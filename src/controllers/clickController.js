const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { resolvePublicBaseUrl } = require('../services/publicBaseUrl');

function buildPublicUrl(pathname) {
    // One shared resolver for every public URL: a single stale localhost value here
    // used to produce click redirects that pointed at a port nothing was listening on.
    const resolved = resolvePublicBaseUrl();
    if (!resolved.ok) return null;

    try {
        const publicUrl = new URL(pathname, resolved.baseUrl);
        if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
            return null;
        }
        return publicUrl;
    } catch {
        return null;
    }
}

function buildEngageUrl(clickId) {
    const engageUrl = buildPublicUrl('/offer/engage');
    if (!engageUrl) return null;
    engageUrl.searchParams.set('aff_sub', clickId);
    return engageUrl.toString();
}

async function createTrackedClick(req, res, redirectImmediately) {
    const offerId = req.params.offerId;
    const userId = req.user?.id ?? null;
    const ipAddress = req.ip || req.socket.remoteAddress || null;

    if (!offerId || offerId.length > 128) {
        return res.status(400).send('Invalid offer ID.');
    }

    try {
        const offerResult = await pool.query(
            'SELECT tracking_url FROM offers WHERE id = $1',
            [offerId]
        );

        if (offerResult.rows.length === 0) {
            return res.status(404).send('Offer not found.');
        }

        let advertiserUrl;
        try {
            advertiserUrl = new URL(offerResult.rows[0].tracking_url);
        } catch {
            console.error(`Offer ${offerId} has an invalid tracking URL.`);
            return res.status(502).send('Offer tracking is temporarily unavailable.');
        }

        if (!['http:', 'https:'].includes(advertiserUrl.protocol) ||
            (advertiserUrl.hostname === req.hostname && advertiserUrl.pathname === '/offer/engage')) {
            return res.status(502).send('Offer tracking URL must use HTTP or HTTPS.');
        }

        const clickId = uuidv4();
        const engageUrl = buildEngageUrl(clickId);
        if (!engageUrl) {
            return res.status(503).send('The public tracking URL is not configured.');
        }

        await pool.query(
            `INSERT INTO clicks (click_id, user_id, offer_id, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
            [clickId, userId, offerId, ipAddress, req.get('user-agent') || null]
        );

        if (redirectImmediately) {
            return res.redirect(302, engageUrl);
        }
        return res.json({ redirectUrl: engageUrl });
    } catch (error) {
        console.error('Tracking Error:', error.message);
        return res.status(500).send('Tracking error occurred.');
    }
}

async function engageClick(req, res) {
    const clickId = String(req.query.aff_sub || '').trim();
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(clickId)) {
        return res.status(400).send('A valid aff_sub click ID is required.');
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
            if (process.env.NODE_ENV === 'production') {
                return res.status(404).send('Demo offer not found.');
            }
            const demoUrl = buildPublicUrl('/demo');
            if (!demoUrl) return res.status(503).send('The public tracking URL is not configured.');
            demoUrl.searchParams.set('click_id', clickId);
            demoUrl.searchParams.set('type', offer.offer_type);
            return res.redirect(302, demoUrl.toString());
        }

        let advertiserUrl;
        try {
            advertiserUrl = new URL(offer.tracking_url);
        } catch {
            return res.status(502).send('Offer tracking is temporarily unavailable.');
        }
        if (!['http:', 'https:'].includes(advertiserUrl.protocol) ||
            (advertiserUrl.hostname === req.hostname && advertiserUrl.pathname === '/offer/engage')) {
            return res.status(502).send('Offer tracking URL must use HTTP or HTTPS.');
        }

        const clickParameter = process.env.TRACKING_CLICK_PARAM || 'aff_sub';
        advertiserUrl.searchParams.set(clickParameter, clickId);
        return res.redirect(302, advertiserUrl.toString());
    } catch (error) {
        console.error('Engage Tracking Error:', error.message);
        return res.status(500).send('Tracking error occurred.');
    }
}

const clickController = {
    trackClick: (req, res) => createTrackedClick(req, res, true),
    createClick: (req, res) => createTrackedClick(req, res, false),
    engageClick
};

module.exports = clickController;