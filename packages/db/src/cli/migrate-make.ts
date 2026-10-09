import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: pnpm --filter @udemy/db migrate:make <snake_case_name>');
  process.exit(1);
}

const dir = join(__dirname, '..', 'migrations');
const indexPath = join(dir, 'index.ts');
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const date = `${now.getUTCFullYear()}_${pad(now.getUTCMonth() + 1)}_${pad(now.getUTCDate())}`;
const index = readFileSync(indexPath, 'utf8');
const prefix = new RegExp(`"${date}_(\\d{4})_`, 'g');
const used = [...index.matchAll(prefix)].map((m) => Number(m[1]));
const seq = String((used.length ? Math.max(...used) : 0) + 1).padStart(4, '0');
const key = `${date}_${seq}_${name}`;
const file = join(dir, `${key}.ts`);
if (existsSync(file)) {
  console.error(`${file} already exists`);
  process.exit(1);
}

writeFileSync(
  file,
  `import { type Kysely, sql } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql\`SELECT 1\`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql\`SELECT 1\`.execute(db);
}
`,
);

const ident = `m${key}`;
writeFileSync(
  indexPath,
  index
    .replace(
      '// <migrate:make-imports>',
      `import * as ${ident} from "./${key}";\n// <migrate:make-imports>`,
    )
    .replace('// <migrate:make-entries>', `"${key}": ${ident},\n  // <migrate:make-entries>`),
);
console.log(`Created src/migrations/${key}.ts and registered it in index.ts`);
