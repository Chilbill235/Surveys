BEGIN;

-- A survey with two questions is a stub, not a survey. The questions that were here were
-- written when the demo was the only survey in the product, and they asked about catalog
-- sections and browsing frequency -- useful for an operator, thin for a participant. A real
-- survey asks about the participant's own situation, because that is what an answer is for:
-- an operator can read "daily" and segment their audience, but "what do you do for fun" is
-- the question that decides whether someone will come back.
--
-- The two original questions are kept verbatim in position, so existing demo clicks and their
-- recorded conversions stay meaningful. New questions are appended after them.

INSERT INTO survey_questions (question_key, prompt, options, position, required) VALUES
    ('interest', 'What are you most interested in right now?',
     '[{"value":"games","label":"Games and apps"},{"value":"shopping","label":"Shopping and deals"},{"value":"learning","label":"Learning and courses"},{"value":"finance","label":"Finance and banking"},{"value":"travel","label":"Travel"}]'::jsonb,
     3, TRUE),
    ('time', 'Roughly how much time do you have for tasks like this each week?',
     '[{"value":"under-30","label":"Under 30 minutes"},{"value":"30-60","label":"30 to 60 minutes"},{"value":"1-2","label":"1 to 2 hours"},{"value":"2-plus","label":"More than 2 hours"}]'::jsonb,
     4, TRUE),
    ('device', 'Which device do you usually use for this kind of thing?',
     '[{"value":"phone","label":"Phone"},{"value":"tablet","label":"Tablet"},{"value":"desktop","label":"Desktop or laptop"}]'::jsonb,
     5, FALSE),
    ('why', 'What brought you here today?',
     '[{"value":"gift","label":"Looking for a gift"},{"value":"extra","label":"Earning a little extra"},{"value":"bored","label":"Something to do"},{"value":"curious","label":"Just browsing"}]'::jsonb,
     6, FALSE)
ON CONFLICT (question_key) DO NOTHING;

COMMIT;