import { Injectable } from '@nestjs/common';
import { type Executor, sql } from '@udemy/db';
import { CommerceClock } from '../application/ports/commerce-clock';

/** `SELECT now()` on the caller's executor (the transaction start time inside a transaction). */
@Injectable()
export class DatabaseCommerceClock extends CommerceClock {
  async now(ex: Executor): Promise<Date> {
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(ex);
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('SELECT now() returned no row');
    return now;
  }
}
