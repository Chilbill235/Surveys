/**
 * Supported withdrawal destinations, network mapping, and client-side address validation rules.
 *
 * Provides shared rules across both server-side API validation and browser UI pickers.
 */

// Common Address Pattern Rules
const ethereumAddress = /^0x[a-fA-F0-9]{40}$/;
const tronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// Safe Base58 RegExp constructor helper
function base58Pattern(minLen, maxLen) {
    return new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${minLen},${maxLen}}$`);
}

const cryptoDestinations = [
    {
        assetCode: 'BTC',
        label: 'Bitcoin',
        symbol: 'BTC',
        addressHint: 'Starts with 1, 3, or bc1. Double-check every character.',
        addressPattern: /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
        networks: [{ value: 'bitcoin', label: 'Bitcoin', providerCoin: 'btc' }]
    },
    {
        assetCode: 'ETH',
        label: 'Ethereum',
        symbol: 'ETH',
        addressHint: 'A 0x address, 42 characters including 0x.',
        addressPattern: ethereumAddress,
        networks: [{ value: 'ethereum', label: 'Ethereum (ERC-20)', providerCoin: 'eth' }]
    },
    {
        assetCode: 'USDT',
        label: 'Tether',
        symbol: 'USDT',
        addressHint: 'Tether exists on several chains. The network you pick must match the address you send.',
        networks: [
            { value: 'ethereum', label: 'Ethereum (ERC-20)', providerCoin: 'usdterc20', addressPattern: ethereumAddress, addressHint: 'Ethereum addresses start with 0x and are 42 characters.' },
            { value: 'tron', label: 'TRON (TRC-20)', providerCoin: 'usdttrc20', addressPattern: tronAddress, addressHint: 'TRON addresses start with T and are 34 characters.' },
            { value: 'polygon', label: 'Polygon', providerCoin: 'usdtmatic', addressPattern: ethereumAddress, addressHint: 'Polygon uses standard 0x addresses.' },
            { value: 'bsc', label: 'BNB Smart Chain (BEP-20)', providerCoin: 'usdtbsc', addressPattern: ethereumAddress, addressHint: 'BNB Smart Chain uses standard 0x addresses.' }
        ]
    },
    {
        assetCode: 'USDC',
        label: 'USD Coin',
        symbol: 'USDC',
        addressHint: 'USDC exists on several chains. The network you pick must match the address you send.',
        networks: [
            { value: 'ethereum', label: 'Ethereum (ERC-20)', providerCoin: 'usdcerc20', addressPattern: ethereumAddress, addressHint: 'Ethereum addresses start with 0x and are 42 characters.' },
            { value: 'polygon', label: 'Polygon', providerCoin: 'usdcmatic', addressPattern: ethereumAddress, addressHint: 'Polygon uses standard 0x addresses.' },
            { value: 'bsc', label: 'BNB Smart Chain (BEP-20)', providerCoin: 'usdcbsc', addressPattern: ethereumAddress, addressHint: 'BNB Smart Chain uses standard 0x addresses.' }
        ]
    },
    {
        assetCode: 'LTC',
        label: 'Litecoin',
        symbol: 'LTC',
        addressHint: 'Starts with L, M, 3, or ltc1.',
        addressPattern: /^(ltc1[ac-hj-np-z02-9]{11,71}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
        networks: [{ value: 'litecoin', label: 'Litecoin', providerCoin: 'ltc' }]
    },
    {
        assetCode: 'BCH',
        label: 'Bitcoin Cash',
        symbol: 'BCH',
        addressHint: 'CashAddr format, starting with q or p (bitcoincash: prefix optional).',
        addressPattern: /^((bitcoincash:)?(q|p)[a-z0-9]{41}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i,
        networks: [{ value: 'bitcoin-cash', label: 'Bitcoin Cash', providerCoin: 'bch' }]
    },
    {
        assetCode: 'SOL',
        label: 'Solana',
        symbol: 'SOL',
        addressHint: 'A base58 address, 32 to 44 characters. Never starts with 0, I, O, or l.',
        addressPattern: base58Pattern(32, 44),
        networks: [{ value: 'solana', label: 'Solana', providerCoin: 'sol' }]
    },
    {
        assetCode: 'DOGE',
        label: 'Dogecoin',
        symbol: 'DOGE',
        addressHint: 'Starts with D, 34 characters long.',
        addressPattern: /^D[1-9A-HJ-NP-Za-km-z]{33}$/,
        networks: [{ value: 'dogecoin', label: 'Dogecoin', providerCoin: 'doge' }]
    },
    {
        assetCode: 'XRP',
        label: 'XRP',
        symbol: 'XRP',
        addressHint: 'An r-address such as rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. XRPL requires a numeric destination tag.',
        addressPattern: /^r[0-9a-zA-Z]{24,34}$/,
        requiresExtraId: true,
        extraIdPattern: /^[0-9]{1,10}$/,
        networks: [{ value: 'ripple', label: 'XRP Ledger', providerCoin: 'xrp' }]
    }
];

const fiatMethods = [
    { value: 'paypal', label: 'PayPal', hint: 'A PayPal email address. Payouts are manually reviewed.' },
    { value: 'venmo', label: 'Venmo', hint: 'A Venmo handle (@username). Transfers are manually reviewed.' }
];

/**
 * App-level withdrawal bounds, in USD.
 *
 * These are the floor and ceiling the request endpoint enforces, independent of what any
 * provider or per-network limit says. A provider minimum above $1 (some networks quote more)
 * is applied on top of this floor by the options endpoint, so the number here is the
 * app's own rule and never the reason a request is refused for being too small.
 *
 * The ceiling is $10,000 rather than the balance itself: a request larger than the balance
 * is refused for the more useful reason, and an explicit ceiling gives the amount box and
 * the error message the same number to show.
 */
const minimumWithdrawalUsd = 1.00;
const maximumWithdrawalUsd = 10000.00;

/**
 * Finds asset configuration by ticker symbol.
 */
function findDestination(assetCode) {
    const clean = String(assetCode || '').trim().toUpperCase();
    return cryptoDestinations.find((entry) => entry.assetCode === clean) || null;
}

/**
 * Finds network configuration by asset code and network identifier.
 */
function findNetwork(assetCode, network) {
    const asset = findDestination(assetCode);
    if (!asset || !Array.isArray(asset.networks)) return null;
    const wanted = String(network || '').trim().toLowerCase();
    return asset.networks.find((entry) => entry.value === wanted) || null;
}

/**
 * Resolves the NOWPayments coin ticker key (e.g. 'usdttrc20').
 */
function providerCoinFor(assetCode, network) {
    return findNetwork(assetCode, network)?.providerCoin || null;
}

/**
 * Returns true if the asset/network destination requires a memo/destination tag.
 */
function requiresDestinationTag(assetCode) {
    return findDestination(assetCode)?.requiresExtraId === true;
}

/**
 * Validates whether an extra destination tag / memo matches format rules.
 */
function isValidDestinationTag(assetCode, extraId) {
    const asset = findDestination(assetCode);
    if (!asset || !asset.requiresExtraId) return true;
    if (!extraId) return false;
    const pattern = asset.extraIdPattern || /^[0-9]+$/;
    return pattern.test(String(extraId).trim());
}

/**
 * Returns array of deduplicated NOWPayments provider tickers across all networks.
 */
function distinctProviderCoins() {
    const coins = new Set();
    for (const asset of cryptoDestinations) {
        for (const network of asset.networks || []) {
            if (network.providerCoin) coins.add(network.providerCoin);
        }
    }
    return Array.from(coins);
}

/**
 * Checks if asset code and network pair is officially supported.
 */
function isSupportedCryptoDestination(assetCode, network) {
    return findNetwork(assetCode, network) !== null;
}

/**
 * Validates a cryptocurrency target address string against the specific asset and network.
 */
function isValidCryptoAddress(assetCode, network, address) {
    if (!address) return false;
    const resolvedNetwork = findNetwork(assetCode, network);
    if (!resolvedNetwork) return false;

    const pattern = resolvedNetwork.addressPattern || findDestination(assetCode)?.addressPattern;
    if (!pattern) return true;

    return pattern.test(String(address).trim());
}

module.exports = {
    cryptoDestinations,
    fiatMethods,
    minimumWithdrawalUsd,
    maximumWithdrawalUsd,
    findDestination,
    findNetwork,
    providerCoinFor,
    requiresDestinationTag,
    isValidDestinationTag,
    distinctProviderCoins,
    isSupportedCryptoDestination,
    isValidCryptoAddress
};