/**
 * Contrast audit for the design tokens in public/style.css.
 *
 * Text that fails WCAG AA is unreadable in practice, and a design token that fails is a
 * silent regression: nothing in the build complains, it just looks wrong. This walks the
 * token block, resolves the light and dark values, and reports every foreground/background
 * pair the stylesheet actually uses.
 */

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/** Extracts the body of a rule, matched by balanced braces rather than by regex. */
function readRule(text, selector) {
    const start = text.indexOf(selector);
    if (start === -1) return '';
    const open = text.indexOf('{', start + selector.length - 1);
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

/** Extracts `--name: value;` declarations from a block of CSS text. */
function readBlock(text, label) {
    const start = text.indexOf(label);
    if (start === -1) throw new Error(`Could not find ${label} in the stylesheet`);
    const open = text.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    const tokens = {};
    const body = text.slice(open, end);
    for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        tokens[match[1]] = match[2].trim();
    }
    return tokens;
}


const light = readBlock(css, ':root {');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark) {');
const dark = readBlock(css.slice(darkStart), ':root {');

function hexToRgb(hex) {
    const value = hex.replace('#', '').trim();
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16)
    ];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [high, low] = la > lb ? [la, lb] : [lb, la];
    return (high + 0.05) / (low + 0.05);
}

/** Blends `alpha` white (or any colour) over `bg`, which is how the header text reads. */
function over(fg, alpha, bg) {
    const f = hexToRgb(fg);
    const b = hexToRgb(bg);
    const blend = f.map((c, i) => Math.round(alpha * c + (1 - alpha) * b[i]));
    return `#${blend.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

// Pairs the stylesheet actually renders. `large` is for text at >=18.66px bold or >=24px.
const PAIRS = [
    { fg: 'ink', bg: 'paper', where: 'body copy on the page' },
    { fg: 'ink', bg: 'surface', where: 'body copy on a card' },
    { fg: 'ink', bg: 'surface-2', where: 'body copy on a sunken panel' },
    { fg: 'ink-soft', bg: 'paper', where: 'secondary copy' },
    { fg: 'ink-soft', bg: 'surface', where: 'secondary copy on a card' },
    { fg: 'muted', bg: 'paper', where: 'muted hints' },
    { fg: 'muted', bg: 'surface', where: 'muted hints on a card' },
    { fg: 'muted', bg: 'surface-2', where: 'muted hints on a sunken panel' },
    { fg: 'faint', bg: 'paper', where: 'placeholders and de-emphasised text' },
    { fg: 'faint', bg: 'surface', where: 'placeholders on a card' },
    // The brand ramp is background-only now (gradient stops, button fills, borders), so
    // the foreground pairs that matter are the two semantic tokens below. Checking the
    // ramp as if it were text is what this audit originally flagged as a false positive.
    { fg: 'heading', bg: 'paper', where: 'headings and labels' },
    { fg: 'heading', bg: 'surface', where: 'headings and labels on a card' },
    { fg: 'heading', bg: 'surface-2', where: 'headings and labels on a sunken panel' },
    { fg: 'heading', bg: 'indigo-100', where: 'checked option label' },
    { fg: 'accent', bg: 'paper', where: 'links, eyebrows, reward amounts' },
    { fg: 'accent', bg: 'surface', where: 'links and reward amounts on a card' },
    { fg: 'accent', bg: 'surface-2', where: 'links on a sunken panel' },
    { fg: 'accent', bg: 'indigo-050', where: 'link on a ghost-button hover' },
    // The money dialogs. The receipt, the balance card and the countdown all sit on the
    // indigo tint or on a sunken panel rather than on a plain surface, so the pairs that
    // were already passing on `surface` say nothing about what is actually rendered there.
    { fg: 'heading', bg: 'indigo-050', where: 'receipt heading and balance total' },
    { fg: 'muted', bg: 'indigo-050', where: 'receipt metadata and balance label' },
    { fg: 'ink', bg: 'indigo-050', where: 'receipt lead line' },
    { fg: 'muted', bg: 'surface-2', where: 'fine print and disabled preset button' },
    { fg: 'ink-soft', bg: 'surface', where: 'confirmation step text' },
    { fg: 'heading', bg: 'surface', where: 'countdown on its own panel' },
    { fg: 'success', bg: 'success-bg', where: 'confirmation tick' },
    { fg: 'success', bg: 'success-bg', where: 'success text' },
    { fg: 'warning', bg: 'warning-bg', where: 'warning text' },
    { fg: 'danger', bg: 'danger-bg', where: 'error text' },
    { fg: 'danger', bg: 'surface', where: 'error text on a card' }
];

let failures = 0;
let checks = 0;

// The dark block only overrides some tokens, so the effective dark palette is the light
// one with the dark block layered over it. Reading only the dark block would treat a token
// the browser still renders from the light palette as missing.
const palettes = { light, dark: { ...light, ...dark } };

for (const [mode, tokens] of Object.entries(palettes)) {
    console.log(`\n=== ${mode} ===`);
    for (const pair of PAIRS) {
        const fg = tokens[pair.fg];
        const bg = tokens[pair.bg];
        if (!fg || !bg || !fg.startsWith('#') || !bg.startsWith('#')) {
            console.log(`  ?? ${pair.fg} on ${pair.bg}: token missing or not a hex value`);
            continue;
        }
        const ratio = contrast(fg, bg);
        checks += 1;
        const pass = ratio >= AA_NORMAL;
        if (!pass) failures += 1;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1  ${pair.fg} on ${pair.bg}  (${pair.where})`);
    }

    // The header is white text over a gradient, so the worst case is the lightest stop the
    // gradient actually reaches. Those stops are read out of the stylesheet rather than
    // hardcoded, so changing the gradient automatically changes what is verified instead
    // of silently leaving a stale colour under test.
    if (mode === 'light') {
        // The .topbar rule is found by balanced braces, not a regex over the whole file:
        // a lazy `[^}]*?` can run past the rule it started in once the file has several
        // .topbar rules in media queries, and picks up tokens from later rules.
        const stops = readRule(css, '.topbar')
            .split(';')
            .filter((declaration) => declaration.includes('linear-gradient'))
            .flatMap((declaration) => [...declaration.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));

        const uniqueStops = [...new Set(stops)];
        if (uniqueStops.length === 0) {
            console.log('  ?? could not read the .topbar gradient stops');
            failures += 1;
        }
        console.log(`  (gradient stops: ${uniqueStops.join(', ')})`);
        for (const stop of uniqueStops) {
            const bg = tokens[stop];
            if (!bg) continue;
            for (const [label, fg] of [
                ['white', '#ffffff'],
                ['white @0.85 (balance-label)', over('#ffffff', 0.85, bg)],
                ['white @0.82 (brand-light)', over('#ffffff', 0.82, bg)],
                ['white @0.78 (demo-balance)', over('#ffffff', 0.78, bg)]
            ]) {
                const ratio = contrast(fg, bg);
                checks += 1;
                const pass = ratio >= AA_NORMAL;
                if (!pass) failures += 1;
                console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1  ${label} on ${stop}`);
            }
        }
    } else {

        // The dark block only overrides some tokens, so the effective dark palette is the
        // light one with the dark block layered on top. A token that is not overridden in
        // dark mode is still the light value, and is what the browser actually renders.
        const darkEffective = tokens;
        for (const end of ['indigo-900', 'indigo-800', 'indigo-700']) {
            const bg = darkEffective[end];
            for (const [label, fg] of [
                ['white', '#ffffff'],
                ['white @0.85 (balance-label)', over('#ffffff', 0.85, bg)],
                ['white @0.82 (brand-light)', over('#ffffff', 0.82, bg)],
                ['white @0.78 (demo-balance)', over('#ffffff', 0.78, bg)]
            ]) {
                const ratio = contrast(fg, bg);
                checks += 1;
                const pass = ratio >= AA_NORMAL;
                if (!pass) failures += 1;
                console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1  ${label} on ${end} (${mode})`);
            }
        }
    }
}

console.log(`\n${checks} pairs checked, ${failures} below WCAG AA (${AA_NORMAL}:1)`);
if (process.argv.includes('--list-tokens')) {
    console.log('\nlight tokens:', JSON.stringify(light, null, 2));
    console.log('\ndark tokens:', JSON.stringify(dark, null, 2));
}
process.exit(failures === 0 ? 0 : 1);
