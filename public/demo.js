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

/** Seconds shown before the automatic return. Long enough to read the result, not a stall. */
const RETURN_DELAY_SECONDS = 8;

let questions = [];
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

    if (demoType !== 'survey') {
        renderConfirmationTask();
        return;
    }
    await loadSurvey();
}

/**
 * Fetches the questions, then renders the first step.
 *
 * A failed load is a refusal rather than a fallback to a built-in copy of the survey. The
 * built-in questions are exactly the thing that was removed so the page and the server could
 * not disagree; reintroducing them as a fallback would restore the drift on the one path
 * where nobody would notice it.
 */
async function loadSurvey() {
    const fields = document.getElementById('demo-fields');
    setMessage('Loading the survey...');

    let data;
    try {
        const response = await fetch('/api/demo/survey', {
            headers: { Authorization: `Bearer ${sessionStorage.getItem(demoTokenKey)}` }
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load the survey.');
        data = body;
    } catch (error) {
        return failTask(error.message);
    }

    questions = Array.isArray(data?.questions) ? data.questions : [];
    if (questions.length === 0) {
        return failTask('This survey has no questions configured yet.');
    }

    document.getElementById('demo-title').textContent = 'Quick survey';
    document.getElementById('demo-copy').textContent =
        `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}. It takes about a minute.`;
    document.getElementById('demo-submit').textContent = 'Submit answers';
    document.getElementById('demo-progress').hidden = false;
    setMessage('');

    for (const question of questions) fields.append(createQuestionGroup(question));
    showStep(0);
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
        input.required = true;

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

function createConfirmationTask() {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'demo-field';

    const legend = document.createElement('legend');
    legend.textContent = 'Confirm the task';

    const label = document.createElement('label');
    label.className = 'demo-check';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'completed';
    input.required = true;

    const text = document.createElement('span');
    text.textContent = 'I have completed the demo partner task and want to claim the test-only reward.';

    label.append(input, text);
    fieldset.append(legend, label);
    return fieldset;
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
 */
function showStep(index) {
    currentStep = Math.min(Math.max(index, 0), questions.length - 1);

    document.querySelectorAll('#demo-fields .survey-step').forEach((step) => {
        step.hidden = Number(step.dataset.step) !== currentStep;
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
    if (demoType !== 'survey' || wrapper.hidden) return;

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
    if (demoType === 'survey' && currentStep < questions.length - 1) {
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

    const answers = demoType === 'survey'
        ? Object.fromEntries(questions.map((question) => [question.key, values[question.key]]))
        : { completed: values.completed === 'on' };

    button.disabled = true;
    button.textContent = demoType === 'survey' ? 'Submitting...' : 'Saving...';
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
        button.textContent = demoType === 'survey' ? 'Submit answers' : 'Complete demo task';
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
    document.getElementById('survey-back').hidden = true;
    setMessage(data.cashValue
        ? 'Saved. This reward was paid to your real balance.'
        : 'Saved. This is simulated test credit only and has no cash value.',
        'success');
    startReturnCountdown(data.returnTo || RETURN_TO);
}

/**
 * Counts down to the return target, and sends the participant there.
 *
 * This is the difference between a survey that feels finished and one that feels abandoned.
 * The countdown is visible and the link works at any point, so the automatic return is a
 * convenience rather than something that has to be waited out -- a participant who wants to
 * look at another offer can leave in the first second.
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
