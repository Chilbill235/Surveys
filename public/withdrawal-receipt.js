/**
 * The standalone withdrawal receipt.
 *
 * A withdrawal had no page of its own, so a user told their payout had been sent was sent to the
 * account page and had to find one row in a list. This is the counterpart to `deposit-receipt.js`
 * and answers the same question in the other direction: not "did the money arrive" but "did my
 * money leave, where did it go, and can I check".
 *
 * It polls while the payout is in flight and stops as soon as the row is terminal, and it shows
 * a refund as a refund. That distinction is the whole reason this page exists: a `failed`
 * withdrawal with a refund behind it is not a lost payment, and a receipt that showed the status
 * without the ledger row would read as one.
 *
 * The page is a shell. The id comes from the path and every field comes from the authenticated
 * owner-scoped endpoint, so it cannot show a withdrawal that is not the signed-in user's.
 */

const sessionKey = 'offerNetworkSessionToken';

/** True once nothing more can change about this withdrawal. */
const terminalStatuses = new Set(['paid', 'failed', 'cancelled', 'expired', 'refunded']);

let pollTimer;

/** The withdrawal id is the last path segment: /receipt/withdrawal/1234. */
function withdrawalIdFromLocation() {
    const match = /\/receipt\/withdrawal\/(\d+)\/?$/.exec(window.location.pathname);
    return match ? match[1] : null;
}

function requireSession() {
    if (window.RewardZoneSession && !window.RewardZoneSession.enforce()) return false;
    return Boolean(sessionStorage.getItem(sessionKey));
}

/**
 * Why a withdrawal did not go out, in words the owner of the money can use.
 *
 * A copy of the helper in `app.js`, which this page does not load -- it is a standalone page with
 * two other scripts and no app bundle. Duplicated deliberately rather than shared through a new
 * file: a shared module would mean a `<script>` tag on every page that formats a receipt, and
 * this is a single pure function whose whole body is a switch over the row's own state. The risk
 * worth guarding is the two drifting apart, and `test/withdrawalReason.test.js` asserts both say
 * the same thing about the same rows.
 */
function withdrawalFailureText(withdrawal = {}) {
    const status = String(withdrawal.status || '').toLowerCase();
    const payoutStatus = String(withdrawal.payout_status || '').toUpperCase();

    if (['SUBMISSION_UNKNOWN', 'VERIFY_UNKNOWN'].includes(payoutStatus)) {
        return 'We are confirming this transfer with our payout provider. Nothing is needed from you, '
            + 'and the money stays yours either way.';
    }
    if (status === 'refunded' || status === 'failed') {
        return 'We were not able to send this withdrawal, so the full amount has been returned to your balance.';
    }
    if (status === 'cancelled') {
        return 'This withdrawal was cancelled and the full amount has been returned to your balance.';
    }
    if (status === 'paid' || payoutStatus === 'FINISHED') return '';
    if (['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'REJECTED_NOT_CHECKED'].includes(payoutStatus)) {
        return 'We were not able to send this withdrawal. If it has not returned to your balance, '
            + 'it will be refunded shortly.';
    }
    return '';
}

/**
 * The payout stage as a short noun phrase.
 *
 * Replaced `String(withdrawal.payout_status).replace(/_/g, ' ').toLowerCase()`, which printed the
 * provider's internal vocabulary: a row in `CREATING` read "creating", which describes what our
 * system is doing rather than anything about the money. The `String(...)` with no fallback also
 * printed the literal text "null" wherever `payout_status` was null.
 */
function payoutStageLabel(withdrawal = {}) {
    const stage = String(withdrawal.payout_status || '').toUpperCase();
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
 * A timestamp, in words.
 *
 * `hour12` is set explicitly rather than left to the browser's locale. Left alone it follows
 * whatever the operating system is set to, so the same receipt read "4:16 PM" for one reader and
 * "16:16" for the next -- and a 24-hour clock reads as military time to anyone who has not grown
 * up with it. A receipt is a record someone keeps, so it should not change shape with the reader's
 * machine. The date stays in the reader's own locale; only the clock format is pinned.
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

function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value ?? '');
}

/** `0.00834784` with a ticker, which is the unit a withdrawal is actually sent in. */
function coin(value, currency) {
    const amount = String(value ?? '').trim();
    if (!amount) return '';
    const ticker = String(currency || '').trim().toUpperCase();
    return ticker ? `${amount} ${ticker}` : amount;
}

/**
 * What the page says at the top, which is not the same question as the badge in a list.
 *
 * A refund outranks a failure, because "Failed" beside a debited balance reads as money lost and
 * the ledger is the only thing that says the money came back.
 */
function outcomeOf(withdrawal) {
    const status = String(withdrawal.status || '').toLowerCase();
    if (withdrawal.refunded_at) {
        return {
            state: 'refunded',
            title: `${formatMoney(withdrawal.amount)} returned to your balance`,
            lead: 'This withdrawal was not sent, and the full amount has been put back on your balance.'
        };
    }
    if (status === 'paid') {
        return {
            state: 'confirmed',
            title: `${formatMoney(withdrawal.amount)} sent`,
            lead: withdrawal.provider_reference
                ? 'This withdrawal has been sent to your payment method. The transaction can be looked up on the blockchain below.'
                : 'This withdrawal has been sent to your payment method.'
        };
    }
    if (status === 'failed' || status === 'cancelled') {
        return {
            state: 'failed',
            title: 'This withdrawal was not sent',
            // Composed rather than quoted: `failure_reason` is the operator's record and is
            // usually the provider's own error text, which reads as a statement about the
            // user's own balance when it is not -- "Insufficient balance" describes our payout
            // provider's account. The one thing they can act on is whether the money came back.
            lead: withdrawalFailureText(withdrawal) || 'The payout could not be completed.'
        };
    }
    return {
        state: 'pending',
        title: 'Your withdrawal is being processed',
        lead: 'We are sending it to your payment method. This page updates itself when that finishes.'
    };
}

function setMessage(title, lead, state) {
    const heading = document.getElementById('receipt-heading');
    if (heading) heading.textContent = title;
    const leadEl = document.getElementById('receipt-lead');
    if (leadEl) leadEl.textContent = lead;
    const card = document.getElementById('receipt-card');
    if (card) card.dataset.state = state;
    const mark = document.getElementById('receipt-mark');
    if (mark) mark.dataset.state = state;
}

function setFootnote(text) {
    const footnote = document.getElementById('receipt-footnote');
    if (!footnote) return;
    if (!text) {
        footnote.hidden = true;
        return;
    }
    footnote.textContent = text;
    footnote.hidden = false;
}

/**
 * A link to a block explorer, or plain text when there is nothing to link to.
 *
 * The server decides whether a link exists and the value is only ever used as an `href`, so
 * this trusts `explorer.transactionUrl` rather than building one here -- a second copy of the
 * chain table in the client is a second copy to get wrong, and a wrong one produces a link to a
 * transaction that was never on any chain.
 */
function explorerCell(label, url) {
    if (!url) return null;
    const link = document.createElement('a');
    link.className = 'receipt-link';
    link.href = url;
    link.textContent = label;
    // A new tab, and no opener: the explorer is a third party, and `noopener` is the difference
    // between "can read this page" and "cannot".
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
}

function renderFacts(withdrawal) {
    const facts = document.getElementById('receipt-facts');
    if (!facts) return;

    const outcome = outcomeOf(withdrawal);
    const explorer = withdrawal.explorer || {};
    const method = withdrawal.payment_method === 'crypto'
        ? `${withdrawal.asset_code || ''}${withdrawal.network ? ` on ${withdrawal.network}` : ''}`.trim()
        : 'Payment method';

    const rows = [
        ['Amount requested', `${formatMoney(withdrawal.amount)} USD`],
        ['Method', method],
        ['Status', outcome.state === 'refunded' ? 'Refunded' : String(withdrawal.status || '')],
        ['Reference', `#${withdrawal.id}`],
        ['Destination', withdrawal.payout_address || withdrawal.payment_address || ''],
        ['Sent', coin(withdrawal.payout_coin_amount, withdrawal.payout_currency || withdrawal.asset_code)],
        ['Network fee', coin(withdrawal.payout_fee_coin, withdrawal.payout_currency || withdrawal.asset_code)],
        ['Requested', formatDateTime(withdrawal.created_at)]
    ];
    if (withdrawal.payout_submitted_at) {
        rows.push(['Sent to provider', formatDateTime(withdrawal.payout_submitted_at)]);
    }
    if (withdrawal.paid_at) {
        rows.push(['Confirmed', formatDateTime(withdrawal.paid_at)]);
    }
    if (withdrawal.refunded_at) {
        rows.push(['Returned to balance', formatDateTime(withdrawal.refunded_at)]);
    }
    if (withdrawal.payout_status) {
        rows.push(['Payout stage', payoutStageLabel(withdrawal)]);
    }
    const reason = withdrawalFailureText(withdrawal);
    if (reason) rows.push(['Reason', reason]);
    if (withdrawal.provider_reference) {
        rows.push(['Transaction reference', withdrawal.provider_reference]);
    }

    const list = document.createElement('div');
    for (const [term, value] of rows) {
        if (!value) continue;
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        // A wallet address and a transaction hash are both unbreakable runs of 40-90 characters,
        // and the two-column facts layout has nowhere to put them.
        if (String(value).length > 34) dd.className = 'is-wrappable';
        list.append(dt, dd);
    }

    // The explorer links go last, as their own block. They are the reason someone opens this
    // page -- "verify it actually went" -- and burying them in a list of labels is how they
    // end up unused.
    const txLink = explorerCell(
        explorer.transactionUrl ? `View on ${explorer.explorerName}` : '',
        explorer.transactionUrl
    );
    const addressLink = explorerCell(
        explorer.addressUrl ? `Open destination on ${explorer.explorerName}` : '',
        explorer.addressUrl
    );
    if (txLink || addressLink) {
        const links = document.createElement('div');
        links.className = 'receipt-links';
        if (txLink) links.append(txLink);
        if (addressLink) links.append(addressLink);
        list.append(links);
    }

    facts.replaceChildren(list);
    facts.hidden = false;
}

function stopPolling() {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
}

function getReceiptCard() {
    return document.getElementById('receipt-card');
}

async function load() {
    if (!requireSession()) return;
    const card = getReceiptCard();
    if (!card) return;

    const id = withdrawalIdFromLocation();
    if (!id) {
        setMessage('Withdrawal not found', 'That link does not point at a withdrawal.', 'failed');
        card.setAttribute('aria-busy', 'false');
        return;
    }

    const token = sessionStorage.getItem(sessionKey);
    if (!token) {
        setMessage(
            'Sign in to view this withdrawal',
            'Withdrawal receipts belong to your account, so this page needs you signed in on this device.',
            'pending'
        );
        card.setAttribute('aria-busy', 'false');
        const actions = document.getElementById('receipt-actions');
        if (actions) actions.hidden = false;
        return;
    }

    let withdrawal;
    try {
        const response = await fetch(`/api/user/withdrawals/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status === 404) {
            setMessage(
                'Withdrawal not found',
                'No withdrawal with that reference belongs to your account.',
                'failed'
            );
            card.setAttribute('aria-busy', 'false');
            return;
        }
        if (response.status === 401) {
            if (window.RewardZoneSession) {
                window.RewardZoneSession.goToLogin(window.RewardZoneSession.currentReturnPath());
                return;
            }
            setMessage('Session expired', 'Sign in again to view this withdrawal.', 'pending');
            card.setAttribute('aria-busy', 'false');
            return;
        }
        if (!response.ok) throw new Error('Could not load the withdrawal.');
        withdrawal = await response.json();
    } catch (error) {
        setMessage('Could not load this withdrawal', error.message, 'failed');
        card.setAttribute('aria-busy', 'false');
        return;
    }

    card.setAttribute('aria-busy', 'false');
    const outcome = outcomeOf(withdrawal);
    setMessage(outcome.title, outcome.lead, outcome.state);
    renderFacts(withdrawal);

    const actions = document.getElementById('receipt-actions');
    if (actions) actions.hidden = false;

    if (terminalStatuses.has(String(withdrawal.status || '').toLowerCase())) {
        stopPolling();
        setFootnote('Keep this link if you need to show the withdrawal again.');
        return;
    }

    setFootnote('You can close this page. We will email you when the payout finishes.');
    // Poll only while the payout is in flight, and only while the tab is visible: a hidden tab
    // checking every few seconds for a payout that may not finish for an hour is pure waste.
    if (!pollTimer) {
        pollTimer = window.setInterval(() => {
            if (document.hidden) return;
            load();
        }, 10000);
    }
}

function wireCopyLink() {
    const copy = document.getElementById('receipt-copy-link');
    if (!copy) return;
    copy.addEventListener('click', async (event) => {
        // The link is a real navigation target, so it stays a real link for middle-click,
        // right-click and keyboard users. The handler only takes over for a plain left click,
        // where copying is what the label promises.
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
    if (!document.hidden && !pollTimer) load();
});

wireCopyLink();
load();
