import { type Kysely, type RawBuilder, sql } from 'kysely';

/**
 * Phase 4: commerce / enrollment / payouts (tables only; the three schemas come from 0001).
 *
 * Source of truth: docs/phase-4-schema-design.md §1 (DDL, in its order, verbatim), §4
 * (privileges). One `sql` per statement; raw SQL throughout because it uses STORED generated
 * columns as FK targets and keys, NULLS NOT DISTINCT and partial uniques, deferred constraint
 * triggers and PL/pgSQL.
 *
 * PG 18 behaviour this relies on (probed on 18.6 in a throwaway database before writing it,
 * see the P4-T6 report):
 * - (a) `refunds_order_id_order_line_id_amount_fk` onto the STORED generated
 *   `order_lines.final_amount` is accepted and enforced (wrong amount / line of another order
 *   -> 23503). A VIRTUAL column is rejected, so every generated column here says STORED.
 * - (b) the `prev_seq` STORED generated chain FKs reject a wrong `from_status` and a seq gap.
 * - (c) `ON CONFLICT (user_id, course_id)` infers `enrollments_user_id_course_id_uq` despite
 *   its `INCLUDE (status)`.
 * - (d) `RETURNING old.status` is NULL for the insert arm of an upsert and the old value for the
 *   update arm (no row when the `DO UPDATE ... WHERE` is false).
 * - (e) BEFORE ROW triggers see NULL for stored generated columns, so
 *   `order_lines_coupon_guard()` never reads `NEW.final_amount`.
 * So none of the §6 fallbacks (refunds_amount_guard trigger, dropping the INCLUDE) is used.
 *
 * Reuses public.set_updated_at() (0001), public.forbid_append_only_mutation() (0002) and
 * public.forbid_row_change() (0003). Append-only tables are guarded by triggers, which also bind
 * superusers; DROP TABLE is not blocked by them, so down() works.
 *
 * Every commerce / enrollment / payouts transaction must run at READ COMMITTED: the coupon
 * reservation trigger and the lock-then-count steps need a fresh snapshot per statement
 * (schema doc §6, race R1).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(db: Kysely<any>, statements: RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) {
    await statement.execute(db);
  }
}

// ---------------------------------------------------------------------------
// 0. Shared commerce helper: the single rounding authority for coupon discounts.
// ---------------------------------------------------------------------------
const helpers = [
  // Called by the quote SQL (§8.1) and by the order_lines guard (below).
  sql`
    CREATE FUNCTION commerce.coupon_discount(p_list numeric, p_type text, p_percent_off smallint, p_amount_off numeric)
    RETURNS numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN CASE p_type
             WHEN 'PERCENT' THEN round(p_list * p_percent_off / 100, 2)   -- numeric round = half away from zero = half-up for >= 0
             WHEN 'AMOUNT'  THEN least(p_amount_off, p_list)               -- floored at 0 (final = list - discount >= 0)
           END
  `,
  sql`
    COMMENT ON FUNCTION commerce.coupon_discount(numeric, text, smallint, numeric) IS
      'Discount of one coupon on one list price (D3/D5). Half-up percent to 2 decimals; AMOUNT capped at list. The Money VO in contracts must property-test equal to this.'
  `,
];

// ---------------------------------------------------------------------------
// 1. commerce.course_prices + append-only history (D2)
// ---------------------------------------------------------------------------
const coursePrices = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER course_prices_immutable_trg BEFORE UPDATE ON commerce.course_prices
      FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
      EXECUTE FUNCTION public.forbid_row_change('course_prices_immutable_ck', 'course_prices.course_id/created_at are immutable')
  `,
  // Every UPDATE must change the price, so every row version has exactly one history row
  sql`
    CREATE TRIGGER course_prices_noop_update_trg BEFORE UPDATE ON commerce.course_prices
      FOR EACH ROW WHEN ((OLD.amount, OLD.currency) IS NOT DISTINCT FROM (NEW.amount, NEW.currency))
      EXECUTE FUNCTION public.forbid_row_change('course_prices_noop_update_ck', 'a course price update must change amount or currency')
  `,
  sql`
    CREATE TRIGGER course_prices_set_updated_at_trg BEFORE UPDATE ON commerce.course_prices
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
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
    )
  `,
  // GetCoursePricing history (last 20, previous amount via lag()) + the 10/day check (ops; the rate limit itself is Redis)
  sql`CREATE INDEX course_price_changes_course_id_changed_at_idx ON commerce.course_price_changes (course_id, changed_at DESC, id DESC)`,
  sql`
    CREATE TRIGGER course_price_changes_append_only_trg BEFORE UPDATE OR DELETE ON commerce.course_price_changes
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER course_price_changes_no_truncate_trg BEFORE TRUNCATE ON commerce.course_price_changes
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE FUNCTION commerce.course_prices_record_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO commerce.course_price_changes (course_id, amount, currency, changed_by, changed_at)
      VALUES (NEW.course_id, NEW.amount, NEW.currency, NEW.updated_by, NEW.updated_at);
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE TRIGGER course_prices_record_change_trg AFTER INSERT OR UPDATE ON commerce.course_prices
      FOR EACH ROW EXECUTE FUNCTION commerce.course_prices_record_change()
  `,
  sql`
    COMMENT ON TABLE commerce.course_prices IS
      'Current price per course (D2). Materialised latest row of course_price_changes, written in the same statement by course_prices_record_change_trg; history cannot be skipped. No row = not for sale (D16). Never deleted (0.00 = free).'
  `,
  sql`
    COMMENT ON TABLE commerce.course_price_changes IS
      'Append-only price history. previous amount = lag(amount) OVER (PARTITION BY course_id ORDER BY changed_at, id); the event payload uses RETURNING old.amount of the upsert.'
  `,
];

// ---------------------------------------------------------------------------
// 2. commerce.carts / cart_items (D4)
// ---------------------------------------------------------------------------
const carts = [
  sql`
    CREATE TABLE commerce.carts (
      user_id     uuid        NOT NULL,
      coupon_code text        NULL,           -- user input, stored uppercased; not an FK (may match nothing)
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT carts_pk             PRIMARY KEY (user_id),
      CONSTRAINT carts_user_id_fk     FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
      CONSTRAINT carts_coupon_code_ck CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9_-]{4,20}$')
    )
  `,
  sql`
    CREATE TRIGGER carts_set_updated_at_trg BEFORE UPDATE ON commerce.carts
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    COMMENT ON TABLE commerce.carts IS
      'Server cart (signed-in users). The row is also the per-user commerce mutex (lock order step 1, §6): checkout, the PAID transition, cancel and refund requests lock it FOR UPDATE first.'
  `,
  sql`
    CREATE TABLE commerce.cart_items (
      user_id   uuid        NOT NULL,
      course_id uuid        NOT NULL,         -- soft ref (D12)
      added_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cart_items_pk         PRIMARY KEY (user_id, course_id),    -- add = ON CONFLICT DO NOTHING; also inCart lookups
      CONSTRAINT cart_items_user_id_fk FOREIGN KEY (user_id) REFERENCES commerce.carts (user_id) ON DELETE CASCADE
    )
  `,
  sql`COMMENT ON TABLE commerce.cart_items IS 'At most COMMERCE_CART_MAX_ITEMS (20) per cart, enforced by the app under the cart row lock.'`,
];

// ---------------------------------------------------------------------------
// 3. commerce.coupons (immutable terms, D5)
// ---------------------------------------------------------------------------
const coupons = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER coupons_immutable_trg BEFORE UPDATE ON commerce.coupons
      FOR EACH ROW WHEN (
           (OLD.id, OLD.scope, OLD.course_id, OLD.code, OLD.discount_type, OLD.percent_off, OLD.amount_off, OLD.currency,
            OLD.starts_at, OLD.ends_at, OLD.max_redemptions, OLD.created_by, OLD.created_at)
           IS DISTINCT FROM
           (NEW.id, NEW.scope, NEW.course_id, NEW.code, NEW.discount_type, NEW.percent_off, NEW.amount_off, NEW.currency,
            NEW.starts_at, NEW.ends_at, NEW.max_redemptions, NEW.created_by, NEW.created_at)
        OR OLD.deactivated_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('coupons_immutable_ck', 'coupon terms are immutable; only one deactivation is allowed')
  `,
  sql`
    COMMENT ON TABLE commerce.coupons IS
      'Course (instructor) and platform (admin) coupons. Terms immutable; state (SCHEDULED/ACTIVE/EXHAUSTED/EXPIRED/DEACTIVATED) is derived. Codes are never reusable within a course. <= 10 active per course: app, under the course_prices row lock.'
  `,
  sql`COMMENT ON COLUMN commerce.coupons.code IS 'Uppercase ASCII (app normalises). text + CHECK instead of citext: the alphabet is ASCII so the CHECK is exact, and citext would make ~ and LIKE case-insensitive.'`,
];

// ---------------------------------------------------------------------------
// 4. commerce.orders
// ---------------------------------------------------------------------------
const orders = [
  sql`
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
    )
  `,
  // D15: at most one open checkout per user (23505 -> checkout_in_progress)
  sql`CREATE UNIQUE INDEX orders_user_id_pending_uq ON commerce.orders (user_id) WHERE status = 'PENDING_PAYMENT'`,
  // ListMyOrders keyset: WHERE user_id=$1 AND (placed_at,id) < ($c,$id) ORDER BY placed_at DESC, id DESC
  sql`CREATE INDEX orders_user_id_placed_at_id_idx ON commerce.orders (user_id, placed_at DESC, id DESC)`,
  // Admin order list (default order, optional from/to on placed_at)
  sql`CREATE INDEX orders_placed_at_id_idx ON commerce.orders (placed_at DESC, id DESC)`,
  // Admin order list filtered by status
  sql`CREATE INDEX orders_status_placed_at_id_idx ON commerce.orders (status, placed_at DESC, id DESC)`,
  sql`
    CREATE TRIGGER orders_set_updated_at_trg BEFORE UPDATE ON commerce.orders
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER orders_immutable_trg BEFORE UPDATE ON commerce.orders
      FOR EACH ROW WHEN (
           (OLD.id, OLD.user_id, OLD.currency, OLD.total_amount, OLD.idempotency_key, OLD.request_fingerprint, OLD.placed_at)
           IS DISTINCT FROM
           (NEW.id, NEW.user_id, NEW.currency, NEW.total_amount, NEW.idempotency_key, NEW.request_fingerprint, NEW.placed_at)
        OR (OLD.paid_at   IS NOT NULL AND NEW.paid_at   IS DISTINCT FROM OLD.paid_at)
        OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at))
      EXECUTE FUNCTION public.forbid_row_change('orders_immutable_ck', 'order identity/money columns are immutable; paid_at/closed_at are set once')
  `,
  sql`
    COMMENT ON TABLE commerce.orders IS
      'The commercial fact (D6). status/placed_at/paid_at/closed_at materialise order_transitions (orders_status_log_ck); total = sum of line finals (orders_total_ck); status agrees with SUCCEEDED refunds (orders_refund_status_ck), payment (payments_order_status_ck) and redemptions (coupon_redemptions_order_status_ck); all checked at COMMIT. Never deleted.'
  `,
  sql`COMMENT ON COLUMN commerce.orders.paid_at IS 'When the order was accepted as paid (enrollments granted). PAYMENT_REVIEW has none; the provider capture time is payments.succeeded_at. Refund window starts here.'`,
  sql`COMMENT ON COLUMN commerce.orders.request_fingerprint IS 'SHA-256 of the quote fingerprint (sorted courseId:final pairs, coupon id, currency). Same Idempotency-Key with another fingerprint -> idempotency_key_reused.'`,
];

// ---------------------------------------------------------------------------
// 5. commerce.coupon_redemptions (D7). Reservation authority lives in its BEFORE INSERT trigger.
// ---------------------------------------------------------------------------
const couponRedemptions = [
  sql`
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
    )
  `,
  // One live redemption per user per coupon (23505 -> coupon_already_used). A late re-consumption (released_at set)
  // is excluded, otherwise a late payment could collide with a newer redemption and the webhook would fail forever (§6 R1).
  sql`
    CREATE UNIQUE INDEX coupon_redemptions_coupon_id_user_id_active_uq
      ON commerce.coupon_redemptions (coupon_id, user_id) WHERE status IN ('RESERVED','CONSUMED') AND released_at IS NULL
  `,
  // max_redemptions count + "already used by me" (quote and trigger), index-only
  sql`
    CREATE INDEX coupon_redemptions_coupon_id_counted_idx
      ON commerce.coupon_redemptions (coupon_id) INCLUDE (user_id) WHERE status IN ('RESERVED','CONSUMED')
  `,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER coupon_redemptions_reserve_trg BEFORE INSERT ON commerce.coupon_redemptions
      FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_reserve_guard()
  `,
  sql`
    CREATE TRIGGER coupon_redemptions_transition_trg BEFORE UPDATE ON commerce.coupon_redemptions
      FOR EACH ROW WHEN (
           (OLD.order_id, OLD.coupon_id, OLD.user_id, OLD.reserved_at) IS DISTINCT FROM (NEW.order_id, NEW.coupon_id, NEW.user_id, NEW.reserved_at)
        OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
        OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
        OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
              (OLD.status = 'RESERVED' AND NEW.status IN ('CONSUMED','RELEASED'))
           OR (OLD.status = 'RELEASED' AND NEW.status = 'CONSUMED'))))
      EXECUTE FUNCTION public.forbid_row_change('coupon_redemptions_transition_ck', 'illegal coupon redemption transition')
  `,
  sql`
    CREATE TRIGGER coupon_redemptions_no_truncate_trg BEFORE TRUNCATE ON commerce.coupon_redemptions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE commerce.coupon_redemptions IS
      'One row per (order, coupon). RESERVED at checkout, CONSUMED at PAID, RELEASED at EXPIRED/CANCELED, RELEASED->CONSUMED on a late payment (counted, may overshoot max_redemptions; accepted, D7). Validity and the limit are enforced by coupon_redemptions_reserve_trg under the coupon row lock. Status agrees with the order status at COMMIT.'
  `,
];

// ---------------------------------------------------------------------------
// 6. commerce.order_lines (immutable snapshot; generated money in one SQL rounding authority, D3/D6)
// ---------------------------------------------------------------------------
const orderLines = [
  sql`
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
    )
  `,
  // Instructor sales summary / recent sales; FK index for instructor_id
  sql`CREATE INDEX order_lines_instructor_id_order_id_idx ON commerce.order_lines (instructor_id, order_id)`,
  // Admin order search by courseId; P6 analytics
  sql`CREATE INDEX order_lines_course_id_idx ON commerce.order_lines (course_id)`,
  // Coupon scope + discount math backstop. BEFORE triggers must not read NEW.final_amount: stored generated
  // columns are computed after BEFORE ROW triggers.
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER order_lines_coupon_trg BEFORE INSERT ON commerce.order_lines
      FOR EACH ROW EXECUTE FUNCTION commerce.order_lines_coupon_guard()
  `,
  sql`
    CREATE TRIGGER order_lines_append_only_trg BEFORE UPDATE OR DELETE ON commerce.order_lines
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER order_lines_no_truncate_trg BEFORE TRUNCATE ON commerce.order_lines
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE commerce.order_lines IS
      'What was sold, forever (D6/D13). Insert-only. final/instructor/platform shares are STORED generated: the DB is the only rounding authority; instructor + platform = final exactly; both >= 0 because bps <= 10000.'
  `,
  sql`COMMENT ON COLUMN commerce.order_lines.final_amount IS 'Generated (list - discount). FK target of refunds.amount (full-line refunds only). Never written by the app.'`,
];

// ---------------------------------------------------------------------------
// 7. commerce.provider_events (webhook claim + dedupe, D10). No payload (PII).
// ---------------------------------------------------------------------------
const providerEvents = [
  sql`
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
    )
  `,
  // Admin order detail: provider events of an order
  sql`CREATE INDEX provider_events_order_id_idx ON commerce.provider_events (order_id) WHERE order_id IS NOT NULL`,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER provider_events_guard_trg BEFORE UPDATE OR DELETE ON commerce.provider_events
      FOR EACH ROW EXECUTE FUNCTION commerce.provider_events_guard()
  `,
  sql`
    CREATE TRIGGER provider_events_no_truncate_trg BEFORE TRUNCATE ON commerce.provider_events
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE commerce.provider_events IS
      'Webhook inbox. Claim (INSERT ON CONFLICT DO NOTHING), apply, outbox and outcome happen in ONE transaction; a concurrent duplicate blocks on the PK and then sees the conflict. One finish update (processed_at, outcome, order_id NULL->value), as in media.transcode_attempts. No payload stored (PII). Reconciler events use synthetic ids.'
  `,
];

// ---------------------------------------------------------------------------
// 8. commerce.order_transitions (append-only, linear chain per order via seq)
// ---------------------------------------------------------------------------
const orderTransitions = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER order_transitions_append_only_trg BEFORE UPDATE OR DELETE ON commerce.order_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER order_transitions_no_truncate_trg BEFORE TRUNCATE ON commerce.order_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE commerce.order_transitions IS
      'Append-only order log. seq is contiguous per order (chain FK: from_status = predecessor.to_status), read as max(seq)+1 under the order row lock. Kept forever.'
  `,
];

// ---------------------------------------------------------------------------
// 9. commerce.payments (one Checkout Session per order, D6)
// ---------------------------------------------------------------------------
const payments = [
  sql`
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
    )
  `,
  // Reconcile (a): CREATING older than 15 min
  sql`CREATE INDEX payments_created_at_creating_idx ON commerce.payments (created_at) WHERE status = 'CREATING'`,
  // Reconcile (b): OPEN sessions expired more than 10 min ago
  sql`CREATE INDEX payments_session_expires_at_open_idx ON commerce.payments (session_expires_at) WHERE status = 'OPEN'`,
  sql`
    CREATE TRIGGER payments_set_updated_at_trg BEFORE UPDATE ON commerce.payments
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER payments_status_insert_trg BEFORE INSERT ON commerce.payments
      FOR EACH ROW WHEN (NEW.status <> 'CREATING')
      EXECUTE FUNCTION public.forbid_row_change('payments_transition_ck', 'a payment must be created CREATING')
  `,
  sql`
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
      EXECUTE FUNCTION public.forbid_row_change('payments_transition_ck', 'illegal payment transition or immutable payment column changed')
  `,
  sql`
    COMMENT ON TABLE commerce.payments IS
      'Checkout Session of an order with total > 0 (1:1, PK = order_id). Amount/currency pinned to the order by composite FK. received_* = what the provider says was charged; PAID requires received = total unless the order went through PAYMENT_REVIEW (payments_received_ck). History lives in order_transitions + provider_events.'
  `,
];

// ---------------------------------------------------------------------------
// 10. commerce.refunds + refund_transitions (D11)
// ---------------------------------------------------------------------------
const refunds = [
  sql`
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
    )
  `,
  // One live refund per line (23505 -> refund_already_requested). Covers "one SUCCEEDED per line" (SUCCEEDED is terminal and live).
  sql`CREATE UNIQUE INDEX refunds_order_line_id_live_uq ON commerce.refunds (order_line_id) WHERE status NOT IN ('REJECTED','FAILED')`,
  // Dispatcher lease: WHERE status='APPROVED' ORDER BY approved_at, id FOR UPDATE SKIP LOCKED
  sql`CREATE INDEX refunds_approved_at_id_dispatch_idx ON commerce.refunds (approved_at, id) WHERE status = 'APPROVED'`,
  // Admin queues (REQUESTED / FAILED) keyset on (created_at, id)
  sql`CREATE INDEX refunds_status_created_at_id_idx ON commerce.refunds (status, created_at, id)`,
  // D11 abuse rule: refunds by user in the last 90 days
  sql`CREATE INDEX refunds_user_id_created_at_idx ON commerce.refunds (user_id, created_at)`,
  // Order detail (refunds of an order) + the order FKs
  sql`CREATE INDEX refunds_order_id_idx ON commerce.refunds (order_id)`,
  sql`
    CREATE TRIGGER refunds_set_updated_at_trg BEFORE UPDATE ON commerce.refunds
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER refunds_immutable_trg BEFORE UPDATE ON commerce.refunds
      FOR EACH ROW WHEN (
           (OLD.id, OLD.order_id, OLD.order_line_id, OLD.user_id, OLD.amount, OLD.initiated_by, OLD.reason_code, OLD.comment, OLD.created_at)
           IS DISTINCT FROM
           (NEW.id, NEW.order_id, NEW.order_line_id, NEW.user_id, NEW.amount, NEW.initiated_by, NEW.reason_code, NEW.comment, NEW.created_at)
        OR (OLD.succeeded_at IS NOT NULL AND NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at)
        OR ((NEW.attempt IS DISTINCT FROM OLD.attempt OR (OLD.status = 'FAILED' AND NEW.status = 'APPROVED'))
            AND NOT (OLD.status = 'FAILED' AND NEW.status = 'APPROVED' AND NEW.attempt = OLD.attempt + 1)))
      EXECUTE FUNCTION public.forbid_row_change('refunds_immutable_ck', 'refund identity is immutable; attempt only increments on FAILED -> APPROVED')
  `,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER refunds_insert_trg BEFORE INSERT ON commerce.refunds
      FOR EACH ROW EXECUTE FUNCTION commerce.refunds_insert_guard()
  `,
  sql`
    CREATE TRIGGER refunds_no_truncate_trg BEFORE TRUNCATE ON commerce.refunds
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE commerce.refunds IS
      'Per-line full refunds. status/approved_at/succeeded_at/attempt/created_at materialise refund_transitions (refunds_status_log_ck, COMMIT). One live refund per line. Provider calls are made only by the API dispatcher (D9), idempotency key refund:{id}:{attempt}.'
  `,
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER refund_transitions_append_only_trg BEFORE UPDATE OR DELETE ON commerce.refund_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER refund_transitions_no_truncate_trg BEFORE TRUNCATE ON commerce.refund_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE commerce.refund_transitions IS 'Append-only refund log (who/when/why, per-attempt provider ids). Linear chain via seq, as order_transitions.'`,
];

// ---------------------------------------------------------------------------
// 11. Commerce deferred consistency triggers (checked at COMMIT)
// ---------------------------------------------------------------------------
const deferredGuards = [
  // 11a. total = sum of line finals, >= 1 line
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER orders_total_trg AFTER INSERT ON commerce.orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_total_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER order_lines_total_trg AFTER INSERT ON commerce.order_lines
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_total_guard()
  `,
  // 11b. status/placed_at/paid_at/closed_at == log; status agrees with SUCCEEDED refunds; transition actors
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER orders_status_log_trg
      AFTER INSERT OR UPDATE OF status, placed_at, paid_at, closed_at ON commerce.orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER order_transitions_status_log_trg AFTER INSERT ON commerce.order_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER refunds_order_status_log_trg AFTER INSERT OR UPDATE OF status ON commerce.refunds
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.orders_status_log_guard()
  `,
  // 11c. payment <-> order status; PAID only on matching received amount (unless reviewed)
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER orders_payment_trg AFTER INSERT OR UPDATE OF status ON commerce.orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.payments_order_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER payments_order_trg AFTER INSERT OR UPDATE OF status, received_amount, received_currency ON commerce.payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.payments_order_guard()
  `,
  // 11d. redemption status <-> order status; every redemption is used by >= 1 line
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER orders_redemptions_trg AFTER UPDATE OF status ON commerce.orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_order_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER coupon_redemptions_order_trg AFTER INSERT OR UPDATE OF status ON commerce.coupon_redemptions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.coupon_redemptions_order_guard()
  `,
  // 11e. refund columns == refund log; root actor matches initiated_by
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER refunds_status_log_trg
      AFTER INSERT OR UPDATE OF status, approved_at, succeeded_at, attempt ON commerce.refunds
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.refunds_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER refund_transitions_status_log_trg AFTER INSERT ON commerce.refund_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.refunds_status_log_guard()
  `,
];

// ---------------------------------------------------------------------------
// 12. enrollment.enrollments + enrollment_transitions (D8)
// ---------------------------------------------------------------------------
const enrollments = [
  sql`
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
    )
  `,
  // My learning keyset: WHERE user_id=$1 AND status='ACTIVE' AND (granted_at,id) < (...) ORDER BY granted_at DESC, id DESC
  sql`CREATE INDEX enrollments_user_id_granted_at_id_active_idx ON enrollment.enrollments (user_id, granted_at DESC, id DESC) WHERE status = 'ACTIVE'`,
  // Course enrolment counts (instructor, P5)
  sql`CREATE INDEX enrollments_course_id_active_idx ON enrollment.enrollments (course_id) WHERE status = 'ACTIVE'`,
  sql`
    CREATE TRIGGER enrollments_set_updated_at_trg BEFORE UPDATE ON enrollment.enrollments
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER enrollments_immutable_trg BEFORE UPDATE ON enrollment.enrollments
      FOR EACH ROW WHEN ((OLD.id, OLD.user_id, OLD.course_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.course_id, NEW.created_at))
      EXECUTE FUNCTION public.forbid_row_change('enrollments_immutable_ck', 'enrollments.user_id/course_id/created_at are immutable')
  `,
  sql`
    CREATE TRIGGER enrollments_no_truncate_trg BEFORE TRUNCATE ON enrollment.enrollments
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE enrollment.enrollments IS
      'One row per (user, course), ACTIVE/REVOKED. Survives course archive and instructor bans (D13). status/source/order_line_id/granted_at/revoked_at/revoke_reason/created_at materialise enrollment_transitions (enrollments_status_log_ck, COMMIT). Never deleted.'
  `,
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER enrollment_transitions_append_only_trg BEFORE UPDATE OR DELETE ON enrollment.enrollment_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER enrollment_transitions_no_truncate_trg BEFORE TRUNCATE ON enrollment.enrollment_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER enrollments_status_log_trg
      AFTER INSERT OR UPDATE OF status, source, order_line_id, granted_at, revoked_at, revoke_reason ON enrollment.enrollments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enrollment.enrollments_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER enrollment_transitions_status_log_trg AFTER INSERT ON enrollment.enrollment_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enrollment.enrollments_status_log_guard()
  `,
  sql`COMMENT ON TABLE enrollment.enrollment_transitions IS 'Append-only enrollment log (GRANT/REVOKE/REGRANT, with source, refund and admin reason). Linear chain via seq.'`,
];

// ---------------------------------------------------------------------------
// 13. payouts: double-entry ledger (written by the worker only, D13)
// ---------------------------------------------------------------------------
const payoutsLedger = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER accounts_append_only_trg BEFORE UPDATE OR DELETE ON payouts.accounts
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER accounts_no_truncate_trg BEFORE TRUNCATE ON payouts.accounts
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
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
    )
  `,
  // A line is reversed at most once (one SUCCEEDED refund per line), even if commerce ever misbehaved
  sql`CREATE UNIQUE INDEX journal_entries_order_line_id_refund_uq ON payouts.journal_entries (order_line_id) WHERE kind = 'REFUND'`,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER journal_entries_sale_trg BEFORE INSERT ON payouts.journal_entries
      FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_sale_guard()
  `,
  sql`
    CREATE TRIGGER journal_entries_append_only_trg BEFORE UPDATE OR DELETE ON payouts.journal_entries
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER journal_entries_no_truncate_trg BEFORE TRUNCATE ON payouts.journal_entries
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
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
    )
  `,
  // account_balances view + account FK
  sql`CREATE INDEX postings_account_id_idx ON payouts.postings (account_id)`,
  sql`
    CREATE TRIGGER postings_append_only_trg BEFORE UPDATE OR DELETE ON payouts.postings
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER postings_no_truncate_trg BEFORE TRUNCATE ON payouts.postings
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER journal_entries_balance_trg AFTER INSERT ON payouts.journal_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_balance_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER postings_balance_trg AFTER INSERT ON payouts.postings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payouts.journal_entries_balance_guard()
  `,
  sql`
    CREATE VIEW payouts.account_balances WITH (security_invoker = true) AS
    SELECT a.id AS account_id, a.type, a.owner_id, a.currency,
           coalesce(sum(p.amount), 0) AS balance,
           count(p.entry_id)          AS posting_count
      FROM payouts.accounts a
      LEFT JOIN payouts.postings p ON p.account_id = a.id
     GROUP BY a.id
  `,
  sql`
    COMMENT ON TABLE payouts.journal_entries IS
      'Double-entry journal. SALE: Dr PROVIDER_CLEARING +final, Cr INSTRUCTOR_PAYABLE[instructor] -instructorShare, Cr PLATFORM_REVENUE -platformShare (zero legs omitted; 0.00 lines get no entry). REFUND: exact mirror of the line SALE (journal_entries_mirror_ck). Balanced at COMMIT (postings_balanced_ck). Append-only.'
  `,
  sql`COMMENT ON VIEW payouts.account_balances IS 'Sum of postings per account (debit +). INSTRUCTOR_PAYABLE balances are negative = owed to the instructor.'`,
];

// ---------------------------------------------------------------------------
// 14. Privileges (prod role split; no-op in dev where udemy_app doesn't exist)
// ---------------------------------------------------------------------------
const privileges = [
  sql`
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
    $$
  `,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await run(db, helpers);
  await run(db, coursePrices);
  await run(db, carts);
  await run(db, coupons);
  await run(db, orders);
  await run(db, couponRedemptions);
  await run(db, orderLines);
  await run(db, providerEvents);
  await run(db, orderTransitions);
  await run(db, payments);
  await run(db, refunds);
  await run(db, deferredGuards);
  await run(db, enrollments);
  await run(db, payoutsLedger);
  await run(db, privileges);
}

/**
 * Down order of schema doc §1, no CASCADE (matches 0001-0003): if a later migration still
 * depends on any of these objects, fail loudly instead of silently dropping it.
 * Grants/comments/triggers/indexes go away with their tables and functions. The commerce,
 * enrollment and payouts schemas stay: 0001 owns them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await run(db, [
    // 1. view
    sql`DROP VIEW IF EXISTS payouts.account_balances`,
    // 2. payouts tables, then functions
    sql`DROP TABLE IF EXISTS payouts.postings`,
    sql`DROP TABLE IF EXISTS payouts.journal_entries`,
    sql`DROP TABLE IF EXISTS payouts.accounts`,
    sql`DROP FUNCTION IF EXISTS payouts.journal_entries_balance_guard()`,
    sql`DROP FUNCTION IF EXISTS payouts.journal_entries_sale_guard()`,
    // 3. enrollment tables, then function
    sql`DROP TABLE IF EXISTS enrollment.enrollment_transitions`,
    sql`DROP TABLE IF EXISTS enrollment.enrollments`,
    sql`DROP FUNCTION IF EXISTS enrollment.enrollments_status_log_guard()`,
    // 4. commerce tables (children first)
    sql`DROP TABLE IF EXISTS commerce.refund_transitions`,
    sql`DROP TABLE IF EXISTS commerce.refunds`,
    sql`DROP TABLE IF EXISTS commerce.order_transitions`,
    sql`DROP TABLE IF EXISTS commerce.provider_events`,
    sql`DROP TABLE IF EXISTS commerce.payments`,
    sql`DROP TABLE IF EXISTS commerce.order_lines`,
    sql`DROP TABLE IF EXISTS commerce.coupon_redemptions`,
    sql`DROP TABLE IF EXISTS commerce.orders`,
    sql`DROP TABLE IF EXISTS commerce.coupons`,
    sql`DROP TABLE IF EXISTS commerce.cart_items`,
    sql`DROP TABLE IF EXISTS commerce.carts`,
    sql`DROP TABLE IF EXISTS commerce.course_price_changes`,
    sql`DROP TABLE IF EXISTS commerce.course_prices`,
    // 5. commerce functions
    sql`DROP FUNCTION IF EXISTS commerce.refunds_status_log_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.coupon_redemptions_order_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.payments_order_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.orders_status_log_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.orders_total_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.refunds_insert_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.provider_events_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.order_lines_coupon_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.coupon_redemptions_reserve_guard()`,
    sql`DROP FUNCTION IF EXISTS commerce.course_prices_record_change()`,
    sql`DROP FUNCTION IF EXISTS commerce.coupon_discount(numeric, text, smallint, numeric)`,
  ]);
}
