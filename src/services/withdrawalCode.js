const { createHash, randomInt, timingSafeEqual } = require('node:crypto');
const pool = require('../config/db');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { sendEmail, isEmailConfigured } = require('./mailer');

/**
 * Confirms a withdrawal with a code sent to the account's own address.
 *
 * A balance session is on its own enough to move money: the bearer token authorises the payout
 * and it lives in `sessionStorage`, where one successful script injection reads it. This adds
 * the second factor that the rest of the money-moving surface lacks -- signing in proves who
 * you are once, and until it expires it proves it again and again, indefinitely.
 *
 * The code is bound to the amount and the destination that were actually displayed when it was
 * sent. That is the part that makes it worth more than a second signature of the same request:
 * without it, a code obtained to authorise a $1 test withdrawal would authorise a $10,000
 * payout to an address chosen afterwards, which is precisely the case the check exists to stop.
 *
 * The comparison itself mirrors `verificationEmail` deliberately: same code length, same
 * lifetime, same attempt budget, same constant-time compare, and a distinct pepper so a hash
 * lifted from this table cannot be replayed against the email-verification one.
 */

const CODE_LENGTH = 6;
const CODE_PATTERN = /^\d{6}$/;
const CODE_LIFETIME_MINUTES = 10;

/**
 * Five guesses, then the code dies.
 *
 * The same budget as email verification, for the same reason: a million possibilities against
 * five attempts is not a search, and a real person mistypes a digit maybe twice.
 */
const MAX_ATTEMPTS = 5;

/** A fresh code, uniform over the whole range so leading zeros are as likely as anything else. */
function generateCode() {
    return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/** Separate pepper from email verification, so one table's hashes cannot be replayed into the other. */
function hashCode(code, userId) {
    const pepper = process.env.WITHDRAWAL_VERIFICATION_PEPPER || process.env.JWT_SECRET || '';
    return createHash('sha256')
        .update(`${pepper}:withdrawal:${userId}:${code}`)
        .digest('hex');
}

/** Constant-time comparison of a submitted code against a stored hash. */
function codeMatches(submittedCode, storedHash, userId) {
    if (!CODE_PATTERN.test(String(submittedCode || ''))) return false;
    const stored = Buffer.from(String(storedHash || ''), 'hex');
    if (stored.length !== 32) return false;
    const expected = Buffer.from(hashCode(String(submittedCode), userId), 'hex');
    return expected.length === stored.length && timingSafeEqual(expected, stored);
}

/**
 * Issues a code for a specific amount and destination, replacing any outstanding one.
 *
 * The insert is upsert-on-partial-unique rather than delete-then-insert, because two requests
 * arriving together would otherwise each delete the other's row and both succeed, leaving two
 * valid codes for one account.
 */
async function issueWithdrawalCode({ userId, amount, destination, email }) {
    const code = generateCode();
    // Atomically replaces any outstanding code. The partial unique index is what this upserts
    // against, so the replace and the "only one live" rule are enforced by the same statement.
    //
    // The obvious DELETE-then-INSERT is not equivalent and was not safe here: two requests
    // arriving together both see no row, both insert, and the second one trips the unique index
    // and surfaces as a 503 -- the user clicks "send another code" twice, quickly, and gets an
    // error for the first code having been silently overwritten by the second.
    //
    // `attempts = 0` because a replacement is a new code, not a continuation of the old one: it
    // would otherwise inherit a nearly-spent budget and be refused before a single real guess.
    const inserted = await pool.query(
        `INSERT INTO withdrawal_verification_codes (user_id, amount, destination, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::INTERVAL)
         ON CONFLICT (user_id) WHERE consumed_at IS NULL
         DO UPDATE SET amount = EXCLUDED.amount,
                       destination = EXCLUDED.destination,
                       code_hash = EXCLUDED.code_hash,
                       attempts = 0,
                       expires_at = EXCLUDED.expires_at,
                       created_at = NOW()
         RETURNING id`,
        [userId, amount, String(destination).slice(0, 128), hashCode(code, userId), String(CODE_LIFETIME_MINUTES)]
    );
    if (inserted.rows.length === 0) {
        // The conflict target is partial, so a row that is present but already consumed does not
        // match it and this insert would have created a second row. That is not a state this
        // schema permits, so it is a real fault rather than something to paper over.
        throw new Error(`Could not issue a withdrawal code for user ${userId}: insert returned no row.`);
    }
    return { code, email };
}

/**
 * Consumes a code, returning `{ ok }` and, on failure, why.
 *
 * `reason` is deliberately coarse. It goes to an authenticated account holder who already knows
 * they own the address, so naming the problem costs nothing and saves a support conversation.
 * It is not a timing oracle: the code comparison itself is constant-time.
 */
async function consumeWithdrawalCode({ userId, code, amount, destination }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Locked, so two concurrent withdrawals cannot both spend the same code. Without the
        // lock both read the row before either marks it consumed, and the check is bypassable
        // with a single replayed request.
        const found = await client.query(
            `SELECT id, code_hash, attempts, expires_at, amount, destination
               FROM withdrawal_verification_codes
              WHERE user_id = $1 AND consumed_at IS NULL
              FOR UPDATE`,
            [userId]
        );

        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'missing' };
        }

        const row = found.rows[0];

        if (new Date(row.expires_at).getTime() <= Date.now()) {
            await client.query('DELETE FROM withdrawal_verification_codes WHERE id = $1', [row.id]);
            await client.query('COMMIT');
            return { ok: false, reason: 'expired' };
        }

        // The code is bound to what it was issued for. A code for a different amount or a
        // different destination is not a near miss, it is a code for a different withdrawal, so
        // it does not consume the attempt budget either -- otherwise an attacker holding a code
        // for their own $1 withdrawal could burn the victim's live code by guessing amounts.
        const sameAmount = Number(row.amount) === Number(amount);
        const sameDestination = String(row.destination) === String(destination).slice(0, 128);
        if (!sameAmount || !sameDestination) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'different' };
        }

        if (row.attempts >= MAX_ATTEMPTS) {
            await client.query('DELETE FROM withdrawal_verification_codes WHERE id = $1', [row.id]);
            await client.query('COMMIT');
            return { ok: false, reason: 'exhausted' };
        }

        if (!codeMatches(code, row.code_hash, userId)) {
            const bumped = await client.query(
                `UPDATE withdrawal_verification_codes
                    SET attempts = attempts + 1
                  WHERE id = $1 AND consumed_at IS NULL
                  RETURNING attempts`,
                [row.id]
            );
            const attempts = bumped.rows[0]?.attempts ?? row.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
                // Destroyed on the last guess, so the real code stops working too. Otherwise a
                // patient attacker would get unlimited tries against a live code.
                await client.query('DELETE FROM withdrawal_verification_codes WHERE id = $1', [row.id]);
                await client.query('COMMIT');
                return { ok: false, reason: 'exhausted' };
            }
            await client.query('COMMIT');
            return { ok: false, reason: 'wrong' };
        }

        await client.query(
            `UPDATE withdrawal_verification_codes SET consumed_at = NOW() WHERE id = $1`,
            [row.id]
        );
        await client.query('COMMIT');
        return { ok: true };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/** Drops any outstanding code, e.g. after a withdrawal succeeds or the user changes their mind. */
async function clearWithdrawalCode(userId) {
    await pool.query(`DELETE FROM withdrawal_verification_codes WHERE user_id = $1`, [userId]);
}

const FAILURE_MESSAGES = {
    missing: 'Confirm this withdrawal with the code we emailed you.',
    expired: 'That code has expired. Send yourself a new one.',
    different: 'That code was issued for a different amount or destination. Send yourself a new one.',
    exhausted: 'Too many incorrect codes. Send yourself a new one.',
    wrong: 'That code is not correct.'
};

function failureMessage(reason) {
    return FAILURE_MESSAGES[reason] || FAILURE_MESSAGES.missing;
}

/** The message that carries the code. Says what the code is for, so it cannot be mistaken. */
function buildMessage({ code, amount, destination, methodLabel }) {
    const blocks = [
        { type: 'code', value: code },
        { type: 'details', items: [
            { label: 'Amount', value: `$${Number(amount).toFixed(2)}` },
            { label: 'Going to', value: String(destination).slice(0, 60) },
            { label: 'Method', value: methodLabel }
        ] },
        { type: 'callout', tone: 'neutral', text: `This code expires in ${CODE_LIFETIME_MINUTES} minutes and can only be used for this withdrawal.` },
        { type: 'paragraph', text: 'If you did not ask to withdraw money, ignore this message and change your account password.' }
    ];

    const shared = {
        heading: 'Confirm your withdrawal',
        intro: `Enter this code to move $${Number(amount).toFixed(2)} out of your account.`,
        blocks
    };

    return {
        subject: `Confirm a $${Number(amount).toFixed(2)} withdrawal`,
        text: renderEmailText(shared),
        html: renderEmail({
            preheader: `${code} confirms your $${Number(amount).toFixed(2)} withdrawal.`,
            ...shared
        })
    };
}

async function sendWithdrawalCodeEmail({ to, code, amount, destination, methodLabel }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal confirmation email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }
    const message = buildMessage({ code, amount, destination, methodLabel });
    return sendEmail({ to, ...message });
}

module.exports = {
    generateCode,
    hashCode,
    codeMatches,
    issueWithdrawalCode,
    consumeWithdrawalCode,
    clearWithdrawalCode,
    failureMessage,
    sendWithdrawalCodeEmail,
    CODE_PATTERN,
    CODE_LIFETIME_MINUTES,
    MAX_ATTEMPTS
};
