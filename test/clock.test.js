const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The header clock is pinned to New York and no longer prints a timezone.
 *
 * Both halves matter. The pin is what makes the header mean the same thing to every reader --
 * it used to read the browser's own zone, so the same page showed "Berlin" in Europe and
 * "Phoenix" in Arizona for one underlying moment. Dropping the label is the consequence: a
 * clock that is always in the same zone does not need to announce it on every page, and the
 * label was the widest, least load-bearing part of the group.
 *
 * The date went the other way. It was "Sep 30" and is now "Wed, Sep 30, 2026". The year was
 * dropped once to save width and is back because it is the part someone checking a payout
 * against a statement needs; the weekday is new for the same reason -- offers turn over on a
 * weekday boundary, and "Saturday" is information a bare date does not carry.
 */

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'clock.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in public/clock.js`);
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

/**
 * Builds a context holding the two formatters and the constant they share.
 *
 * `CLOCK_ZONE` is a module-level const in the real file, so it has to be supplied for the
 * extracted functions to close over. Asserting on its value is the point of the pin tests, so
 * it is read out of the source rather than hardcoded here.
 */
function clockContext() {
    const context = { Date, Intl, Math, Number, String, Object };
    vm.createContext(context);
    vm.runInContext(
        `const CLOCK_ZONE = ${JSON.stringify(/const CLOCK_ZONE = '([^']+)'/.exec(source)[1])};\n`
        + `${extractFunction('zoneFormatter')}\n`
        + `${extractFunction('formatTime')}\n`
        + `${extractFunction('formatShortDate')}\n`
        + 'this.formatTime = formatTime;\nthis.formatShortDate = formatShortDate;\n',
        context
    );
    return context;
}

test('the clock reads a fixed New York zone, not the browser one', () => {
    assert.match(source, /const CLOCK_ZONE = 'America\/New_York'/);

    // The old version called `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is
    // exactly the per-visitor reading that made the header inconsistent.
    assert.doesNotMatch(
        source,
        /resolvedOptions\(\)\.timeZone/,
        'the clock is reading the browser timezone again'
    );
    // Every formatter has to go through the helper, or a date can land on a different day than
    // the time beside it for a visitor a few hours either side of midnight.
    assert.doesNotMatch(source, /new Intl\.DateTimeFormat\((?!'en-US')/, 'an unpinned formatter is in the file');
});

test('a moment is formatted identically whatever the host zone is', () => {
    // 03:30 UTC on 1 January is 22:30 on 31 December in New York. That is the case where a
    // mixed-zone bug is visible: the date has to roll back a day with the time, not sit on
    // January 1 next to a clock that says it is still the 31st.
    const moment = new Date('2027-01-01T03:30:00Z');
    const { formatTime, formatShortDate } = clockContext();

    assert.equal(formatTime(moment), '22:30:00');
    assert.equal(formatShortDate(moment), 'Thu, Dec 31, 2026');
});

test('the date carries the weekday, the day, the month and the year', () => {
    const { formatShortDate } = clockContext();
    const out = formatShortDate(new Date('2026-09-30T12:00:00Z'));

    assert.match(out, /Wed/, 'the weekday is missing');
    assert.match(out, /Sep/, 'the month is missing');
    assert.match(out, /30/, 'the day is missing');
    assert.match(out, /2026/, 'the year is missing');
    // A full weekday and an ordinal suffix are what overflowed the header before. "Wednesday,
    // September 30th" is one element wider than the cell and wraps the row.
    assert.doesNotMatch(out, /Wednesday/);
    assert.doesNotMatch(out, /th\b/, 'an ordinal suffix is back in the date');
    assert.doesNotMatch(out, /  +/, 'the separators left a double space');
});

test('the time is 24-hour and zero-padded', () => {
    const { formatTime } = clockContext();
    // `hour12: false` on `en-US` is the trap: it renders midnight as "24" rather than "00" in
    // some engines, which makes a clock tick to 24 before rolling to 01.
    assert.equal(formatTime(new Date('2026-09-30T00:05:09Z')), '20:05:09');
});

test('the zone label is gone from the markup the script builds', () => {
    // The element and its id are both removed rather than just hidden, so a page cannot end up
    // with an empty gap where the label used to be.
    assert.doesNotMatch(source, /topbar-clock-zone/, 'the zone element is still created');
    assert.doesNotMatch(source, /timezoneLabel/, 'the label helper is still there');
    // The machine-readable datetime stays. It is not a display of the zone, it is the moment.
    assert.match(source, /setAttribute\('datetime', now\.toISOString\(\)\)/);
});

test('the zone CSS is gone with it', () => {
    assert.doesNotMatch(css, /\.topbar-clock-zone/, 'the zone rule was left behind');
});

test('the clock sits flush against the header padding', () => {
    // The left offset it used to carry -- a margin, a padding and a `border-left` divider --
    // existed to separate the clock from nothing, because the clock was the first thing in the
    // cell. With the timezone gone the rule hung in the margin at the far edge of the header.
    const rule = /\.topbar-clock\s*\{[^}]*\}/.exec(css);
    assert.ok(rule, '.topbar-clock rule not found');
    assert.doesNotMatch(rule[0], /margin-left/, 'the left margin was not removed');
    assert.doesNotMatch(rule[0], /padding-left/, 'the left padding was not removed');
    assert.doesNotMatch(rule[0], /border-left/, 'the stray divider was not removed');
});

test('the clock is not formatted twice for the same tick', () => {
    // Time and date must come from the same zone, so both writers are the pinned helpers and
    // neither falls back to a bare local-time formatter.
    const paint = extractFunction('paint');
    assert.match(paint, /formatTime\(now\)/);
    assert.match(paint, /formatShortDate\(now\)/);
    assert.doesNotMatch(paint, /toLocaleTimeString|toLocaleDateString/, 'paint falls back to a local formatter');
});

test('a browser that cannot name the zone does not lose the header', () => {
    // `zoneFormatter` catches `RangeError` and returns null, and both formatters have a plain
    // arithmetic fallback. A trimmed-tzdata engine must not take the whole header down over a
    // clock.
    assert.match(extractFunction('zoneFormatter'), /catch\s*\{\s*return null/);
    assert.match(extractFunction('formatTime'), /pad\(date\.getHours\(\)\)/);
    assert.match(extractFunction('formatShortDate'), /date\.getFullYear\(\)/);
});
