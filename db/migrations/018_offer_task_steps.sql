BEGIN;

-- A demo offer used to be one checkbox: "I have completed the demo partner task". That is
-- not an offer, it is a shrug. A real offer has steps -- visit a site, sign up, confirm an
-- email, make a purchase -- and the participant needs to know what is left. This table gives
-- an offer a list of steps, shown in order on the task page, with each one ticked off as the
-- participant says they did it. The server records which were ticked, so the completion is a
-- set of steps rather than a single boolean, and an operator can see what was actually done.
--
-- Steps are independent of the survey questions. A survey asks about the participant; a task
-- asks them to do things. Mixing the two in one list made both worse: a question is answered,
-- a step is ticked, and the page needs to know which is which to render either correctly.

CREATE TABLE IF NOT EXISTS offer_task_steps (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    -- What the participant is actually asked to do, so the tick means something.
    action_label VARCHAR(120) NOT NULL,
    -- Optional URL the step points at. Nullable: a step can be "check your email" with no
    -- link, and inventing one would send the participant somewhere meaningless.
    url VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (position > 0),
    UNIQUE (offer_id, position)
);

CREATE INDEX IF NOT EXISTS offer_task_steps_offer_idx
    ON offer_task_steps (offer_id, position);

-- The two demo offers get real steps. Without them the task page shows the old single
-- checkbox, which is what this migration exists to replace.
--
-- These were plain `INSERT ... VALUES` rows against literal offer ids 1 and 2. `offers` is
-- created by migration 000 and is *empty* at this point on a fresh database, so the insert raised
-- a foreign-key violation and `scripts/migrate.js` aborted the whole chain: `npm run migrate`
-- could not build a fresh database, which is the entire reason these files exist and the thing
-- the Vercel build step depends on. `ON CONFLICT DO NOTHING` does not suppress an FK violation,
-- so nothing about it made the insert safe.
--
-- Written as `INSERT ... SELECT ... WHERE EXISTS` so each offer's steps land only when that offer
-- is actually there. On an existing database -- where 1 and 2 are the two seeded demo offers --
-- the behaviour is unchanged. On a fresh one, the steps are skipped and the offers, which are
-- created later by `scripts/seed-demo-offers.js`, carry no steps until that script attaches them.
-- That is why the seed script owns steps now: steps belong to the offers it creates, rather than
-- to whatever happens to hold a particular id.
INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 1, 1, 'Visit the partner site and create an account',
     'Open the partner site', 'https://example.com/partner'
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 1)
ON CONFLICT DO NOTHING;

INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 1, 2, 'Confirm the email address they send you',
     'I confirmed my email', NULL
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 1)
ON CONFLICT DO NOTHING;

INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 1, 3, 'Make a first purchase of at least $5',
     'I made a purchase', NULL
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 1)
ON CONFLICT DO NOTHING;

INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 2, 1, 'Download the partner app from the app store',
     'Open the app store', 'https://example.com/app'
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 2)
ON CONFLICT DO NOTHING;

INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 2, 2, 'Install the app and sign in',
     'I am signed in', NULL
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 2)
ON CONFLICT DO NOTHING;

INSERT INTO offer_task_steps (offer_id, position, prompt, action_label, url)
SELECT 2, 3, 'Complete the first task inside the app',
     'I finished the task', NULL
WHERE EXISTS (SELECT 1 FROM offers WHERE id = 2)
ON CONFLICT DO NOTHING;

COMMIT;