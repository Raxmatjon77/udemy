# Postgres roles (staging / prod)

`roles.sql` sets up the role split from `docs/phase-1-schema-design.md` §4. **Dev does not use it.**
The compose stack keeps the single superuser `udemy`, and the migrations' `IF EXISTS (udemy_app)`
grant blocks are no-ops there. The append-only triggers are the only guard in dev.

| Role             | Attributes             | Used by                                                                   |
| ---------------- | ---------------------- | ------------------------------------------------------------------------- |
| `udemy_owner`    | NOLOGIN                | owns the database, every schema, table and function                       |
| `udemy_migrator` | LOGIN, member of owner | the migration Job; each session runs `SET ROLE udemy_owner` automatically |
| `udemy_app`      | LOGIN, NOSUPERUSER     | `apps/api` and `apps/worker` (`DATABASE_URL`)                             |
| `udemy_debezium` | LOGIN, REPLICATION     | the Debezium connector (`database.user`); SELECT on `outbox.events` only  |

What the script grants:

- Default privileges for objects created by `udemy_owner`: USAGE on new schemas, DML on new tables,
  USAGE/SELECT on sequences, and EXECUTE on functions for `udemy_app`. EXECUTE is revoked from PUBLIC.
- The per-table exceptions (no UPDATE/DELETE/TRUNCATE on the append-only tables, read-only
  `access.roles`) are applied by the migrations themselves.
- `udemy_app` gets no access to `public.kysely_migration*`.
- Only `udemy_migrator`, `udemy_app` and `udemy_debezium` may CONNECT.

## When to run

Run it on every new environment, and again after any deploy that adds schemas or outbox tables.
It is idempotent: it re-applies attributes, passwords and grants, so re-running also rotates passwords.

On a new database:

1. Create the database as the admin (`CREATE DATABASE udemy;`). Postgres must run with
   `wal_level=logical` for Debezium.
2. Run `roles.sql`. It creates the roles and makes `udemy_owner` the database owner.
3. Run the migrations as `udemy_migrator`:
   `DATABASE_URL=postgres://udemy_migrator:…@host/udemy pnpm --filter @udemy/db migrate:latest`
   (in k8s, the migration Job runs before the Deployment rollout).
4. Run `roles.sql` again. This grants on objects that exist only after migrating
   (`outbox.events` for Debezium) and revokes app access to the Kysely bookkeeping tables.

## How to run

Connect as a superuser (or the cloud admin role) **to the application database**. Pass passwords as
psql variables taken from the secret store. Never write them into the file.

```bash
psql "postgres://$PG_ADMIN_USER@$PG_HOST:5432/udemy" \
  -v app_password="$UDEMY_APP_DB_PASSWORD" \
  -v migrator_password="$UDEMY_MIGRATOR_DB_PASSWORD" \
  -v debezium_password="$UDEMY_DEBEZIUM_DB_PASSWORD" \
  -f infra/postgres/roles.sql
```

If a variable is missing, the script exits with code 3 before it changes anything.

Notes:

- The passwords appear in `ALTER ROLE … PASSWORD` statements. Make sure `log_statement` is not `all`
  (or `ddl`) on the server while you run it. Alternatively, pass pre-computed SCRAM verifiers
  (`SCRAM-SHA-256$…`) as the variable values, so no plain password ever reaches the server.
- Managed Postgres (RDS / Cloud SQL) has no real superuser. There, give `udemy_debezium` replication
  through the provider's role (`GRANT rds_replication TO udemy_debezium`); the `REPLICATION`
  attribute may be rejected.
- Point the prod Debezium connector at `udemy_debezium` (the dev `infra/debezium/outbox-connector.json`
  uses the superuser `udemy`).
- Never grant `udemy_owner` to `udemy_app`. A table owner can disable the append-only triggers.
  The script revokes such a membership if it finds one.
