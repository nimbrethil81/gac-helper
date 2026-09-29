# SWGOH GAC Helper — Target Architecture

**Status:** v0.7 current architecture, re-baselined 2026-09-29. The application-delivery architecture below is current; the database/evidence/automation architecture remains parked future design.  
**Current platform authority:** [`docs/decisions/ADR-ARCH-115-one-repo-pages-delivery.md`](decisions/ADR-ARCH-115-one-repo-pages-delivery.md).  
**Current behaviour authority:** [`SPEC.md`](SPEC.md).  
**Prior detailed design:** [`docs/archive/architecture/TARGET_ARCHITECTURE-v0.5.md`](archive/architecture/TARGET_ARCHITECTURE-v0.5.md).

## 0. Current position

GAC Helper is a single-user hobby PWA. Its canonical counter catalogue is authored in Google Sheets and served through Google Apps Script.

Application source, tests, documentation, Apps Script and paused future-architecture assets now live in a single public repository: `nimbrethil81/gac-helper`.

Production is hosted at the repository's GitHub Pages site. Merging to `main` does **not** publish production automatically. Production publication is a separate, manually triggered `Deploy Pages Live` GitHub Action that builds and deploys an explicit allow-listed Pages artifact from `main`.

The previous stripped live repository has been retained separately as `gac-helper-archive` for recovery/history only. It is not part of the active delivery path.

The larger database-backed, evidence-driven counter-maintenance programme remains **parked**. Its completed schema, migration, authoring and publishing assets are preserved in the repository, but no hosted database, evidence source, scheduled runner or autonomous catalogue mutation is active.

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
                 v
        nimbrethil81/gac-helper
        source / tests / docs / CI
                 |
         manual Deploy Pages Live
                 |
                 v
        GitHub Pages LIVE
```

## 1. Architectural goals

The current architecture optimises for:

- simple, low-cost operation for a single-user hobby application;
- one canonical repository rather than source/artifact repository duplication;
- an explicit human production-promotion boundary;
- a stripped, allow-listed public Pages artifact even though the source repository is public;
- strong offline/cache behaviour during a GAC round;
- easy human catalogue authoring;
- minimal credential and cloud-service surface area;
- retention of tested future-migration assets without making them active dependencies.

## 2. Current application and data topology

### 2.1 Canonical catalogue and human authoring

Google Sheets remains the canonical catalogue and the day-to-day human authoring workbench.

Google Apps Script remains responsible for:

- `action=data` — builds and serves the catalogue/configuration payload consumed by the PWA;
- `action=roster` — proxies the roster request to Comlink.

Neither route may be retired while the current PWA depends on it.

### 2.2 Cache-first application

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

### 2.3 Repository and source of truth

`nimbrethil81/gac-helper` is the sole active source repository. It is public and contains:

- application source;
- tests and CI;
- documentation;
- Apps Script source;
- current product work;
- paused database/catalogue-maintenance assets.

There is no active separate development repository or production-artifact repository.

`gac-helper-archive` is retained only as a historical/recovery copy of the former stripped live repository. Normal development and deployment must not write to it.

### 2.4 Production deployment

Production is served by GitHub Pages from a GitHub Actions deployment artifact.

The manual `Deploy Pages Live` workflow:

1. can run only against `main` in `nimbrethil81/gac-helper`;
2. checks out the selected source commit;
3. builds `_site` from an explicit allow-list of public PWA files;
4. configures and uploads the Pages artifact;
5. deploys it to the `github-pages` environment.

The allow-list currently includes the public PWA shell/assets and `changelog.md`; internal docs, tests, Apps Script and paused architecture assets are not included.

An ordinary push, PR merge or documentation change does **not** publish production. Production promotion remains a deliberate human action.

### 2.5 Development/testing model

There is no permanent separate DEV Pages origin.

Normal change flow is:

1. branch from `main`;
2. implement and validate;
3. open PR and run CI;
4. owner merges to `main`;
5. perform local/browser/device validation where useful;
6. owner explicitly runs `Deploy Pages Live` when the change should ship;
7. verify LIVE after deployment.

A second persistent DEV site is not currently justified for a single-user hobby application. If that need becomes material later, it should be introduced deliberately rather than recreating repository duplication by default.

## 3. Hosting and platform decisions

GitHub Pages is the active production host.

Cloudflare Workers are **not** part of the active application-delivery architecture. The former development Worker and Worker deployment machinery have been removed.

The production URL remains:

`https://nimbrethil81.github.io/gac-helper/`

The 2026-09-29 repository consolidation reused the same LIVE URL. Desktop Chrome and iPhone Safari were manually verified after cutover. iPhone Safari initially showed a stale loading shell on first normal-mode access, while Private Browsing loaded correctly; a later normal reload also loaded successfully without clearing site data. No code rollback was required.

## 4. Security and public-repository boundary

The repository is public. Security therefore relies on correct content boundaries, not repository privacy.

Standing rules:

- no secrets or credentials are committed;
- no ally code, real roster data, authentication material or unrelated personal identifier is committed as an operational artifact;
- public repository content is treated as fully discoverable;
- the live Pages deployment remains allow-listed and fail-closed;
- future cloud/database credentials, if any, must never be made available to the PWA.

The former cross-repository `LIVE_REPO_PAT` deployment path is no longer required by active architecture.

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

[`ADR-ARCH-115`](decisions/ADR-ARCH-115-one-repo-pages-delivery.md) is the current authority for repository and application-delivery decisions.

[`ADR-ARCH-114`](decisions/ADR-ARCH-114-github-pages-public-repos.md) remains the historical record of the interim two-public-repository Pages model and is superseded for repository topology and deployment.

[`ADR-ARCH-113`](decisions/ADR-ARCH-113-stage1-rebaseline.md) remains authoritative for Google Sheets, Apps Script, cache-first behaviour, no active hosted database, preservation of paused assets and future automation gates where not superseded by later ADRs.

See [`docs/decisions/README.md`](decisions/README.md) for the status map.

## 8. Architecture-change rules

- `SPEC.md` describes shipped behaviour; do not use this document as release history.
- `ROADMAP.md` owns future product work.
- ordinary human-directed features may continue while the architecture/automation programme is parked;
- changing hosting, repository topology, catalogue runtime source, persistent store or autonomous-publication authority requires an explicit architecture decision;
- provider prices/limits and external-service behaviour are time-sensitive and must be rechecked when a future decision depends on them.

## 9. v0.7 re-baseline record — 2026-09-29

v0.7 records these changes from v0.6:

- the former live `gac-helper` repository was renamed to `gac-helper-archive` and retained as recovery history;
- the former source `gac-helper-dev` repository was renamed to `gac-helper`;
- GitHub Pages source was switched to GitHub Actions;
- the manually triggered `Deploy Pages Live` workflow successfully deployed an allow-listed artifact from `main`;
- the existing LIVE URL remained `https://nimbrethil81.github.io/gac-helper/`;
- desktop Chrome and iPhone Safari were verified after cutover;
- the old repo-to-repo `Deploy to Live` workflow became obsolete and is retired;
- the application now uses one active repository while preserving an explicit manual production-promotion boundary;
- Google Sheets, Apps Script, cache-first loading, paused database assets and future automation safeguards remain unchanged.
