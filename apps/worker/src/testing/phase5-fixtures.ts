import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { type DB, type Kysely, sql } from '@udemy/db';
import { createCategoryPair, createDraftCourse } from '@udemy/db/testing';
import type { EventHandlerContract } from '../messaging/event-handler.interface';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';

/**
 * Builders for the Phase 5 worker integration tests (real Postgres, dev compose stack). Events
 * are built in memory and processed with the real `IdempotentEventProcessor` under `it.`-prefixed
 * consumer names, so a running worker never claims them. Cleanup: `deleteTestData` from
 * `@udemy/db/testing` (Phase 5 rows of the users) plus `cleanupPhase5` for what is not user-linked.
 */

const AT = (): string => new Date().toISOString();

export function phase5Envelope(
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    aggregateType,
    aggregateId,
    occurredAt: AT(),
    version: 1,
    payload,
  };
}

export function registered(
  topic: string,
  eventType: string,
  consumerName: string,
  handler: EventHandlerContract,
): RegisteredEventHandler {
  return { topic, eventType, consumerName: `it.${consumerName}`, handler };
}

/** A DRAFT catalog course (title "Integration course") owned by `ownerId`, with its categories. */
export async function seedCourse(
  db: Kysely<DB>,
  ownerId: string,
): Promise<{ courseId: string; categoryIds: string[] }> {
  return db.transaction().execute(async (trx) => {
    const { rootId, childId } = await createCategoryPair(trx);
    const course = await createDraftCourse(trx, { ownerId, categoryId: childId });
    return { courseId: course.courseId, categoryIds: [childId, rootId] };
  });
}

export async function seedAnnouncement(
  db: Kysely<DB>,
  input: { courseId: string; authorId: string; sendEmail: boolean },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO engagement.announcements (course_id, author_id, title, body_md, send_email)
    VALUES (${input.courseId}, ${input.authorId}, 'Integration announcement', 'Body **md**', ${input.sendEmail})
    RETURNING id
  `.execute(db);
  return rows[0]!.id;
}

/**
 * What `deleteTestData` cannot find by user: outbox rows of certificates, the processed-event
 * claims of the test events, rating stats and fan-out jobs of the test courses.
 */
export async function cleanupPhase5(
  db: Kysely<DB>,
  input: { eventIds?: string[]; aggregateIds?: string[]; courseIds?: string[] },
): Promise<void> {
  const eventIds = input.eventIds ?? [];
  const aggregateIds = input.aggregateIds ?? [];
  const courseIds = input.courseIds ?? [];
  // Same superuser approach as deleteTestData: guards and privileges off for this transaction.
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (eventIds.length > 0) {
      await trx.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    if (aggregateIds.length > 0) {
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', aggregateIds).execute();
    }
    if (courseIds.length > 0) {
      await trx.deleteFrom('notifications.fanoutJobs').where('courseId', 'in', courseIds).execute();
      await sql`DELETE FROM engagement.course_rating_stats WHERE course_id = ANY(${courseIds}::uuid[])`.execute(
        trx,
      );
    }
  });
}
