const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingMigrations, describePendingMigrations, migrationFiles } = require('../src/services/schemaCheck');

/**
 * A stub pool, so the check can be exercised without a database.
 *
 * Only the one query the check makes is answered. Anything else throws, which is how a new
 * query added to the check shows up here as a failure rather than as a silently unanswered
 * read that made the check report "current" every time.
 */
function poolReporting(names) {
    return {
        query: async (query) => {
            assert.match(query, /FROM schema_migrations/);
            return { rows: names.map((name) => ({ name })) };
        }
    };
}

test('a fully migrated database reports nothing pending', async () => {
    const files = migrationFiles();
    assert.ok(files.length > 0, 'the repository must ship migrations for this check to mean anything');
    const result = await pendingMigrations(poolReporting(files));
    assert.deepEqual(result.missing, []);
    assert.equal(describePendingMigrations(result), null);
});

test('a migration this build has but the database lacks is named in the warning', async () => {
    const files = migrationFiles();
    const missing = files[files.length - 1];
    const result = await pendingMigrations(poolReporting(files.filter((name) => name !== missing)));

    assert.deepEqual(result.missing, [missing]);
    const message = describePendingMigrations(result);
    // The migration is named, and so is the command that fixes it. "The schema is out of
    // date" is the version of this message that sends someone to the database by hand.
    assert.match(message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(message, /npm run migrate/);
    assert.match(message, /1 migration /);
});

test('a database with no migration history is reported as unknown, not as up to date', async () => {
    // An unmigrated database has no `schema_migrations` table, so the read fails. Reporting
    // that as "nothing pending" would print nothing at all, which is the same silence this
    // check exists to end.
    const failing = { query: async () => { throw new Error('relation "schema_migrations" does not exist'); } };
    assert.equal(await pendingMigrations(failing), null);
    assert.equal(describePendingMigrations(null), null);
});

test('a database missing several migrations counts them and truncates the list', async () => {
    const files = migrationFiles();
    const missing = files.slice(0, 7);
    const result = await pendingMigrations(poolReporting(files.filter((name) => !missing.includes(name))));
    assert.equal(result.missing.length, 7);
    const message = describePendingMigrations(result);
    assert.match(message, /7 migrations /);
    assert.match(message, /and 2 more/);
    // Five names, then the summary, so the warning stays one readable line.
    assert.equal(message.split(', ').length > 5, true);
});
