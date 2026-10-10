import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { type AssignableRole, isAssignableRole } from '../domain/role';
import {
  type RoleChangeRecord,
  UserRoleRepository,
} from '../application/ports/user-role.repository';
import { rethrowConstraintViolation } from './constraint-errors';

/** Rows hold only INSTRUCTOR/ADMIN (FK + CHECK); anything else is skipped defensively. */
function toAssignable(roleCode: string): AssignableRole | undefined {
  return isAssignableRole(roleCode) ? roleCode : undefined;
}

@Injectable()
export class KyselyUserRoleRepository extends UserRoleRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lockUser(trx: Transaction<DB>, userId: string): Promise<boolean> {
    // Shared-kernel exception (D12): access reads identity.users only as the per-user lock
    // target that ban/unban/grant/revoke/password writers all take (schema doc §6).
    // FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE locks of FK checks.
    const row = await trx
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  async findRoles(userId: string, ex: Executor = this.db): Promise<AssignableRole[]> {
    const rows = await ex
      .selectFrom('access.userRoles')
      .select('roleCode')
      .where('userId', '=', userId)
      .execute();
    return rows.map((r) => toAssignable(r.roleCode)).filter((r) => r !== undefined);
  }

  async findRolesForUsers(
    userIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<Map<string, AssignableRole[]>> {
    const result = new Map<string, AssignableRole[]>();
    if (userIds.length === 0) return result;
    const rows = await ex
      .selectFrom('access.userRoles')
      .select(['userId', 'roleCode'])
      .where('userId', 'in', [...userIds])
      .execute();
    for (const row of rows) {
      const role = toAssignable(row.roleCode);
      if (role === undefined) continue;
      const held = result.get(row.userId) ?? [];
      held.push(role);
      result.set(row.userId, held);
    }
    return result;
  }

  async findUserIdsWithRole(role: AssignableRole, ex: Executor = this.db): Promise<string[]> {
    const rows = await ex
      .selectFrom('access.userRoles')
      .select('userId')
      .where('roleCode', '=', role)
      .orderBy('userId')
      .execute();
    return rows.map((r) => r.userId);
  }

  async insertUserRole(
    trx: Transaction<DB>,
    userId: string,
    role: AssignableRole,
  ): Promise<{ grantedAt: Date } | null> {
    try {
      const row = await trx
        .insertInto('access.userRoles')
        .values({ userId, roleCode: role, grantedAt: sql<Date>`now()` })
        .onConflict((oc) => oc.columns(['userId', 'roleCode']).doNothing())
        .returning('grantedAt')
        .executeTakeFirst();
      return row ?? null;
    } catch (error) {
      return rethrowConstraintViolation(error, role);
    }
  }

  async deleteUserRole(
    trx: Transaction<DB>,
    userId: string,
    role: AssignableRole,
  ): Promise<{ revokedAt: Date } | null> {
    const row = await trx
      .deleteFrom('access.userRoles')
      .where('userId', '=', userId)
      .where('roleCode', '=', role)
      .returning(sql<Date>`now()`.as('revokedAt'))
      .executeTakeFirst();
    return row ?? null;
  }

  async insertRoleChange(
    trx: Transaction<DB>,
    record: RoleChangeRecord,
  ): Promise<{ id: string; occurredAt: Date }> {
    try {
      return await trx
        .insertInto('access.roleChanges')
        .values({
          userId: record.userId,
          roleCode: record.role,
          change: record.change,
          actorId: record.actorId,
          reason: record.reason,
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          occurredAt: sql<Date>`now()`,
        })
        .returning(['id', 'occurredAt'])
        .executeTakeFirstOrThrow();
    } catch (error) {
      return rethrowConstraintViolation(error, record.role);
    }
  }
}
