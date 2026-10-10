import { describe, expect, it } from 'vitest';
import {
  MediaAssetNotFound,
  MediaAssetUnusable,
  MediaNotReady,
  MediaPurposeMismatch,
  PlaylistRejected,
  RenditionNotFound,
} from '../domain/media.errors';
import { PlaylistCache } from './playlist-cache';
import type { RenditionRecord } from './ports/media-asset.repository';
import { assetRecord, FAKE_TRX } from './testing/media.fakes';
import { createMediaHarness, type MediaHarness } from './testing/media.harness';

const OWNER = '00000000-0000-7000-8000-00000000aaaa';
const OTHER = '00000000-0000-7000-8000-00000000cccc';
const LECTURE = { type: 'catalog.lecture', id: '00000000-0000-7000-8000-0000000001ec' } as const;
const THUMB = {
  type: 'catalog.course_thumbnail',
  id: '00000000-0000-7000-8000-0000000000c0',
} as const;

function readyVideo(h: MediaHarness, id = '00000000-0000-7000-8000-0000000000a1') {
  const prefix = `assets/${id}/a2/`;
  const renditions: RenditionRecord[] = [
    {
      name: '720p',
      kind: 'HLS_VARIANT',
      width: 1280,
      height: 720,
      bandwidthBps: 3_000_000,
      codecs: 'avc1.4d401f,mp4a.40.2',
      objectKey: `${prefix}hls/720p/index.m3u8`,
    },
    {
      name: '360p',
      kind: 'HLS_VARIANT',
      width: 640,
      height: 360,
      bandwidthBps: 800_000,
      codecs: 'avc1.42c01e,mp4a.40.2',
      objectKey: `${prefix}hls/360p/index.m3u8`,
    },
    {
      name: 'poster',
      kind: 'IMAGE',
      width: 1280,
      height: 720,
      bandwidthBps: null,
      codecs: null,
      objectKey: `${prefix}poster.jpg`,
    },
  ];
  h.assets.add(
    assetRecord({
      id,
      ownerId: OWNER,
      status: 'READY',
      outputPrefix: prefix,
      durationMs: 12_000,
      width: 1280,
      height: 720,
    }),
    renditions,
  );
  h.storage.mediaTexts.set(
    `${prefix}hls/360p/index.m3u8`,
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg_00000.ts\n#EXTINF:6.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n',
  );
  return { id, prefix };
}

describe('MediaFacade usages', () => {
  it('useAsset locks the asset, checks owner/purpose/state and inserts the usage', async () => {
    const h = createMediaHarness();
    const asset = h.assets.add(assetRecord({ ownerId: OWNER, status: 'PROCESSING' }));

    const view = await h.facade.useAsset(FAKE_TRX, {
      assetId: asset.id,
      ownerId: OWNER,
      purpose: 'LECTURE_VIDEO',
      consumer: LECTURE,
    });

    expect(view.id).toBe(asset.id);
    expect(h.usages.lockCalls).toEqual([[asset.id]]);
    expect(h.usages.usages).toEqual([
      { assetId: asset.id, consumerType: 'catalog.lecture', consumerId: LECTURE.id },
    ]);
    // Idempotent.
    await h.facade.useAsset(FAKE_TRX, {
      assetId: asset.id,
      ownerId: OWNER,
      purpose: 'LECTURE_VIDEO',
      consumer: LECTURE,
    });
    expect(h.usages.usages).toHaveLength(1);
  });

  it('answers 404 for a foreign or missing asset, never 403', async () => {
    const h = createMediaHarness();
    const asset = h.assets.add(assetRecord({ ownerId: OWNER }));
    for (const [assetId, ownerId] of [
      [asset.id, OTHER],
      [OTHER, OWNER],
    ] as const) {
      await expect(
        h.facade.useAsset(FAKE_TRX, {
          assetId,
          ownerId,
          purpose: 'LECTURE_VIDEO',
          consumer: LECTURE,
        }),
      ).rejects.toBeInstanceOf(MediaAssetNotFound);
    }
    expect(h.usages.usages).toEqual([]);
  });

  it('rejects purpose mismatches (422) and unusable assets (409)', async () => {
    const h = createMediaHarness();
    const thumb = h.assets.add(assetRecord({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' }));
    const failed = h.assets.add(
      assetRecord({ ownerId: OWNER, status: 'FAILED', failureCode: 'INVALID_MEDIA' }),
    );
    await expect(
      h.facade.useAsset(FAKE_TRX, {
        assetId: thumb.id,
        ownerId: OWNER,
        purpose: 'LECTURE_VIDEO',
        consumer: LECTURE,
      }),
    ).rejects.toBeInstanceOf(MediaPurposeMismatch);
    await expect(
      h.facade.useAsset(FAKE_TRX, {
        assetId: thumb.id,
        ownerId: OWNER,
        purpose: 'COURSE_THUMBNAIL',
        consumer: LECTURE,
      }),
    ).rejects.toBeInstanceOf(MediaPurposeMismatch);
    await expect(
      h.facade.useAsset(FAKE_TRX, {
        assetId: failed.id,
        ownerId: OWNER,
        purpose: 'LECTURE_VIDEO',
        consumer: LECTURE,
      }),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);
  });

  it('refuses an asset already used by another working-copy consumer (409)', async () => {
    const h = createMediaHarness();
    const thumb = h.assets.add(assetRecord({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' }));
    await h.facade.useAsset(FAKE_TRX, {
      assetId: thumb.id,
      ownerId: OWNER,
      purpose: 'COURSE_THUMBNAIL',
      consumer: THUMB,
    });
    await expect(
      h.facade.useAsset(FAKE_TRX, {
        assetId: thumb.id,
        ownerId: OWNER,
        purpose: 'COURSE_THUMBNAIL',
        consumer: { type: 'catalog.course_thumbnail', id: OTHER },
      }),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);
  });

  it('releaseAsset locks and deletes one usage', async () => {
    const h = createMediaHarness();
    const asset = h.assets.add(assetRecord({ ownerId: OWNER }));
    await h.facade.useAsset(FAKE_TRX, {
      assetId: asset.id,
      ownerId: OWNER,
      purpose: 'LECTURE_VIDEO',
      consumer: LECTURE,
    });
    expect(await h.facade.releaseAsset(FAKE_TRX, { assetId: asset.id, consumer: LECTURE })).toBe(
      true,
    );
    expect(await h.facade.releaseAsset(FAKE_TRX, { assetId: asset.id, consumer: LECTURE })).toBe(
      false,
    );
    expect(h.usages.usages).toEqual([]);
  });

  it('pinRevisionAssets locks ascending, needs READY, and releaseConsumer drops the pins', async () => {
    const h = createMediaHarness();
    const b = h.assets.add(
      assetRecord({
        id: '00000000-0000-7000-8000-0000000000b2',
        status: 'READY',
        outputPrefix: 'p',
      }),
    );
    const a = h.assets.add(
      assetRecord({
        id: '00000000-0000-7000-8000-0000000000b1',
        status: 'READY',
        outputPrefix: 'p',
      }),
    );
    const revisionId = '00000000-0000-7000-8000-0000000000e1';

    await h.facade.pinRevisionAssets(FAKE_TRX, { revisionId, assetIds: [b.id, a.id, b.id] });
    expect(h.usages.lockCalls).toEqual([[a.id, b.id]]);
    expect(h.usages.usages.map((u) => u.assetId)).toEqual([a.id, b.id]);

    expect(
      await h.facade.releaseConsumer(FAKE_TRX, { type: 'catalog.course_revision', id: revisionId }),
    ).toEqual([a.id, b.id]);
    expect(h.usages.usages).toEqual([]);

    const processing = h.assets.add(assetRecord({ status: 'PROCESSING' }));
    await expect(
      h.facade.pinRevisionAssets(FAKE_TRX, { revisionId, assetIds: [a.id, processing.id] }),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);
    await expect(
      h.facade.pinRevisionAssets(FAKE_TRX, { revisionId, assetIds: [OTHER] }),
    ).rejects.toBeInstanceOf(MediaAssetNotFound);
  });

  it('assertAttachable is a read-only pre-check', async () => {
    const h = createMediaHarness();
    const asset = h.assets.add(assetRecord({ ownerId: OWNER, purpose: 'LECTURE_RESOURCE' }));
    await expect(
      h.facade.assertAttachable(OWNER, asset.id, 'LECTURE_RESOURCE'),
    ).resolves.toMatchObject({ id: asset.id });
    await expect(
      h.facade.assertAttachable(OTHER, asset.id, 'LECTURE_RESOURCE'),
    ).rejects.toBeInstanceOf(MediaAssetNotFound);
    await expect(
      h.facade.assertAttachable(OWNER, asset.id, 'LECTURE_VIDEO'),
    ).rejects.toBeInstanceOf(MediaPurposeMismatch);
    expect(h.usages.usages).toEqual([]);
  });

  it('getAssets keeps the request order and skips unknown ids', async () => {
    const h = createMediaHarness();
    const x = h.assets.add(assetRecord());
    const y = h.assets.add(assetRecord());
    expect((await h.facade.getAssets([y.id, OTHER, x.id])).map((a) => a.id)).toEqual([y.id, x.id]);
    expect(await h.facade.getAssets([])).toEqual([]);
  });
});

describe('MediaFacade playback', () => {
  it('renders the master playlist from the DB rows', async () => {
    const h = createMediaHarness();
    const { id } = readyVideo(h);
    const master = await h.facade.renderMasterPlaylist(id);
    expect(master.split('\n').filter((l) => !l.startsWith('#') && l !== '')).toEqual([
      '360p.m3u8',
      '720p.m3u8',
    ]);
  });

  it('rewrites every segment to a presigned GET with the playback TTL, caching the text', async () => {
    const h = createMediaHarness();
    const { id, prefix } = readyVideo(h);

    const first = await h.facade.renderVariantPlaylist(id, '360p');
    const second = await h.facade.renderVariantPlaylist(id, '360p');

    expect(first).toContain(`https://media.test/${prefix}hls/360p/seg_00000.ts?X-Amz-Expires=3600`);
    expect(first).toContain(`https://media.test/${prefix}hls/360p/seg_00001.ts?X-Amz-Expires=3600`);
    expect(first).toContain('#EXT-X-ENDLIST');
    expect(second).toBe(first);
    expect(h.storage.reads).toEqual([`${prefix}hls/360p/index.m3u8`]);
    expect(h.storage.presignedGets.every((g) => g.ttlSeconds === 3600)).toBe(true);
  });

  it('validates the rendition against the DB rows (404) and the state (409)', async () => {
    const h = createMediaHarness();
    const { id } = readyVideo(h);
    for (const rendition of ['1080p', 'poster', '../720p']) {
      await expect(h.facade.renderVariantPlaylist(id, rendition)).rejects.toBeInstanceOf(
        RenditionNotFound,
      );
    }
    const processing = h.assets.add(assetRecord({ status: 'PROCESSING' }));
    await expect(h.facade.renderMasterPlaylist(processing.id)).rejects.toBeInstanceOf(
      MediaNotReady,
    );
    await expect(h.facade.renderMasterPlaylist(OTHER)).rejects.toBeInstanceOf(MediaAssetNotFound);
  });

  it.each([
    '../../other/a1/hls/360p/seg_00000.ts',
    '/etc/passwd',
    'https://evil.test/x.ts',
    'a/../../b.ts',
  ])('rejects a playlist whose segment URI escapes its directory (%s)', async (uri) => {
    const h = createMediaHarness();
    const { id, prefix } = readyVideo(h);
    h.storage.mediaTexts.set(`${prefix}hls/360p/index.m3u8`, `#EXTM3U\n#EXTINF:6.0,\n${uri}\n`);
    await expect(h.facade.renderVariantPlaylist(id, '360p')).rejects.toBeInstanceOf(
      PlaylistRejected,
    );
    expect(h.storage.presignedGets).toEqual([]);
  });

  it('presigns images with a forced image content type, 404 for a missing variant', async () => {
    const h = createMediaHarness();
    const { id, prefix } = readyVideo(h);
    const signed = await h.facade.presignImage(id, 'poster');
    expect(signed.url).toBe(`https://media.test/${prefix}poster.jpg?X-Amz-Expires=3600`);
    expect(h.storage.presignedGets).toEqual([
      { key: `${prefix}poster.jpg`, ttlSeconds: 3600, responseContentType: 'image/jpeg' },
    ]);
    await expect(h.facade.presignImage(id, 'w750')).rejects.toBeInstanceOf(MediaPurposeMismatch);
  });

  it('presigns resource downloads as attachment + octet-stream with the download TTL', async () => {
    const h = createMediaHarness();
    const asset = h.assets.add(
      assetRecord({
        id: '00000000-0000-7000-8000-0000000000d1',
        purpose: 'LECTURE_RESOURCE',
        status: 'READY',
        outputPrefix: 'assets/00000000-0000-7000-8000-0000000000d1/a1/',
      }),
    );
    const signed = await h.facade.presignDownload(asset.id, 'Slides "v2".pdf');
    expect(signed.expiresAt).toBe(new Date(Date.UTC(2026, 9, 10, 13, 5, 0)).toISOString());
    expect(h.storage.presignedGets).toEqual([
      {
        key: 'assets/00000000-0000-7000-8000-0000000000d1/a1/resource',
        ttlSeconds: 300,
        responseContentType: 'application/octet-stream',
        responseContentDisposition: expect.stringMatching(
          /^attachment; filename="Slides _v2_.pdf"/,
        ),
      },
    ]);
  });
});

describe('PlaylistCache', () => {
  it('evicts the least recently used entry by count and by size', () => {
    const cache = new PlaylistCache(2, 10);
    cache.set('a', '1234');
    cache.set('b', '1234');
    expect(cache.get('a')).toBe('1234'); // a is now most recent
    cache.set('c', '12');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.count).toBe(2);
    cache.set('d', '123456789');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('d')).toBe('123456789');
    cache.set('huge', 'x'.repeat(11));
    expect(cache.get('huge')).toBeUndefined();
  });
});
