/**
 * Reconciles the stored balances against the ledger that is supposed to explain them.
 *
 * Every check here exists because the corresponding failure is invisible from the outside:
 * the API keeps returning 200s and the dashboard keeps rendering. A user whose deposit
 * shows as confirmed but was never credited, or whose balance is a fixed number lower than
 * their ledger says it should be, finds out by asking. This turns both into a command
 * with a non-zero exit code, so it can be run on a schedule or from a monitor.
 *
 * Read-only. It reports; it never repairs, because every repair here is a judgement about
 * money -- whether an uncredited confirmed deposit was really paid, and whether a balance
 * that does not match its ledger was reset by hand -- and those belong to whoever owns the
 * balance, not to a script.
 *
 * Usage:
 *   node scripts/audit-balance.js [--json] [--fail-on-warnings] [--check=<key>] [--help]
 */

const path = require('node:path');
const fs = require('node:fs');

/**
 * The .env files live next to the project root, not next to the current directory.
 *
 * Loading them by bare name -- `require('dotenv').config()` -- reads from `process.cwd()`,
 * which is the directory the shell happened to be in. That is correct when the script is
 * run as `npm run audit:balance` from the project root, and silently wrong when it is run
 * as `node scripts/audit-balance.js` from anywhere else. The failure is a database
 * connection attempt against an undefined URL, which surfaces as an ECONNREFUSED against
 * localhost rather than as "the .env was not found".
 */
const PROJECT_ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env.local') });
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

const pool = require('../src/config/db');

/**
 * How old an unsettled deposit must be before it is called stuck.
 *
 * Below this, a deposit the provider has not yet confirmed is the normal case, and
 * listing every one of them on every run would make the check useless noise.
 */
const STUCK_DEPOSIT_MINUTES = 30;

/**
 * How many entries of each finding are printed before the report truncates.
 * The count is always the true count; only the listing is bounded.
 */
const MAX_ENTRIES_PER_FINDING = 25;

/**
 * The order severity is reported in. `critical` first because the whole point of the
 * audit is to surface the checks that affect money before the ones that are merely
 * untidy. Within a severity, the checks appear in the order they are declared.
 */
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * One check per way the books can stop agreeing with themselves.
 *
 * `severity` is about the consequence for a user, not about how likely the cause is:
 * `critical` means money is missing or unaccounted for, `warning` means a record is
 * ambiguous, and `info` is context that makes the other findings easier to read.
 */
const CHECKS = [
    {
        key: 'balanceLedgerDrift',
        severity: 'critical',
        title: 'Balances that do not equal the cash ledger',
        why: 'A balance that differs from the sum of its own non-demo ledger rows means at ' +
            'least one write happened without its partner, or the balance was changed ' +
            'outside the app. The user is short by the difference.',
        sql: `SELECT u.id, u.email, u.balance,
                     COALESCE(c.total, 0) AS cash_ledger,
                     (u.balance - COALESCE(c.total, 0)) AS drift
              FROM users u
              LEFT JOIN (
                  SELECT user_id, SUM(amount) AS total
                  FROM balance_transactions
                  WHERE is_demo IS NOT TRUE
                  GROUP BY user_id
              ) c ON c.user_id = u.id
              WHERE u.balance <> COALESCE(c.total, 0)
              ORDER BY ABS(u.balance - COALESCE(c.total, 0)) DESC`,
        format: (r) => `user ${r.id} (${r.email}): balance ${r.balance}, ledger ${r.cash_ledger}, drift ${r.drift}`
    },
    {
        key: 'negativeBalances',
        severity: 'critical',
        title: 'Balances below zero',
        why: 'A negative balance is not a state the app can produce: every write is a ' +
            'debit that was checked against the balance first, or a credit that only ' +
            'adds. A negative value means the balance was changed outside the app, or a ' +
            'debit was written without the check it was supposed to have.',
        sql: `SELECT id, email, balance
              FROM users
              WHERE balance < 0
              ORDER BY balance ASC`,
        format: (r) => `user ${r.id} (${r.email}): balance ${r.balance}`
    },
    {
        key: 'confirmedWithoutCredit',
        severity: 'critical',
        title: 'Deposits shown as confirmed that were never credited',
        why: 'A confirmed deposit with no credit is a payment the user was told arrived and ' +
            'that never funded their balance. Reconciliation skips confirmed rows, so these ' +
            'stay broken until someone looks at them.',
        sql: `SELECT id, user_id, amount, asset_code, provider, provider_payment_id, created_at
              FROM deposits
              WHERE status = 'confirmed' AND credited_at IS NULL
              ORDER BY id`,
        format: (r) => `deposit ${r.id}: ${r.amount} ${r.asset_code} via ${r.provider} ` +
            `(${r.provider_payment_id ?? 'no provider id'}), created ${r.created_at}`
    },
    {
        key: 'creditedWithoutLedger',
        severity: 'critical',
        title: 'Credited deposits with no matching ledger entry',
        why: 'The balance moved with nothing recording why. Nothing can reconcile against it ' +
            'and any retry of the same payment would be blocked by a claim it cannot verify.',
        // The comparison is built from the deposit's own `provider` column rather than
        // trying both prefixes: `source_id` is written as `{provider}:{payment_id}` by
        // the crediting path, so that is the value to look for. A NULL payment_id is
        // excluded here because the concatenation is NULL and the comparison cannot be
        // meaningful; a credited deposit with no payment_id is a separate anomaly that
        // the `stuckDeposits` and `confirmedWithoutCredit` checks do not cover.
        sql: `SELECT d.id, d.user_id, d.amount, d.asset_code, d.provider, d.credited_at
              FROM deposits d
              WHERE d.credited_at IS NOT NULL
                AND d.provider_payment_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM balance_transactions b
                    WHERE b.transaction_type = 'deposit'
                      AND b.source_id = d.provider || ':' || d.provider_payment_id
                )
              ORDER BY d.id`,
        format: (r) => `deposit ${r.id}: ${r.amount} ${r.asset_code} via ${r.provider} credited at ${r.credited_at}`
    },
    {
        key: 'orphanDepositLedger',
        severity: 'critical',
        title: 'Deposit ledger entries with no credited deposit',
        why: 'Money was recorded as arriving for a payment this database does not show as ' +
            'credited. Either a credit was rolled back and the ledger row was not, or the ' +
            'entry was written by something other than the crediting path.',
        sql: `SELECT b.id, b.user_id, b.amount, b.source_id, b.created_at
              FROM balance_transactions b
              WHERE b.transaction_type = 'deposit' AND b.is_demo IS NOT TRUE
                AND NOT EXISTS (
                    SELECT 1 FROM deposits d
                    WHERE d.credited_at IS NOT NULL
                      AND d.provider_payment_id IS NOT NULL
                      AND b.source_id = d.provider || ':' || d.provider_payment_id
                )
              ORDER BY b.id`,
        format: (r) => `ledger ${r.id}: ${r.amount} for ${r.source_id} at ${r.created_at}`
    },
    {
        key: 'unreversedWithdrawals',
        severity: 'critical',
        title: 'Withdrawn funds that were never returned',
        why: 'The balance is debited when a withdrawal is requested. A withdrawal that ended ' +
            'without being paid and was not refunded took the money permanently.',
        sql: `SELECT w.id, w.user_id, w.amount, w.payment_method, w.status,
                     w.failure_reason, w.created_at, w.paid_at
              FROM withdrawals w
              WHERE w.status IN ('failed', 'cancelled')
                AND NOT EXISTS (
                    SELECT 1 FROM balance_transactions b
                    WHERE b.transaction_type = 'refund'
                      AND b.source_id = 'withdrawal:' || w.id::TEXT
                )
              ORDER BY w.id`,
        format: (r) => `withdrawal ${r.id}: ${r.amount} (${r.payment_method}) ended ${r.status}` +
            `${r.failure_reason ? ` -- ${r.failure_reason}` : ' with no reason recorded'}`
    },
    {
        key: 'withdrawalsWithoutDebit',
        severity: 'critical',
        title: 'Withdrawals with no matching debit on the ledger',
        why: 'The balance is debited the moment a withdrawal is requested, and a ledger row ' +
            'records why. A withdrawal row with no debit means either the balance was ' +
            'never reduced for a request the user believes was made, or the debit was ' +
            'written without the ledger row that would let it be accounted for.',
        // The debit is written as `transaction_type = 'withdrawal'` with `source_id =
        // <withdrawal id>`. The refund, when it happens, is a separate `refund` row, so
        // a refunded withdrawal still has its withdrawal debit and is not caught here.
        sql: `SELECT w.id, w.user_id, w.amount, w.payment_method, w.status, w.created_at
              FROM withdrawals w
              WHERE NOT EXISTS (
                  SELECT 1 FROM balance_transactions b
                  WHERE b.transaction_type = 'withdrawal'
                    AND b.source_id = w.id::TEXT
              )
              ORDER BY w.id`,
        format: (r) => `withdrawal ${r.id}: ${r.amount} (${r.payment_method}, ${r.status}) ` +
            `requested ${r.created_at} has no debit row`
    },
    {
        key: 'refundWithoutFailedWithdrawal',
        severity: 'critical',
        title: 'Refund ledger entries with no failed withdrawal behind them',
        why: 'A refund credits the balance back for a withdrawal that was not paid. If the ' +
            'withdrawal it names is not in a failed state, the credit is money that was ' +
            'added without the corresponding reservation being closed -- either a ' +
            'double-refund or a refund written for the wrong row.',
        sql: `SELECT b.id, b.user_id, b.amount, b.source_id, b.created_at
              FROM balance_transactions b
              WHERE b.transaction_type = 'refund'
                AND b.source_id LIKE 'withdrawal:%'
                AND NOT EXISTS (
                    SELECT 1 FROM withdrawals w
                    WHERE 'withdrawal:' || w.id::TEXT = b.source_id
                      AND w.status IN ('failed', 'cancelled')
                )
              ORDER BY b.id`,
        format: (r) => `ledger ${r.id}: refund ${r.amount} for ${r.source_id} at ${r.created_at}`
    },
    {
        key: 'unprovablePaidWithdrawals',
        severity: 'warning',
        title: 'Withdrawals marked paid with nothing to prove it',
        why: 'A paid withdrawal with no provider reference cannot be checked against a ' +
            'provider dashboard or a bank statement. If the money did not arrive there is ' +
            'no way to tell, and no way to correct it without a support ticket.',
        sql: `SELECT id, user_id, amount, payment_method, provider_reference, paid_at
              FROM withdrawals
              WHERE status = 'paid' AND (provider_reference IS NULL OR paid_at IS NULL)
              ORDER BY id`,
        format: (r) => {
            const missing = [
                r.provider_reference ? null : 'no provider reference',
                r.paid_at ? null : 'no paid_at'
            ].filter(Boolean).join(' and ');
            return `withdrawal ${r.id}: ${r.amount} (${r.payment_method}) is marked paid but has ${missing}`;
        }
    },
    {
        key: 'unresolvedWithdrawals',
        severity: 'warning',
        title: 'Withdrawals still awaiting a decision',
        why: 'Not an error: the money is reserved and the request is legitimate. Listed ' +
            'because an undecided withdrawal is a user waiting on an answer, and the longer ' +
            'it sits the more likely it has been chased.',
        sql: `SELECT id, user_id, amount, payment_method, created_at
              FROM withdrawals
              WHERE status IN ('pending', 'processing')
              ORDER BY created_at ASC`,
        format: (r) => `withdrawal ${r.id}: ${r.amount} (${r.payment_method}) requested ${r.created_at}`
    },
    {
        key: 'stuckDeposits',
        severity: 'warning',
        title: 'Deposits waiting on a provider that has not reported back',
        why: 'A deposit the user is watching does not move because no callback arrived. Each ' +
            'of these is one more callback that has to be caught by reconciliation.',
        sql: `SELECT id, user_id, amount, asset_code, status, created_at
              FROM deposits
              WHERE credited_at IS NULL
                AND status IN ('pending', 'confirming')
                AND created_at < NOW() - ($1::int * INTERVAL '1 minute')
              ORDER BY created_at`,
        params: [STUCK_DEPOSIT_MINUTES],
        format: (r) => `deposit ${r.id}: ${r.amount} ${r.asset_code} has been ${r.status} since ${r.created_at}`
    }
];

const CHECK_KEYS = new Set(CHECKS.map((c) => c.key));

const HELP = `Usage: node scripts/audit-balance.js [options]

Runs every balance-integrity check and reports anything it finds. Read-only: it never
modifies the database, only reports what is inconsistent.

Options:
  --json                    Print machine-readable JSON instead of a text report
  --fail-on-warnings        Exit non-zero when warnings are found (default: only criticals)
  --check=<key>             Run only the named check
  --list                    Print the key of every check, then exit
  --help, -h                Print this message

Exit codes:
  0  Every check clean, or warnings only without --fail-on-warnings
  1  A critical check found something, or a warning did under --fail-on-warnings
  2  The audit could not run (database unreachable, bad --check value, or a crash)

Available checks:
${CHECKS.map((c) => `  ${c.severity.padEnd(8)} ${c.key.padEnd(30)} ${c.title}`).join('\n')}
`;

/**
 * Runs the audit. `only` restricts it to a single check by key, which is what a
 * monitor or an operator wants when only one line of the report has changed.
 */
async function runAudit({ only = null } = {}) {
    const selected = only ? CHECKS.filter((c) => c.key === only) : CHECKS;
    if (only && selected.length === 0) {
        throw new Error(`Unknown check "${only}". Known: ${[...CHECK_KEYS].join(', ')}.`);
    }

    const findings = [];
    for (const check of selected) {
        const result = await pool.query(check.sql, check.params ?? []);
        findings.push({
            key: check.key,
            severity: check.severity,
            title: check.title,
            why: check.why,
            count: result.rows.length,
            entries: result.rows.slice(0, MAX_ENTRIES_PER_FINDING).map(check.format),
            truncated: result.rows.length > MAX_ENTRIES_PER_FINDING
        });
    }
    return findings;
}

/**
 * Orders findings by severity, then by the count of affected rows.
 *
 * The report is read top-down and the reader stops at the first thing that matters. A
 * critical with one affected user is more urgent than a warning with twenty, and the
 * default order -- the order the checks happen to be declared in -- put the summary at
 * the bottom regardless.
 */
function orderFindings(findings) {
    return [...findings].sort((a, b) => {
        const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
        if (bySeverity !== 0) return bySeverity;
        return b.count - a.count;
    });
}

function renderText(findings) {
    const lines = [];
    const ordered = orderFindings(findings);
    const problems = ordered.filter((f) => f.count > 0);

    for (const finding of problems) {
        lines.push(`${finding.severity.toUpperCase()}  ${finding.title} (${finding.count})`);
        lines.push(`        ${finding.why}`);
        for (const entry of finding.entries) lines.push(`        - ${entry}`);
        if (finding.truncated) {
            lines.push(`        - ...and ${finding.count - finding.entries.length} more`);
        }
        lines.push('');
    }

    const clean = findings.length - problems.length;
    lines.push(`${clean}/${findings.length} checks clean.`);

    if (problems.length === 0) {
        lines.push('Balances reconcile with the ledger. Nothing to do.');
        return lines.join('\n');
    }

    const critical = problems.filter((f) => f.severity === 'critical').length;
    const warnings = problems.filter((f) => f.severity === 'warning').length;
    if (critical > 0) {
        lines.push(`${critical} critical check(s) affect money and need a decision.`);
    }
    if (warnings > 0) {
        lines.push(`${warnings} warning check(s) need a review but no money is unaccounted for.`);
    }
    return lines.join('\n');
}

function readOption(name) {
    const prefix = `--${name}=`;
    const match = process.argv.find((argument) => argument.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
}

/**
 * Uses the pool's own error formatter when it has one.
 *
 * A connection failure is reported by Node as an `AggregateError` whose `message` is the
 * empty string, with the useful detail on `errors`. `error.message` therefore prints as a
 * blank line, which reads as "the audit crashed for no reason" rather than "the database
 * is unreachable". The pool carries a `describeError` that walks the error and its
 * causes, and this uses it when present so the failure is legible.
 */
function describeError(error) {
    if (typeof pool.describeError === 'function') return pool.describeError(error);
    return error?.message || String(error);
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(HELP);
        return;
    }

    if (process.argv.includes('--list')) {
        console.log(CHECKS.map((c) => `${c.severity}\t${c.key}\t${c.title}`).join('\n'));
        return;
    }

    const asJson = process.argv.includes('--json');
    // `--fail-on-warnings` opts into exiting non-zero on warnings as well as
    // criticals. Off by default: a scheduled job that only wants to hear about
    // missing money should be able to ignore a pending withdrawal, and a job
    // that treats every warning as a page would page on the fact that someone
    // asked for their balance. Both behaviours are legitimate; the flag is how
    // the caller says which one they want.
    const failOnWarnings = process.argv.includes('--fail-on-warnings');
    const only = readOption('check');

    let findings;
    try {
        findings = await runAudit({ only });
    } catch (error) {
        const message = describeError(error);
        console.error(`Balance audit could not run: ${message}`);
        if (asJson) {
            // Printed even on failure so a script that parses stdout gets a well-formed
            // document either way, and can branch on `ok` instead of on the exit code.
            console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        }
        process.exitCode = 2;
        return;
    }

    if (asJson) {
        console.log(JSON.stringify({ ok: true, findings }, null, 2));
    } else {
        console.log(renderText(findings));
    }

    const critical = findings.some((f) => f.count > 0 && f.severity === 'critical');
    const warning = findings.some((f) => f.count > 0 && f.severity === 'warning');

    // A non-zero exit makes this usable as a scheduled check:
    //   0 -- clean, or warnings-only when --fail-on-warnings was not passed
    //   1 -- something needs attention
    //   2 -- the audit itself could not run, so a broken database is never
    //        reported as a clean ledger
    process.exitCode = (critical || (failOnWarnings && warning)) ? 1 : 0;
}

if (require.main === module) {
    main()
        .catch((error) => {
            console.error('Balance audit crashed:', describeError(error));
            process.exitCode = 2;
        })
        .finally(() => pool.end().catch(() => {}));
}

module.exports = { CHECKS, runAudit, renderText };