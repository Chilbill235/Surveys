require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');

const authRoutes = require('./routes/authRoutes');
const publicRoutes = require('./routes/publicRoutes');
const userRoutes = require('./routes/userRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
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