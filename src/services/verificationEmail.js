const { createHash, randomInt, timingSafeEqual } = require('node:crypto');
const { sendEmail, isEmailConfigured } = require('./mailer');
const { renderEmail, renderEmailText } = require('./emailLayout');

/**
 * Six-digit email verification.
 *
 * The code is the only thing standing between "someone typed a valid-looking address" and
 * "an account exists at an inbox the signer may not control", so the properties that matter
 * are all about how much guessing it allows.
 *
 * A six-digit code is a million possibilities, which is *not* much. Brute force is stopped
 * by giving the guesser very few tries rather than by a long secret:
 *
 *   - A row is deleted after a handful of wrong guesses (`MAX_ATTEMPTS`), so the code cannot
 *     be searched offline against a captured hash -- a fast digest of a small number is cheap
 *     to reverse *if you are allowed to keep guessing*, and this removes the ability.
 *   - Codes expire in minutes, which bounds the same attack across accounts.
 *   - Sending is rate limited separately from guessing, so one address cannot be used to
 *     spray codes at a victim.
 *
 * The code is compared with `timingSafeEqual` so a wrong guess leaks no information about how
 * many leading digits were right.
 */

/** Six digits, zero-padded. */
const CODE_LENGTH = 6;
const CODE_PATTERN = /^\d{6}$/;

/** How long a code stays usable. Short, because it is guessable in principle. */
const CODE_LIFETIME_MINUTES = 15;

/**
 * Wrong guesses allowed before the code is destroyed.
 *
 * Five is deliberate. At a million possibilities, five attempts makes an exhaustive search
 * hopeless, while still allowing a real person two or three fat-fingered entries. Beyond
 * this the honest options are "ask for another code", which is cheap.
 */
const MAX_ATTEMPTS = 5;

/** A fresh code, uniformly random over the whole range including leading zeros. */
function generateCode() {
    // `randomInt` is a CSPRNG, and the inclusive upper bound is what makes 000000 and 999999
    // as likely as any other value. `Math.random()` would not be: it is seeded from a small
    // state, and a predictable code defeats the point of sending one.
    return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/**
 * Hashes a code for storage.
 *
 * The code is low entropy, so this is deliberately not a password hash -- scrypt would cost
 * real time on every verification attempt and buy nothing, because the defence is
 * `MAX_ATTEMPTS` plus a short lifetime, not the digest's slowness. The code is peppered with
 * the user's id and a process-secret so a stored hash cannot be matched against a code
 * generated for a different account.
 */
function hashCode(code, userId) {
    const pepper = process.env.EMAIL_VERIFICATION_PEPPER || process.env.JWT_SECRET || '';
    return createHash('sha256')
        .update(`${pepper}:${userId}:${code}`)
        .digest('hex');
}

/**
 * Compares a submitted code against a stored hash without leaking timing.
 *
 * The user id is needed because the hash is bound to the account it was issued for; a code
 * that matches one user's stored hash must not verify another, and without the id in the
 * comparison that is a genuine cross-account hole.
 */
function codeMatches(submittedCode, storedHash, userId) {
    if (!CODE_PATTERN.test(String(submittedCode))) return false;

    const stored = Buffer.from(String(storedHash || ''), 'hex');
    // `timingSafeEqual` throws on a length mismatch, which is itself an oracle, so the lengths
    // are compared first. The stored value is always a fixed-width digest, so a mismatch means
    // the row is not one this app wrote.
    if (stored.length !== 32) return false;

    const computed = Buffer.from(hashCode(String(submittedCode), userId), 'hex');
    return timingSafeEqual(computed, stored);
}

/**
 * The text and HTML bodies for the verification message.
 *
 * The code is the point of the message, so it is the one element that is not a paragraph: it
 * gets its own high-contrast cell, a monospace face, and wide letter spacing, because a
 * six-digit number in body type is easy to misread and a misread code spends one of five
 * attempts. The same digits are in the text alternative, so a client that renders no HTML at
 * all can still complete the flow.
 *
 * Both bodies are produced by the shared layout so this message looks like the rest of the
 * product rather than like a different sender, and so the text and HTML versions cannot drift
 * apart -- which is how a message ends up saying "click here" in a form that has no button.
 */
function buildMessage({ code, minutes = CODE_LIFETIME_MINUTES }) {
    const subject = 'Confirm your RewardZone email';
    const blocks = [
        { type: 'code', value: code },
        { type: 'callout', tone: 'neutral', text: `This code expires in ${minutes} minutes. Request a new one from the sign-in page if it has expired.` },
        { type: 'paragraph', text: 'If you did not try to create an account, you can ignore this email and nothing will happen.' }
    ];

    const shared = {
        heading: 'Confirm your email',
        intro: 'Enter this 6-digit code to finish creating your RewardZone account.',
        blocks
    };

    return {
        subject,
        text: renderEmailText(shared),
        html: renderEmail({
            preheader: `${code} is your RewardZone confirmation code.`,
            ...shared
        })
    };
}

/**
 * Sends a verification code.
 *
 * Delivery is delegated to the shared mailer, so the provider is chosen by configuration
 * rather than baked in here. When no provider is configured the code is logged rather than
 * emailed: local development can still complete the flow, and the operator sees a plain
 * warning instead of a silent failure.
 */
async function sendVerificationEmail({ to, code }) {
    if (!isEmailConfigured()) {
        console.error(`Email verification code (email is not configured, code only): ${code}`);
        return { sent: false, reason: 'email-not-configured' };
    }

    const { subject, text, html } = buildMessage({ code });
    return sendEmail({ to, subject, text, html });
}

module.exports = {
    generateCode,
    hashCode,
    codeMatches,
    buildMessage,
    sendVerificationEmail,
    CODE_LENGTH,
    CODE_PATTERN,
    CODE_LIFETIME_MINUTES,
    MAX_ATTEMPTS
};
