/**
 * Registers an account for a live test and fails clearly when the database is down.
 *
 * A 503 means DATABASE_URL does not point at a reachable database, a `database system
 * is starting up` state, or a missing schema. Treating that as a normal failure inside
 * a test obscures the real cause, so it is converted into an explicit message.
 *
 * The base URL is supplied by the test file because it depends on the ephemeral port
 * the test server is listening on.
 */
const databaseUnavailableMessage = 'DATABASE_URL does not point at a reachable database. ' +
    'Start PostgreSQL, set DATABASE_URL, and run `npm run migrate` before the live tests.';

async function registerOrExplain(origin, email, password) {
    const response = await fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (response.status === 503) {
        throw new Error(databaseUnavailableMessage);
    }
    return response;
}

module.exports = { registerOrExplain, databaseUnavailableMessage };
