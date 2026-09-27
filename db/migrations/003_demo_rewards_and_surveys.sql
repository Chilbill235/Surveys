BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS demo_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (demo_balance >= 0);

ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS offer_type VARCHAR(16) NOT NULL DEFAULT 'offer'
    CHECK (offer_type IN ('offer', 'survey'));

COMMIT;
