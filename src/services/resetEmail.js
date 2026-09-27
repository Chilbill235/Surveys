/**
 * Password reset delivery.
 *
 * Delivery uses Resend over HTTPS, which works inside a serverless function where an
 * outbound SMTP connection is not viable. When no provider is configured the link is
 * logged instead of emailed: local development can still complete the flow, and the
 * operator sees a plain warning rather than a silent failure.
 */

/**
 * Resolves the public origin used for reset links.
 *
 * A reset link built from localhost is useless to the recipient, so an unusable value
 * is reported here rather than silently producing a dead link.
 */
function resolveResetBaseUrl() {
    const rawBaseUrl = (process.env.APP_BASE_URL || '').trim() ||
        (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
    if (!rawBaseUrl) {
        return { ok: false, error: 'APP_BASE_URL is required so reset links point at the public site.' };
    }

    try {
        const parsed = new URL(rawBaseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { ok: false, error: 'APP_BASE_URL must be an absolute http(s) URL.' };
        }
        return { ok: true, baseUrl: parsed };
    } catch {
        return { ok: false, error: 'APP_BASE_URL must be a valid absolute URL.' };
    }
}

async function sendPasswordResetEmail({ to, resetUrl }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
        console.error(`Password reset link (email is not configured, link only): ${resetUrl}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from,
                to: [to],
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
            }),
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            return { sent: false, reason: `email provider returned ${response.status}` };
        }
        return { sent: true };
    } catch (error) {
        return { sent: false, reason: error.message };
    }
}

module.exports = { resolveResetBaseUrl, sendPasswordResetEmail };
