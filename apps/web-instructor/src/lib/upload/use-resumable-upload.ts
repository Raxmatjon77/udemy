'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AssetView, MediaPurpose } from '@udemy/contracts';

import { isApiError, problemMessage } from '../problem';
import { formatBytes } from '../format';
import { mediaTransport } from './media-transport';
import {
  isAbortError,
  runUpload,
  sameFile,
  UploadPartError,
  UploadValidationError,
  type UploadOptions,
  type UploadTransport,
} from './upload-engine';
import {
  parseUploadRecord,
  sessionUploadStore,
  type UploadRecord,
  type UploadStore,
} from './upload-store';

export type UploadStatusPhase =
  'idle' | 'preparing' | 'uploading' | 'completing' | 'done' | 'error' | 'canceled';

export interface UploadState {
  phase: UploadStatusPhase;
  fileName: string | null;
  loaded: number;
  total: number;
  /** User-facing message when `phase === 'error'`. */
  error: string | null;
  asset: AssetView | null;
}

export interface UseResumableUploadOptions {
  purpose: MediaPurpose;
  slotKey: string;
  /** See `UploadOptions.onInitiated` (attach the new asset to its lecture). */
  onInitiated?: (assetId: string) => Promise<void>;
  /** Called with the completed asset (e.g. set it as the course thumbnail). */
  onComplete?: (asset: AssetView) => Promise<void> | void;
  transport?: UploadTransport;
  store?: UploadStore;
  createXhr?: () => XMLHttpRequest;
  concurrency?: number;
  sleep?: UploadOptions['sleep'];
  backoffMs?: UploadOptions['backoffMs'];
}

const IDLE: UploadState = {
  phase: 'idle',
  fileName: null,
  loaded: 0,
  total: 0,
  error: null,
  asset: null,
};

function uploadErrorMessage(error: unknown, purpose: MediaPurpose): string {
  if (error instanceof UploadValidationError) {
    return error.code === 'upload_too_large'
      ? 'This file is too large for this kind of upload.'
      : purpose === 'LECTURE_VIDEO'
        ? 'Choose an MP4, MOV, WebM or MKV video.'
        : purpose === 'COURSE_THUMBNAIL'
          ? 'Choose a JPEG, PNG or WebP image.'
          : 'Choose a PDF or ZIP file.';
  }
  if (error instanceof UploadPartError) {
    return 'The upload was interrupted. Check your connection and select Retry to continue where it stopped.';
  }
  if (isApiError(error)) return problemMessage(error);
  return problemMessage(error);
}

/**
 * React state around `runUpload` (./upload-engine.ts): start, cancel, retry and the resume
 * record of an upload interrupted by a reload (`pending`: select the same file to continue).
 *
 * Unmounting stops the transfer but keeps the resume record (the asset is NOT deleted);
 * `cancel()` deletes the upload on the server (`DELETE /media/uploads/:id`).
 */
export function useResumableUpload(options: UseResumableUploadOptions) {
  const { purpose, slotKey } = options;
  const store = options.store ?? sessionUploadStore;
  const transport = options.transport ?? mediaTransport;

  const [state, setState] = useState<UploadState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const lastFile = useRef<File | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const raw = useSyncExternalStore(
    store.subscribe,
    () => store.raw(slotKey),
    () => null,
  );
  const record = useMemo(() => parseUploadRecord(raw), [raw]);

  useEffect(
    () => () => {
      // Stop the transfer on unmount; the record stays for a later resume.
      controller.current?.abort();
    },
    [],
  );

  const start = useCallback(
    async (file: File): Promise<AssetView | null> => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      lastFile.current = file;
      const current = latest.current;
      setState({ ...IDLE, phase: 'preparing', fileName: file.name, total: file.size });
      try {
        const asset = await runUpload({
          file,
          purpose,
          slotKey,
          transport,
          store,
          signal: own.signal,
          ...(current.createXhr ? { createXhr: current.createXhr } : {}),
          ...(current.concurrency ? { concurrency: current.concurrency } : {}),
          ...(current.sleep ? { sleep: current.sleep } : {}),
          ...(current.backoffMs ? { backoffMs: current.backoffMs } : {}),
          ...(current.onInitiated ? { onInitiated: current.onInitiated } : {}),
          onPhase: (phase) => {
            if (!own.signal.aborted) setState((s) => ({ ...s, phase }));
          },
          onProgress: (loaded, total) => {
            if (!own.signal.aborted) setState((s) => ({ ...s, loaded, total }));
          },
        });
        if (own.signal.aborted) return null;
        await latest.current.onComplete?.(asset);
        setState((s) => ({ ...s, phase: 'done', loaded: s.total, asset, error: null }));
        return asset;
      } catch (error) {
        if (own.signal.aborted || isAbortError(error)) return null;
        setState((s) => ({ ...s, phase: 'error', error: uploadErrorMessage(error, purpose) }));
        return null;
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [purpose, slotKey, store, transport],
  );

  /** Stops the transfer and deletes the upload on the server. */
  const cancel = useCallback(async () => {
    controller.current?.abort();
    controller.current = null;
    const pending = store.load(slotKey);
    store.clear(slotKey);
    setState((s) => ({ ...IDLE, phase: 'canceled', fileName: s.fileName }));
    if (pending) {
      try {
        await transport.abort(pending.assetId);
      } catch {
        // Already gone (404/409) or offline: the janitor aborts stale multiparts anyway.
      }
    }
  }, [slotKey, store, transport]);

  /** Retries the last file in this page session (resumes from the confirmed parts). */
  const retry = useCallback(() => {
    if (lastFile.current) void start(lastFile.current);
  }, [start]);

  const reset = useCallback(() => setState(IDLE), []);

  const busy =
    state.phase === 'preparing' || state.phase === 'uploading' || state.phase === 'completing';
  /** An upload from before a reload that can resume once the same file is selected again. */
  const pending: UploadRecord | null = busy || state.phase === 'error' ? null : record;

  return {
    state,
    busy,
    progress: state.total > 0 ? state.loaded / state.total : 0,
    pending,
    canRetry: state.phase === 'error' && state.fileName !== null,
    start,
    cancel,
    retry,
    reset,
    /** True when `file` would resume the pending upload. */
    resumes: (file: File) => (pending ? sameFile(pending, file, purpose) : false),
  };
}

export function describePending(record: UploadRecord): string {
  const done = record.uploadedParts.length;
  return `${record.name} (${formatBytes(record.size)}), ${done} of ${record.partCount} parts uploaded`;
}
