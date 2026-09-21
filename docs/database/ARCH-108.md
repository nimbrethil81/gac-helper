# ARCH-108 catalogue publication — Phase A implementation record

**Status: Implementation ready for ARCH-104 and connected verification.** This is not an ARCH-108 completion claim. No hosted database or Cloudflare target was contacted, configured or changed.

## Implemented

- Payload schema v1 generation preserves the seven app fields and adds `payloadSchemaVersion`, `catalogueVersion`, `checksum`, `units` and `provenance`. Canonical JSON supplies a reproducible SHA-256 checksum.
- Whole-payload validation covers exact modes and top-level shape, checksum/schema/version, board territories, scoring and undersize ceilings, `SETTING_DEFENCE`, member/external-ID references, stable counter and defence names, assessed-value provenance, persisted-base compatibility and public-artifact secret scanning.
- `20260921160000_arch_108_catalogue_value_lifecycle.sql` adds auditable `ACTIVE`/`RETIRED` lifecycle state to profile members and defence values. The authoring loader supports idempotent retire/reactivate operations. Publication filters those rows and every retired unit, archetype, profile and matchup ancestor. `gac_authoring` still has no `DELETE` grant.
- `20260921160010_arch_108_release_rollback_transition.sql` permits only the `SUPERSEDED` → `DEPLOYED` status transition needed to select a retained immutable release during rollback. Payload, version, schema, base, reason, checksum and source commit remain trigger-protected; each rollback appends `ROLLBACK` provenance.
- Preparation and finalisation are separate short `gac_publisher` transactions under `pg_advisory_xact_lock(108108)`. Preparation rechecks the base, allocates `max(version)+1`, validates before inserting `READY`, and does not move `catalogue_state`. Finalisation rechecks the base and checksum, records repository/Cloudflare identifiers, and moves the pointer only after external verification.
- Versioned `catalogue/vN.json` artifacts are write-once, `catalogue/current.json` is replaced atomically in staging, prior artifacts are retained, and the public directory is built only from an explicit application-file allow-list plus generated catalogue artifacts.
- Cloudflare deployment, HTTP verification, database finalisation, reconciliation and rollback are separate adapters/commands. Local tests replace deployment and HTTP with stateful substitutes; they do not claim to reproduce Cloudflare.
- `.github/workflows/publish-catalogue.yml` is manual-only (`workflow_dispatch`), has `gac-helper-production-publish` concurrency with `cancel-in-progress: false`, and calls the same core commands intended for any future scheduled trigger. No schedule exists.

## Commands and manual entry points

```text
npm run catalogue:generate -- --commit <sha> --reason <reason> [--change-ids <ids>] [--base <id|none>]
npm run catalogue:validate -- --file <payload.json>
npm run catalogue:prepare  -- --commit <sha> --reason <reason> [--change-ids <ids>] [--base <id|none>]
npm run catalogue:stage    -- --commit <sha> --release-id <id>
npm run catalogue:deploy   -- --commit <sha> --release-id <id>
npm run catalogue:verify   -- --commit <sha> --release-id <id>
npm run catalogue:finalise -- --commit <sha> --release-id <id> --deployment-id <id>
npm run catalogue:reconcile -- --commit <sha>
npm run catalogue:rollback -- --commit <sha> --release-id <prior-id>
npm run catalogue:publish  -- --commit <sha> --reason <reason> [--change-ids <ids>] [--base <id|none>]
```

`catalogue:publish` is the entire manual prepare → stage → deploy → HTTP verify → finalise path. The workflow also exposes publish, reconcile and rollback choices. `AUTHORING` requires at least one referenced `APPLIED` change and records it in `catalogue_release_authoring_changes`.

For offline Phase-A command rehearsal, add `--simulate --data-dir .local/arch108`; this uses persistent PGlite plus the filesystem deployment adapter under `dist/public` and never reads provider credentials or contacts a network. Omit `--simulate` for the connected ARCH-104 path.

## Local evidence

PGlite exercises the PostgreSQL constraints, RLS roles, transactions, lifecycle triggers, transaction-scoped advisory-lock statement and sequential stale-base behaviour. Tests prove: invalid candidates write no release/artifact; version allocation is monotonic; `READY` does not move the pointer; finalisation does; deployment and reconciliation are idempotent; simulated deployment and HTTP failures remain `READY`; a simulated finalisation failure is repaired by reconciliation; incompatible rollback is refused; compatible rollback selects an existing checksum-verified retained artifact; and previous artifacts remain available.

Golden parity is exact for the seven legacy app fields after ARCH-106's two already-declared reconciliation deltas. The only payload additions are the five schema-v1 fields above; scoring is compared order-insensitively as already declared by ARCH-106. Public identifiers, display names, public mode spellings and notes otherwise match exactly.

The accepted ARCH-107 example validates, dry-runs, applies twice with a no-op second apply, produces an `AUTHORING` release linked to its change, and adds exactly the `FO_HUX` definition/matchup. Its compensating change retires the created identity and the next normal release contains no `FO_HUX` definition or matchup. Focused lifecycle tests also retire/reactivate a member and defence value twice and confirm retired data is filtered.

PGlite serialises access through its local connection model and therefore does **not** prove contention between independent PostgreSQL sessions or real advisory-lock blocking. The SQL lock, recheck and workflow concurrency declarations are locally inspectable; real overlapping sessions and overlapping production runs remain Phase B.

## Rollback and reconciliation

- Deployment failure: the immutable database release remains `READY`; rerun deploy for that release.
- HTTP-verification failure: it remains `READY`; finalisation is not called.
- Finalisation failure: reconciliation compares the live pointer's version/checksum with recorded `READY` releases and finalises an exact match. If live state matches no `READY` release, it redeploys the database's last `DEPLOYED` release.
- Rollback accepts only a prior `SUPERSEDED` release with payload schema 1 and an exact retained-artifact checksum. It deploys and verifies that artifact before moving the database pointer and appends rollback provenance.
- Schema rollback is non-destructive: lifecycle-column removal refuses to run while retired child rows exist. The release-transition rollback refuses an in-progress two-`DEPLOYED` state.

## ARCH-104 configuration interface

ARCH-104 must supply values without committing them:

| Kind | Exact name | Requirement |
|---|---|---|
| GitHub secret | `SUPABASE_PUBLISHER_DATABASE_URL` | SSL-required connection for a login that assumes only `gac_publisher`; use the Supabase session pooler when GitHub Actions needs IPv4. Do not use `service_role`. |
| GitHub secret | `CLOUDFLARE_API_TOKEN` | Least-scope token able to deploy only the selected Worker. |
| GitHub secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the target Worker. |
| GitHub variable | `CLOUDFLARE_PRODUCTION_WORKER_NAME` | Existing production Worker name. |
| GitHub variable | `CATALOGUE_PRODUCTION_BASE_URL` | HTTPS origin used for post-deployment pointer/artifact verification. |

Time-sensitive provider assumptions to re-check in ARCH-104: the chosen [Supabase connection method](https://supabase.com/docs/guides/database/connecting-to-postgres)'s IPv4/SSL and session behaviour; custom-role connection-string form; Cloudflare's current [static-asset](https://developers.cloudflare.com/workers/static-assets/) and [version/deployment](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/) semantics and retention; [rollback](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/) limitations; Wrangler 4.136 command/JSON output; [CI token](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) scopes; and repository Actions secret/variable availability. The implementation pins Wrangler and records the returned Cloudflare deployment identifier.

## Phase B — connected verification still required

- apply/inspect the migrations and role grants on the hosted Supabase target;
- deploy the real Cloudflare Worker and verify the versioned artifact and pointer over HTTP;
- force a real Cloudflare deployment failure;
- force HTTP verification failure against that target;
- force database-finalisation failure and reconcile it against live static state;
- overlap two real production workflow runs and observe concurrency serialisation;
- overlap independent connected publisher sessions and observe advisory-lock/base recheck behaviour;
- verify hosted `gac_publisher`, `gac_authoring`, `anon` and `authenticated` permissions, including absence of `DELETE` and broad credentials;
- run connected end-to-end `MIGRATION` and `AUTHORING` publication, provenance and compatible rollback;
- confirm retained-artifact and Cloudflare rollback behaviour under the then-current provider semantics.

That connected pass is also the remaining operational sign-off for ARCH-107. Before Stage 2 automation may apply changes, a distinct database-enforced maintenance/applier boundary is mandatory; ARCH-108 intentionally creates no Stage-2 role.

ARCH-109 owns PWA cache/fetch changes. ARCH-110 owns the integrated rehearsal; ARCH-111/112 own hosting consolidation and production cutover. Nothing here changes the live URL or shipped client behaviour.
