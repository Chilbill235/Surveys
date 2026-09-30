-- Lets a survey offer have its own questionnaire instead of sharing one global set.
--
-- `survey_questions` had no `offer_id`, which made the table global: every survey in the
-- catalog was served the same twelve questions in the same order. Two survey offers from two
-- different partners were not two surveys, they were the same survey listed twice -- so a
-- partner who wanted to ask about their product got asked about favourite genres instead, and
-- there was nowhere to record what a specific survey had actually asked.
--
-- The twelve existing rows are the default set and keep `offer_id` NULL, so nothing that works
-- today stops working. A question with an `offer_id` belongs to that offer alone and wins over
-- the default when the offer is being served. Nullable rather than backfilled on purpose:
-- copying the global set onto every existing survey would have made the default unreachable
-- for them, so editing the default would silently stop affecting them.
--
-- `question_key` is UNIQUE on its own, which would stop two offers both asking `favorite`. That
-- uniqueness exists because the key is the answer-map key that gets stored in
-- `conversions.details` and compared on validation, and a collision between two offers would
-- make one offer's answers satisfy another's questions. The constraint is therefore relaxed to
-- per-offer, and the answer map stays safe because a click belongs to exactly one offer, so a
-- detail record only ever holds keys from that offer's own questions.
ALTER TABLE survey_questions
    ADD COLUMN IF NOT EXISTS offer_id INTEGER REFERENCES offers (id) ON DELETE CASCADE;

COMMENT ON COLUMN survey_questions.offer_id IS
    'The survey offer these questions belong to. NULL is the default set, served to any survey offer that has no questions of its own.';

-- The uniqueness that stops one offer's answers satisfying another's questions, now scoped to
-- the offer rather than the whole table. The default set keeps its global uniqueness, because
-- those rows all share `offer_id IS NULL` and `COALESCE` folds them to the same key of 0.
--
-- `DROP CONSTRAINT`, not `DROP INDEX`: `UNIQUE` on a column in the original migration created a
-- constraint, and Postgres refuses to drop the index backing a constraint that way. Naming it
-- wrong is not a no-op warning here, it aborts the migration.
ALTER TABLE survey_questions
    DROP CONSTRAINT IF EXISTS survey_questions_question_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS survey_questions_offer_key_uniq
    ON survey_questions (COALESCE(offer_id, 0), question_key);

-- The serving query filters on `offer_id` and orders by `position`. Without this it is a scan
-- and sort of every question in the system on every survey page load.
CREATE INDEX IF NOT EXISTS survey_questions_offer_position_idx
    ON survey_questions (offer_id, position ASC);

COMMIT;