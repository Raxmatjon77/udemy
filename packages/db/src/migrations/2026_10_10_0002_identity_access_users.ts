import { type Kysely, type RawBuilder, sql } from 'kysely';

/**
 * Phase 1: identity / access / users schemas.
 *
 * Source of truth: docs/phase-1-schema-design.md §1 (DDL), §3 (seed), §4 (privileges).
 * One `sql` per statement, in the order of §1. Raw SQL throughout because most of it
 * (partial/INCLUDE/NULLS NOT DISTINCT indexes, `ON DELETE SET NULL (col)`, triggers,
 * PL/pgSQL, SECURITY DEFINER) can't be expressed with Kysely's schema builder.
 *
 * Append-only tables (access.role_changes, users.instructor_application_transitions,
 * identity.security_events) are guarded by triggers, which also bind superusers.
 * DROP TABLE is not blocked by them, so down() works.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(db: Kysely<any>, statements: RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) {
    await statement.execute(db);
  }
}

// ---------------------------------------------------------------------------
// 0. Schema + shared helper
// ---------------------------------------------------------------------------
const shared = [
  sql`CREATE SCHEMA users`,
  sql`
    CREATE FUNCTION public.forbid_append_only_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% on %.% is forbidden: table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '42501';
    END
    $$
  `,
  sql`
    COMMENT ON FUNCTION public.forbid_append_only_mutation() IS
      'Trigger function: rejects UPDATE/DELETE/TRUNCATE on append-only history tables. Works even for superusers (unlike REVOKE).'
  `,
];

// ---------------------------------------------------------------------------
// 1. identity
// ---------------------------------------------------------------------------
const identityUsers = [
  sql`
    CREATE TABLE identity.users (
      id                  uuid        NOT NULL DEFAULT uuidv7(),
      email               citext      NOT NULL,
      display_name        text        NOT NULL,
      password_hash       text        NOT NULL,
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
    )
  `,
  // Admin keyset: ORDER BY created_at DESC, id DESC
  sql`CREATE INDEX users_created_at_id_idx ON identity.users (created_at DESC, id DESC)`,
  // Admin q-search: display_name ILIKE '%q%'
  sql`CREATE INDEX users_display_name_trgm_idx ON identity.users USING gin (display_name gin_trgm_ops)`,
  // Admin q-search: email::text ILIKE '%q%' (query MUST use the exact expression email::text)
  sql`CREATE INDEX users_email_trgm_idx ON identity.users USING gin ((email::text) gin_trgm_ops)`,
  sql`
    CREATE TRIGGER users_set_updated_at_trg BEFORE UPDATE ON identity.users
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    COMMENT ON TABLE identity.users IS
      'Account aggregate (shared-kernel identity). The only cross-schema FK target (D12). No status column: ACTIVE/BANNED is derived from identity.user_bans. Rows are never hard-deleted in Phase 1; all FKs to it are RESTRICT.'
  `,
  sql`COMMENT ON COLUMN identity.users.email IS 'citext for case-insensitive uniqueness; the app stores the normalised (lowercase NFKC) form.'`,
  sql`COMMENT ON COLUMN identity.users.display_name IS 'Lives here (D8) so signup is atomic without an identity->users dependency. Rich profile is users.profiles.'`,
  sql`COMMENT ON COLUMN identity.users.password_hash IS 'Argon2id PHC-encoded string ($argon2id$v=19$m=...). CHECK pins the algorithm; changing algorithms requires a migration.'`,
  sql`COMMENT ON COLUMN identity.users.email_verified_at IS 'NULL = unverified. Set only by a one-time token issued for the current email (or by reset / CLI provisioning).'`,
];

const identityUserBans = [
  sql`
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
    )
  `,
  // One active ban per user; also serves the login/refresh ban check
  sql`CREATE UNIQUE INDEX user_bans_user_id_active_uq ON identity.user_bans (user_id) WHERE lifted_at IS NULL`,
  // listBans(userId) ORDER BY banned_at DESC; also the FK index for user_id
  sql`CREATE INDEX user_bans_user_id_banned_at_idx ON identity.user_bans (user_id, banned_at DESC)`,
  sql`
    COMMENT ON TABLE identity.user_bans IS
      'Ban history + current ban (row with lifted_at IS NULL). Authentication-blocking state, so owned by identity (D9). Kept forever.'
  `,
  sql`COMMENT ON COLUMN identity.user_bans.lifted_at IS 'NULL = ban is active. Set once by UPDATE ... WHERE user_id=$1 AND lifted_at IS NULL.'`,
];

const identitySessions = [
  sql`
    CREATE TABLE identity.sessions (
      id                  uuid        NOT NULL DEFAULT uuidv7(),
      user_id             uuid        NOT NULL,
      client_app          text        NOT NULL,
      user_agent          text        NULL,
      created_ip          inet        NOT NULL,
      last_ip             inet        NOT NULL,
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
    ) WITH (fillfactor = 90)
  `,
  // Sessions list, activeSessionCount, revoke-all
  sql`CREATE INDEX sessions_user_id_active_idx ON identity.sessions (user_id) WHERE revoked_at IS NULL`,
  // Cleanup: absolute-expired sessions
  sql`CREATE INDEX sessions_absolute_expires_at_idx ON identity.sessions (absolute_expires_at)`,
  // Cleanup: revoked sessions past the forensic grace period
  sql`CREATE INDEX sessions_revoked_at_idx ON identity.sessions (revoked_at) WHERE revoked_at IS NOT NULL`,
  sql`
    COMMENT ON TABLE identity.sessions IS
      'Refresh-token family. ACTIVE/REVOKED stored; EXPIRED derived (absolute_expires_at, or current refresh token expires_at). A revoked session is never reactivated.'
  `,
  sql`COMMENT ON COLUMN identity.sessions.client_app IS 'App the session was issued to; refresh must come from the same BFF client.'`,
  sql`COMMENT ON COLUMN identity.sessions.user_agent IS 'Raw UA truncated to 512 chars by the app; device is parsed at read time.'`,
  sql`COMMENT ON COLUMN identity.sessions.last_ip IS 'IP of the most recent login/refresh (from trusted X-Client-IP).'`,
];

const identityRefreshTokens = [
  sql`
    CREATE TABLE identity.refresh_tokens (
      id          uuid        NOT NULL DEFAULT uuidv7(),
      session_id  uuid        NOT NULL,
      token_hash  bytea       NOT NULL,
      parent_id   uuid        NULL,
      issued_at   timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      CONSTRAINT refresh_tokens_pk               PRIMARY KEY (id),
      CONSTRAINT refresh_tokens_session_id_id_uq UNIQUE (session_id, id),
      CONSTRAINT refresh_tokens_session_id_fk    FOREIGN KEY (session_id) REFERENCES identity.sessions (id) ON DELETE CASCADE,
      CONSTRAINT refresh_tokens_parent_id_fk     FOREIGN KEY (session_id, parent_id)
                                                 REFERENCES identity.refresh_tokens (session_id, id)
                                                 ON DELETE SET NULL (parent_id),
      CONSTRAINT refresh_tokens_token_hash_uq    UNIQUE (token_hash),
      CONSTRAINT refresh_tokens_parent_id_uq     UNIQUE (parent_id),
      CONSTRAINT refresh_tokens_token_hash_ck    CHECK (octet_length(token_hash) = 32),
      CONSTRAINT refresh_tokens_expires_at_ck    CHECK (expires_at > issued_at),
      CONSTRAINT refresh_tokens_parent_id_ck     CHECK (parent_id IS NULL OR parent_id <> id)
    )
  `,
  // At most one current (unconsumed) token per session; INCLUDE for index-only expiry reads
  sql`
    CREATE UNIQUE INDEX refresh_tokens_session_id_current_uq
      ON identity.refresh_tokens (session_id) INCLUDE (expires_at) WHERE consumed_at IS NULL
  `,
  // Cleanup: consumed tokens past expiry; idle-expired sessions
  sql`CREATE INDEX refresh_tokens_expires_at_idx ON identity.refresh_tokens (expires_at)`,
  sql`
    COMMENT ON TABLE identity.refresh_tokens IS
      'Rotating opaque refresh tokens. One unconsumed (current) token per session; consumed tokens are kept until expires_at + grace for reuse detection.'
  `,
  sql`COMMENT ON COLUMN identity.refresh_tokens.token_hash IS 'HMAC-SHA256(REFRESH_TOKEN_PEPPER, raw token), 32 bytes. The raw token is never stored.'`,
  sql`COMMENT ON COLUMN identity.refresh_tokens.parent_id IS 'Token this one rotated from. NULL for the first token of a session, or after the parent was purged by cleanup.'`,
  sql`COMMENT ON COLUMN identity.refresh_tokens.consumed_at IS 'Set when rotated. Presenting a consumed token outside the 10 s grace window = reuse -> revoke the family.'`,
];

const identityOneTimeTokens = [
  sql`
    CREATE TABLE identity.one_time_tokens (
      id              uuid        NOT NULL DEFAULT uuidv7(),
      user_id         uuid        NOT NULL,
      purpose         text        NOT NULL,
      token_hash      bytea       NOT NULL,
      email           citext      NOT NULL,
      source_event_id uuid        NOT NULL,
      requested_at    timestamptz NOT NULL,
      expires_at      timestamptz NOT NULL,
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
    )
  `,
  // One live (unconsumed, uninvalidated) token per (user, purpose); expired-but-unconsumed still counts
  sql`
    CREATE UNIQUE INDEX one_time_tokens_user_id_purpose_live_uq
      ON identity.one_time_tokens (user_id, purpose) WHERE consumed_at IS NULL AND invalidated_at IS NULL
  `,
  // Out-of-order check + invalidate-others; FK index for user_id
  sql`
    CREATE INDEX one_time_tokens_user_id_purpose_requested_at_idx
      ON identity.one_time_tokens (user_id, purpose, requested_at DESC)
  `,
  // Cleanup
  sql`CREATE INDEX one_time_tokens_expires_at_idx ON identity.one_time_tokens (expires_at)`,
  sql`
    COMMENT ON TABLE identity.one_time_tokens IS
      'Email-verification and password-reset tokens, issued deterministically by the worker (D10). Only the hash is stored.'
  `,
  sql`COMMENT ON COLUMN identity.one_time_tokens.email IS 'Address the token was sent to. Verification succeeds only if it still equals identity.users.email.'`,
  sql`COMMENT ON COLUMN identity.one_time_tokens.source_event_id IS 'outbox event id that caused issuance; worker idempotency (INSERT ... ON CONFLICT (source_event_id) DO NOTHING).'`,
  sql`COMMENT ON COLUMN identity.one_time_tokens.requested_at IS 'Event timestamp; used to drop out-of-order redeliveries.'`,
  sql`COMMENT ON COLUMN identity.one_time_tokens.invalidated_at IS 'Superseded by a newer token or by a password change. Mutually exclusive with consumed_at.'`,
];

const identitySecurityEvents = [
  sql`
    CREATE TABLE identity.security_events (
      id          uuid        NOT NULL DEFAULT uuidv7(),
      user_id     uuid        NULL,
      session_id  uuid        NULL,
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
    )
  `,
  // Per-user security timeline; anonymous failures excluded
  sql`
    CREATE INDEX security_events_user_id_occurred_at_idx
      ON identity.security_events (user_id, occurred_at DESC) WHERE user_id IS NOT NULL
  `,
  // Retention purge + time-range scans; insert order = time order -> BRIN
  sql`CREATE INDEX security_events_occurred_at_brin_idx ON identity.security_events USING brin (occurred_at)`,
  // Append-only, except DELETE of rows past the 180-day retention.
  sql`
    CREATE FUNCTION identity.security_events_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.occurred_at < now() - interval '180 days' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'identity.security_events is append-only (% refused; only rows older than 180 days may be deleted)', TG_OP
        USING ERRCODE = '42501';
    END
    $$
  `,
  sql`
    CREATE TRIGGER security_events_append_only_trg BEFORE UPDATE OR DELETE ON identity.security_events
      FOR EACH ROW EXECUTE FUNCTION identity.security_events_guard()
  `,
  sql`
    CREATE TRIGGER security_events_no_truncate_trg BEFORE TRUNCATE ON identity.security_events
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // Retention purge entry point (the only way the app role can delete; SECURITY DEFINER runs as owner).
  sql`
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
    $$
  `,
  sql`REVOKE ALL ON FUNCTION identity.purge_security_events(integer) FROM PUBLIC`,
  sql`
    COMMENT ON TABLE identity.security_events IS
      'Append-only authentication telemetry (never on Kafka). Retention 180 days via identity.purge_security_events(); UPDATE/TRUNCATE always rejected, DELETE only for rows past retention.'
  `,
  sql`COMMENT ON COLUMN identity.security_events.session_id IS 'Soft reference to identity.sessions(id); no FK so history survives session cleanup.'`,
  sql`COMMENT ON COLUMN identity.security_events.email_hash IS 'HMAC-SHA256(LOGIN_EMAIL_HMAC_KEY, attempted email) for unknown-account failures. Never the raw email.'`,
  sql`COMMENT ON COLUMN identity.security_events.metadata IS 'Small JSON object (<= 4 KiB), e.g. {"cause":"wrong_app"}. Use camelCase keys: CamelCasePlugin camel-cases jsonb keys on read.'`,
  sql`COMMENT ON FUNCTION identity.purge_security_events(integer) IS 'Deletes up to p_batch_size rows older than 180 days; returns the count. Call repeatedly until < batch size.'`,
];

// ---------------------------------------------------------------------------
// 2. access
// ---------------------------------------------------------------------------
const accessRoles = [
  sql`
    CREATE TABLE access.roles (
      code        text    NOT NULL,
      is_implicit boolean NOT NULL,
      description text    NOT NULL,
      CONSTRAINT roles_pk                     PRIMARY KEY (code),
      CONSTRAINT roles_code_is_implicit_uq    UNIQUE (code, is_implicit),
      CONSTRAINT roles_code_ck                CHECK (code ~ '^[A-Z][A-Z_]{1,31}$'),
      CONSTRAINT roles_student_is_implicit_ck CHECK (code <> 'STUDENT' OR is_implicit),
      CONSTRAINT roles_description_ck         CHECK (char_length(description) BETWEEN 1 AND 500)
    )
  `,
  // Seed: CHECKs and FKs depend on these rows, so they belong to the migration.
  sql`
    INSERT INTO access.roles (code, is_implicit, description) VALUES
      ('STUDENT',    true,  'Held implicitly by every active account; never stored in access.user_roles.'),
      ('INSTRUCTOR', false, 'Granted when an instructor application is approved. Required to sign in to the instructor app.'),
      ('ADMIN',      false, 'Granted by the admin:bootstrap CLI or by an admin. Required to sign in to the admin app.')
  `,
  sql`
    COMMENT ON TABLE access.roles IS
      'Role reference data, seeded by migration. Permissions are code-defined (D4); no permissions table. is_implicit=true roles cannot be assigned (composite FK + CHECK on user_roles/role_changes).'
  `,
  sql`COMMENT ON COLUMN access.roles.is_implicit IS 'true = held by construction (STUDENT). Pinned true for STUDENT by roles_student_is_implicit_ck.'`,
];

const accessUserRoles = [
  sql`
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
    )
  `,
  // listUserIdsWithRole(role) -> admin role filter
  sql`CREATE INDEX user_roles_role_code_user_id_idx ON access.user_roles (role_code, user_id)`,
  sql`
    COMMENT ON TABLE access.user_roles IS
      'Current explicit role holdings (INSTRUCTOR/ADMIN only). State table; who/why lives in access.role_changes. Grant = INSERT ... ON CONFLICT DO NOTHING RETURNING; revoke = DELETE ... RETURNING; history row only if a row was returned.'
  `,
  sql`COMMENT ON COLUMN access.user_roles.role_is_implicit IS 'Always false. Exists only to make the composite FK to roles(code,is_implicit) reject implicit roles (STUDENT).'`,
];

const accessRoleChanges = [
  sql`
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
    )
  `,
  // Role history per user (admin user detail)
  sql`CREATE INDEX role_changes_user_id_occurred_at_idx ON access.role_changes (user_id, occurred_at DESC)`,
  sql`
    CREATE TRIGGER role_changes_append_only_trg BEFORE UPDATE OR DELETE ON access.role_changes
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER role_changes_no_truncate_trg BEFORE TRUNCATE ON access.role_changes
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    COMMENT ON TABLE access.role_changes IS
      'Append-only role grant/revoke history. Written only when the state table actually changed. Kept forever.'
  `,
  sql`COMMENT ON COLUMN access.role_changes.actor_id IS 'NULL only for source_type = cli_bootstrap (first admin).'`,
  sql`COMMENT ON COLUMN access.role_changes.source_id IS 'Set iff source_type = instructor_application (the application id). Soft reference.'`,
];

// ---------------------------------------------------------------------------
// 3. users
// ---------------------------------------------------------------------------
const usersProfiles = [
  sql`
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
    )
  `,
  sql`
    CREATE TRIGGER profiles_set_updated_at_trg BEFORE UPDATE ON users.profiles
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`COMMENT ON TABLE users.profiles IS 'Optional public profile, created lazily on first PATCH (INSERT ... ON CONFLICT (user_id) DO UPDATE). 1:0..1 with identity.users.'`,
  sql`COMMENT ON COLUMN users.profiles.headline IS 'NULL = not set. Empty string is rejected so "unset" has a single representation.'`,
  sql`COMMENT ON COLUMN users.profiles.avatar_media_id IS 'Soft reference to the Phase 2 media module; FK added when media exists.'`,
];

const usersInstructorApplications = [
  sql`
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
      CONSTRAINT instructor_applications_pk                  PRIMARY KEY (id),
      CONSTRAINT instructor_applications_applicant_id_fk     FOREIGN KEY (applicant_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT instructor_applications_status_ck           CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
      CONSTRAINT instructor_applications_motivation_ck       CHECK (char_length(motivation) BETWEEN 100 AND 3000),
      CONSTRAINT instructor_applications_expertise_ck        CHECK (char_length(expertise) BETWEEN 3 AND 200),
      CONSTRAINT instructor_applications_experience_level_ck CHECK (experience_level IN ('NONE','INFORMAL','PROFESSIONAL','ONLINE')),
      CONSTRAINT instructor_applications_portfolio_url_ck    CHECK (portfolio_url IS NULL OR
                                                             (char_length(portfolio_url) <= 2048 AND portfolio_url ~ '^https://[^[:space:]]+$')),
      CONSTRAINT instructor_applications_version_ck          CHECK (version >= 1)
    )
  `,
  // One PENDING per applicant (race-safe; 23505 -> ApplicationAlreadyPending)
  sql`
    CREATE UNIQUE INDEX instructor_applications_applicant_id_pending_uq
      ON users.instructor_applications (applicant_id) WHERE status = 'PENDING'
  `,
  // Admin queue keyset: WHERE status=$1 AND (submitted_at,id) > ($c1,$c2) ORDER BY submitted_at, id
  sql`
    CREATE INDEX instructor_applications_status_submitted_at_id_idx
      ON users.instructor_applications (status, submitted_at, id)
  `,
  // "My applications" newest first; FK index for applicant_id
  sql`
    CREATE INDEX instructor_applications_applicant_id_submitted_at_idx
      ON users.instructor_applications (applicant_id, submitted_at DESC)
  `,
  sql`
    CREATE TRIGGER instructor_applications_set_updated_at_trg BEFORE UPDATE ON users.instructor_applications
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
  `,
  sql`
    COMMENT ON TABLE users.instructor_applications IS
      'InstructorApplication aggregate. status is a guarded materialisation of the latest transition (documented 3NF exception), verified at commit by a deferred constraint trigger.'
  `,
  sql`COMMENT ON COLUMN users.instructor_applications.status IS 'Materialised = to_status of the transition that has no successor. Needed for the partial unique index and the queue index.'`,
  sql`COMMENT ON COLUMN users.instructor_applications.submitted_at IS 'Aggregate creation time; equals the submission transition occurred_at (same transaction, same now()).'`,
  sql`COMMENT ON COLUMN users.instructor_applications.version IS 'Optimistic-concurrency token; incremented on every state change (expectedVersion).'`,
];

// Constraint names use the ia_transitions_ prefix: the full table name would exceed 63 chars.
const usersTransitions = [
  sql`
    CREATE TABLE users.instructor_application_transitions (
      id             uuid        NOT NULL DEFAULT uuidv7(),
      application_id uuid        NOT NULL,
      from_status    text        NULL,
      to_status      text        NOT NULL,
      actor_id       uuid        NOT NULL,
      reason         text        NULL,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ia_transitions_pk                       PRIMARY KEY (id),
      CONSTRAINT ia_transitions_application_id_fk        FOREIGN KEY (application_id) REFERENCES users.instructor_applications (id) ON DELETE RESTRICT,
      CONSTRAINT ia_transitions_actor_id_fk              FOREIGN KEY (actor_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
      CONSTRAINT ia_transitions_from_status_ck           CHECK (from_status IS NULL OR from_status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
      CONSTRAINT ia_transitions_to_status_ck             CHECK (to_status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
      CONSTRAINT ia_transitions_from_status_to_status_ck CHECK (from_status IS DISTINCT FROM to_status),
      CONSTRAINT ia_transitions_edge_ck                  CHECK ((from_status IS NULL AND to_status = 'PENDING')
                                                             OR (from_status = 'PENDING' AND to_status IN ('APPROVED','REJECTED','WITHDRAWN'))),
      CONSTRAINT ia_transitions_reason_ck                CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
      CONSTRAINT ia_transitions_reason_scope_ck          CHECK (reason IS NULL OR to_status IN ('APPROVED','REJECTED')),
      CONSTRAINT ia_transitions_rejected_reason_ck       CHECK (to_status <> 'REJECTED' OR (reason IS NOT NULL AND char_length(reason) >= 10)),
      CONSTRAINT ia_transitions_application_id_to_status_uq   UNIQUE (application_id, to_status),
      CONSTRAINT ia_transitions_application_id_from_status_uq UNIQUE NULLS NOT DISTINCT (application_id, from_status)
    )
  `,
  sql`
    CREATE TRIGGER ia_transitions_append_only_trg BEFORE UPDATE OR DELETE ON users.instructor_application_transitions
      FOR EACH ROW EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  sql`
    CREATE TRIGGER ia_transitions_no_truncate_trg BEFORE TRUNCATE ON users.instructor_application_transitions
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_append_only_mutation()
  `,
  // Actor rules (immediate): submit/withdraw by applicant only; approve/reject never by applicant.
  sql`
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
    $$
  `,
  sql`
    CREATE TRIGGER ia_transitions_actor_trg BEFORE INSERT ON users.instructor_application_transitions
      FOR EACH ROW EXECUTE FUNCTION users.ia_transitions_actor_guard()
  `,
  // Materialised status == latest transition, checked at COMMIT (deferred) from both sides.
  sql`
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
    $$
  `,
  sql`
    CREATE CONSTRAINT TRIGGER instructor_applications_status_log_trg
      AFTER INSERT OR UPDATE OF status ON users.instructor_applications
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users.instructor_application_status_guard()
  `,
  sql`
    CREATE CONSTRAINT TRIGGER ia_transitions_status_log_trg
      AFTER INSERT ON users.instructor_application_transitions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users.instructor_application_status_guard()
  `,
  sql`
    COMMENT ON TABLE users.instructor_application_transitions IS
      'Append-only state log of instructor applications: who, when, why. from_status NULL = submission. Kept forever.'
  `,
  sql`COMMENT ON COLUMN users.instructor_application_transitions.reason IS 'Required (10..1000) for REJECTED; optional admin note for APPROVED; NULL otherwise.'`,
];

// ---------------------------------------------------------------------------
// 4. Privileges (prod role split; no-op in dev where udemy_app doesn't exist)
// ---------------------------------------------------------------------------
const privileges = [
  sql`
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
    $$
  `,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await run(db, shared);
  await run(db, identityUsers);
  await run(db, identityUserBans);
  await run(db, identitySessions);
  await run(db, identityRefreshTokens);
  await run(db, identityOneTimeTokens);
  await run(db, identitySecurityEvents);
  await run(db, accessRoles);
  await run(db, accessUserRoles);
  await run(db, accessRoleChanges);
  await run(db, usersProfiles);
  await run(db, usersInstructorApplications);
  await run(db, usersTransitions);
  await run(db, privileges);
}

/**
 * Reverse order of up(), no CASCADE (matches 0001): if a later migration still
 * depends on any of these objects, fail loudly instead of silently dropping it.
 * Grants/comments/triggers/indexes go away with their tables and functions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await run(db, [
    // users
    sql`DROP TABLE IF EXISTS users.instructor_application_transitions`,
    sql`DROP TABLE IF EXISTS users.instructor_applications`,
    sql`DROP TABLE IF EXISTS users.profiles`,
    sql`DROP FUNCTION IF EXISTS users.instructor_application_status_guard()`,
    sql`DROP FUNCTION IF EXISTS users.ia_transitions_actor_guard()`,
    // access
    sql`DROP TABLE IF EXISTS access.role_changes`,
    sql`DROP TABLE IF EXISTS access.user_roles`,
    sql`DROP TABLE IF EXISTS access.roles`,
    // identity
    sql`DROP TABLE IF EXISTS identity.security_events`,
    sql`DROP FUNCTION IF EXISTS identity.purge_security_events(integer)`,
    sql`DROP FUNCTION IF EXISTS identity.security_events_guard()`,
    sql`DROP TABLE IF EXISTS identity.one_time_tokens`,
    sql`DROP TABLE IF EXISTS identity.refresh_tokens`,
    sql`DROP TABLE IF EXISTS identity.sessions`,
    sql`DROP TABLE IF EXISTS identity.user_bans`,
    sql`DROP TABLE IF EXISTS identity.users`,
    // shared
    sql`DROP FUNCTION IF EXISTS public.forbid_append_only_mutation()`,
    sql`DROP SCHEMA IF EXISTS users`,
  ]);
}
