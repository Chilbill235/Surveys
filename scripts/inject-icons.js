const fs = require('node:fs');
const path = require('node:path');

/**
 * Inserts the icon and manifest links into every page's head.
 *
 * Five separate HTML files each need the same seven lines, and the set has to stay in step
 * across all of them: a page that links the favicon but not the manifest, or that references
 * an icon file that was renamed, is a bug nobody notices until a tab looks wrong on one
 * route only. Generating the block from one place keeps them identical.
 *
 * The stylesheet link is the anchor, because every page has exactly one and it is the last
 * stylesheet the document loads.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ICON_LINKS = [
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">',
    '<link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">'
].join('\n');

let changed = 0;

for (const name of fs.readdirSync(PUBLIC_DIR).filter((file) => file.endsWith('.html'))) {
    const file = path.join(PUBLIC_DIR, name);
    const original = fs.readFileSync(file, 'utf8');

    // Idempotent: re-running must not stack a second copy of the block.
    if (original.includes('rel="manifest"')) {
        console.log(`skip  public/${name} (already linked)`);
        continue;
    }

    const anchor = original.match(/^[ \t]*<link rel="stylesheet" href="\/style\.css">[ \t]*$/m);
    if (!anchor) {
        console.error(`WARN  public/${name}: no stylesheet link to anchor against`);
        continue;
    }

    const updated = original.replace(anchor[0], `${anchor[0]}\n${ICON_LINKS}`);
    fs.writeFileSync(file, updated);
    console.log(`ok    public/${name}`);
    changed += 1;
}

console.log(`\n${changed} page(s) updated`);
