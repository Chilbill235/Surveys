/**
 * History page.
 *
 * Renders the combined transaction list (deposits, withdrawals, rewards) from
 * `GET /api/user/history`, and filters by type using tab-style buttons.
 * Reuses the auth and notification machinery from app.js (loaded before this
 * script) so the header, balance, and bell stay in sync with the rest of the
 * site.
 */

document.addEventListener('DOMContentLoaded', () => {
    initHistoryFilters();
    initHistorySignIn();
    loadHistory();
    // Sync the balance to the account page's larger display if present.
    const token = getSessionToken();
    if (token) {
        refreshBalance && refreshBalance();
    }

    // Refresh on tab focus -- the user may have completed an offer and come
    // back to see the reward land without a manual reload.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            loadHistory();
            if (getSessionToken()) {
                refreshBalance && refreshBalance();
            }
        }
    });
});

function initHistoryFilters() {
    const buttons = document.querySelectorAll('.history-filter-button');
    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            buttons.forEach((other) => {
                other.classList.toggle('is-active', other === button);
                other.setAttribute('aria-selected', String(other === button));
            });
            renderHistoryList(button.dataset.filter);
        });
    });
}

function initHistorySignIn() {
    // On the history/account page there is no standalone sign-in button to open the
    // offers page; instead the existing account-dialog (wired by app.js) handles it.
    // But if the page was loaded signed-out, a helper button may exist to bounce
    // the user to the offers page where they can sign in.
    const openOffers = document.getElementById('open-offers-signin');
    if (openOffers) {
        openOffers.addEventListener('click', () => {
            window.location.href = '/offers';
        });
    }
}

let historyCache = [];

async function loadHistory() {
    const loading = document.getElementById('history-loading');
    const errorBox = document.getElementById('history-error');
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-list-empty');

    const token = getSessionToken();
    if (!token) {
        loading.textContent = 'Sign in to see your transaction history.';
        return;
    }

    loading.hidden = false;
    errorBox.hidden = true;
    list.hidden = true;
    empty.hidden = true;

    try {
        const response = await fetch('/api/user/history', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (handleUnauthorizedResponse(response)) return;
        if (!response.ok) throw new Error('Could not load history.');

        const data = await response.json();
        historyCache = Array.isArray(data) ? data : [];
        // `renderHistoryList` already decides whether the list or the empty state is shown,
        // including which empty state. Setting `list.hidden` and `empty.hidden` again here
        // was a second, simpler copy of that decision -- and it disagreed with the filter
        // the user may have selected, since it always assumed the `all` view.
        renderHistoryList('all');
        loading.hidden = true;
    } catch (error) {
        loading.hidden = true;
        errorBox.hidden = false;
    }
}

/**
 * The copy and the call to action for an empty history.
 *
 * Keyed by filter, because "you have no transactions" and "your deposits tab is empty" are
 * different situations with different sentences. What they are *not* is different enough to
 * warrant a different action: every one of them now offers "Browse offers" and nothing else.
 *
 * The `all` and `deposit` states used to carry a second button, "Add funds", pointing at
 * `/account`. That was a money control in a list of transactions, so on the account page -- the
 * page these states render on, below a balance card that already has Deposit and Withdraw, and
 * with the account menu carrying both in the header -- it was a fourth copy of the same two
 * controls. It also read as a *tab*, sitting in a row beside "Browse offers" with the same
 * button treatment, which is not what it was. One action per empty state, and it is the one
 * that actually adds something to the account.
 */
const EMPTY_HISTORY_COPY = {
    all: {
        title: 'No transactions yet',
        copy: 'Deposits, withdrawals, and rewards all land here. Complete an offer to start earning, or add funds to see a deposit receipt.',
        primary: { label: 'Browse offers', href: '/offers' },
        secondary: null
    },
    deposit: {
        title: 'No deposits yet',
        copy: 'Anything you add to your balance shows up here with a receipt. Your balance is currently whatever you have earned from offers.',
        primary: { label: 'Browse offers', href: '/offers' },
        secondary: null
    },
    withdrawal: {
        title: 'No withdrawals yet',
        copy: 'When you request a payout it appears here with its status, and again if the money is returned to your balance.',
        primary: { label: 'Browse offers', href: '/offers' },
        secondary: null
    },
    conversion: {
        title: 'No rewards yet',
        copy: 'Complete an offer and the reward posts straight to your balance, with a line here showing what it was for and when it landed.',
        primary: { label: 'Browse offers', href: '/offers' },
        secondary: null
    },
    refund: {
        title: 'No refunds yet',
        copy: 'If a withdrawal cannot be completed the money goes back to your balance, and the return is recorded here.',
        primary: { label: 'Browse offers', href: '/offers' },
        secondary: null
    }
};

/**
 * Applies one of the empty states above to the markup.
 *
 * The buttons are left in the document and hidden rather than removed and rebuilt, so the
 * focus a user has on one of them survives the state change. Rebuilding them would drop a
 * keyboard user's focus to the body on every filter change, which is the one interaction
 * on this page that a keyboard user does repeatedly.
 */
function paintEmptyState(filter) {
    const empty = document.getElementById('history-list-empty');
    if (!empty) return;

    const copy = EMPTY_HISTORY_COPY[filter] || EMPTY_HISTORY_COPY.all;
    const title = document.getElementById('history-empty-title');
    const body = document.getElementById('history-empty-copy');
    const primary = document.getElementById('history-empty-primary');
    const secondary = document.getElementById('history-empty-secondary');

    if (title) title.textContent = copy.title;
    if (body) body.textContent = copy.copy;

    for (const [element, action] of [[primary, copy.primary], [secondary, copy.secondary]]) {
        if (!element) continue;
        // A state with no action for this filter hides the button rather than offering a
        // link to somewhere unhelpful. "No refunds yet" pointing at the offers page would be
        // an answer to a question nobody asked.
        element.hidden = !action;
        if (action) {
            element.textContent = action.label;
            element.setAttribute('href', action.href);
        }
    }

    empty.hidden = false;
}

function renderHistoryList(filter) {
    const list = document.getElementById('history-list');
    if (!list) return;

    // The intro and the filter row stay in place above the result. Hiding them when the
    // result was empty made the filters disappear at exactly the moment they were most
    // useful -- the user needs them to switch away from a tab with nothing on it.
    const intro = document.getElementById('history-intro');
    if (intro) intro.hidden = false;

    list.innerHTML = '';

    const items = filter === 'all'
        ? historyCache
        : historyCache.filter((item) => item.transaction_type === filter);

    if (items.length === 0) {
        list.hidden = true;
        paintEmptyState(filter);
        return;
    }

    list.hidden = false;
    document.getElementById('history-list-empty').hidden = true;

    const fragment = document.createDocumentFragment();
    const wrapper = document.createElement('div');
    wrapper.className = 'history-card';
    for (const item of items) {
        const type = historyTypeFor(item.transaction_type);
        const test = isTestRow(item);
        const row = document.createElement('div');
        // `is-test` is set from the response flag, not from the type, so a test deposit and a
        // test reward are both marked the same way by the same rule.
        row.className = 'history-item is-' + type + (test ? ' is-test' : '');
        row.innerHTML = `
            <span class="history-item-icon" aria-hidden="true">
                ${historyIconFor(type)}
            </span>
            <div class="history-item-details">
                <div class="history-item-title">${escapeHtml(historyTitleFor(item))}</div>
                ${test ? '<span class="history-item-badge">Test balance</span>' : ''}
                ${item.description ? `<div class="history-item-desc">${escapeHtml(item.description)}</div>` : ''}
                <div class="history-item-time">${formatDateTime(item.created_at)}</div>
            </div>
            <span class="history-item-amount is-${type}">
                ${formatHistoryAmount(item)}
            </span>
        `;
        wrapper.appendChild(row);
    }
    list.appendChild(wrapper);
}

/**
 * Every transaction type the stylesheet has a rule for, and the only values allowed to reach
 * `class="history-item is-..."` and the matching amount span.
 *
 * The raw column used to be concatenated straight into both the class and an `innerHTML`
 * template. That was wrong twice over. A type containing a space injected extra classes onto
 * the row through `className`; a missing or unrecognised type produced the literal class `is-`,
 * which matches no rule, so the amount silently lost its deposit/withdrawal colouring. And
 * because one of those two sites was inside a template string assigned to `innerHTML`, the
 * value reached the HTML parser unescaped -- the neighbouring `item.description` and title
 * are both run through `escapeHtml`, so this was an oversight rather than a decision, and any
 * path that ever put markup in a type would have executed it.
 *
 * Resolving through one fixed list makes both problems structurally impossible, which is why
 * the result is interpolated below without escaping: it can only ever be one of these
 * strings. Do not inline the raw column in markup instead -- use this.
 */
const HISTORY_TYPES = ['deposit', 'withdrawal', 'conversion', 'refund', 'adjustment'];

function historyTypeFor(value) {
    return HISTORY_TYPES.includes(value) ? value : 'adjustment';
}

function historyIconFor(type) {
    switch (type) {
        case 'deposit':    return NOTIFICATION_CATEGORY_ICONS.deposit;
        case 'withdrawal': return NOTIFICATION_CATEGORY_ICONS.withdrawal;
        case 'conversion': return NOTIFICATION_CATEGORY_ICONS.reward;
        case 'refund':     return NOTIFICATION_CATEGORY_ICONS.magic;
        case 'adjustment': return NOTIFICATION_CATEGORY_ICONS.survey;
        default:           return TOAST_ICONS.info;
    }
}

/**
 * Whether a row moved the test balance rather than the real one.
 *
 * The history endpoint returns `is_demo` on every row rather than filtering these out. A
 * completed demo offer is the only thing a new user can actually do, so hiding its reward
 * behind a filter left the Rewards tab permanently on "No rewards yet" -- telling someone they
 * had earned nothing immediately after they had earned something.
 *
 * The response is honest about which balance moved; this is where it becomes honest on screen.
 * A test row is rendered with a "Test" badge, in the muted colour rather than the success
 * green, and with no `+` in front of the amount. `+$1.00` in green next to a real balance is
 * the exact thing the old exclusion was protecting against, and this keeps that protection
 * while letting the reward be seen at all.
 */
function isTestRow(item) {
    return item.is_demo === true;
}

function historyTitleFor(item) {
    // Switched on the resolved type rather than the raw column, so an unrecognised value
    // reads as the same neutral "adjustment" the icon and the colour already use, instead of
    // printing whatever the column happened to hold as the row's title.
    switch (historyTypeFor(item.transaction_type)) {
        case 'deposit':    return 'Deposit credited';
        case 'withdrawal':
            if (item.status === 'paid') return 'Withdrawal sent';
            if (item.status === 'failed') return 'Withdrawal failed';
            if (item.status === 'refunded') return 'Withdrawal refunded';
            return 'Withdrawal requested';
        case 'conversion': return isTestRow(item) ? 'Test offer reward' : 'Offer reward credited';
        case 'refund':     return 'Withdrawal refunded';
        default:           return 'Balance adjustment';
    }
}

/**
 * The amount, with a sign only when the row moved real money.
 *
 * `+` is a claim that the balance went up by this much, and for a test row it did not -- so it
 * is dropped there. The number is still shown, because the test balance did go up by it and
 * that is what the user is checking.
 */
function formatHistoryAmount(item) {
    const amount = Number(item.amount);
    const formatted = formatBalance(Math.abs(amount));
    if (isTestRow(item)) return formatted;
    const symbol = amount < 0 ? '-' : '+';
    return `${symbol}${formatted}`;
}

function formatDateTime(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function handleUnauthorizedResponse(response) {
    if (response.status === 401 || response.status === 403) {
        document.getElementById('history-loading').textContent = 'Sign in to see your transaction history.';
        document.getElementById('history-loading').hidden = false;
        return true;
    }
    return false;
}
