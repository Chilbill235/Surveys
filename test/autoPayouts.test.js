const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/config/db');
const nowPayments = require('../src/services/nowPayments');
const autoPayouts = require('../src/services/autoPayouts');

/**
 * These cover the decisions that move money, and they run without a database or a provider
 * by stubbing the boundary. The properties worth protecting are narrow and specific:
 *
 *   - the network-specific ticker, because `usdt` is the wrong coin on every chain but one;
 *   - the claim-before-send ordering, because a crash in the other order loses the fact that
 *     money moved and the next run sends it again;
 *   - refusing to retry an undetermined outcome, which is the only thing that can duplicate
 *     a transfer.
 */

test('a payout ticker is network-specific, and a bare asset is never guessed', () => {
    // The same asset is a different coin on every chain. Sending the bare ticker confirms
    // against the wrong chain and delivers nothing, so the ticker carries the network.
    //
    // The values here come from `src/services/payoutOptions.js`, the single registry of
    // supported destinations. They used to be duplicated in this module and disagreed with
    // it -- USDC on Ethereum resolved to `usdce` here but `usdcerc20` there -- which is how
    // a payout could be sent with a ticker that confirmed against the wrong chain.
    assert.equal(autoPayouts.payoutTicker('USDT', 'ethereum'), 'usdterc20');
    assert.equal(autoPayouts.payoutTicker('USDT', 'tron'), 'usdttrc20');
    assert.equal(autoPayouts.payoutTicker('USDT', 'polygon'), 'usdtmatic');
    assert.equal(autoPayouts.payoutTicker('USDT', 'bsc'), 'usdtbsc');
    assert.equal(autoPayouts.payoutTicker('USDC', 'ethereum'), 'usdcerc20');
    assert.equal(autoPayouts.payoutTicker('USDC', 'polygon'), 'usdcmatic');

    // A coin with one chain resolves to its own ticker.
    assert.equal(autoPayouts.payoutTicker('BTC', 'bitcoin'), 'btc');
    assert.equal(autoPayouts.payoutTicker('LTC', 'litecoin'), 'ltc');
    assert.equal(autoPayouts.payoutTicker('XRP', 'ripple'), 'xrp');

    // A pair the registry does not offer is not guessed. Returning the bare asset would
    // confirm against the wrong chain and deliver nothing, so it comes back null and the
    // claim is skipped for an operator to look at.
    assert.equal(autoPayouts.payoutTicker('USDC', 'solana'), null);
    assert.equal(autoPayouts.payoutTicker('USDT', 'arbitrum'), null);
    assert.equal(autoPayouts.payoutTicker('ZZZ', 'ethereum'), null);
});

test('automatic payouts stay off until they are explicitly switched on', () => {
    const prior = process.env.NOWPAYMENTS_AUTO_PAYOUTS;
    try {
        // Credentials alone must not start sending money. This is the state a fresh
        // deployment is in, and it is the state it should stay in until someone has funded
        // custody and seen a test payout land.
        delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        assert.equal(autoPayouts.autoPayoutsEnabled(), false);

        const off = autoPayouts.preflight();
        assert.equal(off.enabled, false);
        assert.equal(off.ready, false);
        assert.ok(off.reasons.some((reason) => reason.code === 'disabled'));

        // A spelling that looks truthy but is not is treated as off.
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'false';
        assert.equal(autoPayouts.autoPayoutsEnabled(), false);
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = '0';
        assert.equal(autoPayouts.autoPayoutsEnabled(), false);

        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'true';
        assert.equal(autoPayouts.autoPayoutsEnabled(), true);
    } finally {
        if (prior === undefined) delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        else process.env.NOWPAYMENTS_AUTO_PAYOUTS = prior;
    }
});

test('preflight names the IPN secret, because a finished payout nobody hears about never settles', () => {
    const priorAuto = process.env.NOWPAYMENTS_AUTO_PAYOUTS;
    const priorIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    try {
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'true';
        delete process.env.NOWPAYMENTS_IPN_SECRET;

        const check = autoPayouts.preflight();
        assert.equal(check.enabled, true);
        // Without a verified callback a sent payout is never noticed, so the withdrawal would
        // sit in `processing` and the user would be told it is in flight when it is not.
        assert.equal(check.ready, false);
        assert.ok(check.reasons.some((reason) => reason.code === 'ipn-secret'));
    } finally {
        if (priorAuto === undefined) delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        else process.env.NOWPAYMENTS_AUTO_PAYOUTS = priorAuto;
        if (priorIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorIpn;
    }
});

test('a provider rejection is retried, but an undetermined answer never is', () => {
    // A 4xx provably did nothing: the provider refused it, so no money moved and the claim
    // can be handed back for an operator.
    const rejected = new nowPayments.NowPaymentsError('bad request', { status: 400 });
    assert.equal(autoPayouts.isUndetermined(rejected), false);

    const notFound = new nowPayments.NowPaymentsError('missing', { status: 404 });
    assert.equal(autoPayouts.isUndetermined(notFound), false);

    // A 5xx means the provider may have acted before the answer was lost. Retrying is the one
    // action that duplicates a transfer, so it is not taken.
    const serverError = new nowPayments.NowPaymentsError('gateway', { status: 502 });
    assert.equal(autoPayouts.isUndetermined(serverError), true);

    // A wrapped transport failure carries no status at all, because there was no response to
    // carry one. That is the case most likely to be mistaken for "the send failed" and it is
    // the one that must never be retried.
    const noResponse = new nowPayments.NowPaymentsError('socket hang up');
    assert.equal(noResponse.status, 0);
    assert.equal(autoPayouts.isUndetermined(noResponse), true);

    // No response at all -- a timeout or a dropped socket -- is the definition of unknown.
    assert.equal(autoPayouts.isUndetermined(new Error('socket hang up')), true);
});

test('the provider payout vocabulary is normalised, so a sent payout is not left looking unresolved', () => {
    // The provider is uppercase. Storing what it sent verbatim is fine, but a lowercase
    // variant from a different API version must land on the same value, or a finished payout
    // would never match the `FINISHED` the reconciliation and callback paths look for.
    assert.equal(autoPayouts.normalisePayoutStatus('FINISHED'), 'FINISHED');
    assert.equal(autoPayouts.normalisePayoutStatus('finished'), 'FINISHED');
    assert.equal(autoPayouts.normalisePayoutStatus('Finished'), 'FINISHED');
    assert.equal(autoPayouts.normalisePayoutStatus('REJECTED'), 'REJECTED');

    // Anything outside the documented vocabulary is not mapped onto one of its values: an
    // invented status would be written as if the provider had said it.
    assert.equal(autoPayouts.normalisePayoutStatus('SOMETHING_NEW'), null);
    assert.equal(autoPayouts.normalisePayoutStatus(''), null);
    assert.equal(autoPayouts.normalisePayoutStatus(undefined), null);
});

test('only a final provider status counts as resolved', () => {
    for (const status of ['FINISHED', 'REJECTED', 'REJECTED_NOT_CHECKED']) {
        assert.equal(autoPayouts.resolvedPayoutStatuses.has(status), true, status);
    }
    // Everything before the end still has a callback or a reconciliation pass to wait for, so
    // treating these as final would stop a payout being tracked before it had happened.
    for (const status of ['NEW', 'CREATING', 'WAITING', 'PROCESSING', 'SUBMISSION_UNKNOWN']) {
        assert.equal(autoPayouts.resolvedPayoutStatuses.has(status), false, status);
    }
});

/**
 * Runs `work` with the database boundary recorded rather than executed.
 *
 * `pool.connect` is replaced as well as `pool.query` because `pg` implements `query` on top
 * of `connect`: replacing only `query` leaves the real one calling a callback the
 * replacement never invokes, and the request waits forever instead of failing.
 *
 * Parameters are recorded alongside the SQL because the values a statement writes are usually
 * placeholders in the text -- asserting on the text alone would check the wrong thing, and
 * would pass whether or not the right status was actually stored.
 */
async function withRecordedDatabase(run, { candidates = [] } = {}) {
    const originalConnect = pool.connect;
    const originalQuery = pool.query;
    const statements = [];

    const record = (query, params) => {
        statements.push({ sql: String(query).replace(/\s+/g, ' ').trim(), params: params || [] });
        if (String(query).includes('FOR UPDATE SKIP LOCKED')) {
            return { rows: candidates, rowCount: candidates.length };
        }
        // The claim is an `UPDATE ... RETURNING`, and its result is what tells the caller it
        // won the row. Without this every claim looks lost, which silently turns "the payout
        // was sent" assertions into "nothing was claimed" ones.
        if (String(query).includes("payout_status = 'CREATING'") && String(query).includes('RETURNING')) {
            const row = candidates[0]
                ? [{ id: candidates[0].id, payout_address: candidates[0].payment_address, payout_currency: null, payout_coin_amount: null, payout_fee_coin: null }]
                : [];
            return { rows: row, rowCount: row.length };
        }
        return { rows: [], rowCount: 0 };
    };

    const client = {
        query: async (query, params) => record(query, params),
        release: () => {}
    };
    pool.connect = async () => client;
    pool.query = async (query, params) => record(query, params);

    try {
        return { result: await run(statements), statements };
    } finally {
        pool.connect = originalConnect;
        pool.query = originalQuery;
    }
}

/** The statements whose text contains `needle`, for readable assertions below. */
function matching(statements, needle) {
    return statements.filter((entry) => entry.sql.includes(needle));
}

/** Whether any recorded statement wrote `value` as one of its parameters. */
function wroteValue(statements, value) {
    return statements.some((entry) => entry.params.includes(value));
}

test('a claim is scoped to crypto withdrawals that have not been claimed before', async () => {
    const candidate = {
        id: 7, user_id: 1, amount: '25.00', payment_method: 'crypto',
        payment_address: 'bc1qexample', asset_code: 'BTC', network: 'bitcoin',
        destination_tag: null, status: 'pending'
    };

    const { statements } = await withRecordedDatabase(
        (records) => autoPayouts.claimPayoutCandidates({
            limit: 5,
            convertToCoin: async () => 0.001
        }),
        { candidates: [candidate] }
    );

    const select = matching(statements, 'FOR UPDATE SKIP LOCKED');
    assert.equal(select.length, 1, 'the claim must select rows it can lock exclusively');

    // PayPal and Venmo are not payable by this provider at all. The filter lives in the query
    // rather than in JavaScript so a PayPal address cannot reach it even if a caller asks.
    assert.match(select[0].sql, /payment_method = 'crypto'/);

    // The second guard is the whole double-send defence: a row already dealt with is not a
    // candidate again, and the UPDATE repeats the same condition so two runs racing for one
    // row produce a single winner.
    assert.match(select[0].sql, /payout_status IS NULL/);
    const claim = matching(statements, "payout_status = 'CREATING'");
    assert.equal(claim.length, 1, 'the claim itself must be written durably');
    assert.match(claim[0].sql, /payout_status IS NULL/);
    assert.match(claim[0].sql, /status = 'pending'/);
});

test('a withdrawal that cannot be priced is skipped, not sent as a guessed amount', async () => {
    const candidate = {
        id: 7, user_id: 1, amount: '25.00', payment_method: 'crypto',
        payment_address: 'bc1qexample', asset_code: 'BTC', network: 'bitcoin',
        destination_tag: null, status: 'pending'
    };

    const { result, statements } = await withRecordedDatabase(
        () => autoPayouts.claimPayoutCandidates({
            limit: 5,
            // A conversion that fails yields null, and a null amount must never reach the
            // provider.
            convertToCoin: async () => null
        }),
        { candidates: [candidate] }
    );

    assert.deepEqual(result.claimed, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /Could not price/);

    // Nothing was claimed, so no row was written -- the withdrawal stays visible to an
    // operator instead of being silently consumed by a run.
    assert.equal(matching(statements, "status = 'processing'").length, 0);
});

test('a refused submission releases the claim, and an unknown one holds it', async () => {
    const claimed = [{ id: 5, payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const originalSubmit = nowPayments.submitPayoutBatch;
    try {
        // Provably sent nothing: the row goes back to `pending` so an operator can send it, and
        // the claim is cleared so a later run can pick it up.
        nowPayments.submitPayoutBatch = async () => {
            throw new nowPayments.NowPaymentsError('rejected', { status: 400 });
        };
        const released = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));

        assert.equal(released.result.uncertain, 0);
        const release = matching(released.statements, "SET status = 'pending'");
        assert.equal(release.length, 1, 'a provably-unsent claim must be released back to pending');
        assert.match(release[0].sql, /payout_status = NULL/);

        // Outcome unknown: the row stays claimed. Releasing it would let the next run send it
        // again, and failing it would refund a user whose money may already be moving.
        nowPayments.submitPayoutBatch = async () => {
            throw new Error('socket hang up');
        };
        const held = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));

        assert.equal(held.result.uncertain, 1);
        assert.equal(held.result.submitted, 0);
        assert.equal(
            matching(held.statements, "SET status = 'pending'").length,
            0,
            'an undetermined submission must never be released for a resend'
        );
        // Parked in a state an operator can find, and left in `processing` rather than moved.
        assert.equal(wroteValue(held.statements, 'SUBMISSION_UNKNOWN'), true);
        assert.equal(wroteValue(held.statements, 'pending'), false);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
    }
});

/**
 * The batch is created but not sent until it is verified.
 *
 * This is the step whose absence produces no error at all: the provider accepts the batch,
 * holds it, and waits. So these assert the call is made, and that a verification that fails
 * is treated by the same determinate/unknown rule as the submission itself.
 */
test('a created batch is verified, because a batch that is not verified is never sent', async () => {
    const claimed = [{ id: 5, payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const originalSubmit = nowPayments.submitPayoutBatch;
    const originalVerify = nowPayments.verifyPayoutBatch;
    const verified = [];
    try {
        nowPayments.submitPayoutBatch = async () => ({
            batchId: 'batch-1',
            withdrawals: [{ payoutId: 'wd-5', providerWithdrawalId: 'p-1', status: 'WAITING' }]
        });
        nowPayments.verifyPayoutBatch = async (batchId) => {
            verified.push(batchId);
            return { batchId, verified: true };
        };

        const { result } = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));

        // The exact id the provider returned, not a fresh one: verifying an id that was never
        // submitted would confirm nothing while appearing to succeed.
        assert.deepEqual(verified, ['batch-1']);
        assert.equal(result.verified, true);
        assert.equal(result.uncertain, 0);
        assert.equal(result.released, 0);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        nowPayments.verifyPayoutBatch = originalVerify;
    }
});

test('a refused verification releases the claim, and an undetermined one holds it', async () => {
    const claimed = [{ id: 5, payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const originalSubmit = nowPayments.submitPayoutBatch;
    const originalVerify = nowPayments.verifyPayoutBatch;
    try {
        nowPayments.submitPayoutBatch = async () => ({
            batchId: 'batch-1',
            withdrawals: [{ payoutId: 'wd-5', providerWithdrawalId: 'p-1', status: 'WAITING' }]
        });

        // A 4xx from verify means the batch was not released, so no funds moved and the row can
        // go back for an operator.
        nowPayments.verifyPayoutBatch = async () => {
            throw new nowPayments.NowPaymentsError('bad code', { status: 400 });
        };
        const released = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));
        assert.equal(released.result.verified, false);
        assert.equal(released.result.uncertain, 0);
        assert.equal(
            matching(released.statements, "SET status = 'pending'").length,
            1,
            'a provably-unverified batch must be released back for manual handling'
        );

        // A timeout on verify is the dangerous case: the batch may have been released, and
        // releasing the row would let it be paid a second time.
        nowPayments.verifyPayoutBatch = async () => {
            throw new Error('socket hang up');
        };
        const held = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));
        assert.equal(held.result.uncertain, 1);
        assert.equal(
            matching(held.statements, "SET status = 'pending'").length,
            0,
            'an undetermined verification must never be released for a resend'
        );
        assert.equal(wroteValue(held.statements, 'VERIFY_UNKNOWN'), true);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        nowPayments.verifyPayoutBatch = originalVerify;
    }
});

test('a claim is still releasable after the provider status was recorded', async () => {
    // Regression guard for an ordering mistake: verification happens after the per-item status
    // is written, so a release gated on `payout_status = 'CREATING'` would match no rows at
    // all. The claim would then be stranded in `processing` with nothing in the logs, which is
    // the exact state the release path exists to prevent.
    const claimed = [{ id: 5, payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const originalSubmit = nowPayments.submitPayoutBatch;
    const originalVerify = nowPayments.verifyPayoutBatch;
    try {
        nowPayments.submitPayoutBatch = async () => ({
            batchId: 'batch-1',
            // 'WAITING' is a real status, so `recordSubmission` overwrites 'CREATING' with it
            // before verification runs.
            withdrawals: [{ payoutId: 'wd-5', providerWithdrawalId: 'p-1', status: 'WAITING' }]
        });
        nowPayments.verifyPayoutBatch = async () => {
            throw new nowPayments.NowPaymentsError('bad code', { status: 400 });
        };

        const { statements } = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));

        assert.equal(wroteValue(statements, 'WAITING'), true, 'the provider status must be recorded');
        const release = matching(statements, "SET status = 'pending'");
        assert.equal(release.length, 1, 'the release must still match after the status changed');
        // Ownership is asserted on the id, and only a final state is protected.
        assert.match(release[0].sql, /WHERE id = \$2/);
        assert.match(release[0].sql, /NOT IN \('FINISHED', 'REJECTED', 'REJECTED_NOT_CHECKED'\)/);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        nowPayments.verifyPayoutBatch = originalVerify;
    }
});

test('a batch that is never verified is not a completed payout', async () => {
    // With no batch id there is nothing to verify, so nothing was sent. The rows are reported
    // as uncertain rather than submitted, because their fate is genuinely unknown.
    const claimed = [{ id: 5, payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const originalSubmit = nowPayments.submitPayoutBatch;
    const originalVerify = nowPayments.verifyPayoutBatch;
    let verifyCalls = 0;
    try {
        nowPayments.submitPayoutBatch = async () => ({
            batchId: null,
            withdrawals: [{ payoutId: 'wd-5', providerWithdrawalId: null, status: null }]
        });
        nowPayments.verifyPayoutBatch = async () => {
            verifyCalls += 1;
            return { verified: true };
        };

        const { result } = await withRecordedDatabase(() => autoPayouts.submitClaimedPayouts(claimed));
        assert.equal(verifyCalls, 0, 'there is no id to verify');
        assert.equal(result.verified, false);
        assert.equal(result.uncertain, 1);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        nowPayments.verifyPayoutBatch = originalVerify;
    }
});

test('preflight names the missing 2FA secret, which is the one that fails silently', () => {
    const priorAuto = process.env.NOWPAYMENTS_AUTO_PAYOUTS;
    const priorIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const priorTwoFactor = process.env.NOWPAYMENTS_2FA_SECRET;
    try {
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'true';
        process.env.NOWPAYMENTS_IPN_SECRET = 'ipn-secret';
        delete process.env.NOWPAYMENTS_2FA_SECRET;

        const check = autoPayouts.preflight();
        assert.equal(check.ready, false);
        const reason = check.reasons.find((entry) => entry.code === 'two-factor');
        assert.ok(reason, 'a missing TOTP secret must be reported');
        // Every other missing setting fails loudly. This one lets the batch be created without
        // error and simply never be sent, so the message has to say what actually happens.
        assert.match(reason.detail, /never verified/);

        // Setting it is what makes the deployment ready.
        process.env.NOWPAYMENTS_2FA_SECRET = 'JBSWY3DPEHPK3PXP';
        assert.equal(
            autoPayouts.preflight().reasons.some((entry) => entry.code === 'two-factor'),
            false
        );
    } finally {
        if (priorAuto === undefined) delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        else process.env.NOWPAYMENTS_AUTO_PAYOUTS = priorAuto;
        if (priorIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorIpn;
        if (priorTwoFactor === undefined) delete process.env.NOWPAYMENTS_2FA_SECRET;
        else process.env.NOWPAYMENTS_2FA_SECRET = priorTwoFactor;
    }
});

/**
 * The trigger that makes a payout automatic: the withdrawal request sends it.
 *
 * The claim is the property that matters. Being triggered from a request must not be a way to
 * skip the guard, or a double-clicked button would pay a user twice.
 */
test('a new withdrawal is dispatched immediately, and only while automatic payouts are on', async () => {
    const priorAuto = process.env.NOWPAYMENTS_AUTO_PAYOUTS;
    const originalSubmit = nowPayments.submitPayoutBatch;
    const originalVerify = nowPayments.verifyPayoutBatch;
    const cryptoRow = {
        id: 9, user_id: 1, amount: '20.00', payment_method: 'crypto',
        payment_address: 'bc1qexample', asset_code: 'BTC', network: 'bitcoin',
        destination_tag: null, status: 'pending'
    };
    const convertToCoin = async () => 0.002;

    try {
        let sends = 0;
        nowPayments.submitPayoutBatch = async () => {
            sends += 1;
            return {
                batchId: 'batch-9',
                withdrawals: [{ payoutId: 'wd-9', providerWithdrawalId: 'p-9', status: 'WAITING' }]
            };
        };
        nowPayments.verifyPayoutBatch = async () => ({ verified: true });

        // Off by default: the withdrawal is recorded and left in the queue.
        delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        const off = await withRecordedDatabase(
            () => autoPayouts.dispatchPayoutForWithdrawal({ withdrawalId: 9, convertToCoin }),
            { candidates: [cryptoRow] }
        );
        assert.equal(off.result.attempted, false);
        assert.equal(sends, 0, 'nothing may be sent while automatic payouts are disabled');

        // On: the same row is claimed and sent without an operator.
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'true';
        const on = await withRecordedDatabase(
            () => autoPayouts.dispatchPayoutForWithdrawal({ withdrawalId: 9, convertToCoin }),
            { candidates: [cryptoRow] }
        );
        assert.equal(on.result.attempted, true);
        assert.equal(on.result.verified, true);
        assert.equal(on.result.batchId, 'batch-9');
        assert.equal(sends, 1);

        // The claim still requires a `pending` crypto row. A PayPal withdrawal, or one that
        // was already claimed, is not something this path can send.
        // Matched on the SET clause rather than on `payout_status = 'CREATING'`, which also
        // appears in the WHERE of the statement that records the provider's reply -- so
        // matching the bare phrase counts two statements and proves nothing.
        const claim = matching(on.statements, "SET status = 'processing'");
        assert.equal(claim.length, 1, 'exactly one claim, and exactly one send');
        assert.match(claim[0].sql, /payout_status = 'CREATING'/);
        assert.match(claim[0].sql, /WHERE id = \$5 AND status = 'pending' AND payout_status IS NULL/);
        const targeted = matching(on.statements, 'FOR UPDATE SKIP LOCKED')[0];
        assert.match(targeted.sql, /payment_method = 'crypto'/);
        assert.match(targeted.sql, /WHERE id = \$1/);
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        nowPayments.verifyPayoutBatch = originalVerify;
        if (priorAuto === undefined) delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        else process.env.NOWPAYMENTS_AUTO_PAYOUTS = priorAuto;
    }
});

test('a row that is no longer claimable is never sent by the request path', async () => {
    const priorAuto = process.env.NOWPAYMENTS_AUTO_PAYOUTS;
    const originalSubmit = nowPayments.submitPayoutBatch;
    try {
        process.env.NOWPAYMENTS_AUTO_PAYOUTS = 'true';
        let sends = 0;
        nowPayments.submitPayoutBatch = async () => {
            sends += 1;
            return { batchId: 'batch-9', withdrawals: [] };
        };

        // An empty candidate list is what a duplicate request or an already-claimed row sees.
        const { result } = await withRecordedDatabase(
            () => autoPayouts.dispatchPayoutForWithdrawal({
                withdrawalId: 9,
                convertToCoin: async () => 0.002
            }),
            { candidates: [] }
        );

        assert.equal(result.attempted, false);
        assert.equal(sends, 0, 'a withdrawal that cannot be claimed must not be sent');
    } finally {
        nowPayments.submitPayoutBatch = originalSubmit;
        if (priorAuto === undefined) delete process.env.NOWPAYMENTS_AUTO_PAYOUTS;
        else process.env.NOWPAYMENTS_AUTO_PAYOUTS = priorAuto;
    }
});
