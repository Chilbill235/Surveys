const pool = require('../config/db');

/**
 * Database-backed fixed-window rate limiter.
 *
 * Auth endpoints are rate limited per IP and (for password reset) per email. The
 * counter cannot live in process memory: on Vercel every instance has its own memory
 * and instances are created and destroyed freely, so an in-memory counter both
 * resets unpredictably and fails to cover the other instances.
 *
 * Fails closed: when the counter cannot be read or written, the request is denied
 * rather than allowed, so an attacker cannot disable throttling by inducing errors.
 */
async function consumeRateLimit({ bucket, maxAttempts, windowSeconds }) {
    const result = await pool.query(
        `INSERT INTO auth_rate_limits (bucket, attempt_count, window_started_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (bucket) DO UPDATE
             SET attempt_count = CASE
                     WHEN auth_rate_limits.window_started_at < NOW() - ($2 * INTERVAL '1 second') THEN 1
                     ELSE auth_rate_limits.attempt_count + 1
                 END,
                 window_started_at = CASE
                     WHEN auth_rate_limits.window_started_at < NOW() - ($2 * INTERVAL '1 second') THEN NOW()
                     ELSE auth_rate_limits.window_started_at
                 END
         RETURNING attempt_count, window_started_at`,
        [bucket, windowSeconds]
    );

    const attemptCount = Number(result.rows[0].attempt_count);
    const windowStartedAt = new Date(result.rows[0].window_started_at).getTime();
    const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStartedAt + windowSeconds * 1000 - Date.now()) / 1000)
    );

    return { allowed: attemptCount <= maxAttempts, attemptCount, retryAfterSeconds };
}

/**
 * Express middleware that rate limits by client IP plus route name.
 */
function rateLimitByIp({ name, maxAttempts, windowSeconds }) {
    return async (req, res, next) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        try {
            const result = await consumeRateLimit({
                bucket: `${name}:ip:${ip}`,
                maxAttempts,
                windowSeconds
            });
            if (!result.allowed) {
                res.set('Retry-After', String(result.retryAfterSeconds));
                return res.status(429).json({ error: 'Too many attempts. Try again later.' });
            }
            return next();
        } catch (error) {
            console.error('Rate limit check failed:', error.message);
            return res.status(503).json({ error: 'This service is temporarily unavailable.' });
        }
    };
}

module.exports = { consumeRateLimit, rateLimitByIp };

