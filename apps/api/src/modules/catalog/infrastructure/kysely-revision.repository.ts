import { Injectable } from '@nestjs/common';
import {
  COURSE_LANGUAGES,
  COURSE_LEVELS,
  LECTURE_TYPES,
  QUIZ_QUESTION_KINDS,
  REVISION_KINDS,
} from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type InsertedRevision,
  type NewRevision,
  type RevisionLectureRecord,
  type RevisionOutline,
  type RevisionOutlineLecture,
  type RevisionRecord,
  RevisionRepository,
} from '../application/ports/revision.repository';
import type {
  SnapshotQuiz,
  SnapshotQuizOption,
  SnapshotQuizQuestion,
  SnapshotSection,
} from '../domain/revision-snapshot';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { narrow } from './row-mapping';

const DECISIONS = ['APPROVE', 'REJECT', 'WITHDRAW'] as const;

/** Rows per multi-row INSERT of quiz snapshot rows (well below the 65 535 bind limit). */
const QUIZ_INSERT_CHUNK = 1000;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size));
  return result;
}

interface QuizQuestionRow {
  lectureId: string;
  questionId: string;
  position: number;
  kind: string;
  promptMd: string;
  explanationMd: string | null;
}

interface QuizOptionRow {
  questionId: string;
  position: number;
  text: string;
  isCorrect: boolean;
}

/** Quizzes by lecture id from the snapshot rows (questions and options in position order). */
function assembleQuizzes(
  passPcts: ReadonlyMap<string, number>,
  questionRows: readonly QuizQuestionRow[],
  optionRows: readonly QuizOptionRow[],
): Map<string, SnapshotQuiz> {
  const options = new Map<string, SnapshotQuizOption[]>();
  for (const row of [...optionRows].sort((a, b) => a.position - b.position)) {
    const list = options.get(row.questionId) ?? [];
    list.push({ text: row.text, isCorrect: row.isCorrect });
    options.set(row.questionId, list);
  }
  const questions = new Map<string, SnapshotQuizQuestion[]>();
  for (const row of [...questionRows].sort((a, b) => a.position - b.position)) {
    const list = questions.get(row.lectureId) ?? [];
    list.push({
      id: row.questionId,
      kind: narrow(QUIZ_QUESTION_KINDS, row.kind, 'catalog.revision_quiz_questions.kind'),
      promptMd: row.promptMd,
      explanationMd: row.explanationMd,
      options: options.get(row.questionId) ?? [],
    });
    questions.set(row.lectureId, list);
  }
  const result = new Map<string, SnapshotQuiz>();
  for (const [lectureId, passPct] of passPcts) {
    result.set(lectureId, { passPct, questions: questions.get(lectureId) ?? [] });
  }
  return result;
}

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
          quizPassPct: l.type === 'QUIZ' ? (l.quiz?.passPct ?? null) : null,
        })),
      );
      if (lectures.length > 0) {
        await trx.insertInto('catalog.revisionLectures').values(lectures).execute();
      }
      await this.insertQuizzes(trx, revisionId, revision);
      return inserted;
    });
  }

  /**
   * The answer keys of every QUIZ lecture (Phase 5 D6), in the submit transaction (the
   * `revision_quiz_*_same_tx_ck` guards allow no other). The deferred key and completeness
   * checks run at COMMIT; readiness guarantees them, so a violation is a 500.
   */
  private async insertQuizzes(
    trx: Transaction<DB>,
    revisionId: string,
    revision: NewRevision,
  ): Promise<void> {
    const quizLectures = revision.sections.flatMap((s) =>
      s.lectures.flatMap((l) => (l.type === 'QUIZ' && l.quiz !== null ? [l] : [])),
    );
    const questions = quizLectures.flatMap((l) =>
      (l.quiz?.questions ?? []).map((q, position) => ({
        revisionId,
        lectureId: l.id,
        questionId: q.id,
        position,
        kind: q.kind,
        promptMd: q.promptMd,
        explanationMd: q.explanationMd,
      })),
    );
    const options = quizLectures.flatMap((l) =>
      (l.quiz?.questions ?? []).flatMap((q) =>
        q.options.map((o, position) => ({
          revisionId,
          questionId: q.id,
          position,
          text: o.text,
          isCorrect: o.isCorrect,
        })),
      ),
    );
    for (const chunk of chunks(questions, QUIZ_INSERT_CHUNK)) {
      await trx.insertInto('catalog.revisionQuizQuestions').values(chunk).execute();
    }
    for (const chunk of chunks(options, QUIZ_INSERT_CHUNK)) {
      await trx.insertInto('catalog.revisionQuizOptions').values(chunk).execute();
    }
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
    options: { readonly articleBodies?: boolean; readonly quizzes?: boolean } = {},
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
        'quizPassPct',
        withBodies ? 'articleBodyMd' : sql<string | null>`NULL::text`.as('articleBodyMd'),
      ])
      .where('revisionId', '=', revisionId)
      .orderBy('sectionId')
      .orderBy('position')
      .execute();

    const quizPassPcts = new Map<string, number>();
    for (const row of lectureRows) {
      if (row.type === 'QUIZ' && row.quizPassPct !== null) {
        quizPassPcts.set(row.lectureId, row.quizPassPct);
      }
    }
    const quizzes =
      (options.quizzes ?? true) && quizPassPcts.size > 0
        ? await this.loadQuizzes(ex, revisionId, quizPassPcts)
        : new Map<string, SnapshotQuiz>();

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
        quiz: quizzes.get(row.lectureId) ?? null,
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
          quiz: l.quiz,
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

  /** Questions and options of the given QUIZ lectures of one revision (two queries). */
  private async loadQuizzes(
    ex: Executor,
    revisionId: string,
    passPcts: ReadonlyMap<string, number>,
  ): Promise<Map<string, SnapshotQuiz>> {
    const lectureIds = [...passPcts.keys()];
    const questionRows = await ex
      .selectFrom('catalog.revisionQuizQuestions')
      .select(['lectureId', 'questionId', 'position', 'kind', 'promptMd', 'explanationMd'])
      .where('revisionId', '=', revisionId)
      .where('lectureId', 'in', lectureIds)
      .execute();
    const optionRows =
      questionRows.length === 0
        ? []
        : await ex
            .selectFrom('catalog.revisionQuizOptions')
            .select(['questionId', 'position', 'text', 'isCorrect'])
            .where('revisionId', '=', revisionId)
            .where(
              'questionId',
              'in',
              questionRows.map((q) => q.questionId),
            )
            .execute();
    return assembleQuizzes(passPcts, questionRows, optionRows);
  }

  async findQuiz(
    revisionId: string,
    lectureId: string,
    ex: Executor = this.db,
  ): Promise<SnapshotQuiz | null> {
    const lecture = await ex
      .selectFrom('catalog.revisionLectures')
      .select(['type', 'quizPassPct'])
      .where('revisionId', '=', revisionId)
      .where('lectureId', '=', lectureId)
      .executeTakeFirst();
    if (lecture === undefined || lecture.type !== 'QUIZ' || lecture.quizPassPct === null) {
      return null;
    }
    const quizzes = await this.loadQuizzes(
      ex,
      revisionId,
      new Map([[lectureId, lecture.quizPassPct]]),
    );
    return quizzes.get(lectureId) ?? null;
  }

  async findOutlines(
    revisionIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<Map<string, RevisionOutline>> {
    const ids = [...new Set(revisionIds)];
    const result = new Map<string, RevisionOutline>();
    if (ids.length === 0) return result;
    const headers = await ex
      .selectFrom('catalog.courseRevisions')
      .select(['id', 'courseId', 'title'])
      .where('id', 'in', ids)
      .execute();
    if (headers.length === 0) return result;
    const found = headers.map((h) => h.id);
    const sections = await ex
      .selectFrom('catalog.revisionSections')
      .select(['revisionId', 'sectionId', 'title', 'position'])
      .where('revisionId', 'in', found)
      .orderBy('revisionId')
      .orderBy('position')
      .execute();
    const lectureRows = await ex
      .selectFrom('catalog.revisionLectures as l')
      .select((eb) => [
        'l.revisionId',
        'l.lectureId',
        'l.sectionId',
        'l.position',
        'l.type',
        'l.title',
        'l.isPreview',
        'l.mediaAssetId',
        'l.durationSeconds',
        'l.quizPassPct',
        eb
          .selectFrom('catalog.revisionQuizQuestions as q')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('q.revisionId', '=', 'l.revisionId')
          .whereRef('q.lectureId', '=', 'l.lectureId')
          .as('quizQuestionCount'),
      ])
      .where('l.revisionId', 'in', found)
      .orderBy('l.revisionId')
      .orderBy('l.sectionId')
      .orderBy('l.position')
      .execute();

    const lecturesBySection = new Map<string, RevisionOutlineLecture[]>();
    for (const row of lectureRows) {
      const key = `${row.revisionId}|${row.sectionId}`;
      const type = narrow(LECTURE_TYPES, row.type, 'catalog.revision_lectures.type');
      const list = lecturesBySection.get(key) ?? [];
      list.push({
        id: row.lectureId,
        type,
        title: row.title,
        isPreview: row.isPreview,
        mediaAssetId: row.mediaAssetId,
        durationSeconds: type === 'VIDEO' ? row.durationSeconds : null,
        quiz:
          type === 'QUIZ' && row.quizPassPct !== null
            ? { passPct: row.quizPassPct, questionCount: row.quizQuestionCount ?? 0 }
            : null,
      });
      lecturesBySection.set(key, list);
    }
    for (const header of headers) {
      result.set(header.id, {
        revisionId: header.id,
        courseId: header.courseId,
        title: header.title,
        sections: sections
          .filter((s) => s.revisionId === header.id)
          .map((s) => ({
            id: s.sectionId,
            title: s.title,
            lectures: lecturesBySection.get(`${header.id}|${s.sectionId}`) ?? [],
          })),
      });
    }
    return result;
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
