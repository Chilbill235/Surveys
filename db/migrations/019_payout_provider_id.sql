-- 019: per-payout provider identity, and a batch id that is allowed to be a batch
--
-- Two defects in how a payout submission was tied back to a withdrawal, both of which only
-- show up once a batch carries more than one withdrawal.
--
-- 1. `withdrawals_batch_id_unique` is a UNIQUE index on `batch_id`. One batch id legitimately
--    describes N withdrawals -- that is what a batch *is* -- so a run that claimed two
--    withdrawals and sent them together would fail the second `recordSubmission` write with a
--    unique violation. That write happens *after* the provider has accepted the batch and
--    released the money, so the failure lands in the worst place: the code raises an error
--    for a payout that actually went through, and the run reports a failure for a send that
--    succeeded. The index is dropped for a plain lookup index.
--
--    The invariant it was reaching for -- one withdrawal is never in two batches -- is not
--    lost. It is enforced by the claim itself: a row is moved to `processing` with a
--    `payout_status` in one committed statement before the provider is called, and only a row
--    with `payout_status IS NULL` can be claimed. A withdrawal in a second batch would have to
--    be un-claimed first, which only a proven failure does.
--
-- 2. There was nowhere to record the provider's id for an *individual* payout. Only the batch
--    id was kept, and the provider's status endpoint addresses a single payout. Without this
--    column, reconciliation has to poll with a batch id and gets a batch-level answer, which
--    cannot represent the only case that matters: three withdrawals sent together, one
--    finishes and one is rejected. Choosing to act on the batch answer would either mark a
--    rejected payout as sent, or leave a sent one looking unfinished, and both are wrong in a
--    way the user pays for.
--
--    The uniqueness here is the real one. The provider's individual payout id belongs to
--    exactly one withdrawal, so recording it twice would mean the same provider-side transfer
--    was attributed to two rows -- the same double-send this table exists to prevent.

ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS payout_provider_id TEXT;

DROP INDEX IF EXISTS withdrawals_batch_id_unique;

CREATE INDEX IF NOT EXISTS withdrawals_batch_id_idx
    ON withdrawals (batch_id)
    WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_payout_provider_id_unique
    ON withdrawals (payout_provider_id)
    WHERE payout_provider_id IS NOT NULL;

-- Reconciliation sweeps "claimed, submitted, not yet final". The index that drives it has to
-- carry the full terminal set, which now includes FAILED and CANCELLED: a payout the provider
-- gave up on is a withdrawal that must be refunded, not one that is still in flight, and an
-- index that does not know that would keep re-selecting it forever.
DROP INDEX IF EXISTS withdrawals_payout_outcome_idx;

CREATE INDEX IF NOT EXISTS withdrawals_payout_outcome_idx
    ON withdrawals (payout_claimed_at)
    WHERE payout_status IS NOT NULL
      AND payout_status NOT IN (
          'FINISHED', 'FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED'
      );
