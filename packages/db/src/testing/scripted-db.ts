import {
  CamelCasePlugin,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import type { DB } from '../generated/db';

/**
 * A Kysely<DB> (with the production CamelCasePlugin) over a fake driver: every query is
 * recorded, and results are taken in order from `results` (default: no rows). For unit tests of
 * the operational SQL's branching, without a database.
 */
export interface ScriptedDb {
  db: Kysely<DB>;
  /** Compiled SQL of every statement, including BEGIN/COMMIT/ROLLBACK. */
  statements: string[];
  /** Bound parameters, aligned with `statements`. */
  parameters: (readonly unknown[])[];
}

export type ScriptedResult = Partial<QueryResult<Record<string, unknown>>>;

export function scriptedDb(results: ScriptedResult[] = []): ScriptedDb {
  const statements: string[] = [];
  const parameters: (readonly unknown[])[] = [];
  const queue = [...results];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql.replace(/\s+/g, ' ').trim());
      parameters.push(query.parameters);
      const next = queue.shift() ?? {};
      return Promise.resolve({ rows: [], ...next } as QueryResult<R>);
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const record = (s: string) => {
    statements.push(s);
    parameters.push([]);
    return Promise.resolve();
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => record('BEGIN'),
    commitTransaction: () => record('COMMIT'),
    rollbackTransaction: () => record('ROLLBACK'),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
  return { db, statements, parameters };
}
