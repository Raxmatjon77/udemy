import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type CoursePriceRecord,
  type PriceChange,
  type PriceChangeRecord,
  PricingRepository,
} from '../application/ports/pricing.repository';
import { mapCommerceConstraints } from './commerce-constraint-errors';

@Injectable()
export class KyselyPricingRepository extends PricingRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findPrice(courseId: string, ex: Executor = this.db): Promise<CoursePriceRecord | null> {
    const row = await ex
      .selectFrom('commerce.coursePrices')
      .select(['courseId', 'amount', 'currency', 'updatedBy', 'updatedAt'])
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row ?? null;
  }

  async findPrices(
    courseIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<CoursePriceRecord[]> {
    if (courseIds.length === 0) return [];
    return ex
      .selectFrom('commerce.coursePrices')
      .select(['courseId', 'amount', 'currency', 'updatedBy', 'updatedAt'])
      .where('courseId', 'in', [...courseIds])
      .execute();
  }

  async listHistory(
    courseId: string,
    limit: number,
    ex: Executor = this.db,
  ): Promise<PriceChangeRecord[]> {
    // lag() runs over the whole history BEFORE the LIMIT, so the oldest listed entry still
    // gets its true previous amount (schema doc: "previous amount = lag(amount)").
    const { rows } = await sql<PriceChangeRecord>`
      SELECT id, course_id, lag(amount) OVER (ORDER BY changed_at, id) AS previous_amount,
             amount, currency, changed_by, changed_at
        FROM commerce.course_price_changes
       WHERE course_id = ${courseId}
       ORDER BY changed_at DESC, id DESC
       LIMIT ${limit}
    `.execute(ex);
    return rows;
  }

  upsertPrice(
    trx: Transaction<DB>,
    price: { courseId: string; amount: string; currency: string; updatedBy: string },
  ): Promise<PriceChange | null> {
    return mapCommerceConstraints(async () => {
      // PG 18 `RETURNING old.*`: NULL for the first price. The IS DISTINCT guard turns an
      // unchanged price into "no row" (course_prices_noop_update_ck can never fire).
      const { rows } = await sql<PriceChange>`
        INSERT INTO commerce.course_prices AS p (course_id, amount, currency, updated_by)
        VALUES (${price.courseId}, ${price.amount}::numeric, ${price.currency}, ${price.updatedBy})
        ON CONFLICT (course_id) DO UPDATE
           SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_by = EXCLUDED.updated_by
         WHERE (p.amount, p.currency) IS DISTINCT FROM (EXCLUDED.amount, EXCLUDED.currency)
        RETURNING old.amount AS previous_amount, new.amount, new.currency, new.updated_at AS changed_at
      `.execute(trx);
      return rows[0] ?? null;
    });
  }

  async lockPrice(trx: Transaction<DB>, courseId: string): Promise<CoursePriceRecord | null> {
    const row = await trx
      .selectFrom('commerce.coursePrices')
      .select(['courseId', 'amount', 'currency', 'updatedBy', 'updatedAt'])
      .where('courseId', '=', courseId)
      .forUpdate()
      .executeTakeFirst();
    return row ?? null;
  }
}
