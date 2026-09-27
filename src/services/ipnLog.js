/**
 * A small in-memory record of what the NOWPayments callback endpoint has actually seen.
 *
 * The question "is the provider sending the IPN, or are we rejecting it?" has no answer
 * from the outside: both look identical, because in both cases the balance never moves.
 * Before this, the only signal was a line in the log for the handful of cases that
 * reached a `console.error`, so a callback that was never delivered and one that was
 * delivered and refused early looked the same from the dashboard.
 *
 * Every request to the endpoint records an outcome, so the log answers the question
 * directly: an empty log means nothing arrived, and a log full of refusals with a reason
 * means something arrived and was rejected.
 *
 * Deliberately not persisted. This is a diagnostic tail, not an audit trail -- the
 * durable record of what actually happened to a deposit is the deposits table and
 * `payment_provider_events`. It also never records a signature, a secret, or a full
 * address, because it survives in memory and is exposed over HTTP.
 */

const MAX_ENTRIES = 40;
const RETENTION_MS = 6 * 60 * 60 * 1000;

/** @type {Array<{at: string, outcome: string, detail: string, paymentId: string|null, orderId: string|null, status: string|null}>} */
const entries = [];
let lastReceivedAt = null;
let totals = { received: 0, accepted: 0, refused: 0 };

/**
 * Records the outcome of one callback.
 *
 * `outcome` is deliberately coarse -- received / accepted / refused -- because that is
 * the distinction an operator can act on. The detail line says which check failed.
 */
function record({ outcome, detail, paymentId = null, orderId = null, status = null }) {
    const at = new Date().toISOString();
    totals.received += 1;
    if (outcome === 'accepted') totals.accepted += 1;
    else if (outcome === 'refused') totals.refused += 1;
    // Records *arrival*, not acceptance. A callback that arrived and was refused is still
    // proof the provider is sending, which is the whole question being answered here, so
    // gating this on acceptance made it read as "nothing arrived" in exactly the case an
    // operator most needs to investigate.
    lastReceivedAt = at;

    entries.push({ at, outcome, detail, paymentId, orderId, status });
    prune(at);
}

function prune(nowIso) {
    const cutoff = new Date(nowIso).getTime() - RETENTION_MS;
    while (entries.length > MAX_ENTRIES) entries.shift();
    while (entries.length > 0 && new Date(entries[0].at).getTime() < cutoff) entries.shift();
}

/**
 * The most recent entries, newest first, plus enough summary to read at a glance.
 *
 * `lastReceivedAt` answers "is the provider sending at all?" -- it is set by any arrival,
 * accepted or refused. The entries then answer "what happened to the ones that arrived?".
 */
function snapshot() {
    return {
        lastReceivedAt,
        totals: { ...totals },
        entries: [...entries].reverse()
    };
}

/** Test seam: drops the record so one run cannot leak state into the next. */
function reset() {
    entries.length = 0;
    lastReceivedAt = null;
    totals = { received: 0, accepted: 0, refused: 0 };
}

module.exports = { record, snapshot, reset };
