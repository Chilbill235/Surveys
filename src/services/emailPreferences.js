const pool = require('../config/db');

/**
 * The one place that decides whether a money notification may be sent.
 *
 * Two kinds of transactional mail exist, and only one of them is optional:
 *
 *   - **Security and authorisation.** Email verification, password reset, and the withdrawal
 *     confirmation code. Each one is a step the user has to complete: no verification mail
 *     means no confirmed account, no reset mail means no way back in, and no withdrawal code
 *     means no way to finish a withdrawal. These are sent unconditionally and never consult
 *     this module. There is no state in which suppressing them helps anyone.
 *
 *   - **Money notifications.** Deposit instructions, deposit credited, deposit failed,
 *     withdrawal started, withdrawal sent, withdrawal refunded. These are receipts and
 *     progress updates. The account page renders all of them, so a user who switches them
 *     off loses the copy in their inbox and keeps the record in the app. That is the line
 *     the switch sits on, and it is why the module is named for money rather than for email.
 *
 * Reads fail **open**: a database that cannot be reached is treated as "send it". The
 * alternative is that a brief outage during a withdrawal quietly suppresses the one message
 * telling the user their money is on its way, and the failure is invisible because nothing
 * throws. An unwanted receipt is a nuisance; a missing receipt for a completed withdrawal is
 * the kind of thing that becomes a chargeback.
 */

/** The column, named once so a rename is a single edit rather than a grep. */
const COLUMN = 'money_emails_enabled';

/**
 * Normalises a raw column value to the decision the callers act on.
 *
 * `null` and `undefined` mean the column was not selected -- a query that has not been
 * updated, or a row joined from a table that does not carry it -- and are treated as
 * enabled. A missing value must not read as a refusal to send: the safe reading of "we do not
 * know" for a message the user asked for is "send it", not "silently drop it".
 */
function isMoneyEmailEnabled(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'boolean') return value;
    // node-postgres hands back a real boolean for BOOLEAN, but a numeric or text column
    // would arrive as 'f' / 'false' / '0'. Those are the values a hand-edited column or a
    // different driver produce, and treating them as `true` would quietly ignore the opt-out.
    const normalised = String(value).trim().toLowerCase();
    if (normalised === 'f' || normalised === 'false' || normalised === '0' || normalised === 'no' || normalised === 'off') {
        return false;
    }
    return true;
}

/**
 * The current setting for one user, defaulting to enabled.
 *
 * Returns rather than throws: every caller is an email path that is already inside a
 * try/catch whose job is to report a missing message, and a thrown read here would be
 * reported as a send failure when nothing was ever attempted.
 */
async function loadMoneyEmailPreference(userId) {
    try {
        const result = await pool.query(
            `SELECT ${COLUMN} FROM users WHERE id = $1`,
            [userId]
        );
        return isMoneyEmailEnabled(result.rows[0]?.[COLUMN]);
    } catch (error) {
        console.error(`Email preference for user ${userId} could not be read (${error.message}); sending anyway.`);
        return true;
    }
}

/**
 * Writes the setting.
 *
 * Returns the value actually stored, read back from the row rather than echoed from the
 * argument, so a caller that reports the new state to the user is reporting what the
 * database holds. Returns `null` when there is no such user.
 */
async function setMoneyEmailPreference(userId, enabled) {
    // No `updated_at`. `users` has no such column -- `created_at` is the only timestamp on
    // it, and every other write to the table names the columns it means to change. The
    // column exists on `deposits` and `withdrawals`, which is where the assumption came
    // from, and writing it here fails every save with
    // `column "updated_at" of relation "users" does not exist`.
    const result = await pool.query(
        `UPDATE users SET ${COLUMN} = $1 WHERE id = $2 RETURNING ${COLUMN}`,
        [Boolean(enabled), userId]
    );
    if (result.rows.length === 0) return null;
    return isMoneyEmailEnabled(result.rows[0][COLUMN]);
}

/**
 * The shape returned to the client, so the page does not hardcode the policy.
 *
 * `alwaysOn` is spelled out rather than left implicit because the page has to be able to say
 * *which* mail is unaffected by the switch. Telling a user "some email always arrives"
 * without saying which is the kind of statement that produces a support ticket.
 */
function describePolicy() {
    return {
        alwaysOn: [
            { key: 'verify', label: 'Confirm your email address' },
            { key: 'reset', label: 'Reset your password' },
            { key: 'withdrawal-code', label: 'The code that authorises a withdrawal' }
        ],
        switchable: [
            { key: 'deposit-instructions', label: 'Deposit instructions, with the address and amount to send' },
            { key: 'deposit-confirmed', label: 'A receipt when a deposit lands' },
            { key: 'deposit-failed', label: 'Notice when a deposit does not go through' },
            { key: 'withdrawal-started', label: 'Notice when a withdrawal is sent to the blockchain' },
            { key: 'withdrawal-sent', label: 'A receipt when a withdrawal is confirmed' },
            { key: 'withdrawal-refunded', label: 'Notice when a withdrawal is returned to your balance' }
        ]
    };
}

module.exports = {
    COLUMN,
    isMoneyEmailEnabled,
    loadMoneyEmailPreference,
    setMoneyEmailPreference,
    describePolicy
};
