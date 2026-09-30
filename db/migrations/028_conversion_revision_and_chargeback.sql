-- Makes the advertiser payout path actually work on a database built from these migrations.
--
-- Both of these are columns and constraints the code has been using and the migrations never
-- declared. On the development database they exist -- `conversions.revision` was added by hand,
-- and `chargeback` was added to the type list by hand with it -- so every test and every manual
-- run worked, and the gap only shows up where it costs the most: an environment built by
-- `npm run migrate`. That is a fresh database in staging, a contributor's first clone, and the
-- Vercel build step. On those, `/api/postback` fails on `column "revision" does not exist` and
-- every single advertiser postback returns 500 -- including a first-time approval, which is the
-- one that credits a user money.
--
-- So the code was correct and untested, the schema was wrong, and nothing in the suite could
-- see it because the postback tests stub the pool rather than running a migration.
--
-- Written to be safe on a database that already has both, which is the development one. The
-- `IF NOT EXISTS` and the guarded constraint drop are not defensive habit: a migration runner
-- that sees a file twice after a partial failure has to be able to run this again.

-- 1. The postback revision counter.
--
-- `conversions` is unique per click, so a postback that arrives more than once has to update one
-- row rather than insert another. The revision is what makes that update safe and what makes the
-- ledger key unique: `conversion:<click id>:<revision>`, so a re-approval writes a *new* ledger
-- row instead of colliding with the first, and a reversal can be traced back to the credit it
-- reversed. Without the counter there is no way to tell a second approval from a repeated
-- delivery of the first.
ALTER TABLE conversions
    ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN conversions.revision IS
    'How many times this conversion has changed state. The postback ledger key is built from it, so an approved-then-re-approved conversion writes a distinct row instead of colliding.';

-- 2. `chargeback` as a ledger transaction type.
--
-- `reverseConversion` debits the balance and writes a ledger row of type `chargeback`. That type
-- is not in the only CHECK on `transaction_type`, so the insert violates the constraint, the
-- whole transaction rolls back, and the endpoint returns 500. An advertiser reversing a
-- conversion -- a chargeback, a fraud reversal, a correction -- could never be recorded, and
-- could never be recorded *quietly* either: it is a loud 500, which is how it was noticed.
--
-- The fix widens the list rather than removing the CHECK. The constraint is worth keeping: it is
-- what stops a typo becoming a ledger row nobody can classify, and every other type in the list
-- is one the application has a name for. `chargeback` is now one of them, and the history
-- filters were widened alongside it so the row is visible instead of existing and being
-- un-findable.
ALTER TABLE balance_transactions
    DROP CONSTRAINT IF EXISTS balance_transactions_transaction_type_check;

ALTER TABLE balance_transactions
    ADD CONSTRAINT balance_transactions_transaction_type_check
    CHECK (transaction_type IN ('conversion', 'chargeback', 'withdrawal', 'deposit', 'refund', 'adjustment'));

-- 3. The index the click velocity check has been reading without.
--
-- `fraudDetection` counts this account's recent clicks by IP on every single click, filtering on
-- `ip_address` and `created_at`. There is no index on either -- `clicks` is indexed on
-- `click_id` and on `(user_id, created_at)`, neither of which helps. So every click runs a
-- sequential scan of the whole clicks table, and the table is the highest-volume one in the
-- system: one row per click, forever, never deleted. The check that exists to slow down an
-- attacker is the thing that degrades as the table grows, which is backwards.
--
-- Partial, because the query only ever looks at a recent window, so the tail of the table is
-- index entries that can never be read.
CREATE INDEX IF NOT EXISTS clicks_ip_recent_idx
    ON clicks (ip_address, created_at DESC);

COMMIT;