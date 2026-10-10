import { beforeEach, describe, expect, it } from 'vitest';
import { ClientNotAllowed, SignupRateLimited, WeakPassword } from '../../domain/identity.errors';
import { clientOf } from '../testing/identity.fakes';
import { createIdentityHarness, type IdentityHarness, PASSWORD } from '../testing/identity.harness';
import { SIGNUP_RESPONSE_FLOOR_MS } from './register-user.command';

describe('RegisterUserCommand', () => {
  let h: IdentityHarness;
  const student = clientOf('student');

  beforeEach(() => {
    h = createIdentityHarness();
  });

  const signup = (email: string, client = student) =>
    h.register.execute({ email, password: PASSWORD, displayName: '  Jane Doe ', client });

  it('creates the account and emits UserRegistered + EmailVerificationRequested{SIGNUP} together', async () => {
    await expect(signup('Jane@Example.com')).resolves.toEqual({ accepted: true });

    const account = await h.accounts.findByEmail('jane@example.com');
    expect(account).toMatchObject({
      email: 'jane@example.com',
      displayName: 'Jane Doe',
      emailVerifiedAt: null,
    });
    expect(account?.passwordHash).toBe(`$argon2id$fake$${PASSWORD}`);
    expect(h.events.types()).toEqual(['UserRegistered', 'EmailVerificationRequested']);
    expect(h.events.published[1]?.payload).toMatchObject({
      userId: account?.id,
      email: 'jane@example.com',
      reason: 'SIGNUP',
    });
    expect(h.tx.runs).toBe(1); // both events in the same transaction as the insert
    expect(h.floor.floors).toEqual([SIGNUP_RESPONSE_FLOOR_MS]);
  });

  it('answers an existing email identically, hashes anyway and notices the owner once per 24 h', async () => {
    await signup('jane@example.com');
    const hashesBefore = h.fakeHasher.hashes;
    h.events.published.length = 0;

    await expect(signup('JANE@example.com')).resolves.toEqual({ accepted: true });
    expect(h.fakeHasher.hashes).toBe(hashesBefore + 1);
    expect(h.events.types()).toEqual(['SignupAttemptedForExistingEmail']);
    expect(h.store.accounts.size).toBe(1);

    await expect(signup('jane@example.com')).resolves.toEqual({ accepted: true });
    expect(h.events.types()).toEqual(['SignupAttemptedForExistingEmail']); // not a second time
    expect(h.floor.floors).toHaveLength(3);
  });

  it('is for the student app only', async () => {
    await expect(signup('a@example.com', clientOf('instructor'))).rejects.toBeInstanceOf(
      ClientNotAllowed,
    );
    await expect(signup('a@example.com', clientOf('admin'))).rejects.toBeInstanceOf(
      ClientNotAllowed,
    );
    expect(h.store.accounts.size).toBe(0);
  });

  it('limits signups per IP (10 / h) with rl:signup:ip', async () => {
    for (let i = 0; i < 10; i += 1) await signup(`u${i}@example.com`);
    const error = await signup('u10@example.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignupRateLimited);
    expect(h.limiter.counts.get('rl:signup:ip:203.0.113.7')).toBe(11);
  });

  it('refuses a weak password before any hashing or lookup (same for new and existing emails)', async () => {
    const weak = h.register.execute({
      email: 'jane@example.com',
      password: 'jane@example.com',
      displayName: 'Jane',
      client: student,
    });
    await expect(weak).rejects.toBeInstanceOf(WeakPassword);
    expect(h.fakeHasher.hashes).toBe(0);
    expect(h.floor.floors).toEqual([]);
  });
});
