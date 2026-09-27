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

const offerState = { all: [], search: '', sort: 'featured' };
const depositState = { options: null, method: 'crypto' };
/**
 * Ids of deposits already seen in a credited state.
 *
 * The success screen must fire on the *transition*, not on the state. Without this, every
 * poll re-announced the same already-credited deposit forever -- which is also why the
 * old code needed a one-shot `depositHistorySignature` flag to stop it looping.
 */
const creditedDepositsSeen = new Set();
const withdrawState = { options: null, method: 'paypal', asset: '', network: '' };
const accountState = { balance: NaN };


let depositStatusTimer;
let depositHistorySignature = '';

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
    document.getElementById('deposit-amount').addEventListener('input', syncDepositPresets);
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

    document.getElementById('offer-search').addEventListener('input', (event) => {
        offerState.search = event.target.value.trim().toLowerCase();
        renderOffers();
    });
    document.getElementById('offer-sort').addEventListener('change', (event) => {
        offerState.sort = event.target.value;
        renderOffers();
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
    });
    document.getElementById('withdraw-dialog').addEventListener('close', () => {
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
    loadOffers();
    // A payment that confirmed while the tab was closed has no other way to announce
    // itself, and the deposit dialog's poll only runs while that dialog is open.
    announceMissedCredits();

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) announceMissedCredits();
    });
});

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

/** Ends a session and returns the user to the sign-in dialog. */
function signOut() {
    sessionStorage.removeItem(accountTokenKey);
    syncAccountControls();
}

function handleUnauthorized(error) {
    if (error.status !== 401) return false;
    signOut();
    return true;
}

/* ---------------------------------------------------------------- catalog */

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
    } finally {
        skeletons.hidden = true;
        grid.removeAttribute('aria-busy');
    }
}

function renderOffers() {
    const grid = document.getElementById('offer-grid');
    const count = document.getElementById('offer-count');
    const visible = offerState.all.filter((offer) =>
        String(offer.title || '').toLowerCase().includes(offerState.search)
    );

    if (offerState.sort === 'payout-high') {
        visible.sort((a, b) => Number(b.payout) - Number(a.payout));
    } else if (offerState.sort === 'payout-low') {
        visible.sort((a, b) => Number(a.payout) - Number(b.payout));
    } else if (offerState.sort === 'title') {
        visible.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }

    count.textContent = `${visible.length} ${visible.length === 1 ? 'offer' : 'offers'}`;
    grid.replaceChildren();

    if (visible.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = offerState.all.length === 0
            ? 'There are no offers available right now. Check back soon.'
            : 'No offers match your search.';
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
        const type = document.createElement('span');
        type.className = 'offer-type';
        type.textContent = `${isSurvey ? 'Survey' : 'Offer'} | ${String(offer.network_name || 'Partner')}`;
        top.append(id, type);

        const heading = document.createElement('h2');
        heading.className = 'offer-title';
        heading.textContent = title;

        const reward = document.createElement('div');
        reward.className = 'offer-reward';
        const rewardLabel = document.createElement('span');
        rewardLabel.textContent = offer.is_demo ? 'Test-only reward' : 'Reward';
        const amount = document.createElement('strong');
        if (offer.is_demo) {
            amount.className = 'demo-reward';
            amount.textContent = Number.isFinite(payout) ? `${formatBalance(payout)} demo` : '--';
        } else {
            amount.textContent = Number.isFinite(payout) ? formatBalance(payout) : '--';
        }
        reward.append(rewardLabel, amount);

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
        sessionStorage.setItem(accountTokenKey, data.token);
        applyBalance(data.user.balance, data.user.demo_balance);
    // The narrow-screen action bar duplicates the header controls, because the header
    // has to stay one row on a phone and the primary actions belong under the thumb.
    // Each bar button forwards to its header counterpart so the behaviour, the disabled
    // state, and the sign-in label all have exactly one implementation.
    document.querySelectorAll('[data-mirror]').forEach((barButton) => {
        const target = document.getElementById(barButton.dataset.mirror);
        if (target) barButton.addEventListener('click', () => target.click());
    });

    syncAccountControls();

        document.getElementById('account-dialog').close();
        document.getElementById('account-password').value = '';
        // A deposit created before sign-in would have been blocked, so a fresh catalog
        // read is enough; no history needs reloading here.
    } catch (error) {
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
        setFormMessage('deposit-message', `Raised to ${formatBalance(corrected)}, the minimum for this coin.`);
    } else {
        setFormMessage('deposit-message', `Reduced to ${formatBalance(corrected)}, the maximum for this coin.`);
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
function minimumForSelectedCurrency() {
    const options = depositState.options;
    if (!options) return 1;
    if (depositState.method !== 'crypto') return options.minimumUsd;
    const currency = document.getElementById('deposit-currency')?.value;
    const perCurrency = options.minimums?.[currency];
    return Number.isFinite(perCurrency) && perCurrency > 0 ? perCurrency : options.minimumUsd;
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
 */
function updateDepositAmountHint() {
    const hint = document.getElementById('deposit-amount-hint');
    if (!hint) return;
    const options = depositState.options;
    if (!options) return;
    const minimum = minimumForSelectedCurrency();
    const maximum = maximumForSelectedCurrency();
    if (depositState.method === 'crypto') {
        const currency = document.getElementById('deposit-currency')?.value;
        const name = cryptoCurrencyNames[currency] || String(currency || '').toUpperCase();
        hint.textContent = `Minimum ${formatBalance(minimum)} in ${name}. Maximum ${formatBalance(maximum)}.`;
    } else {
        hint.textContent = `Minimum ${formatBalance(minimum)}. Maximum ${formatBalance(maximum)}.`;
    }
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

        const currencySelect = document.getElementById('deposit-currency');
        const previous = currencySelect.value;
        currencySelect.replaceChildren(...options.cryptoCurrencies.map((currency) => {
            const option = document.createElement('option');
            option.value = currency;
            option.textContent = cryptoCurrencyNames[currency] || currency.toUpperCase();
            return option;
        }));
        if (options.cryptoCurrencies.includes(previous)) currencySelect.value = previous;

        const amount = document.getElementById('deposit-amount');
        amount.min = String(minimumForSelectedCurrency());
        amount.max = String(maximumForSelectedCurrency());
        // The default 10.00 can sit outside the first coin's range, which would leave the
        // form un-submittable on open with no visible reason why.
        clampDepositAmountToRange();
        updateDepositAmountHint();
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
        button.title = usable ? '' : `Outside the ${minimum} to ${maximum} range for this coin`;
    });
}

/** Fills the amount box with the largest deposit the selected coin will accept. */
function setMaximumDepositAmount() {
    const input = document.getElementById('deposit-amount');
    input.value = maximumForSelectedCurrency().toFixed(2);
    syncDepositPresets();
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
        // Poll only while a deposit is unsettled, and stop as soon as one confirms. The
        // previous version polled for as long as the dialog stayed open, issuing a
        // history request every ten seconds even after the balance had been updated.
        window.clearInterval(depositStatusTimer);
        depositHistorySignature = '';
        depositStatusTimer = window.setInterval(async () => {
            const outcome = await loadDepositHistory();
            if (outcome.settled && depositHistorySignature !== 'settled') {
                depositHistorySignature = 'settled';
                window.clearInterval(depositStatusTimer);
                depositStatusTimer = undefined;
            }
        }, 10000);
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
    note.textContent = 'Your balance updates automatically once the provider confirms the payment.';

    const again = document.createElement('button');
    again.className = 'button button-light button-wide';
    again.type = 'button';
    again.textContent = 'Make another deposit';
    again.addEventListener('click', resetDepositForAnother);

    stage.append(details);
    instructions.append(heading, lead, stage, note, again);
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

    updateWithdrawFields();
    return true;
}

async function submitWithdrawal(event) {
    event.preventDefault();
    const button = document.getElementById('withdraw-submit');

    // Checked before the request rather than after, so a typo does not cost a round trip.
    if (!validateWithdrawalDestination()) {
        document.getElementById('withdraw-address').focus();
        return;
    }

    button.disabled = true;
    button.textContent = 'Submitting...';
    setFormMessage('withdraw-message', '');

    try {
        const isCrypto = withdrawState.method === 'crypto';
        const result = await requestJson('/api/user/withdraw', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}`
            },
            body: JSON.stringify({
                amount: Number(document.getElementById('withdraw-amount').value),
                paymentMethod: withdrawState.method,
                paymentAddress: document.getElementById('withdraw-address').value.trim(),
                assetCode: isCrypto ? withdrawState.asset : null,
                network: isCrypto ? withdrawState.network : null,
                destinationTag: isCrypto
                    ? document.getElementById('withdraw-tag').value.trim() || null
                    : null
            })
        });

        showWithdrawalConfirmation(result);
        document.getElementById('withdraw-amount').value = '';
        document.getElementById('withdraw-address').value = '';
        document.getElementById('withdraw-tag').value = '';
        updateWithdrawSummary();
        await refreshBalance();
        await loadWithdrawalHistory();
    } catch (error) {
        setFormMessage('withdraw-message', error.message, 'error');
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

async function loadPaymentHistory(endpoint, containerId, kind) {
    const container = document.getElementById(containerId);
    container.textContent = 'Loading history...';
    try {
        const items = await requestJson(endpoint, {
            headers: { Authorization: `Bearer ${sessionStorage.getItem(accountTokenKey)}` }
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

            row.append(details, badge);
            fragment.append(row);
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
