import { Injectable } from '@nestjs/common';
import {
  AnswerHidden,
  AnswerRestored,
  type ModerationSubjectType,
  QuestionHidden,
  QuestionReopened,
  QuestionRestored,
  ReviewHidden,
  ReviewReplyHidden,
  ReviewReplyRestored,
  ReviewRestored,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { EngagementEventPublisher } from './ports/engagement-event.publisher';

/** What the moderation events of a subject carry (ids only, design §7). */
export interface ModeratedSubjectRef {
  readonly type: ModerationSubjectType;
  /** The subject row id. */
  readonly subjectId: string;
  readonly courseId: string;
  readonly authorId: string;
  /** Replies: their review. */
  readonly reviewId: string | null;
  /** Answers: their question. */
  readonly questionId: string | null;
}

function required(value: string | null, what: string): string {
  if (value === null) throw new Error(`a moderation subject always carries its ${what}`);
  return value;
}

/**
 * The `…Hidden` / `…Restored` events of every moderated subject type, written in the
 * moderation transaction (outbox, keyed by courseId). Hiding the accepted answer also clears it
 * in the DB (`answers_sync_question`), which reopens the question: `QuestionReopened` follows.
 */
@Injectable()
export class ModerationEvents {
  constructor(private readonly events: EngagementEventPublisher) {}

  async hidden(
    trx: Transaction<DB>,
    s: ModeratedSubjectRef,
    actorId: string | null,
    at: Date,
    options: { readonly wasAcceptedAnswer: boolean },
  ): Promise<void> {
    const hiddenAt = at.toISOString();
    switch (s.type) {
      case 'REVIEW':
        await this.events.publish(trx, ReviewHidden, {
          reviewId: s.subjectId,
          courseId: s.courseId,
          actorId,
          hiddenAt,
        });
        return;
      case 'REVIEW_REPLY':
        await this.events.publish(trx, ReviewReplyHidden, {
          reviewId: required(s.reviewId, 'review id'),
          courseId: s.courseId,
          authorId: s.authorId,
          actorId,
          hiddenAt,
        });
        return;
      case 'QUESTION':
        await this.events.publish(trx, QuestionHidden, {
          questionId: s.subjectId,
          courseId: s.courseId,
          actorId,
          hiddenAt,
        });
        return;
      case 'ANSWER': {
        const questionId = required(s.questionId, 'question id');
        await this.events.publish(trx, AnswerHidden, {
          answerId: s.subjectId,
          questionId,
          courseId: s.courseId,
          actorId,
          hiddenAt,
        });
        if (options.wasAcceptedAnswer) {
          await this.events.publish(trx, QuestionReopened, {
            questionId,
            courseId: s.courseId,
            answerId: s.subjectId,
            actorId,
            reopenedAt: hiddenAt,
          });
        }
        return;
      }
    }
  }

  async restored(
    trx: Transaction<DB>,
    s: ModeratedSubjectRef,
    actorId: string,
    at: Date,
  ): Promise<void> {
    const restoredAt = at.toISOString();
    switch (s.type) {
      case 'REVIEW':
        await this.events.publish(trx, ReviewRestored, {
          reviewId: s.subjectId,
          courseId: s.courseId,
          actorId,
          restoredAt,
        });
        return;
      case 'REVIEW_REPLY':
        await this.events.publish(trx, ReviewReplyRestored, {
          reviewId: required(s.reviewId, 'review id'),
          courseId: s.courseId,
          authorId: s.authorId,
          actorId,
          restoredAt,
        });
        return;
      case 'QUESTION':
        await this.events.publish(trx, QuestionRestored, {
          questionId: s.subjectId,
          courseId: s.courseId,
          actorId,
          restoredAt,
        });
        return;
      case 'ANSWER':
        await this.events.publish(trx, AnswerRestored, {
          answerId: s.subjectId,
          questionId: required(s.questionId, 'question id'),
          courseId: s.courseId,
          actorId,
          restoredAt,
        });
        return;
    }
  }
}
