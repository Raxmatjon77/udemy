import { Injectable } from '@nestjs/common';
import type { OrderDetail } from '@udemy/contracts';
import { OrderViews } from '../order-views.service';

/** `GetMyOrder` (design §5): lines with their refund state, payment status, resume url. */
@Injectable()
export class GetMyOrderQuery {
  constructor(private readonly views: OrderViews) {}

  /** @throws OrderNotFound (404) for an unknown or foreign order */
  execute(input: { readonly userId: string; readonly orderId: string }): Promise<OrderDetail> {
    return this.views.detail(input.orderId, input.userId);
  }
}
