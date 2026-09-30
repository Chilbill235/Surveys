require('dotenv').config();
const pool = require('../src/config/db');

/**
 * The demo catalog.
 *
 * Steps and questions live here, beside the offer they belong to, rather than in a migration
 * against hardcoded row ids. That split used to mean a freshly seeded demo *offer* had no steps
 * at all -- so the task page rendered "This task has no steps configured yet" and could never be
 * completed, and the only copy of the step text lived in a migration whose ids happened to match
 * whatever rows existed when it ran.
 *
 * Seeding is idempotent on `(network_name, network_offer_id)` and re-applies steps each run, so
 * editing the copy below and re-running is how you change a demo task.
 */
const demoOffers = [
    {
        networkName: 'RewardZone Local Demo 1',
        offerId: 'demo-example-001',
        title: 'TEST ONLY - Partner sign-up demo',
        destination: 'https://demo.invalid/offer/one',
        offerType: 'offer',
        payout: 1.00,
        description: 'Sign up with a demo partner site to see how a multi-step offer task works end to end.',
        partnerLabel: 'Demo Partner',
        estimatedMinutes: 4,
        steps: [
            { prompt: 'Visit the partner site and create an account', actionLabel: 'Open the partner site', url: 'https://example.com/partner' },
            { prompt: 'Confirm the email address they send you', actionLabel: 'I confirmed my email', url: null },
            { prompt: 'Make a first purchase of at least $5', actionLabel: 'I made a purchase', url: null }
        ]
    },
    {
        networkName: 'RewardZone Local Demo 2',
        offerId: 'demo-example-002',
        title: 'TEST ONLY - Product discovery demo',
        destination: 'https://demo.invalid/offer/two',
        offerType: 'offer',
        payout: 1.25,
        description: 'Install a demo app through three steps to see a checklist task running to completion.',
        partnerLabel: 'Demo App Store',
        estimatedMinutes: 5,
        steps: [
            { prompt: 'Download the partner app from the app store', actionLabel: 'Open the app store', url: 'https://example.com/app' },
            { prompt: 'Install the app and sign in', actionLabel: 'I am signed in', url: null },
            { prompt: 'Complete the first task inside the app', actionLabel: 'I finished the task', url: null }
        ]
    },
    {
        networkName: 'RewardZone Local Demo Survey',
        offerId: 'demo-survey-001',
        title: 'TEST ONLY - Short preference survey',
        destination: 'https://demo.invalid/survey/one',
        offerType: 'survey',
        payout: 2.00,
        description: 'Answer a short questionnaire one question at a time, the way a real survey offer pays out.',
        partnerLabel: 'Demo Research',
        estimatedMinutes: 3,
        // No steps: a survey is answered through `survey_questions`, not a checklist. Listed
        // explicitly so the absence reads as a decision rather than an oversight.
        steps: []
    }
];

/**
 * Replaces an offer's steps with `steps`, positions renumbered from 1.
 *
 * Delete-then-insert rather than an upsert on `(offer_id, position)`, because renumbering after a
 * deletion collides with the surviving rows: removing step 2 of 3 leaves a gap, and re-inserting
 * a shorter list on top of the old one would hit the unique key on the positions that were not
 * removed. Replacing the whole set in one statement cannot collide with itself, and it is the
 * only way the copy below can be edited freely -- including by removing a step.
 */
async function replaceSteps(client, offerId, steps) {
    await client.query('DELETE FROM offer_task_steps WHERE offer_id = $1', [offerId]);
    for (const [index, step] of steps.entries()) {
        await client.query(
            `INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
             VALUES ($1, $2, $3, $4, $5)`,
            [offerId, index + 1, step.prompt, step.actionLabel, step.url || null]
        );
    }
}

async function seedDemoOffers() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Demo offers cannot be seeded in production.');
    }

    const client = await pool.connect();
    let offers = 0;
    let steps = 0;
    try {
        await client.query('BEGIN');
        for (const offer of demoOffers) {
            const existing = await client.query(
                'SELECT id FROM offers WHERE network_name = $1 OR network_offer_id = $2 FOR UPDATE',
                [offer.networkName, offer.offerId]
            );
            if (existing.rows.length > 1) {
                throw new Error(`Conflicting records already use ${offer.networkName} or ${offer.offerId}.`);
            }
            let offerId;
            if (existing.rows.length === 1) {
                offerId = existing.rows[0].id;
                await client.query(
                    `UPDATE offers SET network_name = $1, network_offer_id = $2, title = $3,
                        payout = $4, tracking_url = $5, is_active = TRUE, is_demo = TRUE,
                        offer_type = $6,
                        description = COALESCE($7, description),
                        partner_label = COALESCE($8, partner_label),
                        estimated_minutes = COALESCE($9, estimated_minutes)
                     WHERE id = $10`,
                    [offer.networkName, offer.offerId, offer.title, offer.payout, offer.destination,
                        offer.offerType, offer.description ?? null, offer.partnerLabel ?? null,
                        offer.estimatedMinutes ?? null, offerId]
                );
            } else {
                const inserted = await client.query(
                    `INSERT INTO offers
                        (network_name, network_offer_id, title, payout, tracking_url, is_active,
                         is_demo, offer_type, description, partner_label, estimated_minutes)
                     VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6, $7, $8, $9)
                     RETURNING id`,
                    [offer.networkName, offer.offerId, offer.title, offer.payout, offer.destination,
                        offer.offerType, offer.description ?? null, offer.partnerLabel ?? null,
                        offer.estimatedMinutes ?? null]
                );
                offerId = inserted.rows[0].id;
            }
            offers += 1;

            // A survey answers `survey_questions`, so clearing its steps keeps the two mechanisms
            // from both claiming the same offer.
            await replaceSteps(client, offerId, offer.steps);
            steps += offer.steps.length;
        }
        await client.query('COMMIT');
        console.log(
            `Seeded ${offers} demo offers with ${steps} task steps. `
            + 'Rewards only increase the test-only balance.'
        );
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

seedDemoOffers().catch((error) => {
    console.error('Could not seed demo offers:', error.message);
    process.exitCode = 1;
});