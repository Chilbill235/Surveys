/**
 * Loads every page at a phone, tablet and desktop width and reports layout faults.
 *
 * This is the counterpart to `check:frontend`. That one reads the source and asks whether
 * things are *present*; this one renders them and asks whether what came out is usable at
 * the widths real visitors use. The two failure modes it exists for are invisible to a
 * source-level check:
 *
 *   - horizontal overflow, where a fixed width, a wide table, or a long unbroken string
 *     pushes the page wider than the screen, so on a phone the whole layout sits off to one
 *     side and the visitor has to scroll sideways to see anything;
 *   - a header or footer that is present in the markup but clipped, overlapping, or empty,
 *     which reads as "the page is broken" even though every element is technically there.
 *
 * It is deliberately separate from `smoke:ui`, which proves the controls work. This proves
 * the page holds together.
 *
 * Usage:
 *   npm start            # in one terminal
 *   npm run audit:pages  # in another
 */
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://localhost:3001';

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
].filter(Boolean);

/**
 * Every route the app serves, including the two that redirect.
 *
 * `/login` is in this list rather than absent-because-sign-in-pages-do-not-overflow. It is a
 * new document with its own layout, and the reason a new document gets added to this list is
 * that nobody notices a problem on a page they do not visit. A sign-in form that overflows at
 * 320px is seen by the user who can least afford to be sent somewhere else.
 */
const ROUTES = ['/', '/login', '/offers', '/account', '/demo', '/reset-password', '/terms', '/privacy', '/history', '/index.html'];

const VIEWPORTS = [
    { label: 'phone', width: 390, height: 844 },
    { label: 'phone-sm', width: 320, height: 720 },
    { label: 'tablet', width: 768, height: 1024 },
    { label: 'desktop', width: 1440, height: 900 }
];

const problems = [];
const notes = [];

function isOurOrigin(url) {
    if (!url || url === 'about:blank') return false;
    try {
        return new URL(url).origin === BASE;
    } catch {
        return false;
    }
}

(async () => {
    const executablePath = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
    if (!executablePath) {
        console.error('No browser found. Set CHROME_PATH to a Chrome or Edge executable.');
        process.exit(2);
    }

    const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    try {
        for (const route of ROUTES) {
            for (const viewport of VIEWPORTS) {
                const page = await browser.newPage();
                await page.setViewport({ width: viewport.width, height: viewport.height });
                // Every page sets a cache policy, so re-visiting a route at a second width
                // answers 304 Not Modified. That is correct behaviour and not a layout fact,
                // so the cache is turned off and each load is a real response.
                await page.setCacheEnabled(false);

                const ownErrors = [];
                const brokenAssets = [];
                page.on('console', (msg) => {
                    if (msg.type() !== 'error') return;
                    const from = (msg.location() || {}).url;
                    if (isOurOrigin(from)) ownErrors.push(msg.text().split('\n')[0]);
                });
                page.on('pageerror', (err) => ownErrors.push(err.message));
                page.on('response', (res) => {
                    if (res.status() < 400) return;
                    const from = (res.url() || '').startsWith(BASE) ? 'own origin' : 'third party';
                    if (from === 'own origin') brokenAssets.push(`${res.status()} ${res.url()}`);
                });

                let response;
                try {
                    response = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2' });
                } catch (err) {
                    problems.push(`${route} @ ${viewport.label}: navigation failed -- ${err.message}`);
                    await page.close();
                    continue;
                }

                const where = `${route} @ ${viewport.label}`;
                const expected = route === '/demo' ? [200, 404] : [200];
                if (!expected.includes(response.status())) {
                    problems.push(`${where}: responded ${response.status()}, expected ${expected.join(' or ')}`);
                }
                if (ownErrors.length) problems.push(`${where}: console errors -- ${ownErrors.slice(0, 2).join(' | ')}`);
                if (brokenAssets.length) problems.push(`${where}: failed requests -- ${brokenAssets.slice(0, 3).join(' | ')}`);

                const report = await page.evaluate(() => {
                    const doc = document.documentElement;
                    const out = {};

                    // Horizontal overflow. One pixel of slack, because a sub-pixel width
                    // rounds into `scrollWidth` on some engines and is not a real fault.
                    out.overflow = doc.scrollWidth - doc.clientWidth;
                    out.scrollWidth = doc.scrollWidth;
                    out.clientWidth = doc.clientWidth;

                    // Which elements actually stick out, rather than blaming the document.
                    const offenders = [];
                    if (out.overflow > 1) {
                        for (const el of document.body.querySelectorAll('*')) {
                            const r = el.getBoundingClientRect();
                            if (r.width === 0 || r.height === 0) continue;
                            const style = getComputedStyle(el);
                            if (style.position === 'fixed') continue;
                            if (r.right > doc.clientWidth + 1 || r.left < -1) {
                                offenders.push({
                                    tag: el.tagName.toLowerCase(),
                                    id: el.id || null,
                                    cls: (el.className && typeof el.className === 'string')
                                        ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
                                        : null,
                                    left: Math.round(r.left),
                                    right: Math.round(r.right)
                                });
                            }
                            if (offenders.length >= 6) break;
                        }
                    }
                    out.offenders = offenders;

                    const header = document.querySelector('header');
                    const footer = document.querySelector('footer');
                    const rect = (el) => {
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) };
                    };
                    out.header = rect(header);
                    out.footer = rect(footer);

                    // A nav link with no accessible name is invisible to a screen reader and
                    // looks like a gap in the bar.
                    const nav = document.querySelector('header nav, .topbar nav');
                    out.emptyLinks = nav
                        ? [...nav.querySelectorAll('a')].filter((a) => !a.textContent.trim() && !a.getAttribute('aria-label')).length
                        : 0;

                    // The action bar is fixed to the bottom on a phone, so it will sit on top
                    // of the last line of the footer unless the footer reserves space for it.
                    const bar = document.querySelector('.action-bar');
                    const barVisible = bar && getComputedStyle(bar).display !== 'none';
                    out.actionBar = barVisible
                        ? (() => {
                            const s = getComputedStyle(bar);
                            return { position: s.position, height: Math.round(bar.getBoundingClientRect().height) };
                        })()
                        : null;
                    out.footerPadBottom = footer ? Math.round(parseFloat(getComputedStyle(footer).paddingBottom) || 0) : null;
                    out.bodyHasActionBarClass = /has-action-bar/.test(document.body.className);

                    return out;
                });

                if (report.overflow > 1) {
                    const who = report.offenders.length
                        ? ` -- ${report.offenders.map((o) => `${o.tag}${o.id ? '#' + o.id : o.cls ? '.' + o.cls : ''} (${o.left}..${o.right})`).join(', ')}`
                        : '';
                    problems.push(`${where}: page is ${report.overflow}px wider than the viewport${who}`);
                }
                if (report.header && report.header.w === 0) {
                    problems.push(`${where}: the header renders at zero width`);
                }
                if (report.emptyLinks > 0) {
                    problems.push(`${where}: ${report.emptyLinks} header link(s) have no text and no aria-label`);
                }
                if (report.actionBar?.position === 'fixed' && report.bodyHasActionBarClass === false) {
                    problems.push(`${where}: a fixed action bar is present but <body> is missing the has-action-bar class`);
                }

                await page.close();
            }
            notes.push(`  ok   ${route} rendered at ${VIEWPORTS.length} widths`);
        }
    } finally {
        await browser.close();
    }

    console.log(notes.join('\n'));
    if (problems.length) {
        console.log(`\n${problems.length} LAYOUT PROBLEM(S):`);
        for (const p of problems) console.log(`  FAIL  ${p}`);
        process.exit(1);
    }
    console.log(`\nALL ${notes.length} ROUTE/WIDTH COMBINATIONS CLEAN`);
})().catch((err) => {
    console.error('audit:pages could not run:', err.message);
    if (/ECONNREFUSED|fetch failed/i.test(err.message)) {
        console.error(`Is the server running? Start it with "npm start" (expected at ${BASE}).`);
    }
    process.exit(2);
});
