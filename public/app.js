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
const CREDITED_SEEN_KEY = 'offerNetworkDepositStatesSeen';
// Bounded so a long-lived tab cannot grow the entry without limit. Only the most recent events
// need remembering: anything older has long since been acknowledged, and the set is only
// consulted to avoid repeating something the user has already seen.
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

/**
 * Whether a deposit has already been announced in a given state, and marks it seen.
 *
 * Keyed on the state as well as the id, not just the id, and that is what lets a *failed* deposit
 * be announced as well as a credited one. Keyed on the id alone, the first announcement for a
 * deposit consumes the entry and every later state of the same deposit is silent -- so a deposit
 * that expired after being announced as pending, or failed after the user was told nothing, was
 * never reported at all. Those are the events a user most needs to hear about, and they are the
 * ones the id-only key swallowed.
 *
 * Same storage, same lifetime and the same trimming as the withdrawal states, deliberately: two
 * mechanisms that differ in one respect each is how a repeat gets announced on one path and
 * suppressed on the other.
 */
const depositStateSeen = {
    has(id, state) {
        return creditedSeen.has(`${String(id)}:${String(state)}`);
    },
    add(id, state) {
        creditedSeen.add(`${String(id)}:${String(state)}`);
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

/**
 * The newest moment this browser had already told the user about, or null.
 *
 * This is the piece that makes "announce it once" survive a new tab, and it is the reason the
 * two sets above are not enough on their own. `sessionStorage` is scoped to one tab, so it is
 * empty the moment a user opens a second tab -- and with an empty set, the first poll after
 * that load reports every deposit this account has ever had credited and every withdrawal it
 * has ever had sent or failed, all at once. Twenty of them, for events that happened last
 * month. The `firstUpdate` guard handles the repeat-reload case; only a timestamp that outlives
 * the tab can tell a fresh tab which of those rows are new.
 *
 * `localStorage` rather than `sessionStorage` precisely because it has to outlive the tab. It
 * is a single ISO string, it is only ever read at load, and a read failure degrades to "announce
 * nothing" rather than to replaying history.
 */
const LAST_SEEN_AT_KEY = 'offerNetworkLastSeenAt';

function readLastSeenAt() {
    try {
        const raw = window.localStorage.getItem(LAST_SEEN_AT_KEY);
        if (!raw) return null;
        const at = Date.parse(raw);
        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
}

function writeLastSeenAt(at) {
    try {
        window.localStorage.setItem(LAST_SEEN_AT_KEY, new Date(at).toISOString());
    } catch {
        // Storage unavailable. The in-memory `lastSeenAt` still seeds correctly for the rest
        // of this page's life, so the only cost is a replay after a reload.
    }
}

// Read once, at load, and never re-read: the value that matters is the one from *before* this
// page existed, because the first update is the one being judged against it. Re-reading after
// the first update would compare every later event against itself and announce nothing.
const lastSeenAtBeforeLoad = readLastSeenAt();

/**
 * Whether an event is new enough to announce, judged against the pre-load timestamp.
 *
 * A row with no usable event time is treated as *not* new. That is the one case where this
 * returns the wrong answer on purpose: a missing timestamp means the app cannot order the row,
 * and the alternative -- announcing it -- is a burst on every fresh tab, which is the failure
 * this whole mechanism exists to prevent. The row is still in the history list, so nothing is
 * actually hidden from the user; the only cost is a toast that did not arrive.
 */
function isEventSinceLastSeen(eventAt) {
    if (lastSeenAtBeforeLoad === null) return false;
    if (!eventAt) return false;
    const at = Date.parse(eventAt);
    if (!Number.isFinite(at)) return false;
    return at > lastSeenAtBeforeLoad;
}

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
 * Toasts already on screen, by what they say, so the same sentence cannot appear twice.
 *
 * A net under the structural once-only rules, not a substitute for them. Those decide whether
 * an event is new by comparing timestamps and ids; this only catches two calls arriving for the
 * same words in the same moment, which is what a double-clicked submit, or a burst of parallel
 * requests all failing the same way, produces.
 *
 * Keyed on the title and the message together, so two genuinely different toasts never collide
 * even when they share a title -- "Reward credited" twice for two different offers is two
 * events and both must be shown. The window is short because a toast lives about four seconds:
 * anything repeating after that is either a new event or a real bug, and either way it should
 * not be silently swallowed by a longer window.
 */
const TOAST_DEDUPE_MS = 2000;
const recentToasts = new Map();
const TOAST_DEDUPE_LIMIT = 60;

function toastAlreadyShown(title, message) {
    const key = `${title} ${message}`;
    const now = Date.now();
    const previous = recentToasts.get(key);
    if (previous !== undefined && now - previous < TOAST_DEDUPE_MS) return true;
    recentToasts.set(key, now);
    while (recentToasts.size > TOAST_DEDUPE_LIMIT) {
        const oldest = recentToasts.keys().next();
        if (oldest.done) break;
        if (now - recentToasts.get(oldest.value) >= TOAST_DEDUPE_MS) {
            recentToasts.delete(oldest.value);
            continue;
        }
        break;
    }
    return false;
}

/**
 * Where each kind of notification points, so clicking it takes you to what it is about.
 *
 * A toast is a sentence about something that happened on another page, and reading it is
 * usually the first half of a two-step action: the message tells you a deposit landed, and then
 * you have to go and find it. Leaving the destination implicit means every one of these is a
 * dead end -- a notice that reports a change and offers no way to look at it, which is the same
 * class of bug as a button that renders and does nothing.
 *
 * Keyed by the `category` the notification helpers already pass, rather than by matching on the
 * title. Titles are prose and get reworded; a category is a decision, and matching text would
 * silently stop matching the first time someone improves a sentence.
 *
 * `null` is a real answer, not a gap: a notice with nowhere to go stays a plain, non-clickable
 * card. Offering a click that does nothing is worse than not looking clickable, so the control
 * is only added when there is a destination.
 *
 * A deposit points at its own receipt, which is the one page that can answer "did the right
 * amount arrive" -- the account list can only say it was confirmed. `depositId` is used when the
 * caller knows it and falls back to the account list when it does not, so a deposit notice is
 * never a link to nowhere.
 */
const NOTIFICATION_TARGETS = {
    deposit: { href: '/account', label: 'View transactions' },
    deposit_failed: { href: '/account', label: 'View transactions' },
    withdrawal: { href: '/account', label: 'View withdrawals' },
    // The three withdrawal stages, so a stage notification that arrives without a record id still
    // has somewhere to go. The stages exist to keep the dedup index from collapsing them into one;
    // that is a storage concern and has nothing to say about where the link points.
    withdrawal_requested: { href: '/account', label: 'View withdrawals' },
    withdrawal_paid: { href: '/account', label: 'View withdrawals' },
    withdrawal_failed: { href: '/account', label: 'View withdrawals' },
    reward: { href: '/account', label: 'View transactions' },
    survey: { href: '/offers', label: 'Browse offers' },
    magic: { href: '/offers', label: 'Sign in' }
};

/**
 * The destination for a notification, or null when it has none.
 *
 * `href` given by the caller always wins, because a caller that knows a specific record should
 * not be overruled by a category's general page. The deposit receipt is the one case where a
 * category is refined by data, since "your deposit landed" is about one specific deposit.
 */
function notificationTarget({ category, href, recordId, depositId, withdrawalId }) {
    // The record first, and that ordering is the fix for a whole class of dead links.
    //
    // The destination is deliberately *derived* from the record rather than resolved once and
    // stored on the notification. A stored `href` is a cached answer to "where should this go",
    // and the rules for that answer changed here more than once -- from a receipt page, to a
    // history row, and the stored copies kept winning. Every notification already sitting in a
    // user's bell carries the answer its own version of the code produced, so any change to the
    // rules is invisible to every one of them, and the link stays wrong until it is dismissed
    // by hand. Deriving at render time means there is one rule and every entry follows it.
    //
    // The two record cases, which are the whole point of having this function. A category on
    // its own can only ever point at a list, and a list is a thing you have to search: being
    // told your deposit landed and then being dropped on a page where the row is one of many is
    // the same as not being told which row.
    //
    // The destination is the *history row*, not the record's own page, and that is a deliberate
    // choice in the other direction. The history list is where a person goes to see their money
    // in context -- what else happened, what the balance did -- and it can offer the receipt from
    // there. Sending them straight to a receipt answers a narrower question than the one they
    // had, and the record is then one link away rather than zero.
    const record = depositId ?? withdrawalId ?? recordId;
    if (category === 'deposit' && record) {
        return { href: `/account#${historyRowId('deposit', record)}`, label: 'View in history' };
    }
    // A deposit that failed or expired writes no ledger row, so there is no history row to scroll
    // to and the same link would land on a page with nothing on it. The receipt is the one place
    // that can show what went wrong and when. This is a separate category on the wire rather than a
    // flag on the same one so that a stored `href` cannot quietly take priority over the derivation
    // above, which is the bug this function exists to prevent.
    if (category === 'deposit_failed' && record) {
        return { href: `/receipt/deposit/${encodeURIComponent(record)}`, label: 'View receipt' };
    }
    // All withdrawal stages link to the same history row. Grouped rather than written out
    // three times because the three categories exist only to stop the dedup index swallowing one
    // stage behind another, and the moment they are listed separately someone will "simplify"
    // them back to one -- which reintroduces a notification that silently never appears.
    if (record && (category === 'withdrawal'
        || category === 'withdrawal_requested'
        || category === 'withdrawal_processing'
        || category === 'withdrawal_sending'
        || category === 'withdrawal_confirming'
        || category === 'withdrawal_paid'
        || category === 'withdrawal_failed')) {
        return { href: `/account#${historyRowId('withdrawal', record)}`, label: 'View in history' };
    }
    // Deposit pending/processing stages link to the deposit receipt (no history row until credited)
    if (record && (category === 'deposit_pending' || category === 'deposit_processing')) {
        return { href: `/receipt/deposit/${encodeURIComponent(record)}`, label: 'View deposit' };
    }
    // The caller's own href, for a case that genuinely is not a record link: a rejected deposit
    // writes no ledger row, so there is nothing in the history list to scroll to and the receipt
    // is the only page that can show what went wrong. Checked after the record so it is a
    // deliberate choice for that case rather than a way for a stale value to win.
    if (href) return { href, label: 'View details' };
    return NOTIFICATION_TARGETS[category] || null;
}

/**
 * The DOM id of a history row, for one kind of record and id.
 *
 * The one place this string is built. It appears in a notification's `href` and in the id the
 * history list puts on the row it describes, and those two have to agree exactly -- a mismatch is
 * a link to a fragment that matches nothing, which scrolls nowhere and looks like the page is
 * broken. Keeping the format behind one function is what stops a change to one side from
 * silently orphaning every notification already stored in a user's bell.
 */
function historyRowId(kind, id) {
    return `history-${String(kind || '').replace(/[^a-z-]/g, '')}-${encodeURIComponent(String(id ?? ''))}`;
}

/**
 * A brief notice, anchored top-right on desktop and above the action bar on a phone.
 *
 * Four behaviours here that are not obvious from the call sites:
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
 * - A toast with somewhere to go is a real control, and one without stays a plain card.
 *
 * On that last point. The whole clickable area is a `<button>`, not the toast div with a click
 * handler: this codebase has been bitten twice by a control that was reachable, looked right,
 * and did nothing, and once more by a `div` acting as a button, so the rule here is that
 * anything clickable is a real element with a role the browser and a screen reader already
 * understand. That gets keyboard activation, focus, and the accessible name for free, and the
 * only thing it costs is that the markup nests differently than the old one.
 *
 * A toast with no target keeps `role="status"` and stays put. Adding a button that navigates
 * nowhere would be worse than not looking clickable, so `null` is a real answer here.
 */
function showToast(title, message, { tone = 'info', duration = 4500, category = null, href = null, depositId = null, withdrawalId = null } = {}) {
    if (!toastRegion) return;
    // Checked after the region guard so a page with no toast region still records nothing,
    // and before the counter is incremented so a suppressed toast does not burn an id and
    // leave a gap in the sequence the DOM ids are built from.
    if (toastAlreadyShown(String(title || ''), String(message || ''))) return;
    const id = ++toastCount;
    const persistent = tone === 'error';
    const target = notificationTarget({ category, href, depositId, withdrawalId });

    const toast = document.createElement('div');
    toast.className = `toast is-${tone}`;
    toast.dataset.id = id;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    // The animation reads this custom property, and so does the pause below -- which is why
    // the duration has to live on the element rather than only in the timeout.
    toast.style.setProperty('--toast-duration', `${duration / 1000}s`);

    const body = `
        <span class="toast-icon" aria-hidden="true">${TOAST_ICONS[tone] || TOAST_ICONS.info}</span>
        <div class="toast-body">
            <div class="toast-title">${escapeHtml(title)}</div>
            ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
        </div>
    `;

    if (target) {
        // The label is appended as a separate line rather than folded into the title, so the
        // title still reads as the sentence it is. A title that ended in "View transactions"
        // would be read by a screen reader as one long claim about money.
        toast.classList.add('is-link');
        toast.innerHTML = `
            <button class="toast-action" type="button">
                ${body}
                <span class="toast-action-label">${escapeHtml(target.label)}</span>
            </button>
            <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
        `;
        // Activating the toast dismisses it first. Without that the old one stays on screen
        // for the rest of its timer over the page it just navigated to, and on a slow
        // connection the user lands on the destination and then watches a message about the
        // thing they just clicked fade out.
        toast.querySelector('.toast-action').addEventListener('click', () => {
            dismissToast(id);
            followNotificationTarget(target.href);
        });
    } else {
        toast.innerHTML = `
            ${body}
            <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
        `;
    }

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
/** Recently pushed notifications, used to collapse one event that arrived twice. */
const notificationDedupe = new Map();
const NOTIFICATION_DEDUPE_MS = 3000;
const NOTIFICATION_DEDUPE_LIMIT = 50;

/**
 * Shape version for a stored notification.
 *
 * Bumped whenever what a notification records about its destination changes. It exists because
 * the entries in `localStorage` outlive the code that wrote them, and an entry written before a
 * rule change holds a cached answer that is now wrong -- and, for the ones below, cannot be
 * repaired at all.
 */
const NOTIFICATION_SHAPE_VERSION = 2;

function loadNotifications() {
    try {
        const raw = window.localStorage.getItem(NOTIFICATIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        // Anything without the current shape is dropped rather than migrated.
        //
        // These are the entries written before a notification recorded *which* record it was
        // about. They stored a pre-resolved `href` -- `/account` -- and no id, so there is
        // nothing in the entry from which the real destination can be recovered: the id was
        // never written, and guessing one would produce a link to an arbitrary transaction. So
        // the choice is a link known to be wrong, kept until dismissed by hand, or no link at
        // all. Dropping is the better of the two, and the entries are a convenience list with no
        // financial meaning -- every one of them names something that is still in the history
        // list and on its receipt.
        return parsed.filter((entry) => entry && Number(entry.v) === NOTIFICATION_SHAPE_VERSION);
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

/**
 * Follows a notification's destination, including when it is the page already open.
 *
 * `location.assign` to the URL you are already on is not a no-op that the reader can see as
 * "nothing moved" -- it is genuinely nothing. Same path, same fragment: no navigation, no
 * document load, no `hashchange`, because the fragment did not change. The list on screen is
 * never re-examined, so clicking the same notification twice leaves the second click with no
 * effect whatsoever, and if the first click arrived before the row was on the page there is
 * nothing on the page to recover to.
 *
 * Re-dispatching `hashchange` is the fix rather than a new event, because the page that consumes
 * it already listens for exactly that and already knows how to find and focus its rows. A second
 * event type would be a second path into that same code, and the two would drift.
 *
 * Harmless on a page with no such listener, which is the point of reusing the name rather than
 * importing anything.
 */
function followNotificationTarget(href) {
    if (!href) return;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current === href) {
        window.dispatchEvent(new Event('hashchange'));
        return;
    }
    window.location.assign(href);
}

/**
 * The server's copy of this notification, if it is one the server knows about.
 *
 * The bell used to be built entirely in this browser, which made every notification a property of
 * this tab: gone when it closed, absent on a phone, and read-state that disagreed between devices.
 * The record now lives in the database, so a locally-announced event is written back to it and the
 * list is rehydrated from the API. Without this write-back the two halves would disagree -- the
 * server's list would only ever hold what the server itself happened to observe, which is not the
 * same set, and a notification that appeared while this tab was open would be missing next time.
 *
 * Fire and forget, like every other notification write here. The entry is already in the local
 * store and already rendered, so a failed write costs persistence and nothing else; blocking the
 * render on a round trip would make the bell slower, which is the opposite of the point.
 */
function persistNotification(entry) {
    const token = getSessionToken();
    if (!token) return;

    const recordId = entry.recordId;
    // Nothing to deduplicate against without one, and a notification with no record is one the
    // server's partial unique index does not cover, so writing it would risk a duplicate every
    // time. Money events all have one; the session-expiry warning is the counterexample and is
    // deliberately not written.
    if (recordId === null || recordId === undefined || entry.category === 'session') return;

    fetch(`/api/user/notifications`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            category: entry.category,
            tone: entry.tone,
            title: entry.title,
            message: entry.message,
            href: entry.href,
            recordId: String(recordId)
        })
    }).then(async (response) => {
        // 409 is the server saying it already has this one, which is the expected outcome when the
        // webhook and this tab both noticed the same event. Not an error worth surfacing.
        if (response.ok || response.status === 409) return;
        if (response.status === 401) return;
        const body = await response.json().catch(() => ({}));
        console.warn('Could not save notification to the server:', body.error || response.status);
    }).catch(() => {
        // Offline, or the tab was closed mid-request. The local copy stands.
    });
}

/**
 * Replace the local list with the server's.
 *
 * Runs once on load. The server list is the source of truth for anything that happened before this
 * page existed, and it is *replaced* rather than merged: a merge would keep the sessionStorage
 * entries forever alongside the server's, so the bell would grow every visit and the same event
 * would appear twice once both copies had it.
 *
 * A failure leaves the local store alone. That is the right direction -- if the API is unreachable
 * the reader should still see whatever this tab knows, and a cleared bell is a worse outcome than
 * a slightly stale one.
 */
async function hydrateNotifications() {
    const token = getSessionToken();
    if (!token) return;

    let list;
    try {
        const response = await fetch('/api/user/notifications?limit=50', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) return;
        list = await response.json();
    } catch {
        return;
    }
    if (!Array.isArray(list)) return;

    notificationStore = list;
    saveNotifications(notificationStore);
    renderNotificationBell();
    if (notificationDropdown && !notificationDropdown.hidden) renderNotificationList();
}

function pushNotification({ title, message, tone = 'info', href = null, category = null, depositId = null, withdrawalId = null }) {
    // Collapse an event that arrived twice, and only that.
    //
    // The key is the whole notification, not the title. The previous key was the title alone
    // inside a three-second window, which failed in both directions at once: two different
    // withdrawals of the same amount failing together shared a title, so the second was
    // silently discarded and the user was never told their money had failed twice; and the same
    // event arriving four seconds apart passed straight through, because the window had closed
    // and nothing was recording that it had already been announced.
    //
    // Keyed on all three fields, two genuinely different notifications never collide however
    // close together they land, and one event delivered by two code paths in the same tick
    // still collapses to a single bell entry.
    const dedupeKey = `${category || ''} ${title} ${message}`;
    const now = Date.now();
    const previous = notificationDedupe.get(dedupeKey);
    if (previous !== undefined && now - previous < NOTIFICATION_DEDUPE_MS) {
        return;
    }
    notificationDedupe.set(dedupeKey, now);
    // Pruned on write rather than by a `setTimeout` per notification. A timer per push is a
    // live handle that outlives the entry it exists to clear, and the map would only ever be
    // trimmed if the tab kept running. Entries older than the window are worthless, so the
    // oldest are dropped whenever a new one arrives.
    while (notificationDedupe.size > NOTIFICATION_DEDUPE_LIMIT) {
        const oldest = notificationDedupe.keys().next();
        if (oldest.done) break;
        if (now - notificationDedupe.get(oldest.value) >= NOTIFICATION_DEDUPE_MS) {
            notificationDedupe.delete(oldest.value);
            continue;
        }
        break;
    }

    const entry = {
        id: Date.now() + Math.random(),
        title,
        message,
        tone,
        href,
        category,
        // The record this notification is about, stored so the bell can resolve the same
        // destination the toast did. The id rather than a resolved url, because a url resolved
        // at push time is frozen against whatever the rules were at that moment and then goes
        // stale silently -- see `notificationTarget`.
        recordId: depositId ?? withdrawalId ?? null,
        v: NOTIFICATION_SHAPE_VERSION,
        read: false,
        timestamp: Date.now()
    };
    notificationStore.push(entry);
    saveNotifications(notificationStore);
    persistNotification(entry);
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
    persistReadState([id]);
}

function markAllNotificationsRead() {
    notificationStore = notificationStore.map((n) => ({ ...n, read: true }));
    saveNotifications(notificationStore);
    // Every id, so locally-originated entries that were never persisted simply fail to match and
    // the server is asked about the ones it issued.
    persistReadState(notificationStore.map((n) => n.id));
    renderNotificationList();
    renderNotificationBell();
}

/**
 * Tell the server that these notifications are read.
 *
 * Local first, always. The reader clicked "mark all read" and the list has to reflect that in this
 * frame; waiting on a request to repaint is the lag this whole area is trying to remove. The
 * request goes out afterwards and its failure is not surfaced -- the next load rehydrates from the
 * server and would show them unread again, which is the correct outcome for a write that did not
 * happen, and much better than a button that appears not to work.
 *
 * Only ids the server issued are sent. A notification that came from the local store and was never
 * persisted has no server id, and asking to read it would be a guaranteed 404.
 */
function persistReadState(ids) {
    const token = getSessionToken();
    if (!token) return;
    const serverIds = ids.filter((id) => typeof id === 'string' && /^\d+$/.test(id));
    if (serverIds.length === 0) return;

    const send = (method, path) => fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {});

    if (serverIds.length === 1) {
        send('PUT', `/api/user/notifications/${encodeURIComponent(serverIds[0])}/read`);
    } else {
        send('PUT', '/api/user/notifications/read-all');
    }
}

function clearAllNotifications() {
    notificationStore = [];
    saveNotifications(notificationStore);
    // "Clear all" is a delete, not a read: the reader asked for these to be gone, and leaving the
    // rows server-side would make the next load put the same list straight back.
    const token = getSessionToken();
    if (token) fetch('/api/user/notifications', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    if (notificationDropdown && !notificationDropdown.hidden) renderNotificationList();
    renderNotificationBell();
}

function dismissNotification(id) {
    notificationStore = notificationStore.filter((n) => n.id !== id);
    saveNotifications(notificationStore);
    const token = getSessionToken();
    if (token && typeof id === 'string' && /^\d+$/.test(id)) {
        fetch(`/api/user/notifications/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        }).catch(() => {});
    }
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
        // Marked read on the way in, whether or not the row is a link. An unread row that
        // navigates away still has to be read -- otherwise reading it by following the link
        // leaves the badge claiming it was never seen.
        const target = notificationTarget({
            category: item.category,
            href: item.href,
            // The stored record, so a notification that was created before this tab opened
            // still resolves to its own receipt rather than falling back to the account list.
            recordId: item.recordId
        });
        if (!item.read) markNotificationRead(item.id);

        if (target) {
            // A real `<a>`, so the destination is in the DOM, middle-click and "open in new
            // tab" work, and the row is reachable by keyboard. It used to be a `div` with a
            // click handler and an `href` that nothing ever set, which is a control that
            // looked live, took focus as nothing, and navigated nowhere.
            const link = document.createElement('a');
            link.className = `notification-item is-${item.tone} ${item.read ? '' : 'unread'} is-link`;
            link.href = target.href;
            // Kept as a real link so the destination is in the DOM and middle-click and
            // "open in new tab" keep working, and intercepted for a plain left click for one
            // reason: a link to the page and fragment already open is a click with no effect at
            // all, and browsers are not consistent about firing `hashchange` for it. The handler
            // defers to the browser for every modified click, which is the same rule
            // `wireCopyLink` uses on the receipt pages.
            link.addEventListener('click', (event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                markNotificationRead(item.id);
                followNotificationTarget(target.href);
            });
            link.innerHTML = `
                <span class="notification-item-icon" aria-hidden="true">${iconSvgFor(item)}</span>
                <div class="notification-item-content">
                    <div class="notification-item-title">${escapeHtml(item.title)}</div>
                    ${item.message ? `<div class="notification-item-message">${escapeHtml(item.message)}</div>` : ''}
                    <div class="notification-item-time">${formatTimeAgo(item.timestamp)}</div>
                </div>
                <span class="notification-item-go" aria-hidden="true">&rarr;</span>
            `;
            fragment.appendChild(link);
            continue;
        }

        const el = document.createElement('div');
        el.className = `notification-item is-${item.tone} ${item.read ? '' : 'unread'}`;
        el.innerHTML = `
            <span class="notification-item-icon" aria-hidden="true">${iconSvgFor(item)}</span>
            <div class="notification-item-content">
                <div class="notification-item-title">${escapeHtml(item.title)}</div>
                ${item.message ? `<div class="notification-item-message">${escapeHtml(item.message)}</div>` : ''}
                <div class="notification-item-time">${formatTimeAgo(item.timestamp)}</div>
            </div>
            <button type="button" class="notification-item-close" aria-label="Dismiss">&times;</button>
        `;
        const closeButton = el.querySelector('.notification-item-close');
        if (closeButton) closeButton.addEventListener('click', () => dismissNotification(item.id));
        fragment.appendChild(el);
    }
    list.appendChild(fragment);
}

/** The icon for a stored notification: its category first, then its tone. */
function iconSvgFor(item) {
    return NOTIFICATION_CATEGORY_ICONS[item.category] || TOAST_ICONS[item.tone] || TOAST_ICONS.info;
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

    // Pull the server's list in the background. Deliberately after the first render rather than
    // instead of it: the local store is painted immediately so the bell is never blank while a
    // request is in flight, and then the server's copy replaces it once it arrives. Waiting for the
    // request before the first render would put a network round trip in front of the header.
    hydrateNotifications();

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
//
// Each one passes the same `category` to the toast and to the bell. They used to pass it only
// to the bell, which is why clicking a notification in the bell navigated nowhere: the store
// had an `href` field and a `window.location.assign` behind it, and nothing ever filled it in.
// The category is now the single thing that decides where a notice goes, and it is set on both
// halves so a toast and its bell entry cannot point at different pages.

function notifyDepositConfirmed(item) {
    const title = 'Deposit credited';
    const message = `${formatBalance(item.amount)} ${item.currency_code || 'USD'} added to your balance.`;
    // The record, not a pre-resolved url: the bell resolves it through the same
    // `notificationTarget` the toast does, so there is one rule and not two copies of it.
    showToast(title, message, { tone: 'success', category: 'deposit', depositId: item.id ?? null });
    pushNotification({
        title,
        message,
        tone: 'success',
        category: 'deposit',
        depositId: item.id ?? null
    });
}

/**
 * Announces a deposit that will not be credited.
 *
 * The one notification that links to the receipt rather than to the history list, and the reason
 * is not a preference. A credit writes a row to `balance_transactions` and a failure writes
 * none -- no money moved, so there is no movement to record -- which means the list this product
 * would otherwise link to has no row to scroll to. A link to a fragment that matches nothing is
 * the exact failure this feature exists to remove, so the destination is chosen from what
 * actually exists for each outcome rather than uniformly.
 *
 * The message leads with the money, not the failure. What a person wants to know first is whether
 * their balance still holds it, and a toast that says "Deposit failed" above a balance card has
 * already been read as a loss.
 */
function notifyDepositRejected(item) {
    const title = 'Deposit not completed';
    const expired = String(item.status || '').toLowerCase() === 'expired';
    const message = expired
        ? `${formatBalance(item.amount)} ${item.currency_code || 'USD'} was not paid before its address expired. `
          + 'Nothing was taken from your balance.'
        : `${formatBalance(item.amount)} ${item.currency_code || 'USD'} was not credited. `
          + 'Nothing was taken from your balance.';
    const href = item.id === null || item.id === undefined
        ? null
        : `/receipt/deposit/${encodeURIComponent(item.id)}`;
    const depositId = item.id ?? null;
    showToast(title, message, { tone: 'error', category: 'deposit_failed', href, depositId });
    // `deposit_failed`, not `deposit`, for the same reason the withdrawals are split by stage: the
    // dedup index is (user, category, record id), so a rejected deposit sharing the credited
    // deposit's category would be swallowed by whichever was written first. The server records
    // this event as `deposit_failed` too, so this collapses into one entry rather than two.
    pushNotification({ title, message, tone: 'error', category: 'deposit_failed', href, depositId });
}

/**
 * Announces a withdrawal the user has just submitted.
 *
 * The wording is the server's, not a sentence written here. `POST /api/user/withdraw` returns
 * `message` and `withdrawalId` and deliberately does not return the amount -- a submission
 * receipt needs no echo of a number the server has already committed, and returning it would be
 * a second place the amount could disagree with the ledger. This function read `item.amount`
 * anyway, so every "Withdrawal submitted" toast read "Your request to withdraw -- is being
 * processed", and it overwrote the one line that actually distinguishes the two outcomes:
 * "Withdrawal sent" versus "queued for review -- funds have not been sent yet".
 *
 * That distinction is the whole reason to announce a submission at all. A user who is told
 * only that a request "is being processed" reasonably believes the money is on its way, and
 * the provider may not have been handed the payout yet.
 */
function notifyWithdrawalSubmitted(result) {
    const title = 'Withdrawal submitted';
    const message = String(result?.message || '').trim()
        || 'Your withdrawal request has been received.';
    // The id, so this notice also lands on the right row. Unlike a payout in flight -- which has
    // no history row and could not be linked -- a *request* writes its ledger row in the same
    // transaction that debits the balance, so the row saying "Withdrawal request queued" exists
    // before this notification is ever built. That row is also the honest answer to the question
    // this notice raises: where is my money right now.
    const withdrawalId = result?.withdrawalId ?? null;
    showToast(title, message, { tone: 'info', category: 'withdrawal_requested', withdrawalId });
    // The category is the stage, not the kind, and it has to match what the server writes for the
    // same event. A client `withdrawal` and a server `withdrawal_requested` are two rows in the
    // dedup index rather than one, so the reader is told they requested a withdrawal twice.
    pushNotification({ title, message, tone: 'info', category: 'withdrawal_requested', withdrawalId });
}

function notifyWithdrawalPaid(item) {
    const title = 'Withdrawal sent';
    const message = `${formatBalance(item.amount)} has been sent to your payment method.`;
    // The withdrawal id, so both halves land on this payout's own receipt. A user who has been
    // told their money was sent and then dropped on the account list is being asked to search
    // for the one row it was in -- at the exact moment they most want to check it arrived.
    showToast(title, message, { tone: 'success', category: 'withdrawal_paid', withdrawalId: item.id ?? null });
    pushNotification({ title, message, tone: 'success', category: 'withdrawal_paid', withdrawalId: item.id ?? null });
}

function notifyWithdrawalFailed(item) {
    const title = 'Withdrawal failed';
    // Composed from the row's state rather than quoted from `failure_reason`. That field is
    // written for an operator -- it is often the provider's own error, naming a third party, an
    // HTTP status and an endpoint path -- and it was being put straight into a toast. Worse, an
    // "Insufficient balance" from a payout provider describes *our* account, not the user's, so
    // read literally the toast told them their own balance was short. The user-facing sentence
    // says the thing they can act on: whether the money is back.
    const message = withdrawalFailureText(item)
        || 'We were not able to send this withdrawal. Any amount taken from your balance has been returned.';
    showToast(title, message, { tone: 'error', category: 'withdrawal_failed', withdrawalId: item.id ?? null });
    pushNotification({ title, message, tone: 'error', category: 'withdrawal_failed', withdrawalId: item.id ?? null });
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

/**
 * Fetch the page a link points at while the pointer is still travelling towards it.
 *
 * Every navigation in here is a full page load -- Express serves these pages as markup and there
 * is no client router -- so a click is a round trip for HTML, a stylesheet, a dozen scripts and a
 * session check before anything appears. That is the "slow" people feel when they click a link on
 * this site, and it is a network wait, not a slow handler: there is nothing in the click path to
 * optimise.
 *
 * So the work moves to the 100-300ms before the click, when the pointer has already committed to
 * a target. `<link rel="prefetch">` is a hint: the browser decides whether to spend the bandwidth,
 * and nothing here waits on it, so a slow or ignored prefetch costs nothing but a wasted request.
 *
 * Three things it deliberately does not do:
 *
 *   - It only prefetches on `pointerover` and `focusin`, both of which mean the reader is already
 *     pointing at or tabbing to that link. `pointerenter` on the document would fire for every link
 *     a cursor sweeps across on the way somewhere else.
 *   - It skips a link to the page already open, including a different fragment on it. Fetching the
 *     current document to satisfy `#history-withdrawal-88` is a whole extra page download for
 *     something the browser handles with no load at all.
 *   - It respects `navigator.connection.saveData`. A reader who has asked for reduced data usage
 *     does not get a background prefetch behind their back, and neither does a reader on a
 *     2G connection -- which is exactly who cannot afford it.
 */
function prefetchLinkedPages() {
    const seen = new Set();
    const connection = navigator.connection;
    // `saveData` is the explicit opt-out. An `effectiveType` of slow-2g is not -- it is a hint
    // about the link, and prefetching is precisely the request that hurts most on that link, so it
    // is honoured too rather than left to a user agent that may reasonably disagree.
    if (connection && (connection.saveData || /^(slow-2g|2g)$/.test(connection.effectiveType || ''))) {
        return;
    }

    const hint = (anchor) => {
        const href = anchor.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        // Only http(s) on this origin. A `mailto:`, a download or a cross-origin link is not
        // something to fetch speculatively, and the href is resolved so a relative one is compared
        // as the destination rather than as the string on the attribute.
        let url;
        try {
            url = new URL(href, window.location.href);
        } catch {
            return;
        }
        if (url.origin !== window.location.origin) return;
        if (!/^https?:$/.test(url.protocol)) return;
        if (url.pathname === window.location.pathname && !url.search) return;
        // A path that ends in a file extension is a download, not a page: `/invoices/2026-09.csv`
        // passes every other check here and would have the reader's browser fetch the whole file
        // because they rested the pointer near it. The export links on the account page are exactly
        // that shape. The heuristic is the last segment's extension rather than a list of known
        // types, because a link added tomorrow with a type nobody enumerated still gets caught.
        if (/\.[a-z0-9]{1,8}$/i.test(url.pathname)) return;
        if (seen.has(url.href)) return;
        seen.add(url.href);

        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = 'document';
        // `fetchpriority` is about the request this hint causes, not the visible one, so it stays
        // low. A prefetch that outranked the page the reader is actually on would make the page
        // slower in order to make the next one faster.
        link.fetchPriority = 'low';
        link.href = url.href;
        document.head.appendChild(link);
    };

    const from = (event) => {
        const anchor = event.target instanceof Element
            ? event.target.closest('a[href]')
            : null;
        if (anchor) hint(anchor);
    };

    document.addEventListener('pointerover', from, { passive: true });
    document.addEventListener('focusin', from);
}

// Ungated, unlike most of this file: the footer and the header are on the public pages too, and a
// reader on `/terms` clicking through to `/privacy` is exactly the navigation this helps.
document.addEventListener('DOMContentLoaded', prefetchLinkedPages);

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

    // A window can be focused while another window sits in front of it, and on some platforms
    // that never fires `visibilitychange` -- the document is never hidden, it is merely not what
    // the reader is looking at. Focusing this window is that reader saying "show me where I am",
    // so it syncs on that too. `focus` does not bubble, hence `addEventListener` on `window`.
    window.addEventListener('focus', () => {
        // Cleared first: a page that was syncing happily while hidden, and then failed twice in
        // the background, would otherwise spend its first focused moments in a backoff it has no
        // reason to still be in. The failure count is what the network restores, not the fact
        // that time passed.
        if (liveState.consecutiveFailures > 0) {
            liveState.consecutiveFailures = 0;
            paintLiveIndicator();
        }
        syncNow();
    });

    // The reconnection case, and the one the backoff made worst. Coming back online is a fact
    // the browser tells us for free, and the old behaviour was to keep waiting out an interval
    // that could be up to two minutes -- so the network returned and the page sat there still
    // announcing a lost connection, refusing to update, until the backoff expired. The event is
    // the answer; waiting for it to expire was never the plan.
    window.addEventListener('online', () => {
        liveState.consecutiveFailures = 0;
        paintLiveIndicator();
        syncNow();
    });

    // Worth saying out loud. `navigator.onLine === false` is a real, immediate, trustworthy
    // signal that the browser itself is offline -- and it is the one state where the honest
    // message is "You are offline", not "the connection to the site was lost". Those send the
    // reader to different places: one to their wifi, the other to a page reload.
    window.addEventListener('offline', () => {
        paintLiveIndicator();
    });

    // A session that goes away should stop the loop rather than keep failing against an
    // endpoint with a dead token until the tab is closed.
    window.addEventListener('pagehide', stopLiveSync);
    // ...and coming back has to start it again, or the stop above is permanent. `pagehide` also
    // fires when a page enters the back/forward cache, and a page restored from there never
    // re-runs this script -- so without this the balance sat frozen at whatever it was when the
    // user clicked away, with the indicator still reading "Live", for the rest of that page's
    // life. Back is exactly the gesture people use to come back and check their money.
    window.addEventListener('pageshow', (event) => {
        // `persisted` is true only for a bfcache restore. A normal load is already starting the
        // loop from above, and starting it twice would leave two timers racing.
        if (event.persisted) startLiveSync();
    });
});

function startLiveSync() {
    window.clearTimeout(liveState.timer);
    liveState.timer = undefined;
    // Cleared, because a stop set by `stopLiveSync` is what a start is undoing. Without this the
    // two cannot be called in any order.
    liveState.stopped = false;
    liveState.consecutiveFailures = 0;
    if (!getSessionToken()) {
        paintLiveIndicator();
        return;
    }
    syncNow();
}

function stopLiveSync() {
    liveState.stopped = true;
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
    /**
     * Whether the loop has been deliberately stopped.
     *
     * Clearing the timer is not enough on its own: `syncNow` reschedules itself from a
     * `finally`, so a stop requested while a request was still in flight got undone when that
     * request settled. `scheduleLiveSync` honours this instead, which is what makes the auth
     * path actually stop instead of resuming against a session it has already discarded.
     */
    stopped: false,
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
    /**
     * Ledger rows already announced, by id.
     *
     * Needed because a credit can be announced by its deposit row, by its withdrawal refund
     * row, or by the ledger entry that explains it -- and the same credit is present in more
     * than one of those lists. Without this the $10 would be announced once as a deposit
     * credit and again as a reward.
     */
    seenTransactionIds: new Set(),
    /**
     * Whether any update has been applied yet. The first one seeds the announcement state
     * instead of reporting everything the account has already been credited.
     */
    seeded: false
};

/**
 * How long one sync request is given before it is abandoned.
 *
 * Without a ceiling, a request that never settles -- a laptop lid closing, a phone leaving wifi
 * mid-request, a proxy holding the connection open -- is worse than a failed one. A failure
 * rejects, `finally` runs, the loop reschedules and the next attempt recovers. A hang does none
 * of that: `liveState.busy` stays true forever, so every later `syncNow` returns at its first
 * line, and the `finally` that would have rescheduled it never runs at all. The balance freezes
 * silently and never recovers, with nothing on screen to say so. That is the difference between
 * a blip the user rides out and a page that needs reloading.
 *
 * Longer than the 20s idle interval on purpose: a request this slow is not going to produce
 * anything useful, and aborting it early buys a retry rather than a result.
 */
const LIVE_SYNC_TIMEOUT_MS = 20000;

/**
 * How many failed polls in a row it takes to call the connection lost.
 *
 * It used to take one. A phone changing network, a single slow response, a proxy hiccup -- each
 * of those painted "Connection lost" immediately and started the backoff, so the page announced
 * a broken connection for a blip that was over before the user could read it, and then spent the
 * next two minutes waiting out an interval it had grown purely in response to the blip. The
 * indicator and the backoff were both answering a question nobody asked: not "has this stopped
 * working" but "did this fail at all".
 *
 * Two is the point where the pattern is a pattern. One failure still retries promptly.
 */
const LIVE_SYNC_FAILURE_THRESHOLD = 2;

/** Whether the sync has failed often enough, in a row, to be worth telling the user about. */
function liveConnectionFailing() {
    return liveState.consecutiveFailures >= LIVE_SYNC_FAILURE_THRESHOLD;
}

/** How long to wait before the next check, given whether something is outstanding. */
function liveIntervalMs() {
    // Sustained failure first, and unconditionally. The deposit fast-path used to be checked
    // ahead of it, which meant a deposit in progress pinned the interval at five seconds no
    // matter how badly the connection was failing -- so the one moment the loop is guaranteed to
    // be running is the one moment it cannot back off.
    if (liveConnectionFailing()) {
        // Capped at 30s, not the two minutes it used to reach. A long cap is right for a client
        // that has nothing better to do and wrong for a balance page: two minutes of a figure
        // that is known not to be current is a long time to look at a wrong number, and there is
        // no state in this app where two minutes of staleness is better than thirty seconds of
        // one request.
        return Math.min(
            30000,
            4000 * 2 ** Math.min(3, liveState.consecutiveFailures - LIVE_SYNC_FAILURE_THRESHOLD)
        );
    }
    // Faster than the twenty seconds it was. This endpoint answers a single indexed lookup and
    // an unchanged account costs a 304 with no body, so the interval was trading a real delay in
    // every balance, deposit and withdrawal update for a saving nobody was asking for.
    if (liveState.awaitingDeposit) return 3000;
    return 8000;
}

function scheduleLiveSync() {
    // Respects a stop. It has to be checked here rather than only where the timer is cleared,
    // because `syncNow` reschedules from a `finally`, and a stop requested while a request was
    // in flight would otherwise be undone by that `finally` -- the loop restarting seconds after
    // it was stopped, which is what made the auth path below keep polling a session it had
    // already thrown away.
    if (liveState.stopped) return;
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
    // A hung request is indistinguishable from a slow one from here, and only the second is
    // worth waiting for, so the request is given a ceiling. See `LIVE_SYNC_TIMEOUT_MS`.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abortTimer = controller
        ? window.setTimeout(() => { controller.abort(); }, LIVE_SYNC_TIMEOUT_MS)
        : undefined;
    try {
        const response = await fetch(`/api/user/updates${liveState.version ? `?version=${encodeURIComponent(liveState.version)}` : ''}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
            // Absent where `AbortController` is unsupported rather than passed as undefined, so
            // the request is made exactly as it was before.
            ...(controller ? { signal: controller.signal } : {})
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
        // Released first: an aborted request whose timeout is not cleared keeps the timer alive
        // for the full window after the loop has already moved on.
        if (abortTimer !== undefined) window.clearTimeout(abortTimer);
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
/**
 * Announces money returning to the balance, and links to the withdrawal that explains it.
 *
 * The link is the reason this can resolve a destination at all: a refund row's `source_id` is
 * `withdrawal:<id>`, which is the one ledger shape that names the record it belongs to, so the
 * row id is derivable without the server adding a field. Everything else in the live payload is
 * keyed on shapes that cannot say which withdrawal they are for.
 */
function announceLedgerRefund(entry, amount) {
    const match = /^withdrawal:(\d+)$/.exec(String(entry.source_id || '').trim());
    const title = 'Refund received';
    const message = `${formatBalance(amount)} returned to your balance.`;
    const options = match
        ? {
            tone: 'info',
            // `withdrawal_failed`, not `withdrawal`: the live ledger poll sees the refund the
            // server already recorded as a failed withdrawal, and any other category is a second
            // row in the dedup index -- so the reader would see the refund announced once by the
            // server and once by this poll.
            category: 'withdrawal_failed',
            withdrawalId: match[1]
        }
        : { tone: 'info', category: 'reward' };
    showToast(title, message, options);
    // The bell entry carries the id rather than a resolved link, so `notificationTarget` can
    // rebuild the destination from the row that is actually there. See `pushNotification`.
    pushNotification({
        title,
        message,
        tone: options.tone,
        category: options.category,
        ...(match ? { withdrawalId: match[1] } : {})
    });
}

function applyLiveUpdate(payload) {
    // The very first update establishes what already happened rather than reporting it.
    //
    // Without this, opening the page fires a toast for every reward the account has ever been
    // paid -- twenty of them, at once, for a reward that arrived last month. The first payload
    // is the state of the world as the page found it, so every row in it is marked seen without
    // being announced, and only rows that appear *after* this point are events.
    //
    // This is the same seeding the deposit path does with `creditedDepositsSeen`, and it is why
    // the flag is per-page-load rather than persisted: a reload should not replay history, but
    // it should also announce a reward that landed while the tab was closed.
    const firstUpdate = !liveState.seeded;
    liveState.seeded = true;

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
    //
    // On the first update every row is seeded, whether or not it is announced. Without that,
    // opening a tab for an account with any deposit history fired "Deposit credited" once per
    // historical deposit -- the toast burst the `firstUpdate` note above describes, which had
    // been applied to the ledger rows and never to these two loops. The guard is
    // `isEventSinceLastSeen` rather than a blanket "skip the first update", so a credit that
    // landed while the tab was closed is still announced: it happened after the last moment
    // this browser was told about, which is the definition of an event.
    for (const item of deposits) {
        const status = String(item.status || '').toLowerCase();
        const credited = status === 'confirmed' || status === 'paid';
        // A deposit that will never be credited is as much of an event as one that was. The user
        // has money out of their account and nothing to show for it, and the only thing this
        // product says about that is a status word in a list. Its destination is the receipt
        // rather than the history row, and the reason is structural rather than a preference: a
        // failed deposit writes no ledger row, because no money moved, so there is no row in the
        // list to scroll to. The receipt is the one page that can show what went wrong and when.
        const rejected = status === 'failed' || status === 'expired';
        if (!credited && !rejected) continue;

        const state = credited ? 'credited' : 'rejected';
        if (depositStateSeen(item.id, state)) continue;
        depositStateSeen(item.id, state);
        if (firstUpdate && !isEventSinceLastSeen(credited ? item.credited_at : item.updated_at)) continue;

        if (credited) {
            // Announce the credit everywhere: when the dialog is open the user sees the
            // success screen, otherwise they get just the toast and bell so the money
            // arriving is an event, not a number they have to be watching for.
            if (isDialogOpen('deposit-dialog')) {
                showDepositSuccess(item);
            } else {
                notifyDepositConfirmed(item);
            }
        } else {
            notifyDepositRejected(item);
        }
    }

    // A withdrawal reaching a terminal state is announced the same way, and for the same
    // reason: the user is elsewhere on the page and should not have to poll their history
    // to learn their money left or was returned. Only the transitions into paid and failed
    // are announced -- a request sitting in `pending` is not an event, and saying so on
    // every poll would be noise.
    //
    // The event time differs per state on purpose. `paid_at` is when the money left, which is
    // what the user cares about and what `isEventSinceLastSeen` should be comparing. A failure
    // has no `paid_at`, and `updated_at` is the only record of when it was refused.
    for (const item of withdrawals) {
        const status = String(item.status || '').toLowerCase();
        const seenStatus = status === 'paid' ? 'paid' : status === 'failed' ? 'failed' : null;
        if (!seenStatus || withdrawalStateSeen(item.id, seenStatus)) continue;
        markWithdrawalSeen(item.id, seenStatus);
        if (firstUpdate && !isEventSinceLastSeen(status === 'paid' ? item.paid_at : item.updated_at)) continue;
        if (seenStatus === 'paid') {
            notifyWithdrawalPaid(item);
        } else {
            notifyWithdrawalFailed(item);
        }
    }

    // A balance can go up for reasons that have nothing to do with finishing an offer: an
    // operator correcting a row, a bonus, a migration, a test credit inserted by hand in the
    // database. The previous version of this code compared the balance delta against the
    // deposits and withdrawals it had already announced and, for anything left over, said
    // "Reward credited -- $10.00 credited to your balance from a completed offer." That is a
    // guess, and it was wrong every time the cause was not an offer: the only conclusion
    // available from a number was a hard-coded one, and a hand-inserted $10 came back as an
    // offer the user never completed.
    //
    // The server now sends the ledger rows that caused the change, so the cause is read rather
    // than inferred. A `conversion` is an offer reward and is announced as one. Anything else
    // -- an `adjustment`, a `bonus`, a row with no type this client knows -- is announced with
    // whatever description the ledger carries, or not at all if there is nothing to say.
    const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
    let newLedgerRows = 0;
    for (const entry of transactions) {
        const id = String(entry?.id ?? '');
        if (id && liveState.seenTransactionIds.has(id)) continue;
        if (id) {
            liveState.seenTransactionIds.add(id);
            newLedgerRows += 1;
        }

        // Seeded rather than announced on the first update. See the `firstUpdate` note above.
        if (firstUpdate) continue;

        const amount = Number(entry?.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        // A refund is money coming *back*, and it was announced by nobody. The comment below used
        // to say a debit "is a withdrawal, and the withdrawal list already has its own
        // announcement for that" -- which was true of a payout that completes, because
        // `notifyWithdrawalPaid` fires from the webhook. It was not true of the refund, which is
        // written by a payout *run* rather than a webhook and therefore has no client-side
        // caller at all: the only trace it left was a row in the ledger. So when a withdrawal was
        // abandoned because the provider could not fund it, the user's money came back and the
        // page said nothing about it.
        if (entry.transaction_type === 'refund') {
            announceLedgerRefund(entry, amount);
            continue;
        }

        // Only a credit is an event worth announcing. A debit here is a withdrawal request, and
        // the withdrawal list already announces the one that matters -- the payout.
        if (entry.transaction_type !== 'conversion') continue;
        // The description is the ledger's own words for what paid out, which is more useful
        // than a fixed sentence and is what makes an offer reward read as an offer reward.
        const what = String(entry.description || '').trim() || 'a completed offer';
        // Demo and real rewards are the same event with a different balance behind it, so they
        // are announced from the same row. The only difference is which one the user can spend,
        // and saying so is the difference between a useful notice and one that overstates what
        // just happened to their money.
        const isDemo = entry.is_demo === true;
        const title = isDemo ? 'Demo reward credited' : 'Reward credited';
        // "your demo balance", not "your balance" with "demo" in front of the amount. A demo
        // credit does not reach the balance the user can spend, and the sentence is the only
        // thing that says which balance changed -- so the two wordings have to differ in the
        // phrase that carries the meaning, not by a word inserted earlier in the line. That also
        // keeps them distinguishable to anything reading the text, which is what stops a demo
        // reward being reported as spendable money.
        const balanceLabel = isDemo ? 'your demo balance' : 'your balance';
        const message = `${formatBalance(amount)} added to ${balanceLabel} from ${what}.`;
        showToast(title, message, { tone: isDemo ? 'info' : 'success', category: 'reward' });
        pushNotification({
            title,
            message,
            tone: isDemo ? 'info' : 'success',
            category: 'reward',
            href: NOTIFICATION_TARGETS.reward.href
        });
    }

    // Update the tracked previous balances. Nothing announces from them any more -- the demo
    // notice above reads a ledger row, so it is keyed on that row's id and cannot fire twice
    // for one reward the way a difference between two numbers could.
    // `balance` can be `null` for demo-only accounts; coerced so the value is a number.
    if (typeof payload.balance === 'string' || payload.balance === null) {
        liveState.lastKnownBalance = payload.balance === null ? 0 : Number(payload.balance);
    }
    if (typeof payload.demoBalance === 'string') {
        liveState.lastKnownDemoBalance = Number(payload.demoBalance);
    }

    // Tell the history page that the ledger moved, so it refetches instead of waiting for a
    // reload. This is the whole real-time path for that list: `/api/user/updates` already runs
    // on a timer and already carries the rows that changed, so the list does not need a second
    // poller of its own competing with it for the same request.
    //
    // Keyed on ledger rows this payload actually introduced, which is what the comment above
    // this dispatch always claimed it did. `transactions.length > 0` is not that test: the
    // endpoint returns the twenty most recent ledger rows, so for any account with a single
    // transaction the length is twenty on every poll forever, and the list was refetching every
    // five seconds for a result that could not differ. A deposit moving from `processing` to
    // `confirmed` adds no ledger row, so it correctly does not refetch the transaction list --
    // it changes the deposit list, which `applyLiveUpdate` has already redrawn above.
    if (newLedgerRows > 0) {
        window.dispatchEvent(new CustomEvent('offerNetwork:historyChanged', {
            detail: { version: payload.version }
        }));
    }

    // Everything in this payload has now been judged and either announced or deliberately
    // skipped, so "now" is the point any later tab should measure new events against. Written
    // at the end rather than the start, so a payload that throws partway through cannot leave
    // a timestamp claiming the user was told about things the rest of this function never got
    // to announce.
    writeLastSeenAt(Date.now());
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
        note.textContent = `Credited to your balance on ${formatDateTime(deposit.credited_at || deposit.created_at)}.`;
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
    const failing = liveConnectionFailing();
    const waiting = liveState.awaitingDeposit;
    indicator.classList.toggle('is-stale', failing);
    indicator.classList.toggle('is-waiting', waiting && !failing);
    // A separate state, because it is a different fact with a different remedy. "Connection lost"
    // sends someone to reload the page or blame the site; "You are offline" sends them to their
    // wifi. The browser already knows this one -- `navigator.onLine` is answered from the OS, not
    // inferred -- so there is nothing to guess at and no reason to report it as a server problem.
    if (navigator.onLine === false) {
        indicator.textContent = 'You are offline';
        indicator.classList.add('is-stale');
        return;
    }
    if (failing) {
        // Guarded, because `lastSyncedAt` starts at 0 and the first failure can arrive before any
        // success has ever set it. Unguarded, the arithmetic below reported how long it had been
        // since the epoch -- "last updated 1789000000s ago" -- on a page that had simply never
        // reached the server yet. "Retrying" is the true statement for that state.
        const seconds = liveState.lastSyncedAt
            ? Math.round((Date.now() - liveState.lastSyncedAt) / 1000)
            : 0;
        indicator.textContent = seconds > 0
            ? `Connection lost - last updated ${seconds}s ago`
            : 'Connection lost - retrying';
        return;
    }
    indicator.classList.remove('is-stale');
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

    const failing = liveConnectionFailing();
    const waiting = liveState.awaitingDeposit;
    const seconds = balanceChangedAt ? Math.round((Date.now() - balanceChangedAt) / 1000) : null;

    let wording;
    let tone;
    if (navigator.onLine === false) {
        // The same distinction the header indicator makes, for the same reason. This number is
        // stale because the reader has no network, which is a different sentence from the site
        // having stopped answering, and it needs a different response.
        tone = 'is-stale';
        wording = 'You are offline - balance may be out of date';
    } else if (failing) {
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
 * Whether this tab has already reacted to losing its session.
 *
 * Read and written only by `handleUnauthorized`, and never reset. See the note there.
 */
let sessionExpiryHandled = false;

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

    // Only the first 401 does the work. Several requests are in flight whenever this happens --
    // the live sync, a history fetch, a balance read -- and they all come back 401 together.
    // Each one used to run the whole handler: sign out, push a "Session expired" toast, push a
    // bell entry, open the sign-in dialog. So an expired session produced a stack of identical
    // toasts and several sign-in dialogs fighting over the same modal, and the visitor's first
    // impression of signing in was a pile of duplicates.
    //
    // The flag is deliberately never reset. A tab that has lost its session has lost it, and
    // signing in again navigates, so re-arming this would only serve the case where a new
    // session in the same document expires again -- which is not reachable without a reload.
    if (sessionExpiryHandled) return true;
    sessionExpiryHandled = true;

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
 * query to keep in step with the first.
 *
 * The export asks for the endpoint's ceiling rather than the page's window. The list on the
 * account page is five rows at a time for readability, which is the wrong number for a file --
 * an export that quietly covered one page would be indistinguishable from an account with five
 * transactions, and the user has no way to tell which they have. Five hundred is the endpoint's
 * own `HISTORY_MAX_LIMIT`, and if a user ever exceeds it the count in the confirmation is the
 * real number of rows written rather than the total, so a truncated file says so.
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
        const rows = await requestJson('/api/user/history?limit=500', {
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

    // The counter, from the field's own `maxlength` rather than a number written out here, so it
    // cannot disagree with the limit the input actually enforces. `[...value].length` rather than
    // `value.length`, because a 60-character limit counted in UTF-16 code units tells an emoji
    // user they have 60 characters available and then refuses them at 30.
    const counter = document.getElementById('profile-name-count');
    if (counter) {
        const limit = Number(nameInput.getAttribute('maxlength')) || 0;
        const used = [...(nameInput.value || '')].length;
        counter.textContent = limit ? `${used} / ${limit}` : '';
        // Warning well before the limit, and not at it: the browser silently refuses the
        // characters past the end, so by the time the count reads the limit the user has already
        // been stopped typing without being told why.
        counter.classList.toggle('is-warning', limit > 0 && used >= limit - 10);
    }

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
            // The refund is the fact that matters here and it is already said. Appending
            // `failure_reason` added the provider's error to it, so the row read "Returned to your
            // balance on Sep 30 · NOWPayments /v1/payout returned 400.: Insufficient balance" --
            // a completed, settled outcome trailed by a third party's HTTP error.
            return outcome;
        }
        return item.payment_address
            ? `${item.payment_address} · ${new Date(item.created_at).toLocaleDateString()}`
            : new Date(item.created_at).toLocaleDateString();
    }
    if (item.status === 'confirming' || item.status === 'pending') {
        // A partial payment is the case this branch was written for and the case it got
        // wrong. The provider reported an arrival that is smaller than the invoice, and the
        // row said only "Waiting for the payment provider to confirm" -- so a customer who had
        // sent 0.0076 of an expected 0.0083 SOL, and who could see the money in their wallet,
        // was told the system had not seen anything at all. The two amounts are what let them
        // work out whether the shortfall is the fee or a wrong transfer, which is the only
        // reason to look at the row.
        const received = String(item.actually_paid ?? '').trim();
        const expected = String(item.pay_amount ?? item.amount ?? '').trim();
        if (received && Number(received) > 0) {
            const ticker = String(item.pay_currency || item.asset_code || '').toUpperCase();
            const receivedText = coinAmount(received, ticker);
            const expectedText = coinAmount(expected, ticker);
            return expectedText && expectedText !== receivedText
                ? `${receivedText} of ${expectedText} received · still waiting for the rest`
                : `${receivedText} received · waiting for the payment provider to confirm`;
        }
        return 'Waiting for the payment provider to confirm';
    }
    return item.network
        ? `${item.asset_code} on ${item.network}`
        : new Date(item.created_at).toLocaleDateString();
}

/**
 * The Cancel control on a cancellable withdrawal row.
 *
 * Confirmation is not optional here. Cancelling returns real money to the balance, and it is
 * irreversible in the way that matters: a user who cancels a request they meant to keep has to
 * ask for it again, wait again, and pay any fee twice. `confirm` is used rather than a custom
 * dialog because it is the one prompt that cannot be styled into looking non-destructive, which
 * is the point.
 */
function buildCancelWithdrawalButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-ghost history-cancel';
    button.textContent = 'Cancel';
    // The accessible name carries the amount, because "Cancel" alone is ambiguous when the
    // dialog lists several withdrawals and a screen reader user has just heard "Cancel" with
    // no indication of what it applies to.
    button.setAttribute(
        'aria-label',
        `Cancel withdrawal #${item.id} of ${formatBalance(item.amount)} and return it to your balance`
    );

    button.addEventListener('click', () => {
        cancelWithdrawal(item, button);
    });

    return button;
}

/**
 * Cancels a withdrawal and reflects the result.
 *
 * The button is disabled for the duration so a second click cannot race the first into two
 * requests. The server is idempotent about the money -- the second attempt finds a `cancelled`
 * row and refuses -- but two in-flight requests would produce one success and one confusing
 * 409, and the user would see an error on an action that worked.
 */
async function cancelWithdrawal(item, button) {
    const token = getSessionToken();
    if (!token) return;

    const amount = formatBalance(item.amount);
    const confirmed = window.confirm(
        `Cancel this withdrawal of ${amount}? `
        + `${amount} goes straight back to your balance. `
        + 'This cannot be undone, and sending it again means starting over.'
    );
    if (!confirmed) return;

    if (button) button.disabled = true;
    try {
        const result = await requestJson(`/api/user/withdrawals/${encodeURIComponent(item.id)}/cancel`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });

        if (result && result.balance !== undefined && result.balance !== null) {
            applyBalance(result.balance, accountState.demoBalance ?? '0');
        }
        showToast('Withdrawal cancelled', `${amount} is back in your balance.`, {
            tone: 'success',
            // The account page is where the refund is visible in the list; without this the
            // notice reported a balance change the user then had to go and find.
            category: 'withdrawal',
            // And the id, so the same event the server records as `withdrawal_failed` when it
            // refunds the row collapses into one bell entry. A bare category here is a link to
            // the account page with nothing to scroll to, and -- because the write-back needs a
            // record id -- a notification that is never persisted at all.
            withdrawalId: item.id ?? null
        });
        refreshWithdrawalViews();
    } catch (error) {
        if (handleUnauthorized(error)) return;
        showToast(
            'Could not cancel this withdrawal',
            error.message || 'Please try again, or contact support.',
            { tone: 'error' }
        );
        // Re-enabled so a refusal the user can act on -- a payout that has already been sent --
        // does not leave a dead control on the row.
        if (button) button.disabled = false;
    }
}

/**
 * Reloads the withdrawal list wherever it is on screen.
 *
 * Both the dialog's own list and the live-sync copy come from the same data, and the row that
 * was just cancelled should read "Refunded" in both. Repainted through the existing loaders
 * rather than patched in place so a cancelled row cannot linger with a Cancel button on it.
 */
function refreshWithdrawalViews() {
    if (isDialogOpen('withdraw-dialog')) {
        loadPaymentHistory('/api/user/withdrawals', 'withdrawal-history', 'withdrawal');
    }
    syncNow();
}

/**
 * The status badge for a withdrawal, which is not the same question as the status for a
 * deposit.
 *
 * A withdrawal row has two independent lives: ours (`pending` -> `processing` -> `paid`) and
 * the provider's payout. They disagree in the ordinary case, because the payout reaches
 * `FINISHED` before our reconciler has run, and reading only the first gave "Processing" under
 * a transfer that had already landed. Where the provider has spoken, its stage wins -- it is
 * the finer and more recent fact -- and the refund ledger still wins over both, because
 * "Refunded" is a claim about the user's balance and nothing else overrides it.
 */
function withdrawalBadgeLabel(item, payoutState) {
    if (item.refunded_at) return 'Refunded';
    if (payoutState === 'FINISHED') return 'Sent';
    if (payoutState && ['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED'].includes(payoutState)) {
        return 'Not sent';
    }
    // Our own `processing` is only worth showing when the provider has not reported anything
    // yet; otherwise it understates a transfer that is already queued or on the network.
    if (String(item.status || '').toLowerCase() === 'processing' && payoutState) return 'In progress';
    return statusLabels[String(item.status || '').toLowerCase()] || String(item.status || '');
}

/**
 * Formats a coin amount with its ticker, tolerating a missing value.
 *
 * `payout_coin_amount` and `payout_fee_coin` are strings from the provider held as text, so
 * they are shown exactly as recorded rather than run through a currency formatter that would
 * round a 0.000612 SOL fee to $0.00 and make the user think they were charged nothing.
 */
function coinAmount(value, currency) {
    const amount = String(value ?? '').trim();
    if (!amount) return '';
    const ticker = String(currency || '').trim().toUpperCase();
    return ticker ? `${amount} ${ticker}` : amount;
}

/**
 * A timestamp for the details list, or an empty string when it never happened.
 *
 * Absent rather than "Pending": a row that has not been sent yet has no submission time, and
 * printing a dash for a fact that does not exist reads as a missing record.
 */
/**
 * A timestamp, in words, on a twelve-hour clock.
 *
 * `hour12` is set explicitly rather than left to the browser's locale. Left alone it follows
 * whatever the operating system is set to, so the same withdrawal read "4:16 PM" for one reader
 * and "16:16" for the next -- and a 24-hour clock is one a lot of people read as military time
 * rather than as a time. A transaction record is kept and compared, so it should not change
 * shape with the reader's machine settings.
 *
 * The date stays in the reader's own locale; only the clock format is pinned. That is the
 * narrowest change that fixes the complaint: somebody who prefers 24 hours can still change the
 * number by changing their locale, and nobody gets a date in a format they cannot read.
 */
function detailTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * A timestamp with its date, on a twelve-hour clock. Same reasoning as `detailTime`.
 */
function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

/**
 * The per-withdrawal detail disclosure.
 *
 * This is the answer to "I want to see all the status on a withdrawal". The history row has
 * to stay one compact line in a list of twenty, and it is also the only place the amount sent
 * on-chain, the network fee, the destination address and the transaction reference all exist --
 * four numbers and two addresses that used to be visible nowhere in the product, so a user
 * reconciling against their exchange wallet had nothing to compare.
 *
 * A native `<details>`/`<summary>` rather than a button and a div: it is already keyboard
 * operable, already announced as a disclosure with its expanded state, and it needs no
 * JavaScript to stay operable. The expanded state does have to be carried across a repaint,
 * because `renderHistoryInto` rebuilds these rows on every live update -- see
 * `openDetailIdsFor` -- so a hand-rolled toggle is not the alternative being avoided here, it
 * is the same amount of state in a place with no accessibility built in.
 */
function buildWithdrawalDetails(item) {
    const payoutCurrency = item.payout_currency || item.asset_code || '';
    const rows = [
        ['Amount requested', formatBalance(item.amount)],
        ['Method', item.payment_method === 'crypto'
            ? `${item.asset_code || ''}${item.network ? ` on ${item.network}` : ''}`.trim()
            : (item.payment_method || 'Card')],
        ['Sent', coinAmount(item.payout_coin_amount, payoutCurrency)],
        ['Network fee', coinAmount(item.payout_fee_coin, payoutCurrency)],
        ['Destination', item.payout_address || item.payment_address || ''],
        ['Transaction reference', item.provider_reference || ''],
        ['Requested', detailTime(item.created_at)],
        ['Sent to provider', detailTime(item.payout_submitted_at)],
['Payout stage', payoutStageLabel(item)],
            ['Confirmed', detailTime(item.paid_at)],
            ['Refunded', detailTime(item.refunded_at)],
            ['Reason', withdrawalFailureText(item)]
        ].filter(([, value]) => value);
    // Nothing but the amount is known until the user asks for it: a withdrawal that has not
    // been claimed has no payout stage, no reference and no timestamps, and a disclosure that
    // opened onto three near-empty lines is worse than no disclosure.
    if (rows.length <= 2) return null;

    const details = document.createElement('details');
    details.className = 'history-detail';
    // The id the render paths key the restored open state on. `id` is enough to key it, but
    // `data-` says plainly that this is a hook and not a lookup, and it keeps the value out
    // of the `id`/`for` pairing the label checks look at.
    details.dataset.withdrawalId = String(item.id);

    const summary = document.createElement('summary');
    summary.className = 'history-detail-summary';
    summary.textContent = 'Details';
    details.append(summary);

    const list = document.createElement('dl');
    list.className = 'history-detail-list';
    for (const [name, value] of rows) {
        const term = document.createElement('dt');
        term.className = 'history-detail-label';
        term.textContent = name;
        const definition = document.createElement('dd');
        definition.className = 'history-detail-value';
        // A destination address and a transaction reference are both unbreakable runs of
        // 40-90 characters. Left as plain text they overflow the row and push the badge out
        // of alignment, so they wrap; the full value is still in the DOM for copying.
        definition.textContent = value;
        if (name === 'Destination' || name === 'Transaction reference') {
            definition.classList.add('history-detail-mono');
        }
        list.append(term, definition);
    }

    // The links out of the row: the receipt, and the blockchain.
    //
    // A settled withdrawal is the one row on this page that refers to money on a chain, and the
    // transaction hash was previously visible only as a wall of monospace text with nothing to
    // do with it. The whole point of having the hash is to be able to check it, so the ability
    // to check it belongs next to the hash rather than in a second tab the user has to find.
    //
    // The urls are the server's, not built here: the chain table lives in one place, and a
    // client-side copy is a second one to get wrong -- and a wrong one links to a transaction
    // that was never on any chain.
    const actions = document.createElement('div');
    actions.className = 'history-detail-links';
    let hasAction = false;

    if (item.receipt_url) {
        const receipt = document.createElement('a');
        receipt.className = 'history-detail-link';
        receipt.href = item.receipt_url;
        receipt.textContent = 'View receipt';
        actions.append(receipt);
        hasAction = true;
    }

    // The explorer link, transaction first.
    //
    // Only the transaction is offered when there is one. A wallet address is a different page on
    // the same site, answering "has anything arrived here" rather than "did my payment go
    // through", and putting the two side by side under one label is how a reader ends up checking
    // an address and concluding their money is missing when it is sitting in a transaction they
    // never opened. The address link is offered only when there is no transaction to show.
    const explorer = item.explorer || {};
    const hasTx = Boolean(explorer.transactionUrl);
    const explorerHref = explorer.transactionUrl || explorer.addressUrl;
    if (explorerHref) {
        const tx = document.createElement('a');
        tx.className = 'history-detail-link';
        tx.href = explorerHref;
        tx.textContent = hasTx
            ? `View transaction on ${explorer.explorerName || 'blockchain'}`
            : `View deposit address on ${explorer.explorerName || 'blockchain'}`;
        // A new tab, and no opener. The explorer is a third party and this is the one link on
        // the page that leaves the site entirely.
        tx.target = '_blank';
        tx.rel = 'noopener noreferrer';
        actions.append(tx);
        hasAction = true;
    }
    if (hasAction) {
        list.append(actions);
    }

    details.append(list);
    return details;
}

/**
 * Renders one history row.
 *
 * Extracted from the loader so the live sync and the initial load draw the same thing. Two
 * copies of this markup is how a row ends up showing "Refunded" in one place and "Failed"
 * in the other.
 */
/**
 * The full record for a deposit, and the explorer link out of it.
 *
 * A deposit row had no disclosure at all, so the only way to see a blockchain link for one was to
 * open the receipt -- which is a second page, from a second click, for the one fact a person is
 * looking for when they look at a deposit row: did this arrive, and can I check it myself. A
 * withdrawal got exactly this treatment; a deposit, which is the row people check far more often,
 * did not.
 *
 * Shaped like `buildWithdrawalDetails` and keyed on `data-deposit-id`, so the two disclosures
 * restore their open state independently. A single `data-record-id` would collide: a withdrawal of
 * id 12 and a deposit of id 12 are different records in different tables, and a shared key would
 * open both when the reader opened one.
 */
function buildDepositDetails(item) {
    const status = String(item.status || '').toLowerCase();
    // An unpaid deposit is a live instruction, not a record, and the row already says "waiting"
    // with the address on it. What is not known yet is everything the disclosure would show, so
    // opening onto a near-empty list is the same dead end the withdrawal one avoids.
    const rows = [
        ['Amount', formatBalance(item.amount)],
        item.pay_amount ? ['Sent', `${item.pay_amount} ${item.pay_currency || item.asset_code || ''}`.trim()] : null,
        // Recorded when the provider reported less than the quote. The difference between what was
        // sent and what was credited is the question a short payment raises, and without the two
        // side by side the answer has to be worked out by hand from the receipt.
        item.actually_paid !== null && item.actually_paid !== undefined
            ? ['Actually received', `${item.actually_paid} ${item.pay_currency || item.asset_code || ''}`.trim()]
            : null,
        ['Network', item.network || ''],
        ['Address', item.deposit_address || ''],
        ['Created', detailTime(item.created_at)],
        status === 'confirmed' || status === 'paid' ? ['Credited', detailTime(item.credited_at)] : null
    ].filter((row) => row && row[1]);

    // An unpaid deposit is skipped entirely: the row already carries the address and the "waiting"
    // status, and there is no record to disclose.
    if (item.deposit_address && (status === 'pending' || status === 'confirming')) return null;
    if (rows.length <= 2) return null;

    const details = document.createElement('details');
    details.className = 'history-detail';
    details.dataset.depositId = String(item.id);

    const summary = document.createElement('summary');
    summary.className = 'history-detail-summary';
    summary.textContent = 'Details';
    details.append(summary);

    const list = document.createElement('dl');
    list.className = 'history-detail-list';
    for (const [name, value] of rows) {
        const term = document.createElement('dt');
        term.className = 'history-detail-label';
        term.textContent = name;
        const definition = document.createElement('dd');
        definition.className = 'history-detail-value';
        // A wallet address or a transaction hash is one unbreakable run of 40-90 characters. Left
        // as plain text they overflow the row, so they wrap; the full value is still in the DOM
        // for copying.
        definition.textContent = value;
        if (name === 'Address' || name === 'Transaction reference') {
            definition.classList.add('history-detail-mono');
        }
        list.append(term, definition);
    }
    details.append(list);

    // The transaction, not the address. The address is what the reader already has on the row; the
    // transaction is the thing they cannot get from this page any other way, and it is the only
    // one that says whether the payment actually went through. The address is offered only when
    // there is no transaction, and labelled as an address so the two are never confused.
    //
    // The urls are the server's, not built here: the chain table lives in one place and a
    // client-side copy is a second one to get wrong.
    const explorer = item.explorer || {};
    const hasTx = Boolean(explorer.transactionUrl);
    const href = explorer.transactionUrl || explorer.addressUrl;
    if (href) {
        const actions = document.createElement('div');
        actions.className = 'history-detail-links';
        const link = document.createElement('a');
        link.className = 'history-detail-link';
        link.href = href;
        link.textContent = hasTx
            ? `View transaction on ${explorer.explorerName || 'blockchain'}`
            : `View deposit address on ${explorer.explorerName || 'blockchain'}`;
        // A new tab, and no opener: the explorer is a third party, and this is the one link on the
        // page that leaves the site entirely.
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
        details.append(actions);
    }

    return details;
}

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
    const payoutState = kind === 'withdrawal' ? String(item.payout_status || '').toUpperCase() : '';
    badge.className = `payment-status status-${refunded ? 'refunded' : status}`;
    badge.textContent = withdrawalBadgeLabel(item, payoutState);

    // A crypto withdrawal that is being sent by the provider carries its own progress, which
    // is finer-grained than our own `processing`: the user's money is somewhere specific
    // between "queued" and "sent", and "Processing" alone gives them nothing to look at.
    //
    // Rendered whenever the provider has reported a stage, and not only while our own status
    // says `processing`. The screenshot that prompted this was a payout the provider had
    // rejected while the row still read `processing` -- the one state where the user most
    // needs the reason and the row was blank under the badge. A row with no `payout_status` at
    // all gets nothing, because that is a withdrawal the provider machinery never touched.
    const payoutLabel = kind === 'withdrawal' && payoutState && !refunded
        ? payoutProgressLabel(payoutState, item)
        : null;
    if (payoutLabel) {
        const progress = document.createElement('span');
        progress.className = 'payout-progress';
        progress.textContent = payoutLabel;
        details.append(progress);
    }

    row.append(details, badge);

    // A withdrawal the user can still take back gets a Cancel control.
    //
    // Only rendered when the server says `cancellable`, which is that one gate computed in
    // SQL by the same expression the cancel endpoint enforces. The client deliberately does not
    // derive this from the status: a `processing` row can be either a payout on its way or a
    // claim that was made and released, and only the payout columns tell them apart. Offering
    // Cancel on the wrong one is a click away from refunding a transfer that is still moving.
    if (kind === 'withdrawal' && item.cancellable === true) {
        row.append(buildCancelWithdrawalButton(item));
    }

    // The full record, for the rows that have one. Appended after the row's controls so the
    // disclosure sits last and the Cancel button stays where a user reaching for it expects.
    if (kind === 'withdrawal') {
        const detail = buildWithdrawalDetails(item);
        if (detail) row.append(detail);
    }
    if (kind === 'deposit') {
        const detail = buildDepositDetails(item);
        if (detail) row.append(detail);
    }

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
 * Why a withdrawal did not go out, in words the person who owns the money can use.
 *
 * Every place this used to render `failure_reason` or `payout_error` verbatim was showing the
 * provider's own error text to the user: "NOWPayments /v1/payout returned 400.: Insufficient
 * balance". That names a company they have no relationship with, an HTTP status, and an endpoint
 * path, and it tells them nothing they can act on -- worse, "Insufficient balance" describes *our*
 * provider's account, not theirs, so read literally it says the wrong thing about whose money is
 * short. The raw text is still recorded, because it is right for an operator reading the row, and
 * right for the logs. It just stops being the sentence shown to a customer.
 *
 * The sentence is chosen from the row's own state, because that is what we actually know and what
 * the user can act on: whether their money came back, or whether it is being held. An empty
 * return means there is nothing to report, which is the honest answer for a withdrawal that went
 * out normally.
 */
function withdrawalFailureText(item = {}) {
    const status = String(item.status || '').toLowerCase();
    const payoutStatus = String(item.payout_status || '').toUpperCase();
    const refunded = status === 'refunded' || status === 'failed';
    const stillMoving = ['SUBMISSION_UNKNOWN', 'VERIFY_UNKNOWN'].includes(payoutStatus);

    if (stillMoving) {
        return 'We are confirming this transfer with our payout provider. Nothing is needed from you, '
            + 'and the money stays yours either way.';
    }
    if (refunded) {
        return 'We were not able to send this withdrawal, so the full amount has been returned to your balance.';
    }
    if (status === 'cancelled') {
        return 'This withdrawal was cancelled and the full amount has been returned to your balance.';
    }
    if (status === 'paid' || payoutStatus === 'FINISHED') return '';
    if (payoutStatus === 'FAILED' || payoutStatus === 'CANCELLED' || payoutStatus === 'CANCELED'
        || payoutStatus === 'REJECTED' || payoutStatus === 'REJECTED_NOT_CHECKED') {
        return 'We were not able to send this withdrawal. If it has not returned to your balance, '
            + 'it will be refunded shortly.';
    }
    return '';
}

/**
 * The payout stage as a short noun phrase, or nothing.
 *
 * This replaced `String(payout_status || '').replace(/_/g, ' ').toLowerCase()`, which printed the
 * provider's internal vocabulary at the user: a row stuck in `CREATING` read "creating", which
 * describes what *our* system is doing and tells the reader nothing about their money. And for a
 * withdrawal that was never claimed the expression it replaced on the receipt page,
 * `String(withdrawal.payout_status)` with no fallback, printed the literal text "null" as a
 * payout stage.
 *
 * Unmapped stages fall back to "in progress" rather than to the raw word, for the same reason
 * `payoutProgressLabel` does: the provider's vocabulary is not a thing a user can act on, and an
 * unmapped value is the case that most needs a plain answer rather than a silent one.
 */
function payoutStageLabel(item = {}) {
    const stage = String(item.payout_status || '').toUpperCase();
    if (!stage) return '';
    switch (stage) {
        case 'CREATING':
        case 'NEW':
        case 'WAITING':
            return 'Preparing to send';
        case 'PROCESSING':
        case 'SENDING':
            return 'Sending';
        case 'SUBMISSION_UNKNOWN':
        case 'VERIFY_UNKNOWN':
            return 'Confirming with our payout provider';
        case 'FINISHED':
            return 'Confirmed on the network';
        case 'FAILED':
        case 'CANCELLED':
        case 'CANCELED':
        case 'REJECTED':
        case 'REJECTED_NOT_CHECKED':
            return 'Not sent';
        default:
            return 'In progress';
    }
}

/**
 * The provider's payout stage, in words a user can act on.
 *
 * Every state the provider can report is mapped, not just the ones that were first observed.
 * `SENDING` and `VERIFY_UNKNOWN` returned `null` and so rendered as an empty progress line: a
 * withdrawal with a live payout and no text under it, which is indistinguishable from the row
 * that has just come back from the API. An unmapped state is the one case that must never
 * happen silently, so the fallback says the transfer is in progress and unrecognised rather
 * than printing the provider's internal word at someone.
 *
 * The provider's own vocabulary is deliberately not shown: `WAITING` and `REJECTED_NOT_CHECKED`
 * are internal states, and rendering them raw tells the user nothing about whether their money
 * is moving.
 *
 * A null or empty stage returns an empty string rather than a word. A withdrawal that was never
 * claimed has no payout, and printing `null` -- which is what `String(null)` gives -- put the
 * literal text "null" on a user's receipt as a payout stage.
 */
function payoutProgressLabel(payoutStatus, item = {}) {
    if (!payoutStatus) return '';
    switch (String(payoutStatus).toUpperCase()) {
        case 'CREATING':
        case 'NEW':
            return 'Preparing your payout.';
        case 'WAITING':
            return 'Queued with the payout provider.';
        case 'PROCESSING':
            return 'The payout provider is working on your payout.';
        case 'SENDING':
            return 'Sent to the network. This can take a few minutes.';
        case 'SUBMISSION_UNKNOWN':
            return 'Confirming with the payout provider. No action is needed from you.';
        case 'VERIFY_UNKNOWN':
            return 'The payout provider is verifying the transfer. No action is needed from you.';
        case 'FINISHED':
            return 'The transfer was confirmed on the network.';
        case 'FAILED':
        case 'CANCELLED':
        case 'CANCELED':
        case 'REJECTED':
        case 'REJECTED_NOT_CHECKED':
            // Composed from the row's own state rather than quoted from the provider. The reason
            // text is still on the row for an operator; see `withdrawalFailureText` for why it
            // stops being what the user reads.
            return withdrawalFailureText(item) || 'The payout was not sent.';
        default:
            return 'Your payout is in progress.';
    }
}

/**
 * Which withdrawal disclosures the reader has opened in a given list.
 *
 * Both render paths below rebuild every row rather than patching the one that changed, and a
 * rebuild destroys DOM state -- including the `open` attribute on a `<details>`. So a reader
 * who opened a withdrawal to copy the transaction reference would have it snap shut under
 * their cursor every time the poll returned, and the reference would never be readable for
 * as long as it took to select it.
 *
 * Keyed by container and withdrawal id, so opening a row in the account page's list does not
 * open the same row in the dialog's list: those are two views of the same row and the reader
 * opened exactly one of them.
 */
function openDetailIdsFor(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return new Set();
    const open = new Set();
    // Both disclosure kinds, keyed by their own attribute. A shared key would collide across the
    // two id spaces -- withdrawal 12 and deposit 12 are different records -- so the two attributes
    // are read separately and re-opened by the matching one.
    for (const element of container.querySelectorAll('details.history-detail[data-withdrawal-id][open]')) {
        open.add(`w:${element.dataset.withdrawalId}`);
    }
    for (const element of container.querySelectorAll('details.history-detail[data-deposit-id][open]')) {
        open.add(`d:${element.dataset.depositId}`);
    }
    return open;
}

/**
 * Re-opens the disclosures that were open before a rebuild.
 *
 * Assigning the `open` IDL attribute rather than `setAttribute('open', '')`, because the
 * property is what the `open` state is actually read from; the attribute is a reflection of
 * it, and writing the attribute alone is not equivalent on every engine.
 */
function restoreOpenDetails(container, openIds) {
    if (!container || !openIds || openIds.size === 0) return;
    for (const element of container.querySelectorAll('details.history-detail[data-withdrawal-id]')) {
        if (openIds.has(`w:${element.dataset.withdrawalId}`)) element.open = true;
    }
    for (const element of container.querySelectorAll('details.history-detail[data-deposit-id]')) {
        if (openIds.has(`d:${element.dataset.depositId}`)) element.open = true;
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
    const openIds = openDetailIdsFor(containerId);
    if (!items.length) {
        container.textContent = emptyText;
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) fragment.append(buildHistoryRow(item, kind));
    container.replaceChildren(fragment);
    restoreOpenDetails(container, openIds);
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
        // Read before the rebuild below, for the same reason the live sync reads it: the open
        // disclosures in this list are the reader's, and a poll must not take them away.
        const openIds = openDetailIdsFor(containerId);
        container.replaceChildren();

        if (items.length === 0) {
            container.textContent = kind === 'deposit'
                ? 'No deposits yet.'
                : 'No withdrawal requests yet.';
            return { settled: false, settledCount: 0 };
        }

        const fragment = document.createDocumentFragment();
        let settledCount = 0;
        for (const item of items) {
            const status = String(item.status || '').toLowerCase();
            if (status === 'confirmed' || status === 'paid') {
                settledCount += 1;
            }

            fragment.append(buildHistoryRow(item, kind));
        }
        container.append(fragment);
        restoreOpenDetails(container, openIds);

        // No announcement happens here, and that is the point of this function being
        // render-only.
        //
        // It used to mark a newly-settled withdrawal as seen and open the credit screen for a
        // newly-credited deposit -- both without announcing anything itself, on the assumption
        // the live sync was about to. The live sync is not "about to": it runs on a timer, and
        // this list is fetched on a timer of its own and on every `historyChanged`. So opening
        // the withdraw dialog before the next sync arrived consumed the notification
        // permanently -- the row said "Withdrawal sent" and the user was never told, with no
        // way left to be told, because the flag was already set. The same code could also open
        // the success screen for a deposit credited last month, since this function had no way
        // to tell an old credit from a new one.
        //
        // `applyLiveUpdate` is the single owner of announcements. It has the version stamp, it
        // runs on every change, and it already decides what is an event by comparing timestamps
        // rather than by guessing from a list. A list that renders cannot announce; a path that
        // announces cannot be reached twice with the same event.
        //
        // The balance is re-read only when something newly settled, so an open dialog polling
        // every ten seconds is not issuing a balance request on every tick.
        if (settledCount > 0) await refreshBalance();
        return { settled: settledCount > 0, settledCount };
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

    // A modal can only show one deposit, and it is a modal: while it is open the user is
    // looking at the previous one. Returning here used to mean the second deposit was never
    // announced anywhere -- the caller had already marked this id as seen before calling, so
    // the credit was not retried on a later poll either, and it disappeared silently. Two
    // deposits landing together is exactly the case where losing one is worst, because the
    // user is watching the first arrive and has no way to notice the second.
    //
    // So the modal is the preferred presentation and the toast is the fallback, not the
    // alternative being skipped. The toast is what carries the notification either way, so
    // this does not announce the same credit twice -- `notifyDepositConfirmed` is called on
    // both paths below.
    if (!dialog || dialog.open) {
        notifyDepositConfirmed(deposit);
        return;
    }

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
    rows.push(['Credited', formatDateTime(deposit.credited_at || deposit.created_at)]);
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
