const Stripe = require('stripe');
const pool = require('../config/db');
const {
    creditConfirmedDeposit,
    applyDepositStatus,
    targetStatusFor,
    knownProviderStatuses,
    isPaymentFullyPaid
} = require('./depositCredit');
const { amountsMatch } = require('./money');
const nowPayments = require('./nowPayments');
const { notifyDepositCredited, notifyDepositFailed } = require('./depositEmails');
const { realCredential } = require('./credentials');

/**
 * Checks if NOWPayments credentials are set up.
 */
function nowPaymentsConfigured() {
    return nowPayments.isConfigured();
}

/**
 * Checks if Stripe API secret key is configured.
 *
 * Placeholder-aware: the reconciliation sweep is the last chance to credit a deposit whose
 * webhook never arrived, so it must not build a client out of the example value and then
 * report the lookup as failed.
 */
function stripeConfigured() {
    return Boolean(realCredential(process.env, 'STRIPE_SECRET_KEY'));
}

/**
 * Returns an active Stripe client instance.
 */
function getStripeClient() {
    const key = realCredential(process.env, 'STRIPE_SECRET_KEY');
    return key ? new Stripe(key) : null;
}

/**
 * Fetches current payment status directly from the NOWPayments API.
 */
async function fetchProviderPayment(paymentId) {
    return nowPayments.getPaymentStatus(paymentId);
}

/**
 * Applies a provider status outcome inside its own transaction.
 *
 * The client is acquired here rather than passed in. Every call site needs a client for
 * exactly one thing -- running this function -- so handing ownership around produced a
 * contract that was invisible from the call site: the caller connected a client and the
 * callee released it, and a future edit that added a `.release()` in the caller, or
 * reused the client after this returned, would have double-released.
 *
 * Returns `true` when the transaction committed, `false` when it was rolled back. A
 * failure is logged and counted as a skip rather than rethrown, because one unusable
 * deposit should not abort a sweep over many.
 */
async function applyProviderOutcome(deposit, targetStatus, ledgerSourceId, description, summary, logger) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let credited = false;
        let amount = null;

        let statusChanged = false;

        if (targetStatus === 'confirmed') {
            const result = await creditConfirmedDeposit(client, {
                id: deposit.id,
                ledger_source_id: ledgerSourceId,
                provider_payment_id: deposit.provider_payment_id
            }, description);
            credited = result.credited;
            amount = result.amount;
        } else {
            statusChanged = await applyDepositStatus(client, deposit.id, targetStatus, deposit.provider_payment_id);
        }

        await client.query('COMMIT');

        if (credited) {
            logger.log(`Deposit ${deposit.id}: credited $${amount} to user ${deposit.user_id}.`);
            summary.credited += 1;
            // The sweep is a fallback for a callback that never arrived, which makes it the
            // least expected way for a balance to grow. A receipt here is what stops the user
            // reporting an unexplained credit. After the commit, and only for the one call that
            // performed the credit -- an already-credited row is logged as skipped and skipped
            // here too, so a repeated sweep cannot send the same receipt twice.
            notifyDepositCredited({ depositId: deposit.id }).catch((error) => {
                logger.error(`Deposit ${deposit.id}: receipt email failed (${error.message}).`);
            });
        } else if (targetStatus === 'confirmed') {
            logger.log(`Deposit ${deposit.id}: already credited by another process.`);
            summary.skipped += 1;
        } else {
            logger.log(`Deposit ${deposit.id}: marked ${targetStatus}.`);
            summary.failed += 1;
            // The mirror of the receipt above, and gated on the status having actually changed.
            // A sweep re-reads the same expired deposit on every pass until something clears
            // the row, so an ungated notice here would email the same failure notice over and
            // over for as long as the row survives.
            if (statusChanged && targetStatus === 'failed') {
                notifyDepositFailed({ depositId: deposit.id }).catch((error) => {
                    logger.error(`Deposit ${deposit.id}: failure notice failed (${error.message}).`);
                });
            }
        }
        return true;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(`Deposit ${deposit.id}: applying provider status failed (${error.message}).`);
        summary.skipped += 1;
        return false;
    } finally {
        client.release();
    }
}

/**
 * Normalizes and reconciles individual NOWPayments deposits.
 */
async function reconcileNowPaymentsDeposit(deposit, summary, logger) {
    if (!deposit.provider_payment_id) {
        logger.error(`Deposit ${deposit.id}: missing provider_payment_id, skipping lookup.`);
        summary.skipped += 1;
        return;
    }

    let providerPayment;
    try {
        providerPayment = await fetchProviderPayment(deposit.provider_payment_id);
    } catch (error) {
        logger.error(`Deposit ${deposit.id}: provider lookup failed (${error.message}).`);
        summary.skipped += 1;
        return;
    }

    // A 200 whose body is not a JSON object reaches the caller as null, so this is a real
    // answer rather than a fault. Reading a field off it would throw out of this function and
    // out of the sweep's loop, abandoning every deposit after it -- the opposite of the
    // "one unusable deposit is a skip, not an abort" rule the rest of this file follows.
    if (!providerPayment || typeof providerPayment !== 'object' || Array.isArray(providerPayment)) {
        logger.error(`Deposit ${deposit.id}: provider returned no readable payment record - skipping.`);
        summary.skipped += 1;
        return;
    }

    const paymentStatus = String(providerPayment.payment_status || '').toLowerCase();

    // A status the app has never heard of is a real answer from the provider -- likely
    // one this build predates -- and it must not reach the database. The IPN handler
    // already refuses unknown statuses; reconciliation has to make the same check or an
    // unrecognised string falls through `targetStatusFor` and either produces `null`
    // (which violates the status check constraint) or, worse, is written verbatim.
    if (!knownProviderStatuses.has(paymentStatus)) {
        logger.error(`Deposit ${deposit.id}: provider reported an unrecognised status "${paymentStatus}" - skipping.`);
        summary.skipped += 1;
        return;
    }

    // `price_amount` and `price_currency` are the fiat-denominated fields. `pay_amount`,
    // `pay_currency`, and `outcome_amount` are the coin side, and comparing one of those
    // to a USD figure is how a deposit ends up either credited for the wrong amount or
    // skipped as a mismatch when it was fine. There is no safe fallback across that
    // boundary: if the fiat fields are absent, the response cannot be used to match a
    // USD-priced deposit, and the correct action is to say so.
    const providerAmount = Number(providerPayment.price_amount);
    const providerCurrency = String(providerPayment.price_currency || '').trim().toUpperCase();
    const dbCurrency = String(deposit.currency_code || deposit.asset_code || 'USD').trim().toUpperCase();

    if (!Number.isFinite(providerAmount)) {
        logger.error(
            `Deposit ${deposit.id}: provider response has no usable price_amount ` +
            `(got ${JSON.stringify(providerPayment.price_amount)}) - skipping.`
        );
        summary.skipped += 1;
        return;
    }

    // Compared directly, not against a USD fallback. A deposit row is always priced in
    // USD, so a provider response that says anything else is a mismatch, not a licence
    // to proceed.
    if (providerCurrency !== dbCurrency) {
        logger.error(
            `Deposit ${deposit.id}: provider currency ${providerCurrency} does not match stored ${dbCurrency} - skipping.`
        );
        summary.skipped += 1;
        return;
    }

    if (!amountsMatch(providerAmount, deposit.amount)) {
        logger.error(
            `Deposit ${deposit.id}: provider amount ${providerAmount} does not match stored ${deposit.amount} - skipping.`
        );
        summary.skipped += 1;
        return;
    }

    const targetStatus = targetStatusFor(paymentStatus);
    if (targetStatus === 'confirming') {
        logger.log(`Deposit ${deposit.id}: provider status is "${paymentStatus}" - leaving pending.`);
        summary.unchanged += 1;
        return;
    }

    if (targetStatus === 'confirmed' && !isPaymentFullyPaid(providerPayment)) {
        logger.error(
            `Deposit ${deposit.id}: provider reports "${paymentStatus}" but payment verification failed ` +
            `(${providerPayment.actually_paid} paid of ${providerPayment.pay_amount} required) - skipping.`
        );
        summary.skipped += 1;
        return;
    }

    await applyProviderOutcome(
        deposit,
        targetStatus,
        `nowpayments:${deposit.provider_payment_id}`,
        'Confirmed NOWPayments deposit (reconciled)',
        summary,
        logger
    );
}

/**
 * Reconciles Stripe Checkout deposits.
 */
async function reconcileStripeDeposit(deposit, stripe, summary, logger) {
    if (!stripe) {
        logger.error(`Deposit ${deposit.id}: no Stripe client is available.`);
        summary.skipped += 1;
        return;
    }

    if (!deposit.provider_payment_id) {
        logger.error(`Deposit ${deposit.id}: missing Stripe session ID.`);
        summary.skipped += 1;
        return;
    }

    let session;
    try {
        session = await stripe.checkout.sessions.retrieve(deposit.provider_payment_id);
    } catch (error) {
        logger.error(`Deposit ${deposit.id}: Stripe session lookup failed (${error.message}).`);
        summary.skipped += 1;
        return;
    }

    const expectedCents = Math.round(parseFloat(deposit.amount) * 100);
    const sessionCurrency = String(session.currency || '').toLowerCase();

    if (sessionCurrency !== 'usd' || Number(session.amount_total) !== expectedCents) {
        logger.error(`Deposit ${deposit.id}: Stripe amount or currency does not match stored deposit.`);
        summary.skipped += 1;
        return;
    }

    if (session.status === 'expired') {
        await applyProviderOutcome(
            deposit,
            'failed',
            `stripe:${deposit.provider_payment_id}`,
            'Expired Stripe checkout session',
            summary,
            logger
        );
        return;
    }

    if (session.payment_status !== 'paid') {
        logger.log(`Deposit ${deposit.id}: Stripe payment status is "${session.payment_status}" - leaving pending.`);
        summary.unchanged += 1;
        return;
    }

    await applyProviderOutcome(
        deposit,
        'confirmed',
        `stripe:${deposit.provider_payment_id}`,
        'Confirmed Stripe card deposit (reconciled)',
        summary,
        logger
    );
}

/**
 * Fails deposits created over an hour ago that were never attached to a provider payment ID.
 *
 * Bounded by `limit` so a first run against a large backlog cannot hold the connection
 * for minutes. The orphan sweep runs on every general reconciliation; without a limit
 * the query would scan every orphan every time, which is the kind of thing that is fine
 * in development and a problem the first time it runs in production.
 */
async function failOrphanedDeposits({ logger = console, limit = 200 } = {}) {
    const result = await pool.query(
        `UPDATE deposits
         SET status = 'failed', updated_at = NOW()
         WHERE id IN (
             SELECT id FROM deposits
             WHERE provider_payment_id IS NULL
               AND credited_at IS NULL
               AND status IN ('pending', 'confirming')
               AND created_at < NOW() - INTERVAL '1 hour'
             ORDER BY created_at ASC
             LIMIT $1
         )
         RETURNING id`,
        [limit]
    );
    if (result.rows.length > 0) {
        logger.log(`Closed ${result.rows.length} deposit(s) that were never attached to a provider payment.`);
    }
    return result.rows.length;
}

/**
 * Main reconciliation query execution engine.
 */
async function reconcilePendingDeposits({
    limit = 25,
    depositId = null,
    logger = console,
    stripeClient = null
} = {}) {
    const providers = [];
    if (nowPaymentsConfigured()) providers.push('nowpayments');
    if (stripeConfigured()) providers.push('stripe');

    const summary = {
        checked: 0, credited: 0, failed: 0, unchanged: 0, skipped: 0,
        providers,
        note: null
    };

    if (providers.length === 0) {
        summary.note = 'No payment provider credentials are configured, so there is nothing to reconcile.';
        logger.warn(summary.note);
        return summary;
    }

    const params = [providers];

    // Reconcile deposits matching the active providers and status, or targeted by depositId.
    // The generic sweep requires a provider_payment_id because a row without one cannot be
    // looked up; a targeted lookup does not, because the caller already knows which row
    // they mean and the reconciler's message about a missing id is more useful than a
    // silent skip.
    let filter = `provider = ANY($1) AND credited_at IS NULL AND status IN ('pending', 'confirming')`;

    if (depositId !== null) {
        params.push(depositId);
        filter += ` AND id = $${params.length}`;
    } else {
        filter += ` AND provider_payment_id IS NOT NULL`;
    }

    params.push(limit);

    const pending = await pool.query(
        `SELECT id, user_id, amount, provider, provider_payment_id, status, asset_code, currency_code
         FROM deposits
         WHERE ${filter}
         ORDER BY created_at ASC
         LIMIT $${params.length}`,
        params
    );

    summary.checked = pending.rows.length;
    const stripe = stripeConfigured() ? (stripeClient || getStripeClient()) : null;

    // Sequential, not parallel. The NOWPayments client already serialises its own calls
    // per endpoint at the documented 3 RPS, so fanning out would just queue them inside
    // the client while making the logs harder to follow. Stripe's API is faster but the
    // batch is small in practice.
    for (const deposit of pending.rows) {
        if (deposit.provider === 'stripe') {
            await reconcileStripeDeposit(deposit, stripe, summary, logger);
        } else {
            await reconcileNowPaymentsDeposit(deposit, summary, logger);
        }
    }

    // Run orphan cleanup only on general background sweeps, not single-deposit lookups.
    if (depositId === null) {
        try {
            await failOrphanedDeposits({ logger });
        } catch (error) {
            logger.error(`Orphaned deposit cleanup failed (${error.message}).`);
            summary.skipped += 1;
        }
    }

    return summary;
}

module.exports = {
    reconcilePendingDeposits,
    fetchProviderPayment,
    failOrphanedDeposits
};