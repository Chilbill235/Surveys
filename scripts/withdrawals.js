#!/usr/bin/env node

/**
 * Operator CLI for the maintenance endpoints.
 *
 * These exist because the alternative is editing the withdrawals table by hand, which is
 * how a request ends up marked `failed` with the money still debited. But the endpoints
 * need a shared secret and the right HTTP verb, and a browser address bar can supply
 * neither: it sends GET, and every state-changing action is POST. That is the whole
 * reason the refund endpoint looked like it did not exist.
 *
 *   node scripts/withdrawals.js list
 *   node scripts/withdrawals.js paid <id> <provider-reference>
 *   node scripts/withdrawals.js refund <id> "<reason the user will see>"
 *
 * Automatic crypto payouts are the same idea with the sending step done by the provider:
 *
 *   node scripts/withdrawals.js preflight   # is it configured and switched on?
 *   node scripts/withdrawals.js queue       # what would be sent (claims nothing)
 *   node scripts/withdrawals.js send [10]   # actually sends
 *
 * `send` moves real money. It is a named command rather than a flag on something else
 * so that it cannot happen as a side effect of looking.
 *
 * The target defaults to the local server and is overridden with BASE_URL:
 *
 *   BASE_URL=https://your-deployment.vercel.app node scripts/withdrawals.js list
 *
 * The secret is read from CRON_SECRET in the environment, or from .env / .env.local so it
 * does not have to be pasted into a shell history. It is never read from an argument, so
 * it cannot end up in `ps` output or in a transcript.
 */

const path = require('node:path');
const fs = require('node:fs');

// The .env files live next to the project root, not next to the current directory. Loading
// them by name would silently find nothing when the script is run from anywhere but the
// root, which is the most common way an operator gets an unexpected 404 from a missing
// secret rather than from a missing route.
const PROJECT_ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env.local') });
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

/** Node's fetch is only stable from 18 onward; the script refuses to guess. */
if (typeof fetch !== 'function') {
    console.error(
        `This script needs Node 18 or newer for the built-in fetch. You are on ${process.version}.`
    );
    process.exit(2);
}

/**
 * Where the maintenance endpoints live.
 *
 * `BASE_URL` wins over the built-in default so a deployment can be targeted from the same
 * terminal that runs the local server. A trailing slash is stripped so `BASE_URL=https://x/`
 * and `BASE_URL=https://x` produce the same URL.
 */
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

/** How long to wait before giving up on a request, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The commands and the HTTP request each one becomes.
 *
 * Every command returns `{ method, path, body }`, so the transport below has exactly one
 * shape to handle. Validation that depends on user input lives here, where the usage
 * message for that specific command can name the argument that is missing.
 */
const COMMANDS = {
    /** Lists every withdrawal still awaiting a decision. */
    list() {
        return { method: 'GET', path: '/api/maintenance/withdrawals' };
    },

    /** Marks a withdrawal as sent, with the reference that proves the transfer happened. */
    paid(args) {
        const [id, reference] = args;
        if (!id || !reference) {
            throw new UsageError('withdrawals.js paid <id> <provider-reference>');
        }
        if (!/^\d+$/.test(id)) {
            throw new UsageError(`Withdrawal id must be a number, got "${id}".`);
        }
        return {
            method: 'POST',
            path: `/api/maintenance/withdrawals/${id}/paid`,
            body: { providerReference: reference }
        };
    },

    /** Returns the money to the user and records why, so the history explains itself. */
    refund(args) {
        const [id, ...rest] = args;
        const reason = rest.join(' ').trim();
        if (!id || !reason) {
            throw new UsageError('withdrawals.js refund <id> "<reason>"');
        }
        if (!/^\d+$/.test(id)) {
            throw new UsageError(`Withdrawal id must be a number, got "${id}".`);
        }
        return {
            method: 'POST',
            path: `/api/maintenance/withdrawals/${id}/refund`,
            body: { reason }
        };
    },

    /**
     * Reports whether automatic crypto payouts could run, and what is missing if not.
     *
     * This endpoint is not registered yet in this build; a 404 from it is reported as
     * "not implemented" rather than as a failure, because the checks it would perform
     * are useful the moment it exists and misleading before then.
     */
    preflight() {
        return { method: 'GET', path: '/api/maintenance/payouts/preflight', notImplemented: true };
    },

    /** Lists the crypto withdrawals waiting to be sent. The default, and a dry run. */
    queue() {
        return {
            method: 'POST',
            path: '/api/maintenance/payouts/run',
            body: { dryRun: true },
            notImplemented: true
        };
    },

    /**
     * Actually sends. This moves real money to wallet addresses with nobody reading each
     * one, so it must be asked for by name rather than reached by omission.
     */
    send(args) {
        const limit = args[0] ? Number(args[0]) : 10;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new UsageError('withdrawals.js send [limit]  (limit is 1-200, default 10)');
        }
        return {
            method: 'POST',
            path: '/api/maintenance/payouts/run',
            body: { dryRun: false, limit },
            notImplemented: true
        };
    },

    /** Prints the command list. */
    help() {
        return { help: true };
    }
};

/** A usage error, separated from a transport error so the exit code can differ. */
class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

/**
 * Reads the shared secret, or explains what is missing.
 *
 * Throws rather than calling `process.exit`. Exiting from inside a promise is what
 * produces a `UnhandledPromiseRejection` line on top of the actual message, which is
 * how a missing secret used to look like two separate problems.
 */
function readSecret() {
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) {
        throw new UsageError(
            'CRON_SECRET is not set, so the maintenance endpoints will refuse this call.\n' +
            'Set it in the deployment environment and locally in .env or .env.local.\n' +
            `Looked in: ${path.join(PROJECT_ROOT, '.env.local')} and ${path.join(PROJECT_ROOT, '.env')}`
        );
    }
    return secret;
}

/**
 * Performs one authenticated request and returns `{ status, ok, body, headers }`.
 *
 * The response body is parsed as JSON when possible and returned as a string otherwise,
 * because the maintenance router sends plain text for some refusals (`Signature did not
 * match`, `Payment not fully settled yet`) and JSON for others, and a caller that only
 * handled one of the two would drop the reason.
 */
async function call({ method, path: requestPath, body }) {
    const url = `${BASE_URL}${requestPath}`;
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${readSecret()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await response.text();
    let parsed = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not JSON; the raw text is the most useful thing to show.
    }

    return { status: response.status, ok: response.ok, body: parsed, text };
}

/**
 * Reports the two most common failure modes separately.
 *
 * The maintenance router answers 404 both for "no such route" and for "the secret is
 * wrong" -- deliberately, so a prober cannot tell the difference. From the operator's
 * side, though, those are completely different problems, and the default script prints
 * the same generic failure for both. Probing `/ipn-diagnostics` first distinguishes
 * them: that route exists in every build, so a 404 from it means the secret is wrong,
 * and a 404 from any other endpoint means the route does not exist.
 */
async function diagnoseSecret() {
    try {
        const probe = await call({ method: 'GET', path: '/api/maintenance/ipn-diagnostics' });
        if (probe.status === 404) {
            return { secretOk: false, reason: 'The secret was refused (404 from a route that always exists).' };
        }
        if (probe.status === 503) {
            return { secretOk: false, reason: 'The server has no CRON_SECRET configured (503).' };
        }
        return { secretOk: probe.ok, reason: probe.ok ? null : `Probe returned ${probe.status}.` };
    } catch (error) {
        return { secretOk: null, reason: `Could not reach ${BASE_URL}: ${error.message}` };
    }
}

/** Renders a `list` result as a readable table, or as JSON when asked. */
function renderList(body, { json }) {
    if (json) {
        console.log(JSON.stringify(body, null, 2));
        return;
    }
    const rows = Array.isArray(body?.withdrawals) ? body.withdrawals : null;
    if (!rows) {
        console.log(JSON.stringify(body, null, 2));
        return;
    }
    if (rows.length === 0) {
        console.log('No withdrawals are awaiting a decision.');
        return;
    }
    console.log(`${rows.length} withdrawal(s) awaiting a decision:\n`);
    const header = ['id', 'user_id', 'amount', 'method', 'destination', 'status', 'created'];
    console.log(header.join('\t'));
    console.log(header.map((h) => '-'.repeat(Math.max(3, h.length))).join('\t'));
    for (const row of rows) {
        const destination = String(row.payment_address || '').slice(0, 40);
        const created = String(row.created_at || '').replace('T', ' ').slice(0, 19);
        console.log([
            row.id,
            row.user_id,
            row.amount,
            row.payment_method,
            destination,
            row.status,
            created
        ].join('\t'));
    }
    console.log('\nTo pay:    node scripts/withdrawals.js paid <id> "<reference>"');
    console.log('To refund: node scripts/withdrawals.js refund <id> "<reason>"');
}

/**
 * Turns a completed request into console output and an exit code.
 *
 * The exit codes matter when this is scripted: 0 for success, 1 for a refusal the server
 * explained, 2 for a usage or configuration error the operator has to fix, 3 for a
 * network failure that says nothing about the request itself.
 */
function report(response, { json }) {
    if (json) {
        console.log(JSON.stringify({
            status: response.status,
            ok: response.ok,
            body: response.body
        }, null, 2));
    } else if (response.ok) {
        console.log(typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body, null, 2));
    } else {
        console.error(`HTTP ${response.status}`);
        console.error(typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body, null, 2));
    }
    return response.ok ? 0 : 1;
}

const USAGE = `Usage: node scripts/withdrawals.js <command> [args]

  list                                     List withdrawals awaiting a decision
  paid <id> <provider-reference>           Mark a withdrawal as sent
  refund <id> "<reason>"                   Return funds to the user's balance
  preflight                                Check automatic payout configuration
  queue                                    Show what would be sent (nothing is claimed)
  send [limit]                             Send the queued payouts (moves real money)
  help                                     Print this message

Flags:
  --json                                   Print raw JSON instead of a table
  --url <base>                             Override BASE_URL for this run
  --quiet                                  Suppress output; use the exit code only

Environment:
  BASE_URL       Target host (default ${BASE_URL})
  CRON_SECRET    Shared secret for the maintenance endpoints
`;

/** Reads `--url <value>` from the argument list without touching the env. */
function extractUrlOverride(argv) {
    const at = argv.indexOf('--url');
    if (at === -1) return null;
    const value = argv[at + 1];
    if (!value) throw new UsageError('--url needs a value, for example --url https://example.com');
    argv.splice(at, 2);
    return value;
}

async function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
    const positional = argv.filter((arg) => !arg.startsWith('--'));

    const urlOverride = extractUrlOverride(argv);
    if (urlOverride) {
        // The override is applied by rewriting the module-level value the `call` function
        // reads. A parameter would be cleaner, but it would mean threading it through
        // every command and every diagnostic, and there is only one place it is used.
        process.env.BASE_URL = urlOverride;
    }

    const [name = 'help', ...args] = positional;
    const command = COMMANDS[name];
    if (!command) {
        throw new UsageError(`Unknown command "${name}".\n\n${USAGE}`);
    }

    const request = await command(args);
    if (request.help) {
        console.log(USAGE);
        return;
    }

    let response;
    try {
        response = await call(request);
    } catch (error) {
        // A network error is never a statement about the request, so it is reported
        // separately from an HTTP refusal. `fetch failed` alone would hide the reason.
        const reason = error.cause?.code || error.name || 'unknown';
        console.error(`Could not reach ${BASE_URL}: ${reason}`);
        console.error('Is the server running? Is BASE_URL correct?');
        process.exitCode = 3;
        return;
    }

    // A 404 is ambiguous on purpose from the server's side. From here it is unambiguous:
    // if the probe route answers, the secret is fine and the route is missing. If the
    // probe route also 404s, the secret is wrong.
    if (response.status === 404) {
        if (request.notImplemented) {
            console.error(
                `${request.method} ${request.path} is not implemented in this build.\n` +
                'The endpoint has to be registered in maintenanceRoutes.js before this ' +
                'command can be used.'
            );
            process.exitCode = 2;
            return;
        }
        if (!flags.has('--json') && !flags.has('--quiet')) {
            const diagnosis = await diagnoseSecret();
            if (diagnosis.secretOk === false) {
                console.error(diagnosis.reason);
                console.error('Check CRON_SECRET in the environment and in .env.');
                process.exitCode = 2;
                return;
            }
            if (diagnosis.secretOk === null) {
                console.error(diagnosis.reason);
                process.exitCode = 3;
                return;
            }
        }
    }

    if (flags.has('--quiet')) {
        process.exitCode = response.ok ? 0 : 1;
        return;
    }

    // `list` is the only command whose payload is worth tabulating. Everything else is
    // a confirmation whose shape is already decided by the endpoint.
    if (name === 'list' && response.ok) {
        renderList(response.body, { json: flags.has('--json') });
        process.exitCode = 0;
        return;
    }

    process.exitCode = report(response, { json: flags.has('--json') });
}

main().catch((error) => {
    if (error instanceof UsageError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
    }
    console.error(error.stack || error.message);
    process.exitCode = 1;
});