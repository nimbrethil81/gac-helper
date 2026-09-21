# ADR ARCH-102 — Platform Decisions and Threat Model

**Status:** Accepted.
**Decision date:** 2026-09-21.
**Repository evidence SHA:** `907189cf69dad9adeaab2ee5f1b165871cfe34da` (branch `claude/arch-102-platform-decisions-k02zai`, created from `main` at this SHA with no divergence).

**Scope.** This ADR records the Stage-1 platform decisions for the target architecture described in [`TARGET_ARCHITECTURE.md`](../TARGET_ARCHITECTURE.md) and sequenced in [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), work package ARCH-102. It resolves host, environment, publication, secret, role and threat-model questions that ARCH-102 was scoped to answer before manual cloud configuration (ARCH-104) and schema work (ARCH-105) begin. It does not itself create, configure or modify any external service, database, worker, secret, environment, workflow or production release. Every external-provider fact in this document was not verified against a live provider API or console in this session; such facts are labelled `[ASSUMPTION]` and must be re-verified during ARCH-104, as required by the control thread.

## Evidence labels

Each substantive claim below is tagged:

- **[REPO-FACT]** — directly observed in this repository at the evidence SHA above.
- **[PROVIDER-FACT]** — externally verified against a live provider console, API or documentation in this session. (None are used in this ADR; no external verification was performed.)
- **[INFERENCE]** — a conclusion drawn from repository facts plus stated, general platform behaviour, not independently re-verified here.
- **[DECISION]** — an accepted decision from the control thread, recorded as authoritative for Stage 1 regardless of its evidentiary basis.
- **[ASSUMPTION]** — a claim about external-provider behaviour, pricing, limits or terms that has **not** been verified in this session and must be re-checked, most urgently during ARCH-104 and the GATE-200 spike.

---

## 1. Accepted decisions

1. **[DECISION]** The GitHub account underlying this repository is GitHub Free.
2. **[DECISION]** Production hosting moves from GitHub Pages (public `nimbrethil81/gac-helper` repository, [REPO-FACT] confirmed live at `README.md:22` in this repository) to a Cloudflare Workers static-assets deployment. The production URL may therefore change; the exact new URL is not decided by this ADR and is deferred to ARCH-111/ARCH-112.
3. **[DECISION]** The one remaining free Supabase project slot may be used to host GAC Helper's Stage-1 canonical database, with the actual project created manually during ARCH-104 after re-checking cost and account limits.
4. **[DECISION]** The Supabase-slot allocation is reversible. If another owner-operated application later needs the slot more, GAC Helper's database may be migrated, paused, or otherwise reconsidered through a separate, explicitly approved plan. This ADR does not pre-commit to any such migration path.
5. **[DECISION]** The development Cloudflare Worker may remain publicly reachable, subject to three mandatory controls:
   - it is marked `noindex` (a `X-Robots-Tag: noindex` response header and/or a `<meta name="robots" content="noindex">` tag, applied to every response the development Worker serves);
   - it contains no credentials, personal identifiers, or private operational data — this includes ally codes, real roster data, database connection strings, and unredacted provenance that names the owner;
   - it is treated operationally as a **preview environment**, not an access-controlled environment. No secret or personal data may rely on its obscurity for protection.
6. **[DECISION]** GitHub repository secrets plus explicit manual `workflow_dispatch` triggers replace GitHub Environments as the Stage-1 production gate. GitHub Environments with required reviewers are a GitHub Team/Enterprise feature on private repositories; GitHub Free does not offer them for a private repo ([ASSUMPTION] — current GitHub plan-feature matrix, must be re-verified at ARCH-104 in case Free-tier entitlements have changed). Repository secrets scoped to the repository, combined with a workflow that only runs on manual dispatch by the repository owner, is the Stage-1 substitute gate.
7. **[DECISION]** Manual operation is mandatory for Stage 1 and remains available in every later stage. The architecture must support, at minimum:
   - a manual authoring run (human catalogue change without SQL, per `TARGET_ARCHITECTURE.md` §6);
   - a manual candidate/review run (report-only maintenance review, per `TARGET_ARCHITECTURE.md` §8 and `IMPLEMENTATION_PLAN.md` §13.2);
   - a manual publication run (candidate → `READY` → deployed → `DEPLOYED`, §4 below);
   - a manual rollback run (repoint to a prior compatible release, §5 below).
   Scheduling (Stage 3) is an additional trigger for the same underlying commands and code paths — it is never a separate, less-guarded implementation.

## 2. Rejected alternatives

- **GitHub Environments as the Stage-1 gate.** Rejected because GitHub Free does not provide protected/required-reviewer Environments on a private repository ([ASSUMPTION], re-check at ARCH-104). Repository secrets plus manual dispatch achieve an equivalent effect at zero cost and are re-verified as a low-risk substitute because no code path in this design triggers publication except an explicit human-initiated `workflow_dispatch`.
- **Private-repository GitHub Pages.** Rejected. GitHub Pages from a private repository requires GitHub Pro/Team/Enterprise; the account is Free ([ASSUMPTION], re-check at ARCH-104). This is *why* production moves to Cloudflare Workers rather than simply making the existing private dev repository the Pages source.
- **Atomic cross-system transaction spanning the database and Cloudflare deployment.** Rejected. A Postgres transaction and a Cloudflare Workers deployment are two independent systems with no shared transaction coordinator; describing them as atomic would misstate what the implementation can actually guarantee. §4 below replaces this with an explicit multi-phase protocol with defined recovery for every failure window.
- **Daily keep-alive ping to defeat Supabase free-tier pausing.** Rejected. The database is deliberately outside the live PWA's runtime path (`TARGET_ARCHITECTURE.md` §2.8, §17); a paused database must not be allowed to affect the live application, so there is no requirement to keep it warm. A keep-alive would add a recurring scheduled cost/complexity purely to fight a non-problem. §3 below requires every maintenance operation to preflight, fail safely, and resume idempotently instead.
- **Committing raw `pg_dump` output to normal Git history as the Stage-1 backup mechanism.** Rejected. Git is not an appropriate store for potentially large, binary, and update-heavy database dumps, and committing full dumps on every change would make repository history unusable and would risk leaking data outside the intended provenance model. §3 below defines the Stage-1 reconstruction sources instead, and defers a real off-site backup destination to a later gate.
- **Creating Stage-2 login credentials (ingester, analyst, deterministic-applier roles) during Stage 1.** Rejected. Stage 1 has no code path that uses these roles; a dormant credential is pure attack surface with no offsetting value. §6 below creates only the roles Stage 1 actually exercises.
- **One combined production+development Supabase project boundary with no environment separation.** Rejected in favour of a documented local-disposable-plus-one-hosted-canonical model recorded in `TARGET_ARCHITECTURE.md` (§3 below); a single hosted project remains the canonical store, but schema and migration work is developed and rehearsed against a local, disposable Postgres instance first, so canonical data is never used as the primary migration test bed.

## 3. Environment model

**[DECISION]**

- **Local development:** a disposable, locally run Postgres instance (for example via the Supabase CLI's local stack, or plain `docker run postgres`) is used to develop and rehearse schema migrations, the authoring loader, the validator and the publisher before any change touches the hosted project. It holds no real GAC data and is torn down and recreated freely.
- **Hosted canonical:** exactly one hosted Supabase project (Supabase Free, London region — see §11 time-sensitive assumptions) is the Stage-1 canonical database. There is no separate hosted "staging" database in Stage 1; the free-tier project-slot constraint (§1.3) makes a second hosted project impractical, and the publication protocol in §4 is designed so that candidate generation and validation can be rehearsed safely against the one hosted project without ever moving its current-release pointer.
- **Static hosting environments:** two Cloudflare Workers deployments exist —
  - a **development Worker**, publicly reachable per §1.5, serving unpublished/candidate static artifacts and pointers for manual inspection and testing;
  - a **production Worker**, serving the artifact and pointer the live PWA actually reads, updated only through the guarded protocol in §4 via an explicit `workflow_dispatch`.
- **GitHub Actions environments:** in place of GitHub Environments (§1.6, §2), production-affecting workflows are gated by (a) requiring `workflow_dispatch` with no automatic trigger, (b) reading secrets scoped at the repository level, and (c) a concurrency group (§4) that serialises production deployments. This is a weaker gate than a required-reviewer Environment, and that gap is recorded as an accepted Stage-1 limitation rather than papered over — see §9.

## 4. Static artifact and pointer design

**[DECISION]**

- The Cloudflare Worker serves two kinds of static object from its assets directory, mirroring `TARGET_ARCHITECTURE.md` §9.3:
  - **Immutable versioned artifacts** at a version-qualified path (for example `catalogue/v{version}.json`), never overwritten once written.
  - **A tiny current-version pointer** at a fixed path (for example `catalogue/current.json`) containing at minimum the current `version`, `payloadSchemaVersion`, and `checksum` of the artifact it points at. The pointer is the only object the PWA polls on every load; the artifact URL it names is then fetched and validated.
- The **static deployed pointer is authoritative for what the phone currently sees.** It is a Cloudflare Workers asset, updated only by a completed deployment (§4.1 step 4 below).
- The **database `catalogue_state.current_release_id`** records the verified-deployed state as understood by the maintenance/publication tooling. It is expected to agree with the static pointer once step 6 below completes, but the static pointer is what the live app actually reads, and remains authoritative for the app even during the brief window where the two can disagree (§4.2).
- Both objects are served from the same reliable static-delivery path as the app itself (the same Cloudflare Worker), so there is no separate hosting dependency for catalogue delivery.

### 4.1 Revised distributed publication protocol

Publication crosses two independent systems — Postgres and Cloudflare Workers — and cannot be made atomic across them. The protocol instead uses a `READY`/`DEPLOYED` release lifecycle with verification between phases, so that a failure at any point leaves the system in a well-defined, recoverable state.

1. **Candidate generation.** Generate and validate a candidate release against an explicit, named base release (the current `catalogue_state.current_release_id` at the time generation starts), per `TARGET_ARCHITECTURE.md` §9.2 steps 1–5. This step performs no writes to `catalogue_state` or to static storage.
2. **First short database transaction — record `READY`:**
   - take the publication-scoped advisory lock (`TARGET_ARCHITECTURE.md` §9.2 step 1);
   - re-check that the current release still equals the recorded base release; abort if it has moved;
   - allocate the monotonic version;
   - insert the new release row with `status = READY` (an addition to the `CANDIDATE`/`PUBLISHED`/`SUPERSEDED`/`REJECTED` status set in `TARGET_ARCHITECTURE.md` §9.1, needed because publication no longer completes in one transaction — see §9);
   - do **not** move `catalogue_state.current_release_id`;
   - commit and release the lock.
   A `READY` release is immutable database evidence that a candidate passed validation and was allocated a version, but it is not yet live anywhere.
3. **Write the immutable artifact and static pointer to a staging location** (or directly to the development Worker's asset store) — the versioned artifact first, then a pointer object, without yet touching the production Worker.
4. **Deploy artifact and pointer together as one Cloudflare Worker version.** Cloudflare Workers versioned deployments allow the artifact and the pointer to be published as a single atomic asset-manifest update within Cloudflare's own deployment model ([ASSUMPTION] — exact Cloudflare Workers static-assets versioning semantics, re-verify during ARCH-104/ARCH-108 implementation against current Cloudflare documentation). This is the one step in the whole protocol where "atomic" is an accurate word, because it is a single-system operation.
5. **Verify over HTTP**, against the just-deployed production Worker:
   - the pointer is fetched and is well-formed;
   - the artifact URL it names is fetched and returns HTTP 200;
   - the artifact's `payloadSchemaVersion` matches the expected contract version;
   - the artifact's catalogue `version` matches the version allocated in step 2;
   - the artifact's checksum matches the checksum recorded on the `READY` release row.
   Any failure here stops the protocol before touching the database again.
6. **Second short database transaction — finalize:** mark the release `DEPLOYED` and move `catalogue_state.current_release_id` to it, inside the same advisory-lock discipline as step 2.
7. **Record the deployed commit SHA and the Cloudflare version/deployment identifier** on the release row (an addition to `TARGET_ARCHITECTURE.md` §9.1's release fields), so every deployed release is traceable back to both the exact repository state and the exact Cloudflare deployment that served it.

### 4.2 Recovery for the distributed failure window

| Failure point | System state left behind | Recovery |
|---|---|---|
| Cloudflare deployment fails (protocol step 4) | Previous static Worker version remains live; the release stays `READY` in the database | Re-run deployment (step 4 onward) for the same `READY` release; idempotent because the version and checksum are already fixed |
| Cloudflare succeeds but HTTP verification fails (step 5) | New artifact/pointer may be live on Cloudflare, but the database release stays `READY`, never `DEPLOYED` | Do not finalize the database release. Investigate; either redeploy a corrected artifact under the **same** `READY` release, or reconcile per below |
| HTTP verification succeeds but database finalization fails (step 6) | Cloudflare pointer is live and correct; database still shows the prior `current_release_id` | Run the **reconciliation command**: compare the live static pointer against the immutable `READY` release; if it matches exactly (version, schema version, checksum), safely finalize the database release (retry step 6). If it does not match anything recorded, roll the static pointer back to the last release the database agrees is `DEPLOYED` |

- **Concurrency.** Production deployment workflows use a GitHub Actions concurrency group (for example `group: production-publish`, `cancel-in-progress: false`) so two production deployment runs can never execute simultaneously. This is enforced at the workflow level, in addition to the database advisory lock, because the advisory lock alone cannot serialise the Cloudflare deployment step.
- **Idempotency.** Both the deployment step (step 4) and the reconciliation command are safe to re-run: redeploying the same versioned artifact/pointer content is a no-op in effect, and reconciliation only ever moves the system toward agreement between the static pointer and the last-known-good `READY`/`DEPLOYED` release, never destructively.

## 5. Rollback protocol

Rollback selects a prior **compatible** immutable artifact — compatibility meaning the same major `payloadSchemaVersion` the deployed app understands (`TARGET_ARCHITECTURE.md` §9.3) — and repeats a reduced form of §4.1:

1. identify the target prior release (already `DEPLOYED` at some point, its artifact still retained per the retention policy);
2. re-verify its artifact is still present and its checksum still matches;
3. deploy its artifact + a pointer naming it as one Cloudflare Worker version (protocol step 4);
4. verify over HTTP (protocol step 5);
5. finalize the database pointer to the rolled-back release (protocol step 6), recording the rollback explicitly (e.g. a new `catalogue_releases` row or an explicit rollback event, not a mutation of the historical release row) so the release history remains append-only and auditable.

Rollback never requires database availability for the **live PWA** — only for the tooling performing the rollback itself. If the database is unavailable, an operator may still repoint the static pointer directly (protocol steps 3–5 only) as an emergency measure; the database-side finalization (step 6) is then completed once the database is reachable again, using the reconciliation command from §4.2.

## 6. Payload schema v1 outline

**[DECISION]** The Stage-1 payload schema version is `1`. Its content is the JSON object described in `TARGET_ARCHITECTURE.md` §9.1's payload list, made concrete as:

```json
{
  "payloadSchemaVersion": 1,
  "catalogueVersion": 0,
  "checksum": "sha256:...",
  "units": {},
  "counterDefinitions": {},
  "characterDefinitions": {},
  "counters": { "5v5": {}, "3v3": {}, "FLEET": {} },
  "defenceTeams": {},
  "defenceCompositions": {},
  "boardConfig": {},
  "scoring": [],
  "provenance": {
    "baseReleaseId": "...",
    "releaseReason": "MIGRATION | AUTHORING | MAINTENANCE | APPROVED_OVERRIDE",
    "generatedAt": "...",
    "sourceCommitSha": "..."
  }
}
```

This is additive and structurally compatible with the current `action=data` contract documented in `SPEC.md` §5 (`counters`, `counterDefinitions`, `characterDefinitions`, `boardConfig`, `scoring`, `defenceTeams`, `defenceCompositions`), plus the new top-level `payloadSchemaVersion`, `catalogueVersion`, `checksum` and `provenance` fields required for the static-artifact model. Fields the PWA does not currently consume (`units`, `provenance`) must be ignorable by the PWA without breaking parsing, per `TARGET_ARCHITECTURE.md` §9.1's "provenance references ignored by the PWA but retained for audit." The exact field-by-field mapping and validator are ARCH-108 implementation work, not decided further here.

## 7. Stage-1 secret and role inventory

**[DECISION]** Only the roles and credentials Stage 1 actually exercises are created; Stage-2 roles (evidence ingester, maintenance analyst, deterministic applier) are **not** created in Stage 1, per the control-thread amendment on incremental roles.

| Role/secret | Purpose | Used by | Created in Stage 1? |
|---|---|---|---|
| **Migration/admin role** | Schema migration only | A human operator, run manually from a local machine or a manually dispatched workflow; **never stored as a GitHub Actions secret** | Yes — credential held only locally/manually, not in GitHub |
| **Authoring role** | Applies reviewed human authoring changes through the loader/validator | Authoring workflow, triggered manually (§8) | Yes |
| **Publisher role** | Generates, validates and records releases; the only role permitted to move `catalogue_state.current_release_id` | Publication workflow, triggered manually (§8) | Yes |
| **Read-only backup/export role** | Logical export for the Stage-1 backup/recovery model (§9) | Manual export command, or a scheduled export workflow if the eventual Stage-1 recovery implementation needs one | Only if the Stage-1 recovery implementation actually needs it, per the control-thread amendment — not created speculatively |
| `SUPABASE_DB_URL` / equivalent connection secret(s) | Database connectivity for the authoring and publisher roles | GitHub Actions repository secrets, scoped to workflows that require them | Yes, once ARCH-104 provisions the project |
| Cloudflare API token (deploy-scoped) | Deploy the static Worker(s) | Production/development deployment workflows | Yes |
| `LIVE_REPO_PAT` | Sync the allow-listed public artifact to the existing `nimbrethil81/gac-helper` GitHub Pages repository ([REPO-FACT], `.github/workflows/deploy-to-live.yaml:22`) | Existing `deploy-to-live.yaml` workflow | Already exists; retained unchanged through the Stage-1 fallback window (§10); retired only at the ARCH-112 exit gate |
| Evidence-provider credential | Stage-2 evidence ingestion | Stage-2 ingestion workflow | **No** — reserved naming only, populated after GATE-200 |
| Evidence ingester / maintenance analyst / deterministic applier database roles | Stage-2 evidence and assessment pipeline | Stage-2 code | **No** |

**Least privilege.** No role above can write outside its named purpose: the authoring role cannot alter schema or policy; the publisher role generates and validates releases but does not independently mutate canonical catalogue rows outside the authoring/applier paths; the migration/admin role is never placed in an automated, always-available credential. The live PWA holds **no** database credential of any kind — it only ever performs unauthenticated HTTP reads against the Cloudflare Worker's static assets.

## 8. Manual-run entry points

Per §1.7 and `IMPLEMENTATION_PLAN.md` §13, every one of the following is a manually triggerable command/workflow, independent of any schedule, and each is also the exact code path a future scheduled trigger (Stage 3) reuses — a manual trigger is never a separate, less-guarded implementation:

1. **Manual authoring run** — prepare a validated change file, dry-run it, inspect the diff, apply through the authoring loader, generate and validate an `AUTHORING` candidate, then optionally publish through the normal gates (§4). Entry point: a repository script/command runnable locally, and optionally a `workflow_dispatch` workflow for the same command.
2. **Manual candidate/review run** — trigger a maintenance report-only review outside the schedule, accepting bounded inputs (mode, cycle key). Report-only is the default; it never writes `catalogue_state`. Entry point: `workflow_dispatch` with report-only as the default input value.
3. **Manual publication run** — the protocol in §4.1, invoked explicitly; never runs as a side effect of another workflow.
4. **Manual rollback run** — the protocol in §5, invoked explicitly, naming the target prior release.

Every manual entry point records who/what triggered it and remains idempotent for the same logical unit of work (release, authoring change, or maintenance cycle/mode), per `IMPLEMENTATION_PLAN.md` §13.2.

## 9. Threat model

**[DECISION]**, informed by the repository's existing security-boundary language in `TARGET_ARCHITECTURE.md` §13.

**Assets:**
- the canonical Supabase database (schema, catalogue data, authoring history, release metadata);
- the migration/admin, authoring and publisher credentials;
- the Cloudflare deployment token;
- the immutable published artifacts and the production pointer (integrity of what the live app renders);
- the development Worker (low sensitivity by design, per §1.5, but still a public surface);
- the existing `LIVE_REPO_PAT` and the public `gac-helper` fallback repository.

**Trust boundaries:**
- the live PWA is untrusted-by-design with respect to the database: it holds no database credential and can only read public static artifacts (`TARGET_ARCHITECTURE.md` §13);
- GitHub Actions workflows are the only holders of the authoring/publisher/Cloudflare-deploy credentials; these are repository secrets, not committed to source, not printed to logs;
- the migration/admin credential is deliberately kept **outside** GitHub Actions entirely (§7), so a compromised or misconfigured workflow can never obtain schema-level access;
- the development Worker is a public, unauthenticated, `noindex` surface and must never be trusted with anything an attacker finding it by chance/crawl could misuse — this is a design constraint on what may ever be written to it, not a mitigation to be layered on afterward.

**Threats and mitigations:**

| Threat | Mitigation |
|---|---|
| A compromised GitHub Actions run exfiltrates the publisher or authoring credential | Credentials are least-privilege (§7); the publisher role cannot alter schema or policy; secrets are never echoed in workflow logs; the migration/admin credential is never present in Actions at all |
| A malicious or buggy PR triggers unintended production publication | Publication workflows use `workflow_dispatch` only, gated by repository secrets available only to the workflow, not to arbitrary PR contexts; there is no `pull_request` or `push` trigger on the production deployment workflow |
| Two production deployments run concurrently and race | GitHub Actions concurrency group (§4.2) |
| A candidate release is published against a stale base, silently discarding a concurrent change | Base-release re-check inside the advisory-locked transaction (§4.1 step 2), matching `TARGET_ARCHITECTURE.md` §9.2 |
| The development Worker leaks personal or operational data because it is public | Content constraint enforced by policy (§1.5): no credentials, ally codes, real roster data, or unredacted owner-identifying provenance may ever be written to any artifact served by any Worker, development or production; `noindex` further reduces incidental discovery via search engines (it does not, and is not relied upon to, prevent direct access) |
| A privileged database role is used from an untrusted context (e.g. accidentally checked-in in a fixture or test) | Stage-1 roles are limited to the ones actually in use (§7); Stage-2 dormant credentials are not created; `SECURITY DEFINER` functions, if retained, follow the controls in §9.1 below |
| Retrieved third-party evidence (Stage 2+) contains prompt-injection-style content aimed at an AI-assisted mapping/assessment step | Out of Stage-1 scope, but the architecture already requires (`TARGET_ARCHITECTURE.md` §13) that retrieved content is treated as untrusted data whose embedded instructions are never followed, and that no retrieval path can alter schema, policy, credentials, permissions, application code or the release pointer; this ADR does not weaken that requirement |
| The public `gac-helper` fallback repository or its `LIVE_REPO_PAT` is compromised | Unaffected by this ADR's changes; the existing allow-list sync in `deploy-to-live.yaml` (`[REPO-FACT]`) remains the only path that can write to it, and it is retired at the ARCH-112 exit gate, not before |
| A `SECURITY DEFINER` database function is invoked by an unintended role, bypassing row-level policy | See §9.1 |

### 9.1 `SECURITY DEFINER` requirements

If any `SECURITY DEFINER` function is retained in the Stage-1 schema, the following controls are mandatory, not optional hardening:

- the function is placed in a non-exposed schema (not `public`), so it cannot be discovered or invoked through the default PostgREST/API exposure path;
- the function sets a fixed, safe `search_path` explicitly (e.g. `SET search_path = pg_catalog, <owning_schema>`) so it cannot be tricked into resolving an attacker-controlled object;
- `EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated` by default;
- `EXECUTE` is granted only to the one intended role (e.g. the publisher role for a publication-finalization function);
- the function validates the requested operation internally (it does not trust caller-supplied state beyond what it independently re-checks — mirroring the deterministic applier's re-evaluation of policy in `TARGET_ARCHITECTURE.md` §8.4, §13);
- the function avoids dynamic SQL; where dynamic SQL is strictly necessary, all inputs are safely parameterised (`format(...)` with `%L`/`%I` or equivalent, never string concatenation);
- negative permission tests exist proving that a non-intended role (e.g. `anon`, `authenticated`, or another Stage-1 role) cannot execute the function, and cannot write the tables it protects directly.

**The live PWA must never hold any database credential**, `SECURITY DEFINER` or otherwise — this repeats §7 deliberately because it is a hard boundary, not a default that could erode function-by-function.

## 10. Recovery model

**[DECISION]**

### 10.1 Backup and recovery (Stage 1)

Raw `pg_dump` files are **not** committed to normal Git history during Stage 1. Instead, Stage-1 canonical state must be fully reconstructible from:

- **ordered database migrations** — the versioned schema history, applied from empty to reproduce structure;
- **append-only, committed authoring change files** — every human catalogue change, replayed through the authoring loader in order, to reproduce authored canonical content;
- **immutable published catalogue artifacts** — the versioned static JSON artifacts already retained per `TARGET_ARCHITECTURE.md` §9.3, which independently capture every historical published state without needing database access;
- **release metadata and provenance** — the `catalogue_releases` rows (and, once implemented, the `READY`/`DEPLOYED` extension in §4.1) tying each artifact to the migrations and authoring changes that produced it.

This reconstruction path is Stage-1-appropriate because Stage 1 has no autonomous mutation: every canonical change traces to either a migration or a human-authored, version-controlled change file, so there is nothing time-sensitive being generated outside those two append-only sources.

**Before Stage 2** stores evidence and assessment history that is *not* reconstructible this way (retrieved third-party observations, generated assessments), GATE-200 or the relevant Stage-2 work package must select an **encrypted, off-site logical-backup destination** and define retention and restore-testing procedures. This ADR deliberately does not preselect that destination, and explicitly does not preselect "commit raw dumps to Git" as an answer for it.

### 10.2 Supabase pausing

The database is outside the live application's runtime path (`TARGET_ARCHITECTURE.md` §2.8), so a paused free-tier Supabase project must **never** affect the live PWA. No daily keep-alive ping is added merely to defeat free-tier pausing — that would spend recurring scheduled compute solving a problem that does not exist for the live app.

Every manual or scheduled maintenance operation (authoring runs, candidate/review runs, publication runs, and any future Stage-2/3 evidence or scheduling work) must instead:

1. run a **database health preflight** before doing any real work;
2. **stop safely** if the project is unavailable or paused, without partial writes or a misleading failure;
3. **report the exact owner action needed to resume it** (Supabase's own resume/unpause action, stated in the failure output rather than requiring the owner to guess);
4. **permit the same logical run to resume idempotently afterward** — a preflight failure must not consume or corrupt the run's identity (e.g. a `maintenance_run_id` or authoring change ID), so re-running after the owner resumes the project continues cleanly rather than starting over or duplicating.

Current Supabase free-tier pausing behaviour (inactivity window, resume mechanism and latency) is **[ASSUMPTION]** and must be re-checked during ARCH-104 against Supabase's current documentation, since free-tier policies are time-sensitive.

## 11. Consequences for later work packages

- **ARCH-104** becomes the single guided manual configuration session referenced by `IMPLEMENTATION_PLAN.md` §5; it must re-verify every `[ASSUMPTION]` in this ADR (GitHub Free plan-feature limits, Supabase free-tier pausing behaviour, Cloudflare Workers versioned-deployment semantics, current cost and account-limit state) before creating the Supabase project or any secret, and must create only the Stage-1 roles listed in §7.
- **ARCH-105** implements the schema using the §7 role boundaries and, if any `SECURITY DEFINER` function is used, the §9.1 controls and negative permission tests as acceptance criteria, not optional follow-up.
- **ARCH-108** implements the §4.1 `READY`/`DEPLOYED` protocol precisely (including the new release `status` value and the recorded Cloudflare deployment identifier), the §4.2 recovery/reconciliation command, and the GitHub Actions concurrency group; its existing acceptance criteria in `IMPLEMENTATION_PLAN.md` ("two concurrent publishers cannot lose one another's changes", "artifact failure leaves the previous pointer current") are satisfied by this protocol rather than by a cross-system atomic transaction.
- **ARCH-109** and the PWA's cache/refresh logic continue to rely on the static pointer (§4) as authoritative for what the phone sees; no change to that principle is introduced here.
- **ARCH-110** must add explicit rehearsal of every row in the §4.2 failure-window table, plus the concurrency-group behaviour, to its required exercises.
- **ARCH-111/ARCH-112** own the actual origin/production-URL change and client-state migration; this ADR records the environment model and hosting decision they implement but performs none of the eight migration steps itself (export/import/cutover/fallback-retirement), per the control-thread instruction not to perform cutover actions in this task. The existing public `gac-helper` repository and its GitHub Pages deployment remain an untouched fallback through the Stage-1 acceptance window, and `LIVE_REPO_PAT` is retired only at the approved exit gate.
- **GATE-200 / Stage 2 work packages** own selecting the encrypted off-site backup destination deferred in §10.1, and own creating the Stage-2 evidence ingester, maintenance analyst and deterministic-applier roles that this ADR deliberately does not create.
- **`TARGET_ARCHITECTURE.md`** is updated alongside this ADR (see the corresponding diff) to remove the now-settled items from its deferred/open list and reflect the environment, publication and hosting model recorded here.

## 12. Time-sensitive assumptions ARCH-104 must re-check

All of the following are **[ASSUMPTION]**, not verified against a live provider in this session, and must be re-confirmed at the start of ARCH-104 before any project, secret or workflow is created:

1. GitHub Free's current Environments/required-reviewer entitlement for private repositories (§1.6, §2).
2. GitHub Free's current GitHub Pages entitlement for private repositories (§2).
3. Supabase's current free-tier project-slot limit and whether one slot genuinely remains available for this account (§1.3).
4. Supabase's current free-tier pausing/inactivity behaviour, resume mechanism, and any change to pausing policy (§10.2).
5. Supabase's current hosted-region availability and confirmation that London remains offered on the free tier (§3, §13.4 below).
6. Cloudflare Workers' current static-assets versioned-deployment semantics and whether artifact+pointer can genuinely be published as one atomic asset-manifest update (§4.1 step 4).
7. Cloudflare Workers' current free-tier request/asset limits relevant to serving both a development and a production Worker at no cost.
8. Current recurring cost, if any, for the exact Supabase and Cloudflare tiers selected, re-confirmed against §1.3/§1.4's "no new recurring cost unless explicitly approved" requirement from `TARGET_ARCHITECTURE.md` §17.

---

## 13. Summary of this ADR's status

This ADR is **Accepted** for Stage-1 planning purposes. It authorises no external-service creation, configuration, secret, environment, workflow dispatch, database, branch, or production release by itself — those actions occur only in ARCH-104 onward, each under its own explicit approval, per the control-thread instruction governing this task.
