const { promisify } = require('node:util');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { consumeRateLimit } = require('../services/security');
const { sendPasswordResetEmail } = require('../services/resetEmail');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');

const scryptAsync = promisify(scrypt);

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

const JWT_EXPIRES_IN = '12h';
const JWT_ISSUER = 'offer-network-api';

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

/** The user fields safe to return to the client, wherever a user is serialised. */
function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        balance: user.balance,
        demo_balance: user.demo_balance,
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
    return jwt.sign(
        { sub: String(user.id), ver: Number(user.token_version) || 0 },
        process.env.JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER }
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
 * already used, and `{ ok: true }` when the password was changed.
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
        // older than the stored value.
        await client.query(
            `UPDATE users
             SET password_hash = $1, token_version = token_version + 1
             WHERE id = $2`,
            [passwordHash, userId]
        );
        await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

        await client.query('COMMIT');
        return { ok: true };
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

        try {
            const passwordHash = await hashPassword(password);
            const username = `member_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
            const result = await pool.query(
                `INSERT INTO users (username, email, password_hash)
                 VALUES ($1, $2, $3)
                 RETURNING id, email, balance, demo_balance`,
                [username, email, passwordHash]
            );
            const user = result.rows[0];

            const token = issueToken(user);
            if (!token) {
                // Unreachable in practice (JWT_SECRET is checked above), but
                // returning `{ token: null }` would be a silent auth failure.
                return res.status(503).json({ error: 'Account login is not configured.' });
            }
            return res.status(201).json({ token, user: publicUser(user) });
        } catch (error) {
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

    login: async (req, res) => {
        const email = normaliseEmail(req.body.email);
        const password = req.body.password;

        // A malformed shape is rejected before touching the database. The
        // message is deliberately identical for both branches so an attacker
        // cannot distinguish "invalid email" from "wrong password" by status
        // code and message alone.
        if (!isValidEmail(email) || !isValidPasswordShape(password)) {
            return res.status(400).json({ error: 'Enter a valid email and password.' });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        try {
            const result = await pool.query(
                `SELECT id, email, balance, password_hash, is_banned, demo_balance
                 FROM users
                 WHERE LOWER(email) = $1`,
                [email]
            );
            const user = result.rows[0];

            // verifyPassword runs scrypt regardless of whether the row exists,
            // so the response time does not reveal registration status.
            const matches = await verifyPassword(password, user?.password_hash);
            if (!user || !matches || user.is_banned) {
                return res.status(401).json({ error: 'Email or password is incorrect.' });
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
            await replaceResetToken({ userId: user.id, token, ip });

            const resetUrl = buildResetUrl(token);
            if (!resetUrl) {
                console.error('Password reset link could not be built: APP_BASE_URL is not configured.');
                return res.json(RESET_GENERIC_RESPONSE);
            }

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

            return res.json({
                message: 'Your password has been updated. Sign in with your new password.',
                signedOutEverywhere: true,
            });
        } catch (error) {
            console.error('Password reset failed:', error.message);
            if (isDatabaseUnreachable(error)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not reset your password right now.' });
        }
    },
};

module.exports = authController;