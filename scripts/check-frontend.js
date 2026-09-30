/* Static consistency checks for the frontend: balanced CSS, and every element id the
 * scripts reach for must exist in the page that loads them. Run from the project root.
 */
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

let problems = 0;
const fail = (message) => { problems += 1; console.log('FAIL ' + message); };
const pass = (message) => console.log('PASS ' + message);

/**
 * Every page the app serves, for every check that only needs the markup.
 *
 * Coverage used to stop at the four pages that existed when this file was written, so
 * `account.html`, `history.html`, `deposit-receipt.html`, `privacy.html` and `terms.html`
 * were never verified at all. That is not a theoretical gap: the notification work added
 * markup carrying three classes with no rule for them, on exactly the pages missing from
 * this list, and `check:frontend` still reported a clean bill of health.
 */
const pages = [
    'index.html',
    'home.html',
    'demo.html',
    'account.html',
    'history.html',
    'deposit-receipt.html',
    'reset-password.html',
    'privacy.html',
    'terms.html',
    // Their own pages, linked from every footer. Listed here so the same id, label, and
    // contact-trigger checks that cover the other pages cover these too -- a legal page is
    // the last place to want a broken id or a control with no accessible name.
    'cookies.html',
    'aml.html'
];

/**
 * There is deliberately no hand-written "page -> script" table here any more.
 *
 * The one that used to exist listed each page's script so the id cross-reference could be
 * asserted, and it drifted the moment the account page appeared: `app.js` became a script
 * shared by three pages, so the table either had to gain three near-identical entries or
 * quietly stop describing reality. The mapping is now read out of the pages themselves, which
 * is also what `allScripts` below does.
 */

/** Every script any page loads, read from the pages themselves so the list cannot drift. */
const allScripts = [...new Set(pages.flatMap(
    (htmlFile) => [...read(htmlFile).matchAll(/<script[^>]*src="\/([^"]+\.js)"/g)].map((m) => m[1])
))];

const css = read('style.css');

// ---------------------------------------------------------------- JS parses
//
// `node --check` on every script any page loads.
//
// This check exists because a backtick inside a comment within a template literal
// terminated the string early, and `helpdesk.js` shipped as a syntax error. The file was
// syntactically broken on all twelve pages and every other check passed: the stylesheet
// balanced, the ids resolved, the labels were present, the contrast was fine. A broken
// script is a page that renders and then does nothing, and the only reason it was caught at
// all was `audit:pages`, which drives a real browser, is slow, and had not been run.
//
// The cost is one parse per file on every `npm run check`, which is the right trade: a
// syntax error is the most total failure a page can have, and it is the cheapest to detect.
// Run through a child process rather than `new Function` so the file is checked as the
// module it is, with the same parser the browser will use and no execution of it.
{
    const { execFileSync } = require('node:child_process');
    let clean = 0;
    const broken = [];
// ------------------------------------------------- the token validator is given a token
//
// `getSessionTokenFrom` takes the token *string* and answers "is this shaped like a JWT". It was
// being called with the sign-in response object instead, and a non-string is not a JWT, so
// `completeSignIn` threw "Sign-in did not return a session" on every successful sign-in -- the
// validator was added to stop a non-token being stored, and it refused every real token.
//
// This is not a distinction a reader can be expected to make from the call site: `data` is the
// response there and a raw string in the one other caller, and both read as plausible. So the
// names a response is bound to are named here, and passing one to the validator fails the build.
const responseNames = /^(data|body|response|payload|result|session|res)$/;
for (const jsFile of allScripts) {
    const js = read(jsFile);
    const bad = [];
    for (const [, arg] of js.matchAll(/getSessionTokenFrom\(\s*([^)]*?)\s*\)/g)) {
        if (responseNames.test(arg)) {
            bad.push(`getSessionTokenFrom(${arg}) passes the response object; it wants the token string (${arg}.token)`);
        }
    }
    if (bad.length) {
        for (const b of bad) fail(`${jsFile} validates the wrong value -- ${b}`);
    } else {
        pass(`${jsFile}: the token validator is only ever handed a token`);
    }
}

// ------------------------------------------------- one session slot
//
// `passkey-shared.js` and `app.js` each had their own copy of "where the session token
// lives" and they disagreed: the app wrote `sessionStorage.offerNetworkSessionToken`, the
// passkey code wrote and read `localStorage.rz_token`. Each half worked, which is what made
// it survive -- a passkey sign-in produced a token the rest of the site could not see, so the
// visitor landed on the offers page signed out, and a password sign-in left `authHeaders()`
// returning nothing, so the Passkeys card on the account page never appeared and adding or
// removing a passkey was a 401. `smoke-passkeys.js` passed throughout, because it drives the
// API directly and never goes through the browser's storage.
//
// Two copies of a string that must match is the shape of bug this check exists for. It fails
// the build the moment either side is edited without the other.
const appTokenKey = read('app.js').match(/const\s+accountTokenKey\s*=\s*'([^']+)'/);
const passkeyTokenKey = read('passkey-shared.js').match(/const\s+SESSION_TOKEN_KEY\s*=\s*'([^']+)'/);
if (!appTokenKey) {
    fail('app.js no longer declares `accountTokenKey` as a literal, so the session slot it reads cannot be verified');
} else if (!passkeyTokenKey) {
    fail('passkey-shared.js no longer declares `SESSION_TOKEN_KEY` as a literal, so the session slot it reads cannot be verified');
} else if (appTokenKey[1] !== passkeyTokenKey[1]) {
    fail(`the passkey code reads "${passkeyTokenKey[1]}" but the app reads "${appTokenKey[1]}"; one session, one key`);
} else {
    pass(`the passkey code and app.js share one session slot: "${appTokenKey[1]}"`);
}

// The old slot has to stay gone. `localStorage` outlives the tab, so a token left there is a
// live session on disk after the visitor closed the browser.
for (const jsFile of allScripts) {
    const js = read(jsFile);
    if (/localStorage\.setItem\(\s*(?:'|")rz_token/.test(js)) {
        fail(`${jsFile} writes a session token to localStorage, which outlives the tab the session belongs to`);
    }
}
pass('no script writes a session token into localStorage');

for (const jsFile of allScripts) {
        try {
            execFileSync(process.execPath, ['--check', path.join('public', jsFile)], { stdio: 'pipe' });
            clean += 1;
        } catch (error) {
            const detail = String(error.stderr || error.message)
                .split('\n')
                .filter((l) => l.trim() && !l.includes('CategoryInfo') && !l.includes('FullyQualified'))
                .slice(0, 3)
                .join(' | ');
            broken.push(`${jsFile}: ${detail}`);
        }
    }
    if (broken.length) {
        for (const b of broken) fail(`JavaScript does not parse -- ${b}`);
    } else {
        pass(`every script parses (${clean} files)`);
    }
}

// ---------------------------------------------------------------- CSS braces
// Comments and escapes have to be handled, not just strings. An apostrophe inside a
// CSS comment ("the UA's default") used to open a phantom string, which swallowed every
// brace up to the next apostrophe and made a balanced stylesheet report depth -1.
let depth = 0;
let line = 1;
let inString = null;
let inComment = false;
for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    const next = css[i + 1];
    if (char === '\n') line += 1;
    if (inComment) {
        if (char === '*' && next === '/') { inComment = false; i += 1; }
        continue;
    }
    if (inString) {
        if (char === '\\') { i += 1; continue; }
        if (char === inString) inString = null;
        continue;
    }
    if (char === '/' && next === '*') { inComment = true; i += 1; continue; }
    if (char === '"' || char === "'") { inString = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) { fail(`CSS has an extra closing brace near line ${line}`); depth = 0; }
}
if (depth !== 0) fail(`CSS braces are unbalanced (depth ${depth} at end of file)`);
else pass('CSS braces are balanced');

// ------------------------------------------------------- custom properties
//
// A `var()` that names a property which is never defined, and carries no fallback, does not
// fall back to anything: the declaration becomes invalid at computed-value time and the
// property is treated as unset. Nothing warns, the stylesheet still parses, and the rule
// quietly does nothing -- which is the same shape as the cascade bug this project has hit
// before, just one level down.
//
// The fallback is what makes this safe, and there are two legitimate users of it: the stagger
// delay and the toast duration are both supplied per-element from JS through CSSOM
// (`element.style.setProperty`), so a static stylesheet cannot define them. A `var()` with a
// fallback is therefore fine and is not reported.
const definedProperties = new Set([...css.matchAll(/(--[a-z0-9_-]+)\s*:/gi)].map((m) => m[1]));
const bareCustomProperties = [...css.matchAll(/var\(\s*(--[a-z0-9_-]+)\s*([,)])/gi)]
    .filter((m) => m[2] === ')')
    .filter((m) => !definedProperties.has(m[1]));
const uniqueBare = [...new Set(bareCustomProperties.map((m) => m[1]))];
if (uniqueBare.length) {
    fail(`CSS uses custom properties that are never defined and have no fallback: ${uniqueBare.join(', ')}`);
} else {
    pass(`every custom property in style.css is defined or has a fallback (${definedProperties.size} defined)`);
}

// ------------------------------------------------- CSP: no inline styles
//
// `style-src` is `'self' 'unsafe-inline'` -- the `'unsafe-inline'` is there for the `<style>`
// block inside the home page's `<noscript>`, not for markup. So a `style` attribute is not
// actually blocked today. This is enforced anyway, deliberately: if the `'unsafe-inline'` is
// ever dropped in favour of that block being rewritten, this rule is already true and nothing
// has to change. CSSOM writes are permitted either way and are checked separately.
for (const htmlFile of pages) {
    const offenders = [...read(htmlFile).matchAll(/<[^>]+\sstyle="[^"]*"/g)].map((m) => m[0]);
    if (offenders.length) fail(`${htmlFile} has ${offenders.length} inline style attribute(s): ${offenders[0]}`);
}
pass('no HTML file uses a style attribute (kept true so style-src can drop unsafe-inline)');

// ------------------------------------------------- script <-> markup ids
//
// Duplicate ids are a per-page property, so every page is checked for them.
//
// For the id cross-reference the rule depends on how many pages load a script, and it is
// derived from the pages rather than hand-listed, because `app.js` stopped being one page's
// script when the account page arrived: it runs on the offers page and both account pages,
// and it reaches the catalog through optional lookups precisely because the account pages
// have no catalog. Asserting all of its ids against any single page reports that deliberate
// guard as a defect.
//
//   - loaded by one page  -> every id it wants must be on that page
//   - loaded by several   -> every id it wants must exist on at least one of them
//
// Both still catch the bug this exists for, a typo'd or renamed id that exists nowhere. The
// second form additionally catches the inverse: an id that used to be on one page and now
// lives on another. What it cannot catch is an id that is genuinely optional -- but that case
// is not silent, it is an element that is never touched on the page that lacks it, and the
// dead-control check further down reports the ones that are supposed to be interactive.
/**
 * Ids a script looks up defensively and treats as optional.
 *
 * When a script guards its lookup (`if (element) ...`), it is stating that the element is not
 * required on every page that loads it. Asserting otherwise reports a deliberate guard as a
 * defect, which teaches everyone to ignore this check. Each entry records why, so the
 * exception stays a decision instead of a hole that widens.
 */
const OPTIONAL_IDS = new Map([
    // history.js looks for a signed-out helper that bounces the visitor to the offers page to
    // sign in. Neither the account page nor the history page renders one today, and the
    // lookup is guarded, so its absence is correct rather than a missing element.
    ['open-offers-signin', 'guarded by `if (openOffers)` in history.js; only a signed-out helper uses it']
]);

const scriptToPages = new Map();
for (const htmlFile of pages) {
    for (const [, src] of read(htmlFile).matchAll(/<script[^>]*src="\/([^"?#]+\.js)"/g)) {
        if (!scriptToPages.has(src)) scriptToPages.set(src, []);
        scriptToPages.get(src).push(htmlFile);
    }
}

// The same relation the other way round: which scripts a given page loads. The id check below
// needs this rather than `scriptToPages` because it asks "what else is on this page", not
// "who else loads this file".
const pageToScripts = new Map();
for (const htmlFile of pages) {
    const list = pageToScripts.get(htmlFile) ?? [];
    for (const [, src] of read(htmlFile).matchAll(/<script[^>]*src="\/([^"?#]+\.js)"/g)) list.push(src);
    pageToScripts.set(htmlFile, list);
}

for (const [jsFile, hostingPages] of scriptToPages) {
    const js = read(jsFile);
    const wanted = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
    const available = new Set();
    for (const htmlFile of hostingPages) {
        for (const [, id] of read(htmlFile).matchAll(/\bid="([^"]+)"/g)) available.add(id);
    }

    // Ids the site's own scripts build themselves, whether in a template literal they later
    // insert or assigned as a property.
    //
    // `helpdesk.js` constructs its whole dialog in JS and appends it to `document.body`, and
    // `clock.js` injects the topbar clock and the live-transaction indicator, so none of
    // their ids appear in any page's markup. Without this the check reports `#helpdesk-count`
    // as an id the script asks for that does not exist -- which is exactly backwards, since
    // the check exists to catch a lookup that will fail at runtime and this one cannot. The
    // alternative was an OPTIONAL_IDS exception, but that entry would be asserting "this id
    // is deliberately absent", which is the opposite of the truth, and it would have taught
    // the next person that a missing element is fine.
    //
    // Scanned across every script the hosting pages load, not just the one being checked.
    // `app.js` looks up `#live-indicator`, which `clock.js` builds -- and it did fail this
    // check when only `app.js`'s own source was scanned, which is the failure mode this
    // whole mechanism exists to prevent, arriving from a different direction. What matters
    // at runtime is that some script on the page puts the element there before it is read,
    // and the order is enforced in the markup: `clock.js` is the first deferred script on
    // every page, so its `DOMContentLoaded` handler is registered before `app.js`'s and runs
    // before it.
    //
    // The id being present in a script's source is still not a guarantee that it is rendered
    // -- a lookup stays guarded either way, because a script can be loaded on a page with no
    // topbar. It just stops the check from reporting an element that genuinely is there.
    //
    // The alternative was an OPTIONAL_IDS exception, but that entry would be asserting "this
    // id is deliberately absent", which is the opposite of the truth, and it would have
    // taught the next person that a missing element is fine.
    //
    // Scanning the scripts' own markup keeps the check strict everywhere else: an id that is
    // a genuine typo appears in neither the page nor any script and is still reported.
    const coLoaded = new Set([jsFile]);
    for (const page of hostingPages) for (const s of pageToScripts.get(page) ?? []) coLoaded.add(s);
    for (const source of [...coLoaded].map(read)) {
        for (const [, id] of source.matchAll(/\bid="([^"]+)"/g)) available.add(id);
        for (const [, id] of source.matchAll(/\.id\s*=\s*'([^']+)'/g)) available.add(id);
    }

    const absent = [...wanted].filter((id) => !available.has(id) && !OPTIONAL_IDS.has(id));
    const optionalMissing = [...wanted].filter((id) => !available.has(id) && OPTIONAL_IDS.has(id));
    const where = hostingPages.length === 1
        ? hostingPages[0]
        : `any of ${hostingPages.join(', ')}`;
    if (absent.length) fail(`${jsFile} asks for ids missing from ${where}: ${absent.join(', ')}`);
    else pass(`${jsFile}: all ${wanted.size} element ids exist on ${where}`);

    // Reported rather than failed, so a guarded lookup cannot be "fixed" by deleting the
    // guard -- which is what happens when a check demands an element nobody intended to add.
    for (const id of optionalMissing) {
        console.log(`  NOTE ${jsFile} optionally uses #${id}, which no current page renders (${OPTIONAL_IDS.get(id)})`);
    }

    // querySelector results are dereferenced too, so a missing target throws at runtime.
    for (const match of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)\.querySelector/g)) {
        if (!available.has(match[1])) fail(`${jsFile} dereferences a querySelector on missing id ${match[1]}`);
    }
}

for (const htmlFile of pages) {
    const allIds = [...read(htmlFile).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
    if (duplicates.length) fail(`${htmlFile} has duplicate ids: ${[...new Set(duplicates)].join(', ')}`);
    else pass(`${htmlFile} has no duplicate ids`);
}

// ------------------------------------------------- session tokens are never interpolated
//
// The server logged `Rejected a bearer token (JsonWebTokenError: jwt malformed)` eleven times
// for a signed-in page load and kept going, because a live-sync poll runs every few seconds.
// The cause was on the client: `sessionStorage.setItem(key, undefined)` does not fail, it
// stores the string "undefined", so a sign-in response that was not the expected shape put a
// non-token in the session slot, and every later request sent `Bearer undefined`.
//
// The fix is `getSessionToken()` and `authHeaders()`. This check is what stops the shape of the
// bug coming back, because the dangerous construct is not the missing validation -- it is
// interpolating anything that can be null into a header string, which is the one line a
// future edit needs to write to reintroduce the whole thing.
for (const jsFile of allScripts) {
    const js = read(jsFile);
    const bad = [];

    // A storage read interpolated straight into a header. This is the construct that caused
    // the bug, and it is the only one that can reintroduce it: a local `const token =
    // getSessionToken()` followed by `if (!token) return` and then `Bearer ${token}` is correct
    // code, and flagging it would just teach people to ignore the check.
    for (const [, expr] of js.matchAll(/Bearer\s*\$\{([^}]*)\}/g)) {
        const inner = expr.trim();
        if (/(local|session)Storage\.\s*(get|session)Item/.test(inner)) {
            bad.push(`Bearer \${${inner}} -- interpolate a validated token, not a storage read`);
        }
        if (/\bundefined\b|\bnull\b/.test(inner)) {
            bad.push(`Bearer \${${inner}} -- this can be null, which sends "Bearer null"`);
        }
    }

    // Writing a possibly-absent field straight into the session slot. `setItem` does not
    // complain about `undefined`; it stores the string, and the page then believes it is
    // signed in while sending a value the server rejects on every request.
    //
    // The `validated` test names the exact call rather than something looser like "mentions
    // getSessionTokenFrom". It used to look for `getSessionTokenFrom(data)` -- which is the
    // call that was actually wrong, passing the response object where a token string belongs,
    // so the check was satisfied by the bug it should have been catching. The check above now
    // forbids that spelling outright, which is what makes being this specific safe.
    const writers = [...js.matchAll(/setItem\(\s*(accountTokenKey|demoTokenKey|'offerNetworkSessionToken')\s*,\s*([^)]*)\)/g)];
    for (const [, key, value] of writers) {
        const writesAField = /^(data|response|payload|body)\b/.test(value.trim());
        const validated = /getSessionTokenFrom\(\s*data\.token\s*\)|demoSessionToken\(\)/.test(js);
        if (writesAField && !validated) {
            bad.push(`setItem(${key}, ${value.trim()}) stores an unvalidated value`);
        }
    }

    if (bad.length) {
        for (const b of bad) fail(`${jsFile} can send a non-token as a bearer value -- ${b}`);
    } else {
        pass(`${jsFile}: every bearer value comes from a validated token`);
    }
}

// ------------------------------------------------- closed dialogs stay closed
//
// A `<dialog>` is hidden by the user agent with `dialog:not([open]) { display: none }`, and
// that is an author-overridable rule. Writing `display: flex` on the element -- which is what
// the contact form and the help desk both needed, and both did -- makes the dialog lay out
// permanently: closed, un-backdropped, on top of the page, with every field and the send
// button visible to every visitor.
//
// Every check in this file passed while that shipped. Ids resolved, labels were present,
// contrast was fine, and `dialog.open` correctly reported false. Nothing static can see it,
// because the dialog is genuinely not open -- it is a closed dialog that is being displayed.
//
// So this is structural: any rule that sets a `display` on one of the dialog's own classes has
// to set it through `[open]`. It cannot be a check that a browser runs, because the static pass
// is where the mistake gets made, and the cost of catching it here is reading the selectors.
//
// The classes to look for are the ones actually carried by a `<dialog>` element, collected from
// the markup and from `helpdesk.js`, which builds its own. Matching on the word "dialog" in the
// selector instead pulled in `.dialog-heading` and `.dialog-panel` -- children *inside* the
// dialog, whose display is irrelevant to whether a closed dialog shows, and which need `display:
// flex` precisely because the dialog is a column. That reported a failure on correct code and
// would have been the reason to un-flex the heading to make the check pass, which is the wrong
// trade in the direction that matters.
{
    const dialogClasses = new Set();
    for (const htmlFile of pages) {
        for (const m of read(htmlFile).matchAll(/<dialog\b[^>]*\bclass="([^"]+)"/g)) {
            for (const cls of m[1].split(/\s+/)) if (cls) dialogClasses.add(cls);
        }
    }
    // `helpdesk.js` creates its dialog rather than shipping it in a page, so its classes are not
    // in any markup above. Reading the assignment keeps the list honest when the dialog is
    // restyled or a second script-built dialog appears.
    const helpdesk = read('helpdesk.js');
    const helpdeskEl = helpdesk.match(/createElement\('dialog'\)[\s\S]{0,200}?className\s*=\s*'([^']+)'/);
    if (helpdeskEl) {
        for (const cls of helpdeskEl[1].split(/\s+/)) if (cls) dialogClasses.add(cls);
    }

    if (!dialogClasses.has('dialog')) {
        fail('no <dialog class="dialog"> found in the markup, so the closed-dialog check cannot run');
    }

    const escaped = [...dialogClasses].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const dialogSelector = new RegExp(`^\\s*((?:${escaped.join('|')})(?:[.:[\\s,][^{]*)?)\\s*\\{(.*)$`);

    const offenders = [];
    for (const [index, line] of css.split('\n').entries()) {
        const match = line.match(dialogSelector);
        if (!match) continue;
        const [, sel, body] = match;
        // `.dialog::backdrop` and friends have no `display` in the body; only a real
        // declaration on the dialog element itself is a problem.
        if (!/\bdisplay\s*:/.test(body)) continue;
        if (sel.includes('[open]')) continue;
        offenders.push(`style.css:${index + 1} (${sel.trim()})`);
    }
    if (offenders.length) {
        for (const o of offenders) fail(`${o} sets display on a dialog without [open], so a closed dialog stays visible`);
    } else {
        pass(`every display rule on a dialog element is scoped to [open] (${dialogClasses.size} classes)`);
    }
}

// ------------------------------------------------- contact triggers resolve
//
// A contact trigger exists only to open `#contact-dialog`, and the handler calls
// `preventDefault()` before it goes looking for that dialog. A page carrying the trigger
// without the dialog therefore has a link that navigates nowhere and opens nothing: the
// click is swallowed and the user is left with no feedback at all. `privacy.html` shipped
// exactly that way -- contact.js loaded, the footer trigger present, no dialog.
for (const htmlFile of pages) {
    const html = read(htmlFile);
    if (!/\bdata-contact-trigger\b/.test(html)) continue;
    if (!/\bid="contact-dialog"/.test(html)) {
        fail(`${htmlFile} has a contact trigger but no #contact-dialog, so the link does nothing`);
    } else if (!/\bid="contact-form"/.test(html)) {
        fail(`${htmlFile} has #contact-dialog but no #contact-form inside it, so the form cannot submit`);
    }
}
pass('every contact trigger is backed by a contact dialog on the same page');

// ------------------------------------------------- data-mirror targets
const indexHtml = read('index.html');
for (const match of indexHtml.matchAll(/data-mirror="([^"]+)"/g)) {
    if (!new RegExp(`id="${match[1]}"`).test(indexHtml)) {
        fail(`action bar button mirrors a missing control: ${match[1]}`);
    }
}
pass('every action bar button mirrors an existing header control');

// ------------------------------------------------- labels
for (const htmlFile of pages) {
    const html = read(htmlFile);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const dangling = [...html.matchAll(/\bfor="([^"]+)"/g)].map((m) => m[1]).filter((t) => !ids.has(t));
    if (dangling.length) fail(`${htmlFile} has labels pointing at missing ids: ${dangling.join(', ')}`);
    else pass(`${htmlFile}: every <label for> resolves`);

    // aria-labelledby / aria-describedby must also resolve.
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
        const bad = [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))]
            .flatMap((m) => m[1].split(/\s+/))
            .filter((target) => !ids.has(target));
        if (bad.length) fail(`${htmlFile} ${attribute} points at missing ids: ${[...new Set(bad)].join(', ')}`);
    }
}

// ------------------------------------------------- dialog structure
//
// Every direct child of a `<dialog>` must be the panel. The panel owns the padding, the
// background, and the scroll container, so anything outside it renders flush against the
// dialog edge with none of that.
//
// This is not hypothetical: `#withdraw-confirmation` sat outside `.dialog-panel` in the
// withdrawal dialog, because that dialog made the panel *be* the form and then needed a
// sibling for the confirmation screen. The receipt therefore looked like it belonged to a
// different app, while the equivalent deposit screen looked correct -- which is the hardest
// kind of layout bug to report, because "it looks wrong" gives nothing to search for.
for (const htmlFile of pages) {
    const html = read(htmlFile);
    const stray = [];
    for (const match of html.matchAll(/<dialog\b[^>]*>([\s\S]*?)<\/dialog>/g)) {
        const openingTag = match[0].slice(0, match[0].indexOf('>') + 1);
        const dialogId = (/\bid="([^"]+)"/.exec(openingTag) || [, 'dialog'])[1];
        const body = match[1];

        // The body's top level: elements not nested inside another element.
        //
        // Void elements are the trap here. `<input>` and `<br>` are written without a
        // trailing slash and have no closing tag, so counting them as opening tags leaves
        // the depth permanently above zero -- which makes every later sibling look nested,
        // and the check silently passes a broken dialog instead of reporting it.
        const voidElements = new Set([
            'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
            'link', 'meta', 'param', 'source', 'track', 'wbr'
        ]);

        let depth = 0;
        const topLevel = [];
        for (const tag of body.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*?)(\/?)>/gi)) {
            const [, closing, name, attributes, selfClosing] = tag;
            if (selfClosing || voidElements.has(name.toLowerCase())) continue;
            if (closing) {
                depth -= 1;
                continue;
            }
            if (depth === 0) topLevel.push({ name, attributes });
            depth += 1;
        }

        if (topLevel.length === 0) {
            stray.push(`${dialogId}: empty`);
        } else if (topLevel.length > 1) {
            // More than one top-level element means something is sitting beside the panel and
            // therefore outside its padding, background, and scroll container.
            stray.push(`${dialogId}: ${topLevel.length} top-level children (${topLevel.map((t) => `<${t.name}>`).join(' ')})`);
        } else if (!/\bclass="[^"]*\bdialog-panel\b/.test(topLevel[0].attributes)) {
            // Exactly one child, but it is not the panel, so it gets none of the panel's
            // styling. The tag name is reported because it usually is the form.
            stray.push(`${dialogId}: top-level <${topLevel[0].name}> is not a .dialog-panel`);
        }
    }
    if (stray.length) {
        fail(`${htmlFile} has dialog content outside the panel (no .dialog-panel padding): ${stray.join(', ')}`);
    } else {
        pass(`${htmlFile}: every dialog wraps its content in a panel`);
    }
}

// ------------------------------------------------- classes have rules
const cssClasses = new Set([...css.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]));

const builtClasses = new Set();
for (const jsFile of allScripts) {
    const js = read(jsFile);
    for (const match of js.matchAll(/className\s*=\s*'([^']+)'/g)) {
        match[1].split(/\s+/).filter(Boolean).forEach((n) => builtClasses.add(n));
    }
    for (const match of js.matchAll(/classList\.(?:add|toggle)\(\s*'([^']+)'/g)) builtClasses.add(match[1]);
}

// A literal that ends in `-` is a prefix that the rest of the class is concatenated onto at
// runtime -- `'history-item is-' + type`. The full class names cannot be read from the
// source, so instead of skipping the token (which would let a typo through untouched) the
// prefix is validated: the stylesheet must define at least one class that starts with it.
//
// This is stricter than the previous rule, which allowed any `status-` prefix unconditionally
// and so could not have caught a prefix that matched nothing at all.
const isDynamicPrefix = (name) => name.endsWith('-');
const cssClassList = [...cssClasses];

const unstyled = [...builtClasses].filter((n) => {
    if (n.startsWith('status-')) return false;
    if (cssClasses.has(n)) return false;
    if (!isDynamicPrefix(n)) return true;
    return !cssClassList.some((styled) => styled.startsWith(n));
});
if (unstyled.length) fail(`scripts build classes with no CSS rule: ${unstyled.join(', ')}`);
else pass(`all ${builtClasses.size} script-built classes have CSS rules (dynamic prefixes validated)`);

// `is-${variant}` is built dynamically, so the members cannot be read from the source.
// They are the only two variants the helper is called with.
for (const variant of ['error', 'success']) {
    if (!new RegExp(`\\.is-${variant}\\b`).test(css)) fail(`dynamic class is-${variant} has no CSS rule`);
}
if (!/classList\.\w+\(`is-\$\{/.test(read('app.js'))) fail('app.js no longer builds a dynamic is-* class');
pass('dynamically built is-error / is-success classes are styled');

for (const htmlFile of pages) {
    const used = new Set();
    for (const match of read(htmlFile).matchAll(/\bclass="([^"]+)"/g)) {
        match[1].split(/\s+/).filter(Boolean).forEach((n) => used.add(n));
    }
    const unstyledInHtml = [...used].filter((n) => !cssClasses.has(n));
    if (unstyledInHtml.length) fail(`${htmlFile} uses classes with no CSS rule: ${unstyledInHtml.join(', ')}`);
    else pass(`${htmlFile}: all ${used.size} markup classes have CSS rules`);
}

// ------------------------------------------------- web manifest
//
// The browser resolves every icon and every shortcut URL before anything on the page reports a
// problem, so a wrong path here is a 404 nobody ever sees. It happened: the manifest pointed
// `maskable` at an `/icon-maskable-512.png` that no script writes, listed two `/screenshots/*.png`
// that were never added, and sent the "My rewards" shortcut to `/rewards`, which is not a route.
// A shortcut to a page that does not exist is the worst of the three, because it is a
// deliberately installed app entry point that dead-ends.
const manifestPath = path.join(publicDir, 'site.webmanifest');
let manifest = null;
try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
    fail(`site.webmanifest is not valid JSON: ${error.message}`);
}
if (manifest) {
    const referenced = [
        ...(manifest.icons || []).map((icon) => icon.src),
        ...(manifest.shortcuts || []).flatMap((shortcut) => (shortcut.icons || []).map((icon) => icon.src))
    ].filter(Boolean);

    const missing = [...new Set(referenced)].filter((src) =>
        !src.startsWith('http') && !fs.existsSync(path.join(publicDir, src.replace(/^\//, '')))
    );
    if (missing.length) fail(`site.webmanifest references assets that do not exist: ${missing.join(', ')}`);
    else pass(`every icon the manifest declares exists (${new Set(referenced).size} checked)`);

    // Shortcut targets are checked against the routes the server actually registers. The app
    // source is read as text because the routes live in an Express router, and the assertion
    // is only that the path is named there as a route -- not that it is reachable.
    //
    // The match is on the *quoted* form deliberately. A looser substring test would pass on
    // `/account` matching `/account-settings`, which is exactly the kind of check that reports
    // success while verifying nothing.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    for (const shortcut of manifest.shortcuts || []) {
        const route = String(shortcut.url || '').split(/[?#]/)[0];
        if (!route || route === '/') continue;
        if (!appSource.includes(`'${route}'`) && !appSource.includes(`"${route}"`)) {
            fail(`the manifest shortcut "${shortcut.name}" points at ${route}, which is not a registered route`);
        }
    }
    pass('every manifest shortcut points at a registered route');
}

// ------------------------------------------------- controls that can never fire
//
// A control that no script references and that is disabled in the markup can never be clicked.
// There is no console error and no failed request: the click simply never happens, so the page
// looks finished and every button on it is decorative.
//
// This is not hypothetical. The account page shipped its primary calls to action -- Deposit
// and Withdraw -- as `<button ... id="account-deposit-btn" disabled>`, while the script wired
// only `deposit-button` and `withdraw-button`, which are the header and action-bar controls on
// the offers page. The account page was a dead shell: two permanently greyed-out buttons, a
// balance stuck at `--`, and a Connect button that went nowhere. Nothing failed, so every check
// passed.
//
// Two conditions are reported, because they fail differently:
//   - disabled in markup and never referenced: nothing can ever enable it, so it is dead.
//   - `type="button"` and never referenced: it is not a submit, so nothing handles it either.
const everyPublicScript = fs.readdirSync(publicDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(publicDir, file), 'utf8'))
    .join('\n');

function referencedAnywhere(id) {
    return everyPublicScript.includes(`'${id}'`) || everyPublicScript.includes(`"${id}"`);
}

/**
 * A control wired through a data attribute is wired, even though its id is never mentioned.
 *
 * The bottom action bar is the case that matters: those buttons carry `data-mirror` and are
 * wired by a single delegated listener that forwards the click to the control they mirror.
 * Judged by id alone they look dead -- and the two that ship `disabled` look permanently dead
 * -- which is exactly the false positive that would make this check worthless if it fired on
 * the site's main mobile navigation.
 */
function wiredByAttribute(tag) {
    // The attribute may be valueless (`data-contact-trigger`) or carry one
    // (`data-mirror="account-button"`), and both count.
    for (const [, name] of tag.matchAll(/\b(data-[a-z0-9-]+)(?==|\s|\/?>)/g)) {
        if (everyPublicScript.includes(name)) return true;
    }
    return false;
}

const deadControls = [];
for (const htmlFile of pages) {
    const html = read(htmlFile);
    for (const [tag] of html.matchAll(/<button\b[^>]*>/g)) {
        const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
        if (!id) continue;              // no id, so nothing to cross-check against
        if (referencedAnywhere(id) || wiredByAttribute(tag)) continue;

        const disabled = /\bdisabled\b/.test(tag);
        const type = (tag.match(/\btype="([^"]+)"/) || [])[1] || 'submit';
        if (disabled) {
            deadControls.push(`${htmlFile}: #${id} is disabled in the markup and no script enables or listens to it`);
        } else if (type !== 'submit') {
            deadControls.push(`${htmlFile}: #${id} is type="${type}" and no script listens to it`);
        }
    }
}
if (deadControls.length) {
    for (const problem of deadControls) fail(problem);
} else {
    pass(`every button in the markup is reachable from a script (${pages.length} pages)`);
}

// ------------------------------------------------- deposit form completeness
// A deposit form is a form plus the controls that choose what it submits. The controls are
// written once, here, because the failure is that a page can carry the form and quietly omit
// the rest -- and every reference to them is optional, so nothing else here would notice.
//
// `account.html` shipped `#deposit-form` with the amount block and the submit button and no
// method selector at all. `depositState.method` defaults to `crypto` and every lookup of the
// missing pieces is guarded by `if (element)`, so the dialog opened, reported both payment
// providers as available in its notice, and could only ever do one of them. The coin list
// was populated into a `#deposit-currency` that was not on the page, so `getElementById`
// returned null and there was no way to choose a coin. The catalog page, which has the same
// form, was fine -- which is why it read as a working feature everywhere except the one
// screen a user reaches it from.
const DEPOSIT_PARTS = [
    ['a method selector', /data-deposit-method="stripe"/, /data-deposit-method="crypto"/],
    ['the crypto currency select', /id="deposit-currency"/],
    ['the crypto field group', /id="crypto-deposit-fields"/]
];

for (const htmlFile of pages) {
    const html = read(htmlFile);
    if (!/id="deposit-form"/.test(html)) continue;
    const missing = [];
    for (const [label, ...patterns] of DEPOSIT_PARTS) {
        if (!patterns.every((pattern) => pattern.test(html))) missing.push(label);
    }
    if (missing.length) {
        fail(`${htmlFile}: has a deposit form but is missing ${missing.join(' and ')}`);
    }
}
pass('every page with a deposit form also carries its method and currency controls');

// ------------------------------------------------- has-action-bar scope
// The fixed action bar only exists on the offers page, so only that page may pad
// the document to clear it.
for (const htmlFile of pages) {
    const hasClass = /<body[^>]*class="[^"]*has-action-bar/.test(read(htmlFile));
    const hasBar = /class="action-bar"/.test(read(htmlFile));
    if (hasClass !== hasBar) {
        fail(`${htmlFile}: has-action-bar on body is ${hasClass} but the action bar is ${hasBar}`);
    }
}
pass('the has-action-bar body class matches the pages that render the bar');

console.log(problems === 0 ? '\nFRONTEND CHECKS PASSED' : `\n${problems} FRONTEND PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
