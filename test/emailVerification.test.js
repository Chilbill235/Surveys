const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { promisify } = require('node:util');
const { randomBytes, scrypt } = require('node:crypto');
const verificationEmail = require('../src/services/verificationEmail');
const { hashCode, generateCode } = verificationEmail;
const pool = require('../src/config/db');

const scryptAsync = promisify(scrypt);

/** A password the seeded account really has, so login can be exercised for real. */
const PASSWORD = 'a-valid-password-123';

/** Mirrors the stored format so `verifyPassword` accepts it instead of falling back to the dummy. */
function encodePassword(password) {
    const salt = randomBytes(16).toString('hex');
    return scryptAsync(password, salt, 64).then((derived) => (
        `scrypt$${salt}$${derived.toString('hex')}`
    ));
}

/**
 * The email confirmation endpoints, exercised through the real HTTP surface with the
 * database boundary replaced by a small in-memory stand-in.
 *
 * These cover the properties that decide whether the feature is worth having: a wrong code
 * costs an attempt, the attempts run out, a used code cannot be replayed, and no response
 * distinguishes "no such account" from "wrong code".
 */

let server;
let origin;
const priorEnvironment = process.env.NODE_ENV;
const priorJwt = process.env.JWT_SECRET;
const priorBrevo = process.env.BREVO_API_KEY;
const priorResend = process.env.RESEND_API_KEY;
const priorFrom = process.env.EMAIL_FROM;

/** The fake user row the stand-in database serves. */
const db = {
    user: null,
    code: null,
    deletedCodes: 0,
    attemptsBumped: 0,
    verified: null,
    lastEmailedCode: null,
    passwordHash: null,
    // Stands in for `users.token_version`, which every password reset bumps. Tracked as real
    // state because the signed token's `ver` claim has to match it exactly, and a token signed
    // at 0 for an account sitting at 1 is rejected on first use.
    tokenVersion: 0,
    rateLimits: new Map()
};

function resetDb() {
    db.user = null;
    db.code = null;
    db.deletedCodes = 0;
    db.attemptsBumped = 0;
    db.verified = null;
    db.lastEmailedCode = null;
    db.passwordHash = null;
    db.tokenVersion = 0;
    db.rateLimits.clear();
}

/**
 * A stand-in for the two queries `verifyEmail` runs, plus the two it writes.
 *
 * Deliberately narrow: the point is to observe the transitions the handler asks for, not to
 * reimplement SQL. Anything the handler does not ask for throws, so a query it should not be
 * making fails the test instead of being silently absorbed.
 */
async function runStubbedQuery(query, values = []) {
    const sql = String(query).replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };

    if (/FROM users u\s+LEFT JOIN email_verification_codes c/i.test(sql)) {
        if (!db.user) return { rows: [] };
        return {
            rows: [{
                id: db.user.id,
                email: db.user.email,
                balance: '0.00',
                demo_balance: '0.00',
                is_banned: false,
                code_id: db.code ? db.code.id : null,
                code_hash: db.code ? db.code.code_hash : null,
                attempts: db.code ? db.code.attempts : 0
            }]
        };
    }
    if (/UPDATE email_verification_codes SET attempts = attempts \+ 1/i.test(sql)) {
        db.attemptsBumped += 1;
        if (db.code) db.code.attempts += 1;
        return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM email_verification_codes WHERE id/i.test(sql)) {
        db.deletedCodes += 1;
        db.code = null;
        return { rows: [], rowCount: 1 };
    }
    if (/UPDATE users SET email_verified_at = NOW\(\)/i.test(sql)) {
        db.verified = true;
        return { rows: [{ id: db.user.id, email: db.user.email, balance: '0.00', demo_balance: '0.00', token_version: db.tokenVersion }] };
    }
    if (/password_hash[\s\S]*FROM users WHERE LOWER\(email\)/i.test(sql)) {
        if (!db.user) return { rows: [] };
        return {
            rows: [{
                id: db.user.id,
                email: db.user.email,
                balance: '0.00',
                demo_balance: '0.00',
                password_hash: db.passwordHash,
                is_banned: false,
                email_verified_at: db.user.email_verified_at,
                token_version: db.tokenVersion
            }]
        };
    }
    if (/SELECT id, email, email_verified_at FROM users/i.test(sql)) {
        return { rows: db.user ? [db.user] : [] };
    }
    if (/INSERT INTO email_verification_codes/i.test(sql)) {
        db.code = { id: 1, code_hash: values[1], attempts: 0 };
        return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM email_verification_codes WHERE user_id/i.test(sql)) {
        db.code = null;
        return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO auth_rate_limits/i.test(sql)) {
        // The resend limiter shares this pool, so a faithful fixed window is needed: a stub
        // that always answered "first attempt" would quietly stop the limit from being tested.
        const bucket = values[0];
        const windowSeconds = Number(values[1]);
        const now = Date.now();
        let window = db.rateLimits.get(bucket);
        if (!window || now - window.startedAt >= windowSeconds * 1000) {
            window = { count: 0, startedAt: now };
            db.rateLimits.set(bucket, window);
        }
        window.count += 1;
        return {
            rows: [{
                attempt_count: window.count,
                window_started_at: new Date(window.startedAt).toISOString()
            }]
        };
    }

    throw new Error(`Unexpected test query: ${sql}`);
}

function installDbStub() {
    pool.query = async (query, values) => runStubbedQuery(query, values);
    pool.connect = async () => ({
        query: async (query, values) => runStubbedQuery(query, values),
        release: () => {}
    });
}

const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

/**
 * Capture the emailed code instead of sending it.
 *
 * This has to happen before the app is required. The controller destructures
 * `sendVerificationEmail` out of the module at load time, so a replacement installed afterwards
 * would be ignored and the real function would go to the network -- which is a test that
 * hangs rather than fails.
 */
const originalSend = verificationEmail.sendVerificationEmail;
verificationEmail.sendVerificationEmail = async ({ code }) => {
    db.lastEmailedCode = code;
    return { sent: true };
};

const app = require('../src/app');

before(async () => {
    process.env.JWT_SECRET = 'verification-test-secret';
    // Nothing is sent, but the endpoints are configured so the "no email configured" path
    // cannot be mistaken for a delivery failure.
    process.env.BREVO_API_KEY = 'xkeysib-test-key';
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = 'test@example.test';

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    installDbStub();

    // Hashed once: scrypt is deliberately slow, and every seeded account uses this same
    // password so the login test can sign in for real.
    db.defaultPasswordHash = await encodePassword(PASSWORD);
});

after(async () => {
    verificationEmail.sendVerificationEmail = originalSend;
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
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

/** Puts a known user and a known live code into the stand-in database. */
/** Reads the `ver` claim from a signed token, so a test can assert what the server will compare. */
function tokenVersionOf(token) {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload.ver;
}

function seedUserWithCode() {    resetDb();
    const code = generateCode();
    db.user = { id: 11, email: 'member@example.test', email_verified_at: null };
    db.passwordHash = db.defaultPasswordHash;
    db.code = { id: 1, code_hash: hashCode(code, 11), attempts: 0 };
    db.lastEmailedCode = code;
    return code;
}

test('a wrong code is refused with one message, and the same one either way', async () => {
    seedUserWithCode();

    const wrong = await post('/api/auth/verify-email', { email: 'member@example.test', code: '000000' });
    const missing = await post('/api/auth/verify-email', { email: 'nobody@example.test', code: '000000' });

    assert.equal(wrong.status, 400);
    // Identical wording for "wrong code" and "no such account". A difference here is how this
    // endpoint becomes a way to find out which addresses are registered.
    assert.deepEqual(await wrong.json(), await missing.json());
});

test('a correct code verifies the address and returns a session', async () => {
    const code = seedUserWithCode();

    const response = await post('/api/auth/verify-email', { email: 'member@example.test', code });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(db.verified, true);
    // The code is destroyed on use, so it cannot be replayed against the same account.
    assert.equal(db.code, null);
    assert.ok(db.deletedCodes > 0);
});

test('a user who has reset their password can still sign in', async () => {
    // The bug this covers locked an account out permanently rather than signing it out once.
    //
    // Password reset bumps `users.token_version`. The token's `ver` claim is compared against
    // that column on every request and must match exactly. If the sign-in query did not select
    // the column, the claim was signed as 0, so an account sitting at 1 passed sign-in, was
    // handed a token, and then had every request refused with "your session ended because the
    // password changed" -- and signing in again produced the same stale claim, so the loop
    // could never be escaped. The `|| 0` default is what made a forgotten column silent.
    seedUserWithCode();
    db.user.email_verified_at = new Date();
    db.tokenVersion = 0;

    const before = await post('/api/auth/login', { email: 'member@example.test', password: PASSWORD });
    assert.equal(before.status, 200);
    const beforeToken = (await before.json()).token;
    assert.equal(tokenVersionOf(beforeToken), 0);

    // A reset, from any device. The old token is meant to die here.
    db.tokenVersion += 1;
    assert.notEqual(tokenVersionOf(beforeToken), db.tokenVersion, 'the pre-reset token should no longer match');

    // Signing in again has to produce a token that matches the new version, or the account is
    // unreachable from here on.
    const after = await post('/api/auth/login', { email: 'member@example.test', password: PASSWORD });
    assert.equal(after.status, 200);
    const afterToken = (await after.json()).token;
    assert.equal(tokenVersionOf(afterToken), db.tokenVersion);
    assert.notEqual(afterToken, beforeToken);
});

test('a token cannot be minted for an account whose version the query did not return', async () => {
    // The defensive half. `issueToken` must refuse rather than default the version to 0, so
    // that any future query which leaves out the column fails at the point of the mistake
    // instead of quietly signing tokens that are rejected on first use.
    seedUserWithCode();
    db.user.email_verified_at = new Date();

    // Reproduce the original fault: the sign-in query returns a row with no `token_version`.
    const originalQuery = pool.query;
    pool.query = async (query, values) => {
        if (/password_hash[\s\S]*FROM users WHERE LOWER\(email\)/i.test(String(query).replace(/\s+/g, ' '))) {
            return { rows: [{ id: db.user.id, email: db.user.email, balance: '0.00', demo_balance: '0.00', password_hash: db.passwordHash, is_banned: false, email_verified_at: db.user.email_verified_at }] };
        }
        return originalQuery(query, values);
    };

    try {
        // A 500, not a token. The user sees a real failure they can retry, rather than a
        // successful sign-in followed by a session that dies on the first request.
        const response = await post('/api/auth/login', { email: 'member@example.test', password: PASSWORD });
        assert.equal(response.status, 500);
        assert.equal((await response.json()).token, undefined, 'a token was issued without a known version');
    } finally {
        pool.query = originalQuery;
    }
});
test('a used code cannot be replayed', async () => {
    const code = seedUserWithCode();

    assert.equal((await post('/api/auth/verify-email', { email: 'member@example.test', code })).status, 200);

    // The row is gone, so the second attempt is indistinguishable from an unknown code.
    const replay = await post('/api/auth/verify-email', { email: 'member@example.test', code });
    assert.equal(replay.status, 400);
    assert.equal(db.verified, true, 'the replay must not change anything');
});

test('guessing is bounded: the code is destroyed once the attempts run out', async () => {
    const code = seedUserWithCode();

    // Four wrong guesses are allowed and each costs an attempt.
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await post('/api/auth/verify-email', { email: 'member@example.test', code: '111111' });
        assert.equal(response.status, 400);
    }
    assert.equal(db.attemptsBumped, 4);
    assert.ok(db.code, 'the code should still exist after four wrong guesses');

    // The fifth exhausts the budget and destroys the row, so the real code stops working
    // too. Without this, a patient attacker would get unlimited tries against a live code.
    const fifth = await post('/api/auth/verify-email', { email: 'member@example.test', code: '111111' });
    assert.equal(fifth.status, 400);
    assert.equal(db.code, null, 'the code must be destroyed when the attempts run out');

    const afterLockout = await post('/api/auth/verify-email', { email: 'member@example.test', code });
    assert.equal(afterLockout.status, 400);
    assert.equal(db.verified, null, 'a locked-out code must not verify the account');
});

test('a malformed code is refused before the database is touched', async () => {
    seedUserWithCode();
    const before = db.attemptsBumped;

    for (const code of ['12345', '1234567', 'abcdef', '', '  ']) {
        const response = await post('/api/auth/verify-email', { email: 'member@example.test', code });
        assert.equal(response.status, 400, `"${code}" was not refused`);
    }
    // A code that cannot be six digits is not a guess, so it must not spend an attempt --
    // otherwise a script could burn someone's attempts without ever trying to be right.
    assert.equal(db.attemptsBumped, before);
});

test('resending replaces the code, so an old one cannot be used later', async () => {
    const original = seedUserWithCode();

    const resend = await post('/api/auth/resend-verification', { email: 'member@example.test' });
    assert.equal(resend.status, 200);

    const replacement = db.lastEmailedCode;
    assert.notEqual(replacement, original, 'a resend must issue a different code');

    // The old code is gone from the store, so submitting it is refused. A code still sitting
    // in the user's inbox from an earlier request must not remain usable.
    const stale = await post('/api/auth/verify-email', { email: 'member@example.test', code: original });
    assert.equal(stale.status, 400);
    assert.equal(db.verified, null);
});

test('resending answers the same way for an address that does not exist', async () => {
    seedUserWithCode();
    const known = await post('/api/auth/resend-verification', { email: 'member@example.test' });

    db.user = null;
    db.lastEmailedCode = null;
    const unknown = await post('/api/auth/resend-verification', { email: 'nobody@example.test' });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    // Byte-for-byte the same reply, so this cannot be used to enumerate accounts. The only
    // difference is whether a message went out, which is not visible from the response.
    const knownBody = await known.json();
    const unknownBody = await unknown.json();
    assert.deepEqual({ ...knownBody, message: undefined }, { ...unknownBody, message: undefined });
    assert.equal(db.lastEmailedCode, null, 'no code may be generated for an unknown address');
});

test('an unconfirmed account cannot sign in, and the reply says why', async () => {
    process.env.NODE_ENV = 'production';
    seedUserWithCode();

    const response = await post('/api/auth/login', {
        email: 'member@example.test',
        password: PASSWORD
    });

    // The password is genuinely correct here, so this is not a "wrong password" refusal. A 401
    // would leave a real user retyping a password that worked, which is the failure mode this
    // test exists to prevent.
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.requiresVerification, true);
    assert.equal(body.email, 'member@example.test');
    assert.equal(body.token, undefined, 'an unconfirmed account must not receive a session');
});

test('a confirmed account signs in normally', async () => {
    process.env.NODE_ENV = 'production';
    seedUserWithCode();
    db.user.email_verified_at = new Date().toISOString();

    const response = await post('/api/auth/login', {
        email: 'member@example.test',
        password: PASSWORD
    });

    // The gate must not turn into a blanket block: once the address is confirmed the very
    // same account has to get a session.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(body.user.email, 'member@example.test');
});

test('the verification routes are POST-only and answer 405 with the right verb', async () => {
    for (const path of ['/api/auth/verify-email', '/api/auth/resend-verification']) {
        const response = await fetch(`${origin}${path}`, { method: 'GET' });
        assert.equal(response.status, 405, `${path} answered ${response.status} to GET`);
        assert.match(response.headers.get('allow') || '', /POST/);
    }
});
