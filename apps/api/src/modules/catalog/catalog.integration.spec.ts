// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { MediaAssetNotFound, MediaAssetUnusable } from '../media';
import { TransactionRunner } from './application/ports/transaction-runner';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { AttachLectureMediaCommand } from './application/use-cases/attach-lecture-media.command';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { DeleteCategoryCommand } from './application/use-cases/delete-category.command';
import { DeleteCourseCommand } from './application/use-cases/delete-course.command';
import { DeleteLectureCommand } from './application/use-cases/delete-lecture.command';
import { DeleteSectionCommand } from './application/use-cases/delete-section.command';
import { DetachLectureMediaCommand } from './application/use-cases/detach-lecture-media.command';
import { GetCourseQuery } from './application/use-cases/get-course.query';
import { GetCurriculumQuery } from './application/use-cases/get-curriculum.query';
import { ReorderCurriculumCommand } from './application/use-cases/reorder-curriculum.command';
import { SaveArticleCommand } from './application/use-cases/save-article.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { UpdateCategoryCommand } from './application/use-cases/update-category.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { UpdateSectionCommand } from './application/use-cases/update-section.command';
import {
  CategoryDepthExceeded,
  CategoryInUse,
  CategoryNotLeaf,
  CourseInReview,
  CoursePublishedCannotDelete,
  OrderMismatch,
  SlugFrozen,
  SlugTaken,
} from './domain/catalog.errors';
import { mapCatalogConstraints } from './infrastructure/catalog-constraint-errors';
import {
  deleteCatalogTestData,
  forceCourseState,
  insertCatalogTestUser,
  insertTestAsset,
} from './testing/catalog-it';

/*
 * The catalog module against the integration Postgres (IT_DATABASE_URL; skipped locally when
 * unreachable, a failure with CI=true), wired by the real AppModule (real MediaFacade, real
 * triggers, deferred constraints and the constraint -> error mapping). Use cases are called
 * directly; states only P2-T10 can reach (in review, published) are forced through SQL.
 */
describe('catalog (integration: real AppModule, Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 4 });
  const itRedis = useIntegrationRedis();
  const owners: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let app: NestExpressApplication | undefined;

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

  async function owner(label: string): Promise<string> {
    const id = await insertCatalogTestUser(pg.db, label);
    owners.push(id);
    return id;
  }

  async function course(ownerId: string, title = `IT course ${tag}`): Promise<string> {
    return (await get(CreateCourseCommand).execute({ ownerId, title })).id;
  }

  async function usages(assetId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('media.assetUsages')
      .select(['consumerType', 'consumerId'])
      .where('assetId', '=', assetId)
      .execute();
    return rows.map((r) => `${r.consumerType}|${r.consumerId}`).sort();
  }

  async function unusedSince(assetId: string): Promise<Date | null> {
    const row = await pg.db
      .selectFrom('media.assets')
      .select('unusedSince')
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    return row.unusedSince;
  }

  it('curriculum CRUD: sections, lectures, article; positions stay contiguous', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('crud');
    const courseId = await course(ownerId);
    const as = { actorId: ownerId, courseId };
    const s1 = await get(AddSectionCommand).execute({ ...as, title: 'Intro', objective: 'Start' });
    const s2 = await get(AddSectionCommand).execute({ ...as, title: 'Middle' });
    const s3 = await get(AddSectionCommand).execute({ ...as, title: 'End' });
    const l1 = await get(AddLectureCommand).execute({
      ...as,
      sectionId: s1.id,
      type: 'VIDEO',
      title: 'One',
    });
    const l2 = await get(AddLectureCommand).execute({
      ...as,
      sectionId: s1.id,
      type: 'ARTICLE',
      title: 'Two',
    });
    await get(AddLectureCommand).execute({
      ...as,
      sectionId: s1.id,
      type: 'RESOURCE',
      title: 'Three',
    });
    await get(UpdateSectionCommand).execute({
      ...as,
      sectionId: s2.id,
      patch: { objective: null, title: 'Core' },
    });
    const body = 'Read **this** carefully.  \n\n- a list\n';
    await get(SaveArticleCommand).execute({ ...as, lectureId: l2.id, bodyMd: body });
    await get(DeleteLectureCommand).execute({ ...as, lectureId: l1.id });
    await get(DeleteSectionCommand).execute({ ...as, sectionId: s3.id });

    const curriculum = await get(GetCurriculumQuery).execute(courseId);
    expect(
      curriculum.sections.map((s) => [
        s.title,
        s.position,
        s.lectures.map((l) => [l.title, l.position]),
      ]),
    ).toEqual([
      [
        'Intro',
        0,
        [
          ['Two', 0],
          ['Three', 1],
        ],
      ],
      ['Core', 1, []],
    ]);
    expect(curriculum.sections[0]?.lectures[0]?.articleLength).toBe(
      'Read this carefully. a list'.length,
    );
    expect(curriculum.version).toBe(11); // create + 10 writes
    const stored = await pg.db
      .selectFrom('catalog.lectureArticles')
      .select('bodyMd')
      .where('lectureId', '=', l2.id)
      .executeTakeFirstOrThrow();
    expect(stored.bodyMd).toBe(body); // never trimmed
  });

  it('reorders across sections in ONE transaction (deferred uniques); stale order -> order_mismatch', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('reorder');
    const courseId = await course(ownerId);
    const as = { actorId: ownerId, courseId };
    const s1 = await get(AddSectionCommand).execute({ ...as, title: 'S1' });
    const s2 = await get(AddSectionCommand).execute({ ...as, title: 'S2' });
    const add = (sectionId: string, title: string) =>
      get(AddLectureCommand).execute({ ...as, sectionId, type: 'VIDEO', title });
    const a = await add(s1.id, 'a');
    const b = await add(s1.id, 'b');
    const c = await add(s2.id, 'c');
    const d = await add(s2.id, 'd');

    // Swap the sections, move b into S2 at the top and c into S1: every position collides
    // mid-statement; only the committed state is checked.
    await get(ReorderCurriculumCommand).execute({
      ...as,
      sections: [
        { sectionId: s2.id, lectureIds: [b.id, d.id] },
        { sectionId: s1.id, lectureIds: [c.id, a.id] },
      ],
    });
    const rows = await pg.db
      .selectFrom('catalog.lectures as l')
      .innerJoin('catalog.sections as s', 's.id', 'l.sectionId')
      .select(['l.title', 's.title as section', 's.position as sp', 'l.position as lp'])
      .where('l.courseId', '=', courseId)
      .orderBy('s.position')
      .orderBy('l.position')
      .execute();
    expect(rows.map((r) => `${r.section}:${r.sp}/${r.title}:${r.lp}`)).toEqual([
      'S2:0/b:0',
      'S2:0/d:1',
      'S1:1/c:0',
      'S1:1/a:1',
    ]);

    // The old order (a stale tab) no longer matches: 409, nothing changes.
    await expect(
      get(ReorderCurriculumCommand).execute({
        ...as,
        sections: [
          { sectionId: s1.id, lectureIds: [a.id, b.id] },
          { sectionId: s2.id, lectureIds: [c.id] },
        ],
      }),
    ).rejects.toBeInstanceOf(OrderMismatch);

    // A duplicate position surviving to COMMIT is mapped by the transaction runner.
    await expect(
      get(TransactionRunner).run(async (trx) => {
        await sql`UPDATE catalog.sections SET position = 0 WHERE course_id = ${courseId}`.execute(
          trx,
        );
      }),
    ).rejects.toBeInstanceOf(OrderMismatch);
  });

  it('review lock: pending revision -> course_in_review (app check and DB guard)', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('lock');
    const courseId = await course(ownerId);
    const section = await get(AddSectionCommand).execute({
      actorId: ownerId,
      courseId,
      title: 'S',
    });
    await forceCourseState(pg.db, courseId, 'IN_REVIEW');

    await expect(
      get(UpdateCourseCommand).execute({
        actorId: ownerId,
        courseId,
        changes: { title: 'Changed title' },
      }),
    ).rejects.toBeInstanceOf(CourseInReview);
    await expect(
      get(AddLectureCommand).execute({
        actorId: ownerId,
        courseId,
        sectionId: section.id,
        type: 'VIDEO',
        title: 'x',
      }),
    ).rejects.toBeInstanceOf(CourseInReview);
    await expect(
      get(DeleteCourseCommand).execute({ actorId: ownerId, courseId }),
    ).rejects.toBeInstanceOf(CourseInReview);
    // The DB backstop (courses_working_copy_locked_ck) maps to the same error.
    await expect(
      mapCatalogConstraints(() =>
        pg.db
          .insertInto('catalog.sections')
          .values({ courseId, title: 'sneaky', position: 1 })
          .execute(),
      ),
    ).rejects.toBeInstanceOf(CourseInReview);
    await expect(
      mapCatalogConstraints(() =>
        pg.db
          .updateTable('catalog.courses')
          .set({ title: 'Sneaky title' })
          .where('id', '=', courseId)
          .execute(),
      ),
    ).rejects.toBeInstanceOf(CourseInReview);
    expect((await get(GetCourseQuery).execute(courseId)).locked).toBe(true);
    await forceCourseState(pg.db, courseId, 'DRAFT');
  });

  it('attach / swap / detach lecture media keeps usages and unused_since in step', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('media');
    const otherId = await owner('media-other');
    const courseId = await course(ownerId);
    const as = { actorId: ownerId, courseId };
    const section = await get(AddSectionCommand).execute({ ...as, title: 'S' });
    const lecture = await get(AddLectureCommand).execute({
      ...as,
      sectionId: section.id,
      type: 'VIDEO',
      title: 'V',
    });
    const first = await insertTestAsset(pg.db, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      durationMs: 125_000,
    });
    const second = await insertTestAsset(pg.db, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      stage: 'UPLOADED',
    });
    const foreign = await insertTestAsset(pg.db, { ownerId: otherId, purpose: 'LECTURE_VIDEO' });

    const attached = await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: lecture.id,
      assetId: first,
    });
    expect(attached).toMatchObject({
      mediaAssetId: first,
      asset: { status: 'READY', durationSeconds: 125 },
    });
    expect(await usages(first)).toEqual([`catalog.lecture|${lecture.id}`]);
    expect(await unusedSince(first)).toBeNull();

    await get(AttachLectureMediaCommand).execute({ ...as, lectureId: lecture.id, assetId: second });
    expect(await usages(first)).toEqual([]);
    expect(await unusedSince(first)).not.toBeNull();
    expect(await usages(second)).toEqual([`catalog.lecture|${lecture.id}`]);

    await expect(
      get(AttachLectureMediaCommand).execute({ ...as, lectureId: lecture.id, assetId: foreign }),
    ).rejects.toBeInstanceOf(MediaAssetNotFound);
    // A second lecture cannot take an asset another lecture uses.
    const other = await get(AddLectureCommand).execute({
      ...as,
      sectionId: section.id,
      type: 'VIDEO',
      title: 'V2',
    });
    await expect(
      get(AttachLectureMediaCommand).execute({ ...as, lectureId: other.id, assetId: second }),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);
    expect(await usages(second)).toEqual([`catalog.lecture|${lecture.id}`]); // rolled back

    await get(DetachLectureMediaCommand).execute({ ...as, lectureId: lecture.id });
    expect(await usages(second)).toEqual([]);
    const row = await pg.db
      .selectFrom('catalog.lectures')
      .select('mediaAssetId')
      .where('id', '=', lecture.id)
      .executeTakeFirstOrThrow();
    expect(row.mediaAssetId).toBeNull();
  });

  it('delete: releases lecture + thumbnail usages, nulls references, then soft-deletes', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('delete');
    const courseId = await course(ownerId, `Deletable ${tag}`);
    const as = { actorId: ownerId, courseId };
    const section = await get(AddSectionCommand).execute({ ...as, title: 'S' });
    const lecture = await get(AddLectureCommand).execute({
      ...as,
      sectionId: section.id,
      type: 'RESOURCE',
      title: 'R',
    });
    const resource = await insertTestAsset(pg.db, { ownerId, purpose: 'LECTURE_RESOURCE' });
    const thumb = await insertTestAsset(pg.db, { ownerId, purpose: 'COURSE_THUMBNAIL' });
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: lecture.id,
      assetId: resource,
    });
    await get(SetCourseThumbnailCommand).execute({ ...as, assetId: thumb });
    expect(await usages(thumb)).toEqual([`catalog.course_thumbnail|${courseId}`]);

    await get(DeleteCourseCommand).execute(as);

    expect(await usages(resource)).toEqual([]);
    expect(await usages(thumb)).toEqual([]);
    expect(await unusedSince(resource)).not.toBeNull();
    const deleted = await pg.db
      .selectFrom('catalog.courses')
      .select(['deletedAt', 'thumbnailAssetId'])
      .where('id', '=', courseId)
      .executeTakeFirstOrThrow();
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.thumbnailAssetId).toBeNull();
    const transitions = await pg.db
      .selectFrom('catalog.courseTransitions')
      .select('action')
      .where('courseId', '=', courseId)
      .orderBy('occurredAt')
      .execute();
    expect(transitions.map((t) => t.action)).toEqual(['CREATE', 'DELETE']);
    const events = await pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', courseId)
      .execute();
    expect(events.map((e) => e.type).sort()).toEqual(['CourseCreated.v1', 'CourseDeleted.v1']);
    // The released asset can be attached elsewhere right away.
    const next = await course(ownerId);
    const s = await get(AddSectionCommand).execute({
      actorId: ownerId,
      courseId: next,
      title: 'S',
    });
    const l = await get(AddLectureCommand).execute({
      actorId: ownerId,
      courseId: next,
      sectionId: s.id,
      type: 'RESOURCE',
      title: 'R',
    });
    await get(AttachLectureMediaCommand).execute({
      actorId: ownerId,
      courseId: next,
      lectureId: l.id,
      assetId: resource,
    });

    // A published course cannot be deleted.
    const published = await course(ownerId);
    await forceCourseState(pg.db, published, 'PUBLISHED');
    await expect(
      get(DeleteCourseCommand).execute({ actorId: ownerId, courseId: published }),
    ).rejects.toBeInstanceOf(CoursePublishedCannotDelete);
  });

  it('slugs: -2/-3 on conflict (also under a concurrent race), frozen after publication', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('slug');
    const title = `Slug race ${tag}`;
    const base = `slug-race-${tag}`;
    const created = await Promise.all(
      Array.from({ length: 4 }, () => get(CreateCourseCommand).execute({ ownerId, title })),
    );
    expect(created.map((c) => c.slug).sort()).toEqual([
      base,
      `${base}-2`,
      `${base}-3`,
      `${base}-4`,
    ]);

    const [first, second] = created;
    if (first === undefined || second === undefined) throw new Error('unreachable');
    await expect(
      get(UpdateCourseCommand).execute({
        actorId: ownerId,
        courseId: first.id,
        changes: { slug: second.slug },
      }),
    ).rejects.toBeInstanceOf(SlugTaken);
    const renamed = await get(UpdateCourseCommand).execute({
      actorId: ownerId,
      courseId: first.id,
      changes: { slug: `renamed-${tag}` },
    });
    expect(renamed.slug).toBe(`renamed-${tag}`);

    await forceCourseState(pg.db, first.id, 'PUBLISHED');
    await expect(
      get(UpdateCourseCommand).execute({
        actorId: ownerId,
        courseId: first.id,
        changes: { slug: `again-${tag}` },
      }),
    ).rejects.toBeInstanceOf(SlugFrozen);
    // The DB trigger backs it up (courses_slug_frozen_ck).
    await expect(
      mapCatalogConstraints(() =>
        pg.db
          .updateTable('catalog.courses')
          .set({ slug: `again-${tag}` })
          .where('id', '=', first.id)
          .execute(),
      ),
    ).rejects.toBeInstanceOf(SlugFrozen);
    await forceCourseState(pg.db, first.id, 'DRAFT');
  });

  it('categories: two levels, leaf-only assignment, delete only when unused', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('categories');
    const create = async (name: string, parentId?: string) => {
      const created = await get(CreateCategoryCommand).execute({ name, parentId });
      categoryIds.push(created.id);
      return created;
    };
    const group = await create(`IT group ${tag}`);
    const leaf = await create(`IT leaf ${tag}`, group.id);
    const spare = await create(`IT spare ${tag}`, group.id);
    expect([group.depth, leaf.depth, spare.position]).toEqual([1, 2, 1]);
    await expect(create(`IT deep ${tag}`, leaf.id)).rejects.toBeInstanceOf(CategoryDepthExceeded);

    await expect(
      get(CreateCourseCommand).execute({ ownerId, title: `Grouped ${tag}`, categoryId: group.id }),
    ).rejects.toBeInstanceOf(CategoryNotLeaf);
    await get(CreateCourseCommand).execute({
      ownerId,
      title: `Leafed ${tag}`,
      categoryId: leaf.id,
    });

    await expect(get(DeleteCategoryCommand).execute(group.id)).rejects.toBeInstanceOf(
      CategoryInUse,
    );
    await expect(get(DeleteCategoryCommand).execute(leaf.id)).rejects.toBeInstanceOf(CategoryInUse);
    await expect(
      get(UpdateCategoryCommand).execute({ id: group.id, parentId: leaf.id }),
    ).rejects.toBeInstanceOf(CategoryDepthExceeded);

    await get(DeleteCategoryCommand).execute(spare.id);
    const left = await pg.db
      .selectFrom('catalog.categories')
      .select(['id', 'position'])
      .where('parentId', '=', group.id)
      .execute();
    expect(left).toEqual([{ id: leaf.id, position: 0 }]);
  });
});
