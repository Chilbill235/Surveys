const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The live connection.
 *
 * The balance on screen is only as good as the loop that keeps it current, and a loop that stops
 * is worse than one that was never running: the indicator keeps saying "Live" and the number
 * quietly stops being true. Three of the bugs fixed here were of exactly that shape, and none of
 * them is visible to a source-reading test -- they are all about what happens to a request that
 * never comes back, so these tests run the real functions against a fake `fetch` and a clock
 * they control rather than reading the code and asserting on its shape.
 */

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** Extracts a top-level function declaration by name, as source text. */
function extract(name) {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not defined`);
    // `async` sits before the `function` keyword, so a naive slice from `start` produces a
    // non-async function whose `await` is a syntax error -- which is how `syncNow` first failed
    // to load here.
    const prefix = app.slice(0, start).endsWith('async ') ? 'async ' : '';
    const from = prefix ? start - prefix.length : start;
    const parenStart = app.indexOf('(', start);
    let depth = 0;
    let bodyStart = -1;
    for (let i = parenStart; i < app.length; i += 1) {
        if (app[i] === '(') depth += 1;
        else if (app[i] === ')') {
            depth -= 1;
            if (depth === 0) {
                bodyStart = app.indexOf('{', i);
                break;
            }
        }
    }
    assert.notEqual(bodyStart, -1, `could not find the body of ${name}`);
    depth = 0;
    for (let i = bodyStart; i < app.length; i += 1) {
        if (app[i] === '{') depth += 1;
        else if (app[i] === '}') {
            depth -= 1;
            if (depth === 0) return `${app.slice(from, bodyStart)}\n${app.slice(bodyStart, i + 1)}`;
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}

/** Slices the `liveState` object literal, so the tests run against the real state shape. */
function liveStateLiteral() {
    const start = app.indexOf('const liveState = {');
    assert.notEqual(start, -1, 'liveState is gone');
    const end = app.indexOf('};', start);
    return app.slice(start, end + 2);
}

/**
 * Slices the request ceiling as source, rather than hardcoding it.
 *
 * The point of the timeout tests is that a hang is bounded. A test that asserted its own copy of
 * the number would keep passing if someone deleted the ceiling from the app.
 */
function timeoutConstant() {
    const match = /const LIVE_SYNC_TIMEOUT_MS = [^;]+;/.exec(app);
    assert.ok(match, 'the sync request has no documented ceiling');
    return match[0];
}

/**
 * A clock the test drives.
 *
 * `setTimeout` records rather than waits, so a test can decide exactly when a backoff or a
 * request timeout elapses. Real timers would make this suite slow and, worse, flaky -- the
 * difference between "waits 20 seconds" and "never recovers" is the thing under test, and it
 * cannot be asserted by simply running slow.
 */
function fakeClock() {
    let nextId = 1;
    const pending = new Map();
    return {
        window: {
            setTimeout(callback, delay) {
                const id = nextId;
                nextId += 1;
                pending.set(id, { callback, delay });
                return id;
            },
            clearTimeout(id) {
                pending.delete(id);
            }
        },
        /** Runs every timer currently pending, and reports what was scheduled. */
        runAll() {
            const entries = [...pending.entries()];
            pending.clear();
            entries.forEach(([, { callback }]) => callback());
            return entries.map(([, { delay }]) => delay);
        },
        delays() {
            return [...pending.values()].map(({ delay }) => delay);
        },
        count() {
            return pending.size;
        }
    };
}

/**
 * Runs the real loop against a fake server.
 *
 * `fetchImpl` receives the options, including the abort signal, so a test can model a request
 * that never answers by waiting for the signal instead of resolving.
 */
/**
 * Slices a top-level `const NAME = ...;` declaration out of the source.
 *
 * The harness runs the real functions rather than reimplementing them, so anything they close
 * over has to come from the file too. Slicing rather than restating is what stops the test
 * asserting against a copy: a hardcoded threshold here would keep passing if the app's changed.
 */
function constant(name) {
    const pattern = new RegExp(`const ${name} = [^;]+;`);
    const match = pattern.exec(app);
    assert.ok(match, `${name} is gone`);
    return match[0];
}

function buildLoop({ fetchImpl, token = 'a-token', hidden = false } = {}) {
    const clock = fakeClock();
    const calls = { fetch: 0, painted: 0, stopped: 0 };
    const source = [
        liveStateLiteral(),
        timeoutConstant(),
        constant('LIVE_SYNC_FAILURE_THRESHOLD'),
        extract('liveConnectionFailing'),
        extract('liveIntervalMs'),
        extract('scheduleLiveSync'),
        extract('stopLiveSync'),
        extract('syncNow')
    ].join('\n');

    const factory = new Function(
        'window',
        'document',
        'fetch',
        'AbortController',
        'getSessionToken',
        'paintLiveIndicator',
        'handleUnauthorized',
        'applyLiveUpdate',
        'calls',
        `${source}
        return { liveIntervalMs, scheduleLiveSync, syncNow, stopLiveSync, liveState };`
    );

    const api = factory(
        clock.window,
        { hidden },
        fetchImpl,
        typeof AbortController === 'function' ? AbortController : undefined,
        () => token,
        () => { calls.painted += 1; },
        () => false,
        () => {},
        calls
    );

    // `navigator` is read by the painters, and `syncNow` itself does not need it -- supplied so
    // the extracted source evaluates as it does in a browser.
    const withNavigator = { ...api };
    return { api: withNavigator, state: api.liveState, clock, calls };
}

/** A `fetch` that never resolves, and rejects only if the caller aborts it. */
function hangingFetch() {
    return (url, options = {}) => {
        calls().count += 1;
        return new Promise((resolve, reject) => {
            if (!options.signal) return;
            options.signal.addEventListener('abort', () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                reject(error);
            });
        });
    };
}

let fetchCounter = 0;
function calls() {
    return { count: fetchCounter };
}

test('a request that never comes back is abandoned rather than freezing the balance', async () => {
    fetchCounter = 0;
    // The point of the whole exercise. A hung request used to hold `busy` for ever: every later
    // sync returned at its first line, the `finally` that would have rescheduled never ran, and
    // the page sat on a stale number with the indicator still reading "Live". A failure was
    // survivable because it rejected and recovered; a hang was not survivable at all.
    const { api, state, clock } = buildLoop({ fetchImpl: hangingFetch() });

    const inFlight = api.syncNow();
    assert.equal(state.busy, true, 'the first sync did not start');

    // Nothing has come back yet. One timer should exist: the request's own ceiling.
    const [firstDelay] = clock.delays();
    assert.ok(firstDelay > 0, 'the request was given no timeout, so a hang would last for ever');

    // Let the ceiling elapse, which aborts it. The test drives the clock, so this is instant.
    clock.runAll();

    const result = await inFlight;
    assert.equal(result, false, 'an abandoned request reported a change');
    assert.equal(state.busy, false, 'the sync is still marked busy, so no further sync can run');
    assert.equal(state.consecutiveFailures, 1, 'an abandoned request was not counted as a failure');

    // And, the part that makes it recoverable: the loop scheduled its next attempt.
    assert.equal(clock.count(), 1, 'the loop stopped instead of retrying');
});

test('the loop keeps running after the connection comes back', async () => {
    fetchCounter = 0;
    // Recovering is the other half of the bug. A loop that survives a hang and then gives up on
    // the first retry would leave the user with a permanently stale balance and a correct-looking
    // indicator, which is the same failure one step later.
    let mode = 'hang';
    const seen = [];
    const { api, state, clock } = buildLoop({
        fetchImpl: (url, options = {}) => {
            seen.push(url);
            if (mode === 'hang') return hangingFetch()(url, options);
            // A full 200 rather than a 304, because the 304 branch deliberately leaves
            // `version` alone -- nothing new was learned -- and this case is about what a
            // recovered connection does when it next reaches the server for real.
            return Promise.resolve({
                status: 200,
                ok: true,
                json: async () => ({ version: 'v1', balance: '8.00', demoBalance: '7.75' })
            });
        }
    });

    const stuck = api.syncNow();
    clock.runAll();
    await stuck;
    assert.equal(state.consecutiveFailures, 1);
    assert.ok(state.consecutiveFailures > 0, 'precondition: the loop is in a failed state');

    // The connection recovers.
    mode = 'ok';
    await api.syncNow();
    assert.equal(state.consecutiveFailures, 0, 'a successful sync did not clear the failure count');
    assert.equal(state.version, 'v1', 'a successful sync did not record what it learned');

    // And the next wait is back to the normal idle beat rather than a backoff, which is what
    // tells the user the page is healthy again rather than merely hopeful.
    assert.ok(
        clock.delays().every((delay) => delay <= 20000),
        `the loop is still backing off after recovering: ${clock.delays()}ms`
    );
});

test('backoff is not cancelled by a payment in progress', () => {
    // Ordering, and the ordering was wrong. The deposit fast-path was checked first, so a
    // payment in progress pinned the interval at its fast rate however badly the connection was
    // failing -- meaning the one moment the loop is guaranteed to be running is the one moment it
    // cannot back off. A server struggling to answer is exactly the server that fast retries
    // keeps struggling.
    const { api, state } = buildLoop();
    state.awaitingDeposit = true;

    const prompt = api.liveIntervalMs();
    assert.ok(prompt <= 5000, `a payment in progress polls slowly: ${prompt}ms`);

    // A *sustained* failure still backs off, payment or not.
    state.consecutiveFailures = 2;
    assert.ok(
        api.liveIntervalMs() > prompt,
        'a connection that is actually failing is still retried at the payment rate'
    );
    // And it backs off further the longer it goes on.
    const firstBackoff = api.liveIntervalMs();
    state.consecutiveFailures = 4;
    assert.ok(api.liveIntervalMs() > firstBackoff, 'the backoff does not grow');

    // Bounded, and bounded low. The cap used to be two minutes, which for a balance page is a
    // long time to keep showing a figure that is known not to be current.
    state.consecutiveFailures = 50;
    assert.ok(
        api.liveIntervalMs() <= 30000,
        `the backoff reaches ${api.liveIntervalMs()}ms, so a recovered connection is not noticed for minutes`
    );

    // Recovered means prompt again, payment or not.
    state.consecutiveFailures = 0;
    assert.equal(api.liveIntervalMs(), prompt);
});

test('one failed poll is a hiccup, not a lost connection', () => {
    // The single most visible bug in this area, and the reason the page spent so long telling
    // people their connection was gone. Any one failed poll -- a phone changing network, a slow
    // response -- painted "Connection lost" and started a backoff that could reach two minutes.
    // So the page announced a broken connection for a blip that was already over, and then spent
    // the next two minutes refusing to update because of it.
    const { api, state } = buildLoop();
    const threshold = Number(
        /const LIVE_SYNC_FAILURE_THRESHOLD = (\d+)/.exec(app)[1]
    );
    assert.ok(threshold >= 2, 'a single failure still declares the connection lost');

    // One failure is not yet a failure pattern, so the loop keeps the same cadence it would have
    // had without it, rather than starting to back off over one bad response.
    state.awaitingDeposit = true;
    state.consecutiveFailures = 0;
    const prompt = api.liveIntervalMs();
    state.consecutiveFailures = threshold - 1;
    assert.equal(
        api.liveIntervalMs(),
        prompt,
        'a single failure already changed the polling cadence'
    );

    // At the threshold it is a pattern, and the loop does back off.
    state.consecutiveFailures = threshold;
    assert.ok(api.liveIntervalMs() > prompt, 'sustained failure never backs off');
});

test('the idle cadence is short enough to be worth calling live', () => {
    // The interval used to be twenty seconds, which is not a balance page that updates itself --
    // it is a page that refreshes every twenty seconds and calls it live. The endpoint answers
    // one indexed lookup, and an unchanged account costs a 304 with no body at all, so the
    // cadence was buying nothing worth a twenty-second delay in every deposit, withdrawal and
    // balance update.
    const { api, state } = buildLoop();
    state.awaitingDeposit = false;
    state.consecutiveFailures = 0;
    const idle = api.liveIntervalMs();
    assert.ok(idle <= 10000, `the idle interval is ${idle}ms, which is not real time`);

    // And a payment in progress is the case the user is actually watching, so it is the faster
    // of the two rather than merely a faster-than-before one.
    state.awaitingDeposit = true;
    assert.ok(api.liveIntervalMs() <= idle, 'waiting for a payment is not the prompt case');
});

test('coming back online resyncs immediately instead of waiting out a backoff', () => {
    // The reconnection case the backoff made worst. The browser tells us for free when the
    // network returns; the old behaviour was to keep waiting out an interval that could be two
    // minutes, so the network came back and the page sat there announcing a lost connection and
    // refusing to update until the backoff expired. `online` is the answer.
    assert.match(app, /addEventListener\('online'/, 'reconnection is not handled');
    assert.match(app, /addEventListener\('offline'/, 'going offline is not handled');

    // Focus is the same argument for a window that was never hidden -- switching windows does
    // not always fire `visibilitychange`, so a page could sit focused-but-idle.
    assert.match(app, /window\.addEventListener\('focus'/, 'regaining focus does not resync');

    // And each of them clears the failure count, because the failures belonged to a network
    // that no longer exists, then syncs at once. Matched over the whole listener rather than up
    // to the reset, because the reset is the first thing in the block and a window that stops
    // there would not see the `syncNow` that has to follow it.
    for (const label of ['online', 'focus']) {
    const handler = new RegExp(
        `addEventListener\\('${label}'[\\s\\S]{0,900}?\\}\\);`
    ).exec(app);
    assert.ok(handler, `the ${label} listener is not wired`);
    assert.match(handler[0], /consecutiveFailures = 0;/, `${label} does not clear the failure count`);
    assert.match(handler[0], /syncNow\(\)/, `${label} waits for the next interval instead of syncing`);
    }
});

test('being offline is reported as offline, not as a lost connection', () => {
    // A different fact with a different remedy. "Connection lost" sends someone to reload the
    // page or blame the site; "You are offline" sends them to their wifi. `navigator.onLine` is
    // answered from the OS rather than inferred, so there is nothing to guess at.
    const header = extract('paintLiveIndicator');
    assert.match(header, /navigator\.onLine === false/, 'the header ignores being offline');
    assert.match(header, /You are offline/, 'being offline is not stated');

    // Both indicators, or the page contradicts itself within one screen.
    const freshness = extract('paintBalanceFreshness');
    assert.match(freshness, /navigator\.onLine === false/, 'the freshness line ignores being offline');
    assert.match(freshness, /You are offline/, 'being offline is not stated on the freshness line');
});

test('a stopped loop stays stopped', () => {
    // `syncNow` reschedules itself from a `finally`, so clearing the timer alone never stopped
    // anything: any stop requested while a request was in flight was undone when that request
    // settled. The auth path is where this showed up -- the session was discarded, the loop was
    // told to stop, and it resumed polling an endpoint it could not authenticate against.
    const { api, state, clock } = buildLoop();
    api.scheduleLiveSync();
    assert.equal(clock.count(), 1);

    api.stopLiveSync();
    assert.equal(clock.count(), 0, 'the pending timer survived the stop');
    assert.equal(state.stopped, true);

    // A reschedule attempt while stopped must not quietly put the loop back.
    api.scheduleLiveSync();
    assert.equal(clock.count(), 0, 'the loop restarted after being stopped');

    // And a start is what undoes a stop, in either order.
    state.timer = undefined;
    api.scheduleLiveSync();
    assert.equal(clock.count(), 0);
});

test('a page restored from the back/forward cache starts syncing again', () => {
    // `pagehide` stops the loop, which is right for a real navigation. It also fires when a page
    // enters the bfcache, and a page restored from there never re-runs its scripts -- so with
    // nothing to restart it, the balance sat frozen at whatever it was when the user clicked
    // away, while the indicator kept saying "Live". Back is how people come back to check.
    assert.match(
        app,
        /addEventListener\('pageshow'/,
        'a restored page never restarts its live sync'
    );
    assert.match(
        app,
        /addEventListener\('pageshow',[\s\S]*?if \(event\.persisted\) startLiveSync\(\);/,
        'the restore is not wired to a restart'
    );
});

test('a failure before the first success does not report an absurd age', () => {
    // `lastSyncedAt` starts at zero, and a first failure can arrive before anything has ever set
    // it. The age was then measured from the epoch, so a page that had simply never reached the
    // server reported "last updated 1789000000s ago" -- which is not a wrong number so much as a
    // nonsense one, and it undercuts the indicator that exists to be trusted.
    assert.match(app, /const LIVE_SYNC_TIMEOUT_MS = \d+;/, 'the sync has no documented ceiling');

    const indicator = /function paintLiveIndicator\(\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(indicator, 'paintLiveIndicator is gone');
    assert.match(
        indicator[1],
        /liveState\.lastSyncedAt\s*\n?\s*\?[^:]*: 0/,
        'the age is still measured from zero when nothing has ever synced'
    );
});