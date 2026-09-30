const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The account menu carries its own Offers link.
 *
 * This exists because the navigation was removed from the phone header to make room for the
 * clock, and the link it used to hold is the second route to the page the reader is on. Two
 * other routes survive -- the wordmark points at `/`, which *is* the offers page, and the
 * footer keeps both -- so nothing is strictly stranded. But "the logo goes there" is not a
 * discoverable substitute for a link with the destination written on it, and the account menu
 * is the one control on a phone that is always visible.
 *
 * The keyboard half is not asserted as markup. `initAccountMenu()` gathers its items with
 * `panel.querySelectorAll('.account-menu-item')` for both the Escape-to-close and the
 * first/last Tab wrap, so any element with that class is in the ring without being named
 * anywhere. What that means is that the class is load-bearing and the class is asserted --
 * an anchor with `role="menuitem"` but the wrong class would render correctly and be
 * unreachable by keyboard, which is the failure nothing else here would catch. That
 * `querySelectorAll` is itself asserted, because the day it stops being how the ring is built,
 * the class stops being what makes an item reachable and the markup check above would be
 * guarding the wrong thing.
 */

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** The single `<a class="account-menu-item">` whose id is `id`. */
function menuItem(id) {
    const re = new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>`, 'i');
    const match = re.exec(html);
    assert.ok(match, `no account menu link with id ${id}`);
    return match[0];
}

/**
 * The contents of the account menu panel, found by balancing `<div>` and `</div>`.
 *
 * A non-greedy match to the first `</div>` would stop inside the panel's own header block and
 * return the avatar, which is the whole difficulty with reading a panel out of markup by
 * pattern: the items are siblings of a nested subtree, not a flat run of text.
 *
 * Tags are consumed as whole tokens rather than by advancing one character at a time. Scanning
 * character by character and re-testing a five-character window at each position double-counts
 * wherever two tags sit close together, and it never balances -- which is what a panel read
 * this way has to be able to do, since a miscount returns the wrong subtree and every assertion
 * made against it passes against nothing.
 */
function panelContents() {
    const open = /<div\b[^>]*\bid="account-menu-panel"[^>]*>/i.exec(html);
    assert.ok(open, 'no account menu panel in account.html');
    const rest = html.slice(open.index + open[0].length);

    let depth = 1;
    for (const tag of rest.matchAll(/<\/?div\b[^>]*>/g)) {
        depth += tag[0][1] === '/' ? -1 : 1;
        if (depth === 0) return rest.slice(0, tag.index);
    }
    throw new Error('unbalanced <div> after account-menu-panel');
}

test('the account menu has an Offers link that goes to the offers page', () => {
    const tag = menuItem('account-menu-offers');
    assert.match(tag, /\bclass="[^"]*\baccount-menu-item\b/, 'the link is outside the keyboard ring');
    assert.match(tag, /\bhref="\/offers"/, 'the Offers link does not go to /offers');
    assert.match(tag, /\brole="menuitem"/, 'the link is missing its menu role');
});

test('every item in the account menu is reachable by keyboard', () => {
    // The menu is driven entirely by the class, so a menu that grows an item without it -- or
    // an item that is reachable visually but not in the Tab ring -- is a real defect. Counting
    // the links and buttons with the class and asserting they are all inside the panel is
    // weaker than asserting each has a role, but it is the part that fails when the class is
    // dropped from one of them.
    const inner = panelContents();

    const items = inner.match(/\bclass="[^"]*\baccount-menu-item\b[^"]*"/g) || [];
    assert.ok(items.length >= 6, `expected the Offers link plus the existing items, found ${items.length}`);

    // Every one of them declares a menu role, so assistive technology announces the menu as a
    // list of commands rather than as a pile of links.
    const withRole = inner.match(/\bclass="[^"]*\baccount-menu-item\b[^"]*"[^>]*\brole="menuitem"/g) || [];
    assert.equal(
        withRole.length,
        items.length,
        'an account menu item is missing role="menuitem"'
    );
});

test('the keyboard ring is class-driven, so the Offers link needs no script change', () => {
    assert.match(
        appJs,
        /panel\.querySelectorAll\('\.account-menu-item'\)/,
        'the account menu no longer finds its items by class'
    );
});

test('the Offers link navigates rather than being handled like the in-page links', () => {
    // The two in-page items are given a handler that closes the menu on a zero-delay timeout,
    // because hiding the panel cancels an in-page anchor jump. The Offers link is a real
    // navigation, so it deliberately has no such handler: the document unloads and there is no
    // panel left over the destination. Adding one would be harmless but wrong in intent, and
    // what matters is the reverse -- that no handler calls `preventDefault` on it, which would
    // render a link that looks live and does nothing.
    assert.doesNotMatch(
        appJs,
        /account-menu-offers/,
        'the Offers link has a handler; it should navigate natively'
    );
    // The outside-click close must not treat the panel's own links as outside it, or the menu
    // closes under the pointer on the way to the destination.
    assert.match(
        appJs,
        /!event\.target\.closest\('#account-menu'\)/,
        'the outside-click close no longer exempts the menu itself'
    );
});
