import { randomBytes } from 'node:crypto';
import { type Algorithm, hash, parseOptions, verify, type Version } from '@node-rs/argon2';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PasswordHasher } from '../../application/ports/password-hasher';
import type { PlainPassword } from '../../domain/password/plain-password';

/** Argon2id cost parameters (design D2). */
export interface Argon2Params {
  /** KiB of memory (`m`). */
  memoryCost: number;
  /** Passes (`t`). */
  timeCost: number;
  /** Lanes (`p`). */
  parallelism: number;
}

/** OWASP baseline for Argon2id: m=19 MiB, t=2, p=1. */
export const DEFAULT_ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** Injection token for the Argon2 parameters (bound in IdentityModule). */
export const ARGON2_PARAMS = Symbol.for('udemy.identity.ARGON2_PARAMS');

// `Algorithm`/`Version` are ambient const enums, which isolatedModules cannot reference as
// values; these are their numeric members.
const ARGON2ID: Algorithm = 2;
const VERSION_0x13: Version = 1;
const OUTPUT_LENGTH = 32;

function assertParams(params: Argon2Params): void {
  const ok =
    Number.isSafeInteger(params.memoryCost) &&
    params.memoryCost >= 8 * params.parallelism &&
    Number.isSafeInteger(params.timeCost) &&
    params.timeCost >= 1 &&
    Number.isSafeInteger(params.parallelism) &&
    params.parallelism >= 1 &&
    params.parallelism <= 255;
  if (!ok) throw new TypeError(`Invalid Argon2 parameters: ${JSON.stringify(params)}`);
}

/**
 * Argon2id via `@node-rs/argon2` (N-API prebuilds incl. linux-musl; hashing runs on the libuv
 * thread pool, so it does not block the event loop).
 */
@Injectable()
export class Argon2PasswordHasher extends PasswordHasher implements OnModuleInit {
  private readonly logger = new Logger(Argon2PasswordHasher.name);
  private readonly params: Readonly<Argon2Params>;
  private dummyHash: Promise<string> | undefined;

  constructor(@Inject(ARGON2_PARAMS) params: Argon2Params) {
    super();
    assertParams(params);
    this.params = Object.freeze({ ...params });
  }

  /** Computes the dummy hash at boot, so the first unknown-email login is not faster/slower. */
  async onModuleInit(): Promise<void> {
    await this.dummy();
  }

  async hash(password: PlainPassword): Promise<string> {
    return this.hashRaw(password.value);
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(encodedHash, password);
    } catch (error) {
      // A malformed/unsupported stored hash is a data problem, not a reason to log in or to 500.
      this.logger.error({ err: error }, 'Stored password hash could not be verified');
      return false;
    }
  }

  needsRehash(encodedHash: string): boolean {
    try {
      const used = parseOptions(encodedHash);
      return (
        used.algorithm !== ARGON2ID ||
        used.version !== VERSION_0x13 ||
        used.memoryCost !== this.params.memoryCost ||
        used.timeCost !== this.params.timeCost ||
        used.parallelism !== this.params.parallelism ||
        used.outputLen !== OUTPUT_LENGTH
      );
    } catch {
      return true;
    }
  }

  async dummyVerify(password: string): Promise<false> {
    await this.verify(await this.dummy(), password);
    return false;
  }

  private dummy(): Promise<string> {
    // A random secret nobody knows: verification against it can never succeed.
    this.dummyHash ??= this.hashRaw(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }

  private hashRaw(password: string): Promise<string> {
    return hash(password, {
      algorithm: ARGON2ID,
      version: VERSION_0x13,
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
      outputLen: OUTPUT_LENGTH,
    });
  }
}
