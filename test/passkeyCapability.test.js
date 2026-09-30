const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Why the passkey card was invisible on iPhones, and why it no longer is.
 *
 * The old `start()` did not reveal the card until a `GET /api/auth/passkeys` had succeeded.
 * That reads like a sensible guard -- "do not show a security control to someone who cannot
 * use it" -- and on iOS it removed the control from most of the devices that wanted it. A
 * signed-out visitor, a slow connection and a phone with no Face ID enrolled all produced the
 * identical outcome: a card that was simply not in the page, with nothing saying why. The
 * reader cannot distinguish "this device cannot use passkeys" from "this site has no passkeys",
 * and the second is the reading people reach for.
 *
 * These tests pin the split that fixed it: the card's visibility depends only on whether the
 * browser has the WebAuthn API, and everything else -- authentication, device capability --
 * affects what is drawn inside it.
 */

const sharedPath = path.join(__dirname, '..', 'public', 'account-passkeys.js');
const source = fs.readFileSync(sharedPath, 'utf8');
const accountHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');

const sharedModulePath = path.join(__dirname, '..', 'public', 'passkey-shared.js');
const sharedModuleSource = fs.readFileSync(sharedModulePath, 'utf8');

/**
 * The real in-app detector, lifted out of `passkey-shared.js`.
 *
 * `explainUnavailable()` reads the pattern from the shared module rather than keeping its own
 * copy, and the two had drifted: the copy on the account page recognised three apps while the
 * shared one recognised the ones users actually hit. Reading the *real* pattern out of the
 * module keeps this test from passing against a stub that no longer matches what ships, which
 * is the specific failure the drift caused.
 */
const EMBEDDED_PATTERN_SOURCE = /const embeddedBrowserPattern = (\/.*?\/[a-z]*);/.exec(sharedModuleSource);
assert.ok(EMBEDDED_PATTERN_SOURCE, 'embeddedBrowserPattern is not in public/passkey-shared.js');
const embeddedBrowserPattern = vm.runInNewContext(EMBEDDED_PATTERN_SOURCE[1]);

/** Lifts a function declaration out of the browser script by matching braces from its body. */
function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in public/account-passkeys.js`);
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
 * Runs `explainUnavailable` against a stubbed navigator.
 *
 * The user agent and touch-point count are injected rather than emulated, because that is the
 * only part of the decision that varies and it is the part worth testing: getting an iPhone to
 * look like an iPhone needs a real device profile, while every branch here is reached through
 * one string.
 */
function runExplain(userAgent, { maxTouchPoints = 0, available = false } = {}) {
    const dom = {
        'passkey-notice': { hidden: true },
        'passkey-notice-title': { textContent: '' },
        'passkey-notice-body': { textContent: '' },
        'passkey-help': { open: false }
    };
    const addButton = { disabled: false, dataset: {} };
    dom['passkey-add'] = addButton;

    // `explainUnavailable` reads the notice elements through the module-level consts the real
    // file binds at load, not through `document.getElementById` each time. Those are supplied
    // here from the same stub elements so the function writes to what the test then reads.
    const context = {
        navigator: { userAgent, maxTouchPoints },
        notice: dom['passkey-notice'],
        noticeTitle: dom['passkey-notice-title'],
        noticeBody: dom['passkey-notice-body'],
        addButton,
        shared: { embeddedBrowserPattern },
        document: { getElementById: (id) => dom[id] || null }
    };
    vm.runInContext(
        `${extractFunction('explainUnavailable')}\nexplainUnavailable(${available});`,
        vm.createContext(context)
    );
    return {
        title: dom['passkey-notice-title'].textContent,
        body: dom['passkey-notice-body'].textContent,
        noticeShown: dom['passkey-notice'].hidden === false,
        helpOpen: dom['passkey-help'].open,
        addButton
    };
}

const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SAFARI_IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const SAFARI_MAC = SAFARI_IPAD_OS;
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const INSTAGRAM_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]';
const WECHAT_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40';

test('the card is revealed without waiting for the network', () => {
    // This is the whole fix, asserted structurally because it is a visibility ordering that no
    // unit test of a helper can see. The old code fetched first and returned on failure, which
    // is what removed the card from iPhones.
    const start = extractFunction('start');
    const revealAt = start.indexOf('card.hidden = false');
    const listAt = start.indexOf('await refresh()');

    assert.notEqual(revealAt, -1, 'the card is never revealed');
    assert.notEqual(listAt, -1, 'the list is never refreshed');
    assert.ok(revealAt < listAt, 'the card is still revealed only after the list request');

    // And it must not be conditional on the request succeeding. The old guard was
    // `if (!response.ok) return;` before the reveal, which is the exact line that hid it.
    assert.doesNotMatch(
        start.slice(0, revealAt),
        /response\.ok\s*\)\s*return/,
        'the reveal is still gated on a successful request'
    );
});

test('a failed list request leaves an empty list, not a missing card', () => {
    // A signed-out or offline visitor must still see the control and the instructions. The
    // list underneath is the only thing that is allowed to be empty.
    const start = extractFunction('start');
    assert.match(start, /catch\s*\{[\s\S]*render\(\[\]\)/, 'a failed refresh no longer falls back to an empty list');
});

test('an iPhone without Face ID is told what to do', () => {
    const out = runExplain(SAFARI_IPHONE, { maxTouchPoints: 5 });
    assert.equal(out.noticeShown, true, 'no notice was shown at all');
    assert.match(out.title, /Face ID or Touch ID/);
    // The fix, not just the diagnosis. A notice that only says "not supported" leaves the
    // reader with nothing to do.
    assert.match(out.body, /Settings/);
    assert.match(out.body, /Face ID & Passcode/);
    assert.match(out.body, /16\.4/, 'the Safari version floor is not mentioned, which is a real cause');
});

test('an iPad is not told to open Face ID settings', () => {
    // iPadOS 13+ reports a Mac user agent, which is the only reason the touch-point check below
    // exists. Getting here and saying "iPhone" sends someone to a settings screen that does not
    // exist on an iPad, which has Touch ID and no Face ID at all.
    const out = runExplain(SAFARI_IPAD_OS, { maxTouchPoints: 5 });
    assert.match(out.title, /Face ID or Touch ID/, 'the iPad branch is not reached');
    assert.doesNotMatch(out.title, /iPhone/, 'an iPad was told it was an iPhone');
});

test('a Mac is not mistaken for an iPad', () => {
    // Same user agent as the iPad, one touch point. A Mac with a Touch Bar reports zero, and a
    // desktop with a touchscreen reports one -- neither is five, and both must fall through to
    // the desktop wording rather than being told to set up Face ID.
    const out = runExplain(SAFARI_MAC, { maxTouchPoints: 0 });
    assert.match(out.title, /No biometric or screen lock/);
});

test('a phone in an in-app browser is told to open the real browser', () => {
    // The one case where nothing in Settings will fix it. Face ID is fully working on the
    // device; what is missing is the in-app viewer's access to the authenticator. Telling the
    // reader to go and change a setting that is already correct is worse than saying nothing.
    for (const ua of [INSTAGRAM_IOS, WECHAT_ANDROID]) {
        const out = runExplain(ua, { maxTouchPoints: 5 });
        assert.match(out.title, /normal browser/, `in-app webview not detected for ${ua.slice(0, 40)}`);
        assert.match(out.body, /Safari|browser/i);
    }
});

test('an Android phone without a screen lock names the Android fix', () => {
    const out = runExplain(CHROME_ANDROID, { maxTouchPoints: 5 });
    assert.match(out.title, /Screen lock/);
    assert.match(out.body, /fingerprint|screen lock/i);
});

test('the button stays usable even when a problem is reported', () => {
    // `isUserVerifyingPlatformAuthenticatorAvailable()` is a hint, not a guarantee. A desktop
    // browser with a USB security key attached reports no platform authenticator and can still
    // create a passkey perfectly well. Disabling the button on that signal removes the only way
    // to use a security key through this card.
    const out = runExplain(SAFARI_MAC, { maxTouchPoints: 0 });
    assert.equal(out.addButton.disabled, false, 'the button was disabled by a capability hint');
});

test('the setup steps open by themselves when a problem is reported', () => {
    // The reader has just been told Face ID is the problem. Making them then click a summary to
    // read how to fix it is an extra step with nothing gained.
    const out = runExplain(SAFARI_IPHONE, { maxTouchPoints: 5 });
    assert.equal(out.helpOpen, true, 'the instructions stayed collapsed behind a summary');
});

test('the notice, the status and the instructions are in the markup', () => {
    // `check-frontend.js` only verifies ids exist somewhere; this pins that they are on the
    // account page, which is the only page that renders this card.
    for (const id of [
        'passkey-card',
        'passkey-notice',
        'passkey-notice-title',
        'passkey-notice-body',
        'passkey-add',
        'passkey-help',
        'passkey-list',
        'passkey-status'
    ]) {
        assert.match(accountHtml, new RegExp(`id="${id}"`), `#${id} is not in account.html`);
    }
});

test('the instructions name the actual iOS settings path', () => {
    // A wrong path is the difference between a fix and a dead end. "Face ID & Passcode" is the
    // real label on iOS 11 and later; the older "Touch ID & Passcode" is what pre-2018 devices
    // show, and those cannot run the Safari this feature needs anyway.
    assert.match(accountHtml, /Face ID &amp; Passcode/);
    assert.match(accountHtml, /Set Up Face ID/);
    assert.match(accountHtml, /Open this site in <strong>Safari<\/strong>/);
});

test('a browser with no way to ask is not told it has no authenticator', () => {
    // `isUserVerifyingPlatformAuthenticatorAvailable` was not implemented everywhere, and older
    // Safari throws rather than resolving. Both are reported as "unchecked", not as
    // "unavailable" -- treating a failed probe as a negative answer is how a working button
    // gets disabled.
    const check = extractFunction('checkPlatformAuthenticator');
    assert.match(check, /typeof PublicKeyCredential\.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'/);
    assert.match(check, /catch\s*\{[\s\S]*checked: false/);
    assert.doesNotMatch(check, /checked: false, available: false/, 'a failed probe is reported as a negative answer');
});

test('the refusal messages a press can produce are translated', () => {
    // The capability probe runs before the press, so it cannot see everything that can go
    // wrong. These are the errors the press itself produces, and the raw WebAuthn names are
    // meaningless to the person who pressed the button.
    assert.match(source, /NotAllowedError/, 'NotAllowedError is not handled');
    assert.match(source, /SecurityError/, 'SecurityError is not handled');
    assert.match(source, /NotSupportedError/, 'NotSupportedError is not handled');
    assert.match(source, /https:\/\//, 'the https requirement is not explained');
});

/**
 * The defect that made "Face ID is not working" unreportable.
 *
 * `isCancellation()` claimed `NotAllowedError` before the explanatory branch could see it, and
 * `NotAllowedError` is the spec's catch-all for every abort path -- not just a deliberate
 * dismissal. So an iPhone with no Face ID enrolled, or a page open in an in-app browser, threw
 * that error, the caller was told it was a cancellation, and it said nothing at all: no
 * credential sheet, no message, no button state that explains itself. The specific
 * `NotAllowedError` branch explaining the iOS setup existed in the file and was unreachable.
 */
test('a NotAllowedError is not swallowed as a cancellation', () => {
    assert.doesNotMatch(
        /function isCancellation\(error\)\s*\{[\s\S]*?\}/.exec(sharedModuleSource)[0],
        /NotAllowedError/,
        'isCancellation still claims NotAllowedError, so the explanatory branch is dead code'
    );
    assert.match(sharedModuleSource, /AbortError/, 'a genuine cancellation is no longer recognised');
    // And the branch that does the explaining has to come after the cancellation check, or it
    // is still unreachable.
    const cancelAt = source.indexOf('shared.isCancellation(error)');
    const notAllowedAt = source.indexOf("error?.name === 'NotAllowedError'");
    assert.notEqual(cancelAt, -1, 'the cancellation check is gone');
    assert.notEqual(notAllowedAt, -1, 'the NotAllowedError branch is gone');
    assert.ok(cancelAt < notAllowedAt, 'the cancellation check runs first, so the branch is dead');
});

test('a silent NotAllowedError is told how to fix it, per device', () => {
    // The wording cannot come from the exception -- it is the same error for a dismissal and a
    // missing setup -- so it is chosen from the device. Each of these is a case where the user
    // pressed the button, saw no Face ID sheet, and previously got nothing at all.
    const advice = (userAgent, platformAvailable) => {
        const context = {
            navigator: { userAgent, maxTouchPoints: 5 },
            error: { name: 'NotAllowedError' },
            shared: {
                embeddedBrowserPattern,
                notAllowedAdvice: extractSharedFunction('notAllowedAdvice'),
                hasPlatformAuthenticator: async () => platformAvailable
            }
        };
        vm.runInContext(
            `${EMBEDDED_PATTERN_SOURCE[0]}\n${extractSharedFunction('notAllowedAdvice')}\n`
            + 'this.result = notAllowedAdvice(error, ' + JSON.stringify(platformAvailable) + ');',
            vm.createContext(context)
        );
        return context.result;
    };

    // Nothing set up on the device: name the real settings screen.
    assert.match(advice(SAFARI_IPHONE, false), /Face ID & Passcode/);
    assert.match(advice(CHROME_ANDROID, false), /screen lock/i);
    // An in-app viewer, where Face ID is working fine and the fix is a different browser.
    // Checked first, because telling someone to change a setting that is already correct is
    // worse than saying nothing.
    assert.match(advice(INSTAGRAM_IOS, true), /Safari|browser/i);
    // A genuine dismissal on a device that reports a working authenticator: say nothing.
    assert.equal(advice(SAFARI_IPHONE, true), null);
    // Cannot tell whether the device is set up: silence is the honest answer.
    assert.equal(advice(SAFARI_IPHONE, null), null);
});

test('the login page says so before the press, not after it fails', () => {
    // `account-passkeys.js` had an in-app notice and `passkeys.js` had none, so a visitor
    // signing in inside an app got a dead button and discovered the reason only by pressing it.
    const loginSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'passkeys.js'), 'utf8');
    assert.match(loginSource, /embeddedBrowserPattern/, 'the login page has no in-app browser check');
    assert.match(loginSource, /notAllowedAdvice/, 'the login page does not explain a silent failure');
    // The capability answer has three states -- yes, no, and "the browser could not say" --
    // and collapsing the third into the second is what told every older Safari, whose probe
    // throws, that it had no screen lock. Asserted as the three-way shape rather than by the
    // literal `null`, so rephrasing the branches does not break a test that is about the
    // decision.
    const reveal = loginSource.slice(loginSource.indexOf('async function reveal('));
    assert.match(
        reveal,
        /const platform = await shared\.hasPlatformAuthenticator\(\)/,
        'the capability answer is defaulted rather than asked for'
    );
    assert.match(reveal, /platform === true/, 'the "has an authenticator" branch is gone');
    assert.match(reveal, /platform === false/, 'the "no authenticator" branch is gone');
    assert.match(
        reveal,
        /}\s*else\s*\{\s*note\.textContent = 'Use Face ID/,
        'there is no third branch for a browser that could not answer'
    );
});

test('the in-app detector covers the apps people actually open links in', () => {
    // The original three (Facebook, Instagram, WeChat) missed the ones that produced most of
    // the reports, and every miss presented as "Face ID is broken" rather than "open the real
    // browser". Asserted against the real pattern so a token removed here is a test failure.
    for (const token of [
        'Instagram', 'FBAN', 'MicroMessenger', 'Snapchat',
        'Telegram', 'Discord', 'Slack', 'WhatsApp', 'Teams', 'Line/', 'Signal', 'KAKAOTALK'
    ]) {
        assert.ok(
            embeddedBrowserPattern.test(`Mozilla/5.0 ${token}/8.0`),
            `the in-app detector misses ${token}`
        );
    }
    // And it must not match ordinary browsers, or it tells working desktop Chrome to go and
    // change a setting that is already correct.
    for (const ua of [SAFARI_IPHONE, SAFARI_IPAD_OS, CHROME_ANDROID, SAFARI_MAC]) {
        assert.equal(embeddedBrowserPattern.test(ua), false, `a normal browser matched: ${ua.slice(0, 40)}`);
    }
});

/** Lifts a declaration out of the shared browser module by matching braces from its body. */
function extractSharedFunction(name) {
    const start = sharedModuleSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in public/passkey-shared.js`);
    const bodyStart = sharedModuleSource.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < sharedModuleSource.length; i += 1) {
        const character = sharedModuleSource[i];
        if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) return sharedModuleSource.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}
