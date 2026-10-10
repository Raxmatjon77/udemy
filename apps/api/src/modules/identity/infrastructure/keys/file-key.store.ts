import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { type Ed25519Jwk, Ed25519JwkSchema } from '@udemy/contracts';
import { importPKCS8, importSPKI } from 'jose';
import { apiEnvSchema } from '../../../../shared/config';
import { KeyStore } from '../../application/ports/key-store';
import { ACCESS_TOKEN_ALGORITHM } from '../../domain/access-token';

/** The CryptoKey type jose accepts (the global WebCrypto key). */
export type JoseKey = Awaited<ReturnType<typeof importPKCS8>>;

interface LoadedKey {
  readonly kid: string;
  readonly privateKey: JoseKey;
  readonly publicKey: JoseKey;
  readonly jwk: Ed25519Jwk;
}

export interface FileKeyStoreOptions {
  /** Absolute directory holding `<kid>.pem` files (JWT_KEYS_DIR). */
  dir: string;
  /** JWT_ACTIVE_KID. */
  activeKid: string;
}

const PEM_SUFFIX = '.pem';
const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';

/** Exactly the format the config accepts for JWT_ACTIVE_KID (`ed25519-YYYY-MM[-suffix]`). */
export function isValidKid(kid: string): boolean {
  return apiEnvSchema.shape.JWT_ACTIVE_KID.safeParse(kid).success;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    // stat (not the dirent) follows symlinks: k8s Secret volumes link `<kid>.pem` -> ..data/...
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toEd25519Jwk(publicKey: KeyObject, kid: string): Ed25519Jwk {
  const { kty, crv, x } = publicKey.export({ format: 'jwk' });
  return Ed25519JwkSchema.parse({ kty, crv, x, kid, use: 'sig', alg: ACCESS_TOKEN_ALGORITHM });
}

async function loadKey(path: string, kid: string): Promise<LoadedKey> {
  const pem = await readFile(path, 'utf8');
  if (!pem.includes(PKCS8_HEADER)) {
    throw new Error(`JWT key ${kid}: ${path} is not a PKCS8 PEM ("${PKCS8_HEADER}")`);
  }
  let privateKeyObject: KeyObject;
  try {
    privateKeyObject = createPrivateKey({ key: pem, format: 'pem' });
  } catch (error) {
    throw new Error(`JWT key ${kid}: ${path} cannot be parsed`, { cause: error });
  }
  if (privateKeyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `JWT key ${kid}: expected an Ed25519 key, got ${privateKeyObject.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  const publicKeyObject = createPublicKey(privateKeyObject);
  const spki = publicKeyObject.export({ format: 'pem', type: 'spki' }).toString();
  return {
    kid,
    privateKey: await importPKCS8(pem, ACCESS_TOKEN_ALGORITHM),
    publicKey: await importSPKI(spki, ACCESS_TOKEN_ALGORITHM),
    jwk: toEd25519Jwk(publicKeyObject, kid),
  };
}

/**
 * The Ed25519 keys in JWT_KEYS_DIR (design §9 "Key management"), loaded once at boot:
 *
 * - every `<kid>.pem` (PKCS8 Ed25519) is loaded and published in the JWKS;
 * - files not ending in `.pem` (and directories) are ignored;
 * - a `.pem` whose name is not a valid kid is refused (skipped with a warning, never
 *   published or trusted);
 * - an unreadable/non-Ed25519 key file, or a missing `<JWT_ACTIVE_KID>.pem`, fails boot.
 *
 * Rotation = add a file, restart; switch JWT_ACTIVE_KID, restart; remove the old file, restart.
 */
export class FileKeyStore extends KeyStore {
  private static readonly logger = new Logger('FileKeyStore');

  private constructor(
    private readonly active: LoadedKey,
    private readonly keys: ReadonlyMap<string, LoadedKey>,
  ) {
    super();
  }

  static async load(options: FileKeyStoreOptions): Promise<FileKeyStore> {
    const { dir, activeKid } = options;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      throw new Error(
        `JWT_KEYS_DIR ${dir} is not readable. Dev: pnpm --filter @udemy/api keys:generate`,
        { cause: error },
      );
    }

    const keys = new Map<string, LoadedKey>();
    for (const name of entries.sort()) {
      if (!name.endsWith(PEM_SUFFIX)) continue;
      const path = join(dir, name);
      if (!(await isRegularFile(path))) continue;
      const kid = name.slice(0, -PEM_SUFFIX.length);
      if (!isValidKid(kid)) {
        FileKeyStore.logger.warn(
          { file: path },
          'Ignoring JWT key file: name is not a valid kid (ed25519-YYYY-MM[-suffix])',
        );
        continue;
      }
      keys.set(kid, await loadKey(path, kid));
    }

    const active = keys.get(activeKid);
    if (active === undefined) {
      throw new Error(
        `JWT_ACTIVE_KID ${activeKid}: ${join(dir, activeKid + PEM_SUFFIX)} not found. ` +
          'Dev: pnpm --filter @udemy/api keys:generate',
      );
    }
    FileKeyStore.logger.log(
      { activeKid, kids: [...keys.keys()] },
      `Loaded ${keys.size} JWT signing key(s)`,
    );
    return new FileKeyStore(active, keys);
  }

  get activeKid(): string {
    return this.active.kid;
  }

  publicJwks(): readonly Ed25519Jwk[] {
    const others = [...this.keys.values()]
      .filter((key) => key.kid !== this.active.kid)
      .sort((a, b) => b.kid.localeCompare(a.kid));
    return [this.active, ...others].map((key) => key.jwk);
  }

  /** The signing key. */
  signingKey(): { readonly kid: string; readonly key: JoseKey } {
    return { kid: this.active.kid, key: this.active.privateKey };
  }

  /** Public key for `kid`, or undefined for an unknown (or removed) key. */
  verificationKey(kid: string): JoseKey | undefined {
    return this.keys.get(kid)?.publicKey;
  }
}
