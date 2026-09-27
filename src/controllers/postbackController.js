const pool = require('../config/db');
const { timingSafeEqual } = require('crypto');
const { parseCents } = require('../services/money');

function hasValidSecret(req) {
    const expected = process.env.POSTBACK_SECRET;
    if (!expected) return process.env.NODE_ENV !== 'production';

    const supplied = req.get('x-postback-secret') || req.query.secret || '';
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(String(supplied));
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function normalizeStatus(status) {
    const normalized = String(status || '').toLowerCase();
    if (['1', 'approved', 'complete', 'completed'].includes(normalized)) return 'approved';
    if (['0', 'rejected', 'declined', 'failed'].includes(normalized)) return 'rejected';
    if (['pending', 'hold'].includes(normalized)) return 'pending';
    return null;
}

const postbackController = {
    handleS2S: async (req, res) => {
        if (!hasValidSecret(req)) {
            return res.status(403).send('Unauthorized postback.');
        }

        const clickId = String(req.query.click_id || req.body?.click_id || '').trim();
        const payout = parseCents(req.query.payout ?? req.body?.payout);
        const status = normalizeStatus(req.query.status ?? req.body?.status);
        if (!clickId || clickId.length > 128 || payout === null || payout < 0 || !status) {
            return res.status(400).send('Invalid postback parameters.');
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const clickCheck = await client.query(
                `SELECT clicks.user_id, offers.is_demo
                 FROM clicks
                 JOIN offers ON offers.id = clicks.offer_id
                 WHERE clicks.click_id = $1
                 FOR UPDATE OF clicks`,
                [clickId]
            );
            if (clickCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).send('Click ID not found.');
            }
            const userId = clickCheck.rows[0].user_id;
            const isDemo = clickCheck.rows[0].is_demo;
            const conversion = await client.query(
                'SELECT status FROM conversions WHERE click_id = $1',
                [clickId]
            );

            if (conversion.rows.length > 0) {
                const wasApproved = normalizeStatus(conversion.rows[0].status) === 'approved';
                if (wasApproved || status !== 'approved') {
                    await client.query('COMMIT');
                    return res.status(200).send('Already processed');
                }
                await client.query(
                    'UPDATE conversions SET payout = $1, status = $2 WHERE click_id = $3',
                    [payout, status, clickId]
                );
            } else {
                await client.query(
                    'INSERT INTO conversions (click_id, payout, status) VALUES ($1, $2, $3)',
                    [clickId, payout, status]
                );
            }

            if (status === 'approved' && userId !== null && !isDemo && payout > 0) {
                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2',
                    [payout, userId]
                );
                await client.query(
                    `INSERT INTO balance_transactions
                        (user_id, amount, transaction_type, source_id, description)
                     VALUES ($1, $2, 'conversion', $3, 'Approved offer conversion')`,
                    [userId, payout, clickId]
                );
            }

            await client.query('COMMIT');
            res.status(200).send('OK');

        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('Postback Error:', error);
            res.status(500).send('Server Error');
        } finally {
            if (client) client.release();
        }
    }
};

module.exports = postbackController;