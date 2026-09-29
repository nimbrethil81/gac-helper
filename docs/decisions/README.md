# Architecture decision status

| ADR | Current status | Role |
|---|---|---|
| `ADR-ARCH-102-platform.md` | **Partially superseded** | Historical platform/threat-model record. Cloudflare hosting/private-repo assumptions are superseded; security and future-publication principles remain useful. |
| `ADR-ARCH-113-stage1-rebaseline.md` | **Partially superseded** | Google Sheets, Apps Script, cache-first behaviour and paused database decisions remain current. Cloudflare delivery/private-repo/consolidation decisions are superseded. |
| `ADR-ARCH-114-github-pages-public-repos.md` | **Superseded by ADR-ARCH-115 for active delivery** | Historical record of the interim two-public-repository GitHub Pages model. |
| `ADR-ARCH-115-one-repo-pages-delivery.md` | **Accepted — current platform/delivery authority** | One public source repository, GitHub Actions Pages deployment, manual `Deploy Pages Live`, no permanent DEV Pages site, no active Cloudflare hosting. |

Read the ADRs in order when historical rationale matters. For current implementation work, `ADR-ARCH-115` wins wherever repository topology or delivery decisions conflict.
