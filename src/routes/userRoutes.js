const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const requireAuth = require('../middlewares/requireAuth');
const pool = require('../config/db');
const paymentController = require('../controllers/paymentController');
const { rateLimitByIp } = require('../services/security');
const { register: registerMethod } = require('./methodRegistry');
const emailPreferences = require('../services/emailPreferences');
const profile = require('../services/profile');
const withdrawalResolution = require('../services/withdrawalResolution');
const { explorerLinks } = require('../services/explorerLinks');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Page size for the two history endpoints. Extracted because the receipt page
 * and the history page must agree on it: a user who sees "20 most recent" in
 * the UI and then cannot find an older row in the receipt lookup is reporting
 * the same bug from two directions.
 */
const HISTORY_PAGE_SIZE = 20;

/**
 * The most rows `/history` will return, whatever the caller asks for.
 *
 * The endpoint takes a `limit` so the transactions page can paginate and the CSV export can
 * cover more than one screen, and an unbounded value would let a caller pull an entire lifetime
 * of ledger rows in a single request. This is a ceiling on the response, not a policy about how
 * much history exists.
 */
const HISTORY_MAX_LIMIT = 500;

/**
 * The `transaction_type` values `/history` will filter on.
 *
 * A closed list, so `?type=` is matched against a known vocabulary rather than passed through
 * to decide what comes back. The client renders exactly these five tabs, and the endpoint
 * answering "no rows" for anything else is what lets the page count stay truthful: a filter the
 * server does not recognise cannot contribute a `X-Total-Count` that disagrees with the rows.
 *
 * Kept next to the pagination constants because both exist for the same reason -- the endpoint
 * is asked questions about a list rather than only being asked for the list.
 */
const HISTORY_FILTER_TYPES = new Set(['deposit', 'withdrawal', 'conversion', 'chargeback', 'refund', 'adjustment']);

/**
 * Reads a positive integer from a query parameter, ignoring anything else.
 *
 * Both parameters are attacker-controlled, so neither is interpolated into the SQL as text: they
 * are returned as numbers and still bound as `$2`/`$3`, and the range check is what stops a
 * negative or absurd value reaching the database at all. `Number.parseInt('10abc')` is 10, which
 * is lenient in a way that is fine for a display size and wrong for anything that mattered --
 * so the whole string is required to be digits instead.
 */
function positiveIntFromQuery(value, fallback, max) {
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value.trim())) return fallback;
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
}

/**
 * A Postgres BIGINT holds up to 19 digits. A longer numeric string is not a
 * valid id, so it does not need to reach the database at all.
 */
const RECORD_ID_PATTERN = /^\d{1,19}$/;

/**
 * The `source_id` prefix used when a withdrawal refund is written to the
 * ledger. It must match the value the withdrawal service writes, because the
 * history query joins on it: if the two drift, a refunded withdrawal silently
 * shows no `refunded_at`, which is the exact "the money came back and I cannot
 * see it" question this join was added to answer.
 */
const WITHDRAWAL_REFUND_SOURCE_PREFIX = 'withdrawal:';

/**
 * Postgres / network error codes that mean "the database is not reachable", as
 * opposed to "the query was wrong". Classified in one place so every handler
 * on this router returns the same status for the same underlying problem, and
 * so it matches the classification the auth router already makes.
 */
const DB_UNREACHABLE_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

/**
 * The rate limit applied to the two routes that spend money: a deposit
 * creation and a withdrawal request.
 *
 * The name reflects that both routes are financial mutations, not just
 * deposits: the previous `depositLimit` name was applied to `/withdraw` as
 * well, which is the kind of mismatch that leads to one of the two being
 * dropped in a refactor because it "looks like the wrong limiter."
 *
 * The limiter keys on IP because that is what the shared service does. The
 * trade-off is that a shared NAT shares the budget; the alternative (keying on
 * `req.user.id`, which IS available here because `requireAuth` runs first) is
 * more precise and worth switching to if the service gains a user-keyed form.
 * That is a change to `services/security`, so it is left as a note rather than
 * done silently here.
 */
const financialMutationLimit = rateLimitByIp({
    name: 'financial-mutation',
    maxAttempts: 10,
    windowSeconds: 15 * 60,
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Every route on this router requires a valid JWT. Registered before any
// handler so a future route added below is authenticated by default rather
// than by remembering to add the middleware.
router.use(requireAuth);

/**
 * Marks a response as per-user and uncacheable.
 *
 * Every route on this router returns account-specific data: balances,
 * withdrawal history, deposit history, one user's deposit by id. A shared
 * cache or a browser's back/forward cache serving one user another's history
 * is the kind of incident that turns a support ticket into a security report.
 */
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Adds the link a confirmed deposit can be viewed at.
 *
 * Built from the request's own origin rather than a configured base URL,
 * because the receipt is a link the current user follows right now, in this
 * browser. A stored APP_BASE_URL is what provider callbacks are built from,
 * which is a different question and can legitimately be a tunnel while the
 * user is on localhost.
 */
function withDepositDetails(deposit) {
    return {
        ...deposit,
        receipt_url: `/receipt/deposit/${deposit.id}`,
        // A deposit gets an address link and never a transaction link, and that is a statement
        // about what the provider tells us rather than an omission. The NOWPayments callback
        // carries the payment id, the amounts and the status -- and no on-chain transaction hash
        // for an incoming payment, because the provider is the one transacting, not us. So the
        // only honest explorer link is to the address, which is what lets someone watch the
        // payment they just sent actually land.
        explorer: explorerLinks({
            assetCode: deposit.asset_code,
            network: deposit.network,
            address: deposit.deposit_address
        })
    };
}

/**
 * The same for a withdrawal, plus the block-explorer links.
 *
 * A withdrawal had no receipt at all, which is why every withdrawal notification pointed at the
 * account page: a user told their money had been sent, who then had to find the one row it was
 * in among a list of a dozen. The explorer links are the other half -- `provider_reference` is
 * the only place the on-chain transaction is recorded, and it was in a JSON field nobody
 * outside the operator tools could read, so the one fact a user wants when a payout lands (did
 * it actually go, and can I check) was not available to them.
 *
 * A `pending` withdrawal is not a payment, so it gets no receipt link here either. Sending
 * someone a receipt for a request that has not been attempted says the transaction exists when
 * there is nothing yet to look up.
 */
function withWithdrawalDetails(withdrawal) {
    const settled = ['paid', 'failed', 'cancelled'].includes(String(withdrawal.status || '').toLowerCase());
    const explorer = explorerLinks({
        assetCode: withdrawal.asset_code,
        network: withdrawal.network,
        transactionReference: withdrawal.provider_reference,
        address: withdrawal.payout_address || withdrawal.payment_address
    });
    return {
        ...withdrawal,
        ...(settled ? { receipt_url: `/receipt/withdrawal/${withdrawal.id}` } : {}),
        explorer
    };
}

/**
 * The deposit or withdrawal a ledger row is about, or null.
 *
 * A ledger row is one row in a table shared by deposits, withdrawals, rewards, refunds and manual
 * adjustments, and the only thing on it that points at a record is `source_id` -- which has
 * three different shapes depending on which kind of row this is:
 *
 *   - a deposit credit carries `deposit_id` directly (migration 027), because `source_id` holds
 *     the *provider's* payment id and so could never say which of our deposits it was;
 *   - a withdrawal debit carries the bare withdrawal id, `87`;
 *   - a refund carries `withdrawal:87`, prefixed.
 *
 * A client told to figure that out would be re-deriving it from three spellings, and would get
 * it subtly wrong the day a fourth row type is added. It is resolved once, here, into a single
 * typed reference, and the client only ever sees `{ kind, id }` or nothing.
 *
 * Null is a real and common answer: a reward, a demo reward, and a manual adjustment all have no
 * record behind them, and a client that treated an unresolvable row as an error would be wrong
 * about most of the rows it renders.
 */
function historyRecordFrom(row) {
    if (row.deposit_id !== null && row.deposit_id !== undefined) {
        return { kind: 'deposit', id: String(row.deposit_id) };
    }
    const source = String(row.source_id ?? '').trim();
    if (source === '') return null;

    if (row.transaction_type === 'withdrawal' || row.transaction_type === 'refund') {
        const id = source.startsWith('withdrawal:') ? source.slice('withdrawal:'.length) : source;
        // Only digits. `source` came from a column this app writes, but it is not a number and a
        // non-numeric value would be interpolated into a client-built url; refusing it here keeps
        // that from being the client's problem to discover.
        return /^\d{1,19}$/.test(id) ? { kind: 'withdrawal', id } : null;
    }
    return null;
}

/** Classifies a database error so the same cause always produces the same status. */
function sendDatabaseFailure(res, logPrefix, error) {
    console.error(`${logPrefix}:`, pool.describeError ? pool.describeError(error) : error.message);
    if (DB_UNREACHABLE_CODES.has(error?.code)) {
        return res.status(503).json({ error: 'This service is temporarily unavailable.' });
    }
    return res.status(500).json({ error: 'Internal server error.' });
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Email preferences
// ---------------------------------------------------------------------------

/**
 * Reads the one switchable email setting.
 *
 * The response carries the policy as well as the value, so the page can name what stays
 * switched on instead of asserting it. "Some email always arrives" is not something a user
 * can act on; "your password reset always arrives" is.
 */
router.get('/email-preferences', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT money_emails_enabled FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json({
            moneyEmailsEnabled: emailPreferences.isMoneyEmailEnabled(result.rows[0].money_emails_enabled),
            ...emailPreferences.describePolicy()
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Email Preferences Error', error);
    }
});

/**
 * Turns money email on or off.
 *
 * Strict about the body: only a real boolean is accepted. A `PATCH` that treated any
 * non-`false` value as truthy would mean a client sending `{ moneyEmailsEnabled: "false" }`,
 * or `{}`, or `0`, silently switched the user's receipts off. A preference the user did not
 * clearly express is not a preference, and the failure is invisible because the response
 * reports the stored value as if the request had been understood.
 */
router.patch('/email-preferences', async (req, res) => {
    const requested = req.body ? req.body.moneyEmailsEnabled : undefined;
    if (typeof requested !== 'boolean') {
        return res.status(400).json({ error: 'moneyEmailsEnabled must be true or false.' });
    }
    try {
        const stored = await emailPreferences.setMoneyEmailPreference(req.user.id, requested);
        if (stored === null) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json({
            moneyEmailsEnabled: stored,
            ...emailPreferences.describePolicy()
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Email Preferences Error', error);
    }
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Reads the signed-in user's display name and profile picture.
 *
 * Scoped to `req.user.id`, so there is no id in the path to tamper with and no way to ask
 * this endpoint about anybody else. A user who has set neither field gets `null` for both
 * rather than a 404, because "you have not chosen a name" is a normal state and the
 * interface has a fallback for it.
 */
router.get('/profile', async (req, res) => {
    try {
        const stored = await profile.loadProfile(req.user.id);
        if (!stored) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json(stored);
    } catch (error) {
        return sendDatabaseFailure(res, 'Profile Error', error);
    }
});

/**
 * Updates the display name and/or the profile picture.
 *
 * Partial by design: a body carrying only `displayName` changes only the name, so changing
 * a name does not require the client to also resend a picture it would then have to read
 * back first. A field that is absent is left exactly as it is. A field that is present and
 * `null` -- or an empty string -- clears it, which is how the "remove" affordance works.
 *
 * Validation runs here and not in the browser. The client checks the same rules to give
 * immediate feedback, but the browser is the untrusted side of this connection: a request
 * that arrived from anywhere else carries no such check, and the stored value is what ends
 * up rendered next to a balance. Every rejection is a 400 with a message written for the
 * person who typed it, rather than a silent no-op that leaves the interface showing a name
 * the server never accepted.
 */
router.patch('/profile', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // An unknown key is a client bug worth surfacing rather than ignoring. A `PATCH` that
    // silently dropped a misspelled field would report success while changing nothing, and
    // the user would be told their picture was saved.
    const allowedKeys = new Set(['displayName', 'avatarData']);
    const unexpected = Object.keys(body).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
        return res.status(400).json({ error: `Unexpected field: ${unexpected[0]}.` });
    }
    if (unexpected.length === Object.keys(body).length && Object.keys(body).length > 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
        const name = profile.normaliseDisplayName(body.displayName);
        if (!name.ok) return res.status(400).json({ error: name.error });
        patch.displayName = name.value;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'avatarData')) {
        const picture = profile.normaliseAvatar(body.avatarData);
        if (!picture.ok) return res.status(400).json({ error: picture.error });
        patch.avatarData = picture.value;
    }

    try {
        const saved = await profile.saveProfile(req.user.id, patch);
        if (!saved.updated) {
            // Either the account vanished between the session check and this write, or the
            // body named no updatable field. Both are answered 400/404 rather than 200,
            // because a 200 here would claim a change that did not happen.
            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: 'Nothing to update.' });
            }
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json(saved.profile);
    } catch (error) {
        return sendDatabaseFailure(res, 'Profile Update Error', error);
    }
});

/**
 * Ends every session on this account, including this one.
 *
 * The mechanism already exists: `users.token_version` is compared against the `ver` claim on
 * every request by `requireAuth`, and bumping it invalidates every token ever signed. The
 * password reset already relies on it -- which is why a reset signs you out everywhere -- so
 * this is the same control, exposed deliberately rather than as a side effect of changing a
 * password.
 *
 * It is worth having on its own. A token in `sessionStorage` is per-tab, so "sign out" on a
 * shared or borrowed device only closes that tab, and the person who used it before can
 * reopen the page and still be signed in. That is the gap this closes.
 *
 * The response is 200 and the caller's own token is now worthless, which is the intended
 * outcome: the client is expected to clear its local copy and leave. It is told to do that
 * explicitly in the response body rather than having to work out that a `200` means "you are
 * now signed out, oddly".
 */
router.post('/sessions/revoke', async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING id',
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json({
            signedOutEverywhere: true,
            // Stated rather than implied, because the alternative reading of a successful
            // response is "you are still signed in".
            message: 'Every session on this account has been ended, including this one. Sign in again to continue.'
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Session Revoke Error', error);
    }
});

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

router.get('/balance', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT balance, demo_balance FROM users WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        // Returned as-is: the columns are NUMERIC and `node-postgres` hands them
        // back as strings precisely to avoid float precision loss. Coercing to
        // Number here would quietly round a balance that a wallet expects to be
        // exact, so the string form is preserved. A client that needs a number
        // should parse at the edge of its own arithmetic, not here.
        return res.json({
            balance: result.rows[0].balance,
            demoBalance: result.rows[0].demo_balance,
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Balance Error', error);
    }
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * Whether anything the page shows has moved since the version the client last saw.
 *
 * The client polls this instead of re-reading the balance and both history lists, and the
 * answer is normally "nothing changed" in about sixty bytes. That matters because the
 * alternative is a poll that re-downloads every row the user can see several times a
 * minute forever, which on a serverless function is a request count problem before it is
 * a bandwidth one.
 *
 * The version is a string rather than a sequence number because it is derived from data
 * this database already maintains. A monotonic counter would need a column, a write on
 * every path that changes the balance, and a migration on any deployment that has not run
 * it -- and a counter that misses a write is worse than no counter, because it reports
 * "unchanged" when something moved. Timestamps cannot miss a write, and `updated_at` is
 * already bumped by every write that can change what the page shows: a deposit being
 * credited, a withdrawal being paid or refunded by an operator.
 *
 * Balance and `demo_balance` are part of the version rather than of the comparison,
 * because a demo conversion credits `demo_balance` without touching a deposit or a
 * withdrawal, and a header that said "unchanged" there would be lying.
 *
 * When something has changed the full histories come back, so the client does not need a
 * second request to catch up.
 */
router.get('/updates', async (req, res) => {
    const knownVersion = String(req.query.version || '').slice(0, 120);
    try {
        const result = await pool.query(
            `SELECT u.balance, u.demo_balance, u.token_version,
                    (SELECT COALESCE(MAX(updated_at)::TEXT, '') FROM deposits WHERE user_id = u.id) AS deposits_at,
                    (SELECT COALESCE(MAX(updated_at)::TEXT, '') FROM withdrawals WHERE user_id = u.id) AS withdrawals_at,
                    (SELECT COALESCE(MAX(created_at)::TEXT, '') FROM balance_transactions WHERE user_id = u.id) AS ledger_at,
                    (SELECT COALESCE(MAX(id)::TEXT, '0') FROM balance_transactions WHERE user_id = u.id) AS ledger_id
             FROM users u
             WHERE u.id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const row = result.rows[0];
        // The ledger is part of the version for the same reason `balance` is: a reward credits
        // the balance, but so does an operator correction, a bonus, or a migration, and the
        // client cannot tell those apart from the balance alone. Including the ledger's latest
        // row means a balance change that has no ledger row behind it still produces a new
        // version, so the client sees it and can report it as unexplained rather than staying
        // silent. `id` is included as well as `created_at` because two rows can share a
        // timestamp and a manual correction is exactly the kind of write that does.
        const version = [
            row.deposits_at,
            row.withdrawals_at,
            row.balance,
            row.demo_balance,
            row.token_version,
            row.ledger_at,
            row.ledger_id
        ].join('|');

        // `no-store` is not optional here. A cached poll result would report "unchanged"
        // after the deposit that just credited, which is the exact failure this endpoint
        // exists to prevent.
        res.set('Cache-Control', 'no-store');

        if (knownVersion && knownVersion === version) {
            // 304 is the honest status: the client's copy is current. It is smaller than
            // an empty 200 body and intermediaries treat it as "revalidate", which is what
            // it is.
            return res.status(304).end();
        }

        const [deposits, withdrawals, ledger] = await Promise.all([
            pool.query(
                // `pay_amount` and `actually_paid` are the two sides of a short payment, and the
                // client needs both to be able to say "0.0076 of 0.0083 SOL received" instead of
                // only "waiting". A deposit the user is still funding is the one where silence
                // is most expensive, because they are looking at the address to see whether the
                // money arrived.
                `SELECT id, amount, asset_code, currency_code, network, deposit_address,
                        checkout_url, status, credited_at, created_at, updated_at,
                        pay_amount, actually_paid, pay_currency, underpaid_at
                 FROM deposits
                 WHERE user_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [req.user.id, HISTORY_PAGE_SIZE]
            ),
            pool.query(
                // The payout columns are here, not only on `GET /api/user/withdrawals`, and that
                // asymmetry is the bug this fixes. The live poll is what repaints the withdrawal
                // list while a payout is moving, and it was returning a row with no
                // `payout_status` -- so every withdrawal the user watched after the initial page
                // load lost its progress line and fell back to reading "Processing" with nothing
                // under it. The initial load looked right and the live updates did not, which is
                // the worst shape a bug can take: it disappears on refresh.
                `SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
                        w.status, w.failure_reason, w.created_at, w.paid_at, w.updated_at,
                        w.payout_status, w.payout_submitted_at, w.payout_coin_amount, w.payout_fee_coin,
                        w.payout_currency, w.payout_address, w.payout_error, w.provider_reference,
                        r.created_at AS refunded_at
                 FROM withdrawals w
                 LEFT JOIN balance_transactions r
                        ON r.transaction_type = 'refund'
                        AND r.source_id = 'withdrawal:' || w.id::TEXT
                        AND r.user_id = w.user_id
                 WHERE w.user_id = $1
                 ORDER BY w.created_at DESC, w.id DESC
                 LIMIT $2`,
                [req.user.id, HISTORY_PAGE_SIZE]
            ),
            // The reason a balance moved, which `balance` alone cannot express. Without it the
            // client has to infer a cause from the size of a change, and the only cause it can
            // name is "a completed offer" -- which is what a $10 row inserted by hand in the
            // database was reported as. `is_demo` is included so a test reward is not announced
            // as a real one.
            pool.query(
                `SELECT id, amount, transaction_type, source_id, description, is_demo, created_at
                 FROM balance_transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [req.user.id, HISTORY_PAGE_SIZE]
            )
        ]);

        return res.json({
            version,
            balance: row.balance,
            demoBalance: row.demo_balance,
            deposits: deposits.rows.map(withDepositDetails),
            withdrawals: withdrawals.rows.map(withWithdrawalDetails),
            // `balance_transactions` is also the name of the table, but the client already reads
            // `deposits` and `withdrawals` as the two lists, so `transactions` is the consistent
            // third member of that set rather than a table name leaking into an API shape.
            transactions: ledger.rows
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Updates Error', error);
    }
});

// ---------------------------------------------------------------------------
// Withdrawal history
// ---------------------------------------------------------------------------

/**
 * Why a cancel was refused, in the words the person who pressed the button should read.
 *
 * The refusals are separated because they are not the same problem. `already-sent` is the only
 * one the app cannot resolve by itself: a payout was started, it may already be on-chain, and
 * the balance has *not* been returned, so telling the user their money is coming back would be
 * a lie about their balance. It is also the one they cannot fix, so it names what happens next
 * rather than just refusing.
 *
 * `already-paid` is deliberately worded the same way whether the payout finished a second ago
 * or a month ago: a user who asks to cancel wants to know where their money is, not how long it
 * has been gone.
 */
const CANCEL_REFUSALS = {
    'not-found': { status: 404, error: 'That withdrawal does not exist.' },
    'already-paid': {
        status: 409,
        error: 'This withdrawal has already been paid, so it cannot be cancelled.'
    },
    'already-resolved': {
        status: 409,
        error: 'This withdrawal has already been closed. Your balance has already been updated.'
    },
    'already-sent': {
        status: 409,
        error: 'This withdrawal is already on its way and cannot be cancelled. '
            + 'Your balance has not been refunded, because the transfer may still complete. '
            + 'Support can confirm it for you.'
    }
};

router.post('/withdrawals/:id/cancel', async (req, res) => {
    const id = String(req.params.id);
    if (!RECORD_ID_PATTERN.test(id)) {
        // The id is malformed rather than absent, so it is reported as not-found rather than
        // as a validation error that describes the shape of the id back to the caller.
        return res.status(404).json({ error: 'That withdrawal does not exist.' });
    }

    try {
        const result = await withdrawalResolution.cancelWithdrawalByUser(Number(id), req.user.id);

        if (!result.changed) {
            const refusal = CANCEL_REFUSALS[result.reason] || {
                status: 409,
                error: 'This withdrawal cannot be cancelled right now.'
            };
            return res.status(refusal.status).json({ error: refusal.error });
        }

        // The new balance is returned rather than left for the client to infer, because the
        // client already holds a stale copy and the number it would otherwise show is the one
        // thing the user is looking at when they ask whether the money came back.
        return res.json({
            cancelled: true,
            withdrawalId: Number(id),
            refunded: result.refunded,
            balance: result.balance
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Withdrawal cancel error', error);
    }
});

router.get('/withdrawals', async (req, res) => {
    try {
        // The destination is included so the user can confirm a request was
        // recorded against the address they intended, which is the mistake that
        // is hardest to reverse once an operator has paid it.
        //
        // `failure_reason` and `refunded_at` are included because a rejected
        // withdrawal has the money returned to the balance, and a refund the
        // user cannot account for is the same support question as a withdrawal
        // that never arrived. Whether a refund actually happened is read from
        // the ledger rather than inferred from the status: a row edited outside
        // the app can say `failed` with no refund behind it, and telling the
        // user it was returned in that case would be a lie about their money.
        // `cancellable` is computed here rather than left to the client. The client would have
        // to reimplement the gate in `cancelWithdrawalByUser`, and the two copies would drift:
        // a UI that offers Cancel for a payout already in flight is one click away from
        // refunding a transfer that is still moving. One SQL expression, used by the one
        // function that enforces it, is the only way they cannot disagree.
        //
        // It is deliberately the same six columns the gate checks, negated. A withdrawal with
        // a claim, a status, a batch, a provider id, or a submitted timestamp has had the
        // payout machinery touch it and is no longer the user's to cancel.
        const result = await pool.query(
            `SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
                    w.status, w.failure_reason, w.created_at, w.paid_at, w.updated_at,
                    w.payout_status, w.payout_submitted_at, w.payout_coin_amount, w.payout_fee_coin,
                    w.payout_currency, w.payout_address, w.payout_error, w.provider_reference,
                    r.created_at AS refunded_at,
                    (w.status = ANY($4)
                     AND w.payout_claimed_at IS NULL
                     AND w.payout_status IS NULL
                     AND w.batch_id IS NULL
                     AND w.payout_provider_id IS NULL
                     AND w.payout_submitted_at IS NULL
                     AND w.provider_reference IS NULL) AS cancellable
             FROM withdrawals w
             LEFT JOIN balance_transactions r
                    ON r.transaction_type = 'refund'
                    AND r.source_id = $2 || w.id::TEXT
                    AND r.user_id = w.user_id
             WHERE w.user_id = $1
             ORDER BY w.created_at DESC, w.id DESC
             LIMIT $3`,
            [
                req.user.id,
                WITHDRAWAL_REFUND_SOURCE_PREFIX,
                HISTORY_PAGE_SIZE,
                [...withdrawalResolution.resolvableStatuses]
            ]
        );
        return res.json(result.rows.map(withWithdrawalDetails));
    } catch (error) {
        return sendDatabaseFailure(res, 'Withdrawal history error', error);
    }
});

// ---------------------------------------------------------------------------
// Deposit history
// ---------------------------------------------------------------------------

/**
 * The columns both deposit read endpoints project.
 *
 * Shared because these two queries answering the same question with different column lists is
 * not a style preference. It already happened: `pay_amount` and `expires_at` were added to the
 * history and not to the single-deposit lookup, so the receipt page -- whose entire purpose is
 * showing a customer the exact figure they were originally told to send -- silently fell back
 * to "send the exact amount" and told them nothing. The list and the detail view have to agree,
 * so they are one list.
 *
 * `credited_at` is here for the same reason it was originally selected: `status = 'confirmed'`
 * and "the money is on the balance" are the same thing only when the credit ran, and the person
 * reading is the one who cannot tell the two apart.
 */
const DEPOSIT_COLUMNS = 'id, amount, pay_amount, actually_paid, pay_currency, underpaid_at, expires_at, ' +
    'asset_code, currency_code, network, deposit_address, checkout_url, status, credited_at, created_at';

router.get('/deposits', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ${DEPOSIT_COLUMNS}
             FROM deposits
             WHERE user_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [req.user.id, HISTORY_PAGE_SIZE]
        );
        return res.json(await Promise.all(result.rows.map(async (row) => {
            const deposit = withDepositDetails(row);
            // A crypto deposit that is still awaiting payment is re-openable. The exact coin
            // amount and the deadline are read from the row (migration 013) rather than
            // recomputed, because the rate has moved since the deposit was created and the
            // same address serves every amount. The QR is rendered only for these rows:
            // generating one for a settled deposit is work whose result is never shown.
            const instructions = await paymentController.payableInstructionsFor(row);
            return instructions ? { ...deposit, ...instructions } : deposit;
        })));
    } catch (error) {
        return sendDatabaseFailure(res, 'Deposit history error', error);
    }
});

/**
 * One deposit, for its own receipt screen.
 *
 * A crypto deposit has no provider checkout to redirect to -- the customer is
 * shown an address and leaves the site -- so there was no page to send anyone
 * back to afterwards, and the only record of a $5,000 XRP deposit was a row of
 * JSON. This is what a "view your deposit" link points at, and what the
 * standalone receipt page polls.
 *
 * Scoped to the owner, so an id alone reveals nothing. Returns 404 rather than
 * 403 for someone else's deposit, so the response does not confirm that the id
 * exists.
 */
router.get('/deposits/:id', async (req, res) => {
    const depositId = String(req.params.id);
    if (!RECORD_ID_PATTERN.test(depositId)) {
        return res.status(404).json({ error: 'Deposit not found.' });
    }
    try {
        const result = await pool.query(
            `SELECT ${DEPOSIT_COLUMNS}
             FROM deposits
             WHERE id = $1 AND user_id = $2`,
            [depositId, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Deposit not found.' });
        }
        return res.json(withDepositDetails(result.rows[0]));
    } catch (error) {
        return sendDatabaseFailure(res, 'Deposit lookup error', error);
    }
});

/**
 * One withdrawal, for its own receipt screen.
 *
 * The counterpart to `GET /deposits/:id`, added with the withdrawal receipt page. The refund
 * lookup is joined rather than queried, because whether the money came back is the single fact
 * that decides how a receipt reads -- "Failed" and "Returned to your balance" are different
 * claims about the user's money, and a receipt that showed the first without the second would
 * be reporting a loss that did not happen.
 *
 * Scoped to the owner, and 404 rather than 403 for someone else's withdrawal, so the response
 * does not confirm that the id exists.
 */
router.get('/withdrawals/:id', async (req, res) => {
    const withdrawalId = String(req.params.id);
    if (!RECORD_ID_PATTERN.test(withdrawalId)) {
        return res.status(404).json({ error: 'Withdrawal not found.' });
    }
    try {
        const result = await pool.query(
            `SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
                    w.destination_tag, w.status, w.failure_reason, w.created_at, w.paid_at, w.updated_at,
                    w.payout_status, w.payout_submitted_at, w.payout_coin_amount, w.payout_fee_coin,
                    w.payout_currency, w.payout_address, w.payout_error, w.provider_reference,
                    r.created_at AS refunded_at
             FROM withdrawals w
             LEFT JOIN balance_transactions r
                    ON r.transaction_type = 'refund'
                    AND r.source_id = $2 || w.id::TEXT
                    AND r.user_id = w.user_id
             WHERE w.id = $1 AND w.user_id = $3`,
            [withdrawalId, WITHDRAWAL_REFUND_SOURCE_PREFIX, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found.' });
        }
        return res.json(withWithdrawalDetails(result.rows[0]));
    } catch (error) {
        return sendDatabaseFailure(res, 'Withdrawal lookup error', error);
    }
});

// ---------------------------------------------------------------------------
// Combined transaction history
// ---------------------------------------------------------------------------

/**
 * A flat list of every balance movement, in descending order.
 *
 * This is the single query the history page needs: deposits, withdrawals, and
 * reward credits all appear here in chronological order. The frontend does not
 * need to join separate deposit and withdrawal lists to tell the user a credit
 * followed a withdrawal refund, or that a reward landed between two deposits.
 *
 * Demo rows used to be excluded outright, on the reasoning that this list is rendered as
 * `+$1.00` against a header showing the real balance, so a demo reward in here reads as money
 * the user received when none of it is. The reasoning was sound and the conclusion was not:
 * excluding them meant a completed demo offer -- the entire point of the demo pages, and the
 * only thing a new user can actually do here -- produced a Rewards tab that stayed on "No
 * rewards yet" forever, with copy telling them to complete an offer they had just completed.
 * A reward that cannot be seen is indistinguishable from a reward that never paid.
 *
 * So they are included and flagged instead. `is_demo` is returned on every row and the client
 * renders a test reward as a test reward: no cash colouring, an explicit marker, and no sign
 * in front of the amount. The number is what the user earned against the test balance, which
 * is a true thing worth showing.
 *
 * Nothing here touches the cash invariant `npm run audit:balance` relies on -- that query reads
 * the table with its own `is_demo IS NOT TRUE` filter and is unaffected by what this endpoint
 * returns.
 *
 * `limit` and `offset` exist because a fixed twenty rows cannot support a paginated list. The
 * response is still a bare array, because two clients consume it -- the page and the CSV export
 * -- and the count they need is carried in `X-Total-Count` instead of by changing the shape.
 * A header rather than an envelope specifically so the CSV export, which iterates the body
 * directly, keeps working unchanged.
 *
 * `type` narrows to one `transaction_type` and is filtered here rather than in the client for
 * the same reason `limit` is honoured here: pagination over a client-side filter counts the
 * wrong rows. Fetching one page of twenty and filtering it to deposits would show a page of
 * three while the header reported the unfiltered total, and "page 2" would silently repeat or
 * skip rows depending on where the deposits happened to fall. The filter and the window have to
 * be applied to the same set for the count to mean anything.
 *
 * It is matched against a fixed list, and an unrecognised value is an error rather than a
 * silent "no filter": the column is a bound parameter, never interpolated, so this is about
 * answering the question the caller meant -- an unknown type is a client bug, and quietly
 * returning everything would hide it behind a list that looks right.
 */
router.get('/history', async (req, res) => {
    const limit = positiveIntFromQuery(req.query.limit, HISTORY_PAGE_SIZE, HISTORY_MAX_LIMIT);
    // No upper bound on the offset: it is not attacker-amplifiable the way an unbounded limit
    // is, and refusing a large one would make a deep page unreachable rather than merely slow.
    const offset = positiveIntFromQuery(req.query.offset, 0, Number.MAX_SAFE_INTEGER) || 0;

    // `all` and an absent filter both mean "unfiltered". Anything else must be a type this
    // endpoint can actually produce, so the list is derived from the same vocabulary the
    // client renders rather than from whatever the column happens to contain.
    const requestedType = String(req.query.type ?? '').trim().toLowerCase();
    const type = requestedType === '' || requestedType === 'all' ? null : requestedType;
    if (type !== null && !HISTORY_FILTER_TYPES.has(type)) {
        return res.status(400).json({ error: 'Unknown history type.' });
    }

    try {
        // The count and the page come from one round trip via a window function, so the two
        // cannot describe different moments -- which is what makes `X-Total-Count` trustworthy
        // enough for the page number to be derived from it.
        const result = await pool.query(
            `SELECT id, amount, transaction_type, source_id, description, is_demo, created_at,
                    deposit_id,
                    COUNT(*) OVER () AS total_count
              FROM balance_transactions
              WHERE user_id = $1
                AND ($4::TEXT IS NULL OR transaction_type = $4)
              ORDER BY created_at DESC, id DESC
              LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset, type]
        );

        // Reported on every response, including a page past the end where there are no rows. The
        // client needs the true total to keep its page count honest, and deriving it from the
        // rows returned would make the last page look like the only one.
        //
        // The window function cannot supply it on an empty page -- there are no rows to carry it
        // -- so the count is asked for separately. Substituting the offset instead would be
        // wrong in the one case a user reaches deliberately: a stale deep page would report a
        // total equal to its own offset and invent a screenful of pages that do not exist.
        let total = Number(result.rows[0]?.total_count ?? 0);
        if (result.rows.length === 0 && offset > 0) {
            const counted = await pool.query(
                `SELECT COUNT(*)::INT AS total
                   FROM balance_transactions
                  WHERE user_id = $1
                    AND ($2::TEXT IS NULL OR transaction_type = $2)`,
                [req.user.id, type]
            );
            total = Number(counted.rows[0]?.total ?? 0);
        }
        res.set('X-Total-Count', String(total));


        // The window column is stripped rather than left on the row. It is a count for the
        // caller, not a field of a transaction, and both consumers of this body -- the page and
        // the CSV export -- iterate the rows as transactions, so an extra field on each is a
        // shape change disguised as a convenience.
        return res.json(result.rows.map(({ total_count, ...row }) => ({ ...row, record: historyRecordFrom(row) })));
    } catch (error) {
        return sendDatabaseFailure(res, 'History Error', error);
    }
});

// ---------------------------------------------------------------------------
// Options and financial mutations
// ---------------------------------------------------------------------------

router.get('/payment-options', paymentController.providerOptions);
router.get('/withdrawal-options', payoutController.withdrawalOptions);
router.post('/deposits', financialMutationLimit, paymentController.createDeposit);
router.post('/withdraw', financialMutationLimit, payoutController.requestWithdrawal);

registerMethod(/^\/api\/user\/history\/?$/, ['GET']);
registerMethod(/^\/api\/user\/balance\/?$/, ['GET']);
registerMethod(/^\/api\/user\/updates\/?$/, ['GET']);
registerMethod(/^\/api\/user\/profile\/?$/, ['GET', 'PATCH']);
registerMethod(/^\/api\/user\/sessions\/revoke\/?$/, ['POST']);
registerMethod(/^\/api\/user\/payment-options\/?$/, ['GET']);
registerMethod(/^\/api\/user\/withdrawal-options\/?$/, ['GET']);
registerMethod(/^\/api\/user\/deposits\/?$/, ['GET', 'POST']);
registerMethod(/^\/api\/user\/deposits\/\d{1,19}\/?$/, ['GET']);
registerMethod(/^\/api\/user\/withdrawals\/\d{1,19}\/?$/, ['GET']);
registerMethod(/^\/api\/user\/email-preferences\/?$/, ['GET', 'PATCH']);

router.post('/withdrawals/code', financialMutationLimit, payoutController.sendWithdrawalCode);
router.post('/withdrawals', financialMutationLimit, payoutController.requestWithdrawal);
registerMethod(/^\/api\/user\/withdrawals\/?$/, ['GET', 'POST']);
registerMethod(/^\/api\/user\/withdrawals\/code\/?$/, ['POST']);
registerMethod(/^\/api\/user\/withdrawals\/\d{1,19}\/cancel\/?$/, ['POST']);
registerMethod(/^\/api\/user\/withdraw\/?$/, ['POST']);

module.exports = router;