# P4-T1: Final schema design for migration `0004_commerce_enrollment_payouts`

I didn't run anything against a database and I didn't write any files.

## What I checked, and how

**PG 18 behaviour, checked in the docs (18.6 pages for ddl-generated-columns and sql-createtable):**

- Generated columns default to `VIRTUAL`.
- A generation expression cannot reference another generated column.
- Only virtual generated columns are restricted to built-in functions. Stored ones may use user-defined functions.
- Deferrable constraints cannot be `ON CONFLICT` arbiters.

**PG 18 behaviour, checked in the source (REL_18_STABLE):**

- **Referencing side** (`tablecmds.c`, `ATAddForeignKeyConstraint`): the generated-column checks loop only over `fkattnum[]`. A virtual column there gives "foreign key constraints on virtual generated columns are not supported". A stored column there may not use `ON UPDATE` or `ON DELETE` `CASCADE`, `SET NULL` or `SET DEFAULT`. 0003 already uses this pattern (`categories.parent_depth`).
- **Referenced side** (`transformFkeyCheckAttrs`): it does not look at `attgenerated` at all. It needs only a unique index that is valid, not partial, not on expressions, not deferrable, and covers the same set of columns.
- **Indexes** (`indexcmds.c`, `DefineIndex`): only _virtual_ generated columns are rejected ("unique constraints on virtual generated columns are not supported").
- **Conclusion:** `refunds (order_id, order_line_id, amount) → order_lines (order_id, id, final_amount)` is valid if and only if `final_amount` is `STORED`. sql-ops must prove this first; the trigger fallback is in §6 item 1.

**Inputs read:**

- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-4-commerce-enrollment-design.md` (all of it)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-2-schema-design.md` (all of it)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-1-schema-design.md` (§3–§8)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/migrations/{2026_10_09_0001_init.ts, 2026_10_10_0002_identity_access_users.ts, 2026_10_10_0003_catalog_media.ts}`
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/database.ts` and `package.json` (the codegen command and its `parent_depth` override)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/infra/postgres/roles.sql`
- `apps/worker/src/maintenance/*-cleanup.job.ts` (the lock keys `0x75646d79_01` and `_02`)

**Reused, not recreated:**

- `public.set_updated_at()` (0001)
- `public.forbid_append_only_mutation()` (0002)
- `public.forbid_row_change()` (0003)
- the `commerce`, `enrollment` and `payouts` schemas (0001)

**Naming:**

- `<table>_<cols>_<pk|fk|uq|ck|idx>`. Trigger-raised pseudo-constraints use `_ck`.
- The longest name is `enrollment_transitions_enrollment_id_prev_seq_from_status_fk` (60 characters).

**Isolation:** every commerce, enrollment and payouts transaction must run at **READ COMMITTED**. The reservation trigger and the lock-then-count steps depend on each statement getting a fresh snapshot (§6, race R1).

---

## 1. Complete DDL

```sql
-- =====================================================================
-- 0. Shared commerce helper: the single rounding authority for coupon discounts.
--    Called by the quote SQL (§8.1) and by the order_lines guard (below).
-- =====================================================================
CREATE FUNCTION commerce.coupon_discount(p_list numeric, p_type text, p_percent_off smallint, p_amount_off numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE p_type
         WHEN 'PERCENT' THEN round(p_list * p_percent_off / 100, 2)   -- numeric round = half away from zero = half-up for >= 0
         WHEN 'AMOUNT'  THEN least(p_amount_off, p_list)               -- floored at 0 (final = list - discount >= 0)
       END;
COMMENT ON FUNCTION commerce.coupon_discount(numeric, text, smallint, numeric) IS
  'Discount of one coupon on one list price (D3/D5). Half-up percent to 2 decimals; AMOUNT capped at list. The Money VO in contracts must property-test equal to this.';

-- =====================================================================
-- 1. commerce.course_prices + append-only history (D2)
-- =====================================================================
CREATE TABLE commerce.course_prices (
  course_id  uuid          NOT NULL,                 -- soft ref to catalog.courses (D12)
  amount     numeric(12,2) NOT NULL,                 -- 0.00 = free; tier membership is app-validated (PRICE_TIERS)
  currency   char(3)       NOT NULL,
  updated_by uuid          NOT NULL,
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT course_prices_pk            PRIMARY KEY (course_id),
  CONSTRAINT course_prices_updated_by_fk FOREIGN KEY (updated_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT course_prices_amount_ck     CHECK (amount BETWEEN 0 AND 9999.99),
  CONSTRAINT course_prices_currency_ck   CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT course_prices_times_ck      CHECK (updated_at >= created_at)
);
CREATE TRIGGER course_prices_immutable_trg BEFORE UPDATE ON commerce.course_prices
  FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.forbid_row_change('course_prices_immutable_ck', 'course_prices.course_id/created_at are immutable');
-- Every UPDATE must change the price, so every row version has exactly one history row
CREATE TRIGGER course_prices_noop_update_trg BEFORE UPDATE ON commerce.course_prices
  FOR EACH ROW WHEN ((OLD.amount, OLD.currency) IS NOT DISTINCT FROM (NEW.amount, NEW.currency))
  EXECUTE FUNCTION public.forbid_row_change('course_prices_noop_update_ck', 'a course price update must change amount or currency');
CREATE TRIGGER course_prices_set_updated_at_trg BEFORE UPDATE ON commerce.course_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE commerce.course_price_changes (
  id         uuid          NOT NULL DEFAULT uuidv7(),
  course_id  uuid          NOT NULL,
  amount     numeric(12,2) NOT NULL,
  currency   char(3)       NOT NULL,
  changed_by uuid          NOT NULL,
  changed_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT course_price_changes_pk            PRIMARY KEY (id),
  CONSTRAINT course_price_changes_course_id_fk  FOREIGN KEY (course_id) REFERENCES commerce.course_prices (course_id) ON DELETE RESTRICT,
  CONSTRAINT course_price_changes_changed_by_fk FOREIGN KEY (changed_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT course_price_changes_amount_ck     CHECK (amount BETWEEN 0 AND 9999.99),
  CONSTRAINT course_price_changes_currency_ck   CHECK (currency ~ '^[A-Z]{3}$')
);
-- GetCoursePricing history (last 20, previous amount via lag()) + the 10/day check (ops; the rate limit itself is Redis)
CREATE INDEX course_price_changes_course_id_changed_at_idx ON commerce.course_price_changes (course_id, changed_at DESC, id DESC);
CREATE TRIGGER course_price_changes_append_only_trg BEFORE UPDATE OR DELETE ON commerce.course_price_changes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER course_price_changes_no_truncate_trg BEFORE TRUNCATE ON commerce.course_price_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE FUNCTION commerce.course_prices_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO commerce.course_price_changes (course_id, amount, currency, changed_by, changed_at)
  VALUES (NEW.course_id, NEW.amount, NEW.currency, NEW.updated_by, NEW.updated_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER course_prices_record_change_trg AFTER INSERT OR UPDATE ON commerce.course_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.course_prices_record_change();

COMMENT ON TABLE commerce.course_prices IS
  'Current price per course (D2). Materialised latest row of course_price_changes, written in the same statement by course_prices_record_change_trg; history cannot be skipped. No row = not for sale (D16). Never deleted (0.00 = free).';
COMMENT ON TABLE commerce.course_price_changes IS
  'Append-only price history. previous amount = lag(amount) OVER (PARTITION BY course_id ORDER BY changed_at, id); the event payload uses RETURNING old.amount of the upsert.';

-- =====================================================================
-- 2. commerce.carts / cart_items (D4)
-- =====================================================================
CREATE TABLE commerce.carts (
  user_id     uuid        NOT NULL,
  coupon_code text        NULL,           -- user input, stored uppercased; not an FK (may match nothing)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_pk             PRIMARY KEY (user_id),
  CONSTRAINT carts_user_id_fk     FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
  CONSTRAINT carts_coupon_code_ck CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9_-]{4,20}$')
);
CREATE TRIGGER carts_set_updated_at_trg BEFORE UPDATE ON commerce.carts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE commerce.carts IS
  'Server cart (signed-in users). The row is also the per-user commerce mutex (lock order step 1, §6): checkout, the PAID transition, cancel and refund requests lock it FOR UPDATE first.';

CREATE TABLE commerce.cart_items (
  user_id   uuid        NOT NULL,
  course_id uuid        NOT NULL,         -- soft ref (D12)
  added_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_pk         PRIMARY KEY (user_id, course_id),    -- add = ON CONFLICT DO NOTHING; also inCart lookups
  CONSTRAINT cart_items_user_id_fk FOREIGN KEY (user_id) REFERENCES commerce.carts (user_id) ON DELETE CASCADE
);
COMMENT ON TABLE commerce.cart_items IS 'At most COMMERCE_CART_MAX_ITEMS (20) per cart, enforced by the app under the cart row lock.';

-- =====================================================================
-- 3. commerce.coupons (immutable terms, D5)
-- =====================================================================
CREATE TABLE commerce.coupons (
  id              uuid          NOT NULL DEFAULT uuidv7(),
  scope           text          NOT NULL,
  course_id       uuid          NULL,           -- soft ref (D12); NULL = platform coupon
  code            text          NOT NULL,
  discount_type   text          NOT NULL,
  percent_off     smallint      NULL,
  amount_off      numeric(12,2) NULL,
  currency        char(3)       NULL,
  starts_at       timestamptz   NOT NULL,
  ends_at         timestamptz   NOT NULL,
  max_redemptions integer       NULL,
  created_by      uuid          NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  deactivated_at  timestamptz   NULL,
  deactivated_by  uuid          NULL,
  CONSTRAINT coupons_pk                PRIMARY KEY (id),
  -- one code per course; platform coupons (course_id NULL) share one namespace. Also serves ListCoupons by course
  -- and "code within cart courses OR platform" lookups (BitmapOr of two probes)
  CONSTRAINT coupons_course_id_code_uq UNIQUE NULLS NOT DISTINCT (course_id, code),
  CONSTRAINT coupons_created_by_fk     FOREIGN KEY (created_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT coupons_deactivated_by_fk FOREIGN KEY (deactivated_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT coupons_scope_ck          CHECK (scope IN ('COURSE','PLATFORM')),
  CONSTRAINT coupons_scope_course_ck   CHECK ((scope = 'COURSE') = (course_id IS NOT NULL)),
  CONSTRAINT coupons_code_ck           CHECK (code ~ '^[A-Z0-9_-]{4,20}$'),
  CONSTRAINT coupons_discount_type_ck  CHECK (discount_type IN ('PERCENT','AMOUNT')),
  CONSTRAINT coupons_discount_shape_ck CHECK ((discount_type = 'PERCENT') = (percent_off IS NOT NULL)
                                              AND (discount_type = 'AMOUNT') = (amount_off IS NOT NULL)
                                              AND (amount_off IS NULL) = (currency IS NULL)),
  CONSTRAINT coupons_percent_off_ck    CHECK (percent_off IS NULL OR percent_off BETWEEN 1 AND 100),
  CONSTRAINT coupons_amount_off_ck     CHECK (amount_off IS NULL OR amount_off BETWEEN 0.01 AND 9999.99),
  CONSTRAINT coupons_currency_ck       CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT coupons_platform_type_ck  CHECK (scope <> 'PLATFORM' OR discount_type = 'PERCENT'),
  CONSTRAINT coupons_window_ck         CHECK (ends_at > starts_at
                                              AND starts_at <= created_at + interval '90 days'
                                              AND (scope <> 'COURSE'   OR ends_at - starts_at BETWEEN interval '1 day' AND interval '31 days')
                                              AND (scope <> 'PLATFORM' OR ends_at - starts_at <= interval '90 days')),
  CONSTRAINT coupons_max_redemptions_ck CHECK (max_redemptions IS NULL OR max_redemptions BETWEEN 1 AND 100000),
  CONSTRAINT coupons_deactivated_ck    CHECK ((deactivated_at IS NULL) = (deactivated_by IS NULL)
                                              AND (deactivated_at IS NULL OR deactivated_at >= created_at))
);
CREATE TRIGGER coupons_immutable_trg BEFORE UPDATE ON commerce.coupons
  FOR EACH ROW WHEN (
       (OLD.id, OLD.scope, OLD.course_id, OLD.code, OLD.discount_type, OLD.percent_off, OLD.amount_off, OLD.currency,
        OLD.starts_at, OLD.ends_at, OLD.max_redemptions, OLD.created_by, OLD.created_at)
       IS DISTINCT FROM
       (NEW.id, NEW.scope, NEW.course_id, NEW.code, NEW.discount_type, NEW.percent_off, NEW.amount_off, NEW.currency,
        NEW.starts_at, NEW.ends_at, NEW.max_redemptions, NEW.created_by, NEW.created_at)
    OR OLD.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('coupons_immutable_ck', 'coupon terms are immutable; only one deactivation is allowed');
COMMENT ON TABLE commerce.coupons IS
  'Course (instructor) and platform (admin) coupons. Terms immutable; state (SCHEDULED/ACTIVE/EXHAUSTED/EXPIRED/DEACTIVATED) is derived. Codes are never reusable within a course. <= 10 active per course: app, under the course_prices row lock.';
COMMENT ON COLUMN commerce.coupons.code IS 'Uppercase ASCII (app normalises). text + CHECK instead of citext: the alphabet is ASCII so the CHECK is exact, and citext would make ~ and LIKE case-insensitive.';

-- =====================================================================
-- 4. commerce.orders
-- =====================================================================
CREATE TABLE commerce.orders (
  id                  uuid          NOT NULL DEFAULT uuidv7(),
  order_number        bigint        GENERATED ALWAYS AS IDENTITY,
  user_id             uuid          NOT NULL,
  status              text          NOT NULL,
  currency            char(3)       NOT NULL,
  total_amount        numeric(12,2) NOT NULL,
  idempotency_key     uuid          NOT NULL,
  request_fingerprint bytea         NOT NULL,
  placed_at           timestamptz   NOT NULL DEFAULT now(),   -- = creation (replaces created_at); = seq 1 transition
  paid_at             timestamptz   NULL,                     -- = the (single) transition into PAID
  closed_at           timestamptz   NULL,                     -- = first transition into EXPIRED/CANCELED
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT orders_pk                          PRIMARY KEY (id),
  CONSTRAINT orders_order_number_uq             UNIQUE (order_number),               -- admin q = order number
  CONSTRAINT orders_user_id_idempotency_key_uq  UNIQUE (user_id, idempotency_key),   -- checkout resume; also the user_id FK index
  CONSTRAINT orders_id_user_id_uq               UNIQUE (id, user_id),                -- FK target: redemptions, refunds
  CONSTRAINT orders_id_total_amount_currency_uq UNIQUE (id, total_amount, currency), -- FK target: payments
  CONSTRAINT orders_user_id_fk                  FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT orders_status_ck                   CHECK (status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW','EXPIRED','CANCELED','PARTIALLY_REFUNDED','REFUNDED')),
  CONSTRAINT orders_currency_ck                 CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT orders_total_amount_ck             CHECK (total_amount = 0 OR total_amount BETWEEN 0.50 AND 999999.99),  -- D3 Stripe minimum
  CONSTRAINT orders_zero_total_ck               CHECK (total_amount > 0 OR status = 'PAID'),  -- zero-total orders are born PAID, never refunded
  CONSTRAINT orders_request_fingerprint_ck      CHECK (octet_length(request_fingerprint) = 32),
  CONSTRAINT orders_paid_at_ck                  CHECK ((status NOT IN ('PAID','PARTIALLY_REFUNDED') OR paid_at IS NOT NULL)
                                                       AND (status NOT IN ('PENDING_PAYMENT','PAYMENT_REVIEW','EXPIRED','CANCELED') OR paid_at IS NULL)),
  CONSTRAINT orders_closed_at_ck                CHECK ((status NOT IN ('EXPIRED','CANCELED') OR closed_at IS NOT NULL)
                                                       AND (status <> 'PENDING_PAYMENT' OR closed_at IS NULL)),
  CONSTRAINT orders_times_ck                    CHECK ((paid_at IS NULL OR paid_at >= placed_at) AND (closed_at IS NULL OR closed_at >= placed_at))
);
-- D15: at most one open checkout per user (23505 -> checkout_in_progress)
CREATE UNIQUE INDEX orders_user_id_pending_uq ON commerce.orders (user_id) WHERE status = 'PENDING_PAYMENT';
-- ListMyOrders keyset: WHERE user_id=$1 AND (placed_at,id) < ($c,$id) ORDER BY placed_at DESC, id DESC
CREATE INDEX orders_user_id_placed_at_id_idx ON commerce.orders (user_id, placed_at DESC, id DESC);
-- Admin order list (default order, optional from/to on placed_at)
CREATE INDEX orders_placed_at_id_idx ON commerce.orders (placed_at DESC, id DESC);
-- Admin order list filtered by status
CREATE INDEX orders_status_placed_at_id_idx ON commerce.orders (status, placed_at DESC, id DESC);

CREATE TRIGGER orders_set_updated_at_trg BEFORE UPDATE ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER orders_immutable_trg BEFORE UPDATE ON commerce.orders
  FOR EACH ROW WHEN (
       (OLD.id, OLD.user_id, OLD.currency, OLD.total_amount, OLD.idempotency_key, OLD.request_fingerprint, OLD.placed_at)
       IS DISTINCT FROM
       (NEW.id, NEW.user_id, NEW.currency, NEW.total_amount, NEW.idempotency_key, NEW.request_fingerprint, NEW.placed_at)
    OR (OLD.paid_at   IS NOT NULL AND NEW.paid_at   IS DISTINCT FROM OLD.paid_at)
    OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at))
  EXECUTE FUNCTION public.forbid_row_change('orders_immutable_ck', 'order identity/money columns are immutable; paid_at/closed_at are set once');
COMMENT ON TABLE commerce.orders IS
  'The commercial fact (D6). status/placed_at/paid_at/closed_at materialise order_transitions (orders_status_log_ck); total = sum of line finals (orders_total_ck); status agrees with SUCCEEDED refunds (orders_refund_status_ck), payment (payments_order_status_ck) and redemptions (coupon_redemptions_order_status_ck); all checked at COMMIT. Never deleted.';
COMMENT ON COLUMN commerce.orders.paid_at IS 'When the order was accepted as paid (enrollments granted). PAYMENT_REVIEW has none; the provider capture time is payments.succeeded_at. Refund window starts here.';
COMMENT ON COLUMN commerce.orders.request_fingerprint IS 'SHA-256 of the quote fingerprint (sorted courseId:final pairs, coupon id, currency). Same Idempotency-Key with another fingerprint -> idempotency_key_reused.';

-- =====================================================================
-- 5. commerce.coupon_redemptions (D7). Reservation authority lives in its BEFORE INSERT trigger.
-- =====================================================================
CREATE TABLE commerce.coupon_redemptions (
  order_id    uuid        NOT NULL,
  coupon_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,        -- = orders.user_id (pinned by composite FK); needed for the per-user unique
  status      text        NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz NULL,
  released_at timestamptz NULL,            -- kept after a late RELEASED -> CONSUMED (marks the overshoot)
  CONSTRAINT coupon_redemptions_pk                 PRIMARY KEY (order_id, coupon_id),     -- FK target for order_lines; PAID/cancel update by order_id
  CONSTRAINT coupon_redemptions_coupon_id_fk       FOREIGN KEY (coupon_id) REFERENCES commerce.coupons (id) ON DELETE RESTRICT,
  CONSTRAINT coupon_redemptions_order_id_user_id_fk FOREIGN KEY (order_id, user_id) REFERENCES commerce.orders (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT coupon_redemptions_status_ck          CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
  CONSTRAINT coupon_redemptions_timestamps_ck      CHECK ((status = 'RESERVED' AND consumed_at IS NULL AND released_at IS NULL)
                                                       OR (status = 'CONSUMED' AND consumed_at IS NOT NULL)
                                                       OR (status = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)),
  CONSTRAINT coupon_redemptions_times_ck           CHECK ((consumed_at IS NULL OR consumed_at >= reserved_at)
                                                       AND (released_at IS NULL OR released_at >= reserved_at))
);
-- One live redemption per user per coupon (23505 -> coupon_already_used). A late re-consumption (released_at set)
-- is excluded, otherwise a late payment could collide with a newer redemption and the webhook would fail forever (§6 R1).
CREATE UNIQUE INDEX coupon_redemptions_coupon_id_user_id_active_uq
  ON commerce.coupon_redemptions (coupon_id, user_id) WHERE status IN ('RESERVED','CONSUMED') AND released_at IS NULL;
-- max_redemptions count + "already used by me" (quote and trigger), index-only
CREATE INDEX coupon_redemptions_coupon_id_counted_idx
  ON commerce.coupon_redemptions (coupon_id) INCLUDE (user_id) WHERE status IN ('RESERVED','CONSUMED');

CREATE FUNCTION commerce.coupon_redemptions_reserve_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_deactivated timestamptz;
  v_starts      timestamptz;
  v_ends        timestamptz;
  v_max         integer;
  v_used        bigint;
BEGIN
  IF NEW.status NOT IN ('RESERVED','CONSUMED') OR NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a coupon redemption must be created RESERVED (or CONSUMED for a zero-total order)'
      USING ERRCODE = '23514', CONSTRAINT = 'coupon_redemptions_transition_ck';
  END IF;
  -- Mutex per coupon (conflicts with itself and with DeactivateCoupon's UPDATE; not with FK KEY SHARE).
  -- READ COMMITTED: the count below is a new statement, so it sees reservations committed while we waited.
  SELECT deactivated_at, starts_at, ends_at, max_redemptions INTO v_deactivated, v_starts, v_ends, v_max
    FROM commerce.coupons WHERE id = NEW.coupon_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;   -- coupon_redemptions_coupon_id_fk reports it
  END IF;
  IF v_deactivated IS NOT NULL OR now() < v_starts OR now() >= v_ends THEN
    RAISE EXCEPTION 'coupon % is not redeemable now', NEW.coupon_id
      USING ERRCODE = '23514', CONSTRAINT = 'coupon_redemptions_coupon_valid_ck';
  END IF;
  IF v_max IS NOT NULL THEN
    SELECT count(*) INTO v_used FROM commerce.coupon_redemptions r
     WHERE r.coupon_id = NEW.coupon_id AND r.status IN ('RESERVED','CONSUMED');
    IF v_used >= v_max THEN
      RAISE EXCEPTION 'coupon % is exhausted', NEW.coupon_id
        USING ERRCODE = '23514', CONSTRAINT = 'coupon_redemptions_limit_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER coupon_redemptions_reserve_trg BEFORE INSERT ON commerce.coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_reserve_guard();
CREATE TRIGGER coupon_redemptions_transition_trg BEFORE UPDATE ON commerce.coupon_redemptions
  FOR EACH ROW WHEN (
       (OLD.order_id, OLD.coupon_id, OLD.user_id, OLD.reserved_at) IS DISTINCT FROM (NEW.order_id, NEW.coupon_id, NEW.user_id, NEW.reserved_at)
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
    OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
    OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'RESERVED' AND NEW.status IN ('CONSUMED','RELEASED'))
       OR (OLD.status = 'RELEASED' AND NEW.status = 'CONSUMED'))))
  EXECUTE FUNCTION public.forbid_row_change('coupon_redemptions_transition_ck', 'illegal coupon redemption transition');
CREATE TRIGGER coupon_redemptions_no_truncate_trg BEFORE TRUNCATE ON commerce.coupon_redemptions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.coupon_redemptions IS
  'One row per (order, coupon). RESERVED at checkout, CONSUMED at PAID, RELEASED at EXPIRED/CANCELED, RELEASED->CONSUMED on a late payment (counted, may overshoot max_redemptions; accepted, D7). Validity and the limit are enforced by coupon_redemptions_reserve_trg under the coupon row lock. Status agrees with the order status at COMMIT.';

-- =====================================================================
-- 6. commerce.order_lines (immutable snapshot; generated money in one SQL rounding authority, D3/D6)
-- =====================================================================
CREATE TABLE commerce.order_lines (
  id                      uuid          NOT NULL DEFAULT uuidv7(),
  order_id                uuid          NOT NULL,
  line_no                 smallint      NOT NULL,
  course_id               uuid          NOT NULL,     -- soft ref (D12)
  instructor_id           uuid          NOT NULL,     -- snapshot of the owner at sale time
  course_title            text          NOT NULL,     -- snapshot of the live title at sale time
  list_amount             numeric(12,2) NOT NULL,
  discount_amount         numeric(12,2) NOT NULL DEFAULT 0,
  coupon_id               uuid          NULL,
  revenue_share_bps       integer       NOT NULL,     -- snapshot of COMMERCE_INSTRUCTOR_SHARE_BPS (7000)
  -- STORED is mandatory: PG 18 defaults to VIRTUAL, and final_amount is an FK target (refunds)
  final_amount            numeric(12,2) NOT NULL GENERATED ALWAYS AS (list_amount - discount_amount) STORED,
  instructor_share_amount numeric(12,2) NOT NULL GENERATED ALWAYS AS
                            (round(((list_amount - discount_amount) * revenue_share_bps) / 10000, 2)) STORED,
  -- repeats the expression: a generated column cannot reference another generated column
  platform_share_amount   numeric(12,2) NOT NULL GENERATED ALWAYS AS
                            ((list_amount - discount_amount) - round(((list_amount - discount_amount) * revenue_share_bps) / 10000, 2)) STORED,
  CONSTRAINT order_lines_pk                          PRIMARY KEY (id),
  CONSTRAINT order_lines_order_id_line_no_uq         UNIQUE (order_id, line_no),            -- line fetch by order; FK index
  CONSTRAINT order_lines_order_id_course_id_uq       UNIQUE (order_id, course_id),
  CONSTRAINT order_lines_order_id_id_final_amount_uq UNIQUE (order_id, id, final_amount),   -- FK target: refunds (line in order + full amount)
  CONSTRAINT order_lines_order_id_fk                 FOREIGN KEY (order_id) REFERENCES commerce.orders (id) ON DELETE RESTRICT,
  CONSTRAINT order_lines_instructor_id_fk            FOREIGN KEY (instructor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  -- a discounted line must have a redemption of that coupon on the same order
  CONSTRAINT order_lines_order_id_coupon_id_fk       FOREIGN KEY (order_id, coupon_id)
                                                     REFERENCES commerce.coupon_redemptions (order_id, coupon_id) ON DELETE RESTRICT,
  CONSTRAINT order_lines_line_no_ck                  CHECK (line_no BETWEEN 1 AND 20),
  CONSTRAINT order_lines_course_title_ck             CHECK (char_length(course_title) BETWEEN 1 AND 60 AND course_title = btrim(course_title) AND course_title !~ '[[:cntrl:]]'),
  CONSTRAINT order_lines_list_amount_ck              CHECK (list_amount BETWEEN 0.01 AND 9999.99),   -- free courses are never sold
  CONSTRAINT order_lines_discount_amount_ck          CHECK (discount_amount >= 0 AND discount_amount <= list_amount),
  CONSTRAINT order_lines_coupon_id_ck                CHECK ((coupon_id IS NULL) = (discount_amount = 0)),
  CONSTRAINT order_lines_revenue_share_bps_ck        CHECK (revenue_share_bps BETWEEN 0 AND 10000)
);
-- Instructor sales summary / recent sales; FK index for instructor_id
CREATE INDEX order_lines_instructor_id_order_id_idx ON commerce.order_lines (instructor_id, order_id);
-- Admin order search by courseId; P6 analytics
CREATE INDEX order_lines_course_id_idx ON commerce.order_lines (course_id);

-- Coupon scope + discount math backstop. BEFORE triggers must not read NEW.final_amount: stored generated
-- columns are computed after BEFORE ROW triggers.
CREATE FUNCTION commerce.order_lines_coupon_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_scope     text;
  v_course    uuid;
  v_type      text;
  v_pct       smallint;
  v_amt       numeric;
  v_cur       text;
  v_order_cur text;
BEGIN
  IF NEW.coupon_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT scope, course_id, discount_type, percent_off, amount_off, currency
    INTO v_scope, v_course, v_type, v_pct, v_amt, v_cur
    FROM commerce.coupons WHERE id = NEW.coupon_id;
  IF NOT FOUND THEN
    RETURN NEW;   -- order_lines_order_id_coupon_id_fk reports it
  END IF;
  SELECT currency INTO v_order_cur FROM commerce.orders WHERE id = NEW.order_id;
  IF (v_scope = 'COURSE' AND v_course IS DISTINCT FROM NEW.course_id)
     OR (v_cur IS NOT NULL AND v_cur IS DISTINCT FROM v_order_cur) THEN
    RAISE EXCEPTION 'coupon % does not apply to course %', NEW.coupon_id, NEW.course_id
      USING ERRCODE = '23514', CONSTRAINT = 'order_lines_coupon_scope_ck';
  END IF;
  IF NEW.discount_amount IS DISTINCT FROM commerce.coupon_discount(NEW.list_amount, v_type, v_pct, v_amt) THEN
    RAISE EXCEPTION 'order line discount % does not match coupon % terms', NEW.discount_amount, NEW.coupon_id
      USING ERRCODE = '23514', CONSTRAINT = 'order_lines_discount_ck';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER order_lines_coupon_trg BEFORE INSERT ON commerce.order_lines
  FOR EACH ROW EXECUTE FUNCTION commerce.order_lines_coupon_guard();
CREATE TRIGGER order_lines_append_only_trg BEFORE UPDATE OR DELETE ON commerce.order_lines
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER order_lines_no_truncate_trg BEFORE TRUNCATE ON commerce.order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.order_lines IS
  'What was sold, forever (D6/D13). Insert-only. final/instructor/platform shares are STORED generated: the DB is the only rounding authority; instructor + platform = final exactly; both >= 0 because bps <= 10000.';
COMMENT ON COLUMN commerce.order_lines.final_amount IS 'Generated (list - discount). FK target of refunds.amount (full-line refunds only). Never written by the app.';

-- =====================================================================
-- 7. commerce.provider_events (webhook claim + dedupe, D10). No payload (PII).
-- =====================================================================
CREATE TABLE commerce.provider_events (
  provider            text        NOT NULL,
  event_id            text        NOT NULL,     -- evt_... or synthetic 'reconcile:{sessionId}:{COMPLETED|EXPIRED}'
  type                text        NOT NULL,
  livemode            boolean     NOT NULL,
  object_id           text        NULL,         -- session / refund / dispute id
  order_id            uuid        NULL,
  provider_created_at timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz NULL,
  outcome             text        NULL,
  payload_sha256      bytea       NOT NULL,
  CONSTRAINT provider_events_pk                  PRIMARY KEY (provider, event_id),   -- claim: INSERT ... ON CONFLICT DO NOTHING
  CONSTRAINT provider_events_order_id_fk         FOREIGN KEY (order_id) REFERENCES commerce.orders (id) ON DELETE RESTRICT,
  CONSTRAINT provider_events_provider_ck         CHECK (provider IN ('STRIPE')),
  CONSTRAINT provider_events_event_id_ck         CHECK (char_length(event_id) BETWEEN 1 AND 255 AND event_id ~ '^[A-Za-z0-9_:.-]+$'),
  CONSTRAINT provider_events_type_ck             CHECK (char_length(type) BETWEEN 1 AND 100 AND type ~ '^[a-z0-9_.]+$'),
  CONSTRAINT provider_events_object_id_ck        CHECK (object_id IS NULL OR char_length(object_id) BETWEEN 1 AND 255),
  CONSTRAINT provider_events_outcome_ck          CHECK (outcome IS NULL OR outcome IN ('APPLIED','DUPLICATE_EFFECT','IGNORED','ORPHAN','MISMATCH')),
  CONSTRAINT provider_events_processed_ck        CHECK ((processed_at IS NULL) = (outcome IS NULL)
                                                        AND (processed_at IS NULL OR processed_at >= received_at)),
  CONSTRAINT provider_events_payload_sha256_ck   CHECK (octet_length(payload_sha256) = 32)
);
-- Admin order detail: provider events of an order
CREATE INDEX provider_events_order_id_idx ON commerce.provider_events (order_id) WHERE order_id IS NOT NULL;

CREATE FUNCTION commerce.provider_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL
     AND (NEW.provider, NEW.event_id, NEW.type, NEW.livemode, NEW.object_id, NEW.provider_created_at,
          NEW.received_at, NEW.payload_sha256)
         IS NOT DISTINCT FROM
         (OLD.provider, OLD.event_id, OLD.type, OLD.livemode, OLD.object_id, OLD.provider_created_at,
          OLD.received_at, OLD.payload_sha256)
     AND (OLD.order_id IS NULL OR NEW.order_id IS NOT DISTINCT FROM OLD.order_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on commerce.provider_events is forbidden: only the single outcome update is allowed', TG_OP
    USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER provider_events_guard_trg BEFORE UPDATE OR DELETE ON commerce.provider_events
  FOR EACH ROW EXECUTE FUNCTION commerce.provider_events_guard();
CREATE TRIGGER provider_events_no_truncate_trg BEFORE TRUNCATE ON commerce.provider_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.provider_events IS
  'Webhook inbox. Claim (INSERT ON CONFLICT DO NOTHING), apply, outbox and outcome happen in ONE transaction; a concurrent duplicate blocks on the PK and then sees the conflict. One finish update (processed_at, outcome, order_id NULL->value), as in media.transcode_attempts. No payload stored (PII). Reconciler events use synthetic ids.';

-- =====================================================================
-- 8. commerce.order_transitions (append-only, linear chain per order via seq)
-- =====================================================================
CREATE TABLE commerce.order_transitions (
  order_id          uuid        NOT NULL,
  seq               integer     NOT NULL,
  prev_seq          integer     NULL GENERATED ALWAYS AS (NULLIF(seq - 1, 0)) STORED,   -- chain FK helper
  from_status       text        NULL,
  to_status         text        NOT NULL,
  cause             text        NOT NULL,
  provider          text        NULL,
  provider_event_id text        NULL,
  actor_id          uuid        NULL,
  reason            text        NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_transitions_pk                           PRIMARY KEY (order_id, seq),            -- linear: one transition per seq; head = max(seq)
  CONSTRAINT order_transitions_order_id_seq_to_status_uq    UNIQUE (order_id, seq, to_status),      -- chain FK target
  CONSTRAINT order_transitions_order_id_prev_seq_from_status_fk
                                                            FOREIGN KEY (order_id, prev_seq, from_status)
                                                            REFERENCES commerce.order_transitions (order_id, seq, to_status) ON DELETE RESTRICT,
  CONSTRAINT order_transitions_order_id_fk                  FOREIGN KEY (order_id) REFERENCES commerce.orders (id) ON DELETE RESTRICT,
  CONSTRAINT order_transitions_provider_provider_event_id_fk FOREIGN KEY (provider, provider_event_id)
                                                            REFERENCES commerce.provider_events (provider, event_id) ON DELETE RESTRICT,
  CONSTRAINT order_transitions_actor_id_fk                  FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT order_transitions_seq_ck                       CHECK (seq >= 1),
  CONSTRAINT order_transitions_root_ck                      CHECK ((seq = 1) = (from_status IS NULL)),   -- otherwise MATCH SIMPLE would skip the chain FK
  CONSTRAINT order_transitions_from_status_ck               CHECK (from_status IS NULL OR from_status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW','EXPIRED','CANCELED','PARTIALLY_REFUNDED','REFUNDED')),
  CONSTRAINT order_transitions_to_status_ck                 CHECK (to_status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW','EXPIRED','CANCELED','PARTIALLY_REFUNDED','REFUNDED')),
  CONSTRAINT order_transitions_cause_ck                     CHECK (cause IN ('CHECKOUT','ZERO_TOTAL','PROVIDER_EVENT','USER_CANCEL','RECONCILER','REFUND','ADMIN')),
  CONSTRAINT order_transitions_edge_ck                      CHECK (
       (from_status IS NULL               AND to_status = 'PENDING_PAYMENT' AND cause = 'CHECKOUT')
    OR (from_status IS NULL               AND to_status = 'PAID'            AND cause = 'ZERO_TOTAL')
    OR (from_status = 'PENDING_PAYMENT'   AND to_status IN ('PAID','PAYMENT_REVIEW','EXPIRED') AND cause IN ('PROVIDER_EVENT','RECONCILER'))
    OR (from_status = 'PENDING_PAYMENT'   AND to_status = 'CANCELED'        AND cause IN ('USER_CANCEL','RECONCILER'))
    OR (from_status IN ('EXPIRED','CANCELED') AND to_status IN ('PAID','PAYMENT_REVIEW') AND cause IN ('PROVIDER_EVENT','RECONCILER'))
    OR (from_status = 'PAYMENT_REVIEW'    AND to_status = 'PAID'            AND cause = 'ADMIN')
    OR (from_status = 'PAYMENT_REVIEW'    AND to_status = 'REFUNDED'        AND cause = 'REFUND')
    OR (from_status = 'PAID'              AND to_status IN ('PARTIALLY_REFUNDED','REFUNDED') AND cause = 'REFUND')
    OR (from_status = 'PARTIALLY_REFUNDED' AND to_status = 'REFUNDED'       AND cause = 'REFUND')),
  CONSTRAINT order_transitions_event_ck                     CHECK ((provider IS NULL) = (provider_event_id IS NULL)
                                                                   AND (cause <> 'PROVIDER_EVENT' OR provider_event_id IS NOT NULL)
                                                                   AND (cause NOT IN ('CHECKOUT','ZERO_TOTAL','USER_CANCEL','ADMIN') OR provider_event_id IS NULL)),
  CONSTRAINT order_transitions_actor_ck                     CHECK ((cause IN ('CHECKOUT','ZERO_TOTAL','USER_CANCEL','ADMIN')) = (actor_id IS NOT NULL)),
  CONSTRAINT order_transitions_reason_ck                    CHECK ((reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000)
                                                                   AND (cause <> 'ADMIN' OR (reason IS NOT NULL AND char_length(reason) >= 10)))
);
CREATE TRIGGER order_transitions_append_only_trg BEFORE UPDATE OR DELETE ON commerce.order_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER order_transitions_no_truncate_trg BEFORE TRUNCATE ON commerce.order_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.order_transitions IS
  'Append-only order log. seq is contiguous per order (chain FK: from_status = predecessor.to_status), read as max(seq)+1 under the order row lock. Kept forever.';

-- =====================================================================
-- 9. commerce.payments (one Checkout Session per order, D6)
-- =====================================================================
CREATE TABLE commerce.payments (
  order_id            uuid          NOT NULL,
  provider            text          NOT NULL DEFAULT 'STRIPE',
  status              text          NOT NULL DEFAULT 'CREATING',
  amount              numeric(12,2) NOT NULL,
  currency            char(3)       NOT NULL,
  session_expires_at  timestamptz   NOT NULL,   -- decided in tx A and sent verbatim (idempotent replay needs identical params)
  checkout_session_id text          NULL,
  checkout_url        text          NULL,       -- bearer capability: only while OPEN, never logged
  payment_intent_id   text          NULL,
  received_amount     numeric(12,2) NULL,       -- amount_total reported by the provider at completion
  received_currency   char(3)       NULL,
  succeeded_at        timestamptz   NULL,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT payments_pk                           PRIMARY KEY (order_id),
  -- the payment amount can never differ from the order total
  CONSTRAINT payments_order_id_amount_currency_fk  FOREIGN KEY (order_id, amount, currency)
                                                   REFERENCES commerce.orders (id, total_amount, currency) ON DELETE RESTRICT,
  CONSTRAINT payments_checkout_session_id_uq       UNIQUE (checkout_session_id),   -- webhook mapping fallback
  CONSTRAINT payments_payment_intent_id_uq         UNIQUE (payment_intent_id),     -- dispute / refund lookups
  CONSTRAINT payments_provider_ck                  CHECK (provider IN ('STRIPE')),
  CONSTRAINT payments_status_ck                    CHECK (status IN ('CREATING','OPEN','SUCCEEDED','EXPIRED','ABANDONED')),
  CONSTRAINT payments_amount_ck                    CHECK (amount > 0),
  CONSTRAINT payments_currency_ck                  CHECK (currency ~ '^[A-Z]{3}$' AND (received_currency IS NULL OR received_currency ~ '^[A-Z]{3}$')),
  CONSTRAINT payments_ids_ck                       CHECK ((checkout_session_id IS NULL OR char_length(checkout_session_id) BETWEEN 1 AND 255)
                                                          AND (payment_intent_id IS NULL OR char_length(payment_intent_id) BETWEEN 1 AND 255)),
  CONSTRAINT payments_session_ck                   CHECK ((status = 'CREATING' AND checkout_session_id IS NULL)
                                                          OR (status IN ('OPEN','SUCCEEDED','EXPIRED') AND checkout_session_id IS NOT NULL)
                                                          OR status = 'ABANDONED'),
  CONSTRAINT payments_checkout_url_ck              CHECK ((status = 'OPEN') = (checkout_url IS NOT NULL)
                                                          AND (checkout_url IS NULL OR (char_length(checkout_url) <= 2048 AND checkout_url ~ '^https?://'))),
  CONSTRAINT payments_succeeded_ck                 CHECK ((status = 'SUCCEEDED') = (succeeded_at IS NOT NULL)
                                                          AND (status = 'SUCCEEDED') = (payment_intent_id IS NOT NULL)
                                                          AND (status = 'SUCCEEDED') = (received_amount IS NOT NULL)
                                                          AND (received_amount IS NULL) = (received_currency IS NULL)
                                                          AND (received_amount IS NULL OR received_amount >= 0)),
  CONSTRAINT payments_times_ck                     CHECK (session_expires_at > created_at AND (succeeded_at IS NULL OR succeeded_at >= created_at))
);
-- Reconcile (a): CREATING older than 15 min
CREATE INDEX payments_created_at_creating_idx ON commerce.payments (created_at) WHERE status = 'CREATING';
-- Reconcile (b): OPEN sessions expired more than 10 min ago
CREATE INDEX payments_session_expires_at_open_idx ON commerce.payments (session_expires_at) WHERE status = 'OPEN';

CREATE TRIGGER payments_set_updated_at_trg BEFORE UPDATE ON commerce.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER payments_status_insert_trg BEFORE INSERT ON commerce.payments
  FOR EACH ROW WHEN (NEW.status <> 'CREATING')
  EXECUTE FUNCTION public.forbid_row_change('payments_transition_ck', 'a payment must be created CREATING');
CREATE TRIGGER payments_transition_trg BEFORE UPDATE ON commerce.payments
  FOR EACH ROW WHEN (
       (OLD.order_id, OLD.provider, OLD.amount, OLD.currency, OLD.session_expires_at, OLD.created_at)
       IS DISTINCT FROM (NEW.order_id, NEW.provider, NEW.amount, NEW.currency, NEW.session_expires_at, NEW.created_at)
    OR (OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
    OR (OLD.status = 'SUCCEEDED' AND (OLD.payment_intent_id, OLD.received_amount, OLD.received_currency, OLD.succeeded_at)
                                     IS DISTINCT FROM (NEW.payment_intent_id, NEW.received_amount, NEW.received_currency, NEW.succeeded_at))
    OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'CREATING' AND NEW.status IN ('OPEN','ABANDONED','SUCCEEDED'))
       OR (OLD.status = 'OPEN'     AND NEW.status IN ('SUCCEEDED','EXPIRED'))
       OR (OLD.status IN ('EXPIRED','ABANDONED') AND NEW.status = 'SUCCEEDED'))))
  EXECUTE FUNCTION public.forbid_row_change('payments_transition_ck', 'illegal payment transition or immutable payment column changed');
COMMENT ON TABLE commerce.payments IS
  'Checkout Session of an order with total > 0 (1:1, PK = order_id). Amount/currency pinned to the order by composite FK. received_* = what the provider says was charged; PAID requires received = total unless the order went through PAYMENT_REVIEW (payments_received_ck). History lives in order_transitions + provider_events.';

-- =====================================================================
-- 10. commerce.refunds + refund_transitions (D11)
-- =====================================================================
CREATE TABLE commerce.refunds (
  id                  uuid          NOT NULL DEFAULT uuidv7(),
  order_id            uuid          NOT NULL,
  order_line_id       uuid          NOT NULL,
  user_id             uuid          NOT NULL,       -- = orders.user_id (pinned); abuse-rule index
  amount              numeric(12,2) NOT NULL,       -- = order_lines.final_amount (pinned): full-line only
  status              text          NOT NULL,
  initiated_by        text          NOT NULL,
  reason_code         text          NOT NULL,
  comment             text          NULL,
  attempt             smallint      NOT NULL DEFAULT 1,
  provider_refund_id  text          NULL,           -- current attempt's provider refund; earlier ones are in refund_transitions
  dispatch_started_at timestamptz   NULL,           -- dispatcher lease (APPROVED only)
  failure_code        text          NULL,
  approved_at         timestamptz   NULL,           -- = latest transition into APPROVED
  succeeded_at        timestamptz   NULL,           -- = transition into SUCCEEDED
  created_at          timestamptz   NOT NULL DEFAULT now(),   -- = seq 1 transition
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT refunds_pk                               PRIMARY KEY (id),
  CONSTRAINT refunds_order_id_order_line_id_amount_fk FOREIGN KEY (order_id, order_line_id, amount)
                                                      REFERENCES commerce.order_lines (order_id, id, final_amount) ON DELETE RESTRICT,
  CONSTRAINT refunds_order_id_user_id_fk              FOREIGN KEY (order_id, user_id) REFERENCES commerce.orders (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT refunds_provider_refund_id_uq            UNIQUE (provider_refund_id),       -- webhook matching
  CONSTRAINT refunds_status_ck                        CHECK (status IN ('REQUESTED','APPROVED','SUBMITTED','SUCCEEDED','FAILED','REJECTED')),
  CONSTRAINT refunds_initiated_by_ck                  CHECK (initiated_by IN ('STUDENT','ADMIN','SYSTEM')),
  CONSTRAINT refunds_reason_code_ck                   CHECK (
       (initiated_by = 'STUDENT' AND reason_code IN ('NOT_AS_EXPECTED','QUALITY','ACCIDENTAL_PURCHASE','OTHER'))
    OR (initiated_by = 'ADMIN'   AND reason_code IN ('ADMIN_DISCRETION','PAYMENT_REVIEW','DUPLICATE_PURCHASE','OTHER'))
    OR (initiated_by = 'SYSTEM'  AND reason_code = 'DUPLICATE_PURCHASE')),
  CONSTRAINT refunds_comment_ck                       CHECK (comment IS NULL OR (initiated_by = 'STUDENT' AND char_length(comment) BETWEEN 1 AND 1000
                                                             AND translate(comment, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')),
  CONSTRAINT refunds_amount_ck                        CHECK (amount > 0),
  CONSTRAINT refunds_attempt_ck                       CHECK (attempt BETWEEN 1 AND 20),
  CONSTRAINT refunds_requested_ck                     CHECK (status NOT IN ('REQUESTED','REJECTED') OR initiated_by = 'STUDENT'),
  CONSTRAINT refunds_approved_at_ck                   CHECK ((approved_at IS NULL) = (status IN ('REQUESTED','REJECTED'))),
  CONSTRAINT refunds_succeeded_at_ck                  CHECK ((status = 'SUCCEEDED') = (succeeded_at IS NOT NULL)),
  CONSTRAINT refunds_provider_refund_id_ck            CHECK ((status NOT IN ('REQUESTED','APPROVED','REJECTED') OR provider_refund_id IS NULL)
                                                             AND (status NOT IN ('SUBMITTED','SUCCEEDED') OR provider_refund_id IS NOT NULL)
                                                             AND (provider_refund_id IS NULL OR char_length(provider_refund_id) BETWEEN 1 AND 255)),
  CONSTRAINT refunds_failure_code_ck                  CHECK ((status = 'FAILED') = (failure_code IS NOT NULL)
                                                             AND (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$')),
  CONSTRAINT refunds_dispatch_started_at_ck           CHECK (dispatch_started_at IS NULL OR status = 'APPROVED')
);
-- One live refund per line (23505 -> refund_already_requested). Covers "one SUCCEEDED per line" (SUCCEEDED is terminal and live).
CREATE UNIQUE INDEX refunds_order_line_id_live_uq ON commerce.refunds (order_line_id) WHERE status NOT IN ('REJECTED','FAILED');
-- Dispatcher lease: WHERE status='APPROVED' ORDER BY approved_at, id FOR UPDATE SKIP LOCKED
CREATE INDEX refunds_approved_at_id_dispatch_idx ON commerce.refunds (approved_at, id) WHERE status = 'APPROVED';
-- Admin queues (REQUESTED / FAILED) keyset on (created_at, id)
CREATE INDEX refunds_status_created_at_id_idx ON commerce.refunds (status, created_at, id);
-- D11 abuse rule: refunds by user in the last 90 days
CREATE INDEX refunds_user_id_created_at_idx ON commerce.refunds (user_id, created_at);
-- Order detail (refunds of an order) + the order FKs
CREATE INDEX refunds_order_id_idx ON commerce.refunds (order_id);

CREATE TRIGGER refunds_set_updated_at_trg BEFORE UPDATE ON commerce.refunds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER refunds_immutable_trg BEFORE UPDATE ON commerce.refunds
  FOR EACH ROW WHEN (
       (OLD.id, OLD.order_id, OLD.order_line_id, OLD.user_id, OLD.amount, OLD.initiated_by, OLD.reason_code, OLD.comment, OLD.created_at)
       IS DISTINCT FROM
       (NEW.id, NEW.order_id, NEW.order_line_id, NEW.user_id, NEW.amount, NEW.initiated_by, NEW.reason_code, NEW.comment, NEW.created_at)
    OR (OLD.succeeded_at IS NOT NULL AND NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at)
    OR ((NEW.attempt IS DISTINCT FROM OLD.attempt OR (OLD.status = 'FAILED' AND NEW.status = 'APPROVED'))
        AND NOT (OLD.status = 'FAILED' AND NEW.status = 'APPROVED' AND NEW.attempt = OLD.attempt + 1)))
  EXECUTE FUNCTION public.forbid_row_change('refunds_immutable_ck', 'refund identity is immutable; attempt only increments on FAILED -> APPROVED');

CREATE FUNCTION commerce.refunds_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_status text;
BEGIN
  IF NEW.status NOT IN ('REQUESTED','APPROVED') OR NEW.attempt <> 1 OR NEW.provider_refund_id IS NOT NULL
     OR NEW.dispatch_started_at IS NOT NULL OR NEW.succeeded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a refund must be created REQUESTED or APPROVED, attempt 1, undispatched'
      USING ERRCODE = '23514', CONSTRAINT = 'refunds_transition_ck';
  END IF;
  -- FOR SHARE conflicts with a concurrent status UPDATE; a no-op when the caller already holds FOR UPDATE (lock order).
  SELECT status INTO v_order_status FROM commerce.orders WHERE id = NEW.order_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;   -- FK reports it
  END IF;
  IF NOT (v_order_status IN ('PAID','PARTIALLY_REFUNDED')
          OR (v_order_status = 'PAYMENT_REVIEW' AND NEW.initiated_by = 'ADMIN')) THEN
    RAISE EXCEPTION 'order % (%) is not refundable', NEW.order_id, v_order_status
      USING ERRCODE = '23514', CONSTRAINT = 'refunds_order_status_ck';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refunds_insert_trg BEFORE INSERT ON commerce.refunds
  FOR EACH ROW EXECUTE FUNCTION commerce.refunds_insert_guard();
CREATE TRIGGER refunds_no_truncate_trg BEFORE TRUNCATE ON commerce.refunds
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.refunds IS
  'Per-line full refunds. status/approved_at/succeeded_at/attempt/created_at materialise refund_transitions (refunds_status_log_ck, COMMIT). One live refund per line. Provider calls are made only by the API dispatcher (D9), idempotency key refund:{id}:{attempt}.';

CREATE TABLE commerce.refund_transitions (
  refund_id          uuid        NOT NULL,
  seq                integer     NOT NULL,
  prev_seq           integer     NULL GENERATED ALWAYS AS (NULLIF(seq - 1, 0)) STORED,
  from_status        text        NULL,
  to_status          text        NOT NULL,
  actor_id           uuid        NULL,           -- NULL = system (dispatcher / webhook / duplicate detector)
  reason             text        NULL,
  provider_refund_id text        NULL,           -- per-attempt evidence
  failure_code       text        NULL,
  provider           text        NULL,
  provider_event_id  text        NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_transitions_pk                         PRIMARY KEY (refund_id, seq),
  CONSTRAINT refund_transitions_refund_id_seq_to_status_uq UNIQUE (refund_id, seq, to_status),
  CONSTRAINT refund_transitions_refund_id_prev_seq_from_status_fk
                                                           FOREIGN KEY (refund_id, prev_seq, from_status)
                                                           REFERENCES commerce.refund_transitions (refund_id, seq, to_status) ON DELETE RESTRICT,
  CONSTRAINT refund_transitions_refund_id_fk               FOREIGN KEY (refund_id) REFERENCES commerce.refunds (id) ON DELETE RESTRICT,
  CONSTRAINT refund_transitions_actor_id_fk                FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT refund_transitions_provider_provider_event_id_fk FOREIGN KEY (provider, provider_event_id)
                                                           REFERENCES commerce.provider_events (provider, event_id) ON DELETE RESTRICT,
  CONSTRAINT refund_transitions_seq_ck                     CHECK (seq >= 1),
  CONSTRAINT refund_transitions_root_ck                    CHECK ((seq = 1) = (from_status IS NULL)),
  CONSTRAINT refund_transitions_status_ck                  CHECK (to_status IN ('REQUESTED','APPROVED','SUBMITTED','SUCCEEDED','FAILED','REJECTED')
                                                                  AND (from_status IS NULL OR from_status IN ('REQUESTED','APPROVED','SUBMITTED','SUCCEEDED','FAILED','REJECTED'))),
  CONSTRAINT refund_transitions_edge_ck                    CHECK (
       (from_status IS NULL        AND to_status IN ('REQUESTED','APPROVED'))
    OR (from_status = 'REQUESTED'  AND to_status IN ('APPROVED','REJECTED'))
    OR (from_status = 'APPROVED'   AND to_status IN ('SUBMITTED','SUCCEEDED','FAILED'))
    OR (from_status = 'SUBMITTED'  AND to_status IN ('SUCCEEDED','FAILED'))
    OR (from_status = 'FAILED'     AND to_status = 'APPROVED')),
  CONSTRAINT refund_transitions_admin_actor_ck             CHECK (from_status NOT IN ('REQUESTED','FAILED') OR actor_id IS NOT NULL),  -- review / retry are admin actions
  CONSTRAINT refund_transitions_reason_ck                  CHECK ((reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000)
                                                                  AND (to_status <> 'REJECTED' OR (reason IS NOT NULL AND char_length(reason) >= 10))),
  CONSTRAINT refund_transitions_provider_ck                CHECK ((to_status <> 'SUBMITTED' OR provider_refund_id IS NOT NULL)
                                                                  AND (to_status = 'FAILED') = (failure_code IS NOT NULL)
                                                                  AND (provider IS NULL) = (provider_event_id IS NULL))
);
CREATE TRIGGER refund_transitions_append_only_trg BEFORE UPDATE OR DELETE ON commerce.refund_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER refund_transitions_no_truncate_trg BEFORE TRUNCATE ON commerce.refund_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE commerce.refund_transitions IS 'Append-only refund log (who/when/why, per-attempt provider ids). Linear chain via seq, as order_transitions.';

-- =====================================================================
-- 11. Commerce deferred consistency triggers (checked at COMMIT)
-- =====================================================================
-- 11a. total = sum of line finals, >= 1 line
CREATE FUNCTION commerce.orders_total_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid;
  v_total numeric;
  v_n     integer;
  v_sum   numeric;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN v_id := NEW.id; ELSE v_id := NEW.order_id; END IF;
  SELECT total_amount INTO v_total FROM commerce.orders WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(final_amount), 0) INTO v_n, v_sum FROM commerce.order_lines WHERE order_id = v_id;
  IF v_n = 0 OR v_sum <> v_total THEN
    RAISE EXCEPTION 'order % total % does not equal the sum % of its % lines', v_id, v_total, v_sum, v_n
      USING ERRCODE = '23514', CONSTRAINT = 'orders_total_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_total_trg AFTER INSERT ON commerce.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_total_guard();
CREATE CONSTRAINT TRIGGER order_lines_total_trg AFTER INSERT ON commerce.order_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_total_guard();

-- 11b. status/placed_at/paid_at/closed_at == log; status agrees with SUCCEEDED refunds; transition actors
CREATE FUNCTION commerce.orders_status_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id        uuid;
  v_user      uuid;
  v_status    text;
  v_total     numeric;
  v_placed    timestamptz;
  v_paid      timestamptz;
  v_closed    timestamptz;
  v_head      text;
  v_log_place timestamptz;
  v_log_paid  timestamptz;
  v_log_close timestamptz;
  v_refunded  numeric;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN v_id := NEW.id; ELSE v_id := NEW.order_id; END IF;   -- order_transitions, refunds
  SELECT user_id, status, total_amount, placed_at, paid_at, closed_at
    INTO v_user, v_status, v_total, v_placed, v_paid, v_closed
    FROM commerce.orders WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT to_status INTO v_head FROM commerce.order_transitions WHERE order_id = v_id ORDER BY seq DESC LIMIT 1;
  SELECT min(occurred_at) FILTER (WHERE seq = 1),
         min(occurred_at) FILTER (WHERE to_status = 'PAID'),               -- structurally at most one
         min(occurred_at) FILTER (WHERE to_status IN ('EXPIRED','CANCELED'))
    INTO v_log_place, v_log_paid, v_log_close
    FROM commerce.order_transitions WHERE order_id = v_id;
  IF v_head IS DISTINCT FROM v_status OR v_log_place IS DISTINCT FROM v_placed
     OR v_log_paid IS DISTINCT FROM v_paid OR v_log_close IS DISTINCT FROM v_closed THEN
    RAISE EXCEPTION 'order % lifecycle columns do not match its transition log', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'orders_status_log_ck';
  END IF;
  IF EXISTS (SELECT 1 FROM commerce.order_transitions t
              WHERE t.order_id = v_id AND t.cause IN ('CHECKOUT','ZERO_TOTAL','USER_CANCEL')
                AND t.actor_id IS DISTINCT FROM v_user) THEN
    RAISE EXCEPTION 'order % buyer transitions must be made by the buyer', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'order_transitions_buyer_actor_ck';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_refunded FROM commerce.refunds WHERE order_id = v_id AND status = 'SUCCEEDED';
  IF (v_status IN ('PENDING_PAYMENT','EXPIRED','CANCELED','PAID') AND v_refunded <> 0)
     OR (v_status = 'PAYMENT_REVIEW'     AND v_refunded >= v_total)
     OR (v_status = 'PARTIALLY_REFUNDED' AND NOT (v_refunded > 0 AND v_refunded < v_total))
     OR (v_status = 'REFUNDED'           AND v_refunded <> v_total) THEN
    RAISE EXCEPTION 'order % status % does not match refunded amount %', v_id, v_status, v_refunded
      USING ERRCODE = '23514', CONSTRAINT = 'orders_refund_status_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_status_log_trg
  AFTER INSERT OR UPDATE OF status, placed_at, paid_at, closed_at ON commerce.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard();
CREATE CONSTRAINT TRIGGER order_transitions_status_log_trg AFTER INSERT ON commerce.order_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard();
CREATE CONSTRAINT TRIGGER refunds_order_status_log_trg AFTER INSERT OR UPDATE OF status ON commerce.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard();

-- 11c. payment <-> order status; PAID only on matching received amount (unless reviewed)
CREATE FUNCTION commerce.payments_order_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id       uuid;
  v_status   text;
  v_total    numeric;
  v_currency text;
  v_pstatus  text;
  v_recv     numeric;
  v_recv_cur text;
  v_found    boolean;
  v_reviewed boolean;
  v_match    boolean;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN v_id := NEW.id; ELSE v_id := NEW.order_id; END IF;
  SELECT status, total_amount, currency INTO v_status, v_total, v_currency FROM commerce.orders WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT status, received_amount, received_currency INTO v_pstatus, v_recv, v_recv_cur
    FROM commerce.payments WHERE order_id = v_id;
  v_found := FOUND;
  IF (v_total = 0) = v_found
     OR (v_found AND NOT (
          (v_status = 'PENDING_PAYMENT' AND v_pstatus IN ('CREATING','OPEN'))
       OR (v_status IN ('PAID','PAYMENT_REVIEW','PARTIALLY_REFUNDED','REFUNDED') AND v_pstatus = 'SUCCEEDED')
       OR (v_status = 'EXPIRED'  AND v_pstatus = 'EXPIRED')
       OR (v_status = 'CANCELED' AND v_pstatus IN ('EXPIRED','ABANDONED')))) THEN
    RAISE EXCEPTION 'order % (%) and its payment (%) disagree', v_id, v_status, v_pstatus
      USING ERRCODE = '23514', CONSTRAINT = 'payments_order_status_ck';
  END IF;
  IF v_found AND v_pstatus = 'SUCCEEDED' THEN
    v_match := (v_recv = v_total AND v_recv_cur = v_currency);
    SELECT EXISTS (SELECT 1 FROM commerce.order_transitions WHERE order_id = v_id AND to_status = 'PAYMENT_REVIEW')
      INTO v_reviewed;
    IF (v_status = 'PAYMENT_REVIEW' AND v_match) OR (NOT v_reviewed AND NOT v_match) THEN
      RAISE EXCEPTION 'order % received % % but expected % %', v_id, v_recv, v_recv_cur, v_total, v_currency
        USING ERRCODE = '23514', CONSTRAINT = 'payments_received_ck';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_payment_trg AFTER INSERT OR UPDATE OF status ON commerce.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.payments_order_guard();
CREATE CONSTRAINT TRIGGER payments_order_trg AFTER INSERT OR UPDATE OF status, received_amount, received_currency ON commerce.payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.payments_order_guard();

-- 11d. redemption status <-> order status; every redemption is used by >= 1 line
CREATE FUNCTION commerce.coupon_redemptions_order_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid;
  v_status text;
  v_paid   timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN v_id := NEW.id; ELSE v_id := NEW.order_id; END IF;
  SELECT status, paid_at INTO v_status, v_paid FROM commerce.orders WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM commerce.coupon_redemptions r WHERE r.order_id = v_id AND NOT (
          (v_status = 'PENDING_PAYMENT' AND r.status = 'RESERVED')
       OR (v_status = 'PAYMENT_REVIEW'  AND r.status IN ('RESERVED','RELEASED'))
       OR (v_status IN ('PAID','PARTIALLY_REFUNDED') AND r.status = 'CONSUMED')
       OR (v_status = 'REFUNDED' AND r.status = CASE WHEN v_paid IS NULL THEN 'RELEASED' ELSE 'CONSUMED' END)
       OR (v_status IN ('EXPIRED','CANCELED') AND r.status = 'RELEASED'))) THEN
    RAISE EXCEPTION 'order % (%) has a coupon redemption in the wrong state', v_id, v_status
      USING ERRCODE = '23514', CONSTRAINT = 'coupon_redemptions_order_status_ck';
  END IF;
  IF EXISTS (SELECT 1 FROM commerce.coupon_redemptions r
              WHERE r.order_id = v_id
                AND NOT EXISTS (SELECT 1 FROM commerce.order_lines l WHERE l.order_id = r.order_id AND l.coupon_id = r.coupon_id)) THEN
    RAISE EXCEPTION 'order % has a coupon redemption not used by any line', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'coupon_redemptions_unused_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_redemptions_trg AFTER UPDATE OF status ON commerce.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_order_guard();
CREATE CONSTRAINT TRIGGER coupon_redemptions_order_trg AFTER INSERT OR UPDATE OF status ON commerce.coupon_redemptions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_order_guard();

-- 11e. refund columns == refund log; root actor matches initiated_by
CREATE FUNCTION commerce.refunds_status_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id          uuid;
  v_status      text;
  v_approved    timestamptz;
  v_succeeded   timestamptz;
  v_attempt     smallint;
  v_created     timestamptz;
  v_init        text;
  v_user        uuid;
  v_head        text;
  v_l_approved  timestamptz;
  v_l_succeeded timestamptz;
  v_retries     integer;
  v_root_at     timestamptz;
  v_root_actor  uuid;
  v_root_reason text;
BEGIN
  IF TG_TABLE_NAME = 'refunds' THEN v_id := NEW.id; ELSE v_id := NEW.refund_id; END IF;
  SELECT status, approved_at, succeeded_at, attempt, created_at, initiated_by, user_id
    INTO v_status, v_approved, v_succeeded, v_attempt, v_created, v_init, v_user
    FROM commerce.refunds WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT to_status INTO v_head FROM commerce.refund_transitions WHERE refund_id = v_id ORDER BY seq DESC LIMIT 1;
  SELECT max(occurred_at) FILTER (WHERE to_status = 'APPROVED'),
         max(occurred_at) FILTER (WHERE to_status = 'SUCCEEDED'),
         count(*)         FILTER (WHERE from_status = 'FAILED' AND to_status = 'APPROVED')
    INTO v_l_approved, v_l_succeeded, v_retries
    FROM commerce.refund_transitions WHERE refund_id = v_id;
  SELECT occurred_at, actor_id, reason INTO v_root_at, v_root_actor, v_root_reason
    FROM commerce.refund_transitions WHERE refund_id = v_id AND seq = 1;
  IF v_head IS DISTINCT FROM v_status OR v_l_approved IS DISTINCT FROM v_approved
     OR v_l_succeeded IS DISTINCT FROM v_succeeded OR v_attempt <> 1 + v_retries
     OR v_root_at IS DISTINCT FROM v_created THEN
    RAISE EXCEPTION 'refund % columns do not match its transition log', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'refunds_status_log_ck';
  END IF;
  IF (v_init = 'STUDENT' AND v_root_actor IS DISTINCT FROM v_user)
     OR (v_init = 'ADMIN'  AND (v_root_actor IS NULL OR v_root_reason IS NULL OR char_length(v_root_reason) < 10))
     OR (v_init = 'SYSTEM' AND v_root_actor IS NOT NULL) THEN
    RAISE EXCEPTION 'refund % initiator does not match its first transition', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_transitions_actor_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER refunds_status_log_trg
  AFTER INSERT OR UPDATE OF status, approved_at, succeeded_at, attempt ON commerce.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.refunds_status_log_guard();
CREATE CONSTRAINT TRIGGER refund_transitions_status_log_trg AFTER INSERT ON commerce.refund_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.refunds_status_log_guard();

-- =====================================================================
-- 12. enrollment.enrollments + enrollment_transitions (D8)
-- =====================================================================
CREATE TABLE enrollment.enrollments (
  id            uuid        NOT NULL DEFAULT uuidv7(),
  user_id       uuid        NOT NULL,
  course_id     uuid        NOT NULL,      -- soft ref (D12)
  status        text        NOT NULL DEFAULT 'ACTIVE',
  source        text        NOT NULL,      -- source of the current grant
  order_line_id uuid        NULL,          -- soft ref to commerce.order_lines (current grant)
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz NULL,
  revoke_reason text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_pk                   PRIMARY KEY (id),
  -- hasCourseAccess hot path, index-only: WHERE user_id=$1 AND course_id=$2 AND status='ACTIVE'; grant upsert arbiter
  CONSTRAINT enrollments_user_id_course_id_uq UNIQUE (user_id, course_id) INCLUDE (status),
  CONSTRAINT enrollments_user_id_fk           FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT enrollments_status_ck            CHECK (status IN ('ACTIVE','REVOKED')),
  CONSTRAINT enrollments_source_ck            CHECK (source IN ('ORDER','FREE','ADMIN')),
  CONSTRAINT enrollments_order_line_id_ck     CHECK ((source = 'ORDER') = (order_line_id IS NOT NULL)),
  CONSTRAINT enrollments_revoke_reason_ck     CHECK (revoke_reason IS NULL OR revoke_reason IN ('REFUND','ADMIN','CHARGEBACK')),
  CONSTRAINT enrollments_revoked_ck           CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)
                                                     AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT enrollments_times_ck             CHECK (granted_at >= created_at AND (revoked_at IS NULL OR revoked_at >= granted_at))
);
-- My learning keyset: WHERE user_id=$1 AND status='ACTIVE' AND (granted_at,id) < (...) ORDER BY granted_at DESC, id DESC
CREATE INDEX enrollments_user_id_granted_at_id_active_idx ON enrollment.enrollments (user_id, granted_at DESC, id DESC) WHERE status = 'ACTIVE';
-- Course enrolment counts (instructor, P5)
CREATE INDEX enrollments_course_id_active_idx ON enrollment.enrollments (course_id) WHERE status = 'ACTIVE';
CREATE TRIGGER enrollments_set_updated_at_trg BEFORE UPDATE ON enrollment.enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER enrollments_immutable_trg BEFORE UPDATE ON enrollment.enrollments
  FOR EACH ROW WHEN ((OLD.id, OLD.user_id, OLD.course_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.course_id, NEW.created_at))
  EXECUTE FUNCTION public.forbid_row_change('enrollments_immutable_ck', 'enrollments.user_id/course_id/created_at are immutable');
CREATE TRIGGER enrollments_no_truncate_trg BEFORE TRUNCATE ON enrollment.enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE enrollment.enrollments IS
  'One row per (user, course), ACTIVE/REVOKED. Survives course archive and instructor bans (D13). status/source/order_line_id/granted_at/revoked_at/revoke_reason/created_at materialise enrollment_transitions (enrollments_status_log_ck, COMMIT). Never deleted.';

CREATE TABLE enrollment.enrollment_transitions (
  enrollment_id uuid        NOT NULL,
  seq           integer     NOT NULL,
  prev_seq      integer     NULL GENERATED ALWAYS AS (NULLIF(seq - 1, 0)) STORED,
  action        text        NOT NULL,
  from_status   text        NULL,
  to_status     text        NOT NULL,
  source        text        NULL,
  order_line_id uuid        NULL,          -- soft
  revoke_reason text        NULL,
  refund_id     uuid        NULL,          -- soft
  reason        text        NULL,
  actor_id      uuid        NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_transitions_pk                    PRIMARY KEY (enrollment_id, seq),
  CONSTRAINT enrollment_transitions_enrollment_id_seq_to_status_uq UNIQUE (enrollment_id, seq, to_status),
  CONSTRAINT enrollment_transitions_enrollment_id_prev_seq_from_status_fk
                                                          FOREIGN KEY (enrollment_id, prev_seq, from_status)
                                                          REFERENCES enrollment.enrollment_transitions (enrollment_id, seq, to_status) ON DELETE RESTRICT,
  CONSTRAINT enrollment_transitions_enrollment_id_fk      FOREIGN KEY (enrollment_id) REFERENCES enrollment.enrollments (id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_transitions_actor_id_fk           FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_transitions_seq_ck                CHECK (seq >= 1),
  CONSTRAINT enrollment_transitions_root_ck               CHECK ((seq = 1) = (from_status IS NULL) AND (seq = 1) = (action = 'GRANT')),
  CONSTRAINT enrollment_transitions_edge_ck               CHECK (
       (action = 'GRANT'   AND from_status IS NULL      AND to_status = 'ACTIVE')
    OR (action = 'REVOKE'  AND from_status = 'ACTIVE'   AND to_status = 'REVOKED')
    OR (action = 'REGRANT' AND from_status = 'REVOKED'  AND to_status = 'ACTIVE')),
  CONSTRAINT enrollment_transitions_source_ck             CHECK ((action IN ('GRANT','REGRANT')) = (source IS NOT NULL)
                                                                 AND (source IS NULL OR source IN ('ORDER','FREE','ADMIN'))
                                                                 AND (source IS NOT DISTINCT FROM 'ORDER') = (order_line_id IS NOT NULL)),
  CONSTRAINT enrollment_transitions_revoke_ck             CHECK ((action = 'REVOKE') = (revoke_reason IS NOT NULL)
                                                                 AND (revoke_reason IS NULL OR revoke_reason IN ('REFUND','ADMIN','CHARGEBACK'))
                                                                 AND (revoke_reason IS NOT DISTINCT FROM 'REFUND') = (refund_id IS NOT NULL)),
  CONSTRAINT enrollment_transitions_reason_ck             CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT enrollment_transitions_admin_ck              CHECK (NOT (source IS NOT DISTINCT FROM 'ADMIN' OR coalesce(revoke_reason IN ('ADMIN','CHARGEBACK'), false))
                                                                 OR (actor_id IS NOT NULL AND reason IS NOT NULL AND char_length(reason) >= 10))
);
CREATE TRIGGER enrollment_transitions_append_only_trg BEFORE UPDATE OR DELETE ON enrollment.enrollment_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER enrollment_transitions_no_truncate_trg BEFORE TRUNCATE ON enrollment.enrollment_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE FUNCTION enrollment.enrollments_status_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id       uuid;
  v_status   text;
  v_source   text;
  v_line     uuid;
  v_granted  timestamptz;
  v_revoked  timestamptz;
  v_rreason  text;
  v_created  timestamptz;
  h_status   text;
  h_at       timestamptz;
  h_rreason  text;
  g_source   text;
  g_line     uuid;
  g_at       timestamptz;
  v_first    timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'enrollments' THEN v_id := NEW.id; ELSE v_id := NEW.enrollment_id; END IF;
  SELECT status, source, order_line_id, granted_at, revoked_at, revoke_reason, created_at
    INTO v_status, v_source, v_line, v_granted, v_revoked, v_rreason, v_created
    FROM enrollment.enrollments WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT to_status, occurred_at, revoke_reason INTO h_status, h_at, h_rreason
    FROM enrollment.enrollment_transitions WHERE enrollment_id = v_id ORDER BY seq DESC LIMIT 1;
  SELECT source, order_line_id, occurred_at INTO g_source, g_line, g_at
    FROM enrollment.enrollment_transitions WHERE enrollment_id = v_id AND action IN ('GRANT','REGRANT')
   ORDER BY seq DESC LIMIT 1;
  SELECT occurred_at INTO v_first FROM enrollment.enrollment_transitions WHERE enrollment_id = v_id AND seq = 1;
  IF h_status IS DISTINCT FROM v_status OR g_source IS DISTINCT FROM v_source OR g_line IS DISTINCT FROM v_line
     OR g_at IS DISTINCT FROM v_granted OR v_first IS DISTINCT FROM v_created
     OR (v_status = 'REVOKED' AND (h_at IS DISTINCT FROM v_revoked OR h_rreason IS DISTINCT FROM v_rreason)) THEN
    RAISE EXCEPTION 'enrollment % columns do not match its transition log', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'enrollments_status_log_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER enrollments_status_log_trg
  AFTER INSERT OR UPDATE OF status, source, order_line_id, granted_at, revoked_at, revoke_reason ON enrollment.enrollments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enrollment.enrollments_status_log_guard();
CREATE CONSTRAINT TRIGGER enrollment_transitions_status_log_trg AFTER INSERT ON enrollment.enrollment_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enrollment.enrollments_status_log_guard();
COMMENT ON TABLE enrollment.enrollment_transitions IS 'Append-only enrollment log (GRANT/REVOKE/REGRANT, with source, refund and admin reason). Linear chain via seq.';

-- =====================================================================
-- 13. payouts: double-entry ledger (written by the worker only, D13)
-- =====================================================================
CREATE TABLE payouts.accounts (
  id         uuid        NOT NULL DEFAULT uuidv7(),
  type       text        NOT NULL,
  owner_id   uuid        NULL,
  currency   char(3)     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_pk                       PRIMARY KEY (id),
  CONSTRAINT accounts_type_owner_id_currency_uq UNIQUE NULLS NOT DISTINCT (type, owner_id, currency),   -- lazy create: ON CONFLICT DO NOTHING
  CONSTRAINT accounts_id_currency_uq           UNIQUE (id, currency),                                   -- FK target: postings currency pin
  CONSTRAINT accounts_owner_id_fk              FOREIGN KEY (owner_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT accounts_type_ck                  CHECK (type IN ('PROVIDER_CLEARING','PLATFORM_REVENUE','INSTRUCTOR_PAYABLE')),
  CONSTRAINT accounts_owner_id_ck              CHECK ((type = 'INSTRUCTOR_PAYABLE') = (owner_id IS NOT NULL)),
  CONSTRAINT accounts_currency_ck              CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TRIGGER accounts_append_only_trg BEFORE UPDATE OR DELETE ON payouts.accounts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER accounts_no_truncate_trg BEFORE TRUNCATE ON payouts.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE TABLE payouts.journal_entries (
  id              uuid        NOT NULL DEFAULT uuidv7(),
  kind            text        NOT NULL,
  order_line_id   uuid        NOT NULL,     -- soft ref to commerce.order_lines
  refund_id       uuid        NULL,         -- soft ref to commerce.refunds
  source_event_id uuid        NOT NULL,     -- outbox event id (trace only: one OrderPaid creates one entry per line)
  currency        char(3)     NOT NULL,
  occurred_at     timestamptz NOT NULL,     -- business time: paidAt / succeededAt from the event
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_pk                            PRIMARY KEY (id),
  -- idempotency independent of the event id (redelivery / replay): ON CONFLICT DO NOTHING
  CONSTRAINT journal_entries_kind_order_line_id_refund_id_uq UNIQUE NULLS NOT DISTINCT (kind, order_line_id, refund_id),
  CONSTRAINT journal_entries_id_currency_uq                UNIQUE (id, currency),
  CONSTRAINT journal_entries_kind_ck                       CHECK (kind IN ('SALE','REFUND')),
  CONSTRAINT journal_entries_refund_id_ck                  CHECK ((kind = 'REFUND') = (refund_id IS NOT NULL)),
  CONSTRAINT journal_entries_currency_ck                   CHECK (currency ~ '^[A-Z]{3}$')
);
-- A line is reversed at most once (one SUCCEEDED refund per line), even if commerce ever misbehaved
CREATE UNIQUE INDEX journal_entries_order_line_id_refund_uq ON payouts.journal_entries (order_line_id) WHERE kind = 'REFUND';

CREATE FUNCTION payouts.journal_entries_sale_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'REFUND' AND NOT EXISTS (
       SELECT 1 FROM payouts.journal_entries e
        WHERE e.kind = 'SALE' AND e.order_line_id = NEW.order_line_id AND e.refund_id IS NULL) THEN
    RAISE EXCEPTION 'no SALE entry for order line % yet', NEW.order_line_id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_sale_missing_ck';   -- worker: retryable
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_sale_trg BEFORE INSERT ON payouts.journal_entries
  FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_sale_guard();
CREATE TRIGGER journal_entries_append_only_trg BEFORE UPDATE OR DELETE ON payouts.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER journal_entries_no_truncate_trg BEFORE TRUNCATE ON payouts.journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE TABLE payouts.postings (
  entry_id   uuid          NOT NULL,
  line_no    smallint      NOT NULL,
  account_id uuid          NOT NULL,
  currency   char(3)       NOT NULL,     -- FK-pinned to both the entry and the account currency
  amount     numeric(12,2) NOT NULL,     -- debit +, credit -
  CONSTRAINT postings_pk                     PRIMARY KEY (entry_id, line_no),
  CONSTRAINT postings_entry_id_account_id_uq UNIQUE (entry_id, account_id),   -- one leg per account per entry (mirror check)
  CONSTRAINT postings_entry_id_currency_fk   FOREIGN KEY (entry_id, currency) REFERENCES payouts.journal_entries (id, currency) ON DELETE RESTRICT,
  CONSTRAINT postings_account_id_currency_fk FOREIGN KEY (account_id, currency) REFERENCES payouts.accounts (id, currency) ON DELETE RESTRICT,
  CONSTRAINT postings_line_no_ck             CHECK (line_no BETWEEN 1 AND 10),
  CONSTRAINT postings_amount_ck              CHECK (amount <> 0)
);
-- account_balances view + account FK
CREATE INDEX postings_account_id_idx ON payouts.postings (account_id);
CREATE TRIGGER postings_append_only_trg BEFORE UPDATE OR DELETE ON payouts.postings
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER postings_no_truncate_trg BEFORE TRUNCATE ON payouts.postings
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE FUNCTION payouts.journal_entries_balance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id   uuid;
  v_kind text;
  v_line uuid;
  v_n    integer;
  v_sum  numeric;
  v_sale uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN v_id := NEW.id; ELSE v_id := NEW.entry_id; END IF;
  SELECT kind, order_line_id INTO v_kind, v_line FROM payouts.journal_entries WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(amount), 0) INTO v_n, v_sum FROM payouts.postings WHERE entry_id = v_id;
  IF v_n < 2 OR v_sum <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (% postings, sum %)', v_id, v_n, v_sum
      USING ERRCODE = '23514', CONSTRAINT = 'postings_balanced_ck';
  END IF;
  IF v_kind = 'REFUND' THEN
    SELECT id INTO v_sale FROM payouts.journal_entries WHERE kind = 'SALE' AND order_line_id = v_line AND refund_id IS NULL;
    IF v_sale IS NULL OR EXISTS (
         SELECT 1
           FROM (SELECT account_id, amount FROM payouts.postings WHERE entry_id = v_sale) s
           FULL JOIN (SELECT account_id, amount FROM payouts.postings WHERE entry_id = v_id) r USING (account_id)
          WHERE s.amount IS NULL OR r.amount IS NULL OR r.amount <> -s.amount) THEN
      RAISE EXCEPTION 'refund entry % is not the exact mirror of its SALE entry', v_id
        USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_mirror_ck';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_entries_balance_trg AFTER INSERT ON payouts.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_balance_guard();
CREATE CONSTRAINT TRIGGER postings_balance_trg AFTER INSERT ON payouts.postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_balance_guard();

CREATE VIEW payouts.account_balances WITH (security_invoker = true) AS
SELECT a.id AS account_id, a.type, a.owner_id, a.currency,
       coalesce(sum(p.amount), 0) AS balance,
       count(p.entry_id)          AS posting_count
  FROM payouts.accounts a
  LEFT JOIN payouts.postings p ON p.account_id = a.id
 GROUP BY a.id;

COMMENT ON TABLE payouts.journal_entries IS
  'Double-entry journal. SALE: Dr PROVIDER_CLEARING +final, Cr INSTRUCTOR_PAYABLE[instructor] -instructorShare, Cr PLATFORM_REVENUE -platformShare (zero legs omitted; 0.00 lines get no entry). REFUND: exact mirror of the line SALE (journal_entries_mirror_ck). Balanced at COMMIT (postings_balanced_ck). Append-only.';
COMMENT ON VIEW payouts.account_balances IS 'Sum of postings per account (debit +). INSTRUCTOR_PAYABLE balances are negative = owed to the instructor.';

-- =====================================================================
-- 14. Privileges (prod role split; no-op in dev where udemy_app doesn't exist)
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
    GRANT USAGE ON SCHEMA commerce, enrollment, payouts TO udemy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA commerce, enrollment, payouts TO udemy_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA commerce TO udemy_app;   -- orders.order_number identity (belt and braces)
    GRANT EXECUTE ON FUNCTION commerce.coupon_discount(numeric, text, smallint, numeric) TO udemy_app;
    -- append-only history / snapshots / ledger
    REVOKE UPDATE, DELETE, TRUNCATE ON commerce.course_price_changes, commerce.order_lines, commerce.order_transitions,
                                       commerce.refund_transitions, enrollment.enrollment_transitions,
                                       payouts.accounts, payouts.journal_entries, payouts.postings FROM udemy_app;
    -- never hard-deleted (state rows)
    REVOKE DELETE, TRUNCATE ON commerce.course_prices, commerce.coupons, commerce.coupon_redemptions, commerce.orders,
                               commerce.payments, commerce.refunds, commerce.provider_events, enrollment.enrollments FROM udemy_app;
    -- read-only view
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON payouts.account_balances FROM udemy_app;
    -- carts / cart_items keep full DML
  END IF;
END
$$;
```

**Down order** (for sql-ops; no CASCADE, the same style as 0001–0003):

1. `DROP VIEW payouts.account_balances`.
2. Drop `payouts.postings`, `payouts.journal_entries` and `payouts.accounts`. Then drop the functions `payouts.journal_entries_balance_guard()` and `payouts.journal_entries_sale_guard()`.
3. Drop `enrollment.enrollment_transitions` and `enrollment.enrollments`. Then drop `enrollment.enrollments_status_log_guard()`.
4. Drop these commerce tables, in this order: `refund_transitions`, `refunds`, `order_transitions`, `provider_events`, `payments`, `order_lines`, `coupon_redemptions`, `orders`, `coupons`, `cart_items`, `carts`, `course_price_changes`, `course_prices`.
5. Drop these commerce functions: `refunds_status_log_guard`, `coupon_redemptions_order_guard`, `payments_order_guard`, `orders_status_log_guard`, `orders_total_guard`, `refunds_insert_guard`, `provider_events_guard`, `order_lines_coupon_guard`, `coupon_redemptions_reserve_guard`, `course_prices_record_change` and `coupon_discount(numeric, text, smallint, numeric)`.

The schemas stay, because 0001 owns them.

---

## 2. Invariant verification list

**Prices**

| Invariant                                               | Enforced by                                                                                             | Notes                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Every price change is in the history, with who and when | `course_prices_record_change_trg` (same statement), `course_prices_noop_update_ck`, append-only history | `course_prices` = the latest change. A no-op update is rejected, so the upsert must use `WHERE (amount, currency) IS DISTINCT FROM`. |
| Price in [0, 9999.99], currency shape                   | `course_prices_amount_ck`, `*_currency_ck`                                                              | Tier membership is checked in the app (`PRICE_TIERS`).                                                                               |

**Coupons**

| Invariant                                                                                                                             | Enforced by                                                                                 | Notes                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Coupon terms are immutable; deactivation happens once                                                                                 | `coupons_immutable_ck`                                                                      | `DeactivateCoupon` must use `WHERE deactivated_at IS NULL`.         |
| Course ⇔ course_id; platform coupons are PERCENT only; discount shape; window 1–31 d (course) / ≤ 90 d (platform); start ≤ 90 d ahead | `coupons_*_ck`                                                                              |                                                                     |
| Unique code per course; one platform namespace                                                                                        | `coupons_course_id_code_uq` (NULLS NOT DISTINCT)                                            |                                                                     |
| Never over `max_redemptions` (except accepted late overshoot)                                                                         | `coupon_redemptions_reserve_trg` → `coupon_redemptions_limit_ck`, under the coupon row lock | Race-free even if the app forgets to lock. Requires READ COMMITTED. |
| A coupon is redeemable only while active and inside its window                                                                        | `coupon_redemptions_coupon_valid_ck` (same trigger, fresh row after the lock)               | Deactivation cannot race a reservation.                             |
| One live redemption per user per coupon                                                                                               | `coupon_redemptions_coupon_id_user_id_active_uq`                                            | A late re-consumption is excluded (§6 R1).                          |
| Redemption edges RESERVED→CONSUMED/RELEASED and RELEASED→CONSUMED; timestamps match the status                                        | `coupon_redemptions_transition_ck`, `_timestamps_ck`                                        |                                                                     |
| Redemption state matches the order state                                                                                              | deferred `coupon_redemptions_order_status_ck`                                               |                                                                     |
| Each discounted line has a redemption on its order; each redemption is used by a line                                                 | `order_lines_order_id_coupon_id_fk`, deferred `coupon_redemptions_unused_ck`                |                                                                     |
| The line's coupon applies to that course and currency; the discount equals the coupon terms                                           | `order_lines_coupon_scope_ck`, `order_lines_discount_ck` (via `commerce.coupon_discount`)   | The DB is the discount and share rounding authority.                |

**Orders and payments**

| Invariant                                                                                                                            | Enforced by                                                                                          | Notes                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Order total = Σ line finals, with ≥ 1 line; total is 0 or ≥ 0.50                                                                     | deferred `orders_total_ck`, `orders_total_amount_ck`                                                 | Appending a line later also breaks the total.            |
| Final and shares follow a single rounding; instructor + platform = final                                                             | STORED generated columns                                                                             | Table-driven tests (§Hand-off).                          |
| Lines are immutable                                                                                                                  | append-only trigger + REVOKE                                                                         |                                                          |
| One PENDING_PAYMENT order per user                                                                                                   | `orders_user_id_pending_uq`                                                                          |                                                          |
| Same Idempotency-Key gives the same order                                                                                            | `orders_user_id_idempotency_key_uq` + fingerprint                                                    |                                                          |
| Order status changes only through legal, linear edges                                                                                | `order_transitions_edge_ck`, chain FK `…_prev_seq_from_status_fk`, `order_transitions_pk`            | Two concurrent transitions with the same seq give 23505. |
| status, placed_at, paid_at and closed_at equal the log                                                                               | deferred `orders_status_log_ck`                                                                      |                                                          |
| Order money and identity columns are immutable; paid_at and closed_at are set once                                                   | `orders_immutable_ck`                                                                                |                                                          |
| Order status matches the SUCCEEDED refund sum (PAID = 0, PARTIALLY in (0, total), REFUNDED = total)                                  | deferred `orders_refund_status_ck`                                                                   |                                                          |
| Payment amount = order total (always)                                                                                                | `payments_order_id_amount_currency_fk`                                                               |                                                          |
| A payment exists ⇔ total > 0; payment status matches order status                                                                    | deferred `payments_order_status_ck`                                                                  |                                                          |
| PAID only if the received amount and currency match, unless the order went through PAYMENT_REVIEW; PAYMENT_REVIEW only on a mismatch | deferred `payments_received_ck`                                                                      |                                                          |
| Payment edges; session id and payment intent set once; `checkout_url` only while OPEN                                                | `payments_transition_ck`, `payments_checkout_url_ck`, `payments_session_ck`, `payments_succeeded_ck` |                                                          |

**Refunds**

| Invariant                                                                                                                    | Enforced by                                                                                              | Notes |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----- |
| A refund is for a line of its own order, for the full line amount                                                            | `refunds_order_id_order_line_id_amount_fk` (STORED `final_amount` target)                                |       |
| One live refund per line; at most one SUCCEEDED per line                                                                     | `refunds_order_line_id_live_uq`                                                                          |       |
| Refunds are only created on PAID / PARTIALLY_REFUNDED orders (PAYMENT_REVIEW: admin only)                                    | `refunds_order_status_ck` (FOR SHARE on the order)                                                       |       |
| Refund edges; status, approved_at, succeeded_at, attempt and created_at equal the log; the initiator matches the first actor | `refund_transitions_edge_ck` + chain FK, deferred `refunds_status_log_ck`, `refund_transitions_actor_ck` |       |
| Reason code fits the initiator; reject reason ≥ 10; comment only from students                                               | `refunds_reason_code_ck`, `refund_transitions_reason_ck`, `refunds_comment_ck`                           |       |

**Webhooks**

| Invariant                                                                          | Enforced by                                        | Notes |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- | ----- |
| Webhook events are applied once; the outcome is written once; no payload is stored | `provider_events_pk` + `provider_events_guard_trg` |       |

**Enrollments**

| Invariant                                                                                                         | Enforced by                              | Notes |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----- |
| One enrollment per (user, course); grant is an upsert                                                             | `enrollments_user_id_course_id_uq`       |       |
| Enrollment edges GRANT / REVOKE / REGRANT; source and refund shape; admin actions need an actor and a reason ≥ 10 | `enrollment_transitions_*_ck` + chain FK |       |
| Enrollment columns equal the log                                                                                  | deferred `enrollments_status_log_ck`     |       |

**Ledger**

| Invariant                                                                                                                       | Enforced by                                                                                                                                                                                  | Notes                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Every entry is balanced (Σ = 0, ≥ 2 legs)                                                                                       | deferred `postings_balanced_ck`                                                                                                                                                              |                                             |
| Posting currency = entry currency = account currency                                                                            | `postings_entry_id_currency_fk`, `postings_account_id_currency_fk`                                                                                                                           | Declarative, so there is no trigger for it. |
| Ledger is idempotent per (kind, line, refund); a line is reversed at most once; a REFUND needs its SALE and is its exact mirror | `journal_entries_kind_order_line_id_refund_id_uq`, `journal_entries_order_line_id_refund_uq`, `journal_entries_sale_missing_ck` (immediate, retryable), deferred `journal_entries_mirror_ck` |                                             |
| Ledger facts are append-only                                                                                                    | append-only triggers + REVOKE (accounts, entries, postings)                                                                                                                                  |                                             |

**Not DB-enforceable** (these cross schemas, D12):

- `enrollments.order_line_id` ↔ `order_lines`
- `journal_entries` ↔ commerce facts
- `course_id` ↔ catalog

They are covered by the reconciliation queries in §8.7 and §8.8. Run those in integration tests and as an ops check.

**ON DELETE policy:**

- Every FK is RESTRICT, except `carts → users` and `cart_items → carts`, which CASCADE.
- No state table is ever deleted (REVOKE in prod).

---

## 3. Seed data

The migration seeds nothing: no constraint depends on reference rows, and payouts accounts are created lazily.

**Optional dev seed** (a seed script, not the migration; idempotent):

```sql
-- price every published dev course at 49.99 (owner as actor); the trigger writes the history
INSERT INTO commerce.course_prices (course_id, amount, currency, updated_by)
SELECT c.id, 49.99, 'USD', c.owner_id FROM catalog.courses c WHERE c.status = 'PUBLISHED'
ON CONFLICT (course_id) DO NOTHING;

-- one platform coupon, created by a known admin ($admin_id)
INSERT INTO commerce.coupons (scope, code, discount_type, percent_off, starts_at, ends_at, created_by)
VALUES ('PLATFORM', 'WELCOME10', 'PERCENT', 10, now(), now() + interval '90 days', $admin_id)
ON CONFLICT DO NOTHING;

-- platform ledger accounts (otherwise created by the first SALE)
INSERT INTO payouts.accounts (type, owner_id, currency)
VALUES ('PROVIDER_CLEARING', NULL, 'USD'), ('PLATFORM_REVENUE', NULL, 'USD')
ON CONFLICT DO NOTHING;
```

---

## 4. Privileges

**`udemy_app`** gets the block in §1.14, the P1/P2 conditional pattern.

| Grant level         | Objects                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No UPDATE or DELETE | `course_price_changes`, `order_lines`, `order_transitions`, `refund_transitions`, `enrollment_transitions`, `payouts.accounts`, `payouts.journal_entries`, `payouts.postings` |
| No DELETE           | `course_prices`, `coupons`, `coupon_redemptions`, `orders`, `payments`, `refunds`, `provider_events`, `enrollments`                                                           |
| SELECT only         | `payouts.account_balances`                                                                                                                                                    |
| Full DML            | `carts`, `cart_items`                                                                                                                                                         |

**Why the app keeps UPDATE on `coupons` and `orders`:** the guard triggers run as the invoker and take `FOR NO KEY UPDATE` on coupons and `FOR SHARE` on orders. Every row-locking clause requires UPDATE privilege.

**Execution rights:**

- Trigger functions need no EXECUTE at fire time.
- `commerce.coupon_discount` is called from the quote SQL, so it gets an explicit GRANT EXECUTE. `roles.sql` revokes EXECUTE on functions from PUBLIC by default.

**Things I did not add:**

- **Payouts write isolation is not possible yet.** The API and the worker share `udemy_app`, so "payouts written by the worker only" is a convention, not a privilege. A future `udemy_worker` role could get INSERT on payouts while the app gets SELECT only. That needs a `roles.sql` change, which is out of scope here and only noted.
- **`roles.sql`: no change needed.** The global default privileges already cover the new schemas and tables, and no new role is introduced.

---

## 5. 3NF check

**In 3NF:**

- `carts`, `cart_items`, `coupons`
- `course_price_changes` (after dropping `previous_amount`)
- `order_transitions`, `refund_transitions`, `enrollment_transitions`
- `provider_events`
- `payouts.accounts`, `payouts.journal_entries`

**Documented exceptions.** Each one is DB-verified, FK-pinned or immutable:

1. **`course_prices`** is the materialised latest `course_price_changes` row, written by a trigger in the same statement. No-op updates are forbidden, so `updated_by` and `updated_at` always equal the last change.
2. **Materialised state columns.** Each is verified at COMMIT. They are needed for partial uniques, keysets and conditional updates.
   - `orders.status`, `placed_at`, `paid_at`, `closed_at`: `orders_status_log_ck`
   - `refunds.status`, `approved_at`, `succeeded_at`, `attempt`, `created_at`: `refunds_status_log_ck`
   - `enrollments.status`, `source`, `order_line_id`, `granted_at`, `revoked_at`, `revoke_reason`, `created_at`: `enrollments_status_log_ck`
3. **`orders.total_amount`** = Σ line finals (`orders_total_ck`). It is needed as the payment FK target and is immutable.
4. **`order_lines` snapshot columns** (`course_title`, `instructor_id`, `list_amount`, `revenue_share_bps`) are point-in-time facts (D6), not copies of live data.
   - `final_amount` and the two share columns are generated, depending only on columns of the same row. They exist as the FK target and the rounding authority, and they cannot drift.
5. **`coupon_redemptions.user_id` and `refunds.user_id`** depend on `order_id`. Each is pinned by a composite FK to `orders (id, user_id)`. They are needed for the per-user partial unique and the abuse index.
6. **`refunds.amount`** = the line's `final_amount`, and **`refunds.order_id`** = the line's order. Both are pinned by `refunds_order_id_order_line_id_amount_fk`.
7. **`payments.amount` and `currency`** = the order total, pinned by FK.
8. **`postings.currency`** is FK-pinned to both the entry and the account. It turns the currency rule into a declarative constraint.
9. **FK helpers:** `prev_seq` (generated) on the three transition tables.

**Removed relative to design §6, for 3NF:**

- `course_price_changes.previous_amount`: use `lag()`, or `RETURNING old.amount` for the event.
- `refunds.requested_by`: it is the actor of the seq-1 transition.
- `orders.created_at`: it equals `placed_at`.
- `order_lines.created_at`: it equals `orders.placed_at`.
- `coupon_redemptions.id`, `payments.id` and the transitions' `id`: natural keys are used instead.
- The uniqueness of `journal_entries.source_event_id`: see §6 item 9.

**Trade-off flagged (correctness over speed):** `ListRecentSales` keysets on `orders.paid_at` through a join. I did **not** copy `paid_at` onto `order_lines`, because that would be a drifting copy. It is fine at this scale; if it ever becomes hot, the fix is a trigger-maintained projection.

---

## 6. Deviations and issues found

### PG 18 fallback for the generated-column FK

If `refunds_order_id_order_line_id_amount_fk` is rejected:

- Replace `order_lines_order_id_id_final_amount_uq` with `UNIQUE (order_id, id)`.
- Make the FK `(order_id, order_line_id) → order_lines (order_id, id)`.
- Add this trigger:

```sql
CREATE FUNCTION commerce.refunds_amount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_final numeric;
BEGIN
  SELECT list_amount - discount_amount INTO v_final
    FROM commerce.order_lines WHERE id = NEW.order_line_id AND order_id = NEW.order_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;   -- the (order_id, order_line_id) FK reports it
  IF NEW.amount IS DISTINCT FROM v_final THEN
    RAISE EXCEPTION 'refund amount % must equal the line amount %', NEW.amount, v_final
      USING ERRCODE = '23514', CONSTRAINT = 'refunds_order_id_order_line_id_amount_fk';  -- same name, same error mapping
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_amount_trg BEFORE INSERT OR UPDATE OF amount, order_line_id ON commerce.refunds
  FOR EACH ROW EXECUTE FUNCTION commerce.refunds_amount_guard();
```

`payments_order_id_amount_currency_fk` targets plain columns, so it needs no fallback.

### Bugs and gaps in design §5/§6

1. **`journal_entries.source_event_id UNIQUE` breaks multi-line orders.** One `OrderPaid` creates one SALE entry per line, all with the same event id. It is now a plain trace column. Idempotency comes from `(kind, order_line_id, refund_id)`. The writer uses `ON CONFLICT DO NOTHING` with **no target**, and 0 rows means "already posted, skip postings".
2. **A late payment can collide with the per-user unique and wedge the webhook.** The sequence is:
   - The user's order A expires, and its redemption is RELEASED.
   - The user checks out again with the same coupon in order B (RESERVED).
   - A's late `completed` arrives. RELEASED → CONSUMED violates `(coupon_id, user_id) WHERE status IN (RESERVED, CONSUMED)`.
   - The handler returns 500, Stripe retries for 3 days, and money was taken with no enrollment.

   **Fix:** the partial unique excludes rows with `released_at IS NOT NULL`. A late re-consumption keeps `released_at` as the overshoot marker. The count index still counts it, so the overshoot is visible in the coupon's counts.

3. **Missing edge: a late completed with an amount mismatch on an EXPIRED or CANCELED order.** Design §4 allowed only PENDING → PAYMENT_REVIEW. I added EXPIRED/CANCELED → PAYMENT_REVIEW. Money was taken, so it must be reviewable.
4. **"Zero-amount lines: SUCCEEDED directly" contradicts `refunds.amount > 0` and "0.00 lines are not refundable".** I dropped that path.
   - Order refund status is defined by money: REFUNDED ⇔ Σ SUCCEEDED refunds = total.
   - So a PAID order with lines {0.00 via a 100% coupon, 50.00} becomes REFUNDED after the 50.00 refund, while the free line's enrollment stays. That is acceptable and documented.
5. **PAYMENT_REVIEW → REFUNDED would wedge the ledger writer.**
   - The order was never PAID, so there is no `OrderPaid` and no SALE entry.
   - `RefundSucceeded` then hits `journal_entries_sale_missing_ck` (treated as retryable) forever.
   - **Fix for T2/T14:** add `orderWasPaid: boolean` (= `paid_at IS NOT NULL`) to the `RefundSucceeded` payload. The writer ignores events with false. The reconciliation queries also filter on `paid_at IS NOT NULL`.
   - Also, PAYMENT_REVIEW refunds refund line finals, not the received amount. If less was received, the last refund fails at Stripe (over-refund) and lands in FAILED for an admin. This is flagged and accepted, because a mismatch is a bug or tampering signal.
6. **Stripe idempotent replay needs identical parameters.**
   - `expires_at` computed from `now()` at retry time differs from the original, so Stripe rejects the replay ("same parameters").
   - **Fix:** `payments.session_expires_at` is NOT NULL and decided in tx A as `date_trunc('second', now()) + TTL`. It is sent verbatim on every call.
   - Stripe also requires `expires_at` to be at least 30 min in the future for a _fresh_ create, and `COMMERCE_CHECKOUT_SESSION_TTL_MIN=30` is exactly that minimum. A create that takes even milliseconds is rejected. **Set the TTL to 35 or more** (P4-T3).
   - The checkout resume of a CREATING payment must stop after (TTL − 30 min). Past that, treat it as abandoned and let the reconciler (15 min) clean up.
7. **Reconciler and dispatcher shared advisory lock `_03` in design §5/§11.**
   - Use `0x75646d79_03` (504196069635) for refund dispatch and `0x75646d79_04` (504196069636) for reconcile. Otherwise one job starves the other.
   - Bind them from TS constants like the existing `_01` and `_02`.
8. **The redundant partial unique `refunds (order_line_id) WHERE status='SUCCEEDED'` was dropped.** SUCCEEDED is terminal and already inside the live unique.
9. **The redundant `coupons (course_id) WHERE deactivated_at IS NULL` index was dropped.** `coupons_course_id_code_uq` leads with `course_id`, and coupons per course are few.
10. **The redundant `orders (placed_at) WHERE status='PENDING_PAYMENT'` index was dropped.** The reconciler scans `payments`, so it has its own partial indexes there.
11. **`paid_at` semantics made precise.** It is the single transition into PAID; PAYMENT_REVIEW has none. The provider capture time is the new `payments.succeeded_at`. Design §6's "paid_at ⇔ PAYMENT_REVIEW too" would have started the refund window at capture for review orders.
12. **Received amount added** (`payments.received_amount` and `received_currency`). It makes D10's "the amount is re-checked" a DB invariant (`payments_received_ck`). Admin accept from review is the only path to PAID with a mismatch.
13. **Refund retries overwrite `provider_refund_id`.** The per-attempt provider ids and failure codes now live in `refund_transitions`. A retry (FAILED → APPROVED) clears `provider_refund_id`, `failure_code` and `dispatch_started_at`, and increments `attempt` (guarded).
14. **Transition logs use `seq` plus a chain FK** (P2-equivalent, simpler than `prev_transition_id`). `from_status` is DB-checked against the real predecessor, and concurrent transitions collide on the PK.
    - **App duty:** insert with `max(seq)+1` and the head's `to_status`, under the aggregate row lock (§8.3).
15. **The coupon limit and validity moved into a DB trigger** (`coupon_redemptions_reserve_trg`). D7 becomes enforced regardless of app code. The app still pre-locks in ascending id order for deadlock safety; re-locking inside the trigger is a no-op.
16. **Coupon codes are `text` with an uppercase ASCII CHECK, not citext.** On citext, `~` is case-insensitive, so §6's `citext CHECK (code ~ '^[A-Z0-9_-]...')` would accept lowercase. Over an ASCII alphabet the CHECK is exact, and this also avoids the citext codegen override.
17. **Natural PKs:** `payments (order_id)`, `coupon_redemptions (order_id, coupon_id)`, and `(aggregate_id, seq)` for the transition tables. FK targets were consolidated into one per relationship.
18. **New CHECKs:**
    - `orders_total_amount_ck` (0 or ≥ 0.50; the `amount_below_minimum` backstop)
    - `orders_zero_total_ck`
    - the coupon window CHECKs (31 d / 90 d / 90 d ahead)
    - the refund status-shape CHECKs
    - the enrollment admin-reason CHECK
    - the course-price no-op guard
19. **`course_prices`:** DELETE is revoked. 0.00 means free, and the history trigger does not cover deletes.
20. **Redemption state during PAYMENT_REVIEW** is RESERVED, or RELEASED if the order came from EXPIRED/CANCELED. Review → PAID makes it CONSUMED. Review → REFUNDED must make it RELEASED; this is an app duty, DB-checked.
21. **Two unverified PG points** (sql-ops must prove them):
    - `ON CONFLICT (user_id, course_id)` infers `enrollments_user_id_course_id_uq` even with `INCLUDE (status)`. Fallback: drop the `INCLUDE`; the lookup then needs a heap fetch, which is fine.
    - `RETURNING old.*` on `INSERT … ON CONFLICT DO UPDATE` (PG 18) returns NULL for inserts.

### Races, checked one by one

- **R1. Coupon redemption vs expiry/deactivation/limit.**
  - The reservation trigger locks the coupon (`FOR NO KEY UPDATE`, which conflicts with the deactivate UPDATE). It then re-reads in a fresh statement: plpgsql at READ COMMITTED takes a new snapshot per statement. So a deactivation or a competing reservation committed while waiting is seen.
  - The window is tested against `now()` (transaction start). A transaction that began just before `ends_at` may still reserve. This is accepted and bounded by the short transaction.
  - An existing RESERVED redemption whose coupon expires before payment is still honoured (price locked at checkout).
  - **At REPEATABLE READ the count would miss concurrent inserts**, because the coupon row is never updated by a reservation, so no serialization failure fires. Commerce must stay at READ COMMITTED.
  - The late-collision fix is item 2 above.
- **R2. Webhook vs reconciler.**
  - They use different event ids (`evt_…` vs `reconcile:{session}:{status}`), so both may be claimed.
  - Effects are serialised by the cart lock, then the order lock (`FOR UPDATE`), then state guards, so the second one yields `DUPLICATE_EFFECT`.
  - **Reconcile (a) vs user resume:** the reconciler may expire a session the user is just being redirected to. The user then sees an expired page, and the order ends EXPIRED. No money moves, so this is acceptable; resume must stop at TTL − 30 min (item 6).
  - **Reconcile (b)** applies `retrieve()`'s authoritative status through the same handler.
- **R3. Refund vs the PAID transition.**
  - `refunds_order_status_ck` (FOR SHARE on the order) rejects any refund before PAID. The app checks first under its own `FOR UPDATE`.
  - The SYSTEM duplicate refund is inserted inside the PAID transaction, after the order update.
  - **Dispatcher tx2 vs the refund webhook:** both lock the order, then the refund, with conditional updates, so the second is a no-op.
  - Refund SUCCEEDED and the order status recompute must happen in the same transaction (`orders_refund_status_ck`).
- **R4. Double grant.**
  - All PAID transitions of one user serialise on the cart row. A second order for the same course therefore sees ACTIVE, gets `ALREADY_ACTIVE`, and a `DUPLICATE_PURCHASE` refund is created.
  - Free enroll and admin grant don't take the cart lock. They collide on the `(user_id, course_id)` row lock of the upsert, and `ON CONFLICT DO UPDATE … WHERE status='REVOKED'` locks the row even when the WHERE is false. So exactly one side grants and the other sees ACTIVE.
  - **Refund of order A racing B's PAID:** if A's revoke commits first, B's upsert re-evaluates and REGRANTs from B (correct). If B goes first, B gets a duplicate refund and A's refund then revokes. The user is left with no access and both payments refunded, which is acceptable because they asked for a refund.
- **R5. The D11 abuse count.** Two concurrent refund requests by the same user on different orders could each count 2 and both auto-approve. RequestRefund must take the cart row lock first; that is the user mutex and fits the lock order.
- **R6. Duplicate webhook delivery.**
  - The second `INSERT … ON CONFLICT DO NOTHING` blocks on the PK until the first commits, then gets 0 rows: "duplicate, 200".
  - If the first rolls back (500), the second proceeds. Correct.
- **R7. Checkout with the same key twice.** Both requests serialise on the cart lock, and the second finds the order by `(user_id, key)` and resumes. With different keys, the second gets `orders_user_id_pending_uq` (or the app's pre-check), giving 409 `checkout_in_progress`.
- **R8. Lock order.** This is final; a path may skip a step but never takes an earlier step after a later one.

  `carts → orders → payments → refunds → coupons (ascending id) → coupon_redemptions → enrollments (ascending course_id)`

  - New-row inserts are covered by their parent's lock.
  - Webhook handlers read `orders.user_id` without a lock (it is immutable), then lock the cart, then the order.
  - Dispatcher tx2 and the refund webhook lock the order **before** the refund (design §5 implied the reverse for the dispatcher). Its tx1 lease locks refund rows only, with `SKIP LOCKED`, and commits immediately.
  - Coupon creation locks the `course_prices` row (it exists, because price > 0 is required), which serialises the "≤ 10 active" count and AMOUNT ≤ list price. Nothing else locks `course_prices`.
  - The ledger writer touches only payouts.

---

## 7. Kysely type expectations

These assume `kysely-codegen --camel-case --numeric-parser string --date-parser timestamp`.

**Keys:**

- `"commerce.coursePrices"`, `"commerce.coursePriceChanges"`
- `"commerce.carts"`, `"commerce.cartItems"`
- `"commerce.coupons"`, `"commerce.couponRedemptions"`
- `"commerce.orders"`, `"commerce.orderLines"`, `"commerce.orderTransitions"`
- `"commerce.payments"`
- `"commerce.refunds"`, `"commerce.refundTransitions"`
- `"commerce.providerEvents"`
- `"enrollment.enrollments"`, `"enrollment.enrollmentTransitions"`
- `"payouts.accounts"`, `"payouts.journalEntries"`, `"payouts.postings"`
- `"payouts.accountBalances"` (a view). Verify that codegen emits it; if not, type it by hand as read-only.

**Codegen overrides.** Extend the `--overrides` JSON in `packages/db/package.json`, the same mechanism as `parent_depth`. Generated and identity columns otherwise come out as insertable `Generated<…>`.

```json
"commerce.orders.order_number": "ColumnType<string, never, never>",
"commerce.order_lines.final_amount": "ColumnType<string, never, never>",
"commerce.order_lines.instructor_share_amount": "ColumnType<string, never, never>",
"commerce.order_lines.platform_share_amount": "ColumnType<string, never, never>",
"commerce.order_transitions.prev_seq": "ColumnType<number | null, never, never>",
"commerce.refund_transitions.prev_seq": "ColumnType<number | null, never, never>",
"enrollment.enrollment_transitions.prev_seq": "ColumnType<number | null, never, never>"
```

**Types:**

- `numeric` → `Numeric` (a string at runtime). **Insert money only as decimal strings** (`'19.99'`), never JS numbers.
- `sum(numeric)` → string; `count(*)` → `Int8` (string). `smallint` and `integer` → `number`.
- `char(3)` → `string`. `bytea` (`requestFingerprint`, `payloadSha256`) → `Buffer`. `timestamptz` → `Date`.

**Omit on insert** (these are defaults; supply them only where noted):

- `orders.placedAt`
- `payments.status` and `payments.provider`
- `refunds.attempt`
- `enrollments.status`
- every `occurredAt`, `createdAt` and `updatedAt`

The deferred guards compare these timestamps for equality, so they must come from the same transaction's `now()`. Never send JS `new Date()` for `paid_at`, `closed_at`, `approved_at`, `succeeded_at`, `granted_at` or `revoked_at`; use `sql\`now()\``.

**Raw SQL needed:**

- `RETURNING old.status` (PG 18) and the `max(seq)+1` transition insert. Use the `sql` template.
- `ON CONFLICT` arbiters:
  - `carts` (`userId`)
  - `cartItems` (`userId`, `courseId`)
  - `enrollments` (`userId`, `courseId`)
  - `providerEvents` (`provider`, `eventId`)
  - `coursePrices` (`courseId`)
  - for `accounts` and `journalEntries`, use `.onConflict(oc => oc.doNothing())` with no target
- **The accounts lookup must not use `IS NOT DISTINCT FROM`** (it is not indexable). Use `owner_id = $1` or `owner_id IS NULL` per type.

**Errors:** deferred errors (`*_status_log_ck`, `orders_total_ck`, `orders_refund_status_ck`, `payments_*_ck`, `coupon_redemptions_order_status_ck` / `_unused_ck`, `postings_balanced_ck`, `journal_entries_mirror_ck`) surface at `db.transaction().execute()` commit. Map them in the TransactionRunner.

**Keyset cursors:** keep timestamp keyset cursors as exact SQL text (`placed_at::text`, `granted_at::text`, `paid_at::text`), per P2 §14. A JS `Date` loses microseconds.

---

## 8. Operational SQL (all at READ COMMITTED)

### 8.1 Quote (GetCart, and inside checkout after the coupon lock)

```sql
WITH cart AS (
  SELECT k.coupon_code FROM commerce.carts k WHERE k.user_id = $user_id),
lines AS (
  SELECT ci.course_id, ci.added_at, p.amount AS list_amount, p.currency
    FROM commerce.cart_items ci
    LEFT JOIN commerce.course_prices p ON p.course_id = ci.course_id
   WHERE ci.user_id = $user_id),
cands AS (
  SELECT c.id, c.scope, c.course_id, c.discount_type, c.percent_off, c.amount_off, c.currency,
         c.starts_at, c.ends_at, c.deactivated_at, c.max_redemptions,
         (SELECT count(*) FROM commerce.coupon_redemptions r
           WHERE r.coupon_id = c.id AND r.status IN ('RESERVED','CONSUMED'))                        AS used_count,
         EXISTS (SELECT 1 FROM commerce.coupon_redemptions r
                  WHERE r.coupon_id = c.id AND r.user_id = $user_id AND r.status IN ('RESERVED','CONSUMED')) AS used_by_me
    FROM commerce.coupons c, cart
   WHERE c.code = cart.coupon_code
     AND (c.course_id IN (SELECT course_id FROM lines) OR c.course_id IS NULL))
SELECT l.course_id, l.list_amount, l.currency, b.coupon_id, coalesce(b.discount_amount, 0) AS discount_amount
  FROM lines l
  LEFT JOIN LATERAL (
    SELECT c.id AS coupon_id,
           commerce.coupon_discount(l.list_amount, c.discount_type, c.percent_off, c.amount_off) AS discount_amount
      FROM cands c
     WHERE (c.course_id = l.course_id OR c.course_id IS NULL)
       AND c.deactivated_at IS NULL AND now() >= c.starts_at AND now() < c.ends_at
       AND (c.max_redemptions IS NULL OR c.used_count < c.max_redemptions)
       AND NOT c.used_by_me
       AND (c.currency IS NULL OR c.currency = l.currency)
     ORDER BY discount_amount DESC, (c.scope = 'COURSE') DESC, c.id   -- best wins, tie -> course coupon
     LIMIT 1) b ON l.list_amount > 0
 ORDER BY l.added_at, l.course_id;
-- The candidate rows (cands) are also returned to explain coupon_expired/not_started/exhausted/already_used;
-- no candidate matching any line -> coupon_invalid. Catalog status/owner/title and active enrollments come from the facades.
```

### 8.2 Checkout tx A, including the coupon reservation

```sql
INSERT INTO commerce.carts (user_id) VALUES ($user_id) ON CONFLICT (user_id) DO NOTHING;
SELECT coupon_code FROM commerce.carts WHERE user_id = $user_id FOR UPDATE;                     -- lock 1
SELECT o.id, o.status, o.request_fingerprint, p.status AS payment_status, p.checkout_url, p.created_at
  FROM commerce.orders o LEFT JOIN commerce.payments p ON p.order_id = o.id
 WHERE o.user_id = $user_id AND o.idempotency_key = $key;                                        -- resume?
SELECT o.id, p.checkout_url FROM commerce.orders o LEFT JOIN commerce.payments p ON p.order_id = o.id
 WHERE o.user_id = $user_id AND o.status = 'PENDING_PAYMENT';                                    -- 409 checkout_in_progress
SELECT id FROM commerce.coupons
 WHERE code = $code AND (course_id = ANY($course_ids::uuid[]) OR course_id IS NULL)
 ORDER BY id FOR NO KEY UPDATE;                                                                  -- lock coupons, ascending
-- re-run 8.1 now (fresh snapshot) -> compare with expectedTotal / availability -> 409 / 422
INSERT INTO commerce.orders (user_id, status, currency, total_amount, idempotency_key, request_fingerprint)
VALUES ($user_id, CASE WHEN $total::numeric = 0 THEN 'PAID' ELSE 'PENDING_PAYMENT' END, $cur, $total, $key, $fp)
RETURNING id, order_number, placed_at;
-- zero-total: also SET paid_at -> use INSERT ... (paid_at) VALUES (... CASE WHEN $total = 0 THEN now() END)
INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status, consumed_at)
VALUES ($order_id, $coupon_id, $user_id, $zero ? 'CONSUMED' : 'RESERVED', $zero ? now() : NULL);  -- one per distinct coupon used
INSERT INTO commerce.order_lines (order_id, line_no, course_id, instructor_id, course_title,
                                  list_amount, discount_amount, coupon_id, revenue_share_bps)
VALUES (...), (...)
RETURNING id, course_id, final_amount, instructor_share_amount, platform_share_amount;
INSERT INTO commerce.payments (order_id, amount, currency, session_expires_at)                  -- total > 0 only
VALUES ($order_id, $total, $cur, date_trunc('second', now()) + make_interval(mins => $ttl_min::int));
INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause, actor_id)
VALUES ($order_id, 1, NULL, $zero ? 'PAID' : 'PENDING_PAYMENT', $zero ? 'ZERO_TOTAL' : 'CHECKOUT', $user_id);
-- zero-total: grants (8.3 step 6) + cart cleanup; outbox OrderPlaced / OrderPaid; COMMIT
-- tx B, after the provider call:
UPDATE commerce.payments SET status = 'OPEN', checkout_session_id = $sid, checkout_url = $url
 WHERE order_id = $order_id AND status = 'CREATING' RETURNING order_id;                          -- 0 rows -> re-read state
```

### 8.3 The order PAID transition (webhook `CHECKOUT_COMPLETED`; the reconciler uses the same code)

```sql
-- 0. claim (0 rows -> duplicate -> COMMIT, 200)
INSERT INTO commerce.provider_events (provider, event_id, type, livemode, object_id, order_id, provider_created_at, payload_sha256)
VALUES ('STRIPE', $evt, $type, $livemode, $session_id, NULL, $created, $sha)
ON CONFLICT (provider, event_id) DO NOTHING RETURNING event_id;
-- 1. map the order without a lock (user_id is immutable)
SELECT o.id, o.user_id FROM commerce.orders o
 WHERE o.id = coalesce($metadata_order_id, $client_reference_id)
UNION ALL
SELECT p.order_id, o.user_id FROM commerce.payments p JOIN commerce.orders o ON o.id = p.order_id
 WHERE p.checkout_session_id = $session_id
LIMIT 1;                                                                                          -- none -> outcome ORPHAN
-- 2. locks in order
INSERT INTO commerce.carts (user_id) VALUES ($user_id) ON CONFLICT (user_id) DO NOTHING;
SELECT 1 FROM commerce.carts WHERE user_id = $user_id FOR UPDATE;
SELECT status, total_amount, currency FROM commerce.orders WHERE id = $order_id FOR UPDATE;
-- status IN (PAID, PARTIALLY_REFUNDED, REFUNDED, PAYMENT_REVIEW) -> outcome DUPLICATE_EFFECT
-- amount/currency mismatch -> same steps with to_status 'PAYMENT_REVIEW', no grants, outcome MISMATCH
-- 3. payment
UPDATE commerce.payments
   SET status = 'SUCCEEDED', checkout_session_id = coalesce(checkout_session_id, $session_id), checkout_url = NULL,
       payment_intent_id = $pi, received_amount = $amount_total, received_currency = $currency, succeeded_at = now()
 WHERE order_id = $order_id AND status IN ('CREATING','OPEN','EXPIRED','ABANDONED');
-- 4. order + log (seq under the order lock)
UPDATE commerce.orders SET status = 'PAID', paid_at = now()
 WHERE id = $order_id AND status IN ('PENDING_PAYMENT','EXPIRED','CANCELED')
RETURNING old.status;
INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause, provider, provider_event_id)
SELECT $order_id, h.seq + 1, h.to_status, 'PAID', $cause /* PROVIDER_EVENT | RECONCILER */, 'STRIPE', $evt
  FROM (SELECT seq, to_status FROM commerce.order_transitions WHERE order_id = $order_id ORDER BY seq DESC LIMIT 1) h;
-- 5. redemptions
UPDATE commerce.coupon_redemptions SET status = 'CONSUMED', consumed_at = now()
 WHERE order_id = $order_id AND status IN ('RESERVED','RELEASED');
-- 6. grants, per line ORDER BY course_id (EnrollmentFacade.grant on the same trx)
INSERT INTO enrollment.enrollments (user_id, course_id, source, order_line_id)
VALUES ($user_id, $course_id, 'ORDER', $line_id)
ON CONFLICT (user_id, course_id) DO UPDATE
   SET status = 'ACTIVE', source = EXCLUDED.source, order_line_id = EXCLUDED.order_line_id,
       granted_at = now(), revoked_at = NULL, revoke_reason = NULL
 WHERE enrollments.status = 'REVOKED'
RETURNING id, old.status AS previous_status;     -- NULL -> GRANTED (seq 1, GRANT); 'REVOKED' -> REGRANTED; 0 rows -> ALREADY_ACTIVE
INSERT INTO enrollment.enrollment_transitions (enrollment_id, seq, action, from_status, to_status, source, order_line_id)
SELECT $enrollment_id, coalesce(max(seq), 0) + 1, $action, $from, 'ACTIVE', 'ORDER', $line_id
  FROM enrollment.enrollment_transitions WHERE enrollment_id = $enrollment_id;
--    ALREADY_ACTIVE -> SYSTEM refund for that line:
INSERT INTO commerce.refunds (order_id, order_line_id, user_id, amount, status, initiated_by, reason_code, approved_at)
VALUES ($order_id, $line_id, $user_id, $final, 'APPROVED', 'SYSTEM', 'DUPLICATE_PURCHASE', now()) RETURNING id;
INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status) VALUES ($refund_id, 1, NULL, 'APPROVED');
-- 7. cart cleanup
DELETE FROM commerce.cart_items WHERE user_id = $user_id AND course_id = ANY($course_ids::uuid[]);
UPDATE commerce.carts SET coupon_code = NULL WHERE user_id = $user_id AND coupon_code = ANY($consumed_codes::text[]);
-- 8. outbox OrderPaid + EnrollmentGranted (+ RefundApproved); 9. outcome; COMMIT; post-commit dispatcher kick if refunds
UPDATE commerce.provider_events SET order_id = $order_id, processed_at = now(), outcome = 'APPLIED'
 WHERE provider = 'STRIPE' AND event_id = $evt;
```

### 8.4 Refund dispatch lease (API `CommerceJobs`, every 10 s plus the kick)

```sql
-- tx1: claim (short; SKIP LOCKED so replicas split the work)
SELECT pg_try_advisory_xact_lock($dispatch_key::bigint);                 -- 0x75646d79_03; false -> skip this tick
WITH next AS (
  SELECT r.id FROM commerce.refunds r
   WHERE r.status = 'APPROVED'
     AND (r.dispatch_started_at IS NULL OR r.dispatch_started_at < now() - interval '2 minutes')   -- stale lease = crashed claim
   ORDER BY r.approved_at, r.id
   LIMIT $batch
   FOR UPDATE SKIP LOCKED)
UPDATE commerce.refunds r SET dispatch_started_at = now()
  FROM next WHERE r.id = next.id
RETURNING r.id, r.order_id, r.order_line_id, r.amount, r.attempt, r.dispatch_started_at,
          (SELECT p.payment_intent_id FROM commerce.payments p WHERE p.order_id = r.order_id) AS payment_intent_id;
COMMIT;
-- provider.createRefund({paymentIntentId, amountMinor, refundId}, {idempotencyKey: `refund:${id}:${attempt}`}) - no tx open
-- tx2 per refund: lock order, then refund; fenced on (attempt, dispatch_started_at)
SELECT 1 FROM commerce.orders WHERE id = $order_id FOR UPDATE;
UPDATE commerce.refunds
   SET status = $new /* SUBMITTED | SUCCEEDED | FAILED */, provider_refund_id = $prid,
       failure_code = $code, succeeded_at = CASE WHEN $new = 'SUCCEEDED' THEN now() END, dispatch_started_at = NULL
 WHERE id = $id AND status = 'APPROVED' AND attempt = $attempt AND dispatch_started_at = $claimed_at
RETURNING id;                                                            -- 0 rows -> the webhook won; no-op
INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, provider_refund_id, failure_code)
SELECT $id, h.seq + 1, h.to_status, $new, $prid, $code
  FROM (SELECT seq, to_status FROM commerce.refund_transitions WHERE refund_id = $id ORDER BY seq DESC LIMIT 1) h;
-- SUCCEEDED -> recompute the order status in the same tx (8.4b); outbox RefundSucceeded / RefundFailed
-- on a transient error, release the lease:
UPDATE commerce.refunds SET dispatch_started_at = NULL WHERE id = $id AND dispatch_started_at = $claimed_at;

-- 8.4b order status after a refund SUCCEEDED (under the order lock)
SELECT o.status, o.total_amount, o.paid_at,
       coalesce((SELECT sum(r.amount) FROM commerce.refunds r WHERE r.order_id = o.id AND r.status = 'SUCCEEDED'), 0) AS refunded
  FROM commerce.orders o WHERE o.id = $order_id;
-- refunded = total -> REFUNDED (cause REFUND); PAID and 0 < refunded < total -> PARTIALLY_REFUNDED; PAYMENT_REVIEW < total -> unchanged.
-- PAYMENT_REVIEW -> REFUNDED must also: UPDATE coupon_redemptions SET status='RELEASED', released_at=now() WHERE order_id=$1 AND status='RESERVED'.
```

### 8.5 Reconcile (API `CommerceJobs`, every 5 min, `pg_try_advisory_xact_lock(0x75646d79_04)` per batch)

```sql
-- (a) CREATING older than 15 min: replay the create (same key, same stored session_expires_at), then expire it
SELECT p.order_id, p.session_expires_at, o.user_id
  FROM commerce.payments p JOIN commerce.orders o ON o.id = p.order_id
 WHERE p.status = 'CREATING' AND p.created_at < now() - interval '15 minutes'
 ORDER BY p.created_at LIMIT $batch;
--   provider: replay -> expire. ALREADY_COMPLETE -> apply COMPLETED via 8.3 with event 'reconcile:{sid}:COMPLETED'.
--   Otherwise, tx: cart lock, order lock, then
UPDATE commerce.payments SET status = 'ABANDONED', checkout_session_id = coalesce(checkout_session_id, $sid_or_null)
 WHERE order_id = $order_id AND status = 'CREATING';
UPDATE commerce.orders SET status = 'CANCELED', closed_at = now() WHERE id = $order_id AND status = 'PENDING_PAYMENT';
--   + order transition (cause RECONCILER), redemptions RESERVED -> RELEASED, outbox OrderCanceled

-- (b) OPEN sessions whose expires_at passed more than 10 min ago: retrieve, then apply the provider's answer through 8.3 / expire
SELECT p.order_id, p.checkout_session_id
  FROM commerce.payments p
 WHERE p.status = 'OPEN' AND p.session_expires_at < now() - interval '10 minutes'
 ORDER BY p.session_expires_at LIMIT $batch;
--   synthetic event ids 'reconcile:{sessionId}:{COMPLETED|EXPIRED}' are claimed in provider_events like real ones
```

### 8.6 Instructor sales summary (range ≤ 366 days; sales by `paid_at`, refunds by `succeeded_at`)

```sql
WITH mine AS (
  SELECT l.id, l.course_id, l.list_amount, l.discount_amount, l.final_amount, l.instructor_share_amount, o.paid_at
    FROM commerce.order_lines l
    JOIN commerce.orders o ON o.id = l.order_id
   WHERE l.instructor_id = $instructor_id AND o.paid_at IS NOT NULL),
facts AS (
  SELECT 'S' AS k, m.course_id, m.list_amount, m.discount_amount, m.final_amount, m.instructor_share_amount
    FROM mine m WHERE m.paid_at >= $from AND m.paid_at < $to
  UNION ALL
  SELECT 'R', m.course_id, 0, 0, r.amount, m.instructor_share_amount
    FROM mine m JOIN commerce.refunds r ON r.order_line_id = m.id AND r.status = 'SUCCEEDED'
   WHERE r.succeeded_at >= $from AND r.succeeded_at < $to)
SELECT course_id,                                                         -- NULL row = total (ROLLUP)
       count(*) FILTER (WHERE k = 'S')                                         AS sales_count,
       coalesce(sum(list_amount)     FILTER (WHERE k = 'S'), 0)                AS gross,
       coalesce(sum(discount_amount) FILTER (WHERE k = 'S'), 0)                AS discounts,
       coalesce(sum(final_amount)    FILTER (WHERE k = 'R'), 0)                AS refunded,
       coalesce(sum(final_amount)    FILTER (WHERE k = 'S'), 0)
         - coalesce(sum(final_amount) FILTER (WHERE k = 'R'), 0)               AS net,
       coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'S'), 0)
         - coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'R'), 0)    AS instructor_share
  FROM facts
 GROUP BY ROLLUP (course_id);

-- ListRecentSales (no buyer PII), keyset on (paid_at, line id)
SELECT l.id, o.paid_at, o.paid_at::text AS cursor_at, l.course_title, l.final_amount, l.instructor_share_amount,
       c.code AS coupon_code,
       EXISTS (SELECT 1 FROM commerce.refunds r WHERE r.order_line_id = l.id AND r.status = 'SUCCEEDED') AS refunded
  FROM commerce.order_lines l
  JOIN commerce.orders o ON o.id = l.order_id
  LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
 WHERE l.instructor_id = $instructor_id AND o.paid_at IS NOT NULL
   AND (o.paid_at, l.id) < ($cursor_at::timestamptz, $cursor_id::uuid)    -- omitted on page 1
 ORDER BY o.paid_at DESC, l.id DESC
 LIMIT $limit;
```

### 8.7 Ledger reconciliation (integration tests after the worker drains; ops with `paid_at < now() - interval '1 hour'`)

```sql
-- 1. differences per fact; an empty result means the ledger equals commerce
WITH paid_lines AS (
  SELECT l.id AS order_line_id, l.instructor_id, l.final_amount, l.instructor_share_amount, l.platform_share_amount
    FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
   WHERE o.paid_at IS NOT NULL AND l.final_amount > 0),
succ_refunds AS (
  SELECT r.id AS refund_id, r.order_line_id
    FROM commerce.refunds r JOIN commerce.orders o ON o.id = r.order_id
   WHERE r.status = 'SUCCEEDED' AND o.paid_at IS NOT NULL),
legs AS (
  SELECT e.kind, e.order_line_id, e.refund_id,
         coalesce(sum(p.amount) FILTER (WHERE a.type = 'PROVIDER_CLEARING'), 0)  AS clearing,
         coalesce(sum(p.amount) FILTER (WHERE a.type = 'INSTRUCTOR_PAYABLE'), 0) AS payable,
         coalesce(sum(p.amount) FILTER (WHERE a.type = 'PLATFORM_REVENUE'), 0)   AS revenue,
         min(a.owner_id::text) FILTER (WHERE a.type = 'INSTRUCTOR_PAYABLE')      AS payee
    FROM payouts.journal_entries e
    JOIN payouts.postings p ON p.entry_id = e.id
    JOIN payouts.accounts a ON a.id = p.account_id
   GROUP BY e.kind, e.order_line_id, e.refund_id)
SELECT 'SALE' AS kind, pl.order_line_id, NULL::uuid AS refund_id, 'missing or wrong' AS problem
  FROM paid_lines pl
  LEFT JOIN legs g ON g.kind = 'SALE' AND g.order_line_id = pl.order_line_id
 WHERE g.order_line_id IS NULL
    OR g.clearing <> pl.final_amount OR g.payable <> -pl.instructor_share_amount OR g.revenue <> -pl.platform_share_amount
    OR (pl.instructor_share_amount > 0 AND g.payee IS DISTINCT FROM pl.instructor_id::text)
UNION ALL
SELECT 'REFUND', sr.order_line_id, sr.refund_id, 'missing or wrong'
  FROM succ_refunds sr
  JOIN paid_lines pl ON pl.order_line_id = sr.order_line_id
  LEFT JOIN legs g ON g.kind = 'REFUND' AND g.refund_id = sr.refund_id
 WHERE g.refund_id IS NULL
    OR g.clearing <> -pl.final_amount OR g.payable <> pl.instructor_share_amount OR g.revenue <> pl.platform_share_amount
UNION ALL
SELECT g.kind, g.order_line_id, g.refund_id, 'entry without a commerce fact'
  FROM legs g
 WHERE (g.kind = 'SALE'   AND NOT EXISTS (SELECT 1 FROM paid_lines pl WHERE pl.order_line_id = g.order_line_id))
    OR (g.kind = 'REFUND' AND NOT EXISTS (SELECT 1 FROM succ_refunds sr WHERE sr.refund_id = g.refund_id));

-- 2. totals (the D13 statement): sum of SALE clearing = sum of paid finals; sum of REFUND clearing = -sum of SUCCEEDED refunds
SELECT
  (SELECT coalesce(sum(p.amount), 0) FROM payouts.postings p JOIN payouts.journal_entries e ON e.id = p.entry_id
     JOIN payouts.accounts a ON a.id = p.account_id WHERE e.kind = 'SALE' AND a.type = 'PROVIDER_CLEARING')   AS ledger_sales,
  (SELECT coalesce(sum(l.final_amount), 0) FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
    WHERE o.paid_at IS NOT NULL)                                                                               AS commerce_sales,
  (SELECT coalesce(-sum(p.amount), 0) FROM payouts.postings p JOIN payouts.journal_entries e ON e.id = p.entry_id
     JOIN payouts.accounts a ON a.id = p.account_id WHERE e.kind = 'REFUND' AND a.type = 'PROVIDER_CLEARING') AS ledger_refunds,
  (SELECT coalesce(sum(r.amount), 0) FROM commerce.refunds r JOIN commerce.orders o ON o.id = r.order_id
    WHERE r.status = 'SUCCEEDED' AND o.paid_at IS NOT NULL)                                                    AS commerce_refunds;
```

### 8.8 Enrollment ↔ commerce consistency (tests and ops)

```sql
-- ORDER enrollments whose line is not a paid line of the same user and course
SELECT e.id FROM enrollment.enrollments e
 WHERE e.source = 'ORDER'
   AND NOT EXISTS (SELECT 1 FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
                    WHERE l.id = e.order_line_id AND o.user_id = e.user_id AND l.course_id = e.course_id
                      AND o.paid_at IS NOT NULL);
-- ACTIVE ORDER enrollment whose line has a SUCCEEDED or APPROVED refund (should have been revoked at approval)
SELECT e.id FROM enrollment.enrollments e JOIN commerce.refunds r ON r.order_line_id = e.order_line_id
 WHERE e.status = 'ACTIVE' AND r.status IN ('APPROVED','SUBMITTED','SUCCEEDED');
```

---

## 9. Constraint → domain error code (for nestjs-coder)

`err.constraint` is the constraint, index or pseudo-constraint name. Deferred names surface at COMMIT.

**Pricing**

| Constraint (SQLSTATE)                                          | Domain error                     |
| -------------------------------------------------------------- | -------------------------------- |
| `course_prices_amount_ck`, `course_prices_currency_ck` (23514) | `price_not_allowed` 422          |
| `course_prices_noop_update_ck`, `course_prices_immutable_ck`   | 500 (use the IS DISTINCT upsert) |

**Coupons**

| Constraint (SQLSTATE)                                                                                            | Domain error                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `coupons_course_id_code_uq` (23505)                                                                              | `coupon_code_taken` 409                                                                                 |
| `coupons_window_ck`, `_percent_off_ck`, `_amount_off_ck`, `_max_redemptions_ck`, `_code_ck`, `_platform_type_ck` | `validation_failed` 422 (the app validates first)                                                       |
| `coupons_immutable_ck`                                                                                           | 500 (deactivate with `WHERE deactivated_at IS NULL`)                                                    |
| `carts_coupon_code_ck`                                                                                           | `coupon_invalid` 422                                                                                    |
| `coupon_redemptions_coupon_id_user_id_active_uq` (23505)                                                         | `coupon_already_used` 422; in Checkout, 409 `price_changed` plus the fresh quote                        |
| `coupon_redemptions_limit_ck`                                                                                    | `coupon_exhausted` 422; in Checkout, 409 `price_changed` plus the quote                                 |
| `coupon_redemptions_coupon_valid_ck`                                                                             | in Checkout, 409 `price_changed` plus the quote (the quote explains: expired, not started, deactivated) |
| `coupon_redemptions_transition_ck`, `coupon_redemptions_order_status_ck`, `coupon_redemptions_unused_ck`         | 500                                                                                                     |

**Orders and checkout**

| Constraint (SQLSTATE)                                                                                                                             | Domain error                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `orders_user_id_idempotency_key_uq` (23505)                                                                                                       | resume path (re-read by key); a different fingerprint gives `idempotency_key_reused` 422 |
| `orders_user_id_pending_uq` (23505)                                                                                                               | `checkout_in_progress` 409 (re-read `{orderId, checkoutUrl}`)                            |
| `orders_total_amount_ck`                                                                                                                          | `amount_below_minimum` 422 (backstop)                                                    |
| `order_lines_order_id_course_id_uq`                                                                                                               | `cart_changed` 409 (a duplicate line is a programming error, so log it)                  |
| `order_lines_coupon_scope_ck`, `order_lines_discount_ck`, `orders_total_ck`, `orders_zero_total_ck`, `orders_immutable_ck`                        | 500                                                                                      |
| `order_transitions_pk`, `refund_transitions_pk`, `enrollment_transitions_pk` (23505, concurrent seq)                                              | `invalid_state_transition` 409 (impossible under the row lock; log it)                   |
| `order_transitions_edge_ck`, `…_prev_seq_from_status_fk`; the same for refund and enrollment transitions                                          | `invalid_state_transition` 409                                                           |
| `order_transitions_reason_ck`, `refund_transitions_reason_ck`, `enrollment_transitions_admin_ck`, `enrollment_transitions_reason_ck`              | `validation_failed` 422 (admin reason)                                                   |
| `orders_status_log_ck`, `orders_refund_status_ck`, `order_transitions_buyer_actor_ck`, `order_transitions_actor_ck`, `order_transitions_event_ck` | 500                                                                                      |

**Payments and webhooks**

| Constraint (SQLSTATE)                                                                                                                                                                                    | Domain error                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `payments_order_id_amount_currency_fk` (23503), `payments_order_status_ck`, `payments_received_ck`, `payments_transition_ck`, `payments_session_ck`, `payments_checkout_url_ck`, `payments_succeeded_ck` | 500 (webhook: 500, so Stripe retries; log it)                      |
| `payments_checkout_session_id_uq`, `payments_payment_intent_id_uq`                                                                                                                                       | 500 (provider id reused)                                           |
| `provider_events_pk`                                                                                                                                                                                     | never surfaces (`ON CONFLICT DO NOTHING`, so a duplicate gets 200) |

**Refunds**

| Constraint (SQLSTATE)                                                                                                                                                                                  | Domain error                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `refunds_order_line_id_live_uq` (23505)                                                                                                                                                                | `refund_already_requested` 409 (also on RetryRefund when another live refund exists)       |
| `refunds_order_id_order_line_id_amount_fk` (23503)                                                                                                                                                     | `refund_not_found` / 404 (line not in this order; the app resolves within the order first) |
| `refunds_order_status_ck`                                                                                                                                                                              | `refund_not_applicable` 422                                                                |
| `refunds_reason_code_ck`, `refunds_comment_ck`                                                                                                                                                         | `validation_failed` 422                                                                    |
| `refunds_immutable_ck`, `refunds_transition_ck`, `refunds_status_log_ck`, `refund_transitions_actor_ck`, `refund_transitions_admin_actor_ck`, `refund_transitions_provider_ck`, `refunds_*_ck` (shape) | 500                                                                                        |
| `refunds_provider_refund_id_uq`                                                                                                                                                                        | 500 (webhook: log; the outcome is ORPHAN only after a successful rollback-free lookup)     |

**Enrollments**

| Constraint (SQLSTATE)                                                       | Domain error                           |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `enrollments_user_id_course_id_uq`                                          | handled by the upsert (never surfaces) |
| `enrollments_status_log_ck`, `enrollments_immutable_ck`, `enrollments_*_ck` | 500                                    |

**Ledger** (worker)

| Constraint (SQLSTATE)                                                                                                              | Domain error                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `journal_entries_kind_order_line_id_refund_id_uq`, `journal_entries_order_line_id_refund_uq`, `accounts_type_owner_id_currency_uq` | no-op (`ON CONFLICT DO NOTHING`, then skip or re-select)                           |
| `journal_entries_sale_missing_ck`                                                                                                  | **retryable** (the worker throws its retryable error; the SALE is still in flight) |
| `postings_balanced_ck`, `journal_entries_mirror_ck`, `postings_*_currency_fk`                                                      | non-retryable, to the DLQ, plus an alert                                           |

**Other**

| Constraint (SQLSTATE)                                      | Domain error                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `cart_items_user_id_fk` (23503)                            | 500 (ensure the cart row first)                                   |
| 42501 from append-only, provider_events or attempts guards | 500                                                               |
| 40P01 / 40001                                              | retry the transaction once (shouldn't happen with the lock order) |

---

## Hand-off to sql-ops (P4-T6)

1. **Create the migration file.** It is `packages/db/src/migrations/2026_10_xx_0004_commerce_enrollment_payouts.ts`, in the 0003 style (`Kysely<any>`, one `sql` per statement, grouped arrays, `run()`), in the exact order of §1.
   - Register it in `migrations/index.ts`.
   - Write `down()` in the §1 down order.
   - Extend the codegen `--overrides` as in §7, then run `pnpm --filter @udemy/db codegen`.
2. **PG 18 checks first** (fail fast; the fallbacks are noted):
   - (a) `refunds_order_id_order_line_id_amount_fk` onto STORED `final_amount` is accepted, and a wrong amount or a line from another order is rejected. Fallback: §6, first block.
   - (b) The `prev_seq` STORED generated chain FKs are accepted (same pattern as `categories`).
   - (c) `ON CONFLICT (user_id, course_id)` infers the `INCLUDE (status)` unique. Fallback: drop the `INCLUDE`.
   - (d) `RETURNING old.status` on the enrollment upsert returns NULL for an insert and 'REVOKED' for a regrant.
   - (e) In a BEFORE INSERT trigger on `order_lines`, `NEW.final_amount` is NULL. This confirms the guard must not read it.
3. **Integration tests, at minimum:**
   - **Rounding (table-driven):** final / instructor / platform for bps ∈ {0, 1, 7000, 9999, 10000} and amounts {0.01, 0.05, 19.99, 0.50, 9999.99}. Check shares ≥ 0, sum = final and half-up at .xx5. Also check `coupon_discount` (PERCENT 1/33/50/100, AMOUNT > list).
   - **Totals and payments:** a total ≠ Σ lines fails at COMMIT; a payment amount ≠ total fails the FK; an order with total 0.30 fails; a payment on a zero-total order fails at COMMIT.
   - **Coupons, under concurrency:** 20 parallel reservations against `max_redemptions=1` give exactly 1; a deactivation racing a reservation gives one consistent outcome; the per-user unique holds; a late RELEASED→CONSUMED succeeds while the same user holds a newer RESERVED redemption (item 2).
   - **Line checks:** a wrong discount or a foreign-course coupon fails; a redemption not used by a line fails at COMMIT.
   - **Order transitions:** an illegal edge, a wrong `from_status` (chain FK) and a duplicate seq all fail; a status change without a transition fails `orders_status_log_ck`; PAID with a received mismatch fails `payments_received_ck`, but succeeds via PAYMENT_REVIEW → ADMIN.
   - **Refunds:** one live refund per line, including a race between two connections; a refund on a PENDING order fails; a full-line amount mismatch fails; REFUNDED with Σ ≠ total fails at COMMIT; the `attempt` guard holds; the status↔log check holds.
   - **Enrollments:** grant, revoke and regrant via the upsert; an admin revoke without a reason fails; status↔log holds.
   - **Ledger:** an unbalanced entry fails; a currency mismatch fails the FK; a REFUND without a SALE raises `journal_entries_sale_missing_ck`; a non-mirror REFUND fails; a second REFUND for a line fails; a multi-line SALE with the same `source_event_id` succeeds.
   - **Append-only and guards:** UPDATE/DELETE/TRUNCATE on every append-only table give 42501; the `provider_events` second outcome update fails.
4. **Pass §8 and §9 to nestjs-coder:**
   - T13 (quote and coupons)
   - T15 (checkout, PAID, cancel, reconcile)
   - T16 (refunds, dispatcher, sales)
   - T12 (enrollment upsert and transitions)
   - T14 (ledger writer: `ON CONFLICT DO NOTHING` with no target, sale-missing is retryable, ignore `RefundSucceeded` with `orderWasPaid=false`)
5. **Tell nestjs-coder and devops-config about these behaviour changes vs design §5/§6:**
   - transition inserts use `max(seq)+1` under the row lock
   - `session_expires_at` is stored in tx A and sent verbatim, with a TTL of 35 min or more
   - the advisory keys are `_03` (dispatch) and `_04` (reconcile)
   - RequestRefund takes the cart lock first
   - the dispatcher's tx2 locks the order before the refund
   - the PAYMENT_REVIEW → REFUNDED path releases redemptions
   - `RefundSucceeded` gains `orderWasPaid` (P4-T2)
   - all timestamps use SQL `now()`
   - commerce runs at READ COMMITTED
