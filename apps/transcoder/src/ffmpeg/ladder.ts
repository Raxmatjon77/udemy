/**
 * The HLS ladder (design D15): 360p / 720p / 1080p, H.264 + AAC-LC, limited by the source and by
 * TRANSCODER_MAX_HEIGHT. A rung is defined by the SHORT side of the frame, so a portrait
 * 1080x1920 source gets the same three rungs as a landscape 1920x1080 one (720p = 720x1280).
 *
 * - A rung is included when its short side <= min(source short side, TRANSCODER_MAX_HEIGHT).
 * - Each rung scales the source to fit its box (640x360, 1280x720, 1920x1080, or the portrait
 *   transposes), keeping the display aspect ratio, never upscaling, both sides even (yuv420p).
 * - A source whose short side is below 360 gets one rendition at its own size, named
 *   `src{short}p` (the `asset_renditions_name_ck` vocabulary).
 * - Output frame rate is capped at 30 fps, which keeps every rung inside its H.264 level.
 */

export const MAX_OUTPUT_FPS = 30;
/** Rendition names (`src{n}p`) need 3-4 digits; smaller sources are rejected as INVALID_MEDIA. */
export const MIN_SOURCE_SHORT_SIDE = 100;
export const AUDIO_BITRATE_KBPS = 128;
export const AUDIO_CODECS = 'mp4a.40.2';

export interface LadderRung {
  readonly name: '360p' | '720p' | '1080p';
  readonly shortSide: number;
  readonly longSide: number;
  readonly videoKbps: number;
  readonly maxrateKbps: number;
  readonly bufsizeKbps: number;
  readonly profile: 'main' | 'high';
  readonly level: '3.0' | '3.1' | '4.0';
  /** RFC 6381 `avc1.PPCCLL` for the profile/level above. */
  readonly videoCodecs: string;
}

export const LADDER: readonly LadderRung[] = [
  {
    name: '360p',
    shortSide: 360,
    longSide: 640,
    videoKbps: 800,
    maxrateKbps: 856,
    bufsizeKbps: 1200,
    profile: 'main',
    level: '3.0',
    videoCodecs: 'avc1.4d401e',
  },
  {
    name: '720p',
    shortSide: 720,
    longSide: 1280,
    videoKbps: 2800,
    maxrateKbps: 2996,
    bufsizeKbps: 4200,
    profile: 'high',
    level: '3.1',
    videoCodecs: 'avc1.64001f',
  },
  {
    name: '1080p',
    shortSide: 1080,
    longSide: 1920,
    videoKbps: 5000,
    maxrateKbps: 5350,
    bufsizeKbps: 7500,
    profile: 'high',
    level: '4.0',
    videoCodecs: 'avc1.640028',
  },
];

export interface Rendition {
  /** `360p` | `720p` | `1080p` | `src{n}p`. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly videoKbps: number;
  readonly maxrateKbps: number;
  readonly bufsizeKbps: number;
  readonly profile: 'main' | 'high';
  readonly level: string;
  readonly videoCodecs: string;
}

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

function even(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

/** Fits `source` into `box` (keeping aspect, never upscaling); both sides even. */
export function fitInto(source: DisplaySize, box: DisplaySize): DisplaySize {
  const scale = Math.min(1, box.width / source.width, box.height / source.height);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

export function selectLadder(source: DisplaySize, maxShortSide: number): Rendition[] {
  if (!(source.width > 0 && source.height > 0)) {
    throw new RangeError(`invalid source size ${source.width}x${source.height}`);
  }
  const landscape = source.width >= source.height;
  const sourceShort = Math.min(source.width, source.height);
  const cap = Math.min(sourceShort, maxShortSide);

  const rungs = LADDER.filter((rung) => rung.shortSide <= cap);
  if (rungs.length === 0) {
    if (sourceShort < MIN_SOURCE_SHORT_SIDE) {
      throw new RangeError(`source short side ${sourceShort} < ${MIN_SOURCE_SHORT_SIDE}`);
    }
    const size = { width: even(source.width), height: even(source.height) };
    const base = LADDER[0] as LadderRung;
    return [
      {
        ...rungParams(base),
        name: `src${Math.min(size.width, size.height)}p`,
        width: size.width,
        height: size.height,
      },
    ];
  }

  return rungs.map((rung) => {
    const box = landscape
      ? { width: rung.longSide, height: rung.shortSide }
      : { width: rung.shortSide, height: rung.longSide };
    const size = fitInto(source, box);
    return { ...rungParams(rung), name: rung.name, width: size.width, height: size.height };
  });
}

function rungParams(rung: LadderRung): Omit<Rendition, 'name' | 'width' | 'height'> {
  return {
    videoKbps: rung.videoKbps,
    maxrateKbps: rung.maxrateKbps,
    bufsizeKbps: rung.bufsizeKbps,
    profile: rung.profile,
    level: rung.level,
    videoCodecs: rung.videoCodecs,
  };
}

/** `CODECS` of a variant: video, plus AAC-LC when the source has audio. */
export function renditionCodecs(rendition: Rendition, hasAudio: boolean): string {
  return hasAudio ? `${rendition.videoCodecs},${AUDIO_CODECS}` : rendition.videoCodecs;
}
