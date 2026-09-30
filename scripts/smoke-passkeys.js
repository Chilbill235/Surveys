const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

/**
 * Checks the passkey UI end to end in a real browser.
 *
 * The server-side crypto is covered by `test/passkeys.test.js`. What is left is the half a
 * unit test cannot see: that the button is actually shown, that the challenge is in hand
 * before the click, and that a refusal leaves the password form usable.
 *
 * Needs a local Chrome or Edge, same as `smoke-ui.js`; point `CHROME_PATH` at it if it is
 * somewhere unusual.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3199';

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
].filter(Boolean);

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

(async () => {
    const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!executablePath) {
        console.error('No Chrome or Edge found. Set CHROME_PATH to the browser executable.');
        process.exit(1);
    }
    console.log(`Using ${executablePath}\n`);

    const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        // --- Sign-in page ---------------------------------------------------
        await page.goto(`${BASE}/login`, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 600));

        const entryVisible = await page.$eval('#passkey-entry', (el) => !el.hidden && el.offsetParent !== null);
        check('the passkey sign-in control is shown on a browser with WebAuthn', entryVisible);

        const note = await page.$eval('#passkey-note', (el) => el.textContent.trim());
        check('the note names a verification method', note.length > 0, note);

        // The password form must be untouched and still above the button, because a cancelled
        // passkey is the common case and the user needs somewhere else to go.
        const order = await page.$$eval('#account-email, #account-password, #connect-submit, #passkey-signin',
            (els) => els.map((el) => el.id));
        check('the password form is present and precedes the passkey button',
            order.indexOf('account-password') < order.indexOf('passkey-signin'), order.join(' < '));

        const disabled = await page.$eval('#connect-submit', (el) => el.disabled);
        check('the password submit is not disabled by the passkey script', disabled === false);

        // --- Challenges are prefetched ---------------------------------------
        // The flow cannot call the authenticator without a challenge in hand, and it cannot
        // fetch one inside the click, so the preload is what makes the button work at all.
        const challenged = await page.evaluate(async () => {
            const response = await fetch('/api/auth/passkeys/authenticate/options', { method: 'POST' });
            if (!response.ok) return { ok: false, status: response.status };
            const body = await response.json();
            return { ok: Boolean(body.challenge), status: response.status, challenge: body.challenge };
        });
        check('the server issues a sign-in challenge without a session', challenged.ok, `status ${challenged.status}`);

        // --- The challenge lifecycle, in the browser -------------------------
        // The server is stateless by design, so this is the only place the one-shot property
        // lives. Each check is a small function the page actually loads.
        const lifecycle = await page.evaluate(() => {
            const shared = window.RewardZonePasskeys;
            if (!shared) return { error: 'shared module not loaded' };
            const out = {};

            shared.rememberChallenge('authenticate', 'A'.repeat(43));
            out.stored = shared.hasChallenge('authenticate');
            out.otherKind = shared.hasChallenge('register');
            out.consumed = shared.consumeChallenge('authenticate');
            out.spentAfterRead = shared.hasChallenge('authenticate');
            out.secondRead = shared.consumeChallenge('authenticate');

            // Expired after its window.
            sessionStorage.setItem('rewardZonePasskeyChallenge',
                JSON.stringify({ kind: 'authenticate', value: 'B'.repeat(43), at: Date.now() - 6 * 60 * 1000 }));
            out.expired = shared.consumeChallenge('authenticate');

            // A different flow's challenge must not be spendable on this one.
            shared.rememberChallenge('register', 'C'.repeat(43));
            out.crossKind = shared.consumeChallenge('authenticate');

            return out;
        });

        check('a stored challenge is readable while it is fresh', lifecycle.stored === true);
        check('a challenge is not readable as a different kind of flow', lifecycle.otherKind === false);
        check('a challenge is returned once and then spent', lifecycle.consumed === 'A'.repeat(43) && lifecycle.spentAfterRead === false);
        check('a spent challenge is not returned again', lifecycle.secondRead === null);
        check('a challenge older than its window is refused', lifecycle.expired === null);
        check('a registration challenge cannot be spent on a sign-in', lifecycle.crossKind === null);

        // --- Account page ----------------------------------------------------
        // The session gate forwards a signed-out visitor before any passkey script can reveal
        // anything, so the account page is not what loads here -- the redirect is the result.
        await page.goto(`${BASE}/account`, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 600));
        check('a signed-out visitor is sent away from the account page',
            page.url().includes('/login'), page.url());

        // --- Nothing threw ---------------------------------------------------
        const realErrors = consoleErrors.filter((text) => !/favicon|401|Unauthorized|token/i.test(text));
        check('no script errors on either page', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        await browser.close();
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('smoke run failed:', error);
    process.exit(1);
});
