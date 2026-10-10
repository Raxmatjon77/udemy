import { describe, expect, it } from 'vitest';
import {
  buildHlsArgs,
  buildImageArgs,
  buildPosterArgs,
  buildSpriteArgs,
  ffmpegSeconds,
} from './args';
import { selectLadder } from './ladder';
import { buildProbeArgs } from './probe';

/**
 * The exact argument vectors are part of the security boundary (§9: allowlists, no network
 * protocols, -nostdin, capped threads), so they are pinned verbatim.
 */
const IN = '/tmp/transcoder/a-a1-x/source';
const OUT = '/tmp/transcoder/a-a1-x/out';

describe('buildProbeArgs', () => {
  it('video: protocol + demuxer allowlists, pixel cap, only the fields we read', () => {
    expect(buildProbeArgs('video', IN)).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi",
        "-max_pixels",
        "8847360",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-show_entries",
        "format=format_name,duration:stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,channels,sample_rate:stream_disposition=attached_pic:stream_side_data=rotation",
        "-of",
        "json=compact=1",
      ]
    `);
  });

  it('image: only the *_pipe image demuxers (no image2) and the 40 MP cap', () => {
    expect(buildProbeArgs('image', IN)).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "png_pipe,jpeg_pipe,webp_pipe",
        "-max_pixels",
        "40000000",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-show_entries",
        "format=format_name,duration:stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,channels,sample_rate:stream_disposition=attached_pic:stream_side_data=rotation",
        "-of",
        "json=compact=1",
      ]
    `);
  });
});

describe('buildHlsArgs', () => {
  it('two rungs with audio, threads capped at 2', () => {
    const renditions = selectLadder({ width: 1280, height: 720 }, 720);
    expect(
      buildHlsArgs({
        inputPath: IN,
        outputDir: OUT,
        renditions,
        hasAudio: true,
        capFrameRate: false,
        threads: 2,
        maxOutputSeconds: 14_400,
      }),
    ).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi",
        "-max_pixels",
        "8847360",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-filter_complex",
        "[0:v:0]split=2[s0][s1];[s0]scale=w=640:h=360:flags=bicubic,setsar=1,format=yuv420p[v0];[s1]scale=w=1280:h=720:flags=bicubic,setsar=1,format=yuv420p[v1]",
        "-filter_complex_threads",
        "2",
        "-map",
        "[v0]",
        "-map",
        "0:a:0",
        "-map",
        "[v1]",
        "-map",
        "0:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "2",
        "-sc_threshold",
        "0",
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        "-profile:v:0",
        "main",
        "-level:v:0",
        "3.0",
        "-b:v:0",
        "800k",
        "-maxrate:v:0",
        "856k",
        "-bufsize:v:0",
        "1200k",
        "-profile:v:1",
        "high",
        "-level:v:1",
        "3.1",
        "-b:v:1",
        "2800k",
        "-maxrate:v:1",
        "2996k",
        "-bufsize:v:1",
        "4200k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-t",
        "14400",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "mpegts",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        "/tmp/transcoder/a-a1-x/out/hls/%v/seg_%05d.ts",
        "-var_stream_map",
        "v:0,a:0,name:360p v:1,a:1,name:720p",
        "-progress",
        "pipe:1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/hls/%v/index.m3u8",
      ]
    `);
  });

  it('no audio, 60 fps source (fps=30 added), threads auto', () => {
    const renditions = selectLadder({ width: 640, height: 360 }, 1080);
    expect(
      buildHlsArgs({
        inputPath: IN,
        outputDir: OUT,
        renditions,
        hasAudio: false,
        capFrameRate: true,
        threads: 0,
        maxOutputSeconds: 600,
      }),
    ).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-threads",
        "0",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi",
        "-max_pixels",
        "8847360",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-filter_complex",
        "[0:v:0]split=1[s0];[s0]scale=w=640:h=360:flags=bicubic,setsar=1,fps=30,format=yuv420p[v0]",
        "-map",
        "[v0]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "0",
        "-sc_threshold",
        "0",
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        "-profile:v:0",
        "main",
        "-level:v:0",
        "3.0",
        "-b:v:0",
        "800k",
        "-maxrate:v:0",
        "856k",
        "-bufsize:v:0",
        "1200k",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-t",
        "600",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "mpegts",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        "/tmp/transcoder/a-a1-x/out/hls/%v/seg_%05d.ts",
        "-var_stream_map",
        "v:0,name:360p",
        "-progress",
        "pipe:1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/hls/%v/index.m3u8",
      ]
    `);
  });

  it('refuses relative paths, empty ladders, odd sizes and bad thread counts', () => {
    const renditions = selectLadder({ width: 640, height: 360 }, 1080);
    const base = {
      inputPath: IN,
      outputDir: OUT,
      renditions,
      hasAudio: true,
      capFrameRate: false,
      threads: 1,
      maxOutputSeconds: 60,
    };
    expect(() => buildHlsArgs({ ...base, inputPath: 'source' })).toThrow(/absolute/);
    expect(() => buildHlsArgs({ ...base, inputPath: 'http://evil/x' })).toThrow(/absolute/);
    expect(() => buildHlsArgs({ ...base, renditions: [] })).toThrow(/no renditions/);
    expect(() =>
      buildHlsArgs({ ...base, renditions: [{ ...renditions[0]!, width: 641 }] }),
    ).toThrow(/invalid output size/);
    expect(() => buildHlsArgs({ ...base, threads: -1 })).toThrow(/threads/);
    expect(() => buildHlsArgs({ ...base, maxOutputSeconds: 0 })).toThrow(/maxOutputSeconds/);
  });
});

describe('buildPosterArgs / buildSpriteArgs', () => {
  it('poster: input seek, one JPEG frame, metadata stripped, bitexact', () => {
    expect(
      buildPosterArgs({
        inputPath: IN,
        outputPath: `${OUT}/poster.jpg`,
        size: { width: 1280, height: 720 },
        atSeconds: 0.5,
        threads: 1,
      }),
    ).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi",
        "-max_pixels",
        "8847360",
        "-ss",
        "0.500",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=w=1280:h=720:flags=bicubic,setsar=1,format=yuvj420p",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/poster.jpg",
      ]
    `);
  });

  it('sprite: fps sampling + tile', () => {
    expect(
      buildSpriteArgs({
        inputPath: IN,
        outputPath: `${OUT}/sprite.jpg`,
        tile: { width: 160, height: 90 },
        columns: 10,
        rows: 3,
        intervalSeconds: 10,
        threads: 1,
      }),
    ).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi",
        "-max_pixels",
        "8847360",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-map",
        "0:v:0",
        "-vf",
        "select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,10),scale=w=160:h=90:flags=bicubic,setsar=1,tile=10x3,format=yuvj420p",
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-c:v",
        "mjpeg",
        "-q:v",
        "5",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/sprite.jpg",
      ]
    `);
  });

  it('formats seek times with millisecond precision', () => {
    expect(ffmpegSeconds(0)).toBe('0.000');
    expect(ffmpegSeconds(12.3456)).toBe('12.346');
    expect(() => ffmpegSeconds(-1)).toThrow(RangeError);
    expect(() => ffmpegSeconds(Number.NaN)).toThrow(RangeError);
  });
});

describe('buildImageArgs', () => {
  it('thumbnail variants: cover-scale + centre-crop each, JPEG, no metadata', () => {
    expect(
      buildImageArgs({
        inputPath: IN,
        outputs: [
          { outputPath: `${OUT}/w750.jpg`, size: { width: 750, height: 422 } },
          { outputPath: `${OUT}/w480.jpg`, size: { width: 480, height: 270 } },
          { outputPath: `${OUT}/poster.jpg`, size: { width: 1280, height: 720 } },
        ],
        threads: 1,
      }),
    ).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "png_pipe,jpeg_pipe,webp_pipe",
        "-max_pixels",
        "40000000",
        "-i",
        "file:/tmp/transcoder/a-a1-x/source",
        "-filter_complex",
        "[0:v:0]split=3[s0][s1][s2];[s0]scale=w=750:h=422:force_original_aspect_ratio=increase:flags=lanczos,crop=w=750:h=422,setsar=1,format=yuvj420p[o0];[s1]scale=w=480:h=270:force_original_aspect_ratio=increase:flags=lanczos,crop=w=480:h=270,setsar=1,format=yuvj420p[o1];[s2]scale=w=1280:h=720:force_original_aspect_ratio=increase:flags=lanczos,crop=w=1280:h=720,setsar=1,format=yuvj420p[o2]",
        "-filter_complex_threads",
        "1",
        "-map",
        "[o0]",
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/w750.jpg",
        "-map",
        "[o1]",
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/w480.jpg",
        "-map",
        "[o2]",
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        "/tmp/transcoder/a-a1-x/out/poster.jpg",
      ]
    `);
  });
});

describe('hardening invariants (every builder)', () => {
  const all = [
    buildProbeArgs('video', IN),
    buildProbeArgs('image', IN),
    buildHlsArgs({
      inputPath: IN,
      outputDir: OUT,
      renditions: selectLadder({ width: 1920, height: 1080 }, 1080),
      hasAudio: true,
      capFrameRate: false,
      threads: 0,
      maxOutputSeconds: 60,
    }),
    buildPosterArgs({
      inputPath: IN,
      outputPath: `${OUT}/p.jpg`,
      size: { width: 640, height: 360 },
      atSeconds: 1,
      threads: 0,
    }),
    buildSpriteArgs({
      inputPath: IN,
      outputPath: `${OUT}/s.jpg`,
      tile: { width: 160, height: 90 },
      columns: 1,
      rows: 1,
      intervalSeconds: 10,
      threads: 0,
    }),
    buildImageArgs({
      inputPath: IN,
      outputs: [{ outputPath: `${OUT}/w.jpg`, size: { width: 480, height: 270 } }],
      threads: 0,
    }),
  ];

  it.each(all.map((args, i) => [i, args] as const))(
    'builder %i reads only file: with allowlists',
    (_, args) => {
      const input = args.indexOf('-i');
      expect(args[input + 1]).toBe(`file:${IN}`);
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
      expect(args.indexOf('-protocol_whitelist')).toBeLessThan(input);
      expect(args.indexOf('-format_whitelist')).toBeLessThan(input);
      expect(args.indexOf('-max_pixels')).toBeLessThan(input);
      expect(args.join(' ')).not.toMatch(/https?:|tcp:|udp:|rtmp|concat|lavfi|subfile|data:/);
    },
  );

  it.each(all.slice(2).map((args, i) => [i, args] as const))(
    'ffmpeg builder %i never reads stdin',
    (_, args) => {
      expect(args).toContain('-nostdin');
    },
  );
});
