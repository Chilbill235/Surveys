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
 * Checks if NOWPayments credentials are set up.
 */
function nowPaymentsConfigured() {
    return nowPayments.isConfigured();
}

/**
 * Checks if Stripe API secret key is configured.
 */
function stripeConfigured() {
    return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Returns an active Stripe client instance.
 */
function getStripeClient() {
    return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

/**
 * Fetches current payment status directly from the NOWPayments API.
 */
async function fetchProviderPayment(paymentId) {
    return nowPayments.getPaymentStatus(paymentId);
}

/**
 * Applies a provider status outcome inside a database transaction.
 * Passes provider_payment_id through so depositCredit can auto-heal NULL fields.
 */
async function applyProviderOutcome(client, deposit, targetStatus, ledgerSourceId, description, summary, logger) {
    try {
        await client.query('BEGIN');
        let credited = false;
        let amount = null;

        if (targetStatus === 'confirmed') {
            const result = await creditConfirmedDeposit(client, {
                id: deposit.id,
                ledger_source_id: ledgerSourceId,
                provider_payment_id: deposit.provider_payment_id
            }, description);
            credited = result.credited;
            amount = result.amount;
        } else {
            await applyDepositStatus(client, deposit.id, targetStatus, deposit.provider_payment_id);
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

    const paymentStatus = String(providerPayment.payment_status || '').toLowerCase();
    
    // Fallback amount normalization (price_amount -> pay_amount -> outcome_amount)
    const rawAmount = providerPayment.price_amount ?? providerPayment.pay_amount ?? providerPayment.outcome_amount;
    const providerAmount = parseFloat(rawAmount);

    // Normalize currencies
    const providerCurrency = String(providerPayment.price_currency || providerPayment.pay_currency || '').trim().toUpperCase();
    const dbCurrency = String(deposit.currency_code || deposit.asset_code || 'USD').trim().toUpperCase();

    // Verify compatibility
    const currencyMatches = (providerCurrency === dbCurrency) || (providerCurrency === 'USD');
    const amountMatches = !isNaN(providerAmount) && amountsMatch(providerAmount, deposit.amount);

    if (!amountMatches || !currencyMatches) {
        logger.error(
            `Deposit ${deposit.id}: provider amount/currency mismatch. ` +
            `DB: [${deposit.amount} ${dbCurrency}] vs Provider: [${providerAmount} ${providerCurrency}]`
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

    const client = await pool.connect();
    await applyProviderOutcome(
        client, 
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
        const client = await pool.connect();
        await applyProviderOutcome(
            client, 
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

    const client = await pool.connect();
    await applyProviderOutcome(
        client, 
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
    
    // Reconcile deposits matching the active providers and status, or targeted by depositId
    let filter = `provider = ANY($1) AND credited_at IS NULL AND status IN ('pending', 'confirming')`;

    if (depositId !== null) {
        params.push(depositId);
        filter += ` AND id = $${params.length}`;
    } else {
        // Only require provider_payment_id when doing general batch sweeps (orphans handled separately)
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

    for (const deposit of pending.rows) {
        if (deposit.provider === 'stripe') {
            await reconcileStripeDeposit(deposit, stripe, summary, logger);
        } else {
            await reconcileNowPaymentsDeposit(deposit, summary, logger);
        }
    }

    // Run orphan cleanup only on general background sweeps, not single-deposit lookups
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