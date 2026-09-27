const Stripe = require('stripe');
const pool = require('../config/db');
const {
    creditConfirmedDeposit,
    applyDepositStatus,
    targetStatusFor,
    isPaymentFullyPaid
} = require('./depositCredit');
const { amountsMatch } = require('./money');
const nowPayments = require('./nowPayments');

/**
 * Re-checks pending deposits against the provider API and credits the ones the provider
 * reports as finished.
 *
 * This exists because provider callback delivery is not guaranteed. If the callback URL
 * was wrong (for example a localhost URL left in APP_BASE_URL), a single delivery was
 * lost, or the webhook endpoint was misconfigured, the deposit stays `pending` forever
 * and the user is never credited. Reconciliation is the recovery path, and it reuses
 * the same single-credit claim as the webhooks so it can never double-credit.
 *
 * Both providers are covered. Card deposits used to be excluded because the only
 * identifiers available were Stripe session IDs, but a lost `checkout.session.completed`
 * left a paid card deposit with no way back: the user had paid and nothing would ever
 * credit them. Re-reading the Checkout Session by ID closes that gap.
 */

function nowPaymentsConfigured() {
    return nowPayments.isConfigured();
}

function stripeConfigured() {
    return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getStripeClient() {
    return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

/**
 * Reads a crypto payment's current state from `GET /v1/payment/{payment_id}`.
 *
 * This is the endpoint the provider documents as the way to confirm a payment, and it is
 * the only path that can resolve a deposit whose IPN was lost, so it is deliberately the
 * same call the live webhook answers. The shared client also enforces the documented
 * 3 RPS create-payment limit and the API-key and trusted-host rules that the reconciler
 * previously bypassed.
 */
async function fetchProviderPayment(paymentId) {
    return nowPayments.getPaymentStatus(paymentId);
}


/**
 * Applies a provider status to a deposit inside one transaction.
 *
 * The status decision comes from the shared `targetStatusFor`, so a deposit is credited
 * here under exactly the same conditions the live webhook would have applied. A deposit
 * that is already credited by the time this runs loses the claim and is counted as
 * skipped rather than credited again.
 */
async function applyProviderOutcome(client, deposit, targetStatus, ledgerSourceId, description, summary, logger) {
    try {
        // BEGIN sits inside the try so that a client which cannot even start a
        // transaction is still released rather than leaked back to nothing.
        await client.query('BEGIN');
        let credited = false;
        let amount = null;
        if (targetStatus === 'confirmed') {
            const result = await creditConfirmedDeposit(client, {
                id: deposit.id,
                ledger_source_id: ledgerSourceId
            }, description);
            credited = result.credited;
            amount = result.amount;
        } else {
            await applyDepositStatus(client, deposit.id, targetStatus);
        }
        await client.query('COMMIT');

        if (credited) {
            logger.log(`Deposit ${deposit.id}: credited $${amount} to user ${deposit.user_id}.`);
            summary.credited += 1;
        } else if (targetStatus === 'confirmed') {
            logger.log(`Deposit ${deposit.id}: already credited by another process.`);
            summary.skipped += 1;
        } else {
            logger.log(`Deposit ${deposit.id}: marked ${targetStatus}.`);
            summary.failed += 1;
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

async function reconcileNowPaymentsDeposit(deposit, summary, logger) {
    let providerPayment;
    try {
        providerPayment = await fetchProviderPayment(deposit.provider_payment_id);
    } catch (error) {
        logger.error(`Deposit ${deposit.id}: provider lookup failed (${error.message}).`);
        summary.skipped += 1;
        return;
    }

    const paymentStatus = String(providerPayment.payment_status || '').toLowerCase();
    const providerAmount = Number(providerPayment.price_amount);
    const providerCurrency = String(providerPayment.price_currency || '').toUpperCase();

    // The provider must be talking about the same payment the user was asked to make.
    // A mismatch means the callback is describing a different transaction, and crediting
    // on it would pay a balance for money that was never received.
    if (!Number.isFinite(providerAmount) || providerCurrency !== 'USD' ||
        !amountsMatch(providerAmount, deposit.amount)) {
        logger.error(`Deposit ${deposit.id}: provider amount or currency does not match the stored deposit.`);
        summary.skipped += 1;
        return;
    }

    const targetStatus = targetStatusFor(paymentStatus);
    if (targetStatus === 'confirming') {
        logger.log(`Deposit ${deposit.id}: provider status is "${paymentStatus}" - leaving pending.`);
        summary.unchanged += 1;
        return;
    }

    // `finished` is the provider's terminal success state, and this is the path that runs
    // when no callback ever arrived, so it is the last point at which the actual transfer
    // can be checked. A finished payment whose `actually_paid` does not cover the quoted
    // `pay_amount` is a record this build cannot reconcile, and crediting it would convert
    // an unexplained provider row into a real balance. It is left for a later sweep.
    if (targetStatus === 'confirmed' && !isPaymentFullyPaid(providerPayment)) {
        logger.error(
            `Deposit ${deposit.id}: provider reports "${paymentStatus}" but actually_paid ` +
            `(${providerPayment.actually_paid}) does not cover pay_amount (${providerPayment.pay_amount}) - not crediting.`
        );
        summary.skipped += 1;
        return;
    }

    const client = await pool.connect();
    await applyProviderOutcome(client, deposit, targetStatus,
        `nowpayments:${deposit.provider_payment_id}`,
        'Confirmed NOWPayments deposit (reconciled)', summary, logger);
}


async function reconcileStripeDeposit(deposit, stripe, summary, logger) {
    if (!stripe) {
        logger.error(`Deposit ${deposit.id}: no Stripe client is available.`);
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

    const expectedCents = Math.round(Number(deposit.amount) * 100);
    if (String(session.currency || '').toLowerCase() !== 'usd' ||
        Number(session.amount_total) !== expectedCents) {
        logger.error(`Deposit ${deposit.id}: Stripe amount or currency does not match the stored deposit.`);
        summary.skipped += 1;
        return;
    }

    // An expired session is terminal: the customer never completed it, so the deposit
    // can stop sitting in the history list as a pending payment that will never land.
    if (session.status === 'expired') {
        const client = await pool.connect();
        await applyProviderOutcome(client, deposit, 'failed', `stripe:${deposit.provider_payment_id}`,
            'Expired Stripe checkout session', summary, logger);
        return;
    }

    if (session.payment_status !== 'paid') {
        logger.log(`Deposit ${deposit.id}: Stripe payment status is "${session.payment_status}" - leaving pending.`);
        summary.unchanged += 1;
        return;
    }

    const client = await pool.connect();
    await applyProviderOutcome(client, deposit, 'confirmed', `stripe:${deposit.provider_payment_id}`,
        'Confirmed Stripe card deposit (reconciled)', summary, logger);
}

/**
 * Fails deposits that were created but never attached to a provider payment.
 *
 * The deposit row is inserted before the provider is called so the order ID is available
 * to NOWPayments. A crash in between leaves a row with no `provider_payment_id`, which no
 * provider lookup can ever resolve and no webhook can ever match. Left alone it shows the
 * user a pending deposit forever, so it is closed out once it is old enough that the
 * original request has certainly finished.
 */
async function failOrphanedDeposits({ logger = console } = {}) {
    const result = await pool.query(
        `UPDATE deposits
         SET status = 'failed', updated_at = NOW()
         WHERE provider_payment_id IS NULL
           AND credited_at IS NULL
           AND status IN ('pending', 'confirming')
           AND created_at < NOW() - INTERVAL '1 hour'
         RETURNING id`
    );
    if (result.rows.length > 0) {
        logger.log(`Closed ${result.rows.length} deposit(s) that were never attached to a provider payment.`);
    }
    return result.rows.length;
}

/**
 * Re-checks pending deposits against the provider API and credits the ones the provider
 * reports as finished.
 *
 * `stripeClient` is injectable so the reconciliation path can be exercised without a
 * network call; it defaults to a client built from STRIPE_SECRET_KEY.
 *
 * A deployment with no payment credentials has nothing to reconcile. That used to throw,
 * which turned the scheduled job into a 500 every few hours on a perfectly healthy
 * instance and read as a failure in whatever monitors the cron. It now reports zero work
 * and says why.
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
    let filter = `provider = ANY($1) AND credited_at IS NULL AND provider_payment_id IS NOT NULL
                  AND status IN ('pending', 'confirming')`;
    if (depositId !== null) {
        params.push(depositId);
        filter += ` AND id = $${params.length}`;
    }
    params.push(limit);

    const pending = await pool.query(
        `SELECT id, user_id, amount, provider, provider_payment_id, status
         FROM deposits
         WHERE ${filter}
         ORDER BY created_at ASC
         LIMIT $${params.length}`,
        params
    );

    summary.checked = pending.rows.length;
    const stripe = stripeConfigured() ? (stripeClient || getStripeClient()) : null;

    for (const deposit of pending.rows) {
        if (deposit.provider === 'stripe') {
            await reconcileStripeDeposit(deposit, stripe, summary, logger);
        } else {
            await reconcileNowPaymentsDeposit(deposit, summary, logger);
        }
    }

    // Only on a full sweep: a targeted single-deposit run should not touch other rows.
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

module.exports = { reconcilePendingDeposits, fetchProviderPayment, failOrphanedDeposits };
