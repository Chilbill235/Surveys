BEGIN;

-- A six-question survey is a stub, not a survey. The questions that were here were written
-- when the demo was the only survey in the product, and they asked about catalog sections
-- and browsing frequency -- useful for an operator, thin for a participant. A real survey asks
-- about the participant's own situation, because that is what an answer is for: an operator
-- can read "daily" and segment their audience, but "what do you do for fun" is the question
-- that decides whether someone will come back.
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
     6, FALSE),
    ('age', 'Which age range are you in?',
     '[{"value":"18-24","label":"18 to 24"},{"value":"25-34","label":"25 to 34"},{"value":"35-44","label":"35 to 44"},{"value":"45-54","label":"45 to 54"},{"value":"55-plus","label":"55 or older"}]'::jsonb,
     7, FALSE),
    ('country', 'Which country are you in?',
     '[{"value":"us","label":"United States"},{"value":"ca","label":"Canada"},{"value":"uk","label":"United Kingdom"},{"value":"au","label":"Australia"},{"value":"ie","label":"Ireland"},{"value":"other","label":"Somewhere else"}]'::jsonb,
     8, FALSE),
    ('income', 'How would you describe your household income?',
     '[{"value":"under-25","label":"Under $25,000"},{"value":"25-50","label":"$25,000 to $50,000"},{"value":"50-100","label":"$50,000 to $100,000"},{"value":"100-plus","label":"Over $100,000"},{"value":"prefer-not","label":"Prefer not to say"}]'::jsonb,
     9, FALSE),
    ('shopping', 'How often do you buy something online?',
     '[{"value":"weekly","label":"Weekly or more"},{"value":"monthly","label":"Monthly"},{"value":"occasional","label":"A few times a year"},{"value":"rarely","label":"Almost never"}]'::jsonb,
     10, FALSE),
    ('apps', 'Which of these do you use most often?',
     '[{"value":"social","label":"Social media"},{"value":"streaming","label":"Streaming video or music"},{"value":"productivity","label":"Productivity and tools"},{"value":"health","label":"Health and fitness"},{"value":"news","label":"News and reading"}]'::jsonb,
     11, FALSE),
    ('recommend', 'How likely are you to recommend this kind of thing to a friend?',
     '[{"value":"0","label":"Not at all likely"},{"value":"1-3","label":"Somewhat unlikely"},{"value":"4-6","label":"It depends"},{"value":"7-8","label":"Likely"},{"value":"9-10","label":"Very likely"}]'::jsonb,
     12, FALSE)
ON CONFLICT (question_key) DO NOTHING;

COMMIT;