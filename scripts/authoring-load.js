#!/usr/bin/env node
"use strict";

// ARCH-107 human authoring loader.
//
// Applies a validated change file to the ARCH-105 canonical schema in one
// transaction, as gac_authoring, idempotently. The same code path serves the
// dry run: a dry run does exactly what an apply does and then rolls back, so
// the reported diff is the change's real effect rather than a prediction.
//
// It stops at a candidate canonical state. Generating a payload artifact,
// allocating a release version and publishing are ARCH-108's, and this loader
// deliberately writes nothing to gac.catalogue_releases, gac.catalogue_state,
// gac.catalogue_release_provenance or gac.catalogue_release_authoring_changes.

const path = require("node:path");

const { canonicalJson } = require("./baseline-lib.js");
const { canonicalDiff, readChangeFile, structuredValues } = require("./authoring-lib.js");
const { DEFAULT_CAPTURE_ROOT, DEFAULT_DECISIONS_PATH, assertLoadable, buildPlan, readDecisions, readSources } =
  require("./migration-lib.js");
const { applySchema, createDisposableDatabase, loadPlan } = require("./migration-load.js");
const { diffPayloads, projectPayload } = require("./migration-verify.js");

const LOADER_ROLE = "gac_authoring";

// ARCH-106's guard, plus `update`: authoring corrects existing values, which a
// migration never does. `delete` stays out — gac_authoring holds no DELETE
// grant and the canonical model retires rows rather than removing them.
const ALLOWED_VERBS = new Set(["begin", "commit", "rollback", "insert", "update", "select", "set", "reset"]);

// Parents before children, so a file may list its operations in any order.
const ENTITY_ORDER = Object.freeze({ unit: 0, archetype: 1, profile: 2, member: 3, matchup: 4, defenceValues: 5 });

const SNAPSHOT_TABLES = Object.freeze([
  "units",
  "team_archetypes",
  "team_profiles",
  "team_profile_members",
  "matchups",
  "matchup_catalogue_values",
  "defence_catalogue_values",
  "authoring_changes"
]);

class AuthoringError extends Error {
  constructor(issues) {
    super(`Change rejected:\n${issues.map((issue) => `${issue.at}: ${issue.message} [${issue.code}]`).join("\n")}`);
    this.name = "AuthoringError";
    this.issues = issues;
  }
}

function assertAuthoringStatement(sql) {
  const verb = sql.trim().split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_VERBS.has(verb)) {
    throw new Error(`ARCH-107 loader refuses a non-data statement: ${verb}`);
  }
  return sql;
}

async function run(database, sql, params) {
  return database.query(assertAuthoringStatement(sql), params);
}

// ─── canonical snapshot ──────────────────────────────────────────────────────

// Business-keyed rows only. Surrogate keys and the created_at/updated_at audit
// columns are excluded, so a snapshot difference always means a real change and
// two independently built databases compare equal.
async function canonicalSnapshot(database) {
  const snapshot = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, {}]));

  for (const row of (await run(database, "select unit_id, display_name, external_id, unit_type, active from gac.units")).rows) {
    snapshot.units[row.unit_id] = {
      unit_id: row.unit_id,
      display_name: row.display_name,
      external_id: row.external_id ?? null,
      unit_type: row.unit_type,
      active: row.active
    };
  }

  const archetypeCodeById = new Map();
  const archetypeRows = (await run(database, `
    select archetype_id, archetype_code, display_name, battle_type, status,
           merged_into_id, identity_reason, identity_reason_detail, created_by
    from gac.team_archetypes
  `)).rows;
  for (const row of archetypeRows) archetypeCodeById.set(String(row.archetype_id), row.archetype_code);
  for (const row of archetypeRows) {
    snapshot.team_archetypes[row.archetype_code] = {
      archetype_code: row.archetype_code,
      display_name: row.display_name,
      battle_type: row.battle_type,
      status: row.status,
      merged_into_code: row.merged_into_id === null ? null : archetypeCodeById.get(String(row.merged_into_id)) ?? null,
      identity_reason: row.identity_reason,
      identity_reason_detail: row.identity_reason_detail ?? null,
      created_by: row.created_by
    };
  }

  const profileKeyById = new Map();
  for (const row of (await run(database, `
    select profile_id, archetype_id, mode, usage_role, flex_slots, members_complete, status
    from gac.team_profiles
  `)).rows) {
    const key = `${archetypeCodeById.get(String(row.archetype_id))}|${row.mode}|${row.usage_role}`;
    profileKeyById.set(String(row.profile_id), key);
    snapshot.team_profiles[key] = {
      archetype_code: archetypeCodeById.get(String(row.archetype_id)),
      mode: row.mode,
      usage_role: row.usage_role,
      flex_slots: Number(row.flex_slots),
      members_complete: row.members_complete,
      status: row.status
    };
  }

  for (const row of (await run(database, `
    select profile_id, unit_id, member_role, is_leader, sort_order from gac.team_profile_members
  `)).rows) {
    const key = `${profileKeyById.get(String(row.profile_id))}|${row.unit_id}`;
    snapshot.team_profile_members[key] = {
      profile: profileKeyById.get(String(row.profile_id)),
      unit_id: row.unit_id,
      member_role: row.member_role,
      is_leader: row.is_leader,
      sort_order: Number(row.sort_order)
    };
  }

  const matchupKeyById = new Map();
  for (const row of (await run(database, `
    select matchup_id, mode, defence_archetype_id, counter_archetype_id, status, retired_reason
    from gac.matchups
  `)).rows) {
    const key = [
      row.mode,
      archetypeCodeById.get(String(row.defence_archetype_id)),
      archetypeCodeById.get(String(row.counter_archetype_id))
    ].join("|");
    matchupKeyById.set(String(row.matchup_id), key);
    snapshot.matchups[key] = {
      mode: row.mode,
      defence_archetype_code: archetypeCodeById.get(String(row.defence_archetype_id)),
      counter_archetype_code: archetypeCodeById.get(String(row.counter_archetype_id)),
      status: row.status,
      retired_reason: row.retired_reason ?? null
    };
  }

  for (const row of (await run(database, `
    select matchup_id, tier, banner_score, undersize, notes,
           tier_authority, banner_authority, undersize_authority
    from gac.matchup_catalogue_values
  `)).rows) {
    snapshot.matchup_catalogue_values[matchupKeyById.get(String(row.matchup_id))] = {
      tier: row.tier,
      banner_score: Number(row.banner_score),
      undersize: Number(row.undersize),
      notes: row.notes,
      tier_authority: row.tier_authority,
      banner_authority: row.banner_authority,
      undersize_authority: row.undersize_authority
    };
  }

  for (const row of (await run(database, `
    select archetype_id, mode, threat, notes, threat_authority from gac.defence_catalogue_values
  `)).rows) {
    const code = archetypeCodeById.get(String(row.archetype_id));
    snapshot.defence_catalogue_values[`${code}|${row.mode}`] = {
      archetype_code: code,
      mode: row.mode,
      threat: row.threat,
      notes: row.notes,
      threat_authority: row.threat_authority
    };
  }

  const releaseVersionById = new Map(
    (await run(database, "select release_id, version from gac.catalogue_releases")).rows
      .map((row) => [String(row.release_id), Number(row.version)])
  );
  for (const row of (await run(database, `
    select change_id, author, entity_type, operation, authority, reason, status, expected_base_release_id
    from gac.authoring_changes
  `)).rows) {
    snapshot.authoring_changes[row.change_id] = {
      change_id: row.change_id,
      author: row.author,
      entity_type: row.entity_type,
      operation: row.operation,
      authority: row.authority ?? null,
      reason: row.reason,
      status: row.status,
      expected_base_release: row.expected_base_release_id === null
        ? null
        : releaseVersionById.get(String(row.expected_base_release_id)) ?? null
    };
  }

  return snapshot;
}

// ─── base release ────────────────────────────────────────────────────────────

// A change declares the release it was authored against. Publication is
// ARCH-108's, but the base a change assumes is the author's statement of what
// they were looking at, so a change written against a superseded catalogue is
// refused here rather than carried forward into a candidate.
async function resolveBaseRelease(database, change, issues) {
  const state = (await run(database, "select current_release_id from gac.catalogue_state where singleton_id")).rows[0];
  const currentId = state?.current_release_id ?? null;
  let currentVersion = null;
  if (currentId !== null) {
    const row = (await run(database, "select version from gac.catalogue_releases where release_id = $1", [currentId])).rows[0];
    currentVersion = row === undefined ? null : Number(row.version);
  }

  if (change.expected_base_release === null) {
    if (currentVersion !== null) {
      issues.push({
        code: "STALE_BASE_RELEASE",
        at: "expectedBaseRelease",
        message: `the change was authored against an unpublished catalogue, but release version ${currentVersion} is current`
      });
    }
    return { expected_base_release_id: null, currentVersion };
  }

  if (currentVersion === null) {
    issues.push({
      code: "STALE_BASE_RELEASE",
      at: "expectedBaseRelease",
      message: `the change expects release version ${change.expected_base_release}, but no release is current`
    });
    return { expected_base_release_id: null, currentVersion };
  }
  if (currentVersion !== change.expected_base_release) {
    issues.push({
      code: "STALE_BASE_RELEASE",
      at: "expectedBaseRelease",
      message: `the change expects release version ${change.expected_base_release}, but version ${currentVersion} is current`
    });
    return { expected_base_release_id: null, currentVersion };
  }
  return { expected_base_release_id: currentId, currentVersion };
}

// ─── validation against stored state ─────────────────────────────────────────

const LOCKED_FIELDS = Object.freeze({
  tier: "tier_authority",
  banner_score: "banner_authority",
  undersize: "undersize_authority",
  threat: "threat_authority"
});

function profileKeyOf(op) { return `${op.archetype_code}|${op.mode}|${op.usage_role}`; }
function matchupKeyOf(op) { return `${op.mode}|${op.defence_archetype_code}|${op.counter_archetype_code}`; }

function validateAgainstState(change, snapshot, issues, { isReplay = false } = {}) {
  const add = (code, at, message) => issues.push({ code, at, message });

  // Entities this change creates, so a later operation in the same file may
  // depend on them before they exist in the database.
  const pendingArchetypes = new Map();
  const pendingUnits = new Map();
  const pendingProfiles = new Map();
  for (const op of change.operations) {
    if (op.entity === "archetype" && op.operation === "create") {
      pendingArchetypes.set(op.archetype_code, { battle_type: op.battle_type, status: "ACTIVE" });
    }
    if (op.entity === "unit" && op.operation === "create") {
      pendingUnits.set(op.unit_id, { external_id: op.external_id, active: true });
    }
    if (op.entity === "profile" && op.operation === "create") {
      pendingProfiles.set(profileKeyOf(op), { status: "ACTIVE" });
    }
  }

  const archetype = (code) => snapshot.team_archetypes[code] ?? pendingArchetypes.get(code) ?? null;
  const unit = (id) => snapshot.units[id] ?? pendingUnits.get(id) ?? null;
  const profile = (key) => snapshot.team_profiles[key] ?? pendingProfiles.get(key) ?? null;

  const requireArchetype = (at, code, label) => {
    const stored = archetype(code);
    if (stored === null) {
      add("UNKNOWN_ARCHETYPE", at, `${label} ${code} does not exist`);
      return null;
    }
    if (stored.status !== "ACTIVE") {
      add("RETIRED_ARCHETYPE", at, `${label} ${code} is ${stored.status}`);
      return null;
    }
    return stored;
  };

  for (const op of change.operations) {
    const at = op.at;

    switch (op.entity) {
      case "unit": {
        const stored = snapshot.units[op.unit_id] ?? null;
        if (op.operation === "create") {
          if (stored !== null) {
            for (const [column, value] of Object.entries({
              display_name: op.display_name,
              external_id: op.external_id,
              unit_type: op.unit_type
            })) {
              if (value !== undefined && stored[column] !== value) {
                add("CONFLICT", at, `gac.units already holds ${column} ${JSON.stringify(stored[column])} for ${op.unit_id}, not ${JSON.stringify(value)}`);
              }
            }
          } else if (op.external_id !== null) {
            const clash = Object.values(snapshot.units).find((row) => row.external_id === op.external_id);
            if (clash !== undefined) {
              add("DUPLICATE_EXTERNAL_ID", at, `external_id ${op.external_id} already belongs to ${clash.unit_id}`);
            }
          }
        } else if (stored === null) {
          add("UNKNOWN_UNIT", at, `unit ${op.unit_id} does not exist`);
        } else if (op.operation === "update" && op.external_id !== undefined && op.external_id !== null) {
          const clash = Object.values(snapshot.units)
            .find((row) => row.external_id === op.external_id && row.unit_id !== op.unit_id);
          if (clash !== undefined) {
            add("DUPLICATE_EXTERNAL_ID", at, `external_id ${op.external_id} already belongs to ${clash.unit_id}`);
          }
        }
        break;
      }

      case "archetype": {
        const stored = snapshot.team_archetypes[op.archetype_code] ?? null;
        if (op.operation === "create") {
          if (stored !== null) {
            for (const [column, value] of Object.entries({
              display_name: op.display_name,
              battle_type: op.battle_type,
              identity_reason: op.identity_reason,
              identity_reason_detail: op.identity_reason_detail,
              created_by: op.created_by
            })) {
              if (value !== undefined && stored[column] !== value) {
                add("CONFLICT", at, `gac.team_archetypes already holds ${column} ${JSON.stringify(stored[column])} for ${op.archetype_code}, not ${JSON.stringify(value)}`);
              }
            }
          }
        } else if (stored === null) {
          add("UNKNOWN_ARCHETYPE", at, `archetype ${op.archetype_code} does not exist`);
        }
        break;
      }

      case "profile": {
        const key = profileKeyOf(op);
        const stored = snapshot.team_profiles[key] ?? null;
        const parent = op.operation === "create"
          ? requireArchetype(at, op.archetype_code, "archetype")
          : archetype(op.archetype_code);
        if (op.operation === "create") {
          if (parent !== null && op.mode !== null) {
            // Mirrors gac.validate_profile_mode, reported here with the
            // operation that caused it rather than as a trigger failure.
            const incompatible = (parent.battle_type === "FLEET" && !["ANY", "FLEET"].includes(op.mode))
              || (parent.battle_type === "SQUAD" && op.mode === "FLEET");
            if (incompatible) {
              add("MODE_INCOMPATIBLE", at, `mode ${op.mode} is incompatible with ${parent.battle_type} archetype ${op.archetype_code}`);
            }
          }
          if (stored !== null) {
            for (const [column, value] of Object.entries({
              flex_slots: op.flex_slots,
              members_complete: op.members_complete
            })) {
              if (value !== undefined && stored[column] !== value) {
                add("CONFLICT", at, `gac.team_profiles already holds ${column} ${JSON.stringify(stored[column])} for ${key}, not ${JSON.stringify(value)}`);
              }
            }
          }
        } else if (stored === null) {
          add("UNKNOWN_PROFILE", at, `profile ${key} does not exist`);
        }
        break;
      }

      case "member": {
        const key = profileKeyOf(op);
        const parent = profile(key);
        if (parent === null) {
          add("UNKNOWN_PROFILE", at, `profile ${key} does not exist`);
          break;
        }
        if (parent.status !== undefined && parent.status !== "ACTIVE") {
          add("RETIRED_PROFILE", at, `profile ${key} is ${parent.status}`);
        }
        const member = unit(op.unit_id);
        if (member === null) {
          add("UNKNOWN_UNIT", at, `unit ${op.unit_id} does not exist`);
          break;
        }
        const stored = snapshot.team_profile_members[`${key}|${op.unit_id}`] ?? null;
        if (op.operation === "update" && stored === null) {
          add("UNKNOWN_MEMBER", at, `${op.unit_id} is not a member of ${key}`);
          break;
        }
        if (op.operation === "create" && stored !== null) {
          for (const [column, value] of Object.entries({
            member_role: op.member_role,
            is_leader: op.is_leader,
            sort_order: op.sort_order
          })) {
            if (value !== undefined && stored[column] !== value) {
              add("CONFLICT", at, `${op.unit_id} is already a member of ${key} with ${column} ${JSON.stringify(stored[column])}, not ${JSON.stringify(value)}`);
            }
          }
        }
        const memberRole = op.member_role ?? stored?.member_role;
        // Every required member of a publishable profile must carry an
        // external_id; ARCH-106 proved the migrated catalogue satisfies this and
        // authoring must not be the first thing to break it.
        if (memberRole === "REQUIRED" && (member.external_id ?? "") === "") {
          add("MISSING_EXTERNAL_ID", at, `required member ${op.unit_id} has no external_id`);
        }
        const isLeader = op.is_leader ?? stored?.is_leader ?? false;
        if (isLeader && memberRole !== "REQUIRED") {
          add("LEADER_ROLE", at, `leader ${op.unit_id} must be a REQUIRED member of ${key}`);
        }
        break;
      }

      case "matchup": {
        const key = matchupKeyOf(op);
        const stored = snapshot.matchups[key] ?? null;
        const storedValues = snapshot.matchup_catalogue_values[key] ?? null;

        if (op.operation === "create") {
          requireArchetype(at, op.defence_archetype_code, "defence archetype");
          requireArchetype(at, op.counter_archetype_code, "counter archetype");
          const defence = archetype(op.defence_archetype_code);
          const counter = archetype(op.counter_archetype_code);
          if (defence !== null && counter !== null && op.mode !== null) {
            // Mirrors gac.validate_matchup_mode.
            if (defence.battle_type !== counter.battle_type) {
              add("MODE_INCOMPATIBLE", at, `defence ${op.defence_archetype_code} is ${defence.battle_type} but counter ${op.counter_archetype_code} is ${counter.battle_type}`);
            } else if (op.mode === "FLEET" && defence.battle_type !== "FLEET") {
              add("MODE_INCOMPATIBLE", at, `FLEET matchups need FLEET archetypes, got ${defence.battle_type}`);
            } else if (["3V3", "5V5"].includes(op.mode) && defence.battle_type !== "SQUAD") {
              add("MODE_INCOMPATIBLE", at, `${op.mode} matchups need SQUAD archetypes, got ${defence.battle_type}`);
            }
          }
          if (stored !== null && !isReplay) {
            // A matchup is the judgement being authored, so a new change that
            // proposes one the catalogue already holds is an authoring mistake,
            // not something to merge. Replaying the same change ID is the one
            // case that must stay a no-op, and it is handled below.
            add(
              "DUPLICATE_MATCHUP",
              at,
              `${key} already exists; use a matchup update to change its values`
            );
          } else if (stored !== null && storedValues !== null) {
            for (const [column, value] of Object.entries(op.values ?? {})) {
              if (storedValues[column] !== value) {
                add("CONFLICT", at, `gac.matchup_catalogue_values already holds ${column} ${JSON.stringify(storedValues[column])} for ${key}, not ${JSON.stringify(value)}`);
              }
            }
          }
        } else if (stored === null) {
          add("UNKNOWN_MATCHUP", at, `matchup ${key} does not exist`);
        } else if (op.operation === "update" && stored.status !== "ACTIVE") {
          add("RETIRED_MATCHUP", at, `matchup ${key} is ${stored.status}; a retired matchup keeps the values it was retired with`);
        } else if (op.operation === "update" && storedValues === null) {
          add("MISSING_MATCHUP_VALUES", at, `matchup ${key} has no catalogue value row to update`);
        }

        if (op.operation === "update" && storedValues !== null && op.values !== null) {
          checkLocks(add, at, op, storedValues, change.author_role);
        }
        break;
      }

      case "defenceValues": {
        const stored = snapshot.defence_catalogue_values[`${op.archetype_code}|${op.mode}`] ?? null;
        if (op.operation === "create") {
          requireArchetype(at, op.archetype_code, "archetype");
          if (stored !== null) {
            for (const [column, value] of Object.entries(op.values ?? {})) {
              if (stored[column] !== value) {
                add("CONFLICT", at, `gac.defence_catalogue_values already holds ${column} ${JSON.stringify(stored[column])} for ${op.archetype_code}|${op.mode}, not ${JSON.stringify(value)}`);
              }
            }
          }
        } else if (stored === null) {
          add("UNKNOWN_DEFENCE_VALUES", at, `defence values ${op.archetype_code}|${op.mode} do not exist`);
        } else if (op.values !== null) {
          checkLocks(add, at, op, stored, change.author_role);
        }
        break;
      }

      default:
        add("ENTITY", at, `unhandled entity ${op.entity}`);
    }
  }
}

// AUTHORED_LOCKED means automation may propose a change but cannot apply it.
// The maintenance role is refused outright; the owner must say, per operation,
// that the lock is being crossed deliberately.
//
// Notes carry no authority state (TARGET_ARCHITECTURE.md section 5.6 — they are
// human-authored by definition), so they are not lock-protected.
function checkLocks(add, at, op, storedValues, authorRole) {
  for (const [column, authorityColumn] of Object.entries(LOCKED_FIELDS)) {
    const touchesValue = op.values[column] !== undefined && op.values[column] !== storedValues[column];
    const touchesAuthority = op.values[authorityColumn] !== undefined
      && op.values[authorityColumn] !== storedValues[authorityColumn];
    if (!touchesValue && !touchesAuthority) continue;
    if (storedValues[authorityColumn] !== "AUTHORED_LOCKED") continue;

    if (authorRole !== "OWNER") {
      add("LOCKED_VALUE", at, `${column} is AUTHORED_LOCKED and cannot be changed by the ${authorRole} role`);
    } else if (op.acknowledge_locked !== true) {
      add("LOCKED_VALUE", at, `${column} is AUTHORED_LOCKED; set "acknowledgeLocked": true to change it deliberately`);
    }
  }
}

// ─── write planning ──────────────────────────────────────────────────────────

// Desired end state per touched row, derived from the operation and whatever is
// already stored. A row already in its desired state produces no statement at
// all, which is what keeps a repeated apply from touching updated_at.
function planWrites(change, snapshot) {
  const writes = [];
  const ordered = [...change.operations].sort((a, b) => ENTITY_ORDER[a.entity] - ENTITY_ORDER[b.entity]);

  for (const op of ordered) {
    switch (op.entity) {
      case "unit": {
        const stored = snapshot.units[op.unit_id] ?? null;
        if (op.operation === "create") {
          if (stored === null) {
            writes.push({
              kind: "insert",
              table: "gac.units",
              key: op.unit_id,
              row: {
                unit_id: op.unit_id,
                display_name: op.display_name,
                external_id: op.external_id,
                unit_type: op.unit_type
              },
              op
            });
          }
        } else {
          const target = op.operation === "retire"
            ? { active: false }
            : pick({ display_name: op.display_name, external_id: op.external_id });
          pushUpdate(writes, "gac.units", "unit_id", op.unit_id, stored, target, op);
        }
        break;
      }

      case "archetype": {
        const stored = snapshot.team_archetypes[op.archetype_code] ?? null;
        if (op.operation === "create") {
          if (stored === null) {
            writes.push({
              kind: "insert",
              table: "gac.team_archetypes",
              key: op.archetype_code,
              row: {
                archetype_code: op.archetype_code,
                display_name: op.display_name,
                battle_type: op.battle_type,
                identity_reason: op.identity_reason,
                identity_reason_detail: op.identity_reason_detail,
                created_by: op.created_by
              },
              op
            });
          }
        } else {
          const target = op.operation === "retire"
            ? { status: "RETIRED" }
            : pick({
              display_name: op.display_name,
              identity_reason: op.identity_reason,
              identity_reason_detail: op.identity_reason_detail
            });
          pushUpdate(writes, "gac.team_archetypes", "archetype_code", op.archetype_code, stored, target, op);
        }
        break;
      }

      case "profile": {
        const key = profileKeyOf(op);
        const stored = snapshot.team_profiles[key] ?? null;
        if (op.operation === "create") {
          if (stored === null) {
            writes.push({
              kind: "insertProfile",
              table: "gac.team_profiles",
              key,
              row: {
                archetype_code: op.archetype_code,
                mode: op.mode,
                usage_role: op.usage_role,
                flex_slots: op.flex_slots,
                members_complete: op.members_complete
              },
              op
            });
          }
        } else {
          const target = op.operation === "retire"
            ? { status: "RETIRED" }
            : pick({ flex_slots: op.flex_slots, members_complete: op.members_complete });
          writes.push(...profileUpdate(key, op, stored, target));
        }
        break;
      }

      case "member": {
        const profileKey = profileKeyOf(op);
        const key = `${profileKey}|${op.unit_id}`;
        const stored = snapshot.team_profile_members[key] ?? null;
        if (op.operation === "create") {
          // An existing member is a verified no-op: validation already refused
          // a create whose values disagree with the stored row.
          if (stored === null) {
            writes.push({
              kind: "insertMember",
              table: "gac.team_profile_members",
              key,
              row: {
                profile: profileKey,
                unit_id: op.unit_id,
                member_role: op.member_role,
                is_leader: op.is_leader,
                sort_order: op.sort_order
              },
              op
            });
          }
        } else {
          const target = pick({ member_role: op.member_role, is_leader: op.is_leader, sort_order: op.sort_order });
          writes.push(...memberUpdate(key, profileKey, op, stored, target));
        }
        break;
      }

      case "matchup": {
        const key = matchupKeyOf(op);
        const stored = snapshot.matchups[key] ?? null;
        const storedValues = snapshot.matchup_catalogue_values[key] ?? null;
        if (op.operation === "create") {
          if (stored === null) {
            writes.push({
              kind: "insertMatchup",
              table: "gac.matchups",
              key,
              row: {
                mode: op.mode,
                defence_archetype_code: op.defence_archetype_code,
                counter_archetype_code: op.counter_archetype_code
              },
              values: {
                tier: op.values.tier,
                banner_score: op.values.banner_score,
                undersize: op.values.undersize ?? 0,
                notes: op.values.notes ?? "",
                tier_authority: op.values.tier_authority ?? "AUTHORED_BASELINE",
                banner_authority: op.values.banner_authority ?? "AUTHORED_BASELINE",
                undersize_authority: op.values.undersize_authority ?? "AUTHORED_BASELINE"
              },
              op
            });
          }
        } else if (op.operation === "retire") {
          if (stored !== null && stored.status !== "RETIRED") {
            writes.push({ kind: "retireMatchup", table: "gac.matchups", key, reason: op.retired_reason, op });
          }
        } else {
          writes.push(...matchupValuesUpdate(key, op, storedValues));
        }
        break;
      }

      case "defenceValues": {
        const key = `${op.archetype_code}|${op.mode}`;
        const stored = snapshot.defence_catalogue_values[key] ?? null;
        if (op.operation === "create" && stored === null) {
          writes.push({
            kind: "insertDefenceValues",
            table: "gac.defence_catalogue_values",
            key,
            row: {
              archetype_code: op.archetype_code,
              mode: op.mode,
              threat: op.values.threat,
              notes: op.values.notes ?? "",
              threat_authority: op.values.threat_authority ?? "AUTHORED_BASELINE"
            },
            op
          });
          break;
        }
        if (stored === null) break;
        const target = pick(op.values ?? {});
        const changed = differingColumns(stored, target);
        if (changed.length > 0) {
          writes.push({
            kind: "updateDefenceValues",
            table: "gac.defence_catalogue_values",
            key,
            archetype_code: op.archetype_code,
            mode: op.mode,
            set: Object.fromEntries(changed.map((column) => [column, target[column]])),
            op
          });
        }
        break;
      }

      default:
        throw new Error(`Unhandled entity ${op.entity}`);
    }
  }

  return writes;
}

function pick(candidate) {
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
}

function differingColumns(stored, target) {
  if (stored === null) return Object.keys(target);
  return Object.keys(target).filter((column) => stored[column] !== target[column]);
}

function pushUpdate(writes, table, keyColumn, key, stored, target, op) {
  if (stored === null) return;
  const changed = differingColumns(stored, target);
  if (changed.length === 0) return;
  writes.push({
    kind: "update",
    table,
    keyColumn,
    key,
    set: Object.fromEntries(changed.map((column) => [column, target[column]])),
    op
  });
}

function profileUpdate(key, op, stored, target) {
  if (stored === null) return [];
  const changed = differingColumns(stored, target);
  if (changed.length === 0) return [];
  return [{
    kind: "updateProfile",
    table: "gac.team_profiles",
    key,
    archetype_code: op.archetype_code,
    mode: op.mode,
    usage_role: op.usage_role,
    set: Object.fromEntries(changed.map((column) => [column, target[column]])),
    op
  }];
}

function memberUpdate(key, profileKey, op, stored, target) {
  if (stored === null) return [];
  const changed = differingColumns(stored, target);
  if (changed.length === 0) return [];
  return [{
    kind: "updateMember",
    table: "gac.team_profile_members",
    key,
    profile: profileKey,
    unit_id: op.unit_id,
    set: Object.fromEntries(changed.map((column) => [column, target[column]])),
    op
  }];
}

function matchupValuesUpdate(key, op, storedValues) {
  if (storedValues === null || op.values === null) return [];
  const target = pick(op.values);
  const changed = differingColumns(storedValues, target);
  if (changed.length === 0) return [];
  return [{
    kind: "updateMatchupValues",
    table: "gac.matchup_catalogue_values",
    key,
    mode: op.mode,
    defence_archetype_code: op.defence_archetype_code,
    counter_archetype_code: op.counter_archetype_code,
    set: Object.fromEntries(changed.map((column) => [column, target[column]])),
    op
  }];
}

// ─── write execution ─────────────────────────────────────────────────────────

const ARCHETYPE_ID = "(select archetype_id from gac.team_archetypes where archetype_code = ";
const PROFILE_ID = `(select profile.profile_id
     from gac.team_profiles profile
     join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
     where archetype.archetype_code = `;

function setClause(set, params) {
  return Object.entries(set).map(([column, value]) => {
    params.push(value);
    return `${column} = $${params.length}`;
  }).join(", ");
}

async function executeWrite(database, write) {
  const params = [];
  switch (write.kind) {
    case "insert":
      await run(
        database,
        `insert into ${write.table} (${Object.keys(write.row).join(", ")})
         values (${Object.keys(write.row).map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(write.row)
      );
      return;

    case "insertProfile":
      await run(
        database,
        `insert into gac.team_profiles (archetype_id, mode, usage_role, flex_slots, members_complete)
         select archetype_id, $2, $3, $4, $5 from gac.team_archetypes where archetype_code = $1`,
        [write.row.archetype_code, write.row.mode, write.row.usage_role, write.row.flex_slots, write.row.members_complete]
      );
      return;

    case "insertMember": {
      const [archetypeCode, mode, usageRole] = write.row.profile.split("|");
      await run(
        database,
        `insert into gac.team_profile_members (profile_id, unit_id, member_role, is_leader, sort_order)
         select profile.profile_id, $4, $5, $6, $7
         from gac.team_profiles profile
         join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
         where archetype.archetype_code = $1 and profile.mode = $2 and profile.usage_role = $3`,
        [archetypeCode, mode, usageRole, write.row.unit_id, write.row.member_role, write.row.is_leader, write.row.sort_order]
      );
      return;
    }

    case "insertMatchup": {
      const inserted = await run(
        database,
        `insert into gac.matchups (mode, defence_archetype_id, counter_archetype_id)
         values (
           $1,
           ${ARCHETYPE_ID}$2),
           ${ARCHETYPE_ID}$3)
         )
         returning matchup_id`,
        [write.row.mode, write.row.defence_archetype_code, write.row.counter_archetype_code]
      );
      const matchupId = inserted.rows[0].matchup_id;
      const values = write.values;
      await run(
        database,
        `insert into gac.matchup_catalogue_values
           (matchup_id, tier, banner_score, undersize, notes, tier_authority, banner_authority, undersize_authority)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          matchupId, values.tier, values.banner_score, values.undersize, values.notes,
          values.tier_authority, values.banner_authority, values.undersize_authority
        ]
      );
      return;
    }

    case "retireMatchup": {
      const [mode, defence, counter] = write.key.split("|");
      await run(
        database,
        `update gac.matchups
            set status = 'RETIRED', retired_at = statement_timestamp(), retired_reason = $4
          where mode = $1
            and defence_archetype_id = ${ARCHETYPE_ID}$2)
            and counter_archetype_id = ${ARCHETYPE_ID}$3)`,
        [mode, defence, counter, write.reason]
      );
      return;
    }

    case "insertDefenceValues":
      await run(
        database,
        `insert into gac.defence_catalogue_values (archetype_id, mode, threat, notes, threat_authority)
         select archetype_id, $2, $3, $4, $5 from gac.team_archetypes where archetype_code = $1`,
        [write.row.archetype_code, write.row.mode, write.row.threat, write.row.notes, write.row.threat_authority]
      );
      return;

    case "update": {
      const assignments = setClause(write.set, params);
      params.push(write.key);
      await run(
        database,
        `update ${write.table} set ${assignments} where ${write.keyColumn} = $${params.length}`,
        params
      );
      return;
    }

    case "updateProfile": {
      const assignments = setClause(write.set, params);
      params.push(write.archetype_code, write.mode, write.usage_role);
      await run(
        database,
        `update gac.team_profiles set ${assignments}
          where archetype_id = ${ARCHETYPE_ID}$${params.length - 2})
            and mode = $${params.length - 1} and usage_role = $${params.length}`,
        params
      );
      return;
    }

    case "updateMember": {
      const assignments = setClause(write.set, params);
      const [archetypeCode, mode, usageRole] = write.profile.split("|");
      params.push(archetypeCode, mode, usageRole, write.unit_id);
      await run(
        database,
        `update gac.team_profile_members set ${assignments}
          where profile_id = ${PROFILE_ID}$${params.length - 3}
             and profile.mode = $${params.length - 2} and profile.usage_role = $${params.length - 1})
            and unit_id = $${params.length}`,
        params
      );
      return;
    }

    case "updateMatchupValues": {
      const assignments = setClause(write.set, params);
      params.push(write.mode, write.defence_archetype_code, write.counter_archetype_code);
      await run(
        database,
        `update gac.matchup_catalogue_values set ${assignments}
          where matchup_id = (
            select matchup_id from gac.matchups
             where mode = $${params.length - 2}
               and defence_archetype_id = ${ARCHETYPE_ID}$${params.length - 1})
               and counter_archetype_id = ${ARCHETYPE_ID}$${params.length})
          )`,
        params
      );
      return;
    }

    case "updateDefenceValues": {
      const assignments = setClause(write.set, params);
      params.push(write.archetype_code, write.mode);
      await run(
        database,
        `update gac.defence_catalogue_values set ${assignments}
          where archetype_id = ${ARCHETYPE_ID}$${params.length - 1})
            and mode = $${params.length}`,
        params
      );
      return;
    }

    default:
      throw new Error(`Unhandled write kind ${write.kind}`);
  }
}

// ─── the authoring record ────────────────────────────────────────────────────

async function recordChange(database, change, expectedBaseReleaseId) {
  await run(
    database,
    `insert into gac.authoring_changes (
       change_id, author, authored_at, entity_type, operation,
       expected_base_release_id, structured_values, authority, reason, status, applied_at
     ) values ($1, $2, $3::timestamptz, $4, $5, $6, $7::jsonb, $8, $9, 'APPLIED', statement_timestamp())`,
    [
      change.change_id,
      change.author,
      change.authored_at,
      change.entity_type,
      change.operation,
      expectedBaseReleaseId,
      JSON.stringify(structuredValues(change)),
      change.authority,
      change.reason
    ]
  );
}

// A change ID is stable and may only ever describe one change. Re-running an
// applied change is allowed and must be a no-op; re-using its ID for different
// content, or re-running it after the catalogue has moved on, is refused.
async function reconcileExistingRecord(database, change, snapshot, issues) {
  const stored = snapshot.authoring_changes[change.change_id];
  if (stored === undefined) return false;

  for (const [column, value] of Object.entries({
    author: change.author,
    entity_type: change.entity_type,
    operation: change.operation,
    authority: change.authority,
    reason: change.reason,
    expected_base_release: change.expected_base_release
  })) {
    if (stored[column] !== value) {
      issues.push({
        code: "CHANGE_ID_REUSED",
        at: "changeId",
        message: `${change.change_id} is already recorded with ${column} ${JSON.stringify(stored[column])}, not ${JSON.stringify(value)}`
      });
    }
  }

  // jsonb does not preserve key order, so both sides are compared through the
  // same canonical serialisation the baseline tooling already uses.
  const storedValues = (await run(
    database,
    "select structured_values from gac.authoring_changes where change_id = $1",
    [change.change_id]
  )).rows[0].structured_values;
  const parsed = typeof storedValues === "string" ? JSON.parse(storedValues) : storedValues;
  if (canonicalJson(parsed) !== canonicalJson(structuredValues(change))) {
    issues.push({
      code: "CHANGE_ID_REUSED",
      at: "changeId",
      message: `${change.change_id} is already recorded with different operations`
    });
  }
  return true;
}

// ─── post-write invariants ───────────────────────────────────────────────────

async function verifyInvariants(database, releaseStateBefore) {
  const orphanRequired = await run(database, `
    select count(*)::int as total
    from gac.team_profile_members member
    join gac.units unit on unit.unit_id = member.unit_id
    where member.member_role = 'REQUIRED' and coalesce(unit.external_id, '') = ''
  `);
  if (orphanRequired.rows[0].total !== 0) {
    throw new Error(`${orphanRequired.rows[0].total} required members have no external_id after the change`);
  }

  const releaseStateAfter = await readReleaseState(database);
  if (JSON.stringify(releaseStateAfter) !== JSON.stringify(releaseStateBefore)) {
    throw new Error("ARCH-107 must not touch the release lifecycle; publication belongs to ARCH-108");
  }
}

async function readReleaseState(database) {
  const releases = (await run(database, "select count(*)::int as total from gac.catalogue_releases")).rows[0].total;
  const state = (await run(
    database,
    "select current_release_id, publication_generation from gac.catalogue_state where singleton_id"
  )).rows[0];
  return {
    releases,
    current_release_id: state?.current_release_id ?? null,
    publication_generation: Number(state?.publication_generation ?? 0)
  };
}

// ─── apply ───────────────────────────────────────────────────────────────────

async function applyChange(database, change, { dryRun = false, decisions } = {}) {
  const resolvedDecisions = decisions ?? readDecisions();
  let committed = false;

  await database.exec("begin");
  try {
    // Least privilege for the whole transaction. gac_authoring cannot reach
    // schema objects, roles, policies, evidence tables or the release lifecycle.
    await run(database, `set local role ${LOADER_ROLE}`);

    const before = await canonicalSnapshot(database);
    const payloadBefore = await projectPayload(database, resolvedDecisions);
    const releaseStateBefore = await readReleaseState(database);

    const issues = [];
    const base = await resolveBaseRelease(database, change, issues);
    const alreadyApplied = await reconcileExistingRecord(database, change, before, issues);
    validateAgainstState(change, before, issues, { isReplay: alreadyApplied });
    if (issues.length > 0) throw new AuthoringError(issues);

    const writes = planWrites(change, before);
    if (alreadyApplied && writes.length > 0) {
      throw new AuthoringError([{
        code: "ALREADY_APPLIED_DIVERGED",
        at: "changeId",
        message: `${change.change_id} is recorded as applied, but the catalogue no longer matches it: ${writes.map((write) => `${write.table}/${write.key}`).join(", ")}. Author a new change instead of replaying this one.`
      }]);
    }

    for (const write of writes) await executeWrite(database, write);
    if (!alreadyApplied) await recordChange(database, change, base.expected_base_release_id);

    const after = await canonicalSnapshot(database);
    const payloadAfter = await projectPayload(database, resolvedDecisions);
    await verifyInvariants(database, releaseStateBefore);

    const result = {
      changeId: change.change_id,
      dryRun,
      alreadyApplied,
      baseRelease: { expected: change.expected_base_release, current: base.currentVersion },
      writes: writes.map((write) => ({ table: write.table, key: write.key, kind: write.kind })),
      canonicalDiff: canonicalDiff(before, after),
      payloadDiff: diffPayloads(payloadBefore, payloadAfter).map((entry) => ({
        path: entry.path,
        before: entry.expected,
        after: entry.actual
      })),
      payloadAfter
    };

    if (dryRun) {
      await database.exec("rollback");
    } else {
      await database.exec("commit");
      committed = true;
    }
    result.committed = committed;
    return result;
  } catch (error) {
    await database.exec("rollback");
    throw error;
  }
}

// ─── disposable development database ─────────────────────────────────────────

// The same disposable/local pattern ARCH-105 and ARCH-106 use. No hosted
// database, connection string or credential is involved. With no --data-dir the
// database lives only in memory for the duration of the command.
async function openAuthoringDatabase({ dataDir = null, capture = DEFAULT_CAPTURE_ROOT, decisionsPath = DEFAULT_DECISIONS_PATH } = {}) {
  let database;
  if (dataDir === null) {
    database = await createDisposableDatabase();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    database = new PGlite(path.resolve(dataDir));
    await database.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      end $$;
    `);
  }

  const hasSchema = (await database.query(
    "select count(*)::int as total from information_schema.schemata where schema_name = 'gac'"
  )).rows[0].total > 0;

  if (!hasSchema) {
    await applySchema(database);
    const { plan, reconciliation } = buildPlan(readSources(capture), readDecisions(decisionsPath));
    assertLoadable(reconciliation);
    await loadPlan(database, plan, reconciliation);
  }
  return database;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { change: null, dataDir: null, twice: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--change") options.change = argv[++index];
    else if (arg === "--data-dir") options.dataDir = argv[++index];
    else if (arg === "--twice") options.twice = true;
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  if (options.change === null) throw new Error("--change <path> is required");
  return options;
}

function describeResult(result) {
  const lines = [];
  lines.push(`ARCH-107 apply: ${result.committed ? "committed" : "not committed"}`);
  lines.push(`  Change: ${result.changeId}`);
  lines.push(`  Base release: expected ${JSON.stringify(result.baseRelease.expected)}, current ${JSON.stringify(result.baseRelease.current)}`);
  lines.push(`  Writes: ${result.writes.length}`);
  lines.push(`  Canonical row changes: ${result.canonicalDiff.length}`);
  lines.push(`  Payload paths changed: ${result.payloadDiff.length}`);
  if (result.alreadyApplied) lines.push("  Already applied: the change was a verified no-op");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const change = readChangeFile(options.change);
  const database = await openAuthoringDatabase({ dataDir: options.dataDir });
  try {
    const first = await applyChange(database, change);
    console.log(describeResult(first));
    if (options.twice) {
      const second = await applyChange(database, change);
      console.log(describeResult(second));
      if (second.writes.length !== 0) throw new Error("Second apply was not a no-op");
      if (second.canonicalDiff.length !== 0) throw new Error("Second apply changed canonical state");
      console.log("  Idempotency: confirmed");
    }
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ARCH-107 apply failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_VERBS,
  AuthoringError,
  LOADER_ROLE,
  applyChange,
  assertAuthoringStatement,
  canonicalSnapshot,
  describeResult,
  openAuthoringDatabase,
  planWrites,
  readReleaseState,
  resolveBaseRelease,
  run,
  validateAgainstState
};
