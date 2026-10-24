import {
  createCommerceMockStore,
  createLearningHandlers,
  createLearningMockStore,
  FIXTURE_IDS,
  type LearningMockSeed,
  type LearningMockStore,
} from '@udemy/contracts/testing';

import { server } from './msw';

/**
 * The `@udemy/contracts/testing` Phase 5 mock (Q&A, reviews, announcements, quiz authoring,
 * notifications) behind `/api/proxy/*`, with the default instructor (`FIXTURE_IDS.instructor`,
 * owner of "Complete TypeScript" and "PostgreSQL in Depth") as the viewer on an instructor-app
 * token. Every response is parsed with its contracts schema before it is sent.
 */

export const PROXY_BASE = '*/api/proxy';
export const INSTRUCTOR = FIXTURE_IDS.instructor;
export const STUDENT = FIXTURE_IDS.student;
export const COURSE = FIXTURE_IDS.course;

export function installLearning(seed: Omit<LearningMockSeed, 'commerce'> = {}): LearningMockStore {
  const commerce = createCommerceMockStore({ viewerId: INSTRUCTOR });
  const store = createLearningMockStore({ viewerApp: 'instructor', ...seed, commerce });
  server.use(...createLearningHandlers({ baseUrl: PROXY_BASE, store }).handlers);
  return store;
}

/** Runs `act` as `userId` on a student-app token (asking, answering, reviewing), then switches back. */
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

/** The student holds an ACTIVE enrollment in `courseId` (bought it). */
export function enrollStudent(
  store: LearningMockStore,
  courseId: string = COURSE,
  userId: string = STUDENT,
): void {
  store.commerce.seedPaidOrder(userId, [courseId]);
}
