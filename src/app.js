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

const app = express();

// Security HTTP headers (configured to allow serving local static assets & scripts)
app.use(
    helmet({
        contentSecurityPolicy: false, // Disable default CSP to prevent breaking external CDNs/scripts unless strictly configured
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
    if (process.env.NODE_ENV === 'production') {
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