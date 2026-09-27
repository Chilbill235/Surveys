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
 * Usage: `npm run audit:balance [-- --json]`
 */
require('dotenv').config();
const pool = require('../src/config/db');

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
                  WHERE NOT is_demo
                  GROUP BY user_id
              ) c ON c.user_id = u.id
              WHERE u.balance <> COALESCE(c.total, 0)
              ORDER BY ABS(u.balance - COALESCE(c.total, 0)) DESC`,
        format: (r) => `user ${r.id} (${r.email}): balance ${r.balance}, ledger ${r.cash_ledger}, drift ${r.drift}`
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
            `(${r.provider_payment_id}), created ${r.created_at}`
    },
    {
        key: 'creditedWithoutLedger',
        severity: 'critical',
        title: 'Credited deposits with no matching ledger entry',
        why: 'The balance moved with nothing recording why. Nothing can reconcile against it ' +
            'and any retry of the same payment would be blocked by a claim it cannot verify.',
        sql: `SELECT d.id, d.user_id, d.amount, d.asset_code, d.credited_at
              FROM deposits d
              WHERE d.credited_at IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM balance_transactions b
                    WHERE b.transaction_type = 'deposit'
                      AND b.source_id IN ('nowpayments:' || d.provider_payment_id,
                                          'stripe:' || d.provider_payment_id)
                )
              ORDER BY d.id`,
        format: (r) => `deposit ${r.id}: ${r.amount} ${r.asset_code} credited at ${r.credited_at}`
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
              WHERE b.transaction_type = 'deposit' AND NOT b.is_demo
                AND NOT EXISTS (
                    SELECT 1 FROM deposits d
                    WHERE d.credited_at IS NOT NULL
                      AND b.source_id IN ('nowpayments:' || d.provider_payment_id,
                                          'stripe:' || d.provider_payment_id)
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
        format: (r) => `withdrawal ${r.id}: ${r.amount} (${r.payment_method}) is marked paid but has ` +
            `${[r.provider_reference ? null : 'no provider reference', r.paid_at ? null : 'no paid_at']
                .filter(Boolean).join(' and ')}`
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
                AND created_at < NOW() - INTERVAL '30 minutes'
              ORDER BY created_at`,
        format: (r) => `deposit ${r.id}: ${r.amount} ${r.asset_code} has been ${r.status} since ${r.created_at}`
    }
];

async function runAudit() {
    const findings = [];
    for (const check of CHECKS) {
        const result = await pool.query(check.sql);
        findings.push({
            key: check.key,
            severity: check.severity,
            title: check.title,
            why: check.why,
            count: result.rows.length,
            entries: result.rows.slice(0, 25).map(check.format),
            truncated: result.rows.length > 25
        });
    }
    return findings;
}

function renderText(findings) {
    const lines = [];
    for (const finding of findings) {
        if (finding.count === 0) continue;
        lines.push(`${finding.severity.toUpperCase()}  ${finding.title} (${finding.count})`);
        lines.push(`        ${finding.why}`);
        for (const entry of finding.entries) lines.push(`        - ${entry}`);
        if (finding.truncated) {
            lines.push(`        - ...and ${finding.count - finding.entries.length} more`);
        }
        lines.push('');
    }
    const clean = findings.filter((f) => f.count === 0);
    const problems = findings.filter((f) => f.count > 0);
    lines.push(`${clean.length}/${findings.length} checks clean.`);
    if (problems.length === 0) {
        lines.push('Balances reconcile with the ledger. Nothing to do.');
    } else {
        const critical = problems.filter((f) => f.severity === 'critical');
        lines.push(critical.length > 0
            ? `${critical.length} check(s) affect money and need a decision.`
            : 'Only warnings: no money is unaccounted for.');
    }
    return lines.join('\n');
}

async function main() {
    const asJson = process.argv.includes('--json');
    let findings;
    try {
        findings = await runAudit();
    } catch (error) {
        console.error(`Balance audit could not run: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    if (asJson) {
        console.log(JSON.stringify({ ok: true, findings }, null, 2));
    } else {
        console.log(renderText(findings));
    }
    // A non-zero exit makes this usable as a scheduled check: 1 for something that needs
    // attention, 0 for clean, 2 for "the audit itself could not run" so a broken database
    // is never reported as a clean ledger.
    process.exitCode = findings.some((f) => f.count > 0 && f.severity === 'critical') ? 1 : 0;
}

if (require.main === module) {
    main()
        .catch((error) => {
            console.error('Balance audit crashed:', error);
            process.exitCode = 2;
        })
        .finally(() => pool.end().catch(() => {}));
}

module.exports = { CHECKS, runAudit, renderText };
