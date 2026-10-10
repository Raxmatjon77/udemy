import type { CourseLevel, LectureType, RevisionKind } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { SnapshotContent } from '../../domain/revision-snapshot';

/** A lecture of a revision to insert: the snapshot plus its frozen video duration. */
export interface NewRevisionLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly title: string;
  readonly descriptionMd: string | null;
  readonly isPreview: boolean;
  readonly mediaAssetId: string | null;
  readonly articleBodyMd: string | null;
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

  /** The whole snapshot, or null. */
  abstract findById(revisionId: string, ex?: Executor): Promise<RevisionRecord | null>;

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
