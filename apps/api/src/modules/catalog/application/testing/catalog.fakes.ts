import type {
  AssetView,
  BulletKind,
  CourseArchivedPayload,
  CourseCreatedPayload,
  CourseDeletedPayload,
  CoursePublishedPayload,
  CourseRejectedPayload,
  CourseRestoredPayload,
  CourseStatus,
  CourseSubmissionWithdrawnPayload,
  CourseSubmittedForReviewPayload,
  CourseTransitionAction,
  MediaPurpose,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import {
  type AssetConsumer,
  MediaAssetNotFound,
  MediaAssetUnusable,
  type MediaFacade,
  MediaPurposeMismatch,
} from '../../../media';
import {
  CategoryInUse,
  CurriculumLimitExceeded,
  InvalidStateTransition,
  SlugTaken,
  VersionConflict,
} from '../../domain/catalog.errors';
import type { CategoryFacts } from '../../domain/category';
import type { CurriculumPositions } from '../../domain/curriculum';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import {
  type CategoryPatch,
  type CategoryRecord,
  CategoryRepository,
  type CategoryWithCount,
  type NewCategory,
} from '../ports/category.repository';
import {
  CourseLifecycleRepository,
  type DecisionRecord,
  type NewTransition,
  type ReviewQueueRecord,
  type RevisionSummaryRecord,
  type TransitionHead,
  type TransitionRecord,
} from '../ports/course-lifecycle.repository';
import { CoursePeopleDirectory, type CoursePerson } from '../ports/course-people.directory';
import {
  type InsertedRevision,
  type NewRevision,
  type RevisionLectureRecord,
  type RevisionOutline,
  type RevisionRecord,
  RevisionRepository,
} from '../ports/revision.repository';
import {
  type QuizQuestionPatch,
  type QuizQuestionRecord,
  QuizRepository,
  type QuizSettingsRecord,
  type WorkingQuizRecord,
} from '../ports/quiz.repository';
import type { QuizOptionDraft } from '../../domain/quiz';
import type { SnapshotQuiz } from '../../domain/revision-snapshot';
import { SubmissionRateLimiter } from '../ports/submission-rate-limiter';
import {
  type BrowseRecord,
  type LiveCourseRecord,
  type LiveCourseSummaryRecord,
  type LiveLectureLookup,
  PublicCatalogRepository,
  type LiveTotals,
  type RevisionHeaderRecord,
  type SnapshotLectureRecord,
} from '../ports/public-catalog.repository';
import {
  type AdminCourseQuery,
  type AdminCourseRecord,
  type CourseBullets,
  type CourseHeaderPatch,
  type CourseRecord,
  CourseRepository,
  type LifecycleChange,
  type MyCourseRecord,
  type MyCoursesKeyset,
  type NewCourse,
} from '../ports/course.repository';
import {
  type ArticleRecord,
  CurriculumRepository,
  type LectureMediaRef,
  type LecturePatch,
  type LectureRecord,
  type SectionPatch,
  type SectionRecord,
} from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/** Stands in for a Kysely transaction; the fakes never touch it. */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StoredCourse extends Mutable<CourseRecord> {
  deletedAt: Date | null;
}

interface StoredTransition extends NewTransition {
  readonly id: string;
  readonly occurredAt: Date;
}

/**
 * Everything the fakes store, in ONE structured-clonable object, so `FakeTransactionRunner`
 * can roll a failed unit of work back exactly like Postgres would.
 */
export interface CatalogState {
  courses: Map<string, StoredCourse>;
  bullets: Map<string, { outcomes: string[]; requirements: string[] }>;
  transitions: StoredTransition[];
  revisions: Map<string, RevisionSummaryRecord>;
  /** Full snapshots written by FakeRevisionRepository (summaries stay in `revisions`). */
  snapshots: Map<string, RevisionRecord>;
  sections: Map<string, Mutable<SectionRecord>>;
  lectures: Map<string, Mutable<LectureRecord>>;
  articles: Map<string, Mutable<ArticleRecord>>;
  /** `lecture_quizzes` by lecture id. */
  quizzes: Map<string, Mutable<QuizSettingsRecord>>;
  /** `quiz_questions` (with their options) by question id. */
  quizQuestions: Map<string, Mutable<QuizQuestionRecord>>;
  categories: Map<string, Mutable<CategoryRecord>>;
  events: { type: string; payload: unknown }[];
  assets: Map<string, AssetView>;
  /** `${assetId}|${consumerType}|${consumerId}` */
  usages: Set<string>;
}

export class CatalogWorld {
  state: CatalogState = {
    courses: new Map(),
    bullets: new Map(),
    transitions: [],
    revisions: new Map(),
    snapshots: new Map(),
    sections: new Map(),
    lectures: new Map(),
    articles: new Map(),
    quizzes: new Map(),
    quizQuestions: new Map(),
    categories: new Map(),
    events: [],
    assets: new Map(),
    usages: new Set(),
  };
  /** Monotonic clock so `updatedAt` ordering is deterministic. */
  private tick = Date.UTC(2026, 9, 10, 12, 0, 0);

  now(): Date {
    this.tick += 1000;
    return new Date(this.tick);
  }
}

let sequence = 0;
/** A uuid-shaped id with a sortable sequence (asset lock order is "ascending id"). */
export function testId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

/* ----------------------------------------------------------------------------------------
 * Transactions
 * -------------------------------------------------------------------------------------- */

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    const snapshot = structuredClone(this.world.state);
    try {
      return await work(FAKE_TRX);
    } catch (error) {
      this.world.state = snapshot;
      throw error;
    }
  }
}

/* ----------------------------------------------------------------------------------------
 * Courses
 * -------------------------------------------------------------------------------------- */

function toRecord(course: StoredCourse): CourseRecord {
  const record: Partial<StoredCourse> = { ...course };
  delete record.deletedAt;
  return record as CourseRecord;
}

/** Action at the head of a course's chain in the fake log. */
function headOf(world: CatalogWorld, courseId: string): StoredTransition | undefined {
  const chain = world.state.transitions.filter((t) => t.courseId === courseId);
  return chain.find((t) => !chain.some((n) => n.prevTransitionId === t.id));
}

function headActionOf(world: CatalogWorld, courseId: string): CourseTransitionAction | null {
  return headOf(world, courseId)?.action ?? null;
}

/** The latest ARCHIVE transition of an ARCHIVED course (insertion order is chain order). */
function archiveOf(world: CatalogWorld, course: StoredCourse): AdminCourseRecord['archive'] {
  if (course.status !== 'ARCHIVED') return null;
  const last = world.state.transitions
    .filter((t) => t.courseId === course.id && t.action === 'ARCHIVE')
    .at(-1);
  return last === undefined ? null : { actorId: last.actorId, reason: last.reason };
}

export class FakeCourseRepository extends CourseRepository {
  /**
   * Slugs a concurrent transaction takes between our slug lookup and our insert: the insert
   * fails once with SlugTaken, then they count as committed by someone else.
   */
  readonly raceOnce = new Set<string>();
  private readonly committedByOthers = new Set<string>();

  constructor(private readonly world: CatalogWorld) {
    super();
  }

  private live(courseId: string): StoredCourse | undefined {
    const course = this.world.state.courses.get(courseId);
    return course === undefined || course.deletedAt !== null ? undefined : course;
  }

  lockForUpdate(_trx: Transaction<DB>, courseId: string): Promise<CourseRecord | null> {
    return this.findById(courseId);
  }

  async findById(courseId: string): Promise<CourseRecord | null> {
    const course = this.live(courseId);
    return course === undefined ? null : toRecord(course);
  }

  async findOwnerId(courseId: string): Promise<string | null> {
    return this.live(courseId)?.ownerId ?? null;
  }

  async findSlugsWithPrefix(_ex: Executor, prefix: string): Promise<Set<string>> {
    return new Set([
      ...[...this.world.state.courses.values()]
        .filter((c) => c.deletedAt === null && c.slug.startsWith(prefix))
        .map((c) => c.slug),
      ...[...this.committedByOthers].filter((slug) => slug.startsWith(prefix)),
    ]);
  }

  async insert(_trx: Transaction<DB>, course: NewCourse): Promise<CourseRecord> {
    const taken = [...this.world.state.courses.values()].some(
      (c) => c.deletedAt === null && c.slug === course.slug,
    );
    if (taken || this.committedByOthers.has(course.slug)) throw new SlugTaken();
    if (this.raceOnce.delete(course.slug)) {
      this.committedByOthers.add(course.slug);
      throw new SlugTaken();
    }
    const now = this.world.now();
    const stored: StoredCourse = {
      id: testId(),
      ownerId: course.ownerId,
      slug: course.slug,
      title: course.title,
      subtitle: null,
      descriptionMd: null,
      language: null,
      level: null,
      categoryId: course.categoryId,
      thumbnailAssetId: null,
      status: 'DRAFT',
      version: 1,
      pendingRevisionId: null,
      publishedRevisionId: null,
      firstPublishedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.world.state.courses.set(stored.id, stored);
    return toRecord(stored);
  }

  async updateHeader(
    _trx: Transaction<DB>,
    courseId: string,
    patch: CourseHeaderPatch,
  ): Promise<CourseRecord> {
    const course = this.live(courseId);
    if (course === undefined) throw new Error('fake: course not found');
    if (patch.slug !== undefined) {
      const taken = [...this.world.state.courses.values()].some(
        (c) => c.id !== courseId && c.deletedAt === null && c.slug === patch.slug,
      );
      if (taken) throw new SlugTaken();
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (course as unknown as Record<string, unknown>)[key] = value;
    }
    course.version += 1;
    course.updatedAt = this.world.now();
    return toRecord(course);
  }

  async bumpVersion(_trx: Transaction<DB>, courseId: string): Promise<number> {
    const course = this.live(courseId);
    if (course === undefined) throw new Error('fake: course not found');
    course.version += 1;
    course.updatedAt = this.world.now();
    return course.version;
  }

  async markDeleted(_trx: Transaction<DB>, courseId: string): Promise<Date> {
    const course = this.live(courseId);
    if (course === undefined) throw new Error('fake: course not found');
    course.deletedAt = this.world.now();
    course.version += 1;
    return course.deletedAt;
  }

  async getBullets(courseId: string): Promise<CourseBullets> {
    const bullets = this.world.state.bullets.get(courseId);
    return {
      outcomes: [...(bullets?.outcomes ?? [])],
      requirements: [...(bullets?.requirements ?? [])],
    };
  }

  async replaceBullets(
    _trx: Transaction<DB>,
    courseId: string,
    kind: BulletKind,
    texts: readonly string[],
  ): Promise<void> {
    if (texts.length > 10) throw new CurriculumLimitExceeded('fake: too many bullets');
    const bullets = this.world.state.bullets.get(courseId) ?? { outcomes: [], requirements: [] };
    if (kind === 'OUTCOME') bullets.outcomes = [...texts];
    else bullets.requirements = [...texts];
    this.world.state.bullets.set(courseId, bullets);
  }

  async listByOwner(query: {
    readonly ownerId: string;
    readonly status: CourseStatus | undefined;
    readonly after: MyCoursesKeyset | null;
    readonly limit: number;
  }): Promise<MyCourseRecord[]> {
    const text = (d: Date): string => d.toISOString().replace('Z', '000Z');
    return [...this.world.state.courses.values()]
      .filter((c) => c.ownerId === query.ownerId && c.deletedAt === null)
      .filter((c) => query.status === undefined || c.status === query.status)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter((c) => {
        const after = query.after;
        if (after === null) return true;
        const key = text(c.updatedAt);
        return key < after.updatedAt || (key === after.updatedAt && c.id < after.id);
      })
      .slice(0, query.limit)
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        status: c.status,
        pendingRevisionId: c.pendingRevisionId,
        publishedRevisionId: c.publishedRevisionId,
        thumbnailAssetId: c.thumbnailAssetId,
        firstPublishedAt: c.firstPublishedAt,
        updatedAt: c.updatedAt,
        updatedAtText: text(c.updatedAt),
        headAction: headActionOf(this.world, c.id),
      }));
  }

  async applyLifecycle(
    _trx: Transaction<DB>,
    courseId: string,
    change: LifecycleChange,
  ): Promise<CourseRecord> {
    const course = this.live(courseId);
    if (course === undefined) throw new Error('fake: course not found');
    course.status = change.status;
    if (change.pendingRevisionId !== undefined) course.pendingRevisionId = change.pendingRevisionId;
    if (change.publishedRevisionId !== undefined) {
      course.publishedRevisionId = change.publishedRevisionId;
    }
    if (change.markFirstPublished === true && course.firstPublishedAt === null) {
      course.firstPublishedAt = this.world.now();
    }
    course.version += 1;
    course.updatedAt = this.world.now();
    return toRecord(course);
  }

  async searchForAdmin(query: AdminCourseQuery): Promise<AdminCourseRecord[]> {
    const text = (d: Date): string => d.toISOString().replace('Z', '000Z');
    const q = query.q?.toLowerCase();
    return [...this.world.state.courses.values()]
      .filter((c) => c.deletedAt === null)
      .filter((c) => query.status === undefined || c.status === query.status)
      .filter((c) => query.ownerId === undefined || c.ownerId === query.ownerId)
      .filter((c) => q === undefined || c.title.toLowerCase().includes(q) || c.slug.includes(q))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter((c) => {
        const after = query.after;
        if (after === null) return true;
        const key = text(c.updatedAt);
        return key < after.updatedAt || (key === after.updatedAt && c.id < after.id);
      })
      .slice(0, query.limit)
      .map((c) => ({
        id: c.id,
        ownerId: c.ownerId,
        slug: c.slug,
        title: c.title,
        status: c.status,
        pendingRevisionId: c.pendingRevisionId,
        publishedRevisionId: c.publishedRevisionId,
        firstPublishedAt: c.firstPublishedAt,
        updatedAt: c.updatedAt,
        updatedAtText: text(c.updatedAt),
        headAction: headActionOf(this.world, c.id),
        archive: archiveOf(this.world, c),
      }));
  }
}

/* ----------------------------------------------------------------------------------------
 * Lifecycle
 * -------------------------------------------------------------------------------------- */

export class FakeCourseLifecycleRepository extends CourseLifecycleRepository {
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  async getTransitionHead(_trx: Transaction<DB>, courseId: string): Promise<TransitionHead | null> {
    const head = headOf(this.world, courseId);
    return head === undefined
      ? null
      : { id: head.id, toStatus: head.toStatus, action: head.action, actorId: head.actorId };
  }

  /**
   * Mirrors the DB backstops the use cases rely on: the unique chain successor (version
   * conflict) and one decision per revision (`..._decision_uq`).
   */
  async appendTransition(
    _trx: Transaction<DB>,
    transition: NewTransition,
  ): Promise<{ id: string; occurredAt: Date }> {
    const all = this.world.state.transitions;
    if (
      transition.prevTransitionId !== null &&
      all.some(
        (t) =>
          t.courseId === transition.courseId && t.prevTransitionId === transition.prevTransitionId,
      )
    ) {
      throw new VersionConflict();
    }
    const decisions: readonly string[] = ['APPROVE', 'REJECT', 'WITHDRAW'];
    if (
      decisions.includes(transition.action) &&
      all.some((t) => t.revisionId === transition.revisionId && decisions.includes(t.action))
    ) {
      throw new InvalidStateTransition();
    }
    const stored = { ...transition, id: testId(), occurredAt: this.world.now() };
    this.world.state.transitions.push(stored);
    return { id: stored.id, occurredAt: stored.occurredAt };
  }

  async findRevisionSummaries(revisionIds: readonly string[]): Promise<RevisionSummaryRecord[]> {
    return revisionIds.flatMap((id) => {
      const revision = this.world.state.revisions.get(id);
      return revision === undefined ? [] : [revision];
    });
  }

  async findLatestDecision(courseId: string): Promise<DecisionRecord | null> {
    const decisions = this.world.state.transitions
      .filter((t) => t.courseId === courseId && (t.action === 'APPROVE' || t.action === 'REJECT'))
      .map((t) => ({ t, revision: this.world.state.revisions.get(t.revisionId ?? '') }))
      .filter((d) => d.revision !== undefined)
      .sort((a, b) => (b.revision?.revisionNo ?? 0) - (a.revision?.revisionNo ?? 0));
    const latest = decisions[0];
    if (latest === undefined || latest.revision === undefined) return null;
    return {
      action: latest.t.action === 'APPROVE' ? 'APPROVE' : 'REJECT',
      revisionId: latest.revision.id,
      revisionNo: latest.revision.revisionNo,
      reason: latest.t.reason,
      decidedAt: latest.t.occurredAt,
    };
  }

  async findHeadAction(courseId: string): Promise<CourseTransitionAction | null> {
    return headActionOf(this.world, courseId);
  }

  async listHistory(courseId: string): Promise<TransitionRecord[]> {
    const chain = this.world.state.transitions.filter((t) => t.courseId === courseId);
    const ordered: TransitionRecord[] = [];
    let next = chain.find((t) => t.prevTransitionId === null);
    while (next !== undefined) {
      const current = next;
      ordered.push({
        ...current,
        revisionNo:
          current.revisionId === null
            ? null
            : (this.world.state.revisions.get(current.revisionId)?.revisionNo ?? null),
      });
      next = chain.find((t) => t.prevTransitionId === current.id);
    }
    return ordered;
  }

  async listReviewQueue(query: {
    readonly limit: number;
    readonly afterRevisionId: string | null;
  }): Promise<ReviewQueueRecord[]> {
    const after = query.afterRevisionId;
    return [...this.world.state.courses.values()]
      .filter((c) => c.deletedAt === null && c.pendingRevisionId !== null)
      .filter((c) => after === null || (c.pendingRevisionId ?? '') > after)
      .sort((a, b) => ((a.pendingRevisionId ?? '') < (b.pendingRevisionId ?? '') ? -1 : 1))
      .slice(0, query.limit)
      .flatMap((c) => {
        const revision = this.world.state.snapshots.get(c.pendingRevisionId ?? '');
        if (revision === undefined) return [];
        return [
          {
            courseId: c.id,
            ownerId: c.ownerId,
            revisionId: revision.id,
            revisionNo: revision.revisionNo,
            kind: revision.kind,
            title: revision.content.title,
            submittedAt: revision.submittedAt,
          },
        ];
      });
  }
}

/* ----------------------------------------------------------------------------------------
 * Revisions, people, rate limits
 * -------------------------------------------------------------------------------------- */

export class FakeRevisionRepository extends RevisionRepository {
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  async nextRevisionNo(_trx: Transaction<DB>, courseId: string): Promise<number> {
    const numbers = [...this.world.state.revisions.values()]
      .filter((r) => r.courseId === courseId)
      .map((r) => r.revisionNo);
    return Math.max(0, ...numbers) + 1;
  }

  async insert(_trx: Transaction<DB>, revision: NewRevision): Promise<InsertedRevision> {
    const id = testId();
    const submittedAt = this.world.now();
    const lectures = new Map<string, RevisionLectureRecord>();
    for (const section of revision.sections) {
      section.lectures.forEach((l, position) =>
        lectures.set(l.id, { ...l, sectionId: section.id, position }),
      );
    }
    const owner = this.world.state.courses.get(revision.courseId)?.ownerId ?? '';
    this.world.state.snapshots.set(id, {
      id,
      courseId: revision.courseId,
      revisionNo: revision.revisionNo,
      kind: revision.kind,
      contentHashHex: revision.contentHash.toString('hex'),
      submitterNote: revision.submitterNote,
      submittedAt,
      submittedBy: owner,
      content: {
        title: revision.title,
        subtitle: revision.subtitle,
        descriptionMd: revision.descriptionMd,
        language: revision.language as RevisionRecord['content']['language'],
        level: revision.level,
        categoryId: revision.categoryId,
        thumbnailAssetId: revision.thumbnailAssetId,
        outcomes: [...revision.outcomes],
        requirements: [...revision.requirements],
        sections: revision.sections.map((s) => ({
          id: s.id,
          title: s.title,
          objective: s.objective,
          lectures: s.lectures.map((l) => ({
            id: l.id,
            type: l.type,
            title: l.title,
            descriptionMd: l.descriptionMd,
            isPreview: l.isPreview,
            mediaAssetId: l.mediaAssetId,
            articleBodyMd: l.articleBodyMd,
            quiz: l.quiz,
          })),
        })),
      },
      lectures,
    });
    this.world.state.revisions.set(id, {
      id,
      courseId: revision.courseId,
      revisionNo: revision.revisionNo,
      kind: revision.kind,
      submittedAt,
    });
    return { id, revisionNo: revision.revisionNo, submittedAt };
  }

  async findContentHashHex(revisionId: string): Promise<string | null> {
    return this.world.state.snapshots.get(revisionId)?.contentHashHex ?? null;
  }

  async findById(revisionId: string): Promise<RevisionRecord | null> {
    return this.world.state.snapshots.get(revisionId) ?? null;
  }

  async findDecisionAction(revisionId: string): Promise<'APPROVE' | 'REJECT' | 'WITHDRAW' | null> {
    const t = this.world.state.transitions.find(
      (x) =>
        x.revisionId === revisionId &&
        (x.action === 'APPROVE' || x.action === 'REJECT' || x.action === 'WITHDRAW'),
    );
    return t === undefined ? null : (t.action as 'APPROVE' | 'REJECT' | 'WITHDRAW');
  }

  async findQuiz(revisionId: string, lectureId: string): Promise<SnapshotQuiz | null> {
    const lecture = this.world.state.snapshots.get(revisionId)?.lectures.get(lectureId);
    return lecture?.type === 'QUIZ' ? (lecture.quiz ?? null) : null;
  }

  async findOutlines(revisionIds: readonly string[]): Promise<Map<string, RevisionOutline>> {
    const result = new Map<string, RevisionOutline>();
    for (const id of new Set(revisionIds)) {
      const snapshot = this.world.state.snapshots.get(id);
      if (snapshot === undefined) continue;
      result.set(id, {
        revisionId: id,
        courseId: snapshot.courseId,
        title: snapshot.content.title,
        sections: snapshot.content.sections.map((section) => ({
          id: section.id,
          title: section.title,
          lectures: section.lectures.map((l) => ({
            id: l.id,
            type: l.type,
            title: l.title,
            isPreview: l.isPreview,
            mediaAssetId: l.mediaAssetId,
            durationSeconds:
              l.type === 'VIDEO' ? (snapshot.lectures.get(l.id)?.durationSeconds ?? null) : null,
            quiz:
              l.type === 'QUIZ' && l.quiz !== null
                ? { passPct: l.quiz.passPct, questionCount: l.quiz.questions.length }
                : null,
          })),
        })),
      });
    }
    return result;
  }

  async findPreviousApprovedId(courseId: string, beforeRevisionNo: number): Promise<string | null> {
    const approved = this.world.state.transitions
      .filter((t) => t.courseId === courseId && t.action === 'APPROVE' && t.revisionId !== null)
      .map((t) => this.world.state.revisions.get(t.revisionId ?? ''))
      .filter((r): r is RevisionSummaryRecord => r !== undefined && r.revisionNo < beforeRevisionNo)
      .sort((a, b) => b.revisionNo - a.revisionNo);
    return approved[0]?.id ?? null;
  }
}

export class FakeCoursePeopleDirectory extends CoursePeopleDirectory {
  readonly people = new Map<string, CoursePerson>();

  async findPeople(userIds: readonly string[]): Promise<ReadonlyMap<string, CoursePerson>> {
    return new Map(
      userIds.flatMap((id) => {
        const person = this.people.get(id);
        return person === undefined ? [] : [[id, person] as const];
      }),
    );
  }
}

export class FakeSubmissionRateLimiter extends SubmissionRateLimiter {
  readonly hits: string[] = [];
  /** Throws this error on the next hit (e.g. a RateLimitedError). */
  failNext: Error | null = null;

  async hitSubmit(userId: string): Promise<void> {
    this.hits.push(userId);
    const error = this.failNext;
    this.failNext = null;
    if (error !== null) throw error;
  }
}

/* ----------------------------------------------------------------------------------------
 * Curriculum
 * -------------------------------------------------------------------------------------- */

export class FakeCurriculumRepository extends CurriculumRepository {
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  private get s(): CatalogState {
    return this.world.state;
  }

  async listSections(courseId: string): Promise<SectionRecord[]> {
    return [...this.s.sections.values()]
      .filter((x) => x.courseId === courseId)
      .sort((a, b) => a.position - b.position)
      .map((x) => ({ ...x }));
  }

  async listLectures(courseId: string): Promise<LectureRecord[]> {
    const sectionPos = new Map([...this.s.sections.values()].map((x) => [x.id, x.position]));
    return [...this.s.lectures.values()]
      .filter((l) => l.courseId === courseId)
      .sort(
        (a, b) =>
          (sectionPos.get(a.sectionId) ?? 0) - (sectionPos.get(b.sectionId) ?? 0) ||
          a.position - b.position,
      )
      .map((l) => ({ ...l }));
  }

  async listArticleBodies(courseId: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const article of this.s.articles.values()) {
      if (this.s.lectures.get(article.lectureId)?.courseId === courseId) {
        result.set(article.lectureId, article.bodyMd);
      }
    }
    return result;
  }

  async findSection(courseId: string, sectionId: string): Promise<SectionRecord | null> {
    const section = this.s.sections.get(sectionId);
    return section === undefined || section.courseId !== courseId ? null : { ...section };
  }

  async findLecture(courseId: string, lectureId: string): Promise<LectureRecord | null> {
    const lecture = this.s.lectures.get(lectureId);
    return lecture === undefined || lecture.courseId !== courseId ? null : { ...lecture };
  }

  async countSections(_trx: Transaction<DB>, courseId: string): Promise<number> {
    return (await this.listSections(courseId)).length;
  }

  async countLectures(
    _trx: Transaction<DB>,
    courseId: string,
    sectionId: string,
  ): Promise<{ inSection: number; inCourse: number }> {
    const all = await this.listLectures(courseId);
    return { inSection: all.filter((l) => l.sectionId === sectionId).length, inCourse: all.length };
  }

  async countPreviews(
    _trx: Transaction<DB>,
    courseId: string,
    exceptLectureId: string,
  ): Promise<number> {
    return (await this.listLectures(courseId)).filter(
      (l) => l.isPreview && l.id !== exceptLectureId,
    ).length;
  }

  async listLectureMedia(
    _trx: Transaction<DB>,
    courseId: string,
    sectionId?: string,
  ): Promise<LectureMediaRef[]> {
    return (await this.listLectures(courseId))
      .filter(
        (l) => l.mediaAssetId !== null && (sectionId === undefined || l.sectionId === sectionId),
      )
      .map((l) => ({ lectureId: l.id, assetId: l.mediaAssetId ?? '' }))
      .sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
  }

  async insertSection(
    _trx: Transaction<DB>,
    section: { courseId: string; title: string; objective: string | null; position: number },
  ): Promise<SectionRecord> {
    const stored = { ...section, id: testId(), updatedAt: this.world.now() };
    this.s.sections.set(stored.id, stored);
    return { ...stored };
  }

  async updateSection(
    _trx: Transaction<DB>,
    _courseId: string,
    sectionId: string,
    patch: SectionPatch,
  ): Promise<SectionRecord> {
    const section = this.s.sections.get(sectionId);
    if (section === undefined) throw new Error('fake: section not found');
    if (patch.title !== undefined) section.title = patch.title;
    if (patch.objective !== undefined) section.objective = patch.objective;
    section.updatedAt = this.world.now();
    return { ...section };
  }

  async deleteSection(_trx: Transaction<DB>, courseId: string, sectionId: string): Promise<void> {
    for (const lecture of [...this.s.lectures.values()]) {
      if (lecture.sectionId === sectionId) {
        this.s.lectures.delete(lecture.id);
        this.s.articles.delete(lecture.id);
        deleteQuizOf(this.s, lecture.id);
      }
    }
    this.s.sections.delete(sectionId);
    (await this.listSections(courseId)).forEach((x, i) => {
      const stored = this.s.sections.get(x.id);
      if (stored !== undefined) stored.position = i;
    });
  }

  async insertLecture(
    _trx: Transaction<DB>,
    lecture: {
      courseId: string;
      sectionId: string;
      type: LectureRecord['type'];
      title: string;
      position: number;
    },
  ): Promise<LectureRecord> {
    const stored: Mutable<LectureRecord> = {
      ...lecture,
      id: testId(),
      descriptionMd: null,
      isPreview: false,
      mediaAssetId: null,
      updatedAt: this.world.now(),
    };
    this.s.lectures.set(stored.id, stored);
    return { ...stored };
  }

  async updateLecture(
    _trx: Transaction<DB>,
    _courseId: string,
    lectureId: string,
    patch: LecturePatch,
  ): Promise<LectureRecord> {
    const lecture = this.s.lectures.get(lectureId);
    if (lecture === undefined) throw new Error('fake: lecture not found');
    if (patch.title !== undefined) lecture.title = patch.title;
    if (patch.descriptionMd !== undefined) lecture.descriptionMd = patch.descriptionMd;
    if (patch.isPreview !== undefined) lecture.isPreview = patch.isPreview;
    lecture.updatedAt = this.world.now();
    return { ...lecture };
  }

  async setLectureMedia(
    _trx: Transaction<DB>,
    _courseId: string,
    lectureId: string,
    assetId: string | null,
  ): Promise<LectureRecord> {
    const lecture = this.s.lectures.get(lectureId);
    if (lecture === undefined) throw new Error('fake: lecture not found');
    lecture.mediaAssetId = assetId;
    return { ...lecture };
  }

  async clearAllLectureMedia(_trx: Transaction<DB>, courseId: string): Promise<void> {
    for (const lecture of this.s.lectures.values()) {
      if (lecture.courseId === courseId) lecture.mediaAssetId = null;
    }
  }

  async deleteLecture(_trx: Transaction<DB>, courseId: string, lectureId: string): Promise<void> {
    const lecture = this.s.lectures.get(lectureId);
    if (lecture === undefined) return;
    this.s.lectures.delete(lectureId);
    this.s.articles.delete(lectureId);
    deleteQuizOf(this.s, lectureId);
    (await this.listLectures(courseId))
      .filter((l) => l.sectionId === lecture.sectionId)
      .forEach((l, i) => {
        const stored = this.s.lectures.get(l.id);
        if (stored !== undefined) stored.position = i;
      });
  }

  async applyPositions(
    _trx: Transaction<DB>,
    _courseId: string,
    positions: CurriculumPositions,
  ): Promise<void> {
    for (const p of positions.sections) {
      const section = this.s.sections.get(p.id);
      if (section !== undefined) section.position = p.position;
    }
    for (const p of positions.lectures) {
      const lecture = this.s.lectures.get(p.id);
      if (lecture !== undefined) {
        lecture.sectionId = p.sectionId;
        lecture.position = p.position;
      }
    }
  }

  async findArticle(lectureId: string): Promise<ArticleRecord | null> {
    const article = this.s.articles.get(lectureId);
    return article === undefined ? null : { ...article };
  }

  async saveArticle(
    _trx: Transaction<DB>,
    lectureId: string,
    bodyMd: string,
  ): Promise<ArticleRecord> {
    const article = { lectureId, bodyMd, updatedAt: this.world.now() };
    this.s.articles.set(lectureId, article);
    return { ...article };
  }
}

/* ----------------------------------------------------------------------------------------
 * Quizzes (Phase 5)
 * -------------------------------------------------------------------------------------- */

/** The ON DELETE CASCADE of `lecture_quizzes` -> `quiz_questions` -> `quiz_options`. */
function deleteQuizOf(state: CatalogState, lectureId: string): void {
  state.quizzes.delete(lectureId);
  for (const question of [...state.quizQuestions.values()]) {
    if (question.lectureId === lectureId) state.quizQuestions.delete(question.id);
  }
}

function copyQuestion(question: QuizQuestionRecord): QuizQuestionRecord {
  return { ...question, options: question.options.map((o) => ({ ...o })) };
}

export class FakeQuizRepository extends QuizRepository {
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  private get s(): CatalogState {
    return this.world.state;
  }

  private questionsOf(lectureId: string): QuizQuestionRecord[] {
    return [...this.s.quizQuestions.values()]
      .filter((q) => q.lectureId === lectureId)
      .sort((a, b) => a.position - b.position)
      .map(copyQuestion);
  }

  async findQuiz(lectureId: string): Promise<WorkingQuizRecord | null> {
    const settings = this.s.quizzes.get(lectureId);
    if (settings === undefined) return null;
    return { settings: { ...settings }, questions: this.questionsOf(lectureId) };
  }

  async listCourseQuizzes(courseId: string): Promise<Map<string, WorkingQuizRecord>> {
    const result = new Map<string, WorkingQuizRecord>();
    for (const lectureId of this.s.quizzes.keys()) {
      if (this.s.lectures.get(lectureId)?.courseId !== courseId) continue;
      const quiz = await this.findQuiz(lectureId);
      if (quiz !== null) result.set(lectureId, quiz);
    }
    return result;
  }

  async insertQuiz(_trx: Transaction<DB>, lectureId: string): Promise<QuizSettingsRecord> {
    if (this.s.lectures.get(lectureId)?.type !== 'QUIZ') {
      throw new Error('fake: lecture_quizzes_lecture_id_lecture_type_fk');
    }
    const settings = { lectureId, passPct: 70, updatedAt: this.world.now() };
    this.s.quizzes.set(lectureId, settings);
    return { ...settings };
  }

  async updatePassPct(
    _trx: Transaction<DB>,
    lectureId: string,
    passPct: number,
  ): Promise<QuizSettingsRecord> {
    const settings = this.s.quizzes.get(lectureId);
    if (settings === undefined) throw new Error('fake: quiz not found');
    settings.passPct = passPct;
    settings.updatedAt = this.world.now();
    return { ...settings };
  }

  async touch(_trx: Transaction<DB>, lectureId: string): Promise<void> {
    const settings = this.s.quizzes.get(lectureId);
    if (settings !== undefined) settings.updatedAt = this.world.now();
  }

  async listQuestionIds(_trx: Transaction<DB>, lectureId: string): Promise<string[]> {
    return this.questionsOf(lectureId).map((q) => q.id);
  }

  async findQuestion(lectureId: string, questionId: string): Promise<QuizQuestionRecord | null> {
    const question = this.s.quizQuestions.get(questionId);
    return question === undefined || question.lectureId !== lectureId
      ? null
      : copyQuestion(question);
  }

  async insertQuestion(
    _trx: Transaction<DB>,
    question: {
      readonly lectureId: string;
      readonly position: number;
      readonly kind: QuizQuestionRecord['kind'];
      readonly promptMd: string;
      readonly explanationMd: string | null;
    },
  ): Promise<QuizQuestionRecord> {
    if (!this.s.quizzes.has(question.lectureId)) {
      throw new Error('fake: quiz_questions_lecture_id_fk');
    }
    const stored: Mutable<QuizQuestionRecord> = {
      ...question,
      id: testId(),
      updatedAt: this.world.now(),
      options: [],
    };
    this.s.quizQuestions.set(stored.id, stored);
    return copyQuestion(stored);
  }

  async updateQuestion(
    _trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    patch: QuizQuestionPatch,
  ): Promise<QuizQuestionRecord> {
    const question = this.s.quizQuestions.get(questionId);
    if (question === undefined || question.lectureId !== lectureId) {
      throw new Error('fake: question not found');
    }
    if (patch.kind !== undefined) question.kind = patch.kind;
    if (patch.promptMd !== undefined) question.promptMd = patch.promptMd;
    if (patch.explanationMd !== undefined) question.explanationMd = patch.explanationMd;
    question.updatedAt = this.world.now();
    return copyQuestion(question);
  }

  async deleteQuestion(
    _trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
  ): Promise<void> {
    const question = this.s.quizQuestions.get(questionId);
    if (question === undefined || question.lectureId !== lectureId) return;
    this.s.quizQuestions.delete(questionId);
    this.questionsOf(lectureId).forEach((q, position) => {
      const stored = this.s.quizQuestions.get(q.id);
      if (stored !== undefined) stored.position = position;
    });
  }

  async replaceOptions(
    _trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    options: readonly QuizOptionDraft[],
  ): Promise<QuizQuestionRecord> {
    const question = this.s.quizQuestions.get(questionId);
    if (question === undefined || question.lectureId !== lectureId) {
      throw new Error('fake: quiz_options_question_id_fk');
    }
    question.options = options.map((o, position) => ({
      position,
      text: o.text,
      isCorrect: o.isCorrect,
    }));
    question.updatedAt = this.world.now();
    return copyQuestion(question);
  }

  async applyQuestionOrder(
    _trx: Transaction<DB>,
    lectureId: string,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void> {
    for (const p of positions) {
      const question = this.s.quizQuestions.get(p.id);
      if (question !== undefined && question.lectureId === lectureId) {
        question.position = p.position;
      }
    }
  }
}

/* ----------------------------------------------------------------------------------------
 * Public read model (the live courses of the world; the reads the Phase 5 facade and the
 * landing use)
 * -------------------------------------------------------------------------------------- */

export class FakePublicCatalogRepository extends PublicCatalogRepository {
  findLiveCourseCalls = 0;

  constructor(private readonly world: CatalogWorld) {
    super();
  }

  private live(course: StoredCourse | undefined): LiveCourseRecord | null {
    if (
      course === undefined ||
      course.deletedAt !== null ||
      course.publishedRevisionId === null ||
      (course.status !== 'PUBLISHED' && course.status !== 'ARCHIVED')
    ) {
      return null;
    }
    const revision = this.world.state.snapshots.get(course.publishedRevisionId);
    return {
      id: course.id,
      slug: course.slug,
      ownerId: course.ownerId,
      status: course.status,
      liveRevisionId: course.publishedRevisionId,
      thumbnailAssetId: revision?.content.thumbnailAssetId ?? '',
      firstPublishedAt: course.firstPublishedAt ?? new Date(0),
      liveSince: course.firstPublishedAt ?? new Date(0),
    };
  }

  async findPublishedBySlug(slug: string): Promise<LiveCourseRecord | null> {
    const course = [...this.world.state.courses.values()].find(
      (c) => c.slug === slug && c.status === 'PUBLISHED',
    );
    return this.live(course);
  }

  async findLiveCourse(courseId: string): Promise<LiveCourseRecord | null> {
    this.findLiveCourseCalls += 1;
    return this.live(this.world.state.courses.get(courseId));
  }

  async findLiveCourseSummaries(courseIds: readonly string[]): Promise<LiveCourseSummaryRecord[]> {
    return [...new Set(courseIds)].flatMap((id) => {
      const course = this.live(this.world.state.courses.get(id));
      if (course === null) return [];
      const title = this.world.state.snapshots.get(course.liveRevisionId)?.content.title ?? '';
      return [{ ...course, title }];
    });
  }

  async listCategories(): Promise<CategoryRecord[]> {
    return [...this.world.state.categories.values()].map((c) => ({ ...c }));
  }

  findLiveLecture(): Promise<LiveLectureLookup | null> {
    throw new Error('fake: not implemented');
  }
  findRevisionHeader(): Promise<RevisionHeaderRecord | null> {
    throw new Error('fake: not implemented');
  }
  findRevisionLecture(): Promise<SnapshotLectureRecord | null> {
    throw new Error('fake: not implemented');
  }
  listLiveLectureIds(): Promise<string[]> {
    throw new Error('fake: not implemented');
  }
  listLiveCourseIdsByOwner(): Promise<string[]> {
    throw new Error('fake: not implemented');
  }
  liveTotals(): Promise<ReadonlyMap<string, LiveTotals>> {
    throw new Error('fake: not implemented');
  }
  browse(): Promise<BrowseRecord[]> {
    throw new Error('fake: not implemented');
  }
}

/* ----------------------------------------------------------------------------------------
 * Categories
 * -------------------------------------------------------------------------------------- */

export class FakeCategoryRepository extends CategoryRepository {
  treeLocks = 0;

  constructor(private readonly world: CatalogWorld) {
    super();
  }

  private get map(): Map<string, Mutable<CategoryRecord>> {
    return this.world.state.categories;
  }

  private withParent(node: Mutable<CategoryRecord>): CategoryRecord {
    const parent = node.parentId === null ? undefined : this.map.get(node.parentId);
    return { ...node, parentActive: parent?.isActive ?? true };
  }

  async lockTree(): Promise<void> {
    this.treeLocks += 1;
  }

  async findForShare(_trx: Transaction<DB>, id: string): Promise<CategoryFacts | null> {
    return this.findById(id);
  }

  async findById(id: string): Promise<CategoryRecord | null> {
    const node = this.map.get(id);
    return node === undefined ? null : this.withParent(node);
  }

  async listAll(): Promise<CategoryWithCount[]> {
    const courses = [...this.world.state.courses.values()].filter((c) => c.deletedAt === null);
    return [...this.map.values()].map((node) => ({
      ...this.withParent(node),
      courseCount: courses.filter((c) => c.categoryId === node.id).length,
    }));
  }

  async listChildIds(_trx: Transaction<DB>, parentId: string | null): Promise<string[]> {
    return [...this.map.values()]
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);
  }

  async findSlugsWithPrefix(_ex: Executor, prefix: string): Promise<Set<string>> {
    return new Set([...this.map.values()].map((c) => c.slug).filter((s) => s.startsWith(prefix)));
  }

  async countUsage(
    _trx: Transaction<DB>,
    id: string,
  ): Promise<{ children: number; references: number }> {
    return {
      children: [...this.map.values()].filter((c) => c.parentId === id).length,
      references: [...this.world.state.courses.values()].filter((c) => c.categoryId === id).length,
    };
  }

  async insert(_trx: Transaction<DB>, category: NewCategory): Promise<CategoryRecord> {
    if ([...this.map.values()].some((c) => c.slug === category.slug)) throw new SlugTaken();
    const stored = { ...category, id: testId(), isActive: true, parentActive: true };
    this.map.set(stored.id, stored);
    return this.withParent(stored);
  }

  async update(_trx: Transaction<DB>, id: string, patch: CategoryPatch): Promise<CategoryRecord> {
    const node = this.map.get(id);
    if (node === undefined) throw new Error('fake: category not found');
    if (
      patch.slug !== undefined &&
      [...this.map.values()].some((c) => c.id !== id && c.slug === patch.slug)
    ) {
      throw new SlugTaken();
    }
    if (patch.name !== undefined) node.name = patch.name;
    if (patch.slug !== undefined) node.slug = patch.slug;
    if (patch.isActive !== undefined) node.isActive = patch.isActive;
    if (patch.move !== undefined) {
      node.parentId = patch.move.parentId;
      node.position = patch.move.position;
    }
    return this.withParent(node);
  }

  async setPositions(
    _trx: Transaction<DB>,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void> {
    for (const p of positions) {
      const node = this.map.get(p.id);
      if (node !== undefined) node.position = p.position;
    }
  }

  async compactPositions(trx: Transaction<DB>, parentId: string | null): Promise<void> {
    (await this.listChildIds(trx, parentId)).forEach((id, i) => {
      const node = this.map.get(id);
      if (node !== undefined) node.position = i;
    });
  }

  async delete(_trx: Transaction<DB>, id: string): Promise<void> {
    const usage = await this.countUsage(FAKE_TRX, id);
    if (usage.children + usage.references > 0) throw new CategoryInUse();
    this.map.delete(id);
  }
}

/* ----------------------------------------------------------------------------------------
 * Events and media
 * -------------------------------------------------------------------------------------- */

export class FakeCatalogEventPublisher extends CatalogEventPublisher {
  constructor(private readonly world: CatalogWorld) {
    super();
  }

  async courseCreated(_trx: Transaction<DB>, payload: CourseCreatedPayload): Promise<void> {
    this.world.state.events.push({ type: 'CourseCreated', payload });
  }

  async courseDeleted(_trx: Transaction<DB>, payload: CourseDeletedPayload): Promise<void> {
    this.world.state.events.push({ type: 'CourseDeleted', payload });
  }

  async courseSubmittedForReview(
    _trx: Transaction<DB>,
    payload: CourseSubmittedForReviewPayload,
  ): Promise<void> {
    this.world.state.events.push({ type: 'CourseSubmittedForReview', payload });
  }

  async courseSubmissionWithdrawn(
    _trx: Transaction<DB>,
    payload: CourseSubmissionWithdrawnPayload,
  ): Promise<void> {
    this.world.state.events.push({ type: 'CourseSubmissionWithdrawn', payload });
  }

  async coursePublished(_trx: Transaction<DB>, payload: CoursePublishedPayload): Promise<void> {
    this.world.state.events.push({ type: 'CoursePublished', payload });
  }

  async courseRejected(_trx: Transaction<DB>, payload: CourseRejectedPayload): Promise<void> {
    this.world.state.events.push({ type: 'CourseRejected', payload });
  }

  async courseArchived(_trx: Transaction<DB>, payload: CourseArchivedPayload): Promise<void> {
    this.world.state.events.push({ type: 'CourseArchived', payload });
  }

  async courseRestored(_trx: Transaction<DB>, payload: CourseRestoredPayload): Promise<void> {
    this.world.state.events.push({ type: 'CourseRestored', payload });
  }
}

const WORKING_TYPES = new Set(['catalog.lecture', 'catalog.course_thumbnail']);

/** The MediaFacade methods catalog uses, over in-memory assets and usages. */
export class FakeMediaFacade {
  /** Order in which assets were locked (use/release), to check lock ordering. */
  readonly locked: string[] = [];

  constructor(private readonly world: CatalogWorld) {}

  addAsset(overrides: Partial<AssetView> & { ownerId: string; purpose: MediaPurpose }): AssetView {
    const asset: AssetView = {
      id: overrides.id ?? testId(),
      status: 'READY',
      originalFilename: 'file.bin',
      sizeBytes: 1000,
      progressPct: null,
      failureCode: null,
      durationSeconds: overrides.purpose === 'LECTURE_VIDEO' ? 600 : null,
      width: overrides.purpose === 'LECTURE_RESOURCE' ? null : 1280,
      height: overrides.purpose === 'LECTURE_RESOURCE' ? null : 720,
      renditions: [],
      purged: false,
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
    this.world.state.assets.set(asset.id, asset);
    return asset;
  }

  usagesOf(assetId: string): string[] {
    return [...this.world.state.usages]
      .filter((u) => u.startsWith(`${assetId}|`))
      .map((u) => u.slice(assetId.length + 1));
  }

  async getAssets(ids: readonly string[]): Promise<AssetView[]> {
    return [...new Set(ids)].flatMap((id) => {
      const asset = this.world.state.assets.get(id);
      return asset === undefined ? [] : [{ ...asset }];
    });
  }

  async useAsset(
    _trx: Transaction<DB>,
    input: { assetId: string; ownerId: string; purpose: MediaPurpose; consumer: AssetConsumer },
  ): Promise<AssetView> {
    this.locked.push(input.assetId);
    const asset = this.world.state.assets.get(input.assetId);
    if (asset === undefined || asset.ownerId !== input.ownerId) throw new MediaAssetNotFound();
    if (asset.purpose !== input.purpose)
      throw new MediaPurposeMismatch({ expected: input.purpose });
    if (asset.purged || asset.status === 'FAILED' || asset.status === 'ABORTED') {
      throw new MediaAssetUnusable();
    }
    const key = `${input.assetId}|${input.consumer.type}|${input.consumer.id}`;
    const otherWorking = [...this.world.state.usages].some(
      (u) =>
        u.startsWith(`${input.assetId}|`) && u !== key && WORKING_TYPES.has(u.split('|')[1] ?? ''),
    );
    if (otherWorking) throw new MediaAssetUnusable({ reason: 'in use elsewhere' });
    const consumerHasOther = [...this.world.state.usages].some(
      (u) => u.endsWith(`|${input.consumer.type}|${input.consumer.id}`) && u !== key,
    );
    if (consumerHasOther)
      throw new Error('fake: asset_usages_consumer_working_uq (use before release)');
    this.world.state.usages.add(key);
    return { ...asset };
  }

  async releaseAsset(
    _trx: Transaction<DB>,
    input: { assetId: string; consumer: AssetConsumer },
  ): Promise<boolean> {
    this.locked.push(input.assetId);
    return this.world.state.usages.delete(
      `${input.assetId}|${input.consumer.type}|${input.consumer.id}`,
    );
  }

  async releaseConsumer(_trx: Transaction<DB>, consumer: AssetConsumer): Promise<string[]> {
    const suffix = `|${consumer.type}|${consumer.id}`;
    const released = [...this.world.state.usages].filter((u) => u.endsWith(suffix)).sort();
    for (const usage of released) {
      this.world.state.usages.delete(usage);
      this.locked.push(usage.slice(0, usage.length - suffix.length));
    }
    return released.map((u) => u.slice(0, u.length - suffix.length));
  }

  async pinRevisionAssets(
    _trx: Transaction<DB>,
    input: { revisionId: string; assetIds: readonly string[] },
  ): Promise<void> {
    const ids = [...new Set(input.assetIds)].sort();
    for (const id of ids) {
      this.locked.push(id);
      const asset = this.world.state.assets.get(id);
      if (asset === undefined) throw new MediaAssetNotFound();
      if (asset.purged || asset.status !== 'READY') throw new MediaAssetUnusable();
    }
    for (const id of ids)
      this.world.state.usages.add(`${id}|catalog.course_revision|${input.revisionId}`);
  }

  asFacade(): MediaFacade {
    return this as unknown as MediaFacade;
  }
}
