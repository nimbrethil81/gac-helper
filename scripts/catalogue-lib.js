"use strict";

const crypto = require("node:crypto");

const { canonicalJson } = require("./baseline-lib.js");
const { readDecisions } = require("./migration-lib.js");
const { applyExpectedDeltas, diffPayloads, projectPayload, sortScoring } = require("./migration-verify.js");

const PAYLOAD_SCHEMA_VERSION = 1;
const PAYLOAD_KEYS = Object.freeze([
  "payloadSchemaVersion", "catalogueVersion", "checksum", "units",
  "counterDefinitions", "characterDefinitions", "counters", "defenceTeams",
  "defenceCompositions", "boardConfig", "scoring", "provenance"
]);
const MODES = Object.freeze(["3v3", "5v5", "FLEET"]);
const LEAGUES = Object.freeze(["AURODIUM", "BRONZIUM", "CARBONITE", "CHROMIUM", "KYBER"]);
const TERRITORIES = Object.freeze(["FRONT_TOP", "FRONT_BOTTOM", "BACK_TOP", "BACK_BOTTOM"]);
const BANNER_CEILING = Object.freeze({ "3v3": 57, "5v5": 65, FLEET: 73 });
const UNDERSIZE_CEILING = Object.freeze({ "3v3": 2, "5v5": 4, FLEET: 5 });
const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|cookie|connection(?:string|url)|databaseurl|apikey|api_key)/i;
const SENSITIVE_VALUE = /(?:postgres(?:ql)?:\/\/|bearer\s+[a-z0-9._~-]+|gh[pousr]_[a-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

class CatalogueValidationError extends Error {
  constructor(issues) {
    super(`Catalogue rejected:\n${issues.map((issue) => `  - [${issue.code}] ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "CatalogueValidationError";
    this.issues = issues;
  }
}

function unsignedPayload(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  delete copy.checksum;
  return copy;
}

function checksumFor(payload) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(unsignedPayload(payload))).digest("hex")}`;
}

function addChecksum(payload) {
  const complete = { ...payload, checksum: "" };
  complete.checksum = checksumFor(complete);
  return complete;
}

async function generatePayload(database, {
  version,
  baseReleaseId = null,
  releaseReason,
  generatedAt,
  sourceCommitSha,
  authoringChangeIds = [],
  decisions = readDecisions()
}) {
  const projected = await projectPayload(database, decisions);
  const characterDefinitions = projected.characterDefinitions;
  const units = Object.fromEntries(Object.entries(characterDefinitions).map(([unitId, value]) => [unitId, { ...value }]));

  return addChecksum({
    payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
    catalogueVersion: version,
    checksum: "",
    units,
    counterDefinitions: projected.counterDefinitions,
    characterDefinitions,
    counters: projected.counters,
    defenceTeams: projected.defenceTeams,
    defenceCompositions: projected.defenceCompositions,
    boardConfig: projected.boardConfig,
    scoring: sortScoring(projected.scoring),
    provenance: {
      baseReleaseId,
      releaseReason,
      generatedAt,
      sourceCommitSha,
      authoringChangeIds: [...authoringChangeIds].sort()
    }
  });
}

function scanSensitive(value, issues, path = "payload", forbiddenValues = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitive(item, issues, `${path}[${index}]`, forbiddenValues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) issues.push({ code: "SENSITIVE_KEY", path: `${path}.${key}`, message: "secret-shaped keys are forbidden in public artifacts" });
      scanSensitive(child, issues, `${path}.${key}`, forbiddenValues);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (SENSITIVE_VALUE.test(value)) issues.push({ code: "SENSITIVE_VALUE", path, message: "credential-shaped content is forbidden in public artifacts" });
  for (const forbidden of forbiddenValues.filter((entry) => typeof entry === "string" && entry.length >= 8)) {
    if (value.includes(forbidden)) issues.push({ code: "FORBIDDEN_VALUE", path, message: "a configured secret value entered the public artifact" });
  }
}

function validatePayload(payload, {
  goldenPayload = null,
  reconciliation = null,
  basePayload = null,
  allowedRemovedCounterIds = [],
  allowedRemovedDefenceNames = [],
  forbiddenValues = []
} = {}) {
  const issues = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CatalogueValidationError([{ code: "TYPE", path: "payload", message: "must be an object" }]);
  }

  const keys = Object.keys(payload).sort();
  const expectedKeys = [...PAYLOAD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) add("TOP_LEVEL_KEYS", "payload", `expected exactly ${expectedKeys.join(", ")}`);
  if (payload.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) add("SCHEMA_VERSION", "payloadSchemaVersion", `must be ${PAYLOAD_SCHEMA_VERSION}`);
  if (!Number.isSafeInteger(payload.catalogueVersion) || payload.catalogueVersion < 1) add("CATALOGUE_VERSION", "catalogueVersion", "must be a positive safe integer");
  if (!/^sha256:[0-9a-f]{64}$/.test(payload.checksum ?? "")) add("CHECKSUM_FORMAT", "checksum", "must be a sha256 digest");
  else if (checksumFor(payload) !== payload.checksum) add("CHECKSUM_MISMATCH", "checksum", "does not match the canonical payload content");

  const counterModes = Object.keys(payload.counters ?? {}).sort();
  if (JSON.stringify(counterModes) !== JSON.stringify([...MODES].sort())) add("COUNTER_MODES", "counters", `must contain exactly ${MODES.join(", ")}`);

  const settingDefence = (payload.scoring ?? []).filter((row) => row.ruleId === "SETTING_DEFENCE" && row.battleType === "ANY" && row.mode === "ANY");
  if (settingDefence.length !== 1 || !Number.isFinite(settingDefence[0]?.value) || settingDefence[0].value <= 0) {
    add("SETTING_DEFENCE", "scoring", "must contain exactly one positive finite SETTING_DEFENCE / ANY / ANY rule");
  }

  const leagues = Object.keys(payload.boardConfig ?? {}).sort();
  if (JSON.stringify(leagues) !== JSON.stringify([...LEAGUES].sort())) add("BOARD_LEAGUES", "boardConfig", `must contain exactly ${LEAGUES.join(", ")}`);
  for (const league of LEAGUES) {
    const modes = payload.boardConfig?.[league] ?? {};
    if (JSON.stringify(Object.keys(modes).sort()) !== JSON.stringify(["3v3", "5v5"])) add("BOARD_MODES", `boardConfig.${league}`, "must contain exactly 3v3 and 5v5");
    for (const mode of ["3v3", "5v5"]) {
      const rows = modes[mode] ?? [];
      if (JSON.stringify(rows.map((row) => row.territory)) !== JSON.stringify(TERRITORIES)) add("TERRITORY_ORDER", `boardConfig.${league}.${mode}`, `must be ordered ${TERRITORIES.join(", ")}`);
      if (rows.filter((row) => row.type === "FLEET").length !== 1) add("FLEET_TERRITORY", `boardConfig.${league}.${mode}`, "must contain exactly one Fleet territory");
      rows.forEach((row, index) => {
        if (!Number.isInteger(row.teamCount) || row.teamCount < 0) add("TEAM_COUNT", `boardConfig.${league}.${mode}[${index}].teamCount`, "must be a non-negative integer");
        if (!["SQUAD", "FLEET"].includes(row.type)) add("TERRITORY_TYPE", `boardConfig.${league}.${mode}[${index}].type`, "must be SQUAD or FLEET");
      });
    }
  }

  for (const mode of MODES) {
    for (const [defenceName, entries] of Object.entries(payload.counters?.[mode] ?? {})) {
      if (!Array.isArray(entries)) { add("COUNTER_LIST", `counters.${mode}.${defenceName}`, "must be an array"); continue; }
      for (const [index, entry] of entries.entries()) {
        const at = `counters.${mode}.${defenceName}[${index}]`;
        if (!payload.counterDefinitions?.[entry.counterId]) add("UNKNOWN_COUNTER", `${at}.counterId`, `${entry.counterId} has no counter definition`);
        if (!["S", "A", "B", "C"].includes(entry.tier)) add("TIER", `${at}.tier`, "must be S, A, B or C");
        if (!Number.isInteger(entry.bannerScore) || entry.bannerScore < 0 || entry.bannerScore > BANNER_CEILING[mode]) add("BANNER_SCORE", `${at}.bannerScore`, `must be 0..${BANNER_CEILING[mode]}`);
        if (!Number.isInteger(entry.undersize) || entry.undersize < 0 || entry.undersize > UNDERSIZE_CEILING[mode]) add("UNDERSIZE", `${at}.undersize`, `must be 0..${UNDERSIZE_CEILING[mode]}`);
        if (typeof entry.notes !== "string") add("NOTES", `${at}.notes`, "must be a string");
      }
    }
  }

  for (const [counterId, definition] of Object.entries(payload.counterDefinitions ?? {})) {
    if (typeof definition.name !== "string" || definition.name.trim() === "") add("COUNTER_NAME", `counterDefinitions.${counterId}.name`, "must be non-empty");
    if (!Array.isArray(definition.required) || !Array.isArray(definition.recommended)) {
      add("COUNTER_MEMBERS", `counterDefinitions.${counterId}`, "required and recommended must be arrays");
      continue;
    }
    const duplicateMembers = definition.required.filter((unitId) => definition.recommended.includes(unitId));
    duplicateMembers.forEach((unitId) => add("COUNTER_MEMBER_ROLE", `counterDefinitions.${counterId}`, `${unitId} cannot be both required and recommended`));
    for (const unitId of definition.required) {
      const unit = payload.characterDefinitions?.[unitId];
      if (!unit) add("UNKNOWN_REQUIRED_UNIT", `counterDefinitions.${counterId}.required`, `${unitId} is undefined`);
      else if ((unit.externalId ?? "") === "") add("MISSING_EXTERNAL_ID", `characterDefinitions.${unitId}.externalId`, "required members need an external ID");
    }
    for (const unitId of definition.recommended) {
      if (!payload.characterDefinitions?.[unitId]) add("UNKNOWN_RECOMMENDED_UNIT", `counterDefinitions.${counterId}.recommended`, `${unitId} is undefined`);
    }
  }

  for (const [unitId, unit] of Object.entries(payload.characterDefinitions ?? {})) {
    if (typeof unit.name !== "string" || unit.name.trim() === "") add("UNIT_NAME", `characterDefinitions.${unitId}.name`, "must be non-empty");
    if (!["CHARACTER", "SHIP", "CAPITAL_SHIP"].includes(unit.unitType)) add("UNIT_TYPE", `characterDefinitions.${unitId}.unitType`, "is invalid");
    if (typeof unit.externalId !== "string") add("EXTERNAL_ID", `characterDefinitions.${unitId}.externalId`, "must be a string");
  }

  for (const [mode, teams] of Object.entries(payload.defenceTeams ?? {})) {
    if (!["Any", ...MODES].includes(mode)) add("DEFENCE_MODE", `defenceTeams.${mode}`, "is not an app-compatible public mode");
    for (const [name, value] of Object.entries(teams ?? {})) {
      if (name.trim() === "") add("DEFENCE_NAME", `defenceTeams.${mode}`, "contains a blank defence name");
      if (!["LOW", "NORMAL", "HIGH", "EXTREME"].includes(value.threat)) add("THREAT", `defenceTeams.${mode}.${name}.threat`, "is invalid");
      if (typeof value.notes !== "string") add("DEFENCE_NOTES", `defenceTeams.${mode}.${name}.notes`, "must be a string");
    }
  }

  for (const [index, rule] of (payload.scoring ?? []).entries()) {
    if (typeof rule.ruleId !== "string" || rule.ruleId.trim() === "") add("SCORING_RULE", `scoring[${index}].ruleId`, "must be non-empty");
    if (!["ANY", "SQUAD", "FLEET"].includes(rule.battleType)) add("SCORING_BATTLE_TYPE", `scoring[${index}].battleType`, "is invalid");
    if (!["ANY", ...MODES].includes(rule.mode)) add("SCORING_MODE", `scoring[${index}].mode`, "is invalid");
    if (!Number.isSafeInteger(rule.value) || rule.value < 0) add("SCORING_VALUE", `scoring[${index}].value`, "must be a non-negative safe integer");
    if (typeof rule.notes !== "string") add("SCORING_NOTES", `scoring[${index}].notes`, "must be a string");
  }

  if (JSON.stringify(payload.units) !== JSON.stringify(payload.characterDefinitions)) add("UNITS_PROJECTION", "units", "must be the additive canonical unit projection for schema v1");
  if (!payload.provenance || !["MIGRATION", "AUTHORING", "MAINTENANCE", "APPROVED_OVERRIDE"].includes(payload.provenance.releaseReason)) add("PROVENANCE_REASON", "provenance.releaseReason", "is invalid");
  if (!/^[0-9a-f]{40}$/.test(payload.provenance?.sourceCommitSha ?? "")) add("SOURCE_COMMIT", "provenance.sourceCommitSha", "must be a full commit SHA");
  if (Number.isNaN(Date.parse(payload.provenance?.generatedAt ?? ""))) add("GENERATED_AT", "provenance.generatedAt", "must be an ISO timestamp");
  if (!Array.isArray(payload.provenance?.authoringChangeIds) || payload.provenance.authoringChangeIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    add("AUTHORING_CHANGE_IDS", "provenance.authoringChangeIds", "must be an array of non-empty strings");
  } else {
    const sortedUnique = [...new Set(payload.provenance.authoringChangeIds)].sort();
    if (JSON.stringify(sortedUnique) !== JSON.stringify(payload.provenance.authoringChangeIds)) add("AUTHORING_CHANGE_IDS", "provenance.authoringChangeIds", "must be sorted and unique");
    if (payload.provenance.releaseReason === "AUTHORING" && sortedUnique.length === 0) add("AUTHORING_CHANGE_IDS", "provenance.authoringChangeIds", "AUTHORING releases require at least one change ID");
  }

  scanSensitive(payload, issues, "payload", forbiddenValues);

  if (goldenPayload !== null) {
    if (reconciliation === null) add("PARITY_CONFIGURATION", "goldenPayload", "reconciliation is required for golden parity");
    else {
      const expected = applyExpectedDeltas(goldenPayload, reconciliation).adjusted;
      const actual = Object.fromEntries(["counters", "counterDefinitions", "characterDefinitions", "boardConfig", "scoring", "defenceTeams", "defenceCompositions"].map((key) => [key, payload[key]]));
      actual.scoring = sortScoring(actual.scoring);
      for (const difference of diffPayloads(expected, actual)) add("GOLDEN_PARITY", difference.path, "differs from the ARCH-103 golden payload after declared deltas");
    }
  }

  if (basePayload !== null) {
    const removedCounters = Object.keys(basePayload.counterDefinitions ?? {}).filter((id) => !(id in (payload.counterDefinitions ?? {})) && !allowedRemovedCounterIds.includes(id));
    removedCounters.forEach((id) => add("COUNTER_ID_REMOVED", `counterDefinitions.${id}`, "stable counter ID disappeared without an explicit lifecycle change"));
    const defenceNames = (source) => new Set([
      ...Object.values(source.counters ?? {}).flatMap((teams) => Object.keys(teams)),
      ...Object.values(source.defenceTeams ?? {}).flatMap((teams) => Object.keys(teams))
    ]);
    const nextNames = defenceNames(payload);
    for (const name of defenceNames(basePayload)) if (!nextNames.has(name) && !allowedRemovedDefenceNames.includes(name)) add("DEFENCE_NAME_REMOVED", `defence:${name}`, "stable defence name disappeared without an explicit lifecycle change");
  }

  if (issues.length > 0) throw new CatalogueValidationError(issues);
  return { valid: true, checksum: payload.checksum };
}

async function validateAssessedProvenance(database) {
  const matchup = (await database.query(`
    select count(*)::int as total from gac.matchup_catalogue_values
    where (tier_authority = 'ASSESSED' or banner_authority = 'ASSESSED' or undersize_authority = 'ASSESSED')
      and (source_assessment_id is null or source_finding_id is null)
  `)).rows[0].total;
  const defence = (await database.query(`
    select count(*)::int as total from gac.defence_catalogue_values
    where threat_authority = 'ASSESSED'
      and (source_assessment_id is null or source_finding_id is null)
  `)).rows[0].total;
  if (matchup + defence > 0) throw new CatalogueValidationError([{ code: "ASSESSED_PROVENANCE", path: "database", message: `${matchup + defence} assessed row(s) lack assessment/finding provenance` }]);
}

module.exports = {
  PAYLOAD_SCHEMA_VERSION,
  PAYLOAD_KEYS,
  CatalogueValidationError,
  addChecksum,
  checksumFor,
  generatePayload,
  scanSensitive,
  unsignedPayload,
  validateAssessedProvenance,
  validatePayload
};
