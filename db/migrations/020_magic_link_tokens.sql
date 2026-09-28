-- Magic link login tokens
--
-- A magic link lets a user sign in without typing a password or a verification
-- code: an email with a single-use link is sent, and clicking it signs them in.
-- This is aimed at the confirmation step, where the account already exists and
-- only the address needs proving.
--
-- The token is stored as a SHA-256 hash so a database read cannot be used to
-- sign in. Rows are deleted on use and expire after a short window, making each
-- link single-use and time-limited.

BEGIN;

CREATE TABLE IF NOT EXISTS magic_link_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS magic_link_tokens_user_idx
    ON magic_link_tokens (user_id);

CREATE INDEX IF NOT EXISTS magic_link_tokens_expires_idx
    ON magic_link_tokens (expires_at);

COMMIT;
