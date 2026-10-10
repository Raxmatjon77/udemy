import { Injectable } from '@nestjs/common';
import { LECTURE_TYPES, type LectureType } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type ArticleRecord,
  CurriculumRepository,
  type LectureMediaRef,
  type LecturePatch,
  type LectureRecord,
  type SectionPatch,
  type SectionRecord,
} from '../application/ports/curriculum.repository';
import type { CurriculumPositions } from '../domain/curriculum';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { narrow } from './row-mapping';

const SECTION_COLUMNS = ['id', 'courseId', 'title', 'objective', 'position', 'updatedAt'] as const;
const LECTURE_COLUMNS = [
  'id',
  'courseId',
  'sectionId',
  'type',
  'title',
  'descriptionMd',
  'isPreview',
  'position',
  'mediaAssetId',
  'updatedAt',
] as const;

interface LectureRow {
  id: string;
  courseId: string;
  sectionId: string;
  type: string;
  title: string;
  descriptionMd: string | null;
  isPreview: boolean;
  position: number;
  mediaAssetId: string | null;
  updatedAt: Date;
}

function toLectureType(value: string): LectureType {
  return narrow(LECTURE_TYPES, value, 'catalog.lectures.type');
}

function toLectureRecord(row: LectureRow): LectureRecord {
  return { ...row, type: toLectureType(row.type) };
}

/**
 * Sections, lectures and articles with Kysely. Every lookup and write is scoped by
 * `course_id` (nested-route IDOR safety). Position rewrites are single statements over the
 * DEFERRED uniques; gaps are closed with `row_number()`.
 */
@Injectable()
export class KyselyCurriculumRepository extends CurriculumRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  listSections(courseId: string, ex: Executor = this.db): Promise<SectionRecord[]> {
    return ex
      .selectFrom('catalog.sections')
      .select(SECTION_COLUMNS)
      .where('courseId', '=', courseId)
      .orderBy('position')
      .execute();
  }

  async listLectures(courseId: string, ex: Executor = this.db): Promise<LectureRecord[]> {
    const rows = await ex
      .selectFrom('catalog.lectures as l')
      .innerJoin('catalog.sections as s', 's.id', 'l.sectionId')
      .select([
        'l.id',
        'l.courseId',
        'l.sectionId',
        'l.type',
        'l.title',
        'l.descriptionMd',
        'l.isPreview',
        'l.position',
        'l.mediaAssetId',
        'l.updatedAt',
      ])
      .where('l.courseId', '=', courseId)
      .orderBy('s.position')
      .orderBy('l.position')
      .execute();
    return rows.map(toLectureRecord);
  }

  async listArticleBodies(courseId: string, ex: Executor = this.db): Promise<Map<string, string>> {
    const rows = await ex
      .selectFrom('catalog.lectureArticles as a')
      .innerJoin('catalog.lectures as l', 'l.id', 'a.lectureId')
      .select(['a.lectureId', 'a.bodyMd'])
      .where('l.courseId', '=', courseId)
      .execute();
    return new Map(rows.map((r) => [r.lectureId, r.bodyMd]));
  }

  async findSection(
    courseId: string,
    sectionId: string,
    ex: Executor = this.db,
  ): Promise<SectionRecord | null> {
    const row = await ex
      .selectFrom('catalog.sections')
      .select(SECTION_COLUMNS)
      .where('id', '=', sectionId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row ?? null;
  }

  async findLecture(
    courseId: string,
    lectureId: string,
    ex: Executor = this.db,
  ): Promise<LectureRecord | null> {
    const row = await ex
      .selectFrom('catalog.lectures')
      .select(LECTURE_COLUMNS)
      .where('id', '=', lectureId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row === undefined ? null : toLectureRecord(row);
  }

  async countSections(trx: Transaction<DB>, courseId: string): Promise<number> {
    const row = await trx
      .selectFrom('catalog.sections')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('courseId', '=', courseId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async countLectures(
    trx: Transaction<DB>,
    courseId: string,
    sectionId: string,
  ): Promise<{ inSection: number; inCourse: number }> {
    const row = await trx
      .selectFrom('catalog.lectures')
      .select([
        sql<string>`count(*) FILTER (WHERE section_id = ${sectionId})`.as('inSection'),
        sql<string>`count(*)`.as('inCourse'),
      ])
      .where('courseId', '=', courseId)
      .executeTakeFirstOrThrow();
    return { inSection: Number(row.inSection), inCourse: Number(row.inCourse) };
  }

  async countPreviews(
    trx: Transaction<DB>,
    courseId: string,
    exceptLectureId: string,
  ): Promise<number> {
    const row = await trx
      .selectFrom('catalog.lectures')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('courseId', '=', courseId)
      .where('isPreview', '=', true)
      .where('id', '<>', exceptLectureId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async listLectureMedia(
    trx: Transaction<DB>,
    courseId: string,
    sectionId?: string,
  ): Promise<LectureMediaRef[]> {
    let query = trx
      .selectFrom('catalog.lectures')
      .select(['id as lectureId', 'mediaAssetId'])
      .where('courseId', '=', courseId)
      .where('mediaAssetId', 'is not', null);
    if (sectionId !== undefined) query = query.where('sectionId', '=', sectionId);
    const rows = await query.orderBy('mediaAssetId').execute();
    return rows.flatMap((r) =>
      r.mediaAssetId === null ? [] : [{ lectureId: r.lectureId, assetId: r.mediaAssetId }],
    );
  }

  insertSection(
    trx: Transaction<DB>,
    section: { courseId: string; title: string; objective: string | null; position: number },
  ): Promise<SectionRecord> {
    return mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.sections')
        .values(section)
        .returning(SECTION_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }

  updateSection(
    trx: Transaction<DB>,
    courseId: string,
    sectionId: string,
    patch: SectionPatch,
  ): Promise<SectionRecord> {
    return mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.sections')
        .set({ ...patch, updatedAt: sql<Date>`now()` })
        .where('id', '=', sectionId)
        .where('courseId', '=', courseId)
        .returning(SECTION_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }

  async deleteSection(trx: Transaction<DB>, courseId: string, sectionId: string): Promise<void> {
    await mapCatalogConstraints(async () => {
      await trx
        .deleteFrom('catalog.lectures')
        .where('sectionId', '=', sectionId)
        .where('courseId', '=', courseId)
        .execute();
      await trx
        .deleteFrom('catalog.sections')
        .where('id', '=', sectionId)
        .where('courseId', '=', courseId)
        .execute();
      await sql`
        UPDATE catalog.sections s SET position = r.rn - 1
          FROM (SELECT id, (row_number() OVER (ORDER BY position))::int AS rn
                  FROM catalog.sections WHERE course_id = ${courseId}) r
         WHERE s.id = r.id AND s.position <> r.rn - 1
      `.execute(trx);
    });
  }

  async insertLecture(
    trx: Transaction<DB>,
    lecture: {
      courseId: string;
      sectionId: string;
      type: LectureType;
      title: string;
      position: number;
    },
  ): Promise<LectureRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.lectures')
        .values(lecture)
        .returning(LECTURE_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toLectureRecord(row);
  }

  async updateLecture(
    trx: Transaction<DB>,
    courseId: string,
    lectureId: string,
    patch: LecturePatch,
  ): Promise<LectureRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.lectures')
        .set({ ...patch, updatedAt: sql<Date>`now()` })
        .where('id', '=', lectureId)
        .where('courseId', '=', courseId)
        .returning(LECTURE_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toLectureRecord(row);
  }

  async setLectureMedia(
    trx: Transaction<DB>,
    courseId: string,
    lectureId: string,
    assetId: string | null,
  ): Promise<LectureRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.lectures')
        .set({ mediaAssetId: assetId })
        .where('id', '=', lectureId)
        .where('courseId', '=', courseId)
        .returning(LECTURE_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toLectureRecord(row);
  }

  async clearAllLectureMedia(trx: Transaction<DB>, courseId: string): Promise<void> {
    await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.lectures')
        .set({ mediaAssetId: null })
        .where('courseId', '=', courseId)
        .where('mediaAssetId', 'is not', null)
        .execute(),
    );
  }

  async deleteLecture(trx: Transaction<DB>, courseId: string, lectureId: string): Promise<void> {
    await mapCatalogConstraints(async () => {
      const deleted = await trx
        .deleteFrom('catalog.lectures')
        .where('id', '=', lectureId)
        .where('courseId', '=', courseId)
        .returning('sectionId')
        .executeTakeFirst();
      if (deleted === undefined) return;
      await sql`
        UPDATE catalog.lectures l SET position = r.rn - 1
          FROM (SELECT id, (row_number() OVER (ORDER BY position))::int AS rn
                  FROM catalog.lectures WHERE section_id = ${deleted.sectionId}) r
         WHERE l.id = r.id AND l.position <> r.rn - 1
      `.execute(trx);
    });
  }

  async applyPositions(
    trx: Transaction<DB>,
    courseId: string,
    positions: CurriculumPositions,
  ): Promise<void> {
    await mapCatalogConstraints(async () => {
      if (positions.sections.length > 0) {
        await sql`
          UPDATE catalog.sections s SET position = v.position
            FROM unnest(${positions.sections.map((p) => p.id)}::uuid[],
                        ${positions.sections.map((p) => p.position)}::int[]) AS v(id, position)
           WHERE s.id = v.id AND s.course_id = ${courseId} AND s.position <> v.position
        `.execute(trx);
      }
      if (positions.lectures.length > 0) {
        await sql`
          UPDATE catalog.lectures l SET section_id = v.section_id, position = v.position
            FROM unnest(${positions.lectures.map((p) => p.id)}::uuid[],
                        ${positions.lectures.map((p) => p.sectionId)}::uuid[],
                        ${positions.lectures.map((p) => p.position)}::int[]) AS v(id, section_id, position)
           WHERE l.id = v.id AND l.course_id = ${courseId}
             AND (l.section_id, l.position) IS DISTINCT FROM (v.section_id, v.position)
        `.execute(trx);
      }
    });
  }

  async findArticle(lectureId: string, ex: Executor = this.db): Promise<ArticleRecord | null> {
    const row = await ex
      .selectFrom('catalog.lectureArticles')
      .select(['lectureId', 'bodyMd', 'updatedAt'])
      .where('lectureId', '=', lectureId)
      .executeTakeFirst();
    return row ?? null;
  }

  saveArticle(trx: Transaction<DB>, lectureId: string, bodyMd: string): Promise<ArticleRecord> {
    return mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.lectureArticles')
        .values({ lectureId, bodyMd })
        .onConflict((oc) => oc.column('lectureId').doUpdateSet({ bodyMd }))
        .returning(['lectureId', 'bodyMd', 'updatedAt'])
        .executeTakeFirstOrThrow(),
    );
  }
}
