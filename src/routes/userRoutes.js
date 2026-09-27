const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');
const paymentController = require('../controllers/paymentController');
const { rateLimitByIp } = require('../services/security');

// All routes here require a valid JWT token
router.use(requireAuth);

// Creating a deposit calls a paid third-party API and writes a row for every attempt.
// Unthrottled, one client could drive a large volume of provider requests and leave a
// trail of unusable deposit rows, so it carries the same per-IP limit as the auth
// endpoints. The limiter runs after `requireAuth`, so only the address is available to
// key on; that is the same trade-off the login limiter already makes.
const depositLimit = rateLimitByIp({ name: 'create-deposit', maxAttempts: 10, windowSeconds: 15 * 60 });

router.get('/balance', async (req, res) => {
	try {
		const result = await pool.query(
			'SELECT balance, demo_balance FROM users WHERE id = $1',
			[req.user.id]
		);
		if (result.rows.length === 0) {
			return res.status(404).json({ error: 'User not found.' });
		}
		return res.json({
			balance: result.rows[0].balance,
			demoBalance: result.rows[0].demo_balance
		});
	} catch (error) {
		console.error('Balance Error:', error.message);
		return res.status(500).json({ error: 'Failed to load balance.' });
	}
});

router.get('/withdrawals', async (req, res) => {
	try {
		// The destination is included so the user can confirm a request was recorded
		// against the address they intended, which is the mistake that is hardest to
		// reverse once an operator has paid it.
		//
		// `failure_reason` and `refunded_at` are included because a rejected withdrawal has
		// the money returned to the balance, and a refund the user cannot account for is the
		// same support question as a withdrawal that never arrived. Whether a refund
		// actually happened is read from the ledger rather than inferred from the status:
		// a row edited outside the app can say `failed` with no refund behind it, and
		// telling the user it was returned in that case would be a lie about their money.
		const result = await pool.query(
			`SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
			        w.status, w.failure_reason, w.created_at, w.paid_at,
			        r.created_at AS refunded_at
			 FROM withdrawals w
			 LEFT JOIN balance_transactions r
			        ON r.transaction_type = 'refund'
			        AND r.source_id = 'withdrawal:' || w.id::TEXT
			        AND r.user_id = w.user_id
			 WHERE w.user_id = $1
			 ORDER BY w.created_at DESC
			 LIMIT 20`,
			[req.user.id]
		);
		return res.json(result.rows);
	} catch (error) {
		console.error('Withdrawal history error:', error.message);
		return res.status(500).json({ error: 'Failed to load withdrawal history.' });
	}
});

router.get('/deposits', async (req, res) => {
	try {
		const result = await pool.query(
			`SELECT id, amount, asset_code, currency_code, network, deposit_address, checkout_url, status, created_at
			 FROM deposits
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT 20`,
			[req.user.id]
		);
		return res.json(result.rows.map(withReceiptUrl));
	} catch (error) {
		console.error('Deposit history error:', error.message);
		return res.status(500).json({ error: 'Failed to load deposit history.' });
	}
});

/**
 * One deposit, for its own receipt screen.
 *
 * A crypto deposit has no provider checkout to redirect to -- the customer is shown an
 * address and leaves the site -- so there was no page to send anyone back to afterwards,
 * and the only record of a $5,000 XRP deposit was a row of JSON. This is what a
 * "view your deposit" link points at, and what the standalone receipt page polls.
 *
 * Scoped to the owner, so an id alone reveals nothing. Returns 404 rather than 403 for
 * someone else's deposit, so the response does not confirm that the id exists.
 */
router.get('/deposits/:id', async (req, res) => {
	const depositId = String(req.params.id);
	if (!/^\d+$/.test(depositId)) {
		return res.status(404).json({ error: 'Deposit not found.' });
	}
	try {
		const result = await pool.query(
			`SELECT id, amount, asset_code, currency_code, network, deposit_address, checkout_url,
			        status, credited_at, created_at
			 FROM deposits
			 WHERE id = $1 AND user_id = $2`,
			[depositId, req.user.id]
		);
		if (result.rows.length === 0) {
			return res.status(404).json({ error: 'Deposit not found.' });
		}
		return res.json(withReceiptUrl(result.rows[0]));
	} catch (error) {
		console.error('Deposit lookup error:', error.message);
		return res.status(500).json({ error: 'Failed to load the deposit.' });
	}
});

/**
 * Adds the link a confirmed deposit can be viewed at.
 *
 * Built from the request's own origin rather than a configured base URL, because the
 * receipt is a link the current user follows right now, in this browser. A stored
 * APP_BASE_URL is what provider callbacks are built from, which is a different question
 * and can legitimately be a tunnel while the user is on localhost.
 */
function withReceiptUrl(deposit) {
	return { ...deposit, receipt_url: `/deposit/${deposit.id}` };
}

router.get('/payment-options', paymentController.providerOptions);
router.get('/withdrawal-options', payoutController.withdrawalOptions);
router.post('/deposits', depositLimit, paymentController.createDeposit);
router.post('/withdraw', depositLimit, payoutController.requestWithdrawal);

module.exports = router;