import { Injectable, Logger } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import type { ChargeRefundedData, ProviderEvent, RefundUpdatedData } from '@udemy/payments';
import { z } from 'zod';
import { Money } from '../domain/money';
import { refundFailureCode } from '../domain/refund-policy';
import { CommerceClock } from './ports/commerce-clock';
import { OrderRepository } from './ports/order.repository';
import { ProviderRefundEvents, type RefundEventResult } from './ports/provider-refund-events';
import { type RefundRecord, RefundRepository } from './ports/refund.repository';
import { RefundLifecycle } from './refund-lifecycle.service';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * The refund webhooks (design §5 `REFUND_UPDATED`, §4 refund state machine, §14), inside the
 * transaction in which `HandleProviderEvent` claimed the event. Transitions are monotonic and
 * state-guarded, so replays and reordering are no-ops (DUPLICATE_EFFECT / IGNORED).
 *
 * - `refund.updated` / `refund.failed`: matched by `provider_refund_id`, then by
 *   `metadata.refundId` (covers a dispatcher that crashed after the provider call). A provider
 *   refund of an EARLIER attempt (before an admin retry) never touches the current attempt.
 *   pending: APPROVED -> SUBMITTED; succeeded: APPROVED/SUBMITTED -> SUCCEEDED (order status
 *   recomputed, `RefundSucceeded`); failed: APPROVED/SUBMITTED -> FAILED (`RefundFailed`).
 * - `charge.refunded` carries NO refund ids (since API 2022-11-15, §14): it is reconciled by
 *   the payment intent and amounts. The charge's cumulative `amount_refunded` minus our
 *   SUCCEEDED refunds is the newly refunded amount; it settles the order's SUBMITTED refunds
 *   when they add up to exactly that (all of them, or the only one of that amount). Anything
 *   ambiguous is left to the per-refund `refund.updated` (IGNORED); more refunded than we ever
 *   sent is ORPHAN.
 * - No matching refund (e.g. one made in the Stripe dashboard, unsupported): ORPHAN + an error
 *   log for the operators.
 *
 * Lock order (R8): the order row, then the refund rows.
 */
@Injectable()
export class ProviderRefundEventsHandler extends ProviderRefundEvents {
  private readonly logger = new Logger(ProviderRefundEventsHandler.name);

  constructor(
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly lifecycle: RefundLifecycle,
    private readonly clock: CommerceClock,
  ) {
    super();
  }

  apply(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeRefundedData | RefundUpdatedData,
  ): Promise<RefundEventResult> {
    return data.type === 'charge.refunded'
      ? this.chargeRefunded(trx, event, data)
      : this.refundUpdated(trx, event, data);
  }

  private async refundUpdated(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: RefundUpdatedData,
  ): Promise<RefundEventResult> {
    const mapped =
      (await this.refunds.findIdByProviderRefundId(data.providerRefundId, trx)) ??
      (data.refundId !== null && isUuid(data.refundId) ? data.refundId : null);
    const found = mapped === null ? null : await this.refunds.findById(mapped, trx);
    if (found === null) {
      const orderId =
        data.paymentIntentId === null
          ? null
          : await this.orders.findOrderIdByPaymentIntent(data.paymentIntentId, trx);
      this.logger.error(
        `provider event ${event.id}: refund ${data.providerRefundId} matches no refund of ours (dashboard refunds are not supported)`,
      );
      return { outcome: 'ORPHAN', orderId };
    }
    if (data.paymentIntentId !== null) {
      const intentOrder = await this.orders.findOrderIdByPaymentIntent(data.paymentIntentId, trx);
      if (intentOrder !== found.orderId) {
        this.logger.error(
          `provider event ${event.id}: refund ${found.id} belongs to order ${found.orderId}, the event's payment intent to ${intentOrder ?? 'none'}`,
        );
        return { outcome: 'MISMATCH', orderId: found.orderId };
      }
    }
    await this.orders.lockOrder(trx, found.orderId);
    const refund = await this.refunds.lock(trx, found.id);
    if (refund === null) throw new Error(`refund ${found.id} vanished inside its transaction`);
    const orderId = refund.orderId;

    if (refund.providerRefundId !== null && refund.providerRefundId !== data.providerRefundId) {
      this.logger.warn(
        `provider event ${event.id}: refund ${refund.id} is attempt ${refund.attempt} (${refund.providerRefundId}), not ${data.providerRefundId}`,
      );
      return { outcome: 'IGNORED', orderId };
    }
    if (
      refund.providerRefundId === null &&
      (await this.refunds.isEarlierAttempt(trx, refund.id, data.providerRefundId))
    ) {
      // A late event of an attempt before the admin's retry.
      return { outcome: 'DUPLICATE_EFFECT', orderId };
    }
    const expected = Money.fromDecimal(refund.amount, refund.currency);
    if (data.amountMinor !== expected.minor || data.currency !== expected.currency) {
      this.logger.error(
        `provider event ${event.id}: refund ${refund.id} is ${expected.toDecimal()} ${expected.currency}, the provider reports ${data.amountMinor} minor ${data.currency}`,
      );
      return { outcome: 'MISMATCH', orderId };
    }

    switch (data.status) {
      case 'PENDING': {
        if (refund.status === 'SUBMITTED') return { outcome: 'DUPLICATE_EFFECT', orderId };
        if (refund.status !== 'APPROVED') return { outcome: 'IGNORED', orderId };
        const done = await this.refunds.transition(trx, {
          refundId: refund.id,
          from: ['APPROVED'],
          to: 'SUBMITTED',
          actorId: null,
          providerRefundId: data.providerRefundId,
          providerEventId: event.id,
        });
        return { outcome: done.applied ? 'APPLIED' : 'DUPLICATE_EFFECT', orderId };
      }
      case 'SUCCEEDED': {
        if (refund.status === 'SUCCEEDED') return { outcome: 'DUPLICATE_EFFECT', orderId };
        if (refund.status !== 'APPROVED' && refund.status !== 'SUBMITTED') {
          this.logger.error(
            `provider event ${event.id}: refund ${refund.id} succeeded at the provider but is ${refund.status} here`,
          );
          return { outcome: 'IGNORED', orderId };
        }
        await this.succeed(trx, refund, event.id, data.providerRefundId);
        return { outcome: 'APPLIED', orderId };
      }
      case 'FAILED': {
        if (refund.status === 'FAILED') return { outcome: 'DUPLICATE_EFFECT', orderId };
        if (refund.status !== 'APPROVED' && refund.status !== 'SUBMITTED') {
          this.logger.error(
            `provider event ${event.id}: refund ${refund.id} failed at the provider but is ${refund.status} here`,
          );
          return { outcome: 'IGNORED', orderId };
        }
        const failureCode = refundFailureCode(data.failureReason, 'provider_failed');
        const done = await this.refunds.transition(trx, {
          refundId: refund.id,
          from: ['APPROVED', 'SUBMITTED'],
          to: 'FAILED',
          actorId: null,
          providerRefundId: data.providerRefundId,
          failureCode,
          providerEventId: event.id,
        });
        if (!done.applied) return { outcome: 'DUPLICATE_EFFECT', orderId };
        await this.lifecycle.failed(trx, {
          refundId: refund.id,
          orderId,
          failureCode,
          attempt: refund.attempt,
          failedAt: done.at ?? (await this.clock.now(trx)),
        });
        return { outcome: 'APPLIED', orderId };
      }
    }
  }

  private async chargeRefunded(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeRefundedData,
  ): Promise<RefundEventResult> {
    const orderId =
      data.paymentIntentId === null
        ? null
        : await this.orders.findOrderIdByPaymentIntent(data.paymentIntentId, trx);
    if (orderId === null) {
      this.logger.error(`provider event ${event.id}: charge ${data.chargeId} has no order`);
      return { outcome: 'ORPHAN', orderId: null };
    }
    const order = await this.orders.lockOrder(trx, orderId);
    if (order === null) return { outcome: 'ORPHAN', orderId: null };
    if (data.currency !== order.currency) {
      this.logger.error(
        `provider event ${event.id}: charge ${data.chargeId} is ${data.currency}, order ${orderId} ${order.currency}`,
      );
      return { outcome: 'MISMATCH', orderId };
    }
    const minor = (r: RefundRecord): number => Money.fromDecimal(r.amount, order.currency).minor;
    const refunds = await this.refunds.listForOrder(orderId, trx);
    const succeeded = refunds
      .filter((r) => r.status === 'SUCCEEDED')
      .reduce((s, r) => s + minor(r), 0);
    const delta = data.amountRefundedMinor - succeeded;
    if (delta === 0) return { outcome: 'DUPLICATE_EFFECT', orderId };
    if (delta < 0) {
      this.logger.error(
        `provider event ${event.id}: charge ${data.chargeId} reports ${data.amountRefundedMinor} refunded, we recorded ${succeeded}`,
      );
      return { outcome: 'MISMATCH', orderId };
    }
    const submitted = refunds.filter((r) => r.status === 'SUBMITTED');
    const submittedTotal = submitted.reduce((s, r) => s + minor(r), 0);
    const single = submitted.filter((r) => minor(r) === delta);
    const settle = submittedTotal === delta ? submitted : single.length === 1 ? single : [];
    if (settle.length === 0) {
      const inFlight = refunds
        .filter((r) => r.status === 'APPROVED')
        .reduce((s, r) => s + minor(r), 0);
      if (delta > submittedTotal + inFlight) {
        this.logger.error(
          `provider event ${event.id}: charge ${data.chargeId} refunded ${delta} more minor units than any refund we sent`,
        );
        return { outcome: 'ORPHAN', orderId };
      }
      // Ambiguous (or still being dispatched): the per-refund refund.updated settles it.
      return { outcome: 'IGNORED', orderId };
    }
    const ordered = [...settle].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const refund of ordered) {
      const locked = await this.refunds.lock(trx, refund.id);
      if (locked?.status !== 'SUBMITTED') {
        throw new Error(`refund ${refund.id} changed under the order lock`);
      }
    }
    for (const refund of ordered) {
      const done = await this.refunds.transition(trx, {
        refundId: refund.id,
        from: ['SUBMITTED'],
        to: 'SUCCEEDED',
        actorId: null,
        providerEventId: event.id,
      });
      if (!done.applied) throw new Error(`refund ${refund.id} left SUBMITTED under its lock`);
    }
    await this.refunds.applySucceededToOrder(trx, orderId);
    for (const refund of ordered) await this.lifecycle.succeeded(trx, refund.id);
    return { outcome: 'APPLIED', orderId };
  }

  /** APPROVED/SUBMITTED -> SUCCEEDED, the order status, `RefundSucceeded`. */
  private async succeed(
    trx: Transaction<DB>,
    refund: RefundRecord,
    eventId: string,
    providerRefundId: string,
  ): Promise<void> {
    const done = await this.refunds.transition(trx, {
      refundId: refund.id,
      from: ['APPROVED', 'SUBMITTED'],
      to: 'SUCCEEDED',
      actorId: null,
      providerRefundId,
      providerEventId: eventId,
    });
    if (!done.applied) throw new Error(`refund ${refund.id} left ${refund.status} under its lock`);
    await this.refunds.applySucceededToOrder(trx, refund.orderId);
    await this.lifecycle.succeeded(trx, refund.id);
  }
}
