import { Injectable } from '@nestjs/common';
import type { AdminOrderDetail } from '@udemy/contracts';
import { AdminOrderViews } from '../admin-order-views.service';

/** `GET /admin/orders/:orderId` (design §8): the full admin view with the merged timeline. */
@Injectable()
export class GetAdminOrderQuery {
  constructor(private readonly views: AdminOrderViews) {}

  /** @throws OrderNotFound (404) */
  execute(orderId: string): Promise<AdminOrderDetail> {
    return this.views.detail(orderId);
  }
}
