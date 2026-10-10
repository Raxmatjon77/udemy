import { randomUUID } from 'node:crypto';
import { createDatabase, type DB, type Kysely, sql, type Transaction } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxPublisher } from '../../../shared/outbox';
import { AccessFacade } from '../application/access.facade';
import { RoleNotAssignable, UserNotFound } from '../domain/access.errors';
import { KyselyUserRoleRepository } from './kysely-user-role.repository';
import { OutboxRoleEventPublisher } from './outbox-role-event.publisher';

/**
 * Runs against the dev Postgres (port 55432; override with ACCESS_IT_DATABASE_URL). Every
 * test runs in a transaction that is always rolled back: role_changes is append-only and
 * cannot be truncated. Skips cleanly when Postgres is unreachable.
 */
const DATABASE_URL =
  process.env.ACCESS_IT_DATABASE_URL ?? 'postgres://udemy:udemy@localhost:55432/udemy';

class Rollback extends Error {}

describe('access (integration, real Postgres)', () => {
  let db: Kysely<DB>;
  let facade: AccessFacade;
  let reachable = false;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL, max: 2 });
    try {
      await sql`select 1 from access.roles limit 1`.execute(db);
      reachable = true;
    } catch {
      reachable = false;
    }
    facade = new AccessFacade(
      new KyselyUserRoleRepository(db),
      new OutboxRoleEventPublisher(new OutboxPublisher()),
    );
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Runs `fn` in a transaction and always rolls it back. */
  async function inRolledBackTransaction(
    fn: (trx: Transaction<DB>) => Promise<void>,
  ): Promise<void> {
    await db
      .transaction()
      .execute(async (trx) => {
        await fn(trx);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  }

  async function createUser(trx: Transaction<DB>): Promise<string> {
    const row = await trx
      .insertInto('identity.users')
      .values({
        email: `access-it-${randomUUID()}@example.test`,
        displayName: 'Access IT',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const historyOf = (trx: Transaction<DB>, userId: string) =>
    trx
      .selectFrom('access.roleChanges')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('occurredAt')
      .orderBy('id')
      .execute();

  const outboxOf = (trx: Transaction<DB>, userId: string) =>
    trx
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType', 'payload'])
      .where('aggregateId', '=', userId)
      .where('aggregateType', '=', 'access.user_role')
      .orderBy('createdAt')
      .orderBy('id')
      .execute();

  it('grantRole is idempotent: one user_roles row, one history row, one outbox event', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const admin = await createUser(trx);
      const user = await createUser(trx);
      const cmd = {
        userId: user,
        role: 'ADMIN' as const,
        actorId: admin,
        reason: 'promoted by an admin',
        source: { type: 'admin' as const },
      };

      await expect(facade.grantRole(trx, cmd)).resolves.toEqual({ changed: true });
      await expect(facade.grantRole(trx, cmd)).resolves.toEqual({ changed: false });

      expect(await facade.getRoles(user, trx)).toEqual(['STUDENT', 'ADMIN']);
      expect(await facade.hasRole(user, 'ADMIN', trx)).toBe(true);
      expect(await facade.listUserIdsWithRole('ADMIN', trx)).toContain(user);
      const history = await historyOf(trx, user);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        change: 'GRANTED',
        roleCode: 'ADMIN',
        actorId: admin,
        sourceType: 'admin',
        sourceId: null,
      });
      const outbox = await outboxOf(trx, user);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        type: 'RoleGranted.v1',
        payload: { userId: user, role: 'ADMIN', grantedBy: admin, source: { type: 'admin' } },
      });
    });
  });

  it('records the CLI bootstrap grant with a null actor', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const user = await createUser(trx);
      await facade.grantRole(trx, {
        userId: user,
        role: 'ADMIN',
        actorId: null,
        reason: 'first admin',
        source: { type: 'cli_bootstrap' },
      });
      expect(await historyOf(trx, user)).toMatchObject([
        { actorId: null, sourceType: 'cli_bootstrap' },
      ]);
    });
  });

  it('granting STUDENT is rejected with RoleNotAssignable and writes nothing', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const admin = await createUser(trx);
      const user = await createUser(trx);
      await expect(
        facade.grantRole(trx, {
          userId: user,
          role: 'STUDENT',
          actorId: admin,
          reason: 'nope',
          source: { type: 'admin' },
        }),
      ).rejects.toBeInstanceOf(RoleNotAssignable);
      expect(await historyOf(trx, user)).toHaveLength(0);
      expect(await outboxOf(trx, user)).toHaveLength(0);
    });
  });

  it('the database itself refuses STUDENT rows (mapped to RoleNotAssignable)', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const user = await createUser(trx);
      const repo = new KyselyUserRoleRepository(db);
      await expect(
        repo.insertUserRole(trx, user, 'STUDENT' as unknown as 'ADMIN'),
      ).rejects.toBeInstanceOf(RoleNotAssignable);
    });
  });

  it('grant to an unknown user is UserNotFound', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const admin = await createUser(trx);
      await expect(
        facade.grantRole(trx, {
          userId: randomUUID(),
          role: 'INSTRUCTOR',
          actorId: admin,
          reason: 'x',
          source: { type: 'admin' },
        }),
      ).rejects.toBeInstanceOf(UserNotFound);
    });
  });

  it('revokeRole writes history and RoleRevoked only when a role was removed', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const admin = await createUser(trx);
      const user = await createUser(trx);
      const applicationId = randomUUID();
      await facade.grantRole(trx, {
        userId: user,
        role: 'INSTRUCTOR',
        actorId: admin,
        reason: 'application approved',
        source: { type: 'instructor_application', id: applicationId },
      });

      const cmd = { userId: user, role: 'INSTRUCTOR' as const, actorId: admin, reason: 'abuse' };
      await expect(facade.revokeRole(trx, cmd)).resolves.toEqual({ changed: true });
      await expect(facade.revokeRole(trx, cmd)).resolves.toEqual({ changed: false });

      expect(await facade.getRoles(user, trx)).toEqual(['STUDENT']);
      expect(await historyOf(trx, user)).toMatchObject([
        { change: 'GRANTED', sourceType: 'instructor_application', sourceId: applicationId },
        { change: 'REVOKED', actorId: admin, reason: 'abuse', sourceType: null },
      ]);
      const outbox = await outboxOf(trx, user);
      expect(outbox.map((e) => e.type)).toEqual(['RoleGranted.v1', 'RoleRevoked.v1']);
      expect(outbox[1]?.payload).toMatchObject({ revokedBy: admin, reason: 'abuse' });
    });
  });

  it('getRolesForUsers covers users without explicit roles', async (ctx) => {
    if (!reachable) ctx.skip();
    await inRolledBackTransaction(async (trx) => {
      const admin = await createUser(trx);
      const plain = await createUser(trx);
      await facade.grantRole(trx, {
        userId: admin,
        role: 'ADMIN',
        actorId: null,
        reason: 'first admin',
        source: { type: 'cli_bootstrap' },
      });
      const roles = await facade.getRolesForUsers([admin, plain], trx);
      expect(roles.get(admin)).toEqual(['STUDENT', 'ADMIN']);
      expect(roles.get(plain)).toEqual(['STUDENT']);
    });
  });
});
