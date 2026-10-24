import { Injectable } from '@nestjs/common';
import { type DB, sql, type Transaction } from '@udemy/db';

/**
 * Suspends / reinstates the learner's live review of a course (design D9, D10: reviews from
 * non-customers do not count). State-guarded single statements (`suspended_at IS [NOT] NULL`),
 * so a redelivery changes nothing; a deleted review is frozen (`reviews_immutable_ck`) and never
 * matched. `suspended_at` is SQL now().
 */
@Injectable()
export class ReviewSuspension {
  /** The suspended review id, or null when there was nothing to suspend. */
  async suspend(trx: Transaction<DB>, userId: string, courseId: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      UPDATE engagement.reviews SET suspended_at = now()
       WHERE course_id = ${courseId} AND user_id = ${userId} AND deleted_at IS NULL AND suspended_at IS NULL
      RETURNING id
    `.execute(trx);
    return rows[0]?.id ?? null;
  }

  /** The reinstated review id, or null when there was nothing to reinstate. */
  async reinstate(trx: Transaction<DB>, userId: string, courseId: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      UPDATE engagement.reviews SET suspended_at = NULL
       WHERE course_id = ${courseId} AND user_id = ${userId} AND deleted_at IS NULL AND suspended_at IS NOT NULL
      RETURNING id
    `.execute(trx);
    return rows[0]?.id ?? null;
  }
}
