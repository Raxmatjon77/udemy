/**
 * `@udemy/db/testing`: test-only helpers. ESM-only (the harness imports vitest, which cannot be
 * required); never import it from application code (the main `@udemy/db` entry does not
 * include it).
 *
 * - `useIntegrationDb` & co.: the real-Postgres integration convention (IT_DATABASE_URL, skip
 *   locally / fail with CI=true, rollback-per-test, `deleteTestData` needs a superuser).
 * - `scriptedDb`: a Kysely<DB> over a fake driver for unit tests of SQL branching.
 * - fixtures: raw-SQL row builders for catalog/media (they bypass the domain rules on purpose),
 *   and commerce-fixtures for commerce/enrollment/payouts (legal shapes; break one invariant per test).
 */
export type { IntegrationDb, PgErrorShape, SkippableContext } from './it-db.mjs';
export {
  backendPid,
  checkDeferredNow,
  deleteTestData,
  expectFailure,
  IT_DEFAULT_DATABASE_URL,
  isCi,
  itDatabaseUrl,
  PROBE_TIMEOUT_MS,
  rollback,
  signal,
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
