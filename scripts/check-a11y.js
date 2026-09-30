/**
 * Accessibility and ergonomics checks that can be settled by reading the source.
 *
 * This exists because the obvious failures -- a control with no label, two elements sharing
 * an id, a 36px tap target -- are invisible in a screenshot and invisible to a style guide,
 * yet each one makes the site harder to use for someone. They are all decidable statically,
 * so they are decided statically.
 *
 * Deliberately not covered: anything that needs a rendered page. Layout, overlap, and
 * computed colours are only knowable in a browser, and a check that pretends to know them
 * is worse than no check at all.
 */

const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');
const pages = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));

let problems = 0;
const fail = (message) => { problems += 1; console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`PASS ${message}`);

const css = read('style.css');

/**
 * Strips comments and the contents of script and style elements, so text that looks like
 * markup inside a `<script>` is not parsed as an element.
 *
 * Every offset used below comes from this cleaned string, and every slice is taken from it
 * too. Mixing the two is a silent disaster: the first version scanned the cleaned text but
 * sliced the raw one, so every element's inner text came from the wrong place and every
 * control looked unlabelled.
 */
function markupOnly(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '');
}

/** Every element that starts a tag, with its attributes, for simple source-level inspection. */
function* elements(html) {
    const pattern = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    for (const match of html.matchAll(pattern)) {
        const tag = match[1].toLowerCase();
        const attributes = {};
        for (const attribute of match[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
            attributes[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        }
        yield { tag, attributes, raw: match[0], index: match.index };
    }
}

/** The inner text of the element starting at `index`, up to its matching close tag. */
function innerText(html, index, tag) {
    if (['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) return '';

    const start = html.indexOf('>', index) + 1;
    let depth = 1;
    let end = html.length;
    const scanner = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
    scanner.lastIndex = start;
    for (const token of html.matchAll(scanner)) {
        depth += token[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
            end = token.index;
            break;
        }
    }

    return html.slice(start, end)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;|&#\d+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Whether the element at `index` sits inside a `<label>`.
 *
 * Counts open and close tags across the whole document up to the element rather than looking
 * at a fixed-size window behind it. A window cannot work: any earlier `</label>` in those
 * characters makes the element look unwrapped, which is how the search field -- genuinely
 * wrapped, with a visually hidden label -- was reported as having no name at all.
 */
function insideLabel(html, index) {
    let depth = 0;
    const scanner = /<label\b|<\/label\s*>/gi;
    scanner.lastIndex = 0;
    for (const token of html.matchAll(scanner)) {
        if (token.index >= index) break;
        depth += token[0].startsWith('</') ? -1 : 1;
    }
    return depth > 0;
}

// ---------------------------------------------------------------------------
// Unique ids
// ---------------------------------------------------------------------------

for (const page of pages) {
    const clean = markupOnly(read(page));
    const seen = new Map();
    for (const element of elements(clean)) {
        const id = element.attributes.id;
        if (!id) continue;
        if (seen.has(id)) {
            fail(`${page}: duplicate id "${id}" -- getElementById returns only the first, so the second is unreachable`);
        } else {
            seen.set(id, true);
        }
    }
}
if (!problems) pass(`every id is unique across all ${pages.length} pages`);

// ---------------------------------------------------------------------------
// Form controls have an accessible name
// ---------------------------------------------------------------------------

// Elements whose accessible name is normally their own text content.
const NAMED_BY_TEXT = new Set(['button', 'select', 'textarea', 'meter', 'output', 'progress']);
const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

for (const page of pages) {
    const clean = markupOnly(read(page));
    const labelsFor = new Set([...clean.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));

    for (const element of elements(clean)) {
        const { tag, attributes } = element;
        if (!CONTROL_TAGS.has(tag)) continue;
        if (attributes.type === 'hidden') continue;
        // A control that is not in the tab order still needs a name; it is read aloud.
        if (attributes['aria-label'] || attributes['aria-labelledby']) continue;
        if (attributes.id && labelsFor.has(attributes.id)) continue;
        if (insideLabel(clean, element.index)) continue;

        fail(`${page}: <${tag}${attributes.id ? ` id="${attributes.id}"` : ''}> has no label, aria-label, or wrapping <label>`);
    }
}
pass('every form control has an accessible name (label, aria-label, or wrapper)');

// ---------------------------------------------------------------------------
// Buttons and links have an accessible name
// ---------------------------------------------------------------------------

for (const page of pages) {
    const clean = markupOnly(read(page));
    const labelsFor = new Set([...clean.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));

    for (const element of elements(clean)) {
        const { tag, attributes } = element;
        if (!NAMED_BY_TEXT.has(tag) && tag !== 'a') continue;
        // Anchors are only interactive when they have an href.
        if (tag === 'a' && !attributes.href) continue;
        if (attributes['aria-label'] || attributes['aria-labelledby'] || attributes.title) continue;
        if (attributes['aria-hidden'] === 'true') continue;
        // A select or textarea is normally named by an external <label for>, and never by its
        // own text -- the text is the currently chosen option, which changes as the user
        // picks. Requiring inner text here reported a correctly labelled dropdown as nameless.
        if (attributes.id && labelsFor.has(attributes.id)) continue;
        if (tag !== 'a' && insideLabel(clean, element.index)) continue;

        const name = innerText(clean, element.index, tag);
        if (!name) {
            fail(`${page}: <${tag}${attributes.id ? ` id="${attributes.id}"` : ''}${attributes.class ? ` class="${attributes.class}"` : ''}> has no accessible name -- a screen reader announces it as just "button"`);
        }
    }
}
pass('every button, link, and select has an accessible name');

// ---------------------------------------------------------------------------
// Images are described or explicitly decorative
// ---------------------------------------------------------------------------

for (const page of pages) {
    const clean = markupOnly(read(page));
    for (const element of elements(clean)) {
        if (element.tag !== 'img') continue;
        const { attributes } = element;
        const decorative = attributes['aria-hidden'] === 'true' || attributes.role === 'presentation' || attributes.role === 'none';
        if (attributes.alt === undefined && !decorative) {
            fail(`${page}: <img src="${attributes.src || '?'}"> has no alt attribute -- screen readers fall back to reading the file name`);
        }
    }
}
pass('every image has alt text, or is marked decorative');

// ---------------------------------------------------------------------------
// Dialogs are named
// ---------------------------------------------------------------------------

for (const page of pages) {
    const clean = markupOnly(read(page));
    for (const element of elements(clean)) {
        if (element.tag !== 'dialog') continue;
        const named = element.attributes['aria-label']
            || element.attributes['aria-labelledby']
            || (element.attributes.id && new RegExp(`aria-labelledby="[^"]*\\b${element.attributes.id}\\b`).test(clean))
            || innerText(clean, element.index, 'dialog');
        if (!named) {
            fail(`${page}: <dialog${element.attributes.id ? ` id="${element.attributes.id}"` : ''}> has no accessible name`);
        }
    }
}
pass('every dialog has an accessible name');

// ---------------------------------------------------------------------------
// Tap targets
// ---------------------------------------------------------------------------

/** Reads a numeric min-height or height, in px, from a rule block in the stylesheet. */
function declaredHeight(cssText, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = cssText.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm'));
    if (!block) return null;
    const height = block[1].match(/(?:min-height|height)\s*:\s*(\d+)px/);
    return height ? Number(height[1]) : null;
}

// The interactive surfaces a finger has to hit. These are the ones that must be enlarged on
// a touch device; the desktop minimum is lower on purpose.
const TAP_TARGETS = [
    '.button', '.start-button', '.filter-chip', '.choice',
    '.deposit-method-option', '.auth-mode-button', '.amount-presets button', '.switch'
];

/**
 * 44px is a *touch* guideline. Holding every control to it on a mouse-driven desktop would be
 * wrong -- a 34px filter chip is a normal, comfortable size with a pointer, and inflating it
 * would make the toolbar look clumsy. So two thresholds: a modest floor everywhere, and 48px
 * inside the coarse-pointer block where a finger is actually doing the tapping.
 */
const DESKTOP_FLOOR = 32;
const TOUCH_TARGET = 48;

let tapProblems = 0;

for (const selector of TAP_TARGETS) {
    const height = declaredHeight(css, selector);
    if (height === null) {
        fail(`no base height found for ${selector}, so its size cannot be verified`);
        tapProblems += 1;
    } else if (height < DESKTOP_FLOOR) {
        fail(`${selector} is ${height}px in the base rules, under the ${DESKTOP_FLOOR}px desktop floor`);
        tapProblems += 1;
    }
}
if (!tapProblems) pass(`every tap target meets the ${DESKTOP_FLOOR}px desktop floor`);

// The coarse-pointer block is what lifts targets for touch, so every control it is meant to
// cover has to actually be in it, and has to be lifted to the touch target.
const coarseBlock = css.match(/@media \(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/);
if (!coarseBlock) {
    fail('no @media (pointer: coarse) block: tap targets are never enlarged on a touch device');
} else {
    const body = coarseBlock[1];
    for (const selector of [...TAP_TARGETS, '.icon-button', '.form-control', '.max-button']) {
        if (!body.includes(selector)) {
            fail(`the pointer:coarse block does not lift ${selector} for touch`);
            tapProblems += 1;
        }
    }
    // Every rule in the block has to agree on one target size, or the column of controls in a
    // form ends up with mixed heights on a phone.
    const heights = new Set([...body.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1])));
    if (heights.size !== 1 || !heights.has(TOUCH_TARGET)) {
        fail(`the pointer:coarse block mixes target sizes ${[...heights].join(', ')}; expected all ${TOUCH_TARGET}px`);
        tapProblems += 1;
    }
    if (!tapProblems) pass(`the pointer:coarse block lifts every tap target to ${TOUCH_TARGET}px`);
}

// ---------------------------------------------------------------------------

console.log(`\n${problems === 0 ? 'ACCESSIBILITY CHECKS PASSED' : `${problems} problem(s) found`}`);
if (problems > 0) process.exit(1);
