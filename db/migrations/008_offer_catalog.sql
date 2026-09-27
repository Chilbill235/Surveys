BEGIN;

-- The catalog is the whole product surface: it is the only screen a visitor sees before
-- deciding to sign in, and a card made of an ID, a title, and a payout gives them nothing
-- to decide with. Every card read "OFFER 12 / Offer | PartnerNet / Some Title / $2.00",
-- which is not enough to tell two offers apart or to judge whether either is worth
-- starting.
--
-- The blurb is shown next to the payout so the choice can be made from the card, and the
-- partner is given a real name to display rather than a raw network slug. Both are
-- nullable: an offer added by a script or a postback has neither, and the card renders
-- without them rather than the migration inventing copy.

ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS description TEXT;

-- Advertiser networks are identified in their own tracking domains (`t.network_name`),
-- which read as noise on a card meant to be skimmed. The display name is separate so the
-- tracking value is never edited to suit the interface.
ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS partner_label VARCHAR(64);

-- The catalog is sorted and filtered in the browser, so the columns it sorts and filters
-- on are read on every load. `offer_type` had no index, and every query that lists the
-- catalog also filters `is_active`.
CREATE INDEX IF NOT EXISTS offers_active_type_idx
    ON offers (offer_type, id DESC)
    WHERE is_active IS TRUE;

-- The demo offers are the only rows that carry a blurb today. Seeding them here rather
-- than in the seed script means an existing development database picks up the same copy a
-- fresh one gets, so the two cannot drift.
UPDATE offers
SET description = 'Complete a short survey about how you spend time online. No purchase needed.'
WHERE is_demo IS TRUE AND offer_type = 'survey' AND description IS NULL;

UPDATE offers
SET description = 'Install the partner app and open it once to complete this task.'
WHERE is_demo IS TRUE AND offer_type = 'offer' AND description IS NULL;

UPDATE offers
SET partner_label = 'Demo Partner'
WHERE is_demo IS TRUE AND partner_label IS NULL;

COMMIT;
