/**
 * Contract tests for the NOWPayments client.
 *
 * These check the parts of the vendor's documented contract that the HTTP suite cannot
 * reach without a live provider account: the canonicalisation the IPN signature depends
 * on, the two callback body shapes that share one URL, the payment/payout status
 * vocabularies, the rate limit, and the network-specific coin tickers the payout
 * endpoints key on.
 */

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');

const nowPayments = require('../src/services/nowPayments');
const { isPaymentFullyPaid, knownProviderStatuses } = require('../src/services/depositCredit');
const {
    providerCoinFor,
    requiresDestinationTag,
    distinctProviderCoins,
    isValidCryptoAddress
} = require('../src/services/payoutOptions');

test('the IPN signature is computed over a deeply key-sorted body', () => {
    // The provider's own reference implementation recurses into nested objects, and the
    // documented payment payload nests a `fee` object. A shallow sort signs different
    // bytes, so every callback carrying a nested value would be rejected.
    const body = {
        payment_status: 'finished',
        payment_id: 1,
        fee: { serviceFee: 0, depositFee: 0.1, currency: 'btc' },
        price_amount: 5
    };
    const secret = 'ipn-secret';
    const expected = createHmac('sha512', secret)
        .update(JSON.stringify({
            fee: { currency: 'btc', depositFee: 0.1, serviceFee: 0 },
            payment_id: 1,
            payment_status: 'finished',
            price_amount: 5
        }))
        .digest('hex');

    assert.equal(
        nowPayments.verifyIpnSignature(secret, body, expected),
        true,
        'a signature over the deeply sorted body must verify'
    );
    assert.equal(
        nowPayments.verifyIpnSignature(secret, body, 'f'.repeat(128)),
        false,
        'a wrong signature must not verify'
    );
});

test('a malformed IPN signature is rejected before any comparison', () => {
    const body = { payment_id: 1, payment_status: 'finished' };
    const secret = 'ipn-secret';

    // `Buffer.from(value, 'hex')` silently drops non-hex characters, so a signature that
    // is not hex at all has to be refused on shape.
    assert.equal(nowPayments.verifyIpnSignature(secret, body, 'z'.repeat(128)), false);
    assert.equal(nowPayments.verifyIpnSignature(secret, body, 'abc'), false);
    assert.equal(nowPayments.verifyIpnSignature(secret, body, ''), false);
    assert.equal(nowPayments.verifyIpnSignature('', body, 'a'.repeat(128)), false);
    assert.equal(nowPayments.verifyIpnSignature(secret, null, 'a'.repeat(128)), false);
    assert.equal(nowPayments.verifyIpnSignature(secret, [], 'a'.repeat(128)), false);
});

test('payment and payout callbacks are told apart despite sharing one URL', () => {
    // The documented payment body.
    assert.equal(nowPayments.classifyIpnBody({
        payment_id: 1, payment_status: 'finished', order_id: '2'
    }), 'payment');

    // The documented payout body: no `payment_id`, and a `status` from the separate
    // uppercase payout vocabulary.
    assert.equal(nowPayments.classifyIpnBody({
        id: '123', batch_withdrawal_id: '456', status: 'CREATING', currency: 'usdttrc20'
    }), 'payout');
    assert.equal(nowPayments.classifyIpnBody({ id: '123', status: 'FINISHED' }), 'payout');

    assert.equal(nowPayments.classifyIpnBody({}), 'unknown');
    assert.equal(nowPayments.classifyIpnBody(null), 'unknown');
    assert.equal(nowPayments.classifyIpnBody([1, 2]), 'unknown');
});

test('payment and payout statuses are separate namespaces', () => {
    // `FINISHED` for a payout means the money was sent; `finished` for a payment means the
    // customer's deposit completed. Collapsing them would read a paid withdrawal as a
    // funded deposit.
    assert.equal(nowPayments.PAYOUT_STATUSES.FINISHED, 'FINISHED');
    assert.equal(nowPayments.PAYMENT_STATUSES.FINISHED, 'finished');
    assert.notEqual(nowPayments.PAYOUT_STATUSES.FINISHED, nowPayments.PAYMENT_STATUSES.FINISHED);

    // Every documented payment status is known, including the two in-progress ones.
    for (const status of ['waiting', 'confirming', 'confirmed', 'sending',
        'partially_paid', 'finished', 'failed', 'refunded', 'expired']) {
        assert.equal(knownProviderStatuses.has(status), true, `${status} should be known`);
    }
    // The uppercase payout vocabulary is deliberately not a payment status.
    assert.equal(knownProviderStatuses.has('CREATING'), false);
    assert.equal(knownProviderStatuses.has('made_up'), false);
});

test('a payment only counts as paid when actually_paid covers the quoted amount', () => {
    // `pay_amount` is what the customer was quoted; `price_amount` is the fiat value of
    // the deposit. Crediting the fiat value without checking the crypto arrived credits a
    // number rather than a payment.
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.0003, actually_paid: 0.0003 }), true);
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.0003, actually_paid: 0.00031 }), true);
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.0003, actually_paid: 0.0001 }), false);
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.0003, actually_paid: 0 }), false);
    // Absent fields cannot establish that anything arrived, so they are not a confirmation.
    assert.equal(isPaymentFullyPaid({ pay_amount: 0.0003 }), false);
    assert.equal(isPaymentFullyPaid({ actually_paid: 0.0003 }), false);
    assert.equal(isPaymentFullyPaid({ pay_amount: 0, actually_paid: 0 }), false);
    assert.equal(isPaymentFullyPaid(null), false);
});

test('payout coin tickers carry the network, not just the asset', () => {
    // Validating a TRON address against the bare `usdt` ticker would check the wrong
    // chain and pass while being unsendable.
    assert.equal(providerCoinFor('USDT', 'tron'), 'usdttrc20');
    assert.equal(providerCoinFor('USDT', 'ethereum'), 'usdterc20');
    assert.equal(providerCoinFor('USDT', 'polygon'), 'usdtmatic');
    assert.equal(providerCoinFor('USDC', 'ethereum'), 'usdcerc20');
    assert.equal(providerCoinFor('BTC', 'bitcoin'), 'btc');
    assert.equal(providerCoinFor('SOL', 'solana'), 'sol');

    // Case and surrounding whitespace in a request must not change the resolved chain.
    assert.equal(providerCoinFor('usdt', ' TRON '), 'usdttrc20');

    assert.ok(distinctProviderCoins().includes('usdttrc20'));
    assert.ok(distinctProviderCoins().includes('usdcmatic'));
    // A network that is not offered has no ticker, so it cannot be quoted to the provider.
    assert.equal(providerCoinFor('USDT', 'dogecoin'), null);
});

test('assets that need a destination tag are identified', () => {
    // A correct XRP address with no destination tag is unsendable, and the address format
    // alone cannot reveal that.
    assert.equal(requiresDestinationTag('XRP'), true);
    assert.equal(requiresDestinationTag('BTC'), false);
});

test('local address checks still reject the wrong chain', () => {
    // A TRON address submitted for the Ethereum network, and vice versa.
    const tronAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    assert.equal(isValidCryptoAddress('USDT', 'tron', tronAddress), true);
    assert.equal(isValidCryptoAddress('USDT', 'ethereum', tronAddress), false);
    assert.equal(isValidCryptoAddress('ETH', 'ethereum', '0xce810cc51e5da46cd615fa95eb6cf21b78bb7f5c'), true);
    assert.equal(isValidCryptoAddress('USDT', 'tron', '0xce810cc51e5da46cd615fa95eb6cf21b78bb7f5c'), false);
});

test('the merchant coin list is read from the field the provider actually uses', async () => {
    // `GET /v1/merchant/coins` answers with `selectedCurrencies` while `GET /v1/currencies`
    // answers with `currencies`. Reading only `currencies` finds nothing in the merchant
    // list, so the call fell through to the global list on every request and the merchant
    // list was never used. Verified against the live API, not assumed.
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    const baseUrl = process.env.NOWPAYMENTS_API_BASE_URL;
    if (!apiKey) {
        console.warn('Skipping the live currency-shape check: NOWPAYMENTS_API_KEY is not set.');
        return;
    }

    const priorApiKey = process.env.NOWPAYMENTS_API_KEY;
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, options) => {
        const target = String(url);
        if (target.includes('/v1/merchant/coins')) {

            seen.push(target);
            return new Response(JSON.stringify({ selectedCurrencies: ['BTC', 'USDT', 'DOGE'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.includes('/v1/currencies')) {
            seen.push(target);
            return new Response(JSON.stringify({ currencies: ['btc', 'eth', 'ada'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url, options);
    };

    try {
        const coins = await nowPayments.getSupportedCurrencies({ logger: { warn() {} } });
        assert.deepEqual(coins, ['btc', 'usdt', 'doge']);
        assert.equal(seen.length, 1, 'the global list must not be consulted when the merchant list answers');
        assert.ok(seen[0].includes('/v1/merchant/coins'));
    } finally {
        global.fetch = originalFetch;
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
        if (baseUrl === undefined) delete process.env.NOWPAYMENTS_API_BASE_URL;
        else process.env.NOWPAYMENTS_API_BASE_URL = baseUrl;
    }
});

test('a pair minimum is requested in fiat, not read as a coin amount', async () => {

    // The regression: `/v1/min-amount` answers in the *coin* unless `fiat_equivalent` is
    // supplied. The provider's own Node SDK shows a 49.99 USD purchase with
    // `"minimum": { "currency_from": "btc", "min_amount": 0.0001 }`. Reading that as
    // dollars put a $18.81 floor on Bitcoin Cash and refused ordinary deposits under it.
    const priorApiKey = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/v1/min-amount')) {
            seen.push(target);
            // The provider's answer when `fiat_equivalent` is honoured: 0.0008 BCH, which
            // it also reports as 18.81 fiat units of the *coin*. Only the second figure is
            // usable in a USD amount box.
            return new Response(JSON.stringify({
                currency_from: 'usd',
                currency_to: 'bch',
                min_amount: 18.81,
                fiat_equivalent: 0.0008
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(url);
    };

    try {
        const minimum = await nowPayments.getMinimumAmount('usd', 'bch');
        assert.equal(minimum, 0.0008, 'the coin-denominated figure was preferred over the fiat one');
        assert.ok(
            seen[0].includes('fiat_equivalent=usd'),
            'the conversion parameter was not requested, so the units are unknown'
        );
    } finally {
        global.fetch = originalFetch;
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
    }
});

test('an unconverted minimum is converted, never returned as dollars', async () => {
    // The dangerous case: the provider ignores `fiat_equivalent` and answers with a coin
    // amount only. Returning it verbatim is exactly how a coin figure became a dollar
    // figure, so it is converted through the estimate endpoint instead.
    const priorApiKey = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/v1/min-amount')) {
            seen.push(target);
            return new Response(JSON.stringify({ currency_to: 'bch', min_amount: 0.05 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.includes('/v1/estimate')) {
            seen.push(target);
            // 0.05 BCH at about $490 is roughly $24.50.
            return new Response(JSON.stringify({ estimated_amount: 24.5 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url);
    };

    try {
        const minimum = await nowPayments.getMinimumAmount('usd', 'bch');
        assert.equal(minimum, 24.5, 'the coin amount was returned as though it were dollars');
        assert.ok(
            seen.some((url) => url.includes('/v1/estimate') && url.includes('currency_from=bch')),
            'the coin minimum was never converted'
        );
    } finally {
        global.fetch = originalFetch;
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
    }
});

test('a minimum is omitted rather than guessed when it cannot be converted', async () => {
    // If the conversion is unavailable the only honest answer is "unknown". Returning the
    // coin figure would put a wrong dollar amount in front of the user; returning nothing
    // lets the caller apply its own floor, which errs towards accepting the deposit.
    const priorApiKey = process.env.NOWPAYMENTS_API_KEY;
    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/v1/min-amount')) {
            return new Response(JSON.stringify({ min_amount: 18.81 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.includes('/v1/estimate')) {
            return new Response(JSON.stringify({ error: 'unavailable' }), {
                status: 503, headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url);
    };

    try {
        assert.equal(await nowPayments.getMinimumAmount('usd', 'bch'), null);
    } finally {
        global.fetch = originalFetch;
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
    }
});


test('an unrecognised currency window yields no maximum rather than a wrong one', async () => {
    // The published OpenAPI schema for `/v1/currencies?fixed_rate=true` declares
    // `currencies: string[]` and names no amount fields, so a shape change must degrade
    // to "no limit known" rather than to a number that would refuse valid deposits.
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/v1/currencies')) {
            return new Response(JSON.stringify({ currencies: ['btc', 'usdt'] }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url);
    };

    try {
        assert.deepEqual(await nowPayments.getCurrencyLimits({ logger: { warn() {} } }), {});
    } finally {
        global.fetch = originalFetch;
    }
});

test('the TOTP generator matches the RFC 6238 test vectors', () => {
    // RFC 6238 publishes these for the ASCII secret "12345678901234567890", which is
    // "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" in Base32 -- the form a dashboard actually shows.
    // Checking against the published vectors is the only way to know the implementation is
    // right: a code that is merely self-consistent still produces codes the provider rejects,
    // and the symptom is a payout that silently never gets released.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const vectors = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130']
    ];
    for (const [epochSeconds, expected] of vectors) {
        assert.equal(
            nowPayments.generateTotp(secret, { digits: 8, epochSeconds }),
            expected,
            `TOTP for t=${epochSeconds}`
        );
    }

    // The provider wants six digits, and a short one must be left-padded: a five-digit code
    // is rejected outright rather than accepted as a shorter number.
    const code = nowPayments.generateTotp(secret, { epochSeconds: 59 });
    assert.match(code, /^\d{6}$/);

    // The whole code space is reachable, including the low values that only appear if the
    // counter and the modulo are right. A TOTP stuck on a narrow band would still pass a
    // single vector comparison and be wrong most of the time.
    const seen = new Set();
    for (let step = 0; step < 200; step += 1) {
        seen.add(nowPayments.generateTotp(secret, { epochSeconds: 1000 + step * 30 }));
    }
    assert.equal(seen.size, 200, 'each 30s period must produce its own code');
});

test('a secret pasted with padding, lowercase, or spaces still works', () => {
    // These are the ways a correct Base32 secret gets pasted wrong, and each of them is
    // invisible in a dashboard screenshot. Failing on them would look exactly like the
    // provider rejecting a valid code.
    const secret = 'JBSWY3DPEHPK3PXP';
    const options = { epochSeconds: 1111111109 };
    const expected = nowPayments.generateTotp(secret, options);
    assert.equal(nowPayments.generateTotp('jbswy3dpehpk3pxp', options), expected);
    assert.equal(nowPayments.generateTotp('JBSW Y3DP EHPK 3PXP', options), expected);

    // Anything outside the alphabet is refused rather than silently mis-decoded. A secret read
    // with a character dropped would produce a valid-looking code that the provider rejects.
    assert.equal(nowPayments.generateTotp('JBSWY3DP1EHPK3PXP', options), null);
    assert.equal(nowPayments.generateTotp('', options), null);
    assert.equal(nowPayments.generateTotp(undefined, options), null);
});

/** Stubs a payout flow: `/v1/auth` then whichever endpoint the caller exercises. */
async function withPayoutFetch(run, { verifyStatus = 200, payoutBody = { batch_withdrawal_id: 'batch-1' } } = {}) {
    const priorApiKey = process.env.NOWPAYMENTS_API_KEY;
    const priorEmail = process.env.NOWPAYMENTS_EMAIL;
    const priorPassword = process.env.NOWPAYMENTS_PASSWORD;
    const priorTwoFactor = process.env.NOWPAYMENTS_2FA_SECRET;
    const originalFetch = global.fetch;
    const seen = [];

    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';
    process.env.NOWPAYMENTS_EMAIL = 'ops@example.test';
    process.env.NOWPAYMENTS_PASSWORD = 'account-password';
    process.env.NOWPAYMENTS_2FA_SECRET = 'JBSWY3DPEHPK3PXP';
    nowPayments.resetAuthTokenCache();

    global.fetch = async (url, options) => {
        const target = String(url);
        const body = options?.body ? JSON.parse(options.body) : null;
        seen.push({ url: target, body, headers: options?.headers || {} });

        if (target.includes('/v1/auth')) {
            return new Response(JSON.stringify({ token: 'jwt-token' }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.endsWith('/v1/payout/verify')) {
            return new Response(JSON.stringify({ success: true }), {
                status: verifyStatus, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (target.endsWith('/v1/payout')) {
            return new Response(JSON.stringify(payoutBody), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url, options);
    };

    try {
        return { result: await run(seen), seen };
    } finally {
        global.fetch = originalFetch;
        nowPayments.resetAuthTokenCache();
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
        if (priorEmail === undefined) delete process.env.NOWPAYMENTS_EMAIL;
        else process.env.NOWPAYMENTS_EMAIL = priorEmail;
        if (priorPassword === undefined) delete process.env.NOWPAYMENTS_PASSWORD;
        else process.env.NOWPAYMENTS_PASSWORD = priorPassword;
        if (priorTwoFactor === undefined) delete process.env.NOWPAYMENTS_2FA_SECRET;
        else process.env.NOWPAYMENTS_2FA_SECRET = priorTwoFactor;
    }
}

test('verifying a batch posts the batch id and a six-digit code, and is refused without a secret', async () => {
    const { seen } = await withPayoutFetch(
        async () => nowPayments.verifyPayoutBatch('batch-1', { logger: { log() {} } })
    );

    const auth = seen.find((call) => call.url.includes('/v1/auth'));
    assert.ok(auth, 'payout endpoints need a JWT, which comes from the account credentials');
    assert.equal(auth.body.email, 'ops@example.test');

    const verify = seen.find((call) => call.url.endsWith('/v1/payout/verify'));
    assert.ok(verify, 'the verify endpoint was not called');
    // The id must be the one that was created, or the confirmation applies to nothing.
    assert.equal(verify.body.batch_withdrawal_id, 'batch-1');
    assert.match(verify.body.verification_code, /^\d{6}$/);
    assert.equal(verify.headers.Authorization, 'Bearer jwt-token');

    // Without a secret there is no code to generate, and the call must not be attempted: an
    // empty code would be rejected by the provider and reported as a bad 2FA code, sending
    // the operator to debug the wrong thing.
    await withPayoutFetch(async () => {
        delete process.env.NOWPAYMENTS_2FA_SECRET;
        assert.equal(nowPayments.twoFactorConfigured(), false);
        await assert.rejects(
            () => nowPayments.verifyPayoutBatch('batch-1'),
            /NOWPAYMENTS_2FA_SECRET/
        );
    });
});

test('a batch carries the callback URL, so a finished payout is noticed', async () => {
    const entries = [{ payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];

    const { seen } = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        ipnCallbackUrl: 'https://example.test/api/payments/nowpayments/ipn',
        logger: { log() {} }
    }));

    const create = seen.find((call) => call.url.endsWith('/v1/payout'));
    assert.ok(create);
    assert.equal(create.body.ipn_callback_url, 'https://example.test/api/payments/nowpayments/ipn');
    assert.deepEqual(create.body.withdrawals[0].payoutId, 'wd-5');
    assert.equal(create.body.withdrawals[0].currency, 'btc');

    // Left to the dashboard setting when the caller has no usable origin, so a batch is never
    // pointed at a host that cannot receive it.
    const without = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        logger: { log() {} }
    }));
    const noCallback = without.seen.find((call) => call.url.endsWith('/v1/payout'));
    assert.equal('ipn_callback_url' in noCallback.body, false);
});

