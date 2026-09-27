const jwt = require('jsonwebtoken');
const pool = require('../config/db');

/**
 * Verifies a bearer token and checks that it has not been revoked.
 *
 * Resetting a password bumps `users.token_version`, so a token signed before the
 * reset carries an older `ver` and is rejected here. Without this check a stolen
 * session would keep working after the owner reset their password.
 */
async function authenticate(req, res, next, required) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        if (!required) return next();
        return res.status(401).json({ error: 'Authentication is required.' });
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return res.status(401).json({ error: 'Authorization must use a Bearer token.' });
    }

    if (!process.env.JWT_SECRET) {
        return res.status(503).json({ error: 'Authentication is not configured.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(match[1], process.env.JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
    }

    const userId = decoded.id ?? decoded.sub;
    if (userId === undefined || userId === null || String(userId).length === 0) {
        return res.status(401).json({ error: 'Token does not identify a user.' });
    }

    // Older tokens predate revocation support and have no version claim. They are
    // treated as version 0, which matches the column default, so existing sessions
    // keep working and still become revocable after one reset.
    const tokenVersion = decoded.ver === undefined ? 0 : Number(decoded.ver);
    if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
        return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
    }

    try {
        const result = await pool.query('SELECT token_version, is_banned FROM users WHERE id = $1', [userId]);
        const account = result.rows[0];
        if (!account || account.is_banned) {
            return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
        }
        if (Number(account.token_version) !== tokenVersion) {
            return res.status(401).json({ error: 'Your session ended because the password changed. Sign in again.' });
        }
    } catch (error) {
        console.error('Session validation failed:', error.message);
        return res.status(503).json({ error: 'This service is temporarily unavailable.' });
    }

    req.user = { ...decoded, id: userId };
    return next();
}


function requireAuth(req, res, next) {
    return authenticate(req, res, next, true);
}

function optionalAuth(req, res, next) {
    return authenticate(req, res, next, false);
}

module.exports = requireAuth;
module.exports.optionalAuth = optionalAuth;