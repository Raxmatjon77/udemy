-- =====================================================================================
-- Prod/staging role split (docs/phase-1-schema-design.md §4). NOT used in dev.
--
--   udemy_owner     NOLOGIN. Owns the database, schemas and every object the migrations create.
--   udemy_migrator  LOGIN, member of udemy_owner; its sessions run as udemy_owner automatically
--                   (ALTER ROLE ... SET role), so objects created by migrations are owner-owned.
--   udemy_app       LOGIN, NOSUPERUSER, not an owner. Used by apps/api and apps/worker.
--   udemy_debezium  LOGIN REPLICATION. Reads outbox.events through the dbz_outbox publication.
--   udemy_transcoder LOGIN, NOSUPERUSER, not an owner. Used by apps/transcoder only (design
--                   docs/phase-2-catalog-media-design.md D5/§9): least privilege, because it parses
--                   hostile media. NOT covered by the udemy_app default privileges.
--
-- Idempotent and convergent: re-running creates what is missing, re-applies attributes,
-- passwords and grants. Run it as a superuser (or the cloud admin role), connected to the
-- application database:
--
--   psql "postgres://<admin>@<host>:5432/udemy" \
--     -v app_password="$UDEMY_APP_DB_PASSWORD" \
--     -v migrator_password="$UDEMY_MIGRATOR_DB_PASSWORD" \
--     -v debezium_password="$UDEMY_DEBEZIUM_DB_PASSWORD" \
--     -v transcoder_password="$UDEMY_TRANSCODER_DB_PASSWORD" \
--     -f infra/postgres/roles.sql
--
-- Order on a new database: roles.sql -> migrations (as udemy_migrator) -> roles.sql again
-- (the second run grants on objects that only exist after the migrations, e.g. outbox.events).
-- See infra/postgres/README.md.
-- =====================================================================================

\set ON_ERROR_STOP on
\set QUIET on

\if :{?app_password}
\else
  -- RAISE (with ON_ERROR_STOP) makes psql exit non-zero; a bare \quit would exit 0.
  DO $$ BEGIN RAISE EXCEPTION 'missing psql variable: pass -v app_password=...'; END $$;
\endif
\if :{?migrator_password}
\else
  -- RAISE (with ON_ERROR_STOP) makes psql exit non-zero; a bare \quit would exit 0.
  DO $$ BEGIN RAISE EXCEPTION 'missing psql variable: pass -v migrator_password=...'; END $$;
\endif
\if :{?debezium_password}
\else
  -- RAISE (with ON_ERROR_STOP) makes psql exit non-zero; a bare \quit would exit 0.
  DO $$ BEGIN RAISE EXCEPTION 'missing psql variable: pass -v debezium_password=...'; END $$;
\endif
\if :{?transcoder_password}
\else
  -- RAISE (with ON_ERROR_STOP) makes psql exit non-zero; a bare \quit would exit 0.
  DO $$ BEGIN RAISE EXCEPTION 'missing psql variable: pass -v transcoder_password=...'; END $$;
\endif

-- psql does not interpolate :'vars' inside $$ bodies, so hand the passwords to the DO block
-- through session-local settings (cleared at the end of the script).
SET udemy.app_password = :'app_password';
SET udemy.migrator_password = :'migrator_password';
SET udemy.debezium_password = :'debezium_password';
SET udemy.transcoder_password = :'transcoder_password';

BEGIN;

-- ------------------------------------------------------------------------------- roles
DO $$
BEGIN
  IF current_setting('udemy.app_password') = ''
     OR current_setting('udemy.migrator_password') = ''
     OR current_setting('udemy.debezium_password') = ''
     OR current_setting('udemy.transcoder_password') = '' THEN
    RAISE EXCEPTION 'empty role password';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_owner') THEN
    CREATE ROLE udemy_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_migrator') THEN
    CREATE ROLE udemy_migrator;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_app') THEN
    CREATE ROLE udemy_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_debezium') THEN
    CREATE ROLE udemy_debezium;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udemy_transcoder') THEN
    CREATE ROLE udemy_transcoder;
  END IF;

  -- Attributes are (re)applied on every run, so drift is corrected.
  ALTER ROLE udemy_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXECUTE format(
    'ALTER ROLE udemy_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
    current_setting('udemy.migrator_password'));
  EXECUTE format(
    'ALTER ROLE udemy_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
    current_setting('udemy.app_password'));
  EXECUTE format(
    'ALTER ROLE udemy_debezium LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
    current_setting('udemy.debezium_password'));
  EXECUTE format(
    'ALTER ROLE udemy_transcoder LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
    current_setting('udemy.transcoder_password'));
  -- Bound the blast radius of one runaway session (the app's own statements are short; ffmpeg
  -- runs outside any transaction). Per-role defaults, applied at login.
  ALTER ROLE udemy_transcoder SET statement_timeout = '30s';
  ALTER ROLE udemy_transcoder SET idle_in_transaction_session_timeout = '60s';

  -- The migrator acts as the owner. INHERIT FALSE: it holds no owner rights until SET ROLE,
  -- which the per-role default below does at login, so it can never create objects it owns itself.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = 'udemy_owner'::regrole AND member = 'udemy_migrator'::regrole
      AND NOT inherit_option AND set_option
  ) THEN
    GRANT udemy_owner TO udemy_migrator WITH INHERIT FALSE, SET TRUE;
  END IF;
  ALTER ROLE udemy_migrator SET role = 'udemy_owner';

  -- The app must never own or become the owner (an owner can disable the append-only triggers).
  IF pg_has_role('udemy_app', 'udemy_owner', 'MEMBER') THEN
    REVOKE udemy_owner FROM udemy_app;
  END IF;
  -- The transcoder must not inherit the app's broad DML either.
  IF pg_has_role('udemy_transcoder', 'udemy_owner', 'MEMBER') THEN
    REVOKE udemy_owner FROM udemy_transcoder;
  END IF;
  IF pg_has_role('udemy_transcoder', 'udemy_app', 'MEMBER') THEN
    REVOKE udemy_app FROM udemy_transcoder;
  END IF;
END
$$;

-- --------------------------------------------------------------------------- database
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO udemy_owner', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO udemy_migrator, udemy_app, udemy_debezium, udemy_transcoder',
    current_database());
END
$$;

-- PG15+ default already; explicit so older clusters behave the same. The owner (via
-- pg_database_owner) keeps CREATE on public for public.set_updated_at() and friends.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ------------------------------------------------------------- default privileges
-- Apply to every object udemy_owner creates from now on, i.e. everything the migrations create.
-- Global (no IN SCHEMA) so schemas added by later migrations (e.g. `users` in 0002) are covered.
-- Per-table exceptions (no UPDATE/DELETE/TRUNCATE on append-only tables, read-only access.roles)
-- are REVOKEd by the migrations themselves in their `IF EXISTS (udemy_app)` blocks.
ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner GRANT USAGE ON SCHEMAS TO udemy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO udemy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner GRANT USAGE, SELECT ON SEQUENCES TO udemy_app;
-- Functions are EXECUTE-able by PUBLIC by default; restrict that to the app
-- (matters for SECURITY DEFINER functions such as identity.purge_security_events).
ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE udemy_owner GRANT EXECUTE ON FUNCTIONS TO udemy_app;

-- ------------------------------------------- grants on objects that already exist
-- No-ops before the first migration; run the script again after migrating.
DO $$
DECLARE
  s text;
BEGIN
  -- Schemas created by the migrations before this script ran (or by an older run).
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspowner = 'udemy_owner'::regrole
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO udemy_app', s);
  END LOOP;

  -- Debezium: read only the outbox table (publication.autocreate.mode=disabled, so it needs
  -- no ownership; the migration creates publication dbz_outbox).
  IF to_regnamespace('outbox') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA outbox TO udemy_debezium;
  END IF;
  IF to_regclass('outbox.events') IS NOT NULL THEN
    GRANT SELECT ON outbox.events TO udemy_debezium;
  END IF;

  -- Transcoder: schema USAGE only for now. Without table grants it can connect but touch nothing.
  -- TODO(P2-T1/P2-T4): finalise after migration 0003 (catalog_media) exists. Expected grants, all
  -- explicit (the global default privileges cover udemy_app only, never this role):
  --   media.transcode_jobs      SELECT, UPDATE           lease (FOR UPDATE SKIP LOCKED), heartbeat,
  --                                                      complete / fail / requeue; never INSERT
  --                                                      (the worker enqueues) or DELETE
  --   media.transcode_attempts  SELECT, INSERT, UPDATE   append-only log: insert at start, set
  --                                                      finished_at/outcome once (guard trigger)
  --   media.assets              SELECT, UPDATE           status PROCESSING/READY/FAILED, duration,
  --                                                      dims, output_prefix, failure_code,
  --                                                      source_deleted_at (column-level UPDATE if
  --                                                      the final DDL allows it)
  --   media.asset_renditions    SELECT, INSERT           (final table name per P2-T1)
  --   outbox.events             INSERT                   MediaReady / MediaFailed via insertOutboxEvent
  --   EXECUTE on any function the lease/complete SQL calls (none expected; uuidv7() is built in)
  --   LISTEN media_transcode needs no grant.
  -- Explicitly NOT granted: anything in identity, users, access or catalog; DELETE anywhere.
  IF to_regnamespace('media') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA media TO udemy_transcoder;
  END IF;
  IF to_regnamespace('outbox') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA outbox TO udemy_transcoder;
  END IF;

  -- Migration bookkeeping is owner-only, even though the global table default above grants DML.
  IF to_regclass('public.kysely_migration') IS NOT NULL THEN
    REVOKE ALL ON public.kysely_migration FROM udemy_app;
  END IF;
  IF to_regclass('public.kysely_migration_lock') IS NOT NULL THEN
    REVOKE ALL ON public.kysely_migration_lock FROM udemy_app;
  END IF;
END
$$;

COMMIT;

RESET udemy.app_password;
RESET udemy.migrator_password;
RESET udemy.debezium_password;
RESET udemy.transcoder_password;

\set QUIET off
\echo 'udemy roles and privileges applied'
