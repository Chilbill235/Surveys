const fs = require('fs');
const puppeteer = require('puppeteer-core');

/**
 * Measures the offers-page balance card.
 *
 * The offers page is session-gated, so this needs a signed-in session. Rather than seed money and
 * a login, it reads the card's geometry off a page with the balance values injected directly into
 * the DOM after load -- the layout question ("is this centred, and do the two figures sit on one
 * axis") is answered by the boxes, not by where the numbers came from.
 *
 * What it asserts:
 *   - the label, the real balance and the test-only line share a horizontal centre
 *   - the card has no dead second column hanging off its right edge
 *   - the real balance is the largest thing on the card, and the test-only figure is not competing
 *     with it
 *   - nothing overflows sideways at any width
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const PAGE = process.env.BALANCE_PAGE || '/offers';
const WIDTHS = [1280, 1024, 768, 560, 390, 320];

/**
 * The offers page is behind the session gate, and a signed-in run would need a real account, a
 * real balance and seeded offers -- which makes this a manual check rather than something to put
 * in front of a build.
 *
 * So the navigation is intercepted instead: `/offers` is answered from the file on disk with
 * `session-gate.js` removed, and the balance endpoint is stubbed. Every asset still comes from the
 * running server, so the stylesheet under test is the real one. The layout question -- is this
 * centred, do the two figures share an axis, is the real number the dominant one -- is answered
 * by the boxes, not by where the numbers came from.
 */
function serveOffersWithoutGate(request) {
    const html = fs.readFileSync('public/index.html', 'utf8')
        .replace(/<script src="\/session-gate\.js"[^>]*><\/script>/g, '');
    request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body: html
    });
}

function stubBalance(request) {
    if (!/\/api\/user\/balance/.test(request.url())) return false;
    request.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ balance: 1240.88, demo_balance: 12, currency: 'USD' })
    });
    return true;
}

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

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });

    for (const width of WIDTHS) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (stubBalance(request)) return;
            if (request.url().endsWith(PAGE)) { serveOffersWithoutGate(request); return; }
            request.continue();
        });
        console.log(`\n${PAGE} @ ${width}px`);

        await page.goto(BASE + PAGE, { waitUntil: 'networkidle2' });

        const box = await page.evaluate(() => {
            const card = document.querySelector('.offer-balance-card');
            if (!card) return { missing: true, url: location.pathname };

            // Fill in the two figures so the card is measured as it renders with real content
            // rather than as two em-dashes, which are a third of the width and hide any reflow.
            const set = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = text; };
            set('user-balance', '$1,240.88');
            set('demo-balance', '$12.00');

            const r = (el) => {
                if (!el) return null;
                const b = el.getBoundingClientRect();
                return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, right: b.right };
            };
            const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
            return {
                card: r(card),
                label: r(card.querySelector('.balance-label')),
                main: r(card.querySelector('.offer-balance-main')),
                demo: r(card.querySelector('.demo-balance-line')),
                mainSize: parseFloat(cs(card.querySelector('.offer-balance-main'), 'fontSize')),
                demoSize: parseFloat(cs(card.querySelector('.demo-balance-line strong'), 'fontSize')),
                mainAlign: cs(card, 'textAlign'),
                blockAlign: cs(card.querySelector('.offer-balance-block'), 'alignItems'),
                tracks: getComputedStyle(card).gridTemplateColumns.split(' ').length,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
            };
        });

        if (box.missing) { fail(`no .offer-balance-card (landed on ${box.url})`); await page.close(); continue; }

        console.log(`    tracks=${box.tracks} text-align=${box.mainAlign} block-align=${box.blockAlign}`);
        console.log(`    card centre=${Math.round(box.card.cx)} label centre=${box.label && Math.round(box.label.cx)} main centre=${box.main && Math.round(box.main.cx)} demo centre=${box.demo && Math.round(box.demo.cx)}`);

        if (box.tracks === 1) ok('one column -- no dead track on the right');
        else fail(`${box.tracks} tracks, expected 1`);

        // Everything on the card shares one centre axis, to within a pixel of rounding.
        const centres = [box.label, box.main, box.demo].filter(Boolean).map((b) => Math.round(b.cx));
        const spread = Math.max(...centres) - Math.min(...centres);
        if (spread <= 1) ok(`label, balance and test line share a centre axis (${spread}px)`);
        else fail(`not centred: centres ${centres.join(', ')} spread ${spread}px`);

        // The card's own content is centred, which is what makes the above meaningful.
        if (box.blockAlign === 'center') ok('the block centres its children');
        else fail(`block align-items is "${box.blockAlign}"`);
        if (box.mainAlign === 'center') ok('the card text is centred');
        else fail(`card text-align is "${box.mainAlign}"`);

        // The real balance must dominate the test-only one. If they are the same size, or the test
        // figure is bigger, the two read as two equal numbers and that is the mistake this card
        // most needs to avoid.
        if (box.mainSize > box.demoSize) ok(`real balance ${box.mainSize}px > test-only ${box.demoSize}px`);
        else fail(`test-only figure (${box.demoSize}px) is not smaller than the real balance (${box.mainSize}px)`);

        // The figures must not collide: the test line sits below the balance, not beside it.
        if (box.demo && box.main && box.demo.y >= box.main.y + box.main.h - 1) ok('the test-only line is below the balance');
        else fail('the test-only line overlaps the balance');

        if (box.overflow <= 0) ok('no sideways scroll');
        else fail(`page scrolls ${box.overflow}px sideways`);

        await page.close();
    }

    await browser.close();
    console.log(problems ? `\n${problems} PROBLEM(S)` : '\nbalance card centred at every width');
    process.exit(problems ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });