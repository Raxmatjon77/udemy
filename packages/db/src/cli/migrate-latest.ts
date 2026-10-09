import { migrateToLatest } from '../migrator';
import { runCli } from './run';

void runCli(async (db) => {
  const { results } = await migrateToLatest(db);
  for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName}`);
  if (!results?.length) console.log('Already up to date');
});
