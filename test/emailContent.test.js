const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The message bodies are built by string concatenation, which is the only way to produce email
 * that renders in Outlook, and it is also how markup injection happens. These cover the two
 * failure modes that matter: content that breaks the layout, and content that comes from a
 * user and ends up interpreted as markup.
 *
 * The other thing worth defending is the plain-text alternative. A verification code that
 * exists only in the HTML is a code that a text-only client -- some corporate gateways, every
 * `mutt`, several archive readers -- can never deliver, and the user is told to check an inbox
 * that will never receive anything.
 */

process.env.EMAIL_FROM = 'hello@example.test';
process.env.EMAIL_FROM_NAME = 'RewardZone';
process.env.APP_BASE_URL = 'https://app.example.test';

const { renderEmail, renderEmailText, escapeHtml, safeUrl, brandGifUrl } = require('../src/services/emailLayout');
const { buildMessage } = require('../src/services/verificationEmail');
const { sendWelcomeEmail, sendAccountVerifiedEmail } = require('../src/services/accountEmails');
const { sendPasswordResetEmail } = require('../src/services/resetEmail');
const {
    sendDepositInstructionsEmail,
    sendDepositConfirmedEmail,
    sendDepositFailedEmail,
    formatCoin,
    methodLabelFor
} = require('../src/services/depositEmails');
const { sendWithdrawalStartedEmail } = require('../src/services/payoutEmails');

/** Counts opening and closing tags of one name, so unbalanced markup is caught rather than eyeballed. */
function tagBalance(html, tag) {
    const opens = (html.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
    const closes = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    return { opens, closes };
}

test('user-supplied text cannot inject markup into a message', () => {
    const injected = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const html = renderEmail({
        heading: injected,
        intro: injected,
        blocks: [{ type: 'paragraph', text: injected }, { type: 'callout', text: injected }],
        footnote: injected
    });

    // Asserted on the *tag*, not on the attribute. The escaped form legitimately still
    // contains the characters `onerror=`, because only the angle brackets and quotes were
    // neutralised -- so a substring check on the handler name fails on a perfectly safe
    // message, and would pass on an unsafe one if the escaping were ever removed. The
    // message does legitimately contain one img: the brand mark.
    assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(html), 'a live event handler attribute survived into the body');
    assert.ok(!html.includes('<script'), 'a script tag survived into the body');
    assert.ok(html.includes('&lt;script&gt;'), 'the text was not escaped to entities');
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'the payload was not escaped, not just removed');
});

test('a reset link is rendered as a button and repeated in the text alternative', () => {
    const resetUrl = 'https://app.example.test/reset-password?token=abc123&next=1';
    const shared = {
        heading: 'Reset your password',
        intro: 'Someone asked to reset the password for your account.'
    };

    const html = renderEmail({ ...shared, action: { label: 'Choose a new password', url: resetUrl }, footnote: resetUrl });
    const text = renderEmailText({ ...shared, action: { label: 'Choose a new password', url: resetUrl } });

    // The ampersand is the interesting character here: unescaped, `&next=` is parsed as an
    // entity, the link silently loses its second parameter, and the token in the URL stops
    // being the one that was issued.
    assert.ok(html.includes('token=abc123&amp;next=1'), 'the query string was not escaped');
    assert.ok(text.includes(resetUrl), 'the raw URL is missing from the text alternative');
    assert.ok(html.includes('bgcolor='), 'the button is not a table cell with a background, so Outlook renders bare text');
});

test('a non-http link is dropped rather than rendered as a clickable target', () => {
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('data:text/html,<script>'), null);
    assert.equal(safeUrl('  '), null);
    assert.equal(safeUrl('/offers'), null, 'a relative path is not a usable email link');
    assert.equal(safeUrl('https://ok.example/x'), 'https://ok.example/x');

    // A refused URL must remove the button, not render it pointing nowhere.
    const html = renderEmail({ heading: 'Hi', action: { label: 'Go', url: 'javascript:alert(1)' } });
    assert.ok(!html.includes('javascript:'));
    assert.ok(!html.includes('>Go<'));
});

test('mailto is allowed for a reply link, and only as a bare address', () => {
    // The contact form's only action is to reply to the person who wrote, and the footer
    // tells them to. Without `mailto:` in the allow-list that link rendered as nothing at
    // all, which is worse than not offering one.
    assert.equal(safeUrl('mailto:someone@example.test'), 'mailto:someone@example.test');
    assert.equal(safeUrl('mailto:someone@example.test?subject=Hi'), null, 'a pre-filled subject is not rendered');
    assert.equal(safeUrl('mailto:a@b.test,c@d.test'), null, 'more than one recipient is not rendered');
    assert.equal(safeUrl('mailto:not-an-address'), null);
    assert.equal(safeUrl('mailto:someone@example.test/../x'), null);
});

test('a link block renders a real link in both bodies, not muted prose', () => {
    const url = 'https://app.example.test/history';
    const html = renderEmail({
        heading: 'Withdrawal on its way',
        blocks: [{ type: 'link', label: 'Open your withdrawal history:', url }]
    });
    const text = renderEmailText({
        intro: 'We have sent your money.',
        blocks: [{ type: 'link', label: 'Open your withdrawal history:', url }]
    });

    // Underlined, in the accent colour, and the URL is the anchor text. These three are the
    // difference between a link and a line of text that happens to contain one: a footnote
    // rendering the same URL in muted grey with no underline is what it replaced, because
    // some clients strip the scheme from a link they do not recognise, leaving the host and
    // path with nothing to make it clickable.
    assert.match(html, /<a href="https:\/\/app\.example\.test\/history"[^>]*>/);
    assert.match(html, /text-decoration:underline/);
    assert.ok(html.includes(`>${url}<`), 'the URL is not the visible text of the link');
    assert.ok(text.includes(url), 'the URL is missing from the text alternative');
    assert.ok(text.includes('Open your withdrawal history:'), 'the label is missing from the text alternative');
});

test('a link block refuses a URL that is not http(s) or mailto', () => {
    // A refused URL renders nothing at all -- not the label with no link, which would read
    // as a broken page.
    const html = renderEmail({
        heading: 'Hi',
        blocks: [{ type: 'link', label: 'Click here:', url: 'javascript:alert(1)' }]
    });
    assert.ok(!html.includes('javascript:'));
    assert.ok(!html.includes('Click here:'), 'the label was rendered with no link behind it');
});

test('every message that sends a link also writes the URL out in full', async () => {
    // The button is an image-and-border table cell, and gateways that strip images take it
    // with them. So each message that carries a link must repeat the URL as text, and the
    // text alternative is the version a text-only client can act on at all.
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const resetUrl = 'https://app.example.test/reset-password?token=t';
        await sendPasswordResetEmail({ to: 'u@example.test', resetUrl });
        const reset = sent.at(-1);
        assert.ok(reset.htmlContent.includes('https://app.example.test/reset-password?token=t'),
            'the reset URL is not in the HTML');
        assert.ok(reset.textContent.includes(resetUrl), 'the reset URL is not in the text alternative');
        // As a link, not as a footnote: the URL is the anchor text and it is underlined.
        assert.match(reset.htmlContent, /<a href="https:\/\/app\.example\.test\/reset-password\?token=t"[^>]*text-decoration:underline/);

        sent.length = 0;
        await sendWithdrawalStartedEmail({
            to: 'u@example.test',
            amount: 25,
            assetCode: 'usdt',
            network: 'trc20',
            destination: 'TXYZabc'
        });
        const started = sent.at(-1);
        assert.ok(started.htmlContent.includes('https://app.example.test/history'),
            'the history URL is not in the HTML');
        assert.ok(started.textContent.includes('https://app.example.test/history'),
            'the history URL is not in the text alternative');

        sent.length = 0;
        await sendDepositInstructionsEmail({
            to: 'u@example.test',
            amount: 20,
            balance: 0,
            method: 'USDT (TRC20)',
            depositId: 77,
            payAddress: 'TXYZabc',
            payAmount: 19.5
        });
        const instructions = sent.at(-1);
        assert.ok(instructions.htmlContent.includes('https://app.example.test/offers'),
            'the deposit page URL is not in the HTML');
        assert.ok(instructions.textContent.includes('https://app.example.test/offers'),
            'the deposit page URL is not in the text alternative');
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

test('the verification code reaches both the HTML and the text body', () => {
    const { subject, text, html } = buildMessage({ code: '048172' });

    assert.equal(subject, 'Confirm your RewardZone email');
    assert.ok(html.includes('048172'), 'the code is missing from the HTML');
    assert.ok(text.includes('048172'), 'the code is missing from the text alternative');
    assert.ok(/15/.test(text), 'the expiry is missing from the text alternative');
    assert.ok(/15/.test(html), 'the expiry is missing from the HTML');

    // Wide letter spacing, because a six-digit code in proportional type is easy to misread
    // and a misread code spends one of only five attempts.
    assert.ok(/letter-spacing:\s*12px/.test(html), 'the code is not spaced for legibility');
    assert.ok(/monospace/.test(html), 'the code is not in a monospace face');
});

test('a message is structurally sound, because email silently drops unbalanced markup', () => {
    const { html } = buildMessage({ code: '123456' });
    for (const tag of ['table', 'tr', 'td', 'body', 'html', 'p']) {
        const { opens, closes } = tagBalance(html, tag);
        assert.equal(opens, closes, `<${tag}> opened ${opens} times and closed ${closes}`);
    }
    assert.ok(html.startsWith('<!doctype html>'), 'no doctype, so clients guess a rendering mode');
    assert.ok(/role="presentation"/.test(html), 'layout tables are not marked presentational, so screen readers announce layout cells');
});

test('a message says something in the inbox list view, not just in the body', () => {
    const { html } = buildMessage({ code: '123456' });
    // The preheader is the only text an inbox shows in the list, and if it is empty the client
    // pulls the first visible words out of the body -- which for this message would be the
    // heading, so the code would never be previewed.
    const preheader = /display:none[^>]*>([^<]*)</.exec(html);
    assert.ok(preheader, 'no preheader block');
    assert.ok(preheader[1].includes('123456'), `the preheader does not carry the code: ${preheader[1].trim()}`);
});

test('the animated mark is referenced by absolute URL, or omitted when there is no base URL', () => {
    assert.equal(brandGifUrl(), 'https://app.example.test/brand.gif');

    const html = renderEmail({ heading: 'Hi' });
    assert.ok(html.includes('https://app.example.test/brand.gif'), 'the mark is not in the message');
    assert.ok(/alt="RewardZone"/.test(html), 'the image has no alt text, so a blocked image shows a filename');

    // Without a usable base URL the absolute link would be broken, so the image is left out
    // rather than pointed at nothing. A LAN origin rather than an unset variable, because an
    // unset one is a deliberate development fallback and legitimately resolves to localhost --
    // which is the one case where the caller has already decided email is not going anywhere.
    const previous = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'http://192.168.1.50:3000';
    try {
        assert.equal(brandGifUrl(), null);
        const withoutBase = renderEmail({ heading: 'Hi' });
        assert.ok(!withoutBase.includes('<img'), 'a broken image reference was emitted');
        assert.ok(!withoutBase.includes('192.168'), 'a LAN address was emitted into an email');
    } finally {
        process.env.APP_BASE_URL = previous;
    }
});

test('a dark-mode client is told the message supports both schemes', () => {
    const { html } = buildMessage({ code: '123456' });
    assert.ok(/name="color-scheme"[^>]*light dark/.test(html), 'no color-scheme meta, so a dark client inverts it unpredictably');
    assert.ok(/@media \(prefers-color-scheme:dark\)/.test(html), 'no dark-mode override');
});

test('the welcome and thank-you messages both thank the user, and neither invents a link', async () => {
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const welcome = await sendWelcomeEmail({ to: 'a@example.test' });
        const verified = await sendAccountVerifiedEmail({ to: 'a@example.test' });

        assert.equal(welcome.sent, true);
        assert.equal(verified.sent, true);
        assert.equal(sent.length, 2);

        const [welcomeBody, verifiedBody] = sent;
        assert.ok(/Welcome/i.test(welcomeBody.subject), 'the registration mail does not welcome the user');
        assert.ok(/confirm/i.test(welcomeBody.textContent), 'the welcome does not say the next step is confirming');
        assert.ok(/Thank/i.test(verifiedBody.subject), 'the verification mail does not thank the user');
        assert.ok(/active/i.test(verifiedBody.textContent), 'the thank-you does not say the account is now usable');

        // Both must carry a text alternative, or the one that matters most is unreadable in a
        // text-only client.
        for (const body of sent) {
            assert.ok(body.textContent && body.textContent.length > 40, 'a message has no usable text alternative');
            assert.ok(body.htmlContent.includes('<table'), 'a message is not using the branded layout');
        }

        // The welcome links to the catalog, and only over https.
        assert.ok(welcomeBody.htmlContent.includes('https://app.example.test/offers'));
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

test('a courtesy email failing never turns into a failed account', async () => {
    // Registration and verification are already committed by the time these send, so a provider
    // fault is a missing nicety. The mailer resolves rather than throwing, and the callers
    // do not await -- both are what keeps a slow provider from becoming a failed signup.
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const welcome = await sendWelcomeEmail({ to: 'a@example.test' });
        assert.equal(welcome.sent, false);
        assert.ok(welcome.reason, 'a failure with no reason cannot be diagnosed');
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

test('escapeHtml covers the characters that actually break attributes', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
    assert.equal(escapeHtml('"x"'), '&quot;x&quot;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

/**
 * A crypto deposit is not complete when it is created: the user is handed an address and a QR
 * code and has to go and send an exact figure to it. Until these messages existed, the only
 * copy of that figure was the response that produced it -- so a user who closed the tab had no
 * way to finish, and the coin amount is not reconstructible later because the rate has moved
 * and one address serves every figure quoted against it.
 *
 * These pin the three things that make the message usable rather than decorative: the exact
 * amount survives, the destination tag is present when the chain routes by one, and the coin is
 * never rounded to a fixed two decimals -- which turns a real 0.00042 instruction into "0.00",
 * an instruction to send nothing to an address that only accepts a non-zero amount.
 */
test('the deposit instructions carry the exact amount, the address, and the tag', async () => {
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const result = await sendDepositInstructionsEmail({
            to: 'a@example.test',
            amount: 25,
            balance: 40.5,
            method: 'XRP (ripple)',
            depositId: 42,
            payAddress: 'rExampleDestinationAddress',
            payAmount: '12.50000000',
            payinExtraId: 'tag-99',
            expiresAt: '2026-10-01T12:00:00Z'
        });

        assert.equal(result.sent, true);
        assert.equal(sent.length, 1);
        const [body] = sent;

        // The provider's trailing zeros are noise, but the digits must not move.
        assert.match(body.textContent, /12\.5 XRP \(ripple\)/);
        assert.match(body.textContent, /rExampleDestinationAddress/);
        assert.match(body.textContent, /tag-99/);
        assert.match(body.textContent, /\$25\.00/);
        assert.match(body.textContent, /\$40\.50/, 'the account balance is the reference the user checks against');
        assert.ok(body.textContent.length > 40, 'a message has no usable text alternative');
        assert.ok(body.htmlContent.includes('<table'), 'a message is not using the branded layout');
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

test('a coin amount is never rounded to the two decimals a fiat figure would use', () => {
    // Rounding here is not a cosmetic problem: 0.00042 becomes 0.00, and 0.00 is an
    // instruction to send nothing to an address that only accepts a non-zero amount.
    assert.equal(formatCoin('0.00042000'), '0.00042');
    assert.equal(formatCoin('0.001'), '0.001');
    assert.equal(formatCoin('12.50000000'), '12.5');
    assert.equal(formatCoin(100), '100');
    assert.equal(formatCoin('not a number'), null);
});

test('the deposit receipt names the amount, the method, and the new balance', async () => {
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const result = await sendDepositConfirmedEmail({
            to: 'a@example.test',
            amount: 25,
            balance: 65.5,
            method: 'Card',
            reference: 'cs_test_123'
        });

        assert.equal(result.sent, true);
        const [body] = sent;
        // The balance simply becoming larger is the least legible thing that can happen to an
        // account: a user watching an unexpected credit has no way to tell a deposit landing
        // from a mistake, so the receipt has to say what it was for.
        assert.match(body.textContent, /\$25\.00/);
        assert.match(body.textContent, /Card/);
        assert.match(body.textContent, /\$65\.50/, 'the new balance is what the user is trying to account for');
        assert.match(body.textContent, /cs_test_123/);
        assert.ok(body.htmlContent.includes('<table'));
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

test('a crypto deposit is named by coin and network, and a card deposit by card', () => {
    // Sending USDT on the wrong chain is the single most common way a crypto deposit is lost,
    // so the network is not decoration -- it is the part the user gets wrong.
    assert.equal(methodLabelFor({ provider: 'nowpayments', assetCode: 'usdt', network: 'trc20' }), 'USDT (trc20)');
    assert.equal(methodLabelFor({ provider: 'nowpayments', assetCode: 'btc', network: 'bitcoin' }), 'BTC (bitcoin)');
    assert.equal(methodLabelFor({ provider: 'stripe', assetCode: 'USD' }), 'Card');
    // A network the provider did not report is not invented.
    assert.equal(methodLabelFor({ provider: 'nowpayments', assetCode: 'btc' }), 'BTC');
});

test('a deposit email with nowhere to go is a skip, not a failure and not a send', async () => {
    const originalFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return new Response('{}', { status: 201 }); };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const noRecipient = await sendDepositInstructionsEmail({ to: '', payAddress: 'a', payAmount: 1 });
        assert.equal(noRecipient.sent, false);
        assert.equal(noRecipient.reason, 'no-recipient');
        assert.equal(called, false, 'an empty address must not reach the provider');
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

/**
 * A deposit that ends badly used to end in silence. Three ways a crypto deposit can stop --
 * the address expires, the payment is refused, an underpayment is never made whole -- all
 * left the user watching a balance that never moved, with no way to tell the app apart from
 * one that was merely slow.
 *
 * The line that matters most is the one saying the funds were never credited. Without it a
 * failed deposit reads as "the platform has my money", and that belief is what turns a routine
 * expiry into a chargeback.
 */
test('a deposit that did not complete says so, and says the money was never credited', async () => {
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const result = await sendDepositFailedEmail({
            to: 'a@example.test',
            amount: 25,
            method: 'USDT (trc20)',
            expired: true
        });

        assert.equal(result.sent, true);
        const [body] = sent;
        // Named for what happened rather than for the state change: "deposit failed" is a
        // system fact, and the subject is the only part most people read.
        assert.match(body.subject, /did not go through/i);
        assert.match(body.textContent, /could not be completed/i);
        assert.match(body.textContent, /expired/i);
        // The sentence that prevents a support escalation becoming a chargeback.
        assert.match(body.textContent, /not credited to your account/i);
        assert.match(body.textContent, /transaction hash/i, 'the user needs to be told what to bring to support');
        assert.ok(body.htmlContent.includes('<table'));
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

/**
 * The balance is debited the instant a withdrawal request is stored, and until this message
 * existed the next thing the user heard was the final confirmation -- if it arrived at all.
 * In between, their balance had dropped by the full amount with no evidence anything was
 * happening, which reads as "my money is gone" and is when people file a ticket or, worse,
 * submit a second withdrawal.
 */
test('the withdrawal is announced the moment it is sent, and not claimed as arrived', async () => {
    const sent = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response('{"messageId":"1"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    process.env.BREVO_API_KEY = 'test-key';
    try {
        const result = await sendWithdrawalStartedEmail({
            to: 'a@example.test',
            amount: 20,
            assetCode: 'USDT',
            network: 'tron',
            destination: 'TXyz9Example'
        });

        assert.equal(result.sent, true);
        const [body] = sent;
        assert.match(body.textContent, /on its way/i);
        assert.match(body.textContent, /\$20\.00/);
        assert.match(body.textContent, /USDT \(tron\)/);
        // Honest about the stage. Saying "sent" here would be a promise about a blockchain
        // confirmation nobody has seen, and the user would be right to distrust it when the
        // arrival email is late.
        assert.match(body.textContent, /waiting for the blockchain to confirm/i);
        assert.match(body.textContent, /will email you again/i);
    } finally {
        global.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
    }
});

