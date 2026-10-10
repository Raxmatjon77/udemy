import { Injectable } from '@nestjs/common';
import type { ClientApp, Permission } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { RoleNotAssignable, UserNotFound } from '../domain/access.errors';
import {
  canLoginToApp as canLoginToAppPolicy,
  effectivePermissions as effectivePermissionsPolicy,
} from '../domain/permission-policy';
import {
  type AssignableRole,
  IMPLICIT_ROLE,
  isAssignableRole,
  type Role,
  withImplicitRole,
} from '../domain/role';
import { assertGrantProvenance, assertRoleChangeReason } from '../domain/role-change';
import type { GrantRoleCommand, RevokeRoleCommand, RoleChangeResult } from './access.types';
import { RoleEventPublisher } from './ports/role-event.publisher';
import { UserRoleRepository } from './ports/user-role.repository';

/**
 * Public API of the access context (design §3). Write methods run in the caller's
 * transaction; read methods accept an optional executor (default: the root database).
 */
@Injectable()
export class AccessFacade {
  constructor(
    private readonly userRoles: UserRoleRepository,
    private readonly events: RoleEventPublisher,
  ) {}

  /**
   * Every role the user holds, STUDENT always included (implicit, D5), canonical order.
   * Does not check that the user exists; that is identity's job.
   */
  async getRoles(userId: string, ex?: Executor): Promise<Role[]> {
    return withImplicitRole(await this.userRoles.findRoles(userId, ex));
  }

  /** One entry per requested id (STUDENT at least), same semantics as `getRoles`. */
  async getRolesForUsers(userIds: readonly string[], ex?: Executor): Promise<Map<string, Role[]>> {
    const unique = [...new Set(userIds)];
    const stored =
      unique.length === 0 ? new Map() : await this.userRoles.findRolesForUsers(unique, ex);
    return new Map(unique.map((id) => [id, withImplicitRole(stored.get(id) ?? [])]));
  }

  /** Users holding an explicit role (STUDENT is everyone and therefore not listable). */
  listUserIdsWithRole(role: AssignableRole, ex?: Executor): Promise<string[]> {
    if (!isAssignableRole(role)) throw new RoleNotAssignable(role);
    return this.userRoles.findUserIdsWithRole(role, ex);
  }

  async hasRole(userId: string, role: Role, ex?: Executor): Promise<boolean> {
    if (role === IMPLICIT_ROLE) return true;
    return (await this.getRoles(userId, ex)).includes(role);
  }

  /**
   * Idempotent grant. Only when `access.user_roles` actually changed are the history row
   * (`access.role_changes`) and the `RoleGranted` outbox event written, all in `trx`.
   *
   * @throws RoleNotAssignable for STUDENT, UserNotFound, ValidationError (reason)
   */
  async grantRole(trx: Transaction<DB>, cmd: GrantRoleCommand): Promise<RoleChangeResult> {
    if (!isAssignableRole(cmd.role)) throw new RoleNotAssignable(cmd.role);
    assertRoleChangeReason(cmd.reason);
    assertGrantProvenance(cmd.actorId, cmd.source);
    const role = cmd.role;

    await this.lockUser(trx, cmd.userId);
    const inserted = await this.userRoles.insertUserRole(trx, cmd.userId, role);
    if (inserted === null) return { changed: false };

    const change = await this.userRoles.insertRoleChange(trx, {
      userId: cmd.userId,
      role,
      change: 'GRANTED',
      actorId: cmd.actorId,
      reason: cmd.reason,
      sourceType: cmd.source.type,
      sourceId: cmd.source.type === 'instructor_application' ? cmd.source.id : null,
    });
    await this.events.roleGranted(trx, {
      userId: cmd.userId,
      role,
      grantedBy: cmd.actorId,
      source: cmd.source,
      grantedAt: change.occurredAt.toISOString(),
    });
    return { changed: true };
  }

  /**
   * Idempotent revoke, symmetric to `grantRole` (history + `RoleRevoked` only on change).
   * The caller must also revoke the sessions of apps that needed the role (design §5).
   *
   * @throws RoleNotAssignable for STUDENT, UserNotFound, ValidationError (reason)
   */
  async revokeRole(trx: Transaction<DB>, cmd: RevokeRoleCommand): Promise<RoleChangeResult> {
    if (!isAssignableRole(cmd.role)) throw new RoleNotAssignable(cmd.role);
    assertRoleChangeReason(cmd.reason);
    const role = cmd.role;

    await this.lockUser(trx, cmd.userId);
    const deleted = await this.userRoles.deleteUserRole(trx, cmd.userId, role);
    if (deleted === null) return { changed: false };

    const change = await this.userRoles.insertRoleChange(trx, {
      userId: cmd.userId,
      role,
      change: 'REVOKED',
      actorId: cmd.actorId,
      reason: cmd.reason,
      sourceType: null,
      sourceId: null,
    });
    await this.events.roleRevoked(trx, {
      userId: cmd.userId,
      role,
      revokedBy: cmd.actorId,
      reason: cmd.reason,
      revokedAt: change.occurredAt.toISOString(),
    });
    return { changed: true };
  }

  /** BASELINE ∪ permissions(roles ∩ scope(app)) (design D6). */
  effectivePermissions(roles: readonly Role[], app: ClientApp): ReadonlySet<Permission> {
    return effectivePermissionsPolicy(roles, app);
  }

  /** The user holds a role allowed in `app` (student: everyone; instructor/admin: that role). */
  canLoginToApp(roles: readonly Role[], app: ClientApp): boolean {
    return canLoginToAppPolicy(roles, app);
  }

  /**
   * Serialises role changes with ban/unban and the other per-user writers (schema doc §6).
   * The lock row lives in `identity.users`: an accepted shared-kernel exception (D12), used
   * as a lock target only, never read for data.
   */
  private async lockUser(trx: Transaction<DB>, userId: string): Promise<void> {
    if (!(await this.userRoles.lockUser(trx, userId))) throw new UserNotFound();
  }
}
