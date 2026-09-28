const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');

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
 * The link itself is built by the caller using `resolvePublicBaseUrl` from
 * `services/publicBaseUrl`. That validation is deliberately not repeated here: an earlier
 * copy of it lived in this file and was weaker, because it skipped the embedded-credential
 * and LAN-origin checks. Two copies of the same rule drift, and the weaker one is the one
 * that gets used.
 */
async function sendPasswordResetEmail({ to, resetUrl }) {
    if (!isEmailConfigured()) {
        console.error(`Password reset link (email is not configured, link only): ${resetUrl}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    const blocks = [
        { type: 'callout', tone: 'neutral', text: 'This link expires in 60 minutes and can only be used once.' },
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
            action: { label: 'Choose a new password', url: resetUrl, note: 'If the button does not work, paste this link into your browser:' },
            footnote: resetUrl
        })
    });
}

module.exports = { sendPasswordResetEmail };
