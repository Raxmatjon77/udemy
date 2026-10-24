import { Injectable } from '@nestjs/common';
import {
  type OrderStatus,
  REFUND_REVIEW_LOOKBACK_DAYS,
  type RefundInitiator,
  type RefundReasonCode,
  type RefundStatus,
} from '@udemy/contracts';
import {
  applySucceededRefundsToOrder,
  completeRefundDispatch,
  type DB,
  type Executor,
  failRefundDispatch,
  inTransaction,
  leaseRefundsForDispatch,
  REFUND_DISPATCH_LOCK_KEY,
  releaseRefundDispatchLease,
  sql,
  type Transaction,
  tryAdvisoryXactLock,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type LeasedRefundRecord,
  type NewRefund,
  RefundDispatchRepository,
  type RefundFenceInput,
  type RefundKeyset,
  type RefundQueueRecord,
  type RefundRecord,
  RefundRepository,
  type RefundSucceededFacts,
  type RefundTransitionInput,
  type RefundTransitionRecord,
  type RefundTransitionResult,
} from '../application/ports/refund.repository';

interface RefundRow {
  id: string;
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  userId: string;
  courseId: string;
  courseTitle: string;
  instructorId: string;
  amount: string;
  currency: string;
  status: RefundStatus;
  initiatedBy: RefundInitiator;
  reasonCode: RefundReasonCode;
  comment: string | null;
  attempt: number;
  providerRefundId: string | null;
  failureCode: string | null;
  requestedBy: string | null;
  rejectionReason: string | null;
  reviewReason: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  succeededAt: Date | null;
}

/** The D11 lookback (contracts `REFUND_REVIEW_LOOKBACK_DAYS`), as SQL. */
const LOOKBACK = sql`make_interval(days => ${REFUND_REVIEW_LOOKBACK_DAYS}::int)`;

/** Every `RefundRecord` column; `r` = refunds, `o` = orders, `l` = order_lines. */
const REFUND_COLUMNS = sql`
  r.id, r.order_id, o.order_number, r.order_line_id, r.user_id, l.course_id, l.course_title,
  l.instructor_id, r.amount, o.currency, r.status, r.initiated_by, r.reason_code, r.comment,
  r.attempt, r.provider_refund_id, r.failure_code, r.created_at, r.approved_at, r.succeeded_at,
  (SELECT t.actor_id FROM commerce.refund_transitions t
    WHERE t.refund_id = r.id AND t.seq = 1) AS requested_by,
  (SELECT t.reason FROM commerce.refund_transitions t
    WHERE t.refund_id = r.id AND t.to_status = 'REJECTED' ORDER BY t.seq DESC LIMIT 1) AS rejection_reason,
  CASE WHEN r.initiated_by = 'STUDENT' THEN
    (SELECT t.reason FROM commerce.refund_transitions t
      WHERE t.refund_id = r.id AND t.seq = 1) END AS review_reason`;

const REFUND_FROM = sql`
  commerce.refunds r
  JOIN commerce.orders o ON o.id = r.order_id
  JOIN commerce.order_lines l ON l.id = r.order_line_id`;

/** The D11 count of refund `r` as the rule saw it (contracts `recentRefundCount`). */
const RECENT_COUNT = sql`
  (SELECT count(*)::int FROM commerce.refunds x
    WHERE x.user_id = r.user_id AND x.id <> r.id AND x.initiated_by = 'STUDENT'
      AND x.status <> 'REJECTED'
      AND x.created_at >= r.created_at - ${LOOKBACK} AND x.created_at <= r.created_at)`;

function orderNumberOf(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Invalid order number ${value}`);
  return n;
}

function toRecord(row: RefundRow): RefundRecord {
  return { ...row, orderNumber: orderNumberOf(row.orderNumber) };
}

/**
 * Refunds and their log (schema doc §6, §8.4b). Every timestamp the deferred
 * `refunds_status_log_ck` compares is SQL `now()`, written together with the log row.
 */
@Injectable()
export class KyselyRefundRepository extends RefundRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findById(refundId: string, ex: Executor = this.db): Promise<RefundRecord | null> {
    const { rows } = await sql<RefundRow>`
      SELECT ${REFUND_COLUMNS} FROM ${REFUND_FROM} WHERE r.id = ${refundId}
    `.execute(ex);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async lock(trx: Transaction<DB>, refundId: string): Promise<RefundRecord | null> {
    const { rows } = await sql<RefundRow>`
      SELECT ${REFUND_COLUMNS} FROM ${REFUND_FROM} WHERE r.id = ${refundId} FOR UPDATE OF r
    `.execute(trx);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findIdByProviderRefundId(
    providerRefundId: string,
    ex: Executor = this.db,
  ): Promise<string | null> {
    const row = await ex
      .selectFrom('commerce.refunds')
      .select('id')
      .where('providerRefundId', '=', providerRefundId)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async isEarlierAttempt(
    trx: Transaction<DB>,
    refundId: string,
    providerRefundId: string,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom('commerce.refundTransitions')
      .select('seq')
      .where('refundId', '=', refundId)
      .where('providerRefundId', '=', providerRefundId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listForOrder(orderId: string, ex: Executor = this.db): Promise<RefundRecord[]> {
    const { rows } = await sql<RefundRow>`
      SELECT ${REFUND_COLUMNS} FROM ${REFUND_FROM}
       WHERE r.order_id = ${orderId}
       ORDER BY r.created_at, r.id
    `.execute(ex);
    return rows.map(toRecord);
  }

  async listTransitions(
    refundIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<RefundTransitionRecord[]> {
    if (refundIds.length === 0) return [];
    const rows = await ex
      .selectFrom('commerce.refundTransitions')
      .select([
        'refundId',
        'seq',
        'fromStatus',
        'toStatus',
        'actorId',
        'reason',
        'providerRefundId',
        'failureCode',
        'providerEventId',
        'occurredAt',
      ])
      .where('refundId', 'in', [...refundIds])
      .orderBy('refundId')
      .orderBy('seq')
      .execute();
    return rows.map((row) => ({
      ...row,
      fromStatus: row.fromStatus as RefundStatus | null,
      toStatus: row.toStatus as RefundStatus,
    }));
  }

  async countRecentStudentRefunds(
    trx: Transaction<DB>,
    userId: string,
    lookbackDays: number,
  ): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM commerce.refunds
       WHERE user_id = ${userId} AND initiated_by = 'STUDENT' AND status <> 'REJECTED'
         AND created_at >= now() - make_interval(days => ${lookbackDays}::int)
    `.execute(trx);
    return rows[0]?.count ?? 0;
  }

  async insert(trx: Transaction<DB>, refund: NewRefund): Promise<RefundRecord> {
    const approved = refund.status === 'APPROVED';
    const { rows } = await sql<{ id: string }>`
      INSERT INTO commerce.refunds
        (order_id, order_line_id, user_id, amount, status, initiated_by, reason_code, comment, approved_at)
      VALUES (${refund.orderId}, ${refund.orderLineId}, ${refund.userId}, ${refund.amount}::numeric,
              ${refund.status}, ${refund.initiatedBy}, ${refund.reasonCode}, ${refund.comment},
              ${approved ? sql`now()` : null})
      RETURNING id
    `.execute(trx);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('refund insert returned nothing');
    await sql`
      INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, actor_id, reason)
      VALUES (${id}, 1, NULL, ${refund.status}, ${refund.actorId}, ${refund.reason})
    `.execute(trx);
    const record = await this.findById(id, trx);
    if (record === null) throw new Error(`refund ${id} vanished inside its transaction`);
    return record;
  }

  async transition(
    trx: Transaction<DB>,
    input: RefundTransitionInput,
  ): Promise<RefundTransitionResult> {
    const to = input.to;
    const providerRefundId = input.providerRefundId ?? null;
    const failureCode = to === 'FAILED' ? (input.failureCode ?? null) : null;
    if (to === 'FAILED' && failureCode === null) throw new RangeError('FAILED needs a failureCode');
    const { rows } = await sql<{ attempt: number; at: Date; providerRefundId: string | null }>`
      UPDATE commerce.refunds
         SET status = ${to},
             approved_at = CASE WHEN ${to}::text = 'APPROVED' THEN now() ELSE approved_at END,
             succeeded_at = CASE WHEN ${to}::text = 'SUCCEEDED' THEN now() ELSE succeeded_at END,
             attempt = CASE WHEN status = 'FAILED' AND ${to}::text = 'APPROVED' THEN attempt + 1
                            ELSE attempt END,
             failure_code = ${failureCode}::text,
             provider_refund_id = CASE WHEN ${to}::text IN ('APPROVED','REJECTED') THEN NULL
                                       ELSE coalesce(${providerRefundId}::text, provider_refund_id) END,
             dispatch_started_at = NULL
       WHERE id = ${input.refundId} AND status = ANY(${[...input.from]}::text[])
      RETURNING attempt, now() AS at, provider_refund_id
    `.execute(trx);
    const updated = rows[0];
    if (updated === undefined) return { applied: false, at: null, attempt: null };
    const eventId = input.providerEventId ?? null;
    await sql`
      INSERT INTO commerce.refund_transitions
        (refund_id, seq, from_status, to_status, actor_id, reason, provider_refund_id, failure_code,
         provider, provider_event_id)
      SELECT ${input.refundId}, h.seq + 1, h.to_status, ${to}, ${input.actorId}, ${input.reason ?? null},
             ${to === 'SUBMITTED' || to === 'SUCCEEDED' || to === 'FAILED' ? updated.providerRefundId : null},
             ${failureCode}, ${eventId === null ? null : 'STRIPE'}, ${eventId}
        FROM (SELECT seq, to_status FROM commerce.refund_transitions
               WHERE refund_id = ${input.refundId} ORDER BY seq DESC LIMIT 1) h
    `.execute(trx);
    return { applied: true, at: updated.at, attempt: updated.attempt };
  }

  applySucceededToOrder(trx: Transaction<DB>, orderId: string): Promise<OrderStatus> {
    return applySucceededRefundsToOrder(trx, orderId);
  }

  async findSucceededFacts(refundId: string, ex: Executor): Promise<RefundSucceededFacts | null> {
    const { rows } = await sql<RefundSucceededFacts>`
      SELECT r.id AS refund_id, r.order_id, r.order_line_id, r.user_id, l.course_id, l.instructor_id,
             o.currency, r.amount, l.instructor_share_amount, l.platform_share_amount, r.succeeded_at
        FROM ${REFUND_FROM}
       WHERE r.id = ${refundId} AND r.status = 'SUCCEEDED'
    `.execute(ex);
    return rows[0] ?? null;
  }

  async listByStatus(
    status: RefundStatus,
    page: { after?: RefundKeyset; limit: number },
    ex: Executor = this.db,
  ): Promise<RefundQueueRecord[]> {
    const after =
      page.after === undefined
        ? sql``
        : sql`AND (r.created_at, r.id) > (${page.after.createdAt}::timestamptz, ${page.after.id}::uuid)`;
    const { rows } = await sql<RefundRow & { recentRefundCount: number; createdAtText: string }>`
      SELECT ${REFUND_COLUMNS}, ${RECENT_COUNT} AS recent_refund_count,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
        FROM ${REFUND_FROM}
       WHERE r.status = ${status} ${after}
       ORDER BY r.created_at, r.id
       LIMIT ${page.limit}
    `.execute(ex);
    return rows.map(({ recentRefundCount, createdAtText, ...row }) => ({
      ...toRecord(row),
      recentRefundCount,
      keyset: { createdAt: createdAtText, id: row.id },
    }));
  }

  async recentRefundCountOf(refundId: string, ex: Executor = this.db): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      SELECT ${RECENT_COUNT} AS count FROM commerce.refunds r WHERE r.id = ${refundId}
    `.execute(ex);
    return rows[0]?.count ?? 0;
  }
}

/**
 * The dispatcher's lease over `@udemy/db` (`leaseRefundsForDispatch`, `completeRefundDispatch`,
 * `failRefundDispatch`, `releaseRefundDispatchLease`). The id-restricted lease (the post-commit
 * kick) is the same statement with `r.id = ANY(...)` under the same advisory lock.
 */
@Injectable()
export class KyselyRefundDispatchRepository extends RefundDispatchRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lease(options: {
    batchSize: number;
    staleLeaseSeconds: number;
    refundIds?: readonly string[];
  }): Promise<{ locked: boolean; refunds: readonly LeasedRefundRecord[] }> {
    if (options.refundIds === undefined) {
      return leaseRefundsForDispatch(this.db, {
        batchSize: options.batchSize,
        staleLeaseSeconds: options.staleLeaseSeconds,
      });
    }
    const ids = [...new Set(options.refundIds)];
    if (ids.length === 0) return { locked: true, refunds: [] };
    return inTransaction(this.db, async (trx) => {
      if (!(await tryAdvisoryXactLock(trx, REFUND_DISPATCH_LOCK_KEY))) {
        return { locked: false, refunds: [] };
      }
      const { rows } = await sql<LeasedRefundRecord>`
        WITH next AS (
          SELECT r.id FROM commerce.refunds r
           WHERE r.id = ANY(${ids}::uuid[]) AND r.status = 'APPROVED'
             AND (r.dispatch_started_at IS NULL
                  OR r.dispatch_started_at < now() - make_interval(secs => ${options.staleLeaseSeconds}))
           ORDER BY r.approved_at, r.id
           LIMIT ${options.batchSize}
           FOR UPDATE SKIP LOCKED)
        UPDATE commerce.refunds r SET dispatch_started_at = now()
          FROM next WHERE r.id = next.id
        RETURNING r.id, r.order_id, r.order_line_id, r.amount, r.attempt,
                  r.dispatch_started_at::text AS claimed_at,
                  (SELECT p.payment_intent_id FROM commerce.payments p WHERE p.order_id = r.order_id) AS payment_intent_id
      `.execute(trx);
      return { locked: true, refunds: rows };
    });
  }

  async complete(
    trx: Transaction<DB>,
    input: RefundFenceInput & { status: 'SUBMITTED' | 'SUCCEEDED'; providerRefundId: string },
  ): Promise<{ applied: boolean }> {
    const result = await completeRefundDispatch(trx, input);
    return { applied: result.applied };
  }

  async fail(
    trx: Transaction<DB>,
    input: RefundFenceInput & { failureCode: string },
  ): Promise<{ applied: boolean }> {
    const result = await failRefundDispatch(trx, input);
    return { applied: result.applied };
  }

  release(input: { refundId: string; claimedAt: string }): Promise<boolean> {
    return releaseRefundDispatchLease(this.db, input);
  }
}
