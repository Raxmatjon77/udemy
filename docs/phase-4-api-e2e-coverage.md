# Phase 4 API e2e coverage (P4-T17)

Gap audit of `docs/phase-4-commerce-enrollment-design.md` §5, §8, §9 and §14 against the API's Phase 4 specs. "e2e" means over HTTP through the real AppModule (global guards, validation, problem+json); "IT" means an integration spec that calls the use cases directly.

**Files:**

| Key   | File (under `apps/api/src/`)                                |
| ----- | ----------------------------------------------------------- |
| A     | `modules/commerce/commerce.e2e.spec.ts`                     |
| B     | `modules/commerce/commerce-b.e2e.spec.ts`                   |
| C     | `modules/commerce/commerce-c.e2e.spec.ts`                   |
| E     | `modules/enrollment/enrollment.e2e.spec.ts`                 |
| P     | `endpoints.e2e.spec.ts` (full SECTION_8 vs Swagger)         |
| IT-A  | `modules/commerce/commerce.integration.spec.ts`             |
| IT-B  | `modules/commerce/checkout.integration.spec.ts`             |
| IT-C  | `modules/commerce/refunds.integration.spec.ts`              |
| W     | `apps/worker/src/payouts/ledger-writer.integration.spec.ts` |
| **4** | **`phase4.e2e.spec.ts` (new, P4-T17)**                      |

**Summary:**

- **Before:** 55 Phase 4 e2e tests (A 7, B 10, C 13, E 25).
- **After:** 80. The new file **4** adds 25 tests.
- **Gaps closed:** 59 items that had no HTTP-level test, all listed below as "Gaps (now in **4**)" or "Now":
  - 34 route/error items, 6 IDOR, 7 concurrency, 6 webhook, 3 idempotency/reconcile, 2 refund lifecycle, 1 ledger.
  - 49 of them were covered only by IT or unit specs.
  - 10 were covered nowhere: the Express route check, cancel of a CREATING order, B on A's PENDING order (with the provider session left untouched), B's list, A's idempotency key used by B, the refund-vs-admin-refund race, a late completed after CANCEL, parallel duplicate webhooks, the per-state 409 table of refunds, and the ledger from real API flows.
- **Bugs:** none found. Every new case passed against the existing implementation, 3 runs out of 3.

## §8 routes: happy path, documented errors, auth

The "Auth" column covers anonymous, the wrong app (token replayed through another BFF), the wrong role, and foreign ids.

| Route                                                            | Happy      | Errors already e2e                                                                 | Gaps (now in **4**)                                                                                                     | Auth     |
| ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET /commerce/prices`                                           | A          | 400, 401 without C (A)                                                             | none                                                                                                                    | A        |
| `GET /me/cart`                                                   | A          | none documented                                                                    | none                                                                                                                    | A        |
| `PUT /me/cart/items/:id`                                         | A          | 404, 400, 409 `course_is_free` / `cannot_purchase_own_course` (A)                  | 409 `already_enrolled`, 409 `course_not_for_sale` (unpriced, archived), 422 `cart_full`, 429 (IT-A had some)            | A        |
| `DELETE /me/cart/items/:id`                                      | A          | none documented                                                                    | an absent item is 200 (idempotent)                                                                                      | A        |
| `POST /me/cart/merge`                                            | A          | 400 (A); skips incl. `cart_full` (IT-A)                                            | none                                                                                                                    | A        |
| `PUT` / `DELETE /me/cart/coupon`                                 | A          | 422 `coupon_invalid`, 400 (A)                                                      | 422 `coupon_expired` / `coupon_not_started` / `coupon_exhausted` / `coupon_already_used`, 429 (IT-A only)               | A        |
| `GET /me/purchase-states`                                        | A (schema) | none                                                                               | 400 (> 48, malformed); the enrolled / inCart / isOwner values                                                           | A        |
| `GET` / `PUT /courses/:id/pricing`                               | A          | 422 `price_not_allowed`, 400 (A)                                                   | 429 (10/day/course; IT-A only)                                                                                          | A        |
| `GET` / `POST /courses/:id/coupons`                              | A          | 409 `coupon_code_taken`, 400/422 window (A)                                        | 422 `course_is_free`, 429 (50/day)                                                                                      | A        |
| `POST /courses/:id/coupons/:cid/deactivate`                      | A          | 404 IDOR (A)                                                                       | 404 unknown coupon                                                                                                      | A        |
| `GET` / `POST /admin/coupons`, `…/deactivate`                    | A          | 404 for a course coupon (A)                                                        | 409 `coupon_code_taken`                                                                                                 | A        |
| `POST /me/free-enrollments`                                      | E          | 404, 409 `course_not_for_sale`, 400, 429 (E)                                       | 409 `course_not_free`, 409 `cannot_purchase_own_course` (IT only)                                                       | E        |
| `GET /me/enrollments`                                            | E          | 400, 422 cursor (E)                                                                | none                                                                                                                    | E        |
| `/admin/users/:id/enrollments`, `/admin/enrollments`, `…/revoke` | E          | 404, 409, 400 (E)                                                                  | none                                                                                                                    | E        |
| `POST /me/checkout`                                              | B          | 400 key / validation, 403, 409 ×3, 422 `cart_empty` / `idempotency_key_reused` (B) | 422 `amount_below_minimum`, 429, 503 `payment_provider_unavailable` with a real outage (IT-B had 503 and below-minimum) | B, **4** |
| `GET /me/orders`                                                 | B          | none documented                                                                    | keyset paging, malformed cursor (IT-B only)                                                                             | B        |
| `GET /me/orders/:id`, `…/receipt`                                | B          | 404, 409 `order_not_paid` (B)                                                      | none                                                                                                                    | B, **4** |
| `POST /me/orders/:id/cancel`                                     | B          | 404, 409, repeat 200 (B)                                                           | cancel of a CREATING order (replay-then-expire; not covered anywhere)                                                   | B, **4** |
| `POST /webhooks/stripe`                                          | B          | 400 `webhook_signature_invalid` (B)                                                | see "Webhook security"                                                                                                  | B        |
| `POST /me/orders/:id/refunds`                                    | C          | 409, 422 `refund_window_closed`, 400 (C)                                           | 422 `refund_not_applicable` (0.00 line), 404 unknown or foreign line, 429 (IT-C only)                                   | C, **4** |
| `GET /instructor/sales/summary`, `/instructor/sales`             | C          | 400 range (C)                                                                      | scoping by caller over HTTP: B's sales, `courseId` of A (see IDOR)                                                      | C, **4** |
| `GET /admin/orders`, `/admin/orders/:id`                         | C          | 400 (C)                                                                            | 404 `order_not_found`                                                                                                   | C        |
| `POST /admin/orders/:id/refunds`                                 | C          | 409, 422 (C)                                                                       | 404 unknown order; 404 for a line of another order                                                                      | C        |
| `POST /admin/orders/:id/accept-payment`                          | C          | 409 (C)                                                                            | 404                                                                                                                     | C        |
| `GET /admin/refunds`, `…/approve` · `/reject` · `/retry`         | C          | 404 approve, 409, 400 (C)                                                          | 404 reject / retry; the full state table (see "Refund lifecycle")                                                       | C        |
| SECTION_8 Phase 4 = Swagger                                      | P          | none                                                                               | Phase 4 subset compared explicitly (`SECTION_8_PHASE_4`)                                                                | none     |
| SECTION_8 Phase 4 = Express routes                               | none       | none                                                                               | **not covered anywhere before**                                                                                         | none     |

## IDOR matrix (§9)

Every refusal is a 404 problem. Each **4** case also takes a database snapshot of A's rows before and after, and checks that nothing changed.

| Case                                                                                                                    | Before                | Now                   |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- |
| Student B on A's PAID order: detail, receipt, cancel, refund                                                            | B, C (stranger = 404) | **4**                 |
| Student B on A's PENDING order: detail, receipt, cancel, refund; the provider session stays open                        | not covered           | **4**                 |
| A's `orderLineId` inside B's own order, and B's line inside A's order                                                   | IT-C only             | **4**                 |
| B's order list never shows A's orders                                                                                   | not covered           | **4**                 |
| A's `Idempotency-Key` used by B does not resume A's order                                                               | not covered           | **4**                 |
| Instructor B on A's pricing and coupons (GET/PUT/POST), A's coupon under B's course, B's coupon under A's course        | A (partly)            | **4**                 |
| Instructor B's sales: A's `courseId` filter gives nothing; B's summary and list show only B's lines; A sees exactly A's | C (partly)            | **4**                 |
| A course coupon through the admin platform-coupon route                                                                 | A                     | **4**                 |
| Student token on admin routes (403); token through the admin BFF (401)                                                  | C (matrix)            | **4** (with real ids) |
| Instructor-app token on `/me/*` (403); student token through the instructor BFF (401)                                   | B, C                  | **4**                 |

## Concurrency (§9)

| Item                                                                          | Before                           | Now (over HTTP)                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| N=20 parallel checkouts against `max_redemptions=1`: exactly 1 reserved       | IT-B with N=5                    | **4**: 20 buyers, 1 × 201 and 19 × 409 `price_changed`, 1 RESERVED                                                   |
| Two checkouts with different keys: one 201, one 409                           | IT-B                             | **4** (`checkout_in_progress` names the winner)                                                                      |
| The same key twice in parallel: one order                                     | IT-B                             | **4** (identical bodies, one order, one emulator session)                                                            |
| Concurrent duplicate webhook delivery: one effect                             | IT-B and B, sequential only      | **4**: 8 × same id + 4 new ids in parallel give 1 APPLIED, 4 DUPLICATE_EFFECT, one `OrderPaid`, one grant            |
| `expired` after `completed`: no-op                                            | IT-B                             | **4**                                                                                                                |
| Late `completed` after cancel: PAID, plus a duplicate auto-refund when needed | IT-B covered EXPIRED → PAID only | **4**: CANCELED → PAID (no refund); canceled, re-bought, then late → SYSTEM `DUPLICATE_PURCHASE` refund, access kept |
| Refund request racing an admin refund: one live refund                        | not covered                      | **4**: one 201, one 409 `refund_already_requested`, one SUCCEEDED                                                    |

## Webhook security

| Case                                                                                        | Coverage                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Missing signature, wrong secret, stale timestamp, re-serialized body, non-JSON              | B                                             |
| Tampered payload, signature or timestamp on emulator redelivery; same-id dedupe             | B                                             |
| Amount mismatch → PAYMENT_REVIEW                                                            | B                                             |
| Future timestamp (> 300 s ahead, §14)                                                       | **4**                                         |
| Malformed header (no `v1`, no `t`, duplicate `t`, garbage), no body detail                  | **4**                                         |
| Rolled secret (several `v1`, one valid) is accepted                                         | **4** (unit test in `@udemy/payments` before) |
| `livemode: true` → IGNORED; `payment_status: unpaid` → IGNORED; unknown order → ORPHAN, 200 | **4** (IT-B before)                           |

## Checkout idempotency and reconcile

| Case                                                                                                                                          | Coverage            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Resume by key (PENDING and PAID); different fingerprint → 422                                                                                 | B                   |
| Provider outage → 503, the order stays CREATING; the same key resumes it once the provider is back                                            | **4** (IT-B before) |
| Reconcile (b), overdue OPEN still open → EXPIRED at the provider                                                                              | B                   |
| Reconcile (b), completed with the webhook lost (500s until the emulator gives up) → PAID by RECONCILER; a later redelivery → DUPLICATE_EFFECT | **4** (IT-B before) |
| Reconcile (a), stale CREATING → ABANDONED / CANCELED, nothing payable left at the provider, the checkout slot is freed                        | **4** (IT-B before) |

## Refund lifecycle

| Transition / rule                                                                                                                                                                                      | Coverage |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| APPROVED → SUCCEEDED (synchronous); revoke at approval; kick                                                                                                                                           | C        |
| APPROVED → SUBMITTED → SUCCEEDED (`refund.updated`, `charge.refunded`)                                                                                                                                 | C        |
| REQUESTED → APPROVED / REJECTED (≥ 3 in 90 days)                                                                                                                                                       | C        |
| FAILED at create → retry (attempt 2) → SUCCEEDED                                                                                                                                                       | C        |
| SUBMITTED → FAILED via a `refund.failed` webhook; approve / reject / retry are 409 in SUBMITTED, approve / reject in FAILED, all three in SUCCEEDED; the transition log; no second refund for the line | **4**    |

## Ledger reconciliation (D13)

| Case                                                                                                                                                                                                                                                                                                                                                            | Coverage |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Writer on synthetic rows: SALE / REFUND, redelivery, REFUND before SALE, the job                                                                                                                                                                                                                                                                                | W        |
| From real API flows: every `OrderPaid` / `RefundSucceeded` outbox event of **4** (coupon, zero total, late payment, reconciled payment, accepted PAYMENT_REVIEW, refunds), posted with the worker's `@udemy/db` operations, gives `reconcileLedger` = [] and equal `getLedgerTotals`; before posting, the query reports the missing SALEs; replays post nothing | **4**    |

The API test package stays independent of `apps/worker`: **4** uses only `@udemy/db` (`postSaleEntry`, `postRefundEntry`, `reconcileLedger`, `getLedgerTotals`), following the mapping in `apps/worker/src/payouts/handlers/ledger-writer.handlers.ts`.
