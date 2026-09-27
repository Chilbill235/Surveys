const pool = require('../config/db');
const { createHmac, timingSafeEqual } = require('crypto');
const { parseCents } = require('../services/money');

/**
 * Validates postback authentication headers/query against configured secrets using
 * fixed-length digest timing-safe comparison to mitigate buffer length leaks.
 */
function hasValidSecret(req) {
    const expected = process.env.POSTBACK_SECRET;
    if (!expected) return process.env.NODE_ENV !== 'production';

    const supplied = req.get('x-postback-secret') || req.query.secret || '';
    if (!supplied) return false;

    // Normalize buffers using HMAC-SHA256 to guarantee matching byte lengths before timingSafeEqual
    const hmacExpected = createHmac('sha256', 'postback-salt').update(expected).digest();
    const hmacSupplied = createHmac('sha256', 'postback-salt').update(String(supplied)).digest();

    return timingSafeEqual(hmacExpected, hmacSupplied);
}

/**
 * Normalizes provider status strings to canonical application states.
 */
function normalizeStatus(status) {
    const normalized = String(status || '').toLowerCase().trim();
    if (['1', 'approved', 'complete', 'completed', 'success'].includes(normalized)) return 'approved';
    if (['0', 'rejected', 'declined', 'failed', 'reversed', 'chargeback'].includes(normalized)) return 'rejected';
    if (['pending', 'hold', 'paused'].includes(normalized)) return 'pending';
    return null;
}

const postbackController = {
    handleS2S: async (req, res) => {
        if (!hasValidSecret(req)) {
            return res.status(403).send('Unauthorized postback.');
        }

        const clickId = String(req.query.click_id || req.body?.click_id || '').trim();
        const payout = parseCents(req.query.payout ?? req.body?.payout);
        const newStatus = normalizeStatus(req.query.status ?? req.body?.status);

        if (!clickId || clickId.length > 128 || payout === null || payout < 0 || !newStatus) {
            return res.status(400).send('Invalid postback parameters.');
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            // 1. Fetch & lock click record
            const clickRes = await client.query(
                `SELECT clicks.user_id, offers.is_demo
                 FROM clicks
                 JOIN offers ON offers.id = clicks.offer_id
                 WHERE clicks.click_id = $1
                 FOR UPDATE OF clicks`,
                [clickId]
            );

            if (clickRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).send('Click ID not found.');
            }

            const { user_id: userId, is_demo: isDemo } = clickRes.rows[0];

            // 2. Fetch & lock existing conversion record
            const convRes = await client.query(
                `SELECT payout, status FROM conversions WHERE click_id = $1 FOR UPDATE`,
                [clickId]
            );

            const existingConv = convRes.rows[0] || null;
            const oldStatus = existingConv ? normalizeStatus(existingConv.status) : null;
            const oldPayout = existingConv ? Number(existingConv.payout) : 0;

            // 3. Upsert conversion state
            if (existingConv) {
                await client.query(
                    `UPDATE conversions 
                     SET payout = $1, status = $2, updated_at = NOW() 
                     WHERE click_id = $3`,
                    [payout, newStatus, clickId]
                );
            } else {
                await client.query(
                    `INSERT INTO conversions (click_id, payout, status) 
                     VALUES ($1, $2, $3)`,
                    [clickId, payout, newStatus]
                );
            }

            // 4. Balance ledger operations (skip for demo offers or non-user clicks)
            const isEligibleUser = userId !== null && !isDemo;

            if (isEligibleUser) {
                // CASE A: State transitions into 'approved' (Credit User)
                if (newStatus === 'approved' && oldStatus !== 'approved' && payout > 0) {
                    await client.query(
                        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
                        [payout, userId]
                    );

                    await client.query(
                        `INSERT INTO balance_transactions
                            (user_id, amount, transaction_type, source_id, description)
                         VALUES ($1, $2, 'conversion', $3, 'Approved offer conversion')`,
                        [userId, payout, clickId]
                    );
                } 
                // CASE B: State transitions FROM 'approved' TO 'rejected/pending' (Reversal / Chargeback)
                else if (oldStatus === 'approved' && newStatus !== 'approved' && oldPayout > 0) {
                    await client.query(
                        `UPDATE users SET balance = balance - $1 WHERE id = $2`,
                        [oldPayout, userId]
                    );

                    await client.query(
                        `INSERT INTO balance_transactions
                            (user_id, amount, transaction_type, source_id, description)
                         VALUES ($1, $2, 'chargeback', $3, 'Reversed/Chargebacked offer conversion')`,
                        [userId, -oldPayout, clickId]
                    );
                }
            }

            await client.query('COMMIT');
            return res.status(200).send('OK');

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
            }
            console.error('S2S Postback Error:', error);
            return res.status(500).send('Server Error');
        } finally {
            if (client) {
                client.release();
            }
        }
    }
};

module.exports = postbackController;