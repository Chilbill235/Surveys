const pool = require('../config/db');
const { createHash, timingSafeEqual } = require('node:crypto');
const { parseAmountInRange } = require('../services/money');

// ---------------------------------------------------------------------------
// Postback authentication
// ---------------------------------------------------------------------------

/**
 * The shape `clicks.click_id` has.
 *
 * The column is a UUID, and PostgreSQL raises `22P02` for any text that is not one, so an
 * unvalidated id turns a malformed postback into a 500 rather than the 400 that describes
 * it. A repeated query parameter is refused the same way: `String(['a','b'])` is `'a,b'`,
 * which is neither a UUID nor a lookup that could match.
 */
const CLICK_ID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const MAX_CLICK_ID_LENGTH = 64;

/**
 * Whether the request carries a secret that matches POSTBACK_SECRET.
 *
 * Two things that matter for the answer to be trustworthy:
 *
 *   - The two sides are compared in constant time. A naive `===` leaks the
 *     length and the prefix of the expected value through the timing of the
 *     comparison, which is a meaningful reduction in search space for an
 *     attacker who can send many requests.
 *   - The buffers being compared are always the same length, because
 *     `timingSafeEqual` requires it and throws otherwise. The expected value
 *     is hashed with a fixed prefix so both sides are exactly 32 bytes, and a
 *     length mismatch in the raw inputs cannot produce an early return that
 *     itself leaks information.
 */
function hasValidSecret(req) {
    const expected = String(process.env.POSTBACK_SECRET || '');
    // A development build without a secret accepts everything, deliberately:
    // the advertiser postbacks during local testing come from a network that
    // cannot reach a production secret anyway. Production fails closed.
    if (!expected) return process.env.NODE_ENV !== 'production';

    const supplied = String(req.get('x-postback-secret') || req.query.secret || '');
    if (!supplied) return false;

    const a = createHash('sha256').update(`postback:${expected}`).digest();
    const b = createHash('sha256').update(`postback:${supplied}`).digest();
    return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical states, and the provider strings that map to each.
 *
 * A Map rather than three arrays of alternatives: the lookup is one call, the
 * vocabulary is visible in one place, and adding a synonym is adding a key
 * rather than remembering which of three `if`s to edit.
 */
const STATUS_ALIASES = new Map([
    ['1', 'approved'], ['approved', 'approved'], ['complete', 'approved'],
    ['completed', 'approved'], ['success', 'approved'],
    ['0', 'rejected'], ['rejected', 'rejected'], ['declined', 'rejected'],
    ['failed', 'rejected'], ['reversed', 'rejected'], ['chargeback', 'rejected'],
    ['pending', 'pending'], ['hold', 'pending'], ['paused', 'pending'],
]);

function normalizeStatus(status) {
    const key = String(status || '').toLowerCase().trim();
    return STATUS_ALIASES.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

/**
 * The payout, as a dollar figure.
 *
 * The previous version called `parseCents`, which returns a value in cents. The
 * balance is in dollars everywhere else in the app -- a `$5,000` deposit lands
 * as `5000.00000000` on `users.balance`, and every other write treats the value
 * as dollars -- so adding a cents figure to it credited 100x the real amount.
 * `parseAmountInRange` is the same parser the deposit and withdrawal paths use,
 * so the units are the ones the balance is denominated in.
 *
 * Zero is allowed. Some networks send a tracking-only postback with no payout,
 * and the conversion row is still worth recording for the offer's completion
 * stats even though no money moved.
 */
function parsePayoutAmount(value) {
    return parseAmountInRange(value, { min: 0, max: 1_000_000 });
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const postbackController = {
    handleS2S: async (req, res) => {
        // No `Cache-Control` on the success path either: a proxy that caches a
        // 200 for a postback would suppress later retries of the same URL, and
        // the next legitimate state change would be lost.
        res.set('Cache-Control', 'no-store');

        if (!hasValidSecret(req)) {
            return res.status(403).send('Unauthorized postback.');
        }

        const rawClickId = req.query.click_id ?? req.body?.click_id;
        const clickId = Array.isArray(rawClickId) ? '' : String(rawClickId || '').trim();
        const payout = parsePayoutAmount(req.query.payout ?? req.body?.payout);
        const newStatus = normalizeStatus(req.query.status ?? req.body?.status);

        // The payout is allowed to be null only when the status is one where no
        // money changes hands. A rejected postback with no payout is legitimate;
        // an approved one is not, because there is nothing to credit.
        if (!clickId || clickId.length > MAX_CLICK_ID_LENGTH || newStatus === null) {
            return res.status(400).send('Invalid postback parameters.');
        }
        if (!CLICK_ID_PATTERN.test(clickId)) {
            return res.status(400).send('Invalid click ID.');
        }
        if (payout === null && newStatus === 'approved') {
            return res.status(400).send('An approved postback must include a payout amount.');
        }
        const payoutAmount = payout ?? 0;

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            // The click is locked for the whole transaction so two postbacks
            // for the same click cannot interleave. The lock is on `clicks` and
            // not on `conversions`, because the click row is the one that
            // exists on both the insert path and the update path.
            const clickRes = await client.query(
                `SELECT clicks.user_id, offers.is_demo, offers.payout AS offer_payout
                 FROM clicks
                 JOIN offers ON offers.id = clicks.offer_id
                 WHERE clicks.click_id = $1
                 FOR UPDATE OF clicks`,
                [clickId]
            );

            if (clickRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).send('Click ID not found.');
            }

            const { user_id: userId, is_demo: isDemo } = clickRes.rows[0];
            // What the catalog advertised this offer pays, read here so the amount that is
            // about to be credited is checked against a stored row rather than trusted from
            // the request. `|| 0` makes an absent or unreadable payout fail closed: an offer
            // with no recorded amount cannot have a postback that credits one.
            const offerPayout = Number(clickRes.rows[0].offer_payout) || 0;

            const convRes = await client.query(
                `SELECT payout, status, revision FROM conversions WHERE click_id = $1 FOR UPDATE`,
                [clickId]
            );

            const existingConv = convRes.rows[0] || null;
            const oldStatus = existingConv ? normalizeStatus(existingConv.status) : null;
            const oldPayout = existingConv ? Number(existingConv.payout) : 0;

            // A duplicate retry of the same postback has the same target state
            // and the same amount. Doing anything below -- updating the row,
            // writing to the ledger -- would be wasted work at best, and at
            // worst (the re-approval case) would hit the uniqueness on
            // `balance_transactions` and roll the whole transaction back.
            const stateUnchanged = existingConv
                && oldStatus === newStatus
                && oldPayout === payoutAmount;

            if (stateUnchanged) {
                await client.query('COMMIT');
                return res.status(200).send('OK');
            }

            // Every state *change* gets its own revision number, and the
            // revision is what makes the ledger source_id unique. A first
            // approval is revision 1, a chargeback is 2, a re-approval is 3,
            // and so on -- so a click that goes through the full cycle twice
            // does not collide with itself.
            const nextRevision = existingConv ? Number(existingConv.revision || 0) + 1 : 1;

            if (existingConv) {
                await client.query(
                    `UPDATE conversions
                     SET payout = $1, status = $2, revision = $3, updated_at = NOW()
                     WHERE click_id = $4`,
                    [payoutAmount, newStatus, nextRevision, clickId]
                );
            } else {
                await client.query(
                    `INSERT INTO conversions (click_id, payout, status, revision)
                     VALUES ($1, $2, $3, $4)`,
                    [clickId, payoutAmount, newStatus, nextRevision]
                );
            }

            // Demo conversions and anonymous clicks are tracked but never
            // credited: the first is a test offer and the second has no user to
            // credit. Both still keep a conversion row so the offer's own stats
            // are complete.
            const isEligibleUser = userId !== null && !isDemo;

            if (isEligibleUser) {
                // Crediting path. Gated on the transition rather than on the
                // target state, so a postback that re-announces an approval the
                // system already processed is a no-op rather than a second
                // credit.
                const shouldCredit = newStatus === 'approved'
                    && oldStatus !== 'approved'
                    && payoutAmount > 0;

                // Reversal path. Two guards, both necessary:
                //   - `oldStatus === 'approved'` means the click really was
                //     credited before.
                //   - `oldPayout > 0` means there is a positive number to take
                //     back. A click approved for $0 that is later rejected has
                //     nothing to reverse.
                const shouldReverse = oldStatus === 'approved'
                    && newStatus !== 'approved'
                    && oldPayout > 0;

                // A credit cannot be larger than the offer's own payout. This is the same rule
                // the deposit path follows -- a provider's payment id, amount, and currency
                // must match the stored deposit before anything is credited -- applied to the
                // other direction money enters the system. Without it the amount in the
                // postback is the only number that decides a balance, so anyone who can reach
                // this endpoint decides a balance.
                //
                // Only over-payment is refused. A network that pays less than advertised is
                // not a reason to refuse a real conversion, and the reversal path is
                // unaffected because it takes back what was credited.
                if (shouldCredit && payoutAmount > offerPayout) {
                    console.error(
                        `Refused a postback for click ${clickId}: it reports ${payoutAmount} ` +
                        `and the offer pays ${offerPayout}.`
                    );
                    await client.query('ROLLBACK');
                    return res.status(400).send('Postback payout does not match the offer payout.');
                }

                if (shouldCredit) {
                    await creditConversion(client, {
                        userId,
                        amount: payoutAmount,
                        clickId,
                        revision: nextRevision,
                        description: 'Approved offer conversion'
                    });
                } else if (shouldReverse) {
                    await reverseConversion(client, {
                        userId,
                        amount: oldPayout,
                        clickId,
                        revision: nextRevision,
                        description: 'Reversed or chargebacked offer conversion'
                    });
                }
            }

            await client.query('COMMIT');
            return res.status(200).send('OK');

        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('S2S Postback Error:', describeError(error));
            return res.status(500).send('Server Error');
        } finally {
            if (client) client.release();
        }
    }
};

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

/**
 * The two ledger writes, isolated so the transaction body above stays legible.
 *
 * Both use the same source_id shape -- `conversion:${clickId}:${revision}` or
 * `chargeback:${clickId}:${revision}` -- because the pair
 * (transaction_type, source_id) is unique. The revision is what makes a
 * re-approval after a chargeback produce a fresh key instead of colliding with
 * the original approval.
 */
async function creditConversion(client, { userId, amount, clickId, revision, description }) {
    const balance = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [amount, userId]
    );
    if (balance.rowCount !== 1) {
        throw new Error(`Could not credit user ${userId} for click ${clickId}.`);
    }

    await client.query(
        `INSERT INTO balance_transactions
            (user_id, amount, transaction_type, source_id, description)
         VALUES ($1, $2, 'conversion', $3, $4)`,
        [userId, amount, `conversion:${clickId}:${revision}`, description]
    );
}

async function reverseConversion(client, { userId, amount, clickId, revision, description }) {
    const balance = await client.query(
        'UPDATE users SET balance = balance - $1 WHERE id = $2 RETURNING balance',
        [amount, userId]
    );
    if (balance.rowCount !== 1) {
        throw new Error(`Could not reverse user ${userId} for click ${clickId}.`);
    }

    await client.query(
        `INSERT INTO balance_transactions
            (user_id, amount, transaction_type, source_id, description)
         VALUES ($1, $2, 'chargeback', $3, $4)`,
        [userId, -amount, `chargeback:${clickId}:${revision}`, description]
    );
}

/**
 * A message worth putting in a log.
 *
 * Node reports a connection failure as an `AggregateError` whose `message` is
 * the empty string, with the useful detail on `errors`. Logging `error` as-is
 * prints `AggregateError: ` with nothing after it, which is the least useful
 * possible report of "the database is unreachable".
 */
function describeError(error) {
    if (!error) return 'unknown error';
    if (error.message) return error.message;
    if (Array.isArray(error.errors) && error.errors.length > 0) {
        return error.errors.map((inner) => inner.message || String(inner)).join('; ');
    }
    if (error.code) return String(error.code);
    return String(error);
}

module.exports = postbackController;
// Exposed for the test suite, which needs to check the status aliases without
// driving a whole postback through the database.
module.exports.normalizeStatus = normalizeStatus;