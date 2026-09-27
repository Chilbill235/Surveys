/**
 * Whether the demo offer flow is available in this deployment.
 *
 * Four separate decisions used to be made independently, each reading `NODE_ENV` directly:
 * whether demo offers appear in the catalog, whether `/demo` is served, whether
 * `/api/demo/complete` accepts a completion, and whether a demo click is allowed to
 * redirect. Any two of them could disagree, and when they did the result was a dead end
 * with no error anywhere -- a catalog card that leads to a 404, or a completion that is
 * rejected after the user has answered the survey.
 *
 * That is not hypothetical. A deployment with `OFFERS_INCLUDE_DEMO=true` showed the demo
 * offers and then 404'd every one of them, because the resolver that had been written for
 * the catalog was never applied to the other three gates. The catalog and the flow it
 * advertises have to be one decision, so it is made in one place and read by all four.
 *
 * `OFFERS_INCLUDE_DEMO` is the control, tri-state:
 *
 *   - `true` / `1`  -> the demo flow is available.
 *   - `false` / `0` -> it is not, whatever NODE_ENV says.
 *   - unset         -> available outside production, unavailable in production.
 *
 * The unset default is deliberately not "on". A production deployment shares its database
 * with local development, so a default of on would publish local test offers to real
 * visitors. It is also deliberately not "off everywhere": a preview or staging deployment
 * named after a release is exactly where this flow needs to work, and `NODE_ENV` is
 * `production` there, so the default has to be overridable by an explicit variable.
 *
 * This says nothing about whether a demo reward is worth money. Demo completions credit
 * `demo_balance`, which is not withdrawable, and they write a ledger row flagged `is_demo`
 * so they can never be mistaken for cash.
 */
function isDemoModeEnabled() {
    const explicit = String(process.env.OFFERS_INCLUDE_DEMO || '').trim().toLowerCase();
    if (explicit === 'true' || explicit === '1') return true;
    if (explicit === 'false' || explicit === '0') return false;
    return process.env.NODE_ENV !== 'production';
}

/**
 * Why demo mode resolved the way it did, for logs and error messages.
 *
 * Returns the source of the answer as well as the answer, because "demo mode is off" is
 * ambiguous between "production, correctly" and "a preview that forgot to set the
 * variable", and those need different responses from whoever is reading the log.
 */
function describeDemoMode() {
    const configured = String(process.env.OFFERS_INCLUDE_DEMO || '').trim();
    const enabled = isDemoModeEnabled();
    return {
        enabled,
        source: configured ? 'OFFERS_INCLUDE_DEMO' : 'NODE_ENV',
        environment: process.env.NODE_ENV || 'unset'
    };
}

module.exports = { isDemoModeEnabled, describeDemoMode };
