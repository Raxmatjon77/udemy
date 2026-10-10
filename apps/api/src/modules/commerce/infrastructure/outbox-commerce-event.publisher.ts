import { Injectable } from '@nestjs/common';
import {
  CouponCreated,
  type CouponCreatedPayload,
  CouponDeactivated,
  type CouponDeactivatedPayload,
  CoursePriceChanged,
  type CoursePriceChangedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { CommerceEventPublisher } from '../application/ports/commerce-event.publisher';

/** Commerce events through the transactional outbox (topic = aggregate type). */
@Injectable()
export class OutboxCommerceEventPublisher extends CommerceEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async coursePriceChanged(
    trx: Transaction<DB>,
    payload: CoursePriceChangedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, CoursePriceChanged, payload.courseId, payload);
  }

  async couponCreated(trx: Transaction<DB>, payload: CouponCreatedPayload): Promise<void> {
    await this.outbox.publish(trx, CouponCreated, payload.couponId, payload);
  }

  async couponDeactivated(trx: Transaction<DB>, payload: CouponDeactivatedPayload): Promise<void> {
    await this.outbox.publish(trx, CouponDeactivated, payload.couponId, payload);
  }
}
