/**
 * History page.
 *
 * Renders the combined transaction list (deposits, withdrawals, rewards) from
 * `GET /api/user/history`, and filters by type using tab-style buttons.
 * Reuses the auth and notification machinery from app.js (loaded before this
 * script) so the header, balance, and bell stay in sync with the rest of the
 * site.
 *
 * Pagination is server-side. The alternative -- fetching everything and slicing it here -- was
 * what this used to do, and it cannot be made correct: the total that decides how many pages
 * exist lives in `X-Total-Count`, and a filter applied after a page has been cut can only count
 * the rows that survived it. The Deposits tab would show a page of three under a header
 * claiming twenty, and "page 2" would skip or repeat rows depending on where the deposits
 * happened to fall. So the filter and the window are the same request.
 *
 * The page size is five rather than the endpoint's default of twenty because that is what the
 * list is for: a short, scannable recent history. Twenty rows of transaction history is a
 * scroll, not a list.
 */

const HISTORY_PAGE_SIZE = 5;

document.addEventListener('DOMContentLoaded', () => {
    initHistoryFilters();
    initHistorySignIn();
    initHistoryPagination();
    initHistoryLiveRefresh();
    initHistoryFocus();
    loadHistory();
    // Sync the balance to the account page's larger display if present.
    const token = getSessionToken();
    if (token) {
        refreshBalance && refreshBalance();
    }

    // Refresh on tab focus -- the user may have completed an offer and come
    // back to see the reward land without a manual reload. Page one is reloaded rather
    // than the page they were on, because a newly arrived transaction belongs at the top and
    // silently moving someone off the page they were reading is worse than the delay it avoids.
    document.addEventListener('visibilitychange', () => {
        // Skipped while a walk is in progress, for the same reason the live refresh skips it:
        // resetting to page 1 mid-walk sends the search back to the start, and a tab that is
        // hidden and restored repeatedly would never reach its row.
        if (!document.hidden && !focusSearchActive) {
            historyPage = 1;
            loadHistory();
            if (getSessionToken()) {
                refreshBalance && refreshBalance();
            }
        }
    });
});

/**
 * Reloads when the live-sync poll reports that the ledger moved.
 *
 * This is what makes the list update in real time. The alternative -- a timer of this page's
 * own -- would poll the same server on a second, independent schedule, and would refetch the
 * whole list every few seconds even when nothing had changed. `/api/user/updates` already runs
 * on a timer, already answers `304` when the ledger is still, and already carries the rows
 * that moved, so listening to it costs one listener and no extra traffic.
 *
 * Page one is reloaded rather than the current page. A row that just arrived belongs at the
 * top, so a user on page 3 has not missed anything by being moved to page 1 -- and staying put
 * would leave them looking at a page whose contents have shifted underneath them.
 */
function initHistoryLiveRefresh() {
    window.addEventListener('offerNetwork:historyChanged', () => {
        if (document.hidden) return;
        // Not while a link is still being followed to its row. The search advances the page
        // itself, and a refresh that reset `historyPage` to 1 in the middle of it would send the
        // walk back to where it started on every tick -- a livelock that burns a request per
        // poll and never arrives. The row being looked for is, by construction, one that just
        // changed, so skipping the refresh costs nothing: the search's own request has it.
        if (focusSearchActive) return;
        historyPage = 1;
        loadHistory();
    });
}

function initHistoryFilters() {
    const buttons = document.querySelectorAll('.history-filter-button');
    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            // The tab becomes part of the request rather than a filter applied to the page that
            // came back, so the rows and the total describe the same set.
            historyFilter = button.dataset.filter || 'all';
            // Painted after the filter changes, not before, because the painter reads
            // `historyFilter` to decide which button is the active one. Painting first would
            // repaint the tab the user was already on, and the row they clicked would then be
            // marked as a filter it is not showing.
            paintHistoryFilterButtons();
            // Each tab is its own list, so each starts at its own first page. Carrying page 3
            // of All over to a Deposits tab with two pages would land the user on an empty
            // screen and read as "your deposits are gone".
            historyPage = 1;
            // A deliberate change of tab ends the search: the reader has said which list they
            // want, and continuing to page through All in the background would move them off it.
            focusAttempts = FOCUS_SEARCH_PAGES;
            loadHistory();
        });
    });
}

/**
 * Wires the previous/next controls.
 *
 * `historyPage` is the single piece of state both controls and the loader agree on. It is
 * clamped rather than trusted on the way out, because the page count is derived from a total
 * that can change under the user -- a new transaction arriving between two clicks can make the
 * page they were on no longer exist.
 */
function initHistoryPagination() {
    const previous = document.getElementById('history-page-prev');
    const next = document.getElementById('history-page-next');
    if (previous) {
        previous.addEventListener('click', () => {
            if (historyPage <= 1) return;
            historyPage -= 1;
            loadHistory();
        });
    }
    if (next) {
        next.addEventListener('click', () => {
            if (historyPage >= historyPageCount()) return;
            historyPage += 1;
            loadHistory();
        });
    }
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
let historyFilter = 'all';
let historyPage = 1;
// The tab's own total, as the server counted it for that tab. Kept separately from the rows on
// screen because the two answer different questions: the rows are this page, the total is every
// page of this tab.
let historyTotal = 0;

/** How many pages the current tab has, never less than one. */
function historyPageCount() {
    return Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
}

/**
 * Loads one page of the current tab.
 *
 * A request carries a monotonically increasing id and a response that is not the newest is
 * dropped. Without it, the real-time refresh and a filter click race: the user switches to
 * Deposits, the in-flight All request lands afterwards, and the tab they just chose is
 * repainted with everyone's transactions. That is the failure a single in-flight guard is
 * there to prevent, and it is a visible one rather than a subtle data error.
 */
let historyRequestId = 0;

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

    const requestId = ++historyRequestId;

    // The loading state is only shown for a first load. Re-showing it on every refresh or page
    // change blanks the list the user is reading, which is a worse answer to "show me the next
    // page" than a brief absence of the controls.
    const isFirstLoad = historyTotal === 0 && historyPage === 1 && historyCache.length === 0;
    if (isFirstLoad) {
        loading.hidden = false;
        errorBox.hidden = true;
        list.hidden = true;
        empty.hidden = true;
    }

    try {
        // `type` is omitted for the All tab rather than sent as `all`, so the endpoint's own
        // unfiltered path is the one being exercised. The offset is derived from the page
        // number so the two cannot disagree.
        const params = new URLSearchParams({
            limit: String(HISTORY_PAGE_SIZE),
            offset: String((historyPage - 1) * HISTORY_PAGE_SIZE)
        });
        if (historyFilter !== 'all') params.set('type', historyFilter);

        const response = await fetch(`/api/user/history?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (handleUnauthorizedResponse(response)) return;
        if (!response.ok) throw new Error('Could not load history.');

        const data = await response.json();
        // A newer request has already been issued, so this answer is stale.
        if (requestId !== historyRequestId) return;

        historyCache = Array.isArray(data) ? data : [];
        // The header is the only source of the true total. A missing or unparseable one falls
        // back to the rows received, which is right for a single-page list and degrades to
        // "no next page" rather than to an invented one.
        const reported = Number(response.headers.get('X-Total-Count'));
        historyTotal = Number.isFinite(reported) && reported >= 0 ? reported : historyCache.length;

        // The total can shrink under the user -- a refund can remove the only row on the last
        // page -- so a page beyond the end steps back rather than rendering an empty list.
        if (historyPage > historyPageCount()) {
            historyPage = historyPageCount();
            return loadHistory();
        }

        renderHistoryList(historyFilter);
        // After the rows exist, because the fragment in the url has to have something to match.
        // A link that names a specific row and lands on a page that has not found it yet is the
        // failure this exists to prevent, and the search has to run on every load because a
        // filter change or a page turn can put the target on screen later than the click.
        if (pendingFocusHash() && !focusHistoryTarget()) searchForHistoryTarget();
        loading.hidden = true;
        errorBox.hidden = true;
    } catch (error) {
        if (requestId !== historyRequestId) return;
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

    // Not filtered here. The server applied the tab and cut the page, so these rows are
    // already the answer to "deposits, page 2". Filtering them again would compare each row
    // against a filter it was selected by.
    const items = historyCache;

    if (items.length === 0) {
        list.hidden = true;
        // A page past the end of a tab that has rows is a stale page, not an empty history, so
        // it must not be answered with "No deposits yet". The loader steps back before
        // reaching here; this guard covers the case where the last page is emptied by a
        // deletion rather than by a refund of the row that made it current.
        paintEmptyState(historyTotal === 0 ? filter : 'all');
        renderHistoryPagination();
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
        // The stable id a notification's link points at. Without it a notice about one specific
        // deposit could only send the reader to the top of a list, which is the same as saying
        // "something happened to your money" with no way to see what. `historyRowId` is in app.js
        // and is the only place the format exists, because the link and the id have to match
        // exactly or the link scrolls nowhere.
        const record = recordFor(item);
        if (record) row.id = historyRowId(record.kind, record.id);
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
        const receipt = buildReceiptLink(record);
        if (receipt) row.append(receipt);
        wrapper.appendChild(row);
    }
    list.appendChild(wrapper);
    renderHistoryPagination();
}

/**
 * The deposit or withdrawal a ledger row is about, as the server resolved it.
 *
 * Only the server knows: `source_id` carries three different shapes depending on the row type,
 * and it is already normalised into `{ kind, id }` in the history response. Re-deriving it here
 * would mean a second copy of that table to keep correct.
 */
function recordFor(item) {
    const record = item?.record;
    if (!record || typeof record !== 'object') return null;
    if (record.kind !== 'deposit' && record.kind !== 'withdrawal') return null;
    return record;
}

/**
 * The receipt link for a row that has a record behind it.
 *
 * The history list is where someone goes to see their money in context, so it is the right place
 * for the receipt to be one click away -- the alternative is that the list shows a deposit and the
 * only route to its detail is the notification, which is exactly the thing that has usually
 * already been dismissed.
 */
function buildReceiptLink(record) {
    if (!record) return null;
    // `record.id` arrived from the server already validated as digits, and is re-checked here
    // because it becomes part of a url.
    if (!/^\d{1,19}$/.test(String(record.id))) return null;
    const link = document.createElement('a');
    link.className = 'history-item-receipt';
    link.href = record.kind === 'deposit'
        ? `/receipt/deposit/${encodeURIComponent(record.id)}`
        : `/receipt/withdrawal/${encodeURIComponent(record.id)}`;
    link.textContent = 'View receipt';
    return link;
}

/**
 * The fragment a notification's link is pointing at, when it names a history row.
 *
 * Validated against a pattern rather than used as-is. A fragment is attacker-reachable in the
 * sense that anything can send a user to `/account#anything`, and the value ends in a
 * `getElementById`; restricting it to the exact shape this page produces means a malformed or
 * hostile fragment is ignored rather than matched against whatever element happens to answer.
 */
function pendingFocusHash() {
    const hash = window.location.hash.slice(1);
    return /^history-(deposit|withdrawal)-\d{1,19}$/.test(hash) ? hash : '';
}

/**
 * Scrolls to the row a notification's link asked for, and marks it.
 *
 * Three things rather than one, because the browser's own fragment handling only does the first
 * and only when the element exists at load: the rows are rendered by JavaScript from an
 * authenticated request, so there is no element for the browser to find, and a link that changes
 * the hash without moving the reader anywhere reads as a page that ignored it.
 *
 * Focus is moved as well as scrolled. A keyboard or screen-reader user following this link would
 * otherwise have the page silently move under them with the viewport unchanged and no
 * announcement -- the one case where the destination is the whole point of the link and nothing
 * says which thing they arrived at.
 *
 * Returns whether the target was found, which is how the caller knows a search is still needed.
 */
function focusHistoryTarget() {
    const hash = pendingFocusHash();
    if (!hash) return false;
    const target = document.getElementById(hash);
    if (!target) return false;
    target.classList.add('is-focused');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // `tabindex="-1"` makes a non-interactive row focusable without adding it to the tab order,
    // which is what lets focus land here without making every row in the list a tab stop.
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    // Arrived. Cleared here rather than at the call site because this is the only outcome that
    // means the walk is over, and a walk left marked active would keep suppressing the live
    // refresh for the rest of the page's life.
    focusSearchActive = false;
    // The missing-entry notice goes with it. It was a statement about this destination, and the
    // reader is now looking at the thing they asked for, so leaving it up would contradict what
    // is on screen.
    focusTargetMissing = false;
    renderHistoryTargetMissing();
    return true;
}

/**
 * Walks the list looking for the row a link asked for.
 *
 * The list is five rows to a page and the reader may be on the Withdrawals tab on page three, so
 * "the record is not on this page" says nothing about whether it exists. This is a bounded walk
 * rather than a single guess, and the bound is a real limit rather than a hopeful one: a
 * notification is about something that just happened, so its row is on the first page or very
 * near it, and a link to a record from months ago that is not found is an acceptable outcome --
 * the row is still listed, one filter away. Walking every page of a long account to find it would
 * be a burst of requests for something the reader has stopped caring about.
 */
const FOCUS_SEARCH_PAGES = 12;
let focusAttempts = 0;
// Whether a walk is in progress. One flag rather than a check of the counter, because the two
// mean different things: the counter counts how far the walk has got, this says whether one is
// running, and the live refresh and the visibility handler need the second.
let focusSearchActive = false;
// Whether a walk has run to its end without finding the row it was looking for. Distinct from
// "not looking": until this is set the walk may still succeed on a later page, and setting it
// early would announce a missing entry that is really on page three.
let focusTargetMissing = false;

const HISTORY_TARGET_MISSING_COPY =
    'That entry is not in your history. It may predate your transaction list, or be covered by another tab.';

/**
 * Announces, or withdraws, the notice that a linked row was not found.
 *
 * `hidden` rather than an empty element so assistive technology is not handed a blank status
 * region on every load, and cleared rather than left behind once the row turns up -- a notice
 * that outlives the reason for it is its own kind of wrong.
 */
function renderHistoryTargetMissing() {
    const notice = document.getElementById('history-target-missing');
    if (!notice) return;
    notice.hidden = !focusTargetMissing;
    notice.textContent = focusTargetMissing ? HISTORY_TARGET_MISSING_COPY : '';
}

function searchForHistoryTarget() {
    if (focusSearchActive || focusAttempts >= FOCUS_SEARCH_PAGES) return;
    focusSearchActive = true;
    focusAttempts += 1;
    if (historyFilter !== 'all') {
        // Widen to the unfiltered list. The record is in there whichever tab it is on, and the
        // tab the reader happened to be on is not a constraint on a link that asked for one
        // specific row. The tab buttons are repainted to match, because a highlighted tab that
        // does not describe the list is worse than no highlight.
        historyFilter = 'all';
        historyPage = 1;
        paintHistoryFilterButtons();
    } else if (historyPage < historyPageCount()) {
        historyPage += 1;
    } else {
        // The end of the list, and the row is not on any page of it. Stop, and let the walk be
        // considered finished rather than retrying the same last page forever.
        focusSearchActive = false;
        // Say so. A notification whose row cannot be found is otherwise the exact failure this
        // feature was built to remove: the reader follows "your withdrawal is on its way", the
        // page does not move, and nothing distinguishes that from a broken link. The record is
        // genuinely absent -- an entry from before history was kept, or one this list does not
        // cover -- so the honest answer is that, rather than silence or an error.
        focusTargetMissing = true;
        renderHistoryTargetMissing();
        return;
    }
    loadHistory();
}

/**
 * Reflects `historyFilter` on the tab row, so the visible highlight always describes the list.
 *
 * The click handler already does this by toggling each button; this is the same thing for a
 * filter the code changed rather than the user. Two places setting the same visual state is how
 * they drift, so both go through here.
 */
function paintHistoryFilterButtons() {
    const buttons = document.querySelectorAll('.history-filter-button');
    buttons.forEach((button) => {
        const active = (button.dataset.filter || 'all') === historyFilter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
}

/**
 * Wires the arrival of a link that names a specific row.
 *
 * Both entries, not one. A cold load has the fragment already in the url when this page starts,
 * and a click on a notification while the reader is already here changes only the hash -- no
 * navigation, no reload, no `DOMContentLoaded` -- so without the `hashchange` listener the link
 * would appear to do nothing at all.
 */
function initHistoryFocus() {
    if (pendingFocusHash()) focusAttempts = 0;
    window.addEventListener('hashchange', () => {
        focusAttempts = 0;
        // A previous walk may still be marked active, and a new destination deserves a fresh
        // one. Cleared before the attempt rather than after, so a walk in progress cannot block
        // the walk this click asked for.
        focusSearchActive = false;
        // Same for a notice about the previous destination: it described a row this click is not
        // asking for, so it must not stay up while the next one is being looked for.
        focusTargetMissing = false;
        renderHistoryTargetMissing();
        if (!focusHistoryTarget()) searchForHistoryTarget();
    });
}

/**
 * Shows the page controls, and only when there is somewhere to go.
 *
 * A single-page history hides the whole bar. "Page 1 of 1" is a control that cannot do
 * anything, and rendering it invites the reasonable question of what Next would do.
 *
 * The buttons are disabled rather than hidden at the ends, so the bar does not change width as
 * the user moves through it and the focus they may have on a control is not destroyed by it
 * disappearing.
 */
function renderHistoryPagination() {
    const nav = document.getElementById('history-pagination');
    if (!nav) return;

    const pageCount = historyPageCount();
    const status = document.getElementById('history-page-status');
    // Nothing to page through: either there is nothing at all, or it all fits on one page.
    if (historyTotal <= HISTORY_PAGE_SIZE) {
        nav.hidden = true;
        // Cleared rather than left describing the page it was last on. It is not visible while
        // the bar is hidden, but it is the text a screen reader would read if the bar were ever
        // shown again without a fresh render, and "Showing 6-10 of 11" over a list of three
        // deposits is the sort of thing that gets read out verbatim.
        if (status) status.textContent = '';
        return;
    }

    nav.hidden = false;
    if (status) {
        const first = (historyPage - 1) * HISTORY_PAGE_SIZE + 1;
        const last = Math.min(historyPage * HISTORY_PAGE_SIZE, historyTotal);
        status.textContent = `Showing ${first}-${last} of ${historyTotal}`;
    }

    const previous = document.getElementById('history-page-prev');
    const next = document.getElementById('history-page-next');
    if (previous) previous.disabled = historyPage <= 1;
    if (next) next.disabled = historyPage >= pageCount;
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
