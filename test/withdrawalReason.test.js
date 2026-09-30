const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * How a withdrawal explains itself, and how its timestamps read.
 *
 * Two separate complaints, one file, because both are about the same screen: a user told "NOWPayments
 * /v1/payout returned 400.: Insufficient balance" about *their own* withdrawal, and a user reading
 * a transaction time in "16:16" because that is how their machine is configured.
 *
 * The provider's raw error text is still recorded in the database and still shown to an operator --
 * it is genuinely the right string for somebody debugging. What these tests pin is the narrower
 * claim: it is never the sentence a customer is shown, and a timestamp does not change shape with
 * the reader's OS settings.
 *
 * The functions are extracted and evaluated rather than grepped for, because the failure mode here
 * is a mapping that silently omits a state. `CREATING` rendering as "creating" was not a broken
 * string, it was a correct-looking string that was wrong; only calling it can catch that.
 */

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const app = read('public/app.js');
const receipt = read('public/withdrawal-receipt.js');
const history = read('public/history.js');
const depositReceipt = read('public/deposit-receipt.js');

/**
 * Lift one function declaration out of a source file and make it callable.
 *
 * These functions are pure and self-contained by design -- no DOM, no module imports -- which is
 * what makes them testable at all.
 *
 * Braces are matched rather than searched for a closing `\n}`: several of these live inside an
 * IIFE and are therefore indented, and the page-level ones contain object literals and template
 * strings whose braces would end a naive match in the wrong place. Counting braces inside a
 * string would still miscount, so the scan skips over quoted spans as it goes.
 */
function load(source, name) {
    const decl = new RegExp(`(?:^|[\\s;{(])(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
    assert.ok(decl, `${name} not found -- if it was renamed or moved, fix this test's name`);

    const body = source.indexOf('function', decl.index);

    // Step over the parameter list to find the body brace. A parameter can carry a default with
    // braces in it -- `(item = {})` is exactly that -- so the first `{` after the name is not
    // necessarily the body, and counting braces from there produces a function cut off mid-way.
    let parens = 0;
    let open = -1;
    for (let i = source.indexOf('(', body); i < source.length; i++) {
        const ch = source[i];
        if (ch === '(') parens++;
        else if (ch === ')' && --parens === 0) { open = source.indexOf('{', i); break; }
    }
    assert.notEqual(open, -1, `${name}: no body brace after the parameter list`);

    let depth = 0;
    let quote = null;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];

        // Comments have to be skipped before strings are considered. Several of these functions
        // document themselves inline, and a comment containing an apostrophe or a backtick --
        // "the reader's own clock", or a function name in backticks -- otherwise opens a string
        // that never closes, and the brace count never returns to zero.
        if (!quote && ch === '/' && source[i + 1] === '/') {
            const end = source.indexOf('\n', i);
            i = end === -1 ? source.length : end;
            continue;
        }
        if (!quote && ch === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end === -1 ? source.length : end + 1;
            continue;
        }

        if (quote) {
            // A backslash escapes the next character, in a string or in a template literal.
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
            // eslint-disable-next-line no-new-func -- extracting the function under test, on purpose
            return new Function(`return (${source.slice(body, i + 1)})`)();
        }
    }
    throw new Error(`${name}: braces never balanced -- is the file truncated?`);
}

const appFailureText = load(app, 'withdrawalFailureText');
const appStageLabel = load(app, 'payoutStageLabel');
const receiptFailureText = load(receipt, 'withdrawalFailureText');
const receiptStageLabel = load(receipt, 'payoutStageLabel');

test("a provider's error text is never the sentence shown to the user", () => {
    // The real string, taken from a row a user looked at. It names a vendor they have no contract
    // with, an HTTP status and an endpoint, and "insufficient balance" describes the *provider's*
    // account -- read literally it tells the user their own money is short when it is not.
    const raw = 'NOWPayments /v1/payout returned 400.: Insufficient balance';

    for (const fn of [appFailureText, receiptFailureText]) {
        for (const status of ['refunded', 'failed', 'cancelled']) {
            const shown = fn({ status, failure_reason: raw, payout_error: raw, payout_status: 'FAILED' });
            assert.ok(shown.length > 0, `${status} showed the user nothing at all`);
            assert.ok(!shown.includes('NOWPayments'), 'named the provider to the user');
            assert.ok(!shown.includes('400'), 'showed the HTTP status to the user');
            assert.ok(!shown.includes('Insufficient'), 'showed a reason the user cannot act on');
        }
    }
});

test('a failed withdrawal tells the user the money is back', () => {
    // The single fact that matters and the only one the user can act on. Asserted as a substring
    // rather than an equality so copy can be reworded without this test becoming noise.
    for (const fn of [appFailureText, receiptFailureText]) {
        assert.match(fn({ status: 'refunded' }), /returned to your balance/i);
        assert.match(fn({ status: 'failed' }), /returned to your balance/i);
        assert.match(fn({ status: 'cancelled' }), /returned to your balance/i);
    }
});

test('a held payout says the money is still theirs and asks for nothing', () => {
    // SUBMISSION_UNKNOWN and VERIFY_UNKNOWN are the states where we genuinely do not know whether
    // the money moved. Promising a refund there would be a lie we might have to take back, and
    // telling the user to do something would be inventing a step. "Nothing is needed from you" is
    // the whole message, and it is the one that is true today.
    for (const fn of [appFailureText, receiptStageLabel]) {
        assert.match(fn({ status: 'pending', payout_status: 'SUBMISSION_UNKNOWN' }), /confirming/i);
        assert.match(fn({ status: 'pending', payout_status: 'VERIFY_UNKNOWN' }), /confirming/i);
    }
    assert.match(appFailureText({ payout_status: 'VERIFY_UNKNOWN' }), /nothing is needed from you/i);
});

test('a payout that is not done yet never reports a refund it has not made', () => {
    // Ordering matters: the held check has to come before the refunded check, or a row that is
    // both refunded and held would promise a balance the refund path has not touched yet.
    const held = appFailureText({ status: 'refunded', payout_status: 'VERIFY_UNKNOWN' });
    assert.ok(!/returned to your balance/i.test(held), 'promised a refund on a held payout');
});

test('a paid withdrawal reports no failure at all', () => {
    // Empty is the honest answer here. Printing an empty reason produced a blank line that read as
    // something missing; printing a stage is handled separately by payoutStageLabel.
    assert.equal(appFailureText({ status: 'paid', payout_status: 'FINISHED' }), '');
    assert.equal(receiptFailureText({ status: 'paid', payout_status: 'FINISHED' }), '');
});

test('an unclaimed withdrawal has no payout stage, not the word "null"', () => {
    // `String(withdrawal.payout_status)` with no fallback rendered the literal text "null" as a
    // stage on the receipt page -- visible to every user whose withdrawal had not been claimed yet.
    for (const fn of [appStageLabel, receiptStageLabel]) {
        assert.equal(fn({}), '');
        assert.equal(fn({ payout_status: null }), '');
        assert.equal(fn({ payout_status: undefined }), '');
        assert.equal(fn({ payout_status: '' }), '');
    }
});

test('no provider payout state reaches the user as its own word', () => {
    // The whole point of the allowlist. A `replace(/_/g, ' ')` on the raw value printed "creating",
    // "rejected not checked" and "verify unknown" at someone; an unmapped future state would have
    // done the same. Every branch is checked, including the fallback, because the fallback is the
    // one that runs for any state nobody has seen yet.
    //
    // The pattern matches the provider's *raw* vocabulary -- the underscored tokens and the
    // shouting capitals -- and deliberately not plain English words. "Sending" is our own copy and
    // is correct; "SENDING" is the provider leaking through. Matching case-sensitively on the
    // underscored forms catches the lower-cased "rejected not checked" spelling too, since that
    // one is spelled with spaces and can only come from the raw value.
    const providerVocab = /submission_unknown|verify_unknown|rejected not checked|\b(CREATING|PROCESSING|SENDING|WAITING|FINISHED|FAILED|CANCELLED|CANCELED|REJECTED)\b/;
    const stages = ['CREATING', 'NEW', 'WAITING', 'PROCESSING', 'SENDING', 'SUBMISSION_UNKNOWN',
        'VERIFY_UNKNOWN', 'FINISHED', 'FAILED', 'CANCELLED', 'CANCELED', 'REJECTED',
        'REJECTED_NOT_CHECKED', 'SOMETHING_NEW_FROM_THE_PROVIDER'];

    for (const fn of [appStageLabel, receiptStageLabel]) {
        for (const stage of stages) {
            const shown = fn({ payout_status: stage });
            assert.ok(shown.length > 0, `${stage} rendered as an empty stage`);
            assert.ok(!providerVocab.test(shown), `stage "${stage}" rendered as "${shown}"`);
        }
    }
});

test('a terminal provider state is described as not sent', () => {
    // Grouped on purpose: each of these means the transfer never went out, and every one of them
    // used to render its own word.
    for (const fn of [appStageLabel, receiptStageLabel]) {
        for (const stage of ['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED']) {
            assert.match(fn({ payout_status: stage }), /not sent/i, `${stage} was not described as not sent`);
        }
    }
});

test('the withdrawal markup renders the safe functions, not the raw columns', () => {
    // Guards against a future edit reintroducing the raw interpolation. The columns are still in
    // the API response -- an operator needs them -- so nothing upstream should stop sending them.
    for (const source of [app, receipt]) {
        assert.doesNotMatch(
            source,
            /\$\{\s*(item|withdrawal)\.failure_reason\s*\}/,
            'a raw failure_reason is interpolated into markup'
        );
        assert.doesNotMatch(
            source,
            /\$\{\s*(item|withdrawal)\.payout_error\s*\}/,
            'a raw payout_error is interpolated into markup'
        );
    }
});

test('every user-facing timestamp is pinned to a twelve-hour clock', () => {
    // Left to the locale, `toLocaleString()` follows the reader's OS setting, so one withdrawal
    // read "4:16 PM" for one person and "16:16" for the next. These are records people compare
    // against a bank statement, so the clock format has to be stable.
    const formatters = [
        ['public/app.js', 'detailTime'],
        ['public/app.js', 'formatDateTime'],
        ['public/withdrawal-receipt.js', 'formatDateTime'],
        ['public/history.js', 'formatDateTime'],
        ['public/deposit-receipt.js', 'formatDateTime']
    ];

    for (const [file, name] of formatters) {
        const body = read(file);
        const match = new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm').exec(body);
        assert.ok(match, `${name} not found in ${file}`);
        assert.match(match[0], /hour12: true/, `${file} ${name} does not pin the clock format`);
    }
});

test('a formatted timestamp is actually a twelve-hour one', () => {
    // The assertions above are structural and would pass on a `formatDateTime` that never formats
    // anything. This one runs the function: 22:07 with no zone offset is written out as a local
    // time, so it is unambiguously PM and must not come back as "22:07".
    const stamp = '2026-09-30T22:07:00';
    for (const [file, name] of [
        ['public/app.js', 'formatDateTime'],
        ['public/app.js', 'detailTime'],
        ['public/withdrawal-receipt.js', 'formatDateTime'],
        ['public/history.js', 'formatDateTime'],
        ['public/deposit-receipt.js', 'formatDateTime']
    ]) {
        const shown = load(read(file), name)(stamp);
        assert.match(shown, /10:07\s*PM/i, `${file} ${name} did not render a twelve-hour time`);
    }
});

test('a missing or unusable timestamp renders as nothing rather than "Invalid Date"', () => {
    // "Invalid Date" on a receipt is worse than a blank field: it looks like a bug in the record.
    for (const [file, name] of [
        ['public/app.js', 'formatDateTime'],
        ['public/app.js', 'detailTime'],
        ['public/withdrawal-receipt.js', 'formatDateTime'],
        ['public/history.js', 'formatDateTime'],
        ['public/deposit-receipt.js', 'formatDateTime']
    ]) {
        const fn = load(read(file), name);
        assert.equal(fn(''), '', `${file} ${name} rendered an empty timestamp`);
        assert.equal(fn(null), '', `${file} ${name} rendered a null timestamp`);
        assert.equal(fn(undefined), '', `${file} ${name} rendered an undefined timestamp`);
        assert.equal(fn('not a date'), '', `${file} ${name} rendered an unparseable timestamp`);
        assert.doesNotMatch(fn('not a date'), /invalid/i, `${file} ${name} rendered "Invalid Date"`);
    }
});

test('the deposit receipt uses the shared formatter rather than a bare locale call', () => {
    // Structural, because the deposit page was the one place still carrying raw `toLocaleString()`
    // calls: a reader comparing "Pay by" against a block explorer was reading two different clocks.
    const bare = /new Date\((deposit|item|withdrawal)\.[a-z_]+\)\.toLocaleString\(\)/g;
    for (const file of ['public/app.js', 'public/deposit-receipt.js', 'public/history.js',
        'public/withdrawal-receipt.js']) {
        assert.equal(read(file).match(bare), null, `${file} still formats a timestamp without a clock format`);
    }
});

/**
 * The topbar clock, which needs two of its own module's bindings to run outside the page.
 *
 * `formatTime` is not self-contained: it calls `zoneFormatter`, which reads `CLOCK_ZONE`. Both are
 * lifted alongside it rather than stubbed. A stub would be the wrong instrument here -- a fake
 * formatter that ignores the zone would happily agree with a wrong answer, and the whole point is
 * to check what the user is actually shown.
 */
function loadClockFormat() {
    const clock = read('public/clock.js');

    const zoneExpression = /const CLOCK_ZONE = ([\s\S]*?);\r?\n/.exec(clock);
    assert.ok(zoneExpression, 'CLOCK_ZONE is gone from clock.js');
    const zoneName = new Function(`return (${zoneExpression[1]})`)();

    const zoneSource = load(clock, 'zoneFormatter');
    // eslint-disable-next-line no-new-func -- lifting clock.js's own helper out, on purpose
    const zoneFormatter = new Function('CLOCK_ZONE', `return (${zoneSource})`)(zoneName);

    const timeSource = load(clock, 'formatTime');
    // eslint-disable-next-line no-new-func -- lifting clock.js's formatter out, on purpose
    return new Function('zoneFormatter', `return (${timeSource})`)(zoneFormatter);
}

test('the live topbar clock is a twelve-hour clock with the meridiem spelled out', () => {
    // This one was `hour12: false`, on the reasoning that a seconds ticker is cleaner in 24-hour
    // form. It was wrong: "16:16" reads as a military or broadcast time to a large share of people,
    // and offers and survey windows close on a wall-clock day, so the reader needs to know whether
    // a deadline is this afternoon or tonight. The meridiem is what says that, so it has to be
    // there rather than inferred.
    assert.match(read('public/clock.js'), /hour12: true/, 'the topbar clock is still on a twenty-four hour clock');

    // Called, not grepped: a formatter that pins `hour12` but never asks for the hour would pass
    // the assertion above and print nothing at all.
    const formatTime = loadClockFormat();

    // The clock renders in site time, so a bare UTC instant is ambiguous -- 16:07Z is noon in
    // New York. The meridiem is therefore checked against the hour the reader would see, which is
    // the only thing that matters: "PM" on something that is a morning, or "AM" on something that
    // is an evening, is worse than no suffix at all because it is confidently wrong.
    const zoneName = /const CLOCK_ZONE = ([\s\S]*?);\r?\n/.exec(read('public/clock.js'))[1]
        .replace(/['"]/g, '');
    const siteHour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: zoneName });

    const instants = [
        ['2026-01-15T16:07:32Z', 'an afternoon'],
        ['2026-01-15T21:30:00Z', 'an evening'],
        ['2026-01-15T14:00:00Z', 'early afternoon'],
        ['2026-07-15T02:15:00Z', 'the small hours'],
        ['2026-07-15T23:45:00Z', 'just before midnight']
    ];

    for (const [iso, label] of instants) {
        const when = new Date(iso);
        const shown = formatTime(when);
        const expectedMeridiem = Number(siteHour.format(when)) >= 12 ? 'PM' : 'AM';

        assert.match(shown, /(AM|PM)$/, `${label}: "${shown}" does not end in a meridiem`);

        // 24-hour on the wire, 12-hour on screen: if the rendered hour equals the site's 24-hour
        // hour in the afternoon, the clock ignored `hour12` and the meridiem is the only thing
        // disagreeing with the number.
        const twentyFour = Number(siteHour.format(when));
        const twelve = twentyFour % 12 === 0 ? 12 : twentyFour % 12;
        assert.match(
            shown,
            new RegExp(`^${twelve}:`),
            `${label}: site hour ${twentyFour} rendered as "${shown}"`
        );
        assert.ok(
            shown.endsWith(expectedMeridiem),
            `${label}: site hour ${twentyFour} is ${expectedMeridiem} but rendered as "${shown}"`
        );
        // 24-hour on the wire, 12-hour on screen. Only meaningful in the afternoon and evening:
        // at 11am the two forms are both "11", so there is nothing to catch there.
        if (twentyFour > 12) {
            assert.doesNotMatch(
                shown.split(':')[0],
                new RegExp(`^${twentyFour}$`),
                `${label}: the clock printed the 24-hour hour "${twentyFour}" as "${shown}"`
            );
        }
    }
});

test('no timestamp anywhere in the interface is left on a twenty-four hour clock', () => {
    // The sweep that started this: one bare `toLocaleString()` on a receipt is enough for the same
    // record to read "4:16 PM" in one place and "16:16" in another. Scoped to the pages' scripts
    // rather than the whole repo so it fails on user-facing time, not on server logs.
    //
    // Only calls that render a *time* are held to it. `toLocaleString(undefined, { minimumFraction-
    // Digits: 2 })` is money -- $8.00, no clock involved -- and a date-only call has no meridiem
    // to get wrong. Flagging those would have made this test fail on correct code, which is how a
    // sweep gets switched off.
    const userFacing = ['public/app.js', 'public/history.js', 'public/deposit-receipt.js',
        'public/withdrawal-receipt.js', 'public/home.js', 'public/demo.js', 'public/clock.js'];

    for (const file of userFacing) {
        const source = read(file);
        for (const m of source.matchAll(/toLocale(Date|Time)?String\(([^)]*)\)/g)) {
            const args = m[2].trim();
            // `toLocaleDateString` never renders a time, so it never has a meridiem to get wrong.
            const rendersTime = m[1] !== 'Date'
                && (args === '' || /\b(hour|minute|second)\s*:/.test(args));
            if (!rendersTime) continue;
            assert.match(
                m[0],
                /hour12:\s*(true|false)/,
                `${file}: ${m[0]} renders a time but pins no clock format, so it follows the reader's OS`
            );
        }
    }
});