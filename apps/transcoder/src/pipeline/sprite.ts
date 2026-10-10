import type { DisplaySize } from '../ffmpeg/ladder';

/**
 * Seek-preview sprite (design §5): one frame every 10 s (longer intervals for long videos, so the
 * sheet never exceeds 10x10 tiles), long side of each tile 160 px, plus a WebVTT index whose cues
 * point at `sprite.jpg#xywh=x,y,w,h` (relative to the VTT, same output prefix).
 */
export const SPRITE_MIN_INTERVAL_SECONDS = 10;
export const SPRITE_MAX_TILES = 100;
export const SPRITE_COLUMNS = 10;
export const SPRITE_TILE_LONG_SIDE = 160;
export const SPRITE_IMAGE_FILENAME = 'sprite.jpg';

export interface SpritePlan {
  readonly intervalSeconds: number;
  readonly tiles: number;
  readonly columns: number;
  readonly rows: number;
  readonly tile: DisplaySize;
}

function even(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

export function planSprite(durationSeconds: number, display: DisplaySize): SpritePlan {
  if (!(durationSeconds > 0)) throw new RangeError(`invalid duration ${durationSeconds}`);
  const intervalSeconds = Math.max(
    SPRITE_MIN_INTERVAL_SECONDS,
    Math.ceil(durationSeconds / SPRITE_MAX_TILES),
  );
  const tiles = Math.min(
    SPRITE_MAX_TILES,
    Math.max(1, Math.ceil(durationSeconds / intervalSeconds)),
  );
  const columns = Math.min(SPRITE_COLUMNS, tiles);
  const rows = Math.ceil(tiles / columns);
  const landscape = display.width >= display.height;
  const tile = landscape
    ? {
        width: SPRITE_TILE_LONG_SIDE,
        height: even((SPRITE_TILE_LONG_SIDE * display.height) / display.width),
      }
    : {
        width: even((SPRITE_TILE_LONG_SIDE * display.width) / display.height),
        height: SPRITE_TILE_LONG_SIDE,
      };
  return { intervalSeconds, tiles, columns, rows, tile };
}

/** `HH:MM:SS.mmm` */
export function vttTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function buildSpriteVtt(plan: SpritePlan, durationSeconds: number): string {
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < plan.tiles; i++) {
    const start = i * plan.intervalSeconds;
    const end = Math.min((i + 1) * plan.intervalSeconds, durationSeconds);
    if (end <= start) break;
    const x = (i % plan.columns) * plan.tile.width;
    const y = Math.floor(i / plan.columns) * plan.tile.height;
    lines.push(
      `${vttTimestamp(start)} --> ${vttTimestamp(end)}`,
      `${SPRITE_IMAGE_FILENAME}#xywh=${x},${y},${plan.tile.width},${plan.tile.height}`,
      '',
    );
  }
  return lines.join('\n');
}
