const pool = require('../config/db');
const payoutEmails = require('./payoutEmails');
const { COLUMN, isMoneyEmailEnabled } = require('./emailPreferences');

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

/** Reads the recipient address, and the money-email opt-out, for a withdrawal that has just been closed. */
async function recipientEmail(client, withdrawalId) {
    const row = await client.query(
        `SELECT u.email, u.${COLUMN} AS money_emails
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         WHERE w.id = $1`,
        [withdrawalId]
    );
    return row.rows[0] || null;
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
    const recipient = await recipientEmail(client, withdrawal.id);
    withdrawal.user_email = recipient?.email || null;
    withdrawal.user_money_emails = isMoneyEmailEnabled(recipient?.money_emails);
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
async function refundWithdrawal(client, withdrawalId, reason, { description } = {}) {
    const settled = await client.query(
        `SELECT w.id, w.user_id, w.amount, w.status, w.provider_reference,
                w.payment_method, w.payment_address, w.asset_code, w.network,
                u.email AS user_email, u.${COLUMN} AS user_money_emails
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

    // The ledger description is what the user reads in their history, so it is not the operator's
    // reason by default. "NOWPayments /v1/payout returned 400.: Insufficient balance" is the right
    // thing to keep on `failure_reason`, where an operator and a log will read it, and the wrong
    // thing to put in front of someone whose money it is: it names a company they have no
    // relationship with, an HTTP status, and an endpoint path. Callers that have words for the
    // user supply them; the fallback keeps the old behaviour for the operators who do not.
    const ledgerDescription = String(description || '').trim().slice(0, 500) || failureReason;

    const closed = await client.query(
        `UPDATE withdrawals
         SET status = 'failed',
             failure_reason = $1,
             -- A refund means no payout is coming. Leaving the row in CREATING -- the state a
             -- claim writes before the provider is called -- said the opposite for ever: the
             -- reconciliation sweep picked it up on every pass, because CREATING is
             -- deliberately reconcilable, and the user was shown a progress stage for a
             -- withdrawal that had already been given back to them. CREATING is the only value
             -- cleared, and only because it is the only one that means "claimed, not yet sent";
             -- a real provider status is left alone, since that is the record of what happened to
             -- the money. Safe to clear because status = 'failed' above already takes the row
             -- out of the queue, which only claims rows still pending.
             payout_status = CASE WHEN payout_status = 'CREATING' THEN NULL ELSE payout_status END,
             payout_claimed_at = CASE WHEN payout_status = 'CREATING' THEN NULL ELSE payout_claimed_at END,
             updated_at = NOW()
         WHERE id = $2 AND status = ANY($3)
         RETURNING ${WITHDRAWAL_RETURN_COLUMNS.join(', ')}`,
        [failureReason, withdrawalId, [...resolvableStatuses]]
    );
    if (closed.rows.length === 0) {
        return { changed: false, reason: 'already-resolved', withdrawal };
    }
    // The email and the opt-out came from the pre-flight SELECT above, not from this UPDATE,
    // because an UPDATE cannot join another table in its RETURNING clause. Carried over so the
    // caller can notify the right person, or correctly skip, without a second lookup against a
    // row that may have moved. `isMoneyEmailEnabled` is applied here for the same reason it is
    // applied to the value read after a paid write: the caller should not have to know that a
    // missing value means "send" and a string means "parse".
    closed.rows[0].user_email = withdrawal.user_email;
    closed.rows[0].user_money_emails = isMoneyEmailEnabled(withdrawal.user_money_emails);

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
        [withdrawal.user_id, withdrawal.amount, refundSourceId(withdrawalId), ledgerDescription]
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
 * Cancels a withdrawal the user asked to cancel, and returns the money.
 *
 * This is the self-service counterpart to an operator refunding a request, and the difference
 * is who is asking -- which changes the risk, because the user cannot be asked to read a
 * provider dashboard first. So it is deliberately *narrower* than `reverseWithdrawal` rather
 * than a thinner wrapper around it.
 *
 * Why it cannot just call `reverseWithdrawal`
 * ------------------------------------------
 * `refundWithdrawal` refuses a withdrawal carrying a `provider_reference`, on the reasoning
 * that a submitted payout can still settle on-chain afterwards. That guard is correct and it
 * is also *not sufficient here*, because `provider_reference` is only written when a payout
 * reaches `paid`. Every stage before that -- claimed, batch submitted, in flight, or parked
 * because the provider never answered -- leaves it NULL. A crypto withdrawal sitting in
 * `WAITING` or `PROCESSING` is therefore invisible to that guard, and refunding one would
 * credit the balance while the transfer completed, paying the user twice with a database that
 * agrees with itself throughout.
 *
 * The extra rule
 * --------------
 * A user may cancel only while the row carries no evidence that a payout was ever *started*:
 * no claim, no provider status, no batch, no submitted timestamp. That covers the case a user
 * actually hits -- a request that has been sitting in `pending` because automatic payouts are
 * off, a provider that never answered, a queue the user no longer wants to be in -- while
 * refusing everything from the moment the payout machinery touched the row.
 *
 * The two refusals are reported differently on purpose. `already-sent` is not an error the
 * user caused or can fix; it is the one case that genuinely needs a person, because deciding
 * it means reading the provider dashboard. The route turns that into a message telling the
 * user their request is in flight and support will finish it, rather than a generic refusal
 * that reads as a bug.
 *
 * `payout_claimed_at` is the column that makes this safe rather than merely cautious. It is
 * written by the claim UPDATE, in the same statement that moves the row to `processing`, and
 * it is only ever cleared on a *release* -- a provable refusal. So `payout_claimed_at IS NULL`
 * is exactly "no claim is live", including across a crash mid-run: a row claimed by a
 * process that then died is refused here, which is the correct answer, because that process
 * may have sent the payout before it went down.
 */
async function cancelWithdrawalByUser(withdrawalId, userId) {
    return withTransaction(async (client) => {
        // The row is locked for the rest of the transaction, and scoped to the owner. The lock
        // is what makes the read-then-write a decision rather than a guess: a payout run
        // claiming this row at the same moment blocks here until this commits, and then finds
        // `status = 'cancelled'` and skips it. Without it the two interleave and the user is
        // refunded for a payout that is being submitted.
        const row = await client.query(
            `SELECT w.id, w.user_id, w.amount, w.status, w.payment_method, w.provider_reference,
                    w.payout_status, w.payout_claimed_at, w.batch_id, w.payout_provider_id,
                    w.payout_submitted_at
               FROM withdrawals w
              WHERE w.id = $1 AND w.user_id = $2
              FOR UPDATE`,
            [withdrawalId, userId]
        );
        if (row.rows.length === 0) return { changed: false, reason: 'not-found' };

        const withdrawal = row.rows[0];
        if (settledStatuses.has(withdrawal.status)) {
            return { changed: false, reason: 'already-paid', withdrawal };
        }
        if (terminalStatuses.has(withdrawal.status)) {
            return { changed: false, reason: 'already-resolved', withdrawal };
        }

        // The gate. Any one of these means a payout was started, and started is the point of
        // no return -- the money may already be on its way, so the only correct answer is to
        // refuse and let a person reconcile it.
        const started = withdrawal.payout_claimed_at
            || withdrawal.payout_status
            || withdrawal.batch_id
            || withdrawal.payout_provider_id
            || withdrawal.payout_submitted_at
            || withdrawal.provider_reference;
        if (started) {
            return { changed: false, reason: 'already-sent', withdrawal };
        }

        // Everything below is the same close-and-refund that an operator refund performs, so the
        // money path stays in one place: one balance write, one `refund` ledger row keyed on
        // the withdrawal id, both inside this transaction, and a repeat attempt is a rollback
        // rather than a second credit.
        return refundWithdrawal(client, withdrawalId, 'Cancelled by you. Your balance has been updated.');
    });
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
 *
 * "Uninformed" is where the swallowed error used to end. `.catch(() => {})` left no record
 * anywhere, so a receipt that failed to send and a receipt that was never attempted were
 * indistinguishable -- which is the state this file's own tests kept reaching without
 * noticing. The failure is still not propagated, because a mail provider being down must not
 * fail a payout; it is now logged, so the one thing an operator needs is the one thing they
 * get.
 */
async function sendWithdrawal(withdrawalId, providerReference) {
    const result = await withTransaction((client) =>
        markWithdrawalPaid(client, Number(withdrawalId), providerReference)
    );
    if (result.changed) {
        await notifySent(result.withdrawal).catch((error) => {
            console.error(
                `Withdrawal ${withdrawalId} was paid but its receipt email was not sent: ${error.message}`
            );
        });
    }
    return result;
}

/**
 * Closes a withdrawal and refunds the balance.
 *
 * `reason` is the operator's record of why, and it is written to the row. `options.emailReason`
 * is what the user is shown in the email instead, and `options.description` is what is written
 * to their history -- which needed to be its own option rather than reusing the email's, because
 * the two are read in different places by different people and the history entry outlives the
 * message. All three can differ when a failure originates at the provider. "NOWPayments /v1/
 * payout returned 400.: Insufficient balance" is the right thing to keep on the row and the wrong
 * thing to put in front of the user: it names a third party they have no relationship with, an
 * HTTP status, and an endpoint path. Both are sent from here so the refund and the messages
 * announcing it remain one event.
 */
async function reverseWithdrawal(withdrawalId, reason, { emailReason, description } = {}) {
    const result = await withTransaction((client) =>
        refundWithdrawal(client, Number(withdrawalId), reason, { description })
    );
    if (result.changed) {
        await notifyRefunded(result.withdrawal, emailReason || reason).catch((error) => {
            console.error(
                `Withdrawal ${withdrawalId} was refunded but its email was not sent: ${error.message}`
            );
        });
    }
    return result;
}

/** Fires the "your money was sent" message, if there is an address to send it to. */
async function notifySent(withdrawal) {
    const email = String(withdrawal?.user_email || '').trim();
    if (!email) return;
    if (!isMoneyEmailEnabled(withdrawal?.user_money_emails)) {
        console.log(`Withdrawal ${withdrawal?.id}: user has money email switched off, sent email not sent.`);
        return;
    }
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
    if (!isMoneyEmailEnabled(withdrawal?.user_money_emails)) {
        console.log(`Withdrawal ${withdrawal?.id}: user has money email switched off, refunded email not sent.`);
        return;
    }
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
    cancelWithdrawalByUser,
    listUnresolvedWithdrawals,
    refundSourceId,
    resolvableStatuses,
    terminalStatuses,
    settledStatuses
};
