import { z } from 'zod';
import {
  MediaFailureCodeSchema,
  MediaPurposeSchema,
  MediaRenditionNameSchema,
} from '../http/media';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/**
 * Aggregate type and Kafka topic of every media asset event; aggregateId = assetId.
 * Names are media-generic (not `LectureVideo*`): media does not know about lectures (§7).
 */
export const MEDIA_ASSET_AGGREGATE = 'media.asset';
const options = { aggregateType: MEDIA_ASSET_AGGREGATE } as const;

/** Written in the CompleteUpload transaction; the worker enqueues the transcode job. */
export const MediaUploaded = defineEvent(
  'MediaUploaded',
  1,
  z.object({
    assetId: eventId(),
    ownerId: eventId(),
    purpose: MediaPurposeSchema,
    declaredContentType: z.string().min(1).max(127),
    sizeBytes: z.number().int().min(1),
    uploadedAt: eventTimestamp(),
  }),
  options,
);

/**
 * Written by the transcoder with the asset READY. `durationMs` is set for videos (mirrors
 * the `assets` CHECK); `width`/`height` are null for LECTURE_RESOURCE (PDF/ZIP), and
 * `renditions` is then empty.
 */
export const MediaReady = defineEvent(
  'MediaReady',
  1,
  z
    .object({
      assetId: eventId(),
      ownerId: eventId(),
      purpose: MediaPurposeSchema,
      durationMs: z.number().int().min(0).nullable(),
      width: z.number().int().min(1).nullable(),
      height: z.number().int().min(1).nullable(),
      renditions: z.array(MediaRenditionNameSchema),
      readyAt: eventTimestamp(),
    })
    .refine((p) => p.purpose !== 'LECTURE_VIDEO' || p.durationMs !== null, {
      message: 'A ready video must carry durationMs',
      path: ['durationMs'],
    })
    .refine((p) => p.purpose === 'LECTURE_RESOURCE' || (p.width !== null && p.height !== null), {
      message: 'A ready video or image must carry width and height',
      path: ['width'],
    }),
  options,
);

/** Consumed by the processing-failed mailer. `attempts` is 0 for upload-time failures. */
export const MediaFailed = defineEvent(
  'MediaFailed',
  1,
  z.object({
    assetId: eventId(),
    ownerId: eventId(),
    purpose: MediaPurposeSchema,
    failureCode: MediaFailureCodeSchema,
    attempts: z.number().int().min(0),
    failedAt: eventTimestamp(),
  }),
  options,
);

export const MediaPurged = defineEvent(
  'MediaPurged',
  1,
  z.object({
    assetId: eventId(),
    ownerId: eventId(),
    purgedAt: eventTimestamp(),
  }),
  options,
);

/** Every v1 event on the `media.asset` topic. */
export const MEDIA_ASSET_EVENTS = [MediaUploaded, MediaReady, MediaFailed, MediaPurged] as const;

export type MediaUploadedPayload = EventPayload<typeof MediaUploaded>;
export type MediaReadyPayload = EventPayload<typeof MediaReady>;
export type MediaFailedPayload = EventPayload<typeof MediaFailed>;
export type MediaPurgedPayload = EventPayload<typeof MediaPurged>;
