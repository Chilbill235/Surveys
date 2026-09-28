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

function showToast(title, message, { tone = 'info', duration = 4500 } = {}) {
    if (!toastRegion) return;
    const id = ++toastCount;
    const toast = document.createElement('div');
    toast.className = `toast is-${tone}`;
    toast.dataset.id = id;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
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

    if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
    }
    return id;
}

function dismissToast(id) {
    const toast = toastRegion.querySelector(`.toast[data-id="${id}"]`);
    if (!toast) return;
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
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
    showToast(
        'Deposit credited',
        `${formatBalance(item.amount)} ${item.currency_code || 'USD'} added to your balance.`,
        { tone: 'success' }
    );
}

function notifyWithdrawalSubmitted(item) {
    showToast(
        'Withdrawal submitted',
        `Your request to withdraw ${formatBalance(item.amount)} is being processed.`,
        { tone: 'info' }
    );
}

function notifyWithdrawalPaid(item) {
    showToast(
        'Withdrawal sent',
        `${formatBalance(item.amount)} has been sent to your payment method.`,
        { tone: 'success' }
    );
}

function notifyWithdrawalFailed(item) {
    showToast(
        'Withdrawal failed',
        item.failureReason || 'Your withdrawal could not be completed.',
        { tone: 'error' }
    );
}

function notifySessionExpired() {
    showToast(
        'Session expired',
        'Sign in again to continue.',
        { tone: 'warning' }
    );
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
const withdrawalStatesSeen = new Set();
function markWithdrawalSeen(id, status) {
    withdrawalStatesSeen.add(`${id}:${status}`);
}
function withdrawalStateSeen(id, status) {
    return withdrawalStatesSeen.has(`${id}:${status}`);
}
// `codeFor` is the amount/coin/destination a confirmation code was issued for, or null. It
// exists so an edit after the code arrived is caught in the form instead of at the server.
const withdrawState = { options: null, method: 'paypal', asset: '', network: '', codeFor: null };
const accountState = { balance: NaN };


let depositStatusTimer;
let depositHistorySignature = '';

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

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('account-button').addEventListener('click', handleAccountButton);
    document.getElementById('deposit-button').addEventListener('click', openDeposits);
    document.getElementById('withdraw-button').addEventListener('click', openWithdrawal);
    document.getElementById('account-form').addEventListener('submit', connectAccount);
    document.getElementById('withdraw-form').addEventListener('submit', submitWithdrawal);
    document.getElementById('withdraw-code-send')?.addEventListener('click', sendWithdrawalCode);
    document.getElementById('withdraw-code-resend')?.addEventListener('click', sendWithdrawalCode);
    document.getElementById('withdraw-code')?.addEventListener('input', (event) => {
        // Digits only, capped at six. A pasted "123 456" or an autocorrected one is the
        // difference between a code that works and one of five attempts spent.
        event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
    });
    document.getElementById('deposit-form').addEventListener('submit', createDeposit);

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
            amount.value = button.dataset.depositAmount;
            syncDepositPresets();
            amount.focus();
        });
    });
    document.getElementById('deposit-amount').addEventListener('input', () => {
        syncDepositPresets();
        // Re-checked on every keystroke so the "provider will refuse this" state appears and
        // clears as the amount crosses the floor, rather than only after a failed submit.
        validateDepositAmount();
    });
    document.getElementById('deposit-max').addEventListener('click', setMaximumDepositAmount);
    document.getElementById('deposit-currency').addEventListener('change', () => {
        clearDepositMessage();
        // The provider's minimum and maximum are both per currency pair, so switching coins
        // can change the range that will be accepted. Leaving the previous coin's limits in
        // place either blocks a valid amount or lets an invalid one through to the server.
        const amount = document.getElementById('deposit-amount');
        amount.min = String(minimumForSelectedCurrency());
        amount.max = String(maximumForSelectedCurrency());
        // The bounds alone are not enough: the value already typed may now be outside them.
        clampDepositAmountToRange();
        updateDepositAmountHint();
        updateCoinSummary();
        syncDepositPresets();
    });

    document.getElementById('withdraw-asset-options').addEventListener('change', (event) => {
        if (event.target.name === 'withdrawAsset') {
            withdrawState.asset = event.target.value;
            withdrawState.network = '';
            renderNetworkChoices();
            updateWithdrawFields();
        }
    });
    document.getElementById('withdraw-network').addEventListener('change', (event) => {
        withdrawState.network = event.target.value;
        updateWithdrawFields();
    });
    document.getElementById('withdraw-amount').addEventListener('input', updateWithdrawSummary);
    document.getElementById('withdraw-address').addEventListener('input', updateWithdrawSummary);
    document.getElementById('withdraw-max').addEventListener('click', () => {
        // "Withdraw all" means the whole balance, but only up to the provider's own cap:
        // offering $5,000 to someone holding $40,000 produces a request that is refused.
        const options = withdrawState.options;
        const balance = accountState.balance;
        if (!Number.isFinite(balance)) return;
        const ceiling = Number.isFinite(options?.maximumUsd) ? Math.min(balance, options.maximumUsd) : balance;
        const amount = document.getElementById('withdraw-amount');
        amount.value = ceiling.toFixed(2);
        updateWithdrawSummary();
        amount.focus();
    });
    document.getElementById('withdraw-address').addEventListener('input', clearWithdrawMessage);

    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
        button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
    });
    document.getElementById('forgot-password-link').addEventListener('click', () => {
        setFormMessage('account-message', '');
        setAuthMode('forgot');
    });

    // Email confirmation. The code box submits on Enter, so the flow is one keypress from
    // pasting the six digits rather than a hunt for the button.
    document.getElementById('verify-submit').addEventListener('click', submitVerification);
    document.getElementById('verify-resend').addEventListener('click', resendVerificationCode);
    document.getElementById('verify-code').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitVerification();
        }
    });
    document.getElementById('verify-code').addEventListener('input', (event) => {
        // Digits only, even if the code was pasted with a space or a hyphen in it. The field
        // is `maxlength=6`, so stripping rather than truncating is what makes a pasted
        // "123 456" work instead of silently becoming "123 45".
        const cleaned = event.target.value.replace(/\D/g, '').slice(0, 6);
        if (cleaned !== event.target.value) event.target.value = cleaned;
    });
    document.getElementById('verify-back').addEventListener('click', () => {
        hideVerifyStep();
        setAuthMode('login');
        document.getElementById('account-email').focus();
    });

    document.getElementById('offer-search').addEventListener('input', (event) => {
        offerState.search = event.target.value.trim().toLowerCase();
        renderOffers();
    });
    document.getElementById('offer-sort').addEventListener('change', (event) => {
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
    // The narrow-screen action bar duplicates the header controls, because the header has
    // to stay one row on a phone and the primary actions belong under the thumb. Each bar
    // button forwards to its header counterpart, so the behaviour, the disabled state, and
    // the sign-in label all have exactly one implementation.
    //
    // This was registered inside the sign-in handler rather than here, which meant the
    // three buttons in the bottom bar did nothing at all until the visitor had signed in
    // once -- and then registered a fresh listener on every subsequent sign-in. It is
    // page-level wiring: it runs once, and the per-button state is `syncAccountControls`'s
    // job, which is already called on load, on sign-in, and on sign-out.
    document.querySelectorAll('[data-mirror]').forEach((barButton) => {
        const target = document.getElementById(barButton.dataset.mirror);
        if (target) barButton.addEventListener('click', () => target.click());
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
    });

    // Any dialog dismisses on a backdrop click or Escape. Native <dialog> handles
    // Escape, but a click outside the panel does not close it by default.
    document.querySelectorAll('dialog').forEach((dialog) => {
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });
    });

    document.getElementById('deposit-dialog').addEventListener('close', () => {
        window.clearInterval(depositStatusTimer);
        depositStatusTimer = undefined;
        depositHistorySignature = '';
    });    document.getElementById('withdraw-dialog').addEventListener('close', () => {
        setFormMessage('withdraw-message', '');
    });

    document.getElementById('deposit-success-close').addEventListener('click', () => {
        document.getElementById('deposit-success-dialog').close();
    });

    syncAccountControls();
    syncDepositPresets();
    updateDepositFields();
    updateWithdrawFields();
    refreshBalance();
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
    if (sessionStorage.getItem(accountTokenKey)) {
        loadDepositHistory().finally(() => {
            startLiveSync();
            paintLiveIndicator();
        });
    } else {
        startLiveSync();
        paintLiveIndicator();
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
    if (!sessionStorage.getItem(accountTokenKey)) {
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
    consecutiveFailures: 0
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
    const token = sessionStorage.getItem(accountTokenKey);
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
    if (typeof payload.balance === 'string' && payload.balance !== accountState.balance) {
        // `applyBalance` is the one place that writes the header and keeps the withdrawal
        // ceiling in step, so the live path routes through it rather than repeating it. A
        // live update that painted the header but left the withdrawal form capped at the
        // old balance would let someone request more than they have.
        applyBalance(payload.balance, payload.demoBalance ?? '0');
        if (isDialogOpen('withdraw-dialog')) {
            updateWithdrawFields();
            updateWithdrawAmountHint();
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
            if (isDialogOpen('deposit-dialog')) showDepositSuccess(item);
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
            notifyWithdrawalFailed(item);
        }
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
    const indicator = document.getElementById('live-indicator');
    if (!indicator) return;
    const token = sessionStorage.getItem(accountTokenKey);
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
function signOut() {
    const token = sessionStorage.getItem(accountTokenKey);
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
    syncAccountControls();
}

function handleUnauthorized(error) {
    if (error.status !== 401) return false;
    signOut();
    notifySessionExpired();
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
        document.getElementById('offer-count').textContent = 'Offers unavailable';
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
                document.getElementById('offer-search').value = '';
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
    const token = sessionStorage.getItem(accountTokenKey);
    if (!token) {
        showPageMessage('Connect your account before starting an offer.');
        document.getElementById('account-dialog').showModal();
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
            document.getElementById('account-dialog').showModal();
            return;
        }
        showPageMessage(error.message);
    }
}

function showPageMessage(message) {
    const box = document.getElementById('page-message');
    box.replaceChildren(document.createTextNode(message));
    box.hidden = false;
}

/* ---------------------------------------------------------------- account */

function syncAccountControls() {
    const connected = Boolean(sessionStorage.getItem(accountTokenKey));
    const accountButton = document.getElementById('account-button');
    accountButton.textContent = connected ? 'Disconnect' : 'Connect account';
    document.getElementById('deposit-button').disabled = !connected;
    document.getElementById('withdraw-button').disabled = !connected;

    // Mirror the header state onto the narrow-screen action bar.
    document.querySelectorAll('[data-mirror]').forEach((barButton) => {
        const target = document.getElementById(barButton.dataset.mirror);
        if (!target) return;
        barButton.disabled = target.disabled;
        if (target === accountButton) {
            const label = barButton.querySelector('.action-bar-label');
            if (label) label.textContent = connected ? 'Account' : 'Sign in';
        }
    });

    if (!connected) {
        document.getElementById('user-balance').textContent = '--';
        document.getElementById('demo-balance').textContent = '--';
    }
}

function handleAccountButton() {
    if (sessionStorage.getItem(accountTokenKey)) {
        signOut();
        setFormMessage('account-message', '');
        return;
    }
    document.getElementById('account-email').value = '';
    document.getElementById('account-password').value = '';
    setFormMessage('account-message', '');
    setAuthMode('login');
    document.getElementById('account-dialog').showModal();
}

function setAuthMode(mode) {
    const register = mode === 'register';
    const forgot = mode === 'forgot';
    const form = document.getElementById('account-form');
    const title = document.getElementById('account-title');
    const submit = document.getElementById('connect-submit');
    const password = document.getElementById('account-password');
    const passwordLabel = document.getElementById('account-password-label');

    form.dataset.authMode = forgot ? 'forgot' : register ? 'register' : 'login';
    title.textContent = forgot ? 'Reset your password' : register ? 'Create your account' : 'Welcome back';
    submit.textContent = forgot ? 'Email me a reset link' : register ? 'Create account' : 'Sign in';

    // The password row is hidden during a reset. The `hidden` attribute is enough
    // because the stylesheet forces `[hidden]` to win over component display rules.
    passwordLabel.hidden = forgot;
    password.hidden = forgot;
    password.required = !forgot;
    password.autocomplete = register ? 'new-password' : 'current-password';
    password.minLength = register ? 12 : 1;
    document.getElementById('password-hint').hidden = !register;
    document.getElementById('forgot-password-link').hidden = register || forgot;

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

    document.getElementById('verify-email').textContent = email;
    document.getElementById('verify-expiry').textContent = expiresInMinutes
        ? `It expires in ${expiresInMinutes} minutes.`
        : '';

    // The email is remembered because confirming needs it and the field is about to be
    // hidden. Reading it back from the field would be a hidden dependency on a value the
    // user can no longer see or correct.
    form.dataset.verifyEmail = email;

    setFormMessage('verify-message', '');
    document.getElementById('verify-code').value = '';
    document.getElementById('verify-submit').disabled = false;
    document.getElementById('verify-resend').disabled = false;

    for (const id of ['account-email', 'account-password', 'account-password-label',
        'password-hint', 'connect-submit', 'forgot-password-link', 'account-message']) {
        const element = document.getElementById(id);
        if (element) element.hidden = true;
    }
    document.querySelector('.auth-mode')?.setAttribute('hidden', '');

    step.hidden = false;
    document.getElementById('verify-code').focus();
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
    document.getElementById('account-form').dataset.verifyEmail = '';
}

/**
 * Confirms the address and signs the account in.
 *
 * The session comes from this call, not from registration, so the balance shown afterwards is
 * read from a server that has already accepted the address.
 */
async function submitVerification() {
    const form = document.getElementById('account-form');
    const email = form.dataset.verifyEmail || document.getElementById('account-email').value.trim();
    const code = document.getElementById('verify-code').value.trim();
    const button = document.getElementById('verify-submit');

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
        document.getElementById('verify-code').value = '';
        document.getElementById('verify-code').focus();
    }
}

/** Asks for another code. The address is shown, so a wrong entry is corrected here. */
async function resendVerificationCode() {
    const form = document.getElementById('account-form');
    const email = form.dataset.verifyEmail || document.getElementById('account-email').value.trim();
    const button = document.getElementById('verify-resend');

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

/** Everything that has to happen once a session exists, for either sign-in route. */
function completeSignIn(data) {
    sessionStorage.setItem(accountTokenKey, data.token);
    applyBalance(data.user.balance, data.user.demoBalance);
    // The bar and the header have to agree the moment a session exists, because the
    // header controls were disabled for a signed-out visitor and the mirrored ones were
    // disabled to match. `syncAccountControls` is what lifts both, and it also enables
    // the live sync's indicator for the first time.
    syncAccountControls();
    paintLiveIndicator();
    syncNow();

    hideVerifyStep();
    document.getElementById('account-dialog').close();
    document.getElementById('account-password').value = '';
    // A deposit created before sign-in would have been blocked, so a fresh catalog
    // read is enough; no history needs reloading here.
}

async function connectAccount(event) {
    event.preventDefault();
    const email = document.getElementById('account-email').value.trim();
    const password = document.getElementById('account-password').value;
    const button = document.getElementById('connect-submit');
    const mode = document.getElementById('account-form').dataset.authMode || 'login';

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
    document.getElementById('user-balance').textContent = formatBalance(balance);
    document.getElementById('demo-balance').textContent = formatBalance(demoBalance);
    // Kept in state so the withdrawal form can show what is actually available and cap the
    // amount box. It was only ever rendered into the header, which the dialog covers, so
    // the form asked for an amount with no indication of the ceiling.
    accountState.balance = Number(balance);
    syncWithdrawBalance();
}

async function refreshBalance() {
    const token = sessionStorage.getItem(accountTokenKey);
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

function openDeposits() {
    if (!sessionStorage.getItem(accountTokenKey)) {
        document.getElementById('account-dialog').showModal();
        return;
    }
    // The same reset a repeat deposit uses, so reopening the dialog after a completed
    // deposit does not leave the instructions hidden, the submit button stuck on
    // "Generating address...", and the previous countdown still ticking against a
    // deposit the user can no longer see.
    resetDepositForAnother();
    document.getElementById('deposit-dialog').showModal();
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
 * The smallest amount the provider will accept for the currency currently picked.
 *
 * NOWPayments enforces a floor per currency pair, and it is well above a nominal $1 for
 * most coins. The server reports the real one per currency; the picker-level minimum is
 * only the smallest of those, so it is the per-currency value that has to be applied
 * while the user changes coins.
 */
/**
 * The floor the amount box itself enforces: the app's own $1.00.
 *
 * This is deliberately NOT the selected coin's provider minimum. Pinning `min` to a
 * volatile, pair-specific figure meant the advertised $1.00 minimum was unreachable for
 * every coin NOWPayments happens to charge $18 to, and the visible symptom was the amount
 * silently jumping to a number the user never typed. The provider's real floor is
 * reported separately by `providerMinimumForSelectedCurrency`, shown as guidance, and
 * still enforced at payment creation.
 */
function minimumForSelectedCurrency() {
    const appMinimum = depositState.options?.appMinimumUsd;
    return Number.isFinite(appMinimum) && appMinimum > 0 ? appMinimum : 1;
}

/**
 * The coin's real provider floor, or null when the provider has not imposed one.
 */
function providerMinimumForSelectedCurrency() {
    if (depositState.method !== 'crypto') return null;
    const currency = document.getElementById('deposit-currency')?.value;
    const perCurrency = depositState.options?.minimums?.[currency];
    // Only meaningful when it sits above the app's own floor; otherwise it is noise.
    return Number.isFinite(perCurrency) && perCurrency > minimumForSelectedCurrency()
        ? perCurrency
        : null;
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
 * States the limit that actually applies right now, so the reason a coin was rejected is
 * visible before the user submits rather than after.
 *
 * Two facts, deliberately kept apart. The app's own range is the headline, because that is
 * what the box accepts. The provider's per-coin floor is appended as a second sentence, so
 * someone who types a $5 BCH deposit learns why it is refused *before* they submit rather
 * than from a server error afterwards.
 */
function updateDepositAmountHint() {
    const hint = document.getElementById('deposit-amount-hint');
    if (!hint) return;
    const options = depositState.options;
    if (!options) return;

    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();
    const providerMinimum = providerMinimumForSelectedCurrency();

    let text = `Minimum ${formatBalance(minimum)}. Maximum ${formatBalance(maximum)}.`;
    if (providerMinimum) {
        const currency = document.getElementById('deposit-currency')?.value;
        const symbol = cryptoCurrencyNames[currency] || String(currency || '').toUpperCase();
        text += ` ${symbol} deposits start at ${formatBalance(providerMinimum)}.`;
    }
    hint.textContent = text;
    validateDepositAmount();
}

/**
 * Warns about an amount the provider will refuse, before the user submits.
 *
 * The box accepts anything from the app's $1.00, so a $5 Bitcoin Cash deposit is
 * submittable and then rejected by NOWPayments with a server error. Saying so while the
 * amount is still being typed turns a failed submission into a visible, correctable
 * field. It only annotates: it never rewrites the amount, because an amount the user
 * typed and is still editing is not ours to silently replace.
 */
function validateDepositAmount() {
    const hint = document.getElementById('deposit-amount-hint');
    if (!hint) return;
    const providerMinimum = providerMinimumForSelectedCurrency();
    if (!providerMinimum) {
        hint.classList.remove('is-error');
        updateDepositSwapOffer();
        return;
    }
    const amount = Number(document.getElementById('deposit-amount').value);
    const below = Number.isFinite(amount) && amount > 0 && amount < providerMinimum;
    hint.classList.toggle('is-error', below);
    updateDepositSwapOffer();
}

/**
 * States the floor for the coin currently chosen, so it stays on screen after the menu closes.
 *
 * The option labels read "from $X", which makes the choice informed before it is made but
 * leaves the number behind once it is made. It is also the number a user is most likely to
 * misread, so it is labelled explicitly: it is a floor, not a charge, and when it came from
 * the provider it is that provider's volatile per-pair limit rather than this app's rule.
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
    const providerMinimum = providerMinimumForSelectedCurrency();
    const reported = Number(depositState.options?.minimums?.[code]);
    const fromProvider = Number.isFinite(reported) && reported > 0;

    const amount = document.createElement('strong');
    amount.className = 'coin-summary-amount';
    amount.textContent = providerMinimum ? formatBalance(providerMinimum) : 'any amount';

    summary.replaceChildren(
        document.createTextNode(`${name} accepts deposits from `),
        amount,
        document.createTextNode(
            fromProvider
                ? '. That is the payment provider\'s minimum for this network and it moves with their rates.'
                : '. The payment provider\'s minimum for this network is not known right now, so this is our own limit.'
        )
    );
    summary.hidden = false;
}

/**
 * The cheapest coin the provider will actually accept for the amount already in the box.
 *
 * Returns null when the selected coin is already the cheapest, when nothing else qualifies,
 * or when no options have loaded. A coin with no reported floor is treated as accepting the
 * app's own $1.00, because that is the only floor this app enforces itself.
 */
function cheapestCurrencyAccepting(amount) {
    const options = depositState.options;
    const select = document.getElementById('deposit-currency');
    // `cryptoCurrencies` is checked for shape, not just for existence. This runs on every
    // keystroke in the amount box, including before the first options request has resolved and
    // again if that request fails, so it has to survive whatever `depositState.options` happens
    // to be holding rather than assuming the fully-populated server shape.
    if (!options || !select || !Array.isArray(options.cryptoCurrencies)) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const current = select.value;
    const appFloor = minimumForSelectedCurrency();
    let best = null;

    for (const code of options.cryptoCurrencies) {
        if (code === current) continue;
        const reported = Number(options.minimums?.[code]);
        const floor = Number.isFinite(reported) && reported > 0 ? reported : appFloor;
        if (floor > amount) continue;
        if (!best || floor < best.floor) best = { code, floor };
    }
    return best;
}

/**
 * Offers a one-tap switch to a coin that will take the amount already typed.
 *
 * The app advertises a $1.00 minimum, and that promise is only true of some coins: NOWPayments
 * genuinely refuses a Bitcoin Cash deposit under about $18.79, and a handful of other pairs
 * sit in the same range. Telling the user that the amount is too small is necessary and not
 * sufficient, because the actionable part is not "type more" -- it is "use a different coin".
 * Without this, the only way to discover a $1 deposit exists is to read every entry in the
 * picker.
 *
 * Deliberately does not change the amount or the selected coin on its own. Switching a user's
 * payment method because their amount was rejected is not a correction, it is a substitution,
 * and the coin they pick is the one whose network and fees they agreed to. The button performs
 * the change, so it is visible and reversible.
 */
function updateDepositSwapOffer() {
    const offer = document.getElementById('deposit-swap-hint');
    if (!offer) return;

    const hide = () => {
        offer.hidden = true;
        offer.replaceChildren();
    };

    const providerMinimum = providerMinimumForSelectedCurrency();
    const amount = Number(document.getElementById('deposit-amount')?.value);
    if (!providerMinimum || !Number.isFinite(amount) || amount <= 0 || amount >= providerMinimum) {
        hide();
        return;
    }

    const cheaper = cheapestCurrencyAccepting(amount);
    if (!cheaper) {
        hide();
        return;
    }

    const name = cryptoCurrencyNames[cheaper.code] || cheaper.code.toUpperCase();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swap-button';
    button.textContent = `Use ${name} instead — from ${formatBalance(cheaper.floor)}`;

    button.addEventListener('click', () => {
        const select = document.getElementById('deposit-currency');
        if (!select) return;
        select.value = cheaper.code;
        clearDepositMessage();
        // Reuses the currency-change path so the amount bounds, the hint, and the presets all
        // recompute from the new coin. Driving the select and dispatching is what keeps this
        // button from being a second, subtly different implementation of the same change.
        select.dispatchEvent(new Event('change'));
        document.getElementById('deposit-amount')?.focus();
    });

    offer.replaceChildren(
        document.createTextNode(`${formatBalance(amount)} is below the ${formatBalance(providerMinimum)} floor for this coin. `),
        button
    );
    offer.hidden = false;
}

async function loadDepositOptions() {
    const submit = document.getElementById('deposit-submit');
    const title = document.getElementById('deposit-provider-title');
    const copy = document.getElementById('deposit-provider-copy');
    const notice = document.getElementById('provider-notice');
    const providerFinePrint = document.getElementById('deposit-provider-fine-print');
    submit.disabled = true;
    notice.classList.remove('is-ready', 'is-offline', 'is-compact');
    // The fine print belongs to the "ready" state only, so it is cleared with the rest of
    // the notice rather than being left behind if a later load reports an outage.
    providerFinePrint.hidden = true;
    title.textContent = 'Checking payment providers';
    copy.textContent = 'Contacting the configured payment services...';

    try {
        const options = await requestJson('/api/user/payment-options', {
            headers: { Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}` }
        });
        depositState.options = options;

        const stripeButton = document.querySelector('[data-deposit-method="stripe"]');
        const cryptoButton = document.querySelector('[data-deposit-method="crypto"]');
        stripeButton.disabled = !options.stripeAvailable;
        cryptoButton.disabled = !options.cryptoAvailable;
        // A greyed-out card with no explanation is a dead end: the only way to find out why
        // Card is unavailable was to guess. The reason is stated on the card itself, so the
        // answer is where the question is asked.
        describeDepositMethod(stripeButton, options.stripeAvailable
            ? 'Visa, Mastercard, Apple Pay'
            : 'Not configured on this deployment');
        describeDepositMethod(cryptoButton, options.cryptoAvailable
            ? `${options.cryptoCurrencies.length} ${options.cryptoCurrencies.length === 1 ? 'coin' : 'coins'} available`
            : 'Not configured on this deployment');

        const currencySelect = document.getElementById('deposit-currency');
        const previous = currencySelect.value;
        currencySelect.replaceChildren(...options.cryptoCurrencies.map((currency) => {
            const option = document.createElement('option');
            option.value = currency;
            // The provider's own floor is shown in the list itself, phrased as a starting
            // point rather than a hard limit, because that is what it is: NOWPayments will
            // refuse a smaller payment, but the box accepts anything from the app's $1.00.
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
            // Open on the coin the provider will accept the least of. The app advertises a
            // $1.00 minimum, and that is only true in practice if the coin the form happens to
            // start on can actually be funded for that little. Taking the provider's order
            // made the first thing a depositor met a coin with a floor near $18.80, so the
            // advertised minimum was unreachable without the user first having to work out
            // which coins were cheap to start.
            const cheapest = [...options.cryptoCurrencies].sort((a, b) => {
                const floor = (code) => {
                    const value = Number(options.minimums?.[code]);
                    return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
                };
                return floor(a) - floor(b);
            })[0];
            if (cheapest) currencySelect.value = cheapest;
        }

        const amount = document.getElementById('deposit-amount');
        amount.min = String(minimumForSelectedCurrency());
        amount.max = String(maximumForSelectedCurrency());
        // The default 10.00 can sit outside the first coin's range, which would leave the
        // form un-submittable on open with no visible reason why.
        clampDepositAmountToRange();
        updateDepositAmountHint();
        updateCoinSummary();
        syncDepositPresets();

        // Fall back to whichever method actually works rather than leaving the user on
        // a disabled option.
        if (depositState.method === 'stripe' && !options.stripeAvailable && options.cryptoAvailable) {
            depositState.method = 'crypto';
        } else if (depositState.method === 'crypto' && !options.cryptoAvailable && options.stripeAvailable) {
            depositState.method = 'stripe';
        }

        if (options.stripeAvailable || options.cryptoAvailable) {
            notice.classList.add('is-ready', 'is-compact');
            const available = [
                options.stripeAvailable ? 'card' : null,
                options.cryptoAvailable ? 'crypto' : null
            ].filter(Boolean).join(' and ');
            title.textContent = 'Provider available';
            // Once a provider answers, the long explanation is noise between the user and
            // the form. The reassurance that credit waits for confirmation is kept, because
            // it is the one sentence a first-time depositor actually needs; the rest of the
            // wording is moved into the fine print under the form so nothing is lost.
            copy.textContent = `Pay by ${available}.`;
            providerFinePrint.textContent = 'Your balance is credited only after the provider confirms the payment.';
            providerFinePrint.hidden = false;
        } else {
            notice.classList.add('is-offline');
            title.textContent = 'Payment providers are not configured';
            copy.textContent = 'Set Stripe or NOWPayments credentials in the server environment to accept deposits.';
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
        notice.classList.add('is-offline');
        title.textContent = 'Payment providers unavailable';
        copy.textContent = error.message;
        submit.disabled = true;
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

function updateDepositFields() {
    const isCrypto = depositState.method === 'crypto';
    document.querySelectorAll('[data-deposit-method]').forEach((button) => {
        const selected = button.dataset.depositMethod === depositState.method;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });

    document.getElementById('crypto-deposit-fields').hidden = !isCrypto;
    const submit = document.getElementById('deposit-submit');
    submit.textContent = isCrypto ? 'Generate crypto payment address' : 'Continue to secure checkout';

    // Card and crypto have different limits, so the amount bounds and the stated range
    // both have to follow the method as well as the coin.
    const amount = document.getElementById('deposit-amount');
    amount.min = String(minimumForSelectedCurrency());
    amount.max = String(maximumForSelectedCurrency());
    updateDepositAmountHint();

    const chosen = document.querySelector(`[data-deposit-method="${depositState.method}"]`);
    submit.disabled = Boolean(chosen?.disabled) || !(depositState.options?.stripeAvailable || depositState.options?.cryptoAvailable);
}

function syncDepositPresets() {
    const amount = Number(document.getElementById('deposit-amount').value);
    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();
    document.querySelectorAll('[data-deposit-amount]').forEach((button) => {
        const value = Number(button.dataset.depositAmount);
        const selected = amount === value;
        // A coin with a high minimum made the cheap presets a trap: pressing "$5" filled
        // the box with an amount the server always refuses, and the only feedback was a
        // rejection after submitting. Out-of-range presets are disabled instead, so the
        // button state states the limit before the user commits to it.
        const usable = value >= minimum && value <= maximum;
        button.classList.toggle('is-active', selected && usable);
        button.disabled = !usable;
        button.setAttribute('aria-pressed', String(selected && usable));
        button.title = usable ? '' : `Outside the ${formatBalance(minimum)} to ${formatBalance(maximum)} range this app accepts`;
    });
}

/** Fills the amount box with the largest deposit the selected coin will accept. */
function setMaximumDepositAmount() {
    const input = document.getElementById('deposit-amount');
    input.value = maximumForSelectedCurrency().toFixed(2);
    syncDepositPresets();
    validateDepositAmount();
    input.focus();
}

async function createDeposit(event) {
    event.preventDefault();
    const submit = document.getElementById('deposit-submit');
    const isCrypto = depositState.method === 'crypto';
    const originalLabel = submit.textContent;
    submit.disabled = true;
    submit.textContent = isCrypto ? 'Generating address...' : 'Creating checkout...';
    setFormMessage('deposit-message', '');

    try {
        const result = await requestJson('/api/user/deposits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}`
            },
            body: JSON.stringify({
                amount: Number(document.getElementById('deposit-amount').value),
                method: depositState.method,
                currency: isCrypto ? document.getElementById('deposit-currency').value : null
            })
        });

        if (result.checkoutUrl) {
            window.location.assign(result.checkoutUrl);
            return;
        }

        renderDepositInstructions(result);
        document.getElementById('deposit-form').hidden = true;
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
        updateDepositFields();
    } finally {
        if (!document.getElementById('deposit-form').hidden) {
            submit.disabled = false;
            submit.textContent = originalLabel;
        }
    }
}

function renderDepositInstructions(result) {
    const instructions = document.getElementById('deposit-instructions');
    instructions.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = 'Send your deposit';

    const lead = document.createElement('p');
    lead.className = 'receipt-lead';
    // The amount and the network are repeated as plain text below the QR on purpose. A
    // wallet that ignores the QR still has to be told the exact figure, and these are the
    // two values that cannot be guessed.
    lead.textContent = `Send exactly ${result.payAmount} ${result.assetCode} on the ${result.network} network.`;

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

    stage.append(details);
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
    window.clearInterval(depositStatusTimer);
    depositStatusTimer = undefined;

    const instructions = document.getElementById('deposit-instructions');
    instructions.replaceChildren();
    instructions.hidden = true;

    const form = document.getElementById('deposit-form');
    form.hidden = false;

    const submit = document.getElementById('deposit-submit');
    submit.disabled = false;
    submit.textContent = depositState.method === 'crypto'
        ? 'Generate crypto payment address'
        : 'Continue to secure checkout';

    clearDepositMessage();
    updateDepositFields();
    document.getElementById('deposit-amount').focus();
}

/* ------------------------------------------------------------ withdrawals */

function openWithdrawal() {
    if (!sessionStorage.getItem(accountTokenKey)) {
        document.getElementById('account-dialog').showModal();
        return;
    }
    setFormMessage('withdraw-message', '');
    // A previous visit may have left the confirmation panel showing, which would open the
    // dialog straight onto a receipt for a request that is already in the history below.
    const confirmation = document.getElementById('withdraw-confirmation');
    confirmation.hidden = true;
    confirmation.replaceChildren();
    document.getElementById('withdraw-form').hidden = false;
    document.getElementById('withdraw-dialog').showModal();
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
    try {
        if (!withdrawState.options) {
            container.textContent = 'Loading payment methods...';
            withdrawState.options = await requestJson('/api/user/withdrawal-options', {
                headers: { Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}` }
            });
        }
        const options = withdrawState.options;

        // The floor and ceiling are the provider's, but the balance is the real limit, so
        // both are reconciled here rather than leaving the box to a stale pair of bounds.
        const amount = document.getElementById('withdraw-amount');
        amount.min = String(options.minimumUsd);
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
            document.getElementById('withdraw-dialog').close();
            document.getElementById('account-dialog').showModal();
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
    document.getElementById('crypto-withdraw-fields').hidden = !isCrypto;

    const addressLabel = document.getElementById('withdraw-address-label');
    const address = document.getElementById('withdraw-address');
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
        document.getElementById('withdraw-tag').required = needsTag;
    }

    // The network picker is the authoritative list for the chosen asset, so it is only
    // required while a crypto destination is being described.
    document.getElementById('withdraw-network').required = isCrypto;
    updateWithdrawSummary();
}

function updateWithdrawSummary() {
    renderWithdrawalConfirm();
    const summary = document.getElementById('withdraw-summary');
    const amount = Number(document.getElementById('withdraw-amount').value);
    const destination = document.getElementById('withdraw-address').value.trim();
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
        summary.hidden = true;
        return;
    }

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
    const address = document.getElementById('withdraw-address').value.trim();
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
        if (tagField && !tagField.hidden && !document.getElementById('withdraw-tag').value.trim()) {
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
    return {
        amount: Number(document.getElementById('withdraw-amount').value),
        paymentMethod: withdrawState.method,
        paymentAddress: document.getElementById('withdraw-address').value.trim(),
        assetCode: isCrypto ? withdrawState.asset : null,
        network: isCrypto ? withdrawState.network : null,
        destinationTag: isCrypto
            ? document.getElementById('withdraw-tag').value.trim() || null
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
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}`
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
        document.getElementById('withdraw-address').focus();
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

    button.disabled = true;
    button.textContent = 'Submitting...';
    setFormMessage('withdraw-message', '');

    try {
        const result = await requestJson('/api/user/withdraw', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}`
            },
            body: JSON.stringify({ ...withdrawalRequestBody(), code })
        });

        showWithdrawalConfirmation(result);
        notifyWithdrawalSubmitted(result);
        document.getElementById('withdraw-amount').value = '';
        document.getElementById('withdraw-address').value = '';
        document.getElementById('withdraw-tag').value = '';
        // The code is single-use and already spent server-side. Clearing it stops the next
        // withdrawal from being submitted with a dead one, and stops it being read over a
        // shoulder in the meantime.
        document.getElementById('withdraw-code').value = '';
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
            document.getElementById('withdraw-code').value = '';
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
    form.hidden = true;

    const panel = document.getElementById('withdraw-confirmation');
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
        document.getElementById('withdraw-dialog').close();
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
    panel.replaceChildren();
    panel.hidden = true;

    const form = document.getElementById('withdraw-form');
    form.hidden = false;
    clearWithdrawMessage();
    updateWithdrawFields();
    document.getElementById('withdraw-amount').focus();
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
            document.getElementById('deposit-provider-copy').hidden = true;
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
    const token = sessionStorage.getItem(accountTokenKey);
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

    document.getElementById('deposit-success-amount').textContent =
        formatBalance(deposit.amount);
    document.getElementById('deposit-success-lead').textContent = deposit.asset_code
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
            headers: { Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}` }
        });
        applyBalance(data.balance, data.demoBalance);
        balanceText = formatBalance(data.balance);
    } catch (error) {
        // The credit is confirmed regardless; a balance read that fails is not a reason
        // to withhold the confirmation, so the field is simply left unavailable.
    }
    document.getElementById('deposit-success-balance').textContent = balanceText;

    const receiptLink = document.getElementById('deposit-success-receipt');
    receiptLink.href = deposit.receipt_url || `/deposit/${deposit.id}`;

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
    container.replaceChildren(list);
    container.hidden = false;
}

/**
 * Announces a deposit that was credited while the user was away.
 *
 * The in-dialog poll only runs while the deposit dialog is open, so a payment that
 * confirmed ten minutes later was never announced at all. This is a single check when the
 * page loads and whenever the tab regains focus, and it is the difference between "my
 * money arrived" being an event and being a number that changed at some point.
 */
async function announceMissedCredits() {
    if (!sessionStorage.getItem(accountTokenKey)) return;
    try {
        const items = await requestJson('/api/user/deposits', {
            headers: { Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}` }
        });
        const missed = items.find((item) => {
            const status = String(item.status || '').toLowerCase();
            return (status === 'confirmed' || status === 'paid') && !creditedDepositsSeen.has(item.id);
        });
        if (!missed) return;
        // Mark it seen before showing, so a failure to render cannot cause a repeat on the
        // next focus event.
        creditedDepositsSeen.add(missed.id);
        await showDepositSuccess(missed);
    } catch (error) {
        // Silent by design: this is a courtesy notification, and a failed check must not
        // surface as an error the user did not cause.
    }
}
