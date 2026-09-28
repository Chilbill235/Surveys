-- 009: automatic crypto payouts
--
-- Lets a pending *crypto* withdrawal be sent to its address by NOWPayments instead of by
-- an operator, and records enough about that attempt to prove afterwards whether the money
-- moved. The design is driven by one fact: the balance is debited when the request is
-- stored, so anything that could send the same withdrawal twice, or record a send that
-- never happened, pays out real money a second time.

ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS batch_id TEXT,
    ADD COLUMN IF NOT EXISTS payout_status VARCHAR(24),
    ADD COLUMN IF NOT EXISTS payout_coin_amount NUMERIC(24, 8),
    ADD COLUMN IF NOT EXISTS payout_fee_coin NUMERIC(24, 8),
    ADD COLUMN IF NOT EXISTS payout_address TEXT,
    ADD COLUMN IF NOT EXISTS payout_currency VARCHAR(16),
    ADD COLUMN IF NOT EXISTS payout_error TEXT,
    ADD COLUMN IF NOT EXISTS payout_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payout_submitted_at TIMESTAMPTZ;

-- The batch is the only link back to the provider, so it is looked up on every callback and
-- on every reconciliation pass. Unique, because one batch id can only ever describe one
-- submission: a duplicate here would mean the same batch was recorded against two
-- withdrawals, which is the double-send this table exists to make impossible.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_batch_id_unique
    ON withdrawals (batch_id)
    WHERE batch_id IS NOT NULL;

-- Reconciliation scans for payouts the provider has resolved but never called back about,
-- which is precisely the set that is neither pending an operator nor waiting on a callback.
-- A partial index keeps it off the paypal/venmo rows that make up most of the table.
CREATE INDEX IF NOT EXISTS withdrawals_payout_outcome_idx
    ON withdrawals (payout_claimed_at)
    WHERE payout_status IS NOT NULL
      AND payout_status NOT IN ('FINISHED', 'REJECTED', 'REJECTED_NOT_CHECKED');

-- The auto-payout run repeatedly asks the same question: which crypto withdrawals are
-- eligible to send right now? `status` first, because every run filters on it.
CREATE INDEX IF NOT EXISTS withdrawals_auto_payout_candidates_idx
    ON withdrawals (status, created_at)
    WHERE payment_method = 'crypto'
      AND payout_status IS NULL;
