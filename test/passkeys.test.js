const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { promisify } = require('node:util');
const { randomBytes, scrypt } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/app');
const passkeys = require('../src/services/passkeys');
const { VirtualAuthenticator } = require('./helpers/virtualAuthenticator');

const scryptAsync = promisify(scrypt);

/**
 * A password hash in the format the controller verifies.
 *
 * Needed only so the password path in the unconfirmed-account comparison reaches the
 * verification check rather than stopping at "wrong password". A stubbed `'x'` would make the
 * password attempt 401 while the passkey attempt 403s, and the test would then be comparing
 * two different refusals and concluding they agree.
 */
function encodePassword(password) {
    const salt = randomBytes(16).toString('hex');
    return scryptAsync(password, salt, 64).then((derived) => `scrypt$${salt}$${derived.toString('hex')}`);
}

/**
 * Passkey registration, authentication, and revocation.
 *
 * These are end-to-end. A software authenticator generates a real P-256 key pair, builds
 * real authenticator data, and produces a real signature, which `@simplewebauthn/server`
 * verifies. Nothing here is a mock of the cryptography, so a passing test means a genuine
 * assertion was accepted and a genuine forgery was refused -- not that a stub was shaped
 * correctly.
 *
 * What that buys is the ability to test the properties that make a passkey worth having,
 * each of which a mistake in *this* code would quietly undo:
 *
 *   - a credential is bound to one account and one origin, so neither can be swapped by
 *     whoever is making the request;
 *   - a credential cannot be listed, removed, or identified from another account;
 *   - the signature counter is advanced, and advanced *conditionally*, so a replayed or
 *     concurrent assertion is refused rather than accepted;
 *   - a missing or burned challenge is a refusal, not a fallback to something weaker;
 *   - "no such credential" is answered identically to "the signature did not verify", so
 *     this cannot be used to enumerate which passkeys exist.
 */

/**
 * Builds an authenticator and learns the stored form of its credential.
 *
 * `primeVerification` has to run before anything can assert with the key, because the value
 * stored in a `passkeys` row is the library's own re-serialisation of the COSE key -- not
 * something this helper can re-encode for itself and be sure it matches.
 */
async function primed(options) {
    const authenticator = new VirtualAuthenticator(options);
    await authenticator.primeVerification();
    return authenticator;
}

/** The origin the service under test will accept, matching `fakeRequest` below. */
const ORIGIN = 'https://rewardzone.test';
const RP_ID = 'rewardzone.test';

/** Replaces the module's pool for the duration of a call, and puts the real one back. */
async function withPool(query, run) {
    const original = pool.query;
    pool.query = query;
    try {
        return await run();
    } finally {
        pool.query = original;
    }
}

let server;
let httpOrigin;
let priorJwt;
const jwtSecret = 'passkey-test-secret';

function signUserToken(subject) {
    return jwt.sign({ sub: String(subject) }, jwtSecret, { issuer: 'offer-network-api' });
}

function authHeaders(subject) {
    return { Authorization: `Bearer ${signUserToken(subject)}`, 'Content-Type': 'application/json' };
}

async function get(path, headers) {
    const response = await fetch(`${httpOrigin}${path}`, { headers });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function post(path, headers, body) {
    const response = await fetch(`${httpOrigin}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {})
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function del(path, headers) {
    const response = await fetch(`${httpOrigin}${path}`, { method: 'DELETE', headers });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A stand-in for Express, with the two getters the service uses. */
function fakeRequest(host = RP_ID) {
    return {
        get: (name) => (String(name).toLowerCase() === 'host' ? host : undefined),
        protocol: 'https'
    };
}

/**
 * A pool that serves one stored credential, and captures the counter write.
 *
 * The rate-limit table is answered too, because the verify route sits behind a limiter and
 * that limiter fails closed: an unreadable counter denies the request rather than allowing it.
 * Without this row the endpoint answers 503 and the test measures the fixture, not the flow.
 */
function credentialPool(authenticator, storedUser, { advanceRow = true } = {}) {
    const writes = [];
    return {
        writes,
        query: async (query, params) => {
            const sql = String(query).replace(/\s+/g, ' ').trim();
            if (/auth_rate_limits/.test(sql)) {
                return { rows: [{ attempt_count: 0, window_started_at: new Date().toISOString() }], rowCount: 1 };
            }
            if (/FROM passkeys p/.test(sql)) {
                return { rows: [storedUser], rowCount: 1 };
            }
            if (/UPDATE passkeys/.test(sql)) {
                writes.push({ sql, params });
                return advanceRow
                    ? { rows: [{ credential_id: storedUser.credential_id }], rowCount: 1 }
                    : { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        }
    };
}

/** The user row the credential lookup joins to. */
function userRow(authenticator, overrides = {}) {
    return {
        credential_id: authenticator.credentialIdBase64,
        public_key: authenticator.publicKeyColumn,
        counter: authenticator.counter,
        transports: 'internal',
        user_id: 1,
        id: 1,
        email: 'ada@example.com',
        token_version: 0,
        email_verified_at: '2026-01-01T00:00:00.000Z',
        display_name: 'Ada',
        ...overrides
    };
}

/** A challenge of the right shape, for the cases where the value itself is not the subject. */
const VALID_CHALLENGE = 'A'.repeat(43);

before(async () => {
    priorJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = jwtSecret;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    // `localhost`, not `127.0.0.1`. A relying party is a domain, and browsers refuse an IP
    // address as one -- Chrome answers "This is an invalid domain" before the authenticator is
    // reached -- so the flow under test is only ever the one a browser will actually run. The
    // service refuses an IP host for the same reason, which these tests would otherwise trip.
    httpOrigin = `http://localhost:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (priorJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorJwt;
});

// ---------------------------------------------------------------------------
// Relying party and origin
// ---------------------------------------------------------------------------

test('the relying party is the host without its port, so a passkey is not locked to one subdomain', () => {
    assert.equal(passkeys.rpIdFor(fakeRequest('rewardzone.test:8443')), 'rewardzone.test');
    assert.equal(passkeys.rpIdFor(fakeRequest('localhost:3199')), 'localhost');
});

test('an explicit relying party overrides the host', () => {
    const prior = process.env.PASSKEY_RELYING_PARTY_ID;
    process.env.PASSKEY_RELYING_PARTY_ID = 'example.com';
    try {
        assert.equal(passkeys.rpIdFor(fakeRequest('preview.example.com')), 'example.com');
    } finally {
        if (prior === undefined) delete process.env.PASSKEY_RELYING_PARTY_ID;
        else process.env.PASSKEY_RELYING_PARTY_ID = prior;
    }
});

test('the configured public URL is an accepted origin, and a malformed one does not become "any origin"', () => {
    const prior = process.env.APP_BASE_URL;
    // The service logs when the value is unusable, which is intended; this test would
    // otherwise leave an unexplained error in the test output.
    const priorError = console.error;
    console.error = () => {};
    try {
        process.env.APP_BASE_URL = 'https://rewardzone.com/account';
        // Only the origin is taken. A passkey must not depend on which page created it.
        assert.deepEqual(passkeys.expectedOrigins(), ['https://rewardzone.com']);

        process.env.APP_BASE_URL = 'not a url at all';
        // Empty, not "accept anything". A passkey valid on any origin is not a passkey.
        assert.deepEqual(passkeys.expectedOrigins(), []);
    } finally {
        console.error = priorError;
        if (prior === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = prior;
    }
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test('registering offers the authenticator the credentials this account already has', async () => {
    const seen = [];
    const options = await withPool(async (query, params) => {
        seen.push({ sql: String(query), params });
        return {
            rows: [{ credential_id: 'AAAA', transports: 'internal' }, { credential_id: 'BBBB', transports: 'usb,nfc' }],
            rowCount: 2
        };
    }, () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    assert.match(seen[0].sql, /FROM passkeys WHERE user_id = \$1/);
    assert.deepEqual(seen[0].params, [1]);
    assert.deepEqual(options.excludeCredentials.map((c) => c.id), ['AAAA', 'BBBB']);
    assert.deepEqual(options.excludeCredentials[1].transports, ['usb', 'nfc']);
});

test('registering requires a resident key and user verification, so it is not a downgrade from a password', async () => {
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.equal(options.attestation, 'none');
});

test('the options name the account, which the browser requires before it asks the device', async () => {
    // `user.name` is a required member of `PublicKeyCredentialUserEntity`. Without it the
    // browser throws a TypeError -- "Failed to read the 'name' property from
    // 'PublicKeyCredentialEntity'" -- which reaches the visitor as an unhandled error and never
    // reaches their authenticator. It used to be missing in production, because the handler
    // passed `req.user.email` and `requireAuth` deliberately puts no email on that object.
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    assert.equal(options.user.name, 'ada@example.com');
    assert.equal(options.user.displayName, 'ada@example.com');
    // JSON is what the browser actually receives, and `JSON.stringify` drops an undefined
    // member -- which is precisely how the field went missing.
    assert.equal(JSON.parse(JSON.stringify(options)).user.name, 'ada@example.com');
});

test('a session with no email on it still produces a named credential, read from the account', async () => {
    // `requireAuth` builds `req.user` from the token's claims alone, so a handler that copied
    // an email out of it was copying `undefined`. The account row is the only trustworthy source.
    const seen = [];
    const options = await withPool(async (query, params) => {
        seen.push({ sql: String(query), params });
        if (/FROM users WHERE id/.test(String(query))) {
            return { rows: [{ email: 'ada@example.com', display_name: 'Ada' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }, () => passkeys.registrationOptions(fakeRequest(), { id: 7, tokenVersion: 0 }));

    assert.match(seen[1].sql, /FROM users WHERE id = \$1/);
    assert.deepEqual(seen[1].params, [7]);
    assert.equal(options.user.name, 'ada@example.com');
    // The display name is what the user is shown approving, so the saved one wins over the
    // address they will recognise but not recognise themselves by.
    assert.equal(options.user.displayName, 'Ada');
});

test('an account with no usable email is refused here, not by the browser', async () => {
    await assert.rejects(
        withPool(async () => ({ rows: [{ email: '', display_name: null }], rowCount: 1 }),
            () => passkeys.registrationOptions(fakeRequest(), { id: 3 })),
        (error) => error.code === 'account_identity_missing'
    );
});

test('an IP address is refused as a relying party, in words', async () => {
    // WebAuthn's relying party is a domain. A browser will not accept an IP as one, and the
    // refusal arrives as "This is an invalid domain" after the user has tapped a button labelled
    // with their device -- so it is caught where the options are built instead.
    for (const call of [
        () => passkeys.registrationOptions(fakeRequest('127.0.0.1:3199'), { id: 1, email: 'ada@example.com' }),
        () => passkeys.authenticationOptions(fakeRequest('127.0.0.1:3199')),
        () => passkeys.authenticationOptions(fakeRequest('[::1]:3199'))
    ]) {
        await assert.rejects(withPool(async () => ({ rows: [], rowCount: 0 }), call), (error) => {
            assert.equal(error.code, 'invalid_relying_party_host');
            // 400, not the 401 the other refusals use: this is about the request's host, and a
            // 401 here would be read as an expired session.
            assert.equal(error.status, 400);
            assert.match(error.message, /localhost/);
            return true;
        });
    }
});

test('localhost is a name, so a local developer is not locked out', async () => {
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest('localhost:3199'), { id: 1, email: 'ada@example.com' }));
    assert.equal(options.rp.id, 'localhost');
    assert.equal(options.user.name, 'ada@example.com');
});

test('the challenge is returned to the browser, which is where it is kept', async () => {
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    // Not remembered on the server. A challenge in a server-side Map is per instance, so a
    // cold start or a second instance in a load balancer loses it and a passkey that worked
    // locally fails in production.
    assert.equal(typeof options.challenge, 'string');
    assert.ok(options.challenge.length >= 43, 'a 32-byte challenge is 43 characters of base64url');
    assert.match(options.challenge, /^[\w-]+$/);
});

test('a challenge that could not have come from this server is refused', async () => {
    const authenticator = await primed();
    // The shape is checked so the library is never handed something that was not a challenge
    // at all. Anything implausible costs one round trip; a multi-kilobyte string costs more.
    for (const bad of [undefined, null, '', 'short', 'x'.repeat(1000), 'has spaces in it '.padEnd(50, 'a')]) {
        await assert.rejects(
            () => withPool(async () => ({ rows: [], rowCount: 1 }),
                () => passkeys.completeRegistration(fakeRequest(), { id: 1, email: 'a@b.c' }, authenticator.register('y'.repeat(43)), bad)),
            (error) => error.code === 'challenge_missing',
            `expected ${JSON.stringify(bad)} to be refused`
        );
    }
});

// ---------------------------------------------------------------------------
// Registration, end to end
// ---------------------------------------------------------------------------

/** Runs a full registration against a stubbed database and returns what was written. */
async function register(authenticator, user = { id: 1, email: 'ada@example.com' }) {
    const writes = [];
    const options = await withPool(async (query) => {
        writes.push({ sql: String(query).replace(/\s+/g, ' ').trim() });
        return { rows: [], rowCount: 0 };
    }, () => passkeys.registrationOptions(fakeRequest(), user));

    const response = authenticator.register(options.challenge);
    const result = await withPool(async (query, params) => {
        writes.push({ sql: String(query).replace(/\s+/g, ' ').trim(), params });
        return { rows: [], rowCount: 1 };
    }, () => passkeys.completeRegistration(fakeRequest(), user, response, options.challenge));

    return { options, result, writes, response };
}

test('a real registration verifies and stores one credential row owned by the signed-in account', async () => {
    const authenticator = await primed();
    const { result, writes } = await register(authenticator);

    assert.equal(result.credentialId, authenticator.credentialIdBase64);

    const insert = writes.find((w) => /INSERT INTO passkeys/.test(w.sql));
    assert.ok(insert, 'expected an insert into passkeys');
    assert.equal(insert.params[0], 1, 'the row belongs to the signed-in account');
    assert.equal(insert.params[1], authenticator.credentialIdBase64);
    // The key goes in as base64url text, not as the library's `Uint8Array`. Handing the array
    // straight to `pg` writes its comma-separated element numbers, the write reports success,
    // and every later sign-in with the passkey fails to verify for a credential that was
    // registered without complaint.
    assert.equal(typeof insert.params[2], 'string');
    assert.equal(insert.params[2], authenticator.publicKeyColumn);
});

test('re-registering a credential that is already stored does not create a second row', async () => {
    const authenticator = await primed();
    const { writes } = await register(authenticator);

    const insert = writes.find((w) => /INSERT INTO passkeys/.test(w.sql));
    assert.match(insert.sql, /ON CONFLICT \(credential_id\) DO NOTHING/,
        'a repeat registration of the same key must be a no-op, not a constraint error');
});

test('a registration from another origin is refused and stores nothing', async () => {
    // A real key pair and a real signature, over client data claiming a different origin.
    // This is what a phishing site gets if it manages to run a registration flow against a
    // passkey it does not own: the signature is genuine, and origin binding is the only
    // thing that refuses it.
    const attacker = await primed({ origin: 'https://phishing.test', rpId: 'phishing.test' });
    const user = { id: 1, email: 'ada@example.com' };
    const writes = [];

    const options = await withPool(async (query) => {
        writes.push({ sql: String(query) });
        return { rows: [], rowCount: 0 };
    }, () => passkeys.registrationOptions(fakeRequest(), user));

    await assert.rejects(
        () => withPool(async (query) => {
            writes.push({ sql: String(query) });
            return { rows: [], rowCount: 1 };
        }, () => passkeys.completeRegistration(fakeRequest(), user, attacker.register(options.challenge), options.challenge)),
        (error) => error.code === 'registration_failed'
    );

    assert.equal(writes.filter((w) => /INSERT/.test(w.sql)).length, 0,
        'a refused registration must not leave a row behind');
});

test('a registration answered with the wrong challenge is refused', async () => {
    const authenticator = await primed();
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));
    const response = authenticator.register(options.challenge);

    // A different 32-byte value, correctly shaped. The signature is over the challenge that
    // was actually issued, so this is refused -- which is the whole point of the check.
    const other = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    const writes = [];
    await assert.rejects(
        () => withPool(async (query) => {
            writes.push(String(query));
            return { rows: [], rowCount: 1 };
        }, () => passkeys.completeRegistration(fakeRequest(), { id: 1, email: 'ada@example.com' }, response, other.challenge)),
        (error) => error.code === 'registration_failed'
    );
    assert.equal(writes.filter((sql) => /INSERT/.test(sql)).length, 0);
});

test('a registration cannot be completed without a session', async () => {
    for (const path of ['/api/auth/passkeys/register/options', '/api/auth/passkeys/register/verify']) {
        assert.equal((await post(path, { 'Content-Type': 'application/json' }, {})).status, 401, `${path} must require a session`);
    }
});

// ---------------------------------------------------------------------------
// Authentication, end to end
// ---------------------------------------------------------------------------

/** Registers an authenticator and returns it, ready to assert. */
async function enrolled(user = { id: 1, email: 'ada@example.com' }) {
    const authenticator = await primed();
    await register(authenticator, user);
    return authenticator;
}

/** Runs a full assertion against a stubbed database. */
async function authenticate(authenticator, { row, advanceRow = true, origin = ORIGIN, rpId = RP_ID } = {}) {
    const request = {
        get: (name) => (String(name).toLowerCase() === 'host' ? rpId : undefined),
        protocol: origin.split('://')[0]
    };
    const stored = row || userRow(authenticator);
    const signer = origin === ORIGIN ? authenticator : await primed({ origin, rpId });

    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));

    const pool_ = credentialPool(signer, stored, { advanceRow });
    const result = await withPool(pool_.query,
        () => passkeys.completeAuthentication(request, signer.assert(options.challenge), options.challenge));

    return { result, writes: pool_.writes, options };
}

test('a real assertion verifies, resolves the account, and advances the counter', async () => {
    const authenticator = await enrolled();
    const { result, writes } = await authenticate(authenticator);

    assert.equal(result.email, 'ada@example.com');
    assert.equal(result.token_version, 0);

    const update = writes.find((w) => /UPDATE passkeys/.test(w.sql));
    assert.ok(update, 'expected the counter to be written back');
    // Without the `AND counter = $3` guard, two simultaneous assertions would both pass and
    // the replay window the counter exists to close would still be open.
    assert.match(update.sql, /WHERE credential_id = \$2 AND counter = \$3/);
    assert.match(update.sql, /RETURNING credential_id/);
    assert.deepEqual(update.params, [1, authenticator.credentialIdBase64, 0]);
});

test('an assertion from another origin is refused', async () => {
    const authenticator = await enrolled();
    const row = userRow(authenticator);

    // Same key, valid signature -- but the client data claims a different origin. This is the
    // phishing case, and origin binding is the only thing standing in front of it.
    const attacker = await primed({ origin: 'https://phishing.test', rpId: RP_ID });
    const request = fakeRequest();
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));

    const pool_ = credentialPool(attacker, { ...row, public_key: attacker.publicKeyColumn });
    await assert.rejects(
        () => withPool(pool_.query,
            () => passkeys.completeAuthentication(request, attacker.assert(options.challenge), options.challenge)),
        (error) => error.code === 'assertion_failed'
    );
    assert.equal(pool_.writes.length, 0, 'a refused assertion must not advance the counter');
});

test('an assertion for a relying party this site does not serve is refused', async () => {
    const authenticator = await enrolled();
    const request = fakeRequest('rewardzone.test');
    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));

    // The authenticator hashed a different rpId into its authenticator data, so the
    // rpIdHash will not match.
    const other = await primed({ origin: ORIGIN, rpId: 'other.test' });
    const pool_ = credentialPool(other, { ...userRow(authenticator), public_key: other.publicKeyColumn });

    await assert.rejects(
        () => withPool(pool_.query,
            () => passkeys.completeAuthentication(request, other.assert(options.challenge), options.challenge)),
        (error) => error.code === 'assertion_failed'
    );
});

test('a replayed assertion is refused, because its challenge has already been answered', async () => {
    const authenticator = await enrolled();
    const request = fakeRequest();

    const first = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));
    // The stored row is read *before* the authenticator signs, because signing advances the
    // authenticator's own counter. Reading it afterwards would store the post-signature value
    // and the first assertion would be refused as a counter regression -- which is a real
    // protection, but not the one this test is about.
    const row = userRow(authenticator);
    const response = authenticator.assert(first.challenge);

    await withPool(credentialPool(authenticator, row).query,
        () => passkeys.completeAuthentication(request, response, first.challenge));

    // A fresh challenge, presented with the *old* assertion. The signature is still perfectly
    // valid and the counter still advanced, so the only thing standing between this and a
    // replay is the challenge inside the signed client data. This is what makes it safe for
    // the server to take the expected challenge from the request: to pass, an attacker would
    // need a signature over a challenge they had not already spent.
    const second = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));

    await assert.rejects(
        () => withPool(credentialPool(authenticator, row).query,
            () => passkeys.completeAuthentication(request, response, second.challenge)),
        (error) => error.code === 'assertion_failed'
    );
});

test('a challenge is only a nonce, and what actually binds an assertion to it is the signature', async () => {
    // Worth stating explicitly, because it is what makes it safe for the expected challenge to
    // arrive in the request rather than from server-side storage. A challenge carries no
    // marker of which flow issued it -- the server cannot tell a registration challenge from
    // a sign-in one, and deliberately does not try. What stops one being spent on the other is
    // the client-side `kind` check, and what stops either being forged is that the signature
    // covers the challenge. This test pins the second half: a genuine signature over a
    // challenge this server did not issue in this flow still verifies, and the protection is
    // entirely in the signature check.
    const authenticator = await enrolled();
    const row = userRow(authenticator);

    const issued = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.registrationOptions(fakeRequest(), { id: 1, email: 'ada@example.com' }));

    const result = await withPool(credentialPool(authenticator, row).query,
        () => passkeys.completeAuthentication(fakeRequest(), authenticator.assert(issued.challenge), issued.challenge));

    assert.equal(result.email, 'ada@example.com');
});

test('an assertion that lost the counter race is refused, not signed in', async () => {
    const authenticator = await enrolled();
    // The UPDATE matches no rows: another assertion advanced the counter first.
    await assert.rejects(
        () => authenticate(authenticator, { advanceRow: false }),
        (error) => error.code === 'counter_mismatch'
    );
});

test('an unknown credential is answered exactly like a bad signature, so this is not an oracle', async () => {
    const authenticator = await enrolled();
    const request = fakeRequest();

    const unknownOptions = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));
    const unknown = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys
            .completeAuthentication(request, authenticator.assert(unknownOptions.challenge), unknownOptions.challenge)
            .then(() => assert.fail('should have been refused'))
            .catch((error) => ({ code: error.code, message: error.message })));

    // A credential that exists, with a signature that does not verify.
    const badOptions = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(request));
    const impostor = await primed();
    const badSignature = await withPool(
        credentialPool(impostor, { ...userRow(authenticator), public_key: impostor.publicKeyColumn }).query,
        () => passkeys
            .completeAuthentication(request, impostor.assert(badOptions.challenge), badOptions.challenge)
            .then(() => assert.fail('should have been refused'))
            .catch((error) => ({ code: error.code, message: error.message }))
    );

    assert.deepEqual(unknown, badSignature,
        'the two failures must be indistinguishable to the caller');
});

test('an assertion naming no credential is refused before any query runs', async () => {
    await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions(fakeRequest()));

    let queried = false;
    await withPool(async () => {
        queried = true;
        return { rows: [], rowCount: 0 };
    }, () => passkeys
        .completeAuthentication(fakeRequest(), {}, VALID_CHALLENGE)
        .then(() => assert.fail('should have been refused'))
        .catch((error) => assert.equal(error.code, 'missing_credential_id')));

    assert.equal(queried, false);
});

test('sign-in with a passkey is reachable without a session, which is the point of one', async () => {
    const result = await post('/api/auth/passkeys/authenticate/options', { 'Content-Type': 'application/json' });
    // The handler is live, so the request gets a real answer rather than a 401 from the auth
    // middleware.
    assert.notEqual(result.status, 401);
});

test('a verified assertion signs in and issues a session token', async () => {
    const authenticator = await primed({ origin: httpOrigin, rpId: 'localhost' });

    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions({ get: (n) => (n === 'host' ? 'localhost' : undefined), protocol: 'http' }));

    const pool_ = credentialPool(authenticator, {
        credential_id: authenticator.credentialIdBase64,
        public_key: authenticator.publicKeyColumn,
        counter: 0,
        transports: 'internal',
        user_id: 1,
        id: 1,
        email: 'ada@example.com',
        token_version: 3,
        email_verified_at: '2026-01-01T00:00:00.000Z',
        display_name: 'Ada'
    });

    // The whole exchange, over HTTP, through the real route and the real controller.
    const result = await withPool(pool_.query, () => post(
        '/api/auth/passkeys/authenticate/verify',
        { 'Content-Type': 'application/json' },
        { response: authenticator.assert(options.challenge), challenge: options.challenge }
    ));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.user.email, 'ada@example.com');
    // The token names the account the credential belonged to, which is how a credential id
    // becomes an identity -- and it carries the stored `ver`, so a password reset still
    // invalidates sessions that were established with a passkey.
    const claims = jwt.verify(result.body.token, jwtSecret, { issuer: 'offer-network-api' });
    assert.equal(claims.sub, '1');
    assert.equal(claims.ver, 3);
});

test('a passkey on an unconfirmed account cannot sign in, and gets the same answer as a password would', async () => {
    const authenticator = await primed({ origin: httpOrigin, rpId: 'localhost' });
    const unverified = {
        ...userRow(authenticator),
        credential_id: authenticator.credentialIdBase64,
        public_key: authenticator.publicKeyColumn,
        email_verified_at: null
    };

    const options = await withPool(async () => ({ rows: [], rowCount: 0 }),
        () => passkeys.authenticationOptions({ get: (n) => (n === 'host' ? 'localhost' : undefined), protocol: 'http' }));

    // The stub also answers the account and rate-limit lookups, so the password path can be
    // compared honestly. Without them the password attempt fails for unrelated reasons -- a
    // missing user row, or a rate-limit read with no row -- and the test would be asserting
    // that those look the same as a refused unverified account. They do not.
    const base = credentialPool(authenticator, unverified).query;
    const password = 'correct horse battery staple';
    const unverifiedUser = {
        id: 1,
        email: 'ada@example.com',
        email_verified_at: null,
        token_version: 0,
        password_hash: await encodePassword(password)
    };
    const query = async (text, params) => {
        const sql = String(text).replace(/\s+/g, ' ');
        if (/auth_rate_limits/.test(sql)) {
            return { rows: [{ attempt_count: 0, window_started_at: new Date().toISOString() }], rowCount: 1 };
        }
        if (/FROM users/.test(sql)) {
            return { rows: [unverifiedUser], rowCount: 1 };
        }
        return base(text, params);
    };

    const result = await withPool(query, () => post(
        '/api/auth/passkeys/authenticate/verify',
        { 'Content-Type': 'application/json' },
        { response: authenticator.assert(options.challenge), challenge: options.challenge }
    ));

    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.requiresVerification, true);
    assert.match(result.body.error, /Confirm your email/i);

    // Both sign-in paths must agree, or a passkey becomes a way around the check.
    const passwordLogin = await withPool(query, () => post('/api/auth/login', { 'Content-Type': 'application/json' }, {
        email: 'ada@example.com',
        password
    }));
    assert.equal(passwordLogin.status, 403);
    assert.equal(passwordLogin.body.requiresVerification, true);
});

// ---------------------------------------------------------------------------
// Listing and revocation
// ---------------------------------------------------------------------------

test('listing is scoped to the signed-in account', async () => {
    let seen;
    await withPool(async (query, params) => {
        seen = { sql: String(query).replace(/\s+/g, ' ').trim(), params };
        return { rows: [], rowCount: 0 };
    }, () => passkeys.listPasskeys(42));

    assert.match(seen.sql, /FROM passkeys\s+WHERE user_id = \$1/);
    assert.deepEqual(seen.params, [42]);
});

test('removing a credential is scoped to its owner, so one account cannot revoke another', async () => {
    let seen;
    await withPool(async (query, params) => {
        seen = { sql: String(query).replace(/\s+/g, ' ').trim(), params };
        // The DELETE reports no rows: the credential exists, but belongs to somebody else.
        return { rows: [], rowCount: 0 };
    }, () => passkeys.deletePasskey(42, 'SOMEONE_ELSES_CREDENTIAL').then((removed) => assert.equal(removed, false)));

    assert.match(seen.sql, /DELETE FROM passkeys WHERE user_id = \$1 AND credential_id = \$2/);
    assert.deepEqual(seen.params, [42, 'SOMEONE_ELSES_CREDENTIAL']);
});

test('removing a credential that is not there is reported as not found, with no other detail', async () => {
    // `requireAuth` reads `token_version` and `is_banned` from the user row before the handler
    // runs, so the stub has to answer that too or every such test would read as an
    // authentication failure.
    const result = await withPool(async (query) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        if (/FROM users WHERE id = \$1$/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }, () => del('/api/auth/passkeys/NO_SUCH_CREDENTIAL', authHeaders(42)));

    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'That passkey was not found.');
    // A 403 here would confirm the credential exists on some account.
    assert.equal(Object.keys(result.body).length, 1);
});

test('the passkey list is only returned to a signed-in caller', async () => {
    const result = await withPool(async (query) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        if (/FROM users WHERE id = \$1$/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        }
        if (/FROM passkeys\s+WHERE user_id = \$1/.test(sql)) {
            return {
                rows: [{
                    credential_id: 'CRED_1',
                    name: 'Work laptop',
                    device_type: 'multiDevice',
                    transports: 'internal',
                    created_at: '2026-01-01T00:00:00.000Z',
                    last_used_at: null
                }],
                rowCount: 1
            };
        }
        return { rows: [], rowCount: 0 };
    }, () => get('/api/auth/passkeys', authHeaders(42)));

    assert.equal(result.status, 200);
    assert.equal(result.body.passkeys.length, 1);
    assert.equal(result.body.passkeys[0].name, 'Work laptop');
});

test('listing and removing both need a session', async () => {
    assert.equal((await get('/api/auth/passkeys')).status, 401);
    assert.equal((await del('/api/auth/passkeys/ANY', {})).status, 401);
});
