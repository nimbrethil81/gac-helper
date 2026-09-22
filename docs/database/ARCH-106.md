# ARCH-106 migration loader and reconciliation

This document is the operational entry point for the ARCH-106 migration loader. The accepted model remains authoritative in [`TARGET_ARCHITECTURE.md`](../TARGET_ARCHITECTURE.md); the canonical schema and Stage-1 role boundary remain authoritative in [`ARCH-105.md`](ARCH-105.md); the immutable source evidence remains [`data/exports/20260921T085937Z/`](../../data/exports/20260921T085937Z/).

> **Status note (2026-09-22): paused future-migration asset.** [`ADR-ARCH-113`](../decisions/ADR-ARCH-113-stage1-rebaseline.md) re-baselines the active Stage-1 path onto Google Sheets authoring, the Apps Script `action=data` catalogue, cache-first PWA loading and Cloudflare delivery. No hosted database is part of active Stage-1 work, and no database provider is selected. The work recorded in this document is complete and preserved unchanged; its hosted deployment and operationalisation are deferred behind **GATE-150** ([`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) §7.1), which must select a persistent maintenance-store provider, assess its cost and free-tier constraints, and revalidate this implementation against it. Nothing below is reverted, rewritten or downgraded.

**Status: complete.** The loader, reconciliation, compatibility verification, tests and documentation are finished, and the committed decision file records an explicit outcome for every source discrepancy. The three conditions ARCH-106 first reported as blockers were resolved by owner decision on 2026-09-21 and are described in [Owner decisions](#owner-decisions); two of them are implemented as ordered follow-up migrations that correct the ARCH-105 schema. `npm run migrate:load` now succeeds from the committed decision file with no override or flag.

## Contents

| Path | Purpose |
|---|---|
| `data/migration/arch-106-decisions.json` | The committed, machine-readable migration decisions. The only place a discrepancy outcome is chosen. |
| `data/migration/arch-106-reconciliation.json` | Generated machine-readable reconciliation report. |
| `data/migration/arch-106-reconciliation.md` | Generated human-readable reconciliation report. |
| `scripts/migration-lib.js` | Source reading, deterministic transformation, blocker detection, reconciliation. |
| `scripts/migration-reconcile.js` | Dry run. Builds the plan and writes both reports. Never opens a database. |
| `scripts/migration-load.js` | Applies the plan to a disposable database in one transaction. |
| `scripts/migration-verify.js` | Projects the public catalogue contract back out of the database and compares it with the ARCH-103 golden payload. |
| `tests/migration-loader.test.js` | PGlite tests for the whole package. |
| `tests/migration-fixture.js` | Builds small synthetic ARCH-103-shaped captures for negative tests. |
| `supabase/migrations/20260921113000_arch_106_unit_id_format.sql` | Follow-up migration correcting the ARCH-105 `units_unit_id_format` constraint. |
| `supabase/migrations/20260921113010_arch_106_mirror_matchups.sql` | Follow-up migration removing the ARCH-105 `matchups_distinct_archetypes` constraint. |
| `supabase/rollbacks/20260921113000_arch_106_unit_id_format.down.sql` | Non-destructive reverse of the unit-ID amendment. |
| `supabase/rollbacks/20260921113010_arch_106_mirror_matchups.down.sql` | Non-destructive reverse of the mirror-matchup amendment. |

Both generated reports are deterministic functions of the capture directory and the decision file. Regenerate them, never hand-edit them.

## Commands

```bash
npm run migrate:reconcile   # dry run; writes both reports; exits non-zero while a blocker is open
npm run migrate:load        # load a fresh disposable PGlite database
npm run migrate:load -- --twice   # load the same database twice and assert the second load is a no-op
npm run migrate:verify      # load, project the public contract, compare with the golden payload
npm run db:test             # ARCH-105 schema tests plus the ARCH-106 loader tests
```

Every command accepts `--capture <dir>` and `--decisions <path>`. Both default to the committed baseline and decision file, so no absolute or machine-specific path appears anywhere in the package. None of them contacts Google Sheets, Apps Script, Supabase, Cloudflare, GitHub or any other network service, and none of them needs Docker, a login or a credential.

## Loader architecture

1. **Verify before reading.** `readSources()` runs the existing ARCH-103 verifier over the capture directory first. A changed byte, hash, row count or file set stops the package before a single source row is parsed.
2. **Transform.** `buildPlan()` is pure. It reads the eight exported tabs and the decision file, resolves every identity, and returns the complete canonical plan together with a reconciliation report and a list of blockers. It opens no database and writes no file.
3. **Refuse ambiguity.** Any condition without an explicit decision becomes a blocker. `assertLoadable()` throws before the loader opens a transaction.
4. **Load.** `loadPlan()` opens one transaction, switches to `gac_authoring` with `set local role`, resolves stable identities before dependent rows, inserts only rows the database does not already hold, checks post-load invariants, and commits only when every check passes. Any failure rolls the whole transaction back.
5. **Verify compatibility.** `projectPayload()` rebuilds the current seven-key catalogue contract from the loaded canonical state, and `verifyProjection()` compares it with the committed golden payload after applying the approved deltas.

A decision only changes behaviour by naming a resolution the loader implements. `RECOGNISED_RESOLUTIONS` in `scripts/migration-lib.js` lists them per anomaly; an unrecognised value becomes its own blocker rather than a licence to proceed. There is deliberately no general "ignore blockers" or "proceed anyway" option, so the load succeeds only because each condition has a precise, implemented resolution.

### Privilege boundary

The load holds only the Stage-1 catalogue-authoring grants, so it cannot reach schema objects, roles, policies, evidence tables or the release lifecycle. A second guard rejects any statement whose leading verb is not `begin`, `commit`, `rollback`, `insert`, `select`, `set` or `reset`. A test snapshots every `gac` table, column, constraint, policy, function, grant and role before and after a load and asserts they are identical.

The two follow-up migrations are ordinary ordered schema migrations applied as `gac_migration_admin`, exactly like the ARCH-105 pair. They are not run by the loader, and the loader still cannot reach them.

ARCH-106 adds no `SECURITY DEFINER` function, no login credential, no connection string and no new runtime dependency. It uses built-in Node APIs and the PGlite dependency ARCH-105 already pins.

## Deterministic identity rules

| Entity | Rule |
|---|---|
| `units.unit_id` | The source `Character_ID`, byte-for-byte. |
| `team_archetypes.archetype_code` (attack) | The source `Counter_ID`, byte-for-byte. |
| Attack `display_name` | The authored `Counter_Definitions."Counter Team"`, or the `Counter_ID` itself where the legacy Apps Script synthesizes the definition. |
| Defence identity | Reuses an attack archetype only on an exact, unique `display_name` match. Zero matches create a defence-only archetype. Two or more matches are rejected as ambiguous. No fuzzy, case-insensitive or semantic matching is ever attempted. |
| Defence-only `archetype_code` | `DEF_` + the display name uppercased, every character outside `[A-Z0-9]` replaced by `_`, runs of `_` collapsed, leading and trailing `_` removed. Names are processed in ascending code-point order and a collision takes the first free `_2`, `_3`, … suffix, so the outcome never depends on source row order. The 33 resulting codes are committed in the decision file and asserted by a test. |
| `battle_type` | An attack archetype is `FLEET` when any composition member is a `SHIP` or `CAPITAL_SHIP`, cross-checked against the modes the counter is used in; a disagreement is rejected. A defence identity takes its battle type from the modes it defends in, or from its `Defence_Teams` mode when it appears nowhere on `Counters`. |
| Attack profiles | Squad cores migrate once as mode `ANY` because they are currently shared across 3v3 and 5v5. Fleet cores migrate as mode `FLEET`. |
| Defence profiles | One per mode the identity actually appears in, with no members and `members_complete = false`. |
| `is_leader`, `flex_slots` | `false` and `0`. The source records neither and ARCH-106 invents neither. |
| Authority | Every migrated judgement is `AUTHORED_BASELINE`. The source carries no lock evidence, so nothing migrates as `AUTHORED_LOCKED`. |
| Board order | `display_order` is the source row index within each `(League, Mode)` group. |
| Provenance | One `gac.authoring_changes` row, `ARCH-106-LEGACY-MIGRATION`, authority `AUTHORED_BASELINE`, status `APPLIED`, with `authored_at` pinned to the ARCH-103 capture timestamp so two fresh databases agree. |

`members_complete` is `false` on every migrated profile, attack profiles included: `Counter_Composition` records a strategic attacking core, not an exhaustive lineup, so no migrated profile claims completeness.

### What ARCH-106 deliberately does not write

`gac.catalogue_releases`, `gac.catalogue_release_provenance`, `gac.catalogue_release_authoring_changes` and `gac.catalogue_state` stay untouched. A release carries a generated public payload, a payload schema version and a publication lifecycle, and all three belong to ARCH-108. The legacy-migration provenance ARCH-106 owes the schema is therefore the authoring record, not a release record.

## Anomaly decisions

Every condition in the ARCH-103 capture report, and every additional conflict the loader found, has an entry in `data/migration/arch-106-decisions.json`. All nine are resolved.

| Anomaly | Outcome |
|---|---|
| 33 unmatched defence display names | **Resolved by ARCH-106 rule.** Each becomes its own archetype with an unchanged public display name and the deterministic `DEF_…` code. |
| `MAZ_KANATA` synthesized definition | **Resolved by ARCH-106 rule.** Migrated with `archetype_code` `MAZ_KANATA` and `display_name` `MAZ_KANATA`, exactly reproducing today's published semantics, marked `created_by = AUTOMATION` with an `identity_reason_detail` naming the legacy Apps Script synthesis. The separate defence name `Maz Kanata` stays its own identity (`DEF_MAZ_KANATA`). |
| Eight `Any` defence-team modes | **Resolved by ARCH-106 rule.** Stored as the canonical enum `ANY`; the compatibility projection emits `Any`, so the public payload is unchanged. |
| Absent `Defence_Composition` | **Resolved by ARCH-106 rule.** 112 defence profiles with `members_complete = false` and zero members. `defenceCompositions` stays `{}`. No defence member is inferred from attack composition. |
| `Score_Meanings` | **Resolved by ARCH-106 rule.** Not migrated as runtime data, per `TARGET_ARCHITECTURE.md` section 6. All 26 rows reconcile to the ladders in [`SCORING_REFERENCE.md`](../SCORING_REFERENCE.md); the two that had no home there (3v3 score 51, FLEET score 70) were added to that document. |
| `scoring` array order | **Resolved by ARCH-106 rule.** An explicit expected delta: `gac_scoring_rules` has no ordering column and the client resolves scoring by key and specificity, never by array position. |
| Duplicate `3v3 \| Grand Inquisitor \| TRAYA` | **Resolved by owner decision.** See below. |
| `TIE_ADVANCED_x1` unit identifier | **Resolved by owner decision.** See below. |
| Three mirror matchups | **Resolved by owner decision.** See below. |

## Owner decisions

Each of these three was a conflict between two accepted authorities, so ARCH-106 reported it rather than resolving it. The owner accepted all three recommended resolutions on 2026-09-21. Each decision, its accepted candidate, the candidates that were rejected and the evidence behind it remain recorded in `data/migration/arch-106-decisions.json`.

### 1. `DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA` → `COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE`

`Counters` rows 80 and 82 both state `3v3 | Grand Inquisitor | TRAYA`. They agree on `Tier` (`S`), `Banner Score` (`54`) and `Undersize` (`0`), but **row 80 carries the tactical note `Strong` and row 82 carries none**. `gac.matchups` permits exactly one row per `(mode, defence_archetype_id, counter_archetype_id)`.

The two rows collapse into that one canonical matchup, which keeps Tier `S`, Banner Score `54`, Undersize `0` and the note `Strong`. **No note was dropped**: exactly one of the two rows carried an authored note, so retaining it is the union of the authored content rather than a choice between competing values. The survivor was not picked by row order or last-write-wins.

This is **not** an identical-duplicate collapse. The rows are not byte-for-byte equivalent, so `IDENTICAL_DUPLICATE_COLLAPSED` does not apply to them, and the loader still refuses that resolution for this pair. Both source rows are recorded in the reconciliation report and in the `gac.authoring_changes` provenance record, so the mapping stays traceable back to the Sheet.

The loader still rejects a duplicate whose rows disagree on `Tier`, `Banner Score` or `Undersize`, and one where two rows carry different authored notes; either needs its own explicit decision.

### 2. `UNIT_ID_FORMAT_TIE_ADVANCED_X1` → `AMEND_ARCH_105_UNIT_ID_FORMAT`

`Character_Definitions` row 287 has `Character_ID` `TIE_ADVANCED_x1` (display name `TIE Advanced x1`, external ID `TIEADVANCED`), which is also a published `characterDefinitions` key. The ARCH-105 constraint

```sql
constraint units_unit_id_format check (unit_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$')
```

rejected it because of the lowercase `x1` segment, so preserving every `Character_ID` and satisfying the schema were not both possible.

The identifier is preserved byte-for-byte and the constraint is corrected instead, by the ordered follow-up migration `supabase/migrations/20260921113000_arch_106_unit_id_format.sql`:

```sql
constraint units_unit_id_format check (unit_id ~ '^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$')
```

The replacement relaxes exactly one axis, letter case, and keeps every other structural rule: ASCII alphanumerics and underscores only, at least one character per segment, no leading or trailing underscore, and no consecutive underscores. `TIE_ADVANCED_x1` is the only one of the 312 captured `Character_ID` values that relies on the newly allowed form; the other 311 also satisfy the original expression. `team_archetypes_code_format` and `gac_scoring_rules_rule_id_format` keep their uppercase-only rules, which no captured value violates. The already-integrated ARCH-105 migration is unchanged.

`supabase/rollbacks/20260921113000_arch_106_unit_id_format.down.sql` restores the original constraint. It is non-destructive: it never renames or deletes a unit, and it raises and rolls back, naming the offending identifiers, if any stored `unit_id` relies on the widened form.

### 3. `MIRROR_MATCHUP_SELF_REFERENCE` → `AMEND_ARCH_105_ALLOW_MIRROR_MATCHUPS`

Three `Counters` rows pair a defence display name with the identically named attack counter:

| Source row | Mode | Defence team | Counter |
|---|---|---|---|
| 60 | FLEET | `Executor` | `EXECUTOR` |
| 152 | FLEET | `Leviathan` | `LEVIATHAN` |
| 305 | 5v5 | `The Stranger` | `THE_STRANGER` |

These are ordinary mirror matches. Under the single team registry in `TARGET_ARCHITECTURE.md` section 2.2 and the exact-name identity rule, both roles resolve to one archetype, which the ARCH-105 `matchups_distinct_archetypes` constraint forbade.

The ordered follow-up migration `supabase/migrations/20260921113010_arch_106_mirror_matchups.sql` removes that constraint. All three rows load with the same `archetype_id` in both roles, and **no defence-only identity is fabricated** for `Executor`, `Leviathan` or `The Stranger` — they remain among the 36 defence names that reuse their exact attack identity. Uniqueness is unchanged: `matchups_unique_relationship` on `(mode, defence_archetype_id, counter_archetype_id)` still holds, so a single self-reference is valid while a duplicate self-reference is rejected. `gac.validate_matchup_mode()` continues to require both roles to share a battle type.

`supabase/rollbacks/20260921113010_arch_106_mirror_matchups.down.sql` restores the constraint. It is non-destructive: it never deletes a matchup, and it raises and rolls back, naming the offending rows, if any mirror matchup exists.

## Reconciliation totals

Derived from the committed decision file by `npm run migrate:reconcile` and confirmed against a real load.

| Canonical table | Rows |
|---|---:|
| `gac.units` | 312 |
| `gac.team_archetypes` | 90 (57 attack, 33 defence-only) |
| `gac.team_profiles` | 169 (57 attack, 112 defence) |
| `gac.team_profile_members` | 70 |
| `gac.matchups` | 365 |
| `gac.matchup_catalogue_values` | 365 |
| `gac.defence_catalogue_values` | 9 |
| `gac.gac_board_config` | 40 |
| `gac.gac_scoring_rules` | 16 |
| `gac.authoring_changes` | 1 |

Source-to-canonical mapping: 312 `Character_Definitions` rows → 312 units; 56 authored `Counter_Definitions` rows → 56 attack archetypes, plus the synthesized `MAZ_KANATA`; 70 `Counter_Composition` rows → 70 profile members; 366 `Counters` rows → 365 matchups, the single difference being the one approved duplicate collapse; 9 `Defence_Teams` rows → 9 defence value rows; 40 board rows and 16 scoring rows one-to-one; 26 `Score_Meanings` rows retired to `SCORING_REFERENCE.md`. 69 distinct defence display names resolve as 36 reused exact attack identities and 33 defence-only archetypes.

**Difference from the earlier rehearsal figures.** The rehearsal reported 93 archetypes and 36 defence-only identities because it exercised `SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS`, which created `DEF_EXECUTOR`, `DEF_LEVIATHAN` and `DEF_THE_STRANGER`. The accepted decision keeps one archetype per mirror, so the total is 90 and the defence-only count is 33. Every other figure is unchanged, and the 312 units now include `TIE_ADVANCED_x1` under its own identifier rather than a renamed one.

Dropped source rows: **0**. Notes dropped silently: **0** (97 source `Counters` notes, 97 migrated; 14 scoring notes preserved). Required members without an `external_id`: **0** of 62 distinct required units. Fuzzy, semantic or case-insensitive matching used: **none**. Unresolved rows guessed: **0**.

## Idempotency guarantees

The loader reads each table's existing business keys first and inserts only what is missing. When a row already exists, every migrated column is compared and a disagreement aborts the transaction, so no table ever resolves a conflict by overwriting. A second load therefore inserts nothing, leaves surrogate keys and `updated_at` untouched, creates no duplicate provenance row, and produces the same reconciliation output. Tests assert all of this, and separately assert that two independently created databases hold the same business identities and project the same payload, comparing stable identities and semantics rather than generated keys.

## Compatibility results

`npm run migrate:verify` rebuilds the seven-key catalogue contract from the canonical state and compares it with the committed golden payload. Run from the committed decision file, with no override, the result is a full pass with **no unexplained difference**, byte-identical after the approved deltas, and every compatibility check green:

- no changed public `Counter_ID` — 57 golden counter definitions, 57 projected;
- no changed defence display name — all 69 preserved;
- no missing note — 97 golden notes, 97 projected;
- no reduced required-member external-ID coverage — 68 and 68;
- board configuration identical, order included;
- all 16 scoring rows and values identical;
- `defenceCompositions` stays `{}`;
- `characterDefinitions.TIE_ADVANCED_x1` is identical to the golden entry, key included.

Expected deltas are applied to the golden payload one at a time and declared in the machine-readable output; no domain is excluded from the comparison. There are exactly two:

| Delta | Decision | Effect |
|---|---|---|
| `COLLAPSED_DUPLICATE_MATCHUP` | `COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE` | The golden `counters["3v3"]["Grand Inquisitor"]` array carries two `TRAYA` entries; the canonical database carries one, retaining the note `Strong`. |
| `SCORING_ARRAY_ORDER` | `EXPECTED_DELTA_ORDER_INSENSITIVE_SCORING` | Both `scoring` arrays are compared in `(ruleId, battleType, mode)` order. No scoring key, value or note differs. |

There is no unit-rename delta and no mirror-identity delta: the owner decisions removed both by correcting the schema instead of the data. The internal-to-public mode projection (`3V3`/`5V5` → `3v3`/`5v5`, and `ANY` → `Any` for the `defenceTeams` domain only) produces no delta because the projection restores the exact published spelling.

This helper is migration verification only. It adds no `payloadSchemaVersion`, no static catalogue file, no publication state transition, no `catalogue/current.json` and no READY/DEPLOYED logic.

## Rollback procedure

No application reads this database, so rollback affects nothing live and the Google Sheet remains authoritative throughout.

1. For a disposable or development database, drop and recreate it, or execute all four `.down.sql` scripts in reverse migration order — mirror matchups, unit-ID format, ARCH-105 permissions, ARCH-105 core schema — then reapply the four migrations in filename order.
2. Rerun `npm run migrate:load`.

To reverse only a schema amendment, run its own `.down.sql`. Both refuse non-destructively when live data relies on the amendment, so restoring either constraint over incompatible data is a deliberate act, never a silent data loss.

A failed load needs no rollback step of its own: the whole load is one transaction and aborts leave the database exactly as it was.

## Boundaries with ARCH-107 and ARCH-108

- **ARCH-107** owns the human authoring path: the change-file schema, its authoring format, create/update/retire operations and the proposed-diff workflow, and is documented in [`ARCH-107.md`](ARCH-107.md). ARCH-106 writes exactly one `authoring_changes` row, for the legacy migration itself, and adds no dependency of its own. (ARCH-106 anticipated a YAML authoring format; ARCH-107 chose JSON instead, for the reasons recorded in its own document.)
- **ARCH-108** owns the production payload generator, payload schema versioning, additive provenance, the structural and product-contract validators, static catalogue artifacts, the Cloudflare publication protocol and the READY/DEPLOYED lifecycle. ARCH-108 must apply `modeNormalisation.canonicalToPublic` from the decision file when it generates the public payload: the database stores `3V3`, `5V5`, `FLEET` and `ANY`, while the published contract uses `3v3`, `5v5`, `FLEET` and — for the `defenceTeams` domain only — `Any`.

## Deferred and out of scope

- No hosted database, Supabase project, Cloudflare target, repository secret or deployment was contacted or changed. Hosted configuration is deferred to GATE-150.
- No Stage-2 role, backup role or evidence automation was added.
- `RENAME_UNIT_ID_TO_UPPERCASE` and `SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS` remain implemented as rejected alternatives, so the decisions stay reversible, but neither is in effect. Choosing `RENAME_UNIT_ID_TO_UPPERCASE` would be a public catalogue contract change and would need a client-state migration that is deliberately not written.
- The mismatch between the stored `Any` spelling and the client's `defenceTeams["ANY"]` wildcard lookup in `threatFor()` is a pre-existing live-application condition. ARCH-106 reproduces current behaviour exactly and deliberately does not fix it; changing the published spelling would be a product change.
