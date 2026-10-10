import { type DB, type Kysely, sql } from '@udemy/db';
import type { ObjectStorage } from '@udemy/storage';
import { AddLectureCommand } from '../../catalog/application/use-cases/add-lecture.command';
import { AddSectionCommand } from '../../catalog/application/use-cases/add-section.command';
import { ApproveRevisionCommand } from '../../catalog/application/use-cases/approve-revision.command';
import { AttachLectureMediaCommand } from '../../catalog/application/use-cases/attach-lecture-media.command';
import { CreateCategoryCommand } from '../../catalog/application/use-cases/create-category.command';
import { CreateCourseCommand } from '../../catalog/application/use-cases/create-course.command';
import { SetCourseThumbnailCommand } from '../../catalog/application/use-cases/set-course-thumbnail.command';
import { SubmitCourseCommand } from '../../catalog/application/use-cases/submit-course.command';
import { UpdateCourseCommand } from '../../catalog/application/use-cases/update-course.command';
import { UpdateLectureCommand } from '../../catalog/application/use-cases/update-lecture.command';
import { insertReadyThumbnail, insertReadyVideo } from '../../catalog/testing/catalog-public-it';

/**
 * Integration/e2e support for enrollment (IT conventions of `src/testing/integration.ts`): every
 * file owns its data. Courses are published through the real catalog use cases (submit, then
 * approve), with READY media whose objects exist in MinIO, so the real playback path runs.
 * Readiness thresholds come from the catalog-public env (1 lecture, 0 s of video).
 */

type Resolve = <T>(token: abstract new (...args: never[]) => T) => T;

export interface PublishedTestCourse {
  readonly courseId: string;
  readonly slug: string;
  readonly revisionId: string;
  readonly title: string;
  readonly previewVideoId: string;
  /** A NON-preview video lecture of the live revision (entitlement-gated). */
  readonly lockedVideoId: string;
}

/** A group + leaf category for the file's courses (ids returned for cleanup). */
export async function createTestCategory(get: Resolve, tag: string): Promise<string[]> {
  const group = await get(CreateCategoryCommand).execute({ name: `Enroll IT ${tag}` });
  const leaf = await get(CreateCategoryCommand).execute({
    name: `Enroll IT leaf ${tag}`,
    parentId: group.id,
  });
  return [leaf.id, group.id];
}

/** A course with a preview video and a locked video, submitted and approved (PUBLISHED). */
export async function publishTestCourse(
  get: Resolve,
  db: Kysely<DB>,
  storage: ObjectStorage,
  options: { ownerId: string; adminId: string; categoryId: string; title: string },
): Promise<PublishedTestCourse> {
  const { ownerId } = options;
  const course = await get(CreateCourseCommand).execute({ ownerId, title: options.title });
  const as = { actorId: ownerId, courseId: course.id };
  await get(UpdateCourseCommand).execute({
    ...as,
    changes: {
      subtitle: 'A subtitle for the course',
      descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
      language: 'en',
      level: 'BEGINNER',
      categoryId: options.categoryId,
      outcomes: ['One', 'Two', 'Three', 'Four'],
    },
  });
  await get(SetCourseThumbnailCommand).execute({
    ...as,
    assetId: await insertReadyThumbnail(db, storage, ownerId),
  });
  const section = await get(AddSectionCommand).execute({ ...as, title: 'Section one' });
  const addVideo = async (title: string): Promise<string> => {
    const lecture = await get(AddLectureCommand).execute({
      ...as,
      sectionId: section.id,
      type: 'VIDEO',
      title,
    });
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: lecture.id,
      assetId: await insertReadyVideo(db, storage, ownerId),
    });
    return lecture.id;
  };
  const previewVideoId = await addVideo('Preview video');
  await get(UpdateLectureCommand).execute({
    ...as,
    lectureId: previewVideoId,
    patch: { isPreview: true },
  });
  const lockedVideoId = await addVideo('Locked video');
  const { revisionId } = await get(SubmitCourseCommand).execute(as);
  const detail = await get(ApproveRevisionCommand).execute({
    actorId: options.adminId,
    courseId: course.id,
    revisionId,
  });
  if (detail.status !== 'PUBLISHED') throw new Error(`course ${course.id} is ${detail.status}`);
  return {
    courseId: course.id,
    slug: detail.slug,
    revisionId,
    title: options.title,
    previewVideoId,
    lockedVideoId,
  };
}

/** Sets the course price as commerce would (0.00 = free); the history trigger records it. */
export async function setTestCoursePrice(
  db: Kysely<DB>,
  courseId: string,
  amount: string,
  updatedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO commerce.course_prices (course_id, amount, currency, updated_by)
    VALUES (${courseId}, ${amount}::numeric, 'USD', ${updatedBy})
    ON CONFLICT (course_id) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by
     WHERE course_prices.amount IS DISTINCT FROM EXCLUDED.amount
  `.execute(db);
}

/** The enrollment ids of these users (for event assertions and cleanup). */
export async function enrollmentIdsOf(
  db: Kysely<DB>,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .selectFrom('enrollment.enrollments')
    .select('id')
    .where('userId', 'in', [...userIds])
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Removes everything enrollment tests wrote: the users' enrollments with their (append-only)
 * transitions and outbox events, plus the prices of the given courses. Needs a superuser:
 * replica mode disables the append-only, no-delete and deferred guards for this transaction.
 * Run it BEFORE the users are deleted.
 */
export async function deleteEnrollmentTestData(
  db: Kysely<DB>,
  options: { userIds: readonly string[]; courseIds?: readonly string[] },
): Promise<void> {
  const users = [...new Set(options.userIds)];
  const courses = [...new Set(options.courseIds ?? [])];
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (users.length > 0) {
      const ids = (
        await trx
          .selectFrom('enrollment.enrollments')
          .select('id')
          .where('userId', 'in', users)
          .execute()
      ).map((r) => r.id);
      if (ids.length > 0) {
        await trx.deleteFrom('outbox.events').where('aggregateId', 'in', ids).execute();
        await trx
          .deleteFrom('enrollment.enrollmentTransitions')
          .where('enrollmentId', 'in', ids)
          .execute();
        await trx.deleteFrom('enrollment.enrollments').where('id', 'in', ids).execute();
      }
    }
    if (courses.length > 0) {
      await trx
        .deleteFrom('commerce.coursePriceChanges')
        .where('courseId', 'in', courses)
        .execute();
      await trx.deleteFrom('commerce.coursePrices').where('courseId', 'in', courses).execute();
    }
  });
}
