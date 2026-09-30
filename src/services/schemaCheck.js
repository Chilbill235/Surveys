const fs = require('fs');
const path = require('path');

/**
 * Which migration files this build expects the database to have applied.
 *
 * By leading number rather than as text. `Array.prototype.sort()` on strings is lexicographic,
 * so `'100_setup.sql'` sorts before `'20_audit.sql'`, and the comparison the migration runner
 * uses is here too so this check cannot disagree with the order migrations were actually
 * applied in. Files without a leading number sort last.
 */
function compareMigrationFiles(a, b) {
    const numberOf = (name) => {
        const match = /^(\d+)/.exec(name);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    };
    const byNumber = numberOf(a) - numberOf(b);
    if (byNumber !== 0) return byNumber;
    return a.localeCompare(b);
}

function migrationFiles() {
    const directory = path.join(__dirname, '..', '..', 'db', 'migrations');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort(compareMigrationFiles);
}

/**
 * Reports migration files this build has but the database has never applied.
 *
 * Why this exists
 * ---------------
 * A column added by a migration is invisible to the code that uses it until the query runs.
 * The email-preference switch shipped with its migration and its query together, and every
 * test passed, because the tests stubbed the pool. The real database had never been migrated,
 * so the first signed-in user to flip the switch got a `column does not exist` error and a
 * switch that silently sprang back. Nothing at startup said the schema was behind, and the
 * only symptom appeared in production, on one control, after the code looked finished.
 *
 * The question here is deliberately narrow: not "is the schema correct" -- `scripts/audit-sql.js`
 * answers that against the live schema -- but "is the database at least as far along as this
 * build assumes". That gap is the one that turns a deploy into a runtime error.
 *
 * Returns `null` when the answer cannot be determined, because a database that cannot be
 * reached is a different problem and reporting it as "0 migrations pending" would be a lie
 * that hides the real failure. Returns `{ missing: [...] }` otherwise, empty when current.
 */
async function pendingMigrations(pool) {
    let applied;
    try {
        applied = await pool.query('SELECT name FROM schema_migrations');
    } catch {
        // No `schema_migrations` table at all: either the database has never been migrated,
        // which `npm run migrate` fixes, or the query is not permitted. Either way there is
        // nothing here that can distinguish "behind" from "not a migrated database", and
        // guessing wrong in either direction produces a message that is not actionable.
        return null;
    }

    const known = new Set(applied.rows.map((row) => row.name));
    return { missing: migrationFiles().filter((name) => !known.has(name)) };
}

/** The operator-facing line, or null when the schema is current. */
function describePendingMigrations(result) {
    if (!result || result.missing.length === 0) return null;
    const count = result.missing.length;
    const list = result.missing.slice(0, 5).join(', ');
    const rest = count > 5 ? `, and ${count - 5} more` : '';
    return (
        `the connected database is missing ${count} migration${count === 1 ? '' : 's'} this build expects ` +
        `(${list}${rest}). Code paths that use the new tables or columns will fail until they are applied. ` +
        'Run `npm run migrate` against the same DATABASE_URL this process is using.'
    );
}

module.exports = { pendingMigrations, describePendingMigrations, migrationFiles, compareMigrationFiles };
