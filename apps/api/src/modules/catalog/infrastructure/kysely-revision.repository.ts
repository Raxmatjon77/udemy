import { Injectable } from '@nestjs/common';
import { COURSE_LANGUAGES, COURSE_LEVELS, LECTURE_TYPES, REVISION_KINDS } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type InsertedRevision,
  type NewRevision,
  type RevisionLectureRecord,
  type RevisionRecord,
  RevisionRepository,
} from '../application/ports/revision.repository';
import type { SnapshotSection } from '../domain/revision-snapshot';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { narrow } from './row-mapping';

const DECISIONS = ['APPROVE', 'REJECT', 'WITHDRAW'] as const;

/** The append-only revision snapshot tables with Kysely (schema doc §1.8). */
@Injectable()
export class KyselyRevisionRepository extends RevisionRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async nextRevisionNo(trx: Transaction<DB>, courseId: string): Promise<number> {
    const row = await trx
      .selectFrom('catalog.courseRevisions')
      .select(sql<number>`coalesce(max(revision_no), 0)::int + 1`.as('next'))
      .where('courseId', '=', courseId)
      .executeTakeFirstOrThrow();
    return row.next;
  }

  async insert(trx: Transaction<DB>, revision: NewRevision): Promise<InsertedRevision> {
    return mapCatalogConstraints(async () => {
      const inserted = await trx
        .insertInto('catalog.courseRevisions')
        .values({
          courseId: revision.courseId,
          revisionNo: revision.revisionNo,
          kind: revision.kind,
          contentHash: revision.contentHash,
          title: revision.title,
          subtitle: revision.subtitle,
          descriptionMd: revision.descriptionMd,
          language: revision.language,
          level: revision.level,
          categoryId: revision.categoryId,
          thumbnailAssetId: revision.thumbnailAssetId,
          submitterNote: revision.submitterNote,
        })
        .returning(['id', 'revisionNo', 'submittedAt'])
        .executeTakeFirstOrThrow();
      const revisionId = inserted.id;

      const bullets = [
        ...revision.outcomes.map((text, position) => ({ kind: 'OUTCOME', position, text })),
        ...revision.requirements.map((text, position) => ({ kind: 'REQUIREMENT', position, text })),
      ];
      if (bullets.length > 0) {
        await trx
          .insertInto('catalog.revisionBullets')
          .values(bullets.map((b) => ({ revisionId, ...b })))
          .execute();
      }
      if (revision.sections.length > 0) {
        await trx
          .insertInto('catalog.revisionSections')
          .values(
            revision.sections.map((s, position) => ({
              revisionId,
              sectionId: s.id,
              position,
              title: s.title,
              objective: s.objective,
            })),
          )
          .execute();
      }
      const lectures = revision.sections.flatMap((s) =>
        s.lectures.map((l, position) => ({
          revisionId,
          lectureId: l.id,
          sectionId: s.id,
          position,
          type: l.type,
          title: l.title,
          descriptionMd: l.descriptionMd,
          isPreview: l.isPreview,
          mediaAssetId: l.mediaAssetId,
          durationSeconds: l.durationSeconds,
          articleBodyMd: l.articleBodyMd,
        })),
      );
      if (lectures.length > 0) {
        await trx.insertInto('catalog.revisionLectures').values(lectures).execute();
      }
      return inserted;
    });
  }

  async findContentHashHex(revisionId: string, ex: Executor = this.db): Promise<string | null> {
    const row = await ex
      .selectFrom('catalog.courseRevisions')
      .select('contentHash')
      .where('id', '=', revisionId)
      .executeTakeFirst();
    return row === undefined ? null : row.contentHash.toString('hex');
  }

  async findById(
    revisionId: string,
    ex: Executor = this.db,
    options: { readonly articleBodies?: boolean } = {},
  ): Promise<RevisionRecord | null> {
    const header = await ex
      .selectFrom('catalog.courseRevisions as r')
      .innerJoin('catalog.courseTransitions as t', (join) =>
        join.onRef('t.revisionId', '=', 'r.id').on('t.action', '=', 'SUBMIT'),
      )
      .select([
        'r.id',
        'r.courseId',
        'r.revisionNo',
        'r.kind',
        'r.contentHash',
        'r.title',
        'r.subtitle',
        'r.descriptionMd',
        'r.language',
        'r.level',
        'r.categoryId',
        'r.thumbnailAssetId',
        'r.submitterNote',
        'r.submittedAt',
        't.actorId as submittedBy',
      ])
      .where('r.id', '=', revisionId)
      .executeTakeFirst();
    if (header === undefined) return null;

    const bullets = await ex
      .selectFrom('catalog.revisionBullets')
      .select(['kind', 'text'])
      .where('revisionId', '=', revisionId)
      .orderBy('kind')
      .orderBy('position')
      .execute();
    const sections = await ex
      .selectFrom('catalog.revisionSections')
      .select(['sectionId', 'title', 'objective'])
      .where('revisionId', '=', revisionId)
      .orderBy('position')
      .execute();
    const withBodies = options.articleBodies ?? true;
    const lectureRows = await ex
      .selectFrom('catalog.revisionLectures')
      .select([
        'lectureId',
        'sectionId',
        'position',
        'type',
        'title',
        'descriptionMd',
        'isPreview',
        'mediaAssetId',
        'durationSeconds',
        withBodies ? 'articleBodyMd' : sql<string | null>`NULL::text`.as('articleBodyMd'),
      ])
      .where('revisionId', '=', revisionId)
      .orderBy('sectionId')
      .orderBy('position')
      .execute();

    const lectures = new Map<string, RevisionLectureRecord>();
    for (const row of lectureRows) {
      lectures.set(row.lectureId, {
        id: row.lectureId,
        sectionId: row.sectionId,
        position: row.position,
        type: narrow(LECTURE_TYPES, row.type, 'catalog.revision_lectures.type'),
        title: row.title,
        descriptionMd: row.descriptionMd,
        isPreview: row.isPreview,
        mediaAssetId: row.mediaAssetId,
        articleBodyMd: row.articleBodyMd,
        durationSeconds: row.durationSeconds,
      });
    }
    const snapshotSections: SnapshotSection[] = sections.map((s) => ({
      id: s.sectionId,
      title: s.title,
      objective: s.objective,
      lectures: [...lectures.values()]
        .filter((l) => l.sectionId === s.sectionId)
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          id: l.id,
          type: l.type,
          title: l.title,
          descriptionMd: l.descriptionMd,
          isPreview: l.isPreview,
          mediaAssetId: l.mediaAssetId,
          articleBodyMd: l.articleBodyMd,
        })),
    }));

    return {
      id: header.id,
      courseId: header.courseId,
      revisionNo: header.revisionNo,
      kind: narrow(REVISION_KINDS, header.kind, 'catalog.course_revisions.kind'),
      contentHashHex: header.contentHash.toString('hex'),
      submitterNote: header.submitterNote,
      submittedAt: header.submittedAt,
      submittedBy: header.submittedBy,
      content: {
        title: header.title,
        subtitle: header.subtitle,
        descriptionMd: header.descriptionMd,
        language: narrow(COURSE_LANGUAGES, header.language, 'catalog.course_revisions.language'),
        level: narrow(COURSE_LEVELS, header.level, 'catalog.course_revisions.level'),
        categoryId: header.categoryId,
        thumbnailAssetId: header.thumbnailAssetId,
        outcomes: bullets.filter((b) => b.kind === 'OUTCOME').map((b) => b.text),
        requirements: bullets.filter((b) => b.kind === 'REQUIREMENT').map((b) => b.text),
        sections: snapshotSections,
      },
      lectures,
    };
  }

  async findDecisionAction(
    revisionId: string,
    ex: Executor = this.db,
  ): Promise<'APPROVE' | 'REJECT' | 'WITHDRAW' | null> {
    const row = await ex
      .selectFrom('catalog.courseTransitions')
      .select('action')
      .where('revisionId', '=', revisionId)
      .where('action', 'in', [...DECISIONS])
      .executeTakeFirst();
    return row === undefined
      ? null
      : narrow(DECISIONS, row.action, 'catalog.course_transitions.action');
  }

  async findPreviousApprovedId(
    courseId: string,
    beforeRevisionNo: number,
    ex: Executor = this.db,
  ): Promise<string | null> {
    const row = await ex
      .selectFrom('catalog.courseTransitions as t')
      .innerJoin('catalog.courseRevisions as r', 'r.id', 't.revisionId')
      .select('r.id')
      .where('t.courseId', '=', courseId)
      .where('t.action', '=', 'APPROVE')
      .where('r.revisionNo', '<', beforeRevisionNo)
      .orderBy('r.revisionNo', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
