# ADR ARCH-114 — Public repositories and GitHub Pages delivery

**Status:** Superseded by [`ADR-ARCH-115`](ADR-ARCH-115-one-repo-pages-delivery.md) for active repository topology and production delivery.  
**Decision date:** 2026-09-28.  
**Supersedes:** the active-hosting, private-development-repository, Cloudflare cutover and one-repository-target decisions in ADR-ARCH-102 and ADR-ARCH-113.  
**Does not supersede:** the Google Sheets/Apps Script catalogue model, cache-first PWA behaviour, paused database assets, evidence/automation safeguards, GATE-150 or GATE-200.

## Context

GAC Helper historically used two repositories: `gac-helper-dev` for development and `gac-helper` as a stripped public production artifact. The development repository was private, which made GitHub Pages unavailable on the owner's GitHub Free plan and led the Stage-1 architecture toward Cloudflare Workers for both development and production.

On 2026-09-28 the owner deliberately changed `gac-helper-dev` to public after reviewing the repository contents and running a full-history Gitleaks scan across 195 commits with no leaks found. GitHub Pages was then enabled and the development site was manually verified. The `gac-helper-dev` Cloudflare Worker was deleted.

The owner also reconsidered repository consolidation. A single repository would provide only one ordinary GitHub Pages site, whereas the current two-repository model naturally provides independent DEV and LIVE Pages URLs with a clear manual promotion boundary. Repository consolidation was therefore not adopted at this checkpoint.

> Historical note: on 2026-09-29 the owner subsequently chose the simpler one-repository model after deciding a permanent DEV Pages site was not necessary. See ADR-ARCH-115 for the current topology and delivery mechanism.

## Decisions

1. `nimbrethil81/gac-helper-dev` became a **public** repository and remained the development/source repository at this checkpoint.
2. `nimbrethil81/gac-helper` remained a **public, stripped production artifact repository** at this checkpoint.
3. DEV was served by GitHub Pages from `gac-helper-dev`.
4. LIVE remained served by GitHub Pages from `gac-helper`.
5. Privacy of the rendered DEV site was not a requirement.
6. The development Cloudflare Worker was deleted and Cloudflare Workers were **not part of the active application-delivery architecture**.
7. No production hosting-origin migration was planned.
8. The existing `Deploy to Live` workflow remained the explicit manual promotion gate from DEV to LIVE and synced only the allow-listed public application files.
9. The two-repository model was deliberately retained at this checkpoint because it provided two independent GitHub Pages origins and a simple DEV → LIVE promotion boundary without another hosting platform.
10. One-repository consolidation was neither required nor permanently rejected.
11. Because the LIVE origin was unchanged, the previously planned GitHub Pages → Cloudflare browser-state export/import and cutover window were no longer required.
12. Google Sheets remained the canonical catalogue and human authoring workbench; Apps Script continued to serve `action=data` and `action=roster`.
13. The PWA remained cache-first for catalogue loading.
14. The completed database schema, migration loader, authoring tooling and publisher remained preserved as **paused future-migration assets**.
15. Automated evidence-driven maintenance remained parked behind GATE-150 and GATE-200.
16. Cloudflare-specific repository assets could be removed through a separate bounded cleanup once their active role was gone.

## Historical topology

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

## Consequences at the time

### Benefits

- no Cloudflare deployment was required for normal DEV or LIVE hosting;
- no application-hosting origin cutover or local-storage migration was required;
- two stable environment URLs were available;
- the existing manual production promotion boundary remained simple;
- the architecture/automation programme could remain parked independently of ordinary human-directed product changes.

### Trade-offs

- source, internal documentation, tests and paused architecture assets in `gac-helper-dev` were publicly visible;
- the two repositories required promotion/synchronisation machinery;
- a future single-repository model would lose the second permanent Pages URL unless another mechanism was introduced.

## Supersession map

ADR-ARCH-115 now supersedes this ADR for active repository topology and production delivery.

The Google Sheets/Apps Script, cache-first and parked future-architecture decisions carried through this checkpoint remain in force through the later architecture where not otherwise superseded.

## Validation / rollback

This ADR records the 2026-09-28 interim state. It remains useful as historical rationale for why the two-public-repository model existed briefly before the 2026-09-29 consolidation.
