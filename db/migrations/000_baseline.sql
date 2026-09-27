BEGIN;

-- Baseline schema.
--
-- Migrations 001-005 use ALTER TABLE and CREATE INDEX against `users`, `offers`,
-- and `clicks`, which historical deployments created by hand. A fresh database has
-- none of them, so the whole chain fails on the first statement. Creating them here
-- makes `npm run migrate` able to build a brand new database from nothing, which is
-- what the Vercel build step depends on. Every statement is idempotent, so this is
-- safe on databases where the tables already exist.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    network_name TEXT NOT NULL,
    network_offer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    payout NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (payout >= 0),
    tracking_url TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network_name, network_offer_id)
);

CREATE TABLE IF NOT EXISTS clicks (
    id BIGSERIAL PRIMARY KEY,
    click_id UUID NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
    ip_address VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clicks_click_id_idx ON clicks (click_id);
CREATE INDEX IF NOT EXISTS offers_tracking_idx ON offers (network_name, network_offer_id);

COMMIT;
