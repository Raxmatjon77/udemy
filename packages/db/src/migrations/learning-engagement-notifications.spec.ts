import {
  type CompiledQuery,
  type DatabaseConnection,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import * as m0003 from './2026_10_10_0003_catalog_media';
import * as m0005 from './2026_10_24_0005_learning_engagement_notifications';

/**
 * Static checks of migration 0005 without a database: every statement is compiled through a
 * recording driver and inspected as raw text (unlike testing/scripted-db, whitespace and `--`
 * comments are kept). The behaviour itself is covered by the integration specs
 * (src/{learning,engagement,notifications,catalog}/*.integration.spec.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function statementsOf(fn: (db: Kysely<any>) => Promise<void>): Promise<string[]> {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql.trim());
      return Promise.resolve({ rows: [] });
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: () => Promise.resolve(),
        acquireConnection: () => Promise.resolve(connection),
        beginTransaction: () => Promise.resolve(),
        commitTransaction: () => Promise.resolve(),
        rollbackTransaction: () => Promise.resolve(),
        releaseConnection: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
      }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  await fn(db);
  return statements;
}

/** Strips `--` comments line by line, then collapses whitespace. */
const norm = (text: string) =>
  text
    .replace(/--[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('migration 0005 (static)', () => {
  it('keeps every constraint, index and trigger name within 63 characters and unique', async () => {
    const up = (await statementsOf(m0005.up)).join('\n');
    const names = [
      ...up.matchAll(/CONSTRAINT\s+([a-z0-9_]+)\s+(?:PRIMARY|UNIQUE|FOREIGN|CHECK)/g),
      ...up.matchAll(/CREATE (?:UNIQUE )?INDEX\s+([a-z0-9_]+)/g),
      ...up.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+([a-z0-9_]+)/g),
    ].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(150);
    for (const name of names) expect({ name, ok: name.length <= 63 }).toEqual({ name, ok: true });
    const constraints = [
      ...up.matchAll(/CONSTRAINT\s+([a-z0-9_]+)\s+(?:PRIMARY|UNIQUE|FOREIGN|CHECK)/g),
    ].map((m) => m[1]!);
    // lectures_type_ck & co. are dropped and re-added with the same name; everything else is unique
    const readded = new Set([
      'lectures_type_ck',
      'lectures_type_media_asset_id_ck',
      'lectures_type_is_preview_ck',
      'revision_lectures_type_ck',
      'revision_lectures_media_asset_id_ck',
      'revision_lectures_is_preview_ck',
    ]);
    const dupes = constraints.filter((n, i) => constraints.indexOf(n) !== i && !readded.has(n));
    expect(dupes).toEqual([]);
  });

  it('generates the four report tables with the exact prefixes the error map relies on', async () => {
    const up = (await statementsOf(m0005.up)).join('\n');
    for (const [table, subject, arg] of [
      ['review_reports', 'reviews', 'REVIEW'],
      ['review_reply_reports', 'review_replies', 'REVIEW_REPLY'],
      ['question_reports', 'questions', 'QUESTION'],
      ['answer_reports', 'answers', 'ANSWER'],
    ] as const) {
      expect(up).toContain(`CREATE TABLE engagement.${table} (`);
      expect(up).toContain(
        `CONSTRAINT ${table}_subject_id_reporter_id_uq UNIQUE (subject_id, reporter_id)`,
      );
      expect(norm(up)).toContain(
        `CONSTRAINT ${table}_subject_id_fk FOREIGN KEY (subject_id) REFERENCES engagement.${subject} (id) ON DELETE RESTRICT`,
      );
      expect(up).toContain(`engagement.forbid_own_content('${arg}')`);
      expect(up).toContain(`public.forbid_row_change('${table}_transition_ck'`);
      expect(up).toContain(`CREATE INDEX ${table}_status_created_at_id_idx`);
    }
  });

  it('mirrors the contracts enums in the CHECKs (values copied from packages/contracts)', async () => {
    const up = norm((await statementsOf(m0005.up)).join('\n'));
    // notifications/notification-kinds.ts NOTIFICATION_KINDS / APPS / SUBJECT_TYPES / CATEGORIES / CHANNELS
    expect(up).toContain(
      "kind IN ('QA_NEW_QUESTION','QA_NEW_ANSWER','QA_RESOLVED','REVIEW_NEW','REVIEW_REPLY', 'ANNOUNCEMENT','CERTIFICATE_ISSUED','MEDIA_READY','MEDIA_FAILED', 'CONTENT_HIDDEN','MODERATION_QUEUE')",
    );
    expect(up).toContain("app IN ('STUDENT','INSTRUCTOR','ADMIN')");
    expect(up).toContain(
      "subject_type IN ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER','ANNOUNCEMENT','CERTIFICATE','MEDIA_ASSET')",
    );
    expect(up).toContain(
      "category IN ('QA','REVIEWS','ANNOUNCEMENTS','LEARNING','COURSE_BUILDING','MODERATION')",
    );
    expect(up).toContain("channel IN ('IN_APP','EMAIL')");
    // http/learning.ts LECTURE_COMPLETION_CAUSES, CERTIFICATE_TRANSITION_CAUSES, QUIZ_ATTEMPT_STATUSES
    expect(up).toContain(
      "cause IN ('VIDEO_WATCHED','ARTICLE_READ','RESOURCE_OPENED','QUIZ_PASSED','MANUAL')",
    );
    expect(up).toContain("status IN ('IN_PROGRESS','SUBMITTED','ABANDONED')");
    expect(up).toContain("cause IN ('ENROLLMENT_REVOKED','ADMIN')");
    expect(up).toContain("cause IN ('ENROLLMENT_REGRANTED','ADMIN')");
    // http/engagement-moderation.ts REPORT_REASONS, REPORT_STATUSES, MODERATION_ACTIONS (ANNOUNCEMENT excluded: open point 2)
    expect(up).toContain(
      "reason IN ('SPAM','ABUSE','HARASSMENT','OFF_TOPIC','INAPPROPRIATE','OTHER')",
    );
    expect(up).toContain("status IN ('OPEN','ACTIONED','DISMISSED')");
    expect(up).toContain("action IN ('HIDE','RESTORE','DISMISS_REPORTS')");
    expect(up).toContain("subject_type IN ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER'))");
    // http/quiz.ts QUIZ_QUESTION_KINDS
    expect(up).toContain("kind IN ('SINGLE_CHOICE','MULTIPLE_CHOICE')");
    // open point 1 + contracts multilineText: review/reply bodies and report comments allow line breaks
    expect(up).toContain(
      "body = btrim(body) AND translate(body, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'",
    );
    expect(up).toContain(
      "comment = btrim(comment) AND translate(comment, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'",
    );
  });

  it('down() restores the 0003 working_copy_guard body verbatim', async () => {
    const original = (await statementsOf(m0003.up)).find((s) =>
      s.startsWith('CREATE FUNCTION catalog.working_copy_guard()'),
    );
    const restored = (await statementsOf(m0005.down)).find((s) =>
      s.startsWith('CREATE OR REPLACE FUNCTION catalog.working_copy_guard()'),
    );
    expect(original).toBeDefined();
    expect(restored).toBeDefined();
    expect(flat(restored!.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION'))).toBe(
      flat(original!),
    );
    // and up() really replaced it with the quiz-aware body
    const replaced = (await statementsOf(m0005.up)).find((s) =>
      s.startsWith('CREATE OR REPLACE FUNCTION catalog.working_copy_guard()'),
    );
    expect(replaced).toContain("TG_TABLE_NAME = 'quiz_options'");
  });

  it('down() restores the six 0003 catalog CHECKs exactly as 0003 created them', async () => {
    const original = norm((await statementsOf(m0003.up)).join('\n'));
    const down = (await statementsOf(m0005.down)).join('\n');
    const restored = [...down.matchAll(/ADD CONSTRAINT ([a-z_]+_ck)\s+(CHECK \(.*\)),?\s*$/gm)].map(
      (m) => `CONSTRAINT ${m[1]} ${m[2]!.trim()}`,
    );
    expect(restored).toHaveLength(6);
    for (const c of restored) expect(original).toContain(norm(c));
  });

  it('down() drops every table, view and function up() creates (no CASCADE)', async () => {
    const up = (await statementsOf(m0005.up)).join('\n');
    const down = (await statementsOf(m0005.down)).join('\n');
    expect(down).not.toMatch(/CASCADE/);
    const tables = [...up.matchAll(/CREATE TABLE ([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]!);
    expect(tables).toHaveLength(32);
    for (const t of tables) expect(down).toContain(`DROP TABLE IF EXISTS ${t}`);
    expect(down).toContain('DROP VIEW IF EXISTS engagement.content_reports');
    const fns = [...up.matchAll(/CREATE FUNCTION ([a-z_]+\.[a-z_]+)\(/g)].map((m) => m[1]!);
    for (const f of fns) expect(down).toContain(`DROP FUNCTION IF EXISTS ${f}(`);
    // created through the V2 probe DO block (EXECUTE), not a top-level CREATE FUNCTION
    expect(down).toContain('DROP FUNCTION IF EXISTS learning.coverage_bits(varbit)');
    // the enrollment index swap is reversed
    expect(down).toContain('CREATE INDEX IF NOT EXISTS enrollments_course_id_active_idx');
    expect(down).toContain(
      'DROP INDEX IF EXISTS enrollment.enrollments_course_id_user_id_active_idx',
    );
  });

  it('never touches the outbox publication', async () => {
    const all = [...(await statementsOf(m0005.up)), ...(await statementsOf(m0005.down))].join('\n');
    expect(all).not.toMatch(/PUBLICATION/i);
  });
});
