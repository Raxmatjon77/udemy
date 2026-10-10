// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE } from '@udemy/nest-common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import { COURSE_ENTITLEMENTS, type CourseEntitlements } from '../../shared/entitlements';
import { REDIS } from '../../shared/redis';
import { LectureAccessAuthorizer } from '../catalog/application/lecture-access.authorizer';
import { EnrollmentRepository } from './application/ports/enrollment.repository';
import { EnrollmentEntitlements, EnrollmentFacade } from './index';

/*
 * Design §12 risk "T12": the provider graph with
 * `CourseEntitlementsModule.forRoot({ imports: [EnrollmentModule], useExisting: EnrollmentEntitlements })`
 * while EnrollmentModule imports CatalogModule, whose LectureAccessAuthorizer injects the
 * global COURSE_ENTITLEMENTS token. The real AppModule must compile and boot (the
 * RouteSecurityAuditor runs at bootstrap), and catalog must get the enrollment-backed adapter.
 * No Postgres/Redis: the clients are fakes and the repository is replaced.
 */
const USER = '01900000-0000-7000-8000-0000000000a1';
const COURSE = '01900000-0000-7000-8000-0000000000c1';

const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
const hasActive = vi.fn(async (userId: string, courseId: string) => {
  return userId === USER && courseId === COURSE;
});

describe('enrollment provider graph (real AppModule)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(EnrollmentRepository)
      .useValue({ hasActive })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('binds COURSE_ENTITLEMENTS to the one EnrollmentEntitlements instance', async () => {
    const bound = app.get<CourseEntitlements>(COURSE_ENTITLEMENTS, { strict: false });
    const adapter = app.get(EnrollmentEntitlements, { strict: false });
    expect(adapter).toBeInstanceOf(EnrollmentEntitlements);
    expect(bound).toBe(adapter);

    await expect(bound.hasCourseAccess(USER, COURSE)).resolves.toBe(true);
    await expect(bound.hasCourseAccess(USER, '01900000-0000-7000-8000-0000000000c2')).resolves.toBe(
      false,
    );
    // malformed ids never reach SQL
    await expect(bound.hasCourseAccess('not-a-uuid', COURSE)).resolves.toBe(false);
    expect(hasActive).toHaveBeenCalledTimes(2);
  });

  it("catalog's LectureAccessAuthorizer received the enrollment-backed adapter", () => {
    const authorizer = app.get(LectureAccessAuthorizer, { strict: false });
    expect(Reflect.get(authorizer, 'entitlements')).toBe(
      app.get(EnrollmentEntitlements, { strict: false }),
    );
  });

  it('exposes EnrollmentFacade for commerce', () => {
    expect(app.get(EnrollmentFacade, { strict: false })).toBeInstanceOf(EnrollmentFacade);
  });
});
