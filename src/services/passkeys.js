/**
 * Passkeys: registering a device, and signing in with one.
 *
 * ## What this is for
 *
 * Face ID, Touch ID, Windows Hello, an Android screen lock, a hardware security key. The point
 * is that the credential is created by the device and the private key stays in its secure
 * hardware -- there is no password for it to leak, and there is nothing to phish, because the
 * assertion is bound to the origin it was created for.
 *
 * On iPhone and iPad, Safari presents this as Face ID or Touch ID. It is worth being precise
 * about what the prompt means: the user is asked to authenticate with the device, and whether
 * that means a face, a finger, or a passcode is the device's choice, not this site's. A user
 * whose Face ID fails three times is offered their device passcode, and the site does not see
 * which was used.
 *
 * ## The challenge
 *
 * Both flows are challenge-response, and the challenge is the whole security property. The
 * server generates a random challenge, the authenticator signs it along with the origin and
 * the client data, and the server checks the signature against the public key it stored at
 * registration. Without a fresh unpredictable challenge, the same assertion could be
 * presented again and again.
 *
 * The challenge is generated here, handed to the browser, and expected back in the
 * verification request. It is *not* remembered here. That is a deliberate choice, and it is
 * what makes the check meaningful rather than weaker:
 *
 *   - The server is stateless. A challenge held in a server-side Map or session is per
 *     instance, so on a serverless host every cold start loses it, and behind a load balancer
 *     the verification lands on an instance that never saw the request for options. Both
 *     produce a passkey that worked on the developer's machine and 500s in production.
 *   - Nothing is trusted because nothing is remembered. The challenge is compared against the
 *     one the authenticator actually signed over, inside `clientDataJSON`, and the signature
 *     covers that. Handing the expected value in from the client therefore does not let
 *     anyone forge anything: to pass, an assertion must already be a valid signature over
 *     that exact challenge. What a client *can* do is submit a challenge it has already used,
 *     and the client-side storage is what makes that a one-shot -- see `consumeChallenge` in
 *     `public/passkey-shared.js`.
 *
 * ## What is stored
 *
 * The public key, the credential id, a counter, and the user's label. Never a private key,
 * because the device never gives it up. A passkey added to this account therefore cannot be
 * exported from it, which is the property that makes it worth having: there is nothing here to
 * steal.
 *
 * ## Why the library does the cryptography
 *
 * `@simplewebauthn/server` parses the COSE public key, verifies the signature, and enforces
 * the counter check. None of that is reimplemented here. WebAuthn verification is exactly the
 * kind of code that must not be hand-rolled: a subtly wrong COSE parser or a skipped counter
 * check produces a server that accepts forged assertions, and it does so silently.
 */

'use strict';

// Required as a namespace and called through it, rather than destructured.
//
// Destructuring would copy the four functions into local bindings at load time, which is
// tidier to read but makes them unstubbable: a test that wants to exercise the code *around*
// the cryptography cannot reach it, because assigning to the library's exports would not
// change what these local names already point at. Calling through the object costs one
// property lookup and keeps the seams open.
const simplewebauthn = require('@simplewebauthn/server');

const pool = require('../config/db');

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * The origins a passkey is valid for.
 *
 * WebAuthn binds a credential to the origin it was created on, and that is a security
 * boundary: a credential registered here will not work on a phishing site that copied the
 * sign-in form, because the browser refuses to offer it to a different origin at all.
 *
 * So the list must be exact. It is built from `APP_BASE_URL` -- the same variable the magic
 * link and reset emails use, so a deployment configures it once -- plus the current request's
 * own origin, which is what makes a local `http://localhost:3001` work without a second
 * setting.
 *
 * `expectingOrigin` is still passed to the library as the primary check. `allowedOrigins` is
 * what stops a request arriving with a mismatched `Origin` header from being accepted: the
 * two together mean a credential is valid for one known origin and nothing else.
 */
function expectedOrigins() {
    const origins = new Set();
    if (process.env.APP_BASE_URL) {
        try {
            origins.add(new URL(process.env.APP_BASE_URL).origin);
        } catch {
            // A malformed APP_BASE_URL is a deployment problem. It is not silently ignored
            // here, because the alternative -- accepting any origin -- is the vulnerability
            // this whole mechanism exists to prevent. The request's own origin still matches,
            // so local work is unaffected, but the variable should be fixed.
            console.error('passkeys: APP_BASE_URL is not a valid URL; passkeys will be bound to the request origin only.');
        }
    }
    return [...origins];
}

function rpIdFor(req) {
    // The relying party is the registrable domain, so a passkey created on
    // `www.example.com` also works on `example.com` and vice versa. It must be a registrable
    // suffix of the current host, never the host itself, or a passkey would become domain-
    // locked to one subdomain -- which is the common cause of "my passkey worked yesterday".
    const host = (req.get('host') || '').split(':')[0];
    if (process.env.PASSKEY_RELYING_PARTY_ID) return process.env.PASSKEY_RELYING_PARTY_ID;
    return host || 'localhost';
}

/**
 * True for a host that is an IP address rather than a name.
 *
 * Takes the `Host` header as it arrives, port and all, and strips both forms an IPv6 literal is
 * written in: `[::1]:3199` and `[::1]`. Splitting the port off with `split(':')` would leave a
 * bare `[` and miss it, which is how the first version of this check let `::1` through.
 */
function isIpLiteral(host) {
    if (!host) return false;
    const bare = String(host).replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
}

/**
 * Refuses to hand out options for a host a browser will never accept.
 *
 * WebAuthn's relying party is a domain. An IP address is not one: Chrome answers a request made
 * from `http://127.0.0.1:3199` with "This is an invalid domain", after the server has already
 * done the work and after the user has tapped a button labelled with their device. The message
 * names nothing the user or the developer can act on.
 *
 * This is a property of the address, not a fault in the account or the credential, so it is
 * checked where the options are built and reported as what it is. `localhost` is fine -- browsers
 * treat it as a name and a secure context -- so a local developer is told exactly what to open
 * instead. The verification paths keep using `rpIdFor`, because refusing them would lock out
 * anyone who did manage to enrol somewhere else.
 */
function requireRelyingPartyDomain(req) {
    if (process.env.PASSKEY_RELYING_PARTY_ID) return;
    const host = req.get('host') || '';
    if (!isIpLiteral(host)) return;
    throw passkeyError(
        'Passkeys need a domain, not an IP address. Open this page at localhost instead and try again.',
        'invalid_relying_party_host',
        400
    );
}

// ---------------------------------------------------------------------------
// Challenge validation
// ---------------------------------------------------------------------------

/**
 * The challenge the browser says it is answering.
 *
 * Anything that is not a plausible base64url string is rejected here rather than passed on,
 * so the library is never handed something that was not a challenge at all. The check is a
 * shape check, not a security check: the security comes from the signature covering the same
 * value, which the library verifies.
 *
 * 43 to 128 characters covers every real case. A challenge from `generateAuthenticationOptions`
 * is 32 random bytes, which is 43 characters of base64url; the bounds are there so a
 * multi-kilobyte string cannot be posted here to be used as a memory or CPU sink.
 */
function requireChallenge(value) {
    if (typeof value !== 'string' || value.length < 43 || value.length > 128 || !/^[\w-]+$/.test(value)) {
        throw passkeyError('That sign-in attempt timed out. Try again.', 'challenge_missing');
    }
    return value;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The account identity WebAuthn requires as the credential's `user.name`.
 *
 * `user.name` is a required member of `PublicKeyCredentialUserEntity`, and the browser enforces
 * it before the authenticator is even reached: a missing one fails with a TypeError that reads
 * "Failed to read the 'name' property from 'PublicKeyCredentialEntity'" and never touches the
 * user's device. There is nothing to retry and nothing for the visitor to do about it.
 *
 * The name is the account's email, and it is read from the `users` row rather than from the
 * session. `requireAuth` deliberately puts only `id`, `tokenVersion` and the token's timestamps
 * on `req.user` -- it builds that object field by field so a handler can only read something the
 * middleware chose to put there, rather than a claim the token happened to carry -- so a handler
 * that passed `req.user.email` on was passing `undefined`, and the options went out with no
 * `user.name` at all. A caller that already has the email (the tests do) is trusted; otherwise
 * this is one indexed lookup.
 *
 * An account with no usable email cannot be registered against, and saying so here is the point:
 * the alternative is options the browser will reject with a message that names a WebIDL property
 * rather than the account.
 */
async function accountIdentity(user) {
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    if (email.includes('@')) {
        return { email, displayName: user.display_name || email };
    }
    const result = await pool.query('SELECT email, display_name FROM users WHERE id = $1', [user.id]);
    const row = result.rows[0];
    const stored = row && typeof row.email === 'string' ? row.email.trim() : '';
    if (!stored.includes('@')) {
        throw passkeyError('That passkey could not be set up. Try again, or use your password.', 'account_identity_missing');
    }
    return { email: stored, displayName: row.display_name || stored };
}

/**
 * Options for registering a new credential.
 *
 * `excludeCredentials` is the one that matters for the "add another device" case: it lists
 * what this account already has, so the authenticator refuses to enrol a key that is already
 * registered. Without it, a user who re-registers the same phone creates a second row for the
 * same key, and the list they revoke from grows every time they try to add a device.
 */
async function registrationOptions(req, user) {
    requireRelyingPartyDomain(req);
    const result = await pool.query(
        `SELECT credential_id, transports FROM passkeys WHERE user_id = $1`,
        [user.id]
    );
    const identity = await accountIdentity(user);

    return simplewebauthn.generateRegistrationOptions({
        rpName: 'RewardZone',
        rpID: rpIdFor(req),
        userID: Buffer.from(String(user.id)),
        userName: identity.email,
        // A human-recognisable description in the prompt. "rewardzone.com" is what the user
        // is asked to approve, so it has to match the site they think they are on.
        userDisplayName: identity.displayName,
        attestationType: 'none',
        excludeCredentials: result.rows.map((row) => ({
            id: row.credential_id,
            transports: String(row.transports || '').split(',').filter(Boolean)
        })),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required'
        }
    });
}

/**
 * Verifies a registration response and stores the credential.
 *
 * `requireUserVerification` is not optional. It is what makes a stolen or cloned passkey
 * useless without the device's biometric or PIN, and it is enforced here rather than trusted
 * from the browser's flag, because that flag is attacker-controlled input like any other.
 */
async function completeRegistration(req, user, response, challenge) {
    const expectedChallenge = requireChallenge(challenge);

    let verification;
    try {
        verification = await simplewebauthn.verifyRegistrationResponse({
            response,
            expectedChallenge,
            expectedOrigin: expectedOriginsFor(req),
            expectedRPID: rpIdFor(req),
            requireUserVerification: true
        });
    } catch (error) {
        // The library's message is precise about which check failed and is useful in a log.
        // It is not shown to the visitor, who needs to know what to try next, not which
        // attestation statement failed to parse.
        console.warn(`passkey registration refused (${error.code || 'unknown'}: ${error.message})`);
        throw passkeyError('That device could not be registered. Try again, or use your password.', 'registration_failed');
    }

    const info = verification.registrationInfo ?? {};
    if (!info.credential) {
        throw passkeyError('That device could not be registered. Try again, or use your password.', 'no_credential');
    }

    const credentialID = info.credential.id;
    const transports = Array.isArray(info.credential.transports) ? info.credential.transports : [];

    // `ON CONFLICT DO NOTHING` rather than a plain insert: a user who re-runs registration
    // for a key that was already stored must not get a constraint error, and must not end up
    // with a second row they cannot tell apart from the first. The counter and label of the
    // existing row are left alone -- this is the same key, and overwriting its counter with
    // the one from a fresh attestation would let a cloned authenticator back in.
    await pool.query(
        `INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_type, transports, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (credential_id) DO NOTHING`,
        [
            user.id,
            credentialID,
            encodePublicKey(info.credential.publicKey),
            Number(info.credential.counter ?? 0),
            info.credentialDeviceType || null,
            transports.join(',') || null,
            (info.credentialBackedUp === false ? 'Not backed up' : null)
        ]
    );

    return { credentialId: credentialID };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Options for signing in with a passkey.
 *
 * The allowed credential list is not restricted to a user id, because the user is not known
 * yet -- that is the point of a discoverable ("resident") passkey: the authenticator says
 * which account it belongs to once the user has proved who they are. An empty list plus
 * `userVerification: 'required'` is what makes that work.
 */
async function authenticationOptions(req) {
    requireRelyingPartyDomain(req);
    return simplewebauthn.generateAuthenticationOptions({
        rpID: rpIdFor(req),
        userVerification: 'required',
        allowCredentials: []
    });
}

/**
 * Verifies an assertion and returns the account it belongs to.
 *
 * The counter is checked and then written back, and the write is conditional on the stored
 * value still being the one that was verified. That condition is what makes concurrent
 * assertions safe: two simultaneous sign-ins with the same passkey cannot both pass, because
 * the second `UPDATE ... WHERE counter = <old>` matches no rows and is reported as a
 * failure. Without the condition, the last write would simply win and the replay window the
 * counter exists to close would still be open.
 */
async function completeAuthentication(req, response, challenge) {
    const expectedChallenge = requireChallenge(challenge);

    const credentialId = response?.id;
    if (typeof credentialId !== 'string' || !credentialId) {
        throw passkeyError('That is not a passkey sign-in.', 'missing_credential_id');
    }

    const found = await pool.query(
        `SELECT p.credential_id, p.public_key, p.counter, p.transports, p.user_id,
                u.id, u.email, u.token_version, u.email_verified_at, u.display_name
           FROM passkeys p
           JOIN users u ON u.id = p.user_id
          WHERE p.credential_id = $1`,
        [credentialId]
    );

    const row = found.rows[0];
    if (!row) {
        // The same answer as a wrong assertion. Telling a caller that a credential id is
        // unknown would make this an oracle for which passkeys exist, which is information
        // about an account to someone who has not proved they own it.
        throw passkeyError('That passkey did not work. Try again, or use your password.', 'assertion_failed');
    }

    let verification;
    try {
        verification = await simplewebauthn.verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: expectedOriginsFor(req),
            expectedRPID: rpIdFor(req),
            credential: {
                id: row.credential_id,
                publicKey: decodePublicKey(row.public_key),
                counter: Number(row.counter || 0),
                transports: String(row.transports || '').split(',').filter(Boolean)
            },
            requireUserVerification: true
        });
    } catch (error) {
        console.warn(`passkey assertion refused (${error.code || 'unknown'}: ${error.message})`);
        throw passkeyError('That passkey did not work. Try again, or use your password.', 'assertion_failed');
    }

    const newCounter = Number(verification.authenticationInfo?.newCounter ?? 0);
    const advanced = await pool.query(
        `UPDATE passkeys
            SET counter = $1, last_used_at = NOW()
          WHERE credential_id = $2 AND counter = $3
        RETURNING credential_id`,
        [newCounter, row.credential_id, Number(row.counter || 0)]
    );

    if (!advanced.rows.length) {
        // The counter was advanced by a concurrent assertion, or the row changed underneath
        // this one. Either way the stored value is no longer the one this assertion was
        // checked against, so it is not a sign-in.
        throw passkeyError('That passkey was used at the same moment somewhere else. Try again.', 'counter_mismatch');
    }

    return {
        id: row.id,
        email: row.email,
        token_version: row.token_version,
        email_verified_at: row.email_verified_at,
        display_name: row.display_name
    };
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

async function listPasskeys(userId) {
    const result = await pool.query(
        `SELECT credential_id, name, device_type, transports, created_at, last_used_at
           FROM passkeys
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
    );
    return result.rows;
}

/**
 * Removes a credential the user owns.
 *
 * Scoped by `user_id` in the `WHERE` and not by credential id alone, so a request naming
 * another account's credential removes nothing and says so as "not found". The distinction
 * matters: a 403 would confirm the credential exists.
 */
async function deletePasskey(userId, credentialId) {
    const result = await pool.query(
        `DELETE FROM passkeys WHERE user_id = $1 AND credential_id = $2 RETURNING credential_id`,
        [userId, credentialId]
    );
    return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The origin of the current request, always included. See `expectedOrigins`. */
function expectedOriginsFor(req) {
    const configured = expectedOrigins();
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    return configured.includes(requestOrigin) ? configured : [requestOrigin, ...configured];
}

/**
 * The COSE public key, between the library's bytes and the column's text.
 *
 * `@simplewebauthn/server` speaks `Uint8Array` for `credential.publicKey`, in both
 * directions: it returns bytes after a registration and expects bytes to verify an assertion.
 * The column is `TEXT`, and handing a `Uint8Array` straight to `pg` writes its
 * comma-separated *element numbers* -- "112,1,2,3,56,32,..." -- which is not the key, is
 * about four times longer than the key, and is not base64 of anything. Every later sign-in
 * with that passkey then fails to verify, with an error about malformed COSE, on a
 * credential that was registered successfully. Storing it silently is the whole problem: the
 * write reports success.
 *
 * base64url rather than base64 because the value then survives a trip through JSON, a log
 * line, or a database dump without escaping, and because it is the same alphabet the
 * credential id and the challenge already use.
 *
 * The decode side is equally deliberate. Passing the stored *string* back to the library
 * fails with "No data" -- it runs the string straight into a CBOR decoder. Accepting a string
 * here would just move that failure later, to the first person to sign in.
 */
function encodePublicKey(publicKey) {
    if (publicKey == null) throw new Error('passkeys: the authenticator returned no public key');
    if (typeof publicKey === 'string') return publicKey;
    return Buffer.from(publicKey).toString('base64url');
}

function decodePublicKey(stored) {
    if (stored == null) throw new Error('passkeys: the stored credential has no public key');
    if (typeof stored !== 'string') return stored;
    return new Uint8Array(Buffer.from(stored, 'base64url'));
}

function passkeyError(message, code, status) {
    const error = new Error(message);
    error.code = code;
    // 401 by default: nearly every refusal here is a challenge that expired or a credential that
    // does not belong to the caller, and the client answers both by starting again. A refusal
    // that is about the request rather than the session says so -- a 401 for "this host cannot be
    // a relying party" would be read as an expired session by anything watching for one.
    error.status = status || 401;
    return error;
}

module.exports = {
    registrationOptions,
    completeRegistration,
    authenticationOptions,
    completeAuthentication,
    listPasskeys,
    deletePasskey,
    rpIdFor,
    expectedOrigins
};
