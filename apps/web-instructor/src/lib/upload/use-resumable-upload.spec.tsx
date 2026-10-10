// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetViewSchema,
  InitiateUploadRequestSchema,
  InitiateUploadResponseSchema,
  PresignPartsRequestSchema,
  PresignPartsResponseSchema,
  UploadStatusSchema,
} from '@udemy/contracts';

import { createFakeXhr, FakeXhr } from '@/test/fake-xhr';
import { asset } from '@/test/fixtures';
import { problem, proxy, server, setupMockApi } from '@/test/msw';

import { useResumableUpload } from './use-resumable-upload';
import { sessionUploadStore, type UploadRecord } from './upload-store';

setupMockApi();

const ASSET_ID = '0b1f6d1e-0000-4000-8000-0000000000e9';
const SLOT = 'lecture:test';
const PART = 10;

/** 25 bytes → parts of 10, 10 and 5 bytes. */
function videoFile(name = 'lecture.mp4', type = 'video/mp4', size = 25): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1_700_000_000_000 });
}

interface Calls {
  initiate: unknown[];
  partUrls: number[][];
  complete: number;
  status: number;
  deleted: number;
}

/** The media endpoints of design §8, answering with contract-valid bodies. */
function mediaApi({
  completeResponses = [],
  status,
}: {
  completeResponses?: Array<() => Response>;
  status?: () => Response;
} = {}): Calls {
  const calls: Calls = { initiate: [], partUrls: [], complete: 0, status: 0, deleted: 0 };
  server.use(
    http.post(proxy('/media/uploads'), async ({ request }) => {
      const body = InitiateUploadRequestSchema.parse(await request.json());
      calls.initiate.push(body);
      return HttpResponse.json(
        InitiateUploadResponseSchema.parse({ assetId: ASSET_ID, partSize: PART, partCount: 3 }),
        { status: 201 },
      );
    }),
    http.get(proxy(`/media/uploads/${ASSET_ID}`), () => {
      calls.status += 1;
      return status ? status() : new HttpResponse(null, { status: 404 });
    }),
    http.post(proxy(`/media/uploads/${ASSET_ID}/part-urls`), async ({ request }) => {
      const { partNumbers } = PresignPartsRequestSchema.parse(await request.json());
      calls.partUrls.push(partNumbers);
      return HttpResponse.json(
        PresignPartsResponseSchema.parse({
          urls: partNumbers.map((n) => ({
            partNumber: n,
            url: `http://127.0.0.1:9000/udemy-uploads/source?partNumber=${n}&X-Amz-Signature=abc`,
          })),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      );
    }),
    http.post(proxy(`/media/uploads/${ASSET_ID}/complete`), () => {
      const next = completeResponses[calls.complete];
      calls.complete += 1;
      if (next) return next();
      return HttpResponse.json(
        AssetViewSchema.parse(
          asset({ id: ASSET_ID, status: 'UPLOADED', durationSeconds: null, sizeBytes: 25 }),
        ),
      );
    }),
    http.delete(proxy(`/media/uploads/${ASSET_ID}`), () => {
      calls.deleted += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

function renderUpload(options: Partial<Parameters<typeof useResumableUpload>[0]> = {}) {
  return renderHook(() =>
    useResumableUpload({
      purpose: 'LECTURE_VIDEO',
      slotKey: SLOT,
      createXhr: createFakeXhr,
      concurrency: 2,
      sleep: (_ms, signal) =>
        signal.aborted
          ? Promise.reject(new DOMException('aborted', 'AbortError'))
          : Promise.resolve(),
      ...options,
    }),
  );
}

async function waitForPending(count: number): Promise<FakeXhr[]> {
  await waitFor(() => expect(FakeXhr.pending()).toHaveLength(count));
  return FakeXhr.pending();
}

beforeEach(() => {
  FakeXhr.reset();
});

describe('useResumableUpload', () => {
  it('initiates, PUTs every part (2 at a time, no extra headers, no credentials) and completes', async () => {
    const calls = mediaApi();
    const onInitiated = vi.fn(async () => {});
    const { result } = renderUpload({ onInitiated });

    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.start(videoFile());
    });

    const first = await waitForPending(2);
    expect(calls.initiate).toEqual([
      {
        purpose: 'LECTURE_VIDEO',
        filename: 'lecture.mp4',
        contentType: 'video/mp4',
        sizeBytes: 25,
      },
    ]);
    expect(onInitiated).toHaveBeenCalledWith(ASSET_ID);
    // URLs are fetched in one batch for the parts still queued.
    expect(calls.partUrls[0]).toEqual([1, 2, 3]);
    for (const xhr of first) {
      expect(xhr.method).toBe('PUT');
      expect(xhr.withCredentials).toBe(false);
      expect(xhr.headers).toEqual({});
      // No type on the slice: the browser adds no (unsigned) Content-Type.
      expect(xhr.body?.type).toBe('');
    }
    expect(first.map((xhr) => [xhr.partNumber, xhr.body?.size])).toEqual([
      [1, 10],
      [2, 10],
    ]);
    // The resume record is persisted while uploading.
    expect(sessionUploadStore.load(SLOT)?.assetId).toBe(ASSET_ID);

    act(() => first[0]!.progress(5));
    expect(result.current.state.loaded).toBe(5);
    act(() => first[0]!.respond(200));

    const third = await waitForPending(2);
    expect(third.map((xhr) => xhr.partNumber)).toEqual([2, 3]);
    expect(third[1]!.body?.size).toBe(5);
    await waitFor(() => expect(sessionUploadStore.load(SLOT)?.uploadedParts).toEqual([1]));
    act(() => {
      third[0]!.respond(200);
      third[1]!.respond(204);
    });

    await act(() => done);
    expect(calls.complete).toBe(1);
    expect(result.current.state.phase).toBe('done');
    expect(result.current.progress).toBe(1);
    expect(result.current.state.asset?.id).toBe(ASSET_ID);
    expect(sessionUploadStore.load(SLOT)).toBeNull();
  });

  it('retries a failed part, and re-requests its URL after a 403', async () => {
    const calls = mediaApi();
    const { result } = renderUpload({ concurrency: 1 });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.start(videoFile());
    });

    let [xhr] = await waitForPending(1);
    expect(xhr!.partNumber).toBe(1);
    act(() => xhr!.fail()); // network error → retry with the same URL
    [xhr] = await waitForPending(1);
    expect(xhr!.partNumber).toBe(1);
    act(() => xhr!.respond(403)); // expired signature → fresh URL, then retry
    [xhr] = await waitForPending(1);
    expect(xhr!.partNumber).toBe(1);
    expect(calls.partUrls).toEqual([[1, 2, 3], [1]]);
    act(() => xhr!.respond(200));

    for (const part of [2, 3]) {
      [xhr] = await waitForPending(1);
      expect(xhr!.partNumber).toBe(part);
      act(() => xhr!.respond(200));
    }
    await act(() => done);
    expect(result.current.state.phase).toBe('done');
  });

  it('gives up after the last attempt, keeps the record, and Retry resumes', async () => {
    mediaApi();
    const { result } = renderUpload({ concurrency: 1 });
    act(() => {
      void result.current.start(videoFile());
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [xhr] = await waitForPending(1);
      act(() => xhr!.respond(500));
    }
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.state.error).toMatch(/interrupted/);
    expect(result.current.canRetry).toBe(true);
    expect(sessionUploadStore.load(SLOT)?.assetId).toBe(ASSET_ID);
  });

  it('re-uploads exactly the parts named by a 409 upload_incomplete', async () => {
    const calls = mediaApi({
      completeResponses: [() => problem(409, 'upload_incomplete', { missingParts: [2] })],
    });
    const { result } = renderUpload({ concurrency: 3 });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.start(videoFile());
    });
    const parts = await waitForPending(3);
    act(() => parts.forEach((xhr) => xhr.respond(200)));

    const [again] = await waitForPending(1);
    expect(again!.partNumber).toBe(2);
    expect(calls.complete).toBe(1);
    act(() => again!.respond(200));

    await act(() => done);
    expect(calls.complete).toBe(2);
    expect(result.current.state.phase).toBe('done');
  });

  it('resumes after a reload: asks the server which parts exist and sends only the rest', async () => {
    const file = videoFile();
    const record: UploadRecord = {
      assetId: ASSET_ID,
      purpose: 'LECTURE_VIDEO',
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      partSize: PART,
      partCount: 3,
      uploadedParts: [1],
    };
    window.sessionStorage.setItem(`udemy:upload:${SLOT}`, JSON.stringify(record));
    const calls = mediaApi({
      status: () =>
        HttpResponse.json(
          UploadStatusSchema.parse({
            assetId: ASSET_ID,
            status: 'UPLOADING',
            partSize: PART,
            partCount: 3,
            // S3 has parts 1 and 2 (the tab persisted only 1 before the reload).
            uploadedParts: [
              { partNumber: 1, size: 10 },
              { partNumber: 2, size: 10 },
            ],
          }),
        ),
    });
    const onInitiated = vi.fn(async () => {});
    const { result } = renderUpload({ onInitiated });

    // Offered for resuming before any file is chosen.
    expect(result.current.pending?.assetId).toBe(ASSET_ID);
    expect(result.current.resumes(file)).toBe(true);

    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.start(file);
    });
    const [xhr] = await waitForPending(1);
    expect(xhr!.partNumber).toBe(3);
    expect(calls.status).toBe(1);
    expect(calls.initiate).toHaveLength(0);
    expect(calls.partUrls).toEqual([[3]]);
    act(() => xhr!.respond(200));
    await act(() => done);
    expect(onInitiated).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('done');
  });

  it('cancel aborts the transfers and deletes the upload', async () => {
    const calls = mediaApi();
    const { result } = renderUpload();
    act(() => {
      void result.current.start(videoFile());
    });
    const inFlight = await waitForPending(2);

    await act(() => result.current.cancel());
    expect(inFlight.every((xhr) => xhr.aborted)).toBe(true);
    expect(calls.deleted).toBe(1);
    expect(result.current.state.phase).toBe('canceled');
    expect(sessionUploadStore.load(SLOT)).toBeNull();
    expect(calls.complete).toBe(0);
  });

  it('rejects a disallowed file type before calling the API', async () => {
    const { result } = renderUpload();
    await act(() => result.current.start(videoFile('clip.gif', 'image/gif')));
    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.error).toMatch(/MP4, MOV, WebM or MKV/);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
