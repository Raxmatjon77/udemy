// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE } from '@udemy/nest-common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import { LECTURE_COMPLETIONS, type LectureCompletionCounter } from '../../shared/learning-progress';
import { REDIS } from '../../shared/redis';
import type { HttpMethod } from '../../testing/e2e/e2e-harness';
import {
  type Operation,
  SECTION_8_PHASE_5_ENGAGEMENT_A,
  SECTION_8_PHASE_5_ENGAGEMENT_B,
} from '../../testing/e2e/section-8';
import { LearningFacade } from '../learning';
import { EngagementSettings } from './application/engagement-settings';
import { QaHints } from './application/ports/qa-hints';
import {
  REPORT_SUBJECT_HANDLERS,
  type ReportSubjectHandler,
} from './application/report-subjects/report-subject.handler';
import { ReviewEligibility } from './application/review-eligibility';
import { RealtimeQaHints } from './infrastructure/realtime-qa-hints';

/*
 * The engagement provider graph through the REAL AppModule (no Postgres/Redis: fake clients):
 * it compiles and boots (the RouteSecurityAuditor runs at bootstrap and fails boot on a route
 * without a security marker or a `@CheckPolicy` without a resolver), the global
 * LECTURE_COMPLETIONS port is bound to learning's LearningFacade (P5-T10), the report handlers are
 * registered, and Express serves exactly the P5-T12 operations of SECTION_8.
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

describe('engagement provider graph (real AppModule)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
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

  it("binds LECTURE_COMPLETIONS to learning's LearningFacade (P5-T10)", async () => {
    const bound = app.get<LectureCompletionCounter>(LECTURE_COMPLETIONS, { strict: false });
    expect(bound).toBe(app.get(LearningFacade, { strict: false }));
    // malformed ids never reach SQL
    await expect(bound.completedLectureCount('u', 'c')).resolves.toBe(0);
    expect(Reflect.get(app.get(ReviewEligibility, { strict: false }), 'completions')).toBe(bound);
  });

  it('registers a report handler for every report subject type', () => {
    const handlers = app.get<readonly ReportSubjectHandler[]>(REPORT_SUBJECT_HANDLERS, {
      strict: false,
    });
    expect(handlers.map((h) => h.type).sort()).toEqual([
      'ANSWER',
      'QUESTION',
      'REVIEW',
      'REVIEW_REPLY',
    ]);
  });

  it('binds the Q&A hints to the shared RealtimeEmitter adapter', () => {
    expect(app.get(QaHints, { strict: false })).toBeInstanceOf(RealtimeQaHints);
  });

  it('reads ENGAGEMENT_AUTO_HIDE_REPORTS (default 3)', () => {
    expect(app.get(EngagementSettings, { strict: false }).autoHideReports).toBe(3);
  });

  it('Express serves every P5-T12 and P5-T13 operation of SECTION_8', () => {
    const served = new Set(expressRoutes(app.getHttpAdapter().getInstance()).map(op));
    const expected = [...SECTION_8_PHASE_5_ENGAGEMENT_A, ...SECTION_8_PHASE_5_ENGAGEMENT_B].map(op);
    expect(expected.filter((o) => !served.has(o))).toEqual([]);
    expect(new Set(expected).size).toBe(expected.length);
  });
});
