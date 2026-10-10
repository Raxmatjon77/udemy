// Must stay the first import: AppModule validates process.env when it is imported.
import './modules/catalog/testing/apply-catalog-public-e2e-env';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AssetPageSchema,
  AssetViewSchema,
  type AuthResult,
  CategorySchema,
  CourseCardPageSchema,
  CourseDetailSchema,
  CourseLandingSchema,
  CurriculumSchema,
  ErrorCode,
  HLS_PLAYLIST_CONTENT_TYPE,
  InitiateUploadResponseSchema,
  LectureSchema,
  type MediaPurpose,
  PresignPartsResponseSchema,
  RevisionReviewSchema,
  SectionSchema,
  SignedUrlSchema,
  SubmitCourseResponseSchema,
} from '@udemy/contracts';
import { sql } from '@udemy/db';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteCatalogTestData } from './modules/catalog/testing/catalog-it';
import {
  FAKE_JPEG,
  FAKE_SEGMENT,
  finishTranscodeLikeTranscoder,
  insertReadyThumbnail,
  insertReadyVideo,
} from './modules/catalog/testing/catalog-public-it';
import { deleteMediaTestData, useIntegrationS3 } from './modules/media/testing/media-it';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from './testing/e2e/e2e-harness';
import { type Operation, SECTION_8_PHASE_1, SECTION_8_PHASE_2 } from './testing/e2e/section-8';

/*
 * P2-T18: the consolidated Phase 2 API sweep. Every Phase 2 task has its own e2e file
 * (media, catalog, catalog-lifecycle, catalog-public); this file closes the cross-module gaps
 * through the REAL AppModule (global guards in production order, validation, problem+json),
 * real Postgres, Redis and MinIO:
 *
 * - the Phase 2 part of SECTION_8 equals what Swagger documents AND what Express serves;
 * - a cross-module IDOR matrix: instructor B with every id of instructor A (course, section,
 *   lecture, asset, upload, revision) on the media, builder, lifecycle and preview routes;
 * - the moderation race over HTTP (double approve; approve vs reject): exactly one 200;
 * - upload complete idempotency over HTTP: parallel completes, one `MediaUploaded`;
 * - `order_mismatch` over HTTP;
 * - one full happy path: create, upload (the transcoder is simulated: READY + fake HLS objects),
 *   build, submit, approve, anonymous browse, landing, preview playback incl. a segment fetch.
 *
 * Every row, object and rate-limit key the file creates is removed in afterAll, which then
 * checks that nothing is left, so a second run starts from the same state (fresh users, a fresh
 * category tag, fresh TEST-NET IPs). Timing: no wall-clock upper bounds anywhere.
 */
const V1 = '/api/v1';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const DESCRIPTION = 'TypeScript from the ground up, with real projects. '.repeat(6);

interface UserFx {
  readonly user: SignedUpUser;
  readonly token: AuthResult;
}

/** A course of instructor A that was submitted (IN_REVIEW, so it has a pending revision). */
interface IdorCourse {
  readonly courseId: string;
  readonly sectionId: string;
  readonly videoId: string;
  readonly articleId: string;
  readonly videoAssetId: string;
  readonly thumbnailAssetId: string;
  readonly revisionId: string;
  /** An UPLOADING asset of A (nothing uploaded). */
  readonly uploadingAssetId: string;
}

/** A DRAFT course of instructor B (for "B's course + A's child id" combinations). */
interface OwnCourse {
  readonly courseId: string;
  readonly sectionId: string;
  readonly videoId: string;
}

interface Fixtures {
  readonly admin: UserFx;
  readonly a: UserFx;
  readonly b: UserFx;
  readonly groupId: string;
  readonly groupSlug: string;
  readonly leafId: string;
  readonly ofA: IdorCourse;
  readonly ofB: OwnCourse;
}

const op = ([path, method]: Operation): string => `${method.toUpperCase()} ${path}`;

describe('Phase 2 API sweep (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };

  const instructorA = (): BearerClient => e2e.as('instructor', fixtures().a.token.accessToken);
  const instructorB = (): BearerClient => e2e.as('instructor', fixtures().b.token.accessToken);
  const admin = (): BearerClient => e2e.as('admin', fixtures().admin.token.accessToken);
  /** The student BFF with client credentials only: an anonymous visitor. */
  const anonymous = (path: string): request.Test => e2e.http().get(path).set(e2e.client('student'));

  /* ------------------------------------------------------------------------ helpers */

  /** POST /media/uploads -> part-urls -> PUT (real MinIO) -> complete: an UPLOADED asset. */
  async function uploadOverHttp(
    client: BearerClient,
    input: { purpose: MediaPurpose; filename: string; contentType: string; bytes: Buffer },
  ): Promise<string> {
    const init = await client
      .post(`${V1}/media/uploads`)
      .send({
        purpose: input.purpose,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
      })
      .expect(201);
    const { assetId, partCount } = InitiateUploadResponseSchema.parse(init.body);
    expect(partCount).toBe(1);
    await putSinglePart(client, assetId, input.bytes);
    const done = await client.post(`${V1}/media/uploads/${assetId}/complete`).send({}).expect(200);
    expect(AssetViewSchema.parse(done.body)).toMatchObject({ id: assetId, status: 'UPLOADED' });
    return assetId;
  }

  async function putSinglePart(client: BearerClient, assetId: string, bytes: Buffer) {
    const parts = await client
      .post(`${V1}/media/uploads/${assetId}/part-urls`)
      .send({ partNumbers: [1] })
      .expect(200);
    const url = PresignPartsResponseSchema.parse(parts.body).urls[0]?.url ?? '';
    expect((await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) })).status).toBe(200);
  }

  /**
   * A course that passes the e2e readiness rules (1 lecture, 0 s of video), built over HTTP
   * with assets seeded READY (with their output objects in MinIO).
   */
  async function buildReadyCourse(
    client: BearerClient,
    owner: SignedUpUser,
  ): Promise<{ courseId: string; sectionId: string; videoId: string; video: string }> {
    const created = await client
      .post(`${V1}/instructor/courses`)
      .send({ title: `Phase2 ${tag} ${randomUUID().slice(0, 6)}` })
      .expect(201);
    const courseId = CourseDetailSchema.parse(created.body).id;
    const db = e2e.pg.db;
    const thumbnail = await insertReadyThumbnail(db, s3.storage, owner.userId);
    const video = await insertReadyVideo(db, s3.storage, owner.userId);
    return { courseId, video, ...(await buildCourseOnto(client, courseId, { thumbnail, video })) };
  }

  /**
   * Course details, thumbnail and one section with one free-preview VIDEO lecture on an
   * existing course, over HTTP (the given assets must be READY for readiness).
   */
  async function buildCourseOnto(
    client: BearerClient,
    courseId: string,
    assets: { thumbnail: string; video: string },
  ): Promise<{ sectionId: string; videoId: string }> {
    const base = `${V1}/courses/${courseId}`;
    await client
      .patch(base)
      .send({
        subtitle: 'A subtitle for the course',
        descriptionMd: DESCRIPTION,
        language: 'en',
        level: 'BEGINNER',
        categoryId: fixtures().leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      })
      .expect(200);
    await client.put(`${base}/thumbnail`).send({ assetId: assets.thumbnail }).expect(200);
    const section = SectionSchema.parse(
      (await client.post(`${base}/sections`).send({ title: 'Section one' }).expect(201)).body,
    );
    const videoId = LectureSchema.parse(
      (
        await client
          .post(`${base}/sections/${section.id}/lectures`)
          .send({ type: 'VIDEO', title: 'Welcome video' })
          .expect(201)
      ).body,
    ).id;
    await client
      .put(`${base}/lectures/${videoId}/media`)
      .send({ assetId: assets.video })
      .expect(200);
    await client.patch(`${base}/lectures/${videoId}`).send({ isPreview: true }).expect(200);
    return { sectionId: section.id, videoId };
  }

  async function submit(client: BearerClient, courseId: string): Promise<string> {
    return SubmitCourseResponseSchema.parse(
      (await client.post(`${V1}/courses/${courseId}/submit`).send({}).expect(200)).body,
    ).revisionId;
  }

  async function signupInstructor(adminId: string): Promise<UserFx> {
    const user = await e2e.signup({ displayName: `Phase2 ${tag}` });
    await e2e.verifyEmailViaSql(user.userId);
    await e2e.promoteToInstructor(user.userId, adminId);
    return { user, token: await e2e.login('instructor', user.email) };
  }

  /* ------------------------------------------------------------------------ fixtures */

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const adminFx: UserFx = {
      user: adminUser,
      token: await e2e.login('admin', adminUser.email),
    };
    const a = await signupInstructor(adminUser.userId);
    const b = await signupInstructor(adminUser.userId);

    const adminClient = e2e.as('admin', adminFx.token.accessToken);
    const group = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Phase2 ${tag}` })
          .expect(201)
      ).body,
    );
    categoryIds.push(group.id);
    const leaf = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Phase2 leaf ${tag}`, parentId: group.id })
          .expect(201)
      ).body,
    );
    categoryIds.push(leaf.id);
    fx = {
      admin: adminFx,
      a,
      b,
      groupId: group.id,
      groupSlug: group.slug,
      leafId: leaf.id,
      ofA: undefined as unknown as IdorCourse,
      ofB: undefined as unknown as OwnCourse,
    };

    // A: a submitted course (pending revision) with an extra ARTICLE lecture, plus an
    // unfinished upload.
    const clientA = e2e.as('instructor', a.token.accessToken);
    const built = await buildReadyCourse(clientA, a.user);
    const articleId = LectureSchema.parse(
      (
        await clientA
          .post(`${V1}/courses/${built.courseId}/sections/${built.sectionId}/lectures`)
          .send({ type: 'ARTICLE', title: 'Notes' })
          .expect(201)
      ).body,
    ).id;
    await clientA
      .put(`${V1}/courses/${built.courseId}/lectures/${articleId}/article`)
      .send({ bodyMd: 'An article body that is comfortably longer than fifty characters.' })
      .expect(200);
    const detail = CourseDetailSchema.parse(
      (await clientA.get(`${V1}/courses/${built.courseId}`).expect(200)).body,
    );
    const revisionId = await submit(clientA, built.courseId);
    const uploading = InitiateUploadResponseSchema.parse(
      (
        await clientA
          .post(`${V1}/media/uploads`)
          .send({
            purpose: 'LECTURE_VIDEO',
            filename: 'draft.mp4',
            contentType: 'video/mp4',
            sizeBytes: 1024,
          })
          .expect(201)
      ).body,
    ).assetId;

    // B: a DRAFT course with one section and one VIDEO lecture (no media).
    const clientB = e2e.as('instructor', b.token.accessToken);
    const own = CourseDetailSchema.parse(
      (
        await clientB
          .post(`${V1}/instructor/courses`)
          .send({ title: `Phase2 B ${tag}` })
          .expect(201)
      ).body,
    );
    const ownSection = SectionSchema.parse(
      (
        await clientB
          .post(`${V1}/courses/${own.id}/sections`)
          .send({ title: 'B section' })
          .expect(201)
      ).body,
    );
    const ownVideo = LectureSchema.parse(
      (
        await clientB
          .post(`${V1}/courses/${own.id}/sections/${ownSection.id}/lectures`)
          .send({ type: 'VIDEO', title: 'B video' })
          .expect(201)
      ).body,
    );

    fx = {
      ...fx,
      ofA: {
        courseId: built.courseId,
        sectionId: built.sectionId,
        videoId: built.videoId,
        articleId,
        videoAssetId: built.video,
        thumbnailAssetId: detail.thumbnailAssetId ?? '',
        revisionId,
        uploadingAssetId: uploading,
      },
      ofB: { courseId: own.id, sectionId: ownSection.id, videoId: ownVideo.id },
    };
  });

  // Registered after useE2eApp/useIntegrationS3, so it runs BEFORE their teardown (the harness
  // then deletes the users, sessions, outbox rows of the users and the per-IP keys).
  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const db = e2e.pg.db;
    const owners = [fx.admin, fx.a, fx.b].map((u) => u.user.userId);
    const assetIds = (
      await db.selectFrom('media.assets').select('id').where('ownerId', 'in', owners).execute()
    ).map((r) => r.id);

    await deleteMediaTestData(db, owners, { storage: s3.storage, redis: e2e.redis.redis });
    await deleteCatalogTestData(db, { ownerIds: owners, categoryIds, deleteUsers: false });
    await e2e.redis.redis.del(...owners.map((id) => `rl:catalog:submit:u:${id}`));

    // Nothing of this file is left (so a second run starts clean).
    const left = await sql<{ courses: string; assets: string; categories: string; events: string }>`
      SELECT (SELECT count(*) FROM catalog.courses WHERE owner_id = ANY(${owners}::uuid[])) AS courses,
             (SELECT count(*) FROM media.assets WHERE owner_id = ANY(${owners}::uuid[])) AS assets,
             (SELECT count(*) FROM catalog.categories WHERE id = ANY(${categoryIds}::uuid[])) AS categories,
             (SELECT count(*) FROM outbox.events WHERE aggregate_id = ANY(${assetIds}::text[])) AS events
    `.execute(db);
    expect(left.rows[0]).toEqual({ courses: '0', assets: '0', categories: '0', events: '0' });
    for (const owner of owners) {
      for await (const object of s3.storage.listObjects({
        bucket: 'uploads',
        prefix: `uploads/${owner}/`,
      })) {
        throw new Error(`leftover upload object ${object.key}`);
      }
    }
    for (const id of assetIds) {
      for await (const object of s3.storage.listObjects({
        bucket: 'media',
        prefix: `assets/${id}/`,
      })) {
        throw new Error(`leftover media object ${object.key}`);
      }
    }
    const keys = owners.flatMap((id) => [
      `rl:media:initiate:u:${id}`,
      `rl:media:parts:u:${id}`,
      `rl:catalog:submit:u:${id}`,
    ]);
    expect(await e2e.redis.redis.exists(...keys)).toBe(0);
  });

  /* ------------------------------------------------------------------ SECTION_8 */

  describe('SECTION_8: the Phase 2 operations', () => {
    const phase1 = new Set(SECTION_8_PHASE_1.map(op));
    const phase2 = SECTION_8_PHASE_2.map(op).sort();

    it('has no duplicates and no overlap with Phase 1', () => {
      expect(new Set(phase2).size).toBe(phase2.length);
      expect(phase2.filter((o) => phase1.has(o))).toEqual([]);
    });

    it('equals the Phase 2 operations Swagger documents (no extras, no gaps)', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/api/docs-json').expect(200);
      const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
      const documented = Object.entries(paths)
        .filter(([path]) => !path.startsWith('/api/health'))
        .flatMap(([path, item]) =>
          Object.keys(item)
            .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
            .map((method) => op([path, method])),
        )
        .filter((o) => !phase1.has(o))
        .sort();
      expect(documented).toEqual(phase2);
    });

    it('equals the Phase 2 routes Express serves (nothing undocumented hides)', (ctx) => {
      e2e.skip(ctx);
      const served = expressRoutes(e2e.app.getHttpAdapter().getInstance())
        .filter(([path]) => path.startsWith(`${V1}/`) || path.startsWith('/.well-known/'))
        .map(op)
        .filter((o) => !phase1.has(o));
      expect([...new Set(served)].sort()).toEqual(phase2);
    });
  });

  /* ------------------------------------------------------------------ IDOR matrix */

  describe('cross-module IDOR: instructor B with instructor A ids', () => {
    /** Every route an instructor can reach with an id of A's, as [method, path, body]. */
    function routesWithIdsOfA(): (readonly [HttpMethod, string, object?])[] {
      const { ofA, ofB } = fixtures();
      const course = `${V1}/courses/${ofA.courseId}`;
      const lecture = `${course}/lectures/${ofA.videoId}`;
      const own = `${V1}/courses/${ofB.courseId}`;
      return [
        // media: uploads and assets of A
        ['get', `${V1}/media/uploads/${ofA.uploadingAssetId}`],
        ['post', `${V1}/media/uploads/${ofA.uploadingAssetId}/part-urls`, { partNumbers: [1] }],
        ['post', `${V1}/media/uploads/${ofA.uploadingAssetId}/complete`, {}],
        ['delete', `${V1}/media/uploads/${ofA.uploadingAssetId}`],
        ['get', `${V1}/media/assets/${ofA.videoAssetId}`],
        ['get', `${V1}/media/assets/${ofA.thumbnailAssetId}`],
        // catalog builder: A's course and its children
        ['get', course],
        ['patch', course, { title: 'Hijacked title' }],
        ['delete', course],
        ['put', `${course}/thumbnail`, { assetId: ofA.thumbnailAssetId }],
        ['delete', `${course}/thumbnail`],
        ['get', `${course}/curriculum`],
        [
          'put',
          `${course}/curriculum/order`,
          { sections: [{ sectionId: ofA.sectionId, lectureIds: [ofA.videoId, ofA.articleId] }] },
        ],
        ['post', `${course}/sections`, { title: 'Injected' }],
        ['patch', `${course}/sections/${ofA.sectionId}`, { title: 'Hijacked' }],
        ['delete', `${course}/sections/${ofA.sectionId}`],
        ['post', `${course}/sections/${ofA.sectionId}/lectures`, { type: 'VIDEO', title: 'X' }],
        ['patch', lecture, { title: 'Hijacked' }],
        ['delete', lecture],
        ['get', `${course}/lectures/${ofA.articleId}/article`],
        ['put', `${course}/lectures/${ofA.articleId}/article`, { bodyMd: 'Hijacked body' }],
        ['put', `${lecture}/media`, { assetId: ofA.videoAssetId }],
        ['delete', `${lecture}/media`],
        // lifecycle
        ['post', `${course}/submit`, {}],
        ['post', `${course}/withdraw`, {}],
        ['post', `${course}/archive`, {}],
        ['post', `${course}/restore`, {}],
        ['get', `${course}/history`],
        // working-copy preview and downloads
        ['get', `${course}/thumbnail`],
        ['get', `${lecture}/preview/hls/master.m3u8`],
        ['get', `${lecture}/preview/hls/360p.m3u8`],
        ['get', `${lecture}/download`],
        // B's OWN course combined with A's child ids and assets
        ['patch', `${own}/sections/${ofA.sectionId}`, { title: 'Hijacked' }],
        ['delete', `${own}/sections/${ofA.sectionId}`],
        ['post', `${own}/sections/${ofA.sectionId}/lectures`, { type: 'VIDEO', title: 'X' }],
        ['patch', `${own}/lectures/${ofA.videoId}`, { title: 'Hijacked' }],
        ['delete', `${own}/lectures/${ofA.videoId}`],
        ['get', `${own}/lectures/${ofA.articleId}/article`],
        ['put', `${own}/lectures/${ofA.articleId}/article`, { bodyMd: 'Hijacked body' }],
        ['put', `${own}/lectures/${ofA.videoId}/media`, { assetId: ofA.videoAssetId }],
        ['delete', `${own}/lectures/${ofA.videoId}/media`],
        ['get', `${own}/lectures/${ofA.videoId}/preview/hls/master.m3u8`],
        ['get', `${own}/lectures/${ofA.videoId}/download`],
        ['put', `${own}/thumbnail`, { assetId: ofA.thumbnailAssetId }],
        ['put', `${own}/lectures/${ofB.videoId}/media`, { assetId: ofA.videoAssetId }],
      ];
    }

    it('every route answers 404 and nothing of A changes', async (ctx) => {
      skip(ctx);
      const { ofA } = fixtures();
      const before = await snapshotOfA();
      const failures: string[] = [];
      for (const [method, path, body] of routesWithIdsOfA()) {
        const req = instructorB().call(method, path);
        const res = await (body === undefined ? req : req.send(body));
        if (res.status !== 404) failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
        else expectProblem(res, 404);
      }
      expect(failures).toEqual([]);
      // B's id-list read silently omits A's assets (design §8), it never reveals them.
      const listed = AssetPageSchema.parse(
        (
          await instructorB()
            .get(`${V1}/media/assets?ids=${ofA.videoAssetId},${ofA.thumbnailAssetId}`)
            .expect(200)
        ).body,
      );
      expect(listed.items).toEqual([]);
      expect(await snapshotOfA()).toEqual(before);
    });

    it("A's revision: instructors are refused by the admin guard (403, documented), and an admin cannot address it through another course (404)", async (ctx) => {
      skip(ctx);
      const { ofA, ofB } = fixtures();
      const rev = `${V1}/admin/course-revisions/${ofA.revisionId}`;
      // §14 P2-T11 accepted decision: non-admins on admin revision routes get 403, not 404.
      for (const path of [
        rev,
        `${rev}/thumbnail`,
        `${rev}/lectures/${ofA.videoId}/hls/master.m3u8`,
        `${rev}/lectures/${ofA.articleId}/article`,
      ]) {
        expectProblem(await instructorB().get(path), 403);
      }
      expectProblem(
        await instructorB()
          .post(`${V1}/admin/courses/${ofA.courseId}/revisions/${ofA.revisionId}/approve`)
          .send({}),
        403,
      );
      // The revision only resolves under its own course, and lectures only within it.
      for (const action of ['approve', 'reject'] as const) {
        expectProblem(
          await admin()
            .post(`${V1}/admin/courses/${ofB.courseId}/revisions/${ofA.revisionId}/${action}`)
            .send(action === 'reject' ? { reason: 'Not this course at all.' } : {}),
          404,
        );
      }
      expectProblem(await admin().get(`${rev}/lectures/${ofB.videoId}/hls/master.m3u8`), 404);
      // ...and A's course is still waiting for review.
      const course = CourseDetailSchema.parse(
        (await instructorA().get(`${V1}/courses/${ofA.courseId}`).expect(200)).body,
      );
      expect(course).toMatchObject({
        status: 'IN_REVIEW',
        pendingRevision: { id: ofA.revisionId },
      });
    });

    /** Everything B's requests could have touched, read straight from the database. */
    async function snapshotOfA(): Promise<unknown> {
      const { ofA } = fixtures();
      const db = e2e.pg.db;
      return {
        course: await db
          .selectFrom('catalog.courses')
          .select(['title', 'status', 'version', 'thumbnailAssetId', 'deletedAt'])
          .where('id', '=', ofA.courseId)
          .executeTakeFirst(),
        sections: await db
          .selectFrom('catalog.sections')
          .select(['id', 'title', 'position'])
          .where('courseId', '=', ofA.courseId)
          .orderBy('position')
          .execute(),
        lectures: await db
          .selectFrom('catalog.lectures')
          .select(['id', 'title', 'position', 'sectionId', 'mediaAssetId'])
          .where('courseId', '=', ofA.courseId)
          .orderBy('position')
          .execute(),
        upload: await db
          .selectFrom('media.assets')
          .select(['status', 's3UploadId'])
          .where('id', '=', ofA.uploadingAssetId)
          .executeTakeFirst(),
      };
    }
  });

  /* ------------------------------------------------------------------ races */

  describe('moderation race over HTTP', () => {
    it('a double approve: exactly one 200, the other 409', async (ctx) => {
      skip(ctx);
      const { a } = fixtures();
      const client = instructorA();
      const { courseId } = await buildReadyCourse(client, a.user);
      const revisionId = await submit(client, courseId);
      const approve = `${V1}/admin/courses/${courseId}/revisions/${revisionId}/approve`;
      const results = await Promise.all([
        admin().post(approve).send({}),
        admin().post(approve).send({}),
      ]);
      expectExactlyOneWinner(results);
      await expectDecisions(revisionId, ['APPROVE']);
      const course = CourseDetailSchema.parse(
        (await client.get(`${V1}/courses/${courseId}`).expect(200)).body,
      );
      expect(course).toMatchObject({ status: 'PUBLISHED', liveRevision: { id: revisionId } });
    });

    it('approve vs reject in parallel: exactly one 200, the other 409', async (ctx) => {
      skip(ctx);
      const { a } = fixtures();
      const client = instructorA();
      const { courseId } = await buildReadyCourse(client, a.user);
      const revisionId = await submit(client, courseId);
      const decide = `${V1}/admin/courses/${courseId}/revisions/${revisionId}`;
      const results = await Promise.all([
        admin().post(`${decide}/approve`).send({}),
        admin().post(`${decide}/reject`).send({ reason: 'Racing rejection reason.' }),
      ]);
      expectExactlyOneWinner(results);
      const winner = results.findIndex((r) => r.status === 200) === 0 ? 'APPROVE' : 'REJECT';
      await expectDecisions(revisionId, [winner]);
      const course = CourseDetailSchema.parse(
        (await client.get(`${V1}/courses/${courseId}`).expect(200)).body,
      );
      expect(course.status).toBe(winner === 'APPROVE' ? 'PUBLISHED' : 'REJECTED');
    });

    function expectExactlyOneWinner(results: request.Response[]): void {
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409);
      if (loser === undefined) throw new Error('no loser');
      expectProblem(loser, 409);
      expect([ErrorCode.InvalidStateTransition, ErrorCode.VersionConflict]).toContain(
        loser.body.code,
      );
      CourseDetailSchema.parse(results.find((r) => r.status === 200)?.body);
    }

    async function expectDecisions(revisionId: string, actions: string[]): Promise<void> {
      const rows = await e2e.pg.db
        .selectFrom('catalog.courseTransitions')
        .select('action')
        .where('revisionId', '=', revisionId)
        .where('action', 'in', ['APPROVE', 'REJECT', 'WITHDRAW'])
        .execute();
      expect(rows.map((r) => r.action)).toEqual(actions);
    }
  });

  describe('upload complete idempotency over HTTP', () => {
    it('two parallel completes: both answer the UPLOADED asset, one MediaUploaded', async (ctx) => {
      skip(ctx);
      const client = instructorB();
      const bytes = randomBytes(4096);
      const { assetId } = InitiateUploadResponseSchema.parse(
        (
          await client
            .post(`${V1}/media/uploads`)
            .send({
              purpose: 'LECTURE_VIDEO',
              filename: 'race.mp4',
              contentType: 'video/mp4',
              sizeBytes: bytes.length,
            })
            .expect(201)
        ).body,
      );
      await putSinglePart(client, assetId, bytes);

      const complete = `${V1}/media/uploads/${assetId}/complete`;
      const results = await Promise.all([
        client.post(complete).send({}),
        client.post(complete).send({}),
      ]);
      for (const res of results) {
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(AssetViewSchema.parse(res.body)).toMatchObject({ id: assetId, status: 'UPLOADED' });
      }
      // A late third complete is answered from the state, too.
      await client.post(complete).send({}).expect(200);

      const events = await e2e.pg.db
        .selectFrom('outbox.events')
        .select('type')
        .where('aggregateId', '=', assetId)
        .execute();
      expect(events.map((e) => e.type)).toEqual(['MediaUploaded.v1']);
      const object = await s3.storage.headObject({
        bucket: 'uploads',
        key: `uploads/${fixtures().b.user.userId}/${assetId}/source`,
      });
      expect(object?.size).toBe(bytes.length);
    });
  });

  describe('curriculum order over HTTP', () => {
    it('a stale or partial order is 409 order_mismatch and changes nothing', async (ctx) => {
      skip(ctx);
      const client = instructorB();
      const { ofB } = fixtures();
      const base = `${V1}/courses/${ofB.courseId}`;
      const second = LectureSchema.parse(
        (
          await client
            .post(`${base}/sections/${ofB.sectionId}/lectures`)
            .send({ type: 'ARTICLE', title: 'B article' })
            .expect(201)
        ).body,
      ).id;
      const ok = CurriculumSchema.parse(
        (
          await client
            .put(`${base}/curriculum/order`)
            .send({ sections: [{ sectionId: ofB.sectionId, lectureIds: [second, ofB.videoId] }] })
            .expect(200)
        ).body,
      );
      expect(ok.sections[0]?.lectures.map((l) => l.id)).toEqual([second, ofB.videoId]);

      // An order computed before `third` existed is stale: the full set must be named.
      const third = LectureSchema.parse(
        (
          await client
            .post(`${base}/sections/${ofB.sectionId}/lectures`)
            .send({ type: 'ARTICLE', title: 'B article 2' })
            .expect(201)
        ).body,
      ).id;
      expectProblem(
        await client
          .put(`${base}/curriculum/order`)
          .send({ sections: [{ sectionId: ofB.sectionId, lectureIds: [ofB.videoId, second] }] }),
        409,
        ErrorCode.OrderMismatch,
      );
      // A lecture of A's course in B's order is a mismatch too (never a cross-course move).
      expectProblem(
        await client.put(`${base}/curriculum/order`).send({
          sections: [
            {
              sectionId: ofB.sectionId,
              lectureIds: [ofB.videoId, second, third, fixtures().ofA.videoId],
            },
          ],
        }),
        409,
        ErrorCode.OrderMismatch,
      );
      const now = CurriculumSchema.parse((await client.get(`${base}/curriculum`).expect(200)).body);
      expect(now.sections[0]?.lectures.map((l) => l.id)).toEqual([second, ofB.videoId, third]);
    });
  });

  /* ------------------------------------------------------------------ happy path */

  it('the full happy path: create, upload, build, submit, approve, browse, landing, preview', async (ctx) => {
    skip(ctx);
    const { a, groupId, groupSlug, leafId } = fixtures();
    const client = instructorA();

    // 1. create
    const title = `Happy path ${tag}`;
    const created = await client.post(`${V1}/instructor/courses`).send({ title }).expect(201);
    const courseId = CourseDetailSchema.parse(created.body).id;
    expect(created.headers.location).toBe(`/api/v1/courses/${courseId}`);

    // 2. upload a tiny thumbnail and a tiny fake video over HTTP; no transcoder runs here, so
    //    its outputs are simulated (READY + renditions + fake HLS objects in MinIO).
    const thumbnail = await uploadOverHttp(client, {
      purpose: 'COURSE_THUMBNAIL',
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
      bytes: FAKE_JPEG,
    });
    const video = await uploadOverHttp(client, {
      purpose: 'LECTURE_VIDEO',
      filename: 'welcome.mp4',
      contentType: 'video/mp4',
      bytes: randomBytes(4096),
    });
    const db = e2e.pg.db;
    await finishTranscodeLikeTranscoder(db, s3.storage, thumbnail, {
      purpose: 'COURSE_THUMBNAIL',
    });
    await finishTranscodeLikeTranscoder(db, s3.storage, video, {
      purpose: 'LECTURE_VIDEO',
      durationMs: 9_000,
    });
    for (const id of [thumbnail, video]) {
      expect(
        AssetViewSchema.parse((await client.get(`${V1}/media/assets/${id}`).expect(200)).body)
          .status,
      ).toBe('READY');
    }

    // 3. build the curriculum and submit
    const built = await buildCourseOnto(client, courseId, { thumbnail, video });
    const before = CourseDetailSchema.parse(
      (await client.get(`${V1}/courses/${courseId}`).expect(200)).body,
    );
    expect(before.readiness.ready).toBe(true);
    const revisionId = await submit(client, courseId);

    // 4. admin reviews and approves
    const review = RevisionReviewSchema.parse(
      (await admin().get(`${V1}/admin/course-revisions/${revisionId}`).expect(200)).body,
    );
    expect(review.revision).toMatchObject({ state: 'PENDING', kind: 'INITIAL', title });
    expect(review.revision.category).toMatchObject({ id: leafId, parent: { id: groupId } });
    expect(review.assets.map((x) => x.id).sort()).toEqual([thumbnail, video].sort());
    const live = CourseDetailSchema.parse(
      (
        await admin()
          .post(`${V1}/admin/courses/${courseId}/revisions/${revisionId}/approve`)
          .send({ note: 'Welcome aboard' })
          .expect(200)
      ).body,
    );
    expect(live).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE' });

    // 5. an anonymous visitor finds it
    const page = CourseCardPageSchema.parse(
      (await anonymous(`${V1}/catalog/courses?category=${groupSlug}`).expect(200)).body,
    );
    // (The race tests may have published courses in this category too; titles are unique.)
    expect(page.items.filter((card) => card.title === title)).toEqual([
      expect.objectContaining({
        id: courseId,
        slug: live.slug,
        instructor: { id: a.user.userId, displayName: `Phase2 ${tag}` },
        category: expect.objectContaining({ id: leafId }),
        lectureCount: 1,
        videoSeconds: 9,
        hasThumbnail: true,
      }),
    ]);
    const searched = CourseCardPageSchema.parse(
      (await anonymous(`${V1}/catalog/courses?q=${encodeURIComponent(title)}`).expect(200)).body,
    );
    expect(searched.items.map((card) => card.id)).toContain(courseId);

    // 6. the landing page
    const landing = CourseLandingSchema.parse(
      (await anonymous(`${V1}/catalog/courses/by-slug/${live.slug}`).expect(200)).body,
    );
    expect(landing).toMatchObject({
      id: courseId,
      revisionId,
      title,
      subtitle: 'A subtitle for the course',
      descriptionMd: DESCRIPTION,
      language: 'en',
      level: 'BEGINNER',
      outcomes: ['One', 'Two', 'Three', 'Four'],
      instructor: { id: a.user.userId, displayName: `Phase2 ${tag}` },
      totals: { sectionCount: 1, lectureCount: 1, videoSeconds: 9 },
      hasThumbnail: true,
    });
    expect(landing.categoryPath.map((c) => c.id)).toEqual([groupId, leafId]);
    expect(landing.sections).toEqual([
      {
        id: built.sectionId,
        title: 'Section one',
        objective: null,
        lectures: [
          {
            id: built.videoId,
            title: 'Welcome video',
            type: 'VIDEO',
            durationSeconds: 9,
            isPreview: true,
          },
        ],
      },
    ]);
    const image = SignedUrlSchema.parse(
      (
        await anonymous(`${V1}/catalog/courses/${courseId}/images/thumbnail?variant=w480`).expect(
          200,
        )
      ).body,
    );
    const imageRes = await fetch(image.url);
    expect(imageRes.status).toBe(200);
    expect(Buffer.from(await imageRes.arrayBuffer()).equals(FAKE_JPEG)).toBe(true);

    // 7. the free preview plays anonymously: master + variant + a presigned segment
    const lecture = `${V1}/catalog/courses/${courseId}/lectures/${built.videoId}`;
    const master = await anonymous(`${lecture}/hls/master.m3u8`).expect(200);
    expect(master.headers['content-type']).toContain(HLS_PLAYLIST_CONTENT_TYPE);
    expect(master.text.startsWith('#EXTM3U\n')).toBe(true);
    expect(master.text).toContain('\n360p.m3u8\n');
    const variant = await anonymous(`${lecture}/hls/360p.m3u8`).expect(200);
    expect(variant.text).toContain('#EXT-X-ENDLIST');
    const segments = variant.text.split('\n').filter((line) => line.startsWith('http'));
    expect(segments).toHaveLength(2);
    const segment = await fetch(segments[0] ?? '');
    expect(segment.status).toBe(200);
    expect(Buffer.from(await segment.arrayBuffer()).equals(FAKE_SEGMENT)).toBe(true);
  });
});

/**
 * The routes Express really serves, as OpenAPI-style operations (`:param` -> `{param}`). Nest
 * registers every handler as a route layer on the app's router (Express 5: `app.router`).
 */
function expressRoutes(app: unknown): Operation[] {
  interface Layer {
    route?: { path: unknown; methods: Record<string, boolean> };
  }
  const router = (app as { router?: { stack?: Layer[] } }).router;
  if (router?.stack === undefined) throw new Error('unexpected Express internals: no app.router');
  return router.stack.flatMap((layer): Operation[] => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== 'string') return [];
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    return Object.keys(route.methods)
      .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
      .map((method): Operation => [path, method]);
  });
}
