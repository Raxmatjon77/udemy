import type { DB, Kysely } from '@udemy/db';

/**
 * Injection token for the shared `Kysely<DB>` instance.
 * `Symbol.for` (global registry) keeps the token identical even if this file is
 * ever loaded twice (e.g. once from dist and once from source in a test runner).
 */
export const DATABASE = Symbol.for('udemy.DATABASE');

/** Alias so constructors read `@InjectDatabase() private readonly db: Database`. */
export type Database = Kysely<DB>;

export const DATABASE_MODULE_OPTIONS = Symbol.for('udemy.DATABASE_MODULE_OPTIONS');
