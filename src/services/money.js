/**
 * Currency amount parsing shared by every endpoint that accepts a money value.
 *
 * Designed to handle floating-point representation artifacts, numeric string payloads,
 * and exact two-decimal-place cent matching without precision loss.
 */

/**
 * Checks if a string representation of a decimal has more than 2 decimal places.
 */
function hasSubCentStringPrecision(valStr) {
    const parts = valStr.split('.');
    return parts.length > 1 && parts[1].length > 2;
}

/**
 * Parses a decimal amount that has at most two decimal places.
 *
 * Returns the amount as a number snapped to exact cents, or null when the value is missing,
 * non-numeric, negative, or carries sub-cent precision (e.g., 1.005).
 */
function parseCents(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;

    const rawStr = String(value).trim();
    if (rawStr === '' || hasSubCentStringPrecision(rawStr)) return null;

    const amount = Number(rawStr);
    if (!Number.isFinite(amount) || amount < 0) return null;

    // Convert to total integer cents to bypass IEEE-754 float multiplication inaccuracies
    const totalCents = Math.round(amount * 100);

    // Verify back-converted amount matches original within sub-cent epsilon
    if (Math.abs(totalCents - amount * 100) > 0.1) {
        return null;
    }

    return totalCents / 100;
}

/**
 * Parses a decimal amount and enforces an inclusive range [min, max].
 *
 * Returns null for anything that is not a cent-exact amount inside [min, max].
 * Pass `min` or `max` as undefined to leave that side open.
 */
function parseAmountInRange(value, { min, max } = {}) {
    const amount = parseCents(value);
    if (amount === null) return null;

    if (min !== undefined && Number.isFinite(min) && amount < min) return null;
    if (max !== undefined && Number.isFinite(max) && amount > max) return null;

    return amount;
}

/**
 * Compares a provider-reported amount against the stored database value.
 *
 * Converts both operands through parseCents or exact integer cent comparison.
 * Returns true if amounts differ by less than $0.005 (1/2 cent).
 */
function amountsMatch(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;

    const parsedA = parseCents(a);
    const parsedB = parseCents(b);

    if (parsedA !== null && parsedB !== null) {
        return Math.round(parsedA * 100) === Math.round(parsedB * 100);
    }

    const left = parseFloat(a);
    const right = parseFloat(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;

    return Math.abs(left - right) < 0.005;
}

module.exports = { 
    parseCents, 
    parseAmountInRange, 
    amountsMatch 
};