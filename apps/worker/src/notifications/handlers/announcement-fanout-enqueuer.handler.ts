import { Logger } from '@nestjs/common';
import {
  AnnouncementPosted,
  ENGAGEMENT_ANNOUNCEMENT_AGGREGATE,
  type EventEnvelope,
} from '@udemy/contracts';
import { type DB, enqueueAnnouncementFanout, type Transaction } from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';

/**
 * `notifications.announcement-fanout-enqueuer` (design D18, P5-D11): `AnnouncementPosted` ->
 * one `notifications.fanout_jobs` row, `ON CONFLICT (source_event_id) DO NOTHING`. A course with
 * 100 k students must not fan out inside one Kafka handler transaction: the leased FanoutJob does
 * it in batches of 1000 with a resumable cursor.
 */
@EventHandler(ENGAGEMENT_ANNOUNCEMENT_AGGREGATE, AnnouncementPosted.type, {
  consumerName: 'notifications.announcement-fanout-enqueuer',
})
export class AnnouncementFanoutEnqueuer implements EventHandlerContract {
  private readonly logger = new Logger(AnnouncementFanoutEnqueuer.name);

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(AnnouncementPosted, envelope);
    const created = await enqueueAnnouncementFanout(trx, {
      sourceEventId: envelope.eventId,
      courseId: event.courseId,
      announcementId: event.announcementId,
      sendEmail: event.sendEmail,
    });
    this.logger.log(
      { announcementId: event.announcementId, courseId: event.courseId, created },
      created ? 'Announcement fan-out queued' : 'Announcement fan-out already queued',
    );
  }
}
