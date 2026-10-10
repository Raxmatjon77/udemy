import { Injectable } from '@nestjs/common';
import type { OrderSummaryPage } from '@udemy/contracts';
import { decodeOrderCursor, encodeOrderCursor } from '../order-cursor';
import { OrderViews } from '../order-views.service';
import { OrderRepository } from '../ports/order.repository';

export interface ListMyOrdersInput {
  readonly userId: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** `ListMyOrders` (design §5): the buyer's orders, keyset `(placed_at DESC, id DESC)`. */
@Injectable()
export class ListMyOrdersQuery {
  constructor(
    private readonly orders: OrderRepository,
    private readonly views: OrderViews,
  ) {}

  /** @throws ValidationError (422) for a cursor this api did not produce */
  async execute(input: ListMyOrdersInput): Promise<OrderSummaryPage> {
    const after = input.cursor === undefined ? undefined : decodeOrderCursor(input.cursor);
    const rows = await this.orders.listForUser(input.userId, {
      ...(after === undefined ? {} : { after }),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.views.summary(row)),
      nextCursor:
        rows.length > input.limit && last !== undefined ? encodeOrderCursor(last.keyset) : null,
    };
  }
}
