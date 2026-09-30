require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const pool = require('../src/config/db');

// A build can run migrations from several places at once (a Vercel build, a developer's
// machine, a manual `npm run migrate`). Without a lock, two runners see the same
// unapplied migration and both try to apply it, which deadlocks on DDL locks and can
// leave `schema_migrations` disagreeing with the schema. The key is arbitrary but
// fixed, so every runner contends on the same lock.
const migrationLockId = 728_441_903;

/**
 * Removes the transaction control statements a migration file carries.
 *
 * The runner wraps each file in its own transaction, but every migration file also opens
 * and closes one itself. Inside an open transaction the inner `BEGIN` is a no-op
 * ("there is already a transaction in progress") and the inner `COMMIT` ends the
 * runner's transaction early, so the marker INSERT that follows ran on its own and the
 * `ROLLBACK` in the error path could not undo anything the file had already applied. A
 * file that failed halfway left the schema partially migrated.
 *
 * The statements are stripped rather than removed from the files so each migration still
 * applies correctly when run directly through psql. They are matched one per line, which
 * is how they are written, so a string literal containing the word cannot be affected.
 */
function stripTransactionControl(sql) {
    return sql
        .split('\n')
        .filter((line) => !/^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;\s*$/i.test(line))
        .join('\n');
}

/**
 * Orders migration files by their leading number, not by their filename as text.
 *
 * `Array.prototype.sort()` on strings is lexicographic, so `'100_setup.sql'` sorts
 * before `'20_audit.sql'` and every migration numbered one hundred or more would be
 * applied before the ones it depends on. The numbering is well under 100 today, which
 * is exactly what makes this a trap rather than an observed failure: the day someone adds
 * a three-digit migration, `npm run migrate` applies it in the wrong order on a fresh
 * database -- and on an existing one it applies it after everything, because the earlier
 * migrations are already recorded as done and the ordering of the remainder is what
 * changes. The result is a schema that is missing whatever the out-of-order migration
 * assumed, with no error anywhere.
 *
 * The number is the leading run of digits. Files without one keep their relative order
 * and sort after the numbered ones, so a stray file is applied last rather than first.
 */
function compareMigrationFiles(a, b) {
    const numberOf = (name) => {
        const match = /^(\d+)/.exec(name);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    };

    const byNumber = numberOf(a) - numberOf(b);
    if (byNumber !== 0) return byNumber;
    // Same number, or neither has one: fall back to the filename so the order is at
    // least stable between runs of the same build.
    return a < b ? -1 : a > b ? 1 : 0;
}

async function runMigrations() {
    // `connect()` is inside the `try` because a failed connection must still close the
    // pool. It is the one query in this script most likely to fail before any migration
    // runs, and leaving the pool open on that path is what turns "the database is
    // unreachable" into a build that hangs until the platform kills it instead of one
    // that reports the reason and exits 1.
    let client;
    try {
        client = await pool.connect();
        // Build steps run against a fresh database, so lock waits should fail fast
        // instead of holding up a deployment.
        await client.query("SET statement_timeout = '120s'");
        await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);

        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        const migrationDirectory = path.join(__dirname, '..', 'db', 'migrations');
        const migrationFiles = (await fs.readdir(migrationDirectory))
            .filter((file) => file.endsWith('.sql'))
            .sort(compareMigrationFiles);

        for (const name of migrationFiles) {
            const applied = await client.query(
                'SELECT 1 FROM schema_migrations WHERE name = $1',
                [name]
            );
            if (applied.rows.length > 0) {
                console.log(`Already applied: ${name}`);
                continue;
            }

            const sql = stripTransactionControl(await fs.readFile(path.join(migrationDirectory, name), 'utf8'));
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
                await client.query('COMMIT');
            } catch (error) {
                // Best effort. A ROLLBACK that fails -- which is what happens when the
                // connection died rather than the statement being wrong -- must not be
                // allowed to escape this catch, because the rejection it raises replaces
                // the migration error with "connection terminated" and the operator is
                // left with a build failure that names no file and no line.
                await client.query('ROLLBACK').catch(() => {});
                throw new Error(`Migration ${name} failed: ${describeError(error)}`);
            }
            console.log(`Applied: ${name}`);
        }
    } finally {
        // Released explicitly rather than relying on connection close, so a failure to
        // acquire the lock cannot leave the session holding it. Skipped when there is no
        // client, which is the case this `try` block was widened to cover.
        if (client) {
            await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]).catch(() => {});
            client.release();
        }
        await pool.end();
    }
}

/**
 * A message worth putting in a build log.
 *
 * A connection failure reaches here as an `AggregateError` whose `message` is the empty
 * string, with the actual reason on `errors` -- so `error.message` prints as nothing and
 * the build fails with `Migration failed:` and no explanation. The pool carries a
 * `describeError` that walks the error and its causes; it is used when present so the
 * operator is told the host is refusing connections rather than being given a blank.
 */
function describeError(error) {
    if (typeof pool.describeError === 'function') return pool.describeError(error);
    return error?.message || String(error);
}

runMigrations().catch((error) => {
    console.error('Migration failed:', describeError(error));
    process.exitCode = 1;
});
