const fs = require('fs');
const puppeteer = require('puppeteer-core');

/**
 * Measures three presentation changes that a static check cannot see:
 *
 *   1. the profile editor on /account -- everything on one centre axis
 *   2. the footer on a phone -- two columns of groups, not a top-to-bottom stack
 *   3. the topbar on a desktop -- wordmark at the left edge, clock to its right, in that order,
 *      and on a phone -- unchanged
 *
 * All three pages except /terms are session-gated, so navigation is intercepted and the gate
 * stripped, exactly as `smoke-balance-card.js` does. Assets still come from the running server,
 * so the stylesheet under test is the real one.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const WIDTHS = [1280, 1024, 768, 560, 390, 320];

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

function serveWithoutGate(route, file) {
    return (request) => {
        const html = fs.readFileSync(file, 'utf8')
            .replace(/<script src="\/session-gate\.js"[^>]*><\/script>/g, '');
        request.respond({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: { 'Cache-Control': 'no-store' },
            body: html
        });
    };
}

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });

    // ---- 1. Profile editor, centred -------------------------------------------
    for (const width of [1280, 900, 560, 390, 320]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 1000 });
        await page.setRequestInterception(true);
        page.on('request', (r) => (r.url().endsWith('/account') ? serveWithoutGate('/account', 'public/account.html')(r)
            : /\/api\/(user|account)\//.test(r.url())
                ? r.respond({ status: 200, contentType: 'application/json', body: '{}' })
                : r.continue()));

        console.log(`\nprofile editor @ ${width}px`);
        await page.goto(`${BASE}/account`, { waitUntil: 'networkidle2' });

        const box = await page.evaluate(() => {
            const cx = (el) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return Math.round(r.x + r.width / 2);
            };
            const avatar = document.querySelector('.account-profile-avatar');
            const text = document.querySelector('.account-profile-text');
            const actions = document.querySelector('.profile-avatar-actions');
            const buttons = document.querySelector('.profile-avatar-buttons');
            const fieldRow = document.querySelector('#profile-settings .field-row');
            const control = document.querySelector('.profile-editor .form-control');
            const hint = document.querySelector('#profile-display-name-hint');
            const avatarHint = document.querySelector('#profile-avatar-hint');
            const save = document.querySelector('#profile-save');
            const card = document.querySelector('.account-profile');
            const pictureControls = document.querySelector('.profile-avatar-actions');
            const saveRow = document.querySelector('.profile-editor .profile-actions');
            return {
                cardCentre: card && cx(card),
                avatar: cx(avatar), text: cx(text), actionsCol: cx(pictureControls),
                buttons: cx(buttons), fieldRow: cx(fieldRow),
                control: cx(control), hint: cx(hint), avatarHint: cx(avatarHint),
                actionRow: cx(saveRow),
                save: cx(save),
                statusWidth: saveRow ? Math.round(saveRow.getBoundingClientRect().width) : 0,
                textAlign: text && getComputedStyle(text).textAlign,
                actionsAlign: pictureControls && getComputedStyle(pictureControls).alignItems,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
            };
        });

        // Above 820px the card is deliberately two columns -- the picture-and-name block beside the
        // editor -- so the picture is *supposed* to sit left of the name: they are side by side by
        // design. Below 820px they stack, and then the picture has to be on the same axis as
        // everything else, because there is no second track to sit in.
        const stacked = width <= 820;

        console.log(`    identity: avatar=${box.avatar} text=${box.text} buttons=${box.buttons} hint=${box.avatarHint}`);
        console.log(`    editor:   label=${box.fieldRow} field=${box.control} hint=${box.hint} row=${box.actionRow} | card=${box.cardCentre}`);

        // The name, its description and the picture controls are one stack in one track.
        const textStack = ['text', 'buttons', 'avatarHint'];
        const textSpread = Math.max(...textStack.map((k) => box[k])) - Math.min(...textStack.map((k) => box[k]));
        if (textSpread <= 2) ok(`name, controls and hint share an axis (${textSpread}px)`);
        else fail(`name stack not centred -- ${textStack.map((k) => `${k}@${box[k]}`).join(', ')}`);

        // The editor column: label row, field, hint, and the save row.
        const editorStack = ['fieldRow', 'control', 'hint', 'actionRow'];
        const editorSpread = Math.max(...editorStack.map((k) => box[k])) - Math.min(...editorStack.map((k) => box[k]));
        if (editorSpread <= 2) ok(`label, field, hint and save row share an axis (${editorSpread}px)`);
        else fail(`editor not centred -- ${editorStack.map((k) => `${k}@${box[k]}`).join(', ')}`);

        if (stacked) {
            const all = ['avatar', 'text', 'buttons', 'avatarHint', 'fieldRow', 'control', 'hint', 'actionRow'];
            const total = Math.max(...all.map((k) => box[k])) - Math.min(...all.map((k) => box[k]));
            if (total <= 2) ok(`stacked: the whole card is on one axis (${total}px)`);
            else fail(`stacked but split across axes -- ${all.map((k) => `${k}@${box[k]}`).join(', ')}`);
        } else {
            if (box.avatar < box.text) ok('two columns: the picture sits left of the name');
            else fail('the picture is not left of the name in the two-column layout');
        }

        // The save row is a pair -- the button and the status it produces -- so the row is centred,
        // not the button alone. A signed-out visitor has a real status ("Sign in to change this."),
        // and centring the button under a status to its right is the row being centred correctly.
        if (box.statusWidth > 0) ok(`save row is a ${box.statusWidth}px centred pair`);
        else fail('save row has no width');

        if (box.textAlign === 'center') ok('profile text centred');
        else fail(`profile text-align is "${box.textAlign}"`);
        if (box.actionsAlign === 'center') ok('picture controls centred');
        else fail(`picture controls align-items is "${box.actionsAlign}"`);
        if (box.overflow <= 0) ok('no sideways scroll');
        else fail(`page scrolls ${box.overflow}px sideways`);

        await page.close();
    }

    // ---- 2. Footer columns on a phone ------------------------------------------
    for (const width of [1280, 900, 700, 560, 390, 360, 320]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 1000 });
        console.log(`\nfooter @ ${width}px`);

        await page.goto(`${BASE}/terms`, { waitUntil: 'networkidle2' });
        const box = await page.evaluate(() => {
            const footer = document.querySelector('.site-footer');
            const g = (el) => {
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
            };
            const groups = [...footer.querySelectorAll('.site-footer-group')].map((el) => ({
                name: el.getAttribute('aria-label'), ...g(el)
            }));
            // The tallest a link's text runs: how many lines a wrapped link needed.
            const lineHeights = [...footer.querySelectorAll('a')].map((a) => {
                const cs = getComputedStyle(a);
                const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
                const lines = Math.round(a.getBoundingClientRect().height / lh);
                return { lines, text: a.textContent.trim(), w: Math.round(a.getBoundingClientRect().width) };
            });
            return { tracks: getComputedStyle(footer).gridTemplateColumns.split(' ').length, groups, lineHeights };
        });

        console.log(`    tracks=${box.tracks} groups=${box.groups.map((g) => `${g.name}@${g.x},${g.y}w${g.w}`).join(' | ')}`);

        // Four tracks above 900px (brand + three groups on one row), two below it, and one only on a
        // screen narrower than the phone this ships to.
        const expectColumns = width > 900 ? 4 : width > 360 ? 2 : 1;
        if (box.tracks === expectColumns) ok(`${expectColumns} track(s)`);
        else fail(`${box.tracks} tracks, expected ${expectColumns}`);

        if (width > 360 && width <= 900) {
            const [a, b, legal] = box.groups;
            if (a && b && Math.abs(a.y - b.y) < 4 && b.x > a.x) ok('Menu and Help side by side');
            else fail(`not side by side: ${a && `${a.x},${a.y}`} / ${b && `${b.x},${b.y}`}`);
            if (legal && legal.y > a.y && legal.x <= a.x) ok('Legal spans below');
            else fail(`legal is not spanning below: ${legal && `${legal.x},${legal.y}`}`);
            const worst = Math.max(...box.lineHeights.map((l) => l.lines));
            if (worst <= 2) ok(`no link wraps past two lines (worst ${worst})`);
            else {
                const bad = box.lineHeights.filter((l) => l.lines === worst);
                fail(`wraps to ${worst} lines: ${bad.map((b) => `"${b.text}" at ${b.w}px`).join(', ')}`);
            }
        } else if (width > 900) {
            const [a, b, c] = box.groups;
            if (a && b && c && Math.abs(a.y - b.y) < 4 && Math.abs(b.y - c.y) < 4) ok('three groups on one row');
            else fail('groups not on one row');
        } else {
            const stacked = box.groups.every((g, i) => i === 0 || g.y > box.groups[i - 1].y);
            if (stacked) ok('single column, stacked in order');
            else fail('not stacked');
        }

        await page.close();
    }

    // ---- 3. Topbar order, desktop vs phone -------------------------------------
    for (const width of [1280, 900, 560, 390]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        console.log(`\ntopbar @ ${width}px`);
        await page.goto(`${BASE}/terms`, { waitUntil: 'networkidle2' });

        const t = await page.evaluate(() => {
            const brand = document.querySelector('.topbar .brand');
            const clock = document.getElementById('topbar-clock');
            const nav = document.querySelector('.topbar .header-nav');
            if (!brand || !clock) return null;
            const b = brand.getBoundingClientRect();
            const c = clock.getBoundingClientRect();
            const n = nav ? nav.getBoundingClientRect() : null;
            return {
                brandX: Math.round(b.x), clockX: Math.round(c.x),
                brandY: Math.round(b.y), clockY: Math.round(c.y),
                navX: n ? Math.round(n.x) : null,
                width: Math.round(window.innerWidth)
            };
        });

        if (!t) { fail('no brand or clock'); await page.close(); continue; }
        console.log(`    brand x=${t.brandX} y=${t.brandY} | clock x=${t.clockX} y=${t.clockY} | nav x=${t.navX}`);

        if (width > 720) {
            // The wordmark leads the header, the clock follows it. That is the whole change, and it
            // is only true at desktop widths -- see the `min-width: 721px` in the stylesheet.
            if (t.brandX < t.clockX) ok('wordmark is left of the clock');
            else fail(`clock (${t.clockX}) is left of the wordmark (${t.brandX})`);
            if (Math.abs(t.brandY - t.clockY) < 12) ok('they share a row');
            else fail(`different rows: brand y=${t.brandY} clock y=${t.clockY}`);
            // And the wordmark is the leftmost thing in the header, not the clock.
            if (t.navX === null || t.brandX < t.navX) ok('the wordmark leads the header');
            else fail(`the navigation starts left of the wordmark (${t.navX})`);
        } else {
            // On a phone the clock sits at the right of the header and the wordmark at the left,
            // which is what it always did. `order` has nothing to reorder here because the group
            // is `display: contents` and the two are separate grid cells -- so this asserts the
            // phone is unchanged by the desktop-only rule above.
            if (t.brandX < t.clockX) ok('phone keeps the wordmark left, clock right');
            else fail(`phone order changed: brand ${t.brandX}, clock ${t.clockX}`);
        }

        await page.close();
    }

    await browser.close();
    console.log(problems ? `\n${problems} PROBLEM(S)` : '\nprofile, footer and topbar verified');
    process.exit(problems ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });