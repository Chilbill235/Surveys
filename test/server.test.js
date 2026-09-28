const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
// Import the Express app directly, not server.js: server.js is the entry point that
// binds a port, and requiring it here would collide with a running dev server
// (`EADDRINUSE`) every time the suite runs.
const app = require('../src/app');
const pool = require('../src/config/db');
const { reconcilePendingDeposits } = require('../src/services/depositReconciliation');
const { creditConfirmedDeposit } = require('../src/services/depositCredit');
const { markWithdrawalPaid, refundWithdrawal, refundSourceId } = require('../src/services/withdrawalResolution');
const { resetCryptoDepositOptionsCache } = require('../src/controllers/paymentController');
const { registerOrExplain } = require('../helpers/register');

/**
 * Mints a bearer token the auth middleware will actually accept.
 *
 * The issuer is not optional decoration. `requireAuth` verifies it, and a token signed without
 * it is rejected as `jwt issuer invalid` before the handler runs -- so a test that signed its own
 * tokens inline would fail as an authentication error and look like a broken endpoint. Centralised
 * so the required claims are stated once, next to the reason they are required.
 */
function signUserToken(subject, secret = process.env.JWT_SECRET) {
    return jwt.sign({ sub: String(subject) }, secret, { issuer: 'offer-network-api' });
}

let server;
let origin;

/**
 * Recursively sorts object keys, matching how the provider signs a callback.
 *
 * Written out here rather than imported so a change to the app's own sort cannot make the
 * test agree with a regression: the test signs what the *provider* signs.
 */
function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])])
    );
}

/**
 * Returns the database used for live tests, or null when none is configured.
 *
 * This suite used to run against whatever DATABASE_URL pointed at, so `npm test` on a
 * machine (or CI job) with production credentials in the environment executed real
 * registrations, deposits, and withdrawals against live customer data. Live tests now
 * run only when TEST_DATABASE_URL is set, which is the documented opt-in.
 */
function liveTestDatabaseUrl() {
    const url = (process.env.TEST_DATABASE_URL || '').trim();
    if (!url) return null;
    if (url === (process.env.DATABASE_URL || '').trim()) {
        console.warn('Refusing to run live tests: TEST_DATABASE_URL must differ from DATABASE_URL.');
        return null;
    }
    return url;
}

const liveTestUrl = liveTestDatabaseUrl();

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
});

test('root serves the home page', async () => {
    const response = await fetch(origin);
    const html = await response.text();
    assert.equal(response.status, 200);
    // The hero is what makes this the home page rather than some other page being served at
    // `/`. Asserted on a structural marker instead of the title, because the title is copy that
    // gets rewritten for SEO and a test that fails on every such change is a test people learn
    // to delete.
    assert.match(html, /<main class="home-shell"/);
    assert.match(html, /<h1[^>]*>/);
    assert.match(html, /href="\/offers"/);
});

test('offers page and static assets are served', async () => {
    const page = await fetch(`${origin}/offers`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /<title>Offers \| RewardZone<\/title>/);
    assert.match(html, /href="\/style\.css"/);

    const [home, homeScript, demoScript, script, style] = await Promise.all([
        fetch(`${origin}/home.html`),
        fetch(`${origin}/home.js`),
        fetch(`${origin}/demo.js`),
        fetch(`${origin}/app.js`),
        fetch(`${origin}/style.css`)
    ]);
    assert.equal(home.status, 200);
    assert.equal(homeScript.status, 200);
    assert.equal(demoScript.status, 200);
    assert.equal(script.status, 200);
    assert.equal(style.status, 200);
});

test('offer API returns the seeded demo offers and survey outside production', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    try {
        // The catalog is environment-dependent, so the environment is set rather than
        // inherited: this project's .env sets NODE_ENV to `production`, and a test that
        // reads the ambient value asserts nothing about the behaviour it names.
        process.env.NODE_ENV = 'test';
        const response = await fetch(`${origin}/api/offers`);
        assert.equal(response.status, 200);
        const offers = await response.json();
        const demoOffers = offers.filter((offer) => offer.is_demo);
        assert.equal(demoOffers.length, 3);
        assert.ok(demoOffers.every((offer) => offer.title.startsWith('TEST ONLY')));
        assert.ok(demoOffers.some((offer) => offer.offer_type === 'survey'));
        assert.ok(demoOffers.every((offer) => Number(offer.payout) > 0));
        // The card renders the blurb and the display partner name, so both have to be in
        // the response; a seeded offer with neither would render a card with no context.
        assert.ok(demoOffers.every((offer) => typeof offer.description === 'string' && offer.description.length > 0));
        assert.ok(demoOffers.every((offer) => offer.partner_label === 'Demo Partner'));
        // The advertiser's tracking URL must never be sent to the browser: anyone who had
        // it could append their own aff_sub and claim credit for untracked clicks.
        assert.ok(offers.every((offer) => offer.tracking_url === undefined));
    } finally {
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
    }
});

test('demo completion page is available only outside production', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'development';
        const demoPage = await fetch(`${origin}/demo?type=offer`);
        assert.equal(demoPage.status, 200);
        // The label is uppercased by the stylesheet's text-transform, so the source text
        // is sentence case. Match it case-insensitively: what matters is that the page
        // states it is a test environment, not how the casing is spelled in the markup.
        assert.match(await demoPage.text(), /Test environment/i);

        process.env.NODE_ENV = 'production';
        const productionPage = await fetch(`${origin}/demo`);
        assert.equal(productionPage.status, 404);
    } finally {
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
    }
});

test('payment provider options and deposit creation fail honestly when providers are not configured', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.JWT_SECRET;
    const priorStripeSecret = process.env.STRIPE_SECRET_KEY;
    const priorStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const originalQuery = pool.query;
    const userId = 4242;
    let insertStatements = 0;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'payment-config-test-secret';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.NOWPAYMENTS_API_KEY;
    delete process.env.NOWPAYMENTS_IPN_SECRET;

    // This test is about configuration handling, not persistence, so the whole pool is
    // stubbed. That keeps it runnable on a machine with no PostgreSQL while still
    // proving that a rejected deposit never reaches an INSERT.
    pool.query = async (query) => {
        if (query.includes('SELECT token_version')) {
            return { rows: [{ token_version: 0, is_banned: false }] };
        }
        if (/INSERT INTO auth_rate_limits/i.test(query)) {
            return { rows: [{ attempt_count: 1, window_started_at: new Date().toISOString() }] };
        }
        if (/INSERT INTO deposits/i.test(query)) {
            insertStatements += 1;
            return { rows: [{ id: 1 }] };
        }
        throw new Error(`Unexpected test query: ${query}`);
    };

    try {
        const headers = { Authorization: `Bearer ${signUserToken(userId)}` };

        const optionsResponse = await fetch(`${origin}/api/user/payment-options`, { headers });
        assert.equal(optionsResponse.status, 200);
        const options = await optionsResponse.json();
        assert.equal(options.stripeAvailable, false);
        assert.equal(options.cryptoAvailable, false);
        assert.deepEqual(options.cryptoCurrencies, []);
        assert.equal(options.minimumUsd, 1);

        const belowMinimum = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 0.99, method: 'crypto', currency: 'btc' })
        });
        assert.equal(belowMinimum.status, 400);
        // The limits are grouped and carry cents so they read the same way as the amounts
        // the form shows. "$5000" next to a form that says "$5,000.00" leaves the user
        // deciding which of the two is the real ceiling.
        assert.match((await belowMinimum.json()).error, /between \$1\.00 and \$5,000\.00\./);

        const depositResponse = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 10, method: 'crypto', currency: 'btc' })
        });
        assert.equal(depositResponse.status, 503);
        assert.match((await depositResponse.json()).error, /NOWPayments/);
        assert.equal(insertStatements, 0);
    } finally {
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = priorStripeSecret;
        if (priorStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = priorStripeWebhook;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('provider webhooks reject unsigned or unconfigured callbacks', async () => {
    const priorStripeSecret = process.env.STRIPE_SECRET_KEY;
    const priorStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
    try {
        const stripeResponse = await fetch(`${origin}/api/payments/stripe/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'checkout.session.completed' })
        });
        assert.equal(stripeResponse.status, 503);

        const nowResponse = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_id: 1, order_id: '1', payment_status: 'finished' })
        });
        assert.equal(nowResponse.status, 401);
    } finally {
        if (priorStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = priorStripeSecret;
        if (priorStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = priorStripeWebhook;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('NOWPayments IPN browser GET explains that callbacks require POST', async () => {
    const response = await fetch(`${origin}/api/payments/nowpayments/ipn`);
    assert.equal(response.status, 405);
    const body = await response.json();
    // Asserted on the parts that matter rather than the exact wording, because a browser
    // landing on this URL is the only audience: it has to say the method is wrong, and carry
    // an `Allow` header equivalent so a client can discover the right verb.
    assert.match(body.error, /POST/);
    assert.deepEqual(body.allowed, ['POST']);
    assert.equal(response.headers.get('allow'), 'POST');
});

test('a correctly signed IPN is accepted whatever content-type it arrives with', async () => {
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const originalConnect = pool.connect;
    const secret = 'ipn-content-type-test-secret';
    process.env.NOWPAYMENTS_IPN_SECRET = secret;

    // The pool is stubbed so the result does not depend on what the configured database
    // happens to contain. Left unstubbed, a real deposit row with a different provider
    // payment id would answer 400 and make this test pass or fail on live data.
    pool.connect = async () => ({
        query: async (query) => {
            if (/^BEGIN/i.test(query)) return { rows: [] };
            if (/^COMMIT/i.test(query) || /^ROLLBACK/i.test(query)) return { rows: [] };
            if (/FROM deposits WHERE id/i.test(query)) return { rows: [] };
            return { rows: [] };
        },
        release: () => {}
    });

    try {
        // express.json() only parses application/json. A callback that arrives as
        // text/plain used to reach the handler as an empty body and could never pass
        // signature verification, so the provider retried it to no effect. The route now
        // captures raw bytes, so the signature -- which is over the sorted key/value pairs
        // of the object, not the bytes -- verifies regardless of the declared type.
        const body = {
            payment_id: 987654321,
            order_id: '1',
            payment_status: 'waiting',
            price_amount: 25,
            price_currency: 'usd',
            actually_paid: 0,
            pay_amount: 0.00042
        };
        const signature = createHmac('sha512', secret)
            .update(JSON.stringify(sortKeysDeep(body)))
            .digest('hex');

        for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
            const headers = { 'x-nowpayments-sig': signature };
            if (contentType) headers['Content-Type'] = contentType;
            const response = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });
            // 404 means the body parsed, the signature verified, the payload classified
            // as a payment, and only the deposit lookup came up empty. 401 would mean the
            // signature was rejected, which is the regression this test guards.
            assert.equal(response.status, 404, `unexpected status for content-type ${contentType}`);
        }

        // A body that is not JSON cannot be verified, and must be refused rather than
        // throwing inside the handler.
        const malformed = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'x-nowpayments-sig': signature },
            body: 'not json at all'
        });
        assert.equal(malformed.status, 401);
    } finally {
        pool.connect = originalConnect;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('a deposit receipt is reachable by reference and belongs only to its owner', async () => {
    // A crypto deposit has no provider checkout to return to, so this is the page that
    // answers "where did my money go" and the one the success modal links to.
    const originalQuery = pool.query;
    const priorJwt = process.env.JWT_SECRET;
    const jwtSecret = 'receipt-endpoint-test-secret';
    const ownerId = 5150;
    process.env.JWT_SECRET = jwtSecret;

    const row = {
        id: 91,
        amount: '5000.00000000',
        asset_code: 'XRP',
        currency_code: 'USD',
        network: 'xrp',
        deposit_address: 'rMFtSo6jQ2BggQ3vSVTH1T88BEtmLaw7NN',
        checkout_url: null,
        status: 'pending',
        credited_at: null,
        created_at: '2026-09-27T20:57:29.535Z'
    };
    // Session validation looks the user up, and the deposits query is scoped to that id,
    // so the stub has to serve both -- otherwise "someone else gets 404" would pass for
    // the wrong reason, having never got past authentication.
    pool.query = async (query, params) => {
        if (/FROM users/.test(query)) {
            // Any real account may sign in; only the deposits query is scoped, so the
            // cross-user case exercises the ownership filter rather than authentication.
            return { rows: [{ token_version: 0, is_banned: false }] };
        }
        if (!/FROM deposits/.test(query)) return { rows: [] };
        const owner = params[params.length - 1];
        return { rows: String(owner) === String(ownerId) ? [row] : [] };
    };

    try {
        const headers = { Authorization: `Bearer ${signUserToken(ownerId, jwtSecret)}` };

        const found = await fetch(`${origin}/api/user/deposits/91`, { headers });
        assert.equal(found.status, 200);
        const deposit = await found.json();
        // A crypto deposit has no checkout_url, so the receipt link is what a caller has
        // to follow. It is derived from the id, not from a configured base URL.
        assert.equal(deposit.receipt_url, '/deposit/91');
        assert.equal(deposit.checkout_url, null);
        assert.equal(deposit.status, 'pending');

        // The shell must serve for any numeric id, since the id is only read by the page.
        const page = await fetch(`${origin}/deposit/91`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type') || '', /text\/html/);
        assert.match(await page.text(), /deposit-receipt\.js/);

        // Someone else's deposit must be indistinguishable from one that does not exist,
        // or the endpoint confirms which ids are real.
        const denied = await fetch(`${origin}/api/user/deposits/91`, {
            headers: { Authorization: `Bearer ${signUserToken('99999', jwtSecret)}` }
        });
        assert.equal(denied.status, 404);

        // Unauthenticated, and non-numeric ids.
        assert.equal((await fetch(`${origin}/api/user/deposits/91`)).status, 401);
        assert.equal((await fetch(`${origin}/api/user/deposits/abc`, { headers })).status, 404);
    } finally {
        pool.query = originalQuery;
        if (priorJwt === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorJwt;
    }
});

test('the IPN log records arrivals and refusals so delivery can be told from rejection', async () => {
    // "The provider is not sending the IPN" and "we received it and rejected it" look
    // identical from the balance alone. The log is what separates them, so it has to
    // record both and has to stay free of anything sensitive.
    const ipnLog = require('../src/services/ipnLog');
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const priorCron = process.env.CRON_SECRET;
    const priorEnvironment = process.env.NODE_ENV;
    const originalConnect = pool.connect;
    const secret = 'ipn-diagnostics-secret';
    process.env.NOWPAYMENTS_IPN_SECRET = secret;
    process.env.CRON_SECRET = 'diagnostics-cron-secret';
    ipnLog.reset();

    const client = {
        query: async (query) => {
            const normalized = query.replace(/\s+/g, ' ').trim();
            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
            if (/FROM deposits WHERE id/i.test(normalized)) return { rows: [] };
            return { rows: [] };
        },
        release: () => {}
    };
    pool.connect = async () => client;

    const sign = (body) => createHmac('sha512', secret)
        .update(JSON.stringify(sortKeysDeep(body))).digest('hex');

    try {
        // A body whose signature is wrong must be recorded as a refusal with a reason.
        await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': 'deadbeef' },
            body: JSON.stringify({ payment_id: 5, order_id: '5', payment_status: 'finished' })
        });
        // And a correctly signed one that matches no deposit must be recorded too.
        const good = { payment_id: 6, order_id: '6', payment_status: 'finished', price_amount: 10, price_currency: 'usd' };
        await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': sign(good) },
            body: JSON.stringify(good)
        });

        const diagnostics = await fetch(`${origin}/api/maintenance/ipn-diagnostics?secret=diagnostics-cron-secret`);
        assert.equal(diagnostics.status, 200);
        const report = await diagnostics.json();

        assert.equal(report.callbacks.totals.received, 2);
        assert.ok(report.callbacks.entries.length >= 2, 'arrivals were not recorded');
        // Any arrival counts, including a refusal: a callback that was delivered and
        // turned away is still proof the provider is sending, which is the question this
        // report exists to answer.
        assert.ok(
            typeof report.callbacks.lastReceivedAt === 'string',
            'lastReceivedAt was not set even though callbacks arrived'
        );
        assert.ok(
            report.callbacks.entries.some((entry) => /Signature did not match/.test(entry.detail)),
            'the bad signature was not recorded with a reason'
        );
        assert.ok(
            report.callbacks.entries.some((entry) => /No deposit 6/.test(entry.detail)),
            'the unmatched order was not recorded with a reason'
        );
        // Nothing sensitive may appear in a record that is exposed over HTTP.
        const serialised = JSON.stringify(report.callbacks);
        assert.ok(!serialised.includes(secret), 'the IPN secret leaked into the log');
        assert.ok(!serialised.includes('deadbeef'), 'a signature leaked into the log');

        // A wrong secret must not disclose the endpoint in production, where the secret
        // is the only gate. Outside production the gate is loopback, so this asserts the
        // production contract explicitly.
        process.env.NODE_ENV = 'production';
        const denied = await fetch(`${origin}/api/maintenance/ipn-diagnostics?secret=wrong`);
        assert.equal(denied.status, 404);

        // Outside production the endpoint is reachable from loopback with no secret,
        // which is the whole point of having it at all. NODE_ENV is set explicitly for
        // each half rather than restored from the ambient value in between, because this
        // project's .env sets it to `production` and a run inherits that: restoring it
        // after the production check made this assertion test the production gate while
        // claiming to test the development one.
        process.env.NODE_ENV = 'test';
        const local = await fetch(`${origin}/api/maintenance/ipn-diagnostics`);
        assert.equal(local.status, 200);
        await local.json();

        // The report has to name the most likely cause of "no callbacks arrive".
        assert.equal(report.configuration.ipnSecretConfigured, true);
        assert.equal(
            typeof report.configuration.publiclyReachable,
            'boolean',
            'the report does not say whether providers can reach the app'
        );
    } finally {
        pool.connect = originalConnect;
        ipnLog.reset();
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
        if (priorCron === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = priorCron;
    }
});

test('a callback arriving before the payment id is written adopts it instead of failing', async () => {
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const secret = 'ipn-adopt-race-secret';
    const originalConnect = pool.connect;
    process.env.NOWPAYMENTS_IPN_SECRET = secret;

    const paymentId = 555000111;
    const body = {
        payment_id: paymentId,
        order_id: '77',
        payment_status: 'finished',
        price_amount: 40,
        price_currency: 'usd',
        actually_paid: 0.0007,
        pay_amount: 0.0007
    };
    const signature = createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex');

    // The create-payment request writes provider_payment_id after the provider call
    // returns, but the payment already exists at the provider by then and the IPN is not
    // held back until that write commits. The row therefore reads back as NULL here, and
    // used to be answered 400 for a mismatch that was only a race.
    const statements = [];
    const client = {
        query: async (query, params) => {
            statements.push({ query: query.replace(/\s+/g, ' ').trim(), params });
            if (/^BEGIN/i.test(query)) return { rows: [] };
            if (/^COMMIT/i.test(query) || /^ROLLBACK/i.test(query)) return { rows: [] };
            if (/FROM deposits WHERE id/i.test(query)) {
                // provider_payment_id is still null: the race this test reproduces.
                return { rows: [{ id: 77, user_id: 4242, amount: '40', currency_code: 'USD', status: 'pending', credited_at: null, provider_payment_id: null }] };
            }
            if (/SET provider_payment_id = \$1, updated_at/i.test(query)) {
                return { rows: [{ id: 77 }] };
            }
            if (/INSERT INTO payment_provider_events/i.test(query)) return { rows: [{ id: 'evt-adopt' }] };
            return { rows: [] };
        },
        release: () => {}
    };
    pool.connect = async () => client;

    try {
        const response = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': signature },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 200);

        const adopt = statements.find((s) => /SET provider_payment_id = \$1, updated_at/i.test(s.query));
        assert.ok(adopt, 'the callback did not try to adopt the payment id');
        // Conditional in SQL so a concurrent create-payment write cannot be clobbered.
        assert.match(adopt.query, /WHERE id = \$2 AND provider_payment_id IS NULL/);
        assert.deepEqual(adopt.params, [String(paymentId), 77]);
        assert.ok(
            statements.some((s) => /^COMMIT/i.test(s.query)),
            'the adopted payment id was rolled back instead of committed'
        );
    } finally {
        pool.connect = originalConnect;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('a callback for a deposit already holding a different payment id is still refused', async () => {
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const secret = 'ipn-mismatch-test-secret';
    const originalConnect = pool.connect;
    process.env.NOWPAYMENTS_IPN_SECRET = secret;

    const body = {
        payment_id: 111111,
        order_id: '78',
        payment_status: 'finished',
        price_amount: 40,
        price_currency: 'usd',
        actually_paid: 0.0007,
        pay_amount: 0.0007
    };
    const signature = createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex');

    const statements = [];
    const client = {
        query: async (query) => {
            statements.push(query.replace(/\s+/g, ' ').trim());
            if (/^BEGIN/i.test(query)) return { rows: [] };
            if (/^COMMIT/i.test(query) || /^ROLLBACK/i.test(query)) return { rows: [] };
            if (/FROM deposits WHERE id/i.test(query)) {
                return { rows: [{ id: 78, user_id: 4242, amount: '40', currency_code: 'USD', status: 'pending', credited_at: null, provider_payment_id: '999999' }] };
            }
            return { rows: [] };
        },
        release: () => {}
    };
    pool.connect = async () => client;

    try {
        const response = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': signature },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
        assert.ok(
            !statements.some((q) => /SET provider_payment_id/i.test(q)),
            'a mismatched payment id must never be adopted'
        );
        assert.ok(statements.some((q) => /^ROLLBACK/i.test(q)));
    } finally {
        pool.connect = originalConnect;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('Stripe webhook validates signatures from the untouched raw request body', async () => {
    const priorStripeSecret = process.env.STRIPE_SECRET_KEY;
    const priorStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    const secret = 'whsec_test_signature_secret';
    process.env.STRIPE_SECRET_KEY = 'sk_test_webhook_verification';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const payload = JSON.stringify({
        id: 'evt_test_ignored',
        object: 'event',
        type: 'charge.succeeded',
        data: { object: { id: 'ch_test_ignored' } }
    });
    try {
        const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
        const response = await fetch(`${origin}/api/payments/stripe/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
            body: payload
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Ignored/);
    } finally {
        if (priorStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = priorStripeSecret;
        if (priorStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = priorStripeWebhook;
    }
});

test('NOWPayments deposit addresses persist and signed confirmations credit once', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.JWT_SECRET;
    const priorAppBaseUrl = process.env.APP_BASE_URL;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const priorNowBaseUrl = process.env.NOWPAYMENTS_API_BASE_URL;
    const undici = require('undici');
    const originalFetch = undici.fetch;
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const jwtSecret = 'nowpayments-integration-test-secret';
    const ipnSecret = 'nowpayments-ipn-integration-secret';
    const userId = 777;
    const depositId = 42;
    const providerPaymentId = '987654321';
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = jwtSecret;
    process.env.APP_BASE_URL = origin;
    process.env.NOWPAYMENTS_API_KEY = 'test-api-key';
    process.env.NOWPAYMENTS_IPN_SECRET = ipnSecret;
    process.env.NOWPAYMENTS_API_BASE_URL = 'https://nowpayments.test';
    resetCryptoDepositOptionsCache();

    // An in-memory model of the two rows that matter: the deposit and the balance
    // ledger. It records the single-credit claim so a repeated IPN can be proven not to
    // credit twice without needing a live PostgreSQL instance.
    const storedDeposit = {
        id: depositId,
        user_id: userId,
        amount: '3.00000000',
        provider_payment_id: null,
        deposit_address: null,
        status: 'pending',
        credited_at: null
    };
    let userBalance = 0;
    const ledgerEntries = new Set();
    const seenEventIds = new Set();

    function runStubbedQuery(query, values = []) {
        const normalized = query.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) { return { rows: [] }; }
        if (normalized.startsWith('SELECT token_version')) {
            return { rows: [{ token_version: 0, is_banned: false }] };
        }
        if (/INSERT INTO auth_rate_limits/i.test(normalized)) {
            return { rows: [{ attempt_count: 1, window_started_at: new Date().toISOString() }] };
        }
        if (/SELECT balance, demo_balance FROM users/i.test(normalized)) { return { rows: [{ balance: userBalance.toFixed(2), demo_balance: '0.00' }] }; }
        if (/INSERT INTO deposits/i.test(normalized)) {
        // The initial INSERT creates the pending deposit row:
        // values are [userId, provider, amount, assetCode]
        storedDeposit.status = 'pending';
        return { rows: [{ id: depositId, amount: storedDeposit.amount, status: 'pending' }] };
        }
        if (/SELECT id, user_id, amount, currency_code, status, credited_at, provider_payment_id\s+FROM deposits/i.test(normalized)) {
            return { rows: [{
                id: storedDeposit.id,
                user_id: storedDeposit.user_id,
                amount: storedDeposit.amount,
                currency_code: 'USD',
                status: storedDeposit.status,
                credited_at: storedDeposit.credited_at,
                provider_payment_id: storedDeposit.provider_payment_id
            }] };
        }
        if (/UPDATE deposits SET provider_payment_id = \$1, deposit_address = \$2/i.test(normalized)) {
            storedDeposit.provider_payment_id = String(values[0]);
            storedDeposit.deposit_address = String(values[1]);
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO payment_provider_events/i.test(normalized)) {
            const eventId = `${values[0]}:${values[1]}`;
            if (seenEventIds.has(eventId)) return { rows: [] };
            seenEventIds.add(eventId);
            return { rows: [{ event_id: values[1] }] };
        }
        if (/UPDATE deposits SET status = 'confirmed', credited_at = NOW\(\)/i.test(normalized) || /UPDATE deposits SET credited_at = NOW\(\)/i.test(normalized)) {
            if (storedDeposit.credited_at !== null) return { rows: [] };
            storedDeposit.credited_at = new Date().toISOString();
            storedDeposit.status = 'confirmed';
            return { rows: [{ user_id: storedDeposit.user_id, amount: storedDeposit.amount }] };
        }
        if (normalized.startsWith('UPDATE users SET balance')) {
            userBalance += Number(values[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO balance_transactions/i.test(normalized)) {
            // creditConfirmedDeposit requires the ledger write to actually insert a row:
            // a silent conflict would mean the balance moved with no matching entry.
            if (ledgerEntries.has(`${values[0]}|${values[2]}`)) return { rows: [], rowCount: 0 };
            ledgerEntries.add(`${values[0]}|${values[2]}`);
            return { rows: [{ id: 1 }], rowCount: 1 };
        }
        if (/UPDATE deposits SET status = \$1/i.test(normalized)) {
            storedDeposit.status = String(values[0]);
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected test query: ${normalized}`);
    }

    pool.query = async (query, values) => runStubbedQuery(query, values);
    pool.connect = async () => ({
        query: async (query, values) => runStubbedQuery(query, values),
        release: () => {}
    });

    undici.fetch = async (url, options) => {
        const target = String(url);
        if (target.startsWith(origin)) return originalFetch(url, options);
        assert.equal(options.headers['x-api-key'], 'test-api-key');

        // The pre-flight reads the coins this merchant can accept and the real per-coin
        // minimum, because a flat app minimum is below the provider's floor for most
        // coins and every sub-minimum deposit used to be refused after the user committed.
        if (target === 'https://nowpayments.test/v1/merchant/coins') {
            return new Response(JSON.stringify({ currencies: ['btc', 'usdt', 'doge'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.startsWith('https://nowpayments.test/v1/min-amount')) {
            return new Response(JSON.stringify({ min_amount: 2.5 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        // The fixed-rate window. Only btc is capped, so the test can tell a real per-coin
        // maximum apart from the app-wide fallback: btc must be narrowed, usdt and doge
        // must keep the app ceiling.
        if (target.startsWith('https://nowpayments.test/v1/currencies')) {
            return new Response(JSON.stringify({
                currencies: [
                    { currency_code: 'btc', min_amount: 2.5, max_amount: 900 },
                    { currency_code: 'usdt', min_amount: 2.5, max_amount: 5000 },
                    { currency_code: 'doge', min_amount: 2.5, max_amount: 4000 }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        assert.equal(target, 'https://nowpayments.test/v1/payment');
        const paymentRequest = JSON.parse(options.body);
        assert.equal(paymentRequest.price_amount, 3);
        assert.equal(paymentRequest.pay_currency, 'btc');
        assert.equal(paymentRequest.price_currency, 'usd');
        // The callback must point at THIS deployment, which is exactly the bug that left
        // real deposits pending: a localhost callback URL can never be reached.
        assert.equal(paymentRequest.ipn_callback_url, `${origin}/api/payments/nowpayments/ipn`);
        assert.equal(paymentRequest.order_id, String(depositId));
        return new Response(JSON.stringify({
            payment_id: providerPaymentId,
            pay_address: 'btc-provider-generated-test-address',
            pay_amount: 0.00023,
            pay_currency: 'btc',
            price_currency: 'usd',
            price_amount: 3,
            network: 'bitcoin'
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const authHeaders = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signUserToken(userId, jwtSecret)}`
        };

        // The provider's per-coin window reaches the client, so the amount box can be
        // bounded before the user submits instead of after the payment is refused.
        const optionsResponse = await fetch(`${origin}/api/user/payment-options`, { headers: authHeaders });
        assert.equal(optionsResponse.status, 200);
        const options = await optionsResponse.json();
        assert.deepEqual(options.minimums, { btc: 2.5, usdt: 2.5, doge: 2.5 });
        assert.deepEqual(options.maximums, { btc: 900, usdt: 5000, doge: 4000 });
        // The picker-level maximum is the largest per-coin ceiling, so a low-capped coin
        // does not shrink the box for every other coin.
        assert.equal(options.maximumUsd, 5000);
        assert.equal(options.minimumUsd, 2.5);

        // Above the coin's real ceiling is refused up front, naming the coin, rather than
        // being accepted and then failing at payment creation.
        const aboveCoinMaximum = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ amount: 950, method: 'crypto', currency: 'btc' })
        });
        assert.equal(aboveCoinMaximum.status, 400);
        assert.match((await aboveCoinMaximum.json()).error, /maximum deposit in BTC is \$900\.00/);

        // The ceiling is genuinely per-currency rather than one global number: the same
        // amount is above btc's cap and inside usdt's, and reaches the payment call for
        // the coin that allows it.
        const withinOtherCoinMaximum = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ amount: 950, method: 'crypto', currency: 'usdt' })
        });
        assert.equal(withinOtherCoinMaximum.status, 502);
        // 502, not 400: the request passed validation and failed at the stubbed provider
        // call, which asserts price_amount === 3. Reaching it is the point of the case.
        await withinOtherCoinMaximum.text();

        const createResponse = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ amount: 3, method: 'crypto', currency: 'btc' })
        });
        if (createResponse.status !== 201) {
            throw new Error('Deposit creation failed: ' + (await createResponse.text()));
        }
                const created = await createResponse.json();
        assert.equal(created.payAddress, 'btc-provider-generated-test-address');
        assert.equal(created.payAmount, '0.00023');
        assert.equal(created.assetCode, 'BTC');
        assert.equal(created.network, 'bitcoin');
        // The QR is rendered server-side so the page needs no QR library and no CDN. The
        // URI carries the exact amount, because a bare address leaves the user typing the
        // figure where decimals are easiest to get wrong.
        assert.equal(created.paymentUri, 'bitcoin:btc-provider-generated-test-address?amount=0.00023');
        assert.ok(String(created.qrCodeSvg).startsWith('<svg'), 'no QR was rendered for the deposit address');
        assert.match(String(created.qrCodeSvg), /<\/svg>/);
        // No provider deadline was quoted in the stub, so none is invented for the client.
        assert.equal(created.expiresAt, null);


        assert.equal(storedDeposit.provider_payment_id, providerPaymentId);
        assert.equal(storedDeposit.deposit_address, 'btc-provider-generated-test-address');
        assert.equal(storedDeposit.status, 'pending');

        // The documented payment IPN body, including the nested `fee` object. A shallow
        // key sort signs different bytes than the provider did, so the deep sort this
        // exercises is what makes a callback with a nested value verify at all.
        const notification = {
            payment_id: 987654321,
            parent_payment_id: null,
            invoice_id: null,
            payment_status: 'finished',
            pay_address: 'btc-provider-generated-test-address',
            payin_extra_id: null,
            price_amount: 3,
            price_currency: 'usd',
            pay_amount: 0.00023,
            actually_paid: 0.00023,
            actually_paid_at_fiat: 0,
            pay_currency: 'btc',
            order_id: String(depositId),
            order_description: `RewardZone deposit ${depositId}`,
            purchase_id: '987654321',
            outcome_amount: 0.0002,
            outcome_currency: 'btc',
            payment_extra_ids: null,
            fee: { currency: 'btc', depositFee: 0.00001, withdrawalFee: 0, serviceFee: 0 }
        };
        const signedPayload = JSON.stringify(sortKeysDeep(notification));
        const signature = createHmac('sha512', ipnSecret).update(signedPayload).digest('hex');
        const sendIpn = () => fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': signature },
            body: JSON.stringify(notification)
        });
        const firstIpn = await sendIpn();

        assert.equal(firstIpn.status, 200);
        const repeatIpn = await sendIpn();
        assert.equal(repeatIpn.status, 200);

        const balanceResponse = await fetch(`${origin}/api/user/balance`, {
            headers: { Authorization: `Bearer ${signUserToken(userId, jwtSecret)}` }
        });
        assert.equal(balanceResponse.status, 200);
        assert.equal((await balanceResponse.json()).balance, '3.00');
        assert.equal(userBalance, 3);
        assert.equal(storedDeposit.status, 'confirmed');
        assert.equal(ledgerEntries.size, 1);
        assert.ok(ledgerEntries.has(`${userId}|nowpayments:${providerPaymentId}`));
    } finally {
        undici.fetch = originalFetch;
        pool.query = originalQuery;
        pool.connect = originalConnect;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = priorAppBaseUrl;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
        if (priorNowBaseUrl === undefined) delete process.env.NOWPAYMENTS_API_BASE_URL;
        else process.env.NOWPAYMENTS_API_BASE_URL = priorNowBaseUrl;
    }
});

test('deposit amounts a user would type are accepted, sub-cent precision is not', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.JWT_SECRET;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const undici = require('undici');
    const originalFetch = undici.fetch;
    const originalQuery = pool.query;
    const jwtSecret = 'deposit-amount-test-secret';
    const userId = 5150;
    const accepted = [];

    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = jwtSecret;
    process.env.NOWPAYMENTS_API_KEY = 'test-api-key';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
    delete process.env.APP_BASE_URL;
    // The provider answer is cached per credential set for a few minutes. A previous test
    // in this same process may have cached a different account's coins and minimums, so
    // it is dropped rather than leaking into this one's expectations.
    resetCryptoDepositOptionsCache();

    pool.query = async (query) => {
        if (query.includes('SELECT token_version')) return { rows: [{ token_version: 0, is_banned: false }] };
        if (/INSERT INTO auth_rate_limits/i.test(query)) {
            return { rows: [{ attempt_count: 1, window_started_at: new Date().toISOString() }] };
        }
        if (/INSERT INTO deposits/i.test(query)) return { rows: [{ id: 1, amount: '1.10' }] };
        if (/UPDATE deposits SET provider_payment_id = \$1, deposit_address = \$2/i.test(query)) {
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected test query: ${query}`);
    };

    // Every one of these is a plain decimal a user can type. `Math.round(1.1 * 100)`
    // is 110.00000000000001, so the previous `Math.round(x*100) !== x*100` check
     // rejected several of them with a misleading "between $1 and $5,000" error.
    undici.fetch = async (url, options) => {
        // The test's own requests to the app must still reach the real server.
        const target = String(url);
        if (target.startsWith(origin)) return originalFetch(url, options);
        if (target === 'https://api.nowpayments.io/v1/merchant/coins') {
            return new Response(JSON.stringify({ currencies: ['btc'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.startsWith('https://api.nowpayments.io/v1/min-amount')) {
            // Reported as the app's own $1 floor, so this test keeps exercising amount
            // parsing rather than the provider's minimum.
            return new Response(JSON.stringify({ min_amount: 1 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        assert.equal(target, 'https://api.nowpayments.io/v1/payment');
        return new Response(JSON.stringify({
            payment_id: '555', pay_address: 'addr', pay_amount: 0.0001, pay_currency: 'btc'
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signUserToken(userId, jwtSecret)}`
    };

    try {
        for (const amount of [1.1, 1.15, 2.29, 0.99, 1.005, 'abc', 5000.01, 0]) {
            const response = await fetch(`${origin}/api/user/deposits`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ amount, method: 'crypto', currency: 'btc' })
            });
            const label = `${amount}`;
            if (response.status === 201) {
                accepted.push(label);
            } else {
                assert.equal(response.status, 400, `expected ${label} to be rejected, got ${response.status}`);
            }
        }
        assert.deepEqual(accepted, ['1.1', '1.15', '2.29']);
     } finally {
        undici.fetch = originalFetch;
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('a non-finished NOWPayments status never credits, and a malformed signature is rejected', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.JWT_SECRET;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const ipnSecret = 'nowpayments-status-test-secret';
    const depositId = 61;
    const providerPaymentId = '5150';

    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'status-test-secret';
    process.env.NOWPAYMENTS_IPN_SECRET = ipnSecret;

    let balance = 0;
    let depositStatus = 'pending';
    const ledger = [];
    // A payout batch this test recognises, so a `FINISHED` callback can be shown to move a
    // withdrawal to `paid`. Null means "no such batch", which is the state every other payout
    // callback in this test is in.
    let knownBatch = null;

    function runStubbedQuery(query, values = []) {
        const normalized = query.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
        if (/SELECT id, user_id, amount, currency_code, status, credited_at, provider_payment_id\s+FROM deposits/i.test(normalized)) {
            return { rows: [{
                id: depositId, user_id: 1, amount: '25.00', currency_code: 'USD',
                status: depositStatus, credited_at: null, provider_payment_id: providerPaymentId
            }] };
        }
        if (/INSERT INTO payment_provider_events/i.test(normalized)) return { rows: [{ id: 1 }] };
        if (/UPDATE deposits SET status = 'confirmed', credited_at = NOW\(\)/i.test(normalized)) {
            return { rows: [{ user_id: 1, amount: '25.00' }] };
        }
        if (/UPDATE deposits SET status = \$1/i.test(normalized)) {
            depositStatus = String(values[0]);
            return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith('UPDATE users SET balance')) {
            balance += Number(values[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO balance_transactions/i.test(normalized)) {
            ledger.push(`${values[0]}|${values[2]}`);
            return { rows: [{ id: 1 }], rowCount: 1 };
        }
        // A payout callback is looked up by the batch id the provider sent. No row matches,
        // which is the case most of this test exercises: a correctly signed callback about a
        // batch this database has no record of must be acknowledged and must change nothing.
        // `knownBatch` is set later to make one of them match, so that a finished payout for a
        // batch we do know can be shown to actually move the withdrawal.
        if (/SELECT id, status, payout_status FROM withdrawals WHERE batch_id/i.test(normalized)) {
            return { rows: knownBatch ? [knownBatch] : [] };
        }
        if (/UPDATE withdrawals SET status = 'paid', provider_reference = \$1/i.test(normalized)) {
            if (knownBatch) knownBatch.status = 'paid';
            return { rows: [{ id: knownBatch?.id, user_id: 1, amount: '25.00', status: 'paid' }], rowCount: 1 };
        }
        if (/SELECT u\.email[\s\S]*FROM withdrawals w/i.test(normalized)) {
            return { rows: [{ email: 'payout@example.com' }] };
        }
        throw new Error(`Unexpected test query: ${normalized}`);
    }

    pool.query = async (query, values) => runStubbedQuery(query, values);
    pool.connect = async () => ({
        query: async (query, values) => runStubbedQuery(query, values),
        release: () => {}
    });

    const sendIpn = (paymentStatus, signature, overrides = {}) => {
        const notification = {
            payment_id: Number(providerPaymentId),
            order_id: String(depositId),
            payment_status: paymentStatus,
            price_amount: 25,
            price_currency: 'usd',
            pay_currency: 'btc',
            pay_amount: 0.0003,
            actually_paid: 0.0003,
            updated_at: `2026-09-27T00:0${paymentStatus === 'finished' ? 9 : 0}:00.000Z`,
            ...overrides
        };
        const signed = signature || createHmac('sha512', ipnSecret)
            .update(JSON.stringify(sortKeysDeep(notification)))
            .digest('hex');
        return fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': signed },
            body: JSON.stringify(notification)
        });
    };

    try {
        // `Buffer.from(value, 'hex')` silently drops non-hex characters instead of
        // throwing, so the old try/catch could never reject this. It must be refused.
        const malformed = await sendIpn('finished', 'z'.repeat(128));
        assert.equal(malformed.status, 401);

        // Funds received but not finished: the deposit is recorded as in progress and
        // the balance is untouched. This is the state the reconciler used to credit.
        const confirming = await sendIpn('confirmed');
        assert.equal(confirming.status, 200);
        assert.equal(depositStatus, 'confirming');
        assert.equal(balance, 0);
        assert.equal(ledger.length, 0);

        const sending = await sendIpn('sending');
        assert.equal(sending.status, 200);
        assert.equal(depositStatus, 'confirming');
        assert.equal(balance, 0);

        // `finished` is the terminal state, but the credit rests on the money arriving.
        // A finished payment whose `actually_paid` falls short of the amount the customer
        // was quoted must not be turned into a balance, so this is refused outright
        // instead of being applied.
        const underpaid = await sendIpn('finished', undefined, { actually_paid: 0.0001 });
        assert.equal(underpaid.status, 200);
        assert.equal(balance, 0);
        assert.equal(ledger.length, 0);

        // A provider record that omits `actually_paid` entirely cannot establish that
        // anything was received, so it is not treated as a confirmation either.
        const unreported = await sendIpn('finished', undefined, { actually_paid: undefined });
        assert.equal(unreported.status, 200);
        assert.equal(balance, 0);
        assert.equal(ledger.length, 0);

        const finished = await sendIpn('finished');
        assert.equal(finished.status, 200);
        assert.equal(depositStatus, 'confirming');
        assert.equal(balance, 25);
        assert.deepEqual(ledger, [`1|nowpayments:${providerPaymentId}`]);

        // A payout callback shares this URL and posts a completely different body: no
        // `payment_id`, no `order_id`, and a `status` from the separate uppercase payout
        // vocabulary. It must be acknowledged, because a 4xx is a failed delivery the
        // provider would keep retrying.
        //
        // This one is also an unknown batch, which is the only assertion available without a
        // submitted payout on file: a signed callback naming a batch this database has never
        // seen is recorded and applied to nothing. Crediting or refunding on the strength of
        // an id that matches no row would be inventing a financial outcome.
        const payoutBody = {
            id: '777',
            batch_withdrawal_id: '888',
            status: 'CREATING',
            error: null,
            currency: 'usdttrc20',
            amount: '50',
            address: 'TXYZ',
            fee: null,
            extra_id: null,
            hash: null,
            ipn_callback_url: `${origin}/api/payments/nowpayments/ipn`,
            created_at: '2026-09-27T15:29:40.803Z',
            requested_at: null,
            updated_at: null
        };
        const payoutSignature = createHmac('sha512', ipnSecret)
            .update(JSON.stringify(sortKeysDeep(payoutBody)))
            .digest('hex');
        const payout = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': payoutSignature },
            body: JSON.stringify(payoutBody)
        });
        assert.equal(payout.status, 200);
        assert.equal(balance, 25);

        // The same callback, but for a batch this database does know about and reports as
        // finished. This is the one that matters: it is the only event that tells a user their
        // crypto actually left, so it has to move the withdrawal to `paid` and record the
        // batch as its reference.
        //
        // The batch lookup is made to match this time, and the payout vocabulary is used
        // rather than the deposit's own -- `FINISHED` here means sent, which is the collision
        // that `classifyIpnBody` exists to prevent.
        knownBatch = { id: 31, status: 'processing', payout_status: 'PROCESSING' };
        const finishedBody = { ...payoutBody, batch_withdrawal_id: '999', status: 'FINISHED' };
        const finishedSignature = createHmac('sha512', ipnSecret)
            .update(JSON.stringify(sortKeysDeep(finishedBody)))
            .digest('hex');
        const finishedPayout = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': finishedSignature },
            body: JSON.stringify(finishedBody)
        });
        assert.equal(finishedPayout.status, 200);
        assert.equal(knownBatch.status, 'paid');
        // A finished payout is the user's money leaving, not arriving: the balance is
        // untouched by the callback, because it was debited when the request was made.
        assert.equal(balance, 25);
    } finally {

        pool.query = originalQuery;
        pool.connect = originalConnect;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
    }
});

test('deposit options come from the merchant coin list and the provider minimums', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.JWT_SECRET;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const priorNowIpn = process.env.NOWPAYMENTS_IPN_SECRET;
    const priorBaseUrl = process.env.APP_BASE_URL;
    const undici = require('undici');
    const originalFetch = undici.fetch;
    const originalQuery = pool.query;
    const jwtSecret = 'provider-options-test-secret';
    const userId = 4242;
    const requestedPaths = [];

    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = jwtSecret;
    process.env.NOWPAYMENTS_API_KEY = 'test-api-key';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
    process.env.APP_BASE_URL = 'https://app.example.test';
    resetCryptoDepositOptionsCache();

    pool.query = async (query) => {
        if (query.includes('SELECT token_version')) return { rows: [{ token_version: 0, is_banned: false }] };
        // The per-IP deposit limiter records every attempt, and an unstubbed write here
        // surfaces as a 503 from the limiter rather than as the response under test.
        if (/INSERT INTO auth_rate_limits/i.test(query)) {
            return { rows: [{ attempt_count: 1, window_started_at: new Date().toISOString() }] };
        }
        if (/INSERT INTO deposits/i.test(query)) return { rows: [{ id: 1 }] };
        // The app closes out a deposit the provider refused, so this write is expected on the
        // below-the-provider-floor case. Unstubbed it surfaces as a thrown error and the
        // response becomes a 502, which hides the behaviour under test.
        if (/UPDATE deposits SET status = 'failed'/i.test(query)) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected test query: ${query}`);
    };

    undici.fetch = async (url, options) => {
        const target = String(url);
        if (target.startsWith(origin)) return originalFetch(url, options);
        requestedPaths.push(target);
        if (target.includes('/v1/merchant/coins')) {
            // The provider answers this endpoint with `selectedCurrencies`, not
            // `currencies`. Reading the wrong field found nothing here and fell through to
            // the global list, so the merchant's actual configuration was never consulted.
            return new Response(JSON.stringify({ selectedCurrencies: ['BTC', 'USDT', 'DOGE', 'ZZZ'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.includes('/v1/min-amount')) {
            const coin = new URL(target).searchParams.get('currency_to');
            const floors = { btc: 18.8, usdt: 5, doge: 2.5 };
            // Both fields, because the real provider returns both when `fiat_equivalent` is
            // requested, and they mean different things: `min_amount` is in the coin, the
            // `fiat_equivalent` is the same figure in dollars.
            //
            // The stub used to return `min_amount` alone at the fiat value, which is precisely
            // the reading `getMinimumAmount` refuses to make -- 18.8 BTC is not $18.80. The
            // code then converted through `/v1/estimate` (unstubbed, so the call blew up) and
            // the deposit was attempted instead of refused. The coin figure here is
            // deliberately small, so a regression that trusts `min_amount` as dollars would
            // make the floor $0.0003 and quietly let this same $5 deposit through.
            const coinAmounts = { btc: 0.0002, usdt: 4.9, doge: 35 };
            return new Response(JSON.stringify({
                fiat_equivalent: floors[coin] ?? 1,
                min_amount: coinAmounts[coin] ?? 0.5
            }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.includes('/v1/currencies')) {
            // Only btc is capped low. The other two must keep the app-wide ceiling, so a
            // per-coin maximum cannot be confused with a global one.
            return new Response(JSON.stringify({
                currencies: [
                    { currency_code: 'btc', min_amount: 18.8, max_amount: 900 },
                    { currency_code: 'usdt', min_amount: 5, max_amount: 5000 },
                    { currency_code: 'doge', min_amount: 2.5, max_amount: 5000 }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (target.includes('/v1/payment')) {
            // The app deliberately does not block on a cached provider floor, so this request
            // is made and the provider refuses it. NOWPayments words its refusals with the real
            // number in real units, and the app passes those words back untouched.
            return new Response(JSON.stringify({
                error: { code: 'FAILURE', message: 'Minimum amount is 0.0002 BTC, you have 0.000062' }
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected provider call: ${target}`);
    };

    const headers = { Authorization: `Bearer ${signUserToken(userId, jwtSecret)}` };

    try {
        const response = await fetch(`${origin}/api/user/payment-options`, { headers });
        assert.equal(response.status, 200);
        const options = await response.json();

        assert.equal(options.cryptoAvailable, true);
        // The merchant list intersected with the reviewed set. A coin the provider reports
        // but this build has not reviewed is not offered, and one it does not report is
        // never offered even if it is in the reviewed set.
        assert.deepEqual([...options.cryptoCurrencies].sort(), ['btc', 'doge', 'usdt']);

        // The app's own limits are reported separately from the provider's, because they do
        // different jobs: these two bound the amount box, and they are what the advertised
        // "$1.00 minimum" is enforced from on the client. Folding the provider's volatile
        // per-coin floor into the box's minimum is what made a $1 deposit unsubmittable on
        // every coin NOWPayments charges $18 to.
        assert.equal(options.appMinimumUsd, 1);
        assert.equal(options.appMaximumUsd, 5000);

        // The picker floor is the smallest per-currency minimum, and each currency carries
        // its own. The app's own $1 floor still wins where the provider quotes less.
        assert.equal(options.minimumUsd, 2.5);
        assert.equal(options.minimums.btc, 18.8);
        assert.equal(options.minimums.usdt, 5);
        assert.equal(options.minimums.doge, 2.5);

        // The provider's real ceiling is per-coin. btc is capped low, so it must narrow,
        // while the others keep the app-wide $5,000 ceiling.
        assert.deepEqual(options.maximums, { btc: 900, usdt: 5000, doge: 5000 });
        // The picker ceiling is the largest of them, so a capped coin does not shrink the
        // amount box for every other coin.
        assert.equal(options.maximumUsd, 5000);

        // The merchant list is the only source of the coin list. The global list is still
        // not consulted for that -- but it *is* called once for the fixed-rate amount
        // window, which is a different question, so the two are counted separately.
        const fixedRateLimitsCalls = requestedPaths.filter((p) => p.includes('/v1/currencies') && p.includes('fixed_rate=true'));
        assert.equal(fixedRateLimitsCalls.length, 1);
        assert.equal(
            requestedPaths.filter((p) => p.includes('/v1/currencies') && !p.includes('fixed_rate=true')).length,
            0,
            'the global currency list was used as the coin list instead of the merchant list'
        );
        assert.equal(requestedPaths.filter((p) => p.includes('/v1/merchant/coins')).length, 1);

        // Above a coin's real ceiling is refused up front, naming the coin, rather than
        // being accepted by the app and then refused by the provider at payment creation.
        const aboveCoinCeiling = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 950, method: 'crypto', currency: 'btc' })
        });
        assert.equal(aboveCoinCeiling.status, 400);
        assert.match((await aboveCoinCeiling.json()).error, /maximum deposit in BTC is \$900\.00/);

        // A deposit the provider's own floor rules out is NOT blocked by the app. The app
        // advertises a $1.00 minimum and honours it; the provider's floor is a volatile,
        // pair-specific figure, and refusing on a cached read of it meant the advertised $1
        // was unsubmittable for a whole class of coins. Instead the request reaches
        // `createPayment`, the provider refuses, and its own words come back -- which is the
        // only thing that tells the user the number that will actually work.
        //
        // This is the opposite of what this assertion used to require, and deliberately so: it
        // previously expected the app to refuse the amount itself against its cached floor.
        const belowProviderFloor = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 5, method: 'crypto', currency: 'btc' })
        });
        assert.equal(
            belowProviderFloor.status,
            400,
            `expected the provider's refusal to pass through as 400, got ${belowProviderFloor.status}: ` +
            `${JSON.stringify(await belowProviderFloor.clone().text())}. Provider paths: ${requestedPaths.join(' | ')}`
        );
        // The provider's own message, not a generic one. This is the whole point of letting the
        // provider answer: it names the real floor in real units.
        const floorRefusal = (await belowProviderFloor.json()).error;
        assert.match(floorRefusal, /Minimum amount is 0\.0002 BTC/i);
        // And the app did reach the provider, rather than deciding on its own.
        assert.ok(
            requestedPaths.some((path) => path.includes('/v1/payment')),
            'the app refused the amount itself instead of asking the provider'
        );

        // A coin the provider does not offer is refused before any deposit row is written.
        const unlisted = await fetch(`${origin}/api/user/deposits`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50, method: 'crypto', currency: 'ada' })
        });
        assert.equal(unlisted.status, 400);
        assert.match((await unlisted.json()).error, /supported cryptocurrency/);
    } finally {
        undici.fetch = originalFetch;
        pool.query = originalQuery;
        resetCryptoDepositOptionsCache();
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
        if (priorNowIpn === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
        else process.env.NOWPAYMENTS_IPN_SECRET = priorNowIpn;
        if (priorBaseUrl === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = priorBaseUrl;
    }
});

test('reconciliation credits a card deposit whose Stripe webhook was lost', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorStripeSecret = process.env.STRIPE_SECRET_KEY;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const depositId = 88;
    const sessionId = 'cs_test_lost_webhook';
    const silentLogger = { log: () => {}, error: () => {} };

    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_reconcile';
    delete process.env.NOWPAYMENTS_API_KEY;

    let balance = 0;
    let depositStatus = 'pending';
    let creditedAt = null;
    const ledger = [];
    let orphanCleanupRan = false;

    function runStubbedQuery(query, values = []) {
        const normalized = query.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
        if (/FROM deposits\s+WHERE provider = ANY/i.test(normalized)) {
            return { rows: [{
                id: depositId, user_id: 9, amount: '40.00', provider: 'stripe',
                provider_payment_id: sessionId, status: 'pending'
            }] };
        }
        if (/UPDATE deposits SET status = 'confirmed', credited_at = NOW\(\)/i.test(normalized)) {
            if (creditedAt !== null) return { rows: [] };
            creditedAt = new Date().toISOString();
            depositStatus = 'confirmed';
            return { rows: [{ user_id: 9, amount: '40.00' }] };
        }
        if (/UPDATE deposits SET status = \$1/i.test(normalized)) {
            depositStatus = String(values[0]);
            return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith('UPDATE users SET balance')) {
            balance += Number(values[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO balance_transactions/i.test(normalized)) {
            ledger.push(`${values[0]}|${values[2]}`);
            return { rows: [{ id: 1 }], rowCount: 1 };
        }
        if (/provider_payment_id IS NULL/i.test(normalized)) {
            orphanCleanupRan = true;
            return { rows: [] };
        }
        throw new Error(`Unexpected test query: ${normalized}`);
    }

    pool.query = async (query, values) => runStubbedQuery(query, values);
    pool.connect = async () => ({
        query: async (query, values) => runStubbedQuery(query, values),
        release: () => {}
    });

    const stripeClient = {
        checkout: {
            sessions: {
                retrieve: async (requestedId) => {
                    assert.equal(requestedId, sessionId);
                    return { id: sessionId, status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 4000 };
                }
            }
        }
    };

    try {
        const summary = await reconcilePendingDeposits({ stripeClient, logger: silentLogger });
        // Card deposits were excluded from reconciliation entirely, so a lost
        // checkout.session.completed left a paid deposit pending forever.
        assert.equal(summary.checked, 1);
        assert.equal(summary.credited, 1);
        assert.equal(balance, 40);
        assert.equal(depositStatus, 'confirmed');
        assert.deepEqual(ledger, [`9|stripe:${sessionId}`]);
        assert.equal(orphanCleanupRan, true);

        // Running again must not credit a second time.
        creditedAt = null;
        balance = 0;
        ledger.length = 0;
        const second = await reconcilePendingDeposits({ stripeClient, logger: silentLogger });
        assert.equal(second.credited, 1);
        assert.equal(balance, 40);
        assert.equal(ledger.length, 1);
    } finally {
        pool.query = originalQuery;
        pool.connect = originalConnect;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = priorStripeSecret;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
    }
});

test('a ledger conflict aborts the credit instead of moving the balance alone', async () => {
    const client = {
        query: async (query) => {
            const normalized = query.replace(/\s+/g, ' ').trim();
            if (/UPDATE deposits SET status = 'confirmed'/i.test(normalized)) {
                return { rows: [{ user_id: 3, amount: '10.00' }] };
            }
            if (normalized.startsWith('UPDATE users SET balance')) {
                return { rows: [], rowCount: 1 };
            }
            // The ledger row already exists: the claim succeeded but the deposit was
            // already counted, so the credit must be refused rather than doubled.
            if (/INSERT INTO balance_transactions/i.test(normalized)) {
                return { rows: [], rowCount: 0 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        }
    };

    await assert.rejects(
        () => creditConfirmedDeposit(client, { id: 5, ledger_source_id: 'stripe:cs_conflict' }, 'test'),
        /conflicts with an existing ledger entry/
    );
});

test('a missing user row aborts the credit rather than losing the deposit', async () => {
    const client = {
        query: async (query) => {
            const normalized = query.replace(/\s+/g, ' ').trim();
            if (/UPDATE deposits SET status = 'confirmed'/i.test(normalized)) {
                return { rows: [{ user_id: 3, amount: '10.00' }] };
            }
            if (normalized.startsWith('UPDATE users SET balance')) {
                return { rows: [], rowCount: 0 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        }
    };

    await assert.rejects(
        () => creditConfirmedDeposit(client, { id: 5, ledger_source_id: 'stripe:cs_missing_user' }, 'test'),
        /could not be credited/
    );
});

test('an already-claimed deposit is not credited again', async () => {
    const client = {
        query: async (query) => {
            if (/UPDATE deposits SET status = 'confirmed'/i.test(query.replace(/\s+/g, ' '))) {
                return { rows: [] };
            }
            throw new Error(`Unexpected query: ${query}`);
        }
    };

    const result = await creditConfirmedDeposit(client, { id: 5, ledger_source_id: 'stripe:cs_done' }, 'test');
    assert.deepEqual(result, { credited: false, amount: null });
});

test('the scheduled reconciliation endpoint distinguishes misconfiguration from a wrong secret', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.CRON_SECRET;
    const priorNowApi = process.env.NOWPAYMENTS_API_KEY;
    const priorStripe = process.env.STRIPE_SECRET_KEY;
    const originalQuery = pool.query;
    const secret = 'cron-secret-for-the-test-suite';
    const route = '/api/maintenance/reconcile-deposits';

    process.env.NODE_ENV = 'test';
    // No payment providers, so reconciliation short-circuits without touching the
    // database. That is exactly the "nothing to do" case a fresh deployment hits.
    delete process.env.NOWPAYMENTS_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    pool.query = async () => ({ rows: [] });

    try {
        // A missing CRON_SECRET is not a problem outside production: these endpoints are
        // reachable from loopback without a secret precisely so an operator on a machine
        // that has none configured can still reconcile a stuck deposit and read the
        // callback log. The production behaviour -- 503 naming the variable -- is asserted
        // below under an explicit production environment.
        delete process.env.CRON_SECRET;
        const unconfigured = await fetch(`${origin}${route}`);
        assert.equal(unconfigured.status, 200);
        await unconfigured.json();

        process.env.CRON_SECRET = secret;

        // The correct bearer token is what Vercel Cron sends.
        const authorized = await fetch(`${origin}${route}`, {
            headers: { Authorization: `Bearer ${secret}` }
        });
        assert.equal(authorized.status, 200);
        const authorizedBody = await authorized.json();
        assert.equal(authorizedBody.ok, true);
        assert.deepEqual(Object.keys(authorizedBody.summary).sort(),
            ['checked', 'credited', 'failed', 'note', 'providers', 'skipped', 'unchanged']);
        assert.match(authorizedBody.summary.note, /nothing to reconcile/);

        // A wrong secret must stay undiscoverable, and must not be distinguishable
        // from any other unknown path. This is the *production* contract, so the
        // environment is set explicitly: outside production these endpoints are reachable
        // from loopback without a secret at all, which is what makes them usable for
        // manual operator work on a machine with no CRON_SECRET configured.
        process.env.NODE_ENV = 'production';
        for (const headers of [
            { Authorization: 'Bearer wrong-secret' },
            { Authorization: `Bearer ${secret.slice(0, -1)}x` },
            {}
        ]) {
            const rejected = await fetch(`${origin}${route}`, { headers });
            assert.equal(rejected.status, 404, `expected 404 for ${JSON.stringify(headers)}`);
        }
        const unknown = await fetch(`${origin}/api/maintenance/not-a-thing`);
        assert.equal(unknown.status, 404);

        // And in production a missing secret is still a 503 naming the variable, rather
        // than the 404 that made the route look nonexistent.
        delete process.env.CRON_SECRET;
        const unconfiguredInProduction = await fetch(`${origin}${route}`);
        assert.equal(unconfiguredInProduction.status, 503);
        assert.match((await unconfiguredInProduction.json()).detail, /CRON_SECRET/);

        process.env.NODE_ENV = 'test';
        process.env.CRON_SECRET = secret;

        // POST and the alternate carriers exist so the job can be triggered by hand.
        for (const options of [
            { method: 'POST', headers: { Authorization: `Bearer ${secret}` } },
            { headers: { 'x-cron-secret': secret } },
            { headers: {} }
        ]) {
            if (!options.headers) options.headers = {};
            if (!options.method) options.url = `${route}?secret=${encodeURIComponent(secret)}`;
            const { url = route, ...rest } = options;
            const response = await fetch(`${origin}${url}`, rest);
            assert.equal(response.status, 200, `expected 200 for ${JSON.stringify(options)}`);
        }

        // Outside production the endpoints answer from loopback with no secret at all.
        // This is the behaviour that makes them usable: requiring a secret that is
        // deliberately unset produced an undiscoverable 404 for what is fundamentally a
        // local operator task, and a stuck deposit then looked like a provider fault.
        delete process.env.CRON_SECRET;
        const localWithoutSecret = await fetch(`${origin}${route}`);
        assert.equal(localWithoutSecret.status, 200);
        await localWithoutSecret.json();
        const localDiagnostics = await fetch(`${origin}/api/maintenance/ipn-diagnostics`);
        assert.equal(localDiagnostics.status, 200);
        assert.equal((await localDiagnostics.json()).ok, true);
    } finally {
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = priorSecret;
        if (priorNowApi === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorNowApi;
        if (priorStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = priorStripe;
    }
});

test('engage route requires an aff_sub click ID instead of serving the offers page', async () => {
    const response = await fetch(`${origin}/offer/engage`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /aff_sub click ID is required/);
});

test('click creation returns the configured absolute aff_sub URL and redirects to the advertiser', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorProxyKey = process.env.PROXYCHECK_KEY;
    const priorJwtSecret = process.env.JWT_SECRET;
    const priorAppBaseUrl = process.env.APP_BASE_URL;
    const jwtSecret = 'click-flow-test-secret';
    const originalQuery = pool.query;
    let createdClickId;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = jwtSecret;
    delete process.env.APP_BASE_URL;
    delete process.env.PROXYCHECK_KEY;

    pool.query = async (query, values) => {
        if (query.includes('SELECT token_version')) return { rows: [{ token_version: 0, is_banned: false }] };
        if (query.includes('SELECT COUNT(*)')) return { rows: [{ count: '0' }] };
        // Matched on the columns rather than the whole statement. The offer lookup also
        // reads `is_demo` now, so a stub keyed on the exact old SELECT text silently
        // stopped matching and turned this into a 500 with no explanation of why.
        if (/SELECT tracking_url.*FROM offers/i.test(query)) {
            return { rows: [{ tracking_url: 'https://partner.example/click?campaign=42', is_demo: false }] };
        }
        if (query.includes('INSERT INTO clicks')) {
            createdClickId = values[0];
            return { rows: [] };
        }
        if (query.includes('SELECT offers.tracking_url')) {
            return { rows: [{ tracking_url: 'https://partner.example/click?campaign=42', is_demo: false }] };
        }
        throw new Error(`Unexpected test query: ${query}`);
    };

    try {
        const createResponse = await fetch(`${origin}/api/click/offer-1`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${signUserToken(1, jwtSecret)}`
            },
            body: '{}'
        });
        assert.equal(createResponse.status, 200);
        const clickResult = await createResponse.json();
        const engageUrl = new URL(clickResult.redirectUrl, origin);
        // The development fallback is derived from PORT, so assert the host rather than
        // a hard-coded port that only matched when nothing else was configured.
        assert.equal(engageUrl.hostname, 'localhost');
        assert.match(engageUrl.port, /^\d+$/);
        assert.equal(engageUrl.pathname, '/offer/engage');
        assert.equal(engageUrl.searchParams.get('aff_sub'), createdClickId);

        const engageRequestUrl = new URL(`${engageUrl.pathname}${engageUrl.search}`, origin);
        const engageResponse = await fetch(engageRequestUrl, { redirect: 'manual' });
        assert.equal(engageResponse.status, 302);
        const advertiserUrl = new URL(engageResponse.headers.get('location'));
        assert.equal(advertiserUrl.origin, 'https://partner.example');
        assert.equal(advertiserUrl.searchParams.get('aff_sub'), createdClickId);
        assert.equal(advertiserUrl.searchParams.get('campaign'), '42');
    } finally {
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorProxyKey === undefined) delete process.env.PROXYCHECK_KEY;
        else process.env.PROXYCHECK_KEY = priorProxyKey;
        if (priorJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorJwtSecret;
        if (priorAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = priorAppBaseUrl;
    }
});

test('balance requires a verified token and rejects the former test token', async () => {
    const priorSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'unit-test-secret';
    try {
        const missingToken = await fetch(`${origin}/api/user/balance`);
        const formerTestToken = await fetch(`${origin}/api/user/balance`, {
            headers: { Authorization: 'Bearer test-token-123' }
        });
        assert.equal(missingToken.status, 401);
        assert.equal(formerTestToken.status, 401);
    } finally {
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
    }
});

test('registration, login, and balance persist against PostgreSQL', { skip: liveTestUrl ? false : 'Set TEST_DATABASE_URL to a disposable database to run live integration tests.' }, async () => {
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorEnvironment = process.env.NODE_ENV;
    const priorProxyKey = process.env.PROXYCHECK_KEY;
    const priorSecret = process.env.JWT_SECRET;
    const priorAppBaseUrl = process.env.APP_BASE_URL;
    const jwtSecret = 'account-flow-test-secret';
    const email = `copilot-${randomUUID()}@example.invalid`;
    let userId;
    let clickId;
    let surveyClickId;
    // Point the pool at the disposable test database for this test only.
    process.env.DATABASE_URL = liveTestUrl;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = jwtSecret;
    process.env.APP_BASE_URL = origin;
    delete process.env.PROXYCHECK_KEY;
    try {
        const registration = await registerOrExplain(origin, email, 'sample-test-password-42');
        assert.equal(registration.status, 201);
        const registered = await registration.json();
        userId = registered.user.id;
        assert.ok(registered.token);
        await pool.query('UPDATE users SET balance = 20 WHERE id = $1', [userId]);

        const balance = await fetch(`${origin}/api/user/balance`, {
            headers: { Authorization: `Bearer ${registered.token}` }
        });
        assert.equal(balance.status, 200);
        assert.equal((await balance.json()).balance, '20.00');

        const demoOffer = await pool.query(
            'SELECT id FROM offers WHERE is_demo IS TRUE ORDER BY id LIMIT 1'
        );
        assert.ok(demoOffer.rows.length > 0);
        const clickResponse = await fetch(`${origin}/api/click/${demoOffer.rows[0].id}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: '{}'
        });
        assert.equal(clickResponse.status, 200);
        const click = await clickResponse.json();
        const engageUrl = new URL(click.redirectUrl, origin);
        clickId = engageUrl.searchParams.get('aff_sub');
        assert.equal(engageUrl.pathname, '/offer/engage');
        const savedClick = await pool.query(
            'SELECT user_id FROM clicks WHERE click_id = $1',
            [clickId]
        );
        assert.equal(savedClick.rows[0].user_id, userId);
        const engaged = await fetch(engageUrl, { redirect: 'manual' });
        assert.equal(engaged.status, 302);
        const demoUrl = new URL(engaged.headers.get('location'));
        assert.equal(demoUrl.origin, origin);
        assert.equal(demoUrl.pathname, '/demo');
        assert.equal(demoUrl.searchParams.get('click_id'), clickId);
        const demoPage = await fetch(demoUrl);
        assert.equal(demoPage.status, 200);

        const completion = await fetch(`${origin}/api/demo/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: JSON.stringify({ clickId, answers: { completed: true } })
        });
        assert.equal(completion.status, 200);
        const reward = await completion.json();
        assert.equal(Number(reward.credited), 1);
        assert.equal(Number(reward.demoBalance), 1);
        assert.equal(reward.cashValue, false);

        const repeatedCompletion = await fetch(`${origin}/api/demo/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: JSON.stringify({ clickId, answers: { completed: true } })
        });
        assert.equal(repeatedCompletion.status, 200);
        assert.equal((await repeatedCompletion.json()).alreadyCompleted, true);
        const actualBalance = await fetch(`${origin}/api/user/balance`, {
            headers: { Authorization: `Bearer ${registered.token}` }
        });
        const balances = await actualBalance.json();
        assert.equal(balances.balance, '20.00');
        assert.equal(balances.demoBalance, '1.00');

        const surveyOffer = await pool.query(
            `SELECT id FROM offers
             WHERE is_demo IS TRUE AND offer_type = 'survey'
             ORDER BY id LIMIT 1`
        );
        assert.ok(surveyOffer.rows.length > 0);
        const surveyClickResponse = await fetch(`${origin}/api/click/${surveyOffer.rows[0].id}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: '{}'
        });
        assert.equal(surveyClickResponse.status, 200);
        const surveyClick = await surveyClickResponse.json();
        surveyClickId = new URL(surveyClick.redirectUrl).searchParams.get('aff_sub');
        const surveyEngage = await fetch(surveyClick.redirectUrl, { redirect: 'manual' });
        const surveyUrl = new URL(surveyEngage.headers.get('location'));
        assert.equal(surveyUrl.pathname, '/demo');
        assert.equal(surveyUrl.searchParams.get('type'), 'survey');
        const surveyPage = await fetch(surveyUrl);
        assert.equal(surveyPage.status, 200);

        const incompleteSurvey = await fetch(`${origin}/api/demo/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: JSON.stringify({ clickId: surveyClickId, answers: { favorite: 'games' } })
        });
        assert.equal(incompleteSurvey.status, 400);

        const completedSurvey = await fetch(`${origin}/api/demo/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: JSON.stringify({
                clickId: surveyClickId,
                answers: { favorite: 'games', frequency: 'weekly' }
            })
        });
        assert.equal(completedSurvey.status, 200);
        const surveyReward = await completedSurvey.json();
        assert.equal(Number(surveyReward.credited), 2);
        const savedAnswers = await pool.query(
            'SELECT details FROM conversions WHERE click_id = $1',
            [surveyClickId]
        );
        assert.deepEqual(savedAnswers.rows[0].details, { favorite: 'games', frequency: 'weekly' });
        const updatedBalance = await fetch(`${origin}/api/user/balance`, {
            headers: { Authorization: `Bearer ${registered.token}` }
        });
        assert.equal((await updatedBalance.json()).demoBalance, '3.00');

        const login = await fetch(`${origin}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'sample-test-password-42' })
        });
        assert.equal(login.status, 200);
        assert.ok((await login.json()).token);

        const withdrawal = await fetch(`${origin}/api/user/withdraw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${registered.token}`
            },
            body: JSON.stringify({ amount: 5, paymentMethod: 'paypal', paymentAddress: 'test@example.invalid' })
        });
        assert.equal(withdrawal.status, 200);
        const request = await withdrawal.json();
        assert.match(request.message, /queued/);
        const savedWithdrawal = await pool.query(
            'SELECT status FROM withdrawals WHERE id = $1 AND user_id = $2',
            [request.withdrawalId, userId]
        );
        assert.equal(savedWithdrawal.rows[0].status, 'pending');
        const withdrawalHistory = await fetch(`${origin}/api/user/withdrawals`, {
            headers: { Authorization: `Bearer ${registered.token}` }
        });
        assert.equal(withdrawalHistory.status, 200);
        assert.equal((await withdrawalHistory.json())[0].status, 'pending');
        const depositHistory = await fetch(`${origin}/api/user/deposits`, {
            headers: { Authorization: `Bearer ${registered.token}` }
        });
        assert.equal(depositHistory.status, 200);
        assert.deepEqual(await depositHistory.json(), []);
        const ledger = await pool.query(
            `SELECT amount, transaction_type FROM balance_transactions
             WHERE user_id = $1 AND source_id = $2`,
            [userId, String(request.withdrawalId)]
        );
        assert.equal(Number(ledger.rows[0].amount), -5);
        assert.equal(ledger.rows[0].transaction_type, 'withdrawal');
    } finally {
        if (userId !== undefined) {
            if (surveyClickId) {
                await pool.query('DELETE FROM conversions WHERE click_id = $1', [surveyClickId]);
                await pool.query('DELETE FROM clicks WHERE click_id = $1', [surveyClickId]);
            }
            if (clickId) {
                await pool.query('DELETE FROM conversions WHERE click_id = $1', [clickId]);
                await pool.query('DELETE FROM clicks WHERE click_id = $1', [clickId]);
            }
            await pool.query('DELETE FROM balance_transactions WHERE user_id = $1', [userId]);
            await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [userId]);
            await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorProxyKey === undefined) delete process.env.PROXYCHECK_KEY;
        else process.env.PROXYCHECK_KEY = priorProxyKey;
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = priorAppBaseUrl;
        if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = priorDatabaseUrl;
    }
});

test('unknown API paths return JSON 404 responses', async () => {
    const response = await fetch(`${origin}/api/not-a-route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
});

test('production postbacks require a configured secret', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.POSTBACK_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.POSTBACK_SECRET;
    try {
        const [getResponse, postResponse] = await Promise.all([
            fetch(`${origin}/api/postback?click_id=unknown&payout=1&status=approved`),
            fetch(`${origin}/api/postback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ click_id: 'unknown', payout: 1, status: 'approved' })
            })
        ]);
        assert.equal(getResponse.status, 403);
        assert.equal(postResponse.status, 403);
    } finally {
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.POSTBACK_SECRET;
        else process.env.POSTBACK_SECRET = priorSecret;
    }
});

test('an absent proxy check is only fatal when PROXYCHECK_REQUIRED asks it to be', async () => {
    // The old version of this test asserted a flat 503 in production whenever
    // PROXYCHECK_KEY was missing, which is the behaviour the middleware was changed to remove:
    // a feature nobody switched on took the whole catalog offline. The contract is now explicit
    // -- an absent key is a warning, and only PROXYCHECK_REQUIRED makes it fatal -- so both
    // halves are asserted here. Testing only the permissive half would let the fail-closed
    // setting regress unnoticed, and testing only the strict half would re-fail what was fixed.
    const priorEnvironment = process.env.NODE_ENV;
    const priorProxyKey = process.env.PROXYCHECK_KEY;
    const priorRequired = process.env.PROXYCHECK_REQUIRED;
    const priorJwtSecret = process.env.JWT_SECRET;
    const jwtSecret = 'unit-test-secret';
    const originalQuery = pool.query;
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = jwtSecret;
    delete process.env.PROXYCHECK_KEY;

    pool.query = async (query) => {
        if (query.includes('SELECT token_version')) return { rows: [{ token_version: 0, is_banned: false }] };
        return { rows: [] };
    };

    const click = () => fetch(`${origin}/api/click/test-offer`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signUserToken(1, jwtSecret)}`
        },
        body: '{}'
    });

    try {
        // Not required: the absent key is a warning, so the request gets past fraud detection
        // and on to the offer lookup. 404 rather than 503 is what proves the proxy check did
        // not refuse it -- the offer is stubbed away, so the lookup is the next thing to fail.
        delete process.env.PROXYCHECK_REQUIRED;
        const allowed = await click();
        assert.notEqual(allowed.status, 503,
            'a missing, unrequested proxy check must not refuse every click');

        // Required: now the same absence is fatal, and distinctly so -- 503 is "we refused by
        // policy", which is the answer an operator needs to tell apart from a broken offer.
        process.env.PROXYCHECK_REQUIRED = 'true';
        const refused = await click();
        assert.equal(refused.status, 503);
    } finally {
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorProxyKey === undefined) delete process.env.PROXYCHECK_KEY;
        else process.env.PROXYCHECK_KEY = priorProxyKey;
        if (priorRequired === undefined) delete process.env.PROXYCHECK_REQUIRED;
        else process.env.PROXYCHECK_REQUIRED = priorRequired;
        if (priorJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorJwtSecret;
    }
});

/**
 * A withdrawal client that records the writes instead of performing them.
 *
 * The refund is two writes that must agree with each other, so the tests need to see both
 * and to be able to break either one. `failLedger` makes the ledger write conflict, which
 * is the case where the balance has already moved and has to be rolled back with it.
 */
function withdrawalClient({ status = 'pending', amount = '500.00', userId = 3, failLedger = false, balance = 0 } = {}) {
    const state = { balance, closed: null, ledger: [], paid: null };
    const client = {
        state,
        query: async (query, params = []) => {
            const normalized = query.replace(/\s+/g, ' ').trim();
            if (/SELECT w\.id, w\.user_id, w\.amount, w\.status, w\.provider_reference[\s\S]*FROM withdrawals/i.test(normalized)) {
                if (status === 'missing') return { rows: [] };
                return { rows: [{ id: params[0], user_id: userId, amount, status, provider_reference: null }] };
            }
            if (/SELECT u\.email[\s\S]*FROM withdrawals w/i.test(normalized)) {
                return { rows: [{ email: 'recipient@example.com' }] };
            }
            if (normalized.startsWith('SELECT status FROM withdrawals')) {
                return { rows: [{ status }] };
            }
            if (/UPDATE withdrawals SET status = 'paid'/i.test(normalized)) {
                if (status !== 'pending' && status !== 'processing') return { rows: [], rowCount: 0 };
                state.paid = params[0];
                return { rows: [{ id: params[1], user_id: userId, amount, status: 'paid' }], rowCount: 1 };
            }
            if (/UPDATE withdrawals SET status = 'failed'/i.test(normalized)) {
                if (status !== 'pending' && status !== 'processing') return { rows: [], rowCount: 0 };
                state.closed = params[0];
                return { rows: [{ id: params[1], user_id: userId, amount, status: 'failed' }], rowCount: 1 };
            }
            if (normalized.startsWith('UPDATE users SET balance = balance +')) {
                state.balance += Number(params[0]);
                return { rows: [{ balance: state.balance }], rowCount: 1 };
            }
            if (/INSERT INTO balance_transactions/i.test(normalized)) {
                if (failLedger) return { rows: [], rowCount: 0 };
                state.ledger.push(params.slice());
                return { rows: [{ id: 1 }], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        }
    };
    return client;
}

test('a rejected withdrawal returns the money and records why', async () => {
    const client = withdrawalClient({ amount: '500.00', balance: 100 });

    const result = await refundWithdrawal(client, 12, 'PayPal account could not be verified');

    assert.equal(result.changed, true);
    assert.equal(result.refunded, '500.00');
    // The user had 100 and requested 500, so the refund puts them back at 600: the debit
    // taken at request time is what the refund reverses.
    assert.equal(client.state.balance, 600);
    assert.equal(client.state.closed, 'PayPal account could not be verified');
    assert.deepEqual(client.state.ledger[0], [3, '500.00', refundSourceId(12), 'PayPal account could not be verified']);
});

test('a refund that cannot be written to the ledger aborts rather than crediting alone', async () => {
    const client = withdrawalClient({ failLedger: true });

    await assert.rejects(
        () => refundWithdrawal(client, 12, 'test'),
        /already has a refund ledger entry/
    );
    // The balance write happened first, so the only thing standing between this and a user
    // credited twice is the throw: the caller's rollback is what undoes it.
    assert.equal(client.state.balance, 500);
});

test('a paid withdrawal is never refunded', async () => {
    const client = withdrawalClient({ status: 'paid' });

    const result = await refundWithdrawal(client, 12, 'too late');

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-paid');
    assert.equal(client.state.balance, 0);
    assert.equal(client.state.closed, null);
});

test('an already-resolved withdrawal is not refunded a second time', async () => {
    const client = withdrawalClient({ status: 'failed' });

    const result = await refundWithdrawal(client, 12, 'again');

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-resolved');
    assert.equal(client.state.balance, 0);
    assert.equal(client.state.ledger.length, 0);
});

test('refunding a withdrawal that does not exist reports it instead of crediting nobody', async () => {
    const client = withdrawalClient({ status: 'missing' });

    const result = await refundWithdrawal(client, 999, 'test');

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'not-found');
});

test('marking a withdrawal paid requires the reference that proves it', async () => {
    const client = withdrawalClient();

    const missing = await markWithdrawalPaid(client, 12, '   ');
    assert.deepEqual(missing, { changed: false, reason: 'missing-reference' });

    const marked = await markWithdrawalPaid(client, 12, 'pp-9f2c');
    assert.equal(marked.changed, true);
    assert.equal(marked.withdrawal.status, 'paid');
    assert.equal(client.state.paid, 'pp-9f2c');
});

test('a withdrawal already marked paid is not marked paid again', async () => {
    const client = withdrawalClient({ status: 'paid' });

    const result = await markWithdrawalPaid(client, 12, 'pp-9f2c');

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-paid');
    assert.equal(client.state.paid, null);
});
test('withdrawal review endpoints resolve a request and refuse to do it twice', async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSecret = process.env.CRON_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.CRON_SECRET = 'withdrawal-cron-secret';
    const originalConnect = pool.connect;
    const originalQuery = pool.query;

    let withdrawalStatus = 'pending';
    let balance = 0;
    const ledger = [];
    const client = {
        query: async (query, params = []) => {
            const normalized = query.replace(/\s+/g, ' ').trim();
            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
            if (/SELECT w\.id, w\.user_id, w\.amount, w\.status, w\.provider_reference/.test(normalized)) {
                return { rows: [{ id: 12, user_id: 1, amount: '500.00', status: withdrawalStatus, provider_reference: null }] };
            }
            if (normalized.startsWith('SELECT status FROM withdrawals')) {
                return { rows: [{ status: withdrawalStatus }] };
            }
            if (/SELECT u\.email[\s\S]*FROM withdrawals w/i.test(normalized)) {
                return { rows: [{ email: 'test@example.com' }] };
            }
            if (/UPDATE withdrawals SET status = 'failed'/.test(normalized)) {
                const claimed = withdrawalStatus === 'pending' || withdrawalStatus === 'processing';
                withdrawalStatus = 'failed';
                return claimed
                    ? { rows: [{ id: 12, user_id: 1, amount: '500.00', status: 'failed' }], rowCount: 1 }
                    : { rows: [], rowCount: 0 };
            }
            if (normalized.startsWith('UPDATE users SET balance = balance +')) {
                balance += Number(params[0]);
                return { rows: [{ balance: String(balance) }], rowCount: 1 };
            }
            if (/INSERT INTO balance_transactions/i.test(normalized)) {
                if (ledger.includes(params[2])) return { rows: [], rowCount: 0 };
                ledger.push(params[2]);
                return { rows: [{ id: 1 }], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        },
        release: () => {}
    };
    pool.connect = async () => client;
    // `pg`'s Pool.query is implemented on top of Pool.connect, so replacing connect alone
    // leaves pool.query calling a callback the replacement never invokes -- the request
    // waits forever instead of failing. The listing goes through pool.query, so it has to
    // be replaced too, and anything unrecognised throws rather than reaching the database:
    // this test is about the review endpoints, not about what is in the live ledger.
    pool.query = async (query) => {
        if (/SELECT w\.id, w\.user_id, u\.email/.test(query)) {
            return {
                rows: withdrawalStatus === 'pending' || withdrawalStatus === 'processing'
                    ? [{ id: 12, user_id: 1, email: 'a@b.test', amount: '500.00', payment_method: 'paypal',
                        payment_address: 'me@example.test', asset_code: null, network: null,
                        status: withdrawalStatus, created_at: new Date() }]
                    : []
            };
        }
        throw new Error(`Unexpected pool.query: ${query}`);
    };

    try {
        const listed = await fetch(`${origin}/api/maintenance/withdrawals?secret=withdrawal-cron-secret`);
        assert.equal(listed.status, 200);
        const { withdrawals } = await listed.json();
        assert.equal(withdrawals.length, 1);
        assert.equal(withdrawals[0].id, 12);

        // A refund with no reason is refused: the reason is what the user reads in their
        // withdrawal history, so an unexplained rejection is not a usable outcome.
        const unexplained = await fetch(`${origin}/api/maintenance/withdrawals/12/refund?secret=withdrawal-cron-secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(unexplained.status, 400);

        const refunded = await fetch(`${origin}/api/maintenance/withdrawals/12/refund?secret=withdrawal-cron-secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'PayPal account could not be verified' })
        });
        assert.equal(refunded.status, 200);
        const refundBody = await refunded.json();
        assert.equal(refundBody.refunded, '500.00');
        assert.equal(balance, 500);
        assert.deepEqual(ledger, ['withdrawal:12']);

        // Repeating it must not credit the balance twice, and must not claim success.
        const repeated = await fetch(`${origin}/api/maintenance/withdrawals/12/refund?secret=withdrawal-cron-secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'again' })
        });
        assert.equal(repeated.status, 409);
        assert.equal(balance, 500);

        // A paid withdrawal is the one case that must never be reversible here.
        withdrawalStatus = 'paid';
        const afterPaid = await fetch(`${origin}/api/maintenance/withdrawals/12/refund?secret=withdrawal-cron-secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'too late' })
        });
        assert.equal(afterPaid.status, 409);
        assert.equal(balance, 500);

        // A wrong secret is only refused where the secret is the gate. Outside production
        // the gate is loopback and the secret is ignored, so asserting 403 here would be
        // asserting a rule this app does not have; the production contract is asserted
        // instead, and a resolvable route must stay undiscoverable to someone guessing it.
        process.env.NODE_ENV = 'production';
        const wrongSecret = await fetch(`${origin}/api/maintenance/withdrawals/12/paid?secret=wrong`, { method: 'POST' });
        assert.equal(wrongSecret.status, 404);
        assert.equal(balance, 500);

        // The same must hold for the wrong *verb*. `GET` on the POST-only refund endpoint is
        // what a browser address bar sends, and it used to fall through to the catch-all and
        // answer `{"error":"API route not found."}` -- a statement that was true only about
        // the request and false about the endpoint, leaving an operator unable to tell a
        // wrong URL from a wrong verb. It must stay a 404 to an unauthenticated caller, and
        // only become a 405 for one who already holds the secret.
        const wrongVerbUnauthenticated = await fetch(
            `${origin}/api/maintenance/withdrawals/12/refund?secret=wrong`,
            { method: 'GET' }
        );
        assert.equal(wrongVerbUnauthenticated.status, 404);

        // Authenticated, the verb is named rather than hidden.
        const wrongVerb = await fetch(
            `${origin}/api/maintenance/withdrawals/12/refund?secret=withdrawal-cron-secret`,
            { method: 'GET' }
        );
        assert.equal(wrongVerb.status, 405);
        assert.match(wrongVerb.headers.get('allow') || '', /POST/);
        const wrongVerbBody = await wrongVerb.json();
        assert.equal(wrongVerbBody.allowed.includes('POST'), true);
        assert.equal(balance, 500);

        // A path that is not a maintenance route at all stays a plain 404. The 405 must never
        // stand in for "no such endpoint", or a typo would look like a real one.
        const unknownMaintenancePath = await fetch(
            `${origin}/api/maintenance/withdrawals/12/send?secret=withdrawal-cron-secret`,
            { method: 'POST' }
        );
        assert.equal(unknownMaintenancePath.status, 404);
    } finally {
        pool.connect = originalConnect;
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = priorSecret;
    }
});

/**
 * Deployment routing.
 *
 * The bug these lock down was invisible in every other test: the app served every page
 * correctly under `npm start`, and the production deployment swallowed the click hop. So
 * the check is against `vercel.json` itself, including the exact configuration this
 * project used to ship, because that is the one that has to be proven impossible.
 */
test('the deployed routing sends page requests to the function, not to the SPA shell', () => {
    const { checkRouting } = require('../scripts/vercel-build');
    const deployed = require('../vercel.json');

    const verdict = checkRouting(deployed);
    assert.equal(verdict.ok, true, `deployed routing rejected: ${verdict.reason}`);
    assert.match(verdict.destination, /^\/api\//);
});

test('routing that serves index.html for pages is rejected as the bug it is', () => {
    const { checkRouting } = require('../scripts/vercel-build');

    // The configuration that shipped: correct-looking, and it returned the user to the
    // catalog every time they clicked an offer.
    const broken = {
        rewrites: [
            { source: '/api/(.*)', destination: '/api/index.js' },
            { source: '/((?!api/).*)', destination: '/index.html' }
        ]
    };
    const verdict = checkRouting(broken);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /offer\/engage/);
    assert.match(verdict.reason, /advertiser/);

    // A missing catch-all is just as fatal, and much quieter.
    const noCatchAll = { rewrites: [{ source: '/api/(.*)', destination: '/api/index.js' }] };
    assert.equal(checkRouting(noCatchAll).ok, false);

    // Pointing pages at a non-function is a typo that 500s every page.
    const notAFunction = {
        rewrites: [
            { source: '/api/(.*)', destination: '/api/index.js' },
            { source: '/((?!api/).*)', destination: '/somewhere-else' }
        ]
    };
    assert.equal(checkRouting(notAFunction).ok, false);
});

test('every page the app serves is reachable under the deployed routing', () => {
    // The list is the app's own route table. Anything served by Express but not covered by
    // the rewrite silently becomes the SPA shell in production, so it is asserted here
    // rather than discovered from a 404 in production.
    const deployed = require('../vercel.json');
    const pagePaths = ['/', '/offers', '/reset-password', '/demo'];
    // `/deposit/:id` is a pattern, so it is checked as the shape the rewrite must cover.
    const patterns = [/^\/deposit\/:id$/, /^\/offer\/engage$/, /^\/click\/:offerId$/];

    const catchAll = deployed.rewrites.find((rule) => !/^\/api\//.test(rule.source));
    assert.ok(catchAll, 'there is no catch-all rewrite for page requests');
    // The source has to be a negative lookahead on the /api prefix followed by a wildcard:
    // anything narrower leaves a real page outside the rewrite and 404s it in production.
    assert.match(catchAll.source, /^\/\(\(\?!api\/\)/, 'the catch-all must exclude only /api paths');
    assert.match(catchAll.source, /\*\)$/, 'the catch-all must match to the end of the path');

    for (const path of pagePaths) {
        assert.ok(!path.startsWith('/api/'), `${path} would be handled by the API rewrite instead`);
    }
    assert.ok(patterns.length > 0);
});

test('the offer catalog hides demo offers in production and shows them elsewhere', async () => {
    const originalQuery = pool.query;
    const seen = [];
    pool.query = async (query, params) => {
        seen.push({ query: query.replace(/\s+/g, ' ').trim(), params });
        if (/FROM offers/.test(query)) {
            // Mirrors what the database does with the flag, so the assertion is about the
            // wiring between NODE_ENV and the query rather than about this stub.
            const includeDemo = params && params[0] === true;
            const rows = [
                { id: 1, title: 'Real offer', description: 'Do the thing', payout: '3.00', network_name: 'net', partner_label: 'Net', is_demo: false, offer_type: 'offer' },
                { id: 2, title: 'Demo survey', description: 'Answer two questions', payout: '2.00', network_name: 'demo', partner_label: 'Demo Partner', is_demo: true, offer_type: 'survey' }
            ];
            return { rows: includeDemo ? rows : rows.filter((offer) => !offer.is_demo) };
        }
        return { rows: [] };
    };

    const priorEnvironment = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        const production = await fetch(`${origin}/api/offers`);
        assert.equal(production.status, 200);
        const productionOffers = await production.json();
        // The filter is pushed into SQL rather than applied in the response, so a demo
        // offer is never serialised to a production visitor in the first place.
        assert.deepEqual(productionOffers.map((offer) => offer.id), [1]);
        const productionQuery = seen[seen.length - 1];
        assert.equal(productionQuery.params[0], false, 'production did not exclude demo offers in SQL');

        process.env.NODE_ENV = 'test';
        const development = await fetch(`${origin}/api/offers`);
        const developmentOffers = await development.json();
        assert.deepEqual(developmentOffers.map((offer) => offer.id), [1, 2]);
        assert.equal(seen[seen.length - 1].params[0], true);

        // The blurb and the display partner name are what the upgraded card renders, and
        // the tracking URL must never be part of the catalog payload.
        const card = developmentOffers[0];
        assert.equal(card.description, 'Do the thing');
        assert.equal(card.partner_label, 'Net');
        assert.equal(card.tracking_url, undefined);
    } finally {
        pool.query = originalQuery;
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
    }
});

/**
 * The payment check, on its own, across every shape a callback can arrive in.
 *
 * These assertions exist because of a regression that was live in this codebase: when the
 * amounts were missing or unparseable, the check fell back to "is the status `finished`?"
 * and a `finished` body carrying no `actually_paid` at all funded a balance. Anything that
 * can post a signed callback can carry that body, so the fallback turned a status string
 * into money. The cases below are each a way that body can be produced -- a proxy that
 * strips fields, a truncated delivery, a hand-written request, a provider API change.
 */
test('a finished callback only credits when the money provably arrived', () => {
    const { isPaymentFullyPaid } = require('../src/services/depositCredit');

    const refusals = {
        'no actually_paid field': { pay_amount: 0.0003, payment_status: 'finished' },
        'actually_paid is null': { pay_amount: 0.0003, actually_paid: null, payment_status: 'finished' },
        'actually_paid is an empty string': { pay_amount: 0.0003, actually_paid: '', payment_status: 'finished' },
        'actually_paid is not a number': { pay_amount: 0.0003, actually_paid: 'lots', payment_status: 'finished' },
        'actually_paid underpays': { pay_amount: 0.0003, actually_paid: 0.0001, payment_status: 'finished' },
        'a shortfall of a millionth': { pay_amount: 1, actually_paid: 0.999999, payment_status: 'finished' },
        'no pay_amount to compare against': { actually_paid: 0.0003, payment_status: 'finished' },
        'pay_amount is zero': { pay_amount: 0, actually_paid: 0.0003, payment_status: 'finished' },
        'a coin amount compared against a fiat total': { price_amount: 25, actually_paid: 0.0003, payment_status: 'finished' },
        'nothing at all': { payment_status: 'finished' },
        'a null payload': null
    };
    for (const [name, payload] of Object.entries(refusals)) {
        assert.equal(isPaymentFullyPaid(payload), false, `${name} must not credit`);
    }

    const confirmations = {
        'exactly the quoted amount': { pay_amount: 0.0003, actually_paid: 0.0003 },
        'more than quoted': { pay_amount: 0.0003, actually_paid: 0.0004 },
        'numeric strings, which is how the provider sends them': { pay_amount: '0.0003', actually_paid: '0.0003' },
        // 0.1 + 2.8e-17 === 0.1 in binary floating point, so a provider that paid the
        // exact amount can report a value that compares as fractionally short.
        'floating point representation noise': { pay_amount: 0.1, actually_paid: 0.1 + Number.EPSILON }
    };
    for (const [name, payload] of Object.entries(confirmations)) {
        assert.equal(isPaymentFullyPaid(payload), true, `${name} must credit`);
    }
});

test('a crypto deposit is never confirmed against its fiat value', async () => {
    // The units trap in one test: `actually_paid` is a quantity of coin and `price_amount`
    // is dollars. A check that compared them would pass any real payment on an expensive
    // asset and fail every payment on a cheap one, and it would look correct in testing.
    const { isPaymentFullyPaid } = require('../src/services/depositCredit');
    const deposit = { pay_currency: 'btc', pay_amount: 0.0003, price_amount: 25, price_currency: 'usd' };

    // 0.0003 BTC is $25 and is paid; 0.0001 BTC is $8.33 and is not.
    assert.equal(isPaymentFullyPaid({ ...deposit, actually_paid: 0.0003 }), true);
    assert.equal(isPaymentFullyPaid({ ...deposit, actually_paid: 0.0001 }), false);
    // Falling back to the fiat figure would call this paid, because 0.0001 is nowhere near
    // 25 -- and the same fallback would call a 0.0003 payment unpaid on any asset cheaper
    // than BTC. Neither direction is a payment check.
    assert.equal(isPaymentFullyPaid({ ...deposit, pay_amount: undefined, actually_paid: 0.0003 }), false);
});

/**
 * Demo mode is one switch, read by four call sites.
 *
 * They were four independent `NODE_ENV` comparisons, which is how a deployment ends up
 * advertising a demo offer whose survey 404s: the catalog used one rule, the /demo page
 * another, the completion endpoint a third, and the click handler a fourth. The specific
 * failure this locks down is `OFFERS_INCLUDE_DEMO=true` on a deployment with
 * `NODE_ENV=production` -- the state a staging environment is in -- where all four must
 * agree or the survey is a dead end.
 */
test('demo mode resolves the same way for the catalog, the page, and the reward', () => {
    const { isDemoModeEnabled, describeDemoMode } = require('../src/services/demoMode');
    const priorEnvironment = process.env.NODE_ENV;
    const priorOverride = process.env.OFFERS_INCLUDE_DEMO;

    try {
        const cases = [
            { nodeEnv: 'production', override: undefined, expected: false },
            { nodeEnv: 'production', override: 'true', expected: true },
            { nodeEnv: 'production', override: '1', expected: true },
            { nodeEnv: 'production', override: 'false', expected: false },
            { nodeEnv: 'production', override: '0', expected: false },
            // The default is not "on": a production deployment shares its database with
            // local development, so a default of on would publish local test offers to
            // real visitors.
            { nodeEnv: 'development', override: undefined, expected: true },
            { nodeEnv: 'test', override: undefined, expected: true },
            // An explicit false wins even outside production, so a shared environment can
            // be held to the production rule.
            { nodeEnv: 'development', override: 'false', expected: false }
        ];

        for (const { nodeEnv, override, expected } of cases) {
            if (override === undefined) delete process.env.OFFERS_INCLUDE_DEMO;
            else process.env.OFFERS_INCLUDE_DEMO = override;
            process.env.NODE_ENV = nodeEnv;
            assert.equal(
                isDemoModeEnabled(), expected,
                `NODE_ENV=${nodeEnv} OFFERS_INCLUDE_DEMO=${override}`
            );
        }

        // The description is what makes an empty catalog diagnosable, so it must say where
        // the answer came from, not just what it was.
        process.env.NODE_ENV = 'production';
        delete process.env.OFFERS_INCLUDE_DEMO;
        assert.deepEqual(describeDemoMode(), { enabled: false, source: 'NODE_ENV', environment: 'production' });
        process.env.OFFERS_INCLUDE_DEMO = 'true';
        assert.deepEqual(describeDemoMode(), { enabled: true, source: 'OFFERS_INCLUDE_DEMO', environment: 'production' });
    } finally {
        if (priorEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = priorEnvironment;
        if (priorOverride === undefined) delete process.env.OFFERS_INCLUDE_DEMO;
        else process.env.OFFERS_INCLUDE_DEMO = priorOverride;
    }
});

test('a proxy check that cannot run does not take the whole offer flow down by default', () => {
    const { proxyCheckRequired } = require('../src/middlewares/fraudDetection');
    const priorRequired = process.env.PROXYCHECK_REQUIRED;

    try {
        delete process.env.PROXYCHECK_REQUIRED;
        // Failing closed by default meant a deployment that had never configured
        // proxycheck.io answered 503 to every click, on every offer, for every user.
        assert.equal(proxyCheckRequired(), false, 'the default must not refuse tracking');

        process.env.PROXYCHECK_REQUIRED = 'true';
        assert.equal(proxyCheckRequired(), true, 'the strict posture must be selectable');

        process.env.PROXYCHECK_REQUIRED = 'false';
        assert.equal(proxyCheckRequired(), false);
    } finally {
        if (priorRequired === undefined) delete process.env.PROXYCHECK_REQUIRED;
        else process.env.PROXYCHECK_REQUIRED = priorRequired;
    }
});

test('a demo click is refused before it is recorded when demo mode is off', async () => {
    const originalQuery = pool.query;
    const priorEnvironment = process.env.NODE_ENV;
    const priorOverride = process.env.OFFERS_INCLUDE_DEMO;
    const recorded = [];

    pool.query = async (query, values) => {
        // The session has to resolve to a user, or `requireAuth` answers 401 before the
        // offer is ever looked at and the assertion is testing the wrong thing.
        if (query.includes('SELECT token_version')) return { rows: [{ token_version: 0, is_banned: false }] };
        if (query.includes('SELECT COUNT(*)')) return { rows: [{ count: '0' }] };
        if (/SELECT tracking_url.*FROM offers/i.test(query)) {
            return { rows: [{ tracking_url: 'https://partner.example/go', is_demo: true }] };
        }
        if (query.includes('INSERT INTO clicks')) {
            recorded.push(values[0]);
            return { rows: [] };
        }
        return { rows: [] };
    };

    const priorSecret = process.env.JWT_SECRET;
    try {
        process.env.JWT_SECRET = 'demo-click-test-secret';
        process.env.NODE_ENV = 'production';
        process.env.OFFERS_INCLUDE_DEMO = 'false';

        const click = await fetch(`${origin}/api/click/1`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${signUserToken(1, 'demo-click-test-secret')}`
            },
            body: '{}'
        });
        assert.equal(click.status, 404);
        // The point of refusing here: a recorded click can never resolve, so the row would
        // sit in `clicks` looking like a real tracked click forever.
        assert.equal(recorded.length, 0, 'no click row may be written for a demo offer this deployment cannot run');

        // And the message has to explain itself. A bare 404 for an offer the user can see
        // is indistinguishable from a broken link.
        const text = await click.text();
        assert.match(text, /test offer/i);
        assert.doesNotMatch(text, /not found/i);
    } finally {
        pool.query = originalQuery;
        for (const [key, value] of [['JWT_SECRET', priorSecret], ['NODE_ENV', priorEnvironment], ['OFFERS_INCLUDE_DEMO', priorOverride]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a click that cannot run here returns the user to the catalog with a reason', async () => {
    const originalQuery = pool.query;
    const priorEnvironment = process.env.NODE_ENV;
    const priorOverride = process.env.OFFERS_INCLUDE_DEMO;
    const priorBase = process.env.APP_BASE_URL;
    const clickId = '305e6314-02c3-4c6a-8365-f8588f335dfb';

    pool.query = async (query) => {
        if (/SELECT offers.tracking_url/i.test(query)) {
            return { rows: [{ tracking_url: 'https://partner.example/go', is_demo: true, offer_type: 'survey' }] };
        }
        return { rows: [] };
    };

    try {
        process.env.NODE_ENV = 'production';
        process.env.OFFERS_INCLUDE_DEMO = 'false';
        delete process.env.APP_BASE_URL;

        const engage = await fetch(`${origin}/offer/engage?aff_sub=${clickId}`, { redirect: 'manual' });

        // The old behaviour was a 404 page reading "Demo offer not found.", which reads as
        // a broken link and tells the user nothing. The user is now returned somewhere they
        // can keep working, and told why.
        assert.equal(engage.status, 302);
        const location = engage.headers.get('location') || '';
        assert.match(location, /\/offers/);
        assert.match(location, /notice=demo-unavailable/);
        // A redirect must not be cached, or a proxy would keep sending later users here.
        assert.match(engage.headers.get('cache-control') || '', /no-store/);
    } finally {
        pool.query = originalQuery;
        for (const [key, value] of [['NODE_ENV', priorEnvironment], ['OFFERS_INCLUDE_DEMO', priorOverride], ['APP_BASE_URL', priorBase]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
