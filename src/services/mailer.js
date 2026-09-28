const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Transactional email delivery, independent of which provider carries it.
 *
 * This exists because each provider call used to be written inline next to the message that
 * needed sending, so the two flows (verification codes and password resets) had separate HTTP
 * calls, separate configuration checks, and separate failure handling. Changing provider then
 * meant editing both, which is how a provider that stopped working left half the app sending
 * mail one way and the other half another.
 *
 * One function, one configuration check, one error shape. Which provider answers is a
 * configuration value, not a code change.
 *
 * Default is Brevo, because it needs no domain: a Brevo account can send from its own
 * registered sender address straight away, whereas Resend refuses to send to any recipient
 * other than the account owner until a custom domain is verified with DNS. Resend is still
 * supported for a deployment that has done that verification.
 */

/** The provider name, from configuration, or inferred from whichever key is present. */
function emailProvider() {
    const requested = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
    if (requested === 'brevo' || requested === 'resend') return requested;
    // Inferred only as a convenience, and Brevo wins the tie because it is the one that works
    // without a domain. An explicit `EMAIL_PROVIDER` always overrides this.
    if (process.env.BREVO_API_KEY) return 'brevo';
    if (process.env.RESEND_API_KEY) return 'resend';
    return null;
}

/** The registered sender address. Brevo rejects a `from` it has not verified. */
function senderAddress() {
    return String(process.env.EMAIL_FROM || '').trim();
}

function senderName() {
    return String(process.env.EMAIL_FROM_NAME || 'RewardZone').trim();
}

/**
 * Whether a message can actually be sent.
 *
 * Read by the registration path before an account is created: an address that can never be
 * confirmed is worse than a refused registration, because the user is told to check an inbox
 * that will never receive anything.
 */
function isEmailConfigured() {
    if (!senderAddress()) return false;
    const provider = emailProvider();
    if (provider === 'brevo') return Boolean(process.env.BREVO_API_KEY);
    if (provider === 'resend') return Boolean(process.env.RESEND_API_KEY);
    return false;
}

/** A short, non-secret description of the setup, for start-up logs and diagnostics. */
function emailConfiguration() {
    const provider = emailProvider();
    return {
        provider,
        configured: isEmailConfigured(),
        sender: senderAddress() || null,
        senderName: senderName(),
        // Never the key itself. Enough to tell "set" from "set but wrong".
        apiKeyPresent: provider === 'brevo'
            ? Boolean(process.env.BREVO_API_KEY)
            : Boolean(process.env.RESEND_API_KEY)
    };
}

/**
 * Sends one transactional message.
 *
 * Resolves to `{ sent: true }` or `{ sent: false, reason }` and never throws: a provider
 * outage must not take down the request that triggered a verification code, because the
 * account or the reset has already been recorded and the caller can only act on the outcome.
 *
 * The provider's own error body is kept in the reason. It names the real problem -- an
 * unverified sender, a rejected address, an exhausted daily quota -- and without it the
 * operator is left with a bare status code and no way to tell a configuration fault from a
 * bad recipient.
 */
async function sendEmail({ to, subject, text, html }) {
    const provider = emailProvider();
    if (!provider) return { sent: false, reason: 'no email provider is configured' };
    if (!isEmailConfigured()) {
        return { sent: false, reason: `${provider} is selected but its API key or EMAIL_FROM is missing` };
    }

    const from = senderAddress();
    const name = senderName();

    try {
        const response = await fetch(provider === 'brevo' ? BREVO_ENDPOINT : RESEND_ENDPOINT, {
            method: 'POST',
            headers: provider === 'brevo'
                ? { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' }
                : {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
            body: JSON.stringify(provider === 'brevo'
                ? {
                    // Brevo requires a `sender` object and names the bodies differently from
                    // every other provider. This is the only place that shape is known.
                    sender: { name, email: from },
                    to: [{ email: to }],
                    subject,
                    htmlContent: html,
                    textContent: text
                }
                : {
                    from: `${name} <${from}>`,
                    to: [to],
                    subject,
                    text,
                    html
                }),
            // Without this the request can outlive the serverless invocation that started it,
            // and the caller is left waiting on a send that may already have happened.
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            return {
                sent: false,
                reason: `${provider} returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
            };
        }
        return { sent: true };
    } catch (error) {
        return { sent: false, reason: error.message };
    }
}

module.exports = {
    sendEmail,
    isEmailConfigured,
    emailProvider,
    emailConfiguration,
    senderAddress
};
