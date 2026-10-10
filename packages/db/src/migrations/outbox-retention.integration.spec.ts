import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { isCi, useIntegrationDb } from '../testing/it-db.mjs';

/**
 * Migration 0004b_outbox_retention. Locally a database without 0004b applied skips (the usual
 * "unmigrated" rule of the harness); with CI=true it fails.
 */
const pg = useIntegrationDb();

async function applied(): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM public.kysely_migration WHERE name = '2026_10_10_0004b_outbox_retention'
  `.execute(pg.db);
  return rows[0]!.n === 1;
}

describe('0004b outbox retention', () => {
  it('indexes processed_events.processed_at and publishes outbox INSERTs only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const isApplied = await applied();
    if (!isApplied && isCi())
      throw new Error('migration 2026_10_10_0004b_outbox_retention is not applied');
    ctx.skip(!isApplied, '2026_10_10_0004b_outbox_retention not applied (run migrate:latest)');

    const index = await sql<{ def: string }>`
      SELECT pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i
       WHERE i.indexrelid = to_regclass('outbox.processed_events_processed_at_idx')
    `.execute(pg.db);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]!.def).toContain('ON outbox.processed_events USING btree (processed_at)');

    const pub = await sql<{
      pubinsert: boolean;
      pubupdate: boolean;
      pubdelete: boolean;
      pubtruncate: boolean;
    }>`
      SELECT pubinsert, pubupdate, pubdelete, pubtruncate FROM pg_publication WHERE pubname = 'dbz_outbox'
    `.execute(pg.db);
    expect(pub.rows[0]).toEqual({
      pubinsert: true,
      pubupdate: false,
      pubdelete: false,
      pubtruncate: false,
    });
  });
});
