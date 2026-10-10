import {
  StorageAccessDeniedError,
  StorageEntityTooLargeError,
  StorageNotFoundError,
  StorageUnavailableError,
  StorageUsageError,
} from '@udemy/storage';
import { describe, expect, it } from 'vitest';
import {
  InvalidMediaField,
  MediaAssetNotFound,
  MediaAssetUnusable,
  MediaNotReady,
  MediaPurposeMismatch,
  PlaylistRejected,
  UploadNotInProgress,
} from '../domain/media.errors';
import { MEDIA_CONSTRAINT_ERRORS, mapMediaConstraints } from './media-constraint-errors';
import { isNoSuchUpload, toMediaStorageError } from './storage-errors';

const pgError = (constraint: string, code = '23514'): Error =>
  Object.assign(new Error(`violates ${constraint}`), { code, constraint });

describe('media constraint -> domain error (schema doc §9)', () => {
  it.each([
    ['asset_usages_asset_id_working_uq', MediaAssetUnusable],
    ['asset_usages_asset_usable_ck', MediaAssetUnusable],
    ['asset_usages_purpose_ck', MediaPurposeMismatch],
    ['asset_usages_asset_id_fk', MediaAssetNotFound],
    ['assets_status_transition_ck', UploadNotInProgress],
    ['assets_declared_content_type_ck', InvalidMediaField],
    ['assets_declared_size_bytes_ck', InvalidMediaField],
    ['assets_original_filename_ck', InvalidMediaField],
  ])('%s', async (constraint, type) => {
    const cause = pgError(constraint);
    const error = await mapMediaConstraints(() => Promise.reject(cause)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).cause).toBe(cause);
  });

  it.each([
    'asset_usages_consumer_working_uq',
    'assets_part_count_ck',
    'assets_source_key_ck',
    'assets_s3_upload_id_uq',
    'assets_immutable_ck',
  ])('leaves programming errors as 500s (%s)', async (constraint) => {
    expect(MEDIA_CONSTRAINT_ERRORS[constraint]).toBeUndefined();
    const cause = pgError(constraint);
    await expect(mapMediaConstraints(() => Promise.reject(cause))).rejects.toBe(cause);
  });

  it('passes successful statements through', async () => {
    await expect(mapMediaConstraints(async () => 42)).resolves.toBe(42);
  });
});

describe('storage error -> media error', () => {
  const details = { operation: 'op', bucket: 'b', key: 'k' };

  it('keeps S3 outages as 503 dependency errors', () => {
    const error = new StorageUnavailableError(details);
    expect(toMediaStorageError(error)).toBe(error);
  });

  it('maps NoSuchUpload to upload_not_in_progress and missing objects to media_not_ready', () => {
    const noUpload = new StorageNotFoundError('gone', { ...details, s3Code: 'NoSuchUpload' });
    expect(isNoSuchUpload(noUpload)).toBe(true);
    expect(toMediaStorageError(noUpload)).toBeInstanceOf(UploadNotInProgress);
    const noKey = new StorageNotFoundError('gone', { ...details, s3Code: 'NoSuchKey' });
    expect(isNoSuchUpload(noKey)).toBe(false);
    expect(toMediaStorageError(noKey)).toBeInstanceOf(MediaNotReady);
  });

  it('rejects oversized playlists and keeps other failures internal', () => {
    expect(toMediaStorageError(new StorageEntityTooLargeError('big', details))).toBeInstanceOf(
      PlaylistRejected,
    );
    const denied = new StorageAccessDeniedError('denied', details);
    expect(toMediaStorageError(denied)).toBe(denied);
    const usage = new StorageUsageError('bug');
    expect(toMediaStorageError(usage)).toBe(usage);
  });
});
