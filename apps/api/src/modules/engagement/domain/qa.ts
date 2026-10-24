import type { ModerationStatus } from '@udemy/contracts';

/**
 * Course Q&A (Phase 5 learning experience design D12, §4 Question). OPEN/RESOLVED is derived
 * from `acceptedAnswerId`; moderation (VISIBLE/HIDDEN) and the soft delete are orthogonal.
 * `upvoteCount`, `answerCount` and `lastActivityAt` are trigger-maintained in the database (a
 * documented 3NF exception): the application only reads them, never computes or writes them.
 */

export interface QuestionRecord {
  readonly id: string;
  readonly courseId: string;
  /** Null = a general course question. */
  readonly lectureId: string | null;
  readonly authorId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly acceptedAnswerId: string | null;
  readonly moderationStatus: ModerationStatus;
  readonly upvoteCount: number;
  /** Visible, non-deleted answers (trigger-maintained). */
  readonly answerCount: number;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface AnswerRecord {
  readonly id: string;
  readonly questionId: string;
  readonly authorId: string;
  readonly bodyMd: string;
  readonly upvoteCount: number;
  readonly moderationStatus: ModerationStatus;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

/**
 * Whether `viewerId` may see the question (design §9 "Moderation"): hidden content only by its
 * author; a deleted question only while it has visible answers (the "[deleted]" placeholder).
 */
export function canSeeQuestion(question: QuestionRecord, viewerId: string): boolean {
  if (question.moderationStatus === 'HIDDEN' && question.authorId !== viewerId) return false;
  return question.deletedAt === null || question.answerCount > 0;
}

/** A question that can still change: seen by the viewer and not deleted. */
export function isLiveFor(question: QuestionRecord, viewerId: string): boolean {
  return question.deletedAt === null && canSeeQuestion(question, viewerId);
}

/** New answers and votes need a VISIBLE, non-deleted question. */
export function acceptsAnswers(question: QuestionRecord): boolean {
  return question.deletedAt === null && question.moderationStatus === 'VISIBLE';
}

/** Deleted answers are gone for everyone; hidden ones remain visible to their author only. */
export function canSeeAnswer(answer: AnswerRecord, viewerId: string): boolean {
  return (
    answer.deletedAt === null &&
    (answer.moderationStatus === 'VISIBLE' || answer.authorId === viewerId)
  );
}

/** May accept or un-accept an answer: the question author or the course owner. */
export function canResolve(
  question: QuestionRecord,
  viewerId: string,
  courseOwnerId: string,
): boolean {
  return question.authorId === viewerId || courseOwnerId === viewerId;
}
