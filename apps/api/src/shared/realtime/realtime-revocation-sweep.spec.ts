import { REALTIME_LIMITS } from '@udemy/contracts';
import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRealtimeIdentity } from './realtime-identity';
import { RealtimeRevocationSweep } from './realtime-revocation-sweep';
import { FakeSessionRevocations, studentGrant } from './testing/realtime.fakes';

const SID_A = '01900000-0000-7000-8000-00000000b00a';
const SID_B = '01900000-0000-7000-8000-00000000b00b';

interface FakeSocket {
  connected: boolean;
  disconnect: ReturnType<typeof vi.fn>;
}

/** A stand-in socket carrying a handshake identity of `sessionId`. */
function socketOf(sessionId: string): FakeSocket & Socket {
  const socket: FakeSocket = { connected: true, disconnect: vi.fn() };
  socket.disconnect.mockImplementation(() => {
    socket.connected = false;
  });
  const grant = studentGrant({ sessionId });
  setRealtimeIdentity(socket as unknown as Socket, {
    principal: {
      userId: grant.userId,
      sessionId,
      app: grant.app,
      roles: grant.roles,
      permissions: new Set(grant.permissions),
      tokenId: grant.tokenId,
    },
    origin: 'http://localhost:3000',
    connectedAt: new Date(),
    expiresAt: new Date(Date.now() + REALTIME_LIMITS.maxConnectionSeconds * 1000),
  });
  return socket as FakeSocket & Socket;
}

/** Lets the sweep's pending promise chain settle (no wall-clock waiting). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('RealtimeRevocationSweep', () => {
  let sessions: FakeSessionRevocations;
  let sweep: RealtimeRevocationSweep;

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new FakeSessionRevocations();
    sweep = new RealtimeRevocationSweep(sessions);
  });

  afterEach(() => {
    sweep.stop();
    vi.useRealTimers();
  });

  it('disconnects every socket of a revoked session, in one batched lookup', async () => {
    const a1 = socketOf(SID_A);
    const a2 = socketOf(SID_A);
    const b = socketOf(SID_B);
    for (const socket of [a1, a2, b]) sweep.track(socket);
    sessions.revoked.add(SID_A);
    const lookup = vi.spyOn(sessions, 'revokedAmong');

    await expect(sweep.sweep()).resolves.toBe(2);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([SID_A, SID_B]);
    expect(a1.disconnect).toHaveBeenCalledWith(true);
    expect(a2.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(sweep.size).toBe(1);
  });

  it('runs every revocationSweepSeconds once started (fake timers)', async () => {
    const socket = socketOf(SID_A);
    sweep.track(socket);
    sweep.start();
    sweep.start(); // idempotent: still one timer

    sessions.revoked.add(SID_A);
    await vi.advanceTimersByTimeAsync(REALTIME_LIMITS.revocationSweepSeconds * 1000 - 1);
    expect(socket.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a socket revoked after one sweep is closed by the next one', async () => {
    const socket = socketOf(SID_B);
    sweep.track(socket);
    sweep.start();
    await vi.advanceTimersByTimeAsync(REALTIME_LIMITS.revocationSweepSeconds * 1000);
    expect(socket.disconnect).not.toHaveBeenCalled();

    sessions.revoked.add(SID_B);
    await vi.advanceTimersByTimeAsync(REALTIME_LIMITS.revocationSweepSeconds * 1000);
    await flush();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps the sockets when the lookup fails (Redis down) and retries on the next tick', async () => {
    const socket = socketOf(SID_A);
    sweep.track(socket);
    sessions.revoked.add(SID_A);
    sessions.failing = new Error('redis down');

    await expect(sweep.sweep()).resolves.toBe(0);
    expect(socket.disconnect).not.toHaveBeenCalled();

    sessions.failing = undefined;
    await expect(sweep.sweep()).resolves.toBe(1);
  });

  it('skips untracked and already disconnected sockets, and an empty set costs no lookup', async () => {
    const lookup = vi.spyOn(sessions, 'revokedAmong');
    await expect(sweep.sweep()).resolves.toBe(0);
    expect(lookup).not.toHaveBeenCalled();

    const gone = socketOf(SID_A);
    const closed = socketOf(SID_A);
    closed.connected = false;
    sweep.track(gone);
    sweep.track(closed);
    sweep.untrack(gone);
    sessions.revoked.add(SID_A);

    await expect(sweep.sweep()).resolves.toBe(0);
    expect(gone.disconnect).not.toHaveBeenCalled();
    expect(closed.disconnect).not.toHaveBeenCalled();
  });

  it('never overlaps two sweeps', async () => {
    sweep.track(socketOf(SID_A));
    let release: (value: ReadonlySet<string>) => void = () => undefined;
    vi.spyOn(sessions, 'revokedAmong').mockImplementation(
      () =>
        new Promise<ReadonlySet<string>>((resolve) => {
          release = resolve;
        }),
    );

    const first = sweep.sweep();
    await expect(sweep.sweep()).resolves.toBe(0);
    release(new Set([SID_A]));
    await expect(first).resolves.toBe(1);
  });

  it('stop() clears the timer and the tracked sockets', async () => {
    const socket = socketOf(SID_A);
    sweep.track(socket);
    sweep.start();
    sweep.stop();
    sessions.revoked.add(SID_A);

    await vi.advanceTimersByTimeAsync(REALTIME_LIMITS.revocationSweepSeconds * 2000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(sweep.size).toBe(0);
  });
});
