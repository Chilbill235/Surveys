const pool = require('../config/db');
const { PAYMENT_STATUSES, PAYOUT_STATUSES } = require('./nowPayments');

/**
 * The only provider statuses that credit a balance.
 *
 * This lives in one place because the webhook and the reconciler used to disagree:
 * the IPN credited on `finished` alone, while reconciliation also credited on
 * `confirmed` and `sending`. A deposit whose `finished` callback was lost could
 * therefore be credited by the reconciler at a point where the live webhook would
 * still have refused to, so a deposit's fate depended on which path happened to
 * run. `finished` is the provider's terminal success state and is what NOWPayments
 * and Stripe both end on, so it is the only state that credits.
 */
const creditingProviderStatuses = new Set([PAYMENT_STATUSES.FINISHED]);

/** Provider statuses that mean the payment will never succeed. */
const failingProviderStatuses = new Set([
    PAYMENT_STATUSES.FAILED,
    PAYMENT_STATUSES.REFUNDED,
    PAYMENT_STATUSES.EXPIRED
]);

/**
 * Every payment status the provider documents, in lower case.
 *
 * A callback carrying anything outside this set is not a payment state this build knows,
 * and is rejected rather than treated as "still in progress". `sending` and
 * `partially_paid` are real and are both still in progress, so they leave a partially
 * received payment visibly unconfirmed instead of crediting it early.
 */
const knownProviderStatuses = new Set(Object.values(PAYMENT_STATUSES));

/**
 * Whether the provider reports the customer as having sent the full amount.
 *
 * `payment_status: finished` is the documented terminal success state, and the provider
 * sets it only once `actually_paid` reaches `pay_amount`. It is still worth checking the
 * money directly, for two reasons. The reconciler runs precisely when a callback was
 * lost, so it is the last line of defence between a mis-scraped or stale provider record
 * and a real balance credit. And `pay_amount` is the amount the customer was quoted at
 * creation, whereas `price_amount` is the fiat value of the deposit; crediting the fiat
 * value without confirming the crypto arrived is crediting a number, not a payment.
 *
 * Returns false when the provider omits the fields, because an absent `actually_paid`
 * means the confirmation cannot be established and the safe answer is to keep waiting.
 * Reconciliation retries on the next sweep, so waiting costs nothing but a delay.
 */
function isPaymentFullyPaid(payload) {
    const actuallyPaid = Number(payload?.actually_paid);
    const payAmount = Number(payload?.pay_amount);
    if (!Number.isFinite(actuallyPaid) || !Number.isFinite(payAmount) || payAmount <= 0) return false;
    // Crypto amounts carry more precision than a fiat cent, so this compares to a small
    // absolute tolerance rather than rounding. Underpayment by any real amount fails.
    return actuallyPaid + 1e-8 >= payAmount;
}

/**
 * Maps a provider status onto the stored `deposits.status`.
 *
 * Returns 'confirmed' only for a crediting status, and 'confirming' for anything in
 * between, so a partially-received payment is never shown as a completed one.
 */
function targetStatusFor(providerStatus) {
    const status = String(providerStatus || '').toLowerCase();
    if (creditingProviderStatuses.has(status)) return 'confirmed';
    if (failingProviderStatuses.has(status)) return 'failed';
    return 'confirming';
}


/**
 * Marks a deposit confirmed and credits the user balance exactly once.
 *
 * Every crediting path (NOWPayments IPN, Stripe webhook, reconciliation) must
 * use this helper so the balance ledger stays consistent and double-credits are
 * impossible. The conditional UPDATE on `credited_at IS NULL` is the claim: only
 * the caller that flips it from NULL to a timestamp credits the balance.
 *
 * Both writes that follow the claim are verified. A balance that moved without a
 * matching `balance_transactions` row (or the other way round) is an unrecoverable
 * accounting error, so a failure throws and the caller's transaction rolls back
 * rather than leaving a half-applied credit behind. Because the claim is the first
 * statement and the whole helper runs inside the caller's transaction, a rollback
 * also returns `credited_at` to NULL, so the deposit stays creditable and the next
 * attempt can retry cleanly.
 *
 * Must be called with a client that already has an open transaction.
 */
async function creditConfirmedDeposit(client, deposit, description) {
    const claimed = await client.query(
        `UPDATE deposits
         SET status = 'confirmed', credited_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND credited_at IS NULL
         RETURNING user_id, amount`,
        [deposit.id]
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
        // A ledger row for this source already exists while the deposit was still
        // uncredited. That means the deposit row and the ledger disagree about whether
        // this payment was already counted, and crediting now would double-count it.
        throw new Error(`Deposit ${deposit.id} conflicts with an existing ledger entry for ${deposit.ledger_source_id}.`);
    }

    return { credited: true, amount };
}

/**
 * Applies a non-crediting provider status to a deposit without touching balances.
 *
 * `credited_at IS NULL` is part of the WHERE clause on purpose: once a deposit has
 * been credited its status is the authoritative record of the payment, and letting a
 * later callback rewrite it to `confirming` or `pending` would show a funded balance
 * next to a deposit that looks like it never arrived.
 *
 * Must be called with a client that already has an open transaction.
 */
async function applyDepositStatus(client, depositId, status) {
    const result = await client.query(
        `UPDATE deposits SET status = $1, updated_at = NOW()
         WHERE id = $2 AND credited_at IS NULL`,
        [status, depositId]
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
