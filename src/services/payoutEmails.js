const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('./publicBaseUrl');

/**
 * The messages that follow a crypto payout leaving the platform or being refused.
 *
 * A withdrawal request already produces a confirmation-code email, and that is the last
 * message the app used to send about it. From there the user had to watch a balance that no
 * longer includes the money and wonder whether it was on its way: the code proved intent, and
 * nothing afterwards proved anything. These two messages close that gap -- one when the payout
 * is actually sent, one when it is refused and the money is back.
 *
 * Both are advisory and neither throws. The withdrawal is already committed one way or the
 * other by the time either is sent, so a mail provider outage is a missing notification, not
 * a failed payout, and reporting it as the latter would tell a user their money was returned
 * when it was not.
 */

/** The site root, or null when there is nowhere public to point a link. */
function siteUrl() {
    const base = resolvePublicBaseUrl();
    if (!base.ok || !base.baseUrl) return null;
    if (!isPubliclyReachable(base.baseUrl)) return null;
    return String(base.baseUrl).replace(/\/+$/, '');
}

function historyUrl() {
    const root = siteUrl();
    return root ? `${root}/history` : null;
}

/**
 * The history link as a `link` block, so it survives a client that drops the button.
 *
 * Every message here carries a "View history" button, and every one of them also needs the
 * URL written out: these are the messages a user opens on a phone to find out whether their
 * money arrived, which is exactly the client most likely to have lost the button. Returns an
 * empty list when there is no public base URL, so a caller can spread it into `blocks`
 * without a conditional.
 */
function historyLinkBlocks() {
    const history = historyUrl();
    return history ? [{ type: 'link', label: 'Or open your withdrawal history:', url: history }] : [];
}

/**
 * The amount, formatted for a human.
 *
 * Stored as a numeric, so it is formatted here rather than passed through pre-formatted. A
 * value that is not a finite number renders as "NaN" rather than being refused, which is
 * worse than a missing line: it looks like a template bug and hides the real problem.
 */
function formatAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : null;
}

/**
 * Sent the moment a payout batch is accepted and released to the provider.
 *
 * This is the message the withdrawal flow was missing at its most alarming point. The balance
 * is debited the instant the request is stored, and until now the next thing the user heard
 * was either nothing or the final "sent" confirmation. In between, their balance had dropped
 * by the full amount and there was no evidence anything was happening -- which reads as "my
 * money is gone" rather than as "it is being sent", and is exactly when someone opens a
 * support ticket or submits a second withdrawal.
 *
 * It is deliberately honest about the stage. The batch has been created and verified with the
 * provider, which means the payout is queued on-chain, not that the money has arrived. Saying
 * "sent" here would be a promise about a blockchain confirmation nobody has seen yet, and the
 * user would be right to distrust it when the arrival email is late.
 */
async function sendWithdrawalStartedEmail({ to, amount, assetCode, network, destination }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal-started email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatAmount(amount);
    const destinationLabel = String(destination || '').slice(0, 60);
    const assetLabel = String(assetCode || '').toUpperCase() || 'crypto';
    const networkLabel = String(network || '').trim();
    const method = networkLabel ? `${assetLabel} (${networkLabel})` : assetLabel;

    const blocks = [
        { type: 'callout', tone: 'success', text: `${money} is on its way to your wallet.` },
        { type: 'details', items: [
            { label: 'Amount', value: money || 'Unknown' },
            { label: 'Method', value: method },
            { label: 'Sending to', value: destinationLabel || 'Your wallet' }
        ] },
        { type: 'paragraph', text:
            'We have sent this to the payment provider. It is now waiting for the blockchain to confirm, ' +
            'which usually takes a few minutes and can take longer when the network is busy.' }
    ];

    const history = historyUrl();
    blocks.push(...historyLinkBlocks());

    return sendEmail({
        to,
        subject: `${money} withdrawal is on its way`,
        text: renderEmailText({
            intro: `We have accepted your withdrawal of ${money || 'an unknown amount'} and sent it to your wallet.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'We will email you again as soon as the transfer is confirmed on the blockchain. Nothing more is needed from you.'
        }),
        html: renderEmail({
            preheader: `${money} is being sent to your wallet.`,
            heading: 'Withdrawal on its way',
            intro: `We have accepted your withdrawal of ${money || 'an unknown amount'} and sent it to your wallet.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'We will email you again as soon as the transfer is confirmed on the blockchain. Nothing more is needed from you.'
        })
    });
}

/** Sent when a payout is confirmed on-chain and the withdrawal is marked paid. */
async function sendWithdrawalSentEmail({ to, amount, assetCode, network, destination, batchId }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal-sent email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatAmount(amount);
    const destinationLabel = String(destination || '').slice(0, 60);
    const assetLabel = String(assetCode || '').toUpperCase() || 'crypto';
    const networkLabel = String(network || '').trim();
    const method = networkLabel ? `${assetLabel} (${networkLabel})` : assetLabel;

    const blocks = [
        { type: 'callout', tone: 'success', text: `${money} has been sent to your wallet.` },
        { type: 'details', items: [
            { label: 'Amount', value: money || 'Unknown' },
            { label: 'Method', value: method },
            { label: 'Sent to', value: destinationLabel || 'Your wallet' }
        ] }
    ];
    if (batchId) {
        blocks[1].items.push({ label: 'Reference', value: String(batchId) });
    }

    const history = historyUrl();
    blocks.push(...historyLinkBlocks());

    return sendEmail({
        to,
        subject: `${money} withdrawn from your account`,
        text: renderEmailText({
            intro: `Your withdrawal of ${money || 'an unknown amount'} has been sent.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you did not request this withdrawal, contact support immediately.'
        }),
        html: renderEmail({
            preheader: `${money} has been withdrawn to your wallet.`,
            heading: 'Withdrawal sent',
            intro: `Your withdrawal of ${money || 'an unknown amount'} has been sent to your wallet.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you did not request this withdrawal, contact support immediately.'
        })
    });
}

/**
 * Sent when a payout is held because its outcome is unknown.
 *
 * The case this exists for: a claim is taken, the provider is called, and the call fails in a
 * way that does not say whether the money moved. The claim is deliberately kept rather than
 * released -- releasing it is the one action that can pay a withdrawal twice -- so the row
 * sits in `processing` until an operator or a reconciliation pass settles it.
 *
 * Silence is what made that unworkable. The balance was debited the moment the request was
 * stored, so a user in this state is short by the full amount with no message and no way to
 * tell "being sent" from "stuck". They file a ticket, or submit a second withdrawal.
 *
 * So it says the two things that are actually true and the one that matters: the money has
 * **not** been sent, the amount is still held for them, and nothing is needed from them.
 * It does not promise a time, because there is none to give -- a held payout is waiting on a
 * provider lookup, and how long that takes is not something this system controls.
 */
async function sendWithdrawalDelayedEmail({ to, amount, assetCode, network, reason, stage = 'submit' }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal-delayed email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatAmount(amount);
    const assetLabel = String(assetCode || '').toUpperCase() || 'crypto';
    const networkLabel = String(network || '').trim();
    const method = networkLabel ? `${assetLabel} (${networkLabel})` : assetLabel;
    const detail = String(reason || '').trim().slice(0, 200);

    // The two stages are not interchangeable, and saying the wrong one is worse than saying
    // nothing. Before the batch exists, nothing can have been sent, so the amount is
    // certainly still held. Once a batch has been created and only the release is
    // unconfirmed, the transfer may genuinely be in flight -- claiming it has not moved would
    // be a false statement about the user's money, and could talk them into chasing something
    // that is already on its way.
    const moneyMayHaveMoved = stage === 'verify';

    const callout = moneyMayHaveMoved
        ? 'Your withdrawal has been sent to the payment provider and may already be moving. We are confirming the exact status before we tell you it has arrived.'
        : 'Your money has not left. The full amount is still held against your balance and is not lost.';

    const intro = moneyMayHaveMoved
        ? `We are still confirming the status of your ${money || ''} withdrawal. Nothing is needed from you.`.replace(/\s+/g, ' ').trim()
        : `We have not been able to send your ${money || ''} withdrawal, so we have paused it rather than risk sending it twice.`;

    const items = [
        { label: 'Amount', value: money || 'Unknown' },
        { label: 'Method', value: method },
        { label: 'Status', value: moneyMayHaveMoved ? 'Sent - confirmation pending' : 'Held - not yet sent' }
    ];

    const history = historyUrl();
    const message = {
        subject: moneyMayHaveMoved
            ? `${money || 'Your'} withdrawal is on its way - confirming the exact status`
            : `${money || 'Your'} withdrawal is delayed, not lost`,
        preheader: moneyMayHaveMoved
            ? `${money || 'Your withdrawal'} has been sent. We are confirming before we say it has arrived.`
            : `${money || 'Your withdrawal'} has not been sent yet. The money is still held for you.`,
        heading: moneyMayHaveMoved ? 'Your withdrawal is on its way' : 'Your withdrawal is on hold',
        footnote: 'We will email you as soon as this is resolved, whichever way it goes.'
    };

    const blocks = [
        { type: 'callout', tone: moneyMayHaveMoved ? 'warning' : 'warning', text: callout },
        { type: 'details', items },
        ...(detail ? [{ type: 'callout', tone: 'neutral', text: `What we saw: ${detail}` }] : []),
        { type: 'paragraph', text: moneyMayHaveMoved
            ? 'We are checking with the payment provider now. You do not need to do anything, and you should not ' +
              'submit this withdrawal again - we will confirm when it completes, or return it to your balance.'
            : 'We are checking with the payment provider now. You do not need to do anything, and you should not ' +
              'submit this withdrawal again - we will either send it or return it to your balance.' },
        ...historyLinkBlocks()
    ];

    return sendEmail({
        to,
        subject: message.subject,
        text: renderEmailText({
            intro,
            blocks,
            action: history ? { label: 'View withdrawal history', url: history } : null,
            footnote: message.footnote
        }),
        html: renderEmail({
            preheader: message.preheader,
            heading: message.heading,
            intro,
            blocks,
            action: history ? { label: 'View withdrawal history', url: history } : null,
            footnote: message.footnote
        })
    });
}

/** Sent when a payout is refused and the balance is returned. */
async function sendWithdrawalRefundedEmail({ to, amount, reason }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal-refunded email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatAmount(amount);
    const detail = String(reason || 'The payout provider refused this withdrawal.').slice(0, 200);
    const history = historyUrl();
    // Named here rather than inline in both render calls, so the two copies cannot drift --
    // and so the history link can be appended once and appear in both.
    const blocks = [
        { type: 'callout', tone: 'neutral', text: detail },
        ...historyLinkBlocks()
    ];

    return sendEmail({
        to,
        subject: `${money} returned to your account`,
        text: renderEmailText({
            intro: `Your withdrawal of ${money || 'an unknown amount'} was not sent and the money has been returned to your balance.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you would like to try again, you can submit a new withdrawal request.'
        }),
        html: renderEmail({
            preheader: `${money} has been returned to your balance.`,
            heading: 'Withdrawal returned',
            intro: `Your withdrawal of ${money || 'an unknown amount'} was not sent, so the money has been returned to your balance.`,
            blocks,
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you would like to try again, you can submit a new withdrawal request.'
        })
    });
}

module.exports = {
    sendWithdrawalStartedEmail,
    sendWithdrawalSentEmail,
    sendWithdrawalDelayedEmail,
    sendWithdrawalRefundedEmail
};