import type { Executor } from '@udemy/db';

/**
 * The clock for rules evaluated in the app (coupon windows: "starts at most 90 days ahead",
 * "ends in the future", the default `startsAt`). It is the DATABASE clock (`now()`, the
 * transaction start): coupon state is derived by SQL at `now()` and the `coupons_window_ck`
 * CHECK measures against `created_at = now()`, so a host clock that drifts from the DB's
 * (Docker VMs do) would otherwise make a coupon created "now" SCHEDULED, or reject a
 * boundary window that the app accepted.
 */
export abstract class CommerceClock {
  /** `now()` of the executor (inside a transaction: the transaction's start time). */
  abstract now(ex: Executor): Promise<Date>;
}
