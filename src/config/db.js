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

/**
 * How long a shutdown is allowed to take before the process exits anyway.
 *
 * Every platform that sends SIGTERM sends SIGKILL shortly after, so a pool that cannot
 * be closed -- because the database has already gone away -- must not be allowed to
 * hold the process past the point where it would be killed regardless. The cost of
 * exceeding it is that the connections are severed rather than drained; the cost of not
 * having the bound at all is that the process is killed mid-close and logs nothing.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * The individual variables `pg` reads when `connectionString` is undefined.
 * A deployment using these instead of a full URL is not misconfigured, and
 * must not be treated as one.
 */
const INDIVIDUAL_PG_VARS = Object.freeze([
    'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPORT',
]);

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the connection string, or explains clearly why it could not.
 *
 * The original version of this function threw at module load when
 * DATABASE_URL was absent. That is the correct instinct -- the whole point of
 * loading `dotenv` above is to avoid the silent `connectionString: undefined`
 * that `pg` resolves to a local socket -- but it is the wrong mechanism.
 * `pg` itself accepts two sources of connection information:
 *
 *   1. `connectionString` (from DATABASE_URL), or
 *   2. the individual `PGHOST` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` /
 *      `PGPORT` variables.
 *
 * A deployment that uses source 2 and never sets DATABASE_URL is not
 * misconfigured; it is just not using the form this file expects. Throwing at
 * module load in that case crashes the entire app -- including the public
 * offer catalog, which does not even need to know the connection failed --
 * which is worse than the error the pool would have produced on its own.
 *
 * So the check is now:
 *   - Return the URL when it is present.
 *   - Return `undefined` and let `pg` read the individual variables when any
 *     of them is set.
 *   - Otherwise log one explicit, actionable error and still return
 *     `undefined`. The pool will fail on the first query with ECONNREFUSED
 *     against localhost, but the log line above it names the actual problem,
 *     and the app does not crash on startup.
 *
 * `STRICT_DATABASE_URL=true` restores the fail-fast behaviour for deployments
 * that want the crash. It is opt-in rather than the default because a process
 * that cannot reach its database is not useful, but a process that will not
 * start is strictly worse: the failure is silent to the operator (no HTTP
 * response at all, only a startup log) and the app is unreachable for every
 * request, including health checks and the public pages that never touch the
 * database.
 */
function resolveConnectionString() {
    const url = process.env.DATABASE_URL;
    if (typeof url === 'string' && url.trim() !== '') {
        return url.trim();
    }

    // `pg` will build the connection from these when `connectionString` is
    // undefined. If any is present, the deployment is configured by a form
    // this file does not need to understand; step aside and let `pg` handle
    // it exactly as it did before this check existed.
    const hasIndividualVars = INDIVIDUAL_PG_VARS.some((name) => {
        const value = process.env[name];
        return typeof value === 'string' && value.length > 0;
    });
    if (hasIndividualVars) {
        return undefined;
    }

    const message =
        'DATABASE_URL is not set and no individual PG* variables ' +
        `(${INDIVIDUAL_PG_VARS.join(', ')}) are present. pg will fall back to a ` +
        'local socket and every query will fail with ECONNREFUSED against ' +
        'localhost. Set DATABASE_URL in the environment.';

    if (process.env.STRICT_DATABASE_URL === 'true') {
        throw new Error(message);
    }

    // Logged once at module load. Every subsequent query failure will produce
    // the ECONNREFUSED that `pg` emits, which is the symptom; this line is the
    // cause, and having it appear exactly once at the top of the log makes it
    // findable.
    console.error(message);
    return undefined;
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
    let failure = null;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
        return { ok: true };
    } catch (error) {
        failure = error;
        return { ok: false, error: describeError(error) };
    } finally {
        // Released *with* the error when there was one. A plain `release()` puts the
        // client back on the idle list, and if the failure was a severed connection that
        // client is exactly the one that must be discarded -- it is the failure a health
        // check is most likely reporting, and handing it to the next request reproduces
        // the same error on work that never touched the database.
        if (client) client.release(failure ?? undefined);
    }
}

/**
 * Runs `work` inside a transaction and returns whatever it returns.
 *
 * Exists because the alternative is the same four lines in every caller, and the four
 * lines have three ways to be wrong. A `COMMIT` that is not awaited lets the function
 * return before the transaction is durable, so a caller that reports success can be
 * describing a commit that then fails. A missing `ROLLBACK` leaves the connection in an
 * aborted transaction, so the next checkout inherits a client that fails every query
 * with 25P02 until something resets it. A `release()` on only some of the paths -- the
 * success path but not the `throw` path, or a `return` added to the callback later --
 * leaks a client permanently: the pool shrinks one connection at a time and eventually
 * every request fails with "timeout exceeded when trying to connect", which reads as
 * the database being down.
 *
 * `BEGIN` is awaited before `work` is called, so `work` never issues a query outside the
 * transaction it is about to be rolled back.
 */
async function withTransaction(work) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
        await client.query('BEGIN');
        inTransaction = true;
        const result = await work(client);
        await client.query('COMMIT');
        inTransaction = false;
        return result;
    } catch (error) {
        if (inTransaction) {
            // Best effort, and deliberately swallowed. If the connection is gone the
            // ROLLBACK fails too, and letting that failure escape would replace the
            // original error -- the only one that says what actually went wrong -- with
            // a generic "connection terminated" from the unwind.
            await client.query('ROLLBACK').catch(() => {});
        }
        throw error;
    } finally {
        // Unconditional. This is the whole point of the helper: every exit from the
        // function above, including a `return` inside `work`, passes through here.
        client.release();
    }
}

/**
 * Closes the pool when the process is asked to stop.
 *
 * Vercel, Docker, Kubernetes, systemd, and every container orchestrator send SIGTERM
 * (and Ctrl-C sends SIGINT) and then SIGKILL after a short grace period. On the default
 * action the process dies with its sockets still open: PostgreSQL records an abrupt
 * disconnect, rolls back whatever transaction was in flight -- which is how a deposit
 * claim can be lost mid-write -- and leaves connection slots to reap. Ending the pool
 * first drains the idle connections and lets in-flight queries finish inside the grace
 * period.
 *
 * `process.exit` is called explicitly because registering a signal listener replaces
 * Node's default "terminate immediately" behaviour. Without it the process would keep
 * running, holding the event loop open on the very handles being closed.
 */
function installShutdownHandlers() {
    let shuttingDown = false;

    const shutdown = (signal) => {
        // A second signal while the first is still draining must not start a second
        // `pool.end()`: `pg` rejects that with "Called end on pool more than once", and
        // the resulting rejection is thrown from a signal handler, where it becomes an
        // unhandled rejection.
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}; closing the PostgreSQL pool.`);

        // Not unref'd: while the pool is still closing this timer is the only thing
        // guaranteeing the process exits at all if the close hangs.
        const forced = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);

        pool.end()
            .catch((error) => {
                console.error('Error while closing the PostgreSQL pool:', describeError(error));
            })
            .then(() => {
                clearTimeout(forced);
                process.exit(0);
            });
    };

    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => shutdown(signal));
    }
}

installShutdownHandlers();

// The helpers are attached to the pool so callers that already have it in
// hand (the routers, the maintenance endpoints) can reach them without a
// second import. `describeError` in particular is used by the offer, auth,
// and maintenance routers to log failures, and the shape `pool.describeError`
// was already established for that.
pool.describeError = describeError;
pool.buildSslOptions = buildSslOptions;
pool.verifyConnectivity = verifyConnectivity;
pool.withTransaction = withTransaction;

module.exports = pool;