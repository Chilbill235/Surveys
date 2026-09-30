/**
 * Which HTTP methods each known API path accepts.
 *
 * The reason this exists: a browser address bar can only ever send GET, but most of the
 * operator endpoints are POST-only actions. `POST /api/maintenance/withdrawals/42/refund`
 * opened in a browser fell through every route and reached the catch-all, which answered
 * `{"error":"API route not found."}`. That is a true statement about nothing: the path
 * exists, the route exists, and only the method was wrong. An operator reading that has no
 * way to tell "wrong URL" from "wrong verb" and no way to find the verb that was wanted.
 *
 * The registry lets each route module declare the verbs it answers, in the same place the
 * route is registered, so the list cannot drift from the routes. A path that matches an
 * entry but arrives with a method that is not in the entry is answered 405 with an `Allow`
 * header, which is what the status exists for, and which a browser, curl, and every HTTP
 * client already understand.
 *
 * Patterns are matched against the request's path with its query string removed, and must be
 * anchored. A path that matches nothing here is left to the ordinary 404, so this never turns
 * an unknown URL into a 405.
 */

const registry = [];

/**
 * Declares the methods a path pattern answers.
 *
 * @param {RegExp} pattern Anchored pattern for the full request path.
 * @param {string[]} methods Uppercase HTTP method names.
 */
function register(pattern, methods) {
    if (!pattern || !pattern.test) {
        throw new TypeError('register() needs an anchored RegExp pattern.');
    }
    const normalized = methods.map((method) => String(method).toUpperCase());
    if (normalized.length === 0) {
        throw new TypeError('register() needs at least one method.');
    }
    registry.push({ pattern, methods: normalized });
}

/**
 * The methods accepted for a path, or null when the path is not a known API route.
 *
 * A path that matches more than one entry takes the union, so overlapping patterns cannot
 * accidentally report a verb as unsupported when another route already accepts it.
 */
function methodsFor(pathname) {
    const found = new Set();
    let matched = false;
    for (const entry of registry) {
        if (!entry.pattern.test(pathname)) continue;
        matched = true;
        for (const method of entry.methods) found.add(method);
    }
    return matched ? [...found] : null;
}

module.exports = { register, methodsFor };
