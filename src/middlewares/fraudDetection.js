const axios = require('axios');
const pool = require('../config/db');

async function fraudDetection(req, res, next) {
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const userId = req.user?.id ?? null;

    if (!userAgent || /\b(bot|crawler|spider|curl)\b/i.test(userAgent)) {
        await logFraud(userId, ipAddress, 'Bot User-Agent Detected');
        return res.status(403).send('Access denied.');
    }

    if (process.env.NODE_ENV === 'production' && !process.env.PROXYCHECK_KEY) {
        return res.status(503).send('Fraud checks are not configured.');
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
            if (process.env.NODE_ENV === 'production') {
                return res.status(503).send('Fraud checks are temporarily unavailable.');
            }
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