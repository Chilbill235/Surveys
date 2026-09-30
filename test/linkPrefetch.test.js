const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Link prefetching.
 *
 * This is a performance hint with no visible effect and three ways to be wrong, all of which are
 * invisible until somebody is on a metered connection:
 *
 *   - prefetching a link the reader merely swept the cursor across, which spends their data on a
 *     page they never open
 *   - prefetching the page they are already on, which is a second download of the current document
 *     for a click the browser handles with no load at all
 *   - prefetching when the reader asked for reduced data usage
 *
 * So the guards are tested by calling the function with a fake DOM rather than by matching its
 * source. A regex would pass on a function whose conditions are inverted.
 */

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * Lift `prefetchLinkedPages` and run it against a stub document.
 *
 * The real `document` is only used for `createElement`, `head.appendChild` and the two event
 * listeners, so all of that is stubbed. `navigator.connection` is the fourth behaviour worth
 * testing, so that is a parameter.
 */
function run({ connection = null, href = 'https://site.test/offers' } = {}) {
    const appended = [];
    const listeners = {};

    const document = {
        head: { appendChild: (el) => appended.push(el) },
        createElement: () => ({ set rel(v) { this._rel = v; }, get rel() { return this._rel; },
            set as(v) { this._as = v; }, get as() { return this._as; },
            set href(v) { this._href = v; }, get href() { return this._href; },
            set fetchPriority(v) { this._priority = v; }, get fetchPriority() { return this._priority; } }),
        addEventListener: (type, fn) => { listeners[type] = fn; }
    };

    const anchor = (targetHref) => ({ getAttribute: (name) => (name === 'href' ? targetHref : null) });
    // The handler takes an event and walks up from its target, so the stub target needs the
    // `closest` and `instanceof Element` contract the real function relies on.
    const Element = class {};

    // A real `Location` would be simplest, but a plain object that reports the same fields is
    // enough and does not depend on the URL implementation -- and it is the *absence* of these
    // fields, not their value, that this stub exists to catch.
    const parsed = new URL(href);
    const location = { href, origin: parsed.origin, pathname: parsed.pathname, search: parsed.search };
    const window = { location };
    const navigator = { connection };

    const body = /^function prefetchLinkedPages\(\) \{[\s\S]*?\n\}/m.exec(source);
    assert.ok(body, 'prefetchLinkedPages is gone from app.js');

    // eslint-disable-next-line no-new-func -- running the function under test, on purpose
    new Function('document', 'window', 'navigator', 'Element', `${body[0]}\nprefetchLinkedPages();`)(document, window, navigator, Element);

    return {
        appended,
        listeners,
        fire(type, targetHref) {
            listeners[type]({ target: Object.assign(new Element(), { closest: () => anchor(targetHref) }) });
        }
    };
}

test('hovering a link prefetches the page it points at', async () => {
    const { appended, fire } = run();
    await fire('pointerover', '/account');

    assert.equal(appended.length, 1, 'nothing was prefetched');
    assert.equal(appended[0].rel, 'prefetch');
    assert.equal(appended[0].as, 'document');
    assert.match(appended[0].href, /\/account$/);
});

test('tabbing to a link prefetches it too', () => {
    // Keyboard navigation gets no `pointerover` at all, so without `focusin` a reader using the
    // keyboard gets none of the benefit -- and they are the reader for whom a slow navigation
    // costs the most, because every extra page load delays the next thing they can reach.
    const { appended, fire } = run();
    fire('focusin', '/account');
    assert.equal(appended.length, 1);
    assert.match(appended[0].href, /\/account$/);
});

test('a link is fetched once, however many times the pointer crosses it', async () => {
    // `pointerover` fires every time the cursor enters the element, and moving across a row of
    // links fires it repeatedly as the cursor moves between them. Without the guard this injects
    // dozens of duplicate <link> elements for one page.
    const { appended, fire } = run();
    await fire('pointerover', '/account');
    await fire('pointerover', '/account');
    await fire('focusin', '/account');
    await fire('pointerover', '/account');

    assert.equal(appended.length, 1, `${appended.length} hints were injected for one link`);
});

test('the page already open is never fetched', async () => {
    const { appended, fire } = run({ location: { href: 'https://site.test/offers' } });

    await fire('pointerover', '/offers');
    assert.equal(appended.length, 0, 'the current page was prefetched');

    // A fragment on the current page is the same document -- the browser scrolls, it does not load.
    await fire('pointerover', '/offers#history-withdrawal-88');
    assert.equal(appended.length, 0, 'a same-page fragment was treated as a navigation');

    // A different query string *is* a different document, so it has to be allowed through.
    await fire('pointerover', '/offers?filter=surveys');
    assert.equal(appended.length, 1, 'a different query string was wrongly skipped');
});

test('a link that is not a page is not prefetched', () => {
    const { appended, fire } = run();

    fire('pointerover', 'mailto:support@site.test');
    fire('pointerover', 'tel:+15550100');
    fire('pointerover', '/invoices/2026-09.csv');
    fire('pointerover', 'https://elsewhere.test/offers');
    fire('pointerover', '#top');
    fire('pointerover', '');

    assert.equal(appended.length, 0, `prefetched ${appended.map((l) => l.href).join(', ')}`);
});

test('reduced data usage and slow connections disable prefetching', () => {
    // The reader has already told us their budget. Speeding up their next page by spending data
    // they asked us not to spend is not a trade they made.
    const saved = run({ connection: { saveData: true } });
    // Nothing is even bound: the listeners are never attached, so there is nothing to fire.
    assert.deepEqual(Object.keys(saved.listeners), [], 'listeners were bound despite saveData');

    const slow = run({ connection: { effectiveType: '2g' } });
    assert.deepEqual(Object.keys(slow.listeners), [], 'listeners were bound on a 2g connection');

    const fast = run({ connection: { effectiveType: '4g' } });
    fast.fire('pointerover', '/account');
    assert.equal(fast.appended.length, 1, 'a fast connection was wrongly blocked');
});

test('the prefetch never outranks the page being read', async () => {
    const { appended, fire } = run();
    await fire('pointerover', '/account');
    assert.equal(appended[0].fetchPriority, 'low');
});

test('the hint is added on hover and on focus, not on every pointer move', async () => {
    const { listeners } = run();
    // `pointerenter` at the document level would fire for every link the cursor sweeps past on its
    // way to somewhere else, which is the opposite of intent.
    assert.ok(listeners.pointerover, 'pointerover is not bound');
    assert.ok(listeners.focusin, 'focusin is not bound');
    assert.equal(listeners.pointerenter, undefined, 'pointerenter would prefetch on the way past');
    assert.equal(listeners.pointermove, undefined, 'pointermove would prefetch on any movement');
    assert.equal(listeners.mouseover, undefined);
});

test('it runs on the public pages, not only the ones behind the session gate', async () => {
    // `/terms` and `/privacy` have a full footer and header, and they load `app.js`. A visitor
    // reading the terms and following a link is the navigation this is for; gating it to signed-in
    // pages would have left it off on the pages where a reader is most likely to be about to leave.
    const block = /if \(mayUseThisPage\) document\.addEventListener\('DOMContentLoaded', prefetchLinkedPages\)/;
    assert.doesNotMatch(source, block, 'prefetching is gated behind the session check');

    const call = /document\.addEventListener\('DOMContentLoaded', prefetchLinkedPages\);/.exec(source);
    assert.ok(call, 'prefetchLinkedPages is never called');
    assert.ok(call.index < source.indexOf('if (mayUseThisPage) document.addEventListener'), 'not reached before the gate');
});