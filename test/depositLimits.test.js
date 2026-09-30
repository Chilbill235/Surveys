const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The deposit form must not enforce the payment provider's minimum.
 *
 * The bug this pins shut, and it had three separate parts in the browser:
 *
 *   1. `syncDepositPresets` disabled every preset under the provider's floor. Measured on the
 *      live account, the provider quotes ~$18.74 for every coin while the presets are $5/$10/
 *      $25/$50 -- so a form where most one-tap options could not be pressed.
 *   2. `settleDepositAmountToPayable` silently rewrote the amount box to the provider's floor
 *      whenever it was not focused. The user typed $10 and the box said $18.74 with no
 *      explanation, on every currency change and every time the dialog opened.
 *   3. `updateDepositSwapOffer` put a "below the floor for this coin" banner above the button,
 *      permanently, because the floor applied to every coin on this account.
 *
 * Together those made a deposit form that either would not submit or silently charged the user
 * more than they entered. The provider is the only party that knows what it will accept, its
 * figure moves between reads, and `paymentController` already translates its refusal into a
 * sentence with a number in it -- so the form's job is to let the user press the button.
 *
 * `public/app.js` is a browser script with no module boundary, so it cannot be required. The
 * function body is lifted out of the file by brace matching and evaluated against stubs, which
 * tests the text that actually ships.
 */

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** Extracts a named function declaration from the script by matching braces from its body. */
function extractFunction(name) {
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

test('the provider minimum is not read anywhere in the deposit form', () => {
    // Structural, because the failure mode is a re-added gate rather than a wrong number. Any
    // helper named for a provider floor is the thing that comes back, so this asserts on the
    // absence of the concept rather than on one particular comparison.
    assert.doesNotMatch(
        source,
        /providerMinimumForSelectedCurrency/,
        'a per-coin provider floor helper is being read by the deposit form again'
    );
    assert.doesNotMatch(
        source,
        /settleDepositAmountToPayable/,
        'the amount box is being rewritten to the provider floor again'
    );
    assert.doesNotMatch(
        source,
        /cheapestCurrencyAccepting/,
        'the "use a cheaper coin" offer is being rebuilt'
    );
});

test('the amount box is never rewritten to a figure the user did not type', () => {
    // The one function that still moves the box is `clampDepositAmountToRange`, and it is
    // bounded by this app's own floor and ceiling, not by the provider's quote. Asserted by
    // name because the silent-rewrite helper is gone entirely -- if it returns, it will be
    // under one of these names or a new one, and the guard below still catches the new one.
    assert.doesNotMatch(
        extractFunction('minimumForSelectedCurrency'),
        /minimums/,
        'the box floor reads the provider minimums again'
    );
    assert.doesNotMatch(
        extractFunction('maximumForSelectedCurrency'),
        /minimums/,
        'the box ceiling reads the provider minimums again'
    );
});

test('every preset a user can see is a button they can press', () => {
    // Executed, not pattern-matched: the defect was a disabled control, which a text assertion
    // about the same function would pass right through. `minimumForSelectedCurrency` is stubbed
    // at the cent guard the form actually applies for crypto, so the presets must all survive.
    const buttons = [5, 10, 25, 50].map((value) => ({
        dataset: { depositAmount: String(value) },
        disabled: false,
        classList: { toggle() {} },
        setAttribute() {},
        title: ''
    }));
    const context = {
        document: {
            getElementById: (id) => (id === 'deposit-amount' ? { value: '10' } : null),
            querySelectorAll: () => buttons
        },
        depositState: { method: 'crypto' },
        minimumForSelectedCurrency: () => 0.01,
        maximumForSelectedCurrency: () => 5000,
        formatBalance: (value) => `$${Number(value).toFixed(2)}`
    };
    vm.runInContext(
        `${extractFunction('syncDepositPresets')}\nsyncDepositPresets();`,
        vm.createContext(context)
    );

    for (const button of buttons) {
        assert.equal(
            button.disabled,
            false,
            `the $${button.dataset.depositAmount} preset cannot be pressed`
        );
    }
});

test('a preset outside this form\'s own bounds is still disabled', () => {
    // The one gate that remains, so the test above is not passing because the check was
    // deleted wholesale. A coin capped below $50 must grey out the $50 button.
    const buttons = [5, 50].map((value) => ({
        dataset: { depositAmount: String(value) },
        disabled: false,
        classList: { toggle() {} },
        setAttribute() {},
        title: ''
    }));
    const context = {
        document: {
            getElementById: (id) => (id === 'deposit-amount' ? { value: '5' } : null),
            querySelectorAll: () => buttons
        },
        depositState: { method: 'crypto' },
        minimumForSelectedCurrency: () => 0.01,
        maximumForSelectedCurrency: () => 20,
        formatBalance: (value) => `$${Number(value).toFixed(2)}`
    };
    vm.runInContext(
        `${extractFunction('syncDepositPresets')}\nsyncDepositPresets();`,
        vm.createContext(context)
    );

    assert.equal(buttons[0].disabled, false, '$5 is inside the ceiling and was disabled');
    assert.equal(buttons[1].disabled, true, '$50 is above the $20 ceiling and was left enabled');
});

test('the "below the floor" banner is gone from the markup and the stylesheet', () => {
    // It could only ever have appeared on this account: the provider quotes ~$18.74 for every
    // coin, so any amount under that showed a permanent warning above the submit button. The
    // element and its two rules are removed rather than left behind hidden, because a rule with
    // no element is a trap for the next person editing either file.
    for (const file of ['index.html', 'history.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
        assert.doesNotMatch(html, /deposit-swap-hint/, `#deposit-swap-hint is still in ${file}`);
    }
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.doesNotMatch(css, /\.swap-hint/, 'the .swap-hint rule is still in style.css');
    assert.doesNotMatch(css, /\.swap-button/, 'the .swap-button rule is still in style.css');
    assert.doesNotMatch(source, /updateDepositSwapOffer/, 'the no-op hiding function is still called');
});

test('the hint says this app sets no crypto minimum, rather than quoting one', () => {
    // The number under the amount box is the one figure a user reads before deciding what to
    // type. Quoting the provider's volatile floor there made a small deposit look acceptable
    // and then fail -- the opposite of what the picker labels ("from $X") already imply.
    const hint = { textContent: '', classList: { remove() {} } };
    const context = {
        document: { getElementById: (id) => (id === 'deposit-amount-hint' ? hint : null) },
        depositState: { method: 'crypto', options: { maximumUsd: 5000 } },
        minimumForSelectedCurrency: () => 0.01,
        maximumForSelectedCurrency: () => 5000,
        formatBalance: (value) => `$${Number(value).toFixed(2)}`,
        validateDepositAmount: () => {}
    };
    vm.runInContext(
        `${extractFunction('updateDepositAmountHint')}\nupdateDepositAmountHint();`,
        vm.createContext(context)
    );

    assert.match(hint.textContent, /no minimum set by us/i);
    assert.match(hint.textContent, /maximum \$5000\.00/i, `the maximum is missing from: ${hint.textContent}`);
});

test('a card deposit still states its real $1.00 floor', () => {
    // The removal was scoped to crypto. $1 is a genuine card processing floor rather than a
    // quoted guess, so dropping it would have been scope creep in the other direction.
    const hint = { textContent: '', classList: { remove() {} } };
    const context = {
        document: { getElementById: (id) => (id === 'deposit-amount-hint' ? hint : null) },
        depositState: { method: 'stripe', options: { maximumUsd: 5000, appMinimumUsd: 1 } },
        minimumForSelectedCurrency: () => 1,
        maximumForSelectedCurrency: () => 5000,
        formatBalance: (value) => `$${Number(value).toFixed(2)}`,
        validateDepositAmount: () => {}
    };
    vm.runInContext(
        `${extractFunction('updateDepositAmountHint')}\nupdateDepositAmountHint();`,
        vm.createContext(context)
    );

    assert.match(hint.textContent, /Minimum \$1\.00/);
});

test('the default coin selection opens on the cheapest one', () => {
    // Not enforcement: the sort only chooses which coin is pre-selected, and a cheap coin is
    // simply the friendlier default. Kept because it was a real improvement and there is no
    // reason to lose it while removing the gates.
    const loadOptions = extractFunction('loadDepositOptions');
    assert.match(loadOptions, /sort\(/, 'the coin list is no longer sorted by floor');
    assert.match(loadOptions, /options\.minimums/, 'the sort no longer reads the provider floors');
});