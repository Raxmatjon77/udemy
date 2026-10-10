import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderRow,
  AdminOrderTimelineEntry,
  AdminOrderTimelineKind,
} from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { OrderNotFound } from '../domain/commerce.errors';
import { Money } from '../domain/money';
import {
  type AdminOrderParts,
  AdminOrderRepository,
  type AdminOrderRowRecord,
} from './ports/admin-order.repository';
import {
  type CommerceAccount,
  CommerceAdminDirectory,
  CommercePeople,
} from './ports/context-gateways';
import { type OrderHeaderRecord, OrderRepository } from './ports/order.repository';
import {
  type RefundRecord,
  RefundRepository,
  type RefundTransitionRecord,
} from './ports/refund.repository';
import { TransactionRunner } from './ports/transaction-runner';
import { toActor, toAdminBuyer, toAdminRefundView, toRefundTransitionView } from './refund-views';

/**
 * `order_transitions` has no surrogate key (PK `(order_id, seq)`): the contract's transition
 * `id` is a deterministic UUIDv8 of `{orderId}:{seq}`, stable across reads.
 */
export function orderTransitionId(orderId: string, seq: number): string {
  const bytes = createHash('sha256').update(`order-transition:${orderId}:${seq}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const KIND_RANK: Readonly<Record<AdminOrderTimelineKind, number>> = {
  ORDER: 0,
  PAYMENT: 1,
  REFUND: 2,
};

const NO_DETAIL = {
  refundId: null,
  cause: null,
  actorId: null,
  actor: null,
  reason: null,
  providerEventId: null,
  providerRefundId: null,
  failureCode: null,
} as const;

function sum(amounts: readonly string[], currency: string): string {
  return Money.sum(
    amounts.map((a) => Money.fromDecimal(a, currency)),
    currency,
  ).toDecimal();
}

/**
 * The admin order views (design §8 `GET /admin/orders`, `/admin/orders/:orderId`, §10
 * web-admin): the buyer with email, the line snapshot with the SQL revenue split, the payment
 * (never its checkout url), every transition with the actor's display name, the refunds with
 * their logs, the provider events, and one merged timeline. A detail is read in one
 * transaction (one snapshot).
 */
@Injectable()
export class AdminOrderViews {
  constructor(
    private readonly orders: OrderRepository,
    private readonly adminOrders: AdminOrderRepository,
    private readonly refunds: RefundRepository,
    private readonly directory: CommerceAdminDirectory,
    private readonly people: CommercePeople,
    private readonly tx: TransactionRunner,
  ) {}

  /** @throws OrderNotFound (404) */
  detail(orderId: string): Promise<AdminOrderDetail> {
    return this.tx.run((trx) => this.detailIn(orderId, trx));
  }

  /** The detail inside the caller's transaction (e.g. right after accept-payment). */
  async detailIn(orderId: string, ex: Executor): Promise<AdminOrderDetail> {
    const header = await this.orders.findHeader(orderId, ex);
    if (header === null) throw new OrderNotFound();
    const parts = await this.adminOrders.findParts(orderId, ex);
    const refunds = await this.refunds.listForOrder(orderId, ex);
    const refundLog = await this.refunds.listTransitions(
      refunds.map((r) => r.id),
      ex,
    );
    const accounts = await this.directory.findAccounts(
      [
        header.userId,
        ...parts.transitions.flatMap((t) => (t.actorId === null ? [] : [t.actorId])),
        ...refundLog.flatMap((t) => (t.actorId === null ? [] : [t.actorId])),
      ],
      ex,
    );
    const instructors = await this.people.findPeople(
      [...new Set(parts.lines.map((l) => l.instructorId))],
      ex,
    );
    return this.toDetail(header, parts, refunds, refundLog, accounts, instructors);
  }

  async rows(records: readonly AdminOrderRowRecord[]): Promise<AdminOrderRow[]> {
    const accounts = await this.directory.findAccounts([...new Set(records.map((r) => r.userId))]);
    return records.map((r) => {
      const total = Money.fromDecimal(r.totalAmount, r.currency);
      return {
        id: r.id,
        orderNumber: r.orderNumber,
        status: r.status,
        currency: total.currency,
        totalAmount: total.toDecimal(),
        lineCount: r.lineCount,
        buyer: toAdminBuyer(accounts.get(r.userId)),
        placedAt: r.placedAt.toISOString(),
        paidAt: r.paidAt?.toISOString() ?? null,
      };
    });
  }

  private toDetail(
    header: OrderHeaderRecord,
    parts: AdminOrderParts,
    refunds: readonly RefundRecord[],
    refundLog: readonly RefundTransitionRecord[],
    accounts: ReadonlyMap<string, CommerceAccount>,
    instructors: ReadonlyMap<string, { readonly displayName: string; readonly banned: boolean }>,
  ): AdminOrderDetail {
    const currency = Money.zero(header.currency).currency;
    const logOf = new Map<string, RefundTransitionRecord[]>();
    for (const row of refundLog) logOf.set(row.refundId, [...(logOf.get(row.refundId) ?? []), row]);
    const transitions = parts.transitions.map((t) => ({
      id: orderTransitionId(header.orderId, t.seq),
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      cause: t.cause,
      providerEventId: t.providerEventId,
      actorId: t.actorId,
      actor: toActor(t.actorId, accounts),
      reason: t.reason,
      occurredAt: t.occurredAt.toISOString(),
    }));
    const payment = parts.payment;
    return {
      id: header.orderId,
      orderNumber: header.orderNumber,
      status: header.status,
      currency,
      subtotalAmount: sum(
        parts.lines.map((l) => l.listAmount),
        currency,
      ),
      discountAmount: sum(
        parts.lines.map((l) => l.discountAmount),
        currency,
      ),
      totalAmount: Money.fromDecimal(header.totalAmount, currency).toDecimal(),
      refundedAmount: sum(
        refunds.filter((r) => r.status === 'SUCCEEDED').map((r) => r.amount),
        currency,
      ),
      settlement: payment === null ? 'NONE' : 'STRIPE',
      placedAt: header.placedAt.toISOString(),
      paidAt: header.paidAt?.toISOString() ?? null,
      closedAt: header.closedAt?.toISOString() ?? null,
      buyer: toAdminBuyer(accounts.get(header.userId)),
      lines: parts.lines.map((l) => {
        const person = instructors.get(l.instructorId);
        return {
          id: l.id,
          lineNo: l.lineNo,
          courseId: l.courseId,
          courseTitle: l.courseTitle,
          instructorId: l.instructorId,
          instructor:
            person === undefined || person.banned
              ? null
              : { id: l.instructorId, displayName: person.displayName },
          listAmount: l.listAmount,
          discountAmount: l.discountAmount,
          finalAmount: l.finalAmount,
          couponId: l.couponId,
          couponCode: l.couponCode,
          revenueShareBps: l.revenueShareBps,
          instructorShareAmount: l.instructorShareAmount,
          platformShareAmount: l.platformShareAmount,
        };
      }),
      payment:
        payment === null
          ? null
          : {
              // payments are 1:1 with orders (PK order_id): the payment's id is its order id.
              id: header.orderId,
              provider: 'STRIPE',
              status: payment.status,
              amount: payment.amount,
              currency: Money.zero(payment.currency).currency,
              checkoutSessionId: payment.checkoutSessionId,
              paymentIntentId: payment.paymentIntentId,
              sessionExpiresAt: payment.sessionExpiresAt?.toISOString() ?? null,
              succeededAt: payment.succeededAt?.toISOString() ?? null,
              createdAt: payment.createdAt.toISOString(),
            },
      transitions,
      refunds: refunds.map((r) => ({
        ...toAdminRefundView(r),
        transitions: (logOf.get(r.id) ?? []).map((t) => toRefundTransitionView(t, accounts)),
      })),
      providerEvents: parts.providerEvents.map((e) => ({
        provider: 'STRIPE',
        eventId: e.eventId,
        type: e.type,
        livemode: e.livemode,
        objectId: e.objectId ?? '',
        providerCreatedAt: e.providerCreatedAt.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
        processedAt: e.processedAt?.toISOString() ?? null,
        outcome: e.outcome,
      })),
      timeline: this.timeline(transitions, parts, refundLog, accounts),
    };
  }

  /** Order transitions, payment milestones and refund transitions, oldest first. */
  private timeline(
    transitions: AdminOrderDetail['transitions'],
    parts: AdminOrderParts,
    refundLog: readonly RefundTransitionRecord[],
    accounts: ReadonlyMap<string, CommerceAccount>,
  ): AdminOrderTimelineEntry[] {
    const entries: AdminOrderTimelineEntry[] = transitions.map((t) => ({
      ...NO_DETAIL,
      kind: 'ORDER',
      at: t.occurredAt,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      cause: t.cause,
      actorId: t.actorId,
      actor: t.actor,
      reason: t.reason,
      providerEventId: t.providerEventId,
    }));
    const payment = parts.payment;
    if (payment !== null) {
      entries.push({
        ...NO_DETAIL,
        kind: 'PAYMENT',
        at: payment.createdAt.toISOString(),
        fromStatus: null,
        toStatus: 'CREATING',
      });
      if (payment.status === 'SUCCEEDED' && payment.succeededAt !== null) {
        entries.push({
          ...NO_DETAIL,
          kind: 'PAYMENT',
          at: payment.succeededAt.toISOString(),
          fromStatus: null,
          toStatus: 'SUCCEEDED',
        });
      } else if (payment.status !== 'CREATING') {
        // OPEN / EXPIRED / ABANDONED: the payment row's last change.
        entries.push({
          ...NO_DETAIL,
          kind: 'PAYMENT',
          at: payment.updatedAt.toISOString(),
          fromStatus: null,
          toStatus: payment.status,
        });
      }
    }
    for (const t of refundLog) {
      entries.push({
        ...NO_DETAIL,
        kind: 'REFUND',
        at: t.occurredAt.toISOString(),
        refundId: t.refundId,
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        actorId: t.actorId,
        actor: toActor(t.actorId, accounts),
        reason: t.reason,
        providerEventId: t.providerEventId,
        providerRefundId: t.providerRefundId,
        failureCode: t.failureCode,
      });
    }
    // Stable: equal instants keep ORDER, PAYMENT, REFUND, and each log's own order.
    return entries.sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || KIND_RANK[a.kind] - KIND_RANK[b.kind],
    );
  }
}
