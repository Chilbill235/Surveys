const pool = require('../config/db');
const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('./publicBaseUrl');

/**
 * The two messages a deposit produces: the instructions to pay, and the receipt once it lands.
 *
 * Deposits were the one financial flow in the app with no email at all. Every other
 * money-moving event -- registration, verification, the withdrawal code, the payout, the
 * refund -- speaks to the user, and a deposit was silent at both ends. That silence costs
 * money in a way the others do not, because a crypto deposit is not complete when it is
 * created. The user is handed an address and a QR code on a web page, and then has to leave,
 * open a wallet, and send an exact figure to a destination that stops accepting it. If they
 * close the tab, or switch devices, or lose the panel, the address and the amount are gone --
 * the amounts are not reproducible, because the exchange rate has moved and one address serves
 * every figure quoted against it -- and the money either never arrives or arrives with no way
 * to claim it. So the instructions are emailed at creation, where they are the durable copy.
 *
 * And the receipt exists because the credit is the part that is hardest to reason about after
 * the fact. The balance simply becomes larger, with no statement of what it was for; a user
 * watching an account they did not expect to be credited has no way to tell a deposit landing
 * from a mistake. A receipt naming the amount, the method, the new balance, and the reference
 * is what makes the balance legible.
 *
 * Both are advisory and neither throws. The deposit row and the balance are already committed
 * by the time either is sent, so a mail provider fault is a missing notification, not a failed
 * deposit, and reporting it as the latter would tell a user their money is lost when it is
 * sitting in their account.
 */

/**
 * The site root, or null when there is nowhere public to point a link.
 *
 * A localhost base URL is a legitimate provider callback target during local development and
 * useless for a link a recipient has to click, so the button is dropped rather than sent
 * pointing at the sender's own machine. The message is still worth sending without it: the
 * deposit address, the exact amount, and the balance are the point, and none of them are links.
 */
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

function offersUrl() {
    const root = siteUrl();
    return root ? `${root}/offers` : null;
}

/**
 * A fiat figure, formatted for a human.
 *
 * A value that is not a finite number renders as null rather than "NaN": a missing line is
 * obviously missing, while "NaN" reads like a template bug and hides the real problem.
 */
function formatUsd(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : null;
}

/**
 * A coin figure, formatted for a human.
 *
 * Deliberately not the fixed two decimals used for fiat. Crypto amounts span many orders of
 * magnitude, and rounding 0.00042 to two places produces 0.00 -- an instruction to send
 * nothing to an address that only accepts a non-zero amount. Enough digits to survive a
 * wallet's own rounding, with the provider's trailing zeros dropped so `12.50000000` reads as
 * `12.5`.
 */
function formatCoin(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;
    if (amount === 0) return '0';
    return amount.toFixed(8).replace(/\.?0+$/, '');
}

/** A provider timestamp, rendered in the recipient's own locale, or null if unusable. */
function formatWhen(value) {
    if (!value) return null;
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
    }) + ' UTC';
}

/** A destination, trimmed to a length that still fits a mail client. */
function addressLabel(value) {
    const address = String(value || '').trim();
    if (!address) return null;
    return address.length > 70 ? `${address.slice(0, 67)}...` : address;
}

/**
 * How the deposit was paid, in the words the user chose it by.
 *
 * A card deposit is named as a card because that is the only fact about it worth repeating, and
 * a crypto deposit is named by coin and network because sending USDT on the wrong chain is the
 * single most common way a crypto deposit is lost.
 */
function methodLabelFor({ provider, assetCode, network }) {
    if (String(provider || '').toLowerCase() === 'stripe') return 'Card';
    const asset = String(assetCode || '').trim().toUpperCase();
    const chain = String(network || '').trim();
    if (asset && chain) return `${asset} (${chain})`;
    return asset || 'Crypto';
}

/** The user's address, or null when there is nobody to write to. */
function recipient(email) {
    const address = String(email || '').trim();
    return address || null;
}

/** Sent when a crypto deposit is created, carrying everything needed to pay it. */
async function sendDepositInstructionsEmail({
    to,
    amount,
    balance,
    method,
    depositId,
    payAddress,
    payAmount,
    payinExtraId,
    expiresAt,
}) {
    const addressee = recipient(to);
    if (!addressee) return { sent: false, reason: 'no-recipient' };
    if (!isEmailConfigured()) {
        console.error('Deposit-instructions email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatUsd(amount);
    const coinAmount = formatCoin(payAmount);
    const destination = addressLabel(payAddress);
    const balanceLine = formatUsd(balance);
    const deadline = formatWhen(expiresAt);

    // The figure and the destination are listed before the amount, because a user who sends
    // the right coins to the wrong address has lost the money for good, while the reverse is
    // only a wasted fee. The exact amount is not reproducible later, so it is stated here.
    const items = [
        { label: 'Send exactly', value: coinAmount ? `${coinAmount} ${method}`.trim() : 'the amount shown on your deposit page' },
        { label: 'Deposit address', value: destination || 'Unavailable' }
    ];
    if (payinExtraId) {
        // A destination tag or memo is part of the delivery on the chains that route by one.
        // Without it the funds confirm and are never credited, and the address alone looks
        // perfectly sufficient -- which is why it gets its own line and not a footnote.
        items.push({ label: 'Destination tag', value: String(payinExtraId) });
    }
    if (deadline) items.push({ label: 'Send before', value: deadline });
    if (money) items.push({ label: 'Value', value: money });
    if (balanceLine) items.push({ label: 'Your balance', value: `${balanceLine} before this deposit` });
    if (depositId) items.push({ label: 'Reference', value: `#${depositId}` });

    const blocks = [
        { type: 'callout', tone: 'warning', text:
            `This deposit is not finished until ${coinAmount ? `${coinAmount} ${method}` : 'the funds'} arrives at the address below. ` +
            'The balance will not change until it does.' },
        { type: 'details', items },
        { type: 'list', items: [
            'Send only the coin shown, on the network shown. The same coin on a different chain is a different asset.',
            'Check the amount before sending. The provider refunds an underpayment, and the deposit is not credited until it is made whole.',
            'You do not need to keep this page open. These details are all that is needed to complete the payment.'
        ] }
    ];

    const history = historyUrl();
    const offers = offersUrl();

    return sendEmail({
        to: addressee,
        subject: `Complete your ${method} deposit`,
        text: renderEmailText({
            intro: `Here are the details for the ${money || 'crypto'} deposit you just started. Send the exact amount to the address below to add it to your balance.`,
            blocks,
            action: history ? { label: 'View deposit history', url: history } : null,
            footnote: 'If you did not start this deposit, ignore this email and contact support. No funds have left your account.'
        }),
        html: renderEmail({
            preheader: `Send ${coinAmount ? `${coinAmount} ${method}` : 'your deposit'} to finish adding funds to your account.`,
            heading: 'Finish your deposit',
            intro: `Here is everything needed to complete the ${money || 'crypto'} deposit you just started.`,
            blocks,
            action: history ? { label: 'View deposit history', url: history } : null,
            footnote: 'If you did not start this deposit, ignore this email and contact support. No funds have left your account.'
        })
    });
}

/** Sent when a deposit is credited, naming what arrived and what the balance is now. */
async function sendDepositConfirmedEmail({
    to,
    amount,
    balance,
    method,
    reference,
}) {
    const addressee = recipient(to);
    if (!addressee) return { sent: false, reason: 'no-recipient' };
    if (!isEmailConfigured()) {
        console.error('Deposit-confirmed email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatUsd(amount);
    const balanceLine = formatUsd(balance);

    const items = [
        { label: 'Amount added', value: money || 'Unknown' },
        { label: 'Paid with', value: method }
    ];
    if (balanceLine) items.push({ label: 'New balance', value: balanceLine });
    if (reference) items.push({ label: 'Reference', value: String(reference) });

    const offers = offersUrl();
    const history = historyUrl();

    return sendEmail({
        to: addressee,
        subject: `${money || 'Your deposit'} added to your balance`,
        text: renderEmailText({
            intro: `Your deposit of ${money || 'an unknown amount'} has arrived and has been added to your balance.`,
            blocks: [
                { type: 'callout', tone: 'success', text: `${money || 'The deposit'} has been added to your balance.` },
                { type: 'details', items }
            ],
            action: offers ? { label: 'Complete an offer', url: offers } : null,
            footnote: 'Funds are available to withdraw immediately. If this deposit is not one you recognise, contact support.'
        }),
        html: renderEmail({
            preheader: `${money || 'Your deposit'} has been added to your balance.`,
            heading: 'Deposit received',
            intro: `Your deposit of ${money || 'an unknown amount'} has arrived and is now part of your balance.`,
            blocks: [
                { type: 'callout', tone: 'success', text: `${money || 'The deposit'} has been added to your balance.` },
                { type: 'details', items }
            ],
            action: offers ? { label: 'Complete an offer', url: offers } : null,
            footnote: 'Funds are available to withdraw immediately. If this deposit is not one you recognise, contact support.'
        })
    });
}

/**
 * Sent when a deposit will not complete.
 *
 * A crypto deposit is an unfinished thing from the moment it is created, and it can end three
 * ways that leave the user waiting: the provider times the address out, the payment is
 * refused, or an underpayment is never made whole. Every one of those used to end in silence
 * -- the deposit simply stopped appearing in the account, indistinguishable from a bug to
 * someone who had already sent the money and was watching for it to land.
 *
 * The important thing this has to say is that the money was never credited, so a user who sees
 * it knows to look for the funds in their own wallet rather than here. Without that line, a
 * failed deposit reads as "the platform has my money", which is the belief that turns a
 * routine expiry into a chargeback.
 */
async function sendDepositFailedEmail({ to, amount, method, reason, expired }) {
    const addressee = recipient(to);
    if (!addressee) return { sent: false, reason: 'no-recipient' };
    if (!isEmailConfigured()) {
        console.error('Deposit-failed email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const money = formatUsd(amount);
    const detail = String(reason || '').trim()
        || (expired
            ? 'The payment address expired before the full amount was received.'
            : 'The payment could not be completed.');

    const items = [{ label: 'Amount', value: money || 'Unknown' }];
    if (method) items.push({ label: 'Method', value: method });

    const offers = offersUrl();

    return sendEmail({
        to: addressee,
        // Named for what happened rather than for the state change. "Deposit failed" is a
        // system fact; "your deposit did not go through" is the sentence a person needed.
        subject: `${money || 'Your'} deposit did not go through`,
        text: renderEmailText({
            intro: `Your deposit of ${money || 'an unknown amount'} could not be completed, so nothing was added to your balance.`,
            blocks: [
                { type: 'callout', tone: 'danger', text: detail },
                { type: 'details', items },
                { type: 'callout', tone: 'neutral', text:
                    'If you sent funds for this deposit, they were not credited to your account. Check your wallet or ' +
                    'contact support with the transaction hash and we will help you recover them.' }
            ],
            action: offers ? { label: 'Start a new deposit', url: offers } : null,
            footnote: 'If you did not attempt this deposit, no action is needed and nothing was taken from your account.'
        }),
        html: renderEmail({
            preheader: `Your ${money || ''} deposit was not completed and nothing was credited.`.replace(/\s+/g, ' ').trim(),
            heading: 'Deposit did not complete',
            intro: `Your deposit of ${money || 'an unknown amount'} could not be completed, so nothing was added to your balance.`,
            blocks: [
                { type: 'callout', tone: 'danger', text: detail },
                { type: 'details', items },
                { type: 'callout', tone: 'neutral', text:
                    'If you sent funds for this deposit, they were not credited to your account. Check your wallet or ' +
                    'contact support with the transaction hash and we will help you recover them.' }
            ],
            action: offers ? { label: 'Start a new deposit', url: offers } : null,
            footnote: 'If you did not attempt this deposit, no action is needed and nothing was taken from your account.'
        })
    });
}

/**
 * Looks up the address a deposit's messages should go to, and the balance to quote.
 *
 * `req.user` carries no email -- it is built from the token and holds only the session fields
 * a handler needs to authenticate with -- so the address is read from the account row here
 * rather than threaded through from a controller. A user with no address on file gets no
 * message, which is the same outcome as having no mail provider configured.
 */
async function loadRecipient(userId) {
    const result = await pool.query(
        'SELECT email, balance FROM users WHERE id = $1',
        [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const email = recipient(row.email);
    if (!email) return null;
    return { email, balance: row.balance };
}

/**
 * Sends the instructions for a crypto deposit that has just been created.
 *
 * Called after the deposit row is written and the provider has issued an address, because
 * before that there is nothing to instruct anyone to do. Returns a result object rather than
 * throwing: a failure here is a missing email, and the caller has a deposit row and a QR code
 * in the user's hands regardless.
 */
async function notifyDepositInstructions({ userId, depositId, assetCode, network, payAddress, payAmount, payinExtraId, expiresAt, amount }) {
    try {
        const target = await loadRecipient(userId);
        if (!target) {
            console.error(`Deposit ${depositId}: no email address on file, instructions not sent.`);
            return { sent: false, reason: 'no-recipient' };
        }
        return await sendDepositInstructionsEmail({
            to: target.email,
            amount,
            balance: target.balance,
            method: methodLabelFor({ provider: 'nowpayments', assetCode, network }),
            depositId,
            payAddress,
            payAmount,
            payinExtraId,
            expiresAt
        });
    } catch (error) {
        console.error(`Deposit ${depositId}: instructions email failed (${error.message}).`);
        return { sent: false, reason: 'instructions-email-failed' };
    }
}

/**
 * Sends the receipt for a deposit that has just been credited.
 *
 * Called by every path that can credit a balance -- the NOWPayments callback, the Stripe
 * webhook, and the reconciliation sweep -- each of them only after its transaction has
 * committed, and only for the one call that actually performed the credit. The lookup happens
 * here rather than in the transaction so the message can never delay or fail a commit.
 */
async function notifyDepositCredited({ depositId }) {
    try {
        const result = await pool.query(
            `SELECT d.id, d.provider, d.asset_code, d.network, d.amount, d.provider_payment_id,
                    u.email, u.balance
             FROM deposits d
             JOIN users u ON u.id = d.user_id
             WHERE d.id = $1`,
            [depositId]
        );
        const deposit = result.rows[0];
        if (!deposit) {
            console.error(`Deposit ${depositId}: no row to confirm, receipt not sent.`);
            return { sent: false, reason: 'unknown-deposit' };
        }
        const email = recipient(deposit.email);
        if (!email) {
            console.error(`Deposit ${depositId}: no email address on file, receipt not sent.`);
            return { sent: false, reason: 'no-recipient' };
        }
        return await sendDepositConfirmedEmail({
            to: email,
            amount: deposit.amount,
            balance: deposit.balance,
            method: methodLabelFor(deposit),
            reference: deposit.provider_payment_id || deposit.id
        });
    } catch (error) {
        console.error(`Deposit ${depositId}: receipt email failed (${error.message}).`);
        return { sent: false, reason: 'receipt-email-failed' };
    }
}

/**
 * Sends the notice for a deposit that has stopped being payable.
 *
 * Called from the paths that move a deposit to `failed` or `expired`, and only after the
 * write has committed. Reads the row itself rather than trusting the caller to carry the
 * fields, so a status change applied from the reconciliation sweep and one applied from a
 * callback produce the same message.
 */
async function notifyDepositFailed({ depositId, reason = null }) {
    try {
        const result = await pool.query(
            `SELECT d.id, d.provider, d.asset_code, d.network, d.amount, d.status, u.email
             FROM deposits d
             JOIN users u ON u.id = d.user_id
             WHERE d.id = $1`,
            [depositId]
        );
        const deposit = result.rows[0];
        if (!deposit) {
            console.error(`Deposit ${depositId}: no row to report, failure notice not sent.`);
            return { sent: false, reason: 'unknown-deposit' };
        }
        const email = recipient(deposit.email);
        if (!email) {
            console.error(`Deposit ${depositId}: no email address on file, failure notice not sent.`);
            return { sent: false, reason: 'no-recipient' };
        }
        return await sendDepositFailedEmail({
            to: email,
            amount: deposit.amount,
            method: methodLabelFor(deposit),
            reason,
            expired: String(deposit.status || '').toLowerCase() === 'expired'
        });
    } catch (error) {
        console.error(`Deposit ${depositId}: failure notice failed (${error.message}).`);
        return { sent: false, reason: 'failure-email-failed' };
    }
}

module.exports = {
    sendDepositInstructionsEmail,
    sendDepositConfirmedEmail,
    sendDepositFailedEmail,
    notifyDepositInstructions,
    notifyDepositCredited,
    notifyDepositFailed,
    formatCoin,
    formatUsd,
    methodLabelFor
};
