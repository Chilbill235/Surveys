BEGIN;

-- Password reset tokens are stored as SHA-256 hashes, so a database read cannot be
-- used to reset an account. `token_hash` is the primary key and rows are deleted on
-- use, which makes each token single-use.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    requested_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
    ON password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx
    ON password_reset_tokens (expires_at);

-- Changing a password bumps this value, and every issued token carries the value it
-- was signed with. Bumping it therefore invalidates all existing sessions, which is
-- what makes a reset take effect on devices that are already signed in.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Rate-limit counters live in the database because serverless instances do not share
-- memory: an in-process counter would reset on every cold start and would only cover
-- one instance out of many.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
