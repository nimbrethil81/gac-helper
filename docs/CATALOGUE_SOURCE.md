# Git-native catalogue source

**Scope.** Contributor and operator procedure for the Git-authored catalogue in `catalogue/` (issue #41, [`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md)): layout, import, compile, release record and corrections. The schema and payload contracts are owned by ADR-ARCH-116 §4–§7; validation rules and severities are owned by the shared audit ([`CATALOGUE_AUDIT.md`](CATALOGUE_AUDIT.md)). **Production still reads the Google Sheet through Apps Script**; nothing here is served until a separately approved cutover, and [`SPEC.md`](SPEC.md) continues to describe the Sheet runtime.

**Update this document when** the source layout, commands, correction procedure or migration status changes.

## Layout

| Path | Role |
|---|---|
| `catalogue/source/*.json`, `catalogue/source/matchups/{5v5,3v3,FLEET}.json` | Authoring input (ADR-ARCH-116 §4): one row per line, `"schema": 1`. `units`, `counters` and matchup `defences` must stay sorted by ID/name (code-unit order). The importer also sorts defence teams and compositions by defence then mode. |
| `catalogue/release.json` | Catalogue version and canonical checksum of the compiled seven-key payload (ADR §7). CI fails if it does not match the source. |
| `catalogue/corrections/*.json` | Explicit correction lists. Each correction gives exact `before`/`after` rows and its expected runtime effect, and stays `PENDING_OWNER_APPROVAL` until the owner approves it by ID. |
| `catalogue/IMPORT_REPORT.md` | Generated record of the migration import: provenance, counts, checksums and parity, plus the defects carried verbatim. |

Generated delivery files (pointer and release payload) are never committed and never read as input.

## Commands

```bash
npm run catalogue:compile                           # compile + shared rule set (parity gate: report only)
npm run catalogue:compile -- --gate release         # exit 1 on any blocking or owner-approval finding
npm run catalogue:compile -- --compare <action-data.json>   # exact canonical parity with a capture
npm run catalogue:release                           # record version/checksum (bumps only if the checksum changed)
npm run catalogue:release -- --check                # verify release.json (CI)
npm run catalogue:corrections -- <list.json>        # check every correction applies and what it resolves
npm run catalogue:corrections -- <list.json> --apply <id>   # APPROVED corrections only
npm run catalogue:import -- <snapshot-dir>          # migration import (see below)
```

The compiler and validator use only Node built-ins: no `npm ci`, network access, database or credentials.

## Migration baseline

Catalogue version 1 is the **unmodified** import of the read-only snapshot `data/snapshots/20261010T070702Z`. The Sheet was confirmed unchanged at 12:44 UTC the same day, and its compiled checksum equals the live `action=data` capture (`IMPORT_REPORT.md`). The import refuses rather than lose data:
- when the Sheet, `Code.gs` emulation and capture disagree;
- when Apps Script would silently skip rows or drop roles;
- when it would synthesise placeholder counters;
- when a mode cannot be represented.

Known defects were carried verbatim into version 1, and the unchanged release validator rejects it. The owner then approved corrections C1–C5 in `catalogue/corrections/2026-10-10-baseline.json`. Each is applied in its own commit with its own release record, versions 2–6. The current source passes the release gate.

Tests enforce that:
- the committed source equals the import plus only `APPROVED` corrections;
- the compiled payload differs from the live capture by exactly the declared paths of those corrections;
- `release.json` advances one version per applied correction.

So no undeclared edit can land during migration.

The Sheet remains the live authority and the preserved migration baseline: it is not edited by this work. Corrections are made only in Git, after approval.

## Correcting the catalogue

1. Write or review the correction list (`catalogue/corrections/<date>-<topic>.json`).
2. Run `npm run catalogue:corrections -- <file>`. It must report that each correction applies cleanly and introduces no new findings.
3. When the owner approves a correction by ID, set its `status` to `APPROVED`, then run `--apply <id>` and `npm run catalogue:release`, and commit that one correction on its own for review.
4. The release gate (`--gate release`) must pass before any catalogue can be published at cutover.

## Limitations

- Finding locations from the shared rule set name payload paths (for example `counters["3v3"]["Grand Inquisitor"][1]`), not source line numbers.
- Release/pointer generation for Pages, app loading, service-worker bypass and cutover measurements (ADR §7–§10) are not built yet; they belong to the cutover work.
- CI checks the release record and parity tests, not the release gate: the imported baseline fails the gate by design until the owner approves corrections.
