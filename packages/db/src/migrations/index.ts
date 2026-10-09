import type { Migration } from 'kysely/migration';
import * as m2026_10_09_0001_init from './2026_10_09_0001_init';
// <migrate:make-imports>

/**
 * Explicit import map instead of FileMigrationProvider: it works identically
 * from source (tsx) and from compiled dist/ (CommonJS), needs no fs scanning,
 * and gets bundled/typechecked. Keys are sorted by name = execution order.
 * `pnpm migrate:make <name>` appends to this file.
 */
export const migrations: Record<string, Migration> = {
  '2026_10_09_0001_init': m2026_10_09_0001_init,
  // <migrate:make-entries>
};
