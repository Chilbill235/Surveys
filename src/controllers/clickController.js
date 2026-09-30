const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');
const { isDemoModeEnabled } = require('../services/demoMode');
const { normaliseAddress } = require('../middlewares/fraudDetection');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGAGE_PATH = '/offer/engage';
const DEMO_PATH = '/demo';
/** Where a click that cannot be completed here is sent, so the user is not stranded. */
const ENGAGE_CATALOG_PATH = '/offers';

/**
 * The query parameter that carries the click id on *our* engage URL. It is
 * distinct from TRACKING_CLICK_PARAM, which is the parameter we append to the
 * *advertiser's* URL. Sharing one name for both used to be the default and it
 * worked only because they happened to match; keeping them as separate
 * constants makes the two roles explicit and prevents drift.
 */
const INTERNAL_CLICK_PARAM = 'aff_sub';
const DEFAULT_ADVERTISER_CLICK_PARAM = 'aff_sub';

const UUID_RE = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const MAX_OFFER_ID_LENGTH = 128;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a path against the configured public base URL and returns a URL
 * object, or null when the environment is misconfigured. One shared resolver
 * for every public URL: a single stale localhost value here used to produce
 * click redirects that pointed at a port nothing was listening on.
 */
function buildPublicUrl(pathname) {
    const resolved = resolvePublicBaseUrl();
    if (!resolved.ok) return null;
    try {
        const publicUrl = new URL(pathname, resolved.baseUrl);
        if (!HTTP_PROTOCOLS.has(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
            return null;
        }
        return publicUrl;
    } catch {
        return null;
    }
}

/** Builds the internal engage URL that a freshly tracked click redirects to. */
function buildEngageUrl(clickId) {
    const engageUrl = buildPublicUrl(ENGAGE_PATH);
    if (!engageUrl) return null;
    engageUrl.searchParams.set(INTERNAL_CLICK_PARAM, clickId);
    return engageUrl.toString();
}

/**
 * Parses a URL and rejects anything that is not a plain HTTP(S) URL.
 *
 * Credentials in the URL are refused because they would end up in the Location
 * header and in every server log along the redirect chain. The original code
 * accepted them via `new URL()`, which is a small information-disclosure hole
 * on a value the admin controls.
 */
function safeParseHttpUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const url = new URL(value);
        if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
        if (url.username || url.password) return null;
        return url;
    } catch {
        return null;
    }
}

/** Normalises a pathname for comparison: strip trailing slashes, keep the root. */
function normalisePath(pathname) {
    const trimmed = pathname.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
}

/**
 * The hostnames that resolve back to this service.
 *
 * Both the host the request arrived on and the configured public base URL host
 * are included, because an offer can be misconfigured to point at either alias.
 * The original check compared only against `req.hostname`, so a loop through
 * the canonical public host was invisible when the user arrived via an alias.
 */
function selfReferenceHosts(req) {
    const hosts = new Set();
    if (req.hostname) hosts.add(String(req.hostname).toLowerCase());
    const resolved = resolvePublicBaseUrl();
    if (resolved.ok) hosts.add(resolved.baseUrl.hostname.toLowerCase());
    return hosts;
}

/** True when `advertiserUrl` points back at this service's engage endpoint. */
function isEngageSelfReference(advertiserUrl, req) {
    if (normalisePath(advertiserUrl.pathname) !== ENGAGE_PATH) return false;
    return selfReferenceHosts(req).has(advertiserUrl.hostname.toLowerCase());
}

/**
 * Validates an offer's tracking URL as a redirect target. Returns null when it
 * is usable, or a short message describing the problem.
 */
function advertiserUrlProblem(url, req) {
    if (!HTTP_PROTOCOLS.has(url.protocol)) {
        return 'Offer tracking URL must use HTTP or HTTPS.';
    }
    if (isEngageSelfReference(url, req)) {
        // A loop here would bounce the user back into this endpoint, which
        // would redirect again -- an infinite redirect the browser aborts.
        return 'Offer tracking URL points back at this service.';
    }
    return null;
}

/**
 * Sets a redirect with `Cache-Control: no-store`.
 *
 * Tracking redirects are per-click and must never be reused by a proxy or a
 * browser's back/forward cache: a cached engage redirect would credit the
 * wrong click, and a cached track redirect would hand one user another user's
 * click id.
 */
function redirectNoStore(res, status, location) {
    res.set('Cache-Control', 'no-store');
    return res.redirect(status, location);
}

/**
 * Sends an error in the shape the caller can parse.
 *
 * The same handler serves a browser navigation (`GET /click/:offerId`, which is
 * a redirect and never sees a body) and a JSON API call (`POST /api/click/:offerId`,
 * which parses JSON). The success path already respects that split -- JSON for
 * POST, redirect for GET -- but every error path used `res.send`, so a fetch
 * caller received `"Invalid offer ID."` and failed on `.json()` rather than
 * reading the reason. This makes the failure shape match the success shape.
 *
 * `isApi` is passed by the caller rather than read from `req.method`, because
 * the redirect decision and the response-shape decision are the same decision
 * and should not be able to drift.
 */
function sendError(res, isApi, status, message) {
    if (isApi) return res.status(status).json({ error: message });
    return res.status(status).send(message);
}

// ---------------------------------------------------------------------------
// Click tracking
// ---------------------------------------------------------------------------

/**
 * Loads and validates an offer's tracking URL.
 *
 * `is_demo` comes back with it because a demo offer is only clickable where the demo flow
 * is actually available. Recording a click for a demo offer in a deployment that cannot
 * complete it produces a row that can never resolve: the engage hop 404s, the reward never
 * posts back, and the click sits in the table looking like a real tracked click. Refusing
 * to record it is what stops that row existing.
 *
 * `is_active` is part of the same question. The catalog only ever lists active offers, so a
 * deactivated one has been withdrawn from sale -- and an id is a small integer a caller can
 * guess. Without this the offer disappears from the wall while remaining fully clickable and
 * creditable, which is the opposite of what deactivating it is for.
 */
async function loadOfferTrackingUrl(offerId) {
    const result = await pool.query(
        'SELECT tracking_url, is_demo FROM offers WHERE id = $1 AND is_active IS TRUE',
        [offerId]
    );
    if (result.rows.length === 0) return { status: 'not_found' };
    const isDemo = result.rows[0].is_demo === true;
    if (isDemo && !isDemoModeEnabled()) {
        return { status: 'demo_unavailable' };
    }
    const url = safeParseHttpUrl(result.rows[0].tracking_url);
    if (!url) return { status: 'invalid' };
    return { status: 'ok', url };
}

async function createTrackedClick(req, res, redirectImmediately) {
    // `redirectImmediately` and the response shape are the same decision, so the
    // flag is reused rather than read from `req.method` twice.
    const isApi = !redirectImmediately;

    const offerId = req.params.offerId;
    if (!offerId || offerId.length > MAX_OFFER_ID_LENGTH) {
        return sendError(res, isApi, 400, 'Invalid offer ID.');
    }

    try {
        const offer = await loadOfferTrackingUrl(offerId);
        if (offer.status === 'not_found') {
            return sendError(res, isApi, 404, 'Offer not found.');
        }
        if (offer.status === 'demo_unavailable') {
            // 404, because from this deployment's point of view the offer does not exist.
            // The message says *why*, though: a bare "not found" for an offer the user can
            // see in front of them is indistinguishable from a bug, and this one was
            // reported as a broken survey rather than as a disabled test offer.
            console.warn(`Refused a click on demo offer ${offerId}: demo mode is off in this deployment.`);
            return sendError(
                res,
                isApi,
                404,
                'That offer is a test offer and is not available in this environment.'
            );
        }
        if (offer.status === 'invalid') {
            console.error(`Offer ${offerId} has an invalid tracking URL.`);
            return sendError(res, isApi, 502, 'Offer tracking is temporarily unavailable.');
        }

        // The engage handler is what actually redirects to the advertiser, but a
        // click that can never be engaged is not worth recording: validate the
        // target here so the row and the eventual redirect cannot disagree.
        const problem = advertiserUrlProblem(offer.url, req);
        if (problem) {
            console.error(`Offer ${offerId} rejected: ${problem}`);
            return sendError(res, isApi, 502, problem);
        }

        const clickId = uuidv4();
        const engageUrl = buildEngageUrl(clickId);
        if (!engageUrl) {
            console.error('Cannot build the engage URL: the public base URL is not configured.');
            return sendError(res, isApi, 503, 'The public tracking URL is not configured.');
        }

        const userId = req.user?.id ?? null;
        // Normalised before it is stored, because the fraud middleware counts recent clicks
        // by the normalised form. The same client can reach a dual-stack host as
        // `::ffff:1.2.3.4` on one connection and `1.2.3.4` on the next, so an un-normalised
        // row was invisible to the velocity count that refused the eleventh click -- the limit
        // was real for the count and not for the record.
        const ipAddress = normaliseAddress(req.ip || req.socket?.remoteAddress);
        const userAgent = req.get('user-agent') || null;

        await pool.query(
            `INSERT INTO clicks (click_id, user_id, offer_id, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
            [clickId, userId, offerId, ipAddress, userAgent]
        );

        if (redirectImmediately) {
            return redirectNoStore(res, 302, engageUrl);
        }
        return res.json({ redirectUrl: engageUrl });
    } catch (error) {
        // `offers.id` is an integer, so a non-numeric offer id in the URL is a malformed id
        // rather than a missing row, and PostgreSQL says so by raising `22P02` on the
        // comparison. Answering 404 is the same answer a wrong id gets, and keeps a
        // mistyped URL from reading as a server fault.
        if (error && error.code === '22P02') {
            return sendError(res, isApi, 404, 'Offer not found.');
        }
        // The offer id is in the log line, not only in the message the user
        // sees. A bare `Tracking Error: <message>` used to be the only record
        // of the failure, and it named neither the offer nor the click.
        console.error(`Tracking Error for offer ${offerId}:`, error.message);
        return sendError(res, isApi, 500, 'Tracking error occurred.');
    }
}

async function engageClick(req, res) {
    // Reject a repeated parameter rather than coercing the array to a string:
    // `String(['a','b'])` is `'a,b'`, which would pass the length check below
    // and then simply miss the lookup, giving a misleading 404.
    const rawClickId = req.query[INTERNAL_CLICK_PARAM];
    const clickId = Array.isArray(rawClickId) ? '' : String(rawClickId || '').trim();
    if (!UUID_RE.test(clickId)) {
        return res.status(400).send(`A valid ${INTERNAL_CLICK_PARAM} click ID is required.`);
    }

    try {
        const clickResult = await pool.query(
            `SELECT offers.tracking_url, offers.is_demo, offers.offer_type
             FROM clicks
             JOIN offers ON offers.id = clicks.offer_id
             WHERE clicks.click_id = $1`,
            [clickId]
        );
        if (clickResult.rows.length === 0) {
            return res.status(404).send('Tracked click not found.');
        }

        const offer = clickResult.rows[0];

        if (offer.is_demo) {
            if (!isDemoModeEnabled()) {
                // The click exists because it was recorded when demo mode was on -- in
                // local development, or on a deployment that has since turned it off, and
                // the row is in a database both share. The old response was a bare
                // "Demo offer not found.", which reads as a broken link and tells the
                // user nothing they can act on.
                //
                // It also 302s back to the catalog rather than dead-ending on a 404 page,
                // so the user lands somewhere they can keep working.
                console.warn(
                    `Click ${clickId} is for a demo offer, but demo mode is off in this ` +
                    'deployment, so it cannot be completed here. Returning to the catalog.'
                );

                // The query parameter is set through `URL.searchParams` rather than by
                // concatenating `?notice=...` onto the URL string. The concatenated form
                // only produced a correct URL because `buildPublicUrl` currently returns
                // a URL with no query string; if that ever changed -- `ENGAGE_CATALOG_PATH`
                // gaining a parameter, or the resolver adding a `ref` -- the result would
                // be `...?ref=x?notice=...`, which the browser would parse as a single
                // `ref` value and silently drop the notice.
                const catalogUrl = buildPublicUrl(ENGAGE_CATALOG_PATH);
                if (catalogUrl) {
                    catalogUrl.searchParams.set('notice', 'demo-unavailable');
                    return redirectNoStore(res, 302, catalogUrl.toString());
                }
                // The relative fallback keeps the notice. Returning a bare `/offers` here
                // would land the user on the catalog with no explanation, which is the
                // dead end this branch exists to avoid -- and it would do so exactly when
                // the deployment is misconfigured enough that `buildPublicUrl` fails.
                return redirectNoStore(
                    res,
                    302,
                    `${ENGAGE_CATALOG_PATH}?notice=demo-unavailable`
                );
            }
            const demoUrl = buildPublicUrl(DEMO_PATH);
            if (!demoUrl) {
                console.error('Cannot build the demo URL: the public base URL is not configured.');
                return res.status(503).send('The public tracking URL is not configured.');
            }
            demoUrl.searchParams.set('click_id', clickId);
            // Guarded so a null offer_type cannot serialise to the string
            // "null" in the demo page's query string.
            if (offer.offer_type) demoUrl.searchParams.set('type', offer.offer_type);
            return redirectNoStore(res, 302, demoUrl.toString());
        }

        const advertiserUrl = safeParseHttpUrl(offer.tracking_url);
        if (!advertiserUrl) {
            console.error(`Offer for click ${clickId} has an invalid tracking URL.`);
            return res.status(502).send('Offer tracking is temporarily unavailable.');
        }
        const problem = advertiserUrlProblem(advertiserUrl, req);
        if (problem) {
            console.error(`Offer for click ${clickId} rejected: ${problem}`);
            return res.status(502).send(problem);
        }

        const clickParameter = process.env.TRACKING_CLICK_PARAM || DEFAULT_ADVERTISER_CLICK_PARAM;
        advertiserUrl.searchParams.set(clickParameter, clickId);
        return redirectNoStore(res, 302, advertiserUrl.toString());
    } catch (error) {
        // The click id is in the log line for the same reason it is in the
        // others: a bare message did not identify which click failed.
        console.error(`Engage Tracking Error for click ${clickId}:`, error.message);
        return res.status(500).send('Tracking error occurred.');
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const clickController = {
    trackClick: (req, res) => createTrackedClick(req, res, true),
    createClick: (req, res) => createTrackedClick(req, res, false),
    engageClick,
};

module.exports = clickController;
// Exposed for tests that want to assert the engage URL shape without going
// through the whole tracking flow.
module.exports.buildEngageUrl = buildEngageUrl;