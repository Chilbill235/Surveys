const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/config/db');
const {
    recordPartialPayment,
    hasUncreditedArrival,
    targetStatusFor,
    isPaymentFullyPaid
} = require('../src/services/depositCredit');
const { reconcilePendingDeposits } = require('../src/services/depositReconciliation');
const nowPayments = require('../src/services/nowPayments');

/**
 * Captures the statements a stubbed database is asked for, and answers the two shapes the code
 * under test cares about: the progress write, and the sweep's own statements.
 *
 * Awaited before the stub is lifted. Restoring the pool synchronously -- while the callback is
 * still running -- hands every later statement to the real database, which is both a silently
 * empty assertion and a live write from a unit test.
 */
async function withStubbedDb(run, { answer } = {}) {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const statements = [];

    const respond = async (query, params) => {
        statements.push({ sql: String(query), params });
        if (answer) {
            const custom = await answer(query, params, statements);
            if (custom) return custom;
        }
        if (/UPDATE deposits\s+SET actually_paid/.test(String(query))) {
            return { rows: [{ id: params[3] }], rowCount: 1 };
        }
        if (/SELECT id, user_id/.test(String(query))) return { rows: [] };
        return { rows: [], rowCount: 0 };
    };

    pool.query = respond;
    pool.connect = async () => ({ query: respond, release: () => {} });

    try {
        return await run(statements);
    } finally {
        pool.query = originalQuery;
        pool.connect = originalConnect;
    }
}

const progressWrites = (statements) =>
    statements.filter((s) => /UPDATE deposits\s+SET actually_paid/.test(s.sql));

/**
 * Answers the sweep's own statements for one deposit row.
 *
 * The sweep's SELECT and the credit's `SELECT ... FOR UPDATE` are told apart deliberately: the
 * credit path re-reads the row to check who owns it, and a stub that answered both with the
 * same shape would let a test pass for the wrong reason.
 */
function sweepAnswer(depositRow, { credited = true } = {}) {
    return (query, params) => {
        const sql = String(query);
        if (/SELECT id, user_id/.test(sql)) return { rows: [depositRow], rowCount: 1 };
        if (/UPDATE deposits\s+SET status = 'confirmed'/.test(sql)) {
            return credited
                ? { rows: [{ user_id: depositRow.user_id, amount: '1.00000000' }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }
        if (/UPDATE users SET balance/.test(sql)) return { rows: [{ id: depositRow.user_id }], rowCount: 1 };
        if (/INSERT INTO balance_transactions/.test(sql)) {
            return credited ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return null;
    };
}

/** A statement that closes this specific deposit as failed, if one was issued. */
const failedWriteFor = (statements, depositId) =>
    statements.find((s) => Array.isArray(s.params) && s.params[0] === 'failed' && s.params[1] === depositId);

const silentLogger = { log() {}, warn() {}, error() {} };

test('a short payment is recorded, and the row keeps waiting for the rest', async () => {
    // The real shape from a live SOL deposit: quoted 0.00831676, received 0.00765513.
    await withStubbedDb(async (statements) => {
        const result = await recordPartialPayment(88, {
            actuallyPaid: 0.00765513,
            payCurrency: 'SOL',
            payAmount: 0.00831676
        });

        assert.deepEqual(result, { recorded: true, short: true });
        assert.equal(progressWrites(statements).length, 1);
        const [write] = progressWrites(statements);
        assert.equal(write.params[0], 0.00765513, 'the received total is stored exactly, not rounded');
        assert.equal(write.params[1], 'sol', 'the coin is stored, since it is not the fiat currency');
        assert.equal(write.params[2], true, 'and the row is marked short');

        // The deposit must not be closed by this. A short payment is a payment in progress.
        assert.equal(targetStatusFor('partially_paid'), 'confirming');
        assert.equal(isPaymentFullyPaid({ pay_amount: 0.00831676, actually_paid: 0.00765513 }), false);
    });
});

test('the shortfall timestamp is set once and measures how long it has stood', async () => {
    await withStubbedDb(async (statements) => {
        await recordPartialPayment(88, { actuallyPaid: 0.007, payCurrency: 'sol', payAmount: 0.008 });
        await recordPartialPayment(88, { actuallyPaid: 0.0075, payCurrency: 'sol', payAmount: 0.008 });

        const writes = progressWrites(statements);
        assert.equal(writes.length, 2, 'progress is recorded on every report, not just the first');
        // The SQL itself carries the "set once" rule, so it is asserted here rather than trusted:
        // `underpaid_at` is only written while it is still null, and never cleared afterwards.
        for (const write of writes) {
            assert.match(write.sql, /underpaid_at IS NULL THEN NOW\(\) ELSE underpaid_at END/);
        }
        assert.equal(writes[1].params[0], 0.0075, 'the latest total wins');
    });
});

test('a report with no usable amount leaves no number on the row', async () => {
    // A callback stripped of its fields is what a misconfigured proxy produces. Recording a
    // zero, or a NaN, would put a figure on the row that the provider never asserted.
    for (const actuallyPaid of [undefined, null, '', 'not-a-number', -1]) {
        await withStubbedDb(async (statements) => {
            const result = await recordPartialPayment(88, {
                actuallyPaid,
                payCurrency: 'sol',
                payAmount: 0.008
            });
            assert.deepEqual(result, { recorded: false, short: false }, `for ${JSON.stringify(actuallyPaid)}`);
            assert.equal(progressWrites(statements).length, 0);
        });
    }
});

test('a credited deposit is never written to by a late report', async () => {
    // The write is guarded on `credited_at IS NULL` in SQL. A late callback about money that has
    // already been credited must not rewrite the row, and the guard has to be in the statement
    // because a read-then-write check would race the credit.
    await withStubbedDb(async (statements) => {
        await recordPartialPayment(88, { actuallyPaid: 0.008, payCurrency: 'sol', payAmount: 0.008 });
        assert.match(progressWrites(statements)[0].sql, /credited_at IS NULL/);
    });
});

test('an amount with no quote to compare against is recorded but not called short', () => {
    // Measuring a shortfall needs something to measure it against. With no `pay_amount` the
    // honest answer is "unknown", not "short" and not "complete".
    assert.equal(hasUncreditedArrival({ actually_paid: 0.007 }), true);
    assert.equal(hasUncreditedArrival({ actually_paid: 0 }), false);
    assert.equal(hasUncreditedArrival({ actually_paid: '0' }), false);
    assert.equal(hasUncreditedArrival({}), false);
    assert.equal(hasUncreditedArrival(null), false);
});

test('a payment the provider abandons mid-way is left open, not failed', async () => {
    // The money-loss case. `failed` on a payment that already received crypto would close the
    // row, email the customer that nothing arrived, and leave real coins on an address this app
    // gave them with no row pointing at it. The amount is recorded and the row survives.
    const originalGetPaymentStatus = nowPayments.getPaymentStatus;
    const originalConfigured = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';

    const payment = {
        payment_status: 'expired',
        price_amount: 1,
        price_currency: 'usd',
        pay_amount: 0.00831676,
        actually_paid: 0.00765513,
        pay_currency: 'sol'
    };

    try {
        nowPayments.getPaymentStatus = async () => payment;
        await withStubbedDb(async (statements) => {
            const summary = await reconcilePendingDeposits({ limit: 5, logger: silentLogger });

            assert.equal(summary.failed, 0, 'the deposit must not be closed as a clean failure');
            // Scoped to this row on purpose. The sweep also runs `failOrphanedDeposits`, whose
            // statement text contains `SET status = 'failed'`; matching on the text alone would
            // flag that and hide the real question, which is whether *this* deposit was closed.
            assert.equal(
                failedWriteFor(statements, 88),
                undefined,
                'no failure status may be written for a partly-paid deposit'
            );
            assert.equal(progressWrites(statements).length, 1, 'but the amount that did arrive is kept');
            assert.equal(progressWrites(statements)[0].params[0], 0.00765513);
        }, {
            answer: sweepAnswer({
                id: 88, user_id: 105, amount: '1.00', provider: 'nowpayments',
                provider_payment_id: '6396547002', status: 'confirming', asset_code: 'SOL', currency_code: 'USD'
            })
        });
    } finally {
        nowPayments.getPaymentStatus = originalGetPaymentStatus;
        if (originalConfigured === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = originalConfigured;
    }
});

test('an abandoned payment that received nothing still fails normally', async () => {
    // The guard above needs a positive amount. Without that condition every expired deposit
    // would be left open forever, which is the opposite failure and just as bad.
    const originalGetPaymentStatus = nowPayments.getPaymentStatus;
    const originalConfigured = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';

    try {
        nowPayments.getPaymentStatus = async () => ({
            payment_status: 'expired',
            price_amount: 1,
            price_currency: 'usd',
            pay_amount: 0.00831676,
            actually_paid: 0,
            pay_currency: 'sol'
        });
        await withStubbedDb(async (statements) => {
            const summary = await reconcilePendingDeposits({ limit: 5, logger: silentLogger });
            assert.equal(summary.failed, 1, 'a deposit that received nothing is still closed as failed');
        }, {
            answer: sweepAnswer({
                id: 89, user_id: 105, amount: '1.00', provider: 'nowpayments',
                provider_payment_id: '6396547003', status: 'confirming', asset_code: 'SOL', currency_code: 'USD'
            })
        });
    } finally {
        nowPayments.getPaymentStatus = originalGetPaymentStatus;
        if (originalConfigured === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = originalConfigured;
    }
});

test('a payment that is finally paid in full is credited, not treated as short', async () => {
    // The whole point of tracking: the customer tops up the same address, the payment finishes,
    // and the deposit credits on the next report. Nothing about the earlier partial may block it.
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.00831676, actually_paid: 0.00831676 }), true);
    assert.equal(targetStatusFor('finished'), 'confirmed');

    const originalGetPaymentStatus = nowPayments.getPaymentStatus;
    const originalConfigured = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';

    try {
        nowPayments.getPaymentStatus = async () => ({
            payment_status: 'finished',
            price_amount: 1,
            price_currency: 'usd',
            pay_amount: 0.00831676,
            actually_paid: 0.0084,
            pay_currency: 'sol'
        });
        await withStubbedDb(async (statements) => {
            const summary = await reconcilePendingDeposits({ limit: 5, logger: silentLogger });
            assert.ok(
                statements.some((s) => /INSERT INTO balance_transactions/.test(s.sql)),
                'a finished, fully-paid deposit must reach the credit'
            );
            assert.equal(summary.credited, 1);
            assert.equal(progressWrites(statements).length, 1);
            assert.equal(progressWrites(statements)[0].params[2], false, 'a paid-in-full deposit is not short');
        }, {
            answer: sweepAnswer({
                id: 88, user_id: 105, amount: '1.00', provider: 'nowpayments',
                provider_payment_id: '6396547002', status: 'confirming', asset_code: 'SOL', currency_code: 'USD'
            })
        });
    } finally {
        nowPayments.getPaymentStatus = originalGetPaymentStatus;
        if (originalConfigured === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = originalConfigured;
    }
});
