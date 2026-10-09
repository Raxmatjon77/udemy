-- Constraint smoke tests for migration 0002 (identity, access, users).
-- Every check runs inside one transaction that ends in ROLLBACK, so no data is left behind.
-- Run: docker exec -i udemy-dev-postgres-1 psql -U udemy -d udemy < packages/db/sql/smoke/0002_identity_access_users.sql
-- Seed for the Testcontainers suite planned in Phase 1 T16.

\set ON_ERROR_STOP on
\pset footer off
\pset tuples_only on
SELECT 'user=' || current_user || ' superuser=' || rolsuper FROM pg_roles WHERE rolname = current_user;
BEGIN;
CREATE FUNCTION pg_temp.expect_fail(label text, stmt text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE st text; con text; msg text; ctx text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, con = CONSTRAINT_NAME, msg = MESSAGE_TEXT, ctx = PG_EXCEPTION_CONTEXT;
    RETURN format('PASS %s | %s | constraint=%s | %s%s', label, st, coalesce(nullif(con,''),'-'), msg,
                  CASE WHEN ctx LIKE 'PL/pgSQL function %' THEN ' | ' || split_part(ctx, E'\n', 1) ELSE '' END);
  END;
  RETURN 'FAIL (no error) ' || label;
END $f$;

-- fixtures: A applicant, B admin, C second applicant
INSERT INTO identity.users (id, email, display_name, password_hash) VALUES
 ('00000000-0000-7000-8000-00000000000a','a@x.test','Alice','$argon2id$v=19$m=1$x'),
 ('00000000-0000-7000-8000-00000000000b','b@x.test','Bob','$argon2id$v=19$m=1$x'),
 ('00000000-0000-7000-8000-00000000000c','c@x.test','Carol','$argon2id$v=19$m=1$x');
INSERT INTO access.user_roles (user_id, role_code) VALUES ('00000000-0000-7000-8000-00000000000b','ADMIN');
INSERT INTO access.role_changes (user_id, role_code, change, actor_id, reason, source_type)
 VALUES ('00000000-0000-7000-8000-00000000000b','ADMIN','GRANTED',NULL,'bootstrap','cli_bootstrap');
INSERT INTO identity.sessions (id, user_id, client_app, created_ip, last_ip, absolute_expires_at) VALUES
 ('00000000-0000-7000-8000-000000000051','00000000-0000-7000-8000-00000000000a','student','203.0.113.7','203.0.113.7', now()+interval '30 days'),
 ('00000000-0000-7000-8000-000000000052','00000000-0000-7000-8000-00000000000a','student','::1','::1', now()+interval '30 days');
-- S1: t1 consumed -> t2 current
INSERT INTO identity.refresh_tokens (id, session_id, token_hash, parent_id, expires_at, consumed_at) VALUES
 ('00000000-0000-7000-8000-0000000000f1','00000000-0000-7000-8000-000000000051', sha256('t1'), NULL, now()+interval '1 day', now());
INSERT INTO identity.refresh_tokens (id, session_id, token_hash, parent_id, expires_at) VALUES
 ('00000000-0000-7000-8000-0000000000f2','00000000-0000-7000-8000-000000000051', sha256('t2'), '00000000-0000-7000-8000-0000000000f1', now()+interval '1 day');
-- application of A, PENDING with its submission transition
INSERT INTO users.instructor_applications (id, applicant_id, motivation, expertise, experience_level) VALUES
 ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-00000000000a', repeat('m',120), 'Postgres', 'PROFESSIONAL'),
 ('00000000-0000-7000-8000-0000000000a2','00000000-0000-7000-8000-00000000000c', repeat('m',120), 'Postgres', 'PROFESSIONAL');
INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id) VALUES
 ('00000000-0000-7000-8000-0000000000a1', NULL, 'PENDING', '00000000-0000-7000-8000-00000000000a'),
 ('00000000-0000-7000-8000-0000000000a2', NULL, 'PENDING', '00000000-0000-7000-8000-00000000000c');
-- the fixtures themselves satisfy the deferred status/log check
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT 'fixtures OK (status/log consistent)';

SELECT pg_temp.expect_fail('01a STUDENT grant (implicit=false)',
 $$INSERT INTO access.user_roles (user_id, role_code) VALUES ('00000000-0000-7000-8000-00000000000a','STUDENT')$$);
SELECT pg_temp.expect_fail('01b STUDENT grant (implicit=true)',
 $$INSERT INTO access.user_roles (user_id, role_code, role_is_implicit) VALUES ('00000000-0000-7000-8000-00000000000a','STUDENT',true)$$);
SELECT pg_temp.expect_fail('01c STUDENT in role_changes',
 $$INSERT INTO access.role_changes (user_id, role_code, change, actor_id, reason, source_type) VALUES ('00000000-0000-7000-8000-00000000000a','STUDENT','GRANTED','00000000-0000-7000-8000-00000000000b','x','admin')$$);
SELECT pg_temp.expect_fail('01d flip STUDENT to explicit',
 $$UPDATE access.roles SET is_implicit = false WHERE code = 'STUDENT'$$);

INSERT INTO identity.user_bans (user_id, reason, banned_by) VALUES ('00000000-0000-7000-8000-00000000000c','spamming the forums','00000000-0000-7000-8000-00000000000b');
SELECT pg_temp.expect_fail('02 second active ban',
 $$INSERT INTO identity.user_bans (user_id, reason, banned_by) VALUES ('00000000-0000-7000-8000-00000000000c','spamming again!!','00000000-0000-7000-8000-00000000000b')$$);

SELECT pg_temp.expect_fail('03 second unconsumed token in session',
 $$INSERT INTO identity.refresh_tokens (session_id, token_hash, expires_at) VALUES ('00000000-0000-7000-8000-000000000051', sha256('t3'), now()+interval '1 day')$$);
SELECT pg_temp.expect_fail('03b second child of same parent',
 $$INSERT INTO identity.refresh_tokens (session_id, token_hash, parent_id, expires_at, consumed_at) VALUES ('00000000-0000-7000-8000-000000000051', sha256('t4'), '00000000-0000-7000-8000-0000000000f1', now()+interval '1 day', now())$$);

SELECT pg_temp.expect_fail('04 child with parent in another session',
 $$INSERT INTO identity.refresh_tokens (session_id, token_hash, parent_id, expires_at) VALUES ('00000000-0000-7000-8000-000000000052', sha256('t5'), '00000000-0000-7000-8000-0000000000f2', now()+interval '1 day')$$);

SELECT pg_temp.expect_fail('05 second PENDING application',
 $$INSERT INTO users.instructor_applications (applicant_id, motivation, expertise, experience_level) VALUES ('00000000-0000-7000-8000-00000000000a', repeat('m',120), 'Kafka', 'NONE')$$);

-- approve a1 by admin B (valid), then try again / try reject
INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id)
 VALUES ('00000000-0000-7000-8000-0000000000a1','PENDING','APPROVED','00000000-0000-7000-8000-00000000000b');
UPDATE users.instructor_applications SET status='APPROVED', version=version+1 WHERE id='00000000-0000-7000-8000-0000000000a1';
SELECT pg_temp.expect_fail('06a double approve',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id) VALUES ('00000000-0000-7000-8000-0000000000a1','PENDING','APPROVED','00000000-0000-7000-8000-00000000000b')$$);
SELECT pg_temp.expect_fail('06b reject after approve',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id, reason) VALUES ('00000000-0000-7000-8000-0000000000a1','PENDING','REJECTED','00000000-0000-7000-8000-00000000000b','not good enough sorry')$$);
SELECT pg_temp.expect_fail('06c APPROVED -> REJECTED edge',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id, reason) VALUES ('00000000-0000-7000-8000-0000000000a1','APPROVED','REJECTED','00000000-0000-7000-8000-00000000000b','not good enough sorry')$$);

SELECT pg_temp.expect_fail('07a REJECTED without reason',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id) VALUES ('00000000-0000-7000-8000-0000000000a2','PENDING','REJECTED','00000000-0000-7000-8000-00000000000b')$$);
SELECT pg_temp.expect_fail('07b REJECTED with short reason',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id, reason) VALUES ('00000000-0000-7000-8000-0000000000a2','PENDING','REJECTED','00000000-0000-7000-8000-00000000000b','short')$$);

SELECT pg_temp.expect_fail('08a applicant approves own',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id) VALUES ('00000000-0000-7000-8000-0000000000a2','PENDING','APPROVED','00000000-0000-7000-8000-00000000000c')$$);
SELECT pg_temp.expect_fail('08b admin withdraws for applicant',
 $$INSERT INTO users.instructor_application_transitions (application_id, from_status, to_status, actor_id) VALUES ('00000000-0000-7000-8000-0000000000a2','PENDING','WITHDRAWN','00000000-0000-7000-8000-00000000000b')$$);

SELECT pg_temp.expect_fail('09a UPDATE role_changes',   $$UPDATE access.role_changes SET reason = 'tampered'$$);
SELECT pg_temp.expect_fail('09b DELETE role_changes',   $$DELETE FROM access.role_changes$$);
SELECT pg_temp.expect_fail('09c TRUNCATE role_changes', $$TRUNCATE access.role_changes$$);
SELECT pg_temp.expect_fail('09d UPDATE transitions',    $$UPDATE users.instructor_application_transitions SET reason = NULL$$);
SELECT pg_temp.expect_fail('09e DELETE transitions',    $$DELETE FROM users.instructor_application_transitions$$);
SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_fail('09f TRUNCATE transitions',  $$TRUNCATE users.instructor_application_transitions$$);

INSERT INTO identity.security_events (user_id, type, occurred_at) VALUES
 ('00000000-0000-7000-8000-00000000000a','LOGIN_SUCCEEDED', now() - interval '200 days'),
 ('00000000-0000-7000-8000-00000000000a','LOGIN_SUCCEEDED', now() - interval '181 days'),
 ('00000000-0000-7000-8000-00000000000a','LOGIN_FAILED',    now() - interval '179 days'),
 ('00000000-0000-7000-8000-00000000000a','LOGIN_FAILED',    now() - interval '1 day');
SELECT 'purge pre-existing rows in table: ' || count(*) FROM identity.security_events WHERE user_id <> '00000000-0000-7000-8000-00000000000a';
SELECT '10a purge_security_events(5000) deleted=' || identity.purge_security_events(5000);
SELECT '10a remaining_ages_days=' || (SELECT string_agg(extract(day from now()-occurred_at)::text, ',' ORDER BY occurred_at) FROM identity.security_events);
SELECT pg_temp.expect_fail('10b direct DELETE of young security_event', $$DELETE FROM identity.security_events$$);
SELECT pg_temp.expect_fail('10c UPDATE security_event', $$UPDATE identity.security_events SET type = 'LOGOUT'$$);
SELECT pg_temp.expect_fail('10d TRUNCATE security_events', $$TRUNCATE identity.security_events$$);
SELECT pg_temp.expect_fail('10e purge batch 0', $$SELECT identity.purge_security_events(0)$$);

SELECT pg_temp.expect_fail('11a bcrypt password_hash',
 $$INSERT INTO identity.users (email, display_name, password_hash) VALUES ('d@x.test','Dave','$2b$12$abcdefghijklmnopqrstuv')$$);
SELECT pg_temp.expect_fail('11b argon2i (not id) password_hash',
 $$INSERT INTO identity.users (email, display_name, password_hash) VALUES ('d@x.test','Dave','$argon2i$v=19$m=1$x')$$);

-- extra: deferred status/log check fires at commit time (forced via SET CONSTRAINTS IMMEDIATE)
SELECT pg_temp.expect_fail('12 status without matching transition (deferred)',
 $$UPDATE users.instructor_applications SET status='WITHDRAWN' WHERE id='00000000-0000-7000-8000-0000000000a2'; SET CONSTRAINTS ALL IMMEDIATE$$);
SELECT pg_temp.expect_fail('13 email uniqueness is case-insensitive',
 $$INSERT INTO identity.users (email, display_name, password_hash) VALUES ('A@X.test','Alice2','$argon2id$v=19$m=1$x')$$);
ROLLBACK;
SELECT 'leftover rows: users=' || (SELECT count(*) FROM identity.users) || ' sessions=' || (SELECT count(*) FROM identity.sessions)
  || ' tokens=' || (SELECT count(*) FROM identity.refresh_tokens) || ' apps=' || (SELECT count(*) FROM users.instructor_applications)
  || ' transitions=' || (SELECT count(*) FROM users.instructor_application_transitions) || ' role_changes=' || (SELECT count(*) FROM access.role_changes)
  || ' sec_events=' || (SELECT count(*) FROM identity.security_events) || ' roles=' || (SELECT string_agg(code||':'||is_implicit, ',' ORDER BY code) FROM access.roles);
