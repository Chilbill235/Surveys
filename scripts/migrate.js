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

async function runMigrations() {
    const client = await pool.connect();
    try {
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
            .sort();

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
                await client.query('ROLLBACK');
                throw new Error(`Migration ${name} failed: ${error.message}`);
            }
            console.log(`Applied: ${name}`);
        }
    } finally {
        // Released explicitly rather than relying on connection close, so a failure to
        // acquire the lock cannot leave the session holding it.
        await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]).catch(() => {});
        client.release();
        await pool.end();
    }
}

runMigrations().catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
});
