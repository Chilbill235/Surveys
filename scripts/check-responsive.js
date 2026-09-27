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
    ['phone', '.offer-card', 'grid-template-areas', { 'phone 430 (large)': "'top top' 'title title' 'reward start'", 'laptop 1280': undefined }],
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
    ['phone', '.topbar', 'flex-direction', { 'phone 390 (modern)': 'row', 'laptop 1280': undefined }],
    ['phone', '.catalog-toolbar', 'position', { 'laptop 1280': 'sticky', 'phone 390 (modern)': 'static' }],
    ['phone', '.balance-block', 'text-align', { 'phone 390 (modern)': 'right', 'laptop 1280': undefined }],
    ['phone', '.home-stats', 'grid-template-columns', { 'phone 390 (modern)': 'minmax(0, 1fr)', 'tablet 768': 'repeat(2, minmax(0, 1fr))' }],
    ['phone', '.catalog-heading', 'grid-template-columns', { 'tablet 768': 'minmax(0, 1fr)', 'laptop 1280': 'minmax(0, 1fr) auto' }],
    ['phone', '.demo-panel', 'padding', { 'phone 390 (modern)': 'clamp(24px, 4vw, 36px)', 'laptop 1280': 'clamp(24px, 4vw, 36px)' }],
    ['phone', '.offer-card', 'padding', { 'phone 430 (large)': '16px', 'laptop 1280': '20px' }],
    // A narrow window on a desktop still gets the stacked layout, but keeps a cursor,
    // so it is not treated as a touch device for the touch-target rules.
    ['narrow desktop', '.offer-grid', 'grid-template-columns', { 'narrow desktop window 700 (mouse)': 'minmax(0, 1fr)', 'laptop 1280': 'repeat(3, minmax(0, 1fr))' }]
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
    }
}

console.log(problems === 0 ? '\nCASCADE CHECKS PASSED' : `\n${problems} CASCADE PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
