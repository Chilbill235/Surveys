const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');
const { resolvePublicBaseUrl, isPubliclyReachable } = require('./publicBaseUrl');

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

/**
 * Sends a magic link sign-in email.
 *
 * The link carries the magic token in the URL fragment (not the query string),
 * so it is never sent in a request line and never lands in access logs or
 * referrer headers. The frontend reads it from the fragment, exchanges it for a
 * session at the API, and immediately removes it from the address bar.
 */
async function sendMagicLinkEmail({ to, token }) {
    if (!isEmailConfigured()) {
        console.error(`Magic link token (email is not configured, link only): /magic-link/${token}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    const magicUrl = buildMagicLinkUrl(token);

    const blocks = [
        { type: 'callout', tone: 'neutral', text:
            'This link expires in 15 minutes and can only be used once. ' +
            'If you did not request this link, you can safely ignore this email.'
        }
    ];

    return sendEmail({
        to,
        subject: 'Sign in to RewardZone',
        text: renderEmailText({
            intro: 'Click or copy the link below to sign in to your RewardZone account. No password or code is needed.',
            blocks,
            action: magicUrl ? { label: 'Sign in to RewardZone', url: magicUrl, note: 'This link opens your browser and signs you in automatically.' } : null,
            footnote: 'If you did not request this link, you can ignore this email. Nothing happens until you use it.'
        }),
        html: renderEmail({
            preheader: 'Click to sign in to RewardZone without a password.',
            heading: 'Sign in to RewardZone',
            intro: 'Click the button below to sign in to your account. No password or code is needed -- the link signs you in automatically.',
            blocks,
            action: magicUrl ? { label: 'Sign in to RewardZone', url: magicUrl } : null,
            footnote: 'This link is single-use and expires in 15 minutes. If you did not request it, you can ignore this email safely.'
        })
    });
}

function buildMagicLinkUrl(token) {
    const root = siteUrl();
    if (!root) return null;
    const url = new URL('/offers', root);
    url.hash = `magic=${token}`;
    return url.toString();
}

module.exports = { sendMagicLinkEmail };
