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

    // The slack is purely relative, with no absolute floor. Binary floating point error is
    // itself relative, so a relative tolerance is exactly as generous for a large amount as
    // for a small one; an absolute epsilon on top of it is not slack at all on a quoted amount
    // smaller than the epsilon, where it turns "nothing arrived" into a pass. The tolerance is
    // therefore the product alone, and anything beyond it is a real shortfall.
    const tolerance = payAmount * 1e-9;
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
        `INSERT INTO balance_transactions (user_id, amount, transaction_type, source_id, description, deposit_id)
         VALUES ($1, $2, 'deposit', $3, $4, $5)
         ON CONFLICT (transaction_type, source_id) DO NOTHING
         RETURNING id`,
        // `source_id` is the provider's identifier and cannot say which of our deposits it was,
        // so the link to the deposit is carried separately. Without it a ledger row could only
        // ever say "a deposit was credited", never which one, and the history list could not
        // offer a receipt for the row it is showing. See migration 027.
        [userId, amount, deposit.ledger_source_id, description, deposit.id]
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

/**
 * Records what the provider says has arrived, without deciding anything about the deposit.
 *
 * A short payment is not a failure the provider reports as one. The payment sits at
 * `partially_paid`, the customer can send the remainder to the same address, and the payment
 * then finishes and is credited in full. So this function deliberately changes no status and
 * touches no balance: it exists so the shortfall is *recorded* while it is happening, which is
 * the difference between a deposit an operator can see and one they can only reconstruct by
 * asking the provider.
 *
 * The comparison against `pay_amount` is the same relative one `isPaymentFullyPaid` uses, for
 * the same reason, and it is reused rather than reimplemented so the two cannot disagree about
 * what counts as short. A provider that reports a total below the quote is short by definition;
 * one that reports it at or above is not, whatever the status string says.
 *
 * `underpaid_at` is set once and never moved, so it answers "how long has this been short"
 * rather than "when was it last looked at". It is not cleared when the shortfall closes: the
 * record that a deposit was once underpaid is worth keeping, and the column is only read for
 * deposits that are still short.
 *
 * Safe to call on a credited deposit, and on one whose row has already been closed: the guard
 * is `credited_at IS NULL`, so a late callback about money that has been credited cannot
 * rewrite history, and a repeat callback writes the same value again.
 *
 * `client` is injectable because the callback path holds the row `FOR UPDATE` inside an open
 * transaction. Taking a second connection for this write would block on the lock the calling
 * transaction already holds -- the process waiting on itself -- so the caller must pass its own
 * client when it has one. The default is for the read-only callers that have no transaction.
 */
async function recordPartialPayment(depositId, { actuallyPaid, payCurrency, payAmount } = {}, client = pool) {
    const id = Number(depositId);
    if (!Number.isInteger(id) || id <= 0) return { recorded: false, short: false };

    // A missing or unparseable figure is not a shortfall and not a payment; recording either
    // would put a number on the row that the provider never asserted. A callback stripped of
    // its fields is exactly what a misconfigured proxy produces, and it must leave no trace
    // beyond the refusal that already happened upstream.
    //
    // The absence check is explicit rather than left to `Number()`, because `Number(null)` and
    // `Number('')` are both exactly 0: a body with `"actually_paid": null` would otherwise store
    // a hard zero on the deposit and read as "the customer sent nothing", which is a claim about
    // the payment rather than an absence of one.
    if (actuallyPaid === null || actuallyPaid === undefined || actuallyPaid === '' ||
        typeof actuallyPaid === 'boolean') {
        return { recorded: false, short: false };
    }
    const paid = Number(actuallyPaid);
    if (!Number.isFinite(paid) || paid < 0) return { recorded: false, short: false };

    const currency = String(payCurrency || '').trim().toLowerCase().slice(0, 24) || null;
    const required = Number(payAmount);
    // Only a shortfall can be measured against a quote. With no quote to compare, the amount is
    // still worth recording, but whether it is short is unknown and must not be guessed.
    const short = Number.isFinite(required) && required > 0
        ? !isPaymentFullyPaid({ actually_paid: paid, pay_amount: required })
        : false;

    const result = await client.query(
        `UPDATE deposits
         SET actually_paid = $1,
             pay_currency = COALESCE($2, pay_currency),
             underpaid_at = CASE WHEN $3 AND underpaid_at IS NULL THEN NOW() ELSE underpaid_at END,
             updated_at = NOW()
         WHERE id = $4
           AND credited_at IS NULL
         RETURNING id`,
        [paid, currency, short, id]
    );

    return { recorded: result.rowCount > 0, short };
}

/**
 * Whether a provider answer means money arrived that this app has not credited.
 *
 * The provider reports `failed` or `expired` for a payment that was abandoned part-way, and the
 * honest reading of that is not "nothing happened". When `actually_paid` is positive the
 * customer has already sent real crypto to an address this app gave them, and the correct
 * response is to keep the row and its amount on file for a person rather than to close it as a
 * clean failure -- which is what would otherwise produce a "your deposit did not go through"
 * email about a deposit that is mostly in the address.
 *
 * Deliberately conservative: it needs a positive amount, so the ordinary abandoned deposit
 * that received nothing still fails normally and unattended.
 */
function hasUncreditedArrival(payload) {
    const paid = Number(payload?.actually_paid);
    return Number.isFinite(paid) && paid > 0;
}

module.exports = {
    creditConfirmedDeposit,
    applyDepositStatus,
    recordPartialPayment,
    hasUncreditedArrival,
    targetStatusFor,
    creditingProviderStatuses,
    failingProviderStatuses,
    knownProviderStatuses,
    isPaymentFullyPaid,
    PAYOUT_STATUSES,
    pool
};