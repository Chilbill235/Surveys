const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The transactions list pages, and the page has to be cut on the server.
 *
 * The endpoint returns five rows at a time now, with the true total in `X-Total-Count`, and the
 * filter tabs ask the server for their own type. The reason is arithmetic rather than taste: a
 * window cut before a filter is applied counts the wrong rows, so the Deposits tab would show
 * three of twenty and "page 2" would skip or repeat depending on where the deposits happened
 * to fall. These are structural assertions over the real source, because the properties being
 * protected are about which query runs and what the response header says -- neither of which a
 * unit test of a helper would catch if the route stopped using it.
 */

const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'),
    'utf8'
);
const historyPage = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'history.js'),
    'utf8'
);
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const accountHtml = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'account.html'),
    'utf8'
);

/** The body of the `/history` route handler, by brace matching from its declaration. */
function historyHandler() {
    const start = routes.indexOf("router.get('/history'");
    assert.notEqual(start, -1, 'the /history route is not registered');
    const bodyStart = routes.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < routes.length; i += 1) {
        const character = routes[i];
        if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) return routes.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces while extracting the /history handler');
}

test('the history page is cut on the server, and reports the true total', () => {
    const body = historyHandler();

    // The window and the count have to be applied to the same set, or the total describes rows
    // the caller will never be shown. The window function is what makes them one round trip and
    // therefore one moment.
    assert.match(body, /COUNT\(\*\) OVER \(\) AS total_count/, 'the total is not counted with the page');
    assert.match(body, /LIMIT \$2 OFFSET \$3/, 'the page is not windowed in SQL');
    assert.match(body, /res\.set\('X-Total-Count'/, 'the total is not reported to the client');

    // Bound, never interpolated. Both parameters are attacker-controlled, and the range check
    // in `positiveIntFromQuery` is what stops a negative or absurd value reaching the database.
    assert.doesNotMatch(body, /LIMIT \$\{req\.query/, 'a query parameter is interpolated into SQL');
    assert.doesNotMatch(body, /OFFSET \$\{req\.query/, 'a query parameter is interpolated into SQL');
});

test('an empty page past the end still reports the real total', () => {
    // A window function cannot supply a count on a page with no rows, because there are no rows
    // to carry it. Substituting the offset instead -- the tempting one-liner -- invents a
    // screenful of pages that do not exist for anyone who reaches a stale deep page.
    const body = historyHandler();
    assert.match(
        body,
        /result\.rows\.length === 0 && offset > 0[\s\S]*SELECT COUNT\(\*\)::INT AS total/,
        'an empty page falls back to a total that is not counted'
    );
    assert.doesNotMatch(
        body,
        /X-Total-Count'.*\? offset :/s,
        'the total is still being inferred from the offset'
    );
});

test('the type filter is applied in the query, not to an already-cut page', () => {
    const body = historyHandler();

    // Filtering after the window is the bug this replaces. The predicate has to sit in the
    // WHERE clause so the count and the rows describe the same set.
    assert.match(
        body,
        /AND \(\$4::TEXT IS NULL OR transaction_type = \$4\)/,
        'the type filter is not part of the query that counts and pages'
    );

    // A closed vocabulary, and an unknown type refused rather than treated as no filter --
    // silently returning everything would hide a client bug behind a list that looks right.
    assert.match(body, /Unknown history type/, 'an unknown type is not refused');
    assert.match(routes, /HISTORY_FILTER_TYPES = new Set\(/, 'the accepted types are not a fixed list');

    // The `all` tab has to reach the unfiltered path, not a filter that happens to match
    // everything today.
    assert.match(body, /=== 'all' \? null : requestedType/, 'the all tab does not take the unfiltered path');
});

test('the list shows five rows a page, and pages on the server', () => {
    assert.match(historyPage, /const HISTORY_PAGE_SIZE = 5;/, 'the page size is not five');

    // The offset is derived from the page number, so the two cannot disagree.
    assert.match(
        historyPage,
        /offset: String\(\(historyPage - 1\) \* HISTORY_PAGE_SIZE\)/,
        'the offset is not derived from the page number'
    );
    assert.match(historyPage, /limit: String\(HISTORY_PAGE_SIZE\)/, 'the page size is not sent to the server');

    // The filter tab is a server-side query parameter, not a client-side `Array.filter` over a
    // page that has already been cut.
    assert.match(historyPage, /params\.set\('type', historyFilter\)/, 'the tab is not sent to the server');
    assert.doesNotMatch(
        historyPage,
        /historyCache\.filter\(\(item\) => item\.transaction_type/,
        'the tab is still filtered in the browser after the page was cut'
    );

    // The click has to *set* the filter, not merely re-request with whatever is in it. When the
    // filtering moved to the server the handler kept its reload and lost the assignment, so
    // every tab sent no `type` and rendered the same unfiltered list under a different heading --
    // Deposits showing withdrawals, with a total that matched neither. Asserting that the
    // parameter is read is not enough; this is the write that feeds it.
    assert.match(
        historyPage,
        /historyFilter = button\.dataset\.filter/,
        'clicking a filter tab does not change the filter that is sent'
    );

    // The total is read from the header, because deriving it from the rows returned makes the
    // last page look like the only one.
    assert.match(historyPage, /X-Total-Count/, 'the page count is not read from the response header');
});

test('the pagination controls exist, and only appear when there is somewhere to go', () => {
    assert.match(accountHtml, /id="history-pagination"/, 'there are no pagination controls on the page');
    assert.match(accountHtml, /id="history-page-prev"/, 'there is no previous control');
    assert.match(accountHtml, /id="history-page-next"/, 'there is no next control');

    // A single-page history must not show "Page 1 of 1" -- a control that cannot do anything,
    // and one that invites the reasonable question of what Next would do.
    assert.match(
        historyPage,
        /if \(historyTotal <= HISTORY_PAGE_SIZE\) \{\s*nav\.hidden = true;/,
        'the controls are shown when the whole history fits on one page'
    );

    // The status is a live region, so a screen reader is told where in the list it is now
    // rather than only that something changed.
    assert.match(accountHtml, /id="history-page-status"[^>]*aria-live="polite"/, 'the page status is not announced');
});

test('a late response cannot repaint the tab the user is not on', () => {
    // The live refresh and a filter click race: the user switches to Deposits, the in-flight
    // All request lands afterwards, and the tab they just chose is overwritten. The monotonic
    // request id is what prevents that, and the drop has to happen before any state is written.
    assert.match(historyPage, /historyRequestId/, 'requests are not numbered');
    assert.match(
        historyPage,
        /if \(requestId !== historyRequestId\) return;/,
        'a stale response is not discarded'
    );
    assert.match(
        historyPage,
        /if \(document\.hidden\) return;/,
        'a hidden tab still refetches'
    );
});

test('the real-time refresh reuses the live-sync poll rather than adding a timer', () => {
    // A timer on the history page would poll the same server on a second, independent schedule
    // and refetch the whole list every few seconds even when nothing changed. `/api/user/updates`
    // already polls, already answers 304 when still, and already carries the rows that moved.
    assert.match(
        app,
        /new CustomEvent\('offerNetwork:historyChanged'/,
        'the live update does not tell the history page anything'
    );
    assert.match(
        historyPage,
        /window\.addEventListener\('offerNetwork:historyChanged'/,
        'the history page does not listen for it'
    );
    assert.doesNotMatch(historyPage, /setInterval/, 'the history page polls on its own schedule');
});

test('the CSV export asks for the whole history, not one page', () => {
    // Five rows a page is right for a list and wrong for a file. An export that quietly covered
    // one page is indistinguishable from an account with five transactions.
    assert.match(
        app,
        /requestJson\('\/api\/user\/history\?limit=500'/,
        'the export does not ask for more than one page'
    );
    // The confirmation states the number of rows written, so a truncated file says so.
    assert.match(app, /Downloaded \$\{count\} transaction/, 'the export does not report its row count');
});
