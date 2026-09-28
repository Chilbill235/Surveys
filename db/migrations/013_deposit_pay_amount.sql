-- Records what the customer was actually told to send.
--
-- `amount` is the fiat value in dollars. `pay_amount` is the figure in the coin, produced by
-- the provider, and it is the one number that cannot be reconstructed from anything else in the
-- row: the exchange rate moves, the provider rounds to its own precision, and the address is
-- the same address for a hundred different amounts.
--
-- It was previously returned in the create-deposit response and then dropped on the floor. That
-- had two consequences:
--
--   - Closing the instructions dialog lost the only copy. A customer who dismissed it and came
--     back had no way to recover the exact figure, and sending a different amount underpays the
--     deposit, which is the failure mode that leaves money stranded. So the instructions could
--     not be reopened from the history at all.
--   - The row could not be checked against a later callback. When a deposit is short-paid there
--     is nothing to compare the provider's figure against but the claim in the callback itself.
--
-- Nullable, because rows written before this migration have no such value and a NOT NULL
-- column with no default would fail the backfill on a live table. `expires_at` is nullable for
-- a second reason: the provider quotes an expiry on some responses and not others, so a deposit
-- can genuinely have no deadline to record.
ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS pay_amount NUMERIC(36, 18),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

COMMENT ON COLUMN deposits.pay_amount IS
    'Exact amount of the coin the customer was instructed to send. Not derivable from amount: the rate moves.';
COMMENT ON COLUMN deposits.expires_at IS
    'Provider deadline for this payment, when one was quoted. Null where the provider quoted none.';
