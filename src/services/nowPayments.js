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
 *     POST /v1/payout                                create a payout batch
 *     POST /v1/payout/{id}/verify                    2FA confirmation, without which the
 *                                                     batch is created but never sent
 *     POST /v1/payout/validate-address                authoritative address validation
 *     GET  /v1/payout/fee                             network fee estimate
 *     GET  /v1/payout-withdrawal/min-amount/{coin}    minimum payout for a coin
 *     GET  /v1/payout/{batch_id}                      payout batch state
 */

const { createHmac, timingSafeEqual } = require('node:crypto');
const undici = require('undici');
const { realCredential } = require('./credentials');
const { ProxyAgent } = undici;

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
 *
 * The list is the provider's full raw vocabulary, not the subset the dashboard shows.
 * `SENDING`, `FAILED` and `CANCELLED` were missing, and each omission was a way for a
 * user's money to disappear quietly:
 *
 *  - `SENDING` is the on-chain broadcast, the state the provider spends most of its
 *    time in. Unrecognised, it was stored as the fallback `WAITING`, so a withdrawal
 *    genuinely broadcasting on-chain read as "queued, nothing happening yet".
 *  - `FAILED` and `CANCELLED` are terminal *and* mean the money never left. Unrecognised,
 *    they were not in the resolved set, so a payout the provider had given up on left
 *    the user's balance debited with no refund and no notification -- the worst possible
 *    outcome, because the user is told nothing while being poorer.
 *
 * Both spellings of the cancellation are accepted because the provider uses both.
 */
const PAYOUT_STATUSES = Object.freeze({
    NEW: 'NEW',
    CREATING: 'CREATING',
    WAITING: 'WAITING',
    PROCESSING: 'PROCESSING',
    SENDING: 'SENDING',
    FINISHED: 'FINISHED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
    REJECTED_NOT_CHECKED: 'REJECTED_NOT_CHECKED'
});

/** The two spellings the provider uses for a cancelled payout. */
const PAYOUT_CANCELLED_SPELLINGS = Object.freeze(['CANCELLED', 'CANCELED']);

const ipnSignaturePattern = /^[0-9a-f]{128}$/i;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getBaseUrl() {
    return (process.env.NOWPAYMENTS_API_BASE_URL || PRODUCTION_BASE_URL).replace(/\/+$/, '');
}

/**
 * Placeholder-aware, on purpose.
 *
 * A template value in `.env` is a truthy string, so the old truthy check reported the
 * provider as configured, offered crypto deposits, and then failed at the point where the
 * money is already owed. A placeholder key now reads as "not configured" and the deposit
 * path refuses it before an address is ever shown to a customer.
 */
function getApiKey() {
    return realCredential(process.env, 'NOWPAYMENTS_API_KEY') || '';
}

function isConfigured() {
    return Boolean(getApiKey());
}

/**
 * The IPN signing secret, or an empty string when it is missing or still a placeholder.
 *
 * Empty rather than a placeholder, because a non-empty placeholder would verify no
 * callback: an IPN would be accepted or rejected against a value nobody set, which is the
 * same silent failure as a missing secret but harder to see.
 */
function getIpnSecret() {
    return realCredential(process.env, 'NOWPAYMENTS_IPN_SECRET') || '';
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
// Outbound proxy
// ---------------------------------------------------------------------------

/**
 * A memoised dispatcher that routes outbound requests through FIXIE_URL.
 *
 * NOWPayments restricts the payout endpoints to a list of whitelisted IPs, and a
 * serverless host like Vercel cannot be whitelisted because its outbound address
 * changes on every cold start. Fixie provides two stable IPs, and the app routes the
 * whitelisted calls through it.
 *
 * Only the payout endpoints use this. The payment endpoints (`createPayment`,
 * `getMinimumAmount`, `getSupportedCurrencies`, `getCurrencyLimits`) are not IP
 * restricted, and the free Fixie tier allows 500 requests per month -- routing the
 * per-coin currency lookups through it would exhaust the budget in a single cache
 * refresh.
 *
 * Returned as `null` when the URL is unset, which makes the caller use the direct
 * connection. That is the correct behaviour for local development, where the
 * whitelist is not enforced and Fixie may not be configured.
 *
 * Constructed once and cached: `ProxyAgent` opens a connection pool, and building a
 * new one per request would throw the pool away between calls and leak sockets.
 */
let cachedProxyDispatcher = null;
let cachedProxyUrl = null;

function payoutProxyDispatcher() {
    const url = String(process.env.FIXIE_URL || '').trim();
    if (!url) return null;

    // Not used outside production. The proxy exists for one reason: NOWPayments whitelists the
    // payout endpoints by IP, and a serverless host's outbound address moves on every cold
    // start, so a deployment routes through a proxy with fixed addresses. Running locally
    // there is nothing to whitelist and nothing to gain from the round trip -- and a proxy
    // that only works in production is a failure with no upside. `ProxyAgent` builds
    // successfully for a well-formed URL whether or not anything is listening behind it, so
    // the constructor cannot catch this: every call simply fails with "fetch failed", which
    // reads exactly like the provider being down. One check here turns that into a direct
    // connection, which is what a local run wants.
    if (getBaseUrl() !== PRODUCTION_BASE_URL) {
        return null;
    }

    // Rebuild only if the URL changed. In practice it does not change within one
    // process, but this guards against a test that swaps it.
    if (cachedProxyDispatcher && cachedProxyUrl === url) return cachedProxyDispatcher;

    try {
        cachedProxyDispatcher = new ProxyAgent(url);
        cachedProxyUrl = url;
        return cachedProxyDispatcher;
    } catch (error) {
        // A malformed URL is a configuration mistake, not a runtime failure. Logged
        // once, and the caller falls back to a direct connection so an app that was
        // working before the proxy was added does not stop working because of it.
        console.error(`FIXIE_URL is not a usable proxy URL (${error.message}); routing directly.`);
        cachedProxyDispatcher = null;
        cachedProxyUrl = null;
        return null;
    }
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
    constructor(message, { status = 0, providerResponse = null, cause = null, path = null } = {}) {
        super(message);
        this.name = 'NowPaymentsError';
        this.status = status;
        this.providerResponse = providerResponse;
        this.cause = cause;
        // The endpoint the call was making. Carried because the *stage* a payout failed at is
        // what decides whether it is safe to give up on: a request that never got past the
        // token exchange provably sent no money, while the same transport failure at the
        // submission endpoint leaves it unknown. Without this the two are the same exception
        // and both have to be treated as the dangerous one, which strands every withdrawal on
        // a misconfigured proxy.
        this.path = path;
    }

    /**
     * The provider's own words, when it gave any.
     *
     * NOWPayments reports errors as `{ "error": { "code": "FAILURE", "message": "Minimum
     * amount is 0.05 BCH, you have 0.002" } }` -- the useful text is nested one object deep.
     * Only the flat `{ message }` and `{ error: "string" }` shapes were read, so on a real
     * refusal this returned null and `createDeposit` answered every genuine provider
     * rejection with a bare "Could not create a deposit with the selected provider." That
     * threw away the one sentence naming the amount that would have worked, which is the
     * entire reason the caller falls through to its own message instead of a 502.
     *
     * The nested form is therefore checked first, because it is what the provider actually
     * sends; the flat forms stay supported for the endpoints and API versions that use them.
     */
    get providerMessage() {
        if (!this.providerResponse || typeof this.providerResponse !== 'object') return null;

        const { message, error } = this.providerResponse;
        const nested = error && typeof error === 'object' ? error.message : null;

        const candidates = [
            nested,
            typeof message === 'string' ? message : null,
            typeof error === 'string' ? error : null
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
        return null;
    }

    /** True when the provider refused because the request was rate limited. */
    get isRateLimited() {
        return this.status === 429;
    }

    /** True when the provider refused because the caller's IP is not whitelisted. */
    get isIpRefused() {
        return this.status === 403;
    }
}

/**
 * Performs one authenticated request against the provider.
 *
 * `x-api-key` is the documented auth header for everything except the JWT-only listing
 * endpoints. The key is never returned to a browser and never logged.
 *
 * `viaProxy` routes the request through FIXIE_URL when it is set. Only the payout
 * endpoints pass it, because they are the ones on NOWPayments' IP whitelist. When
 * `FIXIE_URL` is unset the option has no effect and the request goes out directly, which
 * is what local development wants.
 */
async function request(method, path, {
    body = null,
    query = null,
    timeoutMs = 12000,
    authToken = null,
    viaProxy = false,
} = {}) {
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

    // The dispatcher is only resolved when the caller asked for it. `ProxyAgent`
    // opens a connection pool on construction, so a request that does not need the
    // proxy should not pay for one.
    const dispatcher = viaProxy ? payoutProxyDispatcher() : null;

    let response;
    try {
        // Keyed on `path`, not `url`, so the documented per-endpoint limit applies.
        //
        // Undici's own `fetch` is used rather than the global one. Node 24 ships a
        // V8-native `fetch` that is a separate implementation, and when a dispatcher is
        // passed it hands `dispatcher.dispatch` a *legacy v1* handler (`onConnect`,
        // `onHeaders`, `onData`, `onComplete`, `onError`). Undici's `ProxyAgent` expects
        // the v2 handler shape (`onRequestStart`, `onResponseStart`, ...) and rejects
        // anything else with `invalid onRequestStart method` -- which is exactly the
        // error the payout endpoints were throwing whenever `FIXIE_URL` was set. Calling
        // through the `undici` module object keeps the reference live: tests swap
        // `undici.fetch` to mock the provider, and a future undici major can replace
        // the function without a call-site change.
        response = await rateLimited(method, path, () => undici.fetch(url, {
            method,
            headers,
            body: body === null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
            // Undici's `fetch` accepts `dispatcher` for a custom connection pool. It is
            // left undefined when the proxy is unset, which makes fetch use its
            // process-wide default.
            ...(dispatcher ? { dispatcher } : {}),
        }));
    } catch (error) {
        if (error instanceof NowPaymentsError) throw error;
        throw new NowPaymentsError(`NOWPayments request to ${path} could not be completed.`, { cause: error, path });
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        const error = new NowPaymentsError(`NOWPayments ${path} returned ${response.status}.`, {
            status: response.status,
            providerResponse: payload,
            path
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
 *
 * Goes through the proxy when it is configured, because the auth endpoint is on the same
 * whitelist as the payout calls: NOWPayments resolves the token against the account that
 * owns the key, and a request from an unlisted IP is refused before the credentials are
 * even checked.
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
        timeoutMs: 10000,
        viaProxy: true,
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
 *
 * Not proxied: this endpoint is not IP-restricted, and the currency list is refreshed on
 * every cache expiry, which would consume the free Fixie budget on its own.
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
 *
 * Not proxied: this endpoint is not IP-restricted.
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

    // `pay_amount` is checked for being a positive figure, not merely a finite one. A payment
    // quoted at zero cannot be paid, and it is also not a figure any instruction can be built
    // from, so storing it would leave a deposit whose panel says "send the amount shown" and
    // shows nothing.
    const payAmount = Number(result?.pay_amount);
    if (!result || !result.payment_id || !result.pay_address || !Number.isFinite(payAmount) || payAmount <= 0) {
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
 *
 * Not proxied: this endpoint is not IP-restricted.
 */
async function getPaymentStatus(paymentId) {
    if (!paymentId) throw new NowPaymentsError('A payment id is required to read payment status.');
    return request('GET', `/v1/payment/${encodeURIComponent(paymentId)}`, { timeoutMs: 12000 });
}

// ---------------------------------------------------------------------------
// Payout endpoints
//
// Every call in this section passes `viaProxy: true`. NOWPayments restricts these
// endpoints to a whitelist of IP addresses, and a serverless host cannot be whitelisted
// because its outbound address changes on every cold start. Fixie provides two stable
// IPs, both whitelisted in the NOWPayments dashboard, and `payoutProxyDispatcher` reads
// `FIXIE_URL` to route these calls through it. When `FIXIE_URL` is unset the option is
// inert and the calls go direct, which is what local development wants.
// ---------------------------------------------------------------------------

/**
 * A description of why a request never reached the provider, good enough to act on.
 *
 * `request` reports a transport failure as "could not be completed" and keeps the underlying
 * error as `cause`. That is the right shape for a thrown exception, but it is useless in a
 * log line: an operator reading "could not be completed" learns nothing, and the one detail
 * that would identify the fault -- a proxy that will not authenticate, a name that does not
 * resolve, a socket that was refused -- is a field away and gets discarded. The likeliest
 * cause of a transport failure on the payout endpoints is a misconfigured `FIXIE_URL`, so the
 * line also says whether the proxy is in play at all. Without that, "the proxy is broken" and
 * "there is no proxy and NOWPayments refused the address" look identical from outside.
 */
function describeTransportFailure(error) {
    const parts = [];
    const cause = error?.cause;
    if (cause) {
        const code = cause.code ? ` (${cause.code})` : '';
        parts.push(`${cause.message || String(cause)}${code}`);
        // Undici nests the proxy's own failure inside a wrapper whose message is frequently
        // just "fetch failed", so the informative text is usually one level further down.
        if (cause.cause?.message) parts.push(`underlying: ${cause.cause.message}`);
    }
    parts.push(payoutProxyConfigured()
        ? 'the request went out via FIXIE_URL'
        : 'FIXIE_URL is unset, so the request went out directly');
    return parts.join('; ');
}

/** Whether the whitelisted proxy is configured for this process. */
function payoutProxyConfigured() {
    return Boolean(String(process.env.FIXIE_URL || '').trim());
}

/**
 * How long the provider address check is abandoned after a transport failure.
 *
 * The check runs on every crypto withdrawal and is metered through a proxy with a small
 * monthly allowance, so a broken proxy is not a log line and nothing else: without this,
 * every withdrawal would pay the full ten-second timeout and a metered request to learn
 * something already known. The local format check carries the requests meanwhile.
 *
 * Shorter than the payout-minimum cool-off because this one guards a real risk -- an address
 * that satisfies the regex but cannot receive anything, on a withdrawal whose balance is
 * already debited -- whereas the minimum only affects a number shown to the user.
 */
const ADDRESS_VALIDATION_RETRY_MS = 5 * 60 * 1000;
let addressValidationUnavailableUntil = 0;
let addressValidationFailureReported = false;

/** Ends the address-check cool-off, so the next withdrawal asks the provider again. */
function resetAddressValidationAvailability() {
    addressValidationUnavailableUntil = 0;
    addressValidationFailureReported = false;
}

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

    // Inside the cool-off a previous withdrawal already established that the provider cannot be
    // reached, so asking again costs a ten-second wait and a metered proxy request to learn the
    // same thing. Reported as unchecked rather than skipped silently, so the caller's `checked`
    // flag still means what it says.
    if (Date.now() < addressValidationUnavailableUntil) {
        return { checked: false, valid: null, reason: null };
    }

    const body = {
        address: String(address),
        currency: String(currency).toLowerCase()
    };
    if (extraId) body.extra_id = String(extraId);

    try {
        const result = await request('POST', '/v1/payout/validate-address', { body, timeoutMs: 10000, viaProxy: true });
        addressValidationUnavailableUntil = 0;
        addressValidationFailureReported = false;
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
        // Only a transport failure opens the cool-off. A provider that answered and reported
        // the address as bad has given a real answer, and the next withdrawal deserves its own
        // check -- cooling that off would let a user retry until the verdict changed.
        if (!error?.status) {
            addressValidationUnavailableUntil = Date.now() + ADDRESS_VALIDATION_RETRY_MS;
            if (!addressValidationFailureReported) {
                addressValidationFailureReported = true;
                logger.warn(
                    `NOWPayments address validation could not be reached: ${describeTransportFailure(error)}. ` +
                    `Only the local address format check will run for the next ${Math.round(ADDRESS_VALIDATION_RETRY_MS / 60000)} minutes, ` +
                    'so an address that looks right but sits on the wrong network will not be caught by the provider. ' +
                    'If FIXIE_URL is set, it is the first thing to check.'
                );
            }
        }
        return { checked: false, valid: null, reason: null };
    }
}

/** Network fee for a payout, or null when the provider will not quote one. */
async function getPayoutFee(currency, amount) {
    try {
        const result = await request('GET', '/v1/payout/fee', {
            query: { currency: String(currency).toLowerCase(), amount: Number(amount) },
            timeoutMs: 8000,
            viaProxy: true,
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
 * This endpoint is access-restricted on the provider side. An account that has not enabled
 * it gets 403 "Access denied | Invalid IP", and the provider cannot even name the address it
 * thinks is calling -- its own response ends in the literal text "undefined". That is a
 * configuration fact about the NOWPayments account, not a fault here, and the caller already
 * falls back to the app's own floor, so an unavailable minimum never blocks a withdrawal.
 *
 * With `FIXIE_URL` set the call is routed through the whitelisted proxy and the 403 should
 * not occur. The cool-off is still kept, because the whitelist is verified per account and
 * a misconfiguration (or an expired Fixie plan) can bring the 403 back. In that case the
 * refusal is one log line and no further requests until the cool-off expires.
 */
let payoutMinimumUnavailableUntil = 0;
let payoutMinimumRefusalReported = false;

/**
 * Whether this process has seen a refusal, and so owes the operator a confirmation if the
 * endpoint starts working.
 *
 * Deliberately not cleared by `resetPayoutMinimumAvailability`, which only ends the cool-off.
 * Recovery is a fact about the account, not about the timer: if the endpoint answers after a
 * refusal, the operator should hear that, whether or not something restarted the cool-off in
 * between. It is cleared only by the recovery itself, so exactly one confirmation is logged
 * per refusal.
 */
let payoutMinimumRefusalSeen = false;

/** In-flight requests, so two concurrent callers for one coin cause one HTTP request. */
const payoutMinimumInFlight = new Map();

/** How long to stop asking after a refusal, and how to undo it when configuration changes. */
const PAYOUT_MINIMUM_RETRY_MS = 15 * 60 * 1000;

/**
 * Whether the provider has refused the payout-minimum endpoint for this account.
 *
 * Distinct from `getPayoutMinimum` returning null. Null means "no usable figure", which has
 * three causes that need different responses: the cool-off is active, the provider answered
 * with something unusable, or the provider refused the account outright. A caller fanning out
 * over every coin needs to tell those apart -- only the third one means the remaining coins
 * are not worth asking about.
 */
function isPayoutMinimumRefused() {
    return Date.now() < payoutMinimumUnavailableUntil;
}

async function getPayoutMinimum(currency) {
    const coin = String(currency).toLowerCase();
    if (Date.now() < payoutMinimumUnavailableUntil) return null;

    // The caller fetches every coin concurrently, so without this a second caller for the
    // same coin would repeat a request that is already in flight.
    if (payoutMinimumInFlight.has(coin)) return payoutMinimumInFlight.get(coin);

    const inFlight = (async () => {
        try {
            const result = await request('GET', `/v1/payout-withdrawal/min-amount/${encodeURIComponent(coin)}`, {
                timeoutMs: 8000,
                viaProxy: true,
            });
            const minimum = Number(result?.min_amount ?? result?.amount);
            if (Number.isFinite(minimum) && minimum > 0) {
                // The endpoint answered, so any earlier refusal no longer applies.
                if (payoutMinimumRefusalSeen) {
                    // Said positively as well as negatively. Without it the only sign that a
                    // dashboard change had taken effect is the absence of a warning, which is
                    // indistinguishable from a process that simply has not re-checked yet.
                    console.log(
                        'NOWPayments is now answering the payout-minimum endpoint; provider ' +
                        'payout minimums are in use.'
                    );
                }
                payoutMinimumUnavailableUntil = 0;
                payoutMinimumRefusalReported = false;
                payoutMinimumRefusalSeen = false;
                return minimum;
            }
            return null;
        } catch (error) {
            if (error instanceof NowPaymentsError && error.status === 403) {
                payoutMinimumUnavailableUntil = Date.now() + PAYOUT_MINIMUM_RETRY_MS;
                if (!payoutMinimumRefusalReported) {
                    payoutMinimumRefusalReported = true;
                    payoutMinimumRefusalSeen = true;
                    const viaProxy = Boolean(process.env.FIXIE_URL);
                    console.warn(
                        `NOWPayments refused the payout-minimum endpoint (${error.providerMessage ?? error.message}). ` +
                        (viaProxy
                            ? 'This request was routed through FIXIE_URL, so the whitelisted proxy IPs are not ' +
                              'the ones on the NOWPayments account. Confirm that BOTH Fixie outbound IPs are ' +
                              'whitelisted at https://account.nowpayments.io/whitelist-settings. '
                            : 'FIXIE_URL is not set, so the request went out from this host\'s own address, ' +
                              'which a serverless platform will not keep stable. Set FIXIE_URL to route these ' +
                              'calls through the whitelisted proxy. ') +
                        `No further requests will be made for ${Math.round(PAYOUT_MINIMUM_RETRY_MS / 60000)} ` +
                        'minutes. This is a capability notice, not a failure: withdrawals are unaffected.'
                    );
                }
            }
            return null;
        } finally {
            payoutMinimumInFlight.delete(coin);
        }
    })();

    payoutMinimumInFlight.set(coin, inFlight);
    return inFlight;
}

/**
 * Ends the cool-off, so the next check asks the provider again.
 *
 * Exists so a deployment whose NOWPayments access was just enabled does not sit out the rest
 * of the cool-off showing app minimums, and so a test can start from a clean slate.
 *
 * It does not clear `payoutMinimumRefusalSeen`. A refusal still owes the operator a
 * confirmation if the endpoint recovers, and that debt outlives the cool-off, so re-arming the
 * check here cannot silence the follow-up.
 */
function resetPayoutMinimumAvailability() {
    payoutMinimumUnavailableUntil = 0;
    payoutMinimumRefusalReported = false;
}

/**
 * Submits a batch of crypto payouts through the Mass Payouts API.
 *
 * The endpoint is a batch: one call carries many withdrawals, and the provider returns one
 * record per entry. It does *not* accept a caller-supplied correlation key. The request body
 * is exactly `address`, `currency`, `amount`, and optionally `extra_id`; the provider rejects
 * anything else with `withdrawals[0].<field> is not allowed`, because the schema is closed
 * rather than permissive. A `payoutId` was sent here for a long time on the assumption that
 * the provider would echo it back, and the first live send against a funded account proved
 * otherwise: the whole batch was refused, nothing moved, and every crypto withdrawal in the
 * queue was released back to `pending` unrefunded-but-undelivered.
 *
 * So the only link between a response entry and a withdrawal row is the destination itself,
 * and `matchPayoutResults` rebuilds it from `address` + `amount` + `currency`. The returned
 * `payoutId` is still this app's own `wd-<id>` key, because `autoPayouts` recovers the
 * withdrawal row from it; it is simply an internal correlation value now rather than
 * something negotiated with the provider.
 *
 * This endpoint is the one place in the app that moves money out without a human, so the
 * shape is deliberately narrow: it takes entries that have already been claimed, and it
 * never decides *whether* to send. Callers must have recorded the claim durably first --
 * see `autoPayouts` -- because a payout that is sent without a claim on file is a payout
 * that can be sent again.
 *
 * `extra_id` carries a destination tag or memo for the chains that route by one (XRP).
 * Sending an XRP address with no tag is a transfer that confirms and delivers nothing.
 */
async function submitPayoutBatch(entries, { logger = console, ipnCallbackUrl = null } = {}) {
    if (!payoutsConfigured()) {
        throw new NowPaymentsError('NOWPayments payouts are not configured: NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD are required.');
    }
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return { batchId: null, withdrawals: [] };

    // Exactly the fields the provider documents, nothing more. The schema is closed, so an
    // extra key is a 400 that costs a whole batch of real payouts -- which is how `payoutId`
    // took every crypto withdrawal in the queue offline. Built from scratch rather than
    // spread, so a future field on the claim object cannot leak in by accident.
    //
    // `unique_external_id` is the correlation key, and it is the one the provider actually
    // documents: NOWPayments' own official SDK serialises exactly this field name, and the
    // provider echoes it back on the create response, on the individual payout record, and in
    // the payout IPN. So a response entry can be tied to a withdrawal row by identity rather
    // than by inferring it from the destination -- and the same value makes a webhook for a
    // single payout in a multi-withdrawal batch unambiguous, which the batch id never could.
    const body = {
        withdrawals: list.map((entry) => {
            const record = {
                address: String(entry.address),
                currency: String(entry.currency).toLowerCase(),
                amount: Number(entry.amount)
            };
            if (entry.extraId) record.extra_id = String(entry.extraId);
            if (entry.payoutId) record.unique_external_id = String(entry.payoutId);
            return record;
        })
    };

    // Sent per batch rather than left to the dashboard setting, because the two can disagree
    // and only one of them is visible from here. A batch created with a callback pointing at a
    // host that cannot reach the app leaves every payout in `processing` with no way to learn
    // it finished; `reconcilePayouts` covers that by polling, but the callback is the only
    // thing that resolves a payout in real time.
    if (ipnCallbackUrl) body.ipn_callback_url = String(ipnCallbackUrl);

    const result = await request('POST', '/v1/payout', {
    authToken: await getAuthToken(),
    body,
    timeoutMs: 30000,
    viaProxy: true,
});

    // The provider reports the batch under either spelling depending on version; both are
    // read because the batch id is the only durable link back to our rows.
    const batchId = result?.batch_withdrawal_id ?? result?.batchWithdrawalId ?? null;

    // Per-entry results, when the provider sends them. Absent for some statuses, in which
    // case the batch id is all we have and reconciliation re-reads the batch.
    const reported = Array.isArray(result?.withdrawals) ? result.withdrawals : [];
    const matches = matchPayoutResults(list, reported);

    const unmatched = matches.reduce((count, item) => count + (item === null ? 1 : 0), 0);
    logger.log(`Submitted a NOWPayments payout batch${batchId ? ` ${batchId}` : ''} with ${list.length} withdrawal(s).`);
    if (unmatched > 0) {
        // Said out loud rather than swallowed. An unmatched entry still gets the batch id and
        // the conservative `WAITING` status, so it is safe; it just has to wait for
        // reconciliation to learn its real state, and an operator reading the log at 3am
        // should not have to work that out from a missing line.
        logger.warn(
            `${unmatched} of ${list.length} payout(s) came back unrecognised; they are recorded as awaiting ` +
            'the provider and will be resolved by reconciliation.'
        );
    }

    return {
        batchId: batchId === null ? null : String(batchId),
        withdrawals: list.map((entry, index) => {
            const item = matches[index];
            return {
                payoutId: String(entry.payoutId),
                providerWithdrawalId: item?.id === undefined || item?.id === null ? null : String(item.id),
                status: typeof item?.status === 'string' ? item.status : null
            };
        })
    };
}

/**
 * Pairs each requested entry with the provider's record of it.
 *
 * Two mechanisms, in order of strength.
 *
 * The primary one is `unique_external_id`, which was sent with the request and is echoed
 * back. That is an identity match and there is nothing to infer: two entries cannot share
 * one, because the value is derived from a withdrawal id that is unique.
 *
 * The fallback matches on the destination -- `address` plus `amount` plus `currency` -- and
 * exists only so a provider that drops or renames the external id still resolves. It runs in
 * tiers from most specific to least, each tier seeing only the entries earlier tiers could
 * not place, so a response that omits `currency` still matches on address and amount rather
 * than falling all the way to address alone.
 *
 * Every pairing must be one-to-one. A key two entries share, or that two reported items
 * share, is ambiguous and is left unpaired on purpose: an unmatched entry is recorded as
 * `WAITING` and resolved later by reconciliation, which is a delay, whereas attributing one
 * entry's status to another entry's row could mark a withdrawal resolved that never moved --
 * and a row wrongly stored as rejected is then protected by the idempotency check in
 * `applyPayoutCallback`, so the real outcome would be ignored when it finally arrives.
 *
 * One-to-one is enforced across the tiers as well as within one. The duplicate-key rule only
 * stops two entries competing for one key inside a single tier, so a report consumed by an
 * earlier tier stayed in the pool for the next one: with three entries and two reported items
 * whose addresses and amounts were equal, one item satisfied tier one for the entry that also
 * matched its currency and tier two for the entry that did not, and two withdrawal rows were
 * written from one provider record. Consumed reports are therefore removed from every later
 * tier rather than left to compete again.
 *
 * Positional pairing is deliberately absent. The provider does not document the order of the
 * `withdrawals` array as the order they were sent in, and "assume the order" is exactly the
 * kind of guess that produces a plausible-looking write to the wrong row.
 */
function matchPayoutResults(list, reported) {
    const matches = new Array(list.length).fill(null);
    if (reported.length === 0) return matches;

    // Identity first. Paired with a uniqueness requirement, so a provider that somehow echoed
    // one external id twice resolves to nothing rather than to whichever entry came first.
    // `consumed` records which reports have already been spoken for, so no later mechanism can
    // hand the same provider record to a second entry.
    const consumed = new Set();
    const externalIdOf = (entry) => String(entry?.unique_external_id ?? entry?.uniqueExternalId ?? '').trim();
    const byExternalId = new Map();
    for (let j = 0; j < reported.length; j += 1) {
        const key = externalIdOf(reported[j]);
        if (!key) continue;
        byExternalId.set(key, byExternalId.has(key) ? null : j);
    }
    if (byExternalId.size > 0) {
        for (let i = 0; i < list.length; i += 1) {
            const key = String(list[i]?.payoutId ?? '').trim();
            if (!key || !byExternalId.has(key)) continue;
            const j = byExternalId.get(key);
            if (j === null || j === undefined) continue;
            matches[i] = reported[j];
            consumed.add(j);
        }
    }
    if (matches.every((item) => item !== null)) return matches;

    const describe = (entry) => ({
        address: String(entry?.address ?? '').trim().toLowerCase(),
        currency: String(entry?.currency ?? '').trim().toLowerCase(),
        // The provider reports `amount` as a string and we send it as a number, so both sides
        // are compared numerically at a fixed precision rather than as text.
        amount: (() => {
            const value = Number(entry?.amount);
            return Number.isFinite(value) ? value.toFixed(12) : null;
        })()
    });

    const requested = list.map(describe);
    const answered = reported.map(describe);

    // Most specific first. A null key means the fields it needs are not usable on that side.
    const keyTiers = [
        (part) => (part.address && part.amount !== null ? `${part.address}|${part.amount}|${part.currency}` : null),
        (part) => (part.address && part.amount !== null ? `${part.address}|${part.amount}` : null),
        (part) => (part.address || null)
    ];

    for (const key of keyTiers) {
        const open = [];
        for (let i = 0; i < requested.length; i += 1) {
            if (matches[i] === null) open.push(i);
        }
        if (open.length === 0) break;

        // A duplicate key is stored as null, which is what makes the mapping one-to-one: two
        // entries wanting the same key resolve to nothing on either side rather than one of
        // them winning arbitrarily.
        const bucket = (indexes, parts) => {
            const map = new Map();
            for (const index of indexes) {
                const value = key(parts[index]);
                if (value === null) continue;
                map.set(value, map.has(value) ? null : index);
            }
            return map;
        };

        const requestedByKey = bucket(open, requested);
        // Reports an earlier tier already paired are excluded, so the mapping stays one-to-one
        // however many tiers a pair is found on rather than only within a single tier.
        const answeredByKey = bucket(
            answered.map((_, index) => index).filter((index) => !consumed.has(index)),
            answered
        );

        for (const [value, requestIndex] of requestedByKey) {
            if (requestIndex === null) continue;
            const answerIndex = answeredByKey.get(value);
            if (answerIndex === null || answerIndex === undefined) continue;
            matches[requestIndex] = reported[answerIndex];
            consumed.add(answerIndex);
        }
    }

    return matches;
}

/**
 * Reads the current state of a submitted payout.
 *
 * Used by reconciliation, and it is the only way out of an unknown submission outcome: when
 * the submit call fails in a way that leaves the caller unsure whether the provider acted
 * (a timeout, a dropped connection), retrying the send is not safe, but asking what already
 * happened is.
 *
 * The id should be the *individual* payout id, not the batch id. The provider's status
 * endpoint addresses a single payout, and reconciliation needs that granularity anyway: a
 * batch of three can finish one entry and reject another, and a batch-level answer would
 * force a choice between telling a user their money moved when it did not, and leaving a
 * sent payout looking unfinished. A batch id is accepted as a fallback for rows claimed
 * before the individual id was stored, and for the window between the create call and the
 * write that records it.
 *
 * Returns null when the provider cannot answer, so a caller can tell "no such payout" and
 * "could not check" apart by treating null as unresolved rather than as a failure.
 */
async function getPayoutStatus(payoutId) {
    if (!payoutsConfigured()) return null;
    const id = String(payoutId || '').trim();
    if (!id) return null;
    try {
        const result = await request('GET', `/v1/payout/${encodeURIComponent(id)}`, {
            timeoutMs: 10000,
            viaProxy: true,
        });
        return result || null;
    } catch (error) {
        // A payout the provider does not know about is a real answer -- it means the
        // submission never landed -- so it is reported rather than swallowed.
        if (error instanceof NowPaymentsError && error.status === 404) return { notFound: true };
        return null;
    }
}

/** Reads a whole batch, for the case where only the batch id is known. */
async function getPayoutBatch(batchId) {
    return getPayoutStatus(batchId);
}

// ---------------------------------------------------------------------------
// Payout 2FA
// ---------------------------------------------------------------------------

/**
 * The Base32 alphabet, and decoding a shared secret into the raw bytes a TOTP is computed from.
 *
 * Base32 is what authenticator apps show and store, and it is not Node's default encoding.
 * The alphabet is stripped of padding and case-folded so a secret copied out of a dashboard
 * with a trailing `=` or in lowercase still works -- those are the two ways a correct secret
 * gets pasted wrong, and failing on them would look like a 2FA rejection from the provider.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBuffer(secret) {
    const cleaned = String(secret || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    if (!cleaned) return null;

    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const character of cleaned) {
        const index = BASE32_ALPHABET.indexOf(character);
        if (index === -1) return null;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >>> bits) & 0xff);
        }
    }
    return bytes.length > 0 ? Buffer.from(bytes) : null;
}

/**
 * Generates the current 6-digit TOTP for a shared secret, per RFC 6238.
 *
 * Implemented here rather than with a library because it is a fixed, twenty-line algorithm
 * with published test vectors, and the TOTP package's API changed shape between its v12 and
 * v13 majors. A dependency that must be re-read on every upgrade to confirm how to call it
 * is a worse trade than the code it would replace; `test/nowpayments.test.js` checks this
 * against the RFC's own vectors.
 *
 * `epochSeconds` is a parameter so the test can pin the counter. Left to the clock, the
 * function is untestable at any interesting instant: it is correct for exactly one 30-second
 * window and changes on its own.
 */
function generateTotp(secret, { digits = 6, epochSeconds = Math.floor(Date.now() / 1000), period = 30 } = {}) {
    const key = base32ToBuffer(secret);
    if (!key) return null;

    // The counter is the number of whole periods since the Unix epoch, as a big-endian
    // 64-bit integer. `writeBigUInt64BE` is used rather than arithmetic because a counter
    // expressed in 8 bytes is what the HMAC is defined over, and building it by shifting in
    // JavaScript numbers would be limited to 32 bits of range.
    const counter = writeCounter(epochSeconds, period);
    const digest = createHmac('sha1', key).update(counter).digest();

    // Dynamic truncation, RFC 4226 section 5.3. The low nibble of the last byte selects the
    // offset of the 4-byte window, and the top bit is masked off so the result is a
    // non-negative 31-bit integer.
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);

    return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 8-byte big-endian TOTP counter for a point in time. */
function writeCounter(epochSeconds, period) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(Math.floor(epochSeconds / period)));
    return buffer;
}

/**
 * Whether automatic 2FA is possible.
 *
 * Without a TOTP secret the payout can be *created* but never *sent*: the provider holds the
 * batch until a verification code arrives, and the only way to produce one is an interactive
 * email code. That is why this is reported by `preflight` rather than discovered when a
 * withdrawal quietly stops completing.
 */
function twoFactorConfigured() {
    return Boolean(String(process.env.NOWPAYMENTS_2FA_SECRET || '').trim());
}

/**
 * Confirms a created batch so the provider actually releases it.
 *
 * This is the step that makes a payout automatic. `POST /v1/payout` only *creates* a batch:
 * the funds stay in the custody balance and nothing is sent until the batch is verified with
 * a 2FA code. A batch that is created and never verified is not a payout that failed -- it is
 * a payout that does not exist yet, which is why skipping this call produces a withdrawal that
 * sits in `processing` forever with no error anywhere.
 *
 * A fresh token is fetched rather than reusing the cached one. The create call may already
 * have consumed most of the token's five-minute life, and a verify that fails on an expired
 * token would be reported as a rejected 2FA code, which sends the operator looking in exactly
 * the wrong place.
 *
 * The batch id goes in the *path*, as the provider's own API reference documents:
 *
 *     POST /v1/payout/:batch-withdrawal-id/verify   body: { "verification_code": "123456" }
 *
 * A widely-circulated integration snippet instead posts to `/v1/payout/verify` with the id in
 * the body. That form is tried only if the documented path answers 404, which is unambiguous
 * -- a 404 means "no such endpoint here", not "rejected". Preferring the documented shape
 * matters because sending the wrong one would otherwise be reported as a rejected 2FA code,
 * which is indistinguishable from a bad code and sends the operator to check their
 * authenticator instead of the integration.
 */
async function verifyPayoutBatch(batchId, { verificationCode, logger = console } = {}) {
    const batch = String(batchId || '').trim();
    if (!batch) {
        throw new NowPaymentsError('Cannot verify a payout batch with no batch id.');
    }
    if (!twoFactorConfigured()) {
        throw new NowPaymentsError(
            'NOWPAYMENTS_2FA_SECRET is not set, so the batch cannot be verified and the payout will not be sent.'
        );
    }

    const code = String(verificationCode || '').trim() || generateTotp(process.env.NOWPAYMENTS_2FA_SECRET);
    if (!code) {
        throw new NowPaymentsError('Could not generate a NOWPayments 2FA code from the configured secret.');
    }

    const encoded = encodeURIComponent(batch);
    try {
        await request('POST', `/v1/payout/${encoded}/verify`, {
            authToken: await getAuthToken(),
            body: { verification_code: code },
            timeoutMs: 20000,
            viaProxy: true,
        });
    } catch (error) {
        const missingEndpoint = error instanceof NowPaymentsError
            && (error.status === 404 || error.status === 405);
        if (!missingEndpoint) throw error;

        logger.warn(
            `NOWPayments has no POST /v1/payout/{id}/verify endpoint (${error.status}); ` +
            'falling back to the id-in-the-body form.'
        );
        await request('POST', '/v1/payout/verify', {
            authToken: await getAuthToken(),
            body: { batch_withdrawal_id: batch, verification_code: code },
            timeoutMs: 20000,
            viaProxy: true,
        });
    }

    logger.log(`Verified NOWPayments payout batch ${batch}; it is now released for sending.`);
    return { batchId: batch, verified: true };
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
    PAYOUT_CANCELLED_SPELLINGS,

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
    twoFactorConfigured,
    generateTotp,

    getSupportedCurrencies,
    getCurrencyLimits,
    getMinimumAmount,
    convertToFiat,
    createPayment,
    getPaymentStatus,
    fixedRateEnabled,
    feePaidByUserEnabled,

    validatePayoutAddress,
    resetAddressValidationAvailability,
    getPayoutFee,
    getPayoutMinimum,
    isPayoutMinimumRefused,
    resetPayoutMinimumAvailability,
    submitPayoutBatch,
    verifyPayoutBatch,
    getPayoutBatch,
    getPayoutStatus,

    sortKeysDeep,
    verifyIpnSignature,
    classifyIpnBody
};