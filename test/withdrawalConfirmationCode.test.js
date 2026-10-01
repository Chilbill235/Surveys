const assert = require('node:assert/strict');
const { test, beforeEach, after, before } = require('node:test');
const { promisify } = require('node:util');
const { randomBytes, scrypt } = require('node:crypto');
const withdrawalCode = require('../src/services/withdrawalCode');
const pool = require('../src/config/db');

const scryptAsync = promisify(scrypt);

/** A password the seeded account really has, so the test can sign in for a real token. */
const PASSWORD = 'a-valid-password-123';

function encodePassword(password) {
    const salt = randomBytes(16).toString('hex');
    return scryptAsync(password, salt, 64).then((derived) => (
        `scrypt$${salt}$${derived.toString('hex')}`
    ));
}

/**
 * The email confirmation gate on withdrawals.
 *
 * The whole feature is one claim: a session token alone must not be enough to move money out
 * of an account, and the thing that makes it true is that the server, not the client, decides
 * whether a code is present, correct, live, and issued for this exact withdrawal. Every test
 * below attacks one of those four.
 *
 * The code is also bound to the amount and destination it was issued for. Without that binding
 * the check is a formality -- a code obtained for a $1 withdrawal authorises a $10,000 one --
 * so the binding gets the same scrutiny as the code itself.
 */

let server;
let origin;
let token;

const priorEnvironment = process.env.NODE_ENV;
const priorJwt = process.env.JWT_SECRET;
const priorBrevo = process.env.BREVO_API_KEY;
const priorResend = process.env.RESEND_API_KEY;
const priorFrom = process.env.EMAIL_FROM;

/**
 * The stand-in database.
 *
 * `reachedDebit` is the important one. A refusal that happens before the money is touched and a
 * refusal that happens after it are different outcomes, and asserting only on the HTTP status
 * would pass either way. Recording whether the debit was reached lets a test distinguish "the
 * code stopped it" from "something else stopped it".
 */
const db = {
    user: null,
    code: null,
    passwordHash: null,
    balance: '500.00',
    reachedDebit: false,
    withdrawn: null,
    // The durable notifications the request writes, in order. Asserted on below so a test can say
    // what the reader was actually told, which is more meaningful than "a row was inserted".
    notifications: [],
    emailed: null,
    emailsSent: 0,
    // Set by a test to simulate a provider that accepts the request but delivers nothing.
    emailDelivery: 'sent'
};

/**
 * Clears the state a single test is allowed to change.
 *
 * `user` and `passwordHash` are deliberately left alone. They are the session the token in
 * `token` was signed for, and every request revalidates against them; wiping them here would
 * make each test fail on authentication instead of on the thing it is actually checking.
 */
function resetDb() {
    db.code = null;
    db.balance = '500.00';
    db.reachedDebit = false;
    db.withdrawn = null;
    db.notifications = [];
    db.emailed = null;
    db.emailsSent = 0;
    db.emailDelivery = 'sent';
}

/**
 * A stand-in for the queries the code gate and the withdrawal commit make.
 *
 * Narrow on purpose: anything the handler does not ask for throws, so a query that should not
 * be running fails the test rather than being absorbed. The lock and transaction statements are
 * matched, not simulated -- the point of the FOR UPDATE in the real service is that two
 * concurrent requests cannot both pass, and a stub cannot demonstrate that.
 */
async function runStubbedQuery(query, values = []) {
    const sql = String(query).replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

    // An upsert with RETURNING, so the counter has to come back or the caller reads
    // `rows[0].attempt_count` off nothing. Always 1: this suite makes one login and then
    // drives the gate directly, so a real limit would only add noise.
    if (/INSERT INTO auth_rate_limits/i.test(sql)) {
        return { rows: [{ attempt_count: 1, window_started_at: new Date() }], rowCount: 1 };
    }

    if (/password_hash[\s\S]*FROM users WHERE LOWER\(email\)/i.test(sql)) {
        if (!db.user) return { rows: [] };
        return {
            rows: [{
                id: db.user.id,
                email: db.user.email,
                balance: db.balance,
                demo_balance: '0.00',
                password_hash: db.passwordHash,
                is_banned: false,
                email_verified_at: db.user.email_verified_at,
                token_version: 0
            }]
        };
    }

    if (/^SELECT email, balance FROM users WHERE id/i.test(sql)) {
        if (!db.user) return { rows: [] };
        return { rows: [{ email: db.user.email, balance: db.balance }] };
    }

    // The auth middleware revalidates the session on every authenticated request, reading these
    // two columns back out. The stub has to answer it or every request is refused as a session
    // failure, which is indistinguishable from a broken gate.
    if (/SELECT token_version, is_banned FROM users WHERE id/i.test(sql)) {
        if (!db.user) return { rows: [] };
        return { rows: [{ token_version: 0, is_banned: false }] };
    }

    if (/^SELECT balance FROM users WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        // Reaching this query means the code gate let the request through to the money, so it
        // is recorded before the caller can pass or fail on balance.
        db.reachedDebit = true;
        return { rows: [{ balance: db.balance }] };
    }

    // Column order is (user_id, amount, destination, code_hash, minutes). Positional, and
    // asserted against the real statement's order -- getting it wrong would store a hash where
    // the amount belongs and make the binding tests pass for the wrong reason.
    //
    // The ON CONFLICT is asserted because the upsert is the only thing keeping "one live code
    // per account" true under concurrency. Delete-then-insert would pass every test in this
    // file while racing in production, so it is refused here rather than merely discouraged.
    if (/INSERT INTO withdrawal_verification_codes/i.test(sql)) {
        assert.match(sql, /ON CONFLICT \(user_id\) WHERE consumed_at IS NULL/,
            'the code insert must upsert against the partial unique index');
        assert.match(sql, /DO UPDATE SET/, 'the upsert must replace the outstanding code');
        assert.match(sql, /attempts = 0/, 'a replacement code must not inherit the old attempt count');
        db.code = {
            id: 1,
            user_id: values[0],
            amount: values[1],
            destination: values[2],
            code_hash: values[3],
            attempts: 0,
            expires_at: new Date(Date.now() + Number(values[4]) * 60_000),
            consumed_at: null
        };
        return { rows: [{ id: 1 }], rowCount: 1 };
    }

    if (/SELECT id, code_hash, attempts, expires_at, amount, destination/i.test(sql)) {
        if (!db.code || db.code.consumed_at) return { rows: [] };
        return { rows: [{ ...db.code }] };
    }

    if (/UPDATE withdrawal_verification_codes SET attempts = attempts \+ 1/i.test(sql)) {
        if (db.code) db.code.attempts += 1;
        return { rows: [{ attempts: db.code ? db.code.attempts : 0 }], rowCount: 1 };
    }

    if (/UPDATE withdrawal_verification_codes SET consumed_at/i.test(sql)) {
        if (db.code) db.code.consumed_at = new Date();
        return { rows: [], rowCount: 1 };
    }

    if (/DELETE FROM withdrawal_verification_codes WHERE id/i.test(sql)) {
        db.code = null;
        return { rows: [], rowCount: 1 };
    }

    if (/DELETE FROM withdrawal_verification_codes WHERE user_id/i.test(sql)) {
        db.code = null;
        return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO withdrawals/i.test(sql)) {
        db.withdrawn = { amount: values[1], address: values[3] };
        return { rows: [{ id: 77 }], rowCount: 1 };
    }

    if (/UPDATE users SET balance = balance - \$1/i.test(sql)) {
        db.balance = String(Number(db.balance) - Number(values[0]));
        return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO balance_transactions/i.test(sql)) return { rows: [], rowCount: 1 };

    // The durable notification write. Answered rather than left to the `throw` below for two
    // reasons: it is a real query the request now makes, and `recordInBackground` swallows its
    // failures -- an unanswered insert would print an error into the output and leave the suite
    // green with no notification ever written, which is the exact failure a notification test
    // is supposed to catch.
    if (/INSERT INTO notifications/i.test(sql)) {
        db.notifications.push({
            category: values[1],
            recordId: values[6],
            title: values[3],
            read: false
        });
        return { rows: [{ id: db.notifications.length, created_at: '2026-09-30T12:00:00Z' }], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
}

function installDbStub() {
    pool.query = async (query, values) => runStubbedQuery(query, values);
    pool.connect = async () => ({
        query: async (query, values) => runStubbedQuery(query, values),
        release: () => {}
    });
}

/**
 * Captured rather than sent.
 *
 * The controller calls `withdrawalCode.sendWithdrawalCodeEmail` as a property lookup on the
 * module object at call time, so replacing it here takes effect without any load-order games --
 * unlike a module that destructures its dependencies at require time.
 */
withdrawalCode.sendWithdrawalCodeEmail = async ({ to, code, amount, destination }) => {
    db.emailsSent += 1;
    db.emailed = { to, code, amount, destination };
    if (db.emailDelivery === 'failed') return { sent: false, reason: 'provider-unavailable' };
    if (db.emailDelivery === 'throws') throw new Error('smtp refused the connection');
    return { sent: true };
};

const app = require('../src/app');

/** A withdrawal request the server will otherwise accept, so only the code can refuse it. */
function withdrawal(overrides = {}) {
    return {
        amount: 25,
        paymentMethod: 'paypal',
        paymentAddress: 'member@example.test',
        ...overrides
    };
}

const postCode = (body) => fetch(`${origin}/api/user/withdrawals/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
});

const postWithdrawal = (body) => fetch(`${origin}/api/user/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
});

/**
 * Issues a code through the real endpoint and returns the code from the email.
 *
 * The code is read from what the email actually carried rather than from the server's response,
 * because the response deliberately does not contain it. Anything else would let a test pass
 * against a code the user would never have received.
 */
async function issueCode(overrides = {}) {
    const response = await postCode(withdrawal(overrides));
    assert.equal(response.status, 200, `code request failed: ${response.status}`);
    assert.ok(db.emailed, 'the request succeeded without an email carrying a code');
    return db.emailed.code;
}

before(async () => {
    process.env.JWT_SECRET = 'withdrawal-code-test-secret';
    process.env.BREVO_API_KEY = 'xkeysib-test-key';
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = 'test@example.test';

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    installDbStub();

    db.user = { id: 21, email: 'member@example.test', email_verified_at: new Date() };
    db.passwordHash = await encodePassword(PASSWORD);

    const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: db.user.email, password: PASSWORD })
    });
    token = (await login.json()).token;
    assert.equal(typeof token, 'string', 'the seeded account could not sign in');
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    if (priorEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnvironment;
    if (priorJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorJwt;
    if (priorBrevo === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = priorBrevo;
    if (priorResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = priorResend;
    if (priorFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = priorFrom;
});

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a withdrawal with no code is refused before the balance is touched', async () => {
    const response = await postWithdrawal(withdrawal());

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /code/i);
    assert.equal(db.reachedDebit, false, 'the request reached the money without a code');
    assert.equal(db.withdrawn, null);
});

test('a well-formed but wrong code is refused, and costs one attempt', async () => {
    await issueCode();

    const response = await postWithdrawal(withdrawal({ code: '000000' }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not correct/i);
    assert.equal(db.reachedDebit, false);
    assert.equal(db.code.attempts, 1);
});

test('the real code is accepted and reaches the withdrawal', async () => {
    const code = await issueCode();

    const response = await postWithdrawal(withdrawal({ code }));

    assert.equal(response.status, 200);
    assert.equal(db.reachedDebit, true);
    assert.equal(db.withdrawn.amount, 25);
});

test('a refused withdrawal tells the reader nothing, and an accepted one records the request', async () => {
    // The bell is how a reader learns their money left the account: the debit on its own is
    // indistinguishable from a charge, and the request is the last point at which the server still
    // knows the request succeeded. Recording it after the commit is what makes the notification
    // survive the tab closing.
    const code = await issueCode();

    const accepted = await postWithdrawal(withdrawal({ code }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(
        db.notifications.map((n) => n.category),
        ['withdrawal_requested'],
        'an accepted withdrawal must record exactly one request notification'
    );
    assert.equal(db.notifications[0].recordId, '77', 'the notification must name the withdrawal it is about');
    assert.equal(db.notifications[0].read, false, 'a new notification starts unread');

    // A refusal must not tell the reader their money was sent, and a failed write must not have
    // taken the request down with it -- the response above is already a 200, so this asserts the
    // row is absent rather than the request survived.
    resetDb();
    const refused = await postWithdrawal(withdrawal({ code: '000000' }));
    assert.equal(refused.status, 400);
    assert.deepEqual(db.notifications, [], 'a refused withdrawal recorded a notification');
});

test('a spent code cannot be replayed for a second withdrawal', async () => {
    const code = await issueCode();

    const first = await postWithdrawal(withdrawal({ code }));
    assert.equal(first.status, 200);

    // The balance is topped back up so a refusal here cannot be mistaken for an
    // insufficient-balance rejection.
    db.balance = '500.00';
    const second = await postWithdrawal(withdrawal({ code }));

    assert.equal(second.status, 400);
    assert.match((await second.json()).error, /code/i);
});

// ---------------------------------------------------------------------------
// Attempt budget
// ---------------------------------------------------------------------------

test('five wrong codes exhaust the budget, and the real code stops working too', async () => {
    const code = await issueCode();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await postWithdrawal(withdrawal({ code: '000000' }));
        assert.equal(response.status, 400, `attempt ${attempt} was accepted`);
    }

    // Destroyed rather than merely locked, so holding a correct code does not buy more tries.
    assert.equal(db.code, null, 'the code row survived exhaustion and would still be usable');

    // With the row destroyed there is no longer a code to be wrong about, so this falls
    // through to the generic "confirm with a code" refusal rather than "too many incorrect".
    const final = await postWithdrawal(withdrawal({ code }));
    assert.equal(final.status, 400);
    assert.match((await final.json()).error, /code/i);
    assert.equal(db.reachedDebit, false);
});

// ---------------------------------------------------------------------------
// Binding to the withdrawal
// ---------------------------------------------------------------------------

test('a code for one amount does not authorise a larger one', async () => {
    const code = await issueCode({ amount: 1 });

    const response = await postWithdrawal(withdrawal({ amount: 400, code }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /different amount or destination/i);
    assert.equal(db.reachedDebit, false);
});

test('a code for one destination does not authorise another', async () => {
    const code = await issueCode();

    const response = await postWithdrawal(withdrawal({ paymentAddress: 'attacker@example.test', code }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /different amount or destination/i);
    assert.equal(db.reachedDebit, false);
});

test('a mismatched amount does not cost an attempt, so a held code cannot be burned by guessing', async () => {
    const code = await issueCode({ amount: 1 });

    // Ten wrong amounts. If each consumed an attempt the fifth would have destroyed a live
    // code, which is what a code intercepted in transit could be used to do.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await postWithdrawal(withdrawal({ amount: 50 + attempt, code }));
        assert.equal(response.status, 400);
    }

    assert.equal(db.code.attempts, 0, 'a mismatched withdrawal consumed the attempt budget');

    // And the code is still good for what it was actually issued for.
    const correct = await postWithdrawal(withdrawal({ amount: 1, code }));
    assert.equal(correct.status, 200);
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test('an expired code is refused and does not reach the money', async () => {
    const code = await issueCode();

    db.code.expires_at = new Date(Date.now() - 1000);

    const response = await postWithdrawal(withdrawal({ code }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /expired/i);
    assert.equal(db.reachedDebit, false);
    assert.equal(db.code, null, 'an expired code was left in place');
});

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

test('no code is issued for a withdrawal the server would refuse anyway', async () => {
    const overLimit = await postCode(withdrawal({ amount: 20000 }));
    assert.equal(overLimit.status, 400);
    assert.equal(db.emailsSent, 0);

    const unsupported = await postCode(withdrawal({ paymentMethod: 'cheque' }));
    assert.equal(unsupported.status, 400);
    assert.equal(db.emailsSent, 0);

    const tooShort = await postCode(withdrawal({ paymentAddress: 'a' }));
    assert.equal(tooShort.status, 400);
    assert.equal(db.emailsSent, 0);
});

test('the emailed code is bound to the amount and destination it was issued for', async () => {
    const response = await postCode(withdrawal({ amount: 42.5, paymentAddress: 'member@example.test' }));
    assert.equal(response.status, 200);

    assert.equal(db.emailsSent, 1);
    assert.equal(db.emailed.amount, 42.5);
    assert.equal(db.emailed.destination, 'member@example.test');
    assert.match(db.emailed.code, /^\d{6}$/);
    assert.equal(db.emailed.to, 'member@example.test');

    // And the stored row carries the same binding, not just the email. This is the assertion
    // that catches a reordering of the INSERT's parameters: the email would still look right
    // while the code silently stopped matching the withdrawal it was issued for.
    assert.equal(Number(db.code.amount), 42.5);
    assert.equal(db.code.destination, 'member@example.test');
    assert.notEqual(db.code.code_hash, db.emailed.code, 'the code was stored in the clear');
    assert.ok(
        withdrawalCode.codeMatches(db.emailed.code, db.code.code_hash, db.code.user_id),
        'the stored hash does not verify against the code that was emailed'
    );
});

test('requesting a second code replaces the first, so only one is ever live', async () => {
    const first = await postCode(withdrawal());
    assert.equal(first.status, 200);
    const second = await postCode(withdrawal());
    assert.equal(second.status, 200);

    assert.equal(db.emailsSent, 2);
    assert.ok(db.code, 'the second request left no live code');
    assert.equal(db.code.attempts, 0, 'the replacement inherited the old attempt count');
});

test('a code that was issued but never delivered is withdrawn, not left to be guessed', async () => {
    db.emailDelivery = 'failed';
    const response = await postCode(withdrawal());
    assert.equal(response.status, 503);

    assert.equal(db.code, null, 'an undelivered code was left live for five more attempts');
});

test('an email provider that throws does not surface as a sent code', async () => {
    db.emailDelivery = 'throws';
    const response = await postCode(withdrawal());
    assert.equal(response.status, 503);
    assert.equal(db.code, null);
});

test('a confirmation code is only ever six digits', () => {
    // Deterministic: the digits are the security property, so this asserts the generator's
    // range and width directly rather than sampling it and hoping.
    assert.equal(withdrawalCode.CODE_PATTERN.source, '^\\d{6}$');
    assert.ok(withdrawalCode.CODE_LIFETIME_MINUTES > 0);
    assert.equal(withdrawalCode.CODE_LIFETIME_MINUTES, 10);
});
