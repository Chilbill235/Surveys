const express = require('express');
const router = express.Router();
const clickController = require('../controllers/clickController');
const demoController = require('../controllers/demoController');
const postbackController = require('../controllers/postbackController');
const fraudDetection = require('../middlewares/fraudDetection');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');
const { isDemoModeEnabled, describeDemoMode } = require('../services/demoMode');
const { register: registerMethod } = require('./methodRegistry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long the public catalog may be cached.
 *
 * 30 seconds at the edge, 60 seconds of stale-while-revalidate so a
 * revalidation that lands during a cold start still serves the previous catalog
 * instead of a spinner. Set here rather than relying on `vercel.json` alone so
 * a self-hosted deploy without a CDN gets the same behaviour from the browser
 * cache, and so the caching policy lives next to the response it describes.
 *
 * If `vercel.json` still carries a `Cache-Control` for this path, remove it:
 * the runtime header supersedes the config on Vercel, and two sources for the
 * same value is how a future change to one leaves the other silently wrong.
 */
const OFFERS_CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=60';

/**
 * Postgres / network error codes that mean "the database is not reachable", as
 * opposed to "the query was wrong". Used so the catalog returns 503 during an
 * outage rather than 500, matching every other handler in the app.
 */
const DB_UNREACHABLE_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

/**
 * Whether demo offers appear in the public catalog.
 *
 * Thin alias kept so the catalog's dependency is named where it is used. The decision
 * itself lives in `src/services/demoMode.js` and is shared with the `/demo` page, the
 * completion endpoint, and the click handler, because a catalog that advertises a demo
 * offer the deployment cannot complete is worse than an empty catalog.
 */
function resolveIncludeDemo() {
    return isDemoModeEnabled();
}

// ---------------------------------------------------------------------------
// Public offer catalog
// ---------------------------------------------------------------------------

/**
 * The offer catalog, which is the only thing the landing page needs to render.
 *
 * `tracking_url` is deliberately absent. Sending it would let anyone append
 * their own aff_sub to the advertiser directly and collect credit for clicks
 * that were never recorded, which is the entire thing the tracking hop exists
 * to prevent.
 *
 * The catalog is filtered and sorted in the browser, so the columns it sorts
 * and filters on are read on every load. `payout` had no index, and every
 * query that lists the catalog also orders by it when the user asks for
 * highest-first.
 *
 * The cache header is set before the query so a slow query still produces a
 * cacheable response, and cleared on the error path so a proxy or a browser
 * never caches a transient failure for 30 seconds.
 */
async function handleListOffers(req, res) {
    res.set('Cache-Control', OFFERS_CACHE_CONTROL);

    try {
        const includeDemo = resolveIncludeDemo();
        const result = await pool.query(
            `SELECT id, title, description, payout, network_name, partner_label,
                    is_demo, offer_type, pays_real_money, estimated_minutes,
                    completion_url
             FROM offers
             WHERE is_active IS TRUE
               AND ($1::boolean OR is_demo IS FALSE)
             ORDER BY created_at DESC, id DESC`,
            [includeDemo]
        );

        // The count is logged on the way out so an empty catalog is never
        // silently mistaken for a working one. A 200 with `[]` and a 200 with
        // 40 rows are the same shape to a client and a very different shape to
        // an operator reading logs, and the distinction is exactly what was
        // missing while this was producing empty pages. The mode is described
        // rather than just reported because the useful question is always
        // "was that deliberate here", and the answer differs by deployment.
        if (result.rows.length === 0) {
            const mode = describeDemoMode();
            console.warn(
                `Offer catalog is empty. Demo mode is ${mode.enabled ? 'on' : 'off'} ` +
                `(from ${mode.source}, NODE_ENV=${mode.environment}). Check that the offers ` +
                'table has active rows in this database, and that OFFERS_INCLUDE_DEMO is ' +
                'set correctly for the environment.'
            );
        }

        return res.json(result.rows);
    } catch (error) {
        // The message is resolved through the pool's helper because a connection
        // failure reports an empty `AggregateError.message`; logging
        // `error.message` directly printed a bare "Offers Error:" and hid the
        // reason the catalog was down.
        console.error('Offers Error:', pool.describeError(error));

        // A failure must not be cached: a 30 second window on the error path
        // would keep serving a 503 after the database came back.
        res.set('Cache-Control', 'no-store');

        if (DB_UNREACHABLE_CODES.has(error?.code)) {
            return res.status(503).json({ error: 'This service is temporarily unavailable.' });
        }
        return res.status(500).json({ error: 'Failed to load offers' });
    }
}

router.get('/api/offers', handleListOffers);

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

router.get('/offer/engage', clickController.engageClick);
router.get('/click/:offerId', requireAuth, fraudDetection, clickController.trackClick);
router.post('/api/click/:offerId', requireAuth, fraudDetection, clickController.createClick);
router.post('/api/demo/complete', requireAuth, demoController.complete);
router.get('/api/demo/survey', requireAuth, demoController.survey);
registerMethod(/^\/api\/demo\/complete\/?$/, ['POST']);
registerMethod(/^\/api\/demo\/survey\/?$/, ['GET']);
// The three public routes that were missing from this list. The registry exists so a known
// path reached with the wrong verb answers 405 with the correct `Allow` header instead of a
// flat 404 -- a distinction that is the whole point of the design, and one that quietly did
// not apply to these. `GET /api/contact` reported "API route not found" for a contact form
// that exists, which reads as the feature being absent rather than as a method mistake.
registerMethod(/^\/api\/offers\/?$/, ['GET']);
registerMethod(/^\/api\/contact\/?$/, ['POST']);
// `\d{1,19}` rather than `[^/]+`: the id is numeric everywhere else, and bounding the length
// keeps a hostile path segment from being reflected into a log line unexamined.
registerMethod(/^\/api\/click\/\d{1,19}\/?$/, ['GET', 'POST']);

// ---------------------------------------------------------------------------
// Server-to-server postbacks from advertiser networks
// ---------------------------------------------------------------------------

router.route('/api/postback')
    .get(postbackController.handleS2S)
    .post(postbackController.handleS2S);

// ---------------------------------------------------------------------------
// Provider webhooks
// ---------------------------------------------------------------------------

/**
 * The NOWPayments IPN endpoint is registered once, in `src/app.js`, immediately before the
 * global body middleware so its raw body parser can run first.
 *
 * A second copy used to sit here as well. It was unreachable -- the route in `app.js`
 * matches first, for every method -- and its 405 body carried a different shape from the one
 * that actually answers, so the two had already begun to disagree about what a caller is
 * told. A duplicate that cannot be reached is worse than no duplicate: it looks like the live
 * definition and is not one.
 */

// ---------------------------------------------------------------------------
// Contact form
// ---------------------------------------------------------------------------

/**
 * Validates that a string is non-empty after trimming.
 */
function validateRequired(data, fields) {
    const errors = [];
    for (const field of fields) {
        if (!data[field] || String(data[field]).trim().length === 0) {
            errors.push(`Missing required field: ${field}`);
        }
    }
    return errors;
}

/** Rate-limit key for the contact endpoint. */
function contactRateLimitKey(req) {
    return req.ip || 'unknown';
}

/**
 * Submissions seen per address, per window.
 *
 * A Map rather than an object so a key is a key, and so the sweep below can
 * delete entries without walking a prototype chain.
 */
const contactRateLimits = new Map();

/**
 * Simple in-memory rate limiter: max 3 submissions per IP per 10 minutes.
 *
 * The window is swept on the way in, so the map holds the addresses seen in the
 * last ten minutes rather than every address the process has ever served.
 * Without that, nothing ever released an entry and the map grew for the life
 * of the instance.
 */
function contactRateLimit(req, res, next) {
    const key = contactRateLimitKey(req);
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    for (const [address, bucket] of contactRateLimits) {
        if (now - bucket.first > windowMs) contactRateLimits.delete(address);
    }

    const bucket = contactRateLimits.get(key);
    if (!bucket) {
        contactRateLimits.set(key, { first: now, count: 1 });
        return next();
    }

    bucket.count += 1;
    if (bucket.count > 3) {
        // Written through the `res` this middleware was given. Reaching for
        // `req.res` instead made the refusal depend on a property Express does
        // not set, so the branch answered `null` and returned without calling
        // `next()` -- a request that hangs instead of one that is limited.
        return res.status(429).json({ error: 'Too many contact requests. Please try again later.' });
    }
    return next();
}

router.post('/api/contact', contactRateLimit, async (req, res) => {
    const errors = validateRequired(req.body, ['name', 'email', 'subject', 'message']);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors[0] });
    }

    // Coerced to strings before the length checks, because a JSON body can carry a
    // number or an object for any of these fields. `(123).length > 5000` is
    // `undefined > 5000`, which is false, so a non-string field skipped the limit
    // entirely and reached the mailer as whatever it happened to be.
    const name = String(req.body.name).trim();
    const email = String(req.body.email).trim();
    const subject = String(req.body.subject).trim();
    const message = String(req.body.message).trim();

    // Every field is bounded, not only the three that were. An unbounded address
    // is as much a way to make somebody else's mail server do the work as an
    // unbounded message is.
    if (message.length > 5000 || subject.length > 200 || name.length > 200 || email.length > 254) {
        return res.status(400).json({ error: 'Field length exceeds limit.' });
    }

    const { sendEmail, isEmailConfigured } = require('../services/mailer');
    const { renderEmail, renderEmailText } = require('../services/emailLayout');

    if (!isEmailConfigured()) {
        console.warn('Contact form submission ignored: email is not configured.');
        return res.status(503).json({ error: 'The contact form is not yet available on this deployment.' });
    }

    // The reply-to, so "reply to this message" in the footer reaches the person who wrote
    // it. Without it a reply lands on the site's own address and the support inbox answers
    // its own customer.
    const recipient = process.env.CONTACT_EMAIL || process.env.EMAIL_FROM;

    try {
        // A `details` block rather than three paragraphs of "Name: ... From: ...", because
        // the message is the one place the owner's own copy carries the sender's details, and
        // a two-column table makes the reply-to address something they can read without
        // parsing a sentence.
        const senderFacts = {
            items: [
                { label: 'From', value: name },
                { label: 'Reply to', value: email },
                { label: 'Subject', value: subject },
            ],
        };
        const shared = {
            blocks: [
                senderFacts,
                { type: 'paragraph', text: message },
            ],
            footerNote: 'Sent from the RewardZone contact form. Replying goes straight to the address above.',
        };

        await sendEmail({
            to: recipient,
            // The subject is prefixed so a contact lands in its own filter alongside the
            // transactional mail, and the sender's subject follows rather than being
            // replaced -- `[Contact]` alone means every message looks identical in a list.
            subject: `[Contact] ${subject}`,
            html: renderEmail({
                ...shared,
                heading: `New message from ${name}`,
                preheader: `Support message from ${name}: ${subject}`,
                // The action a support inbox most needs, and the one a "Reply to" footer
                // cannot deliver by itself in a client that routes replies to the sender
                // address rather than the reply-to header.
                action: { label: 'Reply to this message', url: `mailto:${email}` },
            }),
            text: renderEmailText({
                ...shared,
                action: { label: 'Reply to this message', url: `mailto:${email}` },
            }),
            replyTo: email,
        });

        res.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error('Contact form error:', error.message);
        res.status(500).json({ error: 'Failed to send message. Please try again later.' });
    }
});

module.exports = router;