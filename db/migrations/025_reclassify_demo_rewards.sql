-- Reclassify offer rewards that were filed as manual balance adjustments.
--
-- Completing a demo offer credits a reward. Both the cash and the non-cash branch of
-- `demoController.complete()` wrote that credit to `balance_transactions` with
-- `transaction_type = 'adjustment'`, which is the type the ledger reserves for an operator
-- correcting a balance by hand.
--
-- The type is not cosmetic. `public/history.js` buckets every row into a tab with
-- `item.transaction_type === filter`, and the Rewards tab filters on `'conversion'`. So an
-- `adjustment` row matched no tab except All, and `historyTitleFor` had no `case
-- 'adjustment'`, so it fell through to the `default` branch and rendered as
-- "Balance adjustment". The result a user saw was a reward credited to their balance,
-- carrying the "Test balance" badge and a "Non-cash demo reward" description, that existed
-- under All and was absent from the one tab whose empty state promises that completing an
-- offer posts the reward.
--
-- The write path is fixed in `demoController.js`. This repairs the rows already written, so
-- the ledger a user is looking at agrees with the code that produces it.
--
-- Scoped tightly on purpose. The `source_id` prefix is the discriminator that these are demo
-- offer completions and not a genuine operator correction: a hand-written adjustment has no
-- `demo:` source, and a real offer reward already carries `conversion` from
-- `postbackController`, so retyping it is a no-op rather than a rewrite. An operator's
-- deliberate correction is left exactly as it was filed.

UPDATE balance_transactions
   SET transaction_type = 'conversion'
 WHERE transaction_type = 'adjustment'
   AND source_id LIKE 'demo:%';
