// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { randomInt, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AuthResultSchema,
  InstructorApplicationDetailSchema,
  InstructorApplicationPageSchema,
  InstructorApplicationSchema,
  MeResponseSchema,
  MyInstructorApplicationsResponseSchema,
  ProfileSchema,
  PublicProfileSchema,
} from '@udemy/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { setupApp } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { BootstrapAdminCommand } from './index';
import { deleteUsersTestData } from './testing/users-test-data';

/*
 * The instructor journey over HTTP with the real AppModule: all four global guards in
 * production order, BFF client credentials, real Postgres + Redis (skipped locally when
 * unreachable, a failure with CI=true).
 *
 *   1. bootstrap an admin through the CLI's use case
 *   2. a student signs up, verifies the email (SQL until T9's flow) and applies
 *   3. the admin approves through the admin client
 *   4. the student can now log in to the instructor client (and could not before)
 */
const PASSWORD = 'correct horse battery staple';
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
    'x-client-user-agent': 'users-e2e-spec',
    'x-client-ip': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
  };
}

const FORM = {
  motivation: 'I have taught programming for ten years and would love to teach here. '.repeat(2),
  expertise: 'TypeScript and Node.js',
  experienceLevel: 'ONLINE',
  portfolioUrl: 'https://example.com/portfolio',
} as const;

describe('users e2e: apply -> admin approves -> instructor app login (real guards, PG, Redis)', () => {
  const pg = useIntegrationDatabase({ max: 2 });
  const itRedis = useIntegrationRedis();
  const userIds: string[] = [];
  const tag = `ue2e${randomUUID().slice(0, 8)}`;
  let app: NestExpressApplication | undefined;

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
  });

  afterAll(async () => {
    await app?.close();
    if (pg.available) await deleteUsersTestData(pg.db, userIds);
    await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
    process.env = IT_APP_ENV.savedEnv;
  });

  async function login(client: App, email: string, expected = 200): Promise<request.Response> {
    return http()
      .post('/api/v1/auth/login')
      .set(bff(client))
      .send({ email, password: PASSWORD })
      .expect(expected);
  }

  function as(client: App, token: string) {
    return {
      get: (path: string) =>
        http().get(path).set(bff(client)).set('authorization', `Bearer ${token}`),
      post: (path: string) =>
        http().post(path).set(bff(client)).set('authorization', `Bearer ${token}`),
      patch: (path: string) =>
        http().patch(path).set(bff(client)).set('authorization', `Bearer ${token}`),
    };
  }

  it('runs the whole journey', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
    if (app === undefined) throw new Error('app not started');

    // 1. Bootstrap an admin through the CLI's use case (idempotent).
    const adminEmail = `${tag}-admin@example.test`;
    const bootstrap = app.get(BootstrapAdminCommand, { strict: false });
    const admin = await bootstrap.execute({
      email: adminEmail,
      displayName: `${tag} Admin`,
      password: PASSWORD,
    });
    userIds.push(admin.userId);
    expect(admin).toMatchObject({ created: true, granted: true });
    await expect(
      bootstrap.execute({ email: adminEmail, displayName: 'ignored', password: PASSWORD }),
    ).resolves.toEqual({ userId: admin.userId, created: false, granted: false });

    // 2. A student signs up, verifies the email (SQL until T9), logs in and applies.
    const studentEmail = `${tag}-student@example.test`;
    await http()
      .post('/api/v1/auth/signup')
      .set(bff('student'))
      .send({ email: studentEmail, password: PASSWORD, displayName: `${tag} Student` })
      .expect(202);
    const { id: studentId } = await pg.db
      .selectFrom('identity.users')
      .select('id')
      .where('email', '=', studentEmail)
      .executeTakeFirstOrThrow();
    userIds.push(studentId);

    let student = AuthResultSchema.parse((await login('student', studentEmail)).body);
    const asStudent = as('student', student.accessToken);

    // Unverified: applying is refused.
    const unverified = await asStudent
      .post('/api/v1/me/instructor-applications')
      .send(FORM)
      .expect(403);
    expect(unverified.body).toMatchObject({ code: 'email_not_verified' });

    await pg.db
      .updateTable('identity.users')
      .set({ emailVerifiedAt: new Date() })
      .where('id', '=', studentId)
      .execute();

    const created = await asStudent
      .post('/api/v1/me/instructor-applications')
      .send(FORM)
      .expect(201);
    const application = InstructorApplicationSchema.parse(created.body);
    expect(created.headers.location).toBe(`/api/v1/instructor-applications/${application.id}`);
    expect(application).toMatchObject({ status: 'PENDING', portfolioUrl: FORM.portfolioUrl });

    await asStudent
      .post('/api/v1/me/instructor-applications')
      .send(FORM)
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('application_already_pending'));
    const mine = MyInstructorApplicationsResponseSchema.parse(
      (await asStudent.get('/api/v1/me/instructor-applications').expect(200)).body,
    );
    expect(mine.items.map((a) => a.id)).toEqual([application.id]);
    InstructorApplicationDetailSchema.parse(
      (await asStudent.get(`/api/v1/instructor-applications/${application.id}`).expect(200)).body,
    );
    // Students cannot use the admin endpoints.
    await asStudent.get('/api/v1/admin/instructor-applications').expect(403);
    await asStudent
      .post(`/api/v1/admin/instructor-applications/${application.id}/approve`)
      .send({})
      .expect(403);

    // Profile + /me.
    const profile = ProfileSchema.parse(
      (
        await asStudent
          .patch('/api/v1/me/profile')
          .send({ displayName: `${tag} Jane`, headline: 'Future teacher' })
          .expect(200)
      ).body,
    );
    expect(profile).toMatchObject({ displayName: `${tag} Jane`, headline: 'Future teacher' });
    const me = MeResponseSchema.parse((await asStudent.get('/api/v1/me').expect(200)).body);
    expect(me).toMatchObject({
      id: studentId,
      roles: ['STUDENT'],
      app: 'student',
      emailVerified: true,
    });

    // 3. Before approval the instructor client refuses the student ...
    const denied = await login('instructor', studentEmail, 403);
    expect(denied.body).toMatchObject({ code: 'app_access_denied' });

    // ... the admin finds the application in the queue and approves it.
    const adminLogin = AuthResultSchema.parse((await login('admin', adminEmail)).body);
    const asAdmin = as('admin', adminLogin.accessToken);
    const queue = InstructorApplicationPageSchema.parse(
      (
        await asAdmin
          .get('/api/v1/admin/instructor-applications?status=PENDING&limit=100')
          .expect(200)
      ).body,
    );
    const queued = queue.items.find((item) => item.id === application.id);
    expect(queued?.applicant).toEqual({
      id: studentId,
      email: studentEmail,
      displayName: `${tag} Jane`,
      emailVerified: true,
      status: 'ACTIVE',
    });
    InstructorApplicationDetailSchema.parse(
      (await asAdmin.get(`/api/v1/instructor-applications/${application.id}`).expect(200)).body,
    );

    // A stale expectedVersion is 409 version_conflict.
    await asAdmin
      .post(`/api/v1/admin/instructor-applications/${application.id}/approve`)
      .send({ expectedVersion: 5 })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('version_conflict'));
    const approved = InstructorApplicationSchema.parse(
      (
        await asAdmin
          .post(`/api/v1/admin/instructor-applications/${application.id}/approve`)
          .send({ note: 'Welcome aboard', expectedVersion: queued?.version })
          .expect(200)
      ).body,
    );
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2 });
    await asAdmin
      .post(`/api/v1/admin/instructor-applications/${application.id}/approve`)
      .send({})
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('invalid_state_transition'));
    await asStudent
      .post(`/api/v1/me/instructor-applications/${application.id}/withdraw`)
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('invalid_state_transition'));

    // Admin users views.
    const users = AdminUserPageSchema.parse(
      (await asAdmin.get(`/api/v1/admin/users?q=${tag}&role=INSTRUCTOR`).expect(200)).body,
    );
    expect(users.items.map((u) => [u.id, u.roles])).toEqual([
      [studentId, ['STUDENT', 'INSTRUCTOR']],
    ]);
    const detail = AdminUserDetailSchema.parse(
      (await asAdmin.get(`/api/v1/admin/users/${studentId}`).expect(200)).body,
    );
    expect(detail).toMatchObject({ roles: ['STUDENT', 'INSTRUCTOR'], bans: [] });
    expect(detail.activeSessionCount).toBeGreaterThanOrEqual(1);
    await asAdmin
      .post(`/api/v1/admin/users/${admin.userId}/ban`)
      .send({ reason: 'Trying to ban myself' })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('cannot_ban_self'));

    // 4. The student can now log in to the instructor client.
    const instructor = AuthResultSchema.parse((await login('instructor', studentEmail)).body);
    expect(instructor.user.roles).toEqual(['STUDENT', 'INSTRUCTOR']);
    const meAsInstructor = MeResponseSchema.parse(
      (await as('instructor', instructor.accessToken).get('/api/v1/me').expect(200)).body,
    );
    expect(meAsInstructor.app).toBe('instructor');

    const publicProfile = PublicProfileSchema.parse(
      (await http().get(`/api/v1/users/${studentId}/profile`).set(bff('student')).expect(200)).body,
    );
    expect(publicProfile).toMatchObject({ isInstructor: true, headline: 'Future teacher' });

    // A fresh student-app login also carries the new role.
    student = AuthResultSchema.parse((await login('student', studentEmail)).body);
    expect(student.user.roles).toEqual(['STUDENT', 'INSTRUCTOR']);
  });
});
