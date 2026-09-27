require('dotenv').config();
const { reconcilePendingDeposits } = require('../src/services/depositReconciliation');
const pool = require('../src/config/db');

function readArgument(name) {
    const prefix = `--${name}=`;
    const match = process.argv.find((argument) => argument.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
}

async function main() {
    const rawDepositId = readArgument('deposit');
    if (rawDepositId !== null && !/^\d+$/.test(rawDepositId)) {
        throw new Error('--deposit must be a numeric deposit id.');
    }
    const rawLimit = readArgument('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error('--limit must be an integer between 1 and 200.');
    }

    const summary = await reconcilePendingDeposits({
        limit,
        depositId: rawDepositId === null ? null : Number(rawDepositId)
    });

    console.log('Reconciliation summary:', JSON.stringify(summary));
    if (summary.credited > 0) {
        console.log('Credited deposits were added to the available balance once, and recorded in balance_transactions.');
    }
    if (summary.skipped > 0) {
        console.log('Skipped deposits need a manual look; nothing was credited for them.');
    }
    if (summary.note) {
        // Not a failure: a deployment without payment credentials has nothing to
        // reconcile. Exiting non-zero here would make a healthy instance look broken.
        console.log(`Nothing to do: ${summary.note}`);
    }
    if (summary.checked === 0 && !summary.note) {
        console.log('No unsettled deposits were found.');
    }
}

main()
    .catch((error) => {
        console.error('Reconciliation failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
