import { randomUUID } from 'node:crypto';
import { type DB, type Executor, type Kysely, sql } from '@udemy/db';
import { deleteTestUsers } from '../../../testing/integration';

/**
 * Integration-test support for catalog (IT conventions of `src/testing/integration.ts`): every
 * file owns its data. Users get fresh emails, categories a per-file slug tag, and cleanup
 * removes exactly the rows reachable from the tracked owners and categories.
 */

/** A user row (course/asset owner FK) without going through signup. */
export async function insertCatalogTestUser(db: Kysely<DB>, label: string): Promise<string> {
  const row = await db
    .insertInto('identity.users')
    .values({
      email: `catalog-it-${label}-${randomUUID().slice(0, 12)}@example.test`,
      displayName: `Catalog IT ${label}`,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$bm90LWEtcmVhbC1oYXNo$bm90LWEtcmVhbC1oYXNo',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export type TestAssetPurpose = 'LECTURE_VIDEO' | 'LECTURE_RESOURCE' | 'COURSE_THUMBNAIL';

/**
 * A media asset row walked through the legal status edges up to READY (or left UPLOADED), as
 * the upload flow and the transcoder would leave it. No S3 objects are involved: catalog only
 * reads the row and writes usages.
 */
export async function insertTestAsset(
  ex: Executor,
  options: {
    ownerId: string;
    purpose: TestAssetPurpose;
    stage?: 'UPLOADED' | 'READY';
    durationMs?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const { ownerId, purpose } = options;
  await ex
    .insertInto('media.assets')
    .values({
      id,
      ownerId,
      purpose,
      originalFilename: purpose === 'LECTURE_RESOURCE' ? 'notes.pdf' : 'clip.mp4',
      declaredContentType: purpose === 'LECTURE_RESOURCE' ? 'application/pdf' : 'video/mp4',
      declaredSizeBytes: '10000000',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 2,
      sourceKey: `uploads/${ownerId}/${id}/source`,
      s3UploadId: `catalog-it-${id}`,
    })
    .execute();
  await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${id}`.execute(
    ex,
  );
  if (options.stage === 'UPLOADED') return id;
  await sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${id}`.execute(ex);
  await sql`
    UPDATE media.assets
       SET status = 'READY', output_prefix = ${`assets/${id}/a1/`}, ready_at = now(),
           duration_ms = ${purpose === 'LECTURE_VIDEO' ? (options.durationMs ?? 60_000) : null},
           width = ${purpose === 'LECTURE_RESOURCE' ? null : 1280},
           height = ${purpose === 'LECTURE_RESOURCE' ? null : 720}
     WHERE id = ${id}
  `.execute(ex);
  return id;
}

/**
 * Bypasses the lifecycle guards (superuser, `session_replication_role = replica`: no triggers,
 * no FK checks) to put a course into a state only P2-T10 can reach: a pending revision
 * (`IN_REVIEW`) or a first publication (`PUBLISHED`).
 */
export async function forceCourseState(
  db: Kysely<DB>,
  courseId: string,
  state: 'IN_REVIEW' | 'PUBLISHED' | 'DRAFT',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (state === 'IN_REVIEW') {
      await sql`UPDATE catalog.courses SET status = 'IN_REVIEW', pending_revision_id = uuidv7() WHERE id = ${courseId}`.execute(
        trx,
      );
    } else if (state === 'PUBLISHED') {
      await sql`
        UPDATE catalog.courses
           SET status = 'PUBLISHED', pending_revision_id = NULL, published_revision_id = uuidv7(),
               first_published_at = now()
         WHERE id = ${courseId}`.execute(trx);
    } else {
      await sql`
        UPDATE catalog.courses
           SET status = 'DRAFT', pending_revision_id = NULL, published_revision_id = NULL,
               first_published_at = NULL
         WHERE id = ${courseId}`.execute(trx);
    }
  });
}

/**
 * Removes everything catalog tests wrote for these owners (courses with their children,
 * revisions, transitions, outbox events), the tracked categories, the owners' media rows, then the users.
 * Needs a superuser: replica mode disables the append-only and deferred guards for this
 * transaction only.
 */
export async function deleteCatalogTestData(
  db: Kysely<DB>,
  options: {
    ownerIds: readonly string[];
    categoryIds?: readonly string[];
    /** Default true; the e2e harness deletes its users itself. */
    deleteUsers?: boolean;
  },
): Promise<void> {
  const owners = [...new Set(options.ownerIds)];
  const categories = [...new Set(options.categoryIds ?? [])];
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (owners.length > 0) {
      const courses = (
        await trx
          .selectFrom('catalog.courses')
          .select('id')
          .where('ownerId', 'in', owners)
          .execute()
      ).map((c) => c.id);
      if (courses.length > 0) {
        await trx.deleteFrom('outbox.events').where('aggregateId', 'in', courses).execute();
        await trx
          .deleteFrom('catalog.courseTransitions')
          .where('courseId', 'in', courses)
          .execute();
        // Revision snapshots (P2-T10); the course pointers are dropped with the courses below.
        const revisions = trx
          .selectFrom('catalog.courseRevisions')
          .select('id')
          .where('courseId', 'in', courses);
        // Phase 5 quiz snapshots (FK children of revision_lectures; no cascade in replica mode)
        await trx
          .deleteFrom('catalog.revisionQuizOptions')
          .where('revisionId', 'in', revisions)
          .execute();
        await trx
          .deleteFrom('catalog.revisionQuizQuestions')
          .where('revisionId', 'in', revisions)
          .execute();
        await trx
          .deleteFrom('catalog.revisionLectures')
          .where('revisionId', 'in', revisions)
          .execute();
        await trx
          .deleteFrom('catalog.revisionSections')
          .where('revisionId', 'in', revisions)
          .execute();
        await trx
          .deleteFrom('catalog.revisionBullets')
          .where('revisionId', 'in', revisions)
          .execute();
        await trx.deleteFrom('catalog.courseRevisions').where('courseId', 'in', courses).execute();
        // Phase 5 quiz working copy (replica mode skips the ON DELETE CASCADE triggers)
        const courseLectures = trx
          .selectFrom('catalog.lectures')
          .select('id')
          .where('courseId', 'in', courses);
        await trx
          .deleteFrom('catalog.quizOptions')
          .where('questionId', 'in', (eb) =>
            eb
              .selectFrom('catalog.quizQuestions')
              .select('id')
              .where('lectureId', 'in', courseLectures),
          )
          .execute();
        await trx
          .deleteFrom('catalog.quizQuestions')
          .where('lectureId', 'in', courseLectures)
          .execute();
        await trx
          .deleteFrom('catalog.lectureQuizzes')
          .where('lectureId', 'in', courseLectures)
          .execute();
        await trx
          .deleteFrom('catalog.lectureArticles')
          .where('lectureId', 'in', (eb) =>
            eb.selectFrom('catalog.lectures').select('id').where('courseId', 'in', courses),
          )
          .execute();
        await trx.deleteFrom('catalog.lectures').where('courseId', 'in', courses).execute();
        await trx.deleteFrom('catalog.sections').where('courseId', 'in', courses).execute();
        await trx.deleteFrom('catalog.courseBullets').where('courseId', 'in', courses).execute();
        await trx.deleteFrom('catalog.courses').where('id', 'in', courses).execute();
      }
      const assets = (
        await trx.selectFrom('media.assets').select('id').where('ownerId', 'in', owners).execute()
      ).map((a) => a.id);
      if (assets.length > 0) {
        await trx.deleteFrom('outbox.events').where('aggregateId', 'in', assets).execute();
        await trx.deleteFrom('media.assetUsages').where('assetId', 'in', assets).execute();
        await trx.deleteFrom('media.assets').where('id', 'in', assets).execute();
      }
    }
    if (categories.length > 0) {
      // Leaves first (self-FK), though FK checks are off in replica mode anyway.
      await trx
        .deleteFrom('catalog.categories')
        .where('id', 'in', categories)
        .where('depth', '=', 2)
        .execute();
      await trx.deleteFrom('catalog.categories').where('id', 'in', categories).execute();
    }
  });
  if (owners.length > 0 && options.deleteUsers !== false) await deleteTestUsers(db, owners);
}
