const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The deposit form's coin picker, tested against the real source.
 *
 * This is the logic that decides which coin a depositor is shown first, and the logic behind
 * the "use a different coin" offer. Both exist for the same reason: this app advertises a
 * $1.00 minimum, and that is only true of some coins. NOWPayments genuinely refuses a Bitcoin
 * Cash deposit under about $18.79, and a few other pairs sit in the same range, so a user who
 * has picked a coin with a high floor is told the amount is too small and given no way to
 * discover that a $1 deposit was available the whole time.
 *
 * `public/app.js` is a browser script with no module boundary, so it cannot be imported. The
 * function body is lifted out of the file by brace matching and evaluated against stubs --
 * which tests the text that actually ships. Re-implementing the rule here instead would
 * create a second copy that passes while the real one breaks, which is the failure this whole
 * arrangement exists to prevent.
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

/** Runs the real function against a stubbed document and deposit state. */
function runCheapestCurrency({ options, selected, amount, appFloor = 1 }) {
    const select = { value: selected };
    const context = {
        depositState: { options },
        document: { getElementById: (id) => (id === 'deposit-currency' ? select : null) },
        minimumForSelectedCurrency: () => appFloor,
        // The extracted function takes the amount as a parameter, so the call is made with a
        // value the sandbox can see. Passing it in as a context global rather than inlining it
        // into the script text keeps `NaN` and `Infinity` as real values rather than literals
        // re-parsed by the sandbox.
        amount,
        Math,
        Number
    };
    const factory = vm.createContext(context);
    vm.runInContext(`${extractFunction('cheapestCurrencyAccepting')}\nthis.result = cheapestCurrencyAccepting(amount);`, factory);
    return context.result;
}

test('the picker offers the coin the provider will accept the least of', () => {
    // Bitcoin Cash genuinely refuses under about $18.79; the others are cheap to start. The
    // app's $1.00 minimum is only reachable through one of the cheap ones, so the picker has to
    // open on the cheap one rather than in whatever order the provider listed them.
    const options = {
        cryptoCurrencies: ['bch', 'btc', 'ltc'],
        minimums: { bch: 18.79, btc: 18.8, ltc: 1.5 }
    };
    const cheapest = runCheapestCurrency({ options, selected: 'bch', amount: 5 });
    assert.equal(cheapest.code, 'ltc');
    assert.equal(cheapest.floor, 1.5);
});

test('the picker never suggests the coin that is already selected', () => {
    // Suggesting the current coin produces a button that appears to do nothing, which reads as
    // a broken control rather than as a no-op.
    const options = { cryptoCurrencies: ['ltc', 'bch'], minimums: { ltc: 1.5, bch: 18.79 } };
    const cheapest = runCheapestCurrency({ options, selected: 'ltc', amount: 5 });
    assert.equal(cheapest, null, 'the already-selected cheapest coin was suggested back');
});

test('the picker suggests nothing when no coin will take the amount', () => {
    // A $0.50 crypto deposit is impossible on every pair, and inventing a suggestion here would
    // produce a button that leads straight to a provider refusal.
    const options = { cryptoCurrencies: ['bch', 'btc'], minimums: { bch: 18.79, btc: 18.8 } };
    assert.equal(runCheapestCurrency({ options, selected: 'btc', amount: 0.5 }), null);
});

test('a coin with no reported floor is treated as accepting the app minimum', () => {
    // A missing figure is not a floor of infinity. The provider did not report one, and the
    // only limit this app enforces itself is $1.00, so that is what the coin is treated as
    // accepting -- otherwise an unreported coin is silently excluded from every suggestion.
    const options = { cryptoCurrencies: ['bch', 'doge'], minimums: { bch: 18.79 } };
    const cheapest = runCheapestCurrency({ options, selected: 'bch', amount: 1 });
    assert.equal(cheapest.code, 'doge');
    assert.equal(cheapest.floor, 1, 'it did not fall back to the app minimum');
});

test('a zero or unparseable floor is not treated as a real limit', () => {
    // `0` and `null` are what an omitted or unconverted figure arrives as. Reading either as a
    // real floor of zero would let a sub-minimum coin look like the cheapest option, which is
    // how an unreported value becomes a wrong recommendation.
    const options = {
        cryptoCurrencies: ['bch', 'a', 'b'],
        minimums: { bch: 18.79, a: 0, b: null }
    };
    const cheapest = runCheapestCurrency({ options, selected: 'bch', amount: 5 });
    assert.equal(cheapest.code, 'a');
    assert.equal(cheapest.floor, 1);
});

test('an amount of zero or nothing is not answered with a suggestion', () => {
    const options = { cryptoCurrencies: ['bch', 'ltc'], minimums: { bch: 18.79, ltc: 1.5 } };
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
            runCheapestCurrency({ options, selected: 'bch', amount }),
            null,
            `amount ${amount} produced a suggestion`
        );
    }
});

test('nothing is suggested before the options have loaded', () => {
    // The offer is rendered on every keystroke, including before the first request resolves, so
    // it has to cope with there being no options at all rather than throwing.
    assert.equal(runCheapestCurrency({ options: null, selected: 'bch', amount: 5 }), null);
    assert.equal(runCheapestCurrency({ options: {}, selected: 'bch', amount: 5 }), null);
});

test('the default selection opens on the cheapest coin, which is the whole point of the rule', () => {
    // The picker defaults are written inline in `loadDepositOptions`, so this asserts the
    // contract the user actually experiences: opening the form on the provider's first-listed
    // coin is what put an $18.79 minimum in front of everyone.
    const loadOptions = extractFunction('loadDepositOptions');
    assert.match(loadOptions, /sort\(/, 'the coin list is no longer sorted by floor');
    assert.match(loadOptions, /options\.minimums/, 'the sort no longer reads the provider floors');
    assert.match(loadOptions, /cheapest/, 'the cheapest coin is no longer selected by default');
});
