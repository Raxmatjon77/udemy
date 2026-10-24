/**
 * `@udemy/contracts/testing`: fixture builders and MSW handlers for the Phase 4 commerce &
 * enrollment contracts (design §10) and the Phase 5 learning, engagement and notification
 * contracts (learning experience design §10), so the web apps can build against mocks before
 * the api lands. ESM-only and test/dev code only: the main `@udemy/contracts` entry never
 * imports it, and `msw` is an optional peer dependency (only needed when you import this subpath).
 */
export * from './fixtures.mjs';
export * from './learning-fixtures.mjs';
export type { CommerceHandlers, CommerceHandlersOptions } from './handlers.mjs';
export { createCommerceHandlers, problemResponse } from './handlers.mjs';
export type { LearningHandlers, LearningHandlersOptions } from './learning-handlers.mjs';
export { createLearningHandlers } from './learning-handlers.mjs';
export type {
  CommerceMockSeed,
  MockConsumptionFigures,
  MockConsumptionReader,
  MockCourse,
  MockCourseProgressReader,
  MockEnrollmentChange,
  MockRateLimitRule,
  MockUser,
} from './mock-store.mjs';
export {
  CommerceMockStore,
  createCommerceMockStore,
  defaultMockCourses,
  defaultMockUsers,
  MOCK_RATE_LIMITS,
  MockApiError,
  mockCourseConsumption,
} from './mock-store.mjs';
export type {
  LearningMockRateLimitName,
  LearningMockSeed,
  MockRealtimeEvent,
} from './learning-mock-store.mjs';
export {
  createLearningMockStore,
  LEARNING_MOCK_RATE_LIMITS,
  LearningMockStore,
} from './learning-mock-store.mjs';
