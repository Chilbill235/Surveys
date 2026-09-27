BEGIN;

-- Ledger hygiene and the confirmed-implies-credited invariant.
--
-- Two accounting weaknesses are fixed here. Both were found by auditing the live ledger
-- rather than by reading the code, because the code writes each of them correctly in one
-- statement and the divergence only appears in data written by something else.

-- 1. `balance_transactions` is the audit trail for real money, but demo rewards were
--    written into it as well. A demo reward credits `users.demo_balance` and never
--    touches `users.balance`, so a demo row in this table inflates the ledger relative to
--    the balance it is supposed to explain. The description column said so in prose; the
--    schema now says it structurally, so cash can be reconciled with a query instead of
--    by reading every description.
ALTER TABLE balance_transactions
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from the source prefix rather than the description: the source is the stable
-- identity of the row, the description is free text that an operator can edit.
UPDATE balance_transactions
SET is_demo = TRUE
WHERE NOT is_demo AND source_id LIKE 'demo:%';

-- 2. A deposit could be left showing `confirmed` with no `credited_at`, which is a
--    deposit the user is told arrived that never funded their balance. Nothing in the
--    current code can produce that, but nothing in the schema forbade it either, and one
--    such row already exists. The consequence is worse than the cosmetic mismatch:
--    reconciliation only re-checks deposits in `pending`/`confirming`, so a confirmed row
--    with no credit is permanently invisible to it and can never be paid out.
--
--    The existing row is put back into `confirming` rather than failed. The provider
--    still has the payment, so the reconciler can ask it what really happened: if the
--    money arrived the deposit gets credited, and if it did not the reconciler closes it
--    out. Rewriting the status by hand would pick one of those answers without evidence.
UPDATE deposits
SET status = 'confirming', updated_at = NOW()
WHERE status = 'confirmed' AND credited_at IS NULL;

-- The constraint makes the invariant permanent. `creditConfirmedDeposit` sets the status
-- and the timestamp in the same statement, and `applyDepositStatus` only writes while
-- `credited_at IS NULL`, so every code path in the build satisfies it. The constraint is
-- what makes it true of the next one: a partial write, a manual fix, or a future
-- contribution cannot show a user a confirmed deposit that did not pay out.
ALTER TABLE deposits
    DROP CONSTRAINT IF EXISTS deposits_confirmed_requires_credit;
ALTER TABLE deposits
    ADD CONSTRAINT deposits_confirmed_requires_credit
    CHECK (status <> 'confirmed' OR credited_at IS NOT NULL);

-- The audit query behind `npm run audit:balance` sums only cash rows. Without the index
-- that is a sequential scan of the whole ledger on every run.
CREATE INDEX IF NOT EXISTS balance_transactions_cash_user_idx
    ON balance_transactions (user_id, id)
    WHERE NOT is_demo;

COMMIT;
