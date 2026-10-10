import { describe, expect, it } from 'vitest';
import {
  FAKE_TRX,
  fakeConfig,
  InMemoryOneTimeTokenStore,
  TEST_SECRET,
} from '../testing/identity-mail.fakes';
import { IssueOneTimeToken, type IssueOneTimeTokenInput } from './issue-one-time-token';
import { deriveOneTimeToken, hashOneTimeToken } from './one-time-token';

const USER = '0199c8a0-0000-7000-8000-000000000001';
const EVENT_1 = '0199c8a0-0000-7000-8000-0000000000e1';
const EVENT_2 = '0199c8a0-0000-7000-8000-0000000000e2';
const NOW = new Date('2026-10-10T10:00:00.000Z');
const MINUTE = 60_000;

function setup() {
  const store = new InMemoryOneTimeTokenStore(NOW);
  store.users.set(USER, { email: 'jane@example.com' });
  const issuer = new IssueOneTimeToken(store, fakeConfig());
  const input = (overrides: Partial<IssueOneTimeTokenInput> = {}): IssueOneTimeTokenInput => ({
    eventId: EVENT_1,
    userId: USER,
    purpose: 'PASSWORD_RESET',
    email: 'jane@example.com',
    requestedAt: new Date(NOW.getTime() - MINUTE),
    ...overrides,
  });
  return { store, issuer, input };
}

describe('deriveOneTimeToken (D10)', () => {
  it('is base64url(HMAC-SHA256(secret, eventId ‖ purpose)): deterministic, 43 chars, per purpose', () => {
    const a = deriveOneTimeToken(TEST_SECRET, EVENT_1, 'PASSWORD_RESET');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveOneTimeToken(TEST_SECRET, EVENT_1, 'PASSWORD_RESET')).toBe(a);
    expect(deriveOneTimeToken(TEST_SECRET, EVENT_1, 'EMAIL_VERIFICATION')).not.toBe(a);
    expect(deriveOneTimeToken(TEST_SECRET, EVENT_2, 'PASSWORD_RESET')).not.toBe(a);
    expect(deriveOneTimeToken(`${TEST_SECRET}x`, EVENT_1, 'PASSWORD_RESET')).not.toBe(a);
  });
});

describe('IssueOneTimeToken', () => {
  it('issues a token: stores only sha256(raw), expires_at = requested_at + TTL, under the user lock', async () => {
    const { store, issuer, input } = setup();
    const result = await issuer.execute(FAKE_TRX, input());

    expect(result.kind).toBe('issued');
    if (result.kind !== 'issued') return;
    const row = store.rowFor(EVENT_1);
    expect(row?.tokenHash).toEqual(hashOneTimeToken(result.rawToken));
    expect(row?.tokenHash.toString('utf8')).not.toContain(result.rawToken);
    expect(row?.requestedAt).toEqual(new Date(NOW.getTime() - MINUTE));
    expect(row?.expiresAt).toEqual(new Date(NOW.getTime() - MINUTE + 30 * MINUTE));
    expect(result.expiresAt).toEqual(row?.expiresAt);
    expect(row?.email).toBe('jane@example.com');
    expect(store.locks).toEqual([USER]);
  });

  it('uses a 24 h lifetime for email verification', async () => {
    const { store, issuer, input } = setup();
    await issuer.execute(FAKE_TRX, input({ purpose: 'EMAIL_VERIFICATION' }));
    expect(store.rowFor(EVENT_1)?.expiresAt).toEqual(
      new Date(NOW.getTime() - MINUTE + 24 * 60 * MINUTE),
    );
  });

  it('redelivery returns the SAME token and does not invalidate itself (§14)', async () => {
    const { store, issuer, input } = setup();
    const first = await issuer.execute(FAKE_TRX, input());
    const again = await issuer.execute(FAKE_TRX, input());

    expect(again).toEqual(first);
    expect(store.rows).toHaveLength(1);
    expect(store.rowFor(EVENT_1)?.invalidatedAt).toBeNull();
  });

  it('a newer request invalidates the older live token', async () => {
    const { store, issuer, input } = setup();
    await issuer.execute(FAKE_TRX, input());
    const second = await issuer.execute(FAKE_TRX, input({ eventId: EVENT_2, requestedAt: NOW }));

    expect(second.kind).toBe('issued');
    expect(store.rowFor(EVENT_1)?.invalidatedAt).toEqual(NOW);
    expect(store.rowFor(EVENT_2)?.invalidatedAt).toBeNull();
  });

  it('skips an out-of-order (older) request when a newer one exists', async () => {
    const { store, issuer, input } = setup();
    await issuer.execute(FAKE_TRX, input({ eventId: EVENT_2, requestedAt: NOW }));
    const late = await issuer.execute(FAKE_TRX, input());

    expect(late).toEqual({ kind: 'skipped', reason: 'superseded' });
    expect(store.rowFor(EVENT_1)).toBeUndefined();
    expect(store.rowFor(EVENT_2)?.invalidatedAt).toBeNull();
  });

  it("skips when the user's email is no longer the event's email", async () => {
    const { store, issuer, input } = setup();
    store.users.set(USER, { email: 'new@example.com' });
    await expect(issuer.execute(FAKE_TRX, input())).resolves.toEqual({
      kind: 'skipped',
      reason: 'email_changed',
    });
    expect(store.rows).toHaveLength(0);
  });

  it('compares emails like citext (case-insensitive)', async () => {
    const { issuer, input } = setup();
    const result = await issuer.execute(FAKE_TRX, input({ email: 'Jane@Example.com' }));
    expect(result.kind).toBe('issued');
  });

  it('skips when requested_at + TTL is already past (very late redelivery)', async () => {
    const { store, issuer, input } = setup();
    const result = await issuer.execute(
      FAKE_TRX,
      input({ requestedAt: new Date(NOW.getTime() - 30 * MINUTE) }),
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'expired' });
    expect(store.rows).toHaveLength(0);
  });

  it('skips a deleted user', async () => {
    const { store, issuer, input } = setup();
    store.users.clear();
    await expect(issuer.execute(FAKE_TRX, input())).resolves.toEqual({
      kind: 'skipped',
      reason: 'user_missing',
    });
  });

  it('skips the mail when a redelivered token was already used', async () => {
    const { store, issuer, input } = setup();
    await issuer.execute(FAKE_TRX, input());
    const row = store.rowFor(EVENT_1);
    if (row !== undefined) row.consumedAt = NOW;

    await expect(issuer.execute(FAKE_TRX, input())).resolves.toEqual({
      kind: 'skipped',
      reason: 'already_used',
    });
  });

  it('keeps the purposes independent', async () => {
    const { store, issuer, input } = setup();
    await issuer.execute(FAKE_TRX, input());
    await issuer.execute(
      FAKE_TRX,
      input({ eventId: EVENT_2, purpose: 'EMAIL_VERIFICATION', requestedAt: NOW }),
    );
    expect(store.rowFor(EVENT_1)?.invalidatedAt).toBeNull();
  });
});
