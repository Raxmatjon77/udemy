import { Injectable } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';

/** Links in commerce mails: the app routes of Phase 4 design §10 (origins validated at startup). */
@Injectable()
export class CommerceLinks {
  constructor(private readonly config: WorkerConfigService) {}

  /** The printable receipt (`web-student` `/account/orders/[id]/receipt`). */
  receipt(orderId: string): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}/account/orders/${encodeURIComponent(orderId)}/receipt`;
  }

  /** The order detail with its refund timeline (`web-student` `/account/orders/[id]`). */
  order(orderId: string): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}/account/orders/${encodeURIComponent(orderId)}`;
  }

  /** The admin order detail (`web-admin` `/orders/[id]`): payment, provider events, refunds. */
  adminOrder(orderId: string): string {
    return `${this.config.get('ADMIN_APP_ORIGIN')}/orders/${encodeURIComponent(orderId)}`;
  }

  /** The admin refund queues (`web-admin` `/refunds`: REQUESTED and FAILED). */
  adminRefunds(): string {
    return `${this.config.get('ADMIN_APP_ORIGIN')}/refunds`;
  }
}
