import {
  checkMediaUpload,
  ErrorCode,
  MEDIA_UPLOAD_LIMITS,
  UploadIncompleteProblemSchema,
  type AssetView,
  type InitiateUploadRequest,
  type InitiateUploadResponse,
  type MediaPurpose,
  type PresignPartsResponse,
  type UploadStatus,
} from '@udemy/contracts';

import { isApiError } from '../problem';
import type { UploadRecord, UploadStore } from './upload-store';

/*
 * Resumable multipart upload, browser → MinIO with presigned part URLs (design §10, D10).
 *
 * 1. `POST /media/uploads` → server-chosen part plan `{assetId, partSize, partCount}`.
 * 2. Part URLs are requested in batches (≤ 50 per call) just before they are needed, and again
 *    when one is about to expire or a PUT answers 403.
 * 3. Each part is PUT with XMLHttpRequest (upload progress events), `concurrency` at a time.
 *    The URL signs `host` and `content-length` only: the body is a `Blob` slice WITHOUT a type,
 *    so the browser adds no `Content-Type`, and no other header is set. No credentials.
 * 4. A failed part is retried with exponential backoff (+ jitter); a 403 drops its URL first.
 * 5. `POST …/complete`; a 409 `upload_incomplete` names `missingParts`, which are uploaded again.
 * 6. Progress is persisted (`UploadStore`) so a reload can resume: `GET /media/uploads/:id`
 *    says which parts S3 already has, and only the rest are sent.
 */

export interface UploadTransport {
  initiate(body: InitiateUploadRequest): Promise<InitiateUploadResponse>;
  status(assetId: string): Promise<UploadStatus>;
  partUrls(assetId: string, partNumbers: number[]): Promise<PresignPartsResponse>;
  complete(assetId: string): Promise<AssetView>;
  abort(assetId: string): Promise<void>;
}

export type UploadPhase = 'preparing' | 'uploading' | 'completing';

export interface UploadOptions {
  file: File;
  purpose: MediaPurpose;
  /** Where the resume record lives (`lecture:<id>`, `thumbnail:<courseId>`). */
  slotKey: string;
  transport: UploadTransport;
  store: UploadStore;
  signal: AbortSignal;
  createXhr?: () => XMLHttpRequest;
  /** Parallel part PUTs (design: 3). */
  concurrency?: number;
  /** Attempts per part and per API call, including the first (design: 4 retries). */
  maxAttempts?: number;
  /** Delay before retry `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Server limit stricter than the contracts default (e.g. dev `MEDIA_MAX_VIDEO_BYTES`). */
  maxBytesOverride?: number;
  /**
   * Runs once right after a NEW upload was initiated, before any part is sent (the builder
   * attaches the asset to the lecture there, design §10 sequence). If it throws, the upload is
   * aborted (`DELETE`) and the error is rethrown.
   */
  onInitiated?: (assetId: string) => Promise<void>;
  onPhase?: (phase: UploadPhase) => void;
  /** Bytes confirmed or in flight, and the total. */
  onProgress?: (loaded: number, total: number) => void;
}

/** A client-side rejection before anything was sent (contracts `checkMediaUpload`). */
export class UploadValidationError extends Error {
  constructor(
    readonly code: typeof ErrorCode.UnsupportedMediaType | typeof ErrorCode.UploadTooLarge,
  ) {
    super(code);
    this.name = 'UploadValidationError';
  }
}

/** A part PUT that failed every attempt. */
export class UploadPartError extends Error {
  constructor(
    readonly partNumber: number,
    readonly status: number,
  ) {
    super(`Part ${partNumber} failed${status ? ` with HTTP ${status}` : ' (network error)'}`);
    this.name = 'UploadPartError';
  }
}

export function abortError(): DOMException {
  return new DOMException('The upload was cancelled.', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** A presigned URL is not used when it expires within this margin. */
const URL_SAFETY_MS = 60_000;
/** Rounds of "complete → missing parts → re-upload" before giving up. */
const MAX_COMPLETE_ROUNDS = 3;

export function defaultBackoff(attempt: number): number {
  const base = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
  return base / 2 + Math.random() * (base / 2);
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The size of part `n` (1-based) of a `size`-byte file cut into `partSize` parts. */
export function partBytes(size: number, partSize: number, partNumber: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.max(0, Math.min(partSize, size - start));
}

/** `original_filename` is a single line of 1–255 characters. */
export function uploadFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(clean).slice(0, MEDIA_UPLOAD_LIMITS.maxFilenameLength).join('') || 'upload';
}

export function sameFile(record: UploadRecord, file: File, purpose: MediaPurpose): boolean {
  return (
    record.purpose === purpose &&
    record.name === file.name &&
    record.size === file.size &&
    record.lastModified === file.lastModified
  );
}

function retryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!isApiError(error)) return true; // network
  return error.status === 429 || error.status >= 500;
}

class PartHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Uploads `file` (or resumes the upload recorded for `slotKey` when it is the same file) and
 * returns the completed asset. Rejects with an `AbortError` when `signal` aborts; the resume
 * record is kept on any other failure, so calling it again with the same file resumes.
 */
export async function runUpload(options: UploadOptions): Promise<AssetView> {
  const {
    file,
    purpose,
    slotKey,
    transport,
    store,
    signal,
    createXhr = () => new XMLHttpRequest(),
    concurrency = 3,
    maxAttempts = 5,
    backoffMs = defaultBackoff,
    sleep = defaultSleep,
  } = options;
  const total = file.size;

  const problem = checkMediaUpload(purpose, file.type, file.size, options.maxBytesOverride);
  if (problem) throw new UploadValidationError(problem);

  const throwIfAborted = () => {
    if (signal.aborted) throw abortError();
  };

  /** API calls: retried on network errors, 5xx and 429 (honouring Retry-After). */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted();
      try {
        return await fn();
      } catch (error) {
        if (!retryable(error) || attempt >= maxAttempts) throw error;
        const wait =
          isApiError(error) && error.retryAfterSeconds !== null
            ? error.retryAfterSeconds * 1000
            : backoffMs(attempt);
        await sleep(wait, signal);
      }
    }
  }

  options.onPhase?.('preparing');

  /* ---- resume or initiate ---------------------------------------------------------------- */

  let record: UploadRecord | null = store.load(slotKey);
  const uploaded = new Set<number>();

  if (record && sameFile(record, file, purpose)) {
    const assetId = record.assetId;
    let status: UploadStatus | null = null;
    try {
      status = await call(() => transport.status(assetId));
    } catch (error) {
      if (!(isApiError(error) && error.status === 404)) throw error;
    }
    if (status?.status === 'UPLOADING') {
      record = { ...record, partSize: status.partSize, partCount: status.partCount };
      for (const part of status.uploadedParts) {
        if (part.size === partBytes(total, status.partSize, part.partNumber)) {
          uploaded.add(part.partNumber);
        }
      }
    } else if (status && status.status !== 'FAILED' && status.status !== 'ABORTED') {
      // Already completed (UPLOADED/PROCESSING/READY): complete is idempotent.
      const asset = await call(() => transport.complete(assetId));
      store.clear(slotKey);
      return asset;
    } else {
      store.clear(slotKey);
      record = null;
    }
  } else if (record) {
    // A different file for this slot: the old upload can never finish; abort it.
    const stale = record.assetId;
    store.clear(slotKey);
    record = null;
    void transport.abort(stale).catch(() => undefined);
  }

  if (!record) {
    const plan = await call(() =>
      transport.initiate({
        purpose,
        filename: uploadFilename(file.name),
        contentType: file.type.toLowerCase(),
        sizeBytes: total,
      }),
    );
    if (signal.aborted) {
      void transport.abort(plan.assetId).catch(() => undefined);
      throw abortError();
    }
    record = {
      assetId: plan.assetId,
      purpose,
      name: file.name,
      size: total,
      lastModified: file.lastModified,
      type: file.type,
      partSize: plan.partSize,
      partCount: plan.partCount,
      uploadedParts: [],
    };
    store.save(slotKey, record);
    if (options.onInitiated) {
      try {
        await options.onInitiated(plan.assetId);
      } catch (error) {
        store.clear(slotKey);
        void transport.abort(plan.assetId).catch(() => undefined);
        throw error;
      }
    }
  }

  const active: UploadRecord = record;
  const { assetId, partSize, partCount } = active;
  const persist = () => {
    if (!signal.aborted) {
      store.save(slotKey, { ...active, uploadedParts: [...uploaded].sort((a, b) => a - b) });
    }
  };
  persist();

  /* ---- progress ----------------------------------------------------------------------- */

  const inFlight = new Map<number, number>();
  const report = () => {
    let loaded = 0;
    for (const n of uploaded) loaded += partBytes(total, partSize, n);
    for (const bytes of inFlight.values()) loaded += bytes;
    options.onProgress?.(Math.min(loaded, total), total);
  };

  /* ---- part URLs ---------------------------------------------------------------------- */

  const urls = new Map<number, { url: string; expiresAt: number }>();
  let fetching: Promise<void> | null = null;
  const validUrl = (n: number): string | null => {
    const entry = urls.get(n);
    return entry && entry.expiresAt - Date.now() > URL_SAFETY_MS ? entry.url : null;
  };

  async function urlFor(n: number, queue: readonly number[], inner: AbortSignal): Promise<string> {
    for (;;) {
      if (inner.aborted) throw abortError();
      const url = validUrl(n);
      if (url) return url;
      if (!fetching) {
        const batch = [n, ...queue.filter((p) => p !== n && !validUrl(p))].slice(
          0,
          MEDIA_UPLOAD_LIMITS.maxPartUrlsPerRequest,
        );
        fetching = call(() => transport.partUrls(assetId, batch))
          .then((response) => {
            const expiresAt = Date.parse(response.expiresAt);
            for (const { partNumber, url: partUrl } of response.urls) {
              urls.set(partNumber, { url: partUrl, expiresAt });
            }
          })
          .finally(() => {
            fetching = null;
          });
      }
      await fetching;
    }
  }

  /* ---- one PUT ------------------------------------------------------------------------ */

  function putPart(url: string, n: number, inner: AbortSignal): Promise<void> {
    const start = (n - 1) * partSize;
    // No content type on the slice: the browser then sends no Content-Type header (unsigned).
    const body = file.slice(start, start + partBytes(total, partSize, n));
    return new Promise<void>((resolve, reject) => {
      if (inner.aborted) return reject(abortError());
      const xhr = createXhr();
      const onAbort = () => xhr.abort();
      const done = () => {
        inner.removeEventListener('abort', onAbort);
        inFlight.delete(n);
      };
      xhr.open('PUT', url, true);
      xhr.withCredentials = false;
      xhr.upload.onprogress = (event: ProgressEvent) => {
        inFlight.set(n, event.loaded);
        report();
      };
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new PartHttpError(xhr.status));
      };
      xhr.onerror = () => {
        done();
        reject(new PartHttpError(0));
      };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = () => {
        done();
        reject(abortError());
      };
      inner.addEventListener('abort', onAbort, { once: true });
      xhr.send(body);
    });
  }

  async function uploadPart(
    n: number,
    queue: readonly number[],
    inner: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const url = await urlFor(n, queue, inner);
      try {
        await putPart(url, n, inner);
        uploaded.add(n);
        persist();
        report();
        return;
      } catch (error) {
        if (inner.aborted || isAbortError(error)) throw abortError();
        const status = error instanceof PartHttpError ? error.status : 0;
        // 403: expired or rejected signature; 4xx other than 403/408/429 will not get better.
        if (status === 403) urls.delete(n);
        const permanent = status >= 400 && status < 500 && ![403, 408, 429].includes(status);
        if (permanent || attempt >= maxAttempts) throw new UploadPartError(n, status);
        report();
        await sleep(backoffMs(attempt), inner);
      }
    }
  }

  /** Sends `parts` with `concurrency` workers; the first hard failure stops the others. */
  async function uploadParts(parts: number[]): Promise<void> {
    const queue = [...parts];
    const inner = new AbortController();
    const forward = () => inner.abort();
    signal.addEventListener('abort', forward, { once: true });
    const worker = async () => {
      while (queue.length > 0) {
        const n = queue.shift()!;
        await uploadPart(n, queue, inner.signal);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, () =>
          worker().catch((error: unknown) => {
            inner.abort();
            throw error;
          }),
        ),
      );
    } catch (error) {
      throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener('abort', forward);
    }
  }

  /* ---- run ---------------------------------------------------------------------------- */

  options.onPhase?.('uploading');
  report();
  const all = Array.from({ length: partCount }, (_, i) => i + 1);
  await uploadParts(all.filter((n) => !uploaded.has(n)));

  for (let round = 1; ; round += 1) {
    throwIfAborted();
    options.onPhase?.('completing');
    try {
      const asset = await call(() => transport.complete(assetId));
      store.clear(slotKey);
      return asset;
    } catch (error) {
      const incomplete =
        isApiError(error) && error.code === ErrorCode.UploadIncomplete
          ? UploadIncompleteProblemSchema.safeParse(error.problem)
          : null;
      if (!incomplete?.success || incomplete.data.missingParts.length === 0) throw error;
      if (round >= MAX_COMPLETE_ROUNDS) throw error;
      const missing = incomplete.data.missingParts.filter((n) => n >= 1 && n <= partCount);
      for (const n of missing) uploaded.delete(n);
      persist();
      options.onPhase?.('uploading');
      report();
      await uploadParts(missing);
    }
  }
}
