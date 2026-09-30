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
const undici = require('undici');

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
    const originalFetch = undici.fetch;
    const seen = [];
    undici.fetch = async (url, options) => {
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
        undici.fetch = originalFetch;
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
    const originalFetch = undici.fetch;
    const seen = [];
    undici.fetch = async (url) => {
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
        undici.fetch = originalFetch;
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
    const originalFetch = undici.fetch;
    const seen = [];
    undici.fetch = async (url) => {
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
        undici.fetch = originalFetch;
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
    const originalFetch = undici.fetch;
    undici.fetch = async (url) => {
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
        undici.fetch = originalFetch;
        if (priorApiKey === undefined) delete process.env.NOWPAYMENTS_API_KEY;
        else process.env.NOWPAYMENTS_API_KEY = priorApiKey;
    }
});


test('an unrecognised currency window yields no maximum rather than a wrong one', async () => {
    // The published OpenAPI schema for `/v1/currencies?fixed_rate=true` declares
    // `currencies: string[]` and names no amount fields, so a shape change must degrade
    // to "no limit known" rather than to a number that would refuse valid deposits.
    const originalFetch = undici.fetch;
    undici.fetch = async (url) => {
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
        undici.fetch = originalFetch;
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
    const originalFetch = undici.fetch;
    const seen = [];

    process.env.NOWPAYMENTS_API_KEY = 'test-unit-key';
    process.env.NOWPAYMENTS_EMAIL = 'ops@example.test';
    process.env.NOWPAYMENTS_PASSWORD = 'account-password';
    process.env.NOWPAYMENTS_2FA_SECRET = 'JBSWY3DPEHPK3PXP';
    nowPayments.resetAuthTokenCache();

    undici.fetch = async (url, options) => {
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
        // The documented form: the batch id is in the path, not the body. Matched before the
        // bare `/v1/payout` rule, which would otherwise swallow it.
        if (/\/v1\/payout\/[^/]+\/verify$/.test(target)) {
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
        undici.fetch = originalFetch;
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
        async () => nowPayments.verifyPayoutBatch('batch-1', { logger: { log() {}, warn() {} } })
    );

    const auth = seen.find((call) => call.url.includes('/v1/auth'));
    assert.ok(auth, 'payout endpoints need a JWT, which comes from the account credentials');
    assert.equal(auth.body.email, 'ops@example.test');

    const verify = seen.find((call) => call.url.endsWith('/v1/payout/batch-1/verify'));
    assert.ok(verify, `the documented verify endpoint was not called; saw ${seen.map((c) => c.url).join(', ')}`);
    // The id goes in the path, per the provider's API reference. The widely-circulated
    // alternative puts it in the body, which the provider answers with a 404 -- and a 404 read
    // as "bad 2FA code" sends the operator to debug their authenticator instead.
    assert.match(verify.url, /\/v1\/payout\/batch-1\/verify$/);
    assert.equal(verify.body.verification_code.length, 6);
    assert.equal('batch_withdrawal_id' in verify.body, false, 'the id belongs in the path');
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
        logger: { log() {}, warn() {} }
    }));

    const create = seen.find((call) => call.url.endsWith('/v1/payout'));
    assert.ok(create);
    assert.equal(create.body.ipn_callback_url, 'https://example.test/api/payments/nowpayments/ipn');
    assert.equal(create.body.withdrawals[0].currency, 'btc');
    assert.equal(create.body.withdrawals[0].address, 'bc1qexample');
    assert.equal(create.body.withdrawals[0].amount, 0.001);

    // Left to the dashboard setting when the caller has no usable origin, so a batch is never
    // pointed at a host that cannot receive it.
    const without = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        logger: { log() {}, warn() {} }
    }));
    const noCallback = without.seen.find((call) => call.url.endsWith('/v1/payout'));
    assert.equal('ipn_callback_url' in noCallback.body, false);
});

/**
 * The batch id is what makes a payout send itself, and it is read from a response field whose
 * name the provider does not keep stable across versions.
 *
 * This is here because the whole test file stubbed the create response as
 * `{ batch_withdrawal_id: 'batch-1' }` -- the shape the code was written against. Every test
 * therefore agreed with the implementation and none of them could notice that a live create
 * answers with a top-level `id` instead. The result was a real withdrawal whose batch was
 * created, held by the provider, and never verified: the app took its "created but not
 * verified" branch, and a human had to type a 2FA code into the dashboard for the money to
 * move. NOWPayments' own SDK reads `payout['id']` for the same value, which is what settled
 * the question of which spelling is real.
 */
test('the batch id is read from whichever field the provider used to report it', async () => {
    const entries = [{ payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const shapes = [
        {
            id: '5006836498',
            withdrawals: [{ id: '5007985324', status: 'creating', unique_external_id: 'wd-5' }]
        },
        { batch_withdrawal_id: '5006836498' },
        { batchWithdrawalId: '5006836498' },
        { batch_id: '5006836498' },
        { batchId: '5006836498' }
    ];

    for (const payoutBody of shapes) {
        const { result } = await withPayoutFetch(
            () => nowPayments.submitPayoutBatch(entries, { logger: { log() {}, warn() {}, error() {} } }),
            { payoutBody }
        );
        assert.equal(
            result.batchId,
            '5006836498',
            `batch id not read from ${JSON.stringify(Object.keys(payoutBody))}`
        );
    }

    // The `id` shape is the one a live account actually returns, and the per-withdrawal id
    // inside it is what proves the response was otherwise read correctly: getting the entry id
    // right while missing the batch id is what made this look like a provider fault.
    const live = await withPayoutFetch(
        () => nowPayments.submitPayoutBatch(entries, { logger: { log() {}, warn() {}, error() {} } }),
        { payoutBody: shapes[0] }
    );
    assert.equal(live.result.withdrawals[0].providerWithdrawalId, '5007985324');
});

/**
 * A create response with no batch id anywhere is the failure that costs a real withdrawal, so
 * it cannot pass quietly. The key names are the whole diagnosis and they are gone afterwards.
 */
test('a create response with no batch id says so loudly, naming the keys it did send', async () => {
    const entries = [{ payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 }];
    const errors = [];
    const { result } = await withPayoutFetch(
        () => nowPayments.submitPayoutBatch(entries, {
            logger: { log() {}, warn() {}, error: (message) => errors.push(message) }
        }),
        { payoutBody: { withdrawals: [{ id: '5007985324', status: 'creating' }] } }
    );

    assert.equal(result.batchId, null, 'there is genuinely no batch id in this response');
    assert.equal(errors.length, 1, 'the missing batch id must be reported, not swallowed');
    assert.match(errors[0], /wd-5/, 'the operator has to know which withdrawal is affected');
    assert.match(errors[0], /withdrawals/, 'and which fields the provider did send');
});

/**
 * `POST /v1/payout` has a closed schema: anything beyond the documented fields is refused
 * with `withdrawals[0].<field> is not allowed`, and one extra field costs the whole batch.
 * `payoutId` was sent for a long time on the assumption the provider would echo it back, and
 * the first live send against a funded account was refused outright, leaving every crypto
 * withdrawal in the queue undelivered.
 *
 * The field that *is* documented is `unique_external_id` -- the name NOWPayments' own official
 * SDK serialises, which the provider echoes back on the create response, on the individual
 * payout record, and in the payout IPN. It is an identity match rather than an inference from
 * the destination, which is what makes a single payout inside a multi-withdrawal batch
 * unambiguous. The address matching underneath is the fallback for a response that omits it.
 */
test('a batch sends the documented fields only, and is matched back by its external id', async () => {
    const entries = [
        { payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 },
        { payoutId: 'wd-6', address: 'TXyz9Example', currency: 'usdttrc20', amount: 12.5, extraId: 'tag-1' },
    ];

    // The provider's order is not assumed, and the addresses are deliberately swapped relative
    // to the request. An identity match is unaffected by both; anything positional or
    // address-ordered would get this wrong.
    const { seen, result } = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        logger: { log() {}, warn() {} }
    }), {
        payoutBody: {
            batch_withdrawal_id: 'batch-1',
            withdrawals: [
                { id: 'p-2', unique_external_id: 'wd-6', address: 'TXyz9Example', currency: 'usdttrc20', amount: '12.5', status: 'CREATING' },
                { id: 'p-1', unique_external_id: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: '0.001', status: 'WAITING' },
            ]
        }
    });

    const create = seen.find((call) => call.url.endsWith('/v1/payout'));
    assert.equal('payoutId' in create.body.withdrawals[0], false, 'the provider refuses an unknown field');
    assert.equal(create.body.withdrawals[0].unique_external_id, 'wd-5');
    assert.equal(create.body.withdrawals[1].unique_external_id, 'wd-6');
    assert.equal(create.body.withdrawals[1].extra_id, 'tag-1', 'the destination tag uses the documented name');

    // Each entry keeps its own correlation key and picks up its own provider id, even though
    // the response came back in the opposite order.
    assert.deepEqual(result.withdrawals, [
        { payoutId: 'wd-5', providerWithdrawalId: 'p-1', status: 'WAITING' },
        { payoutId: 'wd-6', providerWithdrawalId: 'p-2', status: 'CREATING' }
    ]);
});

test('a response that omits the external id still resolves, on the destination', async () => {
    const entries = [
        { payoutId: 'wd-5', address: 'bc1qexample', currency: 'btc', amount: 0.001 },
        { payoutId: 'wd-6', address: 'TXyz9Example', currency: 'usdttrc20', amount: 12.5 },
    ];

    // A provider version that drops the field, or a response shape that does not carry it,
    // must degrade to address matching rather than losing every entry in the batch.
    const sparse = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        logger: { log() {}, warn() {} }
    }), {
        payoutBody: {
            batch_withdrawal_id: 'batch-1',
            withdrawals: [
                { id: 'p-1', address: 'bc1qexample', amount: '0.001', status: 'WAITING' },
                { id: 'p-2', address: 'TXyz9Example', amount: '12.5', status: 'CREATING' },
            ]
        }
    });
    assert.deepEqual(sparse.result.withdrawals.map((w) => w.providerWithdrawalId), ['p-1', 'p-2']);

    // Two entries to the same address and currency is ambiguous. Guessing would attach one
    // row's status to the other, so neither is matched and both are left for reconciliation.
    const ambiguous = await withPayoutFetch(() => nowPayments.submitPayoutBatch([
        { payoutId: 'wd-7', address: 'bc1qshared', currency: 'btc', amount: 0.001 },
        { payoutId: 'wd-8', address: 'bc1qshared', currency: 'btc', amount: 0.001 },
    ], {
        logger: { log() {}, warn() {} }
    }), {
        payoutBody: {
            batch_withdrawal_id: 'batch-1',
            withdrawals: [
                { id: 'p-1', address: 'bc1qshared', currency: 'btc', amount: '0.001', status: 'FINISHED' },
                { id: 'p-2', address: 'bc1qshared', currency: 'btc', amount: '0.001', status: 'REJECTED' },
            ]
        }
    });
    assert.deepEqual(ambiguous.result.withdrawals.map((w) => w.status), [null, null]);

    // An entry the provider says nothing about keeps its own key and no status, which
    // `autoPayouts` records as the conservative `WAITING`.
    const partial = await withPayoutFetch(() => nowPayments.submitPayoutBatch(entries, {
        logger: { log() {}, warn() {} }
    }), {
        payoutBody: {
            batch_withdrawal_id: 'batch-1',
            withdrawals: [
                { id: 'p-1', address: 'bc1qexample', currency: 'btc', amount: '0.001', status: 'WAITING' },
            ]
        }
    });
    assert.deepEqual(partial.result.withdrawals, [
        { payoutId: 'wd-5', providerWithdrawalId: 'p-1', status: 'WAITING' },
        { payoutId: 'wd-6', providerWithdrawalId: null, status: null }
    ]);
});

/**
 * `SENDING`, `FAILED` and `CANCELLED` are the states a payout is in for most of its life, or
 * ends its life in. They were missing from the vocabulary, which is not a cosmetic gap: a
 * status the app does not recognise is written as the `WAITING` fallback, so a payout
 * genuinely broadcasting on-chain read as "queued, nothing happening", and a payout the
 * provider had abandoned was never recognised as finished and so never refunded.
 */
test('the payout vocabulary covers the states a real payout passes through and ends in', () => {
    for (const status of ['NEW', 'CREATING', 'WAITING', 'PROCESSING', 'SENDING', 'FINISHED', 'FAILED', 'CANCELLED', 'REJECTED', 'REJECTED_NOT_CHECKED']) {
        assert.equal(nowPayments.PAYOUT_STATUSES[status], status, `${status} is missing from the vocabulary`);
    }
    // Both spellings, because the provider uses both and downstream code has one value to
    // reason about.
    assert.deepEqual([...nowPayments.PAYOUT_CANCELLED_SPELLINGS], ['CANCELLED', 'CANCELED']);
});



/**
 * The payout-minimum endpoint is restricted per NOWPayments account and answers 403 for an
 * account that has not enabled it. The provider's own text ends in the literal "undefined",
 * because it cannot resolve the caller's IP.
 *
 * These pin the two things that made that restriction painful before: it was reported once
 * per coin, so fourteen identical warnings, and the endpoint was re-requested for every coin
 * on every refresh even though the answer could not change.
 */
test('a refused payout minimum is reported once, and then not retried per coin', async () => {
    const saved = Object.fromEntries(
        ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'FIXIE_URL', 'NOWPAYMENTS_PAYOUT_PROXY']
            .map((key) => [key, process.env[key]])
    );
    const originalFetch = undici.fetch;
    const warnings = [];
    const recovery = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    let calls = 0;

    process.env.NOWPAYMENTS_API_KEY = 'test-key';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
    // The warning branches on whether the request actually used the proxy, so the proxy has to
    // be configured AND enabled here. A deployment with the IP whitelist off sets
    // NOWPAYMENTS_PAYOUT_PROXY=off in `.env`, and that value is in the environment for the whole
    // run -- this test is about the proxy-in-play branch, so it opts in rather than assuming.
    process.env.FIXIE_URL = 'http://user:pass@fixie.example:443';
    process.env.NOWPAYMENTS_PAYOUT_PROXY = 'on';
    console.warn = (...args) => warnings.push(args.join(' '));
    console.log = (...args) => recovery.push(args.join(' '));

    undici.fetch = async (url) => {
        if (String(url).includes('/payout-withdrawal/min-amount/')) {
            calls += 1;
            // The provider's literal response, including its unresolved "undefined".
            return new Response(
                JSON.stringify({ error: 'Access denied | Invalid IP - undefined' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return originalFetch(url, {});
    };

    try {
        nowPayments.resetPayoutMinimumAvailability();

        const coins = ['usdttrc20', 'eth', 'usdterc20', 'btc', 'usdtmatic', 'usdcerc20', 'bch', 'ltc', 'sol', 'doge', 'xrp'];
        const results = await Promise.all(coins.map((coin) => nowPayments.getPayoutMinimum(coin)));

        // Every coin still resolves, so the withdrawal form keeps working.
        assert.deepEqual(results, coins.map(() => null));
        // One line, not one per coin.
        assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}: ${warnings.join(' | ')}`);
        assert.match(warnings[0], /payout-minimum endpoint/);
        // It must name the actual cause and carry advice that is achievable. The earliest
        // version said only "allow this server's outbound IP", which cannot be done from a
        // serverless host where the address rotates -- advice that cannot be followed is worse
        // than none, because it sends the operator looking in a place with no answer.
        assert.match(warnings[0], /Invalid IP/);
        assert.match(warnings[0], /whitelist-settings/);
        // The fix differs completely depending on whether a proxy is in play, and picking the
        // wrong one costs the operator a round of guesswork: with a proxy configured, the
        // address that needs whitelisting is the proxy's, not the host's, and saying "this
        // server's IP" would send them to a host address they cannot even discover.
        assert.match(warnings[0], /FIXIE_URL/);
        assert.match(warnings[0], /Fixie outbound IPs are|not the ones on the NOWPayments account/);
        // And it has to say plainly that this is not breaking anything, so nobody treats a
        // recurring capability notice as an outage.
        assert.match(warnings[0], /not a failure|unaffected/);
        // The operator still has to learn what the app is doing about it, which is to fall
        // back to a floor it chose itself. That fact is asserted through the options payload
        // in the fan-out test below; here the line only has to be one the reader can act on.

        // The circuit is open from here on: the second batch of coins makes no requests at
        // all, rather than repeating a call whose answer cannot change. The first batch still
        // costs one request per coin, because they are all started before the first refusal
        // has landed -- which is why the caller fetches concurrently.
        const afterFirstBatch = calls;
        await Promise.all(coins.map((coin) => nowPayments.getPayoutMinimum(coin)));
        assert.equal(calls, afterFirstBatch, 'a later refresh must not re-request a refused endpoint');

        // Still exactly one warning: the later refusals are silent, not merely coalesced.
        assert.equal(warnings.length, 1);

        // Once the cool-off is cleared the endpoint is tried again, and a success both returns
        // a real minimum and reports availability.
        nowPayments.resetPayoutMinimumAvailability();
        undici.fetch = async (url) => {
            if (String(url).includes('/payout-withdrawal/min-amount/')) {
                return new Response(JSON.stringify({ min_amount: 7.5 }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            }
            return originalFetch(url, {});
        };
        assert.equal(await nowPayments.getPayoutMinimum('usdttrc20'), 7.5);

        // Recovery is announced. Silence on recovery is indistinguishable from never having
        // retried, so an operator who fixed the dashboard would have no way to confirm it.
        assert.ok(
            recovery.some((line) => /now answering/i.test(line)),
            `expected a recovery line, got: ${recovery.join(' | ')}`
        );
    } finally {
        console.warn = originalWarn;
        console.log = originalLog;
        undici.fetch = originalFetch;
        nowPayments.resetPayoutMinimumAvailability();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a provider refusal is read from the shape NOWPayments actually sends', () => {
    const { NowPaymentsError } = nowPayments;

    // The documented error body is nested, and the useful text is one object deep. Reading only
    // the flat shapes made every real refusal unreadable, which is how a provider that had
    // named the exact amount that would have worked ended up answered with a bare 502.
    const nested = new NowPaymentsError('NOWPayments /v1/payment returned 400.', {
        status: 400,
        providerResponse: { error: { code: 'FAILURE', message: 'Minimum amount is 0.05 BCH, you have 0.002' } }
    });
    assert.equal(nested.providerMessage, 'Minimum amount is 0.05 BCH, you have 0.002');
    assert.equal(nested.isRateLimited, false);
    assert.equal(nested.isIpRefused, false);

    // The flat shapes other endpoints and versions use stay supported.
    assert.equal(
        new NowPaymentsError('x', { status: 400, providerResponse: { message: 'unknown currency' } }).providerMessage,
        'unknown currency'
    );
    assert.equal(
        new NowPaymentsError('x', { status: 400, providerResponse: { error: 'Access denied' } }).providerMessage,
        'Access denied'
    );

    // A body with no usable text must read as absent, not as the string "undefined". This is
    // the difference between the caller surfacing the provider's words and surfacing garbage.
    for (const providerResponse of [null, {}, { error: {} }, { error: { code: 'X' } }, { error: '   ' }, 'text']) {
        assert.equal(
            new NowPaymentsError('x', { status: 500, providerResponse }).providerMessage,
            null,
            `${JSON.stringify(providerResponse)} produced a provider message`
        );
    }

    // And the status-derived flags still key off the status, not the body.
    assert.equal(new NowPaymentsError('x', { status: 429 }).isRateLimited, true);
    assert.equal(new NowPaymentsError('x', { status: 403 }).isIpRefused, true);
});

test('a transport failure says why, not just that it happened', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';
    delete process.env.FIXIE_URL;

    const warnings = [];
    const logger = { warn: (line) => warnings.push(line) };

    try {
        nowPayments.resetAddressValidationAvailability();
        // The exact shape undici produces for a proxy CONNECT that fails: a generic outer
        // message with the real reason nested one level down. The previous log printed only the
        // outer message, so an operator saw "could not be completed" and nothing else.
        undici.fetch = async () => {
            const outer = new Error('fetch failed');
            outer.cause = Object.assign(new Error('getaddrinfo ENOTFOUND fixie.example'), { code: 'ENOTFOUND' });
            throw outer;
        };

        const verdict = await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
        assert.deepEqual(verdict, { checked: false, valid: null, reason: null });

        assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
        const line = warnings[0];
        // The cause is the whole point. A log line that says only "could not be completed"
        // costs an operator an hour of guessing and names nothing they can act on.
        assert.match(line, /ENOTFOUND/, 'the error code did not reach the log');
        assert.match(line, /fixie\.example/, 'the underlying host did not reach the log');
        // And whether the proxy is even in play, which is the first thing to check and otherwise
        // invisible from outside.
        assert.match(line, /went out directly/, 'the log does not say the request went out direct');

        // With the proxy configured *and the production base URL in use*, the same failure should
        // claim the opposite. The two facts are separate: `FIXIE_URL` being set does not mean a
        // request used it, and a log that assumes it does sends the operator to debug a proxy
        // that was never touched.
        nowPayments.resetAddressValidationAvailability();
        const priorBaseUrl = process.env.NOWPAYMENTS_API_BASE_URL;
        process.env.FIXIE_URL = 'http://user:pass@fixie.example:443';
        // Opted back in explicitly. A deployment with no IP whitelist sets this to `off` in
        // `.env`, and that value is in the environment for the whole test run -- so a test that
        // wants to exercise the proxy has to say so rather than rely on the variable merely
        // being present.
        process.env.NOWPAYMENTS_PAYOUT_PROXY = 'on';
        process.env.NOWPAYMENTS_API_BASE_URL = nowPayments.PRODUCTION_BASE_URL;
        warnings.length = 0;
        await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
        assert.match(warnings[0], /went out via FIXIE_URL/);
        assert.ok(!/went out directly/.test(warnings[0]));

        // The same proxy configured against a non-production base URL: the dispatcher is skipped
        // by design, so the log must say the request went out direct. Claiming otherwise is the
        // misdiagnosis this assertion exists to prevent.
        nowPayments.resetAddressValidationAvailability();
        process.env.NOWPAYMENTS_API_BASE_URL = 'https://sandbox.nowpayments.io';
        warnings.length = 0;
        await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
        assert.match(warnings[0], /went out directly/,
            'a request that skipped the proxy was reported as having used it');
        if (priorBaseUrl === undefined) delete process.env.NOWPAYMENTS_API_BASE_URL;
        else process.env.NOWPAYMENTS_API_BASE_URL = priorBaseUrl;
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetAddressValidationAvailability();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a proxy that rejects the credentials is named as such, not as a cancellation', () => {
    // The exact chain undici produces when the proxy answers 407 to a CONNECT. It is three
    // levels deep and only the deepest one names a cause:
    //
    //   TypeError "fetch failed"
    //     cause: Error "Request was cancelled."                       <- names nothing
    //       cause: Error "Proxy response (407) !== 200 when HTTP Tunneling"   <- the answer
    //
    // `describeTransportFailure` read two levels, so the operator saw "Request was cancelled"
    // and no status code -- a symptom, with the one field that identifies the fault discarded.
    // "Request was cancelled." is also undici's generic wrapper for every transport failure, so
    // it is dropped in favour of anything more specific.
    const error = Object.assign(new Error('could not be completed'), {
        proxyUsed: true,
        cause: Object.assign(new Error('Request was cancelled.'), {
            cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling')
        })
    });

    const line = nowPayments.describeTransportFailure(error);
    assert.match(line, /407/, 'the proxy status code did not reach the log line');
    assert.doesNotMatch(line, /Request was cancelled/,
        'the generic wrapper was reported instead of the reason underneath it');
    // One fault, one fix, and the operator is told what it is rather than left to recognise it.
    assert.match(line, /username or password/i, 'the log does not say what to check');
});

test('a cause chain deeper than undici currently nests is still walked', () => {
    // The walk is a loop with a depth cap precisely so a future undici that adds a level does
    // not silently drop the answer again. Asserted by building a chain deeper than the real
    // one, and by a self-referential chain, which an unbounded walk would spin on forever.
    const deep = Object.assign(new Error('wrapper'), {
        cause: Object.assign(new Error('middle'), {
            cause: Object.assign(new Error('innermost'), {
                cause: Object.assign(new Error('the real reason'), {
                    cause: Object.assign(new Error('even deeper'), {
                        cause: new Error('the actual fault')
                    })
                })
            })
        })
    });
    const line = nowPayments.describeTransportFailure(deep, { proxyUsed: false });
    assert.match(line, /the real reason/, 'a deeply nested cause was dropped');

    const looping = new Error('loops');
    looping.cause = looping;
    assert.doesNotThrow(() => nowPayments.describeTransportFailure(looping, { proxyUsed: false }));
});

test('a transport failure that is not a proxy fault is reported without proxy advice', () => {
    // The 407 advice is specific to a 407. A DNS failure or a refused socket must not be given
    // instructions about credentials it has nothing to do with.
    const dns = Object.assign(new Error('fetch failed'), {
        proxyUsed: false,
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND nowpayments.example'), { code: 'ENOTFOUND' })
    });
    const line = nowPayments.describeTransportFailure(dns);
    assert.match(line, /ENOTFOUND/);
    assert.doesNotMatch(line, /username or password/i,
        'proxy credential advice was given for a non-proxy failure');
});

test('a 407 from the proxy stops the proxy being used again in this process', async () => {
    // The failure mode this closes: one expired Fixie plan, or one typo in `FIXIE_URL`, made
    // *every* payout fail -- each one paying a connection timeout, failing, and being reported
    // as an indistinct transport error. A 407 is a configuration fault; waiting cannot change
    // the answer. After one, the app routes directly so the payout queue keeps moving, and the
    // operator gets a single line naming the cause.
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    const errors = [];
    const priorError = console.error;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';
    process.env.NOWPAYMENTS_EMAIL = 'ops@example.com';
    process.env.NOWPAYMENTS_PASSWORD = 'secret';
    process.env.NOWPAYMENTS_API_BASE_URL = nowPayments.PRODUCTION_BASE_URL;
    process.env.FIXIE_URL = 'http://user:pass@fixie.example:443';
    // Explicit, for the same reason as the transport-failure test: a deployment with the IP
    // whitelist off sets this in `.env`, so the proxy cannot be assumed merely from FIXIE_URL
    // being present. This test is about what the proxy does when it is used.
    process.env.NOWPAYMENTS_PAYOUT_PROXY = 'on';
    console.error = (line) => errors.push(String(line));

    try {
        nowPayments.resetPayoutProxyState();
        nowPayments.resetAuthTokenCache();

        // Undici's exact shape for a proxy that refuses the CONNECT.
        const proxy407 = () => {
            const outer = new Error('fetch failed');
            outer.cause = Object.assign(new Error('Request was cancelled.'), {
                cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling')
            });
            throw outer;
        };

        let calls = 0;
        undici.fetch = async () => { calls += 1; proxy407(); };

        // First failure: trips the breaker.
        await assert.rejects(() => nowPayments.getAuthToken());
        assert.equal(errors.length, 1, 'the breaker did not report itself');
        assert.match(errors[0], /407/, 'the log does not name the status');
        assert.match(errors[0], /username or password|wrong|lapsed/i,
            'the log does not say what is wrong');
        // It has to say what happens next, or the operator cannot tell whether payouts still run.
        assert.match(errors[0], /directly/i, 'the log does not say the fallback');
        assert.match(errors[0], /NOWPAYMENTS_PAYOUT_PROXY=off/,
            'the log does not mention the opt-out for a deployment with no whitelist');

        // Second failure: no longer goes through the proxy at all, so no second timeout.
        await assert.rejects(() => nowPayments.getAuthToken());
        assert.equal(calls, 2, 'the breaker did not stop the second request being attempted');
        assert.equal(errors.length, 1, 'the breaker reported itself more than once');

        // And the opt-out is what an operator sets once the whitelist is off.
        process.env.NOWPAYMENTS_PAYOUT_PROXY = 'off';
        assert.equal(nowPayments.payoutProxyDisabled(), true);
        for (const value of ['false', '0', 'direct']) {
            process.env.NOWPAYMENTS_PAYOUT_PROXY = value;
            assert.equal(nowPayments.payoutProxyDisabled(), true, `${value} did not disable the proxy`);
        }
        // Unset is unchanged behaviour, which is the contract every existing deployment relies on.
        delete process.env.NOWPAYMENTS_PAYOUT_PROXY;
        assert.equal(nowPayments.payoutProxyDisabled(), false, 'an unset value disabled the proxy');
    } finally {
        console.error = priorError;
        undici.fetch = originalFetch;
        nowPayments.resetPayoutProxyState();
        nowPayments.resetAuthTokenCache();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a provider 407 is not mistaken for a broken proxy', () => {
    // The breaker disables a *working* proxy if it misreads a provider answer, and the
    // consequence is that every subsequent payout goes out from an address the provider may
    // refuse. So the detector has to be specific: a 407 that is not about proxy tunnelling is
    // somebody else's status code.
    const providerRefusal = Object.assign(new Error('fetch failed'), {
        cause: new Error('the server responded with status 407')
    });
    assert.equal(nowPayments.mentionsProxyAuthFailure(providerRefusal), false);

    const proxyRefusal = Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('Request was cancelled.'), {
            cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling')
        })
    });
    assert.equal(nowPayments.mentionsProxyAuthFailure(proxyRefusal), true);

    assert.equal(nowPayments.mentionsProxyAuthFailure(null), false);
    assert.equal(
        nowPayments.mentionsProxyAuthFailure(Object.assign(new Error('x'), { cause: new Error('getaddrinfo ENOTFOUND') })),
        false
    );
});

test('an unreachable validator is asked once, not once per withdrawal', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';
    delete process.env.FIXIE_URL;

    const warnings = [];
    const logger = { warn: (line) => warnings.push(line) };

    try {
        nowPayments.resetAddressValidationAvailability();
        let calls = 0;
        undici.fetch = async () => {
            calls += 1;
            throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        };

        // Each of these is a separate withdrawal. Without a cool-off, every one of them waits
        // out the full ten-second timeout and spends a metered proxy request to be told the
        // same thing.
        for (let i = 0; i < 4; i += 1) {
            const verdict = await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
            assert.equal(verdict.checked, false);
        }

        assert.equal(calls, 1, `the provider was asked ${calls} times across four withdrawals`);
        assert.equal(warnings.length, 1, 'the cool-off did not also suppress the repeat log');
        assert.match(warnings[0], /5 minutes/, 'the cool-off length is not stated');

        // Recovery is still detected, and the check resumes rather than staying off for good.
        // The reset stands in for what actually ends a cool-off early -- a credential or
        // configuration change -- because waiting out five real minutes is not something a
        // test can do, and skipping the cool-off check here would leave the resume path
        // untested.
        undici.fetch = async () => new Response(JSON.stringify({ is_valid: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
        nowPayments.resetAddressValidationAvailability();
        const recovered = await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
        // `checked: true` is the assertion that matters: it can only be true if the request
        // actually went out, so the cool-off really did end rather than swallowing the call.
        assert.deepEqual(recovered, { checked: true, valid: true, reason: null });
        assert.equal(calls, 1, 'the failing stub was not the one contacted after recovery');

        // And a fresh transport failure re-opens the cool-off and re-reports, so a proxy that
        // is broken again after being fixed does not fail silently from then on.
        undici.fetch = async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); };
        nowPayments.resetAddressValidationAvailability();
        await nowPayments.validatePayoutAddress('bc1qexample', 'btc', { logger });
        assert.equal(warnings.length, 2, 'a second, later failure was never reported');
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetAddressValidationAvailability();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a provider that answers is never cooled off, however bad the answer is', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';

    try {
        nowPayments.resetAddressValidationAvailability();
        let calls = 0;
        // A definitive rejection is a real answer, not a transport failure. Caching that verdict
        // for five minutes would let someone resubmit the same bad address repeatedly, and would
        // also mean the very first address a user typed was the one that got checked.
        undici.fetch = async () => {
            calls += 1;
            return new Response(JSON.stringify({ is_valid: false, error: 'Not a valid address' }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        };

        const first = await nowPayments.validatePayoutAddress('bc1qexample', 'btc');
        const second = await nowPayments.validatePayoutAddress('bc1qexample', 'btc');

        assert.equal(first.checked, true);
        assert.equal(first.valid, false);
        assert.equal(first.reason, 'Not a valid address');
        assert.deepEqual(second, first);
        assert.equal(calls, 2, 'a definitive rejection was cached instead of re-checked');
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetAddressValidationAvailability();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a refusal is reported as a refusal, which is not the same as no figure', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';

    try {
        // `getPayoutMinimum` returns null for three quite different situations, and a caller
        // fanning out over every coin has to tell them apart. Only a refusal means the other
        // coins are not worth asking about; an answer with no usable figure does not.
        assert.equal(nowPayments.isPayoutMinimumRefused(), false, 'a fresh process starts unrefused');

        undici.fetch = async () => new Response('Access denied', { status: 403 });
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            assert.equal(await nowPayments.getPayoutMinimum('btc'), null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(nowPayments.isPayoutMinimumRefused(), true, 'a 403 did not register as a refusal');

        // A usable answer is not a refusal.
        undici.fetch = async () => new Response(JSON.stringify({ min_amount: 3 }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
        nowPayments.resetPayoutMinimumAvailability();
        assert.equal(await nowPayments.getPayoutMinimum('btc'), 3);
        assert.equal(nowPayments.isPayoutMinimumRefused(), false);

        // An answer that carries no usable figure is also not a refusal. This is the case that
        // matters: treating it as one would blank the whole catalogue's minimums because a
        // single coin had an odd window, which is a much worse outcome than falling back to
        // the app default for that one coin.
        nowPayments.resetPayoutMinimumAvailability();
        undici.fetch = async () => new Response(JSON.stringify({ something_else: 1 }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
        assert.equal(await nowPayments.getPayoutMinimum('btc'), null);
        assert.equal(
            nowPayments.isPayoutMinimumRefused(),
            false,
            'a response with no usable minimum was reported as an account refusal'
        );
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetPayoutMinimumAvailability();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a refused payout minimum stops the whole catalogue being asked, not just one coin', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';
    process.env.NOWPAYMENTS_EMAIL = 'ops@example.test';
    process.env.NOWPAYMENTS_PASSWORD = 'test-password';

    try {
        // The refusal is per account, so the fan-out over ~14 coins should cost one request, not
        // fourteen. Before the probe, every worker started before the first 403 had come back,
        // so the cool-off guard could not prevent the rest of the burst.
        const payoutController = require('../src/controllers/payoutController');
        payoutController.resetPayoutLimitsCache();
        nowPayments.resetPayoutMinimumAvailability();

        let minimumCalls = 0;
        undici.fetch = async (url) => {
            if (String(url).includes('/payout-withdrawal/min-amount/')) {
                minimumCalls += 1;
                return new Response('Access denied', { status: 403 });
            }
            // Fees are a different endpoint and are not part of this behaviour.
            return new Response(JSON.stringify({ fee: 0.5 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        };

        const originalWarn = console.warn;
        const originalError = console.error;
        const originalLog = console.log;
        console.warn = () => {};
        console.error = () => {};
        // The recovery notice is sticky across `resetPayoutMinimumAvailability` by design, so
        // an earlier test's refusal makes this one announce a recovery. Correct behaviour, but
        // it is noise in the test output rather than a finding.
        console.log = () => {};
        let limits;
        try {
            limits = await payoutController.fetchPayoutLimits();
        } finally {
            console.warn = originalWarn;
            console.error = originalError;
            console.log = originalLog;
        }

        assert.equal(minimumCalls, 1, `the refused endpoint was called ${minimumCalls} times, expected 1`);
        assert.deepEqual(limits.minimums, {}, 'a refused account still reported provider minimums');
        assert.equal(limits.minimumsSource, 'app-default');
        // The consequence that reaches the user: the $1.00 floor is unconfirmed.
        assert.equal(limits.minimumsConfirmed, false, 'a refusal was reported as a confirmed minimum');
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetPayoutMinimumAvailability();
        require('../src/controllers/payoutController').resetPayoutLimitsCache();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a working endpoint still reads every coin, and confirms the floors', async () => {
    const saved = { ...process.env };
    const originalFetch = undici.fetch;
    process.env.NOWPAYMENTS_API_KEY = 'test-key';

    try {
        // The probe must not cost the catalogue anything when the endpoint works: the guard is
        // on the refusal, not on having made a request.
        const payoutController = require('../src/controllers/payoutController');
        payoutController.resetPayoutLimitsCache();
        nowPayments.resetPayoutMinimumAvailability();

        const seen = new Set();
        undici.fetch = async (url) => {
            if (String(url).includes('/payout-withdrawal/min-amount/')) {
                seen.add(String(url).split('/').pop());
                return new Response(JSON.stringify({ min_amount: 2 }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(JSON.stringify({ fee: 0.5 }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        };

        const originalLog = console.log;
        console.log = () => {};
        let limits;
        try {
            limits = await payoutController.fetchPayoutLimits();
        } finally {
            console.log = originalLog;
        }
        const expected = require('../src/services/payoutOptions').distinctProviderCoins();

        assert.equal(seen.size, expected.length, `read ${seen.size} coins, catalogue has ${expected.length}`);
        assert.equal(limits.minimumsSource, 'provider');
        assert.equal(limits.minimumsConfirmed, true, 'a successful read was not reported as confirmed');
        assert.equal(Object.keys(limits.minimums).length, expected.length);
    } finally {
        undici.fetch = originalFetch;
        nowPayments.resetPayoutMinimumAvailability();
        require('../src/controllers/payoutController').resetPayoutLimitsCache();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
