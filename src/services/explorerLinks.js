/**
 * Public block-explorer links for a payment, and the reasons this file is careful.
 *
 * Every value produced here ends up in an `href` on a page, and two of them come from a payment
 * provider's response rather than from us. That is the whole reason for the validation below:
 * a link is built by string concatenation, so a value containing a quote or a space can break out
 * of the attribute, and a value that is not an identifier at all produces a link to a page that
 * does not exist while looking exactly like one that does.
 *
 * The second reason is more subtle and cost a real feature. `withdrawals.provider_reference` is
 * not always a transaction hash. It is the hash when the provider gave one, and it is our own
 * `payout:<id>` or `batch:<id>` sentinel when it did not -- the same column, written by
 * `payoutReferenceFrom`, precisely so there is always something to show. Building an explorer URL
 * from that sentinel produces a link to a transaction that was never on any chain, so a sent
 * withdrawal with no hash on the provider is presented as one that can be looked up. A missing
 * link is a smaller problem than a fabricated one, so the sentinels are rejected by name.
 */

/** The chains this app can actually pay out on, with the explorer that indexes them. */
const EXPLORERS = {
    bitcoin: {
        name: 'Mempool',
        tx: (id) => `https://mempool.space/tx/${id}`,
        address: (id) => `https://mempool.space/address/${id}`
    },
    ethereum: {
        name: 'Etherscan',
        tx: (id) => `https://etherscan.io/tx/${id}`,
        address: (id) => `https://etherscan.io/address/${id}`
    },
    litecoin: {
        name: 'Blockchair',
        tx: (id) => `https://blockchair.com/litecoin/tx/${id}`,
        address: (id) => `https://blockchair.com/litecoin/address/${id}`
    },
    'bitcoin-cash': {
        name: 'Blockchair',
        tx: (id) => `https://blockchair.com/bitcoin-cash/tx/${id}`,
        address: (id) => `https://blockchair.com/bitcoin-cash/address/${id}`
    },
    dogecoin: {
        name: 'Blockchair',
        tx: (id) => `https://blockchair.com/dogecoin/tx/${id}`,
        address: (id) => `https://blockchair.com/dogecoin/address/${id}`
    },
    solana: {
        name: 'Solscan',
        tx: (id) => `https://solscan.io/tx/${id}`,
        address: (id) => `https://solscan.io/account/${id}`
    },
    ripple: {
        name: 'XRPScan',
        tx: (id) => `https://xrpscan.com/tx/${id}`,
        address: (id) => `https://xrpscan.com/account/${id}`
    },
    tron: {
        // The hash part of the path, not the whole one. TronScan reads the fragment, so the
        // `#` is part of the URL rather than a delimiter inside a query string.
        name: 'TronScan',
        tx: (id) => `https://tronscan.org/#/transaction/${id}`,
        address: (id) => `https://tronscan.org/#/address/${id}`
    },
    polygon: {
        name: 'PolygonScan',
        tx: (id) => `https://polygonscan.com/tx/${id}`,
        address: (id) => `https://polygonscan.com/address/${id}`
    },
    bsc: {
        name: 'BscScan',
        tx: (id) => `https://bscscan.com/tx/${id}`,
        address: (id) => `https://bscscan.com/address/${id}`
    }
};

/**
 * Every spelling of a chain that reaches this file, mapped to one key in `EXPLORERS`.
 *
 * Three different vocabularies reach here and none of them agree. A deposit stores the provider
 * coin in `network` -- `sol`, `usdttrc20`, `usdtmatic`. A withdrawal stores the destination
 * network the user picked -- `solana`, `ethereum`, `tron`. And the payout path also knows the
 * asset code -- `SOL`, `USDT`, `USDC` -- which on its own is ambiguous across four chains, so
 * the ticker only resolves when it is not a multi-chain one.
 *
 * Resolving from the network is preferred over resolving from the asset, and that ordering is
 * the point: a `USDT` withdrawal on TRON and one on BSC are different chains with different
 * explorers, and a helper that picked the first match for the ticker would send half of them to
 * the wrong blockchain.
 */
const CHAIN_ALIASES = {
    // The spellings the payout and deposit flows use.
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum', 'erc20': 'ethereum',
    litecoin: 'litecoin', ltc: 'litecoin',
    'bitcoin-cash': 'bitcoin-cash', bitcoincash: 'bitcoin-cash', bch: 'bitcoin-cash',
    dogecoin: 'dogecoin', doge: 'dogecoin',
    solana: 'solana', sol: 'solana',
    ripple: 'ripple', xrp: 'ripple', xrpl: 'ripple',
    tron: 'tron', trx: 'tron', 'trc20': 'tron',
    polygon: 'polygon', matic: 'polygon',
    bsc: 'bsc', bnb: 'bsc', 'binance-smart-chain': 'bsc', bscbeacon: 'bsc'
};

/**
 * The provider's per-chain token tickers, which encode the chain in the name.
 *
 * `usdttrc20` is USDT on Tron and `usdtmatic` is USDT on Polygon; both carry `usdt`, so the
 * ticker prefix alone resolves to nothing useful. These are the spellings the payout path
 * stores in `payout_currency` and the deposit path returns as `pay_currency`.
 */
const PROVIDER_COIN_CHAINS = [
    ['usdttrc20', 'tron'], ['usdterc20', 'ethereum'], ['usdtmatic', 'polygon'], ['usdtbsc', 'bsc'],
    ['usdctrc20', 'tron'], ['usdcerc20', 'ethereum'], ['usdcmatic', 'polygon'], ['usdcbsc', 'bsc'],
    ['trx', 'tron'], ['sol', 'solana'], ['xrp', 'ripple']
];

/**
 * Our own placeholders, written into `provider_reference` when the provider gave no hash.
 *
 * Matched before the general identifier test, because `payout:1234` would otherwise pass as an
 * identifier -- it is a legal-looking token -- and produce a link to nothing.
 */
const REFERENCE_SENTINELS = ['payout:', 'batch:'];

/**
 * Whether a value can be safely interpolated into an explorer URL.
 *
 * Base 16, base 58 and bech32 between them cover every hash and address on the chains above,
 * and all three are `[A-Za-z0-9_-]`. The length floor rejects a one-character string that would
 * produce a plausible-looking link to a page that is not there.
 */
function isExplorerIdentifier(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length < 16 || trimmed.length > 200) return false;
    return /^[A-Za-z0-9_-]+$/.test(trimmed);
}

/**
 * Resolves a chain from whatever the caller has, most specific first.
 *
 * Returns null rather than guessing. An unresolved chain produces no links, which renders as
 * an ordinary text field with no link -- the correct outcome for a chain this file does not
 * have an explorer for.
 */
function resolveChain(assetCode, network) {
    // The provider coin is the most specific thing available: it is the only value that
    // distinguishes USDT-on-Tron from USDT-on-BSC.
    for (const [coin, chain] of PROVIDER_COIN_CHAINS) {
        if (String(network || '').trim().toLowerCase() === coin) return chain;
    }

    const networkKey = String(network ?? '').trim().toLowerCase();
    if (networkKey) {
        const fromNetwork = CHAIN_ALIASES[networkKey];
        // A network we do not recognise resolves to nothing, and the ticker is *not* consulted
        // as a fallback. Falling back there is the exact failure this ordering exists to
        // prevent: a deposit on a chain this file has no explorer for, carrying a ticker that
        // also names a different chain (`SOL` on some chain we have not added), would produce a
        // confident link to a transaction on the wrong blockchain. The value is plausible, the
        // url is valid, and the user has no way to tell -- which is worse than no link at all.
        return fromNetwork || null;
    }

    // No network at all: the ticker is the only thing available, and a single-chain ticker
    // still identifies a chain unambiguously. `USDT` and `USDC` are deliberately absent from
    // this map for that reason -- they name four chains each.
    return CHAIN_ALIASES[String(assetCode || '').trim().toLowerCase()] || null;
}

/**
 * A transaction URL, or null when there is no real transaction to link to.
 *
 * `reference` is `provider_reference` for a withdrawal. The sentinel check is what makes this
 * honest: a `payout:<id>` reference means the provider has not published a hash, and saying so
 * by omitting the link is better than inventing one.
 */
function transactionUrl(assetCode, network, reference) {
    if (typeof reference !== 'string') return null;
    const trimmed = reference.trim();
    if (REFERENCE_SENTINELS.some((prefix) => trimmed.toLowerCase().startsWith(prefix))) return null;
    if (!isExplorerIdentifier(trimmed)) return null;
    const chain = resolveChain(assetCode, network);
    if (!chain) return null;
    return EXPLORERS[chain].tx(encodeURIComponent(trimmed));
}

/**
 * An address URL, or null.
 *
 * Used for a deposit address -- the one explorer link a deposit can honestly offer, since the
 * provider's callback carries no transaction hash for an incoming payment -- and for the
 * destination a payout was sent to.
 */
function addressUrl(assetCode, network, address) {
    if (!isExplorerIdentifier(address)) return null;
    const chain = resolveChain(assetCode, network);
    if (!chain) return null;
    return EXPLORERS[chain].address(encodeURIComponent(address.trim()));
}

/**
 * Everything a client needs to render the links for one payment, in one field.
 *
 * A single object rather than two loose columns, so a client cannot show an explorer name
 * without the matching link or the reverse, and so adding a chain later does not change the
 * shape of every response. `chain` and `explorerName` are null when nothing resolved, which is
 * the signal that this payment has nothing to link to.
 */
function explorerLinks({ assetCode, network, transactionReference, address } = {}) {
    const chain = resolveChain(assetCode, network);
    const tx = transactionUrl(assetCode, network, transactionReference);
    const addr = addressUrl(assetCode, network, address);
    return {
        chain,
        explorerName: chain ? EXPLORERS[chain].name : null,
        transactionUrl: tx,
        addressUrl: addr
    };
}

/** Whether this app can link to a chain at all, for a caller deciding to show the field. */
function hasExplorerFor(assetCode, network) {
    return resolveChain(assetCode, network) !== null;
}

module.exports = {
    explorerLinks,
    transactionUrl,
    addressUrl,
    hasExplorerFor,
    resolveChain,
    isExplorerIdentifier
};
