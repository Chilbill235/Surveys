const assert = require('node:assert/strict');
const { test } = require('node:test');

/**
 * Captures the environment, replaces `fetch`, and restores everything afterwards.
 *
 * The mailer is the one place that knows a provider's HTTP shape, so its contract is worth
 * pinning: which key authenticates, which field names the bodies, and what happens when the
 * provider is only half configured. A change to a provider's API that is not caught here
 * shows up in production as signup codes that never arrive, with nothing in the logs beyond a
 * bare status code.
 */
async function withMailer(run, env = {}) {
    const keys = [
        'EMAIL_PROVIDER', 'BREVO_API_KEY', 'RESEND_API_KEY',
        'EMAIL_FROM', 'EMAIL_FROM_NAME'
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalFetch = global.fetch;
    const calls = [];

    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);

    global.fetch = async (url, options) => {
        calls.push({
            url: String(url),
            headers: options?.headers || {},
            body: options?.body ? JSON.parse(options.body) : null
        });
        return new Response(JSON.stringify({ messageId: '<id@brevo>' }), {
            status: 201, headers: { 'Content-Type': 'application/json' }
        });
    };

    try {
        return { result: await run(calls), calls };
    } finally {
        global.fetch = originalFetch;
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

const MESSAGE = {
    to: 'member@example.test',
    subject: 'Confirm your RewardZone email',
    text: 'Your code is 123456',
    html: '<p>Your code is 123456</p>'
};

test('Brevo is used by default and authenticated with its own header', async () => {
    // Brevo is the default because it needs no domain. A Brevo account can send from its own
    // registered sender address immediately, whereas Resend will only send to the account
    // owner until a custom domain is verified -- which is the trap this replacement exists to
    // avoid repeating.
    const { result, calls } = await withMailer(
        () => require('../src/services/mailer').sendEmail(MESSAGE),
        { BREVO_API_KEY: 'xkeysib-abc', EMAIL_FROM: 'no-reply@example.test' }
    );

    assert.equal(result.sent, true);
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    // Brevo authenticates with an `api-key` header, not a bearer token.
    assert.equal(calls[0].headers['api-key'], 'xkeysib-abc');
    assert.equal('Authorization' in calls[0].headers, false);

    // Its body field names differ from every other provider, which is the trap: sending
    // `html`/`text` to Brevo produces a mail with no body at all.
    assert.deepEqual(calls[0].body.sender, { name: 'RewardZone', email: 'no-reply@example.test' });
    assert.deepEqual(calls[0].body.to, [{ email: 'member@example.test' }]);
    assert.equal(calls[0].body.htmlContent, MESSAGE.html);
    assert.equal(calls[0].body.textContent, MESSAGE.text);
    assert.equal(calls[0].body.subject, MESSAGE.subject);
});

test('Resend still works for a deployment that has verified a domain', async () => {
    const { result, calls } = await withMailer(
        () => require('../src/services/mailer').sendEmail(MESSAGE),
        {
            EMAIL_PROVIDER: 'resend',
            RESEND_API_KEY: 're_test',
            EMAIL_FROM: 'no-reply@example.test',
            EMAIL_FROM_NAME: 'RewardZone'
        }
    );

    assert.equal(result.sent, true);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].headers.Authorization, 'Bearer re_test');
    assert.equal(calls[0].body.from, 'RewardZone <no-reply@example.test>');
    assert.equal(calls[0].body.html, MESSAGE.html);
});

test('an explicit provider overrides whichever key happens to be present', async () => {
    // Otherwise leaving a stale Resend key in the environment silently keeps routing mail
    // through a provider that is not the one that was chosen.
    const { calls } = await withMailer(
        () => require('../src/services/mailer').sendEmail(MESSAGE),
        {
            EMAIL_PROVIDER: 'resend',
            RESEND_API_KEY: 're_test',
            BREVO_API_KEY: 'xkeysib-abc',
            EMAIL_FROM: 'no-reply@example.test'
        }
    );

    assert.equal(calls[0].url, 'https://api.resend.com/emails');
});

test('a half-configured provider sends nothing and says which piece is missing', async () => {
    // The dangerous case is a key with no sender: the request is well formed and the provider
    // rejects it, so the reason has to name the sender rather than quoting a status code.
    const noSender = await withMailer(
        () => require('../src/services/mailer').sendEmail(MESSAGE),
        { BREVO_API_KEY: 'xkeysib-abc' }
    );
    assert.equal(noSender.result.sent, false);
    assert.match(noSender.result.reason, /EMAIL_FROM/);
    assert.equal(noSender.calls.length, 0, 'an unusable configuration must not reach the provider');

    const noKey = await withMailer(
        () => require('../src/services/mailer').sendEmail(MESSAGE),
        { EMAIL_FROM: 'no-reply@example.test' }
    );
    assert.equal(noKey.result.sent, false);
    assert.equal(noKey.calls.length, 0);
});

test('registration is refused rather than allowed when nothing can send', async () => {
    // The whole reason `isEmailConfigured` exists: an account created when email cannot be
    // delivered is permanently unusable, and the user is told to check an inbox that will
    // never receive anything.
    const unset = await withMailer(
        () => Promise.resolve({ configured: require('../src/services/mailer').isEmailConfigured() }),
        { EMAIL_FROM: 'no-reply@example.test' }
    );
    assert.equal(unset.result.configured, false);

    const working = await withMailer(
        () => Promise.resolve({ configured: require('../src/services/mailer').isEmailConfigured() }),
        { BREVO_API_KEY: 'xkeysib-abc', EMAIL_FROM: 'no-reply@example.test' }
    );
    assert.equal(working.result.configured, true);
});

test('a provider failure keeps its own explanation for the operator', async () => {
    // Brevo returns `{"code": "unauthorized", "message": "..."}`. Without that body the only
    // clue is a 401, which does not distinguish a revoked key from a typo in a header.
    const saved = Object.fromEntries(
        ['EMAIL_PROVIDER', 'BREVO_API_KEY', 'EMAIL_FROM'].map((key) => [key, process.env[key]])
    );
    const originalFetch = global.fetch;
    process.env.BREVO_API_KEY = 'xkeysib-bad';
    process.env.EMAIL_FROM = 'no-reply@example.test';
    delete process.env.EMAIL_PROVIDER;

    global.fetch = async () => new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Key not found' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
    );

    try {
        const result = await require('../src/services/mailer').sendEmail(MESSAGE);
        assert.equal(result.sent, false);
        assert.match(result.reason, /401/);
        assert.match(result.reason, /Key not found/);
    } finally {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a transport failure is reported, not thrown', async () => {
    // The caller has already recorded the account or the reset, so a rejection here has to be
    // a value it can act on. An exception would take down a request that already succeeded.
    const saved = Object.fromEntries(
        ['EMAIL_PROVIDER', 'BREVO_API_KEY', 'EMAIL_FROM'].map((key) => [key, process.env[key]])
    );
    const originalFetch = global.fetch;
    process.env.BREVO_API_KEY = 'xkeysib-abc';
    process.env.EMAIL_FROM = 'no-reply@example.test';
    delete process.env.EMAIL_PROVIDER;

    global.fetch = async () => {
        throw new Error('socket hang up');
    };

    try {
        const result = await require('../src/services/mailer').sendEmail(MESSAGE);
        assert.equal(result.sent, false);
        assert.match(result.reason, /socket hang up/);
    } finally {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('the reported configuration never includes the key itself', async () => {
    const { result } = await withMailer(
        () => Promise.resolve(require('../src/services/mailer').emailConfiguration()),
        { BREVO_API_KEY: 'xkeysib-super-secret-value', EMAIL_FROM: 'no-reply@example.test' }
    );

    assert.equal(result.provider, 'brevo');
    assert.equal(result.configured, true);
    assert.equal(result.apiKeyPresent, true);
    // Diagnostics end up in logs, and a log line is the worst possible place for a live key.
    assert.equal(JSON.stringify(result).includes('super-secret'), false);
});
