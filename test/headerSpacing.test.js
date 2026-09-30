const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The header's spacing, asserted against the stylesheet rather than against a screenshot.
 *
 * Every defect this file exists for was invisible in a diff and obvious on a phone, which is
 * the worst possible ratio. They were also all *measured* problems -- a 0px gap, a -26px
 * overlap, a 19px disagreement between a declared height and a real one -- so each one is
 * pinned here as the number it was, and the browser-side probe (`probe-header.tmp.js`) is what
 * re-measures them after a change. A structural test catches a rule being reverted; only the
 * probe catches the layout actually moving.
 */

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/** Returns the declarations of the rule whose selector is exactly `selector`. */
function ruleFor(selector) {
    // Anchored to the start of a line so a compound selector elsewhere cannot match first.
    // `.topbar-lead` alone is the flex row; `.topbar > .topbar-lead` is a grid placement with
    // no gap in it, and a substring search finds that one first.
    const re = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
    const match = re.exec(css);
    assert.ok(match, `${selector} has no rule in style.css`);
    const open = css.indexOf('{', match.index);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
            depth -= 1;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    throw new Error(`unbalanced braces after ${selector}`);
}

/** Returns the bodies of every `@media` block whose condition contains `marker`. */
function mediaBlocks(marker) {
    const re = /@media([^{]+)\{/g;
    const bodies = [];
    let match;
    while ((match = re.exec(css)) !== null) {
        if (!match[1].includes(marker)) continue;
        const open = css.indexOf('{', match.index);
        let depth = 0;
        for (let i = open; i < css.length; i += 1) {
            if (css[i] === '{') depth += 1;
            else if (css[i] === '}') {
                depth -= 1;
                if (depth === 0) {
                    bodies.push(css.slice(open + 1, i));
                    break;
                }
            }
        }
    }
    return bodies;
}

/**
 * The single `@media` block for `marker`.
 *
 * Throws when there is more than one, because a stylesheet that has accumulated several blocks
 * for the same breakpoint is exactly the situation where "which one did the author mean" is the
 * wrong question and the file needs consolidating.
 */
function mediaContaining(marker) {
    const bodies = mediaBlocks(marker);
    assert.ok(bodies.length > 0, `there is no @media block for ${marker}`);
    assert.equal(bodies.length, 1, `expected one @media block for ${marker}, found ${bodies.length}`);
    return bodies[0];
}

/** True when any `@media` block for `marker` contains `pattern`. */
function anyMediaBlock(marker, pattern) {
    return mediaBlocks(marker).some((body) => pattern.test(body));
}

/**
 * The `@media` block for `marker` that styles `selectorPattern`, concatenated if several do.
 *
 * The stylesheet has six `@media (max-width: 720px)` blocks, most of them about things that are
 * not the header. `mediaContaining` refuses that ambiguity outright, which is the right default
 * and the wrong tool here: the question is not "which 720px block did the author mean" but "does
 * a 720px block do this to the header". Joining the matching bodies keeps the assertion
 * indifferent to which of them it lands in, and surfaces a genuine conflict if two of them
 * set the same property differently -- the last one would win and the joined text would not
 * match a single-value pattern.
 */
function mediaStyling(marker, selectorPattern) {
    const bodies = mediaBlocks(marker).filter((body) => selectorPattern.test(body));
    assert.ok(bodies.length > 0, `no @media block for ${marker} styles ${selectorPattern}`);
    return bodies.join('\n');
}

test('the clock and the wordmark have a real gap between them', () => {
    // This is the one the user reported as "closed pushed together". `.topbar-lead` is a flex
    // container whose children are the clock and the brand, and it had no `gap` at all: measured
    // 0px at 721, 768, 820 and 900px. An earlier version put the separation in padding on the
    // clock instead, which only ever separated the clock from the edge of the cell -- never
    // from the brand, which is its actual sibling.
    const lead = ruleFor('.topbar-lead');
    assert.match(lead, /gap:\s*\d+px/, 'the lead group has no gap between the clock and the wordmark');
    assert.doesNotMatch(lead, /gap:\s*0/, 'the lead group gap is zero');
});

test('the date is the first thing the clock gives up, not the time', () => {
    // The date is ~95px of the clock's ~162px. It is dropped below 1080px so the centred
    // navigation keeps its clearance; the time is what makes the element a clock and stays.
    const body = mediaContaining('max-width: 1080px');
    assert.ok(body, 'there is no 1080px media query');
    assert.match(body, /\.topbar-clock-date\s*\{[^}]*display:\s*none/, 'the date is not dropped at 1080px');
    // The time must not be in the same rule. Hiding it too would leave a bare date in a
    // collapsed group at some width between the two breakpoints.
    const timeRule = /\.topbar-clock-time[^{]*\{[^}]*\}/.exec(body);
    assert.doesNotMatch(timeRule ? timeRule[0] : '', /display:\s*none/, 'the time is dropped with the date');
});

test('the header grid stops competing for space on a phone', () => {
    // `1fr auto 1fr` makes the two side cells equal, so a 114px nav forced the left cell down
    // to 122px while the 150px wordmark inside it still wanted 150px -- and the wordmark
    // overlapped the nav by 26px at 320px. There was 114px of unused width in the row the
    // whole time; it was locked into the wrong column.
    //
    // The phone row is content-sized with a clock in the middle cell. `minmax(0, 1fr)` rather
    // than `1fr` on that cell, because a bare `1fr` has an implicit `min-width: auto` and the
    // clock's min-content width -- one unbroken date, since the base rule sets `nowrap` -- would
    // refuse to shrink and push the account controls past the right edge.
    const body = mediaStyling('max-width: 720px', /\.topbar/);
    assert.match(body, /\.topbar\s*\{\s*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    assert.doesNotMatch(body, /grid-template-columns:\s*1fr auto 1fr/, 'the equal sides are back on a phone');
});

test('the navigation is gone from the phone header, and the clock has its own cell', () => {
    // The nav used to leave at 480px. That was two breakpoints too late: it had no cell of its
    // own, so it fell to auto-placement in a three-column row that now had one free cell fewer
    // than before, and landed in column 2 -- the clock's column. Measured 0px of clearance from
    // the clock at 520px, clearing it by more at every wider width only because the flexible
    // column outgrew both items.
    //
    // Hiding it across the whole band is the fix. A fourth column was not available: wordmark
    // 129 + nav 98 + clock 86 + controls 48 = 361px before gaps and padding, which is 421px
    // against a 320px header.
    const body = mediaStyling('max-width: 720px', /\.topbar/);
    assert.match(body, /\.topbar > nav\s*\{[^}]*display:\s*none/, 'the nav is still competing on a phone');
    // Every item in row 1 is now placed explicitly. An unplaced item is what auto-placed into
    // the clock's column in the first place, so the clock's placement is the actual assertion.
    assert.match(body, /\.topbar-clock\s*\{[^}]*grid-column:\s*2/, 'the clock has no cell of its own');
    assert.match(body, /\.topbar > \.account-tools\s*\{\s*grid-column:\s*3/);
    assert.match(body, /\.topbar > \.brand\s*\{\s*grid-column:\s*1/);
});

test('the clock is shown on a phone, stacked, at the right-hand end', () => {
    // The clock was hidden outright below 720px because a one-line clock needed 162px and the
    // wordmark plus the account menu left less than that at 320px. Stacking is what bought it
    // the width to exist: 86px measured against 162px on one line, with 21px of clearance from
    // the wordmark at 320px.
    //
    // `justify-self: end` is the other half. Being in the middle column is not the same as being
    // at the right of the header, and the request was for the far right.
    const body = mediaStyling('max-width: 720px', /\.topbar/);
    assert.doesNotMatch(body, /\.topbar-clock\s*\{[^}]*display:\s*none/, 'the clock is hidden again');
    assert.match(body, /\.topbar-clock\s*\{[^}]*flex-direction:\s*column/, 'the clock is not stacked');
    assert.match(body, /\.topbar-clock\s*\{[^}]*justify-self:\s*end/, 'the clock is not at the right-hand end');
    // The date is dropped on a narrow desktop to keep the nav's clearance and restored on a
    // phone, where the clock has a cell to itself and the nav is gone. It is the whole reason
    // the phone clock can say what day it is.
    assert.match(body, /\.topbar-clock-date\s*\{[^}]*display:\s*block/, 'the phone date was left hidden');

    // `display: contents` dissolves `.topbar-lead` so the clock can be placed in the header's
    // own grid. The wrapper is a plain `div` with no role or landmark, so the usual caveat about
    // that property taking semantics with it does not apply -- but it is only true while it
    // stays true, and adding a role to that div would silently break this.
    assert.match(body, /\.topbar-lead\s*\{\s*display:\s*contents/, 'the lead wrapper was not dissolved');
    assert.doesNotMatch(
        ruleFor('.topbar-lead'),
        /\brole=/,
        'the lead wrapper carries a role, which display: contents would strip'
    );
});

test('a hidden live indicator takes no room in the header', () => {
    // `.live-indicator { display: inline-flex }` beat the `hidden` attribute's UA
    // `display: none`, because an author rule on the class wins. The indicator therefore
    // occupied the header's second grid row on every page in every session state -- signed out,
    // before the first request resolved -- leaving a dead band under the content. The same
    // shape as the dialog `[open]` guards elsewhere in this file.
    assert.match(
        css,
        /\.live-indicator\[hidden\]\s*\{\s*display:\s*none/,
        'hidden live indicators still occupy a grid row'
    );
});

test('the declared header height is the real one, not the minimum', () => {
    // `--header-h` feeds `scroll-padding-top` on the root and the `top` of every sticky bar.
    // It said 68px while the header measured 87px on desktop and 100px on mobile, so
    // `.catalog-toolbar` stuck 7px behind the header and anchors landed under it. Both causes
    // of the extra height are deliberate -- a 48px coarse-pointer tap target and the status
    // row -- so the variable is wrong, not the layout.
    assert.match(css, /@media \(min-width: 861px\)\s*\{\s*:root \{ --header-h: 87px; \}/);
    assert.match(css, /@media \(max-width: 860px\)\s*\{\s*:root \{ --header-h: 100px; \}/);

    // The breakpoint has to be the 860px one the action bar already uses. A different number
    // leaves a band where the declared height is for the other layout, which is how the
    // original 721-860px band with both sets of controls on screen happened.
    assert.match(css, /min-width: 861px/, 'the desktop boundary is not 861px');
});

test('the filter row wraps instead of overflowing', () => {
    // A 12px horizontal scrollbar across the whole 721-760px band, from a non-wrapping flex row
    // whose sort field has a fixed minimum. `flex-wrap` on the row is the fix; narrowing the
    // sort field would make the control worse at every width to fix one.
    //
    // Checked across every 860px block rather than the first one, because the file has several
    // blocks for this breakpoint and a single-block assertion passes or fails on whichever one
    // happens to come first -- which is not the property being tested.
    assert.ok(
        anyMediaBlock('max-width: 860px', /\.catalog-filters\s*\{\s*flex-wrap:\s*wrap/),
        'the filter row still cannot wrap'
    );
    // The chips take the full line so the sort field is not left sharing a line that cannot
    // hold both.
    assert.ok(
        anyMediaBlock('max-width: 860px', /\.filter-chips\s*\{\s*flex:\s*1 1 100%/),
        'the chip group does not take its own line'
    );
    // And the base rule must not have gained a non-wrapping `flex-wrap` that outranks it.
    assert.doesNotMatch(ruleFor('.catalog-filters'), /flex-wrap:\s*nowrap/);
});

test('the phone handover is one breakpoint', () => {
    // The header used to hand over at 480px for the nav and 720px for the clock, which is a
    // band where neither rule was true of the whole header and the nav auto-placed into the
    // clock's cell. The clock's 720px block now owns the whole phone header, and the 480px
    // nav rule is gone.
    assert.match(css, /@media \(max-width: 720px\)\s*\{/);
    assert.ok(
        !/max-width: 480px[\s\S]{0,400}?\.topbar/.test(css),
        'a 480px block still styles the header, so the handover is split'
    );
    // 860px is a different handover and still exists, for the action bar and the header's own
    // controls. The point is that the header's *layout* keys off one number.
    assert.match(css, /@media \(max-width: 860px\)/);
});

test('the header is not hidden on a phone', () => {
    // The one thing that must never happen to the header on a phone: the rule that hides the
    // clock and the rule that hides the header live in the same media block, so an over-broad
    // edit to one reaches the other.
    assert.doesNotMatch(css, /@media \(max-width: 720px\)\s*\{\s*\.topbar \{ display: none/);
});
