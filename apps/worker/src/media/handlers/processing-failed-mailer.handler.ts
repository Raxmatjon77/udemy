import { Logger } from '@nestjs/common';
import { type EventEnvelope, MEDIA_ASSET_AGGREGATE, MediaFailed } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { MediaLinks } from '../mail/media-links';
import { processingFailedMail } from '../mail/media-mail.templates';
import { FailedAssetContextReader } from '../persistence/failed-asset-context.reader';

/**
 * `MediaFailed` -> "processing failed" mail to the asset owner (design §7), with the
 * human-readable failure label from contracts and a link to the course builder of the lecture or
 * course that uses the asset ("My courses" if it is not attached). Owner address and the
 * lecture/course titles are read at handling time.
 */
@EventHandler(MEDIA_ASSET_AGGREGATE, MediaFailed.type, {
  consumerName: 'media.processing-failed-mailer',
})
export class ProcessingFailedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(ProcessingFailedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly assets: FailedAssetContextReader,
    private readonly mailer: Mailer,
    private readonly links: MediaLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(MediaFailed, envelope);
    const owner = await this.contacts.find(trx, event.ownerId);
    if (owner === null) {
      this.logger.warn(
        { assetId: event.assetId, ownerId: event.ownerId },
        'MediaFailed for an unknown owner; no mail',
      );
      return;
    }
    const context = await this.assets.find(trx, event.assetId);
    await this.mailer.send({
      to: owner.email,
      ...processingFailedMail({
        displayName: owner.displayName,
        purpose: event.purpose,
        failureCode: event.failureCode,
        originalFilename: context.originalFilename,
        placement: context.placement,
        actionUrl:
          context.placement === null
            ? this.links.myCourses()
            : this.links.courseBuilder(context.placement.courseId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
