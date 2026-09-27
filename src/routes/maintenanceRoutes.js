const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const router = express.Router();
const { reconcilePendingDeposits } = require('../services/depositReconciliation');
const { listUnresolvedWithdrawals, sendWithdrawal, reverseWithdrawal } = require('../services/withdrawalResolution');
const ipnLog = require('../services/ipnLog');
const nowPayments = require('../services/nowPayments');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('../services/publicBaseUrl');

const routePath = '/api/maintenance/reconcile-deposits';
const ipnDiagnosticsPath = '/api/maintenance/ipn-diagnostics';
const withdrawalsPath = '/api/maintenance/withdrawals';

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


/**
 * Withdrawal review: the operator side of a request the user has already been charged for.
 *
 * The balance is debited the moment a withdrawal is requested, so a request that is never
 * resolved -- rejected, or actually sent to the destination -- leaves the user short by
 * that amount and the row sitting in `pending` forever. Before these endpoints existed the
 * only way out was to edit the table by hand, which is how a withdrawal ends up marked
 * `failed` with the money still debited: the status says one thing and the ledger another,
 * and nothing in the app can detect or repair it.
 *
 * Both actions are single-shot and order-dependent, and the state they act on is the only
 * record that the money moved, so a repeat is reported rather than repeated. `409` is used
 * for "already in a state that cannot move" because the request was understood and the
 * answer is genuinely about the current state, and a `200` there would read as success.
 */
const withdrawalIdPattern = /^\d+$/;

function withdrawalId(req) {
    const id = String(req.params.id || '');
    return withdrawalIdPattern.test(id) ? id : null;
}

async function handleListWithdrawals(req, res) {
    if (!enforceAccess(req, res)) return;
    try {
        return res.json({ ok: true, withdrawals: await listUnresolvedWithdrawals() });
    } catch (error) {
        console.error('Could not list withdrawals:', error.message);
        return res.status(500).json({ ok: false, error: 'Could not list withdrawals.' });
    }
}

/** Maps the service's refusal reasons onto a status and a message an operator can act on. */
function describeRefusal(result) {
    if (result.reason === 'not-found') {
        return { status: 404, error: 'No such withdrawal.' };
    }
    if (result.reason === 'already-paid') {
        return { status: 409, error: 'That withdrawal is already marked as paid; it cannot be reversed here.' };
    }
    if (result.reason === 'missing-reference') {
        return { status: 400, error: 'A provider reference is required to mark a withdrawal as paid.' };
    }
    if (result.reason === 'reference-too-long') {
        return { status: 400, error: 'That provider reference is too long.' };
    }
    return {
        status: 409,
        error: `That withdrawal is already ${String(result.reason).replace(/^already-/, '')}.`
    };
}

async function handleMarkPaid(req, res) {
    if (!enforceAccess(req, res)) return;
    const id = withdrawalId(req);
    if (!id) return res.status(404).json({ error: 'No such withdrawal.' });

    try {
        const result = await sendWithdrawal(id, req.body?.providerReference);
        if (!result.changed) {
            const refusal = describeRefusal(result);
            return res.status(refusal.status).json({ ok: false, error: refusal.error });
        }
        return res.json({ ok: true, withdrawal: result.withdrawal });
    } catch (error) {
        console.error(`Could not mark withdrawal ${id} paid:`, error.message);
        return res.status(500).json({ ok: false, error: 'Could not update the withdrawal.' });
    }
}

async function handleRefund(req, res) {
    if (!enforceAccess(req, res)) return;
    const id = withdrawalId(req);
    if (!id) return res.status(404).json({ error: 'No such withdrawal.' });

    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
        // The reason is written to the user's withdrawal history, so it is required rather
        // than defaulted: "rejected" with no explanation is the version that generates a
        // support ticket.
        return res.status(400).json({ ok: false, error: 'A reason is required so the user can see why.' });
    }

    try {
        const result = await reverseWithdrawal(id, reason);
        if (!result.changed) {
            const refusal = describeRefusal(result);
            return res.status(refusal.status).json({ ok: false, error: refusal.error });
        }
        return res.json({ ok: true, withdrawal: result.withdrawal, refunded: result.refunded, balance: result.balance });
    } catch (error) {
        console.error(`Could not refund withdrawal ${id}:`, error.message);
        return res.status(500).json({ ok: false, error: 'Could not refund the withdrawal.' });
    }
}

router.get(withdrawalsPath, handleListWithdrawals);
router.post(`${withdrawalsPath}/:id/paid`, handleMarkPaid);
router.post(`${withdrawalsPath}/:id/refund`, handleRefund);

module.exports = router;
module.exports.routePath = routePath;
module.exports.ipnDiagnosticsPath = ipnDiagnosticsPath;
module.exports.withdrawalsPath = withdrawalsPath;
module.exports.secretsMatch = secretsMatch;
module.exports.callerAllowed = callerAllowed;
