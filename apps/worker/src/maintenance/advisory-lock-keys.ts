/**
 * Single-bigint advisory-lock keys of the scheduled batch jobs: `0x75646d79` ('udmy') followed by
 * one byte per job (design phase 4 §"Batch jobs take pg_try_advisory_xact_lock(0x75646d79_NN)").
 * Every job takes `pg_try_advisory_xact_lock(key)` per batch transaction, so only one replica works
 * at a time. Keys must be unique across ALL processes that share the database (api included).
 *
 * | key            | owner                                       |
 * | -------------- | ------------------------------------------- |
 * | `0x75646d79_01` | worker: IdentityCleanupJob                 |
 * | `0x75646d79_02` | worker: MediaCleanupJob                    |
 * | `0x75646d79_03` | api: CommerceJobs refund dispatch (`REFUND_DISPATCH_LOCK_KEY` in @udemy/db) |
 * | `0x75646d79_04` | api: CommerceJobs reconcile (`COMMERCE_RECONCILE_LOCK_KEY` in @udemy/db) |
 * | `0x75646d79_05` | worker: LedgerReconciliationJob            |
 * | `0x75646d79_06` - `_0f` | reserved for further jobs                 |
 * | `0x75646d79_10` | worker: OutboxRetentionJob                 |
 *
 * The two-int advisory key space (`pg_advisory_xact_lock(int, int)`, e.g. the media quota lock
 * class `'mqta'` or the category tree `'catg'`) never collides with these bigint keys.
 */
export const ADVISORY_LOCK_KEYS = {
  identityCleanup: 0x75646d79_01,
  mediaCleanup: 0x75646d79_02,
  /** Owned by apps/api (CommerceJobs); listed so nobody reuses them here. */
  commerceRefundDispatch: 0x75646d79_03,
  commerceReconcile: 0x75646d79_04,
  ledgerReconciliation: 0x75646d79_05,
  outboxRetention: 0x75646d79_10,
} as const;
