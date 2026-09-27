require('dotenv').config();
const { resolvePublicBaseUrl, isPubliclyReachable, defaultPort } = require('./src/services/publicBaseUrl');

const isProduction = process.env.NODE_ENV === 'production';

function fail(message) {
    console.error(`Configuration error: ${message}`);
    process.exit(1);
}

/**
 * Validates runtime configuration before the server accepts traffic.
 *
 * Misconfiguration here is what silently breaks payments: a localhost APP_BASE_URL in
 * production means providers post confirmations to a machine they cannot reach, so a
 * deposit stays pending forever while the customer has already paid.
 */
function validateRuntimeConfiguration() {
    const publicBaseUrl = resolvePublicBaseUrl();
    if (!publicBaseUrl.ok) {
        fail(publicBaseUrl.error);
    }

    if (!process.env.JWT_SECRET) {
        if (isProduction) fail('JWT_SECRET is required so account sessions can be signed.');
        console.warn('Heads up: JWT_SECRET is not set, so account registration and sign-in are disabled.');
    } else if (process.env.JWT_SECRET.length < 32) {
        const message = 'JWT_SECRET should be at least 32 characters of random data.';
        if (isProduction) fail(message);
        console.warn(`Heads up: ${message}`);
    }

    // Checked in every environment, not just production. A missing CRON_SECRET disables
    // scheduled deposit reconciliation, and because the endpoint answers 404 when it
    // cannot authenticate a caller, the symptom looks identical to a wrong URL. Warning
    // only in production meant a developer never found out locally.
    if (!process.env.CRON_SECRET) {
        console.warn(
            'Warning: CRON_SECRET is not set, so /api/maintenance/reconcile-deposits is disabled ' +
            'and will answer 503. Set CRON_SECRET to enable the scheduled recovery job.'
        );
    }

    if (isProduction) {
        // Registration, deposits, and password resets all write to the database, so
        // production cannot start without it. Locally the app still boots so the static
        // pages and stub-based tests can run.
        if (!process.env.DATABASE_URL) {
            fail('DATABASE_URL is required in production.');
        }
        if (!process.env.POSTBACK_SECRET) {
            console.warn('Warning: POSTBACK_SECRET is not set, so advertiser postbacks are rejected.');
        }
        if (!process.env.PROXYCHECK_KEY) {
            console.warn('Warning: PROXYCHECK_KEY is not set, so VPN/proxy checks are skipped.');
        }
        if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
            console.warn('Warning: RESEND_API_KEY and EMAIL_FROM are not set, so password reset emails cannot be delivered.');
        }
        const hasStripe = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
        const hasNowPayments = Boolean(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET);
        if (!hasStripe && !hasNowPayments) {
            console.warn('Warning: no payment provider credentials are set, so deposits are unavailable.');
        }

        // Not fatal, because localhost is the only workable base URL before a tunnel
        // exists -- but it is the reason a NOWPayments callback "does not arrive". The
        // provider posts to this origin from the public internet and cannot resolve
        // localhost, so every IPN is silently undeliverable. Surfaced rather than assumed,
        // because from the outside it is indistinguishable from the provider being broken.
        if (!isPubliclyReachable(publicBaseUrl.baseUrl) && (hasStripe || hasNowPayments)) {
            console.warn(
                `Warning: APP_BASE_URL is ${publicBaseUrl.baseUrl.origin}, which is not reachable from the ` +
                'internet. Payment providers cannot deliver confirmations to it, so deposits will never be ' +
                'credited automatically. Put the app behind a public HTTPS tunnel (for example ' +
                '`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`), set APP_BASE_URL to ' +
                'that public origin, and set the same URL as the IPN callback in the provider dashboard.'
            );
        }
    }

    // A port mismatch is the same class of failure as an unreachable host, and harder to
    // spot: the app listens on one port while telling providers to call another, so every
    // callback is delivered to whatever happens to be running there -- usually an older
    // build. It fails identically to "the provider is not sending", which is what makes it
    // worth an explicit check rather than a comment.
    const listenPort = defaultPort;
    const configuredPort = publicBaseUrl.baseUrl.port
        ? Number(publicBaseUrl.baseUrl.port)
        : (publicBaseUrl.baseUrl.protocol === 'https:' ? 443 : 80);
    if (configuredPort !== listenPort && !(publicBaseUrl.baseUrl.protocol === 'https:' && listenPort === 443)) {
        console.warn(
            `Warning: APP_BASE_URL is ${publicBaseUrl.baseUrl.origin} but the server listens on port ` +
            `${listenPort}. Provider callbacks will be sent to port ${configuredPort}, which is not this ` +
            `process. Set APP_BASE_URL to http://localhost:${listenPort} for local work, or to your public ` +
            'origin once the app is behind a tunnel.'
        );
    }

    console.log(`Public base URL in use: ${publicBaseUrl.baseUrl.origin}`);
    console.log(`Listening on port: ${listenPort}`);
}

validateRuntimeConfiguration();

const app = require('./src/app');
const port = defaultPort;

app.listen(port, () => {
    console.log(`Offer network API listening on port ${port}`);
});
