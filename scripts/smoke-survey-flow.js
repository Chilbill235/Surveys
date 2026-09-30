#!/usr/bin/env node
/**
 * End-to-end smoke test for the demo offer and survey flow.
 *
 * Covers the path that unit tests structurally cannot: click -> engage -> task/survey page ->
 * completion -> balance credited -> repeat completion refused. The unit tests assert the rules;
 * this asserts that the rules are wired to each other and to a real database.
 *
 * The account is created directly in the database, marked verified, and then signed in through
 * the real `POST /api/auth/login`. It used to be created with `POST /api/auth/register` and its
 * response used as the session -- which stopped working when registration began issuing no token
 * until the emailed code is entered. The script then carried `undefined` into an
 * `Authorization` header, every subsequent call 401'd, and it died on a `new URL('undefined')`.
 * So it had been reporting failures that said nothing about offers, while the offer flow it
 * exists to test went unexercised.
 *
 * Going through `login` rather than issuing a session directly keeps most of the real thing: the
 * password is hashed and verified by the same code, and the token is a real one. Only the
 * emailed code is stepped over, because it is stored hashed precisely so that it cannot be read
 * out of the database -- which is the correct design and the reason this script cannot automate
 * that step without a mail provider.
 *
 * Not destructive: it creates one throwaway user per run and does not touch any other row.
 */
require('dotenv').config();
const pool = require('../src/config/db');
const { hashPassword } = require('../src/controllers/authController');

const origin = process.env.APP_BASE_URL || 'http://localhost:3001';
const offerNetwork = 'RewardZone Local Demo 1';
const surveyNetwork = 'RewardZone Local Demo Survey';

let failures = 0;

function check(label, passed, detail = '') {
    const line = `${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`;
    console.log(line);
    if (!passed) failures += 1;
}

/** A real session for a fresh account, without going through the emailed code. */
async function session(email, password) {
    const passwordHash = await hashPassword(password);
    // No `ON CONFLICT`: `users.email` is unique through a *partial* index on `lower(email)`, not
    // a table constraint, so `ON CONFLICT (email)` does not match anything and fails outright.
    // The address below is unique per run anyway -- a timestamp and six random digits -- so
    // there is nothing to conflict with. Naming that constraint would have been the alternative,
    // and it would have been a worse one: a second uniqueness rule on a column that already has
    // one is two things that can disagree about what "the same email" means.
    const inserted = await pool.query(
        `INSERT INTO users (email, username, password_hash, email_verified_at, balance, demo_balance)
         VALUES ($1, $2, $3, NOW(), 0, 0)
         RETURNING id`,
        [email, `smoke-${Math.floor(Math.random() * 1e9)}`, passwordHash]
    );
    const response = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const body = await response.json();
    return { userId: inserted.rows[0].id, token: body.token || null, status: response.status };
}

async function completeFlow(label, networkName, answersFor) {
    const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const password = 'smoke-flow-password-1';
    const signedIn = await session(email, password);
    check(`${label}: signed in`, Boolean(signedIn.token), `status ${signedIn.status}`);
    if (!signedIn.token) return;

    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${signedIn.token}` };

    const offer = await pool.query('SELECT id FROM offers WHERE network_name = $1', [networkName]);
    if (offer.rows.length === 0) {
        check(`${label}: the offer exists`, false, `no offer named ${networkName} -- run npm run seed:demo`);
        return;
    }
    const offerId = offer.rows[0].id;

    const click = await fetch(`${origin}/api/click/${offerId}`, {
        method: 'POST',
        headers: auth
    });
    const clickBody = await click.json();
    check(`${label}: click recorded`, Boolean(clickBody.redirectUrl), `status ${click.status}`);

    const engaged = await fetch(clickBody.redirectUrl, { headers: { Authorization: `Bearer ${signedIn.token}` }, redirect: 'manual' });
    check(`${label}: engage redirects into the task`, engaged.status === 302, `status ${engaged.status}`);
    const location = engaged.headers.get('location') || '';
    check(`${label}: engage targets the task page`, location.includes('/demo'), location);

    // The task definition, exactly as the page asks it.
    const clickId = new URL(clickBody.redirectUrl, origin).searchParams.get('aff_sub');
    const task = await fetch(`${origin}/api/demo/survey?clickId=${encodeURIComponent(clickId)}`, {
        headers: { Authorization: `Bearer ${signedIn.token}` }
    });
    const taskBody = await task.json();
    const questions = taskBody.questions || [];
    const steps = taskBody.steps || [];
    check(`${label}: the page was given something to answer`, questions.length > 0 || steps.length > 0,
        `offerType=${taskBody.offerType} questions=${questions.length} steps=${steps.length}`);

    // Built from what the server just asked for, rather than hardcoded -- which is what caught
    // the two real staleness bugs here: a task completed with `{completed: true}` when it needs
    // every position ticked, and a survey answered with two keys when four questions are required.
    const answers = answersFor({ questions, steps });
    check(`${label}: built an answer for what was asked`, Object.keys(answers).length > 0);

    const incomplete = await fetch(`${origin}/api/demo/complete`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ clickId, answers: {} })
    });
    check(`${label}: an empty answer is refused`, incomplete.status === 400, `status ${incomplete.status}`);

    const completed = await fetch(`${origin}/api/demo/complete`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ clickId, answers })
    });
    const completedBody = await completed.json();
    check(`${label}: completion is accepted`, completed.status === 200, `status ${completed.status} ${JSON.stringify(completedBody)}`);
    // `credited` is the payout amount, not a count of events. Asserting `=== 1` would have been
    // wrong for every offer that pays more than a dollar, and would have passed on a $1.00 offer
    // while meaning something entirely different from what it looked like.
    check(`${label}: it credited the payout`, Number(completedBody.credited) > 0, `credited ${completedBody.credited}`);
    check(`${label}: it reports the new balance`, typeof completedBody.demoBalance === 'string',
        `demoBalance ${completedBody.demoBalance}`);
    check(`${label}: it returns somewhere to go`, typeof completedBody.returnTo === 'string' && completedBody.returnTo.length > 0, String(completedBody.returnTo));

    const after = await pool.query('SELECT demo_balance FROM users WHERE id = $1', [signedIn.userId]);
    check(`${label}: the test balance actually moved`, Number(after.rows[0].demo_balance) > 0, `demo_balance ${after.rows[0].demo_balance}`);

    // A second claim on the same click is the one that would pay twice.
    const repeated = await fetch(`${origin}/api/demo/complete`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ clickId, answers })
    });
    const repeatedBody = await repeated.json();
    check(`${label}: a repeat claim is refused`, repeated.status === 200 && repeatedBody.alreadyCompleted === true,
        `status ${repeated.status} alreadyCompleted ${repeatedBody.alreadyCompleted}`);

    const afterRepeat = await pool.query('SELECT demo_balance FROM users WHERE id = $1', [signedIn.userId]);
    check(`${label}: a repeat claim pays nothing`, Number(afterRepeat.rows[0].demo_balance) === Number(after.rows[0].demo_balance),
        `demo_balance ${after.rows[0].demo_balance} -> ${afterRepeat.rows[0].demo_balance}`);
    // A repeat must report no new credit, not the original amount again. Asserted because a
    // handler that returns the same body twice looks correct to every other check here.
    check(`${label}: a repeat claim credits nothing further`,
        !repeatedBody.credited || Number(repeatedBody.credited) === 0,
        `credited ${repeatedBody.credited}`);

    const conversions = await pool.query('SELECT COUNT(*)::int AS n FROM conversions WHERE click_id = $1', [clickId]);
    check(`${label}: exactly one conversion was recorded`, conversions.rows[0].n === 1, `n=${conversions.rows[0].n}`);
}

/** Every step ticked, keyed by the position the server asked about. */
const stepAnswers = ({ steps }) =>
    Object.fromEntries(steps.map((step) => [String(step.position), true]));

/** One option value per question, chosen from the options the server offered. */
const surveyAnswers = ({ questions }) =>
    Object.fromEntries(questions.map((question) => [question.key, question.options[0].value]));

async function main() {
    console.log(`Smoke testing the demo offer flow against ${origin}\n`);

    // Note on what this does *not* check: it used to flip `OFFERS_INCLUDE_DEMO` and `NODE_ENV`
    // in its own environment and assert that the catalog hid the demo offers and that `/demo`
    // 404'd. Those assertions cannot pass here. The script talks to a server somebody else
    // started -- the user's nodemon, in this case -- and that process read its environment when
    // it booted. Changing this process's `process.env` afterwards changes nothing about it, so
    // both checks were reporting failures that described the script's own environment rather
    // than the product. They are dropped rather than "fixed", because there is no version of
    // them that means anything without this script spawning the server itself. The demo-mode
    // matrix is covered in `test/server.test.js`, which boots the app with the environment it
    // needs.

    const catalog = await fetch(`${origin}/api/offers`);
    const offers = await catalog.json();
    check('the catalog is served', catalog.status === 200, `status ${catalog.status}`);
    check('the catalog is cacheable',
        /max-age=\d+/.test(catalog.headers.get('cache-control') || ''),
        catalog.headers.get('cache-control'));
    check('demo offers are listed', offers.filter((offer) => offer.is_demo).length > 0, `${offers.length} offers`);
    check('the catalog never leaks a tracking url', offers.every((offer) => offer.tracking_url === undefined));

    const taskPage = await fetch(`${origin}/demo`);
    check('the task page is served', taskPage.status === 200, `status ${taskPage.status}`);

    const unsigned = await fetch(`${origin}/api/click/1`, { method: 'POST' });
    check('a click without a session is refused', unsigned.status === 401, `status ${unsigned.status}`);

    await completeFlow('task', offerNetwork, stepAnswers);
    await completeFlow('survey', surveyNetwork, surveyAnswers);

    console.log('');
    if (failures === 0) {
        console.log('The demo offer and survey flow works end to end.');
    } else {
        console.log(`${failures} check(s) failed.`);
        process.exitCode = 1;
    }
}

main()
    .catch(async (error) => {
        console.error('\nThe smoke run did not finish:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());