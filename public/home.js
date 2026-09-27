/* Home page: a short catalog preview plus the summary figures in the stat strip. */

const previewLimit = 3;

document.addEventListener('DOMContentLoaded', loadHomeOffers);

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

async function loadHomeOffers() {
    const count = document.getElementById('home-offer-count');
    const grid = document.getElementById('home-offers');

    try {
        const response = await fetch('/api/offers');
        if (!response.ok) throw new Error('Offers could not be loaded right now.');
        const offers = await response.json();
        if (!Array.isArray(offers)) throw new Error('The offers response was invalid.');

        renderStats(offers);

        count.textContent = `${offers.length} ${offers.length === 1 ? 'offer' : 'offers'} available`;
        grid.replaceChildren();
        if (offers.length === 0) {
            grid.textContent = 'New offers will appear here when they are available.';
            return;
        }

        const fragment = document.createDocumentFragment();
        offers.slice(0, previewLimit).forEach((offer, index) => {
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
        grid.append(fragment);
    } catch (error) {
        count.textContent = 'Offer catalog unavailable';
        grid.textContent = error.message;
        setStat('stat-offers', '--');
        setStat('stat-best', '--');
        setStat('stat-surveys', '--');
    }
}

function renderStats(offers) {
    const rewards = offers
        .map((offer) => Number(offer.payout))
        .filter((value) => Number.isFinite(value));
    const best = rewards.length ? Math.max(...rewards) : null;

    setStat('stat-offers', String(offers.length));
    setStat('stat-best', best === null ? '--' : formatMoney(best));
    setStat('stat-surveys', String(offers.filter((offer) => offer.offer_type === 'survey').length));
}
