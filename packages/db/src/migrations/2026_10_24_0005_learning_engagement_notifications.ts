import { type Kysely, type RawBuilder, sql } from 'kysely';

/**
 * Phase 5: learning / engagement / notifications, plus the catalog QUIZ lecture type (tables
 * only; the three schemas come from 0001).
 *
 * Source of truth: docs/phase-5-schema-design.md §1 (DDL, in its order), §4 (privileges) and its
 * "Open points: resolved" section. One `sql` per statement; raw SQL throughout (varbit, STORED
 * generated columns, partial uniques, deferred constraint triggers, PL/pgSQL).
 *
 * PG 18 behaviour (schema doc §0). Written in code-only mode (no database available), so the
 * migration does not trust anything it could not prove:
 * - V3/V4 (text -> varbit incl. hex input, `substring`/`||` on varbit, `length` = bits): asserted
 *   by the probe DO block at the top. If any differs, the migration aborts with a message naming
 *   the claim, before a single object is created (Kysely runs a migration in one transaction).
 * - V2 (`bit_count(varbit)`): `learning.coverage_bits(varbit)` is created with `bit_count` when it
 *   resolves and with the `length(replace(bits::text, '0', ''))` fallback otherwise, so the call
 *   sites never change. src/learning/pg18-behaviours.integration.spec.ts records which one won.
 * - V1/V5 (OR of unequal lengths, CASE short-circuit): never relied upon. The flush upsert ORs
 *   `p.coverage | learning.fit_coverage(EXCLUDED.coverage, length(p.coverage))`, which cannot see
 *   unequal lengths even if PG evaluated the branch eagerly (src/learning/progress.ts).
 * - V6 (`pg_trigger_depth()`), V7 (partial-index arbiter), V8 (`RETURNING old.*`), V9, V10:
 *   asserted by the pg18-behaviours integration spec on the first stack run.
 *
 * Deviations from §1 (names unchanged except the one added constraint; see the P5-T4 report):
 * - `learning.fit_coverage`: `substring(...)::varbit` (substring on bit strings is declared on
 *   `bit`), and `greatest(p_len, 0)` so a bad length raises the coverage CHECK, not 22011.
 * - Added `learning.coverage_bits(varbit)` (the V2 wrapper the doc names as the fallback).
 * - Open point 1: review and reply bodies allow line breaks (tab/LF/CR), still trimmed.
 * - Contract alignment: report comments are `multilineText(1, 500)` in the contracts, so they also
 *   allow line breaks.
 * - Contract alignment: notifications are redacted the contracts' way (`redactNotificationPayload`:
 *   texts -> null, `redacted: true`), not to `{}`. notifications_redacted_ck now says
 *   `redacted_at IS NOT NULL` <=> `payload @> {"redacted": true}`, and a redaction needs a subject.
 * - Contract alignment: added notifications_kind_subject_ck (`NOTIFICATION_KIND_META.subjectType`).
 *
 * Reuses public.set_updated_at() (0001), public.forbid_append_only_mutation() (0002),
 * public.forbid_row_change() (0003). REPLACES catalog.working_copy_guard() (0003) so it also
 * covers the quiz tables; down() restores the 0003 body verbatim (a unit spec compares them).
 *
 * Every learning / engagement / notifications transaction runs at READ COMMITTED: the answer
 * trigger, rating recompute, auto-hide count, announcement quota and course-completion check all
 * lock first and read in a new statement.
 *
 * Outbox: unchanged. `dbz_outbox` still publishes only `outbox.events`, insert-only (0004b).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(db: Kysely<any>, statements: RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) {
    await statement.execute(db);
  }
}

// Markdown / multi-line text: no control characters except tab, LF, CR (as 0003/0004).
const noCtrlExceptBreaks = (column: string) =>
  `translate(${column}, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'`;

// ---------------------------------------------------------------------------
// 0. PG 18 probes (V3/V4) and the learning coverage helpers
// ---------------------------------------------------------------------------
const probesAndHelpers = [
  sql`
    DO $$
    BEGIN
      -- V3: text -> varbit, binary and hex input; zero padding via repeat()
      IF length('0101'::text::varbit) <> 4 OR '0101'::text::varbit <> B'0101' THEN
        RAISE EXCEPTION '0005 probe V3 failed: binary text -> varbit';
      END IF;
      IF ('x' || 'a0ff')::varbit <> B'1010000011111111' OR length(('x' || 'a0ff')::varbit) <> 16 THEN
        RAISE EXCEPTION '0005 probe V3 failed: hex text -> varbit (x prefix)';
      END IF;
      IF length(repeat('0', 3)::varbit) <> 3 THEN
        RAISE EXCEPTION '0005 probe V3 failed: repeat(''0'', k)::varbit';
      END IF;
      -- V4: substring and || keep bit semantics; length() counts bits
      IF substring(B'10110'::varbit FROM 1 FOR 3)::varbit <> B'101'
         OR (B'1'::varbit || repeat('0', 2)::varbit) <> B'100'
         OR length(B'1011010110'::varbit) <> 10 THEN
        RAISE EXCEPTION '0005 probe V4 failed: substring / || / length on varbit';
      END IF;
    END
    $$
  `,
  sql`
    CREATE FUNCTION learning.fit_coverage(p_bits varbit, p_len integer)
    RETURNS varbit
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN CASE
             WHEN length(p_bits) >= p_len THEN substring(p_bits FROM 1 FOR greatest(p_len, 0))::varbit   -- truncate extra trailing bits
             ELSE p_bits || repeat('0', p_len - length(p_bits))::varbit                                     -- right-pad (Redis SETBIT only grows to the highest set bit)
           END
  `,
  sql`
    COMMENT ON FUNCTION learning.fit_coverage(varbit, integer) IS
      'Returns p_bits truncated or right-padded with zeros to exactly p_len bits. Bit i (0-based, left to right) = 5 s bucket i = Redis SETBIT offset i. Used on every coverage write so lecture_progress_coverage_ck and the OR in the flush upsert can never see unequal lengths (V1/V4).'
  `,
  // V2: bit_count(varbit) when it resolves, else the text fallback. Same signature either way.
  sql`
    DO $$
    DECLARE
      v_native boolean;
    BEGIN
      BEGIN
        PERFORM bit_count(B'1011'::varbit);
        v_native := true;
      EXCEPTION WHEN undefined_function THEN
        v_native := false;
      END;
      IF v_native THEN
        EXECUTE $f$
          CREATE FUNCTION learning.coverage_bits(p_bits varbit) RETURNS integer
          LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
          RETURN bit_count(p_bits)::integer
        $f$;
      ELSE
        EXECUTE $f$
          CREATE FUNCTION learning.coverage_bits(p_bits varbit) RETURNS integer
          LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
          RETURN length(replace(p_bits::text, '0', ''))
        $f$;
      END IF;
      IF learning.coverage_bits(B'1011000001'::varbit) <> 4 THEN
        RAISE EXCEPTION '0005 probe V2 failed: learning.coverage_bits(B''1011000001'') <> 4';
      END IF;
    END
    $$
  `,
  sql`
    COMMENT ON FUNCTION learning.coverage_bits(varbit) IS
      'Number of set bits (= watched 5 s buckets). bit_count(varbit) on PG 18; the migration falls back to a text count if bit_count is missing (schema doc §0 V2). Watched seconds = least(coverage_bits * 5, duration_seconds).'
  `,
];

// ---------------------------------------------------------------------------
// 1. catalog: QUIZ lecture type (D6)
// ---------------------------------------------------------------------------
const catalogQuizType = [
  // 1a. working-copy lectures: QUIZ has no media and is never a preview
  sql`
    ALTER TABLE catalog.lectures
      DROP CONSTRAINT lectures_type_ck,
      DROP CONSTRAINT lectures_type_media_asset_id_ck,
      DROP CONSTRAINT lectures_type_is_preview_ck,
      ADD CONSTRAINT lectures_type_ck                CHECK (type IN ('VIDEO','ARTICLE','RESOURCE','QUIZ')),
      ADD CONSTRAINT lectures_type_media_asset_id_ck CHECK (type NOT IN ('ARTICLE','QUIZ') OR media_asset_id IS NULL),
      ADD CONSTRAINT lectures_type_is_preview_ck     CHECK (NOT is_preview OR type IN ('VIDEO','ARTICLE'))
  `,
  // 1b. revision snapshot: QUIZ carries its pass mark; composite FK target for quiz questions
  sql`
    ALTER TABLE catalog.revision_lectures
      ADD COLUMN quiz_pass_pct smallint NULL,
      DROP CONSTRAINT revision_lectures_type_ck,
      DROP CONSTRAINT revision_lectures_media_asset_id_ck,
      DROP CONSTRAINT revision_lectures_is_preview_ck,
      ADD CONSTRAINT revision_lectures_type_ck           CHECK (type IN ('VIDEO','ARTICLE','RESOURCE','QUIZ')),
      ADD CONSTRAINT revision_lectures_media_asset_id_ck CHECK ((type IN ('ARTICLE','QUIZ')) = (media_asset_id IS NULL)),
      ADD CONSTRAINT revision_lectures_is_preview_ck     CHECK (NOT is_preview OR type IN ('VIDEO','ARTICLE')),
      ADD CONSTRAINT revision_lectures_quiz_pass_pct_ck  CHECK ((type = 'QUIZ') = (quiz_pass_pct IS NOT NULL)
                                                               AND (quiz_pass_pct IS NULL OR quiz_pass_pct BETWEEN 1 AND 100)),
      ADD CONSTRAINT revision_lectures_revision_id_lecture_id_type_uq UNIQUE (revision_id, lecture_id, type)
  `,
  sql`COMMENT ON COLUMN catalog.revision_lectures.quiz_pass_pct IS 'QUIZ only: snapshot of lecture_quizzes.pass_pct at submit. Learning copies it into quiz_attempts.pass_pct at START.'`,
  // 1c. lecture_quizzes: 1:1 settings of a QUIZ lecture (lecture_articles pattern)
  sql`
    CREATE TABLE catalog.lecture_quizzes (
      lecture_id   uuid        NOT NULL,
      lecture_type text        NOT NULL DEFAULT 'QUIZ',      -- FK helper only
      pass_pct     smallint    NOT NULL DEFAULT 70,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT lecture_quizzes_pk                         PRIMARY KEY (lecture_id),
      CONSTRAINT lecture_quizzes_lecture_id_lecture_type_fk FOREIGN KEY (lecture_id, lecture_type)
                                                            REFERENCES catalog.lectures (id, type) ON DELETE CASCADE,
      CONSTRAINT lecture_quizzes_lecture_type_ck            CHECK (lecture_type = 'QUIZ'),
      CONSTRAINT lecture_quizzes_pass_pct_ck                CHECK (pass_pct BETWEEN 1 AND 100)
    )
  `,
  sql`
    CREATE TRIGGER lecture_quizzes_set_updated_at_trg BEFORE UPDATE ON catalog.lecture_quizzes
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    COMMENT ON TABLE catalog.lecture_quizzes IS
      'Quiz settings of a QUIZ lecture (1:1, required: lecture_quizzes_required_ck at COMMIT). Composite FK to lectures(id, type) with lecture_type pinned to QUIZ. Cascades with the lecture.'
  `,
  // Every QUIZ lecture has exactly one settings row (checked at COMMIT: AddLecture inserts both)
  sql`
    CREATE FUNCTION catalog.lecture_quiz_settings_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_id uuid;
    BEGIN
      IF TG_TABLE_NAME = 'lectures' THEN v_id := NEW.id; ELSE v_id := OLD.lecture_id; END IF;
      IF EXISTS (SELECT 1 FROM catalog.lectures l WHERE l.id = v_id AND l.type = 'QUIZ')
         AND NOT EXISTS (SELECT 1 FROM catalog.lecture_quizzes q WHERE q.lecture_id = v_id) THEN
        RAISE EXCEPTION 'QUIZ lecture % has no lecture_quizzes row', v_id
          USING ERRCODE = '23514', CONSTRAINT = 'lecture_quizzes_required_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER lectures_quiz_settings_trg AFTER INSERT ON catalog.lectures
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'QUIZ')
      EXECUTE FUNCTION catalog.lecture_quiz_settings_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER lecture_quizzes_required_trg AFTER DELETE ON catalog.lecture_quizzes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION catalog.lecture_quiz_settings_guard()
  `,
  // 1d. quiz_questions (working copy)
  sql`
    CREATE TABLE catalog.quiz_questions (
      id             uuid        NOT NULL DEFAULT uuidv7(),
      lecture_id     uuid        NOT NULL,
      position       smallint    NOT NULL,
      kind           text        NOT NULL,
      prompt_md      text        NOT NULL,
      explanation_md text        NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT quiz_questions_pk                     PRIMARY KEY (id),
      -- reorder permutes in one tx (P2 D3); also the lecture_id FK / cascade index
      CONSTRAINT quiz_questions_lecture_id_position_uq UNIQUE (lecture_id, position) DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT quiz_questions_lecture_id_fk          FOREIGN KEY (lecture_id) REFERENCES catalog.lecture_quizzes (lecture_id) ON DELETE CASCADE,
      CONSTRAINT quiz_questions_position_ck            CHECK (position BETWEEN 0 AND 49),        -- contiguous => <= 50 questions (quiz_limit_exceeded backstop)
      CONSTRAINT quiz_questions_kind_ck                CHECK (kind IN ('SINGLE_CHOICE','MULTIPLE_CHOICE')),
      CONSTRAINT quiz_questions_prompt_md_ck           CHECK (char_length(prompt_md) BETWEEN 1 AND 2000
                                                              AND ${sql.raw(noCtrlExceptBreaks('prompt_md'))}),
      CONSTRAINT quiz_questions_explanation_md_ck      CHECK (explanation_md IS NULL OR (char_length(explanation_md) BETWEEN 1 AND 2000
                                                              AND ${sql.raw(noCtrlExceptBreaks('explanation_md'))}))
    )
  `,
  sql`
    CREATE TRIGGER quiz_questions_set_updated_at_trg BEFORE UPDATE ON catalog.quiz_questions
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER quiz_questions_immutable_trg BEFORE UPDATE ON catalog.quiz_questions
      FOR EACH ROW WHEN (OLD.lecture_id IS DISTINCT FROM NEW.lecture_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
      EXECUTE FUNCTION public.forbid_row_change('quiz_questions_immutable_ck', 'quiz_questions.lecture_id/created_at are immutable')
  `,
  sql`COMMENT ON TABLE catalog.quiz_questions IS 'Working-copy quiz questions (<= 50, positions contiguous). May be incomplete; readiness (QUIZ_EMPTY, QUIZ_QUESTION_INVALID) validates. Snapshotted into revision_quiz_questions at submit.'`,
  // 1e. quiz_options (working copy; replaced wholesale by PutQuizQuestionOptions)
  sql`
    CREATE TABLE catalog.quiz_options (
      question_id uuid     NOT NULL,
      position    smallint NOT NULL,
      text        text     NOT NULL,
      is_correct  boolean  NOT NULL DEFAULT false,
      CONSTRAINT quiz_options_pk             PRIMARY KEY (question_id, position),
      CONSTRAINT quiz_options_question_id_fk FOREIGN KEY (question_id) REFERENCES catalog.quiz_questions (id) ON DELETE CASCADE,
      CONSTRAINT quiz_options_position_ck    CHECK (position BETWEEN 0 AND 5),                    -- <= 6 options
      CONSTRAINT quiz_options_text_ck        CHECK (char_length(text) BETWEEN 1 AND 300 AND text = btrim(text) AND text !~ '[[:cntrl:]]')
    )
  `,
  sql`COMMENT ON TABLE catalog.quiz_options IS 'Working-copy options of a question (0..6; readiness requires 2..6 and the correct-count rule). DELETE + INSERT on every edit; no own timestamps (quiz_questions.updated_at / courses.version cover them), as course_bullets.'`,
  // 1f. review lock now also covers the quiz tables (replaces the 0003 body; down() restores it)
  sql`
    CREATE OR REPLACE FUNCTION catalog.working_copy_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_row       record;
      v_course_id uuid;
      v_pending   uuid;
      v_status    text;
      v_deleted   timestamptz;
    BEGIN
      IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

      IF TG_TABLE_NAME IN ('lecture_articles','lecture_quizzes','quiz_questions') THEN
        SELECT l.course_id INTO v_course_id FROM catalog.lectures l WHERE l.id = v_row.lecture_id;
      ELSIF TG_TABLE_NAME = 'quiz_options' THEN
        SELECT l.course_id INTO v_course_id
          FROM catalog.quiz_questions q JOIN catalog.lectures l ON l.id = q.lecture_id
         WHERE q.id = v_row.question_id;
      ELSE
        v_course_id := v_row.course_id;      -- course_bullets, sections, lectures
      END IF;

      IF v_course_id IS NOT NULL THEN   -- NULL: cascade after the parent was deleted (already checked there)
        SELECT c.pending_revision_id, c.status, c.deleted_at INTO v_pending, v_status, v_deleted
          FROM catalog.courses c WHERE c.id = v_course_id FOR SHARE;
        IF v_pending IS NOT NULL OR v_status = 'ARCHIVED' OR v_deleted IS NOT NULL THEN
          RAISE EXCEPTION 'course % working copy is locked (in review, archived or deleted)', v_course_id
            USING ERRCODE = '23514', CONSTRAINT = 'courses_working_copy_locked_ck',
                  SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
        END IF;
      END IF;

      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    COMMENT ON FUNCTION catalog.working_copy_guard() IS
      'BEFORE row trigger on course_bullets/sections/lectures/lecture_articles and (0005) lecture_quizzes/quiz_questions/quiz_options: rejects writes while the course has a pending revision, is ARCHIVED or soft-deleted (courses_working_copy_locked_ck). Backstop for invariant 1; the app still checks first to return course_in_review vs course_not_editable.'
  `,
  sql`
    CREATE TRIGGER lecture_quizzes_working_copy_trg BEFORE INSERT OR UPDATE OR DELETE ON catalog.lecture_quizzes
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  sql`
    CREATE TRIGGER quiz_questions_working_copy_trg  BEFORE INSERT OR UPDATE OR DELETE ON catalog.quiz_questions
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  sql`
    CREATE TRIGGER quiz_options_working_copy_trg    BEFORE INSERT OR UPDATE OR DELETE ON catalog.quiz_options
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  // 1g. immutable revision snapshot of the quiz content (the answer key)
  sql`
    CREATE TABLE catalog.revision_quiz_questions (
      revision_id    uuid     NOT NULL,
      lecture_id     uuid     NOT NULL,
      lecture_type   text     NOT NULL DEFAULT 'QUIZ',   -- FK helper only
      question_id    uuid     NOT NULL,                  -- stable working id (no FK; working question may be deleted later)
      position       smallint NOT NULL,
      kind           text     NOT NULL,
      prompt_md      text     NOT NULL,
      explanation_md text     NULL,
      CONSTRAINT revision_quiz_questions_pk                                     PRIMARY KEY (revision_id, question_id),
      CONSTRAINT revision_quiz_questions_revision_id_lecture_id_position_uq     UNIQUE (revision_id, lecture_id, position),
      CONSTRAINT revision_quiz_questions_revision_id_lecture_id_lecture_type_fk FOREIGN KEY (revision_id, lecture_id, lecture_type)
                                                                                REFERENCES catalog.revision_lectures (revision_id, lecture_id, type) ON DELETE RESTRICT,
      CONSTRAINT revision_quiz_questions_lecture_type_ck                        CHECK (lecture_type = 'QUIZ'),
      CONSTRAINT revision_quiz_questions_position_ck                            CHECK (position BETWEEN 0 AND 49),
      CONSTRAINT revision_quiz_questions_kind_ck                                CHECK (kind IN ('SINGLE_CHOICE','MULTIPLE_CHOICE')),
      CONSTRAINT revision_quiz_questions_prompt_md_ck                           CHECK (char_length(prompt_md) BETWEEN 1 AND 2000
                                                                                       AND ${sql.raw(noCtrlExceptBreaks('prompt_md'))}),
      CONSTRAINT revision_quiz_questions_explanation_md_ck                      CHECK (explanation_md IS NULL OR (char_length(explanation_md) BETWEEN 1 AND 2000
                                                                                       AND ${sql.raw(noCtrlExceptBreaks('explanation_md'))}))
    )
  `,
  sql`
    CREATE TABLE catalog.revision_quiz_options (
      revision_id uuid     NOT NULL,
      question_id uuid     NOT NULL,
      position    smallint NOT NULL,
      text        text     NOT NULL,
      is_correct  boolean  NOT NULL,
      CONSTRAINT revision_quiz_options_pk                         PRIMARY KEY (revision_id, question_id, position),
      CONSTRAINT revision_quiz_options_revision_id_question_id_fk FOREIGN KEY (revision_id, question_id)
                                                                  REFERENCES catalog.revision_quiz_questions (revision_id, question_id) ON DELETE RESTRICT,
      CONSTRAINT revision_quiz_options_position_ck                CHECK (position BETWEEN 0 AND 5),
      CONSTRAINT revision_quiz_options_text_ck                    CHECK (char_length(text) BETWEEN 1 AND 300 AND text = btrim(text) AND text !~ '[[:cntrl:]]')
    )
  `,
  sql`
    CREATE TRIGGER revision_quiz_questions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_quiz_questions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_quiz_questions_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_quiz_questions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_quiz_options_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_quiz_options
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_quiz_options_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_quiz_options
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // An answer key can only be written in the SUBMIT transaction of its revision (submitted_at = now()).
  sql`
    CREATE FUNCTION catalog.revision_quiz_same_tx_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_at timestamptz;
    BEGIN
      SELECT submitted_at INTO v_at FROM catalog.course_revisions WHERE id = NEW.revision_id;
      IF FOUND AND v_at <> now() THEN
        RAISE EXCEPTION 'quiz content of revision % can only be written in its submit transaction', NEW.revision_id
          USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_same_tx_ck';
      END IF;
      RETURN NEW;   -- not found: the FK reports it
    END
    $$
  `,
  sql`
    CREATE TRIGGER revision_quiz_questions_same_tx_trg BEFORE INSERT ON catalog.revision_quiz_questions
      FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_same_tx_guard()
  `,
  sql`
    CREATE TRIGGER revision_quiz_options_same_tx_trg BEFORE INSERT ON catalog.revision_quiz_options
      FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_same_tx_guard()
  `,
  // The key of every snapshotted question is well-formed (checked at COMMIT)
  sql`
    CREATE FUNCTION catalog.revision_quiz_key_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_kind    text;
      v_n       integer;
      v_correct integer;
      v_max     integer;
    BEGIN
      SELECT kind INTO v_kind FROM catalog.revision_quiz_questions
       WHERE revision_id = NEW.revision_id AND question_id = NEW.question_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT count(*), count(*) FILTER (WHERE is_correct), max(position)
        INTO v_n, v_correct, v_max
        FROM catalog.revision_quiz_options
       WHERE revision_id = NEW.revision_id AND question_id = NEW.question_id;
      IF v_n NOT BETWEEN 2 AND 6
         OR v_max <> v_n - 1                                        -- positions contiguous 0..n-1 (grading addresses options by position)
         OR (v_kind = 'SINGLE_CHOICE'   AND v_correct <> 1)
         OR (v_kind = 'MULTIPLE_CHOICE' AND v_correct < 1) THEN
        RAISE EXCEPTION 'revision % question % has an invalid answer key (% options, % correct, kind %)',
                        NEW.revision_id, NEW.question_id, v_n, v_correct, v_kind
          USING ERRCODE = '23514', CONSTRAINT = 'revision_quiz_options_key_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER revision_quiz_questions_key_trg AFTER INSERT ON catalog.revision_quiz_questions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_key_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER revision_quiz_options_key_trg AFTER INSERT ON catalog.revision_quiz_options
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_key_guard()
  `,
  // Every snapshotted QUIZ lecture has 1..50 questions with contiguous positions (QUIZ_EMPTY backstop)
  sql`
    CREATE FUNCTION catalog.revision_quiz_complete_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_n   integer;
      v_max integer;
    BEGIN
      SELECT count(*), max(position) INTO v_n, v_max
        FROM catalog.revision_quiz_questions WHERE revision_id = NEW.revision_id AND lecture_id = NEW.lecture_id;
      IF v_n NOT BETWEEN 1 AND 50 OR v_max <> v_n - 1 THEN
        RAISE EXCEPTION 'revision % quiz lecture % has % questions (need 1..50, contiguous)', NEW.revision_id, NEW.lecture_id, v_n
          USING ERRCODE = '23514', CONSTRAINT = 'revision_lectures_quiz_complete_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER revision_lectures_quiz_complete_trg AFTER INSERT ON catalog.revision_lectures
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'QUIZ')
      EXECUTE FUNCTION catalog.revision_quiz_complete_guard()
  `,
  sql`COMMENT ON TABLE catalog.revision_quiz_questions IS 'Immutable quiz snapshot (D6), written only in the submit transaction. With revision_quiz_options it is the answer key: read only by CatalogFacade.getQuizAnswerKey (learning grading) and the owner/admin authoring/review routes. Append-only.'`,
  sql`COMMENT ON TABLE catalog.revision_quiz_options IS 'Immutable options + correctness of a snapshotted question. Key well-formedness (2..6, contiguous, SINGLE = 1 correct, MULTIPLE >= 1) checked at COMMIT (revision_quiz_options_key_ck). Append-only.'`,
];

// ---------------------------------------------------------------------------
// 2.-8. learning
// ---------------------------------------------------------------------------
const learningProgress = [
  sql`
    CREATE TABLE learning.lecture_progress (
      user_id          uuid        NOT NULL,
      lecture_id       uuid        NOT NULL,     -- soft ref to catalog.lectures (stable across revisions)
      course_id        uuid        NOT NULL,     -- soft; = the lecture's course (documented 3NF exception, §5)
      media_asset_id   uuid        NOT NULL,     -- soft; asset the bitmap was measured against
      duration_seconds integer     NOT NULL,     -- snapshot that gives the bitmap its meaning
      position_seconds integer     NOT NULL DEFAULT 0,
      coverage         varbit      NOT NULL,     -- bit i = 5 s bucket i watched
      first_watched_at timestamptz NOT NULL,
      last_watched_at  timestamptz NOT NULL,     -- heartbeat time (from Redis), the LWW key
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT lecture_progress_pk                  PRIMARY KEY (user_id, lecture_id),
      CONSTRAINT lecture_progress_user_id_fk          FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT lecture_progress_duration_seconds_ck CHECK (duration_seconds BETWEEN 1 AND 86400),           -- <= 17280 bits = 2160 B
      CONSTRAINT lecture_progress_position_seconds_ck CHECK (position_seconds BETWEEN 0 AND duration_seconds),
      CONSTRAINT lecture_progress_coverage_ck         CHECK (length(coverage) = (duration_seconds + 4) / 5),  -- = ceil(duration / 5), integer-exact
      CONSTRAINT lecture_progress_times_ck            CHECK (last_watched_at >= first_watched_at)
    ) WITH (fillfactor = 80)
  `,
  // Player bootstrap, consumption, % per course: WHERE user_id=$1 AND course_id=$2
  sql`CREATE INDEX lecture_progress_user_id_course_id_idx ON learning.lecture_progress (user_id, course_id) INCLUDE (lecture_id)`,
  sql`
    CREATE TRIGGER lecture_progress_set_updated_at_trg BEFORE UPDATE ON learning.lecture_progress
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER lecture_progress_immutable_trg BEFORE UPDATE ON learning.lecture_progress
      FOR EACH ROW WHEN ((OLD.user_id, OLD.lecture_id, OLD.course_id) IS DISTINCT FROM (NEW.user_id, NEW.lecture_id, NEW.course_id))
      EXECUTE FUNCTION public.forbid_row_change('lecture_progress_immutable_ck', 'lecture_progress.user_id/lecture_id/course_id are immutable')
  `,
  sql`
    COMMENT ON TABLE learning.lecture_progress IS
      'Coverage bitmap + resume position per (user, VIDEO lecture). Redis is the write-behind buffer (D2); this row is at most ~15 s behind. Watched seconds = least(learning.coverage_bits(coverage) * 5, duration_seconds), never stored. Coverage ORs only while media_asset_id and duration are unchanged; otherwise the newer bitmap replaces it (D3 reset). Never deleted.'
  `,
  sql`
    CREATE TABLE learning.course_activity (
      user_id          uuid        NOT NULL,
      course_id        uuid        NOT NULL,     -- soft
      last_lecture_id  uuid        NOT NULL,     -- soft
      last_accessed_at timestamptz NOT NULL,
      CONSTRAINT course_activity_pk         PRIMARY KEY (user_id, course_id),
      CONSTRAINT course_activity_user_id_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
    ) WITH (fillfactor = 80)
  `,
  sql`COMMENT ON TABLE learning.course_activity IS 'Last lecture opened per (user, course), flushed from Redis la:{u}:{c}. Monotonic upsert (only a newer last_accessed_at wins). Never deleted.'`,
  sql`
    CREATE TABLE learning.course_completions (
      user_id       uuid        NOT NULL,
      course_id     uuid        NOT NULL,      -- soft
      revision_id   uuid        NOT NULL,      -- soft: live revision whose lecture set was completed
      lecture_count integer     NOT NULL,      -- size of that live lecture set
      completed_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT course_completions_pk               PRIMARY KEY (user_id, course_id),
      CONSTRAINT course_completions_user_id_fk       FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT course_completions_lecture_count_ck CHECK (lecture_count BETWEEN 1 AND 5000)
    )
  `,
  sql`
    CREATE TRIGGER course_completions_append_only_trg BEFORE UPDATE OR DELETE ON learning.course_completions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER course_completions_no_truncate_trg BEFORE TRUNCATE ON learning.course_completions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE learning.course_completions IS 'First time completed lectures covered the live lecture set (D5). Written under the lrnc mutex in the same tx as the completing lecture + outbox CourseCompleted. Never changes: un-ticking or new content does not undo it.'`,
];

const learningQuizAttempts = [
  sql`
    CREATE TABLE learning.quiz_attempts (
      id             uuid        NOT NULL DEFAULT uuidv7(),
      user_id        uuid        NOT NULL,
      course_id      uuid        NOT NULL,     -- soft
      lecture_id     uuid        NOT NULL,     -- soft
      revision_id    uuid        NOT NULL,     -- soft: live revision at START, the grading key
      status         text        NOT NULL DEFAULT 'IN_PROGRESS',
      pass_pct       smallint    NOT NULL,     -- snapshot of revision_lectures.quiz_pass_pct
      question_count smallint    NOT NULL,     -- = count(quiz_attempt_questions) (quiz_attempts_grading_ck)
      correct_count  smallint    NULL,         -- set at SUBMIT
      -- DB is the scoring authority (half away from zero); generated columns cannot reference each other
      score_pct      smallint    NULL GENERATED ALWAYS AS ((round(correct_count * 100.0 / question_count))::smallint) STORED,
      passed         boolean     NULL GENERATED ALWAYS AS (round(correct_count * 100.0 / question_count) >= pass_pct) STORED,
      started_at     timestamptz NOT NULL DEFAULT now(),
      submitted_at   timestamptz NULL,
      abandoned_at   timestamptz NULL,
      CONSTRAINT quiz_attempts_pk                       PRIMARY KEY (id),
      CONSTRAINT quiz_attempts_id_user_id_lecture_id_uq UNIQUE (id, user_id, lecture_id),
      CONSTRAINT quiz_attempts_user_id_fk               FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT quiz_attempts_status_ck                CHECK (status IN ('IN_PROGRESS','SUBMITTED','ABANDONED')),
      CONSTRAINT quiz_attempts_pass_pct_ck              CHECK (pass_pct BETWEEN 1 AND 100),
      CONSTRAINT quiz_attempts_question_count_ck        CHECK (question_count BETWEEN 1 AND 50),
      CONSTRAINT quiz_attempts_correct_count_ck         CHECK (correct_count IS NULL OR correct_count BETWEEN 0 AND question_count),
      CONSTRAINT quiz_attempts_result_ck                CHECK ((status = 'SUBMITTED') = (correct_count IS NOT NULL)
                                                               AND (status = 'SUBMITTED') = (submitted_at IS NOT NULL)
                                                               AND (status = 'ABANDONED') = (abandoned_at IS NOT NULL)),
      CONSTRAINT quiz_attempts_times_ck                 CHECK ((submitted_at IS NULL OR submitted_at >= started_at)
                                                               AND (abandoned_at IS NULL OR abandoned_at >= started_at))
    )
  `,
  // One open attempt per (user, quiz): StartQuizAttempt resume path (23505 -> re-read the open one)
  sql`CREATE UNIQUE INDEX quiz_attempts_user_id_lecture_id_open_uq ON learning.quiz_attempts (user_id, lecture_id) WHERE status = 'IN_PROGRESS'`,
  // ListQuizAttempts keyset
  sql`CREATE INDEX quiz_attempts_user_id_lecture_id_started_at_id_idx ON learning.quiz_attempts (user_id, lecture_id, started_at DESC, id DESC)`,
  // LearningMaintenanceJob (_08): IN_PROGRESS older than LEARNING_QUIZ_ATTEMPT_TTL_H
  sql`CREATE INDEX quiz_attempts_started_at_open_idx ON learning.quiz_attempts (started_at) WHERE status = 'IN_PROGRESS'`,
  sql`
    CREATE TRIGGER quiz_attempts_status_insert_trg BEFORE INSERT ON learning.quiz_attempts
      FOR EACH ROW WHEN (NEW.status <> 'IN_PROGRESS' OR NEW.correct_count IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('quiz_attempts_transition_ck', 'a quiz attempt must be created IN_PROGRESS without a result')
  `,
  sql`
    CREATE TRIGGER quiz_attempts_transition_trg BEFORE UPDATE ON learning.quiz_attempts
      FOR EACH ROW WHEN (
           (OLD.id, OLD.user_id, OLD.course_id, OLD.lecture_id, OLD.revision_id, OLD.pass_pct, OLD.question_count, OLD.started_at)
           IS DISTINCT FROM
           (NEW.id, NEW.user_id, NEW.course_id, NEW.lecture_id, NEW.revision_id, NEW.pass_pct, NEW.question_count, NEW.started_at)
        OR OLD.status <> 'IN_PROGRESS'
        OR NEW.status NOT IN ('SUBMITTED','ABANDONED'))
      EXECUTE FUNCTION public.forbid_row_change('quiz_attempts_transition_ck', 'quiz attempt: only IN_PROGRESS -> SUBMITTED | ABANDONED, once; identity immutable')
  `,
  sql`
    CREATE TRIGGER quiz_attempts_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempts
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE learning.quiz_attempts IS 'Graded server-side against revision_id''s key (D6). score_pct/passed are generated. Never deleted. The SUBMIT update must be conditional (WHERE status = ''IN_PROGRESS''); 0 rows -> re-read (SUBMITTED: stored result; ABANDONED: attempt_not_in_progress).'`,
  sql`
    CREATE TABLE learning.quiz_attempt_questions (
      attempt_id  uuid     NOT NULL,
      question_id uuid     NOT NULL,     -- soft: catalog.revision_quiz_questions(revision_id, question_id)
      position    smallint NOT NULL,     -- display order frozen at START
      is_correct  boolean  NULL,         -- set once at SUBMIT
      CONSTRAINT quiz_attempt_questions_pk                     PRIMARY KEY (attempt_id, question_id),
      CONSTRAINT quiz_attempt_questions_attempt_id_position_uq UNIQUE (attempt_id, position),
      CONSTRAINT quiz_attempt_questions_attempt_id_fk          FOREIGN KEY (attempt_id) REFERENCES learning.quiz_attempts (id) ON DELETE RESTRICT,
      CONSTRAINT quiz_attempt_questions_position_ck            CHECK (position BETWEEN 0 AND 49)
    )
  `,
  sql`
    CREATE FUNCTION learning.quiz_attempt_questions_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_status  text;
      v_started timestamptz;
    BEGIN
      SELECT status, started_at INTO v_status, v_started FROM learning.quiz_attempts WHERE id = NEW.attempt_id;
      IF NOT FOUND THEN RETURN NEW; END IF;   -- FK reports it
      IF TG_OP = 'INSERT' THEN
        -- questions are frozen in the START transaction (started_at = now()) and start ungraded
        IF v_status <> 'IN_PROGRESS' OR v_started <> now() OR NEW.is_correct IS NOT NULL THEN
          RAISE EXCEPTION 'attempt % questions can only be added, ungraded, in its start transaction', NEW.attempt_id
            USING ERRCODE = '23514', CONSTRAINT = 'quiz_attempt_questions_same_tx_ck';
        END IF;
        RETURN NEW;
      END IF;
      IF (NEW.attempt_id, NEW.question_id, NEW.position) IS DISTINCT FROM (OLD.attempt_id, OLD.question_id, OLD.position)
         OR OLD.is_correct IS NOT NULL OR NEW.is_correct IS NULL OR v_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'attempt % question %: only is_correct NULL -> value, once, before SUBMITTED', NEW.attempt_id, NEW.question_id
          USING ERRCODE = '23514', CONSTRAINT = 'quiz_attempt_questions_immutable_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER quiz_attempt_questions_guard_trg BEFORE INSERT OR UPDATE ON learning.quiz_attempt_questions
      FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempt_questions_guard()
  `,
  sql`
    CREATE TRIGGER quiz_attempt_questions_no_delete_trg BEFORE DELETE ON learning.quiz_attempt_questions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER quiz_attempt_questions_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempt_questions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TABLE learning.quiz_attempt_selections (
      attempt_id      uuid     NOT NULL,
      question_id     uuid     NOT NULL,
      option_position smallint NOT NULL,
      CONSTRAINT quiz_attempt_selections_pk                        PRIMARY KEY (attempt_id, question_id, option_position),
      CONSTRAINT quiz_attempt_selections_attempt_id_question_id_fk FOREIGN KEY (attempt_id, question_id)
                                                                   REFERENCES learning.quiz_attempt_questions (attempt_id, question_id) ON DELETE RESTRICT,
      CONSTRAINT quiz_attempt_selections_option_position_ck        CHECK (option_position BETWEEN 0 AND 5)
    )
  `,
  sql`
    CREATE FUNCTION learning.quiz_attempt_selections_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_status text;
    BEGIN
      SELECT status INTO v_status FROM learning.quiz_attempts WHERE id = NEW.attempt_id FOR SHARE;   -- no-op: SUBMIT already holds FOR UPDATE
      IF FOUND AND v_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'attempt % is not in progress', NEW.attempt_id
          USING ERRCODE = '23514', CONSTRAINT = 'quiz_attempt_selections_attempt_open_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER quiz_attempt_selections_open_trg BEFORE INSERT ON learning.quiz_attempt_selections
      FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempt_selections_guard()
  `,
  sql`
    CREATE TRIGGER quiz_attempt_selections_append_only_trg BEFORE UPDATE OR DELETE ON learning.quiz_attempt_selections
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER quiz_attempt_selections_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempt_selections
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // question_count / correct_count agree with the per-question rows (checked at COMMIT)
  sql`
    CREATE FUNCTION learning.quiz_attempts_grading_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_status text;
      v_qc     smallint;
      v_cc     smallint;
      v_n      integer;
      v_ok     integer;
      v_null   integer;
    BEGIN
      SELECT status, question_count, correct_count INTO v_status, v_qc, v_cc FROM learning.quiz_attempts WHERE id = NEW.id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT count(*), count(*) FILTER (WHERE is_correct), count(*) FILTER (WHERE is_correct IS NULL)
        INTO v_n, v_ok, v_null
        FROM learning.quiz_attempt_questions WHERE attempt_id = NEW.id;
      IF v_n <> v_qc
         OR (v_status = 'SUBMITTED'  AND (v_null <> 0 OR v_ok <> v_cc))
         OR (v_status <> 'SUBMITTED' AND v_null <> v_n) THEN
        RAISE EXCEPTION 'attempt % result does not match its graded questions', NEW.id
          USING ERRCODE = '23514', CONSTRAINT = 'quiz_attempts_grading_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER quiz_attempts_grading_trg AFTER INSERT OR UPDATE OF status, correct_count ON learning.quiz_attempts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempts_grading_guard()
  `,
  sql`COMMENT ON TABLE learning.quiz_attempt_questions IS 'Questions of an attempt in display order, frozen at START (same tx). is_correct set once at SUBMIT (selected set = correct set). Never deleted.'`,
  sql`COMMENT ON TABLE learning.quiz_attempt_selections IS 'Selected option positions per question, inserted at SUBMIT while the attempt is IN_PROGRESS. SINGLE <= 1 selection is app-validated (kind lives in the catalog key). Append-only.'`,
];

const learningCompletionsNotes = [
  sql`
    CREATE TABLE learning.lecture_completions (
      user_id         uuid        NOT NULL,
      lecture_id      uuid        NOT NULL,     -- soft
      course_id       uuid        NOT NULL,     -- soft; = the lecture's course (§5)
      lecture_type    text        NOT NULL,     -- = catalog lecture type (immutable there; §5)
      cause           text        NOT NULL,
      revision_id     uuid        NOT NULL,     -- soft: live revision at completion
      quiz_attempt_id uuid        NULL,         -- QUIZ_PASSED: the passing attempt
      completed_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT lecture_completions_pk                                    PRIMARY KEY (user_id, lecture_id),
      CONSTRAINT lecture_completions_user_id_fk                            FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT lecture_completions_quiz_attempt_id_user_id_lecture_id_fk FOREIGN KEY (quiz_attempt_id, user_id, lecture_id)
                                                                           REFERENCES learning.quiz_attempts (id, user_id, lecture_id) ON DELETE RESTRICT,
      CONSTRAINT lecture_completions_lecture_type_ck                       CHECK (lecture_type IN ('VIDEO','ARTICLE','RESOURCE','QUIZ')),
      CONSTRAINT lecture_completions_cause_ck                              CHECK (cause IN ('VIDEO_WATCHED','ARTICLE_READ','RESOURCE_OPENED','QUIZ_PASSED','MANUAL')),
      CONSTRAINT lecture_completions_cause_type_ck                         CHECK (
           (lecture_type = 'VIDEO'    AND cause = 'VIDEO_WATCHED')
        OR (lecture_type = 'ARTICLE'  AND cause IN ('ARTICLE_READ','MANUAL'))
        OR (lecture_type = 'RESOURCE' AND cause IN ('RESOURCE_OPENED','MANUAL'))
        OR (lecture_type = 'QUIZ'     AND cause = 'QUIZ_PASSED')),
      CONSTRAINT lecture_completions_quiz_attempt_ck                       CHECK ((cause = 'QUIZ_PASSED') = (quiz_attempt_id IS NOT NULL))
    )
  `,
  // completed ∩ live ids per course (bootstrap, %, consumption, review gate, course-completion check), index-only
  sql`CREATE INDEX lecture_completions_user_id_course_id_idx ON learning.lecture_completions (user_id, course_id) INCLUDE (lecture_id)`,
  sql`
    CREATE FUNCTION learning.lecture_completions_quiz_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_status text;
      v_passed boolean;
      v_course uuid;
    BEGIN
      SELECT status, passed, course_id INTO v_status, v_passed, v_course FROM learning.quiz_attempts WHERE id = NEW.quiz_attempt_id;
      IF NOT FOUND THEN RETURN NEW; END IF;   -- FK reports it
      IF v_status <> 'SUBMITTED' OR v_passed IS NOT TRUE OR v_course <> NEW.course_id THEN
        RAISE EXCEPTION 'quiz completion of lecture % needs a passed, submitted attempt of this course', NEW.lecture_id
          USING ERRCODE = '23514', CONSTRAINT = 'lecture_completions_quiz_passed_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER lecture_completions_quiz_trg BEFORE INSERT ON learning.lecture_completions
      FOR EACH ROW WHEN (NEW.quiz_attempt_id IS NOT NULL) EXECUTE FUNCTION learning.lecture_completions_quiz_guard()
  `,
  sql`
    CREATE TRIGGER lecture_completions_immutable_trg BEFORE UPDATE ON learning.lecture_completions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('lecture_completions_immutable_ck', 'lecture completions are insert/delete only')
  `,
  sql`COMMENT ON TABLE learning.lecture_completions IS 'Current completion state per (user, lecture). DELETE = un-complete (history lives in the LectureCompleted / LectureCompletionCleared events). Insert/delete only. Every completion write takes the lrnc (user, course) advisory lock first.'`,
  sql`
    CREATE TABLE learning.notes (
      id               uuid        NOT NULL DEFAULT uuidv7(),
      user_id          uuid        NOT NULL,
      course_id        uuid        NOT NULL,   -- soft (§5)
      lecture_id       uuid        NOT NULL,   -- soft
      position_seconds integer     NULL,       -- VIDEO only, <= duration (app; catalog is cross-schema)
      body_md          text        NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notes_pk                  PRIMARY KEY (id),
      CONSTRAINT notes_user_id_fk          FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT notes_position_seconds_ck CHECK (position_seconds IS NULL OR position_seconds BETWEEN 0 AND 86400),
      CONSTRAINT notes_body_md_ck          CHECK (char_length(body_md) BETWEEN 1 AND 2000 AND ${sql.raw(noCtrlExceptBreaks('body_md'))}),
      CONSTRAINT notes_times_ck            CHECK (updated_at >= created_at)
    )
  `,
  // ListNotes keyset per course + the 500/(user, course) count (index-only)
  sql`CREATE INDEX notes_user_id_course_id_created_at_id_idx  ON learning.notes (user_id, course_id, created_at DESC, id DESC)`,
  // ListNotes filtered by lectureId, same keyset
  sql`CREATE INDEX notes_user_id_lecture_id_created_at_id_idx ON learning.notes (user_id, lecture_id, created_at DESC, id DESC)`,
  sql`
    CREATE TRIGGER notes_set_updated_at_trg BEFORE UPDATE ON learning.notes
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER notes_immutable_trg BEFORE UPDATE ON learning.notes
      FOR EACH ROW WHEN ((OLD.id, OLD.user_id, OLD.course_id, OLD.lecture_id, OLD.created_at)
                         IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.course_id, NEW.lecture_id, NEW.created_at))
      EXECUTE FUNCTION public.forbid_row_change('notes_immutable_ck', 'notes.user_id/course_id/lecture_id/created_at are immutable')
  `,
  sql`COMMENT ON TABLE learning.notes IS 'Private learner notes. <= 500 per (user, course): counted under the note advisory lock (§10). Hard-deleted by the owner (allowed after a revoke, D9).'`,
];

const learningCertificates = [
  sql`
    CREATE TABLE learning.certificates (
      id              uuid        NOT NULL DEFAULT uuidv7(),
      public_code     text        NOT NULL,      -- 26 Crockford base32 chars (128 random bits), the verification URL
      user_id         uuid        NOT NULL,
      course_id       uuid        NOT NULL,      -- soft to catalog; pinned to a completion
      revision_id     uuid        NOT NULL,      -- soft: live revision at issue (title source)
      recipient_name  text        NOT NULL,      -- snapshots: what the certificate says
      course_title    text        NOT NULL,
      instructor_name text        NOT NULL,
      status          text        NOT NULL DEFAULT 'ACTIVE',
      issued_at       timestamptz NOT NULL DEFAULT now(),     -- = ISSUE transition (seq 1)
      revoked_at      timestamptz NULL,                       -- = head transition when REVOKED
      pdf_object_key  text        NULL,
      pdf_rendered_at timestamptz NULL,
      source_event_id uuid        NOT NULL,      -- the CourseCompleted outbox event
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT certificates_pk                   PRIMARY KEY (id),
      CONSTRAINT certificates_public_code_uq       UNIQUE (public_code),
      CONSTRAINT certificates_user_id_course_id_uq UNIQUE (user_id, course_id),
      CONSTRAINT certificates_source_event_id_uq   UNIQUE (source_event_id),
      CONSTRAINT certificates_user_id_course_id_fk FOREIGN KEY (user_id, course_id)
                                                   REFERENCES learning.course_completions (user_id, course_id) ON DELETE RESTRICT,
      CONSTRAINT certificates_public_code_ck       CHECK (public_code ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
      CONSTRAINT certificates_recipient_name_ck    CHECK (char_length(recipient_name) BETWEEN 1 AND 80 AND recipient_name = btrim(recipient_name) AND recipient_name !~ '[[:cntrl:]]'),
      CONSTRAINT certificates_course_title_ck      CHECK (char_length(course_title) BETWEEN 1 AND 60 AND course_title = btrim(course_title) AND course_title !~ '[[:cntrl:]]'),
      CONSTRAINT certificates_instructor_name_ck   CHECK (char_length(instructor_name) BETWEEN 1 AND 80 AND instructor_name = btrim(instructor_name) AND instructor_name !~ '[[:cntrl:]]'),
      CONSTRAINT certificates_status_ck            CHECK (status IN ('ACTIVE','REVOKED')),
      CONSTRAINT certificates_revoked_ck           CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
      CONSTRAINT certificates_pdf_ck               CHECK ((pdf_object_key IS NULL) = (pdf_rendered_at IS NULL)
                                                          AND (pdf_object_key IS NULL OR pdf_object_key = 'certificates/' || id::text || '/v1.pdf')),
      CONSTRAINT certificates_times_ck             CHECK ((revoked_at IS NULL OR revoked_at >= issued_at)
                                                          AND (pdf_rendered_at IS NULL OR pdf_rendered_at >= issued_at))
    )
  `,
  // LearningMaintenanceJob (_08): re-render PDFs still missing after 10 min
  sql`CREATE INDEX certificates_issued_at_pdf_pending_idx ON learning.certificates (issued_at) WHERE pdf_rendered_at IS NULL`,
  sql`
    CREATE TRIGGER certificates_set_updated_at_trg BEFORE UPDATE ON learning.certificates
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER certificates_immutable_trg BEFORE UPDATE ON learning.certificates
      FOR EACH ROW WHEN (
           (OLD.id, OLD.public_code, OLD.user_id, OLD.course_id, OLD.revision_id, OLD.recipient_name, OLD.course_title,
            OLD.instructor_name, OLD.issued_at, OLD.source_event_id)
           IS DISTINCT FROM
           (NEW.id, NEW.public_code, NEW.user_id, NEW.course_id, NEW.revision_id, NEW.recipient_name, NEW.course_title,
            NEW.instructor_name, NEW.issued_at, NEW.source_event_id)
        OR (OLD.pdf_rendered_at IS NOT NULL AND (NEW.pdf_object_key, NEW.pdf_rendered_at) IS DISTINCT FROM (OLD.pdf_object_key, OLD.pdf_rendered_at)))
      EXECUTE FUNCTION public.forbid_row_change('certificates_immutable_ck', 'certificate content is immutable; the PDF is recorded once')
  `,
  sql`
    CREATE TRIGGER certificates_no_truncate_trg BEFORE TRUNCATE ON learning.certificates
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TABLE learning.certificate_transitions (
      certificate_id  uuid        NOT NULL,
      seq             integer     NOT NULL,
      prev_seq        integer     NULL GENERATED ALWAYS AS (NULLIF(seq - 1, 0)) STORED,   -- chain FK helper (STORED mandatory)
      action          text        NOT NULL,
      from_status     text        NULL,
      to_status       text        NOT NULL,
      cause           text        NOT NULL,
      actor_id        uuid        NULL,        -- ADMIN only
      reason          text        NULL,        -- ADMIN only, 10..2000
      source_event_id uuid        NULL,        -- worker causes: the consumed event
      occurred_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT certificate_transitions_pk                              PRIMARY KEY (certificate_id, seq),
      CONSTRAINT certificate_transitions_certificate_id_seq_to_status_uq UNIQUE (certificate_id, seq, to_status),
      CONSTRAINT certificate_transitions_certificate_id_prev_seq_from_status_fk
                                                                         FOREIGN KEY (certificate_id, prev_seq, from_status)
                                                                         REFERENCES learning.certificate_transitions (certificate_id, seq, to_status) ON DELETE RESTRICT,
      CONSTRAINT certificate_transitions_certificate_id_fk               FOREIGN KEY (certificate_id) REFERENCES learning.certificates (id) ON DELETE RESTRICT,
      CONSTRAINT certificate_transitions_actor_id_fk                     FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT certificate_transitions_seq_ck                          CHECK (seq >= 1),
      CONSTRAINT certificate_transitions_root_ck                         CHECK ((seq = 1) = (from_status IS NULL) AND (seq = 1) = (action = 'ISSUE')),
      CONSTRAINT certificate_transitions_edge_ck                         CHECK (
           (action = 'ISSUE'     AND from_status IS NULL      AND to_status = 'ACTIVE'  AND cause = 'COURSE_COMPLETED')
        OR (action = 'REVOKE'    AND from_status = 'ACTIVE'   AND to_status = 'REVOKED' AND cause IN ('ENROLLMENT_REVOKED','ADMIN'))
        OR (action = 'REINSTATE' AND from_status = 'REVOKED'  AND to_status = 'ACTIVE'  AND cause IN ('ENROLLMENT_REGRANTED','ADMIN'))),
      CONSTRAINT certificate_transitions_actor_ck                        CHECK ((cause = 'ADMIN') = (actor_id IS NOT NULL)
                                                                                AND (cause = 'ADMIN') = (source_event_id IS NULL)),
      CONSTRAINT certificate_transitions_reason_ck                       CHECK ((cause = 'ADMIN') = (reason IS NOT NULL)
                                                                                AND (reason IS NULL OR (char_length(reason) BETWEEN 10 AND 2000
                                                                                    AND ${sql.raw(noCtrlExceptBreaks('reason'))})))
    )
  `,
  sql`
    CREATE TRIGGER certificate_transitions_append_only_trg BEFORE UPDATE OR DELETE ON learning.certificate_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER certificate_transitions_no_truncate_trg BEFORE TRUNCATE ON learning.certificate_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // status/issued_at/revoked_at == log; an automatic reinstate may only undo an automatic revoke (checked at COMMIT)
  sql`
    CREATE FUNCTION learning.certificates_status_log_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_id      uuid;
      v_status  text;
      v_issued  timestamptz;
      v_revoked timestamptz;
      h_status  text;
      h_at      timestamptz;
      v_root_at timestamptz;
    BEGIN
      IF TG_TABLE_NAME = 'certificates' THEN v_id := NEW.id; ELSE v_id := NEW.certificate_id; END IF;
      SELECT status, issued_at, revoked_at INTO v_status, v_issued, v_revoked FROM learning.certificates WHERE id = v_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT to_status, occurred_at INTO h_status, h_at
        FROM learning.certificate_transitions WHERE certificate_id = v_id ORDER BY seq DESC LIMIT 1;
      SELECT occurred_at INTO v_root_at FROM learning.certificate_transitions WHERE certificate_id = v_id AND seq = 1;
      IF h_status IS DISTINCT FROM v_status OR v_root_at IS DISTINCT FROM v_issued
         OR (v_status = 'REVOKED' AND h_at IS DISTINCT FROM v_revoked) THEN
        RAISE EXCEPTION 'certificate % columns do not match its transition log', v_id
          USING ERRCODE = '23514', CONSTRAINT = 'certificates_status_log_ck';
      END IF;
      IF EXISTS (SELECT 1
                   FROM learning.certificate_transitions t
                   JOIN learning.certificate_transitions p ON p.certificate_id = t.certificate_id AND p.seq = t.seq - 1
                  WHERE t.certificate_id = v_id AND t.cause = 'ENROLLMENT_REGRANTED' AND p.cause <> 'ENROLLMENT_REVOKED') THEN
        RAISE EXCEPTION 'certificate %: a regrant may only reinstate an enrollment-caused revoke (admin revokes stay)', v_id
          USING ERRCODE = '23514', CONSTRAINT = 'certificate_transitions_reinstate_cause_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER certificates_status_log_trg AFTER INSERT OR UPDATE OF status, issued_at, revoked_at ON learning.certificates
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.certificates_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER certificate_transitions_status_log_trg AFTER INSERT ON learning.certificate_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.certificates_status_log_guard()
  `,
  sql`
    COMMENT ON TABLE learning.certificates IS
      'One certificate per course completion (FK). Names/title are point-in-time snapshots. status/issued_at/revoked_at materialise certificate_transitions (certificates_status_log_ck, COMMIT). PDF at the deterministic key certificates/{id}/v1.pdf, recorded once. Never deleted.'
  `,
  sql`COMMENT ON TABLE learning.certificate_transitions IS 'Append-only certificate log (ISSUE/REVOKE/REINSTATE, cause, admin actor + reason). Linear chain via seq (P4 pattern), max(seq)+1 under the certificate row lock.'`,
];

// ---------------------------------------------------------------------------
// 9. engagement reviews + replies + rating stats (D10, D11)
// ---------------------------------------------------------------------------
const engagementReviews = [
  sql`
    CREATE TABLE engagement.reviews (
      id                uuid        NOT NULL DEFAULT uuidv7(),
      course_id         uuid        NOT NULL,      -- soft
      user_id           uuid        NOT NULL,
      rating            smallint    NOT NULL,
      body              text        NULL,          -- plain text (D22), line breaks allowed (open point 1)
      moderation_status text        NOT NULL DEFAULT 'VISIBLE',   -- materialises moderation_actions (moderation_status_log_ck)
      suspended_at      timestamptz NULL,          -- enrollment revoked (worker sync, D9)
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      edited_at         timestamptz NULL,
      deleted_at        timestamptz NULL,
      deleted_by        uuid        NULL,
      CONSTRAINT reviews_pk                   PRIMARY KEY (id),
      CONSTRAINT reviews_user_id_fk           FOREIGN KEY (user_id)    REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT reviews_deleted_by_fk        FOREIGN KEY (deleted_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT reviews_rating_ck            CHECK (rating BETWEEN 1 AND 5),
      CONSTRAINT reviews_body_ck              CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body)
                                                     AND ${sql.raw(noCtrlExceptBreaks('body'))})),
      CONSTRAINT reviews_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
      CONSTRAINT reviews_deleted_ck           CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CONSTRAINT reviews_times_ck             CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                                     AND (deleted_at IS NULL OR deleted_at >= created_at))
    )
  `,
  // One live review per (course, user); the upsert arbiter; "my review" lookup; review-enrollment-sync lookup
  sql`CREATE UNIQUE INDEX reviews_course_id_user_id_live_uq ON engagement.reviews (course_id, user_id) WHERE deleted_at IS NULL`,
  // ListPublicReviews keyset (no rating filter)
  sql`
    CREATE INDEX reviews_course_id_created_at_id_public_idx ON engagement.reviews (course_id, created_at DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL
  `,
  // ListPublicReviews with ?rating= keyset AND the rating recompute (index-only GROUP BY rating per course)
  sql`
    CREATE INDEX reviews_course_id_rating_created_at_id_public_idx ON engagement.reviews (course_id, rating, created_at DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL
  `,
  // ListCourseReviewsForInstructor: all non-deleted (hidden + suspended flagged)
  sql`CREATE INDEX reviews_course_id_created_at_id_live_idx ON engagement.reviews (course_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`,
  sql`
    CREATE TRIGGER reviews_set_updated_at_trg BEFORE UPDATE ON engagement.reviews
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER reviews_immutable_trg BEFORE UPDATE ON engagement.reviews
      FOR EACH ROW WHEN ((OLD.id, OLD.course_id, OLD.user_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.user_id, NEW.created_at)
                         OR OLD.deleted_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('reviews_immutable_ck', 'review identity is immutable; a deleted review is frozen')
  `,
  sql`
    CREATE TRIGGER reviews_no_truncate_trg BEFORE TRUNCATE ON engagement.reviews
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE engagement.reviews IS 'Course reviews (D10). PUBLISHED (counted, public) = VISIBLE AND suspended_at IS NULL AND deleted_at IS NULL. Soft delete only; a new review is allowed after a delete. Eligibility (ACTIVE enrollment, >= 1 completed lecture, not the owner) is app-checked (cross-schema).'`,
  sql`
    CREATE TABLE engagement.review_replies (
      id                uuid        NOT NULL DEFAULT uuidv7(),
      review_id         uuid        NOT NULL,
      author_id         uuid        NOT NULL,      -- = course owner (app; ownership is immutable)
      body              text        NOT NULL,      -- plain text, line breaks allowed (open point 1)
      moderation_status text        NOT NULL DEFAULT 'VISIBLE',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      edited_at         timestamptz NULL,
      deleted_at        timestamptz NULL,
      CONSTRAINT review_replies_pk                   PRIMARY KEY (id),
      CONSTRAINT review_replies_review_id_fk         FOREIGN KEY (review_id) REFERENCES engagement.reviews (id) ON DELETE RESTRICT,
      CONSTRAINT review_replies_author_id_fk         FOREIGN KEY (author_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT review_replies_body_ck              CHECK (char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body)
                                                            AND ${sql.raw(noCtrlExceptBreaks('body'))}),
      CONSTRAINT review_replies_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
      CONSTRAINT review_replies_times_ck             CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                                            AND (deleted_at IS NULL OR deleted_at >= created_at))
    )
  `,
  // One live reply per review (D10); upsert arbiter; reply lookup for the review page (batch by review_id = ANY)
  sql`CREATE UNIQUE INDEX review_replies_review_id_live_uq ON engagement.review_replies (review_id) WHERE deleted_at IS NULL`,
  sql`
    CREATE TRIGGER review_replies_set_updated_at_trg BEFORE UPDATE ON engagement.review_replies
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER review_replies_immutable_trg BEFORE UPDATE ON engagement.review_replies
      FOR EACH ROW WHEN ((OLD.id, OLD.review_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.review_id, NEW.author_id, NEW.created_at)
                         OR OLD.deleted_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('review_replies_immutable_ck', 'reply identity is immutable; a deleted reply is frozen')
  `,
  sql`
    CREATE TRIGGER review_replies_no_truncate_trg BEFORE TRUNCATE ON engagement.review_replies
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE engagement.review_replies IS 'Instructor reply to a review (<= 1 live). Own uuid PK (not review_id) so a deleted reply keeps its reports and moderation history and a new reply gets a new identity.'`,
  sql`
    CREATE TABLE engagement.course_rating_stats (
      course_id      uuid          NOT NULL,     -- soft
      count_1        integer       NOT NULL DEFAULT 0,
      count_2        integer       NOT NULL DEFAULT 0,
      count_3        integer       NOT NULL DEFAULT 0,
      count_4        integer       NOT NULL DEFAULT 0,
      count_5        integer       NOT NULL DEFAULT 0,
      -- derived from the histogram (generated: cannot drift; generated columns can't reference each other)
      review_count   integer       NOT NULL GENERATED ALWAYS AS (count_1 + count_2 + count_3 + count_4 + count_5) STORED,
      rating_sum     bigint        NOT NULL GENERATED ALWAYS AS
                       (count_1::bigint + 2 * count_2::bigint + 3 * count_3::bigint + 4 * count_4::bigint + 5 * count_5::bigint) STORED,
      average_rating numeric(2,1)  NULL GENERATED ALWAYS AS (
                       CASE WHEN count_1 + count_2 + count_3 + count_4 + count_5 > 0
                            THEN round((count_1::bigint + 2 * count_2::bigint + 3 * count_3::bigint + 4 * count_4::bigint + 5 * count_5::bigint)::numeric
                                       / (count_1 + count_2 + count_3 + count_4 + count_5), 1)
                       END) STORED,
      recomputed_at  timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT course_rating_stats_pk        PRIMARY KEY (course_id),
      CONSTRAINT course_rating_stats_counts_ck CHECK (count_1 >= 0 AND count_2 >= 0 AND count_3 >= 0 AND count_4 >= 0 AND count_5 >= 0)
    )
  `,
  sql`COMMENT ON TABLE engagement.course_rating_stats IS 'Read model (D11), written only by the worker: the whole histogram is recomputed from PUBLISHED reviews under SELECT ... FOR UPDATE of this row (§8.4). Totals and the 1-dp average are generated. A missing row = {count: 0}.'`,
];

// ---------------------------------------------------------------------------
// 10. engagement Q&A (D12; trigger-maintained counters, P5-D12)
// ---------------------------------------------------------------------------
const engagementQa = [
  sql`
    CREATE TABLE engagement.questions (
      id                 uuid        NOT NULL DEFAULT uuidv7(),
      course_id          uuid        NOT NULL,     -- soft
      lecture_id         uuid        NULL,         -- soft; NULL = general question
      author_id          uuid        NOT NULL,
      title              text        NOT NULL,     -- plain text
      body_md            text        NOT NULL,
      accepted_answer_id uuid        NULL,         -- RESOLVED <=> NOT NULL (no status column)
      moderation_status  text        NOT NULL DEFAULT 'VISIBLE',
      upvote_count       integer     NOT NULL DEFAULT 0,       -- trigger-maintained (3NF exception)
      answer_count       integer     NOT NULL DEFAULT 0,       -- trigger-maintained: visible, non-deleted answers
      last_activity_at   timestamptz NOT NULL DEFAULT now(),   -- trigger-maintained: greatest(created_at, newest visible answer)
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      edited_at          timestamptz NULL,
      deleted_at         timestamptz NULL,
      CONSTRAINT questions_pk                   PRIMARY KEY (id),
      CONSTRAINT questions_author_id_fk         FOREIGN KEY (author_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT questions_title_ck             CHECK (char_length(title) BETWEEN 5 AND 200 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
      CONSTRAINT questions_body_md_ck           CHECK (char_length(body_md) BETWEEN 1 AND 10000 AND ${sql.raw(noCtrlExceptBreaks('body_md'))}),
      CONSTRAINT questions_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
      CONSTRAINT questions_counts_ck            CHECK (upvote_count >= 0 AND answer_count >= 0),
      CONSTRAINT questions_times_ck             CHECK (last_activity_at >= created_at AND updated_at >= created_at
                                                       AND (edited_at IS NULL OR edited_at >= created_at)
                                                       AND (deleted_at IS NULL OR deleted_at >= created_at))
    )
  `,
  // ListQuestions sort=recent
  sql`
    CREATE INDEX questions_course_id_last_activity_at_id_idx ON engagement.questions (course_id, last_activity_at DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE'
  `,
  // ListQuestions ?lectureId= (recent)
  sql`
    CREATE INDEX questions_course_id_lecture_id_last_activity_at_id_idx ON engagement.questions (course_id, lecture_id, last_activity_at DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE'
  `,
  // sort=top (unstable keyset accepted, Q12; the client de-dupes by id)
  sql`
    CREATE INDEX questions_course_id_upvote_count_id_idx ON engagement.questions (course_id, upvote_count DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE'
  `,
  // sort=unanswered + InstructorQaInbox status=unanswered
  sql`
    CREATE INDEX questions_course_id_created_at_id_unanswered_idx ON engagement.questions (course_id, created_at DESC, id DESC)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND answer_count = 0
  `,
  // q= course-scoped title search (BitmapAnd with a course index)
  sql`
    CREATE INDEX questions_title_trgm_idx ON engagement.questions USING gin (title gin_trgm_ops)
      WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE'
  `,
  sql`
    CREATE TABLE engagement.answers (
      id                uuid        NOT NULL DEFAULT uuidv7(),
      question_id       uuid        NOT NULL,
      author_id         uuid        NOT NULL,
      body_md           text        NOT NULL,
      upvote_count      integer     NOT NULL DEFAULT 0,     -- trigger-maintained
      moderation_status text        NOT NULL DEFAULT 'VISIBLE',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      edited_at         timestamptz NULL,
      deleted_at        timestamptz NULL,
      CONSTRAINT answers_pk                   PRIMARY KEY (id),
      CONSTRAINT answers_question_id_id_uq    UNIQUE (question_id, id),     -- FK target: the accepted answer belongs to the question
      CONSTRAINT answers_question_id_fk       FOREIGN KEY (question_id) REFERENCES engagement.questions (id) ON DELETE RESTRICT,
      CONSTRAINT answers_author_id_fk         FOREIGN KEY (author_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT answers_body_md_ck           CHECK (char_length(body_md) BETWEEN 1 AND 10000 AND ${sql.raw(noCtrlExceptBreaks('body_md'))}),
      CONSTRAINT answers_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
      CONSTRAINT answers_upvote_count_ck      CHECK (upvote_count >= 0),
      CONSTRAINT answers_times_ck             CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                                     AND (deleted_at IS NULL OR deleted_at >= created_at))
    )
  `,
  // Answers page keyset (oldest first) + the counter recompute in answers_sync_question()
  sql`CREATE INDEX answers_question_id_created_at_id_idx ON engagement.answers (question_id, created_at, id)`,
  sql`
    ALTER TABLE engagement.questions
      ADD CONSTRAINT questions_id_accepted_answer_id_fk FOREIGN KEY (id, accepted_answer_id)
          REFERENCES engagement.answers (question_id, id) ON DELETE RESTRICT
  `,
  sql`
    CREATE TABLE engagement.question_votes (
      subject_id uuid        NOT NULL,    -- questions.id
      user_id    uuid        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT question_votes_pk            PRIMARY KEY (subject_id, user_id),
      CONSTRAINT question_votes_subject_id_fk FOREIGN KEY (subject_id) REFERENCES engagement.questions (id) ON DELETE RESTRICT,
      CONSTRAINT question_votes_user_id_fk    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
    )
  `,
  sql`
    CREATE TABLE engagement.answer_votes (
      subject_id uuid        NOT NULL,    -- answers.id
      user_id    uuid        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT answer_votes_pk            PRIMARY KEY (subject_id, user_id),
      CONSTRAINT answer_votes_subject_id_fk FOREIGN KEY (subject_id) REFERENCES engagement.answers (id) ON DELETE RESTRICT,
      CONSTRAINT answer_votes_user_id_fk    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
    )
  `,
  sql`
    CREATE TRIGGER question_votes_immutable_trg BEFORE UPDATE ON engagement.question_votes
      FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('question_votes_immutable_ck', 'votes are insert/delete only')
  `,
  sql`
    CREATE TRIGGER answer_votes_immutable_trg BEFORE UPDATE ON engagement.answer_votes
      FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('answer_votes_immutable_ck', 'votes are insert/delete only')
  `,
  // 10a. "not your own" backstop for votes and reports (TG_ARGV[0] = subject type)
  sql`
    CREATE FUNCTION engagement.forbid_own_content() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_actor  uuid;
      v_author uuid;
    BEGIN
      IF TG_TABLE_NAME IN ('question_votes','answer_votes') THEN v_actor := NEW.user_id; ELSE v_actor := NEW.reporter_id; END IF;
      CASE TG_ARGV[0]
        WHEN 'REVIEW'       THEN SELECT user_id   INTO v_author FROM engagement.reviews        WHERE id = NEW.subject_id;
        WHEN 'REVIEW_REPLY' THEN SELECT author_id INTO v_author FROM engagement.review_replies WHERE id = NEW.subject_id;
        WHEN 'QUESTION'     THEN SELECT author_id INTO v_author FROM engagement.questions      WHERE id = NEW.subject_id;
        WHEN 'ANSWER'       THEN SELECT author_id INTO v_author FROM engagement.answers        WHERE id = NEW.subject_id;
      END CASE;
      IF v_author = v_actor THEN      -- NULL (no subject): the FK reports it
        RAISE EXCEPTION '% on own content is not allowed', TG_TABLE_NAME
          USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_own_content_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER question_votes_own_content_trg BEFORE INSERT ON engagement.question_votes
      FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('QUESTION')
  `,
  sql`
    CREATE TRIGGER answer_votes_own_content_trg BEFORE INSERT ON engagement.answer_votes
      FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('ANSWER')
  `,
  // 10b. upvote counters (delta: exact under concurrency, the row lock serialises and EPQ re-reads the new count)
  sql`
    CREATE FUNCTION engagement.votes_count() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME = 'question_votes' THEN
        IF TG_OP = 'INSERT' THEN
          UPDATE engagement.questions SET upvote_count = upvote_count + 1 WHERE id = NEW.subject_id;
        ELSE
          UPDATE engagement.questions SET upvote_count = upvote_count - 1 WHERE id = OLD.subject_id;
        END IF;
      ELSE
        IF TG_OP = 'INSERT' THEN
          UPDATE engagement.answers SET upvote_count = upvote_count + 1 WHERE id = NEW.subject_id;
        ELSE
          UPDATE engagement.answers SET upvote_count = upvote_count - 1 WHERE id = OLD.subject_id;
        END IF;
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE TRIGGER question_votes_count_trg AFTER INSERT OR DELETE ON engagement.question_votes
      FOR EACH ROW EXECUTE FUNCTION engagement.votes_count()
  `,
  sql`
    CREATE TRIGGER answer_votes_count_trg AFTER INSERT OR DELETE ON engagement.answer_votes
      FOR EACH ROW EXECUTE FUNCTION engagement.votes_count()
  `,
  // 10c. answer_count / last_activity_at / accepted-answer clearing (recompute under the question row lock)
  sql`
    CREATE FUNCTION engagement.answers_sync_question() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- lock first, THEN count in a new statement (READ COMMITTED: sees answers committed while we waited)
      PERFORM 1 FROM engagement.questions WHERE id = NEW.question_id FOR NO KEY UPDATE;
      UPDATE engagement.questions q
         SET answer_count       = c.n,
             last_activity_at   = greatest(q.created_at, c.last_at),
             accepted_answer_id = CASE WHEN q.accepted_answer_id = NEW.id
                                        AND (NEW.deleted_at IS NOT NULL OR NEW.moderation_status <> 'VISIBLE')
                                       THEN NULL ELSE q.accepted_answer_id END
        FROM (SELECT count(*)::int AS n, max(a.created_at) AS last_at
                FROM engagement.answers a
               WHERE a.question_id = NEW.question_id AND a.deleted_at IS NULL AND a.moderation_status = 'VISIBLE') c
       WHERE q.id = NEW.question_id;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE TRIGGER answers_sync_question_insert_trg AFTER INSERT ON engagement.answers
      FOR EACH ROW EXECUTE FUNCTION engagement.answers_sync_question()
  `,
  sql`
    CREATE TRIGGER answers_sync_question_update_trg AFTER UPDATE OF moderation_status, deleted_at ON engagement.answers
      FOR EACH ROW WHEN (OLD.moderation_status IS DISTINCT FROM NEW.moderation_status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION engagement.answers_sync_question()
  `,
  // 10d. counters are never written by the app (insert: defaults; update: only from the triggers above, depth >= 2; V6)
  sql`
    CREATE FUNCTION engagement.counters_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION '%.% counters are trigger-maintained', TG_TABLE_SCHEMA, TG_TABLE_NAME
          USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_counters_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER questions_counters_insert_trg BEFORE INSERT ON engagement.questions
      FOR EACH ROW WHEN (NEW.upvote_count <> 0 OR NEW.answer_count <> 0 OR NEW.last_activity_at <> NEW.created_at OR NEW.accepted_answer_id IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('questions_counters_ck', 'a question starts with zero counters and no accepted answer')
  `,
  sql`
    CREATE TRIGGER questions_counters_update_trg BEFORE UPDATE ON engagement.questions
      FOR EACH ROW WHEN ((OLD.upvote_count, OLD.answer_count, OLD.last_activity_at) IS DISTINCT FROM (NEW.upvote_count, NEW.answer_count, NEW.last_activity_at))
      EXECUTE FUNCTION engagement.counters_guard()
  `,
  sql`
    CREATE TRIGGER answers_counters_insert_trg BEFORE INSERT ON engagement.answers
      FOR EACH ROW WHEN (NEW.upvote_count <> 0)
      EXECUTE FUNCTION public.forbid_row_change('answers_counters_ck', 'an answer starts with zero votes')
  `,
  sql`
    CREATE TRIGGER answers_counters_update_trg BEFORE UPDATE ON engagement.answers
      FOR EACH ROW WHEN (OLD.upvote_count IS DISTINCT FROM NEW.upvote_count)
      EXECUTE FUNCTION engagement.counters_guard()
  `,
  // 10e. timestamps (counter-only updates do not bump updated_at), immutability, accepted answer must be visible
  sql`
    CREATE TRIGGER questions_set_updated_at_trg BEFORE UPDATE ON engagement.questions
      FOR EACH ROW WHEN ((OLD.upvote_count, OLD.answer_count, OLD.last_activity_at) IS NOT DISTINCT FROM (NEW.upvote_count, NEW.answer_count, NEW.last_activity_at))
      EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER answers_set_updated_at_trg BEFORE UPDATE ON engagement.answers
      FOR EACH ROW WHEN (OLD.upvote_count IS NOT DISTINCT FROM NEW.upvote_count)
      EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER questions_immutable_trg BEFORE UPDATE ON engagement.questions
      FOR EACH ROW WHEN (
           (OLD.id, OLD.course_id, OLD.lecture_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.lecture_id, NEW.author_id, NEW.created_at)
        OR (OLD.deleted_at IS NOT NULL AND (OLD.title, OLD.body_md, OLD.moderation_status, OLD.edited_at, OLD.deleted_at)
                                           IS DISTINCT FROM (NEW.title, NEW.body_md, NEW.moderation_status, NEW.edited_at, NEW.deleted_at)))
      EXECUTE FUNCTION public.forbid_row_change('questions_immutable_ck', 'question identity is immutable; deleted content is frozen')
  `,
  sql`
    CREATE TRIGGER answers_immutable_trg BEFORE UPDATE ON engagement.answers
      FOR EACH ROW WHEN (
           (OLD.id, OLD.question_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.question_id, NEW.author_id, NEW.created_at)
        OR (OLD.deleted_at IS NOT NULL AND (OLD.body_md, OLD.moderation_status, OLD.edited_at, OLD.deleted_at)
                                           IS DISTINCT FROM (NEW.body_md, NEW.moderation_status, NEW.edited_at, NEW.deleted_at)))
      EXECUTE FUNCTION public.forbid_row_change('answers_immutable_ck', 'answer identity is immutable; deleted content is frozen')
  `,
  sql`
    CREATE FUNCTION engagement.questions_accepted_answer_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM engagement.answers a
                      WHERE a.id = NEW.accepted_answer_id AND a.question_id = NEW.id
                        AND a.deleted_at IS NULL AND a.moderation_status = 'VISIBLE') THEN
        RAISE EXCEPTION 'answer % is not a visible answer of question %', NEW.accepted_answer_id, NEW.id
          USING ERRCODE = '23514', CONSTRAINT = 'questions_accepted_answer_visible_ck';
      END IF;
      RETURN NEW;
    END
    $$
  `,
  sql`
    CREATE TRIGGER questions_accepted_answer_trg BEFORE UPDATE OF accepted_answer_id ON engagement.questions
      FOR EACH ROW WHEN (NEW.accepted_answer_id IS NOT NULL AND NEW.accepted_answer_id IS DISTINCT FROM OLD.accepted_answer_id)
      EXECUTE FUNCTION engagement.questions_accepted_answer_guard()
  `,
  sql`
    CREATE TRIGGER questions_no_truncate_trg BEFORE TRUNCATE ON engagement.questions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER answers_no_truncate_trg BEFORE TRUNCATE ON engagement.answers
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE engagement.questions IS
      'Course Q&A (D12). OPEN/RESOLVED derived from accepted_answer_id. upvote_count, answer_count, last_activity_at are trigger-maintained materialisations (documented 3NF exception, P5-D12), exact in the same statement; the app cannot write them (questions_counters_ck). Soft delete; a deleted question with answers shows a placeholder.'
  `,
  sql`COMMENT ON TABLE engagement.answers IS 'Answers. Instructor badge = author_id = course owner (read time). Hiding/deleting the accepted answer clears questions.accepted_answer_id (answers_sync_question). Soft delete only.'`,
];

// ---------------------------------------------------------------------------
// 11. engagement announcements (D18) and wishlist (D19)
// ---------------------------------------------------------------------------
const engagementCommunity = [
  sql`
    CREATE TABLE engagement.announcements (
      id         uuid        NOT NULL DEFAULT uuidv7(),
      course_id  uuid        NOT NULL,     -- soft
      author_id  uuid        NOT NULL,
      title      text        NOT NULL,     -- plain text
      body_md    text        NOT NULL,
      send_email boolean     NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL,
      deleted_by uuid        NULL,
      CONSTRAINT announcements_pk            PRIMARY KEY (id),
      CONSTRAINT announcements_author_id_fk  FOREIGN KEY (author_id)  REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT announcements_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT announcements_title_ck      CHECK (char_length(title) BETWEEN 5 AND 120 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
      CONSTRAINT announcements_body_md_ck    CHECK (char_length(body_md) BETWEEN 1 AND 10000 AND ${sql.raw(noCtrlExceptBreaks('body_md'))}),
      CONSTRAINT announcements_deleted_ck    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL OR deleted_at >= created_at))
    )
  `,
  // ListAnnouncements keyset (deleted rows filtered) AND the 30-day quota count (which includes deleted rows)
  sql`CREATE INDEX announcements_course_id_created_at_id_idx ON engagement.announcements (course_id, created_at DESC, id DESC)`,
  sql`
    CREATE TRIGGER announcements_immutable_trg BEFORE UPDATE ON engagement.announcements
      FOR EACH ROW WHEN (
           (OLD.id, OLD.course_id, OLD.author_id, OLD.title, OLD.body_md, OLD.send_email, OLD.created_at)
           IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.author_id, NEW.title, NEW.body_md, NEW.send_email, NEW.created_at)
        OR OLD.deleted_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('announcements_immutable_ck', 'announcements are immutable; only one soft delete')
  `,
  sql`
    CREATE TRIGGER announcements_no_truncate_trg BEFORE TRUNCATE ON engagement.announcements
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE engagement.announcements IS 'Instructor announcements (immutable; soft delete; no moderation flow: open point 2). <= 4 per course per rolling 30 days counted under the anno advisory lock; deleting does not refund quota.'`,
  sql`
    CREATE TABLE engagement.wishlist_items (
      user_id   uuid        NOT NULL,
      course_id uuid        NOT NULL,      -- soft
      added_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wishlist_items_pk         PRIMARY KEY (user_id, course_id),
      CONSTRAINT wishlist_items_user_id_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
    )
  `,
  // ListWishlist keyset + the 1000 cap count (index-only)
  sql`CREATE INDEX wishlist_items_user_id_added_at_course_id_idx ON engagement.wishlist_items (user_id, added_at DESC, course_id DESC)`,
  sql`
    CREATE TRIGGER wishlist_items_immutable_trg BEFORE UPDATE ON engagement.wishlist_items
      FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('wishlist_items_immutable_ck', 'wishlist items are insert/delete only')
  `,
  sql`COMMENT ON TABLE engagement.wishlist_items IS 'Private wishlist (D19). <= 1000 per user, counted under the wish advisory lock. Insert/delete only.'`,
];

// ---------------------------------------------------------------------------
// 12. engagement reports (one table per subject, real FKs, D13) + moderation log
// ---------------------------------------------------------------------------

/** The report tables. Names must follow the prefix exactly: the error map relies on them. */
const REPORT_TABLES = [
  { table: 'review_reports', subjectTable: 'reviews', subjectType: 'REVIEW' },
  { table: 'review_reply_reports', subjectTable: 'review_replies', subjectType: 'REVIEW_REPLY' },
  { table: 'question_reports', subjectTable: 'questions', subjectType: 'QUESTION' },
  { table: 'answer_reports', subjectTable: 'answers', subjectType: 'ANSWER' },
] as const;

function reportTable(t: (typeof REPORT_TABLES)[number]): RawBuilder<unknown>[] {
  const p = t.table;
  return [
    sql.raw(`
      CREATE TABLE engagement.${p} (
        id          uuid        NOT NULL DEFAULT uuidv7(),
        subject_id  uuid        NOT NULL,
        reporter_id uuid        NOT NULL,
        reason      text        NOT NULL,
        comment     text        NULL,
        status      text        NOT NULL DEFAULT 'OPEN',
        created_at  timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz NULL,
        resolved_by uuid        NULL,          -- NULL with resolved_at = AUTO (auto-hide)
        CONSTRAINT ${p}_pk                        PRIMARY KEY (id),
        CONSTRAINT ${p}_subject_id_reporter_id_uq UNIQUE (subject_id, reporter_id),
        CONSTRAINT ${p}_subject_id_fk             FOREIGN KEY (subject_id)  REFERENCES engagement.${t.subjectTable} (id) ON DELETE RESTRICT,
        CONSTRAINT ${p}_reporter_id_fk            FOREIGN KEY (reporter_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
        CONSTRAINT ${p}_resolved_by_fk            FOREIGN KEY (resolved_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
        CONSTRAINT ${p}_reason_ck                 CHECK (reason IN ('SPAM','ABUSE','HARASSMENT','OFF_TOPIC','INAPPROPRIATE','OTHER')),
        CONSTRAINT ${p}_comment_ck                CHECK (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 500 AND comment = btrim(comment)
                                                         AND ${noCtrlExceptBreaks('comment')})),
        CONSTRAINT ${p}_status_ck                 CHECK (status IN ('OPEN','ACTIONED','DISMISSED')),
        CONSTRAINT ${p}_resolved_ck               CHECK ((status = 'OPEN') = (resolved_at IS NULL)
                                                         AND (resolved_by IS NULL OR resolved_at IS NOT NULL)
                                                         AND (resolved_at IS NULL OR resolved_at >= created_at))
      )
    `),
    // Admin queue keyset per status (MergeAppend across the four tables through engagement.content_reports)
    sql.raw(
      `CREATE INDEX ${p}_status_created_at_id_idx ON engagement.${p} (status, created_at, id)`,
    ),
    sql.raw(`
      CREATE TRIGGER ${p}_own_content_trg BEFORE INSERT ON engagement.${p}
        FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('${t.subjectType}')
    `),
    sql.raw(`
      CREATE TRIGGER ${p}_insert_trg BEFORE INSERT ON engagement.${p}
        FOR EACH ROW WHEN (NEW.status <> 'OPEN')
        EXECUTE FUNCTION public.forbid_row_change('${p}_transition_ck', 'a report must be created OPEN')
    `),
    sql.raw(`
      CREATE TRIGGER ${p}_transition_trg BEFORE UPDATE ON engagement.${p}
        FOR EACH ROW WHEN ((OLD.id, OLD.subject_id, OLD.reporter_id, OLD.reason, OLD.comment, OLD.created_at)
                           IS DISTINCT FROM (NEW.id, NEW.subject_id, NEW.reporter_id, NEW.reason, NEW.comment, NEW.created_at)
                           OR OLD.status <> 'OPEN')
        EXECUTE FUNCTION public.forbid_row_change('${p}_transition_ck', 'a report is resolved once (OPEN -> ACTIONED | DISMISSED)')
    `),
    sql.raw(`
      CREATE TRIGGER ${p}_no_truncate_trg BEFORE TRUNCATE ON engagement.${p}
        FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
    `),
    sql.raw(
      `COMMENT ON TABLE engagement.${p} IS 'Reports on engagement.${t.subjectTable} (${t.subjectType}). One per reporter (repeat = idempotent). OPEN -> ACTIONED (hidden, by admin or AUTO with resolved_by NULL) | DISMISSED, once. Never deleted.'`,
    ),
  ];
}

const engagementModeration = [
  ...REPORT_TABLES.flatMap(reportTable),
  sql`
    CREATE VIEW engagement.content_reports WITH (security_invoker = true) AS
    SELECT 'REVIEW'::text       AS subject_type, id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.review_reports
    UNION ALL
    SELECT 'REVIEW_REPLY'::text, id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.review_reply_reports
    UNION ALL
    SELECT 'QUESTION'::text,     id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.question_reports
    UNION ALL
    SELECT 'ANSWER'::text,       id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.answer_reports
  `,
  sql`COMMENT ON VIEW engagement.content_reports IS 'Admin moderation queue across the four report tables (all statuses; filter status/subject_type; keyset (created_at, id)). A subject_type filter constant-folds the other branches away.'`,
  sql`
    CREATE TABLE engagement.moderation_actions (
      id           uuid        NOT NULL DEFAULT uuidv7(),
      subject_type text        NOT NULL,
      subject_id   uuid        NOT NULL,      -- polymorphic; existence verified at COMMIT (moderation_actions_subject_ck)
      action       text        NOT NULL,
      actor_id     uuid        NULL,          -- NULL = AUTO (report threshold)
      reason       text        NULL,
      occurred_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT moderation_actions_pk              PRIMARY KEY (id),
      CONSTRAINT moderation_actions_actor_id_fk     FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT moderation_actions_subject_type_ck CHECK (subject_type IN ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER')),
      CONSTRAINT moderation_actions_action_ck       CHECK (action IN ('HIDE','RESTORE','DISMISS_REPORTS')),
      CONSTRAINT moderation_actions_reason_ck       CHECK ((actor_id IS NULL AND action = 'HIDE' AND reason IS NULL)
                                                           OR (actor_id IS NOT NULL AND reason IS NOT NULL AND char_length(reason) BETWEEN 10 AND 2000
                                                               AND ${sql.raw(noCtrlExceptBreaks('reason'))}))
    )
  `,
  // Admin history per subject + the status-log guard's "latest HIDE/RESTORE" lookup
  sql`CREATE INDEX moderation_actions_subject_type_subject_id_occurred_at_idx ON engagement.moderation_actions (subject_type, subject_id, occurred_at, id)`,
  sql`
    CREATE TRIGGER moderation_actions_append_only_trg BEFORE UPDATE OR DELETE ON engagement.moderation_actions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER moderation_actions_no_truncate_trg BEFORE TRUNCATE ON engagement.moderation_actions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // moderation_status == latest HIDE/RESTORE action (checked at COMMIT, from both sides)
  sql`
    CREATE FUNCTION engagement.moderation_status_log_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_type   text;
      v_id     uuid;
      v_status text;
      v_last   text;
    BEGIN
      IF TG_TABLE_NAME = 'moderation_actions' THEN v_type := NEW.subject_type; v_id := NEW.subject_id;
      ELSE v_type := TG_ARGV[0]; v_id := NEW.id; END IF;
      CASE v_type
        WHEN 'REVIEW'       THEN SELECT moderation_status INTO v_status FROM engagement.reviews        WHERE id = v_id;
        WHEN 'REVIEW_REPLY' THEN SELECT moderation_status INTO v_status FROM engagement.review_replies WHERE id = v_id;
        WHEN 'QUESTION'     THEN SELECT moderation_status INTO v_status FROM engagement.questions      WHERE id = v_id;
        WHEN 'ANSWER'       THEN SELECT moderation_status INTO v_status FROM engagement.answers        WHERE id = v_id;
      END CASE;
      IF v_status IS NULL THEN
        RAISE EXCEPTION 'moderation action on unknown % %', v_type, v_id
          USING ERRCODE = '23514', CONSTRAINT = 'moderation_actions_subject_ck';
      END IF;
      SELECT action INTO v_last FROM engagement.moderation_actions
       WHERE subject_type = v_type AND subject_id = v_id AND action IN ('HIDE','RESTORE')
       ORDER BY occurred_at DESC, id DESC LIMIT 1;
      IF (v_status = 'HIDDEN') <> (v_last IS NOT DISTINCT FROM 'HIDE') THEN
        RAISE EXCEPTION '% % moderation_status % does not match its moderation log (%)', v_type, v_id, v_status, v_last
          USING ERRCODE = '23514', CONSTRAINT = 'moderation_status_log_ck';
      END IF;
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER moderation_actions_status_log_trg AFTER INSERT ON engagement.moderation_actions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER reviews_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.reviews
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('REVIEW')
  `,
  sql`
    CREATE CONSTRAINT TRIGGER review_replies_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.review_replies
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('REVIEW_REPLY')
  `,
  sql`
    CREATE CONSTRAINT TRIGGER questions_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.questions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('QUESTION')
  `,
  sql`
    CREATE CONSTRAINT TRIGGER answers_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.answers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('ANSWER')
  `,
  sql`COMMENT ON TABLE engagement.moderation_actions IS 'Append-only moderation audit (who/what/when/why). actor NULL = AUTO hide at ENGAGEMENT_AUTO_HIDE_REPORTS distinct open reports. Every subject moderation_status equals its latest HIDE/RESTORE (moderation_status_log_ck, COMMIT). ANNOUNCEMENT is excluded (announcements are delete-only, open point 2).'`,
];

// ---------------------------------------------------------------------------
// 13. notifications (D14), preferences, fan-out jobs (D18, P5-D11)
// ---------------------------------------------------------------------------
const notifications = [
  sql`
    CREATE TABLE notifications.notifications (
      id              uuid        NOT NULL DEFAULT uuidv7(),
      user_id         uuid        NOT NULL,
      app             text        NOT NULL,     -- audience app (STUDENT / INSTRUCTOR / ADMIN)
      kind            text        NOT NULL,     -- category = f(kind), in contracts (§5)
      payload         jsonb       NOT NULL,     -- typed snapshot (zod union by kind), <= 4 KB
      subject_type    text        NULL,
      subject_id      uuid        NULL,         -- soft; redaction key
      source_event_id uuid        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      read_at         timestamptz NULL,
      redacted_at     timestamptz NULL,
      CONSTRAINT notifications_pk                              PRIMARY KEY (id),
      CONSTRAINT notifications_user_id_kind_source_event_id_uq UNIQUE (user_id, kind, source_event_id),
      CONSTRAINT notifications_user_id_fk                      FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
      CONSTRAINT notifications_app_ck                          CHECK (app IN ('STUDENT','INSTRUCTOR','ADMIN')),
      CONSTRAINT notifications_kind_ck                         CHECK (kind IN ('QA_NEW_QUESTION','QA_NEW_ANSWER','QA_RESOLVED','REVIEW_NEW','REVIEW_REPLY',
                                                                               'ANNOUNCEMENT','CERTIFICATE_ISSUED','MEDIA_READY','MEDIA_FAILED',
                                                                               'CONTENT_HIDDEN','MODERATION_QUEUE')),
      CONSTRAINT notifications_kind_app_ck                     CHECK (
           (kind IN ('QA_NEW_QUESTION','REVIEW_NEW','MEDIA_READY','MEDIA_FAILED') AND app = 'INSTRUCTOR')
        OR (kind IN ('REVIEW_REPLY','ANNOUNCEMENT','CERTIFICATE_ISSUED')          AND app = 'STUDENT')
        OR (kind IN ('QA_NEW_ANSWER','QA_RESOLVED','CONTENT_HIDDEN')              AND app IN ('STUDENT','INSTRUCTOR'))
        OR (kind = 'MODERATION_QUEUE'                                             AND app = 'ADMIN')),
      -- contracts NOTIFICATION_KIND_META[kind].subjectType (deviation: added, see the header)
      CONSTRAINT notifications_kind_subject_ck                 CHECK (
           (kind IN ('QA_NEW_QUESTION','QA_RESOLVED')     AND subject_type = 'QUESTION')
        OR (kind = 'QA_NEW_ANSWER'                        AND subject_type = 'ANSWER')
        OR (kind = 'REVIEW_NEW'                           AND subject_type = 'REVIEW')
        OR (kind = 'REVIEW_REPLY'                         AND subject_type = 'REVIEW_REPLY')
        OR (kind = 'ANNOUNCEMENT'                         AND subject_type = 'ANNOUNCEMENT')
        OR (kind = 'CERTIFICATE_ISSUED'                   AND subject_type = 'CERTIFICATE')
        OR (kind IN ('MEDIA_READY','MEDIA_FAILED')        AND subject_type = 'MEDIA_ASSET')
        OR (kind IN ('CONTENT_HIDDEN','MODERATION_QUEUE') AND subject_type IS NULL)),
      CONSTRAINT notifications_payload_ck                      CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
      CONSTRAINT notifications_subject_ck                      CHECK ((subject_type IS NULL) = (subject_id IS NULL)
                                                                      AND (subject_type IS NULL OR subject_type IN
                                                                           ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER','ANNOUNCEMENT','CERTIFICATE','MEDIA_ASSET'))),
      -- contracts redactNotificationPayload: texts -> null and redacted: true (deviation from payload = '{}')
      CONSTRAINT notifications_redacted_ck                     CHECK ((redacted_at IS NOT NULL) = (payload @> '{"redacted": true}'::jsonb)
                                                                      AND (redacted_at IS NULL OR subject_id IS NOT NULL)),
      CONSTRAINT notifications_times_ck                        CHECK ((read_at IS NULL OR read_at >= created_at) AND (redacted_at IS NULL OR redacted_at >= created_at))
    )
  `,
  // ListNotifications keyset: WHERE user_id=$1 AND app=$2 AND (created_at,id) < (...) ORDER BY created_at DESC, id DESC
  sql`CREATE INDEX notifications_user_id_app_created_at_id_idx ON notifications.notifications (user_id, app, created_at DESC, id DESC)`,
  // unreadOnly=true list, UnreadCount (count over LIMIT 100), MarkAllRead
  sql`CREATE INDEX notifications_user_id_app_created_at_id_unread_idx ON notifications.notifications (user_id, app, created_at DESC, id DESC) WHERE read_at IS NULL`,
  // moderation-notifier redaction by subject
  sql`CREATE INDEX notifications_subject_type_subject_id_idx ON notifications.notifications (subject_type, subject_id) WHERE subject_id IS NOT NULL`,
  // NotificationRetentionJob (_07): created_at < now() - 180 days, batched
  sql`CREATE INDEX notifications_created_at_idx ON notifications.notifications (created_at)`,
  sql`
    CREATE TRIGGER notifications_immutable_trg BEFORE UPDATE ON notifications.notifications
      FOR EACH ROW WHEN (
           (OLD.id, OLD.user_id, OLD.app, OLD.kind, OLD.subject_type, OLD.subject_id, OLD.source_event_id, OLD.created_at)
           IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.app, NEW.kind, NEW.subject_type, NEW.subject_id, NEW.source_event_id, NEW.created_at)
        OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
        OR (OLD.redacted_at IS NOT NULL AND (NEW.payload, NEW.redacted_at) IS DISTINCT FROM (OLD.payload, OLD.redacted_at))
        OR (NEW.redacted_at IS NULL AND NEW.payload IS DISTINCT FROM OLD.payload))
      EXECUTE FUNCTION public.forbid_row_change('notifications_immutable_ck', 'notifications: only read once and redacted once')
  `,
  sql`COMMENT ON TABLE notifications.notifications IS 'Per-recipient inbox rows (fan-out on write, D14). Mutations: read_at once, redaction once (contracts redactNotificationPayload: texts -> null, redacted: true), retention delete after 180 days. Idempotent on (user, kind, source event).'`,
  sql`
    CREATE TABLE notifications.notification_preferences (
      user_id    uuid        NOT NULL,
      category   text        NOT NULL,
      channel    text        NOT NULL,
      enabled    boolean     NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_preferences_pk          PRIMARY KEY (user_id, category, channel),
      CONSTRAINT notification_preferences_user_id_fk  FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
      CONSTRAINT notification_preferences_category_ck CHECK (category IN ('QA','REVIEWS','ANNOUNCEMENTS','LEARNING','COURSE_BUILDING','MODERATION')),
      CONSTRAINT notification_preferences_channel_ck  CHECK (channel IN ('IN_APP','EMAIL'))
    )
  `,
  sql`
    CREATE TRIGGER notification_preferences_set_updated_at_trg BEFORE UPDATE ON notifications.notification_preferences
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`COMMENT ON TABLE notifications.notification_preferences IS 'Overrides of the code defaults per (category, channel). Locked (transactional) categories are rejected by the app (preference_locked). Unsubscribe = upsert EMAIL false.'`,
  sql`
    CREATE TABLE notifications.fanout_jobs (
      id               uuid        NOT NULL DEFAULT uuidv7(),
      kind             text        NOT NULL,
      source_event_id  uuid        NOT NULL,     -- AnnouncementPosted event id
      course_id        uuid        NOT NULL,     -- soft; snapshot from the event
      subject_id       uuid        NOT NULL,     -- soft: engagement.announcements.id
      send_email       boolean     NOT NULL,     -- snapshot from the event
      status           text        NOT NULL DEFAULT 'QUEUED',
      after_user_id    uuid        NULL,         -- keyset cursor over ACTIVE enrollees (user_id >)
      processed_count  integer     NOT NULL DEFAULT 0,
      attempts         integer     NOT NULL DEFAULT 0,
      max_attempts     integer     NOT NULL DEFAULT 5,
      run_after        timestamptz NOT NULL DEFAULT now(),
      lease_owner      text        NULL,
      lease_expires_at timestamptz NULL,
      last_error_code  text        NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      finished_at      timestamptz NULL,
      CONSTRAINT fanout_jobs_pk                 PRIMARY KEY (id),
      CONSTRAINT fanout_jobs_source_event_id_uq UNIQUE (source_event_id),
      CONSTRAINT fanout_jobs_kind_ck            CHECK (kind IN ('ANNOUNCEMENT')),
      CONSTRAINT fanout_jobs_status_ck          CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
      CONSTRAINT fanout_jobs_lease_ck           CHECK ((status = 'RUNNING') = (lease_owner IS NOT NULL)
                                                       AND (lease_owner IS NULL) = (lease_expires_at IS NULL)),
      CONSTRAINT fanout_jobs_lease_owner_ck     CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
      CONSTRAINT fanout_jobs_max_attempts_ck    CHECK (max_attempts BETWEEN 1 AND 10),
      CONSTRAINT fanout_jobs_attempts_ck        CHECK (attempts BETWEEN 0 AND max_attempts),
      CONSTRAINT fanout_jobs_queued_ck          CHECK (status <> 'QUEUED' OR attempts < max_attempts),
      CONSTRAINT fanout_jobs_processed_count_ck CHECK (processed_count >= 0),
      CONSTRAINT fanout_jobs_last_error_code_ck CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
      CONSTRAINT fanout_jobs_failed_ck          CHECK (status <> 'FAILED' OR last_error_code IS NOT NULL),
      CONSTRAINT fanout_jobs_finished_at_ck     CHECK ((finished_at IS NOT NULL) = (status IN ('DONE','FAILED')))
    )
  `,
  // Lease pickup: WHERE status='QUEUED' AND run_after <= now() ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED
  sql`CREATE INDEX fanout_jobs_run_after_id_queued_idx ON notifications.fanout_jobs (run_after, id) WHERE status = 'QUEUED'`,
  // Reaper: RUNNING with an expired lease
  sql`CREATE INDEX fanout_jobs_lease_expires_at_running_idx ON notifications.fanout_jobs (lease_expires_at) WHERE status = 'RUNNING'`,
  // NotificationRetentionJob (_07): finished jobs older than 30 days
  sql`CREATE INDEX fanout_jobs_finished_at_idx ON notifications.fanout_jobs (finished_at) WHERE finished_at IS NOT NULL`,
  sql`
    CREATE TRIGGER fanout_jobs_set_updated_at_trg BEFORE UPDATE ON notifications.fanout_jobs
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER fanout_jobs_status_insert_trg BEFORE INSERT ON notifications.fanout_jobs
      FOR EACH ROW WHEN (NEW.status <> 'QUEUED' OR NEW.attempts <> 0 OR NEW.processed_count <> 0 OR NEW.after_user_id IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('fanout_jobs_status_transition_ck', 'a fan-out job must be created QUEUED and unstarted')
  `,
  sql`
    CREATE TRIGGER fanout_jobs_status_transition_trg BEFORE UPDATE ON notifications.fanout_jobs
      FOR EACH ROW WHEN (
           (OLD.id, OLD.kind, OLD.source_event_id, OLD.course_id, OLD.subject_id, OLD.send_email, OLD.created_at)
           IS DISTINCT FROM (NEW.id, NEW.kind, NEW.source_event_id, NEW.course_id, NEW.subject_id, NEW.send_email, NEW.created_at)
        OR NEW.processed_count < OLD.processed_count
        OR (OLD.after_user_id IS NOT NULL AND (NEW.after_user_id IS NULL OR NEW.after_user_id < OLD.after_user_id))
        OR OLD.status IN ('DONE','FAILED')
        OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
              (OLD.status = 'QUEUED'  AND NEW.status = 'RUNNING')
           OR (OLD.status = 'RUNNING' AND NEW.status IN ('QUEUED','DONE','FAILED')))))
      EXECUTE FUNCTION public.forbid_row_change('fanout_jobs_status_transition_ck', 'illegal fan-out job transition (or cursor moved back)')
  `,
  sql`COMMENT ON TABLE notifications.fanout_jobs IS 'Leased announcement fan-out (P5-D11, P2 transcode-job pattern). One batch = one tx: fenced job update + <= 1000 notification inserts + cursor advance. A lease lost mid-batch rolls the batch back; UNIQUE (user, kind, source_event_id) makes a replay harmless.'`,
];

// ---------------------------------------------------------------------------
// 14. enrollment: keyset index for the fan-out (supersedes enrollments_course_id_active_idx)
// ---------------------------------------------------------------------------
const enrollmentIndex = [
  // FanoutJob: WHERE course_id=$1 AND status='ACTIVE' AND user_id > $cursor ORDER BY user_id LIMIT 1000 (and course counts, index-only)
  sql`CREATE INDEX enrollments_course_id_user_id_active_idx ON enrollment.enrollments (course_id, user_id) WHERE status = 'ACTIVE'`,
  sql`DROP INDEX enrollment.enrollments_course_id_active_idx`,
];

// ---------------------------------------------------------------------------
// 15. Privileges (prod role split; no-op in dev where udemy_app doesn't exist)
// ---------------------------------------------------------------------------
const privileges = [
  sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
        GRANT USAGE ON SCHEMA learning, engagement, notifications TO udemy_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA learning, engagement, notifications TO udemy_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.lecture_quizzes, catalog.quiz_questions, catalog.quiz_options,
                                              catalog.revision_quiz_questions, catalog.revision_quiz_options TO udemy_app;
        GRANT EXECUTE ON FUNCTION learning.fit_coverage(varbit, integer), learning.coverage_bits(varbit) TO udemy_app;
        -- append-only history / snapshots / logs
        REVOKE UPDATE, DELETE, TRUNCATE ON catalog.revision_quiz_questions, catalog.revision_quiz_options,
                                           learning.course_completions, learning.certificate_transitions,
                                           learning.quiz_attempt_selections, engagement.moderation_actions FROM udemy_app;
        -- insert/delete only
        REVOKE UPDATE, TRUNCATE ON learning.lecture_completions, engagement.question_votes, engagement.answer_votes,
                                   engagement.wishlist_items FROM udemy_app;
        -- never hard-deleted (state rows; soft delete or kept forever)
        REVOKE DELETE, TRUNCATE ON learning.lecture_progress, learning.course_activity, learning.quiz_attempts,
                                   learning.quiz_attempt_questions, learning.certificates,
                                   engagement.reviews, engagement.review_replies, engagement.course_rating_stats,
                                   engagement.questions, engagement.answers, engagement.announcements,
                                   engagement.review_reports, engagement.review_reply_reports,
                                   engagement.question_reports, engagement.answer_reports FROM udemy_app;
        -- read-only view
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON engagement.content_reports FROM udemy_app;
        -- full DML: learning.notes, notifications.notifications (retention), notification_preferences, fanout_jobs (retention),
        --           catalog.lecture_quizzes / quiz_questions / quiz_options (working copy)
      END IF;
    END
    $$
  `,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await run(db, probesAndHelpers);
  await run(db, catalogQuizType);
  await run(db, learningProgress);
  await run(db, learningQuizAttempts);
  await run(db, learningCompletionsNotes);
  await run(db, learningCertificates);
  await run(db, engagementReviews);
  await run(db, engagementQa);
  await run(db, engagementCommunity);
  await run(db, engagementModeration);
  await run(db, notifications);
  await run(db, enrollmentIndex);
  await run(db, privileges);
}

/** The 0003 body of catalog.working_copy_guard(), verbatim (down() restores it; a unit spec compares). */
const WORKING_COPY_GUARD_0003 = sql`
    CREATE OR REPLACE FUNCTION catalog.working_copy_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_course_id uuid;
      v_lecture   uuid;
      v_pending   uuid;
      v_status    text;
      v_deleted   timestamptz;
    BEGIN
      IF TG_TABLE_NAME = 'lecture_articles' THEN
        IF TG_OP = 'DELETE' THEN v_lecture := OLD.lecture_id; ELSE v_lecture := NEW.lecture_id; END IF;
        SELECT l.course_id INTO v_course_id FROM catalog.lectures l WHERE l.id = v_lecture;
      ELSIF TG_OP = 'DELETE' THEN
        v_course_id := OLD.course_id;
      ELSE
        v_course_id := NEW.course_id;
      END IF;

      IF v_course_id IS NOT NULL THEN   -- NULL: article cascade after its lecture was deleted (already checked there)
        -- FOR SHARE conflicts with Submit's UPDATE of pending_revision_id; no-op if the tx already holds FOR NO KEY UPDATE.
        SELECT c.pending_revision_id, c.status, c.deleted_at INTO v_pending, v_status, v_deleted
          FROM catalog.courses c WHERE c.id = v_course_id FOR SHARE;
        IF v_pending IS NOT NULL OR v_status = 'ARCHIVED' OR v_deleted IS NOT NULL THEN
          RAISE EXCEPTION 'course % working copy is locked (in review, archived or deleted)', v_course_id
            USING ERRCODE = '23514', CONSTRAINT = 'courses_working_copy_locked_ck',
                  SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
        END IF;
      END IF;

      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
    $$
  `;

/**
 * Down order of schema doc §1 "Down order", no CASCADE (as 0001-0004): if a later migration
 * still depends on any of these objects, fail loudly. Grants/comments/triggers/indexes go away
 * with their tables and functions; the three schemas stay (0001 owns them).
 *
 * Restoring the 0003 catalog CHECKs fails loudly if any QUIZ lecture or revision exists. That is
 * intentional: append-only revisions can't be deleted, so a down past real quiz data is a
 * data-loss decision for a human.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await run(db, [
    // 1. enrollment index
    sql`CREATE INDEX IF NOT EXISTS enrollments_course_id_active_idx ON enrollment.enrollments (course_id) WHERE status = 'ACTIVE'`,
    sql`DROP INDEX IF EXISTS enrollment.enrollments_course_id_user_id_active_idx`,
    // 2. notifications
    sql`DROP TABLE IF EXISTS notifications.fanout_jobs`,
    sql`DROP TABLE IF EXISTS notifications.notification_preferences`,
    sql`DROP TABLE IF EXISTS notifications.notifications`,
    // 3. engagement
    sql`DROP VIEW IF EXISTS engagement.content_reports`,
    sql`DROP TABLE IF EXISTS engagement.moderation_actions`,
    sql`DROP TABLE IF EXISTS engagement.answer_reports`,
    sql`DROP TABLE IF EXISTS engagement.question_reports`,
    sql`DROP TABLE IF EXISTS engagement.review_reply_reports`,
    sql`DROP TABLE IF EXISTS engagement.review_reports`,
    sql`DROP TABLE IF EXISTS engagement.wishlist_items`,
    sql`DROP TABLE IF EXISTS engagement.announcements`,
    sql`DROP TABLE IF EXISTS engagement.answer_votes`,
    sql`DROP TABLE IF EXISTS engagement.question_votes`,
    sql`ALTER TABLE IF EXISTS engagement.questions DROP CONSTRAINT IF EXISTS questions_id_accepted_answer_id_fk`,
    sql`DROP TABLE IF EXISTS engagement.answers`,
    sql`DROP TABLE IF EXISTS engagement.questions`,
    sql`DROP TABLE IF EXISTS engagement.course_rating_stats`,
    sql`DROP TABLE IF EXISTS engagement.review_replies`,
    sql`DROP TABLE IF EXISTS engagement.reviews`,
    sql`DROP FUNCTION IF EXISTS engagement.moderation_status_log_guard()`,
    sql`DROP FUNCTION IF EXISTS engagement.questions_accepted_answer_guard()`,
    sql`DROP FUNCTION IF EXISTS engagement.counters_guard()`,
    sql`DROP FUNCTION IF EXISTS engagement.answers_sync_question()`,
    sql`DROP FUNCTION IF EXISTS engagement.votes_count()`,
    sql`DROP FUNCTION IF EXISTS engagement.forbid_own_content()`,
    // 4. learning
    sql`DROP TABLE IF EXISTS learning.certificate_transitions`,
    sql`DROP TABLE IF EXISTS learning.certificates`,
    sql`DROP TABLE IF EXISTS learning.notes`,
    sql`DROP TABLE IF EXISTS learning.lecture_completions`,
    sql`DROP TABLE IF EXISTS learning.quiz_attempt_selections`,
    sql`DROP TABLE IF EXISTS learning.quiz_attempt_questions`,
    sql`DROP TABLE IF EXISTS learning.quiz_attempts`,
    sql`DROP TABLE IF EXISTS learning.course_completions`,
    sql`DROP TABLE IF EXISTS learning.course_activity`,
    sql`DROP TABLE IF EXISTS learning.lecture_progress`,
    sql`DROP FUNCTION IF EXISTS learning.certificates_status_log_guard()`,
    sql`DROP FUNCTION IF EXISTS learning.lecture_completions_quiz_guard()`,
    sql`DROP FUNCTION IF EXISTS learning.quiz_attempts_grading_guard()`,
    sql`DROP FUNCTION IF EXISTS learning.quiz_attempt_selections_guard()`,
    sql`DROP FUNCTION IF EXISTS learning.quiz_attempt_questions_guard()`,
    sql`DROP FUNCTION IF EXISTS learning.coverage_bits(varbit)`,
    sql`DROP FUNCTION IF EXISTS learning.fit_coverage(varbit, integer)`,
    // 5. catalog
    sql`DROP TRIGGER IF EXISTS revision_lectures_quiz_complete_trg ON catalog.revision_lectures`,
    sql`DROP TRIGGER IF EXISTS lectures_quiz_settings_trg ON catalog.lectures`,
    sql`DROP TABLE IF EXISTS catalog.revision_quiz_options`,
    sql`DROP TABLE IF EXISTS catalog.revision_quiz_questions`,
    sql`DROP TABLE IF EXISTS catalog.quiz_options`,
    sql`DROP TABLE IF EXISTS catalog.quiz_questions`,
    sql`DROP TABLE IF EXISTS catalog.lecture_quizzes`,
    WORKING_COPY_GUARD_0003,
    sql`
      COMMENT ON FUNCTION catalog.working_copy_guard() IS
        'BEFORE row trigger on course_bullets/sections/lectures/lecture_articles: rejects writes while the course has a pending revision, is ARCHIVED or soft-deleted (courses_working_copy_locked_ck). Backstop for invariant 1; the app still checks first to return course_in_review vs course_not_editable.'
    `,
    sql`
      ALTER TABLE catalog.revision_lectures
        DROP CONSTRAINT IF EXISTS revision_lectures_revision_id_lecture_id_type_uq,
        DROP CONSTRAINT IF EXISTS revision_lectures_quiz_pass_pct_ck,
        DROP COLUMN IF EXISTS quiz_pass_pct,
        DROP CONSTRAINT revision_lectures_type_ck,
        DROP CONSTRAINT revision_lectures_media_asset_id_ck,
        DROP CONSTRAINT revision_lectures_is_preview_ck,
        ADD CONSTRAINT revision_lectures_type_ck           CHECK (type IN ('VIDEO','ARTICLE','RESOURCE')),
        ADD CONSTRAINT revision_lectures_media_asset_id_ck CHECK ((type = 'ARTICLE') = (media_asset_id IS NULL)),
        ADD CONSTRAINT revision_lectures_is_preview_ck     CHECK (NOT is_preview OR type <> 'RESOURCE')
    `,
    sql`
      ALTER TABLE catalog.lectures
        DROP CONSTRAINT lectures_type_ck,
        DROP CONSTRAINT lectures_type_media_asset_id_ck,
        DROP CONSTRAINT lectures_type_is_preview_ck,
        ADD CONSTRAINT lectures_type_ck                CHECK (type IN ('VIDEO','ARTICLE','RESOURCE')),
        ADD CONSTRAINT lectures_type_media_asset_id_ck CHECK (type <> 'ARTICLE' OR media_asset_id IS NULL),
        ADD CONSTRAINT lectures_type_is_preview_ck     CHECK (NOT is_preview OR type <> 'RESOURCE')
    `,
    sql`DROP FUNCTION IF EXISTS catalog.revision_quiz_complete_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.revision_quiz_key_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.revision_quiz_same_tx_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.lecture_quiz_settings_guard()`,
  ]);
}
