import { Logger } from '@nestjs/common';
import {
  AnswerPosted,
  ENGAGEMENT_QUESTION_AGGREGATE,
  type EventEnvelope,
  QuestionPosted,
  QuestionResolved,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { excerptOfMarkdown } from '../delivery/text';
import {
  appOfParticipant,
  NotificationContextReader,
} from '../persistence/notification-context.reader';

/*
 * `notifications.qa-notifier` (design §5 worker table, D14): one handler per event type, so the
 * consumer names are pinned as `notifications.qa-notifier.<event>`. Texts are read at handling
 * time (events carry ids only); content that is already hidden or deleted is not announced.
 * Idempotent: the claim in outbox.processed_events, then UNIQUE (user, kind, source event).
 */

/** `QuestionPosted` -> QA_NEW_QUESTION to the course owner (INSTRUCTOR), unless they asked it. */
@EventHandler(ENGAGEMENT_QUESTION_AGGREGATE, QuestionPosted.type, {
  consumerName: 'notifications.qa-notifier.question-posted',
})
export class QaQuestionPostedNotifier implements EventHandlerContract {
  private readonly logger = new Logger(QaQuestionPostedNotifier.name);

  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(QuestionPosted, envelope);
    const course = await this.reader.course(trx, event.courseId);
    if (course === null || course.ownerId === event.authorId) return;
    const question = await this.reader.question(trx, event.questionId);
    if (question === null || !question.visible) {
      this.logger.log({ questionId: event.questionId }, 'Question gone or hidden; no notification');
      return;
    }
    await this.deliverer.deliver(trx, context, {
      recipientId: course.ownerId,
      app: 'INSTRUCTOR',
      kind: 'QA_NEW_QUESTION',
      subjectId: question.id,
      sourceEventId: envelope.eventId,
      payload: {
        questionId: question.id,
        courseId: course.courseId,
        courseTitle: course.title,
        lectureId: event.lectureId,
        questionTitle: question.title,
        authorName: await this.reader.displayName(trx, event.authorId),
        redacted: false,
      },
    });
  }
}

/**
 * `AnswerPosted` -> QA_NEW_ANSWER to the question author unless they wrote the answer; the
 * "instructor answered" flag comes from the event. The author's bell: INSTRUCTOR when they own
 * the course, else STUDENT.
 */
@EventHandler(ENGAGEMENT_QUESTION_AGGREGATE, AnswerPosted.type, {
  consumerName: 'notifications.qa-notifier.answer-posted',
})
export class QaAnswerPostedNotifier implements EventHandlerContract {
  private readonly logger = new Logger(QaAnswerPostedNotifier.name);

  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(AnswerPosted, envelope);
    if (event.authorId === event.questionAuthorId) return;
    const course = await this.reader.course(trx, event.courseId);
    const question = await this.reader.question(trx, event.questionId);
    const answer = await this.reader.answer(trx, event.answerId);
    if (course === null || question === null || answer === null) return;
    if (!question.visible || !answer.visible) {
      this.logger.log({ answerId: event.answerId }, 'Answer or question hidden; no notification');
      return;
    }
    await this.deliverer.deliver(trx, context, {
      recipientId: event.questionAuthorId,
      app: appOfParticipant(event.questionAuthorId, course.ownerId),
      kind: 'QA_NEW_ANSWER',
      subjectId: answer.id,
      sourceEventId: envelope.eventId,
      payload: {
        questionId: question.id,
        answerId: answer.id,
        courseId: course.courseId,
        courseTitle: course.title,
        questionTitle: question.title,
        authorName: await this.reader.displayName(trx, event.authorId),
        byInstructor: event.byCourseOwner,
        excerpt: excerptOfMarkdown(answer.bodyMd),
        redacted: false,
      },
    });
  }
}

/**
 * `QuestionResolved` -> QA_RESOLVED to the author of the accepted answer (contracts
 * `QaResolvedPayloadSchema`), unless they accepted it themselves.
 */
@EventHandler(ENGAGEMENT_QUESTION_AGGREGATE, QuestionResolved.type, {
  consumerName: 'notifications.qa-notifier.question-resolved',
})
export class QaQuestionResolvedNotifier implements EventHandlerContract {
  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(QuestionResolved, envelope);
    const answer = await this.reader.answer(trx, event.answerId);
    if (answer === null || !answer.visible || answer.authorId === event.actorId) return;
    const course = await this.reader.course(trx, event.courseId);
    const question = await this.reader.question(trx, event.questionId);
    if (course === null || question === null || !question.visible) return;
    await this.deliverer.deliver(trx, context, {
      recipientId: answer.authorId,
      app: appOfParticipant(answer.authorId, course.ownerId),
      kind: 'QA_RESOLVED',
      subjectId: question.id,
      sourceEventId: envelope.eventId,
      payload: {
        questionId: question.id,
        answerId: answer.id,
        courseId: course.courseId,
        courseTitle: course.title,
        questionTitle: question.title,
        redacted: false,
      },
    });
  }
}
