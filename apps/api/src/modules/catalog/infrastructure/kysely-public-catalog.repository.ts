import { Injectable } from '@nestjs/common';
import { COURSE_LANGUAGES, COURSE_LEVELS, LECTURE_TYPES } from '@udemy/contracts';
import { type BrowseOptions, browsePublishedCourses, type Executor, sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { CategoryRecord } from '../application/ports/category.repository';
import {
  type BrowseRecord,
  type LiveCourseRecord,
  type LiveCourseSummaryRecord,
  type LiveLectureLookup,
  PublicCatalogRepository,
  type LiveTotals,
  type RevisionHeaderRecord,
  type SnapshotLectureRecord,
} from '../application/ports/public-catalog.repository';
import { toRecord as toCategoryRecord } from './kysely-category.repository';
import { narrow } from './row-mapping';

/** Statuses that keep a live revision readable (D13). */
const LIVE_STATUSES = ['PUBLISHED', 'ARCHIVED'] as const;

interface LiveCourseRow {
  id: string;
  slug: string;
  ownerId: string;
  status: string;
  liveRevisionId: string | null;
  thumbnailAssetId: string;
  firstPublishedAt: Date | null;
  liveSince: Date | null;
}

interface SnapshotLectureRow {
  revisionId: string;
  lectureId: string;
  type: string;
  title: string;
  isPreview: boolean;
  mediaAssetId: string | null;
  articleBodyMd: string | null;
}

function toLiveCourse(row: LiveCourseRow): LiveCourseRecord {
  // PUBLISHED/ARCHIVED imply both pointers (courses_published_requires_revision_ck,
  // courses_first_published_at_ck); a NULL here is a schema bug.
  if (row.liveRevisionId === null || row.firstPublishedAt === null) {
    throw new Error(`course ${row.id} is ${row.status} without a live revision`);
  }
  return {
    id: row.id,
    slug: row.slug,
    ownerId: row.ownerId,
    status: narrow(LIVE_STATUSES, row.status, 'catalog.courses.status'),
    liveRevisionId: row.liveRevisionId,
    thumbnailAssetId: row.thumbnailAssetId,
    firstPublishedAt: row.firstPublishedAt,
    // The APPROVE of the live revision; restores keep it (no new revision is approved).
    liveSince: row.liveSince ?? row.firstPublishedAt,
  };
}

function toSnapshotLecture(row: SnapshotLectureRow): SnapshotLectureRecord {
  return {
    revisionId: row.revisionId,
    lectureId: row.lectureId,
    type: narrow(LECTURE_TYPES, row.type, 'catalog.revision_lectures.type'),
    title: row.title,
    isPreview: row.isPreview,
    mediaAssetId: row.mediaAssetId,
    articleBodyMd: row.articleBodyMd,
  };
}

/**
 * The public read model with Kysely (schema doc §8.5): courses joined to their live revision
 * (`published_revision_id`). Reads only; no locks.
 */
@Injectable()
export class KyselyPublicCatalogRepository extends PublicCatalogRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findPublishedBySlug(
    slug: string,
    ex: Executor = this.db,
  ): Promise<LiveCourseRecord | null> {
    const row = await this.liveCourses(ex)
      .where('c.slug', '=', slug)
      .where('c.status', '=', 'PUBLISHED')
      .executeTakeFirst();
    return row === undefined ? null : toLiveCourse(row);
  }

  async findLiveCourse(courseId: string, ex: Executor = this.db): Promise<LiveCourseRecord | null> {
    const row = await this.liveCourses(ex).where('c.id', '=', courseId).executeTakeFirst();
    return row === undefined ? null : toLiveCourse(row);
  }

  async findLiveCourseSummaries(
    courseIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<LiveCourseSummaryRecord[]> {
    if (courseIds.length === 0) return [];
    const rows = await this.liveCourses(ex)
      .select('r.title')
      .where('c.id', 'in', [...new Set(courseIds)])
      .execute();
    return rows.map((row) => ({ ...toLiveCourse(row), title: row.title }));
  }

  async findLiveLecture(
    courseId: string,
    lectureId: string,
    options: { readonly withArticle: boolean },
    ex: Executor = this.db,
  ): Promise<LiveLectureLookup | null> {
    const row = await this.liveCourses(ex)
      .leftJoin('catalog.revisionLectures as l', (join) =>
        join.onRef('l.revisionId', '=', 'c.publishedRevisionId').on('l.lectureId', '=', lectureId),
      )
      .select([
        'l.lectureId',
        'l.type',
        'l.title',
        'l.isPreview',
        'l.mediaAssetId',
        options.withArticle
          ? 'l.articleBodyMd'
          : sql<string | null>`NULL::text`.as('articleBodyMd'),
      ])
      .where('c.id', '=', courseId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const course = toLiveCourse(row);
    const lecture =
      row.lectureId === null || row.type === null || row.title === null || row.isPreview === null
        ? null
        : toSnapshotLecture({
            revisionId: course.liveRevisionId,
            lectureId: row.lectureId,
            type: row.type,
            title: row.title,
            isPreview: row.isPreview,
            mediaAssetId: row.mediaAssetId,
            articleBodyMd: row.articleBodyMd,
          });
    return { course, lecture };
  }

  async findRevisionHeader(
    revisionId: string,
    ex: Executor = this.db,
  ): Promise<RevisionHeaderRecord | null> {
    const row = await ex
      .selectFrom('catalog.courseRevisions as r')
      .innerJoin('catalog.courses as c', 'c.id', 'r.courseId')
      .select(['r.id as revisionId', 'r.courseId', 'c.ownerId', 'r.thumbnailAssetId'])
      .where('r.id', '=', revisionId)
      .executeTakeFirst();
    return row ?? null;
  }

  async findRevisionLecture(
    revisionId: string,
    lectureId: string,
    options: { readonly withArticle: boolean },
    ex: Executor = this.db,
  ): Promise<SnapshotLectureRecord | null> {
    const row = await ex
      .selectFrom('catalog.revisionLectures as l')
      .select([
        'l.revisionId',
        'l.lectureId',
        'l.type',
        'l.title',
        'l.isPreview',
        'l.mediaAssetId',
        options.withArticle
          ? 'l.articleBodyMd'
          : sql<string | null>`NULL::text`.as('articleBodyMd'),
      ])
      .where('l.revisionId', '=', revisionId)
      .where('l.lectureId', '=', lectureId)
      .executeTakeFirst();
    return row === undefined ? null : toSnapshotLecture(row);
  }

  async listLiveCourseIdsByOwner(
    ownerId: string,
    limit: number,
    ex: Executor = this.db,
  ): Promise<string[]> {
    const rows = await ex
      .selectFrom('catalog.courses as c')
      .select('c.id')
      .where('c.ownerId', '=', ownerId)
      .where('c.deletedAt', 'is', null)
      .where('c.status', 'in', [...LIVE_STATUSES])
      .where('c.publishedRevisionId', 'is not', null)
      .orderBy('c.firstPublishedAt', 'desc')
      .orderBy('c.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  async listLiveLectureIds(courseId: string, ex: Executor = this.db): Promise<string[]> {
    const rows = await ex
      .selectFrom('catalog.courses as c')
      .innerJoin('catalog.revisionLectures as l', 'l.revisionId', 'c.publishedRevisionId')
      .innerJoin('catalog.revisionSections as s', (join) =>
        join.onRef('s.revisionId', '=', 'l.revisionId').onRef('s.sectionId', '=', 'l.sectionId'),
      )
      .select('l.lectureId')
      .where('c.id', '=', courseId)
      .where('c.deletedAt', 'is', null)
      .where('c.status', 'in', [...LIVE_STATUSES])
      .orderBy('s.position')
      .orderBy('l.position')
      .execute();
    return rows.map((r) => r.lectureId);
  }

  async liveTotals(
    courseIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<ReadonlyMap<string, LiveTotals>> {
    if (courseIds.length === 0) return new Map();
    const { rows } = await sql<{ id: string; lectureCount: number; videoSeconds: number }>`
      SELECT c.id,
             count(l.lecture_id)::int AS lecture_count,
             coalesce(sum(l.duration_seconds) FILTER (WHERE l.type = 'VIDEO'), 0)::int AS video_seconds
        FROM catalog.courses c
        LEFT JOIN catalog.revision_lectures l ON l.revision_id = c.published_revision_id
       WHERE c.id = ANY(${[...new Set(courseIds)]}::uuid[])
       GROUP BY c.id
    `.execute(ex);
    return new Map(
      rows.map((r) => [r.id, { lectureCount: r.lectureCount, videoSeconds: r.videoSeconds }]),
    );
  }

  async browse(options: BrowseOptions, ex: Executor = this.db): Promise<BrowseRecord[]> {
    const rows = await browsePublishedCourses(ex, options);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      ownerId: row.ownerId,
      firstPublishedAt: row.firstPublishedAt,
      title: row.title,
      subtitle: row.subtitle,
      level: narrow(COURSE_LEVELS, row.level, 'catalog.course_revisions.level'),
      language: narrow(COURSE_LANGUAGES, row.language, 'catalog.course_revisions.language'),
      categoryId: row.categoryId,
      thumbnailAssetId: row.thumbnailAssetId,
      cursor: row.cursor,
    }));
  }

  async listCategories(ex: Executor = this.db): Promise<CategoryRecord[]> {
    const rows = await ex
      .selectFrom('catalog.categories as c')
      .leftJoin('catalog.categories as p', 'p.id', 'c.parentId')
      .select([
        'c.id',
        'c.parentId',
        'c.depth',
        'c.slug',
        'c.name',
        'c.position',
        'c.isActive',
        'p.isActive as parentActive',
      ])
      .orderBy('c.depth')
      .orderBy('c.position')
      .execute();
    return rows.map(toCategoryRecord);
  }

  /** Non-deleted courses with a live revision, joined to it. */
  private liveCourses(ex: Executor) {
    return ex
      .selectFrom('catalog.courses as c')
      .innerJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
      .select((eb) => [
        'c.id',
        'c.slug',
        'c.ownerId',
        'c.status',
        'c.publishedRevisionId as liveRevisionId',
        'r.thumbnailAssetId',
        'c.firstPublishedAt',
        eb
          .selectFrom('catalog.courseTransitions as t')
          .select('t.occurredAt')
          .whereRef('t.revisionId', '=', 'c.publishedRevisionId')
          .where('t.action', '=', 'APPROVE')
          .limit(1)
          .as('liveSince'),
      ])
      .where('c.deletedAt', 'is', null)
      .where('c.status', 'in', [...LIVE_STATUSES]);
  }
}
