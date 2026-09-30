const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * The provider's payout states, as recorded in `withdrawals.payout_status`.
 *
 * This is the whole vocabulary `recordTerminalPayoutStatus` treats as final, plus the two
 * held states from `HELD_PAYOUT_STATES`. Every one of them can reach a user's history row, so
 * every one of them needs a sentence -- a state with no sentence renders as a row with a
 * status badge and nothing under it, which is indistinguishable from a row that failed to
 * load.
 */
const PROVIDER_PAYOUT_STATES = [
    'CREATING', 'NEW', 'WAITING', 'PROCESSING', 'SENDING',
    'SUBMISSION_UNKNOWN', 'VERIFY_UNKNOWN', 'FINISHED',
    'FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED'
];

test('both withdrawal payloads carry the payout fields, not just one of them', () => {
    // These two endpoints render the same rows in two places: the initial page load and the
    // live poll. They had drifted -- `/withdrawals` selected `payout_status` and
    // `/updates` did not -- so the progress line was present on load and vanished on the
    // first poll, which is the shape of bug that hides on refresh.
    for (const [name, pattern] of [
        ['/api/user/updates', /SELECT w\.id, w\.amount, w\.payment_method/],
        ['/api/user/withdrawals', /SELECT w\.id, w\.amount, w\.payment_method/]
    ]) {
        for (const column of [
            'payout_status', 'payout_coin_amount', 'payout_fee_coin',
            'payout_currency', 'payout_address', 'payout_error', 'provider_reference'
        ]) {
            assert.match(
                routes,
                new RegExp(`w\\.${column}`),
                `${name} no longer selects w.${column}, so the withdrawal detail loses it`
            );
        }
    }
});

test('the deposit payload carries the partial payment amounts', () => {
    // `actually_paid` is the only way a client can tell "nothing has arrived" from "0.0076 of
    // 0.0083 arrived", and the two need very different words. Without these columns the row
    // says "waiting" in both cases and the customer cannot work out whether to send more.
    for (const column of ['pay_amount', 'actually_paid', 'pay_currency', 'underpaid_at']) {
        assert.match(
            routes,
            new RegExp(`\\b${column}\\b`),
            `the deposit payload no longer carries ${column}`
        );
    }
});

test('every provider payout state has a sentence for the user', () => {
    for (const state of PROVIDER_PAYOUT_STATES) {
        assert.match(
            app,
            new RegExp(`case '${state}':`),
            `${state} has no label, so a withdrawal in that state renders a badge and no progress line`
        );
    }

    // The fallback used to be `null`, which suppressed the whole element. A payout the app
    // does not recognise must still say something, because silence reads as a broken row.
    const label = /function payoutProgressLabel\(payoutStatus, item = \{\}\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(label, 'payoutProgressLabel is gone');
    assert.doesNotMatch(
        label[1],
        /return null;/,
        'payoutProgressLabel can still return null, which hides the progress line entirely'
    );
});

test('a rejected payout shows the reason the provider gave', () => {
    // "The payout was not sent." tells the user nothing they can act on. The provider's error
    // string is the one piece of information that distinguishes "your address was invalid"
    // from "try again later", so it is quoted rather than summarised away.
    assert.match(
        app,
        /payout_error/,
        'the payout failure label does not read the provider error, so every rejection reads the same'
    );
});

test('the withdrawal badge prefers the provider stage over our coarse status', () => {
    const badge = /function withdrawalBadgeLabel\(item, payoutState\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(badge, 'withdrawalBadgeLabel is gone');
    assert.match(badge[1], /payoutState === 'FINISHED'/, 'a finished payout still reads Processing');
    assert.match(
        badge[1],
        /'REJECTED_NOT_CHECKED'\]/,
        'a provider-rejected payout still reads from the status column'
    );
});

test('a withdrawal row opens onto the full payout record', () => {
    // The amount sent on-chain, the fee, the destination and the reference were visible
    // nowhere in the product, so a user reconciling against their exchange wallet had nothing
    // to compare against.
    for (const value of [
        'payout_coin_amount', 'payout_fee_coin', 'payout_address',
        'provider_reference', 'payout_submitted_at', 'paid_at'
    ]) {
        assert.match(
            app,
            new RegExp(`item\\.${value}`),
            `the withdrawal details do not show ${value}`
        );
    }

    // A native disclosure, not a div with a click handler: it is announced as a control with
    // an expanded state and works on the keyboard without any of that being re-implemented.
    assert.match(app, /createElement\('details'\)/, 'the withdrawal details are not a disclosure');
    assert.match(app, /createElement\('summary'\)/, 'the disclosure has no summary to activate it');
});

test('a rebuilt list does not close a disclosure the reader has open', () => {
    // Both render paths rebuild every row, and a rebuild drops the `open` attribute. Without
    // this the row snaps shut on the next poll, which is every few seconds.
    assert.match(
        app,
        /openDetailIdsFor/,
        'the open disclosure state is not carried across a repaint'
    );
    assert.match(app, /restoreOpenDetails/, 'the open disclosure state is never restored');
});

test('a failed withdrawal says why it failed', () => {
    // This is called from the live poll with a raw API row, which is snake_case. Reading the
    // camelCase spelling that no payload uses is why the toast fell back to a generic
    // sentence for every failure and the reason was never shown.
    const notify = /function notifyWithdrawalFailed\(item\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(notify, 'notifyWithdrawalFailed is gone');
    assert.match(
        notify[1],
        /item\.failure_reason/,
        'the failure toast does not read the snake_case reason the live poll actually sends'
    );
});

test('a partial deposit payment is reported as partial', () => {
    const subtitle = /function describeHistorySubtitle\(item, kind\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(subtitle, 'describeHistorySubtitle is gone');
    assert.match(
        subtitle[1],
        /item\.actually_paid/,
        'a short payment is still reported as "waiting for the payment provider"'
    );
});
