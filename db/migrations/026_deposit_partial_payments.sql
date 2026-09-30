-- Records how much of a crypto deposit has actually arrived, so a short payment stays visible.
--
-- A customer who sends less than the quoted `pay_amount` is not an error the provider reports
-- as one: the payment sits at `partially_paid`, and the app's only correct response is to keep
-- waiting, because the customer can top up the same address and the payment then finishes. The
-- app already did that -- `partially_paid` maps to `confirming` and the sweep keeps re-reading
-- the row -- but it recorded nothing about the shortfall, which left three real problems:
--
--   - There was no way to answer "how much is still owed?" or "how much has arrived in total?".
--     `pay_amount` says what was asked for; nothing said what turned up. A support answer to
--     either question had to go back to the provider by hand.
--   - A partial that the provider later abandons was marked `failed` like any other failure, and
--     the customer was emailed that the deposit did not go through. That is not true when most
--     of the money has already landed in the address, and it is the one case where an automated
--     "failed" is actively misleading rather than merely incomplete.
--   - `underpaid_at` gives the shortfall a start time, so an operator can see at a glance
--     whether a deposit is minutes old or has been short for days, which is the difference
--     between a customer about to top up and one who has walked away.
--
-- Nullable, because rows written before this migration have no such value and a NOT NULL column
-- with no default would fail the backfill on a live table.
--
-- `NUMERIC(36,18)` rather than a coin-sized precision: `pay_amount` above uses the same width,
-- and crypto amounts are compared by exact decimal value here, never as floats. Storing a
-- rounded figure would make "did the shortfall close?" answerable only approximately, and that
-- comparison is the whole point of the column.
ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS actually_paid NUMERIC(36, 18),
    ADD COLUMN IF NOT EXISTS pay_currency VARCHAR(24),
    ADD COLUMN IF NOT EXISTS underpaid_at TIMESTAMPTZ;

COMMENT ON COLUMN deposits.actually_paid IS
    'Most recent total of the coin the provider reported as received. Null until a callback or sweep reports one.';
COMMENT ON COLUMN deposits.pay_currency IS
    'Coin that actually_paid and pay_amount are denominated in. Distinct from currency_code, which is the fiat side.';
COMMENT ON COLUMN deposits.underpaid_at IS
    'When the deposit was first seen short of pay_amount. Set once and not moved, so it measures how long the shortfall has stood.';

-- The sweep reads uncredited deposits oldest first, and an underpaid one is now the row an
-- operator most wants to find. A partial index keeps that ordered scan off the settled rows
-- without adding a second full index over the table.
CREATE INDEX IF NOT EXISTS deposits_underpaid_sweep_idx
    ON deposits (updated_at)
    WHERE credited_at IS NULL AND actually_paid IS NOT NULL AND actually_paid < pay_amount;
