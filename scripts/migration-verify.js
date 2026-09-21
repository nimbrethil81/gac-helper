#!/usr/bin/env node
"use strict";

// ARCH-106 compatibility verification.
//
// Reads the loaded canonical state back out of a database, projects the current
// seven-key catalogue contract from it, and compares that projection with the
// committed ARCH-103 golden payload.
//
// This proves the canonical database carries enough information to reconstruct
// today's catalogue semantics. It is migration verification only: ARCH-108 owns
// the production payload generator, payload schema versioning, static catalogue
// files and the publication protocol, and none of those appear here.
//
// Approved reconciliation is applied to the golden payload as an explicit,
// machine-readable delta and the result must then match exactly. No domain is
// excluded from the comparison.

const { isDeepStrictEqual } = require("node:util");

const { canonicalJson } = require("./baseline-lib.js");
const {
  DEFAULT_CAPTURE_ROOT,
  DEFAULT_DECISIONS_PATH,
  buildPlan,
  publicMode,
  readDecisions,
  readSources
} = require("./migration-lib.js");
const { applySchema, createDisposableDatabase, loadPlan } = require("./migration-load.js");

function sortScoring(rows) {
  return [...rows].sort((left, right) => {
    const key = (row) => `${row.ruleId}\u0000${row.battleType}\u0000${row.mode}`;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });
}

// ─── projection ──────────────────────────────────────────────────────────────

async function projectPayload(database, decisions) {
  // The Apps Script always emits these two squad mode keys, even when empty.
  const counters = { "5v5": {}, "3v3": {} };
  const matchupRows = (await database.query(`
    select matchup.mode,
           defence.display_name as defence_name,
           counter.archetype_code as counter_id,
           counter.display_name as counter_name,
           value.tier, value.banner_score, value.undersize, value.notes
    from gac.matchups matchup
    join gac.team_archetypes defence on defence.archetype_id = matchup.defence_archetype_id
    join gac.team_archetypes counter on counter.archetype_id = matchup.counter_archetype_id
    join gac.matchup_catalogue_values value on value.matchup_id = matchup.matchup_id
    where matchup.status = 'ACTIVE'
      and defence.status = 'ACTIVE'
      and counter.status = 'ACTIVE'
    order by matchup.matchup_id
  `)).rows;
  for (const row of matchupRows) {
    const mode = publicMode("counters", decisions, row.mode);
    if (!counters[mode]) counters[mode] = {};
    if (!counters[mode][row.defence_name]) counters[mode][row.defence_name] = [];
    counters[mode][row.defence_name].push({
      counterId: row.counter_id,
      counter: row.counter_name,
      tier: row.tier,
      bannerScore: Number(row.banner_score),
      undersize: Number(row.undersize),
      notes: row.notes
    });
  }

  // An archetype with an ATTACK profile is a published counter identity.
  const counterDefinitions = {};
  const attackProfiles = (await database.query(`
    select archetype.archetype_code, archetype.display_name, profile.profile_id
    from gac.team_profiles profile
    join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
    where profile.usage_role = 'ATTACK'
      and profile.status = 'ACTIVE'
      and archetype.status = 'ACTIVE'
    order by archetype.archetype_code
  `)).rows;
  const attackMembers = (await database.query(`
    select profile_id, unit_id, member_role
    from gac.team_profile_members
    where status = 'ACTIVE'
    order by profile_id, sort_order
  `)).rows;
  const membersByProfile = new Map();
  for (const member of attackMembers) {
    if (!membersByProfile.has(member.profile_id)) membersByProfile.set(member.profile_id, []);
    membersByProfile.get(member.profile_id).push(member);
  }
  for (const profile of attackProfiles) {
    const members = membersByProfile.get(profile.profile_id) ?? [];
    counterDefinitions[profile.archetype_code] = {
      name: profile.display_name,
      required: members.filter((member) => member.member_role === "REQUIRED").map((member) => member.unit_id),
      recommended: members.filter((member) => member.member_role === "RECOMMENDED").map((member) => member.unit_id)
    };
  }

  const characterDefinitions = {};
  for (const unit of (await database.query("select unit_id, display_name, unit_type, external_id from gac.units where active order by unit_id")).rows) {
    characterDefinitions[unit.unit_id] = {
      name: unit.display_name,
      unitType: unit.unit_type,
      externalId: unit.external_id ?? ""
    };
  }

  const boardConfig = {};
  for (const row of (await database.query("select league, mode, territory, territory_type, team_count, display_order from gac.gac_board_config order by league, mode, display_order")).rows) {
    const mode = publicMode("counters", decisions, row.mode);
    if (!boardConfig[row.league]) boardConfig[row.league] = {};
    if (!boardConfig[row.league][mode]) boardConfig[row.league][mode] = [];
    boardConfig[row.league][mode].push({
      territory: row.territory,
      type: row.territory_type,
      teamCount: Number(row.team_count)
    });
  }

  const scoring = (await database.query("select rule_id, battle_type, mode, value, notes from gac.gac_scoring_rules order by rule_id, battle_type, mode")).rows
    .map((row) => ({
      ruleId: row.rule_id,
      battleType: row.battle_type,
      mode: publicMode("scoring", decisions, row.mode),
      value: Number(row.value),
      notes: row.notes
    }));

  const defenceTeams = {};
  for (const row of (await database.query(`
    select archetype.display_name, value.mode, value.threat, value.notes
    from gac.defence_catalogue_values value
    join gac.team_archetypes archetype on archetype.archetype_id = value.archetype_id
    where value.status = 'ACTIVE' and archetype.status = 'ACTIVE'
    order by value.mode, archetype.display_name
  `)).rows) {
    const mode = publicMode("defenceTeams", decisions, row.mode);
    if (!defenceTeams[mode]) defenceTeams[mode] = {};
    defenceTeams[mode][row.display_name] = { threat: row.threat, notes: row.notes };
  }

  // Defence membership was never authored, so this domain stays empty rather
  // than borrowing attack composition.
  const defenceCompositions = {};
  for (const row of (await database.query(`
    select archetype.display_name, profile.mode, member.unit_id
    from gac.team_profile_members member
    join gac.team_profiles profile on profile.profile_id = member.profile_id
    join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
    where profile.usage_role = 'DEFENCE'
      and member.status = 'ACTIVE'
      and profile.status = 'ACTIVE'
      and archetype.status = 'ACTIVE'
    order by profile.profile_id, member.sort_order
  `)).rows) {
    const mode = publicMode("defenceTeams", decisions, row.mode);
    if (!defenceCompositions[mode]) defenceCompositions[mode] = {};
    if (!defenceCompositions[mode][row.display_name]) defenceCompositions[mode][row.display_name] = [];
    defenceCompositions[mode][row.display_name].push(row.unit_id);
  }

  return { counters, counterDefinitions, characterDefinitions, boardConfig, scoring, defenceTeams, defenceCompositions };
}

// ─── expected deltas ─────────────────────────────────────────────────────────

// Apply every approved reconciliation outcome to the golden payload, one
// explicit delta at a time. Whatever remains must match exactly.
function applyExpectedDeltas(goldenPayload, reconciliation) {
  const adjusted = JSON.parse(JSON.stringify(goldenPayload));
  const deltas = [];

  for (const collapse of reconciliation.mappings.manyToOne) {
    const mode = collapse.mode === "3V3" ? "3v3" : collapse.mode === "5V5" ? "5v5" : collapse.mode;
    const entries = adjusted.counters?.[mode]?.[collapse.defenceDisplayName];
    if (!Array.isArray(entries)) {
      throw new Error(`Collapsed matchup is absent from the golden payload: ${mode} / ${collapse.defenceDisplayName}`);
    }
    const matching = entries.filter((entry) => entry.counterId === collapse.counterArchetypeCode);
    if (matching.length !== collapse.sourceRows.length) {
      throw new Error(
        `Golden payload holds ${matching.length} ${collapse.counterArchetypeCode} entries for ${mode} / ${collapse.defenceDisplayName}, expected ${collapse.sourceRows.length}`
      );
    }
    let kept = false;
    adjusted.counters[mode][collapse.defenceDisplayName] = entries.filter((entry) => {
      if (entry.counterId !== collapse.counterArchetypeCode) return true;
      if (kept) return false;
      kept = true;
      return true;
    });
    deltas.push({
      id: "COLLAPSED_DUPLICATE_MATCHUP",
      decision: collapse.resolution,
      domain: "counters",
      mode,
      defenceDisplayName: collapse.defenceDisplayName,
      counterId: collapse.counterArchetypeCode,
      goldenEntries: matching.length,
      canonicalEntries: 1,
      sourceRows: collapse.sourceRows
    });
  }

  for (const rename of reconciliation.unitIdRenames) {
    if (!(rename.from in adjusted.characterDefinitions)) {
      throw new Error(`Renamed unit is absent from the golden payload: ${rename.from}`);
    }
    adjusted.characterDefinitions[rename.to] = adjusted.characterDefinitions[rename.from];
    delete adjusted.characterDefinitions[rename.from];
    let references = 0;
    for (const definition of Object.values(adjusted.counterDefinitions)) {
      for (const list of ["required", "recommended"]) {
        definition[list] = definition[list].map((unitId) => {
          if (unitId !== rename.from) return unitId;
          references += 1;
          return rename.to;
        });
      }
    }
    deltas.push({
      id: "RENAMED_UNIT_ID",
      decision: "RENAME_UNIT_ID_TO_UPPERCASE",
      domain: "characterDefinitions",
      from: rename.from,
      to: rename.to,
      compositionReferencesRewritten: references,
      warning: "This is a public catalogue contract change and needs a documented client migration."
    });
  }

  // gac.gac_scoring_rules has no ordering column, and the client resolves
  // scoring by key and specificity rather than array position.
  adjusted.scoring = sortScoring(adjusted.scoring);
  deltas.push({
    id: "SCORING_ARRAY_ORDER",
    decision: "EXPECTED_DELTA_ORDER_INSENSITIVE_SCORING",
    domain: "scoring",
    detail: "Both sides are compared in (ruleId, battleType, mode) order. No scoring value, key or note differs."
  });

  return { adjusted, deltas };
}

// ─── comparison ──────────────────────────────────────────────────────────────

function diffPayloads(expected, actual, prefix = "") {
  const differences = [];
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!isDeepStrictEqual(expected, actual)) {
      differences.push({ path: prefix || "(root)", expected, actual });
    }
    return differences;
  }
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in expected)) { differences.push({ path, expected: undefined, actual: actual[key] }); continue; }
      if (!(key in actual)) { differences.push({ path, expected: expected[key], actual: undefined }); continue; }
      differences.push(...diffPayloads(expected[key], actual[key], path));
    }
    return differences;
  }
  if (!isDeepStrictEqual(expected, actual)) {
    differences.push({ path: prefix || "(root)", expected, actual });
  }
  return differences;
}

function compatibilityChecks(goldenPayload, projected, reconciliation) {
  const checks = [];

  const goldenCounterIds = new Set();
  for (const teams of Object.values(goldenPayload.counters)) {
    for (const entries of Object.values(teams)) {
      for (const entry of entries) goldenCounterIds.add(entry.counterId);
    }
  }
  const projectedDefinitionIds = new Set(Object.keys(projected.counterDefinitions));
  checks.push({
    id: "NO_CHANGED_PUBLIC_COUNTER_ID",
    passed: [...Object.keys(goldenPayload.counterDefinitions)].every((id) => projectedDefinitionIds.has(id)),
    detail: `${Object.keys(goldenPayload.counterDefinitions).length} golden counter definitions, ${projectedDefinitionIds.size} projected`
  });
  checks.push({
    id: "EVERY_USED_COUNTER_ID_STILL_DEFINED",
    passed: [...goldenCounterIds].every((id) => projectedDefinitionIds.has(id)),
    detail: `${goldenCounterIds.size} counter IDs referenced by golden matchups`
  });

  const goldenDefenceNames = new Set();
  for (const teams of Object.values(goldenPayload.counters)) for (const name of Object.keys(teams)) goldenDefenceNames.add(name);
  for (const teams of Object.values(goldenPayload.defenceTeams)) for (const name of Object.keys(teams)) goldenDefenceNames.add(name);
  const projectedDefenceNames = new Set();
  for (const teams of Object.values(projected.counters)) for (const name of Object.keys(teams)) projectedDefenceNames.add(name);
  for (const teams of Object.values(projected.defenceTeams)) for (const name of Object.keys(teams)) projectedDefenceNames.add(name);
  const missingNames = [...goldenDefenceNames].filter((name) => !projectedDefenceNames.has(name));
  checks.push({
    id: "NO_CHANGED_DEFENCE_DISPLAY_NAME",
    passed: missingNames.length === 0,
    detail: missingNames.length === 0 ? `${goldenDefenceNames.size} defence display names preserved` : `missing: ${missingNames.join(", ")}`
  });

  const goldenNotes = [];
  for (const teams of Object.values(goldenPayload.counters)) {
    for (const entries of Object.values(teams)) {
      for (const entry of entries) if (entry.notes !== "") goldenNotes.push(entry.notes);
    }
  }
  const projectedNotes = [];
  for (const teams of Object.values(projected.counters)) {
    for (const entries of Object.values(teams)) {
      for (const entry of entries) if (entry.notes !== "") projectedNotes.push(entry.notes);
    }
  }
  const missingNotes = [...goldenNotes];
  for (const note of projectedNotes) {
    const index = missingNotes.indexOf(note);
    if (index >= 0) missingNotes.splice(index, 1);
  }
  checks.push({
    id: "NO_MISSING_NOTE",
    passed: missingNotes.length === 0,
    detail: missingNotes.length === 0
      ? `${goldenNotes.length} golden notes, ${projectedNotes.length} projected`
      : `missing notes: ${JSON.stringify(missingNotes)}`
  });

  const goldenCoverage = Object.values(goldenPayload.counterDefinitions)
    .flatMap((definition) => definition.required)
    .filter((unitId) => (goldenPayload.characterDefinitions[unitId]?.externalId ?? "") !== "").length;
  const projectedCoverage = Object.values(projected.counterDefinitions)
    .flatMap((definition) => definition.required)
    .filter((unitId) => (projected.characterDefinitions[unitId]?.externalId ?? "") !== "").length;
  checks.push({
    id: "NO_REDUCED_REQUIRED_MEMBER_EXTERNAL_ID_COVERAGE",
    passed: projectedCoverage >= goldenCoverage,
    detail: `golden ${goldenCoverage}, projected ${projectedCoverage}`
  });

  const boardOrderMatches = isDeepStrictEqual(goldenPayload.boardConfig, projected.boardConfig);
  checks.push({
    id: "NO_CHANGED_BOARD_ORDER_OR_COUNT",
    passed: boardOrderMatches,
    detail: boardOrderMatches ? "board configuration is identical, order included" : "board configuration differs"
  });

  const scoringMatches = isDeepStrictEqual(sortScoring(goldenPayload.scoring), sortScoring(projected.scoring));
  checks.push({
    id: "NO_CHANGED_SCORING_VALUE",
    passed: scoringMatches,
    detail: scoringMatches ? `${goldenPayload.scoring.length} scoring rows identical` : "scoring rows differ"
  });

  checks.push({
    id: "NO_INVENTED_DEFENCE_COMPOSITION",
    passed: isDeepStrictEqual(projected.defenceCompositions, {}),
    detail: "defenceCompositions stays empty because the optional source tab is absent"
  });

  checks.push({
    id: "NO_FUZZY_MAPPINGS",
    passed: reconciliation.assurances.fuzzyMappingsUsed === false
      && reconciliation.assurances.semanticMappingsUsed === false
      && reconciliation.assurances.caseInsensitiveNameMatchingUsed === false,
    detail: "identity resolution used exact, unique display-name matching only"
  });

  return checks;
}

function verifyProjection(goldenPayload, projected, reconciliation) {
  const { adjusted, deltas } = applyExpectedDeltas(goldenPayload, reconciliation);
  const comparable = { ...projected, scoring: sortScoring(projected.scoring) };
  const differences = diffPayloads(adjusted, comparable);
  const checks = compatibilityChecks(goldenPayload, projected, reconciliation);
  const byteIdentical = canonicalJson(adjusted) === canonicalJson(comparable);

  return {
    package: "ARCH-106",
    scope: "migration verification only; ARCH-108 owns payload generation and publication",
    expectedDeltas: deltas,
    unexplainedDifferences: differences,
    byteIdenticalAfterExpectedDeltas: byteIdentical,
    checks,
    passed: differences.length === 0 && byteIdentical && checks.every((check) => check.passed)
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { capture: DEFAULT_CAPTURE_ROOT, decisions: DEFAULT_DECISIONS_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capture") options.capture = argv[++index];
    else if (arg === "--decisions") options.decisions = argv[++index];
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = readSources(options.capture);
  const decisions = readDecisions(options.decisions);
  const { plan, reconciliation } = buildPlan(sources, decisions);

  const database = await createDisposableDatabase();
  try {
    await applySchema(database);
    await loadPlan(database, plan, reconciliation);
    const projected = await projectPayload(database, decisions);
    const result = verifyProjection(sources.goldenPayload, projected, reconciliation);

    console.log(`ARCH-106 compatibility verification: ${result.passed ? "PASSED" : "FAILED"}`);
    for (const check of result.checks) {
      console.log(`  ${check.passed ? "ok  " : "FAIL"} ${check.id} — ${check.detail}`);
    }
    console.log(`  Expected deltas: ${result.expectedDeltas.length}`);
    for (const delta of result.expectedDeltas) {
      console.log(`    - ${delta.id} (${delta.decision})`);
    }
    console.log(`  Unexplained differences: ${result.unexplainedDifferences.length}`);
    for (const difference of result.unexplainedDifferences.slice(0, 20)) {
      console.log(`    - ${difference.path}: expected ${JSON.stringify(difference.expected)}, got ${JSON.stringify(difference.actual)}`);
    }
    if (!result.passed) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ARCH-106 verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { applyExpectedDeltas, diffPayloads, projectPayload, sortScoring, verifyProjection };
