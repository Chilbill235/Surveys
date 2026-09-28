-- Withdrawal columns the code depends on but the schema never had, plus the amount floor.
--
-- Every statement here is missing an `ADD COLUMN` that the application has been writing to
-- for some time, which is why a crypto withdrawal failed with:
--
--   column "destination_tag" of relation "withdrawals" does not exist
--
-- Two columns are absent, not one. PostgreSQL reports only the first unknown column, so
-- fixing `destination_tag` alone would have produced a second failure naming
-- `idempotency_key` on the next attempt. Both are added here together for that reason.

-- The memo/destination tag for networks that require one. XRP is the common case: sending
-- to an exchange deposit address without the tag means the funds arrive uncredited. It is
-- nullable because most assets have no such field, and it is carried through to the provider
-- as `extra_id` when it is present.
ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS destination_tag TEXT;

-- The caller's key for a withdrawal request, used to make a double submit harmless.
--
-- Without the matching unique index below, the `ON CONFLICT (user_id, idempotency_key)`
-- clause in the insert is not merely useless: it names a constraint that does not exist, so
-- the statement fails outright rather than falling back to a plain insert. The two pieces
-- have to be added together, which is why the index is part of this migration rather than a
-- follow-up that could be forgotten.
ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial, and deliberately: the column is nullable because a request is not required to
-- carry a key, and a plain unique index would let each NULL row collide with every other,
-- rejecting every second un-keyed withdrawal. The predicate restricts uniqueness to rows
-- that actually have a key, which is exactly the set the conflict clause is meant to cover.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_user_idempotency_key_unique
    ON withdrawals (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- The amount floor.
--
-- `001_auth_and_payments.sql` created this column with an inline `CHECK (amount >= 5)`, so
-- PostgreSQL named the constraint `withdrawals_amount_check`. The application has always
-- advertised a $1.00 minimum withdrawal and validates against it, which means a request for
-- $1.00 to $4.99 passed every check in the controller and was then rejected by the database
-- -- a user-visible error for a value the form said was allowed. The constraint is dropped
-- and replaced with one named explicitly, so the next person to change the floor has
-- something findable to edit.
--
-- Dropped conditionally: the guard means a database that never had the inline check (or one
-- where it was already removed by hand) still migrates cleanly instead of aborting.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'withdrawals_amount_check'
          AND conrelid = 'withdrawals'::regclass
    ) THEN
        ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_amount_check;
    END IF;
END
$$;

-- $1.00, matching `minimumWithdrawalUsd` in src/services/payoutOptions.js. Kept as a
-- constraint so a negative or zero withdrawal cannot reach the balance ledger even if a
-- future code path forgets to validate the amount.
ALTER TABLE withdrawals
    DROP CONSTRAINT IF EXISTS withdrawals_amount_minimum;
ALTER TABLE withdrawals
    ADD CONSTRAINT withdrawals_amount_minimum CHECK (amount >= 1);
