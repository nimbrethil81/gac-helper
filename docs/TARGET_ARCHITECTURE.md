# SWGOH GAC Helper — Target Architecture

**Status:** v0.6 current architecture, re-baselined 2026-09-28. The application-delivery architecture below is current; the database/evidence/automation architecture remains parked future design.  
**Current platform authority:** [`docs/decisions/ADR-ARCH-114-github-pages-public-repos.md`](decisions/ADR-ARCH-114-github-pages-public-repos.md).  
**Current behaviour authority:** [`SPEC.md`](SPEC.md).  
**Prior detailed design:** [`docs/archive/architecture/TARGET_ARCHITECTURE-v0.5.md`](archive/architecture/TARGET_ARCHITECTURE-v0.5.md).

## 0. Current position

GAC Helper is a single-user hobby PWA whose canonical counter catalogue is authored in Google Sheets and served through Google Apps Script. Development and live application code remain in two public GitHub repositories, each with its own GitHub Pages site. Changes are developed and tested in `gac-helper-dev` and promoted deliberately to the stripped `gac-helper` production repository by the manual `Deploy to Live` workflow.

The larger database-backed, evidence-driven counter-maintenance programme is **parked**. Its completed schema, migration, authoring and publishing assets are preserved in the repository, but no hosted database, evidence source, scheduled runner or autonomous catalogue mutation is active.

```text
Google Sheet (canonical catalogue / human authoring)
        |
        v
Google Apps Script
  action=data     action=roster -> Comlink
        |                 |
        +--------+--------+
                 v
        cache-first PWA
                 |
      +----------+----------+
      |                     |
gac-helper-dev          gac-helper
GitHub Pages DEV        GitHub Pages LIVE
      |                     ^
      +--- Deploy to Live --+
          manual gate
```

## 1. Architectural goals

The current architecture optimises for:

- simple, low-cost operation for a hobby application;
- a clear DEV → LIVE promotion boundary;
- strong offline/cache behaviour during a GAC round;
- easy human catalogue authoring;
- minimal credential and cloud-service surface area;
- retention of tested future-migration assets without making them active dependencies;
- conservative, auditable automation if autonomous maintenance is deliberately revived later.

## 2. Current application and data topology

### 2.1 Canonical catalogue and human authoring

Google Sheets remains the canonical catalogue and the day-to-day human authoring workbench. A normal human-directed catalogue update is a deliberate edit to the Sheet; it does not require an application deployment, database release or generated static catalogue artifact.

Google Apps Script remains responsible for:

- `action=data` — builds and serves the catalogue/configuration payload consumed by the PWA;
- `action=roster` — proxies the roster request to Comlink.

Neither route may be retired while the current PWA depends on it.

### 2.2 Cache-first live application

The PWA must not depend on a remote catalogue fetch succeeding during a live GAC round.

The app therefore:

- stores a validated last-known-good catalogue locally under a versioned cache key;
- renders that known-good cache before network work when available;
- refreshes in the background;
- retains the cache on offline, timeout, HTTP, Apps Script or payload-validation failure;
- never overwrites a usable cache with an invalid/error response;
- refuses incompatible payloads cleanly;
- treats only a first launch with neither cache nor reachable valid catalogue as unusable.

This remains an enduring architecture principle independent of hosting provider.

### 2.3 Development repository and DEV Pages

`nimbrethil81/gac-helper-dev` is public and is the source/development repository. It contains source, tests, documentation, Apps Script, CI, current product work and the paused future-architecture assets.

Its GitHub Pages site is the normal development/test origin. DEV is intentionally public; it must nevertheless contain no credentials, ally codes, private roster data or other information that relies on obscurity for protection.

### 2.4 Production repository and LIVE Pages

`nimbrethil81/gac-helper` remains the stripped production repository and GitHub Pages LIVE origin.

The live repository intentionally contains only the allow-listed application artifact plus its live-owned README. Internal tests, docs, Apps Script and future architecture assets stay in the development repository and are not promoted by ordinary deployment.

### 2.5 Promotion to production

Application deployment is intentionally separate from catalogue authoring.

The manual `Deploy to Live` GitHub Action in `gac-helper-dev`:

1. checks out the development repository;
2. checks out the live repository using the existing deployment credential;
3. synchronises only the explicit public allow-list;
4. commits/pushes the resulting live artifact when it changed.

Production promotion remains a deliberate human action. An ordinary coding/documentation task must not trigger it unless explicitly authorised.

### 2.6 Repository model

The two-repository model is retained deliberately for now.

It provides:

- independent DEV and LIVE GitHub Pages origins;
- a simple promotion boundary;
- a stripped live artifact;
- no requirement for a second hosting provider merely to create a second environment URL.

One-repository consolidation is not an active objective. It may be reconsidered only when a concrete benefit justifies replacing the second Pages origin with another mechanism.

## 3. Hosting and platform decisions

GitHub Pages is the active static host for both DEV and LIVE.

Cloudflare Workers are **not** part of the active application-delivery architecture. The former development Worker was deleted on 2026-09-28. Cloudflare-oriented workflows/configuration may remain temporarily as historical/prepared assets until a separate bounded cleanup confirms they have no remaining role.

Because the LIVE origin remains the existing GitHub Pages origin:

- no production-origin cutover is planned;
- no one-time `localStorage` export/import is required for hosting;
- no Cloudflare fallback window or Worker rollback rehearsal is required;
- ordinary hosting rollback remains a source/deployment concern within the two-repository Pages model.

## 4. Security and public-repository boundary

The development repository is public. Security therefore relies on correct content boundaries, not repository privacy.

Standing rules:

- no secrets or credentials are committed;
- deployment credentials remain GitHub secrets rather than repository content;
- no ally code, real roster data, authentication material or unrelated personal identifier is committed as an operational artifact;
- public DEV content is treated as fully discoverable;
- the stripped live deployment remains allow-listed and fail-closed;
- future cloud/database credentials, if any, must never be made available to the PWA.

Before the 2026-09-28 visibility change, the repository was reviewed and a full-history Gitleaks scan across 195 commits reported no leaks.

## 5. Current catalogue architecture principles

The following principles from v0.5 remain accepted and continue to guide catalogue design even while the database-backed programme is parked:

- **Strategic identity over observed composition.** Canonical teams represent strategically meaningful archetypes, not every observed flex permutation.
- **Consolidation over proliferation.** Prefer the smallest useful catalogue that preserves meaningful matchup/resource differences.
- **Omission over unsupported precision.** Do not manufacture tier/banner/undersize certainty where evidence is insufficient.
- **Human authoring remains first-class.** Automation must complement, not make routine human corrections harder.
- **Evidence, judgement and publication are separate concerns** in any future autonomous-maintenance implementation.
- **Deterministic policy constrains semantic/AI analysis.** Semantic analysis may propose; deterministic validation/policy must control canonical mutation.
- **Publication must be reversible and validated** if/when a future generated catalogue replaces direct Sheet serving.
- **Cost/provider restraint.** Do not create paid or hosted infrastructure until the capability requiring it is ready and its cost/limits have been rechecked.

## 6. Parked future database-backed maintenance architecture

The detailed relational/evidence/automation design from v0.5 is preserved verbatim at [`docs/archive/architecture/TARGET_ARCHITECTURE-v0.5.md`](archive/architecture/TARGET_ARCHITECTURE-v0.5.md), with implementation records in `docs/database/` and the existing migration/scripts/tests directories.

The preserved design includes:

- a Postgres-compatible canonical catalogue model for units, team archetypes, profiles, matchups and accepted values;
- explicit authored authority states (`AUTHORED_LOCKED`, `AUTHORED_BASELINE`, `ASSESSED`);
- version-controlled human authoring without routine SQL;
- append-only evidence, mapping, assessment and finding records;
- deterministic policy application and anomaly circuit breakers;
- immutable/versioned publication concepts;
- independent 5v5 and 3v3 bootstrap/calibration stages;
- bounded publication waves rather than catalogue-completeness pressure;
- provenance, rollback and failure-injection requirements.

These remain useful future design, but they are **not active dependencies or instructions to resume work**.

### 6.1 GATE-150 — persistent maintenance store

No hosted database provider is selected.

Before any paused database-backed asset is operationalised, GATE-150 must deliberately:

- establish that the capability is still wanted;
- select a suitable persistent Postgres-compatible provider;
- recheck cost, free-tier constraints, pausing/retention and operational burden;
- revalidate the preserved schema/tooling against that provider;
- explicitly authorise credentials and hosted external state.

### 6.2 GATE-200 — evidence and runner feasibility

Before evidence-driven maintenance resumes, GATE-200 must identify and validate:

- the exact evidence provider/dataset;
- lawful/permitted automated retrieval;
- available matchup/mode semantics and sample sizes;
- recurring cost and rate limits;
- a deterministic runner/scheduling mechanism;
- safe failure/retry behaviour.

If these gates do not pass, the current Sheet-backed human-authoring model remains the intended operating model.

## 7. Current versus historical decisions

[`ADR-ARCH-114`](decisions/ADR-ARCH-114-github-pages-public-repos.md) is the current authority for hosting/repository decisions.

[`ADR-ARCH-113`](decisions/ADR-ARCH-113-stage1-rebaseline.md) remains authoritative for Google Sheets, Apps Script, cache-first behaviour, no active hosted database, preservation of paused assets and future automation gates; its Cloudflare/private-repository/consolidation decisions are superseded.

[`ADR-ARCH-102`](decisions/ADR-ARCH-102-platform.md) is historical for the original Cloudflare/platform selection. Its security, least-privilege, manual-gate and future-publication reasoning remains useful where not contradicted by later ADRs.

See [`docs/decisions/README.md`](decisions/README.md) for the status map.

## 8. Architecture-change rules

- `SPEC.md` describes shipped behaviour; do not use this document as release history.
- `ROADMAP.md` owns future product work.
- ordinary human-directed features may continue while the architecture/automation programme is parked;
- changing hosting, repository topology, catalogue runtime source, persistent store or autonomous-publication authority requires an explicit architecture decision;
- provider prices/limits and external-service behaviour are time-sensitive and must be rechecked when a future decision depends on them.

## 9. v0.6 re-baseline record — 2026-09-28

v0.6 records these changes from v0.5:

- `gac-helper-dev` became public after repository review and a 195-commit Gitleaks scan reported no leaks;
- GitHub Pages was enabled and manually verified for DEV;
- the DEV Cloudflare Worker was deleted;
- LIVE remained on the existing `gac-helper` GitHub Pages origin;
- the two-repository model was explicitly retained for now because it provides two independent Pages sites and a clear promotion boundary;
- Cloudflare delivery, one-repository consolidation and production-origin/client-state cutover ceased to be active architecture goals;
- Google Sheets, Apps Script, cache-first loading, paused database assets and future automation safeguards remained unchanged;
- detailed v0.5 future architecture was preserved in the archive rather than discarded.
