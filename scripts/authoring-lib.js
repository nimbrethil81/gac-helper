#!/usr/bin/env node
"use strict";

// ARCH-107 human authoring: change-file schema, validation and canonical diff.
//
// This module is pure. It reads and validates a change file, normalises it into
// the canonical vocabulary ARCH-106 already established, and computes canonical
// row diffs. It opens no database, writes no file and contacts no service.
//
// Identity, mode and authority rules are deliberately imported from
// scripts/migration-lib.js rather than restated here, so ARCH-107 cannot drift
// into a competing definition of "valid".

const fs = require("node:fs");
const path = require("node:path");

const {
  ARCHETYPE_CODE_PATTERN,
  SOURCE_MODE_TO_CANONICAL,
  UNIT_ID_PATTERN,
  canonicalMode
} = require("./migration-lib.js");

const CHANGE_FILE_SCHEMA_VERSION = 1;

// gac.authoring_changes.change_id format, from ARCH-105.
const CHANGE_ID_PATTERN = /^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/;

// The ARCH-106 follow-up migration widened units_unit_id_format to allow the
// legacy lowercase segment in TIE_ADVANCED_x1. A change file may therefore
// reference that identifier, but a newly authored unit must still satisfy the
// stricter ARCH-105 uppercase form so no further legacy-shaped ID is created.
const UNIT_ID_REFERENCE_PATTERN = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/;

const AUTHOR_ROLES = Object.freeze(["OWNER", "MAINTENANCE"]);

// ASSESSED is deliberately absent: it is the automation authority state, and
// gac.matchup_catalogue_values requires a source assessment and finding to
// carry it. Human authoring can never supply either.
const AUTHORED_STATES = Object.freeze(["AUTHORED_LOCKED", "AUTHORED_BASELINE"]);

const TIERS = Object.freeze(["S", "A", "B", "C"]);
const THREATS = Object.freeze(["LOW", "NORMAL", "HIGH", "EXTREME"]);
const UNIT_TYPES = Object.freeze(["CHARACTER", "SHIP", "CAPITAL_SHIP"]);
const MEMBER_ROLES = Object.freeze(["REQUIRED", "RECOMMENDED"]);
const USAGE_ROLES = Object.freeze(["ATTACK", "DEFENCE"]);
const BATTLE_TYPES = Object.freeze(["SQUAD", "FLEET"]);
const IDENTITY_REASONS = Object.freeze([
  "DISTINCT_LEADER",
  "DISTINCT_CORE",
  "DISTINCT_RESOURCE_CONFLICT",
  "DISTINCT_MATCHUP_BEHAVIOUR",
  "NEW_GAME_ARCHETYPE",
  "LEGACY_MIGRATION",
  "OTHER_APPROVED"
]);
const ACTOR_ORIGINS = Object.freeze(["HUMAN", "AUTOMATION"]);

// Full-squad, first-attempt, clean-clear ceilings from docs/SCORING_REFERENCE.md.
// banner_score carries no undersize or attempt adjustment, so the ceiling is the
// flawless full-squad total for the mode.
const BANNER_CEILING = Object.freeze({ "3V3": 57, "5V5": 65, FLEET: 73 });

// The most units a counter can drop and still field one. gac's
// matchup_catalogue_values_undersize_range caps the column at 5, which binds
// before the fleet format's theoretical 6.
const UNDERSIZE_CEILING = Object.freeze({ "3V3": 2, "5V5": 4, FLEET: 5 });

// Authoring hygiene for human-written notes. Every one of the 97 migrated notes
// satisfies these rules; they exist so newly authored text cannot smuggle in
// line breaks, control characters or invisible padding that the payload would
// carry to the client.
const NOTES_MAX_LENGTH = 500;

const ENTITIES = Object.freeze({
  unit: ["create", "update", "retire"],
  archetype: ["create", "update", "retire"],
  profile: ["create", "update", "retire"],
  member: ["create", "update"],
  matchup: ["create", "update", "retire"],
  defenceValues: ["create", "update"]
});

// Keys each operation shape accepts. Anything else is rejected rather than
// ignored, so a typo can never be silently dropped.
const OPERATION_KEYS = Object.freeze({
  "unit.create": ["entity", "operation", "unitId", "displayName", "unitType", "externalId"],
  "unit.update": ["entity", "operation", "unitId", "displayName", "externalId"],
  "unit.retire": ["entity", "operation", "unitId"],
  "archetype.create": [
    "entity", "operation", "archetypeCode", "displayName", "battleType",
    "identityReason", "identityReasonDetail", "createdBy"
  ],
  "archetype.update": ["entity", "operation", "archetypeCode", "displayName", "identityReason", "identityReasonDetail"],
  "archetype.retire": ["entity", "operation", "archetypeCode"],
  "profile.create": ["entity", "operation", "archetypeCode", "mode", "usageRole", "flexSlots", "membersComplete"],
  "profile.update": ["entity", "operation", "archetypeCode", "mode", "usageRole", "flexSlots", "membersComplete"],
  "profile.retire": ["entity", "operation", "archetypeCode", "mode", "usageRole"],
  "member.create": [
    "entity", "operation", "archetypeCode", "mode", "usageRole",
    "unitId", "memberRole", "isLeader", "sortOrder"
  ],
  "member.update": [
    "entity", "operation", "archetypeCode", "mode", "usageRole",
    "unitId", "memberRole", "isLeader", "sortOrder"
  ],
  "matchup.create": [
    "entity", "operation", "mode", "defenceArchetypeCode", "counterArchetypeCode",
    "values", "acknowledgeLocked"
  ],
  "matchup.update": [
    "entity", "operation", "mode", "defenceArchetypeCode", "counterArchetypeCode",
    "values", "acknowledgeLocked"
  ],
  "matchup.retire": [
    "entity", "operation", "mode", "defenceArchetypeCode", "counterArchetypeCode", "retiredReason"
  ],
  "defenceValues.create": ["entity", "operation", "archetypeCode", "mode", "values", "acknowledgeLocked"],
  "defenceValues.update": ["entity", "operation", "archetypeCode", "mode", "values", "acknowledgeLocked"]
});

const MATCHUP_VALUE_KEYS = Object.freeze([
  "tier", "bannerScore", "undersize", "notes",
  "tierAuthority", "bannerAuthority", "undersizeAuthority"
]);
const DEFENCE_VALUE_KEYS = Object.freeze(["threat", "notes", "threatAuthority"]);

const CHANGE_FILE_KEYS = Object.freeze([
  "schemaVersion", "changeId", "author", "authorRole", "authoredAt",
  "reason", "expectedBaseRelease", "operations"
]);

// ─── issue collection ────────────────────────────────────────────────────────

class Issues {
  constructor() { this.entries = []; }

  add(code, at, message) {
    this.entries.push({ code, at, message });
    return false;
  }

  get ok() { return this.entries.length === 0; }

  get report() {
    return this.entries.map((issue) => `${issue.at}: ${issue.message} [${issue.code}]`).join("\n");
  }
}

class ChangeFileError extends Error {
  constructor(issues) {
    super(`Change file rejected:\n${issues.report}`);
    this.name = "ChangeFileError";
    this.issues = issues.entries;
  }
}

// ─── primitive checks ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(issues, at, value, { allowEmpty = false, maxLength = 200 } = {}) {
  if (typeof value !== "string") return issues.add("TYPE", at, `expected a string, got ${JSON.stringify(value)}`);
  if (!allowEmpty && value.trim() === "") return issues.add("EMPTY", at, "must not be blank");
  if (value.length > maxLength) return issues.add("LENGTH", at, `must be at most ${maxLength} characters`);
  return true;
}

function requireInteger(issues, at, value, { min, max }) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return issues.add("TYPE", at, `expected an integer, got ${JSON.stringify(value)}`);
  }
  if (value < min || value > max) {
    return issues.add("RANGE", at, `must be between ${min} and ${max}, got ${value}`);
  }
  return true;
}

function requireBoolean(issues, at, value) {
  if (typeof value !== "boolean") return issues.add("TYPE", at, `expected true or false, got ${JSON.stringify(value)}`);
  return true;
}

function requireEnum(issues, at, value, allowed) {
  if (!allowed.includes(value)) {
    return issues.add("ENUM", at, `must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return true;
}

function rejectUnknownKeys(issues, at, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issues.add("UNKNOWN_KEY", `${at}.${key}`, "is not a recognised field");
  }
}

function requireNotes(issues, at, value) {
  if (typeof value !== "string") return issues.add("TYPE", at, `expected a string, got ${JSON.stringify(value)}`);
  if (value.length > NOTES_MAX_LENGTH) {
    return issues.add("LENGTH", at, `must be at most ${NOTES_MAX_LENGTH} characters, got ${value.length}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return issues.add("NOTES_CONTROL_CHARACTER", at, "must not contain control characters or line breaks");
  }
  if (value !== value.trim()) {
    return issues.add("NOTES_PADDING", at, "must not start or end with whitespace");
  }
  return true;
}

function requireTimestamp(issues, at, value) {
  if (typeof value !== "string") return issues.add("TYPE", at, `expected an ISO 8601 timestamp string, got ${JSON.stringify(value)}`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return issues.add("TIMESTAMP", at, `is not a valid ISO 8601 timestamp: ${JSON.stringify(value)}`);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return issues.add("TIMESTAMP_OFFSET", at, "must carry an explicit UTC offset so two machines agree");
  }
  return true;
}

// ─── mode handling, reusing the ARCH-106 vocabulary ──────────────────────────

function normaliseMode(issues, at, value, { allowAny }) {
  if (typeof value !== "string" || SOURCE_MODE_TO_CANONICAL[value] === undefined) {
    issues.add(
      "MODE",
      at,
      `must be one of ${Object.keys(SOURCE_MODE_TO_CANONICAL).join(", ")}, got ${JSON.stringify(value)}`
    );
    return null;
  }
  const mode = canonicalMode(value);
  if (mode === "ANY" && !allowAny) {
    issues.add("MODE", at, "ANY is not a battle mode; use 3v3, 5v5 or FLEET");
    return null;
  }
  return mode;
}

// ─── operation validation ────────────────────────────────────────────────────

function validateMatchupValues(issues, at, values, { mode, required }) {
  if (!isPlainObject(values)) {
    issues.add("TYPE", at, "must be an object of matchup values");
    return null;
  }
  rejectUnknownKeys(issues, at, values, MATCHUP_VALUE_KEYS);

  const normalised = {};
  const present = (key) => Object.prototype.hasOwnProperty.call(values, key);

  if (required && !present("tier")) issues.add("REQUIRED", `${at}.tier`, "is required when a matchup is created");
  if (required && !present("bannerScore")) issues.add("REQUIRED", `${at}.bannerScore`, "is required when a matchup is created");

  if (present("tier") && requireEnum(issues, `${at}.tier`, values.tier, TIERS)) normalised.tier = values.tier;

  if (present("bannerScore")) {
    const ceiling = mode === null ? 100 : BANNER_CEILING[mode];
    if (requireInteger(issues, `${at}.bannerScore`, values.bannerScore, { min: 0, max: ceiling })) {
      normalised.banner_score = values.bannerScore;
    }
  }
  if (present("undersize")) {
    const ceiling = mode === null ? 5 : UNDERSIZE_CEILING[mode];
    if (requireInteger(issues, `${at}.undersize`, values.undersize, { min: 0, max: ceiling })) {
      normalised.undersize = values.undersize;
    }
  }
  if (present("notes") && requireNotes(issues, `${at}.notes`, values.notes)) normalised.notes = values.notes;

  for (const [key, column] of [
    ["tierAuthority", "tier_authority"],
    ["bannerAuthority", "banner_authority"],
    ["undersizeAuthority", "undersize_authority"]
  ]) {
    if (!present(key)) continue;
    if (requireEnum(issues, `${at}.${key}`, values[key], AUTHORED_STATES)) normalised[column] = values[key];
  }

  if (Object.keys(normalised).length === 0 && issues.ok) {
    issues.add("EMPTY_VALUES", at, "changes nothing; remove the operation or give it a value");
  }
  return normalised;
}

function validateDefenceValues(issues, at, values, { required }) {
  if (!isPlainObject(values)) {
    issues.add("TYPE", at, "must be an object of defence values");
    return null;
  }
  rejectUnknownKeys(issues, at, values, DEFENCE_VALUE_KEYS);

  const normalised = {};
  const present = (key) => Object.prototype.hasOwnProperty.call(values, key);

  if (required && !present("threat")) issues.add("REQUIRED", `${at}.threat`, "is required when a defence value row is created");
  if (present("threat") && requireEnum(issues, `${at}.threat`, values.threat, THREATS)) normalised.threat = values.threat;
  if (present("notes") && requireNotes(issues, `${at}.notes`, values.notes)) normalised.notes = values.notes;
  if (present("threatAuthority") && requireEnum(issues, `${at}.threatAuthority`, values.threatAuthority, AUTHORED_STATES)) {
    normalised.threat_authority = values.threatAuthority;
  }

  if (Object.keys(normalised).length === 0 && issues.ok) {
    issues.add("EMPTY_VALUES", at, "changes nothing; remove the operation or give it a value");
  }
  return normalised;
}

function validateOperation(issues, index, raw) {
  const at = `operations[${index}]`;
  if (!isPlainObject(raw)) {
    issues.add("TYPE", at, "must be an object");
    return null;
  }
  if (!requireString(issues, `${at}.entity`, raw.entity) || !requireString(issues, `${at}.operation`, raw.operation)) {
    return null;
  }
  const allowedOperations = ENTITIES[raw.entity];
  if (allowedOperations === undefined) {
    issues.add("ENTITY", `${at}.entity`, `must be one of ${Object.keys(ENTITIES).join(", ")}, got ${JSON.stringify(raw.entity)}`);
    return null;
  }
  if (!allowedOperations.includes(raw.operation)) {
    // member.retire is the one deliberate gap: gac_authoring holds no DELETE
    // grant on gac.team_profile_members and the table carries no lifecycle
    // column, so ARCH-107 cannot remove a member without a permission change
    // that belongs to the owner, not to this package. See docs/database/ARCH-107.md.
    issues.add(
      "OPERATION",
      `${at}.operation`,
      `${raw.entity} supports ${allowedOperations.join(", ")}, not ${JSON.stringify(raw.operation)}`
    );
    return null;
  }

  const shape = `${raw.entity}.${raw.operation}`;
  rejectUnknownKeys(issues, at, raw, OPERATION_KEYS[shape]);

  const op = { entity: raw.entity, operation: raw.operation, at, shape };
  const present = (key) => Object.prototype.hasOwnProperty.call(raw, key);

  if (["unit", "member"].includes(raw.entity)) {
    if (requireString(issues, `${at}.unitId`, raw.unitId, { maxLength: 100 })) {
      const pattern = raw.entity === "unit" && raw.operation === "create"
        ? UNIT_ID_PATTERN
        : UNIT_ID_REFERENCE_PATTERN;
      if (!pattern.test(raw.unitId)) {
        issues.add(
          "UNIT_ID_FORMAT",
          `${at}.unitId`,
          raw.entity === "unit" && raw.operation === "create"
            ? `a newly authored unit_id must match ${UNIT_ID_PATTERN}`
            : `unit_id must match ${UNIT_ID_REFERENCE_PATTERN}`
        );
      } else {
        op.unit_id = raw.unitId;
      }
    }
  }

  if (["archetype", "profile", "member", "defenceValues"].includes(raw.entity)) {
    if (requireString(issues, `${at}.archetypeCode`, raw.archetypeCode, { maxLength: 100 })) {
      if (!ARCHETYPE_CODE_PATTERN.test(raw.archetypeCode)) {
        issues.add("ARCHETYPE_CODE_FORMAT", `${at}.archetypeCode`, `must match ${ARCHETYPE_CODE_PATTERN}`);
      } else {
        op.archetype_code = raw.archetypeCode;
      }
    }
  }

  switch (shape) {
    case "unit.create":
      if (requireString(issues, `${at}.displayName`, raw.displayName)) op.display_name = raw.displayName;
      if (requireEnum(issues, `${at}.unitType`, raw.unitType, UNIT_TYPES)) op.unit_type = raw.unitType;
      op.external_id = null;
      if (present("externalId") && raw.externalId !== null) {
        if (requireString(issues, `${at}.externalId`, raw.externalId, { maxLength: 100 })) op.external_id = raw.externalId;
      }
      break;

    case "unit.update":
      if (present("displayName") && requireString(issues, `${at}.displayName`, raw.displayName)) {
        op.display_name = raw.displayName;
      }
      if (present("externalId")) {
        if (raw.externalId === null) op.external_id = null;
        else if (requireString(issues, `${at}.externalId`, raw.externalId, { maxLength: 100 })) op.external_id = raw.externalId;
      }
      if (!present("displayName") && !present("externalId")) {
        issues.add("EMPTY_VALUES", at, "changes nothing; give displayName or externalId");
      }
      break;

    case "unit.retire":
      break;

    case "archetype.create":
      if (requireString(issues, `${at}.displayName`, raw.displayName)) op.display_name = raw.displayName;
      if (requireEnum(issues, `${at}.battleType`, raw.battleType, BATTLE_TYPES)) op.battle_type = raw.battleType;
      if (requireEnum(issues, `${at}.identityReason`, raw.identityReason, IDENTITY_REASONS)) {
        op.identity_reason = raw.identityReason;
      }
      op.identity_reason_detail = null;
      if (present("identityReasonDetail") && raw.identityReasonDetail !== null) {
        if (requireString(issues, `${at}.identityReasonDetail`, raw.identityReasonDetail, { maxLength: NOTES_MAX_LENGTH })) {
          op.identity_reason_detail = raw.identityReasonDetail;
        }
      }
      if (raw.identityReason === "OTHER_APPROVED" && (op.identity_reason_detail ?? "").trim() === "") {
        issues.add("REQUIRED", `${at}.identityReasonDetail`, "is required when identityReason is OTHER_APPROVED");
      }
      op.created_by = "HUMAN";
      if (present("createdBy") && requireEnum(issues, `${at}.createdBy`, raw.createdBy, ACTOR_ORIGINS)) {
        op.created_by = raw.createdBy;
      }
      break;

    case "archetype.update":
      if (present("displayName") && requireString(issues, `${at}.displayName`, raw.displayName)) {
        op.display_name = raw.displayName;
      }
      if (present("identityReason") && requireEnum(issues, `${at}.identityReason`, raw.identityReason, IDENTITY_REASONS)) {
        op.identity_reason = raw.identityReason;
      }
      if (present("identityReasonDetail")) {
        if (raw.identityReasonDetail === null) op.identity_reason_detail = null;
        else if (requireString(issues, `${at}.identityReasonDetail`, raw.identityReasonDetail, { maxLength: NOTES_MAX_LENGTH })) {
          op.identity_reason_detail = raw.identityReasonDetail;
        }
      }
      if (!present("displayName") && !present("identityReason") && !present("identityReasonDetail")) {
        issues.add("EMPTY_VALUES", at, "changes nothing; give displayName, identityReason or identityReasonDetail");
      }
      break;

    case "archetype.retire":
      break;

    case "profile.create":
    case "profile.update":
    case "profile.retire":
      op.mode = normaliseMode(issues, `${at}.mode`, raw.mode, { allowAny: true });
      if (requireEnum(issues, `${at}.usageRole`, raw.usageRole, USAGE_ROLES)) op.usage_role = raw.usageRole;
      if (raw.operation !== "retire") {
        if (present("flexSlots")) {
          if (requireInteger(issues, `${at}.flexSlots`, raw.flexSlots, { min: 0, max: 10 })) op.flex_slots = raw.flexSlots;
        } else if (raw.operation === "create") {
          op.flex_slots = 0;
        }
        if (present("membersComplete")) {
          if (requireBoolean(issues, `${at}.membersComplete`, raw.membersComplete)) op.members_complete = raw.membersComplete;
        } else if (raw.operation === "create") {
          op.members_complete = false;
        }
        if (raw.operation === "update" && !present("flexSlots") && !present("membersComplete")) {
          issues.add("EMPTY_VALUES", at, "changes nothing; give flexSlots or membersComplete");
        }
      }
      break;

    case "member.create":
    case "member.update":
      op.mode = normaliseMode(issues, `${at}.mode`, raw.mode, { allowAny: true });
      if (requireEnum(issues, `${at}.usageRole`, raw.usageRole, USAGE_ROLES)) op.usage_role = raw.usageRole;
      if (present("memberRole")) {
        if (requireEnum(issues, `${at}.memberRole`, raw.memberRole, MEMBER_ROLES)) op.member_role = raw.memberRole;
      } else if (raw.operation === "create") {
        issues.add("REQUIRED", `${at}.memberRole`, "is required when a member is created");
      }
      if (present("isLeader")) {
        if (requireBoolean(issues, `${at}.isLeader`, raw.isLeader)) op.is_leader = raw.isLeader;
      } else if (raw.operation === "create") {
        op.is_leader = false;
      }
      if (present("sortOrder")) {
        if (requireInteger(issues, `${at}.sortOrder`, raw.sortOrder, { min: 0, max: 32 })) op.sort_order = raw.sortOrder;
      } else if (raw.operation === "create") {
        issues.add("REQUIRED", `${at}.sortOrder`, "is required when a member is created");
      }
      if (op.is_leader === true && op.member_role === "RECOMMENDED") {
        issues.add("LEADER_ROLE", `${at}.isLeader`, "a leader must be a REQUIRED member");
      }
      if (raw.operation === "update" && !present("memberRole") && !present("isLeader") && !present("sortOrder")) {
        issues.add("EMPTY_VALUES", at, "changes nothing; give memberRole, isLeader or sortOrder");
      }
      break;

    case "matchup.create":
    case "matchup.update":
    case "matchup.retire":
      op.mode = normaliseMode(issues, `${at}.mode`, raw.mode, { allowAny: false });
      if (requireString(issues, `${at}.defenceArchetypeCode`, raw.defenceArchetypeCode, { maxLength: 100 })) {
        if (!ARCHETYPE_CODE_PATTERN.test(raw.defenceArchetypeCode)) {
          issues.add("ARCHETYPE_CODE_FORMAT", `${at}.defenceArchetypeCode`, `must match ${ARCHETYPE_CODE_PATTERN}`);
        } else {
          op.defence_archetype_code = raw.defenceArchetypeCode;
        }
      }
      if (requireString(issues, `${at}.counterArchetypeCode`, raw.counterArchetypeCode, { maxLength: 100 })) {
        if (!ARCHETYPE_CODE_PATTERN.test(raw.counterArchetypeCode)) {
          issues.add("ARCHETYPE_CODE_FORMAT", `${at}.counterArchetypeCode`, `must match ${ARCHETYPE_CODE_PATTERN}`);
        } else {
          op.counter_archetype_code = raw.counterArchetypeCode;
        }
      }
      if (raw.operation === "retire") {
        if (requireString(issues, `${at}.retiredReason`, raw.retiredReason, { maxLength: NOTES_MAX_LENGTH })) {
          op.retired_reason = raw.retiredReason;
        }
      } else {
        op.values = validateMatchupValues(issues, `${at}.values`, raw.values, {
          mode: op.mode ?? null,
          required: raw.operation === "create"
        });
        op.acknowledge_locked = false;
        if (present("acknowledgeLocked") && requireBoolean(issues, `${at}.acknowledgeLocked`, raw.acknowledgeLocked)) {
          op.acknowledge_locked = raw.acknowledgeLocked;
        }
      }
      break;

    case "defenceValues.create":
    case "defenceValues.update":
      op.mode = normaliseMode(issues, `${at}.mode`, raw.mode, { allowAny: true });
      op.values = validateDefenceValues(issues, `${at}.values`, raw.values, { required: raw.operation === "create" });
      op.acknowledge_locked = false;
      if (present("acknowledgeLocked") && requireBoolean(issues, `${at}.acknowledgeLocked`, raw.acknowledgeLocked)) {
        op.acknowledge_locked = raw.acknowledgeLocked;
      }
      break;

    default:
      issues.add("OPERATION", at, `unhandled operation shape ${shape}`);
      return null;
  }

  return op;
}

// A stable, human-readable key per target row. Two operations that resolve to
// the same key are ambiguous — the loader refuses rather than guessing an order.
function operationKey(op) {
  switch (op.entity) {
    case "unit": return `unit:${op.unit_id}`;
    case "archetype": return `archetype:${op.archetype_code}`;
    case "profile": return `profile:${op.archetype_code}:${op.mode}:${op.usage_role}`;
    case "member": return `member:${op.archetype_code}:${op.mode}:${op.usage_role}:${op.unit_id}`;
    case "matchup":
      return `matchup:${op.mode}:${op.defence_archetype_code}:${op.counter_archetype_code}`;
    case "defenceValues": return `defenceValues:${op.archetype_code}:${op.mode}`;
    default: throw new Error(`Unhandled entity ${op.entity}`);
  }
}

// ─── change-file validation ──────────────────────────────────────────────────

function validateChange(document, { source = "(inline)" } = {}) {
  const issues = new Issues();

  if (!isPlainObject(document)) {
    issues.add("TYPE", source, "a change file must be a JSON object");
    throw new ChangeFileError(issues);
  }
  rejectUnknownKeys(issues, "(root)", document, CHANGE_FILE_KEYS);

  if (document.schemaVersion !== CHANGE_FILE_SCHEMA_VERSION) {
    issues.add(
      "SCHEMA_VERSION",
      "schemaVersion",
      `must be ${CHANGE_FILE_SCHEMA_VERSION}, got ${JSON.stringify(document.schemaVersion)}`
    );
  }

  const change = { source, schema_version: CHANGE_FILE_SCHEMA_VERSION };

  if (requireString(issues, "changeId", document.changeId, { maxLength: 120 })) {
    if (!CHANGE_ID_PATTERN.test(document.changeId)) {
      issues.add("CHANGE_ID_FORMAT", "changeId", `must match ${CHANGE_ID_PATTERN}`);
    } else {
      change.change_id = document.changeId;
    }
  }
  if (requireString(issues, "author", document.author, { maxLength: 120 })) change.author = document.author;
  if (requireEnum(issues, "authorRole", document.authorRole, AUTHOR_ROLES)) change.author_role = document.authorRole;
  if (requireTimestamp(issues, "authoredAt", document.authoredAt)) {
    change.authored_at = new Date(document.authoredAt).toISOString();
  }
  if (requireString(issues, "reason", document.reason, { maxLength: NOTES_MAX_LENGTH })) change.reason = document.reason;

  if (!Object.prototype.hasOwnProperty.call(document, "expectedBaseRelease")) {
    issues.add(
      "REQUIRED",
      "expectedBaseRelease",
      "is required; use null to assert that no release has been published yet"
    );
  } else if (document.expectedBaseRelease === null) {
    change.expected_base_release = null;
  } else if (requireInteger(issues, "expectedBaseRelease", document.expectedBaseRelease, { min: 1, max: Number.MAX_SAFE_INTEGER })) {
    change.expected_base_release = document.expectedBaseRelease;
  }

  if (!Array.isArray(document.operations) || document.operations.length === 0) {
    issues.add("OPERATIONS", "operations", "must be a non-empty array");
    throw new ChangeFileError(issues);
  }

  const operations = [];
  const seenKeys = new Map();
  document.operations.forEach((raw, index) => {
    const op = validateOperation(issues, index, raw);
    if (op === null) return;
    operations.push(op);
    let key;
    try {
      key = operationKey(op);
    } catch {
      return;
    }
    op.key = key;
    if (seenKeys.has(key)) {
      issues.add(
        "DUPLICATE_OPERATION",
        op.at,
        `targets ${key}, which operations[${seenKeys.get(key)}] already targets`
      );
    } else {
      seenKeys.set(key, index);
    }
  });
  change.operations = operations;

  // Only OWNER may declare a value locked, and only OWNER may knowingly touch
  // one. The maintenance role can propose a lock in review, never apply one.
  for (const op of operations) {
    const authorities = [
      op.values?.tier_authority,
      op.values?.banner_authority,
      op.values?.undersize_authority,
      op.values?.threat_authority
    ].filter((value) => value !== undefined);
    if (authorities.includes("AUTHORED_LOCKED") && change.author_role !== "OWNER") {
      issues.add("LOCK_REQUIRES_OWNER", op.at, "only an OWNER change may set an AUTHORED_LOCKED authority");
    }
    if (op.acknowledge_locked === true && change.author_role !== "OWNER") {
      issues.add("LOCK_REQUIRES_OWNER", op.at, "only an OWNER change may acknowledge a locked value");
    }
  }

  if (!issues.ok) throw new ChangeFileError(issues);

  change.entity_type = summarise(operations.map((op) => op.entity));
  change.operation = summarise(operations.map((op) => op.operation));
  change.authority = summariseAuthority(operations);
  return change;
}

function summarise(values) {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : "MULTIPLE";
}

// gac.authoring_changes.authority is a single nullable column. It records the
// authority when every judgement-bearing operation agrees, and stays NULL
// otherwise; the full per-field detail always lives in structured_values.
function summariseAuthority(operations) {
  const declared = new Set();
  for (const op of operations) {
    if (!op.values) continue;
    for (const column of ["tier_authority", "banner_authority", "undersize_authority", "threat_authority"]) {
      if (op.values[column] !== undefined) declared.add(op.values[column]);
    }
  }
  return declared.size === 1 ? [...declared][0] : null;
}

function readChangeFile(changePath) {
  const resolved = path.resolve(changePath);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Cannot read change file ${changePath}: ${error.message}`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Change file ${changePath} is not valid JSON: ${error.message}`);
  }
  return validateChange(document, { source: path.relative(process.cwd(), resolved) || resolved });
}

// The record stored in gac.authoring_changes.structured_values. It is the full
// normalised change minus the fields the table already carries in columns.
function structuredValues(change) {
  return {
    package: "ARCH-107",
    schemaVersion: change.schema_version,
    source: change.source,
    authorRole: change.author_role,
    expectedBaseRelease: change.expected_base_release,
    operations: change.operations.map((op) => {
      const record = { ...op };
      delete record.at;
      delete record.shape;
      return record;
    })
  };
}

// ─── canonical diff ──────────────────────────────────────────────────────────

// Row-level diff between two canonical snapshots, keyed on business identity
// rather than surrogate keys. created_at and updated_at are audit columns and
// are excluded by the snapshot, so a diff entry always means a real change.
function canonicalDiff(before, after) {
  const changes = [];
  for (const table of Object.keys(after)) {
    const beforeRows = before[table] ?? {};
    const afterRows = after[table];
    for (const key of [...new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)])].sort()) {
      const previous = beforeRows[key];
      const next = afterRows[key];
      if (previous === undefined) {
        changes.push({ table, key, operation: "INSERT", before: null, after: next, columns: Object.keys(next).sort() });
        continue;
      }
      if (next === undefined) {
        changes.push({ table, key, operation: "DELETE", before: previous, after: null, columns: Object.keys(previous).sort() });
        continue;
      }
      const columns = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
        .filter((column) => JSON.stringify(previous[column]) !== JSON.stringify(next[column]))
        .sort();
      if (columns.length > 0) {
        changes.push({
          table,
          key,
          operation: "UPDATE",
          before: Object.fromEntries(columns.map((column) => [column, previous[column] ?? null])),
          after: Object.fromEntries(columns.map((column) => [column, next[column] ?? null])),
          columns
        });
      }
    }
  }
  return changes;
}

module.exports = {
  AUTHORED_STATES,
  AUTHOR_ROLES,
  BANNER_CEILING,
  CHANGE_FILE_SCHEMA_VERSION,
  CHANGE_ID_PATTERN,
  ChangeFileError,
  ENTITIES,
  NOTES_MAX_LENGTH,
  UNDERSIZE_CEILING,
  UNIT_ID_REFERENCE_PATTERN,
  canonicalDiff,
  operationKey,
  readChangeFile,
  structuredValues,
  validateChange
};
