// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { DATABASE } from '@udemy/nest-common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import {
  COURSE_PROGRESS,
  type CourseProgressReader,
  LECTURE_COMPLETIONS,
  type LectureCompletionCounter,
} from '../../shared/learning-progress';
import { REDIS } from '../../shared/redis';
import type { HttpMethod } from '../../testing/e2e/e2e-harness';
import {
  type Operation,
  SECTION_8_PHASE_5_LEARNING_A,
  SECTION_8_PHASE_5_LEARNING_B,
} from '../../testing/e2e/section-8';
import { CatalogFacade } from '../catalog';
import { ReviewEligibility } from '../engagement/application/review-eligibility';
import { EnrollmentFacade } from '../enrollment';
import {
  CertificateOwnership,
  NoteOwnership,
  QuizAttemptOwnership,
} from './application/learning.ownership';
import { LearningSettings } from './application/learning-settings';
import { LearningRepository } from './application/ports/learning.repository';
import { ProgressStore } from './application/ports/progress-store';
import {
  ARTICLE,
  COURSE,
  FakeCatalog,
  FakeClock,
  FakeLearningRepository,
  STUDENT,
  VIDEO,
} from './application/testing/learning.fakes';
import { PROGRESS_FLUSH_INTERVAL_NAME } from './infrastructure/progress-flush.scheduler';
import { RedisProgressStore } from './infrastructure/redis-progress.store';
import { LearningFacade, LearningProgressReader } from './index';

/*
 * The learning provider graph through the REAL AppModule (no Postgres/Redis: fake clients, the
 * repository and catalog replaced): it compiles and boots (the RouteSecurityAuditor runs at
 * bootstrap and fails boot on a route without a security marker), the global COURSE_PROGRESS
 * and LECTURE_COMPLETIONS ports are bound to learning's REAL implementations (no longer the
 * NoCourseProgress / fail-closed NoLectureCompletions defaults), LearningProgressReader does not
 * depend on enrollment (design §1: enrollment injects the token, so that would be a cycle),
 * and Express serves exactly the P5-T10 operations of SECTION_8.
 */
const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

/** [path, method] of every route Express serves (Nest's `:param` written as `{param}`). */
function expressRoutes(app: unknown): Operation[] {
  interface Layer {
    route?: { path: unknown; methods: Record<string, boolean> };
  }
  const router = (app as { router?: { stack?: Layer[] } }).router;
  if (router?.stack === undefined) throw new Error('unexpected Express internals: no app.router');
  return router.stack.flatMap((layer): Operation[] => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== 'string') return [];
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    return Object.keys(route.methods)
      .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
      .map((method): Operation => [path, method]);
  });
}

const op = ([path, method]: Operation): string => `${method.toUpperCase()} ${path}`;

describe('learning provider graph (real AppModule)', () => {
  let app: NestExpressApplication;
  const completions = new FakeLearningRepository(new FakeClock());
  const catalog = new FakeCatalog();

  beforeAll(async () => {
    completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(LearningRepository)
      .useValue(completions)
      .overrideProvider(CatalogFacade)
      .useValue(catalog)
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

  it('binds COURSE_PROGRESS to the one LearningProgressReader instance', async () => {
    const bound = app.get<CourseProgressReader>(COURSE_PROGRESS, { strict: false });
    const reader = app.get(LearningProgressReader, { strict: false });
    expect(reader).toBeInstanceOf(LearningProgressReader);
    expect(bound).toBe(reader);
    await expect(bound.getPercents(STUDENT, [COURSE])).resolves.toEqual(new Map([[COURSE, 25]]));
  });

  it('LearningProgressReader depends only on its repository and CatalogFacade (no cycle)', () => {
    const deps = Reflect.getMetadata('design:paramtypes', LearningProgressReader) as unknown[];
    expect(deps).toEqual([CatalogFacade, LearningRepository]);
    expect(deps).not.toContain(EnrollmentFacade);
  });

  it('binds LECTURE_COMPLETIONS to LearningFacade (the review gate no longer fails closed)', async () => {
    const bound = app.get<LectureCompletionCounter>(LECTURE_COMPLETIONS, { strict: false });
    const facade = app.get(LearningFacade, { strict: false });
    expect(facade).toBeInstanceOf(LearningFacade);
    expect(bound).toBe(facade);
    await expect(bound.completedLectureCount(STUDENT, COURSE)).resolves.toBe(1);
    completions.seedCompletion(STUDENT, COURSE, ARTICLE, 'ARTICLE', 'MANUAL');
    await expect(bound.completedLectureCount(STUDENT, COURSE)).resolves.toBe(2);
    expect(Reflect.get(app.get(ReviewEligibility, { strict: false }), 'completions')).toBe(facade);
  });

  it('uses the Redis write-behind store by default (LEARNING_PROGRESS_STORE=redis)', () => {
    expect(app.get(LearningSettings, { strict: false }).progressStore).toBe('redis');
    expect(app.get(ProgressStore, { strict: false })).toBeInstanceOf(RedisProgressStore);
  });

  it('starts no ProgressFlushJob timer in test apps (LEARNING_JOBS_ENABLED=false)', () => {
    expect(app.get(LearningSettings, { strict: false }).jobsEnabled).toBe(false);
    expect(
      app
        .get(SchedulerRegistry, { strict: false })
        .doesExist('interval', PROGRESS_FLUSH_INTERVAL_NAME),
    ).toBe(false);
  });

  it('Express serves every P5-T10 operation of SECTION_8', () => {
    const served = new Set(expressRoutes(app.getHttpAdapter().getInstance()).map(op));
    const expected = SECTION_8_PHASE_5_LEARNING_A.map(op);
    expect(expected.filter((o) => !served.has(o))).toEqual([]);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('Express serves every P5-T11 operation of SECTION_8 (notes, quiz attempts, certificates)', () => {
    const served = new Set(expressRoutes(app.getHttpAdapter().getInstance()).map(op));
    const expected = SECTION_8_PHASE_5_LEARNING_B.map(op);
    expect(expected.filter((o) => !served.has(o))).toEqual([]);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('registers the note, quiz_attempt and certificate ownership resolvers (P5-T11)', () => {
    for (const resolver of [NoteOwnership, QuizAttemptOwnership, CertificateOwnership]) {
      expect(app.get(resolver, { strict: false })).toBeInstanceOf(resolver);
    }
  });
});
