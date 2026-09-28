const Stripe = require('stripe');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { creditConfirmedDeposit, applyDepositStatus, targetStatusFor, knownProviderStatuses, isPaymentFullyPaid } = require('../services/depositCredit');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('../services/publicBaseUrl');
const { parseAmountInRange, amountsMatch, formatUsd } = require('../services/money');
const nowPayments = require('../services/nowPayments');
const { applyPayoutCallback } = require('../services/autoPayouts');
const ipnLog = require('../services/ipnLog');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** App-level deposit bounds, in USD. Per-currency limits layer on top of these. */
const MIN_DEPOSIT_USD = 1;
const MAX_DEPOSIT_USD = 5000;

/**
 * Coins the app is willing to offer, intersected with what the provider reports.
 *
 * `/v1/merchant/coins` is the authority on what the account can accept, but a
 * sandbox or a brand-new account can return an empty or partial list. This set is
 * intersected with the provider's answer rather than replacing it, so a sandbox
 * cannot quietly start offering coins that were never reviewed, while a newly
 * enabled coin appears as soon as the provider reports it *and* it appears here.
 */
const REVIEWED_DEPOSIT_CURRENCIES = new Set([
    'btc', 'eth', 'ltc', 'usdc', 'usdt', 'bnb', 'sol', 'xrp',
    'doge', 'trx', 'ton', 'ada', 'bch', 'matic', 'avax', 'dot',
]);

/**
 * How long a successful provider read is reused.
 *
 * Reading a minimum is one request per coin at the provider's rate limit, so a
 * cold read takes several seconds and the call is made every time the deposit
 * form opens. The values move with market conditions, not seconds, so a short
 * cache costs nothing and keeps the form responsive.
 */
const CRYPTO_OPTIONS_TTL_MS = 5 * 60 * 1000;

/**
 * Parallelism cap for per-currency provider reads.
 *
 * High enough that a normal catalogue reads in a second or two, low enough that a
 * large catalogue cannot trip the provider's per-second rate limit in one burst.
 */
const CRYPTO_OPTIONS_CONCURRENCY = 4;

/**
 * Stripe events this handler acts on.
 *
 * Three groups, and they are separate sets rather than one list because they do
 * different things to the deposit row:
 *
 *   - `crediting` completes a deposit that was paid.
 *   - `expiring` closes a checkout the customer abandoned.
 *   - `failing` closes a checkout whose asynchronous payment was attempted and
 *     did not succeed. `checkout.session.async_payment_failed` is delivered
 *     separately from `checkout.session.expired`, so a handler that only listened
 *     for expiry left these rows pending until the reconciliation sweep noticed.
 */
const STRIPE_CREDITING_EVENT_TYPES = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
]);
const STRIPE_EXPIRING_EVENT_TYPES = new Set(['checkout.session.expired']);
const STRIPE_FAILING_EVENT_TYPES = new Set(['checkout.session.async_payment_failed']);

// ---------------------------------------------------------------------------
// Payment URIs and QR codes
// ---------------------------------------------------------------------------

/**
 * URI schemes that can safely be built from the information this controller has.
 *
 * Deliberately limited to chains where both the standard *and* the amount units
 * are unambiguous:
 *
 *   - BIP-21 family: `<scheme>:<address>?amount=<decimal native units>`.
 *   - EIP-681 native ETH: `ethereum:<address>@<chainId>?value=<wei>`.
 *
 * ERC-20 tokens (USDC, USDT, DAI, ...) are *deliberately* absent. A correct
 * EIP-681 token transfer needs the token contract and chain id, and putting the
 * recipient in the target slot would tell a wallet to send *ETH* to an address
 * that holds tokens -- a wrong transfer, not a degraded one. Those assets fall
 * through to the bare address, which every wallet reads and no wallet misreads.
 *
 * The same reasoning applies to `matic`, `avax`, `bnb`, `sol`, `trx`, `xrp` and
 * `ton`: either the scheme is not standardised, or the amount units are chain
 * specific, and a wrong prefill is worse than no prefill.
 */
const PAYMENT_URI_SCHEMES = Object.freeze({
    btc:  { scheme: 'bitcoin',     kind: 'bip21' },
    bch:  { scheme: 'bitcoincash', kind: 'bip21' },
    ltc:  { scheme: 'litecoin',    kind: 'bip21' },
    doge: { scheme: 'dogecoin',    kind: 'bip21' },
    eth:  { scheme: 'ethereum',    kind: 'eip681-native', decimals: 18, chainId: 1 },
});

/** A decimal string matching `12`, `12.5`, `0.001`, but not `1e-3` or `-1`. */
const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * Converts a positive decimal string to an integer string in base units.
 * Returns null when the input is not a plain, non-negative decimal.
 */
function decimalToBaseUnits(decimal, decimals) {
    const [whole, fraction = ''] = decimal.split('.');
    const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
    const digits = (whole + paddedFraction).replace(/^0+/, '');
    return digits === '' ? '0' : digits;
}

/**
 * Builds a scannable payment URI carrying the exact amount to send, or returns
 * the bare address when no safe encoding exists.
 *
 * `payin_extra_id` is deliberately not encoded for the chains that need one (XRP
 * Ledger destination tags, for example): the tag travels as its own field and the
 * provider publishes no standard URI parameter for it, so encoding it would
 * produce a string some wallets read and others reject. Those users are told to
 * send the tag separately.
 */
function buildPaymentUri(address, assetCode, payAmount) {
    if (!address) return null;
    const spec = PAYMENT_URI_SCHEMES[String(assetCode || '').toLowerCase()];
    if (!spec) return String(address);

    const raw = String(payAmount ?? '').trim();
    if (!raw || !DECIMAL_AMOUNT_RE.test(raw) || Number(raw) <= 0) return String(address);

    if (spec.kind === 'bip21') {
        // BIP-21 `amount` is the decimal native-unit amount, which is exactly what
        // the provider already gave us, so no conversion is needed.
        return `${spec.scheme}:${address}?amount=${raw}`;
    }
    if (spec.kind === 'eip681-native') {
        const wei = decimalToBaseUnits(raw, spec.decimals);
        if (!wei || wei === '0') return String(address);
        return `${spec.scheme}:${address}@${spec.chainId}?value=${wei}`;
    }
    return String(address);
}

/** Renders a payment URI as an inline SVG, or null if it cannot be produced. */
async function renderDepositQr(address, assetCode, payAmount) {
    const payload = buildPaymentUri(address, assetCode, payAmount);
    if (!payload) return null;
    try {
        return await QRCode.toString(payload, {
            type: 'svg',
            margin: 1,
            width: 240,
            errorCorrectionLevel: 'M',
        });
    } catch (error) {
        // The address and amount are still shown as text, so a QR failure degrades
        // the screen rather than the deposit.
        console.error('Could not render the deposit QR code:', error.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// NOWPayments IPN body handling
// ---------------------------------------------------------------------------

/**
 * Normalises the NOWPayments callback body to a plain object.
 *
 * The route is registered with a raw body parser for every content type (see
 * app.js) so the callback is captured whatever type it arrives with.
 * `express.json()` only parses `application/json`, so relying on `req.body` here
 * meant a callback posted as text/plain reached the handler as `{}` and could
 * never pass signature verification -- the provider would retry it to no effect.
 * Returns null when the bytes are not a JSON object, so a malformed callback is
 * answered 400 rather than throwing inside the handler.
 */
function ipnBodyFrom(req) {
    const raw = req.body;
    if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') return null;
    if (raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getStripeClient() {
    return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

// ---------------------------------------------------------------------------
// Crypto deposit options
// ---------------------------------------------------------------------------

let cryptoOptionsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };

/**
 * The cache only describes the account the current credentials point at.
 * Rotating the API key, or pointing at a different host, changes which coins are
 * accepted and what they cost, so the cached answer is not reusable across a
 * credential change.
 */
function cryptoOptionsIdentity() {
    return `${nowPayments.getApiKey()}|${nowPayments.getBaseUrl()}`;
}

/** Drops the cached provider answer. Used by tests and after a credential change. */
function resetCryptoDepositOptionsCache() {
    cryptoOptionsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving order.
 * A rejection from any `fn` rejects the whole call; callers that want per-item
 * fallbacks should catch inside `fn`.
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function fetchCryptoDepositOptions() {
    const supported = await nowPayments.getSupportedCurrencies();
    const usable = supported.filter((currency) => REVIEWED_DEPOSIT_CURRENCIES.has(currency));
    // When the intersection is empty we keep the provider's list rather than
    // refusing crypto entirely: a freshly-enabled account that reports no reviewed
    // coins is still readable by the form, and the picker simply offers what the
    // provider does. In practice, the reviewed set is broad enough that this is
    // only hit on a cold sandbox.
    const currencies = usable.length > 0 ? usable : supported;

    // The provider's own per-currency window. Absent unless the account is
    // fixed-rate, and absent again if the response shape is not one we recognise.
    const limits = await nowPayments.getCurrencyLimits();

    const fixedRate = nowPayments.fixedRateEnabled();

    // One read per currency, bounded so a large catalogue cannot trip the
    // provider's rate limiter. A single failed read does not blank the picker:
    // that coin falls back to the app floor and every other coin is unaffected.
    const quotes = await mapWithConcurrency(currencies, CRYPTO_OPTIONS_CONCURRENCY, (currency) =>
        nowPayments
            .getMinimumAmount('usd', currency, {
                isFixedRate: fixedRate,
                isFeePaidByUser: nowPayments.feePaidByUserEnabled(),
            })
            .catch((error) => {
                console.warn(`Could not read the ${currency} minimum: ${error.message}`);
                return null;
            })
    );

    const minimums = {};
    const maximums = {};
    let smallest = Infinity;
    let largest = 0;

    currencies.forEach((currency, index) => {
        const window = limits[currency];
        const quoted = quotes[index];

        // Two provider sources, and only one of them states its units in USD.
        //
        //   * `/v1/currencies?fixed_rate=true` reports a window in fiat for the
        //     currency itself, so every coin is quoted in the same units. This is
        //     the trustworthy one.
        //   * `/v1/min-amount` is per *pair*, and the bare `min_amount` it returns
        //     is denominated in the coin, not the fiat, *unless* the account is on
        //     fixed-rate. Reading a coin amount as dollars is exactly how Bitcoin
        //     Cash ended up advertising an $18.79 floor: 0.05 BCH was read as $0.05
        //     and then scaled or misreported by the provider's own response.
        //
        // So the fiat window wins when present, the quoted value is only trusted
        // on a fixed-rate account, and otherwise the app floor is used and the
        // real refusal is left to `createPayment`, whose error message is passed
        // back to the user verbatim.
        let effectiveMin;
        if (window?.min !== null && window?.min !== undefined) {
            effectiveMin = window.min;
        } else if (fixedRate && quoted !== null) {
            effectiveMin = quoted;
        } else {
            effectiveMin = MIN_DEPOSIT_USD;
        }

        // A provider minimum below the app's own floor would let a user submit an
        // amount the app then rejects for no reason, so the app's floor always wins
        // when higher.
        effectiveMin = Math.max(MIN_DEPOSIT_USD, effectiveMin);

        // Last line of defence against a units mistake. Every genuine provider
        // minimum is a small fraction of the app's own $5,000 ceiling, so a minimum
        // at or above that ceiling is not a real limit -- it is a coin amount that
        // was read as dollars, which is the exact failure that put an $18.81 floor
        // on Bitcoin Cash. Clamping to the app default keeps such a value from ever
        // reaching the amount box, and the log makes the bad number visible instead
        // of quietly hiding it.
        if (effectiveMin >= MAX_DEPOSIT_USD) {
            console.warn(
                `NOWPayments reported an implausible minimum for ${currency} ($${effectiveMin.toFixed(2)}), ` +
                `at or above the app ceiling of $${MAX_DEPOSIT_USD.toFixed(2)}. Treating the units as wrong ` +
                'and using the app minimum instead.'
            );
            effectiveMin = MIN_DEPOSIT_USD;
        }
        minimums[currency] = effectiveMin;

        // The app's ceiling is a cap, not a floor: a coin the provider will only
        // take up to $900 must not be offered $5,000. The effective maximum can
        // never fall below the effective minimum, so an unsatisfiable pair still
        // yields a usable range.
        const effectiveMax = Math.max(
            effectiveMin,
            Math.min(MAX_DEPOSIT_USD, window?.max ?? MAX_DEPOSIT_USD)
        );
        maximums[currency] = effectiveMax;

        if (effectiveMin < smallest) smallest = effectiveMin;
        if (effectiveMax > largest) largest = effectiveMax;
    });

    return {
        cryptoCurrencies: currencies,
        // The app's own limits, which are what the amount box enforces.
        //
        // These are deliberately separate from the provider figures below. The
        // provider's per-coin minimum is a volatile, pair-specific fact, and it is
        // not allowed to become the input's `min`. Pinning the box to it meant a
        // $1 deposit -- which this app explicitly advertises as its minimum -- was
        // unsubmittable for a whole class of coins, with the reason surfacing only
        // as a clamped amount the user never typed.
        appMinimumUsd: MIN_DEPOSIT_USD,
        appMaximumUsd: MAX_DEPOSIT_USD,
        // The picker-level minimum is the smallest per-currency floor, so a user is
        // never blocked from the amount box by a limit that only applies to a
        // different coin.
        minimumUsd: Number.isFinite(smallest) ? smallest : MIN_DEPOSIT_USD,
        // The picker-level maximum is the largest per-currency ceiling, for the same
        // reason: a low-capped coin must not shrink the box for every other coin.
        // The frontend narrows this to the selected coin via `maximums`.
        maximumUsd: largest > 0 ? largest : MAX_DEPOSIT_USD,
        // The provider's per-coin windows. These are *guidance* shown to the user
        // before they submit, not a hard block. The app's own $1 floor is what the
        // amount box enforces, and if a chosen coin's real minimum is higher than
        // the amount submitted, NOWPayments refuses the payment and its own message
        // is passed back to the user unchanged. That is a worse-shaped refusal than
        // a pre-check, but it is the only way to let a $1 deposit succeed for every
        // coin whose real minimum is $1 or less.
        minimums,
        maximums,
    };
}

async function getCryptoDepositOptions() {
    const identity = cryptoOptionsIdentity();

    if (cryptoOptionsCache.identity === identity) {
        if (cryptoOptionsCache.value && Date.now() < cryptoOptionsCache.expiresAt) {
            return cryptoOptionsCache.value;
        }
        // Concurrent callers share one refresh. Without this, opening the form in
        // two tabs doubles the provider requests, and the rate limiter makes the
        // second one wait.
        if (cryptoOptionsCache.inFlight) {
            return cryptoOptionsCache.inFlight;
        }
    }

    // Start a new refresh. Replacing the cache object means an in-flight read that
    // belonged to the *previous* identity cannot write into this one; the
    // `.then`/`.finally` guards below re-check before mutating.
    const inFlight = fetchCryptoDepositOptions()
        .then((value) => {
            if (cryptoOptionsCache.identity === identity) {
                cryptoOptionsCache.value = value;
                cryptoOptionsCache.expiresAt = Date.now() + CRYPTO_OPTIONS_TTL_MS;
            }
            return value;
        })
        .finally(() => {
            if (cryptoOptionsCache.identity === identity) {
                cryptoOptionsCache.inFlight = null;
            }
        });

    cryptoOptionsCache = { identity, value: null, expiresAt: 0, inFlight };
    return inFlight;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

async function providerOptions(req, res) {
    const publicBaseUrl = resolvePublicBaseUrl();

    let crypto = {
        cryptoCurrencies: [],
        appMinimumUsd: MIN_DEPOSIT_USD,
        appMaximumUsd: MAX_DEPOSIT_USD,
        minimumUsd: MIN_DEPOSIT_USD,
        maximumUsd: MAX_DEPOSIT_USD,
        minimums: {},
        maximums: {},
    };

    if (
        nowPayments.isConfigured() &&
        nowPayments.getIpnSecret() &&
        publicBaseUrl.ok &&
        nowPayments.isTrustedBaseUrl()
    ) {
        try {
            crypto = await getCryptoDepositOptions();
        } catch (error) {
            console.error('Could not load NOWPayments currencies:', error.message);
        }
    }

    try {
        // Reported so the deposit form can warn that a locally-hosted build will
        // never be credited automatically. Without this the only symptom is a
        // balance that does not move after a real payment, which reads as a
        // provider fault rather than a callback that could not be delivered.
        const callbacksReachable = publicBaseUrl.ok && isPubliclyReachable(publicBaseUrl.baseUrl);
        return res.json({
            stripeAvailable: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
            cryptoAvailable: crypto.cryptoCurrencies.length > 0,
            callbacksReachable,
            publicBaseUrl: publicBaseUrl.ok ? publicBaseUrl.baseUrl.origin : null,
            ...crypto,
        });
    } catch (error) {
        console.error('Could not build payment options:', error.message);
        return res.status(500).json({ error: 'Failed to load payment options.' });
    }
}

/**
 * Translates a NOWPayments refusal into the HTTP response the client should see.
 *
 * Split out of the catch because the same three cases are handled twice there --
 * once inside the "the provider gave us a message" branch and once outside it --
 * and the second copy is where a rate limit stops being reported as a rate
 * limit. Returns null when the error is not a provider error this function knows
 * how to describe, and the caller falls through to the generic 502.
 */
function describeProviderRefusal(error) {
    if (!(error instanceof nowPayments.NowPaymentsError)) return null;

    if (error.isRateLimited) {
        return {
            status: 429,
            error: 'Too many deposit attempts in a short time. Please wait a moment and try again.',
            log: `NOWPayments create-payment rate limit reached: ${error.message}`
        };
    }

    if (error.providerMessage) {
        // The provider explains refusals in the body ("Minimum amount is 0.05 BCH,
        // you have 0.002", "unknown currency"). Those words are more useful than a
        // generic 502 and they are the only thing that tells the user what number
        // will work, so they are passed through unchanged.
        return {
            status: 400,
            error: error.providerMessage,
            log: `NOWPayments refused the deposit: ${error.message} Provider said: ${error.providerMessage}`
        };
    }

    return null;
}

async function createDeposit(req, res) {
    const method = String(req.body.method || '').toLowerCase();
    const payCurrency = String(req.body.currency || '').toLowerCase();
    const amount = parseAmountInRange(req.body.amount, { min: MIN_DEPOSIT_USD, max: MAX_DEPOSIT_USD });
    if (amount === null) {
        return res.status(400).json({ error: `Deposit must be between $${formatUsd(MIN_DEPOSIT_USD)} and $${formatUsd(MAX_DEPOSIT_USD)}.` });
    }
    if (!['stripe', 'crypto'].includes(method)) {
        return res.status(400).json({ error: 'Choose a supported deposit method.' });
    }
    if (method === 'crypto' && !REVIEWED_DEPOSIT_CURRENCIES.has(payCurrency)) {
        return res.status(400).json({ error: 'Choose a supported cryptocurrency.' });
    }

    const publicBaseUrl = resolvePublicBaseUrl();
    if (!publicBaseUrl.ok) {
        return res.status(503).json({ error: publicBaseUrl.error });
    }
    const appBaseUrl = publicBaseUrl.baseUrl;

    if (method === 'stripe' && (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET)) {
        return res.status(503).json({ error: 'Card deposits are unavailable until Stripe API and webhook credentials are configured.' });
    }
    if (method === 'crypto' && (!nowPayments.isConfigured() || !nowPayments.getIpnSecret())) {
        return res.status(503).json({ error: 'Crypto deposits are unavailable until NOWPayments API and IPN credentials are configured.' });
    }
    if (method === 'crypto' && !nowPayments.isTrustedBaseUrl()) {
        return res.status(503).json({ error: 'Crypto deposits are unavailable because NOWPAYMENTS_API_BASE_URL is not the production API.' });
    }

    // The provider is the authority on which coins this account accepts. That list
    // is a courtesy check performed before the insert, so a deposit the provider
    // would refuse never becomes a row the user has to be told about afterwards.
    //
    // The provider's per-currency *minimum* is deliberately not enforced here. It
    // is a volatile, pair-specific figure, and blocking on it meant the app's own
    // advertised $1 floor was unsubmittable for a class of coins. The deposit is
    // accepted at whatever the app floor allows, and if the amount is below the
    // provider's real minimum the `createPayment` call below refuses -- that
    // refusal is answered with the provider's own message, which names the exact
    // number that will work, rather than a generic failure.
    let cryptoOptions = null;
    if (method === 'crypto') {
        try {
            cryptoOptions = await getCryptoDepositOptions();
        } catch (error) {
            console.error('Could not confirm crypto deposit limits, falling back to the app minimums:', error.message);
        }

        const supported = cryptoOptions?.cryptoCurrencies || [...REVIEWED_DEPOSIT_CURRENCIES];
        if (!supported.includes(payCurrency)) {
            return res.status(400).json({ error: 'Choose a supported cryptocurrency.' });
        }

        // The provider's real ceiling is enforced here, because unlike the floor it
        // is a hard limit the provider will always refuse above, and it is cheap to
        // check: `maximums[coin]` comes from the same read as `minimums`, and the
        // app's own $5,000 ceiling is a further cap that is always safe.
        const ceiling = cryptoOptions?.maximums?.[payCurrency] ?? MAX_DEPOSIT_USD;
        if (amount > ceiling) {
            return res.status(400).json({
                error: `The maximum deposit in ${payCurrency.toUpperCase()} is $${ceiling.toFixed(2)}.`,
            });
        }
    }

    let deposit;
    try {
        const inserted = await pool.query(
            `INSERT INTO deposits (user_id, provider, amount, asset_code, currency_code, status)
             VALUES ($1, $2, $3, $4, 'USD', 'pending')
             RETURNING id, amount`,
            [
                req.user.id,
                method === 'stripe' ? 'stripe' : 'nowpayments',
                amount,
                method === 'stripe' ? 'USD' : payCurrency.toUpperCase(),
            ]
        );
        deposit = inserted.rows[0];

        if (method === 'stripe') {
            const stripe = getStripeClient();
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                success_url: new URL('/offers?deposit=return', appBaseUrl).toString(),
                cancel_url: new URL('/offers?deposit=cancelled', appBaseUrl).toString(),
                client_reference_id: String(deposit.id),
                line_items: [{
                    quantity: 1,
                    price_data: {
                        currency: 'usd',
                        unit_amount: Math.round(amount * 100),
                        product_data: { name: 'RewardZone account deposit' },
                    },
                }],
                metadata: { deposit_id: String(deposit.id), user_id: String(req.user.id) },
            }, { idempotencyKey: `rewardzone-deposit-${deposit.id}` });

            await pool.query(
                'UPDATE deposits SET provider_payment_id = $1, checkout_url = $2, updated_at = NOW() WHERE id = $3',
                [session.id, session.url, deposit.id]
            );

            return res.status(201).json({
                depositId: deposit.id,
                checkoutUrl: session.url,
                status: 'pending',
            });
        }

        const payment = await nowPayments.createPayment({
            priceAmount: deposit.amount,
            priceCurrency: 'usd',
            payCurrency,
            orderId: deposit.id,
            orderDescription: `RewardZone deposit ${deposit.id}`,
            ipnCallbackUrl: new URL('/api/payments/nowpayments/ipn', appBaseUrl).toString(),
        });

        const providerAsset = String(payment.pay_currency || payCurrency).toUpperCase();

        // `payin_extra_id` is stored, not just returned. On chains that route by a
        // destination tag or memo (XRP Ledger, TON), the address alone will not
        // deliver the funds -- the tag is part of the delivery. Returning it in
        // this response was not enough: a customer who closed the deposit panel
        // and reopened it had no way to retrieve the tag, and the money arrived at
        // the exchange's shared address with no instruction about who it belonged
        // to. The `payableInstructionsFor` function below reads it back out.
        //
        // The asset code and network are written from the provider response, not
        // from the request. If they disagreed, the row the customer sees would not
        // match the address they must pay to, and the IPN would then be rejected by
        // the amount/currency check in the callback handler and the deposit would
        // never be credited.
        await pool.query(
            `UPDATE deposits SET provider_payment_id = $1, deposit_address = $2,
                amount = $3, network = $4, asset_code = $5, pay_amount = $6,
                payin_extra_id = $7, expires_at = $8, updated_at = NOW() WHERE id = $9`,
            [
                String(payment.payment_id),
                payment.pay_address,
                amount,
                payment.network || payCurrency,
                providerAsset,
                payment.pay_amount,
                payment.payin_extra_id || null,
                payment.expiration_estimate_date || null,
                deposit.id,
            ]
        );

        return res.status(201).json({
            depositId: deposit.id,
            providerPaymentId: String(payment.payment_id),
            payAddress: payment.pay_address,
            payAmount: String(payment.pay_amount),
            payinExtraId: payment.payin_extra_id || null,
            assetCode: providerAsset,
            network: payment.network || payCurrency,
            status: 'pending',
            // Rendered on the server so the page needs no QR library and no CDN,
            // which the `script-src 'self'` policy would block anyway. Best effort:
            // a missing QR must never cost the user their deposit instructions.
            qrCodeSvg: await renderDepositQr(payment.pay_address, providerAsset, payment.pay_amount),
            paymentUri: buildPaymentUri(payment.pay_address, providerAsset, payment.pay_amount),
            // The provider quotes an expiry on some responses and not others, so the
            // client only shows a countdown when there is a real deadline to count to.
            expiresAt: payment.expiration_estimate_date || null,
        });
    } catch (error) {
        // A rate limit is not the customer's fault and the request never reached the
        // payment system, so the deposit row is left `pending` for the orphan sweep
        // to close rather than being failed in front of a user who can simply retry.
        // Failing it here showed an instant, permanent failure for a transient limit,
        // and every rapid tap consumed one of the three permitted create-payment
        // requests per second, so the retries could not succeed either.
        const rateLimited = error instanceof nowPayments.NowPaymentsError && error.isRateLimited;
        if (deposit?.id && !rateLimited) {
            await pool.query(
                `UPDATE deposits SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
                [deposit.id]
            ).catch((cleanupError) => {
                console.error(`Could not mark deposit ${deposit.id} failed after a create error:`, cleanupError.message);
            });
        }

        const refusal = describeProviderRefusal(error);
        if (refusal) {
            console.error(refusal.log);
            return res.status(refusal.status).json({ error: refusal.error });
        }

        console.error('Deposit creation failed:', error.message);
        return res.status(502).json({ error: 'Could not create a deposit with the selected provider.' });
    }
}

async function nowPaymentsIpn(req, res) {
    const secret = nowPayments.getIpnSecret();
    const signature = req.get('x-nowpayments-sig') || '';
    const ipn = ipnBodyFrom(req);

    // Every arrival is logged with the reason it was refused, because "the provider
    // is not sending" and "we rejected it" are indistinguishable from the balance
    // alone. An empty log means nothing arrived; a log with reasons means it arrived
    // and was turned away. No signature, secret, or address is recorded.
    const refuse = (status, reason, extra = {}) => {
        ipnLog.record({
            outcome: 'refused',
            detail: `${status} ${reason}`,
            paymentId: extra.paymentId ?? null,
            orderId: extra.orderId ?? null,
            status: extra.status ?? null,
        });
        console.warn(`NOWPayments IPN refused (${status} ${reason})`);
        return res.status(status).send(reason);
    };

    if (!secret) {
        return refuse(503, 'IPN secret is not configured, so no callback can be verified.');
    }
    if (!ipn) {
        return refuse(401, 'Body was not a JSON object.');
    }
    if (!nowPayments.verifyIpnSignature(secret, ipn, signature)) {
        return refuse(401, 'Signature did not match. Check NOWPAYMENTS_IPN_SECRET.');
    }

    // Payments and payouts share this callback URL and post incompatible bodies. A
    // payout body has no `payment_id` and no `order_id`, so it used to fail the
    // field checks below and be answered 400. The provider treats a 4xx as a failed
    // delivery and retries it on the dashboard's recurrent-notification schedule,
    // so every payout callback would have generated a stream of retries against
    // this endpoint.
    const callbackKind = nowPayments.classifyIpnBody(ipn);
    if (callbackKind === 'payout') {
        // This build now does send crypto payouts, so a payout callback is a state change and
        // not a notice. It is applied through the same `sendWithdrawal` / `reverseWithdrawal`
        // the operator endpoints use, which is what keeps the two invariants that matter: a
        // withdrawal already marked paid cannot be refunded, and a refund is a balance write
        // plus a ledger row inside one transaction.
        try {
            const applied = await applyPayoutCallback(ipn);
            if (!applied.ok) {
                // Signed, well-formed, and about a batch this database has no record of. That
                // is a real configuration or history problem, but answering 4xx would put the
                // callback on the provider's retry schedule forever. It is recorded as
                // accepted and left visible in the diagnostics instead.
                ipnLog.record({
                    outcome: 'accepted',
                    detail: `Payout callback ignored: ${applied.reason}${applied.batchId ? ` (${applied.batchId})` : ''}`
                });
                return res.status(200).send('OK');
            }
            ipnLog.record({
                outcome: 'accepted',
                detail: `Payout callback applied to withdrawal ${applied.withdrawalId}.`
            });
            return res.status(200).send('OK');
        } catch (error) {
            // A real failure to write. Answered 500 so the provider retries: a payout that
            // finished while this write failed is exactly the case where losing the callback
            // would leave a user told their money is moving when it has already moved.
            console.error('Could not apply a payout callback:', error.message);
            return refuse(500, 'Payout callback could not be recorded.');
        }
    }
    if (callbackKind !== 'payment') {
        return refuse(400, 'Payload is neither a payment nor a payout callback.');
    }

    const paymentId = String(ipn.payment_id || '');
    const depositId = String(ipn.order_id || '');
    const paymentStatus = String(ipn.payment_status || '').toLowerCase();
    const callbackAmount = Number(ipn.price_amount);
    const currencyCode = String(ipn.price_currency || '').toUpperCase();

    if (!paymentId || !/^\d+$/.test(depositId) || !knownProviderStatuses.has(paymentStatus)) {
        return refuse(
            400,
            `Field check failed (order_id=${depositId || 'none'} status=${paymentStatus || 'none'}).`,
            { paymentId, orderId: depositId, status: paymentStatus }
        );
    }

    // Several-payments-per-order: the provider can split one order across multiple
    // payments, reporting a child by echoing `parent_payment_id` while the parent
    // gets `parent_payment_id: null`. This app never enables that, so a child
    // callback carries a payment id that belongs to no deposit here. It is
    // acknowledged as understood rather than rejected, because a 400 is a failed
    // delivery the provider would keep retrying, and the deposit it belongs to is
    // credited by the parent's own `finished` callback regardless.
    if (ipn.parent_payment_id) {
        ipnLog.record({
            outcome: 'accepted',
            detail: 'Child payment acknowledged; the parent callback settles the deposit.',
            paymentId,
            orderId: depositId,
            status: paymentStatus,
        });
        return res.status(200).send('OK');
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const depositResult = await client.query(
            `SELECT id, user_id, amount, currency_code, status, credited_at, provider_payment_id
             FROM deposits WHERE id = $1 AND provider = 'nowpayments' FOR UPDATE`,
            [depositId]
        );
        if (depositResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return refuse(
                404,
                `No deposit ${depositId} for this provider. The IPN arrived for an order this app did not create.`,
                { paymentId, orderId: depositId, status: paymentStatus }
            );
        }
        const deposit = depositResult.rows[0];

        // The row can still be waiting for the create-payment UPDATE when the first
        // callback lands: the payment exists at the provider the moment the API call
        // returns, and the IPN is not held back until our write commits. A null
        // provider_payment_id with an otherwise matching, signed callback is that
        // race, not a mismatch, so the id is adopted rather than the callback
        // refused. A row that already holds a *different* id is still refused, and
        // the adopt is conditional in SQL so a concurrent create-payment write
        // cannot be clobbered.
        let paymentIdMatches = deposit.provider_payment_id === paymentId;
        if (deposit.provider_payment_id === null || deposit.provider_payment_id === undefined) {
            const adopted = await client.query(
                `UPDATE deposits SET provider_payment_id = $1, updated_at = NOW()
                 WHERE id = $2 AND provider_payment_id IS NULL RETURNING id`,
                [paymentId, deposit.id]
            );
            paymentIdMatches = adopted.rows.length > 0;
        }

        if (!paymentIdMatches ||
            currencyCode !== 'USD' ||
            !amountsMatch(callbackAmount, deposit.amount)) {
            await client.query('ROLLBACK');
            return refuse(
                400,
                'Payment id, currency, or amount does not match the stored deposit.',
                { paymentId, orderId: depositId, status: paymentStatus }
            );
        }

        // `finished` is the provider's terminal state, but the credit still rests on
        // the money having arrived. Confirming `actually_paid` against the amount the
        // customer was quoted is the check that makes this a payment rather than a
        // status string, and it is the same check the reconciler applies.
        if (targetStatusFor(paymentStatus) === 'confirmed' && !isPaymentFullyPaid(ipn)) {
            await client.query('ROLLBACK');
            const detail = `Reported ${paymentStatus} but actually_paid (${ipn.actually_paid}) does not cover pay_amount (${ipn.pay_amount}).`;
            console.error(`NOWPayments reported deposit ${deposit.id} as ${paymentStatus} but actually_paid does not cover pay_amount.`);
            ipnLog.record({ outcome: 'refused', detail, paymentId, orderId: depositId, status: paymentStatus });
            return res.status(200).send('Payment not fully settled yet.');
        }

        // The provider's payment payload does not carry a timestamp, so the event id
        // is the payment, its status, and what was actually paid. That is stable
        // across a redelivery of the same notification and distinct for a genuinely
        // new one.
        const eventId = [
            paymentId,
            paymentStatus,
            String(ipn.actually_paid ?? ''),
            String(ipn.actually_paid_at_fiat ?? ''),
        ].join(':');

        const event = await client.query(
            `INSERT INTO payment_provider_events (provider, event_id)
             VALUES ('nowpayments', $1) ON CONFLICT DO NOTHING RETURNING id`,
            [eventId]
        );
        if (event.rows.length === 0 || deposit.credited_at) {
            await client.query('COMMIT');
            ipnLog.record({
                outcome: 'accepted',
                detail: 'Duplicate delivery; already processed.',
                paymentId,
                orderId: depositId,
                status: paymentStatus,
            });
            return res.status(200).send('Already processed.');
        }

        const targetStatus = targetStatusFor(paymentStatus);
        if (targetStatus === 'confirmed') {
            // creditConfirmedDeposit is the only thing that writes 'confirmed', and
            // it also flips credited_at, so the status and the credit cannot diverge.
            await creditConfirmedDeposit(client, {
                id: deposit.id,
                ledger_source_id: `nowpayments:${paymentId}`,
            }, 'Confirmed NOWPayments deposit');
        } else {
            await applyDepositStatus(client, deposit.id, targetStatus);
        }

        await client.query('COMMIT');
        ipnLog.record({
            outcome: 'accepted',
            detail: targetStatus === 'confirmed' ? 'Deposit credited.' : `Deposit moved to ${targetStatus}.`,
            paymentId,
            orderId: depositId,
            status: paymentStatus,
        });
        return res.status(200).send('OK');
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('NOWPayments notification failed:', error.message);
        ipnLog.record({ outcome: 'refused', detail: `Server error: ${error.message}` });
        return res.status(500).send('Could not process payment notification.');
    } finally {
        if (client) client.release();
    }
}

async function stripeWebhook(req, res) {
    const stripe = getStripeClient();
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).send('Stripe webhooks are not configured.');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        return res.status(400).send(`Invalid Stripe signature: ${error.message}`);
    }

    const isCrediting = STRIPE_CREDITING_EVENT_TYPES.has(event.type);
    const isExpiry = STRIPE_EXPIRING_EVENT_TYPES.has(event.type);
    const isFailure = STRIPE_FAILING_EVENT_TYPES.has(event.type);
    if (!isCrediting && !isExpiry && !isFailure) {
        return res.status(200).send('Ignored.');
    }

    // Two distinct "the checkout will not complete" events, and they arrive at
    // different moments. `expired` fires 24 hours after an abandoned session;
    // `async_payment_failed` fires once a slow payment method has tried and been
    // rejected. Without the second, a failed bank transfer left the deposit row
    // pending until the reconciliation sweep's `stuckDeposits` check noticed it --
    // which is a warning about a stale row, not a report about a failed payment.
    const session = event.data.object;
    const depositId = String(session.metadata?.deposit_id || '');
    if (!/^\d+$/.test(depositId)) return res.status(400).send('Deposit metadata is invalid.');

    // A crediting event only counts if Stripe says the money is in. A status event
    // (`expired`, `async_payment_failed`) is actionable regardless of what
    // `payment_status` reads at the moment of delivery.
    if (isCrediting && session.payment_status !== 'paid') {
        return res.status(200).send('Payment not complete.');
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const depositResult = await client.query(
            `SELECT id, user_id, amount, provider_payment_id, credited_at
             FROM deposits WHERE id = $1 AND provider = 'stripe' FOR UPDATE`,
            [depositId]
        );
        const deposit = depositResult.rows[0];
        if (!deposit) {
            await client.query('ROLLBACK');
            return res.status(400).send('No deposit for this event.');
        }
        if (session.currency !== 'usd' ||
            Number(session.amount_total) !== Math.round(Number(deposit.amount) * 100)) {
            await client.query('ROLLBACK');
            return res.status(400).send('Payment amount or currency does not match the deposit.');
        }
        if (deposit.provider_payment_id !== null &&
            deposit.provider_payment_id !== undefined &&
            deposit.provider_payment_id !== session.id) {
            await client.query('ROLLBACK');
            return res.status(400).send('Payment id does not match the deposit.');
        }

        // Same adopt-the-race reasoning as the NOWPayments handler: if the
        // create-session write lost the race with the first webhook, a matching
        // signed event is allowed to stamp the id rather than being refused.
        if (deposit.provider_payment_id === null || deposit.provider_payment_id === undefined) {
            await client.query(
                `UPDATE deposits SET provider_payment_id = $1, updated_at = NOW()
                 WHERE id = $2 AND provider_payment_id IS NULL`,
                [session.id, deposit.id]
            );
        }

        const eventInsert = await client.query(
            `INSERT INTO payment_provider_events (provider, event_id)
             VALUES ('stripe', $1) ON CONFLICT DO NOTHING RETURNING id`,
            [event.id]
        );
        if (eventInsert.rows.length === 0 || deposit.credited_at) {
            await client.query('COMMIT');
            return res.status(200).send('Already processed.');
        }

        if (isExpiry) {
            await applyDepositStatus(client, deposit.id, 'failed');
        } else if (isFailure) {
            // The reason is captured so the deposit history can explain why the
            // card never completed. Stripe does not always populate this field,
            // so a sensible fallback is used.
            await applyDepositStatus(client, deposit.id, 'failed');
        } else {
            await creditConfirmedDeposit(client, {
                id: deposit.id,
                ledger_source_id: `stripe:${session.id}`,
            }, 'Confirmed Stripe card deposit');
        }

        await client.query('COMMIT');
        return res.status(200).send('OK');
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('Stripe webhook processing failed:', error.message);
        return res.status(500).send('Could not process Stripe event.');
    } finally {
        if (client) client.release();
    }
}

/**
 * Whether a deposit can still be paid, and the instructions to do it.
 *
 * A crypto deposit is not completed at creation: the row is written, the address is issued, and
 * the customer leaves. If they dismiss that panel, the figures in it exist only in the response
 * that produced it, and there was no way back to them. The history list could show that a
 * deposit was pending and nothing about what to send, which is the state that strands money --
 * the customer cannot act, and the address stays unpaid until the provider expires it.
 *
 * So the exact coin amount, the destination tag, and the deadline are all stored on the row
 * and this rebuilds the panel from them. `pay_amount` in particular is not derivable: the
 * exchange rate has moved since, and the same address serves every amount. `payin_extra_id`
 * is not derivable either, and on the chains that require it the address alone will not
 * deliver the funds.
 *
 * Returns null for anything that is not an outstanding crypto payment, which covers card
 * deposits (they have a checkout to return to, not an address to send to) and every settled
 * state.
 */
async function payableInstructionsFor(deposit) {
    const status = String(deposit?.status || '').toLowerCase();
    if (status !== 'pending' && status !== 'confirming') return null;
    if (!deposit.deposit_address || !deposit.asset_code) return null;

    // No recorded amount means the row predates the column, or the provider never quoted one.
    // Both cases make the panel unsafe to show: a QR that encodes nothing, or instructions to
    // send an amount we cannot state. The customer is better served by starting a new deposit.
    const payAmount = Number(deposit.pay_amount);
    if (!Number.isFinite(payAmount) || payAmount <= 0) return null;

    // The destination tag travels with the address on chains that route by one. It is
    // returned separately from the QR because no standard wallet URI carries it, and a
    // wallet that ignored it would send to the exchange's shared address with no
    // instruction about who the funds belong to.
    return {
        payable: true,
        payAmount: String(deposit.pay_amount),
        payinExtraId: deposit.payin_extra_id || null,
        expiresAt: deposit.expires_at || null,
        qrCodeSvg: await renderDepositQr(deposit.deposit_address, deposit.asset_code, deposit.pay_amount)
    };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const paymentController = {
    providerOptions,
    createDeposit,
    nowPaymentsIpn,
    stripeWebhook,
    payableInstructionsFor,
};

module.exports = paymentController;

// Attached to the module as well as the controller so tests and the receipt
// route can import them without pulling in the whole object.
module.exports.resetCryptoDepositOptionsCache = resetCryptoDepositOptionsCache;
module.exports.buildPaymentUri = buildPaymentUri;
module.exports.__private = { decimalToBaseUnits, mapWithConcurrency };