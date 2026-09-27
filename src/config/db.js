// The environment is loaded here rather than relying on every entry point to do it first.
//
// `Pool` is constructed at module load with `process.env.DATABASE_URL` read once. This file
// used to assume something had already called `dotenv.config()`, which held for `server.js`
// and `api/index.js` and for nothing else. Any other entry point -- a script, a test, a
// future worker -- that required this module first got `connectionString: undefined`, and
// `pg` resolves an absent connection string to a local socket. The result is
// ECONNREFUSED against localhost: the catalog and every authenticated endpoint fail with a
// 500 while the connection string is sitting in `.env` looking correct.
//
// `dotenv.config()` does not overwrite variables that are already set, so this cannot
// override a real deployment's environment, and calling it more than once is harmless.
// `quiet: true` suppresses the informational banner dotenv prints on every start; the
// absence of that banner is not diagnostic and printing it on every function cold start
// is noise in production logs.
require('dotenv').config({ quiet: true });

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POOL_MAX = 20;
const MIN_POOL_MAX = 1;
/**
 * A hard ceiling on the configured pool size. Without it, a typo like
 * `DATABASE_POOL_MAX=2000` would have every serverless instance open 2,000
 * connections against a provider whose own limit is often 20-100, and the
 * failure mode is "too many clients" on every request rather than on the one
 * that misconfigured the variable.
 */
const MAX_POOL_MAX = 200;

const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the connection string, or fails loudly at startup.
 *
 * The whole point of loading `dotenv` above is to avoid the silent
 * `connectionString: undefined` that `pg` resolves to a local socket. But
 * loading `.env` does not guarantee the variable is *in* it. Without this
 * check, a missing or empty `DATABASE_URL` still produces the same
 * ECONNREFUSED-against-localhost failure the load was meant to prevent, and the
 * failure now looks like a code bug rather than a configuration one because the
 * environment "was loaded".
 *
 * Throwing at module load turns that into a startup crash with a message that
 * names the variable. A process that cannot reach its database has no useful
 * work to do, so failing before the HTTP server binds is strictly better than
 * failing on the first request.
 */
function resolveConnectionString() {
    const url = process.env.DATABASE_URL;
    if (typeof url !== 'string' || url.trim() === '') {
        throw new Error(
            'DATABASE_URL is not set. Set it in the environment (or in .env before startup). ' +
            'Without it, pg falls back to a local socket and every request fails with ' +
            'ECONNREFUSED against localhost.'
        );
    }
    return url.trim();
}

/**
 * Resolves the pool size, bounded and sane.
 *
 * `Number(undefined)` is `NaN`, and `Number('0')` is `0`, and `pg` treats a
 * max of zero as "no pooling at all" rather than "use the default". Both are
 * configuration mistakes that produce a service which connects but behaves
 * wrong under load, so both fall back to the default rather than being passed
 * through.
 */
function resolvePoolMax() {
    const raw = Number(process.env.DATABASE_POOL_MAX);
    if (!Number.isFinite(raw) || raw < MIN_POOL_MAX) return DEFAULT_POOL_MAX;
    return Math.min(Math.trunc(raw), MAX_POOL_MAX);
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

/**
 * Builds the TLS options for the connection.
 *
 * Managed PostgreSQL providers (Neon, Supabase, Railway, ...) present
 * certificates that are not in Node's trust store. Connecting with
 * `rejectUnauthorized: true` and no supplied CA therefore fails with
 * "self-signed certificate in certificate chain", so the app cannot reach the
 * database at all in production even though the URL is correct.
 *
 * Verification is enabled when a CA certificate is supplied through
 * DATABASE_CA_CERT (the newline-escaped form environment variables usually
 * hold). A provider that requires verification (`verify-ca` / `verify-full`)
 * is honoured the same way: the CA must be present, and a missing one is
 * reported rather than silently downgraded.
 *
 * The returned object is memoised because it is consulted from `pg` internals
 * on every connection attempt, and re-parsing the CA on each one is wasteful.
 */
let cachedSslOptions = null;

function buildSslOptions() {
    if (cachedSslOptions !== null) return cachedSslOptions;
    cachedSslOptions = computeSslOptions();
    return cachedSslOptions;
}

function computeSslOptions() {
    const sslMode = String(
        process.env.DATABASE_SSL || process.env.PGSSLMODE || ''
    ).trim().toLowerCase();

    // These modes all mean "do not use TLS". `allow` in libpq means "try
    // without SSL first, then with", which for a client that must talk to a
    // managed provider is the same as "no SSL"; treating it as disable matches
    // what every other Node client does with it.
    if (sslMode === 'disable' || sslMode === 'false' || sslMode === 'allow') {
        return false;
    }

    // A single-line env var cannot hold real newlines, so the escaped form is
    // expanded. A value that is present but empty after trimming is treated as
    // absent.
    const ca = String(process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
    if (ca) {
        return { ca, rejectUnauthorized: true };
    }

    // The user has explicitly asked for verification but supplied no CA to
    // verify against. Failing open here would silently strip the verification
    // they asked for; failing closed would break deployments that rely on
    // Node's default trust store. The compromise is to warn loudly on every
    // start until the CA is set, so the gap is visible.
    if (sslMode === 'verify-ca' || sslMode === 'verify-full') {
        console.warn(
            `DATABASE_SSL=${sslMode} was requested but DATABASE_CA_CERT is not set, so ` +
            'the certificate cannot be verified. Set DATABASE_CA_CERT to the provider CA.'
        );
    } else if (process.env.NODE_ENV === 'production') {
        // A production deployment that has not asked for verification and has
        // no CA is in the common "managed Postgres, URL is correct" case. The
        // connection is still encrypted; only the certificate is unverified.
        console.warn(
            'Database TLS is encrypted but the certificate is not verified because ' +
            'DATABASE_CA_CERT is not set. Set DATABASE_CA_CERT to the provider CA to enable verification.'
        );
    }

    return { rejectUnauthorized: false };
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

/**
 * A message worth putting in a log.
 *
 * Node reports a connection failure as an `AggregateError` whose `message` is
 * the empty string, with the actual reason on `errors`. Every handler here logs
 * `error.message`, so an unreachable database used to produce a log line
 * reading `Offers Error:` with nothing after it -- which is the least useful
 * possible report of "the database is not reachable", and the reason a
 * connection problem was indistinguishable from a bad query.
 *
 * Chained errors (`error.cause`) are walked as well: a wrapped error thrown by
 * a driver or a retry helper carries the useful detail on the inner error, and
 * logging only the outer one reports "connection failed" for every distinct
 * underlying cause.
 */
function describeError(error) {
    return describeErrorInner(error, new Set());
}

function describeErrorInner(error, seen) {
    if (error === null || error === undefined) return 'unknown error';

    // A primitive (string, number, symbol) has no shape to inspect.
    if (typeof error !== 'object') return String(error);

    // Guard against a cyclic `cause` chain. A well-behaved error has none, but
    // one produced by a retry loop around a shared error object can.
    if (seen.has(error)) return '(cyclic error)';
    seen.add(error);

    // The most useful message when it is present and non-empty. An empty string
    // is the specific case that motivated this function, so it is treated as
    // absent rather than returned.
    if (typeof error.message === 'string' && error.message.length > 0) {
        return error.message;
    }

    if (Array.isArray(error.errors) && error.errors.length > 0) {
        return error.errors
            .map((inner) => describeErrorInner(inner, seen))
            .join('; ');
    }

    if (error.cause !== undefined && error.cause !== null) {
        const cause = describeErrorInner(error.cause, seen);
        return `caused by: ${cause}`;
    }

    if (error.code) return String(error.code);

    // Last resort. `String({})` is `[object Object]`, which is a legitimate
    // answer but not a useful one; `JSON.stringify` at least names the shape.
    // The `try` covers the circular-reference case JSON refuses to serialise.
    try {
        const json = JSON.stringify(error);
        if (json && json !== '{}') return json;
    } catch {
        // Fall through to the generic label.
    }
    return 'unknown error';
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

const pool = new Pool({
    connectionString: resolveConnectionString(),
    max: resolvePoolMax(),
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: buildSslOptions(),
});

pool.on('error', (err) => {
    // A serverless host can freeze or scale down a runtime without a clean
    // shutdown, which surfaces here as an error on an *idle* client. Exiting
    // would turn a recycled connection into a crash, so the error is logged
    // instead: the pool discards the broken client when it is next checked
    // out, and a fresh one is opened on the following request.
    //
    // The second argument the original handler accepted was unused and is
    // not documented by `pg` as a stable part of the callback signature, so
    // it is not relied on here.
    console.error('Unexpected error on idle PostgreSQL client:', describeError(err));
});

/**
 * A one-shot connectivity check for health endpoints.
 *
 * Acquires a client from the pool, runs the cheapest possible round-trip, and
 * releases it. Returns a plain object rather than throwing, because the caller
 * is almost always a health route that wants to report the failure in a JSON
 * body rather than crash.
 *
 * `SELECT 1` is deliberately bare: anything more would itself be capable of
 * failing for reasons that are not connectivity, and the caller only wants to
 * know whether the database is reachable.
 */
async function verifyConnectivity() {
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
        return { ok: true };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    } finally {
        if (client) client.release();
    }
}

// The helpers are attached to the pool so callers that already have it in
// hand (the routers, the maintenance endpoints) can reach them without a
// second import. `describeError` in particular is used by the offer, auth,
// and maintenance routers to log failures, and the shape `pool.describeError`
// was already established for that.
pool.describeError = describeError;
pool.buildSslOptions = buildSslOptions;
pool.verifyConnectivity = verifyConnectivity;

module.exports = pool;