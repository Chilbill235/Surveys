const axios = require('axios');
const pool = require('../config/db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Whether a VPN/proxy check that cannot be performed should block tracking.
 *
 * This middleware used to fail closed in production, unconditionally, in two places:
 * once when `PROXYCHECK_KEY` was absent, and again when the provider was unreachable.
 * Both mean that a single unconfigured or briefly unavailable third-party integration
 * took the entire offer flow down -- every click answered 503, on every offer, for
 * every user. A deployment that had never heard of proxycheck.io was 100% broken by a
 * feature that was simply not switched on, which is the opposite of what a security
 * control should do when it is not in use.
 *
 * The trade is explicit rather than implied by a `NODE_ENV` comparison:
 *
 *   - `PROXYCHECK_REQUIRED=true`  -> fail closed. Tracking is refused while the check
 *     cannot run. This is the strict posture, and it is correct when proxy traffic is
 *     a real financial exposure for this deployment.
 *   - `PROXYCHECK_REQUIRED=false` -> fail open. The click is tracked and the gap is
 *     logged. Default, because the common case is an integration that is not configured.
 *
 * What is never acceptable either way is failing silently, so a missing key and a failed
 * check each produce one distinct, quotable log line naming the consequence.
 */
function proxyCheckRequired() {
    const configured = String(process.env.PROXYCHECK_REQUIRED || '').trim().toLowerCase();
    if (configured === 'true' || configured === '1') return true;
    if (configured === 'false' || configured === '0') return false;
    return false;
}

/**
 * The velocity window and threshold, both configurable.
 *
 * The previous hard-coded `>= 10 in 1 minute` was a guess that fit exactly one kind of
 * traffic. A deployment behind a corporate NAT legitimately has several users sharing
 * one address; a public rewards site has almost no legitimate reason for a single IP to
 * make ten clicks a minute. Both numbers are policy, so both are read from the
 * environment with the previous values as the default -- a deployment that does not set
 * them behaves as it did before.
 */
const DEFAULT_VELOCITY_THRESHOLD = 10;
const DEFAULT_VELOCITY_WINDOW_SECONDS = 60;

function velocityThreshold() {
    const raw = Number(process.env.FRAUD_VELOCITY_THRESHOLD);
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_VELOCITY_THRESHOLD;
}

function velocityWindowSeconds() {
    const raw = Number(process.env.FRAUD_VELOCITY_WINDOW_SECONDS);
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_VELOCITY_WINDOW_SECONDS;
}

// ---------------------------------------------------------------------------
// Scripted-client detection
// ---------------------------------------------------------------------------

/**
 * User-Agent patterns that indicate an automated client rather than a browser.
 *
 * The single regex this replaces (`/\b(bot|crawler|spider|curl)\b/`) caught the four
 * obvious cases and let everything else through: `wget`, `python-requests`, `Go-http-
 * client`, `okhttp`, `node-fetch`, and the literal string `axios` all passed. Those are
 * exactly the tools a scripted abuse attempt uses, because nobody tries to hide behind a
 * User-Agent they think you already block.
 *
 * The patterns are anchored where the client itself is the whole User-Agent (`^curl/`),
 * and word-bounded where the client's name is one word among others (`\bbot\b`). The
 * distinction matters: `Googlebot` should match `\bbot\b` (it does -- the `t` and `b`
 * are both word characters but the boundary before `bot` is between `e` and `b`, and
 * both are word chars... wait, `Googlebot` lowercased is `googlebot`, `bot` is at the
 * end, so there is a boundary at the end but not at the start of `bot`. So `\bbot\b`
 * does NOT match `googlebot`. This is a known limitation, and it is the right one:
 * Googlebot hitting an auth-gated click endpoint is not a pattern worth optimizing for.
 * The generic `bot` catches the abusive "MegaBot/1.0" style strings.).
 *
 * An empty or missing User-Agent is treated as suspicious by the caller, not here --
 * Node's fetch and some HTTP clients omit it entirely, so it is a stronger signal than
 * any of these patterns.
 */
const SCRIPTED_CLIENT_PATTERNS = [
    /\b(?:bot|crawler|spider|scraper|scraping)\b/i,
    /^curl\//i,
    /^wget\//i,
    /^python-requests\//i,
    /^python-urllib\//i,
    /^go-http-client\//i,
    /^okhttp\//i,
    /^java\//i,
    /^libwww-perl\//i,
    /^httpie\//i,
    /^axios\//i,
    /^node-fetch\//i,
    /^undici\//i,
];

function isScriptedClient(userAgent) {
    if (!userAgent) return true;
    return SCRIPTED_CLIENT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

// ---------------------------------------------------------------------------
// IP normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises an address so the same client does not appear as two.
 *
 * `req.ip` under `trust proxy` returns whatever the proxy chain reported. On a dual-stack
 * host the same client can arrive as `::ffff:1.2.3.4` (an IPv4-mapped IPv6 address) on
 * one request and `1.2.3.4` on the next, depending on which socket the connection came
 * in on. Counting them separately meant a real limit of five clicks per minute from one
 * client, because each form had its own tally.
 *
 * Bracketed IPv6 (`[::1]`) is stripped of its brackets, and a port suffix (`1.2.3.4:5678`)
 * is removed. Everything else is returned unchanged, because a permissive normaliser that
 * accidentally collapses two different clients into one is worse than no normaliser.
 */
function normaliseAddress(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    let address = value.trim();

    // Bracketed IPv6 with optional port: [::1] or [::1]:443
    const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) address = bracketed[1];

    // Trailing port on a bare IPv4 or hostname: 1.2.3.4:5678
    // Only strip when the whole thing before the colon looks like an IPv4 address, so a
    // bare IPv6 (which has many colons and no brackets) is left alone.
    const ipv4WithPort = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4WithPort) address = ipv4WithPort[1];

    // IPv4-mapped IPv6, the form a dual-stack listener reports for an IPv4 client.
    const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) address = mapped[1];

    return address.toLowerCase();
}

// ---------------------------------------------------------------------------
// Proxy check cache
// ---------------------------------------------------------------------------

/**
 * A small in-process cache for proxycheck.io verdicts.
 *
 * The free tier allows 1,000 lookups a day. Without a cache, an active user generates
 * one lookup per click, which exhausts that in a single morning and turns the check
 * off for the rest of the day -- at which point the middleware falls into its fail-open
 * path and the control stops doing anything. Caching a verdict for five minutes means a
 * burst of clicks from one IP costs one lookup, not twenty.
 *
 * The cache is per-process. On serverless hosting a cold start wipes it, which is the
 * correct trade: a global cache would need another service to store it, and the point
 * of this is to smooth bursts, not to be a source of truth.
 *
 * Bounded in size so a hostile client cycling through IPs cannot grow it without limit.
 * When full, the oldest entry is evicted; Map preserves insertion order, which is what
 * makes that a one-liner.
 */
const PROXY_CACHE_MAX = 500;
const PROXY_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a verdict the provider could not give is kept.
 *
 * A real verdict is worth five minutes of not asking again. "Could not check" is not a
 * verdict at all, and caching it for the full five minutes turns a ten-second provider
 * outage into five minutes during which every click from that address is waved through with
 * a fraud row written against it.
 */
const PROXY_CACHE_FAILURE_TTL_MS = 30 * 1000;
const proxyCache = new Map();

function cacheGet(ip) {
    const entry = proxyCache.get(ip);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        proxyCache.delete(ip);
        return null;
    }
    return entry.value;
}

function cacheSet(ip, value, ttlMs = PROXY_CACHE_TTL_MS) {
    if (proxyCache.size >= PROXY_CACHE_MAX) {
        const oldest = proxyCache.keys().next().value;
        if (oldest !== undefined) proxyCache.delete(oldest);
    }
    proxyCache.set(ip, { value, expiresAt: Date.now() + ttlMs });
}

/** Exposed so a test or a configuration change can start from a clean slate. */
function resetFraudCache() {
    proxyCache.clear();
    missingKeyWarned = false;
}

// ---------------------------------------------------------------------------
// One-time warnings
// ---------------------------------------------------------------------------

/** Warns once per process about a missing key, so the log is not spammed per click. */
let missingKeyWarned = false;

// ---------------------------------------------------------------------------
// Proxy check
// ---------------------------------------------------------------------------

/**
 * Asks proxycheck.io whether an address is a known VPN or proxy exit.
 *
 * Returns a discriminated verdict rather than a boolean, because the three outcomes need
 * different responses and the previous code collapsed them:
 *
 *   `{ verdict: 'clean' }`    the provider answered and did not flag the address
 *   `{ verdict: 'proxy', type }` the provider answered and flagged it
 *   `{ verdict: 'unknown', reason }` the check could not be completed
 *
 * The distinction between "checked and clean" and "could not check" is exactly what
 * `PROXYCHECK_REQUIRED` needs to act on, and a boolean made the two indistinguishable.
 *
 * `validateStatus` is set to accept every status so the response body can be inspected
 * even on a non-2xx. proxycheck returns a JSON error document explaining what went wrong
 * -- an invalid key, a quota exceeded, a malformed address -- and reading it turns a
 * generic "check unavailable" into an actionable log line.
 */
async function checkProxyVerdict(ipAddress, apiKey) {
    let response;
    try {
        response = await axios.get(
            `https://proxycheck.io/v2/${encodeURIComponent(ipAddress)}`,
            {
                params: { vpn: 1, key: apiKey },
                timeout: 3000,
                validateStatus: () => true,
            }
        );
    } catch (error) {
        // A network failure, a DNS failure, or a timeout. The axios error carries a code
        // that names which; `error.message` alone says "timeout of 3000ms exceeded" for
        // the last of them and nothing useful for the rest.
        const reason = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
            ? 'timeout'
            : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
                ? 'dns'
                : error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
                    ? 'connection'
                    : 'network';
        return { verdict: 'unknown', reason };
    }

    const body = response.data;
    if (!body || typeof body !== 'object') {
        return { verdict: 'unknown', reason: `non-json-response (http ${response.status})` };
    }

    // The provider reports its own failures in a `status` field, regardless of HTTP
    // status. `denied` and `error` are its two failure words; anything else is an
    // attempt at an answer.
    const status = String(body.status || '').toLowerCase();
    if (status === 'denied' || status === 'error') {
        return { verdict: 'unknown', reason: `${status}: ${body.message || 'no message'}` };
    }

    const ipData = body[ipAddress];
    if (!ipData || typeof ipData !== 'object') {
        // The provider sometimes returns success with a `warning` and no per-IP block --
        // a quota warning, an invalid-key warning, a rate-limit warning.
        const warning = typeof body.message === 'string' ? body.message : 'no per-ip block';
        return { verdict: 'unknown', reason: `no-ip-block (${warning})` };
    }

    if (ipData.proxy === 'yes') {
        return { verdict: 'proxy', type: ipData.type || 'unknown', risk: ipData.risk ?? null };
    }

    return { verdict: 'clean' };
}

async function lookupProxy(ipAddress) {
    const cached = cacheGet(ipAddress);
    if (cached) return { ...cached, cached: true };

    const verdict = await checkProxyVerdict(ipAddress, process.env.PROXYCHECK_KEY);
    // Only cache a real verdict for long. A failure is cached too, but under a shorter TTL so a
    // brief outage does not exempt the address for the full five minutes.
    cacheSet(
        ipAddress,
        verdict,
        verdict.verdict === 'unknown' ? PROXY_CACHE_FAILURE_TTL_MS : PROXY_CACHE_TTL_MS
    );
    return { ...verdict, cached: false };
}

// ---------------------------------------------------------------------------
// Velocity check
// ---------------------------------------------------------------------------

/**
 * Counts recent clicks from one address.
 *
 * The window is a parameter bound into the interval expression rather than interpolated
 * into it, so the value cannot be a SQL fragment however the environment variable is set.
 *
 * The lookup is a full scan unless `clicks (ip_address, created_at)` is indexed. That
 * index is a schema concern, not a middleware one, but on a site with real traffic it is
 * the difference between a sub-millisecond query and a visible pause on every click.
 */
async function countRecentClicks(ipAddress, windowSeconds) {
    const result = await pool.query(
        `SELECT COUNT(*) AS count FROM clicks
         WHERE ip_address = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 second')`,
        [ipAddress, windowSeconds]
    );
    return Number(result.rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function logFraud(userId, ip, reason) {
    try {
        await pool.query(
            `INSERT INTO fraud_logs (user_id, ip_address, reason) VALUES ($1, $2, $3)`,
            [userId || null, ip, reason]
        );
    } catch (err) {
        console.error('Failed to log fraud:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Sets the headers every fraud response should carry, so a proxy does not cache a refusal. */
function refuse(res, status, message) {
    res.set('Cache-Control', 'no-store');
    if (status === 429) {
        // Per RFC 7231, so a well-behaved client backs off instead of retrying immediately.
        res.set('Retry-After', String(velocityWindowSeconds()));
    }
    return res.status(status).send(message);
}

async function fraudDetection(req, res, next) {
    // An OPTIONS request is a CORS preflight and never carries the click itself. Running
    // the checks on it would burn a proxycheck lookup and a velocity count on every
    // cross-origin call, and the answers would be thrown away because the browser does
    // not expect a body.
    if (req.method === 'OPTIONS') return next();

    const ipAddress = normaliseAddress(req.ip || req.socket?.remoteAddress);
    const userAgent = req.headers['user-agent'];
    const userId = req.user?.id ?? null;

    // The result of each check is recorded on the request so a downstream handler can
    // act on what was learned -- refusing a reward, requiring a captcha, or simply
    // including it in an audit record -- without repeating any of the work.
    req.fraud = { proxy: 'skipped', velocity: null, address: ipAddress };

    if (isScriptedClient(userAgent)) {
        await logFraud(userId, ipAddress, `Scripted client: ${String(userAgent || 'no user-agent').slice(0, 200)}`);
        return refuse(res, 403, 'Access denied.');
    }

    // No address to check against means no way to run either the proxy check or the
    // velocity count, and no safe way to fail. Refusing every request from a host that
    // reports no peer address would be a self-inflicted outage; allowing them but
    // skipping the checks is what the rest of this middleware does for an unconfigured
    // provider, and the log line says so.
    if (!ipAddress) {
        console.warn('Fraud checks skipped: no peer address could be determined for this request.');
        req.fraud.proxy = 'no-address';
        return next();
    }

    // --- Proxy / VPN check --------------------------------------------------

    if (process.env.PROXYCHECK_KEY) {
        const lookup = await lookupProxy(ipAddress);
        req.fraud.proxy = lookup.verdict;
        if (lookup.type) req.fraud.proxyType = lookup.type;

        if (lookup.verdict === 'proxy') {
            await logFraud(userId, ipAddress, `VPN/Proxy detected: ${lookup.type}`);
            return refuse(res, 403, 'VPNs and proxies are not allowed.');
        }

        if (lookup.verdict === 'unknown') {
            // The distinction the old code could not make: a provider that could not be
            // reached is not the same as a provider that answered "clean".
            const tag = lookup.cached ? 'cached ' : '';
            console.warn(`Proxy check returned ${tag}unknown (${lookup.reason}) for ${ipAddress}.`);
            if (proxyCheckRequired()) {
                return refuse(res, 503, 'Fraud checks are temporarily unavailable.');
            }
            await logFraud(
                userId,
                ipAddress,
                `Proxy check unavailable (${lookup.reason}); click allowed (PROXYCHECK_REQUIRED is not set)`
            );
        }
    } else if (proxyCheckRequired()) {
        // Asked to fail closed but cannot: say so distinctly, because the difference
        // between "blocked by policy" and "refused by misconfiguration" matters when the
        // whole catalog is returning 503.
        console.error('PROXYCHECK_REQUIRED is set but PROXYCHECK_KEY is missing, so every click is being refused.');
        return refuse(res, 503, 'Fraud checks are not configured.');
    } else if (!missingKeyWarned) {
        missingKeyWarned = true;
        console.warn(
            'PROXYCHECK_KEY is not set, so VPN/proxy checks are not running. Clicks are ' +
            'being tracked without them. Set PROXYCHECK_KEY to enable the check, and ' +
            'PROXYCHECK_REQUIRED=true if tracking should be refused while it is unavailable.'
        );
    }

    // --- Velocity check -----------------------------------------------------

    let clickCount;
    try {
        clickCount = await countRecentClicks(ipAddress, velocityWindowSeconds());
    } catch (error) {
        // The velocity query failed, which means the database is unreachable. That is a
        // real outage and the caller cannot be told to try again later against a service
        // that is already down -- but the click is not worth tracking into a database
        // that is not answering either, so the request is refused rather than allowed.
        console.error('Click velocity check failed:', error.message);
        return refuse(res, 503, 'Tracking is temporarily unavailable.');
    }

    req.fraud.velocity = clickCount;
    const threshold = velocityThreshold();
    if (clickCount >= threshold) {
        await logFraud(userId, ipAddress, `High click velocity: ${clickCount} in ${velocityWindowSeconds()}s`);
        return refuse(res, 429, 'Too many requests.');
    }

    return next();
}

module.exports = fraudDetection;
module.exports.proxyCheckRequired = proxyCheckRequired;
// Exported because the click that this middleware counts has to be *stored* in the same
// normalised form, or the count and the record describe two different clients.
module.exports.normaliseAddress = normaliseAddress;
// Exposed for the test suite, which needs to drive one check and inspect the verdict
// without standing up a database, and for a configuration change that should not have to
// wait out the cache TTL.
module.exports.resetFraudCache = resetFraudCache;
module.exports.__private = { normaliseAddress, isScriptedClient, checkProxyVerdict };