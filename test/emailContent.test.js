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
