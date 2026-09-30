const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/app');
const emailPreferences = require('../src/services/emailPreferences');
const depositEmails = require('../src/services/depositEmails');
const withdrawalResolution = require('../src/services/withdrawalResolution');

/**
 * The money-email switch, and the places that are supposed to honour it.
 *
 * The properties worth protecting are narrow:
 *
 *   - a preference the user never expressed is not applied, so a body that omits the flag --
 *     or sends the string "false" -- is refused rather than read as an opt-out;
 *   - a database that cannot be read does not silently stop receipts, because the send path
 *     runs on a webhook nobody is watching and a suppressed message leaves no trace;
 *   - every one of the six money messages respects the setting, and none of the three
 *     authorisation messages is even capable of being switched off.
 *
 * The last one is enforced by construction rather than by a check: the verification, reset
 * and withdrawal-code paths never read this column, so there is nothing to test. What is
 * tested here is that the column exists to be read, and that every read site normalises it.
 */

/** Replaces the module's pool for one call, and puts the real one back afterwards. */
async function withPool(query, run) {
    const original = pool.query;
    pool.query = query;
    try {
        return await run();
    } finally {
        pool.query = original;
    }
}

/** Captures outbound mail by standing in for `fetch`, which is what the mailer calls. */
async function withCapturedMail(run) {
    const originalFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        sent.push({ url, subject: body.subject || body.email_subject, to: body.to });
        return { ok: true, status: 202, text: async () => '' };
    };
    try {
        return { result: await run(), sent };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('a preference is only ever read as off when the stored value really says off', () => {
    // The values a real BOOLEAN column produces.
    assert.equal(emailPreferences.isMoneyEmailEnabled(true), true);
    assert.equal(emailPreferences.isMoneyEmailEnabled(false), false);

    // The values a text or numeric column, or a different driver, produce. These are the
    // cases where a naive `if (value)` would treat the string "false" as true and quietly
    // ignore an opt-out the user had genuinely made.
    assert.equal(emailPreferences.isMoneyEmailEnabled('t'), true);
    assert.equal(emailPreferences.isMoneyEmailEnabled('true'), true);
    assert.equal(emailPreferences.isMoneyEmailEnabled('f'), false);
    assert.equal(emailPreferences.isMoneyEmailEnabled('false'), false);
    assert.equal(emailPreferences.isMoneyEmailEnabled('0'), false);
    assert.equal(emailPreferences.isMoneyEmailEnabled('no'), false);
    assert.equal(emailPreferences.isMoneyEmailEnabled('off'), false);

    // A value that was not selected at all is not a refusal. "We do not know" must not read
    // as "do not send", or a query that forgot the column would mute every receipt.
    assert.equal(emailPreferences.isMoneyEmailEnabled(null), true);
    assert.equal(emailPreferences.isMoneyEmailEnabled(undefined), true);
});

test('a database that cannot be read does not stop the receipts', async () => {
    await withPool(async () => {
        throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
    }, async () => {
        // Fails open. The alternative is that a brief outage during a withdrawal suppresses
        // the one message saying the money is on its way, and nothing throws to show for it.
        assert.equal(await emailPreferences.loadMoneyEmailPreference(7), true);
    });
});

test('the stored value is read back rather than echoed from the request', async () => {
    const statements = [];
    await withPool(async (query, params) => {
        statements.push({ sql: String(query).replace(/\s+/g, ' ').trim(), params });
        return { rows: [{ money_emails_enabled: false }], rowCount: 1 };
    }, async () => {
        // Asked for `true`, told `false`. Reporting the requested value would show the user
        // a switch in the position they did not choose.
        assert.equal(await emailPreferences.setMoneyEmailPreference(7, true), false);
    });
    assert.match(statements[0].sql, /RETURNING money_emails_enabled/);
    assert.deepEqual(statements[0].params, [true, 7]);
    // `users` has no `updated_at` -- `created_at` is the only timestamp on it. `deposits` and
    // `withdrawals` do have one, so writing it here looks correct and fails every save with
    // `column "updated_at" of relation "users" does not exist`. Nothing catches that until a
    // real request runs, so it is asserted here instead.
    assert.doesNotMatch(statements[0].sql, /updated_at/);
});

test('a setting for an account that does not exist is reported, not invented', async () => {
    await withPool(async () => ({ rows: [], rowCount: 0 }), async () => {
        assert.equal(await emailPreferences.setMoneyEmailPreference(404, true), null);
    });
});

test('the policy says which mail cannot be switched off, rather than only which can', () => {
    const policy = emailPreferences.describePolicy();

    // A page that says "some email always arrives" is not actionable. These three are the
    // steps a user has to take to get into the account and move money in it, so they are
    // named individually.
    const alwaysOn = policy.alwaysOn.map((entry) => entry.key);
    assert.deepEqual(alwaysOn, ['verify', 'reset', 'withdrawal-code']);

    // Every stage of both money flows is listed, so the copy on the page is generated from
    // one list and cannot drift from what is actually sent.
    const switchable = policy.switchable.map((entry) => entry.key);
    assert.deepEqual(switchable, [
        'deposit-instructions', 'deposit-confirmed', 'deposit-failed',
        'withdrawal-started', 'withdrawal-sent', 'withdrawal-refunded'
    ]);
    for (const entry of [...policy.alwaysOn, ...policy.switchable]) {
        assert.ok(entry.label && entry.label.length > 5, `${entry.key} has no usable label`);
    }
});

test('deposit instructions are not emailed to a user who switched money email off', async () => {
    await withPool(async () => ({
        rows: [{ email: 'off@example.com', balance: '10.00', money_emails_enabled: false }],
        rowCount: 1
    }), async () => {
        const { result, sent } = await withCapturedMail(async () => depositEmails.notifyDepositInstructions({
            userId: 7,
            depositId: 1,
            assetCode: 'usdt',
            network: 'tron',
            payAddress: 'TXYZ',
            payAmount: 12.5,
            amount: 12.5
        }));
        assert.equal(result.sent, false);
        assert.equal(result.reason, 'opted-out');
        // The receipt for a crypto deposit carries the only copy of the address and the exact
        // amount, so a suppressed one is a real loss -- but it is the user's explicit choice.
        assert.equal(sent.length, 0);
    });
});

test('a deposit receipt is still emailed to a user who has money email on', async () => {
    const previousFrom = process.env.EMAIL_FROM;
    const previousProvider = process.env.EMAIL_PROVIDER;
    const previousKey = process.env.BREVO_API_KEY;
    try {
        process.env.EMAIL_PROVIDER = 'brevo';
        process.env.EMAIL_FROM = 'no-reply@example.com';
        process.env.BREVO_API_KEY = 'test-key';

        await withPool(async (query) => {
            const sql = String(query);
            if (sql.includes('FROM deposits')) {
                return {
                    rows: [{
                        id: 1, provider: 'nowpayments', asset_code: 'usdt', network: 'tron',
                        amount: '12.50', provider_payment_id: 'pay-1',
                        email: 'on@example.com', balance: '22.50', money_emails_enabled: true
                    }],
                    rowCount: 1
                };
            }
            return { rows: [{ email: 'on@example.com', balance: '22.50', money_emails_enabled: true }], rowCount: 1 };
        }, async () => {
            const { result, sent } = await withCapturedMail(async () => depositEmails.notifyDepositCredited({ depositId: 1 }));
            assert.equal(result.sent, true);
            assert.equal(sent.length, 1);
            assert.match(sent[0].subject, /12\.50/);
        });
    } finally {
        if (previousFrom === undefined) delete process.env.EMAIL_FROM;
        else process.env.EMAIL_FROM = previousFrom;
        if (previousProvider === undefined) delete process.env.EMAIL_PROVIDER;
        else process.env.EMAIL_PROVIDER = previousProvider;
        if (previousKey === undefined) delete process.env.BREVO_API_KEY;
        else process.env.BREVO_API_KEY = previousKey;
    }
});

test('a withdrawal carries the opt-out through the write that closes it', async () => {
    // The address has to be read inside the transaction for the same reason the opt-out is:
    // an UPDATE cannot join another table, so both are carried over from the row that was
    // actually closed rather than from a lookup that could describe a different withdrawal.
    async function markPaid(moneyEmails) {
        const client = {
            query: async (query) => {
                const sql = String(query);
                if (sql.includes('SELECT u.email')) {
                    return { rows: [{ email: 'user@example.com', money_emails: moneyEmails }], rowCount: 1 };
                }
                return {
                    rows: [{
                        id: 5, user_id: 7, amount: '20.00', status: 'paid',
                        provider_reference: 'ref-1', payment_method: 'usdt',
                        payment_address: 'TXYZ', asset_code: 'usdt', network: 'tron'
                    }],
                    rowCount: 1
                };
            }
        };
        return withdrawalResolution.markWithdrawalPaid(client, 5, 'ref-1');
    }

    assert.equal((await markPaid(true)).withdrawal.user_money_emails, true);
    assert.equal((await markPaid(false)).withdrawal.user_money_emails, false);
    // A user row that predates the column, or a query that did not select it, must not be
    // read as an opt-out. Nothing in the send path treats "unknown" as "do not send".
    assert.equal((await markPaid(undefined)).withdrawal.user_money_emails, true);
    assert.equal((await markPaid(null)).withdrawal.user_money_emails, true);
});

test('a withdrawal with no provider reference is still refused, switch or no switch', async () => {
    const client = { query: async () => ({ rows: [], rowCount: 0 }) };
    const result = await withdrawalResolution.markWithdrawalPaid(client, 5, '');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'missing-reference');
});

// ---------------------------------------------------------------------------
// The endpoint's own validation
// ---------------------------------------------------------------------------

/**
 * These exercise the route rather than the service, because the property is about the wire
 * contract: a body the user did not clearly fill in has to be refused. The service is
 * perfectly correct about a boolean, and the bug this guards against is a client sending
 * something else and the route quietly reading it as a decision.
 *
 * No database is involved. The refusal is decided before any query is built, which is the
 * point of doing it first -- so these run on a machine with no `TEST_DATABASE_URL`.
 */
let server;
let origin;
let priorSecret;
let priorQuery;

before(async () => {
    // `requireAuth` refuses every request with a 503 when no secret is configured, so the
    // route cannot be reached at all without one. Set the same way the server tests do.
    priorSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'email-preference-test-secret';

    // `requireAuth` reads the account on every request to check the token has not been
    // revoked. There is no database here, and the refusal it would produce (503) is
    // indistinguishable from the endpoint being broken, so the one lookup is stubbed. The
    // tests below are all about validation that happens *before* any write.
    priorQuery = pool.query;
    pool.query = async (query) => {
        if (String(query).includes('token_version')) {
            return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        }
        return { rows: [{ money_emails_enabled: true }], rowCount: 1 };
    };

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    pool.query = priorQuery;
    if (priorSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorSecret;
});

function patchBody(body) {
    const token = jwt.sign({ sub: '7' }, process.env.JWT_SECRET, { issuer: 'offer-network-api' });
    return fetch(`${origin}/api/user/email-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
}

test('a body that does not state a preference is refused, not guessed at', async () => {
    // Each of these would read as "switch it off" to any handler that treated a missing or
    // falsy value as the answer, and each is a thing a client can plausibly send.
    for (const body of [{}, { moneyEmailsEnabled: 'false' }, { moneyEmailsEnabled: 0 },
        { moneyEmailsEnabled: null }, { moneyEmailsEnabled: undefined }]) {
        const response = await patchBody(body);
        assert.equal(response.status, 400, `${JSON.stringify(body)} was not refused`);
        const payload = await response.json();
        assert.match(payload.error, /true or false/);
    }
});

test('the preference endpoint needs a session', async () => {
    const response = await fetch(`${origin}/api/user/email-preferences`);
    assert.equal(response.status, 401);
});

test('the path answers GET and PATCH, and nothing else', async () => {
    // A browser address bar can only send GET. Without the method registry the path would
    // fall through to the catch-all and answer a 404 that is true about nothing: the route
    // exists, only the verb is wrong.
    const token = jwt.sign({ sub: '7' }, process.env.JWT_SECRET, { issuer: 'offer-network-api' });
    const response = await fetch(`${origin}/api/user/email-preferences`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 405);
    const allow = response.headers.get('allow') || '';
    assert.match(allow, /GET/);
    assert.match(allow, /PATCH/);
});
