# P2-T1: Final schema design for migration `0003_catalog_media`

I didn't run anything against a database. Two PG 18 points are checked against the official docs; two more come from the PG source and are not tested, so they are in the Hand-off as required tests:

- **Checked in the docs:** generated columns default to `VIRTUAL` in PG 18, and `RETURNING OLD.col` exists.
- **Not tested (PG source only):** a FK on a STORED generated column, and `UNIQUE NULLS NOT DISTINCT … DEFERRABLE`.

**Inputs read:**

- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-2-catalog-media-design.md` (all of it, including §13)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-1-schema-design.md`
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/migrations/2026_10_09_0001_init.ts`
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/migrations/2026_10_10_0002_identity_access_users.ts`
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/database.ts`
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/package.json` (kysely-codegen 0.20 with `--camel-case`)
- `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/infra/postgres/roles.sql`
- compose (`postgres:18.6-alpine`)
- PG 18 docs: sql-createtable, ddl-generated-columns, functions-uuid, sql-update

**Facts that shape the design:**

- `catalog`, `media`, `pg_trgm`, `public.set_updated_at()` and `public.forbid_append_only_mutation()` already exist (0001/0002). They are reused, not recreated.
- **PG 18: `GENERATED ALWAYS AS (…)` defaults to VIRTUAL** (from the docs). Per the PG source (`tablecmds.c`), FKs on virtual generated columns are rejected, and on STORED ones only `ON UPDATE CASCADE/SET NULL/SET DEFAULT` and `ON DELETE SET NULL/SET DEFAULT` are rejected. The category depth trick therefore must say `STORED` and use only RESTRICT / NO ACTION. That is the design below; a fallback trigger is in §6.
- **PG 18 docs do not promise that `uuidv7()` is monotonic within a session.** Nothing below relies on id order for correctness. Course history is a hash-linked chain (`prev_transition_id`), not "ORDER BY occurred_at, id".
- **PG 18 `RETURNING OLD.col`** is documented. Cleanup step A uses it.

**Naming:**

- Same convention as Phase 1: `<table>_<cols>_<pk|fk|uq|ck|idx>`.
- Trigger-raised pseudo-constraints use `_ck`.
- The longest name is `course_transitions_course_id_prev_transition_id_from_status_fk` (62 chars), so no shortened prefix is needed.

---

## 1. Complete DDL

```sql
-- =====================================================================
-- 0. Shared helper (public). forbid_append_only_mutation / set_updated_at already exist.
-- =====================================================================
CREATE FUNCTION public.forbid_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[1]
    USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0], SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
END
$$;
COMMENT ON FUNCTION public.forbid_row_change() IS
  'Generic BEFORE-trigger body for triggers whose WHEN clause detects a forbidden change. Raises check_violation (23514) with CONSTRAINT = TG_ARGV[0] and message TG_ARGV[1], so err.constraint maps like a CHECK. Used for immutable columns, frozen slugs, state-machine edges and the review lock.';

-- =====================================================================
-- 1. catalog.categories
-- =====================================================================
CREATE TABLE catalog.categories (
  id           uuid        NOT NULL DEFAULT uuidv7(),
  parent_id    uuid        NULL,
  depth        smallint    NOT NULL,
  parent_depth smallint    NOT NULL GENERATED ALWAYS AS ((depth - 1)::smallint) STORED,  -- STORED is mandatory on PG 18
  slug         text        NOT NULL,
  name         text        NOT NULL,
  position     integer     NOT NULL,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_pk                          PRIMARY KEY (id),
  CONSTRAINT categories_id_depth_uq                 UNIQUE (id, depth),          -- composite FK target (self + courses + revisions)
  CONSTRAINT categories_slug_uq                     UNIQUE (slug),
  CONSTRAINT categories_parent_id_position_uq       UNIQUE NULLS NOT DISTINCT (parent_id, position) DEFERRABLE INITIALLY DEFERRED,
  -- parent must exist AND have depth = my depth - 1 (roots: parent_id NULL -> FK skipped)
  CONSTRAINT categories_parent_id_parent_depth_fk   FOREIGN KEY (parent_id, parent_depth)
                                                    REFERENCES catalog.categories (id, depth) ON DELETE RESTRICT,
  CONSTRAINT categories_depth_ck                    CHECK (depth IN (1, 2)),
  CONSTRAINT categories_depth_parent_id_ck          CHECK ((depth = 1) = (parent_id IS NULL)),
  CONSTRAINT categories_slug_ck                     CHECK (char_length(slug) <= 60 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT categories_name_ck                     CHECK (char_length(name) BETWEEN 2 AND 60 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  CONSTRAINT categories_position_ck                 CHECK (position BETWEEN 0 AND 999)
);
-- No extra indexes: the tree is tiny (full scan); the FK on (parent_id, parent_depth) is served by categories_parent_id_position_uq.
CREATE TRIGGER categories_set_updated_at_trg BEFORE UPDATE ON catalog.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE catalog.categories IS
  'Admin-managed two-level category tree. Depth is enforced declaratively: parent_depth = depth-1 (stored generated) + composite FK to (id, depth). Cycles are impossible (a depth-2 parent has depth 1 and no parent). Hard-deleted only when unused (all inbound FKs RESTRICT).';
COMMENT ON COLUMN catalog.categories.parent_depth IS 'Generated FK helper (= depth - 1). Never written by the app. Makes the self-FK reject a parent of the wrong depth.';
COMMENT ON COLUMN catalog.categories.position IS 'Contiguous 0..n-1 among siblings; unique per parent (roots share parent NULL via NULLS NOT DISTINCT), deferred so a reorder can permute in one transaction.';
COMMENT ON COLUMN catalog.categories.is_active IS 'false = hidden from browse and not assignable/submittable. Existing live revisions keep it.';

-- =====================================================================
-- 2. catalog.courses (working copy + lifecycle). Revision FKs are added after course_revisions exists.
-- =====================================================================
CREATE TABLE catalog.courses (
  id                    uuid        NOT NULL DEFAULT uuidv7(),
  owner_id              uuid        NOT NULL,
  slug                  text        NOT NULL,
  title                 text        NOT NULL,
  subtitle              text        NULL,
  description_md        text        NULL,
  language              text        NULL,
  level                 text        NULL,
  category_id           uuid        NULL,
  category_depth        smallint    NOT NULL DEFAULT 2,
  thumbnail_asset_id    uuid        NULL,                     -- soft ref to media.assets (D12)
  status                text        NOT NULL DEFAULT 'DRAFT',
  version               integer     NOT NULL DEFAULT 1,
  published_revision_id uuid        NULL,
  pending_revision_id   uuid        NULL,
  first_published_at    timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz NULL,
  CONSTRAINT courses_pk                            PRIMARY KEY (id),
  CONSTRAINT courses_owner_id_fk                   FOREIGN KEY (owner_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT courses_category_id_category_depth_fk FOREIGN KEY (category_id, category_depth)
                                                   REFERENCES catalog.categories (id, depth) ON DELETE RESTRICT,
  CONSTRAINT courses_category_depth_ck             CHECK (category_depth = 2),
  CONSTRAINT courses_slug_ck                       CHECK (char_length(slug) <= 60 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT courses_title_ck                      CHECK (char_length(title) BETWEEN 5 AND 60 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT courses_subtitle_ck                   CHECK (subtitle IS NULL OR (char_length(subtitle) BETWEEN 10 AND 120 AND subtitle = btrim(subtitle) AND subtitle !~ '[[:cntrl:]]')),
  CONSTRAINT courses_description_md_ck             CHECK (description_md IS NULL OR char_length(description_md) BETWEEN 1 AND 20000),
  CONSTRAINT courses_language_ck                   CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  CONSTRAINT courses_level_ck                      CHECK (level IS NULL OR level IN ('BEGINNER','INTERMEDIATE','EXPERT','ALL_LEVELS')),
  CONSTRAINT courses_status_ck                     CHECK (status IN ('DRAFT','IN_REVIEW','PUBLISHED','REJECTED','ARCHIVED')),
  CONSTRAINT courses_version_ck                    CHECK (version >= 1),
  -- status <-> pointer shape (the full log equivalence is the deferred courses_status_log_ck)
  CONSTRAINT courses_status_pointers_ck            CHECK (
       (status IN ('DRAFT','REJECTED') AND pending_revision_id IS NULL     AND published_revision_id IS NULL)
    OR (status = 'IN_REVIEW'           AND pending_revision_id IS NOT NULL AND published_revision_id IS NULL)
    OR (status = 'PUBLISHED'           AND published_revision_id IS NOT NULL)
    OR (status = 'ARCHIVED'            AND published_revision_id IS NOT NULL AND pending_revision_id IS NULL)),
  CONSTRAINT courses_revision_pointers_ck          CHECK (pending_revision_id <> published_revision_id),   -- NULLs pass
  CONSTRAINT courses_first_published_at_ck         CHECK ((first_published_at IS NULL) = (published_revision_id IS NULL)),
  CONSTRAINT courses_deleted_at_ck                 CHECK (deleted_at IS NULL OR (status IN ('DRAFT','REJECTED') AND thumbnail_asset_id IS NULL))
);
-- Landing by slug; slug uniqueness among non-deleted courses (23505 -> slug_taken)
CREATE UNIQUE INDEX courses_slug_active_uq ON catalog.courses (slug) WHERE deleted_at IS NULL;
-- ListMyCourses keyset: WHERE owner_id=$1 AND deleted_at IS NULL AND (updated_at,id) < ($c,$id) ORDER BY updated_at DESC, id DESC
CREATE INDEX courses_owner_id_updated_at_id_idx ON catalog.courses (owner_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
-- BrowseCourses keyset: WHERE status='PUBLISHED' AND (first_published_at,id) < (...) ORDER BY first_published_at DESC, id DESC
CREATE INDEX courses_first_published_at_id_idx ON catalog.courses (first_published_at DESC, id DESC) WHERE status = 'PUBLISHED';
-- Admin review queue keyset (oldest first) on the uuidv7 revision id: WHERE pending_revision_id > $cursor ORDER BY pending_revision_id
CREATE UNIQUE INDEX courses_pending_revision_id_uq ON catalog.courses (pending_revision_id) WHERE pending_revision_id IS NOT NULL;
-- One course per thumbnail asset; worker "course by thumbnail asset" lookup (processing-failed mailer)
CREATE UNIQUE INDEX courses_thumbnail_asset_id_uq ON catalog.courses (thumbnail_asset_id) WHERE thumbnail_asset_id IS NOT NULL;
-- FK index for categories delete (category_in_use) + admin courseCount per category
CREATE INDEX courses_category_id_idx ON catalog.courses (category_id) WHERE category_id IS NOT NULL;
-- AdminSearchCourses default order (created_at DESC, id DESC) with optional status filter
CREATE INDEX courses_created_at_id_idx ON catalog.courses (created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- AdminSearchCourses q (>= 3 chars) on the working title
CREATE INDEX courses_title_trgm_idx ON catalog.courses USING gin (title gin_trgm_ops);

CREATE TRIGGER courses_set_updated_at_trg BEFORE UPDATE ON catalog.courses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER courses_immutable_trg BEFORE UPDATE ON catalog.courses
  FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.forbid_row_change('courses_immutable_ck', 'courses.owner_id/created_at are immutable');
CREATE TRIGGER courses_slug_frozen_trg BEFORE UPDATE OF slug ON catalog.courses
  FOR EACH ROW WHEN (OLD.first_published_at IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug)
  EXECUTE FUNCTION public.forbid_row_change('courses_slug_frozen_ck', 'slug is frozen after first publication');
-- D2 review lock for the header fields (children are guarded by catalog.working_copy_guard below)
CREATE TRIGGER courses_working_copy_lock_trg BEFORE UPDATE ON catalog.courses
  FOR EACH ROW WHEN ((OLD.pending_revision_id IS NOT NULL OR OLD.status = 'ARCHIVED' OR OLD.deleted_at IS NOT NULL)
                 AND (OLD.title, OLD.subtitle, OLD.description_md, OLD.language, OLD.level,
                      OLD.category_id, OLD.thumbnail_asset_id, OLD.slug)
                     IS DISTINCT FROM
                     (NEW.title, NEW.subtitle, NEW.description_md, NEW.language, NEW.level,
                      NEW.category_id, NEW.thumbnail_asset_id, NEW.slug))
  EXECUTE FUNCTION public.forbid_row_change('courses_working_copy_locked_ck', 'course working copy is locked (in review, archived or deleted)');

COMMENT ON TABLE catalog.courses IS
  'Course aggregate root: the instructor''s working copy plus lifecycle pointers. Public/student reads use ONLY published_revision_id. status, pending_revision_id, published_revision_id, first_published_at and deleted_at are guarded materialisations of catalog.course_transitions (documented 3NF exception), verified at COMMIT by courses_status_log_ck. Never hard-deleted.';
COMMENT ON COLUMN catalog.courses.slug IS 'Generated from the title; editable until first_published_at is set, then frozen (courses_slug_frozen_ck). Unique among non-deleted courses.';
COMMENT ON COLUMN catalog.courses.category_depth IS 'Always 2. FK helper so the category FK only accepts depth-2 (leaf) categories.';
COMMENT ON COLUMN catalog.courses.thumbnail_asset_id IS 'Soft reference to media.assets (no cross-schema FK, D12). Consistency via media.asset_usages(consumer_type=catalog.course_thumbnail). Nulled when the course is soft-deleted.';
COMMENT ON COLUMN catalog.courses.version IS 'Optimistic-concurrency token; bumped by every mutating use case (expectedVersion).';
COMMENT ON COLUMN catalog.courses.pending_revision_id IS 'Revision currently in review (at most one). = the SUBMIT revision with no decision transition.';
COMMENT ON COLUMN catalog.courses.published_revision_id IS 'Live revision. = revision of the APPROVE transition with the highest revision_no. Never returns to NULL once set.';
COMMENT ON COLUMN catalog.courses.first_published_at IS '= occurred_at of the first APPROVE transition. Freezes the slug; blocks hard-delete semantics (archive only).';
COMMENT ON COLUMN catalog.courses.deleted_at IS 'Soft delete (never-published courses only). = occurred_at of the DELETE transition.';

-- =====================================================================
-- 3. catalog.course_bullets
-- =====================================================================
CREATE TABLE catalog.course_bullets (
  course_id uuid     NOT NULL,
  kind      text     NOT NULL,
  position  smallint NOT NULL,
  text      text     NOT NULL,
  CONSTRAINT course_bullets_pk           PRIMARY KEY (course_id, kind, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT course_bullets_course_id_fk FOREIGN KEY (course_id) REFERENCES catalog.courses (id) ON DELETE RESTRICT,
  CONSTRAINT course_bullets_kind_ck      CHECK (kind IN ('OUTCOME','REQUIREMENT')),
  CONSTRAINT course_bullets_position_ck  CHECK (position BETWEEN 0 AND 9),          -- caps the list at 10
  CONSTRAINT course_bullets_text_ck      CHECK (char_length(text) BETWEEN 1 AND 160 AND text = btrim(text) AND text !~ '[[:cntrl:]]')
);
COMMENT ON TABLE catalog.course_bullets IS
  'Working-copy outcomes/requirements, 0..10 each, positions contiguous. Replaced wholesale (DELETE + INSERT) by UpdateCourseDetails; no own timestamps (courses.updated_at/version cover them). Deferrable PK cannot be an ON CONFLICT arbiter.';

-- =====================================================================
-- 4. catalog.sections
-- =====================================================================
CREATE TABLE catalog.sections (
  id         uuid        NOT NULL DEFAULT uuidv7(),
  course_id  uuid        NOT NULL,
  title      text        NOT NULL,
  objective  text        NULL,
  position   integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sections_pk                    PRIMARY KEY (id),
  CONSTRAINT sections_course_id_id_uq       UNIQUE (course_id, id),     -- composite FK target for lectures
  CONSTRAINT sections_course_id_position_uq UNIQUE (course_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT sections_course_id_fk          FOREIGN KEY (course_id) REFERENCES catalog.courses (id) ON DELETE RESTRICT,
  CONSTRAINT sections_title_ck              CHECK (char_length(title) BETWEEN 1 AND 80 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT sections_objective_ck          CHECK (objective IS NULL OR (char_length(objective) BETWEEN 1 AND 200 AND objective = btrim(objective))),
  CONSTRAINT sections_position_ck           CHECK (position BETWEEN 0 AND 49)   -- contiguous positions => max 50 sections
);
CREATE TRIGGER sections_set_updated_at_trg BEFORE UPDATE ON catalog.sections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER sections_immutable_trg BEFORE UPDATE ON catalog.sections
  FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.forbid_row_change('sections_immutable_ck', 'sections.course_id/created_at are immutable');
COMMENT ON TABLE catalog.sections IS 'Working-copy curriculum sections. Hard-deleted (published versions survive in revision_sections). Positions contiguous 0..n-1 per course.';

-- =====================================================================
-- 5. catalog.lectures
-- =====================================================================
CREATE TABLE catalog.lectures (
  id             uuid        NOT NULL DEFAULT uuidv7(),
  course_id      uuid        NOT NULL,
  section_id     uuid        NOT NULL,
  type           text        NOT NULL,
  title          text        NOT NULL,
  description_md text        NULL,
  is_preview     boolean     NOT NULL DEFAULT false,
  position       integer     NOT NULL,
  media_asset_id uuid        NULL,                 -- soft ref to media.assets (D12)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lectures_pk                       PRIMARY KEY (id),
  CONSTRAINT lectures_id_type_uq               UNIQUE (id, type),        -- composite FK target for lecture_articles
  CONSTRAINT lectures_section_id_position_uq   UNIQUE (section_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT lectures_course_id_section_id_fk  FOREIGN KEY (course_id, section_id)
                                               REFERENCES catalog.sections (course_id, id) ON DELETE RESTRICT,
  CONSTRAINT lectures_type_ck                  CHECK (type IN ('VIDEO','ARTICLE','RESOURCE')),
  CONSTRAINT lectures_title_ck                 CHECK (char_length(title) BETWEEN 1 AND 80 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT lectures_description_md_ck        CHECK (description_md IS NULL OR char_length(description_md) BETWEEN 1 AND 2000),
  CONSTRAINT lectures_position_ck              CHECK (position BETWEEN 0 AND 99),   -- max 100 per section
  CONSTRAINT lectures_type_media_asset_id_ck   CHECK (type <> 'ARTICLE' OR media_asset_id IS NULL),
  CONSTRAINT lectures_type_is_preview_ck       CHECK (NOT is_preview OR type <> 'RESOURCE')
);
-- Curriculum read / course-wide counts (<= 500) / DeleteCourse media detach
CREATE INDEX lectures_course_id_idx ON catalog.lectures (course_id);
-- One lecture per asset; worker "lecture by asset" lookup (processing-failed mailer)
CREATE UNIQUE INDEX lectures_media_asset_id_uq ON catalog.lectures (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE TRIGGER lectures_set_updated_at_trg BEFORE UPDATE ON catalog.lectures
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER lectures_immutable_trg BEFORE UPDATE ON catalog.lectures
  FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.type IS DISTINCT FROM NEW.type
                     OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.forbid_row_change('lectures_immutable_ck', 'lectures.course_id/type/created_at are immutable');

COMMENT ON TABLE catalog.lectures IS 'Working-copy lectures. id is stable across revisions (Phase 5 progress keys on it). Hard-deleted; published versions survive in revision_lectures.';
COMMENT ON COLUMN catalog.lectures.course_id IS 'Functionally determined by section_id (documented 3NF exception): kept for the composite FK that pins a lecture to its course and for cheap course-scoped child loads. Cannot drift (composite FK + immutable).';
COMMENT ON COLUMN catalog.lectures.media_asset_id IS 'Soft reference to media.assets. VIDEO -> LECTURE_VIDEO, RESOURCE -> LECTURE_RESOURCE (app + asset_usages purpose check). Mirrors exactly one media.asset_usages(catalog.lecture, id) row.';
COMMENT ON COLUMN catalog.lectures.is_preview IS 'Free preview (VIDEO/ARTICLE only, <= 10 per course - app under course lock).';

-- =====================================================================
-- 6. catalog.lecture_articles
-- =====================================================================
CREATE TABLE catalog.lecture_articles (
  lecture_id   uuid        NOT NULL,
  lecture_type text        NOT NULL DEFAULT 'ARTICLE',
  body_md      text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lecture_articles_pk                         PRIMARY KEY (lecture_id),
  CONSTRAINT lecture_articles_lecture_id_lecture_type_fk FOREIGN KEY (lecture_id, lecture_type)
                                                         REFERENCES catalog.lectures (id, type) ON DELETE CASCADE,
  CONSTRAINT lecture_articles_lecture_type_ck            CHECK (lecture_type = 'ARTICLE'),
  CONSTRAINT lecture_articles_body_md_ck                 CHECK (char_length(body_md) <= 100000)
);
CREATE TRIGGER lecture_articles_set_updated_at_trg BEFORE UPDATE ON catalog.lecture_articles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE catalog.lecture_articles IS 'Markdown body of ARTICLE lectures (1:0..1). Composite FK to lectures(id, type) with lecture_type pinned to ARTICLE: a body can only hang off an ARTICLE lecture. Cascades with the lecture.';
COMMENT ON COLUMN catalog.lecture_articles.lecture_type IS 'Always ARTICLE. FK helper only.';

-- =====================================================================
-- 7. Review lock for working-copy children (D2), DB backstop for the app's course-row mutex
-- =====================================================================
CREATE FUNCTION catalog.working_copy_guard() RETURNS trigger
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
$$;
COMMENT ON FUNCTION catalog.working_copy_guard() IS
  'BEFORE row trigger on course_bullets/sections/lectures/lecture_articles: rejects writes while the course has a pending revision, is ARCHIVED or soft-deleted (courses_working_copy_locked_ck). Backstop for invariant 1; the app still checks first to return course_in_review vs course_not_editable.';
CREATE TRIGGER course_bullets_working_copy_trg  BEFORE INSERT OR UPDATE OR DELETE ON catalog.course_bullets
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();
CREATE TRIGGER sections_working_copy_trg        BEFORE INSERT OR UPDATE OR DELETE ON catalog.sections
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();
CREATE TRIGGER lectures_working_copy_trg        BEFORE INSERT OR UPDATE OR DELETE ON catalog.lectures
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();
CREATE TRIGGER lecture_articles_working_copy_trg BEFORE INSERT OR UPDATE OR DELETE ON catalog.lecture_articles
  FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard();

-- =====================================================================
-- 8. Immutable revision snapshots
-- =====================================================================
CREATE TABLE catalog.course_revisions (
  id                 uuid        NOT NULL DEFAULT uuidv7(),
  course_id          uuid        NOT NULL,
  revision_no        integer     NOT NULL,
  kind               text        NOT NULL,
  content_hash       bytea       NOT NULL,
  title              text        NOT NULL,
  subtitle           text        NOT NULL,
  description_md     text        NOT NULL,
  language           text        NOT NULL,
  level              text        NOT NULL,
  category_id        uuid        NOT NULL,
  category_depth     smallint    NOT NULL DEFAULT 2,
  thumbnail_asset_id uuid        NOT NULL,          -- soft ref, pinned by asset_usages(catalog.course_revision)
  submitter_note     text        NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_revisions_pk                             PRIMARY KEY (id),
  CONSTRAINT course_revisions_course_id_id_uq                UNIQUE (course_id, id),          -- composite FK target
  CONSTRAINT course_revisions_course_id_revision_no_uq       UNIQUE (course_id, revision_no), -- also the course_id FK index
  CONSTRAINT course_revisions_course_id_fk                   FOREIGN KEY (course_id) REFERENCES catalog.courses (id) ON DELETE RESTRICT,
  CONSTRAINT course_revisions_category_id_category_depth_fk  FOREIGN KEY (category_id, category_depth)
                                                             REFERENCES catalog.categories (id, depth) ON DELETE RESTRICT,
  CONSTRAINT course_revisions_category_depth_ck              CHECK (category_depth = 2),
  CONSTRAINT course_revisions_revision_no_ck                 CHECK (revision_no >= 1),
  CONSTRAINT course_revisions_kind_ck                        CHECK (kind IN ('INITIAL','UPDATE')),
  CONSTRAINT course_revisions_content_hash_ck                CHECK (octet_length(content_hash) = 32),
  CONSTRAINT course_revisions_title_ck                       CHECK (char_length(title) BETWEEN 5 AND 60 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT course_revisions_subtitle_ck                    CHECK (char_length(subtitle) BETWEEN 10 AND 120 AND subtitle = btrim(subtitle) AND subtitle !~ '[[:cntrl:]]'),
  CONSTRAINT course_revisions_description_md_ck              CHECK (char_length(description_md) BETWEEN 200 AND 20000),  -- md length >= plain length
  CONSTRAINT course_revisions_language_ck                    CHECK (language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  CONSTRAINT course_revisions_level_ck                       CHECK (level IN ('BEGINNER','INTERMEDIATE','EXPERT','ALL_LEVELS')),
  CONSTRAINT course_revisions_submitter_note_ck              CHECK (submitter_note IS NULL OR char_length(submitter_note) BETWEEN 1 AND 1000)
);
-- FK index for categories delete (category_in_use) + browse/landing by category
CREATE INDEX course_revisions_category_id_idx ON catalog.course_revisions (category_id);
-- BrowseCourses q (>= 3 chars): ILIKE on live title, joined back via courses.published_revision_id
CREATE INDEX course_revisions_title_trgm_idx ON catalog.course_revisions USING gin (title gin_trgm_ops);
CREATE TRIGGER course_revisions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.course_revisions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER course_revisions_no_truncate_trg BEFORE TRUNCATE ON catalog.course_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

COMMENT ON TABLE catalog.course_revisions IS
  'Immutable reviewed snapshot (D1) of the working copy at SUBMIT. Lifecycle (PENDING/LIVE/REJECTED/WITHDRAWN/SUPERSEDED) is derived from courses pointers + decision transitions. Header columns are NOT NULL: a revision is complete by construction. Kept forever.';
COMMENT ON COLUMN catalog.course_revisions.kind IS 'INITIAL if the course had no live revision at submit, else UPDATE. Equals (SUBMIT.from_status = PUBLISHED); verified at COMMIT by course_revisions_submit_log_ck.';
COMMENT ON COLUMN catalog.course_revisions.content_hash IS 'SHA-256 of the canonical JSON snapshot (details, bullets, ordered sections/lectures, asset ids, article bodies). Equal to the live revision hash -> nothing_to_review.';
COMMENT ON COLUMN catalog.course_revisions.submitted_at IS 'Equals the SUBMIT transition occurred_at (same transaction now()); verified at COMMIT.';

CREATE TABLE catalog.revision_bullets (
  revision_id uuid     NOT NULL,
  kind        text     NOT NULL,
  position    smallint NOT NULL,
  text        text     NOT NULL,
  CONSTRAINT revision_bullets_pk             PRIMARY KEY (revision_id, kind, position),
  CONSTRAINT revision_bullets_revision_id_fk FOREIGN KEY (revision_id) REFERENCES catalog.course_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT revision_bullets_kind_ck        CHECK (kind IN ('OUTCOME','REQUIREMENT')),
  CONSTRAINT revision_bullets_position_ck    CHECK (position BETWEEN 0 AND 9),
  CONSTRAINT revision_bullets_text_ck        CHECK (char_length(text) BETWEEN 1 AND 160 AND text = btrim(text) AND text !~ '[[:cntrl:]]')
);
CREATE TRIGGER revision_bullets_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_bullets
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_bullets_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_bullets
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE catalog.revision_bullets IS 'Snapshot of course_bullets at submit. Append-only.';

CREATE TABLE catalog.revision_sections (
  revision_id uuid    NOT NULL,
  section_id  uuid    NOT NULL,      -- stable working id, no FK (working section may be deleted later)
  position    integer NOT NULL,
  title       text    NOT NULL,
  objective   text    NULL,
  CONSTRAINT revision_sections_pk                      PRIMARY KEY (revision_id, section_id),   -- also FK target
  CONSTRAINT revision_sections_revision_id_position_uq UNIQUE (revision_id, position),
  CONSTRAINT revision_sections_revision_id_fk          FOREIGN KEY (revision_id) REFERENCES catalog.course_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT revision_sections_title_ck                CHECK (char_length(title) BETWEEN 1 AND 80 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT revision_sections_objective_ck            CHECK (objective IS NULL OR (char_length(objective) BETWEEN 1 AND 200 AND objective = btrim(objective))),
  CONSTRAINT revision_sections_position_ck             CHECK (position BETWEEN 0 AND 49)
);
CREATE TRIGGER revision_sections_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_sections
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_sections_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_sections
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE catalog.revision_sections IS 'Snapshot of sections at submit. Append-only.';
COMMENT ON COLUMN catalog.revision_sections.section_id IS 'Working sections.id at submit time (stable identity for diffs). Deliberately no FK.';

CREATE TABLE catalog.revision_lectures (
  revision_id      uuid    NOT NULL,
  lecture_id       uuid    NOT NULL,     -- stable working id, no FK
  section_id       uuid    NOT NULL,
  position         integer NOT NULL,
  type             text    NOT NULL,
  title            text    NOT NULL,
  description_md   text    NULL,
  is_preview       boolean NOT NULL,
  media_asset_id   uuid    NULL,         -- soft ref, pinned by asset_usages(catalog.course_revision)
  duration_seconds integer NULL,         -- snapshot from media at submit
  article_body_md  text    NULL,
  CONSTRAINT revision_lectures_pk                                 PRIMARY KEY (revision_id, lecture_id),
  CONSTRAINT revision_lectures_revision_id_section_id_fk          FOREIGN KEY (revision_id, section_id)
                                                                  REFERENCES catalog.revision_sections (revision_id, section_id) ON DELETE RESTRICT,
  CONSTRAINT revision_lectures_revision_id_section_id_position_uq UNIQUE (revision_id, section_id, position),
  CONSTRAINT revision_lectures_type_ck                            CHECK (type IN ('VIDEO','ARTICLE','RESOURCE')),
  CONSTRAINT revision_lectures_title_ck                           CHECK (char_length(title) BETWEEN 1 AND 80 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  CONSTRAINT revision_lectures_description_md_ck                  CHECK (description_md IS NULL OR char_length(description_md) BETWEEN 1 AND 2000),
  CONSTRAINT revision_lectures_position_ck                        CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT revision_lectures_media_asset_id_ck                  CHECK ((type = 'ARTICLE') = (media_asset_id IS NULL)),       -- VIDEO/RESOURCE must have media
  CONSTRAINT revision_lectures_duration_seconds_ck                CHECK ((type = 'VIDEO') = (duration_seconds IS NOT NULL)
                                                                         AND (duration_seconds IS NULL OR duration_seconds >= 0)),
  CONSTRAINT revision_lectures_article_body_md_ck                 CHECK ((type = 'ARTICLE') = (article_body_md IS NOT NULL)
                                                                         AND (article_body_md IS NULL OR char_length(article_body_md) BETWEEN 1 AND 100000)),
  CONSTRAINT revision_lectures_is_preview_ck                      CHECK (NOT is_preview OR type <> 'RESOURCE')
);
-- One lecture per asset within a revision (mirrors lectures_media_asset_id_uq); "is asset in revision" lookups
CREATE UNIQUE INDEX revision_lectures_revision_id_media_asset_id_uq
  ON catalog.revision_lectures (revision_id, media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE TRIGGER revision_lectures_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_lectures
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER revision_lectures_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_lectures
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE catalog.revision_lectures IS 'Snapshot of lectures (+ article body + video duration) at submit. Playback of the live revision looks up (published_revision_id, lecture_id) via the PK. Append-only.';
COMMENT ON COLUMN catalog.revision_lectures.duration_seconds IS 'Snapshot of media.assets.duration_ms/1000 at submit (READY assets are immutable, so this is a frozen fact, not a drifting copy).';

-- Circular pointers: courses -> its own revisions (composite: a pointer can only target a revision of the same course)
ALTER TABLE catalog.courses
  ADD CONSTRAINT courses_id_published_revision_id_fk FOREIGN KEY (id, published_revision_id)
      REFERENCES catalog.course_revisions (course_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT courses_id_pending_revision_id_fk   FOREIGN KEY (id, pending_revision_id)
      REFERENCES catalog.course_revisions (course_id, id) ON DELETE RESTRICT;

-- =====================================================================
-- 9. catalog.course_transitions (append-only, linear hash-chain per course)
-- =====================================================================
CREATE TABLE catalog.course_transitions (
  id                 uuid        NOT NULL DEFAULT uuidv7(),
  course_id          uuid        NOT NULL,
  prev_transition_id uuid        NULL,
  revision_id        uuid        NULL,
  action             text        NOT NULL,
  from_status        text        NULL,
  to_status          text        NOT NULL,
  actor_id           uuid        NOT NULL,
  reason             text        NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_transitions_pk                                    PRIMARY KEY (id),
  CONSTRAINT course_transitions_course_id_id_to_status_uq             UNIQUE (course_id, id, to_status),   -- chain FK target
  -- linear chain: one root (CREATE, prev NULL) and at most one successor per transition. Losing a concurrent transition race -> 23505
  CONSTRAINT course_transitions_course_id_prev_transition_id_uq       UNIQUE NULLS NOT DISTINCT (course_id, prev_transition_id),
  -- from_status must equal the predecessor's to_status, within the same course
  CONSTRAINT course_transitions_course_id_prev_transition_id_from_status_fk
                                                                      FOREIGN KEY (course_id, prev_transition_id, from_status)
                                                                      REFERENCES catalog.course_transitions (course_id, id, to_status) ON DELETE RESTRICT,
  CONSTRAINT course_transitions_course_id_fk                          FOREIGN KEY (course_id) REFERENCES catalog.courses (id) ON DELETE RESTRICT,
  CONSTRAINT course_transitions_course_id_revision_id_fk              FOREIGN KEY (course_id, revision_id)
                                                                      REFERENCES catalog.course_revisions (course_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_transitions_actor_id_fk                           FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT course_transitions_action_ck                             CHECK (action IN ('CREATE','SUBMIT','WITHDRAW','APPROVE','REJECT','ARCHIVE','RESTORE','DELETE')),
  CONSTRAINT course_transitions_from_status_ck                        CHECK (from_status IS NULL OR from_status IN ('DRAFT','IN_REVIEW','PUBLISHED','REJECTED','ARCHIVED')),
  CONSTRAINT course_transitions_to_status_ck                          CHECK (to_status IN ('DRAFT','IN_REVIEW','PUBLISHED','REJECTED','ARCHIVED')),
  CONSTRAINT course_transitions_root_ck                               CHECK ((action = 'CREATE') = (prev_transition_id IS NULL)
                                                                          AND (action = 'CREATE') = (from_status IS NULL)),
  CONSTRAINT course_transitions_edge_ck                               CHECK (
       (action = 'CREATE'   AND from_status IS NULL AND to_status = 'DRAFT')
    OR (action = 'SUBMIT'   AND ((from_status IN ('DRAFT','REJECTED') AND to_status = 'IN_REVIEW') OR (from_status = 'PUBLISHED' AND to_status = 'PUBLISHED')))
    OR (action = 'WITHDRAW' AND ((from_status = 'IN_REVIEW' AND to_status = 'DRAFT')               OR (from_status = 'PUBLISHED' AND to_status = 'PUBLISHED')))
    OR (action = 'APPROVE'  AND from_status IN ('IN_REVIEW','PUBLISHED') AND to_status = 'PUBLISHED')
    OR (action = 'REJECT'   AND ((from_status = 'IN_REVIEW' AND to_status = 'REJECTED')            OR (from_status = 'PUBLISHED' AND to_status = 'PUBLISHED')))
    OR (action = 'ARCHIVE'  AND from_status = 'PUBLISHED' AND to_status = 'ARCHIVED')
    OR (action = 'RESTORE'  AND from_status = 'ARCHIVED'  AND to_status = 'PUBLISHED')
    OR (action = 'DELETE'   AND from_status IN ('DRAFT','REJECTED') AND to_status = from_status)),
  CONSTRAINT course_transitions_revision_id_ck                        CHECK ((revision_id IS NOT NULL) = (action IN ('SUBMIT','WITHDRAW','APPROVE','REJECT'))),
  CONSTRAINT course_transitions_reason_ck                             CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT course_transitions_reason_scope_ck                       CHECK (reason IS NULL OR action IN ('APPROVE','REJECT','ARCHIVE','WITHDRAW')),
  CONSTRAINT course_transitions_reject_reason_ck                      CHECK (action <> 'REJECT' OR (reason IS NOT NULL AND char_length(reason) >= 10)),
  CONSTRAINT course_transitions_withdraw_reason_ck                    CHECK (action <> 'WITHDRAW' OR reason IS NULL OR reason = 'ARCHIVED')
);
-- each revision submitted once
CREATE UNIQUE INDEX course_transitions_revision_id_submit_uq
  ON catalog.course_transitions (revision_id) WHERE action = 'SUBMIT';
-- each revision decided once (no approve + reject, no approve after withdraw); also the guard's decision lookup
CREATE UNIQUE INDEX course_transitions_revision_id_decision_uq
  ON catalog.course_transitions (revision_id) WHERE action IN ('APPROVE','REJECT','WITHDRAW');
-- deleted once
CREATE UNIQUE INDEX course_transitions_course_id_delete_uq
  ON catalog.course_transitions (course_id) WHERE action = 'DELETE';
-- (history + guard scans by course_id use course_transitions_course_id_prev_transition_id_uq)
CREATE TRIGGER course_transitions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.course_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER course_transitions_no_truncate_trg BEFORE TRUNCATE ON catalog.course_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- Actor rules (immediate)
CREATE FUNCTION catalog.course_transitions_actor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_owner       uuid;
  v_deleted     timestamptz;
  v_prev_action text;
  v_prev_actor  uuid;
BEGIN
  SELECT owner_id, deleted_at INTO v_owner, v_deleted FROM catalog.courses WHERE id = NEW.course_id;
  IF NOT FOUND THEN
    RETURN NEW;   -- course_transitions_course_id_fk reports it
  END IF;
  IF v_deleted IS NOT NULL AND NEW.action <> 'DELETE' THEN
    RAISE EXCEPTION 'course % is deleted', NEW.course_id
      USING ERRCODE = '23514', CONSTRAINT = 'course_transitions_course_deleted_ck';
  END IF;
  IF (NEW.action IN ('CREATE','SUBMIT','DELETE') OR (NEW.action = 'WITHDRAW' AND NEW.reason IS NULL))
     AND NEW.actor_id IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'only the course owner may %', NEW.action
      USING ERRCODE = '23514', CONSTRAINT = 'course_transitions_actor_ck';
  END IF;
  IF NEW.action IN ('APPROVE','REJECT') AND NEW.actor_id = v_owner THEN
    RAISE EXCEPTION 'the course owner cannot decide their own revision'
      USING ERRCODE = '23514', CONSTRAINT = 'course_transitions_self_decision_ck';
  END IF;
  IF NEW.action = 'ARCHIVE' AND NEW.actor_id <> v_owner
     AND (NEW.reason IS NULL OR char_length(NEW.reason) < 10) THEN
    RAISE EXCEPTION 'a takedown requires a reason of at least 10 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'course_transitions_takedown_reason_ck';
  END IF;
  IF NEW.action = 'RESTORE' AND NEW.actor_id = v_owner THEN
    -- the only edge into ARCHIVED is ARCHIVE, so the predecessor IS the archive transition
    SELECT action, actor_id INTO v_prev_action, v_prev_actor
      FROM catalog.course_transitions WHERE id = NEW.prev_transition_id;
    IF v_prev_action IS DISTINCT FROM 'ARCHIVE' OR v_prev_actor IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'the owner may only restore a course they archived themselves'
        USING ERRCODE = '23514', CONSTRAINT = 'course_transitions_restore_actor_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER course_transitions_actor_trg BEFORE INSERT ON catalog.course_transitions
  FOR EACH ROW EXECUTE FUNCTION catalog.course_transitions_actor_guard();

-- Materialised lifecycle == transition log, checked at COMMIT from both sides
CREATE FUNCTION catalog.course_status_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id        uuid;
  v_status    text;
  v_pending   uuid;
  v_live      uuid;
  v_first     timestamptz;
  v_deleted   timestamptz;
  v_head      text;
  v_pend_arr  uuid[];
  v_log_live  uuid;
  v_log_first timestamptz;
  v_log_del   timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'courses' THEN v_id := NEW.id; ELSE v_id := NEW.course_id; END IF;

  SELECT status, pending_revision_id, published_revision_id, first_published_at, deleted_at
    INTO v_status, v_pending, v_live, v_first, v_deleted
    FROM catalog.courses WHERE id = v_id;

  -- head of the chain = the transition no other transition points at
  SELECT t.to_status INTO v_head
    FROM catalog.course_transitions t
   WHERE t.course_id = v_id
     AND NOT EXISTS (SELECT 1 FROM catalog.course_transitions n
                      WHERE n.course_id = v_id AND n.prev_transition_id = t.id);

  -- pending = submitted revisions without a decision (must be <= 1)
  SELECT array_agg(s.revision_id) INTO v_pend_arr
    FROM catalog.course_transitions s
   WHERE s.course_id = v_id AND s.action = 'SUBMIT'
     AND NOT EXISTS (SELECT 1 FROM catalog.course_transitions d
                      WHERE d.revision_id = s.revision_id AND d.action IN ('APPROVE','REJECT','WITHDRAW'));

  -- live = most recent approved revision; first publication = first approval (revision_no order, not clock/uuid order)
  SELECT a.revision_id INTO v_log_live
    FROM catalog.course_transitions a JOIN catalog.course_revisions r ON r.id = a.revision_id
   WHERE a.course_id = v_id AND a.action = 'APPROVE'
   ORDER BY r.revision_no DESC LIMIT 1;
  SELECT a.occurred_at INTO v_log_first
    FROM catalog.course_transitions a JOIN catalog.course_revisions r ON r.id = a.revision_id
   WHERE a.course_id = v_id AND a.action = 'APPROVE'
   ORDER BY r.revision_no ASC LIMIT 1;

  SELECT d.occurred_at INTO v_log_del
    FROM catalog.course_transitions d WHERE d.course_id = v_id AND d.action = 'DELETE';

  IF v_head IS DISTINCT FROM v_status
     OR coalesce(cardinality(v_pend_arr), 0) > 1
     OR v_pending IS DISTINCT FROM v_pend_arr[1]
     OR v_live    IS DISTINCT FROM v_log_live
     OR v_first   IS DISTINCT FROM v_log_first
     OR v_deleted IS DISTINCT FROM v_log_del THEN
    RAISE EXCEPTION 'course % lifecycle columns do not match its transition log', v_id
      USING ERRCODE = '23514', CONSTRAINT = 'courses_status_log_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER courses_status_log_trg
  AFTER INSERT OR UPDATE OF status, pending_revision_id, published_revision_id, first_published_at, deleted_at
  ON catalog.courses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_status_log_guard();
CREATE CONSTRAINT TRIGGER course_transitions_status_log_trg
  AFTER INSERT ON catalog.course_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_status_log_guard();

-- Every revision has exactly its SUBMIT transition and is structurally complete (checked at COMMIT)
CREATE FUNCTION catalog.course_revision_submit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.course_transitions t
                  WHERE t.revision_id = NEW.id AND t.course_id = NEW.course_id AND t.action = 'SUBMIT'
                    AND t.occurred_at = NEW.submitted_at
                    AND (t.from_status = 'PUBLISHED') = (NEW.kind = 'UPDATE')) THEN
    RAISE EXCEPTION 'revision % has no matching SUBMIT transition', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'course_revisions_submit_log_ck';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog.revision_sections s WHERE s.revision_id = NEW.id)
     OR EXISTS (SELECT 1 FROM catalog.revision_sections s
                 WHERE s.revision_id = NEW.id
                   AND NOT EXISTS (SELECT 1 FROM catalog.revision_lectures l
                                    WHERE l.revision_id = s.revision_id AND l.section_id = s.section_id))
     OR (SELECT count(*) FROM catalog.revision_bullets b
          WHERE b.revision_id = NEW.id AND b.kind = 'OUTCOME') < 4 THEN
    RAISE EXCEPTION 'revision % is incomplete (needs >= 1 section, no empty section, >= 4 outcomes)', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'course_revisions_complete_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER course_revisions_submit_log_trg
  AFTER INSERT ON catalog.course_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_revision_submit_guard();

COMMENT ON TABLE catalog.course_transitions IS
  'Append-only course lifecycle log, kept forever. A linear chain per course (prev_transition_id, unique successor): from_status = predecessor.to_status via composite FK, so the whole state machine is DB-enforced and concurrent transitions on one course cannot both commit.';
COMMENT ON COLUMN catalog.course_transitions.prev_transition_id IS 'Head of the chain at insert time (read under the course row lock). NULL only for CREATE.';
COMMENT ON COLUMN catalog.course_transitions.revision_id IS 'Set for SUBMIT/WITHDRAW/APPROVE/REJECT. Each revision has one SUBMIT and at most one decision (APPROVE/REJECT/WITHDRAW).';
COMMENT ON COLUMN catalog.course_transitions.reason IS 'REJECT: required 10..2000. ARCHIVE: owner optional, admin takedown required >= 10 (trigger). APPROVE: optional admin note. WITHDRAW: NULL or the system marker ARCHIVED (auto-withdraw on archive).';
COMMENT ON FUNCTION catalog.course_transitions_actor_guard() IS 'CREATE/SUBMIT/DELETE/plain WITHDRAW by owner only; APPROVE/REJECT never by owner; admin ARCHIVE needs a reason; owner RESTORE only after own ARCHIVE; nothing after DELETE. Whether a non-owner is an ADMIN is decided in the app.';
COMMENT ON FUNCTION catalog.course_status_log_guard() IS 'Deferred: courses.status/pending/published/first_published_at/deleted_at must equal what the transition log implies (courses_status_log_ck).';
COMMENT ON FUNCTION catalog.course_revision_submit_guard() IS 'Deferred: each revision has its SUBMIT transition (same occurred_at, consistent kind) and is structurally complete.';

-- =====================================================================
-- 10. media.assets
-- =====================================================================
CREATE TABLE media.assets (
  id                    uuid        NOT NULL DEFAULT uuidv7(),   -- app normally supplies it (needed for the S3 key before INSERT)
  owner_id              uuid        NOT NULL,
  purpose               text        NOT NULL,
  status                text        NOT NULL DEFAULT 'UPLOADING',
  original_filename     text        NOT NULL,
  declared_content_type text        NOT NULL,
  declared_size_bytes   bigint      NOT NULL,
  part_size_bytes       integer     NOT NULL,
  part_count            integer     NOT NULL,
  source_key            text        NOT NULL,
  s3_upload_id          text        NULL,
  output_prefix         text        NULL,
  duration_ms           integer     NULL,
  width                 integer     NULL,
  height                integer     NULL,
  detected_format       text        NULL,
  failure_code          text        NULL,
  uploaded_at           timestamptz NULL,
  ready_at              timestamptz NULL,
  failed_at             timestamptz NULL,
  first_used_at         timestamptz NULL,               -- trigger-maintained
  unused_since          timestamptz NULL DEFAULT now(), -- trigger-maintained; NULL <=> has usages
  source_deleted_at     timestamptz NULL,
  purged_at             timestamptz NULL,
  objects_deleted_at    timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_pk                          PRIMARY KEY (id),
  CONSTRAINT assets_owner_id_fk                 FOREIGN KEY (owner_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT assets_purpose_ck                  CHECK (purpose IN ('LECTURE_VIDEO','LECTURE_RESOURCE','COURSE_THUMBNAIL')),
  CONSTRAINT assets_status_ck                   CHECK (status IN ('UPLOADING','UPLOADED','PROCESSING','READY','FAILED','ABORTED')),
  CONSTRAINT assets_original_filename_ck        CHECK (char_length(original_filename) BETWEEN 1 AND 255 AND original_filename !~ '[[:cntrl:]]'),
  CONSTRAINT assets_declared_content_type_ck    CHECK (char_length(declared_content_type) <= 100
                                                       AND declared_content_type ~ '^[a-z]+/[a-z0-9][a-z0-9.+-]*$'),
  CONSTRAINT assets_declared_size_bytes_ck      CHECK (declared_size_bytes > 0),
  CONSTRAINT assets_part_size_bytes_ck          CHECK (part_size_bytes >= 5242880),          -- S3 minimum (all but the last part)
  CONSTRAINT assets_part_count_ck               CHECK (part_count BETWEEN 1 AND 10000
                                                       AND part_count = (declared_size_bytes + part_size_bytes - 1) / part_size_bytes),
  CONSTRAINT assets_source_key_ck               CHECK (source_key = 'uploads/' || owner_id::text || '/' || id::text || '/source'),
  CONSTRAINT assets_s3_upload_id_ck             CHECK ((status = 'UPLOADING') = (s3_upload_id IS NOT NULL)
                                                       AND (s3_upload_id IS NULL OR char_length(s3_upload_id) BETWEEN 1 AND 1024)),
  CONSTRAINT assets_output_prefix_ck            CHECK ((status = 'READY') = (output_prefix IS NOT NULL)
                                                       AND (output_prefix IS NULL OR output_prefix = 'assets/' || id::text || '/' || substring(output_prefix from '(a[0-9]+)/$') || '/')),
  CONSTRAINT assets_duration_ms_ck              CHECK ((duration_ms IS NULL OR (duration_ms > 0 AND purpose = 'LECTURE_VIDEO'))
                                                       AND (status <> 'READY' OR purpose <> 'LECTURE_VIDEO' OR duration_ms IS NOT NULL)),
  CONSTRAINT assets_dimensions_ck               CHECK ((width IS NULL) = (height IS NULL)
                                                       AND (width IS NULL OR (width BETWEEN 1 AND 65535 AND height BETWEEN 1 AND 65535 AND purpose <> 'LECTURE_RESOURCE'))
                                                       AND (status <> 'READY' OR purpose = 'LECTURE_RESOURCE' OR width IS NOT NULL)),
  CONSTRAINT assets_detected_format_ck          CHECK (detected_format IS NULL OR char_length(detected_format) BETWEEN 1 AND 100),
  CONSTRAINT assets_failure_code_ck             CHECK (failure_code IS NULL OR failure_code IN
                                                       ('UPLOAD_SIZE_MISMATCH','INVALID_MEDIA','UNSUPPORTED_MEDIA','TOO_LONG',
                                                        'TOO_LARGE_DIMENSIONS','TRANSCODE_ERROR','TIMEOUT','INTERNAL','CRASHED')),
  CONSTRAINT assets_failed_ck                   CHECK ((status = 'FAILED') = (failure_code IS NOT NULL)
                                                       AND (status = 'FAILED') = (failed_at IS NOT NULL)),
  CONSTRAINT assets_ready_at_ck                 CHECK ((status = 'READY') = (ready_at IS NOT NULL)),
  CONSTRAINT assets_uploaded_at_ck              CHECK ((status NOT IN ('UPLOADED','PROCESSING','READY') OR uploaded_at IS NOT NULL)
                                                       AND (status NOT IN ('UPLOADING','ABORTED') OR uploaded_at IS NULL)),
  CONSTRAINT assets_usage_tracking_ck           CHECK (first_used_at IS NOT NULL OR unused_since IS NOT NULL),
  CONSTRAINT assets_purged_at_ck                CHECK (purged_at IS NULL OR (unused_since IS NOT NULL
                                                       AND status IN ('UPLOADED','READY','FAILED','ABORTED'))),
  CONSTRAINT assets_objects_deleted_at_ck       CHECK (objects_deleted_at IS NULL OR purged_at IS NOT NULL),
  CONSTRAINT assets_source_deleted_at_ck        CHECK (source_deleted_at IS NULL OR status IN ('READY','FAILED','ABORTED'))
);
-- FK index for owner_id + owner-scoped listing (admin investigation / future media library)
CREATE INDEX assets_owner_id_created_at_idx ON media.assets (owner_id, created_at DESC);
-- Quota (SUM declared_size_bytes) + concurrency (COUNT status='UPLOADING'), index-only
CREATE INDEX assets_owner_id_quota_idx ON media.assets (owner_id, status) INCLUDE (declared_size_bytes)
  WHERE purged_at IS NULL AND status IN ('UPLOADING','UPLOADED','PROCESSING','READY');
-- Cleanup B: "does this S3 multipart belong to a live UPLOADING asset?"; also uniqueness of upload ids
CREATE UNIQUE INDEX assets_s3_upload_id_uq ON media.assets (s3_upload_id) WHERE s3_upload_id IS NOT NULL;
-- Cleanup A: stale UPLOADING
CREATE INDEX assets_created_at_uploading_idx ON media.assets (created_at) WHERE status = 'UPLOADING';
-- Cleanup C: purge candidates (unused, not purged)
CREATE INDEX assets_unused_since_idx ON media.assets (unused_since) WHERE purged_at IS NULL AND unused_since IS NOT NULL;
-- Cleanup D: source retention (READY + 7 days, §13) and FAILED-source backstop
CREATE INDEX assets_ready_at_source_idx  ON media.assets (ready_at)  WHERE status = 'READY'  AND source_deleted_at IS NULL AND purged_at IS NULL;
CREATE INDEX assets_failed_at_source_idx ON media.assets (failed_at) WHERE status = 'FAILED' AND source_deleted_at IS NULL AND purged_at IS NULL;
-- Cleanup C2: retry object deletion after purge
CREATE INDEX assets_purged_at_objects_idx ON media.assets (purged_at) WHERE purged_at IS NOT NULL AND objects_deleted_at IS NULL;

CREATE TRIGGER assets_set_updated_at_trg BEFORE UPDATE ON media.assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER assets_immutable_trg BEFORE UPDATE ON media.assets
  FOR EACH ROW WHEN (
       (OLD.owner_id, OLD.purpose, OLD.original_filename, OLD.declared_content_type, OLD.declared_size_bytes,
        OLD.part_size_bytes, OLD.part_count, OLD.source_key, OLD.created_at)
       IS DISTINCT FROM
       (NEW.owner_id, NEW.purpose, NEW.original_filename, NEW.declared_content_type, NEW.declared_size_bytes,
        NEW.part_size_bytes, NEW.part_count, NEW.source_key, NEW.created_at)
    OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at))
  EXECUTE FUNCTION public.forbid_row_change('assets_immutable_ck', 'media asset identity/upload-plan columns and purged_at are immutable');
CREATE TRIGGER assets_status_insert_trg BEFORE INSERT ON media.assets
  FOR EACH ROW WHEN (NEW.status <> 'UPLOADING' OR NEW.purged_at IS NOT NULL OR NEW.first_used_at IS NOT NULL)
  EXECUTE FUNCTION public.forbid_row_change('assets_status_transition_ck', 'a media asset must be created UPLOADING, unused and unpurged');
CREATE TRIGGER assets_status_transition_trg BEFORE UPDATE OF status ON media.assets
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NOT (
       (OLD.status = 'UPLOADING'  AND NEW.status IN ('UPLOADED','FAILED','ABORTED'))
    OR (OLD.status = 'UPLOADED'   AND NEW.status = 'PROCESSING')
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('READY','FAILED'))))
  EXECUTE FUNCTION public.forbid_row_change('assets_status_transition_ck', 'illegal media asset status transition');

COMMENT ON TABLE media.assets IS
  'MediaAsset aggregate. status is a guarded state column (edges enforced by assets_status_transition_ck); audit = media.transcode_attempts + outbox events. Never hard-deleted: purge sets purged_at and deletes objects. Purge is orthogonal to status.';
COMMENT ON COLUMN media.assets.original_filename IS 'Display only (sanitised by the app, emitted RFC 5987-encoded). Never used to build keys.';
COMMENT ON COLUMN media.assets.declared_content_type IS 'Browser-declared, advisory only (purpose allowlist enforced in the app/contracts; the transcoder proves the real type).';
COMMENT ON COLUMN media.assets.declared_size_bytes IS 'bigint -> string in TS. Quota counts this. CompleteUpload requires HeadObject size == this.';
COMMENT ON COLUMN media.assets.part_count IS 'Pinned to ceil(declared_size_bytes / part_size_bytes) by assets_part_count_ck.';
COMMENT ON COLUMN media.assets.source_key IS 'Quarantine object key in udemy-uploads. Derivable from (owner_id, id) and pinned to that layout by CHECK (documented 3NF exception: lets cleanup SQL read keys without app code).';
COMMENT ON COLUMN media.assets.s3_upload_id IS 'S3 multipart UploadId; present iff status = UPLOADING.';
COMMENT ON COLUMN media.assets.output_prefix IS 'assets/{id}/a{leaseNo}/ in udemy-media; set at READY.';
COMMENT ON COLUMN media.assets.first_used_at IS 'Maintained by asset_usages triggers. NULL = never attached -> short grace (MEDIA_UNATTACHED_GRACE_HOURS).';
COMMENT ON COLUMN media.assets.unused_since IS 'Maintained by asset_usages triggers under the asset row lock: NULL iff at least one usage exists, else when the last usage went away (creation time if never used). Purge candidate selector. The app must never write it.';
COMMENT ON COLUMN media.assets.purged_at IS 'Set once by the janitor (no usages, grace elapsed). Blocks any new usage (asset_usages_asset_usable_ck).';
COMMENT ON COLUMN media.assets.objects_deleted_at IS 'Set after the source prefix and output prefix were deleted from S3; retried until set.';
COMMENT ON COLUMN media.assets.source_deleted_at IS 'Original deleted: READY + MEDIA_SOURCE_RETENTION_DAYS (7; §13), immediately on FAILED, or at purge.';

-- =====================================================================
-- 11. media.asset_renditions (append-only)
-- =====================================================================
CREATE TABLE media.asset_renditions (
  asset_id      uuid        NOT NULL,
  name          text        NOT NULL,
  kind          text        NOT NULL,
  width         integer     NOT NULL,
  height        integer     NOT NULL,
  bandwidth_bps integer     NULL,
  codecs        text        NULL,
  object_key    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_renditions_pk            PRIMARY KEY (asset_id, name),
  CONSTRAINT asset_renditions_asset_id_fk   FOREIGN KEY (asset_id) REFERENCES media.assets (id) ON DELETE RESTRICT,
  CONSTRAINT asset_renditions_name_ck       CHECK (name ~ '^(360p|480p|720p|1080p|src[0-9]{3,4}p|w750|w480|poster|sprite)$'),
  CONSTRAINT asset_renditions_kind_ck       CHECK (kind IN ('HLS_VARIANT','IMAGE','SPRITE')),
  CONSTRAINT asset_renditions_kind_name_ck  CHECK ((kind = 'HLS_VARIANT') = (name ~ '^([0-9]{3,4}p|src[0-9]{3,4}p)$')
                                                 AND (kind = 'SPRITE') = (name = 'sprite')),
  CONSTRAINT asset_renditions_hls_ck        CHECK ((kind = 'HLS_VARIANT') = (bandwidth_bps IS NOT NULL)
                                                 AND (kind = 'HLS_VARIANT') = (codecs IS NOT NULL)),
  CONSTRAINT asset_renditions_dimensions_ck CHECK (width BETWEEN 1 AND 65535 AND height BETWEEN 1 AND 65535),
  CONSTRAINT asset_renditions_bandwidth_ck  CHECK (bandwidth_bps IS NULL OR bandwidth_bps > 0),
  CONSTRAINT asset_renditions_codecs_ck     CHECK (codecs IS NULL OR (char_length(codecs) <= 100 AND codecs ~ '^[A-Za-z0-9.,]+$')),
  CONSTRAINT asset_renditions_object_key_ck CHECK (char_length(object_key) <= 1024
                                                 AND object_key LIKE 'assets/' || asset_id::text || '/a%')
);
CREATE TRIGGER asset_renditions_append_only_trg BEFORE UPDATE OR DELETE ON media.asset_renditions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER asset_renditions_no_truncate_trg BEFORE TRUNCATE ON media.asset_renditions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();
COMMENT ON TABLE media.asset_renditions IS 'Outputs written once in the READY transaction. Master playlist = HLS_VARIANT rows; the rendition name in a URL is validated against these rows. Append-only (kept after purge as history).';
COMMENT ON COLUMN media.asset_renditions.kind IS 'Determined by name (documented exception: query convenience for the master playlist; asset_renditions_kind_name_ck makes drift impossible).';
COMMENT ON COLUMN media.asset_renditions.object_key IS 'HLS: the variant .m3u8; IMAGE: the JPEG; SPRITE: the WebVTT index (tiles live under the same prefix).';

-- =====================================================================
-- 12. media.asset_usages
-- =====================================================================
CREATE TABLE media.asset_usages (
  asset_id      uuid        NOT NULL,
  consumer_type text        NOT NULL,
  consumer_id   uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_usages_pk               PRIMARY KEY (asset_id, consumer_type, consumer_id),   -- ON CONFLICT target
  CONSTRAINT asset_usages_asset_id_fk      FOREIGN KEY (asset_id) REFERENCES media.assets (id) ON DELETE RESTRICT,
  CONSTRAINT asset_usages_consumer_type_ck CHECK (consumer_type IN ('catalog.lecture','catalog.course_thumbnail','catalog.course_revision'))
);
-- An asset has at most one working-copy consumer (one lecture OR one course thumbnail)
CREATE UNIQUE INDEX asset_usages_asset_id_working_uq
  ON media.asset_usages (asset_id) WHERE consumer_type <> 'catalog.course_revision';
-- A lecture holds one asset; a course one thumbnail (catches release/attach drift)
CREATE UNIQUE INDEX asset_usages_consumer_working_uq
  ON media.asset_usages (consumer_type, consumer_id) WHERE consumer_type <> 'catalog.course_revision';
-- releaseConsumer(type, id), e.g. all pins of a superseded revision
CREATE INDEX asset_usages_consumer_type_consumer_id_idx ON media.asset_usages (consumer_type, consumer_id);

CREATE FUNCTION media.asset_usages_usable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_purpose text;
  v_status  text;
  v_purged  timestamptz;
BEGIN
  -- NO KEY UPDATE: serialises attach/release per asset and conflicts with the janitor's FOR UPDATE.
  SELECT purpose, status, purged_at INTO v_purpose, v_status, v_purged
    FROM media.assets WHERE id = NEW.asset_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;   -- asset_usages_asset_id_fk reports it
  END IF;
  IF v_purged IS NOT NULL OR v_status IN ('FAILED','ABORTED')
     OR (NEW.consumer_type = 'catalog.course_revision' AND v_status <> 'READY') THEN
    RAISE EXCEPTION 'media asset % is not usable (status %, purged %)', NEW.asset_id, v_status, v_purged IS NOT NULL
      USING ERRCODE = '23514', CONSTRAINT = 'asset_usages_asset_usable_ck';
  END IF;
  IF (NEW.consumer_type = 'catalog.course_thumbnail' AND v_purpose <> 'COURSE_THUMBNAIL')
     OR (NEW.consumer_type = 'catalog.lecture' AND v_purpose NOT IN ('LECTURE_VIDEO','LECTURE_RESOURCE')) THEN
    RAISE EXCEPTION 'media asset % purpose % cannot be used as %', NEW.asset_id, v_purpose, NEW.consumer_type
      USING ERRCODE = '23514', CONSTRAINT = 'asset_usages_purpose_ck';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_usages_usable_trg BEFORE INSERT ON media.asset_usages
  FOR EACH ROW EXECUTE FUNCTION media.asset_usages_usable_guard();

CREATE FUNCTION media.asset_usages_track_unused() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE media.assets
       SET unused_since = NULL, first_used_at = coalesce(first_used_at, now())
     WHERE id = NEW.asset_id AND (unused_since IS NOT NULL OR first_used_at IS NULL);
  ELSE
    -- lock first, THEN check in a new statement (READ COMMITTED: sees releases committed while we waited)
    PERFORM 1 FROM media.assets WHERE id = OLD.asset_id FOR NO KEY UPDATE;
    UPDATE media.assets
       SET unused_since = now()
     WHERE id = OLD.asset_id AND unused_since IS NULL
       AND NOT EXISTS (SELECT 1 FROM media.asset_usages u WHERE u.asset_id = OLD.asset_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER asset_usages_track_unused_trg AFTER INSERT OR DELETE ON media.asset_usages
  FOR EACH ROW EXECUTE FUNCTION media.asset_usages_track_unused();
CREATE TRIGGER asset_usages_immutable_trg BEFORE UPDATE ON media.asset_usages
  FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('asset_usages_immutable_ck', 'asset usages are insert/delete only');

COMMENT ON TABLE media.asset_usages IS
  'Reference rows written/deleted by catalog through MediaFacade in catalog''s transaction (D8). An asset with no usages is purge-eligible after the grace period. Insert/delete only; triggers keep media.assets.unused_since/first_used_at exact.';
COMMENT ON COLUMN media.asset_usages.consumer_id IS 'catalog.lecture -> lectures.id; catalog.course_thumbnail -> courses.id; catalog.course_revision -> course_revisions.id. Soft reference (D12).';
COMMENT ON FUNCTION media.asset_usages_usable_guard() IS 'BEFORE INSERT: locks the asset (FOR NO KEY UPDATE) and rejects purged/FAILED/ABORTED assets, non-READY revision pins, and purpose/consumer mismatches.';
COMMENT ON FUNCTION media.asset_usages_track_unused() IS 'AFTER INSERT/DELETE: maintains assets.unused_since (NULL iff used) and first_used_at under the asset row lock. Requires READ COMMITTED.';

-- =====================================================================
-- 13. media.transcode_jobs
-- =====================================================================
CREATE TABLE media.transcode_jobs (
  asset_id         uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'QUEUED',
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL DEFAULT 3,
  lease_count      integer     NOT NULL DEFAULT 0,
  run_after        timestamptz NOT NULL DEFAULT now(),
  lease_owner      text        NULL,
  lease_expires_at timestamptz NULL,
  heartbeat_at     timestamptz NULL,
  progress_pct     smallint    NULL,
  last_error_code  text        NULL,
  finished_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcode_jobs_pk                PRIMARY KEY (asset_id),          -- ON CONFLICT (asset_id) DO NOTHING target
  CONSTRAINT transcode_jobs_asset_id_fk       FOREIGN KEY (asset_id) REFERENCES media.assets (id) ON DELETE RESTRICT,
  CONSTRAINT transcode_jobs_status_ck         CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  CONSTRAINT transcode_jobs_lease_ck          CHECK ((status = 'RUNNING') = (lease_owner IS NOT NULL)
                                                     AND (lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT transcode_jobs_lease_owner_ck    CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  CONSTRAINT transcode_jobs_max_attempts_ck   CHECK (max_attempts BETWEEN 1 AND 10),
  CONSTRAINT transcode_jobs_attempts_ck       CHECK (attempts BETWEEN 0 AND max_attempts AND attempts <= lease_count),
  CONSTRAINT transcode_jobs_queued_ck         CHECK (status <> 'QUEUED' OR attempts < max_attempts),
  CONSTRAINT transcode_jobs_progress_pct_ck   CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
  CONSTRAINT transcode_jobs_last_error_code_ck CHECK (last_error_code IS NULL OR last_error_code IN
                                                     ('INVALID_MEDIA','UNSUPPORTED_MEDIA','TOO_LONG','TOO_LARGE_DIMENSIONS',
                                                      'TRANSCODE_ERROR','TIMEOUT','INTERNAL','CRASHED')),
  CONSTRAINT transcode_jobs_failed_ck         CHECK (status <> 'FAILED' OR last_error_code IS NOT NULL),
  CONSTRAINT transcode_jobs_finished_at_ck    CHECK ((finished_at IS NOT NULL) = (status IN ('SUCCEEDED','FAILED','CANCELLED')))
);
-- Lease pickup: WHERE status='QUEUED' AND run_after <= now() ORDER BY run_after, asset_id LIMIT 1 FOR UPDATE SKIP LOCKED
CREATE INDEX transcode_jobs_run_after_queued_idx ON media.transcode_jobs (run_after, asset_id) WHERE status = 'QUEUED';
-- Reaper: WHERE status='RUNNING' AND lease_expires_at < now()
CREATE INDEX transcode_jobs_lease_expires_at_running_idx ON media.transcode_jobs (lease_expires_at) WHERE status = 'RUNNING';

CREATE TRIGGER transcode_jobs_set_updated_at_trg BEFORE UPDATE ON media.transcode_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER transcode_jobs_status_insert_trg BEFORE INSERT ON media.transcode_jobs
  FOR EACH ROW WHEN (NEW.status <> 'QUEUED' OR NEW.attempts <> 0 OR NEW.lease_count <> 0)
  EXECUTE FUNCTION public.forbid_row_change('transcode_jobs_status_transition_ck', 'a transcode job must be created QUEUED with no attempts');
CREATE TRIGGER transcode_jobs_status_transition_trg BEFORE UPDATE OF status ON media.transcode_jobs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NOT (
       (OLD.status = 'QUEUED'  AND NEW.status IN ('RUNNING','CANCELLED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('QUEUED','SUCCEEDED','FAILED','CANCELLED'))))
  EXECUTE FUNCTION public.forbid_row_change('transcode_jobs_status_transition_ck', 'illegal transcode job status transition');

CREATE FUNCTION media.transcode_jobs_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('media_transcode', NEW.asset_id::text);   -- delivered at COMMIT; deduplicated per tx
  RETURN NULL;
END
$$;
CREATE TRIGGER transcode_jobs_notify_trg AFTER INSERT OR UPDATE OF status ON media.transcode_jobs
  FOR EACH ROW WHEN (NEW.status = 'QUEUED' AND NEW.run_after <= now())
  EXECUTE FUNCTION media.transcode_jobs_notify();

COMMENT ON TABLE media.transcode_jobs IS
  'One processing job per asset (enqueued by the worker on MediaUploaded). Leased with FOR UPDATE SKIP LOCKED by apps/transcoder; lease_count is the fencing token. NOTIFY media_transcode on (re)queue; LISTEN is a latency optimisation, polling is the correctness path.';
COMMENT ON COLUMN media.transcode_jobs.attempts IS 'Penalised attempts (counted toward max_attempts). Graceful shutdown gives the attempt back (attempts - 1).';
COMMENT ON COLUMN media.transcode_jobs.lease_count IS 'Total leases ever taken (never decremented). = transcode_attempts.attempt_no and the a{n} output prefix of the current lease; heartbeat/complete are fenced on it.';
COMMENT ON COLUMN media.transcode_jobs.run_after IS 'Not before this time (exponential backoff on retry: now() + 2^attempts minutes).';
COMMENT ON COLUMN media.transcode_jobs.status IS 'CANCELLED = the asset was purged or no longer processable when leased.';

-- =====================================================================
-- 14. media.transcode_attempts (append-only except the single "finish" update)
-- =====================================================================
CREATE TABLE media.transcode_attempts (
  asset_id     uuid        NOT NULL,
  attempt_no   integer     NOT NULL,
  worker_id    text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz NULL,
  outcome      text        NULL,
  error_code   text        NULL,
  error_detail text        NULL,
  CONSTRAINT transcode_attempts_pk              PRIMARY KEY (asset_id, attempt_no),
  CONSTRAINT transcode_attempts_asset_id_fk     FOREIGN KEY (asset_id) REFERENCES media.transcode_jobs (asset_id) ON DELETE RESTRICT,
  CONSTRAINT transcode_attempts_attempt_no_ck   CHECK (attempt_no >= 1),
  CONSTRAINT transcode_attempts_worker_id_ck    CHECK (char_length(worker_id) BETWEEN 1 AND 128),
  CONSTRAINT transcode_attempts_outcome_ck      CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','RETRY','FAILED','LEASE_LOST','RELEASED')),
  CONSTRAINT transcode_attempts_finished_ck     CHECK ((finished_at IS NULL) = (outcome IS NULL)
                                                      AND (finished_at IS NULL OR finished_at >= started_at)),
  CONSTRAINT transcode_attempts_error_code_ck   CHECK ((error_code IS NULL OR (outcome IN ('RETRY','FAILED','LEASE_LOST') AND error_code IN
                                                      ('INVALID_MEDIA','UNSUPPORTED_MEDIA','TOO_LONG','TOO_LARGE_DIMENSIONS',
                                                       'TRANSCODE_ERROR','TIMEOUT','INTERNAL','CRASHED'))))
                                                      AND (outcome IS DISTINCT FROM 'FAILED' OR error_code IS NOT NULL)),
  CONSTRAINT transcode_attempts_error_detail_ck CHECK (error_detail IS NULL OR (error_code IS NOT NULL AND char_length(error_detail) <= 2000))
);
-- Never two open attempts for one asset (the reaper must close a crashed attempt before the next lease)
CREATE UNIQUE INDEX transcode_attempts_asset_id_open_uq ON media.transcode_attempts (asset_id) WHERE finished_at IS NULL;

CREATE FUNCTION media.transcode_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL
     AND OLD.outcome IS NULL AND OLD.error_code IS NULL AND OLD.error_detail IS NULL
     AND (NEW.asset_id, NEW.attempt_no, NEW.worker_id, NEW.started_at)
         IS NOT DISTINCT FROM (OLD.asset_id, OLD.attempt_no, OLD.worker_id, OLD.started_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on media.transcode_attempts is forbidden: only the single finish update is allowed', TG_OP
    USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER transcode_attempts_guard_trg BEFORE UPDATE OR DELETE ON media.transcode_attempts
  FOR EACH ROW EXECUTE FUNCTION media.transcode_attempts_guard();
CREATE TRIGGER transcode_attempts_no_truncate_trg BEFORE TRUNCATE ON media.transcode_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

COMMENT ON TABLE media.transcode_attempts IS
  'Processing audit, kept forever. Row inserted at lease (open attempt = evidence of a crash if the lease expires), finished exactly once. error_detail is internal, never user-visible.';
COMMENT ON COLUMN media.transcode_attempts.attempt_no IS '= transcode_jobs.lease_count at lease time (monotonic; graceful releases do not reuse numbers).';
COMMENT ON COLUMN media.transcode_attempts.outcome IS 'RELEASED = graceful shutdown (not penalised). LEASE_LOST = lease expired (crash/OOM), closed by the reaper.';

-- =====================================================================
-- 15. Privileges (prod role split; no-op in dev where the roles don't exist)
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
    GRANT USAGE ON SCHEMA catalog, media TO udemy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA catalog, media TO udemy_app;
    -- append-only history / snapshots
    REVOKE UPDATE, DELETE, TRUNCATE ON catalog.course_revisions, catalog.revision_bullets, catalog.revision_sections,
                                       catalog.revision_lectures, catalog.course_transitions FROM udemy_app;
    -- never hard-deleted
    REVOKE DELETE, TRUNCATE ON catalog.courses, media.assets FROM udemy_app;
    -- insert/delete only
    REVOKE UPDATE, TRUNCATE ON media.asset_usages FROM udemy_app;
    -- transcoder-owned (udemy_transcoder): app reads; worker only enqueues jobs
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON media.asset_renditions, media.transcode_attempts FROM udemy_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON media.transcode_jobs FROM udemy_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_transcoder') THEN
    GRANT USAGE ON SCHEMA media, outbox TO udemy_transcoder;
    GRANT SELECT ON media.assets, media.transcode_jobs, media.asset_renditions, media.transcode_attempts TO udemy_transcoder;
    GRANT UPDATE (status, attempts, lease_count, run_after, lease_owner, lease_expires_at, heartbeat_at,
                  progress_pct, last_error_code, finished_at) ON media.transcode_jobs TO udemy_transcoder;
    GRANT UPDATE (status, output_prefix, duration_ms, width, height, detected_format, failure_code,
                  ready_at, failed_at, source_deleted_at) ON media.assets TO udemy_transcoder;
    GRANT INSERT ON media.asset_renditions, media.transcode_attempts TO udemy_transcoder;
    GRANT UPDATE (finished_at, outcome, error_code, error_detail) ON media.transcode_attempts TO udemy_transcoder;
    GRANT INSERT ON outbox.events TO udemy_transcoder;
    GRANT SELECT (id) ON outbox.events TO udemy_transcoder;     -- insertOutboxEvent uses RETURNING id
  END IF;
END
$$;
```

**Down order** (for sql-ops; no CASCADE, same style as 0001/0002):

1. Drop `media.transcode_attempts`, `media.transcode_jobs`, `media.asset_usages`, `media.asset_renditions`, `media.assets`.
2. Drop the media functions: `transcode_attempts_guard`, `transcode_jobs_notify`, `asset_usages_track_unused`, `asset_usages_usable_guard`.
3. Run `ALTER TABLE catalog.courses DROP CONSTRAINT courses_id_published_revision_id_fk, DROP CONSTRAINT courses_id_pending_revision_id_fk`.
4. Drop `catalog.course_transitions`, `revision_lectures`, `revision_sections`, `revision_bullets`, `course_revisions`, `lecture_articles`, `lectures`, `sections`, `course_bullets`, `courses`, `categories`.
5. Drop the catalog functions: `course_revision_submit_guard`, `course_status_log_guard`, `course_transitions_actor_guard`, `working_copy_guard`.
6. Drop `public.forbid_row_change`.

Schemas stay (they are owned by 0001). DROP TABLE is not blocked by the guard triggers.

---

## 2. Verification of invariants

| Invariant                                                                                                                     | Enforced by                                                                                                                                                                                            | Behaviour / notes                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category depth ∈ {1,2}; a root has no parent; a child's parent has depth 1; no cycles                                         | `categories_depth_ck`, `categories_depth_parent_id_ck`, `categories_parent_id_parent_depth_fk` (stored generated `parent_depth`)                                                                       | A depth-3 insert fails the CHECK. A parent of the wrong depth fails the FK. A node with children cannot change depth (children's FK, `ON UPDATE NO ACTION`).                                              |
| Courses / revisions reference only depth-2 categories                                                                         | `courses_category_id_category_depth_fk`, `course_revisions_category_id_category_depth_fk` + `*_category_depth_ck`                                                                                      | A depth-2 category used by a course cannot be turned into a root.                                                                                                                                         |
| Category not deletable while used                                                                                             | RESTRICT FKs from children, courses and revisions                                                                                                                                                      | 23503 in DeleteCategory → `category_in_use`.                                                                                                                                                              |
| Sibling / section / lecture positions unique, permutable in one tx                                                            | `categories_parent_id_position_uq`, `sections_course_id_position_uq`, `lectures_section_id_position_uq` (DEFERRABLE INITIALLY DEFERRED)                                                                | Swaps and cross-section moves inside one transaction succeed; a collision is raised at COMMIT.                                                                                                            |
| ≤ 50 sections, ≤ 100 lectures/section, ≤ 10 bullets/kind                                                                      | `sections_position_ck`, `lectures_position_ck`, `course_bullets_position_ck` + contiguous positions (app)                                                                                              | The ≤ 500 lectures/course and ≤ 10 previews limits are app-only, under the course lock.                                                                                                                   |
| Lecture stays inside its course; sections never move between courses                                                          | `lectures_course_id_section_id_fk` + `lectures_immutable_ck`, `sections_immutable_ck`                                                                                                                  |                                                                                                                                                                                                           |
| Lecture type immutable; ARTICLE has no media; RESOURCE is never a preview                                                     | `lectures_immutable_ck`, `lectures_type_media_asset_id_ck`, `lectures_type_is_preview_ck`                                                                                                              |                                                                                                                                                                                                           |
| Article body only on ARTICLE lectures                                                                                         | `lecture_articles_lecture_id_lecture_type_fk` + `lecture_articles_lecture_type_ck`                                                                                                                     |                                                                                                                                                                                                           |
| One lecture per asset; one course per thumbnail asset                                                                         | `lectures_media_asset_id_uq`, `courses_thumbnail_asset_id_uq`, `asset_usages_asset_id_working_uq`                                                                                                      |                                                                                                                                                                                                           |
| Working copy locked while in review / archived / deleted (D2, invariant 1)                                                    | `courses_working_copy_lock_trg` (header fields) + `catalog.working_copy_guard` on bullets, sections, lectures, articles                                                                                | The guard takes `FOR SHARE` on the course row, which conflicts with Submit's UPDATE, so it is race-free even if a code path forgets the course mutex.                                                     |
| Slug frozen after first publication                                                                                           | `courses_slug_frozen_trg` → `courses_slug_frozen_ck`                                                                                                                                                   |                                                                                                                                                                                                           |
| Owner immutable                                                                                                               | `courses_immutable_ck`                                                                                                                                                                                 |                                                                                                                                                                                                           |
| Status ↔ pointer shape                                                                                                        | `courses_status_pointers_ck`, `courses_first_published_at_ck`, `courses_revision_pointers_ck`, `courses_deleted_at_ck`                                                                                 | DRAFT/REJECTED have no pointers; IN_REVIEW has pending and no live revision; PUBLISHED has live; ARCHIVED has live and no pending; a deleted course is never-published, with no pending and no thumbnail. |
| Pointers point at revisions of the same course                                                                                | `courses_id_published_revision_id_fk`, `courses_id_pending_revision_id_fk`                                                                                                                             |                                                                                                                                                                                                           |
| status, pending, published, first_published_at and deleted_at are exactly what the log implies                                | deferred `courses_status_log_trg` / `course_transitions_status_log_trg` → `courses_status_log_ck`                                                                                                      | Includes **at most one pending revision** (DB-enforced).                                                                                                                                                  |
| Legal state-machine edges only                                                                                                | `course_transitions_edge_ck` + chain FK `…_prev_transition_id_from_status_fk` (from = predecessor.to) + `…_root_ck`                                                                                    |                                                                                                                                                                                                           |
| Linear history; concurrent transitions on one course cannot both commit                                                       | `course_transitions_course_id_prev_transition_id_uq` (NULLS NOT DISTINCT)                                                                                                                              | Also enforces a single CREATE.                                                                                                                                                                            |
| A revision is submitted once and decided once (no approve + reject, no approve after withdraw/resubmit)                       | `course_transitions_revision_id_submit_uq`, `course_transitions_revision_id_decision_uq`                                                                                                               | Approve r1 after a withdraw + resubmit as r2: r1 already has a WITHDRAW, so 23505.                                                                                                                        |
| Every revision has its SUBMIT (same timestamp, kind consistent) and is complete (≥ 1 section, no empty section, ≥ 4 outcomes) | deferred `course_revisions_submit_log_trg` → `course_revisions_submit_log_ck`, `course_revisions_complete_ck`                                                                                          | Configurable thresholds (lecture count, video minutes) stay in the app.                                                                                                                                   |
| A revision header is complete                                                                                                 | NOT NULL columns + `course_revisions_*_ck` (description ≥ 200)                                                                                                                                         |                                                                                                                                                                                                           |
| Revision lecture shape (VIDEO/RESOURCE have media; VIDEO has a duration; ARTICLE has a body)                                  | `revision_lectures_media_asset_id_ck`, `_duration_seconds_ck`, `_article_body_md_ck`, `_is_preview_ck`                                                                                                 |                                                                                                                                                                                                           |
| Revisions and history immutable                                                                                               | append-only + no-truncate triggers on `course_revisions`, `revision_*`, `course_transitions`, `asset_renditions`; REVOKE in prod                                                                       |                                                                                                                                                                                                           |
| CREATE / SUBMIT / DELETE / plain WITHDRAW by the owner; no self-approve/reject                                                | `course_transitions_actor_trg` → `course_transitions_actor_ck` / `course_transitions_self_decision_ck`                                                                                                 |                                                                                                                                                                                                           |
| Admin takedown needs a reason ≥ 10; owner may restore only after their own archive                                            | `course_transitions_takedown_reason_ck`, `course_transitions_restore_actor_ck`                                                                                                                         | Admin-ness of a non-owner stays app-side.                                                                                                                                                                 |
| Nothing after DELETE; delete once                                                                                             | `course_transitions_course_deleted_ck`, `course_transitions_course_id_delete_uq`                                                                                                                       |                                                                                                                                                                                                           |
| Asset status machine UPLOADING → UPLOADED → PROCESSING → READY/FAILED (plus UPLOADING → FAILED/ABORTED); created UPLOADING    | `assets_status_insert_trg`, `assets_status_transition_trg` → `assets_status_transition_ck`                                                                                                             | READY, FAILED and ABORTED are terminal.                                                                                                                                                                   |
| Status-dependent columns                                                                                                      | `assets_s3_upload_id_ck`, `assets_output_prefix_ck`, `assets_failed_ck`, `assets_ready_at_ck`, `assets_uploaded_at_ck`, `assets_duration_ms_ck`, `assets_dimensions_ck`, `assets_source_deleted_at_ck` |                                                                                                                                                                                                           |
| Upload plan consistent; source key never user-derived                                                                         | `assets_part_count_ck`, `assets_part_size_bytes_ck`, `assets_source_key_ck`, `assets_immutable_ck`                                                                                                     |                                                                                                                                                                                                           |
| Never attach a purged / FAILED / ABORTED asset; revision pins only READY; purpose matches consumer                            | `asset_usages_usable_trg` → `asset_usages_asset_usable_ck`, `asset_usages_purpose_ck`                                                                                                                  |                                                                                                                                                                                                           |
| `unused_since` is NULL iff usages exist (purge selector exact, no leaks)                                                      | `asset_usages_track_unused_trg` (row lock + re-check) + `assets_usage_tracking_ck`, `assets_purged_at_ck`                                                                                              |                                                                                                                                                                                                           |
| Purge never hits an in-use, processing or uploading asset; purge is final                                                     | `assets_purged_at_ck`, `assets_immutable_ck` (purged_at) + purge SQL (§8)                                                                                                                              |                                                                                                                                                                                                           |
| Job state machine; lease columns iff RUNNING; attempts ≤ max; QUEUED only if attempts remain                                  | `transcode_jobs_status_*_trg`, `transcode_jobs_lease_ck`, `_attempts_ck`, `_queued_ck`, `_finished_at_ck`, `_failed_ck`                                                                                |                                                                                                                                                                                                           |
| One job per asset (idempotent enqueue)                                                                                        | `transcode_jobs_pk`                                                                                                                                                                                    | `ON CONFLICT (asset_id) DO NOTHING`.                                                                                                                                                                      |
| At most one open attempt; attempts finish exactly once                                                                        | `transcode_attempts_asset_id_open_uq`, `transcode_attempts_guard_trg`                                                                                                                                  |                                                                                                                                                                                                           |
| Rendition shape (name ↔ kind; HLS has bandwidth and codecs; key under the asset prefix)                                       | `asset_renditions_*_ck`                                                                                                                                                                                |                                                                                                                                                                                                           |
| catalog ↔ media soft refs agree (`lectures.media_asset_id` ↔ usage; `thumbnail_asset_id` ↔ usage)                             | **App** (MediaFacade in catalog's tx)                                                                                                                                                                  | Not DB-enforceable without cross-schema coupling (D12). Detection queries are in §8.6; run them in integration tests and as an ops check.                                                                 |

**ON DELETE policy:**

- Every FK is RESTRICT, except `lecture_articles` → `lectures`, which is CASCADE (the article belongs to its lecture).
- Courses and assets are never hard-deleted (and the prod privilege is REVOKEd).
- Sections and lectures are hard-deleted by the use case: lectures first (releasing usages), then sections.

---

## 3. Seed data

The migration seeds nothing; no constraint depends on reference rows (unlike `access.roles`).

**Optional dev seed:** put it in a seed script, not the migration. It is idempotent, and re-running skips existing parents and so their children.

```sql
WITH p AS (
  INSERT INTO catalog.categories (depth, slug, name, position) VALUES
    (1, 'development', 'Development', 0), (1, 'business', 'Business', 1),
    (1, 'design', 'Design', 2), (1, 'it-and-software', 'IT & Software', 3)
  ON CONFLICT (slug) DO NOTHING
  RETURNING id, slug)
INSERT INTO catalog.categories (parent_id, depth, slug, name, position)
SELECT p.id, 2, c.slug, c.name, c.position
FROM p JOIN (VALUES
  ('development', 'web-development', 'Web Development', 0),
  ('development', 'mobile-development', 'Mobile Development', 1),
  ('business', 'entrepreneurship', 'Entrepreneurship', 0),
  ('design', 'graphic-design', 'Graphic Design', 0),
  ('it-and-software', 'network-and-security', 'Network & Security', 0)
) AS c(parent_slug, slug, name, position) ON c.parent_slug = p.slug
ON CONFLICT (slug) DO NOTHING;
```

---

## 4. Privileges

**`udemy_app`:** see the block at the end of §1. Beyond Phase 1's pattern, it also revokes:

- DELETE on `courses` and `assets`
- UPDATE on `asset_usages`
- all writes on `asset_renditions` and `transcode_attempts`
- UPDATE/DELETE on `transcode_jobs` (the worker only INSERTs)

The worker's MediaCleanupJob runs as `udemy_app`. It needs UPDATE on `assets` (it has it) and nothing on jobs.

**`udemy_transcoder` (note for `infra/postgres/roles.sql`, devops-config):**

1. Create it like `udemy_app`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`, with a new required psql variable `transcoder_password`. Add it to the `GRANT CONNECT ON DATABASE` list, and add a guard that it is never a member of `udemy_owner`.
2. **Do not** add it to the global `ALTER DEFAULT PRIVILEGES`. It must get nothing on future tables by default.
3. Add an idempotent block after migrations, guarded by `to_regclass('media.transcode_jobs') IS NOT NULL`, that repeats exactly the `udemy_transcoder` grants from the migration's conditional block. Per-object grants then hold whether roles.sql ran before or after 0003, which is the same two-pass model the file already documents.
4. Least-privilege rationale:
   - SELECT on the four media tables.
   - Column-level UPDATE on the lease/progress columns of `transcode_jobs` and on the result columns of `assets`. It cannot touch `owner_id`, `purged_at`, `unused_since` or usages.
   - INSERT on `asset_renditions` and `transcode_attempts`, plus the finish columns of attempts.
   - INSERT and `SELECT (id)` on `outbox.events`.
   - No catalog access at all.
   - `updated_at` needs no grant: it is set by a BEFORE trigger, and column privileges are checked only on the SET list.
   - Trigger functions need no EXECUTE at fire time (EXECUTE is checked at CREATE TRIGGER).
5. **Prod consequence:** with these REVOKEs, a transcoder running as `udemy_app` cannot write renditions or attempts. The transcoder deployment must use `udemy_transcoder`. Dev is unaffected (single superuser; the triggers are the guard).

---

## 5. 3NF check and documented exceptions

The following are in 3NF, with no non-key attribute depending on anything but the whole key:

- `categories`, `course_bullets`, `sections`, `lecture_articles` (apart from its FK-helper column)
- `revision_bullets`, `revision_sections`, `course_transitions`
- `asset_usages`, `transcode_jobs` (after dropping `kind`, see §6), `transcode_attempts`

**Documented exceptions.** Each one is either DB-verified or immutable:

1. **`courses.status`, `pending_revision_id`, `published_revision_id`, `first_published_at`, `deleted_at`.** These are materialisations of `course_transitions`, needed for partial indexes, keysets and conditional updates. They are verified at COMMIT by `courses_status_log_ck`. This is the same pattern as Phase 1 `instructor_applications.status`, but stronger: it covers every lifecycle column.
2. **`lectures.course_id`.** Determined by `section_id`. It cannot drift (composite FK + immutable).
3. **`course_revisions.kind` and `submitted_at`.** Derivable from the SUBMIT transition; verified at COMMIT.
   - **`submitted_by` is dropped** (§6 had it). It always equals `courses.owner_id` (owner-only SUBMIT, owner immutable), so it was a transitive dependency.
4. **`course_revisions.content_hash`.** A digest of an immutable snapshot, so it cannot drift after insert. Correct computation is the app's job.
5. **`revision_lectures.duration_seconds` and `article_body_md`, and the revision header.** Point-in-time snapshots (D1), not copies of live data. Duration comes from a READY asset, which is immutable.
6. **FK helper constants:** `categories.parent_depth` (generated), `courses.category_depth`, `course_revisions.category_depth`, `lecture_articles.lecture_type`.
7. **`assets.unused_since` and `first_used_at`.** A materialisation of `asset_usages`, maintained only by triggers under the asset row lock. It is needed so purge is an index range scan instead of an anti-join over every used asset.
8. **`assets.source_key`.** Derivable from `(owner_id, id)` and CHECK-pinned to that layout.
9. **`asset_renditions.kind`.** Determined by `name` (part of the key, so formally 2NF), CHECK-pinned.

**Trade-off flagged (correctness over speed):**

- `BrowseCourses` filters category, level and language on the _live revision_ but orders by `courses.first_published_at`. With a selective filter, the planner walks the course keyset index and discards non-matching rows. That is fine at this scale.
- I deliberately did **not** copy the live category/level/language onto `courses`, which would be a drifting 3NF violation.
- The scale-out path is Phase 6 search, or a trigger-maintained `catalog.live_course_index` projection if ever needed.

---

## 6. Deviations from §6, and issues found

**Bugs and races in §5/§6:**

1. **`CHECK (published_revision_id IS DISTINCT FROM pending_revision_id)` rejects every draft.** For NULL/NULL, IS DISTINCT FROM is _false_, not NULL. Replaced with `pending_revision_id <> published_revision_id` (NULLs pass).
2. **Graceful release "attempts − 1" collides with `transcode_attempts PK (asset_id, attempt_no)` and the `a{attempt}` output prefix.** The next lease would reuse the number. I added `transcode_jobs.lease_count`, which is monotonic. It provides the attempt_no, the output prefix and the **fencing token** for heartbeat and complete. I also added outcome `RELEASED`.
3. **Purge vs attach (§6 "FOR SHARE + FOR UPDATE + re-check").**
   - A single-statement purge whose `NOT EXISTS usages` sits in the same statement as `FOR UPDATE` is wrong under READ COMMITTED: EvalPlanQual re-checks only the locked row, while the subquery keeps the old snapshot.
   - `useAsset` taking `FOR SHARE` and then updating the asset row (`unused_since = NULL`) is a classic share → exclusive **upgrade deadlock** between two concurrent attachers.
   - **Fix:** usage triggers take **`FOR NO KEY UPDATE`** on the asset and maintain `unused_since` exactly. Purge then filters on a column of the locked row itself, so EPQ is correct, and it keeps a belt-and-braces `NOT EXISTS`.
   - MediaFacade rule: lock all touched asset rows `ORDER BY id FOR NO KEY UPDATE` first (not `FOR SHARE`).
4. **`unused_since` semantics in §6 were ambiguous** (NULL meant both "in use" and "never released"). The janitor had to anti-join every used asset older than 24 h on every run. It is now NULL iff used, plus `first_used_at` to choose the grace period (24 h never-used / 7 d released).
5. **Concurrent last-release leak.** Two transactions each releasing one of the last two usages could each see the other's usage and never set `unused_since`, so the asset is never purged. Fixed by the lock-then-recheck in `asset_usages_track_unused`. **This requires READ COMMITTED.** Do not run these use cases at REPEATABLE READ.
6. **DeleteCourse must also null `lectures.media_asset_id` and `courses.thumbnail_asset_id`.** Otherwise `lectures_media_asset_id_uq` blocks re-attaching the released asset elsewhere. `courses_deleted_at_ck` enforces the thumbnail half.
   - **Order:** update the lectures first, then set `deleted_at`, because the review-lock guard rejects child writes on a deleted course.
7. **Lease query with `OR` (queued, or RUNNING with an expired lease) + `ORDER BY run_after`** cannot use either partial index well, and recovering a crashed lease needs app logic anyway (close the attempt, decide terminal, emit MediaFailed). It is split into a pure QUEUED lease and a separate **reaper** (§8).
8. **Lease and asset → PROCESSING were two transactions in §5.** A purge could slip between them. They are now one transaction. A lease that finds the asset purged or unprocessable marks the job **`CANCELLED`** (new status).
9. **Lock order:**
   - Catalog: course row → category row (`FOR SHARE`, see item 10) → asset rows ascending (`FOR NO KEY UPDATE`).
   - Transcoder: job row → asset row.
   - Purge: asset row only. It does **not** touch jobs; instead it skips assets with a QUEUED/RUNNING job, which avoids a job ↔ asset lock-order cycle with the lease.
   - Nothing takes a course lock after an asset lock, so there are no cycles.
10. **Category deactivate vs submit/assign race:** the app should `SELECT … FROM catalog.categories WHERE id=$1 FOR SHARE` before checking `is_active`. FK `KEY SHARE` does not conflict with the deactivate UPDATE.
11. **Complete vs janitor-abort race.** S3 Complete succeeds, then the DB UPDATE finds ABORTED (0 rows). The API should delete the completed object. The backstop is that purge of the ABORTED asset deletes the whole `uploads/{owner}/{asset}/` prefix.
12. **Attach-swap ordering:** with `asset_usages_consumer_working_uq`, AttachLectureMedia and SetCourseThumbnail must **release the old usage before using the new one** in the same transaction. §5 lists the reverse order.

**Schema changes vs §6:**

13. **History chain.** `course_transitions.prev_transition_id` + `UNIQUE NULLS NOT DISTINCT (course_id, prev)` + composite FK `(course_id, prev, from_status) → (course_id, id, to_status)`.
    - This makes edges DB-checked against the actual previous state and rejects concurrent transitions.
    - It does not depend on uuidv7 or clock ordering; the PG 18 docs promise no monotonicity.
    - Dropped §6's `(course_id) WHERE action='CREATE'` (implied) and the `(course_id, occurred_at)` index (the chain index serves course scans; per-course history is small).
    - **New app duty:** read the head under the course lock (§8.5) and pass it as `prev_transition_id`.
14. **Actor errors split:**
    - `course_transitions_actor_ck`: owner-only action by a non-owner (programming error)
    - `course_transitions_self_decision_ck` → `self_decision_forbidden`
    - `course_transitions_restore_actor_ck` → `restore_forbidden`
    - `course_transitions_takedown_reason_ck`
    - `course_transitions_course_deleted_ck`
15. **More DB-verified rules:**
    - `courses_status_pointers_ck` and `courses_first_published_at_ck`
    - the review-lock triggers
    - frozen slug
    - revision completeness (`course_revisions_complete_ck`)
    - revision header NOT NULL
    - `revision_lectures` media, duration and body shape
    - WITHDRAW reason limited to NULL or `ARCHIVED`
16. **Admin review queue keyset** is on `courses.pending_revision_id` (uuidv7, ≈ submit order), served by `courses_pending_revision_id_uq`, instead of `(submitted_at, revision_id)`. Keyset correctness only needs a unique key. "Oldest first" is exact to the millisecond.
17. **`transcode_jobs.kind` dropped.** It was fully determined by `assets.purpose` (transitive dependency). The transcoder reads the purpose.
18. **`revision_lectures (revision_id, media_asset_id)`** became a partial UNIQUE (one lecture per asset per revision) rather than a plain index.
19. **New indexes:**
    - `assets_s3_upload_id_uq` (cleanup B)
    - `assets_failed_at_source_idx` (FAILED-source backstop)
    - `courses_category_id_idx`, `course_revisions_category_id_idx` (FK + `category_in_use`)
    - `courses_thumbnail_asset_id_uq` (mailer lookup)
    - `courses_created_at_id_idx`, `courses_title_trgm_idx` (admin search)
    - `asset_usages_consumer_working_uq`
    - `transcode_attempts_asset_id_open_uq`
20. **Usage uniqueness widened:** `asset_usages_asset_id_working_uq` is `WHERE consumer_type <> 'catalog.course_revision'`, not lecture-only. A thumbnail can't serve two courses either.
21. **`transcode_jobs`:** added `finished_at` and `CANCELLED`; `int` instead of smallint for the counters.
22. **Generic `public.forbid_row_change()`.** Trigger + WHEN replaces per-table plpgsql for immutability and state-machine edges.
23. **Unindexed FK columns, by choice** (referenced rows are never deleted):
    - `courses.owner_id` (only the partial index)
    - `course_transitions.actor_id` and `(course_id, revision_id)`
    - `courses.published_revision_id`

**Per-instructor quota.** The env-wide quota is fully supported (index + advisory lock + SQL in §8.4). An admin-overridable per-owner limit is **not** in §6 and has no use case, so I left it out of the DDL. If wanted, here is the drop-in. The quota query then becomes `COALESCE(oq.quota_bytes, $default)`.

```sql
CREATE TABLE media.owner_quotas (
  owner_id    uuid        NOT NULL,
  quota_bytes bigint      NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT owner_quotas_pk             PRIMARY KEY (owner_id),
  CONSTRAINT owner_quotas_owner_id_fk    FOREIGN KEY (owner_id)   REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT owner_quotas_updated_by_fk  FOREIGN KEY (updated_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT owner_quotas_quota_bytes_ck CHECK (quota_bytes > 0)
);
```

**PG 18 fallback, if `categories_parent_id_parent_depth_fk` on the stored generated column is rejected.** Drop `parent_depth` and the self-FK; keep `FOREIGN KEY (parent_id) REFERENCES catalog.categories (id) ON DELETE RESTRICT` and add:

```sql
CREATE FUNCTION catalog.categories_depth_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent_depth smallint;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT depth INTO v_parent_depth FROM catalog.categories WHERE id = NEW.parent_id FOR KEY SHARE;
    IF v_parent_depth IS DISTINCT FROM NEW.depth - 1 THEN
      RAISE EXCEPTION 'category depth mismatch' USING ERRCODE = '23514', CONSTRAINT = 'categories_depth_parent_ck';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.depth <> OLD.depth
     AND EXISTS (SELECT 1 FROM catalog.categories c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'category with children cannot change depth' USING ERRCODE = '23514', CONSTRAINT = 'categories_depth_parent_ck';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER categories_depth_trg BEFORE INSERT OR UPDATE OF parent_id, depth ON catalog.categories
  FOR EACH ROW EXECUTE FUNCTION catalog.categories_depth_guard();
```

`UNIQUE (id, depth)` stays as the target for courses and revisions.

---

## 7. Kysely type expectations

These assume `kysely-codegen --camel-case --numeric-parser string --date-parser timestamp`.

| Table                                                                  | Key                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `catalog.categories`                                                   | `"catalog.categories"` (`CatalogCategories`)                                              |
| `catalog.courses`                                                      | `"catalog.courses"`                                                                       |
| `catalog.course_bullets`                                               | `"catalog.courseBullets"`                                                                 |
| `catalog.sections`                                                     | `"catalog.sections"`                                                                      |
| `catalog.lectures`                                                     | `"catalog.lectures"`                                                                      |
| `catalog.lecture_articles`                                             | `"catalog.lectureArticles"`                                                               |
| `catalog.course_revisions`                                             | `"catalog.courseRevisions"`                                                               |
| `catalog.revision_bullets` / `revision_sections` / `revision_lectures` | `"catalog.revisionBullets"` / `"catalog.revisionSections"` / `"catalog.revisionLectures"` |
| `catalog.course_transitions`                                           | `"catalog.courseTransitions"`                                                             |
| `media.assets`                                                         | `"media.assets"`                                                                          |
| `media.asset_renditions` / `asset_usages`                              | `"media.assetRenditions"` / `"media.assetUsages"`                                         |
| `media.transcode_jobs` / `transcode_attempts`                          | `"media.transcodeJobs"` / `"media.transcodeAttempts"`                                     |

**Notable columns:**

- `categories.parentDepth`: `GeneratedAlways<number>` (stored generated, NOT NULL), never in inserts. **Verify after codegen**; if it emits plain `number`, add an override.
- `courses.categoryDepth`, `courseRevisions.categoryDepth`, `lectureArticles.lectureType`, `courses.status`, `courses.version`, `lectures.isPreview`, `assets.status`, `transcodeJobs.{status,attempts,maxAttempts,leaseCount,runAfter}`: `Generated<…>`. Omit them on insert.
- `assets.unusedSince`: `Generated<Timestamp | null>`. **Never write it, nor `firstUsedAt`** (trigger-owned).
- `assets.declaredSizeBytes`: `Int8` (string at runtime). `SUM(...)::bigint` is also a string. `smallint`/`integer` are `number`.
- `courseRevisions.contentHash`: `Buffer`. `timestamptz`: `Timestamp` → `Date`.
- CHECK-constrained text columns come out as `string`. Narrow them with the contracts' unions (`COURSE_LEVELS`, statuses, failure codes).

**Behaviour notes:**

- **Deferrable constraints cannot be ON CONFLICT arbiters** (`course_bullets_pk`, the position uniques). Bullets use delete + insert.
- Valid conflict targets: `asset_usages_pk` (`.onConflict(oc => oc.columns(['assetId','consumerType','consumerId']).doNothing())`), `transcode_jobs_pk`, `categories_slug_uq`.
- Deferred errors (`*_position_uq`, `courses_status_log_ck`, `course_revisions_submit_log_ck`, `course_revisions_complete_ck`) surface when `db.transaction().execute()` commits.
- `err.constraint` is the index or pseudo-constraint name.
- `InitiateUpload` needs the asset id before the INSERT (the S3 key contains it). Use `SELECT uuidv7()` or a JS uuidv7, and build `sourceKey` exactly as `uploads/${ownerId}/${assetId}/source`.
- Set `courses.first_published_at`, `deleted_at` and `course_revisions.submitted_at` with SQL `now()` (defaults) in the same transaction as their transitions. The deferred guards compare them for equality.

---

## 8. Operational SQL

All of this runs at READ COMMITTED. `$lease_ms`, `$ttl_h` etc. are bound as ints.

### 8.1 Transcoder

```sql
-- LEASE (one transaction)
-- L1
WITH next AS (
  SELECT asset_id FROM media.transcode_jobs
   WHERE status = 'QUEUED' AND run_after <= now()
   ORDER BY run_after, asset_id
   LIMIT 1
   FOR UPDATE SKIP LOCKED)
UPDATE media.transcode_jobs j
   SET status = 'RUNNING', attempts = j.attempts + 1, lease_count = j.lease_count + 1,
       lease_owner = $worker_id, lease_expires_at = now() + $lease_ms::int * interval '1 millisecond',
       heartbeat_at = now(), progress_pct = 0
  FROM next WHERE j.asset_id = next.asset_id
RETURNING j.asset_id, j.attempts, j.max_attempts, j.lease_count;
-- L2 (0 rows -> L2b, commit, continue polling)
UPDATE media.assets SET status = 'PROCESSING'
 WHERE id = $asset_id AND status IN ('UPLOADED','PROCESSING') AND purged_at IS NULL
RETURNING owner_id, purpose, source_key, declared_size_bytes, declared_content_type;
-- L2b
UPDATE media.transcode_jobs
   SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
 WHERE asset_id = $asset_id AND lease_count = $lease_no;
-- L3
INSERT INTO media.transcode_attempts (asset_id, attempt_no, worker_id) VALUES ($asset_id, $lease_no, $worker_id);
COMMIT;

-- HEARTBEAT (every 30 s; 0 rows => lease lost: SIGKILL ffmpeg, discard outputs)
UPDATE media.transcode_jobs
   SET lease_expires_at = now() + $lease_ms::int * interval '1 millisecond', heartbeat_at = now(),
       progress_pct = GREATEST(coalesce(progress_pct, 0), $pct::smallint)
 WHERE asset_id = $asset_id AND status = 'RUNNING' AND lease_owner = $worker_id AND lease_count = $lease_no
RETURNING lease_expires_at;

-- COMPLETE (one transaction; any 0-row step => ROLLBACK, lease lost)
UPDATE media.transcode_jobs
   SET status = 'SUCCEEDED', progress_pct = 100, lease_owner = NULL, lease_expires_at = NULL,
       last_error_code = NULL, finished_at = now()
 WHERE asset_id = $asset_id AND status = 'RUNNING' AND lease_owner = $worker_id AND lease_count = $lease_no;
UPDATE media.assets
   SET status = 'READY', output_prefix = $prefix /* 'assets/{id}/a{lease_no}/' */, duration_ms = $dur,
       width = $w, height = $h, detected_format = $fmt, ready_at = now()
 WHERE id = $asset_id AND status = 'PROCESSING';
INSERT INTO media.asset_renditions (asset_id, name, kind, width, height, bandwidth_bps, codecs, object_key) VALUES (...), (...);
UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'SUCCEEDED'
 WHERE asset_id = $asset_id AND attempt_no = $lease_no AND finished_at IS NULL;
-- insertOutboxEvent(trx, MediaReady)
COMMIT;

-- FAIL, RETRYABLE (0 rows on the job update => take the terminal path)
UPDATE media.transcode_jobs
   SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, progress_pct = NULL,
       last_error_code = $code, run_after = now() + make_interval(mins => power(2, attempts)::int)
 WHERE asset_id = $asset_id AND status = 'RUNNING' AND lease_owner = $worker_id AND lease_count = $lease_no
   AND attempts < max_attempts;
UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'RETRY', error_code = $code, error_detail = $detail
 WHERE asset_id = $asset_id AND attempt_no = $lease_no AND finished_at IS NULL;

-- FAIL, TERMINAL (one transaction), then delete the source after COMMIT
UPDATE media.transcode_jobs
   SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, last_error_code = $code, finished_at = now()
 WHERE asset_id = $asset_id AND status = 'RUNNING' AND lease_owner = $worker_id AND lease_count = $lease_no;
UPDATE media.assets SET status = 'FAILED', failure_code = $code, failed_at = now()
 WHERE id = $asset_id AND status = 'PROCESSING';
UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'FAILED', error_code = $code, error_detail = $detail
 WHERE asset_id = $asset_id AND attempt_no = $lease_no AND finished_at IS NULL;
-- insertOutboxEvent(trx, MediaFailed{attempts})
COMMIT;
-- storage.delete(source_key); then:
UPDATE media.assets SET source_deleted_at = now() WHERE id = $asset_id AND source_deleted_at IS NULL;

-- GRACEFUL RELEASE (SIGTERM; not penalised)
UPDATE media.transcode_jobs
   SET status = 'QUEUED', attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL,
       progress_pct = NULL, run_after = now()
 WHERE asset_id = $asset_id AND status = 'RUNNING' AND lease_owner = $worker_id AND lease_count = $lease_no;
UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'RELEASED'
 WHERE asset_id = $asset_id AND attempt_no = $lease_no AND finished_at IS NULL;

-- REAPER (before each poll; one transaction per batch)
SELECT asset_id, attempts, max_attempts, lease_count FROM media.transcode_jobs
 WHERE status = 'RUNNING' AND lease_expires_at < now()
 ORDER BY lease_expires_at LIMIT 20
 FOR UPDATE SKIP LOCKED;
-- per row:
UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'LEASE_LOST', error_code = 'CRASHED'
 WHERE asset_id = $a AND attempt_no = $n AND finished_at IS NULL;
--   attempts < max_attempts:
UPDATE media.transcode_jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
       progress_pct = NULL, last_error_code = 'CRASHED', run_after = now()
 WHERE asset_id = $a AND status = 'RUNNING' AND lease_count = $n;
--   else terminal: job FAILED 'CRASHED' + asset FAILED 'CRASHED' (WHERE status='PROCESSING') + outbox MediaFailed
```

`LISTEN media_transcode` must run on a **dedicated non-pooled `pg.Client`**. Notifications are lost while disconnected, so the poll interval is the correctness path.

**Enqueuer** (worker, inside the claim transaction):

```sql
INSERT INTO media.transcode_jobs (asset_id)
SELECT id FROM media.assets WHERE id = $asset_id AND status = 'UPLOADED' AND purged_at IS NULL
ON CONFLICT (asset_id) DO NOTHING;
```

### 8.2 Cleanup (MediaCleanupJob; `pg_try_advisory_xact_lock` per batch; repeat until a batch returns fewer than `$batch` rows)

```sql
-- A. stale UPLOADING -> ABORTED; then S3 AbortMultipartUpload(old.s3_upload_id) after COMMIT (idempotent)
WITH doomed AS (
  SELECT id FROM media.assets
   WHERE status = 'UPLOADING' AND created_at < now() - make_interval(hours => $ttl_h::int)
   ORDER BY created_at LIMIT $batch
   FOR UPDATE SKIP LOCKED)
UPDATE media.assets a SET status = 'ABORTED', s3_upload_id = NULL
  FROM doomed WHERE a.id = doomed.id AND a.status = 'UPLOADING'
RETURNING a.id, a.source_key, old.s3_upload_id;          -- PG 18 RETURNING OLD

-- B. S3 ListMultipartUploads(uploads/) initiated > 24 h ago: abort every UploadId NOT returned here
SELECT s3_upload_id FROM media.assets WHERE s3_upload_id = ANY($upload_ids::text[]);

-- C. purge (one tx per batch); then outbox MediaPurged per row in the same tx; delete objects after COMMIT
WITH doomed AS (
  SELECT a.id FROM media.assets a
   WHERE a.purged_at IS NULL AND a.unused_since IS NOT NULL
     AND a.unused_since < now() - make_interval(hours => $never_used_grace_h::int)      -- sargable lower bound
     AND a.unused_since < now() - CASE WHEN a.first_used_at IS NULL
                                       THEN make_interval(hours => $never_used_grace_h::int)
                                       ELSE make_interval(days  => $released_grace_d::int) END
     AND a.status IN ('UPLOADED','READY','FAILED','ABORTED')
     AND NOT EXISTS (SELECT 1 FROM media.transcode_jobs j
                      WHERE j.asset_id = a.id AND j.status IN ('QUEUED','RUNNING'))
   ORDER BY a.unused_since LIMIT $batch
   FOR UPDATE OF a SKIP LOCKED)
UPDATE media.assets a SET purged_at = now()
  FROM doomed
 WHERE a.id = doomed.id AND a.purged_at IS NULL AND a.unused_since IS NOT NULL      -- EPQ re-checks these on the locked row
   AND NOT EXISTS (SELECT 1 FROM media.asset_usages u WHERE u.asset_id = a.id)       -- belt and braces
RETURNING a.id, a.owner_id, a.source_key, a.output_prefix, a.status;
-- after deletePrefix(uploads/{owner}/{id}/) + deletePrefix(output_prefix):
UPDATE media.assets SET objects_deleted_at = now(), source_deleted_at = coalesce(source_deleted_at, now())
 WHERE id = $id AND objects_deleted_at IS NULL;

-- C2. retry object deletion
SELECT id, owner_id, source_key, output_prefix FROM media.assets
 WHERE purged_at IS NOT NULL AND objects_deleted_at IS NULL AND purged_at < now() - interval '10 minutes'
 ORDER BY purged_at LIMIT $batch;

-- D. source retention (§13: READY + MEDIA_SOURCE_RETENTION_DAYS = 7; 1 in dev). No tx held across S3.
SELECT id, source_key FROM media.assets
 WHERE status = 'READY' AND source_deleted_at IS NULL AND purged_at IS NULL
   AND ready_at < now() - make_interval(days => $retention_d::int)
 ORDER BY ready_at LIMIT $batch;
-- D'. FAILED-source backstop (the transcoder normally deletes immediately)
SELECT id, source_key FROM media.assets
 WHERE status = 'FAILED' AND source_deleted_at IS NULL AND purged_at IS NULL
   AND failed_at < now() - interval '1 hour'
 ORDER BY failed_at LIMIT $batch;
-- after storage.delete(source_key) for each (idempotent):
UPDATE media.assets SET source_deleted_at = now() WHERE id = ANY($ids::uuid[]) AND source_deleted_at IS NULL;
```

### 8.3 MediaFacade locking (use / pin / release)

```sql
SELECT id, owner_id, purpose, status, purged_at FROM media.assets
 WHERE id = ANY($ids::uuid[]) ORDER BY id FOR NO KEY UPDATE;     -- first, ascending; never FOR SHARE
-- release:  DELETE FROM media.asset_usages WHERE asset_id = $a AND consumer_type = $t AND consumer_id = $c;
-- use:      INSERT INTO media.asset_usages (asset_id, consumer_type, consumer_id) VALUES (...) ON CONFLICT (asset_id, consumer_type, consumer_id) DO NOTHING;
-- releaseConsumer: lock the consumer's assets first (SELECT asset_id ... ORDER BY asset_id, then the lock above), then DELETE ... WHERE consumer_type=$t AND consumer_id=$c;
```

When swapping an asset, release the old one first, then use the new one.

### 8.4 Quota check (InitiateUpload, in the insert transaction)

```sql
SELECT pg_advisory_xact_lock(1836151905 /* 0x6d717461 'mqta' */, hashtext($owner_id::text));
SELECT coalesce(sum(declared_size_bytes), 0)::bigint                AS used_bytes,
       count(*) FILTER (WHERE status = 'UPLOADING')::int             AS uploading
  FROM media.assets
 WHERE owner_id = $owner_id AND purged_at IS NULL
   AND status IN ('UPLOADING','UPLOADED','PROCESSING','READY');      -- index-only on assets_owner_id_quota_idx
-- used_bytes + $size > MEDIA_QUOTA_BYTES_PER_OWNER -> quota_exceeded; uploading >= MEDIA_MAX_CONCURRENT_UPLOADS -> too_many_uploads
```

The two-int advisory key space does not overlap the bigint key `0x75646d79_02` used by the cleanup lock.

### 8.5 Catalog helpers

```sql
-- head of the transition chain (under the course FOR NO KEY UPDATE lock) -> prev_transition_id, current status
SELECT t.id, t.to_status FROM catalog.course_transitions t
 WHERE t.course_id = $course_id
   AND NOT EXISTS (SELECT 1 FROM catalog.course_transitions n WHERE n.course_id = $course_id AND n.prev_transition_id = t.id);

-- admin review queue (oldest first), keyset on the uuidv7 revision id
SELECT c.id AS course_id, c.owner_id, r.id AS revision_id, r.revision_no, r.kind, r.title, r.submitted_at
  FROM catalog.courses c JOIN catalog.course_revisions r ON r.id = c.pending_revision_id
 WHERE c.pending_revision_id IS NOT NULL AND c.pending_revision_id > $cursor   -- omit the cursor predicate on page 1
 ORDER BY c.pending_revision_id LIMIT $limit;

-- public browse
SELECT c.id, c.slug, c.owner_id, c.first_published_at, r.title, r.subtitle, r.level, r.language, r.category_id, r.thumbnail_asset_id
  FROM catalog.courses c JOIN catalog.course_revisions r ON r.id = c.published_revision_id
 WHERE c.status = 'PUBLISHED'
   AND r.category_id = ANY($category_ids::uuid[])            -- optional filters
   AND (c.first_published_at, c.id) < ($c_at, $c_id)          -- keyset, omitted on page 1
 ORDER BY c.first_published_at DESC, c.id DESC LIMIT $limit;
```

### 8.6 Consistency detection (integration tests + ops)

```sql
-- lecture points at an asset without its usage row
SELECT l.id, l.media_asset_id FROM catalog.lectures l
 WHERE l.media_asset_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM media.asset_usages u WHERE u.asset_id = l.media_asset_id
                     AND u.consumer_type = 'catalog.lecture' AND u.consumer_id = l.id);
-- lecture/thumbnail usage whose consumer no longer points at the asset (leaked pin, blocks purge forever)
SELECT u.* FROM media.asset_usages u
 WHERE (u.consumer_type = 'catalog.lecture'
        AND NOT EXISTS (SELECT 1 FROM catalog.lectures l WHERE l.id = u.consumer_id AND l.media_asset_id = u.asset_id))
    OR (u.consumer_type = 'catalog.course_thumbnail'
        AND NOT EXISTS (SELECT 1 FROM catalog.courses c WHERE c.id = u.consumer_id AND c.thumbnail_asset_id = u.asset_id))
    OR (u.consumer_type = 'catalog.course_revision'
        AND NOT EXISTS (SELECT 1 FROM catalog.courses c
                         WHERE c.pending_revision_id = u.consumer_id OR c.published_revision_id = u.consumer_id));
```

---

## 9. Constraint name → domain error code (for nestjs-coder)

For unique indexes and the trigger pseudo-constraints, `err.constraint` is the name below.

| Constraint (SQLSTATE)                                                                                                                                                                                                                                                                                                               | Domain error                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `categories_slug_uq`, `courses_slug_active_uq` (23505)                                                                                                                                                                                                                                                                              | `slug_taken` 409 (CreateCourse: retry with `-2`, `-3` suffix)                                                     |
| `categories_depth_ck` (23514)                                                                                                                                                                                                                                                                                                       | `category_depth_exceeded` 422                                                                                     |
| `categories_parent_id_parent_depth_fk` (23503 on INSERT/UPDATE)                                                                                                                                                                                                                                                                     | `category_not_found` 404 (the app pre-checks the parent; a residual hit is a race)                                |
| any 23503 inside DeleteCategory (children / `courses_category_*_fk` / `course_revisions_category_*_fk`)                                                                                                                                                                                                                             | `category_in_use` 409                                                                                             |
| `courses_category_id_category_depth_fk` (23503 on INSERT/UPDATE)                                                                                                                                                                                                                                                                    | `category_not_leaf` 422                                                                                           |
| `categories_parent_id_position_uq`, `sections_course_id_position_uq`, `lectures_section_id_position_uq` (23505 at COMMIT)                                                                                                                                                                                                           | `order_mismatch` 409                                                                                              |
| `sections_position_ck`, `lectures_position_ck`, `course_bullets_position_ck`                                                                                                                                                                                                                                                        | `curriculum_limit_exceeded` 422                                                                                   |
| `courses_slug_frozen_ck`                                                                                                                                                                                                                                                                                                            | `slug_frozen` 409                                                                                                 |
| `courses_working_copy_locked_ck`                                                                                                                                                                                                                                                                                                    | `course_in_review` 409 if `pending_revision_id` is set, else `course_not_editable` 409                            |
| `lectures_type_media_asset_id_ck`, `lecture_articles_lecture_id_lecture_type_fk`                                                                                                                                                                                                                                                    | `lecture_type_mismatch` 422                                                                                       |
| `lectures_type_is_preview_ck`, `revision_lectures_is_preview_ck`                                                                                                                                                                                                                                                                    | `preview_not_allowed` 422                                                                                         |
| `course_transitions_self_decision_ck`                                                                                                                                                                                                                                                                                               | `self_decision_forbidden` 403                                                                                     |
| `course_transitions_restore_actor_ck`                                                                                                                                                                                                                                                                                               | `restore_forbidden` 403                                                                                           |
| `course_transitions_takedown_reason_ck`, `course_transitions_reject_reason_ck`                                                                                                                                                                                                                                                      | 422 validation (reason)                                                                                           |
| `course_transitions_revision_id_decision_uq`, `…_revision_id_submit_uq`, `…_course_id_delete_uq`, `…_edge_ck`, `…_prev_transition_id_from_status_fk`                                                                                                                                                                                | `invalid_state_transition` 409                                                                                    |
| `course_transitions_course_id_prev_transition_id_uq` (23505)                                                                                                                                                                                                                                                                        | `version_conflict` 409 (concurrent transition; impossible under the course lock)                                  |
| `course_revisions_course_id_revision_no_uq`                                                                                                                                                                                                                                                                                         | `review_already_pending` 409 (concurrent submit)                                                                  |
| `course_transitions_course_deleted_ck`                                                                                                                                                                                                                                                                                              | `course_not_found` 404                                                                                            |
| `lectures_media_asset_id_uq`, `courses_thumbnail_asset_id_uq`, `asset_usages_asset_id_working_uq`                                                                                                                                                                                                                                   | `media_asset_unusable` 409 (already attached elsewhere)                                                           |
| `asset_usages_asset_usable_ck`                                                                                                                                                                                                                                                                                                      | `media_asset_unusable` 409                                                                                        |
| `asset_usages_purpose_ck`                                                                                                                                                                                                                                                                                                           | `media_purpose_mismatch` 422                                                                                      |
| `asset_usages_asset_id_fk` (23503)                                                                                                                                                                                                                                                                                                  | `media_asset_not_found` 404                                                                                       |
| `assets_status_transition_ck`                                                                                                                                                                                                                                                                                                       | `upload_not_in_progress` 409 (Complete/Abort/PresignParts), else `invalid_state_transition` 409                   |
| `assets_declared_*_ck`, `assets_original_filename_ck`                                                                                                                                                                                                                                                                               | 422 field validation (the app validates first)                                                                    |
| `courses_status_log_ck`, `course_revisions_submit_log_ck`, `course_revisions_complete_ck`, `courses_status_pointers_ck`, `courses_*_ck` (shape), `course_transitions_actor_ck`, `*_immutable_ck`, `asset_usages_consumer_working_uq` (wrong attach order), `assets_part_count_ck`, `assets_source_key_ck`, `assets_s3_upload_id_uq` | 500 (programming error; log it)                                                                                   |
| 42501 from the append-only / attempts guards                                                                                                                                                                                                                                                                                        | 500                                                                                                               |
| `transcode_jobs_*`, `transcode_attempts_*`, `asset_renditions_*`                                                                                                                                                                                                                                                                    | transcoder-internal: treat as `INTERNAL` (retryable). A lease/fencing 0-row result is "lease lost", not an error. |

---

## Hand-off to sql-ops (P2-T4)

1. Create `packages/db/src/migrations/2026_10_xx_0003_catalog_media.ts` in the 0002 style (`Kysely<any>`, one `sql` per statement, grouped arrays, `run()` helper), in the exact order of §1:
   - `public.forbid_row_change`
   - categories, courses, course_bullets, sections, lectures, lecture_articles
   - working-copy guard function and triggers
   - revisions
   - the `ALTER TABLE courses ADD` of the two revision FKs
   - course_transitions and its functions and triggers
   - the media tables
   - the privileges DO block

   Register it in `packages/db/src/migrations/index.ts`. Write `down()` in the order given under §1. Run `pnpm --filter @udemy/db codegen` and check the `parentDepth` and `unusedSince` typings (§7).

2. **PG 18 checks first (fail fast).** If any fails, fall back as noted:
   - (a) `categories_parent_id_parent_depth_fk` on the STORED generated column is accepted, and a wrong-depth parent is rejected. Fallback: the trigger DDL in §6.
   - (b) `UNIQUE NULLS NOT DISTINCT … DEFERRABLE INITIALLY DEFERRED` is accepted, and two roots at the same position fail at COMMIT.
   - (c) `RETURNING old.s3_upload_id` works in the cleanup A statement.
3. Integration tests, at minimum:
   - **Categories:** a wrong-depth parent and a depth-3 node fail; a node with children cannot change depth.
   - **Positions:** a section/lecture position permutation (including a cross-section move) inside one transaction succeeds; a leftover duplicate fails at COMMIT.
   - **Decisions:** double decision (approve + reject; approve after withdraw + resubmit) fails on `…_decision_uq`; self-approve/reject fails on `…_self_decision_ck`; owner restore after an admin takedown fails.
   - **Chain:** two transitions with the same `prev_transition_id` → 23505; an illegal edge (e.g. ARCHIVE from DRAFT) fails.
   - **Status ↔ log:** changing `courses.status` without a transition fails at COMMIT (`courses_status_log_ck`); two pending SUBMITs fail at COMMIT.
   - **Revisions:** a revision without a SUBMIT, or with an empty section, or with < 4 outcomes fails at COMMIT. UPDATE, DELETE and TRUNCATE on revisions and transitions fail (42501).
   - **Review lock:** with `pending_revision_id` set, INSERT/UPDATE/DELETE on sections, lectures, bullets and articles and a title change all fail (`courses_working_copy_locked_ck`); the slug is frozen after approve.
   - **Assets:** an illegal transition (READY → PROCESSING; insert as READY) fails; `part_count` and `source_key` mismatches fail.
   - **Purge vs attach race (two connections):**
     - A holds the asset lock via a usage INSERT; B runs the purge statement and skips the row.
     - Reverse: B purges and holds; A's usage INSERT blocks, then fails with `asset_usages_asset_usable_ck`.
     - Two concurrent releases of the last two usages leave `unused_since` NOT NULL.
   - **Transcoder:** lease with SKIP LOCKED from two connections yields distinct jobs; a heartbeat with a stale `lease_count` updates 0 rows; a second open attempt fails `transcode_attempts_asset_id_open_uq`; an attempt can only be finished once.
   - **Prod roles (if the roles test harness exists):** `udemy_app` cannot INSERT renditions; `udemy_transcoder` cannot UPDATE `assets.purged_at` or read `catalog.*`.
4. Pass §8 to nestjs-coder: lease/heartbeat/complete/reaper to T12 (transcoder), cleanup/quota/enqueuer to T8/T13, head/queue/browse to T10/T11, plus the §9 mapping.
5. Tell devops-config (P2-T3 item 6) to add the `udemy_transcoder` role and grants block to `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/infra/postgres/roles.sql` as described in §4.
6. Tell nestjs-coder about these behaviour changes vs design §5:
   - every transition insert carries `prev_transition_id` (§8.5)
   - MediaFacade locks assets `FOR NO KEY UPDATE` in ascending order and never writes `unused_since`
   - attach-swap is release-then-use
   - DeleteCourse nulls media references before setting `deleted_at`
   - lease + asset PROCESSING + attempt row form one transaction; the reaper is separate
   - the review-queue cursor is the revision id
   - submit/assign take `FOR SHARE` on the category
   - catalog/media transactions stay READ COMMITTED

No files were written.

---

## 10. Amendments: contract alignment (applied in P2-T4)

A later pass by the schema architect checked this design against `packages/contracts` (P2-T2). Structure and names above stay authoritative; only these alignment points were applied in migration 0003:

- All lengths use `char_length`. Section objective 1–200 (single line); approval note and owner archive reason 1–2000; admin reject/takedown reason ≥ 10; article body 0–100000. No `btrim` CHECK on any markdown column (markdown is never trimmed).
- Media `content_type` ≤ 127 with the contract regex; `size_bytes` ≤ 5 TiB; width/height nullable for resources; READY video requires `duration_ms ≥ 0`.
- Status, level, purpose, failure-code, transition-action and rendition-name vocabularies are identical to the contracts.
- Course badges are derived, never stored (DRAFT, IN_REVIEW, REJECTED, LIVE, LIVE_UPDATE_PENDING, LIVE_UPDATE_REJECTED, ARCHIVED).
- Markdown and multiline fields reject control characters except `\t\n\r`; single-line fields use `= btrim()`.
- `media.owner_quotas` is optional: kept only if the quota SQL needs it (default quota comes from `MEDIA_QUOTA_BYTES_PER_OWNER`).
