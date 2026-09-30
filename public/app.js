/* RewardZone offers page.
 *
 * Design notes worth keeping:
 *  - `offerState` and the payment state below are the only mutable module state.
 *  - The withdrawal asset/network pickers are built from GET /api/user/withdrawal-options
 *    rather than a hardcoded list, so the form can never offer a destination the server
 *    would reject. The server also owns address validation; the client only shows the
 *    per-network hint it supplies, which keeps the address rules in one place.
 *  - Nothing here sets a `style` attribute, because the Content-Security-Policy is
 *    `style-src 'self'`. Custom properties are set through CSSOM, which CSP allows.
 */

const accountTokenKey = 'offerNetworkSessionToken';
/**
 * The signed-in address, kept beside the token and cleared with it.
 *
 * `contact.js` reads this to pre-fill the support form. It lives in `sessionStorage` rather
 * than `localStorage` because it is a property of the current session: an address left in
 * local storage outlives the sign-out, so a shared machine would offer the previous user's
 * address to whoever opened the contact form next, and a reply would go to them.
 */
const accountEmailKey = 'rewardZoneEmail';

/**
 * The session token, or `null` if there is not a usable one.
 *
 * Every read of `accountTokenKey` goes through here, and that is not tidiness -- it is the
 * fix for a bug that filled the server log with rejections nobody could act on.
 *
 * `completeSignIn` used to store `data.token` with no check. `sessionStorage.setItem(key,
 * undefined)` does not fail and does not store `undefined`; it stores the four-letter string
 * `"undefined"`. So any sign-in response that was not the shape the code expected -- a proxy
 * that answered 200 with an error body, an API field renamed, a partial response -- quietly
 * put a non-token in the session slot. From then on the page believed it was signed in and
 * every authenticated request sent `Authorization: Bearer undefined`, which the server
 * correctly rejected and logged as `jwt malformed` -- including on the live-sync poll, so
 * every few seconds, for as long as the tab was open, and again on the next page load.
 *
 * Two things have to be true for this to stop, and both are here:
 *
 *   1. A value that is not a token is never stored in the first place. `completeSignIn`
 *      validates before it writes.
 *   2. A value that is already in storage from an older build, or that got in some other way,
 *      is not trusted on the way out. This function treats anything that is not three
 *      base64url segments as "not signed in".
 *
 * The second is the one that matters for people already affected. Without it they would have
 * to clear site data by hand to stop the log filling up, because the poisoned value is
 * indistinguishable from a real one to every other line of code.
 *
 * The shape test is deliberately structural rather than a full parse: three non-empty
 * base64url segments joined by dots is what a JWT is, and the signature is verified on the
 * server. This is a check that stops garbage being sent, not a security boundary -- a caller
 * with a forged token still gets nowhere.
 */
function getSessionToken() {
    let raw = null;
    try {
        raw = sessionStorage.getItem(accountTokenKey);
    } catch {
        // Storage disabled or blocked. Not being able to read a session means not being
        // signed in, which is the correct answer rather than a reason to send a guess.
        return null;
    }
    return getSessionTokenFrom(raw);
}

/**
 * Whether `value` is shaped like a JWT: three non-empty base64url segments.
 *
 * Split out so the check applied to a token on its way into storage and the check applied to
 * one on its way out are the same test, defined once. Two copies of this is one more place
 * for the two to disagree, and the disagreement is the bug.
 *
 * This filters garbage; it is not a security boundary. It answers "is this worth sending".
 * Whether the token is genuine is decided by its signature, on the server.
 */
function getSessionTokenFrom(value) {
    if (typeof value !== 'string' || value.length < 20) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)) ? value : null;
}

/**
 * The `Authorization` header for an authenticated request, or nothing at all.
 *
 * This exists so that no call site can accidentally send `Bearer null`. Interpolating a token
 * getter that can return `null` into a header string is the obvious thing to do, and it
 * produces exactly the bug the getter was added to stop: the string "null" is a perfectly good
 * bearer value as far as the server is concerned, and it logs a `jwt malformed` rejection for
 * every request.
 *
 * Returning `{}` instead of a header is the correct outcome when there is no session: the
 * request goes out anonymous, the route treats it as anonymous, and nothing is logged. Most of
 * these routes are already guarded by an explicit token check, so this is the second line --
 * but the second line is the one that is always on.
 *
 * Spread it: `headers: { ...authHeaders(), 'Content-Type': 'application/json' }`.
 */
function authHeaders() {
    const token = getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

const offerState = { all: [], search: '', sort: 'featured', type: 'all' };
const depositState = { options: null, method: 'crypto' };
/**
 * Ids of deposits already seen in a credited state.
 *
 * The success screen must fire on the *transition*, not on the state. Without this, every
 * poll re-announced the same already-credited deposit forever -- which is also why the
 * old code needed a one-shot `depositHistorySignature` flag to stop it looping.
 *
 * Backed by `sessionStorage` rather than kept in memory, because an in-memory set starts empty
 * on every page load: reloading the dashboard replayed the success screen for every deposit
 * ever credited, which is the opposite of what a transition is supposed to mean.
 *
 * `sessionStorage` rather than `localStorage` is deliberate. The announcement is real
 * information -- "your money arrived" -- and it should survive a reload, but not be suppressed
 * forever. With `localStorage`, a user whose tab closed on the success screen would never be
 * told about a credit that landed while they were away. Per-tab, and gone when the tab closes,
 * is the right lifetime for "you have already been shown this".
 *
 * Same interface as the `Set` it replaces (`has` / `add`), so the call sites are unchanged and
 * there is one place that owns the storage.
 */
const CREDITED_SEEN_KEY = 'offerNetworkCreditedDepositsSeen';
// Bounded so a long-lived tab cannot grow the entry without limit. Only the most recent
// credits need remembering: anything older has long since been acknowledged, and the set is
// only consulted to avoid repeating something the user has already seen.
const CREDITED_SEEN_LIMIT = 50;

/** Session storage throws rather than returning null when it is disabled or full. */
function readCreditedSeen() {
    try {
        const raw = window.sessionStorage.getItem(CREDITED_SEEN_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
        // No storage, or corrupt contents. An empty set means announcements behave exactly as
        // they did before persistence existed, which is a usable fallback.
        return new Set();
    }
}

const creditedSeen = readCreditedSeen();

const creditedDepositsSeen = {
    has(id) {
        return creditedSeen.has(String(id));
    },
    add(id) {
        creditedSeen.add(String(id));
        // Most recent last, so trimming from the front drops the oldest.
        if (creditedSeen.size > CREDITED_SEEN_LIMIT) {
            for (const stale of creditedSeen) {
                if (creditedSeen.size <= CREDITED_SEEN_LIMIT) break;
                creditedSeen.delete(stale);
            }
        }
        try {
            window.sessionStorage.setItem(CREDITED_SEEN_KEY, JSON.stringify([...creditedSeen]));
        } catch {
            // Storage full or unavailable. The in-memory set still suppresses repeats for the
            // rest of this page's life, so a repeat after a reload is a tolerable outcome
            // versus an exception thrown out of a status poll.
        }
    }
};
/* ==========================================================================
   Toast notifications
   --------------------------------------------------------------------------
   Side-of-screen toasts for deposits, withdrawals, and account events. Desktop
   anchors top-right; mobile anchors bottom-center so a phone held in portrait
   keeps them under the thumb. Each toast is dismissible and announced to
   screen readers as a polite live region.
   ========================================================================== */

const toastRegion = document.getElementById('toast-region');
let toastCount = 0;

const TOAST_ICONS = {
    success: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2"/><path d="M8 5v3M8 11.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2l6 11H2L8 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 7v3M8 12.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
};

const NOTIFICATION_CATEGORY_ICONS = {
    deposit: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M14 10h2v6H2v-6h2M6 2h4v4H6zM6 2l-4 4M10 2l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    withdrawal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 7l5 5 5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 12V2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    reward: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    survey: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4h8v8H4zM9 2h2v4h-2zM5 9h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    magic: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v4l2 2 2-2V2h-4zM6 14h6V6H6v8zM6 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/**
 * The most toasts on screen at once.
 *
 * Three, because that is what fits between the header and the fold on a laptop without
 * covering the content, and because the app can fire several at once on one action -- a
 * completion pushes a success, a balance update, and a history entry. Uncapped, a slow
 * connection turned that into a column of cards down the right-hand side of the page with
 * the newest at the bottom, below the fold, so the message that mattered was the one the
 * user could not see.
 */
const MAX_VISIBLE_TOASTS = 3;

/**
 * A brief notice, anchored top-right on desktop and above the action bar on a phone.
 *
 * Three behaviours here that are not obvious from the call sites:
 *
 * - An error stays until it is dismissed. Every toast had a 4.5 second life, including the
 *   ones saying a deposit failed or a withdrawal was refused. A message about money that
 *   disappears before it is read is not a message, and the user's response to it -- the
 *   thing they were supposed to do next -- was gone with it.
 * - Hovering or focusing the toast stops the countdown. A toast that removes itself while
 *   the pointer is on it, or while a screen reader is inside it, is WCAG 2.2.1 timing that
 *   cannot be adjusted -- and the fix is to pause rather than to extend, which also means
 *   the remaining time is still there when the pointer leaves.
 * - The oldest is dropped when there are more than `MAX_VISIBLE_TOASTS`. Dropped, not
 *   queued: a queued toast fires minutes later about something that has been resolved.
 */
function showToast(title, message, { tone = 'info', duration = 4500 } = {}) {
    if (!toastRegion) return;
    const id = ++toastCount;
    const persistent = tone === 'error';
    const toast = document.createElement('div');
    toast.className = `toast is-${tone}`;
    toast.dataset.id = id;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    // The animation reads this custom property, and so does the pause below -- which is why
    // the duration has to live on the element rather than only in the timeout.
    toast.style.setProperty('--toast-duration', `${duration / 1000}s`);
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${TOAST_ICONS[tone] || TOAST_ICONS.info}</span>
        <div class="toast-body">
            <div class="toast-title">${escapeHtml(title)}</div>
            ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
        </div>
        <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
    `;
    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(id));

    toastRegion.appendChild(toast);

    // Trimmed after appending, so the count includes the one just shown and the toast that
    // goes is always the oldest rather than the newest.
    const visible = [...toastRegion.querySelectorAll('.toast:not(.is-leaving)')];
    for (const stale of visible.slice(0, Math.max(0, visible.length - MAX_VISIBLE_TOASTS))) {
        dismissToast(Number(stale.dataset.id));
    }

    if (persistent) {
        // No timeout. The close button is the only way out, which is the point.
        return id;
    }

    let remaining = duration;
    let elapsed = 0;
    let startedAt = Date.now();
    let timer = null;

    const stopCountdown = () => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        elapsed += Date.now() - startedAt;
    };
    const startCountdown = () => {
        if (timer !== null || remaining <= 0) return;
        startedAt = Date.now();
        timer = setTimeout(() => {
            timer = null;
            dismissToast(id);
        }, remaining);
    };

    for (const event of ['mouseenter', 'focusin']) toast.addEventListener(event, stopCountdown);
    for (const event of ['mouseleave', 'focusout']) toast.addEventListener(event, startCountdown);

    // The visible bar is driven by the same remaining time as the timeout, so the bar does
    // not keep draining while the toast is being read.
    const syncBar = () => {
        const left = Math.max(0, remaining - (timer === null ? 0 : Date.now() - startedAt));
        toast.style.setProperty('--toast-progress', `${Math.max(0, left / duration)}`);
    };
    const barTimer = setInterval(syncBar, 100);

    startCountdown();
    // Cleared when the toast goes, whether by its own timeout or by being dismissed early.
    const originalRemove = toast.remove.bind(toast);
    toast.remove = () => {
        clearInterval(barTimer);
        stopCountdown();
        originalRemove();
    };

    return id;
}

function dismissToast(id) {
    const toast = toastRegion.querySelector(`.toast[data-id="${id}"]`);
    if (!toast) return;
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
}

/* ==========================================================================
   Notification dropdown
   --------------------------------------------------------------------------
   A header bell that drops down a panel of recent notifications, mirroring the
   toasts but keeping a dismissible history. Unread count is persisted in
   `localStorage` so the badge survives a reload.
   ========================================================================== */

const NOTIFICATIONS_KEY = 'offerNetworkNotifications';
const NOTIFICATIONS_LIMIT = 50;
/** Recently pushed titles, used to suppress duplicate notifications within a short window. */
const notificationDedupe = new Map();
const NOTIFICATION_DEDUPE_MS = 3000;

function loadNotifications() {
    try {
        const raw = window.localStorage.getItem(NOTIFICATIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveNotifications(list) {
    try {
        window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(list.slice(-NOTIFICATIONS_LIMIT)));
    } catch {
        // Storage full or unavailable. The in-memory version still works for this tab.
    }
}

let notificationStore = loadNotifications();

function unreadCount() {
    return notificationStore.filter((n) => !n.read).length;
}

function pushNotification({ title, message, tone = 'info', href = null, category = null }) {
    // Suppress duplicates that arrive within a short window. Two calls with the same
    // title in quick succession usually mean the same event was pushed twice (a race
    // between the immediate form-submit notification and the first poll), not two
    // genuinely different events.
    const dedupeKey = title;
    const now = Date.now();
    if (notificationDedupe.has(dedupeKey) && now - notificationDedupe.get(dedupeKey) < NOTIFICATION_DEDUPE_MS) {
        return;
    }
    notificationDedupe.set(dedupeKey, now);
    setTimeout(() => notificationDedupe.delete(dedupeKey), NOTIFICATION_DEDUPE_MS);

    notificationStore.push({
        id: Date.now() + Math.random(),
        title,
        message,
        tone,
        href,
        category,
        read: false,
        timestamp: Date.now()
    });
    saveNotifications(notificationStore);
    renderNotificationBell();
    if (notificationDropdown && !notificationDropdown.hidden) {
        renderNotificationList();
    }
}

function markNotificationRead(id) {
    notificationStore = notificationStore.map((n) =>
        n.id === id ? { ...n, read: true } : n
    );
    saveNotifications(notificationStore);
}

function markAllNotificationsRead() {
    notificationStore = notificationStore.map((n) => ({ ...n, read: true }));
    saveNotifications(notificationStore);
    renderNotificationList();
    renderNotificationBell();
}

function clearAllNotifications() {
    notificationStore = [];
    saveNotifications(notificationStore);
    if (notificationDropdown && !notificationDropdown.hidden) renderNotificationList();
    renderNotificationBell();
}

function dismissNotification(id) {
    notificationStore = notificationStore.filter((n) => n.id !== id);
    saveNotifications(notificationStore);
    if (notificationDropdown && !notificationDropdown.hidden) renderNotificationList();
    renderNotificationBell();
}

function renderNotificationBell() {
    const bell = document.getElementById('notification-bell');
    const count = document.getElementById('notification-count');
    if (!bell || !count) return;

    // The bell is a session control: it ships `hidden`, and `syncAccountControls` reveals it
    // once there is a session to show notifications for. This function runs after every change to
    // the store -- which is after `initNotifications`, which is after `syncAccountControls` -- and
    // it used to set `hidden = false` on both of its branches, so the last word belonged to it and
    // a signed-out visitor was given a bell over an empty list. On a page whose header shows the
    // bell that is a control with nothing behind it; on the pages with an action bar the header
    // copy is `display: none` on a phone but not on a desktop, so it showed there too.
    if (!getSessionToken()) {
        bell.hidden = true;
        count.hidden = true;
        return;
    }

    const countValue = unreadCount();
    if (countValue > 0) {
        bell.hidden = false;
        count.textContent = String(countValue > 99 ? '99+' : countValue);
        count.hidden = false;
    } else {
        bell.hidden = false;
        count.hidden = true;
    }

    // The action-bar bell carries its own badge element, and it was never written to. On a
    // phone the header bell is `display: none`, so this badge is the only unread count the
    // visitor could ever have seen -- and it stayed at its initial value of `0` and hidden.
    const mobileCount = document.getElementById('notification-count-mobile');
    if (mobileCount) {
        mobileCount.textContent = String(countValue > 99 ? '99+' : countValue);
        mobileCount.hidden = countValue === 0;
    }
}

function renderNotificationList() {
    const list = document.getElementById('notification-list');
    if (!list) return;

    const recent = [...notificationStore].reverse();
    if (recent.length === 0) {
        list.innerHTML = '<p class="notification-empty">No notifications yet.</p>';
        return;
    }

    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const item of recent) {
        const el = document.createElement('div');
        el.className = `notification-item is-${item.tone} ${item.read ? '' : 'unread'}`;
        const iconSvg = NOTIFICATION_CATEGORY_ICONS[item.category] || TOAST_ICONS[item.tone] || TOAST_ICONS.info;
        el.innerHTML = `
            <span class="notification-item-icon" aria-hidden="true">${iconSvg}</span>
            <div class="notification-item-content">
                <div class="notification-item-title">${escapeHtml(item.title)}</div>
                ${item.message ? `<div class="notification-item-message">${escapeHtml(item.message)}</div>` : ''}
                <div class="notification-item-time">${formatTimeAgo(item.timestamp)}</div>
            </div>
            <button type="button" class="notification-item-close" aria-label="Dismiss">&times;</button>
        `;

        const closeButton = el.querySelector('.notification-item-close');
        if (closeButton) closeButton.addEventListener('click', () => dismissNotification(item.id));
        el.addEventListener('click', (event) => {
            if (event.target.closest('.notification-item-close')) return;
            if (!item.read) markNotificationRead(item.id);
            if (item.href) window.location.assign(item.href);
        });
        fragment.appendChild(el);
    }
    list.appendChild(fragment);
}

function formatTimeAgo(ts) {
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 60) return 'now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
}

const notificationDropdown = document.getElementById('notification-dropdown');

/**
 * There are two bells for one dropdown: the header bell, and the action-bar bell that the
 * stylesheet swaps in on narrow screens (`#notification-bell` becomes `display: none` and
 * `#notification-bell-mobile` becomes `display: flex`).
 *
 * Only the header bell was ever wired. The action-bar bell kept the `hidden` attribute from
 * the markup, had no click handler, and had its badge element never written to -- so on a
 * phone the visitor had no notification bell at all, and no unread count. Because the
 * header bell is still in the DOM (merely not displayed), the shared code below kept working
 * and nothing errored: the dropdown could be toggled, just never by anyone on a phone.
 *
 * Both are collected into one list so every state change applies to whichever one is
 * actually visible.
 */
const notificationBells = [
    document.getElementById('notification-bell'),
    document.getElementById('notification-bell-mobile')
].filter(Boolean);

function toggleNotificationDropdown() {
    if (!notificationDropdown || notificationBells.length === 0) return;
    const isOpen = !notificationDropdown.hidden;
    notificationDropdown.hidden = isOpen;
    for (const bell of notificationBells) {
        bell.setAttribute('aria-expanded', String(!isOpen));
    }
    if (!isOpen) {
        renderNotificationList();
        markAllNotificationsRead();
    }
}

function closeNotificationDropdown() {
    if (!notificationDropdown || notificationBells.length === 0) return;
    notificationDropdown.hidden = true;
    for (const bell of notificationBells) {
        bell.setAttribute('aria-expanded', 'false');
    }
}

function initNotifications() {
    renderNotificationBell();
    for (const bell of notificationBells) {
        bell.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleNotificationDropdown();
        });
    }

    document.addEventListener('click', (event) => {
        if (!notificationDropdown || notificationDropdown.hidden) return;
        if (notificationDropdown.contains(event.target)) return;
        // A click on either bell is the toggle's own click, already stopped above. Without
        // this the outside-click handler would immediately close the dropdown the bell had
        // just opened, which reads as a bell that does nothing.
        if (notificationBells.some((bell) => bell === event.target || bell.contains(event.target))) return;
        closeNotificationDropdown();
    });

    document.getElementById('notification-mark-all')?.addEventListener('click', (event) => {
        event.stopPropagation();
        markAllNotificationsRead();
    });

    document.getElementById('notification-clear-all')?.addEventListener('click', (event) => {
        event.stopPropagation();
        clearAllNotifications();
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Convenience wrappers matching the events that need them.
function notifyDepositConfirmed(item) {
    const title = 'Deposit credited';
    const message = `${formatBalance(item.amount)} ${item.currency_code || 'USD'} added to your balance.`;
    showToast(title, message, { tone: 'success' });
    pushNotification({ title, message, tone: 'success', category: 'deposit' });
}

function notifyWithdrawalSubmitted(item) {
    const title = 'Withdrawal submitted';
    const message = `Your request to withdraw ${formatBalance(item.amount)} is being processed.`;
    showToast(title, message, { tone: 'info' });
    pushNotification({ title, message, tone: 'info', category: 'withdrawal' });
}

function notifyWithdrawalPaid(item) {
    const title = 'Withdrawal sent';
    const message = `${formatBalance(item.amount)} has been sent to your payment method.`;
    showToast(title, message, { tone: 'success' });
    pushNotification({ title, message, tone: 'success', category: 'withdrawal' });
}

function notifyWithdrawalFailed(item) {
    const title = 'Withdrawal failed';
    const message = item.failureReason || 'Your withdrawal could not be completed.';
    showToast(title, message, { tone: 'error' });
    pushNotification({ title, message, tone: 'error', category: 'withdrawal' });
}

function notifySessionExpired() {
    const title = 'Session expired';
    const message = 'Sign in again to continue.';
    showToast(title, message, { tone: 'warning' });
    pushNotification({ title, message, tone: 'warning' });
}

/**
 * Withdrawal states already seen, so a transition can be announced once.
 *
 * Like `creditedDepositsSeen` but keyed on the status a withdrawal has reached,
 * because the events that matter here are transitions into a terminal state --
 * paid, failed -- not the fact that a row exists. A withdrawal that was already
 * paid when the page loaded must not fire "your money has been sent" on every
 * poll.
 */
const WITHDRAWAL_SEEN_KEY = 'offerNetworkWithdrawalStatesSeen';
const WITHDRAWAL_SEEN_LIMIT = 100;

/** Session storage throws rather than returning null when it is disabled or full. */
function readWithdrawalStatesSeen() {
    try {
        const raw = window.sessionStorage.getItem(WITHDRAWAL_SEEN_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
        return new Set();
    }
}

const withdrawalStatesSeen = readWithdrawalStatesSeen();

function persistWithdrawalStatesSeen() {
    try {
        const arr = [...withdrawalStatesSeen];
        if (arr.length > WITHDRAWAL_SEEN_LIMIT) {
            arr.splice(0, arr.length - WITHDRAWAL_SEEN_LIMIT);
        }
        window.sessionStorage.setItem(WITHDRAWAL_SEEN_KEY, JSON.stringify(arr));
    } catch {
        // Storage full or unavailable. In-memory set still suppresses repeats for the
        // rest of this page's life, so a repeat after a reload is a tolerable outcome
        // versus an exception thrown out of a status poll.
    }
}

function markWithdrawalSeen(id, status) {
    const key = `${id}:${status}`;
    if (withdrawalStatesSeen.has(key)) return;
    withdrawalStatesSeen.add(key);
    persistWithdrawalStatesSeen();
}

function withdrawalStateSeen(id, status) {
    return withdrawalStatesSeen.has(`${id}:${status}`);
}
// `codeFor` is the amount/coin/destination a confirmation code was issued for, or null. It
// exists so an edit after the code arrived is caught in the form instead of at the server.
const withdrawState = { options: null, method: 'paypal', asset: '', network: '', codeFor: null };
const accountState = { balance: NaN };
/**
 * Whether this user wants deposit and withdrawal email, and whether we have actually asked.
 *
 * `loaded` is separate from `enabled` because the switch is rendered before the session is
 * known. A page that painted "off" while loading would be claiming the user had switched
 * their receipts off, and a page that painted "on" would be claiming a setting it had not
 * read -- which for a user who genuinely did switch it off is the more annoying of the two,
 * because the switch would jump under their cursor.
 */
const emailPrefState = { enabled: true, loaded: false, saving: false };

/**
 * The display name and profile picture, and whether the form is showing unsaved edits.
 *
 * `saved` is kept alongside the working values because the save button is enabled by
 * "has something changed", and answering that question from the values alone means
 * re-deriving the server's normalisation on every keystroke. Holding what the server last
 * confirmed is the only way to know the difference between "the user typed something" and
 * "the user typed something different from what is stored".
 *
 * `avatarData` holds a data URL rather than a `File`. The file is read and drawn onto a
 * canvas immediately, so the object URL is never retained: a blob URL left alive keeps the
 * whole picked file in memory for the life of the page, and the downscaled result is a few
 * kilobytes. The size that actually gets submitted is produced here, which is why it fits
 * the server's 16 KB cap and the request body's 32 KB one without the user being told to
 * resize anything themselves.
 */
const profileState = {
    displayName: '',
    avatarData: null,
    // Read from the server alongside everything else rather than from `sessionStorage`. The
    // stored copy is a claim made at sign-in time: it survives a password change that should
    // have changed the account, and on a shared device it belongs to whoever used the tab
    // last. The header and the account menu both name the person, so both need a value that
    // is a fact about the present.
    email: '',
    // The numeric account id, used only for the support reference. It identifies the
    // account to a human and grants nothing, which is why it is safe to put on the clipboard.
    accountId: null,
    saved: { displayName: '', avatarData: null },
    loaded: false,
    saving: false,
    dirty: false
};

/**
 * The pixel size the picked picture is drawn at before it is sent.
 *
 * 128 is chosen against the largest place the avatar is rendered -- a 64 px preview in the
 * settings card -- with headroom for a high-density display, at which point a 128 px source
 * is still 2x. Beyond that the extra pixels are invisible while every one of them is bytes
 * in a JSON body and a row in the database.
 */
const PROFILE_AVATAR_SIZE = 128;

/**
 * The largest source file a person may pick, in bytes. 10 MB.
 *
 * This is deliberately far larger than what is stored, and the two numbers answer different
 * questions. The source limit is about what people actually have: a modern phone photo from a
 * 12 MP camera is routinely 4-6 MB as a HEIC or a high-quality JPEG, and a screenshot or a
 * scan can pass 10 MB. Capping the *picked file* at 16 KB, which is what the stored size is
 * capped at, rejected essentially every real photograph -- the user got "that file is too
 * large" for a picture that was never too large for anything, only too large after we had
 * already shrunk it for them.
 *
 * The stored cap stays small and that is the one that matters. By the time anything is sent,
 * the image has been centre-cropped to PROFILE_AVATAR_SIZE and re-encoded as PNG, which is a
 * few kilobytes regardless of what went in. So the upload is a few KB, the request body limit
 * of 32 KB still holds, and the database row stays small. A 10 MB input costs one local decode
 * and nothing downstream.
 *
 * The check is here rather than on the input's `accept` attribute or the server because
 * neither can catch it at the right moment. `accept` is a filter hint the browser is free to
 * ignore, and the server would have to buffer 10 MB to produce a message about a file the
 * browser could have described without reading a byte of it.
 */
const PROFILE_AVATAR_MAX_SOURCE_BYTES = 10 * 1024 * 1024;


/**
 * The deposit the instructions panel is currently showing, and its status line.
 *
 * Held as state rather than looked up on demand so the live sync can tell "this deposit
 * confirmed" from "some other deposit on the account confirmed" -- the user only cares
 * about the one in front of them.
 */
let activeDeposit = null;

/** The most recent deposit rows the live sync received, reused by the status line. */
let lastKnownDeposits = [];

const cryptoCurrencyNames = {
    ada: 'Cardano (ADA)', avax: 'Avalanche (AVAX)', bch: 'Bitcoin Cash (BCH)',
    bnb: 'BNB (BNB)', btc: 'Bitcoin (BTC)', doge: 'Dogecoin (DOGE)',
    dot: 'Polkadot (DOT)', eth: 'Ethereum (ETH)', ltc: 'Litecoin (LTC)',
    matic: 'Polygon (POL)', sol: 'Solana (SOL)', ton: 'Toncoin (TON)',
    trx: 'TRON (TRX)', usdc: 'USD Coin (USDC)', usdt: 'Tether (USDT)',
    xrp: 'XRP (XRP)'
};

const statusLabels = {
    pending: 'Pending', confirming: 'Confirming', confirmed: 'Confirmed',
    paid: 'Paid', failed: 'Failed', expired: 'Expired',
    cancelled: 'Cancelled', processing: 'Processing'
};

/**
 * True while a magic link is being exchanged for a session.
 *
 * The link is the sign-in, so the sign-in form must not be put in front of it: a dialog
 * opening over a page that is about to become a signed-in session asks the person to do
 * something they have already done by clicking the link in their email.
 */
let magicLinkPending = false;

/**
 * Everything below this line is page wiring, and none of it runs for a visitor the gate
 * refused.
 *
 * `session-gate.js` is loaded before this file, so by the time this statement executes the
 * decision has already been made and the redirect is in flight. Registering the listener
 * anyway would mean the offers catalog, the balance poll, and the notification badge all
 * start behind a page the visitor is already leaving -- a burst of requests that come back
 * 401 and each raise a "session expired" toast on the way out. The API is still the
 * authority; this only avoids doing work for someone who cannot use the results.
 */
const mayUseThisPage = window.RewardZoneSession ? window.RewardZoneSession.enforce() : true;

// The sign-in page has no page content behind it, so there is nothing to hide and no dialog
// to dismiss. This only covers the Back button: history can hold a gated page from before
// the session existed, and walking back onto one would put the visitor on a private page
// without a session.
if (window.RewardZoneSession) window.RewardZoneSession.watchForPrivateHistory();

if (mayUseThisPage) document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('account-button')?.addEventListener('click', handleAccountButton);

    // The money pair lives in the account page's balance card, which is the page you come to in
    // order to move money -- it is the only money control on screen there. The offers page has
    // none in its card on purpose: the header's account menu carries "Add funds" and "Withdraw"
    // on every page, and that page's narrow action bar mirrors them. The home page has no card
    // and no bar, so the menu is its only path, which is why the menu keeps them.
    //
    // All of them are optional, because each page carries only the ones it owns, and all of
    // them ship `disabled` in the markup: a listener is not optional for them, or
    // `syncAccountControls()` would enable a control that looks live and does nothing.
    document.getElementById('account-deposit-btn')?.addEventListener('click', openDeposits);
    document.getElementById('account-withdraw-btn')?.addEventListener('click', openWithdrawal);
    document.getElementById('account-password-btn')?.addEventListener('click', openPasswordReset);
    // The menu's own items. Each closes the menu first, so the panel is never left hanging
    // over whatever the item just opened.
    document.getElementById('account-menu-deposit')?.addEventListener('click', () => {
        closeAccountMenu();
        openDeposits();
    });
    document.getElementById('account-menu-withdraw')?.addEventListener('click', () => {
        closeAccountMenu();
        openWithdrawal();
    });
    document.getElementById('account-menu-signout')?.addEventListener('click', () => {
        closeAccountMenu();
        signOut({ leave: true });
    });
    // The two in-page links scroll rather than navigate, so closing the menu has to wait for
    // the scroll to start or the anchor jump is cancelled by the panel being removed.
    for (const id of ['account-menu-profile', 'account-menu-history']) {
        document.getElementById(id)?.addEventListener('click', () => {
            setTimeout(closeAccountMenu, 0);
        });
    }
    document.getElementById('account-export-btn')?.addEventListener('click', exportTransactions);
    document.getElementById('account-copy-ref-btn')?.addEventListener('click', copyAccountReference);
    document.getElementById('account-revoke-sessions-btn')?.addEventListener('click', revokeAllSessions);
    document.getElementById('profile-save')?.addEventListener('click', saveProfile);
    document.getElementById('profile-display-name')?.addEventListener('input', (event) => {
        profileState.displayName = event.target.value;
        updateProfileDirty();
    });
    document.getElementById('profile-avatar-input')?.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        // Reset immediately, so picking the same file twice in a row fires `change` again.
        // Without this the second pick of an already-selected file is silently ignored,
        // which reads to the user as the picker being broken.
        event.target.value = '';
        if (!file) return;
        try {
            profileState.avatarData = await readPickedAvatar(file);
            updateProfileDirty();
        } catch (error) {
            const status = document.getElementById('profile-status');
            if (status) {
                status.textContent = error.message || 'That file could not be used.';
                status.classList.add('is-error');
            }
        }
    });
    document.getElementById('profile-avatar-remove')?.addEventListener('click', () => {
        // Clears the working value only. The stored one is replaced when Save is pressed,
        // so a mis-click is not destructive -- the same contract as the name field.
        profileState.avatarData = null;
        updateProfileDirty();
    });
    document.getElementById('money-emails-toggle')?.addEventListener('change', (event) => {
        saveEmailPreference(event.target.checked);
    });
    document.getElementById('account-form')?.addEventListener('submit', connectAccount);
    document.getElementById('withdraw-form')?.addEventListener('submit', submitWithdrawal);
    document.getElementById('withdraw-code-send')?.addEventListener('click', sendWithdrawalCode);
    document.getElementById('withdraw-code-resend')?.addEventListener('click', sendWithdrawalCode);
    document.getElementById('withdraw-code')?.addEventListener('input', (event) => {
        // Digits only, capped at six. A pasted "123 456" or an autocorrected one is the
        // difference between a code that works and one of five attempts spent.
        event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
    });
    document.getElementById('deposit-form')?.addEventListener('submit', createDeposit);

    document.querySelectorAll('[data-deposit-method]').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.disabled) return;
            depositState.method = button.dataset.depositMethod;
            updateDepositFields();
        });
    });
    document.querySelectorAll('[data-deposit-amount]').forEach((button) => {
        button.addEventListener('click', () => {
            const amount = document.getElementById('deposit-amount');
            if (!amount) return;
            amount.value = button.dataset.depositAmount;
            syncDepositPresets();
            amount.focus();
        });
    });
    document.getElementById('deposit-amount')?.addEventListener('input', () => {
        syncDepositPresets();
        // Re-checked on every keystroke so the "provider will refuse this" state appears and
        // clears as the amount crosses the floor, rather than only after a failed submit.
        validateDepositAmount();
    });
    document.getElementById('deposit-max')?.addEventListener('click', setMaximumDepositAmount);
    document.getElementById('deposit-currency')?.addEventListener('change', () => {
        clearDepositMessage();
        // The provider's minimum and maximum are both per currency pair, so switching coins
        // can change the range that will be accepted. Leaving the previous coin's limits in
        // place either blocks a valid amount or lets an invalid one through to the server.
        const amount = document.getElementById('deposit-amount');
        if (!amount) return;
        amount.min = String(minimumForSelectedCurrency());
        amount.max = String(maximumForSelectedCurrency());
        // The bounds alone are not enough: the value already typed may now be outside them.
        clampDepositAmountToRange();
        updateDepositAmountHint();
        updateCoinSummary();
        syncDepositPresets();
    });

    document.getElementById('withdraw-asset-options')?.addEventListener('change', (event) => {
        if (event.target.name === 'withdrawAsset') {
            withdrawState.asset = event.target.value;
            withdrawState.network = '';
            renderNetworkChoices();
            updateWithdrawFields();
        }
    });
    document.getElementById('withdraw-network')?.addEventListener('change', (event) => {
        withdrawState.network = event.target.value;
        updateWithdrawFields();
    });
    document.getElementById('withdraw-amount')?.addEventListener('input', updateWithdrawSummary);
    document.getElementById('withdraw-address')?.addEventListener('input', updateWithdrawSummary);
    document.getElementById('withdraw-max')?.addEventListener('click', () => {
        // "Withdraw all" means the whole balance, but only up to the provider's own cap:
        // offering $5,000 to someone holding $40,000 produces a request that is refused.
        const options = withdrawState.options;
        const balance = accountState.balance;
        if (!Number.isFinite(balance)) return;
        const ceiling = Number.isFinite(options?.maximumUsd) ? Math.min(balance, options.maximumUsd) : balance;
        const amount = document.getElementById('withdraw-amount');
        if (!amount) return;
        amount.value = ceiling.toFixed(2);
        updateWithdrawSummary();
        amount.focus();
    });
    document.getElementById('withdraw-address')?.addEventListener('input', clearWithdrawMessage);

    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
        button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
    });
    document.getElementById('forgot-password-link')?.addEventListener('click', () => {
        setFormMessage('account-message', '');
        setAuthMode('forgot');
    });

    // Email confirmation. The code box submits on Enter, so the flow is one keypress from
    // pasting the six digits rather than a hunt for the button.
    document.getElementById('verify-submit')?.addEventListener('click', submitVerification);
    document.getElementById('verify-resend')?.addEventListener('click', resendVerificationCode);
    document.getElementById('verify-code')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitVerification();
        }
    });
    document.getElementById('verify-code')?.addEventListener('input', (event) => {
        // Digits only, even if the code was pasted with a space or a hyphen in it. The field
        // is `maxlength=6`, so stripping rather than truncating is what makes a pasted
        // "123 456" work instead of silently becoming "123 45".
        const cleaned = event.target.value.replace(/\D/g, '').slice(0, 6);
        if (cleaned !== event.target.value) event.target.value = cleaned;
    });
    document.getElementById('verify-back')?.addEventListener('click', () => {
        hideVerifyStep();
        setAuthMode('login');
        document.getElementById('account-email')?.focus();
    });
    document.getElementById('verify-magic-link')?.addEventListener('click', sendMagicLink);

    // Magic link returned from the email: read the token from the URL fragment
    // and exchange it for a session silently.
    checkMagicLinkReturn();

    // The sign-in page needs nothing here: the form is the page, and focusing the email
    // field is the useful default. A magic link is the exception -- it signs in on its own,
    // and focusing a password box over the top of it asks someone who is already signed in
    // to sign in again.
    if (!getSessionToken() && !magicLinkPending) {
        if (window.RewardZoneSession?.isLoginPath()) {
            setAuthMode('login');
            document.getElementById('account-email')?.focus();
        } else {
            // The dialog on a page that is legitimately reachable signed out -- the header's
            // "Connect account" button.
            const accountDialog = document.getElementById('account-dialog');
            if (accountDialog && !accountDialog.open) {
                setFormMessage('account-message', '');
                setAuthMode('login');
                accountDialog.showModal();
            }
        }
    }

    document.getElementById('offer-search')?.addEventListener('input', (event) => {
        offerState.search = event.target.value.trim().toLowerCase();
        renderOffers();
    });
    document.getElementById('offer-sort')?.addEventListener('change', (event) => {
        offerState.sort = event.target.value;
        renderOffers();
    });
    // The type chips are a filter rather than a select because they are the one control
    // whose current value has to stay visible while scrolling a long list. `aria-pressed`
    // carries the state instead of a class alone, so the filter is announced as well as
    // drawn -- and a chip group is not a tablist, because it filters one list rather than
    // swapping between panels.
    document.querySelectorAll('[data-offer-type]').forEach((button) => {
        button.addEventListener('click', () => {
            offerState.type = button.dataset.offerType;
            document.querySelectorAll('[data-offer-type]').forEach((other) => {
                other.setAttribute('aria-pressed', String(other === button));
            });
            renderOffers();
        });
    });
    // The narrow-screen action bar duplicates some of the header controls, because the header
    // has to stay one row on a phone and the primary actions belong under the thumb. Each bar
    // button forwards to its header counterpart, so the behaviour, the disabled state, and the
    // sign-in label all have exactly one implementation.
    //
    // This was registered inside the sign-in handler rather than here, which meant the
    // buttons in the bottom bar did nothing at all until the visitor had signed in
    // once -- and then registered a fresh listener on every subsequent sign-in. It is
    // page-level wiring: it runs once, and the per-button state is `syncAccountControls`'s
    // job, which is already called on load, on sign-in, and on sign-out.
    //
    // The Account item that used to be here is gone. It mirrored `account-button`, which is
    // `display: none` while signed in, and a hidden button still fires its handler on
    // `.click()` -- so the item could sign the user out with nothing on screen saying that is
    // what it does. The profile button and its menu are in the header on every width and
    // already carry identity, transactions, money and sign out, so nothing was lost with it.
    document.querySelectorAll('[data-mirror]').forEach((barButton) => {
        const target = document.getElementById(barButton.dataset.mirror);
        if (!target) return;
        barButton.addEventListener('click', () => target.click());
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => {
            const dialog = document.getElementById(button.dataset.close);
            if (dialog) dialog.close();
        });
    });

    // Any dialog dismisses on a backdrop click or Escape. Native <dialog> handles
    // Escape, but a click outside the panel does not close it by default.
    document.querySelectorAll('dialog').forEach((dialog) => {
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });
    });

    document.getElementById('withdraw-dialog')?.addEventListener('close', () => {
        setFormMessage('withdraw-message', '');
    });

    document.getElementById('deposit-success-close')?.addEventListener('click', () => {
        document.getElementById('deposit-success-dialog')?.close();
    });

    syncAccountControls();
    initAccountMenu();
    syncDepositPresets();
    updateDepositFields();
    updateWithdrawFields();
    refreshBalance();
    initNotifications();
    openMoneyActionFromHash();
    // The notice is shown once the catalog has finished loading, not before. `loadOffers`
    // owns `page-message` for the duration of its request -- it clears the box on the way
    // in and writes an error into it on the way out -- so setting a notice beforehand would
    // be wiped by the next line, and setting it unconditionally afterwards would hide a
    // catalog failure behind a less important message. On success the notice replaces
    // nothing; on failure the real error stays.
    loadOffers().then((loaded) => {
        if (loaded) showPageNotice();
    });
    // The page keeps itself current from here on. Seeded with the deposits that are already
    // credited so the first sync does not re-announce a payment that happened before the
    // page loaded, then started: the initial history read is what tells us which those are.
    if (getSessionToken()) {
        loadDepositHistory().finally(() => {
            startLiveSync();
            paintLiveIndicator();
        });
        loadEmailPreference();
        loadProfile();
    } else {
        startLiveSync();
        paintLiveIndicator();
        renderEmailPreference();
        renderProfileEditor();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        // Coming back to the tab is the moment a stale page is most visible, so it syncs
        // immediately instead of waiting out whatever remained of the interval.
        paintLiveIndicator();
        syncNow();
    });

    // A session that goes away should stop the loop rather than keep failing against an
    // endpoint with a dead token until the tab is closed.
    window.addEventListener('pagehide', stopLiveSync);
});

function startLiveSync() {
    window.clearTimeout(liveState.timer);
    liveState.timer = undefined;
    liveState.consecutiveFailures = 0;
    if (!getSessionToken()) {
        paintLiveIndicator();
        return;
    }
    syncNow();
}

function stopLiveSync() {
    window.clearTimeout(liveState.timer);
    liveState.timer = undefined;
}

/* ---------------------------------------------------------------- live sync */

/**
 * Keeping the page current without a reload.
 *
 * The page used to poll only while the deposit dialog was open, plus a single check on
 * load and on tab focus. So a payment that confirmed two minutes after the dialog was
 * closed was never seen: the balance on the header was a number that changed at some point
 * in the past, and the only way to find out was to refresh. That is the difference between
 * "my money arrived" being an event and being a number.
 *
 * Server-Sent Events would be the obvious way to do this properly, and it is deliberately
 * not used. This deploys to Vercel, where a request is a billed function invocation with a
 * wall-clock ceiling: an SSE stream is one invocation held open for as long as the client
 * listens, and every one of them occupies a slot against the concurrency limit for the
 * whole time. A poll that answers 304 in a few dozen bytes and then waits is far cheaper and
 * behaves identically for this use, where the state that changes is "a payment confirmed"
 * -- an event that happens on the order of minutes, not milliseconds.
 *
 * The interval adapts rather than being fixed. While a deposit is outstanding the user is
 * waiting on it, so it is asked every few seconds. When nothing is outstanding the page has
 * nothing to announce, so it settles into a slower beat, and it stops entirely while the tab
 * is hidden -- a background tab is the single biggest waste available here, and browsers
 * already throttle timers in it, so the explicit check keeps the behaviour predictable.
 * Coming back to the tab syncs immediately rather than waiting out the remaining interval.
 */
const liveState = {
    timer: undefined,
    version: '',
    /** Set while a request is in flight, so two syncs cannot overlap. */
    busy: false,
    /** A deposit the user is waiting on, which is what justifies a fast interval. */
    awaitingDeposit: false,
    lastSyncedAt: 0,
    consecutiveFailures: 0,
    /**
     * Balance the live sync last saw, so a reward that arrives between polls can be
     * detected: the balance simply goes up, with no deposit row to explain it.
     */
    lastKnownBalance: NaN,
    lastKnownDemoBalance: NaN,
    /** Sum of deposit credits seen in the current update, so the balance delta can be
     *  split between "money arrived" and "reward was credited". */
    creditedDepositTotal: 0,
    /** Sum of withdrawal refunds seen in the current update, so a returned withdrawal
     * is not double-counted as a reward. */
    refundedWithdrawalTotal: 0
};

/** How long to wait before the next check, given whether something is outstanding. */
function liveIntervalMs() {
    if (liveState.awaitingDeposit) return 5000;
    if (liveState.consecutiveFailures > 0) {
        // Back off when the server is unhappy. Retrying a failing endpoint at the normal
        // rate turns a database blip into a burst of failing requests that keep it blipped.
        return Math.min(120000, 10000 * 2 ** Math.min(4, liveState.consecutiveFailures - 1));
    }
    return 20000;
}

function scheduleLiveSync() {
    window.clearTimeout(liveState.timer);
    liveState.timer = window.setTimeout(() => { syncNow(); }, liveIntervalMs());
}

/**
 * Polls once and applies anything that changed.
 *
 * Returns true when the server reported a change, so a caller that wants to know whether
 * it is worth continuing (a form, a confirmation) can branch on it.
 */
async function syncNow() {
    const token = getSessionToken();
    if (!token || liveState.busy) return false;
    if (document.hidden) {
        // Nothing is rendered while hidden, so there is no reason to spend the request.
        // Coming back triggers an immediate sync through the visibilitychange handler.
        scheduleLiveSync();
        return false;
    }
    liveState.busy = true;
    try {
        const response = await fetch(`/api/user/updates${liveState.version ? `?version=${encodeURIComponent(liveState.version)}` : ''}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store'
        });
        if (response.status === 304) {
            // The common case, and the reason this endpoint exists: nothing moved.
            liveState.consecutiveFailures = 0;
            liveState.lastSyncedAt = Date.now();
            paintLiveIndicator();
            return false;
        }
        if (!response.ok) {
            const error = new Error(`Sync failed (${response.status})`);
            error.status = response.status;
            if (handleUnauthorized(error)) {
                // The session is gone: stop the live-sync loop, there is nothing left to poll.
                stopLiveSync();
                return false;
            }
            throw error;
        }

        const payload = await response.json();
        liveState.version = payload.version;
        liveState.consecutiveFailures = 0;
        liveState.lastSyncedAt = Date.now();
        applyLiveUpdate(payload);
        paintLiveIndicator();
        return true;
    } catch (error) {
        liveState.consecutiveFailures += 1;
        paintLiveIndicator();
        return false;
    } finally {
        liveState.busy = false;
        scheduleLiveSync();
    }
}

/**
 * Applies a change the server reported.
 *
 * Every step is conditional on the data having actually changed, so a sync that arrives
 * while the user is typing in the amount field cannot move the cursor, re-render a list
 * under the pointer, or replace a message they are reading.
 */
function applyLiveUpdate(payload) {
    const hadBalance = Number.isFinite(liveState.lastKnownBalance);
    const hadDemo = Number.isFinite(liveState.lastKnownDemoBalance);

    // Reset the per-update accumulators so they only reflect this poll.
    liveState.creditedDepositTotal = 0;
    liveState.refundedWithdrawalTotal = 0;

    if (typeof payload.balance === 'string' || payload.balance === null) {
        const nextBalanceNum = payload.balance === null ? 0 : Number(payload.balance);
        const nextDemoNum = payload.demoBalance === null || payload.demoBalance === undefined
            ? 0
            : Number(payload.demoBalance);
        const balanceChanged = nextBalanceNum !== accountState.balance;
        const demoChanged = typeof payload.demoBalance === 'string' &&
            nextDemoNum !== liveState.lastKnownDemoBalance;
        if (balanceChanged || demoChanged) {
            // `applyBalance` is the one place that writes the header and keeps the withdrawal
            // ceiling in step, so the live path routes through it rather than repeating it. A
            // live update that painted the header but left the withdrawal form capped at the
            // old balance would let someone request more than they have.
            //
            // `balance` can be `null` when the user has only demo funds -- the header still
            // needs to repaint, so `null` is coerced to `0` for display but is not treated as a
            // reward transition.
            applyBalance(payload.balance ?? '0', payload.demoBalance ?? '0');
            if (isDialogOpen('withdraw-dialog')) {
                updateWithdrawFields();
                updateWithdrawAmountHint();
            }
        }
    }

    const deposits = Array.isArray(payload.deposits) ? payload.deposits : [];
    const withdrawals = Array.isArray(payload.withdrawals) ? payload.withdrawals : [];
    // Kept so the deposit panel can read the status of the deposit it is showing without
    // issuing its own request for it.
    lastKnownDeposits = deposits;

    // Whether a payment is still outstanding decides how fast the next check is, and it is
    // also what the "waiting for payment" hint in the deposit panel reads from.
    liveState.awaitingDeposit = deposits.some((item) => {
        const status = String(item.status || '').toLowerCase();
        return status !== 'confirmed' && status !== 'failed' && status !== 'expired';
    });

    if (isDialogOpen('deposit-dialog')) {
        renderHistoryInto('deposit-history', deposits, 'deposit', 'No deposits yet.');
        paintDepositStatus();
    }
    if (isDialogOpen('withdraw-dialog')) {
        renderHistoryInto('withdrawal-history', withdrawals, 'withdrawal', 'No withdrawals yet.');
    }

    // A credit that happened with no dialog open is announced rather than silently
    // redrawing a number, because the balance going up is the thing a user is waiting for
    // and they should not have to be watching the header to notice it.
    for (const item of deposits) {
        const status = String(item.status || '').toLowerCase();
        const credited = status === 'confirmed' || status === 'paid';
        if (credited && !creditedDepositsSeen.has(item.id)) {
            creditedDepositsSeen.add(item.id);
            liveState.creditedDepositTotal += Number(item.amount) || 0;
            // Announce the credit everywhere: when the dialog is open the user sees the
            // success screen, otherwise they get just the toast and bell so the money
            // arriving is an event, not a number they have to be watching for.
            if (isDialogOpen('deposit-dialog')) {
                showDepositSuccess(item);
            } else {
                notifyDepositConfirmed(item);
            }
        }
    }

    // A withdrawal reaching a terminal state is announced the same way, and for the same
    // reason: the user is elsewhere on the page and should not have to poll their history
    // to learn their money left or was returned. Only the transitions into paid and failed
    // are announced -- a request sitting in `pending` is not an event, and saying so on
    // every poll would be noise.
    for (const item of withdrawals) {
        const status = String(item.status || '').toLowerCase();
        if (status === 'paid' && !withdrawalStateSeen(item.id, 'paid')) {
            markWithdrawalSeen(item.id, 'paid');
            notifyWithdrawalPaid(item);
        } else if (status === 'failed' && !withdrawalStateSeen(item.id, 'failed')) {
            markWithdrawalSeen(item.id, 'failed');
            liveState.refundedWithdrawalTotal += Number(item.amount) || 0;
            notifyWithdrawalFailed(item);
        }
    }

    // A reward from a completed offer or survey arrives as a plain balance increase with
    // no deposit or withdrawal row to explain it. Detect that by comparing the delta
    // against the credits and refunds already announced in this update.
    //
    // `balance` can be `null` (demo-only accounts), in which case the numeric value used
    // for the delta is 0 -- the important thing is that the demo balance delta below is
    // still evaluated.
    if (hadBalance && (typeof payload.balance === 'string' || payload.balance === null)) {
        const prevBalance = liveState.lastKnownBalance;
        const newBalance = payload.balance === null ? 0 : Number(payload.balance);
        const delta = newBalance - prevBalance;
        const accounted = liveState.creditedDepositTotal + liveState.refundedWithdrawalTotal;

        if (delta > 0 && delta > accounted + 0.01) {
            const rewardAmount = delta - accounted;
            const adjusted = Math.max(0, rewardAmount);
            const title = 'Reward credited';
            const message = `${formatBalance(adjusted)} credited to your balance from a completed offer.`;
            showToast(title, message, { tone: 'success' });
            pushNotification({ title, message, tone: 'success', category: 'reward' });
        }
    }

    // Track demo balance changes for demo reward notifications.
    if (hadDemo && typeof payload.demoBalance === 'string' && payload.demoBalance !== String(liveState.lastKnownDemoBalance)) {
        const prevDemo = liveState.lastKnownDemoBalance;
        const newDemo = Number(payload.demoBalance);
        const demoDelta = newDemo - prevDemo;
        if (demoDelta > 0.01) {
            const title = 'Demo reward credited';
            const message = `${formatBalance(demoDelta)} demo added to your balance.`;
            showToast(title, message, { tone: 'info' });
            pushNotification({ title, message, tone: 'info', category: 'reward' });
        }
    }

    // Update the tracked previous balances for the next comparison.
    // `balance` can be `null` for demo-only accounts; coerce to 0 so the delta math
    // above stays correct on the next poll.
    if (typeof payload.balance === 'string' || payload.balance === null) {
        liveState.lastKnownBalance = payload.balance === null ? 0 : Number(payload.balance);
    }
    if (typeof payload.demoBalance === 'string') {
        liveState.lastKnownDemoBalance = Number(payload.demoBalance);
    }
}

/**
 * Paints the live status of the deposit currently on screen.
 *
 * The instructions panel used to say one fixed sentence for the whole life of the deposit,
 * which is the least useful sentence at the exact moment a user is staring at it: the money
 * has not arrived, and nothing on the page has changed to say so. The status comes from the
 * deposit rows the live sync already fetched, so it costs no extra request.
 */
function paintDepositStatus() {
    if (!activeDeposit || !activeDeposit.note) return;
    if (!isDialogOpen('deposit-dialog')) return;

    const rows = lastKnownDeposits;
    if (!rows.length) return;
    const deposit = activeDeposit.id ? rows.find((item) => item.id === activeDeposit.id) : rows[0];
    if (!deposit) return;

    const status = String(deposit.status || '').toLowerCase();
    const note = activeDeposit.note;
    note.classList.remove('is-credited', 'is-failed');

    if (status === 'confirmed' || status === 'paid') {
        note.classList.add('is-credited');
        note.textContent = `Credited to your balance on ${new Date(deposit.credited_at || deposit.created_at).toLocaleString()}.`;
        return;
    }
    if (status === 'failed' || status === 'expired') {
        note.classList.add('is-failed');
        note.textContent = status === 'expired'
            ? 'This address expired before the payment arrived. Start a new deposit to get a fresh address.'
            : 'The provider reported this payment as failed. Nothing was credited; you can start a new deposit.';
        return;
    }
    if (status === 'confirming') {
        note.textContent = 'The payment arrived and is being confirmed on the network. This usually takes a few minutes.';
        return;
    }
    note.textContent = 'Waiting for the payment to arrive. Your balance updates automatically once the provider confirms it.';
}

function isDialogOpen(id) {
    const dialog = document.getElementById(id);
    return Boolean(dialog && dialog.open);
}

/**
 * Says how current the page is, without a spinner.
 *
 * A page that updates itself needs to be able to say it stopped: a "live" indicator that
 * never acknowledges a failure is worse than none, because it tells the user the numbers
 * are current when they may not be. It is only rendered once a session exists, since a
 * logged-out visitor has nothing to sync.
 */
function paintLiveIndicator() {
    // The freshness line below the balance reads the same state and is painted from the same
    // tick, so the two can never disagree about whether the connection is up. It is not
    // conditional on the header indicator existing: a page can have the balance card and no
    // header indicator, and in that case this is what keeps the card honest.
    paintBalanceFreshness();

    const indicator = document.getElementById('live-indicator');
    if (!indicator) return;
    const token = getSessionToken();
    if (!token) {
        indicator.hidden = true;
        return;
    }
    indicator.hidden = false;
    const failing = liveState.consecutiveFailures > 0;
    const waiting = liveState.awaitingDeposit;
    indicator.classList.toggle('is-stale', failing);
    indicator.classList.toggle('is-waiting', waiting && !failing);
    if (failing) {
        const seconds = Math.round((Date.now() - liveState.lastSyncedAt) / 1000);
        indicator.textContent = seconds > 0
            ? `Connection lost - last updated ${seconds}s ago`
            : 'Connection lost - retrying';
        return;
    }
    indicator.textContent = waiting ? 'Waiting for payment...' : 'Live';
}

/* ------------------------------------------------- how fresh is the balance figure */

/**
 * How long the highlight on a changed balance lasts, and why.
 *
 * Long enough to see on a second glance, short enough that it is not decoration. Longer than
 * about a second and a balance that ticks every few seconds leaves the card permanently lit,
 * which stops meaning anything; much shorter and it is missed entirely, which leaves the class
 * looking like a bug rather than a signal.
 */
const BALANCE_FLASH_MS = 1500;

/** The account page's freshness line. Null on every page that has no balance card. */
const freshnessEl = document.getElementById('account-freshness');
const freshnessTextEl = document.getElementById('account-freshness-text');

let freshnessTimer = null;
let balanceFlashTimer = null;
/** When the figure last changed, or 0 if it never has. */
let balanceChangedAt = 0;
/**
 * How the freshness line was last worded, so the age is only rewritten when the wording
 * actually differs. Rewriting the text node on every tick is what turns a polite live region
 * into one that announces itself once a second.
 */
let freshnessWord = '';

/**
 * Says the balance changed, in the only place that knows: `applyBalance`.
 *
 * Not in the DOM observer or the live-sync poller, because both of those would report a change
 * that was not one -- the first paint, a re-render that rewrites the same figure, and a poll
 * that returned identical numbers are all writes to the element and none of them are news. This
 * compares the number, so "changed" means changed.
 *
 * Direction matters for the message: a rise is a reward landing, and saying so is the whole
 * point of a balance that updates itself. A fall is a withdrawal the visitor just made, which
 * they know about and do not need announced.
 */
function noteBalanceChange(previous, next) {
    if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return;
    balanceChangedAt = Date.now();

    const figure = document.getElementById('account-balance-main');
    if (figure) {
        figure.classList.remove('is-updated');
        // Re-adding without a reflow in between does not restart a CSS animation, and this
        // class is the only thing the highlight runs off.
        void figure.offsetWidth;
        figure.classList.add('is-updated');
        window.clearTimeout(balanceFlashTimer);
        balanceFlashTimer = setTimeout(() => figure.classList.remove('is-updated'), BALANCE_FLASH_MS);
    }

    // Wording, not a celebration. Which of the two it is, though, is worth saying: a rise is a
    // reward landing, which is the moment the card exists to report, and a fall is a withdrawal
    // the visitor just made and already knows about. The highlight is the alarm either way.
    freshnessWord = next > previous ? 'Reward received - balance updated' : 'Balance updated';
    paintBalanceFreshness(true);
}

/**
 * Paints "updated just now", or why it cannot say that.
 *
 * Four states, and the last is the one that matters:
 *
 *   no session      nothing to be fresh about, so the line is hidden
 *   never changed   the first figure has loaded but nothing has moved since
 *   failing         the connection is down and this number is the last known one, said
 *                   plainly, because a stale figure that looks live is worse than no figure
 *   aged            how long ago the number moved
 *
 * The wording is deliberately coarse. A precise "Updated 13s ago" would change every second,
 * and this line is inside an `aria-live="polite"` region: rewriting its text node on every
 * tick makes a screen reader say the same sentence over and over, which is worse than saying
 * less. Three wordings cover the first minute -- "just now", "less than a minute", then one
 * per minute -- so the region is written at most a few times a minute.
 *
 * Nothing is written at all when the wording is unchanged, which is the other half of that:
 * this runs off the live-sync timer, and that timer ticks several times a minute.
 */
function paintBalanceFreshness(force = false) {
    if (!freshnessEl || !freshnessTextEl) return;
    if (!getSessionToken()) {
        freshnessEl.hidden = true;
        return;
    }
    freshnessEl.hidden = false;

    const failing = liveState.consecutiveFailures > 0;
    const waiting = liveState.awaitingDeposit;
    const seconds = balanceChangedAt ? Math.round((Date.now() - balanceChangedAt) / 1000) : null;

    let wording;
    let tone;
    if (failing) {
        tone = 'is-stale';
        wording = seconds === null
            ? 'Connection lost - balance may be out of date'
            : `Connection lost - last update ${seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`}`;
    } else if (waiting) {
        tone = 'is-waiting';
        wording = 'Waiting for a payment to arrive';
    } else if (seconds === null) {
        tone = '';
        wording = 'Checking your balance';
    } else if (seconds < 15) {
        tone = 'is-fresh';
        wording = 'Updated just now';
    } else if (seconds < 60) {
        tone = 'is-fresh';
        wording = 'Updated less than a minute ago';
    } else {
        const minutes = Math.round(seconds / 60);
        tone = minutes < 5 ? '' : 'is-stale';
        wording = `Updated ${minutes} min ago`;
    }

    // The first paint after a change has to land even if the previous wording was identical,
    // which is what `force` is for. Everything else waits for the words to differ.
    if (wording === freshnessWord && !force) return;
    freshnessWord = wording;
    freshnessTextEl.textContent = wording;
    freshnessEl.classList.toggle('is-fresh', tone === 'is-fresh');
    freshnessEl.classList.toggle('is-waiting', tone === 'is-waiting');
    freshnessEl.classList.toggle('is-stale', tone === 'is-stale');
}

/* ---------------------------------------------------------------- helpers */

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

    if (!response.ok) {
        const error = new Error(payload?.error || payload || 'The request could not be completed.');
        error.status = response.status;
        // The parsed body rides along on the error so a caller can act on a structured
        // refusal instead of only being able to print its message. `login` answers 403 with
        // `requiresVerification`, and that is routing information rather than a dead end: it
        // means "show the code screen", not "something went wrong".
        error.payload = payload;
        throw error;
    }
    return payload;
}

function formatBalance(value) {
    const balance = Number(value);
    return Number.isFinite(balance)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(balance)
        : '--';
}

function setFormMessage(id, text, variant) {
    const element = document.getElementById(id);
    if (!element) return;
    element.className = 'form-message';
    if (variant) element.classList.add(`is-${variant}`);
    element.textContent = text;
}

function clearDepositMessage() { setFormMessage('deposit-message', ''); }
function clearWithdrawMessage() { setFormMessage('withdraw-message', ''); }

function setHint(id, text, isError) {
    const hint = document.getElementById(id);
    if (!hint) return;
    hint.textContent = text;
    hint.classList.toggle('is-error', Boolean(isError));
}

/** Ends a session: invalidates the server-side token, then clears the local copy. */
function signOut({ leave = false } = {}) {
    const token = getSessionToken();
    if (token) {
        // Fire-and-forget: the local token is cleared immediately below, so a
        // server call that is still in flight when the tab closes does not delay
        // the sign-out. The fetch is not awaited because callers (handleUnauthorized,
        // handleAccountButton) treat this as synchronous.
        fetch('/api/auth/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: '{}'
        }).catch(() => {});
    }
    sessionStorage.removeItem(accountTokenKey);
    // With the token. The address belongs to the session that just ended, and leaving it
    // would pre-fill the support form for whoever signs in next on this tab.
    sessionStorage.removeItem(accountEmailKey);
    // The switch belongs to the session that just ended. Left painted at whatever it was, it
    // would show the previous user's setting to whoever signs in next on this tab.
    emailPrefState.enabled = true;
    emailPrefState.loaded = false;
    emailPrefState.saving = false;
    // The profile belongs to the session that just ended, and it is the sharper case of the
    // same problem: a name and a picture left painted belong to someone who is no longer
    // signed in, and the next person to use this tab would be looking at their own account
    // page with the previous user's name on it.
    profileState.displayName = '';
    profileState.avatarData = null;
    profileState.email = '';
    profileState.accountId = null;
    profileState.saved = { displayName: '', avatarData: null };
    profileState.loaded = false;
    profileState.saving = false;
    profileState.dirty = false;
    const profileNameInput = document.getElementById('profile-display-name');
    if (profileNameInput) profileNameInput.value = '';
    syncAccountControls();
    renderEmailPreference();
    renderProfileEditor();

    // Signing out of a page that requires a session leaves the visitor somewhere they can
    // no longer do anything: the controls have just gone grey and the gate would refuse them
    // on the next reload. So a deliberate sign-out leaves the private area, rather than
    // stranding them on it. `handleUnauthorized` passes `leave: false` because it sends them
    // to sign in itself, which is the better answer for an expired session.
    if (leave && document.body?.dataset.requiresSession === 'true' && window.RewardZoneSession) {
        window.location.replace('/');
    }
}

/**
 * What happens when the server says the token is no longer good.
 *
 * The token is checked only by the API, so an expired or revoked session is discovered
 * here rather than at page load. Signing out alone left the visitor on a page whose
 * controls had just gone grey, with a toast that said "session expired" and nothing to do
 * about it -- so they were sent to sign in, and returned to the page they were on. The
 * toast is kept because it says *why*, which a bare sign-in form does not.
 *
 * Returns true when the error was a 401, so callers can skip their own failure handling:
 * a re-authentication prompt is not something to also render as "Could not load your
 * history".
 */
function handleUnauthorized(error) {
    if (error.status !== 401) return false;
    signOut();
    notifySessionExpired();
    // On the account page the sign-in dialog is already here, so it opens in place --
    // navigating to the login URL would load a second copy of this same page to show a form
    // the visitor can already see. Everywhere else the page is one the gate cannot vouch
    // for, and the return path carries the visitor back.
    if (document.getElementById('account-dialog')) {
        setAuthMode('login');
        const dialog = document.getElementById('account-dialog');
        if (dialog && !dialog.open) dialog.showModal();
    } else if (window.RewardZoneSession) {
        window.RewardZoneSession.goToLogin(window.RewardZoneSession.currentReturnPath());
    }
    return true;
}

/* ---------------------------------------------------------------- catalog */

/**
 * Says why the browser arrived here, when the server sent it back.
 *
 * `/offer/engage` redirects to the catalog with `?notice=demo-unavailable` when a click was
 * recorded against a demo offer that this deployment cannot run -- a click made in local
 * development and then engaged on a deployment with demo mode off, which is exactly what a
 * shared database between the two produces. Returning the user here with no explanation
 * would look like the click did nothing; the notice is the difference between "this offer
 * is not available here" and "something is broken".
 *
 * The parameter is read rather than the whole query string, and only recognised values are
 * acted on, so an arbitrary query string cannot put text on the page.
 */
const PAGE_NOTICES = {
    'demo-unavailable': 'That offer is a test offer, and test offers are not available in this environment.'
};

function showPageNotice() {
    let notice;
    try {
        notice = new URLSearchParams(window.location.search).get('notice');
    } catch {
        return;
    }
    const text = PAGE_NOTICES[notice];
    if (!text) return;
    showPageMessage(text);
    // The notice is removed once shown so a refresh does not repeat it, and so the URL the
    // user copies does not carry it.
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete('notice');
    window.history.replaceState({}, '', cleaned.pathname + cleaned.search);
}

/**
 * Loads the catalog.
 *
 * Resolves to true when the catalog rendered, so the caller knows whether the message area
 * is free. A failure resolves to false rather than rejecting: nothing awaits this for its
 * error, and an unhandled rejection from a page-load convenience call would be reported as
 * a broken script instead of as a catalog that did not load.
 */
async function loadOffers() {
    const skeletons = document.getElementById('loading-skeletons');
    const grid = document.getElementById('offer-grid');
    const message = document.getElementById('page-message');
    if (!skeletons || !grid || !message) return;
    skeletons.hidden = false;
    grid.setAttribute('aria-busy', 'true');
    message.hidden = true;

    try {
        const offers = await requestJson('/api/offers');
        if (!Array.isArray(offers)) throw new Error('The offers response was not valid.');
        offerState.all = offers;
        renderOffers();
        return true;
    } catch (error) {
        offerState.all = [];
        grid.replaceChildren();
        const countEl = document.getElementById('offer-count');
        if (countEl) countEl.textContent = 'Offers unavailable';
        message.replaceChildren(document.createTextNode(`${error.message} `));
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'inline-action';
        retry.textContent = 'Try again';
        retry.addEventListener('click', loadOffers);
        message.append(retry);
        message.hidden = false;
        return false;
    } finally {
        skeletons.hidden = true;
        grid.removeAttribute('aria-busy');
    }
}

/**
 * Everything a card can be matched or sorted on, lower-cased once.
 *
 * Search used to compare the title alone, so typing a partner name or "survey" found
 * nothing even though both were on screen. The blurb is included too, which is what makes
 * a keyword search useful rather than decorative.
 */
function offerSearchText(offer) {
    return [
        offer.title,
        offer.description,
        offer.network_name,
        offer.partner_label,
        offer.is_demo ? 'demo test' : '',
        offer.offer_type === 'survey' ? 'survey questionnaire' : 'offer task'
    ].filter(Boolean).join(' ').toLowerCase();
}

function renderOffers() {
    const grid = document.getElementById('offer-grid');
    const count = document.getElementById('offer-count');
    if (!count || !grid) return;
    const visible = offerState.all.filter((offer) => {
        if (offerState.type !== 'all' && offer.offer_type !== offerState.type) return false;
        if (!offerState.search) return true;
        return offerSearchText(offer).includes(offerState.search);
    });

    if (offerState.sort === 'payout-high') {
        visible.sort((a, b) => Number(b.payout) - Number(a.payout));
    } else if (offerState.sort === 'payout-low') {
        visible.sort((a, b) => Number(a.payout) - Number(b.payout));
    } else if (offerState.sort === 'title') {
        visible.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }

    // The count states the total as well as the visible number whenever a filter is
    // hiding something. "0 offers" on a list of twelve reads as an outage; "0 of 12 match"
    // reads as what it is, which is a search that found nothing.
    const filtering = offerState.type !== 'all' || Boolean(offerState.search);
    const total = offerState.all.length;
    count.textContent = filtering
        ? `${visible.length} of ${total} ${total === 1 ? 'offer' : 'offers'}`
        : `${visible.length} ${visible.length === 1 ? 'offer' : 'offers'}`;
    grid.replaceChildren();

    if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const message = document.createElement('p');
        message.textContent = offerState.all.length === 0
            ? 'There are no offers available right now. Check back soon.'
            : 'No offers match these filters.';
        empty.append(message);
        // A filter that cannot be undone from the screen is a dead end, so the empty state
        // offers the reset rather than only reporting the problem.
        if (offerState.all.length > 0) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'inline-action';
            reset.textContent = 'Clear filters';
            reset.addEventListener('click', () => {
                offerState.search = '';
                offerState.type = 'all';
                const searchInput = document.getElementById('offer-search');
                if (searchInput) searchInput.value = '';
                document.querySelectorAll('[data-offer-type]').forEach((chip) => {
                    chip.setAttribute('aria-pressed', String(chip.dataset.offerType === 'all'));
                });
                renderOffers();
            });
            empty.append(reset);
        }
        grid.append(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((offer, index) => {
        const isSurvey = offer.offer_type === 'survey';
        const title = String(offer.title || 'Untitled offer');
        const payout = Number(offer.payout);

        const card = document.createElement('article');
        card.className = 'offer-card';
        // Custom property set through CSSOM; a style attribute would be blocked by CSP.
        card.style.setProperty('--card-delay', `${Math.min(index, 8) * 35}ms`);

        const top = document.createElement('div');
        top.className = 'offer-card-top';
        const id = document.createElement('span');
        id.className = 'offer-id';
        id.textContent = `OFFER ${offer.id}`;
        // A survey and a partner task are different things to agree to, so the type is a
        // badge on its own rather than a word buried in the partner line. Someone scanning
        // for quick surveys can find them without reading every card.
        const type = document.createElement('span');
        type.className = isSurvey ? 'offer-type is-survey' : 'offer-type';
        type.textContent = isSurvey ? 'Survey' : 'Offer';
        const partner = document.createElement('span');
        partner.className = 'offer-partner';
        // The partner label is preferred over the tracking network name, which is written
        // for a tracking URL rather than for a person deciding whether to start a task.
        partner.textContent = offer.partner_label || offer.network_name || 'Partner';
        top.append(id, type, partner);

        // Surveys are the only kind with a predictable length, and stating it is what a
        // survey provider does. It is the question people actually ask before committing to
        // one, and an unanswered "how long is this?" reads as an unbounded task. The estimate
        // comes from the offer row when it is set, so an operator who knows the survey takes
        // five minutes can say so on the card instead of leaving the page to guess.
        const estimated = Number(offer.estimated_minutes);
        if (isSurvey && Number.isFinite(estimated) && estimated > 0) {
            const estimate = document.createElement('span');
            estimate.className = 'offer-estimate';
            estimate.textContent = `~${estimated} min`;
            top.append(estimate);
        }

        const heading = document.createElement('h2');
        heading.className = 'offer-title';
        heading.textContent = title;

        // The blurb is the reason the card is worth reading, so it is a real paragraph
        // rather than a title attribute: it is the only text on the card that says what the
        // user has to do.
        if (offer.description) {
            const blurb = document.createElement('p');
            blurb.className = 'offer-blurb';
            blurb.textContent = offer.description;
            card.append(blurb);
        }

        const reward = document.createElement('div');
        reward.className = 'offer-reward';
        const rewardLabel = document.createElement('span');
        if (offer.is_demo && offer.pays_real_money) {
            rewardLabel.textContent = 'Real reward';
        } else if (offer.is_demo) {
            rewardLabel.textContent = 'Test-only reward';
        } else {
            rewardLabel.textContent = 'Reward';
        }
        const amount = document.createElement('strong');
        if (offer.is_demo && !offer.pays_real_money) {
            amount.className = 'demo-reward';
            amount.textContent = Number.isFinite(payout) ? `${formatBalance(payout)} demo` : '--';
        } else {
            amount.textContent = Number.isFinite(payout) ? formatBalance(payout) : '--';
        }
        reward.append(rewardLabel, amount);

        // A demo offer that pays real money is worth a second line of explanation. Without
        // it a participant sees "Real reward" and has no idea the money is theirs to keep,
        // which is the entire difference between a test offer and a real one.
        if (offer.is_demo && offer.pays_real_money) {
            const note = document.createElement('p');
            note.className = 'offer-blurb';
            note.style.color = 'var(--muted)';
            note.textContent = 'Pays real money in this test environment.';
            card.append(note);
        }

        const start = document.createElement('button');
        start.className = 'start-button';
        start.type = 'button';
        start.textContent = isSurvey ? 'Take survey' : 'Start offer';
        start.setAttribute('aria-label', `${isSurvey ? 'Take survey' : 'Start offer'}: ${title}`);
        start.addEventListener('click', () => trackOffer(offer.id, start));

        card.append(top, heading, reward, start);
        fragment.append(card);
    });

    grid.append(fragment);
}

async function trackOffer(offerId, button) {
    const token = getSessionToken();
    if (!token) {
        showPageMessage('Connect your account before starting an offer.');
        const dialog = document.getElementById('account-dialog');
        if (dialog) dialog.showModal();
        return;
    }

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing...';

    try {
        const result = await requestJson(`/api/click/${encodeURIComponent(offerId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
        });
        const destination = new URL(result.redirectUrl, window.location.origin);
        if (!['http:', 'https:'].includes(destination.protocol)) {
            throw new Error('This offer has an invalid destination.');
        }
        window.location.assign(destination.toString());
    } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        if (handleUnauthorized(error)) {
            const dialog = document.getElementById('account-dialog');
            if (dialog) dialog.showModal();
            return;
        }
        showPageMessage(error.message);
    }
}

/**
 * Paints every part of the account identity: the header menu, the greeting, and the mark.
 *
 * The user's own picture when they have set one, the brand mark otherwise. The mark is not a
 * generic "signed in" glyph: it is the logo the rest of the product uses, and it stays
 * correct for a visitor who has not chosen a picture -- which is everyone on their first
 * visit, and anyone who never sets one.
 *
 * The same values are written to several places -- the trigger, the panel header, the
 * greeting -- from one state object, so they cannot disagree with each other. A header that
 * says "Ada" above a panel that says "Your account" is the kind of small wrongness that
 * makes a whole page feel unfinished.
 */
function paintAccountAvatar() {
    const connected = Boolean(getSessionToken());
    const source = connected && profileState.avatarData ? profileState.avatarData : '/brand.gif';

    // The bare mark is kept for pages that have no account menu. On those it is the whole
    // account affordance, and hiding it removes a control that does something.
    const avatar = document.getElementById('account-avatar');
    if (avatar) {
        avatar.src = source;
        avatar.hidden = !connected || document.getElementById('account-menu') !== null;
    }

    const name = connected ? profileState.displayName.trim() : '';
    const email = connected ? profileState.email : '';

    // The menu replaces the header's "Sign out" text entirely while signed in, so the two
    // are never both on screen. That is the duplicate this removes: previously the header
    // button became "Sign out" on sign-in *and* the settings card had its own, so one page
    // offered the same destructive action twice.
    const menu = document.getElementById('account-menu');
    if (menu) menu.hidden = !connected;
    const accountButton = document.getElementById('account-button');
    if (accountButton && connected) {
        // Signed in, the menu owns signing out. The button stays in the DOM for pages that
        // still need it, but it is not shown on this one.
        accountButton.hidden = document.getElementById('account-menu') !== null;
    }

    for (const id of ['account-menu-avatar', 'account-menu-avatar-lg']) {
        const image = document.getElementById(id);
        if (image) image.src = source;
    }
    for (const id of ['account-menu-name', 'account-menu-header-name']) {
        const element = document.getElementById(id);
        if (element) element.textContent = name || 'Your account';
    }
    for (const id of ['account-menu-email', 'account-menu-header-email']) {
        const element = document.getElementById(id);
        if (!element) continue;
        element.textContent = email;
        element.hidden = email.length === 0;
    }

    // The greeting. Falls back to the address's local part when no display name has been
    // chosen, because "Welcome back" on its own is a banner and "Welcome back, ada" is a
    // greeting -- and a new account has no name yet, which is exactly when a greeting is
    // most welcome. Never rendered signed out.
    const greeting = document.getElementById('account-greeting');
    if (greeting) {
        const salutation = name || (email ? email.split('@')[0] : '');
        greeting.textContent = salutation ? `Welcome back, ${salutation}` : '';
        greeting.hidden = !connected || salutation.length === 0;
    }

    // A menu left open across a sign-out would be showing the previous user's name and
    // address to whoever signs in next on this tab.
    if (!connected) closeAccountMenu();
}

function showPageMessage(message) {
    const box = document.getElementById('page-message');
    if (!box) return;
    box.replaceChildren(document.createTextNode(message));
    box.hidden = false;
}

/* ---------------------------------------------------------------- account */

function syncAccountControls() {
    const connected = Boolean(getSessionToken());
    // "Connect account" only, and only while signed out.
    //
    // This used to become "Sign out" on sign-in, which is what made the account page offer
    // the same destructive action twice: once here and once in the settings card. With the
    // account menu in the header, signing out happens there, and this button is the way in
    // rather than the way out. Its visibility is decided in `paintAccountAvatar`, which is
    // the one place that knows whether the menu exists on this page.
    const accountButton = document.getElementById('account-button');
    if (accountButton) accountButton.textContent = 'Connect account';
    paintAccountAvatar();

    // The account page's balance card holds this pair and it is the only money control on
    // screen there, so its state follows the session like everything else. The header's account
    // menu carries the same pair on every page -- the offers page's narrow action bar mirrors
    // those two -- which is why both sets are optional here: each page carries the ones it owns.
    const accountDepositBtn = document.getElementById('account-menu-deposit');
    if (accountDepositBtn) accountDepositBtn.disabled = !connected;
    const accountWithdrawBtn = document.getElementById('account-menu-withdraw');
    if (accountWithdrawBtn) accountWithdrawBtn.disabled = !connected;

    const accountCardDepositBtn = document.getElementById('account-deposit-btn');
    if (accountCardDepositBtn) accountCardDepositBtn.disabled = !connected;
    const accountCardWithdrawBtn = document.getElementById('account-withdraw-btn');
    if (accountCardWithdrawBtn) accountCardWithdrawBtn.disabled = !connected;

    // The notification bell is only useful when signed in; hide it (and close any
    // open dropdown) for a logged-out visitor. Both bells are toggled: the header one is
    // `display: none` on a phone and the action-bar one is hidden there, so a signed-in
    // visitor on either layout needs its own copy revealed.
    for (const id of ['notification-bell', 'notification-bell-mobile']) {
        const bell = document.getElementById(id);
        if (!bell) continue;
        bell.hidden = !connected;
        if (!connected) closeNotificationDropdown();
    }

    // Mirror the header state onto the narrow-screen action bar. Every mirrored control now
    // ships `disabled` in the markup and is lifted here, so a bar button is never live while
    // the header control it forwards to is not.
    document.querySelectorAll('[data-mirror]').forEach((barButton) => {
        const target = document.getElementById(barButton.dataset.mirror);
        if (!target) return;
        barButton.disabled = target.disabled;
    });

    if (!connected) {
        const userBalance = document.getElementById('user-balance');
        if (userBalance) userBalance.textContent = '--';
        const demoBalance = document.getElementById('demo-balance');
        if (demoBalance) demoBalance.textContent = '--';
        const accountBalance = document.getElementById('account-balance-main');
        if (accountBalance) accountBalance.textContent = '--';
        const accountDemoBalance = document.getElementById('account-demo-balance');
        if (accountDemoBalance) accountDemoBalance.textContent = '--';
    }
}

/**
 * Paints the money-email switch from whatever is currently known.
 *
 * Three states, not two. Signed out, the switch is disabled and reads as on: there is no
 * session to read a preference from, and painting it off would tell a signed-out visitor
 * they had turned their receipts off when the page has no idea. Saving is its own state so a
 * slow round trip does not let the user flip it twice and leave it somewhere they did not
 * choose.
 */
function renderEmailPreference() {
    const toggle = document.getElementById('money-emails-toggle');
    if (!toggle) return;
    const connected = Boolean(getSessionToken());
    toggle.disabled = !connected || emailPrefState.saving;
    toggle.checked = emailPrefState.enabled;

    const status = document.getElementById('money-emails-status');
    if (!status) return;
    if (emailPrefState.saving) {
        status.textContent = 'Saving...';
        status.classList.remove('is-error');
        return;
    }
    if (!connected) {
        status.textContent = 'Sign in to change this.';
        status.classList.remove('is-error');
        return;
    }
    if (!emailPrefState.loaded) {
        status.textContent = '';
        status.classList.remove('is-error');
        return;
    }
    // The confirmation is the point. A switch that silently changes leaves the user unsure
    // whether it took, and the natural next move is to click it again -- which is how a
    // setting gets put back the way it was by accident.
    status.textContent = emailPrefState.enabled
        ? 'Deposit and withdrawal emails are on.'
        : 'Off. Everything still appears on this page and in your history.';
    status.classList.remove('is-error');
}

/**
 * Reads the current preference.
 *
 * Silent on failure: the page has not asked the user to change anything yet, so a request
 * that did not succeed is better left unreported than shown as an error they did not cause.
 * The switch stays on, which matches the server's own fail-open rule for the send path.
 */
async function loadEmailPreference() {
    const toggle = document.getElementById('money-emails-toggle');
    if (!toggle) return;
    if (!getSessionToken()) {
        emailPrefState.loaded = false;
        emailPrefState.enabled = true;
        renderEmailPreference();
        return;
    }
    try {
        const result = await requestJson('/api/user/email-preferences', {
            headers: authHeaders(),
            cache: 'no-store'
        });
        emailPrefState.enabled = result.moneyEmailsEnabled !== false;
        emailPrefState.loaded = true;
    } catch (error) {
        if (handleUnauthorized(error)) return;
        emailPrefState.enabled = true;
        emailPrefState.loaded = false;
    }
    renderEmailPreference();
}

/**
 * Writes the preference, and puts the switch back where it was if the write failed.
 *
 * The revert is the important half. An optimistic switch that stays flipped after a failed
 * save tells the user their receipts are off when they are not -- and the failure mode of
 * that is a missed withdrawal receipt, which is precisely what the setting exists to control.
 */
async function saveEmailPreference(next) {
    const toggle = document.getElementById('money-emails-toggle');
    if (!toggle || emailPrefState.saving) return;

    const previous = emailPrefState.enabled;
    emailPrefState.enabled = next;
    emailPrefState.saving = true;
    renderEmailPreference();

    try {
        const result = await requestJson('/api/user/email-preferences', {
            method: 'PATCH',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ moneyEmailsEnabled: Boolean(next) })
        });
        // Trust the stored value over the requested one, so what is shown is what is saved.
        emailPrefState.enabled = result.moneyEmailsEnabled !== false;
        emailPrefState.loaded = true;
        emailPrefState.saving = false;
        renderEmailPreference();
        showToast(
            emailPrefState.enabled ? 'Emails switched on' : 'Emails switched off',
            emailPrefState.enabled
                ? 'You will get receipts and progress updates for deposits and withdrawals.'
                : 'You will still see everything on this page and in your history.'
        );
    } catch (error) {
        emailPrefState.enabled = previous;
        emailPrefState.saving = false;
        renderEmailPreference();
        if (handleUnauthorized(error)) return;
        const status = document.getElementById('money-emails-status');
        if (status) {
            // Says the switch moved back rather than that "nothing changed". The user is
            // looking at a control that snapped to a position they did not choose, and
            // "unchanged" does not explain why it is no longer where they left it.
            status.textContent = 'Could not save that, so the switch is back where it was.';
            status.classList.add('is-error');
        }
    }
}

/* ---------------------------------------------------------------- account data */

/**
 * Quotes one CSV field.
 *
 * The naive `field.replace(/"/g, '""')` is not enough on its own: a value containing a
 * comma, a newline, or a leading `=` is not just a display problem. Excel and Google Sheets
 * both treat a cell beginning with `=`, `+`, `-`, or `@` as a formula, so a transaction
 * description that happens to start with one is executed on open. Prefixing an apostrophe
 * is the standard way to force the cell to be read as text, and it is invisible to the
 * person looking at the sheet.
 */
function csvField(value) {
    if (value === null || value === undefined) return '""';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Downloads the account's transactions as a CSV.
 *
 * Built in the browser from the same `/api/user/history` the page already renders, rather
 * than from a new server-side export. That is a deliberate choice: it is the identical data
 * the user is looking at, so the file and the screen cannot disagree, and there is no second
 * query to keep in step with the first. The cost is that it covers the history endpoint's
 * page size, which is stated in the confirmation rather than left to be discovered when the
 * sheet turns out to be short.
 */
async function exportTransactions() {
    const status = document.getElementById('account-data-status');
    const button = document.getElementById('account-export-btn');
    const token = getSessionToken();
    if (!token) return;

    if (button) button.disabled = true;
    if (status) {
        status.textContent = 'Preparing your transactions...';
        status.classList.remove('is-error');
    }

    try {
        const rows = await requestJson('/api/user/history', {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store'
        });

        const header = ['Date', 'Type', 'Amount (USD)', 'Description', 'Reference'];
        const lines = [header.map(csvField).join(',')];
        for (const row of Array.isArray(rows) ? rows : []) {
            lines.push([
                row.created_at || '',
                row.transaction_type || '',
                row.amount ?? '',
                row.description || '',
                row.source_id || ''
            ].map(csvField).join(','));
        }

        // The BOM is what makes Excel read the file as UTF-8 rather than as the local
        // codepage, which is what turns every non-ASCII character in a description into
        // mojibake. Harmless to every other reader.
        const csv = `\uFEFF${lines.join('\r\n')}`;
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `rewardzone-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoked on the next tick rather than immediately: Safari cancels the download if
        // the object URL disappears in the same task that started it.
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        const count = Array.isArray(rows) ? rows.length : 0;
        if (status) {
            status.textContent = count > 0
                ? `Downloaded ${count} transaction${count === 1 ? '' : 's'}.`
                : 'There are no transactions to download yet.';
        }
        if (button) button.disabled = false;
    } catch (error) {
        if (button) button.disabled = false;
        if (handleUnauthorized(error)) return;
        if (status) {
            status.textContent = error.message || 'Could not build your transactions file.';
            status.classList.add('is-error');
        }
    }
}

/**
 * Copies the reference support asks for, to the clipboard.
 *
 * Deliberately the account *id* and not anything secret. Support needs to find the account,
 * and the id is the only value that does that without handing over a credential -- a support
 * agent who can paste an id into a query is useful; one holding a working session token is a
 * liability.
 */
async function copyAccountReference() {
    const status = document.getElementById('account-data-status');
    const button = document.getElementById('account-copy-ref-btn');
    const reference = `RewardZone account ${profileState.accountId || '(id unavailable)'} — ${profileState.email || '(no address on file)'}`;

    try {
        // The async Clipboard API is unavailable on http:// origins other than localhost,
        // which includes any deployment still behind a plain-HTTP tunnel. It is not a rare
        // edge: it is the whole local development environment.
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(reference);
        } else {
            throw new Error('The clipboard is not available in this browser.');
        }
        if (status) {
            status.textContent = 'Copied. Paste it into a message to support.';
            status.classList.remove('is-error');
        }
    } catch {
        // The text is shown either way. A copy button that fails silently on an insecure
        // origin is worse than no copy button, and showing the value means the feature still
        // does the one thing it is for.
        if (status) {
            status.textContent = `Copy this: ${reference}`;
            status.classList.remove('is-error');
        }
    }
    if (button) button.disabled = false;
}

/**
 * Ends every session on the account.
 *
 * The button is disabled for the duration rather than the request being fire-and-forget,
 * because the response means this tab is signed out too and the user needs to be told that
 * before they click anything else. `signOut` then clears the local copy; its own call to
 * `/api/auth/logout` is now made with a token that no longer verifies, which is harmless
 * because the server has already done the work by this point.
 */
async function revokeAllSessions() {
    const button = document.getElementById('account-revoke-sessions-btn');
    const status = document.getElementById('account-revoke-sessions-status');
    const token = getSessionToken();
    if (!token || (button && button.disabled)) return;

    if (button) button.disabled = true;
    if (status) {
        status.textContent = 'Ending every session...';
        status.classList.remove('is-error');
    }

    try {
        const result = await requestJson('/api/user/sessions/revoke', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: '{}'
        });
        showToast('Signed out everywhere', result.message || 'Every session on this account has ended.');
        // `leave: true` because this page needs a session and there no longer is one, so
        // staying would leave the user staring at controls that are all about to go grey.
        signOut({ leave: true });
    } catch (error) {
        if (button) button.disabled = false;
        if (handleUnauthorized(error)) return;
        if (status) {
            status.textContent = error.message || 'Could not end your other sessions.';
            status.classList.add('is-error');
        }
    }
}

/* ---------------------------------------------------------------- account menu */

/**
 * Opens or closes the account menu.
 *
 * The one piece of state is `aria-expanded` on the trigger, and the panel's `hidden` is
 * derived from it, so the two cannot drift. A menu that is visually open while the trigger
 * still says `collapsed` is announced as closed to a screen reader and is dismissed by the
 * first Escape -- which reads as the menu ignoring the keyboard.
 */
function setAccountMenuOpen(open) {
    const trigger = document.getElementById('account-menu-trigger');
    const panel = document.getElementById('account-menu-panel');
    if (!trigger || !panel) return;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
        // Focus moves into the panel so a keyboard user is not left behind it, and lands on
        // the first item rather than the panel itself, which is not focusable.
        const first = panel.querySelector('.account-menu-item');
        if (first) first.focus();
    }
}

function closeAccountMenu() {
    setAccountMenuOpen(false);
}

function accountMenuIsOpen() {
    return document.getElementById('account-menu-trigger')?.getAttribute('aria-expanded') === 'true';
}

/**
 * Wires the account menu: open on click, close on Escape, on outside click, and on blur.
 *
 * Closing on blur rather than only on an outside click is what makes it behave like a menu
 * rather than a panel -- tabbing past the last item closes it, instead of leaving a floating
 * box open behind the page while the user carries on somewhere else.
 */
function initAccountMenu() {
    const trigger = document.getElementById('account-menu-trigger');
    const panel = document.getElementById('account-menu-panel');
    if (!trigger || !panel) return;

    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        setAccountMenuOpen(!accountMenuIsOpen());
    });

    // Escape, and Tab out of the last item.
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeAccountMenu();
            trigger.focus();
            return;
        }
        if (event.key !== 'Tab') return;
        const items = [...panel.querySelectorAll('.account-menu-item')].filter((item) => !item.disabled);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        // Only wrap the ends. Wrapping everywhere turns the menu into a carousel, which makes
        // reaching anything on the page behind it with the keyboard impossible.
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    // Any click outside the menu closes it. Capture phase, so a click that also dismisses a
    // dialog does not reopen it on the way through.
    document.addEventListener('click', (event) => {
        if (!accountMenuIsOpen()) return;
        if (!event.target.closest('#account-menu')) closeAccountMenu();
    }, true);

    // Focus leaving the menu entirely closes it, for the same reason the Tab wrap exists.
    document.addEventListener('focusin', (event) => {
        if (!accountMenuIsOpen()) return;
        if (!event.target.closest('#account-menu')) closeAccountMenu();
    });

    // The menu is anchored below the trigger. On a short window it would open off the bottom
    // of the screen, so it flips above instead of being clipped.
    const positionMenu = () => {
        if (!accountMenuIsOpen()) return;
        const rect = panel.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.top;
        if (rect.height > spaceBelow && rect.top > rect.height) {
            panel.style.top = 'auto';
            panel.style.bottom = 'calc(100% + 10px)';
        } else {
            panel.style.top = 'calc(100% + 10px)';
            panel.style.bottom = 'auto';
        }
    };
    window.addEventListener('resize', positionMenu, { passive: true });
    window.addEventListener('orientationchange', positionMenu, { passive: true });
    trigger.addEventListener('click', () => requestAnimationFrame(positionMenu));
}

/**
 * Paints the profile card from whatever is currently known.
 *
 * Three states, matching the email switch's. Signed out there is no session to read a
 * profile from, so the controls are disabled rather than showing an empty form that a save
 * would silently attach to nobody. Loading and saving are their own states so a slow round
 * trip cannot let the user press save twice, which on a partial form would send the second
 * request for the same change and report a confusing sequence of successes.
 */
function renderProfileEditor() {
    // The header identity is painted first and unconditionally. It used to sit *after* the
    // early return below, which is the second half of the bug this was written for: the
    // guard correctly skipped the editor on a page that has no editor, and then skipped the
    // account menu and greeting with it. So on the offers page -- which has a menu and no
    // editor -- the header kept its initial "Your account" and brand mark forever, and
    // loading the profile changed nothing visible.
    paintAccountAvatar();

    const nameInput = document.getElementById('profile-display-name');
    const preview = document.getElementById('profile-avatar-preview');
    const removeBtn = document.getElementById('profile-avatar-remove');
    const saveBtn = document.getElementById('profile-save');
    const avatarInput = document.getElementById('profile-avatar-input');
    if (!nameInput || !saveBtn) return;

    const connected = Boolean(getSessionToken());
    const picture = profileState.avatarData;

    if (preview) preview.src = picture || '/brand.gif';
    if (removeBtn) removeBtn.hidden = !picture || !connected;
    if (avatarInput) avatarInput.disabled = !connected || profileState.saving;

    nameInput.disabled = !connected || profileState.saving;
    saveBtn.disabled = !connected || profileState.saving || !profileState.dirty;

    const status = document.getElementById('profile-status');
    if (!status) return;
    if (profileState.saving) {
        status.textContent = 'Saving...';
        status.classList.remove('is-error');
        return;
    }
    if (!connected) {
        status.textContent = 'Sign in to change this.';
        status.classList.remove('is-error');
        return;
    }
    if (!profileState.loaded) {
        status.textContent = '';
        status.classList.remove('is-error');
    }
}

/**
 * Records that the form no longer matches what is stored, which is what enables Save.
 *
 * Comparing the working values against the last confirmed ones is the honest definition of
 * "changed". A save button that is merely always-on would let a user press it with nothing
 * to save and get a confirmation for a write that changed nothing; a button that is enabled
 * per-keystroke by any edit would go dead the moment the user typed a name and then deleted
 * it back to exactly what was already stored.
 */
function updateProfileDirty() {
    profileState.dirty =
        profileState.displayName !== profileState.saved.displayName ||
        profileState.avatarData !== profileState.saved.avatarData;
    renderProfileEditor();
}

/**
 * Reads the profile from the server.
 *
 * Silent on failure, like the email preference: the page has not asked the user to change
 * anything yet, so a request that did not succeed is better left unreported than surfaced
 * as an error they did not cause. The card stays empty and editable, and a save that then
 * works is the real answer.
 */
/**
 * Reads the profile from the server.
 *
 * Runs on every page that shows *any* of the account identity, not only the one with the
 * profile editor in it. The gate used to be `#profile-display-name`, which exists only on the
 * account page -- so on the offers page the header had nothing to draw from and painted the
 * fallback: "Your account" and the brand mark, for a visitor who was signed in and had a name
 * and a picture saved. The session and the profile are two facts, and the page was reading
 * one of them.
 *
 * Silent on failure, like the email preference: the page has not asked the user to change
 * anything yet, so a request that did not succeed is better left unreported than surfaced
 * as an error they did not cause. The controls stay empty and editable, and a save that then
 * works is the real answer.
 */
async function loadProfile() {
    // Any of these means the page draws the account's name or picture. The editor is the
    // one that is optional; the menu and the bare mark are the ones that must be fed.
    const hasIdentity = Boolean(
        document.getElementById('profile-display-name') ||
        document.getElementById('account-menu') ||
        document.getElementById('account-avatar')
    );
    if (!hasIdentity) return;

    if (!getSessionToken()) {
        profileState.loaded = false;
        profileState.dirty = false;
        profileState.email = '';
        profileState.accountId = null;
        renderProfileEditor();
        return;
    }

    try {
        const result = await requestJson('/api/user/profile', {
            headers: authHeaders(),
            cache: 'no-store'
        });
        profileState.displayName = result.displayName || '';
        profileState.avatarData = result.avatarData || null;
        profileState.email = result.email || sessionStorage.getItem(accountEmailKey) || '';
        profileState.accountId = result.id ?? null;
        // What the server reported, not what was typed into the form. Without this the `saved`
        // baseline stays empty, `updateProfileDirty` sees a difference on a freshly loaded
        // page, and Save is enabled with nothing to save.
        profileState.saved = { displayName: profileState.displayName, avatarData: profileState.avatarData };
        profileState.loaded = true;
    } catch (error) {
        profileState.loaded = false;
        if (handleUnauthorized(error)) return;
    }

    const nameInput = document.getElementById('profile-display-name');
    // Only written when the user is not mid-edit. A response that lands after they have
    // started typing would otherwise replace what they are typing with what they typed
    // before, which reads as the field fighting back.
    if (nameInput && !profileState.dirty) nameInput.value = profileState.displayName;
    updateProfileDirty();
}

/**
 * Turns a picked file into the data URL that will actually be stored.
 *
 * The file is decoded, drawn centred and square-cropped onto a canvas, and re-encoded as
 * PNG. Doing the resize here rather than asking the server to do it is what keeps the
 * request inside the 32 KB body limit and the stored row inside its 16 KB cap, and it means
 * the user picks any picture their device has rather than having to pre-crop one to a
 * square themselves.
 *
 * `Promise` around the `FileReader` because the alternative is an event handler that has to
 * remember what to do on failure, and a rejected promise routes into the same error path as
 * everything else in this file.
 */
function readPickedAvatar(file) {
    return new Promise((resolve, reject) => {
        // Checked before the reader, because the reader will happily pull 10 MB into a data
        // URL and the decode below will then run for a second and a half before failing on a
        // file that was never going to be usable. `size` is metadata the browser already has,
        // so this costs nothing. The message names the real limit and says what it means in
        // the units people check in their file manager, because "too large" alone makes a
        // user re-pick the same photo twice.
        if (file.size > PROFILE_AVATAR_MAX_SOURCE_BYTES) {
            const limitMb = Math.round(PROFILE_AVATAR_MAX_SOURCE_BYTES / (1024 * 1024));
            const actualMb = (file.size / (1024 * 1024)).toFixed(1);
            reject(new Error(`That photo is ${actualMb} MB, and the limit is ${limitMb} MB. `
                + 'Most phones can make a smaller one: in Photos, use Share and choose '
                + 'Save a Copy or Compress, or take a screenshot of it.'));
            return;
        }

        // HEIC is what an iPhone camera produces and most desktops cannot decode. It is
        // checked before anything else so the message can say what to do about it, rather
        // than surfacing as a generic "that file is not an image we can use" after a decode
        // attempt that was never going to work. Safari can open HEIC, so the image path is
        // still attempted -- this is a hint, not a refusal.
        const isHeic = /image\/(heic|heif)/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('That file could not be read.'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error(isHeic
                ? 'That looks like a HEIC photo, which this browser cannot open. In Photos, choose Export and pick JPEG, or take the screenshot.'
                : 'That file is not an image this browser can open.'));
            image.onload = () => {
                try {
                    const size = PROFILE_AVATAR_SIZE;
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        reject(new Error('This browser cannot prepare the picture.'));
                        return;
                    }
                    // Centre crop: the longest edge fills the square and the overflow is
                    // trimmed equally from both sides, so a wide photo is not squashed into
                    // a circle by being stretched to fit.
                    const scale = Math.max(size / image.width, size / image.height);
                    const width = image.width * scale;
                    const height = image.height * scale;
                    context.drawImage(
                        image,
                        (size - width) / 2,
                        (size - height) / 2,
                        width,
                        height
                    );
                    // Always PNG, whatever came in. The browser has already decoded the
                    // original, so this normalises every accepted format to one the server
                    // can verify from its first eight bytes -- and a 1x1 or 0x0 image is
                    // refused here rather than being stored as a blank square.
                    if (image.width < 1 || image.height < 1) {
                        reject(new Error('That image is too small to use.'));
                        return;
                    }
                    resolve(canvas.toDataURL('image/png'));
                } catch {
                    reject(new Error('That file could not be prepared.'));
                }
            };
            image.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}

/**
 * Saves whichever of the two fields the user actually changed.
 *
 * Only the changed fields are sent. A request carrying both would need the client to know
 * the current value of the one it is not changing, and reading it first is a race between
 * two open tabs -- so a name change in one tab and a picture change in the other would
 * lose one of them. Sending just the edits makes each save mean exactly what it says.
 */
async function saveProfile() {
    if (!getSessionToken() || profileState.saving || !profileState.dirty) return;

    const patch = {};
    if (profileState.displayName !== profileState.saved.displayName) {
        patch.displayName = profileState.displayName;
    }
    if (profileState.avatarData !== profileState.saved.avatarData) {
        patch.avatarData = profileState.avatarData;
    }
    if (Object.keys(patch).length === 0) return;

    profileState.saving = true;
    renderProfileEditor();

    try {
        const result = await requestJson('/api/user/profile', {
            method: 'PATCH',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(patch)
        });
        // What the server stored, not what was submitted. A name is trimmed and its spacing
        // collapsed there, and reporting the submitted value would show the user a name
        // that is not the one on their account.
        profileState.displayName = result.displayName || '';
        profileState.avatarData = result.avatarData || null;
        // The save response carries the whole resource, so the identity is refreshed from
        // the same answer rather than left over from a read that is now stale.
        if (result.email) profileState.email = result.email;
        if (result.id) profileState.accountId = result.id;
        profileState.saved = { displayName: profileState.displayName, avatarData: profileState.avatarData };
        profileState.saving = false;
        profileState.loaded = true;

        const nameInput = document.getElementById('profile-display-name');
        if (nameInput) nameInput.value = profileState.displayName;
        updateProfileDirty();
        showToast('Profile saved', 'Your name and picture are updated on this account.');
    } catch (error) {
        profileState.saving = false;
        renderProfileEditor();
        if (handleUnauthorized(error)) return;
        const status = document.getElementById('profile-status');
        if (status) {
            status.textContent = error.message || 'Could not save your profile.';
            status.classList.add('is-error');
        }
        // Re-read rather than trusting the form: the value that failed may be one the
        // server rejected for a reason the form never applied, and leaving it in place
        // invites the user to press the same button again.
        await loadProfile();
    }
}

function handleAccountButton() {
    if (getSessionToken()) {
        // The explicit choice to sign out, so it also leaves a page that needs a session --
        // see `signOut`. An expired session is different: the visitor did not choose that,
        // and is sent to sign in again instead of to the front page.
        signOut({ leave: true });
        setFormMessage('account-message', '');
        return;
    }
    // On a page that is already the sign-in page, the dialog is right there. On any other
    // page -- the home page, which is the one place a signed-out visitor can still be -- the
    // dialog does not exist, so "Connect account" would have been a button that silently did
    // nothing. It goes to the sign-in page instead, carrying this page along so the visitor
    // lands back on it afterwards.
    if (!document.getElementById('account-dialog') && window.RewardZoneSession) {
        window.RewardZoneSession.goToLogin(window.RewardZoneSession.currentReturnPath());
        return;
    }
    const email = document.getElementById('account-email');
    const password = document.getElementById('account-password');
    if (email) email.value = '';
    if (password) password.value = '';
    setFormMessage('account-message', '');
    setAuthMode('login');
    const dialog = document.getElementById('account-dialog');
    if (dialog) dialog.showModal();
}

/**
 * "Change password" on the account page.
 *
 * There is no password form for a signed-in user, and building one would mean deciding what
 * proof it needs (current password? a fresh emailed token?) and how it interacts with
 * `token_version`. The flow that already exists, and that the card's own copy describes, is
 * the emailed reset: `forgotPassword` issues a single-use token and the link in the message
 * sets the new password. So the button opens the account dialog already in its `forgot` mode,
 * rather than a dialog that looks like it will change the password and cannot.
 *
 * Note this does not sign the visitor out. The reset link lands them on `/reset-password`,
 * which is a separate page and completes on its own.
 */
function openPasswordReset() {
    setFormMessage('account-message', '');
    setAuthMode('forgot');
    const dialog = document.getElementById('account-dialog');
    if (dialog) dialog.showModal();
    document.getElementById('account-email')?.focus();
}

function setAuthMode(mode) {
    const register = mode === 'register';
    const forgot = mode === 'forgot';
    const form = document.getElementById('account-form');
    const title = document.getElementById('account-title');
    const submit = document.getElementById('connect-submit');
    const password = document.getElementById('account-password');
    const passwordLabel = document.getElementById('account-password-label');

    if (!form || !title || !submit) return;

    form.dataset.authMode = forgot ? 'forgot' : register ? 'register' : 'login';
    title.textContent = forgot ? 'Reset your password' : register ? 'Create your account' : 'Welcome back';
    submit.textContent = forgot ? 'Email me a reset link' : register ? 'Create account' : 'Sign in';

    // The password row is hidden during a reset. The `hidden` attribute is enough
    // because the stylesheet forces `[hidden]` to win over component display rules.
    if (passwordLabel) passwordLabel.hidden = forgot;
    if (password) {
        password.hidden = forgot;
        password.required = !forgot;
        password.autocomplete = register ? 'new-password' : 'current-password';
        password.minLength = register ? 12 : 1;
    }
    const passwordHint = document.getElementById('password-hint');
    if (passwordHint) passwordHint.hidden = !register;
    const forgotLink = document.getElementById('forgot-password-link');
    if (forgotLink) forgotLink.hidden = register || forgot;

    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
        const selected = button.dataset.authMode === form.dataset.authMode;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', String(selected));
    });

    // Leaving the confirmation screen by switching mode, so the credentials are never
    // sitting behind a code box that has been dismissed.
    hideVerifyStep();
}

/**
 * Shows the confirmation screen and hides the credentials.
 *
 * A separate screen because after submitting there is nothing left to correct -- the only
 * remaining action is typing the code that was emailed. Leaving the fields visible would
 * invite edits that no longer do anything, which reads as a broken form.
 */
function showVerifyStep(email, expiresInMinutes) {
    const step = document.getElementById('verify-step');
    const form = document.getElementById('account-form');
    if (!step || !form) return;

    const verifyEmail = document.getElementById('verify-email');
    if (verifyEmail) verifyEmail.textContent = email;
    const verifyExpiry = document.getElementById('verify-expiry');
    if (verifyExpiry) verifyExpiry.textContent = expiresInMinutes
        ? `It expires in ${expiresInMinutes} minutes.`
        : '';

    // The email is remembered because confirming needs it and the field is about to be
    // hidden. Reading it back from the field would be a hidden dependency on a value the
    // user can no longer see or correct.
    form.dataset.verifyEmail = email;

    setFormMessage('verify-message', '');
    const verifyCode = document.getElementById('verify-code');
    if (verifyCode) verifyCode.value = '';
    const verifySubmit = document.getElementById('verify-submit');
    if (verifySubmit) verifySubmit.disabled = false;
    const verifyResend = document.getElementById('verify-resend');
    if (verifyResend) verifyResend.disabled = false;

    for (const id of ['account-email', 'account-password', 'account-password-label',
        'password-hint', 'connect-submit', 'forgot-password-link', 'account-message']) {
        const element = document.getElementById(id);
        if (element) element.hidden = true;
    }
    document.querySelector('.auth-mode')?.setAttribute('hidden', '');

    step.hidden = false;
    if (verifyCode) verifyCode.focus();
}

function hideVerifyStep() {
    const step = document.getElementById('verify-step');
    if (!step || step.hidden) return;
    step.hidden = true;
    for (const id of ['account-email', 'account-password', 'account-password-label',
        'password-hint', 'connect-submit', 'forgot-password-link', 'account-message']) {
        const element = document.getElementById(id);
        if (element) element.hidden = false;
    }
    const tabs = document.querySelector('.auth-mode');
    if (tabs) tabs.removeAttribute('hidden');
    const form = document.getElementById('account-form');
    if (form) form.dataset.verifyEmail = '';
}

/**
 * Confirms the address and signs the account in.
 *
 * The session comes from this call, not from registration, so the balance shown afterwards is
 * read from a server that has already accepted the address.
 */
async function submitVerification() {
    const form = document.getElementById('account-form');
    const emailEl = document.getElementById('account-email');
    const verifyCode = document.getElementById('verify-code');
    const button = document.getElementById('verify-submit');
    if (!button || !form || !verifyCode) return;

    const email = form.dataset.verifyEmail || (emailEl ? emailEl.value.trim() : '');
    const code = verifyCode.value.trim();

    if (!/^\d{6}$/.test(code)) {
        setFormMessage('verify-message', 'Enter the 6-digit code from your email.', 'error');
        return;
    }

    button.disabled = true;
    button.textContent = 'Confirming...';
    setFormMessage('verify-message', '');

    try {
        const data = await requestJson('/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code })
        });
        completeSignIn(data);
    } catch (error) {
        setFormMessage('verify-message', error.message, 'error');
        button.disabled = false;
        button.textContent = 'Confirm email';
        // The field is cleared and refocused: a rejected code should not sit there being
        // retyped character by character, and the next one may have come from a new email.
        verifyCode.value = '';
        verifyCode.focus();
    }
}

/** Asks for another code. The address is shown, so a wrong entry is corrected here. */
async function resendVerificationCode() {
    const form = document.getElementById('account-form');
    const emailEl = document.getElementById('account-email');
    const button = document.getElementById('verify-resend');
    if (!button || !form) return;

    const email = form.dataset.verifyEmail || (emailEl ? emailEl.value.trim() : '');

    button.disabled = true;
    setFormMessage('verify-message', '');

    try {
        const data = await requestJson('/api/auth/resend-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        setFormMessage('verify-message', data.message || 'If that address needs confirming, a new code is on its way.', 'success');
    } catch (error) {
        setFormMessage('verify-message', error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

/**
 * Sends a magic link to the email shown on the confirm screen.
 *
 * The user has already proven they own the password (they just typed it on
 * register or login), so no additional identity check is needed before sending
 * the link. The link is single-use and expires in 15 minutes.
 */
async function sendMagicLink() {
    const form = document.getElementById('account-form');
    const emailEl = document.getElementById('account-email');
    const button = document.getElementById('verify-magic-link');
    const messageBox = document.getElementById('verify-message');
    if (!button || !form) return;

    const email = form.dataset.verifyEmail || (emailEl ? emailEl.value.trim() : '');

    button.disabled = true;
    button.textContent = 'Sending magic link...';
    setFormMessage('verify-message', '');

    try {
        const data = await requestJson('/api/auth/magic-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        setFormMessage('verify-message', data.message || 'If an unconfirmed account exists for that email, a magic link is on its way.', 'success');
        pushNotification({
            title: 'Magic link sent',
            message: 'Check your email for a sign-in link.',
            tone: 'success',
            category: 'magic'
        });
        button.textContent = 'Magic link sent';
        setTimeout(() => {
            button.disabled = false;
            button.textContent = 'Resend magic link';
        }, 2000);
    } catch (error) {
        setFormMessage('verify-message', error.message, 'error');
        button.disabled = false;
        button.textContent = 'Send me a magic link instead';
    }
}

/**
 * Checks the URL fragment for a magic link token and exchanges it for a session
 * if one is present. The fragment is removed from the URL before the exchange
 * so it never lands in browser history or gets copied by the user.
 */
function checkMagicLinkReturn() {
    // The token is looked for in the fragment first and in the return path second, because
    // a magic link is an email addressed to someone who is not signed in yet. The gate
    // therefore intercepted it on the way to the sign-in page, and carried the fragment
    // along inside `next` rather than leaving it in the address bar -- reading only the
    // fragment made every magic link a dead link the moment a page became private.
    let fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (!fragment) {
        const pending = new URLSearchParams(window.location.search).get('next');
        const hashIndex = typeof pending === 'string' ? pending.indexOf('#') : -1;
        if (hashIndex !== -1) fragment = pending.slice(hashIndex + 1);
    }
    if (!fragment) return;
    const params = new URLSearchParams(fragment);
    const token = params.get('magic');
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) return;

    // Remove the fragment from the address bar immediately, before any navigation, and drop
    // the return path with it: the token has been used to sign in, so the page it was
    // addressed to is no longer somewhere the visitor needs sending back to.
    window.history.replaceState(null, '', window.location.pathname);
    window.location.hash = '';
    magicLinkPending = true;

    exchangeMagicLink(token);
}

/** Exchanges a magic link token for a session, then signs the user in. */
async function exchangeMagicLink(token) {
    try {
        const data = await requestJson('/api/auth/magic-link/consume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        pushNotification({
            title: 'Signed in',
            message: 'You are signed in via magic link.',
            tone: 'success'
        });
        completeSignIn(data);
    } catch (error) {
        // The link did not work. The visitor is standing on the sign-in page with no way
        // forward unless the form is in front of them, which is the only thing that turns a
        // dead link into a way to sign in.
        magicLinkPending = false;
        showToast('Magic link failed', error.message || 'Could not sign in with that link.', { tone: 'error' });
        const dialog = document.getElementById('account-dialog');
        if (dialog && !dialog.open) {
            setFormMessage('account-message', 'That link did not work. Sign in with your password, or ask for a new one.');
            setAuthMode('login');
            dialog.showModal();
        }
    }
}

/** Everything that has to happen once a session exists, for either sign-in route. */
function completeSignIn(data) {
    // The token is checked before it is stored, not after.
    //
    // `setItem(key, undefined)` does not throw and does not store `undefined` -- it stores the
    // string "undefined". So a sign-in response that was not the expected shape, which any
    // 200-with-an-error-body from a proxy or a renamed API field will produce, put a non-token
    // into the session slot. Everything downstream then believed it was signed in and sent
    // `Bearer undefined`, and the server logged a `jwt malformed` rejection for every request
    // from then on, including one per live-sync poll.
    //
    // A response without a usable token is a failed sign-in, so it is treated as one: nothing
    // is written, whatever was there before is cleared, and the caller is told. `getSessionToken`
    // is the same test applied on the way out, which covers slots poisoned by an older build
    // that this one can never repair.
    // `data.token`, not `data`.
    //
    // `getSessionTokenFrom` takes the string. Handed the response object it sees a non-string
    // and returns null, so *every* successful sign-in took the branch below and threw "Sign in
    // did not return a session" with a perfectly good token sitting in the response. The check
    // was added to stop `setItem(key, undefined)` storing the string "undefined", and it did --
    // by refusing every session, which is a worse version of the same fault.
    if (!getSessionTokenFrom(data.token)) {
        try {
            sessionStorage.removeItem(accountTokenKey);
            sessionStorage.removeItem(accountEmailKey);
        } catch {
            // Storage unavailable; there is nothing to clear and nothing was written.
        }
        throw new Error('Sign-in did not return a session. Please try again.');
    }

    sessionStorage.setItem(accountTokenKey, data.token);
    if (data.user?.email) sessionStorage.setItem(accountEmailKey, data.user.email);

    // Where the visitor was sent from. Read before anything else, because the session now
    // exists and the gate would let them stay on this page either way -- the sign-in would
    // "work" and leave them looking at a sign-in page they had already satisfied, which is
    // the same dead end as a gate that never returns anyone.
    //
    // On the sign-in page there is a destination even when the visitor did not name one: it
    // is a page with nothing on it but the form, so staying put would leave a signed-in
    // person staring at a sign-in form. The account page is where "connect account" means
    // they are trying to end up. Everywhere else -- the header button on a public page, or
    // the dialog over a page they were already on -- no destination was named and the right
    // answer is to stay where they are, because the page behind the form is the one they
    // were already using.
    const onward = window.RewardZoneSession
        ? (window.RewardZoneSession.consumeReturnTo()
            || (window.RewardZoneSession.isLoginPath() ? '/account' : null))
        : null;
    if (onward) {
        window.location.replace(onward);
        return;
    }

    applyBalance(data.user.balance, data.user.demoBalance);
    // The bar and the header have to agree the moment a session exists, because the
    // header controls were disabled for a signed-out visitor and the mirrored ones were
    // disabled to match. `syncAccountControls` is what lifts both, and it also enables
    // the live sync's indicator for the first time.
    syncAccountControls();
    paintLiveIndicator();
    loadEmailPreference();
    loadProfile();
    syncNow();

    hideVerifyStep();
    const dialog = document.getElementById('account-dialog');
    if (dialog) dialog.close();
    const password = document.getElementById('account-password');
    if (password) password.value = '';
    // A deposit created before sign-in would have been blocked, so a fresh catalog
    // read is enough; no history needs reloading here.
}

async function connectAccount(event) {
    event.preventDefault();
    const emailEl = document.getElementById('account-email');
    const passwordEl = document.getElementById('account-password');
    const button = document.getElementById('connect-submit');
    const form = document.getElementById('account-form');
    if (!button || !form) return;

    const email = emailEl ? emailEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';
    const mode = form.dataset.authMode || 'login';

    button.disabled = true;
    button.textContent = mode === 'register' ? 'Creating...' : mode === 'forgot' ? 'Sending...' : 'Signing in...';
    setFormMessage('account-message', '');

    try {
        if (mode === 'forgot') {
            const data = await requestJson('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            setFormMessage('account-message', data.message, 'success');
            showToast('Reset link sent', data.message || 'Check your email for a password reset link.', { tone: 'success' });
            return;
        }

        const data = await requestJson(`/api/auth/${mode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        // Both routes can stop here and ask for a code instead of returning a session.
        //
        // Registration always does, because the address has not been proven. Login does it
        // for an account created before verification existed, or one whose confirmation was
        // never finished -- arriving at the same screen from either direction means the
        // recovery is one place, not two.
        if (data.requiresVerification) {
            showVerifyStep(data.email || email, data.expiresInMinutes);
            return;
        }

        completeSignIn(data);
    } catch (error) {
        // `login` refuses an unconfirmed account with 403 rather than 200, so for that case
        // the code screen is reached from the failure path and not the success one. Without
        // this, someone signing in to an account that predates verification -- or one whose
        // confirmation was never finished -- would be told to confirm their address and then
        // given no way to type the code.
        if (error.payload?.requiresVerification) {
            showVerifyStep(error.payload.email || email, undefined);
            return;
        }
        setFormMessage('account-message', error.message, 'error');
    } finally {
        button.disabled = false;
        button.textContent = mode === 'forgot'
            ? 'Email me a reset link'
            : mode === 'register' ? 'Create account' : 'Sign in';
    }
}

function applyBalance(balance, demoBalance) {
    const userBalance = document.getElementById('user-balance');
    if (userBalance) userBalance.textContent = formatBalance(balance);
    const demoBalanceEl = document.getElementById('demo-balance');
    if (demoBalanceEl) demoBalanceEl.textContent = formatBalance(demoBalance);

    // The account page shows the same two figures a second time, in the balance card, under
    // their own ids. Every write to the header pair has to be mirrored here or the account
    // page shows `--` forever even with a live session, which is what it did.
    const accountBalance = document.getElementById('account-balance-main');
    if (accountBalance) accountBalance.textContent = formatBalance(balance);
    const accountDemoBalanceEl = document.getElementById('account-demo-balance');
    if (accountDemoBalanceEl) accountDemoBalanceEl.textContent = formatBalance(demoBalance);

    const previous = accountState.balance;
    accountState.balance = Number(balance);
    // Seed the live-sync baseline so reward detection works from the first poll,
    // not the second one. Only set when NaN so a live update does not clobber
    // the tracked previous balance before the delta comparison runs.
    if (!Number.isFinite(liveState.lastKnownBalance)) liveState.lastKnownBalance = Number(balance);
    if (!Number.isFinite(liveState.lastKnownDemoBalance)) liveState.lastKnownDemoBalance = Number(demoBalance ?? 0);
    syncWithdrawBalance();

    // After the write, so the flash runs off the new figure, and only when the number really
    // moved -- `previous` is NaN on the first load, which is a first figure rather than a
    // change, and is not something to announce.
    noteBalanceChange(previous, accountState.balance);
    paintBalanceFreshness();
}

async function refreshBalance() {
    const token = getSessionToken();
    if (!token) return;

    try {
        const data = await requestJson('/api/user/balance', {
            headers: { Authorization: `Bearer ${token}` }
        });
        applyBalance(data.balance, data.demoBalance);
    } catch (error) {
        if (handleUnauthorized(error)) return;
        showPageMessage(error.message);
    }
}

/** Shows the withdrawable balance and keeps the "withdraw all" button honest. */
function syncWithdrawBalance() {
    const balance = accountState.balance;
    const available = document.getElementById('withdraw-available');
    const button = document.getElementById('withdraw-max');
    if (!available || !button) return;

    if (!Number.isFinite(balance)) {
        available.textContent = '--';
        button.disabled = true;
    } else {
        available.textContent = formatBalance(balance);
        // Nothing to withdraw, or not enough to clear the provider's floor.
        const minimum = withdrawState.options?.minimumUsd ?? 0;
        button.disabled = balance < minimum || balance <= 0;
    }

    const amount = document.getElementById('withdraw-amount');
    // The balance is the real ceiling; the provider's cap applies on top of it. Whichever
    // is lower is what the box will actually accept, so it is the one shown as max. Bounded
    // from the provider's cap alone when the balance is still unknown, so a failed balance
    // request cannot leave the input with no upper limit at all.
    const providerMaximum = withdrawState.options?.maximumUsd;
    const ceiling = Number.isFinite(providerMaximum)
        ? (Number.isFinite(balance) ? Math.min(balance, providerMaximum) : providerMaximum)
        : balance;
    if (Number.isFinite(ceiling)) amount.max = String(ceiling);
    updateWithdrawAmountHint();
}

/** States the range that actually applies, including what is left in the balance. */
function updateWithdrawAmountHint() {
    const options = withdrawState.options;
    if (!options) return;
    const balance = accountState.balance;
    const providerMaximum = options.maximumUsd;
    const ceiling = Number.isFinite(balance) ? Math.min(balance, providerMaximum) : providerMaximum;

    const parts = [`Minimum ${formatBalance(options.minimumUsd)}`];
    if (Number.isFinite(providerMaximum)) {
        // A balance below the provider's own cap is the limit that actually bites, so
        // saying "maximum $5,000" to someone holding $12 would just be misleading.
        parts.push(Number.isFinite(balance) && balance < providerMaximum
            ? `Maximum ${formatBalance(ceiling)}, your available balance`
            : `Maximum ${formatBalance(providerMaximum)}`);
    }
    setHint('withdraw-amount-hint', `${parts.join('. ')}.`);

    // When the provider refused to report its per-network floors, that $1.00 is this app's own
    // rule and not something the provider has agreed to accept. A crypto request under the
    // provider's real floor would then be refused after the user committed to it, so the
    // unconfirmed state is stated next to the number rather than left to be discovered.
    const notice = document.getElementById('withdraw-minimum-unconfirmed');
    if (!notice) return;
    const confirmed = options.limitsSource?.minimumsConfirmed;
    const relevant = withdrawState.method === 'crypto' && confirmed === false;
    notice.hidden = !relevant;
    if (relevant) {
        notice.textContent = 'This is our own minimum. Crypto payouts are normally limited to a ' +
            'higher amount by the payment provider, and we cannot read that limit right now, so ' +
            'a small crypto request may be refused.';
    }
}

/* --------------------------------------------------------------- deposits */

/**
 * Runs the money action a hash asks for, once, on arrival.
 *
 * The header's account menu is on every page but the money dialogs are not, so a page without
 * them sends the visitor here to run the action (`openDeposits` and `openWithdrawal`). Landing
 * on the account page with the dialog still shut would ask for one more tap to finish what the
 * button they pressed already said, so the hash carries which one it was.
 *
 * The hash is dropped with `replaceState` before the dialog opens, so a refresh reopens the
 * page rather than the dialog, and the browser's back button still goes back where it came
 * from. A hash that is not one of these two is left alone: `#profile-settings` and `#history`
 * are real anchors on this page and the browser handles them.
 */
function openMoneyActionFromHash() {
    const action = window.location.hash.slice(1);
    if (action !== 'add-funds' && action !== 'withdraw') return;
    if (!getSessionToken()) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (action === 'add-funds') openDeposits();
    else openWithdrawal();
}

function openDeposits() {
    if (!getSessionToken()) {
        const dialog = document.getElementById('account-dialog');
        if (dialog) dialog.showModal();
        return;
    }
    // The deposit dialog lives on the account and offers pages, and the header's account menu
    // is on every page -- including the home page, which has the menu and not the dialog. The
    // menu item was therefore a control that closed the menu and did nothing at all, which
    // reads as a broken app rather than as a missing feature. A page without the dialog is sent
    // to the account page, which has it, rather than swallowing the tap.
    const depositDialog = document.getElementById('deposit-dialog');
    if (!depositDialog) {
        window.location.assign('/account#add-funds');
        return;
    }
    // The same reset a repeat deposit uses, so reopening the dialog after a completed
    // deposit does not leave the instructions hidden, the submit button stuck on
    // "Generating address...", and the previous countdown still ticking against a
    // deposit the user can no longer see.
    resetDepositForAnother();
    depositDialog.showModal();
    loadDepositOptions();
    loadDepositHistory();
}

/**
 * Brings the amount back inside the range of the newly selected coin.
 *
 * Switching coins changes the range, and the value in the box does not change with it.
 * A $10 entry left in place after moving to a coin with a $25 floor is an amount the
 * server will refuse, and the only warning is a rejection after submitting. The value is
 * moved rather than merely bounded, because a box whose contents violate its own `min`
 * is one the browser will not let the user submit.
 */
function clampDepositAmountToRange() {
    const input = document.getElementById('deposit-amount');
    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();
    if (!input) return;
    const current = Number(input.value);
    if (!Number.isFinite(current)) return;
    if (current >= minimum && current <= maximum) return;
    const corrected = current < minimum ? minimum : maximum;
    input.value = corrected.toFixed(2);
    if (current < minimum) {
        setFormMessage('deposit-message', `Raised to ${formatBalance(corrected)}, the lowest this app accepts.`);
    } else {
        setFormMessage('deposit-message', `Reduced to ${formatBalance(corrected)}, the most this app accepts.`);
    }
}

/**
 * The floor the amount box itself enforces.
 *
 * For crypto this is only a guard against a blank or negative field: the provider is the only
 * party that knows what it will accept, its figure moves between reads, and hard-coding it here
 * made the form jump to a number the user never typed. Card deposits keep the app's $1.00,
 * which is a real network/processing floor rather than a guess.
 */
function minimumForSelectedCurrency() {
    if (depositState.method === 'crypto') return 0.01;
    const appMinimum = depositState.options?.appMinimumUsd;
    return Number.isFinite(appMinimum) && appMinimum > 0 ? appMinimum : 1;
}

/**
 * The provider's real ceiling for the selected coin.
 *
 * The ceiling is per-currency, not global: a coin the provider caps at $900 must not be
 * offered the app-wide $5,000, because that deposit is refused at payment creation, after
 * the customer has committed to it. Falls back to the picker-level maximum, which is
 * itself the largest per-currency ceiling, so narrowing can only reduce the range.
 */
function maximumForSelectedCurrency() {
    const options = depositState.options;
    if (!options) return 5000;
    if (depositState.method !== 'crypto') return options.maximumUsd;
    const currency = document.getElementById('deposit-currency')?.value;
    const perCurrency = options.maximums?.[currency];
    return Number.isFinite(perCurrency) && perCurrency > 0 ? perCurrency : options.maximumUsd;
}

/**
 * States the bounds the form actually applies.
 *
 * For crypto that is deliberately not a provider figure. The provider's quoted minimum moves
 * between reads and is different per coin, so putting it here made the one number a user reads
 * before typing disagree with the one that decides acceptance -- and made a small deposit look
 * like it should work and then fail. The provider is asked instead, and the server translates a
 * real refusal into a sentence with a number in it.
 */
function updateDepositAmountHint() {
    const hint = document.getElementById('deposit-amount-hint');
    if (!hint) return;
    const options = depositState.options;
    if (!options) return;

    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();

    hint.textContent = depositState.method === 'crypto'
        ? `No minimum set by us. Maximum ${formatBalance(maximum)}.`
        : `Minimum ${formatBalance(minimum)}. Maximum ${formatBalance(maximum)}.`;
    validateDepositAmount();
}

/**
 * The one place the deposit button is turned back on.
 *
 * It is never turned off for the amount. The provider's quoted minimum is an advisory figure
 * that moves between reads, and gating submission on it made deposits impossible to create for
 * amounts the provider would in fact have taken: the form simply refused to submit, with no
 * way for the user to find out why. The provider is asked instead, and the server's
 * `isProviderMinimumRefusal` path turns a real refusal into a message with a number in it.
 *
 * What remains here is the genuinely blocking case -- no payment method available at all, or a
 * chosen coin that is disabled. No amount fixes those, and a live button that goes nowhere is
 * worse than a dead one.
 */
function setDepositSubmitEnabled() {
    const submit = document.getElementById('deposit-submit');
    if (submit) submit.disabled = Boolean(depositBlockedForAvailability());
}

/**
 * Whether a deposit cannot be created at all right now, as opposed to merely being risky.
 *
 * Split from the amount so the option-painting and the end-of-submission paths can ask this
 * without also asking the floor question, which no longer gates anything.
 */
function depositBlockedForAvailability() {
    const chosen = depositState.options?.currencies?.find((c) => c.code === depositState.currency);
    if (chosen?.disabled) return true;
    const options = depositState.options;
    return !(options?.stripeAvailable || options?.cryptoAvailable);
}

/**
 * Keeps the amount hint in a neutral state.
 *
 * Nothing is annotated and nothing is blocked here. The provider's quoted minimum is advisory,
 * it moves between reads, and gating on it stopped deposits that would otherwise have been
 * created -- so a user who is under it presses the button and finds out for real, from the
 * server's translated refusal.
 */
function validateDepositAmount() {
    const hint = document.getElementById('deposit-amount-hint');
    if (hint) hint.classList.remove('is-error');
}

/**
 * States the floor for the coin currently chosen, so it stays on screen after the menu closes.
 *
 * The option labels read "from $X", which makes the choice informed before it is made but
 * leaves the number behind once it is made. This app does not impose a crypto minimum of its
 * own, so what it can honestly say here is that the provider decides -- not a figure that moves
 * between reads and would then contradict what the amount box accepts.
 */
function updateCoinSummary() {
    const summary = document.getElementById('deposit-coin-summary');
    if (!summary) return;

    const select = document.getElementById('deposit-currency');
    const code = select?.value;
    if (!code) {
        summary.hidden = true;
        summary.replaceChildren();
        return;
    }

    const name = cryptoCurrencyNames[code] || code.toUpperCase();

    const amount = document.createElement('strong');
    amount.className = 'coin-summary-amount';
    amount.textContent = 'any amount';

    // One line, not a paragraph. This sits between the coin picker and the button, so every
    // sentence it does not need is a line the user scrolls past to reach the action.
    summary.replaceChildren(
        document.createTextNode('Our minimum is '),
        amount,
        document.createTextNode(
            ` for ${name}. The payment provider may still set a minimum for this network.`
        )
    );
    summary.hidden = false;
}

async function loadDepositOptions() {
    const submit = document.getElementById('deposit-submit');
    const title = document.getElementById('deposit-provider-title');
    const copy = document.getElementById('deposit-provider-copy');
    const notice = document.getElementById('provider-notice');
    const providerFinePrint = document.getElementById('deposit-provider-fine-print');
    if (submit) submit.disabled = true;
    if (notice) notice.classList.remove('is-ready', 'is-offline', 'is-compact');
    // The fine print belongs to the "ready" state only, so it is cleared with the rest of
    // the notice rather than being left behind if a later load reports an outage.
    if (providerFinePrint) providerFinePrint.hidden = true;
    if (title) title.textContent = 'Checking payment providers';
    if (copy) copy.textContent = 'Contacting the configured payment services...';

    try {
        const options = await requestJson('/api/user/payment-options', {
            headers: authHeaders()
        });
        depositState.options = options;

        const stripeButton = document.querySelector('[data-deposit-method="stripe"]');
        const cryptoButton = document.querySelector('[data-deposit-method="crypto"]');
        if (stripeButton) stripeButton.disabled = !options.stripeAvailable;
        if (cryptoButton) cryptoButton.disabled = !options.cryptoAvailable;
        // A greyed-out card with no explanation is a dead end: the only way to find out why
        // Card is unavailable was to guess. The reason is stated on the card itself, so the
        // answer is where the question is asked -- and it distinguishes the two reasons that
        // look identical from here. "Not configured" means nobody set the keys up. "Temporarily
        // unavailable" means they are set and Stripe itself is refusing charges, which is
        // retried and recovers on its own, and it is worth telling the customer to try cards
        // again later rather than writing the feature off.
        describeDepositMethod(stripeButton, options.stripeAvailable
            ? 'Visa, Mastercard, Apple Pay'
            : unavailableDescriptor(options.stripeUnavailableBecause));
        const cryptoAvailableText = Array.isArray(options.cryptoCurrencies)
            ? `${options.cryptoCurrencies.length} ${options.cryptoCurrencies.length === 1 ? 'coin' : 'coins'} available`
            : 'Not configured on this deployment';
        describeDepositMethod(cryptoButton, options.cryptoAvailable
            ? cryptoAvailableText
            : 'Not configured on this deployment');

        // `depositState.method` defaults to `crypto`, so a deployment with no card provider
        // opened on a method that could not work, with a greyed-out card beside it and no
        // reason the selection had moved. Anything that cannot be chosen is not a choice:
        // if the current selection is unavailable and the other one is not, the selection
        // follows what is actually configured.
        const availableMethods = [
            options.stripeAvailable ? 'stripe' : null,
            options.cryptoAvailable ? 'crypto' : null
        ].filter(Boolean);
        if (availableMethods.length > 0 && !availableMethods.includes(depositState.method)) {
            depositState.method = availableMethods[0];
        }

        const currencySelect = document.getElementById('deposit-currency');
        if (currencySelect && Array.isArray(options.cryptoCurrencies)) {
            const previous = currencySelect.value;
            currencySelect.replaceChildren(...options.cryptoCurrencies.map((currency) => {
                const option = document.createElement('option');
                option.value = currency;
                // The provider's own floor is shown in the list itself, phrased as a starting
                // point rather than a hard limit, because that is what it is: NOWPayments will
                // refuse a smaller payment, but this app adds no floor of its own and lets the
                // submission through so the provider can actually be asked.
                // Putting the figure here means it is known *before* the coin is chosen, instead
                // of only after, when a sub-minimum amount is already in the box.
                const name = cryptoCurrencyNames[currency] || currency.toUpperCase();
                const minimum = options.minimums?.[currency];
                const maximum = options.maximums?.[currency];
                const range = [];
                if (Number.isFinite(minimum) && minimum > 0) range.push(`from ${formatBalance(minimum)}`);
                if (Number.isFinite(maximum) && maximum > 0) range.push(`up to ${formatBalance(maximum)}`);
                option.textContent = range.length ? `${name} (${range.join(', ')})` : name;
                return option;
            }));
            if (options.cryptoCurrencies.includes(previous)) {
                currencySelect.value = previous;
            } else {
                // Open on the coin the provider will accept the least of. The app no longer
                // imposes a minimum, so this is purely about a good first impression: taking
                // the provider's order made the first thing a depositor met a coin with a floor
                // near $18.80, which reads as "nothing small is possible here".
                const cheapest = [...options.cryptoCurrencies].sort((a, b) => {
                    const floor = (code) => {
                        const value = Number(options.minimums?.[code]);
                        return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
                    };
                    return floor(a) - floor(b);
                })[0];
                if (cheapest) currencySelect.value = cheapest;
            }
        }

        const amount = document.getElementById('deposit-amount');
        if (amount) {
            amount.min = String(minimumForSelectedCurrency());
            amount.max = String(maximumForSelectedCurrency());
            // The default 10.00 can sit outside the first coin's range, which would leave the
            // form un-submittable on open with no visible reason why.
            clampDepositAmountToRange();
        }
        updateDepositAmountHint();
        updateCoinSummary();
        syncDepositPresets();

        // Repaint after the method may have moved. The selection is settled above, before the
        // coin list and the amount bounds are read, because both of those depend on it -- the
        // old fallback sat after them, so the bounds were computed for a method the user was
        // no longer on, and it never repainted the buttons, leaving the active highlight on
        // the card that had just been ruled out.
        updateDepositFields();

        if (options.stripeAvailable || options.cryptoAvailable) {
            if (notice) notice.classList.add('is-ready', 'is-compact');
            const available = [
                options.stripeAvailable ? 'card' : null,
                options.cryptoAvailable ? 'crypto' : null
            ].filter(Boolean).join(' and ');
            if (title) title.textContent = 'Provider available';
            // Once a provider answers, the long explanation is noise between the user and
            // the form. The reassurance that credit waits for confirmation is kept, because
            // it is the one sentence a first-time depositor actually needs; the rest of the
            // wording is moved into the fine print under the form so nothing is lost.
            if (copy) copy.textContent = `Pay by ${available}.`;
            if (providerFinePrint) {
                providerFinePrint.textContent = 'Your balance is credited only after the provider confirms the payment.';
                providerFinePrint.hidden = false;
            }
        } else {
            if (notice) notice.classList.add('is-offline');
            if (title) title.textContent = 'Payment providers are not configured';
            if (copy) copy.textContent = 'Set Stripe or NOWPayments credentials in the server environment to accept deposits.';
        }

        // A locally hosted build cannot receive confirmations: the provider posts to
        // APP_BASE_URL from the public internet and cannot resolve localhost. Without this
        // the deposit is created, the address is shown, the money is sent, and the balance
        // simply never moves -- which reads as a broken provider rather than a callback
        // that could not be delivered.
        const warning = document.getElementById('callback-warning');
        if (warning && options.callbacksReachable === false) {
            warning.textContent = options.publicBaseUrl
                ? `This build is hosted at ${options.publicBaseUrl}, which payment providers cannot reach. ` +
                  'Deposits will not be credited automatically until APP_BASE_URL points at a public HTTPS address.'
                : 'This build cannot receive payment confirmations because its public address is not reachable from the internet.';
            warning.hidden = false;
        }
        updateDepositFields();
    } catch (error) {
        if (notice) notice.classList.add('is-offline');
        if (title) title.textContent = 'Payment providers unavailable';
        if (copy) copy.textContent = error.message;
        if (submit) submit.disabled = true;
    }
}

/**
 * Sets the second line of a payment-method card.
 *
 * The card's own `<span>` is reused rather than a new element created per load, so the
 * descriptor is not rebuilt on every options refresh -- which matters because the refresh
 * happens every time the dialog opens, and rebuilding a node the user may be reading is how
 * a label ends up flickering.
 */
function describeDepositMethod(button, text) {
    if (!button) return;
    const target = button.querySelector('[data-method-detail]') || button.querySelector('span');
    if (target) target.textContent = text;
}

/**
 * Why a payment method is unavailable, as the customer reads it.
 *
 * The server distinguishes a deployment that was never set up from one where the provider
 * itself is refusing right now, because the two have opposite meanings: the first will stay
 * broken until someone configures it, the second usually clears on its own. Collapsing them
 * into one "unavailable" string is what made a Stripe account-level refusal look like a
 * missing environment variable.
 */
function unavailableDescriptor(reason) {
    return reason === 'temporarily unavailable'
        ? 'Temporarily unavailable, try again later'
        : 'Not configured on this deployment';
}

function updateDepositFields() {
    const isCrypto = depositState.method === 'crypto';
    document.querySelectorAll('[data-deposit-method]').forEach((button) => {
        const selected = button.dataset.depositMethod === depositState.method;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });

    // A two-option picker where one option is permanently disabled is not a choice, it is a
    // dead control with a promise on it. When exactly one method is configured the group and
    // its label are removed entirely, so what is on screen is the thing that works. Both
    // available keeps the picker, because then it is a real decision.
    const options = depositState.options;
    const usable = Boolean(options && (options.stripeAvailable || options.cryptoAvailable));
    const onlyOne = usable && Number(Boolean(options.stripeAvailable)) + Number(Boolean(options.cryptoAvailable)) === 1;
    const methodGroup = document.querySelector('.deposit-method-options');
    const methodLabel = document.getElementById('deposit-method-label');
    if (methodGroup) methodGroup.hidden = onlyOne;
    if (methodLabel) methodLabel.hidden = onlyOne;

    const cryptoFields = document.getElementById('crypto-deposit-fields');
    if (cryptoFields) cryptoFields.hidden = !isCrypto;
    const submit = document.getElementById('deposit-submit');
    if (submit) {
        submit.textContent = isCrypto ? 'Generate crypto payment address' : 'Continue to secure checkout';
    }

    // Card and crypto have different limits, so the amount bounds and the stated range
    // both have to follow the method as well as the coin.
    const amount = document.getElementById('deposit-amount');
    if (amount) {
        amount.min = String(minimumForSelectedCurrency());
        amount.max = String(maximumForSelectedCurrency());
    }
    updateDepositAmountHint();

    const chosen = document.querySelector(`[data-deposit-method="${depositState.method}"]`);
    if (submit) {
        // Three reasons the button can be off, and all three are real: the selected method is
        // unavailable, nothing on this deployment can take a payment, or the amount is below the
        // floor for the chosen coin. The floor is re-checked here rather than only while typing,
        // Only availability gates this, not the amount -- see `depositBlockedForAvailability`. The
        // floor is advisory and is allowed to be wrong without blocking a payment.
        submit.disabled = depositBlockedForAvailability();
    }
}

function syncDepositPresets() {
    const amountEl = document.getElementById('deposit-amount');
    const amount = amountEl ? Number(amountEl.value) : 0;
    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();
    // A preset is a one-tap way to fill the box, so it is judged against the bounds THIS FORM
    // applies -- the app's own floor and ceiling. It used to be compared against the provider's
    // quoted minimum too, which greyed out most of the presets on this account (the provider
    // quotes ~$18.74 for every coin while the presets are $5-$50) and left a deposit form where
    // most of the one-tap options could not be pressed. The provider is asked at submit time and
    // its refusal is translated into a sentence, so nothing is lost by letting the user press.
    document.querySelectorAll('[data-deposit-amount]').forEach((button) => {
        const value = Number(button.dataset.depositAmount);
        const selected = amount === value;
        const usable = value >= minimum && value <= maximum;
        button.classList.toggle('is-active', selected && usable);
        button.disabled = !usable;
        button.setAttribute('aria-pressed', String(selected && usable));
        button.title = usable ? '' : `Outside the ${formatBalance(minimum)} to ${formatBalance(maximum)} this form accepts`;
    });
}

/** Fills the amount box with the largest deposit the selected coin will accept. */
function setMaximumDepositAmount() {
    const input = document.getElementById('deposit-amount');
    if (!input) return;
    input.value = maximumForSelectedCurrency().toFixed(2);
    syncDepositPresets();
    validateDepositAmount();
    input.focus();
}

async function createDeposit(event) {
    event.preventDefault();
    const submit = document.getElementById('deposit-submit');
    if (!submit) return;
    const isCrypto = depositState.method === 'crypto';
    const amountEl = document.getElementById('deposit-amount');
    const currencyEl = document.getElementById('deposit-currency');
    const originalLabel = submit.textContent;

    // No floor refusal here. This used to refuse the submission client-side and print the
    // provider's quoted minimum, because "amountTo is too small" is an unusable message to
    // show someone. The translation is still worth having -- it now happens on the server,
    // where the provider has actually answered -- but doing it before the request meant
    // refusing deposits that would have been created, since a quoted minimum is not a promise
    // about what the next request will be accepted for.
    //
    // So the amount is sent and the provider decides. If it refuses, the error handler below
    // receives the actionable sentence instead of the raw provider text.

    submit.disabled = true;
    submit.textContent = isCrypto ? 'Generating address...' : 'Creating checkout...';
    setFormMessage('deposit-message', '');

    try {
        const result = await requestJson('/api/user/deposits', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: Number(amountEl?.value),
                method: depositState.method,
                currency: isCrypto ? currencyEl?.value : null
            })
        });

        if (result.checkoutUrl) {
            window.location.assign(result.checkoutUrl);
            return;
        }

        renderDepositInstructions(result);
        const depositForm = document.getElementById('deposit-form');
        if (depositForm) depositForm.hidden = true;
        await loadDepositHistory();
        // No interval is started here any more. The page-wide live sync already covers this
        // case and does it better: it keeps the balance, both history lists, the header, and
        // any other open dialog in step, it backs off when the server is unhealthy, and it
        // stops while the tab is hidden. A second timer polling the same data on a different
        // schedule was the reason the deposit panel could be up to ten seconds behind
        // everything else on the page.
        // The deposit is outstanding, so the sync should look again promptly rather than
        // settling into the idle beat.
        liveState.awaitingDeposit = true;
        paintDepositStatus();
        paintLiveIndicator();
        scheduleLiveSync();
    } catch (error) {
        setFormMessage('deposit-message', error.message, 'error');
        // A provider-level refusal changes what this deployment can offer, not just this
        // submission: the server has already stopped advertising the method. Reloading the
        // options is what moves the card button to greyed-out with the reason on it, so the
        // user's next action is visible on the form instead of being another attempt at the
        // same dead end.
        if (error.status === 503) {
            await loadDepositOptions().catch(() => {});
        }
        updateDepositFields();
    } finally {
        const depositForm = document.getElementById('deposit-form');
        if (depositForm && !depositForm.hidden) {
            // Not `= false`: the amount may still be under the coin's floor, and re-enabling
            // the button would undo the reason it was disabled.
            setDepositSubmitEnabled();
            submit.textContent = originalLabel;
        }
    }
}

function renderDepositInstructions(result) {
    const instructions = document.getElementById('deposit-instructions');
    if (!instructions) return;
    instructions.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = 'Send your deposit';

    const lead = document.createElement('p');
    lead.className = 'receipt-lead';

    const stage = document.createElement('div');
    stage.className = 'receipt-stage';

    if (result.qrCodeSvg) {
        const qr = document.createElement('div');
        qr.className = 'receipt-qr';
        // The SVG arrives already rendered and scannable, so it is inserted as markup
        // rather than as an image source. It is produced by our own server from the
        // address the provider gave us, not by anything the page fetched.
        qr.innerHTML = result.qrCodeSvg;
        stage.append(qr);
    }

    const details = document.createElement('div');
    details.className = 'receipt-details';

    const countdown = buildCountdown(result.expiresAt);
    if (countdown) {
        details.append(countdown);
    }

    const isExpired = countdown && (() => {
        const deadline = Number(countdown.dataset.deadline);
        return Number.isFinite(deadline) && Date.now() >= deadline;
    })();

    if (isExpired) {
        lead.textContent = 'This deposit address has expired. Start a new deposit to get a fresh address and countdown.';
        lead.style.color = 'var(--warning)';
    } else {
        lead.textContent = `Send exactly ${result.payAmount} ${result.assetCode} on the ${result.network} network.`;
    }

    const network = document.createElement('p');
    network.className = 'receipt-meta';
    network.textContent = `Network: ${result.network}`;

    const warning = document.createElement('p');
    warning.className = 'deposit-warning';
    warning.textContent = `Send only ${result.assetCode} on the ${result.network} network. Sending another asset, or the same asset on a different network, loses the funds and cannot be recovered.`;

    const addressLabel = document.createElement('p');
    addressLabel.className = 'receipt-label';
    addressLabel.textContent = 'Your deposit address';

    const address = document.createElement('code');
    address.className = 'deposit-address';
    address.textContent = result.payAddress;

    const copy = document.createElement('button');
    copy.className = 'button button-light copy-address';
    copy.type = 'button';
    copy.textContent = 'Copy address';
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(result.payAddress);
            copy.textContent = 'Copied';
        } catch {
            // Clipboard access can be refused (no permission, insecure context). Selecting
            // the address is the useful fallback, so the user can still copy manually.
            copy.textContent = 'Press Ctrl+C to copy';
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(address);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    });

    // Chains that route by a destination tag cannot receive from the address alone, so it
    // is called out here rather than only in the withdrawal form.
    if (result.payinExtraId) {
        const extra = document.createElement('p');
        extra.className = 'receipt-meta is-strong';
        extra.textContent = `Also send this destination tag: ${result.payinExtraId}`;
        details.append(extra);
    }

     details.append(network, warning, addressLabel, address, copy);

    const note = document.createElement('p');
    note.className = 'receipt-note';
    // Replaced by the live status as soon as one arrives, so the two are never both on
    // screen saying different things about the same deposit.
    note.id = 'deposit-status-note';
    note.textContent = 'Your balance updates automatically once the provider confirms the payment.';

    const again = document.createElement('button');
    again.className = 'button button-light button-wide';
    again.type = 'button';
    again.textContent = 'Make another deposit';
    again.addEventListener('click', resetDepositForAnother);

    // Only show the QR and payment details when the address is still live. An expired
    // address that the user scans or copies is money in the wind.
    if (!isExpired) {
        stage.append(details);
    }

    instructions.append(heading, lead, stage, note, again);
    // Tracked so the live sync can find this panel's note without another id lookup, and so
    // it knows which deposit the status belongs to.
    activeDeposit = { id: result.depositId || null, note };
    instructions.hidden = false;

    if (countdown) startCountdown();
}

/**
 * Builds the "expires in" readout, or null when the provider quoted no deadline.
 *
 * A QR and an address with no deadline is the exact state that produces a user sending
 * funds to an address the provider has already retired. The countdown is only shown when
 * there is a real timestamp to count to -- an invented default would be worse than none.
 */
function buildCountdown(expiresAt) {
    if (!expiresAt) return null;
    const deadline = new Date(expiresAt).getTime();
    if (!Number.isFinite(deadline)) return null;

    const element = document.createElement('p');
    element.className = 'receipt-countdown';
    element.dataset.deadline = String(deadline);
    element.textContent = 'Checking how long this address stays valid...';
    return element;
}

let depositCountdownTimer;

/** Paints the expiry readout once, then on a timer until the deadline passes. */
function startCountdown() {
    window.clearInterval(depositCountdownTimer);
    depositCountdownTimer = undefined;

    const paint = () => {
        const element = document.querySelector('.receipt-countdown');
        if (!element) {
            window.clearInterval(depositCountdownTimer);
            depositCountdownTimer = undefined;
            return;
        }
        const remaining = Math.floor((Number(element.dataset.deadline) - Date.now()) / 1000);
        if (remaining <= 0) {
            element.textContent = 'This address has expired. Start a new deposit to get a fresh one.';
            element.classList.add('is-expired');
            window.clearInterval(depositCountdownTimer);
            depositCountdownTimer = undefined;
            return;
        }
        const minutes = Math.floor(remaining / 60);
        const seconds = String(remaining % 60).padStart(2, '0');
        element.textContent = `This address expires in ${minutes}:${seconds}. Send before then.`;
    };

    // Painted immediately so the readout never shows placeholder text for a second.
    paint();
    depositCountdownTimer = window.setInterval(paint, 1000);
}

/**
 * Returns the dialog to the entry form so a second deposit can be started.
 *
 * Without this the form stayed hidden behind the instructions panel, so making another
 * deposit meant closing and reopening the dialog -- and re-reading the provider status.
 */
function resetDepositForAnother() {
    window.clearInterval(depositCountdownTimer);
    depositCountdownTimer = undefined;

    const instructions = document.getElementById('deposit-instructions');
    if (instructions) {
        instructions.replaceChildren();
        instructions.hidden = true;
    }

    const form = document.getElementById('deposit-form');
    if (form) form.hidden = false;

    const submit = document.getElementById('deposit-submit');
    if (submit) {
        // Through the helper, for the same reason as the end of a submission: the amount that
        // was in the box a moment ago may be under the coin's floor, and a second deposit starts
        // with the box disabled until the user types something payable.
        setDepositSubmitEnabled();
        submit.textContent = depositState.method === 'crypto'
            ? 'Generate crypto payment address'
            : 'Continue to secure checkout';
    }

    clearDepositMessage();
    updateDepositFields();
    const amountEl = document.getElementById('deposit-amount');
    if (amountEl) amountEl.focus();
}

/* ------------------------------------------------------------ withdrawals */

function openWithdrawal() {
    if (!getSessionToken()) {
        const dialog = document.getElementById('account-dialog');
        if (dialog) dialog.showModal();
        return;
    }
    // As with `openDeposits`: the dialog is on the account and offers pages, and the header's
    // account menu is on every page. Without the dialog this was a menu item that closed the
    // menu and stopped, so a page that carries the menu has to send the visitor to one that
    // carries the dialog.
    const withdrawDialog = document.getElementById('withdraw-dialog');
    if (!withdrawDialog) {
        window.location.assign('/account#withdraw');
        return;
    }
    setFormMessage('withdraw-message', '');
    // A previous visit may have left the confirmation panel showing, which would open the
    // dialog straight onto a receipt for a request that is already in the history below.
    const confirmation = document.getElementById('withdraw-confirmation');
    if (confirmation) {
        confirmation.hidden = true;
        confirmation.replaceChildren();
    }
    const withdrawForm = document.getElementById('withdraw-form');
    if (withdrawForm) withdrawForm.hidden = false;
    withdrawDialog.showModal();
    loadWithdrawalOptions();
    loadWithdrawalHistory();
    refreshBalance();
}

/**
 * Loads the supported destinations once and builds the pickers from them.
 *
 * The asset and network lists used to be duplicated in this file and in the payout
 * controller. They now come from the server, so adding a destination there is enough.
 */
async function loadWithdrawalOptions() {
    const container = document.getElementById('withdraw-method-options');
    if (!container) return;
    try {
        if (!withdrawState.options) {
            container.textContent = 'Loading payment methods...';
            withdrawState.options = await requestJson('/api/user/withdrawal-options', {
                headers: authHeaders()
            });
        }
        const options = withdrawState.options;

        // The floor and ceiling are the provider's, but the balance is the real limit, so
        // both are reconciled here rather than leaving the box to a stale pair of bounds.
        const amount = document.getElementById('withdraw-amount');
        if (amount) amount.min = String(options.minimumUsd);
        syncWithdrawBalance();
        updateWithdrawAmountHint();

        renderChoiceGroup(container, 'withdrawMethod', options.methods, withdrawState.method, (value) => {
            withdrawState.method = value;
            if (value !== 'crypto') {
                withdrawState.network = '';
            } else if (!withdrawState.asset) {
                withdrawState.asset = options.assets[0]?.code || '';
                renderNetworkChoices();
            }
            updateWithdrawFields();
        });

        renderChoiceGroup(document.getElementById('withdraw-asset-options'), 'withdrawAsset',
            options.assets.map((asset) => ({
                value: asset.code,
                label: `${asset.symbol} ${asset.label}`,
                symbol: asset.symbol
            })),
            withdrawState.asset || options.assets[0]?.code || '',
            (value) => {
                withdrawState.asset = value;
                withdrawState.network = '';
                renderNetworkChoices();
                updateWithdrawFields();
            });

        if (!withdrawState.network) renderNetworkChoices();
        updateWithdrawFields();
    } catch (error) {
        container.replaceChildren();
        if (handleUnauthorized(error)) {
            const withdrawDialog = document.getElementById('withdraw-dialog');
            if (withdrawDialog) withdrawDialog.close();
            const accountDialog = document.getElementById('account-dialog');
            if (accountDialog) accountDialog.showModal();
            return;
        }
        setFormMessage('withdraw-message', error.message, 'error');
    }
}

/**
 * Builds a group of card-style radio buttons.
 *
 * Radios rather than buttons so the form still submits natively, keyboard arrow keys
 * move between options, and `:has(input:checked)` does the visual selection.
 */
function renderChoiceGroup(container, name, options, selected, onChange) {
    container.replaceChildren(...options.map((option) => {
        const label = document.createElement('label');
        label.className = 'choice';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = name;
        input.value = option.value;
        input.checked = option.value === selected;

        if (option.symbol) {
            const badge = document.createElement('span');
            badge.className = 'asset-symbol';
            badge.textContent = option.symbol;
            badge.setAttribute('aria-hidden', 'true');
            label.append(badge);
        }

        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);

        input.addEventListener('change', () => {
            if (input.checked) onChange(option.value);
        });
        return label;
    }));
}

function selectedAsset() {
    return withdrawState.options?.assets.find((asset) => asset.code === withdrawState.asset) || null;
}

function renderNetworkChoices() {
    const select = document.getElementById('withdraw-network');
    const asset = selectedAsset();
    const networks = asset?.networks || [];
    const previous = withdrawState.network;
    select.replaceChildren(...networks.map((network) => {
        const option = document.createElement('option');
        option.value = network.value;
        option.textContent = network.label;
        return option;
    }));
    if (networks.some((network) => network.value === previous)) {
        select.value = previous;
    } else {
        withdrawState.network = select.value;
    }
}

function selectedNetwork() {
    const asset = selectedAsset();
    return asset?.networks.find((network) => network.value === withdrawState.network) || null;
}

/** Shows the destination, network, and resulting balance for the current selection. */
function updateWithdrawFields() {
    const isCrypto = withdrawState.method === 'crypto';
    const cryptoFields = document.getElementById('crypto-withdraw-fields');
    if (cryptoFields) cryptoFields.hidden = !isCrypto;

    const addressLabel = document.getElementById('withdraw-address-label');
    const address = document.getElementById('withdraw-address');
    if (!addressLabel || !address) return;
    if (isCrypto) {
        addressLabel.textContent = 'Wallet address';
        address.placeholder = 'Your wallet address';
        address.autocomplete = 'off';
        address.spellcheck = false;
    } else {
        addressLabel.textContent = withdrawState.method === 'venmo' ? 'Venmo username' : 'PayPal email address';
        address.placeholder = withdrawState.method === 'venmo' ? 'Your Venmo username' : 'you@example.com';
        address.autocomplete = withdrawState.method === 'venmo' ? 'off' : 'email';
        address.spellcheck = false;
    }

    const hintId = 'withdraw-address-hint';
    if (isCrypto) {
        const network = selectedNetwork();
        setHint(hintId, network?.addressHint || 'Check that the network matches the address you are sending to.');
    } else {
        const method = withdrawState.options?.methods.find((entry) => entry.value === withdrawState.method);
        setHint(hintId, method?.hint || '');
    }

    // Some chains route by a destination tag or memo as well as the address. A correct
    // XRP address with no tag cannot receive anything, and nothing in the address format
    // reveals that, so the field appears for exactly the assets that need it.
    const asset = selectedAsset();
    const tagField = document.getElementById('withdraw-tag-field');
    const needsTag = isCrypto && asset?.requiresDestinationTag === true;
    if (tagField) {
        tagField.hidden = !needsTag;
        const tagInput = document.getElementById('withdraw-tag');
        if (tagInput) tagInput.required = needsTag;
    }

    // The network picker is the authoritative list for the chosen asset, so it is only
    // required while a crypto destination is being described.
    const networkEl = document.getElementById('withdraw-network');
    if (networkEl) networkEl.required = isCrypto;
    updateWithdrawSummary();
}

function updateWithdrawSummary() {
    renderWithdrawalConfirm();
    const summary = document.getElementById('withdraw-summary');
    const amountEl = document.getElementById('withdraw-amount');
    const destinationEl = document.getElementById('withdraw-address');
    const amount = amountEl ? Number(amountEl.value) : 0;
    const destination = destinationEl ? destinationEl.value.trim() : '';
    const isCrypto = withdrawState.method === 'crypto';

    const rows = [];
    if (Number.isFinite(amount) && amount > 0) rows.push(['Amount', formatBalance(amount)]);
    if (isCrypto) {
        const asset = selectedAsset();
        const network = selectedNetwork();
        if (asset) rows.push(['Asset', `${asset.symbol} (${asset.label})`]);
        if (network) rows.push(['Network', network.label]);
        // Both of these come from the provider and were being fetched on every open of
        // this form, then never shown. A withdrawal quote that omits the network fee is the
        // kind of surprise that turns into a support ticket, so they are stated explicitly.
        if (Number.isFinite(network?.estimatedFeeCoin) && network.estimatedFeeCoin > 0) {
            rows.push(['Network fee', `~${network.estimatedFeeCoin} ${asset?.symbol || ''}`.trim()]);
        }
        if (Number.isFinite(network?.minimumCoin) && network.minimumCoin > 0) {
            rows.push(['Provider minimum', `${network.minimumCoin} ${asset?.symbol || ''}`.trim()]);
        }
    } else {
        const method = withdrawState.options?.methods.find((entry) => entry.value === withdrawState.method);
        if (method) rows.push(['Method', method.label]);
    }
    if (destination) rows.push(['Sending to', destination]);

    if (Number.isFinite(amount) && amount > 0 && Number.isFinite(accountState.balance)) {
        rows.push(['Balance after', formatBalance(Math.max(0, accountState.balance - amount))]);
    }

    if (rows.length === 0) {
        if (summary) summary.hidden = true;
        return;
    }

    if (!summary) return;

    const list = document.createElement('dl');
    for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
    }
    summary.replaceChildren(list);
    summary.hidden = false;
}

/**
 * Checks the destination before the request is sent.
 *
 * The server already validates the address and rejects a bad one, so this is not a
 * security control -- it is there so an obviously wrong entry is caught while the user is
 * still looking at the field, instead of after a round trip and a rejection. The message
 * is specific, because "invalid address" is the least helpful thing to tell someone whose
 * address is one character long.
 */
function validateWithdrawalDestination() {
    const addressEl = document.getElementById('withdraw-address');
    const address = addressEl ? addressEl.value.trim() : '';
    const method = withdrawState.method;

    if (!address) {
        setHint('withdraw-address-hint', 'Enter where the funds should go.', true);
        return false;
    }

    if (method === 'paypal' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
        setHint('withdraw-address-hint', 'PayPal needs a valid email address.', true);
        return false;
    }
    if (method === 'venmo' && !/^[A-Za-z0-9._-]{3,25}$/.test(address)) {
        setHint('withdraw-address-hint', 'Venmo usernames are 3-25 letters, numbers, dots, dashes or underscores.', true);
        return false;
    }
    if (method === 'crypto') {
        // Whitespace inside an address is never valid, and pasting one is the usual cause
        // of a transfer that silently disappears.
        if (/\s/.test(address)) {
            setHint('withdraw-address-hint', 'A wallet address cannot contain spaces. Check for a stray space or line break.', true);
            return false;
        }
        if (address.length < 16) {
            setHint('withdraw-address-hint', 'That address looks too short to be a real wallet address.', true);
            return false;
        }
        const tagField = document.getElementById('withdraw-tag-field');
        const tagInput = document.getElementById('withdraw-tag');
        if (tagField && !tagField.hidden && !(tagInput?.value.trim())) {
            setHint('withdraw-address-hint', 'This network routes by destination tag as well as address, so the tag is required.', true);
            return false;
        }
    }

    return true;
}

/**
 * Everything the server needs to describe this withdrawal, in one place.
 *
 * Both the code request and the final submit build their body from this, and the server binds
 * the code to the same values. Two separate literals here would be how the two could drift
 * apart, and the symptom would be a code that is rejected for reasons the user cannot see.
 */
function withdrawalRequestBody() {
    const isCrypto = withdrawState.method === 'crypto';
    const amountEl = document.getElementById('withdraw-amount');
    const addressEl = document.getElementById('withdraw-address');
    const tagEl = document.getElementById('withdraw-tag');
    return {
        amount: Number(amountEl?.value),
        paymentMethod: withdrawState.method,
        paymentAddress: addressEl ? addressEl.value.trim() : '',
        assetCode: isCrypto ? withdrawState.asset : null,
        network: isCrypto ? withdrawState.network : null,
        destinationTag: isCrypto
            ? (tagEl ? tagEl.value.trim() || null : null)
            : null
    };
}

/** Shows what a code is about to authorise, and hides the step again. */
function renderWithdrawalConfirm() {
    const panel = document.getElementById('withdraw-confirm');
    const facts = document.getElementById('withdraw-confirm-facts');
    if (!panel || !facts) return;

    const body = withdrawalRequestBody();
    if (!body.paymentAddress) {
        panel.hidden = true;
        return;
    }

    const list = document.createElement('div');
    const rows = [['Amount', formatBalance(body.amount)]];
    if (body.paymentMethod === 'crypto' && body.assetCode) {
        rows.push(['Coin', [body.assetCode, body.network].filter(Boolean).join(' on ')]);
    } else {
        rows.push(['Method', body.paymentMethod === 'paypal' ? 'PayPal' : 'Bank transfer']);
    }
    rows.push(['To', body.destinationTag ? `${body.paymentAddress} (${body.destinationTag})` : body.paymentAddress]);

    for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
    }
    facts.replaceChildren(list);
    panel.hidden = false;

    // The code is bound to the amount and destination it was sent for. Editing either after the
    // fact leaves a code the server will reject, so the step is re-armed here instead of letting
    // the user type six digits at a dead code and spend one of five attempts finding out.
    if (withdrawState.codeFor && withdrawalCodeTarget(body) !== withdrawState.codeFor) {
        withdrawState.codeFor = null;
        const codeInput = document.getElementById('withdraw-code');
        if (codeInput) codeInput.value = '';
        const send = document.getElementById('withdraw-code-send');
        if (send) {
            send.disabled = false;
            send.textContent = 'Email me a new code';
        }
        const resend = document.getElementById('withdraw-code-resend');
        if (resend) resend.hidden = false;
        const hint = document.getElementById('withdraw-code-hint');
        if (hint) {
            hint.hidden = false;
            hint.textContent = 'You changed the amount or destination, so the previous code no longer applies. Request a new one.';
        }
    }
}

/** The exact values the code is bound to, as one comparable string. */
function withdrawalCodeTarget(body) {
    return [body.amount, body.paymentMethod, body.assetCode, body.network, body.paymentAddress, body.destinationTag].join('|');
}

/** Disables confirmation once a code has been sent, and reports the window it is good for. */
function markWithdrawalCodeSent(minutes) {
    const send = document.getElementById('withdraw-code-send');
    const resend = document.getElementById('withdraw-code-resend');
    const hint = document.getElementById('withdraw-code-hint');
    if (send) {
        send.disabled = true;
        send.textContent = 'Code sent';
    }
    if (resend) resend.hidden = false;
    if (hint) {
        hint.hidden = false;
        hint.textContent = `Check your inbox. The code is good for ${minutes} minutes and only works for this amount and destination.`;
    }
    document.getElementById('withdraw-code')?.focus();
}

/** Asks the server for a code for exactly the withdrawal described on screen. */
async function sendWithdrawalCode() {
    const button = document.getElementById('withdraw-code-send');
    const resend = document.getElementById('withdraw-code-resend');
    const hint = document.getElementById('withdraw-code-hint');
    const original = button?.textContent;
    const body = withdrawalRequestBody();

    if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
    }
    if (resend) resend.disabled = true;
    if (hint) hint.hidden = true;

    try {
        const result = await requestJson('/api/user/withdrawals/code', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        // Remembered only after the server confirms it sent one, so a failed request does not
        // leave a code that was never issued being treated as valid.
        withdrawState.codeFor = withdrawalCodeTarget(body);
        markWithdrawalCodeSent(result.expiresInMinutes ?? 10);
    } catch (error) {
        if (hint) {
            hint.hidden = false;
            hint.textContent = error.message;
        }
        if (button) {
            button.disabled = false;
            button.textContent = original;
        }
        if (resend) resend.disabled = false;
    }
}

async function submitWithdrawal(event) {
    event.preventDefault();
    const button = document.getElementById('withdraw-submit');

    // Checked before the request rather than after, so a typo does not cost a round trip.
    if (!validateWithdrawalDestination()) {
        const addressEl = document.getElementById('withdraw-address');
        if (addressEl) addressEl.focus();
        return;
    }

    // The server will refuse a withdrawal without a matching code, and it is bound to the
    // amount and destination. Caught here so the user is sent to the code step rather than
    // shown a rejection they have not been given a way to fix.
    const code = String(document.getElementById('withdraw-code')?.value || '').trim();
    if (!/^\d{6}$/.test(code)) {
        renderWithdrawalConfirm();
        document.getElementById('withdraw-code')?.focus();
        setFormMessage('withdraw-message', 'Enter the 6-digit code we emailed you.', 'error');
        return;
    }

    if (!button) return;
    button.disabled = true;
    button.textContent = 'Submitting...';
    setFormMessage('withdraw-message', '');

    try {
        const result = await requestJson('/api/user/withdraw', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ...withdrawalRequestBody(), code })
        });

        showWithdrawalConfirmation(result);
        notifyWithdrawalSubmitted(result);
        const amountEl = document.getElementById('withdraw-amount');
        if (amountEl) amountEl.value = '';
        const addressEl = document.getElementById('withdraw-address');
        if (addressEl) addressEl.value = '';
        const tagEl = document.getElementById('withdraw-tag');
        if (tagEl) tagEl.value = '';
        // The code is single-use and already spent server-side. Clearing it stops the next
        // withdrawal from being submitted with a dead one, and stops it being read over a
        // shoulder in the meantime.
        const codeEl = document.getElementById('withdraw-code');
        if (codeEl) codeEl.value = '';
        const panel = document.getElementById('withdraw-confirm');
        if (panel) panel.hidden = true;
        withdrawState.codeFor = null;
        const send = document.getElementById('withdraw-code-send');
        if (send) {
            send.disabled = false;
            send.textContent = 'Email me a code';
        }
        const resend = document.getElementById('withdraw-code-resend');
        if (resend) resend.hidden = true;
        const hint = document.getElementById('withdraw-code-hint');
        if (hint) hint.hidden = true;
        updateWithdrawSummary();
        await refreshBalance();
        await loadWithdrawalHistory();
    } catch (error) {
        setFormMessage('withdraw-message', error.message, 'error');
        // A refused code is spent or stale, so the step goes back to asking for a new one
        // rather than leaving a user typing the same six digits at a dead code.
        if (/code/i.test(error.message || '')) {
            const codeEl = document.getElementById('withdraw-code');
            if (codeEl) codeEl.value = '';
            const send = document.getElementById('withdraw-code-send');
            if (send) {
                send.disabled = false;
                send.textContent = 'Email me a new code';
            }
        }
        handleUnauthorized(error);
    } finally {
        button.disabled = false;
        button.textContent = 'Submit request';
    }
}

/**
 * Swaps the form for a confirmation the user can actually read.
 *
 * This used to set a success message and close the dialog after 1.8 seconds. That is
 * barely long enough to register, and it happened whether or not anyone had read it --
 * so the one screen that tells someone their money is now held pending manual review was
 * also the one screen nobody saw. The dialog now stays open on an explicit receipt, and
 * the user dismisses it themselves.
 */
function showWithdrawalConfirmation(result) {
    const form = document.getElementById('withdraw-form');
    if (form) form.hidden = true;

    const panel = document.getElementById('withdraw-confirmation');
    if (!panel) return;
    panel.replaceChildren();

    const mark = document.createElement('span');
    mark.className = 'confirmation-mark';
    mark.setAttribute('aria-hidden', 'true');

    const heading = document.createElement('h3');
    heading.textContent = 'Request received';

    const lead = document.createElement('p');
    lead.className = 'receipt-lead';
    lead.textContent = result?.message || 'Your request is saved as pending. Funds have not been sent yet.';

    const steps = document.createElement('ol');
    steps.className = 'confirmation-steps';
    for (const step of [
        'The amount is held from your balance now.',
        'An operator reviews the request.',
        'Funds leave after the request is paid.'
    ]) {
        const item = document.createElement('li');
        item.textContent = step;
        steps.append(item);
    }

    const close = document.createElement('button');
    close.className = 'button button-accent button-wide';
    close.type = 'button';
    close.textContent = 'Done';
    close.addEventListener('click', () => {
        const withdrawDialog = document.getElementById('withdraw-dialog');
        if (withdrawDialog) withdrawDialog.close();
    });

    const another = document.createElement('button');
    another.className = 'button button-light button-wide';
    another.type = 'button';
    another.textContent = 'Make another request';
    another.addEventListener('click', resetWithdrawalForAnother);

    panel.append(mark, heading, lead, steps, close, another);
    panel.hidden = false;
    close.focus();
}

/** Returns the withdrawal dialog to the entry form after a confirmed request. */
function resetWithdrawalForAnother() {
    const panel = document.getElementById('withdraw-confirmation');
    if (panel) {
        panel.replaceChildren();
        panel.hidden = true;
    }

    const form = document.getElementById('withdraw-form');
    if (form) form.hidden = false;
    clearWithdrawMessage();
    updateWithdrawFields();
    const amountEl = document.getElementById('withdraw-amount');
    if (amountEl) amountEl.focus();
}

/* ---------------------------------------------------------------- history */

async function loadWithdrawalHistory() {
    await loadPaymentHistory('/api/user/withdrawals', 'withdrawal-history', 'withdrawal');
}

async function loadDepositHistory() {
    await loadPaymentHistory('/api/user/deposits', 'deposit-history', 'deposit');
}

/** Shortens a long identifier for display, keeping both ends so it stays recognisable. */
function shortenAddress(value) {
    const text = String(value || '');
    if (text.length <= 24) return text;
    return `${text.slice(0, 12)}…${text.slice(-8)}`;
}

function describeHistoryItem(item, kind) {
    if (kind === 'withdrawal') {
        const method = item.payment_method === 'crypto'
            ? `${item.asset_code || ''} ${item.network ? `on ${item.network}` : ''}`.trim()
            : item.payment_method;
        return `${formatBalance(item.amount)} to ${method || 'destination'}`;
    }
    return `${formatBalance(item.amount)} ${item.currency_code || 'USD'} deposit`;
}

function describeHistorySubtitle(item, kind) {
    if (kind === 'withdrawal') {
        // A rejected withdrawal is the one history row where the outcome is not in the
        // amount, and "Failed" next to a debited balance reads as money lost. The ledger is
        // what says the money came back, so the wording follows it rather than the status:
        // a row that says failed with no refund behind it gets the honest reading.
        if (item.status === 'failed' || item.status === 'cancelled') {
            const outcome = item.refunded_at
                ? `Returned to your balance on ${new Date(item.refunded_at).toLocaleDateString()}`
                : 'No refund was recorded for this request';
            return item.failure_reason ? `${outcome} · ${item.failure_reason}` : outcome;
        }
        return item.payment_address
            ? `${item.payment_address} · ${new Date(item.created_at).toLocaleDateString()}`
            : new Date(item.created_at).toLocaleDateString();
    }
    if (item.status === 'confirming' || item.status === 'pending') {
        return 'Waiting for the payment provider to confirm';
    }
    return item.network
        ? `${item.asset_code} on ${item.network}`
        : new Date(item.created_at).toLocaleDateString();
}

/**
 * Renders one history row.
 *
 * Extracted from the loader so the live sync and the initial load draw the same thing. Two
 * copies of this markup is how a row ends up showing "Refunded" in one place and "Failed"
 * in the other.
 */
function buildHistoryRow(item, kind) {
    const status = String(item.status || '').toLowerCase();

    const row = document.createElement('div');
    row.className = 'history-row';

    const details = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = describeHistoryItem(item, kind);
    const subtitle = document.createElement('span');
    subtitle.textContent = describeHistorySubtitle(item, kind);
    details.append(label, subtitle);

    if (kind === 'deposit' && item.deposit_address && status !== 'confirmed') {
        const address = document.createElement('code');
        address.className = 'deposit-address history-address';
        // A full address is 30-90 characters of unbreakable noise in a list, and
        // it made each row several lines tall. Shortened for reading, with the
        // whole value still on the element for hover and for anyone copying it.
        address.textContent = shortenAddress(item.deposit_address);
        address.title = item.deposit_address;
        details.append(address);
    }

    const badge = document.createElement('span');
    // "Refunded" is a different claim from "Failed": it tells the user the money is
    // back, and it is only used when the ledger says so. The colour stays the
    // failure colour because the request was still rejected.
    const refunded = kind === 'withdrawal' && Boolean(item.refunded_at);
    badge.className = `payment-status status-${refunded ? 'refunded' : status}`;
    badge.textContent = refunded ? 'Refunded' : (statusLabels[status] || status);

    // A crypto withdrawal that is being sent by the provider carries its own progress, which
    // is finer-grained than our own `processing`: the user's money is somewhere specific
    // between "queued" and "sent", and "Processing" alone gives them nothing to look at. Only
    // shown while the payout is genuinely in flight -- a `paid` withdrawal has already been
    // said to have arrived, and repeating "sent" under a "Paid" badge is noise.
    const payoutLabel = kind === 'withdrawal' && status === 'processing' ? payoutProgressLabel(item.payout_status) : null;
    if (payoutLabel) {
        const progress = document.createElement('span');
        progress.className = 'payout-progress';
        progress.textContent = payoutLabel;
        details.append(progress);
    }

    row.append(details, badge);

    // A crypto deposit that has not been paid yet is a live instruction, not a record. Closing
    // the panel by accident used to leave the customer with a row that said "waiting" and
    // nothing about what to send, which is the state that strands money: the address is unpaid
    // and the only copy of the amount was in the dialog that had just been dismissed.
    //
    // So the row is a button while it is payable. Not a link and not a `div` with a click
    // handler -- a button, because it is reachable by keyboard, announced as a control, and
    // activates on Enter and Space without any of that being re-implemented here.
    if (kind === 'deposit' && item.payable && item.deposit_address) {
        const reopen = document.createElement('button');
        reopen.type = 'button';
        reopen.className = 'history-reopen';
        reopen.textContent = 'Show how to pay';
        reopen.setAttribute('aria-label', `Show how to pay deposit #${item.id} of ${formatBalance(item.amount)}`);

        reopen.addEventListener('click', () => {
            const dialog = document.getElementById('deposit-dialog');
            if (!dialog) return;
            // The form is hidden, not removed: the customer has already paid for this one, and
            // offering a second amount box next to a live address invites paying twice.
            const form = document.getElementById('deposit-form');
            if (form) form.hidden = true;
            const providerCopy = document.getElementById('deposit-provider-copy');
            if (providerCopy) providerCopy.hidden = true;
            const title = document.getElementById('deposit-title');
            if (title) title.textContent = 'Complete your deposit';
            renderDepositInstructions({
                payAmount: item.payAmount,
                assetCode: item.asset_code,
                network: item.network,
                qrCodeSvg: item.qrCodeSvg,
                expiresAt: item.expiresAt,
                payAddress: item.deposit_address
            });
            if (!dialog.open) dialog.showModal();
        });

        row.append(reopen);
        // The row's own class drives the affordance; set after appending so the button styles
        // are in place when the check scripts read the markup.
        row.classList.add('is-reopenable');
    }

    return row;
}

/**
 * The provider's payout stage, in words a user can act on.
 *
 * The provider's own vocabulary is deliberately not shown: `WAITING` and `REJECTED_NOT_CHECKED`
 * are internal states, and rendering them raw tells the user nothing about whether their money
 * is moving. Anything unrecognised falls back to the neutral "on its way" rather than
 * guessing at a stage, and an unknown outcome -- the one case where the app genuinely does not
 * know -- says so plainly instead of implying progress.
 */
function payoutProgressLabel(payoutStatus) {
    switch (String(payoutStatus || '').toUpperCase()) {
        case 'CREATING':
        case 'NEW':
            return 'Preparing your payout.';
        case 'WAITING':
        case 'PROCESSING':
            return 'Sent to the network. This can take a few minutes.';
        case 'SUBMISSION_UNKNOWN':
            return 'Confirming with the payout provider. No action is needed from you.';
        default:
            return null;
    }
}

/**
 * Draws a history list from data already in hand.
 *
 * Used by the live sync, which receives the rows in the same response as the change that
 * caused them, so rendering them here is what saves the second request.
 */
function renderHistoryInto(containerId, items, kind, emptyText) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!items.length) {
        container.textContent = emptyText;
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) fragment.append(buildHistoryRow(item, kind));
    container.replaceChildren(fragment);
}

async function loadPaymentHistory(endpoint, containerId, kind) {
    const container = document.getElementById(containerId);
    if (!container) return { settled: false, settledCount: 0 };
    container.textContent = 'Loading history...';
    const token = getSessionToken();
    if (!token) {
        container.textContent = 'Sign in to view history.';
        return { settled: false, settledCount: 0 };
    }
    try {
        const items = await requestJson(endpoint, {
            headers: { Authorization: `Bearer ${token}` }
        });
        container.replaceChildren();

        if (items.length === 0) {
            container.textContent = kind === 'deposit'
                ? 'No deposits yet.'
                : 'No withdrawal requests yet.';
            return { settled: false, settledCount: 0 };
        }

        const fragment = document.createDocumentFragment();
        let settledCount = 0;
        let newlyConfirmed = null;
        for (const item of items) {
            const status = String(item.status || '').toLowerCase();
            const isCredited = status === 'confirmed' || status === 'paid';
            if (isCredited) {
                settledCount += 1;
                // The transition is what triggers the success screen. The first time this
                // id is seen credited is the moment the money arrived; every poll after
                // that is the same fact and must stay silent.
                if (kind === 'deposit' && !creditedDepositsSeen.has(item.id)) {
                    creditedDepositsSeen.add(item.id);
                    newlyConfirmed = item;
                }
                if (kind === 'withdrawal') {
                    const seenStatus =
                        status === 'paid' ? 'paid' : status === 'failed' ? 'failed' : null;
                    if (seenStatus && !withdrawalStateSeen(item.id, seenStatus)) {
                        markWithdrawalSeen(item.id, seenStatus);
                    }
                }
            }

            fragment.append(buildHistoryRow(item, kind));
        }
        container.append(fragment);

        if (newlyConfirmed) await showDepositSuccess(newlyConfirmed);
        // The balance is re-read only when something newly settled, so an open dialog
        // polling every ten seconds is not issuing a balance request on every tick.
        if (settledCount > 0) await refreshBalance();
        return { settled: newlyConfirmed !== null, settledCount };
    } catch (error) {
        container.textContent = error.message;
        return { settled: false, settledCount: 0 };
    }
}

/**
 * The credit screen: what was added, to which reference, and the new balance.
 *
 * This is the moment the whole deposit flow exists for, and it previously had no screen
 * at all -- the balance changed silently behind a status badge in a list. It is a modal
 * rather than a navigation so the user is not taken away from the deposit they are in the
 * middle of, and it links to the standalone receipt for the reference and amount.
 */
async function showDepositSuccess(deposit) {
    const dialog = document.getElementById('deposit-success-dialog');
    if (!dialog || dialog.open) return;

    const amountEl = document.getElementById('deposit-success-amount');
    if (amountEl) amountEl.textContent = formatBalance(deposit.amount);
    const leadEl = document.getElementById('deposit-success-lead');
    if (leadEl) leadEl.textContent = deposit.asset_code
        ? `Your ${deposit.asset_code} deposit has been confirmed and credited.`
        : 'Your card payment has been confirmed and credited.';

    const rows = [['Reference', `#${deposit.id}`]];
    if (deposit.asset_code) {
        rows.push(['Asset', deposit.asset_code]);
        if (deposit.network) rows.push(['Network', deposit.network]);
        if (deposit.pay_amount) rows.push(['Sent', `${deposit.pay_amount} ${deposit.asset_code}`]);
    }
    rows.push(['Credited', new Date(deposit.credited_at || deposit.created_at).toLocaleString()]);
    renderReceiptFacts(document.getElementById('deposit-success-facts'), rows);

    // The balance is read after the credit so the number shown is the one the user just
    // earned, not the one from before it landed.
    let balanceText = '--';
    try {
        const data = await requestJson('/api/user/balance', {
            headers: authHeaders()
        });
        applyBalance(data.balance, data.demoBalance);
        balanceText = formatBalance(data.balance);
    } catch (error) {
        // The credit is confirmed regardless; a balance read that fails is not a reason
        // to withhold the confirmation, so the field is simply left unavailable.
    }
    const balanceEl = document.getElementById('deposit-success-balance');
    if (balanceEl) balanceEl.textContent = balanceText;

    const receiptLink = document.getElementById('deposit-success-receipt');
    if (receiptLink) receiptLink.href = deposit.receipt_url || `/receipt/deposit/${deposit.id}`;

    // A toast as well as the dialog: the dialog only appears when the poll that
    // noticed the credit is running, which is while the deposit dialog is open.
    // A payment that lands while the user is elsewhere on the page still needs
    // to announce itself, and a toast is the only thing that does that.
    notifyDepositConfirmed(deposit);

    dialog.showModal();
}

function renderReceiptFacts(container, rows) {
    const list = document.createElement('div');
    for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
    }
    if (container) {
        container.replaceChildren(list);
        container.hidden = false;
    }
}
