const fs = require('fs');
const puppeteer = require('puppeteer-core');

/**
 * Measures the rendered footer across the whole width range.
 *
 * A CSS change to a layout is the one kind of change every static check in this repo passes
 * without complaint: the selectors are valid, the classes have rules, the ids resolve, there are
 * no console errors -- and the columns can still not be columns. Only a real layout engine knows
 * how many boxes it made and where they landed.
 *
 * The bands, and why each one is asserted:
 *   > 900px   brand + three groups on one row
 *   361-900   two groups side by side, brand and legal spanning the full width
 *   <= 360px  one column
 *
 * That middle band is the one that was broken and is the reason this exists: a `@media
 * (max-width: 720px)` block further down the file declared its own `display` and
 * `grid-template-columns` on `.site-footer` with `!important`, so across 560-720px the footer was
 * one centred stack while the rules describing two columns sat above it looking correct. No static
 * check compares what a stylesheet says with what a browser does.
 *
 * The band reaches all the way down to 360px on purpose. A single column on a phone is a stack of
 * twelve full-width rows -- four screens of footer -- for a reader who wanted the cookie policy.
 * 360px is measured, not guessed: it is where "Frequently asked" stops fitting two lines.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Public pages only. `/offers` and `/account` are session-gated and redirect when signed out, so
// measuring them here would measure the login page.
const PAGES = ['/', '/terms', '/cookies'];
const WIDTHS = [1280, 1000, 900, 768, 700, 640, 560, 480, 390, 320];

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const executablePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!executablePath) { console.log('no local Chrome or Edge found -- set CHROME_PATH'); process.exit(2); }

let problems = 0;
const fail = (m) => { problems++; console.log(`    FAIL ${m}`); };
const ok = (m) => console.log(`    ok   ${m}`);

const band = (w) => (w > 900 ? 'wide' : w > 360 ? 'two-up' : 'single');

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });

    for (const width of WIDTHS) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        let first = true;
        for (const route of PAGES) {
            await page.goto(BASE + route, { waitUntil: 'networkidle2' });
            if (first) { console.log(`\n${route} @ ${width}px (${band(width)})`); first = false; }

            const box = await page.evaluate(() => {
                const footer = document.querySelector('.site-footer');
                if (!footer) return null;
                const rect = (el) => {
                    const r = el.getBoundingClientRect();
                    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                };
                const brand = footer.querySelector('.site-footer-brand');
                const groups = [...footer.querySelectorAll('.site-footer-group')].map((g) => ({
                    name: g.getAttribute('aria-label'),
                    ...rect(g),
                    column: getComputedStyle(g).gridColumnStart,
                    links: [...g.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), ...rect(a) }))
                }));
                return {
                    columns: getComputedStyle(footer).gridTemplateColumns.split(' ').length,
                    brand: { ...rect(brand), column: getComputedStyle(brand).gridColumnStart },
                    groups,
                    // The number of link rows the tallest group needs, i.e. how tall the footer is
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    headings: [...footer.querySelectorAll('.site-footer-heading')].map((h) => h.textContent.trim())
                };
            });

            if (!box) { fail(`${route}: no .site-footer`); continue; }
            const sameRow = (a, b) => Math.abs(a.y - b.y) < 4;

            if (band(width) === 'wide') {
                if (box.groups.every((g) => sameRow(g, box.groups[0]))) ok('three groups on one row');
                else fail(`groups not on one row: ${box.groups.map((g) => `${g.name}@${g.x},${g.y}`).join(' | ')}`);
                if (sameRow(box.brand, box.groups[0]) && box.brand.x < box.groups[0].x) ok('brand left of the groups');
                else fail(`brand x=${box.brand.x} y=${box.brand.y} not left of groups x=${box.groups[0].x}`);
                if (box.columns === 4) ok('four tracks');
                else fail(`${box.columns} tracks, expected 4`);
            } else if (band(width) === 'two-up') {
                const [a, b, legal] = box.groups;
                if (a && b && sameRow(a, b) && b.x > a.x) ok('Menu and Help side by side');
                else fail(`Menu and Help not side by side: ${a && `${a.x},${a.y}`} / ${b && `${b.x},${b.y}`}`);
                if (legal && sameRow(legal, a) === false && legal.x <= a.x) ok('Legal spans the full width below');
                else fail(`Legal is not spanning: ${legal && `${legal.x},${legal.y}`}`);
                if (box.columns === 2) ok('two tracks');
                else fail(`${box.columns} tracks, expected 2`);
                if (box.brand.x <= a.x) ok('brand spans the full width above');
                else fail(`brand x=${box.brand.x} vs first group x=${a.x}`);
            } else {
                const stacked = box.groups.every((g, i) => i === 0 || g.y > box.groups[i - 1].y);
                if (stacked) ok('groups stacked in DOM order');
                else fail(`groups not stacked: ${box.groups.map((g) => `${g.name}@${g.x},${g.y}`).join(' | ')}`);
                if (box.columns === 1) ok('one track');
                else fail(`${box.columns} tracks, expected 1`);
            }

            // Every group keeps its heading and all four links, at every width. A layout change
            // that achieves its columns by hiding something has not fixed anything.
            if (box.headings.length === 3) ok('three group headings');
            else fail(`headings: ${box.headings.join(', ')}`);
            const linkCount = box.groups.map((g) => g.links.length);
            if (linkCount.every((n) => n >= 4)) ok('every group kept its links');
            else fail(`link counts: ${linkCount.join(', ')}`);

            const zero = box.groups.flatMap((g) => g.links).filter((l) => l.w < 8 || l.h < 8);
            if (zero.length === 0) ok('every footer link has a hit area');
            else fail(`links with no size: ${zero.map((l) => l.text).join(', ')}`);

            if (box.overflow > 0) fail(`page scrolls ${box.overflow}px sideways`);
            else ok('no sideways scroll');
        }

        if (errors.length) fail(`page errors: ${errors.join('; ')}`);
        else ok('no page errors');

        // The two dialog triggers, once per width.
        await page.goto(`${BASE}/terms`, { waitUntil: 'networkidle2' });
        for (const [sel, id] of [['[data-helpdesk-trigger]', 'helpdesk-dialog'], ['[data-contact-trigger]', 'contact-dialog']]) {
            const result = await page.evaluate(async (s, dialogId) => {
                const t = document.querySelector(s);
                if (!t) return 'no trigger';
                t.click();
                await new Promise((r) => setTimeout(r, 350));
                const d = document.getElementById(dialogId);
                if (d && d.open) { d.close(); return 'opened'; }
                return 'did not open';
            }, sel, id);
            if (result === 'opened') ok(`${sel} opens #${id}`);
            else fail(`${sel} ${result}`);
        }

        await page.close();
    }

    await browser.close();
    console.log(problems ? `\n${problems} PROBLEM(S)` : '\nfooter layout verified at every width');
    process.exit(problems ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });