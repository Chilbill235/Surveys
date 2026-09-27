/**
 * Port the app listens on when PORT is not set. `server.js` and the development
 * fallback below both read this so a locally built callback URL always matches the
 * port actually in use (a mismatch made every local deposit callback fail).
 */
const defaultPort = Number(process.env.PORT) || 3000;
const defaultDevelopmentBaseUrl = `http://localhost:${defaultPort}`;

/**
 * Resolves the public origin the app is reachable at.
 *
 * Provider webhooks (Stripe redirects, the NOWPayments IPN) and password reset
 * links are all built from this value. If it points at localhost in production the
 * provider can never reach the app: the deposit stays pending forever and the user
 * is never credited. So an unusable value is rejected here instead of silently
 * producing a dead callback or an unopenable reset link.
 */
function resolvePublicBaseUrl() {
    const isProduction = process.env.NODE_ENV === 'production';
    const rawBaseUrl = (process.env.APP_BASE_URL || '').trim() ||
        (isProduction ? '' : defaultDevelopmentBaseUrl);
    if (!rawBaseUrl) {
        return { ok: false, error: 'Public site URL is not configured. Set APP_BASE_URL.' };
    }

    let parsed;
    try {
        parsed = new URL(rawBaseUrl);
    } catch {
        return { ok: false, error: 'Configure APP_BASE_URL as a valid public origin.' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return { ok: false, error: 'Configure APP_BASE_URL as a valid public origin.' };
    }

    if (isProduction) {
        const hostname = parsed.hostname.toLowerCase();
        const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
            hostname.endsWith('.localhost');
        if (parsed.protocol !== 'https:' || isLoopback) {
            return {
                ok: false,
                error: 'APP_BASE_URL must be the public HTTPS origin in production, otherwise provider webhooks cannot reach the app.'
            };
        }
    }

    return { ok: true, baseUrl: parsed };
}

/**
 * Whether a provider on the public internet could actually reach this origin.
 *
 * This is deliberately separate from `ok`. A localhost APP_BASE_URL is *valid* in
 * development -- it is the only thing that works before a tunnel exists -- but it is
 * unreachable from the provider, so every `ipn_callback_url` built from it is a dead
 * address. The symptom is indistinguishable from a provider that is not sending: the
 * deposit is created, the address is shown, the customer pays, and the callback never
 * lands, so the balance never moves. Production already refuses this outright; everywhere
 * else it is surfaced as a warning and reported to the client.
 */
function isPubliclyReachable(baseUrl) {
    let parsed;
    try {
        parsed = baseUrl instanceof URL ? baseUrl : new URL(String(baseUrl));
    } catch {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
        hostname.endsWith('.localhost') || /^127\./.test(hostname);
    if (isLoopback) return false;
    // A bare container or LAN hostname is not resolvable from the internet either. These
    // are the names Docker and WSL hand out, and they are the other shape of this bug.
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    return true;
}

module.exports = { resolvePublicBaseUrl, isPubliclyReachable, defaultPort };

