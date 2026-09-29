/**
 * Port the app listens on when PORT is not set. `server.js` and the development
 * fallback below both read this so a locally built callback URL always matches the
 * port actually in use (a mismatch made every local deposit callback fail).
 *
 * A `PORT` of `0` asks the OS for any free port; it is rejected here because
 * nothing can build a callback URL against a port it does not know.
 */
const portFromEnv = Number(process.env.PORT);
const defaultPort = Number.isInteger(portFromEnv) && portFromEnv > 0
    ? portFromEnv
    : 3001;
const defaultDevelopmentBaseUrl = `http://localhost:${defaultPort}`;

/**
 * Whether a hostname refers to this machine or the local network.
 *
 * Covers:
 *   - loopback: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`
 *   - RFC 1918 IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 *   - CGNAT: `100.64.0.0/10`
 *   - link-local: `169.254.0.0/16`, `fe80::/10`
 *   - IPv6 unique-local: `fc00::/7`
 *   - mDNS / container suffixes: `*.local`, `*.internal`
 *
 * The check is by string, not by DNS resolution: a name that happens to resolve
 * to a private address is still reachable if it is public DNS, and a private
 * address that happens to have a public reverse is still private. Hostnames are
 * compared literally because that is what ends up in the callback URL.
 */
function isLocalAddress(hostname) {
    const host = String(hostname || '').toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

    // IPv4 literal, possibly with a port already stripped by URL parsing.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        const [a, b] = host.split('.').map(Number);
        if (a === 127) return true;                     // 127.0.0.0/8
        if (a === 10) return true;                      // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;        // 192.168.0.0/16
        if (a === 169 && b === 254) return true;        // 169.254.0.0/16
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
        return false;
    }

    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10), matched by prefix.
    if (/^f[cd][\da-f]{2}:/i.test(host)) return true;
    if (/^fe[89ab][\da-f]:/i.test(host)) return true;

    // Docker, WSL, and mDNS names are resolvable only on their own network.
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;

    return false;
}

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
    const rawEnv = (process.env.APP_BASE_URL || '').trim() ||
        (isProduction ? '' : defaultDevelopmentBaseUrl);
    if (!rawEnv) {
        return { ok: false, error: 'Public site URL is not configured. Set APP_BASE_URL.' };
    }

    // Support a comma-separated list of origins (e.g. for local testing on both
    // localhost and a LAN address: `APP_BASE_URL=http://localhost:3001,http://192.168.1.10:3001`).
    // The first well-formed origin is returned as `baseUrl` for callback URLs; the
    // full list is returned as `baseUrls` for CORS and other multi-origin checks.
    const rawUrls = rawEnv.split(',').map((s) => s.trim()).filter(Boolean);
    if (rawUrls.length === 0) {
        return { ok: false, error: 'Public site URL is not configured. Set APP_BASE_URL.' };
    }

    const parsedUrls = [];
    for (const raw of rawUrls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            return { ok: false, error: `Configure APP_BASE_URL as a valid public origin. (${raw} was not parseable)` };
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            return { ok: false, error: `Configure APP_BASE_URL as a valid public origin. (${raw} was invalid)` };
        }
        parsedUrls.push(parsed);
    }

    if (isProduction) {
        // Every origin in a production list must be HTTPS and publicly reachable.
        for (const parsed of parsedUrls) {
            if (parsed.protocol !== 'https:' || isLocalAddress(parsed.hostname)) {
                return {
                    ok: false,
                    error: 'APP_BASE_URL must be the public HTTPS origin in production, otherwise provider webhooks cannot reach the app.'
                };
            }
        }
    }

    return { ok: true, baseUrl: parsedUrls[0], baseUrls: parsedUrls };
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
    return !isLocalAddress(parsed.hostname);
}

module.exports = { resolvePublicBaseUrl, isPubliclyReachable, isLocalAddress, defaultPort };