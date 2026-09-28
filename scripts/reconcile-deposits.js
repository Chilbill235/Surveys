require('dotenv').config();
const { reconcilePendingDeposits } = require('../src/services/depositReconciliation');
const pool = require('../src/config/db');

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * A deposit id fits in a Postgres BIGINT (19 digits), so a longer numeric
 * string is not a valid id and does not need to reach the database. The rest of
 * the codebase bounds ids the same way; a script that credits balances should
 * not be the one place that does not.
 */
const MAX_ID_LENGTH = 19;
const DEPOSIT_ID_PATTERN = new RegExp(`^\\d{1,${MAX_ID_LENGTH}}$`);

const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

const KNOWN_ARGUMENTS = ['deposit', 'limit', 'i-know-this-is-production'];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Reads a `--name=value` argument, or null when it is absent.
 *
 * The space-separated form (`--deposit 42`) is rejected rather than ignored.
 * Treating it as "no filter" would run a full reconcile against every pending
 * deposit -- a money-moving operation -- for an operator who was trying to
 * limit it to one. Failing loudly is the only safe answer, because the wrong
 * behaviour here credits balances.
 */
function readArgument(name) {
    const prefix = `--${name}=`;
    const matches = process.argv.filter((argument) => argument.startsWith(prefix));
    if (matches.length > 1) {
        throw new Error(`--${name} was supplied more than once; only one value is accepted.`);
    }
    if (matches.length === 1) return matches[0].slice(prefix.length);

    if (process.argv.includes(`--${name}`)) {
        throw new Error(
            `--${name} must be written as --${name}=value (no space). ` +
            `Received "--${name}" without a value, which would otherwise run a full reconcile.`
        );
    }
    return null;
}

/**
 * Rejects anything that is not a recognised `--name` or `--name=value`, so a
 * typo is visible rather than silently accepted.
 */
function rejectUnknownArguments() {
    for (const argument of process.argv.slice(2)) {
        if (!argument.startsWith('--')) continue;
        const name = argument.slice(2).split('=')[0];
        if (!KNOWN_ARGUMENTS.includes(name)) {
            throw new Error(
                `Unknown argument --${name}. Recognised: ` +
                KNOWN_ARGUMENTS.map((n) => `--${n}`).join(', ') + '.'
            );
        }
    }
}

/** Parses and bounds the deposit id, or null when not supplied. */
function parseDepositId(raw) {
    if (raw === null) return null;
    if (!DEPOSIT_ID_PATTERN.test(raw)) {
        throw new Error(
            `--deposit must be a positive integer with at most ${MAX_ID_LENGTH} digits.`
        );
    }
    return Number(raw);
}

/** Parses and bounds the limit, or the default when not supplied. */
function parseLimit(raw) {
    if (raw === null) return DEFAULT_LIMIT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
        throw new Error(`--limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

/**
 * Refuses to run against a production database unless the caller confirms it.
 *
 * This script credits balances, and it is the version an operator runs locally.
 * The maintenance endpoint that does the same thing is gated behind
 * CRON_SECRET in production; this script has no such gate. Without this check,
 * a DATABASE_URL pointed at production by accident -- which is one exported
 * variable away from the same terminal the local work was happening in --
 * credits real deposits against real money.
 *
 * The heuristic is deliberately coarse. It cannot tell for certain whether a
 * URL is production, so it errs on the side of refusing. A false positive costs
 * the operator a single extra flag; a false negative credits money nobody
 * meant to credit.
 */
function guardAgainstProduction() {
    if (process.argv.includes('--i-know-this-is-production')) return;

    const url = process.env.DATABASE_URL || '';
    const looksProduction =
        process.env.NODE_ENV === 'production' ||
        /neon\.tech|supabase\.co|railway\.app|render\.com|amazonaws\.com|azure\.com|heroku\.com/i.test(url);

    if (looksProduction) {
        throw new Error(
            'This looks like a production database. Reconciliation credits balances and cannot be undone. ' +
            'Pass --i-know-this-is-production to proceed, or point DATABASE_URL at a local database.'
        );
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    rejectUnknownArguments();

    const depositId = parseDepositId(readArgument('deposit'));
    const limit = parseLimit(readArgument('limit'));

    guardAgainstProduction();

    const summary = await reconcilePendingDeposits({ limit, depositId });

    console.log('Reconciliation summary:', JSON.stringify(summary, null, 2));
    if (summary.credited > 0) {
        console.log(
            'Credited deposits were added to the available balance once, and recorded in balance_transactions.'
        );
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
    .finally(async () => {
        // Awaited so the process does not exit while the pool is still closing
        // connections. Without this, the exit can race the close on a slow
        // connection.
        await pool.end().catch(() => {});
    });