/**
 * The exact string that started this: a deposit refused with "Your account cannot currently
 * make live charges" reached the customer as a 502 reading "Could not create a deposit with
 * the selected provider", the card button stayed enabled, and every retry produced the same
 * dead end. These tests pin the classification that fixes it -- in particular that an
 * account-level refusal suspends cards and a rate limit does not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const stripeErrors = require('../src/services/stripeErrors');

/** A Stripe error, shaped the way the SDK throws one. */
function stripeError({ type, code, message }) {
    const error = new Error(message);
    error.type = type;
    if (code) error.code = code;
    return error;
}

test('an account that cannot take live charges suspends cards and names the cause', () => {
    stripeErrors.resetSuspension();
    const refusal = stripeErrors.describeStripeFailure(
        stripeError({ type: 'StripeInvalidRequestError', message: 'Your account cannot currently make live charges.' })
    );

    assert.equal(refusal.suspends, true);
    assert.equal(refusal.status, 503);
    // Not Stripe's sentence. It names a condition the customer cannot act on, and repeating
    // it back to them reads as though they caused it.
    assert.doesNotMatch(refusal.error, /live charges/);
    assert.match(refusal.error, /cryptocurrency/i, 'the customer needs to be told what they can do instead');
    // The log is where the operator learns what actually happened, and it must say which of
    // the two opposite fixes applies.
    assert.match(refusal.log, /cannot currently make live charges/);
    assert.match(refusal.log, /key mode=\w+/);
    assert.match(refusal.log, /sk_test_/, 'a live key and a test key fail identically from outside');
});

test('the other ways Stripe says "this account is not enabled" are caught too', () => {
    const phrases = [
        'StripeInvalidRequestError: The provided account cannot accept charges',
        'StripeInvalidRequestError: Your account is inactive',
        'StripeInvalidRequestError: charges_disabled for this account',
        'StripePermissionError: This API key does not have the required permissions',
    ];
    for (const phrase of phrases) {
        const [type, message] = phrase.split(': ');
        const refusal = stripeErrors.describeStripeFailure(
            stripeError({ type: type.split(' ')[0], message })
        );
        assert.equal(refusal.suspends, true, `${phrase} should suspend cards`);
    }
});

test('a bad key or a key without Checkout permission suspends cards', () => {
    const auth = stripeErrors.describeStripeFailure(
        stripeError({ type: 'StripeAuthenticationError', message: 'Invalid API Key provided: sk_live_***' })
    );
    assert.equal(auth.suspends, true);
    assert.match(auth.log, /not a publishable key/);

    const permission = stripeErrors.describeStripeFailure(
        stripeError({ type: 'StripePermissionError', message: 'The provided key does not have the required permissions' })
    );
    assert.equal(permission.suspends, true);
});

test('a rate limit does not suspend cards, because the next request can succeed', () => {
    const refusal = stripeErrors.describeStripeFailure(
        stripeError({ type: 'StripeRateLimitError', message: 'Too many requests' })
    );
    assert.equal(refusal.suspends, false, 'hiding the button for a rate limit turns backpressure into an outage');
    assert.equal(refusal.status, 429);
    assert.match(refusal.error, /wait a moment/i);
});

test('retryable and per-request failures keep cards available', () => {
    const cases = [
        ['StripeConnectionError', 'request to Stripe failed', 502],
        ['StripeCardError', 'Your card was declined.', 400],
        ['StripeInvalidRequestError', 'Amount must be at least 50 cents', 400],
    ];
    for (const [type, message, status] of cases) {
        const refusal = stripeErrors.describeStripeFailure(stripeError({ type, message }));
        assert.equal(refusal.suspends, false, `${type} is not an account-level fault`);
        assert.equal(refusal.status, status);
    }
});

test('an unrecognised failure still logs the type and code rather than swallowing them', () => {
    const refusal = stripeErrors.describeStripeFailure(stripeError({ type: 'StripeSomethingNew', code: 'zz', message: 'who knows' }));
    assert.equal(refusal.suspends, false);
    assert.equal(refusal.status, 502);
    assert.match(refusal.log, /type=StripeSomethingNew, code=zz/);
});

test('a suspension hides cards for a while and then expires on its own', () => {
    stripeErrors.resetSuspension();
    assert.equal(stripeErrors.cardSuspensionReason(), null);

    stripeErrors.suspendCards('Stripe refused charges at the account level.');
    assert.ok(stripeErrors.cardSuspensionReason(), 'cards must be hidden while the account is refusing');
    assert.equal(stripeErrors.cardSuspensionReason(), stripeErrors.cardSuspensionReason(), 'the reason must not drift between reads');

    // The expiry is time-based, so it is exercised by moving the recorded deadline rather
    // than by waiting ten minutes for it.
    stripeErrors.suspendCards('test');
    const originalNow = Date.now;
    Date.now = () => originalNow() + stripeErrors.CARD_SUSPENSION_MS + 1;
    try {
        assert.equal(stripeErrors.cardSuspensionReason(), null, 'a suspension must not need a manual reset');
    } finally {
        Date.now = originalNow;
    }
    stripeErrors.resetSuspension();
});

test('creating a session clears a stale suspension', () => {
    stripeErrors.resetSuspension();
    stripeErrors.suspendCards('earlier refusal');
    assert.ok(stripeErrors.cardSuspensionReason());
    stripeErrors.clearSuspension();
    assert.equal(stripeErrors.cardSuspensionReason(), null);
});

test('the key-mode helper only ever reads the value, never reports it', () => {
    const prior = process.env.STRIPE_SECRET_KEY;
    try {
        process.env.STRIPE_SECRET_KEY = 'sk_live_51H8xYzAbCdEfGhIjKlMnOp';
        assert.equal(stripeErrors.stripeKeyMode(), 'live');
        assert.equal(stripeErrors.looksLikeSecretKey(process.env.STRIPE_SECRET_KEY), true);

        process.env.STRIPE_SECRET_KEY = 'sk_test_4eC39HqLyjWDarjtT1zdp7dc';
        assert.equal(stripeErrors.stripeKeyMode(), 'test');
        assert.equal(stripeErrors.looksLikeSecretKey(process.env.STRIPE_SECRET_KEY), true);

        // The two mistakes that produce an opaque "Invalid API Key" from Stripe.
        process.env.STRIPE_SECRET_KEY = 'pk_live_51H8xYzAbCdEfGhIjKlMnOp';
        assert.equal(stripeErrors.looksLikeSecretKey(process.env.STRIPE_SECRET_KEY), false);
        process.env.STRIPE_SECRET_KEY = 'rk_live_51H8xYzAbCdEfGhIjKlMnOp';
        assert.equal(stripeErrors.looksLikeSecretKey(process.env.STRIPE_SECRET_KEY), false);
        assert.equal(stripeErrors.stripeKeyMode(), 'unknown');
    } finally {
        if (prior === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = prior;
    }
});
