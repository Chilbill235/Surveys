const express = require('express');
const router = express.Router();
const clickController = require('../controllers/clickController');
const demoController = require('../controllers/demoController');
const postbackController = require('../controllers/postbackController');
const paymentController = require('../controllers/paymentController');
const fraudDetection = require('../middlewares/fraudDetection');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');
const { isDemoModeEnabled, describeDemoMode } = require('../services/demoMode');
const { register: registerMethod } = require('./methodRegistry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long the public catalog may be cached.
 *
 * 30 seconds at the edge, 60 seconds of stale-while-revalidate so a
 * revalidation that lands during a cold start still serves the previous catalog
 * instead of a spinner. Set here rather than relying on `vercel.json` alone so
 * a self-hosted deploy without a CDN gets the same behaviour from the browser
 * cache, and so the caching policy lives next to the response it describes.
 *
 * If `vercel.json` still carries a `Cache-Control` for this path, remove it:
 * the runtime header supersedes the config on Vercel, and two sources for the
 * same value is how a future change to one leaves the other silently wrong.
 */
const OFFERS_CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=60';

/**
 * Postgres / network error codes that mean "the database is not reachable", as
 * opposed to "the query was wrong". Used so the catalog returns 503 during an
 * outage rather than 500, matching every other handler in the app.
 */
const DB_UNREACHABLE_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

/**
 * Whether demo offers appear in the public catalog.
 *
 * Thin alias kept so the catalog's dependency is named where it is used. The decision
 * itself lives in `src/services/demoMode.js` and is shared with the `/demo` page, the
 * completion endpoint, and the click handler, because a catalog that advertises a demo
 * offer the deployment cannot complete is worse than an empty catalog.
 */
function resolveIncludeDemo() {
    return isDemoModeEnabled();
}

// ---------------------------------------------------------------------------
// Public offer catalog
// ---------------------------------------------------------------------------

/**
 * The offer catalog, which is the only thing the landing page needs to render.
 *
 * `tracking_url` is deliberately absent. Sending it would let anyone append
 * their own aff_sub to the advertiser directly and collect credit for clicks
 * that were never recorded, which is the entire thing the tracking hop exists
 * to prevent.
 *
 * The cache header is set before the query so a slow query still produces a
 * cacheable response, and cleared on the error path so a proxy or a browser
 * never caches a transient failure for 30 seconds.
 */
async function handleListOffers(req, res) {
    res.set('Cache-Control', OFFERS_CACHE_CONTROL);

    try {
        const includeDemo = resolveIncludeDemo();
        const result = await pool.query(
            `SELECT id, title, description, payout, network_name, partner_label, is_demo, offer_type
             FROM offers
             WHERE is_active IS TRUE
               AND ($1::boolean OR is_demo IS FALSE)
             ORDER BY created_at DESC, id DESC`,
            [includeDemo]
        );

        // The count is logged on the way out so an empty catalog is never
        // silently mistaken for a working one. A 200 with `[]` and a 200 with
        // 40 rows are the same shape to a client and a very different shape to
        // an operator reading logs, and the distinction is exactly what was
        // missing while this was producing empty pages. The mode is described
        // rather than just reported because the useful question is always
        // "was that deliberate here", and the answer differs by deployment.
        if (result.rows.length === 0) {
            const mode = describeDemoMode();
            console.warn(
                `Offer catalog is empty. Demo mode is ${mode.enabled ? 'on' : 'off'} ` +
                `(from ${mode.source}, NODE_ENV=${mode.environment}). Check that the offers ` +
                'table has active rows in this database, and that OFFERS_INCLUDE_DEMO is ' +
                'set correctly for the environment.'
            );
        }

        return res.json(result.rows);
    } catch (error) {
        // The message is resolved through the pool's helper because a connection
        // failure reports an empty `AggregateError.message`; logging
        // `error.message` directly printed a bare "Offers Error:" and hid the
        // reason the catalog was down.
        console.error('Offers Error:', pool.describeError(error));

        // A failure must not be cached: a 30 second window on the error path
        // would keep serving a 503 after the database came back.
        res.set('Cache-Control', 'no-store');

        if (DB_UNREACHABLE_CODES.has(error?.code)) {
            return res.status(503).json({ error: 'This service is temporarily unavailable.' });
        }
        return res.status(500).json({ error: 'Failed to load offers' });
    }
}

router.get('/api/offers', handleListOffers);

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

router.get('/offer/engage', clickController.engageClick);
router.get('/click/:offerId', requireAuth, fraudDetection, clickController.trackClick);
router.post('/api/click/:offerId', requireAuth, fraudDetection, clickController.createClick);
router.post('/api/demo/complete', requireAuth, demoController.complete);
router.get('/api/demo/survey', requireAuth, demoController.survey);
registerMethod(/^\/api\/demo\/complete\/?$/, ['POST']);
registerMethod(/^\/api\/demo\/survey\/?$/, ['GET']);

// ---------------------------------------------------------------------------
// Server-to-server postbacks from advertiser networks
// ---------------------------------------------------------------------------

router.route('/api/postback')
    .get(postbackController.handleS2S)
    .post(postbackController.handleS2S);

// ---------------------------------------------------------------------------
// Provider webhooks
// ---------------------------------------------------------------------------

/**
 * Rejects any non-POST request to the NOWPayments IPN endpoint.
 *
 * The provider only posts, so a GET here is a misconfigured scheduler or a
 * probe. `Allow: POST` is set per RFC 7231 so a well-behaved client and a
 * scanner both see the correct method rather than a bare 405.
 *
 * Registered as an `.all()` guard rather than a `.get()` handler so PUT and
 * DELETE also receive a proper 405 rather than Express's default 404, which
 * would leave the route looking unregistered to anything that only checks
 * whether the endpoint exists.
 */
function requirePostIpn(req, res, next) {
    if (req.method === 'POST') return next();
    res.set('Allow', 'POST');
    return res.status(405).json({
        error: 'This webhook only accepts provider POST requests.',
        method: 'POST',
    });
}

router.route('/api/payments/nowpayments/ipn')
    .all(requirePostIpn)
    .post(paymentController.nowPaymentsIpn);

module.exports = router;