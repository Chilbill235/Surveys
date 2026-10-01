/**
 * Row answers for the reads the money-email notifications add to a query.
 *
 * Every test that stubs the pool does it with a long chain of `if (/regex/.test(sql))` and
 * ends in `throw new Error('Unexpected test query')`. That is the right design -- an
 * unrecognised query *should* fail loudly -- but it means any read the notification path adds
 * breaks every stub at once, and the notification swallows the failure in its own try/catch.
 * The result is a green test run in which no deposit receipt is ever sent, which is exactly
 * the bug a test is supposed to catch.
 *
 * So the notification's reads are answered from one place, and every stub delegates here.
 * Adding a column to those queries is then a one-line change in one file instead of an
 * eight-file sweep, and a stub that has *not* been updated fails with a message naming this
 * helper rather than a raw SQL string nobody will recognise.
 */

const EMAIL = 'depositor@example.com';

/** The two shapes: the bare user lookup, and the deposit joined to its owner. */
const PATTERNS = [
    /SELECT\s+email,\s*balance,\s*money_emails_enabled\s+FROM\s+users/i,
    /FROM\s+deposits\s+d\s+JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*d\.user_id/i,
    // The durable notification write, answered here for the same reason as the reads above. It is
    // recorded through `recordInBackground`, which swallows its own failures, so a stub that does
    // not answer this insert produces a green run in which no notification is ever written --
    // the failure the notification path is supposed to catch.
    /INSERT\s+INTO\s+notifications/i
];

/**
 * Returns a stub result for a notification read, or `null` if the query is not one.
 *
 * @param {string} query The SQL as the code issued it.
 * @param {{ balance?: string|number, depositId?: number|bigint }} [options] Values the
 *   answer should reflect, so a test can assert on a receipt that names a real amount.
 * @returns {{ rows: object[] }|null}
 */
function notificationRows(query, options = {}) {
    const text = String(query || '');
    if (!PATTERNS.some((pattern) => pattern.test(text))) return null;

    const balance = options.balance !== undefined ? String(options.balance) : '0.00';

    // The insert is `ON CONFLICT ... RETURNING *`, and the conflict path returns no rows. A row
    // is returned here so a caller that needs the new id gets one, which is the normal path.
    if (/INSERT\s+INTO\s+notifications/i.test(text)) {
        return {
            rows: [{
                id: options.notificationId !== undefined ? options.notificationId : 1,
                category: null,
                tone: 'info',
                title: null,
                message: null,
                href: null,
                record_id: null,
                read_at: null,
                created_at: '2026-09-30T12:00:00.000Z'
            }]
        };
    }

    if (/JOIN\s+users/i.test(text)) {
        return {
            rows: [{
                id: options.depositId !== undefined ? options.depositId : 1,
                provider: 'nowpayments',
                asset_code: 'usdt',
                network: 'tron',
                amount: '3.00',
                status: 'confirmed',
                provider_payment_id: 'pay-test-1',
                email: EMAIL,
                balance,
                money_emails_enabled: true
            }]
        };
    }

    return { rows: [{ email: EMAIL, balance, money_emails_enabled: true }] };
}

module.exports = { notificationRows, NOTIFICATION_TEST_EMAIL: EMAIL };
