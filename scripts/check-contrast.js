/**
 * Contrast audit for the design tokens in public/style.css.
 *
 * Text that fails WCAG AA is unreadable in practice, and a design token that
 * fails is a silent regression: nothing in the build complains, it just looks
 * wrong. This walks the token block, resolves the light and dark values, and
 * reports every foreground/background pair the stylesheet actually uses.
 */

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const AA_NORMAL = 4.5;
// Large text (>=18.66px bold or >=24px) is allowed a lower ratio. Kept because
// the money dialogs use 24px headings and 28px balance totals, and those are
// the pairs a future edit is most likely to break.
const AA_LARGE = 3.0;

/**
 * The alpha values the stylesheet applies to white text over the brand ramp.
 * Kept in one place so a CSS change that is not mirrored here is visible in a
 * single list rather than scattered across the pairs table.
 */
const HEADER_TEXT_ALPHAS = [
    { label: 'white', alpha: 1 },
    { label: 'white @0.85 (balance-label)', alpha: 0.85 },
    { label: 'white @0.82 (brand-light)', alpha: 0.82 },
    { label: 'white @0.78 (demo-balance)', alpha: 0.78 }
];

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the first balanced-brace block matched by `regex`.
 *
 * The regex must consume through the opening `{`. Returns null when there is
 * no match, and the caller decides whether that is an error or an empty result.
 */
function extractBlock(text, regex) {
    const match = regex.exec(text);
    if (!match) return null;

    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(open + 1, i);
        }
    }
    return null;
}

/**
 * Finds a selector at a rule boundary.
 *
 * `indexOf('.topbar')` also matches `.topbar-logo`, `.topbar-inner`, and
 * `.topbar:hover`, so the naive lookup reads the wrong rule's body as soon as
 * any of those appears earlier in the file. A selector is only the one being
 * asked for when the characters on both sides of it are not identifier
 * characters, and the next non-space character after it is `{` -- not `:` for
 * a pseudo-class, and not `-` for a compound name.
 */
function findSelector(text, selector) {
    let from = 0;
    while (from <= text.length - selector.length) {
        const at = text.indexOf(selector, from);
        if (at === -1) return -1;

        const before = at === 0 ? '' : text[at - 1];
        const after = text[at + selector.length] || '';
        const okBefore = before === '' || /[\s,}>;]/.test(before);
        const okAfter = after === '' || /[\s,{]/.test(after);
        if (okBefore && okAfter) return at;

        from = at + 1;
    }
    return -1;
}

/** Extracts the body of a rule, matched by balanced braces. */
function readRule(text, selector) {
    const start = findSelector(text, selector);
    if (start === -1) return '';

    const open = text.indexOf('{', start + selector.length - 1);
    if (open === -1) return '';

    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(open + 1, i);
        }
    }
    return '';
}

/**
 * Extracts `--name: value;` declarations from a block of CSS text.
 *
 * Tolerant of whitespace around the brace: `:root {`, `:root{`, and a newline
 * before the brace all match. Requiring the exact form `:root {` silently
 * returns an empty token map for a stylesheet that happens to be formatted
 * without the space, which then reads as every token being missing.
 */
function readBlock(text, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = extractBlock(text, new RegExp(`${escaped}\\s*\\{`));
    if (body === null) throw new Error(`Could not find ${label} in the stylesheet`);

    const tokens = {};
    for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        tokens[m[1]] = m[2].trim();
    }
    return tokens;
}

const light = readBlock(css, ':root');

/**
 * The dark block lives inside `@media (prefers-color-scheme: dark) { ... }`,
 * and it cannot be read from the whole stylesheet because the first `:root` is
 * the light one. The media query body is sliced out first, then its `:root` is
 * read from that.
 */
const DARK_MEDIA_RE = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/;

function readDarkTokens(text) {
    const body = extractBlock(text, DARK_MEDIA_RE);
    if (body === null) return {};
    return readBlock(body, ':root');
}

function darkBlockBody(text) {
    return extractBlock(text, DARK_MEDIA_RE) ?? '';
}

const dark = readDarkTokens(css);

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

/** Parses `#rgb` or `#rrggbb`. Returns null for anything else, rather than NaN. */
function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    const value = hex.trim().replace(/^#/, '');
    const full = value.length === 3
        ? value.split('').map((c) => c + c).join('')
        : value;
    if (!/^[\da-f]{6}$/i.test(full)) return null;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16)
    ];
}

/** WCAG 2.1 relative luminance. Returns null when the input is not a hex colour. */
function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, or null when either side is not a hex colour. */
function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (la === null || lb === null) return null;
    const [high, low] = la > lb ? [la, lb] : [lb, la];
    return (high + 0.05) / (low + 0.05);
}

/**
 * Blends a foreground colour at the given alpha over a background. Both
 * arguments must be hex. Returns null otherwise, so a bad token surfaces as
 * a `??` line rather than as a `NaN:1` in the report.
 */
function over(fg, alpha, bg) {
    const f = hexToRgb(fg);
    const b = hexToRgb(bg);
    if (!f || !b) return null;
    const blend = f.map((c, i) => Math.round(alpha * c + (1 - alpha) * b[i]));
    return `#${blend.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// The pairs the stylesheet actually renders
// ---------------------------------------------------------------------------

/**
 * Each pair is one foreground/background combination the CSS renders. The
 * `large` flag opts a pair into the large-text threshold; it is set only for
 * text the stylesheet sizes at 24px or above (or 18.66px bold). If you change
 * a font size in the stylesheet, change the flag here too -- the audit cannot
 * read font sizes.
 */
const PAIRS = [
    // Body copy
    { fg: 'ink', bg: 'paper', where: 'body copy on the page' },
    { fg: 'ink', bg: 'surface', where: 'body copy on a card' },
    { fg: 'ink', bg: 'surface-2', where: 'body copy on a sunken panel' },
    { fg: 'ink', bg: 'indigo-050', where: 'receipt lead line' },

    // Secondary copy
    { fg: 'ink-soft', bg: 'paper', where: 'secondary copy' },
    { fg: 'ink-soft', bg: 'surface', where: 'secondary copy on a card' },

    // Muted hints
    { fg: 'muted', bg: 'paper', where: 'muted hints' },
    { fg: 'muted', bg: 'surface', where: 'muted hints on a card' },
    { fg: 'muted', bg: 'surface-2', where: 'fine print and disabled preset button' },
    { fg: 'muted', bg: 'indigo-050', where: 'receipt metadata and balance label' },

    // Placeholders
    { fg: 'faint', bg: 'paper', where: 'placeholders and de-emphasised text' },
    { fg: 'faint', bg: 'surface', where: 'placeholders on a card' },

    // Headings
    { fg: 'heading', bg: 'paper', where: 'headings and labels' },
    { fg: 'heading', bg: 'surface', where: 'headings and labels on a card' },
    { fg: 'heading', bg: 'surface-2', where: 'headings and labels on a sunken panel' },
    { fg: 'heading', bg: 'indigo-100', where: 'checked option label' },
    { fg: 'heading', bg: 'indigo-050', where: 'receipt heading and balance total', large: true },

    // Links and reward amounts
    { fg: 'accent', bg: 'paper', where: 'links, eyebrows, reward amounts' },
    { fg: 'accent', bg: 'surface', where: 'links and reward amounts on a card' },
    { fg: 'accent', bg: 'surface-2', where: 'links on a sunken panel' },
    { fg: 'accent', bg: 'indigo-050', where: 'link on a ghost-button hover' },

    // Semantic
    { fg: 'success', bg: 'success-bg', where: 'confirmation tick and success text' },
    { fg: 'warning', bg: 'warning-bg', where: 'warning text' },
    { fg: 'danger', bg: 'danger-bg', where: 'error text' },
    { fg: 'danger', bg: 'surface', where: 'error text on a card' }
];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function report(where, ratio, required = AA_NORMAL) {
    checks += 1;
    if (ratio === null) {
        console.log(`  ??    ???  ${where}  (token missing or not a hex colour)`);
        failures += 1;
        return;
    }
    const pass = ratio >= required;
    if (!pass) failures += 1;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1  ${where}`);
}

/**
 * The effective dark palette is the light one with the dark block layered over
 * it, because the dark block only overrides some tokens. A token that is not
 * overridden in dark mode is still the light value and is what the browser
 * actually renders.
 */
const palettes = {
    light,
    dark: { ...light, ...dark }
};

/** Reads the `var(--token)` references out of the `.topbar` gradient. */
function topbarGradientStops(scope) {
    return [...new Set(
        readRule(scope, '.topbar')
            .split(';')
            .filter((declaration) => declaration.includes('linear-gradient'))
            .flatMap((declaration) =>
                [...declaration.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])
            )
    )];
}

for (const [mode, tokens] of Object.entries(palettes)) {
    console.log(`\n=== ${mode} ===`);

    for (const pair of PAIRS) {
        const fg = tokens[pair.fg];
        const bg = tokens[pair.bg];
        if (!fg || !bg) {
            report(`${pair.fg} on ${pair.bg}  (${pair.where})`, null);
            continue;
        }
        const required = pair.large ? AA_LARGE : AA_NORMAL;
        report(`${pair.fg} on ${pair.bg}  (${pair.where})`, contrast(fg, bg), required);
    }

    // The header is white text over a gradient, so the worst case is the
    // lightest stop the gradient actually reaches. Those stops are read out of
    // the stylesheet rather than hardcoded, so changing the gradient changes
    // what is verified instead of leaving a stale colour under test.
    //
    // In dark mode the search scope is the media block, so the lookup finds
    // the dark .topbar rule rather than the light one. If the dark block has
    // no .topbar rule at all, the light gradient is what renders and that is
    // what the audit falls back to.
    const scope = mode === 'light' ? css : darkBlockBody(css);
    const stops = topbarGradientStops(scope).length > 0
        ? topbarGradientStops(scope)
        : topbarGradientStops(css);

    if (stops.length === 0) {
        console.log(`  ??    ???  could not read the ${mode} .topbar gradient stops`);
        failures += 1;
        continue;
    }
    console.log(`  (gradient stops: ${stops.join(', ')})`);

    for (const stop of stops) {
        const bg = tokens[stop];
        if (!bg) {
            report(`white on ${stop} (token missing)`, null);
            continue;
        }
        for (const { label, alpha } of HEADER_TEXT_ALPHAS) {
            const fg = alpha === 1 ? '#ffffff' : over('#ffffff', alpha, bg);
            report(`${label} on ${stop}`, contrast(fg, bg));
        }
    }
}

console.log(`\n${checks} pairs checked, ${failures} below WCAG AA (${AA_NORMAL}:1)`);

if (process.argv.includes('--list-tokens')) {
    console.log('\nlight tokens:', JSON.stringify(light, null, 2));
    console.log('\ndark tokens:', JSON.stringify(dark, null, 2));
}

process.exit(failures === 0 ? 0 : 1);