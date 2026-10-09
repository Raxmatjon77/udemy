import type { DB } from '@udemy/db';
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

/**
 * In-memory stand-in for Postgres, good enough for idempotency tests:
 * real Kysely (same plugins and SQL compiler as production) on top of a fake driver
 * that emulates `INSERT INTO outbox.processed_events ... ON CONFLICT DO NOTHING RETURNING`
 * with transactional visibility (rows become visible on COMMIT, vanish on ROLLBACK).
 */
export class FakeDatabaseState {
  readonly processed = new Set<string>();
  readonly executedSql: string[] = [];
  commits = 0;
  rollbacks = 0;
}

const PROCESSED_EVENTS_INSERT = /^insert into "outbox"\."processed_events"/i;

class FakeConnection implements DatabaseConnection {
  readonly pending = new Set<string>();

  constructor(private readonly state: FakeDatabaseState) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.state.executedSql.push(query.sql);
    if (!PROCESSED_EVENTS_INSERT.test(query.sql)) {
      return { rows: [] };
    }
    const [consumer, eventId] = query.parameters.map(String);
    const key = `${consumer}|${eventId}`;
    if (this.state.processed.has(key) || this.pending.has(key)) {
      return { rows: [], numAffectedRows: 0n }; // conflict -> DO NOTHING -> no row returned
    }
    this.pending.add(key);
    return { rows: [{ event_id: eventId } as R], numAffectedRows: 1n };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not supported by the fake database');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly state: FakeDatabaseState) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new FakeConnection(this.state);
  }

  async beginTransaction(): Promise<void> {}

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as FakeConnection;
    for (const key of conn.pending) this.state.processed.add(key);
    conn.pending.clear();
    this.state.commits++;
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    (connection as FakeConnection).pending.clear();
    this.state.rollbacks++;
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

export function createFakeDatabase(): { db: Kysely<DB>; state: FakeDatabaseState } {
  const state = new FakeDatabaseState();
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(state),
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
  return { db, state };
}
