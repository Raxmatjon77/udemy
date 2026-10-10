import { describe, expect, it } from 'vitest';
import { decideRefresh, REFRESH_REUSE_GRACE_MS, SESSION_LIFETIMES } from './session';

const now = new Date('2026-10-10T10:00:00.000Z');
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);
const session = {
  clientApp: 'student' as const,
  absoluteExpiresAt: at(3_600_000),
  revokedAt: null,
};
const token = { consumedAt: null, expiresAt: at(60_000) };

describe('decideRefresh (design §4 steps 2–4)', () => {
  it('rotates a current, unexpired token of an active session of the same app', () => {
    expect(decideRefresh({ token, session, child: null, clientApp: 'student', now })).toEqual({
      kind: 'rotate',
    });
  });

  it('rejects revoked / absolutely expired sessions and other apps before looking at the token', () => {
    const consumed = { consumedAt: at(-1_000), expiresAt: at(60_000) };
    expect(
      decideRefresh({
        token: consumed,
        session: { ...session, revokedAt: at(-1) },
        child: null,
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reject', cause: 'session_revoked' });
    expect(
      decideRefresh({
        token,
        session: { ...session, absoluteExpiresAt: now },
        child: null,
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reject', cause: 'session_expired' });
    expect(
      decideRefresh({ token: consumed, session, child: null, clientApp: 'admin', now }),
    ).toEqual({
      kind: 'reject',
      cause: 'wrong_app',
    });
  });

  it('grace: consumed < 10 s ago and the child is still current and unexpired', () => {
    const child = { consumedAt: null, expiresAt: at(60_000) };
    const consumed = (ago: number) => ({ consumedAt: at(-ago), expiresAt: at(60_000) });
    expect(
      decideRefresh({ token: consumed(9_999), session, child, clientApp: 'student', now }),
    ).toEqual({ kind: 'grace' });
    expect(
      decideRefresh({
        token: consumed(REFRESH_REUSE_GRACE_MS),
        session,
        child,
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reuse' });
    expect(
      decideRefresh({
        token: consumed(1_000),
        session,
        child: { ...child, consumedAt: at(-500) },
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reuse' });
    expect(
      decideRefresh({
        token: consumed(1_000),
        session,
        child: { ...child, expiresAt: now },
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reuse' });
    expect(
      decideRefresh({ token: consumed(1_000), session, child: null, clientApp: 'student', now }),
    ).toEqual({
      kind: 'reuse',
    });
  });

  it('rejects an expired (idle) token', () => {
    expect(
      decideRefresh({
        token: { consumedAt: null, expiresAt: now },
        session,
        child: null,
        clientApp: 'student',
        now,
      }),
    ).toEqual({ kind: 'reject', cause: 'token_expired' });
  });

  it('has the per-app lifetimes of design §9', () => {
    const day = 86_400;
    expect(SESSION_LIFETIMES).toEqual({
      student: { idleTtlSeconds: 14 * day, absoluteTtlSeconds: 60 * day },
      instructor: { idleTtlSeconds: 7 * day, absoluteTtlSeconds: 30 * day },
      admin: { idleTtlSeconds: 3_600, absoluteTtlSeconds: 12 * 3_600 },
    });
  });
});
