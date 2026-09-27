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
    distinctProviderCoins
} = require('../services/payoutOptions');
const nowPayments = require('../services/nowPayments');

/**
 * Real per-coin payout limits and fees fetched from provider.
 */
const PAYOUT_LIMITS_TTL_MS = 5 * 60 * 1000;
let payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };

function payoutLimitsIdentity() {
    return `${nowPayments.getApiKey()}|${nowPayments.getBaseUrl()}`;
}

async function fetchPayoutLimits() {
    const coins = distinctProviderCoins();
    
    // Fetch limits in parallel with resilient promise fallbacks
    const [minimums, fees] = await Promise.all([
        Promise.all(coins.map(async (coin) => [coin, await nowPayments.getPayoutMinimum(coin).catch(() => null)])),
        Promise.all(coins.map(async (coin) => [coin, await nowPayments.getPayoutFee(coin, 1).catch(() => null)]))
    ]);

    const minimumMap = {};
    for (const [coin, value] of minimums) {
        if (value !== null && value !== undefined) minimumMap[coin] = value;
    }

    const feeMap = {};
    for (const [coin, value] of fees) {
        if (value !== null && value !== undefined) feeMap[coin] = value;
    }

    return {
        minimums: minimumMap,
        fees: feeMap,
        minimumsSource: Object.keys(minimumMap).length > 0 ? 'provider' : 'app-default',
        feesSource: Object.keys(feeMap).length > 0 ? 'provider' : 'app-default'
    };
}

async function getPayoutLimits() {
    if (!nowPayments.isConfigured() || !nowPayments.isTrustedBaseUrl()) {
        return { minimums: {}, fees: {}, minimumsSource: 'app-default', feesSource: 'app-default' };
    }

    const identity = payoutLimitsIdentity();

    // Serve non-expired cached copy
    if (
        payoutLimitsCache.identity === identity &&
        payoutLimitsCache.value &&
        Date.now() < payoutLimitsCache.expiresAt
    ) {
        return payoutLimitsCache.value;
    }

    // Deduplicate in-flight requests
    if (!payoutLimitsCache.inFlight || payoutLimitsCache.identity !== identity) {
        payoutLimitsCache.identity = identity;
        payoutLimitsCache.inFlight = fetchPayoutLimits()
            .then((value) => {
                if (payoutLimitsCache.identity === identity) {
                    payoutLimitsCache.value = value;
                    payoutLimitsCache.expiresAt = Date.now() + PAYOUT_LIMITS_TTL_MS;
                }
                return value;
            })
            .catch((err) => {
                console.error('Failed to update payout limits cache:', err.message);
                return { minimums: {}, fees: {}, minimumsSource: 'app-default', feesSource: 'app-default' };
            })
            .finally(() => {
                payoutLimitsCache.inFlight = null;
            });
    }

    return payoutLimitsCache.inFlight;
}

/** Drops the cached provider limits answer. */
function resetPayoutLimitsCache() {
    payoutLimitsCache = { identity: null, value: null, expiresAt: 0, inFlight: null };
}

/**
 * Returns options, limits, and supported network configurations for frontend pickers.
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
        console.error('Could not build withdrawal options response:', error.message);
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
                error: `Enter an amount between $${minimumWithdrawalUsd.toFixed(2)} and $${maximumWithdrawalUsd.toFixed(2)}.`
            });
        }

        if (!['paypal', 'crypto', 'venmo'].includes(paymentMethod)) {
            return res.status(400).json({ error: 'Unsupported payment method.' });
        }

        if (paymentAddress.length < 3 || paymentAddress.length > 254) {
            return res.status(400).json({ error: 'Enter a valid payment destination.' });
        }

        // Crypto specific validations
        if (paymentMethod === 'crypto') {
            if (!isSupportedCryptoDestination(assetCode, network)) {
                return res.status(400).json({ error: 'Choose a supported crypto asset and network.' });
            }

            if (!isValidCryptoAddress(assetCode, network, paymentAddress)) {
                return res.status(400).json({
                    error: 'That address does not match the valid format for the selected network.'
                });
            }

            if (requiresDestinationTag(assetCode)) {
                if (!destinationTag) {
                    return res.status(400).json({ error: 'This network requires a destination tag or memo.' });
                }
                if (typeof isValidDestinationTag === 'function' && !isValidDestinationTag(assetCode, destinationTag)) {
                    return res.status(400).json({ error: 'The destination tag format is invalid.' });
                }
            }

            // Consult remote provider validation API
            const coin = providerCoinFor(assetCode, network);
            const verdict = await nowPayments.validatePayoutAddress(paymentAddress, coin, { extraId: destinationTag });
            if (verdict.checked && verdict.valid === false) {
                return res.status(400).json({
                    error: verdict.reason
                        ? `Address validation failed: ${verdict.reason}`
                        : 'Address is invalid or unroutable on the selected chain.'
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

            // Deduct balance
            await client.query(
                'UPDATE users SET balance = balance - $1 WHERE id = $2',
                [amount, userId]
            );

            // Record withdrawal queued request (persisting destination_tag)
            const withdrawalRes = await client.query(
                `INSERT INTO withdrawals
                    (user_id, amount, payment_method, payment_address, asset_code, network, destination_tag)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [
                    userId,
                    amount,
                    paymentMethod,
                    paymentAddress,
                    paymentMethod === 'crypto' ? assetCode : null,
                    paymentMethod === 'crypto' ? network : null,
                    paymentMethod === 'crypto' ? destinationTag : null
                ]
            );

            const withdrawalId = withdrawalRes.rows[0].id;

            // Audit transaction ledger record
            await client.query(
                `INSERT INTO balance_transactions
                    (user_id, amount, transaction_type, source_id, description)
                 VALUES ($1, $2, 'withdrawal', $3, 'Withdrawal request queued')`,
                [userId, -amount, String(withdrawalId)]
            );

            await client.query('COMMIT');

            return res.status(200).json({
                message: 'Withdrawal request queued for review. Funds have not been sent yet.',
                withdrawalId
            });

        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('Payout Request Error:', error);
            return res.status(500).json({ error: 'Internal server error processing payout.' });
        } finally {
            if (client) client.release();
        }
    }
};

module.exports = payoutController;
module.exports.resetPayoutLimitsCache = resetPayoutLimitsCache;