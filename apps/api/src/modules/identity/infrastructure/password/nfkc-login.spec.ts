import { describe, expect, it } from 'vitest';
import { clientOf } from '../../application/testing/identity.fakes';
import { createIdentityHarness } from '../../application/testing/identity.harness';
import { Email } from '../../domain/email';
import { InvalidCredentials } from '../../domain/identity.errors';
import { PlainPassword } from '../../domain/password/plain-password';
import { Argon2PasswordHasher } from './argon2-password.hasher';

/**
 * NIST 800-63B: passwords are NFKC-normalised before hashing AND before verifying, so a user
 * who signed up typing fullwidth characters (e.g. a CJK IME) can log in typing ASCII, and vice
 * versa. LoginCommand with the real Argon2 hasher (cheap parameters).
 */
describe('login with a compatibility-equivalent password (NFKC, real Argon2)', () => {
  const fullwidth = 'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ';
  const student = clientOf('student');

  async function harnessWithAccount(signupPassword: string) {
    const hasher = new Argon2PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
    await hasher.onModuleInit();
    const h = createIdentityHarness({ hasher });
    const email = Email.parse('wide@example.com');
    h.store.addAccount({
      email: email.value,
      passwordHash: await hasher.hash(PlainPassword.create(signupPassword, { email })),
    });
    return h;
  }

  it('signed up fullwidth, logs in with ASCII and with fullwidth', async () => {
    const h = await harnessWithAccount(fullwidth);
    for (const password of ['correct horse battery', fullwidth]) {
      await expect(
        h.login.execute({ email: 'wide@example.com', password, client: student }),
      ).resolves.toMatchObject({ user: { email: 'wide@example.com' } });
    }
  });

  it('signed up ASCII, logs in fullwidth; case still matters', async () => {
    const h = await harnessWithAccount('correct horse battery');
    await expect(
      h.login.execute({ email: 'wide@example.com', password: fullwidth, client: student }),
    ).resolves.toMatchObject({ user: { email: 'wide@example.com' } });
    await expect(
      h.login.execute({
        email: 'wide@example.com',
        password: 'CORRECT HORSE BATTERY',
        client: student,
      }),
    ).rejects.toBeInstanceOf(InvalidCredentials);
  });
});
