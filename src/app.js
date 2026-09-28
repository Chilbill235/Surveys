require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');

const authRoutes = require('./routes/authRoutes');
const publicRoutes = require('./routes/publicRoutes');
const userRoutes = require('./routes/userRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const { methodsFor } = require('./routes/methodRegistry');
const paymentController = require('./controllers/paymentController');
const { isDemoModeEnabled } = require('./services/demoMode');

const app = express();

// Security HTTP headers.
//
// Three of helmet's defaults are deliberately overridden, and the reason is the same in
// each case: the policy is expressed in `vercel.json` at the edge, and a second,
// differently-scoped copy of the same header from the origin only produces a conflict that
// the stricter of the two silently wins.
//
//  - `contentSecurityPolicy: false`. The policy is set in vercel.json so it also covers the
//    files Vercel serves from its own CDN, which never reach this process. Emitting one
//    here as well would mean the two have to stay identical forever, with no signal when
//    they drift.
//  - `frameguard: false`. Helmet's default is `X-Frame-Options: SAMEORIGIN`, which is
//    *narrower* than the `frame-ancestors 'self' https:` the deployment allows, and it
//    cannot express "any https origin" at all. Left on, it silently overrides the intent
//    and blocks the site being embedded over https while looking like a security win.
//    `frame-ancestors` is the modern control and is the one that applies.
//  - `crossOriginResourcePolicy: 'cross-origin'`, because the site is meant to be embedded
//    and the same-origin default would block the embedded page's own subresources.
app.use(
    helmet({
        contentSecurityPolicy: false,
        frameguard: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
);

// Dynamic CORS configuration
const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

if (corsOrigins.length > 0) {
    app.use(
        cors({
            origin: corsOrigins,
            credentials: true
        })
    );
}

/* -------------------------------------------------------------------------- */
/*                            WEBHOOK RAW PARSERS                             */
/* -------------------------------------------------------------------------- */

// Raw body parser for Stripe Webhook Signature verification
app.post(
    '/api/payments/stripe/webhook',
    express.raw({ type: 'application/json' }),
    paymentController.stripeWebhook
);

// Raw body parser for NOWPayments IPN verification
app.post(
    '/api/payments/nowpayments/ipn',
    express.raw({ type: '*/*', limit: '32kb' }),
    paymentController.nowPaymentsIpn
);

/* -------------------------------------------------------------------------- */
/*                          GLOBAL BODY MIDDLEWARE                            */
/* -------------------------------------------------------------------------- */

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

/* -------------------------------------------------------------------------- */
/*                              PROXY CONFIG                                  */
/* -------------------------------------------------------------------------- */

const proxySetting = process.env.TRUST_PROXY;
if (proxySetting === 'false') {
    app.set('trust proxy', false);
} else if (proxySetting && proxySetting !== 'true') {
    app.set('trust proxy', proxySetting);
} else {
    app.set('trust proxy', proxySetting === 'true' || process.env.VERCEL === '1');
}

/* -------------------------------------------------------------------------- */
/*                            STATIC FILE ROUTES                              */
/* -------------------------------------------------------------------------- */

const publicDirectory = path.join(__dirname, '..', 'public');

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'home.html'));
});

app.get('/offers', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'reset-password.html'));
});

app.get('/deposit/:id', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'deposit-receipt.html'));
});

app.get('/demo', (req, res) => {
    // Demo mode, not NODE_ENV. The demo page and the demo offers in the catalog are one
    // feature: if the catalog shows a demo offer, this page has to be reachable, and if it
    // is not, the catalog has nothing to point at. Keying them off different variables is
    // how a deployment ends up advertising surveys that lead to a 404.
    if (!isDemoModeEnabled()) {
        return res.status(404).send('Page not found.');
    }
    return res.sendFile(path.join(publicDirectory, 'demo.html'));
});

app.use(
    express.static(publicDirectory, {
        index: false,
        maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
    })
);

/* -------------------------------------------------------------------------- */
/*                                API ROUTES                                  */
/* -------------------------------------------------------------------------- */

// Maintenance mode route must evaluate prior to API routes to allow short-circuiting
app.use(maintenanceRoutes);
app.use('/api/auth', authRoutes);
app.use('/', publicRoutes);
app.use('/api/user', userRoutes);

// A known path reached with the wrong verb is 405, not 404. This has to sit ahead of the
// 404 handlers below: the routes have already declined to match, so by the time a request
// arrives here the only thing left to tell apart "wrong URL" from "wrong verb" is the
// registry the route modules populated.
//
// Without it, opening the POST-only refund endpoint in a browser answered
// `{"error":"API route not found."}` -- a statement that was true only in the sense that no
// route matched the request, and false about the thing the operator actually asked: the
// endpoint exists, and a GET was the wrong way to reach it.
app.use('/api', (req, res, next) => {
    // `req.path` inside a mounted router is relative to the mount, so the registry is asked
    // about the full path.
    const pathname = req.originalUrl.split('?')[0];
    const allowed = methodsFor(pathname);
    if (!allowed) return next();

    // OPTIONS is the CORS preflight and discovery verb, and is answered for every known
    // path regardless of what the caller sent. Advertised so a client can find the verb.
    const verbs = allowed.includes('OPTIONS') ? allowed : [...allowed, 'OPTIONS'];
    res.set('Allow', verbs.join(', '));

    // 200 with a body, not 204: a 204 must carry no body, and the body-less response drops
    // the `Allow` header this exists to publish.
    if (req.method === 'OPTIONS') {
        return res.status(200).json({ allowed: verbs });
    }
    if (allowed.includes(req.method)) return next();

    return res.status(405).json({
        error: `${req.method} is not allowed for this endpoint.`,
        allowed: verbs,
        hint: `Use ${verbs.filter((verb) => verb !== 'OPTIONS').join(' or ')} with ${pathname}.`,
    });
});

// 404 Handlers
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((req, res) => res.status(404).send('Page not found.'));

/* -------------------------------------------------------------------------- */
/*                          GLOBAL ERROR HANDLER                              */
/* -------------------------------------------------------------------------- */

app.use((error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }

    // Handle Body-Parser & Syntax Errors
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ error: 'Invalid JSON payload format.' });
    }

    const status = Number(error.status || error.statusCode);

    if (status === 413) {
        return res.status(413).json({ error: 'Request body exceeds maximum size limit (32kb).' });
    }

    if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).json({ error: error.message || 'Invalid request parameters.' });
    }

    console.error('Unhandled Application Error:', error);
    return res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

module.exports = app;