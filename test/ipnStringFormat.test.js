const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The NOWPayments webhook format is a dashboard setting, and one of its two options can stop
 * crypto deposits from being credited.
 *
 * The app decides "is this a child payment?" with a check on `parent_payment_id`. The provider
 * reports a *parent* payment as `parent_payment_id: null`, so that field being empty is the
 * normal case -- and the normal case is the one that has to keep working. A parent payment's own
 * `finished` callback is the only one that can settle its deposit, because the credit is keyed on
 * the parent. Classify a parent as a child and the app acknowledges the callback and credits
 * nothing: the money arrived, the user is told nothing, and the balance never moves.
 *
 * The dashboard offers an "All-Strings" format where every value is sent as a string, and a JSON
 * `null` arrives as the string `"null"`. `"null"` is truthy, so a plain truthiness test reads the
 * parent as a child. That is a single dropdown away from every crypto deposit on the site
 * silently failing to credit, and nothing in the app would report an error -- the callback is
 * answered 200.
 */

/** Runs the function out of the controller, which is one big module-level file. */
function loadHasParentPayment() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'paymentController.js'), 'utf8');
    const start = source.indexOf('function hasParentPayment');
    assert.notEqual(start, -1, 'hasParentPayment is not defined');
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                // eslint-disable-next-line no-new-func
                return new Function(`${source.slice(start, i + 1)}; return hasParentPayment;`)();
            }
        }
    }
    throw new Error('unbalanced braces while extracting hasParentPayment');
}

test('a parent payment is not mistaken for a child, in every serialisation of "no parent"', () => {
    const hasParentPayment = loadHasParentPayment();

    // The three ways "no parent" can arrive. The last is the All-Strings format, and the one
    // that made this a question.
    for (const value of [null, undefined, '']) {
        assert.equal(hasParentPayment(value), false, `${JSON.stringify(value)} was read as a parent id`);
    }
    assert.equal(hasParentPayment('null'), false, 'the string "null" was read as a parent id');
    assert.equal(hasParentPayment(' NULL '), false, 'a padded "null" was read as a parent id');
    assert.equal(hasParentPayment('undefined'), false, 'the string "undefined" was read as a parent id');
});

test('a real parent id is still recognised', () => {
    const hasParentPayment = loadHasParentPayment();
    // If this returned false for a genuine child callback, the app would try to settle a deposit
    // that does not exist and refuse the callback 404 -- the provider would then retry it
    // forever. Over-correcting here is a different outage, so both directions are pinned.
    assert.equal(hasParentPayment(1234567), true, 'a numeric parent id was not recognised');
    assert.equal(hasParentPayment('1234567'), true, 'a stringified parent id was not recognised');
    assert.equal(hasParentPayment(' 1234567 '), true, 'a padded parent id was not recognised');
});

test('the credit path does not use truthiness for parent_payment_id', () => {
    // Structural, so a later edit cannot quietly reintroduce the original bug behind a
    // passing unit test -- the function above would still be correct and still unused.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'paymentController.js'), 'utf8');
    assert.doesNotMatch(
        source,
        /if \(ipn\.parent_payment_id\)/,
        'the parent check is truthiness again'
    );
    assert.match(source, /if \(hasParentPayment\(ipn\.parent_payment_id\)\)/, 'the hardened check is not the one in use');
});

test('the rest of the callback handling tolerates stringly-typed values', () => {
    // Everything else this handler reads is coerced explicitly, so the format choice is inert
    // for it. These are the assertions that keep it that way: a truthiness check introduced on
    // any of these fields would misread a stringified null exactly as above.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'paymentController.js'), 'utf8');
    assert.match(source, /String\(ipn\.payment_id \|\| ''\)/, 'payment_id is not coerced');
    assert.match(source, /String\(ipn\.order_id \|\| ''\)/, 'order_id is not coerced');
    assert.match(source, /String\(ipn\.payment_status \|\| ''\)\.toLowerCase\(\)/, 'payment_status is not coerced');
    assert.match(source, /Number\(ipn\.price_amount\)/, 'price_amount is not coerced, so All-Strings would break the amount check');
});

test('the payout callback path is format-agnostic already', () => {
    // Payout bodies take a different route, and they use `??` and `String()` throughout rather
    // than truthiness -- which is why the All-Strings option only ever threatened deposits.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'autoPayouts.js'), 'utf8');
    assert.match(source, /String\(body\?\.batch_withdrawal_id \?\? body\?\.batchWithdrawalId \?\? ''\)/);
    assert.match(source, /Array\.isArray\(body\?\.withdrawals\)/, 'the payout item list is not type-checked');
    assert.match(source, /item\?\.status \?\? item\?\.payout_status/, 'a payout status is read by truthiness');
    // The classifier only tests for key presence, never for a value, so it cannot be confused
    // by a stringified null either.
    const np = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'nowPayments.js'), 'utf8');
    assert.match(np, /body\.payment_id !== undefined \|\| body\.payment_status !== undefined/);
});
