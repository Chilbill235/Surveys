# RewardZone

A rewards/offer-wall API with accounts, offer click tracking, Stripe + NOWPayments
deposits, and a balance ledger. It runs as a single Express app that can be hosted
on Vercel and reached at a real public URL instead of localhost.

## Deploy to Vercel

1. Push this repository to GitHub, then import it at
   [vercel.com/new](https://vercel.com/new). Vercel auto-detects Express because
   `server.js` exports the app.
2. Add an environment variable for every secret in the table below, in the
   **Production** environment, with your real values.
3. Set `APP_BASE_URL` to the **public HTTPS origin** Vercel gives you, for example
   `https://rewardzone.vercel.app`. This is the most common cause of deposits not
   crediting: a localhost value makes providers post their webhooks to a machine
   they cannot reach, so the deposit stays `pending` forever.
4. Deploy. The `vercel-build` script runs `npm run migrate`, so tables and indexes
   are created and upgraded automatically on every deploy.
5. Register the provider callbacks at the public origin:
   - Stripe webhook: `https://<your-domain>/api/payments/stripe/webhook` for
     `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   - NOWPayments IPN: the app sends `https://<your-domain>/api/payments/nowpayments/ipn`
     as `ipn_callback_url`.
6. Add a `CRON_SECRET` variable. `vercel.json` schedules a job that re-checks pending
   deposits against the provider and credits any the provider reports as finished, so one
   lost webhook cannot strand funds. The schedule is daily, which every plan allows; a
   sub-daily schedule (`0 */6 * * *`) is rejected outright on Hobby and fails the deploy.

`TRUST_PROXY` defaults to `true` on Vercel so per-IP rate limiting sees the real
client address from `X-Forwarded-For`.

### How requests are routed

`vercel.json` is where this app most easily breaks, because every page and the click
tracking hop are served by the function, not by static files.

| Request | Handled by |
| --- | --- |
| `/api/**` | the function (`api/index.js` -> `src/app.js`) |
| `/style.css`, `/*.js`, `/*.html` | Vercel's static files, served before any rewrite |
| `/`, `/offers`, `/reset-password`, `/deposit/:id`, `/demo` | the function, which picks the right page |
| **`/offer/engage`** | the function — this is the redirect to the advertiser |
| everything else | the function, which answers 404 |

The rewrite is `/((?!api/).*)` -> `/api/index.js`. It must **not** point at `index.html`.

That is the single highest-impact mistake available in this file, and it was the one that
shipped. Rewriting every non-API path to `index.html` is the standard SPA configuration and
it looks completely reasonable, but `/offer/engage` is not under `/api` — so the advertiser
redirect was swallowed, every user who clicked an offer landed back on the offers page, and
nothing anywhere reported an error. The same rewrite also broke `/` (the home page became
the catalog), `/reset-password` (password reset could never load its form), and
`/deposit/:id` (no receipt). The tests could not catch it, because under `npm start` Express
serves all of them correctly and `vercel.json` is not consulted.

`npm run vercel-build` now parses `vercel.json` and fails the build if the catch-all points
at `index.html`, is missing, or does not target a function. `test/server.test.js` asserts
the same rule against the configuration that actually ships, and against the broken one.

Static assets are served by the CDN because Vercel checks the filesystem before applying
`rewrites`, so the function only handles requests that are genuinely not files.

### The Content-Security-Policy

It is set in `vercel.json` rather than in Express, so it also covers the files Vercel serves
from its own CDN — those never reach the application. `src/app.js` therefore runs helmet
with `contentSecurityPolicy: false`, and with `frameguard: false`:

- `frame-ancestors 'self' https:` allows embedding over https, and `X-Frame-Options:
  SAMEORIGIN` (helmet's default) would silently block that while appearing to be a security
  improvement. It also cannot express "any https origin" at all, so `frame-ancestors` is
  the only control that means what it says.
- `script-src 'self'` is accurate: every page loads an external script and there are no
  inline scripts, inline event handlers, or `eval` anywhere in `public/`. `check:frontend`
  fails the build if that stops being true.
- `style-src 'self' 'unsafe-inline'` is required because the deposit QR and the staggered
  card animation set CSS custom properties through CSSOM.


## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (Neon, Supabase, RDS, ...). |
| `DATABASE_CA_CERT` | recommended | Provider CA in PEM form (`\n` escapes allowed). Enables certificate verification. |
| `DATABASE_SSL` | optional | `disable` turns TLS off. Defaults to TLS on with no verification unless a CA is set. |
| `JWT_SECRET` | yes | Long random value that signs session tokens. |
| `APP_BASE_URL` | yes | Public HTTPS origin. Used for provider callbacks and reset links. |
| `POSTBACK_SECRET` | production | Shared secret for advertiser postbacks. |
| `PROXYCHECK_KEY` | optional | VPN/proxy fraud checks on click tracking. |
| `PROXYCHECK_REQUIRED` | optional | `true` refuses clicks while a proxy check cannot run. Default `false`: the click is tracked and the gap logged. |
| `OFFERS_INCLUDE_DEMO` | optional | `true` enables the demo offers, the `/demo` page, and the demo reward flow. Unset means enabled outside production only. |
| `CRON_SECRET` | recommended | Protects scheduled deposit reconciliation. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for cards | Enables Stripe Checkout deposits. |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | for crypto | Enables crypto deposits. |
| `NOWPAYMENTS_API_BASE_URL` | optional | Defaults to `https://api.nowpayments.io`. |
| `NOWPAYMENTS_FIXED_RATE`, `NOWPAYMENTS_FEE_PAID_BY_USER` | optional | `POST /v1/payment` options. Default `false`. |
| `NOWPAYMENTS_EMAIL`, `NOWPAYMENTS_PASSWORD` | for crypto payouts | JWT for the payout endpoints. Case-sensitive. |
| `NOWPAYMENTS_2FA_SECRET` | for crypto payouts | Base32 TOTP secret. Without it a batch is created but never verified, so the payout is never sent. |
| `NOWPAYMENTS_AUTO_PAYOUTS` | optional | `true` sends eligible **crypto** withdrawals automatically. Unset means off. See [Automatic crypto payouts](#automatic-crypto-payouts). |
| `BREVO_API_KEY`, `EMAIL_FROM` | for signup and reset email | Default provider. Brevo needs no domain of your own. `EMAIL_FROM` must be a sender registered in Brevo. |
| `RESEND_API_KEY` | optional | Only if `EMAIL_PROVIDER=resend`, and only once you have verified a custom domain — Resend will not send to anyone but the account owner until then. |
| `EMAIL_PROVIDER` | optional | `brevo` (default) or `resend`. Inferred from whichever key is set if unset. |
| `EMAIL_FROM_NAME` | optional | Display name on outgoing mail. Defaults to `RewardZone`. |
| `CORS_ORIGIN` | optional | Comma-separated extra browser origins. |
| `TRUST_PROXY` | optional | Defaults to `true` on Vercel; set `false` to disable. |
| `TRACKING_CLICK_PARAM` | optional | Click ID parameter sent to advertisers (default `aff_sub`). |
| `TEST_DATABASE_URL` | optional | Only used by the live integration test suite. |

Managed PostgreSQL providers present certificates that are not in Node's trust store, so
the connection is encrypted but unverified until `DATABASE_CA_CERT` is set. Without it the
app logs a warning at startup; connections do not fail.

Never commit `.env` and never place provider secrets in browser code.

## Local setup

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `JWT_SECRET`, and
   `APP_BASE_URL` (`http://localhost:3000` is fine locally).
2. Run `npm run migrate` to create or update the schema.
3. Run `npm run seed:demo` to add two demo tasks and one demo survey. It refuses to
   run when `NODE_ENV=production`.
4. Run `npm start` and open `/` for the home page or `/offers` for the catalog.

Users create an account or sign in from the account modal. Passwords are stored as
scrypt hashes and the session token stays in the current browser tab.

## Password reset

"Forgot password" in the account modal emails a single-use link
(`/reset-password#token=...`). Tokens are stored only as hashes, expire after one
hour, and are invalidated when used. Before this flow existed there was no way to
recover an account, because passwords are stored as one-way scrypt hashes and the
original text cannot be retrieved.

## Deposits and crediting

A balance is credited **only** after a provider confirms the payment, and only once:

- The update that flips `deposits.credited_at` from `NULL` to a timestamp is the
  single claim that credits a balance, and it is shared by the Stripe webhook, the
  NOWPayments IPN, and reconciliation. Replayed or concurrent callbacks therefore
  credit at most once.
- Both writes that follow the claim are verified. If the balance row or the
  `balance_transactions` row is not written, the transaction is rolled back rather
  than leaving a credit that no ledger entry explains.
- The provider payment ID, amount, and currency must match the stored deposit before
  anything is credited.
- **Only the provider's terminal success state credits a balance.** For NOWPayments that
  is `finished`; the IPN and the reconciler share one status table so a deposit cannot be
  credited by one path while the other would still have refused it.
- **A terminal status is a claim, not evidence.** A `finished` callback also has to report
  `actually_paid` covering `pay_amount` — the amount the customer was quoted — before the
  credit happens. Either field missing means the confirmation cannot be established, and
  the callback is refused rather than credited on the strength of its status string. This
  matters more than it looks: the check once fell back to "trust `finished` when the
  numbers are missing", which meant any `finished` body with no `actually_paid` funded a
  balance, and a truncated or hand-written callback is exactly what that produces. The
  comparison is against `pay_amount` and never against `price_amount`, because
  `actually_paid` is a quantity of coin and `price_amount` is dollars; comparing them is a
  units error whose verdict changes with the price of the asset. The tolerance is
  relative, so it absorbs floating-point noise without accepting a real shortfall.
- `npm run reconcile` re-checks pending deposits against the provider API and credits
  those reported as finished: `npm run reconcile`, `npm run reconcile -- --deposit=15`,
  or `npm run reconcile -- --limit=50`. It covers **both** providers: a card deposit is
  resolved by re-reading its Stripe Checkout Session, so a lost
  `checkout.session.completed` no longer leaves a paid deposit pending forever.
- Deposits whose checkout was abandoned are closed out. Stripe reports the session as
  expired, and deposits that were created but never attached to a provider payment (a
  crash between the insert and the provider call) are marked failed after an hour,
  because no webhook or lookup can ever resolve them.
- Returning to `/offers?deposit=return` from a checkout never credits a balance by
  itself; it only prompts the app to re-read the balance and deposit history.

### Crypto deposits against the NOWPayments contract

`src/services/nowPayments.js` is the only place that talks to the provider, holding the
base URL, the `x-api-key` header, the documented per-endpoint rate limits, and both status
vocabularies. The details that matter for money:

- **Confirmation is `GET /v1/payment/{payment_id}`.** That is the endpoint the reconciler
  reads, so the path that runs when a callback was lost asks the same question the live
  webhook answers.
- **A credit requires the money, not just a status.** `payment_status: finished` is the
  provider's terminal state, but both the IPN and the reconciler additionally check that
  `actually_paid` covers `pay_amount`. `pay_amount` is what the customer was quoted;
  `price_amount` is the fiat value of the deposit. Crediting the fiat value without
  confirming the crypto arrived credits a number rather than a payment. A provider record
  that omits `actually_paid` is not treated as a confirmation and is left for a later sweep.
- **Which coins exist is the merchant's, not ours.** `GET /v1/merchant/coins` answers with
  `selectedCurrencies`, and `GET /v1/currencies` is the global list of everything
  NOWPayments supports anywhere. Reading the global list and filtering it against a
  hardcoded allowlist offered coins the account had not enabled, and payment creation then
  failed. The merchant list is intersected with a reviewed set, so an unreviewed coin is
  not offered either.
- **The minimum is per currency pair, and it is much higher than $1.** `GET /v1/min-amount`
  is quoted for each coin. On the account this was last verified against, the floor for
  USD→BTC was **$18.80** and for USD→BCH **$18.79**, so an amount of $1 is genuinely below
  what NOWPayments will accept for those pairs. That figure is volatile — it moves with
  fees and volume — which is why it is kept strictly separate from the app's own limits:

  | | Enforced on | Source |
  |---|---|---|
  | App range, **$1.00 – $5,000.00** | the amount box's `min`/`max` | `appMinimumUsd` / `appMaximumUsd` |
  | Provider per-coin range | payment creation, and shown as guidance | `minimums` / `maximums` |

  Both are reported by `GET /api/user/payment-options`. The amount box enforces only the
  app's range, so the advertised $1.00 minimum is actually usable; the provider's floor is
  stated in the hint and in the coin's own picker entry, and is refused server-side with a
  precise message before any deposit row is written.

  These were previously collapsed into one figure, which made the box's `min` jump to
  $18.79 whenever a high-floor coin was selected: the advertised minimum was unreachable,
  and the visible symptom was the amount silently rewriting itself to a number the user
  never typed.
- **Callbacks have two shapes and share one URL.** A payment body carries `payment_id` and
  `payment_status`; a payout body carries `id` and a `status` from a separate uppercase
  vocabulary. A payout callback used to fail the payment field checks and be answered 400,
  which the provider treats as a failed delivery and retries. Both shapes are now
  recognised and acknowledged.
- **Several-payments-per-order is answered, not rejected.** A child payment reports
  `parent_payment_id` and belongs to no deposit here, so it is acknowledged with 200 rather
  than 400 to keep it out of the provider's retry schedule.
- **A rate limit is not a failed deposit.** `POST /v1/payment` is limited to 3 requests per
  second by the provider. Requests are queued to stay inside that, and a 429 leaves the
  deposit `pending` for the orphan sweep instead of closing it in front of a user who can
  simply retry.

Provider answers that only sometimes exist are treated as unknown rather than as refusal:
`GET /v1/payout-withdrawal/min-amount/{coin}` is access-restricted on accounts that have
not enabled it and answers 403, so the app falls back to its own floor and says so.

## Withdrawals

Withdrawal requests are stored as `pending` and reserve the requested amount. PayPal,
Venmo, and crypto payouts are **not** sent automatically, so a pending request must
never be described as paid. Payout-provider credentials, recipient eligibility, and
manual review are still required before transfers can be enabled.

Withdrawals are limited to **$1.00 – $10,000.00**. The floor and the ceiling live in
`src/services/payoutOptions.js` as the single source of truth, and the server sends both
in `GET /api/user/withdrawal-options`; the browser sets the amount box's `min` from that
response rather than repeating the numbers. A limit stated in one place but enforced in
another is how a user ends up submitting an amount the server then refuses.

`GET /api/user/withdrawal-options` is the single source of truth for what can be paid
out. It returns the supported methods, the crypto assets and their networks, the amount
bounds, and a per-network hint describing what a valid address looks like. The browser
builds its pickers from that response, so a destination can never be offered in the UI
while the server rejects it. It also reports the provider's real `GET /v1/payout/fee`
per coin, so a transfer's cost can be shown rather than guessed.

`src/services/payoutOptions.js` owns the asset, network, and address rules. Addresses are
validated before the request is stored, because the balance is debited as soon as it is
stored: a request recorded against an address that can never receive funds is paid late
or not at all. The common failure is an address for a different chain than the network
selected (a `0x` address sent as Bitcoin, a `T...` address sent as USDT on Ethereum), and
each asset and network is checked against its own format.

The local check is a first pass, because a regular expression cannot know whether an
address exists on the chain that was selected. The request is then put to the provider's own
`POST /v1/payout/validate-address`, which can. That endpoint keys on a **network-specific**
coin ticker, so the ticker is resolved from the asset *and* network: Tether is `usdterc20`
on Ethereum, `usdttrc20` on TRON, and `usdtmatic` on Polygon. Validating a TRON address
against the bare `usdt` ticker would confirm the wrong chain and pass while being
unsendable, which is exactly the failure this prevents. Provider validation is advisory,
so if the provider cannot be reached the local check stands rather than blocking a
withdrawal.

XRPL routes by a destination tag as well as by address, and a correct XRP address with no
tag is unsendable in a way the address format cannot reveal. The withdrawal form asks for
the tag when the selected asset needs one.

## Automatic crypto payouts

Crypto withdrawals can be sent to the user's wallet by NOWPayments' Mass Payouts API instead
of by an operator. **PayPal and Venmo are never automated** — NOWPayments is a crypto
gateway and cannot pay either, so those stay a manual step permanently.

| Method | Who sends it | Automated? |
| --- | --- | --- |
| `crypto` | NOWPayments payout API | Yes, when switched on |
| `paypal` | You, in PayPal | Never — the provider cannot |
| `venmo` | You, in Venmo | Never — the provider cannot |

### What it does to the ledger

A withdrawal is already debited when it is requested, so this changes only *who sends* and
*when the status moves*. The money path is deliberately narrow:

1. **Claim, then send.** The row moves to `processing` with the exact address, coin, and
   amount written to it, in a committed transaction, **before** the provider is called. If
   the process dies at any point afterwards, the claim is on file. The alternative — call
   the provider, then record — has a window where a crash loses the fact that money moved
   and the next run sends it again.
2. **A refused batch releases the claim** back to `pending` for an operator. Nothing was
   sent, so the request is untouched.
3. **An unknown outcome is never retried.** A timeout or dropped connection leaves it
   impossible to tell whether the provider accepted the batch, so the claim is *held* in
   `SUBMISSION_UNKNOWN` rather than released. Releasing it would let the next run duplicate a
   transfer; failing it would refund a user whose money may already be moving.
4. **Only a `FINISHED` callback marks a withdrawal paid**, and only a `REJECTED` one refunds
   it. Both go through the same `sendWithdrawal` / `reverseWithdrawal` the operator endpoints
   use, so a `paid` withdrawal still cannot be refunded and a refund is still a balance
   write plus a ledger row in one transaction.
5. **Only crypto, filtered in SQL.** The claim query carries `payment_method = 'crypto'`, so
   a PayPal address cannot reach the provider even if a caller asks for it.

The network fee is estimated and recorded per payout, but it is charged against the NOWPayments
custody balance rather than deducted from the user's amount, so the user receives the full coin
equivalent of what they requested.

### Setting it up

1. **On the NOWPayments account**, enable custody and fund the payout balance. Nothing in this
   app can do this, and a payout against an unfunded balance is refused by the provider.
2. **Set the credentials** if not already present:
   `NOWPAYMENTS_EMAIL`, `NOWPAYMENTS_PASSWORD`, and `NOWPAYMENTS_IPN_SECRET`.
   The IPN secret is what tells the app a payout finished — without it a sent withdrawal sits
   in `processing` and the user is told their money is in flight when it is not.
3. **Redeploy.** `db/migrations/009_auto_payouts.sql` adds the payout columns and the unique
   index on `batch_id`; the build applies it.
4. **Check readiness** — this sends nothing:
   ```bash
   npm run withdrawals -- preflight
   ```
   It reports each missing piece separately, because the fix is different for each.
5. **See what would be sent**, still claiming nothing:
   ```bash
   npm run withdrawals -- queue
   ```
6. **Send for real** — a named command, not a flag, so it cannot happen by omission:
   ```bash
   npm run withdrawals -- send 10
   ```

`NOWPAYMENTS_AUTO_PAYOUTS` is **off unless set to `true`**. Credentials alone never start
sending money; the switch is separate so a fresh deployment stays manual until someone has
funded custody and seen a test payout land.

To run it on a schedule instead, add a cron entry to `vercel.json` alongside the existing
reconciliation job — `POST /api/maintenance/payouts/run` with `{"dryRun": false}`. Vercel Cron
issues `GET`, and that path is deliberately POST-only so a link preview cannot move money; use
the script or a scheduler that can send a POST.

### When something is stuck

| `payout_status` | Meaning | What to do |
| --- | --- | --- |
| `CREATING` | Claimed, submission not yet confirmed | Wait, then re-run `queue`; a later run will not re-claim it. |
| `WAITING` / `PROCESSING` | Sent to the network | Nothing. The callback or reconciliation will finish it. |
| `SUBMISSION_UNKNOWN` | The provider never answered | **Do not resend.** Check the NOWPayments dashboard for the batch, then `paid` or `refund` by hand. |
| `FINISHED` / `REJECTED` | Settled | Nothing. The withdrawal is already `paid` or `failed`. |

Anything in `SUBMISSION_UNKNOWN` is listed by `npm run withdrawals -- list` and needs a human
decision, which is the point: it is the one state where the app cannot safely choose.

### Resolving a withdrawal

A request is a debit the moment it is stored, so it has to end somewhere. Two operator
endpoints close it, and both are guarded by `CRON_SECRET` exactly like scheduled
reconciliation (loopback only outside production):

| Endpoint | Effect |
| --- | --- |
| `GET /api/maintenance/withdrawals` | Requests still awaiting a decision, oldest first. |
| `POST /api/maintenance/withdrawals/:id/paid` | Marks it sent. `providerReference` is required. |
| `POST /api/maintenance/withdrawals/:id/refund` | Closes it as `failed` and returns the money. `reason` is required. |

A crypto withdrawal that [automatic payouts](#automatic-crypto-payouts) has sent is not
resolved by hand — the provider's callback does it, and the same `paid`/`failed` invariants
apply either way.

A refund is the balance write plus a `refund` ledger row keyed on `withdrawal:<id>`, in one
transaction, so a repeat attempt collides on the ledger instead of paying the user twice.
A withdrawal already marked `paid` is refused outright: once the funds have left, giving
the money back is not a database operation. A refund is also the only way the destination
problem above is recoverable — before these endpoints the sole remedy was editing the
`withdrawals` table by hand, which is how a row ends up saying `failed` with the money
still debited and nothing in the app able to notice.

Both actions are single-shot. A second call reports `409` rather than repeating the write,
because a retried operator action and a contradictory one are different problems.

#### Calling them

Use the operator script rather than typing the request by hand:

```bash
# Reads CRON_SECRET from the environment, or from .env.local
npm run withdrawals -- list
npm run withdrawals -- paid 42 "PAYPAL-REF-88123"
npm run withdrawals -- refund 42 "PayPal account could not be verified"

# Against a deployment rather than the local server
BASE_URL=https://your-deployment.vercel.app npm run withdrawals -- list
```

The secret is read from the environment or `.env.local` and never from an argument, so it
cannot end up in shell history or in `ps` output.

Two things about these endpoints are easy to get wrong by hand, and both have produced a
false "this endpoint does not exist":

- **The state-changing endpoints are POST-only.** A browser address bar can only send
  `GET`, so opening `…/withdrawals/42/refund` there sent the wrong verb, matched no route,
  and fell through to the catch-all's `{"error":"API route not found."}` — true about the
  request, false about the endpoint. A known path reached with the wrong verb is now
  answered `405` with an `Allow` header naming the verb to use. Unknown paths still get a
  plain `404`, so a typo never looks like a real endpoint.
- **A wrong `CRON_SECRET` answers `404`, deliberately**, to keep the endpoint
  undiscoverable. That is why the `405` is only returned to a caller who already holds the
  secret: an unauthenticated caller still sees `404`, exactly as before. In production an
  *unset* `CRON_SECRET` answers `503` naming the variable, which is the case that means
  "nobody set this up" rather than "you sent the wrong thing".

The same `405` handling covers the user-facing withdrawal API, so
`GET /api/user/withdraw` names the correct verb instead of reporting the route missing.
`POST /api/user/withdrawals` is also accepted as an alias for the create action, which was
otherwise spelled `/withdraw` while its list was `/withdrawals`.

## Reconciling the books

`npm run audit:balance` compares every balance against the cash ledger and reports eight
ways the two can stop agreeing with each other — including deposits shown as confirmed that
were never credited, and withdrawals that ended without being paid or refunded. It is
read-only, exits `1` when money is unaccounted for and `2` when the audit itself cannot
run, so it can be scheduled or monitored. `--json` is available for machine reading.

Two schema rules make most of those checks structural rather than hopeful:

- `deposits.status = 'confirmed'` requires `credited_at` to be set. `creditConfirmedDeposit`
  writes both in one statement, and reconciliation only re-checks `pending`/`confirming`
  rows, so a confirmed row with no credit would otherwise be invisible forever.
- `balance_transactions.is_demo` separates the demo rewards, which move `demo_balance`, from
  the rows that explain `balance`. Without it, "my balance equals the sum of my ledger" is
  false by construction and cannot be checked.

## The catalog

`GET /api/offers` is the whole product surface for a first-time visitor, and it answers with
`id, title, description, payout, network_name, partner_label, is_demo, offer_type`.

- **Demo offers are a feature, not a data flag.** `OFFERS_INCLUDE_DEMO` decides four things
  at once: whether demo offers appear in the catalog, whether `/demo` is served, whether
  `/api/demo/complete` accepts a completion, and whether a demo click may redirect. They
  used to be four separate `NODE_ENV` comparisons, which is how a deployment ends up
  advertising a survey that 404s — the catalog is the only one of the four a visitor can
  see, so the other three failing produces no signal at all.
  - `true` — available. `false` — not available. Unset — available outside production.
  - Vercel sets `NODE_ENV=production` on previews too, so a staging deployment needs this
    set explicitly to test the survey flow. That is the setting the demo flow is for.
  - The unset default is *off* in production, because a production deployment shares its
    database with local development: a default of on would publish local test offers to
    real visitors.
- **A click that cannot run here is never recorded.** Clicking a demo offer in a deployment
  with demo mode off is refused with an explanation, before the row is written — a recorded
  click can never resolve, and would sit in `clicks` looking like a real tracked click.
- **A click that was recorded elsewhere is not a dead end.** A click made in local
  development and engaged on a deployment with demo mode off (the same database, so this
  happens) redirects back to the catalog with `?notice=demo-unavailable`, and the catalog
  says why. The previous response was a 404 page reading "Demo offer not found."
- **The survey's questions are rows, not code.** They used to be defined twice — a literal
  array in `public/demo.js` and two `Set`s in `demoController` — and the two had to be edited
  together or the page would offer an answer the server rejected. `survey_questions` (migration
  010) is now the single definition: `GET /api/demo/survey` serves it, and completion is
  validated against the same rows, so the page can only ever offer what the server will accept.
  Editing a survey is a database change, not a deploy.
  - A row with a malformed option list is repaired by *dropping* the bad entries, never by
    inventing a value. An option with no usable value cannot be selected, and one generated
    from an index would store an answer nobody chose.
  - An answer that is not on the question's own option list is refused, which is what stops a
    page left open in a tab from before an edit recording a response to a question that no
    longer exists.
  - Extra keys in a submission are dropped rather than stored, so an unrecognised key cannot
    land in `conversions.details` as though it were an answer.
- **A completed survey returns to the offer wall by itself**, after a visible countdown with
  the link available at any point. Finishing a questionnaire and then having to find your own
  way back is the part of the flow that loses people; the countdown keeps the automatic return
  a convenience rather than something to wait out.
- **The survey is paged, one question at a time.** A wall of question groups scrolls past the
  point where someone is answering, and on a phone the submit button ends up several screens
  below the last question. Back and Next share one row, and the first option is focused on
  each step so arrow keys work immediately.
- **`tracking_url` is never sent.** With it, anyone could append their own `aff_sub` to the
  advertiser and claim credit for clicks that were never recorded — which is the entire
  reason for the `/offer/engage` hop.
- **Cards are filterable and searchable, and surveys are distinguishable.** Type chips (All /
  Offers / Surveys) narrow the list, and search covers the title, blurb, partner, and keywords
  — searching the title alone found nothing for a partner name that was visible on screen. The
  count reads "0 of 12 offers" when a filter is hiding things, because "0 offers" on a list of
  twelve reads as an outage, and the empty state offers a reset. The type is a badge and a
  survey states an estimated length, because "how long is this?" is the question people
  actually ask before committing and an unanswered one reads as an unbounded task.
- The response is short-cached (`max-age=30, s-maxage=30, stale-while-revalidate=60`) from
  the handler rather than from `vercel.json`, so a self-hosted deploy gets the same behaviour
  and the policy lives next to the response it describes. These rows are public, change
  rarely, and are identical for every visitor. A failure is answered 503 and never cached.

`offers.description` and `offers.partner_label` were added in migration `008` for the card.
`network_name` is the advertiser's tracking identifier, which reads as noise on a card, so it
is displayed only as a fallback.

## Front end

The stylesheet is a single design system in `public/style.css`, ordered tokens → base →
components → responsive. Every breakpoint lives in the last section, because the
previous version interleaved them with the base rules and later desktop declarations
silently overrode earlier mobile ones.

Two constraints the front end is built around:

- **The Content-Security-Policy is `style-src 'self'`.** Inline `style` attributes are
  blocked, so per-element custom properties are set through CSSOM
  (`element.style.setProperty`), which CSP permits. The build reads no inline styles.
- **`[hidden]` is forced with `!important`.** Any component that set `display` in a class
  rule was ignoring the `hidden` attribute, because an author rule beats the user-agent
  `[hidden] { display: none }`. That is why the password label stayed visible during a
  password reset.

### Live account updates

`GET /api/user/updates?version=…` is polled by the page so a balance, a confirmed
deposit, or a resolved withdrawal appears without a reload. It takes a `version` the
client already holds and returns `304 Not Modified` when nothing has changed, so the
common case — an idle visitor on the catalog — costs a conditional request rather than a
full history payload.

The version covers the latest deposit and withdrawal rows **and** the account's
`token_version`, so a password change or a forced sign-out cannot be missed by a client
that is only watching for payments. Any change returns refreshed balances, deposits, and
withdrawals with `Cache-Control: no-store`, because a cached balance is a wrong balance.

Polling is deliberately uneven. It is fast while a deposit is outstanding, since that is
when the user is watching a timer, and slow when the account is quiet; failures back off
rather than hammering a struggling server. Polling pauses while the tab is hidden and
resyncs immediately on return, because a browser throttles timers in a background tab and
returning to it would otherwise show a stale balance with no visible cause. A `304` is
not repainted, so the live indicator does not flicker on every idle poll.

The indicator above the balance states which of those is happening: live, waiting on a
provider, stale, just credited, or failed.

### Two layouts, not one layout that shrinks

The mobile and desktop experiences are separate layouts. The phone is not a narrow
desktop: a 390px viewport cannot hold a card *and* the control that operates it, so
reflowing the desktop card wastes the width it does have. The breakpoints are:

- `max-width: 720px` — phone. This is the layout the app is designed around, so these
  rules are written first and everything wider is the enhancement.
- `min-width: 721px` and up — desktop: hover and sticky behaviour, multi-column grids,
  dialogs as centred modals.
- `min-width: 1100px`, `1280px`, `1600px` — progressive widening of the content measure.

What actually changes at the phone breakpoint:

| Desktop | Phone |
| --- | --- |
| Header actions sit in the top bar | Same buttons mirrored into a fixed bottom action bar |
| Offer card: name, blurb, price, actions stacked | Offer row: name and price on one line, blurb, actions |
| Dialog centred as a modal | Dialog pinned to the bottom edge as a sheet, with a grab handle |
| Skeleton is a CSS grid | Skeleton is a flex column matching the card it replaces |

The bottom bar is what makes the phone layout usable: deposit, withdraw, and the account
controls stay reachable without scrolling back to the top, which is the only place a
desktop header makes sense. `body.has-action-bar` is what reserves space for it, and it
is scoped to that class on purpose — applying the padding to every `body` gave the home,
demo, and reset pages 68px of dead space at the bottom for a bar they do not render.

Type scales with `clamp()` rather than per-breakpoint overrides, and coarse pointers get
48px touch targets. The catalogue toolbar is sticky on desktop and scrolls away on the
phone, where a pinned search field would eat the fold.

To re-verify the cascade without a browser, `npm run check:responsive` parses the real
stylesheet and reports the computed declaration each viewport range resolves to.

## Testing

`npm test` runs the HTTP-level suite, which uses stubs and needs no database. The
live database suite is skipped unless `TEST_DATABASE_URL` is set, so it cannot touch
a production database by accident:

```bash
TEST_DATABASE_URL=postgresql://user:pass@host/testdb npm test
```

Run the live suite against a disposable database only.

`npm run smoke` is the one command that exercises the real wiring rather than stubs: it
boots the app and requests every page the deployment is supposed to serve, the catalog, the
full click hop through to the advertiser, the demo redirect, and an unsigned webhook. It
exists because the routing bug above was invisible to every other check — Express serves all
of those paths correctly, so only a real request against the real routes can tell that a
rewrite is swallowing one. It registers an account to make the click hop, and deletes it
afterwards. It needs a reachable database, and it points `APP_BASE_URL` at its own port, so
give it a free one (`PORT=3311 npm run smoke`).

`npm run smoke:survey` is the same idea for demo mode. It runs with
`NODE_ENV=production` — the environment of a real deployment — and walks the demo flow with
demo mode off, then on, then off again mid-flow to prove the last case returns the user to
the catalog instead of dead-ending. That middle case is the bug that was reported.

## Static checks

`npm run check` needs no database and no browser, and covers the two classes of front
end bug that only show up after a change has already landed:

- `check:frontend` — every element id the scripts reach for exists in the page that
  loads them, no duplicate ids, every `<label for>` and `aria-labelledby` target
  resolves, every class used in markup or built in script has a CSS rule, and no
  inline `style` attribute slipped in (the CSP would block it in production).
- `check:responsive` — parses `public/style.css` and asserts the declaration each
  viewport range actually resolves to, which is how a mobile rule being silently
  overridden by a later desktop rule gets caught without a browser.
