import { Injectable } from '@nestjs/common';
import type { Receipt } from '@udemy/contracts';
import { OrderViews } from '../order-views.service';

/** `GetReceipt` (design §5): number, date, lines, discounts, total, buyer name; no card data. */
@Injectable()
export class GetReceiptQuery {
  constructor(private readonly views: OrderViews) {}

  /**
   * @throws OrderNotFound (404) for an unknown or foreign order
   * @throws OrderNotPaid (409) before payment
   */
  execute(input: { readonly userId: string; readonly orderId: string }): Promise<Receipt> {
    return this.views.receipt(input.orderId, input.userId);
  }
}
