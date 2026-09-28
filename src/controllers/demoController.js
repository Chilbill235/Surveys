const pool = require('../config/db');
const { isDemoModeEnabled } = require('../services/demoMode');
const { loadSurveyQuestions, answersAreValid, sanitiseAnswers } = require('../services/surveyService');

const clickIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

const demoController = {
    /**
     * The survey the page should render.
     *
     * Served from the database rather than embedded in the page script so the questions the
     * user is asked and the answers the server will accept cannot drift apart. Requires a
     * session, like completion does, because it is only reachable by following a click and
     * there is nothing useful to show without one.
     */
    survey: async (req, res) => {
        if (!isDemoModeEnabled()) {
            return res.status(404).json({ error: 'Demo rewards are not available in this deployment.' });
        }
        try {
            const questions = await loadSurveyQuestions();
            return res.json({ questions });
        } catch (error) {
            console.error('Could not load survey questions:', error.message);
            return res.status(500).json({ error: 'Could not load the survey.' });
        }
    },

    complete: async (req, res) => {
        // Same gate as the catalog and the demo page. When this rejected while the catalog
        // showed the offer, a user could complete the survey and be told the reward did not
        // exist, having already spent the time.
        if (!isDemoModeEnabled()) {
            return res.status(404).json({ error: 'Demo rewards are not available in this deployment.' });
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
            // Loaded once here and used for both the check and the stored payload, so what is
            // validated and what is recorded cannot be two different definitions.
            const questions = offer.offer_type === 'survey' ? await loadSurveyQuestions() : null;
            if (offer.offer_type === 'survey') {
                if (!await answersAreValid(answers, questions)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Answer every question before submitting.' });
                }
            } else if (answers?.completed !== true) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Complete the demo task before submitting.' });
            }

            // Only the questions that were actually asked are kept. An unrecognised key is
            // dropped rather than written into `details` as if it were an answer.
            const recorded = questions ? sanitiseAnswers(answers, questions) : { completed: true };

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
                [clickId, payout, JSON.stringify(recorded)]
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
