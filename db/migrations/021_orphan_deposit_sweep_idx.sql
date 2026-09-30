-- Index for the orphan-deposit sweep.
--
-- `failOrphanedDeposits` runs on every reconciliation pass -- daily from `vercel.json`,
-- and again from `npm run reconcile` -- and finds deposits that were created but never
-- attached to a provider payment (a crash between the insert and the provider call, so
-- no webhook or lookup can ever resolve them). It selects on exactly those three
-- columns and orders by `created_at`, and the only index `deposits` had on the path was
-- `deposits_user_created_idx (user_id, created_at DESC)`, which cannot serve a query
-- that does not filter on `user_id`. So the sweep was a sequential scan of the whole
-- table on every pass, growing with every deposit the platform has ever taken.
--
-- Partial, because the predicate is the query: the vast majority of rows are deposits
-- that *were* attached to a provider payment, and none of them can ever be selected by
-- this sweep, so indexing them costs write amplification on the hot insert path for no
-- read that ever happens.

CREATE INDEX IF NOT EXISTS deposits_orphan_sweep_idx
    ON deposits (created_at)
    WHERE provider_payment_id IS NULL
      AND credited_at IS NULL
      AND status IN ('pending', 'confirming');
