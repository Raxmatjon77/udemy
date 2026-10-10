import { MEDIA_ASSET_STATUSES, type MediaAssetStatus } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertAttachableAs,
  assertPinnable,
  canTransition,
  completionStep,
  isTerminal,
  sanitizeFilename,
} from './media-asset';
import {
  InvalidMediaField,
  MediaAssetUnusable,
  MediaPurposeMismatch,
  QuotaExceeded,
  TooManyUploads,
  UnsupportedMediaType,
  UploadTooLarge,
} from './media.errors';
import { PurposePolicy } from './purpose-policy';
import {
  assertPartNumbers,
  judgeUploadedParts,
  partContentLength,
  planOf,
  planUpload,
} from './upload-plan';
import { admitUpload } from './upload-quota';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('MediaAsset state machine (design §4)', () => {
  const edges: [MediaAssetStatus, MediaAssetStatus][] = [
    ['UPLOADING', 'UPLOADED'],
    ['UPLOADING', 'FAILED'],
    ['UPLOADING', 'ABORTED'],
    ['UPLOADED', 'PROCESSING'],
    ['PROCESSING', 'READY'],
    ['PROCESSING', 'FAILED'],
  ];

  it('allows exactly the designed edges (same as assets_status_transition_ck)', () => {
    for (const from of MEDIA_ASSET_STATUSES) {
      for (const to of MEDIA_ASSET_STATUSES) {
        const expected = edges.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('has READY, FAILED and ABORTED as terminal states', () => {
    expect(MEDIA_ASSET_STATUSES.filter(isTerminal)).toEqual(['READY', 'FAILED', 'ABORTED']);
  });

  it('decides CompleteUpload idempotently', () => {
    expect(completionStep('UPLOADING')).toBe('complete');
    for (const status of ['UPLOADED', 'PROCESSING', 'READY', 'FAILED'] as const) {
      expect(completionStep(status)).toBe('already-done');
    }
    expect(completionStep('ABORTED')).toBe('not-in-progress');
  });
});

describe('attach and pin rules', () => {
  const ready = {
    ownerId: 'o',
    purpose: 'LECTURE_VIDEO',
    status: 'READY',
    purged: false,
  } as const;

  it('accepts a matching, usable asset in any non-failed state', () => {
    for (const status of ['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY'] as const) {
      expect(() => assertAttachableAs({ ...ready, status }, 'LECTURE_VIDEO')).not.toThrow();
    }
  });

  it('rejects another purpose (422), failed/aborted/purged assets (409)', () => {
    expect(() => assertAttachableAs(ready, 'COURSE_THUMBNAIL')).toThrow(MediaPurposeMismatch);
    expect(() => assertAttachableAs({ ...ready, status: 'FAILED' }, 'LECTURE_VIDEO')).toThrow(
      MediaAssetUnusable,
    );
    expect(() => assertAttachableAs({ ...ready, status: 'ABORTED' }, 'LECTURE_VIDEO')).toThrow(
      MediaAssetUnusable,
    );
    expect(() => assertAttachableAs({ ...ready, purged: true }, 'LECTURE_VIDEO')).toThrow(
      MediaAssetUnusable,
    );
  });

  it('pins only READY, unpurged assets', () => {
    expect(() => assertPinnable(ready)).not.toThrow();
    expect(() => assertPinnable({ ...ready, status: 'PROCESSING' })).toThrow(MediaAssetUnusable);
    expect(() => assertPinnable({ ...ready, purged: true })).toThrow(MediaAssetUnusable);
  });
});

describe('sanitizeFilename', () => {
  it('strips control characters, trims and normalises to NFC', () => {
    expect(sanitizeFilename('  intro\u0000\u0007 video.mp4\n ')).toBe('intro video.mp4');
    expect(sanitizeFilename('Cafe\u0301.pdf')).toBe('Café.pdf');
  });

  it('caps at 255 code points without splitting surrogate pairs', () => {
    const name = sanitizeFilename(`${'😀'.repeat(300)}`);
    expect(Array.from(name)).toHaveLength(255);
    expect(name.endsWith('😀')).toBe(true);
  });

  it('rejects a name with nothing printable', () => {
    expect(() => sanitizeFilename(' \u0001\t ')).toThrow(InvalidMediaField);
  });
});

describe('PurposePolicy (MEDIA_PURPOSE_RULES + env overrides)', () => {
  const policy = new PurposePolicy({
    LECTURE_VIDEO: GiB,
    COURSE_THUMBNAIL: 10 * GiB, // above the contract ceiling: must not raise it
    LECTURE_RESOURCE: 100 * MiB,
  });

  it('accepts allowlisted types and normalises the content type', () => {
    expect(policy.accept('LECTURE_VIDEO', ' Video/MP4 ', 10)).toEqual({
      purpose: 'LECTURE_VIDEO',
      contentType: 'video/mp4',
      sizeBytes: 10,
    });
    expect(policy.accept('LECTURE_RESOURCE', 'application/pdf', 100 * MiB).contentType).toBe(
      'application/pdf',
    );
  });

  it.each([
    ['COURSE_THUMBNAIL', 'image/svg+xml'],
    ['COURSE_THUMBNAIL', 'image/gif'],
    ['LECTURE_VIDEO', 'image/png'],
    ['LECTURE_RESOURCE', 'text/html'],
  ] as const)('rejects %s as %s (unsupported_media_type)', (purpose, type) => {
    expect(() => policy.accept(purpose, type, 1)).toThrow(UnsupportedMediaType);
  });

  it('applies the lower env limit and never exceeds the contract ceiling', () => {
    expect(policy.maxBytes('LECTURE_VIDEO')).toBe(GiB);
    expect(policy.maxBytes('COURSE_THUMBNAIL')).toBe(5 * MiB);
    expect(() => policy.accept('LECTURE_VIDEO', 'video/mp4', GiB + 1)).toThrow(UploadTooLarge);
    expect(() => policy.accept('COURSE_THUMBNAIL', 'image/png', 5 * MiB + 1)).toThrow(
      UploadTooLarge,
    );
    expect(() => policy.accept('COURSE_THUMBNAIL', 'image/png', 5 * MiB)).not.toThrow();
  });
});

describe('part plan (D10)', () => {
  it('keeps the 8 MiB part size for a single-part upload (assets_part_size_bytes_ck)', () => {
    expect(planUpload(1)).toEqual({ sizeBytes: 1, partSize: 8 * MiB, partCount: 1 });
    expect(planUpload(5 * MiB - 1)).toEqual({
      sizeBytes: 5 * MiB - 1,
      partSize: 8 * MiB,
      partCount: 1,
    });
    expect(partContentLength(planUpload(1234), 1)).toBe(1234);
  });

  it('uses 8 MiB parts, then grows them to stay near 1000 parts', () => {
    expect(planUpload(8 * MiB + 1)).toEqual({
      sizeBytes: 8 * MiB + 1,
      partSize: 8 * MiB,
      partCount: 2,
    });
    expect(planUpload(4 * GiB)).toEqual({ sizeBytes: 4 * GiB, partSize: 8 * MiB, partCount: 512 });
    const big = planUpload(10 * GiB);
    expect(big.partSize).toBe(11 * MiB);
    expect(big.partCount).toBe(931);
    expect(partContentLength(big, big.partCount)).toBe(10 * GiB - 930 * 11 * MiB);
  });

  it('rebuilds and validates the stored plan', () => {
    expect(planOf({ declaredSizeBytes: 100, partSizeBytes: 8 * MiB, partCount: 1 })).toEqual({
      sizeBytes: 100,
      partSize: 8 * MiB,
      partCount: 1,
    });
    expect(() =>
      planOf({ declaredSizeBytes: 100, partSizeBytes: 8 * MiB, partCount: 2 }),
    ).toThrow();
  });

  it('rejects part numbers outside 1..partCount (422)', () => {
    const plan = planUpload(20 * MiB);
    expect(() => assertPartNumbers(plan, [1, 2, 3])).not.toThrow();
    expect(() => assertPartNumbers(plan, [1, 4])).toThrow(InvalidMediaField);
    expect(() => assertPartNumbers(plan, [0])).toThrow(InvalidMediaField);
  });

  it('judges the parts S3 reports', () => {
    const plan = planUpload(20 * MiB); // 8 + 8 + 4 MiB
    const all = [
      { partNumber: 1, size: 8 * MiB },
      { partNumber: 2, size: 8 * MiB },
      { partNumber: 3, size: 4 * MiB },
    ];
    expect(judgeUploadedParts(plan, all)).toEqual({ kind: 'complete' });
    expect(judgeUploadedParts(plan, all.slice(0, 1))).toEqual({
      kind: 'incomplete',
      missingParts: [2, 3],
    });
    expect(
      judgeUploadedParts(plan, [...all.slice(0, 2), { partNumber: 3, size: 4 * MiB - 1 }]).kind,
    ).toBe('size-mismatch');
    expect(judgeUploadedParts(plan, [...all, { partNumber: 4, size: 1 }]).kind).toBe(
      'size-mismatch',
    );
    // A wrong size wins over missing parts: it can never be repaired by uploading more.
    expect(judgeUploadedParts(plan, [{ partNumber: 1, size: 1 }]).kind).toBe('size-mismatch');
  });
});

describe('admitUpload (quota and concurrency)', () => {
  const limits = { quotaBytes: 100, maxConcurrentUploads: 2 };

  it('admits up to the quota inclusive', () => {
    expect(() => admitUpload({ usedBytes: '60', uploading: 1 }, 40, limits)).not.toThrow();
  });

  it('rejects past the quota (422 quota_exceeded)', () => {
    expect(() => admitUpload({ usedBytes: '60', uploading: 0 }, 41, limits)).toThrow(QuotaExceeded);
  });

  it('checks concurrency first (429 too_many_uploads)', () => {
    expect(() => admitUpload({ usedBytes: '1000', uploading: 2 }, 1, limits)).toThrow(
      TooManyUploads,
    );
  });

  it('does exact int8 arithmetic', () => {
    const huge = { quotaBytes: Number.MAX_SAFE_INTEGER, maxConcurrentUploads: 5 };
    expect(() =>
      admitUpload({ usedBytes: String(Number.MAX_SAFE_INTEGER), uploading: 0 }, 1, huge),
    ).toThrow(QuotaExceeded);
  });
});
