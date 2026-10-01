require('dotenv').config();
const pool = require('../src/config/db');
const nowPayments = require('../src/services/nowPayments');

/**
 * Fills in `deposits.tx_hash` for deposits recorded before the column existed.
 *
 * Migration 031 added the column and left it null, and nothing was backfilled: a hash that was
 * never stored cannot be recovered from a deposit address by looking at the chain, because one
 * address can receive many payments and a guess would produce a confident link to somebody else's
 * transaction. So those deposits kept showing a wallet address, which is the thing the change was
 * meant to stop.
 *
 * Asking the provider is not a guess. `GET /v1/payment/{id}` returns the payment's own record, and
 * the hash on it is the hash of that payment. So this is a read, not a reconstruction, and it is
 * safe to run against rows that already have a hash -- the update is a no-op for them.
 *
 * Usage:
 *   node scripts/backfill-deposit-tx.js                    every deposit with no hash
 *   node scripts/backfill-deposit-tx.js --limit=200        cap the number read
 *   node scripts/backfill-deposit-tx.js --provider=nowpayments
 *
 * Read-only against the provider: it calls the status endpoint and nothing else. It writes only
 * `deposits.tx_hash`, and only where that column is currently null.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseArgs(argv) {
    const args = { limit: DEFAULT_LIMIT, provider: 'nowpayments' };
    for (const raw of argv) {
        const match = /^--([a-z-]+)(?:=(.*))?$/.exec(String(raw));
        if (!match) continue;
        if (match[1] === 'limit') {
            const n = Number.parseInt(match[2] ?? '', 10);
            if (Number.isFinite(n) && n > 0) args.limit = Math.min(n, MAX_LIMIT);
        } else if (match[1] === 'provider') {
            args.provider = String(match[2] ?? '').trim().toLowerCase();
        }
    }
    return args;
}

async function main() {
    const { limit, provider } = parseArgs(process.argv.slice(2));

    if (provider !== 'nowpayments') {
        console.error(`No backfill is implemented for provider "${provider}". Only nowpayments is known to publish a hash.`);
        process.exitCode = 1;
        return;
    }

    const pending = await pool.query(
        `SELECT id, provider_payment_id, asset_code, network
           FROM deposits
          WHERE tx_hash IS NULL
            AND provider_payment_id IS NOT NULL
            AND provider = 'nowpayments'
          ORDER BY id
          LIMIT $1`,
        [limit]
    );

    if (pending.rows.length === 0) {
        console.log('No deposits are missing a transaction hash.');
        return;
    }

    console.log(`Reading ${pending.rows.length} deposit(s) from the provider. This makes one API call each.`);
    let filled = 0;
    let empty = 0;
    let failed = 0;

    for (const row of pending.rows) {
        let hash = null;
        try {
            hash = nowPayments.depositTxHashFrom(await nowPayments.getPaymentStatus(row.provider_payment_id));
        } catch (error) {
            // One unreachable deposit must not abandon the rest: these are independent reads and a
            // run that stops at the first failure leaves the remaining rows unbackfilled for no
            // reason other than the order they happen to be in.
            failed += 1;
            console.log(`  deposit ${row.id}: could not read the provider (${error.message}) - skipped`);
            continue;
        }

        if (!hash) {
            // The common case, and not a failure: the provider publishes no hash for this payment.
            // Saying so plainly is the difference between "we tried" and "we gave up".
            empty += 1;
            continue;
        }

        // COALESCE for the same reason the capture path uses: a concurrent confirmation may have
        // written a hash between the read and here, and the one that got there first is the one
        // that was read from the payment record that produced it.
        const written = await pool.query(
            'UPDATE deposits SET tx_hash = COALESCE(tx_hash, $1) WHERE id = $2 RETURNING id',
            [hash, row.id]
        );
        if (written.rowCount > 0) {
            filled += 1;
            console.log(`  deposit ${row.id}: ${hash}`);
        }
    }

    console.log(`\nFilled ${filled}, still unknown ${empty}, unreadable ${failed}.`);
    if (empty > 0) {
        console.log('A deposit with no hash keeps its address link, which is a true statement about what the provider published.');
    }
}

main()
    .catch((error) => {
        console.error('Backfill failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
