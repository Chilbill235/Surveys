const path = require('node:path');

/**
 * Loads `offerTaskSteps` against a stubbed pool, and records the queries it issues.
 *
 * Split out of the test file rather than inlined so the stub can both answer and report. The
 * recorded queries matter for the assertions about things enforced in SQL -- a `LIMIT`, a bound
 * parameter -- because a stub that returns whatever rows it was handed would pass a test about
 * how many rows come back no matter what the real code did.
 */

function loadModuleWithSpies(rows = []) {
    const servicePath = path.join(__dirname, '..', 'src', 'services', 'offerTaskSteps.js');
    const dbPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

    const seen = [];
    const previous = require.cache[dbPath];
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: {
            query: async (text, params) => {
                seen.push({ text, params });
                return { rows };
            }
        }
    };
    delete require.cache[require.resolve(servicePath)];
    const loaded = require(servicePath);
    if (previous) require.cache[dbPath] = previous;
    else delete require.cache[dbPath];

    return Object.assign({ seen }, loaded);
}

module.exports = { loadModuleWithSpies };