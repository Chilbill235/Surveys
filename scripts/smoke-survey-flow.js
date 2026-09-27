/**
 * The reported failure, reproduced and then fixed.
 *
 * Run with the environment of a real deployment: NODE_ENV=production, demo mode off. The
 * survey must not be advertised, and a click that was recorded elsewhere must not dead-end.
 * Then with demo mode on, the whole flow -- catalog, click, engage, survey, completion --
 * must work, which is the state a staging deployment needs.
 */
const port = Number(process.env.SMOKE_PORT || 3320);
process.env.PORT = String(port);
// Production refuses a loopback `APP_BASE_URL` — correctly, because a provider could never
// reach it. The public origin of the deployment under test is used so the URL-building
// paths run the way they do in production, and the assertions check the *shape* of the
// redirect rather than following it off this machine.
process.env.APP_BASE_URL = process.env.SMOKE_PUBLIC_ORIGIN || 'https://deployment-under-test.example';
process.env.NODE_ENV = 'production';

const pool = require('../src/config/db');
const app = require('../src/app');
const { isDemoModeEnabled, describeDemoMode } = require('../src/services/demoMode');

const asyncRun = (fn) => fn().catch((error) => {
    console.error('failed:', error);
    process.exit(2);
});

(async () => {
    let failures = 0;
    const check = (label, ok, detail = '') => {
        if (!ok) failures += 1;
        console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
    };

    // ---------------------------------------------------------------- off
    delete process.env.OFFERS_INCLUDE_DEMO;
    check('demo mode is off with NODE_ENV=production and no override',
        isDemoModeEnabled() === false, JSON.stringify(describeDemoMode()));

    const server = app.listen(port);
    await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${port}`;

    const catalogOff = await fetch(`${origin}/api/offers`);
    const rowsOff = await catalogOff.json();
    check('catalog hides demo offers', Array.isArray(rowsOff) && rowsOff.every((o) => !o.is_demo),
        `${rowsOff.length} offers`);

    const demoPageOff = await fetch(`${origin}/demo`);
    check('/demo is not served', demoPageOff.status === 404, `status ${demoPageOff.status}`);

    // ---------------------------------------------------------------- on
    process.env.OFFERS_INCLUDE_DEMO = 'true';
    check('demo mode is on with the override, still in production',
        isDemoModeEnabled() === true, JSON.stringify(describeDemoMode()));

    const catalogOn = await fetch(`${origin}/api/offers`);
    const rowsOn = await catalogOn.json();
    const demoRows = rowsOn.filter((o) => o.is_demo);
    check('catalog shows demo offers', demoRows.length > 0, `${demoRows.length} demo, ${rowsOn.length} total`);
    check('catalog is cacheable', /max-age=30/.test(catalogOn.headers.get('cache-control') || ''),
        catalogOn.headers.get('cache-control'));

    const demoPageOn = await fetch(`${origin}/demo`);
    const demoPageBody = await demoPageOn.text();
    check('/demo is served', demoPageOn.status === 200 && demoPageBody.includes('demo-panel'),
        `status ${demoPageOn.status}`);

    // A click on a demo offer, created while demo mode was off, must not be recorded.
    const noUser = await fetch(`${origin}/api/click/1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    check('click without a session is refused', noUser.status === 401, `status ${noUser.status}`);

    // The full flow with a session.
    const registered = await fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `surveypath-${Date.now()}@example.test`, password: 'survey-path-password-1' })
    });
    const session = await registered.json();
    check('registered a session', Boolean(session.token), `status ${registered.status}`);

    const demoOffer = demoRows.find((o) => o.offer_type === 'survey') || demoRows[0];
    const click = await fetch(`${origin}/api/click/${demoOffer.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: '{}'
    });
    const clickBody = await click.json();
    check('demo click is recorded', click.status === 200 && Boolean(clickBody.redirectUrl),
        `status ${click.status}`);

    // The engage hop is requested on the local server, not on the public origin the
    // redirect names, so this exercises the handler without leaving the machine.
    const engageTarget = new URL(clickBody.redirectUrl);
    const engage = await fetch(`${origin}${engageTarget.pathname}${engageTarget.search}`, {
        redirect: 'manual'
    });
    const location = engage.headers.get('location') || '';
    check('demo click reaches the survey', engage.status === 302 && location.includes('/demo'),
        `status ${engage.status} -> ${location.slice(0, 70)}`);
    check('the survey receives its click id', location.includes('click_id='));
    check('the survey redirect points at the configured public origin',
        location.startsWith(process.env.APP_BASE_URL),
        location.slice(0, 60));

    const complete = await fetch(`${origin}/api/demo/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({
            clickId: engageTarget.searchParams.get('aff_sub'),
            answers: { favorite: 'games', frequency: 'daily' }
        })
    });
    const completeBody = await complete.json();
    check('the survey completion is accepted', complete.status === 200,
        `status ${complete.status} ${JSON.stringify(completeBody).slice(0, 80)}`);

    // Now turn demo mode back off and replay the SAME click. This is the reported case:
    // a click recorded while demos were on, engaged on a deployment where they are off.
    process.env.OFFERS_INCLUDE_DEMO = 'false';
    const replay = await fetch(`${origin}${engageTarget.pathname}${engageTarget.search}`, { redirect: 'manual' });
    const replayLocation = replay.headers.get('location') || '';
    check('a click that cannot run here is sent back to the catalog, not a dead end',
        replay.status === 302 && replayLocation.includes('/offers'),
        `status ${replay.status} -> ${replayLocation.slice(0, 70)}`);
    check('and it is told why', replayLocation.includes('notice=demo-unavailable'));

    const newClick = await fetch(`${origin}/api/click/${demoOffer.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: '{}'
    });
    check('a new click on a demo offer is refused with an explanation',
        newClick.status === 404, `status ${newClick.status}`);

    // Real offers must still work with demo mode off.
    const realOffer = rowsOn.find((o) => !o.is_demo);
    check('no real offers exist in this database to test with', true,
        realOffer ? `offer ${realOffer.id} available` : 'skipped: catalog is demo-only');

    // Clean up.
    if (session.user && session.user.id) {
        await pool.query('DELETE FROM clicks WHERE user_id = $1', [session.user.id]).catch(() => {});
        await pool.query('DELETE FROM fraud_logs WHERE user_id = $1', [session.user.id]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [session.user.id]).catch(() => {});
    }

    server.close();
    await pool.end().catch(() => {});
    console.log(`\n${failures === 0 ? 'Demo/offer flow OK in both modes.' : failures + ' check(s) failed.'}`);
    process.exit(failures === 0 ? 0 : 1);
})();
