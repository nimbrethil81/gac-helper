# ADR ARCH-115 — One-repository GitHub Pages delivery

**Status:** Accepted.  
**Decision date:** 2026-09-29.  
**Supersedes:** ADR-ARCH-114 for active repository topology, DEV/LIVE hosting topology and production deployment mechanism.  
**Does not supersede:** Google Sheets/Apps Script catalogue authority, cache-first PWA behaviour, paused database assets, GATE-150/GATE-200, or the security principles retained from earlier ADRs.

## Context

ADR-ARCH-114 retained two public repositories because that provided separate DEV and LIVE GitHub Pages sites with an explicit promotion boundary.

After further use, the owner concluded that a permanent DEV site is not currently worth the duplication for a single-user hobby application. The important control is not a second repository; it is ensuring that merging to `main` does not automatically publish production.

GitHub Pages supports deployment from a GitHub Actions artifact, so the production boundary can be retained inside one source repository with a manually triggered workflow.

## Decision

1. `nimbrethil81/gac-helper` is the sole active source repository.
2. The former source repository `gac-helper-dev` was renamed to `gac-helper`.
3. The former stripped live repository was renamed to `gac-helper-archive` and retained for recovery/history only.
4. GitHub Pages for `gac-helper` uses **GitHub Actions** as its source.
5. Production publication is performed only through the manually triggered `Deploy Pages Live` workflow.
6. Merging or pushing to `main` does **not** automatically deploy production.
7. `Deploy Pages Live` runs only for `main` in `nimbrethil81/gac-helper` and builds an explicit allow-listed Pages artifact.
8. Internal documentation, tests, Apps Script and paused architecture assets remain in the repository but are not included in the live Pages artifact.
9. The old cross-repository `Deploy to Live` workflow and its `LIVE_REPO_PAT` path are retired.
10. No permanent separate DEV Pages site is retained.
11. If a persistent DEV environment becomes genuinely useful later, it should be introduced deliberately without assuming a return to two repositories.
12. Cloudflare Workers remain outside the active application-delivery architecture.
13. Google Sheets remains the canonical catalogue and human authoring surface; Apps Script continues `action=data` and `action=roster`.
14. The PWA remains cache-first for catalogue loading.
15. Database/evidence/automation work remains parked behind the existing restart gates.

## Current topology

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

`gac-helper-archive` sits outside this topology and is retained only as recovery/history.

## Migration performed

The migration was executed in controlled stages on 2026-09-29:

1. a guarded manual Pages deployment workflow was added while the repository was still named `gac-helper-dev`;
2. the old live repository was renamed to `gac-helper-archive`;
3. the source repository was renamed from `gac-helper-dev` to `gac-helper`;
4. Pages source was switched to GitHub Actions;
5. `Deploy Pages Live` was run manually from `main`;
6. all deployment steps completed successfully;
7. `https://nimbrethil81.github.io/gac-helper/` was manually verified in desktop Chrome and iPhone Safari.

On iPhone Safari, the first normal-mode attempt briefly displayed the old loading shell while Private Browsing loaded the new site correctly. A subsequent normal Safari attempt loaded successfully without clearing site data. This was consistent with transient stale browser/service-worker state rather than a failed deployment.

## Consequences

### Benefits

- one canonical repository and one set of history/PRs/docs;
- no cross-repository deployment credential or synchronisation machinery;
- explicit production gate retained;
- production artifact remains narrowly allow-listed;
- existing LIVE URL retained;
- reduced repository/admin complexity for a single-user application.

### Trade-offs

- no permanent independently hosted DEV site;
- browser/device testing of unreleased work must use local/branch-aware methods rather than a standing DEV Pages URL;
- the source repository contains internal project material publicly, although the live Pages artifact remains stripped.

## Rollback / recovery

`gac-helper-archive` is retained as the historical stripped-live repository and can be used as a recovery reference if the new delivery model proves unsuitable.

A future change to repository topology or production hosting requires a new ADR. Routine application changes do not.
