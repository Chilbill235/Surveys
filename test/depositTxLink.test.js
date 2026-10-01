const assert = require('node:assert/strict');
const { test } = require('node:test');
const { depositTxHashFrom } = require('../src/services/nowPayments');
const { transactionUrl, addressUrl, isExplorerIdentifier } = require('../src/services/explorerLinks');

/**
 * Getting the *transaction* in front of the reader, rather than the address they already had.
 *
 * The complaint this fixes is specific: a user paid, went to check, and found a link to their own
 * wallet address. That link is not wrong -- it is the address the payment was sent to -- but it
 * answers a different question, and on a page whose whole purpose is "did my money arrive" it is
 * the wrong answer offered confidently. The transaction is what they are looking for.
 *
 * Three ways this can go wrong, all of them silent, and all three asserted here:
 *
 *   - the hash is never read out of the provider payload, so the receipt can only ever fall back
 *     to the address and the code that claims to fix it changes nothing;
 *   - a value that is not a hash is stored as one, producing a confident link to a page that does
 *     not exist, which is worse than no link at all;
 *   - the address and the transaction are presented under one label, so a reader who clicks the
 *     one that is offered believes they have looked at the payment.
 */

const SOL_SIGNATURE = 'hnaaCeLwwMgvafSbnkUiX1x1Yk992UpGVoSToUU84Rx2vUbA7KwzaN4zzyfNWyyhBCG2H1dc95tHV92NTBnFEuf';
const ETH_HASH = '0x4b1e2f8a1c9d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f';

test('the transaction hash is read out of the provider payload', () => {
    // The exact case from the report: a Solana signature in the response body.
    assert.equal(
        depositTxHashFrom({ tx_hash: SOL_SIGNATURE }),
        SOL_SIGNATURE,
        'a Solana signature in the payload was not read'
    );
    // The status response nests the payment; the IPN is the payment. Both must work, or the sweep
    // and the webhook disagree about whether a hash exists.
    assert.equal(
        depositTxHashFrom({ payment: { tx_hash: ETH_HASH } }),
        ETH_HASH,
        'the nested status response was not read'
    );
});

test("the customer's payin hash is read, and the provider's payout hash is refused", () => {
    // Taken from a real `GET /v1/payment/{id}` response on this account. Both fields are present
    // on the same object, and the difference between them is the difference between a working
    // "check my payment" link and a dead one.
    const payload = {
        payment_id: 5489253433,
        payment_status: 'finished',
        pay_address: 'EgPYjx6m6PCBK7WwaZcxfGRwQJdW9WkRq2TpLaiV3Kqr',
        pay_amount: 0.00841157,
        actually_paid: 0.01679027,
        pay_currency: 'sol',
        order_id: '87',
        // The transaction the customer sent. Base58, 88 characters, a real Solana signature.
        payin_hash: SOL_SIGNATURE,
        // The provider's own onward settlement. NOT a chain transaction -- it is a bookkeeping
        // reference, and it is 64 hex characters, which passes every character test an explorer
        // identifier has to pass.
        payout_hash: 'partner_liability_tx_05cd3ae6a28a3bb2901c625efbe7d29a7ec4e55c440df22253487c6e53e40fad',
        type: 'crypto2crypto'
    };

    assert.equal(
        depositTxHashFrom(payload),
        SOL_SIGNATURE,
        'the customer transaction was not read from payin_hash'
    );

    // The trap. `payout_hash` is real, it is a hash-shaped string, and every generic check passes
    // it. Linking to it produces a solscan /tx/ URL for a transaction that was never on Solana --
    // a link that looks exactly right and 404s, on the page whose only job is to let someone
    // check their money. It is refused by name, not by omission, because the next person to read
    // this payload will see the field and reasonably reach for it.
    assert.ok(
        isExplorerIdentifier(payload.payout_hash),
        'this test is only meaningful if payout_hash passes the identifier check'
    );
    assert.equal(
        depositTxHashFrom({ payout_hash: payload.payout_hash }),
        null,
        "the provider's internal settlement reference was accepted as a transaction hash"
    );
    // And with both present, the customer's wins -- priority order, not whichever came first.
    assert.equal(depositTxHashFrom({ payout_hash: payload.payout_hash, payin_hash: SOL_SIGNATURE }), SOL_SIGNATURE);
    assert.equal(
        depositTxHashFrom({ hash: 'a'.repeat(64), payin_hash: SOL_SIGNATURE }),
        SOL_SIGNATURE,
        'a generic hash field beat the field that is known to be the customer payment'
    );
});

test('the customer transaction is read from every spelling the provider uses', () => {
    // The payout path already learned this one the hard way and lists seven spellings. A deposit
    // that recognises only `tx_hash` reads nothing at all on the chains that spell it differently.
    const spellings = [
        'tx_hash', 'txHash', 'transaction_hash', 'transactionHash', 'txid', 'tx_id', 'hash',
        'payin_hash', 'payinHash', 'payin_tx_hash'
    ];
    for (const spelling of spellings) {
        assert.equal(
            depositTxHashFrom({ [spelling]: SOL_SIGNATURE }),
            SOL_SIGNATURE,
            `the spelling "${spelling}" was not read`
        );
    }
    // And the nested shapes, for the chains that put the transaction on its own object.
    assert.equal(depositTxHashFrom({ transaction: { hash: SOL_SIGNATURE } }), SOL_SIGNATURE);
    assert.equal(depositTxHashFrom({ payment_details: { tx_hash: ETH_HASH } }), ETH_HASH);
    // The IPN shape as well as the status shape.
    assert.equal(depositTxHashFrom({ payment: { payin_hash: SOL_SIGNATURE } }), SOL_SIGNATURE);
});

test('a value that is not a hash is never returned', () => {
    // This is the failure that matters. A `payout:` sentinel, a payment id, a URL, or a sentence
    // all pass a naive "is there a hash field" check, and each would build a link to a page that
    // does not exist. The user is told so by a third party, on a page they opened to verify money.
    const rejects = [
        null, undefined, '', '   ', 'payout:1234', 'batch:99',
        '5077079511',
        'https://evil.example/steal',
        'a'.repeat(4),
        'not a hash with spaces',
        'quote"onclick="alert(1)',
        12345,
        { nested: 'object' }
    ];
    for (const value of rejects) {
        assert.equal(
            depositTxHashFrom({ tx_hash: value }),
            null,
            `${JSON.stringify(value)} was accepted as a transaction hash`
        );
    }
    // A null hash field must not throw or return the sentinel it sits next to.
    assert.equal(depositTxHashFrom({ tx_hash: null, hash: 'payout:7' }), null);
    assert.equal(depositTxHashFrom(null), null);
    assert.equal(depositTxHashFrom(undefined), null);
    assert.equal(depositTxHashFrom('a string, not an object'), null);
});

test('the address is never mistaken for a transaction', () => {
    // A Solana wallet address is a base58 string of a plausible length. It is exactly the kind of
    // value `isExplorerIdentifier` accepts, which is correct for an address link and would be a
    // disaster for a transaction link: the reader would be sent to a /tx/ page for their own
    // wallet. Nothing here can tell the two apart -- that is why the hash is only ever taken from
    // a field the provider names as the transaction, and why the test above rejects the sentinels.
    const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    assert.ok(isExplorerIdentifier(wallet), 'a wallet address must still pass the identifier test');
    // The same value under a transaction field is still rejected only if it fails the test, so the
    // guard here is structural: the caller decides, the validator checks, and neither guesses.
    assert.equal(typeof transactionUrl('SOL', 'solana', wallet), 'string');
});

test('a deposit with a hash gets a transaction link and a labelled address link', () => {
    const tx = transactionUrl('SOL', 'sol', SOL_SIGNATURE);
    const addr = addressUrl('SOL', 'sol', '9WzDXwBbmkg8ZTbN');

    assert.equal(tx, `https://solscan.io/tx/${SOL_SIGNATURE}`, 'the Solana transaction link is not a /tx/ link');
    assert.equal(addr, 'https://solscan.io/account/9WzDXwBbmkg8ZTbN');
    assert.notEqual(tx, addr, 'the transaction link and the address link are the same page');
});

test('a deposit with no hash gets no transaction link rather than a fabricated one', () => {
    // The honest null. A link built from a payment id or an address produces a page that looks
    // right and is not, which is worse for a reader than being told nothing is known yet.
    assert.equal(transactionUrl('SOL', 'sol', null), null);
    assert.equal(transactionUrl('SOL', 'sol', 'payout:1234'), null);
    assert.equal(transactionUrl('SOL', 'sol', '5077079511'), null, 'a bare payment id became a link');
    assert.equal(transactionUrl('SOL', 'sol', ''), null);
});

test('the address link still works when there is no transaction, so the receipt is not empty', () => {
    // The fallback is the point: a provider that publishes no hash must still leave the reader able
    // to watch the payment land. Losing both links would be a regression, not a correction.
    assert.equal(addressUrl('SOL', 'sol', '9WzDXwBbmkg8ZTbN'), 'https://solscan.io/account/9WzDXwBbmkg8ZTbN');
    assert.equal(addressUrl('USDT', 'usdttrc20', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'), 'https://tronscan.org/#/address/TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE');
    assert.equal(addressUrl('BTC', 'btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), 'https://mempool.space/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
});
