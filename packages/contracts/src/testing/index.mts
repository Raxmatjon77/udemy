/**
 * `@udemy/contracts/testing`: fixture builders and MSW handlers for the Phase 4 commerce &
 * enrollment contracts (design §10), so the web apps can build against mocks before the api
 * lands. ESM-only and test/dev code only: the main `@udemy/contracts` entry never imports it,
 * and `msw` is an optional peer dependency (only needed when you import this subpath).
 */
export * from './fixtures.mjs';
export type { CommerceHandlers, CommerceHandlersOptions } from './handlers.mjs';
export { createCommerceHandlers, problemResponse } from './handlers.mjs';
export type { CommerceMockSeed, MockCourse, MockUser } from './mock-store.mjs';
export {
  CommerceMockStore,
  createCommerceMockStore,
  defaultMockCourses,
  defaultMockUsers,
  MockApiError,
} from './mock-store.mjs';
