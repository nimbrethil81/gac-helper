# ARCH-105 database schema and permissions

This document is the operational entry point for the unconnected Stage-1 database schema. The accepted model and role boundaries remain authoritative in [`TARGET_ARCHITECTURE.md`](../TARGET_ARCHITECTURE.md) and [`ADR-ARCH-102-platform.md`](../decisions/ADR-ARCH-102-platform.md).

## Contents

- `supabase/migrations/20260921101325_arch_105_core_schema.sql` creates the private `gac` schema, enum types, 21 tables, referential and lifecycle constraints, indexes, triggers and row-level security.
- `supabase/migrations/20260921101336_arch_105_stage1_permissions.sql` creates the `NOLOGIN` group roles `gac_authoring` and `gac_publisher`, grants only their Stage-1 capabilities, and creates their RLS policies.
- Matching files in `supabase/rollbacks/` remove the permission layer first and then the schema and migration-owner role.
- `tests/database-schema.test.js` applies the migrations to disposable WebAssembly PostgreSQL, tests constraints and role boundaries, runs rollback, and reapplies from empty.

Two ordered follow-up migrations owned by ARCH-106 correct constraints in this schema — `20260921113000_arch_106_unit_id_format.sql` widens `units_unit_id_format` and `20260921113010_arch_106_mirror_matchups.sql` removes `matchups_distinct_archetypes` — each with a matching non-destructive rollback. The reasons are recorded in [`ARCH-106.md`](ARCH-106.md). The two ARCH-105 files above are unchanged.

The migrations create no login credential, secret or catalogue seed data. They do not connect to the hosted Supabase project. ARCH-104 will create the separate login credentials that assume the checked-in `NOLOGIN` group roles.

## Role boundary

| Role | Allowed | Explicitly excluded |
|---|---|---|
| `gac_migration_admin` | Own the private schema and its objects; used only while applying approved migrations | Login credential, GitHub Actions secret, superuser, role creation, database creation, RLS bypass |
| `gac_authoring` | Read and write canonical catalogue, accepted values, authoring records, board configuration and scoring; read release base/current state | Schema/policy changes, evidence/assessment writes, release or current-pointer writes |
| `gac_publisher` | Read the complete schema; insert immutable release/provenance records; perform allowed release transitions; move the singleton current pointer | Canonical catalogue writes, schema/policy changes, arbitrary release-field mutation |

`anon` and `authenticated` receive no `gac` schema usage or table access. The live PWA therefore has no database path. The optional backup/export role is not created because the accepted Stage-1 recovery model reconstructs state from migrations, authoring changes and immutable artifacts. Stage-2 evidence-ingester, maintenance-analyst and deterministic-applier roles are deliberately absent.

## Local validation

Run:

```bash
npm run check
npm test
npm run db:test
```

The test runner uses `@electric-sql/pglite` pinned in `package-lock.json`; it does not require Docker or a network service.

## Hosted application and rollback

ARCH-104 applies these ordered migrations through the normal Supabase migration history after its time-sensitive provider checks and credential setup. Do not paste individual statements selectively into the hosted project.

Before any future connected application, take the recovery action required by the active environment. To reverse an unconnected/disposable application, execute every `.down.sql` file in reverse migration order: the two ARCH-106 follow-ups first, then the permissions rollback, then the core-schema rollback. No application currently reads this database, so rollback does not affect the live PWA.
