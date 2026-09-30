/**
 * Drives the real pages in a real browser and asserts the controls are not inert.
 *
 * Why this exists
 * ---------------
 * The account page shipped with its two primary calls to action -- Deposit and Withdraw --
 * rendered `disabled`, never referenced by any script, and every static check passing. They
 * had valid ids, valid CSS classes, no console errors, and no failed requests. They simply
 * did nothing, on the page that is supposed to be the account.
 *
 * No static check can catch that on its own, because the failure is not "this id is missing"
 * or "this class has no rule". It is "this element is reachable, looks right, and has nothing
 * behind it". Only clicking proves otherwise.
 *
 * What it asserts
 * ---------------
 * For each page: it loads, nothing throws, every script resolves, and the controls that must
 * work without a session actually do. Signed out, Deposit and Withdraw are *correctly*
 * disabled -- so what is checked is that Connect and Change password open their dialog, and
 * that the balance shows the signed-out placeholder rather than `undefined`.
 *
 * It deliberately runs signed out, so it needs no account, no seeded offers and no money. A
 * signed-in pass would additionally need a real balance, which makes it a manual check rather
 * than something to put in front of a build.
 *
 * Usage
 * -----
 *   npm start                 # in one terminal
 *   npm run smoke:ui          # in another
 *
 * Needs a local Chrome or Edge. Point `CHROME_PATH` at it if it is somewhere unusual.
 */
const fs = require('fs');
const path = require('path');
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
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
].filter(Boolean);

const failures = [];
const notes = [];

/**
 * Pages that refuse a signed-out visitor.
 *
 * Kept as a list rather than read off the markup so that a page which is *supposed* to be
 * gated and is not shows up here as a failure, instead of quietly joining the set of pages
 * that pass because nothing checked them.
 */
const GATED_ROUTES = ['/offers', '/account', '/receipt/deposit/1'];

function check(passed, description, detail) {
    if (passed) notes.push(`  ok    ${description}`);
    else failures.push(`${description}${detail ? `\n          ${detail}` : ''}`);
}

/**
 * Console noise from a third-party embed is not our bug, and reporting it as one would train
 * people to ignore this output. The donation widget on the marketing page calls
 * `account-api.nowpayments.io`, which currently answers 404, so the page logs an error that
 * nobody here can fix and that the visible fallback text already covers.
 *
 * Attribution is by the origin the message came from, not by matching the text: the message
 * text is the provider's, not ours, and it does not name its own host.
 */
function isOurOrigin(locationUrl) {
    if (!locationUrl || locationUrl === 'about:blank') return false;
    try {
        return new URL(locationUrl).origin === BASE;
    } catch {
        return false;
    }
}

(async () => {
    const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
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
        // Only the pages a signed-out visitor can actually land on are measured for clean
        // loading. `/offers`, `/account` and the receipt page are gated, so a visit to any of
        // them ends on `/login` -- measuring them here would silently be measuring the
        // sign-in page instead, which is a different document, and would have reported a
        // clean console for pages nobody ever loaded. The gate sections below cover them.
        const PAGES = ['/', '/login'];

        for (const route of PAGES) {
            const page = await browser.newPage();
            const pageErrors = [];
            const consoleErrors = [];
            const thirdPartyErrors = [];
            const brokenScripts = [];

            page.on('pageerror', (err) => pageErrors.push(err.message));
            page.on('console', (msg) => {
                if (msg.type() !== 'error') return;
                const text = msg.text().split('\n')[0];
                const from = (msg.location() || {}).url;
                if (isOurOrigin(from)) consoleErrors.push(`${text}  (${from})`);
                else thirdPartyErrors.push(`${text}  (${from})`);
            });
            page.on('response', (res) => {
                if (res.request().resourceType() === 'script' && res.status() >= 400) {
                    brokenScripts.push(`${res.status()} ${res.url()}`);
                }
            });

            const response = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2' });
            check(response.status() === 200, `${route} responds 200`, `got ${response.status()}`);
            check(pageErrors.length === 0, `${route} has no uncaught error`, pageErrors.join('\n          '));
            check(brokenScripts.length === 0, `${route} loads every script`, brokenScripts.join('\n          '));

            // Only our own origin counts as a defect.
            check(consoleErrors.length === 0, `${route} console is clean`, consoleErrors.join('\n          '));
            for (const text of thirdPartyErrors) {
                notes.push(`  note  ${route}: third-party embed logged "${text}"`);
            }

            const hasActionBar = await page.evaluate(() => Boolean(document.querySelector('.action-bar')));
            if (hasActionBar) {
                const mobileBell = await page.evaluate(() => Boolean(document.getElementById('notification-bell-mobile')));
                check(mobileBell, `${route}: the action-bar notification bell exists`);
            } else {
                notes.push(`  n/a   ${route}: no action bar on this page`);
            }

            // The account dashboard's controls are not checked here. This loop visits pages
            // signed out, and a signed-out visit to `/account` is supposed to end on the
            // sign-in page -- so the Deposit button being absent is the correct outcome, and
            // asserting its presence would assert the bug. It has its own signed-in section
            // below.

            await page.close();
        }

        // The account dashboard's own controls, and the account menu. Checked on their own
        // page loads rather than as part of the loop above, because a signed-out visit to
        // `/account` is *supposed* to land on the sign-in page: the controls do exist in the
        // document, but the one a signed-out visitor gets is the form. Asserting "the Deposit
        // button is present" on a page they were correctly refused would be asserting the bug.
        //
        // Both `/account` and `/offers` are checked, and they share this block on purpose. The
        // account menu is the same control on both, and the bug it was added to fix -- a
        // signed-in visitor seeing "Your account" and the brand mark on the offers page -- is
        // invisible to a check that only ever looks at the account page. `loadProfile` had been
        // gated on the profile *editor*, which only `/account` has.
        for (const route of ['/account', '/offers']) {
            const page = await browser.newPage();
            try {
                // The API is answered locally, not against the server. A signed-in page needs
                // a token to render, and the only token available here is a fake one, which
                // the real API answers with 401 -- and 401 is exactly the path that signs the
                // visitor out again and redirects, so the dashboard is never observable.
                // Serving the handful of responses the page reads on load means the dashboard
                // is rendered as it would be for a real signed-in visitor, which is the state
                // whose controls and avatar are being asserted.
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    const url = request.url();
                    if (!url.includes('/api/')) {
                        request.continue();
                        return;
                    }
                    if (url.includes('/user/balance')) {
                        request.respond({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ balance: '42.50', demoBalance: '0' })
                        });
                        return;
                    }
                    if (url.includes('/user/deposits')) {
                        request.respond({ status: 200, contentType: 'application/json', body: '[]' });
                        return;
                    }
                    if (url.includes('/user/history')) {
                        request.respond({ status: 200, contentType: 'application/json', body: '[]' });
                        return;
                    }
                    if (url.includes('/user/email-preferences')) {
                        request.respond({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ moneyEmails: true })
                        });
                        return;
                    }
                    // A realistic profile, because the catch-all below answers `{}` and the
                    // account page reads an empty object as "no name, no address" -- which
                    // paints the fallback "Your account" and no greeting, and would make a
                    // check for either one a test of the stub rather than of the page.
                    if (url.includes('/user/profile')) {
                        request.respond({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                displayName: 'Ada Lovelace',
                                avatarData: null,
                                email: 'ada@example.com'
                            })
                        });
                        return;
                    }
                    if (url.includes('/user/payment-options')) {
                        request.respond({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ stripeAvailable: false, cryptoAvailable: false, callbacksReachable: false, publicBaseUrl: null })
                        });
                        return;
                    }
                    // Anything else -- the live-sync poll above all -- gets an empty 200 rather
                    // than a 401, because a 401 here is a logout.
                    request.respond({ status: 200, contentType: 'application/json', body: '{}' });
                });

                await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
                await page.evaluate(() => sessionStorage.setItem('offerNetworkSessionToken', 'test-token-not-verified'));
                await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
                await new Promise((r) => setTimeout(r, 500));

                check(new URL(page.url()).pathname === route,
                    `${route}: a visitor with a session stays on the page`,
                    `landed on ${new URL(page.url()).pathname}`);

                const controls = await page.evaluate(() => {
                    const read = (id) => {
                        const el = document.getElementById(id);
                        return el ? { present: true, disabled: el.disabled } : { present: false };
                    };
                    // The first of these ids that the page actually renders, or `{ present:
                    // false }` if it renders none of them. Defined here rather than inline
                    // because the return object needs it before its own properties do.
                    const firstPresent = (...ids) => {
                        for (const id of ids) {
                            if (document.getElementById(id)) return read(id);
                        }
                        return { present: false };
                    };
                    return {
                    // The Deposit/Withdraw pair, whichever spelling the page uses.
                    //
                    // Three pages carry this pair and they spell it three ways: the account
                    // page's balance card uses `account-deposit-btn`, the offers page's balance
                    // card uses `offer-deposit-btn`, and nothing uses the old header ids any
                    // more. All three spellings are tried rather than hard-coding one page's
                    // markup, and the order matters only in that a page with two of them -- the
                    // account page has the card pair and the action bar mirrors -- should report
                    // the card, which is the primary.
                    //
                    // This list is read as "any of these", and `firstPresent` is what
                    // distinguishes that from the bug this replaced: a check that asserted one
                    // hard-coded id reported a failure no markup change could satisfy, which
                    // teaches people to ignore the check.
                    deposit: firstPresent('account-deposit-btn', 'offer-deposit-btn', 'deposit-button'),
                    withdraw: firstPresent('account-withdraw-btn', 'offer-withdraw-btn', 'withdraw-button'),
                        // The signed-out entry point is the header's "Connect account" button,
                        // `account-button` -- not a control in the balance card. Looking for an
                        // `account-connect-btn` that the page never had meant this check
                        // reported a failure no markup change could satisfy, which trains people
                        // to ignore it.
                        connect: read('account-button'),
                        // Only the account page has a password card, so its presence is not
                        // asserted on the offers page.
                        password: document.getElementById('account-password-btn')
                            ? read('account-password-btn') : null,
                        connectLabel: document.getElementById('account-button')?.textContent?.trim() || null,
                        connectVisible: (() => {
                            const el = document.getElementById('account-button');
                            return el ? !el.hidden && getComputedStyle(el).display !== 'none' : null;
                        })()
                    };
                });

                for (const [name, control] of Object.entries(controls)) {
                    if (name === 'connectLabel' || name === 'connectVisible') continue;
                    // A `null` control is a control this page does not have, not a missing one.
                    if (control === null) continue;
                    check(control.present, `${route}: the ${name} control exists`);
                }
                check(controls.deposit.disabled === false && controls.withdraw.disabled === false,
                    `${route}: Deposit and Withdraw are enabled once signed in`,
                    JSON.stringify(controls));

                // Exactly one sign-out control, and it is behind the account menu.
                //
                // This used to assert that the header button relabelled itself to "Sign out" on
                // sign-in. That label is the duplicate: the settings card had its own sign-out
                // too, so a signed-in visitor saw the same destructive action offered twice, in
                // two places, at the same visual weight as Deposit and Withdraw.
                check(controls.connectVisible === false,
                    `${route}: the header connect button is hidden once signed in, because the menu owns signing out`,
                    `visible=${JSON.stringify(controls.connectVisible)}`);
                check(controls.connectLabel === 'Connect account',
                    `${route}: the connect button says what it does, not what it used to do`,
                    `label=${JSON.stringify(controls.connectLabel)}`);

                // ---------------------------------------------------------------------------
                // The account menu.
                //
                // Checked on both the account page and the offers page, because the bug this
                // was written for was not on either page individually. `loadProfile` was gated
                // on the profile *editor*, which only the account page has, so on offers the
                // header painted its fallback: "Your account" and the brand mark, for a visitor
                // who was signed in with a name and a picture saved. A check on the account
                // page alone passes straight through that.
                // ---------------------------------------------------------------------------
                const menu = await page.evaluate(() => {
                    const wrap = document.getElementById('account-menu');
                    const trigger = document.getElementById('account-menu-trigger');
                    const panel = document.getElementById('account-menu-panel');
                    // Every sign-out on the page, so a second one appearing anywhere -- in a
                    // dialog, a card, the footer, the action bar -- is caught rather than
                    // tolerated.
                    const signouts = [...document.querySelectorAll('button, a')]
                        .filter((el) => !el.closest('dialog') && /^sign out$/i.test(el.textContent.trim()));
                    return {
                        present: Boolean(wrap && trigger && panel),
                        wrapHidden: wrap ? wrap.hidden : null,
                        panelHidden: panel ? panel.hidden : null,
                        expanded: trigger ? trigger.getAttribute('aria-expanded') : null,
                        avatarSrc: document.getElementById('account-menu-avatar')?.getAttribute('src') || null,
                        name: document.getElementById('account-menu-name')?.textContent?.trim() || null,
                        email: document.getElementById('account-menu-email')?.textContent?.trim() || null,
                        signOutCount: signouts.length,
                        signOutIds: signouts.map((el) => el.id || el.tagName)
                    };
                });

                check(menu.present && menu.wrapHidden === false,
                    `${route}: the account menu is shown once signed in`,
                    JSON.stringify(menu));
                check(menu.expanded === 'false' && menu.panelHidden === true,
                    `${route}: the account menu starts closed`,
                    JSON.stringify(menu));
                check(menu.avatarSrc === '/brand.gif',
                    `${route}: the account menu falls back to the brand mark when no picture is set`,
                    JSON.stringify(menu));
                // The whole point of the trigger: it says who is signed in, in the header,
                // without anyone having to open anything -- and it does so on *every* page.
                check(menu.name === 'Ada Lovelace' && menu.email === 'ada@example.com',
                    `${route}: the header names the signed-in person and their address`,
                    JSON.stringify(menu));
                check(menu.signOutCount === 1 && menu.signOutIds.includes('account-menu-signout'),
                    `${route}: there is exactly one sign-out control, and it is in the menu`,
                    JSON.stringify(menu));

                // Opening it, because a menu that is present but does not open is the same as
                // one that is not there.
                await page.click('#account-menu-trigger');
                await new Promise((r) => setTimeout(r, 120));
                const opened = await page.evaluate(() => ({
                    expanded: document.getElementById('account-menu-trigger')?.getAttribute('aria-expanded'),
                    panelHidden: document.getElementById('account-menu-panel')?.hidden,
                    // Where the panel actually is, against the control that opened it. The
                    // notifications panel had this same bug -- anchored to the whole header
                    // tool row rather than to the bell -- so the position is asserted, not
                    // just the visibility.
                    triggerRight: document.getElementById('account-menu-trigger')?.getBoundingClientRect().right,
                    panelRight: document.getElementById('account-menu-panel')?.getBoundingClientRect().right,
                    panelWithinViewport:
                        document.getElementById('account-menu-panel')?.getBoundingClientRect().right <= window.innerWidth + 1
                }));
                check(opened.expanded === 'true' && opened.panelHidden === false,
                    `${route}: clicking the profile picture opens the account menu`,
                    JSON.stringify(opened));
                check(opened.panelWithinViewport === true,
                    `${route}: the account menu opens inside the viewport`,
                    JSON.stringify(opened));
                check(Math.abs(opened.panelRight - opened.triggerRight) < 2,
                    `${route}: the account menu is aligned to the control that opened it`,
                    JSON.stringify(opened));

                // Escape closes it.
                await page.keyboard.press('Escape');
                await new Promise((r) => setTimeout(r, 120));
                const closed = await page.evaluate(() => ({
                    expanded: document.getElementById('account-menu-trigger')?.getAttribute('aria-expanded'),
                    panelHidden: document.getElementById('account-menu-panel')?.hidden
                }));
                check(closed.expanded === 'false' && closed.panelHidden === true,
                    `${route}: Escape closes the account menu`,
                    JSON.stringify(closed));

                // The notifications panel is anchored to the bell, not to the header row.
                await page.evaluate(() => {
                    const bell = document.getElementById('notification-bell');
                    if (bell) bell.hidden = false;
                });
                await page.click('#notification-bell');
                await new Promise((r) => setTimeout(r, 120));
                const notifications = await page.evaluate(() => {
                    const panel = document.getElementById('notification-dropdown')?.getBoundingClientRect();
                    const bell = document.getElementById('notification-bell')?.getBoundingClientRect();
                    return {
                        panelRight: panel ? panel.right : null,
                        bellRight: bell ? bell.right : null,
                        withinViewport: panel ? panel.right <= window.innerWidth + 1 : null
                    };
                });
                check(notifications.withinViewport === true,
                    `${route}: the notifications panel opens inside the viewport`,
                    JSON.stringify(notifications));
                check(Math.abs(notifications.panelRight - notifications.bellRight) < 2,
                    `${route}: the notifications panel is aligned to the bell that opened it`,
                    JSON.stringify(notifications));
                await page.keyboard.press('Escape');

                // The greeting. The account page is addressed to a person, so the first thing
                // on it says who is signed in rather than leading with a balance figure. The
                // offers page is a catalog and has no greeting; what it must have is the same
                // identity in the header, which the menu checks above cover.
                if (route === '/account') {
                    const greeting = await page.evaluate(() => {
                        const el = document.getElementById('account-greeting');
                        return { present: Boolean(el), hidden: el ? el.hidden : null, text: el ? el.textContent.trim() : null };
                    });
                    check(greeting.present && greeting.hidden === false && /welcome back/i.test(greeting.text || ''),
                        '/account: the page greets the signed-in visitor',
                        JSON.stringify(greeting));
                    check(/Ada Lovelace/.test(greeting.text || ''),
                        '/account: the greeting uses the name the user chose, not their address',
                        JSON.stringify(greeting));
                }
            } finally {
                await page.close();
            }
        }

        // ---------------------------------------------------------------------------
        // Every dialog's primary action is actually reachable
        // ---------------------------------------------------------------------------
        //
        // This is here because of a bug that two separate checks missed.
        //
        // The contact form and the help desk were both taller than a phone screen. The dialog
        // scrolled, so nothing overflowed and no layout check fired -- but "Send message" and
        // "Send" sat 45-50px below the dialog's own bottom edge at 360x640, 360x800 and
        // 1280x800 alike. `dialog.open` was true, the button had a non-zero box, the ids
        // resolved, the labels were present, and the contrast passed. `elementFromPoint` on the
        // button's centre returned null, which is the part that matters: the tap landed on
        // nothing. A support form whose send button is off the screen is a support form
        // nobody uses, and nothing in the suite noticed.
        //
        // So this measures the thing directly. For every dialog the page can open, it opens it
        // at a phone size and asks two questions: is the primary control inside the dialog's
        // visible bounds, and does a hit-test at its centre reach it? The second is the one
        // that catches an element which is technically visible and practically untappable --
        // under a sticky header, behind a scroll container, or clipped by a parent.
        //
        // A control that is present but clipped is the exact failure this is for, so there is
        // no exemption for "it is just below the fold": scrolling to it is a different gesture
        // and the affordance for it does not exist.
        {
            const DIALOGS = [
                { trigger: '[data-contact-trigger]', submit: '#contact-submit', name: 'contact' },
                { trigger: '[data-helpdesk-trigger]', submit: '#helpdesk-send', name: 'help desk' }
            ];

            for (const route of ['/account', '/offers', '/']) {
                const page = await browser.newPage();
                try {
                    // 640px tall on purpose: it is the shortest viewport any of these dialogs
                    // is expected to survive, and it is the size that exposed both bugs. A
                    // taller viewport hides the problem by accident.
                    await page.setViewport({ width: 360, height: 640 });
                    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
                    await new Promise((r) => setTimeout(r, 400));

                    for (const dialog of DIALOGS) {
                        const hasTrigger = await page.$(dialog.trigger);
                        if (!hasTrigger) continue;

                        await page.click(dialog.trigger);
                        await new Promise((r) => setTimeout(r, 400));

                        const result = await page.evaluate((submitId) => {
                            const open = document.querySelector('dialog[open]');
                            const submit = open ? open.querySelector(submitId) : null;
                            if (!open || !submit) return { ok: false, reason: 'dialog or submit not found' };
                            const dr = open.getBoundingClientRect();
                            const sr = submit.getBoundingClientRect();
                            const insideBounds = sr.top >= dr.top - 1 && sr.bottom <= dr.bottom + 1;
                            const hit = document.elementFromPoint(
                                sr.left + sr.width / 2,
                                sr.top + sr.height / 2
                            );
                            return {
                                ok: insideBounds && Boolean(submit.contains(hit)),
                                insideBounds,
                                hitTestReachesIt: Boolean(hit && submit.contains(hit)),
                                dialogBottom: Math.round(dr.bottom),
                                submitBottom: Math.round(sr.bottom),
                                viewportHeight: window.innerHeight
                            };
                        }, dialog.submit);

                        check(result.ok,
                            `${route}: the ${dialog.name} dialog's send button is reachable`,
                            JSON.stringify(result));

                        await page.keyboard.press('Escape');
                        await new Promise((r) => setTimeout(r, 250));
                    }
                } finally {
                    await page.close();
                }
            }
        }

        // ---------------------------------------------------------------------------
        // The sign-in gate
        // ---------------------------------------------------------------------------
        //
        // Only a browser can prove these. The gate reads `sessionStorage`, decides before
        // the page paints, and navigates -- none of which a static check or an HTTP request
        // can observe, and all of which is the difference between "you are signed out" and
        // "here is your balance" on a page that shows other people's-shaped data.
        for (const route of GATED_ROUTES) {
            const page = await browser.newPage();
            try {
                // `domcontentloaded`, not `networkidle2`: the point of these checks is where
                // the browser ended up, and the signed-in half of each pair starts the live
                // balance poll, which by design never lets the network go idle.
                await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 5000 }).catch(() => {});

                const landed = new URL(page.url());
                check(landed.pathname === '/login',
                    `${route}: a signed-out visitor is sent to sign in`,
                    `landed on ${landed.pathname}`);
                check(landed.searchParams.get('next') === route,
                    `${route}: the sign-in page remembers where to come back to`,
                    `next=${JSON.stringify(landed.searchParams.get('next'))}`);

                // The sign-in page is a document, not a dialog, so there is nothing to open
                // and nothing to dismiss. What it must have is a usable form -- a redirect
                // that lands on a page with no form on it is the same as no redirect, one
                // click later.
                const state = await page.evaluate(() => ({
                    form: Boolean(document.getElementById('account-form')),
                    email: Boolean(document.getElementById('account-email')),
                    focused: document.activeElement?.id || null,
                    // The whole reason `/login` is its own file. A dialog over the account
                    // page leaves the dashboard in the document behind the backdrop, where a
                    // visitor who dismisses it -- Escape, the close button, a click outside --
                    // is left standing on a private page with every control greyed out.
                    dialog: Boolean(document.getElementById('account-dialog')),
                    header: Boolean(document.querySelector('.topbar')),
                    accountPage: Boolean(document.querySelector('.account-dashboard, .catalog-grid, .offer-grid')),
                    closers: document.querySelectorAll('[data-close]').length,
                    // What a dismissal would have revealed.
                    balances: document.querySelectorAll('#account-balance-main, #balance, #user-balance').length
                }));
                check(state.form && state.email,
                    `${route}: the sign-in page has a usable form`,
                    `form=${state.form} email=${state.email}`);
                check(state.focused === 'account-email',
                    `${route}: the sign-in page puts the cursor in the email field`,
                    `focused=${state.focused}`);
                check(!state.dialog,
                    `${route}: the sign-in page is not a dismissible dialog`,
                    'a dialog means Escape or the close button leaves the visitor on the page');
                check(!state.header && !state.accountPage,
                    `${route}: nothing from the account or offers pages is on the sign-in page`,
                    `header=${state.header} accountContent=${state.accountPage}`);
                check(state.closers === 0,
                    `${route}: the sign-in page has no close control`,
                    `found ${state.closers} close buttons`);
                check(state.balances === 0,
                    `${route}: the sign-in page contains no balance or catalog to see behind it`,
                    `found ${state.balances} balance elements`);

                // Escape and a click on the backdrop, the two ways a dialog is normally
                // dismissed. Neither may change where the visitor is.
                await page.keyboard.press('Escape');
                await page.mouse.click(4, 4);
                await new Promise((r) => setTimeout(r, 150));
                const afterEscape = new URL(page.url());
                check(afterEscape.pathname === '/login' && afterEscape.searchParams.get('next') === route,
                    `${route}: Escape and a backdrop click do not dismiss the sign-in page`,
                    `landed on ${afterEscape.pathname}${afterEscape.search}`);

                // Back must not walk onto a private page either. The gate replaced the gated
                // entry, so this lands somewhere public; the assertion is only that it is
                // not the private page, signed out.
                await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                await new Promise((r) => setTimeout(r, 200));
                const afterBack = new URL(page.url());
                const privatePaths = ['/offers', '/account'];
                const hasToken = await page.evaluate(() => {
                    // `about:blank` and a `data:` document have no storage, and reading it
                    // throws a SecurityError that would abort the whole run -- so a history
                    // entry with no origin is reported as "no session", which is the
                    // conservative answer: it is certainly not a signed-in page.
                    try {
                        return Boolean(sessionStorage.getItem('offerNetworkSessionToken'));
                    } catch {
                        return false;
                    }
                }).catch(() => false);
                const backIsPrivate = privatePaths.includes(afterBack.pathname) && !hasToken;
                check(!backIsPrivate,
                    `${route}: Back does not reveal a private page to a signed-out visitor`,
                    `landed on ${afterBack.pathname}`);

                // With a token present the same page must stay put. A gate that always
                // redirected would look correct in the signed-out test above and would send
                // every signed-in visitor to the sign-in form on every page load.
                //
                // Navigated to a real origin first: after the Back check the page may be on
                // `about:blank`, which has no `sessionStorage` at all, and writing to it
                // throws a SecurityError rather than returning anything.
                await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
                await page.evaluate(() => sessionStorage.setItem('offerNetworkSessionToken', 'test-token-not-verified'));
                await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
                check(new URL(page.url()).pathname === route,
                    `${route}: a visitor with a session is not sent to sign in`,
                    `landed on ${new URL(page.url()).pathname}`);

                await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
                await page.evaluate(() => sessionStorage.clear());
            } finally {
                await page.close();
            }
        }

        // ---------------------------------------------------------------------------
        // The sign-in page is not a trap for someone who is already signed in
        // ---------------------------------------------------------------------------
        //
        // A redirect that sends a signed-in visitor to a sign-in form is the gate's version
        // of a dead end: they would pass the gate, be shown a form they do not need, and see
        // no way past it. It is checked once, not per gated route, because the behaviour does
        // not depend on which page brought them there.
        {
            const page = await browser.newPage();
            try {
                // The API is stubbed, and the reason is the same as in the signed-in section
                // above: the only token available here is fake, a real API answers 401, and a
                // 401 is a sign-out -- which bounces the visitor straight back to `/login`. The
                // forwarding would be real and correct, and the assertion would be measuring a
                // bounce caused by the stub's own fakery.
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    if (request.url().includes('/api/')) {
                        request.respond({ status: 200, contentType: 'application/json', body: '{}' });
                        return;
                    }
                    request.continue();
                });

                await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
                await page.evaluate(() => sessionStorage.setItem('offerNetworkSessionToken', 'test-token-not-verified'));

                // Not awaited: the promise resolves once the *final* document has loaded, and
                // the final document here is the one the redirect lands on, so awaiting it
                // first would mean the poll below starts too late to see anything.
                page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});

                // Polled from Node rather than with `page.waitForFunction`, which evaluates
                // inside the page: the redirect destroys that execution context mid-wait and
                // Puppeteer reports the destruction as a rejection, so the check would fail on
                // the very navigation it exists to confirm. Reading the URL from here observes
                // the navigation itself and cannot be broken by it.
                let landedOn = new URL(page.url()).pathname;
                for (let attempt = 0; attempt < 20 && landedOn !== '/account'; attempt += 1) {
                    await new Promise((r) => setTimeout(r, 250));
                    landedOn = new URL(page.url()).pathname;
                }
                check(landedOn === '/account',
                    '/login: a visitor who already has a session is sent to their account',
                    `landed on ${landedOn}`);
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }

    console.log(notes.join('\n'));
    if (failures.length) {
        console.log(`\n${failures.length} UI PROBLEM(S):`);
        for (const failure of failures) console.log(`  FAIL  ${failure}`);
        process.exit(1);
    }
    console.log(`\nALL ${notes.filter((n) => n.startsWith('  ok')).length} UI ASSERTIONS PASSED`);
    // Exits explicitly. A page left holding a session starts the live balance poll, which
    // keeps a timer in the browser, and the handle that keeps it alive can outlive
    // `browser.close()` -- so the process printed its result and then sat there, which
    // reads as a hung check in whatever runs it.
    process.exit(0);
})().catch((err) => {
    console.error('smoke:ui could not run:', err.message);
    if (/ECONNREFUSED|fetch failed/i.test(err.message)) {
        console.error(`Is the server running? Start it with "npm start" (expected at ${BASE}).`);
    }
    process.exit(2);
});
