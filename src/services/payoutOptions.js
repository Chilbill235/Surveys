/**
 * Supported withdrawal destinations, and how to recognise a valid address for each.
 *
 * The destination list lived in two places: the payout controller, which validates a
 * request, and the browser bundle, which builds the asset and network pickers. Adding an
 * asset on the server without the matching client entry produced a request the user could
 * not make, and the reverse produced a picker the server always rejected. Both now read
 * this, and the browser learns what is supported from `withdrawalOptions`.
 *
 * A network is listed only when funds can actually be sent on it, because sending to the
 * wrong chain is unrecoverable. Payouts are still not dispatched automatically, so an
 * operator must review and send every request manually.
 *
 * `providerCoin` is the ticker NOWPayments expects for that specific network. It is not
 * the asset code: Tether is `usdt` as an asset but `usdterc20`, `usdttrc20`, or
 * `usdtmatic` depending on the chain, and the address validator checks the chain implied
 * by the ticker. Validating a TRON address against the bare `usdt` ticker would confirm
 * the wrong network, which is precisely the mistake that loses funds.
 */

const ethereumAddress = /^0x[a-fA-F0-9]{40}$/;
const tronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const base58 = (firstChars, min, max) => new RegExp(`^[${firstChars}][a-km-zA-HJ-NP-Z1-9]{${min},${max}}$`);

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
            { value: 'polygon', label: 'Polygon', providerCoin: 'usdtmatic', addressPattern: ethereumAddress, addressHint: 'Polygon uses standard 0x addresses.' }
        ]
    },
    {
        assetCode: 'USDC',
        label: 'USD Coin',
        symbol: 'USDC',
        addressHint: 'USDC exists on several chains. The network you pick must match the address you send.',
        networks: [
            { value: 'ethereum', label: 'Ethereum (ERC-20)', providerCoin: 'usdcerc20', addressPattern: ethereumAddress, addressHint: 'Ethereum addresses start with 0x and are 42 characters.' },
            { value: 'polygon', label: 'Polygon', providerCoin: 'usdcmatic', addressPattern: ethereumAddress, addressHint: 'Polygon uses standard 0x addresses.' }
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
        addressPattern: /^(bitcoincash:)?[qp][a-z0-9]{40,41}$/,
        networks: [{ value: 'bitcoin-cash', label: 'Bitcoin Cash', providerCoin: 'bch' }]
    },
    {
        assetCode: 'SOL',
        label: 'Solana',
        symbol: 'SOL',
        addressHint: 'A base58 address, 32 to 44 characters. Never starts with 0 or I/O/l.',
        addressPattern: base58('1-9A-HJ-NP-Za-km-z', 31, 43),
        networks: [{ value: 'solana', label: 'Solana', providerCoin: 'sol' }]
    },
    {
        assetCode: 'XRP',
        label: 'XRP',
        symbol: 'XRP',
        addressHint: 'An r-address such as rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX. XRPL also uses a destination tag.',
        addressPattern: /^r[0-9a-zA-Z]{24,34}$/,
        // XRP Ledger needs a destination tag as well as an address, which the provider
        // takes as `extra_id`. Without it a transfer can be sent but not routed.
        requiresExtraId: true,
        networks: [{ value: 'ripple', label: 'XRP Ledger', providerCoin: 'xrp' }]
    }
];


const fiatMethods = [
    { value: 'paypal', label: 'PayPal', hint: 'A PayPal email address. Payouts go through PayPal Mass Payout and are not sent automatically.' },
    { value: 'venmo', label: 'Venmo', hint: 'A Venmo username. Venmo transfers are not sent automatically.' }
];

const minimumWithdrawalUsd = 5.00;
const maximumWithdrawalUsd = 50000.00;

function findDestination(assetCode) {
    return cryptoDestinations.find(
        (entry) => entry.assetCode === String(assetCode || '').trim().toUpperCase()
    ) || null;
}

function findNetwork(assetCode, network) {
    const asset = findDestination(assetCode);
    if (!asset) return null;
    const wanted = String(network || '').trim().toLowerCase();
    return asset.networks.find((entry) => entry.value === wanted) || null;
}

/**
 * The ticker NOWPayments uses for an asset on a specific network.
 *
 * `POST /v1/payout/validate-address` and the payout fee endpoint both key on this, and it
 * is the only place the chain is expressed. A TRON USDT address validated against the
 * bare `usdt` ticker is checked against the wrong chain and would pass while being
 * unsendable, so this is resolved from the network rather than the asset.
 *
 * Returns null when the asset or network is not one this build offers. There is
 * deliberately no fallback to the asset's first network: an unrecognised network must not
 * quietly resolve to some other chain, which is the exact mistake this mapping exists to
 * prevent. The caller checks the pair against `isSupportedCryptoDestination` first.
 */
function providerCoinFor(assetCode, network) {
    return findNetwork(assetCode, network)?.providerCoin || null;
}


/**
 * True when the asset needs a destination tag or memo alongside the address.
 *
 * XRPL routes by a numeric destination tag; a transfer without one is unsendable however
 * correct the address is, and the address format alone cannot detect that.
 */
function requiresDestinationTag(assetCode) {
    return findDestination(assetCode)?.requiresExtraId === true;
}

/**
 * Every distinct coin the app can pay out on, de-duplicated across networks.
 *
 * Used to ask the provider for real per-coin payout minimums and fees, so the withdrawal
 * form can quote what a transfer will actually cost instead of a hardcoded number.
 */
function distinctProviderCoins() {
    const coins = new Set();
    for (const asset of cryptoDestinations) {
        for (const network of asset.networks) {
            if (network.providerCoin) coins.add(network.providerCoin);
        }
    }
    return [...coins];
}

/**
 * Returns true when the asset/network pair is one this build can pay out to.
 *
 * Both values are compared after normalisation because the request arrives with whatever
 * case the client sent, while the table is the canonical upper-case form.
 */
function isSupportedCryptoDestination(assetCode, network) {
    return findNetwork(assetCode, network) !== null;
}

/**
 * Checks a crypto address against the format for the chosen asset and network.
 *
 * This never touches the network, so it cannot tell a well-formed address from one that
 * simply does not exist. It does catch the realistic mistakes: pasting an address for the
 * wrong chain, truncating it, or sending a memo-tagged destination. A rejected address is
 * never stored, because a request recorded with an unusable address is paid late or not
 * at all, and the funds are already debited by then.
 *
 * This is the local first pass. `payoutController` follows it with the provider's own
 * `POST /v1/payout/validate-address`, which is the only check that can know an address
 * really exists on the selected chain.
 */
function isValidCryptoAddress(assetCode, network, address) {
    const resolvedNetwork = findNetwork(assetCode, network);
    if (!resolvedNetwork) return false;
    const pattern = resolvedNetwork.addressPattern || findDestination(assetCode)?.addressPattern;
    if (!pattern) return true;
    return pattern.test(String(address || '').trim());
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
    distinctProviderCoins,
    isSupportedCryptoDestination,
    isValidCryptoAddress
};

