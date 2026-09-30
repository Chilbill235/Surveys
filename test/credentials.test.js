/**
 * A placeholder in `.env` is a truthy string.
 *
 * That is the whole reason this module exists. `if (process.env.STRIPE_SECRET_KEY)` passes
 * on `whsec_your_stripe_webhook_secret_here`, so the app reports card deposits as available,
 * takes the customer's money, and then fails the signature check on the callback that was
 * supposed to credit it. Nothing in that chain raises, because every individual check was
 * answered by "is it non-empty?" and the answer was technically yes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPlaceholderCredential, realCredential, placeholderProblems } = require('../src/services/credentials');

test('example template values are treated as missing', () => {
    const placeholders = [
        'whsec_your_stripe_webhook_secret_here',
        'sk_your_stripe_secret_key_here',
        'pk_your_publishable_key',
        'your_api_key',
        'your-api-key',
        'YOUR_HERE',
        'YOUR_API_KEY_HERE',
        'replace_me',
        'changeme',
        'placeholder',
        'TODO',
        'fixme',
        'example_key',
        'your_secret_here',
        '<your-key>',
        '{YOUR_KEY}',
        '[YOUR_KEY]',
        'aaaaaaaa',
        '0000000000',
        '   ',
        '',
    ];
    for (const value of placeholders) {
        assert.equal(isPlaceholderCredential(value), true, `${JSON.stringify(value)} should not count as a credential`);
    }
    assert.equal(isPlaceholderCredential(undefined), true);
    assert.equal(isPlaceholderCredential(null), true);
    assert.equal(isPlaceholderCredential(12345), true);
    assert.equal(isPlaceholderCredential({ toString: () => 'sk_live_x' }), true);
});

test('real credentials are not mistaken for placeholders', () => {
    const real = [
        'sk_live_51H8xYzAbCdEfGhIjKlMnOp',
        'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
        'rk_live_51H8xYzAbCdEfGhIjKlMnOpQrSt',
        'whsec_T9dPQ2mVxK8sLwR4bN6cJfH0gA3eY7uI1oP5tZrX',
        '3619RCJW-MNBUIHI1A4WDNHHSHNWQ1XZR',
        'tEGmIT4ZbJ9lQw8Xc2vNa5PdRsYu7KfH3',
        'xkeysib-2f4a1c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170',
    ];
    for (const value of real) {
        assert.equal(isPlaceholderCredential(value), false, `${value.slice(0, 12)}... is a real credential`);
    }
    // Trimming is the only normalisation, so a value pasted with trailing whitespace from a
    // copy/paste still works.
    assert.equal(isPlaceholderCredential('  sk_live_51H8xYzAbCdEfGhIjKlMnOp  '), false);
    // A short repeated value is a keyboard slip; a longer repeated-looking secret is not.
    assert.equal(isPlaceholderCredential('abc'), false);
});

test('realCredential returns the value or null without ever returning a placeholder', () => {
    const env = { GOOD: 'sk_live_51H8xYzAbCdEfGhIjKlMnOp', BAD: 'whsec_your_webhook_secret_here' };
    assert.equal(realCredential(env, 'GOOD'), 'sk_live_51H8xYzAbCdEfGhIjKlMnOp');
    assert.equal(realCredential(env, 'BAD'), null);
    assert.equal(realCredential(env, 'ABSENT'), null);
});

test('placeholderProblems names every unusable variable, in order', () => {
    const env = {
        STRIPE_SECRET_KEY: 'sk_live_51H8xYzAbCdEfGhIjKlMnOp',
        STRIPE_WEBHOOK_SECRET: 'whsec_your_stripe_webhook_secret_here',
    };
    const problems = placeholderProblems(env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    // The working key is not reported; the unusable one is, by variable name, so the
    // operator knows which line of the environment file to replace.
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^STRIPE_WEBHOOK_SECRET is missing or is still a placeholder value\.$/);
    assert.deepEqual(placeholderProblems(env, ['STRIPE_SECRET_KEY']), []);
});
