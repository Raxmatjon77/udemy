import { Injectable, Logger } from '@nestjs/common';
import {
  AnnouncementDeleted,
  AnswerHidden,
  ENGAGEMENT_ANNOUNCEMENT_AGGREGATE,
  ENGAGEMENT_COURSE_REVIEW_AGGREGATE,
  ENGAGEMENT_QUESTION_AGGREGATE,
  type EventEnvelope,
  QuestionHidden,
  ReviewHidden,
  ReviewReplyHidden,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { AdminRecipientsReader } from '../../shared/mail/admin-recipients.reader';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { NotificationStore } from '../delivery/notification.store';
import {
  appOfParticipant,
  NotificationContextReader,
} from '../persistence/notification-context.reader';

/*
 * `notifications.moderation-notifier` (design §5 worker table, D13/D14):
 *
 * - `*Hidden`: redact every notification that quotes the hidden subject (texts -> null,
 *   `redacted: true`, once), tell the author (CONTENT_HIDDEN, MODERATION category: locked, so
 *   in-app and e-mail always), and for an AUTO hide (actorId null: the report threshold) tell
 *   every admin (MODERATION_QUEUE).
 * - `AnnouncementDeleted`: redact the announcement's notifications (delete-only, no notices).
 *
 * A hidden question also redacts the QA_NEW_ANSWER rows of its answers (they quote its title).
 * Redaction is never undone by a restore: a row is redacted once (`notifications_immutable_ck`).
 * Consumer names: `notifications.moderation-notifier.<event>`.
 */

type HiddenSubjectType = 'REVIEW' | 'REVIEW_REPLY' | 'QUESTION' | 'ANSWER';

interface HiddenSubject {
  readonly subjectType: HiddenSubjectType;
  readonly subjectId: string;
  readonly courseId: string;
  readonly authorId: string;
  /** null = AUTO (the report threshold). */
  readonly actorId: string | null;
}

/** The author notice and the admin queue notice of one hide. */
@Injectable()
export class HiddenContentNotices {
  private readonly logger = new Logger(HiddenContentNotices.name);

  constructor(
    private readonly reader: NotificationContextReader,
    private readonly admins: AdminRecipientsReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async send(
    trx: Transaction<DB>,
    context: HandlerContext,
    envelope: EventEnvelope,
    subject: HiddenSubject,
  ): Promise<void> {
    const course = await this.reader.course(trx, subject.courseId);
    if (course === null) {
      this.logger.warn({ courseId: subject.courseId }, 'Hidden content of an unknown course');
      return;
    }
    if (subject.actorId !== subject.authorId) {
      await this.deliverer.deliver(trx, context, {
        recipientId: subject.authorId,
        app: appOfParticipant(subject.authorId, course.ownerId),
        kind: 'CONTENT_HIDDEN',
        subjectId: null,
        sourceEventId: envelope.eventId,
        payload: {
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          courseId: course.courseId,
          courseTitle: course.title,
        },
      });
    }
    if (subject.actorId !== null) return;
    const openReportCount = Math.max(
      1,
      await this.reader.reportCount(trx, subject.subjectType, subject.subjectId),
    );
    for (const admin of await this.admins.list(trx)) {
      await this.deliverer.deliver(trx, context, {
        recipientId: admin.userId,
        app: 'ADMIN',
        kind: 'MODERATION_QUEUE',
        subjectId: null,
        sourceEventId: envelope.eventId,
        payload: {
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          courseId: course.courseId,
          openReportCount,
        },
      });
    }
  }
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewHidden.type, {
  consumerName: 'notifications.moderation-notifier.review-hidden',
})
export class ReviewHiddenNotifier implements EventHandlerContract {
  constructor(
    private readonly store: NotificationStore,
    private readonly reader: NotificationContextReader,
    private readonly notices: HiddenContentNotices,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(ReviewHidden, envelope);
    await this.store.redactSubjects(trx, 'REVIEW', [event.reviewId]);
    const review = await this.reader.review(trx, event.reviewId);
    if (review === null) return;
    await this.notices.send(trx, context, envelope, {
      subjectType: 'REVIEW',
      subjectId: review.id,
      courseId: event.courseId,
      authorId: review.userId,
      actorId: event.actorId,
    });
  }
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewReplyHidden.type, {
  consumerName: 'notifications.moderation-notifier.review-reply-hidden',
})
export class ReviewReplyHiddenNotifier implements EventHandlerContract {
  constructor(
    private readonly store: NotificationStore,
    private readonly reader: NotificationContextReader,
    private readonly notices: HiddenContentNotices,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(ReviewReplyHidden, envelope);
    // The event names the review; every reply of it (one live at a time) is redacted.
    await this.store.redactSubjects(
      trx,
      'REVIEW_REPLY',
      await this.reader.replyIdsOf(trx, event.reviewId),
    );
    const reply = await this.reader.liveReply(trx, event.reviewId);
    if (reply === null) return;
    await this.notices.send(trx, context, envelope, {
      subjectType: 'REVIEW_REPLY',
      subjectId: reply.id,
      courseId: event.courseId,
      authorId: event.authorId,
      actorId: event.actorId,
    });
  }
}

@EventHandler(ENGAGEMENT_QUESTION_AGGREGATE, QuestionHidden.type, {
  consumerName: 'notifications.moderation-notifier.question-hidden',
})
export class QuestionHiddenNotifier implements EventHandlerContract {
  constructor(
    private readonly store: NotificationStore,
    private readonly reader: NotificationContextReader,
    private readonly notices: HiddenContentNotices,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(QuestionHidden, envelope);
    await this.store.redactSubjects(trx, 'QUESTION', [event.questionId]);
    await this.store.redactSubjects(
      trx,
      'ANSWER',
      await this.reader.answerIdsOf(trx, event.questionId),
    );
    const question = await this.reader.question(trx, event.questionId);
    if (question === null) return;
    await this.notices.send(trx, context, envelope, {
      subjectType: 'QUESTION',
      subjectId: question.id,
      courseId: event.courseId,
      authorId: question.authorId,
      actorId: event.actorId,
    });
  }
}

@EventHandler(ENGAGEMENT_QUESTION_AGGREGATE, AnswerHidden.type, {
  consumerName: 'notifications.moderation-notifier.answer-hidden',
})
export class AnswerHiddenNotifier implements EventHandlerContract {
  constructor(
    private readonly store: NotificationStore,
    private readonly reader: NotificationContextReader,
    private readonly notices: HiddenContentNotices,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(AnswerHidden, envelope);
    await this.store.redactSubjects(trx, 'ANSWER', [event.answerId]);
    const answer = await this.reader.answer(trx, event.answerId);
    if (answer === null) return;
    await this.notices.send(trx, context, envelope, {
      subjectType: 'ANSWER',
      subjectId: answer.id,
      courseId: event.courseId,
      authorId: answer.authorId,
      actorId: event.actorId,
    });
  }
}

/** `AnnouncementDeleted` -> redact its ANNOUNCEMENT rows (the FanoutJob stops on its own). */
@EventHandler(ENGAGEMENT_ANNOUNCEMENT_AGGREGATE, AnnouncementDeleted.type, {
  consumerName: 'notifications.moderation-notifier.announcement-deleted',
})
export class AnnouncementDeletedNotifier implements EventHandlerContract {
  private readonly logger = new Logger(AnnouncementDeletedNotifier.name);

  constructor(private readonly store: NotificationStore) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(AnnouncementDeleted, envelope);
    const redacted = await this.store.redactSubjects(trx, 'ANNOUNCEMENT', [event.announcementId]);
    this.logger.log(
      { announcementId: event.announcementId, redacted: redacted.length },
      'Announcement notifications redacted',
    );
  }
}
