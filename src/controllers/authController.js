const { promisify } = require('node:util');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { consumeRateLimit } = require('../services/security');
const { sendPasswordResetEmail } = require('../services/resetEmail');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');

const scryptAsync = promisify(scrypt);
const passwordBytes = 64;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const resetTokenLifetimeMinutes = 60;
const resetTokenBytes = 32;

async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await scryptAsync(password, salt, passwordBytes);
    return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(password, encodedHash) {
    if (!encodedHash) {
        await scryptAsync(password, 'offer-network-missing-account', passwordBytes);
        return false;
    }

    const [algorithm, salt, savedHash] = encodedHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !/^[\da-f]+$/i.test(savedHash || '')) return false;

    const actualHash = await scryptAsync(password, salt, passwordBytes);
    const expectedHash = Buffer.from(savedHash, 'hex');
    return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

function issueToken(user) {
    if (!process.env.JWT_SECRET) return null;
    return jwt.sign(
        { sub: String(user.id), ver: Number(user.token_version) || 0 },
        process.env.JWT_SECRET,
        { expiresIn: '12h', issuer: 'offer-network-api' }
    );
}

function validCredentials(email, password) {
    return email.length <= 254 && emailPattern.test(email) &&
        typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

function hashResetToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function resetTokenFromBody(body) {
    const token = String(body?.token || '').trim();
    return /^[\da-f]{64}$/i.test(token) ? token : '';
}

/**
 * Builds the reset link. The token travels in the URL fragment, so it is never sent
 * in a request line and therefore never lands in access logs or referrer headers.
 */
function buildResetUrl(token) {
    const publicBaseUrl = resolvePublicBaseUrl();
    if (!publicBaseUrl.ok) return null;
    const url = new URL('/reset-password', publicBaseUrl.baseUrl);
    url.hash = `token=${token}`;
    return url.toString();
}

const authController = {
    register: async (req, res) => {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = req.body.password;
        if (!validCredentials(email, password)) {
            return res.status(400).json({ error: 'Enter a valid email and a password between 12 and 128 characters.' });
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
            return res.status(201).json({ token: issueToken(user), user });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'An account with that email already exists.' });
            }
            console.error('Registration Error:', error.message);
            // Distinguish "cannot reach the database" from a genuine failure. Without
            // this the caller (and the test suite) sees only a 500 and cannot tell that
            // DATABASE_URL is missing or wrong, which is the most common setup mistake.
            if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(error.code)) {
                return res.status(503).json({ error: 'This service is temporarily unavailable.' });
            }
            return res.status(500).json({ error: 'Could not create your account.' });
        }
    },

    login: async (req, res) => {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = req.body.password;
        if (!validCredentials(email, password)) {
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
            const matches = await verifyPassword(password, user?.password_hash);
            if (!user || !matches || user.is_banned) {
                return res.status(401).json({ error: 'Email or password is incorrect.' });
            }
            return res.json({ token: issueToken(user), user: {
                id: user.id,
                email: user.email,
                balance: user.balance,
                demo_balance: user.demo_balance
            } });
        } catch (error) {
            console.error('Login Error:', error.message);
            return res.status(500).json({ error: 'Could not sign in right now.' });
        }
    },

    /**
     * Starts a password reset.
     *
     * The response is identical whether or not the address has an account, and whether
     * or not email delivery is configured, so this endpoint cannot be used to discover
     * which addresses are registered.
     */
    forgotPassword: async (req, res) => {
        const genericResponse = {
            message: 'If an account exists for that email, a reset link is on its way. The link expires in 60 minutes.'
        };
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!emailPattern.test(email) || email.length > 254) {
            return res.status(400).json({ error: 'Enter a valid email address.' });
        }

        try {
            const ip = req.ip || req.socket?.remoteAddress || 'unknown';
            const perEmail = await consumeRateLimit({
                bucket: `reset:email:${email}`,
                maxAttempts: 3,
                windowSeconds: 15 * 60
            });
            if (!perEmail.allowed) {
                return res.status(429).json({ error: 'Too many reset requests for that address. Try again later.' });
            }

            const userResult = await pool.query(
                'SELECT id FROM users WHERE LOWER(email) = $1 AND is_banned IS NOT TRUE',
                [email]
            );
            const user = userResult.rows[0];
            if (!user) {
                // Spend comparable time on the not-found path so response timing does
                // not reveal whether the address exists.
                await hashPassword(`nonexistent-${email}`);
                return res.json(genericResponse);
            }

            const token = randomBytes(resetTokenBytes).toString('hex');
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Only the newest link stays valid for an account.
                await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
                await client.query(
                    `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, requested_ip)
                     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4)`,
                    [hashResetToken(token), user.id, resetTokenLifetimeMinutes, ip]
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }

            const resetUrl = buildResetUrl(token);
            if (!resetUrl) {
                console.error('Password reset link could not be built: APP_BASE_URL is not configured.');
                return res.json(genericResponse);
            }

            const delivery = await sendPasswordResetEmail({ to: email, resetUrl });
            if (!delivery.sent) {
                // Operators need to know delivery failed; the client sees no difference.
                console.error(`Password reset email was not delivered (${delivery.reason}).`);
            }
            return res.json(genericResponse);
        } catch (error) {
            console.error('Password reset request failed:', error.message);
            return res.json(genericResponse);
        }
    },

    /**
     * Completes a password reset.
     *
     * The token is single-use, expires after 60 minutes, and is consumed in the same
     * transaction that changes the password. `token_version` is bumped so every session
     * issued before the reset stops working, and outstanding reset tokens for the
     * account are removed.
     */
    resetPassword: async (req, res) => {
        const token = resetTokenFromBody(req.body);
        const password = req.body.password;
        if (!token) {
            return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
        }
        if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
            return res.status(400).json({ error: 'Choose a password between 12 and 128 characters.' });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'Account login is not configured.' });
        }

        try {
            const passwordHash = await hashPassword(password);
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
                    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
                }

                const userId = tokenResult.rows[0].user_id;
                await client.query(
                    `UPDATE users
                     SET password_hash = $1, token_version = token_version + 1
                     WHERE id = $2`,
                    [passwordHash, userId]
                );
                await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
                await client.query('COMMIT');

                return res.json({
                    message: 'Your password has been updated. Sign in with your new password.',
                    signedOutEverywhere: true
                });
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Password reset failed:', error.message);
            return res.status(500).json({ error: 'Could not reset your password right now.' });
        }
    }
};

module.exports = authController;
