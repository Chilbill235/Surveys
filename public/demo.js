/* Demo task page.
 *
 * Questions are rendered as card-style radio groups rather than <select> dropdowns:
 * a dropdown hides the other answers behind a tap, which makes a short survey feel
 * slower than it is and does not work well with a keyboard. Radios also give native
 * arrow-key navigation and a real form value without any custom state.
 *
 * Nothing here sets a `style` attribute; the Content-Security-Policy is
 * `style-src 'self'`, so custom properties go through CSSOM.
 */

const demoTokenKey = 'offerNetworkSessionToken';
const params = new URLSearchParams(window.location.search);
const demoClickId = params.get('click_id') || '';
const demoType = params.get('type') === 'survey' ? 'survey' : 'offer';

const questions = [
    {
        name: 'favorite',
        label: 'Which catalog section interests you most?',
        options: [
            { value: 'games', label: 'Games' },
            { value: 'shopping', label: 'Shopping' },
            { value: 'learning', label: 'Learning' }
        ]
    },
    {
        name: 'frequency',
        label: 'How often do you browse offers?',
        options: [
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' },
            { value: 'rarely', label: 'Rarely' }
        ]
    }
];

document.addEventListener('DOMContentLoaded', () => {
    renderDemoTask();
    document.getElementById('demo-form').addEventListener('submit', submitDemoTask);
    document.getElementById('demo-form').addEventListener('change', updateProgress);
});

function setMessage(text, variant) {
    const message = document.getElementById('demo-message');
    message.className = 'form-message';
    if (variant) message.classList.add(`is-${variant}`);
    message.textContent = text;
}

function failTask(message) {
    setMessage(message, 'error');
    document.getElementById('demo-form').hidden = true;
}

function renderDemoTask() {
    const title = document.getElementById('demo-title');
    const copy = document.getElementById('demo-copy');
    const fields = document.getElementById('demo-fields');

    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(demoClickId)) {
        return failTask('This demo link is missing a valid click ID. Start the task from the offers page.');
    }
    if (!sessionStorage.getItem(demoTokenKey)) {
        return failTask('Sign in from the offers page to complete this task.');
    }

    if (demoType === 'survey') {
        title.textContent = 'Short demo survey';
        copy.textContent = 'Answer both questions to test survey completion. Two answers are required.';
        document.getElementById('demo-submit').textContent = 'Submit answers';
        questions.forEach((question) => fields.append(createQuestionGroup(question)));
        document.getElementById('demo-progress').hidden = false;
    } else {
        title.textContent = 'Demo partner task';
        copy.textContent = 'This local task tests click tracking and completion without leaving RewardZone.';
        fields.append(createConfirmationTask());
    }
    updateProgress();
}

/** Builds one labelled radio group, wrapped in a fieldset for grouping semantics. */
function createQuestionGroup(question) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'demo-field';

    const legend = document.createElement('legend');
    legend.textContent = question.label;

    const grid = document.createElement('div');
    grid.className = 'choice-grid';

    question.options.forEach((option) => {
        const label = document.createElement('label');
        label.className = 'choice';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = question.name;
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

/**
 * Shows how much of the task is answered.
 *
 * Only meaningful for the survey, where there is more than one question. A progress
 * bar that never moves is worse than none, so it is hidden for the single-step task.
 */
function updateProgress() {
    const wrapper = document.getElementById('demo-progress');
    if (demoType !== 'survey' || wrapper.hidden) return;

    const inputs = [...document.querySelectorAll('#demo-fields input[type="radio"]')];
    if (inputs.length === 0) return;

    const answered = new Set(inputs.filter((input) => input.checked).map((input) => input.name)).size;
    const percent = Math.round((answered / questions.length) * 100);

    document.getElementById('demo-progress-bar').style.width = `${percent}%`;
    document.getElementById('demo-progress-label').textContent =
        answered === 0
            ? 'Answer both questions to continue'
            : `${answered} of ${questions.length} answered`;
}

async function submitDemoTask(event) {
    event.preventDefault();
    const form = document.getElementById('demo-form');
    const button = document.getElementById('demo-submit');
    const values = Object.fromEntries(new FormData(form).entries());

    const answers = demoType === 'survey'
        ? { favorite: values.favorite, frequency: values.frequency }
        : { completed: values.completed === 'on' };

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
        button.textContent = 'Completed';
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
    result.textContent = repeat
        ? `This task was already completed. Test-only balance: ${formatMoney(data.demoBalance)}.`
        : `Added ${formatMoney(data.credited)} to your test-only balance. New test balance: ${formatMoney(data.demoBalance)}.`;
    result.hidden = false;

    document.getElementById('demo-progress').hidden = true;
    setMessage('Saved. This is simulated test credit only and has no cash value.', 'success');
}

function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
        : '--';
}
