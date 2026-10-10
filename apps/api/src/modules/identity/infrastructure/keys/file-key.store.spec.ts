import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JwksResponseSchema } from '@udemy/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileKeyStore, isValidKid } from './file-key.store';

function ed25519Pem(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

describe('FileKeyStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'udemy-jwt-keys-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function addKey(kid: string, pem = ed25519Pem()): Promise<void> {
    await writeFile(join(dir, `${kid}.pem`), pem, { mode: 0o600 });
  }

  it('loads every <kid>.pem and publishes all public keys, the active key first', async () => {
    await addKey('ed25519-2026-09');
    await addKey('ed25519-2026-10');
    await addKey('ed25519-2026-11');

    const store = await FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' });

    expect(store.activeKid).toBe('ed25519-2026-10');
    expect(store.publicJwks().map((k) => k.kid)).toEqual([
      'ed25519-2026-10',
      'ed25519-2026-11',
      'ed25519-2026-09',
    ]);
    expect(JwksResponseSchema.parse({ keys: store.publicJwks() }).keys).toHaveLength(3);
    for (const jwk of store.publicJwks()) {
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
      expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
      expect(jwk).not.toHaveProperty('d');
    }
    expect(store.signingKey().kid).toBe('ed25519-2026-10');
    expect(store.verificationKey('ed25519-2026-09')).toBeDefined();
    expect(store.verificationKey('ed25519-2025-01')).toBeUndefined();
  });

  it('ignores non-.pem files and directories', async () => {
    await addKey('ed25519-2026-10');
    await writeFile(join(dir, 'README.txt'), 'hello');
    await writeFile(join(dir, 'ed25519-2026-11.pem.bak'), ed25519Pem());
    await mkdir(join(dir, 'ed25519-2026-12.pem'));

    const store = await FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' });

    expect(store.publicJwks().map((k) => k.kid)).toEqual(['ed25519-2026-10']);
  });

  it('refuses .pem files whose name is not a valid kid', async () => {
    await addKey('ed25519-2026-10');
    await addKey('rsa-2026-10');
    await addKey('ed25519-2026-13');
    await addKey('ED25519-2026-10');

    const store = await FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' });

    expect(store.publicJwks().map((k) => k.kid)).toEqual(['ed25519-2026-10']);
  });

  it('follows symlinks (k8s Secret volumes)', async () => {
    const real = join(dir, '..data');
    await mkdir(real);
    await writeFile(join(real, 'ed25519-2026-10.pem'), ed25519Pem());
    await symlink(join(real, 'ed25519-2026-10.pem'), join(dir, 'ed25519-2026-10.pem'));

    const store = await FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' });

    expect(store.activeKid).toBe('ed25519-2026-10');
  });

  it('fails when the active key is missing', async () => {
    await addKey('ed25519-2026-09');

    await expect(FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' })).rejects.toThrow(
      /JWT_ACTIVE_KID ed25519-2026-10: .*ed25519-2026-10\.pem not found/,
    );
  });

  it('fails when the directory does not exist', async () => {
    await expect(
      FileKeyStore.load({ dir: join(dir, 'missing'), activeKid: 'ed25519-2026-10' }),
    ).rejects.toThrow(/JWT_KEYS_DIR .* is not readable/);
  });

  it('fails on a key that is not Ed25519', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    await addKey('ed25519-2026-10', ec);

    await expect(FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' })).rejects.toThrow(
      /expected an Ed25519 key, got ec/,
    );
  });

  it('fails on a non-PKCS8 or corrupt PEM', async () => {
    await addKey('ed25519-2026-10', 'not a key');
    await expect(FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' })).rejects.toThrow(
      /not a PKCS8 PEM/,
    );

    await addKey(
      'ed25519-2026-10',
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
    );
    await expect(FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' })).rejects.toThrow(
      /cannot be parsed/,
    );
  });

  it('uses the config kid format', () => {
    expect(isValidKid('ed25519-2026-10')).toBe(true);
    expect(isValidKid('ed25519-2026-10-b')).toBe(true);
    expect(isValidKid('ed25519-2026-00')).toBe(false);
    expect(isValidKid('../ed25519-2026-10')).toBe(false);
  });
});
