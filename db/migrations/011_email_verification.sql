-- 011: email verification
--
-- Registration used to hand back a session immediately, so the address only had to look
-- like an email. A typo, or an address belonging to someone else, became a real account that
-- could hold a balance and later receive a password reset for an inbox it does not own.
-- A six-digit code sent to the address closes that.
--
-- The code is stored as a SHA-256 hash for the same reason the reset token is: a database
-- read must not be enough to verify an account. Unlike the reset token, the code is low
-- entropy -- a million possibilities, 000000 through 999999 -- so the hash alone would not
-- stop an offline search. What makes it safe is `attempts`: the row is deleted after a
-- handful of wrong guesses, and the code is short-lived, so the search space is never
-- actually available.

BEGIN;

-- NULL means unverified. A user created before this migration has no value here, so the
-- column's presence is not evidence the address was ever confirmed; `COALESCE` in the
-- verification query treats every pre-existing row as unverified, which is the safe
-- direction -- it asks the owner to prove the address rather than assuming it is theirs.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_verification_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verification looks the row up by user, and there is normally at most one live code per
-- user, so this is the access path for every verification attempt.
CREATE INDEX IF NOT EXISTS email_verification_codes_user_idx
    ON email_verification_codes (user_id);

-- Housekeeping: expired and spent rows are collected on this index rather than by scanning
-- the table, and the index is only useful while rows are still waiting to be collected.
CREATE INDEX IF NOT EXISTS email_verification_codes_expiry_idx
    ON email_verification_codes (expires_at);

COMMIT;
