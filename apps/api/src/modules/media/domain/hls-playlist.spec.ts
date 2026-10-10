import { describe, expect, it } from 'vitest';
import {
  parseVariantPlaylist,
  playlistUris,
  renderMasterPlaylist,
  serializePlaylist,
} from './hls-playlist';
import { PlaylistRejected } from './media.errors';

const VARIANT = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXTINF:6.000000,',
  'seg_00000.ts',
  '#EXTINF:2.500000,',
  'seg_00001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

describe('renderMasterPlaylist (D7)', () => {
  it('lists the variants by bandwidth with relative URIs', () => {
    const text = renderMasterPlaylist([
      {
        name: '720p',
        bandwidthBps: 3_000_000,
        width: 1280,
        height: 720,
        codecs: 'avc1.4d401f,mp4a.40.2',
      },
      {
        name: '360p',
        bandwidthBps: 800_000,
        width: 640,
        height: 360,
        codecs: 'avc1.42c01e,mp4a.40.2',
      },
    ]);
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"',
        '360p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
        '720p.m3u8',
        '',
      ].join('\n'),
    );
  });

  it('refuses rows that would inject into the playlist', () => {
    expect(() =>
      renderMasterPlaylist([
        { name: '../x', bandwidthBps: 1, width: 1, height: 1, codecs: 'avc1' },
      ]),
    ).toThrow(PlaylistRejected);
    expect(() =>
      renderMasterPlaylist([
        { name: '360p', bandwidthBps: 1, width: 1, height: 1, codecs: 'a"\n#EXT' },
      ]),
    ).toThrow(PlaylistRejected);
  });
});

describe('variant playlist rewrite', () => {
  it('replaces every segment line and keeps the tags verbatim', () => {
    const lines = parseVariantPlaylist(VARIANT);
    expect(playlistUris(lines)).toEqual(['seg_00000.ts', 'seg_00001.ts']);
    const out = serializePlaylist(lines, (uri) => `https://media.test/${uri}?sig=1`);
    expect(out).toContain('#EXTINF:6.000000,\nhttps://media.test/seg_00000.ts?sig=1\n');
    expect(out).toContain('https://media.test/seg_00001.ts?sig=1\n#EXT-X-ENDLIST\n');
    expect(out.split('\n').filter((l) => l.endsWith('.ts'))).toEqual([]);
  });

  it('accepts CRLF and a BOM', () => {
    const lines = parseVariantPlaylist(`\uFEFF${VARIANT.replace(/\n/g, '\r\n')}`);
    expect(playlistUris(lines)).toHaveLength(2);
  });

  it.each([
    ['no header', 'seg_00000.ts\n'],
    [
      'an encryption key URI',
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil/key"\nseg.ts\n',
    ],
    ['an fMP4 init map', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg.m4s\n'],
    ['a nested playlist', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nother.m3u8\n'],
  ])('rejects a playlist with %s', (_name, text) => {
    expect(() => parseVariantPlaylist(text)).toThrow(PlaylistRejected);
  });

  it('fails loudly when a URI has no signed URL', () => {
    expect(() => serializePlaylist(parseVariantPlaylist(VARIANT), () => undefined)).toThrow(
      PlaylistRejected,
    );
  });
});
