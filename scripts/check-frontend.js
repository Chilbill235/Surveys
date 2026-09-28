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

const pages = {
    'index.html': 'app.js',
    'home.html': 'home.js',
    'demo.html': 'demo.js',
    'reset-password.html': 'reset-password.js'
};

const css = read('style.css');

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

// ------------------------------------------------- CSP: no inline styles
// The deployed Content-Security-Policy is `style-src 'self'`, which blocks a style
// attribute in markup. CSSOM writes are allowed, so those are checked separately.
for (const htmlFile of Object.keys(pages)) {
    const offenders = [...read(htmlFile).matchAll(/<[^>]+\sstyle="[^"]*"/g)].map((m) => m[0]);
    if (offenders.length) fail(`${htmlFile} has ${offenders.length} inline style attribute(s): ${offenders[0]}`);
}
pass('no HTML file uses a style attribute (CSP style-src self)');

// ------------------------------------------------- script <-> markup ids
for (const [htmlFile, jsFile] of Object.entries(pages)) {
    const html = read(htmlFile);
    const js = read(jsFile);

    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));

    const absent = [...wanted].filter((id) => !htmlIds.has(id));
    if (absent.length) fail(`${jsFile} asks for ids missing from ${htmlFile}: ${absent.join(', ')}`);
    else pass(`${jsFile}: all ${wanted.size} element ids exist in ${htmlFile}`);

    // querySelector results are dereferenced too, so a missing target throws at runtime.
    for (const match of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)\.querySelector/g)) {
        if (!htmlIds.has(match[1])) fail(`${jsFile} dereferences a querySelector on missing id ${match[1]}`);
    }

    const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
    if (duplicates.length) fail(`${htmlFile} has duplicate ids: ${[...new Set(duplicates)].join(', ')}`);
    else pass(`${htmlFile} has no duplicate ids`);
}

// ------------------------------------------------- data-mirror targets
const indexHtml = read('index.html');
for (const match of indexHtml.matchAll(/data-mirror="([^"]+)"/g)) {
    if (!new RegExp(`id="${match[1]}"`).test(indexHtml)) {
        fail(`action bar button mirrors a missing control: ${match[1]}`);
    }
}
pass('every action bar button mirrors an existing header control');

// ------------------------------------------------- labels
for (const htmlFile of Object.keys(pages)) {
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
for (const htmlFile of Object.keys(pages)) {
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
for (const jsFile of Object.values(pages)) {
    const js = read(jsFile);
    for (const match of js.matchAll(/className\s*=\s*'([^']+)'/g)) {
        match[1].split(/\s+/).filter(Boolean).forEach((n) => builtClasses.add(n));
    }
    for (const match of js.matchAll(/classList\.(?:add|toggle)\(\s*'([^']+)'/g)) builtClasses.add(match[1]);
}
const unstyled = [...builtClasses].filter((n) => !cssClasses.has(n) && !n.startsWith('status-'));
if (unstyled.length) fail(`scripts build classes with no CSS rule: ${unstyled.join(', ')}`);
else pass(`all ${builtClasses.size} script-built classes have CSS rules`);

// `is-${variant}` is built dynamically, so the members cannot be read from the source.
// They are the only two variants the helper is called with.
for (const variant of ['error', 'success']) {
    if (!new RegExp(`\\.is-${variant}\\b`).test(css)) fail(`dynamic class is-${variant} has no CSS rule`);
}
if (!/classList\.\w+\(`is-\$\{/.test(read('app.js'))) fail('app.js no longer builds a dynamic is-* class');
pass('dynamically built is-error / is-success classes are styled');

for (const htmlFile of Object.keys(pages)) {
    const used = new Set();
    for (const match of read(htmlFile).matchAll(/\bclass="([^"]+)"/g)) {
        match[1].split(/\s+/).filter(Boolean).forEach((n) => used.add(n));
    }
    const unstyledInHtml = [...used].filter((n) => !cssClasses.has(n));
    if (unstyledInHtml.length) fail(`${htmlFile} uses classes with no CSS rule: ${unstyledInHtml.join(', ')}`);
    else pass(`${htmlFile}: all ${used.size} markup classes have CSS rules`);
}

// ------------------------------------------------- has-action-bar scope
// The fixed action bar only exists on the offers page, so only that page may pad
// the document to clear it.
for (const htmlFile of Object.keys(pages)) {
    const hasClass = /<body[^>]*class="[^"]*has-action-bar/.test(read(htmlFile));
    const hasBar = /class="action-bar"/.test(read(htmlFile));
    if (hasClass !== hasBar) {
        fail(`${htmlFile}: has-action-bar on body is ${hasClass} but the action bar is ${hasBar}`);
    }
}
pass('the has-action-bar body class matches the pages that render the bar');

console.log(problems === 0 ? '\nFRONTEND CHECKS PASSED' : `\n${problems} FRONTEND PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
