BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
    ON users (LOWER(email))
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS offers_active_created_idx
    ON offers (is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS clicks_user_created_idx
    ON clicks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fraud_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address VARCHAR(64),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversions (
    id BIGSERIAL PRIMARY KEY,
    click_id UUID NOT NULL UNIQUE REFERENCES clicks(click_id) ON DELETE RESTRICT,
    payout NUMERIC(12, 2) NOT NULL CHECK (payout >= 0),
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 5),
    payment_method VARCHAR(24) NOT NULL CHECK (payment_method IN ('paypal', 'crypto', 'venmo')),
    payment_address TEXT NOT NULL,
    asset_code VARCHAR(16),
    network VARCHAR(32),
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
    provider_reference TEXT,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deposits (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider VARCHAR(32) NOT NULL,
    provider_payment_id VARCHAR(128) UNIQUE,
    amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
    asset_code VARCHAR(16) NOT NULL,
    network VARCHAR(32),
    deposit_address TEXT,
    checkout_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'expired')),
    credited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balance_transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount NUMERIC(20, 8) NOT NULL CHECK (amount <> 0),
    transaction_type VARCHAR(24) NOT NULL
        CHECK (transaction_type IN ('conversion', 'withdrawal', 'deposit', 'refund', 'adjustment')),
    source_id VARCHAR(128) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_type, source_id)
);

CREATE INDEX IF NOT EXISTS withdrawals_user_created_idx
    ON withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deposits_user_created_idx
    ON deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS balance_transactions_user_created_idx
    ON balance_transactions (user_id, created_at DESC);

COMMIT;
