const pool = require('../config/db');
const nowPayments = require('./nowPayments');
const { sendWithdrawal, reverseWithdrawal } = require('./withdrawalResolution');
const payoutEmails = require('./payoutEmails');
const payoutOptions = require('./payoutOptions');
const { resolvePublicBaseUrl } = require('./publicBaseUrl');
const { COLUMN, isMoneyEmailEnabled } = require('./emailPreferences');

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
        const explanation = providerExplanation(error);
        const detail = explanation ? `${error.message}: ${explanation}` : error.message;

        // The call died before a payout could exist. Refusing the withdrawal here is not a
        // judgement about whether the money went -- there was no payout to go -- and it is the
        // only outcome that gets the user their balance back and an email saying so, instead
        // of a row stuck in `processing` with the money already debited and nothing sent.
        //
        // The funds shortfall is here, beside the auth failure, for the same reason and with the
        // same consequences: a determinate refusal that will be refused identically forever if
        // the row is re-queued, so the user is refunded and told rather than left waiting on a
        // platform account that has nothing to send. It is checked after `failedBeforeSending`
        // because that is the strictly stronger statement -- a call that never got as far as
        // being authenticated cannot be refused for a balance it was never read against.
        if (failedBeforeSending(error) || isProviderFundsShortfall(error)) {
            // The two need different words. An auth failure means the deployment could not
            // reach the provider at all, which is our problem to fix silently; a funds
            // shortfall means the provider was reached and could not pay, and the user is owed
            // both the refund and an explanation of why it is not our fault. The operator keeps
            // the full detail on the row either way.
            return await abandonClaimedPayouts(
                claimed,
                detail,
                explanation,
                isProviderFundsShortfall(error)
                    ? 'We were not able to send this withdrawal because our payment provider could not '
                      + 'complete the transfer at that time. Nothing left your account, and the full amount '
                      + 'has been returned to your balance.'
                    : null
            );
        }

        const unknown = isUndetermined(error);
        // Called out separately because it is the one refusal an operator cannot fix by
        // re-running. The claim is held, so the loop stops, but the row will not settle on its
        // own either: a duplicate id means the provider already holds a payout under this key,
        // and the only way to learn that payout's batch id is the dashboard. Left as an ordinary
        // `held` line it would be indistinguishable from a proxy timeout that reconciliation
        // resolves by itself.
        if (isDuplicateExternalId(error)) {
            console.error(
                `Payout submission for ${claimed.map((entry) => entry.id).join(', ')} was refused ` +
                'because the provider already holds a payout under this unique_external_id. The ' +
                'claims are held rather than released so the withdrawal cannot be sent twice. ' +
                `Find the existing payout on the provider dashboard (external id ` +
                `${claimed.map((entry) => entry.payoutId).join(', ')}) and settle it there, or ` +
                'release the claim by hand once you have confirmed no payout exists.'
            );
        }
        await releaseOrHoldClaims(claimed, unknown ? 'SUBMISSION_UNKNOWN' : 'SUBMIT_FAILED', detail);
        const outcomes = claimed.map((entry) =>
            summarizeOutcome(entry, {
                verdict: unknown ? 'held' : 'released',
                detail,
                providerMessage: explanation
            })
        );
        // Only the held ones. A released claim is back in the queue and will be attempted
        // again, so telling the user about it would describe a delay that is about to end.
        if (unknown) notifyWithdrawalsDelayed(claimed, detail);
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
        // Same reasoning as the submission path: a released claim is retried, a held one is
        // not, and a held one is the one the user is waiting on with no idea why. The stage
        // differs because here the batch was created -- only its release is unconfirmed -- so
        // the money may already be moving and the message has to allow for that.
        if (unknown) notifyWithdrawalsDelayed(claimed, detail, 'verify');
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

    // The batch is created and released. That is the last point at which the app knows for
    // certain the payout is on its way and has not yet been told, so it is where the user is
    // told -- the alternative is a balance that has silently dropped by the full amount with
    // no message until the confirmation arrives, which is when people file a ticket.
    notifyWithdrawalsStarted(claimed);

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
 * Closes claimed withdrawals whose payout could not even be attempted.
 *
 * Used only when the provider call failed before any payout existed, so this is a refund of
 * money that provably never left rather than a reversal of a transfer that may have. It
 * routes through `reverseWithdrawal` rather than editing the row directly, which means the
 * balance credit, the ledger entry, and the user's email all come from the one path that is
 * already correct for "this withdrawal did not happen" -- an operator refund does exactly the
 * same thing. Writing a bespoke `UPDATE` here would have been a second, thinner version of
 * the same state change, and the two would drift.
 *
 * Per-row rather than all-or-nothing, because a batch can straddle the failure: `reverseWithdrawal`
 * refuses a row that is already paid or already carries a provider reference, and that refusal
 * is a correct outcome to report rather than an error to throw over the rows that did resolve.
 *
 * `userReason` is what the refunding email says, and it is optional because not every caller
 * has a phrasing that is better than the raw detail -- see `reverseWithdrawal`.
 */
async function abandonClaimedPayouts(claimed, detail, providerMessage, userReason) {
    const outcomes = [];
    let abandoned = 0;
    let held = 0;

    for (const entry of claimed) {
        const id = withdrawalIdFromPayoutId(entry.payoutId);
        if (id === null) continue;

        try {
            const result = await reverseWithdrawal(id, detail.slice(0, 500), {
                // Omitted entirely when the caller has nothing better to say, so the operator
                // detail reaches the email rather than a blank callout. It is also the wording
                // that goes into the user's history, which is a second reader of the same fact:
                // an entry sitting in someone's transaction list is read by them, not by whoever
                // is on call, so the provider's error string is not left there.
                ...(userReason ? { emailReason: userReason, description: userReason } : {})
            });
            if (result.changed) {
                abandoned += 1;
                outcomes.push(summarizeOutcome(entry, {
                    verdict: 'abandoned',
                    detail,
                    providerMessage
                }));
                continue;
            }
            // Refused for a real reason -- already paid, or a payout was already submitted
            // under this id. The money may be gone, so it is held for an operator rather than
            // force-failed, and the reason is kept on the row.
            held += 1;
            await pool.query(
                `UPDATE withdrawals
                 SET payout_status = 'SUBMISSION_UNKNOWN', payout_error = $1, updated_at = NOW()
                 WHERE id = $2
                   AND (payout_status IS NULL OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES})`,
                [String(result.reason || 'Could not be closed automatically.').slice(0, 500), id]
            );
            outcomes.push(summarizeOutcome(entry, {
                verdict: 'held',
                detail: `${detail} (could not be closed: ${result.reason})`,
                providerMessage
            }));
        } catch (error) {
            held += 1;
            outcomes.push(summarizeOutcome(entry, {
                verdict: 'held',
                detail: `${detail} (close failed: ${error.message})`,
                providerMessage
            }));
        }
    }

    logPayoutRun('submitClaimedPayouts', claimed, outcomes);

    // The one abandonment that is a deployment fault rather than a per-withdrawal outcome, and
    // the only one an operator can fix from the outside. Logged as an error and by amount,
    // because every other withdrawal this run touches will fail the same way until the
    // provider's own account is funded, and the user-visible consequence of that should be a
    // queue of refunded requests rather than a queue of stuck ones.
    if (userReason) {
        console.error(
            'Payout account has insufficient balance: '
            + `${abandoned} withdrawal(s) were refunded to their users (`
            + `${claimed.map((entry) => entry.id).join(', ')}) because the provider refused to send. `
            + 'Fund the NOWPayments payout account. Until it is funded, every payout run refunds the '
            + 'withdrawals it attempts rather than leaving them queued.'
        );
    }

    return {
        submitted: 0,
        released: 0,
        abandoned,
        batchId: null,
        uncertain: held,
        error: detail,
        providerMessage,
        outcomes
    };
}

/**
 * Tells each user their withdrawal has left for the blockchain.
 *
 * One lookup per claim rather than one per entry, and never awaited: the payout is already
 * sent by this point, so a mail provider fault is a missing courtesy, not a failed
 * withdrawal, and holding the run open for it would delay the next claim in the same batch.
 * A claim whose user has no address on file is skipped with a log line rather than throwing.
 */
async function notifyWithdrawalsStarted(claimed) {
    for (const entry of claimed) {
        const id = withdrawalIdFromPayoutId(entry.payoutId);
        if (id === null) continue;
        try {
            const result = await pool.query(
                `SELECT w.amount, w.payout_address, w.payout_currency, w.network, u.email, u.${COLUMN}
                 FROM withdrawals w
                 JOIN users u ON u.id = w.user_id
                 WHERE w.id = $1`,
                [id]
            );
            const row = result.rows[0];
            if (!row || !String(row.email || '').trim()) continue;
            if (!isMoneyEmailEnabled(row[COLUMN])) {
                console.log(`Withdrawal ${id}: user has money email switched off, started email not sent.`);
                continue;
            }
            await payoutEmails.sendWithdrawalStartedEmail({
                to: row.email,
                amount: row.amount,
                assetCode: entry.assetCode || row.payout_currency,
                network: entry.network || row.network,
                destination: entry.address || row.payout_address
            });
        } catch (error) {
            console.error(`Withdrawal ${id}: started email failed (${error.message}).`);
        }
    }
}

/**
 * Tells each user their payout is held rather than sent.
 *
 * The counterpart to `notifyWithdrawalsStarted`, for the run that did not get as far as
 * sending. Without it a held withdrawal is a debited balance with no message at all, which
 * is the state that produces a support ticket or a second withdrawal -- the money is not
 * gone, but nothing in the product says so.
 *
 * Deliberately not awaited by the caller, on the same reasoning as the started notice: the
 * payout's fate is already decided by this point, so a mail provider fault is a missing
 * courtesy rather than a failed payment, and holding the run open for it would delay the
 * next claim in the same batch.
 */
async function notifyWithdrawalsDelayed(claimed, detail, stage = 'submit') {
    for (const entry of claimed) {
        const id = withdrawalIdFromPayoutId(entry.payoutId);
        if (id === null) continue;
        try {
            const result = await pool.query(
                `SELECT w.amount, w.network, w.payout_currency, u.email, u.${COLUMN}
                 FROM withdrawals w
                 JOIN users u ON u.id = w.user_id
                 WHERE w.id = $1`,
                [id]
            );
            const row = result.rows[0];
            if (!row || !String(row.email || '').trim()) continue;
            if (!isMoneyEmailEnabled(row[COLUMN])) {
                console.log(`Withdrawal ${id}: user has money email switched off, delay email not sent.`);
                continue;
            }
            await payoutEmails.sendWithdrawalDelayedEmail({
                to: row.email,
                amount: row.amount,
                assetCode: entry.assetCode || row.payout_currency,
                network: entry.network || row.network,
                reason: detail,
                stage
            });
        } catch (error) {
            console.error(`Withdrawal ${id}: delay email failed (${error.message}).`);
        }
    }
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
    // A refusal over a `unique_external_id` we already sent is the one 4xx that is not
    // determinate. See `isDuplicateExternalId` for why, and why it is handled by exclusion
    // rather than by a status check: the status is 400, the same as every other refusal.
    if (isDuplicateExternalId(error)) return true;
    return !(error.status >= 400 && error.status < 500);
}

/**
 * Whether the provider refused a create because our `unique_external_id` is already taken.
 *
 * This is the answer to a question nobody asked. The id is `wd-<withdrawal id>`, derived from
 * the row rather than generated, so it is stable across every attempt to send the same
 * withdrawal -- which is the point: it is what makes a repeated send impossible. The cost is
 * that once a single attempt has reached the provider, the id is spent forever, and the create
 * call answers `400 unique_external_id already exists` from then on.
 *
 * The failure mode that follows is the reason this is checked separately. Read as an ordinary
 * 4xx, "nothing was sent, release the claim" is exactly wrong: the refusal is *evidence that a
 * payout under this id exists*. Releasing sends the row back to `pending`, the next run claims
 * it, the next send is refused identically, and the loop repeats on every scheduler tick --
 * `1 claimed, 1 resolved [74:released]` forever, with the balance debited and the money never
 * moving. It is also a double-payment hazard in the general case, because a row released to
 * `pending` is a row the app will happily send under a different id once one is supplied.
 *
 * The claim therefore stays held, exactly as it would for a transport failure whose answer is
 * unknown, and reconciliation settles it from whatever the provider reports. It is not treated
 * as a batch that provably never existed, because a duplicate id is proof of the opposite.
 *
 * Matched on the provider's own words rather than on a code, because the code is the generic
 * `BAD_REQUEST` that every refusal shares. Both the structured code and the message are checked
 * so a reworded message alone cannot silently reclassify this back into a releasable failure.
 */
function isDuplicateExternalId(error) {
    if (!(error instanceof nowPayments.NowPaymentsError)) return false;
    if (error.path && String(error.path).trim().toLowerCase() !== '/v1/payout') return false;

    const provider = error.providerResponse;
    const haystack = [
        provider?.code,
        provider?.message,
        provider?.error,
        error.message
    ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');

    return haystack.includes('unique_external_id') && haystack.includes('already exists');
}

/**
 * Whether the provider refused because its own payout wallet could not cover the payout.
 *
 * `POST /v1/payout` answers `400 Insufficient balance` when the platform's own balance is below
 * the amount being sent. It is a determinate refusal -- the provider read the request and
 * declined it, so no payout exists and no money moved -- but it is the one 4xx that must not
 * be released back to `pending`, and the reason is about time rather than about safety.
 *
 * The balance being short is a fact about the platform account, and the fix for it is an
 * operator topping that account up. Re-queuing the user's withdrawal does not touch it. So the
 * row goes back to `pending`, the next scheduler tick claims it, the next send is refused with
 * the same words, and the loop repeats forever -- `1 claimed, 1 resolved [87:released]` on every
 * run, with the user's balance debited the whole time and nothing at all sent. A user watching
 * their request sit in "processing" indefinitely is worse off than a user who has been told
 * their money is back and can try again when the platform can actually pay.
 *
 * So this is treated as an abandonment rather than a release: `abandonClaimedPayouts` refunds
 * the balance through `reverseWithdrawal`, which also writes the ledger row and sends the
 * "your money is back" email, so the refund and the notification are the same event and cannot
 * come apart.
 *
 * Matched on the provider's words for the same reason as `isDuplicateExternalId`: the code is
 * the generic `BAD_REQUEST` every refusal shares, so only the message distinguishes this one.
 * The `path` is checked because a shortfall on a *verification* call means something different
 * from a shortfall on the create, and the create is the only place a batch was refused for lack
 * of funds.
 */
function isProviderFundsShortfall(error) {
    if (!(error instanceof nowPayments.NowPaymentsError)) return false;
    if (error.path && String(error.path).trim().toLowerCase() !== '/v1/payout') return false;

    const provider = error.providerResponse;
    const haystack = [
        provider?.code,
        provider?.message,
        provider?.error,
        error.providerMessage,
        error.message
    ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');

    return haystack.includes('insufficient balance')
        || haystack.includes('insufficient funds')
        || haystack.includes('not enough balance');
}

/**
 * Whether a failure provably happened before any payout could have been sent.
 *
 * `POST /v1/auth` exchanges an email and password for a five-minute JWT. It creates nothing,
 * moves no funds, and is not even authenticated with the API key that identifies the payout.
 * If it did not complete, no batch was created, nothing was submitted, and there is no
 * payout for a callback to arrive about later.
 *
 * That makes it the one transport failure that is safe to give up on, and treating it the
 * same as an undetermined send is what strands a withdrawal: the claim stays in
 * `processing`, the balance stays debited, the run reports `1 uncertain`, and an operator has
 * to decide by hand whether money moved on a call that could not have made it. The symptom
 * is a misconfigured outbound proxy, which is a deployment fault that should not require
 * touching a user's withdrawal to work around.
 *
 * Only the auth path qualifies. A transport failure at `/v1/payout` or `/v1/batch` is left to
 * `isUndetermined`, which is the correct answer there and stays that way.
 */
function failedBeforeSending(error) {
    if (!(error instanceof nowPayments.NowPaymentsError)) return false;
    return String(error.path || '').trim().toLowerCase() === '/v1/auth';
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
 *
 * The provider's own id for the individual payout is stored at the same time. It is what
 * makes the entry pollable later -- the status endpoint addresses one payout, not a batch --
 * and without it a batch of several can only ever be resolved as a single unit, which is the
 * one situation that must not be guessed at.
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
             payout_provider_id = COALESCE($4, payout_provider_id),
             payout_submitted_at = NOW(),
             updated_at = NOW()
         WHERE id = $3 AND payout_status = 'CREATING'`,
        [status, batchId, id, entry.providerWithdrawalId || null]
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
const UNRESOLVED_PAYOUT_STATES =
    "('FINISHED', 'FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED')";

/**
 * The states that are not the provider's to move.
 *
 * A submission or a verification whose outcome was never confirmed is parked here precisely
 * because the app cannot choose: releasing it could pay a withdrawal twice, and refunding it
 * could credit a user whose money is already moving. That judgement belongs to a person
 * reading the NOWPayments dashboard, and `payout_status` is the only column that says so --
 * a row parked here looks identical to an ordinary in-flight payout otherwise.
 *
 * A progress status from the provider is not that judgement. Letting `WAITING` or `SENDING`
 * overwrite the marker silently took the choice away: reconciliation reads the held row, sees
 * the batch sitting in a non-terminal state, writes the progress status over the top, and the
 * row is then an ordinary payout that has quietly stopped moving. Only the terminal states
 * below may resolve a held row, and they go through the same `sendWithdrawal` /
 * `reverseWithdrawal` the operator endpoints use.
 */
const HELD_PAYOUT_STATES = "('SUBMISSION_UNKNOWN', 'VERIFY_UNKNOWN')";

async function releaseOrHoldClaims(claimed, status, detail) {
    for (const entry of claimed) {
        const id = withdrawalIdFromPayoutId(entry.payoutId);
        if (id === null) continue;

        if (status === 'SUBMIT_FAILED' || status === 'VERIFY_FAILED') {
            // `batch_id` and `payout_provider_id` are cleared with the rest of the claim, and
            // they used not to be -- they did not exist when this was written (migration 019
            // added the second one). A released claim provably sent nothing, so the identity of
            // the submission that did not happen has to go with it. Left behind it does real
            // damage twice over: `recordSubmission` coalesces a missing provider id onto
            // whatever is already there, so the *next* claim of this row inherits the id of the
            // dead payout and reconciliation then reads that payout's state onto it; and a
            // released row still answers `withdrawalForBatch` for a batch it is no longer part
            // of, so a callback about that batch can mark a withdrawal paid that was never sent.
            await pool.query(
                `UPDATE withdrawals
                 SET status = 'pending', payout_status = NULL, payout_claimed_at = NULL,
                     batch_id = NULL, payout_provider_id = NULL,
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
 *
 * Both spellings of a cancelled payout are folded onto `CANCELLED` here, so everything
 * downstream -- the resolved set, the reconciliation query, the index that drives it -- has
 * one value to reason about rather than two.
 */
function normalisePayoutStatus(status) {
    if (typeof status !== 'string' || !status) return null;
    const upper = status.toUpperCase();
    if (nowPayments.PAYOUT_CANCELLED_SPELLINGS.includes(upper)) {
        return nowPayments.PAYOUT_STATUSES.CANCELLED;
    }
    return Object.values(nowPayments.PAYOUT_STATUSES).includes(upper) ? upper : null;
}

/**
 * Statuses after which no further transition is expected.
 *
 * `FINISHED` is the success. `FAILED`, `CANCELLED` and the two rejection states are all
 * "the money did not move", and every one of them must end in a refund rather than a wait.
 *
 * That set used to leave `FAILED` and `CANCELLED` out, on the grounds that they were not in
 * the provider's documented list. They are: a payout that fails on-chain or is cancelled
 * without ever being sent is exactly the case where a user must get their money back, and
 * excluding it left the balance debited, the row in `processing`, and no notification -- the
 * user told nothing while being poorer. A status this app does not recognise is treated as
 * unresolved rather than as a failure, because guessing wrong here would refund a payout
 * that is actually in flight.
 */
const resolvedPayoutStatuses = new Set([
    nowPayments.PAYOUT_STATUSES.FINISHED,
    nowPayments.PAYOUT_STATUSES.FAILED,
    nowPayments.PAYOUT_STATUSES.CANCELLED,
    nowPayments.PAYOUT_STATUSES.REJECTED,
    nowPayments.PAYOUT_STATUSES.REJECTED_NOT_CHECKED
]);

/**
 * Applies a payout callback to the withdrawals it belongs to.
 *
 * Entries are matched by the `unique_external_id` this app sent, which is the only link in a
 * callback that identifies one withdrawal unambiguously. A batch id is the fallback, and it
 * is only safe when exactly one row carries it.
 *
 * That fallback used to take the first matching row. With one withdrawal per batch -- which
 * is what the old UNIQUE index on `batch_id` enforced, and what the app produced in practice
 * -- that was fine. A batch carrying several withdrawals, which is the entire point of the
 * endpoint, would have had its first row resolved and the rest silently left in `processing`
 * forever: the callback said `FINISHED` for the third entry and the third withdrawal was
 * never marked paid. Worse, a batch where entry one was rejected and entry three finished
 * would have marked the *rejected* withdrawal as sent.
 *
 * A callback for a payout this app has no record of is reported rather than treated as
 * success. Marking a payout paid because an unknown id mentioned `FINISHED` would be
 * inventing proof that the money moved.
 */
async function applyPayoutCallback(body) {
    const batchId = String(body?.batch_withdrawal_id ?? body?.batchWithdrawalId ?? '').trim();
    if (!batchId) {
        return { ok: false, reason: 'no-batch-id' };
    }

    // A finished batch can be reported per item or as a batch-wide status. The item list is
    // preferred because the provider can finish one entry of a batch and reject another.
    const items = Array.isArray(body?.withdrawals) ? body.withdrawals : [];
    const reported = items.length > 0 ? items : [{ status: body?.status }];

    // Batch-wide status, for a callback that describes the batch rather than its entries.
    const batchStatus = normalisePayoutStatus(body?.status ?? body?.payout_status);

    let applied = 0;
    const seen = new Set();

    for (const item of reported) {
        // An entry that says nothing about itself inherits the batch-wide status, because that
        // is the only description of it there is. An entry that reports a status this app does
        // not recognise does not, and the fallback used to cover both: a provider that added a
        // state to one entry of a batch was read as whichever outcome the *batch* happened to
        // carry, so a new failure spelling inside a `REJECTED` batch refunded a payout that was
        // in flight, and a new state inside a `FINISHED` batch marked it paid. That is the same
        // principle the resolved set is built on -- an unrecognised status is unresolved, never
        // an outcome -- and the entry is left for reconciliation and an operator instead.
        const itemStatus = item?.status ?? item?.payout_status;
        const status = normalisePayoutStatus(itemStatus)
            || (itemStatus === undefined || itemStatus === null ? batchStatus : null);
        if (!status) continue;

        const externalId = String(item?.unique_external_id ?? item?.uniqueExternalId ?? '').trim();
        const target = externalId ? await withdrawalForExternalId(externalId) : await withdrawalForBatch(batchId);
        if (!target) continue;

        // One entry must not be applied twice, however many times the provider repeats itself
        // within a single body.
        const key = `${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        await applyResolvedPayout(target, status, batchId, item?.error, payoutReferenceFrom(item, batchId));
        applied += 1;
    }

    return { ok: true, batchId, applied, withdrawalId: seen.size > 0 ? Number([...seen][0]) : null };
}

/** The withdrawal a `unique_external_id` refers to, recomputed from the key itself. */
async function withdrawalForExternalId(externalId) {
    const id = withdrawalIdFromPayoutId(externalId);
    if (id === null) return null;
    const result = await pool.query(
        'SELECT id, status, payout_status FROM withdrawals WHERE id = $1',
        [id]
    );
    return result.rows[0] ?? null;
}

/**
 * The single withdrawal a batch id refers to, or null when the batch is not unambiguous.
 *
 * Refusing an ambiguous batch is deliberate. Acting on the first of several would resolve a
 * row the callback never mentioned, and the other rows would be left looking unfinished
 * forever with no way to tell they were merely unlisted.
 */
async function withdrawalForBatch(batchId) {
    const result = await pool.query(
        'SELECT id, status, payout_status FROM withdrawals WHERE batch_id = $1',
        [batchId]
    );
    return result.rows.length === 1 ? result.rows[0] : null;
}

/**
 * Writes one provider-reported state onto one withdrawal, through the same resolution paths
 * the operator endpoints use -- which is what guarantees a `paid` withdrawal cannot be
 * refunded, and that a refund is a balance write plus a ledger row in one transaction.
 */
async function applyResolvedPayout(withdrawal, status, batchId, error, reference = null) {
    const current = normalisePayoutStatus(withdrawal.payout_status);
    if (current && resolvedPayoutStatuses.has(current)) {
        // Already final. Re-applying would be a second write, and a second refund is the
        // exact double-credit this whole path exists to make impossible.
        return 'already-resolved';
    }

    if (!resolvedPayoutStatuses.has(status)) {
        // A progress state, not an outcome. Recorded so the user-visible history reflects the
        // payout is genuinely moving -- `SENDING` in particular is the on-chain broadcast,
        // and it used to be silently stored as `WAITING`, reading as "queued, nothing yet".
        if (normalisePayoutStatus(status)) {
            await pool.query(
                `UPDATE withdrawals
                 SET payout_status = $1, updated_at = NOW()
                 WHERE id = $2
                   AND (payout_status IS NULL
                        OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES} ${HELD_PAYOUT_STATES})`,
                [status, withdrawal.id]
            );
        }
        return 'in-progress';
    }

    if (status === nowPayments.PAYOUT_STATUSES.FINISHED) {
        // The reference is what support and the user are shown as proof the money moved, so it
        // has to name something real. `batch:` with nothing after it is what a row whose
        // `batch_id` was never stored used to record, and an empty-looking reference is worse
        // than none: it looks like a value and cannot be looked up. The caller's reference wins
        // when it has one (a transaction hash, or the individual payout id), and the batch id is
        // only the last resort.
        const resolved = reference || (batchId ? `batch:${batchId}` : null);
        if (!resolved) {
            return 'unchanged';
        }
        const result = await sendWithdrawal(withdrawal.id, resolved);
        // The provider's own final state is written alongside the resolution, not left behind.
        //
        // `markWithdrawalPaid` closes the withdrawal but does not touch `payout_status`, so a
        // payout settled by this path kept whatever progress state it last saw -- and the
        // history row a user reads is built from `payout_status`, so a finished payout was
        // still described as "Preparing your payout" long after the money had arrived. That
        // was the visible half of the same stuck row this whole function exists to clear.
        if (result.changed) await recordTerminalPayoutStatus(withdrawal.id, status);
        return result.changed ? 'sent' : 'unchanged';
    }

    const reason = String(
        error ||
        (status === nowPayments.PAYOUT_STATUSES.CANCELLED
            ? 'The payout was cancelled before it was sent.'
            : 'The payout provider could not send this withdrawal.')
    );
    const result = await reverseWithdrawal(withdrawal.id, reason);
    if (result.changed) await recordTerminalPayoutStatus(withdrawal.id, status);
    return result.changed ? 'refunded' : 'unchanged';
}

/**
 * Stores the provider's final state against a withdrawal that has just been resolved.
 *
 * Guarded the same way as the progress write above, so a payout that some other path resolved
 * in the meantime is not overwritten. Fails quietly: the withdrawal is already closed, so a
 * history line that stays one step behind is a cosmetic problem, and throwing here would turn
 * a settled payout into an error report about an unsettled one.
 */
async function recordTerminalPayoutStatus(withdrawalId, status) {
    try {
        await pool.query(
            `UPDATE withdrawals
             SET payout_status = $1, updated_at = NOW()
             WHERE id = $2
               AND (payout_status IS NULL OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES})`,
            [status, withdrawalId]
        );
    } catch (error) {
        console.warn(`Could not record payout status ${status} for withdrawal ${withdrawalId}: ${error.message}`);
    }
}

/**
 * Asks the provider about submissions whose outcome was never confirmed, and settles them.
 *
 * This is the recovery path for a run that died or timed out mid-submission. It reads rather
 * than sends, so running it is always safe, and it only ever resolves rows that are already
 * claimed -- it cannot pick up an unclaimed withdrawal and send it, because that is the
 * operator's decision or the next run's.
 *
 * It settles, rather than merely reporting, and that is the whole reason it exists. The
 * callback is the fast path, but a callback is a POST from a third party to a URL that has to
 * be publicly reachable, and every one of those is a way for a payout to finish on-chain with
 * the app never hearing about it. That state is the most damaging one available: the balance
 * was debited at request time, the user has been told nothing, and the money has left. A
 * reconciliation pass that only logs what it read leaves that withdrawal in `processing`
 * forever -- and because the function was not called from anywhere, it did exactly that.
 *
 * The settling goes through the same `sendWithdrawal` / `reverseWithdrawal` the callback
 * uses, so the idempotency rules are identical: a payout already resolved is not resolved
 * twice, a `paid` withdrawal is never refunded, and a refund is a balance write and a ledger
 * row in one transaction. That is what makes it safe to run this on a timer, every minute,
 * forever.
 */
async function reconcilePayouts({ limit = 20, logger = console } = {}) {
    const pending = await pool.query(
        `SELECT id, batch_id, payout_provider_id, payout_status, payout_claimed_at
         FROM withdrawals
         WHERE payout_status IS NOT NULL
           AND payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES}
           AND (payout_provider_id IS NOT NULL OR batch_id IS NOT NULL)
         ORDER BY payout_claimed_at ASC
         LIMIT $1`,
        [limit]
    );

    const outcomes = [];
    for (const row of pending.rows) {
        // The individual payout id is preferred: it is the only one that can express "this one
        // finished, that one was rejected" within a batch. The batch id is the fallback for
        // rows claimed before the id was stored, and for the window between the create call
        // and the write that records it.
        const lookupId = row.payout_provider_id || row.batch_id;
        const payout = await nowPayments.getPayoutStatus(lookupId);
        if (!payout) {
            // "Cannot check" is not "failed". Recorded as unresolved so the row is revisited
            // rather than being written off on a transient provider problem.
            outcomes.push({ id: row.id, resolved: false, reason: 'provider-unavailable' });
            continue;
        }
        if (payout.notFound) {
            // The provider has no record of this id at all. A submission that was answered
            // with a 4xx never created anything, and a row still holding a claim after that
            // is stuck on a payout that does not exist. Released back to the operator queue
            // rather than left to age -- the user is waiting on money that was never sent.
            const released = await releaseStuckClaim(row.id, 'The provider has no record of this payout.');
            outcomes.push({ id: row.id, resolved: released, reason: 'unknown-to-provider' });
            if (released) {
                logger.warn(`Payout reconciliation: released withdrawal ${row.id}, the provider has no record of ${lookupId}.`);
            }
            continue;
        }

        // A single-payout read may be flat, or may nest the payout under `result`/`payout`.
        // Read across the shapes rather than assuming one, because a wrong guess here reads
        // as "status unknown" and a payout that finished would look unresolved forever.
        const status = payoutStatusFrom(payout, lookupId);
        if (!status) {
            outcomes.push({ id: row.id, resolved: false, reason: 'status-unreadable' });
            continue;
        }

        const outcome = await applyResolvedPayout(
            { id: row.id, payout_status: row.payout_status },
            status,
            row.batch_id || '',
            payoutErrorFrom(payout, lookupId),
            payoutReferenceFrom(payout, lookupId)
        );
        outcomes.push({ id: row.id, resolved: true, status, outcome });
        if (outcome === 'sent' || outcome === 'refunded') {
            logger.log(`Payout reconciliation: withdrawal ${row.id} is ${outcome} (${status}).`);
        }
    }
    return outcomes;
}

/**
 * The individual payout record inside whatever the provider answered with.
 *
 * `GET /v1/payout/{id}` does not answer with the payout. It answers with the *batch* that
 * contains it: `{ id: "<batch id>", createdAt, withdrawals: [ { id, status, hash, ... } ] }`,
 * and it does so whether the id asked for is a batch id or a single payout id. So reading
 * `status` off the top level finds nothing, the status reads as absent, and a payout that
 * genuinely finished is reported as "status-unreadable" and left in `processing` forever --
 * which is precisely the state reconciliation exists to clear.
 *
 * The entry is chosen by matching the id that was actually asked for. Falling back to "the
 * only entry" is safe for a single-withdrawal batch, and a batch with several entries that
 * somehow has no id match resolves to nothing rather than to an arbitrary member: reading
 * one withdrawal's outcome off another withdrawal's record marks the wrong row paid, and a
 * row wrongly stored as paid is then protected by the idempotency check, so the real outcome
 * would be ignored when it did arrive.
 */
function payoutRecordFrom(payout, lookupId) {
    const source = payout?.result ?? payout?.payout ?? payout;
    if (!source || typeof source !== 'object') return null;

    const entries = Array.isArray(source.withdrawals) ? source.withdrawals : null;
    if (!entries || entries.length === 0) return source;

    const wanted = lookupId === null || lookupId === undefined ? '' : String(lookupId).trim();
    if (wanted) {
        const exact = entries.find((entry) => String(entry?.id ?? '').trim() === wanted);
        if (exact) return exact;
    }
    return entries.length === 1 ? entries[0] : null;
}

/** The payout status, wherever the provider chose to put it in the response. */
function payoutStatusFrom(payout, lookupId = null) {
    const source = payoutRecordFrom(payout, lookupId) ?? payout;
    return normalisePayoutStatus(source?.payout_status ?? source?.status ?? payout?.status);
}

/** The provider's explanation of a failure, if it gave one. */
function payoutErrorFrom(payout, lookupId = null) {
    const source = payoutRecordFrom(payout, lookupId) ?? payout;
    const value = source?.error ?? payout?.error;
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    // A structured error is rendered rather than JSON-stringified into the user's inbox.
    const message = value.message ?? value.error ?? null;
    return message ? String(message) : null;
}

/**
 * The proof recorded against a withdrawal the provider says has finished.
 *
 * This is what the user's history shows and what support reads when someone asks where the
 * money went, so it is ordered by how much it is worth to a human: the on-chain transaction
 * hash first, because it is the one value that can be pasted into a block explorer, then the
 * provider's own payout id, and only then the batch id.
 *
 * The batch id is last rather than first on purpose. It is the value this app had the most
 * trouble obtaining -- it is the one field the create response did not spell the way the
 * parser expected -- so a row whose `batch_id` is null was previously recorded with the
 * literal string `batch:`, which reads like a reference and resolves to nothing. Falling
 * through to the individual payout id means a reconciled payout always carries the id the
 * provider dashboard shows.
 */
function payoutReferenceFrom(payout, lookupId) {
    const source = payoutRecordFrom(payout, lookupId) ?? payout ?? {};
    // `hash` is the field the provider actually sends on a finished payout, and the one its
    // dashboard labels "Payout Hash". The longer spellings are kept because they are what the
    // status endpoint uses for a different read, and a hash that cannot be pasted into a
    // block explorer is not worth much as proof.
    const hash = source?.hash ?? source?.payout_hash ?? source?.payoutHash ?? source?.txid
        ?? source?.tx_id ?? source?.transaction_hash ?? source?.transactionHash;
    if (typeof hash === 'string' && hash.trim()) return hash.trim();
    const id = source?.id ?? payout?.id ?? lookupId;
    if (id === null || id === undefined) return null;
    const trimmed = String(id).trim();
    return trimmed ? `payout:${trimmed}` : null;
}

/**
 * Returns a claimed withdrawal to the operator queue because the provider never had it.
 *
 * Only used when the provider positively reports that the id is unknown, which is the one
 * answer that proves nothing was sent. A payout whose status simply cannot be read is left
 * claimed, because "could not check" is not the same as "did not happen" and releasing on it
 * would let the next run send the withdrawal a second time.
 *
 * The batch and provider ids go with the rest of the claim, for the reason given in
 * `releaseOrHoldClaims`: a row that is back in the queue must not still be answerable for a
 * submission the provider never made.
 */
async function releaseStuckClaim(withdrawalId, detail) {
    const result = await pool.query(
        `UPDATE withdrawals
         SET status = 'pending', payout_status = NULL, payout_claimed_at = NULL,
             batch_id = NULL, payout_provider_id = NULL,
             payout_address = NULL, payout_currency = NULL,
             payout_coin_amount = NULL, payout_fee_coin = NULL,
             payout_error = $1, updated_at = NOW()
         WHERE id = $2
           AND status = 'processing'
           AND (payout_status IS NULL OR payout_status NOT IN ${UNRESOLVED_PAYOUT_STATES})`,
        [String(detail).slice(0, 500), withdrawalId]
    );
    return result.rowCount > 0;
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
