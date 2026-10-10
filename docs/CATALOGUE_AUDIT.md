# Catalogue integrity and parity audit

**Scope.** How to run the read-only catalogue audit (issue #34), what its findings mean and where its limits are. It is the gate for the Git-native catalogue import ([`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md), #41), and the same rules validate the compiled Git source during the [fortnightly counter review](CATALOGUE_SOURCE.md#fortnightly-counter-review). Shipped app behaviour belongs in [`SPEC.md`](SPEC.md); scoring constants belong in [`SCORING_REFERENCE.md`](SCORING_REFERENCE.md). The individual rules, severities and runtime-effect wording live in `RULES` in `scripts/catalogue-audit-lib.js` and are printed in every report's legend; they are not restated here.

**Update this document when** the audit's input routes, commands, severity model or known limitations change, or a new baseline snapshot replaces the current one.

## What it does

The audit never writes to the Sheet, Apps Script, the app or any hosted service, and never corrects data. It:

1. reads a timestamped snapshot of the nine catalogue tabs (`Counters`, `Counter_Definitions`, `Counter_Composition`, `Character_Definitions`, `Defence_Teams`, `Defence_Composition`, `Score_Meanings`, `GAC_Board_Config`, `GAC_Scoring`). `Roster` and `GAC History` are never read;
2. checks headers, formulas, rows Apps Script silently skips, identifiers, references, enumerations, unit type versus mode, scoring and board shape, and defence identity (exact display name + mode, with `ANY` as the consumer wildcard);
3. replays `apps-script/Code.gs` `action=data` over the tabs and compares the result with the captured live `action=data` response (**parity**, canonical-JSON equality as defined in ADR-ARCH-116 §5);
4. rechecks the known 2026-10-10 observations (`Gungan`/`Gungans`, `Any` vs `ANY`, `KELLERAN_BEQ`/`JOCASTA_NU`, `Geonosian`/`Geonosians`, defence-only compositions, `REVA`/`GUNGANS` identities);
5. writes a deterministic Markdown/JSON report: counts, source row, mode, severity, observed vs expected, runtime effect and snapshot freshness.

The same rules also run over any seven-key `action=data` payload (`--payload`), so #41's compiled release is validated by this rule set rather than a second one.

## Severity model

| Severity | Meaning | Release gate |
|---|---|---|
| `blocking` | Structural or reference error; the catalogue breaks a contract or silently loses data. | Fails |
| `owner-approval` | A runtime-visible defect with more than one legitimate resolution (e.g. alias, `Any` row, duplicate matchup). The report proposes; the owner decides via an approved correction list (ADR-ARCH-116 §6). | Fails |
| `warning` | Non-blocking editorial issue (non-canonical spelling, blank threat, missing score meaning). | Passes |
| `info` | Legitimate shape noted for review (flexible composition, defence-only identity, cross-mode spelling). | Passes |

Legitimate partial, flexible or recommended-only compositions, sparse threat ratings, defence-only identities and informal counter names (`REVA` led by `THIRD_SISTER`, `GUNGANS` by `BOSS_NASS`) are never failures. Name variants are reported only as **candidate aliases** and only when they differ by case, punctuation or a trailing plural, so `Rey`/`Rex` stay distinct.

## Running it

```bash
# Audit a snapshot (parity gate: report, exit 0)
npm run catalogue:audit -- data/snapshots/20261010T070702Z

# Release gate: exit 1 on any blocking or owner-approval finding
npm run catalogue:audit -- data/snapshots/<stamp> --gate release

# Historical/migration snapshot freshness check (not the current review authority)
npm run catalogue:audit -- data/snapshots/<stamp> --max-age-days 14

# Audit a compiled or captured seven-key payload
npm run catalogue:audit -- --payload <payload.json> --gate release

# Write reports
npm run catalogue:audit -- data/snapshots/<stamp> --markdown <file.md> --json <file.json>
```

Exit codes: `0` passed, `1` gate failed or snapshot stale, `2` unreadable, tampered or malformed input. CI runs the audit offline through `npm test`; it never contacts Google.

## Taking a fresh snapshot

An operator with read access does this; it needs no credentials in the repository.

1. In the Sheet, **File → Download → Microsoft Excel (.xlsx)**. Note the UTC time. Keep the file outside the repository: it contains personal tabs.
2. Save the live `action=data` response (the Apps Script web-app URL, the same deployment as `ROSTER_API_URL` in `app.js`, with no `action` parameter) to a file and note the UTC time.
3. Run:

   ```bash
   npm run catalogue:snapshot -- --xlsx <workbook.xlsx> --captured-at <ISO> \
     --action-data <response.json> --action-data-captured-at <ISO> \
     --workbook-title SWGOH_GAC_Assistant_Data [--workbook-modified-at <ISO>]
   ```

   This writes `data/snapshots/<stamp>/` with one typed JSON file per catalogue tab (values as Apps Script reads them, plus formulas and error cells), the raw `action=data` bytes and a checksummed `manifest.json`. It refuses to overwrite an existing snapshot.
4. Generate the report beside it with `--markdown …/audit-report.md --json …/audit-report.json`. If the Sheet's last modification is later than either capture, recapture: parity is only meaningful for a consistent pair.

Older ARCH-103 CSV exports (`data/exports/*`) are also accepted, with the limitations below.

## Current baseline

[`data/snapshots/20261010T070702Z/audit-report.md`](../data/snapshots/20261010T070702Z/audit-report.md) — Sheet export 2026-10-10T07:07:02Z, `action=data` 2026-10-10T07:17:34Z (workbook last modified 2026-10-09T13:20:07Z). Parity: exact match. All known 2026-10-10 observations are still present in that immutable snapshot and reported, together with a newly found defect (`IG_12_AND_GROGU` and `PAZ_VIZSLA`, required by `BO_KATAN_MANDALORE`, have blank `Unit_Type` and `External_ID`). They were corrected later in Git releases 2–6; the frozen Sheet and snapshot remain unchanged and are not current review authorities.

## Limitations

- **Freshness is operator-bound.** The audit is only as current as the snapshot; `--max-age-days` makes staleness explicit.
- **What an export can show.** Values are cached formula results. Data validation, protected ranges and other Sheets-only settings are not checked.
- **CSV snapshots are untyped.** Numbers and `TRUE`/`FALSE` are inferred, so a number stored as text is invisible to parity, and formula checks are skipped (`FORMULA_METADATA_UNAVAILABLE`).
- **Parity mirrors the repository `Code.gs`.** A mismatch cannot say whether the Sheet changed between captures or the deployed Apps Script differs from the repository. A lock-step test fails whenever the `Code.gs` data path changes without the emulator being reviewed.
- **Alias detection is deliberately narrow.** Other misspellings appear only as `DEFENCE_ONLY_IDENTITY` (info).
- **Runtime-effect text describes current `app.js`** lookups (exact mode key, then `ANY`; board options from `counters[mode]`). Revisit it when those lookups change.
- **Scoring constants** (full-squad banner ceilings and unit counts) mirror `SCORING_REFERENCE.md` in `scripts/catalogue-audit-lib.js`; change both together.
