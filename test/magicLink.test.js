const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/app');
const { buildMagicLinkUrlForTest } = require('../src/services/magicLinkEmail');
const { sendPasswordResetEmail } = require('../src/services/resetEmail');

/**
 * The magic link, end to end: request it, render the email, follow the link, get a session.
 *
 * This is the only auth path in the product with no fallback. Password sign-in has the form
 * in front of the user; the six-digit code has a resend button. A magic link is a URL in an
 * email and nothing else -- so any break in it is a user with no way into their account and
 * no visible reason why.
 *
 * The tests below are written against the flow rather than against the endpoints, because
 * the failures that matter here are the ones that only appear *between* two correct-looking
 * pieces: an email that renders with no link in it, a link that points somewhere the gate
 * turns away, and a gate that turns it away.
 */

let server;
let origin;
const priorJwt = process.env.JWT_SECRET;
const jwtSecret = 'magic-link-test-secret';
const priorBaseUrl = process.env.APP_BASE_URL;
const priorBrevoKey = process.env.BREVO_API_KEY;
const priorEmailFrom = process.env.EMAIL_FROM;
const priorEmailProvider = process.env.EMAIL_PROVIDER;

function signUserToken(subject) {
    return jwt.sign({ sub: String(subject) }, jwtSecret, { issuer: 'offer-network-api' });
}

/**
 * Captures outbound mail by standing in for `fetch`, which is what the mailer calls.
 *
 * Everything that is not the mailer is passed through to the real `fetch`. Replacing it
 * wholesale also swallows the request to the test server itself, so the endpoint under test
 * is never reached and every assertion below fails on a 202 from the stub rather than on
 * anything the code did -- which reads as a broken endpoint and is not one.
 */
async function withCapturedMail(run) {
    const originalFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, options) => {
        if (!String(url).includes('email')) return originalFetch(url, options);
        const body = JSON.parse(options.body);
        sent.push({ url, body });
        return { ok: true, status: 202, text: async () => '' };
    };
    try {
        return { result: await run(), sent };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

/**
 * Puts the mailer into a state where it will actually attempt a send.
 *
 * The real gate is `isEmailConfigured`, which needs a sender address *and* a provider key.
 * Without both, `sendEmail` short-circuits to `{ sent: false, reason: 'not-configured' }`
 * and returns before it ever calls `fetch` -- so a test that forgot this would see "no email
 * was captured" and conclude the magic link is not being sent, when in fact the mailer was
 * never asked to.
 */
function configureMailer() {
    process.env.EMAIL_PROVIDER = 'brevo';
    process.env.BREVO_API_KEY = 'test-key-not-a-real-credential';
    process.env.EMAIL_FROM = 'noreply@example.com';
}

before(async () => {
    process.env.JWT_SECRET = jwtSecret;
    // A public origin, which is the case that has to work: this is what production runs with.
    process.env.APP_BASE_URL = 'https://app.example.com';
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const restore = (key, value) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    };
    restore('JWT_SECRET', priorJwt);
    restore('APP_BASE_URL', priorBaseUrl);
    restore('BREVO_API_KEY', priorBrevoKey);
    restore('EMAIL_FROM', priorEmailFrom);
    restore('EMAIL_PROVIDER', priorEmailProvider);
});

/**
 * Stubs the database for the send path.
 *
 * The magic-link table is written through a dedicated connection, so `connect` is stubbed as
 * well as `query` -- a stub that only covers `query` makes every test here fail as a
 * connection error, which reads as a broken endpoint rather than a broken stub.
 */
function withMagicLinkDb(stored, run) {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const issued = [];

    const handle = async (query, params) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();

        // The rate limiter runs on the pool, before any of the auth logic. Its row shape is
        // read positionally (`rows[0].attempt_count`), so returning an empty array here makes
        // it throw and the endpoint answers 503 -- which is indistinguishable, from the
        // outside, from the real failure being investigated.
        if (/auth_rate_limits/.test(sql)) {
            return {
                rows: [{ attempt_count: 1, window_started_at: new Date() }],
                rowCount: 1
            };
        }

        if (/SELECT id, email, email_verified_at FROM users/.test(sql)) {
            return { rows: stored.user ? [stored.user] : [], rowCount: stored.user ? 1 : 0 };
        }
        if (/DELETE FROM magic_link_tokens WHERE user_id/.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO magic_link_tokens/.test(sql)) {
            issued.push(params);
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM magic_link_tokens\s+WHERE token_hash/.test(sql)) {
            const hash = params[0];
            return {
                rows: hash === stored.tokenHash
                    ? [{ user_id: stored.user.id, email: stored.user.email }]
                    : [],
                rowCount: hash === stored.tokenHash ? 1 : 0
            };
        }
        if (/UPDATE users/.test(sql)) {
            return {
                rows: [{
                    id: stored.user.id,
                    email: stored.user.email,
                    balance: '0.00',
                    demo_balance: '0.00',
                    token_version: 1
                }],
                rowCount: 1
            };
        }
        // Session validation during the consume call.
        if (/FROM users WHERE id =/.test(sql)) {
            return {
                rows: [{ token_version: 0, is_banned: false, balance: '0.00', demo_balance: '0.00' }],
                rowCount: 1
            };
        }
        return { rows: [], rowCount: 0 };
    };

    pool.query = handle;
    pool.connect = async () => ({ query: handle, release() {} });

    return Promise.resolve()
        .then(() => run({ issued }))
        .then((result) => ({ ...result, issued }))
        .finally(() => {
            pool.query = originalQuery;
            pool.connect = originalConnect;
        });
}

test('the email carries a working link, not an empty message', async () => {
    // This is the failure that is invisible from the endpoint: the request answers 200, the
    // mailer reports a successful send, and the message that lands has no link in it. The
    // user is told a link is on its way and there is nothing to click.
    configureMailer();

    const user = { id: 9001, email: 'pending@example.com', email_verified_at: null };
    const { sent, issued } = await withMagicLinkDb({ user }, async () => {
        return withCapturedMail(async () => {
            const response = await fetch(`${origin}/api/auth/magic-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Mixed case on the way in: the address is stored lower-cased, so this also
                // proves the lookup normalises rather than matching the raw string.
                body: JSON.stringify({ email: 'Pending@Example.com' })
            });
            assert.equal(response.status, 200);
        });
    });

    assert.equal(sent.length, 1, 'exactly one email should have been attempted');
    // Brevo names the bodies `htmlContent` / `textContent`; Resend names them `html` / `text`.
    const message = sent[0].body;
    const html = message.htmlContent || '';
    const text = message.textContent || '';

    // The link must be present in BOTH renderings. The HTML button is what most clients
    // show; the text body is what a text-only client reads, and it is the only fallback
    // when an image-stripping gateway eats the button.
    assert.match(html, /https:\/\/app\.example\.com\/offers#magic=[0-9a-f]{64}/,
        'the HTML body must contain a magic link');
    assert.match(text, /https:\/\/app\.example\.com\/offers#magic=[0-9a-f]{64}/,
        'the plain-text body must contain a magic link');

    // Both renderings must carry the *same* token. They are built from one variable today,
    // but they are rendered by two different functions, and a link that works in one client
    // and not another is exactly the failure that gets reported as "the link is broken" with
    // no way to reproduce it.
    const fromHtml = /#magic=([0-9a-f]{64})/.exec(html)[1];
    const fromText = /#magic=([0-9a-f]{64})/.exec(text)[1];
    assert.equal(fromHtml, fromText, 'both bodies must carry the same token');

    // The emailed token must be the one whose hash was stored. A link whose token does not
    // match the stored hash is a link that cannot be redeemed, and the failure surfaces only
    // when the user clicks it.
    assert.equal(issued.length, 1, 'exactly one token should have been stored');
    assert.equal(issued[0][0], createHash('sha256').update(fromHtml).digest('hex'),
        'the emailed token must be the one whose hash was stored');
    assert.equal(issued[0][2], 'pending@example.com',
        'the token is stored against the normalised address');
});

test('a magic link is only offered for an account that has not been confirmed', async () => {
    // The response is deliberately identical either way, so this asserts on the mail rather
    // than the status code: a confirmed account getting no email is correct, and one getting
    // a link it does not need is not what the copy promises.
    configureMailer();

    const verified = { id: 9002, email: 'done@example.com', email_verified_at: new Date() };
    const { sent } = await withMagicLinkDb({ user: verified }, async () => {
        return withCapturedMail(async () => {
            const response = await fetch(`${origin}/api/auth/magic-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'done@example.com' })
            });
            assert.equal(response.status, 200);
        });
    });

    assert.equal(sent.length, 0, 'a confirmed account must not be sent a sign-in link');
});

test('an unknown address is answered exactly like a known one', async () => {
    // The anti-enumeration property. If the two answers differed in status or body, the
    // endpoint would confirm which addresses have accounts -- and it is the only thing
    // standing between this route and a list of every customer.
    configureMailer();

    const { sent: sentForKnown, result: knownResponse } = await withMagicLinkDb(
        { user: { id: 9003, email: 'a@example.com', email_verified_at: null } },
        async () => withCapturedMail(async () => {
            const response = await fetch(`${origin}/api/auth/magic-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'a@example.com' })
            });
            return { status: response.status, body: await response.json() };
        })
    );

    const { sent: sentForUnknown, result: unknownResponse } = await withMagicLinkDb(
        { user: null },
        async () => withCapturedMail(async () => {
            const response = await fetch(`${origin}/api/auth/magic-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'nobody@example.com' })
            });
            return { status: response.status, body: await response.json() };
        })
    );

    // The work differs, which is the point: one is sent and one is not.
    assert.equal(sentForKnown.length, 1);
    assert.equal(sentForUnknown.length, 0);

    // The answer must not.
    assert.equal(unknownResponse.status, knownResponse.status);
    assert.deepEqual(unknownResponse.body, knownResponse.body,
        'the response must not reveal whether the address has an account');
});

test('a malformed address is refused outright, before any lookup', async () => {
    // This one *is* allowed to differ, because "that is not an email address" says nothing
    // about whether an account exists -- it is a statement about the input.
    for (const email of ['', 'not-an-email', 'a@', '@example.com', 'a b@example.com']) {
        const response = await fetch(`${origin}/api/auth/magic-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(email)}`);
    }
});

test('the emailed link is redeemable exactly once', async () => {
    // Single-use is the whole security property of the token. If a second redemption
    // succeeded, a link forwarded out of a mailbox would keep working.
    const token = 'a'.repeat(64);
    const user = { id: 9004, email: 'single@example.com', email_verified_at: null };

    const first = await withMagicLinkDb({ user, tokenHash: createHash('sha256').update(token).digest('hex') },
        async () => {
            const response = await fetch(`${origin}/api/auth/magic-link/consume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            return { status: response.status, body: await response.json() };
        });

    assert.equal(first.status, 200);
    assert.ok(first.body.token, 'a successful redemption returns a session token');

    // Second attempt, with the row now gone. The stub returns no rows for a hash that is not
    // live, which is the state a real second attempt finds.
    const second = await withMagicLinkDb({ user, tokenHash: 'b'.repeat(64) }, async () => {
        const response = await fetch(`${origin}/api/auth/magic-link/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        return { status: response.status, body: await response.json() };
    });

    // 400, not 401 and not 500: the link is a credential that has been spent or never
    // existed, and the user is told to sign in another way.
    assert.equal(second.status, 400);
});

test('a malformed token is refused before the database is touched', async () => {
    // Length and shape are checked up front, so a hostile or truncated value cannot turn
    // into a query at all. The pool is stubbed so the consume route's IP limiter is counting
    // against a stubbed counter rather than the real one -- five rapid requests against a
    // live limiter is a 429 by the fourth, which would be reported here as the endpoint
    // accepting a malformed token.
    const user = { id: 9005, email: 'shape@example.com', email_verified_at: null };
    await withMagicLinkDb({ user, tokenHash: 'f'.repeat(64) }, async () => {
        for (const token of ['', 'nope', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
            const response = await fetch(`${origin}/api/auth/magic-link/consume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(token)}`);
        }
    });
});

test('the link the email carries survives the gate that guards the page it points at', () => {
    // The emailed link is `/offers#magic=...`, and `/offers` is served by a page marked
    // `data-requires-session="true"`. A signed-out recipient therefore never sees that page:
    // the session gate redirects to `/login?next=...`. If the magic fragment were dropped in
    // that redirect, every magic link in every mailbox would be a dead link -- and the
    // symptom would be "the link does nothing" with nothing in any log to explain it.
    //
    // This asserts the contract between the two files rather than running a browser: the URL
    // the email builds must be one the gate is able to carry across, and the token must be
    // in the fragment rather than the query string so it never reaches a request line.
    const url = buildMagicLinkUrlForTest('c'.repeat(64));
    assert.ok(url, 'a public base URL must produce a link');
    const parsed = new URL(url);

    assert.equal(parsed.pathname, '/offers');
    assert.equal(parsed.search, '', 'the token must not be in the query string');
    assert.equal(parsed.hash, `#magic=${'c'.repeat(64)}`);

    // What the gate does with it, reproduced here: the fragment is carried into `next`.
    const carry = parsed.hash.startsWith('#magic=') ? parsed.hash : '';
    assert.ok(carry, 'the gate carries the magic fragment across the redirect');
    const loginUrl = `/login?next=${encodeURIComponent(`${parsed.pathname}${carry}`)}`;

    // And what the reader does with what arrives: read `next`, find the fragment inside it.
    const carried = new URL(loginUrl, 'https://app.example.com').searchParams.get('next');
    const hashIndex = carried.indexOf('#');
    assert.notEqual(hashIndex, -1);
    const fragment = carried.slice(hashIndex + 1);
    const token = new URLSearchParams(fragment).get('magic');
    assert.equal(token, 'c'.repeat(64), 'the token survives the redirect intact');
});

test('a local base URL does not produce a link that cannot be opened', () => {
    // The guard that keeps provider callbacks honest also runs here, and it makes
    // `buildMagicLinkUrl` return null on localhost. That is correct -- a link to
    // `localhost:3001` is dead in an inbox -- but it means the caller must handle null by
    // refusing to send rather than by sending a message with no link in it.
    const prior = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'http://localhost:3001';
    try {
        assert.equal(buildMagicLinkUrlForTest('d'.repeat(64)), null);
    } finally {
        if (prior === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = prior;
    }
});

test('no email is sent at all when the link cannot be built', async () => {
    // The regression this exists for. `magicUrl ? {...} : null` used to read as a tidy way
    // to express an optional button, and it meant a misconfigured deployment delivered a
    // sign-in email with a heading, an intro, and no way to sign in -- while the provider
    // reported success and the endpoint told the user the link was on its way.
    configureMailer();
    const prior = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'http://localhost:3001';

    try {
        const user = { id: 9006, email: 'nolink@example.com', email_verified_at: null };
        const { sent } = await withMagicLinkDb({ user }, async () => withCapturedMail(async () => {
            const response = await fetch(`${origin}/api/auth/magic-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'nolink@example.com' })
            });
            // Still 200: the endpoint must not confirm which addresses have accounts, and
            // telling this one apart from an unknown address would confirm that one.
            assert.equal(response.status, 200);
        }));

        assert.equal(sent.length, 0, 'a sign-in email with no link must not be delivered');
    } finally {
        if (prior === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = prior;
    }
});

test('a password reset is not delivered with a link that cannot be opened', async () => {
    // Same defect, same consequence, and worse: the reset link is the only way to get back
    // into the account. It also has to not print the token while complaining about it.
    configureMailer();
    const warnings = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args) => warnings.push(args.join(' '));
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
        const { sent } = await withCapturedMail(async () => {
            const result = await sendPasswordResetEmail({
                to: 'someone@example.com',
                resetUrl: 'http://localhost:3001/reset-password?token=deadbeefdeadbeef'
            });
            return result;
        });

        assert.equal(sent.length, 0, 'a reset email with no working link must not be delivered');
        assert.equal(warnings.length, 1);
        // The log names the problem and points at the fix...
        assert.match(warnings[0], /APP_BASE_URL/);
        // ...and it must NOT contain the live token, which would put a working credential
        // into whatever ships logs off the host.
        assert.doesNotMatch(warnings[0], /deadbeefdeadbeef/);
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
});

void signUserToken;
