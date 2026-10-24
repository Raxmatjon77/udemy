import type { CourseLevel, LectureType, RevisionKind } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { SnapshotContent, SnapshotQuiz } from '../../domain/revision-snapshot';

/** A lecture of a revision to insert: the snapshot plus its frozen video duration. */
export interface NewRevisionLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly title: string;
  readonly descriptionMd: string | null;
  readonly isPreview: boolean;
  readonly mediaAssetId: string | null;
  readonly articleBodyMd: string | null;
  /**
   * QUIZ only (Phase 5 D6): pass mark, questions, options and answer key, written into
   * `revision_lectures.quiz_pass_pct` + `revision_quiz_questions` / `revision_quiz_options` in
   * the submit transaction; null otherwise.
   */
  readonly quiz: SnapshotQuiz | null;
  /** VIDEO only (READY asset duration, seconds); null otherwise. */
  readonly durationSeconds: number | null;
}

/**
 * A complete revision (D1): every header column is NOT NULL in `course_revisions` (readiness
 * guarantees them at submit). `submitted_at` is SQL `now()`, equal to the SUBMIT transition's
 * `occurred_at` in the same transaction (`course_revisions_submit_log_ck`).
 */
export interface NewRevision {
  readonly courseId: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  readonly contentHash: Buffer;
  readonly title: string;
  readonly subtitle: string;
  readonly descriptionMd: string;
  readonly language: string;
  readonly level: CourseLevel;
  readonly categoryId: string;
  readonly thumbnailAssetId: string;
  readonly submitterNote: string | null;
  readonly outcomes: readonly string[];
  readonly requirements: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly title: string;
    readonly objective: string | null;
    readonly lectures: readonly NewRevisionLecture[];
  }[];
}

export interface InsertedRevision {
  readonly id: string;
  readonly revisionNo: number;
  readonly submittedAt: Date;
}

/** A stored lecture: the snapshot lecture plus its section and duration. */
export interface RevisionLectureRecord extends NewRevisionLecture {
  readonly sectionId: string;
  readonly position: number;
}

/** A stored revision, read back for review, diffs and (P2-T11) the live landing page. */
export interface RevisionRecord {
  readonly id: string;
  readonly courseId: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  /** Lowercase hex of the 32-byte `content_hash`. */
  readonly contentHashHex: string;
  readonly submitterNote: string | null;
  readonly submittedAt: Date;
  /** Actor of the SUBMIT transition (always the owner). */
  readonly submittedBy: string;
  /** The reviewable content, exactly as hashed. */
  readonly content: SnapshotContent;
  /** Lectures with their frozen durations, by lecture id. */
  readonly lectures: ReadonlyMap<string, RevisionLectureRecord>;
}

/** A lecture of a revision outline (no article body, no quiz content). */
export interface RevisionOutlineLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly title: string;
  readonly isPreview: boolean;
  /** VIDEO/RESOURCE; null for ARTICLE and QUIZ. */
  readonly mediaAssetId: string | null;
  /** VIDEO only (frozen at submit); null otherwise. */
  readonly durationSeconds: number | null;
  /** QUIZ only: the pass mark and the number of questions; null otherwise. */
  readonly quiz: { readonly passPct: number; readonly questionCount: number } | null;
}

/**
 * The curriculum of a revision without any content body (Phase 5 `CatalogFacade` live
 * curriculum): immutable, so it is cached per revision id.
 */
export interface RevisionOutline {
  readonly revisionId: string;
  readonly courseId: string;
  /** The revision's (approved) course title. */
  readonly title: string;
  /** In curriculum order, lectures in order. */
  readonly sections: readonly {
    readonly id: string;
    readonly title: string;
    readonly lectures: readonly RevisionOutlineLecture[];
  }[];
}

/**
 * The append-only revision snapshots (`course_revisions` + `revision_bullets` +
 * `revision_sections` + `revision_lectures`, design §6 / schema doc §1.8). Writers run in the
 * caller's transaction, which holds the course row lock.
 */
export abstract class RevisionRepository {
  /** `max(revision_no) + 1` of the course (1 for the first submission). */
  abstract nextRevisionNo(trx: Transaction<DB>, courseId: string): Promise<number>;

  /** Inserts the header, bullets, sections and lectures. */
  abstract insert(trx: Transaction<DB>, revision: NewRevision): Promise<InsertedRevision>;

  /** Lowercase hex `content_hash` of a revision, or null when it does not exist. */
  abstract findContentHashHex(revisionId: string, ex?: Executor): Promise<string | null>;

  /**
   * The whole snapshot, or null. `articleBodies: false` skips the (up to 100 000 character)
   * article bodies, which are then null in `content` and `lectures`; `quizzes: false` skips the
   * quiz content (questions, options, ANSWER KEYS), which is then null: for outlines such as
   * the public landing page, never for hashing or diffs. Both default to true.
   */
  abstract findById(
    revisionId: string,
    ex?: Executor,
    options?: { readonly articleBodies?: boolean; readonly quizzes?: boolean },
  ): Promise<RevisionRecord | null>;

  /**
   * The quiz of one QUIZ lecture of a revision, ANSWER KEY INCLUDED, or null when the lecture
   * is not a QUIZ lecture of that revision. Only for grading (learning, through
   * `CatalogFacade.getQuizAnswerKey`), the learner view after stripping the key, and the admin
   * moderation route.
   */
  abstract findQuiz(
    revisionId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<SnapshotQuiz | null>;

  /** The outlines of these revisions (three queries whatever the count), by revision id. */
  abstract findOutlines(
    revisionIds: readonly string[],
    ex?: Executor,
  ): Promise<Map<string, RevisionOutline>>;

  /** The revision's decision transition (APPROVE/REJECT/WITHDRAW), if decided. */
  abstract findDecisionAction(
    revisionId: string,
    ex?: Executor,
  ): Promise<'APPROVE' | 'REJECT' | 'WITHDRAW' | null>;

  /**
   * The most recent APPROVED revision of the course numbered below `beforeRevisionNo` (the
   * base a revision is diffed against: what was live when it was reviewed).
   */
  abstract findPreviousApprovedId(
    courseId: string,
    beforeRevisionNo: number,
    ex?: Executor,
  ): Promise<string | null>;
}
