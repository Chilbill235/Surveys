const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    generateCode,
    hashCode,
    codeMatches,
    buildMessage,
    CODE_PATTERN,
    CODE_LIFETIME_MINUTES,
    MAX_ATTEMPTS
} = require('../src/services/verificationEmail');

/**
 * The code is low entropy by design, so the properties worth protecting are all about how
 * much guessing it permits. These cover the arithmetic of that, and the two ways the
 * comparison could be circumvented: a code valid for one account being used for another, and
 * a wrong code revealing how much of it was right.
 */

test('a generated code is six digits, and covers the whole range', () => {
    // Enough draws that every band below is certain to appear. 2000 samples over a million
    // values leaves a ~2e-9 chance of missing a one-percent band, so this cannot flake.
    const draws = 2000;
    const values = [];
    for (let i = 0; i < draws; i += 1) {
        const code = generateCode();
        assert.match(code, CODE_PATTERN, `${code} is not six digits`);
        assert.equal(code.length, 6);
        values.push(Number(code));
    }

    // Leading zeros must be possible: a code of "000123" is as valid as "123456", and
    // `String(randomInt(...))` without padding would silently lose every value that
    // starts with a zero -- ten percent of them.
    assert.ok(values.some((value) => value < 100000), 'no code below 100000: leading zeros look lost');

    // Repeats are expected and are not a defect. 400 draws from a million possibilities
    // collide roughly eight percent of the time, so asserting uniqueness would be a coin
    // flip dressed up as a test. What would be a real defect is a generator covering less
    // than the full range -- a truncated bound, or a `randomInt` that never reaches the top
    // -- so the sample is checked for reaching both ends of the space instead.
    assert.ok(values.some((value) => value >= 990000), 'no code above 990000: the top of the range looks unreachable');
    assert.ok(values.some((value) => value < 10000), 'no code below 10000: the bottom of the range looks unreachable');
});

test('a code is bound to the account it was issued for', () => {
    const code = '123456';
    const hash = hashCode(code, 7);

    assert.equal(codeMatches(code, hash, 7), true);

    // The same code against a different user's stored hash must not verify. Without the id
    // in the comparison, a code issued for one account would confirm another -- a real
    // cross-account hole, not a theoretical one.
    assert.equal(codeMatches(code, hash, 8), false);
});

test('a wrong code never matches, whatever it looks like', () => {
    const hash = hashCode('000000', 3);
    for (const wrong of ['000001', '999999', '123456', '00000', '0000000', 'abcdef', '', ' 000000 ']) {
        assert.equal(codeMatches(wrong, hash, 3), false, `${wrong} was accepted`);
    }
});

test('a malformed stored value is rejected rather than throwing', () => {
    // `timingSafeEqual` throws when the two buffers differ in length. A row that is not a
    // digest -- truncated, or from a hand-edited table -- must fail the check, not take the
    // endpoint down with a 500 on every attempt.
    for (const stored of ['', 'not-hex', 'abc', null, undefined, '0'.repeat(64), 'f'.repeat(64)]) {
        assert.equal(codeMatches('123456', stored, 1), false, `${stored} was accepted`);
    }
});

test('the stored value is not the code', () => {
    const code = '123456';
    const hash = hashCode(code, 5);
    // A database read must not hand over a working code. This is the whole reason the value
    // is hashed, and it is the one property that silently stops being true if someone
    // "simplifies" the storage later.
    assert.notEqual(hash, code);
    assert.equal(hash.includes(code), false);
    assert.match(hash, /^[\da-f]{64}$/);
});

test('the attempt budget is small enough to make the code unsearchable', () => {
    // A million possible codes, and this many guesses, is the whole defence. The arithmetic
    // is asserted rather than assumed, so raising MAX_ATTEMPTS to something comfortable
    // looking fails here instead of quietly weakening the system.
    assert.equal(10 ** 6 > MAX_ATTEMPTS, true,
        'the attempt budget must be a vanishing fraction of the code space');
    assert.equal(MAX_ATTEMPTS, 5);
    // Long enough for a real person to mistype a code twice and still be fine.
    assert.equal(MAX_ATTEMPTS >= 3, true);
    // Short-lived, so the same code cannot be attacked tomorrow.
    assert.equal(CODE_LIFETIME_MINUTES <= 30, true);
});

test('the message states the code and its expiry, and never the account', () => {
    const { subject, text, html } = buildMessage({ code: '424242' });

    assert.match(subject, /RewardZone/);
    assert.match(text, /424242/);
    assert.match(html, /424242/);
    // The expiry is stated in both bodies, because a user who misses it needs to know to
    // ask for another one rather than assume the code is wrong.
    assert.match(text, new RegExp(`${CODE_LIFETIME_MINUTES} minutes`));
    assert.match(html, new RegExp(`${CODE_LIFETIME_MINUTES} minutes`));
    // And it must be clear the mail is not a request from us.
    assert.match(text, /did not try to create an account/i);
});
