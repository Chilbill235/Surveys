const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('./publicBaseUrl');

/**
 * The two messages that bracket account creation.
 *
 * A service that only sends a code and then goes quiet leaves the user with no confirmation
 * that anything happened: the code is proof of *work outstanding*, never proof that the
 * account now exists. So registration gets a welcome, and successful verification gets a
 * thank-you that also says what the account can now do -- which is the moment the user is
 * most likely to want to know.
 *
 * Both are advisory. Neither is allowed to fail the request that triggered it: the account
 * is already committed to the database by the time either is sent, so a provider fault at this
 * point is a missing nicety, not a failed registration, and reporting one as the other would
 * tell a user their account was not created when it was.
 */

/**
 * The site root, or null when there is nowhere public to point a link.
 *
 * A localhost base URL is legitimate for a provider callback during local development and
 * useless for a link a recipient has to click, so the button is dropped rather than sent
 * pointing at the sender's own machine. The message is still worth sending without it: the
 * address in it, and the fact that the account exists, are the point.
 */
function siteUrl() {
    const base = resolvePublicBaseUrl();
    if (!base.ok || !base.baseUrl) return null;
    if (!isPubliclyReachable(base.baseUrl)) return null;
    return String(base.baseUrl).replace(/\/+$/, '');
}

function offersUrl() {
    const root = siteUrl();
    return root ? `${root}/offers` : null;
}

/** Sends the welcome that follows a successful registration. */
async function sendWelcomeEmail({ to }) {
    if (!isEmailConfigured()) {
        console.error('Welcome email was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const offers = offersUrl();
    const blocks = [
        { type: 'list', items: [
            'Pick an offer from the catalog and we track it against your account.',
            'Deposit by card or crypto whenever you want to add funds.',
            'Withdraw to a card, a wallet, or PayPal once you have a balance.'
        ] },
        { type: 'callout', tone: 'neutral', text:
            'One more step: enter the 6-digit code we just emailed you to finish setting up your account.'
        }
    ];

    return sendEmail({
        to,
        subject: 'Welcome to RewardZone',
        text: renderEmailText({
            intro: 'Thanks for creating a RewardZone account. Your account is ready as soon as you confirm your email address.',
            blocks,
            action: offers ? { label: 'Browse offers', url: offers } : null,
            footnote: 'If you did not create this account, ignore this email. Nothing happens until the address is confirmed.'
        }),
        html: renderEmail({
            preheader: 'Your account is almost ready - confirm your email to start earning.',
            heading: 'Welcome to RewardZone',
            intro: 'Thanks for creating an account. You are one short code away from being able to complete offers and track your rewards.',
            blocks,
            action: offers ? { label: 'Browse offers', url: offers, note: 'You can do this now or after confirming your email.' } : null,
            footnote: 'If you did not create this account, you can ignore this message. Nothing happens until the address is confirmed.'
        })
    });
}

/** Sends the thank-you that follows a successful verification. */
async function sendAccountVerifiedEmail({ to }) {
    if (!isEmailConfigured()) {
        console.error('Verification thank-you was not sent (email is not configured).');
        return { sent: false, reason: 'email-not-configured' };
    }

    const offers = offersUrl();
    const blocks = [
        { type: 'callout', tone: 'success', text: 'Your email address is confirmed and your account is fully active.' },
        { type: 'list', items: [
            'Complete an offer and the reward is credited once the partner confirms it.',
            'Add funds by card or crypto from the Deposit button.',
            'Withdraw your balance whenever you want, starting from $1.00.'
        ] }
    ];

    return sendEmail({
        to,
        // The subject carries the thanks, not just the heading. The subject is the only part
        // of a message most people read, and a list showing "Your RewardZone account is
        // confirmed" reads like a notification from a system rather than from the product.
        subject: 'Thank you for confirming your RewardZone account',
        text: renderEmailText({
            intro: 'Thank you for confirming your email. Your RewardZone account is now active and ready to use.',
            blocks,
            action: offers ? { label: 'Start earning', url: offers } : null,
            footnote: 'If the confirmation code is still in your inbox you can delete this thread - it has already been used.'
        }),
        html: renderEmail({
            preheader: 'Your account is confirmed. Thanks for verifying.',
            heading: 'Thank you for confirming',
            intro: 'Your email address is verified and your account is active. Everything is unlocked.',
            blocks,
            action: offers ? { label: 'Start earning', url: offers } : null,
            footnote: 'You can delete the confirmation email now - the code has been used and cannot be used again.'
        })
    });
}

module.exports = { sendWelcomeEmail, sendAccountVerifiedEmail };
