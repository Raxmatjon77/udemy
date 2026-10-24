# P5-T1: Final schema design for migration `0005_learning_engagement_notifications`

I didn't run anything against a database and I didn't write any files. Every PG 18 behaviour this design relies on that I could not prove from memory of the docs/source is listed in §0 with a fallback; sql-ops must probe those first (P5-T4).

## What I read

- `docs/phase-5-learning-engagement-design.md` (all of it; §4, §5, §6, §9, §11 P5-T1 and §14 drive this document)
- `docs/phase-4-schema-design.md` (all of it: the style, the seq-chain transition pattern, the deferred status-log pattern, the privileges block, the error map)
- `packages/db/src/migrations/{0001_init, 0002_identity_access_users (shared helpers), 0003_catalog_media (all), 0004b_outbox_retention}`
- `infra/postgres/roles.sql` (default privileges: `udemy_app` gets DML on every new table and EXECUTE on every new function automatically; the migration only REVOKEs)
- `packages/db/src/media/quota.ts` (the two-int lock convention: the class is a 4-ASCII-char constant, e.g. `'mqta'` = `1836151905`, the second key is `hashtext(...)`)
- `packages/db/src/commerce/locks.ts`, `apps/worker/src/maintenance/advisory-lock-keys.ts` (single-bigint job keys `0x75646d79_NN`; `_06`–`_0f` free)

**Reused, not recreated:** `public.set_updated_at()` (0001), `public.forbid_append_only_mutation()` (0002), `public.forbid_row_change()` (0003), `catalog.working_copy_guard()` (0003; **replaced** with `CREATE OR REPLACE` to cover the quiz tables, and restored by `down()`), the `learning`, `engagement`, `notifications` schemas (0001).

**Naming:** `<table>_<cols>_<pk|fk|uq|ck|idx>`; trigger-raised pseudo-constraints use `_ck`; triggers `<table>_<purpose>_trg`. The longest name is `certificate_transitions_certificate_id_prev_seq_from_status_fk` (62 characters, limit 63).

**Isolation:** every learning, engagement and notifications transaction runs at **READ COMMITTED**. The Q&A answer trigger, the rating recompute, the auto-hide count, the announcement quota and the course-completion check all use lock-then-read-in-a-new-statement, which needs a fresh snapshot per statement.

**Outbox:** no change. `dbz_outbox` still publishes only `outbox.events`, insert-only (0004b). No new table is added to the publication; heavy-write tables (`lecture_progress`) generate WAL but pgoutput does not decode unpublished tables.

---

## 0. PG 18 points sql-ops MUST verify first (fail fast)

| #   | Claim                                                                                                                                                                                                                                            | Why it matters                                                                          | Fallback if false                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1  | `varbit \| varbit` works on equal lengths and **raises 22026 "cannot OR bit strings of different sizes"** on different lengths.                                                                                                                  | The flush upsert ORs old and new coverage.                                              | None needed if it errors: §8.1 never ORs unequal lengths (CASE on asset+duration, plus `learning.fit_coverage` on the input). If it silently pads or truncates instead, keep the CASE anyway.                |
| V2  | `bit_count(varbit)` exists (PG 14+ `bit_count(bit)`, varbit coerces) and returns `bigint`.                                                                                                                                                       | Watched seconds, consumption, ratio in `DirectProgressStore`.                           | `length(replace(coverage::text, '0', ''))`. Wrap it in `learning.coverage_bits(varbit)` so call sites don't change.                                                                                          |
| V3  | Explicit `text::varbit` I/O casts work, including hex input: `('x' \|\| 'a0ff')::varbit` = 16 bits, `'0101'::text::varbit`, and `repeat('0', k)::varbit`. Also check what `'x'::varbit` (empty hex) gives.                                       | The app passes coverage as text (`text[]` → varbit); `fit_coverage` pads with `repeat`. | Pass `'0'/'1'` text strings built in TS (always exactly `bucketCount` chars). For padding, use `B'0'::varbit` concatenated in a loop or `lpad`-style via `(repeat('0',k))::bit(k)`.                          |
| V4  | `substring(varbit FROM 1 FOR n)` and `varbit \|\| varbit` return `varbit`; `length(varbit)` returns the **bit** count (not bytes).                                                                                                               | `fit_coverage`, `lecture_progress_coverage_ck`.                                         | `bit(n)` cast truncates/pads on the right for `bit(n)` targets: `p_bits::bit(n)::varbit`. This is also a simpler `fit_coverage` body; prefer it if it behaves as documented.                                 |
| V5  | In `INSERT … ON CONFLICT DO UPDATE SET coverage = CASE WHEN <same asset+duration> THEN p.coverage \| EXCLUDED.coverage ELSE … END`, the OR branch is **not evaluated** when the condition is false (no constant folding of column refs).         | Asset swap mid-life.                                                                    | Split into two statements: an `UPDATE … WHERE same asset` and an upsert for the rest.                                                                                                                        |
| V6  | `pg_trigger_depth()` is `1` inside a BEFORE UPDATE trigger fired by a top-level app UPDATE and `2` when the UPDATE comes from another trigger's body.                                                                                            | `questions_counters_ck` / `answers_counters_ck` (app may never write counters).         | Drop the depth check. REVOKE UPDATE on `questions`/`answers`, GRANT column-level UPDATE on content columns, and make the counter trigger functions `SECURITY DEFINER SET search_path = pg_catalog, pg_temp`. |
| V7  | `ON CONFLICT (course_id, user_id) WHERE deleted_at IS NULL` infers the partial unique `reviews_course_id_user_id_live_uq` (same for `review_replies_review_id_live_uq`).                                                                         | Review/reply upsert.                                                                    | `ON CONFLICT ON CONSTRAINT` is impossible for indexes. Do a SELECT … FOR UPDATE then INSERT or UPDATE, catching 23505 → retry as update.                                                                     |
| V8  | `RETURNING old.rating` on `INSERT … ON CONFLICT DO UPDATE` returns NULL for an insert (PG 18 `RETURNING old/new`). The same check was P4 item 21.                                                                                                | `previousRating` in `ReviewEdited`.                                                     | `xmax = 0 AS inserted` plus a prior SELECT.                                                                                                                                                                  |
| V9  | `ALTER TABLE catalog.revision_lectures ADD CONSTRAINT … UNIQUE (revision_id, lecture_id, type)` and `ADD COLUMN` succeed on the append-only table. Row triggers don't fire on DDL; existing rows are unique because the PK is a subset.          | Composite FK of `revision_quiz_questions`.                                              | None expected.                                                                                                                                                                                               |
| V10 | STORED generated `numeric`/`smallint`/`boolean` columns using `round(numeric)` (`quiz_attempts.score_pct`, `passed`; `course_rating_stats.*`) are accepted. A generated column may not reference another, which is why expressions are repeated. | DB is the scoring and rating rounding authority.                                        | Plain columns plus CHECKs `score_pct = round(…)`, `passed = (…)`.                                                                                                                                            |

**Why not a fixed bucket count per lecture revision?** A fixed bitmap (e.g. 1024 buckets, bucket size = duration / 1024) makes every coverage the same length, so `|` can never fail. I rejected it:

- bucket size would vary per video: 14 s on a 4 h video, 0.06 s on a 1 min one;
- the plausibility budget (D3) and the 0.9 threshold would mean different things per video.

The chosen design keeps 5 s buckets (`length = ceil(duration / 5)`, written as `(duration_seconds + 4) / 5`, enforced by CHECK) and makes unequal lengths impossible at the OR site. Three layers do that:

1. `learning.fit_coverage(new, n)` normalises the app input to exactly `n` bits.
2. A `CASE` ORs only when asset **and** duration are unchanged.
3. Otherwise last-write-wins replaces the bitmap (the D3 reset).

---

## 1. Complete DDL (in migration order)

```sql
-- =====================================================================
-- 0. learning helper: coverage normaliser (single place that touches bit lengths)
-- =====================================================================
CREATE FUNCTION learning.fit_coverage(p_bits varbit, p_len integer)
RETURNS varbit
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE
         WHEN length(p_bits) >= p_len THEN substring(p_bits FROM 1 FOR p_len)        -- truncate extra trailing bits
         ELSE p_bits || repeat('0', p_len - length(p_bits))::varbit                  -- right-pad (Redis SETBIT only grows to the highest set bit)
       END;
COMMENT ON FUNCTION learning.fit_coverage(varbit, integer) IS
  'Returns p_bits truncated or right-padded with zeros to exactly p_len bits. Bit i (0-based, left to right) = 5 s bucket i = Redis SETBIT offset i. Used on every coverage write so lecture_progress_coverage_ck and the OR in the flush upsert can never see unequal lengths (V1/V4).';

-- =====================================================================
-- 1. catalog: QUIZ lecture type (D6)
-- =====================================================================
-- 1a. working-copy lectures: QUIZ has no media and is never a preview
ALTER TABLE catalog.lectures
  DROP CONSTRAINT lectures_type_ck,
  DROP CONSTRAINT lectures_type_media_asset_id_ck,
  DROP CONSTRAINT lectures_type_is_preview_ck,
  ADD CONSTRAINT lectures_type_ck                CHECK (type IN ('VIDEO','ARTICLE','RESOURCE','QUIZ')),
  ADD CONSTRAINT lectures_type_media_asset_id_ck CHECK (type NOT IN ('ARTICLE','QUIZ') OR media_asset_id IS NULL),
  ADD CONSTRAINT lectures_type_is_preview_ck     CHECK (NOT is_preview OR type IN ('VIDEO','ARTICLE'));

-- 1b. revision snapshot: QUIZ carries its pass mark; composite FK target for quiz questions
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
  ADD CONSTRAINT revision_lectures_revision_id_lecture_id_type_uq UNIQUE (revision_id, lecture_id, type);   -- FK target (type pinned to QUIZ)
COMMENT ON COLUMN catalog.revision_lectures.quiz_pass_pct IS 'QUIZ only: snapshot of lecture_quizzes.pass_pct at submit. Learning copies it into quiz_attempts.pass_pct at START.';

-- 1c. lecture_quizzes: 1:1 settings of a QUIZ lecture (lecture_articles pattern)
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
);
CREATE TRIGGER lecture_quizzes_set_updated_at_trg BEFORE UPDATE ON catalog.lecture_quizzes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE catalog.lecture_quizzes IS
  'Quiz settings of a QUIZ lecture (1:1, required: lecture_quizzes_required_ck at COMMIT). Composite FK to lectures(id, type) with lecture_type pinned to QUIZ. Cascades with the lecture.';

-- Every QUIZ lecture has exactly one settings row (checked at COMMIT: AddLecture inserts both)
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
$$;
CREATE CONSTRAINT TRIGGER lectures_quiz_settings_trg AFTER INSERT ON catalog.lectures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'QUIZ')
  EXECUTE FUNCTION catalog.lecture_quiz_settings_guard();
CREATE CONSTRAINT TRIGGER lecture_quizzes_required_trg AFTER DELETE ON catalog.lecture_quizzes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION catalog.lecture_quiz_settings_guard();

-- 1d. quiz_questions (working copy)
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
                                                          AND translate(prompt_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT quiz_questions_explanation_md_ck      CHECK (explanation_md IS NULL OR (char_length(explanation_md) BETWEEN 1 AND 2000
                                                          AND translate(explanation_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'))
);
CREATE TRIGGER quiz_questions_set_updated_at_trg BEFORE UPDATE ON catalog.quiz_questions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER quiz_questions_immutable_trg BEFORE UPDATE ON catalog.quiz_questions
  FOR EACH ROW WHEN (OLD.lecture_id IS DISTINCT FROM NEW.lecture_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.forbid_row_change('quiz_questions_immutable_ck', 'quiz_questions.lecture_id/created_at are immutable');
COMMENT ON TABLE catalog.quiz_questions IS 'Working-copy quiz questions (<= 50, positions contiguous). May be incomplete; readiness (QUIZ_EMPTY, QUIZ_QUESTION_INVALID) validates. Snapshotted into revision_quiz_questions at submit.';

-- 1e. quiz_options (working copy; replaced wholesale by PutQuizQuestionOptions)
CREATE TABLE catalog.quiz_options (
  question_id uuid     NOT NULL,
  position    smallint NOT NULL,
  text        text     NOT NULL,
  is_correct  boolean  NOT NULL DEFAULT false,
  CONSTRAINT quiz_options_pk             PRIMARY KEY (question_id, position),
  CONSTRAINT quiz_options_question_id_fk FOREIGN KEY (question_id) REFERENCES catalog.quiz_questions (id) ON DELETE CASCADE,
  CONSTRAINT quiz_options_position_ck    CHECK (position BETWEEN 0 AND 5),                    -- <= 6 options
  CONSTRAINT quiz_options_text_ck        CHECK (char_length(text) BETWEEN 1 AND 300 AND text = btrim(text) AND text !~ '[[:cntrl:]]')
);
COMMENT ON TABLE catalog.quiz_options IS 'Working-copy options of a question (0..6; readiness requires 2..6 and the correct-count rule). DELETE + INSERT on every edit; no own timestamps (quiz_questions.updated_at / courses.version cover them), as course_bullets.';

-- 1f. review lock now also covers the quiz tables (replaces the 0003 body; down() restores it)
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
$$;
CREATE TRIGGER lecture_quizzes_working_copy_trg BEFORE INSERT OR UPDATE OR DELETE ON catalog.lecture_quizzes
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();
CREATE TRIGGER quiz_questions_working_copy_trg  BEFORE INSERT OR UPDATE OR DELETE ON catalog.quiz_questions
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();
CREATE TRIGGER quiz_options_working_copy_trg    BEFORE INSERT OR UPDATE OR DELETE ON catalog.quiz_options
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();

-- 1g. immutable revision snapshot of the quiz content (the answer key)
CREATE TABLE catalog.revision_quiz_questions (
  revision_id    uuid     NOT NULL,
  lecture_id     uuid     NOT NULL,
  lecture_type   text     NOT NULL DEFAULT 'QUIZ',   -- FK helper only
  question_id    uuid     NOT NULL,                  -- stable working id (no FK; working question may be deleted later)
  position       smallint NOT NULL,
  kind           text     NOT NULL,
  prompt_md      text     NOT NULL,
  explanation_md text     NULL,
  CONSTRAINT revision_quiz_questions_pk                                     PRIMARY KEY (revision_id, question_id),   -- grading lookup + options FK target
  CONSTRAINT revision_quiz_questions_revision_id_lecture_id_position_uq     UNIQUE (revision_id, lecture_id, position), -- getQuizForAttempt / getQuizAnswerKey ordered read
  CONSTRAINT revision_quiz_questions_revision_id_lecture_id_lecture_type_fk FOREIGN KEY (revision_id, lecture_id, lecture_type)
                                                                            REFERENCES catalog.revision_lectures (revision_id, lecture_id, type) ON DELETE RESTRICT,
  CONSTRAINT revision_quiz_questions_lecture_type_ck                        CHECK (lecture_type = 'QUIZ'),
  CONSTRAINT revision_quiz_questions_position_ck                            CHECK (position BETWEEN 0 AND 49),
  CONSTRAINT revision_quiz_questions_kind_ck                                CHECK (kind IN ('SINGLE_CHOICE','MULTIPLE_CHOICE')),
  CONSTRAINT revision_quiz_questions_prompt_md_ck                           CHECK (char_length(prompt_md) BETWEEN 1 AND 2000
                                                                                   AND translate(prompt_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT revision_quiz_questions_explanation_md_ck                      CHECK (explanation_md IS NULL OR (char_length(explanation_md) BETWEEN 1 AND 2000
                                                                                   AND translate(explanation_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'))
);
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
);
CREATE TRIGGER revision_quiz_questions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_quiz_questions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_quiz_questions_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_quiz_questions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_quiz_options_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_quiz_options
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_quiz_options_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_quiz_options
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- An answer key can only be written in the SUBMIT transaction of its revision (submitted_at = now(), P2 invariant),
-- so a committed key can never gain questions or options later (append-only alone would allow that).
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
$$;
CREATE TRIGGER revision_quiz_questions_same_tx_trg BEFORE INSERT ON catalog.revision_quiz_questions
  FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_same_tx_guard();
CREATE TRIGGER revision_quiz_options_same_tx_trg BEFORE INSERT ON catalog.revision_quiz_options
  FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_same_tx_guard();

-- The key of every snapshotted question is well-formed (checked at COMMIT, design revision_quiz_options_key_ck)
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
$$;
CREATE CONSTRAINT TRIGGER revision_quiz_questions_key_trg AFTER INSERT ON catalog.revision_quiz_questions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_key_guard();   -- catches 0 options
CREATE CONSTRAINT TRIGGER revision_quiz_options_key_trg AFTER INSERT ON catalog.revision_quiz_options
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.revision_quiz_key_guard();

-- Every snapshotted QUIZ lecture has 1..50 questions with contiguous positions (QUIZ_EMPTY backstop)
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
$$;
CREATE CONSTRAINT TRIGGER revision_lectures_quiz_complete_trg AFTER INSERT ON catalog.revision_lectures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'QUIZ')
  EXECUTE FUNCTION catalog.revision_quiz_complete_guard();

COMMENT ON TABLE catalog.revision_quiz_questions IS 'Immutable quiz snapshot (D6), written only in the submit transaction. With revision_quiz_options it is the answer key: read only by CatalogFacade.getQuizAnswerKey (learning grading) and the owner/admin authoring/review routes. Append-only.';
COMMENT ON TABLE catalog.revision_quiz_options IS 'Immutable options + correctness of a snapshotted question. Key well-formedness (2..6, contiguous, SINGLE = 1 correct, MULTIPLE >= 1) checked at COMMIT (revision_quiz_options_key_ck). Append-only.';

-- =====================================================================
-- 2. learning.lecture_progress (VIDEO only; written by ProgressFlushJob / DirectProgressStore, D2/D3)
-- =====================================================================
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
) WITH (fillfactor = 80);   -- coverage/position updates touch no indexed column -> HOT updates need free page space
-- Player bootstrap, consumption, % per course: WHERE user_id=$1 AND course_id=$2
CREATE INDEX lecture_progress_user_id_course_id_idx ON learning.lecture_progress (user_id, course_id) INCLUDE (lecture_id);
CREATE TRIGGER lecture_progress_set_updated_at_trg BEFORE UPDATE ON learning.lecture_progress
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER lecture_progress_immutable_trg BEFORE UPDATE ON learning.lecture_progress
  FOR EACH ROW WHEN ((OLD.user_id, OLD.lecture_id, OLD.course_id) IS DISTINCT FROM (NEW.user_id, NEW.lecture_id, NEW.course_id))
  EXECUTE FUNCTION public.forbid_row_change('lecture_progress_immutable_ck', 'lecture_progress.user_id/lecture_id/course_id are immutable');
COMMENT ON TABLE learning.lecture_progress IS
  'Coverage bitmap + resume position per (user, VIDEO lecture). Redis is the write-behind buffer (D2); this row is at most ~15 s behind. Watched seconds = least(bit_count(coverage) * 5, duration_seconds), never stored. Coverage ORs only while media_asset_id and duration are unchanged; otherwise the newer bitmap replaces it (D3 reset). Never deleted.';

-- =====================================================================
-- 3. learning.course_activity (resume pointer)
-- =====================================================================
CREATE TABLE learning.course_activity (
  user_id          uuid        NOT NULL,
  course_id        uuid        NOT NULL,     -- soft
  last_lecture_id  uuid        NOT NULL,     -- soft
  last_accessed_at timestamptz NOT NULL,
  CONSTRAINT course_activity_pk         PRIMARY KEY (user_id, course_id),   -- bootstrap resume lookup; flush upsert arbiter
  CONSTRAINT course_activity_user_id_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
) WITH (fillfactor = 80);
COMMENT ON TABLE learning.course_activity IS 'Last lecture opened per (user, course), flushed from Redis la:{u}:{c}. Monotonic upsert (only a newer last_accessed_at wins). Never deleted.';

-- =====================================================================
-- 4. learning.course_completions (permanent, append-only, D5)
-- =====================================================================
CREATE TABLE learning.course_completions (
  user_id       uuid        NOT NULL,
  course_id     uuid        NOT NULL,      -- soft
  revision_id   uuid        NOT NULL,      -- soft: live revision whose lecture set was completed
  lecture_count integer     NOT NULL,      -- size of that live lecture set
  completed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_completions_pk               PRIMARY KEY (user_id, course_id),   -- ON CONFLICT DO NOTHING; certificates FK target
  CONSTRAINT course_completions_user_id_fk       FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT course_completions_lecture_count_ck CHECK (lecture_count BETWEEN 1 AND 5000)   -- 50 sections x 100 lectures
);
CREATE TRIGGER course_completions_append_only_trg BEFORE UPDATE OR DELETE ON learning.course_completions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER course_completions_no_truncate_trg BEFORE TRUNCATE ON learning.course_completions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE learning.course_completions IS 'First time completed lectures covered the live lecture set (D5). Written under the lrnc mutex in the same tx as the completing lecture + outbox CourseCompleted. Never changes: un-ticking or new content does not undo it.';

-- =====================================================================
-- 5. learning.quiz_attempts + questions + selections (D6)
-- =====================================================================
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
  -- DB is the scoring authority (half away from zero); generated columns cannot reference each other, hence the repetition
  score_pct      smallint    NULL GENERATED ALWAYS AS ((round(correct_count * 100.0 / question_count))::smallint) STORED,
  passed         boolean     NULL GENERATED ALWAYS AS (round(correct_count * 100.0 / question_count) >= pass_pct) STORED,
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz NULL,
  abandoned_at   timestamptz NULL,
  CONSTRAINT quiz_attempts_pk                       PRIMARY KEY (id),
  CONSTRAINT quiz_attempts_id_user_id_lecture_id_uq UNIQUE (id, user_id, lecture_id),    -- FK target: lecture_completions
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
);
-- One open attempt per (user, quiz): StartQuizAttempt resume path (23505 -> re-read the open one)
CREATE UNIQUE INDEX quiz_attempts_user_id_lecture_id_open_uq ON learning.quiz_attempts (user_id, lecture_id) WHERE status = 'IN_PROGRESS';
-- ListQuizAttempts keyset: WHERE user_id=$1 AND lecture_id=$2 AND (started_at,id) < (...) ORDER BY started_at DESC, id DESC
CREATE INDEX quiz_attempts_user_id_lecture_id_started_at_id_idx ON learning.quiz_attempts (user_id, lecture_id, started_at DESC, id DESC);
-- LearningMaintenanceJob (_08): IN_PROGRESS older than LEARNING_QUIZ_ATTEMPT_TTL_H
CREATE INDEX quiz_attempts_started_at_open_idx ON learning.quiz_attempts (started_at) WHERE status = 'IN_PROGRESS';
CREATE TRIGGER quiz_attempts_status_insert_trg BEFORE INSERT ON learning.quiz_attempts
  FOR EACH ROW WHEN (NEW.status <> 'IN_PROGRESS' OR NEW.correct_count IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('quiz_attempts_transition_ck', 'a quiz attempt must be created IN_PROGRESS without a result');
CREATE TRIGGER quiz_attempts_transition_trg BEFORE UPDATE ON learning.quiz_attempts
  FOR EACH ROW WHEN (
       (OLD.id, OLD.user_id, OLD.course_id, OLD.lecture_id, OLD.revision_id, OLD.pass_pct, OLD.question_count, OLD.started_at)
       IS DISTINCT FROM
       (NEW.id, NEW.user_id, NEW.course_id, NEW.lecture_id, NEW.revision_id, NEW.pass_pct, NEW.question_count, NEW.started_at)
    OR OLD.status <> 'IN_PROGRESS'                                                   -- terminal states are frozen
    OR NEW.status NOT IN ('SUBMITTED','ABANDONED'))                                  -- the only edges: IN_PROGRESS -> {SUBMITTED, ABANDONED}
  EXECUTE FUNCTION public.forbid_row_change('quiz_attempts_transition_ck', 'quiz attempt: only IN_PROGRESS -> SUBMITTED | ABANDONED, once; identity immutable');
CREATE TRIGGER quiz_attempts_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE learning.quiz_attempts IS 'Graded server-side against revision_id''s key (D6). score_pct/passed are generated. Never deleted. The SUBMIT update must be conditional (WHERE status = ''IN_PROGRESS''); 0 rows -> re-read (SUBMITTED: stored result; ABANDONED: attempt_not_in_progress).';

CREATE TABLE learning.quiz_attempt_questions (
  attempt_id  uuid     NOT NULL,
  question_id uuid     NOT NULL,     -- soft: catalog.revision_quiz_questions(revision_id, question_id)
  position    smallint NOT NULL,     -- display order frozen at START
  is_correct  boolean  NULL,         -- set once at SUBMIT
  CONSTRAINT quiz_attempt_questions_pk                     PRIMARY KEY (attempt_id, question_id),
  CONSTRAINT quiz_attempt_questions_attempt_id_position_uq UNIQUE (attempt_id, position),
  CONSTRAINT quiz_attempt_questions_attempt_id_fk          FOREIGN KEY (attempt_id) REFERENCES learning.quiz_attempts (id) ON DELETE RESTRICT,
  CONSTRAINT quiz_attempt_questions_position_ck            CHECK (position BETWEEN 0 AND 49)
);
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
$$;
CREATE TRIGGER quiz_attempt_questions_guard_trg BEFORE INSERT OR UPDATE ON learning.quiz_attempt_questions
  FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempt_questions_guard();
CREATE TRIGGER quiz_attempt_questions_no_delete_trg BEFORE DELETE ON learning.quiz_attempt_questions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER quiz_attempt_questions_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempt_questions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

CREATE TABLE learning.quiz_attempt_selections (
  attempt_id      uuid     NOT NULL,
  question_id     uuid     NOT NULL,
  option_position smallint NOT NULL,
  CONSTRAINT quiz_attempt_selections_pk                        PRIMARY KEY (attempt_id, question_id, option_position),
  CONSTRAINT quiz_attempt_selections_attempt_id_question_id_fk FOREIGN KEY (attempt_id, question_id)
                                                               REFERENCES learning.quiz_attempt_questions (attempt_id, question_id) ON DELETE RESTRICT,
  CONSTRAINT quiz_attempt_selections_option_position_ck        CHECK (option_position BETWEEN 0 AND 5)
);
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
$$;
CREATE TRIGGER quiz_attempt_selections_open_trg BEFORE INSERT ON learning.quiz_attempt_selections
  FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempt_selections_guard();
CREATE TRIGGER quiz_attempt_selections_append_only_trg BEFORE UPDATE OR DELETE ON learning.quiz_attempt_selections
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER quiz_attempt_selections_no_truncate_trg BEFORE TRUNCATE ON learning.quiz_attempt_selections
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- question_count / correct_count agree with the per-question rows (checked at COMMIT)
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
$$;
CREATE CONSTRAINT TRIGGER quiz_attempts_grading_trg AFTER INSERT OR UPDATE OF status, correct_count ON learning.quiz_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.quiz_attempts_grading_guard();
COMMENT ON TABLE learning.quiz_attempt_questions IS 'Questions of an attempt in display order, frozen at START (same tx). is_correct set once at SUBMIT (selected set = correct set). Never deleted.';
COMMENT ON TABLE learning.quiz_attempt_selections IS 'Selected option positions per question, inserted at SUBMIT while the attempt is IN_PROGRESS. SINGLE <= 1 selection is app-validated (kind lives in the catalog key). Append-only.';

-- =====================================================================
-- 6. learning.lecture_completions (insert/delete only, D4)
-- =====================================================================
CREATE TABLE learning.lecture_completions (
  user_id         uuid        NOT NULL,
  lecture_id      uuid        NOT NULL,     -- soft
  course_id       uuid        NOT NULL,     -- soft; = the lecture's course (§5)
  lecture_type    text        NOT NULL,     -- = catalog lecture type (immutable there; §5)
  cause           text        NOT NULL,
  revision_id     uuid        NOT NULL,     -- soft: live revision at completion
  quiz_attempt_id uuid        NULL,         -- QUIZ_PASSED: the passing attempt
  completed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lecture_completions_pk                               PRIMARY KEY (user_id, lecture_id),   -- ON CONFLICT DO NOTHING
  CONSTRAINT lecture_completions_user_id_fk                       FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT lecture_completions_quiz_attempt_id_user_id_lecture_id_fk FOREIGN KEY (quiz_attempt_id, user_id, lecture_id)
                                                                  REFERENCES learning.quiz_attempts (id, user_id, lecture_id) ON DELETE RESTRICT,
  CONSTRAINT lecture_completions_lecture_type_ck                  CHECK (lecture_type IN ('VIDEO','ARTICLE','RESOURCE','QUIZ')),
  CONSTRAINT lecture_completions_cause_ck                         CHECK (cause IN ('VIDEO_WATCHED','ARTICLE_READ','RESOURCE_OPENED','QUIZ_PASSED','MANUAL')),
  CONSTRAINT lecture_completions_cause_type_ck                    CHECK (
       (lecture_type = 'VIDEO'    AND cause = 'VIDEO_WATCHED')
    OR (lecture_type = 'ARTICLE'  AND cause IN ('ARTICLE_READ','MANUAL'))
    OR (lecture_type = 'RESOURCE' AND cause IN ('RESOURCE_OPENED','MANUAL'))
    OR (lecture_type = 'QUIZ'     AND cause = 'QUIZ_PASSED')),
  CONSTRAINT lecture_completions_quiz_attempt_ck                  CHECK ((cause = 'QUIZ_PASSED') = (quiz_attempt_id IS NOT NULL))
);
-- completed ∩ live ids per course (bootstrap, %, consumption, review gate, course-completion check), index-only
CREATE INDEX lecture_completions_user_id_course_id_idx ON learning.lecture_completions (user_id, course_id) INCLUDE (lecture_id);
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
$$;
CREATE TRIGGER lecture_completions_quiz_trg BEFORE INSERT ON learning.lecture_completions
  FOR EACH ROW WHEN (NEW.quiz_attempt_id IS NOT NULL) EXECUTE FUNCTION learning.lecture_completions_quiz_guard();
CREATE TRIGGER lecture_completions_immutable_trg BEFORE UPDATE ON learning.lecture_completions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('lecture_completions_immutable_ck', 'lecture completions are insert/delete only');
COMMENT ON TABLE learning.lecture_completions IS 'Current completion state per (user, lecture). DELETE = un-complete (history lives in the LectureCompleted / LectureCompletionCleared events). Insert/delete only. Every completion write takes the lrnc (user, course) advisory lock first.';

-- =====================================================================
-- 7. learning.notes
-- =====================================================================
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
  CONSTRAINT notes_body_md_ck          CHECK (char_length(body_md) BETWEEN 1 AND 2000
                                              AND translate(body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT notes_times_ck            CHECK (updated_at >= created_at)
);
-- ListNotes keyset per course + the 500/(user, course) count (index-only)
CREATE INDEX notes_user_id_course_id_created_at_id_idx  ON learning.notes (user_id, course_id, created_at DESC, id DESC);
-- ListNotes filtered by lectureId, same keyset
CREATE INDEX notes_user_id_lecture_id_created_at_id_idx ON learning.notes (user_id, lecture_id, created_at DESC, id DESC);
CREATE TRIGGER notes_set_updated_at_trg BEFORE UPDATE ON learning.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER notes_immutable_trg BEFORE UPDATE ON learning.notes
  FOR EACH ROW WHEN ((OLD.id, OLD.user_id, OLD.course_id, OLD.lecture_id, OLD.created_at)
                     IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.course_id, NEW.lecture_id, NEW.created_at))
  EXECUTE FUNCTION public.forbid_row_change('notes_immutable_ck', 'notes.user_id/course_id/lecture_id/created_at are immutable');
COMMENT ON TABLE learning.notes IS 'Private learner notes. <= 500 per (user, course): counted under the note advisory lock (§10). Hard-deleted by the owner (allowed after a revoke, D9).';

-- =====================================================================
-- 8. learning.certificates + certificate_transitions (D7)
-- =====================================================================
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
  CONSTRAINT certificates_public_code_uq       UNIQUE (public_code),                 -- VerifyCertificate
  CONSTRAINT certificates_user_id_course_id_uq UNIQUE (user_id, course_id),          -- issue idempotency; ListMyCertificates; admin per-user tab
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
);
-- LearningMaintenanceJob (_08): re-render PDFs still missing after 10 min
CREATE INDEX certificates_issued_at_pdf_pending_idx ON learning.certificates (issued_at) WHERE pdf_rendered_at IS NULL;
CREATE TRIGGER certificates_set_updated_at_trg BEFORE UPDATE ON learning.certificates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER certificates_immutable_trg BEFORE UPDATE ON learning.certificates
  FOR EACH ROW WHEN (
       (OLD.id, OLD.public_code, OLD.user_id, OLD.course_id, OLD.revision_id, OLD.recipient_name, OLD.course_title,
        OLD.instructor_name, OLD.issued_at, OLD.source_event_id)
       IS DISTINCT FROM
       (NEW.id, NEW.public_code, NEW.user_id, NEW.course_id, NEW.revision_id, NEW.recipient_name, NEW.course_title,
        NEW.instructor_name, NEW.issued_at, NEW.source_event_id)
    OR (OLD.pdf_rendered_at IS NOT NULL AND (NEW.pdf_object_key, NEW.pdf_rendered_at) IS DISTINCT FROM (OLD.pdf_object_key, OLD.pdf_rendered_at)))
  EXECUTE FUNCTION public.forbid_row_change('certificates_immutable_ck', 'certificate content is immutable; the PDF is recorded once');
CREATE TRIGGER certificates_no_truncate_trg BEFORE TRUNCATE ON learning.certificates
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

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
  CONSTRAINT certificate_transitions_pk                                 PRIMARY KEY (certificate_id, seq),
  CONSTRAINT certificate_transitions_certificate_id_seq_to_status_uq    UNIQUE (certificate_id, seq, to_status),
  CONSTRAINT certificate_transitions_certificate_id_prev_seq_from_status_fk
                                                                        FOREIGN KEY (certificate_id, prev_seq, from_status)
                                                                        REFERENCES learning.certificate_transitions (certificate_id, seq, to_status) ON DELETE RESTRICT,
  CONSTRAINT certificate_transitions_certificate_id_fk                  FOREIGN KEY (certificate_id) REFERENCES learning.certificates (id) ON DELETE RESTRICT,
  CONSTRAINT certificate_transitions_actor_id_fk                        FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT certificate_transitions_seq_ck                             CHECK (seq >= 1),
  CONSTRAINT certificate_transitions_root_ck                            CHECK ((seq = 1) = (from_status IS NULL) AND (seq = 1) = (action = 'ISSUE')),
  CONSTRAINT certificate_transitions_edge_ck                            CHECK (
       (action = 'ISSUE'     AND from_status IS NULL      AND to_status = 'ACTIVE'  AND cause = 'COURSE_COMPLETED')
    OR (action = 'REVOKE'    AND from_status = 'ACTIVE'   AND to_status = 'REVOKED' AND cause IN ('ENROLLMENT_REVOKED','ADMIN'))
    OR (action = 'REINSTATE' AND from_status = 'REVOKED'  AND to_status = 'ACTIVE'  AND cause IN ('ENROLLMENT_REGRANTED','ADMIN'))),
  CONSTRAINT certificate_transitions_actor_ck                           CHECK ((cause = 'ADMIN') = (actor_id IS NOT NULL)
                                                                               AND (cause = 'ADMIN') = (source_event_id IS NULL)),
  CONSTRAINT certificate_transitions_reason_ck                          CHECK ((cause = 'ADMIN') = (reason IS NOT NULL)
                                                                               AND (reason IS NULL OR (char_length(reason) BETWEEN 10 AND 2000
                                                                                   AND translate(reason, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')))
);
CREATE TRIGGER certificate_transitions_append_only_trg BEFORE UPDATE OR DELETE ON learning.certificate_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER certificate_transitions_no_truncate_trg BEFORE TRUNCATE ON learning.certificate_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- status/issued_at/revoked_at == log; an automatic reinstate may only undo an automatic revoke (checked at COMMIT)
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
$$;
CREATE CONSTRAINT TRIGGER certificates_status_log_trg AFTER INSERT OR UPDATE OF status, issued_at, revoked_at ON learning.certificates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.certificates_status_log_guard();
CREATE CONSTRAINT TRIGGER certificate_transitions_status_log_trg AFTER INSERT ON learning.certificate_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.certificates_status_log_guard();
COMMENT ON TABLE learning.certificates IS
  'One certificate per course completion (FK). Names/title are point-in-time snapshots. status/issued_at/revoked_at materialise certificate_transitions (certificates_status_log_ck, COMMIT). PDF at the deterministic key certificates/{id}/v1.pdf, recorded once. Never deleted.';
COMMENT ON TABLE learning.certificate_transitions IS 'Append-only certificate log (ISSUE/REVOKE/REINSTATE, cause, admin actor + reason). Linear chain via seq (P4 pattern), max(seq)+1 under the certificate row lock.';

-- =====================================================================
-- 9. engagement.reviews + review_replies + course_rating_stats (D10, D11)
-- =====================================================================
CREATE TABLE engagement.reviews (
  id                uuid        NOT NULL DEFAULT uuidv7(),
  course_id         uuid        NOT NULL,      -- soft
  user_id           uuid        NOT NULL,
  rating            smallint    NOT NULL,
  body              text        NULL,          -- plain text (D22)
  moderation_status text        NOT NULL DEFAULT 'VISIBLE',   -- materialises moderation_actions (moderation_status_log_ck)
  suspended_at      timestamptz NULL,          -- enrollment revoked (worker sync, D9)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz NULL,
  deleted_at        timestamptz NULL,
  deleted_by        uuid        NULL,
  CONSTRAINT reviews_pk                PRIMARY KEY (id),
  CONSTRAINT reviews_user_id_fk        FOREIGN KEY (user_id)    REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT reviews_deleted_by_fk     FOREIGN KEY (deleted_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT reviews_rating_ck         CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT reviews_body_ck           CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body) AND body !~ '[[:cntrl:]]')),
  CONSTRAINT reviews_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
  CONSTRAINT reviews_deleted_ck        CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT reviews_times_ck          CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                              AND (deleted_at IS NULL OR deleted_at >= created_at))
);
-- One live review per (course, user); the upsert arbiter; "my review" lookup; review-enrollment-sync lookup
CREATE UNIQUE INDEX reviews_course_id_user_id_live_uq ON engagement.reviews (course_id, user_id) WHERE deleted_at IS NULL;
-- ListPublicReviews keyset (no rating filter)
CREATE INDEX reviews_course_id_created_at_id_public_idx ON engagement.reviews (course_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL;
-- ListPublicReviews with ?rating= keyset AND the rating recompute (index-only GROUP BY rating per course)
CREATE INDEX reviews_course_id_rating_created_at_id_public_idx ON engagement.reviews (course_id, rating, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL;
-- ListCourseReviewsForInstructor: all non-deleted (hidden + suspended flagged)
CREATE INDEX reviews_course_id_created_at_id_live_idx ON engagement.reviews (course_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER reviews_set_updated_at_trg BEFORE UPDATE ON engagement.reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER reviews_immutable_trg BEFORE UPDATE ON engagement.reviews
  FOR EACH ROW WHEN ((OLD.id, OLD.course_id, OLD.user_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.user_id, NEW.created_at)
                     OR OLD.deleted_at IS NOT NULL)                                     -- deleted is terminal
  EXECUTE FUNCTION public.forbid_row_change('reviews_immutable_ck', 'review identity is immutable; a deleted review is frozen');
CREATE TRIGGER reviews_no_truncate_trg BEFORE TRUNCATE ON engagement.reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE engagement.reviews IS 'Course reviews (D10). PUBLISHED (counted, public) = VISIBLE AND suspended_at IS NULL AND deleted_at IS NULL. Soft delete only; a new review is allowed after a delete. Eligibility (ACTIVE enrollment, >= 1 completed lecture, not the owner) is app-checked (cross-schema).';

CREATE TABLE engagement.review_replies (
  id                uuid        NOT NULL DEFAULT uuidv7(),
  review_id         uuid        NOT NULL,
  author_id         uuid        NOT NULL,      -- = course owner (app; ownership is immutable)
  body              text        NOT NULL,      -- plain text
  moderation_status text        NOT NULL DEFAULT 'VISIBLE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz NULL,
  deleted_at        timestamptz NULL,
  CONSTRAINT review_replies_pk                   PRIMARY KEY (id),
  CONSTRAINT review_replies_review_id_fk         FOREIGN KEY (review_id) REFERENCES engagement.reviews (id) ON DELETE RESTRICT,
  CONSTRAINT review_replies_author_id_fk         FOREIGN KEY (author_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT review_replies_body_ck              CHECK (char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body) AND body !~ '[[:cntrl:]]'),
  CONSTRAINT review_replies_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
  CONSTRAINT review_replies_times_ck             CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                                        AND (deleted_at IS NULL OR deleted_at >= created_at))
);
-- One live reply per review (D10); upsert arbiter; reply lookup for the review page (batch by review_id = ANY)
CREATE UNIQUE INDEX review_replies_review_id_live_uq ON engagement.review_replies (review_id) WHERE deleted_at IS NULL;
CREATE TRIGGER review_replies_set_updated_at_trg BEFORE UPDATE ON engagement.review_replies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER review_replies_immutable_trg BEFORE UPDATE ON engagement.review_replies
  FOR EACH ROW WHEN ((OLD.id, OLD.review_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.review_id, NEW.author_id, NEW.created_at)
                     OR OLD.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('review_replies_immutable_ck', 'reply identity is immutable; a deleted reply is frozen');
CREATE TRIGGER review_replies_no_truncate_trg BEFORE TRUNCATE ON engagement.review_replies
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE engagement.review_replies IS 'Instructor reply to a review (<= 1 live). Own uuid PK (not review_id) so a deleted reply keeps its reports and moderation history and a new reply gets a new identity.';

CREATE TABLE engagement.course_rating_stats (
  course_id      uuid          NOT NULL,     -- soft
  count_1        integer       NOT NULL DEFAULT 0,
  count_2        integer       NOT NULL DEFAULT 0,
  count_3        integer       NOT NULL DEFAULT 0,
  count_4        integer       NOT NULL DEFAULT 0,
  count_5        integer       NOT NULL DEFAULT 0,
  -- derived from the histogram (generated: cannot drift; generated columns can't reference each other, hence repetition)
  review_count   integer       NOT NULL GENERATED ALWAYS AS (count_1 + count_2 + count_3 + count_4 + count_5) STORED,
  rating_sum     bigint        NOT NULL GENERATED ALWAYS AS
                   (count_1::bigint + 2 * count_2::bigint + 3 * count_3::bigint + 4 * count_4::bigint + 5 * count_5::bigint) STORED,
  average_rating numeric(2,1)  NULL GENERATED ALWAYS AS (
                   CASE WHEN count_1 + count_2 + count_3 + count_4 + count_5 > 0
                        THEN round((count_1::bigint + 2 * count_2::bigint + 3 * count_3::bigint + 4 * count_4::bigint + 5 * count_5::bigint)::numeric
                                   / (count_1 + count_2 + count_3 + count_4 + count_5), 1)
                   END) STORED,
  recomputed_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT course_rating_stats_pk        PRIMARY KEY (course_id),   -- GetRatings batch (course_id = ANY), recompute lock
  CONSTRAINT course_rating_stats_counts_ck CHECK (count_1 >= 0 AND count_2 >= 0 AND count_3 >= 0 AND count_4 >= 0 AND count_5 >= 0)
);
COMMENT ON TABLE engagement.course_rating_stats IS 'Read model (D11), written only by the worker: the whole histogram is recomputed from PUBLISHED reviews under SELECT ... FOR UPDATE of this row (§8.4). Totals and the 1-dp average are generated. A missing row = {count: 0}.';

-- =====================================================================
-- 10. engagement Q&A: questions, answers, votes (D12; trigger-maintained counters, P5-D12)
-- =====================================================================
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
  CONSTRAINT questions_body_md_ck           CHECK (char_length(body_md) BETWEEN 1 AND 10000
                                                   AND translate(body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT questions_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
  CONSTRAINT questions_counts_ck            CHECK (upvote_count >= 0 AND answer_count >= 0),
  CONSTRAINT questions_times_ck             CHECK (last_activity_at >= created_at AND updated_at >= created_at
                                                   AND (edited_at IS NULL OR edited_at >= created_at)
                                                   AND (deleted_at IS NULL OR deleted_at >= created_at))
);
-- ListQuestions sort=recent: WHERE course_id=$1 AND <visible> AND (last_activity_at,id) < (...) ORDER BY last_activity_at DESC, id DESC
CREATE INDEX questions_course_id_last_activity_at_id_idx ON engagement.questions (course_id, last_activity_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE';
-- ListQuestions ?lectureId= (recent); other sorts with a lecture filter sort this small subset
CREATE INDEX questions_course_id_lecture_id_last_activity_at_id_idx ON engagement.questions (course_id, lecture_id, last_activity_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE';
-- sort=top (unstable keyset accepted, Q12; the client de-dupes by id)
CREATE INDEX questions_course_id_upvote_count_id_idx ON engagement.questions (course_id, upvote_count DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE';
-- sort=unanswered + InstructorQaInbox status=unanswered (course_id = ANY(<=100))
CREATE INDEX questions_course_id_created_at_id_unanswered_idx ON engagement.questions (course_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND answer_count = 0;
-- q= course-scoped title search (BitmapAnd with a course index)
CREATE INDEX questions_title_trgm_idx ON engagement.questions USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE';

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
  CONSTRAINT answers_body_md_ck           CHECK (char_length(body_md) BETWEEN 1 AND 10000
                                                 AND translate(body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT answers_moderation_status_ck CHECK (moderation_status IN ('VISIBLE','HIDDEN')),
  CONSTRAINT answers_upvote_count_ck      CHECK (upvote_count >= 0),
  CONSTRAINT answers_times_ck             CHECK (updated_at >= created_at AND (edited_at IS NULL OR edited_at >= created_at)
                                                 AND (deleted_at IS NULL OR deleted_at >= created_at))
);
-- Answers page keyset (oldest first) + the counter recompute in answers_sync_question()
CREATE INDEX answers_question_id_created_at_id_idx ON engagement.answers (question_id, created_at, id);

ALTER TABLE engagement.questions
  ADD CONSTRAINT questions_id_accepted_answer_id_fk FOREIGN KEY (id, accepted_answer_id)
      REFERENCES engagement.answers (question_id, id) ON DELETE RESTRICT;      -- MATCH SIMPLE: skipped while NULL

CREATE TABLE engagement.question_votes (
  subject_id uuid        NOT NULL,    -- questions.id
  user_id    uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_votes_pk            PRIMARY KEY (subject_id, user_id),  -- Vote = ON CONFLICT DO NOTHING; "my votes" on a page (subject_id = ANY, user_id)
  CONSTRAINT question_votes_subject_id_fk FOREIGN KEY (subject_id) REFERENCES engagement.questions (id) ON DELETE RESTRICT,
  CONSTRAINT question_votes_user_id_fk    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
);
CREATE TABLE engagement.answer_votes (
  subject_id uuid        NOT NULL,    -- answers.id
  user_id    uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answer_votes_pk            PRIMARY KEY (subject_id, user_id),
  CONSTRAINT answer_votes_subject_id_fk FOREIGN KEY (subject_id) REFERENCES engagement.answers (id) ON DELETE RESTRICT,
  CONSTRAINT answer_votes_user_id_fk    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
);
CREATE TRIGGER question_votes_immutable_trg BEFORE UPDATE ON engagement.question_votes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('question_votes_immutable_ck', 'votes are insert/delete only');
CREATE TRIGGER answer_votes_immutable_trg BEFORE UPDATE ON engagement.answer_votes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('answer_votes_immutable_ck', 'votes are insert/delete only');

-- 10a. "not your own" backstop for votes and reports (TG_ARGV[0] = subject type)
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
$$;
CREATE TRIGGER question_votes_own_content_trg BEFORE INSERT ON engagement.question_votes
  FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('QUESTION');
CREATE TRIGGER answer_votes_own_content_trg BEFORE INSERT ON engagement.answer_votes
  FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('ANSWER');

-- 10b. upvote counters (delta: exact under concurrency, the row lock serialises and EPQ re-reads the new count)
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
$$;
CREATE TRIGGER question_votes_count_trg AFTER INSERT OR DELETE ON engagement.question_votes
  FOR EACH ROW EXECUTE FUNCTION engagement.votes_count();
CREATE TRIGGER answer_votes_count_trg AFTER INSERT OR DELETE ON engagement.answer_votes
  FOR EACH ROW EXECUTE FUNCTION engagement.votes_count();

-- 10c. answer_count / last_activity_at / accepted-answer clearing (recompute under the question row lock)
CREATE FUNCTION engagement.answers_sync_question() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- lock first, THEN count in a new statement (READ COMMITTED: sees answers committed while we waited; P2 asset_usages pattern)
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
$$;
CREATE TRIGGER answers_sync_question_insert_trg AFTER INSERT ON engagement.answers
  FOR EACH ROW EXECUTE FUNCTION engagement.answers_sync_question();
CREATE TRIGGER answers_sync_question_update_trg AFTER UPDATE OF moderation_status, deleted_at ON engagement.answers
  FOR EACH ROW WHEN (OLD.moderation_status IS DISTINCT FROM NEW.moderation_status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION engagement.answers_sync_question();

-- 10d. counters are never written by the app (insert: defaults; update: only from the triggers above, depth >= 2; V6)
CREATE FUNCTION engagement.counters_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '%.% counters are trigger-maintained', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_counters_ck';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER questions_counters_insert_trg BEFORE INSERT ON engagement.questions
  FOR EACH ROW WHEN (NEW.upvote_count <> 0 OR NEW.answer_count <> 0 OR NEW.last_activity_at <> NEW.created_at OR NEW.accepted_answer_id IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('questions_counters_ck', 'a question starts with zero counters and no accepted answer');
CREATE TRIGGER questions_counters_update_trg BEFORE UPDATE ON engagement.questions
  FOR EACH ROW WHEN ((OLD.upvote_count, OLD.answer_count, OLD.last_activity_at) IS DISTINCT FROM (NEW.upvote_count, NEW.answer_count, NEW.last_activity_at))
  EXECUTE FUNCTION engagement.counters_guard();
CREATE TRIGGER answers_counters_insert_trg BEFORE INSERT ON engagement.answers
  FOR EACH ROW WHEN (NEW.upvote_count <> 0)
  EXECUTE FUNCTION public.forbid_row_change('answers_counters_ck', 'an answer starts with zero votes');
CREATE TRIGGER answers_counters_update_trg BEFORE UPDATE ON engagement.answers
  FOR EACH ROW WHEN (OLD.upvote_count IS DISTINCT FROM NEW.upvote_count)
  EXECUTE FUNCTION engagement.counters_guard();

-- 10e. timestamps (counter-only updates do not bump updated_at), immutability, accepted answer must be visible
CREATE TRIGGER questions_set_updated_at_trg BEFORE UPDATE ON engagement.questions
  FOR EACH ROW WHEN ((OLD.upvote_count, OLD.answer_count, OLD.last_activity_at) IS NOT DISTINCT FROM (NEW.upvote_count, NEW.answer_count, NEW.last_activity_at))
  EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER answers_set_updated_at_trg BEFORE UPDATE ON engagement.answers
  FOR EACH ROW WHEN (OLD.upvote_count IS NOT DISTINCT FROM NEW.upvote_count)
  EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER questions_immutable_trg BEFORE UPDATE ON engagement.questions
  FOR EACH ROW WHEN (
       (OLD.id, OLD.course_id, OLD.lecture_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.lecture_id, NEW.author_id, NEW.created_at)
    OR (OLD.deleted_at IS NOT NULL AND (OLD.title, OLD.body_md, OLD.moderation_status, OLD.edited_at, OLD.deleted_at)
                                       IS DISTINCT FROM (NEW.title, NEW.body_md, NEW.moderation_status, NEW.edited_at, NEW.deleted_at)))
  EXECUTE FUNCTION public.forbid_row_change('questions_immutable_ck', 'question identity is immutable; deleted content is frozen');
CREATE TRIGGER answers_immutable_trg BEFORE UPDATE ON engagement.answers
  FOR EACH ROW WHEN (
       (OLD.id, OLD.question_id, OLD.author_id, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.question_id, NEW.author_id, NEW.created_at)
    OR (OLD.deleted_at IS NOT NULL AND (OLD.body_md, OLD.moderation_status, OLD.edited_at, OLD.deleted_at)
                                       IS DISTINCT FROM (NEW.body_md, NEW.moderation_status, NEW.edited_at, NEW.deleted_at)))
  EXECUTE FUNCTION public.forbid_row_change('answers_immutable_ck', 'answer identity is immutable; deleted content is frozen');
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
$$;
CREATE TRIGGER questions_accepted_answer_trg BEFORE UPDATE OF accepted_answer_id ON engagement.questions
  FOR EACH ROW WHEN (NEW.accepted_answer_id IS NOT NULL AND NEW.accepted_answer_id IS DISTINCT FROM OLD.accepted_answer_id)
  EXECUTE FUNCTION engagement.questions_accepted_answer_guard();
CREATE TRIGGER questions_no_truncate_trg BEFORE TRUNCATE ON engagement.questions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER answers_no_truncate_trg BEFORE TRUNCATE ON engagement.answers
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE engagement.questions IS
  'Course Q&A (D12). OPEN/RESOLVED derived from accepted_answer_id. upvote_count, answer_count, last_activity_at are trigger-maintained materialisations (documented 3NF exception, P5-D12), exact in the same statement; the app cannot write them (questions_counters_ck). Soft delete; a deleted question with answers shows a placeholder.';
COMMENT ON TABLE engagement.answers IS 'Answers. Instructor badge = author_id = course owner (read time). Hiding/deleting the accepted answer clears questions.accepted_answer_id (answers_sync_question). Soft delete only.';

-- =====================================================================
-- 11. engagement.announcements (D18) and wishlist_items (D19)
-- =====================================================================
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
  CONSTRAINT announcements_body_md_ck    CHECK (char_length(body_md) BETWEEN 1 AND 10000
                                                AND translate(body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),
  CONSTRAINT announcements_deleted_ck    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL OR deleted_at >= created_at))
);
-- ListAnnouncements keyset (deleted rows filtered; they are rare) AND the 30-day quota count, which deliberately includes deleted rows
CREATE INDEX announcements_course_id_created_at_id_idx ON engagement.announcements (course_id, created_at DESC, id DESC);
CREATE TRIGGER announcements_immutable_trg BEFORE UPDATE ON engagement.announcements
  FOR EACH ROW WHEN (
       (OLD.id, OLD.course_id, OLD.author_id, OLD.title, OLD.body_md, OLD.send_email, OLD.created_at)
       IS DISTINCT FROM (NEW.id, NEW.course_id, NEW.author_id, NEW.title, NEW.body_md, NEW.send_email, NEW.created_at)
    OR OLD.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('announcements_immutable_ck', 'announcements are immutable; only one soft delete');
CREATE TRIGGER announcements_no_truncate_trg BEFORE TRUNCATE ON engagement.announcements
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE engagement.announcements IS 'Instructor announcements (immutable; soft delete). <= 4 per course per rolling 30 days counted under the anno advisory lock; deleting does not refund quota.';

CREATE TABLE engagement.wishlist_items (
  user_id   uuid        NOT NULL,
  course_id uuid        NOT NULL,      -- soft
  added_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wishlist_items_pk         PRIMARY KEY (user_id, course_id),   -- add = ON CONFLICT DO NOTHING; GetWishlistStates (course_id = ANY)
  CONSTRAINT wishlist_items_user_id_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
);
-- ListWishlist keyset + the 1000 cap count (index-only)
CREATE INDEX wishlist_items_user_id_added_at_course_id_idx ON engagement.wishlist_items (user_id, added_at DESC, course_id DESC);
CREATE TRIGGER wishlist_items_immutable_trg BEFORE UPDATE ON engagement.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('wishlist_items_immutable_ck', 'wishlist items are insert/delete only');
COMMENT ON TABLE engagement.wishlist_items IS 'Private wishlist (D19). <= 1000 per user, counted under the wish advisory lock. Insert/delete only.';

-- =====================================================================
-- 12. engagement reports (per subject, real FKs, D13) + moderation log
-- =====================================================================
-- (identical shape x4; shown once for reviews, then the three others)
CREATE TABLE engagement.review_reports (
  id          uuid        NOT NULL DEFAULT uuidv7(),
  subject_id  uuid        NOT NULL,
  reporter_id uuid        NOT NULL,
  reason      text        NOT NULL,
  comment     text        NULL,
  status      text        NOT NULL DEFAULT 'OPEN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  resolved_by uuid        NULL,          -- NULL with resolved_at = AUTO (auto-hide)
  CONSTRAINT review_reports_pk                      PRIMARY KEY (id),
  CONSTRAINT review_reports_subject_id_reporter_id_uq UNIQUE (subject_id, reporter_id),   -- one report per reporter (repeat = 200); open-count per subject
  CONSTRAINT review_reports_subject_id_fk           FOREIGN KEY (subject_id)  REFERENCES engagement.reviews (id) ON DELETE RESTRICT,
  CONSTRAINT review_reports_reporter_id_fk          FOREIGN KEY (reporter_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT review_reports_resolved_by_fk          FOREIGN KEY (resolved_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT review_reports_reason_ck               CHECK (reason IN ('SPAM','ABUSE','HARASSMENT','OFF_TOPIC','INAPPROPRIATE','OTHER')),
  CONSTRAINT review_reports_comment_ck              CHECK (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 500 AND comment = btrim(comment) AND comment !~ '[[:cntrl:]]')),
  CONSTRAINT review_reports_status_ck               CHECK (status IN ('OPEN','ACTIONED','DISMISSED')),
  CONSTRAINT review_reports_resolved_ck             CHECK ((status = 'OPEN') = (resolved_at IS NULL)
                                                           AND (resolved_by IS NULL OR resolved_at IS NOT NULL)
                                                           AND (resolved_at IS NULL OR resolved_at >= created_at))
);
-- Admin queue keyset per status (MergeAppend across the four tables through engagement.content_reports)
CREATE INDEX review_reports_status_created_at_id_idx ON engagement.review_reports (status, created_at, id);
CREATE TRIGGER review_reports_own_content_trg BEFORE INSERT ON engagement.review_reports
  FOR EACH ROW EXECUTE FUNCTION engagement.forbid_own_content('REVIEW');
CREATE TRIGGER review_reports_insert_trg BEFORE INSERT ON engagement.review_reports
  FOR EACH ROW WHEN (NEW.status <> 'OPEN')
  EXECUTE FUNCTION public.forbid_row_change('review_reports_transition_ck', 'a report must be created OPEN');
CREATE TRIGGER review_reports_transition_trg BEFORE UPDATE ON engagement.review_reports
  FOR EACH ROW WHEN ((OLD.id, OLD.subject_id, OLD.reporter_id, OLD.reason, OLD.comment, OLD.created_at)
                     IS DISTINCT FROM (NEW.id, NEW.subject_id, NEW.reporter_id, NEW.reason, NEW.comment, NEW.created_at)
                     OR OLD.status <> 'OPEN')
  EXECUTE FUNCTION public.forbid_row_change('review_reports_transition_ck', 'a report is resolved once (OPEN -> ACTIONED | DISMISSED)');
CREATE TRIGGER review_reports_no_truncate_trg BEFORE TRUNCATE ON engagement.review_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- engagement.review_reply_reports : same columns/constraints/indexes/triggers with prefix review_reply_reports_,
--   subject FK -> engagement.review_replies (id), own-content arg 'REVIEW_REPLY'
-- engagement.question_reports     : prefix question_reports_, subject FK -> engagement.questions (id), arg 'QUESTION'
-- engagement.answer_reports       : prefix answer_reports_,   subject FK -> engagement.answers (id),   arg 'ANSWER'
-- (sql-ops: generate the three from one TS template; names must follow the prefix exactly, the error map relies on them)

CREATE VIEW engagement.content_reports WITH (security_invoker = true) AS
SELECT 'REVIEW'::text       AS subject_type, id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.review_reports
UNION ALL
SELECT 'REVIEW_REPLY'::text, id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.review_reply_reports
UNION ALL
SELECT 'QUESTION'::text,     id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.question_reports
UNION ALL
SELECT 'ANSWER'::text,       id, subject_id, reporter_id, reason, comment, status, created_at, resolved_at, resolved_by FROM engagement.answer_reports;
COMMENT ON VIEW engagement.content_reports IS 'Admin moderation queue across the four report tables (all statuses; filter status/subject_type; keyset (created_at, id)). A subject_type filter constant-folds the other branches away.';

CREATE TABLE engagement.moderation_actions (
  id           uuid        NOT NULL DEFAULT uuidv7(),
  subject_type text        NOT NULL,
  subject_id   uuid        NOT NULL,      -- polymorphic; existence verified at COMMIT (moderation_actions_subject_ck)
  action       text        NOT NULL,
  actor_id     uuid        NULL,          -- NULL = AUTO (report threshold)
  reason       text        NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_actions_pk           PRIMARY KEY (id),
  CONSTRAINT moderation_actions_actor_id_fk  FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT moderation_actions_subject_type_ck CHECK (subject_type IN ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER')),
  CONSTRAINT moderation_actions_action_ck    CHECK (action IN ('HIDE','RESTORE','DISMISS_REPORTS')),
  CONSTRAINT moderation_actions_reason_ck    CHECK ((actor_id IS NULL AND action = 'HIDE' AND reason IS NULL)               -- AUTO only hides
                                                    OR (actor_id IS NOT NULL AND reason IS NOT NULL AND char_length(reason) BETWEEN 10 AND 2000
                                                        AND translate(reason, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'))
);
-- Admin history per subject + the status-log guard's "latest HIDE/RESTORE" lookup
CREATE INDEX moderation_actions_subject_type_subject_id_occurred_at_idx ON engagement.moderation_actions (subject_type, subject_id, occurred_at, id);
CREATE TRIGGER moderation_actions_append_only_trg BEFORE UPDATE OR DELETE ON engagement.moderation_actions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER moderation_actions_no_truncate_trg BEFORE TRUNCATE ON engagement.moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- moderation_status == latest HIDE/RESTORE action (checked at COMMIT, from both sides)
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
$$;
CREATE CONSTRAINT TRIGGER moderation_actions_status_log_trg AFTER INSERT ON engagement.moderation_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard();
CREATE CONSTRAINT TRIGGER reviews_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('REVIEW');
CREATE CONSTRAINT TRIGGER review_replies_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.review_replies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('REVIEW_REPLY');
CREATE CONSTRAINT TRIGGER questions_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.questions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('QUESTION');
CREATE CONSTRAINT TRIGGER answers_moderation_log_trg AFTER INSERT OR UPDATE OF moderation_status ON engagement.answers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement.moderation_status_log_guard('ANSWER');
COMMENT ON TABLE engagement.moderation_actions IS 'Append-only moderation audit (who/what/when/why). actor NULL = AUTO hide at ENGAGEMENT_AUTO_HIDE_REPORTS distinct open reports. Every subject moderation_status equals its latest HIDE/RESTORE (moderation_status_log_ck, COMMIT).';

-- =====================================================================
-- 13. notifications (D14), preferences, fan-out jobs (D18, P5-D11)
-- =====================================================================
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
  CONSTRAINT notifications_pk                             PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_kind_source_event_id_uq UNIQUE (user_id, kind, source_event_id),   -- idempotent fan-out; also the user_id FK index
  CONSTRAINT notifications_user_id_fk                     FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
  CONSTRAINT notifications_app_ck                         CHECK (app IN ('STUDENT','INSTRUCTOR','ADMIN')),
  CONSTRAINT notifications_kind_ck                        CHECK (kind IN ('QA_NEW_QUESTION','QA_NEW_ANSWER','QA_RESOLVED','REVIEW_NEW','REVIEW_REPLY',
                                                                          'ANNOUNCEMENT','CERTIFICATE_ISSUED','MEDIA_READY','MEDIA_FAILED',
                                                                          'CONTENT_HIDDEN','MODERATION_QUEUE')),
  CONSTRAINT notifications_kind_app_ck                    CHECK (
       (kind IN ('QA_NEW_QUESTION','REVIEW_NEW','MEDIA_READY','MEDIA_FAILED') AND app = 'INSTRUCTOR')
    OR (kind IN ('REVIEW_REPLY','ANNOUNCEMENT','CERTIFICATE_ISSUED')          AND app = 'STUDENT')
    OR (kind IN ('QA_NEW_ANSWER','QA_RESOLVED','CONTENT_HIDDEN')              AND app IN ('STUDENT','INSTRUCTOR'))
    OR (kind = 'MODERATION_QUEUE'                                             AND app = 'ADMIN')),
  CONSTRAINT notifications_payload_ck                     CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  CONSTRAINT notifications_subject_ck                     CHECK ((subject_type IS NULL) = (subject_id IS NULL)
                                                                 AND (subject_type IS NULL OR subject_type IN
                                                                      ('REVIEW','REVIEW_REPLY','QUESTION','ANSWER','ANNOUNCEMENT','CERTIFICATE','MEDIA_ASSET'))),
  CONSTRAINT notifications_redacted_ck                    CHECK (redacted_at IS NULL OR (payload = '{}'::jsonb AND subject_id IS NOT NULL)),
  CONSTRAINT notifications_times_ck                       CHECK ((read_at IS NULL OR read_at >= created_at) AND (redacted_at IS NULL OR redacted_at >= created_at))
);
-- ListNotifications keyset: WHERE user_id=$1 AND app=$2 AND (created_at,id) < (...) ORDER BY created_at DESC, id DESC
CREATE INDEX notifications_user_id_app_created_at_id_idx ON notifications.notifications (user_id, app, created_at DESC, id DESC);
-- unreadOnly=true list, UnreadCount (count over LIMIT 100), MarkAllRead
CREATE INDEX notifications_user_id_app_created_at_id_unread_idx ON notifications.notifications (user_id, app, created_at DESC, id DESC) WHERE read_at IS NULL;
-- moderation-notifier redaction by subject
CREATE INDEX notifications_subject_type_subject_id_idx ON notifications.notifications (subject_type, subject_id) WHERE subject_id IS NOT NULL;
-- NotificationRetentionJob (_07): created_at < now() - 180 days, batched
CREATE INDEX notifications_created_at_idx ON notifications.notifications (created_at);
CREATE TRIGGER notifications_immutable_trg BEFORE UPDATE ON notifications.notifications
  FOR EACH ROW WHEN (
       (OLD.id, OLD.user_id, OLD.app, OLD.kind, OLD.subject_type, OLD.subject_id, OLD.source_event_id, OLD.created_at)
       IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.app, NEW.kind, NEW.subject_type, NEW.subject_id, NEW.source_event_id, NEW.created_at)
    OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
    OR (OLD.redacted_at IS NOT NULL AND (NEW.payload, NEW.redacted_at) IS DISTINCT FROM (OLD.payload, OLD.redacted_at))
    OR (NEW.redacted_at IS NULL AND NEW.payload IS DISTINCT FROM OLD.payload))
  EXECUTE FUNCTION public.forbid_row_change('notifications_immutable_ck', 'notifications: only read once and redacted once');
COMMENT ON TABLE notifications.notifications IS 'Per-recipient inbox rows (fan-out on write, D14). Mutations: read_at once, redaction once (payload -> {}), retention delete after 180 days. Idempotent on (user, kind, source event).';

CREATE TABLE notifications.notification_preferences (
  user_id    uuid        NOT NULL,
  category   text        NOT NULL,
  channel    text        NOT NULL,
  enabled    boolean     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_pk          PRIMARY KEY (user_id, category, channel),   -- effective = defaults ⊕ rows of this user
  CONSTRAINT notification_preferences_user_id_fk  FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE,
  CONSTRAINT notification_preferences_category_ck CHECK (category IN ('QA','REVIEWS','ANNOUNCEMENTS','LEARNING','COURSE_BUILDING','MODERATION')),
  CONSTRAINT notification_preferences_channel_ck  CHECK (channel IN ('IN_APP','EMAIL'))
);
CREATE TRIGGER notification_preferences_set_updated_at_trg BEFORE UPDATE ON notifications.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE notifications.notification_preferences IS 'Overrides of the code defaults per (category, channel). Locked (transactional) categories are rejected by the app (preference_locked). Unsubscribe = upsert EMAIL false.';

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
  CONSTRAINT fanout_jobs_source_event_id_uq UNIQUE (source_event_id),        -- enqueuer ON CONFLICT DO NOTHING
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
);
-- Lease pickup: WHERE status='QUEUED' AND run_after <= now() ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED
CREATE INDEX fanout_jobs_run_after_id_queued_idx ON notifications.fanout_jobs (run_after, id) WHERE status = 'QUEUED';
-- Reaper: RUNNING with an expired lease
CREATE INDEX fanout_jobs_lease_expires_at_running_idx ON notifications.fanout_jobs (lease_expires_at) WHERE status = 'RUNNING';
-- NotificationRetentionJob (_07): finished jobs older than 30 days
CREATE INDEX fanout_jobs_finished_at_idx ON notifications.fanout_jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE TRIGGER fanout_jobs_set_updated_at_trg BEFORE UPDATE ON notifications.fanout_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER fanout_jobs_status_insert_trg BEFORE INSERT ON notifications.fanout_jobs
  FOR EACH ROW WHEN (NEW.status <> 'QUEUED' OR NEW.attempts <> 0 OR NEW.processed_count <> 0 OR NEW.after_user_id IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('fanout_jobs_status_transition_ck', 'a fan-out job must be created QUEUED and unstarted');
CREATE TRIGGER fanout_jobs_status_transition_trg BEFORE UPDATE ON notifications.fanout_jobs
  FOR EACH ROW WHEN (
       (OLD.id, OLD.kind, OLD.source_event_id, OLD.course_id, OLD.subject_id, OLD.send_email, OLD.created_at)
       IS DISTINCT FROM (NEW.id, NEW.kind, NEW.source_event_id, NEW.course_id, NEW.subject_id, NEW.send_email, NEW.created_at)
    OR NEW.processed_count < OLD.processed_count
    OR (OLD.after_user_id IS NOT NULL AND (NEW.after_user_id IS NULL OR NEW.after_user_id < OLD.after_user_id))   -- cursor only advances
    OR OLD.status IN ('DONE','FAILED')
    OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'QUEUED'  AND NEW.status = 'RUNNING')
       OR (OLD.status = 'RUNNING' AND NEW.status IN ('QUEUED','DONE','FAILED')))))
  EXECUTE FUNCTION public.forbid_row_change('fanout_jobs_status_transition_ck', 'illegal fan-out job transition (or cursor moved back)');
COMMENT ON TABLE notifications.fanout_jobs IS 'Leased announcement fan-out (P5-D11, P2 transcode-job pattern). One batch = one tx: fenced job update + <= 1000 notification inserts + cursor advance. A lease lost mid-batch rolls the batch back; UNIQUE (user, kind, source_event_id) makes a replay harmless.';

-- =====================================================================
-- 14. enrollment: keyset index for the fan-out (supersedes enrollments_course_id_active_idx)
-- =====================================================================
-- FanoutJob: WHERE course_id=$1 AND status='ACTIVE' AND user_id > $cursor ORDER BY user_id LIMIT 1000 (and course counts, index-only)
CREATE INDEX enrollments_course_id_user_id_active_idx ON enrollment.enrollments (course_id, user_id) WHERE status = 'ACTIVE';
DROP INDEX enrollment.enrollments_course_id_active_idx;

-- =====================================================================
-- 15. Privileges (prod role split; no-op in dev where udemy_app doesn't exist)
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
    GRANT USAGE ON SCHEMA learning, engagement, notifications TO udemy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA learning, engagement, notifications TO udemy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.lecture_quizzes, catalog.quiz_questions, catalog.quiz_options,
                                          catalog.revision_quiz_questions, catalog.revision_quiz_options TO udemy_app;
    GRANT EXECUTE ON FUNCTION learning.fit_coverage(varbit, integer) TO udemy_app;
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
$$;
```

**Down order** (sql-ops; no CASCADE, as 0001–0004):

1. Recreate `enrollment.enrollments_course_id_active_idx ON enrollment.enrollments (course_id) WHERE status = 'ACTIVE'`, then drop `enrollments_course_id_user_id_active_idx`.
2. Drop `notifications.fanout_jobs`, `notification_preferences`, `notifications`.
3. Drop `VIEW engagement.content_reports`. Drop `engagement.moderation_actions`, the four `*_reports`, `wishlist_items`, `announcements`, `answer_votes`, `question_votes`. Run `ALTER TABLE engagement.questions DROP CONSTRAINT questions_id_accepted_answer_id_fk`. Drop `answers`, `questions`, `course_rating_stats`, `review_replies`, `reviews`. Drop the functions `moderation_status_log_guard`, `questions_accepted_answer_guard`, `counters_guard`, `answers_sync_question`, `votes_count`, `forbid_own_content`.
4. Drop these learning tables, in this order: `certificate_transitions`, `certificates`, `notes`, `lecture_completions`, `quiz_attempt_selections`, `quiz_attempt_questions`, `quiz_attempts`, `course_completions`, `course_activity`, `lecture_progress`. Then drop the functions `certificates_status_log_guard`, `lecture_completions_quiz_guard`, `quiz_attempts_grading_guard`, `quiz_attempt_selections_guard`, `quiz_attempt_questions_guard`, `fit_coverage(varbit, integer)`.
5. Catalog, in this order:
   1. `DROP TRIGGER revision_lectures_quiz_complete_trg ON catalog.revision_lectures`, then `DROP TRIGGER lectures_quiz_settings_trg ON catalog.lectures`.
   2. Drop the tables `revision_quiz_options`, `revision_quiz_questions`, `quiz_options`, `quiz_questions`, `lecture_quizzes`.
   3. `CREATE OR REPLACE FUNCTION catalog.working_copy_guard()` with the **0003 body verbatim**.
   4. On `revision_lectures`: drop `revision_lectures_revision_id_lecture_id_type_uq` and `revision_lectures_quiz_pass_pct_ck`, drop the column `quiz_pass_pct`, and restore the three 0003 CHECKs (`type_ck`, `media_asset_id_ck`, `is_preview_ck`).
   5. On `lectures`: restore the three 0003 CHECKs.
   6. Drop the functions `revision_quiz_complete_guard`, `revision_quiz_key_guard`, `revision_quiz_same_tx_guard`, `lecture_quiz_settings_guard`.
   - **Step 5 fails loudly if any QUIZ lecture or revision exists. That is intentional:** append-only revisions can't be deleted, so a down past real quiz data is a data-loss decision for a human.

---

## 2. Invariant verification list

**Catalog (quiz)**

| Invariant                                                                      | Enforced by                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| QUIZ lectures have no media and are never previews (working copy and snapshot) | `lectures_type_media_asset_id_ck`, `lectures_type_is_preview_ck`, `revision_lectures_*` |
| Settings only on QUIZ lectures; every QUIZ lecture has settings                | `lecture_quizzes_lecture_id_lecture_type_fk`, deferred `lecture_quizzes_required_ck`    |
| ≤ 50 questions, ≤ 6 options, positions unique (deferred for reorder)           | `*_position_ck`, `quiz_questions_lecture_id_position_uq`, `quiz_options_pk`             |
| Working-copy quiz edits are blocked while in review / archived / deleted       | `courses_working_copy_locked_ck` (extended `working_copy_guard`)                        |
| Snapshot questions hang only off a QUIZ revision lecture                       | `revision_quiz_questions_revision_id_lecture_id_lecture_type_fk`                        |
| Every snapshotted quiz has 1–50 contiguous questions; every key is well-formed | deferred `revision_lectures_quiz_complete_ck`, deferred `revision_quiz_options_key_ck`  |
| A committed answer key can never change (no update, delete, or late insert)    | append-only triggers + REVOKE + `revision_quiz_*_same_tx_ck`                            |

**Learning**

| Invariant                                                                                                         | Enforced by                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Coverage length = ceil(duration/5); position ≤ duration                                                           | `lecture_progress_coverage_ck`, `_position_seconds_ck`                                                                         |
| Coverage only grows for the same asset; resets on swap                                                            | flush SQL (§8.1) — app; DB guarantees the length                                                                               |
| Completion cause fits the lecture type (MANUAL only ARTICLE/RESOURCE)                                             | `lecture_completions_cause_type_ck`                                                                                            |
| A QUIZ completion is backed by a passed, submitted attempt of the same user, lecture and course                   | `lecture_completions_quiz_attempt_ck`, composite FK, `lecture_completions_quiz_passed_ck`                                      |
| Course completion is permanent                                                                                    | append-only + REVOKE                                                                                                           |
| One open attempt per (user, quiz); IN_PROGRESS → SUBMITTED/ABANDONED once; identity frozen                        | `quiz_attempts_user_id_lecture_id_open_uq`, `quiz_attempts_transition_ck`                                                      |
| Score and pass are computed by the DB; question/correct counts match the per-question rows                        | generated columns, deferred `quiz_attempts_grading_ck`                                                                         |
| Attempt questions frozen at START; graded once before SUBMITTED; selections only while open                       | `quiz_attempt_questions_same_tx_ck`, `_immutable_ck`, `quiz_attempt_selections_attempt_open_ck`                                |
| A certificate exists only for a course completion; one per (user, course)                                         | `certificates_user_id_course_id_fk`, `_uq`                                                                                     |
| Certificate status/issued/revoked = log; legal edges; admin needs actor + reason; regrant can't undo admin revoke | `certificate_transitions_*_ck` + chain FK, deferred `certificates_status_log_ck`, `certificate_transitions_reinstate_cause_ck` |
| Certificate text immutable; PDF key deterministic and recorded once                                               | `certificates_immutable_ck`, `certificates_pdf_ck`                                                                             |

**Engagement**

| Invariant                                                                                     | Enforced by                                                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| One live review per (user, course); one live reply per review                                 | `reviews_course_id_user_id_live_uq`, `review_replies_review_id_live_uq`                               |
| Deleted reviews/replies/questions/answers are frozen; identity immutable                      | `*_immutable_ck`                                                                                      |
| Stats = histogram of PUBLISHED reviews; totals and average consistent                         | worker recompute (§8.4) + generated columns; IT consistency query §8.8                                |
| Counters equal `count(*)` (votes; visible non-deleted answers); the app can't write them      | vote/answer triggers, `questions_counters_ck`, `answers_counters_ck`; IT §8.8                         |
| The accepted answer belongs to the question and is visible; hiding/deleting it clears it      | `questions_id_accepted_answer_id_fk`, `questions_accepted_answer_visible_ck`, `answers_sync_question` |
| No votes/reports on own content; one vote / report per user per subject                       | `*_own_content_ck`, `*_votes_pk`, `*_reports_subject_id_reporter_id_uq`                               |
| Reports resolved once; moderation_status = latest HIDE/RESTORE; AUTO only hides; admin reason | `*_reports_transition_ck`, deferred `moderation_status_log_ck`, `moderation_actions_reason_ck`        |
| Announcements immutable; delete once                                                          | `announcements_immutable_ck`                                                                          |

**Notifications**

| Invariant                                                                   | Enforced by                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| One row per (user, kind, event); kind targets the right app; payload ≤ 4 KB | `notifications_user_id_kind_source_event_id_uq`, `_kind_app_ck`, `_payload_ck` |
| Read once, redacted once (to `{}`)                                          | `notifications_immutable_ck`, `_redacted_ck`                                   |
| Fan-out: legal edges, monotonic cursor, lease shape                         | `fanout_jobs_status_transition_ck`, `_lease_ck`                                |

**Not DB-enforceable (cross-schema, D12):** `course_id`/`lecture_id`/`revision_id` ↔ catalog; lecture type and duration ↔ catalog; enrollment-based access; review eligibility; the reply author = owner; notes position ≤ VIDEO duration; certificates ACTIVE ⇔ enrollment ACTIVE. These are covered by the IT/ops consistency queries in §8.8.

**ON DELETE:**

- Everything is RESTRICT except:
  - `notifications → users` and `notification_preferences → users`, which CASCADE;
  - the catalog working-copy quiz tables, which CASCADE with the lecture.
- State tables are never deleted (REVOKE).

---

## 3. Seed data

None. No constraint depends on reference rows; defaults live in code (notification preferences) or are lazily created (rating stats).

---

## 4. Privileges

| Grant level                    | Objects                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No UPDATE/DELETE (append-only) | `catalog.revision_quiz_questions`, `catalog.revision_quiz_options`, `learning.course_completions`, `learning.certificate_transitions`, `learning.quiz_attempt_selections`, `engagement.moderation_actions`                              |
| No UPDATE (insert/delete)      | `learning.lecture_completions`, `engagement.question_votes`, `engagement.answer_votes`, `engagement.wishlist_items`                                                                                                                     |
| No DELETE                      | `learning.lecture_progress`, `course_activity`, `quiz_attempts`, `quiz_attempt_questions`, `certificates`; `engagement.reviews`, `review_replies`, `course_rating_stats`, `questions`, `answers`, `announcements`, the four `*_reports` |
| SELECT only                    | `engagement.content_reports` (view)                                                                                                                                                                                                     |
| Full DML                       | `learning.notes`, `notifications.*` (retention deletes), the catalog working-copy quiz tables                                                                                                                                           |

**Why the app keeps some UPDATE rights:** the guard and counter triggers run as the invoker.

- They UPDATE `questions` and `answers` counters, and lock `questions` `FOR NO KEY UPDATE`.
- The auto-hide path locks the subject row; selections lock `quiz_attempts` `FOR SHARE`.
- All of these need UPDATE on the table.

**`roles.sql` needs no change.** The global default privileges already give `udemy_app` DML on the new tables and EXECUTE on the new functions. The explicit `GRANT EXECUTE` on `fit_coverage` is belt and braces, as `coupon_discount` was in P4.

**API and worker share `udemy_app`.** "Rating stats and certificates are written by the worker only" is therefore a convention, not a privilege. This is the same caveat as payouts in P4.

---

## 5. Design decisions and 3NF check

**In 3NF:**

- `course_activity`, `course_completions`, `quiz_attempt_questions`, `quiz_attempt_selections`, `notes`
- `certificate_transitions`, `review_replies`
- the vote and report tables, `moderation_actions`, `wishlist_items`, `announcements`
- `notification_preferences`
- the catalog quiz tables

**Documented exceptions** (each is immutable, FK-pinned, generated, or verified at COMMIT):

1. **`course_id` next to `lecture_id`** in `lecture_progress`, `lecture_completions`, `notes` and `quiz_attempts`.
   - The lecture determines the course, but catalog is cross-schema (no FK).
   - Lectures never change course (`lectures_immutable_ck`), and the column is immutable here.
   - Needed for every per-course read. Same precedent as `catalog.lectures.course_id`.
2. **`lecture_completions.lecture_type`** is determined by the lecture, and is immutable in catalog. It is needed for `lecture_completions_cause_type_ck` (the DB-level D4 rule).
3. **Snapshots** (point-in-time facts, not drifting copies):
   - `lecture_progress.duration_seconds` / `media_asset_id` give the bitmap its meaning;
   - `quiz_attempts.pass_pct` / `question_count` come from an immutable revision;
   - `certificates.recipient_name` / `course_title` / `instructor_name` are what the certificate says;
   - `fanout_jobs.course_id` / `send_email` come from the immutable announcement event.
4. **Q&A counters (P5-D12):** `questions.upvote_count`, `answer_count`, `last_activity_at` and `answers.upvote_count`.
   - Needed for indexable keyset sorts (`recent`, `top`, `unanswered`).
   - Exact in the same statement: votes use row-locked deltas; answers use lock-then-recount.
   - The app cannot write them (`*_counters_ck`), and an IT consistency query compares them with `count(*)`.
5. **`course_rating_stats`** is a projection: the histogram is materialised by the worker and is self-healing (full recompute every event). `review_count`, `rating_sum` and `average_rating` are **generated** from the histogram, so there is no transitive dependency left to drift.
6. **Materialised state verified at COMMIT:**
   - `certificates.status` / `issued_at` / `revoked_at`: `certificates_status_log_ck`
   - `moderation_status` on the four subjects: `moderation_status_log_ck`
7. **`quiz_attempts.score_pct` / `passed`** are generated from columns of the same row, so they cannot drift. The DB is the rounding authority.

**Removed or changed relative to design §6, for 3NF or correctness:**

- **`notifications.category` dropped.** The category is a function of `kind` (fixed mapping in contracts). Preferences are matched in code.
- **`course_rating_stats.review_count` / `rating_sum` made generated** (design had stored columns plus Σ CHECKs).
- **`quiz_attempts.score_pct` / `passed` made generated** (design had plain NULL columns).
- **`review_replies` got its own uuid PK plus a partial unique live index.** Design had PK `review_id` and no soft delete. A hard-deleted reply would break `review_reply_reports` (FK RESTRICT) and erase the moderation trail. A PK-upsert "undelete" would attach old reports to new text.
- **`questions_id_accepted_answer_id_fk` is not DEFERRABLE.** Question and answer exist before any accept, so there is nothing to defer. An immediate 23503 maps cleanly to `answer_not_found`.
- **`certificate_transitions` uses the P4 seq-chain** (`PK (certificate_id, seq)` + chain FK) instead of a uuid PK plus a partial unique ISSUE index. `root_ck` (seq 1 ⇔ ISSUE) makes the ISSUE unique redundant, and concurrent transitions collide on the PK.
- **`lecture_completions.quiz_attempt_id` added.** A QUIZ completion now points to the passing attempt (audit, DB-checked).
- **`notifications.redacted_at` added**, so redaction is explicit and happens once.
- **`moderation_actions.subject_type` no longer includes ANNOUNCEMENT.** No announcement moderation flow exists (announcements are deleted by owner or admin with `deleted_by`), and the log guard would have nothing to verify. Re-add it together with a flow (open point 2).

**Indexes dropped or reshaped relative to §6, with reasons:**

- `reviews (user_id, course_id)`: the live unique `(course_id, user_id)` serves every lookup (my review, enrollment sync).
- `reviews (course_id) INCLUDE (rating)`: superseded by `(course_id, rating, created_at, id)` with the same predicate. That one index also serves the `?rating=` list and the index-only GROUP BY.
- `announcements (course_id, created_at DESC, id DESC) WHERE deleted_at IS NULL` + `(course_id, created_at)`: one full index serves both the list (deleted rows are rare; filtered) and the quota count (which must include deleted rows).
- `quiz_questions UNIQUE (lecture_id, id)`: no FK targets it, and options reference `question_id` alone.
- `notifications (user_id, app) WHERE read_at IS NULL`: widened to `(user_id, app, created_at DESC, id DESC) WHERE read_at IS NULL`, so it also serves the `unreadOnly` keyset and `MarkAllRead`.
- `*_reports (status, created_at) WHERE status='OPEN'`: made full `(status, created_at, id)`, because the admin queue filters any status.
- `certificate_transitions` partial unique on ISSUE: redundant (see above).
- **Added** `enrollment.enrollments_course_id_user_id_active_idx`, dropping `enrollments_course_id_active_idx`. The fan-out keyset `user_id > $cursor ORDER BY user_id` within one course needs `(course_id, user_id)`; the P4 index would sort all enrollees of the course per batch. The new index also serves the per-course counts.

**Trade-offs flagged (correctness over speed):**

- `answers_sync_question` re-counts a question's visible answers on every answer insert, hide or delete (index range scan, O(answers per question)), instead of a delta. A delta would need four cases (insert, hide, restore, delete) plus `last_activity_at` recomputation on hide, which is exactly where drift creeps in.
- `InstructorQaInbox` over ≤ 100 course ids sorts the union of per-course index ranges. It is bounded by one instructor's open questions; P6 can add an owner projection if it gets hot. I did not copy `owner_id` onto questions, because it would be a cross-schema copy.
- The `unresolved` inbox filter (`accepted_answer_id IS NULL`) has no dedicated index; it filters on the course indexes.
- `lecture_progress`/`course_activity` use `fillfactor = 80` so the 15 s flush updates stay HOT. This is purely physical; no correctness cost.

---

## 6. Races, checked one by one

- **R1. Parallel completions finishing a course** (the T10 test: one `LectureCompleted`, one `CourseCompleted`).
  - Every completion transaction first takes `pg_advisory_xact_lock(1819438691 /* 'lrnc' */, hashtext(user_id || ':' || course_id))`, then inserts, then checks completed ⊇ live ids in a **new statement**.
  - At READ COMMITTED the second transaction sees the first one's row. `course_completions_pk` plus `ON CONFLICT DO NOTHING` makes the insert idempotent anyway.
  - Two parallel heartbeats crossing 0.9 on the same lecture: `lecture_completions_pk` / `ON CONFLICT DO NOTHING RETURNING` means only the inserter emits `LectureCompleted`.
- **R2. Parallel quiz starts:** `quiz_attempts_user_id_lecture_id_open_uq`. The loser gets 23505, rolls back to a savepoint (or retries the tx) and returns the open attempt (200).
- **R3. Submit vs the abandon job:**
  - Submit locks the attempt `FOR UPDATE WHERE status='IN_PROGRESS'`.
  - The job uses `FOR UPDATE SKIP LOCKED` and re-checks `status='IN_PROGRESS'` in the UPDATE.
  - Exactly one wins; the transition guard rejects the other edge.
- **R4. Parallel review upserts:** both target `reviews_course_id_user_id_live_uq` via `ON CONFLICT … DO UPDATE`. The second waits on the row, then updates; one row results.
- **R5. Flush vs heartbeat (no lost bits):**
  - The flush takes `_06` **before** claiming from Redis. Taking the claim first would strand claimed members whenever the try-lock fails.
  - It claims (Lua ZPOPMIN plus the snapshots), upserts with OR, and on DB error re-adds with `ZADD NX`.
  - A heartbeat after the claim re-dirties the key, so the next flush ORs its bits in. OR is commutative and idempotent.
  - Batch rows are sorted by `(user_id, lecture_id)`, so a concurrent `DirectProgressStore` write cannot deadlock with a flush.
- **R6. Duplicate `CourseCompleted`:**
  - `INSERT certificates … ON CONFLICT DO NOTHING` (no target; covers `(user_id, course_id)` and `source_event_id`).
  - 0 rows: read the row; `pdf_rendered_at IS NULL` means re-render only.
  - The PDF key is deterministic (`certificates_pdf_ck`), so a retry overwrites the same object.
- **R7. 20 parallel votes by one user:** the PK gives one row, and `ON CONFLICT DO NOTHING` fires no trigger for the losers, so the counter is 1. Votes by different users on the same question serialise on the question row in the delta UPDATE; EPQ re-reads the new count, so the result is exact.
- **R8. Parallel answers on one question:** `answers_sync_question` locks the question `FOR NO KEY UPDATE`, then counts in a new statement. The second answerer's count sees the first. The answer's FK check (`KEY SHARE`) does not conflict with `NO KEY UPDATE`.
- **R9. Auto-hide threshold** (3 distinct reporters at once):
  - `ReportContent` must lock the **subject row** `FOR NO KEY UPDATE` before inserting the report and counting open reports in a new statement.
  - Without the lock, three concurrent reporters each count ≤ 2 and nobody hides.
  - The hide, the `moderation_actions(AUTO)` row and the ACTIONED updates happen in that same transaction.
- **R10. Fan-out lease expiry mid-batch:**
  - Each batch tx starts with a fenced `SELECT … FOR UPDATE WHERE id=$1 AND status='RUNNING' AND lease_owner=$me AND attempts=$n`.
  - 0 rows means the lease was lost: abort without inserting.
  - If the reaper requeues while a batch is running, the reaper's UPDATE waits on the row lock. The batch commits first and the requeue then resumes from the advanced cursor.
  - Duplicates are impossible because of `notifications_user_id_kind_source_event_id_uq`. Emails go only to rows returned by `RETURNING` (newly inserted), after commit.
- **R11. Rating recompute concurrency:**
  - `rating-aggregator` (topic keyed by course) and `review-enrollment-sync` (enrollment topic, keyed by user) can recompute the same course concurrently.
  - Both do `INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`, then the aggregate in the next statement. The row lock serialises them and the second sees the first's committed review change.
- **R12. Announcement quota:** `pg_advisory_xact_lock(1634627183 /* 'anno' */, hashtext(course_id))`, then count in a new statement, then insert. Parallel posts can't exceed 4 per 30 days.
- **R13. Certificate regrant after an admin revoke:**
  - The worker REINSTATE must check that the head transition's cause is `ENROLLMENT_REVOKED`, and skip otherwise.
  - `certificate_transitions_reinstate_cause_ck` is the COMMIT backstop. Without the pre-check, the event would land in the DLQ.

**Lock order** (a path may skip steps, never reverse them):

`lrnc/note/wish/anno advisory → aggregate row (attempt / certificate / question / subject / stats / fan-out job) → child rows`

Learning never locks commerce or enrollment rows. `LearningConsumptionPolicy` runs inside commerce's refund transaction (after the cart and order locks) and only reads learning tables, without locks.

---

## 7. Kysely type expectations

These assume `kysely-codegen --camel-case --numeric-parser string --date-parser timestamp`.

**Keys:**

- `"learning.lectureProgress"`, `"learning.courseActivity"`, `"learning.lectureCompletions"`, `"learning.courseCompletions"`
- `"learning.quizAttempts"`, `"learning.quizAttemptQuestions"`, `"learning.quizAttemptSelections"`
- `"learning.notes"`, `"learning.certificates"`, `"learning.certificateTransitions"`
- `"engagement.reviews"`, `"engagement.reviewReplies"`, `"engagement.courseRatingStats"`
- `"engagement.questions"`, `"engagement.answers"`, `"engagement.questionVotes"`, `"engagement.answerVotes"`
- `"engagement.announcements"`, `"engagement.wishlistItems"`, `"engagement.reviewReports"`, `"engagement.reviewReplyReports"`, `"engagement.questionReports"`, `"engagement.answerReports"`, `"engagement.moderationActions"`
- `"engagement.contentReports"` (view; check codegen emits it, else hand-type it read-only)
- `"notifications.notifications"`, `"notifications.notificationPreferences"`, `"notifications.fanoutJobs"`
- `"catalog.lectureQuizzes"`, `"catalog.quizQuestions"`, `"catalog.quizOptions"`, `"catalog.revisionQuizQuestions"`, `"catalog.revisionQuizOptions"`
- `catalog.revisionLectures.quizPassPct` (new column)

**Codegen `--overrides` additions** (generated columns, and trigger-owned counters the app must never write):

```json
"learning.quiz_attempts.score_pct": "ColumnType<number | null, never, never>",
"learning.quiz_attempts.passed": "ColumnType<boolean | null, never, never>",
"learning.certificate_transitions.prev_seq": "ColumnType<number | null, never, never>",
"engagement.course_rating_stats.review_count": "ColumnType<number, never, never>",
"engagement.course_rating_stats.rating_sum": "ColumnType<string, never, never>",
"engagement.course_rating_stats.average_rating": "ColumnType<string | null, never, never>",
"engagement.questions.upvote_count": "ColumnType<number, never, never>",
"engagement.questions.answer_count": "ColumnType<number, never, never>",
"engagement.questions.last_activity_at": "ColumnType<Date, never, never>",
"engagement.answers.upvote_count": "ColumnType<number, never, never>"
```

**Types:**

- `varbit` → `string` (node-pg has no parser for OID 1562; it returns `'0101…'`).
  - **Never round-trip coverage through JS except to seed Redis on a miss.** For that: `SELECT coverage::text`, then TS packs it MSB-first into a Buffer for `SET lpc:{u}:{l}`.
  - **Write coverage as text:** `'x' || hex(redisBytes)` cast `::varbit`, always wrapped in `learning.fit_coverage(…, (duration + 4) / 5)`.
  - Arrays go as `$n::text[]` and are cast per element. Do not bind `varbit[]`.
- `bit_count` → `Int8` (string): cast `::int` in SQL.
- `jsonb` → `Json`. `numeric(2,1)` → string.
- `smallint` / `integer` → `number`.

**Omit on insert** (defaults; the guards compare them with `now()` and need the same-transaction value):

- `quizAttempts.startedAt`, which must stay `now()`: `quiz_attempt_questions_same_tx_ck` relies on it;
- every `createdAt`, `completedAt`, `issuedAt`, `occurredAt`;
- `questions.lastActivityAt`.

Use `` sql`now()` `` for `submittedAt`, `abandonedAt`, `revokedAt`, `deletedAt`, `readAt`, `resolvedAt`, `redactedAt`, `finishedAt`.

**Raw SQL needed:**

- the varbit upsert (§8.1);
- `RETURNING old.*` (review upsert);
- `max(seq)+1` transition inserts;
- partial-index `ON CONFLICT … WHERE deleted_at IS NULL` (reviews, review replies).

**Deferred errors** surface at commit in `db.transaction().execute()`:

`lecture_quizzes_required_ck`, `revision_quiz_options_key_ck`, `revision_lectures_quiz_complete_ck`, `quiz_attempts_grading_ck`, `certificates_status_log_ck`, `certificate_transitions_reinstate_cause_ck`, `moderation_status_log_ck`, `moderation_actions_subject_ck`, `quiz_questions_lecture_id_position_uq`.

**Keyset cursors:** carry the exact SQL timestamp text (`created_at::text`, `last_activity_at::text`, `added_at::text`, `started_at::text`), per P2 §14.

---

## 8. Operational SQL sketches (all at READ COMMITTED)

### 8.1 Progress flush upsert (`packages/db/src/learning/progress-upsert.ts`)

The same statement with one row is the `DirectProgressStore`.

```sql
-- tx: SELECT pg_try_advisory_xact_lock(504196069638 /* 0x75646d79_06 */);  false -> skip this tick, claim nothing
-- then the Lua claim of <= 500 members; rows deduped on (user_id, lecture_id) and sorted by them
INSERT INTO learning.lecture_progress AS p
       (user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds, coverage, first_watched_at, last_watched_at)
SELECT b.user_id, b.lecture_id, b.course_id, b.media_asset_id, b.duration_seconds,
       least(greatest(b.position_seconds, 0), b.duration_seconds),
       learning.fit_coverage(b.coverage_hex::varbit, (b.duration_seconds + 4) / 5),
       b.first_at, b.last_at
  FROM unnest($user_ids::uuid[], $lecture_ids::uuid[], $course_ids::uuid[], $asset_ids::uuid[], $durations::int[],
              $positions::int[], $coverages::text[] /* 'x' || hex */, $first_ats::timestamptz[], $last_ats::timestamptz[])
       AS b(user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds, coverage_hex, first_at, last_at)
 ORDER BY b.user_id, b.lecture_id
ON CONFLICT (user_id, lecture_id) DO UPDATE SET
  coverage = CASE
               WHEN p.media_asset_id = EXCLUDED.media_asset_id AND p.duration_seconds = EXCLUDED.duration_seconds
                 THEN p.coverage | EXCLUDED.coverage                     -- equal lengths by lecture_progress_coverage_ck (V1, V5)
               WHEN EXCLUDED.last_watched_at >= p.last_watched_at
                 THEN EXCLUDED.coverage                                  -- asset swapped: D3 reset, newest wins
               ELSE p.coverage
             END,
  media_asset_id   = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.media_asset_id   ELSE p.media_asset_id   END,
  duration_seconds = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.duration_seconds ELSE p.duration_seconds END,
  position_seconds = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.position_seconds ELSE p.position_seconds END,  -- LWW
  first_watched_at = least(p.first_watched_at, EXCLUDED.first_watched_at),
  last_watched_at  = greatest(p.last_watched_at, EXCLUDED.last_watched_at)
RETURNING user_id, lecture_id, bit_count(coverage)::int AS covered_buckets, length(coverage) AS bucket_count;   -- Direct store: ratio

INSERT INTO learning.course_activity AS a (user_id, course_id, last_lecture_id, last_accessed_at)
SELECT * FROM unnest($user_ids::uuid[], $course_ids::uuid[], $lecture_ids::uuid[], $accessed_ats::timestamptz[])
 ORDER BY 1, 2
ON CONFLICT (user_id, course_id) DO UPDATE
   SET last_lecture_id = EXCLUDED.last_lecture_id, last_accessed_at = EXCLUDED.last_accessed_at
 WHERE EXCLUDED.last_accessed_at > a.last_accessed_at;
-- On 23514 for the batch: retry row by row, drop (and log) the offending member, re-add the rest (ZADD NX).
```

### 8.2 Completion (`learning/completion.ts`)

```sql
SELECT pg_advisory_xact_lock(1819438691 /* 'lrnc' */, hashtext($user_id::text || ':' || $course_id::text));
INSERT INTO learning.lecture_completions (user_id, lecture_id, course_id, lecture_type, cause, revision_id, quiz_attempt_id)
VALUES ($user_id, $lecture_id, $course_id, $type, $cause, $live_revision_id, $attempt_id_or_null)
ON CONFLICT (user_id, lecture_id) DO NOTHING
RETURNING completed_at;                                   -- 1 row -> outbox LectureCompleted
-- EvaluateCourseCompletion (new statement, same tx, still under the lock)
SELECT count(*)::int AS done
  FROM learning.lecture_completions
 WHERE user_id = $user_id AND lecture_id = ANY($live_lecture_ids::uuid[]);
-- done = cardinality(live ids) ->
INSERT INTO learning.course_completions (user_id, course_id, revision_id, lecture_count)
VALUES ($user_id, $course_id, $live_revision_id, $live_count)
ON CONFLICT (user_id, course_id) DO NOTHING
RETURNING completed_at;                                   -- 1 row -> outbox CourseCompleted
-- Uncomplete: DELETE FROM learning.lecture_completions WHERE user_id=$1 AND lecture_id=$2 RETURNING course_id (-> LectureCompletionCleared)
```

### 8.3 Consumption for the refund policy (`learning/consumption.ts`, P5-D6)

Inputs: the live curriculum from `CatalogFacade.getLiveCurriculum`, flattened to parallel arrays.

```sql
WITH live AS (
  SELECT * FROM unnest($lecture_ids::uuid[], $types::text[], $asset_ids::uuid[], $durations::int[])
         AS l(lecture_id, type, media_asset_id, duration_seconds))
SELECT
  -- watched = covered buckets x 5, clamped per lecture (the last bucket is partial); only bitmaps of the live asset count (D3)
  (SELECT coalesce(sum(least(bit_count(p.coverage) * 5, l.duration_seconds)), 0)::int
     FROM live l
     JOIN learning.lecture_progress p
       ON p.user_id = $user_id AND p.lecture_id = l.lecture_id
      AND p.media_asset_id = l.media_asset_id AND p.duration_seconds = l.duration_seconds
    WHERE l.type = 'VIDEO')                                                       AS video_seconds_watched,
  (SELECT coalesce(sum(duration_seconds), 0)::int FROM live WHERE type = 'VIDEO') AS video_seconds_total,
  (SELECT count(*)::int FROM learning.lecture_completions c JOIN live l ON l.lecture_id = c.lecture_id
    WHERE c.user_id = $user_id AND c.course_id = $course_id)                      AS completed_lectures,
  (SELECT count(*)::int FROM live)                                                AS total_lectures,
  (SELECT completed_at FROM learning.course_completions WHERE user_id = $user_id AND course_id = $course_id) AS course_completed_at,
  (SELECT status       FROM learning.certificates       WHERE user_id = $user_id AND course_id = $course_id) AS certificate_status;
```

`LearningConsumptionPolicy` (commerce) objects, in this order, using integer comparisons (no floats), strict `>` per P5-D6:

1. `certificate_status = 'ACTIVE'` → `certificate_issued`.
2. `video_seconds_watched * 100 > PCT * video_seconds_total` → `consumed_video_{floor(watched*100/total)}`.
3. `completed_lectures * 100 > PCT * total_lectures` → `consumed_lectures_{…}`.

The figures read the DB, so they are at most one flush (≤ 15 s) behind Redis; that is acceptable for a NEEDS_REVIEW signal. The query reads only, takes no locks, and runs inside commerce's refund transaction.

### 8.4 Rating recompute (`engagement/rating-recompute.ts`, worker only)

```sql
INSERT INTO engagement.course_rating_stats (course_id) VALUES ($course_id) ON CONFLICT (course_id) DO NOTHING;
SELECT 1 FROM engagement.course_rating_stats WHERE course_id = $course_id FOR UPDATE;      -- serialises recomputes of one course
UPDATE engagement.course_rating_stats s                                                    -- new statement: fresh snapshot after the lock
   SET count_1 = a.c1, count_2 = a.c2, count_3 = a.c3, count_4 = a.c4, count_5 = a.c5, recomputed_at = now()
  FROM (SELECT count(*) FILTER (WHERE rating = 1)::int AS c1, count(*) FILTER (WHERE rating = 2)::int AS c2,
               count(*) FILTER (WHERE rating = 3)::int AS c3, count(*) FILTER (WHERE rating = 4)::int AS c4,
               count(*) FILTER (WHERE rating = 5)::int AS c5
          FROM engagement.reviews
         WHERE course_id = $course_id AND deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL) a
 WHERE s.course_id = $course_id;                    -- index-only on reviews_course_id_rating_created_at_id_public_idx

-- GetRatings
SELECT course_id, review_count, average_rating::text AS average, count_1, count_2, count_3, count_4, count_5
  FROM engagement.course_rating_stats WHERE course_id = ANY($course_ids::uuid[]);

-- Review upsert (UpsertMyReview; V7, V8)
INSERT INTO engagement.reviews AS r (course_id, user_id, rating, body) VALUES ($c, $u, $rating, $body)
ON CONFLICT (course_id, user_id) WHERE deleted_at IS NULL
DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, edited_at = now()
 WHERE (r.rating, r.body) IS DISTINCT FROM (EXCLUDED.rating, EXCLUDED.body)
RETURNING id, old.rating AS previous_rating;        -- old NULL -> ReviewPosted; else ReviewEdited; 0 rows -> unchanged (no-op)
```

### 8.5 Q&A reads (`engagement/qa-queries.ts`)

```sql
-- recent (page n): $vis = deleted_at IS NULL AND moderation_status = 'VISIBLE'
SELECT id, lecture_id, author_id, title, upvote_count, answer_count, accepted_answer_id IS NOT NULL AS resolved,
       last_activity_at, last_activity_at::text AS cursor_at
  FROM engagement.questions
 WHERE course_id = $c AND deleted_at IS NULL AND moderation_status = 'VISIBLE'
   AND ($lecture_id::uuid IS NULL OR lecture_id = $lecture_id)       -- two SQL variants in code, so each hits its own index
   AND (last_activity_at, id) < ($cursor_at::timestamptz, $cursor_id::uuid)
 ORDER BY last_activity_at DESC, id DESC LIMIT $limit;
-- top:        ... AND (upvote_count, id) < ($cv::int, $cid) ORDER BY upvote_count DESC, id DESC
-- unanswered: ... AND answer_count = 0 AND (created_at, id) < (...) ORDER BY created_at DESC, id DESC
-- q=:         ... AND title ILIKE '%' || $q_escaped || '%' (>= 3 chars; escape % _ \)
-- inbox:      course_id = ANY($owned_ids::uuid[]) AND <status filter>, ORDER BY created_at DESC, id DESC
-- Report (R9): SELECT 1 FROM engagement.<subject> WHERE id = $id FOR NO KEY UPDATE;
--              INSERT INTO engagement.<subject>_reports ... ON CONFLICT (subject_id, reporter_id) DO NOTHING;
--              SELECT count(*) FROM engagement.<subject>_reports WHERE subject_id = $id AND status = 'OPEN';   -- >= threshold -> hide
```

### 8.6 Announcement fan-out lease (`notifications/fanout-lease.ts`, P5-D11)

```sql
-- enqueue (AnnouncementPosted handler, inside the claim tx)
INSERT INTO notifications.fanout_jobs (kind, source_event_id, course_id, subject_id, send_email)
VALUES ('ANNOUNCEMENT', $event_id, $course_id, $announcement_id, $send_email)
ON CONFLICT (source_event_id) DO NOTHING;

-- lease (short tx)
WITH next AS (
  SELECT id FROM notifications.fanout_jobs
   WHERE status = 'QUEUED' AND run_after <= now()
   ORDER BY run_after, id LIMIT 1
   FOR UPDATE SKIP LOCKED)
UPDATE notifications.fanout_jobs j
   SET status = 'RUNNING', attempts = j.attempts + 1, lease_owner = $worker_id, lease_expires_at = now() + interval '2 minutes'
  FROM next WHERE j.id = next.id
RETURNING j.id, j.attempts, j.course_id, j.subject_id, j.send_email, j.after_user_id, j.source_event_id;

-- one batch = one tx
SELECT after_user_id FROM notifications.fanout_jobs
 WHERE id = $id AND status = 'RUNNING' AND lease_owner = $worker_id AND attempts = $attempt FOR UPDATE;   -- 0 rows -> lease lost, stop
-- announcement deleted meanwhile (engagement reader) -> mark DONE (below) and stop
SELECT user_id FROM enrollment.enrollments                                        -- via an enrollment worker reader / facade
 WHERE course_id = $course_id AND status = 'ACTIVE' AND ($after::uuid IS NULL OR user_id > $after)
 ORDER BY user_id LIMIT 1000;                                                     -- enrollments_course_id_user_id_active_idx
INSERT INTO notifications.notifications (user_id, app, kind, payload, subject_type, subject_id, source_event_id)
SELECT u, 'STUDENT', 'ANNOUNCEMENT', $payload::jsonb, 'ANNOUNCEMENT', $announcement_id, $source_event_id
  FROM unnest($user_ids::uuid[]) AS u
ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
RETURNING user_id;                                                                -- afterCommit: push + (send_email AND pref) email
UPDATE notifications.fanout_jobs
   SET after_user_id = $last_user_id, processed_count = processed_count + $n, lease_expires_at = now() + interval '2 minutes'
 WHERE id = $id;
-- fewer than 1000 enrollees returned -> also: status = 'DONE', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
COMMIT;

-- reaper (same job, each tick)
UPDATE notifications.fanout_jobs
   SET status           = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
       finished_at      = CASE WHEN attempts >= max_attempts THEN now() END,
       run_after        = now() + make_interval(mins => (2 ^ attempts)::int),
       last_error_code  = 'lease_expired', lease_owner = NULL, lease_expires_at = NULL
 WHERE status = 'RUNNING' AND lease_expires_at < now();
```

### 8.7 Retention and maintenance

```sql
-- NotificationRetentionJob (worker, daily): per batch tx pg_try_advisory_xact_lock(504196069639 /* _07 */)
DELETE FROM notifications.notifications
 WHERE id IN (SELECT id FROM notifications.notifications
               WHERE created_at < now() - interval '180 days' ORDER BY created_at LIMIT 5000);
DELETE FROM notifications.fanout_jobs
 WHERE id IN (SELECT id FROM notifications.fanout_jobs
               WHERE finished_at < now() - interval '30 days' ORDER BY finished_at LIMIT 1000);

-- LearningMaintenanceJob (worker, hourly): per batch tx pg_try_advisory_xact_lock(504196069640 /* _08 */)
UPDATE learning.quiz_attempts a SET status = 'ABANDONED', abandoned_at = now()
  FROM (SELECT id FROM learning.quiz_attempts
         WHERE status = 'IN_PROGRESS' AND started_at < now() - make_interval(hours => $ttl_h::int)
         ORDER BY started_at LIMIT 1000 FOR UPDATE SKIP LOCKED) s       -- a SUBMIT holding the row is skipped (R3)
 WHERE a.id = s.id AND a.status = 'IN_PROGRESS';
SELECT id FROM learning.certificates
 WHERE pdf_rendered_at IS NULL AND issued_at < now() - interval '10 minutes' ORDER BY issued_at LIMIT 100;   -- re-render
```

### 8.8 Consistency queries (ITs, and ops)

```sql
-- stats = recompute (empty = consistent)
SELECT s.course_id FROM engagement.course_rating_stats s
  LEFT JOIN (SELECT course_id, count(*) FILTER (WHERE rating=1) c1, count(*) FILTER (WHERE rating=2) c2, count(*) FILTER (WHERE rating=3) c3,
                    count(*) FILTER (WHERE rating=4) c4, count(*) FILTER (WHERE rating=5) c5
               FROM engagement.reviews WHERE deleted_at IS NULL AND moderation_status='VISIBLE' AND suspended_at IS NULL
              GROUP BY course_id) r USING (course_id)
 WHERE (s.count_1, s.count_2, s.count_3, s.count_4, s.count_5)
       IS DISTINCT FROM (coalesce(r.c1,0), coalesce(r.c2,0), coalesce(r.c3,0), coalesce(r.c4,0), coalesce(r.c5,0));
-- counters = count(*)
SELECT q.id FROM engagement.questions q
 WHERE q.upvote_count <> (SELECT count(*) FROM engagement.question_votes v WHERE v.subject_id = q.id)
    OR q.answer_count <> (SELECT count(*) FROM engagement.answers a WHERE a.question_id = q.id AND a.deleted_at IS NULL AND a.moderation_status = 'VISIBLE')
    OR q.last_activity_at <> greatest(q.created_at, (SELECT max(a.created_at) FROM engagement.answers a
                                                       WHERE a.question_id = q.id AND a.deleted_at IS NULL AND a.moderation_status = 'VISIBLE'));
SELECT a.id FROM engagement.answers a WHERE a.upvote_count <> (SELECT count(*) FROM engagement.answer_votes v WHERE v.subject_id = a.id);
-- certificates: every certificate has a completion (FK; asserts the FK exists) and ACTIVE <=> enrollment ACTIVE (after the worker drained)
SELECT c.id FROM learning.certificates c
  JOIN enrollment.enrollments e ON e.user_id = c.user_id AND e.course_id = c.course_id
 WHERE (c.status = 'ACTIVE') <> (e.status = 'ACTIVE')
   AND NOT EXISTS (SELECT 1 FROM learning.certificate_transitions t WHERE t.certificate_id = c.id AND t.cause = 'ADMIN');
-- reviews suspended <=> enrollment revoked (live reviews)
SELECT r.id FROM engagement.reviews r
  JOIN enrollment.enrollments e ON e.user_id = r.user_id AND e.course_id = r.course_id
 WHERE r.deleted_at IS NULL AND (r.suspended_at IS NOT NULL) <> (e.status = 'REVOKED');
```

---

## 9. Constraint → domain error code (for nestjs-coder)

`err.constraint` is the constraint, index or pseudo-constraint name; deferred names surface at COMMIT.

**Catalog (quiz authoring)**

| Constraint (SQLSTATE)                                                                                          | Domain error                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `courses_working_copy_locked_ck`                                                                               | `course_in_review` 409 / `course_not_editable` (as P2)         |
| `lectures_type_media_asset_id_ck` (media on a QUIZ)                                                            | `lecture_type_mismatch` 422                                    |
| `lectures_type_is_preview_ck`, `revision_lectures_is_preview_ck`                                               | `preview_not_allowed` 422                                      |
| `lecture_quizzes_lecture_id_lecture_type_fk`, `quiz_questions_lecture_id_fk` (23503)                           | `lecture_type_mismatch` 422 (not a QUIZ) / `lecture_not_found` |
| `lecture_quizzes_pass_pct_ck`                                                                                  | `validation_failed` 422                                        |
| `quiz_questions_position_ck`                                                                                   | `quiz_limit_exceeded` 422                                      |
| `quiz_questions_lecture_id_position_uq` (COMMIT)                                                               | `order_mismatch` 409                                           |
| `quiz_questions_prompt_md_ck`, `_explanation_md_ck`                                                            | `validation_failed` 422 (`markdown_not_allowed` is app-side)   |
| `quiz_options_pk` (23505), `quiz_options_position_ck`, `quiz_options_text_ck`                                  | `quiz_options_invalid` 422                                     |
| `quiz_options_question_id_fk` (23503)                                                                          | `quiz_question_not_found` 404                                  |
| `quiz_questions_immutable_ck`, `lecture_quizzes_required_ck`                                                   | 500                                                            |
| `revision_quiz_options_key_ck`, `revision_lectures_quiz_complete_ck` (COMMIT)                                  | `course_not_ready` (a readiness bug: 500 + log)                |
| `revision_quiz_questions_same_tx_ck`, `revision_quiz_options_same_tx_ck`, `revision_lectures_quiz_pass_pct_ck` | 500                                                            |

**Learning**

| Constraint (SQLSTATE)                                                                                                | Domain error                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lecture_progress_coverage_ck`, `_position_seconds_ck`, `_duration_seconds_ck`, `_times_ck`, `_immutable_ck`         | flush: drop the row + log (§8.1); Direct store: 500                                                                                               |
| `lecture_completions_pk`                                                                                             | never surfaces (`ON CONFLICT DO NOTHING`): idempotent 200                                                                                         |
| `lecture_completions_cause_type_ck`                                                                                  | `completion_not_allowed` 422 (the app validates first)                                                                                            |
| `lecture_completions_quiz_attempt_ck`, `_quiz_passed_ck`, `_quiz_attempt_id_user_id_lecture_id_fk`, `_immutable_ck`  | 500                                                                                                                                               |
| `course_completions_pk`                                                                                              | never surfaces (`ON CONFLICT DO NOTHING`)                                                                                                         |
| `quiz_attempts_user_id_lecture_id_open_uq` (23505)                                                                   | resume path: re-read and return the open attempt (200)                                                                                            |
| `quiz_attempts_transition_ck`                                                                                        | 500 (SUBMIT/abandon use `WHERE status='IN_PROGRESS'`; 0 rows → re-read: SUBMITTED = stored result 200, ABANDONED = `attempt_not_in_progress` 409) |
| `quiz_attempts_grading_ck` (COMMIT), `quiz_attempt_questions_same_tx_ck`, `_immutable_ck`, `quiz_attempts_result_ck` | 500                                                                                                                                               |
| `quiz_attempt_selections_pk` (23505), `_attempt_id_question_id_fk` (23503), `_option_position_ck`                    | `quiz_answers_invalid` 422 (app validates first)                                                                                                  |
| `quiz_attempt_selections_attempt_open_ck`                                                                            | `attempt_not_in_progress` 409                                                                                                                     |
| `notes_body_md_ck`, `notes_position_seconds_ck`                                                                      | `validation_failed` 422                                                                                                                           |
| `notes_immutable_ck`                                                                                                 | 500                                                                                                                                               |
| `certificates_user_id_course_id_uq`, `certificates_source_event_id_uq`                                               | never surface (`ON CONFLICT DO NOTHING`, no target)                                                                                               |
| `certificates_public_code_uq` (23505)                                                                                | worker: regenerate the code and retry once                                                                                                        |
| `certificates_user_id_course_id_fk` (23503)                                                                          | worker: non-retryable → DLQ + alert (a completion must precede the event)                                                                         |
| `certificate_transitions_pk` (23505), `_edge_ck`, `_certificate_id_prev_seq_from_status_fk`                          | `invalid_state_transition` 409                                                                                                                    |
| `certificate_transitions_reason_ck`                                                                                  | `validation_failed` 422 (admin reason)                                                                                                            |
| `certificate_transitions_reinstate_cause_ck` (COMMIT)                                                                | worker: pre-check and skip; if it surfaces → DLQ                                                                                                  |
| `certificates_status_log_ck`, `certificates_immutable_ck`, `certificates_pdf_ck`, `certificate_transitions_actor_ck` | 500 / worker DLQ                                                                                                                                  |

**Engagement**

| Constraint (SQLSTATE)                                                                                                    | Domain error                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `reviews_course_id_user_id_live_uq`, `review_replies_review_id_live_uq`                                                  | upsert path (never surfaces with the ON CONFLICT; else retry as update) |
| `reviews_rating_ck`, `reviews_body_ck`, `review_replies_body_ck`                                                         | `validation_failed` 422                                                 |
| `reviews_immutable_ck`, `review_replies_immutable_ck` (row deleted)                                                      | `review_not_found` / `reply_not_found` 404 (re-read); otherwise 500     |
| `questions_title_ck`, `questions_body_md_ck`, `answers_body_md_ck`, `announcements_title_ck`, `announcements_body_md_ck` | `validation_failed` 422                                                 |
| `questions_immutable_ck`, `answers_immutable_ck`                                                                         | `question_not_found` / `answer_not_found` 404 if deleted; else 500      |
| `questions_id_accepted_answer_id_fk` (23503), `questions_accepted_answer_visible_ck`                                     | `answer_not_found` 404                                                  |
| `answers_question_id_fk` (23503)                                                                                         | `question_not_found` 404                                                |
| `question_votes_pk`, `answer_votes_pk`, `wishlist_items_pk`, `*_reports_subject_id_reporter_id_uq`                       | idempotent (`ON CONFLICT DO NOTHING`): 204 / 200                        |
| `question_votes_own_content_ck`, `answer_votes_own_content_ck`                                                           | `cannot_vote_own_content` 422                                           |
| `*_reports_own_content_ck`                                                                                               | `cannot_report_own_content` 422                                         |
| `*_votes_subject_id_fk`, `*_reports_subject_id_fk` (23503)                                                               | the subject's `*_not_found` 404                                         |
| `*_reports_comment_ck`, `*_reports_reason_ck`                                                                            | `validation_failed` 422                                                 |
| `*_reports_transition_ck`                                                                                                | `invalid_state_transition` 409                                          |
| `moderation_actions_reason_ck`                                                                                           | `validation_failed` 422                                                 |
| `moderation_status_log_ck`, `moderation_actions_subject_ck` (COMMIT), `questions_counters_ck`, `answers_counters_ck`     | 500                                                                     |
| `announcements_immutable_ck`                                                                                             | `announcement_not_found` 404 if already deleted; else 500               |
| `course_rating_stats_counts_ck`                                                                                          | worker non-retryable → DLQ                                              |

**Notifications**

| Constraint (SQLSTATE)                                                               | Domain error                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `notifications_user_id_kind_source_event_id_uq`, `fanout_jobs_source_event_id_uq`   | never surface (`ON CONFLICT DO NOTHING`)                                                |
| `notifications_payload_ck`, `notifications_kind_app_ck`, `notifications_subject_ck` | worker non-retryable → DLQ + alert (payload builder bug)                                |
| `notifications_immutable_ck`                                                        | 500 (mark-read must use `WHERE read_at IS NULL`; redaction `WHERE redacted_at IS NULL`) |
| `notification_preferences_category_ck`, `_channel_ck`                               | `validation_failed` 422                                                                 |
| `fanout_jobs_status_transition_ck`, `fanout_jobs_lease_ck`                          | 500 (fenced updates make them unreachable)                                              |

**Other:** 42501 from append-only guards → 500. 40P01 / 40001 → retry the transaction once.

---

## 10. Advisory locks (confirmed)

**Single-bigint job keys.** Each job takes `pg_try_advisory_xact_lock(key)` per batch transaction. Add them to `ADVISORY_LOCK_KEYS` and as constants in `@udemy/db`.

| Key                              | Owner                                                                          | Usage                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `0x75646d79_06` = `504196069638` | **api** `ProgressFlushJob` (`LEARNING_PROGRESS_FLUSH_LOCK_KEY` in `@udemy/db`) | Taken **before** the Redis claim. False = skip the tick. One flush DB batch at a time across replicas. |
| `0x75646d79_07` = `504196069639` | **worker** `NotificationRetentionJob`                                          | Daily; batched deletes of notifications > 180 d and finished fan-out jobs > 30 d (§8.7).               |
| `0x75646d79_08` = `504196069640` | **worker** `LearningMaintenanceJob`                                            | Hourly; abandon stale attempts, re-render missing PDFs (§8.7).                                         |

`_09`–`_0f` remain reserved. The fan-out jobs need no global key: rows are leased with `SKIP LOCKED`.

**Two-int per-entity mutexes.** These follow the `'mqta'` convention: the class is a 4-ASCII-char constant, the second key is `hashtext(...)`. They never collide with the bigint keys.

| Class (ASCII → int4)    | Second key                                  | Serialises                                                        |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `'lrnc'` = `1819438691` | `hashtext(user_id \|\| ':' \|\| course_id)` | Every lecture-completion write + `EvaluateCourseCompletion` (R1). |
| `'anno'` = `1634627183` | `hashtext(course_id)`                       | Announcement 4/30 d quota (R12).                                  |
| `'note'` = `1852798053` | `hashtext(user_id \|\| ':' \|\| course_id)` | Notes cap 500 per (user, course).                                 |
| `'wish'` = `2003399528` | `hashtext(user_id)`                         | Wishlist cap 1000.                                                |

Design §4/§5 wrote `hashtext('lrnc')` / `('anno', …)` for the class. I use the fixed ASCII constants instead, as `MEDIA_QUOTA_LOCK_CLASS` does, so the class is visible in `pg_locks` and stable across PG versions.

---

## Hand-off to sql-ops (P5-T4)

1. **Probe §0 V1–V10 first** on PG 18, in a throwaway DB, and record the results in the migration header as 0003 did. Adopt the fallbacks where needed (V4: prefer the `::bit(n)::varbit` body of `fit_coverage` if it behaves as documented; V6: SECURITY DEFINER counters).
2. **Create the migration** `packages/db/src/migrations/2026_10_xx_0005_learning_engagement_notifications.ts`, in the 0003/0004 style (`Kysely<any>`, one `sql` per statement, grouped arrays, `run()`), in the exact order of §1.
   - Generate the four report tables from one template, with exact names.
   - Register it in `migrations/index.ts`.
   - Write `down()` in the §1 down order. It must restore the 0003 `working_copy_guard` body and CHECKs verbatim.
3. **Codegen:** extend `--overrides` per §7, then run `pnpm --filter @udemy/db codegen`.
4. **Operational SQL in `@udemy/db`:**
   - `src/learning/{progress-upsert, completion, consumption, curriculum-progress, maintenance}.ts` (§8.1–§8.3, §8.7; `curriculum-progress` = the one-GROUP-BY `getPercents` over `unnest(course_ids, lecture_ids)` joined to `lecture_completions` by PK);
   - `src/engagement/{rating-recompute, qa-queries, reports}.ts` (§8.4, §8.5);
   - `src/notifications/{fanout-lease, retention}.ts` (§8.6, §8.7);
   - `src/*/consistency.ts` (§8.8);
   - lock constants (§10).
5. **Integration tests, at minimum:**
   - Coverage: OR of overlapping bitmaps; asset swap resets; an older batch does not overwrite newer data; `fit_coverage` pads and truncates; `bit_count`; an unequal-length OR is never reached.
   - `lecture_progress_coverage_ck` rejects a wrong length.
   - Counters: 20 parallel votes by one user give 1; N users in parallel give N; parallel answers give the exact count; hiding the accepted answer clears it; the app UPDATE of `upvote_count` fails with `questions_counters_ck`.
   - Rating recompute equals the §8.8 query after random review ops, including parallel recomputes.
   - Deferred checks: a quiz key with 1 option, 0 correct on SINGLE, 2 correct on SINGLE, or non-contiguous positions fails at COMMIT; a QUIZ revision lecture with 0 questions fails; a later insert into a committed key fails `_same_tx_ck`; a QUIZ lecture without settings fails.
   - Certificates: status without a transition fails `certificates_status_log_ck`; a regrant reinstate after an ADMIN revoke fails; an admin action without a reason fails; a duplicate ISSUE fails.
   - Quiz attempts: parallel starts give 1 open attempt; submit vs abandon has one winner; questions added outside the start tx fail; `correct_count` ≠ graded rows fails at COMMIT; `score_pct`/`passed` rounding at 69.5/70 and 2/3 of 70%.
   - Completions: MANUAL on VIDEO fails; QUIZ_PASSED with a failed attempt fails; parallel completion of the last two lectures gives exactly one `course_completions` row.
   - Moderation: a status change without an action fails at COMMIT; 3 concurrent reporters auto-hide exactly once (with the subject lock).
   - Fan-out: lease expiry mid-batch → no duplicate notifications; the cursor never moves back; retention deletes in batches.
   - Append-only and guards: UPDATE/DELETE/TRUNCATE on every append-only table give 42501; the notifications read-once and redact-once rules hold.
6. **Pass to nestjs-coder:**
   - §8–§10 and the §9 map: T10/T11 learning, T12/T13 engagement, T14 notifications, T15 worker, T16 consumption.
   - Behaviour changes vs design §5/§6:
     - lock classes are ASCII constants;
     - take `_06` before the Redis claim;
     - `ReportContent` locks the subject row first;
     - the regrant reinstate pre-checks the head cause;
     - `review_replies` has its own id;
     - `notifications` has no `category` column (map it from `kind`);
     - `lecture_completions.quiz_attempt_id` must be set for QUIZ_PASSED;
     - quiz attempt questions must be inserted in the START transaction with `started_at` defaulted;
     - all timestamps use SQL `now()`;
     - everything runs at READ COMMITTED.

## Open points: resolved (2026-10-24)

| #   | Point                                        | Resolution                                                                                                                                                                                                        |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Line breaks in review and reply bodies       | Allowed: use the markdown CHECK form (`translate(…) !~ '[[:cntrl:]]'`, tab/LF/CR permitted). Paragraphs are normal in reviews.                                                                                    |
| 2   | Announcement moderation                      | **User:** delete only. No `moderation_status`, no `announcement_reports`; ANNOUNCEMENT stays out of `moderation_actions.subject_type`.                                                                            |
| 3   | Locked notification categories               | Enforced in the app, not by a CHECK. The contracts (P5-T2) lock only MODERATION, on both channels.                                                                                                                |
| 4   | Admin-revoked certificate on re-enrollment   | **User:** admin revocations stick. Automatic reinstatement only undoes REFUND/CHARGEBACK revocations; keep `certificate_transitions_reinstate_cause_ck`.                                                          |
| 5   | Replacing `enrollments_course_id_active_idx` | Accepted: `(course_id, user_id) WHERE status='ACTIVE'` serves every query the old index served, plus the fan-out.                                                                                                 |
| 6   | Fan-out reads enrollments                    | P5-T15 adds an enrollment reader (`listActiveEnrolleesAfter(courseId, afterUserId, limit)`).                                                                                                                      |
| 7   | Redis claim lost on crash                    | P5-T10 uses a processing-set claim pattern (move dirty keys to a per-run processing set, delete after commit, re-queue leftovers on start).                                                                       |
| 8   | `working_copy_guard` replaced                | P5-T4 re-runs the 0003 integration tests against 0005 (needs the stack; on the run-at-the-end list).                                                                                                              |
| 9   | Lock constants                               | Checked: 'lrnc' 1819438691, 'anno' 1634627183, 'note' 1852798053, 'wish' 2003399528, `_06`/`_07`/`_08` = 504196069638/39/40. The only existing two-int classes are 'mqta' and 'catg', so there are no collisions. |

Contract alignment (from P5-T2): event timestamps use named fields (`postedAt`, `revokedAt`, …); the notification app values are uppercase STUDENT/INSTRUCTOR/ADMIN; the subject types are QUESTION, ANSWER, REVIEW, REVIEW_REPLY, ANNOUNCEMENT, CERTIFICATE, MEDIA_ASSET; excerpts are at most 280 chars; payloads at most 4096 bytes. P5-T4 must match these in the CHECKs.
