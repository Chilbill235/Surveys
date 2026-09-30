/**
 * Turns a Stripe exception into a response, a log line, and a decision about whether cards
 * should still be offered.
 *
 * Why this is its own module
 * --------------------------
 * A Stripe Checkout failure has three very different shapes, and the app used to treat them
 * as one. All of them reached the customer as a 502 reading "Could not create a deposit with
 * the selected provider", and all of them left the card button enabled, so every customer
 * walked into the same wall and every retry produced the same dead end.
 *
 *   - The account cannot take charges at all. `Your account cannot currently make live
 *     charges.` is Stripe refusing on account state, not on the request. The key is fine,
 *     the code is fine, and nothing the customer does will change the answer, so the only
 *     useful behaviour is to stop offering cards and say so in words that name the cause.
 *   - The credential is wrong or under-permissioned. Same shape from the customer's side,
 *     different fix for the operator.
 *   - The request itself was refused, or the network failed. This one can be retried, and
 *     saying so is the difference between a user who comes back and one who does not.
 */

/**
 * How long a confirmed account-level failure keeps cards hidden.
 *
 * Long enough that a customer who reloads does not walk into the same refusal, short enough
 * that fixing the dashboard and redeploying is not the only way back: after this, cards
 * reappear and the next attempt finds out for itself. Ten minutes is a guess at "long enough
 * to stop the repeat, short enough that it is not a manual reset button".
 */
const CARD_SUSPENSION_MS = 10 * 60 * 1000;

/** Set while cards are known to be unusable, with the reason and when it was noticed. */
let suspension = null;

/**
 * The live/test mode the configured key is in.
 *
 * Only ever logged, never shown to a customer: it is a fact about the deployment, and the
 * customer's own card is the same either way. It is the first thing anyone checks when
 * "live charges" is the error, because the two causes look identical from the outside and
 * have opposite fixes.
 */
function stripeKeyMode() {
    const key = process.env.STRIPE_SECRET_KEY || '';
    if (/^sk_test_/.test(key)) return 'test';
    if (/^sk_live_/.test(key)) return 'live';
    return 'unknown';
}

function suspendCards(reason) {
    suspension = { reason, until: Date.now() + CARD_SUSPENSION_MS };
    console.error(`Card deposits suspended for ${CARD_SUSPENSION_MS / 60000} minutes: ${reason}`);
}

/** Clears the suspension after a session is created successfully. */
function clearSuspension() {
    if (suspension) suspension = null;
}

/** The reason cards are currently hidden, or null. Exported for the payment options response. */
function cardSuspensionReason() {
    if (!suspension) return null;
    if (suspension.until <= Date.now()) {
        suspension = null;
        return null;
    }
    return suspension.reason;
}

/** Forgets the suspension. Tests, and nothing else. */
function resetSuspension() {
    suspension = null;
}

/**
 * Whether the key looks like one Stripe would accept as a secret key at all.
 *
 * Cheap and local: it saves a network round trip and a confusing `Invalid API Key` for the
 * two shapes that are certainly wrong -- a publishable key pasted into the secret slot, and
 * the `rk_` restricted key used where a full key is required for Checkout.
 */
function looksLikeSecretKey(key) {
    if (typeof key !== 'string') return false;
    const trimmed = key.trim();
    return /^sk_(test|live)_[A-Za-z0-9]{8,}$/.test(trimmed);
}

/**
 * Classifies a thrown Stripe error.
 *
 * `suspends` is the important field: true for the failures where no retry can succeed, which
 * is the signal to hide the card button for a while instead of inviting another attempt.
 */
function describeStripeFailure(error) {
    const type = error?.type || '';
    const code = error?.code || error?.error?.code || '';
    const message = String(error?.message || error || 'unknown Stripe error');
    const haystack = `${type} ${code} ${message}`.toLowerCase();

    // Account-level. Stripe words this several ways depending on where in onboarding the
    // account is, so the check is on the meaning rather than on one exact sentence.
    const accountBlocked =
        haystack.includes('cannot currently make live charges')
        || haystack.includes('cannot accept charges')
        || haystack.includes('not enabled to accept')
        || haystack.includes('account_invalid')
        || haystack.includes('account is inactive')
        || haystack.includes('account_country_invalid')
        || haystack.includes('account_capability')
        || haystack.includes('charges_disabled');

    if (accountBlocked) {
        return {
            status: 503,
            suspends: true,
            // Customer-facing. Does not repeat Stripe's sentence, because the sentence names
            // a problem the customer cannot act on and reads as though they caused it.
            error: 'Card deposits are unavailable right now. You can deposit with cryptocurrency instead.',
            log: `Stripe refused charges at the account level (type=${type || 'none'}, code=${code || 'none'}, ` +
                `key mode=${stripeKeyMode()}): ${message}. Card deposits stay hidden for ` +
                `${CARD_SUSPENSION_MS / 60000} minutes. Live charges require an activated Stripe account: ` +
                'finish verification in the Stripe dashboard, or point STRIPE_SECRET_KEY at a test key ' +
                '(sk_test_...) for a sandbox run.'
        };
    }

    if (type === 'StripeAuthenticationError' || haystack.includes('invalid api key') || haystack.includes('api_key_invalid')) {
        return {
            status: 503,
            suspends: true,
            error: 'Card deposits are unavailable right now. You can deposit with cryptocurrency instead.',
            log: `Stripe rejected the API key (key mode=${stripeKeyMode()}): ${message}. ` +
                'STRIPE_SECRET_KEY must be the account secret key (sk_...), not a publishable key.'
        };
    }

    if (type === 'StripePermissionError') {
        return {
            status: 503,
            suspends: true,
            error: 'Card deposits are unavailable right now. You can deposit with cryptocurrency instead.',
            log: `Stripe refused the key's permissions: ${message}. The key needs write access to Checkout Sessions.`
        };
    }

    if (type === 'StripeRateLimitError') {
        // Retryable, so cards stay available: a rate limit is this request's problem, not
        // the account's, and hiding the button would turn a few seconds of backpressure
        // into a visible outage.
        return {
            status: 429,
            suspends: false,
            error: 'Too many deposit attempts in a short time. Please wait a moment and try again.',
            log: `Stripe rate limited the deposit: ${message}`
        };
    }

    if (type === 'StripeConnectionError') {
        return {
            status: 502,
            suspends: false,
            error: 'Card payments are temporarily unreachable. Please try again in a moment.',
            log: `Could not reach Stripe: ${message}`
        };
    }

    if (type === 'StripeInvalidRequestError') {
        // A bad request is ours, not the customer's: an unsupported currency, a malformed
        // line item, a missing capability. It says so in the log and answers plainly, but
        // does not hide the button, because the next attempt may well be a different one.
        return {
            status: 400,
            suspends: false,
            error: 'Card deposits could not be started. Please try again or use cryptocurrency.',
            log: `Stripe rejected the checkout request (type=${type}, code=${code || 'none'}, key mode=${stripeKeyMode()}): ${message}`
        };
    }

    if (type === 'StripeCardError') {
        return {
            status: 400,
            suspends: false,
            error: 'That card was declined. Please try a different card.',
            log: `Stripe declined the card (code=${code || 'none'}): ${message}`
        };
    }

    return {
        status: 502,
        suspends: false,
        error: 'Could not create a deposit with the selected provider.',
        log: `Unrecognised Stripe failure (type=${type || 'none'}, code=${code || 'none'}): ${message}`
    };
}

module.exports = {
    CARD_SUSPENSION_MS,
    describeStripeFailure,
    suspendCards,
    clearSuspension,
    cardSuspensionReason,
    resetSuspension,
    stripeKeyMode,
    looksLikeSecretKey,
};
