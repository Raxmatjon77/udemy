import {
  ENGAGEMENT_COURSE_REVIEW_AGGREGATE,
  type EventEnvelope,
  ReviewEdited,
  ReviewPosted,
  ReviewReplyPosted,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { excerptOfPlainText } from '../delivery/text';
import { NotificationContextReader } from '../persistence/notification-context.reader';

/*
 * `notifications.review-notifier` (design §5 worker table): new reviews and rating changes to the
 * instructor, replies to the reviewer. Consumer names `notifications.review-notifier.<event>`.
 * Review and reply bodies are plain text (D22), quoted as an excerpt.
 */

/** Shared by ReviewPosted and ReviewEdited: REVIEW_NEW to the course owner. */
async function notifyOwner(
  reader: NotificationContextReader,
  deliverer: NotificationDeliverer,
  trx: Transaction<DB>,
  context: HandlerContext,
  input: { eventId: string; reviewId: string; courseId: string; previousRating: number | null },
): Promise<void> {
  const course = await reader.course(trx, input.courseId);
  const review = await reader.review(trx, input.reviewId);
  if (course === null || review === null || !review.published) return;
  if (review.userId === course.ownerId) return;
  await deliverer.deliver(trx, context, {
    recipientId: course.ownerId,
    app: 'INSTRUCTOR',
    kind: 'REVIEW_NEW',
    subjectId: review.id,
    sourceEventId: input.eventId,
    payload: {
      reviewId: review.id,
      courseId: course.courseId,
      courseTitle: course.title,
      rating: review.rating,
      previousRating: input.previousRating,
      reviewerName: await reader.displayName(trx, review.userId),
      excerpt: excerptOfPlainText(review.body),
      redacted: false,
    },
  });
}

/** `ReviewPosted` -> REVIEW_NEW to the instructor. */
@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewPosted.type, {
  consumerName: 'notifications.review-notifier.review-posted',
})
export class ReviewPostedNotifier implements EventHandlerContract {
  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(ReviewPosted, envelope);
    await notifyOwner(this.reader, this.deliverer, trx, context, {
      eventId: envelope.eventId,
      reviewId: event.reviewId,
      courseId: event.courseId,
      previousRating: null,
    });
  }
}

/** `ReviewEdited` -> REVIEW_NEW (with `previousRating`) only when the rating changed. */
@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewEdited.type, {
  consumerName: 'notifications.review-notifier.review-edited',
})
export class ReviewEditedNotifier implements EventHandlerContract {
  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(ReviewEdited, envelope);
    if (event.rating === event.previousRating) return;
    await notifyOwner(this.reader, this.deliverer, trx, context, {
      eventId: envelope.eventId,
      reviewId: event.reviewId,
      courseId: event.courseId,
      previousRating: event.previousRating,
    });
  }
}

/** `ReviewReplyPosted` -> REVIEW_REPLY to the reviewer (subject: the live reply). */
@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewReplyPosted.type, {
  consumerName: 'notifications.review-notifier.reply-posted',
})
export class ReviewReplyPostedNotifier implements EventHandlerContract {
  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(ReviewReplyPosted, envelope);
    const review = await this.reader.review(trx, event.reviewId);
    const reply = await this.reader.liveReply(trx, event.reviewId);
    const course = await this.reader.course(trx, event.courseId);
    if (review === null || reply === null || course === null || !reply.visible) return;
    if (review.deleted || review.userId === event.authorId) return;
    await this.deliverer.deliver(trx, context, {
      recipientId: review.userId,
      app: 'STUDENT',
      kind: 'REVIEW_REPLY',
      subjectId: reply.id,
      sourceEventId: envelope.eventId,
      payload: {
        reviewId: review.id,
        courseId: course.courseId,
        courseTitle: course.title,
        instructorName: await this.reader.displayName(trx, event.authorId),
        excerpt: excerptOfPlainText(reply.body),
        redacted: false,
      },
    });
  }
}
