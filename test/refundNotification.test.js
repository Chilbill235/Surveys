const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The refund path.
 *
 * Every bug here was found by looking at a real row after a real payout run, not by reading the
 * code -- which is why none of them had a test. They share a shape: the refund itself was correct
 * (the money came back, the ledger row was written, the email went out), and everything *around*
 * it was not. A test that only asserts the balance went up passes on all three.
 */

const resolution = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'withdrawalResolution.js'), 'utf8');
const autoPayouts = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'autoPayouts.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const refund = /async function refundWithdrawal\([\s\S]*?\n\}/.exec(resolution)[0];

test('a refunded withdrawal stops claiming to be an in-flight payout', () => {
    // Found on withdrawal 88, left as `CREATING` by a refund. `CREATING` is the state a claim
    // writes before the provider is called, and it is deliberately reconcilable -- so a
    // withdrawal that had already been given back to its user was picked up by the
    // reconciliation sweep on every single pass, for ever, and shown to them with a progress
    // stage for a payout that was never going to happen.
    assert.match(
        refund,
        /payout_status = CASE WHEN payout_status = 'CREATING' THEN NULL/,
        'a refunded withdrawal keeps its in-flight payout status'
    );

    // Only CREATING is cleared, and that is the whole safety argument: it is the only value that
    // means "claimed, not yet sent". A real provider status is the record of what happened to
    // the money and is not this function's to erase.
    assert.match(
        refund,
        /ELSE payout_status END/,
        'a real provider status is overwritten by a refund'
    );

    // The claim timestamp goes with it, or the row still reads as claimed to everything that
    // looks at it.
    assert.match(refund, /payout_claimed_at = CASE/, 'a refunded withdrawal keeps its claim time');
});

test('clearing the payout status cannot put a refunded withdrawal back in the queue', () => {
    // `payout_status IS NULL` is exactly the condition the payout queue claims on, so clearing it
    // is only safe because `status = 'failed'` has already taken the row out. Both facts are
    // asserted, because the safety of the first depends on the second and neither is obvious.
    assert.match(
        refund,
        /SET status = 'failed'/,
        'a refund no longer marks the withdrawal failed'
    );
    assert.match(
        autoPayouts,
        /WHERE status = 'pending' AND payout_status IS NULL/,
        'the payout queue no longer filters on status, so a failed row could be claimed'
    );
});

test('the provider error stays with the operator and out of the user\'s history', () => {
    // Also found on 88: the ledger row's description is what the user reads in their own
    // transaction list, and it said "NOWPayments /v1/payout returned 400.: Insufficient balance".
    // A third party they have no relationship with, an HTTP status and an endpoint path, in the
    // one place a person goes to find out where their money went.
    assert.match(refund, /ledgerDescription/, 'the ledger description cannot be chosen by the caller');

    // Operator detail stays on the row, where it belongs.
    assert.match(
        refund,
        /failure_reason = \$1/,
        'the operator reason is no longer stored on the row'
    );

    // And the two are separate inputs, with the description falling back to the reason only when
    // a caller has nothing better -- so no caller is left with a blank history entry.
    assert.match(
        refund,
        /String\(description \|\| ''\)\.trim\(\)\.slice\(0, 500\) \|\| failureReason/,
        'there is no user-facing fallback for the history description'
    );

    // The option has to reach the insert, or declaring it does nothing.
    assert.match(
        refund,
        /'refund', \$3, \$4\)/,
        'the ledger insert no longer takes a description parameter'
    );

    // And the caller that knows the wording has to pass it. Payout abandonment is the case that
    // matters: it is the one that produces a provider string as the reason.
    assert.match(
        autoPayouts,
        /emailReason: userReason, description: userReason/,
        'the payout-abandon path still writes the provider error into the user history'
    );
});

test('a refund is announced, because nothing else announces it', () => {
    // The gap the user reported. The live loop announced rewards only, and carried a comment
    // saying debits are fine because "the withdrawal list already has its own announcement" --
    // true of a payout that completes, whose webhook calls `notifyWithdrawalPaid`, and false of
    // the refund, which is written by a payout *run*. Nothing called into the client at all: the
    // only trace was a ledger row the loop walked past.
    assert.match(app, /function announceLedgerRefund\(/, 'refunds are still never announced');
    assert.match(
        app,
        /entry\.transaction_type === 'refund'\) \{\s*announceLedgerRefund\(/,
        'the live loop still walks past refund rows'
    );
});

test('a refund notice links to the withdrawal that explains it', () => {
    // A refund row's `source_id` is `withdrawal:<id>` -- the one ledger shape that names the
    // record behind it, so the destination is derivable without the server sending another field.
    // Asserted as a substring rather than a pattern because the pattern here is the literal
    // `/^withdrawal:(\d+)$/`, and escaping that through two more regular expressions is how a
    // test ends up asserting on the wrong thing and passing.
    assert.ok(
        app.includes("/^withdrawal:(\\d+)$/.exec(String(entry.source_id"),
        'the refund notice does not read the withdrawal id from source_id'
    );

    // The id, not a resolved link: `pushNotification` stores the id so `notificationTarget` can
    // rebuild the destination from the row that is actually there. A frozen `/account` is the
    // bug this whole area had.
    assert.ok(
        app.includes('withdrawalId: match[1]'),
        'the refund notice does not carry the withdrawal id'
    );

    // And a refund with no recognisable source falls back to a category rather than inventing an
    // id -- a link to a row that cannot exist is worse than no link. The refund's own category is
    // `withdrawal_failed` because that is what the server records the same refund as; anything
    // else is a second row in the dedup index and the reader sees the refund twice.
    const fallback = app.slice(app.indexOf('function announceLedgerRefund('));
    assert.match(
        fallback,
        /\? \{[^}]*category: 'withdrawal_failed'[^}]*\}\s*\n\s*: \{[^}]*category: 'reward'/,
        'an unidentifiable refund does not fall back to a category'
    );
});