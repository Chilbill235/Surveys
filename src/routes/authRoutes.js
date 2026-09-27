const express = require('express');
const authController = require('../controllers/authController');
const { rateLimitByIp } = require('../services/security');

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

module.exports = router;
