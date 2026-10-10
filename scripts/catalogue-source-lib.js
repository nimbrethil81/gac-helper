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

// Apply corrections in memory. Each change names a file and the exact current
// row ("before") it replaces with "after"; insert has no "before", delete no
// "after". A change whose "before" is not found exactly once is refused, so a
// stale or mistyped correction can never land.
function applyCorrections(source, corrections) {
  const next = Object.fromEntries(Object.entries(source).map(([file, rows]) => [file, JSON.parse(JSON.stringify(rows))]));
  for (const correction of corrections) {
    for (const [index, change] of correction.changes.entries()) {
      const where = `${correction.id} change ${index + 1} (${change.file})`;
      const rows = next[change.file];
      if (!rows) throw new Error(`${where}: unknown source file`);
      if (change.before) {
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

function readCorrections(file) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  if (document.schema !== 1 || !Array.isArray(document.corrections)) throw new Error(`Not a correction list: ${file}`);
  return document;
}

module.exports = {
  CATALOGUE_TABS,
  FILES,
  IMPORT_BLOCKERS,
  MATCHUP_MODES,
  RELEASE_CONTRACT,
  SOURCE_SCHEMA,
  applyCorrections,
  auditSource,
  compileSource,
  formatSourceJson,
  importFromPayload,
  importSnapshot,
  readCorrections,
  readSource,
  scoreMeaningsFromSnapshot,
  validateSource,
  writeSource
};
