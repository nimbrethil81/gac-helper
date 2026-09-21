# ARCH-106 migration loader and reconciliation

This document is the operational entry point for the ARCH-106 migration loader. The accepted model remains authoritative in [`TARGET_ARCHITECTURE.md`](../TARGET_ARCHITECTURE.md); the canonical schema and Stage-1 role boundary remain authoritative in [`ARCH-105.md`](ARCH-105.md); the immutable source evidence remains [`data/exports/20260921T085937Z/`](../../data/exports/20260921T085937Z/).

**Status: blocked, not complete.** The loader, reconciliation, compatibility verification, tests and documentation are finished, and the committed decision file records an explicit outcome for every source discrepancy. Three of those outcomes need an owner decision before any load may run, because the ARCH-103 baseline and the ARCH-105 schema genuinely conflict. They are listed in [Blockers](#blockers).

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

### Privilege boundary

The load holds only the Stage-1 catalogue-authoring grants, so it cannot reach schema objects, roles, policies, evidence tables or the release lifecycle. A second guard rejects any statement whose leading verb is not `begin`, `commit`, `rollback`, `insert`, `select`, `set` or `reset`. A test snapshots every `gac` table, column, constraint, policy, function, grant and role before and after a load and asserts they are identical.

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

Every condition in the ARCH-103 capture report, and every additional conflict the loader found, has an entry in `data/migration/arch-106-decisions.json`.

| Anomaly | Outcome |
|---|---|
| 33 unmatched defence display names | **Resolved.** Each becomes its own archetype with an unchanged public display name and the deterministic `DEF_…` code. |
| `MAZ_KANATA` synthesized definition | **Resolved.** Migrated with `archetype_code` `MAZ_KANATA` and `display_name` `MAZ_KANATA`, exactly reproducing today's published semantics, marked `created_by = AUTOMATION` with an `identity_reason_detail` naming the legacy Apps Script synthesis. The separate defence name `Maz Kanata` stays its own identity (`DEF_MAZ_KANATA`). |
| Eight `Any` defence-team modes | **Resolved.** Stored as the canonical enum `ANY`; the compatibility projection emits `Any`, so the public payload is unchanged. |
| Absent `Defence_Composition` | **Resolved.** 112 defence profiles with `members_complete = false` and zero members. `defenceCompositions` stays `{}`. No defence member is inferred from attack composition. |
| `Score_Meanings` | **Resolved.** Not migrated as runtime data, per `TARGET_ARCHITECTURE.md` section 6. All 26 rows reconcile to the ladders in [`SCORING_REFERENCE.md`](../SCORING_REFERENCE.md); the two that had no home there (3v3 score 51, FLEET score 70) were added to that document. |
| `scoring` array order | **Resolved.** An explicit expected delta: `gac_scoring_rules` has no ordering column and the client resolves scoring by key and specificity, never by array position. |
| Duplicate `3v3 \| Grand Inquisitor \| TRAYA` | **Blocked.** See below. |
| `TIE_ADVANCED_x1` unit identifier | **Blocked.** See below. |
| Three mirror matchups | **Blocked.** See below. |

## Blockers

Each blocker is a conflict between two accepted authorities. ARCH-106 will not resolve any of them on its own, and the loader refuses to write to a database while any of them is open. Each has candidate resolutions with their exact effects recorded in the decision file; the loader implements every candidate that does not require a schema change, so recording a decision is the only work needed to unblock a load.

### 1. `DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA`

`Counters` rows 80 and 82 both state `3v3 | Grand Inquisitor | TRAYA`. They agree on `Tier` (`S`), `Banner Score` (`54`) and `Undersize` (`0`), but **row 80 carries the tactical note `Strong` and row 82 carries none**. `gac.matchups` permits exactly one row per `(mode, defence_archetype_id, counter_archetype_id)`.

They are therefore not byte-for-byte equivalent across all meaningful fields, so `IDENTICAL_DUPLICATE_COLLAPSED` does not apply and ARCH-106 will not pick a survivor or use last-write-wins. Collapsing them at all removes one of the two entries the current app publishes for this defence team, which is a visible catalogue change whichever row survives.

Candidates: `COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE` (one matchup, note `Strong`, no authored note lost), `COLLAPSE_KEEPING_ROW_82` (drops the note, conflicting with the no-dropped-note rule), or `CORRECT_AT_SOURCE` (owner amends the Sheet and ARCH-103 is re-captured).

### 2. `UNIT_ID_FORMAT_TIE_ADVANCED_X1`

`Character_Definitions` row 287 has `Character_ID` `TIE_ADVANCED_x1`. `gac.units` enforces `units_unit_id_format check (unit_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$')`, which the lowercase `x1` segment fails. The identifier is a public `characterDefinitions` key in the golden payload. It is referenced by no counter composition.

Preserving every `Character_ID` and satisfying the ARCH-105 constraint are not both possible for this unit. ARCH-106 may not amend the ARCH-105 schema and will not rename a public identifier on its own.

Candidates: `AMEND_ARCH_105_UNIT_ID_FORMAT` (a reviewed follow-up ARCH-105 migration widens the check; the only candidate that preserves the identifier and the payload — recommended), `RENAME_UNIT_ID_TO_UPPERCASE` (changes the public key and needs a documented client migration), or `CORRECT_AT_SOURCE`.

### 3. `MIRROR_MATCHUP_SELF_REFERENCE`

Three `Counters` rows pair a defence display name with the identically named attack counter:

| Source row | Mode | Defence team | Counter |
|---|---|---|---|
| 60 | FLEET | `Executor` | `EXECUTOR` |
| 152 | FLEET | `Leviathan` | `LEVIATHAN` |
| 305 | 5v5 | `The Stranger` | `THE_STRANGER` |

These are ordinary mirror matches: the catalogue advises countering a team with the same team. Under the single team registry in `TARGET_ARCHITECTURE.md` section 2.2 and the exact-name identity rule, both roles resolve to one archetype, which `gac.matchups` forbids through `matchups_distinct_archetypes check (defence_archetype_id <> counter_archetype_id)`.

Candidates: `AMEND_ARCH_105_ALLOW_MIRROR_MATCHUPS` (a reviewed follow-up ARCH-105 migration drops the constraint; all three rows survive and the payload is unchanged — recommended), `SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS` (three extra defence-only archetypes; the payload is unchanged, but the canonical model then asserts that three exactly-matching names are different teams), or `DROP_MIRROR_MATCHUPS` (not acceptable — it discards authored source rows).

## Reconciliation totals

Counts below are from the committed, blocked state. The blocked conditions withhold one unit, three mirror matchups and one duplicate composite. The figures in brackets are the same run with the three candidate resolutions that load against the ARCH-105 schema as committed today (`COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE`, `RENAME_UNIT_ID_TO_UPPERCASE`, `SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS`); they are rehearsal evidence, not decisions.

| Canonical table | Blocked | Rehearsal |
|---|---:|---:|
| `gac.units` | 311 | 312 |
| `gac.team_archetypes` | 90 | 93 |
| `gac.team_profiles` | 169 | 169 |
| `gac.team_profile_members` | 70 | 70 |
| `gac.matchups` | 361 | 365 |
| `gac.matchup_catalogue_values` | 361 | 365 |
| `gac.defence_catalogue_values` | 9 | 9 |
| `gac.gac_board_config` | 40 | 40 |
| `gac.gac_scoring_rules` | 16 | 16 |
| `gac.authoring_changes` | 1 | 1 |

Source rows reconcile as 312 characters, 56 authored counter definitions plus one synthesized, 70 composition members, 366 counter rows, 9 defence-team rows, 40 board rows, 16 scoring rows and 26 retired score-meaning rows. 69 distinct defence display names resolve as 36 reused exact attack identities and 33 defence-only archetypes.

Notes dropped silently: **0** in both states. Required members without an `external_id`: **0**. Fuzzy, semantic or case-insensitive matching used: **none**. Unresolved rows guessed: **0**.

## Idempotency guarantees

The loader reads each table's existing business keys first and inserts only what is missing. When a row already exists, every migrated column is compared and a disagreement aborts the transaction, so no table ever resolves a conflict by overwriting. A second load therefore inserts nothing, leaves surrogate keys and `updated_at` untouched, creates no duplicate provenance row, and produces the same reconciliation output. Tests assert all of this, and separately assert that two independently created databases hold the same business identities and project the same payload, comparing stable identities and semantics rather than generated keys.

## Compatibility results

`npm run migrate:verify` rebuilds the seven-key catalogue contract from the canonical state and compares it with the committed golden payload. In the rehearsal state the result is a full pass with **no unexplained difference**, byte-identical after the approved deltas, and every compatibility check green:

- no changed public `Counter_ID` — 57 golden counter definitions, 57 projected;
- no changed defence display name — all 69 preserved;
- no missing note — 97 golden notes, 97 projected;
- no reduced required-member external-ID coverage — 68 and 68;
- board configuration identical, order included;
- all 16 scoring rows and values identical;
- `defenceCompositions` stays `{}`.

Expected deltas are applied to the golden payload one at a time and declared in the machine-readable output; no domain is excluded from the comparison. The rehearsal produced three: the collapsed duplicate matchup, the renamed unit identifier, and the order-insensitive `scoring` comparison. The first two disappear under the recommended `AMEND_ARCH_105_*` candidates; the third is inherent to the schema.

This helper is migration verification only. It adds no `payloadSchemaVersion`, no static catalogue file, no publication state transition, no `catalogue/current.json` and no READY/DEPLOYED logic.

## Rollback procedure

No application reads this database, so rollback affects nothing live and the Google Sheet remains authoritative throughout.

1. For a disposable or development database, drop and recreate it, or execute the two ARCH-105 `.down.sql` scripts in reverse migration order (permissions first, then the core schema) as described in [`ARCH-105.md`](ARCH-105.md), then reapply the migrations.
2. Rerun `npm run migrate:load`.

A failed load needs no rollback step of its own: the whole load is one transaction and aborts leave the database exactly as it was.

## Boundaries with ARCH-107 and ARCH-108

- **ARCH-107** owns the human authoring path: the change-file schema, its YAML authoring format, create/update/retire operations and the proposed-diff workflow. ARCH-106 writes exactly one `authoring_changes` row, for the legacy migration itself, and adds no YAML dependency.
- **ARCH-108** owns the production payload generator, payload schema versioning, additive provenance, the structural and product-contract validators, static catalogue artifacts, the Cloudflare publication protocol and the READY/DEPLOYED lifecycle. ARCH-108 must apply `modeNormalisation.canonicalToPublic` from the decision file when it generates the public payload: the database stores `3V3`, `5V5`, `FLEET` and `ANY`, while the published contract uses `3v3`, `5v5`, `FLEET` and — for the `defenceTeams` domain only — `Any`.

## Deferred and out of scope

- No hosted database, Supabase project, Cloudflare target, repository secret or deployment was contacted or changed. Hosted configuration remains ARCH-104.
- No Stage-2 role, backup role or evidence automation was added.
- `RENAME_UNIT_ID_TO_UPPERCASE` is implemented but would be a public catalogue contract change; the client-state migration it would need is not written, because that decision has not been taken.
- The mismatch between the stored `Any` spelling and the client's `defenceTeams["ANY"]` wildcard lookup in `threatFor()` is a pre-existing live-application condition. ARCH-106 reproduces current behaviour exactly and deliberately does not fix it; changing the published spelling would be a product change.
