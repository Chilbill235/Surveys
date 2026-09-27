const express = require('express');
const router = express.Router();
const clickController = require('../controllers/clickController');
const demoController = require('../controllers/demoController');
const postbackController = require('../controllers/postbackController');
const paymentController = require('../controllers/paymentController');
const fraudDetection = require('../middlewares/fraudDetection');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');

/**
 * The offer catalog, which is the only thing the landing page needs to render.
 *
 * Demo offers are excluded in production. They were served unconditionally, and every one
 * of them is a dead end there: `/offer/engage` redirects a demo click to `/demo`, which
 * answers 404 in production, and `/api/demo/complete` does the same. So a production
 * visitor could browse a "Take survey" card, sign in, click it, and be sent to a 404 --
 * the catalog was advertising an offer the deployment could not honour.
 *
 * `tracking_url` is deliberately absent. Sending it would let anyone append their own
 * aff_sub to the advertiser directly and collect credit for clicks that were never
 * recorded, which is the entire thing the tracking hop exists to prevent.
 *
 * The response is short-cached by `vercel.json`. These rows are public, change rarely, and
 * are identical for every visitor, so a 30 second window removes most of the function
 * invocations the catalog costs without making a new offer feel late.
 */
router.get('/api/offers', async (req, res) => {
    try {
        const includeDemo = process.env.NODE_ENV !== 'production';
        const result = await pool.query(
            `SELECT id, title, description, payout, network_name, partner_label, is_demo, offer_type
             FROM offers
             WHERE is_active IS TRUE AND ($1::boolean OR is_demo IS FALSE)
             ORDER BY created_at DESC, id DESC`,
            [includeDemo]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Offers Error:', error.message);
        res.status(500).json({ error: 'Failed to load offers' });
    }
});

// --- Tracking & Webhook Routes ---
router.get('/offer/engage', clickController.engageClick);
router.get('/click/:offerId', requireAuth, fraudDetection, clickController.trackClick);
router.post('/api/click/:offerId', requireAuth, fraudDetection, clickController.createClick);
router.post('/api/demo/complete', requireAuth, demoController.complete);

// Handle server-to-server postbacks from advertiser networks
router.route('/api/postback')
    .get(postbackController.handleS2S)
    .post(postbackController.handleS2S);
router.route('/api/payments/nowpayments/ipn')
    .get((req, res) => res.status(405).json({
        error: 'This webhook only accepts provider POST requests.',
        method: 'POST'
    }))
    .post(paymentController.nowPaymentsIpn);

module.exports = router;