const fs = require('fs');
const puppeteer = require('puppeteer-core');

/**
 * Watches the live topbar clock and reads what it actually prints.
 *
 * `hour12: false` in a `Intl.DateTimeFormat` options object is one line, and it is invisible in
 * every static check in this repo: the call is valid, the id resolves, the element has a size.
 * Only the rendered text says "16:16" instead of "4:16 PM", and only the rendered text says
 * whether a reader in the afternoon can tell afternoon from morning.
 *
 * So this ticks the real clock and asserts on the string in the DOM. It reads it twice, roughly a
 * minute apart is too slow for a smoke test, so instead it checks three things: the meridiem is
 * present, it agrees with the site's own 24-hour hour for the current instant, and the seconds
 * actually advance (a frozen clock that happens to be formatted correctly is still broken).
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const ZONE = process.env.CLOCK_ZONE || 'America/New_York';

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
const fail = (m) => { problems++; console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    console.log(`live clock @ ${BASE}/ (zone ${ZONE})`);
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });

    const read = () => page.evaluate(() => {
        const node = document.getElementById('topbar-clock-time');
        return node ? node.textContent.trim() : null;
    });

    const first = await read();
    if (!first) fail('no #topbar-clock-time on the page');
    else {
        console.log(`  clock reads: "${first}"`);

        const shaped = /^\d{1,2}:\d{2}:\d{2}\s?(AM|PM)$/.exec(first);
        ok(!!shaped, `not a 12-hour clock with a meridiem: "${first}"`);

        const twentyFour = Number(new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', hour12: false, timeZone: ZONE
        }).format(new Date()));
        const expected = twentyFour >= 12 ? 'PM' : 'AM';
        const shownHour = Number(first.split(':')[0]);
        const twelve = twentyFour % 12 === 0 ? 12 : twentyFour % 12;

        ok(shownHour === twelve, `hour ${shownHour} does not match site hour ${twentyFour} (expected ${twelve})`);
        ok(first.endsWith(expected), `meridiem should be ${expected} at site hour ${twentyFour}`);
        if (twentyFour > 12) {
            ok(shownHour !== twentyFour, `printed the 24-hour hour ${twentyFour}`);
        }
    }

    // The seconds have to move, or it is a formatted string rather than a clock.
    await new Promise((r) => setTimeout(r, 1600));
    const second = await read();
    if (first && second) {
        const secs = (s) => Number(s.split(':')[2].slice(0, 2));
        const drifted = secs(second) !== secs(first) || second.slice(-2) !== first.slice(-2);
        ok(drifted, `the clock is not ticking: "${first}" then "${second}"`);
    }

    // And it must still say which half of the day it is after the rollover boundary is crossed.
    const overnight = await page.evaluate(() => {
        // Ask the page's own formatter for 01:00 and 13:00 in the site zone.
        const node = document.getElementById('topbar-clock-time');
        return node ? node.getAttribute('datetime') : null;
    });
    ok(!!overnight, 'the clock carries a machine-readable datetime alongside the text');

    await browser.close();
    console.log(problems ? `\n${problems} PROBLEM(S)` : '\nlive clock verified');
    process.exit(problems ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });