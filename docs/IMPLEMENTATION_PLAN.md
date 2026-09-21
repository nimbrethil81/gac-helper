# SWGOH GAC Helper — Target Architecture Implementation Plan

**Status:** Ready for implementation planning and staged execution. No implementation work has started.

**Planning baseline:** `main` at `1e6bdc55b4619eccb4a2ca7103a79d0a831476c1`.

**Architecture authority:** [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) v0.3, informed by the accepted platform decisions in [`docs/decisions/ADR-ARCH-102-platform.md`](decisions/ADR-ARCH-102-platform.md).

**Scope.** This document defines the ordered delivery plan, dependencies, manual configuration, acceptance gates and rollback points for implementing the target architecture. It does not redefine the architecture and does not describe current shipped behaviour. Current behaviour remains authoritative in [`SPEC.md`](SPEC.md).

**Update this document when** a work package is completed, split, materially re-scoped, blocked or abandoned. Record current status and evidence without turning this document into release history. Shipped behaviour moves into `SPEC.md` and the concise release event goes into `changelog.md`.

---

## 1. Delivery principles

1. The programme has exactly **three user-facing stages**.
2. Work packages inside a stage are execution checkpoints, not additional stages.
3. Nearly all GitHub, database and hosting configuration is concentrated into one Stage 1 session.
4. Stage 1 is independently valuable and may remain the final delivered state if useful evidence cannot be obtained.
5. Stage 2 is report-only. It cannot alter the current live catalogue.
6. Stage 3 activates bounded autonomous publication only after Stage 2 acceptance.
7. The current Sheet-backed application remains recoverable throughout Stage 1 and for at least one complete GAC event after cutover.
8. The production app is never switched during an ordinary coding task. Cutover is its own explicitly approved work package.
9. Each work package begins from fresh repository evidence and ends with a reviewed diff, relevant tests and an updated status in this document. The depth of verification at the end of a package is set by principles 16–18, not applied uniformly.
10. Repository changes follow the branch and pull-request workflow in `AGENTS.md`. Pull-request review does not replace the independent verification required by principles 16–18 for higher-risk packages. Agents may not trigger production deployment unless the work package explicitly authorises it.
11. No secrets, personal identifiers or private operational files may enter a public artifact.
12. Stage boundaries are acceptance decisions. Passing unit tests alone is not sufficient.
13. Human authoring and maintenance review must be runnable on demand outside the schedule.
14. Manual and scheduled maintenance use the same core pipeline, policy, validation and audit path; a manual trigger cannot bypass safeguards.
15. This conversation remains the control thread. Coding and deep-analysis work may use breakout threads, but scope, decisions, verification and next-step selection return here.
16. **Verification scales with blast radius, not with package count.** A work package that is local-only, git-revertible and has no external state, production, cost, credential or permission impact may land once: package acceptance tests pass; CI passes; a scope/diff review confirms no unintended changes; its documentation records results, known limitations and deferred integration checks; and the worktree is clean. Full independent verification for such a package is deferred to its stage's integration checkpoint (ARCH-110 for Stage 1, ARCH-207 for Stage 2, ARCH-304 for Stage 3), which re-exercises it there instead of twice.
17. **Full independent verification is risk-triggered**, expressed as criteria rather than a fixed package list, and applies whenever a package involves: cloud configuration, credentials, permissions, RLS or another trust-boundary change; an operation that creates cost or mutates external state; publication, concurrency, rollback or distributed-state logic; a destructive or difficult-to-reverse data operation; a production deployment, URL migration, cutover or autonomous-activation step; or a stage exit gate. A nominally local package that turns out to introduce any of these risks automatically escalates to full verification, regardless of how it was originally scoped.
18. **Later refinement does not normally reopen completed work.** A later package may amend an earlier package's output through additive migrations or documented follow-up changes; both packages' records cross-reference the amendment, and the earlier package remains `Complete`. This is not absolute: if later evidence shows the earlier package fundamentally failed its own acceptance criteria, exposed a security issue, or produced unsafe external state, reopening it is appropriate. Ordinary implementation refinement discovered by a downstream package — as ARCH-106 amending ARCH-105's schema constraints once real data was loaded — is not grounds to reopen the earlier package.

---

## 2. Current repository baseline

At the planning baseline:

- the app is a plain HTML/CSS/JavaScript PWA;
- `app.js` uses one `API_URL` for both catalogue data and `action=roster`;
- Google Sheets is the authored catalogue and Google Apps Script builds its JSON payload;
- Apps Script also proxies the roster request to Comlink;
- the PWA does not persist the catalogue locally before the initial fetch;
- `service-worker.js` precaches only the application shell and uses network-first fallback;
- `tests/my-board.test.js` is the only automated test file;
- `.github/workflows/deploy-to-live.yaml` is manual and synchronises an explicit allow-list into the public live repository;
- `.assetsignore` mirrors the public allow-list;
- internal docs, tests and Apps Script are excluded from the live artifact;
- the current development/live repository split is working and remains the fallback until consolidation is proved;
- the account hosting this repository and the live `gac-helper` repository is GitHub Free — no private-repository GitHub Environments or GitHub Pages ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1, §2).

**Corrected since the planning baseline (ARCH-101, completed):**

- `package.json` now exists, with `npm run check` (syntax/static checks) and `npm test` (`node --test`, discovering all `tests/*.test.js` files) as the deterministic test commands;
- `.github/workflows/ci.yml` now exists, running `npm run check` then `npm test` on push to `main` and on pull requests targeting `main`;
- the disposable Apps Script authorisation helper and its hard-coded personal ally code have been removed from `apps-script/Code.gs`; no personal ally code remains in the repository.

These facts constrain the implementation. None may be silently assumed away.

---

## 3. Programme overview

| Stage | Outcome | User involvement | Production effect |
|---|---|---|---|
| **1. Canonical platform, authoring and publication** | Database-backed canonical store, safe human authoring, immutable static catalogue, offline cache, tested cutover and guarded one-repository deployment | One concentrated configuration session plus explicit cutover approval | Replaces Sheet catalogue runtime only after full acceptance |
| **2. Maintenance engine, report-only** | Evidence ingestion, mapping, assessments and policy findings tested against real cycles | Evidence-source decision and review of validation results | None; current catalogue cannot change |
| **3. Scheduled bounded autonomy** | Idempotent scheduling, automatic validated publication, concise reporting and recovery | Activation approval; later involvement only for failures or genuine escalation | Eligible maintenance releases may become current |

Before Stage 2 there is one **evidence and runner entry gate**. It is a go/no-go check, not a fourth build stage.

---

# Stage 1 — Canonical platform, authoring and publication

## 4. Stage 1 objective

Deliver a complete, independently useful replacement for the Sheet-backed catalogue path while preserving the existing product contract and a simple fallback.

At Stage 1 completion:

- Postgres-compatible storage is the canonical maintenance and authoring store;
- human catalogue changes do not require SQL;
- all current IDs, names, notes, modes, configuration and scoring survive migration;
- the application consumes a validated static catalogue artifact;
- the catalogue loads from a known-good local cache before background refresh;
- Apps Script remains only for roster proxying;
- the old `action=data` route and Sheet remain available during the fallback window;
- the public artifact remains fail-closed;
- repository consolidation has been completed only if its safety gates pass;
- no evidence ingestion or autonomous maintenance has been implemented.

## 5. Stage 1 work packages

### ARCH-101 — Baseline capture and CI foundation

**Purpose:** Establish automated protection before changing architecture.

**Baseline and completion evidence:**

- Starting full `main` SHA: `71ee5eb7453859dd61bfdbb841af0669f23a603f` (2026-09-20; newer than the SHA quoted when this work package was handed off — fresh evidence was obtained before editing).
- Initial test command and result: `node --test tests/*.test.js` — 31/31 passing; no `package.json` existed yet.
- Final repository commands: `npm run check` (runs `node --check` over `app.js`, `service-worker.js` and `tests/*.test.js`) and `npm test` (runs `node --test`, which discovers all `*.test.js` files under `tests/` with no file named explicitly).
- Final test/check results: `npm run check` — clean, no output; `npm test` — 31/31 passing. A temporary intentionally-failing test file was added under `tests/`, confirmed to make `npm test` exit non-zero (32 run, 1 failed), then removed; the suite returned to 31/31 passing.
- CI workflow added: `.github/workflows/ci.yml` — runs on push to `main` and on pull requests targeting `main`, using Node 22, running `npm run check` then `npm test`. No install step, since the project has no dependencies. No secrets and no deployment step.
- No `package-lock.json` was added: the project has zero dependencies, so a lockfile would document nothing and was deliberately omitted.
- The disposable `authorise()` helper and its hard-coded personal ally code were removed from `apps-script/Code.gs`. It was not called by any application code, its own comment already marked it "Safe to delete", and removing it leaves `doGet`, `action=data`, `action=roster` and the roster proxy (`fetchRoster`) unchanged.
- `apps-script/Code.gs` is not covered by the syntax-check script: Node's `node --check` rejects the `.gs` extension outright (`ERR_UNKNOWN_FILE_EXTENSION`), and Apps Script's runtime globals (`SpreadsheetApp`, `ContentService`, `UrlFetchApp`) are not something a plain Node syntax check should pretend to validate. No workaround (renaming, wrapping, or stubbing globals) was introduced; this is a known boundary of the current tooling.
- `.github/workflows/deploy-to-live.yaml` was not modified and was not triggered.
- Resulting completion commit SHA: reported in the coding-agent handoff to the control thread (recording it here would create a self-reference against the commit that carries this update).

**Status: Complete.** Every acceptance criterion below passed.

**Repository work:**

- add the smallest suitable Node project manifest and deterministic test commands;
- make `node --test` run all repository tests without naming an individual file;
- add a CI workflow for pushes and pull requests;
- run syntax checks appropriate to the plain-JavaScript app;
- add initial contract-test locations without changing application behaviour;
- document the exact baseline commit and current test count;
- remove the personal ally code from the disposable Apps Script authorisation helper, or remove the helper entirely.

**Must not:**

- change catalogue behaviour;
- alter deployment;
- introduce a frontend framework or build system merely to support tests.

**Acceptance:**

- existing tests pass locally and in CI;
- CI fails on an intentionally failing test in a temporary verification and returns green after restoration;
- no live/public deployment occurs;
- Apps Script contains no personal ally code.

**Rollback:** Revert this package; current app and deployment remain unchanged.

**Depends on:** none.

---

### ARCH-102 — Platform decisions and threat model

**Purpose:** Resolve the implementation decisions that affect Stage 1 structure before cloud configuration.

**Decision evidence and acceptance:**

- Starting full `main` SHA: `907189cf69dad9adeaab2ee5f1b165871cfe34da` (2026-09-21; the branch `claude/arch-102-platform-decisions-k02zai` was created from this SHA with no divergence, confirmed via `git merge-base --is-ancestor origin/main HEAD`).
- Decision record: [`docs/decisions/ADR-ARCH-102-platform.md`](decisions/ADR-ARCH-102-platform.md), Accepted, decision date 2026-09-21.
- `TARGET_ARCHITECTURE.md` bumped to v0.3 to record these decisions (§14, §15.0, §16, §19 items 24–32, §20, §22).
- Accepted decisions: Cloudflare Workers static assets as the production static host (GitHub Pages retired only at the ARCH-112 exit gate); Supabase Free in London as the Stage-1 canonical database, using the account's one remaining free slot, reversible via a separate approved plan; local disposable Postgres for development plus exactly one hosted canonical project; repository secrets plus manual `workflow_dispatch` as the Stage-1 production gate in place of GitHub Environments; the `READY`/`DEPLOYED` two-phase, HTTP-verified publication protocol in place of a cross-system atomic transaction, with a GitHub Actions concurrency group and idempotent reconciliation; Stage-1 backup/recovery reconstructed from ordered migrations, authoring change files, immutable artifacts and release metadata rather than committed raw `pg_dump` files; no daily Supabase keep-alive, replaced by a preflight/fail-safe/resume pattern; only Stage-1 roles created in Stage 1 (migration/admin, authoring, publisher, and read-only backup/export if needed); mandatory `SECURITY DEFINER` controls if any such function is retained; the production-origin change sequenced as its own ARCH-111/ARCH-112 client-state migration.
- No external service, database, Cloudflare Worker, GitHub secret, environment, scheduled workflow, or production release was created, configured or modified by this work package. This was a documentation-only decision record.
- Resulting completion commit SHA: reported in the coding-agent handoff to the control thread (recording it here would create a self-reference against the commit that carries this update).

**Status: Complete.** Every acceptance criterion below passed.

**Decisions to make from current evidence:**

1. Postgres host and region.
2. One-project versus separate-project environment design.
3. Static catalogue artifact storage and current-pointer mechanism.
4. How the development environment reads unpublished candidate artifacts.
5. One-repository production mechanism and fail-closed public artifact.
6. Backup/export and database wake/recovery procedures.
7. Exact secret and least-privilege role inventory.
8. Whether generated artifacts are committed, attached to releases, or deployed directly.
9. Payload schema version 1 contract.
10. Naming and location of migrations, change files and generated artifacts.

**Required evaluation criteria:**

- no database dependency in the live PWA path;
- no new recurring cost unless explicitly approved;
- compatibility with existing GitHub/static hosting;
- recovery without specialist database knowledge;
- no broad database credential available to the maintenance runner;
- no internal file can enter the public artifact by default;
- the implementation remains portable away from the selected provider.

**Deliverable:** A concise checked-in decision record linked from this plan. Architectural changes discovered here update `TARGET_ARCHITECTURE.md` rather than being hidden in implementation notes.

**Acceptance:** Every Stage 1 configuration field and secret is known before the manual session is scheduled.

**Rollback:** Documentation-only.

**Depends on:** ARCH-101.

---

### ARCH-103 — Migration and golden-contract capture

**Purpose:** Create immutable evidence of the current canonical data and app contract before migration.

**Completion evidence (2026-09-21):**

- Starting full `origin/main` SHA: `d113f512b02d950ede320a26075fe52d3f6e9c97`; the dedicated `codex/arch-103-canonical-baseline` branch was grounded exactly at that commit after confirming the worktree was clean and the remote `main` ref had not moved.
- One replacement read-only `action=data` capture was made at `2026-09-21T08:59:37Z`, using the deployment URL already configured in `app.js`. The exact 77,553 response bytes have SHA-256 `342e3e4bf095cb7ae25011682f81b17da2b8470b445e046db5f541d5bc0cc4a3` and satisfy the seven-key contract in `SPEC.md`.
- Baseline directory: [`data/exports/20260921T085937Z/`](../data/exports/20260921T085937Z/). The raw response, deterministic canonical JSON, manifest, source-tab CSV files and observational report share the same capture timestamp.
- Exported source tabs and data-row counts: `Counters` 366; `Defence_Teams` 9; `Score_Meanings` 26; `Counter_Definitions` 56; `Counter_Composition` 70; `Character_Definitions` 312; `GAC_Board_Config` 40; `GAC_Scoring` 16. The optional `Defence_Composition` tab was absent and is recorded as a zero-row source limitation. `Roster` and `GAC History` were not read or exported.
- Verification command: `npm run baseline:verify`. It checks the file set, byte sizes, hashes, payload schema/types, semantic raw/canonical equality, CSV headers and row counts, payload-domain counts, and prohibited manifest fields without any network access or credential.
- Anomaly summary: [`capture-report.md`](../data/exports/20260921T085937Z/capture-report.md). It records zero migration blockers; deterministic-mapping work for 33 unmatched defence names, one duplicate matchup composite, the synthesized `MAZ_KANATA` counter definition and eight mixed-case `Any` wildcard rows; one safe legacy condition (the absent optional defence-composition tab); and the two informational derived columns.
- ARCH-105 provides the canonical schema and constraints; ARCH-106 owns migration reconciliation and deterministic resolution of the captured mapping anomalies.
- Completion validation included `npm run check`, `npm test`, `npm run baseline:verify`, `git diff --check`, a tracked-files-only clean-checkout verification, a temporary corruption rehearsal that failed non-zero, a post-rehearsal baseline pass, privacy/secret scans, exact raw/canonical semantic comparison and CI review. CI remains credential-free and verifies only committed files.
- No live Sheet cell, Apps Script deployment, endpoint other than `action=data`, cloud service, repository setting/secret, deployment or database was changed.

**Status: Complete.** The acceptance criteria below passed, including explicit reporting of unresolved and partial defence compositions.

**Artifacts:**

- timestamped exports of every relevant Sheet tab;
- current Apps Script `action=data` response as the golden payload;
- manifest containing source timestamp, hashes and row/entity counts;
- reports for current IDs, defence names, modes, required-member external IDs, notes, board configuration and scoring;
- inventory of persisted client keys affected by identity changes.

**Storage constraints:**

- artifacts remain in the private source repository or another approved private location;
- no roster, ally-code or other unnecessary personal data is included;
- generated exports are never added to the public artifact allow-list.

**Acceptance:**

- exports can reconstruct the current payload without querying the Sheet;
- the golden payload is valid JSON and passes a baseline contract test;
- each current `Counter_ID` and defence display name is enumerated;
- unresolved/partial defence compositions are explicitly reported;
- hashes make accidental export changes visible.

**Rollback:** Delete only the new private artifacts if required; the Sheet is untouched.

**Depends on:** ARCH-101. May run in parallel with ARCH-102 after CI exists.

---

### ARCH-104 — Prepared manual-configuration session

**Purpose:** ARCH-104 is the **single guided manual configuration session** for Stage 1: nearly all required cloud and repository setup, completed in one user session after agents have prepared exact instructions and after [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) has resolved every field this session needs.

**Before any creation step, this session must re-check** — per ADR-ARCH-102 §12 — current GitHub Free plan-feature limits (Environments, private-repository Pages), Supabase's current free-tier project-slot limit and pausing behaviour, Supabase's current hosted-region availability (London), Cloudflare Workers' current static-assets versioning semantics and free-tier limits, and the current recurring cost of the selected tiers. Any material change from the ADR's assumptions is reported to the control thread before configuration proceeds, not silently absorbed.

**The remaining free Supabase project may be created only after** this re-check confirms cost and account limits, and building on the owner authorization already recorded in ADR-ARCH-102 §1.3 — this session does not re-seek that authorization, only re-verifies the facts it depended on. The resulting slot choice remains revisitable through a future migration per ADR-ARCH-102 §1.4: this session does not treat the allocation as permanent.

**Preparation performed by the agent before the session:**

- produce a step-by-step checklist using the selected provider's current UI terminology;
- list every secret and permission with its exact purpose, per the ADR-ARCH-102 §7 role/secret inventory;
- provide validation actions after each group;
- identify which values are safe to expose to the static app and which are publisher/admin only;
- prepare migrations and workflows so configuration can be tested immediately;
- prepare the manual-trigger workflows (`workflow_dispatch`) for authoring, candidate/review, publication and rollback runs (ADR-ARCH-102 §8) so they can be exercised in this session;
- include a recovery/export check before leaving the session.

**Expected user actions in the single session:**

- create the Supabase Free project in the London region (subject to the re-check above);
- create only the Stage-1 database roles from ADR-ARCH-102 §7 — migration/admin (never stored in GitHub Actions), authoring, publisher, and read-only backup/export if the Stage-1 recovery implementation needs it; no Stage-2 role is created;
- add repository secrets (database connection, publisher, Cloudflare deploy token, artifact-storage config); GitHub Environments are **not** configured, since repository secrets plus manual `workflow_dispatch` are the Stage-1 production gate (ADR-ARCH-102 §1.6, §3);
- configure the Cloudflare Workers development and production static-hosting/publication targets;
- configure or approve the guarded one-repository deployment route;
- confirm backup/export capability and the database health-preflight/resume behaviour (ADR-ARCH-102 §10.2);
- approve required workflow permissions, including the production-deployment concurrency group;
- exercise each manual-trigger workflow at least once in a safe (report-only / non-production) mode;
- retain the existing live-repository token (`LIVE_REPO_PAT`) until the ARCH-112 fallback retirement.

**Reserved for later:**

- an evidence-provider credential cannot be supplied until the Stage 2 gate identifies a provider; no Stage-2 database role (evidence ingester, maintenance analyst, deterministic applier) is created in this session;
- Stage 1 should nevertheless reserve the environment/secret naming convention so later setup is a single value addition, not new infrastructure.

**Acceptance:**

- harmless read-only connection tests succeed;
- publisher credentials cannot perform admin/schema operations;
- public/app configuration contains no privileged secret;
- a database export or documented recovery check succeeds;
- each manual-trigger workflow (authoring, candidate/review, publication, rollback) runs successfully in a safe mode;
- no production cutover occurs.

**Rollback:** Remove newly added secrets or disable new workflows; existing application remains unchanged.

**Depends on:** ARCH-102 (complete) and prepared implementation from ARCH-105/ARCH-108 far enough to validate connections. The session occurs once those packages are ready, not at the beginning of Stage 1.

---

### ARCH-105 — Core database schema and permissions

**Purpose:** Implement the provider-neutral schema defined by the target architecture.

**Completion evidence (2026-09-21):**

- Two ordered migrations under `supabase/migrations/` create the private `gac` schema, its lifecycle enums, 21 relational tables, referential/uniqueness/lifecycle constraints, foreign-key indexes, row-level security and non-`SECURITY DEFINER` validation triggers.
- Matching reverse-order scripts under `supabase/rollbacks/` remove Stage-1 permission objects before dropping the unconnected schema and migration-owner role.
- The schema covers canonical units/archetypes/profiles/members, matchups and accepted values, human authoring, generic evidence/mapping/assessment/finding/run records, board/scoring configuration, immutable release/provenance records, the `READY`/`DEPLOYED` lifecycle, base-release references and singleton publication state.
- `gac_migration_admin`, `gac_authoring` and `gac_publisher` are non-login, non-superuser, non-RLS-bypass group roles with narrow grants. `anon` and `authenticated` have no access to the private schema. No backup role is needed under the accepted Stage-1 reconstruction model, and no Stage-2 role is created.
- `tests/database-schema.test.js` applies the migrations to disposable PostgreSQL, proves role boundaries and negative writes, exercises stable-identity/uniqueness/lifecycle constraints, audits foreign-key indexes and absence of `SECURITY DEFINER`, runs both rollback scripts, and reapplies from empty. No hosted database or external service is contacted.
- Operational details and the role matrix are recorded in [`docs/database/ARCH-105.md`](database/ARCH-105.md).

**Status: Complete.** Hosted connection/configuration remains ARCH-104; migration loading and captured-anomaly reconciliation remain ARCH-106.

**Schema areas:**

- units;
- team archetypes, profiles and members;
- matchups;
- accepted matchup and defence catalogue values;
- human authoring changes;
- generic evidence, mapping, assessment, finding and run tables;
- board and scoring configuration;
- releases, provenance and current state;
- lifecycle enums, uniqueness and referential constraints;
- authority states;
- publication lock/base-release fields.

**Permission boundaries — Stage-1 roles created and granted now** (per [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §7):

- migration/admin (schema only; used manually, never stored as a GitHub Actions secret);
- authoring loader;
- publisher;
- read-only backup/export — only if the eventual Stage-1 recovery implementation actually needs it.

**Reserved, not created in Stage 1:** evidence ingester, maintenance analyst and deterministic-applier roles belong to Stage 2. The schema may define the tables these roles will eventually touch (evidence, mapping, assessment, finding, run tables), but no login role or credential for them exists until Stage 2 provisions it. This is a deliberate incremental-roles decision, not an oversight to fix later.

The live PWA receives no database credential.

**Implementation rules:**

- use ordered, reversible migrations;
- avoid provider-specific SQL where ordinary Postgres works;
- do not add provider-shaped evidence metrics before the Stage 2 source contract exists;
- include schema tests for uniqueness, forbidden writes and lifecycle rules;
- seed no speculative catalogue data;
- if any `SECURITY DEFINER` function is used, it must satisfy every control in [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §9.1: non-exposed schema, fixed safe `search_path`, `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`, granted only to the intended role, internal validation of the requested operation, no unparameterised dynamic SQL, and negative permission tests.

**Acceptance:**

- migrations apply from an empty database;
- migrations are repeatable/idempotent where required;
- rollback or restore procedure is demonstrated in a disposable environment;
- permissions prove each Stage-1 role can perform only its intended operations;
- no Stage-2 role (evidence ingester, maintenance analyst, deterministic applier) exists as a login credential;
- any retained `SECURITY DEFINER` function has negative permission tests proving other roles cannot execute it or write the tables it protects directly.

**Rollback:** Restore the pre-migration database or recreate from ordered migrations. No app uses it yet.

**Depends on:** ARCH-102 (complete). Connection verification uses ARCH-104.

---

### ARCH-106 — Migration loader and reconciliation

**Purpose:** Transform the captured Sheet data into the canonical schema without changing public identity.

**Required transformations:**

- preserve `Character_ID` as `unit_id`;
- preserve every attack `Counter_ID` as `archetype_code`;
- create unified archetypes for attack/defence identities;
- use `ANY` attack profiles for currently mode-shared squad compositions;
- create mode-specific defence profiles and `members_complete` state;
- migrate matchups, tiers, banner scores, undersize and tactical notes;
- migrate threat and defence notes;
- mark migrated judgements `AUTHORED_BASELINE` unless explicitly locked;
- migrate board configuration and scoring;
- create the legacy-migration authoring/provenance record;
- report all duplicate, ambiguous and unresolved mappings.

**Non-negotiable compatibility:**

- public names and mode strings remain byte-identical;
- no automatic tidy-up or rename occurs during migration;
- no unresolved row is guessed;
- no note is dropped;
- no required-unit external-ID coverage is reduced.

**Acceptance:**

- repeated loading is idempotent;
- row/entity counts reconcile to ARCH-103;
- every discrepancy has a written resolution;
- all duplicate identity decisions are explicit;
- the database can generate the current catalogue semantics.

**Completion evidence (2026-09-21):**

- Starting `main` SHA `9a5f37a7ecbf7dfcac0b85f79e616e96a6924477`; candidate commit `30021c06df7f385f08fac5137867c4fc74dfe556` and its remediation commit on the dedicated branch.
- Loader, reconciliation, compatibility verification, tests and record: `data/migration/arch-106-decisions.json`, `data/migration/arch-106-reconciliation.{json,md}`, `scripts/migration-lib.js`, `scripts/migration-load.js`, `scripts/migration-reconcile.js`, `scripts/migration-verify.js`, `tests/migration-loader.test.js`, `tests/migration-fixture.js` and [`docs/database/ARCH-106.md`](database/ARCH-106.md).
- Commands `migrate:reconcile`, `migrate:load` and `migrate:verify` run against the committed baseline and a disposable PGlite database, with no override, flag or environment variable that bypasses a decision or a constraint. No hosted service, credential or Docker is involved, and the ARCH-103 capture is only read.
- All nine captured and discovered anomalies have an explicit committed outcome. Six follow deterministic ARCH-106 rules: the 33 defence-only identities, the synthesized `MAZ_KANATA` definition, the eight `Any` modes, the absent `Defence_Composition`, the retirement of `Score_Meanings`, and the order-insensitive `scoring` comparison.
- Three were conflicts between the ARCH-103 baseline and the ARCH-105 schema; the owner accepted all three recommended resolutions. The duplicate `3v3 | Grand Inquisitor | TRAYA` collapses to one matchup retaining its sole authored note `Strong`, with both source rows recorded in provenance. `TIE_ADVANCED_x1` is preserved byte-for-byte. All three mirror matchups load with one archetype in both roles and no fabricated defence-only identity.
- Two ordered follow-up migrations owned by ARCH-106 correct the ARCH-105 schema, each with a non-destructive rollback that refuses rather than delete data: `supabase/migrations/20260921113000_arch_106_unit_id_format.sql` widens `units_unit_id_format` to `^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$`, and `supabase/migrations/20260921113010_arch_106_mirror_matchups.sql` removes `matchups_distinct_archetypes` while keeping `matchups_unique_relationship`. The already-integrated ARCH-105 migrations are unchanged.
- Final canonical counts: 312 units; 90 archetypes (57 attack, 33 defence-only); 169 profiles (57 attack, 112 defence); 70 profile members; 365 matchups and 365 catalogue-value rows; 9 defence value rows; 40 board rows; 16 scoring rows; 1 authoring record. 366 `Counters` rows map to 365 matchups, the single difference being the approved duplicate collapse. Zero dropped source rows, zero silently dropped notes, zero required members without an `external_id`, zero fuzzy mappings.
- Repeated loading is a no-op: the second load inserts nothing, moves no surrogate key, touches no `updated_at` and creates no duplicate provenance row. Two independently created databases hold identical business identities and project an identical payload.
- Compatibility verification passes with zero unexplained differences and two declared deltas: the approved duplicate collapse and the order-insensitive `scoring` comparison. Public counter IDs, defence display names, notes, board order, scoring values and required-member external-ID coverage are all preserved.
- Validation: `npm run check`, `npm test`, `npm run db:test`, `npm run baseline:verify`, `npm run migrate:reconcile`, `npm run migrate:load`, `npm run migrate:load -- --twice`, `npm run migrate:verify`, forward/rollback/reapply exercises including both follow-up migrations, safe rollback-failure exercises with incompatible data, `npm audit --audit-level=high`, `git diff --check`, ARCH-103 fixture hash verification, and secret/credential/ally-code/roster/absolute-path scans.
- No external service was contacted or modified: no Google Sheet, Apps Script deployment, hosted Supabase project, Cloudflare target, GitHub setting or secret, and no deployment.
- **Control-thread independent re-verification (2026-09-21):** ARCH-106 involves schema/constraint amendments and identity-mapping rules, so it received full independent verification under principle 17 rather than the lighter package 9/16 gate. From a clean checkout of the branch (`0778fad`, dependencies freshly installed), the control thread independently reran `npm run check`, `npm test` (88/88 passing), `npm run migrate:reconcile` (READY, 0 blockers), `npm run migrate:verify` (PASSED, 0 unexplained differences, exactly the 2 declared deltas) and `npm run migrate:load -- --twice` (0 rows inserted on the second load), and checked every plan acceptance criterion and non-negotiable compatibility rule above against the generated reports by hand. Merged into `main` as a merge commit after tests passed on the merged tree.

**Status: Complete.** Every acceptance criterion passed and independently reconfirmed. ARCH-104, ARCH-107 and ARCH-108 remain unstarted.

**Rollback:** Drop/recreate the unconnected database and rerun. Sheet remains authoritative.

**Depends on:** ARCH-103 and ARCH-105.

---

### ARCH-107 — Human authoring and manual release path

**Purpose:** Ensure routine maintenance remains easier than direct database editing.

**Completion evidence (2026-09-21):**

- Starting `main` SHA `978dfcb0c9a6bbc2375620b09a5119c38ba8d245`, confirmed as the tip of `origin/main` before any edit. Delivered on a branch, as ARCH-105 and ARCH-106 were.
- Files added: `scripts/authoring-lib.js`, `scripts/authoring-validate.js`, `scripts/authoring-dry-run.js`, `scripts/authoring-load.js`, `tests/authoring-loader.test.js`, `data/authoring/arch-107-example-counter.change.json`, `data/authoring/arch-107-example-counter-revert.change.json` and [`docs/database/ARCH-107.md`](database/ARCH-107.md). Files changed: `package.json` (three `author:*` commands; `db:test` extended) and `docs/database/ARCH-106.md` (its forward-looking note said ARCH-107 would use YAML).
- No migration, schema object, constraint, permission, role or policy was added or changed. The ARCH-105 and ARCH-106 migrations and rollbacks are byte-identical, and a test asserts every `gac` table, constraint, policy, grant and role is unchanged by an apply.
- **Change-file format: JSON**, not the YAML the ARCH-106 document anticipated. Every machine-readable data file in the repository is already JSON, Node parses it natively, and the project pins exactly one dependency. The cost — no comments in a change file — is accepted and recorded.
- Commands `author:validate`, `author:dry-run` and `author:apply` run against a disposable in-memory PGlite database, or a persistent local one with `--data-dir`. There is no override, flag or environment variable that bypasses a validation rule, a lock or the base-release check.
- Supported operations: `create`/`update`/`retire` for units, archetypes, profiles and matchups, and `create`/`update` for members and defence catalogue values. Matchup catalogue values ride on the matchup operations, which are one-to-one with them. `gac_board_config` and `gac_scoring_rules` are deliberately out of scope as application configuration.
- Validation reuses the ARCH-106 identity vocabulary (`SOURCE_MODE_TO_CANONICAL`, `canonicalMode`, `UNIT_ID_PATTERN`, `ARCHETYPE_CODE_PATTERN`) rather than restating it, and takes mode-aware banner and undersize ceilings from [`SCORING_REFERENCE.md`](SCORING_REFERENCE.md) (57/65/73 and 2/4/5). Every migrated value satisfies those bounds.
- The dry run applies the change inside the transaction and rolls back, so the reported diff is the change's real effect rather than a prediction. It reports the canonical row diff column by column and the payload diff path by path, and a test asserts the database and payload are byte-identical before and after.
- `AUTHORED_LOCKED` protection is enforced per field and per declared `authorRole`: the maintenance role cannot change a locked value or its authority, and the owner must set `acknowledgeLocked` on the operation. **This boundary is loader-enforced, not database-enforced**, because both roles run as `gac_authoring` and ARCH-105 deliberately created no separate maintenance role; the limitation is documented rather than worked around.
- Validation: `npm run check` (clean), `npm test` (117/117 passing, 29 of them new), `npm run db:test` (68/68 passing), `npm run baseline:verify`, `npm run migrate:reconcile`, `npm run migrate:load -- --twice`, `npm run migrate:verify` (PASSED, 0 unexplained differences, the same 2 declared deltas), `npm run author:validate`, `npm run author:dry-run` and `npm run author:apply -- --twice` (6 writes then 0), plus a three-process `--data-dir` exercise applying the example, its reversal, and a refused replay.
- The 29 package tests cover every acceptance criterion below, plus: unknown fields rejected rather than ignored, a create that disagrees with stored state refused rather than merged, a stable change ID refused for different content, an applied change refused when a later change superseded it, mode/battle-type incompatibility, required-member `external_id` coverage, every update and retire write path, the non-data statement guard, an unchanged schema and release lifecycle, and a full rollback on a database-level rejection.
- No hosted service, credential or secret was touched: no Supabase project, Cloudflare target, GitHub setting or secret, no Google Sheet, no Apps Script deployment and no deployment of any kind. The ARCH-103 capture and the ARCH-106 decision file are only read.
- **Open question for the control thread.** A profile member cannot be removed: `gac_authoring` holds no `DELETE` grant on `gac.team_profile_members` and the table has no lifecycle column. `member.retire` is refused with an explicit message rather than worked around. Resolving it needs either an additive migration granting that `DELETE`, or a lifecycle column — both are ARCH-105 permission-boundary changes and were not taken unilaterally. `gac.defence_catalogue_values` has the same shape.
- **Handoff to ARCH-108.** ARCH-106's compatibility projection does not filter retired archetypes or profiles, so a retired attack identity still projects into `counterDefinitions`. Retiring a matchup does remove the counter from `counters`. ARCH-108's generator must filter retired rows; a test asserts the current behaviour so it cannot be forgotten.
- Operational details, the change-file schema, the authoring workflow and the full limitation list are recorded in [`docs/database/ARCH-107.md`](database/ARCH-107.md).

**Status: Complete — local implementation accepted and merged; operational publication proof remains part of ARCH-108's full verification.** Merged into `main` at `d2685a9` via pull request #14 (merge commit `2553d0a71af8bb51393f4d489b744b1baf26c809`). Every acceptance criterion below is implemented and covered by a test, except `create AUTHORING candidates through the normal publisher`, which cannot be demonstrated until ARCH-108 exists and is excluded by design (see **Operationally proven only alongside ARCH-108**). `docs/SPEC.md` is unchanged because no shipped application behaviour changed.

**Repository work:**

- define a concise validated change-file schema;
- implement an idempotent loader;
- support create/update/retire operations required by the current catalogue;
- support `AUTHORED_LOCKED` and `AUTHORED_BASELINE`;
- validate identifiers, membership, modes, scores, notes and expected base release;
- record applied author, reason and change ID;
- provide dry-run output and a human-readable proposed diff;
- create `AUTHORING` candidates through the normal publisher;
- document the agent-assisted authoring workflow.

**Acceptance:**

- an agent can prepare a one-counter change without SQL;
- dry run shows exact canonical and payload effects;
- applying the same change twice does not duplicate data;
- an invalid unit ID, duplicate matchup, out-of-range score or stale base release is rejected;
- locked values cannot be changed by the maintenance role;
- one reversible test authoring change produces a valid development candidate.

**Verification approach:** Local-only and git-revertible (change-file schema, loader, validator, dry-run diff against a disposable database) — package tests, CI and a scope/diff review are sufficient to land it, per principle 16. It does not receive its own full independent verification cycle.

**Operationally proven only alongside ARCH-108:** ARCH-107 may be implemented and merged before ARCH-108 exists, but its "create `AUTHORING` candidates through the normal publisher" acceptance bullet cannot be demonstrated until ARCH-108's publisher exists. ARCH-107 is therefore not considered operationally proven, and its acceptance criteria are not signed off, until ARCH-108 demonstrates an authored change becoming a validated candidate/release through the normal publisher. The two packages share one full independent verification pass, run at ARCH-108 completion, covering both.

**Rollback:** Reject the candidate or create a compensating reviewed authoring change. No live pointer moves.

**Depends on:** ARCH-105 and ARCH-106. Not operationally proven until ARCH-108 (see Verification approach above).

---

### ARCH-108 — Catalogue generator, validator and publisher

**Status: Implementation ready for ARCH-104 and connected verification.** Phase A implements the generator, validators, lifecycle amendment, immutable artifact/pointer builder, locked two-transaction publication protocol, adapters, HTTP verification, reconciliation, compatible rollback, manual-only workflow and command entry points. Local PGlite and simulated static-deployment evidence is recorded in [`docs/database/ARCH-108.md`](database/ARCH-108.md). It includes the ARCH-107 example/reversal integration proof, but does not claim real Cloudflare, connected Supabase, independent-session contention or production-workflow overlap. Those Phase-B items remain mandatory after ARCH-104, so ARCH-108 is not Complete and ARCH-107 is not yet operationally signed off.

**Purpose:** Generate immutable app-compatible artifacts safely, and implement the revised distributed publication protocol across the database and Cloudflare Workers.

**Components:**

- payload generator matching the golden contract, at payload schema version 1 ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §6);
- schema-versioned additive provenance;
- structural and product-contract validators;
- transaction-scoped publication lock;
- base-release comparison;
- monotonic version allocation;
- an added `READY` release status (alongside `CANDIDATE`/`PUBLISHED`/`SUPERSEDED`/`REJECTED`), immutable release record and checksum, per the [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.1 protocol: a first short transaction records the release `READY` without moving `current_release_id`; the artifact and pointer are then deployed to Cloudflare Workers as one version; the deployment is verified over HTTP (pointer, artifact, payload schema version, catalogue version, checksum); only then does a second short transaction mark the release `DEPLOYED` and move `current_release_id`;
- the deployed commit SHA and Cloudflare version/deployment identifier recorded on the release row;
- a **reconciliation command** implementing [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.2's recovery table for every named failure window (Cloudflare deployment failure, HTTP verification failure, database finalization failure);
- a GitHub Actions **concurrency group** on the production deployment workflow so two production deployments cannot run simultaneously;
- compatible rollback command implementing [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §5;
- explicit `MIGRATION`, `AUTHORING`, `MAINTENANCE` and `APPROVED_OVERRIDE` reasons.

**Product validations include:**

- exact app mode keys;
- one valid `SETTING_DEFENCE` rule;
- territory order/type/count;
- scoring and undersize limits;
- external-ID coverage;
- stable counter and defence keys;
- valid zero-counter defence handling;
- provenance for assessed values;
- compatibility with persisted state.

**Acceptance:**

- golden payload parity passes, excluding documented additive metadata/order;
- two concurrent publishers cannot lose one another's changes;
- the production-deployment concurrency group prevents two simultaneous production deployment runs, demonstrated with a forced overlap;
- stale-base publication is rejected;
- invalid candidate publishes nothing;
- a forced Cloudflare deployment failure leaves the release `READY` (not `DEPLOYED`) and the previous static Worker version live;
- a forced HTTP-verification failure after a successful Cloudflare deployment leaves the database release `READY`, not finalized;
- a forced database-finalization failure after successful HTTP verification is resolved by the reconciliation command, either finalizing the matching `READY` release or rolling the static pointer back;
- the reconciliation command and the deployment step are both demonstrated idempotent under repeated invocation;
- rollback selects only a compatible payload schema;
- previous artifacts remain available.

**Verification approach:** Full independent verification under principle 17 — this package implements the publication, concurrency, rollback and distributed-state logic that principle 17 names explicitly. Its verification pass also signs off ARCH-107's acceptance criteria (see ARCH-107's "Operationally proven only alongside ARCH-108" note).

**Rollback:** Repoint to the previous compatible release, per [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §5. Database history remains intact.

**Depends on:** ARCH-105, ARCH-106 and the platform decisions from ARCH-102 (complete). ARCH-107 consumes it.

---

### ARCH-109 — PWA catalogue cache and split endpoints

**Purpose:** Make the live-round application genuinely cache-first while retaining the roster proxy.

**Changes expected in current files:**

- `app.js`:
  - replace the single `API_URL` with separate catalogue and roster-proxy configuration; the catalogue URL points at the Cloudflare Worker's current-version pointer, per [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4;
  - add a versioned catalogue cache key;
  - validate HTTP status, schema version and required payload fields;
  - render the cached known-good catalogue first;
  - refresh in the background;
  - preserve cache on invalid/failed responses;
  - make incompatibility understandable without discarding usable data;
  - retain existing roster behaviour and timeout;
- `service-worker.js`:
  - make cache lifecycle explicit;
  - remove obsolete shell caches;
  - avoid trapping catalogue versions incorrectly;
  - preserve offline shell startup;
- tests:
  - cached cold start;
  - successful refresh;
  - failed refresh;
  - invalid response;
  - incompatible payload version;
  - roster endpoint remains separate;
  - active round and persisted identity remain intact.

**Must not:**

- redesign the interface;
- change counter/allocation/scoring behaviour;
- move roster calls into the database platform;
- delete compatibility with current localStorage state.

**Acceptance:**

- an offline cold launch after one successful sync reaches a usable round;
- a network failure never replaces a good catalogue;
- a bad 200 response is rejected;
- roster import still uses Apps Script;
- current test suite and new cache tests pass.

**Verification approach:** Local-only and git-revertible (client-side cache/fetch logic, no cloud or production impact) — package tests, CI and a scope/diff review are sufficient to land it, per principle 16. Its offline/cold-start and cache-invalidation behaviour is independently re-exercised as part of ARCH-110's integrated rehearsal (items 9–10) rather than in a separate verification pass here.

**Rollback:** Restore the Apps Script catalogue URL. Existing `action=data` remains live.

**Depends on:** ARCH-108 for the final contract. Test scaffolding may start earlier.

---

### ARCH-110 — Development reconciliation and failure rehearsal

**Purpose:** Prove the integrated Stage 1 system before production or repository consolidation.

**Required exercises:**

1. golden-payload parity;
2. entity-count reconciliation;
3. counter-ID and defence-name preservation;
4. fixture-roster availability equivalence;
5. defence snapshot completeness/unresolved behaviour;
6. board and scoring equivalence;
7. zero-counter defence behaviour;
8. human authoring dry run and candidate generation;
9. offline cold launch;
10. invalid-payload rejection;
11. simultaneous publication;
12. stale-base rejection;
13. artifact-write failure;
14. pointer-write failure;
15. database unavailable while the PWA continues from static/cache;
16. rollback to a prior artifact;
17. rollback to Sheet-backed `action=data`;
18. production-deployment concurrency: a forced overlapping production deployment run is serialised (not lost or corrupted) by the GitHub Actions concurrency group ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.2);
19. reconciliation after each named distributed-publication failure window — Cloudflare deployment failure, HTTP verification failure, and database finalization failure — each resolved correctly and idempotently by the reconciliation command ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.1–§4.2);
20. database health preflight and safe stop: a maintenance operation run against a paused/unavailable Supabase project reports the exact owner action needed to resume it, and the same logical run resumes idempotently afterward ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §10.2).

**Deliverable:** A signed-off Stage 1 validation report containing evidence, not just pass/fail claims.

**Verification approach:** Full independent verification — this is Stage 1's integration checkpoint under principle 16, and is where ARCH-107 and ARCH-109 (landed on package tests plus a scope/diff review) receive their independent re-verification, alongside ARCH-108's own full verification.

**Acceptance:** Every mandatory check passes or has an explicit user-approved exception recorded in the architecture.

**Rollback:** No production state has changed.

**Depends on:** ARCH-106 through ARCH-109.

---

### ARCH-111 — Guarded one-repository consolidation and Cloudflare origin preparation

**Purpose:** Reach the desired single-source repository model without weakening the current public boundary, and implement and test the client-state export/import required by the production-origin change (GitHub Pages → Cloudflare Workers, [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.2, `TARGET_ARCHITECTURE.md` §15.0).

**Preconditions:**

- CI is green;
- development reconciliation is complete;
- fail-closed artifact generation exists;
- secrets and personal identifiers are excluded;
- the current live repository remains recoverable.

**Required behaviour:**

- `main` remains the authoritative source;
- only a generated/allow-listed public artifact is deployed;
- internal docs, migrations, tests, evidence and change files cannot be published accidentally;
- production deployment is explicit, uses a tested commit/artifact, and is gated by repository secrets plus manual `workflow_dispatch` rather than a GitHub Environment ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.6);
- environment configuration remains external;
- **the live URL changes deliberately, not incidentally**: client-state export is implemented and tested on the old (GitHub Pages) origin, and client-state import is implemented and tested on the new (Cloudflare Workers) origin, per `TARGET_ARCHITECTURE.md` §15.0 steps 1–2; the actual cutover (steps 3–8) remains ARCH-112's;
- the old live repository and its GitHub Pages deployment remain available, unmodified, until the ARCH-112 exit gate — never retired as a side effect of this package.

**Acceptance:**

- a deliberately added private test file is excluded from the public artifact;
- public artifact contents match the allow-list;
- deployment can be reproduced from a known commit;
- client-state export on the old origin and import on the new origin are each demonstrated round-trip correct for roster, boards, templates, used counters and preferences;
- rollback to the former live repository is documented and tested.

**Rollback:** Re-enable the current `deploy-to-live.yaml` path and public repository.

**Depends on:** ARCH-101, ARCH-102 (complete) and ARCH-110.

---

### ARCH-112 — Production cutover and fallback window

**Purpose:** Switch production only after explicit approval. This package performs the origin change itself (`TARGET_ARCHITECTURE.md` §15.0 steps 3–8), building on the export/import capability ARCH-111 built and tested.

**Pre-cutover evidence:**

- Stage 1 validation report approved;
- database backup/export current;
- migration and artifact hashes recorded;
- prior live commit and Apps Script URL recorded;
- rollback rehearsed;
- no unresolved Critical/Major migration finding;
- production artifact reviewed.

**Cutover:**

1. freeze Sheet authoring briefly;
2. rerun export/reconciliation for changes since ARCH-103;
3. apply the final idempotent delta;
4. export client state from the old (GitHub Pages) origin;
5. publish the production static catalogue and deploy the new Cloudflare Workers origin, verified per the [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.1 protocol (candidate → `READY` → deploy → HTTP-verify → `DEPLOYED`);
6. import client state and re-import the roster by ally code on the new origin;
7. confirm boards, templates, used counters, preferences and offline behaviour on the new origin;
8. confirm roster import;
9. confirm active/saved board compatibility;
10. confirm offline reload;
11. start the one-complete-GAC-event fallback window.

**During fallback:**

- the old GitHub Pages origin, the Sheet and Apps Script `action=data` all remain intact and unmodified;
- new canonical authoring occurs only through the target path;
- emergency rollback may restore the old catalogue URL and/or the old origin entirely;
- no evidence automation begins.

**Stage 1 exit gate:**

- one complete GAC event succeeds on production;
- the owner has completed at least one real authoring change without SQL;
- no catalogue/roster/offline regression remains;
- only at this gate are the old GitHub Pages deployment and `LIVE_REPO_PAT` retired, per `TARGET_ARCHITECTURE.md` §15.0 step 8;
- rollback is still available;
- only then may `action=data` be retired and the Sheet archived.

**Depends on:** ARCH-110 and ARCH-111, or an approved consolidation exception.

---

## 6. Stage 1 dependency summary

| Work package | Depends on | Can overlap |
|---|---|---|
| ARCH-101 | — | — |
| ARCH-102 | ARCH-101 | ARCH-103 |
| ARCH-103 | ARCH-101 | ARCH-102 |
| ARCH-104 | ARCH-102 (complete) plus prepared connection code | Scheduled once, validates ARCH-105/108 |
| ARCH-105 | ARCH-102 (complete) | Migration-tool preparation |
| ARCH-106 | ARCH-103, ARCH-105 | ARCH-107 design |
| ARCH-107 | ARCH-105, ARCH-106, ARCH-108 | Documentation/tests |
| ARCH-108 | ARCH-102, ARCH-105, ARCH-106 | ARCH-109 scaffolding |
| ARCH-109 | ARCH-108 contract | ARCH-107 |
| ARCH-110 | ARCH-106–109 | — |
| ARCH-111 | ARCH-101/102/110 | — |
| ARCH-112 | ARCH-110/111 or approved exception | — |

Only ARCH-112 may switch production.

---

# Evidence and runner entry gate

## 7. GATE-200 — Source and execution feasibility

This gate occurs after Stage 1 and before Stage 2 implementation commitment. It may be investigated earlier, but it cannot introduce infrastructure or bypass Stage 1 priorities.

**Questions to answer with fresh evidence:**

1. Which provider and exact dataset contain useful GAC matchup observations?
2. Does the provider permit automated retrieval?
3. What authentication and recurring cost are required?
4. Are observations mode-specific?
5. Are exact attack and defence compositions available as stable unit IDs?
6. What sample sizes exist for representative common and uncommon matchups?
7. Are attempt number, units fielded and clean-win semantics available?
8. What rate limits, readiness delay and retention apply?
9. Can the existing CI/scheduled platform run ingestion safely at no new cost?
10. Is AI required for routine mapping, or only ambiguous cases?

**Spike output:**

- one stored raw sample;
- parser feasibility report;
- mapping exercise against a catalogue slice;
- matched/variant/unresolved counts;
- sample-size distribution;
- terms/cost statement;
- recommended runner;
- explicit `GO`, `GO WITH LIMITS` or `STOP AFTER STAGE 1`.

**No-go rule:** If permitted, sufficiently granular and acceptably priced evidence does not exist, do not implement Stages 2 or 3.

---

# Stage 2 — Maintenance engine in report-only mode

## 8. Stage 2 objective

Produce explainable maintenance proposals from real evidence without changing the current catalogue or static pointer.

## 9. Stage 2 work packages

**Verification approach across Stage 2:** These packages are report-only by construction — nothing in ARCH-201–205 can alter the current live catalogue or pointer — so they land on package tests, CI and a scope/diff review per principle 16, without a separate independent verification cycle each. Full independent verification under principle 17 concentrates on ARCH-206 (the first package with any write authority, even to a non-current candidate) and ARCH-207 (the Stage 2 exit gate). A package that unexpectedly touches a credential, external write, or trust boundary escalates immediately per principle 17, regardless of this default.

### ARCH-201 — Provider contract and source adapter

- formalise the provider fields and semantics proven by GATE-200;
- add only the required provider-specific normalisation;
- preserve raw responses and hashes;
- implement idempotent retrieval and rate-limit handling;
- create fixtures with secrets/personal data removed.

**Acceptance:** The same source cycle cannot be ingested twice; parser changes are versioned; malformed data fails closed.

**Depends on:** GATE-200 = `GO` or `GO WITH LIMITS`.

---

### ARCH-202 — Run lifecycle and evidence ingestion

- implement `cycle_key` and per-mode attempts;
- detect evidence readiness without guessing;
- ingest immutable observations under the evidence role;
- record source snapshot and retrieval contract;
- support retry/resume without duplicate logical runs;
- keep Fleet as a peer mode.

**Acceptance:** Forced retries and partial source failures preserve one coherent logical run.

**Depends on:** ARCH-201.

---

### ARCH-203 — Deterministic canonical mapping

- exact ID/signature match first;
- subset → `UNDERSIZED_VARIANT`;
- expansion/flex handling;
- existing-profile similarity rules;
- mechanical confidence bound;
- unresolved observations remain unresolved;
- no archetype creation.

**Acceptance:** Known fixtures map deterministically; undersized teams never become new identities; ambiguous cases remain queued for semantic review.

**Depends on:** ARCH-202.

---

### ARCH-204 — Bounded semantic review

- define the minimal structured input for ambiguous mapping or strategic-distinction assessment;
- ensure retrieved content is treated as untrusted data;
- prevent semantic output from writing canonical tables;
- allow semantic analysis only to lower confidence;
- record model/analyst version and reasoning;
- provide deterministic fallback to `OBSERVE` when unavailable.

**Acceptance:** Disabling the semantic component does not stop ingestion or deterministic findings; no credential or write path is exposed to it.

**Depends on:** ARCH-203. May be omitted if GATE-200 proves deterministic mapping sufficient.

---

### ARCH-205 — Assessments, findings and policy

- calculate provider-supported measures;
- implement initial tier and threat assessment only;
- enforce authority states;
- retain banner/undersize as advisory findings only;
- implement usefulness, hysteresis, staleness, duplicate and anomaly rules;
- version `maintenance/policy.yaml`;
- generate `PUBLISH`, `OBSERVE`, `ESCALATE` and `REJECT` findings.

**Acceptance:** Fixtures cover every decision state and policy boundary; locked values never become applicable changes.

**Depends on:** ARCH-203 and optional ARCH-204.

---

### ARCH-206 — Deterministic applier and non-current candidate

- provide an on-demand report-only entry point so a maintenance review can be run outside the eventual schedule;
- record whether each run was triggered manually or by schedule;
- re-evaluate every `PUBLISH` finding against the checked-in policy;
- record enforced policy version;
- demote failed findings to `OBSERVE` with reason;
- apply permitted mutations only in an isolated candidate context;
- generate and validate a static artifact;
- prevent pointer updates unconditionally in report-only mode;
- produce a concise diff against the current release.

**Acceptance:** A user can manually trigger a report-only run and receive the same candidate and findings that the scheduled path would produce from the same inputs. No Stage 2 code path can update `catalogue_state` or the production pointer, even with an analyst credential.

**Depends on:** ARCH-205 and Stage 1 publisher.

---

### ARCH-207 — Report-only validation period

Run at least two representative completed same-format events.

Review:

- mapping accuracy;
- false new-identity pressure;
- proposed tier/threat changes;
- authority-state behaviour;
- duplicate/staleness findings;
- silent `OBSERVE` behaviour;
- anomaly response;
- source outages;
- reproducibility and provenance;
- user value versus operational noise.

**Stage 2 exit gate:**

- no unexplained canonical mapping error;
- no proposed change bypasses policy;
- findings are useful enough to justify scheduling;
- anomaly tests fail closed;
- all proposals can be reproduced from stored evidence;
- user explicitly approves Stage 3 activation work.

**Rollback:** Disable ingestion. Stage 1 remains unchanged.

---

# Stage 3 — Scheduling and bounded autonomous publication

## 10. Stage 3 objective

Run eligible maintenance cycles unattended, publish only validated changes, and involve the user only for failure or genuine escalation.

## 11. Stage 3 work packages

**Verification approach across Stage 3:** ARCH-301 (scheduling/readiness) and ARCH-303 (reporting/escalation) land on package tests, CI and a scope/diff review per principle 16. Full independent verification under principle 17 concentrates on ARCH-302 (autonomous publication activation — irreversible production effect) and ARCH-304 (the Stage 3 exit gate).

### ARCH-301 — Scheduler and readiness detection

- expose an explicit on-demand trigger as well as the schedule;
- make report-only the safe default for a manual maintenance trigger;
- allow manual publication only through the normal eligible-publication path, never as a validation bypass;
- route scheduled and manual triggers into the same versioned command/function;
- record trigger type, initiator and supplied cycle/mode inputs;
- schedule at the lowest useful cadence;
- detect completed events and source readiness;
- create/resume one logical run;
- prevent overlapping active attempts;
- back off on rate limits and source outages;
- produce no alert for ordinary “not ready” results.

**Acceptance:** Duplicate scheduler triggers create no duplicate run or release. A manual run for the same cycle/mode either resumes the same eligible logical run or is rejected with a clear reason; it never creates a competing publication.

---

### ARCH-302 — Autonomous publication activation

- enable production pointer updates only for eligible `MAINTENANCE` releases;
- retain publication lock and base-release checks;
- refuse anomaly-blocked runs;
- support `APPROVED_OVERRIDE` only through explicit human action;
- preserve authored locks and note authority;
- publish versioned artifact before pointer.

**Acceptance:** A forced mid-publication failure leaves the previous artifact current.

**Depends on:** ARCH-301 and Stage 2 approval.

---

### ARCH-303 — Reporting and escalation

Routine success report:

- cycle/mode;
- evidence volume and mapping rate;
- published changes;
- observed findings count;
- release/version/checksum;
- rollback reference.

Alert only for:

- source or parser failure after retry policy;
- validation or publication failure;
- anomaly stop;
- genuine `ESCALATE` decision.

`OBSERVE` findings remain silent unless explicitly requested.

**Acceptance:** A no-change successful run creates no user task.

---

### ARCH-304 — Operational hardening and activation

Prove:

- retry after interrupted ingestion;
- retry after candidate generation;
- concurrent scheduler trigger;
- source unavailable;
- malformed source;
- semantic component unavailable;
- database unavailable while app remains usable;
- artifact storage unavailable;
- pointer update unavailable;
- rollback to prior compatible release;
- restoration after erroneous but structurally valid release;
- disable switch for all scheduling.

**Stage 3 exit gate:**

- two consecutive unattended eligible cycles complete correctly;
- reporting remains concise;
- failure injection leaves production usable;
- rollback is demonstrated;
- the user approves routine autonomous operation.

**Rollback:** Disable scheduling and repoint to the last human-approved compatible release.

---

## 12. Manual configuration plan

The goal is one substantial session in Stage 1.

| Configuration | Stage 1 session | Later action |
|---|---|---|
| Database project/region | Create Supabase Free (London) and verify, after re-checking cost/limits | None unless provider changes |
| Database roles/credentials | Configure only Stage-1 roles: migration/admin (manual only, never in GitHub Actions), authoring, publisher, and read-only backup/export if needed | Populate Stage-2 evidence/analyst/applier credentials only after GATE-200 |
| Production gate | Repository secrets plus manual `workflow_dispatch`; GitHub Environments are not used (unavailable for a private repo on GitHub Free) | None |
| Repository secrets | Database, publisher, Cloudflare deploy token, artifact storage, roster proxy config | Add provider secret value after GATE-200 |
| Static hosting | Configure Cloudflare Workers development and production publication targets | None |
| Workflow permissions | Configure CI, candidate and explicit production workflows, including the production-deployment concurrency group | Enable scheduled workflow only in Stage 3 |
| Repository consolidation | Configure target route and fallback | Retire old live repo only after ARCH-112 acceptance |
| Backup/recovery | Verify export, documented restore, and the database health preflight/resume behaviour | Periodic verification through automation where possible |

If provider UI or account restrictions force another substantial manual setup later, stop and present the reason before expanding the programme.

---

## 13. Manual and on-demand operations

Two separate on-demand paths are required.

### 13.1 Human authoring

The owner or control chat can initiate an authoring run at any time:

1. prepare a validated change file;
2. run a dry run;
3. inspect the canonical and payload diff;
4. apply the change through the authoring loader;
5. generate and validate an `AUTHORING` candidate;
6. publish only after the normal publication gates pass.

Human authoring is independent of the maintenance schedule.

### 13.2 Maintenance review

The owner or control chat can trigger a maintenance review outside the schedule.

The trigger must accept only bounded, validated inputs such as mode, cycle key and report-only/publication intent. Report-only is the default. It uses the same ingestion, mapping, assessment, policy, anomaly and validation code as a scheduled run.

A manual trigger:

- does not lower evidence thresholds;
- does not bypass an anomaly;
- does not override `AUTHORED_LOCKED` values;
- does not write the production pointer unless it is explicitly a publication run and every ordinary gate passes;
- records who/what triggered it;
- remains idempotent for the same cycle and mode.

This capability is required in Stage 2 for report-only analysis and retained in Stage 3 after scheduling is enabled.

---

## 14. Control-chat operating model

This conversation is the programme control thread.

The control thread owns:

- current work-package selection and status;
- architectural and product decisions;
- dependency and acceptance-gate checks;
- manual-configuration guidance;
- review of breakout results against fresh repository evidence;
- the next self-contained handoff prompt;
- decisions to pause, rollback, cut over or activate autonomy.

### 14.1 Coding breakouts

Each coding session receives a self-contained prompt for one work package or an explicitly bounded part of one.

Every coding prompt must include:

- repository and branch;
- a recommended coding-agent reasoning effort level, with a one-sentence justification;
- requirement to report the fresh full `main` SHA;
- instruction to read `AGENTS.md`, this plan and all task-relevant authorities;
- objective, deliverables and precise exclusions;
- current dependencies and prerequisite evidence;
- expected files or components to inspect without assuming their contents;
- tests and acceptance criteria;
- documentation-update rules;
- the branch and pull-request workflow in `AGENTS.md`;
- an explicit prohibition on production deployment unless that work package authorises it;
- required final report: resulting SHA, files changed, tests run, validation evidence, decisions and blockers.

The control thread also states the recommended effort level outside the prompt when handing it to the user, so the setting is visible before the breakout begins.

After a breakout returns, the control thread independently refreshes repository evidence before accepting completion or preparing the next task.

### 14.2 Deep-analysis breakouts

Use a read-only analysis breakout when a decision needs substantial research, comparison or failure-mode testing before code is appropriate.

Analysis prompts must:

- state that no repository or external-system changes are authorised;
- identify the exact decision to resolve;
- distinguish fact, inference and recommendation;
- return concrete options, trade-offs and a recommended decision;
- identify time-sensitive facts that require current verification.

### 14.3 Manual steps

Whenever the user must configure GitHub, the database host, static hosting, Apps Script or another external service, the control thread provides:

1. the purpose of the configuration;
2. numbered, click-by-click instructions using current interface labels;
3. the exact value or value pattern to enter;
4. which values are secret and must not be pasted into chat or committed;
5. a verification step after each logical group;
6. an explicit stop point if the displayed options differ;
7. the rollback or removal action where relevant.

Do not distribute avoidable configuration across later stages. Prepare the full Stage 1 checklist before asking the user to begin the concentrated configuration session.

---

## 15. Agent execution protocol

Each work package should be handed to a coding agent separately using a self-contained prompt.

Every prompt must require the agent to:

1. report the fresh full `main` SHA;
2. read `AGENTS.md` and relevant authorities;
3. confirm the work-package scope and exclusions;
4. inspect the current implementation before editing;
5. preserve unrelated user changes;
6. implement only the named package;
7. add or update tests;
8. run the relevant suite;
9. review the diff;
10. update this plan's work-package status and evidence;
11. update `SPEC.md` only when shipped current behaviour changes;
12. update `changelog.md` only when a release actually ships;
13. avoid production deployment unless the package is ARCH-112 or ARCH-302 and explicitly approved.

A work package may be split into smaller coding tasks when needed, but the package acceptance gate remains singular and the split does not create another programme stage.

---

## 16. Status tracking

Use these states:

- `Not started`
- `Ready`
- `In progress`
- `Blocked`
- `Validation`
- `Complete`
- `Abandoned`

Initial status:

| Item | Status |
|---|---|
| ARCH-101 | Complete |
| ARCH-102 | Complete |
| ARCH-103 | Complete |
| ARCH-104 | Not started |
| ARCH-105 | Complete |
| ARCH-106 | Complete |
| ARCH-107 | Complete |
| ARCH-108 | Not started |
| ARCH-109 | Not started |
| ARCH-110 | Not started |
| ARCH-111 | Not started |
| ARCH-112 | Not started |
| GATE-200 | Not started |
| ARCH-201–207 | Not started |
| ARCH-301–304 | Not started |

Only one implementation work package should normally be `In progress` at a time. Documentation preparation or independent read-only evidence gathering may overlap where the dependency table permits.

---

## 17. Explicit exclusions

This programme does not include:

- redesigning the PWA interface;
- changing allocation, battle-order or scoring objectives;
- per-battle undersize advice;
- rewriting the app in a framework;
- cloud-backed player roster storage;
- replacing Comlink;
- replacing the Apps Script roster proxy without a separate trigger;
- tactical-note generation by AI;
- autonomous banner or undersize publication in the initial engine;
- long-lived Sheet/database dual-write;
- public distribution or multi-user administration;
- adding paid services without an explicit cost decision.

These remain separate roadmap or architectural decisions.

---

## 18. Definition of programme complete

The programme is complete only when:

- Stage 1 has replaced the catalogue runtime and survived its fallback window;
- Stage 2 has validated real evidence in report-only mode;
- Stage 3 has completed two unattended eligible cycles;
- production works from cached static catalogue data without database availability;
- human authoring remains available and documented;
- every autonomous change is reproducible and policy-enforced;
- failures and anomalies do not partially publish;
- rollback is proven;
- routine success creates no user administration;
- current behaviour and release history have been moved into their proper authorities.
