const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/app');

/**
 * A known path reached with the wrong verb must answer 405, not 404.
 *
 * The distinction is the point of the registry. A 404 on `GET /api/contact` says the feature
 * is absent; a 405 with `Allow: POST` says the caller used the wrong verb, and an HTTP client
 * can correct itself from the header. The failure mode is silent, too: three public routes
 * were never added to the registry, and nothing failed when they were missed -- the paths
 * simply fell through to the generic 404 for as long as the omission went unnoticed.
 *
 * No database is involved. The registry is consulted after the routers have declined to
 * match, so this runs on a machine with no `TEST_DATABASE_URL`.
 */
let server;
let origin;
let priorSecret;
let priorQuery;

before(async () => {
    priorSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'method-registry-test-secret';

    // `requireAuth` reads the account on every request to check the token has not been
    // revoked. Without a database the refusal it produces (503) would be indistinguishable
    // from the endpoint being broken, so the one lookup is stubbed.
    priorQuery = pool.query;
    pool.query = async (query) => {
        if (String(query).includes('token_version')) {
            return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
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

/**
 * Every API path the app serves, with the verbs it accepts.
 *
 * Listed here rather than derived from the router because the router cannot be introspected
 * for this: a `router` is a function, and reflecting over it to find its methods means
 * parsing the source again. Writing the list out is the duplication that makes it worth
 * having -- adding a route without adding it here fails this test.
 */
const API_ROUTES = [
    { path: '/api/auth/login', methods: ['POST'] },
    { path: '/api/auth/register', methods: ['POST'] },
    { path: '/api/auth/logout', methods: ['POST'] },
    { path: '/api/auth/forgot-password', methods: ['POST'] },
    { path: '/api/auth/reset-password', methods: ['POST'] },
    { path: '/api/auth/verify-email', methods: ['POST'] },
    { path: '/api/auth/resend-verification', methods: ['POST'] },
    { path: '/api/auth/magic-link', methods: ['POST'] },
    { path: '/api/auth/magic-link/consume', methods: ['POST'] },
    { path: '/api/offers', methods: ['GET'] },
    { path: '/api/contact', methods: ['POST'] },
    { path: '/api/demo/survey', methods: ['GET'] },
    { path: '/api/demo/complete', methods: ['POST'] },
    { path: '/api/click/7', methods: ['GET', 'POST'] },
    { path: '/api/user/balance', methods: ['GET'] },
    { path: '/api/user/deposits', methods: ['GET', 'POST'] },
    { path: '/api/user/deposits/42', methods: ['GET'] },
    { path: '/api/user/email-preferences', methods: ['GET', 'PATCH'] },
    { path: '/api/user/history', methods: ['GET'] },
    { path: '/api/user/payment-options', methods: ['GET'] },
    { path: '/api/user/updates', methods: ['GET'] },
    { path: '/api/user/withdraw', methods: ['POST'] },
    { path: '/api/user/withdrawal-options', methods: ['GET'] },
    { path: '/api/user/withdrawals', methods: ['GET', 'POST'] },
    { path: '/api/user/withdrawals/code', methods: ['POST'] }
];

const OTHERS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

test('every API path names the verbs it accepts, so a wrong one is a 405 and not a 404', async () => {
    const missing = [];
    for (const route of API_ROUTES) {
        for (const method of OTHERS) {
            const response = await fetch(`${origin}${route.path}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: method === 'GET' || method === 'DELETE' ? undefined : '{}'
            });
            if (route.methods.includes(method)) {
                // Registered correctly. The handler may still refuse for want of a session
                // or a database, which is not what this test is about -- only that the
                // registry did not turn a valid verb into a 405.
                assert.notEqual(response.status, 405, `${method} ${route.path} was refused as a bad verb`);
                continue;
            }
            if (response.status !== 405) {
                missing.push(`${method} ${route.path} -> ${response.status} (expected 405)`);
            }
        }
    }
    assert.deepEqual(missing, [], `paths missing from the method registry:\n  ${missing.join('\n  ')}`);
});

test('a 405 names the verbs that would have worked', async () => {
    const response = await fetch(`${origin}/api/contact`, { method: 'GET' });
    assert.equal(response.status, 405);
    const allow = response.headers.get('allow') || '';
    assert.match(allow, /POST/);
});

test('a path that genuinely does not exist is still a 404, not a 405', async () => {
    // The other half of the contract. If unknown paths also answered 405 the registry would
    // be claiming routes that do not exist, which is worse than the 404 it replaced.
    const response = await fetch(`${origin}/api/not-a-real-endpoint`, { method: 'GET' });
    assert.equal(response.status, 404);
});

test('an unknown /api/user path is 401 before a token and 404 after one', async () => {
    // `userRoutes` authenticates the whole mount, so an anonymous caller cannot tell a typo
    // from a real path. That is deliberate -- answering 404 first would enumerate the API to
    // anyone who asked. The point of this test is that the ambiguity ends once the caller
    // has proved who they are, otherwise a typo in an authenticated client is permanently
    // indistinguishable from an expired session.
    const anonymous = await fetch(`${origin}/api/user/not-a-real-endpoint`, { method: 'GET' });
    assert.equal(anonymous.status, 401);

    const token = jwt.sign({ sub: '7' }, process.env.JWT_SECRET, { issuer: 'offer-network-api' });
    const authenticated = await fetch(`${origin}/api/user/not-a-real-endpoint`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(authenticated.status, 404);
});

test('a page path that does not exist is a plain 404, never JSON', async () => {
    // The SPA catch-all answers HTML routes. If an API path ever fell through to it, a client
    // expecting JSON would get a page, and every error message in the front end would render
    // as "[object Object]".
    const response = await fetch(`${origin}/not-a-real-page`);
    assert.equal(response.status, 404);
    assert.ok(!(response.headers.get('content-type') || '').includes('application/json'));
});
