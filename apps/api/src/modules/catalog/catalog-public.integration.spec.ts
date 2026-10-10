// Must stay the first import: AppModule validates process.env when it is imported.
import { CATALOG_PUBLIC_IT_ENV } from './testing/apply-catalog-public-it-env';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { HLS_PLAYLIST_CONTENT_TYPE } from '@udemy/contracts';
import { sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { MediaNotReady, RenditionNotFound } from '../media';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { CatalogFacade } from './application/catalog.facade';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { ApproveRevisionCommand } from './application/use-cases/approve-revision.command';
import { ArchiveCourseCommand } from './application/use-cases/archive-course.command';
import { AttachLectureMediaCommand } from './application/use-cases/attach-lecture-media.command';
import { BrowseCoursesQuery } from './application/use-cases/browse-courses.query';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { GetCourseLandingQuery } from './application/use-cases/get-course-landing.query';
import { GetCourseQuery } from './application/use-cases/get-course.query';
import { GetCourseThumbnailQuery } from './application/use-cases/get-course-thumbnail.query';
import { GetLectureArticleQuery } from './application/use-cases/get-lecture-article.query';
import { GetLectureDownloadQuery } from './application/use-cases/get-lecture-download.query';
import { GetLecturePlaylistQuery } from './application/use-cases/get-lecture-playlist.query';
import { RestoreCourseCommand } from './application/use-cases/restore-course.command';
import { SaveArticleCommand } from './application/use-cases/save-article.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { SubmitCourseCommand } from './application/use-cases/submit-course.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { UpdateLectureCommand } from './application/use-cases/update-lecture.command';
import {
  CourseNotFound,
  LectureLocked,
  LectureNotFound,
  RevisionNotFound,
} from './domain/catalog.errors';
import type { PlaybackViewer } from './domain/playback-access';
import { deleteCatalogTestData, insertCatalogTestUser } from './testing/catalog-it';
import {
  FAKE_JPEG,
  FAKE_PDF,
  FAKE_SEGMENT,
  insertInFlightAsset,
  insertReadyResource,
  insertReadyThumbnail,
  insertReadyVideo,
} from './testing/catalog-public-it';

/*
 * P2-T11 against the integration Postgres + Redis + MinIO through the real AppModule:
 * courses are published through the real use cases (submit -> approve), their READY media
 * has real objects in the media bucket, and every presigned URL handed out is fetched for
 * real. Readiness thresholds: 1 lecture / 0 s (apply-catalog-public-it-env).
 */
describe('public catalog and playback (integration: AppModule, Postgres, Redis, MinIO)', () => {
  const pg = useIntegrationDatabase({ max: 6 });
  const itRedis = useIntegrationRedis();
  const s3 = useIntegrationS3();
  const owners: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let app: NestExpressApplication | undefined;
  let groupSlug = '';
  const leaves: { id: string; slug: string }[] = [];
  let adminId = '';

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean =>
    pg.available && itRedis.available && s3.unavailableReason === undefined;

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    await app.init();
    const group = await get(CreateCategoryCommand).execute({ name: `Public IT ${tag}` });
    groupSlug = group.slug;
    categoryIds.push(group.id);
    for (const name of ['one', 'two']) {
      const leaf = await get(CreateCategoryCommand).execute({
        name: `Public leaf ${name} ${tag}`,
        parentId: group.id,
      });
      categoryIds.push(leaf.id);
      leaves.push({ id: leaf.id, slug: leaf.slug });
    }
    adminId = await insertCatalogTestUser(pg.db, 'admin');
    owners.push(adminId);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) {
        await deleteMediaTestData(pg.db, owners, { storage: s3.storage });
        await deleteCatalogTestData(pg.db, { ownerIds: owners, categoryIds });
      }
    } finally {
      await rm(CATALOG_PUBLIC_IT_ENV.keysDir, { recursive: true, force: true });
      process.env = CATALOG_PUBLIC_IT_ENV.savedEnv;
    }
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
    s3.skipIfUnavailable(ctx);
  };

  interface Published {
    ownerId: string;
    courseId: string;
    slug: string;
    revisionId: string;
    previewVideoId: string;
    lockedVideoId: string;
    previewArticleId: string;
    resourceId: string;
    owner: PlaybackViewer;
  }

  /** A course built and published through the real use cases (submit, then admin approve). */
  async function publishedCourse(
    label: string,
    options: { leaf?: number; level?: 'BEGINNER' | 'EXPERT'; language?: 'en' | 'de' } = {},
  ): Promise<Published> {
    const ownerId = await insertCatalogTestUser(pg.db, label);
    owners.push(ownerId);
    const course = await get(CreateCourseCommand).execute({
      ownerId,
      title: `Public ${label} ${tag}`,
    });
    const as = { actorId: ownerId, courseId: course.id };
    await get(UpdateCourseCommand).execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: options.language ?? 'en',
        level: options.level ?? 'BEGINNER',
        categoryId: leaves[options.leaf ?? 0]?.id,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    await get(SetCourseThumbnailCommand).execute({
      ...as,
      assetId: await insertReadyThumbnail(pg.db, s3.storage, ownerId),
    });
    const section = await get(AddSectionCommand).execute({ ...as, title: 'Section one' });
    const add = async (type: 'VIDEO' | 'ARTICLE' | 'RESOURCE', title: string) =>
      (await get(AddLectureCommand).execute({ ...as, sectionId: section.id, type, title })).id;

    const previewVideoId = await add('VIDEO', 'Preview video');
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: previewVideoId,
      assetId: await insertReadyVideo(pg.db, s3.storage, ownerId, 125_000),
    });
    await get(UpdateLectureCommand).execute({
      ...as,
      lectureId: previewVideoId,
      patch: { isPreview: true },
    });
    const lockedVideoId = await add('VIDEO', 'Locked video');
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: lockedVideoId,
      assetId: await insertReadyVideo(pg.db, s3.storage, ownerId, 61_000),
    });
    const previewArticleId = await add('ARTICLE', 'Preview article');
    await get(SaveArticleCommand).execute({
      ...as,
      lectureId: previewArticleId,
      bodyMd: '# Welcome\n\nA preview article that is comfortably longer than fifty characters.',
    });
    await get(UpdateLectureCommand).execute({
      ...as,
      lectureId: previewArticleId,
      patch: { isPreview: true },
    });
    const resourceId = await add('RESOURCE', 'Slides');
    await get(AttachLectureMediaCommand).execute({
      ...as,
      lectureId: resourceId,
      assetId: await insertReadyResource(pg.db, s3.storage, ownerId),
    });

    const { revisionId } = await get(SubmitCourseCommand).execute(as);
    const detail = await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: course.id,
      revisionId,
    });
    expect(detail.status).toBe('PUBLISHED');
    return {
      ownerId,
      courseId: course.id,
      slug: detail.slug,
      revisionId,
      previewVideoId,
      lockedVideoId,
      previewArticleId,
      resourceId,
      owner: { userId: ownerId, isModerator: false },
    };
  }

  const admin = (): PlaybackViewer => ({ userId: adminId, isModerator: true });
  const student: PlaybackViewer = { userId: randomUUID(), isModerator: false };

  function segmentUrls(variant: string): string[] {
    return variant.split('\n').filter((line) => line.startsWith('http'));
  }

  it('anonymous: master + variant of a preview lecture; the presigned segment is fetchable', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('preview');
    const playlists = get(GetLecturePlaylistQuery);
    const input = {
      source: { kind: 'live' as const, courseId: c.courseId },
      lectureId: c.previewVideoId,
      viewer: null,
    };

    const master = await playlists.master(input);
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360');
    expect(master).toContain('\n360p.m3u8\n');

    const variant = await playlists.variant(input, '360p');
    const urls = segmentUrls(variant);
    expect(urls).toHaveLength(2);
    const res = await fetch(urls[0] ?? '');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(FAKE_SEGMENT)).toBe(true);
    expect(HLS_PLAYLIST_CONTENT_TYPE).toBe('application/vnd.apple.mpegurl');

    // an unknown rendition of an authorized lecture is a 404 from media
    await expect(playlists.variant(input, '1080p')).rejects.toBeInstanceOf(RenditionNotFound);
  });

  it('non-preview lecture: locked for anonymous/student, playable by the owner and admins', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('locked');
    const playlists = get(GetLecturePlaylistQuery);
    const as = (viewer: PlaybackViewer | null) => ({
      source: { kind: 'live' as const, courseId: c.courseId },
      lectureId: c.lockedVideoId,
      viewer,
    });
    await expect(playlists.master(as(null))).rejects.toBeInstanceOf(LectureLocked);
    await expect(playlists.variant(as(student), '360p')).rejects.toBeInstanceOf(LectureLocked);
    expect(await playlists.master(as(c.owner))).toContain('360p.m3u8');
    const variant = await playlists.variant(as(admin()), '360p');
    expect((await fetch(segmentUrls(variant)[1] ?? '')).status).toBe(200);

    // another course's lecture id never resolves through this course
    const other = await publishedCourse('locked-other');
    await expect(
      playlists.master({ ...as(c.owner), lectureId: other.previewVideoId }),
    ).rejects.toBeInstanceOf(LectureNotFound);
  });

  it('articles and downloads follow the matrix; the download is an attachment', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('article');
    const live = { kind: 'live' as const, courseId: c.courseId };
    await expect(
      get(GetLectureArticleQuery).execute({
        source: live,
        lectureId: c.previewArticleId,
        viewer: null,
      }),
    ).resolves.toEqual({
      bodyMd: '# Welcome\n\nA preview article that is comfortably longer than fifty characters.',
    });

    const downloads = get(GetLectureDownloadQuery);
    await expect(
      downloads.execute({ source: live, lectureId: c.resourceId, viewer: null }),
    ).rejects.toBeInstanceOf(LectureLocked);
    const signed = await downloads.execute({
      source: live,
      lectureId: c.resourceId,
      viewer: c.owner,
    });
    const res = await fetch(signed.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(Buffer.from(await res.arrayBuffer()).equals(FAKE_PDF)).toBe(true);
  });

  it('working-copy preview: owner and admin only; it serves unapproved lectures', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('working');
    const sections = await pg.db
      .selectFrom('catalog.sections')
      .select('id')
      .where('courseId', '=', c.courseId)
      .execute();
    const draft = await get(AddLectureCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      sectionId: sections[0]?.id ?? '',
      type: 'VIDEO',
      title: 'Not reviewed yet',
    });
    const playlists = get(GetLecturePlaylistQuery);
    const working = (viewer: PlaybackViewer | null) => ({
      source: { kind: 'working' as const, courseId: c.courseId },
      lectureId: draft.id,
      viewer,
    });

    // nothing attached yet, then an in-flight upload: 409 media_not_ready (gap 1: attachable)
    await expect(playlists.master(working(c.owner))).rejects.toBeInstanceOf(MediaNotReady);
    const uploading = await insertInFlightAsset(pg.db, {
      ownerId: c.ownerId,
      purpose: 'LECTURE_VIDEO',
      stage: 'UPLOADING',
    });
    await get(AttachLectureMediaCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: draft.id,
      assetId: uploading,
    });
    await expect(playlists.master(working(c.owner))).rejects.toBeInstanceOf(MediaNotReady);

    const ready = await insertReadyVideo(pg.db, s3.storage, c.ownerId);
    await get(AttachLectureMediaCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: draft.id,
      assetId: ready,
    });
    expect(await playlists.master(working(c.owner))).toContain('360p.m3u8');
    expect(segmentUrls(await playlists.variant(working(admin()), '360p'))).toHaveLength(2);
    await expect(playlists.master(working(null))).rejects.toBeInstanceOf(CourseNotFound);
    await expect(playlists.master(working(student))).rejects.toBeInstanceOf(CourseNotFound);

    // the live route does not know the unapproved lecture
    await expect(
      playlists.master({ ...working(c.owner), source: { kind: 'live', courseId: c.courseId } }),
    ).rejects.toBeInstanceOf(LectureNotFound);
  });

  it('admin revision playlist, article and thumbnail; revisions are admin-only', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('revision');
    const revision = { kind: 'revision' as const, revisionId: c.revisionId };
    const playlists = get(GetLecturePlaylistQuery);
    const master = await playlists.master({
      source: revision,
      lectureId: c.lockedVideoId,
      viewer: admin(),
    });
    expect(master).toContain('360p.m3u8');
    const variant = await playlists.variant(
      { source: revision, lectureId: c.lockedVideoId, viewer: admin() },
      '360p',
    );
    expect((await fetch(segmentUrls(variant)[0] ?? '')).status).toBe(200);
    await expect(
      playlists.master({ source: revision, lectureId: c.lockedVideoId, viewer: c.owner }),
    ).rejects.toBeInstanceOf(RevisionNotFound);
    await expect(
      get(GetLectureArticleQuery).execute({
        source: revision,
        lectureId: c.previewArticleId,
        viewer: admin(),
      }),
    ).resolves.toMatchObject({ bodyMd: expect.stringContaining('# Welcome') });

    const thumbnail = await get(GetCourseThumbnailQuery).execute({
      source: revision,
      variant: 'w480',
    });
    expect((await fetch(thumbnail.url)).status).toBe(200);
  });

  it('landing: live revision only; an unapproved edit does not change it', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('landing');
    const landing = get(GetCourseLandingQuery);
    const before = await landing.execute(c.slug);
    expect(before).toMatchObject({
      id: c.courseId,
      revisionId: c.revisionId,
      title: `Public landing ${tag}`,
      outcomes: ['One', 'Two', 'Three', 'Four'],
      categoryPath: [{ slug: groupSlug }, { slug: leaves[0]?.slug }],
      instructor: { id: c.ownerId, displayName: 'Catalog IT landing' },
      totals: { sectionCount: 1, lectureCount: 4, videoSeconds: 125 + 61 },
      hasThumbnail: true,
    });
    expect(
      before.sections[0]?.lectures.map((l) => [l.type, l.isPreview, l.durationSeconds]),
    ).toEqual([
      ['VIDEO', true, 125],
      ['VIDEO', false, 61],
      ['ARTICLE', true, null],
      ['RESOURCE', false, null],
    ]);

    // edit the working copy and submit it (pending, not approved)
    await get(UpdateCourseCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      changes: { title: `Edited landing ${tag}` },
    });
    await get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId });
    const after = await landing.execute(c.slug);
    expect(after.title).toBe(`Public landing ${tag}`);
    expect(after.revisionId).toBe(c.revisionId);
    expect(after.lastUpdatedAt).toBe(before.lastUpdatedAt);
    expect((await get(GetCourseQuery).execute(c.courseId)).title).toBe(`Edited landing ${tag}`);

    // an unknown slug is 404
    await expect(landing.execute(`no-such-course-${tag}`)).rejects.toBeInstanceOf(CourseNotFound);
  });

  it('archived: landing, thumbnail and public playback are 404; the owner still plays it', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('archived');
    await get(ArchiveCourseCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      byAdmin: false,
    });
    await expect(get(GetCourseLandingQuery).execute(c.slug)).rejects.toBeInstanceOf(CourseNotFound);
    await expect(
      get(GetCourseThumbnailQuery).execute({
        source: { kind: 'live', courseId: c.courseId },
        variant: 'w750',
      }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    const playlists = get(GetLecturePlaylistQuery);
    const live = (viewer: PlaybackViewer | null) => ({
      source: { kind: 'live' as const, courseId: c.courseId },
      lectureId: c.previewVideoId,
      viewer,
    });
    await expect(playlists.master(live(null))).rejects.toBeInstanceOf(CourseNotFound);
    expect(await playlists.master(live(c.owner))).toContain('360p.m3u8');

    const facade = get(CatalogFacade);
    expect(await facade.getPublishedCourse(c.courseId)).toMatchObject({ status: 'ARCHIVED' });
    const browse = await get(BrowseCoursesQuery).execute({ limit: 48, category: groupSlug });
    expect(browse.items.map((i) => i.id)).not.toContain(c.courseId);

    await get(RestoreCourseCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      byAdmin: false,
    });
    expect((await get(GetCourseLandingQuery).execute(c.slug)).id).toBe(c.courseId);
  });

  it('a banned owner: no instructor on the landing page or the card', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('banned');
    await pg.db
      .insertInto('identity.userBans')
      .values({ userId: c.ownerId, reason: 'catalog public IT: banned owner', bannedBy: adminId })
      .execute();
    expect((await get(GetCourseLandingQuery).execute(c.slug)).instructor).toBeNull();
    const page = await get(BrowseCoursesQuery).execute({
      limit: 48,
      category: groupSlug,
      q: 'Public banned',
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: c.courseId, instructor: null });
  });

  it('browse: category subtree, level, language, title search and exact keyset paging', async (ctx) => {
    skip(ctx);
    const a = await publishedCourse('browse-a', { leaf: 0, level: 'BEGINNER', language: 'en' });
    const b = await publishedCourse('browse-b', { leaf: 1, level: 'EXPERT', language: 'de' });
    const c = await publishedCourse('browse-c', { leaf: 1, level: 'BEGINNER', language: 'en' });
    // Same first_published_at down to the millisecond, different microseconds: the cursor must
    // keep the exact text or one of them is skipped (design §14).
    await pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`UPDATE catalog.courses SET first_published_at = '2030-01-01T00:00:00.000500Z' WHERE id = ${b.courseId}`.execute(
        trx,
      );
      await sql`UPDATE catalog.courses SET first_published_at = '2030-01-01T00:00:00.000100Z' WHERE id = ${c.courseId}`.execute(
        trx,
      );
    });
    const browse = get(BrowseCoursesQuery);
    const ids = async (query: Parameters<BrowseCoursesQuery['execute']>[0]) =>
      (await browse.execute(query)).items.map((i) => i.id);
    const mine = new Set([a.courseId, b.courseId, c.courseId]);
    const only = (list: string[]) => list.filter((id) => mine.has(id));

    expect(only(await ids({ limit: 48, category: groupSlug }))).toEqual([
      b.courseId,
      c.courseId,
      a.courseId,
    ]);
    expect(await ids({ limit: 48, category: leaves[1]?.slug })).toEqual([b.courseId, c.courseId]);
    expect(only(await ids({ limit: 48, category: groupSlug, level: 'EXPERT' }))).toEqual([
      b.courseId,
    ]);
    expect(only(await ids({ limit: 48, category: groupSlug, language: 'en' }))).toEqual([
      c.courseId,
      a.courseId,
    ]);
    expect(await ids({ limit: 48, category: groupSlug, q: 'browse-c' })).toEqual([c.courseId]);
    expect(await ids({ limit: 48, category: `no-such-${tag}` })).toEqual([]);

    // keyset: one per page through the subtree
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await browse.execute({ limit: 1, category: leaves[1]?.slug, cursor });
      seen.push(...page.items.map((x) => x.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([b.courseId, c.courseId]);

    const card = (await browse.execute({ limit: 48, category: leaves[0]?.slug })).items.find(
      (x) => x.id === a.courseId,
    );
    expect(card).toMatchObject({
      slug: a.slug,
      title: `Public browse-a ${tag}`,
      level: 'BEGINNER',
      language: 'en',
      category: { id: leaves[0]?.id, slug: leaves[0]?.slug },
      instructor: { id: a.ownerId, displayName: 'Catalog IT browse-a' },
      lectureCount: 4,
      videoSeconds: 186,
      hasThumbnail: true,
    });
  });

  it('the live thumbnail and the working-copy thumbnail are fetchable signed URLs', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('thumb');
    const thumbnails = get(GetCourseThumbnailQuery);
    for (const variant of ['w750', 'w480'] as const) {
      const signed = await thumbnails.execute({
        source: { kind: 'live', courseId: c.courseId },
        variant,
      });
      const res = await fetch(signed.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await res.arrayBuffer()).equals(FAKE_JPEG)).toBe(true);
    }

    // gap 1: the builder attaches a thumbnail that is still uploading; the working-copy URL is
    // then 409 media_not_ready while the live one keeps serving the approved image
    const processing = await insertInFlightAsset(pg.db, {
      ownerId: c.ownerId,
      purpose: 'COURSE_THUMBNAIL',
      stage: 'PROCESSING',
    });
    const detail = await get(SetCourseThumbnailCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      assetId: processing,
    });
    expect(detail.thumbnail).toMatchObject({ id: processing, status: 'PROCESSING' });
    expect(detail.readiness.issues.map((i) => i.code)).toContain('THUMBNAIL_NOT_READY');
    await expect(
      thumbnails.execute({ source: { kind: 'working', courseId: c.courseId }, variant: 'w750' }),
    ).rejects.toBeInstanceOf(MediaNotReady);
    const live = await thumbnails.execute({
      source: { kind: 'live', courseId: c.courseId },
      variant: 'w750',
    });
    expect((await fetch(live.url)).status).toBe(200);
  });

  it('CatalogFacade: published course, live lecture membership and ids', async (ctx) => {
    skip(ctx);
    const c = await publishedCourse('facade');
    const facade = get(CatalogFacade);
    expect(await facade.getPublishedCourse(c.courseId)).toMatchObject({
      id: c.courseId,
      slug: c.slug,
      ownerId: c.ownerId,
      status: 'PUBLISHED',
      liveRevisionId: c.revisionId,
    });
    expect(await facade.getPublishedCourse(randomUUID())).toBeNull();
    expect(await facade.lectureBelongsToLiveRevision(c.courseId, c.lockedVideoId)).toBe(true);
    expect(await facade.lectureBelongsToLiveRevision(c.courseId, randomUUID())).toBe(false);
    expect(await facade.getLiveLectureIds(c.courseId)).toEqual([
      c.previewVideoId,
      c.lockedVideoId,
      c.previewArticleId,
      c.resourceId,
    ]);
  });

  it('CatalogFacade.getCourseSummaries: live title, status and thumbnail; omits the rest', async (ctx) => {
    skip(ctx);
    const a = await publishedCourse('summary-a');
    const b = await publishedCourse('summary-b');
    await get(ArchiveCourseCommand).execute({
      actorId: b.ownerId,
      courseId: b.courseId,
      byAdmin: false,
    });
    // An edit of the working copy is not live until a new revision is approved.
    await get(UpdateCourseCommand).execute({
      actorId: a.ownerId,
      courseId: a.courseId,
      changes: { title: `Renamed summary-a ${tag}` },
    });
    const draft = await get(CreateCourseCommand).execute({
      ownerId: a.ownerId,
      title: `Draft summary ${tag}`,
    });
    const facade = get(CatalogFacade);

    const summaries = await facade.getCourseSummaries([
      b.courseId,
      draft.id,
      randomUUID(),
      'not-a-uuid',
      a.courseId,
      b.courseId,
    ]);

    // Order of first occurrence; draft, unknown and malformed ids are omitted.
    expect(summaries).toEqual([
      {
        id: b.courseId,
        slug: b.slug,
        ownerId: b.ownerId,
        status: 'ARCHIVED',
        liveRevisionId: b.revisionId,
        title: `Public summary-b ${tag}`,
        hasThumbnail: true,
      },
      {
        id: a.courseId,
        slug: a.slug,
        ownerId: a.ownerId,
        status: 'PUBLISHED',
        liveRevisionId: a.revisionId,
        title: `Public summary-a ${tag}`,
        hasThumbnail: true,
      },
    ]);

    // Inside the caller's transaction (commerce snapshots order lines this way).
    await pg.db.transaction().execute(async (trx) => {
      const inTrx = await facade.getCourseSummaries([a.courseId], trx);
      expect(inTrx.map((s) => s.title)).toEqual([`Public summary-a ${tag}`]);
    });

    // A live thumbnail that can no longer be served (its w750 rendition is gone).
    const { thumbnailAssetId } = await pg.db
      .selectFrom('catalog.courseRevisions')
      .select('thumbnailAssetId')
      .where('id', '=', a.revisionId)
      .executeTakeFirstOrThrow();
    await pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await trx
        .deleteFrom('media.assetRenditions')
        .where('assetId', '=', thumbnailAssetId)
        .where('name', '=', 'w750')
        .execute();
    });
    expect(await facade.getCourseSummaries([a.courseId])).toEqual([
      expect.objectContaining({ id: a.courseId, hasThumbnail: false }),
    ]);

    expect(await facade.getCourseSummaries([])).toEqual([]);
    expect(await facade.getCourseSummaries(['nope'])).toEqual([]);
    await expect(
      facade.getCourseSummaries(Array.from({ length: 101 }, () => randomUUID())),
    ).rejects.toBeInstanceOf(RangeError);
    // Duplicates count once against the limit.
    await expect(
      facade.getCourseSummaries([...Array.from({ length: 100 }, () => randomUUID()), a.courseId]),
    ).rejects.toBeInstanceOf(RangeError);
    const hundred = [a.courseId, ...Array.from({ length: 99 }, () => randomUUID()), a.courseId];
    expect((await facade.getCourseSummaries(hundred)).map((s) => s.id)).toEqual([a.courseId]);
  });
});
