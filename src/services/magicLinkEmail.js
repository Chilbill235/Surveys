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
    const magicUrl = buildMagicLinkUrl(token);

    if (!isEmailConfigured()) {
        // The real link, not an invented path: a developer following this line to finish a
        // local flow should land on the page that reads the fragment, and a path that 404s
        // costs more time than the log saves.
        console.error(`Magic link token (email is not configured, link only): ${magicUrl || `#magic=${token}`}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    // Refuse to send rather than send a message with no link in it.
    //
    // `buildMagicLinkUrl` returns null when the configured origin is not reachable from the
    // public internet -- a localhost `APP_BASE_URL`, which is the default in development and
    // a misconfiguration that survives into a deploy whenever `NODE_ENV` is not literally
    // "production". Every earlier version of this function treated that as "send the email
    // without the action block", because `magicUrl ? {...} : null` reads as a tidy way to
    // express an optional button.
    //
    // The result is the worst possible failure for this message: the provider reports a
    // successful send, the caller logs nothing wrong, the endpoint answers the user with
    // "a magic link is on its way", and the message that arrives has a heading and an intro
    // and no way to sign in. There is no fallback -- a magic link *is* the credential -- so
    // the user is left waiting for a link that was never in the email, and every part of the
    // system reports success.
    //
    // Not sending is the honest outcome. The user sees the same "on its way" they would see
    // for an address with no account, which is the response the endpoint has to give anyway
    // to avoid confirming which addresses are registered, and the operator gets a log line
    // naming the actual problem.
    if (!magicUrl) {
        console.error(
            'Magic link was not sent: no public site URL is configured, so the link cannot be built. ' +
            'Set APP_BASE_URL to the public HTTPS origin (for example https://your-app.vercel.app). ' +
            'Sending the email without a link would deliver a sign-in message with nothing to click.'
        );
        // In development the link is printed instead, because there is a person at the
        // keyboard who can complete the flow with it. `APP_BASE_URL` defaults to localhost,
        // so this is the ordinary local case and not an exotic one -- without this, local
        // testing of magic link sign-in is impossible and the only way to find out why is
        // the line above. The token is not printed in production, where nobody is watching
        // the console and it would be a live credential sitting in a log.
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Magic link token (development only): ${magicUrlForLog(token)}`);
        }
        return { sent: false, reason: 'no-public-url' };
    }

    // The link, twice over: once as the button, once written out in full.
    //
    // A single-use sign-in link is the one link in this product with no fallback, and the
    // button is the part most likely to be lost -- it is an image-and-border table cell, and
    // gateways that strip images or block tracking take it with them. The written-out URL is
    // what makes the message work when that happens, so it is a `link` block rather than the
    // footnote it used to be, where it rendered as muted prose with no underline and lost its
    // scheme in clients that rewrite unrecognised links.
    const blocks = [
        { type: 'callout', tone: 'neutral', text:
            'This link expires in 15 minutes and can only be used once. ' +
            'If you did not request this link, you can safely ignore this email.'
        },
        { type: 'link', label: 'If the button does not work, open this link:', url: magicUrl },
        { type: 'paragraph', text: 'Nothing happens until you use the link. If you did not request it, you can ignore this email.' }
    ];

    return sendEmail({
        to,
        subject: 'Sign in to RewardZone',
        text: renderEmailText({
            intro: 'Click or copy the link below to sign in to your RewardZone account. No password or code is needed.',
            blocks,
            action: { label: 'Sign in to RewardZone', url: magicUrl, note: 'This link opens your browser and signs you in automatically.' }
        }),
        html: renderEmail({
            preheader: 'Click to sign in to RewardZone without a password.',
            heading: 'Sign in to RewardZone',
            intro: 'Click the button below to sign in to your account. No password or code is needed -- the link signs you in automatically.',
            blocks,
            action: { label: 'Sign in to RewardZone', url: magicUrl, note: 'Single use. Expires in 15 minutes.' }
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

/**
 * A link a developer can follow locally, for the console when no public origin exists.
 *
 * Built from the first configured origin even when that one is a LAN or loopback address,
 * because the whole point is to be clickable from the machine that printed it. It is
 * never emailed and never used in production -- see the caller.
 */
function magicUrlForLog(token) {
    const base = resolvePublicBaseUrl();
    if (!base.ok || !base.baseUrl) return `/offers#magic=${token}`;
    return `${String(base.baseUrl).replace(/\/+$/, '')}/offers#magic=${token}`;
}

module.exports = { sendMagicLinkEmail, buildMagicLinkUrlForTest: buildMagicLinkUrl };
