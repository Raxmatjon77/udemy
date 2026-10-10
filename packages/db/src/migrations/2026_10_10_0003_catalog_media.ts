import { type Kysely, type RawBuilder, sql } from 'kysely';

/**
 * Phase 2: catalog / media schemas (tables only; the schemas and pg_trgm come from 0001).
 *
 * Source of truth: docs/phase-2-schema-design.md §1 (DDL, in its order), §4 (privileges).
 * One `sql` per statement, generated from §1 verbatim; raw SQL throughout because it uses
 * STORED generated columns as FK keys, NULLS NOT DISTINCT + DEFERRABLE uniques, partial and
 * INCLUDE indexes, constraint triggers and PL/pgSQL.
 *
 * PG 18 behaviour this relies on (probed on 18.6 before writing it, see P2-T4 report):
 * - `GENERATED ALWAYS AS (...)` defaults to VIRTUAL in PG 18; `parent_depth` must say STORED
 *   so it can be part of `categories_parent_id_parent_depth_fk`.
 * - `UNIQUE NULLS NOT DISTINCT ... DEFERRABLE INITIALLY DEFERRED` is accepted and checked at COMMIT.
 *
 * Append-only tables (course_revisions, revision_*, course_transitions, asset_renditions,
 * transcode_attempts) are guarded by triggers, which also bind superusers. DROP TABLE is not
 * blocked by them, so down() works.
 *
 * Deviations from §1 (all CHECK-level, names unchanged; see the P2-T4 report):
 * - transcode_attempts_error_code_ck: §1 had one ')' too many (syntax error); fixed, same meaning.
 * - Contract alignment with packages/contracts (orchestrator amendment): markdown / multi-line
 *   columns reject control characters except tab/LF/CR (never trimmed); section objectives are
 *   single-line (no control chars); original_filename = btrim; revision article body 0..100000;
 *   declared_content_type <= 127 with the contracts regex; declared_size_bytes <= 5 TiB;
 *   duration_ms >= 0.
 *
 * Use cases must run at READ COMMITTED: media.asset_usages_track_unused() relies on
 * lock-then-recheck (schema doc §6 item 5).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(db: Kysely<any>, statements: RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) {
    await statement.execute(db);
  }
}

// ---------------------------------------------------------------------------
// 0. Shared helper (public). forbid_append_only_mutation / set_updated_at already exist.
// ---------------------------------------------------------------------------
const shared = [
  sql`
    CREATE FUNCTION public.forbid_row_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '%', TG_ARGV[1]
        USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0], SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
    END
    $$
  `,
  sql`
    COMMENT ON FUNCTION public.forbid_row_change() IS
      'Generic BEFORE-trigger body for triggers whose WHEN clause detects a forbidden change. Raises check_violation (23514) with CONSTRAINT = TG_ARGV[0] and message TG_ARGV[1], so err.constraint maps like a CHECK. Used for immutable columns, frozen slugs, state-machine edges and the review lock.'
  `,
];

// ---------------------------------------------------------------------------
// 1. catalog.categories
// ---------------------------------------------------------------------------
const catalogCategories = [
  sql`
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
    )
  `,
  // No extra indexes: the tree is tiny (full scan); the FK on (parent_id, parent_depth) is served by categories_parent_id_position_uq.
  sql`
    CREATE TRIGGER categories_set_updated_at_trg BEFORE UPDATE ON catalog.categories
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    COMMENT ON TABLE catalog.categories IS
      'Admin-managed two-level category tree. Depth is enforced declaratively: parent_depth = depth-1 (stored generated) + composite FK to (id, depth). Cycles are impossible (a depth-2 parent has depth 1 and no parent). Hard-deleted only when unused (all inbound FKs RESTRICT).'
  `,
  sql`COMMENT ON COLUMN catalog.categories.parent_depth IS 'Generated FK helper (= depth - 1). Never written by the app. Makes the self-FK reject a parent of the wrong depth.'`,
  sql`COMMENT ON COLUMN catalog.categories.position IS 'Contiguous 0..n-1 among siblings; unique per parent (roots share parent NULL via NULLS NOT DISTINCT), deferred so a reorder can permute in one transaction.'`,
  sql`COMMENT ON COLUMN catalog.categories.is_active IS 'false = hidden from browse and not assignable/submittable. Existing live revisions keep it.'`,
];

// ---------------------------------------------------------------------------
// 2. catalog.courses (working copy + lifecycle). Revision FKs are added after course_revisions exists.
// ---------------------------------------------------------------------------
const catalogCourses = [
  sql`
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
      CONSTRAINT courses_description_md_ck             CHECK (description_md IS NULL OR (char_length(description_md) BETWEEN 1 AND 20000 AND translate(description_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')),
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
    )
  `,
  // Landing by slug; slug uniqueness among non-deleted courses (23505 -> slug_taken)
  sql`CREATE UNIQUE INDEX courses_slug_active_uq ON catalog.courses (slug) WHERE deleted_at IS NULL`,
  // ListMyCourses keyset: WHERE owner_id=$1 AND deleted_at IS NULL AND (updated_at,id) < ($c,$id) ORDER BY updated_at DESC, id DESC
  sql`CREATE INDEX courses_owner_id_updated_at_id_idx ON catalog.courses (owner_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`,
  // BrowseCourses keyset: WHERE status='PUBLISHED' AND (first_published_at,id) < (...) ORDER BY first_published_at DESC, id DESC
  sql`CREATE INDEX courses_first_published_at_id_idx ON catalog.courses (first_published_at DESC, id DESC) WHERE status = 'PUBLISHED'`,
  // Admin review queue keyset (oldest first) on the uuidv7 revision id: WHERE pending_revision_id > $cursor ORDER BY pending_revision_id
  sql`CREATE UNIQUE INDEX courses_pending_revision_id_uq ON catalog.courses (pending_revision_id) WHERE pending_revision_id IS NOT NULL`,
  // One course per thumbnail asset; worker "course by thumbnail asset" lookup (processing-failed mailer)
  sql`CREATE UNIQUE INDEX courses_thumbnail_asset_id_uq ON catalog.courses (thumbnail_asset_id) WHERE thumbnail_asset_id IS NOT NULL`,
  // FK index for categories delete (category_in_use) + admin courseCount per category
  sql`CREATE INDEX courses_category_id_idx ON catalog.courses (category_id) WHERE category_id IS NOT NULL`,
  // AdminSearchCourses default order (created_at DESC, id DESC) with optional status filter
  sql`CREATE INDEX courses_created_at_id_idx ON catalog.courses (created_at DESC, id DESC) WHERE deleted_at IS NULL`,
  // AdminSearchCourses q (>= 3 chars) on the working title
  sql`CREATE INDEX courses_title_trgm_idx ON catalog.courses USING gin (title gin_trgm_ops)`,
  sql`
    CREATE TRIGGER courses_set_updated_at_trg BEFORE UPDATE ON catalog.courses
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER courses_immutable_trg BEFORE UPDATE ON catalog.courses
      FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
      EXECUTE FUNCTION public.forbid_row_change('courses_immutable_ck', 'courses.owner_id/created_at are immutable')
  `,
  sql`
    CREATE TRIGGER courses_slug_frozen_trg BEFORE UPDATE OF slug ON catalog.courses
      FOR EACH ROW WHEN (OLD.first_published_at IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug)
      EXECUTE FUNCTION public.forbid_row_change('courses_slug_frozen_ck', 'slug is frozen after first publication')
  `,
  // D2 review lock for the header fields (children are guarded by catalog.working_copy_guard below)
  sql`
    CREATE TRIGGER courses_working_copy_lock_trg BEFORE UPDATE ON catalog.courses
      FOR EACH ROW WHEN ((OLD.pending_revision_id IS NOT NULL OR OLD.status = 'ARCHIVED' OR OLD.deleted_at IS NOT NULL)
                     AND (OLD.title, OLD.subtitle, OLD.description_md, OLD.language, OLD.level,
                          OLD.category_id, OLD.thumbnail_asset_id, OLD.slug)
                         IS DISTINCT FROM
                         (NEW.title, NEW.subtitle, NEW.description_md, NEW.language, NEW.level,
                          NEW.category_id, NEW.thumbnail_asset_id, NEW.slug))
      EXECUTE FUNCTION public.forbid_row_change('courses_working_copy_locked_ck', 'course working copy is locked (in review, archived or deleted)')
  `,
  sql`
    COMMENT ON TABLE catalog.courses IS
      'Course aggregate root: the instructor''s working copy plus lifecycle pointers. Public/student reads use ONLY published_revision_id. status, pending_revision_id, published_revision_id, first_published_at and deleted_at are guarded materialisations of catalog.course_transitions (documented 3NF exception), verified at COMMIT by courses_status_log_ck. Never hard-deleted.'
  `,
  sql`COMMENT ON COLUMN catalog.courses.slug IS 'Generated from the title; editable until first_published_at is set, then frozen (courses_slug_frozen_ck). Unique among non-deleted courses.'`,
  sql`COMMENT ON COLUMN catalog.courses.category_depth IS 'Always 2. FK helper so the category FK only accepts depth-2 (leaf) categories.'`,
  sql`COMMENT ON COLUMN catalog.courses.thumbnail_asset_id IS 'Soft reference to media.assets (no cross-schema FK, D12). Consistency via media.asset_usages(consumer_type=catalog.course_thumbnail). Nulled when the course is soft-deleted.'`,
  sql`COMMENT ON COLUMN catalog.courses.version IS 'Optimistic-concurrency token; bumped by every mutating use case (expectedVersion).'`,
  sql`COMMENT ON COLUMN catalog.courses.pending_revision_id IS 'Revision currently in review (at most one). = the SUBMIT revision with no decision transition.'`,
  sql`COMMENT ON COLUMN catalog.courses.published_revision_id IS 'Live revision. = revision of the APPROVE transition with the highest revision_no. Never returns to NULL once set.'`,
  sql`COMMENT ON COLUMN catalog.courses.first_published_at IS '= occurred_at of the first APPROVE transition. Freezes the slug; blocks hard-delete semantics (archive only).'`,
  sql`COMMENT ON COLUMN catalog.courses.deleted_at IS 'Soft delete (never-published courses only). = occurred_at of the DELETE transition.'`,
];

// ---------------------------------------------------------------------------
// 3. catalog.course_bullets
// ---------------------------------------------------------------------------
const catalogCourseBullets = [
  sql`
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
    )
  `,
  sql`
    COMMENT ON TABLE catalog.course_bullets IS
      'Working-copy outcomes/requirements, 0..10 each, positions contiguous. Replaced wholesale (DELETE + INSERT) by UpdateCourseDetails; no own timestamps (courses.updated_at/version cover them). Deferrable PK cannot be an ON CONFLICT arbiter.'
  `,
];

// ---------------------------------------------------------------------------
// 4. catalog.sections
// ---------------------------------------------------------------------------
const catalogSections = [
  sql`
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
      CONSTRAINT sections_objective_ck          CHECK (objective IS NULL OR (char_length(objective) BETWEEN 1 AND 200 AND objective = btrim(objective) AND objective !~ '[[:cntrl:]]')),
      CONSTRAINT sections_position_ck           CHECK (position BETWEEN 0 AND 49)   -- contiguous positions => max 50 sections
    )
  `,
  sql`
    CREATE TRIGGER sections_set_updated_at_trg BEFORE UPDATE ON catalog.sections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER sections_immutable_trg BEFORE UPDATE ON catalog.sections
      FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.created_at IS DISTINCT FROM NEW.created_at)
      EXECUTE FUNCTION public.forbid_row_change('sections_immutable_ck', 'sections.course_id/created_at are immutable')
  `,
  sql`COMMENT ON TABLE catalog.sections IS 'Working-copy curriculum sections. Hard-deleted (published versions survive in revision_sections). Positions contiguous 0..n-1 per course.'`,
];

// ---------------------------------------------------------------------------
// 5. catalog.lectures
// ---------------------------------------------------------------------------
const catalogLectures = [
  sql`
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
      CONSTRAINT lectures_description_md_ck        CHECK (description_md IS NULL OR (char_length(description_md) BETWEEN 1 AND 2000 AND translate(description_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')),
      CONSTRAINT lectures_position_ck              CHECK (position BETWEEN 0 AND 99),   -- max 100 per section
      CONSTRAINT lectures_type_media_asset_id_ck   CHECK (type <> 'ARTICLE' OR media_asset_id IS NULL),
      CONSTRAINT lectures_type_is_preview_ck       CHECK (NOT is_preview OR type <> 'RESOURCE')
    )
  `,
  // Curriculum read / course-wide counts (<= 500) / DeleteCourse media detach
  sql`CREATE INDEX lectures_course_id_idx ON catalog.lectures (course_id)`,
  // One lecture per asset; worker "lecture by asset" lookup (processing-failed mailer)
  sql`CREATE UNIQUE INDEX lectures_media_asset_id_uq ON catalog.lectures (media_asset_id) WHERE media_asset_id IS NOT NULL`,
  sql`
    CREATE TRIGGER lectures_set_updated_at_trg BEFORE UPDATE ON catalog.lectures
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER lectures_immutable_trg BEFORE UPDATE ON catalog.lectures
      FOR EACH ROW WHEN (OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.type IS DISTINCT FROM NEW.type
                         OR OLD.created_at IS DISTINCT FROM NEW.created_at)
      EXECUTE FUNCTION public.forbid_row_change('lectures_immutable_ck', 'lectures.course_id/type/created_at are immutable')
  `,
  sql`COMMENT ON TABLE catalog.lectures IS 'Working-copy lectures. id is stable across revisions (Phase 5 progress keys on it). Hard-deleted; published versions survive in revision_lectures.'`,
  sql`COMMENT ON COLUMN catalog.lectures.course_id IS 'Functionally determined by section_id (documented 3NF exception): kept for the composite FK that pins a lecture to its course and for cheap course-scoped child loads. Cannot drift (composite FK + immutable).'`,
  sql`COMMENT ON COLUMN catalog.lectures.media_asset_id IS 'Soft reference to media.assets. VIDEO -> LECTURE_VIDEO, RESOURCE -> LECTURE_RESOURCE (app + asset_usages purpose check). Mirrors exactly one media.asset_usages(catalog.lecture, id) row.'`,
  sql`COMMENT ON COLUMN catalog.lectures.is_preview IS 'Free preview (VIDEO/ARTICLE only, <= 10 per course - app under course lock).'`,
];

// ---------------------------------------------------------------------------
// 6. catalog.lecture_articles
// ---------------------------------------------------------------------------
const catalogLectureArticles = [
  sql`
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
      CONSTRAINT lecture_articles_body_md_ck                 CHECK (char_length(body_md) <= 100000 AND translate(body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')
    )
  `,
  sql`
    CREATE TRIGGER lecture_articles_set_updated_at_trg BEFORE UPDATE ON catalog.lecture_articles
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`COMMENT ON TABLE catalog.lecture_articles IS 'Markdown body of ARTICLE lectures (1:0..1). Composite FK to lectures(id, type) with lecture_type pinned to ARTICLE: a body can only hang off an ARTICLE lecture. Cascades with the lecture.'`,
  sql`COMMENT ON COLUMN catalog.lecture_articles.lecture_type IS 'Always ARTICLE. FK helper only.'`,
];

// ---------------------------------------------------------------------------
// 7. Review lock for working-copy children (D2), DB backstop for the app's course-row mutex
// ---------------------------------------------------------------------------
const catalogWorkingCopyGuard = [
  sql`
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
    $$
  `,
  sql`
    COMMENT ON FUNCTION catalog.working_copy_guard() IS
      'BEFORE row trigger on course_bullets/sections/lectures/lecture_articles: rejects writes while the course has a pending revision, is ARCHIVED or soft-deleted (courses_working_copy_locked_ck). Backstop for invariant 1; the app still checks first to return course_in_review vs course_not_editable.'
  `,
  sql`
    CREATE TRIGGER course_bullets_working_copy_trg  BEFORE INSERT OR UPDATE OR DELETE ON catalog.course_bullets
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  sql`
    CREATE TRIGGER sections_working_copy_trg        BEFORE INSERT OR UPDATE OR DELETE ON catalog.sections
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  sql`
    CREATE TRIGGER lectures_working_copy_trg        BEFORE INSERT OR UPDATE OR DELETE ON catalog.lectures
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
  sql`
    CREATE TRIGGER lecture_articles_working_copy_trg BEFORE INSERT OR UPDATE OR DELETE ON catalog.lecture_articles
      FOR EACH ROW EXECUTE FUNCTION catalog.working_copy_guard()
  `,
];

// ---------------------------------------------------------------------------
// 8. Immutable revision snapshots
// ---------------------------------------------------------------------------
const catalogRevisions = [
  sql`
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
      CONSTRAINT course_revisions_description_md_ck              CHECK (char_length(description_md) BETWEEN 200 AND 20000 AND translate(description_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'),  -- md length >= plain length
      CONSTRAINT course_revisions_language_ck                    CHECK (language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
      CONSTRAINT course_revisions_level_ck                       CHECK (level IN ('BEGINNER','INTERMEDIATE','EXPERT','ALL_LEVELS')),
      CONSTRAINT course_revisions_submitter_note_ck              CHECK (submitter_note IS NULL OR (char_length(submitter_note) BETWEEN 1 AND 1000 AND translate(submitter_note, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'))
    )
  `,
  // FK index for categories delete (category_in_use) + browse/landing by category
  sql`CREATE INDEX course_revisions_category_id_idx ON catalog.course_revisions (category_id)`,
  // BrowseCourses q (>= 3 chars): ILIKE on live title, joined back via courses.published_revision_id
  sql`CREATE INDEX course_revisions_title_trgm_idx ON catalog.course_revisions USING gin (title gin_trgm_ops)`,
  sql`
    CREATE TRIGGER course_revisions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.course_revisions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER course_revisions_no_truncate_trg BEFORE TRUNCATE ON catalog.course_revisions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE catalog.course_revisions IS
      'Immutable reviewed snapshot (D1) of the working copy at SUBMIT. Lifecycle (PENDING/LIVE/REJECTED/WITHDRAWN/SUPERSEDED) is derived from courses pointers + decision transitions. Header columns are NOT NULL: a revision is complete by construction. Kept forever.'
  `,
  sql`COMMENT ON COLUMN catalog.course_revisions.kind IS 'INITIAL if the course had no live revision at submit, else UPDATE. Equals (SUBMIT.from_status = PUBLISHED); verified at COMMIT by course_revisions_submit_log_ck.'`,
  sql`COMMENT ON COLUMN catalog.course_revisions.content_hash IS 'SHA-256 of the canonical JSON snapshot (details, bullets, ordered sections/lectures, asset ids, article bodies). Equal to the live revision hash -> nothing_to_review.'`,
  sql`COMMENT ON COLUMN catalog.course_revisions.submitted_at IS 'Equals the SUBMIT transition occurred_at (same transaction now()); verified at COMMIT.'`,
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER revision_bullets_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_bullets
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_bullets_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_bullets
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE catalog.revision_bullets IS 'Snapshot of course_bullets at submit. Append-only.'`,
  sql`
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
      CONSTRAINT revision_sections_objective_ck            CHECK (objective IS NULL OR (char_length(objective) BETWEEN 1 AND 200 AND objective = btrim(objective) AND objective !~ '[[:cntrl:]]')),
      CONSTRAINT revision_sections_position_ck             CHECK (position BETWEEN 0 AND 49)
    )
  `,
  sql`
    CREATE TRIGGER revision_sections_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_sections
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_sections_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_sections
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE catalog.revision_sections IS 'Snapshot of sections at submit. Append-only.'`,
  sql`COMMENT ON COLUMN catalog.revision_sections.section_id IS 'Working sections.id at submit time (stable identity for diffs). Deliberately no FK.'`,
  sql`
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
      CONSTRAINT revision_lectures_description_md_ck                  CHECK (description_md IS NULL OR (char_length(description_md) BETWEEN 1 AND 2000 AND translate(description_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')),
      CONSTRAINT revision_lectures_position_ck                        CHECK (position BETWEEN 0 AND 99),
      CONSTRAINT revision_lectures_media_asset_id_ck                  CHECK ((type = 'ARTICLE') = (media_asset_id IS NULL)),       -- VIDEO/RESOURCE must have media
      CONSTRAINT revision_lectures_duration_seconds_ck                CHECK ((type = 'VIDEO') = (duration_seconds IS NOT NULL)
                                                                             AND (duration_seconds IS NULL OR duration_seconds >= 0)),
      CONSTRAINT revision_lectures_article_body_md_ck                 CHECK ((type = 'ARTICLE') = (article_body_md IS NOT NULL)
                                                                             AND (article_body_md IS NULL OR (char_length(article_body_md) <= 100000 AND translate(article_body_md, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]'))),
      CONSTRAINT revision_lectures_is_preview_ck                      CHECK (NOT is_preview OR type <> 'RESOURCE')
    )
  `,
  // One lecture per asset within a revision (mirrors lectures_media_asset_id_uq); "is asset in revision" lookups
  sql`
    CREATE UNIQUE INDEX revision_lectures_revision_id_media_asset_id_uq
      ON catalog.revision_lectures (revision_id, media_asset_id) WHERE media_asset_id IS NOT NULL
  `,
  sql`
    CREATE TRIGGER revision_lectures_append_only_trg BEFORE UPDATE OR DELETE ON catalog.revision_lectures
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER revision_lectures_no_truncate_trg BEFORE TRUNCATE ON catalog.revision_lectures
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE catalog.revision_lectures IS 'Snapshot of lectures (+ article body + video duration) at submit. Playback of the live revision looks up (published_revision_id, lecture_id) via the PK. Append-only.'`,
  sql`COMMENT ON COLUMN catalog.revision_lectures.duration_seconds IS 'Snapshot of media.assets.duration_ms/1000 at submit (READY assets are immutable, so this is a frozen fact, not a drifting copy).'`,
  // Circular pointers: courses -> its own revisions (composite: a pointer can only target a revision of the same course)
  sql`
    ALTER TABLE catalog.courses
      ADD CONSTRAINT courses_id_published_revision_id_fk FOREIGN KEY (id, published_revision_id)
          REFERENCES catalog.course_revisions (course_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT courses_id_pending_revision_id_fk   FOREIGN KEY (id, pending_revision_id)
          REFERENCES catalog.course_revisions (course_id, id) ON DELETE RESTRICT
  `,
];

// ---------------------------------------------------------------------------
// 9. catalog.course_transitions (append-only, linear hash-chain per course)
// ---------------------------------------------------------------------------
const catalogTransitions = [
  sql`
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
      CONSTRAINT course_transitions_reason_ck                             CHECK (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 2000 AND translate(reason, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]')),
      CONSTRAINT course_transitions_reason_scope_ck                       CHECK (reason IS NULL OR action IN ('APPROVE','REJECT','ARCHIVE','WITHDRAW')),
      CONSTRAINT course_transitions_reject_reason_ck                      CHECK (action <> 'REJECT' OR (reason IS NOT NULL AND char_length(reason) >= 10)),
      CONSTRAINT course_transitions_withdraw_reason_ck                    CHECK (action <> 'WITHDRAW' OR reason IS NULL OR reason = 'ARCHIVED')
    )
  `,
  // each revision submitted once
  sql`
    CREATE UNIQUE INDEX course_transitions_revision_id_submit_uq
      ON catalog.course_transitions (revision_id) WHERE action = 'SUBMIT'
  `,
  // each revision decided once (no approve + reject, no approve after withdraw); also the guard's decision lookup
  sql`
    CREATE UNIQUE INDEX course_transitions_revision_id_decision_uq
      ON catalog.course_transitions (revision_id) WHERE action IN ('APPROVE','REJECT','WITHDRAW')
  `,
  // deleted once
  sql`
    CREATE UNIQUE INDEX course_transitions_course_id_delete_uq
      ON catalog.course_transitions (course_id) WHERE action = 'DELETE'
  `,
  // (history + guard scans by course_id use course_transitions_course_id_prev_transition_id_uq)
  sql`
    CREATE TRIGGER course_transitions_append_only_trg BEFORE UPDATE OR DELETE ON catalog.course_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER course_transitions_no_truncate_trg BEFORE TRUNCATE ON catalog.course_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // Actor rules (immediate)
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER course_transitions_actor_trg BEFORE INSERT ON catalog.course_transitions
      FOR EACH ROW EXECUTE FUNCTION catalog.course_transitions_actor_guard()
  `,
  // Materialised lifecycle == transition log, checked at COMMIT from both sides
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER courses_status_log_trg
      AFTER INSERT OR UPDATE OF status, pending_revision_id, published_revision_id, first_published_at, deleted_at
      ON catalog.courses
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_status_log_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER course_transitions_status_log_trg
      AFTER INSERT ON catalog.course_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_status_log_guard()
  `,
  // Every revision has exactly its SUBMIT transition and is structurally complete (checked at COMMIT)
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER course_revisions_submit_log_trg
      AFTER INSERT ON catalog.course_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.course_revision_submit_guard()
  `,
  sql`
    COMMENT ON TABLE catalog.course_transitions IS
      'Append-only course lifecycle log, kept forever. A linear chain per course (prev_transition_id, unique successor): from_status = predecessor.to_status via composite FK, so the whole state machine is DB-enforced and concurrent transitions on one course cannot both commit.'
  `,
  sql`COMMENT ON COLUMN catalog.course_transitions.prev_transition_id IS 'Head of the chain at insert time (read under the course row lock). NULL only for CREATE.'`,
  sql`COMMENT ON COLUMN catalog.course_transitions.revision_id IS 'Set for SUBMIT/WITHDRAW/APPROVE/REJECT. Each revision has one SUBMIT and at most one decision (APPROVE/REJECT/WITHDRAW).'`,
  sql`COMMENT ON COLUMN catalog.course_transitions.reason IS 'REJECT: required 10..2000. ARCHIVE: owner optional, admin takedown required >= 10 (trigger). APPROVE: optional admin note. WITHDRAW: NULL or the system marker ARCHIVED (auto-withdraw on archive).'`,
  sql`COMMENT ON FUNCTION catalog.course_transitions_actor_guard() IS 'CREATE/SUBMIT/DELETE/plain WITHDRAW by owner only; APPROVE/REJECT never by owner; admin ARCHIVE needs a reason; owner RESTORE only after own ARCHIVE; nothing after DELETE. Whether a non-owner is an ADMIN is decided in the app.'`,
  sql`COMMENT ON FUNCTION catalog.course_status_log_guard() IS 'Deferred: courses.status/pending/published/first_published_at/deleted_at must equal what the transition log implies (courses_status_log_ck).'`,
  sql`COMMENT ON FUNCTION catalog.course_revision_submit_guard() IS 'Deferred: each revision has its SUBMIT transition (same occurred_at, consistent kind) and is structurally complete.'`,
];

// ---------------------------------------------------------------------------
// 10. media.assets
// ---------------------------------------------------------------------------
const mediaAssets = [
  sql`
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
      CONSTRAINT assets_original_filename_ck        CHECK (char_length(original_filename) BETWEEN 1 AND 255 AND original_filename = btrim(original_filename)
                                                           AND original_filename !~ '[[:cntrl:]]'),
      CONSTRAINT assets_declared_content_type_ck    CHECK (char_length(declared_content_type) <= 127
                                                           AND declared_content_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
      CONSTRAINT assets_declared_size_bytes_ck      CHECK (declared_size_bytes BETWEEN 1 AND 5497558138880),   -- 5 TiB (S3 object limit, contracts maxDeclaredBytes)
      CONSTRAINT assets_part_size_bytes_ck          CHECK (part_size_bytes >= 5242880),          -- S3 minimum (all but the last part)
      CONSTRAINT assets_part_count_ck               CHECK (part_count BETWEEN 1 AND 10000
                                                           AND part_count = (declared_size_bytes + part_size_bytes - 1) / part_size_bytes),
      CONSTRAINT assets_source_key_ck               CHECK (source_key = 'uploads/' || owner_id::text || '/' || id::text || '/source'),
      CONSTRAINT assets_s3_upload_id_ck             CHECK ((status = 'UPLOADING') = (s3_upload_id IS NOT NULL)
                                                           AND (s3_upload_id IS NULL OR char_length(s3_upload_id) BETWEEN 1 AND 1024)),
      CONSTRAINT assets_output_prefix_ck            CHECK ((status = 'READY') = (output_prefix IS NOT NULL)
                                                           AND (output_prefix IS NULL OR output_prefix = 'assets/' || id::text || '/' || substring(output_prefix from '(a[0-9]+)/$') || '/')),
      CONSTRAINT assets_duration_ms_ck              CHECK ((duration_ms IS NULL OR (duration_ms >= 0 AND purpose = 'LECTURE_VIDEO'))
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
    )
  `,
  // FK index for owner_id + owner-scoped listing (admin investigation / future media library)
  sql`CREATE INDEX assets_owner_id_created_at_idx ON media.assets (owner_id, created_at DESC)`,
  // Quota (SUM declared_size_bytes) + concurrency (COUNT status='UPLOADING'), index-only
  sql`
    CREATE INDEX assets_owner_id_quota_idx ON media.assets (owner_id, status) INCLUDE (declared_size_bytes)
      WHERE purged_at IS NULL AND status IN ('UPLOADING','UPLOADED','PROCESSING','READY')
  `,
  // Cleanup B: "does this S3 multipart belong to a live UPLOADING asset?"; also uniqueness of upload ids
  sql`CREATE UNIQUE INDEX assets_s3_upload_id_uq ON media.assets (s3_upload_id) WHERE s3_upload_id IS NOT NULL`,
  // Cleanup A: stale UPLOADING
  sql`CREATE INDEX assets_created_at_uploading_idx ON media.assets (created_at) WHERE status = 'UPLOADING'`,
  // Cleanup C: purge candidates (unused, not purged)
  sql`CREATE INDEX assets_unused_since_idx ON media.assets (unused_since) WHERE purged_at IS NULL AND unused_since IS NOT NULL`,
  // Cleanup D: source retention (READY + 7 days, §13) and FAILED-source backstop
  sql`CREATE INDEX assets_ready_at_source_idx  ON media.assets (ready_at)  WHERE status = 'READY'  AND source_deleted_at IS NULL AND purged_at IS NULL`,
  sql`CREATE INDEX assets_failed_at_source_idx ON media.assets (failed_at) WHERE status = 'FAILED' AND source_deleted_at IS NULL AND purged_at IS NULL`,
  // Cleanup C2: retry object deletion after purge
  sql`CREATE INDEX assets_purged_at_objects_idx ON media.assets (purged_at) WHERE purged_at IS NOT NULL AND objects_deleted_at IS NULL`,
  sql`
    CREATE TRIGGER assets_set_updated_at_trg BEFORE UPDATE ON media.assets
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER assets_immutable_trg BEFORE UPDATE ON media.assets
      FOR EACH ROW WHEN (
           (OLD.owner_id, OLD.purpose, OLD.original_filename, OLD.declared_content_type, OLD.declared_size_bytes,
            OLD.part_size_bytes, OLD.part_count, OLD.source_key, OLD.created_at)
           IS DISTINCT FROM
           (NEW.owner_id, NEW.purpose, NEW.original_filename, NEW.declared_content_type, NEW.declared_size_bytes,
            NEW.part_size_bytes, NEW.part_count, NEW.source_key, NEW.created_at)
        OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at))
      EXECUTE FUNCTION public.forbid_row_change('assets_immutable_ck', 'media asset identity/upload-plan columns and purged_at are immutable')
  `,
  sql`
    CREATE TRIGGER assets_status_insert_trg BEFORE INSERT ON media.assets
      FOR EACH ROW WHEN (NEW.status <> 'UPLOADING' OR NEW.purged_at IS NOT NULL OR NEW.first_used_at IS NOT NULL)
      EXECUTE FUNCTION public.forbid_row_change('assets_status_transition_ck', 'a media asset must be created UPLOADING, unused and unpurged')
  `,
  sql`
    CREATE TRIGGER assets_status_transition_trg BEFORE UPDATE OF status ON media.assets
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NOT (
           (OLD.status = 'UPLOADING'  AND NEW.status IN ('UPLOADED','FAILED','ABORTED'))
        OR (OLD.status = 'UPLOADED'   AND NEW.status = 'PROCESSING')
        OR (OLD.status = 'PROCESSING' AND NEW.status IN ('READY','FAILED'))))
      EXECUTE FUNCTION public.forbid_row_change('assets_status_transition_ck', 'illegal media asset status transition')
  `,
  sql`
    COMMENT ON TABLE media.assets IS
      'MediaAsset aggregate. status is a guarded state column (edges enforced by assets_status_transition_ck); audit = media.transcode_attempts + outbox events. Never hard-deleted: purge sets purged_at and deletes objects. Purge is orthogonal to status.'
  `,
  sql`COMMENT ON COLUMN media.assets.original_filename IS 'Display only (sanitised by the app, emitted RFC 5987-encoded). Never used to build keys.'`,
  sql`COMMENT ON COLUMN media.assets.declared_content_type IS 'Browser-declared, advisory only (purpose allowlist enforced in the app/contracts; the transcoder proves the real type).'`,
  sql`COMMENT ON COLUMN media.assets.declared_size_bytes IS 'bigint -> string in TS. Quota counts this. CompleteUpload requires HeadObject size == this.'`,
  sql`COMMENT ON COLUMN media.assets.part_count IS 'Pinned to ceil(declared_size_bytes / part_size_bytes) by assets_part_count_ck.'`,
  sql`COMMENT ON COLUMN media.assets.source_key IS 'Quarantine object key in udemy-uploads. Derivable from (owner_id, id) and pinned to that layout by CHECK (documented 3NF exception: lets cleanup SQL read keys without app code).'`,
  sql`COMMENT ON COLUMN media.assets.s3_upload_id IS 'S3 multipart UploadId; present iff status = UPLOADING.'`,
  sql`COMMENT ON COLUMN media.assets.output_prefix IS 'assets/{id}/a{leaseNo}/ in udemy-media; set at READY.'`,
  sql`COMMENT ON COLUMN media.assets.first_used_at IS 'Maintained by asset_usages triggers. NULL = never attached -> short grace (MEDIA_UNATTACHED_GRACE_HOURS).'`,
  sql`COMMENT ON COLUMN media.assets.unused_since IS 'Maintained by asset_usages triggers under the asset row lock: NULL iff at least one usage exists, else when the last usage went away (creation time if never used). Purge candidate selector. The app must never write it.'`,
  sql`COMMENT ON COLUMN media.assets.purged_at IS 'Set once by the janitor (no usages, grace elapsed). Blocks any new usage (asset_usages_asset_usable_ck).'`,
  sql`COMMENT ON COLUMN media.assets.objects_deleted_at IS 'Set after the source prefix and output prefix were deleted from S3; retried until set.'`,
  sql`COMMENT ON COLUMN media.assets.source_deleted_at IS 'Original deleted: READY + MEDIA_SOURCE_RETENTION_DAYS (7; §13), immediately on FAILED, or at purge.'`,
];

// ---------------------------------------------------------------------------
// 11. media.asset_renditions (append-only)
// ---------------------------------------------------------------------------
const mediaAssetRenditions = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER asset_renditions_append_only_trg BEFORE UPDATE OR DELETE ON media.asset_renditions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER asset_renditions_no_truncate_trg BEFORE TRUNCATE ON media.asset_renditions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`COMMENT ON TABLE media.asset_renditions IS 'Outputs written once in the READY transaction. Master playlist = HLS_VARIANT rows; the rendition name in a URL is validated against these rows. Append-only (kept after purge as history).'`,
  sql`COMMENT ON COLUMN media.asset_renditions.kind IS 'Determined by name (documented exception: query convenience for the master playlist; asset_renditions_kind_name_ck makes drift impossible).'`,
  sql`COMMENT ON COLUMN media.asset_renditions.object_key IS 'HLS: the variant .m3u8; IMAGE: the JPEG; SPRITE: the WebVTT index (tiles live under the same prefix).'`,
];

// ---------------------------------------------------------------------------
// 12. media.asset_usages
// ---------------------------------------------------------------------------
const mediaAssetUsages = [
  sql`
    CREATE TABLE media.asset_usages (
      asset_id      uuid        NOT NULL,
      consumer_type text        NOT NULL,
      consumer_id   uuid        NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT asset_usages_pk               PRIMARY KEY (asset_id, consumer_type, consumer_id),   -- ON CONFLICT target
      CONSTRAINT asset_usages_asset_id_fk      FOREIGN KEY (asset_id) REFERENCES media.assets (id) ON DELETE RESTRICT,
      CONSTRAINT asset_usages_consumer_type_ck CHECK (consumer_type IN ('catalog.lecture','catalog.course_thumbnail','catalog.course_revision'))
    )
  `,
  // An asset has at most one working-copy consumer (one lecture OR one course thumbnail)
  sql`
    CREATE UNIQUE INDEX asset_usages_asset_id_working_uq
      ON media.asset_usages (asset_id) WHERE consumer_type <> 'catalog.course_revision'
  `,
  // A lecture holds one asset; a course one thumbnail (catches release/attach drift)
  sql`
    CREATE UNIQUE INDEX asset_usages_consumer_working_uq
      ON media.asset_usages (consumer_type, consumer_id) WHERE consumer_type <> 'catalog.course_revision'
  `,
  // releaseConsumer(type, id), e.g. all pins of a superseded revision
  sql`CREATE INDEX asset_usages_consumer_type_consumer_id_idx ON media.asset_usages (consumer_type, consumer_id)`,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER asset_usages_usable_trg BEFORE INSERT ON media.asset_usages
      FOR EACH ROW EXECUTE FUNCTION media.asset_usages_usable_guard()
  `,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER asset_usages_track_unused_trg AFTER INSERT OR DELETE ON media.asset_usages
      FOR EACH ROW EXECUTE FUNCTION media.asset_usages_track_unused()
  `,
  sql`
    CREATE TRIGGER asset_usages_immutable_trg BEFORE UPDATE ON media.asset_usages
      FOR EACH ROW EXECUTE FUNCTION public.forbid_row_change('asset_usages_immutable_ck', 'asset usages are insert/delete only')
  `,
  sql`
    COMMENT ON TABLE media.asset_usages IS
      'Reference rows written/deleted by catalog through MediaFacade in catalog''s transaction (D8). An asset with no usages is purge-eligible after the grace period. Insert/delete only; triggers keep media.assets.unused_since/first_used_at exact.'
  `,
  sql`COMMENT ON COLUMN media.asset_usages.consumer_id IS 'catalog.lecture -> lectures.id; catalog.course_thumbnail -> courses.id; catalog.course_revision -> course_revisions.id. Soft reference (D12).'`,
  sql`COMMENT ON FUNCTION media.asset_usages_usable_guard() IS 'BEFORE INSERT: locks the asset (FOR NO KEY UPDATE) and rejects purged/FAILED/ABORTED assets, non-READY revision pins, and purpose/consumer mismatches.'`,
  sql`COMMENT ON FUNCTION media.asset_usages_track_unused() IS 'AFTER INSERT/DELETE: maintains assets.unused_since (NULL iff used) and first_used_at under the asset row lock. Requires READ COMMITTED.'`,
];

// ---------------------------------------------------------------------------
// 13. media.transcode_jobs
// ---------------------------------------------------------------------------
const mediaTranscodeJobs = [
  sql`
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
    )
  `,
  // Lease pickup: WHERE status='QUEUED' AND run_after <= now() ORDER BY run_after, asset_id LIMIT 1 FOR UPDATE SKIP LOCKED
  sql`CREATE INDEX transcode_jobs_run_after_queued_idx ON media.transcode_jobs (run_after, asset_id) WHERE status = 'QUEUED'`,
  // Reaper: WHERE status='RUNNING' AND lease_expires_at < now()
  sql`CREATE INDEX transcode_jobs_lease_expires_at_running_idx ON media.transcode_jobs (lease_expires_at) WHERE status = 'RUNNING'`,
  sql`
    CREATE TRIGGER transcode_jobs_set_updated_at_trg BEFORE UPDATE ON media.transcode_jobs
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    CREATE TRIGGER transcode_jobs_status_insert_trg BEFORE INSERT ON media.transcode_jobs
      FOR EACH ROW WHEN (NEW.status <> 'QUEUED' OR NEW.attempts <> 0 OR NEW.lease_count <> 0)
      EXECUTE FUNCTION public.forbid_row_change('transcode_jobs_status_transition_ck', 'a transcode job must be created QUEUED with no attempts')
  `,
  sql`
    CREATE TRIGGER transcode_jobs_status_transition_trg BEFORE UPDATE OF status ON media.transcode_jobs
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NOT (
           (OLD.status = 'QUEUED'  AND NEW.status IN ('RUNNING','CANCELLED'))
        OR (OLD.status = 'RUNNING' AND NEW.status IN ('QUEUED','SUCCEEDED','FAILED','CANCELLED'))))
      EXECUTE FUNCTION public.forbid_row_change('transcode_jobs_status_transition_ck', 'illegal transcode job status transition')
  `,
  sql`
    CREATE FUNCTION media.transcode_jobs_notify() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('media_transcode', NEW.asset_id::text);   -- delivered at COMMIT; deduplicated per tx
      RETURN NULL;
    END
    $$
  `,
  sql`
    CREATE TRIGGER transcode_jobs_notify_trg AFTER INSERT OR UPDATE OF status ON media.transcode_jobs
      FOR EACH ROW WHEN (NEW.status = 'QUEUED' AND NEW.run_after <= now())
      EXECUTE FUNCTION media.transcode_jobs_notify()
  `,
  sql`
    COMMENT ON TABLE media.transcode_jobs IS
      'One processing job per asset (enqueued by the worker on MediaUploaded). Leased with FOR UPDATE SKIP LOCKED by apps/transcoder; lease_count is the fencing token. NOTIFY media_transcode on (re)queue; LISTEN is a latency optimisation, polling is the correctness path.'
  `,
  sql`COMMENT ON COLUMN media.transcode_jobs.attempts IS 'Penalised attempts (counted toward max_attempts). Graceful shutdown gives the attempt back (attempts - 1).'`,
  sql`COMMENT ON COLUMN media.transcode_jobs.lease_count IS 'Total leases ever taken (never decremented). = transcode_attempts.attempt_no and the a{n} output prefix of the current lease; heartbeat/complete are fenced on it.'`,
  sql`COMMENT ON COLUMN media.transcode_jobs.run_after IS 'Not before this time (exponential backoff on retry: now() + 2^attempts minutes).'`,
  sql`COMMENT ON COLUMN media.transcode_jobs.status IS 'CANCELLED = the asset was purged or no longer processable when leased.'`,
];

// ---------------------------------------------------------------------------
// 14. media.transcode_attempts (append-only except the single "finish" update)
// ---------------------------------------------------------------------------
const mediaTranscodeAttempts = [
  sql`
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
                                                           'TRANSCODE_ERROR','TIMEOUT','INTERNAL','CRASHED')))
                                                          AND (outcome IS DISTINCT FROM 'FAILED' OR error_code IS NOT NULL)),
      CONSTRAINT transcode_attempts_error_detail_ck CHECK (error_detail IS NULL OR (error_code IS NOT NULL AND char_length(error_detail) <= 2000))
    )
  `,
  // Never two open attempts for one asset (the reaper must close a crashed attempt before the next lease)
  sql`CREATE UNIQUE INDEX transcode_attempts_asset_id_open_uq ON media.transcode_attempts (asset_id) WHERE finished_at IS NULL`,
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER transcode_attempts_guard_trg BEFORE UPDATE OR DELETE ON media.transcode_attempts
      FOR EACH ROW EXECUTE FUNCTION media.transcode_attempts_guard()
  `,
  sql`
    CREATE TRIGGER transcode_attempts_no_truncate_trg BEFORE TRUNCATE ON media.transcode_attempts
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE media.transcode_attempts IS
      'Processing audit, kept forever. Row inserted at lease (open attempt = evidence of a crash if the lease expires), finished exactly once. error_detail is internal, never user-visible.'
  `,
  sql`COMMENT ON COLUMN media.transcode_attempts.attempt_no IS '= transcode_jobs.lease_count at lease time (monotonic; graceful releases do not reuse numbers).'`,
  sql`COMMENT ON COLUMN media.transcode_attempts.outcome IS 'RELEASED = graceful shutdown (not penalised). LEASE_LOST = lease expired (crash/OOM), closed by the reaper.'`,
];

// ---------------------------------------------------------------------------
// 15. Privileges (prod role split; no-op in dev where the roles don't exist)
// ---------------------------------------------------------------------------
const privileges = [
  sql`
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
    $$
  `,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await run(db, shared);
  await run(db, catalogCategories);
  await run(db, catalogCourses);
  await run(db, catalogCourseBullets);
  await run(db, catalogSections);
  await run(db, catalogLectures);
  await run(db, catalogLectureArticles);
  await run(db, catalogWorkingCopyGuard);
  await run(db, catalogRevisions);
  await run(db, catalogTransitions);
  await run(db, mediaAssets);
  await run(db, mediaAssetRenditions);
  await run(db, mediaAssetUsages);
  await run(db, mediaTranscodeJobs);
  await run(db, mediaTranscodeAttempts);
  await run(db, privileges);
}

/**
 * Down order of schema doc §1, no CASCADE (matches 0001/0002): if a later migration still
 * depends on any of these objects, fail loudly instead of silently dropping it.
 * Grants/comments/triggers/indexes go away with their tables and functions. The catalog and
 * media schemas stay: 0001 owns them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await run(db, [
    // 1. media tables (children first)
    sql`DROP TABLE IF EXISTS media.transcode_attempts`,
    sql`DROP TABLE IF EXISTS media.transcode_jobs`,
    sql`DROP TABLE IF EXISTS media.asset_usages`,
    sql`DROP TABLE IF EXISTS media.asset_renditions`,
    sql`DROP TABLE IF EXISTS media.assets`,
    // 2. media functions
    sql`DROP FUNCTION IF EXISTS media.transcode_attempts_guard()`,
    sql`DROP FUNCTION IF EXISTS media.transcode_jobs_notify()`,
    sql`DROP FUNCTION IF EXISTS media.asset_usages_track_unused()`,
    sql`DROP FUNCTION IF EXISTS media.asset_usages_usable_guard()`,
    // 3. break the courses <-> course_revisions cycle
    sql`
      ALTER TABLE IF EXISTS catalog.courses
        DROP CONSTRAINT IF EXISTS courses_id_published_revision_id_fk,
        DROP CONSTRAINT IF EXISTS courses_id_pending_revision_id_fk
    `,
    // 4. catalog tables
    sql`DROP TABLE IF EXISTS catalog.course_transitions`,
    sql`DROP TABLE IF EXISTS catalog.revision_lectures`,
    sql`DROP TABLE IF EXISTS catalog.revision_sections`,
    sql`DROP TABLE IF EXISTS catalog.revision_bullets`,
    sql`DROP TABLE IF EXISTS catalog.course_revisions`,
    sql`DROP TABLE IF EXISTS catalog.lecture_articles`,
    sql`DROP TABLE IF EXISTS catalog.lectures`,
    sql`DROP TABLE IF EXISTS catalog.sections`,
    sql`DROP TABLE IF EXISTS catalog.course_bullets`,
    sql`DROP TABLE IF EXISTS catalog.courses`,
    sql`DROP TABLE IF EXISTS catalog.categories`,
    // 5. catalog functions
    sql`DROP FUNCTION IF EXISTS catalog.course_revision_submit_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.course_status_log_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.course_transitions_actor_guard()`,
    sql`DROP FUNCTION IF EXISTS catalog.working_copy_guard()`,
    // 6. shared helper
    sql`DROP FUNCTION IF EXISTS public.forbid_row_change()`,
  ]);
}
