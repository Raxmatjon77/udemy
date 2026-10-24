import type { Migration } from 'kysely/migration';
import * as m2026_10_09_0001_init from './2026_10_09_0001_init';
import * as m2026_10_10_0002_identity_access_users from './2026_10_10_0002_identity_access_users';
import * as m2026_10_10_0003_catalog_media from './2026_10_10_0003_catalog_media';
import * as m2026_10_10_0004_commerce_enrollment_payouts from './2026_10_10_0004_commerce_enrollment_payouts';
import * as m2026_10_10_0004b_outbox_retention from './2026_10_10_0004b_outbox_retention';
import * as m2026_10_24_0005_learning_engagement_notifications from './2026_10_24_0005_learning_engagement_notifications';
// <migrate:make-imports>

/**
 * Explicit import map instead of FileMigrationProvider: it works identically
 * from source (tsx) and from compiled dist/ (CommonJS), needs no fs scanning,
 * and gets bundled/typechecked. Keys are sorted by name = execution order.
 * `pnpm migrate:make <name>` appends to this file.
 */
export const migrations: Record<string, Migration> = {
  '2026_10_09_0001_init': m2026_10_09_0001_init,
  '2026_10_10_0002_identity_access_users': m2026_10_10_0002_identity_access_users,
  '2026_10_10_0003_catalog_media': m2026_10_10_0003_catalog_media,
  '2026_10_10_0004_commerce_enrollment_payouts': m2026_10_10_0004_commerce_enrollment_payouts,
  '2026_10_10_0004b_outbox_retention': m2026_10_10_0004b_outbox_retention,
  '2026_10_24_0005_learning_engagement_notifications':
    m2026_10_24_0005_learning_engagement_notifications,
  // <migrate:make-entries>
};
