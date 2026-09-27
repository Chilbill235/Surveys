const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const projectRoot = path.resolve(__dirname, '..');

async function main() {
    console.log('Running database migrations before build...');

    const migration = spawn(process.execPath, [path.join(__dirname, 'migrate.js')], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: process.env
    });

    const exitCode = await new Promise((resolve) => {
        migration.on('close', resolve);
        migration.on('error', (error) => {
            console.error('Could not start the migration runner:', error.message);
            resolve(1);
        });
    });

    if (exitCode !== 0) {
        console.error('Migrations failed. Aborting the build so an outdated schema is never deployed.');
        process.exit(exitCode || 1);
    }

    // Repo hygiene check: a committed .env or service-account key would expose live
    // provider secrets to anyone who can read the repository, so the build refuses to
    // continue. Vercel Environment Variables are the supported way to supply secrets.
    const forbiddenFiles = ['.env', '.env.local', '.env.production', 'service-account.json'];
    const leaked = forbiddenFiles.filter((name) => fs.existsSync(path.join(projectRoot, name)));
    if (leaked.length > 0) {
        console.error(`Build aborted: remove secret files from the repository (${leaked.join(', ')}) and set them as environment variables instead.`);
        process.exit(1);
    }

    const bundledEntryPoints = ['public/app.js', 'public/home.js', 'public/demo.js', 'public/reset-password.js'];
    for (const relativePath of bundledEntryPoints) {
        const absolutePath = path.join(projectRoot, relativePath);
        const source = fs.readFileSync(absolutePath, 'utf8');
        const size = zlib.gzipSync(Buffer.from(source)).length;
        console.log(`${relativePath}: ${source.length} bytes (${size} bytes gzipped)`);
    }

    console.log('Build checks passed.');
}

main().catch((error) => {
    console.error('Build failed:', error.message);
    process.exit(1);
});
