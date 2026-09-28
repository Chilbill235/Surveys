const express = require('express');
const authController = require('../controllers/authController');
const { rateLimitByIp } = require('../services/security');
const requireAuth = require('../middlewares/requireAuth');
const { register: registerMethod } = require('./methodRegistry');

const router = express.Router();

// The previous version counted attempts in a module-level Map. On a serverless host
// that Map is per instance and disappears on every cold start, so it neither limited
// an attacker across instances nor survived a redeploy. These limiters keep the
// counter in the database instead.
const forgotLimit = rateLimitByIp({ name: 'forgot-password', maxAttempts: 5, windowSeconds: 60 * 60 });
const resetLimit = rateLimitByIp({ name: 'reset-password', maxAttempts: 10, windowSeconds: 60 * 60 });

// Registration was 5 per hour. Because the bucket is keyed on IP, a shared address
// (an office, a university, or a carrier-grade NAT on mobile) exhausted that budget
// across every real user behind it, and the 429 looked like the app was broken.
// Ten per hour still stops automated signup while leaving room for a shared address.
// Raising this also means raising `auth:ip:<address>:register` by hand in the database.
const registerLimit = rateLimitByIp({ name: 'register', maxAttempts: 10, windowSeconds: 60 * 60 });

router.post('/register', registerLimit, authController.register);
// The login route is not fronted by an IP rate limiter middleware. Failed credentials are
// counted inside the controller after the password check, so only actual authentication
// failures consume a slot -- successful logins and the unconfirmed-account 403 do not,
// which kept real users locked out if they retried a known-good password behind a NAT.
router.post('/login', authController.login);
router.post('/forgot-password', forgotLimit, authController.forgotPassword);
router.post('/reset-password', resetLimit, authController.resetPassword);

// Verification. The code check is not behind a per-IP limiter of its own: the code is already
// limited to a handful of guesses by the server-side attempt counter, which is the control
// that has to be unevadable. An IP limiter in front of it would only push a patient attacker
// onto another address, and would punish a household whose members all mistyped a code.
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);

// Magic link: sends a single-use sign-in link to the email on file, bypassing the code
// entry step for an unconfirmed account.
router.post('/magic-link', authController.sendMagicLink);
// Consumes the token from the URL fragment and exchanges it for a session.
router.post('/magic-link/consume', authController.consumeMagicLink);

// Logout is a mutation, so it needs a valid session. Bumping `token_version` on the row
// invalidates every token signed at the old version, which is what a server-side sign-out
// requires -- deleting the local copy alone leaves an intercepted token alive until it expires.
router.post('/logout', requireAuth, authController.logout);

registerMethod(/^\/api\/auth\/register\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/login\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/forgot-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/reset-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/verify-email\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/resend-verification\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/magic-link\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/magic-link\/consume\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/logout\/?$/, ['POST']);

module.exports = router;
