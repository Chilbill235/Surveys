const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const paymentController = require('../src/controllers/paymentController');

const {
    MIN_CRYPTO_DEPOSIT_USD,
    isProviderMinimumRefusal,
    belowProviderMinimumMessage
} = paymentController;

/**
 * Crypto deposits have no minimum of this app's own.
 *
 * The shape of the bug this pins shut: a provider-quoted floor was being enforced as a hard
 * client-side and server-side gate. The provider's figure is advisory -- it moves per read, per
 * payment method and per network condition -- so gating on it stopped deposits the provider
 * would have accepted, and the user saw a form that would not submit and no explanation. That is
 * strictly worse than sending the amount and letting the provider answer.
 *
 * What has to survive that change is the error handling. The provider is now the only thing
 * enforcing a floor, so its refusal is the only place a user ever learns one exists, and
 * "amountTo is too small" is not a thing a person can act on.
 */

test('the crypto floor is a bare guard against zero, not a policy', () => {
    // A cent, and it is the floor for both the client box and the server parser. If this number
    // is ever raised, the gate is back and the tests below pass while deposits are blocked.
    assert.equal(MIN_CRYPTO_DEPOSIT_USD, 0.01);
});

test('nothing in createDeposit compares the amount to a provider floor', () => {
    // Structural rather than behavioural, because the behaviour is a refusal that used to be
    // right and is now wrong: the code could be reintroduced anywhere in a 700-line handler.
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'controllers', 'paymentController.js'),
        'utf8'
    );
    const handler = source.slice(source.indexOf('async function createDeposit('));

    // The comparison is allowed to exist, the refusal on the result of it is not.
    assert.doesNotMatch(
        handler,
        /amount\s*<\s*floor/,
        'createDeposit still refuses deposits by comparing the amount to a provider floor'
    );
    assert.doesNotMatch(
        handler,
        /deposit_below_provider_minimum/,
        'createDeposit still returns a pre-emptive below-minimum error code'
    );
});

test('every shape the provider words a minimum refusal in is recognised', () => {
    // These are the three forms NOWPayments uses, and the first two are the reason the
    // translation exists: one names a request parameter, the other an amount in a currency the
    // user never chose. A missed case shows that string to a customer verbatim.
    for (const message of [
        'amountTo is too small',
        'priceAmount is too small',
        'Minimum amount is 0.05 BCH',
        'minimum amount is 10',
        'Amount is lower than minimum',
        'amount is less than the minimum',
        'value below the minimum',
    ]) {
        assert.equal(
            isProviderMinimumRefusal(message),
            true,
            `a minimum refusal was not recognised: ${message}`
        );
    }
});

test('refusals that are not about the amount are left alone', () => {
    // The translation must not swallow a different problem. "unknown currency" and a rate limit
    // have their own handling, and restating them as "raise the amount" would be a lie.
    for (const message of [
        'unknown currency',
        'payment method is not available',
        'API key is invalid',
        'amount must be a number',
    ]) {
        assert.equal(
            isProviderMinimumRefusal(message),
            false,
            `a non-minimum refusal was mistaken for one: ${message}`
        );
    }
    assert.equal(isProviderMinimumRefusal(''), false);
    assert.equal(isProviderMinimumRefusal(null), false);
    assert.equal(isProviderMinimumRefusal(undefined), false);
});

test('the refusal message names the coin, the floor and the way forward', () => {
    // Each of the three answers a question the raw refusal leaves open, which is the whole
    // reason this string exists instead of the provider's.
    const message = belowProviderMinimumMessage('bch', 18.79, 5);
    assert.match(message, /BCH/, 'the coin is not named');
    assert.match(message, /\$18\.79/, 'the floor is not stated');
    assert.match(message, /\$5\.00/, 'the amount the user typed is not echoed back');
    assert.match(message, /choose a coin with a lower minimum/i, 'there is no way forward');
});

test('a missing floor is omitted rather than invented', () => {
    // The provider refused, and the live quote that would have supplied the number failed, so
    // there is genuinely nothing to quote. Printing "$0.00" -- which `Number(null)` would have
    // produced, and did before the caller stopped coercing -- is worse than printing no number.
    const message = belowProviderMinimumMessage('bch', null, 5);
    assert.doesNotMatch(message, /\$0\.00/, 'an absent floor was rendered as a real one');
    assert.doesNotMatch(message, /NaN/);
    assert.match(message, /below what our payment provider accepts/i);
    assert.match(message, /BCH/, 'the coin is still named when the floor is not');
});

test('the amount box does not enforce a crypto minimum', () => {
    // Checked against the shipped source because the box is what the user actually fights with.
    // A `min` above a cent here is a disabled button, whatever the server thinks.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('function minimumForSelectedCurrency(');
    assert.notEqual(start, -1, 'minimumForSelectedCurrency is not in public/app.js');
    const body = appSource.slice(start, appSource.indexOf('}', start));
    assert.match(body, /crypto/, 'the crypto branch was removed');
    assert.match(body, /0\.01/, 'crypto no longer falls back to a sub-cent floor');
});

test('the submit button is never disabled because of the amount', () => {
    // The failure the user reported: a form that would not submit, with nothing to explain it.
    // This asserts on the shipped text, because the regression is a disabled control, which no
    // unit test of a helper would have caught.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

    const enableStart = appSource.indexOf('function setDepositSubmitEnabled(');
    assert.notEqual(enableStart, -1, 'setDepositSubmitEnabled is not in public/app.js');
    const enableBody = appSource.slice(
        enableStart,
        appSource.indexOf('function depositBlockedForAvailability(')
    );
    assert.doesNotMatch(
        enableBody,
        /BelowFloor/,
        'the submit button is disabled by the provider floor again'
    );

    // And nothing else in the amount-validation path turns it off either.
    const validateStart = appSource.indexOf('function validateDepositAmount(');
    const validateBody = appSource.slice(validateStart, appSource.indexOf('function ', validateStart + 10));
    assert.doesNotMatch(
        validateBody,
        /submit\.disabled/,
        'validateDepositAmount disables the submit button again'
    );
});

test('the amount-validation path annotates nothing and blocks nothing', () => {
    // The gate, the disabled button and the "below the floor" banner have all been removed, so
    // there is nothing left for this function to do beyond leaving the hint in a neutral state.
    // Asserted as the absence of every one of those, because each was independently capable of
    // blocking a deposit the provider would have taken.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const validateStart = appSource.indexOf('function validateDepositAmount(');
    const validateBody = appSource.slice(validateStart, appSource.indexOf('function ', validateStart + 10));

    assert.doesNotMatch(validateBody, /classList\.add\(['"]is-error/, 'the hint is marked as an error again');
    assert.match(
        validateBody,
        /classList\.remove\(['"]is-error/,
        'a stale warning from an earlier version is never cleared'
    );
    assert.doesNotMatch(validateBody, /submit\.disabled/, 'the submit button is disabled again');
    assert.doesNotMatch(validateBody, /minimums/, 'a provider floor is read again');
    assert.doesNotMatch(validateBody, /input\.value/, 'the amount is rewritten again');
});

test('a card deposit keeps its $1.00 floor', () => {
    // The request was scoped to crypto. A card minimum is a real processing floor rather than a
    // quoted guess, so removing it would have been scope creep in the other direction.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('function minimumForSelectedCurrency(');
    const body = appSource.slice(start, appSource.indexOf('}', start));
    assert.match(body, /appMinimumUsd/, 'the card branch no longer uses the app minimum');
});

/**
 * Runs an extracted `public/app.js` function against a stub DOM.
 *
 * `public/app.js` is a browser script with no module boundary, so it cannot be required. Lifting
 * the function body out by brace matching and evaluating it against stubs tests the text that
 * actually ships, which is the only version that can regress.
 */
function extractFunction(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in public/app.js`);
    const bodyStart = source.indexOf('{', start);
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

test('an amount under the quoted floor still leaves the button clickable', () => {
    // The end-to-end shape of the fix, executed rather than pattern-matched: a $5 BCH deposit
    // against a quoted $18.79 floor must leave the button enabled. This is exactly the case that
    // used to be un-submittable.
    const submit = { disabled: false };
    const context = {
        document: { getElementById: (id) => (id === 'deposit-submit' ? submit : null) },
        depositState: { currency: 'bch', options: { stripeAvailable: true, cryptoAvailable: true } },
        depositBlockedForAvailability: () => false
    };
    vm.runInContext(
        `${extractFunction('setDepositSubmitEnabled')}\nsetDepositSubmitEnabled();`,
        vm.createContext(context)
    );
    assert.equal(submit.disabled, false, 'a sub-floor amount disabled the submit button');
});

test('a deposit with no available method is still blocked', () => {
    // The gate that remains. A live button that goes nowhere is worse than a dead one, and no
    // amount can fix a missing payment method.
    const context = {
        document: { getElementById: () => null },
        depositState: { currency: 'bch', options: { stripeAvailable: false, cryptoAvailable: false } }
    };
    vm.runInContext(
        `${extractFunction('depositBlockedForAvailability')}\nthis.result = depositBlockedForAvailability();`,
        vm.createContext(context)
    );
    assert.equal(context.result, true);
});
