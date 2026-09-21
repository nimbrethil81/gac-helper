"use strict";

// ARCH-106 migration library.
//
// Transforms the committed ARCH-103 Google Sheets baseline into the ARCH-105
// canonical schema. Everything here is a pure function of the capture directory
// and the committed decision file, so the reconciliation report, the loaded
// canonical state and the compatibility projection are identical on every run
// and in every database.
//
// No statement in this file contacts a network service, and nothing writes to
// the ARCH-103 capture directory.

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { parseCsv, resolveCaptureRoot, resolveRegularFile } = require("./baseline-lib.js");
const { verifyBaseline } = require("./verify-baseline.js");

const DEFAULT_CAPTURE_ROOT = path.join("data", "exports", "20260921T085937Z");
const DEFAULT_DECISIONS_PATH = path.join("data", "migration", "arch-106-decisions.json");

const ARCHETYPE_CODE_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const UNIT_ID_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const TIERS = new Set(["S", "A", "B", "C"]);
const THREATS = new Set(["LOW", "NORMAL", "HIGH", "EXTREME"]);
const UNIT_TYPES = new Set(["CHARACTER", "SHIP", "CAPITAL_SHIP"]);
const MEMBER_ROLES = new Set(["REQUIRED", "RECOMMENDED"]);
const LEAGUES = new Set(["KYBER", "AURODIUM", "CHROMIUM", "BRONZIUM", "CARBONITE"]);
const TERRITORIES = new Set(["FRONT_TOP", "FRONT_BOTTOM", "BACK_TOP", "BACK_BOTTOM"]);

// ─── source reading ──────────────────────────────────────────────────────────

// Read one exported tab as objects keyed by its exact header names. sourceRow is
// the spreadsheet row number, so every reconciliation entry points back at a
// cell a human can open.
function readSheet(captureRoot, filename) {
  const resolved = resolveRegularFile(captureRoot, filename);
  const rows = parseCsv(fs.readFileSync(resolved.absolutePath, "utf8"));
  const headers = rows[0];
  return rows.slice(1).map((cells, index) => {
    const record = { sourceRow: index + 2 };
    headers.forEach((header, column) => { record[header] = cells[column] ?? ""; });
    return record;
  });
}

// Verify the ARCH-103 fixture before reading a single byte of it. A corrupted or
// edited capture must fail here, not halfway through a load.
function readSources(captureRoot = DEFAULT_CAPTURE_ROOT) {
  const root = resolveCaptureRoot(captureRoot);
  const baseline = verifyBaseline(root);

  const manifestPath = resolveRegularFile(root, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath.absolutePath, "utf8"));
  const byTab = new Map(manifest.sheetExports.map((sheet) => [sheet.tabName, sheet.filename]));

  const payloadPath = resolveRegularFile(root, manifest.appsScriptPayload.canonicalFilename);
  const goldenPayload = JSON.parse(fs.readFileSync(payloadPath.absolutePath, "utf8"));

  return {
    captureRoot: root,
    captureDirectory: path.basename(root),
    manifest,
    baseline,
    goldenPayload,
    counters: readSheet(root, byTab.get("Counters")),
    defenceTeams: readSheet(root, byTab.get("Defence_Teams")),
    scoreMeanings: readSheet(root, byTab.get("Score_Meanings")),
    counterDefinitions: readSheet(root, byTab.get("Counter_Definitions")),
    counterComposition: readSheet(root, byTab.get("Counter_Composition")),
    characterDefinitions: readSheet(root, byTab.get("Character_Definitions")),
    boardConfig: readSheet(root, byTab.get("GAC_Board_Config")),
    scoring: readSheet(root, byTab.get("GAC_Scoring"))
  };
}

function readDecisions(decisionsPath = DEFAULT_DECISIONS_PATH) {
  const decisions = JSON.parse(fs.readFileSync(path.resolve(decisionsPath), "utf8"));
  if (decisions.schemaVersion !== 1) {
    throw new Error(`Unsupported decision schemaVersion: ${decisions.schemaVersion}`);
  }
  if (decisions.package !== "ARCH-106") {
    throw new Error(`Decision file is not an ARCH-106 decision file: ${decisions.package}`);
  }
  if (!Array.isArray(decisions.anomalies)) throw new Error("Decision file has no anomalies array");
  return decisions;
}

function findAnomaly(decisions, id) {
  return decisions.anomalies.find((anomaly) => anomaly.id === id) ?? null;
}

// A decision counts as settled only when it is explicitly RESOLVED and names a
// resolution. Anything else stops the load.
function resolutionOf(decisions, id) {
  const anomaly = findAnomaly(decisions, id);
  if (!anomaly) return null;
  return anomaly.status === "RESOLVED" && anomaly.resolution ? anomaly.resolution : null;
}

// ─── deterministic helpers ───────────────────────────────────────────────────

const SOURCE_MODE_TO_CANONICAL = Object.freeze({
  "3v3": "3V3",
  "5v5": "5V5",
  FLEET: "FLEET",
  Any: "ANY",
  ANY: "ANY"
});

function canonicalMode(sourceMode) {
  const canonical = SOURCE_MODE_TO_CANONICAL[sourceMode];
  if (!canonical) throw new Error(`Unrecognised source mode: ${JSON.stringify(sourceMode)}`);
  return canonical;
}

function publicMode(domain, decisions, mode) {
  const table = decisions.modeNormalisation.canonicalToPublic[domain];
  if (!table || !table[mode]) {
    throw new Error(`No public mode spelling for ${domain}.${mode}`);
  }
  return table[mode];
}

// DEF_ + the display name uppercased, every character outside [A-Z0-9] replaced
// by _, runs collapsed, edges trimmed. Names are processed in ascending
// code-point order and collisions take the first free _N suffix, so the outcome
// never depends on source row order.
function defenceOnlyCodeBase(displayName) {
  const base = displayName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (base === "") throw new Error(`Defence display name yields no usable code: ${JSON.stringify(displayName)}`);
  return `DEF_${base}`;
}

function allocateDefenceOnlyCode(displayName, taken) {
  const base = defenceOnlyCodeBase(displayName);
  let code = base;
  let suffix = 1;
  while (taken.has(code)) {
    suffix += 1;
    code = `${base}_${suffix}`;
  }
  if (!ARCHETYPE_CODE_PATTERN.test(code)) {
    throw new Error(`Generated defence-only code is not a valid archetype_code: ${code}`);
  }
  taken.add(code);
  return { code, base, collisionSuffix: suffix > 1 ? suffix : null };
}

function requireInteger(value, label, { min, max }) {
  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new Error(`${label} is not an integer: ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} is out of range ${min}..${max}: ${parsed}`);
  }
  return parsed;
}

// ─── plan construction ───────────────────────────────────────────────────────

class Blockers {
  constructor() { this.entries = []; }

  add(anomalyId, message, evidence) {
    this.entries.push({ anomalyId, message, evidence: evidence ?? null });
  }

  get blocked() { return this.entries.length > 0; }
}

function buildUnits(sources, decisions, blockers) {
  const unitIdResolution = resolutionOf(decisions, "UNIT_ID_FORMAT_TIE_ADVANCED_X1");
  const units = [];
  const dropped = [];
  const renames = [];
  const seenUnitIds = new Set();
  const seenExternalIds = new Set();

  for (const row of sources.characterDefinitions) {
    const unitId = row.Character_ID;
    if (unitId === "") throw new Error(`Character_Definitions row ${row.sourceRow} has a blank Character_ID`);
    if (seenUnitIds.has(unitId)) {
      throw new Error(`Character_Definitions row ${row.sourceRow} repeats Character_ID ${unitId}`);
    }
    seenUnitIds.add(unitId);

    if (!UNIT_TYPES.has(row.Unit_Type)) {
      throw new Error(`Character_Definitions row ${row.sourceRow} has an unknown Unit_Type: ${row.Unit_Type}`);
    }
    const externalId = row.External_ID === "" ? null : row.External_ID;
    if (externalId !== null) {
      if (seenExternalIds.has(externalId)) {
        throw new Error(`Character_Definitions row ${row.sourceRow} repeats External_ID ${externalId}`);
      }
      seenExternalIds.add(externalId);
    }

    // ARCH-105 constrains unit_id. A source identifier the schema rejects is a
    // conflict between two accepted authorities, so ARCH-106 stops unless an
    // explicit decision says which authority gives way. It never renames a
    // public identifier on its own.
    let canonicalUnitId = unitId;
    if (!UNIT_ID_PATTERN.test(unitId)) {
      if (unitIdResolution === "RENAME_UNIT_ID_TO_UPPERCASE") {
        canonicalUnitId = unitId.toUpperCase();
        if (!UNIT_ID_PATTERN.test(canonicalUnitId)) {
          throw new Error(`Uppercasing ${JSON.stringify(unitId)} still fails units_unit_id_format`);
        }
        renames.push({ from: unitId, to: canonicalUnitId, sourceRow: row.sourceRow });
      } else if (unitIdResolution !== "AMEND_ARCH_105_UNIT_ID_FORMAT") {
        blockers.add(
          "UNIT_ID_FORMAT_TIE_ADVANCED_X1",
          `Character_ID ${JSON.stringify(unitId)} (Character_Definitions row ${row.sourceRow}) fails the ARCH-105 units_unit_id_format constraint`,
          { characterId: unitId, sourceRow: row.sourceRow }
        );
        dropped.push({
          source: "Character_Definitions",
          sourceRow: row.sourceRow,
          identifier: unitId,
          reason: "BLOCKED_UNIT_ID_FORMAT"
        });
        continue;
      }
    }

    units.push({
      unit_id: canonicalUnitId,
      display_name: row.Character_Name,
      external_id: externalId,
      unit_type: row.Unit_Type,
      sourceRow: row.sourceRow,
      sourceCharacterId: unitId
    });
  }

  return { units, dropped, renames };
}

// An attack archetype is FLEET when it fields any ship. The composition-derived
// answer is cross-checked against the modes the counter is actually used in, so
// a mislabelled unit type cannot quietly produce an impossible matchup.
function attackBattleType(counterId, members, unitTypeById, counterModes) {
  const types = members.map((member) => unitTypeById.get(member.Character_ID));
  const hasShip = types.some((type) => type === "SHIP" || type === "CAPITAL_SHIP");
  const hasCharacter = types.some((type) => type === "CHARACTER");
  if (hasShip && hasCharacter) {
    throw new Error(`Counter_ID ${counterId} mixes ship and character members; battle type is ambiguous`);
  }
  if (!hasShip && !hasCharacter) {
    throw new Error(`Counter_ID ${counterId} has no usable composition members; battle type cannot be derived`);
  }
  const fromComposition = hasShip ? "FLEET" : "SQUAD";

  if (counterModes.size > 0) {
    const modes = [...counterModes];
    const fromModes = modes.every((mode) => mode === "FLEET")
      ? "FLEET"
      : modes.every((mode) => mode !== "FLEET") ? "SQUAD" : "MIXED";
    if (fromModes !== fromComposition) {
      throw new Error(
        `Counter_ID ${counterId} battle type disagrees: composition says ${fromComposition}, Counters modes say ${fromModes} (${modes.sort().join(", ")})`
      );
    }
  }

  return fromComposition;
}

function buildArchetypes(sources, decisions, blockers) {
  const unitTypeById = new Map(sources.characterDefinitions.map((row) => [row.Character_ID, row.Unit_Type]));
  const authoredNameById = new Map();
  for (const row of sources.counterDefinitions) {
    if (row.Counter_ID === "") throw new Error(`Counter_Definitions row ${row.sourceRow} has a blank Counter_ID`);
    if (authoredNameById.has(row.Counter_ID)) {
      throw new Error(`Counter_Definitions row ${row.sourceRow} repeats Counter_ID ${row.Counter_ID}`);
    }
    authoredNameById.set(row.Counter_ID, row["Counter Team"]);
  }

  const membersByCounterId = new Map();
  for (const row of sources.counterComposition) {
    if (row.Counter_ID === "" || row.Character_ID === "") {
      throw new Error(`Counter_Composition row ${row.sourceRow} has a blank identifier`);
    }
    if (!MEMBER_ROLES.has(row.Role)) {
      throw new Error(`Counter_Composition row ${row.sourceRow} has an unknown Role: ${row.Role}`);
    }
    if (!unitTypeById.has(row.Character_ID)) {
      throw new Error(`Counter_Composition row ${row.sourceRow} references unknown Character_ID ${row.Character_ID}`);
    }
    if (!membersByCounterId.has(row.Counter_ID)) membersByCounterId.set(row.Counter_ID, []);
    const existing = membersByCounterId.get(row.Counter_ID);
    if (existing.some((member) => member.Character_ID === row.Character_ID)) {
      throw new Error(`Counter_Composition row ${row.sourceRow} repeats ${row.Counter_ID} / ${row.Character_ID}`);
    }
    existing.push(row);
  }

  const counterModes = new Map();
  const defenceModes = new Map();
  for (const row of sources.counters) {
    if (row.Counter_ID === "" || row["Defence Team"] === "" || row.Mode === "") {
      throw new Error(`Counters row ${row.sourceRow} has a blank required identifier`);
    }
    const mode = canonicalMode(row.Mode);
    if (!counterModes.has(row.Counter_ID)) counterModes.set(row.Counter_ID, new Set());
    counterModes.get(row.Counter_ID).add(mode);
    if (!defenceModes.has(row["Defence Team"])) defenceModes.set(row["Defence Team"], new Set());
    defenceModes.get(row["Defence Team"]).add(mode);
  }
  for (const counterId of counterModes.keys()) {
    if (!authoredNameById.has(counterId)) {
      throw new Error(`Counters references Counter_ID ${counterId}, which has no Counter_Definitions row`);
    }
  }

  const synthesizedResolution = resolutionOf(decisions, "SYNTHESIZED_COUNTER_DEFINITION_MAZ_KANATA");
  const archetypes = [];
  const byCode = new Map();
  const takenCodes = new Set();
  const attackIds = [...new Set([...authoredNameById.keys(), ...membersByCounterId.keys()])].sort();

  for (const counterId of attackIds) {
    if (!ARCHETYPE_CODE_PATTERN.test(counterId)) {
      throw new Error(`Counter_ID ${JSON.stringify(counterId)} fails the ARCH-105 archetype_code format`);
    }
    const authored = authoredNameById.has(counterId);
    if (!authored && synthesizedResolution !== "PRESERVE_LEGACY_SYNTHESIZED_DEFINITION") {
      blockers.add(
        "SYNTHESIZED_COUNTER_DEFINITION_MAZ_KANATA",
        `Counter_ID ${counterId} has composition but no authored definition, and no explicit decision covers it`,
        { counterId }
      );
      continue;
    }

    const members = membersByCounterId.get(counterId) ?? [];
    const archetype = {
      archetype_code: counterId,
      // The legacy Apps Script publishes the Counter_ID itself when no
      // definition row exists. Reproducing that keeps the payload identical
      // without inventing a display name.
      display_name: authored ? authoredNameById.get(counterId) : counterId,
      battle_type: attackBattleType(counterId, members, unitTypeById, counterModes.get(counterId) ?? new Set()),
      identity_reason: "LEGACY_MIGRATION",
      identity_reason_detail: authored
        ? null
        : "Legacy Apps Script synthesized this counter definition from Counter_Composition; no Counter_Definitions row existed at the ARCH-103 capture.",
      created_by: authored ? "HUMAN" : "AUTOMATION",
      definitionSource: authored ? "AUTHORED" : "LEGACY_SYNTHESIZED",
      usedAsAttack: true,
      usedAsDefence: false,
      members
    };
    if (archetype.display_name === "") {
      throw new Error(`Counter_ID ${counterId} has a blank display name`);
    }
    archetypes.push(archetype);
    byCode.set(counterId, archetype);
    takenCodes.add(counterId);
  }

  // Defence identity resolution. Exact and unique, or defence-only. Never fuzzy.
  const byDisplayName = new Map();
  for (const archetype of archetypes) {
    if (!byDisplayName.has(archetype.display_name)) byDisplayName.set(archetype.display_name, []);
    byDisplayName.get(archetype.display_name).push(archetype);
  }

  const declaredDefenceModes = new Map();
  for (const row of sources.defenceTeams) {
    if (row.Defence_Team === "" || row.Mode === "") {
      throw new Error(`Defence_Teams row ${row.sourceRow} has a blank required identifier`);
    }
    const key = `${canonicalMode(row.Mode)}\u0000${row.Defence_Team}`;
    if (declaredDefenceModes.has(key)) {
      throw new Error(`Defence_Teams row ${row.sourceRow} repeats ${row.Mode} / ${row.Defence_Team}`);
    }
    declaredDefenceModes.set(key, row);
  }

  const defenceNames = [...new Set([
    ...sources.counters.map((row) => row["Defence Team"]),
    ...sources.defenceTeams.map((row) => row.Defence_Team)
  ])].sort();

  // A defence display name mirrors when the catalogue counters it with the
  // identically named attack identity. Reusing one archetype for both roles is
  // what ARCH-105 matchups_distinct_archetypes forbids, so a SPLIT decision
  // sends these names down the defence-only path instead.
  const mirrorDefenceNames = new Set(
    sources.counters
      .filter((row) => identity_authoredNameFor(authoredNameById, row.Counter_ID) === row["Defence Team"])
      .map((row) => row["Defence Team"])
  );
  const splitMirrors = resolutionOf(decisions, "MIRROR_MATCHUP_SELF_REFERENCE") === "SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS";

  const defenceResolutions = [];
  const defenceArchetypeByName = new Map();
  const generatedIdentifiers = [];

  for (const name of defenceNames) {
    const observed = defenceModes.get(name) ?? new Set();
    const declared = sources.defenceTeams
      .filter((row) => row.Defence_Team === name)
      .map((row) => canonicalMode(row.Mode));

    const matches = splitMirrors && mirrorDefenceNames.has(name) ? [] : (byDisplayName.get(name) ?? []);
    if (matches.length > 1) {
      blockers.add(
        "AMBIGUOUS_DEFENCE_IDENTITY",
        `Defence display name ${JSON.stringify(name)} matches ${matches.length} archetype display names; ARCH-106 will not guess`,
        { displayName: name, candidates: matches.map((match) => match.archetype_code) }
      );
      continue;
    }

    let archetype;
    let outcome;
    if (matches.length === 1) {
      archetype = matches[0];
      outcome = "REUSED_EXACT_ATTACK_IDENTITY";
      const expected = battleTypeFromModes(name, observed, declared);
      if (expected !== null && expected !== archetype.battle_type) {
        throw new Error(
          `Defence ${JSON.stringify(name)} plays as ${expected} but its exact attack identity ${archetype.archetype_code} is ${archetype.battle_type}`
        );
      }
    } else {
      const battleType = battleTypeFromModes(name, observed, declared);
      if (battleType === null) {
        blockers.add(
          "DEFENCE_BATTLE_TYPE_UNDETERMINED",
          `Defence display name ${JSON.stringify(name)} appears in no mode that establishes a battle type`,
          { displayName: name }
        );
        continue;
      }
      const allocated = allocateDefenceOnlyCode(name, takenCodes);
      archetype = {
        archetype_code: allocated.code,
        display_name: name,
        battle_type: battleType,
        identity_reason: "LEGACY_MIGRATION",
        identity_reason_detail: null,
        created_by: "HUMAN",
        definitionSource: "DEFENCE_ONLY",
        usedAsAttack: false,
        usedAsDefence: true,
        members: []
      };
      archetypes.push(archetype);
      byCode.set(allocated.code, archetype);
      outcome = mirrorDefenceNames.has(name) && splitMirrors
        ? "DEFENCE_ONLY_ARCHETYPE_SPLIT_FROM_MIRROR"
        : "DEFENCE_ONLY_ARCHETYPE";
      generatedIdentifiers.push({
        kind: "defence_only_archetype_code",
        displayName: name,
        generated: allocated.code,
        rule: "DEF_ + display name uppercased, non [A-Z0-9] replaced by _, runs collapsed, edges trimmed",
        collisionSuffix: allocated.collisionSuffix
      });
    }

    archetype.usedAsDefence = true;
    defenceArchetypeByName.set(name, archetype);
    defenceResolutions.push({
      displayName: name,
      archetypeCode: archetype.archetype_code,
      outcome,
      battleType: archetype.battle_type,
      observedModes: [...observed].sort(),
      declaredModes: [...new Set(declared)].sort()
    });
  }

  archetypes.sort((left, right) => (left.archetype_code < right.archetype_code ? -1 : 1));

  return {
    archetypes,
    byCode,
    defenceArchetypeByName,
    defenceResolutions,
    generatedIdentifiers,
    declaredDefenceModes,
    defenceModes,
    authoredNameById,
    membersByCounterId
  };
}

function identity_authoredNameFor(authoredNameById, counterId) {
  return authoredNameById.has(counterId) ? authoredNameById.get(counterId) : counterId;
}

function battleTypeFromModes(name, observedModes, declaredModes) {
  const observed = [...observedModes];
  if (observed.length > 0) {
    if (observed.every((mode) => mode === "FLEET")) return "FLEET";
    if (observed.every((mode) => mode !== "FLEET")) return "SQUAD";
    throw new Error(`Defence ${JSON.stringify(name)} spans fleet and squad modes; battle type is ambiguous`);
  }
  const declared = declaredModes.filter((mode) => mode !== "ANY");
  if (declared.length > 0) {
    if (declared.every((mode) => mode === "FLEET")) return "FLEET";
    if (declared.every((mode) => mode !== "FLEET")) return "SQUAD";
    throw new Error(`Defence ${JSON.stringify(name)} declares both fleet and squad modes`);
  }
  return null;
}

function buildProfiles(identity, unitIdBySourceId) {
  const profiles = [];

  for (const archetype of identity.archetypes) {
    if (archetype.usedAsAttack && archetype.members.length > 0) {
      // Squad cores are currently shared across 3v3 and 5v5, so they migrate
      // once as ANY. Fleet cores stay fleet-specific.
      const mode = archetype.battle_type === "FLEET" ? "FLEET" : "ANY";
      profiles.push({
        archetype_code: archetype.archetype_code,
        mode,
        usage_role: "ATTACK",
        flex_slots: 0,
        // Counter_Composition records a strategic core, not an exhaustive
        // lineup, so no migrated profile claims completeness.
        members_complete: false,
        members: archetype.members.map((member, index) => ({
          unit_id: unitIdBySourceId.get(member.Character_ID) ?? member.Character_ID,
          member_role: member.Role,
          is_leader: false,
          sort_order: index,
          sourceRow: member.sourceRow
        }))
      });
    }

    if (!archetype.usedAsDefence) continue;

    const observed = identity.defenceModes.get(archetype.display_name) ?? new Set();
    const declared = [...new Set(
      [...identity.declaredDefenceModes.values()]
        .filter((row) => row.Defence_Team === archetype.display_name)
        .map((row) => canonicalMode(row.Mode))
    )];
    // Only modes the identity actually appears in. Defence_Composition is
    // absent, so these profiles carry no members and say so.
    const modes = observed.size > 0 ? [...observed].sort() : declared.sort();
    for (const mode of modes) {
      profiles.push({
        archetype_code: archetype.archetype_code,
        mode,
        usage_role: "DEFENCE",
        flex_slots: 0,
        members_complete: false,
        members: []
      });
    }
  }

  profiles.sort((left, right) => {
    const key = (profile) => `${profile.archetype_code}\u0000${profile.usage_role}\u0000${profile.mode}`;
    return key(left) < key(right) ? -1 : 1;
  });
  return profiles;
}

function buildMatchups(sources, identity, decisions, blockers) {
  const duplicateResolution = resolutionOf(decisions, "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA");
  const mirrorResolution = resolutionOf(decisions, "MIRROR_MATCHUP_SELF_REFERENCE");

  const groups = new Map();
  for (const row of sources.counters) {
    const mode = canonicalMode(row.Mode);
    const defence = identity.defenceArchetypeByName.get(row["Defence Team"]);
    const counter = identity.byCode.get(row.Counter_ID);
    if (!defence || !counter) continue; // an earlier blocker already covers this row
    const key = `${mode}\u0000${defence.archetype_code}\u0000${counter.archetype_code}`;
    if (!groups.has(key)) groups.set(key, { mode, defence, counter, rows: [] });
    groups.get(key).rows.push(row);
  }

  const matchups = [];
  const dropped = [];
  const collapsed = [];
  const mirrors = [];

  for (const [, group] of groups) {
    const values = group.rows.map((row) => ({
      sourceRow: row.sourceRow,
      tier: row.Tier,
      banner_score: requireInteger(row["Banner Score"], `Counters row ${row.sourceRow} Banner Score`, { min: 0, max: 100 }),
      undersize: requireInteger(row.Undersize, `Counters row ${row.sourceRow} Undersize`, { min: 0, max: 5 }),
      notes: row.Notes
    }));
    for (const value of values) {
      if (!TIERS.has(value.tier)) {
        throw new Error(`Counters row ${value.sourceRow} has an unknown Tier: ${JSON.stringify(value.tier)}`);
      }
    }

    // gac.matchups forbids a self-referential relationship. Mirror matches are
    // real play, so this is a schema/baseline conflict, never a row to discard.
    if (group.defence.archetype_code === group.counter.archetype_code) {
      mirrors.push({
        mode: group.mode,
        archetypeCode: group.defence.archetype_code,
        displayName: group.defence.display_name,
        sourceRows: values.map((value) => value.sourceRow)
      });
      if (mirrorResolution === null) {
        blockers.add(
          "MIRROR_MATCHUP_SELF_REFERENCE",
          `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code} resolves both roles to archetype ${group.defence.archetype_code}, which ARCH-105 matchups_distinct_archetypes forbids`,
          { mode: group.mode, archetypeCode: group.defence.archetype_code, sourceRows: values.map((value) => value.sourceRow) }
        );
        for (const value of values) {
          dropped.push({
            source: "Counters",
            sourceRow: value.sourceRow,
            identifier: `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code}`,
            reason: "BLOCKED_MIRROR_MATCHUP"
          });
        }
        continue;
      }
    }

    let chosen = values[0];
    if (values.length > 1) {
      const meaningful = values.map(({ sourceRow, ...rest }) => rest);
      const identical = meaningful.every((entry) => isDeepStrictEqual(entry, meaningful[0]));
      const differingFields = ["tier", "banner_score", "undersize", "notes"]
        .filter((field) => new Set(values.map((value) => value[field])).size > 1);

      if (identical && duplicateResolution === "IDENTICAL_DUPLICATE_COLLAPSED") {
        collapsed.push({
          mode: group.mode,
          defenceDisplayName: group.defence.display_name,
          counterArchetypeCode: group.counter.archetype_code,
          sourceRows: values.map((value) => value.sourceRow),
          resolution: "IDENTICAL_DUPLICATE_COLLAPSED"
        });
      } else if (!identical && duplicateResolution === "COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE") {
        const nonBlank = values.filter((value) => value.notes !== "");
        const otherFields = ["tier", "banner_score", "undersize"]
          .filter((field) => new Set(values.map((value) => value[field])).size > 1);
        if (otherFields.length > 0 || nonBlank.length > 1) {
          blockers.add(
            "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA",
            `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code} duplicates differ beyond a single non-blank note (${[...otherFields, ...(nonBlank.length > 1 ? ["notes"] : [])].join(", ")})`,
            { sourceRows: values.map((value) => value.sourceRow) }
          );
          continue;
        }
        chosen = nonBlank[0] ?? values[0];
        collapsed.push({
          mode: group.mode,
          defenceDisplayName: group.defence.display_name,
          counterArchetypeCode: group.counter.archetype_code,
          sourceRows: values.map((value) => value.sourceRow),
          resolution: "COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE",
          survivingSourceRow: chosen.sourceRow
        });
      } else {
        blockers.add(
          "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA",
          identical
            ? `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code} appears ${values.length} times with identical values and no explicit collapse decision`
            : `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code} appears ${values.length} times and the rows differ in ${differingFields.join(", ")}; ARCH-106 will not choose a survivor`,
          { sourceRows: values.map((value) => value.sourceRow), differingFields }
        );
        for (const value of values) {
          dropped.push({
            source: "Counters",
            sourceRow: value.sourceRow,
            identifier: `${group.mode} | ${group.defence.display_name} | ${group.counter.archetype_code}`,
            reason: "BLOCKED_DUPLICATE_COMPOSITE"
          });
        }
        continue;
      }
    }

    matchups.push({
      mode: group.mode,
      defence_archetype_code: group.defence.archetype_code,
      counter_archetype_code: group.counter.archetype_code,
      tier: chosen.tier,
      banner_score: chosen.banner_score,
      undersize: chosen.undersize,
      notes: chosen.notes,
      sourceRows: values.map((value) => value.sourceRow),
      sortKey: Math.min(...values.map((value) => value.sourceRow))
    });
  }

  // Source row order is the published order of each defence team's counter list.
  matchups.sort((left, right) => left.sortKey - right.sortKey);
  return { matchups, dropped, collapsed, mirrors };
}

function buildDefenceValues(sources, identity, blockers) {
  const values = [];
  for (const row of sources.defenceTeams) {
    const archetype = identity.defenceArchetypeByName.get(row.Defence_Team);
    if (!archetype) continue; // an earlier blocker already covers this row
    const threat = row.Threat.trim().toUpperCase();
    if (!THREATS.has(threat)) {
      throw new Error(`Defence_Teams row ${row.sourceRow} has an unknown Threat: ${JSON.stringify(row.Threat)}`);
    }
    values.push({
      archetype_code: archetype.archetype_code,
      mode: canonicalMode(row.Mode),
      threat,
      notes: row.Notes,
      sourceRow: row.sourceRow,
      sourceMode: row.Mode,
      sourceThreat: row.Threat
    });
  }
  values.sort((left, right) => {
    const key = (value) => `${value.archetype_code}\u0000${value.mode}`;
    return key(left) < key(right) ? -1 : 1;
  });
  return values;
}

function buildBoardConfig(sources) {
  const rows = [];
  const orderByLeagueMode = new Map();
  for (const row of sources.boardConfig) {
    if (!LEAGUES.has(row.League)) {
      throw new Error(`GAC_Board_Config row ${row.sourceRow} has an unknown League: ${row.League}`);
    }
    if (!TERRITORIES.has(row.Territory)) {
      throw new Error(`GAC_Board_Config row ${row.sourceRow} has an unknown Territory: ${row.Territory}`);
    }
    const mode = canonicalMode(row.Mode);
    if (mode !== "3V3" && mode !== "5V5") {
      throw new Error(`GAC_Board_Config row ${row.sourceRow} has an unsupported Mode: ${row.Mode}`);
    }
    if (row.Territory_Type !== "SQUAD" && row.Territory_Type !== "FLEET") {
      throw new Error(`GAC_Board_Config row ${row.sourceRow} has an unknown Territory_Type: ${row.Territory_Type}`);
    }
    const key = `${row.League}\u0000${mode}`;
    const displayOrder = orderByLeagueMode.get(key) ?? 0;
    orderByLeagueMode.set(key, displayOrder + 1);
    rows.push({
      league: row.League,
      mode,
      territory: row.Territory,
      territory_type: row.Territory_Type,
      team_count: requireInteger(row.Team_Count, `GAC_Board_Config row ${row.sourceRow} Team_Count`, { min: 0, max: 32767 }),
      display_order: displayOrder,
      sourceRow: row.sourceRow
    });
  }
  return rows;
}

function buildScoringRules(sources) {
  const rows = [];
  const seen = new Set();
  for (const row of sources.scoring) {
    if (!ARCHETYPE_CODE_PATTERN.test(row.Rule_ID)) {
      throw new Error(`GAC_Scoring row ${row.sourceRow} has an invalid Rule_ID: ${JSON.stringify(row.Rule_ID)}`);
    }
    if (!["ANY", "SQUAD", "FLEET"].includes(row.Battle_Type)) {
      throw new Error(`GAC_Scoring row ${row.sourceRow} has an unknown Battle_Type: ${row.Battle_Type}`);
    }
    const mode = canonicalMode(row.Mode);
    const key = `${row.Rule_ID}\u0000${row.Battle_Type}\u0000${mode}`;
    if (seen.has(key)) {
      throw new Error(`GAC_Scoring row ${row.sourceRow} repeats ${row.Rule_ID} / ${row.Battle_Type} / ${row.Mode}`);
    }
    seen.add(key);
    rows.push({
      rule_id: row.Rule_ID,
      battle_type: row.Battle_Type,
      mode,
      value: requireInteger(row.Value, `GAC_Scoring row ${row.sourceRow} Value`, { min: -2147483648, max: 2147483647 }),
      notes: row.Notes,
      sourceRow: row.sourceRow,
      sourceMode: row.Mode
    });
  }
  return rows;
}

// ─── reconciliation ──────────────────────────────────────────────────────────

function buildReconciliation(sources, decisions, plan, identity, blockers, extras) {
  const attackArchetypes = plan.archetypes.filter((archetype) => archetype.usedAsAttack);
  const defenceOnly = identity.defenceResolutions
    .filter((entry) => entry.outcome.startsWith("DEFENCE_ONLY_ARCHETYPE"));
  const reused = identity.defenceResolutions
    .filter((entry) => entry.outcome === "REUSED_EXACT_ATTACK_IDENTITY");

  const requiredMembers = plan.profiles
    .filter((profile) => profile.usage_role === "ATTACK")
    .flatMap((profile) => profile.members.filter((member) => member.member_role === "REQUIRED"));
  const externalIdByUnit = new Map(plan.units.map((unit) => [unit.unit_id, unit.external_id]));
  const requiredWithoutExternalId = [...new Set(requiredMembers.map((member) => member.unit_id))]
    .filter((unitId) => !externalIdByUnit.get(unitId));

  const sourceCounterNotes = sources.counters.filter((row) => row.Notes !== "");
  const migratedMatchupNotes = plan.matchups.filter((matchup) => matchup.notes !== "");
  const withheldCounterRows = new Set(
    extras.dropped.filter((entry) => entry.source === "Counters").map((entry) => entry.sourceRow)
  );
  const notesWithheldByBlockers = sourceCounterNotes
    .filter((row) => withheldCounterRows.has(row.sourceRow)).length;

  return {
    package: "ARCH-106",
    schemaVersion: 1,
    baseline: {
      captureDirectory: sources.captureDirectory,
      captureTimestamp: sources.manifest.captureTimestamp,
      rawSha256: sources.manifest.appsScriptPayload.rawSha256,
      canonicalSha256: sources.manifest.appsScriptPayload.canonicalSha256
    },
    status: blockers.blocked ? "BLOCKED" : "READY",
    sourceRowCounts: sources.manifest.aggregateRowCounts.sheetDataRows,
    sourceRowCountsTotal: sources.manifest.aggregateRowCounts.sheetDataRowsTotal,
    canonicalEntityCounts: {
      units: plan.units.length,
      team_archetypes: plan.archetypes.length,
      team_archetypes_attack: attackArchetypes.length,
      team_archetypes_defence_only: defenceOnly.length,
      team_profiles: plan.profiles.length,
      team_profiles_attack: plan.profiles.filter((profile) => profile.usage_role === "ATTACK").length,
      team_profiles_defence: plan.profiles.filter((profile) => profile.usage_role === "DEFENCE").length,
      team_profile_members: plan.profiles.reduce((total, profile) => total + profile.members.length, 0),
      matchups: plan.matchups.length,
      matchup_catalogue_values: plan.matchups.length,
      defence_catalogue_values: plan.defenceValues.length,
      gac_board_config: plan.boardConfig.length,
      gac_scoring_rules: plan.scoringRules.length,
      authoring_changes: 1
    },
    mappings: {
      oneToOne: {
        "Character_Definitions -> gac.units": `${sources.characterDefinitions.length} -> ${plan.units.length}`,
        "Counter_Definitions -> gac.team_archetypes (attack)": `${sources.counterDefinitions.length} -> ${attackArchetypes.filter((archetype) => archetype.definitionSource === "AUTHORED").length}`,
        "Counter_Composition -> gac.team_profile_members": `${sources.counterComposition.length} -> ${plan.profiles.reduce((total, profile) => total + profile.members.length, 0)}`,
        "GAC_Board_Config -> gac.gac_board_config": `${sources.boardConfig.length} -> ${plan.boardConfig.length}`,
        "GAC_Scoring -> gac.gac_scoring_rules": `${sources.scoring.length} -> ${plan.scoringRules.length}`,
        "Defence_Teams -> gac.defence_catalogue_values": `${sources.defenceTeams.length} -> ${plan.defenceValues.length}`,
        "Counters -> gac.matchups + gac.matchup_catalogue_values": `${sources.counters.length} -> ${plan.matchups.length}`
      },
      manyToOne: extras.collapsed,
      synthesized: attackArchetypes
        .filter((archetype) => archetype.definitionSource === "LEGACY_SYNTHESIZED")
        .map((archetype) => ({
          archetypeCode: archetype.archetype_code,
          displayName: archetype.display_name,
          provenance: "LEGACY_APPS_SCRIPT_SYNTHESIZED",
          createdBy: archetype.created_by
        }))
    },
    defenceIdentities: {
      distinctDisplayNames: identity.defenceResolutions.length + blockers.entries.filter((entry) => entry.anomalyId === "AMBIGUOUS_DEFENCE_IDENTITY" || entry.anomalyId === "DEFENCE_BATTLE_TYPE_UNDETERMINED").length,
      reusedExactAttackIdentity: reused.length,
      defenceOnly: defenceOnly.length,
      defenceOnlyMappings: defenceOnly.map((entry) => ({
        displayName: entry.displayName,
        archetypeCode: entry.archetypeCode,
        battleType: entry.battleType,
        outcome: entry.outcome
      })),
      reusedMappings: reused.map((entry) => ({
        displayName: entry.displayName,
        archetypeCode: entry.archetypeCode
      }))
    },
    generatedIdentifiers: identity.generatedIdentifiers,
    unitIdRenames: extras.unitIdRenames,
    mirrorMatchups: extras.mirrors,
    notePreservation: {
      sourceCounterNotesNonBlank: sourceCounterNotes.length,
      migratedMatchupNotesNonBlank: migratedMatchupNotes.length,
      sourceDefenceTeamNotesNonBlank: sources.defenceTeams.filter((row) => row.Notes !== "").length,
      migratedDefenceNotesNonBlank: plan.defenceValues.filter((value) => value.notes !== "").length,
      sourceScoringNotesNonBlank: sources.scoring.filter((row) => row.Notes !== "").length,
      migratedScoringNotesNonBlank: plan.scoringRules.filter((rule) => rule.notes !== "").length,
      // A note may be withheld only because a blocker withheld its whole row.
      // Anything unaccounted for here would be a silently dropped note.
      notesWithheldByBlockers: notesWithheldByBlockers,
      notesDroppedSilently:
        sourceCounterNotes.length - migratedMatchupNotes.length - notesWithheldByBlockers
    },
    requiredMemberExternalIdCoverage: {
      distinctRequiredUnits: new Set(requiredMembers.map((member) => member.unit_id)).size,
      withoutExternalId: requiredWithoutExternalId.length,
      missing: requiredWithoutExternalId
    },
    modeNormalisations: [
      ...new Set(sources.defenceTeams.map((row) => `defenceTeams: source ${JSON.stringify(row.Mode)} -> canonical ${canonicalMode(row.Mode)} -> public ${JSON.stringify(publicMode("defenceTeams", decisions, canonicalMode(row.Mode)))}`))
    ].sort(),
    scoreMeanings: {
      sourceRows: sources.scoreMeanings.length,
      disposition: "RETIRED_AUTHORING_GUIDANCE",
      runtimeTableCreated: false,
      home: "docs/SCORING_REFERENCE.md"
    },
    defenceComposition: {
      sourceTabPresent: false,
      membersInvented: 0,
      defenceProfilesCreated: plan.profiles.filter((profile) => profile.usage_role === "DEFENCE").length,
      allDefenceProfilesIncomplete: plan.profiles
        .filter((profile) => profile.usage_role === "DEFENCE")
        .every((profile) => profile.members_complete === false && profile.members.length === 0)
    },
    droppedSourceRows: extras.dropped,
    assurances: {
      fuzzyMappingsUsed: false,
      semanticMappingsUsed: false,
      caseInsensitiveNameMatchingUsed: false,
      unresolvedRowsGuessed: 0,
      lastWriteWinsUsed: false
    },
    anomalies: decisions.anomalies.map((anomaly) => ({
      id: anomaly.id,
      status: anomaly.status,
      resolution: anomaly.resolution,
      affectedCount: anomaly.affectedCount ?? null
    })),
    blockers: blockers.entries
  };
}

// ─── public entry point ──────────────────────────────────────────────────────

function buildPlan(sources, decisions) {
  const blockers = new Blockers();

  const unitResult = buildUnits(sources, decisions, blockers);
  const identity = buildArchetypes(sources, decisions, blockers);
  const unitIdBySourceId = new Map(unitResult.units.map((unit) => [unit.sourceCharacterId, unit.unit_id]));
  const profiles = buildProfiles(identity, unitIdBySourceId);
  const matchupResult = buildMatchups(sources, identity, decisions, blockers);
  const defenceValues = buildDefenceValues(sources, identity, blockers);
  const boardConfig = buildBoardConfig(sources);
  const scoringRules = buildScoringRules(sources);

  // Every attack profile member must reference a unit that actually loaded.
  const loadedUnits = new Set(unitResult.units.map((unit) => unit.unit_id));
  for (const profile of profiles) {
    for (const member of profile.members) {
      if (!loadedUnits.has(member.unit_id)) {
        blockers.add(
          "UNIT_ID_FORMAT_TIE_ADVANCED_X1",
          `Profile ${profile.archetype_code} / ${profile.mode} / ${profile.usage_role} needs unit ${member.unit_id}, which is blocked`,
          { archetypeCode: profile.archetype_code, unitId: member.unit_id }
        );
      }
    }
  }

  const provenance = decisions.provenance;
  const plan = {
    units: unitResult.units,
    archetypes: identity.archetypes,
    profiles,
    matchups: matchupResult.matchups,
    defenceValues,
    boardConfig,
    scoringRules,
    authoringChange: {
      change_id: provenance.changeId,
      author: provenance.author,
      authored_at: provenance.authoredAt,
      entity_type: provenance.entityType,
      operation: provenance.operation,
      authority: provenance.authority,
      reason: provenance.reason,
      status: "APPLIED"
    }
  };

  const reconciliation = buildReconciliation(sources, decisions, plan, identity, blockers, {
    collapsed: matchupResult.collapsed,
    mirrors: matchupResult.mirrors,
    unitIdRenames: unitResult.renames,
    dropped: [...unitResult.dropped, ...matchupResult.dropped].sort((left, right) => left.sourceRow - right.sourceRow)
  });

  plan.authoringChange.structured_values = {
    package: "ARCH-106",
    baseline: reconciliation.baseline,
    canonicalEntityCounts: reconciliation.canonicalEntityCounts,
    sourceRowCounts: reconciliation.sourceRowCounts,
    decisions: reconciliation.anomalies
  };

  return { plan, identity, reconciliation, blockers };
}

function assertLoadable(reconciliation) {
  if (reconciliation.blockers.length === 0) return;
  const lines = reconciliation.blockers.map((entry) => `  - [${entry.anomalyId}] ${entry.message}`);
  throw new Error(
    `ARCH-106 load refused: ${reconciliation.blockers.length} unresolved blocker(s) require an owner decision in data/migration/arch-106-decisions.json.\n${lines.join("\n")}`
  );
}

module.exports = {
  ARCHETYPE_CODE_PATTERN,
  DEFAULT_CAPTURE_ROOT,
  DEFAULT_DECISIONS_PATH,
  SOURCE_MODE_TO_CANONICAL,
  UNIT_ID_PATTERN,
  allocateDefenceOnlyCode,
  assertLoadable,
  buildPlan,
  canonicalMode,
  defenceOnlyCodeBase,
  findAnomaly,
  publicMode,
  readDecisions,
  readSources,
  resolutionOf
};
