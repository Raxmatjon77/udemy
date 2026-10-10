import {
  MEDIA_ASSET_STATUSES,
  type MediaAssetStatus,
  type MediaFailureCode,
  type MediaPurpose,
} from '@udemy/contracts';
import { InvalidMediaField, MediaAssetUnusable, MediaPurposeMismatch } from './media.errors';

export type { MediaAssetStatus, MediaFailureCode, MediaPurpose };

/**
 * The MediaAsset state machine (design §4). The same edges are enforced by
 * `assets_status_transition_ck` in the database; this copy lets use cases decide before
 * writing and gives the unit tests something to pin.
 */
const TRANSITIONS: Readonly<Record<MediaAssetStatus, readonly MediaAssetStatus[]>> = {
  UPLOADING: ['UPLOADED', 'FAILED', 'ABORTED'],
  UPLOADED: ['PROCESSING'],
  PROCESSING: ['READY', 'FAILED'],
  READY: [],
  FAILED: [],
  ABORTED: [],
};

export function canTransition(from: MediaAssetStatus, to: MediaAssetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isMediaAssetStatus(value: string): value is MediaAssetStatus {
  return (MEDIA_ASSET_STATUSES as readonly string[]).includes(value);
}

/** Terminal states (no outgoing edge). */
export function isTerminal(status: MediaAssetStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * What `CompleteUpload` does for an asset in `status` (design §5, idempotent):
 * - `complete`: still UPLOADING, verify and complete it;
 * - `already-done`: past UPLOADING (UPLOADED, PROCESSING, READY, or FAILED by an earlier
 *   size check), answer with the current state;
 * - `not-in-progress`: ABORTED, the upload is gone (409 `upload_not_in_progress`).
 */
export type CompletionStep = 'complete' | 'already-done' | 'not-in-progress';

export function completionStep(status: MediaAssetStatus): CompletionStep {
  if (status === 'UPLOADING') return 'complete';
  if (status === 'ABORTED') return 'not-in-progress';
  return 'already-done';
}

/** The fields usability decisions depend on. */
export interface AssetUsabilityFacts {
  readonly ownerId: string;
  readonly purpose: MediaPurpose;
  readonly status: MediaAssetStatus;
  readonly purged: boolean;
}

/**
 * May `asset` be attached as `purpose` by `ownerId`? Ownership is the caller's business: a
 * foreign asset must look missing (404), so this only checks purpose and usability.
 *
 * @throws MediaPurposeMismatch (422) when the asset was uploaded for another purpose
 * @throws MediaAssetUnusable (409) when FAILED, ABORTED or purged
 */
export function assertAttachableAs(asset: AssetUsabilityFacts, purpose: MediaPurpose): void {
  if (asset.purpose !== purpose) {
    throw new MediaPurposeMismatch({ expected: purpose, actual: asset.purpose });
  }
  if (asset.purged) {
    throw new MediaAssetUnusable({ reason: 'The media asset was deleted.' });
  }
  if (asset.status === 'FAILED' || asset.status === 'ABORTED') {
    throw new MediaAssetUnusable({
      reason:
        asset.status === 'FAILED'
          ? 'The media asset failed processing.'
          : 'The media upload was cancelled.',
    });
  }
}

/** A revision pin (`catalog.course_revision`) needs a READY, unpurged asset. */
export function assertPinnable(asset: AssetUsabilityFacts): void {
  if (asset.purged || asset.status !== 'READY') {
    throw new MediaAssetUnusable({ reason: 'Only ready media can be submitted for review.' });
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Same bound as the `assets_original_filename_ck` CHECK. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * The display-only original filename (design §4): NFC, control characters removed, trimmed,
 * at most 255 characters (by code point, never splitting a surrogate pair). It is never used to
 * build object keys.
 *
 * @throws InvalidMediaField when nothing printable is left
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(CONTROL_CHARS, '').trim();
  const clipped = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join('').trim();
  if (clipped.length === 0) {
    throw new InvalidMediaField({ path: 'filename', message: 'The filename is empty.' });
  }
  return clipped;
}
