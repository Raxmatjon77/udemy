import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Email } from '../../domain/email';
import { PlainPassword } from '../../domain/password/plain-password';
import {
  type Argon2Params,
  Argon2PasswordHasher,
  DEFAULT_ARGON2_PARAMS,
} from './argon2-password.hasher';

/** Cheap parameters keep the suite fast; one test covers the production defaults. */
const FAST: Argon2Params = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const email = Email.parse('jane@example.com');
const password = PlainPassword.create('correct horse battery', { email });

describe('Argon2PasswordHasher', () => {
  let hasher: Argon2PasswordHasher;

  beforeAll(async () => {
    hasher = new Argon2PasswordHasher(FAST);
    await hasher.onModuleInit();
  });

  it('hashes with Argon2id v19 and the configured parameters, salted', async () => {
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);

    expect(first).toMatch(
      /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(second).not.toBe(first);
  });

  it('uses the OWASP baseline m=19456, t=2, p=1 by default', async () => {
    const hash = await new Argon2PasswordHasher(DEFAULT_ARGON2_PARAMS).hash(password);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hasher.hash(password);

    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'correct horse batterY')).resolves.toBe(false);
    await expect(hasher.verify(hash, '')).resolves.toBe(false);
  });

  it('normalises (NFKC) before hashing and before verifying', async () => {
    const fullwidth = 'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ';
    const fromFullwidth = await hasher.hash(PlainPassword.create(fullwidth, { email }));
    const fromAscii = await hasher.hash(password);

    await expect(hasher.verify(fromFullwidth, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(fromAscii, fullwidth)).resolves.toBe(true);
    // NFKC never folds case.
    await expect(hasher.verify(fromAscii, 'CORRECT HORSE BATTERY')).resolves.toBe(false);
  });

  it('rehashVerified produces a current-parameter hash of the normalised password', async () => {
    const rehashed = await hasher.rehashVerified('ｓｈｏｒｔ');
    expect(hasher.needsRehash(rehashed)).toBe(false);
    await expect(hasher.verify(rehashed, 'short')).resolves.toBe(true);
  });

  it('returns false (does not throw) for a malformed stored hash', async () => {
    await expect(hasher.verify('not-a-hash', 'correct horse battery')).resolves.toBe(false);
  });

  it('needsRehash is false for current parameters and flips when they change', async () => {
    const hash = await hasher.hash(password);
    expect(hasher.needsRehash(hash)).toBe(false);

    expect(new Argon2PasswordHasher({ ...FAST, memoryCost: 2048 }).needsRehash(hash)).toBe(true);
    expect(new Argon2PasswordHasher({ ...FAST, timeCost: 2 }).needsRehash(hash)).toBe(true);
    expect(new Argon2PasswordHasher({ ...FAST, parallelism: 2 }).needsRehash(hash)).toBe(true);
  });

  it('needsRehash is true for other algorithms and unparsable hashes', () => {
    const argon2i =
      '$argon2i$v=19$m=1024,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$5Y0Z0gOqC2Bc6yBzYzZ1a3hZbm5JdmRkZ2V4Y2VsbGVu';
    expect(hasher.needsRehash(argon2i)).toBe(true);
    expect(hasher.needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    expect(hasher.needsRehash('')).toBe(true);
  });

  it('dummyVerify always resolves false and costs a real verification', async () => {
    const slow = new Argon2PasswordHasher(DEFAULT_ARGON2_PARAMS);
    await slow.onModuleInit();
    const real = await slow.hash(password);

    const verifySpy = vi.spyOn(slow, 'verify');
    await expect(slow.dummyVerify('correct horse battery')).resolves.toBe(false);

    // Equal cost is a structural property, not a timing one (wall-clock ratios flake on loaded
    // machines): the dummy path must run one real Argon2 verify against a hash encoded with the
    // same algorithm and parameters as a real user's hash.
    expect(verifySpy).toHaveBeenCalledTimes(1);
    const [dummyHash] = verifySpy.mock.calls[0]!;
    const paramsOf = (encoded: string) => encoded.split('$').slice(1, 4).join('$');
    expect(paramsOf(dummyHash)).toBe(paramsOf(real));
    expect(paramsOf(real)).toMatch(/^argon2id\$v=19\$m=19456,t=2,p=1$/);
  });

  it('rejects invalid parameters at construction', () => {
    expect(() => new Argon2PasswordHasher({ ...FAST, timeCost: 0 })).toThrow(TypeError);
    expect(() => new Argon2PasswordHasher({ ...FAST, parallelism: 0 })).toThrow(TypeError);
    expect(() => new Argon2PasswordHasher({ ...FAST, memoryCost: 4 })).toThrow(TypeError);
  });
});
