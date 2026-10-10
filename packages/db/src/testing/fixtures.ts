import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor } from '../transaction';

/** Test-data builders for catalog/media integration tests. Every row is unique per call. */

export function uniqueSuffix(): string {
  return randomBytes(5).toString('hex');
}

export async function createUser(ex: Executor): Promise<string> {
  const row = await ex
    .insertInto('identity.users')
    .values({
      email: `it-db-${uniqueSuffix()}@example.test`,
      displayName: 'IT db user',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aXQ$aXQ',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

// ------------------------------------------------------------------------------------ media

export type AssetPurpose = 'LECTURE_VIDEO' | 'LECTURE_RESOURCE' | 'COURSE_THUMBNAIL';
export type AssetStage = 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY';

export const PART_SIZE = 5 * 1024 * 1024;

/** Inserts an UPLOADING asset and walks it through the legal edges up to `stage`. */
export async function createAsset(
  ex: Executor,
  opts: { ownerId: string; purpose?: AssetPurpose; stage?: AssetStage; createdAt?: Date },
): Promise<string> {
  const id = randomUUID();
  const purpose = opts.purpose ?? 'LECTURE_VIDEO';
  const stage = opts.stage ?? 'UPLOADED';
  await ex
    .insertInto('media.assets')
    .values({
      id,
      ownerId: opts.ownerId,
      purpose,
      originalFilename: 'clip.mp4',
      declaredContentType: purpose === 'LECTURE_VIDEO' ? 'video/mp4' : 'image/png',
      declaredSizeBytes: '10000000',
      partSizeBytes: PART_SIZE,
      partCount: 2,
      sourceKey: `uploads/${opts.ownerId}/${id}/source`,
      s3UploadId: `it-upload-${id}`,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .execute();
  if (stage === 'UPLOADING') return id;
  await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${id}`.execute(
    ex,
  );
  if (stage === 'UPLOADED') return id;
  await sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${id}`.execute(ex);
  if (stage === 'PROCESSING') return id;
  await sql`
    UPDATE media.assets
       SET status = 'READY', output_prefix = ${`assets/${id}/a1/`}, ready_at = now(),
           duration_ms = ${purpose === 'LECTURE_VIDEO' ? 60_000 : null},
           width = ${purpose === 'LECTURE_RESOURCE' ? null : 1280},
           height = ${purpose === 'LECTURE_RESOURCE' ? null : 720}
     WHERE id = ${id}
  `.execute(ex);
  return id;
}

export async function assetRow(ex: Executor, id: string) {
  return ex.selectFrom('media.assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function jobRow(ex: Executor, assetId: string) {
  return ex
    .selectFrom('media.transcodeJobs')
    .selectAll()
    .where('assetId', '=', assetId)
    .executeTakeFirstOrThrow();
}

// ---------------------------------------------------------------------------------- catalog

/** A free root position (roots share parent NULL in categories_parent_id_position_uq). */
async function freeRootPosition(ex: Executor): Promise<number> {
  const { rows } = await sql<{ p: number }>`
    SELECT p FROM generate_series(100, 999) p
     WHERE NOT EXISTS (SELECT 1 FROM catalog.categories WHERE parent_id IS NULL AND position = p)
     ORDER BY random() LIMIT 1
  `.execute(ex);
  return rows[0]!.p;
}

export async function createCategoryPair(
  ex: Executor,
): Promise<{ rootId: string; childId: string }> {
  const s = uniqueSuffix();
  const root = await ex
    .insertInto('catalog.categories')
    .values({
      depth: 1,
      slug: `it-root-${s}`,
      name: 'IT root',
      position: await freeRootPosition(ex),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const child = await ex
    .insertInto('catalog.categories')
    .values({ parentId: root.id, depth: 2, slug: `it-leaf-${s}`, name: 'IT leaf', position: 0 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { rootId: root.id, childId: child.id };
}

export interface TransitionInput {
  courseId: string;
  prevTransitionId: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  revisionId?: string | null;
  reason?: string | null;
}

export async function insertTransition(ex: Executor, t: TransitionInput): Promise<string> {
  const row = await ex
    .insertInto('catalog.courseTransitions')
    .values({
      courseId: t.courseId,
      prevTransitionId: t.prevTransitionId,
      action: t.action,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actorId: t.actorId,
      revisionId: t.revisionId ?? null,
      reason: t.reason ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface DraftCourse {
  courseId: string;
  ownerId: string;
  categoryId: string;
  /** Current head of the transition chain. */
  head: string;
}

/** CreateCourse: course DRAFT + CREATE transition (consistent at COMMIT). */
export async function createDraftCourse(
  ex: Executor,
  opts: { ownerId: string; categoryId: string },
): Promise<DraftCourse> {
  const course = await ex
    .insertInto('catalog.courses')
    .values({
      ownerId: opts.ownerId,
      slug: `it-course-${uniqueSuffix()}`,
      title: 'Integration course',
      categoryId: opts.categoryId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const head = await insertTransition(ex, {
    courseId: course.id,
    prevTransitionId: null,
    action: 'CREATE',
    fromStatus: null,
    toStatus: 'DRAFT',
    actorId: opts.ownerId,
  });
  return { courseId: course.id, ownerId: opts.ownerId, categoryId: opts.categoryId, head };
}

export interface RevisionShape {
  outcomes?: number;
  /** Lectures per section (0 = an empty section). */
  sections?: number[];
}

/** Inserts a revision snapshot (header + bullets + sections + ARTICLE lectures). No SUBMIT. */
export async function insertRevision(
  ex: Executor,
  opts: {
    courseId: string;
    categoryId: string;
    revisionNo: number;
    kind: 'INITIAL' | 'UPDATE';
  } & RevisionShape,
): Promise<string> {
  const rev = await ex
    .insertInto('catalog.courseRevisions')
    .values({
      courseId: opts.courseId,
      revisionNo: opts.revisionNo,
      kind: opts.kind,
      contentHash: randomBytes(32),
      title: 'Integration course',
      subtitle: 'A subtitle for tests',
      descriptionMd: 'x'.repeat(220),
      language: 'en',
      level: 'BEGINNER',
      categoryId: opts.categoryId,
      thumbnailAssetId: randomUUID(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const outcomes = opts.outcomes ?? 4;
  for (let i = 0; i < outcomes; i++) {
    await ex
      .insertInto('catalog.revisionBullets')
      .values({ revisionId: rev.id, kind: 'OUTCOME', position: i, text: `Outcome ${i}` })
      .execute();
  }
  const sections = opts.sections ?? [1];
  for (const [position, lectures] of sections.entries()) {
    const sectionId = randomUUID();
    await ex
      .insertInto('catalog.revisionSections')
      .values({ revisionId: rev.id, sectionId, position, title: `Section ${position}` })
      .execute();
    for (let l = 0; l < lectures; l++) {
      await ex
        .insertInto('catalog.revisionLectures')
        .values({
          revisionId: rev.id,
          lectureId: randomUUID(),
          sectionId,
          position: l,
          type: 'ARTICLE',
          title: `Lecture ${l}`,
          isPreview: false,
          articleBodyMd: 'Article body long enough for the tests.',
        })
        .execute();
    }
  }
  return rev.id;
}

/** SubmitForReview from DRAFT/REJECTED (INITIAL) or PUBLISHED (UPDATE): revision + SUBMIT + pointers. */
export async function submit(
  ex: Executor,
  course: DraftCourse,
  opts: { revisionNo: number; from: 'DRAFT' | 'REJECTED' | 'PUBLISHED' } & RevisionShape,
): Promise<string> {
  const kind = opts.from === 'PUBLISHED' ? 'UPDATE' : 'INITIAL';
  const revisionId = await insertRevision(ex, {
    courseId: course.courseId,
    categoryId: course.categoryId,
    revisionNo: opts.revisionNo,
    kind,
    outcomes: opts.outcomes,
    sections: opts.sections,
  });
  course.head = await insertTransition(ex, {
    courseId: course.courseId,
    prevTransitionId: course.head,
    action: 'SUBMIT',
    fromStatus: opts.from,
    toStatus: opts.from === 'PUBLISHED' ? 'PUBLISHED' : 'IN_REVIEW',
    actorId: course.ownerId,
    revisionId,
  });
  await ex
    .updateTable('catalog.courses')
    .set({
      status: opts.from === 'PUBLISHED' ? 'PUBLISHED' : 'IN_REVIEW',
      pendingRevisionId: revisionId,
    })
    .where('id', '=', course.courseId)
    .execute();
  return revisionId;
}

/** ApproveRevision by `adminId`. */
export async function approve(
  ex: Executor,
  course: DraftCourse,
  opts: { revisionId: string; adminId: string; from: 'IN_REVIEW' | 'PUBLISHED' },
): Promise<void> {
  course.head = await insertTransition(ex, {
    courseId: course.courseId,
    prevTransitionId: course.head,
    action: 'APPROVE',
    fromStatus: opts.from,
    toStatus: 'PUBLISHED',
    actorId: opts.adminId,
    revisionId: opts.revisionId,
  });
  await sql`
    UPDATE catalog.courses
       SET status = 'PUBLISHED', published_revision_id = ${opts.revisionId}, pending_revision_id = NULL,
           first_published_at = coalesce(first_published_at, now())
     WHERE id = ${course.courseId}
  `.execute(ex);
}
