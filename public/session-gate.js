/**
 * Sign-in gate for the pages that need one.
 *
 * Why a separate file
 * -------------------
 * A `defer` script runs after the document is parsed and before `DOMContentLoaded`, in the
 * order the tags appear. Loading this first means the gate runs before any other page script
 * has started rendering, so a signed-out visitor to the offers page is sent to sign in
 * before the catalog, the balance, or the account controls are painted. Folding this into
 * `app.js` would put it behind whatever that file does at the top level, which is the whole
 * race the gate exists to win.
 *
 * Why it is client-side at all
 * ----------------------------
 * The session lives in `sessionStorage` and is sent as a bearer token, so the server has
 * nothing to check until the first API call. A server-side redirect would therefore have
 * been a redirect-to-login on every page load, for signed-in users too, and the only way to
 * tell the two apart before the token is read is to read the token. The trade is that the
 * decision is made here; the API is still the authority, and a 401 anywhere sends the
 * visitor here through the same path.
 *
 * Marking a page as private is one attribute on its `<body>`:
 *
 *     <body data-requires-session="true">
 *
 * The login page deliberately does not carry it -- it is where the gate sends people, and a
 * gate that redirected to itself would be a loop.
 */
(() => {
    const LOGIN_PATH = '/login';
    const RETURN_PARAM = 'next';
    const TOKEN_KEY = 'offerNetworkSessionToken';
    /** Where a signed-in visitor who opens the sign-in page goes when they named no page. */
    const DEFAULT_DESTINATION = '/account';

    function isLoginPath() {
        const path = window.location.pathname;
        return path === LOGIN_PATH || path === `${LOGIN_PATH}/`;
    }

    /**
     * A return path is only honoured when it is a path on this site.
     *
     * The value arrives in a query string, which means it can be anything a person types
     * into the address bar. `https://evil.example` and `//evil.example` are both rejected
     * by the leading-slash rule, because a leading `/` is what makes the browser resolve
     * against this origin rather than fetch someone else's site after a sign-in. Backslashes
     * are refused too: some browsers normalise `/\` to `//`, which is the same escape by a
     * different spelling.
     */
    function safeReturnPath(value) {
        if (typeof value !== 'string') return null;
        const candidate = value.trim();
        if (candidate === '' || candidate.length > 2048) return null;
        if (!candidate.startsWith('/')) return null;
        if (candidate.startsWith('//') || candidate.startsWith('/\\')) return null;
        // Back to the login page, or a bounce that never ends.
        if (candidate === LOGIN_PATH || candidate.startsWith(`${LOGIN_PATH}?`) || candidate.startsWith(`${LOGIN_PATH}/`)) return null;
        return candidate;
    }

    /**
     * Where the visitor is now, as a return path.
     *
     * The magic-link fragment is carried along. A magic link is an email that signs someone
     * in, and those are built as `/offers#magic=...`; a gate that dropped the fragment on
     * the way to the login page would turn every magic link into a dead link, and the token
     * is the only thing that is in it. Other fragments are left behind so a `#section` link
     * does not pin the visitor to a page they were only passing through.
     */
    function currentReturnPath() {
        const hash = window.location.hash || '';
        const carry = hash.startsWith('#magic=') ? hash : '';
        return `${window.location.pathname}${window.location.search || ''}${carry}`;
    }

    function loginUrlFor(from) {
        const target = safeReturnPath(from) || '/account';
        return `${LOGIN_PATH}?${RETURN_PARAM}=${encodeURIComponent(target)}`;
    }

    function hasToken() {
        return Boolean(sessionStorage.getItem(TOKEN_KEY));
    }

    /**
     * Where the visitor was sent from, left in place.
     *
     * Read-only. The gate reads this on load to decide whether a visitor who already has a
     * session should be sent onward, and that decision happens long before they sign in --
     * clearing the parameter there would take the destination with it, and the sign-in that
     * follows would have nothing to return to.
     */
    function peekReturnTo() {
        return safeReturnToParam(new URLSearchParams(window.location.search).get(RETURN_PARAM));
    }

    /**
     * The page the visitor was sent away from, taken once.
     *
     * Read and removed in the same step: a stale `next` left in the URL would send a
     * visitor who signs in an hour later back to a page they have long since left, and a
     * second sign-in in the same tab would send them there again.
     */
    function consumeReturnTo() {
        const path = peekReturnTo();
        if (path !== null) clearReturnTo();
        return path;
    }

    function safeReturnToParam(raw) {
        return raw === null ? null : safeReturnPath(raw);
    }

    function clearReturnTo() {
        const url = new URL(window.location.href);
        if (!url.searchParams.has(RETURN_PARAM)) return;
        url.searchParams.delete(RETURN_PARAM);
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }

    /**
     * Sends the visitor to sign in, remembering where they were.
     *
     * `replace`, not `assign`: the page they were refused is not somewhere they can act, and
     * leaving it in the history stack means the browser Back button walks straight back into
     * the gate and bounces them out again.
     */
    function goToLogin(from) {
        const url = loginUrlFor(from);
        if (window.location.pathname + window.location.search === url) return;
        window.location.replace(url);
    }

    /**
     * Called on every page load. Returns true when the visitor may stay.
     *
     * Two cases, and the second is the one that is easy to miss: a signed-in visitor who
     * lands on `/login?next=/account` should be sent onward rather than shown a sign-in form
     * they do not need. That is what makes "signed out, go here, come back" work when they
     * already have a session from a moment ago.
     */
    function enforce() {
        if (isLoginPath()) {
            const onward = peekReturnTo();
            if (hasToken()) {
                // A session with nowhere particular to go is not a reason to show a sign-in
                // form. The default is the account page, because that is where "connect
                // account" on a public page means the visitor is trying to end up.
                window.location.replace(onward || DEFAULT_DESTINATION);
                return false;
            }
            return true;
        }
        if (document.body?.dataset.requiresSession !== 'true') return true;
        if (hasToken()) return true;
        goToLogin(currentReturnPath());
        return false;
    }

    /**
     * Keeps a signed-out visitor on the sign-in page.
     *
     * `/login` is its own page with nothing behind it, so there is no page content to hide
     * and no dialog to dismiss -- a visitor cannot reach `/offers` or `/account` from here
     * except by signing in. What this does guard is the one navigation that would defeat
     * that: a magic link or a `next` value is fine, but the Back button is not, because
     * history can hold the gated page that sent them here. The gate already replaced it, so
     * the previous entry is wherever they were before -- and if that was a private page, the
     * gate runs again and replaces forward to here. The observable result is that Back never
     * reveals a page they were not signed in for.
     */
    function watchForPrivateHistory() {
        window.addEventListener('popstate', () => {
            if (hasToken()) return;
            if (isLoginPath()) return;
            if (document.body?.dataset.requiresSession !== 'true') return;
            goToLogin(currentReturnPath());
        });
    }

    window.RewardZoneSession = {
        LOGIN_PATH,
        TOKEN_KEY,
        safeReturnPath,
        currentReturnPath,
        loginUrlFor,
        hasToken,
        peekReturnTo,
        consumeReturnTo,
        clearReturnTo,
        goToLogin,
        isLoginPath,
        enforce,
        watchForPrivateHistory
    };
})();
