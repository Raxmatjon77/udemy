/**
 * `@udemy/db/testing`: test-only helpers. ESM-only (the harness imports vitest, which cannot be
 * required); never import it from application code (the main `@udemy/db` entry does not
 * include it).
 *
 * - `useIntegrationDb` & co.: the real-Postgres integration convention (IT_DATABASE_URL, skip
 *   locally / fail with CI=true, rollback-per-test, `deleteTestData` needs a superuser).
 * - `scriptedDb`: a Kysely<DB> over a fake driver for unit tests of SQL branching.
 * - fixtures: raw-SQL row builders for catalog/media (they bypass the domain rules on purpose),
 *   commerce-fixtures for commerce/enrollment/payouts and phase5-fixtures for learning /
 *   engagement / catalog QUIZ (legal shapes; break one invariant per test).
 * - `skipUnlessMigrated`: gate tests on a migration newer than the 0004 probe (skip locally, fail in CI).
 */
export type { IntegrationDb, PgErrorShape, SkippableContext } from './it-db.mjs';
export {
  backendPid,
  checkDeferredNow,
  deferredFailure,
  deferredOk,
  deleteTestData,
  expectFailure,
  IT_DEFAULT_DATABASE_URL,
  isCi,
  itDatabaseUrl,
  PHASE5_MIGRATION,
  PROBE_TIMEOUT_MS,
  rollback,
  signal,
  skipUnlessMigrated,
  useIntegrationDb,
  waitUntilBlocked,
} from './it-db.mjs';
export type { ScriptedDb, ScriptedResult } from './scripted-db.js';
export { scriptedDb } from './scripted-db.js';
export type {
  AssetPurpose,
  AssetStage,
  DraftCourse,
  RevisionShape,
  TransitionInput,
} from './fixtures.js';
export type { CouponOptions, OrderLineSpec, RefundSpec, TestOrder } from './commerce-fixtures.js';
export {
  createCoupon,
  createOrder,
  createRefund,
  fromCents,
  openPayment,
  payOrder,
  setCoursePrice,
  testEventId,
  toCents,
  uniqueCode,
} from './commerce-fixtures.js';
export {
  approve,
  assetRow,
  createAsset,
  createCategoryPair,
  createDraftCourse,
  createUser,
  insertRevision,
  insertTransition,
  jobRow,
  PART_SIZE,
  submit,
  uniqueSuffix,
} from './fixtures.js';
export type { QuizQuestionSpec } from './phase5-fixtures.js';
export {
  certificateCode,
  createActiveEnrollment,
  createAnswer,
  createCourseCompletion,
  createQuestion,
  createReviewRow,
  insertQuizRevisionLecture,
  startQuizAttempt,
  submitQuizAttempt,
} from './phase5-fixtures.js';
