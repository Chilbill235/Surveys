const pool = require('../config/db');
const nowPayments = require('./nowPayments');
const { sendWithdrawal, reverseWithdrawal } = require('./withdrawalResolution');
const payoutOptions = require('./payoutOptions');
const { resolvePublicBaseUrl } = require('./publicBaseUrl');

/**
 * Automatic crypto payouts via the NOWPayments Mass Payouts API.
 *
 * This is the only part of the app that moves money out without a person deciding to. The
 * whole module is therefore organised around one hazard: the balance is debited the moment a
 * withdrawal is stored, so sending one twice pays real money twice, and recording a send
 * that never happened tells the user their money is on its way when it is not.
 *
 * Three rules follow, and everything below exists to enforce them.
 *
 * 1. **Claim before sending, never after.** A row is moved to `processing` and stamped with
 *    the exact address, coin, and amount that will be sent, in a committed transaction,
 *    *before* the provider is called. If the process dies at any point after that, the claim
 *    is on file and the outcome is discoverable. A design that calls the provider first and
 *    records afterwards has a window where a crash loses the fact that money moved, and the
 *    next run would send it again.
 *
 * 2. **An unknown outcome is never retried automatically.** A timeout or a dropped
 *    connection leaves the caller unable to tell whether the provider accepted the batch.
 *    Retrying is the one action that can duplicate a transfer, so it is not taken: the
 *    attempt is left claimed, and reconciliation asks the provider what it has instead.
 *
 * 3. **Only crypto, and only to the address already validated at request time.** NOWPayments
 *    cannot pay PayPal or Venmo at all, and those methods stay manual forever. The filter is
 *    in the claim query rather than in JavaScript so a PayPal address cannot reach the
 *    provider even if a caller asks for it, and the address sent is the one already checked
 *    by `payoutOptions` and the provider's own validator.
 */

/**
 * Whether automatic payouts are switched on.
 *
 * Off unless `NOWPAYMENTS_AUTO_PAYOUTS` says otherwise. Enabling it is a deliberate act with
 * a real consequence -- every eligible crypto withdrawal starts leaving the platform without
 * anyone reading it -- so it is never inferred from the presence of credentials. Credentials
 * without this flag mean "the operator may send", which is the state the app was in before
 * and the state a fresh deployment should stay in until someone has funded custody and seen
 * a test payout land.
 */
function autoPayoutsEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.NOWPAYMENTS_AUTO_PAYOUTS || '').toLowerCase());
}

/**
 * The payout coin ticker for a stored withdrawal.
 *
 * `asset_code` on a withdrawal is the *asset* (USDT) while the provider keys on the
 * *network-specific* ticker (usdterc20 on Ethereum, usdttrc20 on TRON). Sending `usdt` for
 * every network confirms against the wrong chain and delivers nothing, so this resolves the
 * pair the same way address validation already does and refuses rather than guessing.
 *
 * The map used to live here, next to the payout code. It disagreed with
 * `src/services/payoutOptions.js` -- USDC on Ethereum resolved to `usdce` here but
 * `usdcerc20` there, and it listed networks (solana, base) that the destinations table does
 * not offer -- so a payout could be sent with a ticker that confirmed against the wrong chain.
 * There is one registry now, and this delegates to it. Anything not in the registry returns
 * null, which `claimOneRow` turns into a skip rather than a guess.
 */
function payoutTicker(assetCode, network) {
    return payoutOptions.providerCoinFor(assetCode, network);
}

/**
 * Why automatic payouts cannot run, for the preflight check.
 *
 * Every condition is reported rather than thrown, because the operator's next action is
 * different for each: fund custody, set a variable, turn a switch on. A single "not
 * configured" collapses those into one unusable message.
 */
function preflight() {
    const reasons = [];

    if (!autoPayoutsEnabled()) {
        reasons.push({
            code: 'disabled',
            detail: 'NOWPAYMENTS_AUTO_PAYOUTS is not set, so nothing is sent automatically.'
        });
    }
    if (!nowPayments.payoutsConfigured()) {
        reasons.push({
            code: 'credentials',
            detail: 'NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD are required for the payout API.'
        });
    }
    if (!nowPayments.getIpnSecret()) {
        // Without a verified callback a finished payout is never noticed, so a withdrawal
        // would sit in `processing` forever and the user would be told it is in flight when
        // it is not.
        reasons.push({
            code: 'ipn-secret',
            detail: 'NOWPAYMENTS_IPN_SECRET is required, otherwise finished payouts are never detected.'
        });
    }
    if (!nowPayments.twoFactorConfigured()) {
        // The one that fails silently. Every other missing setting stops a payout loudly;
        // this one lets the batch be *created* without error and simply never be released, so
        // the withdrawal sits in `processing` with nothing in the logs to explain it.
        reasons.push({
            code: 'two-factor',
            detail: 'NOWPAYMENTS_2FA_SECRET (the Base32 TOTP secret) is required. Without it the batch is created but never verified, so the payout is never sent.'
        });
    }

    return {
        enabled: autoPayoutsEnabled(),
        ready: reasons.length === 0,
        reasons
    };
}

/**
 * Durably claims the crypto withdrawals that may be sent right now.
 *
 * The claim is an `UPDATE ... WHERE status = 'pending' AND payout_status IS NULL RETURNING`,
 * which is what makes it safe to run concurrently: two runs racing for the same row produce
 * one winner, because the second UPDATE matches nothing once the first has committed. The
 * returned rows are the ones this caller exclusively owns.
 *
 * The rows are selected `FOR UPDATE SKIP LOCKED` so a second run does not block on rows the
 * first is still holding, which would serialise two scheduled runs behind each other for no
 * benefit.
 *
 * The amount sent is recomputed per row rather than reused from the request, and stored, so
 * the figure that left the platform can be read back later and compared with the provider's
 * own record. The `fee` is the provider's network fee estimate and is informational: it
 * comes out of the custody balance, not out of the user's amount, so the payout value is the
 * full coin equivalent of what was requested.
 */
async function claimPayoutCandidates({ limit = 10, convertToCoin }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // SKIP LOCKED plus the `payout_status IS NULL` filter: the first is about rows
        // another transaction is mid-update on, the second is about rows this system has
        // already dealt with. Both are needed; neither substitutes for the other.
        const candidates = await client.query(
            `SELECT id, user_id, amount, payment_method, payment_address, asset_code, network,
                    destination_tag, status
             FROM withdrawals
             WHERE status = 'pending'
               AND payment_method = 'crypto'
               AND payout_status IS NULL
               AND asset_code IS NOT NULL
               AND network IS NOT NULL
             ORDER BY created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit]
        );

        const claimed = [];
        const skipped = [];

        for (const row of candidates.rows) {
            const outcome = await claimOneRow(client, row, convertToCoin);
            if (outcome.claimed) claimed.push(outcome.claimed);
            else if (outcome.skipped) skipped.push(outcome.skipped);
        }

        // Skips are reported, not swallowed. A row that cannot be priced or has no ticker is
        // left unclaimed precisely so an operator can see it -- a run that silently consumed
        // it would strand a user whose money never moved with no explanation anywhere.
        for (const skip of skipped) {
            console.warn(`Payout run skipped withdrawal ${skip.id}: ${skip.reason}`);
        }

        await client.query('COMMIT');
        return { claimed, skipped };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Sends an already-claimed set of withdrawals as one batch and records the result.
 *
 * The claim is on file before this runs, so every path out of here is recoverable. A
 * rejected call releases the claim back to `pending` -- nothing was sent, and leaving the
 * rows claimed would strand a user whose money never moved. A call whose outcome is unknown
 * leaves the claim exactly as it is, which is the whole point: the rows stay owned by this
 * submission and reconciliation will find out what happened.
 *
 * `unknown` is the distinction that matters. A provider that answered `400` has not sent
 * anything and the rows are safe to release. A timeout has an undetermined answer, and the
 * only correct response to an undetermined answer is to stop and look.
 */
async function submitClaimedPayouts(claimed) {
    if (claimed.length === 0) return { submitted: 0, released: 0, batchId: null, uncertain: 0, outcomes: [] };

    let response;
    try {
        response = await nowPayments.submitPayoutBatch(claimed, { ipnCallbackUrl: payoutIpnCallbackUrl() });
    } catch (error) {
        const unknown = isUndetermined(error);
        const explanation = providerExplanation(error);
        const detail = explanation ? `${error.message}: ${explanation}` : error.message;
        await releaseOrHoldClaims(claimed, unknown ? 'SUBMISSION_UNKNOWN' : 'SUBMIT_FAILED', detail);
        const outcomes = claimed.map((entry) =>
            summarizeOutcome(entry, {
                verdict: unknown ? 'held' : 'released',
                detail,
                providerMessage: explanation
            })
        );
        logPayoutRun('submitClaimedPayouts', claimed, outcomes);
        return {
            submitted: 0,
            released: unknown ? 0 : claimed.length,
            batchId: null,
            uncertain: unknown ? claimed.length : 0,
            error: detail,
            providerMessage: explanation,
            outcomes
        };
    }

    const batchId = response.batchId;
    for (const entry of response.withdrawals) {
        await recordSubmission(entry, batchId);
    }

    // Creating a batch does not send it. The provider holds the batch until it is verified
    // with a 2FA code, so without this call the withdrawal is stored, the batch exists, no
    // money moves, and no error is raised anywhere -- the row simply sits in `processing`
    // until an operator notices. This is the step that makes the payout automatic.
    if (batchId === null) {
        const outcomes = claimed.map((entry) =>
            summarizeOutcome(entry, { verdict: 'created', detail: 'Batch created but not verified.' })
        );
        logPayoutRun('submitClaimedPayouts', claimed, outcomes);
        return {
            submitted: response.withdrawals.length,
            released: 0,
            batchId: null,
            verified: false,
            uncertain: claimed.length,
            outcomes
        };
    }

    try {
        await nowPayments.verifyPayoutBatch(batchId);
    } catch (error) {
        // A 4xx means the provider understood and refused, so the batch was not released and
        // no funds moved: the rows can safely go back to `pending` for an operator. Anything
        // else -- a timeout, a dropped connection, a 5xx -- leaves it unknown whether the
        // batch was released, and releasing those rows is the one action that can pay a
        // withdrawal twice. They stay claimed for reconciliation instead.
        const unknown = isUndetermined(error);
        const explanation = providerExplanation(error);
        const detail = explanation ? `${error.message}: ${explanation}` : error.message;
        await releaseOrHoldClaims(claimed, unknown ? 'VERIFY_UNKNOWN' : 'VERIFY_FAILED', detail);
        const outcomes = claimed.map((entry) =>
            summarizeOutcome(entry, {
                verdict: unknown ? 'held' : 'released',
                detail,
                providerMessage: explanation
            })
        );
        logPayoutRun('submitClaimedPayouts', claimed, outcomes);
        return {
            submitted: response.withdrawals.length,
            released: unknown ? 0 : claimed.length,
            batchId,
            verified: false,
            uncertain: unknown ? claimed.length : 0,
            error: detail,
            providerMessage: explanation,
            outcomes
        };
    }

    const outcomes = claimed.map((entry) =>
        summarizeOutcome(entry, { verdict: 'sent', detail: `Batch ${batchId} verified.` })
    );
    logPayoutRun('submitClaimedPayouts', claimed, outcomes);
    return {
        submitted: response.withdrawals.length,
        released: 0,
        batchId,
        verified: true,
        uncertain: 0,
        outcomes
    };
}

/**
 * The URL the provider posts payout status updates to.
 *
 * The same endpoint as payments, because the incoming body is already classified into both
 * shapes and either can arrive on the one URL. Returns null when the public origin is not
 * usable, which leaves the provider's dashboard setting in charge rather than sending a
 * callback to a host that cannot receive it.
 */
function payoutIpnCallbackUrl() {
    const publicBaseUrl = resolvePublicBaseUrl();
    if (!publicBaseUrl.ok) return null;
    return new URL('/api/payments/nowpayments/ipn', publicBaseUrl.baseUrl).toString();
}

/**
 * Whether a failure leaves the submission's fate unknown.
 *
 * Only a 4xx is determinate: the provider received the request, understood it, and refused
 * it, so nothing was sent and the claim can safely go back for an operator.
 *
 * Everything else is undetermined, and that includes a `NowPaymentsError` with no status --
 * which is what a transport failure looks like once it has been wrapped, because there was
 * no response to carry one. Treating that as "the send failed" would be the exact bug this
 * distinction exists to prevent: the provider may have accepted the batch and sent the
 * money, and the next run would send it a second time.
 */
function isUndetermined(error) {
    if (!(error instanceof nowPayments.NowPaymentsError)) return true;
    return !(error.status >= 400 && error.status < 500);
}

/**
 * The provider's own explanation of a refusal, when it gave one.
 *
 * A `NowPaymentsError` carries the provider response and a `providerMessage` getter, but the
 * failure paths below used to log only `error.message`, which is the generic "NOWPayments
 * /v1/payout returned 400." That threw away the one sentence naming what would work -- the
 * entire reason the caller falls through to its own message. The detail is lifted out here so
 * every failure path, the outcome array, and the response body all carry the same words.
 */
function providerExplanation(error) {
    if (!error) return null;
    if (error.providerMessage && typeof error.providerMessage === 'string') {
        const trimmed = error.providerMessage.trim();
        if (trimmed) return trimmed;
    }
    if (error.cause && typeof error.cause === 'object' && error.cause.providerMessage) {
        return error.cause.providerMessage;
    }
    return null;
}

/**
 * One line per withdrawal, for the operator.
 *
 * A run that reports only a count cannot tell an operator whether a silent failure left a
 * user waiting, so each claimed row gets a line naming what happened to it and why. The
 * caller can log the array or return it in the response; either way the detail is available
 * wherever the run is driven from.
 */
function summarizeOutcome(entry, outcome) {
    return {
        withdrawalId: entry.id,
        amountUsd: entry.amountUsd,
        asset: entry.assetCode,
        network: entry.network,
        coin: entry.currency,
        coinAmount: entry.amount,
        ...outcome
    };
}

/**
 * Logs one line per claimed withdrawal, at the end of a run.
 *
 * Logged here rather than inline so every path -- success, refusal, and unknown -- produces
 * the same shape, and so a future caller that forgets to log cannot leave a run silent.
 */
function logPayoutRun(label, claimed, outcomes) {
    const summary = outcomes.length
        ? outcomes.map((o) => `${o.withdrawalId}:${o.verdict}`).join(', ')
        : '(none)';
    console.log(`${label}: ${claimed.length} claimed, ${outcomes.length} resolved [${summary}]`);
}

/**
 * Writes the provider's answer onto each claimed row.
 *
 * A per-item status is preferred over the batch id because the provider can accept a batch
 * and still reject one entry in it; storing the batch alone would leave a rejected
 * withdrawal waiting for a callback that will describe it as sent.
 */
async function recordSubmission(entry, batchId) {
    const status = normalisePayoutStatus(entry.status) || 'WAITING';
    // The payout id is the `wd-<id>` key this module derives, so the withdrawal it refers to
    // is recomputed from it rather than carried alongside. Recomputing means a response that
    // does not line up with our claim cannot update a row it has no business touching.
    const id = withdrawalIdFromPayoutId(entry.payoutId);
    if (id === null) return;
    await pool.query(
        `UPDATE withdrawals
         SET payout_status = $1,
             batch_id = COALESCE($2, batch_id),
             payout_submitted_at = NOW(),
             updated_at = NOW()
         WHERE id = $3 AND payout_status = 'CREATING'`,
        [status, batchId, id]
    );
}

/** Recovers the withdrawal id from a `wd-<id>` payout key, or null when it is not one. */
function withdrawalIdFromPayoutId(payoutId) {
    const match = /^wd-(\d{1,19})$/.exec(String(payoutId ?? ''));
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? id : null;
}

/**
 * Releases a claim back to the operator queue, or parks it for inspection.
 *
 * `SUBMIT_FAILED` and `VERIFY_FAILED` provably sent nothing, so the row goes back to
 * `pending` and an operator can send it manually. `SUBMISSION_UNKNOWN` and `VERIFY_UNKNOWN`
 * leave the row in `processing`: the balance is still debited, the user is still waiting, and
 * the batch may or may not exist. Releasing one of those would let the next run send it a
 * second time, and marking it failed would refund a user whose money may already be moving.
 * It stays claimed and visible until reconciliation says what happened.
 *
 * The ownership gate is the id, not the `CREATING` status. This used to require
 * `payout_status = 'CREATING'`, which was correct while nothing wrote a status between the
 * claim and this call. Verification now happens *after* the provider's per-item status has
 * been recorded, so that condition no longer held and both updates silently matched zero
 * rows -- leaving a row in `processing` with no explanation, which is the state this whole
 * function exists to prevent. The rows still belong exclusively to this invocation because
 * they came from the claim query; the status is now only checked to avoid clobbering a payout
 * that has already reached a final state.
 */
const UNRESOLVED_PAYOUT_STATES = "('FINISHED', 'REJECTED', 'REJECTED_NOT_CHECKED')";

async function releaseOrHoldClaims(claimed, status, detail) {
    for (const entry of claimed) {
        const id = withdrawalIdFromPayoutId(entry.payoutId);
        if (id === null) continue;

        if (status === 'SUBMIT_FAILED' || status === 'VERIFY_FAILED') {
            await pool.query(
                `UPDATE withdrawals
                 SET status = 'pending', payout_status = NULL, payout_claimed_at = NULL,
                     payout_address = NULL, payout_currency = NULL,
                     payout_coin_amount = NULL, payout_fee_coin = NULL,
                     payout_error = $1, updated_at = NOW()
                 WHERE id = $2
                   AND status = 'processing'
                   AND (payout_status IS NULL OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES})`,
                [String(detail || 'The provider refused the payout batch.').slice(0, 500), id]
            );
        } else {
            await pool.query(
                `UPDATE withdrawals
                 SET payout_status = $1, payout_error = $2, updated_at = NOW()
                 WHERE id = $3
                   AND (payout_status IS NULL OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES})`,
                [status, String(detail || 'The provider did not answer.').slice(0, 500), id]
            );
        }
    }
}

/**
 * The provider's payout vocabulary, lowercased into a shape the app stores.
 *
 * The provider is uppercase and the database column is not case-checked, so normalising
 * here is what keeps a callback from writing `finished` where the rest of the code expects
 * `FINISHED` and leaving a sent payout looking unresolved forever.
 */
function normalisePayoutStatus(status) {
    if (typeof status !== 'string' || !status) return null;
    const upper = status.toUpperCase();
    return Object.values(nowPayments.PAYOUT_STATUSES).includes(upper) ? upper : null;
}

/** Statuses after which no further transition is expected. */
const resolvedPayoutStatuses = new Set([
    nowPayments.PAYOUT_STATUSES.FINISHED,
    nowPayments.PAYOUT_STATUSES.REJECTED,
    nowPayments.PAYOUT_STATUSES.REJECTED_NOT_CHECKED
]);

/**
 * Applies a payout callback to the withdrawal it belongs to.
 *
 * The batch id is the only link between the provider's callback and our rows, and it is
 * unique, so this affects at most one withdrawal. Anything the provider reports as final
 * is applied through the same `markWithdrawalPaid` / `refundWithdrawal` the operator
 * endpoints use, which is what guarantees the invariants: a `paid` withdrawal cannot be
 * refunded, and a refund is a balance write plus a ledger row in one transaction.
 *
 * A callback for a batch we have never seen is reported rather than treated as success.
 * Marking a payout paid because an unknown id mentioned `FINISHED` would be inventing proof
 * that the money moved.
 */
async function applyPayoutCallback(body) {
    const batchId = String(body?.batch_withdrawal_id ?? body?.batchWithdrawalId ?? '').trim();
    if (!batchId) {
        return { ok: false, reason: 'no-batch-id' };
    }

    const match = await pool.query(
        'SELECT id, status, payout_status FROM withdrawals WHERE batch_id = $1',
        [batchId]
    );
    if (match.rows.length === 0) {
        return { ok: false, reason: 'unknown-batch', batchId };
    }

    const withdrawal = match.rows[0];

    // A finished batch can be reported per item or as a batch-wide status. The item list is
    // preferred because the provider can finish one entry of a batch and reject another.
    const items = Array.isArray(body?.withdrawals) ? body.withdrawals : [];
    const reported = items.length > 0
        ? items
        : [{ status: body?.status }];

    const current = normalisePayoutStatus(withdrawal.payout_status);
    if (current && resolvedPayoutStatuses.has(current)) {
        // Already final. Re-applying would be a second write, and a second refund is the
        // exact double-credit this whole path exists to make impossible.
        return { ok: true, batchId, applied: 0, withdrawalId: withdrawal.id, alreadyResolved: true };
    }

    let applied = 0;
    for (const item of reported) {
        const status = normalisePayoutStatus(item?.status);
        if (!status || !resolvedPayoutStatuses.has(status)) continue;

        if (status === nowPayments.PAYOUT_STATUSES.FINISHED) {
            const result = await sendWithdrawal(withdrawal.id, `batch:${batchId}`);
            if (result.changed) applied += 1;
        } else {
            const result = await reverseWithdrawal(
                withdrawal.id,
                String(item?.error || 'The payout provider rejected this withdrawal.')
            );
            if (result.changed) applied += 1;
        }
        break;
    }

    return { ok: true, batchId, applied, withdrawalId: withdrawal.id };
}

/**
 * Asks the provider about submissions whose outcome was never confirmed.
 *
 * This is the recovery path for a run that died or timed out mid-submission. It reads rather
 * than sends, so running it is always safe, and it only ever resolves rows that are already
 * claimed -- it cannot pick up an unclaimed withdrawal and send it, because that is the
 * operator's decision or the next run's.
 */
async function reconcilePayouts({ limit = 20 } = {}) {
    const pending = await pool.query(
        `SELECT batch_id, id FROM withdrawals
         WHERE payout_status IS NOT NULL
           AND payout_status NOT IN ('FINISHED', 'REJECTED', 'REJECTED_NOT_CHECKED')
           AND batch_id IS NOT NULL
         ORDER BY payout_claimed_at ASC
         LIMIT $1`,
        [limit]
    );

    const outcomes = [];
    for (const row of pending.rows) {
        const batch = await nowPayments.getPayoutBatch(row.batch_id);
        if (!batch) {
            // "Cannot check" is not "failed". Recorded as unresolved so the row is revisited
            // rather than being written off on a transient provider problem.
            outcomes.push({ id: row.id, batchId: row.batch_id, resolved: false, reason: 'provider-unavailable' });
            continue;
        }
        outcomes.push({ id: row.id, batchId: row.batch_id, resolved: true, batch });
    }
    return outcomes;
}

/**
 * Claims one withdrawal inside the caller's transaction.
 *
 * Shared by the batch run and the single-withdrawal dispatch so both go through the identical
 * pricing, ticker resolution, and durable-claim rules. Two copies of this would be two places
 * for the "record the claim before sending" invariant to be forgotten in.
 *
 * Returns `{ claimed }` on success, `{ skipped }` when the row cannot be priced, and neither
 * when another run won the race -- in which case the row is left alone rather than claimed.
 */
async function claimOneRow(client, row, convertToCoin) {
    const ticker = payoutTicker(row.asset_code, row.network);
    if (!ticker) {
        return { skipped: { id: row.id, reason: `No payout ticker for ${row.asset_code}/${row.network}.` } };
    }

    const coinAmount = await convertToCoin(row.amount, ticker);
    if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
        // No conversion means no safe amount. Left unclaimed so an operator can see
        // it rather than being silently consumed by a run.
        return { skipped: { id: row.id, reason: `Could not price ${row.amount} in ${ticker.toUpperCase()}.` } };
    }

    const fee = await nowPayments.getPayoutFee(ticker, coinAmount);

    // The whole claim, in one statement, inside the caller's transaction.
    const result = await client.query(
        `UPDATE withdrawals
         SET status = 'processing',
             payout_status = 'CREATING',
             payout_claimed_at = NOW(),
             payout_address = $1,
             payout_currency = $2,
             payout_coin_amount = $3,
             payout_fee_coin = $4,
             updated_at = NOW()
         WHERE id = $5 AND status = 'pending' AND payout_status IS NULL
         RETURNING id, payout_address, payout_currency, payout_coin_amount, payout_fee_coin`,
        [row.payment_address, ticker, coinAmount, fee, row.id]
    );

    if (result.rows.length === 0) return {};
    return {
        claimed: {
            id: row.id,
            userId: row.user_id,
            amountUsd: row.amount,
            assetCode: row.asset_code,
            network: row.network,
            // Derived from the withdrawal id rather than random, so a provider response
            // and a later reconciliation pass both recompute the same key.
            payoutId: `wd-${row.id}`,
            address: row.payment_address,
            currency: ticker,
            amount: coinAmount,
            fee,
            extraId: row.destination_tag || null
        }
    };
}

/**
 * Sends one just-created crypto withdrawal, immediately, in the request that created it.
 *
 * This is what makes a payout automatic rather than queued: the user asks to withdraw and the
 * payout is submitted in the same interaction, instead of waiting for someone to run the
 * maintenance endpoint.
 *
 * Two properties are deliberate.
 *
 * It goes through the same claim as the batch run, so being triggered from a request buys no
 * privilege: the row is only sent if it was `pending`, only if it is crypto, and only once.
 * A duplicate request cannot send twice, because the second finds the row already claimed.
 *
 * And it never throws. The withdrawal is already committed and the balance already debited by
 * the time this runs, so a provider outage here must not turn a completed withdrawal into an
 * error the user retries -- a retry would be a second withdrawal. A failure is left in the
 * queue for the batch run or the operator, which is exactly where it would have been without
 * this call.
 */
async function dispatchPayoutForWithdrawal({ withdrawalId, convertToCoin }) {
    const unattempted = { attempted: false, submitted: 0, batchId: null, verified: false, uncertain: 0, outcomes: [], reason: null };
    if (!autoPayoutsEnabled()) {
        unattempted.reason = 'automatic-payouts-disabled';
        return unattempted;
    }

    const id = Number(withdrawalId);
    if (!Number.isSafeInteger(id) || id <= 0) {
        unattempted.reason = 'invalid-withdrawal-id';
        return unattempted;
    }

    let claimed = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const row = await client.query(
            `SELECT id, user_id, amount, payment_method, payment_address, asset_code, network,
                    destination_tag, status
             FROM withdrawals
             WHERE id = $1
               AND status = 'pending'
               AND payment_method = 'crypto'
               AND payout_status IS NULL
               AND asset_code IS NOT NULL
               AND network IS NOT NULL
             FOR UPDATE SKIP LOCKED`,
            [id]
        );
        if (row.rows.length > 0) {
            const outcome = await claimOneRow(client, row.rows[0], convertToCoin);
            if (outcome.claimed) claimed.push(outcome.claimed);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Could not claim withdrawal ${id} for automatic payout: ${error.message}`);
        unattempted.reason = 'claim-failed';
        return unattempted;
    } finally {
        client.release();
    }

    if (claimed.length === 0) {
        unattempted.reason = 'nothing-to-claim';
        return unattempted;
    }

    const outcome = await submitClaimedPayouts(claimed);
    // Same shape as the batch run so the operator can grep one log format.
    console.log(`Payout dispatch for withdrawal ${id}: ` +
        `${outcome.submitted} submitted, ${outcome.uncertain} uncertain` +
        (outcome.error ? `, error: ${outcome.error}` : ''));
    return {
        attempted: true,
        submitted: outcome.submitted,
        batchId: outcome.batchId,
        verified: outcome.verified,
        uncertain: outcome.uncertain,
        outcomes: outcome.outcomes,
        ...(outcome.error ? { error: outcome.error } : {})
    };
}

/**
 * USD to coin conversion for a payout, using the provider's own estimate.
 *
 * Lives here rather than in the route so the withdrawal request and the batch run price a
 * payout the same way; a second copy is a second answer to "how many coins is $20". The
 * `convertToCoin` parameter on the claim functions remains the seam for a test double, which
 * is why this default does not need to be swappable itself.
 *
 * Returns null on failure: a withdrawal that cannot be priced is left for an operator rather
 * than sent as a guessed amount.
 */
async function usdToCoin(usdAmount, ticker) {
    const amount = Number(usdAmount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const estimate = await nowPayments.request('GET', '/v1/estimate', {
        query: { amount, currency_from: 'usd', currency_to: String(ticker).toLowerCase() },
        timeoutMs: 10000
    });
    const coin = Number(estimate?.estimated_amount);
    return Number.isFinite(coin) && coin > 0 ? coin : null;
}

module.exports = {
    autoPayoutsEnabled,
    preflight,
    usdToCoin,
    payoutTicker,
    claimPayoutCandidates,
    dispatchPayoutForWithdrawal,
    submitClaimedPayouts,
    applyPayoutCallback,
    reconcilePayouts,
    normalisePayoutStatus,
    resolvedPayoutStatuses,
    isUndetermined
};
