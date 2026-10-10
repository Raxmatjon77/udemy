# @udemy/stripe-emulator

A **test-only** Stripe stand-in (design `docs/phase-4-commerce-enrollment-design.md`, D12 layer 3).
It implements the Checkout Session and Refund subset that `@udemy/payments` uses at API version
`2026-09-30.endive`, a hosted pay page, and signed webhook delivery with retries. API e2e and
Playwright point the **real** `StripePaymentProvider` at it with `STRIPE_API_BASE_URL`, so the
adapter, the raw-body webhook path and the signature verification all run for real, without
Stripe secrets.

All state is in memory. Never expose it beyond loopback and never point production at it.

## Running

| How                | Command                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Compose (dev)      | `docker compose --env-file .env -f infra/docker/docker-compose.dev.yml --profile emulator up -d --build stripe-emulator` |
| Host, watch mode   | `pnpm --filter @udemy/stripe-emulator dev` (set the env below first)                                                     |
| Host, built        | `pnpm --filter @udemy/stripe-emulator build && node apps/stripe-emulator/dist/main.js`                                   |
| In-process (tests) | `startEmulator(emulatorConfig({ secretKey, webhookSecret, webhookUrl }), { port: 0, host: '127.0.0.1' })`                |

The API then uses `STRIPE_API_BASE_URL=http://127.0.0.1:12111`, the same `STRIPE_SECRET_KEY` and
the same `STRIPE_WEBHOOK_SECRET`.

### Environment

| Variable                         | Default        | Meaning                                                                                     |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                           | `12111`        | Listen port.                                                                                |
| `HOST`                           | `0.0.0.0`      | Listen address.                                                                             |
| `STRIPE_SECRET_KEY`              | required       | The only accepted API key (`sk_test_…`), as `Authorization: Bearer` (or Basic user).        |
| `STRIPE_WEBHOOK_SECRET`          | required       | `whsec_…`; signs every delivery (`Stripe-Signature: t=…,v1=…`).                             |
| `EMULATOR_WEBHOOK_URL`           | unset          | Where events are POSTed. Unset: events are stored (`not_configured`) and never sent.        |
| `EMULATOR_PUBLIC_URL`            | listen address | Pay-page origin as the browser sees it; `session.url` is `${EMULATOR_PUBLIC_URL}/pay/{id}`. |
| `EMULATOR_CONTROL_ENABLED`       | `true`         | Mounts `/_emulator/*`. `false` removes it (404).                                            |
| `EMULATOR_WEBHOOK_MAX_ATTEMPTS`  | `5`            | Attempts per event, the first one included.                                                 |
| `EMULATOR_WEBHOOK_RETRY_BASE_MS` | `1000`         | First retry delay; doubles per attempt.                                                     |
| `EMULATOR_WEBHOOK_RETRY_MAX_MS`  | `60000`        | Retry delay cap.                                                                            |
| `EMULATOR_WEBHOOK_TIMEOUT_MS`    | `10000`        | Per-attempt timeout.                                                                        |
| `EMULATOR_EXPIRY_SWEEP_MS`       | `1000`         | How often open sessions past `expires_at` are expired (also checked on every request).      |
| `LOG_LEVEL`                      | `info`         | `debug` for more. Logs are JSON lines.                                                      |

## Stripe API subset (`/v1`)

Every `/v1` request needs the key. Bodies are `application/x-www-form-urlencoded` (JSON is
rejected, as on Stripe). A `Stripe-Version` header other than `2026-09-30.endive` is a 400
`api_version_invalid`. Errors use Stripe's envelope and status codes
(`{"error":{"type","code","param","message"}}`: 400 / 401 / 404, `stripe-should-retry: false`),
so the SDK raises the same error classes. Every response has a `Request-Id`.

**Idempotency** (POST): the same `Idempotency-Key` with the same method, path and parameters
replays the original response (`Idempotent-Replayed: true`, `Original-Request`). The same key with
anything different is 400 `idempotency_error`. Only executed (2xx) requests are saved, so a
request rejected by validation can be retried with the same key.

| Endpoint                                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/checkout/sessions`            | Accepts exactly what `buildCheckoutSessionParams` sends: `mode=payment`, `allowed_payment_method_types` (required, `card` only), `line_items[i][quantity]` + `[price_data][currency, unit_amount, product_data][name]`, `client_reference_id`, `customer_email`, `metadata`, `payment_intent_data[metadata]`, `success_url` (required), `cancel_url`, `expires_at` (30 min to 24 h). `payment_method_types` and any other parameter are 400 `parameter_unknown`. A total in 1..49 minor units is 400 `amount_too_small`. |
| `GET /v1/checkout/sessions/:id`         | The session. `url` is null once it is complete or expired. Unknown id: 404 `resource_missing`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /v1/checkout/sessions/:id/expire` | Open → expired, sends `checkout.session.expired`. Not open: 400, as on Stripe (the adapter then reports `ALREADY_COMPLETE` / `ALREADY_EXPIRED`).                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /v1/refunds`                      | Accepts `payment_intent` (required; from a paid session), `amount`, `reason` (`duplicate`, `fraudulent`, `requested_by_customer`), `metadata`. Default outcome: `succeeded`, and sends `charge.refunded` + `refund.updated`. Over-refund: 400 `charge_already_refunded` / `amount_too_large`. Unknown intent: 400 `resource_missing` (`param: payment_intent`). See the control API for failing or pending refunds.                                                                                                      |
| `GET /v1/refunds/:id`                   | The refund (current status, `failure_reason` when failed).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Hosted checkout page

`GET /pay/:sessionId` serves an accessible HTML page (no scripts, no external assets) with the
line items, the total and three buttons in one form (`POST /pay/:sessionId`, `action=…`):

| Button    | Result                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Pay`     | The session becomes complete + paid with a fake `pi_…` / `ch_…`; `checkout.session.completed` is sent; **303** to `success_url` with `{CHECKOUT_SESSION_ID}` replaced. |
| `Decline` | **402**, the same page with "Your card was declined" (`role="alert"`). The session stays open; no event.                                                               |
| `Cancel`  | **303** to `cancel_url` (only shown when one was given). The session stays open, as on Stripe.                                                                         |

A paid session's page is 409, an expired one 410, an unknown one 404.

## Webhooks

Events: `checkout.session.completed`, `checkout.session.expired` (API, control or the
`expires_at` sweep), `charge.refunded` (charge totals only, no embedded refunds),
`refund.updated` (succeeded), `refund.failed`, and `charge.dispute.created` (control only).
Envelopes match `stripeEvent()` in `@udemy/payments/testing`: unique `evt_…` id,
`api_version: 2026-09-30.endive`, `livemode: false`, `request.id` / `request.idempotency_key`
when an API call caused it.

Each event is serialized once; every attempt POSTs those bytes with
`Stripe-Signature: t={now},v1={HMAC}` computed by `computeWebhookSignature` from
`@udemy/payments`. Attempts run one at a time in creation order; a non-2xx (redirects included)
or a network error is retried after `base × 2^(n-1)` ms (capped) until the attempt limit. All
events stay stored for listing and redelivery.

## Control API (`/_emulator`)

JSON in, JSON out; errors are `{"error":{"message"}}` with 400 / 404 / 409. Mounted unless
`EMULATOR_CONTROL_ENABLED=false`. No auth: keep the port on loopback.

| Endpoint                                         | Body / query                                                                | Effect                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_emulator`                                 |                                                                             | Index: version, URLs and this endpoint list.                                                                                                                                                                                                                                                                                      |
| `GET /_emulator/state`                           |                                                                             | Sessions (with line items and the last decline), payment intents, refunds, queued refund plans.                                                                                                                                                                                                                                   |
| `POST /_emulator/checkout/sessions/:id/complete` |                                                                             | Pays an open session without a browser (same as `Pay`). Returns `{ session, redirectUrl }`. 409 when not open.                                                                                                                                                                                                                    |
| `POST /_emulator/checkout/sessions/:id/expire`   |                                                                             | Expires an open session now: `checkout.session.expired`. 409 when not open.                                                                                                                                                                                                                                                       |
| `POST /_emulator/refunds/fail-next`              | `{ count?: 1..100, failureReason? }`                                        | The next refund(s) are returned `pending` and then fail (`refund.failed`). Default reason `expired_or_canceled_card`.                                                                                                                                                                                                             |
| `POST /_emulator/refunds/next`                   | `{ outcome: "succeeded" \| "failed" \| "pending", count?, failureReason? }` | Plans the next refund(s), FIFO. `pending` stays pending until settled.                                                                                                                                                                                                                                                            |
| `POST /_emulator/refunds/:id/settle`             | `{ outcome: "succeeded" \| "failed", failureReason? }`                      | Settles a pending refund (`charge.refunded` + `refund.updated`, or `refund.failed`). 409 when not pending.                                                                                                                                                                                                                        |
| `POST /_emulator/payment_intents/:id/dispute`    | `{ reason? }` (default `fraudulent`)                                        | Sends `charge.dispute.created` for a paid intent.                                                                                                                                                                                                                                                                                 |
| `GET /_emulator/events`                          | `?type=…&status=pending\|retrying\|delivered\|failed\|not_configured`       | Sent events, oldest first, with `status`, `attempts[]` (`kind`, `statusCode`, `error`, `tamper`), `nextAttemptAt`, `deliveredAt`.                                                                                                                                                                                                 |
| `GET /_emulator/events/:id`                      |                                                                             | One event's delivery record plus the exact event JSON.                                                                                                                                                                                                                                                                            |
| `POST /_emulator/events/:id/redeliver`           | `{ tamper?: "payload" \| "signature" \| "stale_timestamp" }`                | Sends the event again (same id and bytes, fresh signature), one attempt, no retries; waits and returns `{ attempt }`. Use it to test dedupe. `tamper` sends a deliberately invalid delivery: body altered after signing, a wrong secret, or `t` 10 minutes old. A failed or tampered redelivery never changes the event's status. |
| `POST /_emulator/webhooks/drain`                 | `?timeoutMs=` (default 10000, max 60000)                                    | Waits until nothing is queued, in flight or waiting to retry. Returns `{ idle }`.                                                                                                                                                                                                                                                 |
| `POST /_emulator/reset`                          |                                                                             | Forgets sessions, payments, refunds, plans, idempotency keys and events (pending retries are dropped).                                                                                                                                                                                                                            |

`GET /health` returns 200 `{"status":"ok"}` (no auth).

## Tests

- `pnpm --filter @udemy/stripe-emulator test`: unit specs, plus the shared PaymentProvider
  contract suite (`src/contract/payment-provider-contract.ts`) run with the real
  `StripePaymentProvider` against an in-process emulator on a random port, and webhook delivery
  to a local sink that verifies every request with `verifyWebhook` and an ephemeral `whsec_`.
- The same suite's stateless cases also run against stripe-mock when `IT_STRIPE_MOCK_URL` is set
  (skipped otherwise; a set but unreachable URL fails).
