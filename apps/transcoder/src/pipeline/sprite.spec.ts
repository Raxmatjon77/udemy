import { describe, expect, it } from 'vitest';
import { buildSpriteVtt, planSprite, vttTimestamp } from './sprite';

describe('planSprite', () => {
  it('one tile per 10 s, up to 10 columns', () => {
    expect(planSprite(25, { width: 1280, height: 720 })).toEqual({
      intervalSeconds: 10,
      tiles: 3,
      columns: 3,
      rows: 1,
      tile: { width: 160, height: 90 },
    });
    expect(planSprite(5, { width: 1280, height: 720 })).toMatchObject({
      tiles: 1,
      columns: 1,
      rows: 1,
    });
    expect(planSprite(605, { width: 1920, height: 1080 })).toMatchObject({
      tiles: 61,
      columns: 10,
      rows: 7,
    });
  });

  it('stretches the interval so long videos stay within 10x10 tiles', () => {
    expect(planSprite(4 * 3600, { width: 1920, height: 1080 })).toMatchObject({
      intervalSeconds: 144,
      tiles: 100,
      columns: 10,
      rows: 10,
    });
  });

  it('portrait tiles keep the 160 px long side', () => {
    expect(planSprite(30, { width: 540, height: 960 }).tile).toEqual({ width: 90, height: 160 });
  });
});

describe('buildSpriteVtt', () => {
  it('cues map time ranges to sprite.jpg regions; the last cue ends at the duration', () => {
    const plan = planSprite(25, { width: 1280, height: 720 });
    expect(buildSpriteVtt(plan, 25)).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:10.000',
        'sprite.jpg#xywh=0,0,160,90',
        '',
        '00:00:10.000 --> 00:00:20.000',
        'sprite.jpg#xywh=160,0,160,90',
        '',
        '00:00:20.000 --> 00:00:25.000',
        'sprite.jpg#xywh=320,0,160,90',
        '',
      ].join('\n'),
    );
  });

  it('wraps rows after 10 columns', () => {
    const vtt = buildSpriteVtt(planSprite(115, { width: 1280, height: 720 }), 115);
    expect(vtt).toContain('00:01:40.000 --> 00:01:50.000\nsprite.jpg#xywh=0,90,160,90');
    expect(vttTimestamp(3723.4567)).toBe('01:02:03.457');
  });
});
