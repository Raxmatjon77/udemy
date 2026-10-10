// Must stay the first import: AppModule validates process.env when it is imported.
import './testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  CategoryTreeResponseSchema,
  CourseCardPageSchema,
  CourseDetailSchema,
  CourseLandingSchema,
  ErrorCode,
  HLS_PLAYLIST_CONTENT_TYPE,
  PublicArticleSchema,
  SignedUrlSchema,
  SubmitCourseResponseSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { AttachLectureMediaCommand } from './application/use-cases/attach-lecture-media.command';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { SaveArticleCommand } from './application/use-cases/save-article.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { UpdateLectureCommand } from './application/use-cases/update-lecture.command';
import { playbackRateLimitKey } from './infrastructure/redis-playback-rate-limiter';
import { deleteCatalogTestData } from './testing/catalog-it';
import {
  FAKE_SEGMENT,
  insertReadyResource,
  insertReadyThumbnail,
  insertReadyVideo,
} from './testing/catalog-public-it';

/*
 * P2-T11 endpoints (design §8) through the REAL AppModule: global guards in production order
 * (client auth, throttler, optional Bearer on @Public routes, policies), validation,
 * problem+json, Postgres, Redis and MinIO. The public routes work with the student BFF's
 * client credentials alone; the full authorization matrix runs across anonymous / student /
 * owner / other instructor / admin for the live, working-copy and revision sources.
 */
const V1 = '/api/v1';

type Viewer = 'anonymous' | 'student' | 'owner' | 'other' | 'admin';

interface Fixtures {
  users: { owner: SignedUpUser; other: SignedUpUser; student: SignedUpUser; admin: SignedUpUser };
  tokens: { owner: AuthResult; other: AuthResult; student: AuthResult; admin: AuthResult };
  groupSlug: string;
  courseId: string;
  slug: string;
  revisionId: string;
  lectures: { previewVideo: string; lockedVideo: string; article: string; resource: string };
}

describe('public catalog and playback endpoints (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  const categoryIds: string[] = [];
  const usedIps = new Set<string>();
  const tag = randomUUID().slice(0, 8);
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });

  /** A request through the student BFF with client credentials only (no session). */
  function anonymous(path: string): request.Test {
    usedIps.add(e2e.ip());
    return e2e.http().get(path).set(e2e.client('student'));
  }

  /** Each viewer through its own app (D6: permissions are app-scoped). */
  function viewer(name: Exclude<Viewer, 'anonymous'>): BearerClient {
    usedIps.add(e2e.ip());
    const { tokens } = fixtures();
    switch (name) {
      case 'student':
        return e2e.as('student', tokens.student.accessToken);
      case 'owner':
        return e2e.as('instructor', tokens.owner.accessToken);
      case 'other':
        return e2e.as('instructor', tokens.other.accessToken);
      case 'admin':
        return e2e.as('admin', tokens.admin.accessToken);
    }
  }

  const call = (who: Viewer, path: string): request.Test =>
    who === 'anonymous' ? anonymous(path) : viewer(who).get(path);

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const other = await e2e.signup();
    const student = await e2e.signup();
    for (const u of [owner, other, student]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    await e2e.promoteToInstructor(other.userId, admin.userId);
    const tokens = {
      owner: await e2e.login('instructor', owner.email),
      other: await e2e.login('instructor', other.email),
      student: await e2e.login('student', student.email),
      admin: await e2e.login('admin', admin.email),
    };

    // The course is built through the use cases (covered over HTTP by catalog.e2e), then
    // submitted and approved over HTTP.
    const group = await get(CreateCategoryCommand).execute({ name: `Pub e2e ${tag}` });
    const leaf = await get(CreateCategoryCommand).execute({
      name: `Pub e2e leaf ${tag}`,
      parentId: group.id,
    });
    categoryIds.push(group.id, leaf.id);
    const ownerId = owner.userId;
    const course = await get(CreateCourseCommand).execute({
      ownerId,
      title: `Public e2e ${tag}`,
    });
    const as = { actorId: ownerId, courseId: course.id };
    await get(UpdateCourseCommand).execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: leaf.id,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    await get(SetCourseThumbnailCommand).execute({
      ...as,
      assetId: await insertReadyThumbnail(e2e.pg.db, s3.storage, ownerId),
    });
    const section = await get(AddSectionCommand).execute({ ...as, title: 'Section one' });
    const add = async (type: 'VIDEO' | 'ARTICLE' | 'RESOURCE', title: string) =>
      (await get(AddLectureCommand).execute({ ...as, sectionId: section.id, type, title })).id;
    const previewVideo = await add('VIDEO', 'Preview video');
    const lockedVideo = await add('VIDEO', 'Locked video');
    const article = await add('ARTICLE', 'Locked article');
    const resource = await add('RESOURCE', 'Slides');
    for (const lectureId of [previewVideo, lockedVideo]) {
      await get(AttachLectureMediaCommand).execute({
        ...as,
        lectureId,
        assetId: await insertReadyVideo(e2e.pg.db, s3.storage, ownerId),
      });
    }
    await get(UpdateLectureCommand).execute({
      ...as,
      lectureId: previewVideo,
      patch: { isPreview: true },
    });
    await get(SaveArticleCommand).execute({
      ...as,
      lectureId: article,
      bodyMd: 'An article body that is comfortably longer than fifty characters.',
    });
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: resource,
      assetId: await insertReadyResource(e2e.pg.db, s3.storage, ownerId),
    });

    const { revisionId } = SubmitCourseResponseSchema.parse(
      (
        await e2e
          .as('instructor', tokens.owner.accessToken)
          .post(`${V1}/courses/${course.id}/submit`)
          .send({})
          .expect(200)
      ).body,
    );
    const detail = CourseDetailSchema.parse(
      (
        await e2e
          .as('admin', tokens.admin.accessToken)
          .post(`${V1}/admin/courses/${course.id}/revisions/${revisionId}/approve`)
          .send({})
          .expect(200)
      ).body,
    );
    fx = {
      users: { owner, other, student, admin },
      tokens,
      groupSlug: group.slug,
      courseId: course.id,
      slug: detail.slug,
      revisionId,
      lectures: { previewVideo, lockedVideo, article, resource },
    };
  });

  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const ids = Object.values(fx.users).map((u) => u.userId);
    await e2e.redis.redis.del(...[...usedIps].map(playbackRateLimitKey));
    await deleteMediaTestData(e2e.pg.db, ids, { storage: s3.storage });
    // The harness deletes the users themselves.
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: ids, categoryIds, deleteUsers: false });
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };

  const live = (lectureId: string, rest: string): string =>
    `${V1}/catalog/courses/${fixtures().courseId}/lectures/${lectureId}/${rest}`;
  const working = (lectureId: string, rest: string): string =>
    `${V1}/courses/${fixtures().courseId}/lectures/${lectureId}/${rest}`;
  const revision = (lectureId: string, rest: string): string =>
    `${V1}/admin/course-revisions/${fixtures().revisionId}/lectures/${lectureId}/${rest}`;

  /* ------------------------------------------------------------------ no session */

  it('categories, browse, landing and thumbnail work with client credentials only', async (ctx) => {
    skip(ctx);
    const { courseId, slug, groupSlug, users } = fixtures();

    const tree = await anonymous(`${V1}/catalog/categories`).expect(200);
    expect(tree.headers['cache-control']).toBe('public, max-age=300');
    const group = CategoryTreeResponseSchema.parse(tree.body).items.find(
      (g) => g.slug === groupSlug,
    );
    expect(group?.children).toHaveLength(1);

    const page = CourseCardPageSchema.parse(
      (await anonymous(`${V1}/catalog/courses?category=${groupSlug}&level=BEGINNER`).expect(200))
        .body,
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        id: courseId,
        slug,
        instructor: { id: users.owner.userId, displayName: `Owner ${tag}` },
        lectureCount: 4,
        hasThumbnail: true,
      }),
    ]);
    expect(page.nextCursor).toBeNull();

    const landing = CourseLandingSchema.parse(
      (await anonymous(`${V1}/catalog/courses/by-slug/${slug}`).expect(200)).body,
    );
    expect(landing).toMatchObject({ id: courseId, revisionId: fixtures().revisionId });
    expectProblem(
      await anonymous(`${V1}/catalog/courses/by-slug/no-such-${tag}`),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(await anonymous(`${V1}/catalog/courses/by-slug/Not_A_Slug`), 400);

    const thumbnail = await anonymous(
      `${V1}/catalog/courses/${courseId}/images/thumbnail?variant=w480`,
    ).expect(200);
    expect(thumbnail.headers['cache-control']).toBe('private, no-store');
    const signed = SignedUrlSchema.parse(thumbnail.body);
    expect((await fetch(signed.url)).status).toBe(200);
    expectProblem(
      await anonymous(`${V1}/catalog/courses/${randomUUID()}/images/thumbnail`),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(
      await anonymous(`${V1}/catalog/courses/${courseId}/images/thumbnail?variant=poster`),
      400,
    );

    // without client credentials nothing is served
    expectProblem(await e2e.http().get(`${V1}/catalog/categories`), 401);
  });

  it('a preview lecture plays anonymously: master + variant + a presigned segment', async (ctx) => {
    skip(ctx);
    const { previewVideo } = fixtures().lectures;

    const master = await anonymous(live(previewVideo, 'hls/master.m3u8')).expect(200);
    expect(master.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(master.headers['content-type']).toContain(HLS_PLAYLIST_CONTENT_TYPE);
    expect(master.headers['cache-control']).toBe('private, max-age=60');
    expect(master.text).toContain('\n360p.m3u8\n');

    const variant = await anonymous(live(previewVideo, 'hls/360p.m3u8')).expect(200);
    expect(variant.headers['cache-control']).toBe('private, no-store');
    const urls = variant.text.split('\n').filter((l) => l.startsWith('http'));
    expect(urls).toHaveLength(2);
    const segment = await fetch(urls[0] ?? '');
    expect(segment.status).toBe(200);
    expect(Buffer.from(await segment.arrayBuffer()).equals(FAKE_SEGMENT)).toBe(true);

    expectProblem(await anonymous(live(previewVideo, 'hls/master2.m3u8')), 400);
    expectProblem(await anonymous(live(previewVideo, 'hls/1080p.m3u8')), 404);
    expectProblem(
      await anonymous(live(fixtures().lectures.article, 'hls/master.m3u8')),
      422,
      ErrorCode.LectureTypeMismatch,
    );
    expectProblem(
      await anonymous(live(randomUUID(), 'hls/master.m3u8')),
      404,
      ErrorCode.LectureNotFound,
    );
  });

  /* -------------------------------------------------------------- authorization matrix */

  const LIVE_LOCKED: Record<Viewer, number> = {
    anonymous: 403,
    student: 403,
    owner: 200,
    other: 403,
    admin: 200,
  };
  // Authenticated route: no session = 401; the student app has no course:read = 403;
  // another instructor's course = 404 (policy); owner and admin read.
  const WORKING: Record<Viewer, number> = {
    anonymous: 401,
    student: 403,
    owner: 200,
    other: 404,
    admin: 200,
  };
  const REVISION: Record<Viewer, number> = {
    anonymous: 401,
    student: 403,
    owner: 403,
    other: 403,
    admin: 200,
  };
  const VIEWERS: Viewer[] = ['anonymous', 'student', 'owner', 'other', 'admin'];

  async function expectStatus(
    who: Viewer,
    path: string,
    status: number,
  ): Promise<request.Response> {
    const res = await call(who, path);
    if (status === 200) {
      expect(res.status, `${who} GET ${path}: ${res.text.slice(0, 300)}`).toBe(200);
    } else {
      expectProblem(res, status);
    }
    return res;
  }

  it.for(VIEWERS)('live revision matrix: %s', async (who, ctx) => {
    skip(ctx);
    const { lockedVideo, previewVideo, article, resource } = fixtures().lectures;
    await expectStatus(who, live(previewVideo, 'hls/master.m3u8'), 200);
    await expectStatus(who, live(lockedVideo, 'hls/master.m3u8'), LIVE_LOCKED[who]);
    const variant = await expectStatus(who, live(lockedVideo, 'hls/360p.m3u8'), LIVE_LOCKED[who]);
    if (LIVE_LOCKED[who] === 403) {
      expect(variant.body.code).toBe(ErrorCode.LectureLocked);
    }
    const body = await expectStatus(who, live(article, 'article'), LIVE_LOCKED[who]);
    if (LIVE_LOCKED[who] === 200) {
      expect(PublicArticleSchema.parse(body.body).bodyMd).toContain('comfortably longer');
    }
    const download = await expectStatus(who, live(resource, 'download'), LIVE_LOCKED[who]);
    if (LIVE_LOCKED[who] === 200) {
      const res = await fetch(SignedUrlSchema.parse(download.body).url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    }
  });

  it.for(VIEWERS)('working-copy matrix: %s', async (who, ctx) => {
    skip(ctx);
    const { lockedVideo, resource } = fixtures().lectures;
    await expectStatus(who, working(lockedVideo, 'preview/hls/master.m3u8'), WORKING[who]);
    await expectStatus(who, working(lockedVideo, 'preview/hls/360p.m3u8'), WORKING[who]);
    await expectStatus(who, working(resource, 'download'), WORKING[who]);
    const thumbnail = await expectStatus(
      who,
      `${V1}/courses/${fixtures().courseId}/thumbnail?variant=w750`,
      WORKING[who],
    );
    if (WORKING[who] === 200) {
      expect((await fetch(SignedUrlSchema.parse(thumbnail.body).url)).status).toBe(200);
    }
  });

  it.for(VIEWERS)('revision matrix: %s', async (who, ctx) => {
    skip(ctx);
    const { lockedVideo, article, resource } = fixtures().lectures;
    await expectStatus(who, revision(lockedVideo, 'hls/master.m3u8'), REVISION[who]);
    await expectStatus(who, revision(lockedVideo, 'hls/360p.m3u8'), REVISION[who]);
    await expectStatus(who, revision(article, 'article'), REVISION[who]);
    await expectStatus(who, revision(resource, 'download'), REVISION[who]);
    await expectStatus(
      who,
      `${V1}/admin/course-revisions/${fixtures().revisionId}/thumbnail`,
      REVISION[who],
    );
  });

  it('the owner can also play locked lectures through the student app (optional Bearer)', async (ctx) => {
    skip(ctx);
    const { tokens, lectures } = fixtures();
    // The owner's student-app token: the principal is the owner, so the live route allows it.
    const ownerAsStudent = await e2e.login('student', fixtures().users.owner.email);
    expect(ownerAsStudent.accessToken).not.toBe(tokens.owner.accessToken);
    usedIps.add(e2e.ip());
    await e2e
      .as('student', ownerAsStudent.accessToken)
      .get(live(lectures.lockedVideo, 'hls/master.m3u8'))
      .expect(200);
    // An invalid Bearer on a public route is ignored: anonymous, so locked.
    expectProblem(
      await anonymous(live(lectures.lockedVideo, 'hls/master.m3u8')).set(
        'authorization',
        'Bearer not-a-token',
      ),
      403,
      ErrorCode.LectureLocked,
    );
  });

  it('foreign ids: another course or revision never resolves the lecture', async (ctx) => {
    skip(ctx);
    const { lectures, revisionId } = fixtures();
    const unknownCourse = randomUUID();
    expectProblem(
      await anonymous(
        `${V1}/catalog/courses/${unknownCourse}/lectures/${lectures.previewVideo}/hls/master.m3u8`,
      ),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(
      await viewer('admin').get(
        `${V1}/admin/course-revisions/${revisionId}/lectures/${randomUUID()}/hls/master.m3u8`,
      ),
      404,
      ErrorCode.LectureNotFound,
    );
    expectProblem(
      await viewer('admin').get(
        `${V1}/admin/course-revisions/${randomUUID()}/lectures/${lectures.lockedVideo}/hls/master.m3u8`,
      ),
      404,
    );
  });

  it('per-IP playback rate limit: 429 with Retry-After once the window is used up', async (ctx) => {
    skip(ctx);
    const ip = await e2e.freshIp();
    usedIps.add(ip);
    await e2e.redis.redis.set(playbackRateLimitKey(ip), '240', 'PX', 60_000);
    const res = await e2e
      .http()
      .get(live(fixtures().lectures.previewVideo, 'hls/master.m3u8'))
      .set(e2e.client('student', { ip }));
    expectProblem(res, 429, ErrorCode.RateLimited);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lifecycle contract: reject takes expectedVersion and returns CourseDetail; landing unchanged', async (ctx) => {
    skip(ctx);
    const { courseId, slug, tokens } = fixtures();
    const owner = viewer('owner');
    await owner
      .patch(`${V1}/courses/${courseId}`)
      .send({ title: `Edited e2e ${tag}` })
      .expect(200);
    const { revisionId } = SubmitCourseResponseSchema.parse(
      (await owner.post(`${V1}/courses/${courseId}/submit`).send({}).expect(200)).body,
    );
    // the pending edit is not public, but the admin can play the pending revision
    const landing = CourseLandingSchema.parse(
      (await anonymous(`${V1}/catalog/courses/by-slug/${slug}`).expect(200)).body,
    );
    expect(landing.title).toBe(`Public e2e ${tag}`);
    await viewer('admin')
      .get(
        `${V1}/admin/course-revisions/${revisionId}/lectures/${fixtures().lectures.lockedVideo}/hls/master.m3u8`,
      )
      .expect(200);

    const decide = `${V1}/admin/courses/${courseId}/revisions/${revisionId}/reject`;
    const reason = 'The new title does not match the content.';
    const admin = e2e.as('admin', tokens.admin.accessToken);
    expectProblem(
      await admin.post(decide).send({ reason, expectedVersion: 1 }),
      409,
      ErrorCode.VersionConflict,
    );
    const current = CourseDetailSchema.parse(
      (await viewer('owner').get(`${V1}/courses/${courseId}`).expect(200)).body,
    );
    const rejected = CourseDetailSchema.parse(
      (await admin.post(decide).send({ reason, expectedVersion: current.version }).expect(200))
        .body,
    );
    expect(rejected).toMatchObject({ id: courseId, status: 'PUBLISHED' });
    expect(
      CourseLandingSchema.parse(
        (await anonymous(`${V1}/catalog/courses/by-slug/${slug}`).expect(200)).body,
      ).title,
    ).toBe(`Public e2e ${tag}`);
  });
});
