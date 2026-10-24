/**
 * Framework-free playback controller behind `<HlsPlayer>` (design D7 and §10).
 *
 * Playlists come from the BFF (`/api/proxy/.../master.m3u8`); the variant playlists list
 * presigned MinIO segment URLs that expire after an hour (`MEDIA_PLAYBACK_URL_TTL_S`). A long
 * session (pause, come back later) therefore eventually sees segment GETs fail with 403. The
 * controller reacts by re-fetching the playlists (which re-signs every segment) and resuming at
 * the same position, with a bounded backoff, and gives up with a clear error state when that
 * keeps failing.
 *
 * State machine (`PlayerStatus.kind`):
 *
 * ```
 *   idle ──start()──▶ loading ──manifest parsed──▶ ready
 *                       │                            │  ▲
 *                       │ master 401/403/404/409,    │  │ first fragment after the reload
 *                       │ fatal network/media error  │  │
 *                       ▼                            ▼  │
 *                     error ◀──attempts exhausted── refreshing(attempt n)
 *                       │      or master refused      ▲  │ 403 on a segment or variant playlist:
 *                       │                             │  │ remember currentTime + playing,
 *                       └──retry() (user)──▶ loading  │  │ stopLoad, wait backoff[n-1],
 *                                                     └──┘ loadSource(src), startLoad(resumeAt)
 * ```
 *
 * - Attempts are counted per "incident": the counter resets once playback has been healthy (a
 *   fragment loaded) for `healthyResetMs` after the last refresh. A normal hourly expiry is
 *   therefore always attempt 1 and is retried immediately; fresh URLs failing again within a
 *   minute (a real authorization problem, clock skew) back off and stop after `maxAttempts`.
 * - Duplicate 403s while a refresh is pending are ignored (hls.js reports one per loader).
 * - A 403 on the MASTER playlist is not an expiry: it is the API refusing access
 *   (`lecture_locked`); it ends in `error/forbidden` without retries.
 * - hls.js is used whenever MSE (or ManagedMediaSource) is available, including desktop Safari:
 *   only hls.js exposes the HTTP status of a failed segment. Native HLS is the fallback when MSE
 *   is missing (older iOS); there a `MEDIA_ERR_NETWORK` after a successful start is treated as a
 *   possible expiry and handled by the same bounded refresh (re-set `src`, seek, resume).
 */

export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export type PlayerErrorReason =
  /** The API refused the playlist (403, e.g. `lecture_locked`). */
  | 'forbidden'
  /** The session ended (final 401 from the BFF). */
  | 'unauthorized'
  /** 404: no such lecture or no video. */
  | 'not-found'
  /** 409 `media_not_ready`: still transcoding. */
  | 'not-ready'
  /** Segment URLs kept failing after `maxAttempts` playlist refreshes. */
  | 'expired'
  /** Network failure, timeout, 429 or 5xx. */
  | 'network'
  /** The media could not be decoded. */
  | 'media'
  /** Neither MSE nor native HLS is available. */
  | 'unsupported';

export type PlayerStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'refreshing'; attempt: number }
  | {
      kind: 'error';
      reason: PlayerErrorReason;
      httpStatus?: number;
      /** The stable problem `code` of a refused master playlist (problem+json body), if any. */
      code?: string;
      /** `Retry-After` of a refused master playlist (429), in seconds. */
      retryAfterSeconds?: number;
    };

/** What a failed playlist response said about itself (hls.js passes the XHR along). */
export interface PlaylistProblem {
  code?: string;
  retryAfterSeconds?: number;
}

export interface RefreshPolicy {
  /** Playlist reloads per incident before giving up. */
  maxAttempts: number;
  /** Delay before reload n (index n-1); the last entry repeats. */
  backoffMs: readonly number[];
  /** Healthy playback after a refresh for this long resets the attempt counter. */
  healthyResetMs: number;
}

export const DEFAULT_REFRESH_POLICY: RefreshPolicy = Object.freeze({
  maxAttempts: 3,
  backoffMs: Object.freeze([0, 2_000, 8_000]),
  healthyResetMs: 60_000,
});

/** The subset of `HTMLVideoElement` the controller uses (a plain object in unit tests). */
export interface PlaybackMedia {
  currentTime: number;
  readonly paused: boolean;
  readonly error: { readonly code: number } | null;
  src: string;
  play(): Promise<void> | void;
  load(): void;
  removeAttribute(name: string): void;
  canPlayType(type: string): string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The subset of an hls.js error event payload the controller reads. */
export interface HlsErrorData {
  type: string;
  details: string;
  fatal: boolean;
  response?: { code?: number } | undefined;
  /** The loader's request object (an `XMLHttpRequest` with the default loader). */
  networkDetails?: unknown;
}

interface ResponseLike {
  responseText?: unknown;
  getResponseHeader?: (name: string) => string | null;
}

/**
 * Reads the problem+json `code` and `Retry-After` of a failed playlist request from the XHR
 * hls.js reports as `networkDetails` (the master playlist is loaded as text, so the error body
 * is readable). Anything unexpected yields `{}`: the caller still has the HTTP status.
 */
export function playlistProblemOf(networkDetails: unknown): PlaylistProblem {
  if (typeof networkDetails !== 'object' || networkDetails === null) return {};
  const response = networkDetails as ResponseLike;
  const problem: PlaylistProblem = {};
  try {
    if (typeof response.responseText === 'string' && response.responseText.startsWith('{')) {
      const body = JSON.parse(response.responseText) as { code?: unknown };
      if (typeof body.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.code)) {
        problem.code = body.code;
      }
    }
  } catch {
    // not JSON (or not readable): no code
  }
  try {
    const raw = response.getResponseHeader?.('retry-after');
    const seconds = raw ? Number(raw) : Number.NaN;
    if (Number.isInteger(seconds) && seconds >= 0) problem.retryAfterSeconds = seconds;
  } catch {
    // headers not exposed
  }
  return problem;
}

type HlsListener = (event: string, data: never) => void;

/** The subset of an hls.js instance the controller uses. */
export interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(media: never): void;
  startLoad(startPosition?: number): void;
  stopLoad(): void;
  recoverMediaError(): void;
  destroy(): void;
  on(event: string, listener: HlsListener): void;
}

/** The subset of the hls.js default export (class + statics) the controller uses. */
export interface HlsConstructor {
  new (config: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  readonly Events: {
    readonly MANIFEST_PARSED: string;
    readonly FRAG_LOADED: string;
    readonly ERROR: string;
  };
  readonly ErrorTypes: { readonly NETWORK_ERROR: string; readonly MEDIA_ERROR: string };
  readonly ErrorDetails: {
    readonly MANIFEST_LOAD_ERROR: string;
    readonly LEVEL_LOAD_ERROR: string;
    readonly FRAG_LOAD_ERROR: string;
  };
}

export interface HlsPlaybackOptions {
  media: PlaybackMedia;
  /** Master playlist URL on the BFF. */
  src: string;
  /** Lazily imports hls.js (a dynamic `import()`, so pages without video never load it). */
  loadHls: () => Promise<HlsConstructor>;
  /** Whether MSE/ManagedMediaSource exists; checked before hls.js is even downloaded. */
  hasMediaSource: () => boolean;
  onStatus: (status: PlayerStatus) => void;
  /** Where the first load starts, in seconds (resume position); default the beginning. */
  startPosition?: number;
  policy?: Partial<RefreshPolicy>;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
}

/** hls.js settings: start loading only when we say where; never send cookies to MinIO. */
export const HLS_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  autoStartLoad: false,
  enableWorker: true, // transmuxing off the main thread (CSP: worker-src blob:)
  lowLatencyMode: false,
  backBufferLength: 90,
  // Segment GETs go cross-origin to MinIO with a capability URL: no cookies, no credentials.
  xhrSetup: (xhr: XMLHttpRequest) => {
    xhr.withCredentials = false;
  },
});

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

function reasonForHttpStatus(code: number | undefined): PlayerErrorReason {
  switch (code) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      return 'not-ready';
    default:
      return 'network';
  }
}

/** 0 (network), timeouts, 429 and 5xx are worth another refresh attempt. */
function isTransient(code: number | undefined): boolean {
  return code === undefined || code === 0 || code === 429 || code >= 500;
}

export class HlsPlaybackController {
  private readonly policy: RefreshPolicy;
  private readonly now: () => number;
  private status: PlayerStatus = { kind: 'idle' };
  private mode: 'hls' | 'native' | null = null;
  private hls: HlsInstance | null = null;
  private Hls: HlsConstructor | null = null;
  private destroyed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Playlist reloads in the current incident. */
  private attempts = 0;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  /** A fragment loaded since the last (re)load: the reload worked. */
  private healthySinceRefresh = false;
  private resumeAt = 0;
  private resumePlaying = false;
  private mediaRecoveries = 0;
  private readonly nativeListeners: Array<[string, () => void]> = [];

  constructor(private readonly options: HlsPlaybackOptions) {
    this.policy = { ...DEFAULT_REFRESH_POLICY, ...options.policy };
    this.now = options.now ?? Date.now;
    const start = options.startPosition;
    if (start !== undefined && Number.isFinite(start) && start > 0) this.resumeAt = start;
  }

  get current(): PlayerStatus {
    return this.status;
  }

  /** Picks hls.js or native HLS and loads the master playlist. */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.setStatus({ kind: 'loading' });
    const { media, hasMediaSource, loadHls } = this.options;

    let Hls: HlsConstructor | null = null;
    if (hasMediaSource()) {
      try {
        Hls = await loadHls();
      } catch {
        Hls = null; // chunk failed to load: try native below, else report
      }
      if (this.destroyed || generation !== this.generation) return;
    }

    if (Hls?.isSupported()) {
      this.mode = 'hls';
      this.Hls = Hls;
      this.createHls(Hls);
      return;
    }
    if (media.canPlayType(HLS_MIME_TYPE)) {
      this.mode = 'native';
      this.startNative();
      return;
    }
    this.fail(Hls === null && hasMediaSource() ? 'network' : 'unsupported');
  }

  /** User-initiated retry from the error state: a fresh incident at the last known position. */
  retry(): void {
    if (this.destroyed) return;
    if (this.status.kind !== 'error') return;
    this.rememberPosition();
    this.attempts = 0;
    this.mediaRecoveries = 0;
    this.teardown();
    void this.start();
  }

  destroy(): void {
    this.destroyed = true;
    this.teardown();
  }

  /* ------------------------------------------------------------------ hls.js ---- */

  private createHls(Hls: HlsConstructor): void {
    const hls = new Hls({ ...HLS_CONFIG });
    this.hls = hls;
    const events = Hls.Events;
    hls.on(events.MANIFEST_PARSED, () => this.onManifestParsed());
    hls.on(events.FRAG_LOADED, () => this.onHealthy());
    hls.on(events.ERROR, ((_event: string, data: HlsErrorData) =>
      this.onHlsError(data)) as HlsListener);
    hls.attachMedia(this.options.media as never);
    hls.loadSource(this.options.src);
  }

  private onManifestParsed(): void {
    if (!this.hls) return;
    this.hls.startLoad(this.resumeAt > 0 ? this.resumeAt : -1);
    this.restorePosition();
    if (this.status.kind === 'loading') this.setStatus({ kind: 'ready' });
  }

  private onHealthy(): void {
    this.healthySinceRefresh = true;
    if (this.status.kind === 'refreshing' || this.status.kind === 'loading') {
      this.setStatus({ kind: 'ready' });
    }
  }

  private onHlsError(data: HlsErrorData): void {
    const Hls = this.Hls;
    if (!Hls || this.status.kind === 'error') return;
    const code = data.response?.code;
    const { ErrorDetails, ErrorTypes } = Hls;

    // Expired segment signature (or a refused variant playlist): reload the playlists.
    if (
      code === 403 &&
      (data.details === ErrorDetails.FRAG_LOAD_ERROR ||
        data.details === ErrorDetails.LEVEL_LOAD_ERROR)
    ) {
      this.scheduleRefresh();
      return;
    }

    if (data.details === ErrorDetails.MANIFEST_LOAD_ERROR) {
      // The master playlist is authorized by the API on every load.
      if (this.status.kind === 'refreshing' && isTransient(code)) {
        this.scheduleRefresh();
        return;
      }
      this.fail(reasonForHttpStatus(code), code, playlistProblemOf(data.networkDetails));
      return;
    }

    if (!data.fatal) return; // hls.js retries or switches levels on its own

    if (data.type === ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < 1) {
      this.mediaRecoveries += 1;
      this.hls?.recoverMediaError();
      return;
    }
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      this.fail(reasonForHttpStatus(code), code);
      return;
    }
    this.fail('media');
  }

  /* ------------------------------------------------------------------ native ---- */

  private startNative(): void {
    const { media } = this.options;
    const on = (type: string, listener: () => void) => {
      media.addEventListener(type, listener);
      this.nativeListeners.push([type, listener]);
    };
    on('loadedmetadata', () => {
      this.restorePosition();
      if (this.status.kind === 'loading') this.setStatus({ kind: 'ready' });
    });
    on('playing', () => this.onHealthy());
    on('error', () => this.onNativeError());
    media.src = this.options.src;
    media.load();
  }

  private onNativeError(): void {
    if (this.status.kind === 'error') return;
    const code = this.options.media.error?.code;
    // Native HLS hides HTTP statuses. A network error after playback worked is most likely an
    // expired segment URL; before that it is the master playlist itself failing.
    if (
      code === MEDIA_ERR_NETWORK &&
      (this.healthySinceRefresh || this.status.kind === 'refreshing')
    ) {
      this.scheduleRefresh();
      return;
    }
    this.fail(code === MEDIA_ERR_DECODE ? 'media' : 'network');
  }

  /* ------------------------------------------------------------------ refresh ---- */

  /**
   * Starts a refresh incident, or continues it when the reload itself failed (status is still
   * `refreshing` and no reload is pending). Ignored while a reload is already scheduled: hls.js
   * reports one 403 per failing loader.
   */
  private scheduleRefresh(): void {
    if (this.status.kind === 'error') return;
    const continuing = this.status.kind === 'refreshing';
    if (continuing && this.timer !== null) return;

    if (
      !continuing &&
      this.healthySinceRefresh &&
      this.now() - this.lastRefreshAt >= this.policy.healthyResetMs
    ) {
      this.attempts = 0; // the previous incident is over
    }
    this.attempts += 1;
    if (this.attempts > this.policy.maxAttempts) {
      this.fail('expired', 403);
      return;
    }
    if (!continuing) this.rememberPosition();
    this.setStatus({ kind: 'refreshing', attempt: this.attempts });
    this.hls?.stopLoad();

    const backoff = this.policy.backoffMs;
    const delay = backoff[Math.min(this.attempts - 1, backoff.length - 1)] ?? 0;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed || this.status.kind !== 'refreshing') return;
      this.lastRefreshAt = this.now();
      this.healthySinceRefresh = false;
      this.reload();
    }, delay);
  }

  private reload(): void {
    const { media, src } = this.options;
    if (this.mode === 'hls' && this.hls) {
      this.hls.loadSource(src); // re-fetches master + variants: fresh segment signatures
    } else if (this.mode === 'native') {
      media.src = src;
      media.load();
    }
  }

  private rememberPosition(): void {
    const { media } = this.options;
    if (Number.isFinite(media.currentTime) && media.currentTime > 0) {
      this.resumeAt = media.currentTime;
    }
    this.resumePlaying = !media.paused;
  }

  /** After a (re)load: seek back to where the viewer was and resume if they were playing. */
  private restorePosition(): void {
    const { media } = this.options;
    if (this.resumeAt > 0 && Math.abs(media.currentTime - this.resumeAt) > 0.5) {
      media.currentTime = this.resumeAt;
    }
    if (this.resumePlaying && media.paused) {
      this.resumePlaying = false;
      // Autoplay policies may refuse; the viewer then presses play.
      void Promise.resolve()
        .then(() => media.play())
        .catch(() => undefined);
    }
  }

  /* ------------------------------------------------------------------ plumbing ---- */

  private fail(
    reason: PlayerErrorReason,
    httpStatus?: number,
    problem: PlaylistProblem = {},
  ): void {
    this.clearTimer();
    this.hls?.stopLoad();
    this.setStatus(
      httpStatus === undefined || httpStatus === 0
        ? { kind: 'error', reason }
        : { kind: 'error', reason, httpStatus, ...problem },
    );
  }

  private teardown(): void {
    this.generation += 1;
    this.clearTimer();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const { media } = this.options;
    for (const [type, listener] of this.nativeListeners) media.removeEventListener(type, listener);
    this.nativeListeners.length = 0;
    if (this.mode === 'native') {
      media.removeAttribute('src');
      media.load();
    }
    this.mode = null;
    this.healthySinceRefresh = false;
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: PlayerStatus): void {
    this.status = status;
    if (!this.destroyed) this.options.onStatus(status);
  }
}
