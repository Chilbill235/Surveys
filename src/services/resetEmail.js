const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { isPubliclyReachable } = require('./publicBaseUrl');

/**
 * Password reset delivery.
 *
 * Delivery is delegated to the shared mailer, so the provider is a configuration value rather
 * than something written into this file. HTTPS works inside a serverless function where an
 * outbound SMTP connection is not viable.
 *
 * When no provider is configured the link is logged instead of emailed: local development can
 * still complete the flow, and the operator sees a plain warning rather than a silent failure.
 *
 * When a provider *is* configured but the link would point somewhere unreachable, the message
 * is not sent at all. The link is the whole content of this email, so a delivered message
 * whose link does nothing is worse than no message -- see the guard below.
 *
 * The link itself is built by the caller using `resolvePublicBaseUrl` from
 * `services/publicBaseUrl`. That validation is deliberately not repeated here: an earlier
 * copy of it lived in this file and was weaker, because it skipped the embedded-credential
 * and LAN-origin checks. Two copies of the same rule drift, and the weaker one is the one
 * that gets used. What this file does add is a warning when a *valid* base URL still points
 * somewhere unreachable -- the validation passes, the email is sent, and the link is dead.
 */
async function sendPasswordResetEmail({ to, resetUrl }) {
    if (!isEmailConfigured()) {
        console.error(`Password reset link (email is not configured, link only): ${resetUrl}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    // Refuse to send a link that cannot be opened.
    //
    // The previous version sent it and logged a warning. That is the worst of both: the
    // message is delivered, the provider reports success, the sender is told the reset link
    // is on its way, and the only symptom is that the link does nothing when opened on a
    // phone -- which is indistinguishable from the email never arriving, and is not what
    // anyone would go looking for.
    //
    // The reset link is the entire content of this message. There is no code to type, no
    // fallback, and no second copy: a message without a working link is not a degraded
    // reset, it is not a reset.
    //
    // Not sending is the honest outcome. The user gets the same acknowledgement an unknown
    // address would get -- which the endpoint has to give anyway so it does not confirm who
    // has an account -- and the operator gets a log line naming the actual problem.
    if (!isPubliclyReachable(resetUrl)) {
        // The *origin* is logged, never the full URL. `resetUrl` carries a live single-use
        // token, and writing it to a log puts a working credential in whatever ships logs
        // off the host, where it is readable by anyone with log access and outlives the
        // token's own expiry in any archive.
        let origin = '(unparseable)';
        try {
            origin = new URL(resetUrl).origin;
        } catch { /* the guard below reports it; nothing more to do here */ }
        console.error(
            `Password reset was not sent: it would link to ${origin}, which is not reachable from the ` +
            'public internet. Anyone opening the link on a phone or another device would get nothing, and ' +
            'the message would look delivered. Set APP_BASE_URL to the public HTTPS origin of this deployment.'
        );
        return { sent: false, reason: 'no-public-url' };
    }

    const blocks = [
        { type: 'callout', tone: 'neutral', text: 'This link expires in 60 minutes and can only be used once.' },
        // The URL in full, styled as a link. It used to be the `footnote` argument, which
        // renders as muted body text with no underline -- indistinguishable from the sentence
        // above it, and stripped to a bare `revu-gamma.vercel.app/...` in clients that drop
        // the scheme from a link they do not recognise. It is the only copy of this URL that
        // survives a client which discards the button, so it cannot be a footnote.
        { type: 'link', label: 'If the button does not work, open this link:', url: resetUrl },
        { type: 'paragraph', text: 'If you did not request this, ignore this email and your password stays unchanged. If someone else has your password, reset it here and then change it again.' }
    ];

    const shared = {
        heading: 'Reset your password',
        intro: 'Someone asked to reset the password for your RewardZone account. Choose a new one to carry on.',
        blocks
    };

    return sendEmail({
        to,
        subject: 'Reset your RewardZone password',
        text: renderEmailText({
            ...shared,
            action: { label: 'Choose a new password', url: resetUrl, note: 'Expires in 60 minutes. Single use.' }
        }),
        html: renderEmail({
            preheader: 'A password reset was requested for your RewardZone account.',
            ...shared,
            action: { label: 'Choose a new password', url: resetUrl, note: 'Single use. Expires in 60 minutes.' }
        })
    });
}

module.exports = { sendPasswordResetEmail };
