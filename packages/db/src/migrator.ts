import type { Kysely } from 'kysely';
import { type MigrationResultSet, Migrator } from 'kysely/migration';
import { migrations } from './migrations';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    allowUnorderedMigrations: false,
  });
}

/** Applies all pending migrations. Throws if any migration fails. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error) throw result.error;
  return result;
}

/** Reverts the most recently applied migration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateDown(db: Kysely<any>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateDown();
  if (result.error) throw result.error;
  return result;
}
