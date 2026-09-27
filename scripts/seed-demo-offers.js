require('dotenv').config();
const pool = require('../src/config/db');

const demoOffers = [
    {
        networkName: 'RewardZone Local Demo 1',
        offerId: 'demo-example-001',
        title: 'TEST ONLY - Partner sign-up demo',
        destination: 'https://demo.invalid/offer/one',
        offerType: 'offer',
        payout: 1.00
    },
    {
        networkName: 'RewardZone Local Demo 2',
        offerId: 'demo-example-002',
        title: 'TEST ONLY - Product discovery demo',
        destination: 'https://demo.invalid/offer/two',
        offerType: 'offer',
        payout: 1.25
    },
    {
        networkName: 'RewardZone Local Demo Survey',
        offerId: 'demo-survey-001',
        title: 'TEST ONLY - Short preference survey',
        destination: 'https://demo.invalid/survey/one',
        offerType: 'survey',
        payout: 2.00
    }
];

async function seedDemoOffers() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Demo offers cannot be seeded in production.');
    }

    const client = await pool.connect();
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
            if (existing.rows.length === 1) {
                await client.query(
                    `UPDATE offers SET network_name = $1, network_offer_id = $2, title = $3,
                        payout = $4, tracking_url = $5, is_active = TRUE, is_demo = TRUE,
                        offer_type = $6 WHERE id = $7`,
                    [offer.networkName, offer.offerId, offer.title, offer.payout, offer.destination, offer.offerType, existing.rows[0].id]
                );
            } else {
                await client.query(
                    `INSERT INTO offers
                        (network_name, network_offer_id, title, payout, tracking_url, is_active, is_demo, offer_type)
                     VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6)`,
                    [offer.networkName, offer.offerId, offer.title, offer.payout, offer.destination, offer.offerType]
                );
            }
        }
        await client.query('COMMIT');
        console.log('Seeded two demo offers and one demo survey. Rewards only increase the test-only balance.');
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
