# SWGOH GAC Helper — Architecture Implementation Plan

**Status:** Parked. Re-baselined 2026-09-29 after repository consolidation and successful GitHub Pages cutover. No active multi-stage architecture, Cloudflare or autonomous-maintenance programme is running.  
**Architecture authority:** [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) v0.7 and [`ADR-ARCH-115`](decisions/ADR-ARCH-115-one-repo-pages-delivery.md).  
**Prior detailed plan:** [`docs/archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md`](archive/architecture/IMPLEMENTATION_PLAN-2026-09-22.md).  
**Current behaviour authority:** [`SPEC.md`](SPEC.md).

## 1. 2026-09-29 re-baseline checkpoint

The architecture programme remains deliberately parked. The active delivery model is now intentionally simple:

- one public source repository: `nimbrethil81/gac-helper`;
- GitHub Pages production at `https://nimbrethil81.github.io/gac-helper/`;
- no permanent separate DEV Pages site;
- merge/push to `main` does **not** deploy production;
- production is published only through the manual `Deploy Pages Live` workflow;
- that workflow deploys an explicit allow-listed Pages artifact from `main`;
- the former stripped live repository is retained as `gac-helper-archive` for recovery/history only;
- Google Sheets remains canonical and Apps Script continues `action=data` and `action=roster`;
- completed database/migration/authoring/publisher assets remain preserved but paused;
- no evidence source, hosted maintenance database, scheduled runner or autonomous catalogue mutation is active.

The first one-repo Pages deployment completed successfully on 2026-09-29. Desktop Chrome and iPhone Safari were manually verified against the existing live URL.

## 2. Current operating model

### Human-directed application changes

1. Branch from `main` in `nimbrethil81/gac-helper`.
2. Keep CI/tests appropriate to the change green.
3. Open a PR and merge only after owner review unless explicitly authorised otherwise.
4. Perform local/browser/device validation where useful.
5. Run `Deploy Pages Live` manually only when the owner decides the change should ship.
6. Verify LIVE after deployment.

A normal documentation-only change is not in the Pages allow-list and therefore does not require production deployment.

### Human-directed catalogue changes

- edit the canonical Google Sheet deliberately;
- Apps Script continues to serve the resulting `action=data` payload;
- the PWA validates and caches the payload cache-first;
- no database publication/release process is required on the active path.

### Parked automation work

Do not create a hosted database, evidence-source integration, maintenance scheduler or autonomous publication path unless the owner explicitly restarts that programme through GATE-150/GATE-200.

## 3. Work-package disposition

| Package / gate | Current status | Current disposition |
|---|---|---|
| ARCH-101 Baseline/CI | **Complete — active foundation** | Keep. CI guards ordinary work. |
| ARCH-102 Platform decisions/threat model | **Complete — partially superseded** | Historical platform/security record. Hosting/private-repo assumptions superseded. |
| ARCH-103 Canonical/golden capture | **Complete — reusable asset** | Keep. |
| ARCH-104 Cloudflare manual configuration | **Superseded** | Historical only. Cloudflare is not active delivery. |
| ARCH-105 Database schema/permissions | **Complete — paused future asset** | Keep unchanged behind GATE-150. |
| ARCH-106 Migration loader/reconciliation | **Complete — paused future asset** | Keep unchanged behind GATE-150. |
| ARCH-107 Human authoring tooling | **Complete — paused future asset** | Keep unchanged behind GATE-150. Active authoring remains direct Sheet editing. |
| ARCH-108 Catalogue generator/publisher | **Phase A complete — paused future asset** | Keep behind GATE-150; host/provider assumptions must be revalidated before reuse. |
| ARCH-109 PWA catalogue cache | **Complete — active foundation** | Keep. Cache-first validated Apps Script loading remains enduring. |
| ARCH-110 Cloudflare integration/failure rehearsal | **Superseded** | Do not execute. |
| ARCH-111 One-repository consolidation/origin prep | **Complete in simplified form** | One active repo now adopted; no separate DEV origin retained. |
| ARCH-112 Production Cloudflare cutover/fallback | **Superseded** | No Cloudflare cutover. |
| GATE-150 Persistent maintenance store | **Parked — not entered** | Required before hosted database work is revived. |
| GATE-200 Evidence/runner entry | **Parked — not entered** | Required before evidence-driven maintenance resumes. |
| Stages 2–5 automated maintenance/bootstrap | **Parked — not started** | Preserve design only. |

## 4. What remains active architecture work

There is **no active multi-stage architecture programme**.

The current architecture is considered stable enough for ordinary human-directed feature and data work. Further architecture work should be driven by an actual problem rather than migration momentum.

Legitimate bounded maintenance includes:

- maintain CI and the manual Pages deployment workflow;
- keep the live Pages allow-list narrow;
- keep documentation consistent with the one-repository delivery model;
- maintain cache/offline behaviour;
- improve tests when a human-directed feature exposes a gap.

None of these actions implicitly restarts the parked database/evidence programme.

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

Their existence is not an instruction to deploy them.

## 6. Restart gates

### GATE-150 — persistent maintenance store

Before operationalising any paused database-backed asset:

1. confirm the capability is still wanted;
2. select a persistent Postgres-compatible provider;
3. verify current cost/free-tier/pausing/retention constraints;
4. revalidate the preserved implementation against that provider;
5. explicitly authorise creation of hosted state and credentials.

### GATE-200 — evidence and runner feasibility

Before evidence-driven maintenance:

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
- `main` is source, not automatically production.
- LIVE is the allow-listed Pages artifact produced by `Deploy Pages Live`.
- `gac-helper-archive` is recovery/history only and must not be used for normal deployment.
- Public repository visibility means no secret, credential, ally code, private roster data or unrelated personal identifier may rely on repository privacy.
- Google Sheet and Apps Script availability/access must not be changed while the PWA depends on `action=data`/`action=roster`.
- The PWA must keep the last-known-good catalogue usable through ordinary network/API refresh failures.
- Completed paused database work remains preserved unless a later explicit decision retires it.

## 8. Completion state of the one-repo migration

The migration is complete when:

- `gac-helper` is the sole active source repository;
- Pages uses GitHub Actions;
- `Deploy Pages Live` successfully publishes the allow-listed artifact;
- the existing live URL works on desktop and iPhone;
- the obsolete repo-to-repo deployment workflow is removed;
- ADR-115 and current architecture docs describe the one-repo topology;
- `gac-helper-archive` remains available as recovery/history but is outside the active path.
