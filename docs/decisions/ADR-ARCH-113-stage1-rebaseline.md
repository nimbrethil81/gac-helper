# ADR ARCH-113 — Stage-1 delivery re-baseline: Google Sheets authoring and Cloudflare delivery

**Status:** Accepted.
**Decision date:** 2026-09-22.
**Repository evidence SHA:** `1ae213ce48be1f9af096deda43bfb3ea70976501` (confirmed as the tip of `origin/main`, and confirmed to contain pull request #17, "Document controlled 5v5 and 3v3 bootstrap stages").

**Identifier note.** `ARCH-113` is a decision-record identifier only. It is **not** a new implementation work package. The Stage-1 work packages remain ARCH-101–ARCH-112, re-scoped where this ADR requires it in [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md).

**Scope.** This ADR re-baselines the **active Stage-1 delivery path** following the decision not to create a third Supabase Free project. It supersedes the now-inapplicable database-hosting, static-catalogue-publication and Supabase-configuration parts of [`ADR-ARCH-102-platform.md`](ADR-ARCH-102-platform.md), and leaves the rest of that ADR in force. It changes documentation only: it creates, configures or modifies no external service, database, Worker, secret, environment, workflow, Google Sheet, Apps Script deployment or production release, and it deletes no completed implementation work.

## Evidence labels

The labels from ADR-ARCH-102 are reused unchanged:

- **[REPO-FACT]** — directly observed in this repository at the evidence SHA above.
- **[PROVIDER-FACT]** — externally verified against a live provider console, API or documentation in this session. (None are used in this ADR; no external verification was performed.)
- **[INFERENCE]** — a conclusion drawn from repository facts plus stated, general platform behaviour, not independently re-verified here.
- **[DECISION]** — an accepted decision from the control thread, recorded as authoritative regardless of its evidentiary basis.
- **[ASSUMPTION]** — a claim about external-provider behaviour, pricing, limits or terms **not** verified in this session, which must be re-checked before it is relied upon.

---

## 1. Accepted decisions

1. **[DECISION]** **Google Sheets remains the canonical catalogue and the day-to-day human authoring workbench** for the active Stage-1 path. It is not a migration source awaiting replacement in this stage; it is the live authoring surface.
2. **[DECISION]** **Google Apps Script remains the live catalogue API (`action=data`) and the roster proxy (`action=roster`)** ([REPO-FACT] both routes are served by the single `API_URL` in `app.js:3`, used at `app.js:1594` and `app.js:1673`). Neither route is retired in Stage 1.
3. **[DECISION]** The PWA gains **cache-first loading of the validated Apps Script catalogue payload**. A previously loaded, validated catalogue remains usable through a temporary connection failure or an Apps Script failure. This closes the gap [REPO-FACT] recorded in `TARGET_ARCHITECTURE.md` §1: a failed catalogue fetch currently prevents normal startup.
4. **[DECISION]** The private GitHub repository remains the development source of truth, and delivery is consolidated onto **Cloudflare Workers with separate development and production deployments**.
5. **[DECISION]** **Production deployment remains manual**, occurring only from a reviewed, merged pull request through an explicit manual workflow. This preserves ADR-ARCH-102 §1.6's repository-secrets-plus-`workflow_dispatch` gate.
6. **[DECISION]** **No Supabase project, Neon project, database credential, hosted database migration, database authoring path or database-backed publication path is part of the active Stage-1 implementation.**
7. **[DECISION]** The already-implemented database schema, migration loader, authoring tooling and catalogue publisher are **valuable future migration assets**. Their completed history, evidence and documentation are preserved as-is. Their hosted deployment and operationalisation are marked **paused**, not abandoned, deleted, downgraded or rewritten.
8. **[DECISION]** **Automated evidence-driven maintenance remains a future roadmap capability.** Before it resumes, an explicit future decision must select a persistent maintenance store (for example Neon or another managed Postgres provider) and revalidate the paused database path. That decision is gated at **GATE-150** (§9).
9. **[DECISION]** The controlled `5V5` and `3V3` bootstrap/calibration policy added by pull request #17 **remains valid**. It is future automated-maintenance policy. It is **not** a prerequisite for, or a dependency of, the revised Stage-1 delivery path.

---

## 2. What this ADR supersedes in ADR-ARCH-102

Only the following parts of ADR-ARCH-102 are superseded, and only for the **active** path. Each remains the authoritative record of the paused database path, to be revalidated at GATE-150 rather than rewritten now.

| ADR-ARCH-102 element | Status after this ADR |
|---|---|
| §1.3 Use of the remaining free Supabase project slot for GAC Helper | **Superseded.** No Supabase project is created. The slot is not claimed. |
| §1.4 Reversibility of the Supabase-slot allocation | **Superseded as moot.** No allocation exists to reverse. |
| §3 Environment model, "Hosted canonical" — exactly one hosted Supabase project as the Stage-1 canonical database | **Superseded.** There is no hosted canonical database in Stage 1. The local disposable Postgres instance remains the only database the repository's tooling uses, for tests and rehearsal. |
| §3 Environment model, "Static hosting environments" | **In force**, unchanged: a development Worker and a production Worker (§3 of this ADR). |
| §4 Static artifact and pointer design (immutable `catalogue/v{version}.json` artifacts and a `catalogue/current.json` pointer) | **Superseded as the active live-data path.** Retained as the paused path's design. The active path's catalogue source is the Apps Script `action=data` payload. |
| §4.1 `READY`/`DEPLOYED` distributed publication protocol, §4.2 recovery table | **Superseded as active Stage-1 work.** Retained, unchanged and implemented (ARCH-108 Phase A), as the paused path's protocol. Its *principles* — verify after deploy, never advertise an unverified release, idempotent recovery — remain in force for Cloudflare application deployment (§6). |
| §6 Payload schema v1 outline | **Superseded as the active app contract.** The active app contract is the existing `action=data` contract in `SPEC.md` §5. Payload schema v1 remains the paused path's target contract. |
| §7 Stage-1 secret and role inventory — the database rows (`SUPABASE_DB_URL`/equivalent, migration/admin, authoring, publisher and backup/export roles) | **Superseded for Stage 1.** No database role, connection secret or credential is created. The Cloudflare API token and the existing `LIVE_REPO_PAT` rows remain in force. |
| §7 "The live PWA holds **no** database credential of any kind" | **In force and strengthened.** On the active path there is no database at all (§7 of this ADR). |
| §10.1 Stage-1 backup/recovery reconstruction model | **Superseded as moot** while no hosted database exists. The Google Sheet plus the committed ARCH-103 capture are the active path's recovery evidence. The model is revalidated at GATE-150. |
| §10.2 Supabase pausing, preflight/fail-safe/resume pattern | **Superseded as moot** for Stage 1; revalidated against whichever provider GATE-150 selects. |
| §12 items 3, 4, 5 and 8, insofar as they concern Supabase project slots, pausing, London region and Supabase cost | **Superseded.** ARCH-104 no longer re-checks them. Items 1, 2, 6 and 7 (GitHub Free entitlements and Cloudflare semantics/limits) remain ARCH-104's to re-check. |

Nothing else in ADR-ARCH-102 is superseded, weakened or reinterpreted by this ADR.

## 3. What ADR-ARCH-102 still decides

These remain in force, unchanged, and this ADR depends on them:

- **§1.2 Cloudflare Workers as the production static host**, replacing GitHub Pages, because the account is GitHub Free and private-repository Pages is unavailable to it.
- **§1.5 Development Worker controls** — publicly reachable, `noindex`, no credentials or personal data, treated as a preview environment and never as an access-controlled one.
- **§1.6 Manual production gate** — repository secrets plus explicit `workflow_dispatch`, in place of GitHub Environments.
- **§1.7 / §8 Mandatory manual operation** — every operational path must be runnable manually and must be the same code path any future scheduled trigger would reuse. On the active path this covers development deployment, production deployment and deployment rollback; the authoring, candidate/review and database publication runs pause with the database path.
- **Cache validation principles** — validate HTTP status, schema and required fields before use; never overwrite a known-good cache with an invalid or failed response; refuse an incompatible payload cleanly; never treat an error body as a catalogue. These now apply to the Apps Script payload instead of a static artifact.
- **§9 Threat model**, minus the assets that no longer exist (the database and its credentials). The development Worker's content constraint, the workflow-trigger constraints and the untrusted-third-party-content rule are unchanged.
- **§9.1 `SECURITY DEFINER` requirements** — retained in full for the paused schema; [REPO-FACT] the ARCH-105 schema contains no `SECURITY DEFINER` function and its test suite asserts their absence.
- **Client-state cutover precautions** — the production origin change strands browser `localStorage` unless client state is explicitly exported and imported. This remains ARCH-111/ARCH-112 work and is unchanged by this ADR.
- **Conservative automated-maintenance safeguards** — evidence gating, deterministic policy application, authority states, anomaly circuit breakers and the bootstrap/steady-state separation. All remain future policy, all remain intact.

---

## 4. The active Stage-1 delivery path

```text
Google Sheets (canonical catalogue, human authoring)
        |
        v
Apps Script  action=data  (catalogue API)        Apps Script  action=roster  (Comlink proxy)
        |                                                 |
        +---------------------+---------------------------+
                              v
                    PWA: fetch, validate, cache
                    render known-good cache first,
                    refresh in the background
                              ^
                              |
          Cloudflare Workers static assets (the PWA itself)
          development Worker            production Worker
                              ^
                              |
        Private GitHub repository -> reviewed, merged PR -> manual workflow_dispatch
```

- **Authoring** is a human editing the Google Sheet. There is no change file, loader, dry run or release for the active path.
- **The catalogue** is whatever `action=data` returns, validated by the PWA before it replaces a cached payload.
- **Delivery** is the PWA's own code and assets, deployed to two Cloudflare Workers.
- **The catalogue and the deployment are independent.** Publishing a catalogue change means editing the Sheet; it requires no deployment, no release row and no pointer.

## 5. Rejected alternatives

- **Creating a third Supabase Free project.** Rejected by the owner decision this ADR records. It would consume the last free project slot on a Stage-1 path whose live application, by design, never reads the database. The resulting benefit does not justify the slot, the credential surface or the operational obligations (pausing, preflight, recovery) that come with it.
- **Publishing the catalogue from Sheets to GitHub as a static release.** Rejected for now. The proposal was to capture `action=data`, review the captured payload, commit it, and release it as a static artifact. For a **single human author**, this adds a routine capture, review and release cycle to every catalogue edit — a change that is currently one cell edit visible to the app immediately — without a corresponding benefit: there is no second author to coordinate with, no review population, and no concurrency to serialise. It also re-creates the distributed-publication problem (artifact, pointer, verification, rollback) that the database path already solved, for a payload the Sheet can already serve. Cache-first loading in the PWA (§1.3) delivers the resilience that was the proposal's main attraction, at a fraction of the friction. This rejection is "for now", not permanent: it becomes attractive again if authorship widens or if `action=data` proves insufficiently reliable in practice.
- **Selecting Neon (or any other managed Postgres provider) now.** Rejected as premature. Neon is a **future option, not a selected provider**. Selecting a provider before the maintenance capability that needs it is scoped repeats the mistake this re-baseline corrects. GATE-150 (§9) owns the selection.
- **Deleting, reverting or downgrading the completed database work (ARCH-105–ARCH-108).** Rejected. The schema, migration loader, reconciliation evidence, authoring tooling and publisher are complete, tested and independently verified [REPO-FACT]. They are provider-neutral Postgres and remain the most valuable prepared asset for any future maintenance store. Removing them would destroy verified work to tidy a document.
- **Making the Google Sheet or the Apps Script deployment private, restricted or removed.** Rejected while the PWA depends on `action=data` (§7).
- **Treating GitHub plus Cloudflare as free of distributed-state concerns.** Rejected as inaccurate (§6).

---

## 6. Distributed state on the revised path

The revised path is simpler than the database path in one specific way: **the database is no longer in the live catalogue path**, so no cross-system release protocol is needed to publish catalogue data. That is the whole of the simplification, and it must not be overstated.

The following remain real, and remain ARCH-110's and ARCH-111/ARCH-112's to exercise:

- **Deployment status.** A Cloudflare deployment can fail, partially propagate, or succeed while serving different content from what the deploying commit contained. A deployment that has not been verified has not succeeded.
- **Post-deploy verification.** After a production deployment, the deployed origin must be checked over HTTP: the app loads, the expected build is being served, and the catalogue fetch against `action=data` succeeds from that origin.
- **Rollback.** A bad deployment must be reversible to a known-good prior version, and that reversal must itself be verified. Rollback must not depend on the Apps Script deployment or on the Sheet being in any particular state.
- **Two origins during cutover.** While the GitHub Pages origin and the Cloudflare origin both serve the app, they hold **separate** browser state (`localStorage` is origin-keyed) and may serve different builds. This is state divergence between two live systems, and it is exactly why the one-time export/import in ARCH-111/ARCH-112 exists.
- **Two deployments after cutover.** The development Worker and the production Worker can drift. The development Worker's content constraints (ADR-ARCH-102 §1.5) apply permanently, not just during the cutover.
- **A shared external dependency.** Both origins, and both Workers, depend on the same Apps Script deployment. An Apps Script failure affects every environment at once. Cache-first loading (§1.3) is the mitigation, and its failure behaviour is a required ARCH-110 exercise.

## 7. Standing constraints

- **The Google Sheet and the Apps Script deployment must not be made private, restricted or removed while the PWA depends on `action=data`.** This includes narrowing the Apps Script deployment's access setting, changing its deployment URL without a coordinated app change, or archiving the Sheet. Any such change breaks the live application for every user on every origin. Retiring `action=data` was previously planned for Stage 1; it is now explicitly deferred, and may not happen until a replacement catalogue path is live and accepted.
- **The live PWA never holds a database credential**, of any kind, in any environment. On the active path this is trivially satisfied because no database exists; it remains a hard boundary that no future work package may erode, restated from ADR-ARCH-102 §7 and §9.1.
- **No agent may create a Supabase project, a Neon project, a database credential or any hosted database resource** as part of active Stage-1 work. Doing so requires GATE-150 and an explicit owner decision.
- **No agent may trigger production deployment** except under a work package that explicitly authorises it.

## 8. Paused assets

The following are **paused**: complete, preserved, unchanged, and not on the active Stage-1 critical path.

| Asset | Location | State |
|---|---|---|
| Stage-1 database schema, roles, RLS and rollbacks | `supabase/migrations/`, `supabase/rollbacks/` | Complete, tested against disposable Postgres, never applied to a hosted project |
| Migration loader, reconciliation and compatibility verification | `scripts/migration-*.js`, `data/migration/` | Complete and independently re-verified |
| Human authoring change files, validator, dry run and loader | `scripts/authoring-*.js`, `data/authoring/` | Complete; operational sign-off deferred with the publisher |
| Catalogue generator, validators, publisher, reconciliation and rollback | `scripts/catalogue-*.js` | Phase A complete; Phase B (connected verification) paused |
| Manual catalogue publication workflow | `.github/workflows/publish-catalogue.yml` | Present, manual-only (`workflow_dispatch`), never run; not part of the active path |
| ARCH-103 golden capture and source-tab exports | `data/exports/20260921T085937Z/` | Immutable evidence; still verified by `npm run baseline:verify` in CI |
| Database package documentation | `docs/database/ARCH-105.md`–`ARCH-108.md` | Preserved; status notes added, technical content unchanged |

**Preservation rules.** These assets keep their tests, their CI coverage and their completion records. They are not reverted, rewritten, downgraded to drafts, or described as failed or abandoned. A future work package may amend them additively after GATE-150, under delivery principle 18.

---

## 9. GATE-150 — persistent maintenance-store decision gate

**[DECISION]** A new gate, **GATE-150**, sits between Stage 1 and any Stage-2 automated-maintenance implementation. It must produce an explicit `GO`, `GO WITH LIMITS` or `STOP` before the paused database path may be deployed or operationalised.

GATE-150 must:

1. **Select a persistent maintenance-store provider** — Neon, another managed Postgres provider, a self-hosted instance, or a reconsidered Supabase project — with the selection recorded as a decision, not an assumption.
2. **Assess cost and free-tier constraints** for that provider against `TARGET_ARCHITECTURE.md` §17's "no new recurring cost unless explicitly approved" rule, including pausing/inactivity behaviour, storage limits, connection limits and region availability.
3. **Revalidate the paused database implementation** against the selected provider before any deployment: apply the ordered migrations, re-verify the role boundary and RLS, re-run the migration loader and reconciliation against the then-current Sheet data, and complete ARCH-108's Phase-B connected verification list.
4. **Re-verify the superseded ADR-ARCH-102 assumptions** that apply to the selected provider (§2), since they were Supabase-specific and are time-sensitive regardless.
5. **Decide the catalogue's canonical home at that point** — whether the database becomes canonical (with the Sheet retiring on a planned, reversible cutover) or remains a maintenance-side store beside a Sheet that stays canonical.

GATE-150 and GATE-200 are independent and may be investigated in either order or in parallel, but **both** must be resolved before Stage 2 implementation begins. GATE-200's no-go rule is unchanged: if no permitted, sufficiently granular and acceptably priced evidence source exists, Stages 2–5 do not happen, and GATE-150 becomes moot.

## 10. Consequences for work packages

- **ARCH-104** is re-scoped to **Cloudflare-only manual configuration and connected deployment preparation**. It must not instruct the owner to create a Supabase project, a database user, a database secret or a Supabase workflow. It re-checks ADR-ARCH-102 §12 items 1, 2, 6 and 7 only.
- **ARCH-105, ARCH-106 and ARCH-107** remain `Complete`. Their completion evidence is factual history and is not rewritten. They become **paused future-migration assets** (§8).
- **ARCH-108** remains Phase-A complete. Its Phase-B connected verification is **paused**, moving behind GATE-150. Its checked-in workflow and commands remain present and unrun.
- **ARCH-109** is re-scoped to **validated, cache-first loading of the Apps Script `action=data` payload**. It must not rely on a static catalogue pointer or artifact. The split-endpoint work reduces to configuration clarity, since both routes remain on the same Apps Script deployment.
- **ARCH-110** becomes the **Stage-1 integration and rehearsal checkpoint for the revised path**: cache behaviour, Apps Script failure fallback, Cloudflare development and production deployment, deployment rollback, and cutover readiness. Database-connected verification, database role/permission verification, database reconciliation and database-backed publication leave the active Stage-1 exit criteria and become GATE-150 requirements.
- **ARCH-111 and ARCH-112** are unchanged in purpose: one-repository Cloudflare consolidation and the real production-origin cutover, including temporary preservation of the existing GitHub Pages site and the owner's one-time browser-state export/import plus roster re-import. Their static-catalogue assumptions are removed.
- **GATE-150** is new (§9). **GATE-200** is unchanged.
- **Stages 4 and 5** (the `5V5` and `3V3` bootstrap/calibration stages from pull request #17) are unchanged and remain future work. They are not a Stage-1 dependency and must not be activated by Stage-1 work.

## 11. Time-sensitive assumptions to re-check

All **[ASSUMPTION]**, none verified in this session:

1. GitHub Free's current Environments/required-reviewer entitlement for private repositories (ADR-ARCH-102 §12 item 1) — ARCH-104.
2. GitHub Free's current GitHub Pages entitlement for private repositories (ADR-ARCH-102 §12 item 2) — ARCH-104.
3. Cloudflare Workers' current static-assets and versions/deployments semantics, including rollback limitations and retention (ADR-ARCH-102 §12 item 6) — ARCH-104.
4. Cloudflare Workers' current free-tier request and asset limits for serving both a development and a production Worker at no cost (ADR-ARCH-102 §12 item 7) — ARCH-104.
5. Google Apps Script's current quotas, execution limits and availability characteristics for `action=data` under cache-first load, and its behaviour as an availability dependency shared by both origins — ARCH-109/ARCH-110.
6. That `action=data` remains fetchable from the new Cloudflare origin under the Apps Script deployment's current access and cross-origin behaviour. The app fetches it cross-origin today from GitHub Pages [REPO-FACT], but the new origin has not been tested — ARCH-110, before cutover.
7. Whichever provider GATE-150 selects: cost, free-tier limits, pausing behaviour, region availability and connection method.

---

## 12. Status

This ADR is **Accepted** for Stage-1 planning purposes. It authorises no external-service creation, configuration, secret, environment, workflow dispatch, database, deployment or production release. `TARGET_ARCHITECTURE.md` (v0.5) and `IMPLEMENTATION_PLAN.md` are updated alongside it to reflect the revised active path; `SPEC.md`, `README.md`, `ROADMAP.md` and `changelog.md` are deliberately unchanged, because no shipped behaviour, headline capability, roadmap item or release has changed.
