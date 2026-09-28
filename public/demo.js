/* Demo task page.
 *
 * Questions are rendered as card-style radio groups rather than <select> dropdowns:
 * a dropdown hides the other answers behind a tap, which makes a short survey feel
 * slower than it is and does not work well with a keyboard. Radios also give native
 * arrow-key navigation and a real form value without any custom state.
 *
 * The survey is paged -- one question at a time, with Back and Next -- because that is how
 * survey providers present a questionnaire and because it is what works on a phone. A wall
 * of question groups scrolls past the point where a person is answering, and on a small
 * screen the submit button ends up several screens below the last question, so the answers
 * that matter are not in view when the decision is made.
 *
 * Questions come from `GET /api/demo/survey` rather than being written here, so the page
 * offers exactly what the server will accept. They used to be defined twice -- once here and
 * once as two `Set`s in the controller -- and editing one without the other produced a page
 * that offered an answer the server rejected.
 *
 * On completion the page returns to the offer wall by itself, as a survey provider does. A
 * participant who finishes a questionnaire and then has to find their own way back is the
 * part of the flow that loses people; the countdown is shown and the link is right there for
 * anyone the automatic return would not suit.
 *
 * Nothing here sets a `style` attribute; the Content-Security-Policy is
 * `style-src 'self'`, so custom properties go through CSSOM.
 */

const demoTokenKey = 'offerNetworkSessionToken';
const params = new URLSearchParams(window.location.search);
const demoClickId = params.get('click_id') || '';
const demoType = params.get('type') === 'survey' ? 'survey' : 'offer';

/**
 * Where the participant is returned to after completion.
 *
 * Always the offer wall by default rather than a value from the query string: an open redirect
 * built from a URL parameter is a way to make this page's "return to RewardZone" link land
 * somewhere else wearing its name. The server may override it with the offer's own
 * `completion_url`, which is part of the offer rather than of this page.
 */
const RETURN_TO = '/offers';

/** Seconds shown before the automatic return. Short: a participant who finished wants to
 * keep going, and a countdown that waits is friction. The link is always available, so the
 * automatic return is a convenience rather than something that has to be waited out. */
const RETURN_DELAY_SECONDS = 2;

let questions = [];
    let steps = [];
    let currentStep = 0;
    let returnTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('demo-form').addEventListener('submit', onSubmit);
    document.getElementById('demo-form').addEventListener('change', onAnswerChanged);
    document.getElementById('survey-back').addEventListener('click', onStepBack);
    start();
});

async function start() {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(demoClickId)) {
        return failTask('This demo link is missing a valid click ID. Start the task from the offers page.');
    }
    if (!sessionStorage.getItem(demoTokenKey)) {
        return failTask('Sign in from the offers page to complete this task.');
    }

    // The page used to branch on the `type` query parameter, which the engage handler sets from
    // the offer row. It is a hint, and a stale one -- an offer that changes type after a click
    // is recorded leaves the page rendering the old shape. The survey endpoint now answers with
    // `offerType`, which is what the server actually thinks this click is for, so the page
    // asks and the server decides.
    await loadTask();
}

/**
 * Fetches the task the server thinks this click is for, then renders it.
 *
 * A failed load is a refusal rather than a fallback to a built-in copy of the survey. The
 * built-in questions are exactly the thing that was removed so the page and the server could
 * not disagree; reintroducing them as a fallback would restore the drift on the one path
 * where nobody would notice it.
 */
async function loadTask() {
    const fields = document.getElementById('demo-fields');
    setMessage('Loading the task...');

    let data;
    try {
        const response = await fetch(`/api/demo/survey?clickId=${encodeURIComponent(demoClickId)}`, {
            headers: { Authorization: `Bearer ${sessionStorage.getItem(demoTokenKey)}` }
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load the task.');
        data = body;
    } catch (error) {
        return failTask(error.message);
    }

    const isSurvey = data.offerType === 'survey';
    if (isSurvey) {
        questions = Array.isArray(data?.questions) ? data.questions : [];
        if (questions.length === 0) {
            return failTask('This survey has no questions configured yet.');
        }
        // The server does not send a step index, and using the array position in two places is
        // how they drift. Assign it here once, from the order the server returned, so the
        // rendering, the step counter, and the progress bar all agree about which question is
        // which. Without this every fieldset's data-step was "undefined", showStep(0) matched
        // nothing, and the survey appeared to have no questions at all.
        questions = questions.map((question, index) => ({ ...question, index }));

        document.getElementById('demo-title').textContent = 'Quick survey';
        document.getElementById('demo-copy').textContent =
            `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}. It takes about a minute.`;
        document.getElementById('demo-submit').textContent = 'Submit answers';
        document.getElementById('demo-progress').hidden = false;
        setMessage('');

        for (const question of questions) fields.append(createQuestionGroup(question));
        showStep(0);
        return;
    }

    steps = Array.isArray(data?.steps) ? data.steps : [];
    if (steps.length === 0) {
        return failTask('This task has no steps configured yet.');
    }

    document.getElementById('demo-title').textContent = 'Partner task';
    document.getElementById('demo-copy').textContent =
        `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}. Tick each one as you do it.`;
    document.getElementById('demo-submit').textContent = 'Complete task';
    document.getElementById('demo-progress').hidden = false;
    setMessage('');

    for (const step of steps) fields.append(createTaskStep(step));
    updateTaskProgress();
}

/** Builds one labelled radio group, wrapped in a fieldset for grouping semantics. */
function createQuestionGroup(question) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'demo-field survey-step';
    // Each step is a group of its own, and only the current one is shown. The fieldset is
    // still in the form when hidden, so the answers are submitted without any extra state.
    fieldset.dataset.step = String(question.index);
    fieldset.hidden = true;

    const legend = document.createElement('legend');
    legend.className = 'survey-legend';
    legend.innerHTML = '';
    legend.append(
        Object.assign(document.createElement('span'), {
            className: 'survey-step-count',
            textContent: `Question ${question.index + 1} of ${questions.length}`
        }),
        Object.assign(document.createElement('span'), {
            className: 'survey-prompt',
            textContent: question.prompt
        })
    );

    const grid = document.createElement('div');
    grid.className = 'choice-grid survey-options';

    question.options.forEach((option) => {
        const label = document.createElement('label');
        label.className = 'choice';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = question.key;
        input.value = option.value;
        // `required` is set per question, not per radio. A question the survey marks optional
        // must not be required: a participant who skips it is still submitting a valid
        // answer set, and marking it required would refuse them for a question nobody asked
        // them to answer.
        input.required = question.required === false ? false : true;

        const text = document.createElement('span');
        text.textContent = option.label;

        label.append(input, text);
        grid.append(label);
    });

    fieldset.append(legend, grid);
    return fieldset;
}

function renderConfirmationTask() {
    const fields = document.getElementById('demo-fields');
    document.getElementById('demo-title').textContent = 'Demo partner task';
    document.getElementById('demo-copy').textContent =
        'This local task tests click tracking and completion without leaving RewardZone.';
    fields.append(createConfirmationTask());
}

/**
 * One step of a partner task: a checkbox the participant ticks to say they did the thing.
 *
 * A demo offer used to be one checkbox saying "I have completed the demo partner task", which
 * is not an offer, it is a shrug. A real offer has steps -- visit a site, sign up, confirm an
 * email, make a purchase -- and the participant needs to know what is left. Each step is its
 * own labelled checkbox, shown in order, so the page is a checklist rather than a single
 * assertion. The server records which were ticked, so the completion is a set of steps rather
 * than a boolean, and an operator can see what was actually done.
 *
 * The step's own URL, when it has one, is a real link the participant clicks. It is opened in
 * the same tab: the page stays in the tab, the participant does the thing, comes back, and
 * ticks the box. Opening it in a new tab would leave this page unreachable behind a tab the
 * participant may not return to.
 */
function createTaskStep(step) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'demo-field task-step';
    fieldset.dataset.position = String(step.position);

    const legend = document.createElement('legend');
    legend.className = 'task-legend';
    legend.append(
        Object.assign(document.createElement('span'), {
            className: 'task-step-count',
            textContent: `Step ${step.position} of ${steps.length}`
        }),
        Object.assign(document.createElement('span'), {
            className: 'task-prompt',
            textContent: step.prompt
        })
    );

    const label = document.createElement('label');
    label.className = 'demo-check';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = String(step.position);
    input.value = 'on';
    input.required = true;
    input.addEventListener('change', updateTaskProgress);

    const text = document.createElement('span');
    text.textContent = step.actionLabel;

    label.append(input, text);

    if (step.url) {
        const link = document.createElement('a');
        link.className = 'task-link';
        link.href = step.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open the partner site';
        fieldset.append(legend, label, link);
    } else {
        fieldset.append(legend, label);
    }

    return fieldset;
}

/**
 * Shows how many steps are ticked.
 *
 * Counted over every step, not the visible one, so the bar reflects the whole task and does
 * not jump back when the participant scrolls. A task is not paged like a survey -- the
 * participant needs to see what is left -- so this is a single checklist with a count.
 */
function updateTaskProgress() {
    const wrapper = document.getElementById('demo-progress');
    if (steps.length === 0 || wrapper.hidden) return;

    const ticked = steps.filter((step) => {
        const input = document.querySelector(
            `#demo-fields input[name="${CSS.escape(step.position)}"]`
        );
        return Boolean(input && input.checked);
    }).length;

    const percent = steps.length === 0 ? 0 : Math.round((ticked / steps.length) * 100);
    document.getElementById('demo-progress-bar').style.width = `${percent}%`;
    document.getElementById('demo-progress-label').textContent =
        `${ticked} of ${steps.length} steps done`;
}

function setMessage(text, variant) {
    const message = document.getElementById('demo-message');
    message.className = 'form-message';
    if (variant) message.classList.add(`is-${variant}`);
    message.textContent = text;
}

function failTask(message) {
    setMessage(message, 'error');
    document.getElementById('demo-form').hidden = true;
    document.getElementById('demo-progress').hidden = true;
}

/**
 * Shows one question, hides the rest, and moves the buttons to match.
 *
 * The submit button becomes "Next" until the last question, so there is a single forward
 * control and no separate "next" that could disagree with it about which is which.
 *
 * A `required` radio inside a fieldset that is not visible is reported by the browser as an
 * invalid, unfocusable control -- six warnings for a six-question survey, one per hidden
 * step, every time the page loads. Toggling `required` off the steps that are not shown and
 * back on when they become visible is what makes the validity check describe the page as it
 * is rather than as it will be: only the question in front of the participant is required
 * to be answered before it can advance.
 */
function showStep(index) {
    currentStep = Math.min(Math.max(index, 0), questions.length - 1);

    document.querySelectorAll('#demo-fields .survey-step').forEach((step) => {
        const visible = Number(step.dataset.step) === currentStep;
        step.hidden = !visible;
        step.querySelectorAll('input').forEach((input) => {
            input.required = visible;
        });
    });

    const submit = document.getElementById('demo-submit');
    const back = document.getElementById('survey-back');
    const isLast = currentStep === questions.length - 1;

    submit.textContent = isLast ? 'Submit answers' : 'Next';
    back.hidden = currentStep === 0;

    updateProgress();
    // The first option is focused so the arrow keys work immediately and a screen reader
    // starts at the question rather than at the top of the document.
    const first = document.querySelector(
        `#demo-fields .survey-step[data-step="${currentStep}"] input`
    );
    if (first) first.focus({ preventScroll: true });
}

function onStepBack() {
    if (currentStep > 0) showStep(currentStep - 1);
}

/** Re-answers a step after it has been visited, which is what makes Next accept it. */
function onAnswerChanged(event) {
    const step = event.target.closest?.('.survey-step');
    if (!step) return;
    updateProgress();
}

/**
 * Shows how much of the survey is answered.
 *
 * Counted over every question, not the visible one, so the bar reflects the whole survey
 * and does not jump back to a third when the participant returns to an earlier question.
 */
function updateProgress() {
    const wrapper = document.getElementById('demo-progress');
    if (questions.length === 0 || wrapper.hidden) return;

    const answered = questions.filter((question) => {
        const input = document.querySelector(
            `#demo-fields input[name="${CSS.escape(question.key)}"]:checked`
        );
        return Boolean(input);
    }).length;

    const percent = questions.length === 0 ? 0 : Math.round((answered / questions.length) * 100);
    document.getElementById('demo-progress-bar').style.width = `${percent}%`;
    document.getElementById('demo-progress-label').textContent =
        answered === 0
            ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} to answer`
            : `${answered} of ${questions.length} answered`;
}

/**
 * Advances rather than submits, until the last question.
 *
 * HTML validation runs first: a step with nothing chosen must not advance, or the
 * participant ends up on question three having skipped two.
 */
function onSubmit(event) {
    event.preventDefault();
    // A task is not paged -- the participant needs to see what is left -- so it submits
    // directly. Only the survey advances.
    if (questions.length > 0 && currentStep < questions.length - 1) {
        if (!document.getElementById('demo-form').reportValidity()) return;
        showStep(currentStep + 1);
        return;
    }
    submitTask();
}

async function submitTask() {
    const form = document.getElementById('demo-form');
    const button = document.getElementById('demo-submit');
    const values = Object.fromEntries(new FormData(form).entries());

    // The shape of the answers depends on what the server said this click is for, which is
    // what `questions` and `steps` hold after `loadTask`. A survey answers by question key;
    // a task ticks by step position. The server validates against the same definitions, so a
    // stale page cannot submit a shape the server no longer accepts.
    const answers = questions.length > 0
        ? Object.fromEntries(questions.map((question) => [question.key, values[question.key]]))
        : Object.fromEntries(
            steps.map((step) => [String(step.position), values[String(step.position)] === 'on'])
        );

    button.disabled = true;
    button.textContent = 'Saving...';
    setMessage('');

    try {
        const response = await fetch('/api/demo/complete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionStorage.getItem(demoTokenKey)}`
            },
            body: JSON.stringify({ clickId: demoClickId, answers })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not complete the demo.');

        form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
        showResult(data);
    } catch (error) {
        setMessage(error.message, 'error');
        button.disabled = false;
        button.textContent = questions.length > 0 ? 'Submit answers' : 'Complete task';
    }
}

function showResult(data) {
    const result = document.getElementById('demo-result');
    const repeat = Boolean(data.alreadyCompleted);

    result.classList.toggle('is-repeat', repeat);
    if (data.cashValue) {
        result.textContent = repeat
            ? `This task was already completed. Your balance: ${formatMoney(data.balance)}.`
            : `Added ${formatMoney(data.credited)} to your balance. New balance: ${formatMoney(data.balance)}.`;
    } else {
        result.textContent = repeat
            ? `This task was already completed. Test-only balance: ${formatMoney(data.demoBalance)}.`
            : `Added ${formatMoney(data.credited)} to your test-only balance. New test balance: ${formatMoney(data.demoBalance)}.`;
    }
    result.hidden = false;

    document.getElementById('demo-progress').hidden = true;
    // `survey-back` only exists on the survey page. Guarding the lookup rather than assuming
    // the element is present keeps the same code working for a task, which has no back button.
    const back = document.getElementById('survey-back');
    if (back) back.hidden = true;
    setMessage(data.cashValue
        ? 'Saved. This reward was paid to your real balance.'
        : 'Saved. This is simulated test credit only and has no cash value.',
        'success');
    startReturnCountdown(data.returnTo || RETURN_TO);
}

/**
 * Sends the participant back to the offers page (or the offer's own completion URL).
 *
 * The countdown is short because a participant who finished wants to keep going, and waiting
 * is friction. The link is always available, so the automatic return is a convenience rather
 * than something that has to be waited out -- a participant who wants to look at another offer
 * can leave in the first second.
 */
function startReturnCountdown(target) {
    const destination = typeof target === 'string' && target.startsWith('/')
        ? target
        : RETURN_TO;
    const countdown = document.getElementById('return-countdown');
    const link = document.getElementById('return-link');
    if (!countdown || !link) return;

    countdown.hidden = false;
    link.hidden = false;
    link.href = destination;

    let remaining = RETURN_DELAY_SECONDS;
    const paint = () => {
        countdown.textContent = `Returning you to the offers page in ${remaining} second${remaining === 1 ? '' : 's'}.`;
        if (remaining <= 0) {
            window.clearInterval(returnTimer);
            returnTimer = null;
            window.location.assign(destination);
            return;
        }
        remaining -= 1;
    };
    paint();
    returnTimer = window.setInterval(paint, 1000);
}

function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
        : '--';
}
