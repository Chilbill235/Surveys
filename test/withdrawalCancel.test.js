const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Letting a user cancel their own withdrawal.
 *
 * The feature is small: a button and a POST. The reason it needs its own file is that a
 * withdrawal is a *debit* the moment it is stored, so cancelling it is a refund -- and a refund
 * of a withdrawal whose payout is already moving pays the same person twice. Nothing in the
 * database would disagree with itself afterwards: the ledger would show the withdrawal, the
 * refund, and a `paid` status all at once, and the balance would be the sum of a transaction
 * that happened and one that did not.
 *
 * So the tests are overwhelmingly about refusals. The one path that must succeed is the boring
 * one: a request that has never been claimed.
 */

/**
 * Runs `body` against a fake database that records every statement, and returns both.
 *
 * The rows the fake returns are supplied per-test by matching on the SQL text, which keeps each
 * test readable as "given this row, the refund must not happen" rather than as a pile of
 * positional placeholders.
 */
async function withFakeDb(body, handlers = {}) {
    const statements = [];
    const client = {
        async query(sql, params = []) {
            statements.push({ sql, params });
            for (const [pattern, responder] of Object.entries(handlers)) {
                if (new RegExp(pattern).test(sql)) {
                    return typeof responder === 'function' ? responder(sql, params) : responder;
                }
            }
            return { rows: [], rowCount: 0 };
        },
        release() {}
    };

    // The module takes its pool at require time, so it is stubbed before the test reaches it.
    const poolPath = require.resolve('../src/config/db');
    const resolutionPath = require.resolve('../src/services/withdrawalResolution');
    const emailsPath = require.resolve('../src/services/payoutEmails');
    const prefsPath = require.resolve('../src/services/emailPreferences');

    const originalPool = require.cache[poolPath];
    const originalResolution = require.cache[resolutionPath];
    const originalEmails = require.cache[emailsPath];
    const originalPrefs = require.cache[prefsPath];

    const connect = async () => {
        await client.query('BEGIN');
        return client;
    };
    require.cache[poolPath] = {
        id: poolPath, filename: poolPath, loaded: true, exports: { connect, query: client.query.bind(client) }
    };
    require.cache[emailsPath] = {
        id: emailsPath, filename: emailsPath, loaded: true,
        exports: {
            sendWithdrawalRefundedEmail: async () => {},
            sendWithdrawalSentEmail: async () => {}
        }
    };
    require.cache[prefsPath] = {
        id: prefsPath, filename: prefsPath, loaded: true,
        exports: { COLUMN: 'money_emails_enabled', isMoneyEmailEnabled: () => true }
    };
    delete require.cache[resolutionPath];

    try {
        const resolution = require(resolutionPath);
        const result = await body(resolution);
        return { result, statements };
    } finally {
        if (originalPool) require.cache[poolPath] = originalPool; else delete require.cache[poolPath];
        if (originalEmails) require.cache[emailsPath] = originalEmails; else delete require.cache[emailsPath];
        if (originalPrefs) require.cache[prefsPath] = originalPrefs; else delete require.cache[prefsPath];
        if (originalResolution) require.cache[resolutionPath] = originalResolution;
        else delete require.cache[resolutionPath];
    }
}

/** The row a `SELECT ... FOR UPDATE` returns: a claim that never happened. */
function cancellableRow(overrides = {}) {
    return {
        rows: [{
            id: 7, user_id: 3, amount: '25.00', status: 'pending', payment_method: 'crypto',
            provider_reference: null, payout_status: null, payout_claimed_at: null,
            batch_id: null, payout_provider_id: null, payout_submitted_at: null,
            user_email: 'u@example.test', user_money_emails: true,
            ...overrides
        }],
        rowCount: 1
    };
}

/** The UPDATE that closes the row, and the balance credit, both succeeding. */
const closingStatements = {
    'SET status = \'failed\'': { rows: [{ id: 7, user_id: 3, amount: '25.00', status: 'failed' }], rowCount: 1 },
    'UPDATE users SET balance': { rows: [{ balance: '40.00' }], rowCount: 1 },
    'INSERT INTO balance_transactions': { rows: [{ id: 99 }], rowCount: 1 }
};

test('a withdrawal nobody has claimed can be cancelled, and the money comes back', async () => {
    const { result, statements } = await withFakeDb(
        (resolution) => resolution.cancelWithdrawalByUser(7, 3),
        { 'FOR UPDATE': cancellableRow(), ...closingStatements }
    );

    assert.equal(result.changed, true);
    // The two writes that make the refund real: a balance credit and a `refund` ledger row
    // keyed on the withdrawal, both inside the transaction.
    assert.equal(statements.some((s) => /UPDATE users SET balance = balance \+ \$1/.test(s.sql)), true);
    assert.equal(
        statements.some((s) => /INSERT INTO balance_transactions/.test(s.sql) && /'refund'/.test(s.sql)),
        true
    );
    assert.equal(result.refunded, '25.00');
});

test('a withdrawal cannot be cancelled by someone who does not own it', async () => {
    // The user id is part of the WHERE clause, so another account's row is simply not found.
    // A cancel endpoint that looked the row up by id alone would let any signed-in user refund
    // any withdrawal in the system.
    const { result, statements } = await withFakeDb(
        (resolution) => resolution.cancelWithdrawalByUser(7, 999),
        { 'FOR UPDATE': { rows: [], rowCount: 0 } }
    );
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'not-found');
    assert.equal(statements.some((s) => /UPDATE users SET balance/.test(s.sql)), false);
});

/**
 * The refusal that matters most, and the one a thinner implementation would get wrong.
 *
 * `provider_reference` is only written when a payout reaches `paid`. Every stage before that
 * leaves it NULL -- claimed, batch submitted, in flight, or parked because the provider never
 * answered. So a guard written against `provider_reference` alone sees a crypto payout that is
 * already on its way as an ordinary pending row, refunds it, and the user is paid twice.
 *
 * Each of these columns is one moment where the money may already be moving, so each is tested
 * on its own. A guard that checked only one of them would pass any single test here.
 */
for (const [column, value] of [
    ['payout_claimed_at', new Date()],
    ['payout_status', 'WAITING'],
    ['batch_id', '5006835884'],
    ['payout_provider_id', '5006835884'],
    ['payout_submitted_at', new Date()],
    ['provider_reference', 'batch-abc']
]) {
    test(`a withdrawal with ${column} set cannot be cancelled`, async () => {
        const { result, statements } = await withFakeDb(
            (resolution) => resolution.cancelWithdrawalByUser(7, 3),
            { 'FOR UPDATE': cancellableRow({ [column]: value }) }
        );

        assert.equal(result.changed, false);
        assert.equal(result.reason, 'already-sent');
        // The point of the refusal: no balance was credited.
        assert.equal(statements.some((s) => /UPDATE users SET balance/.test(s.sql)), false);
        assert.equal(statements.some((s) => /INSERT INTO balance_transactions/.test(s.sql)), false);
    });
}

test('a payout the provider never answered about cannot be cancelled either', async () => {
    // `SUBMISSION_UNKNOWN` is the held state from the duplicate-external-id case, and it is
    // exactly the situation a user would most want to cancel: their money has been stuck and
    // they have been told nothing. It is also the one where the app has provably lost the link
    // to whatever the provider did, so the transfer may well be in flight. Refusing is the
    // only safe answer, and the route's message has to say so rather than read as a bug.
    const { result } = await withFakeDb(
        (resolution) => resolution.cancelWithdrawalByUser(74, 105),
        { 'FOR UPDATE': cancellableRow({ id: 74, status: 'processing', payout_status: 'SUBMISSION_UNKNOWN' }) }
    );
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-sent');
});

test('a paid withdrawal is not cancelled, and is not described as missing', async () => {
    const { result } = await withFakeDb(
        (resolution) => resolution.cancelWithdrawalByUser(7, 3),
        { 'FOR UPDATE': cancellableRow({ status: 'paid', provider_reference: 'batch-abc' }) }
    );
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-paid');
});

test('an already-closed withdrawal is not refunded a second time', async () => {
    // Twice in the same click, or once after an operator already refunded it. The status
    // catches the second one before any balance write.
    for (const status of ['failed', 'cancelled']) {
        const { result, statements } = await withFakeDb(
            (resolution) => resolution.cancelWithdrawalByUser(7, 3),
            { 'FOR UPDATE': cancellableRow({ status }) }
        );
        assert.equal(result.changed, false, `a ${status} withdrawal was cancelled again`);
        assert.equal(result.reason, 'already-resolved');
        assert.equal(statements.some((s) => /UPDATE users SET balance/.test(s.sql)), false);
    }
});

test('a claim and a cancel cannot both win, because the row is locked for the decision', async () => {
    // The lock is the whole concurrency argument, so it is asserted rather than assumed: the
    // row is read `FOR UPDATE`, which is what makes a payout run claiming the same row block
    // here until this transaction commits and then skip it (its own claim requires
    // `status = 'pending'`, and this writes `failed`).
    const { statements } = await withFakeDb(
        (resolution) => resolution.cancelWithdrawalByUser(7, 3),
        { 'FOR UPDATE': cancellableRow(), ...closingStatements }
    );
    const lock = statements.find((s) => /FOR UPDATE/.test(s.sql));
    assert.ok(lock, 'the cancel does not lock the withdrawal row');
    // And the lock is taken on the owner-scoped read, not on a separate unscope lookup.
    assert.match(lock.sql, /w\.id = \$1 AND w\.user_id = \$2/);
});

test('a conflicting refund rolls the whole thing back rather than crediting twice', async () => {
    // If the ledger insert failed after the balance had been credited, the user would have
    // money that no ledger row explains -- the exact state `npm run audit:balance` exists to
    // catch, created by this feature rather than found by it.
    //
    // The ledger insert conflicts when a refund row already exists for this withdrawal, which
    // the row status did not reveal: a refund applied and then reversed by hand, for example.
    // The correct behaviour is to throw, so `withTransaction` rolls the balance write back with
    // it -- not to swallow the conflict and report success, which is the version that invents
    // money. The test asserts the throw *and* the rollback, because either alone is half the
    // guarantee.
    let thrown = null;
    const { statements } = await withFakeDb(
        async (resolution) => {
            try {
                await resolution.cancelWithdrawalByUser(7, 3);
            } catch (error) {
                thrown = error;
            }
            return {};
        },
        {
            'FOR UPDATE': cancellableRow(),
            'SET status = \'failed\'': { rows: [{ id: 7, user_id: 3, amount: '25.00' }], rowCount: 1 },
            'UPDATE users SET balance': { rows: [{ balance: '40.00' }], rowCount: 1 },
            'INSERT INTO balance_transactions': { rows: [], rowCount: 0 }
        }
    );

    assert.ok(thrown, 'a conflicting refund was swallowed instead of rolling back');
    assert.match(thrown.message, /already has a refund ledger entry/);
    assert.equal(
        statements.some((s) => s.sql.trim() === 'ROLLBACK'),
        true,
        'the transaction was not rolled back'
    );
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'), 'utf8');

test('the cancel route is registered, POST-only, and behind a session', () => {
    assert.match(routes, /router\.post\('\/withdrawals\/:id\/cancel'/, 'the cancel route is not registered');
    // The method registry is what turns a wrong verb into a 405 instead of a 404, which is the
    // difference between "you used the wrong thing" and "this does not exist".
    assert.match(
        routes,
        /registerMethod\(\/\^\\\/api\\\/user\\\/withdrawals\\\/\\d\{1,19\}\\\/cancel\\\/\?\$\/, \['POST'\]\)/,
        'the cancel route is not registered as POST-only'
    );
});

test('each refusal reaches the user as its own message, not one generic error', () => {
    // The refusals are different problems and the user can act on exactly one of them. In
    // particular `already-sent` must say the balance was *not* refunded: that row is a payout
    // that may already be on-chain, and a message that left the refund unmentioned would be
    // read as "it is on its way back" by anyone who wanted the money.
    assert.match(routes, /'already-sent':\s*\{\s*status: 409/, 'the in-flight refusal has no status');
    assert.match(routes, /Your balance has not been refunded/, 'the in-flight refusal does not say the money was kept');
    assert.match(routes, /Support can confirm it for you/, 'the in-flight refusal does not say what happens next');
    assert.match(routes, /'not-found':\s*\{\s*status: 404/, 'a missing withdrawal is not a 404');
    assert.match(routes, /'already-paid':\s*\{\s*status: 409/, 'a paid withdrawal has no distinct answer');
    assert.match(routes, /'already-resolved':\s*\{\s*status: 409/, 'a closed withdrawal has no distinct answer');
});

test('the list tells the client which rows are cancellable, using the same gate', () => {
    // A UI that reimplemented the rule in JavaScript would drift from the one that enforces it,
    // and the drift shows up as a Cancel button on a payout that is already moving. So the
    // expression is asserted to contain the same columns the service checks.
    assert.match(routes, /AS cancellable/, 'the list does not report which rows are cancellable');
    for (const column of [
        'payout_claimed_at', 'payout_status', 'batch_id',
        'payout_provider_id', 'payout_submitted_at', 'provider_reference'
    ]) {
        assert.match(
            routes,
            new RegExp(`w\\.${column} IS NULL`),
            `the cancellable expression does not require ${column} to be null`
        );
    }
});

test('a cancelled withdrawal reads as refunded, not as a failure', () => {
    // The badge already distinguishes the two from the ledger row rather than the status, and
    // a user-cancelled request is the case where that distinction is the whole message.
    //
    // The wording moved into `withdrawalBadgeLabel`, because the badge now also lets a
    // finished or provider-rejected payout override the coarse `status` column, and a payout
    // stage is not the same question as a refund. What must not change is the precedence: the
    // refund ledger outranks all of it, because "Refunded" is the claim about the user's money
    // and nothing else overrides that.
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(app, /item\.refunded_at/, 'the refund badge no longer reads the ledger');

    const badge = /function withdrawalBadgeLabel\(item, payoutState\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(badge, 'withdrawalBadgeLabel is gone, so the badge has no refund rule at all');
    assert.match(
        badge[1],
        /if \(item\.refunded_at\) return 'Refunded';/,
        'the refund is no longer the first thing the badge considers'
    );
});
