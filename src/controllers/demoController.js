/**
 * Where the participant is returned to after completion.
 *
 * The offer's own `completion_url` wins when it is set, because the redirect is part of the
 * offer rather than of the page: an offer added without editing the page script used to send
 * everyone back to the catalog, which is a silent loss of the audience that offer paid for.
 * The catalog is the fallback, and it is never a value from the request, because an open
 * redirect built from a URL parameter is a way to make this page's "return to RewardZone"
 * link land somewhere else wearing its name.
 */
function resolveCompletionUrl(offer) {
    const fallback = '/offers';
    const candidate = String(offer?.completion_url || '').trim();
    if (!candidate) return fallback;
    try {
        const url = new URL(candidate, 'http://localhost');
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
        if (url.username || url.password) return fallback;
        // Only a same-origin path is allowed. A fully-qualified URL here would be an open
        // redirect, which is exactly what the fallback exists to avoid.
        if (candidate.startsWith('//') || /^https?:\/\//i.test(candidate)) return fallback;
        if (!candidate.startsWith('/')) return fallback;
        return candidate;
    } catch {
        return fallback;
    }
}

const pool = require('../config/db');
const { isDemoModeEnabled } = require('../services/demoMode');
const { loadSurveyQuestions, answersAreValid, sanitiseAnswers } = require('../services/surveyService');
const { loadOfferTaskSteps, taskStepsAreValid } = require('../services/offerTaskSteps');

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
            // The click carries the offer id, which is what decides whether this is a survey
            // or a task. Returning both shapes lets the page ask for one without a second
            // round trip, and the server is what decides which one to render.
            const clickId = String(req.query.clickId || '').trim();
            const click = clickIdPattern.test(clickId)
                ? await pool.query(
                    `SELECT clicks.offer_id, offers.offer_type
                     FROM clicks
                     JOIN offers ON offers.id = clicks.offer_id
                     WHERE clicks.click_id = $1 AND clicks.user_id = $2`,
                    [clickId, req.user.id]
                )
                : { rows: [] };

            const offerType = click.rows[0]?.offer_type || 'survey';
            const questions = offerType === 'survey' ? await loadSurveyQuestions() : null;
            const steps = offerType !== 'survey'
                ? await loadOfferTaskSteps(click.rows[0]?.offer_id)
                : null;

            return res.json({
                offerType,
                questions,
                steps
            });
        } catch (error) {
            console.error('Could not load demo questions:', error.message);
            return res.status(500).json({ error: 'Could not load the demo task.' });
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
                `SELECT clicks.user_id, offers.is_demo, offers.offer_type, offers.payout,
                        offers.pays_real_money, offers.completion_url
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
            const steps = offer.offer_type !== 'survey' ? await loadOfferTaskSteps(offer.id) : null;
            if (offer.offer_type === 'survey') {
                if (!await answersAreValid(answers, questions)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Answer every question before submitting.' });
                }
            } else {
                if (!taskStepsAreValid(answers, steps)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Tick every step before submitting.' });
                }
            }

            // Only the questions that were actually asked are kept. An unrecognised key is
            // dropped rather than written into `details` as if it were an answer.
            const recorded = questions ? sanitiseAnswers(answers, questions) : { completed: true };
            if (steps) {
                // The step positions that were ticked, so the completion record says which
                // steps were done rather than just that the task was done.
                recorded.completed = true;
                recorded.steps = steps.map((step) => ({
                    position: step.position,
                    actionLabel: step.actionLabel,
                    ticked: answers[step.position] === true
                }));
            }

            const priorConversion = await client.query(
                'SELECT status FROM conversions WHERE click_id = $1',
                [clickId]
            );
            if (priorConversion.rows.length > 0) {
                const user = await client.query(
                    'SELECT demo_balance, balance FROM users WHERE id = $1',
                    [req.user.id]
                );
                await client.query('COMMIT');
                return res.json({
                    alreadyCompleted: true,
                    demoBalance: user.rows[0].demo_balance,
                    balance: user.rows[0].balance,
                    cashValue: false,
                    returnTo: resolveCompletionUrl(offer)
                });
            }

            const payout = Number(offer.payout);
            if (!Number.isFinite(payout) || payout <= 0) {
                throw new Error('Demo reward is invalid.');
            }

            // A demo offer can pay real money. This is opt-in and off by default: a deployment
            // that never sets OFFERS_TEST_REAL=true still cannot move cash through the demo
            // flow, which is the whole point of the flag. Without it every demo completion is a
            // non-cash credit to demo_balance, and the flag is what lets a test environment
            // turn that into a real balance move for verifying payouts end to end.
            const paysReal = offer.pays_real_money === true
                && process.env.OFFERS_TEST_REAL === 'true';

            await client.query(
                `INSERT INTO conversions (click_id, payout, status, details)
                 VALUES ($1, $2, 'approved', $3::jsonb)`,
                [clickId, payout, JSON.stringify(recorded)]
            );

            if (paysReal) {
                const updatedUser = await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
                    [payout, req.user.id]
                );
                // A real-money test completion is a real balance move, so it is written to the
                // cash ledger without the demo flag. The flag is what keeps "balance equals the
                // sum of my cash ledger" a query; marking this row demo would break that
                // invariant for a payout the operator has actually sent.
                await client.query(
                    `INSERT INTO balance_transactions
                        (user_id, amount, transaction_type, source_id, description, is_demo)
                     VALUES ($1, $2, 'adjustment', $3, 'Test offer reward', FALSE)`,
                    [req.user.id, payout, `demo:${clickId}`]
                );
                await client.query('COMMIT');
                return res.json({
                    credited: payout,
                    balance: updatedUser.rows[0].balance,
                    demoBalance: null,
                    cashValue: true,
                    returnTo: resolveCompletionUrl(offer)
                });
            }

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
                balance: null,
                cashValue: false,
                returnTo: resolveCompletionUrl(offer)
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
