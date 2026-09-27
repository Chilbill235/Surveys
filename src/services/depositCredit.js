const pool = require('../config/db');
const { PAYMENT_STATUSES, PAYOUT_STATUSES } = require('./nowPayments');

/**
 * The only provider statuses that credit a balance.
 */
const creditingProviderStatuses = new Set([
    PAYMENT_STATUSES?.FINISHED || 'finished'
]);

/** Provider statuses that mean the payment will never succeed. */
const failingProviderStatuses = new Set([
    PAYMENT_STATUSES?.FAILED || 'failed',
    PAYMENT_STATUSES?.REFUNDED || 'refunded',
    PAYMENT_STATUSES?.EXPIRED || 'expired'
]);

/**
 * Every payment status the provider documents, in lower case.
 */
const knownProviderStatuses = new Set(
    PAYMENT_STATUSES 
        ? Object.values(PAYMENT_STATUSES).map(s => String(s).toLowerCase())
        : ['finished', 'failed', 'refunded', 'expired', 'waiting', 'confirming', 'sending', 'partially_paid']
);

/**
 * Whether the provider reports the customer as having sent the full amount.
 * Handles string numbers, floating point precision edge cases, and missing fields.
 */
function isPaymentFullyPaid(payload) {
    if (!payload) return false;

    const actuallyPaid = parseFloat(payload.actually_paid);
    const payAmount = parseFloat(payload.pay_amount);
    const priceAmount = parseFloat(payload.price_amount);
    const outcomeAmount = parseFloat(payload.outcome_amount);

    // Pick the most relevant target payment amount
    const targetAmount = !isNaN(payAmount) && payAmount > 0 
        ? payAmount 
        : (!isNaN(priceAmount) && priceAmount > 0 ? priceAmount : outcomeAmount);

    // If numerical payment numbers are missing or zero, fallback to checking payment status directly
    if (isNaN(actuallyPaid) || isNaN(targetAmount) || targetAmount <= 0) {
        const status = String(payload.payment_status || '').toLowerCase();
        return status === 'finished';
    }

    // Allow a small absolute tolerance (0.00001) for crypto precision differences
    return actuallyPaid + 0.00001 >= targetAmount;
}

/**
 * Maps a provider status onto the stored `deposits.status`.
 */
function targetStatusFor(providerStatus) {
    const status = String(providerStatus || '').toLowerCase();
    if (creditingProviderStatuses.has(status)) return 'confirmed';
    if (failingProviderStatuses.has(status)) return 'failed';
    return 'confirming';
}

/**
 * Marks a deposit confirmed and credits the user balance exactly once.
 * Also backfills `provider_payment_id` if it was previously NULL on the deposit row.
 *
 * Must be called with a client that already has an open transaction.
 */
async function creditConfirmedDeposit(client, deposit, description) {
    const claimed = await client.query(
        `UPDATE deposits
         SET status = 'confirmed', 
             credited_at = NOW(), 
             updated_at = NOW(),
             provider_payment_id = COALESCE(provider_payment_id, $2)
         WHERE id = $1 AND credited_at IS NULL
         RETURNING user_id, amount`,
        [deposit.id, deposit.provider_payment_id || null]
    );

    if (claimed.rows.length === 0) {
        return { credited: false, amount: null };
    }

    const { user_id: userId, amount } = claimed.rows[0];

    const balanceUpdate = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [amount, userId]
    );

    if (balanceUpdate.rowCount !== 1) {
        throw new Error(`Deposit ${deposit.id} was claimed but user ${userId} could not be credited.`);
    }

    const ledgerInsert = await client.query(
        `INSERT INTO balance_transactions (user_id, amount, transaction_type, source_id, description)
         VALUES ($1, $2, 'deposit', $3, $4)
         ON CONFLICT (transaction_type, source_id) DO NOTHING
         RETURNING id`,
        [userId, amount, deposit.ledger_source_id, description]
    );

    if (ledgerInsert.rowCount !== 1) {
        throw new Error(`Deposit ${deposit.id} conflicts with an existing ledger entry for ${deposit.ledger_source_id}.`);
    }

    return { credited: true, amount };
}

/**
 * Applies a non-crediting provider status to a deposit without touching balances.
 * Optionally backfills `provider_payment_id` if provided.
 *
 * Must be called with a client that already has an open transaction.
 */
async function applyDepositStatus(client, depositId, status, providerPaymentId = null) {
    const result = await client.query(
        `UPDATE deposits 
         SET status = $1, 
             updated_at = NOW(),
             provider_payment_id = COALESCE(provider_payment_id, $3)
         WHERE id = $2 AND credited_at IS NULL`,
        [status, depositId, providerPaymentId]
    );
    return result.rowCount > 0;
}

module.exports = {
    creditConfirmedDeposit,
    applyDepositStatus,
    targetStatusFor,
    creditingProviderStatuses,
    failingProviderStatuses,
    knownProviderStatuses,
    isPaymentFullyPaid,
    PAYOUT_STATUSES,
    pool
};