# ARCH-107 human authoring and manual release path

This document is the operational entry point for the ARCH-107 human authoring path. The accepted model remains authoritative in [`TARGET_ARCHITECTURE.md`](../TARGET_ARCHITECTURE.md) section 6; the canonical schema and Stage-1 role boundary remain authoritative in [`ARCH-105.md`](ARCH-105.md); the deterministic identity, mode and authority rules remain authoritative in [`ARCH-106.md`](ARCH-106.md) and `data/migration/arch-106-decisions.json`; scoring bounds remain authoritative in [`SCORING_REFERENCE.md`](../SCORING_REFERENCE.md).

**Status: implemented, not operationally proven.** The change-file schema, validator, idempotent loader, dry run and tests are complete and green. ARCH-107 stops at a *candidate canonical state*. Turning that candidate into a validated release through the normal publisher is ARCH-108's, and until ARCH-108 exists this package's `create AUTHORING candidates through the normal publisher` acceptance bullet cannot be demonstrated. See [Boundary with ARCH-108](#boundary-with-arch-108).

## Contents

| Path | Purpose |
|---|---|
| `scripts/authoring-lib.js` | Change-file schema, validation, normalisation and canonical diff. Pure; opens no database. |
| `scripts/authoring-validate.js` | `author:validate`. Structural validation only, no database. |
| `scripts/authoring-dry-run.js` | `author:dry-run`. Applies a change inside a transaction, reports the canonical and payload diff, rolls back. |
| `scripts/authoring-load.js` | `author:apply`. The idempotent loader, plus the disposable/local development database it runs against. |
| `data/authoring/arch-107-example-counter.change.json` | Worked example: add a counter identity and list it against an existing defence. |
| `data/authoring/arch-107-example-counter-revert.change.json` | The reverse of that example, by retirement. |
| `tests/authoring-loader.test.js` | PGlite tests for the whole package. |

No migration, schema object, permission, role or policy is added or changed by ARCH-107. The ARCH-105 and ARCH-106 migrations are untouched.

## Commands

```bash
npm run author:validate -- --change <path>   # structure, identifiers, modes, scores, notes, authority
npm run author:dry-run  -- --change <path>   # exact canonical and payload diff; writes nothing
npm run author:apply    -- --change <path>   # apply in one transaction
npm run author:apply    -- --change <path> --twice   # apply twice and assert the second is a no-op
npm run db:test                              # ARCH-105, ARCH-106 and ARCH-107 database tests
```

`author:dry-run` and `author:apply` accept `--data-dir <path>` to use a persistent local PGlite database instead of an in-memory one, so a sequence of changes can build on each other. Keep that path outside the repository. With no `--data-dir`, the database lives only for the command.

`author:dry-run` also accepts `--out <path>` for the human-readable report and `--json <path>` for the machine-readable candidate, which carries the complete canonical diff, payload diff and projected candidate payload. Neither is committed: a candidate is generated on demand from the change file and the database, so a stale copy cannot drift into the repository.

When the database is empty, both commands build the baseline first by applying the committed migrations and running the ARCH-106 load. They never contact Supabase, Cloudflare, GitHub, Google Sheets or Apps Script, need no Docker, and use no credential or connection string. This is the same disposable/local pattern ARCH-105 and ARCH-106 use; hosted configuration remains ARCH-104.

## Why JSON rather than YAML

[`ARCH-106.md`](ARCH-106.md) anticipated a YAML authoring format. ARCH-107 uses JSON instead:

- every machine-readable data file in the repository is already JSON — the ARCH-103 capture, its manifest, and the ARCH-106 decision and reconciliation files;
- Node parses JSON natively, so the format adds no dependency to a project that pins exactly one;
- the repository's development rules ask for existing patterns to be reused before new dependencies are introduced.

The trade is real: JSON has no comments, so a change file carries its explanation in `reason` rather than alongside the values. That is acceptable for files that describe a handful of discrete operations.

## Change-file schema

A change file is one JSON object. Version 1:

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. |
| `changeId` | yes | Stable change ID, matching `^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$`. Becomes `gac.authoring_changes.change_id`. |
| `author` | yes | Who authored the change. |
| `authorRole` | yes | `OWNER` or `MAINTENANCE`. See [Authority and locked values](#authority-and-locked-values). |
| `authoredAt` | yes | ISO 8601 timestamp with an explicit UTC offset. |
| `reason` | yes | Concise reason, at most 500 characters. |
| `expectedBaseRelease` | yes | The release `version` the change was authored against, or `null` to assert that no release is current. |
| `operations` | yes | A non-empty array of operations. |

Any other top-level field, any unrecognised operation field and any unrecognised value field is **rejected**, never ignored, so a typo cannot silently drop part of a change.

### Operations

| Entity | `create` | `update` | `retire` |
|---|---|---|---|
| `unit` | `unitId`, `displayName`, `unitType`, optional `externalId` | `displayName`, `externalId` | sets `active = false` |
| `archetype` | `archetypeCode`, `displayName`, `battleType`, `identityReason`, optional `identityReasonDetail`, `createdBy` | `displayName`, `identityReason`, `identityReasonDetail` | sets `status = RETIRED` |
| `profile` | `archetypeCode`, `mode`, `usageRole`, optional `flexSlots`, `membersComplete` | `flexSlots`, `membersComplete` | sets `status = RETIRED` |
| `member` | `archetypeCode`, `mode`, `usageRole`, `unitId`, `memberRole`, `sortOrder`, optional `isLeader` | `memberRole`, `isLeader`, `sortOrder` | **not supported** — see [Known limitations](#known-limitations) |
| `matchup` | `mode`, `defenceArchetypeCode`, `counterArchetypeCode`, `values` (`tier` and `bannerScore` required) | `values` | `retiredReason` required; sets `status = RETIRED` |
| `defenceValues` | `archetypeCode`, `mode`, `values` (`threat` required) | `values` | **not supported** — the table has no lifecycle column |

`matchup` values are `tier`, `bannerScore`, `undersize`, `notes`, `tierAuthority`, `bannerAuthority`, `undersizeAuthority`. `defenceValues` values are `threat`, `notes`, `threatAuthority`. An `update` changes only the fields it names. Authority defaults to `AUTHORED_BASELINE` on a create.

A matchup and its one-to-one `gac.matchup_catalogue_values` row are one authoring concept, so `matchup.update` edits the value row; there is no separate entity for it. `gac.gac_board_config` and `gac.gac_scoring_rules` are deliberately outside ARCH-107: they are application configuration, they change very rarely, and no current maintenance task needs them.

Operations may be listed in any order. The loader applies them parents-first (units, archetypes, profiles, members, matchups, defence values), so a file can create an archetype and use it in the same change.

### A worked example

`data/authoring/arch-107-example-counter.change.json` is a complete one-counter change: create the `FO_HUX` archetype, its `ANY` attack profile and three members, then list it against `ADMIRAL_RADDUS` in 5v5 with a tier, banner score, undersize and note. It is **illustrative only** — the counter and its values are examples, not authored catalogue judgements, and the file is never published.

`data/authoring/arch-107-example-counter-revert.change.json` reverses it by retiring the matchup, the profile and the archetype.

## Validation

`author:validate` checks everything that needs no database:

- **Structure** — schema version, required fields, types, unknown fields, empty operations, an operation that would change nothing, two operations targeting the same row.
- **Identifiers** — `changeId`, `archetype_code` and `unit_id` formats. A newly authored `unit_id` must match the stricter ARCH-105 form `^[A-Z0-9]+(?:_[A-Z0-9]+)*$`; a *reference* to an existing unit may use the form the ARCH-106 follow-up migration widened to, so `TIE_ADVANCED_x1` stays usable without licensing new legacy-shaped identifiers.
- **Modes** — accepted through ARCH-106's `SOURCE_MODE_TO_CANONICAL`, so a change file may write `3v3` or `3V3` and the loader stores the canonical enum. `ANY` is accepted for profiles and defence values and refused for matchups.
- **Scores** — `tier` and `threat` enums, and mode-aware numeric bounds taken from [`SCORING_REFERENCE.md`](../SCORING_REFERENCE.md): `bannerScore` is a full-squad, first-attempt, clean-clear value, so its ceiling is 57 (3v3), 65 (5v5) and 73 (fleet); `undersize` may not leave a counter with no units, so its ceiling is 2 (3v3), 4 (5v5) and 5 (fleet, where the schema's `0..5` column bound binds before the format's theoretical 6). Every migrated value satisfies these bounds.
- **Notes** — a string of at most 500 characters, with no control characters, no line breaks and no leading or trailing whitespace. All 97 migrated notes satisfy this; the rule exists so newly authored text cannot carry invisible padding or line breaks into the published payload.
- **Authority** — only `AUTHORED_LOCKED` and `AUTHORED_BASELINE` may be authored. `ASSESSED` is refused: it is the automation state and `gac.matchup_catalogue_values` requires a source assessment and finding to carry it, neither of which human authoring can supply.

`author:dry-run` and `author:apply` add everything that needs stored state:

- **Membership and existence** — every referenced unit, archetype, profile, member and matchup exists and is not retired; a required member carries a non-empty `external_id`; a leader is a `REQUIRED` member.
- **Mode compatibility** — the same rules as `gac.validate_profile_mode` and `gac.validate_matchup_mode`, reported against the operation that caused them rather than as a trigger failure.
- **Duplicates** — a `matchup.create` for a matchup the catalogue already holds is refused; a `create` of any entity whose stored row disagrees with the change is refused rather than merged; a new `external_id` that already belongs to another unit is refused.
- **Base release** — see below.
- **Locked values** — see below.

Every issue in a change is reported together, not one per run.

## Expected base release

`expectedBaseRelease` is the author's statement of what they were looking at. The loader compares it with `gac.catalogue_state.current_release_id` and refuses a stale change:

| `expectedBaseRelease` | Current release | Result |
|---|---|---|
| `null` | none | accepted — the pre-ARCH-108 state |
| `null` | version *n* | rejected as stale |
| *n* | version *n* | accepted, and `expected_base_release_id` recorded on the authoring row |
| *n* | version *m* ≠ *n* | rejected as stale |
| *n* | none | rejected as stale |

No release exists until ARCH-108 publishes one, so every change authored today declares `null`. The tests exercise the published cases by seeding a release row directly as test scaffolding; that scaffolding is not a publisher and bypasses the version allocation, checksum and `READY`/`DEPLOYED` protocol ARCH-108 owns.

## Authority and locked values

`TARGET_ARCHITECTURE.md` section 2.6 defines `AUTHORED_LOCKED` as "automation may propose a change but cannot apply it". ARCH-107 enforces that through the declared `authorRole`:

- a `MAINTENANCE` change may not set an `AUTHORED_LOCKED` authority;
- a `MAINTENANCE` change may not change a value, or the authority of a value, whose stored authority is `AUTHORED_LOCKED`;
- an `OWNER` change may, but only when the operation carries `"acknowledgeLocked": true`, so crossing a lock is always deliberate;
- fields that are not locked stay editable by either role.

Locking is per field: `tier`, `bannerScore` and `undersize` each carry their own authority, as does `threat`. Notes carry no authority state (`TARGET_ARCHITECTURE.md` section 5.6 — they are human-authored by definition) and are therefore not lock-protected.

**This boundary is enforced by the loader, not by the database.** Both roles run as `gac_authoring`, because ARCH-105 deliberately created only the migration-admin, authoring and publisher roles, and adding a distinct maintenance login role is a permission change that belongs to the owner, not to this package. `authorRole` is recorded in `structured_values` on every change, so the claim is auditable, but a direct SQL writer holding the `gac_authoring` grant could still change a locked value. Stage 2's deterministic applier will need database-level separation; that is noted for ARCH-108 and Stage 2 rather than assumed here.

## Idempotency

The loader computes the desired end state of each touched row and issues a statement only where the stored row differs. Applying the same change twice therefore:

- inserts nothing the second time;
- issues no `UPDATE`, so no `updated_at` moves and no surrogate key shifts;
- creates no second `gac.authoring_changes` row.

A change ID is stable and may only ever describe one change:

- re-running an applied change whose content is unchanged and whose effects are all still in place is a verified no-op;
- re-using a change ID for different content is refused (`CHANGE_ID_REUSED`);
- replaying an applied change after a later change superseded it is refused (`ALREADY_APPLIED_DIVERGED`) rather than silently reverting the later change. Author a new change instead.

## Privilege boundary

The apply runs in one transaction under `set local role gac_authoring`, so it holds exactly the Stage-1 catalogue-authoring grants and cannot reach schema objects, roles, policies, evidence tables or the release lifecycle. A second guard rejects any statement whose leading verb is not `begin`, `commit`, `rollback`, `insert`, `update`, `select`, `set` or `reset`. `delete` is deliberately absent: `gac_authoring` holds no `DELETE` grant and the canonical model retires rows rather than removing them.

Before it commits, the loader re-checks that no required member lost its `external_id` and that `gac.catalogue_releases` and `gac.catalogue_state` are exactly as it found them. Any failure, before or after the writes, rolls the whole transaction back. A dry run takes the same path and always rolls back.

A test snapshots every `gac` table, constraint, policy, grant and role, plus the release count and publication pointer, before and after an apply and asserts they are identical.

## Agent-assisted authoring workflow

1. **Describe the change.** The owner states the intent in the control thread — add a counter, correct a banner score, retire a matchup, lock a value.
2. **Draft the change file.** The agent writes one JSON file under `data/authoring/`, giving it a stable `changeId`, the author, the reason, `expectedBaseRelease` and the operations. It needs no SQL.
3. **Validate.** `npm run author:validate -- --change <path>` catches structure, identifier, mode, score, note and authority problems in a second, with no database.
4. **Dry run.** `npm run author:dry-run -- --change <path>` reports the exact canonical rows that would change, column by column, and the exact payload paths that would change, then rolls back. Add `--json <path>` for the machine-readable candidate.
5. **Review.** The owner reads the diff. Nothing has been written at this point.
6. **Apply.** `npm run author:apply -- --change <path>` commits the change to the development database and records the author, reason and change ID in `gac.authoring_changes`.
7. **Publish.** ARCH-108 turns the candidate canonical state into a validated `AUTHORING` release; its connected operation remains gated on ARCH-104.

To reverse a change before publication, author a compensating change file that retires what was created, as `arch-107-example-counter-revert.change.json` does. Nothing is ever deleted, so the history stays intact and the reversal is itself a recorded authoring change.

## ARCH-108 lifecycle amendment

ARCH-108 resolves the two child-row lifecycle gaps additively: `gac.team_profile_members` and `gac.defence_catalogue_values` now carry the same `ACTIVE`/`RETIRED` shape used by the canonical model, and the loader supports idempotent `retire`/`reactivate` operations for both. No `DELETE` grant was added. The migration and its non-destructive rollback are recorded in [`ARCH-108.md`](ARCH-108.md); this is a later refinement under delivery principle 18, not a reopening of ARCH-105.

The ARCH-108 projection also filters retired archetypes, profiles, members, matchups and defence values. The earlier limitations below describe ARCH-107 at its accepted commit and are superseded by that additive record.

## Known limitations at the accepted ARCH-107 commit

- **A profile member cannot be removed.** `gac_authoring` holds `select, insert, update` on `gac.team_profile_members` and no `DELETE`, and the table carries no lifecycle column, so there is no way to drop a member without a permission change. `member.retire` is refused with an explicit message rather than worked around. This is an **open question for the control thread**: the fix is either a small ARCH-107-owned additive migration granting `delete on gac.team_profile_members to gac_authoring`, or a lifecycle column on the table. Neither was taken unilaterally, because it changes the ARCH-105 permission boundary.
- **A `defence_catalogue_values` row cannot be retired**, for the same reason: the table has a composite primary key, no status column and no `DELETE` grant. Its values can be updated.
- **A retired attack identity still projects into `counterDefinitions`.** The payload diff uses ARCH-106's compatibility projection, which predates retirement and does not filter retired archetypes or profiles. Retiring a matchup does remove the counter from `counters`, which is what a player sees. ARCH-108's generator must filter retired archetypes and profiles; this is recorded in [Boundary with ARCH-108](#boundary-with-arch-108) and asserted by a test so it cannot be forgotten.
- **The locked-value boundary is loader-enforced, not database-enforced**, as described above.
- **`unit_type`, `battle_type`, `unit_id` and `archetype_code` cannot be changed.** The last two are immutable by database trigger. `unit_type` and `battle_type` shape identity and mode validation, and changing either would need existing profiles and matchups re-validated, which no trigger does on an archetype update; ARCH-107 refuses rather than creating a silent inconsistency.
- **No hosted database.** Everything targets a disposable or local PGlite database. There is no connected environment to author against until ARCH-104 runs.

## Boundary with ARCH-108

ARCH-107 produces a candidate canonical state and stops. It deliberately writes nothing to `gac.catalogue_releases`, `gac.catalogue_release_provenance`, `gac.catalogue_release_authoring_changes` or `gac.catalogue_state`, and an invariant refuses to commit if any of them moved.

ARCH-108 owns, and must supply, the rest of the human publication path described in `TARGET_ARCHITECTURE.md` section 6:

- the payload generator, payload schema version, checksum and immutable release record;
- `maintenance_run_id = NULL`, `release_reason = AUTHORING`, and provenance linking the release to its `authoring_changes` rows through `gac.catalogue_release_authoring_changes`;
- the structural and product-contract validators;
- the publication lock, base-release comparison and `READY`/`DEPLOYED` protocol;
- **filtering retired archetypes, profiles and matchups out of the generated payload**, which ARCH-106's compatibility projection does not do;
- applying `modeNormalisation.canonicalToPublic` from the ARCH-106 decision file, as ARCH-106 already recorded.

ARCH-108 Phase A now demonstrates this local path, including the worked example, release link, expected delta and compensating change. Operational sign-off remains deferred until ARCH-108 Phase B performs connected publication and rollback; see [`ARCH-108.md`](ARCH-108.md).
