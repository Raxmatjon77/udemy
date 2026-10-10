// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { randomInt, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AuthResultSchema } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { ConflictError, DomainError } from '@udemy/nest-common/errors';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { setupApp } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { AccessFacade } from '../access';
import { IdentityFacade } from '../identity';
import { InstructorApplicationRepository } from './application/ports/instructor-application.repository';
import { AdminSearchUsersQuery } from './application/use-cases/admin-search-users.query';
import { ApproveInstructorApplicationCommand } from './application/use-cases/approve-instructor-application.command';
import { BanUserCommand } from './application/use-cases/ban-user.command';
import { BootstrapAdminCommand } from './application/use-cases/bootstrap-admin.command';
import { RejectInstructorApplicationCommand } from './application/use-cases/reject-instructor-application.command';
import { SubmitInstructorApplicationCommand } from './application/use-cases/submit-instructor-application.command';
import { UpdateMyProfileCommand } from './application/use-cases/update-my-profile.command';
import {
  ApplicationAlreadyPending,
  EmailNotVerified,
  InvalidStateTransition,
  InvalidUsersField,
  SelfDecisionForbidden,
  TargetIsAdmin,
} from './domain/users.errors';
import { deleteUsersTestData } from './testing/users-test-data';

/*
 * The users module against the integration Postgres + Redis (IT_DATABASE_URL / IT_REDIS_URL;
 * skipped locally when unreachable, a failure with CI=true), wired by the real AppModule.
 * Use cases are called directly; HTTP is used only where a login (session) is needed.
 */
const PASSWORD = 'correct horse battery staple';
const UA = 'users-integration-spec';
const SECRETS = {
  student: 'dev-student-bff-secret-change-me-in-prod',
  instructor: 'dev-instructor-bff-secret-change-me-in-prod',
  admin: 'dev-admin-bff-secret-change-me-in-prod',
} as const;
type App = keyof typeof SECRETS;

function bff(app: App): Record<string, string> {
  return {
    'x-client-id': `${app}-bff`,
    'x-client-secret': SECRETS[app],
    'x-client-user-agent': UA,
    'x-client-ip': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
  };
}

const FORM = {
  motivation: 'I have taught programming for ten years and would love to teach here. '.repeat(2),
  expertise: 'TypeScript and Node.js',
  experienceLevel: 'PROFESSIONAL',
} as const;
const REASON = 'Please describe your teaching experience in more detail.';

class Rollback extends Error {}

describe('users (integration: real AppModule, Postgres, Redis)', () => {
  const pg = useIntegrationDatabase({ max: 2 });
  const itRedis = useIntegrationRedis();
  const userIds: string[] = [];
  /** A unique token in every display name, so the admin search only sees this run's users. */
  const runTag = `uit${randomUUID().slice(0, 8)}`;
  let app: NestExpressApplication | undefined;
  let adminId = '';
  let adminEmail = '';

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const http = () => {
    if (app === undefined) throw new Error('app not started');
    return request(app.getHttpServer());
  };

  beforeAll(async () => {
    if (!pg.available || !itRedis.available) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    setupApp(app);
    await app.init();

    adminEmail = `${runTag}-admin@example.test`;
    const admin = await get(BootstrapAdminCommand).execute({
      email: adminEmail,
      displayName: `${runTag} Admin`,
      password: PASSWORD,
    });
    adminId = admin.userId;
    userIds.push(adminId);
  });

  afterAll(async () => {
    await app?.close();
    if (pg.available) await deleteUsersTestData(pg.db, userIds);
    await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
    process.env = IT_APP_ENV.savedEnv;
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  /** A user row (dummy hash: cannot log in) or, with `login`, a real provisioned account. */
  async function createUser(
    options: { verified?: boolean; login?: boolean; name?: string } = {},
  ): Promise<{ id: string; email: string }> {
    const email = `${runTag}-${randomUUID()}@example.test`;
    const displayName = `${runTag} ${options.name ?? 'User'}`;
    let id: string;
    if (options.login === true) {
      ({ userId: id } = await pg.db.transaction().execute((trx) =>
        get(IdentityFacade).provisionAccount(trx, {
          email,
          displayName,
          password: PASSWORD,
          emailVerified: true,
        }),
      ));
    } else {
      ({ id } = await pg.db
        .insertInto('identity.users')
        .values({
          email,
          displayName,
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
          emailVerifiedAt: options.verified === false ? null : new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow());
    }
    userIds.push(id);
    return { id, email };
  }

  async function submit(applicantId: string): Promise<string> {
    return (await get(SubmitInstructorApplicationCommand).execute({ applicantId, form: FORM })).id;
  }

  async function outboxTypes(aggregateId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', aggregateId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.type);
  }

  async function login(
    app: App,
    email: string,
  ): Promise<{ accessToken: string; sessionId: string }> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set(bff(app))
      .send({ email, password: PASSWORD })
      .expect(200);
    return AuthResultSchema.parse(res.body);
  }

  it('submit -> approve grants INSTRUCTOR and writes the transitions and outbox rows', async (ctx) => {
    skip(ctx);
    const student = await createUser();
    const applicationId = await submit(student.id);

    const approved = await get(ApproveInstructorApplicationCommand).execute({
      actorId: adminId,
      applicationId,
      note: 'Welcome aboard',
      expectedVersion: 1,
    });

    expect(approved).toMatchObject({ status: 'APPROVED', version: 2 });
    expect(approved.transitions.map((t) => [t.fromStatus, t.toStatus, t.actorId])).toEqual([
      [null, 'PENDING', student.id],
      ['PENDING', 'APPROVED', adminId],
    ]);
    // submitted_at = the submission transition's occurred_at (same transaction, same now()).
    expect(approved.transitions[0]?.occurredAt).toBe(approved.submittedAt);
    await expect(get(AccessFacade).getRoles(student.id)).resolves.toEqual([
      'STUDENT',
      'INSTRUCTOR',
    ]);
    const history = await pg.db
      .selectFrom('access.roleChanges')
      .selectAll()
      .where('userId', '=', student.id)
      .execute();
    expect(history).toEqual([
      expect.objectContaining({
        roleCode: 'INSTRUCTOR',
        change: 'GRANTED',
        actorId: adminId,
        sourceType: 'instructor_application',
        sourceId: applicationId,
      }),
    ]);
    await expect(outboxTypes(applicationId)).resolves.toEqual([
      'InstructorApplicationSubmitted.v1',
      'InstructorApplicationApproved.v1',
    ]);
    await expect(outboxTypes(student.id)).resolves.toContain('RoleGranted.v1');
  });

  it('a double approve is 409 invalid_state_transition (and the DB refuses a second decision too)', async (ctx) => {
    skip(ctx);
    const student = await createUser();
    const applicationId = await submit(student.id);
    const approve = get(ApproveInstructorApplicationCommand);
    await approve.execute({ actorId: adminId, applicationId });

    const error = await approve
      .execute({ actorId: adminId, applicationId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidStateTransition);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as DomainError).code).toBe('invalid_state_transition');

    // Backstop: a transition row past the domain check hits ia_transitions_*_uq.
    const repo = get(InstructorApplicationRepository);
    const backstop = await pg.db
      .transaction()
      .execute((trx) =>
        repo.insertTransition(trx, {
          applicationId,
          applicantId: student.id,
          fromStatus: 'PENDING',
          toStatus: 'REJECTED',
          actorId: adminId,
          reason: REASON,
        }),
      )
      .catch((e: unknown) => e);
    expect(backstop).toBeInstanceOf(InvalidStateTransition);
  });

  it('self-approval is 403 self_decision_forbidden (domain check and DB trigger)', async (ctx) => {
    skip(ctx);
    const student = await createUser();
    const applicationId = await submit(student.id);

    const error = await get(ApproveInstructorApplicationCommand)
      .execute({ actorId: student.id, applicationId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SelfDecisionForbidden);
    expect((error as DomainError).kind).toBe('forbidden');

    // ia_transitions_actor_trg -> ia_transitions_actor_ck, mapped to the same error.
    const repo = get(InstructorApplicationRepository);
    const trigger = await pg.db
      .transaction()
      .execute(async (trx: Transaction<DB>) => {
        await repo.insertTransition(trx, {
          applicationId,
          applicantId: student.id,
          fromStatus: 'PENDING',
          toStatus: 'APPROVED',
          actorId: student.id,
          reason: null,
        });
        throw new Rollback();
      })
      .catch((e: unknown) => e);
    expect(trigger).toBeInstanceOf(SelfDecisionForbidden);
  });

  it('reject without a reason: 422 from the use case, 400 over HTTP', async (ctx) => {
    skip(ctx);
    const student = await createUser();
    const applicationId = await submit(student.id);

    await expect(
      get(RejectInstructorApplicationCommand).execute({
        actorId: adminId,
        applicationId,
        reason: ' ',
      }),
    ).rejects.toThrow(InvalidUsersField);

    const { accessToken } = await login('admin', adminEmail);
    const res = await http()
      .post(`/api/v1/admin/instructor-applications/${applicationId}/reject`)
      .set(bff('admin'))
      .set('authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);
    expect(res.body).toMatchObject({ code: 'validation_failed' });
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'reason' })]);

    const still = await pg.db
      .selectFrom('users.instructorApplications')
      .select(['status', 'version'])
      .where('id', '=', applicationId)
      .executeTakeFirstOrThrow();
    expect(still).toEqual({ status: 'PENDING', version: 1 });
  });

  it('concurrent approve + reject on the same application: exactly one wins', async (ctx) => {
    skip(ctx);
    const approve = get(ApproveInstructorApplicationCommand);
    const reject = get(RejectInstructorApplicationCommand);
    for (let round = 0; round < 5; round += 1) {
      const student = await createUser();
      const applicationId = await submit(student.id);

      const results = await Promise.allSettled([
        approve.execute({ actorId: adminId, applicationId }),
        reject.execute({ actorId: adminId, applicationId, reason: REASON }),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidStateTransition);

      const row = await pg.db
        .selectFrom('users.instructorApplications')
        .select(['status', 'version'])
        .where('id', '=', applicationId)
        .executeTakeFirstOrThrow();
      const transitions = await pg.db
        .selectFrom('users.instructorApplicationTransitions')
        .select('toStatus')
        .where('applicationId', '=', applicationId)
        .execute();
      expect(row.version).toBe(2);
      expect(transitions.map((t) => t.toStatus).sort()).toEqual(['PENDING', row.status].sort());
      const isInstructor = await get(AccessFacade).hasRole(student.id, 'INSTRUCTOR');
      expect(isInstructor).toBe(row.status === 'APPROVED');
      expect(await outboxTypes(applicationId)).toHaveLength(2);
    }
  });

  it('submit checks eligibility fresh: unverified email 403, second PENDING 409', async (ctx) => {
    skip(ctx);
    const unverified = await createUser({ verified: false });
    await expect(submit(unverified.id)).rejects.toThrow(EmailNotVerified);

    const student = await createUser();
    await submit(student.id);
    await expect(submit(student.id)).rejects.toThrow(ApplicationAlreadyPending);

    // The partial unique index answers the same when the pre-check is bypassed (race).
    const repo = get(InstructorApplicationRepository);
    const raced = await pg.db
      .transaction()
      .execute((trx) =>
        repo.insert(trx, {
          applicantId: student.id,
          motivation: FORM.motivation,
          expertise: FORM.expertise,
          experienceLevel: 'PROFESSIONAL',
          portfolioUrl: null,
          transition: { fromStatus: null, toStatus: 'PENDING', actorId: student.id, reason: null },
        }),
      )
      .catch((e: unknown) => e);
    expect(raced).toBeInstanceOf(ApplicationAlreadyPending);
  });

  it('ban revokes every session in the DB and sets the Redis sid keys', async (ctx) => {
    skip(ctx);
    const user = await createUser({ login: true });
    const first = await login('student', user.email);
    const second = await login('student', user.email);

    const ban = await get(BanUserCommand).execute({
      actorId: adminId,
      userId: user.id,
      reason: 'Repeated spam in the Q&A section',
    });
    expect(ban).toMatchObject({ userId: user.id, bannedBy: adminId, liftedAt: null });

    const sessions = await pg.db
      .selectFrom('identity.sessions')
      .select(['id', 'revokedAt', 'revokeReason'])
      .where('userId', '=', user.id)
      .execute();
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).not.toBeNull();
      expect(session.revokeReason).toBe('BANNED');
    }
    for (const sid of [first.sessionId, second.sessionId]) {
      expect(await itRedis.redis.exists(`auth:revoked:sid:${sid}`)).toBe(1);
    }
    // The old access token stops working at once.
    await http()
      .get('/api/v1/me')
      .set(bff('student'))
      .set('authorization', `Bearer ${first.accessToken}`)
      .expect(401);
    await expect(outboxTypes(user.id)).resolves.toContain('UserBanned.v1');
  });

  it('banning an admin is 409 target_is_admin and changes nothing', async (ctx) => {
    skip(ctx);
    const actor = await createUser();
    await pg.db.transaction().execute((trx) =>
      get(AccessFacade).grantRole(trx, {
        userId: actor.id,
        role: 'ADMIN',
        actorId: null,
        reason: 'integration test',
        source: { type: 'cli_bootstrap' },
      }),
    );

    const error = await get(BanUserCommand)
      .execute({ actorId: actor.id, userId: adminId, reason: 'Trying to ban another admin' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TargetIsAdmin);
    expect((error as DomainError).code).toBe('target_is_admin');
    expect((error as DomainError).kind).toBe('conflict');
    const bans = await pg.db
      .selectFrom('identity.userBans')
      .select('id')
      .where('userId', '=', adminId)
      .execute();
    expect(bans).toEqual([]);
  });

  it('the admin search role filter goes through access (idIn) and attaches roles', async (ctx) => {
    skip(ctx);
    const instructor = await createUser({ name: 'Searchable Instructor' });
    const student = await createUser({ name: 'Searchable Student' });
    await get(ApproveInstructorApplicationCommand).execute({
      actorId: adminId,
      applicationId: await submit(instructor.id),
    });
    const search = get(AdminSearchUsersQuery);
    const q = `${runTag} Searchable`;

    const all = await search.execute({ q, limit: 20 });
    expect(all.items.map((u) => u.id).sort()).toEqual([instructor.id, student.id].sort());

    const instructors = await search.execute({ q, role: 'INSTRUCTOR', limit: 20 });
    expect(instructors.items.map((u) => [u.id, u.roles])).toEqual([
      [instructor.id, ['STUDENT', 'INSTRUCTOR']],
    ]);

    const admins = await search.execute({ q: runTag, role: 'ADMIN', limit: 20 });
    expect(admins.items.map((u) => u.id)).toContain(adminId);
    expect(admins.items.map((u) => u.id)).not.toContain(instructor.id);
  });

  it('PATCH profile changes the display name and upserts the profile in one transaction', async (ctx) => {
    skip(ctx);
    const user = await createUser();
    const update = get(UpdateMyProfileCommand);

    await expect(
      update.execute({ userId: user.id, displayName: `${runTag} Renamed`, headline: 'Teacher' }),
    ).resolves.toMatchObject({ displayName: `${runTag} Renamed`, headline: 'Teacher', bio: null });
    // Invalid input changes nothing (neither the name nor the profile).
    await expect(
      update.execute({ userId: user.id, displayName: `${runTag} Never`, bio: 'b'.repeat(4001) }),
    ).rejects.toThrow(InvalidUsersField);
    const summary = await get(IdentityFacade).getUserSummary(user.id);
    expect(summary?.displayName).toBe(`${runTag} Renamed`);
    await expect(outboxTypes(user.id)).resolves.toEqual(['DisplayNameChanged.v1']);
  });
});
