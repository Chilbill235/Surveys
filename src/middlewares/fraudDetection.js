const axios = require('axios');
const pool = require('../config/db');

/**
 * Whether a VPN/proxy check that cannot be performed should block tracking.
 *
 * This middleware used to fail closed in production, unconditionally, in two places:
 * once when `PROXYCHECK_KEY` was absent, and again when the provider was unreachable.
 * Both mean that a single unconfigured or briefly unavailable third-party integration
 * took the entire offer flow down — every click answered 503, on every offer, for every
 * user. A deployment that had never heard of proxycheck.io was 100% broken by a feature
 * that was simply not switched on, which is the opposite of what a security control
 * should do when it is not in use.
 *
 * The trade is explicit rather than implied by a `NODE_ENV` comparison:
 *
 *   - `PROXYCHECK_REQUIRED=true`  -> fail closed. Tracking is refused while the check
 *     cannot run. This is the strict posture, and it is correct when proxy traffic is a
 *     real financial exposure for this deployment.
 *   - `PROXYCHECK_REQUIRED=false` -> fail open. The click is tracked and the gap is
 *     logged. Default, because the common case is an integration that is not configured.
 *
 * What is never acceptable either way is failing silently, so a missing key and a failed
 * check each produce one distinct, quotable log line naming the consequence.
 */
function proxyCheckRequired() {
    const configured = String(process.env.PROXYCHECK_REQUIRED || '').trim().toLowerCase();
    if (configured === 'true' || configured === '1') return true;
    if (configured === 'false' || configured === '0') return false;
    return false;
}

/** Warns once per process about a missing key, so the log is not spammed per click. */
let missingKeyWarned = false;

async function fraudDetection(req, res, next) {
    const ipAddress = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const userId = req.user?.id ?? null;

    if (!userAgent || /\b(bot|crawler|spider|curl)\b/i.test(userAgent)) {
        await logFraud(userId, ipAddress, 'Bot User-Agent Detected');
        return res.status(403).send('Access denied.');
    }

    if (process.env.PROXYCHECK_KEY && ipAddress) {
        try {
            const vpnCheck = await axios.get(
                `https://proxycheck.io/v2/${encodeURIComponent(ipAddress)}`,
                {
                    params: { vpn: 1, key: process.env.PROXYCHECK_KEY },
                    timeout: 3000
                }
            );
            const ipData = vpnCheck.data[ipAddress];

            if (ipData?.proxy === 'yes') {
                await logFraud(userId, ipAddress, `VPN/Proxy Detected: ${ipData.type || 'unknown'}`);
                return res.status(403).send('VPNs and proxies are not allowed.');
            }
        } catch (error) {
            console.error('Proxy check unavailable:', error.message);
            if (proxyCheckRequired()) {
                return res.status(503).send('Fraud checks are temporarily unavailable.');
            }
            // The refusal is recorded so the gap is auditable after the fact rather than
            // only visible in a log line nobody is watching.
            await logFraud(userId, ipAddress, 'Proxy check unavailable; click allowed (PROXYCHECK_REQUIRED is not set)');
        }
    } else if (!process.env.PROXYCHECK_KEY) {
        if (proxyCheckRequired()) {
            // Asked to fail closed but cannot: say so, because the difference between
            // "blocked by policy" and "refused by misconfiguration" matters when the
            // whole catalog is returning 503.
            console.error('PROXYCHECK_REQUIRED is set but PROXYCHECK_KEY is missing, so every click is being refused.');
            return res.status(503).send('Fraud checks are not configured.');
        }
        if (!missingKeyWarned) {
            missingKeyWarned = true;
            console.warn(
                'PROXYCHECK_KEY is not set, so VPN/proxy checks are not running. Clicks are ' +
                'being tracked without them. Set PROXYCHECK_KEY to enable the check, and ' +
                'PROXYCHECK_REQUIRED=true if tracking should be refused while it is unavailable.'
            );
        }
    }

    try {
        const clickVelocity = await pool.query(
            `SELECT COUNT(*) FROM clicks WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
            [ipAddress]
        );

        if (Number(clickVelocity.rows[0].count) >= 10) {
            await logFraud(userId, ipAddress, 'High Click Velocity');
            return res.status(429).send('Too many requests.');
        }

    } catch (error) {
        console.error('Click velocity check failed:', error.message);
        return res.status(503).send('Tracking is temporarily unavailable.');
    }

    return next();
}

async function logFraud(userId, ip, reason) {
    try {
        await pool.query(
            `INSERT INTO fraud_logs (user_id, ip_address, reason) VALUES ($1, $2, $3)`,
            [userId || null, ip, reason]
        );
    } catch (err) {
        console.error('Failed to log fraud:', err.message);
    }
}

module.exports = fraudDetection;
module.exports.proxyCheckRequired = proxyCheckRequired;