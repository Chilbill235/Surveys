require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
/*                            WEBHOOK ROUTES                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rejects any non-POST request to a webhook endpoint.
 *
 * The provider only posts, so a GET here is a misconfigured scheduler or a probe.
 * `Allow: POST` is set per RFC 7231 so a scanner sees the correct method rather
 * than a bare 404 that leaves the endpoint looking unregistered.
 *
 * The method registry that powers the `/api` 405 handler is populated by the
 * route modules, and these two paths are registered directly on `app` rather
 * than through a router, so the registry does not know about them. Without this
 * guard, `GET /api/payments/nowpayments/ipn` falls through every route, reaches
 * the `/api` 405 handler, finds no entry, and continues to the `/api` 404 --
 * reporting "route not found" when the real answer is "POST only". That is the
 * exact behaviour the maintenance router's IPN guard was added to prevent.
 */
function webhookPostOnly(label) {
    return (req, res, next) => {
        if (req.method === 'POST') return next();
        res.set('Allow', 'POST');
        return res.status(405).json({
            error: `${label} only accepts POST requests.`,
            allowed: ['POST'],
        });
    };
}

// Raw body parsers are required for signature verification -- the handlers read
// the unparsed bytes, and `express.json()` cannot reconstruct them once parsed.
// Both must therefore be registered before the global JSON body middleware.
//
// `.all()` before `.post()` so a GET is rejected before the raw parser runs:
// buffering the body of a request that is about to be discarded is wasted work,
// and the `limit` on the NOWPayments parser makes it a small denial-of-service
// surface on a path an unauthenticated caller can reach.

// Stripe verifies the signature over the exact bytes Stripe sent.
app.route('/api/payments/stripe/webhook')
    .all(webhookPostOnly('The Stripe webhook'))
    .post(express.raw({ type: 'application/json' }), paymentController.stripeWebhook);

// NOWPayments signs the *parsed and re-serialised* payload, so the parser has to
// accept whatever content type the provider chooses; `type: '*/*'` keeps the raw
// bytes available whatever the header says.
app.route('/api/payments/nowpayments/ipn')
    .all(webhookPostOnly('The NOWPayments IPN'))
    .post(express.raw({ type: '*/*', limit: '32kb' }), paymentController.nowPaymentsIpn);

/* -------------------------------------------------------------------------- */
/*                          GLOBAL BODY MIDDLEWARE                            */
/* -------------------------------------------------------------------------- */

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

/* -------------------------------------------------------------------------- */
/*                              PROXY CONFIG                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many proxy hops to trust when resolving `req.ip`.
 *
 * The default is `1`, not `true`, and the difference is a security boundary.
 *
 * `trust proxy: true` tells Express to trust the whole `X-Forwarded-For` chain, which makes
 * `req.ip` the **leftmost** entry -- the one the client wrote. Any client can set it. Vercel's
 * edge appends to that header rather than replacing it, so the leftmost entry survives all the
 * way to the app and `req.ip` becomes attacker-controlled.
 *
 * That matters because every per-IP limiter in this app is keyed on `req.ip`: login,
 * registration, password reset, verification resend, and the magic link. A spoofed header
 * makes all of them free, so the limits stop being limits.
 *
 * `1` means "trust exactly one hop", so Express takes the **rightmost** entry -- the one the
 * edge appended, which is the address the edge actually saw. A Vercel deployment has exactly
 * one proxy in front of the function, so `1` yields the real client address and cannot be
 * spoofed by anything the client sends.
 *
 * The failure mode of setting the count too low is that every visitor collapses into the
 * proxy's own address, which is why the number is a hop count and not a boolean. An operator
 * with a different chain overrides it with `TRUST_PROXY=<hops>`.
 */
const proxySetting = process.env.TRUST_PROXY;
if (proxySetting === 'false') {
    app.set('trust proxy', false);
} else if (proxySetting && proxySetting !== 'true') {
    app.set('trust proxy', proxySetting);
} else {
    app.set('trust proxy', 1);
}

/* -------------------------------------------------------------------------- */
/*                            STATIC FILE ROUTES                              */
/* -------------------------------------------------------------------------- */

const publicDirectory = path.join(__dirname, '..', 'public');

/**
 * Sends an HTML page with the copyright year already in it.
 *
 * The year in the footer used to be written by a script, which meant every page had to load
 * one. Three of them deliberately do not -- `home.html`, `terms.html` and `privacy.html` are
 * static pages that load no application bundle at all -- so the year was either wrong on those
 * or it was an exception in the frontend check teaching the next person that a missing element
 * is fine. Neither is a good trade for one integer.
 *
 * Rendering it here removes the dependency entirely: the year is correct in the first byte of
 * the response, it is correct with JavaScript disabled, and it cannot go stale, because it is
 * computed per request rather than written into a file once and forgotten until January.
 *
 * The file is read and sent rather than streamed. These pages are a few kilobytes each and
 * there are eleven of them, so the memory cost is negligible, and it is the only version of
 * this that is obviously correct: `sendFile` streams, and a stream cannot be rewritten in
 * flight. Caching is handled by the `Cache-Control` header below rather than by the platform,
 * because the year means the response genuinely differs from a cached copy once a year and
 * the default for a `sendFile` here is no-store anyway.
 *
 * Only the year is substituted. The pages are still the files on disk -- no template language,
 * no build step -- and the placeholder is a plain `<span data-current-year>`, so opening the
 * file in an editor still shows readable HTML containing a year.
 */
function sendHtml(res, fileName) {
    fs.readFile(path.join(publicDirectory, fileName), 'utf8', (error, markup) => {
        if (error) {
            res.status(500).send('Page unavailable.');
            return;
        }
        res.type('html').send(markup.replace(/<span data-current-year>\d*<\/span>/g,
            `<span data-current-year>${new Date().getFullYear()}</span>`));
    });
}

app.get('/', (req, res) => sendHtml(res, 'home.html'));

// The trailing-slash form is accepted for each of these because a URL a user
// types by hand often ends in one, and Express's exact-match routing would
// otherwise send it to the catch-all 404. `express.static` below does not save
// it: the directory form looks for `offers/index.html`, which does not exist.
app.get(['/offers', '/offers/'], (req, res) => {
    sendHtml(res, 'index.html');
});

app.get(['/reset-password', '/reset-password/'], (req, res) => {
    sendHtml(res, 'reset-password.html');
});

app.get('/receipt/deposit/:id', (req, res) => {
    sendHtml(res, 'deposit-receipt.html');
});

app.get(['/demo', '/demo/'], (req, res) => {
    if (!isDemoModeEnabled()) {
        return res.status(404).send('Page not found.');
    }
    return sendHtml(res, 'demo.html');
});

app.get(['/history', '/history/'], (req, res) => {
    return res.redirect(301, '/account');
});

app.get(['/account', '/account/'], (req, res) => {
    sendHtml(res, 'account.html');
});

// Its own page, not `account.html` with a dialog on top.
//
// The gate sends signed-out visitors here, and the account page behind a dialog means the
// dashboard is visible around its edges and still there if the dialog is dismissed -- so a
// visitor who must sign in could see the page they are signing in to reach, and could stay
// on it. `login.html` is the sign-in screen and nothing else: no page content behind it, and
// no close control to dismiss.
app.get(['/login', '/login/'], (req, res) => {
    sendHtml(res, 'login.html');
});

// `login.html` is a real file in the public directory, so static would serve it directly at
// this path, bypassing the route above. Same problem and same answer as `/index.html`: one
// canonical URL for the page, so a link that reaches the file form still goes through the
// route and the redirect behaviour stays in one place.
app.get('/login.html', (req, res) => res.redirect(301, '/login'));

app.get(['/terms', '/terms/'], (req, res) => {
    sendHtml(res, 'terms.html');
});

app.get(['/privacy', '/privacy/'], (req, res) => {
    sendHtml(res, 'privacy.html');
});

// The cookie and AML policies are their own pages rather than sections of the Terms.
//
// A link that goes nowhere is worse than no link: a footer entry pointing at a document that
// does not exist implies the document exists, and a reader who cannot find it concludes the
// worst. These two are referenced from every page's footer, so they have to be real, and they
// have to have their own URLs so a compliance reviewer or a partner can be sent straight to
// one without being made to find it inside a longer document.
app.get(['/cookies', '/cookies/'], (req, res) => {
    sendHtml(res, 'cookies.html');
});

app.get(['/aml', '/aml/'], (req, res) => {
    sendHtml(res, 'aml.html');
});

// Same reason as `/index.html` and `/login.html` above: the file is real and static would serve
// it directly, giving the same content a second URL with no canonical form and no redirect
// behaviour, so a link that arrives at the file form skips the route.
app.get('/cookies.html', (req, res) => res.redirect(301, '/cookies'));
app.get('/aml.html', (req, res) => res.redirect(301, '/aml'));

// `/index.html` is a valid file in the public directory and static would serve
// it directly, bypassing the route above. Redirected so the catalog has one
// canonical URL and any tracking that lands on the file form goes through it.
app.get('/index.html', (req, res) => res.redirect(301, '/offers'));

// Same problem, same answer, for the history page. `/account` absorbed it: it serves
// `account.html`, which already loads `history.js` and owns `#history-list` and the
// filter row. `history.html` is still on disk and `express.static` would serve it
// directly, giving the same content a second URL with no canonical link back and a
// second copy of the markup that will drift from the one that is actually served.
// This is a redirect, not a deletion -- removing the file is a separate decision.
app.get('/history.html', (req, res) => res.redirect(301, '/account'));

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
//
// Before the registry on purpose. These endpoints move money and authenticate with
// `CRON_SECRET`, and the design is that they do not disclose themselves to a caller who
// cannot present it: a wrong verb on a maintenance path answers 404, not 405, until the
// secret is supplied. Hoisting the registry above them answered 405 to anyone, which turned
// an operator-only path into one an unauthenticated caller could enumerate and probe.
app.use(maintenanceRoutes);

// A known path reached with the wrong verb is 405, not 404.
//
// This sits above the user and auth routers, not below them, and that placement is the
// whole fix. `userRoutes` installs `router.use(requireAuth)`, which runs before Express
// matches a route -- so with the check after the mount, every wrong verb on `/api/user/*` was
// answered 401 "Authentication is required." That is not a slightly unhelpful status: an
// authenticated user was told they were not authenticated. From the front end it is
// indistinguishable from a lapsed session, which is precisely the report it produces -- a
// form that "will not save" and a sign-in that appears to work.
//
// It discloses nothing new to an anonymous caller. A correct verb on a registered path with
// no token already answers 401, which confirms the path exists just as a 405 would; the
// `Allow` header simply names the verbs.
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