// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CATALOG_COURSE_EVENTS } from '@udemy/contracts';
import { findLeakedUsages, sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { RevisionRepository } from './application/ports/revision.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { AdminSearchCoursesQuery } from './application/use-cases/admin-search-courses.query';
import { ApproveRevisionCommand } from './application/use-cases/approve-revision.command';
import { ArchiveCourseCommand } from './application/use-cases/archive-course.command';
import { AttachLectureMediaCommand } from './application/use-cases/attach-lecture-media.command';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { GetCourseHistoryQuery } from './application/use-cases/get-course-history.query';
import { GetCourseQuery } from './application/use-cases/get-course.query';
import { GetRevisionReviewQuery } from './application/use-cases/get-revision-review.query';
import { ListReviewQueueQuery } from './application/use-cases/list-review-queue.query';
import { RejectRevisionCommand } from './application/use-cases/reject-revision.command';
import { RestoreCourseCommand } from './application/use-cases/restore-course.command';
import { SaveArticleCommand } from './application/use-cases/save-article.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { SubmitCourseCommand } from './application/use-cases/submit-course.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { WithdrawSubmissionCommand } from './application/use-cases/withdraw-submission.command';
import {
  InvalidStateTransition,
  NothingToReview,
  RestoreForbidden,
  SelfDecisionForbidden,
} from './domain/catalog.errors';
import { contentHash } from './domain/revision-snapshot';
import {
  deleteCatalogTestData,
  insertCatalogTestUser,
  insertTestAsset,
} from './testing/catalog-it';

/*
 * P2-T10 against the integration Postgres through the real AppModule: the revision builder,
 * media pins (real MediaFacade + usage triggers), the transition chain, the deferred
 * status <-> log and revision guards at COMMIT, the decision unique index under a real race,
 * and the outbox rows validated against the contracts. Default thresholds (5 lectures, 30 min
 * of video), so the fixture is a realistic course.
 */
describe('catalog lifecycle (integration: real AppModule, Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 6 });
  const itRedis = useIntegrationRedis();
  const owners: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let app: NestExpressApplication | undefined;
  let leafId = '';
  let groupId = '';
  let adminId = '';

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean => pg.available && itRedis.available;

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
    const group = await get(CreateCategoryCommand).execute({ name: `Lifecycle IT ${tag}` });
    const leaf = await get(CreateCategoryCommand).execute({
      name: `Lifecycle leaf ${tag}`,
      parentId: group.id,
    });
    categoryIds.push(group.id, leaf.id);
    leafId = leaf.id;
    groupId = group.id;
    adminId = await insertCatalogTestUser(pg.db, 'admin');
    owners.push(adminId);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) await deleteCatalogTestData(pg.db, { ownerIds: owners, categoryIds });
    } finally {
      await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
      process.env = IT_APP_ENV.savedEnv;
    }
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  interface Ready {
    ownerId: string;
    courseId: string;
    articleIds: string[];
    assetIds: string[];
  }

  /** A course that passes the default readiness rules: 1 video (30 min) + 4 articles. */
  async function readyCourse(label: string): Promise<Ready> {
    const ownerId = await insertCatalogTestUser(pg.db, label);
    owners.push(ownerId);
    const course = await get(CreateCourseCommand).execute({
      ownerId,
      title: `Lifecycle ${label} ${tag}`,
    });
    const as = { actorId: ownerId, courseId: course.id };
    await get(UpdateCourseCommand).execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    const thumbnail = await insertTestAsset(pg.db, { ownerId, purpose: 'COURSE_THUMBNAIL' });
    await get(SetCourseThumbnailCommand).execute({ ...as, assetId: thumbnail });
    const section = await get(AddSectionCommand).execute({ ...as, title: 'Section one' });
    const video = await get(AddLectureCommand).execute({
      ...as,
      sectionId: section.id,
      type: 'VIDEO',
      title: 'Video',
    });
    const videoAsset = await insertTestAsset(pg.db, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      durationMs: 1_800_000,
    });
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: video.id,
      assetId: videoAsset,
    });
    const articleIds: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const article = await get(AddLectureCommand).execute({
        ...as,
        sectionId: section.id,
        type: 'ARTICLE',
        title: `Article ${i}`,
      });
      await get(SaveArticleCommand).execute({
        ...as,
        lectureId: article.id,
        bodyMd: `Article ${i}: a body that is comfortably longer than fifty characters.`,
      });
      articleIds.push(article.id);
    }
    return { ownerId, courseId: course.id, articleIds, assetIds: [thumbnail, videoAsset].sort() };
  }

  async function pinsOf(revisionId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('media.assetUsages')
      .select('assetId')
      .where('consumerType', '=', 'catalog.course_revision')
      .where('consumerId', '=', revisionId)
      .execute();
    return rows.map((r) => r.assetId).sort();
  }

  /** Outbox rows of the course, each validated against its contract. */
  async function outbox(courseId: string): Promise<{ type: string; payload: unknown }[]> {
    const rows = await pg.db
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType', 'payload', 'createdAt'])
      .where('aggregateId', '=', courseId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    return rows.map((row) => {
      const definition = CATALOG_COURSE_EVENTS.find((e) => e.qualifiedType === row.type);
      if (definition === undefined) throw new Error(`unknown event ${row.type}`);
      expect(row.aggregateType).toBe('catalog.course');
      return { type: definition.type, payload: definition.parsePayload(row.payload) };
    });
  }

  it('full lifecycle: submit -> approve -> edit -> update -> reject -> resubmit -> approve', async (ctx) => {
    skip(ctx);
    const c = await readyCourse('full');
    const r1 = await get(SubmitCourseCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      note: 'First version',
    });
    expect(await pinsOf(r1.revisionId)).toEqual(c.assetIds);

    // the stored snapshot round-trips to the stored content hash
    const stored = await get(RevisionRepository).findById(r1.revisionId);
    expect(stored).not.toBeNull();
    if (stored === null) return;
    expect(contentHash(stored.content).toString('hex')).toBe(stored.contentHashHex);
    expect(stored.lectures.size).toBe(5);

    const queue = await get(ListReviewQueueQuery).execute({ limit: 100 });
    expect(queue.items.map((i) => i.revisionId)).toContain(r1.revisionId);

    await expect(
      get(ApproveRevisionCommand).execute({
        actorId: c.ownerId,
        courseId: c.courseId,
        revisionId: r1.revisionId,
      }),
    ).rejects.toBeInstanceOf(SelfDecisionForbidden);
    const live = await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId: r1.revisionId,
    });
    expect(live).toMatchObject({
      status: 'PUBLISHED',
      badge: 'LIVE',
      hasUnpublishedChanges: false,
    });
    await expect(
      get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId }),
    ).rejects.toBeInstanceOf(NothingToReview);

    const as = { actorId: c.ownerId, courseId: c.courseId };
    await get(SaveArticleCommand).execute({
      ...as,
      lectureId: c.articleIds[0] ?? '',
      bodyMd: 'An edited article body, still comfortably longer than fifty characters.',
    });
    expect((await get(GetCourseQuery).execute(c.courseId)).hasUnpublishedChanges).toBe(true);
    await get(UpdateCourseCommand).execute({
      ...as,
      changes: {
        subtitle: 'A sharper subtitle',
        outcomes: ['One', 'Two', 'Three', 'Four', 'Five'],
      },
    });
    const r2 = await get(SubmitCourseCommand).execute(as);
    const review = await get(GetRevisionReviewQuery).execute(r2.revisionId);
    expect(review.revision).toMatchObject({ kind: 'UPDATE', state: 'PENDING', revisionNo: 2 });
    expect(review.revision.category).toMatchObject({
      id: leafId,
      parent: { id: groupId, name: `Lifecycle IT ${tag}` },
    });
    expect(review.diff).toMatchObject({
      baseRevisionId: r1.revisionId,
      changedFields: ['subtitle', 'outcomes'],
      fieldChanges: [
        { field: 'subtitle', before: 'A subtitle for the course', after: 'A sharper subtitle' },
        {
          field: 'outcomes',
          before: ['One', 'Two', 'Three', 'Four'],
          after: ['One', 'Two', 'Three', 'Four', 'Five'],
        },
      ],
      lectures: { changed: [c.articleIds[0]], added: [], removed: [], moved: [] },
    });
    await get(RejectRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId: r2.revisionId,
      reason: 'The edited article is not clear.',
    });
    expect(await pinsOf(r2.revisionId)).toEqual([]);
    expect((await get(GetCourseQuery).execute(c.courseId)).badge).toBe('LIVE_UPDATE_REJECTED');

    const r3 = await get(SubmitCourseCommand).execute(as);
    await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId: r3.revisionId,
      note: 'Thanks',
    });
    expect(await pinsOf(r1.revisionId)).toEqual([]); // superseded
    expect(await pinsOf(r3.revisionId)).toEqual(c.assetIds);
    const leaks = await findLeakedUsages(pg.db, { limit: 1000 });
    expect(leaks.filter((u) => c.assetIds.includes(u.assetId))).toEqual([]);

    const course = await pg.db
      .selectFrom('catalog.courses')
      .select(['status', 'publishedRevisionId', 'pendingRevisionId', 'firstPublishedAt'])
      .where('id', '=', c.courseId)
      .executeTakeFirstOrThrow();
    expect(course).toMatchObject({
      status: 'PUBLISHED',
      publishedRevisionId: r3.revisionId,
      pendingRevisionId: null,
    });
    const firstApprove = await pg.db
      .selectFrom('catalog.courseTransitions')
      .select('occurredAt')
      .where('revisionId', '=', r1.revisionId)
      .where('action', '=', 'APPROVE')
      .executeTakeFirstOrThrow();
    expect(course.firstPublishedAt).toEqual(firstApprove.occurredAt);

    const history = await get(GetCourseHistoryQuery).execute({
      courseId: c.courseId,
      viewerIsModerator: true,
    });
    expect(history.items.map((i) => `${i.action}:${i.toStatus}`)).toEqual([
      'CREATE:DRAFT',
      'SUBMIT:IN_REVIEW',
      'APPROVE:PUBLISHED',
      'SUBMIT:PUBLISHED',
      'REJECT:PUBLISHED',
      'SUBMIT:PUBLISHED',
      'APPROVE:PUBLISHED',
    ]);

    const events = await outbox(c.courseId);
    expect(events.map((e) => e.type)).toEqual([
      'CourseCreated',
      'CourseSubmittedForReview',
      'CoursePublished',
      'CourseSubmittedForReview',
      'CourseRejected',
      'CourseSubmittedForReview',
      'CoursePublished',
    ]);
    expect(events[1]?.payload).toMatchObject({ kind: 'INITIAL', revisionNo: 1 });
    expect(events[3]?.payload).toMatchObject({ kind: 'UPDATE', revisionNo: 2 });
    expect(events[6]?.payload).toMatchObject({
      revisionId: r3.revisionId,
      decidedBy: adminId,
      slug: live.slug,
    });
  });

  it('takedown -> owner restore forbidden -> admin restore; a pending update is auto-withdrawn', async (ctx) => {
    skip(ctx);
    const c = await readyCourse('takedown');
    const r1 = await get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId });
    await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId: r1.revisionId,
    });
    await get(SaveArticleCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: c.articleIds[1] ?? '',
      bodyMd: 'Another edited article body that is longer than fifty characters.',
    });
    const r2 = await get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId });

    const down = await get(ArchiveCourseCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      reason: 'Violates the content policy.',
      byAdmin: true,
    });
    expect(down).toMatchObject({ status: 'ARCHIVED', pendingRevision: null });
    // The admin list names the takedown actor and reason (the latest ARCHIVE transition).
    const listed = await get(AdminSearchCoursesQuery).execute({ ownerId: c.ownerId, limit: 5 });
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: c.courseId,
        status: 'ARCHIVED',
        archivedBy: expect.objectContaining({ id: adminId, isModerator: true }),
        archiveReason: 'Violates the content policy.',
      }),
    ]);
    expect(await pinsOf(r2.revisionId)).toEqual([]);
    expect(await pinsOf(r1.revisionId)).toEqual(c.assetIds); // live content is kept

    await expect(
      get(RestoreCourseCommand).execute({
        actorId: c.ownerId,
        courseId: c.courseId,
        byAdmin: false,
      }),
    ).rejects.toBeInstanceOf(RestoreForbidden);
    // the DB trigger agrees (bypassing the app check): course_transitions_restore_actor_ck
    const head = await pg.db
      .selectFrom('catalog.courseTransitions')
      .select('id')
      .where('courseId', '=', c.courseId)
      .where('action', '=', 'ARCHIVE')
      .executeTakeFirstOrThrow();
    await expect(
      get(TransactionRunner).run(async (trx) => {
        await trx
          .insertInto('catalog.courseTransitions')
          .values({
            courseId: c.courseId,
            prevTransitionId: head.id,
            action: 'RESTORE',
            fromStatus: 'ARCHIVED',
            toStatus: 'PUBLISHED',
            actorId: c.ownerId,
          })
          .execute();
      }),
    ).rejects.toBeInstanceOf(RestoreForbidden);

    const restored = await get(RestoreCourseCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      byAdmin: true,
    });
    expect(restored).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE' });
    const relisted = await get(AdminSearchCoursesQuery).execute({ ownerId: c.ownerId, limit: 5 });
    expect(relisted.items[0]).toMatchObject({ archivedBy: null, archiveReason: null });
    const events = (await outbox(c.courseId)).map((e) => e.type).slice(-3);
    expect(events).toEqual(['CourseSubmissionWithdrawn', 'CourseArchived', 'CourseRestored']);
    const archived = (await outbox(c.courseId)).find((e) => e.type === 'CourseArchived');
    expect(archived?.payload).toMatchObject({ byAdmin: true, actorId: adminId });
  });

  it('approve and reject racing on the same revision: exactly one wins', async (ctx) => {
    skip(ctx);
    const c = await readyCourse('race');
    const r1 = await get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId });
    const decide = { actorId: adminId, courseId: c.courseId, revisionId: r1.revisionId };
    const results = await Promise.allSettled([
      get(ApproveRevisionCommand).execute(decide),
      get(RejectRevisionCommand).execute({ ...decide, reason: 'Racing rejection reason.' }),
      get(ApproveRevisionCommand).execute(decide),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const r of lost) expect(r.reason).toBeInstanceOf(InvalidStateTransition);
    const decisions = await pg.db
      .selectFrom('catalog.courseTransitions')
      .select('action')
      .where('revisionId', '=', r1.revisionId)
      .where('action', 'in', ['APPROVE', 'REJECT', 'WITHDRAW'])
      .execute();
    expect(decisions).toHaveLength(1);
  });

  it('approve of a withdrawn revision after a resubmit is rejected', async (ctx) => {
    skip(ctx);
    const c = await readyCourse('resubmit');
    const as = { actorId: c.ownerId, courseId: c.courseId };
    const r1 = await get(SubmitCourseCommand).execute(as);
    await get(WithdrawSubmissionCommand).execute(as);
    expect(await pinsOf(r1.revisionId)).toEqual([]);
    const r2 = await get(SubmitCourseCommand).execute(as);
    await expect(
      get(ApproveRevisionCommand).execute({
        actorId: adminId,
        courseId: c.courseId,
        revisionId: r1.revisionId,
      }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);
    // the decision index also refuses it at the DB level
    const head = await pg.db
      .selectFrom('catalog.courseTransitions as t')
      .select('t.id')
      .where('t.courseId', '=', c.courseId)
      .where('t.revisionId', '=', r2.revisionId)
      .executeTakeFirstOrThrow();
    await expect(
      get(TransactionRunner).run(async (trx) => {
        await trx
          .insertInto('catalog.courseTransitions')
          .values({
            courseId: c.courseId,
            prevTransitionId: head.id,
            revisionId: r1.revisionId,
            action: 'APPROVE',
            fromStatus: 'IN_REVIEW',
            toStatus: 'PUBLISHED',
            actorId: adminId,
          })
          .execute();
      }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);
    const live = await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId: r2.revisionId,
    });
    expect(live.liveRevision?.id).toBe(r2.revisionId);
  });

  it('status <-> log consistency is checked at COMMIT', async (ctx) => {
    skip(ctx);
    const c = await readyCourse('consistency');
    const error = await pg.db
      .transaction()
      .execute(async (trx) => {
        await sql`UPDATE catalog.courses SET status = 'REJECTED' WHERE id = ${c.courseId}`.execute(
          trx,
        );
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ constraint: 'courses_status_log_ck' });
    // every course this file drove through the lifecycle is still consistent
    const rows = await pg.db
      .selectFrom('catalog.courses')
      .select('id')
      .where('ownerId', 'in', owners)
      .execute();
    await pg.db.transaction().execute(async (trx) => {
      for (const row of rows) {
        await sql`UPDATE catalog.courses SET status = status WHERE id = ${row.id}`.execute(trx);
      }
      await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);
    });
  });
});
