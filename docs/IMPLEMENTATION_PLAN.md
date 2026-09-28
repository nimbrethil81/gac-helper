# SWGOH GAC Helper — Architecture Implementation Plan

**Status:** Parked. Re-baselined 2026-09-28 after the development repository became public and GitHub Pages returned as the DEV host. No Cloudflare cutover, repository-consolidation or autonomous-maintenance programme is active.  
**Architecture authority:** [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) v0.6 and [`ADR-ARCH-114`](decisions/ADR-ARCH-114-github-pages-public-repos.md).  
**Prior detailed plan:** [`docs/archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md`](archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md).  
**Current behaviour authority:** [`SPEC.md`](SPEC.md).

## 1. 2026-09-28 re-baseline checkpoint

The architecture programme remains deliberately parked. This checkpoint updates the platform assumptions without reactivating any larger work programme.

Confirmed decisions/state:

- `gac-helper-dev` is now **public**.
- Before the visibility change, repository contents were reviewed and a full-history Gitleaks scan across **195 commits** reported **no leaks found**.
- GitHub Pages is enabled for `gac-helper-dev` and the DEV app was manually verified at its Pages URL.
- The `gac-helper-dev` Cloudflare Worker has been deleted.
- `gac-helper` remains the public stripped LIVE repository and GitHub Pages production origin.
- The existing manual `Deploy to Live` workflow remains present and available as the production promotion gate.
- The owner explicitly chose to retain the **two-repository model for now** because it provides independent DEV and LIVE Pages URLs without another hosting mechanism.
- No production-origin migration is planned, so the former Cloudflare cutover/client-state migration work is not required.
- Google Sheets remains canonical and Apps Script continues both `action=data` and `action=roster`.
- The completed database/migration/authoring/publisher assets remain preserved but paused.
- No evidence source, hosted maintenance database, scheduled runner or autonomous catalogue mutation is active.

## 2. Current operating model

### Human-directed application changes

1. Work in `gac-helper-dev`.
2. Keep CI/tests appropriate to the change green.
3. Verify the change against the DEV GitHub Pages site where browser/device validation is useful.
4. Promote to `gac-helper` only through the explicit manual `Deploy to Live` action when the owner decides the change should ship.
5. Verify LIVE after promotion.

A normal documentation-only change is not part of the LIVE allow-list and therefore does not require production deployment.

### Human-directed catalogue changes

- edit the canonical Google Sheet deliberately;
- Apps Script continues to serve the resulting `action=data` payload;
- the PWA validates and caches the payload cache-first;
- no database publication/release process is required on the active path.

### Parked automation work

Do not create a hosted database, evidence-source integration, maintenance scheduler or autonomous publication path unless the owner explicitly restarts that programme through GATE-150/GATE-200.

## 3. Work-package disposition

| Package / gate | Current status | 2026-09-28 disposition |
|---|---|---|
| ARCH-101 Baseline/CI | **Complete — active foundation** | Keep. CI continues to guard ordinary work. |
| ARCH-102 Platform decisions/threat model | **Complete — partially superseded** | Historical platform/security record. Hosting/private-repo assumptions superseded by ADR-114. |
| ARCH-103 Canonical/golden capture | **Complete — reusable asset** | Keep. Capture contains catalogue/configuration evidence, not roster/GAC History; its old “private source repo” storage assumption is superseded by the public-repo re-baseline. |
| ARCH-104 Cloudflare manual configuration | **Superseded for active delivery** | Repository preparation remains historical evidence. The DEV Worker was later deleted; no Cloudflare production cutover is planned. |
| ARCH-105 Database schema/permissions | **Complete — paused future asset** | Keep unchanged behind GATE-150. |
| ARCH-106 Migration loader/reconciliation | **Complete — paused future asset** | Keep unchanged behind GATE-150. |
| ARCH-107 Human authoring tooling | **Complete — paused future asset** | Keep unchanged behind GATE-150. Active human authoring remains direct Sheet editing. |
| ARCH-108 Catalogue generator/publisher | **Phase A complete — paused future asset** | Keep unchanged behind GATE-150. No active static catalogue release pointer. |
| ARCH-109 PWA catalogue cache | **Complete — active foundation** | Keep. Cache-first validated Apps Script loading remains an enduring requirement. |
| ARCH-110 Cloudflare integration/failure rehearsal | **Superseded in original form** | Do not execute Cloudflare rehearsal. Ordinary DEV/LIVE Pages verification belongs to normal release practice instead. |
| ARCH-111 One-repository consolidation/origin prep | **Superseded/deferred by explicit decision** | Two repositories are deliberately retained; no active consolidation work. |
| ARCH-112 Production Cloudflare cutover/fallback | **Superseded** | No hosting-origin cutover is planned; LIVE stays on its current Pages origin. |
| GATE-150 Persistent maintenance store | **Parked — not entered** | Required before any hosted database/paused database path is revived. |
| GATE-200 Evidence/runner entry | **Parked — not entered** | Required before evidence-driven maintenance resumes. |
| Stages 2–5 automated maintenance/bootstrap | **Parked — not started** | Preserve design only; no autonomous progression. |

## 4. What remains active architecture work

There is **no active multi-stage architecture programme** after this re-baseline.

The current architecture is considered stable enough for ordinary human-directed feature and data work. Any maintenance now should be small and justified by an actual problem rather than continuing the former migration programme by momentum.

Examples of legitimate bounded maintenance:

- remove Cloudflare-specific workflows/configuration after confirming they are no longer referenced by anything needed for LIVE promotion;
- keep documentation consistent with the public-repository/Pages model;
- maintain CI and cache/offline behaviour;
- improve tests when a human-directed feature exposes a gap;
- retain the live deployment allow-list and explicit promotion boundary.

None of these actions implicitly restarts ARCH-105–108 deployment or Stages 2–5.

## 5. Preserved future architecture assets

The detailed 2026-09-22 implementation plan is preserved verbatim at [`docs/archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md`](archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md). Database-specific implementation records remain under `docs/database/`.

Preserved assets include:

- ARCH-103 canonical/golden capture and verification;
- provider-neutral Postgres schema/migrations/rollbacks;
- deterministic migration reconciliation;
- version-controlled human authoring tooling;
- catalogue generator/validator/publisher;
- tests and CI coverage supporting those components;
- evidence/policy/bootstrap safeguards documented by the prior target architecture.

They are retained because the design may be useful if evidence-driven maintenance becomes worthwhile later. Their existence is not an instruction to deploy them.

## 6. Restart gates

### GATE-150 — persistent maintenance store

Before operationalising any paused database-backed asset:

1. confirm the capability is still wanted;
2. select a persistent Postgres-compatible provider;
3. verify current cost/free-tier/pausing/retention constraints;
4. revalidate the preserved implementation against that provider;
5. explicitly authorise creation of hosted state and credentials.

No agent may create Supabase, Neon or another hosted maintenance database merely because migration assets exist in the repository.

### GATE-200 — evidence and runner feasibility

Before Stage 2 evidence-driven maintenance:

1. identify the exact provider/dataset;
2. verify permitted/reliable automated retrieval;
3. prove useful GAC mode/matchup semantics and representative samples;
4. verify recurring cost/rate limits/outage behaviour;
5. choose and prove the runner/scheduling mechanism;
6. report the gate result before implementation proceeds.

If either gate fails or is not worth the complexity, continue with the current human-authored Sheet model.

## 7. Standing delivery and safety rules

- `SPEC.md` describes shipped behaviour; `ROADMAP.md` describes future product work.
- No ordinary coding task may trigger production deployment unless explicitly authorised.
- The live repository remains an allow-listed deployment artifact, not the development source of truth.
- Public repository visibility means no secret, credential, ally code, private roster data or unrelated personal identifier may rely on repository privacy.
- Google Sheet and Apps Script availability/access must not be changed while the PWA depends on `action=data`/`action=roster`.
- The PWA must keep the last-known-good catalogue usable through ordinary network/API refresh failures.
- Completed paused database work remains preserved unless a later explicit decision retires it.
- Architecture/provider assumptions must be rechecked when a future decision actually depends on them.

## 8. Completion state of this re-baseline

This documentation re-baseline is complete when:

- ADR-114 records the accepted repository/hosting decisions;
- `TARGET_ARCHITECTURE.md` describes the public two-repository GitHub Pages topology as current;
- this plan no longer presents Cloudflare cutover or repository consolidation as pending execution;
- prior v0.5 architecture/22 Sep implementation detail is preserved in `docs/archive/architecture/`;
- ADR status is discoverable from `docs/decisions/README.md`;
- no application code, workflow, hosting setting or LIVE repository content is changed as part of the documentation-only re-baseline.
