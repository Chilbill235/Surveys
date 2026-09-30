/**
 * Passkey sign-in, on the login page.
 *
 * ## The shape of it
 *
 * `navigator.credentials` only works inside a user gesture, so every call into it has to sit
 * directly in a click handler with no `await` in front of it. That single constraint explains
 * the structure of this file: the server's challenge is fetched *before* the button is clicked,
 * and `navigator.credentials.get()` happens synchronously inside the handler. Fetching the
 * challenge on click instead would mean awaiting something first, and by the time it resolved
 * the gesture would be gone and the browser would refuse the call.
 *
 * So:
 *
 *   1. On load, ask the server for options.
 *   2. On click, hand them straight to `navigator.credentials.get()`.
 *   3. Post the result; the server checks the signature and issues a session.
 *
 * Step 1 is not an optimisation. It is what makes the flow legal in the browser.
 *
 * ## What the user sees
 *
 * On an iPhone this is a Face ID prompt, on Android a fingerprint or face unlock, on Windows
 * Hello, and on a desktop with a USB key a prompt to touch it. The site is not choosing: it
 * asked for user verification and the device decides how to satisfy it.
 *
 * Cancelling is not an error. Someone who dismisses the sheet still has a password form above
 * the button, and the right thing to do is leave it exactly as it is.
 *
 * The base64url helpers and the fetch wrappers come from `passkey-shared.js`.
 */

'use strict';

(function () {
    const shared = window.RewardZonePasskeys;
    if (!shared) return;

    const API = '/api/auth/passkeys';

    const entry = document.getElementById('passkey-entry');
    const button = document.getElementById('passkey-signin');
    // The label is a child span rather than the button's own text, so the "waiting..." state
    // can be swapped without destroying the glyph. Assigning `textContent` on the button
    // would replace all its children, and the icon would not come back on reset.
    const buttonLabel = document.getElementById('passkey-signin-label');
    const note = document.getElementById('passkey-note');
    const message = document.getElementById('account-message');

    if (!entry || !button) return;

    function report(text) {
        if (!message) return;
        message.textContent = text;
        message.classList.remove('is-error');
    }

    function fail(text) {
        if (!message) return;
        message.textContent = text;
        message.classList.add('is-error');
    }

    /** Prefetched options, so the credential call can happen inside the click handler. */
    let cachedOptions = null;

    async function prefetchOptions() {
        if (cachedOptions) return cachedOptions;
        const response = await fetch(`${API}/authenticate/options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error('unavailable');
        const options = await response.json();
        // Kept in web storage, not just in this closure. The click handler has to reach the
        // same challenge, and it runs after a page navigation has had every chance to clear a
        // closure that only lived on the page that fetched it.
        shared.rememberChallenge('authenticate', options.challenge);
        cachedOptions = options;
        return options;
    }

    async function signInWithPasskey() {
        button.disabled = true;
        const original = buttonLabel ? buttonLabel.textContent : 'Sign in with a passkey';
        if (buttonLabel) buttonLabel.textContent = 'Waiting for your device...';

        try {
            const options = await prefetchOptions();
            const request = {
                challenge: shared.base64urlToBuffer(options.challenge),
                timeout: options.timeout,
                rpId: options.rpId,
                // 'required', not 'preferred'. A passkey that does not verify the user is a
                // private key anyone holding the device can use, which is a downgrade from the
                // password it is meant to replace. The server enforces this too.
                userVerification: 'required',
                allowCredentials: (options.allowCredentials || []).map((item) => ({
                    id: shared.base64urlToBuffer(item.id),
                    type: 'public-key',
                    transports: item.transports || []
                }))
            };

            // Synchronous from here to the end of the gesture: no `await` before this call.
            const credential = await navigator.credentials.get({ publicKey: request });
            if (!credential) throw new Error('no-credential');

            // Spent whether or not the assertion verifies, so a second click gets a fresh
            // challenge rather than replaying one the server has already seen.
            const challenge = shared.consumeChallenge('authenticate');
            if (!challenge) {
                fail('That sign-in attempt timed out. Try again.');
                cachedOptions = null;
                return;
            }

            const response = await fetch(`${API}/authenticate/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ response: shared.serialiseAssertion(credential), challenge })
            });
            const body = await shared.readJson(response);
            cachedOptions = null;

            if (!response.ok) {
                if (response.status === 403 && body.requiresVerification) {
                    fail(body.error);
                    return;
                }
                fail(body.error || 'That passkey did not work.');
                return;
            }

            // Stored through the shared helper, in the same session slot every other page
            // reads. This used to write to `localStorage` under a key of its own, which the
            // rest of the app never looked at: the visitor arrived at /offers holding a
            // perfectly good token that the site considered them not signed in with. A
            // session belongs in `sessionStorage`, which is also what the sign-out and the
            // "sign out everywhere" controls act on.
            if (!shared.storeSession(body)) {
                fail('Sign-in did not return a session. Please try again.');
                return;
            }
            report('Signed in. Taking you to your account...');

            // A full navigation rather than a history push: every page rebuilds its state
            // from the session on load, and a soft transition would leave the previous
            // page's DOM standing there under the new URL.
            const next = new URLSearchParams(location.search).get('next');
            window.location.assign(next && next.startsWith('/') ? next : '/offers');
        } catch (error) {
            cachedOptions = null;
            if (shared.isCancellation(error)) {
                // The credential sheet was dismissed. The password form is untouched and still
                // above the button, so there is nothing to say.
                return;
            }
            // The same silent failure as on the account page, and worse here: a visitor
            // signing in with a passkey who is in an in-app browser, or on an iPhone with no
            // Face ID set up, pressed the button, saw no sheet, and was told only that
            // "passkey sign-in did not work". Since `isCancellation` used to swallow
            // `NotAllowedError` entirely, that generic sentence was not even the common
            // outcome -- most of the time there was no message at all.
            if (error?.name === 'NotAllowedError') {
                const advice = shared.notAllowedAdvice(error, await shared.hasPlatformAuthenticator());
                if (advice) {
                    fail(advice);
                    return;
                }
                return;
            }
            if (error?.name === 'NotSupportedError') {
                fail('This browser does not support passkeys. Updating Safari to 16.4 or newer will add support, and you can sign in with your password until then.');
                return;
            }
            fail('Passkey sign-in did not work. You can sign in with your password instead.');
        } finally {
            button.disabled = false;
            if (buttonLabel) buttonLabel.textContent = original;
        }
    }

    /**
     * Shows the entry point if this browser can use one.
     *
     * `PublicKeyCredential` merely *existing* proves nothing: a desktop browser with no
     * platform authenticator still exposes the object and then fails when the user tries it.
     * So the button is shown whenever the API is present -- a USB security key on the same
     * machine also works -- and the availability check is used only to word the note
     * accurately, since "Face ID" is not true of a Windows machine.
     */
    async function reveal() {
        if (typeof PublicKeyCredential === 'undefined') return;

        // The in-app case is decided before anything else, and it is checked here rather than
        // only after a failure because this is the one condition that is certain to fail. An
        // in-app web view has no access to the platform authenticator at all, so no credential
        // sheet will ever appear. Saying so next to the button means the visitor does not have
        // to press it and read an error to find out -- and the fix is a different browser,
        // which is not something either of the two other messages would have told them.
        if (shared.embeddedBrowserPattern.test(navigator.userAgent || '')) {
            if (note) {
                note.textContent = 'Open this page in Safari, Chrome or Firefox to use a passkey. '
                    + 'Apps that open links inside their own browser cannot reach Face ID, Touch ID or your screen lock.';
            }
            entry.hidden = false;
            return;
        }

        // `null` means the browser could not answer, which is not the same as "no". Older
        // Safari throws on the probe. The previous version collapsed both to `false` and so
        // told every one of those phones that it had no screen lock, when the real answer is
        // that nobody had asked it.
        const platform = await shared.hasPlatformAuthenticator();

        if (note) {
            if (platform === true) {
                note.textContent = 'Face ID, Touch ID, Windows Hello, or your device screen lock.';
            } else if (platform === false) {
                const ua = navigator.userAgent || '';
                const isAppleMobile = /iPhone|iPad|iPod/i.test(ua)
                    || (/Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
                if (isAppleMobile) {
                    note.textContent = 'Set up Face ID or a passcode in Settings first, or use a security key.';
                } else if (/Android/i.test(ua)) {
                    note.textContent = 'Set up a screen lock in Settings first, or use a security key.';
                } else {
                    note.textContent = 'Use the security key or screen lock already set up on this device.';
                }
            } else {
                note.textContent = 'Use Face ID, Touch ID, your screen lock, or a security key.';
            }
        }

        entry.hidden = false;

        // Warm the challenge so the click handler can call the authenticator inside the
        // gesture. A failure here is silent: the button stays, and the click refetches.
        prefetchOptions().catch(() => {});
    }

    button.addEventListener('click', signInWithPasskey);
    reveal().catch(() => {});
})();
