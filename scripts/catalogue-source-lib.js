"use strict";

// Git-native catalogue source: import, compile and validate (issue #41,
// ADR-ARCH-116 §4–§5).
//
// - importFromPayload turns a reconciled action=data payload (plus the
//   authoring-only Score_Meanings rows) into catalogue/source/ files without
//   modifying any value: discrepancies are carried verbatim.
// - compileSource turns catalogue/source/ back into the exact seven-key
//   action=data payload. It is pure, dependency-free and deterministic.
// - auditSource validates source files, then runs the shared #34 rule set
//   (catalogue-audit-lib) over the compiled payload. There is no second rule
//   authority for catalogue values.
// - applyCorrections applies an explicit correction list in memory, refusing
//   any change whose recorded "before" no longer matches.

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { canonicalJson, sha256 } = require("./baseline-lib.js");

const {
  CATALOGUE_TABS,
  auditPayload,
  collector,
  compareFindings,
  diffPayloads,
  emulateActionData,
  payloadChecksum,
  scanSensitive,
  summarise
} = require("./catalogue-audit-lib.js");

const SOURCE_SCHEMA = 1;
const RELEASE_CONTRACT = "gac-catalogue-release:v1";
const CHANGE_SET_SCHEMA = 2;
const CHANGE_SET_CONTRACT = "gac-catalogue-change-set:v1";
const ABSENT = "ABSENT";
const REMOVE = "REMOVE";
const MATCHUP_MODES = Object.freeze(["5v5", "3v3", "FLEET"]);

// File → top-level array key, row fields (required / optional) and sort key.
const FILES = Object.freeze({
  "units.json": { array: "units", required: { id: "string", name: "string", unitType: "string" }, optional: { externalId: "string" }, sortBy: "id" },
  "counters.json": { array: "counters", required: { id: "string", name: "string", required: "strings", recommended: "strings" }, optional: { strategicReserve: "true" }, sortBy: "id" },
  "defence-teams.json": { array: "defenceTeams", required: { defence: "string", mode: "string", threat: "string" }, optional: { notes: "string" } },
  "defence-compositions.json": { array: "defenceCompositions", required: { defence: "string", mode: "string", units: "strings" } },
  "board-config.json": { array: "territories", required: { league: "string", mode: "string", territory: "string", type: "string", teamCount: "number" } },
  "scoring.json": { array: "rules", required: { ruleId: "string", battleType: "string", mode: "string", value: "number" }, optional: { notes: "string" } },
  "score-meanings.json": { array: "meanings", required: { mode: "string", bannerScore: "number", meaning: "string" } },
  ...Object.fromEntries(MATCHUP_MODES.map((mode) => [`matchups/${mode}.json`, {
    array: "defences",
    required: { defence: "string", counters: "matchups" },
    sortBy: "defence"
  }]))
});
const MATCHUP_ENTRY = { required: { counterId: "string", tier: "string", bannerScore: "number", undersize: "number" }, optional: { notes: "string" } };

// Field order used when writing rows, so imports and corrections diff cleanly.
const FIELD_ORDER = ["id", "defence", "mode", "league", "territory", "type", "teamCount", "ruleId", "battleType", "value",
  "name", "unitType", "externalId", "strategicReserve", "required", "recommended", "threat", "units", "counterId", "tier",
  "bannerScore", "undersize", "meaning", "notes", "counters",
  // Correction lists (catalogue/corrections/*.json).
  "baseline", "baselineChecksum", "issue", "approval", "status", "title", "resolves", "references",
  "externalIdVerification", "runtimeEffect", "file", "before", "after", "changes", "corrections"];

// Code-unit order: deterministic and locale-independent.
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ─── formatting ──────────────────────────────────────────────────────────────

function orderedKeys(object) {
  return Object.keys(object).sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    return (ia < 0 ? FIELD_ORDER.length : ia) - (ib < 0 ? FIELD_ORDER.length : ib) || byCodeUnits(a, b);
  });
}

const isPrimitive = (value) => value === null || typeof value !== "object";
const isLeaf = (value) => isPrimitive(value) ||
  (Array.isArray(value) ? value.every(isPrimitive) : Object.values(value).every((child) => isPrimitive(child) || (Array.isArray(child) && child.every(isPrimitive))));

function formatLeaf(value) {
  if (isPrimitive(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  const keys = orderedKeys(value);
  return keys.length ? `{ ${keys.map((key) => `${JSON.stringify(key)}: ${formatLeaf(value[key])}`).join(", ")} }` : "{}";
}

// Two-space indented JSON with one source row per line.
function formatSourceJson(value, indent = "") {
  if (isLeaf(value)) return formatLeaf(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${inner}${formatSourceJson(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  const keys = value.schema !== undefined ? ["schema", ...orderedKeys(value).filter((key) => key !== "schema")] : orderedKeys(value);
  return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${formatSourceJson(value[key], inner)}`).join(",\n")}\n${indent}}`;
}

// ─── reading and writing ─────────────────────────────────────────────────────

// In-memory source: { "units.json": [...rows], "matchups/5v5.json": [...], ... }
function readSource(directory) {
  const root = path.resolve(directory);
  const { findings, add } = collector();
  const source = {};
  for (const [file, spec] of Object.entries(FILES)) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      add("SOURCE_SCHEMA", { location: file, observed: "missing file", expected: `{ "schema": 1, "${spec.array}": [...] }` });
      source[file] = [];
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch (error) {
      add("SOURCE_SCHEMA", { location: file, observed: `invalid JSON: ${error.message}`, expected: "valid JSON" });
      source[file] = [];
      continue;
    }
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
    if (parsed?.schema !== SOURCE_SCHEMA || !Array.isArray(parsed?.[spec.array]) || keys.length !== 2) {
      add("SOURCE_SCHEMA", { location: file, observed: JSON.stringify(keys), expected: `exactly "schema": ${SOURCE_SCHEMA} and "${spec.array}": [...]` });
    }
    source[file] = Array.isArray(parsed?.[spec.array]) ? parsed[spec.array] : [];
  }
  const known = new Set(Object.keys(FILES));
  const walk = (dir, prefix = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
  });
  if (fs.existsSync(root)) {
    for (const file of walk(root)) {
      if (!known.has(file)) add("SOURCE_SCHEMA", { location: file, observed: "unexpected file", expected: Object.keys(FILES).join(", ") });
    }
  }
  return { source, findings };
}

function writeSource(directory, source) {
  const root = path.resolve(directory);
  for (const [file, spec] of Object.entries(FILES)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${formatSourceJson({ schema: SOURCE_SCHEMA, [spec.array]: source[file] ?? [] })}\n`);
  }
}

// Validate the complete replacement before swapping it into place. This keeps a
// multi-file correction from leaving a partly written source tree if a later
// file cannot be formatted or written.
function writeSourceAtomically(directory, source) {
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(root)}-stage-`));
  const backup = path.join(parent, `.${path.basename(root)}-backup-${process.pid}-${Date.now()}`);
  try {
    writeSource(stage, source);
    const reread = readSource(stage);
    if (reread.findings.length || !isDeepStrictEqual(reread.source, source)) {
      throw new Error("staged source did not round-trip exactly");
    }
    if (!fs.existsSync(root)) {
      fs.renameSync(stage, root);
      return;
    }
    fs.renameSync(root, backup);
    try {
      fs.renameSync(stage, root);
    } catch (error) {
      fs.renameSync(backup, root);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ─── import (payload → source), lossless by construction ─────────────────────

const withoutBlank = (row, ...fields) => {
  const copy = { ...row };
  for (const field of fields) if (copy[field] === "") delete copy[field];
  return copy;
};

function sortRows(file, rows) {
  const spec = FILES[file];
  if (spec.sortBy) return [...rows].sort((a, b) => byCodeUnits(a[spec.sortBy], b[spec.sortBy]));
  if (file === "defence-teams.json" || file === "defence-compositions.json") {
    return [...rows].sort((a, b) => byCodeUnits(a.defence, b.defence) || byCodeUnits(a.mode, b.mode));
  }
  return rows;
}

function importFromPayload(payload, scoreMeanings = []) {
  const unrepresentable = Object.keys(payload.counters).filter((mode) => !MATCHUP_MODES.includes(mode));
  if (unrepresentable.length) throw new Error(`Counters mode(s) ${JSON.stringify(unrepresentable)} cannot be represented: matchup files exist only for ${MATCHUP_MODES.join(", ")}`);

  const source = {
    "units.json": sortRows("units.json", Object.entries(payload.characterDefinitions).map(([id, unit]) =>
      withoutBlank({ id, name: unit.name, unitType: unit.unitType, externalId: unit.externalId }, "externalId"))),
    "counters.json": sortRows("counters.json", Object.entries(payload.counterDefinitions).map(([id, definition]) => ({
      id,
      name: definition.name,
      ...(definition.strategicReserve === true ? { strategicReserve: true } : {}),
      required: [...definition.required],
      recommended: [...definition.recommended]
    }))),
    "defence-teams.json": sortRows("defence-teams.json", Object.entries(payload.defenceTeams).flatMap(([mode, teams]) =>
      Object.entries(teams).map(([defence, value]) => withoutBlank({ defence, mode, threat: value.threat, notes: value.notes }, "notes")))),
    "defence-compositions.json": sortRows("defence-compositions.json", Object.entries(payload.defenceCompositions).flatMap(([mode, teams]) =>
      Object.entries(teams).map(([defence, units]) => ({ defence, mode, units: [...units] })))),
    "board-config.json": Object.entries(payload.boardConfig).flatMap(([league, modes]) =>
      Object.entries(modes).flatMap(([mode, rows]) => rows.map((row) => ({ league, mode, territory: row.territory, type: row.type, teamCount: row.teamCount })))),
    "scoring.json": payload.scoring.map((rule) => withoutBlank({ ruleId: rule.ruleId, battleType: rule.battleType, mode: rule.mode, value: rule.value, notes: rule.notes }, "notes")),
    "score-meanings.json": scoreMeanings.map((row) => ({ ...row }))
  };
  for (const mode of MATCHUP_MODES) {
    source[`matchups/${mode}.json`] = sortRows(`matchups/${mode}.json`, Object.entries(payload.counters[mode] ?? {}).map(([defence, entries]) => ({
      defence,
      counters: entries.map((entry) => withoutBlank({ counterId: entry.counterId, tier: entry.tier, bannerScore: entry.bannerScore, undersize: entry.undersize, notes: entry.notes }, "notes"))
    })));
  }
  return source;
}

// Score_Meanings is authoring-only (never served), so it comes from the tab.
function scoreMeaningsFromSnapshot(snapshot) {
  const tab = snapshot.tabs.Score_Meanings;
  if (!tab) return [];
  const headers = tab.grid[0].map(String);
  const at = (name) => headers.indexOf(name);
  return tab.grid.slice(1)
    .filter((row) => row.some((value) => String(value).trim() !== ""))
    .map((row) => ({ mode: row[at("Mode")], bannerScore: row[at("Score")], meaning: row[at("Meaning")] }));
}

// Sheet-only losses the seven-key payload cannot carry. Importing over any of
// them would silently drop authored data, so the import refuses instead.
const IMPORT_BLOCKERS = new Set([
  "SNAPSHOT_TAB_MISSING", "HEADER_MISSING", "HEADER_POSITION", "HEADER_DUPLICATE", "FORMULA_ERROR",
  "DERIVED_FORMULA_MISSING", "DERIVED_FORMULA_RANGE", "DERIVED_VALUE_MISMATCH", "ROW_SKIPPED_INCOMPLETE",
  "COMPOSITION_ROLE_DROPPED", "COMPOSITION_UNKNOWN_COUNTER", "MATCHUP_MODE_INVALID", "PARITY_MISMATCH"
]);

// Import a reconciled snapshot. Refuses unless the Sheet, Code.gs emulation and
// captured action=data agree exactly, and the compiled source reproduces the
// captured payload exactly.
function importSnapshot(snapshot, snapshotReport) {
  if (!snapshot.actionData) throw new Error("Snapshot has no action=data capture; parity cannot be proven");
  const blockers = snapshotReport.findings.filter((finding) => IMPORT_BLOCKERS.has(finding.code));
  if (snapshotReport.parity.status !== "MATCH" || blockers.length) {
    throw new Error(`Snapshot is not importable without data loss (parity ${snapshotReport.parity.status}; ${blockers.map((finding) => `${finding.code} at ${finding.location}`).join("; ") || "no Sheet-only blockers"})`);
  }
  const definedCounters = new Set(snapshot.tabs.Counter_Definitions.grid.slice(1).map((row) => String(row[0]).trim()).filter(Boolean));
  const synthesised = Object.keys(snapshot.actionData.payload.counterDefinitions).filter((id) => !definedCounters.has(id));
  if (synthesised.length) throw new Error(`Apps Script placeholder definitions would be imported as authored data: ${synthesised.join(", ")}`);

  const source = importFromPayload(emulateActionData(snapshot.tabs), scoreMeaningsFromSnapshot(snapshot));
  const differences = diffPayloads(snapshot.actionData.payload, compileSource(source));
  if (differences.length) {
    throw new Error(`Undeclared import difference(s): ${differences.slice(0, 10).map((difference) => difference.path).join(", ")}${differences.length > 10 ? ` (+${differences.length - 10} more)` : ""}`);
  }
  return source;
}

// ─── compile (source → seven-key payload) ────────────────────────────────────

function compileSource(source) {
  const counterNames = new Map();
  const payload = {
    counters: { "5v5": {}, "3v3": {} },
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };

  for (const counter of source["counters.json"]) {
    if (!counterNames.has(counter.id)) counterNames.set(counter.id, counter.name);
    payload.counterDefinitions[counter.id] = {
      name: counter.name,
      required: [...(counter.required ?? [])],
      recommended: [...(counter.recommended ?? [])],
      ...(counter.strategicReserve === true ? { strategicReserve: true } : {})
    };
  }
  for (const unit of source["units.json"]) {
    payload.characterDefinitions[unit.id] = { name: unit.name, unitType: unit.unitType, externalId: unit.externalId ?? "" };
  }
  for (const mode of MATCHUP_MODES) {
    const defences = source[`matchups/${mode}.json`] ?? [];
    if (!defences.length && mode === "FLEET") continue;
    if (!payload.counters[mode]) payload.counters[mode] = {};
    for (const { defence, counters } of defences) {
      const list = payload.counters[mode][defence] ?? (payload.counters[mode][defence] = []);
      for (const entry of counters ?? []) {
        list.push({
          counterId: entry.counterId,
          counter: counterNames.get(entry.counterId) ?? "",
          tier: entry.tier,
          bannerScore: entry.bannerScore,
          undersize: entry.undersize,
          notes: entry.notes ?? ""
        });
      }
    }
  }
  for (const row of source["board-config.json"]) {
    const modes = payload.boardConfig[row.league] ?? (payload.boardConfig[row.league] = {});
    (modes[row.mode] ?? (modes[row.mode] = [])).push({ territory: row.territory, type: row.type, teamCount: row.teamCount });
  }
  payload.scoring = source["scoring.json"].map((rule) => ({ ruleId: rule.ruleId, battleType: rule.battleType, mode: rule.mode, value: rule.value, notes: rule.notes ?? "" }));
  for (const row of source["defence-teams.json"]) {
    (payload.defenceTeams[row.mode] ?? (payload.defenceTeams[row.mode] = {}))[row.defence] = { threat: row.threat, notes: row.notes ?? "" };
  }
  for (const row of source["defence-compositions.json"]) {
    const teams = payload.defenceCompositions[row.mode] ?? (payload.defenceCompositions[row.mode] = {});
    const units = teams[row.defence] ?? (teams[row.defence] = []);
    for (const unitId of row.units ?? []) if (!units.includes(unitId)) units.push(unitId);
  }
  return payload;
}

// ─── source validation ───────────────────────────────────────────────────────

function typeOk(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "true") return value === true;
  if (type === "strings") return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (type === "matchups") return Array.isArray(value) && value.length > 0;
  return false;
}

function checkRow(row, spec, location, add) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    add("SOURCE_SCHEMA", { location, observed: JSON.stringify(row), expected: "an object" });
    return false;
  }
  const allowed = { ...spec.required, ...(spec.optional ?? {}) };
  const problems = [];
  for (const [field, type] of Object.entries(spec.required)) if (!typeOk(row[field], type)) problems.push(`${field} must be ${type === "matchups" ? "a non-empty array" : type}`);
  for (const [field, type] of Object.entries(spec.optional ?? {})) if (row[field] !== undefined && !typeOk(row[field], type)) problems.push(`${field} must be ${type === "true" ? "true (or omitted)" : type}`);
  for (const field of Object.keys(row)) if (!(field in allowed)) problems.push(`unknown field ${field}`);
  if (problems.length) add("SOURCE_SCHEMA", { location, observed: problems.join("; "), expected: `fields ${Object.keys(allowed).join(", ")}` });
  return problems.length === 0;
}

function validateSource(source, add) {
  for (const [file, spec] of Object.entries(FILES)) {
    const rows = source[file] ?? [];
    rows.forEach((row, index) => {
      const location = `${file} ${spec.array}[${index}]`;
      if (checkRow(row, spec, location, add) && spec.array === "defences") {
        row.counters.forEach((entry, entryIndex) => checkRow(entry, MATCHUP_ENTRY, `${location}.counters[${entryIndex}]`, add));
      }
    });
    if (spec.sortBy) {
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1]?.[spec.sortBy];
        const current = rows[index]?.[spec.sortBy];
        if (typeof previous === "string" && typeof current === "string" && byCodeUnits(previous, current) > 0) {
          add("SOURCE_ORDER", { location: `${file} ${spec.array}[${index}]`, subject: current, observed: `${JSON.stringify(previous)} before ${JSON.stringify(current)}`, expected: `sorted by ${spec.sortBy} (code-unit order)` });
        }
      }
    }
    const keyOf = spec.sortBy ? (row) => row?.[spec.sortBy]
      : file === "defence-teams.json" || file === "defence-compositions.json" ? (row) => `${row?.defence}\u0000${row?.mode}` : null;
    if (keyOf) {
      const seen = new Map();
      rows.forEach((row, index) => {
        const key = keyOf(row);
        if (seen.has(key)) add("SOURCE_DUPLICATE", { location: `${file} ${spec.array}[${seen.get(key)}] and [${index}]`, subject: String(key).replace("\u0000", " / "), observed: "repeated key", expected: "unique key" });
        else seen.set(key, index);
      });
    }
  }
  scanSensitive(source["score-meanings.json"], "score-meanings.json", add);
}

// Validate source, compile it, and run the shared #34 rule set over the result.
function auditSource(source, { label = "catalogue/source", readFindings = [] } = {}) {
  const { findings, add } = collector();
  findings.push(...readFindings);
  validateSource(source, add);
  const payload = compileSource(source);
  const payloadReport = auditPayload(payload, { label });
  findings.push(...payloadReport.findings);
  findings.sort(compareFindings);
  return {
    ...payloadReport,
    input: { kind: "source", label, checksum: payloadChecksum(payload) },
    summary: summarise(findings),
    findings,
    payload
  };
}

// ─── corrections ─────────────────────────────────────────────────────────────

function stableKeyForRow(file, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (file === "units.json" || file === "counters.json") return { id: row.id };
  const matchup = /^matchups\/(5v5|3v3|FLEET)\.json$/.exec(file);
  if (matchup) return { mode: matchup[1], defence: row.defence };
  if (file === "defence-teams.json" || file === "defence-compositions.json") return { defence: row.defence, mode: row.mode };
  if (file === "board-config.json") return { league: row.league, mode: row.mode, territory: row.territory };
  if (file === "scoring.json") return { ruleId: row.ruleId, battleType: row.battleType, mode: row.mode };
  if (file === "score-meanings.json") return { mode: row.mode, bannerScore: row.bannerScore };
  return null;
}

function exactKeys(value, expected, where) {
  const actual = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) throw new Error(`${where}: expected fields ${wanted.join(", ")}; got ${actual.join(", ") || "none"}`);
}

function nonEmptyString(value, where) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where}: must be a non-empty string`);
}

function validateModernCorrections(document) {
  exactKeys(document, ["schema", "contract", "issue", "baseline", "corrections"], "change-set document");
  if (document.contract !== CHANGE_SET_CONTRACT) throw new Error(`change-set document: unsupported contract ${JSON.stringify(document.contract)}`);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+(?:#.*)?$/.test(document.issue ?? "")) {
    throw new Error("change-set document: issue must be a GitHub issue or pull-request URL");
  }
  exactKeys(document.baseline, ["commit", "catalogueVersion", "checksum"], "change-set baseline");
  if (!/^[0-9a-f]{40}$/.test(document.baseline.commit ?? "")) throw new Error("change-set baseline.commit must be a full lowercase Git commit SHA");
  if (!Number.isSafeInteger(document.baseline.catalogueVersion) || document.baseline.catalogueVersion < 1) throw new Error("change-set baseline.catalogueVersion must be a positive integer");
  if (!/^sha256:[0-9a-f]{64}$/.test(document.baseline.checksum ?? "")) throw new Error("change-set baseline.checksum must be sha256:<64 lowercase hex>");
  if (!Array.isArray(document.corrections) || !document.corrections.length) throw new Error("change-set document must contain at least one correction");

  const ids = new Set();
  const touched = new Map();
  for (const correction of document.corrections) {
    const where = `correction ${correction?.id ?? "<missing>"}`;
    exactKeys(correction, ["id", "status", "disposition", "title", "rationale", "approval", "provenance", "affectedReferences", "runtimeImpact", "expectedPayloadPaths", "changes"], where);
    nonEmptyString(correction.id, `${where}.id`);
    if (!/^[A-Z0-9][A-Z0-9._-]{2,127}$/.test(correction.id)) throw new Error(`${where}.id: use a stable uppercase proposal ID`);
    if (ids.has(correction.id)) throw new Error(`${where}.id: duplicate correction ID`);
    ids.add(correction.id);
    if (!["PENDING_OWNER_APPROVAL", "APPROVED", "REJECTED", "DEFERRED"].includes(correction.status)) throw new Error(`${where}.status: invalid decision state`);
    if (!["ADD", "AMEND", "RETIRE"].includes(correction.disposition)) throw new Error(`${where}.disposition: must be ADD, AMEND or RETIRE`);
    nonEmptyString(correction.title, `${where}.title`);
    nonEmptyString(correction.rationale, `${where}.rationale`);

    exactKeys(correction.provenance, ["evidence", "conditions", "confidence", "limitations"], `${where}.provenance`);
    if (!Array.isArray(correction.provenance.evidence) || !correction.provenance.evidence.length) throw new Error(`${where}.provenance.evidence: at least one source is required`);
    for (const [index, evidence] of correction.provenance.evidence.entries()) {
      const evidenceWhere = `${where}.provenance.evidence[${index}]`;
      exactKeys(evidence, ["url", "publisher", "publishedOrObservedAt", "accessedAt", "supports"], evidenceWhere);
      if (!/^https:\/\//.test(evidence.url ?? "")) throw new Error(`${evidenceWhere}.url: must be HTTPS`);
      for (const field of ["publisher", "publishedOrObservedAt", "accessedAt", "supports"]) nonEmptyString(evidence[field], `${evidenceWhere}.${field}`);
      if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(evidence.publishedOrObservedAt)) throw new Error(`${evidenceWhere}.publishedOrObservedAt: use a UTC date or timestamp`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.accessedAt)) throw new Error(`${evidenceWhere}.accessedAt: use a UTC date`);
    }
    for (const field of ["conditions", "confidence", "limitations"]) nonEmptyString(correction.provenance[field], `${where}.provenance.${field}`);
    if (!/^(High|Medium|Low)\b/.test(correction.provenance.confidence)) throw new Error(`${where}.provenance.confidence: start with High, Medium or Low and give the reasoning`);

    if (!Array.isArray(correction.affectedReferences) || !correction.affectedReferences.length) throw new Error(`${where}.affectedReferences: at least one affected or checked reference is required`);
    for (const [index, reference] of correction.affectedReferences.entries()) {
      const referenceWhere = `${where}.affectedReferences[${index}]`;
      exactKeys(reference, ["file", "stableKey", "effect"], referenceWhere);
      if (!FILES[reference.file]) throw new Error(`${referenceWhere}.file: unknown source file ${JSON.stringify(reference.file)}`);
      if (!reference.stableKey || typeof reference.stableKey !== "object" || Array.isArray(reference.stableKey)) throw new Error(`${referenceWhere}.stableKey: must be an object`);
      nonEmptyString(reference.effect, `${referenceWhere}.effect`);
    }

    exactKeys(correction.runtimeImpact, ["5v5", "3v3", "FLEET", "counters", "roundAvailability", "scoring", "strategicReserve"], `${where}.runtimeImpact`);
    for (const field of ["5v5", "3v3", "FLEET", "counters", "roundAvailability", "scoring", "strategicReserve"]) nonEmptyString(correction.runtimeImpact[field], `${where}.runtimeImpact.${field}`);
    if (!Array.isArray(correction.expectedPayloadPaths) || correction.expectedPayloadPaths.some((value) => typeof value !== "string" || !value.startsWith("payload"))) {
      throw new Error(`${where}.expectedPayloadPaths: list every expected compiled payload path`);
    }
    if (correction.status === "APPROVED" && !correction.expectedPayloadPaths.length) throw new Error(`${where}.expectedPayloadPaths: an approved proposal must declare its compiled impact`);
    if (new Set(correction.expectedPayloadPaths).size !== correction.expectedPayloadPaths.length) throw new Error(`${where}.expectedPayloadPaths: duplicate path`);
    if (!Array.isArray(correction.changes) || !correction.changes.length) throw new Error(`${where}.changes: at least one change is required`);

    for (const [index, change] of correction.changes.entries()) {
      const changeWhere = `${where}.changes[${index}]`;
      exactKeys(change, ["file", "operation", "stableKey", "before", "after"], changeWhere);
      if (!FILES[change.file]) throw new Error(`${changeWhere}.file: unknown source file ${JSON.stringify(change.file)}`);
      if (["board-config.json", "scoring.json", "score-meanings.json"].includes(change.file)) throw new Error(`${changeWhere}.file: scoring and board configuration require a separately scoped workflow`);
      if (!["ADD", "AMEND", "RETIRE"].includes(change.operation)) throw new Error(`${changeWhere}.operation: must be ADD, AMEND or RETIRE`);
      const beforeIsAbsent = change.before === ABSENT;
      const afterIsRemove = change.after === REMOVE;
      if (change.operation === "ADD" && (!beforeIsAbsent || afterIsRemove)) throw new Error(`${changeWhere}: ADD needs before ${ABSENT} and an after row`);
      if (change.operation === "AMEND" && (beforeIsAbsent || afterIsRemove)) throw new Error(`${changeWhere}: AMEND needs exact before and after rows`);
      if (change.operation === "RETIRE" && (beforeIsAbsent || !afterIsRemove)) throw new Error(`${changeWhere}: RETIRE needs an exact before row and after ${REMOVE}`);
      const rows = [beforeIsAbsent ? null : change.before, afterIsRemove ? null : change.after].filter(Boolean);
      if (!rows.length || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error(`${changeWhere}: before/after rows must be objects or the explicit sentinels`);
      for (const row of rows) {
        const derived = stableKeyForRow(change.file, row);
        if (!isDeepStrictEqual(derived, change.stableKey)) throw new Error(`${changeWhere}.stableKey: ${JSON.stringify(change.stableKey)} does not match row identity ${JSON.stringify(derived)}`);
      }
      const touchKey = `${change.file}\n${canonicalJson(change.stableKey)}`;
      if (touched.has(touchKey)) throw new Error(`${changeWhere}: overlaps ${touched.get(touchKey)}`);
      touched.set(touchKey, changeWhere);
    }

    if (correction.status === "APPROVED") {
      // The owner's decision is the GitHub link and date. The checksum is
      // tool-generated evidence of the exact approved content, never an owner
      // sign-off. Legacy approvals carry a baseline-bound changeSetChecksum.
      const legacy = Boolean(correction.approval) && Object.hasOwn(correction.approval, "changeSetChecksum");
      exactKeys(correction.approval, ["reference", "decidedAt", legacy ? "changeSetChecksum" : "contentChecksum"], `${where}.approval`);
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+#(?:issue|issuecomment|pullrequestreview)-\d+$/.test(correction.approval.reference ?? "")) {
        throw new Error(`${where}.approval.reference: must link to the exact GitHub issue body, issue comment or pull-request review`);
      }
      nonEmptyString(correction.approval.decidedAt, `${where}.approval.decidedAt`);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(correction.approval.decidedAt)) throw new Error(`${where}.approval.decidedAt: use an ISO UTC timestamp`);
      if (legacy) {
        if (correction.approval.changeSetChecksum !== correctionChecksum(document, correction)) throw new Error(`${where}.approval.changeSetChecksum: does not approve this exact baseline and diff`);
      } else if (correction.approval.contentChecksum !== contentChecksum(correction)) {
        throw new Error(`${where}.approval.contentChecksum: the content changed after it was approved; a new owner decision is needed`);
      }
    } else if (correction.approval !== null) {
      throw new Error(`${where}.approval: must be null unless status is APPROVED`);
    }
  }
}

// Baseline-independent digest of the approved content and intended effect.
// Generated by the tooling to detect post-approval edits; a moved baseline does
// not change it.
function contentChecksum(correction) {
  return `sha256:${sha256(canonicalJson({ id: correction.id, changes: correction.changes, expectedPayloadPaths: [...correction.expectedPayloadPaths].sort() }))}`;
}

// Legacy baseline-bound checksum, retained to verify approvals recorded before #68.
function correctionChecksum(document, correction) {
  return `sha256:${sha256(canonicalJson({ baseline: document.baseline, id: correction.id, changes: correction.changes }))}`;
}

// Apply corrections in memory. Schema-1 migration corrections retain their
// historical omitted-before/after convention. Schema-2 change sets use stable
// keys and explicit ABSENT/REMOVE sentinels. Nothing is written until every
// change in the selected proposal has applied and the caller has validated the
// coherent result.
function applyCorrections(source, corrections) {
  const next = Object.fromEntries(Object.entries(source).map(([file, rows]) => [file, JSON.parse(JSON.stringify(rows))]));
  for (const correction of corrections) {
    for (const [index, change] of correction.changes.entries()) {
      const where = `${correction.id} change ${index + 1} (${change.file})`;
      const rows = next[change.file];
      if (!rows) throw new Error(`${where}: unknown source file`);
      if (change.operation) {
        const matches = rows.map((row, position) => (isDeepStrictEqual(stableKeyForRow(change.file, row), change.stableKey) ? position : -1)).filter((position) => position >= 0);
        if (change.operation === "ADD") {
          if (matches.length !== 0) throw new Error(`${where}: ${JSON.stringify(change.stableKey)} is present; expected ABSENT`);
          rows.push(JSON.parse(JSON.stringify(change.after)));
        } else {
          if (matches.length !== 1) throw new Error(`${where}: stable key matches ${matches.length} rows; expected exactly 1`);
          if (!isDeepStrictEqual(rows[matches[0]], change.before)) throw new Error(`${where}: stale before row for ${JSON.stringify(change.stableKey)}`);
          if (change.operation === "AMEND") rows[matches[0]] = JSON.parse(JSON.stringify(change.after));
          else rows.splice(matches[0], 1);
        }
      } else if (change.before) {
        const matches = rows.map((row, position) => (isDeepStrictEqual(row, change.before) ? position : -1)).filter((position) => position >= 0);
        if (matches.length !== 1) throw new Error(`${where}: "before" matches ${matches.length} rows; expected exactly 1`);
        if (change.after) rows[matches[0]] = JSON.parse(JSON.stringify(change.after));
        else rows.splice(matches[0], 1);
      } else if (change.after) {
        rows.push(JSON.parse(JSON.stringify(change.after)));
      } else {
        throw new Error(`${where}: needs "before", "after" or both`);
      }
      next[change.file] = sortRows(change.file, rows);
    }
  }
  return next;
}

// A correction is applied when every "after" row is present and every
// replaced or deleted "before" row is gone.
function isApplied(source, correction) {
  return correction.changes.every((change) => {
    const rows = source[change.file] ?? [];
    const present = (row) => rows.some((candidate) => isDeepStrictEqual(candidate, row));
    const after = change.after === REMOVE ? null : change.after;
    const before = change.before === ABSENT ? null : change.before;
    if (after && !present(after)) return false;
    if (before && !(after && isDeepStrictEqual(before, after)) && present(before)) return false;
    return true;
  });
}

function readCorrections(file) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  if (document.schema === CHANGE_SET_SCHEMA) validateModernCorrections(document);
  else if (document.schema !== 1 || !Array.isArray(document.corrections)) throw new Error(`Not a correction list: ${file}`);
  return document;
}

module.exports = {
  CATALOGUE_TABS,
  CHANGE_SET_CONTRACT,
  CHANGE_SET_SCHEMA,
  FILES,
  IMPORT_BLOCKERS,
  MATCHUP_MODES,
  RELEASE_CONTRACT,
  SOURCE_SCHEMA,
  applyCorrections,
  auditSource,
  compileSource,
  contentChecksum,
  correctionChecksum,
  formatSourceJson,
  importFromPayload,
  importSnapshot,
  isApplied,
  readCorrections,
  readSource,
  scoreMeaningsFromSnapshot,
  validateModernCorrections,
  validateSource,
  writeSource,
  writeSourceAtomically
};
