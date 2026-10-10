import { hardenedInput, type ProbeProfile } from './whitelists';

/** ffprobe JSON is small; anything bigger than this is hostile (huge tag/stream lists). */
export const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

const SHOW_ENTRIES = [
  'format=format_name,duration',
  'stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,channels,sample_rate',
  'stream_disposition=attached_pic',
  'stream_side_data=rotation',
].join(':');

/** `ffprobe` arguments: allowlisted input, only the fields we read, compact JSON on stdout. */
export function buildProbeArgs(profile: ProbeProfile, inputPath: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...hardenedInput(profile, inputPath),
    '-show_entries',
    SHOW_ENTRIES,
    '-of',
    'json=compact=1',
  ];
}

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export interface ProbedVideoStream {
  readonly index: number;
  readonly codecName: string | null;
  /** Coded size (0 when unknown). */
  readonly width: number;
  readonly height: number;
  /** Display rotation normalised to 0, 90, 180 or 270. */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly sampleAspectRatio: Rational | null;
  /** Frames per second (avg, else r_frame_rate); null when unknown. */
  readonly frameRate: number | null;
  /** Cover art (an attached picture), not a real video track. */
  readonly attachedPic: boolean;
}

export interface ProbedAudioStream {
  readonly index: number;
  readonly codecName: string | null;
  readonly channels: number | null;
  readonly sampleRate: number | null;
}

export interface ProbeResult {
  readonly formatName: string;
  /** Container duration in seconds; null when absent or not a finite number. */
  readonly durationSeconds: number | null;
  readonly video: readonly ProbedVideoStream[];
  readonly audio: readonly ProbedAudioStream[];
}

export class ProbeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeParseError';
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseRational(value: unknown, separator: '/' | ':'): Rational | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(separator);
  if (parts.length !== 2) return null;
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    return null;
  }
  return { num, den };
}

function normaliseRotation(value: unknown): 0 | 90 | 180 | 270 {
  const degrees = finite(value);
  if (degrees === null) return 0;
  const quarter = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  return quarter as 0 | 90 | 180 | 270;
}

function rotationOf(stream: Json): 0 | 90 | 180 | 270 {
  const list = stream.side_data_list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isObject(entry) && entry.rotation !== undefined) return normaliseRotation(entry.rotation);
    }
  }
  return 0;
}

/** Parses `ffprobe -of json` output (see buildProbeArgs). Throws ProbeParseError when malformed. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    throw new ProbeParseError('ffprobe output is not JSON');
  }
  if (!isObject(root) || !isObject(root.format)) {
    throw new ProbeParseError('ffprobe output has no format section');
  }
  const formatName = str(root.format.format_name);
  if (formatName === null) throw new ProbeParseError('ffprobe reported no format name');
  const duration = finite(root.format.duration);
  const streams = Array.isArray(root.streams) ? root.streams.filter(isObject) : [];

  const video: ProbedVideoStream[] = [];
  const audio: ProbedAudioStream[] = [];
  for (const stream of streams) {
    const index = int(stream.index) ?? -1;
    if (stream.codec_type === 'video') {
      const disposition = isObject(stream.disposition) ? stream.disposition : {};
      const rate =
        parseRational(stream.avg_frame_rate, '/') ?? parseRational(stream.r_frame_rate, '/');
      video.push({
        index,
        codecName: str(stream.codec_name),
        width: Math.max(0, int(stream.width) ?? 0),
        height: Math.max(0, int(stream.height) ?? 0),
        rotation: rotationOf(stream),
        sampleAspectRatio: parseRational(stream.sample_aspect_ratio, ':'),
        frameRate: rate === null ? null : rate.num / rate.den,
        attachedPic: int(disposition.attached_pic) === 1,
      });
    } else if (stream.codec_type === 'audio') {
      audio.push({
        index,
        codecName: str(stream.codec_name),
        channels: int(stream.channels),
        sampleRate: int(stream.sample_rate),
      });
    }
  }
  return {
    formatName,
    durationSeconds: duration !== null && duration > 0 ? duration : null,
    video,
    audio,
  };
}
