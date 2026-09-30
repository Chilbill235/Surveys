const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { explorerLinks, transactionUrl, addressUrl, isExplorerIdentifier, resolveChain } =
    require('../src/services/explorerLinks');
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'userRoutes.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const serverApp = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const receiptJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'withdrawal-receipt.js'),
    'utf8'
);

/**
 * Why a link builder cannot be trusted to be handed anything.
 *
 * Every value here becomes an `href`, and two of the three arrive from a payment provider
 * rather than from this app. A provider reference is not even a hash: `payoutReferenceFrom`
 * writes a `payout:<id>` or `batch:<id>` sentinel into the same column when the provider
 * published no transaction id, precisely so there is always something to show. Building an
 * explorer URL from that produces a link to a transaction that was never on any chain, presented
 * exactly like one that can be looked up -- which is worse than showing nothing.
 */

// The real value from withdrawal 84, a finished SOL payout.
const SOL_TX = 'X5jr18jvqAbZ8WVUTT9YXvPqq5rAXwMLaWC9dEKbfGvsAgXpB2BFdumgWu8tf9ysrNQYy8gARPNUA1WxWPf7QzM';
const SOL_ADDRESS = 'Ygs89NQwoq9SdAY7urzmfD5nQFt3tVJwn3hAJTbREB';

test('a real transaction hash on a known chain produces an explorer link', () => {
    const url = transactionUrl('SOL', 'solana', SOL_TX);
    assert.equal(url, `https://solscan.io/tx/${SOL_TX}`);
});

test('our own sentinels are never turned into a transaction link', () => {
    // The one 4xx-shaped case that matters most: `provider_reference` is a hash OR one of these.
    // A link built from either is a dead end that looks real, and the user is the one who finds
    // out -- on a withdrawal they have just been told went through.
    for (const reference of ['payout:5007985324', 'batch:5006836498', 'PAYOUT:1', 'BATCH:2']) {
        assert.equal(
            transactionUrl('SOL', 'solana', reference),
            null,
            `${reference} was turned into a transaction link, but no such transaction exists`
        );
    }
});

test('a reference that is not an identifier is refused', () => {
    // Each of these would produce a syntactically valid href pointing somewhere meaningless.
    for (const reference of [
        'javascript:alert(1)',          // an href that is not a url at all
        'abc',                          // too short to be a hash
        'X5jr 18jvqAb Z8WVUTT9',        // spaces
        '"><script>alert(1)</script>',  // attribute breakout
        'https://evil.example/tx/1',   // absolute url where an id belongs
        '../../admin',                 // traversal
        ''
    ]) {
        assert.equal(
            transactionUrl('SOL', 'solana', reference),
            null,
            `${JSON.stringify(reference)} was accepted as a transaction id`
        );
    }
});

test('a non-string or missing reference is refused rather than thrown on', () => {
    for (const reference of [null, undefined, 0, {}, [], true, 12345]) {
        assert.equal(transactionUrl('SOL', 'solana', reference), null);
    }
});

test('an address is validated the same way a hash is', () => {
    assert.equal(addressUrl('SOL', 'solana', SOL_ADDRESS), `https://solscan.io/account/${SOL_ADDRESS}`);
    for (const bad of ['javascript:alert(1)', 'short', 'a"b', 'a b', null, '']) {
        assert.equal(addressUrl('SOL', 'solana', bad), null);
    }
});

test('every chain this app pays out on resolves to a working explorer', () => {
    // Taken from the payout options, so a chain added there and not here shows up as a missing
    // link rather than as a link to the wrong chain.
    const chains = {
        btc: 'bitcoin', eth: 'ethereum', ltc: 'litecoin', bch: 'bitcoin-cash',
        doge: 'dogecoin', sol: 'solana', xrp: 'ripple'
    };
    for (const [coin, chain] of Object.entries(chains)) {
        assert.equal(resolveChain(coin, null), chain, `${coin} does not resolve`);
        const url = transactionUrl(coin, chain, SOL_TX);
        assert.ok(url && url.startsWith('https://'), `${coin} produces no usable transaction link`);
        assert.match(url, /\/tx\//, `${coin} does not produce a transaction url`);
    }
});

test('a multi-chain token resolves from its network, not from its ticker', () => {
    // USDT on Tron and USDT on BSC are different chains with different explorers, and picking
    // the first match for the ticker sends half the withdrawals to the wrong blockchain -- the
    // kind of wrong that looks entirely correct.
    const tron = transactionUrl('USDT', 'usdttrc20', SOL_TX);
    const bsc = transactionUrl('USDT', 'usdtbsc', SOL_TX);
    const polygon = transactionUrl('USDT', 'usdtmatic', SOL_TX);

    assert.match(tron, /tronscan\.org/, 'USDT on Tron did not resolve to TronScan');
    assert.match(tron, /#\/transaction\//, 'the TronScan url is missing its fragment path');
    assert.match(bsc, /bscscan\.com/, 'USDT on BSC did not resolve to BscScan');
    assert.match(polygon, /polygonscan\.com/, 'USDT on Polygon did not resolve to PolygonScan');
    // Three chains, three different explorers. Two of them agreeing would mean a lookup table
    // that is keyed on the wrong thing.
    assert.equal(new Set([tron, bsc, polygon]).size, 3);
});

test('the withdrawal network spelling and the deposit network spelling both resolve', () => {
    // A withdrawal stores `solana`; a deposit stores the provider coin `sol`. Same chain, two
    // vocabularies, and a helper that only knew one would work in one half of the product.
    assert.equal(
        transactionUrl('SOL', 'solana', SOL_TX),
        transactionUrl('SOL', 'sol', SOL_TX)
    );
});

test('an unknown chain produces no links rather than a guess', () => {
    // The chains this app accepts for deposits but does not pay out on. There is no honest link
    // to make for them, and a wrong one is worse than none.
    //
    // `''` and `null` are deliberately not in this list: an absent network is not an unknown
    // one. A record with no network falls back to a single-chain ticker, which is the only case
    // where the ticker identifies a chain on its own.
    for (const chain of ['ada', 'dot', 'avax', 'klingon']) {
        assert.equal(resolveChain('SOL', chain), null, `${chain} resolved to a chain`);
        assert.equal(transactionUrl('SOL', chain, SOL_TX), null);
    }
    // The case this guards: an unrecognised network must not fall back to the ticker, because
    // `SOL` on a chain we have no explorer for would otherwise produce a perfectly valid link
    // to a perfectly wrong blockchain.
    assert.equal(resolveChain('SOL', 'klingon'), null, 'an unknown network fell back to the ticker');
    // An absent network does fall back, which is the whole point of the two-step order.
    assert.equal(resolveChain('SOL', null), 'solana');
    assert.equal(resolveChain('SOL', ''), 'solana');
    // A multi-chain ticker with no network is not a chain, and must not become one.
    assert.equal(resolveChain('USDT', null), null);
    assert.equal(resolveChain('USDC', ''), null);
});

test('isExplorerIdentifier accepts the real shapes and rejects the rest', () => {
    assert.equal(isExplorerIdentifier(SOL_TX), true, 'a real base58 Solana signature was rejected');
    assert.equal(isExplorerIdentifier(SOL_ADDRESS), true, 'a real base58 Solana address was rejected');
    assert.equal(
        isExplorerIdentifier('0x1234567890abcdef1234567890abcdef12345678'),
        true,
        'a real EVM hash was rejected'
    );
    assert.equal(
        isExplorerIdentifier('rDsbeomae4FXwgQTJp9Rs64Qg8vokaa7BYXi'),
        true,
        'a real XRPL address was rejected'
    );
    for (const bad of [null, undefined, 42, 'x', 'has space', 'a/b', 'a:b', '<script>']) {
        assert.equal(isExplorerIdentifier(bad), false, `${JSON.stringify(bad)} was accepted`);
    }
});

test('the links object is all-or-nothing about its explorer name', () => {
    // A client that shows the name without a link renders "Solscan" next to a hash and no way
    // to get there, which is worse than not mentioning it.
    const good = explorerLinks({ assetCode: 'SOL', network: 'solana', transactionReference: SOL_TX });
    assert.equal(good.explorerName, 'Solscan');
    assert.ok(good.transactionUrl);

    const unknown = explorerLinks({ assetCode: 'SOL', network: 'klingon', transactionReference: SOL_TX });
    assert.equal(unknown.explorerName, null);
    assert.equal(unknown.transactionUrl, null);
    assert.equal(unknown.addressUrl, null);
});

// ---------------------------------------------------------------------------
// The plumbing
// ---------------------------------------------------------------------------

test('a deposit gets an address link and no transaction link', () => {
    // A statement about the provider, not an omission: the NOWPayments callback carries the
    // payment id, the amounts and the status, and no on-chain hash for an incoming payment,
    // because the provider is the one transacting. Inventing a transaction url here would be a
    // link to a hash nobody has.
    const deposit = explorerLinks({ assetCode: 'SOL', network: 'sol', address: SOL_ADDRESS });
    assert.equal(deposit.addressUrl, `https://solscan.io/account/${SOL_ADDRESS}`);
    assert.equal(deposit.transactionUrl, null);
});

test('the single-withdrawal endpoint is registered and owner-scoped', () => {
    assert.match(routes, /router\.get\('\/withdrawals\/:id'/, 'no single-withdrawal endpoint exists');
    assert.match(
        routes,
        /WHERE w\.id = \$1 AND w\.user_id = \$3/,
        'the withdrawal lookup is not scoped to its owner'
    );
    // 404 rather than 403, so the response does not confirm that someone else\'s id exists.
    assert.match(
        routes,
        /router\.get\('\/withdrawals\/:id'[\s\S]{0,600}?status\(404\)\.json\(\{ error: 'Withdrawal not found\.' \}\)/,
        'a withdrawal that is not the caller\'s does not 404'
    );
});

test('the withdrawal receipt page is routed and gated', () => {
    assert.match(
        serverApp,
        /app\.get\('\/receipt\/withdrawal\/:id'/,
        'the withdrawal receipt is not routed'
    );
    assert.match(
        serverApp,
        /sendHtml\(res, 'withdrawal-receipt\.html'\)/,
        'the withdrawal receipt route does not serve the page'
    );
    // Every field comes from the authenticated endpoint, so the shell cannot show a withdrawal
    // that is not the reader\'s.
    assert.match(receiptJs, /requireSession\(\)/, 'the receipt does not require a session');
    assert.match(
        receiptJs,
        /`\/api\/user\/withdrawals\/\$\{id\}`/,
        'the receipt does not read the owner-scoped endpoint'
    );
});

test('a refund outranks a failure on the receipt', () => {
    // "Failed" beside a debited balance reads as money lost. The ledger is the only thing that
    // says the money came back, and a receipt showing the status without it would be reporting
    // a loss that did not happen.
    const outcome = /function outcomeOf\(withdrawal\) \{([\s\S]*?)\n\}/.exec(receiptJs);
    assert.ok(outcome, 'the receipt has no outcome function');
    assert.match(
        outcome[1],
        /if \(withdrawal\.refunded_at\)/,
        'the refund is no longer checked first'
    );
    assert.match(outcome[1], /state: 'refunded'/, 'a refund does not read as a refund');
});

test('the receipt renders the explorer links the server resolved', () => {
    // And does not build its own. A second copy of the chain table in the client is a second
    // copy to get wrong, and a wrong one links to a transaction that never existed.
    assert.match(receiptJs, /withdrawal\.explorer/, 'the receipt ignores the resolved links');
    assert.match(receiptJs, /explorer\.transactionUrl/, 'the receipt does not offer the transaction link');
    assert.match(receiptJs, /explorer\.addressUrl/, 'the receipt does not offer the address link');
    assert.doesNotMatch(
        receiptJs,
        /solscan|etherscan|bscscan|tronscan/,
        'the receipt builds its own explorer url instead of using the server\'s'
    );
});

test('an external explorer link opens safely', () => {
    // The one link on the page that leaves the site entirely. `target="_blank"` without
    // `noopener` hands the opened page a reference to this one.
    assert.match(receiptJs, /rel = 'noopener noreferrer'/, 'the receipt link does not set noopener');
    assert.match(appJs, /rel = 'noopener noreferrer'/, 'the history link does not set noopener');
});

test('a withdrawal notification points at that withdrawal\'s row in the history list', () => {
    // Every withdrawal notification used to point at `/account`, so being told your money was
    // sent ended in a list where the row was one of a dozen. It now names the row, and the
    // history page scrolls to it.
    for (const [name, pattern] of [
        ['notifyWithdrawalPaid', /notifyWithdrawalPaid/],
        ['notifyWithdrawalFailed', /notifyWithdrawalFailed/]
    ]) {
        const body = new RegExp(`function ${name}\\(item\\) \\{([\\s\\S]*?)\\n\\}`).exec(appJs);
        assert.ok(body, `${name} is gone`);
        assert.match(
            body[1],
            /withdrawalId: item\.id/,
            `${name} does not carry the withdrawal id to the toast or the bell`
        );
    }
    // And the id has to mean something at the other end.
    const target = /function notificationTarget\(([\s\S]*?)\n\}/.exec(appJs);
    assert.ok(target, 'notificationTarget is gone');
    assert.match(target[1], /historyRowId\('withdrawal', record\)/, 'a withdrawal id resolves to no row');
});

test('a submitted withdrawal is linked to its own history row', () => {
    // Unlike a payout in flight, a *request* writes its ledger row in the same transaction that
    // debits the balance, so the row saying "Withdrawal request queued" already exists when this
    // notification is built. It is also the honest answer to the question the notice raises:
    // where is my money right now.
    const body = /function notifyWithdrawalSubmitted\(([\s\S]*?)\n\}/.exec(appJs);
    assert.ok(body, 'notifyWithdrawalSubmitted is gone');
    assert.match(
        body[1],
        /withdrawalId = result\?\.withdrawalId/,
        'a submitted withdrawal is not linked to the row that already exists for it'
    );
    // And the toast and the bell must agree, or one of them lands somewhere else.
    assert.match(
        body[1],
        /showToast\(title, message, \{ tone: 'info', category: 'withdrawal', withdrawalId \}\)/,
        'the toast has no id'
    );
    assert.match(
        body[1],
        /pushNotification\(\{ title, message, tone: 'info', category: 'withdrawal', withdrawalId \}\)/,
        'the bell has no id'
    );
});

test('a rejected deposit is linked to its receipt, because it has no history row', () => {
    // A credit writes a `balance_transactions` row and a failure writes none -- no money moved,
    // so there is no movement to record. A link to a fragment that matches nothing is the exact
    // failure this feature exists to remove, so the two outcomes are pointed at different places
    // on purpose rather than uniformly.
    const rejected = /function notifyDepositRejected\(([\s\S]*?)\n\}/.exec(appJs);
    assert.ok(rejected, 'notifyDepositRejected is gone');
    assert.match(
        rejected[1],
        /\/receipt\/deposit\//,
        'a rejected deposit does not link to its receipt'
    );

    // And it has to actually be announced, which needs a state-keyed guard rather than the
    // id-only one. Keyed on the id alone, the first announcement for a deposit consumes the
    // entry and every later state of the same deposit is silent.
    assert.match(
        appJs,
        /const depositStateSeen = \{[\s\S]*?has\(id, state\)/,
        'deposit announcements are not keyed on the state as well as the id'
    );
    assert.match(
        appJs,
        /depositStateSeen\(item\.id, state\)/,
        'the deposit loop does not record which state it announced'
    );
    const creditedSeen = /const depositStateSeen = \{([\s\S]*?)\n\};/.exec(appJs);
    assert.ok(creditedSeen, 'the deposit state store is gone');
    assert.match(creditedSeen[1], /\$\{String\(id\)\}:\$\{String\(state\)\}/, 'the state is not part of the key');
});

test('the bell resolves the stored record rather than a pre-resolved url', () => {
    // One rule builds the destination. Resolving at push time and storing a url meant the label
    // was fixed at creation ("View details" forever, even for a receipt) and a notification that
    // outlived its own logic kept pointing wherever it was written.
    assert.match(
        appJs,
        /recordId: depositId \?\? withdrawalId \?\? null/,
        'the notification does not store the record it is about'
    );
    assert.match(
        appJs,
        /recordId: item\.recordId/,
        'the bell does not resolve the stored record'
    );
    assert.match(
        appJs,
        /notificationTarget\(\{[\s\S]*?category: item\.category/,
        'the bell does not resolve its destination through notificationTarget'
    );
});
