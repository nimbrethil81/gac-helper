# ADR ARCH-114 — Public repositories and GitHub Pages delivery

**Status:** Accepted.  
**Decision date:** 2026-09-28.  
**Supersedes:** the active-hosting, private-development-repository, Cloudflare cutover and one-repository-target decisions in ADR-ARCH-102 and ADR-ARCH-113.  
**Does not supersede:** the Google Sheets/Apps Script catalogue model, cache-first PWA behaviour, paused database assets, evidence/automation safeguards, GATE-150 or GATE-200.

## Context

GAC Helper historically used two repositories: `gac-helper-dev` for development and `gac-helper` as a stripped public production artifact. The development repository was private, which made GitHub Pages unavailable on the owner's GitHub Free plan and led the Stage-1 architecture toward Cloudflare Workers for both development and production.

On 2026-09-28 the owner deliberately changed `gac-helper-dev` to public after reviewing the repository contents and running a full-history Gitleaks scan across 195 commits with no leaks found. GitHub Pages was then enabled and the development site was manually verified. The `gac-helper-dev` Cloudflare Worker was deleted.

The owner also reconsidered repository consolidation. A single repository would provide only one ordinary GitHub Pages site, whereas the current two-repository model naturally provides independent DEV and LIVE Pages URLs with a clear manual promotion boundary. Repository consolidation is therefore not an active architectural objective.

## Decisions

1. `nimbrethil81/gac-helper-dev` is a **public** repository and remains the development/source repository.
2. `nimbrethil81/gac-helper` remains a **public, stripped production artifact repository**.
3. DEV is served by GitHub Pages from `gac-helper-dev`.
4. LIVE remains served by GitHub Pages from `gac-helper`.
5. Privacy of the rendered DEV site is not a requirement.
6. The development Cloudflare Worker has been deleted and Cloudflare Workers are **not part of the active application-delivery architecture**.
7. No production hosting-origin migration is currently planned.
8. The existing `Deploy to Live` workflow remains the explicit manual promotion gate from DEV to LIVE and continues to sync only the allow-listed public application files.
9. The two-repository model is deliberately retained for now because it provides two independent GitHub Pages origins and a simple DEV → LIVE promotion boundary without another hosting platform.
10. One-repository consolidation is neither required nor permanently rejected. It may be reconsidered only if there is a concrete benefit that outweighs the need to provide a second environment URL by another mechanism.
11. Because the LIVE origin is unchanged, the previously planned GitHub Pages → Cloudflare browser-state export/import and cutover window are no longer required.
12. Google Sheets remains the canonical catalogue and human authoring workbench; Apps Script continues to serve `action=data` and `action=roster`.
13. The PWA remains cache-first for catalogue loading: it renders a validated last-known-good catalogue before background refresh and never overwrites that cache with an invalid/failed response.
14. The completed database schema, migration loader, authoring tooling and publisher remain preserved as **paused future-migration assets**. No hosted database is selected or active.
15. Automated evidence-driven maintenance remains parked. GATE-150 must select/revalidate a persistent maintenance store and GATE-200 must validate evidence/runner feasibility before that programme can resume.
16. Cloudflare-specific repository assets may remain temporarily while documentation is re-baselined; their removal is a separate bounded cleanup and must not disturb the current `Deploy to Live` path.

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
      +----------+----------+
      |                     |
gac-helper-dev          gac-helper
GitHub Pages DEV        GitHub Pages LIVE
      |                     ^
      +--- Deploy to Live --+
          manual gate
```

Catalogue publication and application deployment remain independent: a Sheet edit changes catalogue data without an application deployment; an application change is tested in DEV and promoted deliberately to LIVE.

## Consequences

### Benefits

- no Cloudflare deployment is required for normal DEV or LIVE hosting;
- no application-hosting origin cutover or local-storage migration is required;
- two stable environment URLs remain available;
- the existing manual production promotion boundary remains simple and understandable;
- the development repository being public removes the former private-Pages constraint and makes its ordinary GitHub-hosted Actions usage eligible for public-repository treatment under GitHub's current plan rules;
- the architecture/automation programme can remain parked independently of ordinary human-directed product changes.

### Trade-offs

- source, internal documentation, tests and paused architecture assets in `gac-helper-dev` are publicly visible;
- the two repositories continue to require a promotion/synchronisation workflow;
- a future single-repository model would need a different solution for a second persistent environment URL;
- Cloudflare-specific workflows/configuration now represent historical/prepared capability rather than active architecture and should be removed only through a separate cleanup after confirming they have no remaining role.

## Supersession map

### ADR-ARCH-102

Superseded for the active path:

- production hosting moving from GitHub Pages to Cloudflare Workers;
- the development Worker as the preview environment;
- private-repository GitHub Pages as the reason Cloudflare is required;
- the two-Worker active hosting model;
- Cloudflare application-deployment rollback/cutover requirements.

Retained as historical/future design where relevant:

- threat-modelling and least-privilege principles;
- manual production gating;
- deterministic/reversible publication principles for any future catalogue platform;
- database permission/security thinking for the paused database path.

### ADR-ARCH-113

Still in force:

- Google Sheets as canonical catalogue and human authoring surface;
- Apps Script `action=data` and `action=roster`;
- validated cache-first catalogue loading;
- no active hosted database;
- preservation of completed database tooling as paused assets;
- GATE-150 and future evidence-driven maintenance safeguards;
- controlled 5v5/3v3 bootstrap policy as future policy.

Superseded:

- private development repository;
- Cloudflare Workers as DEV/production delivery;
- Cloudflare deployment/rollback and production-origin cutover;
- one-repository consolidation as an active target.

## Validation / rollback

This ADR records decisions already carried out manually for repository visibility, DEV Pages and deletion of the DEV Worker. It authorises no live deployment and changes no application code.

If the Pages model later proves unsuitable, hosting can be reconsidered through a new ADR. The production repository and current LIVE Pages origin remain the recovery anchor until an explicitly approved successor architecture replaces them.
