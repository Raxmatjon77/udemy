import { Logger } from '@nestjs/common';
import {
  type EventEnvelope,
  MEDIA_ASSET_AGGREGATE,
  MediaFailed,
  MediaReady,
  type MediaPurpose,
  realtimeUserRoom,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { RealtimeEmitter } from '../../shared/realtime';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { clampText } from '../delivery/text';
import { NotificationContextReader } from '../persistence/notification-context.reader';

/*
 * `notifications.media-notifier` (design §5 worker table): MEDIA_READY / MEDIA_FAILED to the
 * asset owner's instructor bell (COURSE_BUILDING; in-app only, the Phase 2 failure mail is
 * unchanged), plus a `media.changed {assetId}` hint after commit so the course builder refetches
 * the asset without polling. The hint goes out even when the in-app preference is off.
 */

interface NotifierDeps {
  readonly reader: NotificationContextReader;
  readonly deliverer: NotificationDeliverer;
  readonly realtime: RealtimeEmitter;
}

async function notifyOwner(
  deps: NotifierDeps,
  trx: Transaction<DB>,
  context: HandlerContext,
  input:
    | {
        kind: 'MEDIA_READY';
        eventId: string;
        assetId: string;
        ownerId: string;
        purpose: MediaPurpose;
      }
    | {
        kind: 'MEDIA_FAILED';
        eventId: string;
        assetId: string;
        ownerId: string;
        purpose: MediaPurpose;
        failureCode: string;
      },
): Promise<void> {
  const filename = await deps.reader.assetFilename(trx, input.assetId);
  const base = {
    assetId: input.assetId,
    purpose: input.purpose,
    filename: filename === null ? null : clampText(filename, 255),
  };
  const common = {
    recipientId: input.ownerId,
    app: 'INSTRUCTOR' as const,
    subjectId: input.assetId,
    sourceEventId: input.eventId,
  };
  if (input.kind === 'MEDIA_READY') {
    await deps.deliverer.deliver(trx, context, { ...common, kind: 'MEDIA_READY', payload: base });
  } else {
    await deps.deliverer.deliver(trx, context, {
      ...common,
      kind: 'MEDIA_FAILED',
      payload: { ...base, failureCode: input.failureCode },
    });
  }
  context.afterCommit(() =>
    deps.realtime.emit(realtimeUserRoom(input.ownerId, 'INSTRUCTOR'), 'media.changed', {
      assetId: input.assetId,
    }),
  );
}

@EventHandler(MEDIA_ASSET_AGGREGATE, MediaReady.type, {
  consumerName: 'notifications.media-notifier.media-ready',
})
export class MediaReadyNotifier implements EventHandlerContract {
  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
    private readonly realtime: RealtimeEmitter,
  ) {}

  private deps(): NotifierDeps {
    return { reader: this.reader, deliverer: this.deliverer, realtime: this.realtime };
  }

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(MediaReady, envelope);
    await notifyOwner(this.deps(), trx, context, {
      kind: 'MEDIA_READY',
      eventId: envelope.eventId,
      assetId: event.assetId,
      ownerId: event.ownerId,
      purpose: event.purpose,
    });
  }
}

@EventHandler(MEDIA_ASSET_AGGREGATE, MediaFailed.type, {
  consumerName: 'notifications.media-notifier.media-failed',
})
export class MediaFailedNotifier implements EventHandlerContract {
  private readonly logger = new Logger(MediaFailedNotifier.name);

  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
    private readonly realtime: RealtimeEmitter,
  ) {}

  private deps(): NotifierDeps {
    return { reader: this.reader, deliverer: this.deliverer, realtime: this.realtime };
  }

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(MediaFailed, envelope);
    this.logger.debug({ assetId: event.assetId }, 'Media failed; notifying the owner');
    await notifyOwner(this.deps(), trx, context, {
      kind: 'MEDIA_FAILED',
      eventId: envelope.eventId,
      assetId: event.assetId,
      ownerId: event.ownerId,
      purpose: event.purpose,
      failureCode: event.failureCode,
    });
  }
}
