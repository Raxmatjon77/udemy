import { describe, expect, it } from 'vitest';
import { parseProbeOutput, ProbeParseError } from './probe';

describe('parseProbeOutput', () => {
  it('reads format, video (rotation, SAR, fps, cover art) and audio streams', () => {
    const json = JSON.stringify({
      programs: [],
      streams: [
        {
          index: 0,
          codec_name: 'h264',
          codec_type: 'video',
          width: 1920,
          height: 1080,
          sample_aspect_ratio: '1:1',
          avg_frame_rate: '30000/1001',
          disposition: { attached_pic: 0 },
          side_data_list: [{ rotation: -90 }],
        },
        { index: 1, codec_name: 'aac', codec_type: 'audio', sample_rate: '48000', channels: 2 },
        {
          index: 2,
          codec_name: 'mjpeg',
          codec_type: 'video',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
        { index: 3, codec_type: 'data' },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.005000' },
    });
    const result = parseProbeOutput(json);
    expect(result.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(result.durationSeconds).toBe(5.005);
    expect(result.video[0]).toMatchObject({
      width: 1920,
      height: 1080,
      rotation: 270,
      attachedPic: false,
    });
    expect(result.video[0]?.frameRate).toBeCloseTo(29.97, 2);
    expect(result.video[1]).toMatchObject({ attachedPic: true });
    expect(result.audio).toEqual([{ index: 1, codecName: 'aac', channels: 2, sampleRate: 48000 }]);
  });

  it('treats absent, N/A, zero or negative durations as null and 0/0 rates as unknown', () => {
    const base = {
      streams: [
        {
          codec_type: 'video',
          avg_frame_rate: '0/0',
          r_frame_rate: '0/0',
          sample_aspect_ratio: '0:1',
        },
      ],
    };
    for (const duration of [undefined, 'N/A', '0.000000', '-1']) {
      const result = parseProbeOutput(
        JSON.stringify({ ...base, format: { format_name: 'matroska,webm', duration } }),
      );
      expect(result.durationSeconds).toBeNull();
      expect(result.video[0]).toMatchObject({
        frameRate: null,
        sampleAspectRatio: null,
        width: 0,
        rotation: 0,
      });
    }
  });

  it('throws ProbeParseError for non-JSON or a missing format', () => {
    expect(() => parseProbeOutput('{\n')).toThrow(ProbeParseError);
    expect(() => parseProbeOutput('{"streams":[]}')).toThrow(ProbeParseError);
    expect(() => parseProbeOutput('{"format":{}}')).toThrow(/no format name/);
  });
});
