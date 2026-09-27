const { Pool } = require('pg');

/**
 * Builds the TLS options for the connection.
 *
 * Managed PostgreSQL providers (Neon, Supabase, Railway, ...) present certificates that
 * are not in Node's trust store. Connecting with `rejectUnauthorized: true` and no
 * supplied CA therefore fails with "self-signed certificate in certificate chain", so the
 * app cannot reach the database at all in production even though the URL is correct.
 *
 * Verification is enabled when a CA certificate is supplied through DATABASE_CA_CERT
 * (the newline-escaped form environment variables usually hold), and the absence of one
 * is reported at startup rather than left to surface as a connection error later.
 */
function buildSslOptions() {
    const sslMode = (process.env.DATABASE_SSL || process.env.PGSSLMODE || '').trim().toLowerCase();
    if (sslMode === 'disable' || sslMode === 'false' || sslMode === 'allow') {
        return false;
    }

    // A single-line env var cannot hold real newlines, so the escaped form is expanded.
    const ca = (process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
    if (ca) {
        return { ca, rejectUnauthorized: true };
    }

    if (process.env.NODE_ENV === 'production' && sslMode !== 'require') {
        console.warn(
            'Database TLS is encrypted but the certificate is not verified because ' +
            'DATABASE_CA_CERT is not set. Set DATABASE_CA_CERT to the provider CA to enable verification.'
        );
    }
    return { rejectUnauthorized: false };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX) || 20, // Maximum connections in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: buildSslOptions()
});

pool.on('error', (err, client) => {
    // A serverless host can freeze or scale down a runtime without a clean shutdown,
    // which surfaces here as an error on an idle client. Exiting would turn a
    // recycled connection into a crash, so the error is logged instead. The pool
    // discards the broken client and opens a fresh one on the next request.
    console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

module.exports = pool;
module.exports.buildSslOptions = buildSslOptions;
