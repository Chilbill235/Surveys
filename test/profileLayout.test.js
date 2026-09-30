const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The profile card's shape.
 *
 * This exists because of one rule: a control sits next to the thing it changes. The picture
 * controls used to live in the far column of the card, a full card-width from the picture they
 * replace, so the reader had to hold "choose" and "this face" in their head across the gutter --
 * which is not a strong claim about a profile card, it is just the sort of thing that happens
 * when a form is assembled from two columns of unrelated settings.
 *
 * Nothing pinned any of it before. The card could have lost its picture controls, moved them
 * back across the gutter, or lost the mobile order that makes it readable on a phone, and every
 * check in the repo would have passed.
 */

const account = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** The card's markup, so an assertion can be about this block and not the whole page. */
function profileCard() {
    const start = account.indexOf('<div class="account-profile"');
    assert.notEqual(start, -1, 'the profile card is gone');
    // To its matching close, by counting divs from the opening tag.
    let depth = 0;
    for (let i = start; i < account.length; i += 1) {
        if (account.startsWith('<div', i)) depth += 1;
        else if (account.startsWith('</div>', i)) {
            depth -= 1;
            if (depth === 0) return account.slice(start, i + 6);
        }
    }
    throw new Error('unbalanced divs in the profile card');
}

test('the picture controls are beside the picture, not across the card', () => {
    const card = profileCard();
    // Order in the markup is the order a screen reader and a keyboard tab run through it, so
    // "beside" has to mean adjacent in the source and not merely nearby on screen.
    const avatar = card.indexOf('id="profile-avatar-preview"');
    const actions = card.indexOf('class="profile-avatar-actions"');
    const nameField = card.indexOf('id="profile-display-name"');
    assert.ok(avatar > -1, 'the picture preview is gone');
    assert.ok(actions > -1, 'the picture controls are gone');
    assert.ok(nameField > -1, 'the display name field is gone');

    assert.ok(
        actions > avatar && nameField > actions,
        'the picture controls are no longer between the picture and the name'
    );

    // And they are in the same grid column as the picture, so they sit under the name rather
    // than under the far edge of the card. Without the explicit row/column pair they fall back
    // to source order into column one, which puts the button under the avatar instead.
    assert.match(
        css,
        /\.account-profile-avatar \{[\s\S]*?grid-column: 1;/,
        'the avatar is not pinned to its own column'
    );
    assert.match(
        css,
        /\.profile-avatar-actions \{ grid-column: 2;/,
        'the picture controls are not in the same column as the picture'
    );
});

test('the card stacks in an order that still reads on a phone', () => {
    // Picture, then who you are, then what to change. If the controls come back above the
    // description on a narrow screen the block reads as a form with no subject attached to it.
    assert.match(
        css,
        /@media \(max-width: 820px\) \{[\s\S]*?\.profile-avatar-actions \{ grid-column: 1 \/ -1; grid-row: 3; \}/,
        'the mobile stacking order was lost'
    );
    // And the card's own two columns collapse, or the phone gets a two-column card.
    assert.match(
        css,
        /@media \(max-width: 820px\) \{[\s\S]*?\.account-profile \{ grid-template-columns: minmax\(0, 1fr\);/,
        'the profile card does not collapse on a narrow screen'
    );
});

test('the avatar size is declared in both places it can disagree', () => {
    // The element carries `width`/`height` attributes and the stylesheet carries a size. If
    // only one changes, the image reserves a different box than it paints into and the card
    // shifts when the picture loads -- which is the one thing above the fold on this page.
    const card = profileCard();
    const attribute = /<img[^>]*id="profile-avatar-preview"[^>]*width="(\d+)"/.exec(card);
    assert.ok(attribute, 'the preview lost its width attribute');
    const rule = /\.profile-avatar-preview \{[\s\S]*?width: (\d+)px;[\s\S]*?height: (\d+)px;/.exec(css);
    assert.ok(rule, 'the preview lost its size rule');
    assert.equal(
        Number(attribute[1]),
        Number(rule[1]),
        `the element reserves ${attribute[1]}px but the stylesheet paints ${rule[1]}px`
    );
    assert.equal(Number(rule[1]), Number(rule[2]), 'the preview is not square');
});

test('the name counter counts characters, not code units', () => {
    // The one genuinely load-bearing thing in the counter. `maxlength` on a text input is
    // measured in UTF-16 code units, so an emoji is two -- and a counter reading `value.length`
    // alongside it tells a user they have 60 characters available and then stops them at 30,
    // with nothing on screen explaining the discrepancy.
    const counter = /function renderProfileEditor\(\) \{([\s\S]*?)\n\}/.exec(app);
    assert.ok(counter, 'renderProfileEditor is gone');
    assert.match(
        counter[1],
        /getElementById\('profile-name-count'\)/,
        'the counter is never painted'
    );
    assert.match(
        counter[1],
        /\[\.\.\.\(nameInput\.value \|\| ''\)\]\.length/,
        'the counter counts UTF-16 code units, so it under-reports emoji'
    );
    // It reads the limit off the field rather than restating it, because a hardcoded 60 next to
    // a `maxlength` of 60 is two numbers that will eventually differ.
    assert.match(
        counter[1],
        /nameInput\.getAttribute\('maxlength'\)/,
        'the counter hardcodes the limit instead of reading it'
    );
});

test('the counter is not a live region', () => {
    // It is updated on every keystroke. As a live region that is a screen reader talking over
    // the person who is typing, on every character, to say a number the field's limit already
    // conveys. Decorative, therefore hidden from the tree.
    assert.match(account, /id="profile-name-count"[^>]*aria-hidden="true"/, 'the counter is announced');
});

test('the counter warns before the limit, not at it', () => {
    // At the limit it is too late: the input has already refused the characters past the end.
    // The user needs to be told while there is still room to shorten something.
    const counter = /function renderProfileEditor\(\) \{([\s\S]*?)\n\}/.exec(app);
    assert.match(
        counter[1],
        /is-warning/,
        'the counter never warns'
    );
    const threshold = /used >= limit - (\d+)/.exec(counter[1]);
    assert.ok(threshold, 'the warning threshold is not expressed against the limit');
    assert.ok(Number(threshold[1]) > 0, 'the counter warns only once the limit is already reached');
    // And the rule it toggles exists, or the class does nothing visible.
    assert.match(css, /\.field-count\.is-warning \{/, 'the warning state has no style');
});