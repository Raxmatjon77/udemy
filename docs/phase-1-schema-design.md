# T1: Final schema design for migration `0002_identity_access_users`

**Inputs:** `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/phase-1-identity-access-design.md` (§2, §4–§8, §13), `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/migrations/2026_10_09_0001_init.ts`, `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/database.ts`, `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/src/generated/db.ts`, `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/packages/db/package.json` (kysely 0.29.6, kysely-codegen 0.20.0 `--camel-case`), `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/docs/architecture-plan.md` §3, and `/Users/hamidovraxmatjon/coding/learnigProjects/udemy/infra/docker/docker-compose.dev.yml`.

**Facts that shape the design:**

- In dev, `udemy` is created through `POSTGRES_USER`, which makes it a **superuser**. A superuser ignores GRANT and REVOKE, so the append-only rule can only be enforced with triggers in dev.
- Migration 0001 sets these conventions: `uuidv7()` defaults, the `public.set_updated_at()` function, and indexes named `<table>_<cols>_idx`.

**Naming:**

- Constraints use `<table>_<cols>_<pk|fk|uq|ck>`. Unique indexes are also named `_uq`. Partial unique indexes add a qualifier before the suffix (for example `_active_uq`).
- **Exception:** `users.instructor_application_transitions` uses the prefix `ia_transitions_`. The full table name plus column names goes past PostgreSQL's 63-character identifier limit (`..._application_id_from_status_uq` is 64 chars), and PostgreSQL would silently truncate the name.

---

## 1. Complete DDL

```sql
-- =====================================================================
-- 0. Schema + shared helper
-- =====================================================================
CREATE SCHEMA users;   -- owned by 0002; down() drops it (no CASCADE, matches 0001 style)

-- Generic guard for append-only tables (row-level UPDATE/DELETE and statement-level TRUNCATE).
CREATE FUNCTION public.forbid_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is forbidden: table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;
COMMENT ON FUNCTION public.forbid_append_only_mutation() IS
  'Trigger function: rejects UPDATE/DELETE/TRUNCATE on append-only history tables. Works even for superusers (unlike REVOKE).';

-- =====================================================================
-- 1. identity
-- =====================================================================
CREATE TABLE identity.users (
  id                  uuid        NOT NULL DEFAULT uuidv7(),
  email               citext      NOT NULL,                 -- normalised by the Email VO (trim, NFKC, lowercase)
  display_name        text        NOT NULL,
  password_hash       text        NOT NULL,                 -- Argon2id PHC string
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  email_verified_at   timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pk                PRIMARY KEY (id),
  CONSTRAINT users_email_uq          UNIQUE (email),
  CONSTRAINT users_email_ck          CHECK (char_length(email::text) <= 254 AND strpos(email::text, '@') > 1),
  CONSTRAINT users_display_name_ck   CHECK (char_length(display_name) BETWEEN 1 AND 60
                                            AND display_name = btrim(display_name)
                                            AND display_name !~ '[[:cntrl:]]'),
  CONSTRAINT users_password_hash_ck  CHECK (password_hash LIKE '$argon2id$%')
);
-- Admin keyset: ORDER BY created_at DESC, id DESC WHERE (created_at, id) < (:c, :id)
CREATE INDEX users_created_at_id_idx      ON identity.users (created_at DESC, id DESC);
-- Admin q-search: display_name ILIKE '%q%'
CREATE INDEX users_display_name_trgm_idx  ON identity.users USING gin (display_name gin_trgm_ops);
-- Admin q-search: email::text ILIKE '%q%'  (query MUST use the exact expression email::text)
CREATE INDEX users_email_trgm_idx         ON identity.users USING gin ((email::text) gin_trgm_ops);
CREATE TRIGGER users_set_updated_at_trg BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE identity.users IS
  'Account aggregate (shared-kernel identity). The only cross-schema FK target (D12). No status column: ACTIVE/BANNED is derived from identity.user_bans. Rows are never hard-deleted in Phase 1; all FKs to it are RESTRICT.';
COMMENT ON COLUMN identity.users.email IS 'citext for case-insensitive uniqueness; the app stores the normalised (lowercase NFKC) form.';
COMMENT ON COLUMN identity.users.display_name IS 'Lives here (D8) so signup is atomic without an identity->users dependency. Rich profile is users.profiles.';
COMMENT ON COLUMN identity.users.password_hash IS 'Argon2id PHC-encoded string ($argon2id$v=19$m=...). CHECK pins the algorithm; changing algorithms requires a migration.';
COMMENT ON COLUMN identity.users.email_verified_at IS 'NULL = unverified. Set only by a one-time token issued for the current email (or by reset / CLI provisioning).';

CREATE TABLE identity.user_bans (
  id          uuid        NOT NULL DEFAULT uuidv7(),
  user_id     uuid        NOT NULL,
  reason      text        NOT NULL,
  banned_by   uuid        NOT NULL,
  banned_at   timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz NULL,
  lifted_by   uuid        NULL,
  lift_reason text        NULL,
  CONSTRAINT user_bans_pk                       PRIMARY KEY (id),
  CONSTRAINT user_bans_user_id_fk               FOREIGN KEY (user_id)   REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT user_bans_banned_by_fk             FOREIGN KEY (banned_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT user_bans_lifted_by_fk             FOREIGN KEY (lifted_by) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT user_bans_reason_ck                CHECK (char_length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT user_bans_lift_reason_ck           CHECK (lift_reason IS NULL OR char_length(lift_reason) BETWEEN 1 AND 1000),
  CONSTRAINT user_bans_lifted_at_lifted_by_ck   CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CONSTRAINT user_bans_lift_reason_lifted_at_ck CHECK (lift_reason IS NULL OR lifted_at IS NOT NULL),
  CONSTRAINT user_bans_banned_by_ck             CHECK (banned_by <> user_id),
  CONSTRAINT user_bans_lifted_by_ck             CHECK (lifted_by IS NULL OR lifted_by <> user_id),
  CONSTRAINT user_bans_lifted_at_ck             CHECK (lifted_at IS NULL OR lifted_at >= banned_at)
);
-- One active ban per user; also serves login/refresh ban check and admin status filter (EXISTS ... lifted_at IS NULL)
CREATE UNIQUE INDEX user_bans_user_id_active_uq ON identity.user_bans (user_id) WHERE lifted_at IS NULL;
-- listBans(userId) ORDER BY banned_at DESC; also the FK index for user_id
CREATE INDEX user_bans_user_id_banned_at_idx ON identity.user_bans (user_id, banned_at DESC);

COMMENT ON TABLE identity.user_bans IS
  'Ban history + current ban (row with lifted_at IS NULL). Authentication-blocking state, so owned by identity (D9). Kept forever.';
COMMENT ON COLUMN identity.user_bans.lifted_at IS 'NULL = ban is active. Set once by UPDATE ... WHERE user_id=$1 AND lifted_at IS NULL.';

CREATE TABLE identity.sessions (
  id                  uuid        NOT NULL DEFAULT uuidv7(),
  user_id             uuid        NOT NULL,
  client_app          text        NOT NULL,
  user_agent          text        NULL,
  created_ip          inet        NOT NULL,
  last_ip             inet        NOT NULL,              -- app sets = created_ip on insert
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz NULL,
  revoke_reason       text        NULL,
  CONSTRAINT sessions_pk                          PRIMARY KEY (id),
  CONSTRAINT sessions_user_id_fk                  FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT sessions_client_app_ck               CHECK (client_app IN ('student','instructor','admin')),
  CONSTRAINT sessions_user_agent_ck               CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT sessions_revoke_reason_ck            CHECK (revoke_reason IS NULL OR revoke_reason IN
                                                   ('LOGOUT','LOGOUT_ALL','USER_REVOKED','REUSE_DETECTED',
                                                    'PASSWORD_CHANGED','PASSWORD_RESET','BANNED','ROLE_LOST')),
  CONSTRAINT sessions_revoked_at_revoke_reason_ck CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT sessions_absolute_expires_at_ck      CHECK (absolute_expires_at > created_at)
) WITH (fillfactor = 90);   -- last_used_at/last_ip updated on every refresh; unindexed -> HOT updates
-- Sessions list, activeSessionCount, revoke-all (UPDATE ... WHERE user_id=$1 AND revoked_at IS NULL)
CREATE INDEX sessions_user_id_active_idx     ON identity.sessions (user_id) WHERE revoked_at IS NULL;
-- Cleanup: absolute-expired sessions
CREATE INDEX sessions_absolute_expires_at_idx ON identity.sessions (absolute_expires_at);
-- Cleanup: revoked sessions past the forensic grace period
CREATE INDEX sessions_revoked_at_idx         ON identity.sessions (revoked_at) WHERE revoked_at IS NOT NULL;

COMMENT ON TABLE identity.sessions IS
  'Refresh-token family. ACTIVE/REVOKED stored; EXPIRED derived (absolute_expires_at, or current refresh token expires_at). A revoked session is never reactivated.';
COMMENT ON COLUMN identity.sessions.client_app IS 'App the session was issued to; refresh must come from the same BFF client.';
COMMENT ON COLUMN identity.sessions.user_agent IS 'Raw UA truncated to 512 chars by the app; device is parsed at read time.';
COMMENT ON COLUMN identity.sessions.last_ip IS 'IP of the most recent login/refresh (from trusted X-Client-IP).';

CREATE TABLE identity.refresh_tokens (
  id          uuid        NOT NULL DEFAULT uuidv7(),
  session_id  uuid        NOT NULL,
  token_hash  bytea       NOT NULL,                      -- HMAC-SHA256(pepper, raw)
  parent_id   uuid        NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                      -- min(issued_at + idleTtl(app), session.absolute_expires_at)
  consumed_at timestamptz NULL,
  CONSTRAINT refresh_tokens_pk              PRIMARY KEY (id),
  CONSTRAINT refresh_tokens_session_id_id_uq UNIQUE (session_id, id),  -- composite-FK target + cascade/family index
  CONSTRAINT refresh_tokens_session_id_fk   FOREIGN KEY (session_id) REFERENCES identity.sessions (id) ON DELETE CASCADE,
  -- parent must be in the SAME session; deleting an old parent only nulls parent_id (never the child's session_id)
  CONSTRAINT refresh_tokens_parent_id_fk    FOREIGN KEY (session_id, parent_id)
                                            REFERENCES identity.refresh_tokens (session_id, id)
                                            ON DELETE SET NULL (parent_id),
  CONSTRAINT refresh_tokens_token_hash_uq   UNIQUE (token_hash),       -- refresh/logout lookup by hash
  CONSTRAINT refresh_tokens_parent_id_uq    UNIQUE (parent_id),        -- at most one child per token; grace-path child lookup
  CONSTRAINT refresh_tokens_token_hash_ck   CHECK (octet_length(token_hash) = 32),
  CONSTRAINT refresh_tokens_expires_at_ck   CHECK (expires_at > issued_at),
  CONSTRAINT refresh_tokens_parent_id_ck    CHECK (parent_id IS NULL OR parent_id <> id)
);
-- Exactly-one-current (DB guarantees at most one; rotation inserts the child in the same tx).
-- INCLUDE lets the sessions list / idle-expiry check read expires_at index-only.
CREATE UNIQUE INDEX refresh_tokens_session_id_current_uq
  ON identity.refresh_tokens (session_id) INCLUDE (expires_at) WHERE consumed_at IS NULL;
-- Cleanup: consumed tokens past expiry; idle-expired sessions (current token expired)
CREATE INDEX refresh_tokens_expires_at_idx ON identity.refresh_tokens (expires_at);

COMMENT ON TABLE identity.refresh_tokens IS
  'Rotating opaque refresh tokens. One unconsumed (current) token per session; consumed tokens are kept until expires_at + grace for reuse detection.';
COMMENT ON COLUMN identity.refresh_tokens.token_hash IS 'HMAC-SHA256(REFRESH_TOKEN_PEPPER, raw token), 32 bytes. The raw token is never stored.';
COMMENT ON COLUMN identity.refresh_tokens.parent_id IS 'Token this one rotated from. NULL for the first token of a session, or after the parent was purged by cleanup.';
COMMENT ON COLUMN identity.refresh_tokens.consumed_at IS 'Set when rotated. Presenting a consumed token outside the 10 s grace window = reuse -> revoke the family.';

CREATE TABLE identity.one_time_tokens (
  id              uuid        NOT NULL DEFAULT uuidv7(),
  user_id         uuid        NOT NULL,
  purpose         text        NOT NULL,
  token_hash      bytea       NOT NULL,                  -- SHA-256(raw)
  email           citext      NOT NULL,
  source_event_id uuid        NOT NULL,
  requested_at    timestamptz NOT NULL,                  -- from the event, not now()
  expires_at      timestamptz NOT NULL,                  -- requested_at + TTL(purpose)
  consumed_at     timestamptz NULL,
  invalidated_at  timestamptz NULL,
  CONSTRAINT one_time_tokens_pk                            PRIMARY KEY (id),
  CONSTRAINT one_time_tokens_user_id_fk                    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT one_time_tokens_token_hash_uq                 UNIQUE (token_hash),
  CONSTRAINT one_time_tokens_source_event_id_uq            UNIQUE (source_event_id),
  CONSTRAINT one_time_tokens_purpose_ck                    CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
  CONSTRAINT one_time_tokens_token_hash_ck                 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT one_time_tokens_email_ck                      CHECK (char_length(email::text) <= 254),
  CONSTRAINT one_time_tokens_expires_at_ck                 CHECK (expires_at > requested_at),
  CONSTRAINT one_time_tokens_consumed_at_invalidated_at_ck CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);
-- One live (unconsumed, uninvalidated) token per (user, purpose). Expired-but-unconsumed still counts as live.
CREATE UNIQUE INDEX one_time_tokens_user_id_purpose_live_uq
  ON identity.one_time_tokens (user_id, purpose) WHERE consumed_at IS NULL AND invalidated_at IS NULL;
-- Out-of-order check ("newer requested_at exists?") + invalidate-others on reset; FK index for user_id
CREATE INDEX one_time_tokens_user_id_purpose_requested_at_idx
  ON identity.one_time_tokens (user_id, purpose, requested_at DESC);
-- Cleanup
CREATE INDEX one_time_tokens_expires_at_idx ON identity.one_time_tokens (expires_at);

COMMENT ON TABLE identity.one_time_tokens IS
  'Email-verification and password-reset tokens, issued deterministically by the worker (D10). Only the hash is stored.';
COMMENT ON COLUMN identity.one_time_tokens.email IS 'Address the token was sent to. Verification succeeds only if it still equals identity.users.email.';
COMMENT ON COLUMN identity.one_time_tokens.source_event_id IS 'outbox event id that caused issuance; worker idempotency (INSERT ... ON CONFLICT (source_event_id) DO NOTHING).';
COMMENT ON COLUMN identity.one_time_tokens.requested_at IS 'Event timestamp; used to drop out-of-order redeliveries.';
COMMENT ON COLUMN identity.one_time_tokens.invalidated_at IS 'Superseded by a newer token or by a password change. Mutually exclusive with consumed_at.';

CREATE TABLE identity.security_events (
  id          uuid        NOT NULL DEFAULT uuidv7(),
  user_id     uuid        NULL,
  session_id  uuid        NULL,                          -- soft reference (sessions are purged)
  type        text        NOT NULL,
  client_app  text        NULL,
  ip          inet        NULL,
  user_agent  text        NULL,
  email_hash  bytea       NULL,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_events_pk            PRIMARY KEY (id),
  CONSTRAINT security_events_user_id_fk    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT security_events_type_ck       CHECK (type IN (
      'LOGIN_SUCCEEDED','LOGIN_FAILED','LOGIN_THROTTLED',
      'REFRESH_REUSE_DETECTED','REFRESH_REJECTED',
      'LOGOUT','LOGOUT_ALL','SESSION_REVOKED',
      'PASSWORD_RESET_REQUESTED','PASSWORD_CHANGED','EMAIL_VERIFIED',
      'USER_BANNED','USER_UNBANNED')),
  CONSTRAINT security_events_client_app_ck CHECK (client_app IS NULL OR client_app IN ('student','instructor','admin')),
  CONSTRAINT security_events_user_agent_ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT security_events_email_hash_ck CHECK (email_hash IS NULL OR octet_length(email_hash) = 32),
  CONSTRAINT security_events_metadata_ck   CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096)
);
-- Per-user security timeline (admin detail / investigations); anonymous failures excluded from the index
CREATE INDEX security_events_user_id_occurred_at_idx
  ON identity.security_events (user_id, occurred_at DESC) WHERE user_id IS NOT NULL;
-- Retention purge + time-range scans; append-only, insert order = time order -> BRIN is tiny and effective
CREATE INDEX security_events_occurred_at_brin_idx ON identity.security_events USING brin (occurred_at);

-- Append-only, except DELETE of rows past the 180-day retention.
CREATE FUNCTION identity.security_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.occurred_at < now() - interval '180 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity.security_events is append-only (% refused; only rows older than 180 days may be deleted)', TG_OP
    USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER security_events_append_only_trg BEFORE UPDATE OR DELETE ON identity.security_events
  FOR EACH ROW EXECUTE FUNCTION identity.security_events_guard();
CREATE TRIGGER security_events_no_truncate_trg BEFORE TRUNCATE ON identity.security_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- Retention purge entry point (the only way the app role can delete; SECURITY DEFINER runs as owner).
CREATE FUNCTION identity.purge_security_events(p_batch_size integer DEFAULT 5000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 50000 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 50000' USING ERRCODE = '22023';
  END IF;
  DELETE FROM identity.security_events
  WHERE id = ANY (ARRAY(
    SELECT id FROM identity.security_events
    WHERE occurred_at < now() - interval '180 days'
    LIMIT p_batch_size));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;
REVOKE ALL ON FUNCTION identity.purge_security_events(integer) FROM PUBLIC;

COMMENT ON TABLE identity.security_events IS
  'Append-only authentication telemetry (never on Kafka). Retention 180 days via identity.purge_security_events(); UPDATE/TRUNCATE always rejected, DELETE only for rows past retention.';
COMMENT ON COLUMN identity.security_events.session_id IS 'Soft reference to identity.sessions(id); no FK so history survives session cleanup.';
COMMENT ON COLUMN identity.security_events.email_hash IS 'HMAC-SHA256(LOGIN_EMAIL_HMAC_KEY, attempted email) for unknown-account failures. Never the raw email.';
COMMENT ON COLUMN identity.security_events.metadata IS 'Small JSON object (<= 4 KiB), e.g. {"cause":"wrong_app"}. Use camelCase keys: CamelCasePlugin camel-cases jsonb keys on read.';
COMMENT ON FUNCTION identity.purge_security_events(integer) IS 'Deletes up to p_batch_size rows older than 180 days; returns the count. Call repeatedly until < batch size.';

-- =====================================================================
-- 2. access
-- =====================================================================
CREATE TABLE access.roles (
  code        text    NOT NULL,
  is_implicit boolean NOT NULL,
  description text    NOT NULL,
  CONSTRAINT roles_pk                     PRIMARY KEY (code),
  CONSTRAINT roles_code_is_implicit_uq    UNIQUE (code, is_implicit),   -- target of the composite FKs
  CONSTRAINT roles_code_ck                CHECK (code ~ '^[A-Z][A-Z_]{1,31}$'),
  CONSTRAINT roles_student_is_implicit_ck CHECK (code <> 'STUDENT' OR is_implicit),
  CONSTRAINT roles_description_ck         CHECK (char_length(description) BETWEEN 1 AND 500)
);
INSERT INTO access.roles (code, is_implicit, description) VALUES
  ('STUDENT',    true,  'Held implicitly by every active account; never stored in access.user_roles.'),
  ('INSTRUCTOR', false, 'Granted when an instructor application is approved. Required to sign in to the instructor app.'),
  ('ADMIN',      false, 'Granted by the admin:bootstrap CLI or by an admin. Required to sign in to the admin app.');

COMMENT ON TABLE access.roles IS
  'Role reference data, seeded by migration. Permissions are code-defined (D4); no permissions table. is_implicit=true roles cannot be assigned (composite FK + CHECK on user_roles/role_changes).';
COMMENT ON COLUMN access.roles.is_implicit IS 'true = held by construction (STUDENT). Pinned true for STUDENT by roles_student_is_implicit_ck.';

CREATE TABLE access.user_roles (
  user_id          uuid        NOT NULL,
  role_code        text        NOT NULL,
  role_is_implicit boolean     NOT NULL DEFAULT false,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_pk                            PRIMARY KEY (user_id, role_code),
  CONSTRAINT user_roles_user_id_fk                    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_role_code_role_is_implicit_fk FOREIGN KEY (role_code, role_is_implicit)
                                                      REFERENCES access.roles (code, is_implicit)
                                                      ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT user_roles_role_is_implicit_ck           CHECK (role_is_implicit = false)
);
-- listUserIdsWithRole(role) -> admin role filter
CREATE INDEX user_roles_role_code_user_id_idx ON access.user_roles (role_code, user_id);

COMMENT ON TABLE access.user_roles IS
  'Current explicit role holdings (INSTRUCTOR/ADMIN only). State table; who/why lives in access.role_changes. Grant = INSERT ... ON CONFLICT DO NOTHING RETURNING; revoke = DELETE ... RETURNING; history row only if a row was returned.';
COMMENT ON COLUMN access.user_roles.role_is_implicit IS 'Always false. Exists only to make the composite FK to roles(code,is_implicit) reject implicit roles (STUDENT).';

CREATE TABLE access.role_changes (
  id               uuid        NOT NULL DEFAULT uuidv7(),
  user_id          uuid        NOT NULL,
  role_code        text        NOT NULL,
  role_is_implicit boolean     NOT NULL DEFAULT false,
  change           text        NOT NULL,
  actor_id         uuid        NULL,
  reason           text        NOT NULL,
  source_type      text        NULL,
  source_id        uuid        NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_changes_pk                            PRIMARY KEY (id),
  CONSTRAINT role_changes_user_id_fk                    FOREIGN KEY (user_id)  REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT role_changes_actor_id_fk                   FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT role_changes_role_code_role_is_implicit_fk FOREIGN KEY (role_code, role_is_implicit)
                                                        REFERENCES access.roles (code, is_implicit)
                                                        ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT role_changes_role_is_implicit_ck           CHECK (role_is_implicit = false),
  CONSTRAINT role_changes_change_ck                     CHECK (change IN ('GRANTED','REVOKED')),
  CONSTRAINT role_changes_reason_ck                     CHECK (char_length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT role_changes_source_type_ck                CHECK (source_type IS NULL OR source_type IN ('instructor_application','cli_bootstrap','admin')),
  CONSTRAINT role_changes_grant_source_type_ck          CHECK (change = 'REVOKED' OR source_type IS NOT NULL),
  CONSTRAINT role_changes_revoke_source_type_ck         CHECK (change = 'GRANTED' OR source_type IS NULL OR source_type = 'admin'),
  CONSTRAINT role_changes_source_id_ck                  CHECK ((source_id IS NOT NULL) = (source_type IS NOT DISTINCT FROM 'instructor_application')),
  CONSTRAINT role_changes_actor_id_ck                   CHECK ((actor_id IS NULL) = (source_type IS NOT DISTINCT FROM 'cli_bootstrap'))
);
-- Role history per user (admin user detail)
CREATE INDEX role_changes_user_id_occurred_at_idx ON access.role_changes (user_id, occurred_at DESC);
CREATE TRIGGER role_changes_append_only_trg BEFORE UPDATE OR DELETE ON access.role_changes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER role_changes_no_truncate_trg BEFORE TRUNCATE ON access.role_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

COMMENT ON TABLE access.role_changes IS
  'Append-only role grant/revoke history. Written only when the state table actually changed. Kept forever.';
COMMENT ON COLUMN access.role_changes.actor_id IS 'NULL only for source_type = cli_bootstrap (first admin).';
COMMENT ON COLUMN access.role_changes.source_id IS 'Set iff source_type = instructor_application (the application id). Soft reference.';

-- =====================================================================
-- 3. users
-- =====================================================================
CREATE TABLE users.profiles (
  user_id         uuid        NOT NULL,
  headline        text        NULL,
  bio             text        NULL,
  avatar_media_id uuid        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pk          PRIMARY KEY (user_id),
  CONSTRAINT profiles_user_id_fk  FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT profiles_headline_ck CHECK (headline IS NULL OR (char_length(headline) BETWEEN 1 AND 60 AND headline = btrim(headline))),
  CONSTRAINT profiles_bio_ck      CHECK (bio IS NULL OR char_length(bio) BETWEEN 1 AND 4000)
);
CREATE TRIGGER profiles_set_updated_at_trg BEFORE UPDATE ON users.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE users.profiles IS 'Optional public profile, created lazily on first PATCH (INSERT ... ON CONFLICT (user_id) DO UPDATE). 1:0..1 with identity.users.';
COMMENT ON COLUMN users.profiles.headline IS 'NULL = not set. Empty string is rejected so "unset" has a single representation.';
COMMENT ON COLUMN users.profiles.avatar_media_id IS 'Soft reference to the Phase 2 media module; FK added when media exists.';

CREATE TABLE users.instructor_applications (
  id               uuid        NOT NULL DEFAULT uuidv7(),
  applicant_id     uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'PENDING',
  motivation       text        NOT NULL,
  expertise        text        NOT NULL,
  experience_level text        NOT NULL,
  portfolio_url    text        NULL,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instructor_applications_pk               PRIMARY KEY (id),
  CONSTRAINT instructor_applications_applicant_id_fk  FOREIGN KEY (applicant_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT instructor_applications_status_ck        CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  CONSTRAINT instructor_applications_motivation_ck    CHECK (char_length(motivation) BETWEEN 100 AND 3000),
  CONSTRAINT instructor_applications_expertise_ck     CHECK (char_length(expertise) BETWEEN 3 AND 200),
  CONSTRAINT instructor_applications_experience_level_ck CHECK (experience_level IN ('NONE','INFORMAL','PROFESSIONAL','ONLINE')),
  CONSTRAINT instructor_applications_portfolio_url_ck CHECK (portfolio_url IS NULL OR
                                                        (char_length(portfolio_url) <= 2048 AND portfolio_url ~ '^https://[^[:space:]]+$')),
  CONSTRAINT instructor_applications_version_ck       CHECK (version >= 1)
);
-- One PENDING per applicant (race-safe; 23505 -> ApplicationAlreadyPending)
CREATE UNIQUE INDEX instructor_applications_applicant_id_pending_uq
  ON users.instructor_applications (applicant_id) WHERE status = 'PENDING';
-- Admin queue keyset: WHERE status=$1 AND (submitted_at,id) > ($c1,$c2) ORDER BY submitted_at, id
CREATE INDEX instructor_applications_status_submitted_at_id_idx
  ON users.instructor_applications (status, submitted_at, id);
-- "My applications" newest first; FK index for applicant_id
CREATE INDEX instructor_applications_applicant_id_submitted_at_idx
  ON users.instructor_applications (applicant_id, submitted_at DESC);
CREATE TRIGGER instructor_applications_set_updated_at_trg BEFORE UPDATE ON users.instructor_applications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE users.instructor_applications IS
  'InstructorApplication aggregate. status is a guarded materialisation of the latest transition (documented 3NF exception), verified at commit by a deferred constraint trigger.';
COMMENT ON COLUMN users.instructor_applications.status IS 'Materialised = to_status of the transition that has no successor. Needed for the partial unique index and the queue index.';
COMMENT ON COLUMN users.instructor_applications.submitted_at IS 'Aggregate creation time; equals the submission transition occurred_at (same transaction, same now()).';
COMMENT ON COLUMN users.instructor_applications.version IS 'Optimistic-concurrency token; incremented on every state change (expectedVersion).';

CREATE TABLE users.instructor_application_transitions (
  id             uuid        NOT NULL DEFAULT uuidv7(),
  application_id uuid        NOT NULL,
  from_status    text        NULL,
  to_status      text        NOT NULL,
  actor_id       uuid        NOT NULL,
  reason         text        NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_transitions_pk                        PRIMARY KEY (id),
  CONSTRAINT ia_transitions_application_id_fk         FOREIGN KEY (application_id) REFERENCES users.instructor_applications (id) ON DELETE RESTRICT,
  CONSTRAINT ia_transitions_actor_id_fk               FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT ia_transitions_from_status_ck            CHECK (from_status IS NULL OR from_status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  CONSTRAINT ia_transitions_to_status_ck              CHECK (to_status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  CONSTRAINT ia_transitions_from_status_to_status_ck  CHECK (from_status IS DISTINCT FROM to_status),
  -- the state machine's legal edges
  CONSTRAINT ia_transitions_edge_ck                   CHECK ((from_status IS NULL AND to_status = 'PENDING')
                                                          OR (from_status = 'PENDING' AND to_status IN ('APPROVED','REJECTED','WITHDRAWN'))),
  CONSTRAINT ia_transitions_reason_ck                 CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT ia_transitions_reason_scope_ck           CHECK (reason IS NULL OR to_status IN ('APPROVED','REJECTED')),
  CONSTRAINT ia_transitions_rejected_reason_ck        CHECK (to_status <> 'REJECTED' OR (reason IS NOT NULL AND char_length(reason) >= 10)),
  -- each state reached at most once (no double approve)
  CONSTRAINT ia_transitions_application_id_to_status_uq   UNIQUE (application_id, to_status),
  -- each state LEFT at most once (no approve + reject); NULL (submission) also unique
  CONSTRAINT ia_transitions_application_id_from_status_uq UNIQUE NULLS NOT DISTINCT (application_id, from_status)
);
CREATE TRIGGER ia_transitions_append_only_trg BEFORE UPDATE OR DELETE ON users.instructor_application_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation();
CREATE TRIGGER ia_transitions_no_truncate_trg BEFORE TRUNCATE ON users.instructor_application_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation();

-- Actor rules (immediate): submit/withdraw by applicant only; approve/reject never by applicant.
CREATE FUNCTION users.ia_transitions_actor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_applicant uuid;
BEGIN
  SELECT applicant_id INTO v_applicant FROM users.instructor_applications WHERE id = NEW.application_id;
  IF NEW.to_status IN ('PENDING','WITHDRAWN') AND NEW.actor_id IS DISTINCT FROM v_applicant THEN
    RAISE EXCEPTION 'only the applicant may move an instructor application to %', NEW.to_status
      USING ERRCODE = '23514', CONSTRAINT = 'ia_transitions_actor_ck';
  ELSIF NEW.to_status IN ('APPROVED','REJECTED') AND NEW.actor_id = v_applicant THEN
    RAISE EXCEPTION 'an applicant cannot decide their own instructor application'
      USING ERRCODE = '23514', CONSTRAINT = 'ia_transitions_actor_ck';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ia_transitions_actor_trg BEFORE INSERT ON users.instructor_application_transitions
  FOR EACH ROW EXECUTE FUNCTION users.ia_transitions_actor_guard();

-- Materialised status == latest transition, checked at COMMIT (deferred) from both sides.
CREATE FUNCTION users.instructor_application_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid;
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'instructor_applications' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.application_id;
  END IF;
  SELECT status INTO v_status FROM users.instructor_applications WHERE id = v_id;
  IF NOT EXISTS (SELECT 1 FROM users.instructor_application_transitions t
                 WHERE t.application_id = v_id AND t.to_status = v_status)
     OR EXISTS (SELECT 1 FROM users.instructor_application_transitions t
                WHERE t.application_id = v_id AND t.from_status = v_status) THEN
    RAISE EXCEPTION 'instructor application % has status % which does not match its transition log', v_id, v_status
      USING ERRCODE = '23514', CONSTRAINT = 'instructor_applications_status_log_ck';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER instructor_applications_status_log_trg
  AFTER INSERT OR UPDATE OF status ON users.instructor_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users.instructor_application_status_guard();
CREATE CONSTRAINT TRIGGER ia_transitions_status_log_trg
  AFTER INSERT ON users.instructor_application_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users.instructor_application_status_guard();

COMMENT ON TABLE users.instructor_application_transitions IS
  'Append-only state log of instructor applications: who, when, why. from_status NULL = submission. Kept forever.';
COMMENT ON COLUMN users.instructor_application_transitions.reason IS 'Required (10..1000) for REJECTED; optional admin note for APPROVED; NULL otherwise.';

-- =====================================================================
-- 4. Privileges (prod role split; no-op in dev where the role doesn't exist)
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
    GRANT USAGE ON SCHEMA identity, access, users TO udemy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity, access, users TO udemy_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON identity.security_events, access.role_changes,
                                       users.instructor_application_transitions FROM udemy_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON access.roles FROM udemy_app;
    GRANT EXECUTE ON FUNCTION identity.purge_security_events(integer) TO udemy_app;
  END IF;
END
$$;
```

**Down order** (for sql-ops):

1. Drop `users.instructor_application_transitions`, `users.instructor_applications`, `users.profiles`, then the two `users.*` functions.
2. Drop `access.role_changes`, `access.user_roles`, `access.roles`.
3. Drop `identity.security_events`, `identity.purge_security_events`, `identity.security_events_guard`, `identity.one_time_tokens`, `identity.refresh_tokens`, `identity.sessions`, `identity.user_bans`, `identity.users`.
4. Drop `public.forbid_append_only_mutation`.
5. Run `DROP SCHEMA users` without CASCADE.

`DROP TABLE` is not blocked by the append-only triggers.

---

## 2. Verification of the required constraints

| Requirement                                 | Mechanism                                                                                                                                                                                                                  | Verified behaviour                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STUDENT can never be granted                | `user_roles_role_is_implicit_ck` (always false) + FK `(role_code, role_is_implicit) → roles(code, is_implicit)` + `roles_student_is_implicit_ck`                                                                           | `('STUDENT', false)` has no parent row, so the FK fails. `('STUDENT', true)` fails the CHECK. Flipping STUDENT to non-implicit is blocked by the roles CHECK. Flipping INSTRUCTOR/ADMIN to implicit while anyone holds them is blocked by `ON UPDATE RESTRICT`. **Added:** the same trick on `role_changes`, so the history can't record STUDENT either. |
| One active ban per user                     | `user_bans_user_id_active_uq` partial unique                                                                                                                                                                               | Two concurrent bans: the second gets 23505 and maps to `AlreadyBanned`. Unban is `UPDATE ... WHERE user_id=$1 AND lifted_at IS NULL RETURNING`.                                                                                                                                                                                                          |
| Exactly one unconsumed token per session    | `refresh_tokens_session_id_current_uq`                                                                                                                                                                                     | The DB enforces **at most one**. "At least one" comes from the rotation algorithm: consuming the old token and inserting its child happen in one transaction. I did not add a deferred trigger for "at least one", since a revoked session legitimately keeps a dead current token. Flagged.                                                             |
| At most one child per token                 | `refresh_tokens_parent_id_uq`                                                                                                                                                                                              | Two concurrent rotations of the same token: the loser gets 23505 even without `FOR UPDATE`.                                                                                                                                                                                                                                                              |
| One live one-time token per (user, purpose) | `one_time_tokens_user_id_purpose_live_uq`                                                                                                                                                                                  | An expired but unconsumed token still counts as live, so the invalidate step must not filter on `expires_at` (see §6).                                                                                                                                                                                                                                   |
| Unique `source_event_id`                    | `one_time_tokens_source_event_id_uq`                                                                                                                                                                                       | Works as the `ON CONFLICT (source_event_id) DO NOTHING` target. A conflict on the live-token index is **not** swallowed, which is correct.                                                                                                                                                                                                               |
| One PENDING application per applicant       | `instructor_applications_applicant_id_pending_uq`                                                                                                                                                                          | Concurrent submits: 23505 maps to `ApplicationAlreadyPending`.                                                                                                                                                                                                                                                                                           |
| Unique `(application_id, to_status)`        | `ia_transitions_application_id_to_status_uq`                                                                                                                                                                               | Present. **On its own it is not enough**: APPROVED and REJECTED are different `to_status` values, so both could be inserted. I added `UNIQUE NULLS NOT DISTINCT (application_id, from_status)` plus `ia_transitions_edge_ck`, so the log is a linear chain with at most one exit from PENDING.                                                           |
| REJECTED requires a reason                  | `ia_transitions_rejected_reason_ck` (NOT NULL and ≥10 chars; ≤1000 from `ia_transitions_reason_ck`)                                                                                                                        | OK                                                                                                                                                                                                                                                                                                                                                       |
| Paired-null rules                           | `sessions_revoked_at_revoke_reason_ck`, `user_bans_lifted_at_lifted_by_ck`, `user_bans_lift_reason_lifted_at_ck`, `one_time_tokens_consumed_at_invalidated_at_ck`, `role_changes_source_id_ck`, `role_changes_actor_id_ck` | All use the `(a IS NULL) = (b IS NULL)` / `IS NOT DISTINCT FROM` form, so a NULL can never slip through a CHECK as "unknown".                                                                                                                                                                                                                            |

**ON DELETE policy** (stated once, applied everywhere):

- **All FKs to `identity.users`, `access.roles` and `users.instructor_applications` are RESTRICT.** Accounts, roles and applications are never hard-deleted in Phase 1 (GDPR erasure is out of scope and would be done by anonymisation). RESTRICT makes an accidental `DELETE` fail loudly instead of silently cascading away audit history. Even if credentials-only tables used CASCADE, the RESTRICT history tables would block the delete anyway.
- **`refresh_tokens.session_id` is CASCADE.** Tokens have no meaning without their family, and session cleanup has to remove them.
- **`refresh_tokens.parent_id` is `SET NULL (parent_id)`.** CASCADE would delete the whole descendant chain, including the live current token, whenever cleanup removes an old consumed ancestor. That would be a serious bug. NO ACTION would make batched cleanup of old consumed tokens fail.

---

## 3. Seed data

The `INSERT INTO access.roles` statement inside the DDL holds the three rows: STUDENT (implicit), INSTRUCTOR and ADMIN (both explicit). The seed belongs in the migration itself, not in a separate seed script, because CHECKs and FKs depend on it.

---

## 4. Privileges: recommendation

**Use both layers.**

1. **Triggers (in the migration, effective now in dev and prod).**
   - `public.forbid_append_only_mutation()` is attached BEFORE UPDATE OR DELETE (row level) and BEFORE TRUNCATE (statement level) on `access.role_changes` and `users.instructor_application_transitions`.
   - `identity.security_events` gets its own guard: UPDATE is always rejected; DELETE is allowed only for rows with `occurred_at < now() - 180 days`.
   - Triggers fire for superusers, so this is the **only** guard that works with the single dev superuser `udemy`. REVOKE does nothing for a superuser.
2. **Role split (prod).**
   - `udemy_owner`: NOLOGIN, owns the schemas and objects. Migrations run as a migrator login that does `SET ROLE udemy_owner`.
   - `udemy_app`: LOGIN, NOSUPERUSER, not the owner. It gets DML except UPDATE/DELETE/TRUNCATE on the three append-only tables, SELECT-only on `access.roles`, and EXECUTE on `identity.purge_security_events`.
   - `udemy_debezium`: REPLICATION plus SELECT on `outbox.events`.
   - The conditional `DO $$ IF EXISTS (udemy_app) ...` block in the migration is a no-op in dev and correct in prod.
   - `ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner ...` and creating the roles themselves belong in an infra SQL script (devops-config), not in a migration, because roles are cluster-level objects and carry passwords.
3. **Retention without a DELETE grant.** The worker calls `SELECT identity.purge_security_events(5000)`. The function is SECURITY DEFINER (runs as owner) with a pinned `search_path`. The trigger still refuses rows younger than 180 days, even for the owner.
4. **Constraints on the setup:**
   - The app role must never own the tables. An owner can `ALTER TABLE ... DISABLE TRIGGER` and re-grant itself privileges.
   - Testcontainers tests cannot `TRUNCATE` the three append-only tables. Use a fresh database or a template DB per suite, or run cleanup as a superuser with `SET session_replication_role = replica`.

---

## 5. Normalization (3NF) check

**Checked and in 3NF.** Every non-key attribute depends on the whole key and on nothing else:

- `identity.users`: no stored `status`; it is derived from bans.
- `identity.user_bans`, `identity.sessions`, `identity.refresh_tokens`: `refresh_tokens` has no `user_id`; it is reached through the session.
- `identity.one_time_tokens`, `identity.security_events`.
- `access.roles`, `access.role_changes`.
- `users.profiles`, `users.instructor_application_transitions`.

**Policy snapshots, not transitive dependencies:**

- `refresh_tokens.expires_at` and `one_time_tokens.expires_at` are computed from config and stored on purpose. They freeze the TTL that was in force at issue time, and later config changes must not alter them.
- `one_time_tokens.email` is the address the token was issued to. It is a historical fact, not a copy of `users.email`.

**Documented exception: `users.instructor_applications.status`.**

- It is materialised from the latest transition. It is needed by the partial unique index (one PENDING per applicant) and by the queue keyset index.
- It is written in the same transaction as the transition row.
- It is now **DB-verified**: deferred constraint triggers on both tables check at COMMIT that `status` equals the `to_status` of the only transition with no successor.
- `submitted_at` is part of the same exception. It equals the submission transition's `occurred_at`, and both default to the same transaction-stable `now()`.
- Who, when (for decisions) and why exist only in the transitions table.

**Same pattern, made minimal: `access.user_roles`.**

- It is the current-state projection of `role_changes` (the standard state table plus history log).
- I **removed `granted_by` and `grant_reason`** from §6's version, because they duplicated the GRANTED `role_changes` row and could drift.
- It now holds only the key, the FK helper column and `granted_at`, which records when the row itself was created.

---

## 6. Deviations from §6 and issues found

**Schema changes:**

1. **`ia_transitions_application_id_from_status_uq` (NULLS NOT DISTINCT) and `ia_transitions_edge_ck` added.** `(application_id, to_status)` alone allowed both APPROVED and REJECTED. The edge CHECK also replaces "PENDING → PENDING is impossible" with a full whitelist of legal edges. I also added `ia_transitions_reason_scope_ck` (reason only on APPROVED or REJECTED).
2. **Actor rules enforced in the DB** with the immediate trigger `ia_transitions_actor_trg`: only the applicant can submit or withdraw, and the applicant can never approve or reject their own application. Errors carry `CONSTRAINT = 'ia_transitions_actor_ck'` so they can be mapped.
3. **Deferred status ↔ log consistency triggers.** These turn the documented exception from app-guarded into DB-guarded.
4. **Dropped `ia_transitions (application_id, occurred_at)`.** Both unique constraints lead with `application_id`, and an application has at most two transitions.
5. **Refresh tokens:**
   - The parent FK is now composite `(session_id, parent_id) → (session_id, id)`, so a child must be in its parent's family.
   - It uses `ON DELETE SET NULL (parent_id)` (PG15+ column list). CASCADE would have been destructive.
   - `UNIQUE (session_id, id)` is the FK target and replaces §6's `(session_id, issued_at)` index. uuidv7 ids are time-ordered, so the number of indexes stays the same.
   - The current-token partial unique index gets `INCLUDE (expires_at)`.
   - Added `refresh_tokens_expires_at_idx` for cleanup.
6. **Sessions:**
   - Added `sessions_revoked_at_idx` (partial) for cleanup.
   - `created_ip` and `last_ip` are NOT NULL.
   - Added `fillfactor = 90` so the per-refresh updates of `last_used_at`/`last_ip` can be HOT updates.
   - The active index stays `(user_id) WHERE revoked_at IS NULL`, with no `last_used_at` column, so those updates remain HOT. Each user has only a few sessions, so sorting them in memory is cheap.
7. **One-time tokens:**
   - Added `(user_id, purpose, requested_at DESC)`. The "newer request exists?" check in `IssueOneTimeToken` had no index, and this one also covers the FK.
   - Added `(expires_at)` for cleanup.
8. **Security events:**
   - Added type `REFRESH_REJECTED`. §5 says the exact refresh-failure cause is written to `security_events`, but none of the listed types fit.
   - Added the `metadata` object/size CHECK.
   - The `user_id` index is partial (`WHERE user_id IS NOT NULL`).
9. **`access.role_changes`:**
   - Composite FK trick added.
   - Source/actor pairing CHECKs: `cli_bootstrap` ⇔ `actor_id IS NULL`, `instructor_application` ⇔ `source_id` present, grants require a `source_type`, revokes can only have source `admin` or none.
10. **`access.user_roles`:** dropped `granted_by` and `grant_reason` (see §5).
11. **`access.roles`:** added `roles_student_is_implicit_ck` and a format CHECK on `code`.
12. **`identity.users`:**
    - Added `password_hash LIKE '$argon2id$%'` and the display-name trim/control-character CHECKs.
    - **Deliberately not added:** lowercase or NFKC CHECKs on `email`. PostgreSQL's `lower()` depends on the database collation and can disagree with JS `toLowerCase()` on exotic characters, which would cause spurious CHECK failures. The domain owns normalisation, and citext owns uniqueness.
13. **Unindexed FK columns, by choice:** `user_bans.banned_by/lifted_by`, `role_changes.actor_id`, `ia_transitions.actor_id`, `user_roles` → `roles`. They are only needed when a referenced row is deleted, which never happens (RESTRICT, no user deletion). Add them if hard-delete or erasure is ever introduced.

**Bug in the §5 `IssueOneTimeToken` flow (for nestjs-coder).**

- The flow is "invalidate the live token, then `INSERT ... ON CONFLICT (source_event_id) DO NOTHING`". On a **redelivery** of an event whose token was already committed, the invalidate step kills that very token. The insert is then a no-op, and the re-sent email carries a dead link.
- **Fix:** `UPDATE ... SET invalidated_at = now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND invalidated_at IS NULL AND source_event_id <> $eventId`. Leave out any `expires_at` filter, because expired-but-unconsumed tokens still occupy the live slot.
- Also set `expires_at = requested_at + TTL`, and skip issuing if that is already in the past. Very old redeliveries, including ones arriving after cleanup removed the original row, then become harmless.

**Races the app must close (constraints can't).**

- **Ban vs grant-ADMIN** ("cannot ban an ADMIN holder"): use `SELECT ... FROM identity.users WHERE id=$1 FOR NO KEY UPDATE` as a per-user mutex in ban, unban, grantRole, revokeRole, password change/reset and IssueOneTimeToken. It does not conflict with the `FOR KEY SHARE` locks that FK checks take, so inserts into sessions and security_events never block on it.
- **Lock order:** always the token row, then the session row (as in the refresh algorithm). Logout and revoke-all lock only sessions, so no deadlock cycle exists.
- **Timestamps:** set all state timestamps (`revoked_at`, `consumed_at`, `lifted_at`, ...) with SQL `now()`, not JS `new Date()`. That keeps a single clock (the time-ordering CHECKs depend on it) and gives everything in one transaction an identical timestamp.

**Query notes (§5/§8).**

- **Admin search:** `[display_name ILIKE $q OR email::text ILIKE $q] AND [NOT] EXISTS(active ban) AND id = ANY($idIn) AND (created_at, id) < ($c, $id) ORDER BY created_at DESC, id DESC LIMIT n`.
  - Escape `%`, `_` and `\` in q.
  - Trigram indexes only help when q is at least 3 characters; enforce `q.length >= 3`, or use an exact-email equality path.
  - `idIn` from the role filter can grow large for INSTRUCTOR. That is acceptable at this scale; the trade-off is the module boundary. Flagged.
- **Sessions list / activeSessionCount:** `sessions s JOIN refresh_tokens rt ON rt.session_id = s.id AND rt.consumed_at IS NULL WHERE s.user_id=$1 AND s.revoked_at IS NULL AND s.absolute_expires_at > now() AND rt.expires_at > now()`. The join is answered index-only from `refresh_tokens_session_id_current_uq`.
- **Refresh lookup:** `WHERE token_hash = $1 FOR UPDATE` uses `refresh_tokens_token_hash_uq`. The grace-path check for the child uses `refresh_tokens_parent_id_uq`.

**Constraint names → domain errors.** For unique indexes, `err.constraint` is the index name.

| Constraint / error                                                  | Domain mapping                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `users_email_uq`                                                    | existing-email signup path (still 202)                      |
| `user_bans_user_id_active_uq`                                       | `AlreadyBanned`                                             |
| `instructor_applications_applicant_id_pending_uq`                   | `ApplicationAlreadyPending`                                 |
| `ia_transitions_*_uq`                                               | `InvalidStateTransition`                                    |
| `ia_transitions_actor_ck`                                           | `SelfDecisionForbidden`                                     |
| `refresh_tokens_parent_id_uq` / `_session_id_current_uq`            | concurrent rotation: retry, which then takes the grace path |
| `user_roles_role_code_role_is_implicit_fk` / `_role_is_implicit_ck` | `RoleNotAssignable`                                         |
| `user_roles_user_id_fk`                                             | `UserNotFound`                                              |
| 42501 from the guard triggers                                       | 500 (programming error)                                     |
| `instructor_applications_status_log_ck` at COMMIT                   | 500 (programming error)                                     |

---

## 7. Kysely type expectations

**Table keys** (`--camel-case`, interface name in parentheses):

| Table                                      | Kysely key                                 |
| ------------------------------------------ | ------------------------------------------ |
| `identity.users`                           | `"identity.users"` (`IdentityUsers`)       |
| `identity.user_bans`                       | `"identity.userBans"`                      |
| `identity.sessions`                        | `"identity.sessions"`                      |
| `identity.refresh_tokens`                  | `"identity.refreshTokens"`                 |
| `identity.one_time_tokens`                 | `"identity.oneTimeTokens"`                 |
| `identity.security_events`                 | `"identity.securityEvents"`                |
| `access.roles`                             | `"access.roles"`                           |
| `access.user_roles`                        | `"access.userRoles"`                       |
| `access.role_changes`                      | `"access.roleChanges"`                     |
| `users.profiles`                           | `"users.profiles"`                         |
| `users.instructor_applications`            | `"users.instructorApplications"`           |
| `users.instructor_application_transitions` | `"users.instructorApplicationTransitions"` |

**Types:**

| PG type               | Generated TS                                                                                                                                                                                | Runtime value (with `database.ts` parsers)                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `timestamptz`         | `Timestamp` = `ColumnType<Date, Date \| string, Date \| string>`; `Generated<Timestamp>` where there is a default                                                                           | `Date` (custom parser)                                                                                          |
| `bytea`               | `Buffer`                                                                                                                                                                                    | `Buffer` (pg default parser). Pass a `Buffer` for inserts and `where('tokenHash', '=', buf)`.                   |
| `inet`                | `string`                                                                                                                                                                                    | `string`, e.g. `"203.0.113.7"` or `"::1"`. Validate X-Client-IP before inserting; malformed input raises 22P02. |
| `citext`              | **Verify after codegen.** The expected value is `string`, but citext is an extension type with a dynamic OID. If codegen emits `unknown`, add a type override in the kysely-codegen config. | `string` (pg has no parser for it, so the raw text comes through)                                               |
| `uuid`                | `string` (`Generated<string>` for `id`)                                                                                                                                                     | `string`                                                                                                        |
| `jsonb`               | `Json`                                                                                                                                                                                      | Object. **Keys are camel-cased on read**, so write camelCase keys into `security_events.metadata`.              |
| `integer` (`version`) | `number` (`Generated<number>`)                                                                                                                                                              | `number`                                                                                                        |
| `boolean`             | `boolean` (`Generated<boolean>` for `role_is_implicit`)                                                                                                                                     | `boolean`                                                                                                       |

**Other notes for nestjs-coder:**

- `ON CONFLICT` against a partial unique index needs the predicate, e.g. `.onConflict(oc => oc.column('userId').where('liftedAt', 'is', null)...)`. In practice, only `sourceEventId` and `(userId, roleCode)` are used as conflict targets.
- `make_interval(days => ${n}::int)` needs the `::int` cast when bound through `sql`.
- Errors from the deferred triggers are raised when `db.transaction().execute()` commits.

---

## 8. Cleanup queries (worker job)

**Running them:**

- Run each statement repeatedly until it affects fewer rows than the batch size. Give each batch its own transaction.
- `FOR UPDATE SKIP LOCKED` means concurrent workers and live refreshes are never blocked. The advisory lock from T9 is only there to avoid duplicated work; use `pg_try_advisory_xact_lock` per batch, because a session-level lock does not work reliably across pool connections.

**Parameters:**

- `$1` is the grace period in days (suggested: 7).
- `$2` is the batch size (suggested: 5000 for tokens, 500 for sessions, since a session delete cascades to its tokens).

```sql
-- A. Consumed refresh tokens past expiry + grace (current tokens are removed with their session)
WITH doomed AS (
  SELECT id FROM identity.refresh_tokens
  WHERE consumed_at IS NOT NULL
    AND expires_at < now() - make_interval(days => $1::int)
  ORDER BY expires_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM identity.refresh_tokens rt USING doomed WHERE rt.id = doomed.id;

-- B1. Absolute-expired sessions (cascade deletes their tokens)
WITH doomed AS (
  SELECT id FROM identity.sessions
  WHERE absolute_expires_at < now() - make_interval(days => $1::int)
  ORDER BY absolute_expires_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM identity.sessions s USING doomed WHERE s.id = doomed.id;

-- B2. Revoked sessions past grace
WITH doomed AS (
  SELECT id FROM identity.sessions
  WHERE revoked_at IS NOT NULL
    AND revoked_at < now() - make_interval(days => $1::int)
  ORDER BY revoked_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM identity.sessions s USING doomed WHERE s.id = doomed.id;

-- B3. Idle-expired sessions (current token expired); locks token then session = refresh lock order
WITH doomed AS (
  SELECT rt.session_id AS id FROM identity.refresh_tokens rt
  WHERE rt.consumed_at IS NULL
    AND rt.expires_at < now() - make_interval(days => $1::int)
  ORDER BY rt.expires_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM identity.sessions s USING doomed WHERE s.id = doomed.id;

-- C. One-time tokens: everything expired more than N days ago.
--    Every consumed/invalidated token has expires_at <= requested_at + 24h, so this removes them all
--    with one index; live unexpired tokens are never touched.
WITH doomed AS (
  SELECT id FROM identity.one_time_tokens
  WHERE expires_at < now() - make_interval(days => $1::int)
  ORDER BY expires_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM identity.one_time_tokens t USING doomed WHERE t.id = doomed.id;

-- D. security_events > 180 days (only path allowed by the trigger / prod grants)
SELECT identity.purge_security_events($2);   -- returns rows deleted
```

**Retention, by table:**

- `user_bans`, `role_changes` and `instructor_application_transitions` are kept forever as business audit.
- **Trade-off (correctness for storage):** deleting a consumed refresh token means a replay of it more than 7 days after its expiry is no longer detected as reuse. It is still rejected, as an unknown token.
- **Upgrade path:** if security_events volume grows, partition it monthly by `occurred_at` and drop old partitions. Retention then becomes O(1) and needs no DELETE at all.

---

## Hand-off to sql-ops (T4)

1. Create `packages/db/src/migrations/2026_10_10_0002_identity_access_users.ts` (`Kysely<any>`, one `sql\`\`` per statement, in the order of §1 above), including:
   - `CREATE SCHEMA users`
   - `public.forbid_append_only_mutation()`
   - the 12 tables with their constraints, indexes and comments
   - the `set_updated_at` triggers on `identity.users`, `users.profiles` and `users.instructor_applications`
   - the append-only, truncate, actor and deferred status triggers, plus their functions
   - `identity.purge_security_events` and its REVOKE
   - the `access.roles` seed
   - the conditional `udemy_app` grant block
2. Write `down()` in the order given at the end of §1.
3. Register the migration in `packages/db/src/migrations/index.ts`. Run it against PG 18, then run `pnpm --filter @udemy/db codegen` and check the citext mapping (§7).
4. Integration tests, at minimum:
   - granting STUDENT fails
   - a second active ban fails
   - approve + reject on the same application fails (`from_status` uniqueness)
   - a status/transition mismatch fails at COMMIT
   - UPDATE/DELETE/TRUNCATE on the append-only tables fails, and deleting a security_event younger than 180 days fails
   - a concurrent double rotation of one refresh token fails
5. Hand the §8 cleanup SQL to nestjs-coder (T9).
6. Flag to devops-config (T3/T18): the prod roles `udemy_owner`, `udemy_app` and `udemy_debezium`, with `ALTER DEFAULT PRIVILEGES`, as an infra SQL script. Dev keeps the single superuser `udemy`, where the triggers are the effective guard.

No files were written.
