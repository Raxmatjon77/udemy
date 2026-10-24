import type {
  OrderStatus,
  RefundInitiator,
  RefundReasonCode,
  RefundStatus,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

/** A refund with what its views and events need (line snapshot, order currency). */
export interface RefundRecord {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: number;
  readonly orderLineId: string;
  /** = `orders.user_id` (pinned by FK): the buyer. */
  readonly userId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly instructorId: string;
  /** The full line amount (`order_lines.final_amount`, pinned by FK). */
  readonly amount: string;
  readonly currency: string;
  readonly status: RefundStatus;
  readonly initiatedBy: RefundInitiator;
  readonly reasonCode: RefundReasonCode;
  readonly comment: string | null;
  readonly attempt: number;
  readonly providerRefundId: string | null;
  readonly failureCode: string | null;
  /** The actor of the first transition: the student, or the admin; null for SYSTEM. */
  readonly requestedBy: string | null;
  /** The reason of the latest REJECTED transition. */
  readonly rejectionReason: string | null;
  /**
   * STUDENT requests: the consumption objection recorded on the first transition (Phase 5 D8,
   * contracts `AdminRefund.reviewReason`); null otherwise.
   */
  readonly reviewReason: string | null;
  readonly createdAt: Date;
  readonly approvedAt: Date | null;
  readonly succeededAt: Date | null;
}

export interface RefundTransitionRecord {
  readonly refundId: string;
  readonly seq: number;
  readonly fromStatus: RefundStatus | null;
  readonly toStatus: RefundStatus;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly providerRefundId: string | null;
  readonly failureCode: string | null;
  readonly providerEventId: string | null;
  readonly occurredAt: Date;
}

export interface NewRefund {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly userId: string;
  readonly amount: string;
  /** REQUESTED (student, needs review) or APPROVED. */
  readonly status: 'REQUESTED' | 'APPROVED';
  readonly initiatedBy: Exclude<RefundInitiator, 'SYSTEM'>;
  readonly reasonCode: RefundReasonCode;
  /** Students only (`refunds_comment_ck`). */
  readonly comment: string | null;
  /** The first transition's actor: the student, or the admin. */
  readonly actorId: string;
  /**
   * ADMIN: 10–2000 characters (`refund_transitions_reason_ck`). STUDENT: the consumption
   * objection that sent the request to review (Phase 5 D8), else null.
   */
  readonly reason: string | null;
}

/**
 * One refund state change: a conditional `UPDATE ... WHERE status IN (from)` plus the next
 * row of the log, in the caller's transaction (after the order lock, R8). The columns that
 * `refunds_status_log_ck` compares are written with SQL `now()`, like the log row.
 */
export interface RefundTransitionInput {
  readonly refundId: string;
  readonly from: readonly RefundStatus[];
  readonly to: RefundStatus;
  /** Admin review / retry (required from REQUESTED and FAILED); null for the system. */
  readonly actorId: string | null;
  readonly reason?: string | null;
  /** SUBMITTED / SUCCEEDED / FAILED: this attempt's provider refund. */
  readonly providerRefundId?: string | null;
  /** FAILED only (`^[a-z0-9_]{1,64}$`). */
  readonly failureCode?: string | null;
  /** The claimed webhook event that caused it. */
  readonly providerEventId?: string | null;
}

export interface RefundTransitionResult {
  /** false = the refund was no longer in `from` (a race; nothing written). */
  readonly applied: boolean;
  /** The SQL `now()` of the change (the transaction start). */
  readonly at: Date | null;
  /** The attempt after the change (retry increments it). */
  readonly attempt: number | null;
}

/** Keyset of the admin refund list: `created_at` as exact SQL text + the id. */
export interface RefundKeyset {
  readonly createdAt: string;
  readonly id: string;
}

export interface RefundQueueRecord extends RefundRecord {
  /** The D11 count as the rule saw it (contracts `recentRefundCount`). */
  readonly recentRefundCount: number;
  readonly keyset: RefundKeyset;
}

/** Everything `RefundSucceeded` carries (design §7). */
export interface RefundSucceededFacts {
  readonly refundId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly instructorId: string;
  readonly currency: string;
  readonly amount: string;
  readonly instructorShareAmount: string;
  readonly platformShareAmount: string;
  readonly succeededAt: Date;
}

/**
 * `commerce.refunds` + `refund_transitions` (schema doc §6, §8.4b). Writes run under the
 * caller's cart (user) and order locks; constraint violations propagate (the transaction
 * runner maps the context-free ones, e.g. `refunds_order_line_id_live_uq`).
 */
export abstract class RefundRepository {
  abstract findById(refundId: string, ex?: Executor): Promise<RefundRecord | null>;

  /** Lock step after the order (R8): the refund row FOR UPDATE. */
  abstract lock(trx: Transaction<DB>, refundId: string): Promise<RefundRecord | null>;

  /** The refund currently holding this provider refund id (`refunds_provider_refund_id_uq`). */
  abstract findIdByProviderRefundId(
    providerRefundId: string,
    ex?: Executor,
  ): Promise<string | null>;

  /** True when an earlier attempt of the refund recorded this provider refund id. */
  abstract isEarlierAttempt(
    trx: Transaction<DB>,
    refundId: string,
    providerRefundId: string,
  ): Promise<boolean>;

  /** The order's refunds, oldest first. */
  abstract listForOrder(orderId: string, ex?: Executor): Promise<RefundRecord[]>;

  /** The logs of these refunds, by refund then seq. */
  abstract listTransitions(
    refundIds: readonly string[],
    ex?: Executor,
  ): Promise<RefundTransitionRecord[]>;

  /**
   * The D11 count at request time (under the cart lock): the user's STUDENT refunds, not
   * REJECTED, created since `now() - lookbackDays`.
   */
  abstract countRecentStudentRefunds(
    trx: Transaction<DB>,
    userId: string,
    lookbackDays: number,
  ): Promise<number>;

  /** A new refund (REQUESTED or APPROVED, attempt 1) and its first transition. */
  abstract insert(trx: Transaction<DB>, refund: NewRefund): Promise<RefundRecord>;

  abstract transition(
    trx: Transaction<DB>,
    input: RefundTransitionInput,
  ): Promise<RefundTransitionResult>;

  /**
   * §8.4b under the order lock: SUCCEEDED refunds sum to the total -> REFUNDED (also from
   * PAYMENT_REVIEW, releasing its reservations), PAID with a partial sum -> PARTIALLY_REFUNDED.
   */
  abstract applySucceededToOrder(trx: Transaction<DB>, orderId: string): Promise<OrderStatus>;

  abstract findSucceededFacts(refundId: string, ex: Executor): Promise<RefundSucceededFacts | null>;

  /** Admin list: one status, oldest first `(created_at, id)`. */
  abstract listByStatus(
    status: RefundStatus,
    page: { readonly after?: RefundKeyset; readonly limit: number },
    ex?: Executor,
  ): Promise<RefundQueueRecord[]>;

  /** The D11 count of one refund as the rule saw it (see `RefundQueueRecord`). */
  abstract recentRefundCountOf(refundId: string, ex?: Executor): Promise<number>;
}

/* ----------------------------------------------------------------------------------------
 * Dispatch (schema doc §8.4, D9)
 * -------------------------------------------------------------------------------------- */

export interface LeasedRefundRecord {
  readonly id: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly amount: string;
  readonly attempt: number;
  /** Exact `dispatch_started_at` text: the fence of tx2. */
  readonly claimedAt: string;
  readonly paymentIntentId: string | null;
}

export interface RefundFenceInput {
  readonly refundId: string;
  readonly orderId: string;
  readonly attempt: number;
  readonly claimedAt: string;
}

/**
 * The dispatcher's lease and its fenced outcomes (`@udemy/db` refund-dispatch SQL): tx1
 * leases APPROVED rows under the advisory lock `REFUND_DISPATCH_LOCK_KEY` (`0x75646d79_03`)
 * with SKIP LOCKED and commits; the provider call runs with no transaction; tx2 writes the
 * outcome only if the lease still holds (status APPROVED, same attempt, same claim time).
 */
export abstract class RefundDispatchRepository {
  /**
   * tx1 (its own short transaction). `refundIds` restricts the lease to those refunds (the
   * post-commit kick); otherwise the oldest approvals first, `batchSize` at most.
   * `locked: false` = another replica holds the dispatcher lock.
   */
  abstract lease(options: {
    readonly batchSize: number;
    readonly staleLeaseSeconds: number;
    readonly refundIds?: readonly string[];
  }): Promise<{ readonly locked: boolean; readonly refunds: readonly LeasedRefundRecord[] }>;

  /** tx2: APPROVED -> SUBMITTED / SUCCEEDED (order recomputed on SUCCEEDED). */
  abstract complete(
    trx: Transaction<DB>,
    input: RefundFenceInput & {
      readonly status: 'SUBMITTED' | 'SUCCEEDED';
      readonly providerRefundId: string;
    },
  ): Promise<{ readonly applied: boolean }>;

  /** tx2: APPROVED -> FAILED with `failure_code`. */
  abstract fail(
    trx: Transaction<DB>,
    input: RefundFenceInput & { readonly failureCode: string },
  ): Promise<{ readonly applied: boolean }>;

  /** Gives a lease back after a transient error (fenced); the next run retries at once. */
  abstract release(input: {
    readonly refundId: string;
    readonly claimedAt: string;
  }): Promise<boolean>;
}
