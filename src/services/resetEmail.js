const { sendEmail, isEmailConfigured } = require('./mailer');

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

    return sendEmail({
        to,
        subject: 'Reset your RewardZone password',
        text: [
            'Someone asked to reset the password for this RewardZone account.',
            '',
            `Open this link to choose a new password: ${resetUrl}`,
            '',
            'The link expires in 60 minutes and can only be used once.',
            'If you did not request this, you can ignore this email and your password stays unchanged.'
        ].join('\n'),
        html: [
            '<p>Someone asked to reset the password for this RewardZone account.</p>',
            `<p><a href="${resetUrl}">Choose a new password</a></p>`,
            '<p>The link expires in 60 minutes and can only be used once.</p>',
            '<p>If you did not request this, you can ignore this email and your password stays unchanged.</p>'
        ].join('')
    });
}

module.exports = { sendPasswordResetEmail };
