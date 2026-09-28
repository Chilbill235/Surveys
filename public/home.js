/* Home page: a short catalog preview plus the summary figures in the stat strip. */

/**
 * How many offers the preview shows. The full catalog is one click away, and a
 * preview that shows everything is just a slower-loading version of that page.
 */
const PREVIEW_LIMIT = 3;

/**
 * Give up on the offer fetch after this long. Without a timeout, a request that
 * hangs -- a cold serverless function, a stalled connection -- leaves the
 * skeleton on screen forever, and the user has no way to tell whether the page
 * is still working or broken.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The message shown when the catalog cannot be loaded.
 *
 * A fixed string, not `error.message`. The fetch error for a network failure is
 * `TypeError: Failed to fetch`, and for a 5xx it is whatever the server wrote in
 * the body. Both are debug text, and neither belongs on a page a user is reading.
 * The detail goes to the console, where it is useful.
 */
const LOAD_ERROR_MESSAGE = 'Offers could not be loaded right now.';

document.addEventListener('DOMContentLoaded', () => {
    loadHomeOffers();

    const retry = document.getElementById('home-offers-retry');
    if (retry) {
        retry.addEventListener('click', () => {
            // The error banner is hidden on the new attempt so a slow retry does
            // not sit behind a stale failure message.
            hideError();
            loadHomeOffers();
        });
    }
});

function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
        : '--';
}

function setStat(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function showError(message) {
    const banner = document.getElementById('home-offers-error');
    const text = document.getElementById('home-offers-error-text');
    if (text) text.textContent = message;
    if (banner) banner.hidden = false;
}

function hideError() {
    const banner = document.getElementById('home-offers-error');
    if (banner) banner.hidden = true;
}

/** Marks the grid as busy and returns it, or null if the page is missing it. */
function beginLoading() {
    const grid = document.getElementById('home-offers');
    if (!grid) return null;

    // The skeletons are `aria-hidden`, so a screen reader sees an empty grid
    // while the fetch is running. `aria-busy` is what tells it to wait rather
    // than announce the emptiness.
    grid.setAttribute('aria-busy', 'true');
    return grid;
}

/** Clears the loading skeletons. Called once the real cards, or an error, are ready. */
function clearSkeletons(grid) {
    if (!grid) return;
    grid.removeAttribute('aria-busy');
    grid.replaceChildren();
}

async function loadHomeOffers() {
    const count = document.getElementById('home-offer-count');
    const grid = beginLoading();
    if (!grid) return;

    if (count) count.textContent = 'Loading offers...';

    // A per-attempt controller. If the user clicks retry while the first request
    // is still in flight, the first request is aborted and its `catch` sees an
    // AbortError it can ignore, rather than racing the retry and rendering the
    // older result over the newer one.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch('/api/offers', {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`Offers endpoint returned ${response.status}.`);
        }

        const offers = await response.json();
        if (!Array.isArray(offers)) {
            throw new Error('The offers response was not an array.');
        }

        clearSkeletons(grid);
        hideError();
        renderStats(offers);
        renderOfferPreview(grid, offers, count);
    } catch (error) {
        // An abort is not a failure to report. It happens when the timeout fires
        // or when a retry cancels the first attempt, and in both cases the code
        // that initiated the abort has already decided what to do next.
        if (error.name === 'AbortError') {
            clearSkeletons(grid);
            if (count) count.textContent = 'Loading timed out';
            showError('The offer list took too long to load.');
            setStat('stat-offers', '--');
            setStat('stat-best', '--');
            setStat('stat-surveys', '--');
            return;
        }

        // The real message is for the console, not for the page. A user reading
        // `Failed to fetch` learns nothing; an operator reading it in the console
        // learns everything.
        console.error('Home page could not load offers:', error);
        clearSkeletons(grid);
        if (count) count.textContent = 'Offer catalog unavailable';
        showError(LOAD_ERROR_MESSAGE);
        setStat('stat-offers', '--');
        setStat('stat-best', '--');
        setStat('stat-surveys', '--');
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Renders up to `PREVIEW_LIMIT` cards. The grid is already cleared by the caller,
 * so this only appends.
 */
function renderOfferPreview(grid, offers, count) {
    if (count) {
        count.textContent = offers.length === 0
            ? 'No offers are available right now'
            : `${offers.length} ${offers.length === 1 ? 'offer' : 'offers'} available`;
    }

    if (offers.length === 0) {
        // A user with no offers and a user whose fetch failed need different
        // messages, and the empty state is rendered as its own element rather
        // than as the grid's textContent so the two do not look the same.
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'New offers will appear here when partners confirm them.';
        grid.append(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    offers.slice(0, PREVIEW_LIMIT).forEach((offer, index) => {
        const isSurvey = offer.offer_type === 'survey';

        const item = document.createElement('article');
        item.className = 'home-offer';
        // Custom property through CSSOM; a style attribute is blocked by the CSP.
        item.style.setProperty('--card-delay', `${index * 60}ms`);

        const network = document.createElement('span');
        network.className = 'home-offer-network';
        network.textContent = `${isSurvey ? 'Survey' : 'Offer'} | ${String(offer.network_name || 'Partner')}`;

        const title = document.createElement('h3');
        title.textContent = String(offer.title || 'Untitled offer');

        const reward = document.createElement('span');
        reward.className = offer.is_demo ? 'home-offer-reward is-demo' : 'home-offer-reward';
        reward.textContent = offer.is_demo
            ? `Test-only credit: ${formatMoney(offer.payout)}`
            : formatMoney(offer.payout);

        item.append(network, title, reward);
        fragment.append(item);
    });

    // The whole preview is one append, which is one layout pass, rather than
    // three appends each triggering its own.
    grid.append(fragment);
}

/**
 * Fills in the three figures in the summary strip.
 *
 * `Math.max(...rewards)` spreads the array into an argument list, which throws
 * `RangeError: Maximum call stack size exceeded` somewhere around 100,000
 * elements. That is not a real catalogue size today, but the fix is one line and
 * the failure mode is a blank page.
 */
function renderStats(offers) {
    let best = null;
    let surveyCount = 0;

    for (const offer of offers) {
        if (offer.offer_type === 'survey') surveyCount += 1;

        const reward = Number(offer.payout);
        if (!Number.isFinite(reward)) continue;
        if (best === null || reward > best) best = reward;
    }

    setStat('stat-offers', String(offers.length));
    setStat('stat-best', best === null ? '--' : formatMoney(best));
    setStat('stat-surveys', String(surveyCount));
}