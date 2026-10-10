import { describe, expect, it } from 'vitest';
import { StorageUsageError } from './errors';
import {
  assertRenditionName,
  assetOutputPrefix,
  assetPrefix,
  hlsSegmentKey,
  hlsVariantPlaylistKey,
  imageKey,
  type ImageVariant,
  parseAssetOutputPrefix,
  parseUploadSourceKey,
  resolvePlaylistUri,
  resourceKey,
  spriteImageKey,
  spriteVttKey,
  uploadSourceKey,
} from './keys';

const OWNER = '0b8e2c1a-1111-4a2b-8c3d-000000000001';
const ASSET = '7d4f9e2b-2222-4c5d-9e6f-000000000002';
const OUT = `assets/${ASSET}/a2/`;

describe('upload keys', () => {
  it('builds uploads/{ownerId}/{assetId}/source (design §4)', () => {
    expect(uploadSourceKey(OWNER, ASSET)).toBe(`uploads/${OWNER}/${ASSET}/source`);
  });

  it('round-trips through parseUploadSourceKey', () => {
    expect(parseUploadSourceKey(uploadSourceKey(OWNER, ASSET))).toEqual({
      ownerId: OWNER,
      assetId: ASSET,
    });
  });

  it.each([
    `uploads/${OWNER}/${ASSET}/source2`,
    `uploads/${OWNER}/${ASSET}/`,
    `uploads/${OWNER}/../${ASSET}/source`,
    `it-x/uploads/${OWNER}/${ASSET}/source`,
    'uploads/a/b/source',
  ])('parseUploadSourceKey(%s) is null', (key) => {
    expect(parseUploadSourceKey(key)).toBeNull();
  });

  it.each([
    ['not-a-uuid', ASSET],
    [OWNER.toUpperCase(), ASSET],
    [OWNER, '../../etc/passwd'],
    [OWNER, `${ASSET}/x`],
    ['', ASSET],
  ])('refuses ids (%s, %s)', (owner, asset) => {
    expect(() => uploadSourceKey(owner, asset)).toThrow(StorageUsageError);
  });
});

describe('media keys', () => {
  it('builds assets/{assetId}/ and assets/{assetId}/a{outputVersion}/', () => {
    expect(assetPrefix(ASSET)).toBe(`assets/${ASSET}/`);
    expect(assetOutputPrefix(ASSET, 2)).toBe(OUT);
    expect(OUT.startsWith(assetPrefix(ASSET))).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_000_001])('refuses outputVersion %d', (v) => {
    expect(() => assetOutputPrefix(ASSET, v)).toThrow(StorageUsageError);
  });

  it('round-trips through parseAssetOutputPrefix', () => {
    expect(parseAssetOutputPrefix(OUT)).toEqual({ assetId: ASSET, outputVersion: 2 });
    expect(parseAssetOutputPrefix(`assets/${ASSET}/a0/`)).toBeNull();
    expect(parseAssetOutputPrefix(`assets/${ASSET}/a2`)).toBeNull();
    expect(parseAssetOutputPrefix(`assets/${ASSET}/a2/hls/`)).toBeNull();
  });

  it('lays out HLS variants, segments, images, sprite and resource under the output prefix', () => {
    expect(hlsVariantPlaylistKey(OUT, '720p')).toBe(`${OUT}hls/720p/index.m3u8`);
    expect(hlsVariantPlaylistKey(OUT, 'src540p')).toBe(`${OUT}hls/src540p/index.m3u8`);
    expect(hlsSegmentKey(OUT, '360p', 0)).toBe(`${OUT}hls/360p/seg_00000.ts`);
    expect(hlsSegmentKey(OUT, '360p', 123)).toBe(`${OUT}hls/360p/seg_00123.ts`);
    expect(imageKey(OUT, 'w750')).toBe(`${OUT}w750.jpg`);
    expect(imageKey(OUT, 'w480')).toBe(`${OUT}w480.jpg`);
    expect(imageKey(OUT, 'poster')).toBe(`${OUT}poster.jpg`);
    expect(spriteImageKey(OUT)).toBe(`${OUT}sprite.jpg`);
    expect(spriteVttKey(OUT)).toBe(`${OUT}sprite.vtt`);
    expect(resourceKey(OUT)).toBe(`${OUT}resource`);
  });

  it.each(['poster', 'w750', 'sprite', '../720p', '720p/../../x', '2160p', '', 'src12p'])(
    'refuses %s as an HLS rendition',
    (name) => {
      expect(() => hlsVariantPlaylistKey(OUT, name)).toThrow(StorageUsageError);
    },
  );

  it('refuses keys under a foreign or malformed output prefix', () => {
    expect(() => imageKey('assets/x/a1/', 'w750')).toThrow(StorageUsageError);
    expect(() => resourceKey(`uploads/${OWNER}/${ASSET}/`)).toThrow(StorageUsageError);
    expect(() => imageKey(OUT, 'sprite' as ImageVariant)).toThrow(StorageUsageError);
    expect(() => hlsSegmentKey(OUT, '360p', 100_000)).toThrow(StorageUsageError);
  });

  it('validates rendition names like the DB CHECK', () => {
    for (const ok of [
      '360p',
      '480p',
      '720p',
      '1080p',
      'src540p',
      'src1440p',
      'w750',
      'w480',
      'poster',
      'sprite',
    ]) {
      expect(() => assertRenditionName(ok)).not.toThrow();
    }
    for (const bad of ['240p', 'src1p', 'w100', 'poster.jpg', '720p\n']) {
      expect(() => assertRenditionName(bad)).toThrow(StorageUsageError);
    }
  });
});

describe('resolvePlaylistUri', () => {
  const playlist = hlsVariantPlaylistKey(OUT, '720p');

  it('resolves segment lines against the playlist directory', () => {
    expect(resolvePlaylistUri(playlist, 'seg_00007.ts')).toBe(`${OUT}hls/720p/seg_00007.ts`);
    expect(resolvePlaylistUri(playlist, 'sub/seg_1.ts')).toBe(`${OUT}hls/720p/sub/seg_1.ts`);
  });

  it.each([
    '../360p/seg_00000.ts',
    './seg.ts',
    '/assets/x/seg.ts',
    'http://evil.example/seg.ts',
    'seg.ts?x=1',
    'seg.ts#f',
    '..',
    'a/../../b.ts',
    '',
    '.hidden',
  ])('refuses %s', (uri) => {
    expect(() => resolvePlaylistUri(playlist, uri)).toThrow(StorageUsageError);
  });
});
