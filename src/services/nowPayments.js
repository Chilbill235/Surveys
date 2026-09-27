/**
 * NOWPayments API client.
 *
 * Every call to the provider used to be built inline, in two files that each had their own
 * copy of the base URL, the `x-api-key` header, the trusted-host check, and the timeout.
 * That is how the currency list ended up being read from a different endpoint than the one
 * it should have used while the reconciler still called the right one. The provider
 * contract now lives here, in the order the vendor documents it.
 *
 * Endpoints implemented, per the "API and endpoint description" reference:
 *
 *   Authorization
 *     POST /v1/auth                                  JWT for payout requests (5 min)
 *   Payments
 *     GET  /v1/merchant/coins                        currencies this merchant can accept
 *     GET  /v1/currencies                            fallback currency list
 *     GET  /v1/currencies?fixed_rate=true            fallback with min/max
 *     GET  /v1/min-amount                            real minimum for a currency pair
 *     POST /v1/payment                                create a payment
 *     GET  /v1/payment/{payment_id}                   payment status / confirmation
 *   Payouts
 *     POST /v1/payout/validate-address                authoritative address validation
 *     GET  /v1/payout/fee                             network fee estimate
 *     GET  /v1/payout-withdrawal/min-amount/{coin}    minimum payout for a coin
 */

const { createHmac, timingSafeEqual } = require('node:crypto');

const PRODUCTION_BASE_URL = 'https://api.nowpayments.io';

/**
 * Documented per-endpoint rate limits, in requests per second.
 *
 * NOWPayments publishes these: 3 RPS on create-payment and 7 RPS on estimate. Creating a
 * payment has no limit of its own in the app, so a user who taps the button repeatedly, or
 * a burst of concurrent requests, gets HTTP 429 from the provider and every one of those
 * deposits is failed and closed out by the catch in `createDeposit`. The deposit is
 * marked failed before the provider is ever consulted, so a 429 destroys a deposit the
 * user never had a chance to pay. The limiter serialises calls instead.
 */
const ENDPOINT_RATE_LIMITS = new Map([
    ['POST /v1/payment', 3],
    ['GET /v1/estimate', 7]
]);
const DEFAULT_RATE_LIMIT_RPS = 3;

/** The documented payment lifecycle. `finished` is the only success state. */
const PAYMENT_STATUSES = Object.freeze({
    WAITING: 'waiting',
    CONFIRMING: 'confirming',
    CONFIRMED: 'confirmed',
    SENDING: 'sending',
    PARTIALLY_PAID: 'partially_paid',
    FINISHED: 'finished',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    EXPIRED: 'expired'
});

/**
 * The documented payout lifecycle, which is a *separate namespace* from payment status.
 *
 * `FINISHED` here means the payout was sent; `finished` there means the customer's
 * deposit completed. They are different fields in different payloads, and collapsing
 * them would let a finished withdrawal be read as a funded deposit.
 */
const PAYOUT_STATUSES = Object.freeze({
    NEW: 'NEW',
    CREATING: 'CREATING',
    WAITING: 'WAITING',
    PROCESSING: 'PROCESSING',
    FINISHED: 'FINISHED',
    REJECTED: 'REJECTED',
    REJECTED_NOT_CHECKED: 'REJECTED_NOT_CHECKED'
});

const ipnSignaturePattern = /^[0-9a-f]{128}$/i;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getBaseUrl() {
    return (process.env.NOWPAYMENTS_API_BASE_URL || PRODUCTION_BASE_URL).replace(/\/+$/, '');
}

function getApiKey() {
    return process.env.NOWPAYMENTS_API_KEY || '';
}

function isConfigured() {
    return Boolean(getApiKey());
}

function getIpnSecret() {
    return process.env.NOWPAYMENTS_IPN_SECRET || '';
}

/**
 * Reports whether the configured base URL is the real production API.
 *
 * The API key is sent as an `x-api-key` header on every call, so pointing this at a host
 * that is not NOWPayments leaks it. Enforced outside production so a sandbox can be used
 * locally, and never in production.
 */
function isTrustedBaseUrl() {
    return process.env.NODE_ENV !== 'production' || getBaseUrl() === PRODUCTION_BASE_URL;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// One serial queue per endpoint, each remembering when its next call may start.
const limiterState = new Map();

/**
 * Serialises calls to one endpoint and keeps them inside its documented rate.
 *
 * The key is the documented path (`POST /v1/payment`), not the full URL, so it has to be
 * built from the path the caller was given. An earlier version keyed on the absolute URL
 * and so never matched the table above: the limit was silently inert.
 */
function rateLimited(method, path, run) {
    const key = `${method.toUpperCase()} ${String(path).split('?')[0]}`;
    const minIntervalMs = Math.ceil(1000 / (ENDPOINT_RATE_LIMITS.get(key) || DEFAULT_RATE_LIMIT_RPS));

    const state = limiterState.get(key) || { tail: Promise.resolve(), nextAllowedAt: 0 };
    limiterState.set(key, state);

    const task = state.tail.then(async () => {
        const waitMs = Math.max(0, state.nextAllowedAt - Date.now());
        if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        state.nextAllowedAt = Date.now() + minIntervalMs;
        return run();
    });

    // The queue must survive a failure, or one thrown error stops every later call on this
    // endpoint from being scheduled at all. The caller's own rejection still propagates
    // through `task`.
    state.tail = task.then(() => undefined, () => undefined);
    return task;
}


// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** An error that carries the provider's own explanation, which is the useful part. */
class NowPaymentsError extends Error {
    constructor(message, { status = 0, providerResponse = null, cause = null } = {}) {
        super(message);
        this.name = 'NowPaymentsError';
        this.status = status;
        this.providerResponse = providerResponse;
        this.cause = cause;
    }

    /** The provider's own words, when it gave any. */
    get providerMessage() {
        if (!this.providerResponse || typeof this.providerResponse !== 'object') return null;
        const { message, error } = this.providerResponse;
        const text = typeof message === 'string' ? message : typeof error === 'string' ? error : null;
        return text && text.trim() ? text.trim() : null;
    }

    /** True when the provider refused because the request was rate limited. */
    get isRateLimited() {
        return this.status === 429;
    }
}

/**
 * Performs one authenticated request against the provider.
 *
 * `x-api-key` is the documented auth header for everything except the JWT-only listing
 * endpoints. The key is never returned to a browser and never logged.
 */
async function request(method, path, { body = null, query = null, timeoutMs = 12000, authToken = null } = {}) {
    if (!isConfigured()) {
        throw new NowPaymentsError('NOWPayments is not configured: NOWPAYMENTS_API_KEY is missing.');
    }
    if (!isTrustedBaseUrl()) {
        throw new NowPaymentsError('NOWPayments API calls are blocked because the configured base URL is not the production API.');
    }

    let url = `${getBaseUrl()}${path}`;
    if (query) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) params.set(key, String(value));
        }
        const serialised = params.toString();
        if (serialised) url += `?${serialised}`;
    }

    const headers = { 'x-api-key': getApiKey(), Accept: 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (body !== null) headers['Content-Type'] = 'application/json';

    let response;
    try {
        // Keyed on `path`, not `url`, so the documented per-endpoint limit applies.
        response = await rateLimited(method, path, () => fetch(url, {
            method,
            headers,
            body: body === null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        }));
    } catch (error) {
        if (error instanceof NowPaymentsError) throw error;
        throw new NowPaymentsError(`NOWPayments request to ${path} could not be completed.`, { cause: error });
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        const error = new NowPaymentsError(`NOWPayments ${path} returned ${response.status}.`, {
            status: response.status,
            providerResponse: payload
        });
        throw error;
    }
    return payload;
}

// ---------------------------------------------------------------------------
// Authorization (payouts)
// ---------------------------------------------------------------------------

// The token is valid for 5 minutes. Cached slightly short of that so a request cannot
// start with a token that expires in flight.
const AUTH_TOKEN_TTL_MS = 4 * 60 * 1000;
let authTokenCache = { token: null, expiresAt: 0 };

function payoutsConfigured() {
    return isConfigured() && Boolean(process.env.NOWPAYMENTS_EMAIL) && Boolean(process.env.NOWPAYMENTS_PASSWORD);
}

function resetAuthTokenCache() {
    authTokenCache = { token: null, expiresAt: 0 };
}

/**
 * Returns a JWT for the payout endpoints, which require `Authorization: Bearer` on top of
 * the API key. Email and password are case-sensitive.
 */
async function getAuthToken() {
    if (authTokenCache.token && Date.now() < authTokenCache.expiresAt) {
        return authTokenCache.token;
    }
    if (!payoutsConfigured()) {
        throw new NowPaymentsError('NOWPayments payouts are not configured: NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD are required.');
    }

    const result = await request('POST', '/v1/auth', {
        body: {
            email: process.env.NOWPAYMENTS_EMAIL,
            password: process.env.NOWPAYMENTS_PASSWORD
        },
        timeoutMs: 10000
    });
    if (!result || typeof result.token !== 'string' || !result.token) {
        throw new NowPaymentsError('NOWPayments did not return an authorization token.');
    }

    authTokenCache = { token: result.token, expiresAt: Date.now() + AUTH_TOKEN_TTL_MS };
    return result.token;
}

// ---------------------------------------------------------------------------
// Payment endpoints
// ---------------------------------------------------------------------------

/**
 * Lists the currencies this merchant can actually accept.
 *
 * `GET /v1/currencies` returns every coin NOWPayments supports anywhere, which is not the
 * same thing as the coins enabled for this account. Reading that list and filtering it
 * against a hardcoded allowlist offered users coins the merchant had not switched on, and
 * the create-payment call then failed with a generic 502. `GET /v1/merchant/coins` is the
 * endpoint the provider documents for exactly this question. The global list remains as
 * a fallback so a sandbox that does not implement it still works.
 */
async function getSupportedCurrencies({ logger = console } = {}) {
    // The two endpoints disagree on the field name: the merchant list answers with
    // `selectedCurrencies` and the global list with `currencies`. Reading only `currencies`
    // finds nothing in the merchant list, so every call silently fell through to the global
    // one and the merchant list was never actually used.
    const readCoins = (payload) => {
        if (!payload || typeof payload !== 'object') return [];
        const values = payload.selectedCurrencies ?? payload.currencies;
        return Array.isArray(values) ? values.map((coin) => String(coin).toLowerCase()) : [];
    };

    try {
        const coins = readCoins(await request('GET', '/v1/merchant/coins', { timeoutMs: 8000 }));
        if (coins.length > 0) return coins;
    } catch (error) {
        logger.warn(`NOWPayments merchant/coins lookup failed (${error.message}); falling back to the global currency list.`);
    }

    return readCoins(await request('GET', '/v1/currencies', { timeoutMs: 8000 }));
}

function toPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The provider's own per-currency amount window, from `/v1/currencies?fixed_rate=true`.
 *
 * The app previously enforced a flat $5,000 ceiling of its own, which is not a limit the
 * provider applies. A real ceiling matters mostly for the coins that cap low, because a
 * deposit above the coin's maximum is refused at payment creation, after the customer has
 * already committed to it.
 *
 * The field names are genuinely unpublished: the OpenAPI schema for this endpoint declares
 * `currencies` as `string[]` and describes no amount fields, and only the prose docs say
 * the `fixed_rate` query "shows min/max amounts". Rather than assume a spelling, this
 * accepts the ones in use and drops anything it cannot read, so an unrecognised or changed
 * shape yields *no* maximum and the caller keeps its own ceiling. That direction is
 * deliberate: a wrong maximum would refuse deposits the provider would have accepted,
 * whereas a missing one only means the old, more permissive behaviour.
 *
 * Only fixed-rate entries carry a window, so a non-fixed-rate account gets an empty map.
 */
async function getCurrencyLimits({ logger = console } = {}) {
    try {
        const payload = await request('GET', '/v1/currencies', {
            query: { fixed_rate: 'true' },
            timeoutMs: 8000
        });
        const entries = Array.isArray(payload?.currencies) ? payload.currencies : [];
        const limits = {};
        for (const entry of entries) {
            // Without fixed_rate the endpoint answers with bare ticker strings, which
            // carry no amounts and so are skipped rather than misread.
            if (!entry || typeof entry !== 'object') continue;
            const code = String(entry.currency_code ?? entry.code ?? '').toLowerCase();
            if (!code) continue;
            const min = toPositiveNumber(entry.min_amount ?? entry.minimal_amount);
            const max = toPositiveNumber(entry.max_amount ?? entry.maximum_amount);
            // A maximum at or below the minimum is not a usable window; treat it as absent
            // so the caller falls back rather than presenting a range nothing can satisfy.
            if (max === null || (min !== null && max <= min)) continue;
            limits[code] = { min, max };
        }
        return limits;
    } catch (error) {
        logger.warn(`NOWPayments currency limits lookup failed: ${error.message}; using the app ceiling.`);
        return {};
    }
}

/**
 * Converts an amount of one currency into the price currency, using the documented
 * estimate endpoint.
 *
 * This exists because `/v1/min-amount` answers in the *coin* unless `fiat_equivalent` is
 * honoured, and a coin-denominated number must never be shown in a USD amount box. Rather
 * than guess, the conversion is performed explicitly, so a minimum can always be stated in
 * the same units as the amount the user is typing. Returns null when the provider will not
 * convert, so the caller can omit the minimum rather than invent one.
 */
async function convertToFiat(amount, fromCurrency, toCurrency = 'usd') {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    const from = String(fromCurrency || '').toLowerCase();
    const to = String(toCurrency || 'usd').toLowerCase();
    if (!from || from === to) return value;
    try {
        const result = await request('GET', '/v1/estimate', {
            query: { amount: value, currency_from: from, currency_to: to },
            timeoutMs: 8000
        });
        const converted = Number(result?.estimated_amount);
        return Number.isFinite(converted) && converted > 0 ? converted : null;
    } catch (error) {
        return null;
    }
}

/**
 * The real minimum NOWPayments will accept for a currency pair, expressed in `priceCurrency`.
 *
 * The app advertised a flat $1. NOWPayments' documented minimum is around $2 for about
 * half the coins it supports and $3-5 for the rest, so every sub-minimum deposit was
 * refused by the provider after the app had already told the user the amount was fine.
 *
 * The units are the trap. Without `fiat_equivalent` this endpoint answers in the *coin*,
 * not the fiat: the provider's own Node SDK shows a 49.99 USD purchase with
 * `"minimum": { "currency_from": "btc", "min_amount": 0.0001 }`, i.e. 0.0001 BTC. Reading
 * that as dollars is what gave Bitcoin Cash an $18.81 minimum and refused every ordinary
 * deposit under it.
 *
 * So the raw `min_amount` is never returned as a fiat figure. It is converted through the
 * estimate endpoint, and if that conversion is unavailable the function returns null
 * instead -- the caller then applies its own floor. Returning an unconverted coin number
 * here is the one outcome that must not happen, because it silently becomes a dollar
 * amount in the UI and in the deposit limit check.
 */
async function getMinimumAmount(priceCurrency, payCurrency, {
    isFixedRate = false,
    isFeePaidByUser = false
} = {}) {
    const from = String(priceCurrency || 'usd').toLowerCase();
    const to = String(payCurrency || '').toLowerCase();
    if (!to) return null;

    const query = {
        currency_from: from,
        currency_to: to,
        is_fixed_rate: isFixedRate ? 'true' : 'false',
        is_fee_paid_by_user: isFeePaidByUser ? 'true' : 'false'
    };

    const readFields = (payload) => ({
        fiat: Number(payload?.fiat_equivalent),
        raw: Number(payload?.min_amount)
    });

    try {
        // `fiat_equivalent` is requested even when the source is already USD: it is the
        // parameter that makes the provider do the conversion, and asking for a USD
        // equivalent of a USD source is a no-op rather than an error.
        const asked = await request('GET', '/v1/min-amount', {
            query: { ...query, fiat_equivalent: from },
            timeoutMs: 8000
        });
        const { fiat, raw } = readFields(asked);
        if (Number.isFinite(fiat) && fiat > 0) return fiat;
        if (Number.isFinite(raw) && raw > 0) return await convertToFiat(raw, to, from);
        return null;
    } catch (error) {
        // The provider rejected the conversion parameter, or the call failed. Retried
        // without it so a floor is still available -- and the retry's figure is converted
        // rather than trusted, for the same reason.
        try {
            const asked = await request('GET', '/v1/min-amount', { query, timeoutMs: 8000 });
            const { fiat, raw } = readFields(asked);
            if (Number.isFinite(fiat) && fiat > 0) return fiat;
            if (Number.isFinite(raw) && raw > 0) return await convertToFiat(raw, to, from);
        } catch (retryError) {
            return null;
        }
        return null;
    }
}

function fixedRateEnabled() {
    return process.env.NOWPAYMENTS_FIXED_RATE === 'true';
}

function feePaidByUserEnabled() {
    return process.env.NOWPAYMENTS_FEE_PAID_BY_USER === 'true';
}

/**
 * Creates a payment and returns the address the customer must pay to.
 *
 * The response is checked for the three fields the deposit cannot work without. A payment
 * that comes back without an address or a `pay_amount` cannot be shown to a customer, and
 * storing the deposit as if it had instructions would leave them waiting on nothing.
 */
async function createPayment({
    priceAmount,
    priceCurrency = 'usd',
    payCurrency,
    orderId,
    orderDescription = null,
    ipnCallbackUrl,
    isFixedRate = fixedRateEnabled(),
    isFeePaidByUser = feePaidByUserEnabled()
}) {
    const body = {
        price_amount: Number(priceAmount),
        price_currency: String(priceCurrency).toLowerCase(),
        pay_currency: String(payCurrency).toLowerCase(),
        ipn_callback_url: ipnCallbackUrl,
        order_id: String(orderId),
        is_fixed_rate: Boolean(isFixedRate),
        is_fee_paid_by_user: Boolean(isFeePaidByUser)
    };
    if (orderDescription) body.order_description = orderDescription;

    const result = await request('POST', '/v1/payment', { body, timeoutMs: 12000 });

    if (!result || !result.payment_id || !result.pay_address || !Number.isFinite(Number(result.pay_amount))) {
        throw new NowPaymentsError('NOWPayments returned incomplete payment instructions.', {
            providerResponse: result
        });
    }
    return result;
}

/**
 * Reads a payment's current state from the provider.
 *
 * This is `GET /v1/payment/{payment_id}` and it is the authoritative answer to "did this
 * payment arrive?", so it backs the reconciler: it is the path that resolves a deposit
 * whose callback never landed.
 */
async function getPaymentStatus(paymentId) {
    if (!paymentId) throw new NowPaymentsError('A payment id is required to read payment status.');
    return request('GET', `/v1/payment/${encodeURIComponent(paymentId)}`, { timeoutMs: 12000 });
}

// ---------------------------------------------------------------------------
// Payout endpoints
// ---------------------------------------------------------------------------

/**
 * Asks the provider whether an address can receive funds.
 *
 * `payoutOptions` checks addresses with per-network regular expressions, which catch the
 * realistic mistakes but cannot know whether an address exists or belongs to the chain
 * that was selected. The balance is debited the moment a withdrawal is stored, so an
 * address that passes the regex and cannot receive anything is unrecoverable. This is the
 * provider's own validator; it is advisory, so a provider-side failure falls back to the
 * local check rather than blocking the request.
 */
async function validatePayoutAddress(address, currency, { extraId = null, logger = console } = {}) {
    if (!isConfigured() || !isTrustedBaseUrl()) {
        return { checked: false, valid: null, reason: 'NOWPayments is not configured, so only the local address format was checked.' };
    }

    const body = {
        address: String(address),
        currency: String(currency).toLowerCase()
    };
    if (extraId) body.extra_id = String(extraId);

    try {
        const result = await request('POST', '/v1/payout/validate-address', { body, timeoutMs: 10000 });
        // The endpoint reports validity in a few shapes across API versions; any explicit
        // `false` is authoritative, and an absent flag is treated as "cannot tell" rather
        // than as permission, so a shape change fails closed towards the local check.
        const valid = typeof result?.is_valid === 'boolean' ? result.is_valid
            : typeof result?.valid === 'boolean' ? result.valid
                : null;
        if (valid === false) {
            const reason = typeof result?.error === 'string' ? result.error
                : typeof result?.message === 'string' ? result.message
                    : 'The provider does not recognise this address.';
            return { checked: true, valid: false, reason };
        }
        return { checked: true, valid, reason: null };
    } catch (error) {
        logger.warn(`NOWPayments address validation could not be completed (${error.message}); using the local address check only.`);
        return { checked: false, valid: null, reason: null };
    }
}

/** Network fee for a payout, or null when the provider will not quote one. */
async function getPayoutFee(currency, amount) {
    try {
        const result = await request('GET', '/v1/payout/fee', {
            query: { currency: String(currency).toLowerCase(), amount: Number(amount) },
            timeoutMs: 8000
        });
        const fee = Number(result?.withdrawal_fee ?? result?.fee);
        return Number.isFinite(fee) ? fee : null;
    } catch (error) {
        return null;
    }
}

/**
 * Minimum NOWPayments will payout for a coin, in that coin, or null when unknown.
 *
 * This endpoint is access-restricted: on an account that has not enabled it the provider
 * answers 403 "Access denied | Invalid IP", which is a configuration fact rather than a
 * fault, and is reported as such instead of being swallowed. The caller falls back to its
 * own floor, so an unavailable minimum never blocks a withdrawal.
 */
async function getPayoutMinimum(currency) {
    const coin = String(currency).toLowerCase();
    try {
        const result = await request('GET', `/v1/payout-withdrawal/min-amount/${encodeURIComponent(coin)}`, {
            timeoutMs: 8000
        });
        const minimum = Number(result?.min_amount ?? result?.amount);
        if (Number.isFinite(minimum) && minimum > 0) return minimum;
        return null;
    } catch (error) {
        if (error instanceof NowPaymentsError && error.status === 403) {
            console.warn(
                `NOWPayments refused the payout minimum for ${coin} (${error.providerMessage ?? error.message}). ` +
                'This endpoint is not enabled for the account, so the app minimum is used instead.'
            );
        }
        return null;
    }
}


// ---------------------------------------------------------------------------
// IPN
// ---------------------------------------------------------------------------

/**
 * Recursively sorts object keys so the signed body is canonical.
 *
 * `JSON.stringify(body, Object.keys(body).sort())` only sorts the top level: the replacer
 * array is applied at every depth, so a nested object has all of its own keys stripped and
 * serialises as `{}`. The documented payment IPN nests a `fee` object, so a shallow sort
 * would produce a signature over the wrong bytes and every callback would be rejected.
 */
function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])])
    );
}

/**
 * Verifies an IPN signature: HMAC-SHA-512 over the key-sorted body, hex encoded, compared
 * in constant time against the `x-nowpayments-sig` header.
 *
 * `Buffer.from(value, 'hex')` never throws: it silently drops every non-hex character, so
 * a comparison without a shape check would degrade to comparing whatever survived. The
 * signature shape is validated before the digest is compared.
 */
function verifyIpnSignature(secret, body, signature) {
    if (typeof secret !== 'string' || !secret) return false;
    if (typeof signature !== 'string' || !ipnSignaturePattern.test(signature)) return false;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    const expected = createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(expected, supplied);
}

/**
 * Distinguishes the two callback shapes NOWPayments posts to an IPN URL.
 *
 * Payments and payouts share the callback channel and use incompatible bodies. A payment
 * carries `payment_id` and `payment_status`; a payout carries `id` and a `status` from the
 * separate uppercase payout vocabulary. Without this split a payout callback fails the
 * payment field checks and is answered 400, and the provider treats a 4xx as a delivery
 * failure and retries it on the dashboard's recurrent-notification schedule.
 */
function classifyIpnBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
    if (body.payment_id !== undefined || body.payment_status !== undefined) return 'payment';
    if (body.batch_withdrawal_id !== undefined || (body.id !== undefined && body.status !== undefined)) return 'payout';
    return 'unknown';
}

module.exports = {
    PRODUCTION_BASE_URL,
    PAYMENT_STATUSES,
    PAYOUT_STATUSES,

    getBaseUrl,
    getApiKey,
    getIpnSecret,
    isConfigured,
    isTrustedBaseUrl,

    NowPaymentsError,
    request,

    payoutsConfigured,
    getAuthToken,
    resetAuthTokenCache,

    getSupportedCurrencies,
    getCurrencyLimits,
    getMinimumAmount,
    convertToFiat,
    createPayment,
    getPaymentStatus,
    fixedRateEnabled,
    feePaidByUserEnabled,

    validatePayoutAddress,
    getPayoutFee,
    getPayoutMinimum,

    sortKeysDeep,
    verifyIpnSignature,
    classifyIpnBody
};
