const { resolvePublicBaseUrl, isPubliclyReachable } = require('./publicBaseUrl');

/**
 * Shared branded HTML for every message the app sends.
 *
 * The messages used to be a handful of bare `<p>` tags, so they arrived looking like a
 * different product than the one the user had just signed up for, and the six-digit code --
 * the only thing standing between an address and an account -- was set in body text that a
 * phone would wrap mid-number.
 *
 * Everything here is deliberately constrained to what email actually renders:
 *
 *   - Layout is tables, not flex or grid. Outlook's renderer has no flexbox at all, so a
 *     flex layout does not degrade, it collapses to a stack in a different order.
 *   - Every visual style is inline. A `<style>` block is kept only for the two things that
 *     cannot be inlined -- the media query and the dark-mode override -- because clients strip
 *     the rest of it inconsistently.
 *   - Widths are in pixels with a percentage fallback on the outer table, so the message is
 *     600px on a desktop client and full-bleed on a 360px phone.
 *   - A `text` alternative is always produced alongside the HTML. Some corporate gateways and
 *     every plain-text client read only that, and a verification code that exists only in an
 *     image is a code nobody can use.
 *
 * Colours are the same tokens as `public/style.css`, so the email and the site read as one
 * product. They are duplicated as literal values rather than imported because there is no
 * build step: the stylesheet is served to a browser and this runs on a serverless function.
 */

const BRAND = {
    heading: '#131c4a',
    accent: '#2449d8',
    accentDark: '#1b39ac',
    paper: '#f5f2ea',
    surface: '#fffdf8',
    ink: '#171a2b',
    inkSoft: '#3d4457',
    muted: '#54586b',
    line: '#ddd8cb',
    success: '#1f6b45',
    successBg: '#e2f2e6',
    warning: '#8a5d20',
    warningBg: '#fdf1dc',
    danger: '#a52f28',
    dangerBg: '#fbe6e2'
};

/** Escapes text for interpolation into HTML. Used on every caller-supplied string. */
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escapes a URL for an attribute, and refuses anything that is not http(s). */
function safeUrl(value) {
    const raw = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return null;
    return escapeHtml(raw);
}

/**
 * The absolute URL of the animated brand mark, or null when there is nowhere to point it.
 *
 * Served by the app itself rather than attached to the message. Inline attachment
 * (`Content-ID`) would travel inside the MIME part and survive a client that rewrites or
 * strips remote images, but neither Brevo nor Resend documents a `contentId` on their
 * attachment objects, and a `cid:` reference to an attachment the provider silently dropped
 * renders as a broken-image placeholder -- which looks worse than a remote image that a
 * client chose not to load, because at least the latter still shows its alt text.
 *
 * So it is a normal image with a public URL, plus alt text, which is the combination that
 * degrades most quietly everywhere.
 *
 * Publicly reachable is required, not just well-formed. `resolvePublicBaseUrl` deliberately
 * falls back to localhost in development because that is the only thing that works before a
 * tunnel exists -- a useful accommodation for a provider callback the developer can watch
 * arrive, and a useless one for a link a recipient has to click. A localhost image in an
 * email is broken for everyone except the person who sent it, so it is left out instead.
 */
function brandGifUrl() {
    const base = resolvePublicBaseUrl();
    if (!base.ok || !base.baseUrl) return null;
    if (!isPubliclyReachable(base.baseUrl)) return null;
    return `${String(base.baseUrl).replace(/\/+$/, '')}/brand.gif`;
}

/**
 * Renders a full message.
 *
 * `blocks` is an ordered list of sections rather than an HTML string, so a caller cannot
 * accidentally emit unbalanced markup and each section is styled in one place. Supported
 * section types are `code` (the verification code), `details` (a two-column fact list),
 * `callout` (a coloured note), and `list` (bullets).
 */
function renderEmail({
    brand = 'RewardZone',
    preheader = '',
    heading,
    intro = '',
    blocks = [],
    action = null,
    footnote = '',
    footerNote = ''
} = {}) {
    const gifUrl = brandGifUrl();

    const preheaderText = String(preheader || intro || '').replace(/\s+/g, ' ').trim();
    const rows = [];

    // ---------------------------------------------------------------- header
    rows.push(`<tr><td style="padding:0 0 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
                <td align="left" valign="middle" style="font-family:${stack()};font-size:18px;font-weight:700;color:${BRAND.heading};letter-spacing:-0.2px">
                    ${escapeHtml(brand)}
                </td>
                <td align="right" valign="middle">
                    ${
                        gifUrl
                            ? `<img src="${escapeHtml(gifUrl)}" width="56" height="56" alt="${escapeHtml(brand)}" style="display:block;width:56px;height:56px;border:0;border-radius:14px;outline:none;text-decoration:none" />`
                            : ''
                    }
                </td>
            </tr>
        </table>
    </td></tr>`);

    // ---------------------------------------------------------------- heading
    rows.push(`<tr><td style="padding:0 0 8px 0">
        <h1 style="margin:0;font-family:${displayStack()};font-size:27px;line-height:34px;font-weight:700;color:${BRAND.heading};letter-spacing:-0.4px">
            ${escapeHtml(heading || '')}
        </h1>
    </td></tr>`);

    if (intro) {
        rows.push(`<tr><td style="padding:0 0 20px 0">
            <p style="margin:0;font-family:${stack()};font-size:16px;line-height:25px;color:${BRAND.inkSoft}">
                ${escapeHtml(intro)}
            </p>
        </td></tr>`);
    }

    // ---------------------------------------------------------------- blocks
    for (const block of blocks) {
        rows.push(renderBlock(block));
    }

    // ---------------------------------------------------------------- action
    if (action && action.label && action.url) {
        const href = safeUrl(action.url);
        if (href) {
            // A table cell with a background, not a styled <a>. Outlook ignores most CSS on
            // anchors and renders the label as bare text, which is why the old "button" was
            // a link that looked like a sentence.
            rows.push(`<tr><td style="padding:24px 0 8px 0" align="center">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                    <tr>
                        <td align="center" bgcolor="${BRAND.accent}" style="border-radius:12px">
                            <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${stack()};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${escapeHtml(action.label)}</a>
                        </td>
                    </tr>
                </table>
            </td></tr>`);

            if (action.note) {
                rows.push(`<tr><td style="padding:10px 0 0 0" align="center">
                    <p style="margin:0;font-family:${stack()};font-size:13px;line-height:20px;color:${BRAND.muted}">
                        ${escapeHtml(action.note)}
                    </p>
                </td></tr>`);
            }
        }
    }

    if (footnote) {
        rows.push(`<tr><td style="padding:20px 0 0 0">
            <p style="margin:0;font-family:${stack()};font-size:14px;line-height:22px;color:${BRAND.muted}">
                ${escapeHtml(footnote)}
            </p>
        </td></tr>`);
    }

    // ---------------------------------------------------------------- footer
    rows.push(`<tr><td style="padding:28px 0 0 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="border-top:1px solid ${BRAND.line};font-family:${stack()};font-size:12px;line-height:19px;color:${BRAND.muted};padding-top:16px">
                <p style="margin:0 0 6px 0">You are receiving this because an account was created on ${escapeHtml(brand)}.</p>
                ${
                    footerNote
                        ? `<p style="margin:0 0 6px 0">${escapeHtml(footerNote)}</p>`
                        : ''
                }
                <p style="margin:0">${escapeHtml(brand)} &middot; Need help? Reply to this message.</p>
            </td></tr>
        </table>
    </td></tr>`);

    return [
        '<!doctype html>',
        '<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
        '<head>',
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width,initial-scale=1" />',
        // Tells clients the message supports both schemes, which is what makes Outlook.com and
        // Apple Mail apply their own dark inversion rather than showing light-on-white.
        '<meta name="color-scheme" content="light dark" />',
        '<meta name="supported-color-schemes" content="light dark" />',
        '<title>' + escapeHtml(heading || brand) + '</title>',
        // The only style block in the message. Everything structural is inline; this exists
        // solely for the narrow-screen padding and for the dark-mode override, neither of
        // which can be expressed inline.
        '<style>',
        '  @media only screen and (max-width:620px){',
        '    .wrap{width:100%!important;border-radius:0!important}',
        '    .pad{padding-left:20px!important;padding-right:20px!important}',
        '    .code{font-size:30px!important;letter-spacing:8px!important}',
        '    h1{font-size:23px!important;line-height:30px!important}',
        '  }',
        '  @media (prefers-color-scheme:dark){',
        '    .surface{background:#161a2e!important;border-color:#2a3050!important}',
        '    .ink{color:#eef1fb!important}',
        '    .ink-soft{color:#c2c8dd!important}',
        '    .muted{color:#9aa1b8!important}',
        '    .rule{border-color:#2a3050!important}',
        '    .code-cell{background:#0f1428!important;border-color:#3a4267!important}',
        '    .code-text{color:#c2c8dd!important}',
        '  }',
        '</style>',
        '</head>',
        // A light background on the body, so a dark-mode client that ignores the inline paper
        // colour does not flash a white page around a dark card.
        `<body style="margin:0;padding:0;background:${BRAND.paper};-webkit-text-size-adjust:100%">`,
        // The preheader: the first thing an inbox shows in the list view, and the only way to
        // control that text. It is hidden, and padded, so the client does not pull body copy
        // in after it.
        `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(
            preheaderText
        )}${'&nbsp;'.repeat(60)}</div>`,
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.paper + '">',
        '<tr><td align="center" style="padding:28px 12px">',
        // The card. 600px is the width every major client lays out cleanly, and the percentage
        // fallback is what keeps it from overflowing a 360px phone.
        `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:20px">`,
        '<tr><td class="pad" style="padding:30px 32px 30px 32px">',
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
        rows.filter(Boolean).join('\n'),
        '</table>',
        '</td></tr>',
        '</table>',
        '</td></tr></table>',
        '</body></html>'
    ].join('');
}

function renderBlock(block) {
    if (!block || typeof block !== 'object') return '';

    if (block.type === 'code') {
        // The code gets its own cell with a monospace face, wide letter spacing, and a copyable
        // value in the text alternative. Spacing matters here: a 6-digit code in proportional
        // type is easy to misread, and a misread code burns one of five attempts.
        return `<tr><td style="padding:4px 0 20px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td class="code-cell" align="center" bgcolor="${BRAND.paper}" style="background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:14px;padding:20px 12px">
                        <p class="code code-text" style="margin:0;font-family:ui-monospace,'Cascadia Mono',Consolas,'Courier New',monospace;font-size:34px;line-height:42px;font-weight:700;letter-spacing:12px;text-indent:12px;color:${BRAND.heading}">${escapeHtml(block.value)}</p>
                    </td>
                </tr>
            </table>
        </td></tr>`;
    }

    if (block.type === 'details') {
        const entries = Array.isArray(block.items) ? block.items : [];
        if (entries.length === 0) return '';
        const rows = entries.map((item) => {
            // Alternating tint, so a two-column list stays scannable on a narrow screen where
            // the label and value sit close together.
            const tint = 'background:#faf8f2';
            return [
                `<tr>`,
                `<td class="rule ink-soft" width="42%" style="padding:10px 0;font-family:${stack()};font-size:14px;line-height:20px;color:${BRAND.inkSoft};border-bottom:1px solid ${BRAND.line}">${escapeHtml(item.label)}</td>`,
                `<td class="rule ink" align="right" style="padding:10px 0;font-family:${stack()};font-size:14px;line-height:20px;font-weight:600;color:${BRAND.ink};border-bottom:1px solid ${BRAND.line}">${escapeHtml(item.value)}</td>`,
                `</tr>`
            ].join('');
        });
        return `<tr><td style="padding:0 0 20px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>
        </td></tr>`;
    }

    if (block.type === 'callout') {
        const tone = block.tone === 'danger' ? BRAND.danger : block.tone === 'success' ? BRAND.success : BRAND.warning;
        const background = block.tone === 'danger' ? BRAND.dangerBg : block.tone === 'success' ? BRAND.successBg : BRAND.warningBg;
        return `<tr><td style="padding:0 0 20px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${background};border-radius:12px">
                <tr><td style="padding:14px 16px;font-family:${stack()};font-size:14px;line-height:21px;color:${tone};border-left:3px solid ${tone}">${escapeHtml(block.text)}</td></tr>
            </table>
        </td></tr>`;
    }

    if (block.type === 'list') {
        const items = Array.isArray(block.items) ? block.items : [];
        if (items.length === 0) return '';
        const listItems = items
            .map(
                (item) =>
                    `<li style="margin:0 0 8px 0;font-family:${stack()};font-size:15px;line-height:23px;color:${BRAND.inkSoft}">${escapeHtml(item)}</li>`
            )
            .join('');
        return `<tr><td style="padding:0 0 20px 0">
            <ul style="margin:0;padding:0 0 0 2px;list-style-position:outside">${listItems}</ul>
        </td></tr>`;
    }

    if (block.type === 'paragraph') {
        return `<tr><td style="padding:0 0 16px 0">
            <p class="ink-soft" style="margin:0;font-family:${stack()};font-size:15px;line-height:24px;color:${BRAND.inkSoft}">${escapeHtml(block.text)}</p>
        </td></tr>`;
    }

    return '';
}

/**
 * The plain-text rendering of the same content.
 *
 * Built from the same inputs as the HTML rather than written separately, so the two cannot
 * drift. A message whose text version is missing a code, or still says "click here", is worse
 * than one with no HTML at all.
 */
function renderEmailText({ intro = '', blocks = [], action = null, footnote = '' } = {}) {
    const lines = [];
    if (intro) lines.push(intro, '');

    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'code') {
            lines.push(`Your code: ${block.value}`, '');
        } else if (block.type === 'details') {
            for (const item of block.items || []) lines.push(`${item.label}: ${item.value}`);
            if ((block.items || []).length) lines.push('');
        } else if (block.type === 'callout') {
            lines.push(block.text, '');
        } else if (block.type === 'list') {
            for (const item of block.items || []) lines.push(`- ${item}`);
            if ((block.items || []).length) lines.push('');
        } else if (block.type === 'paragraph') {
            lines.push(block.text, '');
        }
    }

    if (action && action.label && action.url) {
        lines.push(`${action.label}: ${action.url}`);
        if (action.note) lines.push(action.note);
        lines.push('');
    }

    if (footnote) lines.push(footnote);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stack() {
    return "'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif";
}

function displayStack() {
    return "Georgia,'Iowan Old Style','Times New Roman',serif";
}

module.exports = {
    renderEmail,
    renderEmailText,
    escapeHtml,
    safeUrl,
    brandGifUrl,
    BRAND
};
