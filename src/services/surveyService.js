const pool = require('../config/db');

/**
 * The survey's questions, and what counts as a valid answer to them.
 *
 * These lived as a literal array in `public/demo.js` and as two `Set`s in
 * `demoController`, which meant a question added in one place and not the other produced a
 * page that offered an answer the server rejected -- or, worse, a server that accepted an
 * answer nobody was ever shown. Both are gone: the questions are rows, the page renders the
 * rows, and this module validates against the same rows.
 */

/** Bounds on the stored option shape, so a malformed row cannot become an unusable page. */
const MAX_QUESTIONS = 20;
const MAX_OPTIONS_PER_QUESTION = 12;
const MAX_PROMPT_LENGTH = 300;
const MAX_OPTION_LABEL_LENGTH = 120;

/**
 * Loads the questions for a survey, in the order the page should ask them.
 *
 * `offerId` picks between two sets: the questions that belong to this offer, and the global
 * default set. The table used to hold only the second, so every survey in the catalog was
 * literally the same questionnaire -- a partner asking about their product got asked about
 * favourite genres, and there was nowhere to record what a given survey had actually asked.
 *
 * The offer's own questions win, and the default is the fallback rather than a merge. Merging
 * would produce a survey that is half one thing and half another, and the user could not tell
 * which -- whereas "this survey has its own questions, and these are they" is a coherent form
 * with a coherent answer map. An offer that defines none gets the default, which is what makes
 * every existing survey keep working unchanged.
 *
 * One query rather than two: `offer_id = $1 OR offer_id IS NULL` fetches both candidates, and
 * the preference between them is applied in JS against rows that are already in hand. Asking
 * the database to do it would mean a window function for a set that is at most 20 rows, and the
 * ordering rules below are easier to keep honest in one place.
 *
 * The option list is normalised here rather than handed to the page as stored. A row edited
 * by hand can hold a non-array, an option without a `value`, or a label long enough to break
 * the layout, and each of those would surface as a blank radio button or a one-word answer
 * that silently does not match what was stored. An option without a usable `value` is
 * dropped rather than repaired, because a repaired value is not the one that was recorded.
 */
async function loadSurveyQuestions(offerId) {
    const owned = Number.isInteger(offerId) && offerId > 0 ? offerId : null;
    const result = await pool.query(
        `SELECT question_key, prompt, options, position, required, offer_id
         FROM survey_questions
         WHERE offer_id IS NULL OR offer_id = $1
         ORDER BY position ASC, id ASC
         LIMIT $2`,
        [owned, MAX_QUESTIONS * 2]
    );

    const forOffer = [];
    const fallback = [];
    for (const row of result.rows) {
        const question = normaliseQuestion(row);
        if (!question) continue;
        if (owned !== null && row.offer_id === owned) forOffer.push(question);
        else if (row.offer_id === null) fallback.push(question);
    }
    return forOffer.length > 0 ? forOffer : fallback;
}

/** One stored row as a question the page can render, or null if it cannot be rendered. */
function normaliseQuestion(row) {
    const options = readOptions(row.options);
    if (options.length === 0) return null;
    return {
        key: String(row.question_key),
        prompt: String(row.prompt).slice(0, MAX_PROMPT_LENGTH),
        options,
        required: row.required !== false
    };
}

/** Pulls a usable option list out of a stored JSON value, or an empty list. */
function readOptions(stored) {
    const list = Array.isArray(stored) ? stored : [];
    return list
        .filter((option) => option && typeof option === 'object')
        .map((option) => ({
            value: String(option.value ?? '').trim(),
            label: String(option.label ?? '').trim().slice(0, MAX_OPTION_LABEL_LENGTH)
        }))
        .filter((option) => option.value !== '' && option.label !== '')
        .slice(0, MAX_OPTIONS_PER_QUESTION);
}

/**
 * Whether a submitted answer set is a valid response to the current questions.
 *
 * Checked against the stored questions rather than a hardcoded list, which is what makes
 * editing a question safe: the server accepts exactly what the page was able to offer, and
 * a stale page -- one still open in a tab from before an edit -- is rejected instead of
 * quietly recording an answer to a question that no longer exists.
 *
 * A required question with no answer is a refusal, not a default. Defaulting would let a
 * skipped question be recorded as though it had been asked and answered.
 */
async function answersAreValid(answers, questions = null) {
    const survey = questions || await loadSurveyQuestions();
    if (survey.length === 0) return false;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;

    for (const question of survey) {
        const given = answers[question.key];
        if (question.required) {
            if (typeof given !== 'string' || given === '') return false;
        } else if (given === undefined || given === null || given === '') {
            continue;
        }
        // An answer must be one this question actually offered. Anything else came from
        // somewhere the page did not, and is refused rather than stored.
        if (!question.options.some((option) => option.value === given)) return false;
    }
    return true;
}

/**
 * The submitted answers, reduced to the stored questions and nothing else.
 *
 * Extra keys are dropped rather than persisted. The whole body is not stored, so an
 * unrecognised key would otherwise be written into `conversions.details` as though it were a
 * response to a question that never existed.
 */
function sanitiseAnswers(answers, questions) {
    const kept = {};
    for (const question of questions) {
        const given = answers?.[question.key];
        if (typeof given === 'string' && given !== '') kept[question.key] = given;
    }
    return kept;
}

module.exports = {
    loadSurveyQuestions,
    answersAreValid,
    sanitiseAnswers,
    readOptions,
    MAX_QUESTIONS,
    MAX_OPTIONS_PER_QUESTION
};
