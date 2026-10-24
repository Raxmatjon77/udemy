import { randomUUID } from 'node:crypto';
import {
  ANNOUNCEMENT_LIMITS,
  type ModerationActionType,
  type ModerationStatus,
  type ModerationSubjectType,
} from '@udemy/contracts';
import type { DB, QuestionCursor, Transaction, VoteSubject } from '@udemy/db';
import type { CatalogFacade } from '../../../catalog';
import type { EnrollmentFacade } from '../../../enrollment';
import type { UsersFacade } from '../../../users';
import type { AnnouncementRecord } from '../../domain/announcement';
import {
  AnswerNotFound,
  CannotVoteOwnContent,
  QuestionNotFound,
} from '../../domain/engagement.errors';
import {
  type ModerationActionRecord,
  type ModerationOutcome,
  type ModerationReportRecord,
  type ModerationSubjectRecord,
  subjectKey,
} from '../../domain/moderation';
import type { AnswerRecord, QuestionRecord } from '../../domain/qa';
import { ModerationEvents } from '../moderation-events';
import { ModerationReader } from '../moderation-reader';
import { PeopleDirectory } from '../people';
import { AnnouncementRepository } from '../ports/announcement.repository';
import {
  ModerationRepository,
  type QueueOptions,
  type QueueRow,
  type SubjectRef,
} from '../ports/moderation.repository';
import {
  type AcceptedAnswerChange,
  type AnswerWithQuestion,
  type CreatedAtKeyset,
  type CreatedAtRow,
  type InboxOptions,
  QaRepository,
  type QuestionListOptions,
  type QuestionListRow,
} from '../ports/qa.repository';
import { type QaHint, QaHints } from '../ports/qa-hints';
import { QaAccess } from '../qa-access';
import { QaPresenter } from '../qa-presenter';
import { AnswerReportSubject } from '../report-subjects/answer.report-subject';
import { QuestionReportSubject } from '../report-subjects/question.report-subject';
import { ReviewReplyReportSubject } from '../report-subjects/review-reply.report-subject';
import { ReviewReportSubject } from '../report-subjects/review.report-subject';
import { AskQuestionCommand } from '../use-cases/ask-question.command';
import { DeleteAnnouncementCommand } from '../use-cases/delete-announcement.command';
import { DeleteAnswerCommand } from '../use-cases/delete-answer.command';
import { DeleteQuestionCommand } from '../use-cases/delete-question.command';
import { EditAnswerCommand } from '../use-cases/edit-answer.command';
import { EditQuestionCommand } from '../use-cases/edit-question.command';
import { GetQuestionQuery } from '../use-cases/get-question.query';
import { InstructorQaInboxQuery } from '../use-cases/instructor-qa-inbox.query';
import { ListAnnouncementsQuery } from '../use-cases/list-announcements.query';
import { ListAnswersQuery } from '../use-cases/list-answers.query';
import { ListCourseAnnouncementsQuery } from '../use-cases/list-course-announcements.query';
import { ListModerationQueueQuery } from '../use-cases/list-moderation-queue.query';
import { ListQuestionsQuery } from '../use-cases/list-questions.query';
import { ModerateContentCommand } from '../use-cases/moderate-content.command';
import { PostAnnouncementCommand } from '../use-cases/post-announcement.command';
import { PostAnswerCommand } from '../use-cases/post-answer.command';
import { ReportContentCommand } from '../use-cases/report-content.command';
import { SetAcceptedAnswerCommand } from '../use-cases/set-accepted-answer.command';
import { VoteCommand } from '../use-cases/vote.command';
import {
  type Clock,
  createEngagementHarness,
  exactText,
  FAKE_TRX,
  type InMemoryReportRepository,
  type InMemoryReviewRepository,
} from './engagement.fakes';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const assertTrx = (trx: Transaction<DB>, op: string): void => {
  if (!trx.isTransaction) throw new TypeError(`${op} needs a transaction`);
};

/**
 * In-memory twin of the Q&A tables and their triggers: `answer_count` / `last_activity_at`
 * recomputed from visible, non-deleted answers; hiding or deleting the accepted answer clears
 * it; votes are unique per (subject, user) and never on own content.
 */
export class InMemoryQaRepository extends QaRepository {
  readonly questions: Mutable<QuestionRecord>[] = [];
  readonly answers: Mutable<AnswerRecord>[] = [];
  /** `${subject}:${subjectId}:${userId}` */
  readonly votes = new Set<string>();
  readonly locks: string[] = [];

  constructor(private readonly clock: Clock) {
    super();
  }

  private q(id: string): Mutable<QuestionRecord> | undefined {
    return this.questions.find((x) => x.id === id);
  }

  private a(id: string): Mutable<AnswerRecord> | undefined {
    return this.answers.find((x) => x.id === id);
  }

  /** The `answers_sync_question` trigger. */
  sync(questionId: string): void {
    const q = this.q(questionId);
    if (q === undefined) return;
    const visible = this.answers.filter(
      (a) =>
        a.questionId === questionId && a.deletedAt === null && a.moderationStatus === 'VISIBLE',
    );
    q.answerCount = visible.length;
    const newest = Math.max(q.createdAt.getTime(), ...visible.map((a) => a.createdAt.getTime()));
    q.lastActivityAt = new Date(newest);
    if (q.acceptedAnswerId !== null && !visible.some((a) => a.id === q.acceptedAnswerId)) {
      q.acceptedAnswerId = null;
    }
  }

  /** Test helper / moderation fake: set a subject's moderation status (triggers included). */
  setStatus(type: 'QUESTION' | 'ANSWER', id: string, status: ModerationStatus): boolean {
    if (type === 'QUESTION') {
      const q = this.q(id);
      if (q === undefined) return false;
      q.moderationStatus = status;
      return true;
    }
    const a = this.a(id);
    if (a === undefined) return false;
    a.moderationStatus = status;
    this.sync(a.questionId);
    return true;
  }

  /** `InMemoryReportRepository` lookup for QUESTION / ANSWER subjects. */
  readonly reportLookup = (
    type: string,
    id: string,
  ): { status: ModerationStatus; hide(): void } | null => {
    if (type !== 'QUESTION' && type !== 'ANSWER') return null;
    const row = type === 'QUESTION' ? this.q(id) : this.a(id);
    if (row === undefined || row.deletedAt !== null) return null;
    return { status: row.moderationStatus, hide: () => this.setStatus(type, id, 'HIDDEN') };
  };

  private keyOf(q: QuestionRecord, sort: QuestionCursor['sort']): QuestionCursor {
    return sort === 'recent'
      ? { sort, lastActivityAt: exactText(q.lastActivityAt), id: q.id }
      : sort === 'top'
        ? { sort, upvoteCount: q.upvoteCount, id: q.id }
        : { sort, createdAt: exactText(q.createdAt), id: q.id };
  }

  listQuestions(options: QuestionListOptions): Promise<QuestionListRow[]> {
    const before = (a: QuestionCursor, b: QuestionCursor): boolean => {
      // a sorts AFTER b in the DESC order (a < b)
      if (a.sort === 'top' && b.sort === 'top') {
        return a.upvoteCount < b.upvoteCount || (a.upvoteCount === b.upvoteCount && a.id < b.id);
      }
      const at =
        a.sort === 'recent' ? a.lastActivityAt : a.sort === 'unanswered' ? a.createdAt : '';
      const bt =
        b.sort === 'recent' ? b.lastActivityAt : b.sort === 'unanswered' ? b.createdAt : '';
      return at < bt || (at === bt && a.id < b.id);
    };
    const needle = options.titleContains?.toLowerCase();
    const rows = this.questions
      .filter(
        (q) =>
          q.courseId === options.courseId &&
          q.deletedAt === null &&
          q.moderationStatus === 'VISIBLE' &&
          (options.lectureId === undefined || q.lectureId === options.lectureId) &&
          (needle === undefined || q.title.toLowerCase().includes(needle)) &&
          (options.sort !== 'unanswered' || q.answerCount === 0),
      )
      .map((q) => ({ question: { ...q }, cursor: this.keyOf(q, options.sort) }))
      .filter((r) => options.after === null || before(r.cursor, options.after))
      .sort((x, y) => (before(x.cursor, y.cursor) ? 1 : -1));
    return Promise.resolve(rows.slice(0, options.limit));
  }

  findQuestion(questionId: string): Promise<QuestionRecord | null> {
    const q = this.q(questionId);
    return Promise.resolve(q === undefined ? null : { ...q });
  }

  lockQuestion(trx: Transaction<DB>, questionId: string): Promise<QuestionRecord | null> {
    assertTrx(trx, 'lockQuestion');
    this.locks.push(`question:${questionId}`);
    return this.findQuestion(questionId);
  }

  /** Test helper: a question by anyone. */
  seedQuestion(input: {
    courseId: string;
    authorId: string;
    lectureId?: string | null;
    title?: string;
    moderationStatus?: ModerationStatus;
  }): QuestionRecord {
    const at = this.clock.next();
    const q: Mutable<QuestionRecord> = {
      id: randomUUID(),
      courseId: input.courseId,
      lectureId: input.lectureId ?? null,
      authorId: input.authorId,
      title: input.title ?? 'How does this work?',
      bodyMd: 'Please explain.',
      acceptedAnswerId: null,
      moderationStatus: input.moderationStatus ?? 'VISIBLE',
      upvoteCount: 0,
      answerCount: 0,
      lastActivityAt: at,
      createdAt: at,
      editedAt: null,
      deletedAt: null,
    };
    this.questions.push(q);
    return { ...q };
  }

  insertQuestion(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      lectureId: string | null;
      authorId: string;
      title: string;
      bodyMd: string;
    },
  ): Promise<QuestionRecord> {
    assertTrx(trx, 'insertQuestion');
    const q = this.seedQuestion(input);
    const stored = this.q(q.id);
    if (stored !== undefined) stored.bodyMd = input.bodyMd;
    return this.findQuestion(q.id).then((r) => r ?? q);
  }

  updateQuestion(
    trx: Transaction<DB>,
    questionId: string,
    changes: { title?: string | undefined; bodyMd?: string | undefined },
  ): Promise<QuestionRecord | null> {
    assertTrx(trx, 'updateQuestion');
    const q = this.q(questionId);
    if (q === undefined || q.deletedAt !== null) return Promise.resolve(null);
    const title = changes.title ?? q.title;
    const bodyMd = changes.bodyMd ?? q.bodyMd;
    if (title !== q.title || bodyMd !== q.bodyMd) {
      q.title = title;
      q.bodyMd = bodyMd;
      q.editedAt = this.clock.next();
    }
    return this.findQuestion(questionId);
  }

  softDeleteQuestion(trx: Transaction<DB>, questionId: string): Promise<QuestionRecord | null> {
    assertTrx(trx, 'softDeleteQuestion');
    const q = this.q(questionId);
    if (q === undefined || q.deletedAt !== null) return Promise.resolve(null);
    q.deletedAt = this.clock.next();
    return this.findQuestion(questionId);
  }

  setAcceptedAnswer(
    trx: Transaction<DB>,
    questionId: string,
    answerId: string | null,
  ): Promise<AcceptedAnswerChange | null> {
    assertTrx(trx, 'setAcceptedAnswer');
    const q = this.q(questionId);
    if (q === undefined || q.deletedAt !== null) return Promise.resolve(null);
    if (answerId !== null) {
      const a = this.a(answerId);
      // questions_id_accepted_answer_id_fk / questions_accepted_answer_visible_ck
      if (
        a === undefined ||
        a.questionId !== questionId ||
        a.deletedAt !== null ||
        a.moderationStatus !== 'VISIBLE'
      ) {
        return Promise.reject(new AnswerNotFound());
      }
    }
    const previousAnswerId = q.acceptedAnswerId;
    q.acceptedAnswerId = answerId;
    return Promise.resolve({ question: { ...q }, previousAnswerId, at: this.clock.next() });
  }

  listAnswers(
    questionId: string,
    viewerId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnswerRecord>[]> {
    const rows = this.answers
      .filter(
        (a) =>
          a.questionId === questionId &&
          a.deletedAt === null &&
          (a.moderationStatus === 'VISIBLE' || a.authorId === viewerId),
      )
      .map((a) => ({ record: { ...a }, createdAtKey: exactText(a.createdAt) }))
      .sort((x, y) =>
        x.createdAtKey === y.createdAtKey
          ? x.record.id < y.record.id
            ? -1
            : 1
          : x.createdAtKey < y.createdAtKey
            ? -1
            : 1,
      )
      .filter(
        (r) =>
          after === null ||
          r.createdAtKey > after.createdAt ||
          (r.createdAtKey === after.createdAt && r.record.id > after.id),
      );
    return Promise.resolve(rows.slice(0, limit));
  }

  findAnswer(answerId: string): Promise<AnswerWithQuestion | null> {
    const a = this.a(answerId);
    const q = a === undefined ? undefined : this.q(a.questionId);
    return Promise.resolve(
      a === undefined || q === undefined ? null : { answer: { ...a }, question: { ...q } },
    );
  }

  lockAnswerAcceptance(
    trx: Transaction<DB>,
    answerId: string,
  ): Promise<{ readonly wasAccepted: boolean } | null> {
    assertTrx(trx, 'lockAnswerAcceptance');
    const a = this.a(answerId);
    if (a === undefined) return Promise.resolve(null);
    this.locks.push(`answer:${answerId}`, `question:${a.questionId}`);
    return Promise.resolve({ wasAccepted: this.q(a.questionId)?.acceptedAnswerId === answerId });
  }

  /** Test helper: an answer by anyone. */
  seedAnswer(questionId: string, authorId: string, bodyMd = 'Like this.'): AnswerRecord {
    const a: Mutable<AnswerRecord> = {
      id: randomUUID(),
      questionId,
      authorId,
      bodyMd,
      upvoteCount: 0,
      moderationStatus: 'VISIBLE',
      createdAt: this.clock.next(),
      editedAt: null,
      deletedAt: null,
    };
    this.answers.push(a);
    this.sync(questionId);
    return { ...a };
  }

  insertAnswer(
    trx: Transaction<DB>,
    input: { questionId: string; authorId: string; bodyMd: string },
  ): Promise<AnswerRecord> {
    assertTrx(trx, 'insertAnswer');
    if (this.q(input.questionId) === undefined) return Promise.reject(new QuestionNotFound());
    return Promise.resolve(this.seedAnswer(input.questionId, input.authorId, input.bodyMd));
  }

  updateAnswer(
    trx: Transaction<DB>,
    answerId: string,
    bodyMd: string,
  ): Promise<AnswerRecord | null> {
    assertTrx(trx, 'updateAnswer');
    const a = this.a(answerId);
    if (a === undefined || a.deletedAt !== null) return Promise.resolve(null);
    if (a.bodyMd !== bodyMd) {
      a.bodyMd = bodyMd;
      a.editedAt = this.clock.next();
    }
    return Promise.resolve({ ...a });
  }

  softDeleteAnswer(trx: Transaction<DB>, answerId: string): Promise<AnswerRecord | null> {
    assertTrx(trx, 'softDeleteAnswer');
    const a = this.a(answerId);
    if (a === undefined || a.deletedAt !== null) return Promise.resolve(null);
    a.deletedAt = this.clock.next();
    this.sync(a.questionId);
    return Promise.resolve({ ...a });
  }

  private voteTarget(subject: VoteSubject, subjectId: string) {
    return subject === 'QUESTION' ? this.q(subjectId) : this.a(subjectId);
  }

  castVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean> {
    const target = this.voteTarget(subject, subjectId);
    if (target === undefined) {
      return Promise.reject(subject === 'QUESTION' ? new QuestionNotFound() : new AnswerNotFound());
    }
    if (target.authorId === userId) return Promise.reject(new CannotVoteOwnContent());
    const key = `${subject}:${subjectId}:${userId}`;
    if (this.votes.has(key)) return Promise.resolve(false);
    this.votes.add(key);
    target.upvoteCount += 1;
    return Promise.resolve(true);
  }

  retractVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean> {
    const key = `${subject}:${subjectId}:${userId}`;
    if (!this.votes.delete(key)) return Promise.resolve(false);
    const target = this.voteTarget(subject, subjectId);
    if (target !== undefined) target.upvoteCount -= 1;
    return Promise.resolve(true);
  }

  votedAmong(
    subject: VoteSubject,
    subjectIds: readonly string[],
    userId: string,
  ): Promise<ReadonlySet<string>> {
    return Promise.resolve(
      new Set(subjectIds.filter((id) => this.votes.has(`${subject}:${id}:${userId}`))),
    );
  }

  listInbox(options: InboxOptions): Promise<CreatedAtRow<QuestionRecord>[]> {
    const rows = this.questions
      .filter(
        (q) =>
          options.courseIds.includes(q.courseId) &&
          q.deletedAt === null &&
          q.moderationStatus === 'VISIBLE' &&
          (options.status !== 'unanswered' || q.answerCount === 0) &&
          (options.status !== 'unresolved' || q.acceptedAnswerId === null),
      )
      .map((q) => ({ record: { ...q }, createdAtKey: exactText(q.createdAt) }))
      .sort((x, y) =>
        x.createdAtKey === y.createdAtKey
          ? x.record.id < y.record.id
            ? 1
            : -1
          : x.createdAtKey < y.createdAtKey
            ? 1
            : -1,
      )
      .filter(
        (r) =>
          options.after === null ||
          r.createdAtKey < options.after.createdAt ||
          (r.createdAtKey === options.after.createdAt && r.record.id < options.after.id),
      );
    return Promise.resolve(rows.slice(0, options.limit));
  }
}

const announcementOf = (row: AnnouncementRecord): AnnouncementRecord => ({
  id: row.id,
  courseId: row.courseId,
  authorId: row.authorId,
  title: row.title,
  bodyMd: row.bodyMd,
  sendEmail: row.sendEmail,
  createdAt: row.createdAt,
});

/** In-memory announcements: the quota window is relative to the fake clock. */
export class InMemoryAnnouncementRepository extends AnnouncementRepository {
  readonly items: (Mutable<AnnouncementRecord> & {
    deletedAt: Date | null;
    deletedBy: string | null;
  })[] = [];
  readonly lockedCourses: string[] = [];

  constructor(private readonly clock: Clock) {
    super();
  }

  listLive(
    courseId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnnouncementRecord>[]> {
    const rows = this.items
      .filter((a) => a.courseId === courseId && a.deletedAt === null)
      .map((a) => ({ record: announcementOf(a), createdAtKey: exactText(a.createdAt) }))
      .sort((x, y) =>
        x.createdAtKey === y.createdAtKey
          ? x.record.id < y.record.id
            ? 1
            : -1
          : x.createdAtKey < y.createdAtKey
            ? 1
            : -1,
      )
      .filter(
        (r) =>
          after === null ||
          r.createdAtKey < after.createdAt ||
          (r.createdAtKey === after.createdAt && r.record.id < after.id),
      );
    return Promise.resolve(rows.slice(0, limit));
  }

  windowCreatedAts(courseId: string): Promise<Date[]> {
    const since = this.clock.now().getTime() - ANNOUNCEMENT_LIMITS.windowDays * 86_400_000;
    return Promise.resolve(
      this.items
        .filter((a) => a.courseId === courseId && a.createdAt.getTime() > since)
        .map((a) => a.createdAt)
        .sort((a, b) => a.getTime() - b.getTime()),
    );
  }

  async lockQuota(trx: Transaction<DB>, courseId: string): Promise<number> {
    assertTrx(trx, 'lockQuota');
    this.lockedCourses.push(courseId);
    return (await this.windowCreatedAts(courseId)).length;
  }

  insert(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      authorId: string;
      title: string;
      bodyMd: string;
      sendEmail: boolean;
    },
  ): Promise<AnnouncementRecord> {
    assertTrx(trx, 'insert');
    const row = {
      id: randomUUID(),
      ...input,
      createdAt: this.clock.next(),
      deletedAt: null,
      deletedBy: null,
    };
    this.items.push(row);
    return Promise.resolve(announcementOf(row));
  }

  softDelete(
    trx: Transaction<DB>,
    courseId: string,
    announcementId: string,
    actorId: string,
  ): Promise<{ readonly announcement: AnnouncementRecord; readonly deletedAt: Date } | null> {
    assertTrx(trx, 'softDelete');
    const row = this.items.find(
      (a) => a.id === announcementId && a.courseId === courseId && a.deletedAt === null,
    );
    if (row === undefined) return Promise.resolve(null);
    row.deletedAt = this.clock.next();
    row.deletedBy = actorId;
    return Promise.resolve({ announcement: announcementOf(row), deletedAt: row.deletedAt });
  }
}

/** Moderation over the review, Q&A and report fakes (state machine of `moderateSubject`). */
export class InMemoryModerationRepository extends ModerationRepository {
  readonly actions: ModerationActionRecord[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly reviews: InMemoryReviewRepository,
    private readonly qa: InMemoryQaRepository,
    private readonly reports: InMemoryReportRepository,
  ) {
    super();
  }

  private subject(type: ModerationSubjectType, id: string): ModerationSubjectRecord | null {
    const base = { type, id, routeId: id, title: null, rating: null, lectureId: null };
    switch (type) {
      case 'REVIEW': {
        const r = this.reviews.reviews.find((x) => x.id === id);
        return r === undefined
          ? null
          : {
              ...base,
              courseId: r.courseId,
              authorId: r.userId,
              moderationStatus: r.moderationStatus,
              deleted: r.deletedAt !== null,
              createdAt: r.createdAt,
              body: r.body,
              rating: r.rating,
              reviewId: r.id,
              questionId: null,
            };
      }
      case 'REVIEW_REPLY': {
        const reply = this.reviews.replies.find((x) => x.id === id);
        const review = this.reviews.reviews.find((x) => x.id === reply?.reviewId);
        return reply === undefined || review === undefined
          ? null
          : {
              ...base,
              routeId: review.id,
              courseId: review.courseId,
              authorId: reply.authorId,
              moderationStatus: reply.moderationStatus,
              deleted: reply.deletedAt !== null,
              createdAt: reply.createdAt,
              body: reply.body,
              reviewId: review.id,
              questionId: null,
            };
      }
      case 'QUESTION': {
        const q = this.qa.questions.find((x) => x.id === id);
        return q === undefined
          ? null
          : {
              ...base,
              courseId: q.courseId,
              authorId: q.authorId,
              moderationStatus: q.moderationStatus,
              deleted: q.deletedAt !== null,
              createdAt: q.createdAt,
              title: q.title,
              body: q.bodyMd,
              reviewId: null,
              questionId: q.id,
              lectureId: q.lectureId,
            };
      }
      case 'ANSWER': {
        const a = this.qa.answers.find((x) => x.id === id);
        const q = this.qa.questions.find((x) => x.id === a?.questionId);
        return a === undefined || q === undefined
          ? null
          : {
              ...base,
              courseId: q.courseId,
              authorId: a.authorId,
              moderationStatus: a.moderationStatus,
              deleted: a.deletedAt !== null,
              createdAt: a.createdAt,
              body: a.bodyMd,
              reviewId: null,
              questionId: q.id,
              lectureId: q.lectureId,
            };
      }
    }
  }

  private setStatus(type: ModerationSubjectType, id: string, status: ModerationStatus): void {
    if (type === 'QUESTION' || type === 'ANSWER') {
      this.qa.setStatus(type, id, status);
    } else if (type === 'REVIEW') {
      this.reviews.stored(id).moderationStatus = status;
    } else {
      const reply = this.reviews.replies.find((x) => x.id === id);
      if (reply !== undefined) reply.moderationStatus = status;
    }
  }

  private openReports(ref: SubjectRef) {
    return this.reports.reports.filter(
      (r) => r.subjectType === ref.type && r.subjectId === ref.id && r.status === 'OPEN',
    );
  }

  queuePage(options: QueueOptions): Promise<QueueRow[]> {
    const groups = new Map<string, { ref: SubjectRef; last: Date; statuses: Set<string> }>();
    for (const r of this.reports.reports) {
      if (options.type !== undefined && r.subjectType !== options.type) continue;
      const key = subjectKey(r.subjectType, r.subjectId);
      const g = groups.get(key) ?? {
        ref: { type: r.subjectType, id: r.subjectId },
        last: r.createdAt,
        statuses: new Set<string>(),
      };
      if (r.createdAt > g.last) g.last = r.createdAt;
      g.statuses.add(r.status);
      groups.set(key, g);
    }
    const rows = [...groups.values()]
      .filter((g) => g.statuses.has(options.status))
      .map((g) => ({ ref: g.ref, lastReportedAt: g.last, lastReportedAtKey: exactText(g.last) }))
      .sort((x, y) =>
        x.lastReportedAtKey === y.lastReportedAtKey
          ? x.ref.id < y.ref.id
            ? 1
            : -1
          : x.lastReportedAtKey < y.lastReportedAtKey
            ? 1
            : -1,
      )
      .filter(
        (r) =>
          options.after === null ||
          r.lastReportedAtKey < options.after.lastReportedAt ||
          (r.lastReportedAtKey === options.after.lastReportedAt &&
            r.ref.id < options.after.subjectId),
      );
    return Promise.resolve(rows.slice(0, options.limit));
  }

  loadSubjects(refs: readonly SubjectRef[]): Promise<ReadonlyMap<string, ModerationSubjectRecord>> {
    const map = new Map<string, ModerationSubjectRecord>();
    for (const ref of refs) {
      const s = this.subject(ref.type, ref.id);
      if (s !== null) map.set(subjectKey(ref.type, ref.id), s);
    }
    return Promise.resolve(map);
  }

  resolveRoute(
    type: ModerationSubjectType,
    routeId: string,
  ): Promise<ModerationSubjectRecord | null> {
    if (type !== 'REVIEW_REPLY') return Promise.resolve(this.subject(type, routeId));
    const replies = this.reviews.replies
      .filter((r) => r.reviewId === routeId)
      .sort(
        (a, b) =>
          Number(a.deletedAt !== null) - Number(b.deletedAt !== null) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    const reply = replies[0];
    return Promise.resolve(reply === undefined ? null : this.subject(type, reply.id));
  }

  reportsOf(refs: readonly SubjectRef[], perSubject: number): Promise<ModerationReportRecord[]> {
    return Promise.resolve(
      refs.flatMap((ref) =>
        this.reports.reports
          .filter((r) => r.subjectType === ref.type && r.subjectId === ref.id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, perSubject)
          .map((r) => ({ ...r, subjectType: ref.type })),
      ),
    );
  }

  openReportCounts(refs: readonly SubjectRef[]): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(
      new Map(refs.map((ref) => [subjectKey(ref.type, ref.id), this.openReports(ref).length])),
    );
  }

  actionsOf(refs: readonly SubjectRef[]): Promise<ModerationActionRecord[]> {
    const keys = new Set(refs.map((r) => subjectKey(r.type, r.id)));
    return Promise.resolve(
      this.actions.filter((a) => keys.has(subjectKey(a.subjectType, a.subjectId))),
    );
  }

  private resolve(ref: SubjectRef, status: 'ACTIONED' | 'DISMISSED'): number {
    const open = this.openReports(ref);
    const at = this.clock.next();
    for (const r of open) {
      r.status = status;
      r.resolvedAt = at;
    }
    return open.length;
  }

  private log(ref: SubjectRef, action: ModerationActionType, actorId: string, reason: string) {
    this.actions.push({
      id: randomUUID(),
      subjectType: ref.type,
      subjectId: ref.id,
      action,
      actorId,
      reason,
      occurredAt: this.clock.next(),
    });
  }

  moderate(
    trx: Transaction<DB>,
    input: { ref: SubjectRef; action: ModerationActionType; actorId: string; reason: string },
  ): Promise<ModerationOutcome> {
    assertTrx(trx, 'moderate');
    const { ref, action, actorId, reason } = input;
    const s = this.subject(ref.type, ref.id);
    if (s === null) return Promise.resolve({ outcome: 'NOT_FOUND' });
    const applied = (statusChanged: boolean, resolvedReports: number): ModerationOutcome => ({
      outcome: 'APPLIED',
      moderationStatus: this.subject(ref.type, ref.id)?.moderationStatus ?? s.moderationStatus,
      statusChanged,
      resolvedReports,
    });
    if (s.deleted) {
      if (action !== 'DISMISS_REPORTS') return Promise.resolve({ outcome: 'DELETED' });
      const n = this.resolve(ref, 'DISMISSED');
      if (n === 0) return Promise.resolve({ outcome: 'NOOP' });
      this.log(ref, action, actorId, reason);
      return Promise.resolve(applied(false, n));
    }
    if (action === 'HIDE') {
      if (s.moderationStatus === 'HIDDEN') {
        const n = this.resolve(ref, 'ACTIONED');
        if (n === 0) return Promise.resolve({ outcome: 'NOOP' });
        this.log(ref, action, actorId, reason);
        return Promise.resolve(applied(false, n));
      }
      this.setStatus(ref.type, ref.id, 'HIDDEN');
      this.log(ref, action, actorId, reason);
      return Promise.resolve(applied(true, this.resolve(ref, 'ACTIONED')));
    }
    if (action === 'RESTORE') {
      if (s.moderationStatus === 'VISIBLE') return Promise.resolve({ outcome: 'NOOP' });
      this.setStatus(ref.type, ref.id, 'VISIBLE');
      this.log(ref, action, actorId, reason);
      return Promise.resolve(applied(true, this.resolve(ref, 'DISMISSED')));
    }
    const n = this.resolve(ref, 'DISMISSED');
    if (n === 0) return Promise.resolve({ outcome: 'NOOP' });
    this.log(ref, action, actorId, reason);
    return Promise.resolve(applied(false, n));
  }

  transactionNow(trx: Transaction<DB>): Promise<Date> {
    assertTrx(trx, 'transactionNow');
    return Promise.resolve(this.clock.now());
  }
}

/** Records the post-commit hints. */
export class RecordingQaHints extends QaHints {
  readonly hints: QaHint[] = [];

  changed(hint: QaHint): Promise<void> {
    this.hints.push(hint);
    return Promise.resolve();
  }
}

/** The engagement harness plus Q&A, announcements and moderation, wired as the module does. */
export function createQaHarness(options: { autoHideReports?: number } = {}) {
  const base = createEngagementHarness(options);
  const qa = new InMemoryQaRepository(base.clock);
  base.reports.subjectLookups.push(qa.reportLookup);
  const announcements = new InMemoryAnnouncementRepository(base.clock);
  const moderation = new InMemoryModerationRepository(base.clock, base.reviews, qa, base.reports);
  const hints = new RecordingQaHints();

  const catalog = base.catalog as unknown as CatalogFacade;
  const enrollment = base.enrollment as unknown as EnrollmentFacade;
  const people = new PeopleDirectory(base.users as unknown as UsersFacade);
  const access = new QaAccess(catalog, enrollment);
  const presenter = new QaPresenter(qa, people);
  const moderationEvents = new ModerationEvents(base.events);
  const reader = new ModerationReader(moderation, catalog, people);
  const listAnswers = new ListAnswersQuery(access, qa, presenter);
  const handlers = [
    new ReviewReportSubject(base.reviews, base.events),
    new ReviewReplyReportSubject(base.reviews, base.events),
    new QuestionReportSubject(qa, access, moderationEvents, hints),
    new AnswerReportSubject(qa, access, moderationEvents, hints),
  ];
  const { rateLimiter, events, tx } = base;

  return {
    ...base,
    qa,
    announcements,
    moderation,
    hints,
    trx: FAKE_TRX,
    reportContent: new ReportContentCommand(
      rateLimiter,
      base.reports,
      { autoHideReports: options.autoHideReports ?? 3 },
      tx,
      handlers,
    ),
    listQuestions: new ListQuestionsQuery(access, qa, presenter),
    getQuestion: new GetQuestionQuery(access, qa, presenter, listAnswers),
    listAnswers,
    askQuestion: new AskQuestionCommand(
      rateLimiter,
      access,
      catalog,
      qa,
      events,
      tx,
      presenter,
      hints,
    ),
    editQuestion: new EditQuestionCommand(access, qa, tx, presenter, hints),
    deleteQuestion: new DeleteQuestionCommand(access, qa, events, tx, hints),
    postAnswer: new PostAnswerCommand(rateLimiter, access, qa, events, tx, presenter, hints),
    editAnswer: new EditAnswerCommand(access, qa, tx, presenter, hints),
    deleteAnswer: new DeleteAnswerCommand(access, qa, events, tx, hints),
    vote: new VoteCommand(rateLimiter, access, qa),
    setAccepted: new SetAcceptedAnswerCommand(access, qa, events, tx, presenter, hints),
    inbox: new InstructorQaInboxQuery(catalog, qa, presenter),
    listAnnouncements: new ListAnnouncementsQuery(access, announcements, people),
    listCourseAnnouncements: new ListCourseAnnouncementsQuery(announcements, people),
    postAnnouncement: new PostAnnouncementCommand(
      rateLimiter,
      catalog,
      announcements,
      events,
      tx,
      people,
    ),
    deleteAnnouncement: new DeleteAnnouncementCommand(announcements, events, tx),
    moderationQueue: new ListModerationQueueQuery(moderation, reader),
    moderate: new ModerateContentCommand(moderation, qa, moderationEvents, tx, reader, hints),
  };
}

export type QaHarness = ReturnType<typeof createQaHarness>;
