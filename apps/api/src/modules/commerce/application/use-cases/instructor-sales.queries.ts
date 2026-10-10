import { Injectable } from '@nestjs/common';
import type { RecentSalePage, SalesSummary, SalesSummaryQuery } from '@udemy/contracts';
import { Money } from '../../domain/money';
import { CommerceSettings } from '../commerce-settings';
import { decodeOrderCursor, encodeOrderCursor } from '../order-cursor';
import { type SalesTotalsRecord, SalesRepository } from '../ports/sales.repository';

function totals(row: SalesTotalsRecord): SalesTotalsRecord {
  return {
    salesCount: row.salesCount,
    refundCount: row.refundCount,
    gross: row.gross,
    discounts: row.discounts,
    refunded: row.refunded,
    net: row.net,
    instructorShare: row.instructorShare,
  };
}

/**
 * `GET /instructor/sales/summary?from=&to=` (design §5 `GetSalesSummary`): the principal's own
 * lines only (`order_lines.instructor_id`; another instructor's courses are simply absent), in
 * the platform currency, with the SQL-generated 70% share. No buyer PII.
 */
@Injectable()
export class GetSalesSummaryQuery {
  constructor(
    private readonly sales: SalesRepository,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(instructorId: string, query: SalesSummaryQuery): Promise<SalesSummary> {
    const summary = await this.sales.summary(instructorId, {
      from: new Date(query.from),
      to: new Date(query.to),
    });
    return {
      from: new Date(query.from).toISOString(),
      to: new Date(query.to).toISOString(),
      currency: Money.zero(this.settings.currency).currency,
      totals: totals(summary.totals),
      courses: summary.courses.map((c) => ({
        ...totals(c),
        courseId: c.courseId,
        courseTitle: c.courseTitle,
      })),
    };
  }
}

/** `GET /instructor/sales?courseId=&cursor=` (design §5 `ListRecentSales`): newest first. */
@Injectable()
export class ListRecentSalesQuery {
  constructor(private readonly sales: SalesRepository) {}

  /** @throws ValidationError (422) for a cursor this api did not produce */
  async execute(
    instructorId: string,
    query: { readonly courseId?: string; readonly cursor?: string; readonly limit: number },
  ): Promise<RecentSalePage> {
    const after = query.cursor === undefined ? undefined : decodeOrderCursor(query.cursor);
    const rows = await this.sales.recent(instructorId, {
      ...(query.courseId === undefined ? {} : { courseId: query.courseId }),
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => {
        const final = Money.fromDecimal(r.finalAmount, r.currency);
        return {
          orderLineId: r.orderLineId,
          paidAt: r.paidAt.toISOString(),
          courseId: r.courseId,
          courseTitle: r.courseTitle,
          currency: final.currency,
          listAmount: r.listAmount,
          finalAmount: final.toDecimal(),
          couponCode: r.couponCode,
          instructorShareAmount: r.instructorShareAmount,
          refunded: r.refunded,
        };
      }),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeOrderCursor(last.keyset) : null,
    };
  }
}
