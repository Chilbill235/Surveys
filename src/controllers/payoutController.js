const { createHash } = require('node:crypto');
const pool = require('../config/db');
const { parseAmountInRange } = require('../services/money');
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

// ---------------------------------------------------------------------------
// Schema prerequisite
// ---------------------------------------------------------------------------
//
// This controller expects the following migration to have been applied:
//
//   ALTER TABLE withdrawals ADD COLUMN idempotency_key TEXT;
//
//   CREATE UNIQUE INDEX withdrawals_user_idempotency_key_uniq
//       ON withdrawals (user_id, idempotency_key)
//       WHERE idempotency_key IS NOT NULL;
//
// The column is nullable so existing rows and any caller that does not supply a
// key are unaffected. The index is partial so multiple NULLs do not collide.

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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * order. A rejection from any `fn` rejects the whole call; callers that want
 * per-item fallbacks should catch inside `fn`, which is what the two provider
 * reads below do.
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

    // One read per coin per metric, bounded so a large catalogue cannot trip the
    // rate limiter. A single failed read is logged and that coin falls back to
    // the app default; it does not blank the rest of the catalogue.
    const minimumEntries = await mapWithConcurrency(coins, PAYOUT_LIMITS_CONCURRENCY, async (coin) => {
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
            },
        });
    } catch (error) {
        console.error('Could not build withdrawal options response:', error.message);
        return res.status(500).json({ error: 'Failed to load withdrawal options.' });
    }
}

// ---------------------------------------------------------------------------
// Withdrawal validation
// ---------------------------------------------------------------------------

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
// Withdrawal request
// ---------------------------------------------------------------------------

async function requestWithdrawal(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Sign in to request a withdrawal.' });
    }

    const paymentMethod = String(req.body.paymentMethod || '').toLowerCase();
    const paymentAddress = String(req.body.paymentAddress || '').trim();
    const assetCode = String(req.body.assetCode || '').toUpperCase();
    const network = String(req.body.network || '').toLowerCase();
    const destinationTag = normaliseDestinationTag(req.body.destinationTag);

    const amount = parseAmountInRange(req.body.amount, {
        min: minimumWithdrawalUsd,
        max: maximumWithdrawalUsd,
    });
    if (amount === null) {
        return res.status(400).json({
            error: `Enter an amount between $${minimumWithdrawalUsd.toFixed(2)} and $${maximumWithdrawalUsd.toFixed(2)}.`,
        });
    }

    if (!SUPPORTED_PAYMENT_METHODS.has(paymentMethod)) {
        return res.status(400).json({ error: 'Unsupported payment method.' });
    }

    if (
        paymentAddress.length < MIN_PAYMENT_ADDRESS_LENGTH ||
        paymentAddress.length > MAX_PAYMENT_ADDRESS_LENGTH
    ) {
        return res.status(400).json({ error: 'Enter a valid payment destination.' });
    }

    if (paymentMethod === 'crypto') {
        const problem = await validateCryptoWithdrawal({
            assetCode,
            network,
            paymentAddress,
            destinationTag,
        });
        if (problem) return res.status(problem.status).json({ error: problem.error });
    }

    // Computed after validation so a malformed request does not consume an
    // idempotency key that a corrected retry would need.
    const idempotencyKey = resolveIdempotencyKey(req, userId, [
        amount,
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

        return res.status(200).json({
            message: 'Withdrawal request queued for review. Funds have not been sent yet.',
            withdrawalId,
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
    requestWithdrawal,
};

module.exports = payoutController;
module.exports.resetPayoutLimitsCache = resetPayoutLimitsCache;