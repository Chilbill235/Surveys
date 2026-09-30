const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Why a hand-inserted $10 was announced as "credited from a completed offer."
 *
 * The live sync reports a balance, and the client had no other way to know what changed it. It
 * therefore computed the delta, subtracted the deposits and refunds it had already announced in
 * the same update, and treated whatever was left as an offer reward -- because an offer reward
 * is the only cause the page has vocabulary for.
 *
 * A balance can go up for several other reasons, and every one of them was reported as an offer:
 * an operator correcting a row, a bonus, a migration, a test credit typed straight into the
 * Neon console. The user saw "Reward credited -- $10.00 credited to your balance from a
 * completed offer" for money they had just created by hand.
 *
 * The fix is to stop inferring the cause from the size of a change. `/api/user/updates` now
 * returns the ledger rows behind the balance, and the announcement is driven by the row's
 * `transaction_type` rather than by arithmetic.
 *
 * `public/app.js` is a browser script with no module boundary, so the loop is lifted out by brace
 * matching and run against stubs. That tests the text that actually ships.
 */

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'),
    'utf8'
);

/**
 * Extracts a named function declaration from the script by matching braces from its body.
 *
 * The parameter list is skipped first, because a destructured one contains braces that are not
 * the body: `pushNotification({ title, message, tone = 'info' })` has a `}` before its first
 * statement, and counting from the first `{` after the name returns the signature and nothing
 * else. Any test asserting on the body of such a function then failed against a fragment that
 * contained none of it.
 */
function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in public/app.js`);

    // Walk the parameter list to its matching `)`. Depth counting rather than `indexOf`, so a
    // default value containing a paren does not end the walk early.
    const parenStart = source.indexOf('(', start);
    let parenDepth = 0;
    let parenEnd = -1;
    for (let i = parenStart; i < source.length; i += 1) {
        if (source[i] === '(') parenDepth += 1;
        else if (source[i] === ')') {
            parenDepth -= 1;
            if (parenDepth === 0) { parenEnd = i; break; }
        }
    }
    assert.notEqual(parenEnd, -1, `unbalanced parentheses in the parameters of ${name}`);

    const bodyStart = source.indexOf('{', parenEnd);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        const character = source[i];
        if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}

/**
 * Runs `applyLiveUpdate` with a stubbed notification layer and returns what was announced.
 *
 * The whole function is lifted rather than just the announcement loop, because the loop's
 * correctness depends on the seeding flag and the seen-set it shares with the rest of the
 * function. Testing the loop alone would miss a reset that wiped the set, or a first-update
 * flag that was never set.
 */
function runUpdate(payload, {
    liveState,
    isEventSinceLastSeen,
    writeLastSeenAt,
    withdrawalStateSeen,
    markWithdrawalSeen,
    creditedDepositsSeen,
    depositStateSeen
} = {}) {
    const announced = [];
    // Collected rather than dispatched. This harness lifts one function out of a browser
    // script, so there is no `window` to dispatch on, and the real-time history refresh is a
    // side effect of exactly this function -- so a stub that records the call is what lets the
    // tests below see it at all.
    const historyChanges = [];
    // The announcement paths, by name, so a test can assert a specific one fired rather than
    // inferring it from a toast. The toast layer is shared by deposits, withdrawals and
    // rewards, so it cannot tell them apart on its own.
    const notified = { deposit: [], withdrawalPaid: [], withdrawalFailed: [], success: [] };
    // The seeding gate and the timestamp write, both real module-level functions in the script
    // that this harness lifts a single function out of. Defaulted so the tests above exercise
    // the announcement paths; the tests that are about seeding pass their own.
    const seededGate = isEventSinceLastSeen || (() => true);
    const seededWrite = writeLastSeenAt || (() => {});
    const state = liveState || {
        lastKnownBalance: NaN,
        lastKnownDemoBalance: NaN,
        seenTransactionIds: new Set(),
        seeded: false
    };
    const context = {
        liveState: state,
        accountState: { balance: 0, demoBalance: 0 },
        applyBalance() {},
        isDialogOpen: () => false,
        updateWithdrawFields() {},
        updateDepositFields() {},
        renderHistoryInto() {},
        paintDepositStatus() {},
        notifyDepositConfirmed: (item) => notified.deposit.push(item),
        notifyWithdrawalPaid: (item) => notified.withdrawalPaid.push(item),
        notifyWithdrawalFailed: (item) => notified.withdrawalFailed.push(item),
        showDepositSuccess: (item) => notified.success.push(item),
        updateDepositAmountHint() {},
        updateDepositSwapOffer() {},
        showToast: (title, message) => announced.push({ title, message, tone: 'success' }),
        // Only the toast is recorded. The same announcement is deliberately delivered twice --
        // once on screen and once to the notification bell -- and counting both would make every
        // assertion in this file off by a factor of two.
        pushNotification() {},
        // `applyLiveUpdate` announces a reward through the same category -> destination table
        // every other notice uses, so the extracted function reads it. The harness supplies the
        // other module-level dependencies the same way; without this it is a ReferenceError on
        // a constant that has nothing to do with what these tests are about.
        NOTIFICATION_TARGETS: {
            deposit: { href: '/account', label: 'View transactions' },
            withdrawal: { href: '/account', label: 'View withdrawals' },
            reward: { href: '/account', label: 'View transactions' },
            survey: { href: '/offers', label: 'Browse offers' },
            magic: { href: '/offers', label: 'Sign in' }
        },
        formatBalance: (value) => `$${Number(value).toFixed(2)}`,
        lastKnownDeposits: null,
        withdrawalStateSeen: withdrawalStateSeen || (() => false),
        markWithdrawalSeen: markWithdrawalSeen || (() => {}),
        creditedDepositsSeen: creditedDepositsSeen || { has: () => true, add() {} },
        // The deposit announcements are keyed on the state as well as the id, so that a deposit
        // which is first seen pending and then fails is still announced. Supplied here under
        // both names because `applyLiveUpdate` uses the state-keyed store and the harness has
        // always stubbed the id-only one.
        depositStateSeen: depositStateSeen || {
            has: () => true,
            add() {}
        },
        isEventSinceLastSeen: seededGate,
        // The other half of that mechanism: applied at the end of every update so a later tab
        // measures new events against this moment.
        writeLastSeenAt: seededWrite,
        window: {
            dispatchEvent: (event) => historyChanges.push(event?.detail ?? null)
        },
        // A browser global too, and the only reason the event carries a `detail` at all. The
        // plain object it becomes is enough: the listener in `history.js` reads the detail, and
        // nothing here depends on it being a real `CustomEvent`.
        CustomEvent: class CustomEvent {
            constructor(type, options) {
                this.type = type;
                this.detail = options?.detail;
            }
        }
    };
    const factory = vm.createContext(Object.assign(context, { payload }));
    vm.runInContext(
        `${extractFunction('applyLiveUpdate')}\napplyLiveUpdate(payload);`,
        factory
    );
    return { announced, notified, state, historyChanges };
}

/**
 * Applies an empty first update so the page is past its seeding pass.
 *
 * The first payload a page receives describes the world as it found it, and nothing in it is
 * announced. Every "this SHOULD be announced" case therefore has to open the page first, the
 * same way a real session does.
 */
function openedState() {
    const state = {
        lastKnownBalance: Number.NaN,
        lastKnownDemoBalance: Number.NaN,
        seenTransactionIds: new Set(),
        seeded: false
    };
    runUpdate({ balance: '0.00', demoBalance: '0.00', transactions: [] }, { liveState: state });
    return state;
}

test('an offer reward is announced, and named from the ledger', () => {
    // The case that has to keep working. `conversion` is what `postbackController` writes for a
    // real offer reward and what `demoController` now writes for a completed demo, so this is
    // the only type that means "you finished something".
    const { announced } = runUpdate({
        balance: '10.00',
        demoBalance: '0.00',
        transactions: [{
            id: '900',
            amount: '10.00',
            transaction_type: 'conversion',
            description: 'Offer reward - Acme',
            is_demo: false
        }]
    }, { liveState: openedState() });
    assert.equal(announced.length, 1, 'a completed offer reward was not announced');
    assert.match(announced[0].title, /Reward credited/);
    assert.match(announced[0].message, /\$10\.00/);
    // The ledger's own words, not a fixed sentence. This is the whole point of the change.
    assert.match(announced[0].message, /Acme/);
});

test('a manual credit is not announced as a completed offer', () => {
    // The reported bug. An operator typed $10 into the balance and a conversion-looking row into
    // the ledger; the page called it an offer reward. An `adjustment` is a manual correction by
    // definition, so it must never produce an offer announcement.
    const { announced } = runUpdate({
        balance: '10.00',
        demoBalance: '0.00',
        transactions: [{
            id: '901',
            amount: '10.00',
            transaction_type: 'adjustment',
            description: 'Test balance',
            is_demo: false
        }]
    });
    assert.equal(announced.length, 0, 'a manual adjustment was announced as an offer reward');
});

test('a balance change with no ledger row behind it announces nothing', () => {
    // The other half of the fix. The old code inferred the cause from the delta alone, so a
    // balance edited without a ledger row was still reported as an offer. With no row there is
    // no cause to state, and inventing one is the failure.
    const { announced } = runUpdate({
        balance: '999.00',
        demoBalance: '0.00',
        transactions: []
    });
    assert.equal(announced.length, 0, 'an unexplained balance change was announced');
});

test('a demo reward is not announced as real money', () => {
    // `is_demo` credits `demo_balance`, and it is the flag that says which. A real-money demo
    // completion writes `is_demo = FALSE` and *should* announce; a test-balance one must never
    // be announced in the wording that means spendable money.
    //
    // The assertion is about the wording rather than about the count, because a demo reward is a
    // real event the user just performed and announcing it is correct -- as a demo reward. The
    // mistake this guards against is "added to your balance from", which is the sentence that
    // means the money is theirs to spend. Silencing demo rewards entirely was the previous
    // behaviour, and it was a side effect of the balance-delta heuristic this file exists to
    // remove: the row was skipped here, and the notice came from comparing two numbers
    // instead, so it was neither reliably announced nor reliably worded.
    const { announced } = runUpdate({
        balance: '0.00',
        demoBalance: '5.00',
        transactions: [{
            id: '902',
            amount: '5.00',
            transaction_type: 'conversion',
            description: 'Non-cash demo reward - Test offer',
            is_demo: true
        }]
    });
    assert.ok(
        announced.every((entry) => !/added to your balance from/.test(entry.message)),
        'a non-cash demo reward was announced as real money'
    );
    for (const entry of announced) {
        assert.match(entry.title, /Demo/i, 'a demo reward was announced without saying it was a demo');
        assert.match(entry.message, /demo/, 'a demo reward was announced without saying it was a demo');
    }
});

test('the first update seeds the seen set without replaying history', () => {
    // Without seeding, opening the page fires a toast for every reward the account has ever
    // received -- twenty at once, for money that arrived last month. The first payload is the
    // state the page found, so it is recorded without being announced.
    const { announced, state } = runUpdate({
        balance: '50.00',
        demoBalance: '0.00',
        transactions: [
            { id: '1', amount: '10.00', transaction_type: 'conversion', description: 'Old reward', is_demo: false },
            { id: '2', amount: '20.00', transaction_type: 'conversion', description: 'Old reward', is_demo: false }
        ]
    });
    assert.equal(announced.length, 0, 'existing rewards were announced on page load');
    assert.ok(state.seenTransactionIds.has('1'), 'the first row was not recorded as seen');
    assert.ok(state.seenTransactionIds.has('2'), 'the second row was not recorded as seen');
});

test('a reward that lands after the first update is announced exactly once', () => {
    // The `seen` set is what stops a poll that returns the same twenty rows every twenty
    // seconds from announcing the same reward forever, and what stops a credit that appears in
    // both the deposit list and the ledger from being announced twice.
    const state = openedState();

    const row = {
        id: '910',
        amount: '10.00',
        transaction_type: 'conversion',
        description: 'Offer reward - Acme',
        is_demo: false
    };
    const first = runUpdate({ balance: '10.00', demoBalance: '0.00', transactions: [row] }, { liveState: state });
    assert.equal(first.announced.length, 1, 'a new reward was not announced');

    // The same poll again, as happens on every interval.
    const second = runUpdate({ balance: '10.00', demoBalance: '0.00', transactions: [row] }, { liveState: state });
    assert.equal(second.announced.length, 0, 'the same reward was announced twice');
});

/**
 * The real-time refresh for the transaction list is a side effect of this function.
 *
 * The history page has no timer of its own -- it listens for this event instead. That is the
 * whole reason it can update without polling `/api/user/history` on a second schedule, and it
 * is the property the list's "updates in real time" claim rests on. If the dispatch is dropped
 * the page still works, but silently stops being live, which is exactly the kind of regression
 * that no other assertion here would notice.
 */
test('new ledger rows tell the history page to refetch', () => {
    const state = openedState();

    const withRow = runUpdate({
        balance: '10.00',
        demoBalance: '0.00',
        transactions: [{
            id: '920',
            amount: '10.00',
            transaction_type: 'conversion',
            description: 'Offer reward - Acme',
            is_demo: false
        }]
    }, { liveState: state });
    assert.equal(withRow.historyChanges.length, 1, 'a new ledger row did not ask the list to refresh');

    // An update that carried nothing new must not ask for a refetch. A poll runs every twenty
    // seconds, and refetching the list on each one would be a request whose result cannot
    // differ from the rows already on screen.
    const nothing = runUpdate({ balance: '10.00', demoBalance: '0.00', transactions: [] }, { liveState: state });
    assert.equal(nothing.historyChanges.length, 0, 'the list was told to refetch with nothing new to show');

    // A test reward moves the test balance, and it is a real row on the All tab -- a user
    // completing their first demo offer is the one thing worth seeing appear live. It is
    // deliberately not excluded here, unlike the real-money toast, which must not call it cash.
    const demo = runUpdate({
        balance: '10.00',
        demoBalance: '5.00',
        transactions: [{
            id: '921',
            amount: '5.00',
            transaction_type: 'conversion',
            description: 'Demo offer reward',
            is_demo: true
        }]
    }, { liveState: state });
    assert.equal(demo.historyChanges.length, 1, 'a demo reward did not refresh the list');
    // The test balance going up is still announced -- as a *demo* reward. What must not appear
    // is the real-money wording, which is the mistake the `is_demo` flag exists to prevent.
    assert.ok(
        demo.announced.every((entry) => !/added to your balance from/.test(entry.message)),
        'a demo reward was announced as real money'
    );
});

test('the old balance-delta inference is gone', () => {
    // Structural, because the arithmetic could be reintroduced anywhere: an operator's edit and
    // a legitimate offer reward produce the identical number, so any code that reasons from the
    // delta alone is back to guessing.
    const body = extractFunction('applyLiveUpdate');
    // A fixed sentence is fine as the fallback for a ledger row that carries no description of
    // its own. What must not come back is a *delta* -- the sum of an unexplained increase is
    // what turned a hand-typed $10 into "from a completed offer".
    assert.doesNotMatch(
        body,
        /creditedDepositTotal|refundedWithdrawalTotal/,
        'the delta-subtraction accumulators are still in the live update path'
    );
    assert.doesNotMatch(
        body,
        /delta\s*[><=]/,
        'the live update still reasons from a balance delta'
    );
    // And the announcement must be gated on the ledger's own type, not merely present.
    assert.match(
        body,
        /transaction_type !== 'conversion'/,
        'an announcement is no longer gated on the ledger row being an offer reward'
    );
});

test('the updates endpoint returns the ledger and versions on it', () => {
    // Both halves are needed. The rows without the version change would never be delivered,
    // because a balance change with no ledger row is invisible to the old version string -- and
    // a balance change with a ledger row *is* visible, so the version keeps the client polling
    // correctly either way.
    assert.match(routes, /FROM balance_transactions WHERE user_id = u\.id/, 'the ledger is not versioned');
    assert.match(routes, /row\.ledger_at/, 'the ledger timestamp is not in the version');
    assert.match(routes, /transactions: ledger\.rows/, 'the ledger rows are not returned');
    assert.match(routes, /is_demo/, 'the demo flag is not selected, so a test credit cannot be told apart');
});

// ---------------------------------------------------------------------------
// Once, on the event
//
// Everything above is about *what* is announced. These are about *how often*, which is a
// separate question with a separate set of failure modes: the two dedupe sets are scoped to a
// tab, and a tab is the thing that closes.
// ---------------------------------------------------------------------------

/** A withdrawal row in a terminal state, with the timestamp that says when. */
function withdrawal(id, status, at) {
    return {
        id,
        amount: '1.00',
        status,
        paid_at: status === 'paid' ? at : null,
        updated_at: at,
        failure_reason: null,
        payout_status: 'FINISHED',
        payment_method: 'crypto',
        asset_code: 'SOL',
        network: 'solana',
        payment_address: 'Ygs89NQwoq9SdAY7urzmfD5nQFt3tVJwn3hAJTbR'
    };
}

/** An empty first update, to move a page past its seeding pass. */
function emptyUpdate(overrides = {}) {
    return runUpdate(
        { balance: '0.00', demoBalance: '0.00', transactions: [], withdrawals: [], deposits: [] },
        { isEventSinceLastSeen: () => false, ...overrides }
    );
}

test('a new tab does not replay every withdrawal the account has ever had', () => {
    // The bug. `sessionStorage` is scoped to one tab, so it is empty the instant a second tab
    // opens, and both the withdrawal and deposit loops ran on the first payload without any
    // seeding guard -- which is what the `firstUpdate` flag was for, applied to the ledger rows
    // and never to these two. Opening a tab then fired "Withdrawal sent" once per historical
    // withdrawal and "Deposit credited" once per historical deposit, all at once.
    //
    // The gate is the timestamp, not a blanket skip: a row older than the last time this browser
    // was told about is history, and a row newer than it is an event that happened while the tab
    // was closed. Both are asserted, because either half alone would pass a weaker version of
    // this test -- skipping everything would "fix" the burst and silently lose the real event.
    const history = [
        withdrawal(1, 'paid', '2026-09-01T10:00:00.000Z'),
        withdrawal(2, 'failed', '2026-09-02T10:00:00.000Z')
    ];
    const { notified } = runUpdate(
        { balance: '0.00', demoBalance: '0.00', transactions: [], deposits: [], withdrawals: history },
        { isEventSinceLastSeen: () => false }
    );
    assert.equal(notified.withdrawalPaid.length, 0, 'a past withdrawal was re-announced on a new tab');
    assert.equal(notified.withdrawalFailed.length, 0, 'a past failure was re-announced on a new tab');
});

test('a withdrawal that finished while the tab was closed is still announced', () => {
    // The other half, and the reason the gate is a comparison rather than a skip. The whole
    // point of polling is to tell someone their money left while they were not looking, and a
    // naive "ignore the first payload" fix throws that away.
    const { notified } = runUpdate(
        {
            balance: '0.00',
            demoBalance: '0.00',
            transactions: [],
            deposits: [],
            withdrawals: [withdrawal(9, 'paid', '2026-09-30T17:00:00.000Z')]
        },
        { isEventSinceLastSeen: (at) => at === '2026-09-30T17:00:00.000Z' }
    );
    assert.equal(notified.withdrawalPaid.length, 1, 'a payout that landed while away was not announced');
    assert.equal(notified.withdrawalPaid[0].id, 9);
});

test('a first-ever visit announces nothing, because there is nothing to compare against', () => {
    // No stored timestamp means no basis for ordering, and guessing "announce it" is the burst
    // this mechanism exists to prevent. The rows are still marked seen, so the next poll is
    // silent too rather than re-deciding.
    const { notified, state } = runUpdate(
        {
            balance: '0.00',
            demoBalance: '0.00',
            transactions: [],
            deposits: [],
            withdrawals: [withdrawal(1, 'paid', '2026-09-01T10:00:00.000Z')]
        },
        { isEventSinceLastSeen: () => false }
    );
    assert.equal(notified.withdrawalPaid.length, 0);
    assert.equal(state.seeded, true, 'the first payload did not finish the seeding pass');
});

test('a withdrawal is announced once, not on every poll that still returns it', () => {
    // The `seen` set, exercised through the real loop rather than asserted structurally. The
    // harness gives `withdrawalStateSeen` a working implementation backed by a Set, which is
    // what the page does, and the same row is then delivered three times as a five-second poll
    // would.
    const seen = new Set();
    const deps = {
        withdrawalStateSeen: (id, status) => seen.has(`${id}:${status}`),
        markWithdrawalSeen: (id, status) => seen.add(`${id}:${status}`)
    };

    const first = runUpdate(
        { balance: '0.00', demoBalance: '0.00', transactions: [], deposits: [], withdrawals: [withdrawal(3, 'paid', '2026-09-30T17:00:00.000Z')] },
        { ...deps, liveState: { lastKnownBalance: 0, lastKnownDemoBalance: 0, seenTransactionIds: new Set(), seeded: true } }
    );
    assert.equal(first.notified.withdrawalPaid.length, 1, 'the payout was not announced');

    for (const attempt of [1, 2]) {
        const again = runUpdate(
            { balance: '0.00', demoBalance: '0.00', transactions: [], deposits: [], withdrawals: [withdrawal(3, 'paid', '2026-09-30T17:00:00.000Z')] },
            { ...deps, liveState: { lastKnownBalance: 0, lastKnownDemoBalance: 0, seenTransactionIds: new Set(), seeded: true } }
        );
        assert.equal(again.notified.withdrawalPaid.length, 0, `the same payout was announced again on poll ${attempt}`);
    }
});

test('the timestamp is recorded after every update, so the next tab has something to measure against', () => {
    // Written at the end rather than the start: a payload that throws partway through must not
    // leave a timestamp claiming the user was told about announcements that never happened.
    const stamps = [];
    emptyUpdate({ writeLastSeenAt: (at) => stamps.push(at) });
    assert.equal(stamps.length, 1, 'the last-seen moment was not recorded');
    assert.ok(Number.isFinite(stamps[0]), 'the recorded moment is not a usable number');
});

test('the list of payments renders without announcing anything', () => {
    // `loadPaymentHistory` used to mark a settled withdrawal as seen and open the credit screen
    // for a newly-credited deposit, without announcing either. The live sync is not "about to"
    // run -- it is on a timer, and this list is fetched on a timer of its own -- so opening the
    // withdraw dialog first consumed the notification permanently: the row said "Withdrawal sent"
    // and the user was never told, with the flag already set and no way left to be told.
    const body = extractFunction('loadPaymentHistory');
    for (const forbidden of [
        'markWithdrawalSeen',
        'creditedDepositsSeen',
        'showDepositSuccess',
        'notifyDepositConfirmed'
    ]) {
        assert.ok(
            !new RegExp(`\\b${forbidden}\\b`).test(body),
            `the payment list still reaches for ${forbidden}, so a list load can consume or steal a notification`
        );
    }
    // It still renders, and still counts what has settled for the balance refresh.
    assert.match(body, /buildHistoryRow\(item, kind\)/, 'the payment list no longer renders rows');
});

test('a second deposit crediting while the success screen is open is still announced', () => {
    // The success screen is a modal, so it can only show one deposit. Returning early when it
    // is open used to mean the second credit was announced nowhere -- the caller had already
    // marked the id seen, so no later poll retried it either, and it disappeared silently.
    const body = extractFunction('showDepositSuccess');
    assert.match(
        body,
        /if \(!dialog \|\| dialog\.open\) \{[\s\S]{0,200}?notifyDepositConfirmed\(deposit\)/,
        'a credit arriving while the success screen is open is dropped instead of toasted'
    );
    // And the normal path announces it too, once, after the facts are on screen.
    assert.match(body, /notifyDepositConfirmed\(deposit\)/, 'the success screen no longer notifies');
});

test('a withdrawal submission reports the server outcome, not a guess', () => {
    // `POST /api/user/withdraw` returns `message` and `withdrawalId` and deliberately does not
    // return the amount. Reading `item.amount` anyway made every submission toast read "Your
    // request to withdraw -- is being processed", and it overwrote the one line that
    // distinguishes "sent" from "queued for review -- funds have not been sent yet".
    const body = extractFunction('notifyWithdrawalSubmitted');
    assert.doesNotMatch(
        body,
        /item\.amount|item\?\.amount/,
        'the submission toast reads an amount the response does not carry'
    );
    assert.match(
        body,
        /result\?\.message|result\.message/,
        'the submission toast does not use the server outcome'
    );
});

test('a repeated session expiry is announced once', () => {
    // Every in-flight request 401s together, and each one used to run the whole handler: sign
    // out, toast, bell entry, open the sign-in dialog. Several identical toasts and several
    // dialogs fighting over the same modal.
    const body = extractFunction('handleUnauthorized');
    assert.match(
        body,
        /if \(sessionExpiryHandled\) return true;/,
        'a second 401 in the same tab repeats the whole expiry sequence'
    );
});

test('the bell collapses one event twice but never two different events once', () => {
    // The dedupe key used to be the title alone inside a three-second window, which failed in
    // both directions: two withdrawals of the same amount failing together shared a title and
    // the second was silently discarded, while the same event arriving four seconds apart
    // passed straight through.
    const body = extractFunction('pushNotification');
    const key = /const dedupeKey = ([^;]+);/.exec(body);
    assert.ok(key, 'the notification dedupe key is not in pushNotification');
    assert.match(
        key[1],
        /message/,
        'the dedupe key ignores the message, so two different events sharing a title collide'
    );
    assert.doesNotMatch(
        body,
        /setTimeout\(\s*\(\)\s*=>\s*notificationDedupe\.delete/,
        'the dedupe map is still trimmed by a timer per notification rather than on write'
    );
});

test('a toast cannot appear twice for the same sentence', () => {
    // The net under the structural once-only rules: two calls for the same words in the same
    // moment, which is what a double-clicked submit or a burst of parallel failures produces.
    // Keyed on title *and* message, so "Reward credited" twice for two different offers is two
    // events and both must show.
    assert.match(extractFunction('showToast'), /toastAlreadyShown\(/, 'the toast layer has no dedupe');
    const gate = extractFunction('toastAlreadyShown');
    assert.match(gate, /title/, 'the toast dedupe key ignores the title');
    assert.match(gate, /message/, 'the toast dedupe key ignores the message');
});
