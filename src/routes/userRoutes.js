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
function withReceiptUrl(deposit) {
    return { ...deposit, receipt_url: `/receipt/deposit/${deposit.id}` };
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
                    (SELECT COALESCE(MAX(updated_at)::TEXT, '') FROM withdrawals WHERE user_id = u.id) AS withdrawals_at
             FROM users u
             WHERE u.id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const row = result.rows[0];
        const version = [row.deposits_at, row.withdrawals_at, row.balance, row.demo_balance, row.token_version].join('|');

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

        const [deposits, withdrawals] = await Promise.all([
            pool.query(
                `SELECT id, amount, asset_code, currency_code, network, deposit_address,
                        checkout_url, status, credited_at, created_at
                 FROM deposits
                 WHERE user_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [req.user.id, HISTORY_PAGE_SIZE]
            ),
            pool.query(
                `SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
                        w.status, w.failure_reason, w.created_at, w.paid_at,
                        r.created_at AS refunded_at
                 FROM withdrawals w
                 LEFT JOIN balance_transactions r
                        ON r.transaction_type = 'refund'
                        AND r.source_id = 'withdrawal:' || w.id::TEXT
                        AND r.user_id = w.user_id
                 WHERE w.user_id = $1
                 ORDER BY w.created_at DESC
                 LIMIT $2`,
                [req.user.id, HISTORY_PAGE_SIZE]
            )
        ]);

        return res.json({
            version,
            balance: row.balance,
            demoBalance: row.demo_balance,
            deposits: deposits.rows.map(withReceiptUrl),
            withdrawals: withdrawals.rows
        });
    } catch (error) {
        return sendDatabaseFailure(res, 'Updates Error', error);
    }
});

// ---------------------------------------------------------------------------
// Withdrawal history
// ---------------------------------------------------------------------------

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
        const result = await pool.query(
            `SELECT w.id, w.amount, w.payment_method, w.payment_address, w.asset_code, w.network,
                    w.status, w.failure_reason, w.created_at, w.paid_at,
                    w.payout_status, w.payout_submitted_at,
                    r.created_at AS refunded_at
             FROM withdrawals w
             LEFT JOIN balance_transactions r
                    ON r.transaction_type = 'refund'
                    AND r.source_id = $2 || w.id::TEXT
                    AND r.user_id = w.user_id
             WHERE w.user_id = $1
             ORDER BY w.created_at DESC, w.id DESC
             LIMIT $3`,
            [req.user.id, WITHDRAWAL_REFUND_SOURCE_PREFIX, HISTORY_PAGE_SIZE]
        );
        return res.json(result.rows);
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
const DEPOSIT_COLUMNS = 'id, amount, pay_amount, expires_at, asset_code, currency_code, network, ' +
    'deposit_address, checkout_url, status, credited_at, created_at';

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
            const deposit = withReceiptUrl(row);
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
        return res.json(withReceiptUrl(result.rows[0]));
    } catch (error) {
        return sendDatabaseFailure(res, 'Deposit lookup error', error);
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
 */
router.get('/history', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, amount, transaction_type, source_id, description, is_demo, created_at
             FROM balance_transactions
             WHERE user_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [req.user.id, HISTORY_PAGE_SIZE]
        );
        return res.json(result.rows);
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
registerMethod(/^\/api\/user\/email-preferences\/?$/, ['GET', 'PATCH']);

router.post('/withdrawals/code', financialMutationLimit, payoutController.sendWithdrawalCode);
router.post('/withdrawals', financialMutationLimit, payoutController.requestWithdrawal);
registerMethod(/^\/api\/user\/withdrawals\/?$/, ['GET', 'POST']);
registerMethod(/^\/api\/user\/withdrawals\/code\/?$/, ['POST']);
registerMethod(/^\/api\/user\/withdraw\/?$/, ['POST']);

module.exports = router;