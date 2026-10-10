import type { Permission } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { OwnershipResolver } from '../../../shared/auth';
import { effectivePermissions } from '../domain/permission-policy';
import { type AuthorizationSubject, Authorizer } from './authorizer';
import type { OwnershipRegistry } from './ownership.registry';

const ALICE = '0199b0a4-0000-7000-8000-00000000000a';
const BOB = '0199b0a4-0000-7000-8000-00000000000b';
const APP_1 = '0199b0a4-0000-7000-8000-000000000101';

function subject(userId: string, permissions: Permission[]): AuthorizationSubject {
  return { userId, permissions: new Set(permissions) };
}

function setup(owners: Record<string, string> = {}, registered = true) {
  const resolver: OwnershipResolver = {
    ownerOf: vi.fn(async (id: string) => owners[id] ?? null),
  };
  const registry = {
    get: vi.fn(() => (registered ? resolver : undefined)),
    has: vi.fn(() => registered),
  } as unknown as OwnershipRegistry;
  return { authorizer: new Authorizer(registry), resolver };
}

describe('Authorizer', () => {
  it('can() checks the principal permission set', () => {
    const { authorizer } = setup();
    const p = subject(ALICE, ['user:read:any']);
    expect(authorizer.can(p, 'user:read:any')).toBe(true);
    expect(authorizer.can(p, 'user:ban:any')).toBe(false);
  });

  it(':any allows without loading the resource', async () => {
    const { authorizer, resolver } = setup();
    const admin = subject(ALICE, ['instructor_application:read:any']);
    await expect(
      authorizer.canOnResource(admin, 'read', 'instructor_application', APP_1),
    ).resolves.toBe('ALLOW');
    expect(resolver.ownerOf).not.toHaveBeenCalled();
  });

  it(':own allows the owner', async () => {
    const { authorizer } = setup({ [APP_1]: ALICE });
    const student = subject(ALICE, ['instructor_application:read:own']);
    await expect(
      authorizer.canOnResource(student, 'read', 'instructor_application', APP_1),
    ).resolves.toBe('ALLOW');
  });

  it(':own answers NOT_FOUND (not DENY) for another owner', async () => {
    const { authorizer } = setup({ [APP_1]: BOB });
    const student = subject(ALICE, ['instructor_application:read:own']);
    await expect(
      authorizer.canOnResource(student, 'read', 'instructor_application', APP_1),
    ).resolves.toBe('NOT_FOUND');
  });

  it(':own answers NOT_FOUND for a missing resource or an empty id', async () => {
    const { authorizer, resolver } = setup();
    const student = subject(ALICE, ['instructor_application:withdraw:own']);
    await expect(
      authorizer.canOnResource(student, 'withdraw', 'instructor_application', APP_1),
    ).resolves.toBe('NOT_FOUND');
    vi.mocked(resolver.ownerOf).mockClear();
    await expect(
      authorizer.canOnResource(student, 'withdraw', 'instructor_application', ''),
    ).resolves.toBe('NOT_FOUND');
    expect(resolver.ownerOf).not.toHaveBeenCalled();
  });

  it('DENY without :any or :own, and the resource is never loaded', async () => {
    const { authorizer, resolver } = setup({ [APP_1]: ALICE });
    const other = subject(ALICE, ['instructor_application:read:own']);
    await expect(
      authorizer.canOnResource(other, 'review', 'instructor_application', APP_1),
    ).resolves.toBe('DENY');
    expect(resolver.ownerOf).not.toHaveBeenCalled();
  });

  it('an ADMIN in the student app only has :own on applications (D6)', async () => {
    const { authorizer } = setup({ [APP_1]: BOB });
    const adminInStudentApp: AuthorizationSubject = {
      userId: ALICE,
      permissions: effectivePermissions(['STUDENT', 'ADMIN'], 'student'),
    };
    await expect(
      authorizer.canOnResource(adminInStudentApp, 'read', 'instructor_application', APP_1),
    ).resolves.toBe('NOT_FOUND');
    await expect(
      authorizer.canOnResource(adminInStudentApp, 'review', 'instructor_application', APP_1),
    ).resolves.toBe('DENY');
  });

  it('fails loudly when :own applies but no resolver is registered', async () => {
    const { authorizer } = setup({}, false);
    const student = subject(ALICE, ['instructor_application:read:own']);
    await expect(
      authorizer.canOnResource(student, 'read', 'instructor_application', APP_1),
    ).rejects.toThrow(/OwnershipResolverFor\('instructor_application'\)/);
  });
});
