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

/** Sent when a payout is refused and the balance is returned. */
async function sendWithdrawalRefundedEmail({ to, amount, reason }) {
    if (!isEmailConfigured()) {
        console.error('Withdrawal-refunded email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatAmount(amount);
    const detail = String(reason || 'The payout provider refused this withdrawal.').slice(0, 200);
    const history = historyUrl();

    return sendEmail({
        to,
        subject: `${money} returned to your account`,
        text: renderEmailText({
            intro: `Your withdrawal of ${money || 'an unknown amount'} was not sent and the money has been returned to your balance.`,
            blocks: [
                { type: 'callout', tone: 'neutral', text: detail }
            ],
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you would like to try again, you can submit a new withdrawal request.'
        }),
        html: renderEmail({
            preheader: `${money} has been returned to your balance.`,
            heading: 'Withdrawal returned',
            intro: `Your withdrawal of ${money || 'an unknown amount'} was not sent, so the money has been returned to your balance.`,
            blocks: [
                { type: 'callout', tone: 'neutral', text: detail }
            ],
            action: history ? { label: 'View history', url: history } : null,
            footnote: 'If you would like to try again, you can submit a new withdrawal request.'
        })
    });
}

module.exports = {
    sendWithdrawalStartedEmail,
    sendWithdrawalSentEmail,
    sendWithdrawalRefundedEmail
};