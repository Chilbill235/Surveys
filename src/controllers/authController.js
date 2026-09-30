const { promisify } = require('node:util');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { consumeRateLimit } = require('../services/security');
const { sendPasswordResetEmail } = require('../services/resetEmail');
const { sendWelcomeEmail, sendAccountVerifiedEmail } = require('../services/accountEmails');
const mailer = require('../services/mailer');
const {
    generateCode,
    hashCode,
    codeMatches,
    sendVerificationEmail,
    CODE_PATTERN,
    CODE_LIFETIME_MINUTES,
    MAX_ATTEMPTS
} = require('../services/verificationEmail');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');
const { sendMagicLinkEmail } = require('../services/magicLinkEmail');
const passkeys = require('../services/passkeys');

const scryptAsync = promisify(scrypt);

const MAGIC_LINK_WINDOW_MINUTES = 15;

/**
 * Sending a magic link is rated per address and per IP, on the same terms as asking for a
 * new verification code.
 *
 * This endpoint sends a real message to a real inbox, so an unlimited one is an
 * unauthenticated way to bury someone's mail and to spend the provider's quota, either by
 * hammering one address or by walking a list of them. The limit is consumed before the
 * address is looked up, so crossing it tells an attacker nothing about whether the account
 * exists.
 */
const MAGIC_LINK_LIMIT_PER_ADDRESS = 3;
const MAGIC_LINK_LIMIT_PER_IP = 10;
const MAGIC_LINK_LIMIT_WINDOW_SECONDS = 15 * 60;

/**
 * One message for every failed verification, whatever the reason.
 *
 * A more specific reply would be a better experience and a worse system: distinguishing
 * "no account", "already confirmed", "expired" and "wrong code" tells an attacker which
 * addresses are registered and how far a guess got. The recovery path for a real user is the
 * resend button, which is one click either way.
 */
const VERIFICATION_FAILED_MESSAGE =
    'That code is not valid. Check the newest email, or request a new code.';

/** New codes per address per window. Enough for a real person, not enough to bury an inbox. */
/** How many times one address may ask for a fresh code, and how often. */
const RESEND_CODE_LIMIT_PER_ADDRESS = 3;
const RESEND_CODE_LIMIT_PER_IP = 10;
const RESEND_CODE_WINDOW_SECONDS = 15 * 60;

/**
 * Whether email can be sent at all.
 *
 * Checked before an account is created rather than after, because a deployment without this
 * cannot confirm anyone: registration would "succeed", the user would wait for a code that
 * never came, and the account they just made would be permanently unusable.
 *
 * Read from the shared mailer rather than from a provider key here, so the check follows
 * whichever provider is configured instead of hard-coding one that may no longer be in use.
 */
function isEmailConfigured() {
    return mailer.isEmailConfigured();
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;

/**
 * A fixed salt used only on the "no such account" path, so the scrypt call that
 * burns time there cannot be distinguished from a real verification by a timing
 * observer. The value is arbitrary; only the work matters.
 */
const DUMMY_SCRYPT_SALT = 'offer-network-missing-account';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_LIFETIME_MINUTES = 60;
const RESET_TOKEN_HEX_PATTERN = /^[\da-f]{64}$/i;

const RESET_WINDOW_SECONDS = 15 * 60;
const RESET_LIMIT_PER_EMAIL = 3;
const RESET_LIMIT_PER_IP = 10;
const RESET_LIMIT_PER_SUBMIT_IP = 10;

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILED_ATTEMPTS = 10;

const JWT_EXPIRES_IN = '12h';
const JWT_ISSUER = 'offer-network-api';
/** Must match the single algorithm `requireAuth` will verify against. */
const JWT_ALGORITHM = 'HS256';

/**
 * Postgres / network error codes that mean "the database is not reachable",
 * not "the request was wrong". Classified in one place so `register`, `login`
 * and the reset handlers return the same status for the same underlying issue.
 */
const DB_UNREACHABLE_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

const PASSWORD_POLICY_MESSAGE =
    `Choose a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`;

const RESET_INVALID_MESSAGE = 'This reset link is invalid or has expired. Request a new one.';

/**
 * The response to every "start a reset" outcome: found, not found, banned,
 * email provider down, base URL misconfigured. Frozen so it cannot be mutated
 * by accident between requests.
 */
const RESET_GENERIC_RESPONSE = Object.freeze({
    message:
        'If an account exists for that email, a reset link is on its way. ' +
        `The link expires in ${RESET_TOKEN_LIFETIME_MINUTES} minutes.`,
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isDatabaseUnreachable(error) {
    return DB_UNREACHABLE_CODES.has(error?.code);
}

/**
 * Turns a passkey failure into a response the visitor can act on.
 *
 * Two rules, and both exist to avoid telling an attacker something.
 *
 * The service throws errors that already carry a message written for a person -- "that passkey
 * did not work, try again or use your password" -- because the library's own errors are
 * precise about which check failed and that precision is for a log, not for a sign-in screen.
 * A visitor who is told their assertion had a counter mismatch learns about the credential's
 * internals and still does not know what to do next.
 *
 * A credential id that is not on this site gets the same answer as a signature that does not
 * verify. Distinguishing them would make this an oracle for which passkeys exist, which is
 * information about an account to someone who has not proved they own it.
 */
function respondToPasskeyError(res, error, fallback) {
    if (isDatabaseUnreachable(error)) {
        return res.status(503).json({ error: 'This service is temporarily unavailable.' });
    }
    if (error?.code) {
        return res.status(error.status || 401).json({ error: error.message, code: error.code });
    }
    console.error('Passkey Error:', error?.message);
    return res.status(500).json({ error: fallback });
}

function normaliseEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
    return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

function isValidPasswordShape(password) {
    return typeof password === 'string'
        && password.length >= PASSWORD_MIN_LENGTH
        && password.length <= PASSWORD_MAX_LENGTH;
}

/**
 * A login attempt only needs a non-empty password string. The length policy is
 * enforced at registration: a password accepted on sign-up will still validate
 * against this check. Requiring the full policy on login means an account whose
 * password predates the policy can never sign in, and the error message tells the
 * user their password is wrong when the real situation is that it is too short.
 */
function isValidLoginPassword(password) {
    return typeof password === 'string' && password.length > 0;
}

/** The user fields safe to return to the client, wherever a user is serialised. */
function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        balance: user.balance,
        demoBalance: user.demo_balance,
    };
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

async function hashPassword(password) {
    const salt = randomBytes(SCRYPT_SALT_BYTES).toString('hex');
    const hash = await scryptAsync(password, salt, SCRYPT_KEY_BYTES);
    return `${SCRYPT_PREFIX}$${salt}$${hash.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * scrypt is run exactly once whether or not `encodedHash` is present or well
 * formed, so a caller that reaches this with no user still pays the same cost
 * as a caller that reaches it with a real account and a wrong password. That
 * is what stops an unauthenticated caller from learning which email addresses
 * are registered by measuring login latency.
 */
async function verifyPassword(password, encodedHash) {
    const [algorithm, salt, savedHash] = String(encodedHash || '').split('$');
    const wellFormed =
        algorithm === SCRYPT_PREFIX &&
        Boolean(salt) &&
        /^[\da-f]+$/i.test(savedHash || '');

    const actual = await scryptAsync(
        password,
        wellFormed ? salt : DUMMY_SCRYPT_SALT,
        SCRYPT_KEY_BYTES
    );

    if (!wellFormed) return false;
    const expected = Buffer.from(savedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

function issueToken(user) {
    if (!process.env.JWT_SECRET) return null;

    // Read strictly, and refuse rather than defaulting.
    //
    // `Number(user.token_version) || 0` used to stand here, and it turned a forgotten column
    // into a locked-out account instead of a failure. Password reset bumps `users.token_version`,
    // and `requireAuth` rejects any token whose `ver` claim is not exactly the stored value. If
    // the row that reached here was selected without that column, the claim was signed as 0, so
    // a user whose version was 1 passed sign-in, received a token, and then had every single
    // request refused with "your session ended because the password changed" -- forever, because
    // signing in again produced the same stale claim. Silent and permanent.
    //
    // So an absent or malformed version is an error here. Any query feeding `issueToken` that
    // leaves out the column now fails loudly at the call site instead of quietly signing a token
    // that will be rejected on first use.
    const rawVersion = user?.token_version;
    const version = rawVersion === null || rawVersion === undefined ? NaN : Number(rawVersion);
    if (!Number.isInteger(version) || version < 0) {
        throw new Error(
            'issueToken was called without a usable token_version. Add token_version to the ' +
            'query or RETURNING clause that produced this user row.'
        );
    }

    // `algorithm` is stated rather than left to the library's default so the signer and
    // `requireAuth`'s verify-side allow-list cannot drift apart: verification accepts only
    // HS256, so signing must be pinned to it rather than to whatever happens to be default.
    return jwt.sign(
        { sub: String(user.id), ver: version },
        process.env.JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER, algorithm: JWT_ALGORITHM }
    );
}

// ---------------------------------------------------------------------------
// Reset token helpers
// ---------------------------------------------------------------------------

function hashResetToken(token) {
    // The token is 32 random bytes, so a fast digest is sufficient: there is no
    // low-entropy secret to brute-force from the stored value.
    return createHash('sha256').update(token).digest('hex');
}

function resetTokenFromBody(body) {
    const token = String(body?.token || '').trim();
    return RESET_TOKEN_HEX_PATTERN.test(token) ? token : '';
}

/**
 * Builds the reset link. The token travels in the URL fragment, so it is never
 * sent in a request line and therefore never lands in access logs or referrer
 * headers.
 */
function buildResetUrl(token) {
    const publicBaseUrl = resolvePublicBaseUrl();
    if (!publicBaseUrl.ok) return null;
    const url = new URL('/reset-password', publicBaseUrl.baseUrl);
    url.hash = `token=${token}`;
    return url.toString();
}

/** Replaces any outstanding reset token for a user with a freshly issued one. */
async function replaceResetToken({ userId, token, ip }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Only the newest link stays valid for an account.
        await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
        await client.query(
            `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, requested_ip)
             VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4)`,
            [hashResetToken(token), userId, RESET_TOKEN_LIFETIME_MINUTES, ip]
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Consumes a reset token and rotates the account's password in one
 * transaction. Returns `{ ok: false }` when the token is expired, unknown, or
 * already used, and `{ ok: true, user }` when the password was changed.
 *
 * The updated row comes back out of the transaction on purpose. The reset is a sign-in --
 * the holder of a valid, unexpired, single-use token has proved they can read the
 * account's mail, which is the same proof a password sign-in gives -- so the response
 * carries a session and the visitor lands on their account rather than being told to
 * type the password they just invented. Signing that token needs `token_version` *after*
 * the bump, and only this row has it.
 */
async function consumeResetToken({ token, passwordHash }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tokenResult = await client.query(
            `SELECT user_id FROM password_reset_tokens
             WHERE token_hash = $1 AND expires_at > NOW()
             FOR UPDATE`,
            [hashResetToken(token)]
        );
        if (tokenResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false };
        }

        const userId = tokenResult.rows[0].user_id;
        // `token_version` is bumped so every session issued before the reset
        // stops working; the middleware rejects any JWT whose `ver` claim is
        // older than the stored value. The new value is returned so the token
        // minted from this row is not immediately stale.
        const updated = await client.query(
            `UPDATE users
             SET password_hash = $1, token_version = token_version + 1
             WHERE id = $2
             RETURNING id, email, balance, demo_balance, token_version`,
            [passwordHash, userId]
        );
        await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

        await client.query('COMMIT');
        return { ok: true, user: updated.rows[0] || null };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const authController = {
    /**
     * Creates an account and sends a confirmation code.
     *
     * No session token is returned. The account exists but cannot be used until the address
     * is confirmed, which is the entire point: handing back a token here is what let a typo,
     * or an address belonging to someone else, become a usable account holding a balance.
     *
     * The response distinguishes "created, now confirm it" from "that address is taken",
     * because the person registering already knows the address they typed. That is not an
     * enumeration surface -- registration is not a secret, and the alternative (pretending to
     * succeed while sending nothing) leaves a real user stuck with no way forward.
     */
    register: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        const password = req.body.password;

        if (!isValidEmail(email) || !isValidPasswordShape(password)) {
            return res.status(400).json({
                error: `Enter a valid email and a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
            });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        // Email is the only way to prove an address, so a deployment without it cannot
        // confirm anyone. Production refuses outright rather than minting accounts that can
        // never be used -- a user who is told to check an inbox that will never receive
        // anything has no way forward and no way to tell that from a delivery problem.
        //
        // Outside production the code is logged and the address is accepted as already
        // confirmed, so local development and the smoke suite work without a mail provider.
        // The branch is gated on NODE_ENV rather than on the missing variables, so a
        // production deployment with a misconfigured provider is refused rather than
        // silently skipping verification for real users.
        const emailReady = isEmailConfigured();
        if (!emailReady && process.env.NODE_ENV === 'production') {
            return res.status(503).json({
                error: 'Email confirmation is not configured, so accounts cannot be created right now.'
            });
        }
        if (!emailReady) {
            console.warn(
                'No email provider is configured: new accounts are being accepted without email ' +
                'confirmation. Set BREVO_API_KEY (or RESEND_API_KEY) and EMAIL_FROM. This is a ' +
                'development convenience and is refused in production.'
            );
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const passwordHash = await hashPassword(password);
            const username = `member_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
            const result = await client.query(
                `INSERT INTO users (username, email, password_hash, email_verified_at)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, balance, demo_balance, token_version`,
            // Confirmed at creation only on the development path above; production always
            // leaves this NULL until a code proves the address.
            [username, email, passwordHash, emailReady ? null : new Date()]
        );
            const user = result.rows[0];

            if (emailReady) {
                const code = generateCode();
                await client.query(
                    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at)
                     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
                    [user.id, hashCode(code, user.id), String(CODE_LIFETIME_MINUTES)]
                );
                await client.query('COMMIT');
                client.release();
                client = null;

                const delivery = await sendVerificationEmail({ to: user.email, code });
                if (!delivery.sent) {
                    // The account is real and a code exists, so this is recoverable by
                    // resending. Logged loudly because it means nobody can be confirmed.
                    console.error(`Verification email was not delivered (${delivery.reason}).`);
                }

                // The welcome is a second, independent message. It is sent without awaiting it
                // and its failure is swallowed inside the mailer, because the account already
                // exists by now: holding the response open to deliver a courtesy email would
                // turn a slow provider into a failed registration, and awaiting it serially
                // would double the time the user waits on the button they just pressed.
                sendWelcomeEmail({ to: user.email }).catch((error) => {
                    console.error('Welcome email failed:', error.message);
                });

                return res.status(201).json({
                    requiresVerification: true,
                    email: user.email,
                    expiresInMinutes: CODE_LIFETIME_MINUTES
                });
            }

            await client.query('COMMIT');
            client.release();
            client = null;

            const token = issueToken(user);
            if (!token) {
                return res.status(503).json({ error: 'Account login is not configured.' });
            }
            return res.status(201).json({ token, user: publicUser(user) });
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
                client.release();
            }
            if (error.code === '23505') {
                // The email column is the only uniqueness the client can
                // influence: `username` is server-generated and collisions are
                // astronomically unlikely. Reporting the email conflict only
                // when the violation actually names it keeps a stray username
                // collision from being blamed on the user's email.
                if (String(error.detail || '').toLowerCase().includes('email')) {
                    return res.status(409).json({ error: 'An account with that email already exists.' });
                }
                console.error('Registration hit an unexpected unique violation:', error.detail);
            } else {
                console.error('Registration Error:', error.message);
            }
            // Distinguish "cannot reach the database" from a genuine failure.
            // Without this the caller (and the test suite) sees only a 500 and
            // cannot tell that DATABASE_URL is missing or wrong, which is the
            // most common setup mistake.
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not create your account.' });
        }
    },

    /**
     * Confirms an address with the code that was emailed, and issues the session.
     *
     * The code row is destroyed on a correct guess, so it cannot be replayed, and on the
     * last wrong guess, so it cannot be searched. Every failure answers with one message: a
     * more specific reply would tell an attacker whether the address exists, whether a code
     * was live, and how many digits were right.
     */
    verifyEmail: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        const code = String(req.body.code || '').trim();

        if (!isValidEmail(email) || !CODE_PATTERN.test(code)) {
            return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const found = await client.query(
                `SELECT u.id, u.email, u.balance, u.demo_balance, u.is_banned,
                        c.id AS code_id, c.code_hash, c.attempts
                 FROM users u
                 LEFT JOIN email_verification_codes c
                        ON c.user_id = u.id AND c.consumed_at IS NULL AND c.expires_at > NOW()
                 WHERE LOWER(u.email) = $1
                 FOR UPDATE OF u`,
                [email]
            );
            const row = found.rows[0];

            if (!row || !row.code_id || row.is_banned) {
                if (client) await client.query('ROLLBACK').catch(() => {});
                return res.status(400).json({ error: VERIFICATION_FAILED_MESSAGE });
            }

            if (!codeMatches(code, row.code_hash, row.id)) {
                // Spending an attempt on every wrong guess, and destroying the code when they
                // run out, is what makes a million possibilities unsearchable.
                await client.query(
                    'UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1',
                    [row.code_id]
                );
                if (row.attempts + 1 >= MAX_ATTEMPTS) {
                    await client.query('DELETE FROM email_verification_codes WHERE id = $1', [row.code_id]);
                }
                await client.query('COMMIT');
                return res.status(400).json({ error: VERIFICATION_FAILED_MESSAGE });
            }

            await client.query('DELETE FROM email_verification_codes WHERE id = $1', [row.code_id]);
            const updated = await client.query(
                `UPDATE users SET email_verified_at = NOW() WHERE id = $1
                 RETURNING id, email, balance, demo_balance, token_version`,
                [row.id]
            );
            await client.query('COMMIT');
            client.release();
            client = null;

            const user = updated.rows[0];
            const token = issueToken(user);
            if (!token) {
                return res.status(503).json({ error: 'Account login is not configured.' });
            }

            // Sent here, and not during registration, because this is the only point at which
            // the address is known to be real. A welcome sent on registration congratulates
            // someone on an account they may not be able to use, and would have to be corrected
            // by a follow-up if the code were never entered. Fire-and-forget for the same reason
            // as registration: the session is already issued and the user is already waiting.
            sendAccountVerifiedEmail({ to: user.email }).catch((error) => {
                console.error('Verification thank-you email failed:', error.message);
            });

            return res.json({ token, user: publicUser(user) });
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
                client.release();
            }
            console.error('Email verification Error:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not confirm your email right now.' });
        }
    },

    /**
     * Sends another code to an address that has not been confirmed.
     *
     * Rated per address and per IP, because without a send limit this is a way to bury an
     * inbox in mail. The response is identical whether the address is unknown, already
     * confirmed, or absent, so it cannot be used to discover who has an account -- only
     * whether a message was actually sent differs, and that is not observable from outside.
     */
    resendVerification: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Enter a valid email address.' });
        }
        const ip = clientIp(req);

        try {
            // Inside the try, deliberately. `consumeRateLimit` queries the database, and a
            // rejected promise escaping an async handler is not caught by Express 4: the
            // request hangs until the client gives up and the rejection is unhandled, which
            // under Node's default policy takes the process down. A database blip while
            // rating a resend has to be an ordinary 503, not a crash.
            const [perAddress, perIp] = await Promise.all([
                consumeRateLimit({
                    bucket: `verify-email:${email}`,
                    maxAttempts: RESEND_CODE_LIMIT_PER_ADDRESS,
                    windowSeconds: RESEND_CODE_WINDOW_SECONDS
                }),
                consumeRateLimit({
                    bucket: `verify-email:ip:${ip}`,
                    maxAttempts: RESEND_CODE_LIMIT_PER_IP,
                    windowSeconds: RESEND_CODE_WINDOW_SECONDS
                })
            ]);
            if (!perAddress.allowed || !perIp.allowed) {
                return res.status(429).json({
                    error: 'Too many requests for a new code. Try again in a few minutes.',
                    retryAfterSeconds: Math.max(perAddress.retryAfterSeconds, perIp.retryAfterSeconds)
                });
            }

            const found = await pool.query(
                'SELECT id, email, email_verified_at FROM users WHERE LOWER(email) = $1',
                [email]
            );
            const user = found.rows[0];

            if (user && !user.email_verified_at) {
                const code = generateCode();
                // Any previous live code is dropped, so only the newest one works and a code
                // still sitting in the user's inbox from an earlier request cannot be used
                // after they asked for a new one. Dropped and replaced in one transaction:
                // two requests that interleave -- both deletes, then both inserts -- would
                // otherwise leave two live codes behind, and only one of them would be the
                // one the user is now reading.
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM email_verification_codes WHERE user_id = $1', [user.id]);
                    await client.query(
                        `INSERT INTO email_verification_codes (user_id, code_hash, expires_at)
                         VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
                        [user.id, hashCode(code, user.id), String(CODE_LIFETIME_MINUTES)]
                    );
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {});
                    throw error;
                } finally {
                    client.release();
                }

                const delivery = await sendVerificationEmail({ to: user.email, code });
                if (!delivery.sent) {
                    console.error(`Verification email was not delivered (${delivery.reason}).`);
                }
            }

            return res.json({
                ok: true,
                expiresInMinutes: CODE_LIFETIME_MINUTES,
                message: 'If that address needs confirming, a new code is on its way.'
            });
        } catch (error) {
            console.error('Could not issue a new verification code:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not send a new code right now.' });
        }
    },


    login: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        const password = req.body.password;

        // A malformed shape is rejected before touching the database. The
        // message is deliberately identical for both branches so an attacker
        // cannot distinguish "invalid email" from "wrong password" by status
        // code and message alone.
        if (!isValidEmail(email) || !isValidLoginPassword(password)) {
            return res.status(400).json({ error: 'Enter a valid email and password.' });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        try {
            const result = await pool.query(
                `SELECT id, email, balance, password_hash, is_banned, demo_balance, email_verified_at, token_version
                 FROM users
                 WHERE LOWER(email) = $1`,
                [email]
            );
            const user = result.rows[0];

            // verifyPassword runs scrypt regardless of whether the row exists,
            // so the response time does not reveal registration status.
            const matches = await verifyPassword(password, user?.password_hash);
            if (!user || !matches || user.is_banned) {
                // Rate limiting lives here, not in middleware, so only a failed credential
                // check counts against the budget. Successful logins and the 403 path for
                // an unconfirmed account must not consume an attempt: a user retrying their
                // password, or a freshly registered user going through confirmation, is not
                // an attack. Only a wrong password (or unknown address, which pays the same
                // scrypt cost) moves the counter.
                const rate = await consumeRateLimit({
                    bucket: `login:ip:${clientIp(req)}`,
                    maxAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
                    windowSeconds: LOGIN_WINDOW_SECONDS,
                });
                if (!rate.allowed) {
                    return res.status(429).json({
                        error: 'Too many failed sign-in attempts. Try again in a few minutes.',
                        retryAfterSeconds: rate.retryAfterSeconds,
                    });
                }
                return res.status(401).json({ error: 'Email or password is incorrect.' });
            }

            // An unconfirmed account is refused here even though the password was correct.
            // This is the gate that makes verification mean something: without it, the check
            // only ever delayed sign-in by one extra click and the account was usable
            // regardless. The address is echoed back because the caller already proved they
            // own the password, so this reveals nothing they did not already know, and the
            // client needs it to show which address to confirm.
            //
            // `COALESCE` matters: accounts created before this migration have no value in the
            // column, and treating "NULL" as confirmed would silently exempt every existing
            // user. Null means unverified, which asks them to confirm rather than assuming.
            if (!user.email_verified_at) {
                return res.status(403).json({
                    error: 'Confirm your email address to finish setting up your account.',
                    requiresVerification: true,
                    email: user.email
                });
            }

            const token = issueToken(user);
            if (!token) {
                return res.status(503).json({ error: 'Account login is not configured.' });
            }
            return res.json({ token, user: publicUser(user) });
        } catch (error) {
            console.error('Login Error:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not sign in right now.' });
        }
    },

    /**
     * Starts a password reset.
     *
     * The response is identical whether or not the address has an account, and
     * whether or not email delivery is configured, so this endpoint cannot be
     * used to discover which addresses are registered.
     */
    forgotPassword: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Enter a valid email address.' });
        }

        try {
            const ip = clientIp(req);

            // Two limits: one keyed on the address so a single inbox cannot be
            // flooded, and one keyed on the caller so an attacker cannot walk a
            // list of addresses from one machine.
            const [perEmail, perIp] = await Promise.all([
                consumeRateLimit({
                    bucket: `reset:email:${email}`,
                    maxAttempts: RESET_LIMIT_PER_EMAIL,
                    windowSeconds: RESET_WINDOW_SECONDS,
                }),
                consumeRateLimit({
                    bucket: `reset:ip:${ip}`,
                    maxAttempts: RESET_LIMIT_PER_IP,
                    windowSeconds: RESET_WINDOW_SECONDS,
                }),
            ]);
            if (!perEmail.allowed || !perIp.allowed) {
                return res.status(429).json({
                    error: 'Too many reset requests. Please wait before trying again.',
                });
            }

            const userResult = await pool.query(
                'SELECT id FROM users WHERE LOWER(email) = $1 AND is_banned IS NOT TRUE',
                [email]
            );
            const user = userResult.rows[0];

            if (!user) {
                // Spend comparable time on the not-found path: a full scrypt
                // costs the same as the one a real account's reset would have
                // triggered during the eventual sign-in that never happens.
                await hashPassword(`nonexistent-${email}`);
                return res.json(RESET_GENERIC_RESPONSE);
            }

            const token = randomBytes(RESET_TOKEN_BYTES).toString('hex');
            const resetUrl = buildResetUrl(token);
            if (!resetUrl) {
                // Refused before the token is stored. A deployment with no usable
                // APP_BASE_URL cannot deliver this link at all, and storing it first would
                // delete whatever reset link the account did have and replace it with one
                // that can never arrive.
                console.error('Password reset link could not be built: APP_BASE_URL is not configured.');
                return res.json(RESET_GENERIC_RESPONSE);
            }

            await replaceResetToken({ userId: user.id, token, ip });

            const delivery = await sendPasswordResetEmail({ to: email, resetUrl });
            if (!delivery.sent) {
                // Operators need to know delivery failed; the client sees no
                // difference, because telling the client would reveal that the
                // address was found.
                console.error(`Password reset email was not delivered (${delivery.reason}).`);
            }
            return res.json(RESET_GENERIC_RESPONSE);
        } catch (error) {
            // A request that fails here must not expose the failure: the
            // response is the same one a not-found address receives.
            console.error('Password reset request failed:', error.message);
            return res.json(RESET_GENERIC_RESPONSE);
        }
    },

    /**
     * Completes a password reset.
     *
     * The token is single-use, expires after 60 minutes, and is consumed in the
     * same transaction that changes the password. `token_version` is bumped so
     * every session issued before the reset stops working, and outstanding
     * reset tokens for the account are removed.
     *
     * The response carries a session token, so the browser goes straight to the
     * account page instead of showing a message telling the visitor to sign in with
     * the password they have just set.
     */
    resetPassword: async (req, res) => {
        const token = resetTokenFromBody(req.body);
        const password = req.body.password;

        if (!token) {
            return res.status(400).json({ error: RESET_INVALID_MESSAGE });
        }
        if (!isValidPasswordShape(password)) {
            return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        try {
            // A rate limit here bounds abuse of a valid token by a stolen
            // password or a leaked reset URL, and bounds credential-stuffing
            // attempts against the reset endpoint from one address.
            const rate = await consumeRateLimit({
                bucket: `reset:submit:${clientIp(req)}`,
                maxAttempts: RESET_LIMIT_PER_SUBMIT_IP,
                windowSeconds: RESET_WINDOW_SECONDS,
            });
            if (!rate.allowed) {
                return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
            }

            const passwordHash = await hashPassword(password);
            const outcome = await consumeResetToken({ token, passwordHash });
            if (!outcome.ok) {
                return res.status(400).json({ error: RESET_INVALID_MESSAGE });
            }

            // A session for the reset itself, so the visitor lands on their account instead
            // of being told to sign in with the password they chose one second ago. The
            // token is signed at the bumped `token_version`, so it is not one of the sessions
            // the reset just revoked. If signing fails for any reason the reset still stands
            // -- the password really has changed -- so the response degrades to the old
            // "now sign in" shape rather than reporting a failure that did not happen.
            let session = null;
            if (outcome.user) {
                try {
                    session = { token: issueToken(outcome.user), user: publicUser(outcome.user) };
                } catch (error) {
                    console.error('Password reset succeeded but the session could not be issued:', error.message);
                }
            }

            return res.json({
                message: session
                    ? 'Your password has been updated and you are signed in.'
                    : 'Your password has been updated. Sign in with your new password.',
                signedOutEverywhere: true,
                ...(session?.token ? { token: session.token, user: session.user } : {}),
            });
        } catch (error) {
            console.error('Password reset failed:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not reset your password right now.' });
        }
    },

    /**
     * Signs out the current session by bumping `token_version`.
     *
     * A client that only deletes its local token is still vulnerable: if the token was
     * intercepted, the copy continues working until it expires or is overwritten by a
     * fresh sign-in. Bumping `token_version` invalidates every token signed at the old
     * version across all devices, which is what "sign out everywhere" actually means.
     *
     * The endpoint is idempotent: bumping the version again is harmless, and a caller
     * with no session to revoke is handled the same as one whose token was already
     * stale.
     */
    // -----------------------------------------------------------------------
    // Passkeys
    // -----------------------------------------------------------------------
    //
    // Four endpoints, two round trips. The first of each pair generates a challenge and
    // returns options for `navigator.credentials`; the second takes what the authenticator
    // produced and finishes the job. They cannot be merged, because the browser has to run
    // between them and that is where the Face ID or Touch ID prompt happens.
    //
    // Registration needs a session -- a passkey is added to an account, so somebody has to
    // already be in it. Authentication deliberately does not: that is the whole point of a
    // discoverable passkey, that the account is resolved from the credential after the user
    // has proved who they are rather than by being told who they are first.
    //
    // `requireAuth` on the two register routes is also what keeps a stolen session from
    // quietly enrolling a new device on its way out.

    /**
     * Options for adding a device.
     *
     * `req.user` is passed as it is rather than copied field by field. The copy this used to
     * make listed `email` and `display_name`, and `requireAuth` puts neither on that object -- it
     * builds one field by field on purpose -- so both were `undefined` and the options went out
     * with no `user.name`, which the browser rejects before the device is ever asked. The service
     * reads the account's identity from the database, which is also the only place it can be
     * trusted from.
     */
    passkeyRegisterOptions: async (req, res) => {
        try {
            const options = await passkeys.registrationOptions(req, req.user);
            return res.json(options);
        } catch (error) {
            return respondToPasskeyError(res, error, 'Could not start setting up that passkey.');
        }
    },

    /** Finishes adding a device, or refuses and explains. */
    passkeyRegisterVerify: async (req, res) => {
        try {
            const result = await passkeys.completeRegistration(
                req,
                req.user,
                req.body?.response,
                req.body?.challenge
            );
            return res.json({ ok: true, credentialId: result.credentialId });
        } catch (error) {
            return respondToPasskeyError(res, error, 'Could not register that passkey.');
        }
    },

    /** Options for signing in. Anonymous, and deliberately so. */
    passkeyAuthenticateOptions: async (req, res) => {
        try {
            return res.json(await passkeys.authenticationOptions(req));
        } catch (error) {
            return respondToPasskeyError(res, error, 'Could not start passkey sign-in.');
        }
    },

    /**
     * Finishes signing in.
     *
     * The response shape is the same as `login`, so the client has one sign-in path rather
     * than two that differ in a field name. An unconfirmed account is refused exactly as
     * `login` refuses it -- holding a passkey is not confirmation, and letting it through
     * would create accounts that can hold a balance but never receive the email that says
     * they are real.
     */
    passkeyAuthenticateVerify: async (req, res) => {
        try {
            const user = await passkeys.completeAuthentication(req, req.body?.response, req.body?.challenge);
            if (!user.email_verified_at) {
                return res.status(403).json({
                    error: 'Confirm your email address before signing in.',
                    requiresVerification: true,
                    email: user.email
                });
            }
            const token = issueToken(user);
            if (!token) {
                return res.status(503).json({ error: 'Authentication is not configured.' });
            }
            return res.json({
                token,
                user: { id: user.id, email: user.email, display_name: user.display_name || null }
            });
        } catch (error) {
            return respondToPasskeyError(res, error, 'Passkey sign-in did not work.');
        }
    },

    /** The devices this account can sign in with, for the revoke list. */
    passkeyList: async (req, res) => {
        try {
            return res.json({ passkeys: await passkeys.listPasskeys(req.user.id) });
        } catch (error) {
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not load your passkeys right now.' });
        }
    },

    /**
     * Removes a device.
     *
     * 404 for a credential this account does not have, which is also the answer for one that
     * belongs to somebody else. A 403 would confirm that the credential exists, which is a
     * small thing to leak but a free one, and there is no version of this that needs it.
     */
    passkeyDelete: async (req, res) => {
        try {
            const removed = await passkeys.deletePasskey(req.user.id, req.params.credentialId);
            if (!removed) {
                return res.status(404).json({ error: 'That passkey was not found.' });
            }
            return res.json({ ok: true });
        } catch (error) {
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not remove that passkey right now.' });
        }
    },

    logout: async (req, res) => {
        try {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    'UPDATE users SET token_version = token_version + 1 WHERE id = $1',
                    [req.user.id]
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }

            return res.json({ signedOutEverywhere: true });
        } catch (error) {
            console.error('Logout Error:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not end your session right now.' });
        }
    },

    /**
     * Issues a magic link sign-in email.
     *
     * The address is not confirmed to exist or not exist: the response is identical
     * either way, and the email is only actually sent if a live, unconfirmed account
     * is found. This prevents the endpoint from being used to enumerate accounts or
     * to spam an address that does not have one -- but only if sending is itself
     * rate limited, which is why the counters are spent before the address is looked up.
     *
     * The link itself is a random 32-byte token carried in the URL fragment. The
     * token is hashed before storage, so a database read cannot produce a valid link.
     * It is single-use, it expires after a short window, and requesting a new one
     * invalidates any that were outstanding.
     */
    sendMagicLink: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Enter a valid email address.' });
        }

        try {
            const [perAddress, perIp] = await Promise.all([
                consumeRateLimit({
                    bucket: `magic-link:${email}`,
                    maxAttempts: MAGIC_LINK_LIMIT_PER_ADDRESS,
                    windowSeconds: MAGIC_LINK_LIMIT_WINDOW_SECONDS
                }),
                consumeRateLimit({
                    bucket: `magic-link:ip:${clientIp(req)}`,
                    maxAttempts: MAGIC_LINK_LIMIT_PER_IP,
                    windowSeconds: MAGIC_LINK_LIMIT_WINDOW_SECONDS
                })
            ]);
            if (!perAddress.allowed || !perIp.allowed) {
                return res.status(429).json({
                    error: 'Too many magic links requested. Try again in a few minutes.',
                    retryAfterSeconds: Math.max(perAddress.retryAfterSeconds, perIp.retryAfterSeconds)
                });
            }

            const userResult = await pool.query(
                'SELECT id, email, email_verified_at FROM users WHERE LOWER(email) = $1',
                [email]
            );
            const user = userResult.rows[0];

            if (user && !user.email_verified_at) {
                const token = randomBytes(32).toString('hex');
                const tokenHash = createHash('sha256').update(token).digest('hex');

                // Replaces rather than appends, in one transaction. Without the delete a
                // second request leaves the first link live, so a link that has already been
                // forwarded, or copied out of a mailbox, still signs the account in after the
                // owner has asked for a new one -- and the rows accumulate. The transaction is
                // what stops two concurrent requests from each deleting the other's row and
                // then both inserting, which leaves two live tokens again.
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM magic_link_tokens WHERE user_id = $1', [user.id]);
                    await client.query(
                        `INSERT INTO magic_link_tokens (token_hash, user_id, email, expires_at)
                         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
                        [tokenHash, user.id, user.email, MAGIC_LINK_WINDOW_MINUTES]
                    );
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {});
                    throw error;
                } finally {
                    client.release();
                }

                const delivery = await sendMagicLinkEmail({ to: user.email, token });
                if (!delivery.sent) {
                    console.error(`Magic link email was not delivered (${delivery.reason}).`);
                }
            }

            // Same response whether or not the address has an account, to avoid
            // revealing which addresses are registered.
            return res.json({
                message: 'If an unconfirmed account exists for that email, a magic link is on its way. The link expires in 15 minutes.',
                expiresInMinutes: MAGIC_LINK_WINDOW_MINUTES
            });
        } catch (error) {
            console.error('Send magic link Error:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not send a magic link right now.' });
        }
    },

    /**
     * Consumes a magic link token and issues a session.
     *
     * The token is compared as a hash: the raw token is never stored. On success the
     * row is deleted so it cannot be replayed, the address is confirmed -- the link is
     * proof of control of the inbox, the same proof a six-digit code carries -- and the
     * user's `token_version` is bumped so any session issued before this sign-in stops
     * working.
     *
     * Because this endpoint is reached by a link in an email rather than a form
     * submission, the token arrives in the request body from the frontend (which
     * reads it from the URL fragment and removes the fragment from the address bar
     * before navigating).
     */
    consumeMagicLink: async (req, res) => {
        const rawToken = String(req.body?.token || '').trim();
        if (!/^[0-9a-f]{64}$/i.test(rawToken)) {
            return res.status(400).json({ error: 'This magic link is invalid or has expired.' });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        const tokenHash = createHash('sha256').update(rawToken).digest('hex');

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            // Delete and return in one shot: single-use semantics with no race.
            const found = await client.query(
                `DELETE FROM magic_link_tokens
                 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
                 RETURNING user_id, email`,
                [tokenHash]
            );

            if (found.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                client = null;
                return res.status(400).json({ error: 'This magic link is invalid or has expired.' });
            }

            const row = found.rows[0];

            // Confirm the account and retire earlier sessions in one write.
            //
            // The confirmation is the point: the link was only ever sent to an address
            // with `email_verified_at` NULL, and clicking it is the same proof of inbox
            // control that the six-digit code is. Leaving the column NULL signed the user
            // in here and then refused their very next password sign-in as unverified,
            // while the thank-you email sent below claimed the opposite.
            //
            // `RETURNING` rather than a separate read so `issueToken` is handed the version
            // this write produced. Reading first and bumping afterwards would sign a token
            // one version behind the row, and every request made with it would be refused
            // as revoked. `is_banned` is filtered in the WHERE clause, so a disabled
            // account gets the same "invalid link" answer and, because the delete is
            // rolled back with it, its token is not silently burned.
            const updated = await client.query(
                `UPDATE users
                 SET email_verified_at = COALESCE(email_verified_at, NOW()),
                     token_version = token_version + 1
                 WHERE id = $1 AND is_banned IS NOT TRUE
                 RETURNING id, email, balance, demo_balance, token_version`,
                [row.user_id]
            );
            const user = updated.rows[0];

            if (!user) {
                await client.query('ROLLBACK');
                client.release();
                client = null;
                return res.status(400).json({ error: 'This magic link is invalid or has expired.' });
            }

            await client.query('COMMIT');
            client.release();
            client = null;

            const token = issueToken(user);
            if (!token) {
                return res.status(503).json({ error: 'Account login is not configured.' });
            }

            sendAccountVerifiedEmail({ to: user.email }).catch((error) => {
                console.error('Magic link sign-in thank-you email failed:', error.message);
            });

            return res.json({ token, user: publicUser(user) });
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
                client.release();
            }
            console.error('Consume magic link Error:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not sign you in right now.' });
        }
    },
};

module.exports = authController;

/**
 * The password hasher, exported for the smoke test.
 *
 * It was module-private, so `scripts/smoke-survey-flow.js` had no way to create an account it
 * could then sign in with -- and its own answer, hashing a throwaway password a second way, is
 * exactly the duplication that ends with a fixture hashed by an algorithm the server does not
 * accept. Exporting the real one means the smoke test signs in through the same code path a real
 * user does, so a change to the hashing or the stored format breaks the test rather than quietly
 * making its fixture unloginable.
 */
module.exports.hashPassword = hashPassword;
