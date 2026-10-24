import {
  createCommerceHandlers,
  createCommerceMockStore,
  createLearningHandlers,
  createLearningMockStore,
  type CommerceMockSeed,
  type LearningMockSeed,
  type LearningMockStore,
} from '@udemy/contracts/testing';
import type { SetupServer } from 'msw/node';

import { clock } from './commerce';
import { PROXY } from './msw';

/**
 * The Phase 5 api (learning, engagement, notifications, realtime tickets) on top of the Phase 4
 * commerce mocks, from `@udemy/contracts/testing`, behind the BFF proxy path the browser calls.
 * The store plays the workers synchronously (certificates on completion, ratings, notification
 * fan-out) and parses every response with its contracts schema.
 *
 * The clock is the fixed, movable `clock.now` of the commerce mocks: heartbeat plausibility
 * budgets are computed from it, never from the wall clock (no sleeps, no time bounds).
 */
export function mockLearning(
  server: SetupServer,
  seed: Omit<LearningMockSeed, 'commerce'> & { commerceSeed?: CommerceMockSeed } = {},
): LearningMockStore {
  const { commerceSeed, ...rest } = seed;
  const commerce = createCommerceMockStore({ now: () => clock.now, ...commerceSeed });
  const store = createLearningMockStore({ commerce, ...rest });
  server.use(
    ...createLearningHandlers({ baseUrl: PROXY, store }).handlers,
    ...createCommerceHandlers({ baseUrl: PROXY, store: commerce }).handlers,
  );
  return store;
}

/** Moves the mock clock forward (heartbeat budgets, rate windows, timestamps). */
export function advanceClock(ms: number): void {
  clock.now = new Date(clock.now.getTime() + ms);
}

/** Runs `fn` as another user/app of the mock (an instructor answering, posting, …). */
export function asViewer<T>(
  store: LearningMockStore,
  viewer: { userId: string; app: 'student' | 'instructor' | 'admin' },
  fn: () => T,
): T {
  const before = { userId: store.commerce.viewerId, app: store.viewerApp };
  store.commerce.viewerId = viewer.userId;
  store.viewerApp = viewer.app;
  try {
    return fn();
  } finally {
    store.commerce.viewerId = before.userId;
    store.viewerApp = before.app;
  }
}
