const Stripe = require('stripe');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { creditConfirmedDeposit, applyDepositStatus, targetStatusFor, knownProviderStatuses, isPaymentFullyPaid } = require('../services/depositCredit');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');
const { parseAmountInRange, amountsMatch } = require('../services/money');
const nowPayments = require('../services/nowPayments');
const ipnLog = require('../services/ipnLog');
const { isPubliclyReachable } = require('../services/publicBaseUrl');

/**
 * Coins the app is willing to offer, used as a floor on what the provider reports.
 *
 * `/v1/merchant/coins` is the authority on what the account can accept, but a sandbox or a
 * brand-new account can return an empty or partial list. This set is intersected with the
 * provider's answer rather than replacing it, so a sandbox cannot quietly start offering
 * coins that were never reviewed, while a newly enabled coin appears as soon as the
 * provider reports it.
 */
const reviewedDepositCurrencies = new Set([
    'btc', 'eth', 'ltc', 'usdc', 'usdt', 'bnb', 'sol', 'xrp',
    'doge', 'trx', 'ton', 'ada', 'bch', 'matic', 'avax', 'dot'
]);

const minimumDepositUsd = 1;
const maximumDepositUsd = 5000;

/**
 * URI schemes for the coins most likely to be picked on a phone.
 *
 * A bare address in a QR is scannable, but it leaves the user to type the amount, and
 * typing it is exactly where people get the decimals wrong. Encoding the amount into the
 * URI lets the wallet prefill it. Only the schemes that are actually standardised are
 * listed; anything else falls back to the bare address, which every wallet still reads.
 */
const paymentUriSchemes = {
    btc: 'bitcoin', bch: 'bitcoincash', ltc: 'litecoin', doge: 'dogecoin',
    eth: 'ethereum', usdc: 'ethereum', usdt: 'ethereum', dai: 'ethereum',
    matic: 'ethereum', avax: 'ethereum', dot: 'polkadot',
    bnb: 'binance', sol: 'solana', trx: 'tron', xrp: 'ripple', ton: 'ton'
};

/**
 * Builds a scannable payment URI carrying the exact amount to send.
 *
 * `payin_extra_id` is deliberately not encoded for the chains that need one (XRP Ledger
 * destination tags, for example): the tag travels as its own field and the provider
 * publishes no standard URI parameter for it, so encoding it would produce a string some
 * wallets read and others reject. Those users are told to send the tag separately.
 */
function buildPaymentUri(address, assetCode, payAmount) {
    if (!address) return null;
    const scheme = paymentUriSchemes[String(assetCode || '').toLowerCase()];
    if (!scheme) return String(address);
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) return String(address);
    return `${scheme}:${address}?amount=${amount}`;
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
            errorCorrectionLevel: 'M'
        });
    } catch (error) {
        // The address and amount are still shown as text, so a QR failure degrades the
        // screen rather than the deposit.
        console.error('Could not render the deposit QR code:', error.message);
        return null;
    }
}

const creditingStripeEventTypes = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded'
]);
const expiringStripeEventTypes = new Set(['checkout.session.expired']);

/**
 * Normalises the NOWPayments callback body to a plain object.
 *
 * The route is registered with a raw body parser for every content type (see app.js) so
 * the callback is captured whatever type it arrives with. `express.json()` only parses
 * `application/json`, so relying on req.body here meant a callback posted as text/plain
 * reached the handler as `{}` and could never pass signature verification -- the provider
 * would retry it to no effect. Returns null when the bytes are not a JSON object, so a
 * malformed callback is answered 400 rather than throwing inside the handler.
 */
function ipnBodyFrom(req) {
    const raw = req.body;
    if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') return null;
    if (raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
}

function getStripeClient() {
    return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

/**
 * Reports the currencies crypto deposits can use, and the real minimum for each.
 *
 * The minimum used to be a flat $1 advertised to the user and enforced by the app. The
 * provider's floor is per currency pair and higher than that for most coins, so those
 * deposits were accepted by the app and then refused by the provider after the customer
 * had already chosen an amount. Each currency is now reported with the minimum the
 * provider actually quoted, and a currency whose minimum could not be read keeps the app's
 * own floor rather than being dropped from the picker.
 *
 * The result is cached briefly. Reading a minimum is one request per coin at the
 * provider's rate limit, so a cold read of every supported currency takes several seconds
 * and the call is made every time the deposit form is opened. The values move with market
 * conditions, not seconds, so a short cache costs nothing and keeps the form responsive.
 */
const CRYPTO_OPTIONS_TTL_MS = 5 * 60 * 1000;
let cryptoOptionsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };

/**
 * The cache only describes the account the current credentials point at. Rotating the API
 * key, or pointing at a different host, changes which coins are accepted and what they
 * cost, so the cached answer is not reusable across a credential change.
 */
function cryptoOptionsIdentity() {
    return `${nowPayments.getApiKey()}|${nowPayments.getBaseUrl()}`;
}

/** Drops the cached provider answer. Used by tests and after a credential change. */
function resetCryptoDepositOptionsCache() {
    cryptoOptionsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };
}

async function fetchCryptoDepositOptions() {
    const supported = await nowPayments.getSupportedCurrencies();
    const usable = supported.filter((currency) => reviewedDepositCurrencies.has(currency));
    const currencies = usable.length > 0 ? usable : supported;

    // The provider's own per-currency window. Absent unless the account is fixed-rate, and
    // absent again if the response shape is not one we recognise -- in both cases this is
    // an empty map and the app's own ceiling applies, exactly as it did before.
    const limits = await nowPayments.getCurrencyLimits();

    const minimums = {};
    const maximums = {};
    let smallest = Infinity;
    let largest = 0;
    for (const currency of currencies) {
        const window = limits[currency];
        const quoted = await nowPayments.getMinimumAmount('usd', currency, {
            isFixedRate: nowPayments.fixedRateEnabled(),
            isFeePaidByUser: nowPayments.feePaidByUserEnabled()
        });

        // Two provider sources for the same floor, and they are not equally trustworthy.
        // `/v1/currencies?fixed_rate=true` states a window in fiat for the currency
        // itself, so every coin is quoted in the same units. `/v1/min-amount` is per *pair*
        // and its bare `min_amount` is denominated in the coin, not the fiat, which is how
        // Bitcoin Cash ended up advertising an $18.81 minimum and rejecting ordinary
        // deposits below it. Where the two disagree by more than a plausible margin the
        // window wins, because it is the one whose units are known.
        let effectiveMin;
        if (window?.min !== null && window?.min !== undefined) {
            if (quoted !== null && quoted > window.min * 4) {
                console.warn(
                    `NOWPayments quoted a ${currency} minimum of $${quoted.toFixed(2)} but its own ` +
                    `fixed-rate window starts at $${window.min.toFixed(2)}; using the window.`
                );
            }
            effectiveMin = window.min;
        } else {
            effectiveMin = quoted ?? minimumDepositUsd;
        }

        // A provider minimum below the app's own floor would let a user submit an amount
        // the app then rejects for no reason, so the app's floor always wins when higher.
        effectiveMin = Math.max(minimumDepositUsd, effectiveMin);

        // Last line of defence against a units mistake. Every genuine provider minimum is
        // a small fraction of the app's own $5,000 ceiling, so a minimum at or above that
        // ceiling is not a real limit -- it is a coin amount that was read as dollars,
        // which is the exact failure that put an $18.81 floor on Bitcoin Cash. Clamping to
        // the app default keeps such a value from ever reaching the amount box, and the log
        // makes the bad number visible instead of quietly hiding it.
        if (effectiveMin >= maximumDepositUsd) {
            console.warn(
                `NOWPayments reported an implausible minimum for ${currency} ($${effectiveMin.toFixed(2)}), ` +
                `at or above the app ceiling of $${maximumDepositUsd.toFixed(2)}. Treating the units as wrong ` +
                'and using the app minimum instead.'
            );
            effectiveMin = minimumDepositUsd;
        }
        minimums[currency] = effectiveMin;

        // The app's ceiling is a cap, not a floor: a coin the provider will only take up
        // to $900 must not be offered $5,000. The effective maximum can never fall below
        // the effective minimum, so an unsatisfiable pair still yields a usable range.
        const effectiveMax = Math.max(effectiveMin, Math.min(maximumDepositUsd, window?.max ?? maximumDepositUsd));
        maximums[currency] = effectiveMax;

        if (effectiveMin < smallest) smallest = effectiveMin;
        if (effectiveMax > largest) largest = effectiveMax;
    }

    return {
        cryptoCurrencies: currencies,
        // The picker-level minimum is the smallest per-currency floor, so a user is never
        // blocked from the amount box by a limit that only applies to a different coin.
        minimumUsd: Number.isFinite(smallest) ? smallest : minimumDepositUsd,
        // The picker-level maximum is the largest per-currency ceiling, for the same
        // reason: a low-capped coin must not shrink the box for every other coin. The
        // frontend narrows this to the selected coin via `maximums`.
        maximumUsd: largest > 0 ? largest : maximumDepositUsd,
        minimums,
        maximums
    };
}

async function getCryptoDepositOptions() {
    const identity = cryptoOptionsIdentity();
    if (cryptoOptionsCache.identity === identity &&
        cryptoOptionsCache.value && Date.now() < cryptoOptionsCache.expiresAt) {
        return cryptoOptionsCache.value;
    }
    // Concurrent callers share one refresh. Without this, opening the form in two tabs
    // doubles the provider requests, and the rate limiter makes the second one wait.
    if (!cryptoOptionsCache.inFlight || cryptoOptionsCache.identity !== identity) {
        cryptoOptionsCache = { identity, value: null, expiresAt: 0, inFlight: null };
        cryptoOptionsCache.inFlight = fetchCryptoDepositOptions()
            .then((value) => {
                // Only store it if the credentials are still the ones it was read with.
                if (cryptoOptionsCache.identity === identity) {
                    cryptoOptionsCache.value = value;
                    cryptoOptionsCache.expiresAt = Date.now() + CRYPTO_OPTIONS_TTL_MS;
                }
                return value;
            })
            .finally(() => { cryptoOptionsCache.inFlight = null; });
    }
    return cryptoOptionsCache.inFlight;
}



async function providerOptions(req, res) {
    let crypto = {
        cryptoCurrencies: [],
        minimumUsd: minimumDepositUsd,
        maximumUsd: maximumDepositUsd,
        minimums: {},
        maximums: {}
    };
    if (nowPayments.isConfigured() && nowPayments.getIpnSecret() &&
        resolvePublicBaseUrl().ok && nowPayments.isTrustedBaseUrl()) {
        try {
            crypto = await getCryptoDepositOptions();
        } catch (error) {
            console.error('Could not load NOWPayments currencies:', error.message);
        }
    }
    try {
        const publicBaseUrl = resolvePublicBaseUrl();
        // Reported so the deposit form can warn that a locally-hosted build will never be
        // credited automatically. Without this the only symptom is a balance that does not
        // move after a real payment, which reads as a provider fault rather than a
        // callback that could not be delivered.
        const callbacksReachable = publicBaseUrl.ok && isPubliclyReachable(publicBaseUrl.baseUrl);
        return res.json({
            stripeAvailable: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
            cryptoAvailable: crypto.cryptoCurrencies.length > 0,
            callbacksReachable,
            publicBaseUrl: publicBaseUrl.ok ? publicBaseUrl.baseUrl.origin : null,
            ...crypto
        });
    } catch (error) {
        console.error('Could not build payment options:', error.message);
        return res.status(500).json({ error: 'Failed to load payment options.' });
    }
}


const paymentController = {
    providerOptions,

    createDeposit: async (req, res) => {
        const method = String(req.body.method || '').toLowerCase();
        const payCurrency = String(req.body.currency || '').toLowerCase();
        const amount = parseAmountInRange(req.body.amount, { min: minimumDepositUsd, max: maximumDepositUsd });
        if (amount === null) {
            return res.status(400).json({ error: 'Deposit must be between $1 and $5,000.' });
        }
        if (!['stripe', 'crypto'].includes(method)) {
            return res.status(400).json({ error: 'Choose a supported deposit method.' });
        }
        if (method === 'crypto' && !reviewedDepositCurrencies.has(payCurrency)) {
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
            return res.status(503).json({ error: 'Crypto deposits are unavailable because NOWPayments_API_BASE_URL is not the production API.' });
        }

        // The provider is the authority on which coins this account accepts, and on the
        // real minimum for each. Both are a courtesy check performed before the insert, so
        // a deposit the provider would refuse never becomes a row the user has to be told
        // about afterwards. If the pre-flight cannot be completed the request proceeds on
        // the app's own list and floor rather than being refused: the provider is still the
        // authority at payment creation, so falling back costs a clear error there, while
        // failing closed would turn a transient provider outage into a total deposit
        // outage for every user.
        let cryptoOptions = null;
        if (method === 'crypto') {
            try {
                cryptoOptions = await getCryptoDepositOptions();
            } catch (error) {
                console.error('Could not confirm crypto deposit limits, falling back to the app minimums:', error.message);
            }
            const supported = cryptoOptions?.cryptoCurrencies || [...reviewedDepositCurrencies];
            if (!supported.includes(payCurrency)) {
                return res.status(400).json({ error: 'Choose a supported cryptocurrency.' });
            }
            const required = cryptoOptions?.minimums?.[payCurrency] ?? minimumDepositUsd;
            if (amount < required) {
                return res.status(400).json({
                    error: `The minimum deposit in ${payCurrency.toUpperCase()} is $${required.toFixed(2)}.`
                });
            }
            // Checked against the provider's real ceiling as well as the app's own, so an
            // amount the provider would refuse is caught before the user commits to it.
            // The message names the coin, because the ceiling is per-currency.
            const ceiling = cryptoOptions?.maximums?.[payCurrency] ?? maximumDepositUsd;
            if (amount > ceiling) {
                return res.status(400).json({
                    error: `The maximum deposit in ${payCurrency.toUpperCase()} is $${ceiling.toFixed(2)}.`
                });
            }
        }


        let deposit;
        try {
            const inserted = await pool.query(
                `INSERT INTO deposits (user_id, provider, amount, asset_code, currency_code, status)
                 VALUES ($1, $2, $3, $4, 'USD', 'pending')
                 RETURNING id, amount`,
                [req.user.id, method === 'stripe' ? 'stripe' : 'nowpayments', amount, method === 'stripe' ? 'USD' : payCurrency.toUpperCase()]
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
                            product_data: { name: 'RewardZone account deposit' }
                        }
                    }],
                    metadata: { deposit_id: String(deposit.id), user_id: String(req.user.id) }
                }, { idempotencyKey: `rewardzone-deposit-${deposit.id}` });
                await pool.query(
                    'UPDATE deposits SET provider_payment_id = $1, checkout_url = $2, updated_at = NOW() WHERE id = $3',
                    [session.id, session.url, deposit.id]
                );
                return res.status(201).json({ depositId: deposit.id, checkoutUrl: session.url, status: 'pending' });
            }

            const payment = await nowPayments.createPayment({
                priceAmount: deposit.amount,
                priceCurrency: 'usd',
                payCurrency,
                orderId: deposit.id,
                orderDescription: `RewardZone deposit ${deposit.id}`,
                ipnCallbackUrl: new URL('/api/payments/nowpayments/ipn', appBaseUrl).toString()
            });
            const providerAsset = String(payment.pay_currency || payCurrency).toUpperCase();
            // The asset code and network are written from the provider response, not
            // from the request. If they disagreed, the row the customer sees would not
            // match the address they must pay to, and the IPN would then be rejected by
            // the amount/currency check below and the deposit would never be credited.
            await pool.query(
                `UPDATE deposits SET provider_payment_id = $1, deposit_address = $2,
                    amount = $3, network = $4, asset_code = $5, updated_at = NOW() WHERE id = $6`,
                [String(payment.payment_id), payment.pay_address, amount, payment.network || payCurrency, providerAsset, deposit.id]
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
                expiresAt: payment.expiration_estimate_date || null
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
                ).catch(() => {});
            }
            // The provider explains refusals in the body ("Minimum amount is ...", unknown
            // currency). The caller logs the provider's own words so an operator can act,
            // but the client response stays generic.
            const providerDetail = error instanceof nowPayments.NowPaymentsError && error.providerMessage
                ? `${error.message} Provider said: ${error.providerMessage}`
                : error.message;
            if (rateLimited) {
                console.error('NOWPayments create-payment rate limit reached:', providerDetail);
                return res.status(429).json({
                    error: 'Too many deposit attempts in a short time. Please wait a moment and try again.'
                });
            }
            console.error('Deposit creation failed:', providerDetail);
            return res.status(502).json({ error: 'Could not create a deposit with the selected provider.' });
        }
    },

    nowPaymentsIpn: async (req, res) => {
        const secret = nowPayments.getIpnSecret();
        const signature = req.get('x-nowpayments-sig') || '';
        const ipn = ipnBodyFrom(req);

        // Every arrival is logged with the reason it was refused, because "the provider is
        // not sending" and "we rejected it" are indistinguishable from the balance alone.
        // An empty log means nothing arrived; a log with reasons means it arrived and was
        // turned away. No signature, secret, or address is recorded.
        const refuse = (status, reason, extra = {}) => {
            ipnLog.record({
                outcome: 'refused',
                detail: `${status} ${reason}`,
                paymentId: extra.paymentId ?? null,
                orderId: extra.orderId ?? null,
                status: extra.status ?? null
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
        // payout body has no `payment_id` and no `order_id`, so it used to fail the field
        // checks below and be answered 400. The provider treats a 4xx as a failed delivery
        // and retries it on the dashboard's recurrent-notification schedule, so every
        // payout callback would have generated a stream of retries against this endpoint.
        const callbackKind = nowPayments.classifyIpnBody(ipn);
        if (callbackKind === 'payout') {
            // Payouts are not dispatched by this app, so there is no payout row to move.
            // Acknowledged rather than rejected: a signed callback about a payout this
            // build does not send is expected traffic, not an error worth retrying.
            ipnLog.record({ outcome: 'accepted', detail: 'Payout callback acknowledged; this build sends no payouts.' });
            return res.status(200).send('OK');
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
            return refuse(400, `Field check failed (order_id=${depositId || 'none'} status=${paymentStatus || 'none'}).`, { paymentId, orderId: depositId, status: paymentStatus });
        }

        // Several-payments-per-order: the provider can split one order across multiple
        // payments, reporting a child by echoing `parent_payment_id` while the parent gets
        // `parent_payment_id: null`. This app never enables that, so a child callback
        // carries a payment id that belongs to no deposit here. It is acknowledged as
        // understood rather than rejected, because a 400 is a failed delivery the provider
        // would keep retrying, and the deposit it belongs to is credited by the parent's
        // own `finished` callback regardless.
        if (ipn.parent_payment_id) {
            ipnLog.record({ outcome: 'accepted', detail: 'Child payment acknowledged; the parent callback settles the deposit.', paymentId, orderId: depositId, status: paymentStatus });
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
                return refuse(404, `No deposit ${depositId} for this provider. The IPN arrived for an order this app did not create.`, { paymentId, orderId: depositId, status: paymentStatus });
            }
            const deposit = depositResult.rows[0];

            // The row can still be waiting for the create-payment UPDATE when the first
            // callback lands: the payment exists at the provider the moment the API call
            // returns, and the IPN is not held back until our write commits. A null
            // provider_payment_id with an otherwise matching, signed callback is that race,
            // not a mismatch, so the id is adopted rather than the callback refused. A row
            // that already holds a *different* id is still refused, and the adopt is
            // conditional in SQL so a concurrent create-payment write cannot be clobbered.
            let adoptedPaymentId = false;
            if (deposit.provider_payment_id === null || deposit.provider_payment_id === undefined) {
                const adopted = await client.query(
                    `UPDATE deposits SET provider_payment_id = $1, updated_at = NOW()
                     WHERE id = $2 AND provider_payment_id IS NULL RETURNING id`,
                    [paymentId, deposit.id]
                );
                adoptedPaymentId = adopted.rows.length > 0;
            }

            if ((deposit.provider_payment_id !== null && deposit.provider_payment_id !== paymentId && !adoptedPaymentId) ||
                currencyCode !== 'USD' || !amountsMatch(callbackAmount, deposit.amount)) {
                await client.query('ROLLBACK');
                return refuse(400, 'Payment id, currency, or amount does not match the stored deposit.', { paymentId, orderId: depositId, status: paymentStatus });
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
            // is the payment, its status, and what was actually paid. That is stable across
            // a redelivery of the same notification and distinct for a genuinely new one.
            const eventId = [
                paymentId,
                paymentStatus,
                String(ipn.actually_paid ?? ''),
                String(ipn.actually_paid_at_fiat ?? '')
            ].join(':');
            const event = await client.query(
                `INSERT INTO payment_provider_events (provider, event_id)
                 VALUES ('nowpayments', $1) ON CONFLICT DO NOTHING RETURNING id`,
                [eventId]
            );
            if (event.rows.length === 0 || deposit.credited_at) {
                await client.query('COMMIT');
                ipnLog.record({ outcome: 'accepted', detail: 'Duplicate delivery; already processed.', paymentId, orderId: depositId, status: paymentStatus });
                return res.status(200).send('Already processed.');
            }

            const targetStatus = targetStatusFor(paymentStatus);
            if (targetStatus === 'confirmed') {
                // creditConfirmedDeposit is the only thing that writes 'confirmed', and
                // it also flips credited_at, so the status and the credit cannot diverge.
                await creditConfirmedDeposit(client, {
                    id: deposit.id,
                    ledger_source_id: `nowpayments:${paymentId}`
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
                status: paymentStatus
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
    },


    stripeWebhook: async (req, res) => {
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
        if (!creditingStripeEventTypes.has(event.type) && !expiringStripeEventTypes.has(event.type)) {
            return res.status(200).send('Ignored.');
        }

        // An abandoned checkout produced a deposit row that can never be paid, because
        // Stripe expires the session after 24 hours. Without handling the expiry the row
        // stays `pending` and the customer sees a deposit that will never arrive.
        const isExpiry = expiringStripeEventTypes.has(event.type);
        const session = event.data.object;
        const depositId = String(session.metadata?.deposit_id || '');
        if (!/^\d+$/.test(depositId)) return res.status(400).send('Deposit metadata is invalid.');
        if (!isExpiry && session.payment_status !== 'paid') return res.status(200).send('Payment not complete.');

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
            if (!deposit || deposit.provider_payment_id !== session.id ||
                session.currency !== 'usd' || Number(session.amount_total) !== Math.round(Number(deposit.amount) * 100)) {
                await client.query('ROLLBACK');
                return res.status(400).send('Payment details do not match the deposit.');
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
            } else {
                await creditConfirmedDeposit(client, {
                    id: deposit.id,
                    ledger_source_id: `stripe:${session.id}`
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
};

module.exports = paymentController;
module.exports.resetCryptoDepositOptionsCache = resetCryptoDepositOptionsCache;

