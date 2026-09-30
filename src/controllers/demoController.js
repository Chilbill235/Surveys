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
const COMPLETION_FALLBACK = '/offers';

/**
 * The origin the candidate is resolved against before it is judged.
 *
 * It is never returned to anyone: only a *path* derived from it is, and only when the
 * resolution stayed on this origin.
 */
const COMPLETION_PLACEHOLDER_ORIGIN = 'http://localhost';

function resolveCompletionUrl(offer) {
    const candidate = String(offer?.completion_url || '').trim();
    if (!candidate) return COMPLETION_FALLBACK;
    if (!candidate.startsWith('/')) return COMPLETION_FALLBACK;
    try {
        const url = new URL(candidate, COMPLETION_PLACEHOLDER_ORIGIN);
        // The origin comparison is the whole check, and it has to be made on the *resolved*
        // URL rather than on the text. A prefix test is not enough: `/\evil.example` and
        // `/\/evil.example` both start with a single slash, and WHATWG URL parsing treats a
        // backslash as a separator, so the page's `location.href` assignment turns them into
        // `//evil.example` -- an off-site redirect wearing this page's "return to RewardZone"
        // name. Resolving first catches every one of those spellings at once, along with
        // `//host` and any fully-qualified `https://` value.
        if (url.origin !== COMPLETION_PLACEHOLDER_ORIGIN) return COMPLETION_FALLBACK;
        if (url.username || url.password) return COMPLETION_FALLBACK;
        // Re-serialised rather than echoed, so a path that survived resolution cannot carry
        // anything the parser read as part of the authority.
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return COMPLETION_FALLBACK;
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
            const questions = offerType === 'survey' ? await loadSurveyQuestions(click.rows[0]?.offer_id) : null;
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
                // `title`, not `name`: the column is `offers.title`. The other demo queries in this file select
                // `offers.title`, and it is what the catalog renders, so a reward row naming the
                // offer matches what the user saw on the card they completed.
                `SELECT clicks.user_id, offers.id, offers.title, offers.is_demo, offers.offer_type, offers.payout,
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
            //
            // `offer.id` is selected because the step list is keyed by it. Without the column
            // in this SELECT the lookup below was handed `undefined`, returned no steps, and
            // every non-survey demo offer answered "Tick every step before submitting."
            // forever -- a task that could be rendered but never completed.
            // `offer.id` is `offers.id` under its own name in the SELECT above -- the offer's own id, which is
// what `loadSurveyQuestions` needs to find that survey's own questions. Reading `offer.offer_id`
// here instead would be `undefined`, which the loader treats as "no offer" and answers with the
// global default set, so every survey would quietly get the same twelve questions and the
// per-offer feature would appear to work while doing nothing.
const questions = offer.offer_type === 'survey' ? await loadSurveyQuestions(Number(offer.id)) : null;
            const steps = offer.offer_type !== 'survey' ? await loadOfferTaskSteps(offer.id) : null;
            if (offer.offer_type === 'survey') {
                if (!await answersAreValid(answers, questions)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Answer every question before submitting.' });
                }
            } else {
                // Awaited, and that is the entire point of the line.
                //
                // `taskStepsAreValid` is `async`, so without `await` it hands back a Promise --
                // which is always truthy -- and `!truthy` is always false. The check therefore
                // never rejected anything, and every step-based offer could be completed with an
                // empty `answers` object and the full payout credited. The survey branch above has
                // always awaited, which is why surveys were safe and offers were not, and why
                // nothing in the unit tests caught it: the function's own tests all passed while
                // its one caller had stopped calling it.
                //
                // Worth stating plainly because it is not the kind of mistake that announces
                // itself: there is no error, no log line, and the response is a normal 200 with a
                // correct-looking credit. The only way it is visible is an end-to-end check that
                // submits an incomplete payload and insists on a refusal.
                if (!await taskStepsAreValid(answers, steps)) {
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
                // Read back from the RETURNING clause rather than assumed, so a user row that
                // vanished between the session check and this write fails the transaction
                // instead of a ledger entry with no balance behind it.
                if (updatedUser.rowCount !== 1) {
                    throw new Error('Could not credit the completing user.');
                }
                // A real-money test completion is a real balance move, so it is written to the
                // cash ledger without the demo flag. The flag is what keeps "balance equals the
                // sum of my cash ledger" a query; marking this row demo would break that
                // invariant for a payout the operator has actually sent.
                //
                // `transaction_type` is `conversion`, matching the non-cash branch below and
                // `postbackController`: the type names what happened to the balance, and a
                // credited offer reward is a conversion whether or not the money is real.
                // `is_demo` is already the flag that says which. Filing it as `adjustment`
                // put it in no tab at all -- the All list labelled it "Balance adjustment"
                // for a manual correction, and the Rewards tab, whose empty state promises
                // that completing an offer posts the reward, stayed empty.
                await client.query(
                    `INSERT INTO balance_transactions
                        (user_id, amount, transaction_type, source_id, description, is_demo)
                     VALUES ($1, $2, 'conversion', $3, 'Test offer reward', FALSE)`,
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
            if (updatedUser.rowCount !== 1) {
                throw new Error('Could not credit the completing user.');
            }
            // This row lands in the same table as the cash ledger even though it moves
            // `demo_balance` and never touches `balance`, so it is flagged rather than
            // identified by its description: the flag is what makes "balance equals the
            // sum of my cash ledger" a query, and the description is free text an operator
            // can edit.
            //
            // `transaction_type` is `conversion`, not `adjustment`, and that is the whole
            // reason a completed demo offer shows up where the user expects it. `conversion`
            // is what `postbackController` writes for a real offer reward, and it is what the
            // history page's Rewards filter selects on. `adjustment` is an operator fixing a
            // balance by hand, so a demo reward filed as one landed under no tab at all: the
            // All list showed it under an icon and a title for a manual correction, and
            // Rewards -- the tab whose empty state literally reads "Complete an offer and the
            // reward posts straight to your balance" -- stayed empty forever. The type names
            // what happened to the balance, and a credited reward is a conversion whether or not
            // the money is real; `is_demo` is already the flag that says which it is.
            await client.query(
                `INSERT INTO balance_transactions
                    (user_id, amount, transaction_type, source_id, description, is_demo)
                 VALUES ($1, $2, 'conversion', $3, $4, TRUE)`,
                [req.user.id, payout, `demo:${clickId}`, `Non-cash demo reward - ${offer.title}`]
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
