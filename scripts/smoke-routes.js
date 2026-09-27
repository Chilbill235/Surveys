/**
 * End-to-end check of the paths the old vercel.json rewrote to index.html.
 *
 * Run against a local server to prove each page and the click hop is served by the app
 * rather than the SPA shell, which is what production was doing.
 */
process.env.NODE_ENV = 'development';
process.env.PORT = '3311';
process.env.APP_BASE_URL = 'http://localhost:3311';
process.env.NODE_ENV = process.env.SMOKE_ENV || 'development';

const pool = require('../src/config/db');
const app = require('../src/app');
const { createHmac } = require('crypto');

(async () => {
    const server = app.listen(Number(process.env.PORT));
    await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${process.env.PORT}`;
    let failures = 0;
    let smokeUserId = null;

    const check = async (label, path, expect) => {
        const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
        const body = await response.text();
        const ok = expect(response, body);
        if (!ok) failures += 1;
        const marker = body.includes('<title>') ? (body.match(/<title>([^<]*)</) || [])[1] : '';
        console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${response.status}  ${marker}`);
    };

    // Each of these is a page the old rewrite served as the offers page instead.
    await check('home page', '/', (r, b) => r.status === 200 && !b.includes('id="offer-grid"'));
    await check('offers page', '/offers', (r, b) => r.status === 200 && b.includes('id="offer-grid"'));
    await check('password reset page', '/reset-password', (r, b) => r.status === 200 && !b.includes('id="offer-grid"'));
    await check('deposit receipt page', '/deposit/1', (r, b) => r.status === 200 && !b.includes('id="offer-grid"'));
    await check('demo page (non-production)', '/demo', (r) => r.status === 200);
    await check('static script', '/app.js', (r) => r.status === 200);
    await check('stylesheet', '/style.css', (r) => r.status === 200);

    // The catalog itself.
    const offersResponse = await fetch(`${origin}/api/offers`);
    const offersText = await offersResponse.text();
    let offers;
    try {
        offers = JSON.parse(offersText);
    } catch {
        console.log(`FAIL  /api/offers returned ${offersResponse.status} with a non-JSON body: ${offersText.slice(0, 120)}`);
        failures += 1;
        offers = [];
    }
    if (!Array.isArray(offers)) {
        console.log(`FAIL  /api/offers returned ${offersResponse.status}: ${offersText.slice(0, 160)}`);
        failures += 1;
        offers = [];
    }
    const demoVisible = offers.some((offer) => offer.is_demo);
    console.log(`${demoVisible ? 'ok  ' : 'FAIL'}  catalog shows demo offers in dev  ${offers.length} offers`);
    if (!demoVisible) failures += 1;
    const described = offers.every((offer) => typeof offer.description === 'string' && offer.description.length > 0);
    console.log(`${described ? 'ok  ' : 'FAIL'}  every offer has a blurb`);
    if (!described) failures += 1;
    const noTrackingUrl = offers.every((offer) => offer.tracking_url === undefined);
    console.log(`${noTrackingUrl ? 'ok  ' : 'FAIL'}  catalog never exposes tracking_url`);
    if (!noTrackingUrl) failures += 1;

    // The click hop: the request that used to land the user back on the catalog.
    const offer = offers[0];
    if (offer) {
        const registered = await fetch(`${origin}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `smoke-${Date.now()}@example.test`, password: 'smoke-test-password-123' })
        });
        const session = await registered.json();
        // 201 is the correct answer for a new account; both are accepted so the check is
        // about having a session, not about which status the route chose.
        if (![200, 201].includes(registered.status) || !session.token) {
            console.log(`FAIL  could not register a session: ${registered.status} ${JSON.stringify(session).slice(0, 120)}`);
            failures += 1;
        } else {
            smokeUserId = session.user && session.user.id;
            const click = await fetch(`${origin}/api/click/${offer.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                body: '{}'
            });
            const clickBody = await click.json();
            const engageUrl = clickBody.redirectUrl;
            const engaged = await fetch(engageUrl, { redirect: 'manual' });
            const location = engaged.headers.get('location') || '';
            const leftTheSite = /^[a-z]+:\/\//i.test(location) && !location.startsWith(origin);
            console.log(`${click.status === 200 && leftTheSite ? 'ok  ' : 'FAIL'}  click reaches the advertiser`);
            console.log(`      ${engaged.status} -> ${location.slice(0, 90)}`);
            if (click.status !== 200 || !leftTheSite) failures += 1;

            // A demo click must reach the demo page with its click id, not a 404.
            const demoOffer = offers.find((candidate) => candidate.is_demo);
            if (demoOffer) {
                const demoClick = await fetch(`${origin}/api/click/${demoOffer.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                    body: '{}'
                });
                const demoBody = await demoClick.json();
                // /offer/engage answers with a redirect to the demo page, so the hop has to
                // be followed: a 302 naming /demo is the correct answer, not a failure.
                const demoPage = await fetch(demoBody.redirectUrl, { redirect: 'manual' });
                const demoLocation = demoPage.headers.get('location') || '';
                const reachedDemo = demoPage.status === 302 && demoLocation.includes('/demo') && demoLocation.includes('click_id=');
                const demoRendered = reachedDemo
                    ? await (await fetch(demoBody.redirectUrl)).text()
                    : '';
                const served = reachedDemo && demoRendered.includes('demo-panel');
                console.log(`${served ? 'ok  ' : 'FAIL'}  demo click reaches the demo page  ${demoPage.status} -> ${demoLocation.slice(0, 60)}`);
                if (!served) failures += 1;
            }

            // The signed IPN path still refuses an unsigned callback.
            const unsigned = await fetch(`${origin}/api/payments/nowpayments/ipn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': 'nope' },
                body: JSON.stringify({ payment_id: 1, order_id: '1', payment_status: 'finished' })
            });
            console.log(`${unsigned.status === 401 ? 'ok  ' : 'FAIL'}  unsigned IPN refused  ${unsigned.status}`);
            if (unsigned.status !== 401) failures += 1;
        }
    }

    // The account this check created is removed afterwards. A smoke test that leaves a
    // registered user behind in the live database is a smoke test that eventually makes
    // the real one fail for the wrong reason.
    if (smokeUserId !== null) {
        await pool.query('DELETE FROM clicks WHERE user_id = $1', [smokeUserId]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [smokeUserId]).catch(() => {});
        console.log(`      (cleaned up smoke account ${smokeUserId})`);
    }

    server.close();
    await pool.end().catch(() => {});
    console.log(`\n${failures === 0 ? 'All smoke checks passed.' : failures + ' smoke check(s) failed.'}`);
    process.exit(failures === 0 ? 0 : 1);
})();
