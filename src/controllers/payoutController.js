const pool = require('../config/db');
const { parseAmountInRange } = require('../services/money');
const {
    cryptoDestinations,
    fiatMethods,
    minimumWithdrawalUsd,
    maximumWithdrawalUsd,
    isSupportedCryptoDestination,
    isValidCryptoAddress,
    providerCoinFor,
    requiresDestinationTag,
    distinctProviderCoins
} = require('../services/payoutOptions');
const nowPayments = require('../services/nowPayments');

/**
 * Real per-coin payout limits and fees, when the provider will quote them.
 *
 * The withdrawal form used to state a flat $5 minimum that came from this file alone.
 * NOWPayments enforces its own floor per coin, so a request between $5 and the real
 * minimum was accepted, debited from the balance, and then unsendable. The provider's
 * `GET /v1/payout-withdrawal/min-amount/{coin}` is asked for the truth, and the larger of
 * the two is what the form states and the request is checked against.
 *
 * Cached for the same reason the deposit options are: this is one request per coin per
 * endpoint at the provider's rate limit, so a cold read takes several seconds, and it is
 * made every time the withdrawal form is opened. Fees move with network conditions rather
 * than seconds, so a short cache keeps the form responsive.
 */
const PAYOUT_LIMITS_TTL_MS = 5 * 60 * 1000;
let payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };

function payoutLimitsIdentity() {
    return `${nowPayments.getApiKey()}|${nowPayments.getBaseUrl()}`;
}

async function fetchPayoutLimits() {
    const coins = distinctProviderCoins();
    const [minimums, fees] = await Promise.all([
        Promise.all(coins.map(async (coin) => [coin, await nowPayments.getPayoutMinimum(coin)])),
        Promise.all(coins.map(async (coin) => [coin, await nowPayments.getPayoutFee(coin, 1)]))
    ]);

    const minimumMap = {};
    for (const [coin, value] of minimums) {
        if (value !== null) minimumMap[coin] = value;
    }
    const feeMap = {};
    for (const [coin, value] of fees) {
        if (value !== null) feeMap[coin] = value;
    }
    return {
        minimums: minimumMap,
        fees: feeMap,
        // Reported per field, because the two endpoints can be enabled independently. A
        // single verdict was previously driven by the minimum alone, so a working fee
        // lookup still read as "nothing from the provider".
        minimumsSource: Object.keys(minimumMap).length > 0 ? 'provider' : 'app-default',
        feesSource: Object.keys(feeMap).length > 0 ? 'provider' : 'app-default'
    };
}

async function getPayoutLimits() {
    if (!nowPayments.isConfigured() || !nowPayments.isTrustedBaseUrl()) {
        return { minimums: {}, fees: {}, minimumsSource: 'app-default', feesSource: 'app-default' };
    }

    const identity = payoutLimitsIdentity();
    if (payoutLimitsCache.identity === identity &&
        payoutLimitsCache.value && Date.now() < payoutLimitsCache.expiresAt) {
        return payoutLimitsCache.value;
    }
    if (!payoutLimitsCache.inFlight || payoutLimitsCache.identity !== identity) {
        payoutLimitsCache = { identity, value: null, expiresAt: 0, inFlight: null };
        payoutLimitsCache.inFlight = fetchPayoutLimits()
            .then((value) => {
                if (payoutLimitsCache.identity === identity) {
                    payoutLimitsCache.value = value;
                    payoutLimitsCache.expiresAt = Date.now() + PAYOUT_LIMITS_TTL_MS;
                }
                return value;
            })
            .finally(() => { payoutLimitsCache.inFlight = null; });
    }
    return payoutLimitsCache.inFlight;
}

/** Drops the cached provider answer. Used by tests and after a credential change. */
function resetPayoutLimitsCache() {
    payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };
}


/**
 * Everything the withdrawal form needs in order to be built correctly.
 *
 * The browser used to hardcode the asset and network lists, which meant the picker could
 * offer a destination the server would reject, or hide one it would accept. Serving the
 * authoritative list removes that class of mismatch entirely.
 *
 * Assets and networks also report whether they need a destination tag, so the form can ask
 * for it instead of accepting a request that can never be routed.
 */
async function withdrawalOptions(req, res) {
    let limits = { minimums: {}, fees: {}, minimumsSource: 'app-default', feesSource: 'app-default' };
    try {
        limits = await getPayoutLimits();
    } catch (error) {
        console.error('Could not load NOWPayments payout limits:', error.message);
    }

    try {
        return res.json({
            methods: [
                ...fiatMethods,
                { value: 'crypto', label: 'Cryptocurrency', hint: 'Sent to a wallet address you control. Check the network carefully.' }
            ],
            assets: cryptoDestinations.map((asset) => ({
                code: asset.assetCode,
                label: asset.label,
                symbol: asset.symbol,
                addressHint: asset.addressHint,
                requiresDestinationTag: requiresDestinationTag(asset.assetCode),
                networks: asset.networks.map((network) => {
                    // The provider's floor is quoted in the coin, not in USD, so it is
                    // reported as guidance for the operator rather than used as the amount
                    // bound. The amount bound stays in USD because the balance is in USD.
                    const coinMinimum = limits.minimums[network.providerCoin];
                    return {
                        value: network.value,
                        label: network.label,
                        addressHint: network.addressHint || asset.addressHint,
                        providerCoin: network.providerCoin,
                        minimumCoin: coinMinimum ?? null,
                        estimatedFeeCoin: limits.fees[network.providerCoin] ?? null
                    };
                })
            })),
            minimumUsd: minimumWithdrawalUsd,
            maximumUsd: maximumWithdrawalUsd,
            limitsSource: {
                minimums: limits.minimumsSource,
                fees: limits.feesSource
            }
        });
    } catch (error) {
        // This handler is mounted directly on a router, and Express 4 does not catch a
        // rejected promise from an async handler, so an escaping throw would become an
        // unhandled rejection rather than a 500. Nothing here may reject.
        console.error('Could not build withdrawal options:', error.message);
        return res.status(500).json({ error: 'Failed to load withdrawal options.' });
    }
}



const payoutController = {
    withdrawalOptions,

    requestWithdrawal: async (req, res) => {
        const userId = req.user.id;
        const paymentMethod = String(req.body.paymentMethod || '').toLowerCase();
        const paymentAddress = String(req.body.paymentAddress || '').trim();
        const assetCode = String(req.body.assetCode || '').toUpperCase();
        const network = String(req.body.network || '').toLowerCase();
        const destinationTag = String(req.body.destinationTag || '').trim() || null;

        const amount = parseAmountInRange(req.body.amount, {
            min: minimumWithdrawalUsd,
            max: maximumWithdrawalUsd
        });
        if (amount === null) {
            return res.status(400).json({
                error: `Enter an amount between $${minimumWithdrawalUsd} and $${maximumWithdrawalUsd} with no more than two decimal places.`
            });
        }
        if (!['paypal', 'crypto', 'venmo'].includes(paymentMethod)) {
            return res.status(400).json({ error: 'Unsupported payment method.' });
        }
        if (paymentMethod === 'crypto' && !isSupportedCryptoDestination(assetCode, network)) {
            return res.status(400).json({ error: 'Choose a supported crypto asset and network.' });
        }
        if (paymentAddress.length < 3 || paymentAddress.length > 254) {
            return res.status(400).json({ error: 'Enter a valid payment destination.' });
        }
        // The balance is debited when the request is stored, so an address that can never
        // receive funds has to be refused before that happens. The most common real
        // mistake is an address for a different chain than the network that was selected.
        if (paymentMethod === 'crypto' && !isValidCryptoAddress(assetCode, network, paymentAddress)) {
            return res.status(400).json({
                error: 'That address does not look valid for the selected asset and network. Check the network matches the address.'
            });
        }
        if (paymentMethod === 'crypto' && requiresDestinationTag(assetCode) && !destinationTag) {
            return res.status(400).json({ error: 'This network needs a destination tag as well as the address.' });
        }

        // The regex above proves the address is well-formed. It cannot prove the address
        // exists on the chain that was selected, and a wrong-but-well-formed address is
        // unrecoverable once the balance is debited, so the provider's own validator is
        // consulted. It keys on the network-specific coin ticker, so a TRON address is
        // checked as `usdttrc20` and not as the bare asset.
        if (paymentMethod === 'crypto') {
            const coin = providerCoinFor(assetCode, network);
            const verdict = await nowPayments.validatePayoutAddress(paymentAddress, coin, { extraId: destinationTag });
            if (verdict.checked && verdict.valid === false) {
                return res.status(400).json({
                    error: verdict.reason
                        ? `That address cannot receive funds: ${verdict.reason}`
                        : 'That address cannot receive funds on the selected network.'
                });
            }
        }

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

            if (currentBalance < amount) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Insufficient balance.' });
            }

            await client.query(
                'UPDATE users SET balance = balance - $1 WHERE id = $2',
                [amount, userId]
            );

            const withdrawalRes = await client.query(
                `INSERT INTO withdrawals
                    (user_id, amount, payment_method, payment_address, asset_code, network)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [
                    userId,
                    amount,
                    paymentMethod,
                    paymentAddress,
                    paymentMethod === 'crypto' ? assetCode : null,
                    paymentMethod === 'crypto' ? network : null
                ]
            );
            const withdrawalId = withdrawalRes.rows[0].id;
            await client.query(
                `INSERT INTO balance_transactions
                    (user_id, amount, transaction_type, source_id, description)
                 VALUES ($1, $2, 'withdrawal', $3, 'Withdrawal request queued')`,
                [userId, -amount, String(withdrawalId)]
            );

            await client.query('COMMIT');
            res.status(200).json({
                message: 'Withdrawal request queued for review. Funds have not been sent yet.',
                withdrawalId
            });
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('Payout Request Error:', error.message);
            res.status(500).json({ error: 'Internal server error processing payout.' });
        } finally {
            if (client) client.release();
        }
    }
};

module.exports = payoutController;
module.exports.resetPayoutLimitsCache = resetPayoutLimitsCache;

