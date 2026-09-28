# Architecture decision status

| ADR | Current status | Role |
|---|---|---|
| `ADR-ARCH-102-platform.md` | **Partially superseded** | Historical platform/threat-model record. Cloudflare hosting/private-repo assumptions are superseded by ADR-ARCH-114; security and future-publication principles remain useful. |
| `ADR-ARCH-113-stage1-rebaseline.md` | **Partially superseded** | Google Sheets, Apps Script, cache-first behaviour and paused database decisions remain current. Cloudflare delivery/private-repo/consolidation decisions are superseded by ADR-ARCH-114. |
| `ADR-ARCH-114-github-pages-public-repos.md` | **Accepted — current platform/delivery authority** | Two public repositories, GitHub Pages for DEV and LIVE, manual `Deploy to Live`, no active Cloudflare hosting migration. |

Read the ADRs in order when historical rationale matters. For current implementation work, `ADR-ARCH-114` wins wherever the hosting/repository decisions conflict.
