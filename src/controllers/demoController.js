const pool = require('../config/db');

const clickIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const favoriteOptions = new Set(['games', 'shopping', 'learning']);
const frequencyOptions = new Set(['daily', 'weekly', 'rarely']);

function validAnswers(offerType, answers) {
    if (offerType === 'survey') {
        return favoriteOptions.has(answers?.favorite) && frequencyOptions.has(answers?.frequency);
    }
    return answers?.completed === true;
}

const demoController = {
    complete: async (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            return res.status(404).json({ error: 'Demo rewards are disabled.' });
        }

        const clickId = String(req.body.clickId || '').trim();
        const answers = req.body.answers;
        if (!clickIdPattern.test(clickId) || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
            return res.status(400).json({ error: 'Invalid demo completion.' });
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const click = await client.query(
                `SELECT clicks.user_id, offers.is_demo, offers.offer_type, offers.payout
                 FROM clicks
                 JOIN offers ON offers.id = clicks.offer_id
                 WHERE clicks.click_id = $1 AND clicks.user_id = $2
                 FOR UPDATE OF clicks`,
                [clickId, req.user.id]
            );
            if (click.rows.length === 0 || click.rows[0].is_demo !== true) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Demo click not found.' });
            }

            const offer = click.rows[0];
            if (!validAnswers(offer.offer_type, answers)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Complete the demo task before submitting.' });
            }

            const priorConversion = await client.query(
                'SELECT status FROM conversions WHERE click_id = $1',
                [clickId]
            );
            if (priorConversion.rows.length > 0) {
                const user = await client.query(
                    'SELECT demo_balance FROM users WHERE id = $1',
                    [req.user.id]
                );
                await client.query('COMMIT');
                return res.json({
                    alreadyCompleted: true,
                    demoBalance: user.rows[0].demo_balance,
                    cashValue: false
                });
            }

            const payout = Number(offer.payout);
            if (!Number.isFinite(payout) || payout <= 0) {
                throw new Error('Demo reward is invalid.');
            }

            await client.query(
                `INSERT INTO conversions (click_id, payout, status, details)
                 VALUES ($1, $2, 'approved', $3::jsonb)`,
                [clickId, payout, JSON.stringify(answers)]
            );
            const updatedUser = await client.query(
                'UPDATE users SET demo_balance = demo_balance + $1 WHERE id = $2 RETURNING demo_balance',
                [payout, req.user.id]
            );
            // This row lands in the same table as the cash ledger even though it moves
            // `demo_balance` and never touches `balance`, so it is flagged rather than
            // identified by its description: the flag is what makes "balance equals the
            // sum of my cash ledger" a query, and the description is free text an operator
            // can edit.
            await client.query(
                `INSERT INTO balance_transactions
                    (user_id, amount, transaction_type, source_id, description, is_demo)
                 VALUES ($1, $2, 'adjustment', $3, 'Non-cash demo reward', TRUE)`,
                [req.user.id, payout, `demo:${clickId}`]
            );

            await client.query('COMMIT');
            return res.json({
                credited: payout,
                demoBalance: updatedUser.rows[0].demo_balance,
                cashValue: false
            });
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('Demo completion error:', error.message);
            return res.status(500).json({ error: 'Could not complete this demo task.' });
        } finally {
            if (client) client.release();
        }
    }
};

module.exports = demoController;
