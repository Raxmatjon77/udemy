import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { CoursePriceReader } from '../application/ports/course-price.reader';

/**
 * Reads the one `commerce.course_prices` row of a course (primary key lookup), read-only.
 *
 * The one place enrollment reads another context's table, on purpose: commerce owns the price
 * and depends on enrollment (D8), so enrollment cannot call a commerce facade without a module
 * cycle. Same precedent as the worker's cross-context readers (design finding 10). The amount
 * stays the decimal string Postgres returns (never a float).
 */
@Injectable()
export class KyselyCoursePriceReader extends CoursePriceReader {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findPriceAmount(courseId: string, ex?: Executor): Promise<string | null> {
    const row = await (ex ?? this.db)
      .selectFrom('commerce.coursePrices')
      .select('amount')
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row?.amount ?? null;
  }
}
