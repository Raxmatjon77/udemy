import { Module } from '@nestjs/common';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { ProcessingFailedMailerHandler } from './handlers/processing-failed-mailer.handler';
import { TranscodeEnqueuerHandler } from './handlers/transcode-enqueuer.handler';
import { MediaLinks } from './mail/media-links';
import { FailedAssetContextReader } from './persistence/failed-asset-context.reader';
import { TranscodeJobQueue } from './persistence/transcode-job-queue';

/**
 * Consumers of the `media.asset` topic (design §7): the transcode enqueuer (`MediaUploaded`) and
 * the processing-failed mailer (`MediaFailed`). `MediaReady` and `MediaPurged` have no Phase 2
 * consumer. The @EventHandler providers are discovered by the messaging registry, which also
 * ensures `media.asset` and `media.asset.dlq` at startup; nothing is exported.
 */
@Module({
  providers: [
    TranscodeJobQueue,
    FailedAssetContextReader,
    UserContactReader,
    MediaLinks,
    TranscodeEnqueuerHandler,
    ProcessingFailedMailerHandler,
  ],
})
export class MediaEventsModule {}
