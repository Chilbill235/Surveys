-- Confirms that a withdrawal is really being requested by the account owner.
--
-- A balance session is enough to move money: the bearer token alone authorises a payout, and it
-- is held in `sessionStorage`, where one successful XSS reads it. A withdrawal code means an
-- attacker with a stolen session still cannot move funds without also reading the owner's
-- inbox, and -- because the code is bound to the amount and destination that were actually
-- shown -- cannot redirect a real payout to an address they control.
--
-- Deliberately a separate table from `email_verification_codes` rather than a shared one with
-- a purpose column. The two have different lifetimes, different attempt budgets, and different
-- things to say when they are wrong, and merging them would mean every change to one had to
-- keep the other honest.
CREATE TABLE IF NOT EXISTS withdrawal_verification_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What was confirmed, so a code cannot be reused for a different payout.
    --
    -- Without this the code confirms only "this session may withdraw", and a code obtained for
    -- a $1 sanity check would authorise a $10,000 payout. Bound to the normalised amount and
    -- the destination as the user was shown them.
    amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
    destination VARCHAR(128) NOT NULL,

    code_hash CHAR(64) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live code per account. The lookup that matters is "this user's outstanding code", and a
-- partial unique index keeps it to one row without a delete-then-insert that two concurrent
-- requests could interleave into two valid codes.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_verification_codes_one_live
    ON withdrawal_verification_codes (user_id)
    WHERE consumed_at IS NULL;

-- Supports the cleanup sweep for codes that were issued and never used.
CREATE INDEX IF NOT EXISTS withdrawal_verification_codes_expires
    ON withdrawal_verification_codes (expires_at);
