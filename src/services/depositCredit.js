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
 *
 * `payment_status: finished` is the provider's documented terminal success state, and it is
 * the only status that reaches this function. It is still not evidence on its own: the
 * provider sets it, and anything that can post a signed callback can carry it, so the credit
 * has to rest on the money having actually arrived.
 *
 * Two fields are required, and the absence of either is a refusal rather than a pass:
 *
 *  - `actually_paid`, what the provider says arrived, and
 *  - `pay_amount`, the amount the customer was quoted when the payment was created.
 *
 * The comparison is against `pay_amount` and never against `price_amount`. `price_amount`
 * is the fiat value of the deposit; `actually_paid` is a quantity of coin. Comparing a coin
 * amount to a fiat number is a units error that either always passes or always fails
 * depending on the exchange rate, and a check whose verdict depends on the price of the
 * asset is not a check.
 *
 * An earlier version of this function fell back to "if the numbers are missing or
 * unparseable, trust the status string". That made every malformed or partial callback a
 * credit: a `finished` body with no `actually_paid` at all -- exactly what a misconfigured
 * proxy, a truncated delivery, or a hand-rolled request produces -- passed the check and
 * funded a balance. A missing field is not evidence of payment, so it is refused. The cost
 * of refusing is a delay: reconciliation re-asks the provider on its next sweep, and
 * a payment that really did finish is credited then.
 *
 * The tolerance is relative, because crypto amounts span many orders of magnitude and a
 * fixed epsilon is either noise on a large amount or a real underpayment on a small one.
 */
function isPaymentFullyPaid(payload) {
    if (!payload) return false;

    const actuallyPaid = Number(payload.actually_paid);
    const payAmount = Number(payload.pay_amount);

    if (!Number.isFinite(actuallyPaid) || !Number.isFinite(payAmount) || payAmount <= 0) {
        return false;
    }

    // Only enough slack to absorb binary floating point representation error, which is the
    // one case where a provider that paid the exact quoted amount can still report a hair
    // under. Anything beyond that is a real shortfall and must not be credited.
    const tolerance = Math.max(1e-12, payAmount * 1e-9);
    return actuallyPaid + tolerance >= payAmount;
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
 * Returns whether the status actually *changed*, not merely whether a row was written. The
 * provider repeats notifications, and the reconciliation sweep re-reads the same deposit on
 * every pass, so a row that already reads `failed` gets this call again and again. Reporting
 * that as a change would send the user a fresh "your deposit did not go through" every time,
 * which trains people to ignore the one email that matters here. Idempotence is what makes
 * the notification safe to fire off the back of this return value.
 *
 * The backfill is a separate statement for the same reason: it is not a status change and
 * must still happen on a repeat, while the status update must not.
 *
 * Must be called with a client that already has an open transaction.
 */
async function applyDepositStatus(client, depositId, status, providerPaymentId = null) {
    const result = await client.query(
        `UPDATE deposits
         SET status = $1,
             updated_at = NOW()
         WHERE id = $2
           AND credited_at IS NULL
           AND status IS DISTINCT FROM $1
         RETURNING id`,
        [status, depositId]
    );

    if (providerPaymentId) {
        await client.query(
            `UPDATE deposits
             SET provider_payment_id = $1, updated_at = NOW()
             WHERE id = $2 AND provider_payment_id IS NULL`,
            [providerPaymentId, depositId]
        );
    }

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