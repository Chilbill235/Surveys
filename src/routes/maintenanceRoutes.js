const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const router = express.Router();
const { reconcilePendingDeposits } = require('../services/depositReconciliation');
const ipnLog = require('../services/ipnLog');
const nowPayments = require('../services/nowPayments');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('../services/publicBaseUrl');

const routePath = '/api/maintenance/reconcile-deposits';
const ipnDiagnosticsPath = '/api/maintenance/ipn-diagnostics';

/** True when the request came from this machine. */
function isLoopbackRequest(req) {
    const address = req.socket?.remoteAddress || '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Whether this caller may use a maintenance endpoint.
 *
 * The secret gate is right for production and useless for the thing these endpoints are
 * actually for. Reconciling a stuck deposit by hand and checking whether callbacks are
 * arriving are operator jobs done on the machine running the app, and asking for a secret
 * that is deliberately not set in development produced an undiscoverable
 * `{"error":"Page not found."}` -- which is indistinguishable from the route not existing,
 * and is exactly how a stuck deposit ended up looking like a provider fault.
 *
 * So outside production the gate is "this request came from loopback", which cannot be
 * satisfied from off the machine. In production both must hold: a configured secret and a
 * matching one. A missing secret in production still answers 503 rather than 404, so the
 * difference between "unset" and "wrong" stays visible to whoever is setting it up.
 */
function callerAllowed(req) {
    if (process.env.NODE_ENV === 'production') {
        const expected = process.env.CRON_SECRET;
        if (!expected) return { allowed: false, status: 503, reason: 'unset' };
        return secretsMatch(readProvidedSecret(req), expected)
            ? { allowed: true }
            : { allowed: false, status: 404, reason: 'mismatch' };
    }
    return isLoopbackRequest(req)
        ? { allowed: true }
        : { allowed: false, status: 403, reason: 'not-local' };
}

/**
 * Shared refusal/allowance handling for both maintenance routes.
 *
 * Returns true when the caller may proceed, and false when it has already been answered.
 * It must not return the response object: `res.json()` resolves to the response, which is
 * truthy, so a caller written as `if (!enforceAccess(...)) return;` would sail straight
 * past the refusal and try to send a second response -- which Express reports as
 * "Cannot set headers after they are sent".
 */
function enforceAccess(req, res) {
    const decision = callerAllowed(req);
    if (decision.allowed) return true;

    if (decision.reason === 'unset') {
        console.error(
            'CRON_SECRET is not set, so the maintenance endpoints cannot authenticate a caller. ' +
            'Scheduled deposit reconciliation will not run until it is set.'
        );
        res.status(503).json({
            error: 'Maintenance endpoints are not configured.',
            detail: 'Set CRON_SECRET in the environment to enable them in production.'
        });
        return false;
    }
    if (decision.reason === 'not-local') {
        res.status(403).json({
            error: 'Maintenance endpoints are only available from this machine outside production.'
        });
        return false;
    }
    // Wrong secret: keep it undiscoverable, exactly as a wrong URL behaves.
    res.status(404).json({ error: 'Page not found.' });
    return false;
}

/** Length-safe, timing-safe shared-secret comparison. */
function secretsMatch(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
    const supplied = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (supplied.length !== expectedBuffer.length) return false;
    return timingSafeEqual(supplied, expectedBuffer);
}

/**
 * Reads the secret from wherever the caller put it.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The header and query forms
 * exist so the endpoint can also be triggered by hand from a terminal or another
 * scheduler without changing the method.
 */
function readProvidedSecret(req) {
    const authorization = req.get('authorization') || '';
    if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
    return req.get('x-cron-secret') || req.query.secret || '';
}

/**
 * Scheduled recovery endpoint for deposits whose provider callback never arrived.
 *
 * A missing CRON_SECRET used to answer 404, the same as a wrong URL. That is the
 * correct response for a *wrong* secret, since it keeps the endpoint undiscoverable,
 * but it is actively misleading when the secret was simply never configured: an
 * operator following the URL in vercel.json saw "Page not found." and concluded the
 * route did not exist. The two cases are now separated, and an unconfigured server
 * says exactly what to set.
 */
async function handleReconcile(req, res) {
    if (!enforceAccess(req, res)) return;

    try {
        const summary = await reconcilePendingDeposits({ limit: 50 });
        return res.json({ ok: true, summary });
    } catch (error) {
        console.error('Scheduled deposit reconciliation failed:', error.message);
        return res.status(500).json({ ok: false, error: 'Reconciliation failed.' });
    }
}

// Vercel Cron issues GET requests. POST is also accepted so the endpoint can be
// triggered manually from a script that prefers to send a body.
router.get(routePath, handleReconcile);
router.post(routePath, handleReconcile);

/**
 * Reports whether provider callbacks are actually arriving.
 *
 * "The IPN is not being sent" and "the IPN is being sent and we are rejecting it" produce
 * exactly the same symptom from the dashboard: the balance does not move. This endpoint
 * separates them. An empty record with a null `lastReceivedAt` means nothing has ever
 * arrived, which almost always means the callback URL is not reachable from the internet
 * (a localhost APP_BASE_URL) rather than that the provider is broken.
 *
 * Guarded by the same CRON_SECRET as reconciliation, and answers 404 for a wrong secret
 * so it is not discoverable. It exposes no signature, secret, or wallet address -- only
 * counts, timestamps, payment ids, and the reason a callback was refused.
 */
function handleIpnDiagnostics(req, res) {
    if (!enforceAccess(req, res)) return;

    const publicBaseUrl = resolvePublicBaseUrl();
    return res.json({
        ok: true,
        callbacks: ipnLog.snapshot(),
        configuration: {
            publicBaseUrl: publicBaseUrl.ok ? publicBaseUrl.baseUrl.origin : null,
            // The single most common cause of "no callbacks arrive": the provider posts to
            // this origin and cannot resolve it, so the delivery fails before it starts.
            publiclyReachable: publicBaseUrl.ok && isPubliclyReachable(publicBaseUrl.baseUrl),
            ipnSecretConfigured: Boolean(nowPayments.getIpnSecret()),
            apiKeyConfigured: nowPayments.isConfigured(),
            apiBaseUrl: nowPayments.getBaseUrl()
        }
    });
}

router.get(ipnDiagnosticsPath, handleIpnDiagnostics);
router.post(ipnDiagnosticsPath, handleIpnDiagnostics);

module.exports = router;
module.exports.routePath = routePath;
module.exports.ipnDiagnosticsPath = ipnDiagnosticsPath;
module.exports.secretsMatch = secretsMatch;
module.exports.callerAllowed = callerAllowed;
