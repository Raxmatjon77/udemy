/**
 * Enrollment <-> commerce consistency (docs/phase-4-schema-design.md §8.8): the cross-schema
 * links the DB cannot enforce (D12). Both must return nothing; run them in integration tests and
 * as an ops check. `userIds` scopes them (tests on a shared database); omit it for the full scan.
 */
import { sql } from 'kysely';
import type { Executor } from '../transaction';

function userScope(column: string, userIds: readonly string[] | undefined) {
  return userIds === undefined ? sql`` : sql`AND ${sql.ref(column)} = ANY(${[...userIds]}::uuid[])`;
}

/** ORDER enrollments whose line is not a paid line of the same user and course. */
export async function findOrderEnrollmentsWithoutPaidLine(
  executor: Executor,
  options: { userIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT e.id FROM enrollment.enrollments e
     WHERE e.source = 'ORDER' ${userScope('e.user_id', options.userIds)}
       AND NOT EXISTS (SELECT 1 FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
                        WHERE l.id = e.order_line_id AND o.user_id = e.user_id AND l.course_id = e.course_id
                          AND o.paid_at IS NOT NULL)
     ORDER BY e.id
  `.execute(executor);
  return rows.map((r) => r.id);
}

/** ACTIVE enrollments whose granting line has an APPROVED/SUBMITTED/SUCCEEDED refund (should be revoked). */
export async function findActiveEnrollmentsWithLiveRefund(
  executor: Executor,
  options: { userIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT DISTINCT e.id FROM enrollment.enrollments e JOIN commerce.refunds r ON r.order_line_id = e.order_line_id
     WHERE e.status = 'ACTIVE' AND r.status IN ('APPROVED','SUBMITTED','SUCCEEDED') ${userScope('e.user_id', options.userIds)}
     ORDER BY e.id
  `.execute(executor);
  return rows.map((r) => r.id);
}
