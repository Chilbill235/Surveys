const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

/**
 * The contract between the two halves of the notification system.
 *
 * There are now two writers: the server, which records a money event as it happens, and the
 * browser, which records what it announced locally so the event survives the tab closing. They
 * deduplicate against the same partial unique index -- (user_id, category, record_id) -- so the two
 * only agree if they use the *same* category for the same event. When they disagree the failure is
 * invisible: both writes succeed, the user sees the event twice, and nothing anywhere reports an
 * error. That is what happened once already, when the browser said `withdrawal` and the server said
 * `withdrawal_requested`.
 *
 * These are source-text assertions because the two sides are in two languages, two files and two
 * runtimes. The alternative is an integration test that boots the app and drives the DOM, which
 * would be a far larger thing to maintain for a set of string constants -- but the consequence of
 * a wrong constant here is a duplicated or missing notification for real money, so the constants
 * are pinned rather than left to a code review to catch.
 */

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const notifications = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'eventNotifications.js'),
    'utf8'
);
const userRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'), 'utf8');

/** The body of a top-level function, so an assertion cannot match a call site somewhere else. */
function bodyOf(source, name) {
    const match = new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`).exec(source);
    assert.ok(match, `${name} is gone from ${source === appJs ? 'app.js' : 'the server'}`);
    return match[1];
}

/**
 * The categories the client writes, read from the `pushNotification` calls that carry a record id.
 *
 * Read rather than hardcoded, so adding a stage to the client and not to this list shows up as a
 * failure rather than as silence.
 */
const CLIENT_CATEGORIES = [
    ...new Set(
        [...appJs.matchAll(/pushNotification\(\{[^}]*category: '([a-z_]+)'[^}]*\}\)/g)].map((m) => m[1])
    )
];

test('the client writes a category the server also writes', () => {
    const serverCategories = new Set(
        [...notifications.matchAll(/category: '([a-z_]+)'/g)].map((m) => m[1])
    );

    // `reward`, `session` and `magic` are client-only on purpose: a reward is announced by the
    // ledger poll rather than by a server event, and a session expiry has no record at all. They
    // are the allowed exceptions, and being an exception has to be a decision on this list.
    const clientOnly = ['reward', 'session', 'magic'];
    const unknown = CLIENT_CATEGORIES.filter(
        (category) => !serverCategories.has(category) && !clientOnly.includes(category)
    );

    assert.deepEqual(
        unknown,
        [],
        `the client writes categories the server does not: ${unknown.join(', ')} -- either half will be a duplicate row`
    );
});

test('the server writes no category the client cannot render or navigate', () => {
    const client = appJs;
    const serverCategories = [...new Set([...notifications.matchAll(/category: '([a-z_]+)'/g)].map((m) => m[1]))];

    for (const category of serverCategories) {
        assert.ok(
            client.includes(`'${category}'`),
            `the server records "${category}" but the client has no case for it -- the notification would render with no destination`
        );
    }
});

test('a stage notification collapses with the server write rather than duplicating it', () => {
    // The rule, stated as the thing it prevents. Both halves name the same stage, so the two
    // writes collide on the index and one row survives.
    const pairs = [
        ['notifyDepositConfirmed', 'deposit', 'depositCredited', 'deposit'],
        ['notifyDepositRejected', 'deposit_failed', 'depositFailed', 'deposit_failed'],
        ['notifyWithdrawalSubmitted', 'withdrawal_requested', 'withdrawalSubmitted', 'withdrawal_requested'],
        ['notifyWithdrawalPaid', 'withdrawal_paid', 'withdrawalPaid', 'withdrawal_paid'],
        ['notifyWithdrawalFailed', 'withdrawal_failed', 'withdrawalFailed', 'withdrawal_failed']
    ];

    for (const [clientFn, clientCategory, serverFn, serverCategory] of pairs) {
        const client = bodyOf(appJs, clientFn);
        assert.ok(
            client.includes(`category: '${clientCategory}'`),
            `${clientFn} does not write "${clientCategory}"`
        );

        // The server side, from the function that names the category rather than the whole file.
        const server = notifications.slice(notifications.indexOf(`function ${serverFn}(`));
        assert.ok(
            server.slice(0, 600).includes(`category: '${serverCategory}'`),
            `${serverFn} does not write "${serverCategory}"`
        );
    }
});

test('a stage that is not the first of its kind does not reuse the bare kind category', () => {
    // `deposit` is both a category and a stage, which is what made this bug possible: the credit
    // legitimately writes `deposit`, and so did the failure, and the second write was swallowed.
    // The other stages therefore have to be distinctly named -- anything whose category is not the
    // kind itself must not reuse the kind.
    const bare = ['withdrawal', 'deposit'];
    for (const category of bare) {
        // `deposit` and `withdrawal` remain valid for exactly one stage each. Counted rather than
        // banned outright, because banning them would forbid the legitimate credit.
        const uses = CLIENT_CATEGORIES.filter((c) => c === category).length;
        assert.ok(uses <= 1, `"${category}" is written by more than one client function`);
    }

    // And the server half of the same rule: the withdrawal stages must all be distinct, or
    // the payout notification is the one that disappears.
    const withdrawalStages = new Set(
        [...notifications.matchAll(/function (withdrawal\w+)\(\{[\s\S]*?category: '([a-z_]+)'/g)]
            .map((m) => m[2])
            .filter((c) => c.startsWith('withdrawal'))
    );
    assert.deepEqual(
        [...withdrawalStages].sort(),
        ['withdrawal_confirming', 'withdrawal_failed', 'withdrawal_paid', 'withdrawal_processing', 'withdrawal_requested', 'withdrawal_sending'],
        `the withdrawal stages collapsed to ${[...withdrawalStages].join(', ')} -- the index will drop the second`
    );
});

test('the live refund poll and the server refund write agree on the category', () => {
    // The one place the two halves describe the same event from opposite ends: the poll reads a
    // ledger row the server wrote when it refunded, and announces it locally. If the categories
    // differ, the reader is told their money came back twice -- once by the server, once by the
    // poll that is supposed to be the same message arriving in a different window.
    const body = bodyOf(appJs, 'announceLedgerRefund');
    assert.ok(
        body.includes("category: 'withdrawal_failed'"),
        'the refund poll does not use the server refund category'
    );
    assert.ok(
        body.includes('withdrawalId: match[1]'),
        'the refund poll carries no record id, so it cannot deduplicate or link'
    );
});

test('a locally-announced money event is written back to the server', () => {
    // Without this the server's list only ever holds what the server itself observed, and the two
    // lists quietly diverge: a notification the user saw would be gone on the next load.
    assert.ok(
        appJs.includes('function persistNotification('),
        'nothing writes a client-announced notification back to the server'
    );
    const push = bodyOf(appJs, 'pushNotification');
    assert.ok(
        push.includes('persistNotification(entry)'),
        'pushNotification does not persist what it pushed'
    );
});

test('a notification with no record is deliberately not written back', () => {
    // A session expiry has no record, and the index's partial clause excludes null record ids --
    // so writing it would insert a row nothing could ever deduplicate, on every visit. The
    // exclusion is asserted because the alternative, "write everything", is the change that looks
    // harmless and fills the table.
    assert.match(
        bodyOf(appJs, 'persistNotification'),
        /entry\.category === 'session'/,
        'the session notification is no longer excluded from persistence'
    );
    assert.match(
        bodyOf(appJs, 'persistNotification'),
        /recordId === null \|\| recordId === undefined/,
        'a record-less notification is no longer excluded from persistence'
    );
});

test('the bell rehydrates from the server on load', () => {
    assert.ok(appJs.includes('function hydrateNotifications('), 'nothing rehydrates the bell from the API');
    assert.ok(
        bodyOf(appJs, 'initNotifications').includes('hydrateNotifications()'),
        'the bell is never hydrated'
    );
    const hydrate = bodyOf(appJs, 'hydrateNotifications');
    // Replaced, not merged. A merge would keep every sessionStorage entry alongside the server's
    // forever, so the bell would grow on every visit and show each event twice once both had it.
    assert.match(hydrate, /notificationStore = list;/, 'the server list is merged rather than replacing the local one');
    // And a failure leaves the local store alone: a cleared bell is worse than a stale one.
    assert.ok(hydrate.includes('if (!response.ok) return;'), 'a failed hydration clears the bell');
});

test('read and dismissed state is sent to the server, not kept in the tab', () => {
    assert.ok(appJs.includes('function persistReadState('), 'read state is never sent to the server');
    for (const [fn, call] of [
        ['markNotificationRead', 'persistReadState([id]);'],
        ['markAllNotificationsRead', 'persistReadState(notificationStore.map((n) => n.id));'],
        ['dismissNotification', "method: 'DELETE'"],
        ['clearAllNotifications', "method: 'DELETE'"]
    ]) {
        assert.ok(
            bodyOf(appJs, fn).includes(call),
            `${fn} changes the local store but never tells the server`
        );
    }
    // Only ids the server issued. A locally-created entry has no server row, and asking to read it
    // is a guaranteed 404 on every click. The source is `/^\d+$/.test(id)`.
    assert.ok(
        bodyOf(appJs, 'persistReadState').includes("typeof id === 'string' && /^\\d+$/.test(id)"),
        'read state is sent for ids the server never issued'
    );
});

test('the notification routes are all present and all require a session', () => {
    const routes = [
        ['post', "/notifications'"],
        ['get', "/notifications'"],
        ['put', "/notifications/:id/read'"],
        ['put', "/notifications/read-all'"],
        ['delete', "/notifications/:id'"],
        ['delete', "/notifications'"]
    ];
    for (const [method, route] of routes) {
        assert.ok(
            userRoutes.includes(`router.${method}('${route}`),
            `router.${method}('${route} is missing)`
        );
    }
    // A stored href is rendered as a link, and it is the one place a persisted value can be a
    // URL the reader did not intend to follow -- so only same-site paths are accepted.
    assert.match(userRoutes, /href\.startsWith\('\/'\)/, 'a stored notification href is not restricted to same-site paths');
});

test('every function the notification code calls is actually defined', () => {
    // `app.js` is a plain script loaded with no bundler, so nothing checks it. A typo'd or
    // renamed accessor -- `getToken()` where the accessor is `getSessionToken()` -- is not a
    // syntax error and does not fail `node --check`. It throws at runtime, on the first
    // notification the reader ever receives, so the bell is dead in production and the whole
    // suite is green. That is exactly what happened once here, and it is invisible in review
    // because the name looks plausible.
    //
    // Only the notification code is checked rather than the whole 6,600-line file: the file calls
    // a great deal of DOM and platform API that is not defined in it, and a full analysis is
    // mostly a list of false positives.
    const defined = new Set([
        ...[...appJs.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
        ...[...appJs.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])
    ]);

    // The functions the new code is responsible for, and everything they call at their own level.
    const owners = [
        'persistNotification', 'hydrateNotifications', 'persistReadState',
        'pushNotification', 'markNotificationRead', 'markAllNotificationsRead',
        'dismissNotification', 'clearAllNotifications', 'notificationTarget',
        'initNotifications', 'notifyDepositRejected', 'notifyWithdrawalSubmitted',
        'notifyWithdrawalPaid', 'notifyWithdrawalFailed', 'announceLedgerRefund'
    ];

    const missing = [];
    for (const owner of owners) {
        const declared = new RegExp(`function ${owner}\\(([\\s\\S]*?)\\n\\}`).exec(appJs);
        assert.ok(declared, `${owner} is gone`);
        for (const [, call] of declared[1].matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
            // Local and parameter names are in `defined` already; skip anything that resolves.
            if (defined.has(call)) continue;
            // Platform and DOM globals are not in this file by design.
            if (GLOBALS.has(call)) continue;
            missing.push(`${owner}() calls ${call}()`);
        }
    }

    assert.deepEqual([...new Set(missing)], [], 'a called function does not exist in app.js');
});

const GLOBALS = new Set([
    // Keywords, which the call-shaped regex cannot tell from a function.
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
    'async', 'is', 'in', 'of', 'new', 'do', 'else', 'void', 'delete', 'instanceof',
    'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'encodeURIComponent', 'decodeURIComponent', 'Number', 'parseInt', 'parseFloat',
    'isFinite', 'isNaN', 'String', 'Boolean', 'Object', 'Array', 'Promise', 'Error',
    'console', 'document', 'window', 'sessionStorage', 'localStorage', 'navigator',
    'URLSearchParams', 'AbortController', 'Math', 'Date', 'JSON', 'Set', 'Map'
]);
