const express = require('express');
const router = express.Router();
const clickController = require('../controllers/clickController');
const demoController = require('../controllers/demoController');
const postbackController = require('../controllers/postbackController');
const paymentController = require('../controllers/paymentController');
const fraudDetection = require('../middlewares/fraudDetection');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');

// --- Frontend Data Routes ---
router.get('/api/offers', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, title, payout, network_name, is_demo, offer_type
             FROM offers
             WHERE is_active IS TRUE
             ORDER BY created_at DESC, id DESC`
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