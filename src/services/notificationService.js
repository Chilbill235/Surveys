const pool = require('../config/db');

/**
 * The durable record of what has been told to a user, and whether they have read it.
 *
 * The bell used to be built entirely in the browser from `sessionStorage`, which meant a
 * notification existed only while the tab that made it was open. This module is the other half of
 * that: the server writes the event, and the API reads it, so the same notification is there on a
 * phone, after a restart, and for a reader who was never signed in when it happened.
 *
 * The shape of the data is already decided by the client -- `category`, `tone`, `title`, `message`,
 * `href`, `recordId` -- because the renderer that exists consumes exactly that. Nothing is invented
 * here that the UI cannot already draw; the change is where the row lives, not what it says.
 *
 * Every function takes a `userId` and scopes to it in the `WHERE` clause, including the ones that
 * take a notification id. A notification id is guessable -- they are a sequence -- so an unscoped
 * `UPDATE ... WHERE id = $1` would let one reader mark another's notification read. The scope is not
 * a convenience, it is the authorisation.
 */

// The list is paged the same way the history list is: `limit`/`offset` in, `X-Total-Count` out, so
// the bell can show "12 unread" without having read 12 notifications.
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function clampLimit(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}

function clampOffset(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
}

/**
 * One row, in the shape the client renders.
 *
 * `record_id` comes back as `recordId` and `read_at` as a boolean plus `readAt`. The client needs
 * the boolean to pick the unread styling and the timestamp to show when it was read; sending the
 * raw column and letting each side convert it is how the two drift.
 */
function shape(row) {
    return {
        id: String(row.id),
        category: row.category,
        tone: row.tone,
        title: row.title,
        message: row.message || null,
        href: row.href || null,
        recordId: row.record_id === null || row.record_id === undefined ? null : String(row.record_id),
        read: row.read_at !== null && row.read_at !== undefined,
        readAt: row.read_at || null,
        createdAt: row.created_at,
        timestamp: row.created_at
    };
}

/**
 * Record an event, once.
 *
 * The insert is `ON CONFLICT DO NOTHING` against the partial unique index on
 * (user_id, category, record_id). That is what makes it safe to call from every code path that can
 * observe the same event: a deposit is credited by the provider webhook, by the reconciliation job
 * and by an operator retry, and each of those calls this. Without the conflict clause the reader
 * would get the same message three times, once per path -- and since the bell is a list, three
 * copies of "Deposit credited" look like three deposits.
 *
 * A notification with no `recordId` is not deduplicated, because a system notice is not about one
 * record and two of them are two different messages. The partial index excludes those rows for
 * exactly that reason.
 *
 * Returns the row as it now stands -- the existing one on a conflict, the new one otherwise -- so
 * a caller can use the id it just got back. Never throws for a duplicate: a duplicate is the
 * expected case, not an error.
 */
async function record({ userId, category, tone = 'info', title, message = null, href = null, recordId = null }) {
    if (!userId) throw new Error('record() needs a userId');
    if (!title) throw new Error('record() needs a title');
    if (!category) throw new Error('record() needs a category');

    const result = await pool.query(
        `INSERT INTO notifications (user_id, category, tone, title, message, href, record_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, category, record_id) WHERE record_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [userId, category, tone, title, message, href, recordId === null || recordId === undefined ? null : String(recordId)]
    );

    if (result.rows.length > 0) return { created: true, notification: shape(result.rows[0]) };

    // The conflict path. Read the row back so the caller still gets an id to act on -- marking "this
    // one is read" needs to know which one "this one" is, and the caller does not have the id
    // because the insert did not happen.
    const existing = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 AND category = $2 AND record_id = $3 LIMIT 1',
        [userId, category, String(recordId)]
    );
    return {
        created: false,
        notification: existing.rows.length > 0 ? shape(existing.rows[0]) : null
    };
}

/**
 * The reader's notifications, newest first, with the total for the unread badge.
 *
 * The unread count is a separate cheap query rather than a `COUNT` over the returned page, because
 * the badge answers "how many are waiting" and the page answers "what are they". A reader with 40
 * unread and 30 returned is not a bug, and reading the badge off the page size would report 0.
 */
async function list(userId, { limit, offset, unreadOnly = false } = {}) {
    const take = clampLimit(limit);
    const skip = clampOffset(offset);

    const where = unreadOnly ? 'user_id = $1 AND read_at IS NULL' : 'user_id = $1';

    const [rows, unread] = await Promise.all([
        pool.query(
            `SELECT * FROM notifications
             WHERE ${where}
             ORDER BY id DESC
             LIMIT $2 OFFSET $3`,
            unreadOnly ? [userId, take, skip] : [userId, take, skip]
        ),
        pool.query(
            'SELECT COUNT(*)::INT AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
            [userId]
        )
    ]);

    return {
        notifications: rows.rows.map(shape),
        total: rows.rows.length,
        unread: unread.rows[0] ? unread.rows[0].count : 0
    };
}

async function unreadCount(userId) {
    const result = await pool.query(
        'SELECT COUNT(*)::INT AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [userId]
    );
    return result.rows[0] ? result.rows[0].count : 0;
}

/**
 * Mark one read. Scoped to the owner, so a guessed id cannot mark somebody else's.
 *
 * `read_at = COALESCE(read_at, NOW())` rather than `NOW()`: marking an already-read notification
 * read again should not move the moment it was read, and a reader who re-opens a notification
 * should see the time they first read it.
 */
async function markRead(userId, id) {
    const result = await pool.query(
        `UPDATE notifications
         SET read_at = COALESCE(read_at, NOW())
         WHERE user_id = $1 AND id = $2
         RETURNING *`,
        [userId, id]
    );
    return result.rows.length > 0 ? shape(result.rows[0]) : null;
}

async function markAllRead(userId) {
    const result = await pool.query(
        `UPDATE notifications
         SET read_at = COALESCE(read_at, NOW())
         WHERE user_id = $1 AND read_at IS NULL
         RETURNING id`,
        [userId]
    );
    return result.rowCount;
}

/**
 * Remove one. A delete rather than a hide: the reader asked for it to be gone, and leaving the row
 * with a dismissed flag means the next "mark all read" counts it.
 *
 * Scoped to the owner, as everywhere else here.
 */
async function remove(userId, id) {
    const result = await pool.query(
        'DELETE FROM notifications WHERE user_id = $1 AND id = $2 RETURNING id',
        [userId, id]
    );
    return result.rowCount > 0;
}

async function clearAll(userId) {
    const result = await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    return result.rowCount;
}

/**
 * Fire-and-forget wrapper for call sites that must not be held up by, or broken by, the bell.
 *
 * A deposit credit is the important case: the money is already in the balance and the ledger row is
 * already written, and a failing insert into `notifications` must not roll any of that back. A
 * dropped notification is a much smaller failure than a failed deposit, so this logs and returns
 * rather than rethrowing. It is a named function so the swallowing is visible at the call site
 * instead of being a bare `.catch()` with no explanation of why it is allowed.
 */
function recordInBackground(details) {
    return record(details).catch((error) => {
        // eslint-disable-next-line no-console -- this is the only place a notification failure is
        // allowed to be silent, and it is exactly where it must not be silent.
        console.error(`[notifications] could not record "${details.title}" for user ${details.userId}:`, error.message);
        return { created: false, notification: null };
    });
}

module.exports = {
    record,
    recordInBackground,
    list,
    unreadCount,
    markRead,
    markAllRead,
    remove,
    clearAll
};