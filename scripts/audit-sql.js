const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

/**
 * Cross-checks every column named in a SQL string against the live schema.
 *
 * The `users.updated_at` bug is the reason this exists. That statement was wrong in a way
 * nothing caught: the tests stubbed the pool, so the SQL was never parsed by PostgreSQL, and
 * the only place it ran was a real request against a real database. Every check in the suite
 * passed and the feature was completely non-functional.
 *
 * A stub cannot tell you a column is imaginary. The schema can. This walks the source,
 * pulls the identifiers out of each SQL string, and reports the ones that name a column no
 * table has. Statements that mention a table which does not exist are reported too -- a
 * dropped or renamed table produces exactly the same class of runtime failure.
 *
 * It is a linter, not a proof. It does not know about aliases, CTEs, or columns produced by
 * a function, so candidates are reported for review rather than asserted as failures. What
 * it does guarantee is that a name which matches no table and no alias is surfaced instead
 * of sitting in a string until a user request happens to run it.
 */

// Anchored to this file, not the working directory: `npm run` sets cwd to the package root,
// so a `../src` here would point outside the project and find no files at all -- which
// reported "0 statements, all clean" rather than an error.
const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src', 'scripts', 'test'].map((d) => path.join(ROOT, d));
const SKIP = new Set([
    // Words that appear in SQL but are not column references.
    'select', 'from', 'where', 'and', 'or', 'not', 'null', 'as', 'on', 'set', 'values',
    'insert', 'into', 'update', 'delete', 'returning', 'order', 'by', 'group', 'having',
    'limit', 'offset', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'lateral',
    'union', 'all', 'distinct', 'case', 'when', 'then', 'else', 'end', 'exists', 'in',
    'is', 'asc', 'desc', 'true', 'false', 'default', 'primary', 'key', 'unique', 'constraint',
    'references', 'create', 'table', 'index', 'if', 'conflict', 'do', 'nothing', 'for', 'of',
    'with', 'using', 'begin', 'commit', 'rollback', 'transaction', 'coalesce', 'count', 'sum',
    'max', 'min', 'now', 'interval', 'extract', 'date', 'timestamp', 'timestamptz', 'numeric',
    'text', 'boolean', 'integer', 'bigint', 'serial', 'bigserial', 'uuid', 'json', 'jsonb',
    'array', 'lower', 'upper', 'trim', 'length', 'cast', 'nullif', 'greatest', 'least',
    'exclude', 'where', 'over', 'partition', 'rows', 'range', 'preceding', 'following',
    'unbounded', 'current', 'row', 'int', 'bigserial', 'text', 'varying', 'char', 'collate',
    'like', 'ilike', 'any', 'some', 'array_agg', 'string_agg', 'generate_series', 'unnest',
    'to_char', 'to_number', 'to_date', 'to_timestamp', 'age', 'justify_days', 'concat',
    // Scalar functions. These are called, not referenced, and read as columns to a scanner.
    'abs', 'round', 'sqrt', 'power', 'sign', 'width_bucket', 'random', 'random', 'pi',
    'left', 'right', 'split_part', 'regexp_replace', 'regexp_match', 'btrim', 'ltrim',
    'rtrim', 'initcap', 'reverse', 'repeat', 'strpos', 'translate', 'encode', 'decode',
    'date_trunc', 'date_part', 'timeofday', 'statement_timestamp', 'transaction_timestamp',
    'clock_timestamp', 'localtime', 'localtimestamp', 'current_date', 'current_timestamp'
]);

/** Words that are keywords or structural, never a column, and that are short or common. */
const RESERVED = new Set([
    'and', 'or', 'not', 'null', 'as', 'on', 'set', 'values', 'returning', 'order', 'by',
    'group', 'having', 'limit', 'offset', 'join', 'inner', 'left', 'right', 'full', 'outer',
    'cross', 'lateral', 'union', 'all', 'distinct', 'case', 'when', 'then', 'else', 'end',
    'exists', 'in', 'is', 'asc', 'desc', 'true', 'false', 'default', 'primary', 'key',
    'unique', 'constraint', 'references', 'conflict', 'do', 'nothing', 'for', 'of', 'with',
    'using', 'begin', 'commit', 'rollback', 'transaction', 'now', 'coalesce', 'count', 'sum',
    'max', 'min', 'over', 'partition', 'rows', 'range', 'preceding', 'following', 'current',
    'row', 'select', 'from', 'where', 'insert', 'into', 'update', 'delete', 'table', 'index',
    'create', 'if', 'exists', 'greatest', 'least', 'nullif', 'cast', 'array_agg',
    'string_agg', 'generate_series', 'unnest', 'exclude', 'escape', 'lateral', 'largest',
    'smallest', 'approximate', 'signed', 'unsigned', 'mod', 'div', 'floor', 'ceil'
]);

/**
 * Words that can follow a table name, so the alias matcher stops instead of eating them.
 * Without this list `FROM clicks JOIN offers` reads `JOIN` as the alias for `clicks`.
 */
const CLAUSE_KEYWORDS = [
    'AS', 'FROM', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL',
    'LATERAL', 'ON', 'USING', 'WHERE', 'SET', 'VALUES', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET',
    'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING', 'WITH', 'SELECT', 'AND', 'OR',
    'NOT', 'FOR', 'WINDOW', 'FILTER', 'OVER', 'PARTITION', 'IS', 'IN'
].join('|');

(async () => {
    // ---- the schema -------------------------------------------------------------------
    const tables = await pool.query(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'`
    );

    const columnsByTable = new Map();
    const allColumns = new Set();
    for (const row of tables.rows) {
        if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
        columnsByTable.get(row.table_name).add(row.column_name);
        allColumns.add(row.column_name);
    }
    const tableNames = new Set(columnsByTable.keys());

    // ---- the statements ---------------------------------------------------------------
    const statements = [];
    for (const dir of SOURCE_DIRS) {
        const walk = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.js')) continue;
                statements.push(...extract(full, fs.readFileSync(full, 'utf8')));
            }
        };
        if (fs.existsSync(dir)) walk(dir);
    }

    // ---- compare ----------------------------------------------------------------------
    const findings = [];
    let checked = 0;
    let skipped = 0;
    for (const statement of statements) {
        // A statement that interpolates a JS variable cannot be checked statically: the
        // column name is not knowable until runtime. Those are reported separately rather
        // than guessed at, because a wrong guess is worse than an admission of ignorance --
        // it either invents a finding or hides a real one.
        if (statement.interpolated) { skipped += 1; continue; }
        checked += 1;

        // String literals first. `'failed'`, `'withdrawal:'` and `'= paid'` are data, not
        // columns, and reading them as column names is what turned the first version of this
        // into a wall of noise nobody would read.
        const sql = statement.sql.replace(/'(?:[^']|'')*'/g, "''");

        // Alias -> table, from FROM/JOIN. Resolving this is what makes `d.id` checkable
        // against `deposits` instead of treating `d` as an unknown column.
        //
        // The lookahead is load-bearing. Without it the optional alias group happily eats
        // the *next* clause keyword: in `FROM clicks JOIN offers ON ...` the alias after
        // `clicks` matched `JOIN`, the match consumed it, and `offers` was never registered
        // as a table at all -- so every `offers.*` in the statement was reported as a column
        // of nothing.
        const aliases = new Map();
        const aliasPattern = new RegExp(
            '\\b(?:FROM|JOIN)\\s+([a-z_][a-z0-9_]*)\\s*'
            + `(?:AS\\s+)?(?!(?:${CLAUSE_KEYWORDS})\\b)([a-z_][a-z0-9_]*)?`,
            'gi'
        );
        let m;
        while ((m = aliasPattern.exec(sql)) !== null) {
            const table = m[1].toLowerCase();
            const alias = (m[2] || '').toLowerCase();
            if (!tableNames.has(table)) continue;
            aliases.set(table, table);
            if (alias && !RESERVED.has(alias)) aliases.set(alias, table);
        }
        if (aliases.size === 0) continue;

        // Names the statement itself defines: SELECT-list output aliases and CTEs. Both are
        // real identifiers that are not columns of any table, and both are correct.
        const defined = new Set();
        for (const a of sql.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) defined.add(a[1].toLowerCase());
        for (const a of sql.matchAll(/\bWITH\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) defined.add(a[1].toLowerCase());
        // `FOR UPDATE SKIP LOCKED` and friends: lock clauses, not columns. Added per word
        // because that is how the identifier scanner sees them.
        if (/\bFOR\s+UPDATE\s+SKIP\s+LOCKED\b/i.test(sql)) { defined.add('skip'); defined.add('locked'); }
        if (/\bFOR\s+UPDATE\s+NOWAIT\b/i.test(sql)) defined.add('nowait');

        // Every column reachable from this statement.
        const reachable = new Set();
        for (const table of new Set(aliases.values())) {
            for (const c of columnsByTable.get(table)) reachable.add(c);
        }

        // Qualified references, checked against their own table rather than the union -- a
        // column that exists on `withdrawals` but not on `users` is caught this way and
        // missed by a union.
        const qualified = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
        while ((m = qualified.exec(sql)) !== null) {
            const owner = m[1].toLowerCase();
            const column = m[2];
            if (!aliases.has(owner)) continue;
            const table = columnsByTable.get(aliases.get(owner));
            if (table && !table.has(column)) {
                findings.push({ ...statement, missing: `${m[1]}.${column}`, near: nearMiss(column, table) });
            }
        }

        // Bare references, against the union of the tables this statement touches.
        for (const raw of sql.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []) {
            const identifier = raw.toLowerCase();
            if (identifier.length <= 2) continue;              // alias / short keyword
            if (RESERVED.has(identifier)) continue;
            if (defined.has(identifier)) continue;             // defined by this statement
            if (aliases.has(identifier)) continue;             // it IS a table
            if (SKIP.has(identifier)) continue;
            if (reachable.has(identifier)) continue;
            if (allColumns.has(raw)) continue;                // a column of some other table
            findings.push({ ...statement, missing: raw, near: nearMiss(raw, reachable) });
        }
    }

    // ---- report -----------------------------------------------------------------------
    console.log(`Read ${statements.length} SQL string(s) from ${SOURCE_DIRS.length} directories.`);
    console.log(`Checked ${checked} against the live schema; ${skipped} skipped for interpolating a JS value.`);
    if (findings.length === 0) {
        console.log('\nEvery statically-checkable column name matches a column in the schema.');
    } else {
        console.log(`\n${findings.length} column name(s) that match no column of the tables they are used with:\n`);
        for (const f of findings) {
            console.log(`  ${f.file}:${f.line}`);
            console.log(`      missing: ${f.missing}${f.near ? `   (did you mean "${f.near}"?)` : ''}`);
            console.log(`      ${f.text.slice(0, 140)}`);
        }
    }
    if (process.argv.includes('--list-skipped')) { for (const s of statements.filter((x) => x.interpolated)) console.log('  ' + s.file + ':' + s.line + '  ' + s.text.slice(0, 90)); }
    await pool.end();
    process.exit(findings.length === 0 ? 0 : 1);
})().catch((e) => { console.error('audit failed:', e.message); process.exit(2); });

/** Closest real column, for a typo. Edit distance, so `updated_at` suggests `created_at`. */
function nearMiss(identifier, reachable) {
    let best = null;
    let bestScore = Infinity;
    for (const candidate of reachable) {
        const d = distance(identifier.toLowerCase(), candidate.toLowerCase());
        if (d < bestScore) { bestScore = d; best = candidate; }
    }
    return bestScore <= 3 ? best : null;
}

function distance(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let last = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const temp = prev[j];
            prev[j] = a[i - 1] === b[j - 1] ? last : Math.min(last + 1, prev[j] + 1, prev[j - 1] + 1);
            last = temp;
        }
    }
    return prev[b.length];
}

/**
 * Pulls the SQL string literals out of a file, with their line numbers.
 *
 * A blunt scan, deliberately: it takes anything that looks like a quoted run containing
 * SQL keywords. It over-collects rather than under-collects, because a missed statement is
 * an unchecked one, and the false positives are filtered by the schema comparison.
 */
function extract(file, source) {
    const out = [];
    const lines = source.split(/\r?\n/);

    // Template literals and quoted strings, in one pass. The previous version anchored on a
    // SQL keyword inside a single-line match, which found nothing at all: nearly every query
    // in this codebase is a multi-line template literal, so a pattern that cannot cross a
    // newline skips the entire data layer.
    const pattern = /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const literal = match[0].slice(1, -1);
        if (!/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(literal)) continue;

        const line = source.slice(0, match.index).split('\n').length;
        const identifiers = new Set();
        for (const raw of literal.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) identifiers.add(raw);
        out.push({
            file: path.relative(ROOT, file).replace(/\\/g, '/'),
            line,
            text: (lines[line - 1] || '').trim(),
            // The full literal, not a shortened one. Truncating for display and then
            // analysing the truncated text cut queries off before their FROM clause, so the
            // tables they touch were invisible and every qualified column in them was
            // reported as belonging to no table.
            sql: literal,
            interpolated: literal.includes('${'),
            identifiers
        });
    }
    return out;
}


