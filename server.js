require('dotenv').config();

/**
 * Derives the local-facing URL variables from PORT.
 *
 * A developer changing the port in `.env` used to have to change APP_BASE_URL and
 * CORS_ORIGIN to match, and getting it wrong produced two failures that look
 * unrelated to the cause: a CORS block on every fetch from the browser (because the
 * allowlist still named the old port), and a port-mismatch warning at startup
 * (because the public origin still named the old port). Both are the same mistake,
 * and neither is worth making twice.
 *
 * This runs before `require('./src/app')`, which reads CORS_ORIGIN at module load to
 * configure the CORS middleware. It also runs before `resolvePublicBaseUrl()` is
 * first called below.
 *
 * An explicit value always wins. On Vercel, APP_BASE_URL and CORS_ORIGIN are set in
 * the project environment, so this block does nothing there and the production
 * values are used exactly as before. Locally, neither is usually set, and both are
 * filled in from PORT.
 */
(function deriveLocalUrlDefaults() {
    const parsedPort = Number(process.env.PORT);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3001;
    const localOrigin = `http://localhost:${port}`;
    if (!process.env.APP_BASE_URL) process.env.APP_BASE_URL = localOrigin;
    // If CORS_ORIGIN is not set, allow every origin in APP_BASE_URL (comma-separated)
    // plus the localhost origin, so local testing from multiple devices works.
    if (!process.env.CORS_ORIGIN) {
        const allOrigins = process.env.APP_BASE_URL
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        process.env.CORS_ORIGIN = allOrigins.join(',');
    }
})();

const { resolvePublicBaseUrl, isPubliclyReachable, defaultPort } = require('./src/services/publicBaseUrl');
const { emailConfiguration } = require('./src/services/mailer');
const { placeholderProblems, realCredential } = require('./src/services/credentials');
const { stripeKeyMode, looksLikeSecretKey } = require('./src/services/stripeErrors');
const nowPayments = require('./src/services/nowPayments');

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
            'Warning: CRON_SECRET is not set, so /api/maintenance/reconcile-deposits and ' +
            '/api/maintenance/reconcile-payouts are disabled and will answer 503. Set CRON_SECRET ' +
            'to enable the scheduled recovery jobs.'
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
        const mail = emailConfiguration();
        if (!mail.configured) {
            console.warn(
                `Warning: no email provider is fully configured (provider: ${mail.provider || 'none'}, ` +
                'sender: ' + (mail.sender || 'unset') + '), so signup confirmation and password reset ' +
                'emails cannot be delivered. Set BREVO_API_KEY and EMAIL_FROM.'
            );
        }
        // Placeholder-aware, so a deployment carrying only the example values is told that
        // at startup instead of discovering it on a customer's first card payment.
        const stripeProblems = placeholderProblems(process.env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
        if (stripeProblems.length === 0 && !looksLikeSecretKey(realCredential(process.env, 'STRIPE_SECRET_KEY'))) {
            stripeProblems.push('STRIPE_SECRET_KEY is not a Stripe secret key (sk_test_... or sk_live_...).');
        }
        const hasStripe = stripeProblems.length === 0;
        const hasNowPayments = nowPayments.isConfigured() && Boolean(nowPayments.getIpnSecret());
        if (stripeProblems.length > 0) {
            console.warn(`Warning: card deposits are disabled because ${stripeProblems.join(' ')}`);
        }
        if (hasStripe) {
            // A live key only charges if the account has finished activation. Stripe's refusal
            // ("Your account cannot currently make live charges") happens on the first
            // deposit, in front of a customer, and looks identical to a code fault. Naming the
            // mode here means the log line beside the first failure already says which of the
            // two it is.
            const mode = stripeKeyMode();
            console.log(`Card deposits enabled with a ${mode} Stripe key.`);
            if (mode === 'live') {
                console.log(
                    'Note: a live key needs an activated Stripe account. If the first card deposit is refused with ' +
                    '"cannot currently make live charges", finish verification in the Stripe dashboard or point ' +
                    'STRIPE_SECRET_KEY at a test key (sk_test_...) for a sandbox run.'
                );
            }
        }
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
    //
    // A production deployment behind Vercel is exempt: the platform terminates HTTPS on
    // 443 and forwards to the process, so a listen port that is not 443 is expected and
    // the callback genuinely does arrive on 443. The exemption checks the *configured*
    // port rather than the listen port, because those are the two values that have to
    // agree for a callback to land.
    const listenPort = defaultPort;
    const configuredPort = publicBaseUrl.baseUrl.port
        ? Number(publicBaseUrl.baseUrl.port)
        : (publicBaseUrl.baseUrl.protocol === 'https:' ? 443 : 80);
    const behindTlsProxy = publicBaseUrl.baseUrl.protocol === 'https:' && configuredPort === 443;
    if (configuredPort !== listenPort && !behindTlsProxy) {
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

    // ---------------------------------------------------------------------------
    // Is the database at least as migrated as this build assumes?
    // ---------------------------------------------------------------------------
    //
    // A column added by a migration does not exist until the query runs, so code that uses
    // it is written, merged, and green while the database it will meet has never been
    // migrated. The failure surfaces in production, on one control, with a stack trace
    // about a column -- and nothing at startup said the schema was behind.
    //
    // Warned, not fatal. A server that refuses to boot over a pending migration takes down
    // routes that work perfectly well against the schema that *is* there, which trades a
    // partial fault for a total outage. `scripts/audit-sql.js` is the deeper check.
    const pool = require('./src/config/db');
    const { pendingMigrations, describePendingMigrations } = require('./src/services/schemaCheck');
    pendingMigrations(pool).then(
        (result) => {
            const message = describePendingMigrations(result);
            if (message) console.warn(`Warning: ${message}`);
        },
        () => {
            // Unreachable database, or one that forbids the read. Not this check's problem to
            // diagnose; saying so would only compete with the connection error itself.
        }
    );

    // ---------------------------------------------------------------------------
    // Automatic crypto payouts
    // ---------------------------------------------------------------------------
    //
    // Crypto withdrawals are paid by the provider on their own schedule, and the
    // operator has to be told when one is ready. The endpoint above is the trigger;
    // this is the timer. It runs the preflight and, if configured, claims and sends
    // whatever is waiting -- the same path a human operator would take, which is
    // the point: there is one implementation of "send these", and it is exercised
    // by both.
    //
    // The interval is one minute. Shorter burns polling the provider API on every
    // tick for a queue that is usually empty; longer leaves a user staring at a
    // "processing" withdrawal for a long time. One minute is the compromise.
    const AUTO_PAYOUT_INTERVAL_MS = 60_000;

    // Settling is on a slower beat than sending. The callback is the fast path and it
    // normally resolves a payout within seconds; this is the net underneath it, for the
    // callbacks that never arrive. Polling the provider costs a request per in-flight
    // payout, so a shorter interval buys nothing once the queue is settled and spends real
    // quota while it is not. Five minutes is inside the window a user would still call
    // "where is my money", and slow enough to be free in the steady state.
    const PAYOUT_RECONCILE_INTERVAL_MS = 5 * 60_000;

    async function runAutoPayoutsTick() {
        try {
            const autoPayouts = require('./src/services/autoPayouts');
            const preflight = autoPayouts.preflight();
            if (!preflight.ready) return;

            const { claimed, skipped } = await autoPayouts.claimPayoutCandidates({
                limit: 20,
                convertToCoin: autoPayouts.usdToCoin
            });
            if (claimed.length === 0) return;

            const outcome = await autoPayouts.submitClaimedPayouts(claimed);
            console.log(`Auto-payouts: claimed ${claimed.length}, submitted ${outcome.submitted}, skipped ${skipped.length}.`);
        } catch (error) {
            console.error('Auto-payouts tick failed:', error.message);
        }
    }

    // Runs unconditionally, unlike the sending tick: a deployment that has payouts in
    // flight but has since unset NOWPAYMENTS_AUTO_PAYOUTS still owes those users an
    // outcome, and refusing to look would leave a withdrawal stuck in `processing` with
    // its balance already debited. Settling reads and never sends, so it is safe to run
    // even where sending is not configured.
    async function runPayoutReconcileTick() {
        try {
            const autoPayouts = require('./src/services/autoPayouts');
            const outcomes = await autoPayouts.reconcilePayouts({ limit: 50 });
            const settled = outcomes.filter((o) => o.outcome === 'sent' || o.outcome === 'refunded');
            if (settled.length > 0) {
                console.log(`Payout reconcile: settled ${settled.length} of ${outcomes.length} in-flight payout(s).`);
            }
        } catch (error) {
            console.error('Payout reconciliation tick failed:', error.message);
        }
    }

    // First tick after a short delay so startup logs settle.
    setTimeout(runAutoPayoutsTick, 5000);
    setInterval(runAutoPayoutsTick, AUTO_PAYOUT_INTERVAL_MS);

    // Reconciliation starts later than sending: there is nothing in flight five seconds
    // after a cold start, and this way the first pass does not immediately re-read batches
    // that the first sending tick is still creating.
    setTimeout(runPayoutReconcileTick, 30_000);
    setInterval(runPayoutReconcileTick, PAYOUT_RECONCILE_INTERVAL_MS);
});
