const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/config/db');
const notificationService = require('../src/services/notificationService');

/**
 * The durable notification record.
 *
 * This is what makes a notification survive the tab closing, and the properties worth protecting
 * are the ones that fail invisibly -- the bell still renders, the balance is still right, and the
 * user is simply told something twice, or never, or about someone else's money:
 *
 *   - the same event written twice (a webhook, a reconciliation sweep and an operator retry all
 *     observe the same deposit credit) producing three bell entries saying "Deposit credited";
 *   - one reader marking or deleting another reader's notification, because the ids are a
 *     sequence and therefore guessable;
 *   - the unread badge reading the size of the returned page instead of counting unread rows;
 *   - a notification write failing a request that had already committed a deposit credit.
 */

/**
 * Runs `work` with the database boundary recorded rather than executed.
 *
 * `pool.connect` is replaced as well as `pool.query` because `pg` implements `query` on top of
 * `connect`: replacing only `query` leaves the real one calling a callback the replacement never
 * invokes, and the request waits forever instead of failing.
 *
 * SQL is recorded alongside its parameters. A statement's meaning usually lives in the placeholders
 * -- asserting on the text alone would check that a query ran, not that it ran with the right
 * user id in it.
 */
async function withDatabase(work, answers = []) {
    const originalConnect = pool.connect;
    const originalQuery = pool.query;
    const statements = [];

    const record = (query, params) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        statements.push({ sql, params: params || [] });
        for (const { pattern, result, error } of answers) {
            if (pattern.test(sql)) {
                if (error) return Promise.reject(error);
                const value = typeof result === 'function' ? result() : result;
                return { rows: value.rows || [], rowCount: value.rowCount ?? (value.rows || []).length };
            }
        }
        return { rows: [], rowCount: 0 };
    };

    const client = { query: async (query, params) => record(query, params), release: () => {} };
    pool.connect = async () => client;
    pool.query = async (query, params) => record(query, params);

    try {
        return { result: await work(statements), statements };
    } finally {
        pool.connect = originalConnect;
        pool.query = originalQuery;
    }
}

function rows(list) {
    return { rows: list, rowCount: list.length };
}

const DEPOSIT = {
    id: '7', category: 'deposit', tone: 'success', title: 'Deposit credited',
    message: 'Your deposit of $10.00 has been added to your balance.', href: null,
    record_id: '42', read_at: null, created_at: '2026-09-30T12:00:00Z'
};

/**
 * Every stage of every money event, with the key the dedup index will see.
 *
 * This exists because the stages were originally one category per *kind* -- `deposit` for a
 * credit and a failure, `withdrawal` for a request, a payment and a refund. With the index on
 * (user, category, record id) that silently swallows whichever stage is recorded second: a reader
 * is told their withdrawal was requested, the payout lands, and the "Withdrawal sent" notification
 * is discarded as a duplicate. Nothing errors and nothing is visible in the bell -- which is the
 * failure mode this table exists to make impossible to reintroduce.
 */
const STAGES = [
    ['deposit', 'depositCredited', { depositId: 42, amount: 10 }],
    ['deposit_failed', 'depositFailed', { depositId: 42, amount: 10 }],
    ['withdrawal_requested', 'withdrawalSubmitted', { withdrawalId: 77, amount: 25 }],
    ['withdrawal_paid', 'withdrawalPaid', { withdrawalId: 77, amount: 25 }],
    ['withdrawal_failed', 'withdrawalFailed', { withdrawalId: 77, amount: 25, refunded: true }]
];

test('every stage of a record is a distinct category, so no stage is deduplicated away', async () => {
    const { result, statements } = await withDatabase(
        () => notificationService.record({ userId: 5, category: 'withdrawal_requested', recordId: 77, title: 'Withdrawal requested' }),
        [{ pattern: /INSERT INTO notifications/, result: () => rows([{ ...DEPOSIT, id: '1', category: 'withdrawal_requested', record_id: '77' }]) }]
    );

    assert.equal(result.created, true);
    // The key is (user, category, record id). Withdrawing the category leaves the three
    // withdrawal stages sharing one key, and only the first would ever be written.
    const keys = STAGES.map(([category, , args]) => `5|${category}|${args.depositId ?? args.withdrawalId}`);
    assert.equal(new Set(keys).size, STAGES.length, `two stages share a dedup key: ${keys.join(' , ')}`);
    assert.equal(statements[0].params[1], 'withdrawal_requested');
});

test('the recorded category is the one the caller asked for', async () => {
    // A service that overrode the category with its own default would pass the test above while
    // still collapsing stages, so the assertion is that the caller's value is what is stored.
    const eventNotifications = require('../src/services/eventNotifications');

    const { statements } = await withDatabase(
        async () => {
            for (const [, fn, args] of STAGES) {
                await eventNotifications[fn]({ userId: 5, ...args });
            }
        },
        [{ pattern: /INSERT INTO notifications/, result: () => rows([DEPOSIT]) }]
    );

    const stored = statements.map((entry) => entry.params[1]);
    assert.deepEqual(stored, STAGES.map(([category]) => category));
    // And every one of them names the record, so each is navigable and each dedups on its own key.
    for (const entry of statements) {
        assert.notEqual(entry.params[6], null, 'a stage with no record id cannot be deduplicated or linked');
    }
});

function only(sql, statements) {
    return statements.filter((entry) => sql.test(entry.sql));
}

test('recording a notification stores the event the renderer needs', async () => {
    const { result, statements } = await withDatabase(
        () => notificationService.record({
            userId: 5,
            category: 'deposit',
            recordId: 42,
            tone: 'success',
            title: 'Deposit credited',
            message: 'Your deposit of $10.00 has been added to your balance.'
        }),
        [{ pattern: /INSERT INTO notifications/, result: () => rows([DEPOSIT]) }]
    );

    assert.equal(result.created, true);
    // `record_id` is text on purpose: a notification can be about a ledger id, a provider id, or
    // nothing. The renderer needs a string and a boolean, not a raw column.
    assert.equal(result.notification.recordId, '42');
    assert.equal(result.notification.read, false);
    assert.equal(result.notification.timestamp, '2026-09-30T12:00:00Z');
    // A stored read timestamp has to become the boolean the client branches on, and it has to be a
    // boolean: `read_at ? ...` is false for a row that has been read.
    assert.equal(typeof result.notification.read, 'boolean');
    assert.equal(statements[0].params[0], 5);
});

test('the insert is written to tolerate the same event arriving twice', async () => {
    const { statements } = await withDatabase(
        () => notificationService.record({ userId: 5, category: 'deposit', recordId: 42, title: 'Deposit credited' }),
        [{ pattern: /INSERT INTO notifications/, result: () => rows([DEPOSIT]) }]
    );

    const insert = only(/INSERT INTO notifications/, statements)[0];
    // This clause is the whole reason a deposit credited by both the webhook and the reconciliation
    // sweep produces one bell entry rather than two. Without it the second call inserts, and the
    // reader is told the same thing twice about the same deposit.
    assert.match(insert.sql, /ON CONFLICT/i, 'no conflict clause -- a repeated event duplicates');
    // Partial, because a notification with no record must not be deduplicated against every other
    // one that has no record: two unrelated system notices are two different messages.
    assert.match(insert.sql, /WHERE record_id IS NOT NULL/i, 'the conflict target is not the partial index');
});

test('a repeat event returns the existing notification rather than nothing', async () => {
    const { result } = await withDatabase(
        () => notificationService.record({ userId: 5, category: 'deposit', recordId: 42, title: 'Deposit credited' }),
        [
            // The `ON CONFLICT DO NOTHING RETURNING` insert returns no rows on the repeat path.
            { pattern: /INSERT INTO notifications/, result: () => rows([]) },
            { pattern: /SELECT \* FROM notifications/, result: () => rows([{ ...DEPOSIT, id: '3' }]) }
        ]
    );

    assert.equal(result.created, false);
    // The caller still gets an id. Marking "this one is read" needs to know which one "this one"
    // is, and on the conflict path the insert never returned one.
    assert.equal(result.notification.id, '3');
    assert.equal(result.notification.recordId, '42');
});

test('every read and write is scoped to the owner', async () => {
    // The ids are a sequence, so a notification id is guessable. An `UPDATE ... WHERE id = $1`
    // without the user would let one reader mark another's notification read, or delete it.
    const { statements } = await withDatabase(async () => {
        await notificationService.markRead(5, 9);
        await notificationService.remove(5, 9);
        await notificationService.markAllRead(5);
        await notificationService.clearAll(5);
    }, [
        { pattern: /UPDATE notifications SET read_at = COALESCE\(read_at, NOW\(\)\)/, result: () => rows([{ ...DEPOSIT, id: '9' }]) },
        { pattern: /DELETE FROM notifications WHERE user_id/, result: () => ({ rowCount: 1 }) }
    ]);

    for (const entry of statements) {
        assert.equal(entry.params[0], 5, `unscoped statement: ${entry.sql}`);
        assert.match(entry.sql, /user_id = \$1/, `statement does not filter on the owner: ${entry.sql}`);
    }
    // `markRead` takes a read first, then the update. An `UPDATE ... RETURNING` alone would
    // suffice; the shape matters only in that both halves are scoped, which is asserted above.
    assert.equal(only(/UPDATE notifications/, statements).length, 2, 'expected markRead and markAllRead');
    assert.equal(only(/DELETE FROM notifications/, statements).length, 2, 'expected remove and clearAll');
});

test('marking read does not move the moment it was read', async () => {
    const { statements } = await withDatabase(
        () => notificationService.markRead(5, 9),
        [{ pattern: /UPDATE notifications/, result: () => rows([{ ...DEPOSIT, id: '9' }]) }]
    );

    // Re-opening a notification should show when it was first read, not when it was last clicked.
    // A plain `read_at = NOW()` rewrites it every time the reader looks at it again.
    assert.match(only(/UPDATE notifications/, statements)[0].sql, /COALESCE\(read_at, NOW\(\)\)/);
});

test('marking all read only touches unread rows', async () => {
    const { statements } = await withDatabase(
        () => notificationService.markAllRead(5),
        [{ pattern: /UPDATE notifications/, result: () => ({ rowCount: 3 }) }]
    );

    const update = only(/UPDATE notifications/, statements)[0];
    assert.match(update.sql, /read_at IS NULL/, 'already-read rows were rewritten');
    // Marking all read reports how many it changed so the client can repaint without a second read.
    assert.equal(update.params[1], undefined, 'no expected count was passed');
});

test('the unread badge counts unread rows, not the size of the page', async () => {
    const { result } = await withDatabase(
        () => notificationService.list(5, { limit: 30, offset: 0 }),
        [
            { pattern: /SELECT \* FROM notifications/, result: () => rows([]) },
            { pattern: /COUNT\(\*\)::INT AS count/, result: () => rows([{ count: 12 }]) }
        ]
    );

    // A reader with 12 unread and 0 returned is not a bug. Reading the badge off the page size
    // would report 0, and the bell would show nothing while the list held entries.
    assert.equal(result.unread, 12);
    assert.equal(result.total, 0);
});

test('the list is newest first and paged', async () => {
    const { statements } = await withDatabase(
        () => notificationService.list(5, { limit: 10, offset: 20 }),
        [
            { pattern: /SELECT \* FROM notifications/, result: () => rows([]) },
            { pattern: /COUNT\(\*\)::INT AS count/, result: () => rows([{ count: 0 }]) }
        ]
    );

    const page = only(/SELECT \* FROM notifications/, statements)[0];
    assert.match(page.sql, /ORDER BY id DESC/, 'the newest notification has to be first');
    assert.equal(page.params[1], 10);
    assert.equal(page.params[2], 20);
});

test('a page size beyond the cap is clamped rather than trusted', async () => {
    const { statements } = await withDatabase(
        () => notificationService.list(5, { limit: '100000', offset: -5 }),
        [
            { pattern: /SELECT \* FROM notifications/, result: () => rows([]) },
            { pattern: /COUNT\(\*\)::INT AS count/, result: () => rows([{ count: 0 }]) }
        ]
    );

    const page = only(/SELECT \* FROM notifications/, statements)[0];
    assert.equal(page.params[1], 100, 'an unbounded limit was passed through');
    assert.equal(page.params[2], 0, 'a negative offset was passed through');
});

test('an unread-only list filters on the server', async () => {
    const { statements } = await withDatabase(
        () => notificationService.list(5, { unreadOnly: true }),
        [
            { pattern: /SELECT \* FROM notifications/, result: () => rows([]) },
            { pattern: /COUNT\(\*\)::INT AS count/, result: () => rows([{ count: 4 }]) }
        ]
    );

    assert.match(only(/SELECT \* FROM notifications/, statements)[0].sql, /read_at IS NULL/);
});

test('a background write that fails does not throw at the caller', async () => {
    // A deposit credit is already committed by the time this runs. A failing insert into
    // notifications must not roll that back: a dropped notification is a far smaller failure than a
    // failed deposit, and this is the call the money paths use.
    const { result } = await withDatabase(
        () => notificationService.recordInBackground({ userId: 5, category: 'deposit', recordId: 42, title: 'Deposit credited' }),
        [{ pattern: /INSERT INTO notifications/, error: new Error('connection terminated unexpectedly') }]
    );

    assert.deepEqual(result, { created: false, notification: null });
});

test('a record with nothing identifying it is refused before it reaches the database', async () => {
    const { statements } = await withDatabase(async () => {
        await assert.rejects(() => notificationService.record({ userId: 5, title: 'no category' }));
        await assert.rejects(() => notificationService.record({ userId: 5, category: 'deposit' }));
        await assert.rejects(() => notificationService.record({ category: 'deposit', title: 'no user' }));
    });

    assert.equal(statements.length, 0, 'an invalid record still reached the database');
});

test('a notification with no record stores null, not the text "null"', async () => {
    // As far as the unique index is concerned the literal string "null" is a real record_id, so a
    // system notice written twice under the same "null" id would have the second one swallowed.
    const { result, statements } = await withDatabase(
        () => notificationService.record({ userId: 5, category: 'system', title: 't', recordId: undefined }),
        [{ pattern: /INSERT INTO notifications/, result: () => rows([{ ...DEPOSIT, id: '1', category: 'system', record_id: null }]) }]
    );

    assert.equal(statements[0].params[6], null);
    assert.equal(result.notification.recordId, null);
});
