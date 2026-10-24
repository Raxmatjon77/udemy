import {
  createCommerceMockStore,
  createLearningHandlers,
  createLearningMockStore,
  defaultMockUsers,
  FIXTURE_IDS,
  type LearningMockSeed,
  type LearningMockStore,
} from '@udemy/contracts/testing';

import { PROXY_BASE, server } from './msw';

/**
 * The `@udemy/contracts/testing` Phase 5 mock (moderation, certificates, revision quizzes,
 * notifications) behind `/api/proxy/*`, with the signed-in admin (`FIXTURE_IDS.admin`) as the
 * viewer on an admin-app token. Every response is parsed with its contracts schema first.
 */

export const ADMIN = FIXTURE_IDS.admin;
export const STUDENT = FIXTURE_IDS.student;
export const COURSE = FIXTURE_IDS.course;

/** Extra students who report content (three distinct reporters reach the auto-hide threshold). */
export const REPORTERS = [
  { id: '0b1f6d1e-0000-4000-8000-00000000aa01', displayName: 'Rita Reporter', email: 'r1@x.test' },
  { id: '0b1f6d1e-0000-4000-8000-00000000aa02', displayName: 'Rob Reporter', email: 'r2@x.test' },
  { id: '0b1f6d1e-0000-4000-8000-00000000aa03', displayName: 'Ray Reporter', email: 'r3@x.test' },
] as const;

export function installLearning(seed: Omit<LearningMockSeed, 'commerce'> = {}): LearningMockStore {
  const commerce = createCommerceMockStore({
    viewerId: ADMIN,
    users: [...defaultMockUsers(), ...REPORTERS],
  });
  const store = createLearningMockStore({ viewerApp: 'admin', ...seed, commerce });
  server.use(...createLearningHandlers({ baseUrl: PROXY_BASE, store }).handlers);
  return store;
}

/** Runs `act` as `userId` on a student-app token, then switches back to the admin. */
export function asStudent<T>(store: LearningMockStore, act: () => T, userId: string = STUDENT): T {
  const viewer = store.commerce.viewerId;
  const app = store.viewerApp;
  store.commerce.viewerId = userId;
  store.viewerApp = 'student';
  try {
    return act();
  } finally {
    store.commerce.viewerId = viewer;
    store.viewerApp = app;
  }
}

/** A published review by the student, reported by `reporters` of `REPORTERS` (3 auto-hide it). */
export function seedReportedReview(
  store: LearningMockStore,
  reporters = 1,
  body = 'Terrible course, buy mine instead at spam.example',
): string {
  const reviewId = store.seedReview(STUDENT, COURSE, 1, body);
  for (const reporter of REPORTERS.slice(0, reporters)) {
    store.seedReport('REVIEW', reviewId, reporter.id, 'SPAM');
  }
  return reviewId;
}

/** The student completed every lecture of `COURSE`: an ACTIVE certificate is issued. */
export function seedCertificate(store: LearningMockStore): void {
  store.commerce.seedEnrollment(STUDENT, COURSE);
  store.seedCompletion(STUDENT, COURSE);
}
