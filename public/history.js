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

    // Refresh on tab focus -- the user may have completed an offer and come
    // back to see the reward land without a manual reload.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadHistory();
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

    const token = sessionStorage.getItem(accountTokenKey);
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
        renderHistoryList('all');
        loading.hidden = true;
        list.hidden = historyCache.length === 0;
        empty.hidden = historyCache.length > 0;
    } catch (error) {
        loading.hidden = true;
        errorBox.hidden = false;
    }
}

function renderHistoryList(filter) {
    const list = document.getElementById('history-list');
    if (!list) return;

    // Replace the intro and filter row with the list and empty state.
    const intro = document.getElementById('history-intro');
    if (intro) intro.hidden = false;

    list.innerHTML = '';

    const items = filter === 'all'
        ? historyCache
        : historyCache.filter((item) => item.transaction_type === filter);

    if (items.length === 0) {
        list.hidden = true;
        const empty = document.getElementById('history-list-empty');
        if (empty) empty.hidden = false;
        return;
    }

    list.hidden = false;
    document.getElementById('history-list-empty').hidden = true;

    const fragment = document.createDocumentFragment();
    const wrapper = document.createElement('div');
    wrapper.className = 'history-card';
    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'history-item is-' + item.transaction_type;
        row.innerHTML = `
            <span class="history-item-icon" aria-hidden="true">
                ${historyIconFor(item.transaction_type)}
            </span>
            <div class="history-item-details">
                <div class="history-item-title">${escapeHtml(historyTitleFor(item))}</div>
                ${item.description ? `<div class="history-item-desc">${escapeHtml(item.description)}</div>` : ''}
                <div class="history-item-time">${formatDateTime(item.created_at)}</div>
            </div>
            <span class="history-item-amount is-${item.transaction_type}">
                ${formatHistoryAmount(item)}
            </span>
        `;
        wrapper.appendChild(row);
    }
    list.appendChild(wrapper);
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

function historyTitleFor(item) {
    switch (item.transaction_type) {
        case 'deposit':    return 'Deposit credited';
        case 'withdrawal': return 'Withdrawal sent';
        case 'conversion': return 'Offer reward credited';
        case 'refund':     return 'Withdrawal refunded';
        case 'adjustment': return 'Balance adjustment';
        default:           return item.transaction_type;
    }
}

function formatHistoryAmount(item) {
    const amount = Number(item.amount);
    const formatted = formatBalance(Math.abs(amount));
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
