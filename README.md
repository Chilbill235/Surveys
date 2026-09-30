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
     The `whsec_...` value Stripe shows when you create the endpoint is what belongs in
     `STRIPE_WEBHOOK_SECRET`. It is *not* the API key: the key creates the Checkout session
     and the signing secret verifies the callback that credits it, and the app needs both.
   - NOWPayments IPN: the app sends `https://<your-domain>/api/payments/nowpayments/ipn`
     as `ipn_callback_url`.

   Card deposits stay hidden until both Stripe variables hold real values. The example
   environment ships readable stand-ins (`whsec_your_stripe_webhook_secret_here`), and a
   stand-in is a non-empty string, so a plain "is it set?" check passes on it: the app
   offers cards, takes the payment, and then cannot verify the webhook that would credit
   the balance. Values that are obviously templates are therefore treated as missing, at
   startup, in the deposit options, in the webhook, and in reconciliation. See
   `src/services/credentials.js`.
6. Add a `CRON_SECRET` variable. `vercel.json` schedules a job that re-checks pending
   deposits against the provider and credits any the provider reports as finished, so one
   lost webhook cannot strand funds. The schedule is daily, which every plan allows; a
   sub-daily schedule (`0 */6 * * *`) is rejected outright on Hobby and fails the deploy.

`TRUST_PROXY` sets how many proxy hops Express trusts when it resolves `req.ip`, and it
defaults to `1`. The count matters because every per-IP limiter in the app -- login,
registration, password reset, verification resend, the magic link -- is keyed on `req.ip`.

`true` would be the wrong default. It tells Express to trust the whole `X-Forwarded-For`
chain, which makes `req.ip` the **leftmost** entry: the one the client wrote. Vercel's edge
appends to that header rather than replacing it, so a spoofed header survives to the app and
every rate limit in the app becomes free to bypass. `1` takes the **rightmost** entry, the one
the edge appended, which is the address the edge actually saw. A Vercel deployment has exactly
one proxy in front of the function, so `1` gives the real client address.

Set `TRUST_PROXY` to the hop count your own chain actually has, or `false` to disable it
entirely. Setting it too low is the opposite failure: every visitor collapses into the proxy's
address and they share one rate-limit bucket.

### How requests are routed

`vercel.json` is where this app most easily breaks, because every page and the click
tracking hop are served by the function, not by static files.

| Request | Handled by |
| --- | --- |
| `/api/**` | the function (`api/index.js` -> `src/app.js`) |
| `/style.css`, `/*.js`, `/*.html` | Vercel's static files, served before any rewrite |
| `/` | the function, which serves the marketing home page |
| `/offers` | the function, which serves the offer catalog |
| `/account` | the function, which serves the account page |
| `/login` | the function, which serves `login.html` — the sign-in page in its own right, not the account page behind a dialog |
| `/reset-password`, `/receipt/deposit/:id`, `/demo`, `/terms`, `/privacy` | the function, which picks the right page |
| `/index.html` | 301 to `/offers` — it is a real file in `public/`, so without this the catalog is served at two URLs |
| `/history`, `/history.html` | 301 to `/account`, so an old bookmark or a static-file URL still lands somewhere real |
| **`/offer/engage`** | the function — this is the redirect to the advertiser |
| everything else | the function, which answers 404 |

`/` and `/offers` are different pages on purpose: `/` is the marketing page, and `/offers` is
the catalog that `app.js` drives. They were briefly the same file, which made the marketing
copy and the catalog contend for one URL.

Ten HTML pages are served this way (`home`, `index`, `account`, `login`, `history`, `demo`,
`deposit-receipt`, `reset-password`, `terms`, `privacy`) and `check:frontend` and
`check:a11y` both read every one of them. Coverage originally covered only four, which is
how three classes with no CSS rule reached `index.html` while the check still reported a
clean bill of health.

### The sign-in gate

`/offers`, `/account` and `/receipt/deposit/:id` require a session. A visitor without one is
sent to `/login?next=<where they were>` and returned there after signing in. Two decisions
behind that, both of which were the other way round at first:

**`/login` is its own page, not the account page with a dialog on it.** It was, and the
dashboard was visible around the edges of the dialog, legible in the gaps, and still there
if the dialog was dismissed — Escape, the close button, a click on the backdrop. A visitor
who must sign in could see the thing they were signing in to reach, and could stay on it
with every control greyed out. `login.html` is the sign-in screen and nothing else: no
header, no balance, no catalog, and no close control, because there is nothing behind it to
close. The account page keeps its dialog for the case that is genuinely a choice rather than
a dead end — clicking "Connect account" in the header of a page that *is* reachable signed
out, where the account page is legitimately on screen.

**The gate runs on the client, and that is a consequence of where the session lives.** It
is a token in `sessionStorage`, so the server has nothing to check until the first API call;
a server-side redirect would be a redirect-to-login on every page load, for signed-in users
too. The API is still the authority — a 401 anywhere calls `handleUnauthorized`, which
signs the visitor out and sends them to `/login` with the same return path. The client-side
gate exists so the decision happens before the page paints rather than after.

Marking a page private is one attribute: `data-requires-session="true"` on its `<body>`.
`public/session-gate.js` is loaded before the page's own scripts on every page that could
use it, so the decision is made before anything renders. `scripts/smoke-ui.js` asserts the
whole behaviour in a real browser — the redirect, the return path, that Escape and a
backdrop click change nothing, that the sign-in page contains no balance or catalog
element, and that a visitor with a session is not sent to sign in.

The `next` parameter is read from the query string, so it is only honoured when it is a
path on this site: a leading `/`, and not `//` or `/\`, because those resolve against
another origin after a sign-in.

`history.html` is no longer routed: `/history` redirects to `/account`, which is where the
same markup is served from. The file is still checked, because it is what `/history` used to
serve and a stale copy of a page is how a fix lands on one file and not the other.

The rewrite is `/((?!api/).*)` -> `/api/index.js`. It must **not** point at `index.html`.

That is the single highest-impact mistake available in this file, and it was the one that
shipped. Rewriting every non-API path to `index.html` is the standard SPA configuration and
it looks completely reasonable, but `/offer/engage` is not under `/api` — so the advertiser
redirect was swallowed, every user who clicked an offer landed back on the offers page, and
nothing anywhere reported an error. The same rewrite also broke `/` (the home page became
the catalog), `/reset-password` (password reset could never load its form), and
`/receipt/deposit/:id` (no receipt). The tests could not catch it, because under `npm start` Express
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
  fails the build if that stops being true. The one inline `<script>` on the home page is
  `type="application/ld+json"`, which is not a JavaScript MIME type and so is not an inline
  script as far as the directive is concerned.
- `style-src 'self' 'unsafe-inline'` is required for exactly one reason: the `<style>` block
  inside the home page's `<noscript>`, which hides the offer list for a visitor without
  JavaScript. With scripting disabled that content is parsed as ordinary DOM, so the `<style>`
  element is subject to `style-src` like any other, and it is blocked without
  `'unsafe-inline'`.

  It is **not** required for the CSSOM writes the deposit QR and the staggered card animation
  use to set custom properties. `element.style.setProperty` is not an inline style attribute
  and is permitted under `style-src 'self'`. The previous version of this file claimed the
  opposite, which is worth correcting precisely because the wrong reason is worse than no
  reason: it invites someone to delete the `<noscript>` block, remove `'unsafe-inline'` to
  tighten the policy, and break the no-JavaScript path -- while the CSSOM code would have
  kept working either way, giving no signal that the change was load-bearing.


## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (Neon, Supabase, RDS, ...). |
| `DATABASE_CA_CERT` | recommended | Provider CA in PEM form (`\n` escapes allowed). Enables certificate verification. |
| `DATABASE_SSL` | optional | `disable` turns TLS off. Defaults to TLS on with no verification unless a CA is set. |
| `DATABASE_POOL_MAX` | optional | Connection pool ceiling. Clamped to a hard maximum, because `2000` would otherwise have every serverless instance exhaust the provider's own connection limit. |
| `PGSSLMODE` | optional | Read as a fallback for `DATABASE_SSL`, using libpq's names. |
| `STRICT_DATABASE_URL` | optional | `true` makes an unreachable database fatal at startup instead of a logged warning. Off by default: a process that cannot reach its database is not useful, but one that will not start is worse — it answers no request at all. |
| `JWT_SECRET` | yes | Long random value that signs session tokens. |
| `APP_BASE_URL` | yes | Public HTTPS origin. Used for provider callbacks and reset links. |
| `POSTBACK_SECRET` | production | Shared secret for advertiser postbacks. |
| `PROXYCHECK_KEY` | optional | VPN/proxy fraud checks on click tracking. |
| `PROXYCHECK_REQUIRED` | optional | `true` refuses clicks while a proxy check cannot run. Default `false`: the click is tracked and the gap logged. |
| `FRAUD_VELOCITY_THRESHOLD`, `FRAUD_VELOCITY_WINDOW_SECONDS` | optional | How many clicks one address may record in a window before it is treated as automated. |
| `FIXIE_URL` | optional | Fixed-egress proxy for NOWPayments **payout** calls, which are restricted to a whitelist of IP addresses. Needed on a serverless host, whose outbound address changes on every cold start. Leave empty once the provider's IP whitelist is switched off. |
| `NOWPAYMENTS_PAYOUT_PROXY` | optional | `off` (or `false`/`0`/`direct`) never routes payouts through `FIXIE_URL`, even when that variable is still present. Set it when the provider no longer restricts payouts by IP — a stale or expired proxy otherwise fails every payout. |
| `OFFERS_TEST_REAL` | optional | `true` lets a demo offer marked `pays_real_money` move a **real** balance instead of `demo_balance`. Off by default: a deployment that never sets it cannot move cash through the demo flow. |
| `OFFERS_INCLUDE_DEMO` | optional | `true` enables the demo offers, the `/demo` page, and the demo reward flow. Unset means enabled outside production only. |
| `CRON_SECRET` | recommended | Protects scheduled deposit reconciliation. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for cards | Enables Stripe Checkout deposits. Both are required; either one alone leaves no working card path. Template values count as unset. |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | for crypto | Enables crypto deposits. |
| `NOWPAYMENTS_API_BASE_URL` | optional | Defaults to `https://api.nowpayments.io`. |
| `NOWPAYMENTS_FIXED_RATE`, `NOWPAYMENTS_FEE_PAID_BY_USER` | optional | `POST /v1/payment` options. Default `false`. |
| `NOWPAYMENTS_EMAIL`, `NOWPAYMENTS_PASSWORD` | for crypto payouts | JWT for the payout endpoints. Case-sensitive. |
| `NOWPAYMENTS_2FA_SECRET` | for crypto payouts | Base32 TOTP secret. Without it a batch is created but never verified, so the payout is never sent. |
| `NOWPAYMENTS_AUTO_PAYOUTS` | optional | `true` sends eligible **crypto** withdrawals automatically. Unset means off. See [Automatic crypto payouts](#automatic-crypto-payouts). |
| `BREVO_API_KEY`, `EMAIL_FROM` | for signup and reset email | Default provider. Brevo needs no domain of your own. `EMAIL_FROM` must be a sender registered in Brevo. |
| `CONTACT_EMAIL` | optional | Where the contact form delivers. Falls back to `EMAIL_FROM`. |
| `EMAIL_VERIFICATION_PEPPER` | recommended | Peppers stored email-verification code hashes. Falls back to `JWT_SECRET`. Set it explicitly so rotating `JWT_SECRET` does not invalidate every outstanding code. |
| `WITHDRAWAL_VERIFICATION_PEPPER` | recommended | As above for withdrawal codes. Deliberately a *different* pepper, so a hash lifted from one table cannot be replayed against the other. Falls back to `JWT_SECRET`. |
| `RESEND_API_KEY` | optional | Only if `EMAIL_PROVIDER=resend`, and only once you have verified a custom domain — Resend will not send to anyone but the account owner until then. |
| `EMAIL_PROVIDER` | optional | `brevo` (default) or `resend`. Inferred from whichever key is set if unset. |
| `EMAIL_FROM_NAME` | optional | Display name on outgoing mail. Defaults to `RewardZone`. |
| `CORS_ORIGIN` | optional | Comma-separated extra browser origins. |
| `TRUST_PROXY` | optional | Proxy hop count used to resolve `req.ip`. Defaults to `1`; set `false` to disable. See "Trust proxy" above — `true` is not safe here. |
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
4. **A duplicate `unique_external_id` is held, not released.** The id sent to the provider is
   `wd-<withdrawal id>`, derived from the row rather than generated, so it is identical on every
   attempt to send the same withdrawal — which is what makes a repeated send impossible. The
   cost is that once *any* attempt has reached the provider, the id is spent for good and
   `POST /v1/payout` answers `400 unique_external_id already exists` from then on.

   That refusal arrives as a 4xx, so the general rule above would release the claim — and this
   is the one 4xx where that is exactly backwards. The refusal is evidence that a payout under
   this id *exists*. Releasing sends the row back to `pending`, the next run re-claims it, the
   next send is refused identically, and the loop repeats on every scheduler tick: the log
   reads `1 claimed, 1 resolved [74:released]` while the balance stays debited and the money
   never moves. It is also a double-payment hazard, because a row released to `pending` is one
   the app will send under a fresh id the moment one is supplied.

   So this case is detected by the provider's own wording (`isDuplicateExternalId`) and held
   like a transport failure whose answer is unknown. See
   [When something is stuck](#when-something-is-stuck) — it needs a person, because the only
   way to learn the existing payout's batch id is the dashboard.
5. **Only a `FINISHED` callback marks a withdrawal paid**, and only a `REJECTED` one refunds
   it. Both go through the same `sendWithdrawal` / `reverseWithdrawal` the operator endpoints
   use, so a `paid` withdrawal still cannot be refunded and a refund is still a balance
   write plus a ledger row in one transaction.
6. **Only crypto, filtered in SQL.** The claim query carries `payment_method = 'crypto'`, so
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

   The secret is generated on the NOWPayments dashboard, under **Set up IPN** → *Your IPN secret
   key*. Copy it into `NOWPAYMENTS_IPN_SECRET` (it is 32 characters) and never regenerate it
   without updating the environment: a rotated secret invalidates the signature on every callback
   in flight, and they are refused as `Signature did not match` until the new one is deployed.

3. **Set the dashboard's Webhook URL** to
   `https://<your-domain>/api/payments/nowpayments/ipn`, with `APP_BASE_URL` set to the same
   public HTTPS origin.

   This is a safety net rather than the main path. Both the deposit create and the payout batch
   submit pass their own `ipn_callback_url`, built from `APP_BASE_URL`, so callbacks normally
   arrive without the dashboard setting. It is still worth setting: it is what covers a payment
   created outside the API, and it is where a delivery failure shows up. If `APP_BASE_URL` is
   localhost the app refuses to build a callback at all rather than posting the provider a dead
   address — a deposit would then never be credited, with no error anywhere.

   **Webhook format:** either option is now safe. *All-Strings* used to be a hazard and was
   hardened — the handler decided "is this a child payment?" by testing `parent_payment_id` for
   truth, and that field is `null` for an ordinary parent payment. Under All-Strings a JSON
   `null` arrives as the string `"null"`, so the parent was read as a child, acknowledged with
   a 200, and credited nothing: the money arrived and the balance never moved, on every crypto
   deposit, from one dropdown. The check is now an explicit test for a real parent id. Everything
   else the callback reads is coerced with `String()`/`Number()`, so the format is inert.

   **Recurring notifications:** leave it on. It is the provider's retry schedule for callbacks
   that fail to deliver, and it is what rescues a payout whose callback was missed while the
   service was down. A 5-minute interval costs nothing when nothing is wrong.

4. **Redeploy.** `db/migrations/009_auto_payouts.sql` adds the payout columns and the unique
   index on `batch_id`; the build applies it.
5. **Check readiness** — this sends nothing:
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

One `SUBMISSION_UNKNOWN` needs more than the others. When the provider answers
`400 unique_external_id already exists`, the log says so explicitly and names the external id
(`wd-<withdrawal id>`). The run will not fix it and re-running will not either — the id is
spent for good, so the same refusal comes back every time. Settle it from the NOWPayments
dashboard:

- **A payout exists under that external id.** It is the one this app sent. Mark it with
  `npm run withdrawals -- paid <id> <provider-reference>`, or let the callback land if the batch
  was verified.
- **No payout exists under it.** The row is safe to release, but nothing in the app will do it
  for you — the id stays spent, so re-sending would be refused the same way. Use the operator
  endpoints, and expect to send the payout under a fresh external id.

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

### Cancelling your own withdrawal

`POST /api/user/withdrawals/:id/cancel` lets a user take back a request that is going nowhere,
and the withdraw dialog offers a **Cancel** button on any row the server marks `cancellable`. It
is a refund — the balance goes straight back — so the interesting part is when it is *refused*.

A user cannot be asked to read a provider dashboard first, so this is deliberately **narrower**
than the operator refund above rather than a thinner version of it. The operator rule is "refuse
anything with a `provider_reference`", because that is the record that a payout was submitted.
That guard is not enough on its own: `provider_reference` is only written when a payout reaches
`paid`, so **every stage before that leaves it NULL** — claimed, batch submitted, in flight, or
parked because the provider never answered. A crypto withdrawal in `WAITING` is therefore
invisible to it, and refunding one credits the balance while the transfer completes, paying the
same person twice with a ledger that agrees with itself throughout.

So a cancel is allowed only while the row carries no evidence that a payout was ever *started*:

| Column | Means |
| --- | --- |
| `payout_claimed_at` | A payout run has claimed this row. |
| `payout_status` | The provider or the claimer has written a payout state onto it. |
| `batch_id` / `payout_provider_id` | A batch exists at the provider under this id. |
| `payout_submitted_at` | A submission was recorded. |
| `provider_reference` | A payout was submitted or finished. |

`payout_claimed_at` is the one that makes this safe rather than merely cautious. It is written
by the claim `UPDATE` in the same statement that moves the row to `processing`, and cleared only
on a *release* — a provable refusal. So "no claim is live" holds even across a crash mid-run: a
row claimed by a process that then died is refused, which is correct, because that process may
have sent the payout before it went down.

The refusals are worded separately because they are not the same problem. `already-sent` is the
only one the app cannot resolve itself, so it says the balance was **not** refunded and that
support can confirm it — a message that left the refund unmentioned would be read as "your money
is on its way back" by exactly the users who most want to believe it. The same predicate is
computed in SQL for the list endpoint's `cancellable` flag, so the button and the rule that
enforces it cannot drift apart.

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

## Email

Every money-moving event sends a message, and the six of them are:

| Message | Sent when | Service |
| --- | --- | --- |
| Deposit instructions | the address and amount are issued | `depositEmails` |
| Deposit received | the balance is credited | `depositEmails` |
| Deposit did not complete | the payment fails or expires | `depositEmails` |
| Withdrawal on its way | a payout batch is released | `payoutEmails` |
| Withdrawal sent | the payout confirms on-chain | `payoutEmails` |
| Withdrawal returned | the provider refuses, and the money is refunded | `payoutEmails` |

Plus the three that are **not** switchable: email confirmation, password reset, and the
six-digit code that authorises a withdrawal. Each one is a step the user has to complete, so
suppressing it does not quiet the app — it locks the account out of itself. Nothing in the
code path that sends those three reads the preference.

### The money-email switch

`GET` and `PATCH /api/user/email-preferences` carry one boolean, `moneyEmailsEnabled`,
stored in `users.money_emails_enabled` (migration `022`). The response also names which
messages are gated and which are not, so the account page describes the real policy rather
than a copy of it that can drift.

Three things about the send path are deliberate:

- **Reads fail open.** If the preference cannot be read, the message is sent. The send path
  runs on webhooks and cron nobody is watching, so a suppressed message leaves no trace,
  while an unwanted one is visible and fixable.
- **A missing value means "on".** A column that was not selected, a row that predates the
  migration, and `NULL` all read as enabled. "We do not know" must never mean "do not send".
- **The body must state a boolean.** `PATCH` refuses `"false"`, `0`, `null`, and `{}` rather
  than treating any of them as an opt-out. A preference the user did not clearly express is
  not a preference, and the failure is invisible because the response would report the
  stored value as though the request had been understood.

`isMoneyEmailEnabled` is the only place that reads the column, and it normalises the shapes a
different driver or a hand-edited column can produce (`'f'`, `'false'`, `'0'`) — a naive
`if (value)` reads the string `"false"` as `true` and silently ignores the opt-out.

### Display name and profile picture

`GET` and `PATCH /api/user/profile` carry `displayName` and `avatarData`, stored in
`users.display_name` and `users.avatar_data` (migration `023`). The account page edits both
in the Profile settings card, and the picture replaces the brand mark in the header and the
name in the header-adjacent area of the balance card.

Both fields are **presentation only**. Nothing reads them to decide what a user may do, so a
rename cannot touch a ledger row, a deposit, or a session — which is why `display_name` does
not need to be unique and why neither is resolved against another account. That is what makes
it safe to let a user type freely into one.

`PATCH` is partial: a body naming only `displayName` writes only that column. A fixed
two-column `UPDATE` would blank the picture on every name change, and the client cannot avoid
that — it does not know the current value of the field it is not sending, and reading it
first is a race between two open tabs. A field present and `null` (or empty) clears it.

Validation lives in `src/services/profile.js` and runs **on the server**. The browser applies
the same rules, but the browser is the untrusted side of the connection and the stored value
is what gets rendered next to a balance:

- **Display name** — trimmed, whitespace runs collapsed to single spaces (so a pasted
  non-breaking space does not render identically to another user's plain space), max 60
  characters measured *after* normalisation, and control characters refused rather than
  stripped. Stripping would store something different from what was typed, and the user
  would be shown a name they did not enter. Tab, newline, and carriage return are folded to
  spaces first, because a name pasted with a line break in it is a paste artefact, not an
  attempt to smuggle a control character. Lone surrogates are refused because `Buffer.from`
  would silently store U+FFFD in place of the character the user typed.
- **Profile picture** — a `data:image/<type>;base64,` URL, restricted to PNG, JPEG, GIF, and
  WebP. `svg+xml` is excluded because SVG is a document format that can carry script. The
  declared media type is a claim by the sender and nothing checks it, so the decoded bytes are
  verified against the declared signature (structurally for WebP, which is a RIFF container
  and shares its first four bytes with WAV). The size is checked **twice** — encoded length
  first, before any decode, so a multi-megabyte upload is refused without being turned into
  bytes; then decoded length, capped at 16 KB.

`avatar_data` holds the image bytes as a data URL rather than a path, because this service
deploys to Vercel where the filesystem is ephemeral and per-invocation (a file written during
a request is gone by the next one), and no object storage is configured. The trade-off is a
`users` row that grows, which the 16 KB cap and the 32 KB JSON body limit bound. A product
needing full-resolution uploads should move the image to object storage and keep only a URL
here; the column shape does not need to change.

The client centre-crops the picked file to 128×128 and re-encodes it before sending, which is
what keeps a typical upload inside both the 16 KB avatar cap and the 32 KB request limit
without asking the user to resize anything themselves.

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

- **No inline `style` attributes.** `style-src` is `'self' 'unsafe-inline'` (see
  "The Content-Security-Policy" above for why), so a `style` attribute in markup would not be
  *blocked* -- but none is wanted anyway. Per-element custom properties are set through CSSOM
  (`element.style.setProperty`), and `check:frontend` fails the build if an inline style
  attribute appears, so the day `'unsafe-inline'` is dropped for the `<noscript>` block nothing
  has to change to keep working.
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

### The transaction list pages on the server

`GET /api/user/history` returns five rows at a time — `?limit=` and `?offset=`, with the true
total for the current tab in the `X-Total-Count` header — and the account page pages through
them with Previous/Next. The response body is still a bare array of transactions, because the
CSV export iterates it directly; the count is a header rather than an envelope for exactly that
reason.

Two decisions are load-bearing, and both are about the filter tabs rather than the paging:

- **The `type` filter is applied in SQL, not to the page that came back.** Fetching one page and
  filtering it to deposits counts the wrong rows: the tab would show three of twenty under a
  header claiming twenty, and "page 2" would skip or repeat rows depending on where the
  deposits happened to fall. `?type=` is matched against a fixed list, and an unrecognised value
  is refused rather than treated as no filter — silently returning everything would hide a client
  bug behind a list that looks right.
- **The count and the page come from one query**, via `COUNT(*) OVER ()`, so they cannot
  describe different moments. A page past the end has no rows to carry the window function's
  count, so it asks for the count separately rather than substituting its own offset, which
  would invent a screenful of pages that do not exist.

The list refreshes in real time by listening for `applyLiveUpdate`'s `historyChanged` event
rather than running a timer of its own. `/api/user/updates` already polls, already answers `304`
when the ledger is still, and already carries the rows that moved, so a second poller would cost
a request every twenty seconds to learn nothing. The CSV export asks for `limit=500` instead:
five rows is right for a list and wrong for a file, and an export that quietly covered one page
would be indistinguishable from an account with five transactions.

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

`npm run smoke:ui` drives the real pages in a real Chrome or Edge and asserts the controls
are not inert. It needs the server running (`npm start`) and no account, no seeded offers and
no money: it runs signed out, which is the only state that needs nothing set up.

It exists because no static check can catch a button that is reachable, correctly styled, and
has nothing behind it. The account page shipped that way — two permanently greyed-out
buttons, a balance frozen at `--`, and a Connect button that went nowhere — and every other
check passed. Only clicking proves otherwise. It asserts that each page loads with no
uncaught error and no broken script, that the console is clean for our own origin, and then
the two things only a browser can see:

- **The sign-in gate.** That `/offers`, `/account` and `/receipt/deposit/1` each send a
  signed-out visitor to `/login` carrying the page they came from; that the sign-in page is a
  document rather than a dialog, with no close control, no header and no balance or catalog
  element behind it; that Escape and a click on the backdrop change nothing; that Back does
  not walk onto a private page; and that a visitor with a session is not sent to sign in.
  These are the assertions that would have caught `/login` being the account page with a
  modal on top — a check that passed for the wrong reason until the page was made real.
- **The signed-in dashboard.** That the Deposit and Withdraw controls exist and are enabled
  with a session, that the session button says what its next click will do, and that the
  animated brand mark appears as the account avatar. The API is answered locally for this
  rather than against the server: the only token available is a fake one, the real API answers
  401, and a 401 is a sign-out — so without the stub the dashboard redirects away before it can
  be observed.

Errors logged by a third-party embed are attributed by origin and reported as notes, not
failures. The donation widget currently logs one — `account-api.nowpayments.io` answers 404
for its settings call — which is that provider's problem and is already covered by the
visible fallback text on the page.

## Static checks

`npm run check` needs no database and no browser, and covers the two classes of front
end bug that only show up after a change has already landed. It runs all four checks and
reports every failure, rather than stopping at the first one — the chain used to be `&&`, so a
`check:frontend` failure meant the contrast check never ran and a contrast regression stayed
hidden until the front end was clean. The exit code is still non-zero if anything failed, so
it remains a usable CI gate.

- `check:frontend` — every element id the scripts reach for exists in the page that loads
  them, no duplicate ids, every `<label for>` and `aria-labelledby` target resolves, every
  class used in markup or built in script has a CSS rule, no inline `style` attribute slipped
  in (the CSP would block it in production), and every `data-contact-trigger` is backed by a
  `#contact-dialog` on the same page.

  The contact-trigger rule is there because of a real dead link. The handler calls
  `preventDefault()` before it looks for the dialog, so a page carrying the trigger without
  the dialog has a link that navigates nowhere and opens nothing — `privacy.html` shipped
  with `contact.js` loaded, the footer link present, and no dialog to drive it.

  All nine pages are checked. A script that more than one page loads is not asserted against
  any single page — `app.js` runs on the catalog and both account pages and reaches the
  catalog through optional lookups precisely because those pages have no catalog — so instead
  every id it asks for must exist on at least one of its host pages. That still catches a
  renamed or typo'd id that exists nowhere, which is what the check is for.

- Every button in the markup is reachable from a script, and every `data-contact-trigger` is
  backed by a `#contact-dialog` on the same page.

  The button rule is the one that would have caught the dead account page. It reports a
  control that is `disabled` in the markup and that no script enables or listens to, and a
  `type="button"` control that no script listens to. Both fail silently: no console error, no
  failed request, nothing for any other check to notice. `account.html` shipped its primary
  Deposit and Withdraw buttons exactly that way — the script wired only `deposit-button` and
  `withdraw-button`, which are the header and action-bar controls on the catalog — so the
  whole account page was inert while every check reported clean.

  Controls wired through a data attribute are recognised as wired. The bottom action bar is
  wired by `data-mirror` and one delegated listener that forwards the click, so judging those
  by id alone would fire on the site's main mobile navigation and teach everyone to ignore
  this check. An id the script treats as optional is listed as a NOTE rather than a failure,
  so a guarded `if (element)` lookup is not "fixed" by deleting the guard.

## Auditing the SQL

`npm run audit:sql` needs a live database, which is why it is not in `npm run check`. It reads
every SQL string out of `src`, `scripts` and `test`, resolves the table aliases each statement
declares, and reports any column name that matches no column of the table it is used with.

It exists because a stubbed pool cannot tell you a column is imaginary. `UPDATE users SET
money_emails_enabled = $1, updated_at = NOW()` shipped that way: `users` has no `updated_at`
— `created_at` is its only timestamp, and `deposits` and `withdrawals` do have one, which is
where the assumption came from. Every test passed, because none of them parsed the statement,
and the only place it ran was a real request against a real database. The preference saved
nothing and reported no error.

Statements that interpolate a JS value are counted and reported rather than guessed at, since
a column list is not knowable from the string; the two that use one in this codebase are
covered by `test/autoPayouts.test.js` and the migration that introduced the column. The
registry test (`test/methodRegistry.test.js`) is the other half of the same idea on the HTTP
side: it asserts that every API path the app serves is registered with its verbs, so a wrong
verb is a 405 naming the right one instead of a 401 or a 404 that reads as "this does not
exist".

`audit:sql` catches a column that was never created. It cannot catch a column that exists but
was never added to the database this deployment is pointed at, so `server.js` also compares
`schema_migrations` against the migration files this build ships and warns at startup when
the database is behind, naming the files and the `npm run migrate` that fixes them. It warns
rather than refuses to boot, because a pending migration only breaks the routes that use the
new columns — refusing to start would take down the ones that work.

- `check:responsive` — parses `public/style.css` and asserts the declaration each
  viewport range actually resolves to, which is how a mobile rule being silently
  overridden by a later desktop rule gets caught without a browser.
