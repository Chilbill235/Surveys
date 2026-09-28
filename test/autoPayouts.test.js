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
    // against the wrong chain and delivers nothing.
    assert.equal(autoPayouts.payoutTicker('USDT', 'ethereum'), 'usdterc20');
    assert.equal(autoPayouts.payoutTicker('USDT', 'tron'), 'usdttrc20');
    assert.equal(autoPayouts.payoutTicker('USDT', 'polygon'), 'usdtmatic');
    assert.equal(autoPayouts.payoutTicker('USDC', 'ethereum'), 'usdce');

    // A coin with one chain falls through to the asset, which is correct for it.
    assert.equal(autoPayouts.payoutTicker('BTC', 'bitcoin'), 'btc');
    assert.equal(autoPayouts.payoutTicker('LTC', 'litecoin'), 'ltc');
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
