const pool = require('../config/db');

/**
 * The steps an offer asks the participant to do, in the order they should do them.
 *
 * A demo offer used to be one checkbox: "I have completed the demo partner task". That is not
 * an offer, it is a shrug. A real offer has steps -- visit a site, sign up, confirm an email,
 * make a purchase -- and the participant needs to know what is left. This loads them in order
 * so the task page can show a checklist with each step ticked off as the participant says
 * they did it.
 *
 * Steps are independent of the survey questions. A survey asks about the participant; a task
 * asks them to do things. Mixing the two in one list made both worse: a question is answered,
 * a step is ticked, and the page needs to know which is which to render either correctly.
 */

/** Bounds on the stored step shape, so a malformed row cannot become an unusable page. */
const MAX_STEPS = 20;
const MAX_PROMPT_LENGTH = 300;
const MAX_ACTION_LABEL_LENGTH = 120;

/**
 * Loads the steps for one offer, in the order the page should show them.
 *
 * A step's URL is shown to the participant as a link to click, and it is checked for a
 * usable scheme here rather than left to the browser. A browser does not refuse a
 * `javascript:` href -- it runs it in this page's origin when the participant clicks -- so
 * "the browser is what enforces it is a real URL" is not true of the one scheme that
 * matters. The row is operator-supplied rather than visitor-supplied, but the column is
 * free text.
 */
async function loadOfferTaskSteps(offerId) {
    const id = Number(offerId);
    if (!Number.isSafeInteger(id) || id <= 0) return [];

    const result = await pool.query(
        `SELECT position, prompt, action_label, url
         FROM offer_task_steps
         WHERE offer_id = $1
         ORDER BY position ASC, id ASC
         LIMIT $2`,
        [id, MAX_STEPS]
    );

    return result.rows
        .map((row) => ({
            position: Number(row.position),
            prompt: String(row.prompt || '').slice(0, MAX_PROMPT_LENGTH),
            actionLabel: String(row.action_label || '').slice(0, MAX_ACTION_LABEL_LENGTH),
            url: usableStepUrl(row.url)
        }))
        .filter((step) => step.prompt !== '' && step.actionLabel !== '');
}

/**
 * A step's link, or null when it is absent or is not a plain web address.
 *
 * Null is a legitimate answer, not a rejection: "check your email" is a step with no
 * link, and dropping the step over it would lose the instruction.
 */
function usableStepUrl(value) {
    const raw = value ? String(value).trim() : '';
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * Whether a submitted set of ticks is a valid response to the current steps.
 *
 * Checked against the stored steps rather than a hardcoded list, which is what makes editing
 * a step safe: the server accepts exactly what the page was able to offer, and a stale page
 * -- one still open in a tab from before an edit -- is rejected instead of quietly recording
 * a tick for a step that no longer exists.
 *
 * Every step must be ticked. A step that is skipped is not a completion, and defaulting it to
 * true would let a participant submit without doing the work.
 */
async function taskStepsAreValid(ticks, steps = null) {
    const list = steps || [];
    if (list.length === 0) return false;
    if (!ticks || typeof ticks !== 'object' || Array.isArray(ticks)) return false;

    for (const step of list) {
        const given = ticks[step.position];
        if (given !== true) return false;
    }
    return true;
}

module.exports = {
    loadOfferTaskSteps,
    taskStepsAreValid,
    MAX_STEPS
};