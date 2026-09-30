-- Links a credit on the balance ledger back to the deposit that earned it.
--
-- A credit is `balance_transactions`, which is a single flat table shared by deposits, withdrawals,
-- rewards, refunds and manual adjustments. The only thing on it that points anywhere is
-- `source_id`, and for a deposit that is `nowpayments:<payment id>` or `stripe:<session id>` --
-- the *provider's* identifier, not ours. The deposit's own id is not on the ledger row anywhere.
--
-- That is invisible until something needs to connect the two, and then it is the thing that
-- decides whether a feature can exist. A deposit notification has to land on that deposit, the
-- transaction list has to be able to offer the receipt for the row it is showing, and the history
-- row for a credit has to be able to say "this is the deposit you were notified about". All three
-- need the same join, and the join key was not being written. A credit said "Deposit credited" and
-- then could not say which deposit, which is the same information a person reading the list wants
-- and cannot be reconstructed from the row.
--
-- Nullable, and the `ALTER` is guarded: rows written before this migration have no such value, and
-- the backfill below can only fill the ones whose provider id is still known.
--
-- The backfill joins on `source_id` against the provider id already stored on `deposits`, which is
-- an exact match rather than a guess. It is written to touch only rows this column does not
-- already have, so re-running the migration is harmless -- and it must be, because migrations in
-- this directory are applied by a runner that may see a file twice after a partial failure.
--
-- `ON DELETE SET NULL` rather than a cascade or a restrict: a ledger row is a financial record and
-- must outlive the record it refers to. If a deposit is ever removed, the credit stays and simply
-- stops offering a link, which is the correct direction for that to fail in.
ALTER TABLE balance_transactions
    ADD COLUMN IF NOT EXISTS deposit_id BIGINT REFERENCES deposits (id) ON DELETE SET NULL;

COMMENT ON COLUMN balance_transactions.deposit_id IS
    'The deposit this credit came from. Null for rows that are not deposit credits, and for pre-migration rows whose provider id is no longer known.';

-- Backfill by provider id. `nowpayments:` and `stripe:` prefixes are matched literally because
-- `source_id` is built as `<provider>:<provider payment id>` and `deposits.provider_payment_id`
-- holds the part after the colon.
UPDATE balance_transactions bt
   SET deposit_id = d.id
  FROM deposits d
 WHERE bt.deposit_id IS NULL
   AND bt.transaction_type = 'deposit'
   AND d.provider_payment_id IS NOT NULL
   AND bt.source_id IN ('nowpayments:' || d.provider_payment_id, 'stripe:' || d.provider_payment_id);

-- The history endpoint is about one user's rows in descending time order, and the link is looked
-- up per rendered row. Without this the list falls back to a sequential scan of that user's whole
-- ledger for every row on the page, which is the difference between one index probe and a scan
-- that grows for the life of the account.
CREATE INDEX IF NOT EXISTS balance_transactions_deposit_idx
    ON balance_transactions (user_id, created_at DESC, id DESC)
    WHERE deposit_id IS NOT NULL;
