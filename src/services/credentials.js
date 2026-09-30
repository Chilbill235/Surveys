/**
 * Reading a credential as "is it set?" is not the same question as "will it work?".
 *
 * Every credential in `.env.example` ships as a readable stand-in --
 * `whsec_your_stripe_webhook_secret_here` -- and a non-empty string is a perfectly good
 * credential as far as `process.env` is concerned. So a boolean check on a
 * configured-looking value passes on a template someone left behind, the app reports the
 * provider as available, offers the payment method, takes the customer's money, and then
 * fails to verify the callback that was supposed to credit it.
 *
 * The failure is silent by construction: the placeholder is truthy, so nothing about it
 * looks wrong. This module is the one place that asks whether a value is set *and real*.
 */

/**
 * Whether a value is a template rather than a credential.
 *
 * Deliberately not a strict format check on the whole value. A secret's shape is the
 * provider's business and changes between key types; what matters is that it is not a
 * placeholder someone left behind, which is what this actually detects.
 */
function isPlaceholderCredential(value) {
    if (typeof value !== 'string') return true;
    const trimmed = value.trim();
    if (trimmed === '') return true;
    return (
        /^(sk|rk|pk|whsec|ak|api)_your/i.test(trimmed)
        || /^(your[_-]|your\b)/i.test(trimmed)
        || /(placeholder|changeme|change_me|replace_me|todo|fixme|example)/i.test(trimmed)
        // The example values all end in `_here`, which is the giveaway on a value that
        // otherwise looks plausible.
        || /_here$/i.test(trimmed)
        || /[<>{}\[\]]/.test(trimmed)
        // A value made only of one repeated character is a keyboard slip, not a credential.
        || /^(.)\1{7,}$/.test(trimmed)
    );
}

/** The raw environment value, or null when it is missing or still a placeholder. */
function realCredential(env, name) {
    const value = env[name];
    return isPlaceholderCredential(value) ? null : value;
}

/** Names of the given variables that are missing or still placeholders, in order. */
function placeholderProblems(env, names) {
    return names.filter((name) => isPlaceholderCredential(env[name])).map((name) => `${name} is missing or is still a placeholder value.`);
}

module.exports = { isPlaceholderCredential, realCredential, placeholderProblems };
