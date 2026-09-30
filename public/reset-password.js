/**
 * Completes the password reset flow.
 *
 * The token arrives in the URL fragment (`/reset-password#token=...`), not the query
 * string, so it is never sent in a request line and therefore never recorded in
 * access logs or leaked through a Referer header. The fragment is removed from the
 * address bar as soon as it is read, so it is not left behind in browser history or
 * in a screen share.
 *
 * Where it finishes
 * -----------------
 * On the account page, signed in. The server returns a session with the reset -- reading
 * a valid, unexpired, single-use token out of the account's own mailbox is the same proof
 * a password sign-in gives -- and this page stores it and goes there. It used to leave the
 * visitor on a success message whose only advice was to go and type the password they had
 * just chosen, on a different page, which is the same work again with the reward being a
 * blank form. If the session is not in the response the redirect still happens: they are
 * sent to sign in and returned here afterwards, which is better than a page that explains
 * the next step in prose.
 */
const SESSION_KEY = 'offerNetworkSessionToken';
// Cleared alongside the token on the reset page. `app.js` writes it at sign-in and reads it
// to pre-fill the contact form, so a stale copy would outlive the session the reset revoked.
const EMAIL_KEY = 'rewardZoneEmail';
const ACCOUNT_PATH = '/account';

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

function showToast(title, message, tone) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast is-${tone || 'info'}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    const icon = tone === 'success'
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${icon}</span>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
    `;
    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
    region.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 200);
    }, 4500);
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
        showToast('Reset link invalid', 'This reset link is not complete or has expired.', 'error');
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
                showToast('Password reset failed', payload.error || 'Could not reset your password.', 'error');
                return;
            }

            // The token is consumed server-side, so the form cannot be submitted twice.
            form.hidden = true;
            intro.textContent = 'Your password has been updated.';
            showMessage(message, payload.message || 'Your password has been updated.', false);
            showToast('Password updated', 'Your password has been changed successfully.', 'success');
            document.getElementById('reset-password').value = '';
            document.getElementById('reset-confirm').value = '';
            help.hidden = true;
            if (fallback) {
                showMessage(fallback, 'Taking you to your account...', false);
            }

            // Every other session was revoked by the reset, so any token this tab was
            // holding is dead and is cleared before the new one goes in. Leaving it would
            // mean the account page spends its first request on a 401 and sends the visitor
            // straight back to sign in -- immediately after they signed in successfully.
            sessionStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(EMAIL_KEY);
            if (payload.token) sessionStorage.setItem(SESSION_KEY, payload.token);
            if (payload.user?.email) sessionStorage.setItem(EMAIL_KEY, payload.user.email);

            // Long enough for the success message and toast to be read, so the redirect is
            // not the visitor's only evidence that anything happened. Replaced rather than
            // assigned: the token was in the URL a moment ago, and Back should not replay
            // a page whose token is spent.
            setTimeout(() => {
                window.location.replace(
                    payload.token ? ACCOUNT_PATH : `/login?next=${encodeURIComponent(ACCOUNT_PATH)}`
                );
            }, 1600);
        } catch (error) {
            showMessage(message, 'Could not reach the server. Check your connection and try again.', true);
            showToast('Connection failed', 'Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'Update password';
        }
    });
});
