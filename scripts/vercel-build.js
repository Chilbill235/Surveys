const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const projectRoot = path.resolve(__dirname, '..');

/**
 * Runs the migrations, retrying transient database failures.
 *
 * A build that aborts on the first connection error is the wrong trade: the schema is not
 * optional, but neither is the build. Serverless Postgres in particular refuses
 * connections for a few seconds while a compute instance resumes, and two builds racing
 * the same database can collide on the advisory lock the migration runner takes. Both look
 * like an unreachable database and both resolve on their own within a handful of seconds,
 * so they are retried before the build is failed.
 *
 * A real schema error is not retried. `migrate.js` reports a non-zero exit for both, and
 * only the connection-shaped failures are indistinguishable from a transient one by exit
 * code alone -- so every attempt is retried, and the last output is shown either way. The
 * cost of retrying a genuine SQL error is a slower failed build; the cost of not retrying
 * a cold database is an undeployable site.
 */
const MIGRATION_ATTEMPTS = 4;
const MIGRATION_BACKOFF_MS = [0, 3000, 8000, 15000];

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The files git is tracking, or null when git cannot answer.
 *
 * Uses the index rather than the working tree, because a file can be present on disk,
 * ignored, and still be tracked -- and the tracked set is the one that gets deployed.
 */
function trackedFiles() {
    const result = spawnSync('git', ['ls-files'], { cwd: projectRoot, encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function runMigrations() {
    return new Promise((resolve) => {
        const migration = spawn(process.execPath, [path.join(__dirname, 'migrate.js')], {
            cwd: projectRoot,
            stdio: 'inherit',
            env: process.env
        });
        migration.on('close', resolve);
        migration.on('error', (error) => {
            console.error('Could not start the migration runner:', error.message);
            resolve(1);
        });
    });
}

async function migrateWithRetries() {
    for (let attempt = 0; attempt < MIGRATION_ATTEMPTS; attempt += 1) {
        const backoff = MIGRATION_BACKOFF_MS[attempt] || 0;
        if (backoff > 0) {
            console.log(`Retrying migrations in ${backoff}ms (attempt ${attempt + 1}/${MIGRATION_ATTEMPTS})...`);
            await wait(backoff);
        }
        const exitCode = await runMigrations();
        if (exitCode === 0) return 0;
        console.warn(`Migrations exited with code ${exitCode}.`);
    }
    return 1;
}

async function main() {
    console.log('Running database migrations before build...');

    if (await migrateWithRetries() !== 0) {
        console.error('Migrations failed. Aborting the build so an outdated schema is never deployed.');
        process.exit(1);
    }

    // Repo hygiene check: a committed .env or service-account key would expose live
    // provider secrets to anyone who can read the repository, so the build refuses to
    // continue. Vercel Environment Variables are the supported way to supply secrets.
    //
    // What is checked is what git *tracks*, not what is on disk. Every developer has a
    // local .env -- the app cannot run without one -- so testing for existence made the
    // build script unrunnable outside CI, which is where it actually matters. The risk
    // being guarded against is a file being committed, and only a tracked file is at risk.
    const forbiddenFiles = ['.env', '.env.local', '.env.production', 'service-account.json'];
    const tracked = trackedFiles();
    const leaked = forbiddenFiles.filter((name) =>
        tracked === null
            ? fs.existsSync(path.join(projectRoot, name))
            : tracked.has(name)
    );
    if (leaked.length > 0) {
        console.error(`Build aborted: remove secret files from the repository (${leaked.join(', ')}) and set them as environment variables instead.`);
        process.exit(1);
    }
    console.log(tracked === null
        ? 'Secret-file check skipped: git is unavailable, so nothing could be confirmed tracked.'
        : `Secret-file check passed: none of ${forbiddenFiles.join(', ')} is tracked by git.`);

    const bundledEntryPoints = [
        'public/app.js',
        'public/home.js',
        'public/demo.js',
        'public/reset-password.js',
        'public/deposit-receipt.js'
    ];
    for (const relativePath of bundledEntryPoints) {
        const absolutePath = path.join(projectRoot, relativePath);
        const source = fs.readFileSync(absolutePath, 'utf8');
        const size = zlib.gzipSync(Buffer.from(source)).length;
        console.log(`${relativePath}: ${source.length} bytes (${size} bytes gzipped)`);
    }

    // The routing table is the one piece of configuration where a typo takes the whole
    // site down silently: a bad `rewrites` entry serves the SPA shell for the click
    // tracking hop, so every offer leads back to the catalog and nothing reports an error.
    // It is parsed and sanity-checked here, where a failure is still a build failure.
    verifyRouting();

    console.log('Build checks passed.');
}

/**
 * Fails the build on a routing configuration that would break click tracking.
 *
 * The specific failure this exists to catch is a rewrite that sends every non-API path to
 * `index.html`. That is the correct-looking SPA setup, and it is exactly wrong here: the
 * click hop is `/offer/engage`, which is not under `/api`, so the advertiser redirect is
 * swallowed and the user lands back on the offers page with no error anywhere. The home
 * page, the password reset page, and every deposit receipt break the same way.
 */
function verifyRouting() {
    const configPath = path.join(projectRoot, 'vercel.json');
    if (!fs.existsSync(configPath)) {
        console.error('vercel.json is missing, so there is no routing configuration to verify.');
        process.exit(1);
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.error(`vercel.json is not valid JSON: ${error.message}`);
        process.exit(1);
    }

    const rewrites = config.rewrites || [];
    const catchAll = rewrites.find((rule) => !/^\/api\//.test(rule.source));
    if (!catchAll) {
        console.error('vercel.json rewrites every non-API path nowhere, so /offer/engage, /, /reset-password, and /deposit/:id will 404.');
        process.exit(1);
    }
    if (/index\.html$/.test(catchAll.destination)) {
        console.error(
            'vercel.json sends non-API paths to index.html. That swallows /offer/engage, ' +
            'so clicking an offer returns the user to the catalog instead of the advertiser, ' +
            'and breaks /, /reset-password, and /deposit/:id. Point it at the function instead.'
        );
        process.exit(1);
    }
    if (!/^\/api\//.test(catchAll.destination)) {
        console.error(`vercel.json routes page requests to ${catchAll.destination}, which is not a function.`);
        process.exit(1);
    }
    console.log(`Routing verified: ${catchAll.source} -> ${catchAll.destination}`);
}

main().catch((error) => {
    console.error('Build failed:', error.message);
    process.exit(1);
});
