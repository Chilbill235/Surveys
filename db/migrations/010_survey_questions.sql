-- 010: server-driven survey questions
--
-- The survey's questions were defined twice -- once as a literal array in `public/demo.js`
-- and once as two `Set`s in `demoController` -- and the two had to be edited together or
-- the page would offer an answer the server rejected, or accept one the page never showed.
-- Questions now live here, so changing a survey is a database row rather than a code
-- change, and there is exactly one definition of what a valid answer is.
--
-- The two original questions are kept verbatim in position, so existing demo clicks and
-- their recorded conversions stay meaningful.

BEGIN;

CREATE TABLE IF NOT EXISTS survey_questions (
    id SERIAL PRIMARY KEY,
    -- The value the client posts as the answer key. Stable across edits to the prompt or
    -- options, so an answer already stored against it still reads correctly.
    question_key VARCHAR(64) NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    -- An ordered list of { value, label }. Stored as JSON because the option set is the
    -- question's own data and normalising it into a second table buys nothing at this size.
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array'),
    position INTEGER NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (position > 0),
    CHECK (jsonb_array_length(options) > 0)
);

-- The page asks for questions in order on every load. A partial index on `position` alone
-- would be a sequential scan of the whole table for a table this small, so the ordering is
-- served by a plain ordered read and the index that earns its keep is the unique key above.
CREATE INDEX IF NOT EXISTS survey_questions_position_idx
    ON survey_questions (position);

INSERT INTO survey_questions (question_key, prompt, options, position, required) VALUES
    ('favorite', 'Which catalog section interests you most?',
     '[{"value":"games","label":"Games"},{"value":"shopping","label":"Shopping"},{"value":"learning","label":"Learning"}]'::jsonb,
     1, TRUE),
    ('frequency', 'How often do you browse offers?',
     '[{"value":"daily","label":"Daily"},{"value":"weekly","label":"Weekly"},{"value":"rarely","label":"Rarely"}]'::jsonb,
     2, TRUE)
ON CONFLICT (question_key) DO NOTHING;

COMMIT;
