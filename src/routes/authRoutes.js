const express = require('express');
const authController = require('../controllers/authController');
const { rateLimitByIp } = require('../services/security');
const { register: registerMethod } = require('./methodRegistry');

const router = express.Router();

// The previous version counted attempts in a module-level Map. On a serverless host
// that Map is per instance and disappears on every cold start, so it neither limited
// an attacker across instances nor survived a redeploy. These limiters keep the
// counter in the database instead.
const loginLimit = rateLimitByIp({ name: 'login', maxAttempts: 10, windowSeconds: 15 * 60 });
const forgotLimit = rateLimitByIp({ name: 'forgot-password', maxAttempts: 5, windowSeconds: 60 * 60 });
const resetLimit = rateLimitByIp({ name: 'reset-password', maxAttempts: 10, windowSeconds: 60 * 60 });

// Registration was 5 per hour. Because the bucket is keyed on IP, a shared address
// (an office, a university, or a carrier-grade NAT on mobile) exhausted that budget
// across every real user behind it, and the 429 looked like the app was broken.
// Ten per hour still stops automated signup while leaving room for a shared address.
// Raising this also means raising `auth:ip:<address>:register` by hand in the database.
const registerLimit = rateLimitByIp({ name: 'register', maxAttempts: 10, windowSeconds: 60 * 60 });

router.post('/register', registerLimit, authController.register);
router.post('/login', loginLimit, authController.login);
router.post('/forgot-password', forgotLimit, authController.forgotPassword);
router.post('/reset-password', resetLimit, authController.resetPassword);

// Verification. The code check is not behind a per-IP limiter of its own: the code is already
// limited to a handful of guesses by the server-side attempt counter, which is the control
// that has to be unevaditable. An IP limiter in front of it would only push a patient attacker
// onto another address, and would punish a household whose members all mistyped a code.
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);

registerMethod(/^\/api\/auth\/register\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/login\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/forgot-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/reset-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/verify-email\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/resend-verification\/?$/, ['POST']);

module.exports = router;
