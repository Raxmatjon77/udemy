import { Injectable } from '@nestjs/common';
import {
  type BulletKind,
  COURSE_LANGUAGES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  type CourseStatus,
} from '@udemy/contracts';
import { type DB, type Executor, escapeLikePattern, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type CourseBullets,
  type CourseHeaderPatch,
  type CourseRecord,
  CourseRepository,
  type MyCourseRecord,
  type MyCoursesKeyset,
  type NewCourse,
} from '../application/ports/course.repository';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { exactUtcText, narrow, narrowNullable } from './row-mapping';

const COURSE_COLUMNS = [
  'id',
  'ownerId',
  'slug',
  'title',
  'subtitle',
  'descriptionMd',
  'language',
  'level',
  'categoryId',
  'thumbnailAssetId',
  'status',
  'version',
  'pendingRevisionId',
  'publishedRevisionId',
  'firstPublishedAt',
  'createdAt',
  'updatedAt',
] as const;

interface CourseRow {
  id: string;
  ownerId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  descriptionMd: string | null;
  language: string | null;
  level: string | null;
  categoryId: string | null;
  thumbnailAssetId: string | null;
  status: string;
  version: number;
  pendingRevisionId: string | null;
  publishedRevisionId: string | null;
  firstPublishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toCourseStatus(value: string): CourseStatus {
  return narrow(COURSE_STATUSES, value, 'catalog.courses.status');
}

function toCourseRecord(row: CourseRow): CourseRecord {
  return {
    ...row,
    language: narrowNullable(COURSE_LANGUAGES, row.language, 'catalog.courses.language'),
    level: narrowNullable(COURSE_LEVELS, row.level, 'catalog.courses.level'),
    status: toCourseStatus(row.status),
  };
}

function toDecisionAction(value: string): 'APPROVE' | 'REJECT' {
  return narrow(['APPROVE', 'REJECT'] as const, value, 'catalog.course_transitions.action');
}

/**
 * `catalog.courses` + `catalog.course_bullets` with Kysely. Deleted courses are filtered
 * everywhere; writes map constraints (schema doc §9) and bump `version` via SQL.
 */
@Injectable()
export class KyselyCourseRepository extends CourseRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lockForUpdate(trx: Transaction<DB>, courseId: string): Promise<CourseRecord | null> {
    const row = await trx
      .selectFrom('catalog.courses')
      .select(COURSE_COLUMNS)
      .where('id', '=', courseId)
      .where('deletedAt', 'is', null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toCourseRecord(row);
  }

  async findById(courseId: string, ex: Executor = this.db): Promise<CourseRecord | null> {
    const row = await ex
      .selectFrom('catalog.courses')
      .select(COURSE_COLUMNS)
      .where('id', '=', courseId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : toCourseRecord(row);
  }

  async findOwnerId(courseId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('catalog.courses')
      .select('ownerId')
      .where('id', '=', courseId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row?.ownerId ?? null;
  }

  async findSlugsWithPrefix(ex: Executor, prefix: string): Promise<Set<string>> {
    const rows = await ex
      .selectFrom('catalog.courses')
      .select('slug')
      .where('deletedAt', 'is', null)
      .where('slug', 'like', `${escapeLikePattern(prefix)}%`)
      .execute();
    return new Set(rows.map((r) => r.slug));
  }

  async insert(trx: Transaction<DB>, course: NewCourse): Promise<CourseRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.courses')
        .values({
          ownerId: course.ownerId,
          slug: course.slug,
          title: course.title,
          categoryId: course.categoryId,
        })
        .returning(COURSE_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toCourseRecord(row);
  }

  async updateHeader(
    trx: Transaction<DB>,
    courseId: string,
    patch: CourseHeaderPatch,
  ): Promise<CourseRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.courses')
        .set({ ...patch, version: sql<number>`version + 1` })
        .where('id', '=', courseId)
        .where('deletedAt', 'is', null)
        .returning(COURSE_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toCourseRecord(row);
  }

  async bumpVersion(trx: Transaction<DB>, courseId: string): Promise<number> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.courses')
        .set({ version: sql<number>`version + 1` })
        .where('id', '=', courseId)
        .where('deletedAt', 'is', null)
        .returning('version')
        .executeTakeFirstOrThrow(),
    );
    return row.version;
  }

  async markDeleted(trx: Transaction<DB>, courseId: string): Promise<Date> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.courses')
        .set({ deletedAt: sql<Date>`now()`, version: sql<number>`version + 1` })
        .where('id', '=', courseId)
        .where('deletedAt', 'is', null)
        .returning('deletedAt')
        .executeTakeFirstOrThrow(),
    );
    if (row.deletedAt === null) throw new Error('deleted_at was not set');
    return row.deletedAt;
  }

  async getBullets(courseId: string, ex: Executor = this.db): Promise<CourseBullets> {
    const rows = await ex
      .selectFrom('catalog.courseBullets')
      .select(['kind', 'text'])
      .where('courseId', '=', courseId)
      .orderBy('kind')
      .orderBy('position')
      .execute();
    return {
      outcomes: rows.filter((r) => r.kind === 'OUTCOME').map((r) => r.text),
      requirements: rows.filter((r) => r.kind === 'REQUIREMENT').map((r) => r.text),
    };
  }

  async replaceBullets(
    trx: Transaction<DB>,
    courseId: string,
    kind: BulletKind,
    texts: readonly string[],
  ): Promise<void> {
    await mapCatalogConstraints(async () => {
      await trx
        .deleteFrom('catalog.courseBullets')
        .where('courseId', '=', courseId)
        .where('kind', '=', kind)
        .execute();
      if (texts.length === 0) return;
      await trx
        .insertInto('catalog.courseBullets')
        .values(texts.map((text, position) => ({ courseId, kind, position, text })))
        .execute();
    });
  }

  async listByOwner(query: {
    readonly ownerId: string;
    readonly status: CourseStatus | undefined;
    readonly after: MyCoursesKeyset | null;
    readonly limit: number;
  }): Promise<MyCourseRecord[]> {
    let builder = this.db
      .selectFrom('catalog.courses as c')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('catalog.courseTransitions as t')
            .innerJoin('catalog.courseRevisions as r', 'r.id', 't.revisionId')
            .select(['t.action', 't.revisionId'])
            .whereRef('t.courseId', '=', 'c.id')
            .where('t.action', 'in', ['APPROVE', 'REJECT'])
            .orderBy('r.revisionNo', 'desc')
            .limit(1)
            .as('d'),
        (join) => join.onTrue(),
      )
      .select([
        'c.id',
        'c.slug',
        'c.title',
        'c.status',
        'c.pendingRevisionId',
        'c.publishedRevisionId',
        'c.thumbnailAssetId',
        'c.firstPublishedAt',
        'c.updatedAt',
        exactUtcText('c.updated_at').as('updatedAtText'),
        'd.action as decisionAction',
        'd.revisionId as decisionRevisionId',
      ])
      .where('c.ownerId', '=', query.ownerId)
      .where('c.deletedAt', 'is', null);
    if (query.status !== undefined) builder = builder.where('c.status', '=', query.status);
    const after = query.after;
    if (after !== null) {
      builder = builder.where(
        sql<boolean>`(c.updated_at, c.id) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await builder
      .orderBy('c.updatedAt', 'desc')
      .orderBy('c.id', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: toCourseStatus(row.status),
      pendingRevisionId: row.pendingRevisionId,
      publishedRevisionId: row.publishedRevisionId,
      thumbnailAssetId: row.thumbnailAssetId,
      firstPublishedAt: row.firstPublishedAt,
      updatedAt: row.updatedAt,
      updatedAtText: row.updatedAtText,
      latestDecision:
        row.decisionAction === null || row.decisionRevisionId === null
          ? null
          : { action: toDecisionAction(row.decisionAction), revisionId: row.decisionRevisionId },
    }));
  }
}
