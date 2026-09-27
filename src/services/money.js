/**
 * Currency amount parsing shared by every endpoint that accepts a money value.
 *
 * Amounts arrive as JSON numbers, and a value such as 1.1 is held as
 * 1.100000000000000088817841970012523233890533447265625. Comparing
 * `Math.round(amount * 100) !== amount * 100` therefore rejects amounts the user typed
 * perfectly correctly (1.1, 1.10, 1.15), which surfaced as "Deposit must be between $1
 * and $5,000" for perfectly valid input.
 *
 * The scaled value is compared against its rounded form with a tolerance instead. The
 * tolerance is far below one cent at any realistic amount, so genuine sub-cent input
 * such as 1.005 is still rejected, and the returned value is snapped to whole cents so
 * the number that gets stored is exactly the one that was meant.
 */

// Number.EPSILON-scaled so the tolerance grows with magnitude: a fixed absolute
// tolerance would wrongly accept a stray sub-cent digit on a very large amount.
function centTolerance(scaled) {
    return Math.max(1e-6, Math.abs(scaled) * Number.EPSILON * 4);
}

/**
 * Parses a decimal amount that has at most two decimal places.
 *
 * Returns the amount as a number snapped to cents, or null when the value is missing,
 * not a finite number, or carries sub-cent precision.
 */
function parseCents(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'string' && value.trim() === '') return null;

    const amount = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(amount)) return null;

    const scaled = amount * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > centTolerance(scaled)) return null;
    return rounded / 100;
}

/**
 * Parses a decimal amount and enforces an inclusive range.
 *
 * Returns null for anything that is not a cent-exact amount inside [min, max], so a
 * caller can treat a single null as one rejection reason. Pass `min` or `max` as
 * undefined to leave that side open.
 */
function parseAmountInRange(value, { min, max } = {}) {
    const amount = parseCents(value);
    if (amount === null) return null;
    if (min !== undefined && amount < min) return null;
    if (max !== undefined && amount > max) return null;
    return amount;
}

/**
 * Compares a provider-reported amount against the stored one.
 *
 * Provider payloads are decimal numbers that do not always round-trip through JSON
 * identically, so the comparison needs the same tolerance the parser uses. A difference
 * of more than one cent is a real mismatch and is rejected.
 */
function amountsMatch(a, b) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) < 0.005;
}

module.exports = { parseCents, parseAmountInRange, amountsMatch };
