require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const publicRoutes = require('./routes/publicRoutes');
const userRoutes = require('./routes/userRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const paymentController = require('./controllers/paymentController');

const app = express();

const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
}

// Raw body is required first so webhook signatures are verified against the exact
// bytes the provider sent. express.json() would re-serialize the payload.
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), paymentController.stripeWebhook);

// NOWPayments signs the callback, but its signature is computed over the sorted key/value
// pairs of the JSON object, not over the raw bytes, so the body only has to *parse*.
// `express.json()` below only parses when the content-type matches, though: a callback
// that arrives as text/plain, or with no content-type at all, would reach the handler with
// an empty body and fail signature verification permanently. Capturing the raw bytes for
// this path first and parsing them explicitly makes the route content-type independent.
// body-parser marks the body as consumed, so the global express.json() then skips it.
app.use('/api/payments/nowpayments/ipn', express.raw({ type: '*/*', limit: '32kb' }));

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// Vercel terminates TLS in front of the function, so the client IP only arrives in
// X-Forwarded-For. Without this, req.ip is the proxy address and per-IP rate limiting
// would treat every visitor as a single client.
const proxySetting = process.env.TRUST_PROXY;
if (proxySetting === 'false') {
    app.set('trust proxy', false);
} else if (proxySetting && proxySetting !== 'true') {
    app.set('trust proxy', proxySetting);
} else {
    app.set('trust proxy', proxySetting === 'true' || process.env.VERCEL === '1');
}

const publicDirectory = path.join(__dirname, '..', 'public');

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'home.html'));
});
app.get('/offers', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'index.html'));
});
app.get('/reset-password', (req, res) => {
    // The reset token arrives in the URL fragment, which is never sent to the server,
    // so this route only ever serves the static page.
    res.sendFile(path.join(publicDirectory, 'reset-password.html'));
});
// The standalone receipt for one deposit. The id is read from the path by the page
// itself, so this only ever serves the static shell; the data comes from the
// authenticated single-deposit endpoint, so the page cannot leak another user's deposit.
app.get('/deposit/:id', (req, res) => {
    res.sendFile(path.join(publicDirectory, 'deposit-receipt.html'));
});
app.get('/demo', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).send('Page not found.');
    }
    return res.sendFile(path.join(publicDirectory, 'demo.html'));
});
app.use(express.static(publicDirectory, { index: false }));

// Mount routes. The maintenance routes must come first so they can short-circuit.
app.use(maintenanceRoutes);
app.use('/api/auth', authRoutes);
app.use('/', publicRoutes);
app.use('/api/user', userRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((req, res) => res.status(404).send('Page not found.'));
app.use((error, req, res, next) => {
    console.error('Request error:', error.message);
    // body-parser rejects malformed JSON with 400 and oversized payloads with 413. Both
    // are client errors and were previously reported as 500s, which told the caller the
    // server was broken and hid the fact that the request itself was the problem.
    const status = Number(error.status || error.statusCode);
    if (status === 413) {
        return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).json({ error: 'Invalid request body.' });
    }
    return res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;
