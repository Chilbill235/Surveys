BEGIN;

-- A demo offer can be marked as paying real money. This is opt-in and off by default:
-- a deployment that never sets OFFERS_TEST_REAL=true still cannot move cash through the
-- demo flow, which is the whole point of the flag. Without the column every demo completion
-- is a non-cash credit to demo_balance, and the flag is what lets a test environment turn
-- that into a real balance move for verifying payouts end to end.
ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS pays_real_money BOOLEAN NOT NULL DEFAULT FALSE;

-- The completion URL is where a finished task sends the participant. A demo offer that
-- redirects back to the catalog after completion used to be handled by the page script
-- alone, which means an offer added without editing that script had nowhere to send
-- anyone. Stored per offer so the redirect is part of the offer, not of the page.
ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS completion_url VARCHAR(512);

-- An offer can carry an estimated duration in minutes, shown on the card so a participant
-- can judge whether it is worth starting. Nullable: an offer that does not know its own
-- duration is not a broken offer.
ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER;

-- The catalog is filtered and sorted in the browser, so the columns it sorts and filters on
-- are read on every load. `payout` had no index, and every query that lists the catalog also
-- orders by it when the user asks for highest-first.
CREATE INDEX IF NOT EXISTS offers_payout_idx
    ON offers (payout DESC)
    WHERE is_active IS TRUE;

COMMIT;