import { Injectable } from '@nestjs/common';
import type { AdminRefundQueuePage, RefundStatus } from '@udemy/contracts';
import { consumptionKey, CourseConsumptionViews } from '../learning-consumption.policy';
import { CommerceAdminDirectory } from '../ports/context-gateways';
import { RefundRepository } from '../ports/refund.repository';
import { decodeRefundCursor, encodeRefundCursor } from '../refund-cursor';
import { toQueueItem } from '../refund-views';

export interface ListRefundQueueInput {
  /** Any refund status (P4-T16); REQUESTED and FAILED are the work queues. */
  readonly status: RefundStatus;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `GET /admin/refunds` (design §8): refunds in one status, oldest first `(created_at, id)`,
 * with the order number, the buyer (email included), the D11 `recentRefundCount` as the
 * auto-approve rule saw it, the recorded `reviewReason` and the buyer's current consumption of
 * the course (Phase 5 D8, one learning read per distinct buyer and course on the page).
 */
@Injectable()
export class ListRefundQueueQuery {
  constructor(
    private readonly refunds: RefundRepository,
    private readonly directory: CommerceAdminDirectory,
    private readonly consumption: CourseConsumptionViews,
  ) {}

  /** @throws ValidationError (422) for a cursor this api did not produce */
  async execute(input: ListRefundQueueInput): Promise<AdminRefundQueuePage> {
    const after = input.cursor === undefined ? undefined : decodeRefundCursor(input.cursor);
    const rows = await this.refunds.listByStatus(input.status, {
      ...(after === undefined ? {} : { after }),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const accounts = await this.directory.findAccounts([...new Set(page.map((r) => r.userId))]);
    const consumption = await this.consumption.ofMany(page);
    const last = page.at(-1);
    return {
      items: page.map((r) => {
        const figures = consumption.get(consumptionKey(r.userId, r.courseId));
        if (figures === undefined) throw new Error(`no consumption read for refund ${r.id}`);
        return toQueueItem(r, r.recentRefundCount, accounts, figures);
      }),
      nextCursor:
        rows.length > input.limit && last !== undefined ? encodeRefundCursor(last.keyset) : null,
    };
  }
}
