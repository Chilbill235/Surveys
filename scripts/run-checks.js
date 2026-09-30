/**
 * Runs every static check and reports all of them.
 *
 * The package script this replaces chained the checks with `&&`, so the first failure ended
 * the run and every later check was never executed. That is the wrong trade for a gate whose
 * purpose is to tell you everything that is broken: you fix one problem, re-run, and discover
 * the next one, one round trip at a time. It is worse than that when the failing check is one
 * you are not expecting -- a `check:frontend` failure masks a contrast regression entirely.
 *
 * So every check runs, each in its own process, and the failures are summarised at the end.
 * The exit code is non-zero if any of them failed, so this is still a usable CI gate.
 */
const { spawnSync } = require('child_process');

const CHECKS = [
    ['check:frontend', 'scripts/check-frontend.js'],
    ['check:responsive', 'scripts/check-responsive.js'],
    ['check:contrast', 'scripts/check-contrast.js'],
    ['check:a11y', 'scripts/check-a11y.js']
];

const failed = [];

for (const [name, script] of CHECKS) {
    console.log(`\n${'='.repeat(60)}\n${name}\n${'='.repeat(60)}`);
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
    if (result.error) {
        console.error(`${name} could not be run: ${result.error.message}`);
        failed.push(name);
    } else if (result.status !== 0) {
        failed.push(name);
    }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length === 0) {
    console.log(`ALL CHECKS PASSED (${CHECKS.length} run)`);
    process.exit(0);
}
console.log(`${failed.length} of ${CHECKS.length} CHECKS FAILED: ${failed.join(', ')}`);
process.exit(1);
