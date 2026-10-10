import type { DB, Executor, Transaction } from '@udemy/db';
import { ValidationError } from '@udemy/nest-common/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleNotAssignable, UserNotFound } from '../domain/access.errors';
import type { AssignableRole } from '../domain/role';
import { AccessFacade } from './access.facade';
import { RoleEventPublisher } from './ports/role-event.publisher';
import { type RoleChangeRecord, UserRoleRepository } from './ports/user-role.repository';

const ALICE = '0199b0a4-0000-7000-8000-00000000000a';
const ADMIN_ID = '0199b0a4-0000-7000-8000-0000000000ad';
const NOW = new Date('2026-10-10T10:00:00.000Z');
const trx = { isTransaction: true } as unknown as Transaction<DB>;

/** In-memory port implementation: enough to test the orchestration rules. */
class FakeUserRoles extends UserRoleRepository {
  readonly users = new Set<string>([ALICE, ADMIN_ID]);
  readonly held = new Map<string, Set<AssignableRole>>();
  readonly changes: RoleChangeRecord[] = [];
  readonly locked: string[] = [];

  async lockUser(_trx: Transaction<DB>, userId: string): Promise<boolean> {
    this.locked.push(userId);
    return this.users.has(userId);
  }
  async findRoles(userId: string, _ex?: Executor): Promise<AssignableRole[]> {
    return [...(this.held.get(userId) ?? [])];
  }
  async findRolesForUsers(ids: readonly string[]): Promise<Map<string, AssignableRole[]>> {
    return new Map(
      ids.filter((id) => this.held.has(id)).map((id) => [id, [...this.held.get(id)!]]),
    );
  }
  async findUserIdsWithRole(role: AssignableRole): Promise<string[]> {
    return [...this.held].filter(([, roles]) => roles.has(role)).map(([id]) => id);
  }
  async insertUserRole(_t: Transaction<DB>, userId: string, role: AssignableRole) {
    const roles = this.held.get(userId) ?? new Set<AssignableRole>();
    if (roles.has(role)) return null;
    roles.add(role);
    this.held.set(userId, roles);
    return { grantedAt: NOW };
  }
  async deleteUserRole(_t: Transaction<DB>, userId: string, role: AssignableRole) {
    return this.held.get(userId)?.delete(role) === true ? { revokedAt: NOW } : null;
  }
  async insertRoleChange(_t: Transaction<DB>, record: RoleChangeRecord) {
    this.changes.push(record);
    return { id: `change-${this.changes.length}`, occurredAt: NOW };
  }
}

describe('AccessFacade', () => {
  let repo: FakeUserRoles;
  let events: { roleGranted: ReturnType<typeof vi.fn>; roleRevoked: ReturnType<typeof vi.fn> };
  let facade: AccessFacade;

  beforeEach(() => {
    repo = new FakeUserRoles();
    events = {
      roleGranted: vi.fn(async () => undefined),
      roleRevoked: vi.fn(async () => undefined),
    };
    facade = new AccessFacade(repo, events as unknown as RoleEventPublisher);
  });

  it('getRoles always includes STUDENT, in canonical order', async () => {
    expect(await facade.getRoles(ALICE)).toEqual(['STUDENT']);
    repo.held.set(ALICE, new Set(['ADMIN', 'INSTRUCTOR']));
    expect(await facade.getRoles(ALICE)).toEqual(['STUDENT', 'INSTRUCTOR', 'ADMIN']);
  });

  it('getRolesForUsers returns an entry per requested id', async () => {
    repo.held.set(ALICE, new Set(['INSTRUCTOR']));
    const roles = await facade.getRolesForUsers([ALICE, ADMIN_ID, ALICE]);
    expect([...roles]).toEqual([
      [ALICE, ['STUDENT', 'INSTRUCTOR']],
      [ADMIN_ID, ['STUDENT']],
    ]);
    expect(await facade.getRolesForUsers([])).toEqual(new Map());
  });

  it('hasRole: STUDENT is always held, explicit roles come from storage', async () => {
    expect(await facade.hasRole(ALICE, 'STUDENT')).toBe(true);
    expect(await facade.hasRole(ALICE, 'ADMIN')).toBe(false);
    repo.held.set(ALICE, new Set(['ADMIN']));
    expect(await facade.hasRole(ALICE, 'ADMIN')).toBe(true);
    expect(await facade.listUserIdsWithRole('ADMIN')).toEqual([ALICE]);
  });

  it('grantRole is idempotent: history + event only on the first call', async () => {
    const cmd = {
      userId: ALICE,
      role: 'INSTRUCTOR' as const,
      actorId: ADMIN_ID,
      reason: 'approved',
      source: {
        type: 'instructor_application' as const,
        id: '0199b0a4-0000-7000-8000-000000000101',
      },
    };
    await expect(facade.grantRole(trx, cmd)).resolves.toEqual({ changed: true });
    await expect(facade.grantRole(trx, cmd)).resolves.toEqual({ changed: false });
    expect(repo.locked).toEqual([ALICE, ALICE]);
    expect(repo.changes).toEqual([
      {
        userId: ALICE,
        role: 'INSTRUCTOR',
        change: 'GRANTED',
        actorId: ADMIN_ID,
        reason: 'approved',
        sourceType: 'instructor_application',
        sourceId: '0199b0a4-0000-7000-8000-000000000101',
      },
    ]);
    expect(events.roleGranted).toHaveBeenCalledOnce();
    expect(events.roleGranted).toHaveBeenCalledWith(trx, {
      userId: ALICE,
      role: 'INSTRUCTOR',
      grantedBy: ADMIN_ID,
      source: cmd.source,
      grantedAt: NOW.toISOString(),
    });
  });

  it('grantRole rejects STUDENT before touching storage', async () => {
    await expect(
      facade.grantRole(trx, {
        userId: ALICE,
        role: 'STUDENT',
        actorId: ADMIN_ID,
        reason: 'x',
        source: { type: 'admin' },
      }),
    ).rejects.toBeInstanceOf(RoleNotAssignable);
    expect(repo.locked).toEqual([]);
  });

  it('grantRole: unknown user -> UserNotFound; bad reason -> ValidationError; bad provenance -> Error', async () => {
    const base = {
      role: 'ADMIN' as const,
      reason: 'bootstrap',
      source: { type: 'cli_bootstrap' as const },
    };
    await expect(
      facade.grantRole(trx, {
        ...base,
        userId: '0199b0a4-0000-7000-8000-0000000000ff',
        actorId: null,
      }),
    ).rejects.toBeInstanceOf(UserNotFound);
    await expect(
      facade.grantRole(trx, { ...base, userId: ALICE, actorId: null, reason: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      facade.grantRole(trx, { ...base, userId: ALICE, actorId: ADMIN_ID }),
    ).rejects.toThrow(/cli_bootstrap/);
    expect(repo.changes).toEqual([]);
  });

  it('revokeRole is symmetric and idempotent', async () => {
    repo.held.set(ALICE, new Set(['INSTRUCTOR']));
    const cmd = { userId: ALICE, role: 'INSTRUCTOR' as const, actorId: ADMIN_ID, reason: 'abuse' };
    await expect(facade.revokeRole(trx, cmd)).resolves.toEqual({ changed: true });
    await expect(facade.revokeRole(trx, cmd)).resolves.toEqual({ changed: false });
    expect(repo.changes).toMatchObject([{ change: 'REVOKED', sourceType: null, sourceId: null }]);
    expect(events.roleRevoked).toHaveBeenCalledOnce();
    expect(events.roleRevoked).toHaveBeenCalledWith(trx, {
      userId: ALICE,
      role: 'INSTRUCTOR',
      revokedBy: ADMIN_ID,
      reason: 'abuse',
      revokedAt: NOW.toISOString(),
    });
    await expect(facade.revokeRole(trx, { ...cmd, role: 'STUDENT' })).rejects.toBeInstanceOf(
      RoleNotAssignable,
    );
  });

  it('delegates effectivePermissions / canLoginToApp to the domain policy', () => {
    expect(facade.canLoginToApp(['STUDENT'], 'admin')).toBe(false);
    expect(facade.effectivePermissions(['STUDENT', 'ADMIN'], 'admin').has('role:grant:any')).toBe(
      true,
    );
  });
});
