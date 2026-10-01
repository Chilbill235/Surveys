const { recordInBackground } = require('./notificationService');

/**
 * Money events, as durable notifications.
 *
 * Every one of these is a moment where the reader's balance or their money-in-transit changed for a
 * reason the product should explain. The email for each already existed; this is the in-app half,
 * and it is deliberately a separate record from the email because they answer different questions
 * and have different lifetimes -- an email is a receipt you can forward to support, a notification
 * is a live status with a read flag.
 *
 * The copy lives here rather than at the call sites for the reason the client derives notification
 * destinations instead of storing them: one place decides what a credited deposit is called, so two
 * paths that fire it cannot disagree. The deposit credit is written by the provider webhook, by
 * the reconciliation sweep and by an operator retry, and those three are exactly the kind of code
 * that drifts.
 *
 * `recordId` is what makes the notification deduplicate and what makes it navigable. It is the id
 * of the record, not of the notification, so "which deposit is this about" survives every future
 * change to how the row is stored.
 *
 * None of these throw. They are all `recordInBackground`, because the money has already moved by
 * the time any of them runs: a failed insert must not roll back a credit that is already committed.
 */

/**
 * A deposit that landed.
 *
 * `href` is left null on purpose. The client derives the destination from the category and the
 * record id, so the link is computed against today's history-row rules rather than against whatever
 * they were when the deposit credited. A stored href is a cached answer that goes stale silently.
 */
function depositCredited({ userId, depositId, amount, creditedAt = null }) {
    return recordInBackground({
        userId,
        category: 'deposit',
        recordId: depositId,
        tone: 'success',
        title: 'Deposit credited',
        message: `Your deposit of $${format(amount)} has been added to your balance.`,
        href: null,
        creditedAt
    });
}

/**
 * A deposit that will never land.
 *
 * A distinct category from `deposit`, and the difference is load-bearing. A credited deposit writes
 * a ledger row and has a history row to scroll to; a failed one writes nothing, so the same link
 * would land on a page with no row on it. The client maps this category to the receipt, which is the
 * one page that can show what went wrong and when.
 */
function depositFailed({ userId, depositId, amount, reason = null, expired = false }) {
    return recordInBackground({
        userId,
        category: 'deposit_failed',
        recordId: depositId,
        tone: expired ? 'warning' : 'error',
        title: expired ? 'Deposit expired' : 'Deposit failed',
        message: expired
            ? `Your deposit of $${format(amount)} expired before it was paid.`
            : `Your deposit of $${format(amount)} could not be completed.`,
        href: `/receipt/deposit/${encodeURIComponent(depositId)}`,
        reason
    });
}

/**
 * A deposit has been created and is awaiting payment.
 */
function depositPending({ userId, depositId, amount }) {
    return recordInBackground({
        userId,
        category: 'deposit_pending',
        recordId: depositId,
        tone: 'info',
        title: 'Deposit created',
        message: `Your deposit of $${format(amount)} is awaiting payment.`
    });
}

/**
 * A deposit has received a partial payment and is being processed.
 */
function depositProcessing({ userId, depositId, amount }) {
    return recordInBackground({
        userId,
        category: 'deposit_processing',
        recordId: depositId,
        tone: 'info',
        title: 'Deposit processing',
        message: `Your deposit of $${format(amount)} has been detected and is being confirmed.`
    });
}

/**
 * The three withdrawal stages are three categories, not one with a decorated id.
 *
 * The unique index is on (user_id, category, record_id), so a single `withdrawal` category for all
 * three would mean the second event about a withdrawal is silently discarded: the "requested"
 * notification is written first, and when the payout lands and writes `withdrawal` + the same
 * record id, the conflict clause does nothing and the reader is never told their money was sent.
 * That is the worst possible bug here -- a notification that fails to appear is invisible, and the
 * balance is the only thing left to check.
 *
 * Distinct categories also make the destination derivable from the category alone, which is what
 * the client relies on rather than a stored href.
 */
function withdrawalSubmitted({ userId, withdrawalId, amount }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_requested',
        recordId: withdrawalId,
        tone: 'info',
        title: 'Withdrawal requested',
        message: `Your withdrawal of $${format(amount)} is being processed.`
    });
}

function withdrawalPaid({ userId, withdrawalId, amount, paidAt = null }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_paid',
        recordId: withdrawalId,
        tone: 'success',
        title: 'Withdrawal sent',
        message: `Your withdrawal of $${format(amount)} has been sent.`,
        paidAt
    });
}

/**
 * A withdrawal that failed and was returned.
 *
 * Its own category rather than the withdrawal id decorated with a suffix. The index already
 * separates the stages by category, so decorating the id would be a second, invisible mechanism
 * doing the same job -- and one that would silently stop working the moment a category were ever
 * reused.
 */
function withdrawalFailed({ userId, withdrawalId, amount, refunded = true }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_failed',
        recordId: withdrawalId,
        tone: refunded ? 'warning' : 'error',
        title: refunded ? 'Withdrawal returned' : 'Withdrawal failed',
        message: refunded
            ? `Your withdrawal of $${format(amount)} could not be sent and has been returned to your balance.`
            : `Your withdrawal of $${format(amount)} could not be sent.`
    });
}

/**
 * Withdrawal is being prepared for payout (claimed, pricing, building batch).
 */
function withdrawalProcessing({ userId, withdrawalId, amount }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_processing',
        recordId: withdrawalId,
        tone: 'info',
        title: 'Withdrawal processing',
        message: `Your withdrawal of $${format(amount)} is being prepared for payout.`
    });
}

/**
 * Withdrawal has been submitted to the payment provider and is on its way.
 */
function withdrawalSending({ userId, withdrawalId, amount }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_sending',
        recordId: withdrawalId,
        tone: 'info',
        title: 'Withdrawal sending',
        message: `Your withdrawal of $${format(amount)} has been sent to the payment provider.`
    });
}

/**
 * Withdrawal is awaiting on-chain confirmation from the provider.
 */
function withdrawalConfirming({ userId, withdrawalId, amount }) {
    return recordInBackground({
        userId,
        category: 'withdrawal_confirming',
        recordId: withdrawalId,
        tone: 'info',
        title: 'Withdrawal confirming',
        message: `Your withdrawal of $${format(amount)} is awaiting blockchain confirmation.`
    });
}

/**
 * A `format` that cannot throw.
 *
 * The amount is already stored as a numeric string, and a notification is the last thing that
 * should be what turns a balance into a failed insert. Two decimals, no currency symbol beyond the
 * `$` the rest of the product uses.
 */
function format(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toFixed(2);
}

module.exports = {
    depositCredited,
    depositFailed,
    depositPending,
    depositProcessing,
    withdrawalSubmitted,
    withdrawalProcessing,
    withdrawalSending,
    withdrawalConfirming,
    withdrawalPaid,
    withdrawalFailed
};