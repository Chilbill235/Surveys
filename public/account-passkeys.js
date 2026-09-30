/**
 * Adding and revoking passkeys from the account page.
 *
 * Split from `passkeys.js` because the two flows share very little. The sign-in half is
 * anonymous and has one button; this half needs a session, lists what is already registered,
 * and can remove things. Keeping them in one file would mean both halves loading a
 * registration function on a page that has no button to press it.
 *
 * The base64url conversions and the fetch wrappers come from `passkey-shared.js`, which is
 * loaded first and is DOM-free.
 *
 * ## The gesture problem again
 *
 * As on the login page, `navigator.credentials.create()` has to run inside a click handler with
 * no `await` in front of it. The registration options are therefore fetched when the page
 * loads and refreshed after each failure, so that pressing "Add this device" can go straight
 * to the authenticator.
 */

'use strict';

(function () {
    const shared = window.RewardZonePasskeys;
    const API = '/api/auth/passkeys';

    const card = document.getElementById('passkey-card');
    const addButton = document.getElementById('passkey-add');
    const list = document.getElementById('passkey-list');
    const status = document.getElementById('passkey-status');
    const notice = document.getElementById('passkey-notice');
    const noticeTitle = document.getElementById('passkey-notice-title');
    const noticeBody = document.getElementById('passkey-notice-body');

    // Nothing to do on a browser with no WebAuthn at all. The card stays `hidden` from the
    // markup, so this is also the guard that keeps it off the page.
    if (!card || !addButton || !list || !status || !shared) return;
    if (typeof PublicKeyCredential === 'undefined') return;

    function setStatus(text, isError) {
        status.textContent = text;
        status.classList.toggle('is-error', Boolean(isError));
    }

    // --- Why the button might not work --------------------------------------

    /**
     * Whether this device can actually create a passkey right now, and if not, why.
     *
     * This is the part that was missing, and its absence is why the passkey card simply did
     * not appear on iPhones. The old check was `typeof PublicKeyCredential !== 'undefined'`,
     * which iOS Safari passes, so the card showed -- but on any iPhone where Face ID was not
     * enrolled, or where Safari was older than 16.4, the card then appeared and the button did
     * nothing when pressed. Earlier revisions went the other way and hid the card unless the
     * list request succeeded, which hid it for the majority of real iPhones instead.
     *
     * Both failure modes are the same failure from the reader's side: a security control that
     * is either missing or inert, with nothing said. So the card is now always shown when the
     * browser has WebAuthn at all, and this function decides whether to explain a limitation
     * or get out of the way.
     *
     * `isUserVerifyingPlatformAuthenticatorAvailable()` is the only signal there is. It
     * returns a promise, it was not implemented everywhere, and it is permitted to return
     * `false` for a reason the browser will not explain -- which is why the copy below names
     * the iOS causes specifically rather than claiming to know which one applies.
     */
    async function checkPlatformAuthenticator() {
        if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
            // No way to ask. Not the same as "unavailable": the API may still work, so the
            // card stays fully live and this is not surfaced at all.
            return { supported: true, checked: false };
        }
        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            return { supported: true, checked: true, available: available === true };
        } catch {
            // Older Safari throws rather than resolving. Treated as unverified for the same
            // reason as above: a wrong "unavailable" would disable a control that works.
            return { supported: true, checked: false };
        }
    }

    /**
     * States the situation in words, with the fix, instead of leaving a dead button.
     *
     * Three cases, because the fix differs in each and a generic "not supported" leaves the
     * reader with nothing to do:
     *
     *  - An iPhone or iPad. Face ID is not enrolled, or the device is on Safari older than
     *    16.4. Both are the overwhelmingly common causes and both are fixable in Settings.
     *  - Anything else. Almost always a screen lock that is not set, or an in-app browser
     *    (Instagram, Facebook, an email client) where the biometric sheet is not available.
     *  - A plain desktop browser with no platform authenticator. A USB security key is the
     *    answer, and it is worth naming because the button is not the only way in.
     */
    function explainUnavailable(available) {
        if (!notice || !noticeTitle || !noticeBody) return;

        const ua = navigator.userAgent || '';
        const isAppleMobile = /iPhone|iPad|iPod/i.test(ua)
            // iPadOS 13+ reports itself as a Mac, so the touch-point count is the only signal
            // that distinguishes an iPad from a desktop Safari.
            || (/Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
        const isAndroid = /Android/i.test(ua);
        // An in-app webview: WebKit under another app's shell. Face ID exists on the phone but
        // the sheet is not offered, and the fix is to leave that app rather than to change a
        // setting. The pattern lives in the shared module because the login page needs the
        // same answer, and it had been written twice and drifted: the copy here recognised
        // three apps while the shared one recognises the ones users actually hit.
        const isEmbedded = shared.embeddedBrowserPattern.test(ua);

        if (isEmbedded) {
            // Checked before the platform branches on purpose. An in-app viewer runs on a phone
            // with Face ID fully working, so "Face ID needs setting up" would send the reader
            // into Settings to change something that is already correct. The problem is where
            // the page is open, and only the browser can fix that.
            noticeTitle.textContent = 'Open this page in your normal browser';
            noticeBody.textContent = 'This page is open inside another app, which is not allowed to use your phone\'s Face ID, fingerprint or screen lock. Tap the share button and choose Open in Safari, then press Add this device again.';
        } else if (isAppleMobile) {
            // "iPhone or iPad" and "Face ID or Touch ID" rather than a guess. iPadOS reports a
            // Mac user agent, which is why this branch is reached at all, and an iPad has no
            // Face ID -- telling someone to open Face ID settings on an iPad sends them to a
            // screen that does not exist.
            noticeTitle.textContent = 'Face ID or Touch ID needs setting up on this device';
            noticeBody.textContent = 'Open Settings, then Face ID & Passcode, and turn your biometric lock on. If it is already on, check that Safari is version 16.4 or newer. The steps are under the button below.';
        } else if (isAndroid) {
            noticeTitle.textContent = 'Screen lock needs setting up on this phone';
            noticeBody.textContent = 'Open Settings, Security, and set up a fingerprint, face unlock or screen lock. A passkey cannot be created until the phone has one.';
        } else {
            noticeTitle.textContent = 'No biometric or screen lock on this device';
            noticeBody.textContent = 'Passkeys use the security this computer already has. Set a screen lock or a login password, or use a USB security key, and then press Add this device again.';
        }

        notice.hidden = false;
        // The button is not removed. The probe is allowed to be wrong -- it is a browser hint,
        // and a desktop browser with a security key attached reports no platform authenticator
        // while still being perfectly able to create one. Leaving it live with an explanation
        // above it is more useful than a control the user is told they may not have.
        addButton.disabled = false;
        addButton.dataset.passkeyUnavailable = 'true';

        // Open the steps. This is the one case where the reader certainly needs them, and
        // making them click a summary labelled "How to set up Face ID" after being told Face ID
        // is the problem is a step of indirection for no gain.
        const help = document.getElementById('passkey-help');
        if (help) help.open = true;
    }

    // --- Listing ------------------------------------------------------------

    /**
     * Renders the registered devices.
     *
     * Built with `createElement` and `textContent` rather than `innerHTML`. The device label
     * is user-supplied, so putting it into a template string would be an injection point --
     * and while a passkey name is not currently editable, writing it defensively costs
     * nothing and the label is going to be editable eventually.
     */
    function render(rows) {
        list.textContent = '';

        if (!rows.length) {
            const empty = document.createElement('li');
            empty.className = 'passkey-item';
            const copy = document.createElement('div');
            copy.className = 'passkey-item-main';
            const name = document.createElement('p');
            name.className = 'passkey-item-name';
            name.textContent = 'No passkeys yet';
            const meta = document.createElement('p');
            meta.className = 'passkey-item-meta';
            meta.textContent = 'Add this device to sign in without your password.';
            copy.append(name, meta);
            empty.append(copy);
            list.append(empty);
            return;
        }

        for (const row of rows) {
            const item = document.createElement('li');
            item.className = 'passkey-item';

            const main = document.createElement('div');
            main.className = 'passkey-item-main';

            const name = document.createElement('p');
            name.className = 'passkey-item-name';
            // Falls back to the date rather than showing a blank line, because an unlabelled
            // row in a revoke list is something a person cannot act on.
            name.textContent = row.name || describeDevice(row);

            const meta = document.createElement('p');
            meta.className = 'passkey-item-meta';
            meta.textContent = describeMeta(row);

            main.append(name, meta);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button button-ghost passkey-remove';
            remove.textContent = 'Remove';
            remove.addEventListener('click', () => confirmRemove(row, remove));

            item.append(main, remove);
            list.append(item);
        }
    }

    function describeDevice(row) {
        const type = String(row.device_type || '').toLowerCase();
        if (type.includes('hybrid')) return 'Phone or tablet';
        if (String(row.transports || '').includes('internal')) return 'This device';
        if (String(row.transports || '').includes('usb')) return 'Security key';
        if (String(row.transports || '').includes('nfc')) return 'NFC key';
        if (String(row.transports || '').includes('ble')) return 'Bluetooth key';
        return 'Passkey';
    }

    function describeMeta(row) {
        const parts = [];
        const added = row.created_at ? new Date(row.created_at) : null;
        if (added && !Number.isNaN(added.getTime())) {
            parts.push(`Added ${added.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`);
        }
        if (row.last_used_at) {
            const used = new Date(row.last_used_at);
            if (!Number.isNaN(used.getTime())) {
                parts.push(`Last used ${used.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
            }
        }
        if (row.name) parts.push(row.name);
        return parts.join(' \u00b7 ');
    }

    async function refresh() {
        const response = await fetch(API, { headers: shared.authHeaders() });
        if (!response.ok) {
            // A signed-out visitor landing here gets an empty list rather than an error
            // banner. The session gate sends them to sign-in a moment later anyway, and a
            // "could not load" message on a page they are about to be redirected off is just
            // noise.
            render([]);
            return;
        }
        const body = await shared.readJson(response);
        render(Array.isArray(body.passkeys) ? body.passkeys : []);
    }

    // --- Adding -------------------------------------------------------------

    let cachedOptions = null;

    async function prefetch() {
        if (cachedOptions) return cachedOptions;
        const response = await fetch(`${API}/register/options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...shared.authHeaders() }
        });
        if (!response.ok) {
            // The server's own words, not a stand-in. A refusal here is usually something the
            // person can act on -- "Passkeys need a domain, not an IP address" -- and the
            // generic `unavailable` that used to be thrown here replaced it with a message about
            // their password, which is not what went wrong.
            const body = await shared.readJson(response);
            cachedOptions = null;
            throw new Error(body?.error || 'That passkey could not be set up right now.');
        }
        const options = await response.json();
        shared.rememberChallenge('register', options.challenge);
        cachedOptions = options;
        return options;
    }

    /**
     * Turns a registration response into the JSON the server expects.
     *
     * `attestationObject` is sent as a base64url string rather than base64: the COSE content
     * inside is binary, and standard base64 contains `+`, `/` and `=` which would have to be
     * escaped through a JSON string and back. Base64url avoids that and matches what the
     * challenge is already using.
     */
    function serialiseRegistration(credential) {
        return {
            id: credential.id,
            rawId: shared.bufferToBase64url(credential.rawId),
            type: credential.type,
            response: {
                clientDataJSON: shared.bufferToBase64url(credential.response.clientDataJSON),
                attestationObject: shared.bufferToBase64url(credential.response.attestationObject)
            },
            clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
            authenticatorAttachment: credential.authenticatorAttachment || null
        };
    }

    async function addPasskey() {
        setStatus('', false);
        addButton.disabled = true;
        const original = addButton.textContent;
        addButton.textContent = 'Waiting for your device...';

        try {
            const options = await prefetch();

            // `user.name` is required by WebAuthn and the browser throws a TypeError naming a
            // WebIDL property if it is missing -- "Failed to read the 'name' property from
            // 'PublicKeyCredentialEntity'" -- which reaches the visitor as an unhandled error on
            // a page that otherwise looks finished. The server fills it from the account's email;
            // this is the check that says so in words if it ever does not, and it also means a
            // half-built options object cannot reach the authenticator.
            if (typeof options.user?.name !== 'string' || !options.user.name.includes('@')) {
                cachedOptions = null;
                setStatus('We could not read the email on your account, and a passkey needs one to be named after. Try again in a moment, or use your password.', true);
                return;
            }

            const request = {
                challenge: shared.base64urlToBuffer(options.challenge),
                rp: { name: options.rp.name, id: options.rp.id },
                user: {
                    id: shared.base64urlToBuffer(options.user.id),
                    name: options.user.name,
                    displayName: options.user.displayName
                },
                pubKeyCredParams: options.pubKeyCredParams,
                timeout: options.timeout,
                attestation: options.attestation,
                excludeCredentials: (options.excludeCredentials || []).map((item) => ({
                    id: shared.base64urlToBuffer(item.id),
                    type: 'public-key',
                    transports: item.transports || []
                })),
                authenticatorSelection: options.authenticatorSelection
            };

            // Inside the gesture: no `await` between here and the click that started this.
            const credential = await navigator.credentials.create({ publicKey: request });
            if (!credential) throw new Error('no-credential');

            // Spent whether or not the attestation verifies.
            const challenge = shared.consumeChallenge('register');
            if (!challenge) {
                setStatus('That took too long. Try again.', true);
                cachedOptions = null;
                return;
            }

            const response = await fetch(`${API}/register/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...shared.authHeaders() },
                body: JSON.stringify({ response: serialiseRegistration(credential), challenge })
            });
            const body = await shared.readJson(response);
            cachedOptions = null;

            if (!response.ok) {
                setStatus(body.error || 'That passkey could not be added.', true);
                return;
            }

            // The device is on the account now, so this browser can sign in without a
            // password.
            setStatus('Added. You can now sign in with it on this device.', false);
            await refresh();
        } catch (error) {
            cachedOptions = null;
            if (shared.isCancellation(error)) {
                // The Face ID sheet was dismissed. The user's call, so say nothing.
                setStatus('', false);
                return;
            }
            // The iPhone failure this whole path exists for. `NotAllowedError` is thrown when
            // the device has no usable authenticator -- no Face ID enrolled, no passcode set,
            // or an in-app viewer with no access to the biometric sheet -- and the sheet simply
            // never appears.
            //
            // This branch was unreachable until `isCancellation` stopped claiming the error
            // first, so an iPhone with nothing set up pressed this button, saw no sheet and no
            // message, and reported that Face ID was broken. What to say cannot be read out of
            // the exception -- it is identical for a dismissal and for a missing setup -- so it
            // is chosen from the device: the in-app case first, because the fix there is a
            // different browser rather than a different Settings app.
            if (error?.name === 'NotAllowedError') {
                const advice = shared.notAllowedAdvice(error, await shared.hasPlatformAuthenticator());
                if (advice) {
                    setStatus(advice, true);
                    return;
                }
                // A real dismissal on a device that reports a working authenticator.
                setStatus('', false);
                return;
            }
            // `InvalidStateError` is a credential that is already registered for this account
            // on this device, which is a fact about the device rather than about https. It used
            // to be lumped in with `SecurityError` and answered with "load the site over https
            // with its real address", sending people to fix a problem they did not have.
            if (error?.name === 'InvalidStateError') {
                setStatus('This device already has a passkey for your account. Remove the existing one first if you want to add it again.', true);
                return;
            }
            if (error?.name === 'SecurityError') {
                setStatus('Passkeys need the site loaded over https:// with its real address, not a preview or an IP address. Your password still works.', true);
                return;
            }
            // Safari before 16.4, and any browser with no WebAuthn implementation at all.
            // Reached on a browser that passes the `PublicKeyCredential` feature check but
            // cannot create a credential, which is a real gap on older iPhones and worth
            // naming rather than reporting as an unexplained failure.
            if (error?.name === 'NotSupportedError') {
                setStatus('This browser does not support passkeys. Updating Safari to 16.4 or newer will add support, and your password still works until then.', true);
                return;
            }
            setStatus(error?.message || 'That passkey could not be added. You can keep using your password.', true);
        } finally {
            addButton.disabled = false;
            addButton.textContent = original;
        }
    }

    // --- Removing -----------------------------------------------------------

    /**
     * Removes a device after an explicit confirmation.
     *
     * `confirm()` rather than a bespoke dialog: the question is unambiguous, and a native
     * prompt is the one confirmation users already have the reflex to read carefully. The
     * row is not removed optimistically, because a failed delete that has already been taken
     * off the screen is a security problem that looks like a success.
     */
    async function confirmRemove(row, button) {
        const label = row.name || describeDevice(row);
        const ok = window.confirm(`Remove the passkey "${label}" from this account?\n\nYou will no longer be able to sign in with it. Your password will still work.`);
        if (!ok) return;

        button.disabled = true;
        const original = button.textContent;
        button.textContent = 'Removing...';

        try {
            const response = await fetch(`${API}/${encodeURIComponent(row.credential_id)}`, {
                method: 'DELETE',
                headers: shared.authHeaders()
            });
            const body = await shared.readJson(response);

            if (!response.ok) {
                setStatus(body.error || 'That passkey could not be removed.', true);
                return;
            }
            setStatus('Passkey removed.', false);
            await refresh();
        } catch {
            setStatus('That passkey could not be removed. Check your connection and try again.', true);
        } finally {
            button.disabled = false;
            button.textContent = original;
        }
    }

    // --- Start --------------------------------------------------------------

    async function start() {
        // The card is revealed as soon as the script knows there is a WebAuthn API, which is
        // before any network call. It used to wait for a successful list request instead, and
        // that is what made the whole card disappear on iPhones: a signed-out visitor, a slow
        // connection or a flaky one all produced the same silent absence as "this device
        // cannot use passkeys", and the majority of real iPhones were in that group.
        //
        // Capability and authentication are now separate questions with separate answers. The
        // card is shown for anyone with a WebAuthn API; the list underneath is empty until the
        // session is confirmed, and the capability notice above it is filled in from the
        // device, not from the session.
        card.hidden = false;
        addButton.addEventListener('click', addPasskey);

        const capability = await checkPlatformAuthenticator();
        if (capability.checked && capability.available === false) {
            explainUnavailable(false);
        }

        // A failed or unauthenticated list is not an error state for the card. The gate sends a
        // signed-out visitor to sign-in a moment later, and rendering the empty list is the
        // honest thing to show in the meantime.
        try {
            await refresh();
        } catch {
            render([]);
        }

        // Warm the registration options so the first press can call the authenticator inside
        // the gesture. Silent on failure -- the click handler refetches and reports.
        prefetch().catch(() => {});
    }

    start().catch(() => {});
})();
