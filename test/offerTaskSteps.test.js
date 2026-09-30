const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Task-step validation.
 *
 * This module decides whether a user may claim a payout for an offer, so it is the one piece of
 * the offers system with a money consequence. It had no test at all -- `offer_task_steps`,
 * `taskStepsAreValid` and `loadOfferTaskSteps` appeared nowhere under `test/`. The gap was
 * invisible because the surrounding paths were exercised: the live end-to-end test completes an
 * offer, but only when `TEST_DATABASE_URL` is set, and it is skipped by default. So on a normal
 * run, the rule that decides who gets paid was never executed.
 *
 * The functions are exercised directly against a stubbed pool, because the rules are the point.
 * Both are `async` -- `taskStepsAreValid` shares a signature with `answersAreValid` and both are
 * awaited at their call sites -- so every assertion here awaits. Forgetting to would not fail
 * here: `assert.equal(Promise, false)` fails loudly, which is the only reason it is worth
 * writing this down.
 */

/** Reads the real module with a stubbed pool, so the validation rules are the ones under test. */
function loadModule(rows = []) {
    const servicePath = path.join(__dirname, '..', 'src', 'services', 'offerTaskSteps.js');
    const dbPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

    // `offerTaskSteps` requires `../config/db` and keeps the pool in module scope, so the only
    // way to exercise it without a database is to put a fake at that resolved path before the
    // service loads. Re-seeded on every call rather than once, so each test gets its own rows.
    const previous = require.cache[dbPath];
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { query: async () => ({ rows }) }
    };
    delete require.cache[require.resolve(servicePath)];
    const loaded = require(servicePath);
    if (previous) require.cache[dbPath] = previous;
    else delete require.cache[dbPath];

    return loaded;
}

const STEPS = [
    { position: 1, prompt: 'Open the site', actionLabel: 'Open the site', url: 'https://example.com' },
    { position: 2, prompt: 'Confirm your email', actionLabel: 'I confirmed my email', url: null },
    { position: 3, prompt: 'Make a purchase', actionLabel: 'I made a purchase', url: null }
];

test('every step must be ticked', async () => {
    const { taskStepsAreValid } = loadModule(STEPS);

    assert.equal(await taskStepsAreValid({ 1: true, 2: true, 3: true }, STEPS), true, 'a fully ticked task is rejected');

    // Each one missing on its own. Ticked-but-fewer is the shape a user produces by scrolling
    // past a step, so it is the case that actually happens and it must not pass.
    assert.equal(await taskStepsAreValid({ 1: true, 2: true }, STEPS), false, 'an unfinished task was accepted');
    assert.equal(await taskStepsAreValid({ 2: true, 3: true }, STEPS), false, 'a task with its first step skipped was accepted');
    assert.equal(await taskStepsAreValid({}, STEPS), false, 'an empty task was accepted');
});

test('only a real tick counts', async () => {
    const { taskStepsAreValid } = loadModule(STEPS);

    // The client sends booleans, but the endpoint is public and the payload is attacker-supplied,
    // so what matters is that the server cannot be convinced by something truthy that is not a
    // tick. `"true"` and `1` are the two that would slip through a naive truthiness check.
    assert.equal(await taskStepsAreValid({ 1: 'true', 2: true, 3: true }, STEPS), false, 'a string was accepted as a tick');
    assert.equal(await taskStepsAreValid({ 1: 1, 2: true, 3: true }, STEPS), false, 'the number 1 was accepted as a tick');
    assert.equal(await taskStepsAreValid({ 1: 'on', 2: true, 3: true }, STEPS), false, 'the checkbox value was accepted as a tick');
});

test('a task with no steps cannot be completed', async () => {
    const { taskStepsAreValid } = loadModule([]);

    // The fail-closed direction, and it is deliberate. An offer whose steps failed to load --
    // a missing row, a bad `url`, a prompt edited out -- would otherwise be completable for free,
    // because "tick nothing" satisfies "tick everything" over an empty list. Refusing is the only
    // answer that cannot pay someone for an offer with no definition.
    assert.equal(await taskStepsAreValid({}, []), false, 'a task with no steps was completable');
    assert.equal(await taskStepsAreValid({ 1: true }, []), false, 'a task with no steps was completable with a tick');
    assert.equal(await taskStepsAreValid({}, undefined), false, 'a missing task definition was completable');
    assert.equal(await taskStepsAreValid({}, null), false, 'a null task definition was completable');
});

test('the ticks must be an object, not a list', async () => {
    const { taskStepsAreValid } = loadModule(STEPS);

    // A JSON array is an object to `typeof`, so a guard that only asks `typeof ticks === 'object'`
    // would accept `[{position:1},{position:2},{position:3}]`. Positions come out as undefined and
    // the ticks read as unticked, so it fails today -- but on the strength of the loop, not on the
    // guard, which is the kind of thing that stops being true the moment the loop changes.
    assert.equal(await taskStepsAreValid([{ position: 1 }], STEPS), false, 'an array of ticks was accepted');
    assert.equal(await taskStepsAreValid(null, STEPS), false, 'null was accepted');
    assert.equal(await taskStepsAreValid(undefined, STEPS), false, 'undefined was accepted');
    assert.equal(await taskStepsAreValid('yes', STEPS), false, 'a string was accepted');
});

test('a step row missing its prompt or label cannot be served', async () => {
    // A step with no prompt renders as a blank line the user is asked to tick, and one with no
    // label has nothing to click. Both are dropped by the loader rather than repaired, because a
    // repaired step is a step the participant was never shown.
    const { loadOfferTaskSteps } = loadModule([
        { position: 1, prompt: 'Real step', action_label: 'Do it', url: null },
        { position: 2, prompt: '', action_label: 'No prompt', url: null },
        { position: 3, prompt: 'No label', action_label: '', url: null }
    ]);

    const steps = await loadOfferTaskSteps(1);
    assert.equal(steps.length, 1, 'an unrenderable step was served');
    assert.equal(steps[0].prompt, 'Real step');
    assert.equal(steps[0].actionLabel, 'Do it');
});

test('a step url is only usable over http, so a script url cannot become a link', async () => {
    // The url is rendered as an anchor the participant clicks, so a `javascript:` value would be
    // script injection delivered by whoever can write a row -- and delivered to the user, on a
    // page whose whole job is to be clicked through. Checked once on the way out, per step.
    const { loadOfferTaskSteps } = loadModule([
        { position: 1, prompt: 'Safe', action_label: 'Go', url: 'https://example.com' },
        { position: 2, prompt: 'Script', action_label: 'Go', url: 'javascript:alert(1)' },
        { position: 3, prompt: 'Data', action_label: 'Go', url: 'data:text/html,<script>alert(1)</script>' },
        { position: 4, prompt: 'Relative', action_label: 'Go', url: '/offers' }
    ]);

    const steps = await loadOfferTaskSteps(1);
    // `new URL()` normalises, so the served value is the parsed one and the trailing slash is
    // expected rather than a defect -- what matters is that it parsed and stayed http(s).
    assert.equal(steps[0].url, 'https://example.com/', 'a safe url was dropped');
    assert.equal(steps[1].url, null, 'a javascript: url was served as a link');
    assert.equal(steps[2].url, null, 'a data: url was served as a link');
    assert.equal(steps[3].url, null, 'a relative url was served as a link');
});

test('the loader bounds what one offer can ask of a participant', async () => {
    // Unbounded, anyone able to insert a row could make the page render an unbounded number of
    // steps -- and the payout is claimed by ticking all of them.
    //
    // Asserted on the query rather than on the returned rows, because the cap is a SQL `LIMIT`
    // and the stubbed pool ignores one. Testing it by feeding 40 rows through a stub would prove
    // only that the stub returns what it was given -- which is exactly the bug this file exists
    // to prevent, one level down.
    const { loadModuleWithSpies } = require('./offerTaskStepsTestHelper');
    const { loadOfferTaskSteps, MAX_STEPS, seen } = loadModuleWithSpies([
        { position: 1, prompt: 'Step 1', action_label: 'Do it', url: null }
    ]);

    assert.ok(MAX_STEPS <= 20, `the step cap is ${MAX_STEPS}`);
    await loadOfferTaskSteps(1);

    assert.equal(seen.length, 1, 'the loader issued more than one query');
    assert.match(seen[0].text, /LIMIT\s+\$2/i, 'the step query has no bounded LIMIT');
    assert.equal(seen[0].params[1], MAX_STEPS, 'the LIMIT is not bound to the cap');
});

test('a non-positive or fractional offer id loads nothing', async () => {
    // The id is interpolated as a parameter, so this is about not asking the database a question
    // with no answer: `WHERE offer_id = NULL` matches nothing, and a fractional or zero id is not
    // an offer. Returns `[]` rather than throwing, which is what makes the completion path able to
    // report "no steps configured" instead of a 500.
    const { loadOfferTaskSteps } = loadModule([]);
    for (const id of [0, -1, 1.5, 'abc', null, undefined, NaN]) {
        assert.deepEqual(await loadOfferTaskSteps(id), [], `offer id ${String(id)} loaded steps`);
    }
});

test('the completion endpoint awaits the step check', () => {
    // The one bug in this file that the tests above cannot catch, and the most expensive one in
    // the offers system.
    //
    // `taskStepsAreValid` is `async`. At its single call site it was written
    // `if (!taskStepsAreValid(answers, steps))` with no `await`, so the condition tested a
    // Promise, which is always truthy, so `!truthy` is always false and the check never rejected
    // anything. Every step-based offer could be completed by posting `{"answers": {}}` and taking
    // the full payout without doing any of it.
    //
    // It was invisible because it is not a crash: no error, no log line, a normal 200 with a
    // correct-looking credit. Every unit test in this file passed throughout -- the function was
    // behaving perfectly and simply was not being consulted. Only an end-to-end submission of an
    // incomplete payload finds it, which is what `scripts/smoke-survey-flow.js` now does.
    //
    // So this asserts the call site, not the function. It is a source-level check by necessity,
    // and it is here precisely because the behavioural coverage was blind to this.
    const path = require('node:path');
    const fs = require('node:fs');
    const controller = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'controllers', 'demoController.js'), 'utf8'
    );

    const callSite = /if \(!([\s\S]{0,40}?)taskStepsAreValid\(/g;
    const calls = [...controller.matchAll(callSite)];
    assert.ok(calls.length > 0, 'the step check is no longer called at all');
    for (const call of calls) {
        assert.ok(
            call[1].includes('await'),
            'the step check is not awaited, so its Promise is always truthy and it never rejects'
        );
    }

    // The survey branch is the one that was always right, and it is asserted so that "fix" is not
    // later applied to both branches by someone who has read about the bug and not its scope.
    const surveyCall = /if \(!([\s\S]{0,40}?)answersAreValid\(/g;
    for (const call of [...controller.matchAll(surveyCall)]) {
        assert.ok(call[1].includes('await'), 'the survey answer check is not awaited');
    }
});

test('a long prompt or label cannot break the page it is rendered into', async () => {
    // Truncated on the way out. A prompt edited to be enormous is a layout problem on a page that
    // is rendered for a payout the user is waiting on, so it is bounded rather than trusted.
    const { loadOfferTaskSteps } = loadModule([
        { position: 1, prompt: 'p'.repeat(5000), action_label: 'l'.repeat(5000), url: null }
    ]);

    const [step] = await loadOfferTaskSteps(1);
    assert.ok(step.prompt.length <= 300, `the prompt was ${step.prompt.length} characters`);
    assert.ok(step.actionLabel.length <= 120, `the label was ${step.actionLabel.length} characters`);
});