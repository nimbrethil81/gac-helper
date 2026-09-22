# SWGOH GAC Helper — Target Architecture Implementation Plan

**Status:** Parked by owner decision on 2026-09-22. Completed work remains integrated and supported; no further architecture, migration, Cloudflare cutover or automated-maintenance stage is active.

**Original planning baseline:** `main` at `1e6bdc55b4619eccb4a2ca7103a79d0a831476c1`.

**Architecture authority:** [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) v0.5, informed by the accepted platform decisions in [`docs/decisions/ADR-ARCH-102-platform.md`](decisions/ADR-ARCH-102-platform.md) as re-baselined by [`docs/decisions/ADR-ARCH-113-stage1-rebaseline.md`](decisions/ADR-ARCH-113-stage1-rebaseline.md).

**Defined Stage-1 path (parked).** Google Sheets (canonical catalogue and human authoring) → Apps Script `action=data` and `action=roster` → cache-first PWA → Cloudflare Workers development and production delivery. **No active work package requires a hosted database of any provider.** The completed database schema, migration loader, authoring tooling and publisher are preserved as **paused** future-migration assets behind GATE-150 (§7.1). See §5.0 for the parking checkpoint status of each package.

**Scope.** This document defines the ordered delivery plan, dependencies, manual configuration, acceptance gates and rollback points for implementing the target architecture. It does not redefine the architecture and does not describe current shipped behaviour. Current behaviour remains authoritative in [`SPEC.md`](SPEC.md).

**Update this document when** a work package is completed, split, materially re-scoped, blocked or abandoned. Record current status and evidence without turning this document into release history. Shipped behaviour moves into `SPEC.md` and the concise release event goes into `changelog.md`.

## Parking checkpoint — 2026-09-22

This is a deliberate priority change, not a failure or rollback of completed work.

- Parking baseline: `main` at `f07d19e0feeef28427d71c67c8579c7bec1d3815`; CI passed on that commit.
- The existing GitHub Pages application remains the production service. The last recorded successful `Deploy to Live` run used development-repository commit `337782b6165595e87b4937ccc0ff1926462ca157` on 2026-09-20. Later architecture work has not been promoted through that workflow.
- ARCH-109 is complete and integrated on `main`, but its cache-first application changes are not claimed as shipped to the current production origin by this checkpoint.
- ARCH-104 repository preparation is complete. The `gac-helper-dev` Worker record and `https://gac-helper-dev.nimbrethil81.workers.dev` URL exist, the failed automatic Cloudflare build connection was disconnected, and the manual GitHub deployment/rollback workflows are present. No successful connected Worker deployment, production Worker acceptance, rollback rehearsal or production cutover is recorded.
- ARCH-105–ARCH-108 remain completed, tested future-migration assets. No GAC Helper hosted database, database user or database credential was created; ARCH-108 Phase B remains unrun.
- ARCH-110–ARCH-112, GATE-150, GATE-200 and Stages 2–5 are parked. No evidence source, scheduled runner or autonomous catalogue mutation is active.
- Until an explicit restart decision, catalogue maintenance uses the existing operating model: manually initiated, AI-assisted updates to the canonical Google Sheet, served by the unchanged Apps Script API.
- The checked-in future architecture, migrations and automation design are preserved for possible later reuse. They must not be interpreted as an instruction to resume work automatically.

To resume, first obtain fresh repository and service evidence, confirm the GitHub Pages production state, decide whether Cloudflare migration and automated maintenance are still desired, and then explicitly select the relevant parked gate or work package. Do not infer resumption merely from the ordering below.

---

## 1. Delivery principles

1. The programme has exactly **five user-facing stages**. Steady-state autonomous maintenance is the operating state after Stage 5, not a sixth stage.
2. Work packages inside a stage are execution checkpoints, not additional stages.
3. Nearly all GitHub, database and hosting configuration is concentrated into one Stage 1 session.
4. Stage 1 is independently valuable and may remain the final delivered state if useful evidence cannot be obtained.
5. Stage 2 is report-only. It cannot alter the current live catalogue.
6. Stage 3 proves scheduling and bounded autonomous publication only after Stage 2 acceptance; it does not authorise unrestricted catalogue expansion.
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
19. **Discovery volume and publication volume are independent.** Bootstrap discovery may be large, but canonical publication remains evidence-qualified, usefulness-filtered and deliberately bounded.
20. **Curated data is the trusted bootstrap seed.** Automated evidence may challenge an authored baseline, but bootstrap disagreement creates a reviewable proposal rather than a silent overwrite.
21. **Paused is not abandoned.** A completed work package whose operational deployment is deferred keeps its `Complete` status, its evidence, its tests and its CI coverage. It is not reverted, rewritten, downgraded to a draft, or described as failed. Its deferred operational steps are recorded against the gate that will resume them ([ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) §8).

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
| **1. Cache-first catalogue and Cloudflare delivery** | Cache-first PWA catalogue loading against Apps Script, Cloudflare development/production delivery, guarded one-repository consolidation, and a tested production-origin cutover with client-state migration | One concentrated Cloudflare configuration session plus explicit cutover approval | Moves the app to a new origin; the catalogue source is unchanged |
| **2. Maintenance engine, report-only** | Evidence ingestion, mapping, assessments and policy findings tested against real cycles | Evidence-source decision and review of validation results | None; current catalogue cannot change |
| **3. Bounded autonomous publication capability** | Idempotent scheduling, automatic validated publication, concise reporting and recovery proved without unrestricted expansion | Approval to begin controlled bootstrap | Eligible maintenance releases may become current only within the proved bounded path |
| **4. 5v5 bootstrap and calibration** | Broad 5v5 discovery, shadow comparison with curated data and bounded promotion waves | Review and acceptance of the 5v5 bootstrap report | Small evidence-qualified 5v5 batches may become current |
| **5. 3v3 bootstrap and calibration** | Independent 3v3 discovery, calibration and bounded promotion waves | Review and acceptance of the 3v3 bootstrap report | Small evidence-qualified 3v3 batches may become current |

Before Stage 2 there are two gates: **GATE-150** (persistent maintenance-store provider, §7.1) and **GATE-200** (evidence and runner entry, §7). Both are go/no-go checks, not additional build stages, and both must be resolved before Stage 2 implementation begins.

---

# Stage 1 — Cache-first catalogue and Cloudflare delivery

## 4. Stage 1 objective

Make the live application resilient to a catalogue-fetch failure, and move production delivery onto Cloudflare Workers, without changing where the catalogue comes from or how the owner authors it.

At Stage 1 completion:

- Google Sheets remains the canonical catalogue and the owner's authoring workbench, unchanged;
- Apps Script continues to serve both `action=data` and `action=roster`, unchanged;
- the PWA validates the `action=data` payload, caches it, and renders the last known-good catalogue before any network work;
- a refresh failure — offline, timeout, HTTP error, Apps Script failure or an invalid 200 body — retains and renders the cached catalogue instead of an error state;
- the application is served from Cloudflare Workers, with separate development and production deployments;
- production deployment is manual, from a reviewed, merged pull request, and is verified over HTTP afterwards;
- a production deployment can be rolled back to a verified known-good prior version;
- the public artifact remains fail-closed and allow-listed;
- repository consolidation has been completed only if its safety gates pass;
- the owner's browser state has survived the origin change, with the GitHub Pages origin retained as the fallback through the acceptance window;
- no hosted database, database credential, evidence ingestion or autonomous maintenance exists.

## 5. Stage 1 work packages

### 5.0 Package status at the parking checkpoint

[ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) re-baselined the defined Stage-1 path before the programme was parked. No completion history below is changed: ARCH-101, ARCH-102, ARCH-103, ARCH-105, ARCH-106, ARCH-107, ARCH-108 Phase A and ARCH-109 were delivered and verified as recorded.

| Package | Status at the parking checkpoint |
|---|---|
| ARCH-101 Baseline capture and CI | **Complete — active foundation.** CI still guards every change. |
| ARCH-102 Platform decisions and threat model | **Complete.** Partly superseded by ADR-ARCH-113; Cloudflare delivery, the manual gate, manual operation, cache validation principles, client-state precautions and the threat model remain in force. |
| ARCH-103 Migration and golden-contract capture | **Complete — reusable future asset.** The capture also serves as active-path recovery evidence and is still verified by `npm run baseline:verify` in CI. |
| ARCH-104 Manual configuration session | **Repository preparation complete; connected configuration and deployment parked.** |
| ARCH-105 Database schema and permissions | **Complete — paused future-migration asset.** Never applied to a hosted project. |
| ARCH-106 Migration loader and reconciliation | **Complete — paused future-migration asset.** |
| ARCH-107 Human authoring and manual release path | **Complete — paused future-migration asset.** Operational sign-off pauses with ARCH-108 Phase B. |
| ARCH-108 Catalogue generator, validator and publisher | **Phase A complete — paused.** Phase B connected verification moves behind GATE-150. |
| ARCH-109 PWA catalogue cache | **Complete.** Cache-first loading of the Apps Script payload is integrated on `main`; production promotion is not claimed by this checkpoint. |
| ARCH-110 Integration and failure rehearsal | **Parked — not started.** |
| ARCH-111 One-repository consolidation and origin preparation | **Parked — not started.** |
| ARCH-112 Production cutover and fallback window | **Parked — not started.** |
| GATE-150 Persistent maintenance-store decision | **Parked — not entered**, §7.1. |
| GATE-200 Evidence and runner entry gate | **Parked — not entered**, §7.2. |

**Paused means preserved** (delivery principle 21): the migrations, loader, authoring tooling, publisher, their tests, their CI coverage, their documentation and their completion evidence all stay exactly as delivered. No paused package is currently on an active delivery path, and nothing in the future-migration set may be deployed before GATE-150.

**While parked, no work package may create** a Supabase project, a Neon project, any other hosted database, a database user, a database credential or a database workflow.

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

> **Partly superseded.** [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) withdraws this package's database-hosting, static-catalogue-publication and Supabase-configuration decisions. Its Cloudflare delivery decision, manual production gate, mandatory-manual-operation rule, cache validation principles, client-state cutover precautions, threat model and `SECURITY DEFINER` controls all remain in force. The completion evidence below is the factual record of what was decided on 2026-09-21 and is not rewritten; ADR-ARCH-113 §2 lists exactly what it supersedes.

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

### ARCH-104 — Prepared manual-configuration session (Cloudflare only)

**Status: Parked after repository preparation.** PR #20 added the static-asset build, development `noindex` handling, and manual deployment/rollback workflows; PR #21 pinned Wrangler 4.136.1 for least-privilege deployment compatibility. Connected development deployment, production setup, rollback rehearsal and cutover were not completed or accepted. No production cutover occurred.

**Purpose:** ARCH-104 is the **single guided manual configuration session** for Stage 1: the Cloudflare and repository setup the revised path needs, completed in one user session after agents have prepared exact instructions.

**Explicitly out of scope.** This session does **not** create a Supabase project, a Neon project, any other hosted database, a database user, a database role, a database connection secret, a Supabase workflow, or any database-backed publication target. Provisioning a persistent store is GATE-150's, under a separate owner decision. An agent preparing this session must not reintroduce those steps.

**Before any creation step, this session must re-check** — per [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) §11 — current GitHub Free plan-feature limits (Environments, private-repository Pages), Cloudflare Workers' current static-assets and versions/deployments semantics including rollback limitations and retention, Cloudflare's current free-tier request/asset limits for two Workers, and the current recurring cost of the selected tiers. The Supabase-specific re-checks from ADR-ARCH-102 §12 (items 3, 4, 5 and 8) no longer apply. Any material change from the recorded assumptions is reported to the control thread before configuration proceeds, not silently absorbed.

**Preparation performed by the agent before the session:**

- produce a step-by-step checklist using Cloudflare's and GitHub's current UI terminology;
- list every secret and variable with its exact purpose and least-privilege scope;
- provide validation actions after each group;
- identify which values are safe to expose to the static app and which are deploy-only;
- prepare the deployment workflows so configuration can be tested immediately;
- prepare the manual-trigger workflows (`workflow_dispatch`) for development deployment, production deployment and deployment rollback so they can be exercised in this session;
- confirm the existing `publish-catalogue.yml` workflow remains manual-only and unrun, and requires no secret in this session.

**Expected user actions in the single session:**

- create the Cloudflare Workers **development** and **production** deployments for the PWA;
- apply the development Worker's mandatory controls: `noindex`, no credentials, no personal identifiers, preview-not-access-controlled ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.5);
- create a least-scope Cloudflare API token able to deploy only the selected Workers;
- add the repository secrets and variables the deployment workflows need (Cloudflare API token, account ID, Worker names, production base URL); GitHub Environments are **not** configured, since repository secrets plus manual `workflow_dispatch` are the production gate ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.6, §3);
- configure or approve the guarded one-repository deployment route;
- approve required workflow permissions, including a production-deployment concurrency group so two deployment runs cannot overlap;
- exercise the development deployment, the production deployment and the rollback workflow at least once in a safe (non-cutover) mode;
- retain the existing live-repository token (`LIVE_REPO_PAT`) and the GitHub Pages deployment until the ARCH-112 fallback retirement.

**Reserved for later:**

- no database credential of any kind is created here; a persistent-store connection secret is created only after GATE-150 selects a provider;
- an evidence-provider credential cannot be supplied until GATE-200 identifies a provider;
- the secret naming convention may be reserved so later setup is a single value addition, not new infrastructure.

**Acceptance:**

- a development deployment succeeds and the deployed app loads from the development Worker;
- the development Worker returns `noindex` and serves no credential or personal data;
- a production deployment succeeds from a reviewed, merged commit and is verified over HTTP afterwards;
- a deployment rollback returns the production Worker to the prior verified version;
- the deploy token cannot perform account-wide or non-deployment operations;
- public/app configuration contains no privileged secret;
- no database, database credential or database workflow is created;
- no production cutover occurs — the live origin remains GitHub Pages until ARCH-112.

**Rollback:** Remove newly added secrets or disable new workflows; the existing GitHub Pages application remains unchanged and live.

**Depends on:** ARCH-102 (complete) and ADR-ARCH-113. It no longer depends on ARCH-105/ARCH-108 being ready, because no database connection is validated here; it should occur once ARCH-109's deployment needs are understood.

---

### ARCH-105 — Core database schema and permissions

> **Paused future-migration asset.** Delivered and verified as recorded below; its hosted deployment and operationalisation are deferred behind GATE-150 (§7.1) by [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md). It is not on the active Stage-1 critical path, and it is not abandoned, reverted or rewritten. The completion evidence below is unchanged.



**Purpose:** Implement the provider-neutral schema defined by the target architecture.

**Completion evidence (2026-09-21):**

- Two ordered migrations under `supabase/migrations/` create the private `gac` schema, its lifecycle enums, 21 relational tables, referential/uniqueness/lifecycle constraints, foreign-key indexes, row-level security and non-`SECURITY DEFINER` validation triggers.
- Matching reverse-order scripts under `supabase/rollbacks/` remove Stage-1 permission objects before dropping the unconnected schema and migration-owner role.
- The schema covers canonical units/archetypes/profiles/members, matchups and accepted values, human authoring, generic evidence/mapping/assessment/finding/run records, board/scoring configuration, immutable release/provenance records, the `READY`/`DEPLOYED` lifecycle, base-release references and singleton publication state.
- `gac_migration_admin`, `gac_authoring` and `gac_publisher` are non-login, non-superuser, non-RLS-bypass group roles with narrow grants. `anon` and `authenticated` have no access to the private schema. No backup role is needed under the accepted Stage-1 reconstruction model, and no Stage-2 role is created.
- `tests/database-schema.test.js` applies the migrations to disposable PostgreSQL, proves role boundaries and negative writes, exercises stable-identity/uniqueness/lifecycle constraints, audits foreign-key indexes and absence of `SECURITY DEFINER`, runs both rollback scripts, and reapplies from empty. No hosted database or external service is contacted.
- Operational details and the role matrix are recorded in [`docs/database/ARCH-105.md`](database/ARCH-105.md).

**Status: Complete — paused.** Migration loading and captured-anomaly reconciliation were completed by ARCH-106. Hosted connection and configuration are no longer ARCH-104's: they move to GATE-150, which must also select the provider these migrations would be applied to.

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

**Rollback:** Restore the pre-migration database or recreate from ordered migrations. No app uses it, and no hosted database exists.

**Depends on:** ARCH-102 (complete). Connection verification moves to GATE-150 and is no longer ARCH-104's, since ARCH-104 creates no database.

---

### ARCH-106 — Migration loader and reconciliation

> **Paused future-migration asset.** Delivered and verified as recorded below; its hosted deployment and operationalisation are deferred behind GATE-150 (§7.1) by [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md). It is not on the active Stage-1 critical path, and it is not abandoned, reverted or rewritten. The completion evidence below is unchanged.



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

**Status: Complete — paused.** Every acceptance criterion passed and was independently reconfirmed. (ARCH-107 and ARCH-108 Phase A have since been delivered; ARCH-104 is re-scoped and remains unstarted.)

**Rollback:** Drop/recreate the unconnected database and rerun. Sheet remains authoritative.

**Depends on:** ARCH-103 and ARCH-105.

---

### ARCH-107 — Human authoring and manual release path

> **Paused future-migration asset.** Delivered and verified as recorded below; its hosted deployment and operationalisation are deferred behind GATE-150 (§7.1) by [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md). It is not on the active Stage-1 critical path, and it is not abandoned, reverted or rewritten. The completion evidence below is unchanged.



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

**Depends on:** ARCH-105 and ARCH-106. Not operationally proven until ARCH-108's connected verification, which is paused behind GATE-150.

---

### ARCH-108 — Catalogue generator, validator and publisher

> **Paused future-migration asset.** Phase A is delivered as recorded; Phase B (connected verification) is deferred behind GATE-150 (§7.1) by [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md). Nothing below is reverted or rewritten. The checked-in `.github/workflows/publish-catalogue.yml` workflow and the `catalogue:*` commands remain present, manual-only and unrun; they are not part of the active Stage-1 path and must not be run against any production target.

**Status: Phase A complete; Phase B paused.** Phase A implements the generator, validators, lifecycle amendment, immutable artifact/pointer builder, locked two-transaction publication protocol, adapters, HTTP verification, reconciliation, compatible rollback, manual-only workflow and command entry points. Local PGlite and simulated static-deployment evidence is recorded in [`docs/database/ARCH-108.md`](database/ARCH-108.md). It includes the ARCH-107 example/reversal integration proof, but does not claim real Cloudflare, a connected hosted database, independent-session contention or production-workflow overlap. Those Phase-B items remain mandatory before this path is ever deployed, but they are no longer Stage-1 work: they move behind GATE-150, together with the provider decision that determines what they would be verified against. ARCH-107's operational sign-off pauses with them.

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

**Verification approach:** Full independent verification under principle 17 — this package implements the publication, concurrency, rollback and distributed-state logic that principle 17 names explicitly. That pass runs at GATE-150 resumption and also signs off ARCH-107's acceptance criteria (see ARCH-107's "Operationally proven only alongside ARCH-108" note).

**Rollback:** Repoint to the previous compatible release, per [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §5. Database history remains intact.

**Depends on:** ARCH-105, ARCH-106 and the platform decisions from ARCH-102 (complete). ARCH-107 consumes it. Phase B additionally depends on GATE-150.

---

### ARCH-109 — Cache-first catalogue loading

**Status: Complete (ARCH-109).** The PWA now validates and caches the Apps Script `action=data` payload under a versioned localStorage entry containing cache schema, acceptance time and source-contract metadata. It renders a valid known-good cache first, refreshes in the background, and retains that cache through network, HTTP, JSON or contract-validation failures; a first-ever failed launch shows the explicit catalogue-unavailable state without clearing player state. The Apps Script roster route remains separate. The service worker caches only same-origin shell requests and does not intercept the catalogue endpoint. Local verification: `npm run check`, `npm test` (60 passing), `npm run baseline:verify`, and `git diff --check`.

**Purpose:** Make the live-round application genuinely cache-first against the catalogue source it already uses, so a temporary connection failure or an Apps Script failure cannot cost the owner a round.

**The catalogue source does not change.** The PWA keeps fetching `action=data` from the existing Apps Script deployment, and keeps using `action=roster` for roster import. There is no static catalogue pointer, no versioned artifact, no release and no checksum on this path; this package must not introduce one or assume one exists.

**Changes expected in current files:**

- `app.js`:
  - replace the single hard-coded `API_URL` with explicit catalogue and roster-proxy configuration, even though both currently resolve to the same Apps Script deployment, so the two concerns can fail and evolve independently;
  - add a versioned local cache key for the catalogue payload;
  - validate the response before use: HTTP status, JSON parse, and the required top-level fields of the `SPEC.md` §5 contract;
  - persist only a validated payload;
  - render the cached known-good catalogue first, then refresh in the background;
  - preserve the cache on any failed or invalid refresh, and surface staleness unobtrusively rather than as an error state;
  - keep a first-ever launch with no cache and no reachable catalogue understandable and explicit;
  - retain existing roster behaviour and timeout;
- `service-worker.js`:
  - make cache lifecycle explicit;
  - remove obsolete shell caches;
  - avoid trapping a stale catalogue response;
  - preserve offline shell startup;
- tests:
  - cached cold start with no network;
  - successful refresh replaces the cache;
  - failed refresh (offline, timeout, HTTP error) retains and renders the cache;
  - invalid 200 body is rejected and the cache is retained;
  - a payload missing required contract fields is rejected;
  - roster endpoint remains separate and unchanged;
  - an active round and persisted identity survive a refresh failure.

**Must not:**

- redesign the interface;
- change counter/allocation/scoring behaviour;
- introduce a static catalogue artifact, pointer, release or checksum;
- introduce any database or database-backed catalogue path;
- change the Apps Script code, the Sheet, or either route's URL semantics;
- delete compatibility with current `localStorage` state.

**Acceptance:**

- an offline cold launch after one successful sync reaches a usable round;
- a network or Apps Script failure never replaces a good catalogue, and never shows an error screen when a cached catalogue exists;
- a bad 200 response is rejected and the previous catalogue remains in use;
- roster import still uses Apps Script and is unaffected by catalogue failures;
- current test suite and new cache tests pass.

**Verification approach:** Local-only and git-revertible (client-side cache/fetch logic, no cloud or production impact) — package tests, CI and a scope/diff review are sufficient to land it, per principle 16. Its offline/cold-start and cache-invalidation behaviour is independently re-exercised as part of ARCH-110's integrated rehearsal rather than in a separate verification pass here.

**Rollback:** Revert the package. The app returns to its current direct-fetch behaviour against the unchanged `action=data` route.

**Depends on:** ARCH-101. It no longer depends on ARCH-108, because the payload contract is the existing `action=data` contract in `SPEC.md` §5, not a generated artifact.

---

### ARCH-110 — Stage-1 integration and failure rehearsal

**Status: Parked — not started.** Resume only after an explicit owner decision to restart Cloudflare delivery work.

**Purpose:** Prove the integrated revised Stage-1 system — cache behaviour, Apps Script failure fallback, Cloudflare delivery, deployment rollback and cutover readiness — before the production-origin change.

**Required exercises:**

1. **Cold start from cache:** an offline cold launch after one successful sync reaches a usable round.
2. **Successful refresh:** a valid `action=data` response replaces the cache and renders.
3. **Connection failure:** an offline or timed-out refresh retains and renders the last known-good catalogue.
4. **Apps Script failure:** an HTTP error, an Apps Script error page, and a 200 response whose body is not a valid catalogue are each rejected, with the cache retained in every case.
5. **Roster independence:** roster import still works when the catalogue refresh is failing, and vice versa.
6. **Contract equivalence:** the cache-first app renders the same counters, defences, board configuration and scoring as the current app from the same `action=data` payload.
7. **Zero-counter defence behaviour** remains safe and explicit.
8. **Development deployment:** a build deploys to the development Worker, which returns `noindex` and contains no credential or personal data.
9. **Production deployment:** a reviewed, merged commit deploys to the production Worker and is verified over HTTP afterwards — the app loads, the expected build is served, and a catalogue fetch against `action=data` succeeds **from the Cloudflare origin** ([ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) §11 item 6).
10. **Deployment failure:** a forced failed deployment leaves the previously deployed version live and verifiable.
11. **Deployment rollback:** production returns to a verified known-good prior version, and the rollback is itself verified.
12. **Deployment concurrency:** a forced overlapping production deployment run is serialised, not lost or interleaved.
13. **Fail-closed public artifact:** a deliberately added private file does not reach the deployed artifact.
14. **Client-state readiness:** export on the old origin and import on the new origin round-trip roster, boards, templates, used counters and preferences (exercising ARCH-111's implementation).
15. **Origin fallback:** the GitHub Pages origin still serves the current app, unmodified, and remains a usable fallback.

**Explicitly out of scope, and moved to GATE-150** as future paused-path verification requirements: database-connected verification, database role and permission verification, migration reconciliation against a hosted database, database-backed publication, the `READY`/`DEPLOYED` distributed-publication failure windows, publication reconciliation, release rollback, and database health preflight/resume behaviour. Those exercises remain mandatory *for that path*, recorded in §7.1 and in [`docs/database/ARCH-108.md`](database/ARCH-108.md)'s Phase-B list. They are not Stage-1 exit criteria.

**Deliverable:** A signed-off Stage 1 validation report containing evidence, not just pass/fail claims.

**Verification approach:** Full independent verification — this is Stage 1's integration checkpoint under principle 16, and is where ARCH-109 (landed on package tests plus a scope/diff review) receives its independent re-verification.

**Acceptance:** Every mandatory check passes or has an explicit user-approved exception recorded in the architecture.

**Rollback:** No production state has changed.

**Depends on:** ARCH-104, ARCH-109 and ARCH-111's export/import implementation.

---

### ARCH-111 — Guarded one-repository consolidation and Cloudflare origin preparation

**Status: Parked — not started.** Repository consolidation and origin preparation are not required for the current operating model.

**Purpose:** Reach the desired single-source repository model without weakening the current public boundary, and implement and test the client-state export/import required by the production-origin change (GitHub Pages → Cloudflare Workers, [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.2, `TARGET_ARCHITECTURE.md` §15.0).

**Preconditions:**

- CI is green;
- the ARCH-110 integration rehearsal is complete, or its deployment-related exercises are complete where this package supplies the export/import they depend on;
- fail-closed artifact generation exists;
- secrets, personal identifiers and the paused database assets are excluded from the public artifact;
- the current live repository remains recoverable.

**Required behaviour:**

- `main` remains the authoritative source;
- only a generated/allow-listed public artifact is deployed;
- internal docs, migrations, tests, migration evidence, authoring change files and the paused database tooling cannot be published accidentally;
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

**Depends on:** ARCH-101, ARCH-102 (complete) and ARCH-104. Its export/import implementation feeds ARCH-110 exercise 14, so the two packages interleave rather than strictly sequencing.

---

### ARCH-112 — Production cutover and fallback window

**Status: Parked — not started.** GitHub Pages remains the production origin; no Cloudflare production cutover is authorised.

**Purpose:** Switch production only after explicit approval. This package performs the origin change itself (`TARGET_ARCHITECTURE.md` §15.0 steps 3–8), building on the export/import capability ARCH-111 built and tested.

**Pre-cutover evidence:**

- Stage 1 validation report approved;
- prior live commit, the Apps Script deployment URL and the old origin URL recorded;
- client-state export taken and verified importable;
- deployment rollback rehearsed;
- the GitHub Pages origin confirmed intact and serving;
- production artifact reviewed and fail-closed.

**Cutover:**

1. export client state from the old (GitHub Pages) origin;
2. deploy the new Cloudflare Workers production origin from a reviewed, merged commit;
3. verify the deployment over HTTP: the app loads, the expected build is served, and a catalogue fetch against `action=data` succeeds from the new origin;
4. import client state on the new origin and re-import the roster by ally code;
5. confirm boards, templates, used counters, preferences and offline behaviour on the new origin;
6. confirm roster import;
7. confirm active/saved board compatibility;
8. confirm offline reload from cache;
9. start the one-complete-GAC-event fallback window.

No Sheet freeze, export/reconciliation rerun or catalogue delta is required: the catalogue source is unchanged, and both origins read the same `action=data` payload throughout.

**During fallback:**

- the old GitHub Pages origin, the Sheet and both Apps Script routes all remain intact and unmodified;
- authoring continues in the Google Sheet exactly as before;
- emergency rollback may return the production Worker to a prior verified deployment, or direct the owner back to the old origin entirely;
- no evidence automation begins, and no hosted database is created.

**Stage 1 exit gate:**

- one complete GAC event succeeds on production from the Cloudflare origin;
- the owner has made at least one real catalogue change in the Sheet and seen it reach the live app;
- no catalogue/roster/offline regression remains;
- a catalogue-refresh failure has been observed, or deliberately induced, without costing a usable catalogue;
- only at this gate are the old GitHub Pages deployment and `LIVE_REPO_PAT` retired, per `TARGET_ARCHITECTURE.md` §15.0 step 8;
- deployment rollback is still available.

**`action=data` is not retired and the Sheet is not archived at this gate.** Both remain the live catalogue path. Retiring either requires a replacement catalogue path that is live and accepted, which requires GATE-150 ([ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) §7).

**Depends on:** ARCH-110 and ARCH-111, or an approved consolidation exception.

---

## 6. Stage 1 dependency summary

| Work package | Depends on | Can overlap |
|---|---|---|
| ARCH-101 | — | — |
| ARCH-102 | ARCH-101 | ARCH-103 |
| ARCH-103 | ARCH-101 | ARCH-102 |
| ARCH-104 (active, Cloudflare only) | ARCH-102 (complete), ADR-ARCH-113 | ARCH-109 |
| ARCH-105 (paused) | ARCH-102 (complete) | — |
| ARCH-106 (paused) | ARCH-103, ARCH-105 | — |
| ARCH-107 (paused) | ARCH-105, ARCH-106, ARCH-108 | — |
| ARCH-108 Phase A (paused) | ARCH-102, ARCH-105, ARCH-106 | — |
| ARCH-108 Phase B (paused) | GATE-150 | — |
| ARCH-109 (active) | ARCH-101 | ARCH-104 |
| ARCH-110 (active) | ARCH-104, ARCH-109, ARCH-111 export/import | — |
| ARCH-111 (active) | ARCH-101, ARCH-102, ARCH-104 | ARCH-110 |
| ARCH-112 (active) | ARCH-110 and ARCH-111, or an approved exception | — |
| GATE-150 | Stage 1 delivered | GATE-200 |

Only ARCH-112 may switch production. The paused packages have no active dependents: nothing in ARCH-104, ARCH-109, ARCH-110, ARCH-111 or ARCH-112 waits on them, and none of them may be resumed before GATE-150.

---

# Gates before Stage 2

## 7. Gate overview

Two independent gates sit between Stage 1 and Stage 2 implementation. They may be investigated in either order or in parallel, and **both** must be resolved before Stage 2 begins. Neither may introduce infrastructure or bypass Stage 1 priorities.

| Gate | Question | Blocks |
|---|---|---|
| GATE-150 (§7.1) | Which persistent maintenance store, at what cost, and does the paused database implementation still work against it? | Any deployment of the paused database path, and Stage 2 |
| GATE-200 (§7.2) | Does permitted, sufficiently granular, acceptably priced GAC evidence exist, and what runs the ingestion? | Stages 2 and 3 |

### 7.1 GATE-150 — Persistent maintenance-store decision

Added by [ADR-ARCH-113](decisions/ADR-ARCH-113-stage1-rebaseline.md) §9. This gate governs the paused database path: nothing in ARCH-105–ARCH-108 may be deployed, connected or operationalised until it produces an explicit `GO`, `GO WITH LIMITS` or `STOP`.

**Questions to answer with fresh evidence:**

1. Which persistent maintenance store is selected — Neon, another managed Postgres provider, a self-hosted instance, or a reconsidered Supabase project? **No provider is selected today; Neon is a candidate, not a decision.**
2. What are its current cost, free-tier limits, storage limits, connection limits and region availability?
3. What is its pausing/inactivity behaviour, and what resume action does it require?
4. Does it satisfy `TARGET_ARCHITECTURE.md` §17's "no new recurring cost unless explicitly approved" rule, or does it need an explicit cost decision?
5. Is the checked-in schema portable to it without provider-specific rework?
6. Does the catalogue's canonical home move there, or does Google Sheets remain canonical with the database serving maintenance only?
7. Which of ADR-ARCH-102's superseded assumptions still need re-verification for the selected provider?

**Required revalidation before any deployment of the paused path:**

- apply the ordered migrations to the selected provider and verify the role boundary, grants and RLS on it;
- re-run the migration loader and reconciliation against the then-current Sheet data, not the 2026-09-21 capture alone;
- complete ARCH-108's Phase-B connected verification list in [`docs/database/ARCH-108.md`](database/ARCH-108.md), which also completes ARCH-107's operational sign-off;
- re-exercise the distributed-publication failure windows, publication reconciliation, release rollback and the database health preflight/resume behaviour — the exercises removed from ARCH-110's active scope;
- define the encrypted off-site logical-backup destination, retention and restore testing that ADR-ARCH-102 §10.1 deliberately deferred.

**Gate output:** a recorded decision naming the provider (or declining to select one), its cost assessment, the revalidation results, and an explicit `GO`, `GO WITH LIMITS` or `STOP`.

**No-go rule:** If no acceptable persistent store exists, the paused path stays paused. Stage 1 is unaffected, because the live application does not depend on it.

**Relationship to GATE-200:** If GATE-200 returns `STOP AFTER STAGE 1`, GATE-150 is moot — there is no automated maintenance to store anything for.

---

### 7.2 GATE-200 — Source and execution feasibility

This gate occurs after Stage 1 and before Stage 2 implementation commitment, alongside GATE-150 (§7.1). It may be investigated earlier, but it cannot introduce infrastructure or bypass Stage 1 priorities.

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

**No-go rule:** If permitted, sufficiently granular and acceptably priced evidence does not exist, do not implement Stages 2 or 3. In that case GATE-150 is moot and the paused database path remains paused indefinitely.

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

**Depends on:** GATE-200 = `GO` or `GO WITH LIMITS`, and GATE-150 = `GO` or `GO WITH LIMITS`.

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

**Depends on:** ARCH-205 and the publisher revalidated at GATE-150.

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

# Stage 3 — Scheduling and bounded autonomous publication capability

## 10. Stage 3 objective

Prove that eligible maintenance cycles can run unattended and publish only validated, bounded changes. Stage 3 establishes machinery safe enough for controlled bootstrap runs; it does not authorise unrestricted catalogue expansion or steady-state autonomous maintenance.

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

### ARCH-302 — Bounded autonomous publication activation

- enable production pointer updates only for eligible `MAINTENANCE` releases;
- retain publication lock and base-release checks;
- refuse anomaly-blocked runs;
- support `APPROVED_OVERRIDE` only through explicit human action;
- preserve authored locks and note authority;
- enforce absolute and proportional catalogue-change ceilings;
- prevent bootstrap publication outside the active format, approved promotion wave and configured batch limit;
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
- batch limits and mass-change circuit breakers are demonstrated;
- the user approves a controlled `5V5` bootstrap, not yet routine steady-state operation.

**Rollback:** Disable scheduling and repoint to the last human-approved compatible release.

---

# Stage 4 — `5V5` bootstrap and calibration

## 12. Stage 4 objective

Discover the full `5V5` catalogue opportunity in shadow mode, calibrate the maintenance engine against the curated seed catalogue, and promote only differentiated, evidence-qualified candidates in small waves.

Large discovery batches are expected and permitted. They do not enlarge a publication wave or weaken any evidence, usefulness, authority, anomaly or validation threshold.

## 13. Stage 4 work packages

### ARCH-401 — `5V5` shadow discovery and baseline comparison

- run a complete `5V5` discovery pass without canonical or pointer writes;
- retain every discovered defence, candidate matchup and rejected/held outcome with provenance;
- compare rediscovered counters, rankings and proposed values with the curated `5V5` catalogue;
- exercise curated counters as regression cases, including experience-backed downgrades and exceptions;
- classify agreement, disagreement, new coverage, duplicate/no-value proposals and insufficient evidence;
- record source, sample size, recency, observed performance, banner evidence and confidence for every candidate.

**Acceptance:** The full pass is reproducible; no discovery becomes canonical; unresolved or weak evidence remains staged; the comparison exposes systematic bias, false positives and missing evidence rather than hiding them in aggregate scores.

### ARCH-402 — `5V5` calibration and bounded promotion waves

- tune only evidence-backed policy parameters exposed by ARCH-401;
- require a candidate to add reliability, banner efficiency, accessibility, undersize potential or otherwise missing coverage;
- route every curated-data disagreement to review rather than silently overwriting it;
- leave banner values unknown in staging when evidence is insufficient; never manufacture false precision;
- rank eligible candidates by evidence and user value;
- publish in small waves capped by both absolute count and catalogue percentage;
- trip a review stop when churn, disagreement, mapping failure or source-volume change exceeds its circuit breaker;
- preserve complete release, finding and rollback provenance for every promoted change.

**Acceptance:** No `AUTHORED_LOCKED` value changes; no curated bootstrap judgement is silently overwritten; every new canonical record has supporting evidence and provenance; low-confidence candidates remain staged; repeated or oversized waves stop safely; previous releases remain recoverable.

### ARCH-403 — `5V5` bootstrap acceptance

Produce a compact report containing:

- discovered defences and candidate matchups;
- promoted, rejected and held volumes;
- confidence distribution and evidence/sample-size distribution;
- agreement and disagreement rates with curated data;
- representative high-impact additions, changes, false positives and unresolved gaps;
- publication-wave sizes and all circuit-breaker events;
- rollback references and the proposed transition of the remaining `5V5` backlog to steady-state maintenance after Stage 5.

**Stage 4 exit gate:** Every Stage-4 acceptance criterion has passed, the report shows credible calibration and controlled catalogue growth, rollback is demonstrated, and the user explicitly accepts the `5V5` bootstrap.

**Rollback:** Stop further `5V5` promotion waves and repoint to the last accepted compatible release. Preserve staged evidence and decisions for audit.

---

# Stage 5 — `3V3` bootstrap and calibration

## 14. Stage 5 objective

Repeat the controlled bootstrap independently for `3V3`. Passing Stage 4 does not waive `3V3` validation because composition patterns, sample sizes, banner behaviour and matchup volatility can differ materially from `5V5`.

## 15. Stage 5 work packages

### ARCH-501 — `3V3` shadow discovery and baseline comparison

Run the ARCH-401 discovery, provenance, curated-regression and disagreement analysis for `3V3`, without canonical or pointer writes.

**Acceptance:** The complete `3V3` shadow pass is reproducible and independently exposes weak evidence, bias, false positives and unresolved mappings.

### ARCH-502 — `3V3` calibration and bounded promotion waves

Apply the ARCH-402 evidence, usefulness, curated-protection, banner-precision, batch-ceiling, circuit-breaker, provenance and rollback requirements using independently calibrated `3V3` policy parameters.

**Acceptance:** Every promoted `3V3` record satisfies the Stage-4 quality controls under the independently calibrated `3V3` policy; low-confidence and oversized changes remain staged or stop for review.

### ARCH-503 — `3V3` bootstrap acceptance and steady-state transition

Produce the same acceptance report as ARCH-403 for `3V3`, including representative differences from `5V5` calibration.

**Stage 5 exit gate:** Every Stage-5 acceptance criterion has passed, rollback is demonstrated, and the user explicitly accepts the `3V3` bootstrap and transition to steady-state autonomous maintenance.

**Rollback:** Stop further `3V3` promotion waves and repoint to the last accepted compatible release. Accepted `5V5` bootstrap results remain intact.

After Stage 5, the same bounded pipeline enters steady-state operation. Mass-change circuit breakers, authority rules, provenance requirements and publication ceilings remain active; catalogue completeness never becomes a publication target.

---

## 16. Manual configuration plan

The goal is one substantial session in Stage 1 (ARCH-104), and it is **Cloudflare-only**.

| Configuration | Stage 1 session | Later action |
|---|---|---|
| Persistent database project/region | **Not created.** No Supabase, Neon or other hosted database exists on the active path | Provider selected and provisioned only at GATE-150, under a separate owner decision |
| Database roles/credentials | **None created.** No database user, role or connection secret | Created with the provider at GATE-150; Stage-2 evidence/analyst/applier roles only after GATE-200 |
| Production gate | Repository secrets plus manual `workflow_dispatch`; GitHub Environments are not used (unavailable for a private repo on GitHub Free) | None |
| Repository secrets and variables | Cloudflare deploy token, account ID, Worker names, production base URL | Add a persistent-store secret only after GATE-150; add an evidence-provider secret only after GATE-200 |
| Static hosting | Configure the Cloudflare Workers development and production deployments for the PWA, including the development Worker's `noindex` and content constraints | None |
| Workflow permissions | Configure CI and the explicit manual deployment/rollback workflows, including the production-deployment concurrency group | Enable any scheduled workflow only in Stage 3, after both gates |
| Repository consolidation | Configure target route and fallback | Retire old live repo only after ARCH-112 acceptance |
| Recovery | Confirm deployment rollback works and the GitHub Pages fallback is intact; the Google Sheet plus the committed ARCH-103 capture are the catalogue's recovery evidence | Database backup/restore procedures belong to GATE-150 |

**Cost assumption for the active path:** no new recurring paid service. The only providers involved are Cloudflare Workers (two deployments, assumed free tier), Google Apps Script (existing, free) and GitHub Free Actions. Cloudflare's current free-tier limits are re-checked in ARCH-104 before they are relied upon.

If provider UI or account restrictions force another substantial manual setup later, stop and present the reason before expanding the programme.

---

## 17. Manual and on-demand operations

**On the active path**, the on-demand operations are deployment operations: deploy to development, deploy to production (verified over HTTP afterwards), and roll a production deployment back to a verified prior version. Each is manually triggered, records who triggered it, and is the same command any future automation would reuse. Catalogue changes need none of them — the owner edits the Google Sheet and the change is live through `action=data`.

The two paths below are **paused** with the database path and resume at GATE-150.

### 17.1 Human authoring (paused)

The owner or control chat can initiate an authoring run at any time:

1. prepare a validated change file;
2. run a dry run;
3. inspect the canonical and payload diff;
4. apply the change through the authoring loader;
5. generate and validate an `AUTHORING` candidate;
6. publish only after the normal publication gates pass.

Human authoring is independent of the maintenance schedule. Until GATE-150, the active human authoring path is editing the Google Sheet directly.

### 17.2 Maintenance review (paused)

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

## 18. Control-chat operating model

This conversation is the programme control thread.

The control thread owns:

- current work-package selection and status;
- architectural and product decisions;
- dependency and acceptance-gate checks;
- manual-configuration guidance;
- review of breakout results against fresh repository evidence;
- the next self-contained handoff prompt;
- decisions to pause, rollback, cut over or activate autonomy.

### 18.1 Coding breakouts

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

### 18.2 Deep-analysis breakouts

Use a read-only analysis breakout when a decision needs substantial research, comparison or failure-mode testing before code is appropriate.

Analysis prompts must:

- state that no repository or external-system changes are authorised;
- identify the exact decision to resolve;
- distinguish fact, inference and recommendation;
- return concrete options, trade-offs and a recommended decision;
- identify time-sensitive facts that require current verification.

### 18.3 Manual steps

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

## 19. Agent execution protocol

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

## 20. Status tracking

Use these states:

- `Not started`
- `Ready`
- `In progress`
- `Blocked`
- `Validation`
- `Complete`
- `Paused`
- `Abandoned`

`Paused` means delivered or partially delivered work whose remaining operational steps are deferred behind a gate, preserved intact (delivery principle 21). It is distinct from `Blocked`, which means work that should be proceeding but cannot, and from `Abandoned`, which means work that will not be completed.

Current status:

| Item | Status | Note |
|---|---|---|
| ARCH-101 | Complete | Active foundation |
| ARCH-102 | Complete | Partly superseded by ADR-ARCH-113 |
| ARCH-103 | Complete | Reusable future asset; also active-path recovery evidence |
| ARCH-104 | Not started | Active, re-scoped to Cloudflare only |
| ARCH-105 | Complete | Paused future-migration asset |
| ARCH-106 | Complete | Paused future-migration asset |
| ARCH-107 | Complete | Paused future-migration asset; operational sign-off at GATE-150 |
| ARCH-108 | Phase A complete; Phase B `Paused` | Behind GATE-150 |
| ARCH-109 | Not started | Active, re-scoped to cache-first Apps Script loading |
| ARCH-110 | Not started | Active, re-scoped to the revised integration checkpoint |
| ARCH-111 | Not started | Active |
| ARCH-112 | Not started | Active; only this package may switch production |
| GATE-150 | Not started | New; required before the paused path resumes |
| GATE-200 | Not started | Unchanged |
| ARCH-201–207 | Not started | Behind both gates |
| ARCH-301–304 | Not started | Behind both gates |
| ARCH-401–403 | Not started | Future bootstrap policy; not a Stage-1 dependency |
| ARCH-501–503 | Not started | Future bootstrap policy; not a Stage-1 dependency |

Only one implementation work package should normally be `In progress` at a time. Documentation preparation or independent read-only evidence gathering may overlap where the dependency table permits.

---

## 21. Explicit exclusions

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
- creating any hosted database, database user or database credential before GATE-150;
- retiring `action=data`, archiving the Google Sheet, or restricting either, while the PWA depends on them;
- public distribution or multi-user administration;
- adding paid services without an explicit cost decision.

These remain separate roadmap or architectural decisions.

---

## 22. Definition of programme complete

The programme is complete only when:

- Stage 1 has moved delivery to Cloudflare, made catalogue loading cache-first, and survived its fallback window;
- GATE-150 has selected a persistent maintenance store and the paused database path has been revalidated against it;
- Stage 2 has validated real evidence in report-only mode;
- Stage 3 has proved bounded scheduling and autonomous publication without authorising unrestricted expansion;
- Stage 4 has completed and received explicit `5V5` bootstrap acceptance;
- Stage 5 has completed and received explicit `3V3` bootstrap and steady-state acceptance;
- production works from a cached, validated catalogue without any remote system being reachable;
- human authoring remains available and documented;
- every autonomous change is reproducible and policy-enforced;
- failures and anomalies do not partially publish;
- rollback is proven;
- routine success creates no user administration;
- current behaviour and release history have been moved into their proper authorities.
