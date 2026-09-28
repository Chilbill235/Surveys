#!/usr/bin/env node

/**
 * Operator CLI for the maintenance endpoints.
 *
 * These exist because the alternative is editing the withdrawals table by hand, which is how
 * a request ends up marked `failed` with the money still debited. But the endpoints need a
 * shared secret and the right HTTP verb, and a browser address bar can supply neither: it
 * sends GET, and every state-changing action is POST. That is the whole reason the refund
 * endpoint looked like it did not exist.
 *
 * This is the intended way to call them, so the verb, the secret header, and the JSON body
 * do not have to be got right by hand each time.
 *
 *   node scripts/withdrawals.js list
 *   node scripts/withdrawals.js paid <id> <provider-reference>
 *   node scripts/withdrawals.js refund <id> "<reason the user will see>"
 *
 * The target defaults to the local server and is overridden with BASE_URL:
 *
 *   BASE_URL=https://your-deployment.vercel.app node scripts/withdrawals.js list
 *
 * The secret is read from CRON_SECRET in the environment, or from .env / .env.local so it
 * does not have to be pasted into a shell history. It is never read from an argument, so it
 * cannot end up in `ps` output or in a transcript.
 */

require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

const COMMANDS = {
    /** Lists every withdrawal still awaiting a decision. */
    async list() {
        return { method: 'GET', path: '/api/maintenance/withdrawals' };
    },

    /** Marks a withdrawal as sent, with the reference that proves the transfer happened. */
    async paid(args) {
        const [id, reference] = args;
        if (!id || !reference) {
            throw new Error('Usage: withdrawals.js paid <id> <provider-reference>');
        }
        return {
            method: 'POST',
            path: `/api/maintenance/withdrawals/${id}/paid`,
            body: { providerReference: reference }
        };
    },

    /** Returns the money to the user and records why, so the history explains itself. */
    async refund(args) {
        const [id, ...rest] = args;
        const reason = rest.join(' ').trim();
        if (!id || !reason) {
            throw new Error('Usage: withdrawals.js refund <id> "<reason>"');
        }
        return {
            method: 'POST',
            path: `/api/maintenance/withdrawals/${id}/refund`,
            body: { reason }
        };
    }
};

function readSecret() {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.error(
            'CRON_SECRET is not set, so the maintenance endpoints will refuse this call.\n' +
            'Set it in the deployment environment and locally in .env.local.'
        );
        process.exit(2);
    }
    return secret;
}

function describe(body) {
    // The endpoints answer either an `ok` payload or a refusal. Printed as-is rather than
    // prettified into something that hides a field: a status this script reports as success
    // must be checkable by eye.
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

async function main() {
    const [name, ...args] = process.argv.slice(2);
    const command = COMMANDS[name];
    if (!command) {
        console.error(`Usage: node scripts/withdrawals.js <${Object.keys(COMMANDS).join('|')}>`);
        process.exit(2);
    }

    const request = await command(args);
    const response = await fetch(`${BASE_URL}${request.path}`, {
        method: request.method,
        headers: {
            Authorization: `Bearer ${readSecret()}`,
            ...(request.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: request.body ? JSON.stringify(request.body) : undefined
    });

    const text = await response.text();
    let body = text;
    try {
        body = JSON.parse(text);
    } catch {
        // Not JSON: the raw body is the most useful thing to show.
    }

    if (!response.ok) {
        console.error(`${request.method} ${request.path} -> ${response.status}`);
        describe(body);
        process.exit(1);
    }
    describe(body);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
