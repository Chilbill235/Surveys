const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');
const { creditConfirmedDeposit } = require('../src/services/depositCredit');

const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'), 'utf8');
const historyJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'history.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '027_ledger_deposit_link.sql'),
    'utf8'
);

/**
 * Getting from a notice about a deposit to that deposit's row in the history list.
 *
 * This is a join across four tables and two files, and each of those seams is a place where the
 * feature can be present in one half and silently absent in the other. A notification can carry
 * an id the list has no row for; a row can carry a record id the client does not render; a
 * fragment can name an id the page writes under a different format. All three look identical
 * from the outside -- a link that goes nowhere and a page that appears to ignore the click.
 */

/** The resolver the route uses, lifted and run, so these are not assertions about source text. */
function historyRecordFrom(row) {
    const start = routes.indexOf('function historyRecordFrom(');
    assert.notEqual(start, -1, 'historyRecordFrom is not in userRoutes.js');
    const parenStart = routes.indexOf('(', start);
    let depth = 0;
    let bodyStart = -1;
    for (let i = parenStart; i < routes.length; i += 1) {
        if (routes[i] === '(') depth += 1;
        else if (routes[i] === ')') {
            depth -= 1;
            if (depth === 0) { bodyStart = routes.indexOf('{', i); break; }
        }
    }
    let braces = 0;
    let end = -1;
    for (let i = bodyStart; i < routes.length; i += 1) {
        if (routes[i] === '{') braces += 1;
        else if (routes[i] === '}') {
            braces -= 1;
            if (braces === 0) { end = i; break; }
        }
    }
    const source = `${routes.slice(start, bodyStart)}\n${routes.slice(bodyStart, end + 1)}`;
    return new Function(`${source}\nreturn historyRecordFrom;`)();
}

const record = historyRecordFrom();

test('a withdrawal debit and its refund both resolve to the same withdrawal', () => {
    // The two rows are one event seen from each side: the debit took the money out, the refund
    // put it back. `source_id` spells them differently -- `87` and `withdrawal:87` -- so anything
    // reading the column directly has to know both, and the two spellings are the only thing
    // separating "linked" from "a row that quietly has no link".
    const debit = record({ transaction_type: 'withdrawal', source_id: '87', deposit_id: null });
    const refund = record({ transaction_type: 'refund', source_id: 'withdrawal:87', deposit_id: null });
    assert.deepEqual(debit, { kind: 'withdrawal', id: '87' });
    assert.deepEqual(refund, { kind: 'withdrawal', id: '87' });
});

test('a deposit credit resolves through the column, not through source_id', () => {
    // `source_id` for a deposit is the *provider's* payment id, so it cannot say which of our
    // deposits it was. That is the whole reason the column exists.
    const row = record({
        transaction_type: 'deposit',
        source_id: 'nowpayments:1234567',
        deposit_id: 87
    });
    assert.deepEqual(row, { kind: 'deposit', id: '87' });
});

test('a reward, a demo reward and an adjustment have no record, and that is not an error', () => {
    // Most rows in the list have nothing behind them. A resolver that treated an unresolvable
    // row as a failure would be wrong about most of what it renders.
    for (const row of [
        { transaction_type: 'conversion', source_id: 'demo:1acbdaa4-5934', deposit_id: null },
        { transaction_type: 'conversion', source_id: 'offer:7', deposit_id: null },
        { transaction_type: 'adjustment', source_id: null, deposit_id: null },
        { transaction_type: 'deposit', source_id: 'nowpayments:1234567', deposit_id: null }
    ]) {
        assert.equal(record(row), null, `${row.transaction_type} was given a record it does not have`);
    }
});

test('a source_id that is not an id is refused rather than linked', () => {
    // `source_id` is a column this app writes, but it is text and the result becomes part of a
    // client-built fragment. Refusing here keeps that from being the client's problem.
    for (const source of ['withdrawal:abc', 'withdrawal:', ' 87 x', 'withdrawal:8;7', 'x'.repeat(40)]) {
        assert.equal(
            record({ transaction_type: 'refund', source_id: source, deposit_id: null }),
            null,
            `${JSON.stringify(source)} was linked as a withdrawal`
        );
    }
});

test('a credit writes the deposit id onto the ledger row', () => {
    // The behavioural test for the column, through the real credit path. A structural assertion
    // that the SQL mentions `deposit_id` would pass against a column that is selected, never
    // written -- which is the state this started in.
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const statements = [];
    const respond = async (query, params) => {
        statements.push({ sql: String(query), params });
        if (/UPDATE deposits\s+SET status = 'confirmed'/.test(String(query))) {
            return { rows: [{ user_id: 7, amount: '10.00' }], rowCount: 1 };
        }
        return { rows: [{ id: 1 }], rowCount: 1 };
    };
    pool.query = respond;
    pool.connect = async () => ({ query: respond, release() {} });

    return (async () => {
        try {
            await creditConfirmedDeposit(
                { query: respond },
                { id: 87, ledger_source_id: 'nowpayments:555', provider_payment_id: '555' },
                'Confirmed NOWPayments deposit'
            );
        } finally {
            pool.query = originalQuery;
            pool.connect = originalConnect;
        }

        const insert = statements.find((s) => /INSERT INTO balance_transactions/.test(s.sql));
        assert.ok(insert, 'no ledger row was written for the credit');
        assert.match(insert.sql, /deposit_id/, 'the credit does not record which deposit it was');
        // The deposit id is the *last* parameter, and it has to be the deposit's own id rather
        // than the provider payment id that happens to sit next to it in the call.
        assert.equal(
            insert.params[insert.params.length - 1],
            87,
            'the ledger row is not linked to the deposit'
        );
        assert.notEqual(insert.params[insert.params.length - 1], '555', 'the provider id was written as the deposit id');
    })();
});

test('the migration adds the column, and backfills what it can exactly', () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS deposit_id BIGINT/, 'the column is not added');
    // `ON DELETE SET NULL` because a ledger row is a financial record and must outlive the
    // record it refers to; the alternative failure direction is deleting the credit.
    assert.match(
        migration,
        /REFERENCES deposits \(id\) ON DELETE SET NULL/,
        'a deleted deposit would take its credit with it'
    );
    // The backfill joins on the provider id, which is exact rather than a guess.
    assert.match(migration, /nowpayments:' \|\| d\.provider_payment_id/, 'the backfill is not exact');
    assert.match(migration, /stripe:' \|\| d\.provider_payment_id/, 'the stripe backfill is missing');
    // And it only fills rows that do not already have a value, so a re-run is harmless.
    assert.match(migration, /WHERE bt\.deposit_id IS NULL/, 'the backfill can overwrite a good value');
});

test('the history response carries the resolved record on every row', () => {
    assert.match(routes, /deposit_id,/, 'the query does not select the column');
    assert.match(
        routes,
        /record: historyRecordFrom\(row\)/,
        'the resolved record is not on the response'
    );
});

test('the history page puts the id on the row the fragment names', () => {
    // The two halves of the format, in two different files. `historyRowId` lives in app.js
    // because the notification builds the fragment there, and history.js uses it to name the
    // row -- so there is one format rather than two that have to agree.
    assert.match(
        historyJs,
        /row\.id = historyRowId\(record\.kind, record\.id\)/,
        'the history rows carry no id, so a fragment can match nothing'
    );
    assert.match(appJs, /function historyRowId\(/, 'the row id helper is gone');
});

test('a link to a row scrolls to it, marks it, and moves focus to it', () => {
    // Scrolling alone is not enough for a keyboard or screen-reader user, and neither is
    // focusing alone for everyone else. All three, because arriving somewhere is the entire
    // purpose of the link.
    assert.match(historyJs, /scrollIntoView\(/, 'the target row is not scrolled to');
    assert.match(historyJs, /classList\.add\('is-focused'\)/, 'the target row is not marked');
    assert.match(historyJs, /setAttribute\('tabindex', '-1'\)/, 'the row is not focusable');
    assert.match(historyJs, /target\.focus\(/, 'focus is not moved to the target row');
});

test('the fragment is validated before it is used to find a row', () => {
    // Anything can send a user to `/account#anything`, and the value ends in a `getElementById`.
    assert.match(
        historyJs,
        /\^history-\(deposit\|withdrawal\)-/,
        'the fragment is not matched against the shape this page produces'
    );
    const gate = /function pendingFocusHash\(\) \{([\s\S]*?)\n\}/.exec(historyJs);
    assert.ok(gate, 'pendingFocusHash is gone');
    assert.match(gate[1], /\.test\(hash\)/, 'the fragment is returned without being validated');
});

test('a link to a row that is not on the current page looks for it', () => {
    // Five rows to a page, and the reader may be on a filter and page three. "Not on this page"
    // says nothing about whether the record exists, so the page has to go and find it rather
    // than leaving a link that appears to do nothing.
    assert.match(historyJs, /searchForHistoryTarget/, 'nothing searches for the target');
    // Bounded, and for a stated reason: a notice is about something recent, and walking every
    // page of a long account to find a months-old record is a burst of requests for something
    // the reader has stopped caring about.
    assert.match(historyJs, /FOCUS_SEARCH_PAGES/, 'the search is not bounded');
    // And a hash change while the reader is already here has to be handled, or the link does
    // nothing at all: changing only the fragment navigates to nothing and reloads nothing.
    assert.match(
        historyJs,
        /addEventListener\('hashchange'/,
        'a notification clicked while already on the page does nothing'
    );
    assert.match(historyJs, /initHistoryFocus\(\)/, 'the focus wiring is never started');
});

test('a walk that ends without the row says so instead of leaving silence', () => {
    // The load-bearing case this feature can still get wrong. The walk is bounded, so it will
    // finish without finding the row for real reasons: a record from before history was kept, or
    // one no filter of this list covers. Before this, that ended in silence, and silence after
    // "your withdrawal is on its way" is indistinguishable from a broken link -- the reader has
    // followed a link, the page has not moved, and nothing has told them why. So the walk gives
    // up *visibly*.
    assert.match(
        historyJs,
        /function renderHistoryTargetMissing\(\)/,
        'the notice is never rendered'
    );

    // The walk gives up in exactly one place, and that place sets the flag. Asserted on the
    // give-up branch rather than the happy one, because the happy branch clearing a flag it
    // never set is not the behaviour under test.
    const walk = /function searchForHistoryTarget\(\) \{([\s\S]*?)\n\}/.exec(historyJs);
    assert.ok(walk, 'searchForHistoryTarget is gone');
    assert.match(
        walk[1],
        /focusTargetMissing = true;\s*\n\s*renderHistoryTargetMissing\(\);\s*\n\s*return;/,
        'the walk gives up without announcing that the row was not found'
    );

    // It has to be shown through the DOM, not held in a variable: a flag nothing renders is the
    // same silence with more code.
    assert.match(historyJs, /notice\.hidden = !focusTargetMissing/, 'the notice is not shown or hidden');
    assert.match(historyJs, /notice\.textContent = focusTargetMissing/, 'the notice is not given words');

    // And it must not outlive its reason. Reaching the row, or asking for a different one, has
    // to withdraw it -- a notice that contradicts the screen is worse than no notice.
    const found = /function focusHistoryTarget\(\) \{([\s\S]*?)\n\}/.exec(historyJs);
    assert.match(found[1], /focusTargetMissing = false/, 'the notice survives arriving at the row');

    const wired = /function initHistoryFocus\(\) \{([\s\S]*?)\n\}/.exec(historyJs);
    assert.match(
        wired[1],
        /focusTargetMissing = false/,
        'a notice about the previous row stays up while the next one is looked for'
    );
});

test('the notice lives somewhere the pagination repaint cannot erase', () => {
    // `history-page-status` is rewritten by `renderHistoryPagination` on every list repaint --
    // filters, pages, and the live refresh all call it. Sharing that element would mean the
    // notice appears and then silently vanishes on the next refresh, which is the failure mode
    // all over again, only slower and more confusing.
    assert.match(
        historyJs,
        /getElementById\('history-target-missing'\)/,
        'the notice does not have an element of its own'
    );
    const helper = /function renderHistoryTargetMissing\(\) \{([\s\S]*?)\n\}/.exec(historyJs);
    assert.ok(helper, 'renderHistoryTargetMissing is gone');
    assert.doesNotMatch(
        helper[1],
        /history-page-status/,
        'the notice is written into the pagination status'
    );

    // The markup side, because a `getElementById` for an element no page defines returns null
    // and the helper returns early -- back to silence, with a guard that looks like it works.
    const account = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');
    assert.match(account, /id="history-target-missing"/, 'no page defines the element the notice is written to');
    // Announced, not just coloured: it is the only feedback a reader gets that the link did not
    // resolve, and it appears after a navigation, so nothing else will say it.
    assert.match(
        account,
        /id="history-target-missing"[^>]*aria-live="polite"/,
        'the notice is not announced to assistive technology'
    );
    assert.match(
        account,
        /id="history-target-missing"[^>]*role="status"/,
        'the notice is not a status region'
    );
    // Hidden rather than empty. An always-present empty live region is announced as a blank on
    // every single page load, which is noise that trains people to ignore announcements.
    assert.match(account, /id="history-target-missing"[^>]*hidden/, 'the notice starts visible');

    // And a class with no rule would be caught by the frontend checker, but the rule is what
    // makes it read as a note rather than as body text floating in the list.
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.history-target-missing \{/, 'the notice has no styling');
});

test('the notice explains itself rather than reporting a failure', () => {
    // The row is not there; the money is not lost. Copy that reads as an error sends someone
    // looking for a problem that does not exist, and copy that says "not found" without saying
    // what to do leaves them exactly where they started.
    assert.match(
        historyJs,
        /const HISTORY_TARGET_MISSING_COPY =[\s\S]*?;/,
        'the notice has no copy of its own'
    );
    const copy = /const HISTORY_TARGET_MISSING_COPY =\s*'([^']*)'/.exec(historyJs);
    assert.ok(copy, 'the copy is not a single readable sentence');
    assert.doesNotMatch(
        copy[1],
        /error|failed|could not|unable|problem/i,
        `the notice reads as a failure: "${copy[1]}"`
    );
    // It has to point somewhere. Two concrete reasons, both real, and a way to look for the row
    // by other means is what makes this a dead end the reader can act on.
    assert.match(copy[1], /tab/i, 'the notice does not mention the filters that may cover the row');
    assert.match(copy[1], /history/i, 'the notice does not say what was not found');
});
