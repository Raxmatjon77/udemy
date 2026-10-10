import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HLS_CONFIG,
  HlsPlaybackController,
  type HlsConstructor,
  type HlsErrorData,
  type PlaybackMedia,
  type PlayerStatus,
} from './hls-playback';

/* ----------------------------------------------------------------- mocked hls.js ---- */

const Events = {
  MANIFEST_PARSED: 'hlsManifestParsed',
  FRAG_LOADED: 'hlsFragLoaded',
  ERROR: 'hlsError',
} as const;
const ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' } as const;
const ErrorDetails = {
  MANIFEST_LOAD_ERROR: 'manifestLoadError',
  LEVEL_LOAD_ERROR: 'levelLoadError',
  FRAG_LOAD_ERROR: 'fragLoadError',
} as const;

class FakeHls {
  static supported = true;
  static instances: FakeHls[] = [];
  static isSupported() {
    return FakeHls.supported;
  }
  static Events = Events;
  static ErrorTypes = ErrorTypes;
  static ErrorDetails = ErrorDetails;

  readonly listeners = new Map<string, Array<(event: string, data: unknown) => void>>();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  startLoad = vi.fn();
  stopLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();

  constructor(readonly config: Record<string, unknown>) {
    FakeHls.instances.push(this);
  }
  on(event: string, listener: (event: string, data: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, data: unknown = {}) {
    for (const listener of this.listeners.get(event) ?? []) listener(event, data);
  }
  /* helpers */
  manifestParsed() {
    this.emit(Events.MANIFEST_PARSED);
  }
  fragLoaded() {
    this.emit(Events.FRAG_LOADED);
  }
  error(data: Partial<HlsErrorData> & { code?: number }) {
    const { code, ...rest } = data;
    this.emit(Events.ERROR, {
      type: ErrorTypes.NETWORK_ERROR,
      details: ErrorDetails.FRAG_LOAD_ERROR,
      fatal: false,
      ...(code === undefined ? {} : { response: { code } }),
      ...rest,
    });
  }
}

class FakeVideo implements PlaybackMedia {
  currentTime = 0;
  paused = true;
  error: { code: number } | null = null;
  src = '';
  play = vi.fn(() => {
    this.paused = false;
  });
  load = vi.fn();
  removeAttribute = vi.fn();
  canPlayType = vi.fn(() => '');
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const SRC = '/api/proxy/catalog/courses/c1/lectures/l1/hls/master.m3u8';

function setup(options: { mse?: boolean; loadFails?: boolean } = {}) {
  const video = new FakeVideo();
  const statuses: PlayerStatus[] = [];
  const loadHls = vi.fn(async () => {
    if (options.loadFails) throw new Error('ChunkLoadError');
    return FakeHls as unknown as HlsConstructor;
  });
  const controller = new HlsPlaybackController({
    media: video,
    src: SRC,
    loadHls,
    hasMediaSource: () => options.mse ?? true,
    onStatus: (status) => statuses.push(status),
  });
  const hls = () => FakeHls.instances.at(-1)!;
  return { video, statuses, controller, loadHls, hls, last: () => statuses.at(-1) };
}

/** Starts and plays until a fragment loaded at `time`, playing. */
async function playing(time = 1_234) {
  const ctx = setup();
  await ctx.controller.start();
  ctx.hls().manifestParsed();
  ctx.hls().fragLoaded();
  ctx.video.currentTime = time;
  ctx.video.paused = false;
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
  FakeHls.instances = [];
  FakeHls.supported = true;
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- tests ---- */

describe('start', () => {
  it('lazy-loads hls.js, attaches, loads the master and starts loading after the manifest', async () => {
    const { controller, loadHls, hls, video, statuses } = setup();
    expect(loadHls).not.toHaveBeenCalled(); // nothing happens at construction
    await controller.start();
    expect(loadHls).toHaveBeenCalledTimes(1);
    expect(hls().config).toMatchObject({ autoStartLoad: false, enableWorker: true });
    expect(hls().attachMedia).toHaveBeenCalledWith(video);
    expect(hls().loadSource).toHaveBeenCalledWith(SRC);
    expect(statuses).toEqual([{ kind: 'loading' }]);

    hls().manifestParsed();
    expect(hls().startLoad).toHaveBeenCalledWith(-1);
    expect(statuses.at(-1)).toEqual({ kind: 'ready' });
  });

  it('never sends credentials with segment requests', () => {
    const xhr = { withCredentials: true } as XMLHttpRequest;
    (HLS_CONFIG.xhrSetup as (x: XMLHttpRequest) => void)(xhr);
    expect(xhr.withCredentials).toBe(false);
  });

  it('falls back to native HLS without MSE, without downloading hls.js', async () => {
    const ctx = setup({ mse: false });
    ctx.video.canPlayType.mockReturnValue('maybe');
    await ctx.controller.start();
    expect(ctx.loadHls).not.toHaveBeenCalled();
    expect(ctx.video.src).toBe(SRC);
    ctx.video.dispatch('loadedmetadata');
    expect(ctx.last()).toEqual({ kind: 'ready' });
  });

  it('reports unsupported when there is neither MSE nor native HLS', async () => {
    const ctx = setup({ mse: false });
    await ctx.controller.start();
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'unsupported' });
  });

  it('reports a network error when the hls.js chunk fails to load', async () => {
    const ctx = setup({ loadFails: true });
    await ctx.controller.start();
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'network' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'not-ready'],
    [503, 'network'],
  ] as const)('master playlist %i ends in error/%s without retries', async (code, reason) => {
    const ctx = setup();
    await ctx.controller.start();
    ctx.hls().error({ details: ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true, code });
    expect(ctx.last()).toEqual({ kind: 'error', reason, httpStatus: code });
    vi.runAllTimers();
    expect(ctx.hls().loadSource).toHaveBeenCalledTimes(1);
  });
});

describe('403 refresh state machine', () => {
  it('a segment 403 reloads the playlists immediately and resumes where the viewer was', async () => {
    const ctx = await playing(1_234);
    const hls = ctx.hls();

    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });
    expect(hls.stopLoad).toHaveBeenCalledTimes(1);

    // hls.loadSource re-attaches the media: the element resets.
    ctx.video.currentTime = 0;
    ctx.video.paused = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(hls.loadSource).toHaveBeenLastCalledWith(SRC);

    hls.manifestParsed();
    expect(hls.startLoad).toHaveBeenLastCalledWith(1_234);
    expect(ctx.video.currentTime).toBe(1_234);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.video.play).toHaveBeenCalledTimes(1);
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });

    hls.fragLoaded();
    expect(ctx.last()).toEqual({ kind: 'ready' });
    expect(FakeHls.instances).toHaveLength(1); // same instance, no re-creation
  });

  it('a paused viewer stays paused after the refresh', async () => {
    const ctx = await playing(50);
    ctx.video.paused = true;
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    await vi.advanceTimersByTimeAsync(0);
    ctx.hls().manifestParsed();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.video.play).not.toHaveBeenCalled();
    expect(ctx.video.currentTime).toBe(50);
  });

  it('a variant playlist 403 also triggers the refresh', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.LEVEL_LOAD_ERROR, code: 403, fatal: true });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.hls().loadSource).toHaveBeenCalledTimes(2);
  });

  it('dedupes the burst of 403s while a reload is pending', async () => {
    const ctx = await playing();
    for (let i = 0; i < 5; i++) {
      ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.hls().loadSource).toHaveBeenCalledTimes(2);
    expect(ctx.statuses.filter((s) => s.kind === 'refreshing')).toHaveLength(1);
  });

  it('backs off (0 s, 2 s, 8 s) while fresh URLs keep failing, then gives up with error/expired', async () => {
    const ctx = await playing(300);
    const hls = ctx.hls();
    const reloads = () => hls.loadSource.mock.calls.length - 1;

    // attempt 1: immediate
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reloads()).toBe(1);
    hls.manifestParsed();

    // the reloaded playlist's segments fail again -> attempt 2 after 2 s
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 2 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reloads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloads()).toBe(2);
    hls.manifestParsed();

    // attempt 3 after 8 s
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 3 });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(reloads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloads()).toBe(3);
    hls.manifestParsed();

    // a 4th failure: give up
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'expired', httpStatus: 403 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reloads()).toBe(3);
    expect(hls.stopLoad).toHaveBeenCalled();

    // errors after the terminal state are ignored
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'expired', httpStatus: 403 });
  });

  it('a 403 soon after a successful refresh continues the same incident (no reset within 60 s)', async () => {
    const ctx = await playing();
    const hls = ctx.hls();
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    await vi.advanceTimersByTimeAsync(0);
    hls.manifestParsed();
    hls.fragLoaded();
    expect(ctx.last()).toEqual({ kind: 'ready' });

    await vi.advanceTimersByTimeAsync(30_000);
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 2 });
  });

  it('hourly expiries during a long session are each a fresh attempt 1', async () => {
    const ctx = await playing();
    const hls = ctx.hls();
    for (let hour = 1; hour <= 5; hour++) {
      await vi.advanceTimersByTimeAsync(3_600_000);
      hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
      expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });
      await vi.advanceTimersByTimeAsync(0);
      hls.manifestParsed();
      hls.fragLoaded();
      expect(ctx.last()).toEqual({ kind: 'ready' });
    }
    expect(hls.loadSource).toHaveBeenCalledTimes(6);
  });

  it('a master refused during the refresh (403: access revoked) ends in error/forbidden', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    await vi.advanceTimersByTimeAsync(0);
    ctx.hls().error({ details: ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'forbidden', httpStatus: 403 });
  });

  it('a transient master failure during the refresh counts as another attempt', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    await vi.advanceTimersByTimeAsync(0);
    ctx.hls().error({ details: ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true, code: 503 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.hls().loadSource).toHaveBeenCalledTimes(3);
  });

  it('a 403 before anything ever played is retried too, and bounded', async () => {
    const ctx = setup();
    await ctx.controller.start();
    const hls = ctx.hls();
    hls.manifestParsed();
    for (let i = 0; i < 3; i++) {
      hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
      await vi.advanceTimersByTimeAsync(10_000);
      hls.manifestParsed();
    }
    hls.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toMatchObject({ kind: 'error', reason: 'expired' });
  });

  it('retry() from the error state starts a fresh incident at the last position', async () => {
    const ctx = await playing(777);
    const first = ctx.hls();
    for (let i = 0; i < 4; i++) {
      first.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(ctx.last()).toMatchObject({ kind: 'error', reason: 'expired' });

    ctx.controller.retry();
    expect(first.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    const second = ctx.hls();
    expect(second).not.toBe(first);
    expect(ctx.last()).toEqual({ kind: 'loading' });
    second.manifestParsed();
    expect(second.startLoad).toHaveBeenCalledWith(777);
    expect(ctx.last()).toEqual({ kind: 'ready' });
    second.error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });
  });

  it('destroy() cancels a pending reload and stops status updates', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    // second attempt is delayed; destroy before it fires
    await vi.advanceTimersByTimeAsync(0);
    ctx.hls().manifestParsed();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 403 });
    const count = ctx.statuses.length;
    ctx.controller.destroy();
    expect(ctx.hls().destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.hls().loadSource).toHaveBeenCalledTimes(2);
    expect(ctx.statuses).toHaveLength(count);
  });
});

describe('other errors', () => {
  it('ignores non-fatal, non-403 errors (hls.js retries those itself)', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, code: 500 });
    expect(ctx.last()).toEqual({ kind: 'ready' });
  });

  it('recovers one fatal media error, then gives up with error/media', async () => {
    const ctx = await playing();
    ctx.hls().error({ type: ErrorTypes.MEDIA_ERROR, details: 'bufferAppendError', fatal: true });
    expect(ctx.hls().recoverMediaError).toHaveBeenCalledTimes(1);
    expect(ctx.last()).toEqual({ kind: 'ready' });
    ctx.hls().error({ type: ErrorTypes.MEDIA_ERROR, details: 'bufferAppendError', fatal: true });
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'media' });
  });

  it('a fatal network error (segments unreachable) ends in error/network', async () => {
    const ctx = await playing();
    ctx.hls().error({ details: ErrorDetails.FRAG_LOAD_ERROR, fatal: true, code: 0 });
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'network' });
  });
});

describe('native HLS fallback', () => {
  async function native() {
    const ctx = setup({ mse: false });
    ctx.video.canPlayType.mockReturnValue('maybe');
    await ctx.controller.start();
    ctx.video.dispatch('loadedmetadata');
    ctx.video.dispatch('playing');
    ctx.video.currentTime = 90;
    ctx.video.paused = false;
    return ctx;
  }

  it('a network error after playback worked re-sets src and resumes', async () => {
    const ctx = await native();
    ctx.video.error = { code: 2 };
    ctx.video.dispatch('error');
    expect(ctx.last()).toEqual({ kind: 'refreshing', attempt: 1 });
    ctx.video.src = '';
    ctx.video.currentTime = 0;
    ctx.video.paused = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.video.src).toBe(SRC);
    ctx.video.dispatch('loadedmetadata');
    expect(ctx.video.currentTime).toBe(90);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.video.play).toHaveBeenCalled();
    ctx.video.dispatch('playing');
    expect(ctx.last()).toEqual({ kind: 'ready' });
  });

  it('a network error before anything played is final', async () => {
    const ctx = setup({ mse: false });
    ctx.video.canPlayType.mockReturnValue('maybe');
    await ctx.controller.start();
    ctx.video.error = { code: 4 };
    ctx.video.dispatch('error');
    expect(ctx.last()).toEqual({ kind: 'error', reason: 'network' });
  });

  it('destroy() removes the listeners and the src', async () => {
    const ctx = await native();
    ctx.controller.destroy();
    expect(ctx.video.removeAttribute).toHaveBeenCalledWith('src');
    expect([...ctx.video.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});
