import type { PlainPassword } from '../../domain/password/plain-password';

/**
 * Password hashing port (design D2). Implemented with Argon2id in infrastructure.
 * Inject it by class: `constructor(private readonly hasher: PasswordHasher)`.
 */
export abstract class PasswordHasher {
  /** Encoded Argon2id hash (PHC string) of a policy-checked password. */
  abstract hash(password: PlainPassword): Promise<string>;

  /**
   * Constant-time comparison of `password` with an encoded hash. Returns false (never throws)
   * for a wrong password and for a malformed hash.
   */
  abstract verify(encodedHash: string, password: string): Promise<boolean>;

  /**
   * True when the hash was made with other parameters (or another algorithm/version) than the
   * current configuration: re-hash the password after a successful login.
   */
  abstract needsRehash(encodedHash: string): boolean;

  /**
   * Runs a full verification against a dummy hash computed once at boot and always resolves
   * false. Login calls it for an unknown email so that path costs the same as a wrong password
   * (design §9, "Enumeration and timing").
   */
  abstract dummyVerify(password: string): Promise<false>;
}
