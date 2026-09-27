/**
 * Completes the password reset flow.
 *
 * The token arrives in the URL fragment (`/reset-password#token=...`), not the query
 * string, so it is never sent in a request line and therefore never recorded in
 * access logs or leaked through a Referer header. The fragment is removed from the
 * address bar as soon as it is read, so it is not left behind in browser history or
 * in a screen share.
 */
function readResetToken() {
    const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const token = new URLSearchParams(fragment).get('token') || '';
    if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname);
    }
    return /^[\da-f]{64}$/i.test(token) ? token : '';
}

function showMessage(element, text, isError) {
    element.className = isError ? 'form-message is-error' : 'form-message';
    element.textContent = text;
    element.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
    const token = readResetToken();
    const form = document.getElementById('reset-form');
    const intro = document.getElementById('reset-intro');
    const fallback = document.getElementById('reset-fallback');
    const help = document.getElementById('reset-help');
    const message = document.getElementById('reset-message');
    const button = document.getElementById('reset-submit');

    if (!token) {
        intro.textContent = 'This reset link is not complete.';
        showMessage(fallback, 'This reset link is invalid or has expired. Request a new one from the sign-in dialog.', true);
        help.hidden = false;
        return;
    }

    form.hidden = false;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = document.getElementById('reset-password').value;
        const confirmation = document.getElementById('reset-confirm').value;
        if (password.length < 12 || password.length > 128) {
            showMessage(message, 'Choose a password between 12 and 128 characters.', true);
            return;
        }
        if (password !== confirmation) {
            showMessage(message, 'Both password fields must match.', true);
            return;
        }

        button.disabled = true;
        button.textContent = 'Updating...';
        message.className = 'form-message';
        message.textContent = '';

        try {
            const response = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password })
            });
            const contentType = response.headers.get('content-type') || '';
            const payload = contentType.includes('application/json') ? await response.json() : {};
            if (!response.ok) {
                showMessage(message, payload.error || 'Could not reset your password.', true);
                if (response.status === 400) help.hidden = false;
                return;
            }

            // The token is consumed server-side, so the form cannot be submitted twice.
            form.hidden = true;
            intro.textContent = 'Your password has been updated.';
            showMessage(message, `${payload.message} Sign in from the offers page with your new password.`, false);
            document.getElementById('reset-password').value = '';
            document.getElementById('reset-confirm').value = '';
            help.hidden = true;
            showMessage(fallback, 'Return to the offers page to sign in.', false);
        } catch (error) {
            showMessage(message, 'Could not reach the server. Check your connection and try again.', true);
        } finally {
            button.disabled = false;
            button.textContent = 'Update password';
        }
    });
});
