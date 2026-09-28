const pool = require('../config/db');
const payoutEmails = require('./payoutEmails');

/**
 * The terminal states a withdrawal can be moved to, and which of them keep the money.
 *
 * The balance is debited when the request is stored, so a withdrawal that stops short of
 * `paid` and is not refunded leaves the user short by exactly that amount with no record
 * of why. `resolveWithdrawal` is the only thing that closes a withdrawal, and it is the
 * only place either of these two writes happens.
 */
const terminalStatuses = new Set(['paid', 'failed', 'cancelled']);

/** Statuses a withdrawal may still be resolved from. */
const resolvableStatuses = new Set(['pending', 'processing']);

/** Withdrawal statuses that mean the funds left the platform and must never be refunded. */
const settledStatuses = new Set(['paid']);

/**
 * The columns the two terminal writes return. The email address is fetched separately
 * inside the transaction, after the write succeeds, because an UPDATE cannot join another
 * table in its RETURNING clause -- and the address is the one thing that has to be right
 * for the notification to reach the right person, so it is read from the row that was
 * actually closed rather than from a parallel lookup that could describe a different one.
 */
const WITHDRAWAL_RETURN_COLUMNS = [
    'id', 'user_id', 'amount', 'status', 'provider_reference',
    'payment_method', 'payment_address', 'asset_code', 'network'
];

/** Reads the recipient address for a withdrawal that has just been closed. */
async function recipientEmail(client, withdrawalId) {
    const row = await client.query(
        `SELECT u.email
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         WHERE w.id = $1`,
        [withdrawalId]
    );
    return row.rows[0]?.email || null;
}

/**
 * Marks a withdrawal as sent, recording the provider reference that proves it.
 *
 * The reference is required rather than optional. A `paid` withdrawal with no reference
 * cannot be reconciled against a provider dashboard or a bank statement later, which is
 * the only reason to keep the row at all; accepting an empty one would manufacture
 * exactly the unprovable record this is meant to prevent.
 *
 * Returns `{ changed: false, reason }` rather than throwing when the withdrawal is already
 * in a state it cannot move out of, because a retried operator action and a contradictory
 * one are different problems and the caller needs to tell them apart.
 *
 * Must be called with a client that already has an open transaction.
 */
async function markWithdrawalPaid(client, withdrawalId, providerReference) {
    const reference = String(providerReference || '').trim();
    if (!reference) {
        return { changed: false, reason: 'missing-reference' };
    }
    if (reference.length > 200) {
        return { changed: false, reason: 'reference-too-long' };
    }

    const claimed = await client.query(
        `UPDATE withdrawals
         SET status = 'paid', provider_reference = $1, paid_at = NOW(), failure_reason = NULL, updated_at = NOW()
         WHERE id = $2 AND status = ANY($3)
         RETURNING ${WITHDRAWAL_RETURN_COLUMNS.join(', ')}`,
        [reference, withdrawalId, [...resolvableStatuses]]
    );
    if (claimed.rows.length === 0) {
        return { changed: false, reason: await describeUnclaimable(client, withdrawalId) };
    }
    const withdrawal = claimed.rows[0];
    withdrawal.user_email = await recipientEmail(client, withdrawal.id);
    return { changed: true, withdrawal };
}

/**
 * Closes a withdrawal that will not be paid and returns the money to the balance.
 *
 * The refund is a positive balance write plus a `refund` ledger row keyed on the
 * withdrawal, both inside the caller's transaction. The ledger row is what makes a second
 * refund impossible: the unique key on `(transaction_type, source_id)` turns a repeat
 * into a conflict, and a conflict is treated as a failure that rolls the whole refund
 * back rather than as a no-op, because a balance that moved with no matching ledger row
 * is the unrecoverable version of this bug.
 *
 * A `paid` withdrawal is refused outright. Once funds have left, "give the money back" is
 * not a database operation, and quietly crediting the balance for a payment that really
 * was made would invent money out of nothing.
 *
 * A withdrawal with a `provider_reference` is refused too. That reference is the record
 * that a payout was submitted to the provider, and a submitted payout can still complete
 * on-chain after this transaction commits. Refunding it would credit the balance *and*
 * leave the crypto transfer in flight -- the user gets paid twice, and nothing in the
 * database would disagree with itself. If the operator has verified the batch was
 * rejected or never sent, they can clear the reference first with an explicit database
 * write; that is a deliberate, visible action rather than a side effect of a refund.
 *
 * Must be called with a client that already has an open transaction.
 */
async function refundWithdrawal(client, withdrawalId, reason) {
    const settled = await client.query(
        `SELECT w.id, w.user_id, w.amount, w.status, w.provider_reference,
                w.payment_method, w.payment_address, w.asset_code, w.network,
                u.email AS user_email
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         WHERE w.id = $1 FOR UPDATE`,
        [withdrawalId]
    );
    if (settled.rows.length === 0) {
        return { changed: false, reason: 'not-found' };
    }
    const withdrawal = settled.rows[0];
    if (settledStatuses.has(withdrawal.status)) {
        return { changed: false, reason: 'already-paid', withdrawal };
    }
    if (terminalStatuses.has(withdrawal.status)) {
        return { changed: false, reason: 'already-resolved', withdrawal };
    }
    // The reference is the only evidence the payout was submitted. Its absence is what
    // makes the refund safe: a withdrawal with no reference never left the platform.
    if (withdrawal.provider_reference) {
        return { changed: false, reason: 'submitted-payout', withdrawal };
    }

    const failureReason = String(reason || '').trim().slice(0, 500) || 'Withdrawal rejected on review';

    const closed = await client.query(
        `UPDATE withdrawals
         SET status = 'failed', failure_reason = $1, updated_at = NOW()
         WHERE id = $2 AND status = ANY($3)
         RETURNING ${WITHDRAWAL_RETURN_COLUMNS.join(', ')}`,
        [failureReason, withdrawalId, [...resolvableStatuses]]
    );
    if (closed.rows.length === 0) {
        return { changed: false, reason: 'already-resolved', withdrawal };
    }
    // The email came from the pre-flight SELECT above, not from this UPDATE, because an
    // UPDATE cannot join another table in its RETURNING clause. Carried over so the caller
    // can notify the right person without a second lookup against a row that may have moved.
    closed.rows[0].user_email = withdrawal.user_email;

    const balanceUpdate = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [withdrawal.amount, withdrawal.user_id]
    );
    if (balanceUpdate.rowCount !== 1) {
        throw new Error(`Withdrawal ${withdrawalId} was closed but user ${withdrawal.user_id} could not be refunded.`);
    }

    // The unique key on (transaction_type, source_id) is what makes a second refund a
    // failure rather than a silent second credit. A conflict here means a refund ledger
    // row already exists for this withdrawal, which the row status did not reveal -- a
    // refund that was applied and then reversed by hand, for example. The transaction is
    // rolled back by the caller, so the balance write above is undone with it.
    const ledgerInsert = await client.query(
        `INSERT INTO balance_transactions (user_id, amount, transaction_type, source_id, description)
         VALUES ($1, $2, 'refund', $3, $4)
         ON CONFLICT (transaction_type, source_id) DO NOTHING
         RETURNING id`,
        [withdrawal.user_id, withdrawal.amount, refundSourceId(withdrawalId), failureReason]
    );
    if (ledgerInsert.rowCount !== 1) {
        throw new Error(
            `Withdrawal ${withdrawalId} already has a refund ledger entry; ` +
            'the balance write was rolled back and nothing changed.'
        );
    }

    return {
        changed: true,
        withdrawal: closed.rows[0],
        refunded: withdrawal.amount,
        balance: balanceUpdate.rows[0].balance
    };
}

/**
 * The ledger source id for a withdrawal refund.
 *
 * Keyed on the withdrawal id and nothing else, so the second refund attempt collides with
 * the first rather than creating a second credit. Exported for the audit tooling and the
 * tests, which both need to name the same row.
 */
function refundSourceId(withdrawalId) {
    return `withdrawal:${withdrawalId}`;
}

/**
 * Why a withdrawal could not be claimed, for the caller's message.
 *
 * The row is read rather than inferred because the four cases look identical from the
 * UPDATE alone, and "already paid" must not be reported as "not found".
 */
async function describeUnclaimable(client, withdrawalId) {
    const current = await client.query('SELECT status FROM withdrawals WHERE id = $1', [withdrawalId]);
    if (current.rows.length === 0) return 'not-found';
    return `already-${current.rows[0].status}`;
}

/**
 * Runs one withdrawal resolution in its own transaction.
 *
 * Both operations above assume a transaction and both make two writes that must agree
 * with each other, so neither is safe to run outside one. Wrapping them here means the
 * route and the CLI get the same guarantee rather than each remembering to open one.
 */
async function withTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Sends a withdrawal. `withdrawalId` is coerced so a route param cannot reach SQL as-is.
 *
 * The notification is fired after the transaction commits, never inside it. A mail call
 * belongs to the outcome, not to the write: sending it from within the transaction would
 * couple a provider outage to the payout, and the one thing this module must never do is
 * make a successful payout look like a failure. The email is advisory and is awaited
 * neither for the response nor for the balance, so a mail provider that is down leaves the
 * payout intact and the user simply uninformed.
 */
async function sendWithdrawal(withdrawalId, providerReference) {
    const result = await withTransaction((client) =>
        markWithdrawalPaid(client, Number(withdrawalId), providerReference)
    );
    if (result.changed) {
        await notifySent(result.withdrawal).catch(() => {});
    }
    return result;
}

/** Closes a withdrawal and refunds the balance. */
async function reverseWithdrawal(withdrawalId, reason) {
    const result = await withTransaction((client) =>
        refundWithdrawal(client, Number(withdrawalId), reason)
    );
    if (result.changed) {
        await notifyRefunded(result.withdrawal, reason).catch(() => {});
    }
    return result;
}

/** Fires the "your money was sent" message, if there is an address to send it to. */
async function notifySent(withdrawal) {
    const email = String(withdrawal?.user_email || '').trim();
    if (!email) return;
    await payoutEmails.sendWithdrawalSentEmail({
        to: email,
        amount: withdrawal.amount,
        assetCode: withdrawal.asset_code,
        network: withdrawal.network,
        destination: withdrawal.payment_address,
        batchId: withdrawal.provider_reference
    });
}

/** Fires the "your money is back" message, if there is an address to send it to. */
async function notifyRefunded(withdrawal, reason) {
    const email = String(withdrawal?.user_email || '').trim();
    if (!email) return;
    await payoutEmails.sendWithdrawalRefundedEmail({
        to: email,
        amount: withdrawal.amount,
        reason
    });
}

/**
 * Withdrawals still awaiting a decision, for the operator screen.
 *
 * Ordered oldest first on purpose: a request that has been waiting longest is the one a
 * user is most likely to have chased, and an operator working top-down by recency keeps
 * deferring the same requests.
 *
 * `provider_reference` is included so the operator can see, before refunding, whether the
 * payout was already submitted. A withdrawal in `processing` with a reference must not be
 * refunded without an explicit reversal of that reference first; showing the value here
 * makes that decision visible rather than something the refund endpoint refuses silently.
 */
async function listUnresolvedWithdrawals({ limit = 50 } = {}) {
    const result = await pool.query(
        `SELECT w.id, w.user_id, u.email, w.amount, w.payment_method, w.payment_address,
                w.asset_code, w.network, w.provider_reference, w.status, w.created_at
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         WHERE w.status = ANY($1)
         ORDER BY w.created_at ASC
         LIMIT $2`,
        [[...resolvableStatuses], limit]
    );
    return result.rows;
}

module.exports = {
    markWithdrawalPaid,
    refundWithdrawal,
    sendWithdrawal,
    reverseWithdrawal,
    listUnresolvedWithdrawals,
    refundSourceId,
    resolvableStatuses,
    terminalStatuses,
    settledStatuses
};