import { describe, expect, it } from 'vitest';
import {
  CATALOG_COURSE_AGGREGATE,
  CATALOG_COURSE_EVENTS,
  CourseArchived,
  CourseCreated,
  CourseDeleted,
  CoursePublished,
  CourseRejected,
  CourseRestored,
  CourseSubmissionWithdrawn,
  CourseSubmittedForReview,
} from './catalog';
import type { EventDefinition } from './define-event';
import {
  MEDIA_ASSET_AGGREGATE,
  MEDIA_ASSET_EVENTS,
  MediaFailed,
  MediaPurged,
  MediaReady,
  MediaUploaded,
} from './media';

const courseId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const ownerId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c02';
const adminId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c03';
const revisionId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c04';
const assetId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c05';
const at = '2026-10-10T12:00:00.000Z';
const title = 'Complete TypeScript';
const reason = 'The curriculum contains copyrighted material.';

/** One valid sample payload per event; the keys double as the full event list. */
const samples = new Map<EventDefinition, Record<string, unknown>>([
  [CourseCreated, { courseId, ownerId, title, createdAt: at }],
  [
    CourseSubmittedForReview,
    { courseId, revisionId, revisionNo: 1, ownerId, kind: 'INITIAL', title, submittedAt: at },
  ],
  [
    CourseSubmissionWithdrawn,
    { courseId, revisionId, ownerId, actorId: ownerId, cause: 'OWNER', withdrawnAt: at },
  ],
  [
    CoursePublished,
    {
      courseId,
      revisionId,
      revisionNo: 2,
      ownerId,
      slug: 'complete-typescript',
      kind: 'UPDATE',
      decidedBy: adminId,
      publishedAt: at,
    },
  ],
  [
    CourseRejected,
    { courseId, revisionId, ownerId, kind: 'INITIAL', decidedBy: adminId, reason, rejectedAt: at },
  ],
  [CourseArchived, { courseId, ownerId, actorId: adminId, byAdmin: true, reason, archivedAt: at }],
  [CourseRestored, { courseId, ownerId, actorId: ownerId, restoredAt: at }],
  [CourseDeleted, { courseId, ownerId, deletedAt: at }],
  [
    MediaUploaded,
    {
      assetId,
      ownerId,
      purpose: 'LECTURE_VIDEO',
      declaredContentType: 'video/mp4',
      sizeBytes: 3 * 1024 ** 3,
      uploadedAt: at,
    },
  ],
  [
    MediaReady,
    {
      assetId,
      ownerId,
      purpose: 'LECTURE_VIDEO',
      durationMs: 305_000,
      width: 1280,
      height: 720,
      renditions: ['360p', '720p', 'poster', 'sprite'],
      readyAt: at,
    },
  ],
  [
    MediaFailed,
    {
      assetId,
      ownerId,
      purpose: 'COURSE_THUMBNAIL',
      failureCode: 'INVALID_MEDIA',
      attempts: 1,
      failedAt: at,
    },
  ],
  [MediaPurged, { assetId, ownerId, purgedAt: at }],
]);

const allEvents: readonly EventDefinition[] = [...CATALOG_COURSE_EVENTS, ...MEDIA_ASSET_EVENTS];
const cases = [...samples].map(([event, payload]) => ({ name: event.type, event, payload }));

describe('Phase 2 events', () => {
  it('has a sample for every event in the topic lists', () => {
    expect(new Set(allEvents)).toEqual(new Set(samples.keys()));
    expect(new Set(allEvents.map((e) => e.qualifiedType)).size).toBe(allEvents.length);
    expect(CATALOG_COURSE_EVENTS.map((e) => e.type)).toEqual([
      'CourseCreated',
      'CourseSubmittedForReview',
      'CourseSubmissionWithdrawn',
      'CoursePublished',
      'CourseRejected',
      'CourseArchived',
      'CourseRestored',
      'CourseDeleted',
    ]);
    expect(MEDIA_ASSET_EVENTS.map((e) => e.type)).toEqual([
      'MediaUploaded',
      'MediaReady',
      'MediaFailed',
      'MediaPurged',
    ]);
  });

  it.each(cases)('$name round-trips through JSON', ({ event, payload }) => {
    const parsed = event.parsePayload(JSON.parse(JSON.stringify(payload)));
    expect(parsed).toEqual(payload);
    expect(event.parsePayload(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(event.version).toBe(1);
    expect(event.qualifiedType).toBe(`${event.type}.v1`);
  });

  it.each(cases)('$name rejects a missing field and a non-ISO timestamp', ({ event, payload }) => {
    for (const key of Object.keys(payload)) {
      const missing = { ...payload };
      delete missing[key];
      expect(event.safeParsePayload(missing).success, key).toBe(false);
    }
    const timestampKey = Object.keys(payload).find((key) => key.endsWith('At'))!;
    expect(event.safeParsePayload({ ...payload, [timestampKey]: '10/10/2026' }).success).toBe(
      false,
    );
  });

  it.each(cases)('$name strips unknown fields', ({ event, payload }) => {
    const parsed = event.parsePayload({ ...payload, sourceKey: 'uploads/x', url: 'https://s3' });
    expect(parsed).not.toHaveProperty('sourceKey');
    expect(parsed).not.toHaveProperty('url');
  });

  it('routes each event to its topic', () => {
    for (const e of CATALOG_COURSE_EVENTS) expect(e.aggregateType).toBe(CATALOG_COURSE_AGGREGATE);
    for (const e of MEDIA_ASSET_EVENTS) expect(e.aggregateType).toBe(MEDIA_ASSET_AGGREGATE);
    expect([CATALOG_COURSE_AGGREGATE, MEDIA_ASSET_AGGREGATE]).toEqual([
      'catalog.course',
      'media.asset',
    ]);
  });

  it('enforces the enums', () => {
    const submitted = samples.get(CourseSubmittedForReview)!;
    expect(CourseSubmittedForReview.safeParsePayload({ ...submitted, kind: 'MINOR' }).success).toBe(
      false,
    );
    expect(CourseSubmittedForReview.safeParsePayload({ ...submitted, revisionNo: 0 }).success).toBe(
      false,
    );
    const withdrawn = samples.get(CourseSubmissionWithdrawn)!;
    expect(
      CourseSubmissionWithdrawn.safeParsePayload({ ...withdrawn, cause: 'ARCHIVED' }).success,
    ).toBe(true);
    expect(
      CourseSubmissionWithdrawn.safeParsePayload({ ...withdrawn, cause: 'ADMIN' }).success,
    ).toBe(false);
    const failed = samples.get(MediaFailed)!;
    expect(MediaFailed.safeParsePayload({ ...failed, failureCode: 'OOM' }).success).toBe(false);
    expect(MediaFailed.safeParsePayload({ ...failed, attempts: 0 }).success).toBe(true);
    expect(MediaFailed.safeParsePayload({ ...failed, purpose: 'USER_AVATAR' }).success).toBe(false);
  });

  it('CourseRejected bounds the reason to 10–2000', () => {
    const base = samples.get(CourseRejected)!;
    expect(CourseRejected.safeParsePayload({ ...base, reason: 'r'.repeat(2000) }).success).toBe(
      true,
    );
    expect(CourseRejected.safeParsePayload({ ...base, reason: 'too short' }).success).toBe(false);
    expect(CourseRejected.safeParsePayload({ ...base, reason: 'r'.repeat(2001) }).success).toBe(
      false,
    );
  });

  it('CourseArchived requires a reason for an admin takedown only', () => {
    const base = samples.get(CourseArchived)!;
    const owner = { ...base, actorId: ownerId, byAdmin: false, reason: null };
    expect(CourseArchived.parsePayload(owner)).toEqual(owner);
    expect(CourseArchived.safeParsePayload({ ...owner, reason: 'Retiring it' }).success).toBe(true);
    expect(CourseArchived.safeParsePayload({ ...base, reason: null }).success).toBe(false);
    expect(CourseArchived.safeParsePayload({ ...base, reason: 'short' }).success).toBe(false);
  });

  it('MediaReady mirrors the READY asset CHECKs', () => {
    const video = samples.get(MediaReady)!;
    expect(MediaReady.safeParsePayload({ ...video, durationMs: null }).success).toBe(false);
    expect(MediaReady.safeParsePayload({ ...video, width: null }).success).toBe(false);
    expect(MediaReady.safeParsePayload({ ...video, renditions: ['../etc'] }).success).toBe(false);

    const thumbnail = {
      ...video,
      purpose: 'COURSE_THUMBNAIL',
      durationMs: null,
      width: 1600,
      height: 900,
      renditions: ['w750', 'w480'],
    };
    expect(MediaReady.parsePayload(thumbnail)).toEqual(thumbnail);

    const resource = {
      ...video,
      purpose: 'LECTURE_RESOURCE',
      durationMs: null,
      width: null,
      height: null,
      renditions: [],
    };
    expect(MediaReady.parsePayload(resource)).toEqual(resource);
  });

  it('MediaUploaded requires a positive integer size', () => {
    const base = samples.get(MediaUploaded)!;
    expect(MediaUploaded.safeParsePayload({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(MediaUploaded.safeParsePayload({ ...base, sizeBytes: 1.5 }).success).toBe(false);
    expect(MediaUploaded.safeParsePayload({ ...base, sizeBytes: '10' }).success).toBe(false);
  });
});
