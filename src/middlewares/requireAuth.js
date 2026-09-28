const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The issuer every token is signed with.
 *
 * `jwt.verify` accepts a token whose `iss` claim is anything at all unless this is
 * passed as an option. The issuer is not a secret and checking it is not a
 * cryptographic control, but it is the difference between "signed by us" and
 * "signed by anyone holding the same secret" -- and the second case is a
 * deployment accident rather than an attack. A shared secret between two services
 * on the same host would let a token from one authenticate against the other,
 * and the issuer claim is what tells them apart.
 */
const JWT_ISSUER = 'offer-network-api';

/**
 * The one algorithm this service signs with, and therefore the only one it will
 * verify against.
 *
 * `jsonwebtoken` accepts any algorithm named in the token's own header by default,
 * including `none`. Restricting the list is the standard mitigation for the
 * "algorithm confusion" family of vulnerabilities, and it costs nothing -- a
 * token signed with the wrong algorithm is a token this service did not issue.
 */
const JWT_ALGORITHMS = ['HS256'];

/**
 * A bound on the user id read from the token.
 *
 * The value goes to a parameterised query, so it cannot inject, but a thousand-
 * character id is not something this service ever issued and passing it to the
 * database only to have the lookup miss wastes a round trip on a hostile request.
 */
const MAX_USER_ID_LENGTH = 64;

/**
 * The user fields every authenticated request carries on `req.user`.
 *
 * Built explicitly rather than spreading the decoded payload, because spreading
 * copies every claim the token happens to hold -- including `iat`, `exp`, `iss`,
 * `sub`, and anything a future signer adds. A handler that reads `req.user.role`
 * should find a value the middleware put there, not one an attacker hoped the
 * token would carry.
 */
function buildUser(decoded, userId) {
    return {
        id: userId,
        // Preserved because handlers use it as a cache key for per-session state.
        tokenVersion: Number(decoded.ver ?? 0),
        issuedAt: decoded.iat ?? null,
        expiresAt: decoded.exp ?? null,
    };
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Reads the bearer token from the Authorization header, or returns null.
 *
 * The scheme is matched case-insensitively per RFC 7235 -- a client that sends
 * `bearer` in lowercase is correct and must not be rejected. The extracted value
 * is trimmed, because a trailing newline or space from a naive client is not a
 * different token and rejecting it produces a "invalid token" that has nothing to
 * do with the token.
 */
function readBearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || header.length === 0) return null;

    const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
    if (!match) return null;

    const token = match[1].trim();
    return token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * A refusal helper so every unauthenticated response is shaped the same way.
 *
 * Three things the ad-hoc responses got wrong:
 *
 *   - No `WWW-Authenticate` header. RFC 7235 requires it on a 401 so an HTTP
 *     client knows which scheme to use when it retries. Browsers ignore it, but
 *     SDKs and reverse proxies do not.
 *
 *   - `Cache-Control: no-store`. A 401 for a per-user endpoint must not be cached
 *     by a shared proxy, or every user behind that proxy sees the refusal.
 *
 *   - A machine-readable `code` alongside the message. A client that wants to
 *     show "your session expired, sign in again" needs to distinguish that from
 *     "your account was disabled" without parsing English. The `code` is stable;
 *     the message can change.
 */
function refuse(res, status, code, message, headers = {}) {
    res.set('Cache-Control', 'no-store');
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="rewardzone"');
    for (const [name, value] of Object.entries(headers)) res.set(name, value);
    return res.status(status).json({ error: message, code });
}

/**
 * True when the JWT library rejected the token specifically because it expired.
 *
 * `TokenExpiredError` and `JsonWebTokenError` are different classes for a reason:
 * an expired token is a normal lifecycle event and the client should be told to
 * refresh, whereas a malformed signature is a wrong token and the client should
 * be told to stop. Collapsing them into "Invalid token" leaves a client unable
 * to do the right thing with either.
 */
function isExpiredError(error) {
    return error && error.name === 'TokenExpiredError';
}

// ---------------------------------------------------------------------------
// Account lookup
// ---------------------------------------------------------------------------

/**
 * Loads the account fields session validation needs.
 *
 * Returns null when the row is missing, so the caller cannot mistake "no such
 * user" for "user is fine". A banned account is reported separately so the
 * refusal can say so, rather than collapsing into the generic invalid-token
 * message the previous version used.
 */
async function loadAccount(userId) {
    const result = await pool.query(
        'SELECT token_version, is_banned FROM users WHERE id = $1',
        [userId]
    );
    return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Verifies a bearer token and checks that it has not been revoked.
 *
 * Resetting a password bumps `users.token_version`, so a token signed before the
 * reset carries an older `ver` and is rejected here. Without this check a stolen
 * session would keep working after the owner reset their password.
 *
 * `required` is the whole difference between `requireAuth` and `optionalAuth`,
 * and it changes the behaviour in three places:
 *
 *   - no header:          rejected when required, allowed when not
 *   - malformed header:   rejected either way, because a wrong scheme is a
 *                         mistake worth surfacing, not a sign the client meant
 *                         to be anonymous
 *   - invalid/expired:    rejected when required, silently treated as anonymous
 *                         when not
 *
 * That last distinction is the one the previous version got wrong: an
 * `optionalAuth` route rejected an expired token with a 401, which made every
 * public endpoint fail for a user whose session had quietly lapsed. The point of
 * optional auth is that the endpoint works either way; a token that cannot be
 * used is not a reason to refuse a request that did not need one.
 */
async function authenticate(req, res, next, required) {
    const token = readBearerToken(req);

    if (!token) {
        // A missing Authorization header on an optional route is the normal
        // anonymous case. On a required route it is a 401 and the client is told
        // so in a way it can act on.
        if (!required) {
            req.user = null;
            return next();
        }
        return refuse(res, 401, 'missing_token', 'Authentication is required.');
    }

    if (!process.env.JWT_SECRET) {
        // Checked before verify, not after, because a misconfigured server that
        // refuses every request should say why rather than pretending the token
        // was bad.
        return refuse(res, 503, 'auth_not_configured', 'Authentication is not configured.');
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, {
            algorithms: JWT_ALGORITHMS,
            issuer: JWT_ISSUER,
        });
    } catch (error) {
        // The reason the token was rejected is logged without the token itself,
        // because a signature failure on a real user's token is often the first
        // sign of a key rotation and the log is where an operator looks for it.
        if (isExpiredError(error)) {
            if (!required) {
                req.user = null;
                return next();
            }
            return refuse(res, 401, 'token_expired', 'Your session has expired. Sign in again.');
        }
        console.warn(`Rejected a bearer token (${error.name || 'unknown'}: ${error.message}).`);
        if (!required) {
            req.user = null;
            return next();
        }
        return refuse(res, 401, 'invalid_token', 'Unauthorized. Invalid token.');
    }

    // `sub` is what the issuer sets; `id` is the shape an earlier version of the
    // signing code used, and tokens issued by it are still in circulation until
    // they expire. Both are accepted, and `sub` wins when both are present.
    const rawUserId = decoded.sub ?? decoded.id;
    if (rawUserId === undefined || rawUserId === null) {
        return refuse(res, 401, 'invalid_token', 'Token does not identify a user.');
    }

    const userId = String(rawUserId);
    if (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
        return refuse(res, 401, 'invalid_token', 'Token does not identify a user.');
    }

    // Older tokens predate revocation support and have no version claim. They are
    // treated as version 0, which matches the column default, so existing sessions
    // keep working and still become revocable after one reset. An explicit `null`
    // is treated the same way rather than being coerced by `Number(null)`, which
    // is 0 for the same reason a missing claim is -- but only by accident.
    const rawVersion = decoded.ver;
    const tokenVersion = rawVersion === undefined || rawVersion === null ? 0 : Number(rawVersion);
    if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
        return refuse(res, 401, 'invalid_token', 'Unauthorized. Invalid token.');
    }

    let account;
    try {
        account = await loadAccount(userId);
    } catch (error) {
        console.error('Session validation failed:', error.message);
        return refuse(res, 503, 'service_unavailable', 'This service is temporarily unavailable.');
    }

    if (!account) {
        // The signature was valid, so the token really was issued by this
        // service, but the account it names is gone. The message is the same as
        // any other bad token on purpose: telling a caller the account existed
        // and was deleted is a disclosure the caller has no claim to.
        return refuse(res, 401, 'invalid_token', 'Unauthorized. Invalid token.');
    }

    // Written as `=== true` rather than tested for truthiness, so a column that
    // is `NULL` is treated as "not banned" and a column that is `false` is
    // treated the same way -- matching the `is_banned IS NOT TRUE` semantics the
    // rest of the codebase uses. Reading a NULL as falsy happens to give the
    // same answer, but only because the ternary in JavaScript happens to do what
    // the SQL does; the explicit comparison is what keeps them in step.
    if (account.is_banned === true) {
        return refuse(res, 403, 'account_disabled', 'This account has been disabled.');
    }

    if (Number(account.token_version) !== tokenVersion) {
        // The client can distinguish this from an ordinary expiry because the
        // code differs. A UI that offers "sign back in" for an expired session
        // and "your password changed, sign in again" for this one is doing what
        // the two codes were separated for.
        return refuse(
            res,
            401,
            'session_revoked',
            'Your session ended because the password changed. Sign in again.'
        );
    }

    req.user = buildUser(decoded, userId);
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
// Exposed for the test suite, which needs to inspect the token reader without
// standing up a request, and for a future route that wants to know whether a
// caller is signed in without requiring them to be.
module.exports.buildUser = buildUser;
module.exports.__private = { readBearerToken, isExpiredError };