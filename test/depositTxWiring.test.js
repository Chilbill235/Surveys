const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

/**
 * The deposit transaction link, end to end.
 *
 * `depositTxLink.test.js` proves the pieces work. This proves they are *joined*: that the column
 * exists, that something writes it, that the API selects it, and that the receipt prefers the
 * transaction over the address.
 *
 * The reason to assert on source text is that the failure mode here is a chain of individually
 * correct steps with one missing. A working extractor, a column nobody selects, and a receipt that
 * renders correctly from a permanently-null field are all green tests and a product that still
 * shows a wallet address. The join is the thing, and the join is invisible in a unit test.
 */

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const userRoutes = read('src', 'routes', 'userRoutes.js');
const paymentController = read('src', 'controllers', 'paymentController.js');
const reconciliation = read('src', 'services', 'depositReconciliation.js');
const depositReceipt = read('public', 'deposit-receipt.js');
const historyJs = read('public', 'app.js');
const migration = read('db', 'migrations', '031_deposit_tx_hash.sql');

const SIGNATURE = 'hnaaCeLwwMgvafSbnkUiX1x1Yk992UpGVoSToUU84Rx2vUbA7KwzaN4zzyfNWyyhBCG2H1dc95tHV92NTBnFEuf';

test('the column exists and is nullable rather than required', () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS tx_hash TEXT/, 'the column is not created');
    // NOT NULL would make every existing row fail the migration, and a hash genuinely does not
    // exist for a deposit the provider never published one for.
    assert.ok(
        !/tx_hash\s+TEXT\s+NOT NULL/i.test(migration),
        'tx_hash is NOT NULL, which breaks the migration on existing rows'
    );
});

test('both confirmation paths capture the hash', () => {
    // The webhook and the sweep are alternatives, not a sequence: the sweep exists for the
    // callback that never arrives, so a hash captured only in the IPN handler is missing on
    // exactly the deposits nobody was watching.
    assert.match(
        paymentController,
        /depositTxHashFrom\(ipn\)/,
        'the IPN handler never reads a hash out of the callback'
    );
    assert.match(
        reconciliation,
        /depositTxHashFrom\(providerPayment\)/,
        'the reconciliation sweep never reads a hash out of the status response'
    );

    // And each writes it inside the transaction it already holds, rather than opening another.
    for (const [name, source] of [['paymentController', paymentController], ['depositReconciliation', reconciliation]]) {
        assert.match(
            source,
            /UPDATE deposits SET tx_hash = COALESCE\(tx_hash, \$1\)/,
            `${name} does not store the hash`
        );
    }
    // COALESCE, because a later delivery that omits the hash must not erase one already captured.
    assert.equal(
        (paymentController.match(/tx_hash = COALESCE\(tx_hash/g) || []).length, 1,
        'the IPN path lost its COALESCE guard'
    );
});

test('the API selects the column on every route that returns a deposit', () => {
    // Two separate queries, and a hash missing from the second one is invisible on the first page
    // load and present after a refresh -- the shape of bug that gets reported as "sometimes it
    // works".
    assert.match(
        userRoutes,
        /const DEPOSIT_COLUMNS = [^;]*tx_hash/,
        'DEPOSIT_COLUMNS does not select tx_hash'
    );
    assert.match(
        userRoutes,
        /underpaid_at, tx_hash\s*\n\s*FROM deposits/,
        'the live-poll deposit query does not select tx_hash'
    );
});

test('a deposit response offers both links, from the same record', () => {
    const details = /function withDepositDetails\([\s\S]*?\n\}/.exec(userRoutes);
    assert.ok(details, 'withDepositDetails is gone');

    // The hash as the transaction reference. Omitting this is the single change that would make
    // the whole feature inert while every test above still passed.
    assert.match(
        details[0],
        /transactionReference: deposit\.tx_hash/,
        'the deposit is not passed its hash, so no transaction link is ever built'
    );
    // And the address still goes through, as the labelled fallback rather than the only link.
    assert.match(details[0], /address: deposit\.deposit_address/);
});

test('the receipt leads with the transaction and labels the address as an address', () => {
    // Order is the fix. Two links under one label mean a reader who clicks the address concludes
    // their money is missing when it is sitting in a transaction they never opened.
    const txIndex = depositReceipt.indexOf('View transaction on');
    const addressIndex = depositReceipt.indexOf('View deposit address on');
    assert.ok(txIndex > -1, 'the receipt offers no transaction link');
    assert.ok(addressIndex > -1, 'the receipt offers no address link');
    assert.ok(txIndex < addressIndex, 'the address link is rendered before the transaction link');

    // Both labels name what they are. "View this address on Solscan" was accurate and read as a
    // payment, which is the complaint.
    assert.match(
        depositReceipt,
        /View transaction on \$\{explorer\.explorerName\}/,
        'the transaction link is not labelled as a transaction'
    );
    assert.ok(
        !depositReceipt.includes('View this address on'),
        'the address link is still labelled in a way that reads as a payment'
    );
});

test('the history row shows the transaction, and the address only when there is none', () => {
    // A deposit row, which had no disclosure at all until now: the only way to reach a blockchain
    // link for a deposit was the receipt -- a second page and a second click, for the one fact a
    // person is looking for when they look at a deposit row.
    const deposit = /function buildDepositDetails\([\s\S]*?\n\}/.exec(historyJs);
    assert.ok(deposit, 'buildDepositDetails is gone -- a deposit row still has no explorer link');

    // The transaction is preferred and the address is the labelled fallback.
    assert.match(
        deposit[0],
        /const href = explorer\.transactionUrl \|\| explorer\.addressUrl;/,
        'the deposit disclosure does not prefer the transaction link'
    );
    assert.match(
        deposit[0],
        /View transaction on \$\{explorer\.explorerName/,
        'the transaction link is not labelled as a transaction'
    );

    // A withdrawal shows the transaction, never the destination address. The address is on the
    // receipt and in the disclosure's own field; offering it in the list as a peer is how a
    // reader checks an address and concludes the money is missing.
    const withdrawal = /function buildWithdrawalDetails\([\s\S]*?\n\}/.exec(historyJs);
    assert.ok(withdrawal, 'buildWithdrawalDetails is gone');
    assert.match(
        withdrawal[0],
        /const hasTx = Boolean\(explorer\.transactionUrl\);/,
        'the withdrawal disclosure no longer labels which of the two links it is showing'
    );

    // And it is wired in, which is the step that makes the function inert if missed.
    assert.match(
        /function buildHistoryRow\([\s\S]*?\n\}/.exec(historyJs)[0],
        /if \(kind === 'deposit'\) \{\s*\n\s*const detail = buildDepositDetails\(item\);/,
        'the deposit disclosure is built but never added to a row'
    );
});

test('the two disclosures restore their open state independently', () => {
    // One key for both would collide: withdrawal 12 and deposit 12 are different records in
    // different tables, and a live update would re-open the wrong one.
    for (const [fn, attribute] of [['openDetailIdsFor', 'data-deposit-id'], ['restoreOpenDetails', 'data-deposit-id']]) {
        const body = new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`).exec(historyJs);
        assert.ok(body, `${fn} is gone`);
        assert.ok(body[0].includes(attribute), `${fn} does not handle the deposit disclosure`);
    }
    // And the withdrawal key is namespaced rather than reused bare.
    const open = /function openDetailIdsFor\([\s\S]*?\n\}/.exec(historyJs)[0];
    assert.match(open, /open\.add\(`w:\$\{element\.dataset\.withdrawalId\}`\)/, 'the withdrawal key is not namespaced');
    assert.match(open, /open\.add\(`d:\$\{element\.dataset\.depositId\}`\)/, 'the deposit key is not namespaced');
});

test('the backfill asks the provider rather than guessing a hash from the address', () => {
    const script = read('scripts', 'backfill-deposit-tx.js');

    // This is the whole safety argument. A hash cannot be recovered from a deposit address --
    // one address receives many payments, and a guess produces a confident link to somebody
    // else's transaction. Asking the provider for the payment's own record is a read.
    assert.match(script, /getPaymentStatus\(row\.provider_payment_id\)/, 'the backfill does not read the payment from the provider');
    assert.match(script, /depositTxHashFrom\(/, 'the backfill does not run the payload through the hash extractor');

    // Only rows that are actually missing one, so a re-run is a no-op and can never overwrite a
    // hash that arrived with the confirmation.
    assert.match(script, /WHERE tx_hash IS NULL/, 'the backfill would re-read rows that already have a hash');
    assert.match(script, /tx_hash = COALESCE\(tx_hash, \$1\)/, 'the backfill would overwrite a hash written concurrently');

    // And one unreachable payment must not abandon the rest. These are independent reads, and a
    // run that stops at the first failure leaves every remaining row unbackfilled for no reason
    // other than the order the ids happen to come back in.
    assert.match(script, /catch \(error\) \{[\s\S]*?continue;/, 'one failed read aborts the whole backfill');

    // Refuse an unknown provider rather than assuming its payload looks like the known one.
    assert.match(script, /No backfill is implemented for provider/, 'an unknown provider is silently accepted');
});

test('the backfill is wired as a script and is read-only against the provider', () => {
    assert.match(
        read('package.json'),
        /"backfill:deposit-tx": "node scripts\/backfill-deposit-tx\.js"/,
        'the backfill has no npm script'
    );
    const script = read('scripts', 'backfill-deposit-tx.js');
    // It calls the status endpoint and nothing else. A backfill that could move money is a
    // different script, and the difference should be visible in the file.
    for (const forbidden of ['createPayment', 'verifyPayoutBatch', 'creditConfirmedDeposit', 'refundWithdrawal']) {
        assert.ok(!script.includes(forbidden), `the backfill calls ${forbidden}, which can move money`);
    }
});

test('the explorer link builder produces a /tx/ URL for the reported transaction', () => {
    // The literal case from the report, pinned end to end through the real builder, so a change to
    // the chain table that broke Solana would fail here rather than in a browser.
    const { transactionUrl } = require('../src/services/explorerLinks');
    assert.equal(
        transactionUrl('SOL', 'sol', SIGNATURE),
        `https://solscan.io/tx/${SIGNATURE}`
    );
    // And the thing the user was shown instead is still reachable, but as the address it is.
    const { addressUrl } = require('../src/services/explorerLinks');
    assert.equal(addressUrl('SOL', 'sol', SIGNATURE), `https://solscan.io/account/${SIGNATURE}`);
});
