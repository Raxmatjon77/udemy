import { Injectable } from '@nestjs/common';
import {
  ADMIN_ORDER_BUYER_MATCH_LIMIT,
  type AdminOrderPage,
  type AdminOrdersQuery,
} from '@udemy/contracts';
import { AdminOrderViews } from '../admin-order-views.service';
import { decodeOrderCursor, encodeOrderCursor } from '../order-cursor';
import { AdminOrderRepository } from '../ports/admin-order.repository';
import { CommerceAdminDirectory } from '../ports/context-gateways';

/**
 * `GET /admin/orders` (design §8, §10 web-admin): newest first, every filter ANDed. The
 * buyer-email filter resolves at most `ADMIN_ORDER_BUYER_MATCH_LIMIT` matching accounts
 * through identity (commerce never reads identity tables); no match is an empty page.
 */
@Injectable()
export class SearchAdminOrdersQuery {
  constructor(
    private readonly adminOrders: AdminOrderRepository,
    private readonly directory: CommerceAdminDirectory,
    private readonly views: AdminOrderViews,
  ) {}

  /** @throws ValidationError (422) for a cursor this api did not produce */
  async execute(query: AdminOrdersQuery): Promise<AdminOrderPage> {
    const after = query.cursor === undefined ? undefined : decodeOrderCursor(query.cursor);
    const userIdIn =
      query.buyerEmail === undefined
        ? undefined
        : await this.directory.searchIdsByEmail(query.buyerEmail, ADMIN_ORDER_BUYER_MATCH_LIMIT);
    const rows = await this.adminOrders.search(
      {
        ...(query.q === undefined ? {} : { orderNumber: query.q }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        ...(userIdIn === undefined ? {} : { userIdIn }),
        ...(query.courseId === undefined ? {} : { courseId: query.courseId }),
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      },
      { ...(after === undefined ? {} : { after }), limit: query.limit + 1 },
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.views.rows(page),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeOrderCursor(last.keyset) : null,
    };
  }
}
