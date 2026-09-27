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
6. Add a `CRON_SECRET` variable. `vercel.json` schedules a job every 6 hours that
   re-checks pending deposits against the provider and credits any the provider
   reports as finished, so one lost webhook cannot strand funds.

`TRUST_PROXY` defaults to `true` on Vercel so per-IP rate limiting sees the real
client address from `X-Forwarded-For`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (Neon, Supabase, RDS, ...). |
| `DATABASE_CA_CERT` | recommended | Provider CA in PEM form (`\n` escapes allowed). Enables certificate verification. |
| `DATABASE_SSL` | optional | `disable` turns TLS off. Defaults to TLS on with no verification unless a CA is set. |
| `JWT_SECRET` | yes | Long random value that signs session tokens. |
| `APP_BASE_URL` | yes | Public HTTPS origin. Used for provider callbacks and reset links. |
| `POSTBACK_SECRET` | production | Shared secret for advertiser postbacks. |
| `PROXYCHECK_KEY` | production | VPN/proxy fraud checks on click tracking. |
| `CRON_SECRET` | recommended | Protects scheduled deposit reconciliation. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for cards | Enables Stripe Checkout deposits. |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | for crypto | Enables crypto deposits. |
| `NOWPAYMENTS_API_BASE_URL` | optional | Defaults to `https://api.nowpayments.io`. |
| `NOWPAYMENTS_FIXED_RATE`, `NOWPAYMENTS_FEE_PAID_BY_USER` | optional | `POST /v1/payment` options. Default `false`. |
| `NOWPAYMENTS_EMAIL`, `NOWPAYMENTS_PASSWORD` | for crypto payouts | JWT for the payout endpoints. Case-sensitive. |
| `RESEND_API_KEY`, `EMAIL_FROM` | for reset email | Sends password reset messages. |
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
  is quoted for each coin and applied to the amount the user submits. On the account this
  was last verified against, the floor for USD→BTC was **$18.80**, so the app's previous
  flat `$1` accepted every amount the provider was going to refuse. The picker states the
  real floor and changes it when the coin changes.
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
