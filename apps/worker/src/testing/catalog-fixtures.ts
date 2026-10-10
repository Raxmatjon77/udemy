import { randomBytes } from 'node:crypto';
import { type DB, type Kysely, sql } from '@udemy/db';

/**
 * Minimal committed catalog/media rows for worker integration tests (removed afterwards with
 * `deleteTestData`). Mirrors what the api's use cases write, without going through the api.
 */

/** CreateCourse: a DRAFT course plus its CREATE transition (checked at COMMIT). */
export async function seedDraftCourse(
  db: Kysely<DB>,
  options: { ownerId: string; title: string },
): Promise<{ courseId: string; slug: string }> {
  const slug = `it-worker-${randomBytes(5).toString('hex')}`;
  const courseId = await db.transaction().execute(async (trx) => {
    const course = await trx
      .insertInto('catalog.courses')
      .values({ ownerId: options.ownerId, slug, title: options.title })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('catalog.courseTransitions')
      .values({
        courseId: course.id,
        prevTransitionId: null,
        action: 'CREATE',
        fromStatus: null,
        toStatus: 'DRAFT',
        actorId: options.ownerId,
      })
      .execute();
    return course.id;
  });
  return { courseId, slug };
}

/** A section with one VIDEO lecture that references `mediaAssetId`. */
export async function seedVideoLecture(
  db: Kysely<DB>,
  options: { courseId: string; title: string; mediaAssetId: string },
): Promise<string> {
  const section = await db
    .insertInto('catalog.sections')
    .values({ courseId: options.courseId, position: 0, title: 'Section one' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const lecture = await db
    .insertInto('catalog.lectures')
    .values({
      courseId: options.courseId,
      sectionId: section.id,
      position: 0,
      type: 'VIDEO',
      title: options.title,
      mediaAssetId: options.mediaAssetId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return lecture.id;
}

/** A LECTURE_VIDEO asset walked UPLOADING -> `stage` through the legal edges. */
export async function seedVideoAsset(
  db: Kysely<DB>,
  options: { id: string; ownerId: string; stage: 'UPLOADED' | 'FAILED'; filename?: string },
): Promise<void> {
  const { id, ownerId } = options;
  await db
    .insertInto('media.assets')
    .values({
      id,
      ownerId,
      purpose: 'LECTURE_VIDEO',
      originalFilename: options.filename ?? 'clip.mp4',
      declaredContentType: 'video/mp4',
      declaredSizeBytes: '1000',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 1,
      sourceKey: `uploads/${ownerId}/${id}/source`,
      s3UploadId: `it-${id}`,
    })
    .execute();
  await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${id}`.execute(
    db,
  );
  if (options.stage === 'UPLOADED') return;
  await sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${id}`.execute(db);
  await sql`
    UPDATE media.assets SET status = 'FAILED', failure_code = 'TOO_LONG', failed_at = now()
     WHERE id = ${id}
  `.execute(db);
}
