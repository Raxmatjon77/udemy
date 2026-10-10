import { describe, expect, it } from 'vitest';
import { TranscodeFailure } from './failure';
import { parseVariantPlaylist, peakBandwidthBps } from './outputs';

const VALID = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.000000,
seg_00000.ts
#EXTINF:3.500000,
seg_00001.ts
#EXT-X-ENDLIST
`;

describe('parseVariantPlaylist', () => {
  it('returns the segments of a valid ffmpeg playlist', () => {
    expect(parseVariantPlaylist(VALID)).toEqual([
      { uri: 'seg_00000.ts', index: 0, durationSeconds: 6 },
      { uri: 'seg_00001.ts', index: 1, durationSeconds: 3.5 },
    ]);
  });

  it.each([
    ['an absolute URI', VALID.replace('seg_00001.ts', 'https://evil.example/x.ts')],
    ['a path traversal', VALID.replace('seg_00001.ts', '../../x.ts')],
    ['a file URI', VALID.replace('seg_00001.ts', 'file:///etc/passwd')],
    ['out-of-order segments', VALID.replace('seg_00001.ts', 'seg_00003.ts')],
    ['no ENDLIST', VALID.replace('#EXT-X-ENDLIST', '')],
    ['an EVENT playlist', VALID.replace('VOD', 'EVENT')],
    ['HLS v6', VALID.replace('VERSION:3', 'VERSION:6')],
    ['a URI without EXTINF', VALID.replace('#EXTINF:3.500000,\n', '')],
    ['no segments', '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n'],
  ])('rejects %s as TRANSCODE_ERROR', (_, text) => {
    expect(() => parseVariantPlaylist(text)).toThrow(TranscodeFailure);
  });
});

describe('peakBandwidthBps', () => {
  it('is the highest segment bitrate, ignoring a short tail segment', () => {
    expect(
      peakBandwidthBps([
        { durationSeconds: 6, bytes: 600_000 },
        { durationSeconds: 6, bytes: 900_000 },
        { durationSeconds: 0.2, bytes: 100_000 },
      ]),
    ).toBe(1_200_000);
  });

  it('uses short segments when they are all there is', () => {
    expect(peakBandwidthBps([{ durationSeconds: 0.5, bytes: 1000 }])).toBe(16_000);
  });
});
