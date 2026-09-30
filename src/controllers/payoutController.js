const { createHash } = require('node:crypto');
const pool = require('../config/db');
const { parseAmountInRange, formatUsd } = require('../services/money');
const {
    cryptoDestinations,
    fiatMethods,
    minimumWithdrawalUsd,
    maximumWithdrawalUsd,
    isSupportedCryptoDestination,
    isValidCryptoAddress,
    isValidDestinationTag,
    providerCoinFor,
    requiresDestinationTag,
    distinctProviderCoins,
} = require('../services/payoutOptions');
const nowPayments = require('../services/nowPayments');
const withdrawalCode = require('../services/withdrawalCode');
const autoPayouts = require('../services/autoPayouts');

// ---------------------------------------------------------------------------
// Schema prerequisites
// ---------------------------------------------------------------------------
//
// This controller expects the following migrations to have been applied:
//
//   ALTER TABLE withdrawals ADD COLUMN idempotency_key TEXT;
//
//   CREATE UNIQUE INDEX withdrawals_user_idempotency_key_uniq
//       ON withdrawals (user_id, idempotency_key)
//       WHERE idempotency_key IS NOT NULL;
//
// The column is nullable so existing rows and any caller that does not supply a
// key are unaffected. The index is partial so multiple NULLs do not collide.
//
//   The withdrawal-code table and its index live in `services/withdrawalCode`;
//   this controller only consumes the interface.

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

/**
 * Verifies that the two injected services expose the interface this controller
 * actually calls.
 *
 * Without this, a missing or renamed function fails at request time as
 * `TypeError: withdrawalCode.consumeWithdrawalCode is not a function` with a
 * stack trace that names the controller, not the service. The failure surfaces
 * to the user as a 503 from the outer catch, which reads as "the server is
 * having a problem" rather than "the service is not wired up".
 *
 * The check runs at module load, so a misconfigured deployment fails to start
 * rather than failing on the first withdrawal attempt.
 */
function requireFunctions(moduleName, module, names) {
    const missing = names.filter((name) => typeof module?.[name] !== 'function');
    if (missing.length > 0) {
        throw new Error(
            `${moduleName} is missing the function(s) this controller requires: ${missing.join(', ')}. ` +
            'Check that the service exports them and that the require path is correct.'
        );
    }
}

requireFunctions('services/withdrawalCode', withdrawalCode, [
    'issueWithdrawalCode',
    'sendWithdrawalCodeEmail',
    'clearWithdrawalCode',
    'consumeWithdrawalCode',
    'failureMessage',
]);
requireFunctions('services/autoPayouts', autoPayouts, [
    'dispatchPayoutForWithdrawal',
]);

if (typeof withdrawalCode.CODE_PATTERN?.test !== 'function') {
    throw new Error(
        'services/withdrawalCode must export CODE_PATTERN as a RegExp so the controller can ' +
        'reject a malformed code before spending a database round-trip on it.'
    );
}
if (!Number.isInteger(withdrawalCode.CODE_LIFETIME_MINUTES)) {
    throw new Error(
        'services/withdrawalCode must export CODE_LIFETIME_MINUTES as an integer so the ' +
        'controller can tell the user how long the emailed code lasts.'
    );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const PAYOUT_LIMITS_TTL_MS = 5 * 60 * 1000;

/**
 * Parallelism cap for the per-coin provider reads. High enough that a normal
 * catalogue reads in a second or two, low enough that a large catalogue cannot
 * trip the provider's per-second rate limit in a single burst.
 */
const PAYOUT_LIMITS_CONCURRENCY = 4;

const MIN_PAYMENT_ADDRESS_LENGTH = 3;
const MAX_PAYMENT_ADDRESS_LENGTH = 254;

const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The fallback window for a client that does not send an idempotency key.
 *
 * Two identical withdrawal requests from the same user inside this window are
 * treated as one. Long enough to catch a double-tap or a retried fetch; short
 * enough that a user who genuinely wants to send the same amount to the same
 * address twice in a row is not silently blocked, because the second request
 * lands outside the bucket.
 */
const FALLBACK_IDEMPOTENCY_WINDOW_SECONDS = 30;

/**
 * The answer served when the provider cannot be consulted at all. Frozen so a
 * handler cannot accidentally mutate the shared object between requests.
 */
const APP_DEFAULT_LIMITS = Object.freeze({
    minimums: {},
    fees: {},
    minimumsSource: 'app-default',
    feesSource: 'app-default',
    // Not merely "no provider figures": the provider refused to answer, so the app's $1.00 floor
    // is known to be this app's own rule and not something the provider has agreed to. The
    // withdrawal form says so, rather than presenting an unconfirmed number as a limit.
    minimumsConfirmed: false,
});

/**
 * The methods this endpoint actually accepts, derived from the list the options
 * endpoint advertises. Hard-coding a second list here used to mean a method
 * could appear in the picker and then be rejected at submit time, or vice versa.
 */
const SUPPORTED_PAYMENT_METHODS = new Set([
    ...fiatMethods
        .map((method) => String(method?.value || '').toLowerCase())
        .filter(Boolean),
    'crypto',
]);

/**
 * Human-readable names for the fiat methods, so the email does not say "paypal"
 * or "bank transfer" for a method whose label in the picker is something else.
 *
 * Built from `fiatMethods` at module load rather than hard-coded, because the
 * list of methods lives there and a method added to the picker without a name
 * here would render its raw `value` in the email.
 */
const METHOD_LABELS = new Map(
    fiatMethods
        .filter((method) => method?.value && method?.label)
        .map((method) => [String(method.value).toLowerCase(), String(method.label)])
);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving order.
 * A rejection from any `fn` rejects the whole call; callers that want per-item
 * fallbacks should catch inside `fn`, which is what the two provider reads below do.
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from(
        { length: Math.max(1, Math.min(limit, items.length)) },
        async () => {
            for (;;) {
                const index = cursor++;
                if (index >= items.length) return;
                results[index] = await fn(items[index], index);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

/**
 * Normalises an optional destination tag. The `||` form used previously turned
 * a numeric `0` into `null`, because `0 || ''` is `''`. Tags are strings in
 * practice, but a client that sends `0` for a tag-less chain, or a chain that
 * genuinely uses tag 0, must not have it silently dropped.
 */
function normaliseDestinationTag(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Normalises the amount for use in a fingerprint. `0.1 + 0.2` is
 * `0.30000000000000004` in JavaScript, and using the raw float's string form
 * in a hash means a fingerprint taken from a slightly different float is a
 * different fingerprint. Rounding to cents produces the number the user typed,
 * which is what the request actually means.
 */
function normalizeAmountForFingerprint(amount) {
    return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

/**
 * Builds the idempotency key for a withdrawal request.
 *
 * A client-supplied key wins outright: it is the only form that can distinguish
 * "the user meant to do this twice" from "the client retried once", because
 * only the client knows. The fallback is a fingerprint of the request scoped to
 * a short time bucket, which handles the double-click case the client did not
 * explicitly mark.
 *
 * The user id is included so a key cannot collide across accounts, and the
 * bucket is computed server-side so a client cannot widen it.
 */
function resolveIdempotencyKey(req, userId, fingerprintParts) {
    const supplied = String(
        req.get(IDEMPOTENCY_HEADER) || req.body?.idempotencyKey || ''
    ).trim();
    if (supplied && supplied.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return supplied;

    const bucket = Math.floor(Date.now() / (FALLBACK_IDEMPOTENCY_WINDOW_SECONDS * 1000));
    const fingerprint = [userId, bucket, ...fingerprintParts]
        .map((part) => String(part ?? ''))
        .join('|');
    return `auto:${createHash('sha256').update(fingerprint).digest('hex')}`;
}

/**
 * The single string a confirmation code is bound to, so both sides compare the
 * same value. Crypto includes the tag; fiat is just the address.
 *
 * Exported implicitly through `validateWithdrawalRequest`'s return so the code
 * path and the submit path cannot disagree on this value. A disagreement would
 * make every code "invalid" for the request it was issued for.
 */
function destinationFor(paymentMethod, paymentAddress, destinationTag) {
    if (paymentMethod !== 'crypto') return paymentAddress;
    return destinationTag ? `${paymentAddress}:${destinationTag}` : paymentAddress;
}

/**
 * The label shown in the confirmation email and the response body.
 *
 * Two things the previous version got wrong:
 *   - `.toUpperCase()` was applied to the *whole* joined string, so "BTC on
 *     Ethereum" became "BTC ON ETHEREUM". The asset code is uppercased because
 *     that is its canonical form; the network name is not, because it is a
 *     proper noun.
 *   - The fallback for a fiat method was the string `"Bank transfer"`, which is
 *     wrong for anything that is not actually a bank transfer. The label now
 *     comes from `fiatMethods`, so a method added to the picker is rendered
 *     with the label the picker shows.
 */
function withdrawalMethodLabel(paymentMethod, assetCode, network) {
    if (paymentMethod === 'crypto') {
        const parts = [String(assetCode || '').toUpperCase()];
        if (network) parts.push(String(network));
        const label = parts.filter(Boolean).join(' on ');
        return label || 'Cryptocurrency';
    }
    return METHOD_LABELS.get(paymentMethod) || paymentMethod;
}

// ---------------------------------------------------------------------------
// Payout limits cache
// ---------------------------------------------------------------------------

let payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };

/**
 * The cache only describes the account the current credentials point at.
 * Rotating the API key, or pointing at a different host, changes which coins
 * are payable and what they cost, so the cached answer is not reusable across
 * a credential change.
 */
function payoutLimitsIdentity() {
    return `${nowPayments.getApiKey()}|${nowPayments.getBaseUrl()}`;
}

/** Drops the cached provider limits answer. Used by tests and after a credential change. */
function resetPayoutLimitsCache() {
    payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };
}

async function fetchPayoutLimits() {
    const coins = distinctProviderCoins();

    // The provider's refusal is per account, not per coin, so it is worth spending one request
    // to find out before spending fourteen. `getPayoutMinimum` already skips calls made inside
    // the cool-off, but the fan-out is concurrent: every worker starts before the first refusal
    // has come back, so the guard cannot help until the burst is already in the air. Probing
    // first turns "a dozen guaranteed refusals per refresh" into one.
    //
    // A null probe on its own is not enough to stop. It also means the provider answered with
    // no usable figure, and skipping the rest of the catalogue for that would leave every coin
    // on the app default because one coin had an odd window. Only an actual refusal stops it.
    let probed = null;
    if (coins.length > 0) probed = await nowPayments.getPayoutMinimum(coins[0]);
    const minimumsRefused = probed === null && nowPayments.isPayoutMinimumRefused();

    // One read per coin per metric, bounded so a large catalogue cannot trip the
    // rate limiter. A single failed read is logged and that coin falls back to
    // the app default; it does not blank the rest of the catalogue.
    const minimumEntries = minimumsRefused
        ? []
        : await mapWithConcurrency(coins, PAYOUT_LIMITS_CONCURRENCY, async (coin) => {
            try {
                return [coin, await nowPayments.getPayoutMinimum(coin)];
            } catch (error) {
                console.warn(`Could not read the ${coin} payout minimum: ${error.message}`);
                return [coin, null];
            }
        });

    const feeEntries = await mapWithConcurrency(coins, PAYOUT_LIMITS_CONCURRENCY, async (coin) => {
        try {
            return [coin, await nowPayments.getPayoutFee(coin, 1)];
        } catch (error) {
            console.warn(`Could not read the ${coin} payout fee: ${error.message}`);
            return [coin, null];
        }
    });

    const minimums = {};
    for (const [coin, value] of minimumEntries) {
        if (value !== null && value !== undefined) minimums[coin] = value;
    }

    const fees = {};
    for (const [coin, value] of feeEntries) {
        if (value !== null && value !== undefined) fees[coin] = value;
    }

    return {
        minimums,
        fees,
        minimumsSource: Object.keys(minimums).length > 0 ? 'provider' : 'app-default',
        feesSource: Object.keys(fees).length > 0 ? 'provider' : 'app-default',
        // Reported so the withdrawal form can say that a $1.00 crypto request is this app's own
        // floor and not one the provider has agreed to. Without it the form states a minimum it
        // has not been able to confirm, and the first thing a user learns is a refusal at
        // submission time, after they have committed to the request.
        minimumsConfirmed: !minimumsRefused
    };
}

async function getPayoutLimits() {
    if (!nowPayments.isConfigured() || !nowPayments.isTrustedBaseUrl()) {
        return APP_DEFAULT_LIMITS;
    }

    const identity = payoutLimitsIdentity();
    const previous = payoutLimitsCache;
    const sameIdentity = previous.identity === identity;

    if (sameIdentity) {
        if (previous.value && Date.now() < previous.expiresAt) {
            return previous.value;
        }
        // Concurrent callers share one refresh. Without this, opening the
        // withdrawal form in two tabs doubles the provider requests, and the
        // rate limiter makes the second one wait.
        if (previous.inFlight) {
            return previous.inFlight;
        }
    }

    const inFlight = fetchPayoutLimits()
        .then((value) => {
            // Only store it if the credentials are still the ones it was read
            // with. A stale read that lands after a credential change must not
            // overwrite the newer answer.
            if (payoutLimitsCache.identity === identity) {
                payoutLimitsCache.value = value;
                payoutLimitsCache.expiresAt = Date.now() + PAYOUT_LIMITS_TTL_MS;
            }
            return value;
        })
        .catch((error) => {
            console.error('Failed to update payout limits cache:', error.message);
            // A refresh failure is not evidence the previous values were wrong:
            // serve the last good answer if the identity still matches, so a
            // transient provider outage does not blank every coin's minimum and
            // fee on the withdrawal form.
            return sameIdentity && previous.value ? previous.value : APP_DEFAULT_LIMITS;
        })
        .finally(() => {
            // Guarded by identity so a read that belonged to the previous
            // credentials cannot clear the in-flight marker of the current one.
            if (payoutLimitsCache.identity === identity) {
                payoutLimitsCache.inFlight = null;
            }
        });

    // Replace the whole cache object rather than mutating it in place. A
    // partially-updated object is what let a stale read's `.finally` clobber a
    // newer read's state under the previous implementation.
    payoutLimitsCache = {
        identity,
        value: sameIdentity ? previous.value : null,
        expiresAt: sameIdentity ? previous.expiresAt : 0,
        inFlight,
    };
    return inFlight;
}

// ---------------------------------------------------------------------------
// Shared withdrawal validation
// ---------------------------------------------------------------------------

/**
 * Validates every part of a withdrawal request that does not depend on the
 * database.
 *
 * Both `sendWithdrawalCode` and `requestWithdrawal` used to perform this same
 * validation as separate inline blocks. Two copies that must stay in step is a
 * recipe for the code path to issue a confirmation code for a request the
 * submit path then refuses -- which reaches the user as "your code is invalid"
 * for a code that was fine, and sends them back to the form to try again.
 *
 * Returns `{ ok: true, data }` on success and `{ ok: false, status, error }`
 * on any failure, so the caller is a linear sequence of returns rather than a
 * nest of `if` blocks.
 */
async function validateWithdrawalRequest(body) {
    const paymentMethod = String(body.paymentMethod || '').toLowerCase();
    const paymentAddress = String(body.paymentAddress || '').trim();
    const assetCode = String(body.assetCode || '').toUpperCase();
    const network = String(body.network || '').toLowerCase();
    const destinationTag = normaliseDestinationTag(body.destinationTag);

    const amount = parseAmountInRange(body.amount, {
        min: minimumWithdrawalUsd,
        max: maximumWithdrawalUsd,
    });
    if (amount === null) {
        return {
            ok: false,
            status: 400,
            error: `Enter an amount between $${formatUsd(minimumWithdrawalUsd)} and $${formatUsd(maximumWithdrawalUsd)}.`,
        };
    }

    if (!SUPPORTED_PAYMENT_METHODS.has(paymentMethod)) {
        return { ok: false, status: 400, error: 'Unsupported payment method.' };
    }

    if (
        paymentAddress.length < MIN_PAYMENT_ADDRESS_LENGTH ||
        paymentAddress.length > MAX_PAYMENT_ADDRESS_LENGTH
    ) {
        return { ok: false, status: 400, error: 'Enter a valid payment destination.' };
    }

    if (paymentMethod === 'crypto') {
        const problem = await validateCryptoWithdrawal({
            assetCode,
            network,
            paymentAddress,
            destinationTag,
        });
        if (problem) return { ok: false, ...problem };
    }

    return {
        ok: true,
        data: {
            paymentMethod,
            paymentAddress,
            assetCode,
            network,
            destinationTag,
            amount,
            destination: destinationFor(paymentMethod, paymentAddress, destinationTag),
        },
    };
}

/**
 * Validates everything about a crypto withdrawal that can be checked before the
 * database is touched: asset, network, address format, destination tag, and the
 * provider's own address check.
 *
 * Returns null when the request is acceptable, or a `{ status, error }` object
 * the caller should return verbatim. This shape keeps the handler a linear
 * sequence of `if (problem) return send(problem)` rather than a deep nest.
 */
async function validateCryptoWithdrawal({ assetCode, network, paymentAddress, destinationTag }) {
    if (!isSupportedCryptoDestination(assetCode, network)) {
        return { status: 400, error: 'Choose a supported crypto asset and network.' };
    }

    if (!isValidCryptoAddress(assetCode, network, paymentAddress)) {
        return {
            status: 400,
            error: 'That address does not match the valid format for the selected network.',
        };
    }

    if (requiresDestinationTag(assetCode)) {
        if (!destinationTag) {
            return { status: 400, error: 'This network requires a destination tag or memo.' };
        }
        if (!isValidDestinationTag(assetCode, destinationTag)) {
            return { status: 400, error: 'The destination tag format is invalid.' };
        }
    }

    // The local validator already passed. The provider check is a second
    // opinion, so a provider outage should not block every crypto withdrawal:
    // the request proceeds and the operator sees the failure in the log. This
    // is a deliberate policy choice, and the reverse (failing closed) would turn
    // a transient provider incident into a total crypto payout outage.
    const coin = providerCoinFor(assetCode, network);
    let verdict = { checked: false };
    try {
        verdict = await nowPayments.validatePayoutAddress(paymentAddress, coin, {
            extraId: destinationTag,
        });
    } catch (error) {
        console.warn(`Provider address validation was unavailable for ${coin}: ${error.message}`);
    }

    if (verdict.checked && verdict.valid === false) {
        return {
            status: 400,
            error: verdict.reason
                ? `Address validation failed: ${verdict.reason}`
                : 'Address is invalid or unroutable on the selected chain.',
        };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Options endpoint
// ---------------------------------------------------------------------------

async function withdrawalOptions(req, res) {
    let limits = APP_DEFAULT_LIMITS;
    try {
        limits = await getPayoutLimits();
    } catch (error) {
        console.error('Could not load NOWPayments payout limits:', error.message);
    }

    try {
        return res.json({
            methods: [
                ...fiatMethods,
                {
                    value: 'crypto',
                    label: 'Cryptocurrency',
                    hint: 'Sent to a wallet address you control. Check the network carefully.',
                },
            ],
            assets: cryptoDestinations.map((asset) => ({
                code: asset.assetCode,
                label: asset.label,
                symbol: asset.symbol,
                addressHint: asset.addressHint,
                requiresDestinationTag: requiresDestinationTag(asset.assetCode),
                networks: asset.networks.map((network) => ({
                    value: network.value,
                    label: network.label,
                    addressHint: network.addressHint || asset.addressHint,
                    providerCoin: network.providerCoin,
                    minimumCoin: limits.minimums[network.providerCoin] ?? null,
                    estimatedFeeCoin: limits.fees[network.providerCoin] ?? null,
                })),
            })),
            minimumUsd: minimumWithdrawalUsd,
            maximumUsd: maximumWithdrawalUsd,
            limitsSource: {
                minimums: limits.minimumsSource,
                fees: limits.feesSource,
                // Whether the per-network floors were actually read from the provider this
                // refresh. `minimumsSource` alone cannot carry this: an account the provider
                // refuses leaves `minimums` empty, which is the same shape as "the provider
                // answered and reported nothing", and only the first of those means the
                // displayed floor is unverified.
                minimumsConfirmed: limits.minimumsConfirmed !== false,
            },
        });
    } catch (error) {
        console.error('Could not build withdrawal options response:', error.message);
        return res.status(500).json({ error: 'Failed to load withdrawal options.' });
    }
}

// ---------------------------------------------------------------------------
// Withdrawal code
// ---------------------------------------------------------------------------

/**
 * Emails a confirmation code for one specific withdrawal.
 *
 * The amount and destination are part of the request, not of the confirmation, and the code is
 * stored bound to both. That is the point: a code is not permission to withdraw, it is
 * permission for the withdrawal the user was actually looking at when it was sent. Without the
 * binding, a code requested for a $1 sanity check would authorise a $10,000 payout to an
 * address chosen afterwards, which is the case the check exists to prevent.
 *
 * Every input is validated exactly as it is for the real withdrawal, so a code is never issued
 * for a request that could not have been made. Validating here and not there would let a user
 * be sent a code for a payout the server would refuse, and then discover the refusal only after
 * reading the code.
 *
 * The balance is also checked here, which the earlier version did not do. A user with $0 could
 * request a code for $100, receive it, and only discover the problem on submit -- a wasted
 * email and a confusing failure for something the server already knew.
 */
async function sendWithdrawalCode(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Sign in to request a withdrawal.' });
    }

    const validated = await validateWithdrawalRequest(req.body);
    if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
    }
    const { amount, destination, paymentMethod, assetCode, network } = validated.data;

    try {
        const userRes = await pool.query('SELECT email, balance FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const { email, balance } = userRes.rows[0];
        const currentBalance = Number(balance);

        // The same non-finite guard the submit path uses, so a corrupt balance row produces one
        // consistent refusal rather than a code issued and then a submit rejected.
        if (!Number.isFinite(currentBalance)) {
            console.error(`User ${userId} has a non-numeric balance; refusing to issue a code.`);
            return res.status(500).json({ error: 'Internal server error processing payout.' });
        }
        if (currentBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance.' });
        }

        const { code } = await withdrawalCode.issueWithdrawalCode({
            userId,
            amount,
            destination,
            email
        });

        const delivery = await withdrawalCode.sendWithdrawalCodeEmail({
            to: email,
            code,
            amount,
            destination,
            methodLabel: withdrawalMethodLabel(paymentMethod, assetCode, network)
        });
        if (!delivery.sent) {
            // The row exists but nothing was sent, so a code the user never receives would
            // otherwise be waiting to be guessed. Cleared rather than left to expire.
            //
            // If the delete itself fails, that code is still live: unconsumed, unexpired, and
            // worth five guesses to anyone trying. The user is told 503 either way, so the
            // request outcome does not change -- but the two states are not the same and the
            // operator has to be able to tell them apart. The old `.catch(() => {})` made a
            // surviving code indistinguishable from a cleared one.
            await clearDeliveredCodeOrWarn(userId, 'delivery failed');
            console.error(`Withdrawal confirmation email was not delivered (${delivery.reason}).`);
            return res.status(503).json({ error: 'Could not email a confirmation code right now.' });
        }

        return res.json({
            sent: true,
            expiresInMinutes: withdrawalCode.CODE_LIFETIME_MINUTES
        });
    } catch (error) {
        console.error('Withdrawal confirmation failed:', error.message);
        // Same reasoning as the undelivered case above: the code may well have been written
        // before the failure, and a code the user never received is still five guesses for
        // whoever is guessing.
        await clearDeliveredCodeOrWarn(userId, 'request threw');
        return res.status(503).json({ error: 'Could not email a confirmation code right now.' });
    }
}

/**
 * Deletes an undelivered withdrawal code, and says so loudly if the delete did not happen.
 *
 * Exists because the failure being guarded is not visible anywhere else. The user is told
 * 503 either way, the request looks identical, and the code row is the only evidence that a
 * live six-digit code now exists for a message nobody received. A silent `.catch` made that
 * survivable: the row expired eventually, and in the meantime it was a valid, guessable
 * credential belonging to a user who has been told nothing was sent.
 *
 * The caller does not get a boolean because it cannot act on one -- the response is 503
 * regardless. This is a reporting obligation, not a control flow one.
 */
async function clearDeliveredCodeOrWarn(userId, context) {
    try {
        await withdrawalCode.clearWithdrawalCode(userId);
    } catch (error) {
        console.error(
            `SECURITY: withdrawal code for user ${userId} was NOT cleared after the ${context} `
            + `(${error.message}). It stays valid until it expires and can be spent; it should be `
            + 'deleted by hand.'
        );
    }
}

// ---------------------------------------------------------------------------
// Withdrawal request
// ---------------------------------------------------------------------------

async function requestWithdrawal(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Sign in to request a withdrawal.' });
    }

    const validated = await validateWithdrawalRequest(req.body);
    if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
    }
    const { paymentMethod, paymentAddress, assetCode, network, destinationTag, amount, destination } = validated.data;

    // The confirmation code is checked before the idempotency key is resolved, so a request
    // that is going to be refused anyway does not burn the key a corrected retry needs.
    //
    // Note the trade-off: on a double-click, the second request carries a code the first call
    // has already consumed, so it fails with "invalid code" rather than being recognised as a
    // duplicate. The frontend should disable the submit button after the first click. Doing
    // this the other way -- resolving the idempotency key first and short-circuiting on a
    // duplicate -- would mean a code typed wrong and corrected still collides with the
    // abandoned attempt's key, which is worse.
    //
    // Checked before the balance is read and debited, which is the whole reason for the check:
    // a session token alone must not be enough to move money out of an account.
    const submittedCode = String(req.body.code || '').trim();
    if (!withdrawalCode.CODE_PATTERN.test(submittedCode)) {
        return res.status(400).json({ error: withdrawalCode.failureMessage('missing') });
    }

    try {
        const verdict = await withdrawalCode.consumeWithdrawalCode({
            userId,
            code: submittedCode,
            amount,
            destination
        });
        if (!verdict.ok) {
            return res.status(400).json({ error: withdrawalCode.failureMessage(verdict.reason) });
        }
    } catch (error) {
        console.error('Withdrawal code check failed:', error.message);
        // Fails closed. An error here is indistinguishable, to an attacker, from "no code was
        // supplied", so letting the request through on a database fault would turn a transient
        // database problem into an unprotected payout path.
        return res.status(503).json({ error: 'Could not confirm this withdrawal right now. Try again.' });
    }

    // Computed after validation so a malformed request does not consume an
    // idempotency key that a corrected retry would need.
    //
    // The amount is normalised before it goes into the fingerprint because
    // `String(0.1 + 0.2)` is `"0.30000000000000004"`, and a fingerprint taken
    // from a slightly different float is a different fingerprint.
    const idempotencyKey = resolveIdempotencyKey(req, userId, [
        normalizeAmountForFingerprint(amount),
        paymentMethod,
        paymentAddress,
        assetCode,
        network,
        destinationTag,
    ]);

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const userRes = await client.query(
            'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found.' });
        }

        const currentBalance = Number(userRes.rows[0].balance);
        // A non-finite balance would make `currentBalance < amount` false and
        // let the deduction through on a corrupt row. Refusing here is safer
        // than silently writing a bad ledger entry.
        if (!Number.isFinite(currentBalance)) {
            await client.query('ROLLBACK');
            console.error(`User ${userId} has a non-numeric balance; refusing withdrawal.`);
            return res.status(500).json({ error: 'Internal server error processing payout.' });
        }
        if (currentBalance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance.' });
        }

        // The insert is the point where idempotency is decided, not the balance
        // check: a retry that arrives after the first request committed will
        // find a balance that already reflects the first deduction, and would
        // therefore fail with "Insufficient balance" rather than being recognised
        // as a retry. The unique index catches it instead, and the `RETURNING`
        // row is empty exactly when the key was already used.
        const withdrawalRes = await client.query(
            `INSERT INTO withdrawals
                (user_id, amount, payment_method, payment_address, asset_code, network,
                 destination_tag, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
             DO NOTHING
             RETURNING id`,
            [
                userId,
                amount,
                paymentMethod,
                paymentAddress,
                paymentMethod === 'crypto' ? assetCode : null,
                paymentMethod === 'crypto' ? network : null,
                paymentMethod === 'crypto' ? destinationTag : null,
                idempotencyKey,
            ]
        );

        if (withdrawalRes.rows.length === 0) {
            // The key was already used. Re-read the original row so the caller
            // gets the same withdrawal id it would have received the first time.
            await client.query('ROLLBACK');
            const existing = await pool.query(
                `SELECT id FROM withdrawals WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, idempotencyKey]
            );
            return res.status(200).json({
                message: 'Withdrawal request already queued for review.',
                withdrawalId: existing.rows[0]?.id ?? null,
                duplicate: true,
            });
        }

        const withdrawalId = withdrawalRes.rows[0].id;

        // The balance deduction happens after the insert, so an idempotent retry
        // never reaches this line and cannot double-debit.
        await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2',
            [amount, userId]
        );

        await client.query(
            `INSERT INTO balance_transactions
                (user_id, amount, transaction_type, source_id, description)
             VALUES ($1, $2, 'withdrawal', $3, 'Withdrawal request queued')`,
            [userId, -amount, String(withdrawalId)]
        );

        await client.query('COMMIT');

        // The transaction is finished and this handler has no further use for the connection.
        // It is handed back here rather than left to the `finally` below, because the automatic
        // payout below is two provider calls -- a batch create and a 2FA verification, each with
        // its own multi-second timeout -- and the dispatch takes a connection of its own while it
        // claims the row. Holding this one across all of that costs the pool a connection for up
        // to a minute per withdrawal, and the pool is what every other request in the app reads
        // and writes through: enough concurrent withdrawals and the whole API stalls behind
        // requests that are only waiting on NOWPayments. `client` is cleared so the `catch` and
        // `finally` below do not release it a second time.
        client.release();
        client = null;

        // The withdrawal is now real and the balance is debited, so the payout is attempted
        // from here rather than waiting for a scheduled run: the user asked to be paid, and
        // the point of automatic payouts is that nobody has to notice their request afterwards.
        //
        // This runs after the commit and cannot fail the request. A provider outage here
        // leaves the withdrawal `pending` in the queue for the batch run or an operator,
        // which is where it would have been anyway. Failing the response instead would be
        // actively harmful: the user would retry, and the retry is a second withdrawal.
        let automaticPayout = null;
        if (paymentMethod === 'crypto') {
            try {
                const outcome = await autoPayouts.dispatchPayoutForWithdrawal({
                    withdrawalId,
                    convertToCoin: autoPayouts.usdToCoin
                });
                if (outcome?.attempted) automaticPayout = outcome;
            } catch (error) {
                console.error(`Automatic payout for withdrawal ${withdrawalId} did not complete:`, error.message);
            }
        }

        return res.status(200).json({
            message: automaticPayout?.verified
                ? 'Withdrawal sent. It will be confirmed on-chain shortly.'
                : 'Withdrawal request queued for review. Funds have not been sent yet.',
            withdrawalId,
            ...(automaticPayout
                ? { payout: { batchId: automaticPayout.batchId, sent: automaticPayout.verified } }
                : {}),
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('Payout Request Error:', error.message);
        return res.status(500).json({ error: 'Internal server error processing payout.' });
    } finally {
        if (client) client.release();
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const payoutController = {
    withdrawalOptions,
    sendWithdrawalCode,
    requestWithdrawal,
};

module.exports = payoutController;
module.exports.resetPayoutLimitsCache = resetPayoutLimitsCache;
// Exposed for the tests, which need to drive one refresh and inspect what it cost. The
// controller's own request handlers go through the cache, so there is no other way to observe
// the fan-out without standing up the whole route and a fake provider.
module.exports.fetchPayoutLimits = fetchPayoutLimits;
module.exports.__private = { validateWithdrawalRequest, withdrawalMethodLabel };