/**
 * Shared passkey plumbing: base64url conversion, the fetch wrappers, and error classification.
 *
 * This is its own file rather than part of `passkeys.js` because both the sign-in page and the
 * account page need these helpers and neither has the other's markup. Keeping them in the
 * sign-in file would force the account page to load a sign-in entry point it does not have --
 * and, worse, would couple the two pages so that renaming a button on one silently disabled
 * the other.
 *
 * Nothing here touches the DOM, so it is safe to load anywhere.
 */

'use strict';

window.RewardZonePasskeys = (function () {
    const CHALLENGE_KEY = 'rewardZonePasskeyChallenge';
    const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

    /**
     * Remembers the challenge for an operation, and when it was issued.
     *
     * The challenge lives here, in the browser, rather than on the server. Two reasons, and
     * the second is the important one:
     *
     *   - A challenge held in a server-side Map is per instance. On a serverless host every
     *     cold start loses it, and behind a load balancer the verification lands on an
     *     instance that never saw the request for options. Both produce a passkey that worked
     *     on the developer's machine and fails in production.
     *   - Nothing is trusted because nothing is remembered. The expected challenge is compared
     *     against the one the authenticator actually signed over, inside `clientDataJSON`, and
     *     the signature covers it. Handing the expected value in from the client therefore
     *     does not let anyone forge anything -- to pass, an assertion must already be a valid
     *     signature over that exact challenge.
     *
     * One slot, not one per operation, and that is deliberate. Registering and signing in are
     * both things a person does on one device at a time, and a second slot would let a stale
     * registration challenge still be sitting there when someone presses "sign in with a
     * passkey" -- at which point the assertion is signed over the wrong challenge and the
     * flow fails with an error nobody can act on.
     *
     * `sessionStorage` rather than anything persistent, so it dies with the tab and two
     * parallel attempts cannot read each other's value.
     *
     * @throws when the browser is blocking storage. A passkey flow cannot proceed without
     * somewhere to keep the challenge, and continuing without one would mean sending an
     * assertion the server will reject for no reason the user can see.
     */
    function rememberChallenge(kind, challenge) {
        try {
            sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify({ kind, value: challenge, at: Date.now() }));
        } catch {
            throw new Error('This browser is blocking site storage, which passkeys need.');
        }
    }

    /**
     * Reads the stored challenge for an operation and clears it.
     *
     * Cleared on read whatever happens next, and expired after five minutes. An assertion is
     * only ever expected within seconds of being asked for; a challenge that outlives its
     * window is one that could be presented again, and burning it costs a single tap.
     *
     * The `kind` check is what stops a registration challenge being spent on a sign-in, or the
     * other way round. Neither can forge anything -- both are checked against a signature --
     * but mixing them produces a failure that looks like a broken device.
     *
     * @returns the challenge, or `null` when there is nothing usable to answer.
     */
    function consumeChallenge(kind) {
        let raw = null;
        try {
            raw = sessionStorage.getItem(CHALLENGE_KEY);
            sessionStorage.removeItem(CHALLENGE_KEY);
        } catch {
            return null;
        }
        if (!raw) return null;
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!parsed || parsed.kind !== kind || typeof parsed.value !== 'string') return null;
        if (Date.now() - Number(parsed.at || 0) > CHALLENGE_LIFETIME_MS) return null;
        return parsed.value;
    }

    /** Whether a usable challenge is already in hand, for a flow that is about to be clicked. */
    function hasChallenge(kind) {
        let raw = null;
        try {
            raw = sessionStorage.getItem(CHALLENGE_KEY);
        } catch {
            return false;
        }
        if (!raw) return false;
        try {
            const parsed = JSON.parse(raw);
            return parsed?.kind === kind && Date.now() - Number(parsed?.at || 0) <= CHALLENGE_LIFETIME_MS;
        } catch {
            return false;
        }
    }

    /**
     * Base64url string -> ArrayBuffer.
     *
     * WebAuthn's `challenge`, `credential.id`, and `user.id` are all binary in the wire format
     * but arrive as base64url in JSON, because JSON has no byte type. `-` and `_` have to be
     * mapped back to `+` and `/`, and the length has to be re-padded to a multiple of four --
     * base64url is unpadded by definition, and `atob` is not.
     */
    function base64urlToBuffer(value) {
        const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    /** ArrayBuffer -> base64url string. The inverse, and the reason `atob` needs padding above. */
    function bufferToBase64url(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // The session slot. `app.js` names the same string in `accountTokenKey`, and
    // `check-frontend.js` fails the build if the two drift apart -- they have to be one
    // value, and the check exists because they were not: this file and `app.js` each kept
    // their own copy of "where the token lives" and disagreed.
    const SESSION_TOKEN_KEY = 'offerNetworkSessionToken';
    const SESSION_EMAIL_KEY = 'offerNetworkAccountEmail';

    // Where `passkeys.js` used to put the token after a passkey sign-in. See `migrateLegacyToken`.
    const LEGACY_TOKEN_KEY = 'rz_token';

    /**
     * Whether `value` is shaped like a JWT: three non-empty base64url segments.
     *
     * The same test `app.js` applies on the way in and on the way out, restated rather than
     * imported because this file is deliberately DOM-free and shared with the sign-in page,
     * where it has to stand on its own. It filters garbage; it is not a security boundary.
     * Whether a token is genuine is decided by its signature, on the server.
     */
    function isJwtShaped(value) {
        if (typeof value !== 'string' || value.length < 20) return false;
        const parts = value.split('.');
        if (parts.length !== 3) return false;
        return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
    }

    /**
     * Moves a token written by the old build into the session slot the app actually reads.
     *
     * `passkeys.js` stored a successful passkey sign-in in `localStorage` under `rz_token`,
     * and `authHeaders()` read it back from there. Both halves agreed with each other and
     * neither agreed with `app.js`, which stores and reads `sessionStorage`, so a passkey
     * sign-in left the visitor holding a valid token that the rest of the site could not
     * see -- every page treated them as signed out -- while a password sign-in left
     * `authHeaders()` returning no token at all, which is why the Passkeys card on the
     * account page never appeared and why adding or removing a passkey 401'd.
     *
     * `localStorage` also outlives the tab, so that token stayed on disk after the visitor
     * closed the browser, which is the opposite of what the session slot is for. Moving it
     * fixes both at once. The old value is removed afterwards: leaving it behind would keep
     * a copy alive that no code reads, which is worse than useless to anyone auditing the
     * origin's storage.
     *
     * Best-effort and silent. A browser with storage disabled is not signed in, which is the
     * correct answer rather than a reason to throw.
     */
    let legacyChecked = false;

    function migrateLegacyToken() {
        // Once per page load. `authHeaders()` runs per request, and re-reading and re-removing
        // a key on every call would put two storage round trips in the path of every passkey
        // request for a migration that can only ever find something the first time.
        if (legacyChecked) return;
        legacyChecked = true;
        let legacy = null;
        try {
            legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
        } catch {
            return;
        }
        if (!isJwtShaped(legacy)) {
            try {
                localStorage.removeItem(LEGACY_TOKEN_KEY);
            } catch {
                /* Nothing to clean up if storage is unavailable. */
            }
            return;
        }
        try {
            if (!sessionStorage.getItem(SESSION_TOKEN_KEY)) {
                sessionStorage.setItem(SESSION_TOKEN_KEY, legacy);
            }
            localStorage.removeItem(LEGACY_TOKEN_KEY);
        } catch {
            /* Storage unavailable: not being signed in is the right answer. */
        }
    }

    /** The current session token, or null. The one place in this file that reads storage. */
    function readSessionToken() {
        migrateLegacyToken();
        try {
            const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
            return isJwtShaped(token) ? token : null;
        } catch {
            return null;
        }
    }

    /**
     * Stores a session returned by a passkey sign-in.
     *
     * Checked the same way as everywhere else: a response that is not a token is a failed
     * sign-in, so nothing is written and whatever was there is cleared. `setItem` does not
     * complain about `undefined` -- it stores the string -- and a slot holding the word
     * "undefined" is a page that believes it is signed in and sends a bearer value the server
     * rejects on every request.
     */
    function storeSession(data) {
        const token = data && data.token;
        if (!isJwtShaped(token)) {
            try {
                sessionStorage.removeItem(SESSION_TOKEN_KEY);
                sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch {
                /* Storage unavailable; there is nothing to clear and nothing was written. */
            }
            return false;
        }
        try {
            sessionStorage.setItem(SESSION_TOKEN_KEY, token);
            if (data.user?.email) sessionStorage.setItem(SESSION_EMAIL_KEY, data.user.email);
            localStorage.removeItem(LEGACY_TOKEN_KEY);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * The `Authorization` header, or nothing.
     *
     * Same rule as everywhere else in this codebase: a missing token produces no header at
     * all, not `Bearer null`. The version that sent the header unconditionally filled the
     * server log with 401s that meant nothing.
     */
    function authHeaders() {
        const token = readSessionToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    /**
     * Parses a response as JSON, tolerating an empty or non-JSON body.
     *
     * A 502 from a proxy in front of the app arrives as HTML, and `response.json()` rejecting
     * on it turns a readable "the service is having trouble" into an unhandled rejection with
     * no message at all.
     */
    async function readJson(response) {
        try {
            return await response.json();
        } catch {
            return {};
        }
    }

    /**
     * True for the outcomes that are unambiguously the user's decision rather than a fault.
     *
     * Only `AbortError` qualifies. `NotAllowedError` used to be here too, and that was the
     * bug: it is the spec's catch-all for *every* abort path, so treating all of them as a
     * deliberate cancellation also swallowed the one case the user cannot act on by ignoring
     * it. On an iPhone with no Face ID enrolled, no passcode set, or the page open in an
     * in-app browser, `navigator.credentials.create()` throws `NotAllowedError` and the sheet
     * never appears -- and the caller, having been told this was a cancellation, said nothing
     * at all. The user pressed a button and got no sheet and no message, which is the exact
     * report that "Face ID is not working". The specific `NotAllowedError` branch in
     * `account-passkeys.js` that explains this was unreachable dead code.
     *
     * A genuine dismissal is still silent: the caller distinguishes the two by having already
     * asked the device whether a verifying platform authenticator exists, which is what
     * separates "you have nothing set up" from "you said no".
     */
    function isCancellation(error) {
        if (!error) return false;
        return error.name === 'AbortError';
    }

    /**
     * Whether the device reports a verifying platform authenticator -- Face ID, Touch ID,
     * Windows Hello, an Android screen lock.
     *
     * The capability probe, cached, because it is what distinguishes a silent `NotAllowedError`
     * (nothing set up on this device) from a real cancellation (the sheet was dismissed).
     * Only the former should be explained, so a person who deliberately backs out of a Face ID
     * prompt is not told to go and enable Face ID.
     *
     * A missing API or a browser that throws on it is reported as `null` -- unknown -- rather
     * than `false`. "Cannot tell" must not be turned into "this device cannot do it", which is
     * the conclusion the notice would otherwise draw on older Safari.
     */
    let platformAuthenticatorProbe = null;

    async function hasPlatformAuthenticator() {
        if (platformAuthenticatorProbe !== null) return platformAuthenticatorProbe;
        if (typeof PublicKeyCredential === 'undefined'
            || typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
            platformAuthenticatorProbe = null;
            return platformAuthenticatorProbe;
        }
        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            platformAuthenticatorProbe = available === true;
        } catch {
            platformAuthenticatorProbe = null;
        }
        return platformAuthenticatorProbe;
    }

    /**
     * How to phrase a `NotAllowedError` for someone on this device.
     *
     * The error carries no information -- it is the same exception for a dismissed sheet, an
     * un-enrolled Face ID and an in-app browser with no access to the biometric prompt -- so
     * the wording is chosen from the device rather than read out of the error. Returns null
     * when there is genuinely nothing to say, which is the dismissal case: the user knows
     * exactly what they did, and telling them to go and set up Face ID they already declined
     * is worse than saying nothing.
     *
     * The in-app case is checked first because it is the only one where the fix is a different
     * browser rather than a different Settings app, and getting it wrong sends someone into
     * Face ID settings that are already correct.
     */
    function notAllowedAdvice(error, platformAvailable) {
        const ua = navigator.userAgent || '';
        const embedded = embeddedBrowserPattern.test(ua);

        if (embedded) {
            return 'Your app does not let this page use Face ID. Open this site in Safari, Chrome or Firefox and try again.';
        }
        if (platformAvailable === false) {
            const isAppleMobile = /iPhone|iPad|iPod/i.test(ua)
                || (/Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
            if (isAppleMobile) {
                return 'This device has no Face ID or passcode set up, so there is nothing for the passkey to use. '
                    + 'Open Settings, then Face ID & Passcode, set it up, and try again.';
            }
            if (/Android/i.test(ua)) {
                return 'This phone has no screen lock set up, so there is nothing for the passkey to use. '
                    + 'Open Settings, then Security, set a screen lock, and try again.';
            }
            return 'This device has no screen lock or biometric set up, so there is nothing for the passkey to use. '
                + 'Set one up in your device settings and try again.';
        }
        // `null` means the platform could not be asked, so a dismissal cannot be ruled out and
        // the honest response is silence rather than a guess.
        return null;
    }

    /**
     * User agents for browsers that host a page inside another app.
     *
     * These are the ones that actually withhold the biometric prompt: an in-app web view has
     * no access to the platform authenticator at all, so WebAuthn either throws or returns a
     * credential that cannot be verified. The original three (Facebook, Instagram, WeChat)
     * caught the common cases but not the ones users actually hit -- Telegram, Discord, Slack
     * and every mail client open links this way, and each of them produced a bare
     * `NotAllowedError` that the app was swallowing.
     *
     * Matched against the whole UA string, and the tokens are deliberately specific. A bare
     * `wv` or `WebView` would also match desktop Chrome's compatibility tokens and misdiagnose
     * a working desktop browser as broken.
     */
    const embeddedBrowserPattern = /FBAN|FBAV|Instagram|LinkedInApp|MicroMessenger|QQ\/|Snapchat|Telegram|Discord|Slack|Line\/|KAKAOTALK|Signal|Gmail|Outlook|Mail\/|Teams|WhatsApp|; wv\)|Version\/[\d.]+ wv\)/i;

    /**
     * Turns a `PublicKeyCredential` from an assertion into the JSON the server expects.
     *
     * `clientExtensionResults` is forwarded verbatim rather than filtered. The server ignores
     * extensions it does not recognise, and passing the whole object means a new browser
     * extension is visible server-side without a matching change here.
     */
    function serialiseAssertion(credential) {
        return {
            id: credential.id,
            rawId: bufferToBase64url(credential.rawId),
            type: credential.type,
            response: {
                clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
                authenticatorData: bufferToBase64url(credential.response.authenticatorData),
                signature: bufferToBase64url(credential.response.signature),
                userHandle: credential.response.userHandle
                    ? bufferToBase64url(credential.response.userHandle)
                    : null
            },
            clientExtensionResults: credential.getClientExtensionResults
                ? credential.getClientExtensionResults()
                : {}
        };
    }

    return {
        base64urlToBuffer,
        bufferToBase64url,
        authHeaders,
        readSessionToken,
        storeSession,
        readJson,
        isCancellation,
        hasPlatformAuthenticator,
        notAllowedAdvice,
        embeddedBrowserPattern,
        serialiseAssertion,
        rememberChallenge,
        consumeChallenge,
        hasChallenge
    };
})();
