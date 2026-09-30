/* A miniature CSS cascade simulator.
 *
 * Reading the stylesheet is not verification: the bug that motivated the previous
 * rewrite was a media query that was present and correct but silently overridden by a
 * later desktop rule, and that is invisible by inspection. This resolves, for a given
 * viewport and pointer type, which declaration actually wins for a selector.
 *
 * It handles the subset of CSS this project uses: @media with and/or/not over
 * max-width, min-width and pointer; single- and multi-selector rules; and the standard
 * specificity order. @keyframes blocks are skipped, and declarations marked !important
 * are honoured. It is not a browser, but it agrees with one on the questions asked here.
 *
 * Run from the project root: node tmp-cascade.js
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

// ------------------------------------------------------------------ parsing

/** Splits a rule body into declarations. */
function parseDeclarations(body) {
    const declarations = [];
    for (const chunk of body.split(';')) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon === -1) continue;
        const property = trimmed.slice(0, colon).trim();
        let value = trimmed.slice(colon + 1).trim();
        let important = false;
        if (/!important$/i.test(value)) {
            important = true;
            value = value.replace(/!important$/i, '').trim();
        }
        declarations.push({ property, value, important });
    }
    return declarations;
}

/** Walks the stylesheet, tracking brace depth so @media bodies can be flattened. */
function parseStylesheet(source) {
    // Comments are stripped first. A brace inside a comment would otherwise shift the
    // depth counter and mis-associate every rule after it.
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];

    parseRange(clean, 0, clean.length, [], rules);
    return rules;
}

/** Parses every rule between two offsets, inheriting `mediaStack`. */
function parseRange(source, from, to, mediaStack, rules) {
    let index = from;

    while (index < to) {
        const braceStart = source.indexOf('{', index);
        if (braceStart === -1 || braceStart >= to) break;

        const prelude = source.slice(index, braceStart).trim();

        // Find the close brace that matches this one, without leaving the range.
        let depth = 1;
        let cursor = braceStart + 1;
        while (cursor < to && depth > 0) {
            if (source[cursor] === '{') depth += 1;
            else if (source[cursor] === '}') depth -= 1;
            cursor += 1;
        }
        const body = source.slice(braceStart + 1, cursor - 1);

        if (prelude.startsWith('@media')) {
            // Descend: the conditions apply to every rule inside the block, so the
            // nested rules are collected with the condition attached rather than the
            // whole block being treated as opaque.
            parseRange(source, braceStart + 1, cursor - 1,
                mediaStack.concat(prelude.slice(6).trim()), rules);
        } else if (prelude.startsWith('@')) {
            // Keyframes and other at-rules contribute no cascaded declarations here.
        } else {
            for (const selector of splitSelectors(prelude)) {
                rules.push({
                    media: mediaStack.slice(),
                    selector,
                    specificity: specificityOf(selector),
                    declarations: parseDeclarations(body),
                    order: rules.length
                });
            }
        }

        index = cursor;
    }
}

function splitSelectors(prelude) {
    return prelude.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('@'));
}

/** id count, then class/attribute/pseudo-class count, then element count. */
function specificityOf(selector) {
    const withoutStrings = selector.replace(/"[^"]*"/g, '""');
    const ids = (withoutStrings.match(/#[\w-]+/g) || []).length;
    const classes = (withoutStrings.match(/\.[\w-]+/g) || []).length
        + (withoutStrings.match(/\[[^\]]*\]/g) || []).length
        + (withoutStrings.match(/:(?!:)[a-z-]+/g) || []).length;
    const elements = (withoutStrings.match(/(^|[\s>+~])([a-z][\w-]*)/g) || []).length;
    return ids * 10000 + classes * 100 + elements;
}

// ------------------------------------------------------- media query matching

const featurePattern = /\(\s*([a-z-]+)\s*:\s*([^)]+)\)/gi;

function matchesCondition(condition, environment) {
    let result = null;
    // Split on `and`, leaving `or` handling to the top level.
    const orParts = condition.split(/\bor\b/i);
    result = orParts.some((orPart) => {
        const andParts = orPart.split(/\band\b/i);
        return andParts.every((part) => {
            const negated = part.trim().startsWith('not ');
            const cleaned = part.trim().replace(/^not\s+/i, '').trim();
            const matched = matchesFeatureList(cleaned, environment);
            return negated ? !matched : matched;
        });
    });
    return result;
}

function matchesFeatureList(text, environment) {
    if (text === '') return true;
    let allMatched = true;
    let matchedAny = false;
    featurePattern.lastIndex = 0;
    let match;
    while ((match = featurePattern.exec(text)) !== null) {
        const feature = match[1].toLowerCase();
        const rawValue = match[2].trim();
        matchedAny = true;

        if (feature === 'max-width') {
            allMatched = allMatched && environment.width <= parseFloat(rawValue);
        } else if (feature === 'min-width') {
            allMatched = allMatched && environment.width >= parseFloat(rawValue);
        } else if (feature === 'pointer') {
            allMatched = allMatched && environment.pointer === rawValue.toLowerCase();
        } else if (feature === 'prefers-color-scheme') {
            // Treated as non-matching so the light-mode cascade is what gets verified.
            // The dark block only redefines colour tokens, never layout, so excluding
            // it cannot hide a layout problem.
            allMatched = false;
        } else {
            // Any other feature this stylesheet does not use for layout.
            allMatched = true;
        }
    }
    return matchedAny ? allMatched : true;
}

// ------------------------------------------------------------------ cascade

/**
 * The classes a selector is written in, used to decide whether another rule could be talking
 * about the same element.
 *
 * The element being described is not in this file, so "does this selector match it" cannot be
 * answered exactly. What can be answered is the weaker and sufficient question: does the other
 * rule name one of the same classes? That is what makes a competing rule visible at all.
 */
function classesIn(selector) {
    const withoutStrings = selector.replace(/"[^"]*"/g, '""');
    return (withoutStrings.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
}

/** The element names in a selector -- `nav`, `footer`, `button`. */
function typesIn(selector) {
    const withoutStrings = selector.replace(/"[^"]*"/g, '""');
    return (withoutStrings.match(/(^|[\s>+~])([a-z][\w-]*)/g) || [])
        .map((m) => m.replace(/[\s>+~]/g, ''));
}

/**
 * Rules that set `property` on what may be the same element, at a specificity equal to or
 * higher than `target`, and say something different.
 *
 * This is the check that would have caught the footer's `display` being flex. `.site-footer-group
 * { display: grid }` was correct, asserted, and passing -- because `resolve()` only ever looks at
 * rules whose selector string *equals* the one asked about. `.site-footer nav { display: flex }`
 * was never consulted: it is a different string, it outranks it on specificity (a class plus a
 * type beats a class), and it wins in every browser on every page with that footer. The
 * assertion could not see it, so the check reported the stylesheet was correct while the
 * stylesheet was not.
 *
 * The class test is deliberately narrow. A competing rule has to describe the same element, so
 * it has to name every class the target names -- not merely share one. Two rules that mention
 * `.dialog-panel` but where one is scoped to a contact dialog and the other is not are not
 * rivals; they are a base rule and a deliberate override of it, and that is how a stylesheet is
 * supposed to be written. What disqualifies a candidate is claiming to be a rule about the same
 * thing while naming a different subset of the target's classes.
 *
 * That leaves exactly the footer shape: `.site-footer nav` names no class the target names, so
 * it is not caught here either. So the class relationship is checked in the other direction
 * too: a rule that mentions a *type* selector the target's element also has -- `nav` -- while
 * naming none of the target's classes, is the ancestor-or-sibling rule that can silently
 * outrank it. That is the specific form the mistake took, and the comment on the footer rule
 * records why it is easy to fall into.
 */
function competingRules(rules, selector, property, environment, target) {
    const classes = classesIn(selector);
    const types = typesIn(selector);
    const found = [];
    for (const rule of rules) {
        if (rule.selector === selector) continue;
        if (!rule.media.every((condition) => matchesCondition(condition, environment))) continue;
        if (rule.specificity < target.specificity) continue;

        const competitorClasses = classesIn(rule.selector);
        const competitorTypes = typesIn(rule.selector);
        const scoped = /[\s>+~]/.test(rule.selector.replace(/::?[a-z-]+(\([^)]*\))?/g, '').trim());

        // A single compound selector naming exactly the target's classes is the same element
        // written twice -- the only way two such rules can both apply is if one is stale.
        if (!scoped && competitorClasses.length > 0
            && classes.length === competitorClasses.length
            && classes.every((c) => competitorClasses.includes(c))) {
            found.push(rule);
            continue;
        }

        // A rule that names no class at all but does name an element type the target's element
        // also has. This is the footer shape: `.site-footer nav` reaches every nav inside the
        // footer, so it reaches `.site-footer-group` too, and a class plus a type outranks a
        // class. Nothing about the two selectors looks related unless you already know the
        // element is both.
        if (competitorClasses.length === 0 && competitorTypes.some((t) => types.includes(t))) {
            found.push(rule);
        }
    }
    return found.filter((rule) => {
        const declaration = rule.declarations.find((d) => d.property === property);
        return declaration && declaration.value !== target.value;
    }).map((rule) => `${rule.selector} (specificity ${rule.specificity} vs ${target.specificity})`);
}

let competitionProblems = 0;

/** Returns the winning declarations for `selector` in `environment`. */
function resolve(rules, selector, environment) {
    const winners = new Map();
    for (const rule of rules) {
        if (rule.selector !== selector) continue;
        if (!rule.media.every((condition) => matchesCondition(condition, environment))) continue;

        for (const declaration of rule.declarations) {
            const existing = winners.get(declaration.property);
            const better = !existing
                || (declaration.important && !existing.important)
                || (declaration.important === existing.important
                    && (rule.specificity > existing.specificity
                        || (rule.specificity === existing.specificity && rule.order > existing.order)));
            if (better) {
                winners.set(declaration.property, {
                    value: declaration.value,
                    important: declaration.important,
                    specificity: rule.specificity,
                    selector: rule.selector,
                    order: rule.order,
                    media: rule.media
                });
            }
        }
    }
    return winners;
}

const rules = parseStylesheet(css);

const viewports = {
    'phone 320 (small)': { width: 320, pointer: 'coarse' },
    'phone 390 (modern)': { width: 390, pointer: 'coarse' },
    'phone 430 (large)': { width: 430, pointer: 'coarse' },
    'tablet 768': { width: 768, pointer: 'coarse' },
    'laptop 1280': { width: 1280, pointer: 'fine' },
    'desktop 1440': { width: 1440, pointer: 'fine' },
    'wide 1920': { width: 1920, pointer: 'fine' },
    'narrow desktop window 700 (mouse)': { width: 700, pointer: 'fine' }
};

const expectations = [
    // [description, selector, property, { viewport: expected value }]
    // `undefined` means "no rule for this selector applies", so the element falls back to
    // the browser default or to whatever a lower-specificity rule set. That is a real
    // outcome, not a gap, so it is asserted where it is correct.
    ['phone', '.action-bar', 'display', { 'phone 390 (modern)': 'flex', 'laptop 1280': 'none' }],
    ['phone', '.header-action', 'display', { 'phone 390 (modern)': 'none', 'laptop 1280': undefined }],
    ['phone', '.offer-card', 'display', { 'phone 390 (modern)': 'grid', 'laptop 1280': 'flex' }],
    // 430px sits above the 400px block, so the row layout keeps its 116px action.
    ['phone', '.start-button', 'min-width', { 'phone 430 (large)': '116px', 'phone 390 (modern)': '0', 'laptop 1280': undefined }],
    // The blurb is a full-width row between the title and the reward. It is named rather
    // than auto-placed: an unnamed child in a grid with template areas lands in an implicit
    // row whose size nothing controls, which is how the row collapsed to zero height.
    ['phone', '.offer-card', 'grid-template-areas', { 'phone 430 (large)': "'top top' 'title title' 'blurb blurb' 'reward start'", 'laptop 1280': undefined }],
    // The blurb must be given its own area on mobile too, or it lands in that implicit row.
    ['phone', '.offer-blurb', 'grid-area', { 'phone 390 (modern)': 'blurb', 'laptop 1280': undefined }],
    ['phone', '.offer-grid', 'grid-template-columns', { 'phone 390 (modern)': 'minmax(0, 1fr)', 'laptop 1280': 'repeat(3, minmax(0, 1fr))', 'wide 1920': 'repeat(4, minmax(0, 1fr))' }],
    // The base .dialog must state inset/margin explicitly. The `* { margin: 0 }` reset
    // overrides the UA's `dialog:modal` centring, which is what left dialogs pinned to
    // the top-left corner. So `auto` / `0` here are load-bearing, not a restatement of
    // the UA default, and mobile then overrides them to turn the dialog into a sheet.
    ['phone', '.dialog', 'margin', { 'phone 390 (modern)': '0', 'laptop 1280': 'auto' }],
    ['phone', '.dialog', 'inset', { 'phone 390 (modern)': 'auto 0 0 0', 'laptop 1280': '0' }],
    ['phone', '.has-action-bar', 'padding-bottom', { 'phone 390 (modern)': 'calc(68px + env(safe-area-inset-bottom))', 'laptop 1280': undefined }],
    ['phone', 'body', 'padding-bottom', { 'phone 390 (modern)': undefined, 'laptop 1280': undefined }],
    ['phone', '.dialog', 'border-radius', { 'phone 390 (modern)': 'var(--r-xl) var(--r-xl) 0 0', 'laptop 1280': 'var(--r-lg)' }],
    // 430px resolves in the 720px sheet rule, 390px in the narrower 400px override.
    // Both keep the panel's top padding above the drawn handle so it stays visible.
    ['phone', '.dialog-panel', 'padding', {
        'phone 430 (large)': '14px 18px calc(20px + env(safe-area-inset-bottom))',
        'phone 390 (modern)': '17px 15px calc(17px + env(safe-area-inset-bottom))',
        'laptop 1280': '28px'
    }],
    ['phone', '.dialog-panel::before', 'display', { 'phone 390 (modern)': 'block', 'laptop 1280': undefined }],
    // The header is a three-column grid, and these four are the invariants that make the phone
    // layout work: the clock and wordmark share the left cell, the navigation owns a true
    // centre, the account tools sit at the end of the right one, and the live indicator gets
    // its own row so a long "Connection lost" cannot widen the centre column and push the
    // navigation off centre. The previous version of this asserted `flex-direction: row` on
    // `.topbar`, which the flex layout needed and the grid ignores -- it would have kept
    // passing after the header stopped being a flex row at all, which is the kind of check
    // that outlives the thing it was written for.
    // The header is a three-column grid above 720px and `auto minmax(0, 1fr) auto` below it.
    //
    // `1fr auto 1fr` forces the two side cells to be EQUAL, so on a 390px screen a 114px nav
    // pushed both sides down to 122px while the 150px wordmark inside the left one still
    // wanted 150px -- and the wordmark overlapped the navigation by 26px at 320px and 5px at
    // 414px. There was 114px of unused width in the row the whole time; it was locked into the
    // wrong column.
    //
    // The phone side is content-sized with the clock in its own cell. `minmax(0, 1fr)` rather
    // than `1fr` on the middle column so the clock can shrink rather than push the account
    // controls past the right edge, which is the failure a bare `1fr` allows here.
    //
    // The nav leaves the header below 720px, not 480px. It had no cell of its own, so it fell
    // to auto-placement in a row that now had one free cell fewer and landed in column 2 --
    // the clock's column -- clearing it by 0px at 520px. Asserted separately below, since the
    // one thing that genuinely changes across the breakpoint is where the nav is.
    ['phone', '.topbar', 'grid-template-columns', { 'phone 390 (modern)': 'auto minmax(0, 1fr) auto', 'laptop 1280': '1fr auto 1fr' }],
    ['phone', '.topbar', 'grid-template-rows', { 'phone 390 (modern)': 'auto auto', 'laptop 1280': 'auto auto' }],
    ['phone', '.topbar > .account-tools', 'grid-column', { 'phone 390 (modern)': '3', 'laptop 1280': '3' }],
    ['phone', '.topbar > .live-indicator', 'grid-row', { 'phone 390 (modern)': '2', 'laptop 1280': '2' }],

    // The navigation sat 8px left of true centre on every width and every page that has both a
    // nav and an account cluster. `justify-self: center` centres the *margin box*, and the nav
    // carried a `margin-right: 16px` left over from when the header was a flex row and this was
    // the last thing before the buttons. Half of it went back as a visible offset. It looked
    // centred, which is what made it survive: nothing overflows, nothing clips, and only a
    // measurement against the header's own midpoint shows it.
    ['phone', '.header-nav', 'margin-right', { 'phone 390 (modern)': undefined, 'laptop 1280': undefined }],

    // The clock and the wordmark are flex siblings in `.topbar-lead`, and that container had no
    // `gap` at all: measured 0px between "09:12:55 Wed, Sep 30, 2026" and "rewardzone" at 721,
    // 768, 820 and 900px. A `padding-left` on the clock had been standing in for the separation
    // and only ever separated it from the edge of the cell, never from its own sibling.
    //
    // Below 720px the wrapper dissolves so the clock can be given its own cell, which means the
    // gap stops being load-bearing exactly where it used to be: the two are no longer siblings.
    // The desktop value is asserted as `flex` rather than left undefined because that is what
    // the base rule says, and asserting nothing there would let the rule change unnoticed.
    ['phone', '.topbar-lead', 'gap', { 'laptop 1280': '16px' }],
    ['phone', '.topbar-lead', 'display', { 'phone 390 (modern)': 'contents', 'laptop 1280': 'flex' }],
    ['phone', '.topbar > .brand', 'grid-column', { 'phone 390 (modern)': '1', 'laptop 1280': undefined }],

    // The clock stacks on a phone, which is what buys it the width to exist there at all:
    // one line was 162px and the wordmark plus the account menu left less than that at 320px,
    // stacked is 86px. `justify-self: end` is what puts it at the right-hand end of the header
    // rather than merely in the middle column.
    ['phone', '.topbar-clock', 'flex-direction', { 'phone 390 (modern)': 'column', 'laptop 1280': undefined }],
    ['phone', '.topbar-clock', 'justify-self', { 'phone 390 (modern)': 'end', 'laptop 1280': undefined }],

    // The date is the clock's first thing to give up on a narrow *desktop*, and the last on a
    // phone, where it has a cell to itself. 1080px is the cutoff, so it is present at 1280 and
    // gone by 768 -- but restored below 720px, because the navigation that needed the room is
    // gone there too.
    ['phone', '.topbar-clock-date', 'display', { 'laptop 1280': undefined, 'tablet 768': 'none', 'phone 390 (modern)': 'block' }],

    // The nav is gone across the whole phone band, not just the narrow end of it. This is the
    // assertion that catches the auto-placement bug: with the clock in column 2 and the nav
    // present, the nav lands in that same cell, clearing the clock by 0px at 520px.
    ['phone', '.topbar > nav', 'display', { 'phone 390 (modern)': 'none', 'tablet 768': undefined, 'laptop 1280': undefined }],

    // A hidden live indicator must take no room. `.live-indicator { display: inline-flex }` beat
    // the `hidden` attribute's UA rule, so a dead 17px band sat under the header on every page
    // in every session state.
    ['phone', '.live-indicator[hidden]', 'display', { 'phone 390 (modern)': 'none', 'laptop 1280': 'none' }],

    // The footer's link groups were laid out as a left-aligned wrapped flex row while the brand
    // and the copyright above them were centred. `.site-footer nav { display: flex }` beat
    // `.site-footer-group { display: grid }` on specificity -- a class plus a type beats a class
    // -- so `justify-items` was silently inert. Both halves are pinned: the group has to be a grid,
    // and it has to set its own alignment.
    //
    // Asserted on `.site-footer .site-footer-group`, which is the selector that now has to win.
    // Asserting the bare class would keep passing while the stylesheet was wrong, because
    // `resolve()` reads only rules whose selector string matches exactly -- and the reason this
    // shipped broken is precisely that the winning rule was a different string. The cross-
    // examination below is what sees the `.site-footer nav` competitor; this is what proves the
    // fix landed.
    //
    // The alignment itself is `start`, not `center`. The footer is a map of the site now -- brand
    // on the left, three labelled link columns beside it -- and a map has a top-left corner.
    // Centring each group's links inside a column that is itself centred in the footer stacked
    // them under a centred heading with no shared axis, which is what the columns replaced.
    ['phone', '.site-footer .site-footer-group', 'display', { 'phone 390 (modern)': 'grid', 'laptop 1280': 'grid' }],
    ['phone', '.site-footer .site-footer-group', 'justify-items', { 'phone 390 (modern)': 'start', 'laptop 1280': 'start' }],

    // The footer is four tracks on a desktop, two groups side by side below it, and one column only
    // below 360px. The phone expectation is two tracks, not one: a single column there is a stack
    // of twelve full-width rows -- four screens of footer -- for a reader who wanted the cookie
    // policy. The 360px floor is measured, not guessed: it is where "Frequently asked" stops
    // fitting two lines in a column.
    ['phone', '.site-footer', 'grid-template-columns', { 'phone 390 (modern)': 'repeat(2, minmax(0, 1fr))', 'laptop 1280': 'minmax(0, 1.6fr) repeat(3, minmax(0, 1fr))' }],

    // Below 900px the brand takes its own row across the full width, and the legal group does the
    // same at the bottom with its links in one wrapping row. Both facts are load-bearing: the
    // brand has to span or it occupies the first cell of a two-column grid and pushes the groups
    // down by its own height while looking like a fourth link list.
    //
    // Both stay `1 / -1` all the way down. At 560px and below the grid is a single column, where
    // `1 / -1` and `auto` place the group identically -- so the legal group is asserted to span at
    // the phone too, rather than asserted to `auto` and then quietly overridden by the phone
    // block further down the stylesheet. A rule that never wins is not a rule.
    ['tablet', '.site-footer-brand', 'grid-column', { 'phone 390 (modern)': '1 / -1', 'tablet 768': '1 / -1' }],
    ['tablet', '.site-footer .site-footer-group-legal', 'grid-column', { 'phone 390 (modern)': '1 / -1', 'tablet 768': '1 / -1' }],

    // Three separate ways the account page pushed its content sideways on a 320px screen.
    //
    // A grid column with no explicit template is an implicit `auto` column, which sizes to its
    // content's max-content width. Every settings card then became as wide as the longest
    // unbreakable string inside it and the page scrolled 46px sideways.
    ['phone', '.account-settings-grid', 'grid-template-columns', { 'phone 390 (modern)': 'minmax(0, 1fr)', 'laptop 1280': 'minmax(0, 1fr)' }],
    // `.account-balance-block` is a column flex with `align-items: center`, so its items are
    // sized to their own content. A `nowrap` greeting holding a long display name therefore
    // built a box wider than the card, and the `overflow: hidden` had nothing to clip against.
    ['phone', '.account-greeting', 'max-width', { 'phone 390 (modern)': '100%', 'laptop 1280': '100%' }],
    // "Copy account reference" measured 171px and the card is 272px at 320, so the pair needed
    // 352px and could not share a line at any width the phone actually has.
    ['phone', '.profile-actions', 'flex-wrap', { 'phone 390 (modern)': 'wrap', 'laptop 1280': 'wrap' }],
    ['phone', '.catalog-toolbar', 'position', { 'laptop 1280': 'sticky', 'phone 390 (modern)': 'static' }],
    ['phone', '.balance-block', 'text-align', { 'phone 390 (modern)': 'right', 'laptop 1280': undefined }],
    ['phone', '.home-stats', 'grid-template-columns', { 'phone 390 (modern)': 'minmax(0, 1fr)', 'tablet 768': 'repeat(2, minmax(0, 1fr))' }],
    ['phone', '.catalog-heading', 'grid-template-columns', { 'tablet 768': 'minmax(0, 1fr)', 'laptop 1280': 'minmax(0, 1fr) auto' }],
    ['phone', '.demo-panel', 'padding', { 'phone 390 (modern)': 'clamp(24px, 4vw, 36px)', 'laptop 1280': 'clamp(24px, 4vw, 36px)' }],
    ['phone', '.offer-card', 'padding', { 'phone 430 (large)': '16px', 'laptop 1280': '20px' }],
    // A narrow window on a desktop still gets the stacked layout, but keeps a cursor,
    // so it is not treated as a touch device for the touch-target rules.
    ['narrow desktop', '.offer-grid', 'grid-template-columns', { 'narrow desktop window 700 (mouse)': 'minmax(0, 1fr)', 'laptop 1280': 'repeat(3, minmax(0, 1fr))' }],

    // A full-width button is the only place a label is allowed to wrap. The base button is
    // `nowrap` so a short inline button never breaks mid-word, but the primary actions carry
    // labels the script sets -- "Generate crypto payment address" is wider than a 320px phone
    // once the dialog and button padding are taken off, and it was being clipped at the edge.
    // Asserted at the smallest supported width, which is where it actually broke.
    ['phone', '.button-wide', 'white-space', { 'phone 320 (small)': 'normal', 'laptop 1280': 'normal' }],
    ['phone', '.button-wide', 'width', { 'phone 320 (small)': '100%', 'laptop 1280': '100%' }],

    // The survey's Back and Next share one row rather than stacking, because stacking pushes
    // the primary control below the fold on a short phone.
    ['phone', '.demo-actions', 'display', { 'phone 390 (modern)': 'flex', 'laptop 1280': 'flex' }],

    // "How it works" collapses to one column on a phone and widens as space allows, with no
    // breakpoints of its own. `auto-fit` with a 240px floor is the whole mechanism: two
    // columns need 480px plus the gap, so a 390px phone gets one column and a 1280px desktop
    // gets three, from a single declaration. Hardcoding a column count here would need a rule
    // per viewport and would still be wrong at the widths between them.
    ['phone', '.home-step-list', 'grid-template-columns', {
        'phone 320 (small)': 'repeat(auto-fit, minmax(240px, 1fr))',
        'phone 390 (modern)': 'repeat(auto-fit, minmax(240px, 1fr))',
        'laptop 1280': 'repeat(auto-fit, minmax(240px, 1fr))'
    }],

    // The offer card's type badge and partner name share one wrapping row, so a long network
    // name cannot push the badge off the line.
    ['phone', '.offer-card-top', 'flex-wrap', { 'phone 390 (modern)': 'wrap', 'laptop 1280': 'wrap' }]
];

let problems = 0;
for (const [label, selector, property, expectationsForViewports] of expectations) {
    for (const [viewportName, expected] of Object.entries(expectationsForViewports)) {
        const environment = viewports[viewportName];
        const resolved = resolve(rules, selector, environment);
        const actual = resolved.get(property);
        const actualValue = actual ? actual.value : undefined;

        // A rule only needs to "win" if one exists; undefined means no declaration
        // applies, which is the correct outcome for a desktop-only property.
        const matches = actualValue === expected;
        if (!matches) problems += 1;
        const mediaLabel = actual && actual.media.length ? actual.media.join(' and ') : 'no media query';
        console.log(
            `${matches ? 'PASS' : 'FAIL'}  ${label.padEnd(6)} ${selector.padEnd(18)} ${property.padEnd(22)} ` +
            `@${viewportName.padEnd(36)} = ${JSON.stringify(actualValue)}` +
            (matches ? '' : ` (expected ${JSON.stringify(expected)}) [${mediaLabel}]`)
        );

        // Only cross-examine where there is a declaration to cross-examine. `undefined` means
        // nothing applies, and a competing rule setting the same property would have been the
        // reason the expected value is absent -- which the assertion above already reports.
        if (actual && actualValue === expected) {
            const competitors = competingRules(rules, selector, property, environment, actual);
            if (competitors.length) {
                competitionProblems += 1;
                console.log(
                    `FAIL  ${label.padEnd(6)} ${selector.padEnd(18)} ${property.padEnd(22)} ` +
                    `@${viewportName.padEnd(36)} shadowed by ${competitors.join('; ')}`
                );
            }
        }
    }
}

if (competitionProblems === 0) {
    console.log('\nNo asserted value is outranked by a rule naming the same class.');
}

console.log(problems === 0 && competitionProblems === 0
    ? '\nCASCADE CHECKS PASSED'
    : `\n${problems + competitionProblems} CASCADE PROBLEM(S)`);
process.exit(problems === 0 && competitionProblems === 0 ? 0 : 1);
