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

// Bounds how often an unauthenticated caller can drive a token lookup. It cannot be a
// search -- the token is 32 random bytes -- so this is only here to cap the query rate.
const magicLinkConsumeLimit = rateLimitByIp({ name: 'magic-link-consume', maxAttempts: 10, windowSeconds: 15 * 60 });

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
// entry step for an unconfirmed account. The controller rates sending per address and per
// IP, because that limit has to be spent before the address is looked up -- an IP limiter
// here alone would still let one machine walk a list of addresses.
router.post('/magic-link', authController.sendMagicLink);
// Consumes the token from the URL fragment and exchanges it for a session. Unauthenticated,
// and it reaches the database on every call, so the request rate is bounded even though the
// 32-byte token itself cannot be guessed.
router.post('/magic-link/consume', magicLinkConsumeLimit, authController.consumeMagicLink);

// Logout is a mutation, so it needs a valid session. Bumping `token_version` on the row
// invalidates every token signed at the old version, which is what a server-side sign-out
// requires -- deleting the local copy alone leaves an intercepted token alive until it expires.
router.post('/logout', requireAuth, authController.logout);

// --- Passkeys ----------------------------------------------------------------
//
// Two round trips per operation, because the browser has to run the authenticator in
// between and that is where Face ID, Touch ID, or a Windows Hello prompt happens.
//
// `passkeyAuthenticateOptions` and `passkeyAuthenticateVerify` are deliberately
// unauthenticated. That is the point of a discoverable passkey: the account is resolved from
// the credential *after* the user has proved who they are, rather than being named first and
// then asked to confirm. Requiring a session would mean only somebody already signed in could
// use one, which defeats the purpose.
//
// The two register routes do require a session -- a passkey is attached to an account, so
// somebody has to already be inside that account to add a device to it.
//
// On limiting: the options route is *not* limited, and that is a considered decision rather
// than an oversight. It generates a random challenge and returns it. There is no database
// query on it at all, and the cost is a few hundred bytes of response. It is also called
// automatically on every render of the sign-in page, because the browser has to have the
// challenge in hand before the click -- `navigator.credentials` only works inside a gesture.
//
// A per-IP limit on something a page load triggers is a lockout waiting to happen. The cap is
// spent by the office, the university, the carrier, or the family behind one router, and
// everyone behind it gets a 429 -- which surfaces as a passkey button that does nothing, on a
// device that is working perfectly. A limit that punishes shared addresses is worse than no
// limit at all for a request this cheap.
//
// The verify route *is* limited, and generously. There the work is a signature check and a
// lookup, and an attacker can drive it without a credential. The cap is set high enough that
// nobody reaches it by failing Face ID a few times, which is the point: it exists to bound
// deliberate flooding, not to throttle a person having a bad day with their passcode.
const passkeyAuthLimit = rateLimitByIp({ name: 'passkey-authenticate', maxAttempts: 100, windowSeconds: 15 * 60 });

router.post('/passkeys/register/options', requireAuth, authController.passkeyRegisterOptions);
router.post('/passkeys/register/verify', requireAuth, authController.passkeyRegisterVerify);
router.post('/passkeys/authenticate/options', authController.passkeyAuthenticateOptions);
router.post('/passkeys/authenticate/verify', passkeyAuthLimit, authController.passkeyAuthenticateVerify);
router.get('/passkeys', requireAuth, authController.passkeyList);
router.delete('/passkeys/:credentialId', requireAuth, authController.passkeyDelete);

registerMethod(/^\/api\/auth\/register\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/login\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/forgot-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/reset-password\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/verify-email\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/resend-verification\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/magic-link\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/magic-link\/consume\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/logout\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/passkeys\/register\/options\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/passkeys\/register\/verify\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/passkeys\/authenticate\/options\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/passkeys\/authenticate\/verify\/?$/, ['POST']);
registerMethod(/^\/api\/auth\/passkeys\/?$/, ['GET']);
registerMethod(/^\/api\/auth\/passkeys\/[^/]+\/?$/, ['DELETE']);

module.exports = router;
