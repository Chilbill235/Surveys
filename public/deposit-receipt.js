/**
 * The standalone deposit receipt.
 *
 * A crypto deposit has no provider checkout to return to -- the customer is shown an
 * address, leaves the site, and pays from their wallet -- so this page is the "where did
 * my money go" answer. It polls the single-deposit endpoint while the payment is
 * unsettled and stops as soon as it is terminal, the same rule the dialog uses, so a
 * settled deposit is not polled forever.
 *
 * The page is a shell: the id comes from the path and every field on screen comes from
 * the authenticated endpoint, so it cannot show a deposit that is not the signed-in
 * user's. It holds no secrets and logs nothing.
 */

const sessionKey = 'offerNetworkSessionToken';
const terminalStatuses = new Set(['confirmed', 'paid', 'failed', 'expired', 'cancelled', 'refunded']);

let pollTimer;

/** The deposit id is the last path segment: /deposit/1234.
 *
 * `RegExp#test` returns a boolean, and using it as if it returned a match array is how this
 * page used to show "That link does not point at a deposit" for every URL including the ones
 * that did: `match[1]` was always undefined. `exec` returns the array, which is what makes the
 * capture group reachable.
 */
function depositIdFromLocation() {
    const match = /\/deposit\/(\d+)\/?$/.exec(window.location.pathname);
    return match ? match[1] : null;
}

function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value ?? '');
}

function statusLabel(status) {
    const known = {
        pending: 'Awaiting payment',
        confirming: 'Confirming with the provider',
        confirmed: 'Credited to your balance',
        paid: 'Credited to your balance',
        failed: 'Payment failed',
        expired: 'Payment expired',
        cancelled: 'Cancelled',
        refunded: 'Refunded'
    };
    return known[status] || status;
}

function setMessage(title, lead, state) {
    document.getElementById('receipt-heading').textContent = title;
    document.getElementById('receipt-lead').textContent = lead;
    const card = document.getElementById('receipt-card');
    card.dataset.state = state;
    document.getElementById('receipt-mark').dataset.state = state;
}

function renderFacts(deposit) {
    const facts = document.getElementById('receipt-facts');
    const rows = [
        ['Amount', `${formatMoney(deposit.amount)} ${deposit.currency_code || 'USD'}`]
    ];
    if (deposit.asset_code) rows.push(['Asset', deposit.asset_code]);
    if (deposit.network) rows.push(['Network', deposit.network]);
    if (deposit.pay_amount) rows.push(['Sent', `${deposit.pay_amount} ${deposit.asset_code || ''}`.trim()]);
    rows.push(['Status', statusLabel(deposit.status)]);
    rows.push(['Reference', `#${deposit.id}`]);
    if (deposit.deposit_address) rows.push(['Address', deposit.deposit_address]);
    rows.push(['Created', new Date(deposit.created_at).toLocaleString()]);
    // Only while the deposit can still be paid. Once it is settled the deadline is history, and
    // showing a timestamp in the past next to "credited" reads as a second problem.
    if (deposit.expires_at && !terminalStatuses.has(String(deposit.status || '').toLowerCase())) {
        rows.push(['Pay by', new Date(deposit.expires_at).toLocaleString()]);
    }
    if (deposit.credited_at) {
        rows.push(['Credited', new Date(deposit.credited_at).toLocaleString()]);
    }

    const list = document.createElement('div');
    for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        // A 40-character wallet address breaks the two-column layout on a phone.
        if (String(value).length > 34) dd.className = 'is-wrappable';
        list.append(dt, dd);
    }
    facts.replaceChildren(list);
    facts.hidden = false;
}

function stopPolling() {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
}

async function load(showFooter) {
    const id = depositIdFromLocation();
    if (!id) {
        setMessage('Deposit not found', 'That link does not point at a deposit.', 'failed');
        document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
        return;
    }

    const token = sessionStorage.getItem(sessionKey);
    if (!token) {
        setMessage(
            'Sign in to view this deposit',
            'Deposit receipts belong to your account, so this page needs you signed in on this device.',
            'pending'
        );
        document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
        document.getElementById('receipt-actions').hidden = false;
        document.getElementById('receipt-copy-link').hidden = true;
        return;
    }

    let deposit;
    try {
        const response = await fetch(`/api/user/deposits/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status === 404) {
            setMessage('Deposit not found', 'No deposit with that reference belongs to your account.', 'failed');
            document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
            return;
        }
        if (response.status === 401) {
            setMessage('Session expired', 'Sign in again to view this deposit.', 'pending');
            document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
            return;
        }
        if (!response.ok) throw new Error('Could not load the deposit.');
        deposit = await response.json();
    } catch (error) {
        setMessage('Could not load this deposit', error.message, 'failed');
        document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
        return;
    }

    document.getElementById('receipt-card').setAttribute('aria-busy', 'false');
    renderFacts(deposit);
    document.getElementById('receipt-actions').hidden = false;

    const status = String(deposit.status || '').toLowerCase();
    if (status === 'confirmed' || status === 'paid') {
        stopPolling();
        setMessage(
            `Credited ${formatMoney(deposit.amount)} ${deposit.currency_code || 'USD'}`,
            'This deposit has been confirmed and added to your balance.',
            'confirmed'
        );
        setFootnote('Keep this link if you need to show the deposit again.');
        return;
    }
    if (terminalStatuses.has(status)) {
        stopPolling();
        setMessage(
            statusLabel(status),
            'This deposit will not be credited. Start a new deposit from the offers page.',
            'failed'
        );
        return;
    }

    setMessage(
        'Waiting for your payment',
        `Send ${deposit.pay_amount ? `${deposit.pay_amount} ${deposit.asset_code}` : 'the exact amount'} ` +
        `to the address below${deposit.network ? ` on the ${deposit.network} network` : ''}. ` +
        'This page updates itself once the provider confirms it.',
        'pending'
    );
    setFootnote('You can close this page. Your balance updates whether or not you keep it open.');

    // Poll only while unsettled, and only while the tab is visible. A hidden tab polling
    // every few seconds for a payment that may not arrive for an hour is pure waste.
    if (!pollTimer) {
        pollTimer = window.setInterval(() => {
            if (document.hidden) return;
            load(false);
        }, 10000);
    }
}

function setFootnote(text) {
    const footnote = document.getElementById('receipt-footnote');
    if (!text) {
        footnote.hidden = true;
        return;
    }
    footnote.textContent = text;
    footnote.hidden = false;
}

function wireCopyLink() {
    const copy = document.getElementById('receipt-copy-link');
    copy.addEventListener('click', async (event) => {
        // The link is a real navigation target, so it must stay a real link for
        // middle-click, right-click and keyboard users. The click handler only takes over
        // for a plain left click, where copying is what the label promises.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        try {
            await navigator.clipboard.writeText(window.location.href);
            copy.textContent = 'Link copied';
        } catch {
            copy.textContent = 'Copy from the address bar';
        }
    });
}

document.addEventListener('visibilitychange', () => {
    // Coming back to the tab should show the current state, not whatever was last polled.
    if (!document.hidden && !pollTimer) load(false);
});

wireCopyLink();
load(true);
