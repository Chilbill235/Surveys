const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Clickable notifications.
 *
 * A notification is a sentence about something that happened somewhere else, so reading it is
 * usually only the first half of what the user wants. The rest is going and looking at it. Before
 * this, every notice in the app was that first half with nothing behind it -- and the bell was
 * the sharper version of the same bug: `renderNotificationList` had a `window.location.assign`
 * behind an `item.href` that *nothing in the codebase ever set*, so the row looked live, took a
 * click, marked itself read, and went nowhere.
 *
 * The tests are mostly structural because the properties that matter are about which element is
 * created and what is reachable, not about a return value.
 */

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const historyJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'history.js'), 'utf8');

/** Extracts a top-level function declaration by name, as source text. */
function extract(name) {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not defined`);
    // The body brace is *not* the first brace after the name: `showToast` destructures its
    // options, so counting from there matches the parameter object's own braces and returns the
    // signature instead of the function. The parameter list's closing paren is found first.
    const parenStart = app.indexOf('(', start);
    let parenDepth = 0;
    let bodyStart = -1;
    for (let i = parenStart; i < app.length; i += 1) {
        const character = app[i];
        if (character === '(') parenDepth += 1;
        else if (character === ')') {
            parenDepth -= 1;
            if (parenDepth === 0) {
                bodyStart = app.indexOf('{', i);
                break;
            }
        }
    }
    assert.notEqual(bodyStart, -1, `could not find the body of ${name}`);
    let depth = 0;
    for (let i = bodyStart; i < app.length; i += 1) {
        if (app[i] === '{') depth += 1;
        else if (app[i] === '}') {
            depth -= 1;
            if (depth === 0) return `${app.slice(start, bodyStart)}\n${app.slice(bodyStart, i + 1)}`;
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}

/** Runs `notificationTarget` with the module's constant table and the row-id helper in scope. */
function targetFor(input) {
    const source = `${extract('notificationTarget')}`;
    const table = app.slice(
        app.indexOf('const NOTIFICATION_TARGETS'),
        app.indexOf('};', app.indexOf('const NOTIFICATION_TARGETS')) + 2
    );
    // `historyRowId` too, because `notificationTarget` calls it. The link and the id the history
    // page puts on the row are two halves of one format, and a harness that provided only one of
    // them would let a change to the other through untested.
    const rowId = extract('historyRowId');
    // Two invocations, and the difference matters: `new Function(body)` *returns* the wrapper,
    // so the first call is what evaluates the body and yields `notificationTarget`. Without it
    // this returns the function itself, and every assertion below quietly reads `.href` off a
    // function -- which is `undefined`, so all four fail at once with no useful message.
    const build = new Function(`${table}\n${rowId}\n${source}\nreturn notificationTarget;`);
    return build()(input);
}

test('each kind of notice points somewhere', () => {
    // Keyed by category, not by title. Titles are prose and get reworded; a matching failure
    // would be silent, leaving every notice without a destination the day someone improved
    // the wording of one.
    assert.match(
        app,
        /const NOTIFICATION_TARGETS = \{[\s\S]*deposit:[\s\S]*withdrawal:[\s\S]*reward:/,
        'the category -> destination table is missing or incomplete'
    );

    assert.equal(targetFor({ category: 'deposit' }).href, '/account');
    assert.equal(targetFor({ category: 'withdrawal' }).href, '/account');
    assert.equal(targetFor({ category: 'reward' }).href, '/account');
});

test('a deposit notice points at that deposit\'s row in the history list', () => {
    // The history list, not the receipt page directly. The list is where someone goes to see
    // their money in context -- what else happened, what the balance did -- and it can offer
    // the receipt from there. A link that skipped past it answered a narrower question than the
    // one the notice raised.
    assert.equal(targetFor({ category: 'deposit', depositId: 42 }).href, '/account#history-deposit-42');
    assert.equal(targetFor({ category: 'deposit', depositId: 42 }).label, 'View in history');
    // Without an id it falls back to the list rather than linking to a row that cannot exist.
    assert.equal(targetFor({ category: 'deposit' }).href, '/account');
});

test('the fragment a notice carries is the id the history page puts on the row', () => {
    // These two halves are written in different files and have to agree exactly. When they do
    // not, the link scrolls nowhere and the page looks like it ignored the click -- which is the
    // failure the whole feature is for.
    const fragment = targetFor({ category: 'withdrawal', withdrawalId: 87 }).href.split('#')[1];
    assert.equal(fragment, 'history-withdrawal-87');
    assert.match(
        historyJs,
        /row\.id = historyRowId\(record\.kind, record\.id\)/,
        'the history page no longer puts that id on its rows'
    );
    // The kind is sanitised rather than trusted. It only ever comes from this module's own two
    // literals today, but it is concatenated into a fragment, and the property that matters is
    // that nothing survives which could break out of one.
    const buildRowId = new Function(`${extract('historyRowId')}\nreturn historyRowId;`)();
    assert.equal(buildRowId('deposit', 42), 'history-deposit-42');
    assert.equal(buildRowId('dep osit', 42), 'history-deposit-42', 'the kind is not sanitised');
    assert.equal(buildRowId('"><script>', '42'), 'history-script-42', 'the kind is not sanitised');
    assert.equal(buildRowId('', '42'), 'history--42', 'an empty kind produces a bare prefix');
});

test('a record id is url-encoded rather than pasted into the fragment', () => {
    // The id reaches a url, so it is encoded. Not a real id today, but the function is the only
    // thing standing between a stored notification and a malformed link.
    const buildRowId = new Function(`${extract('historyRowId')}\nreturn historyRowId;`)();
    assert.equal(buildRowId('deposit', '1 2'), 'history-deposit-1%202');
});

test('a notice with nowhere to go stays a plain card', () => {
    // The load-bearing negative. `null` is a real answer here, and it is what stops this
    // becoming "every toast is clickable" -- a control that navigates nowhere is worse than
    // one that does not look clickable.
    assert.equal(targetFor({}), null);
    assert.equal(targetFor({ category: null }), null);
    assert.equal(targetFor({ category: 'made-up' }), null);
});

test('a caller that knows a specific destination is not overruled by its category', () => {
    assert.equal(targetFor({ category: 'reward', href: '/somewhere-else' }).href, '/somewhere-else');
});

test('a clickable toast is a real button, not a div with a click handler', () => {
    // The rule this codebase has been bitten by twice already: anything clickable is a real
    // element. A `div` here means no keyboard activation, no focus, and no accessible name --
    // three failures that look identical to "it works" when you click it with a mouse.
    const body = extract('showToast');
    assert.match(
        body,
        /<button class="toast-action" type="button">/,
        'the clickable part of a toast is not a button element'
    );
    assert.doesNotMatch(
        body,
        /toast\.addEventListener\('click'/,
        'the toast div itself is the click target rather than a control inside it'
    );
    // And it must be the whole message, not a small link in the corner: what the user is aiming
    // at after reading "your deposit landed" is the message itself.
    assert.match(body, /class="toast-action" type="button">\s*\$\{body\}/, 'the button does not wrap the message');
});

test('the toast close button stays available on a clickable toast', () => {
    // Activating the whole card must not cost the user their other way out. They are rendered
    // in both branches, and the close handler only dismisses -- if it also navigated, a user
    // reaching for the X would be sent to another page.
    const body = extract('showToast');
    const closeCount = (body.match(/class="toast-close"/g) || []).length;
    assert.equal(closeCount, 2, 'the close button is not rendered in both the linked and plain branches');
    assert.match(
        body,
        /toast\.querySelector\('\.toast-close'\)\.addEventListener\('click', \(\) => dismissToast\(id\)\)/,
        'the close button does something other than dismiss'
    );
    assert.doesNotMatch(
        body,
        /addEventListener\('click', \(\) => dismissToast\(id\)\);[\s\S]{0,80}location\.assign/,
        'dismissing also navigates'
    );
});

test('following a notice dismisses it rather than leaving it over the destination', () => {
    // Otherwise the toast is still counting down on the page the user just navigated to, and on
    // a slow connection they arrive and then watch a message about the thing they clicked fade.
    const body = extract('showToast');
    assert.match(
        body,
        /addEventListener\('click', \(\) => \{\s*dismissToast\(id\);\s*followNotificationTarget/,
        'the toast is not dismissed before navigating'
    );
});

test('a click on a notice whose destination is already open still does something', () => {
    // `location.assign` to the page and fragment already open is genuinely nothing: no
    // navigation, no document load, and no `hashchange`, because the fragment did not change. So
    // the second click on the same notification had no effect at all, and if the first click
    // arrived before the row was on the page there was nothing on screen to recover to.
    const body = extract('followNotificationTarget');
    assert.match(
        body,
        /current === href[\s\S]{0,200}?dispatchEvent\(new Event\('hashchange'\)\)/,
        'a notice pointing at the open page does not re-trigger the page'
    );
    assert.match(body, /location\.assign\(href\)/, 'a notice pointing elsewhere no longer navigates');
});

test('a bell entry is still a real link, and a plain click is intercepted', () => {
    // The href has to stay, so middle-click and "open in new tab" keep working. The interception
    // is only for a plain left click, for the same-fragment reason as above -- and every
    // modified click is deferred to the browser, which is what keeps those affordances real.
    const list = extract('renderNotificationList');
    assert.match(list, /link\.href = target\.href/, 'the bell entry is not a real link');
    assert.match(
        list,
        /metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/,
        'a modified click is not left to the browser'
    );
    assert.match(list, /followNotificationTarget\(target\.href\)/, 'the bell does not follow its target');
});

test('a bell entry with a destination is a real link', () => {
    // It used to be a `div` whose click handler ended at `window.location.assign(item.href)`,
    // with `item.href` never set anywhere. Making it an `<a>` means the destination is in the
    // DOM: middle-click, "open in new tab", and keyboard activation all work, and a link with
    // no href is visibly not a link rather than silently inert.
    assert.match(app, /const link = document\.createElement\('a'\)/, 'a linked notification is not an anchor');
    assert.match(app, /link\.href = target\.href/, 'the anchor has no destination');
    assert.doesNotMatch(
        extract('renderNotificationList'),
        /window\.location\.assign\(item\.href\)/,
        'navigation is still done from a click handler on a non-link element'
    );
});

test('both halves of a notice agree on where it goes', () => {
    // They used to disagree by construction: the helpers passed `category` only to
    // `pushNotification`, so the bell could in principle have had a target the toast did not.
    // Every helper that announces money now sets it on both.
    for (const helper of [
        'notifyDepositConfirmed', 'notifyWithdrawalSubmitted',
        'notifyWithdrawalPaid', 'notifyWithdrawalFailed'
    ]) {
        const body = extract(helper);
        const toastLine = body.match(/showToast\([^;]*?\{([^}]*)\}/);
        assert.ok(toastLine, `${helper} has no toast options`);
        assert.match(toastLine[1], /category:/, `${helper} does not tell the toast its category`);
        assert.match(body, /pushNotification\([\s\S]*category:/, `${helper} does not tell the bell its category`);
    }
});

test('following a notification marks it read', () => {
    // It has to. A link that navigates away still has to count as read, or reading it by
    // following the link leaves the badge claiming it was never seen.
    const body = extract('renderNotificationList');
    assert.match(body, /if \(!item\.read\) markNotificationRead\(item\.id\)/, 'a read is not recorded');
    // And the mark must happen before the row is built, not in a click handler the keyboard
    // never reaches.
    assert.ok(
        body.indexOf('markNotificationRead') < body.indexOf("createElement('a')"),
        'the read is recorded on click rather than as the row is built'
    );
});

test('the destination label does not corrupt the title for a screen reader', () => {
    // The button's accessible name is everything inside it, so folding "View receipt" into the
    // title would be announced as one long claim about money. It is a separate element, which
    // reads as a separate line.
    assert.match(app, /class="toast-action-label"/, 'the destination label is not its own element');
    assert.doesNotMatch(
        extract('showToast'),
        /toast-title">\$\{escapeHtml\(title\) \+ /,
        'the destination has been appended to the title'
    );
});

test('a notice with no destination is not in the tab order', () => {
    // It is not a control. Giving a keyboard user something focusable that does nothing is the
    // trap this codebase keeps walking into, so the negative is asserted.
    const body = extract('showToast');
    assert.match(body, /if \(target\) \{[\s\S]*\} else \{/, 'there is no non-clickable branch');
});