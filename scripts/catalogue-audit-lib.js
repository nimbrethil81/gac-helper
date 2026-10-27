"use strict";

// Read-only catalogue integrity and parity audit (issue #34, ADR-ARCH-116 §4).
//
// One rule set, two input routes:
//   - a timestamped Sheet snapshot (typed tab grids, optionally with a captured
//     Apps Script action=data response), checked row by row and reconciled
//     against a faithful emulation of apps-script/Code.gs; and
//   - any seven-key action=data compatible payload (a live capture or a
//     compiled Git-native release), checked through the same rules.
//
// Both routes build the same intermediate model, so the Git-native compiler
// (#41) reuses these rules rather than growing a second rule authority.
//
// Nothing here writes to a source, contacts a network service or corrects
// data. Findings are classified, never auto-fixed.

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  REQUIRED_PAYLOAD_KEYS,
  canonicalJson,
  countPayloadDomains,
  parseCsv,
  sha256
} = require("./baseline-lib.js");
const { columnLetters } = require("./xlsx-lib.js");

// ─── constants ───────────────────────────────────────────────────────────────

const SNAPSHOT_KIND = "gac-catalogue-snapshot";
const SNAPSHOT_SCHEMA = 1;
const REPORT_SCHEMA = 1;

// Active catalogue tabs. Personal tabs (Roster, GAC History) are deliberately
// absent: they are never read, extracted or reported.
const CATALOGUE_TABS = Object.freeze([
  "Counters",
  "Counter_Definitions",
  "Counter_Composition",
  "Character_Definitions",
  "Defence_Teams",
  "Defence_Composition",
  "Score_Meanings",
  "GAC_Board_Config",
  "GAC_Scoring"
]);
const EXCLUDED_PERSONAL_TABS = Object.freeze(["Roster", "GAC History"]);

// Header contracts, mirroring how Code.gs reads each tab:
//   header      — read by exact header name, no fallback (Counters);
//   positional  — read by fixed column index regardless of header text;
//   fallback    — read by header name, silently falling back to a fixed index.
const TAB_SPECS = Object.freeze({
  Counters: {
    appsScript: "required",
    access: "header",
    columns: ["Mode", "Defence Team", "Counter_ID", "Counter Team", "Tier", "Banner Score", "Score Meaning", "Undersize", "Notes"],
    derived: ["Counter Team", "Score Meaning"]
  },
  Counter_Definitions: { appsScript: "required", access: "positional", columns: ["Counter_ID", "Counter Team"], optional: ["Strategic_Reserve"] },
  Counter_Composition: { appsScript: "required", access: "positional", columns: ["Counter_ID", "Character_ID", "Role"] },
  Character_Definitions: { appsScript: "required", access: "fallback", columns: ["Character_ID", "Character_Name", "Unit_Type"], optional: ["External_ID"] },
  Defence_Teams: { appsScript: "optional", access: "fallback", columns: ["Defence_Team", "Mode", "Threat"], optional: ["Notes"] },
  Defence_Composition: { appsScript: "optional", access: "fallback", columns: ["Defence_Team", "Mode", "Character_ID"] },
  Score_Meanings: { appsScript: "unread", access: "header", columns: ["Mode", "Score", "Meaning"] },
  GAC_Board_Config: { appsScript: "optional", access: "fallback", columns: ["League", "Mode", "Territory", "Territory_Type", "Team_Count"] },
  GAC_Scoring: { appsScript: "optional", access: "fallback", columns: ["Rule_ID", "Battle_Type", "Mode", "Value"], optional: ["Notes"] }
});

const MATCHUP_MODES = Object.freeze(["5v5", "3v3", "FLEET"]);
const DEFENCE_MODES = Object.freeze(["5v5", "3v3", "FLEET", "ANY"]);
const SQUAD_MODES = Object.freeze(["5v5", "3v3"]);
const TIERS = Object.freeze(["S", "A", "B", "C"]);
// Tactical matchup roles (issues #112/#115): a step in a multi-battle plan, not a
// one-shot win. Such an entry has no tier, banner score or undersize.
const MATCHUP_ROLES = Object.freeze(["SETUP", "CLEANUP"]);
const THREATS = Object.freeze(["EXTREME", "HIGH", "NORMAL", "LOW"]);
const UNIT_TYPES = Object.freeze(["CHARACTER", "SHIP", "CAPITAL_SHIP"]);
const SHIP_TYPES = Object.freeze(["SHIP", "CAPITAL_SHIP"]);
const ROLES = Object.freeze(["REQUIRED", "RECOMMENDED"]);
const LEAGUES = Object.freeze(["KYBER", "AURODIUM", "CHROMIUM", "BRONZIUM", "CARBONITE"]);
const TERRITORIES = Object.freeze(["FRONT_TOP", "FRONT_BOTTOM", "BACK_TOP", "BACK_BOTTOM"]);
const TERRITORY_TYPES = Object.freeze(["SQUAD", "FLEET"]);
const BATTLE_TYPES = Object.freeze(["SQUAD", "FLEET", "ANY"]);
const SCORING_MODES = Object.freeze(["5v5", "3v3", "ANY"]);
const RESERVE_TRUE = Object.freeze(["TRUE", "YES", "Y", "1"]);
const RESERVE_FALSE = Object.freeze(["", "FALSE", "NO", "N", "0"]);

// Derived from catalogue/source/scoring.json and pinned by tests/scoring-rules.test.js:
// full-squad first-attempt ceilings and the unit count per format (undersize can
// drop at most units − 1).
const BANNER_CEILING = Object.freeze({ "5v5": 65, "3v3": 57, FLEET: 73 });
const UNIT_COUNT = Object.freeze({ "5v5": 5, "3v3": 3, FLEET: 7 });

const ID_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const EXTERNAL_ID_PATTERN = /^[A-Z0-9_]+$/;

const SEVERITIES = Object.freeze(["blocking", "owner-approval", "warning", "info"]);

// Every finding code, its severity and what it means. The report prints this
// legend so a reader never has to open the code to interpret a finding.
const RULES = Object.freeze({
  SNAPSHOT_TAB_MISSING: ["blocking", "A tab Apps Script requires is absent; action=data would throw."],
  OPTIONAL_TAB_MISSING: ["warning", "An optional tab is absent; Apps Script returns an empty section."],
  HEADER_MISSING: ["blocking", "An expected header is absent, so Apps Script reads the wrong column or nothing."],
  HEADER_POSITION: ["blocking", "A positionally-read tab has a header in the wrong column."],
  HEADER_DUPLICATE: ["blocking", "A header appears twice; Apps Script reads only one of the columns."],
  HEADER_UNKNOWN: ["warning", "A column Apps Script does not read; its content never reaches the app."],
  FORMULA_ERROR: ["blocking", "A cell evaluates to a spreadsheet error (for example a broken spill)."],
  DERIVED_FORMULA_MISSING: ["blocking", "A Counters derived column has lost its open-ended array formula."],
  DERIVED_FORMULA_RANGE: ["blocking", "Authored Counters rows extend past the derived array formula's range."],
  DERIVED_VALUE_MISMATCH: ["blocking", "A derived Counter Team value disagrees with Counter_Definitions."],
  SCORE_MEANING_MISMATCH: ["warning", "A derived Score Meaning value disagrees with Score_Meanings."],
  UNEXPECTED_FORMULA: ["warning", "A formula exists outside the two documented derived columns."],
  FORMULA_METADATA_UNAVAILABLE: ["info", "The snapshot format (CSV) carries no formula metadata; formula checks were not run."],
  ROW_SKIPPED_INCOMPLETE: ["blocking", "An authored row lacks a key column, so Apps Script silently skips it."],
  COMPOSITION_ROLE_DROPPED: ["blocking", "A composition row's Role is neither REQUIRED nor RECOMMENDED, so Apps Script silently drops it."],
  NONCANONICAL_SPELLING: ["warning", "A value Apps Script normalises (trim/upper-case) is not authored canonically."],
  ID_FORMAT: ["warning", "An identifier is not uppercase with underscores; never renamed automatically."],
  DUPLICATE_UNIT_ID: ["blocking", "Character_ID is not unique; later rows overwrite earlier ones."],
  DUPLICATE_COUNTER_ID: ["blocking", "Counter_ID is not unique; later rows overwrite earlier ones."],
  DUPLICATE_EXTERNAL_ID: ["blocking", "External_ID maps to more than one Character_ID; roster import is ambiguous."],
  EXTERNAL_ID_FORMAT: ["warning", "External_ID does not look like a game base ID."],
  UNIT_NAME_BLANK: ["blocking", "A unit has no display name."],
  UNIT_TYPE_INVALID: ["blocking", "Unit_Type is not CHARACTER, SHIP or CAPITAL_SHIP."],
  REQUIRED_UNIT_NO_EXTERNAL_ID: ["blocking", "A REQUIRED counter member has no External_ID, so imported rosters never own it."],
  COUNTER_NAME_BLANK: ["blocking", "A counter definition has no display name."],
  COUNTER_NAME_DUPLICATE: ["warning", "Two counter definitions share a display name; the exact-name defence fallback becomes ambiguous."],
  STRATEGIC_RESERVE_VALUE: ["warning", "Strategic_Reserve holds an unrecognised value, read as Normal."],
  MATCHUP_COUNTER_NAME_BLANK: ["blocking", "A matchup's displayed counter name is blank."],
  MATCHUP_UNKNOWN_COUNTER: ["blocking", "A matchup references a Counter_ID with no Counter_Definitions row."],
  COMPOSITION_UNKNOWN_COUNTER: ["blocking", "Composition references an undefined Counter_ID; Apps Script synthesises a placeholder named after the ID."],
  COMPOSITION_UNKNOWN_UNIT: ["blocking", "Composition references an undefined Character_ID."],
  COMPOSITION_DUPLICATE_MEMBER: ["blocking", "A unit appears more than once in one counter's composition (duplicate or conflicting role)."],
  COUNTER_UNIT_TYPE_MIXED: ["blocking", "A counter mixes characters with ships."],
  MATCHUP_UNIT_TYPE_MODE: ["blocking", "A FLEET matchup uses a character counter, or a squad matchup uses a ship counter."],
  MATCHUP_MODE_INVALID: ["blocking", "Counters Mode is not exactly 5v5, 3v3 or FLEET; the bucket is unreachable."],
  DUPLICATE_MATCHUP: ["owner-approval", "The logical matchup key (mode, defence, Counter_ID) repeats; choosing the surviving row is an owner decision."],
  TIER_INVALID: ["blocking", "Tier is not exactly S, A, B or C."],
  BANNER_SCORE_INVALID: ["blocking", "Banner Score is not a whole number between 1 and the mode's full-squad ceiling."],
  BANNER_SCORE_NO_MEANING: ["warning", "No Score_Meanings row exists for this mode and Banner Score."],
  UNDERSIZE_NONNUMERIC: ["warning", "Undersize is blank or non-numeric and is read as 0."],
  UNDERSIZE_INVALID: ["blocking", "Undersize is fractional, negative or larger than the format allows."],
  MATCHUP_ROLE_INVALID: ["blocking", "A tactical matchup's role is not exactly SETUP or CLEANUP."],
  MATCHUP_ROLE_SCORED: ["blocking", "A SETUP/CLEANUP matchup carries a tier, banner score or undersize; tactical steps are never ranked or projected as wins."],
  MATCHUP_ROLE_NOTES_BLANK: ["blocking", "A SETUP/CLEANUP matchup has no notes stating its purpose and conditions."],
  MATCHUP_CLEANUP_WITHOUT_SETUP: ["warning", "A defence lists a CLEANUP step but no SETUP step that creates the weakened state it depends on."],
  DEFENCE_MODE_CASE: ["owner-approval", "A defence-tab Mode differs from a valid mode only by case; the app's exact lookup never matches it."],
  DEFENCE_MODE_INVALID: ["blocking", "A defence-tab Mode is not 5v5, 3v3, FLEET or ANY."],
  DEFENCE_MODE_BLANK: ["warning", "A defence-tab Mode is blank and is read as ANY."],
  DEFENCE_TEAM_DUPLICATE: ["blocking", "Defence_Teams repeats a (defence, mode) key; the later row silently wins."],
  THREAT_INVALID: ["blocking", "Threat is not EXTREME, HIGH, NORMAL or LOW and is read as NORMAL."],
  THREAT_BLANK: ["warning", "Threat is blank and is read as NORMAL."],
  DEFENCE_ALIAS_CANDIDATE: ["owner-approval", "A defence-tab name misses every exact Counters lookup in its mode but nearly matches one; never auto-renamed."],
  DEFENCE_NAME_VARIANT: ["warning", "Two Counters defence names in the same mode differ only by case, punctuation or plural."],
  DEFENCE_NAME_CROSS_MODE_VARIANT: ["info", "The same defence is spelled differently in different modes; not assumed to be an error."],
  DEFENCE_ONLY_IDENTITY: ["info", "A defence-tab name has no Counters entry in its mode; legitimate for defence-only/saved identities."],
  DEFENCE_COMPOSITION_UNKNOWN_UNIT: ["blocking", "Defence_Composition references an undefined Character_ID."],
  DEFENCE_COMPOSITION_DUPLICATE_MEMBER: ["warning", "Defence_Composition repeats a member; Apps Script de-duplicates it."],
  DEFENCE_COMPOSITION_UNIT_TYPE: ["blocking", "A squad defence lists ships, or a FLEET defence lists characters."],
  DEFENCE_COMPOSITION_OVERSIZE: ["warning", "A squad defence lists more units than the format fields."],
  DEFENCE_COMPOSITION_FLEET_UNREACHABLE: ["warning", "A FLEET-mode composition is never consulted; the app resolves My Board teams under the round's squad mode or ANY."],
  BOARD_ROW_INVALID: ["blocking", "A GAC_Board_Config row has an invalid league, mode, territory, type or team count."],
  BOARD_DUPLICATE: ["blocking", "GAC_Board_Config repeats a (league, mode, territory) key."],
  BOARD_SHAPE: ["blocking", "A league/mode does not have exactly the four territories, or a league/mode is missing."],
  BOARD_ORDER: ["warning", "Territories are not in Front Top, Front Bottom, Back Top, Back Bottom order."],
  BOARD_FLEET_COUNT: ["warning", "A league/mode does not have exactly one FLEET territory."],
  SCORING_ROW_INVALID: ["blocking", "A GAC_Scoring row has an invalid battle type, mode or value."],
  SCORING_DUPLICATE: ["blocking", "GAC_Scoring repeats a (Rule_ID, Battle_Type, Mode) key."],
  SETTING_DEFENCE: ["blocking", "There is not exactly one positive, finite SETTING_DEFENCE / ANY / ANY rule."],
  SCORING_UNIT_COUNT: ["blocking", "An OWN_UNITS/ENEMY_UNITS row disagrees with the format's unit count."],
  SCORE_MEANING_INVALID: ["warning", "A Score_Meanings row is malformed, duplicated or blank."],
  SENSITIVE_CONTENT: ["blocking", "Credential-, email- or ally-code-shaped content in public catalogue data."],
  PARITY_MISMATCH: ["blocking", "The emulated Code.gs payload differs from the captured action=data response."],
  PAYLOAD_SHAPE: ["blocking", "The payload does not have the seven-key action=data shape."],
  SHIP_PILOTS_INVALID: ["blocking", "Ship crew metadata must use unique canonical character IDs and cover every ship when present."],
  SOURCE_SCHEMA: ["blocking", "A Git-native source file or row does not follow the catalogue/source schema."],
  SOURCE_DUPLICATE: ["blocking", "A Git-native source key repeats; the compiled payload would silently keep only one row."],
  SOURCE_ORDER: ["blocking", "A Git-native source array is not in its required sort order."],
  COUNTER_NO_REQUIRED_MEMBERS: ["info", "A counter has no REQUIRED members (flexible/partial composition); availability is not unit-gated."],
  COUNTER_UNREFERENCED: ["info", "A counter definition is not used by any matchup."],
  UNIT_NO_EXTERNAL_ID: ["info", "A unit has no External_ID; roster import cannot mark it owned."]
});

function rule(code) {
  const entry = RULES[code];
  if (!entry) throw new Error(`Unknown audit rule: ${code}`);
  return { severity: entry[0], description: entry[1] };
}

// ─── small helpers ───────────────────────────────────────────────────────────

const str = (value) => (value === undefined || value === null ? "" : String(value));
const trimmed = (value) => str(value).trim();
const isBlank = (value) => trimmed(value) === "";

// Mirrors Code.gs col(): header index, else a fixed fallback.
function col(headers, name, fallback) {
  const index = headers.indexOf(name);
  return index >= 0 ? index : fallback;
}

// Case, punctuation, diacritics and a trailing plural "s" only. Deliberately
// narrow: "Rey"/"Rex" and other one-letter differences are distinct teams.
function aliasKey(name) {
  return str(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/s$/, "");
}

function rowLocation(tab, rowNumber) {
  return `${tab} row ${rowNumber}`;
}

function jsonValue(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

// ─── snapshot loading ────────────────────────────────────────────────────────

function typedCsvCell(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "TRUE") return true;
  if (value === "FALSE") return false;
  return value;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function verifiedBytes(root, entry, label) {
  const file = path.join(root, entry.file);
  if (path.relative(root, file).startsWith("..")) throw new Error(`${label} path escapes the snapshot: ${entry.file}`);
  const bytes = fs.readFileSync(file);
  if (entry.sha256 && sha256(bytes) !== entry.sha256) throw new Error(`${label} SHA-256 differs from manifest: ${entry.file}`);
  if (entry.bytes !== undefined && bytes.length !== entry.bytes) throw new Error(`${label} byte size differs from manifest: ${entry.file}`);
  return bytes;
}

// Load a catalogue snapshot directory. Two formats are accepted:
//   - gac-catalogue-snapshot (typed tab JSON from scripts/catalogue-snapshot.js);
//   - the ARCH-103 CSV export (data/exports/*), with untyped CSV cells.
function loadSnapshot(directory) {
  const root = path.resolve(directory);
  const manifest = readJsonFile(path.join(root, "manifest.json"));

  if (manifest.kind === SNAPSHOT_KIND) {
    if (manifest.schema !== SNAPSHOT_SCHEMA) throw new Error(`Unsupported snapshot schema: ${manifest.schema}`);
    const tabs = {};
    for (const entry of manifest.tabs) {
      if (!CATALOGUE_TABS.includes(entry.tab)) throw new Error(`Snapshot contains a non-catalogue tab: ${entry.tab}`);
      const tab = JSON.parse(verifiedBytes(root, entry, "Tab").toString("utf8"));
      tabs[entry.tab] = { grid: tab.grid, formulas: tab.formulas ?? [], errors: tab.errors ?? [], typed: true, formulaMetadata: true };
    }
    let actionData = null;
    if (manifest.actionData) {
      actionData = {
        capturedAt: manifest.actionData.capturedAt,
        payload: JSON.parse(verifiedBytes(root, manifest.actionData, "action=data capture").toString("utf8"))
      };
    }
    return { directory: root, format: SNAPSHOT_KIND, capturedAt: manifest.capturedAt, source: manifest.source ?? {}, tabs, actionData };
  }

  if (manifest.schemaVersion === 1 && Array.isArray(manifest.sheetExports)) {
    const tabs = {};
    for (const sheet of manifest.sheetExports) {
      const bytes = verifiedBytes(root, { file: sheet.filename, sha256: sheet.sha256, bytes: sheet.byteSize }, "CSV tab");
      const grid = parseCsv(bytes.toString("utf8")).map((row, index) => (index === 0 ? row : row.map(typedCsvCell)));
      tabs[sheet.tabName] = { grid, formulas: [], errors: [], typed: false, formulaMetadata: false };
    }
    const payload = manifest.appsScriptPayload;
    const raw = verifiedBytes(root, { file: payload.rawFilename, sha256: payload.rawSha256, bytes: payload.rawByteSize }, "action=data capture");
    return {
      directory: root,
      format: "arch-103-csv-export",
      capturedAt: manifest.captureTimestamp,
      source: { method: "csv-export" },
      tabs,
      actionData: { capturedAt: manifest.captureTimestamp, payload: JSON.parse(raw.toString("utf8")) }
    };
  }

  throw new Error(`Unrecognised snapshot manifest in ${root}`);
}

// ─── Apps Script emulation (apps-script/Code.gs buildDataPayload) ─────────────
//
// A line-for-line port operating on getDataRange().getValues()-shaped grids.
// Keep it in lock-step with Code.gs: parity findings are only meaningful while
// this is faithful.

function parseUndersize(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function parseReserveFlag(raw) {
  if (raw === true) return true;
  return RESERVE_TRUE.indexOf(String(raw).trim().toUpperCase()) >= 0;
}

function emulateActionData(tabs) {
  for (const name of ["Counters", "Counter_Definitions", "Counter_Composition", "Character_Definitions"]) {
    if (!tabs[name]) return { error: `Apps Script would throw: required tab ${name} is missing` };
  }
  const countersData = tabs.Counters.grid;
  const counterDefsData = tabs.Counter_Definitions.grid;
  const counterCompData = tabs.Counter_Composition.grid;
  const characterDefsData = tabs.Character_Definitions.grid;

  const output = {
    counters: { "5v5": {}, "3v3": {} },
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };

  const counterHeaders = countersData[0] ?? [];
  for (let i = 1; i < countersData.length; i++) {
    const row = countersData[i];
    const entry = {};
    counterHeaders.forEach((h, idx) => { entry[h] = row[idx]; });
    const counterId = String(entry["Counter_ID"] || "").trim();
    const mode = String(entry["Mode"] || "").trim();
    const team = String(entry["Defence Team"] || "").trim();
    if (!counterId || !mode || !team) continue;
    if (!output.counters[mode]) output.counters[mode] = {};
    if (!output.counters[mode][team]) output.counters[mode][team] = [];
    output.counters[mode][team].push({
      counterId,
      counter: entry["Counter Team"],
      tier: entry["Tier"],
      bannerScore: entry["Banner Score"],
      undersize: parseUndersize(entry["Undersize"]),
      notes: entry["Notes"]
    });
  }

  const counterDefsHeaders = counterDefsData[0] ?? [];
  const cdReserve = counterDefsHeaders.indexOf("Strategic_Reserve");
  for (let i = 1; i < counterDefsData.length; i++) {
    const row = counterDefsData[i];
    const counterId = String(row[0]).trim();
    if (!counterId) continue;
    output.counterDefinitions[counterId] = { name: String(row[1]).trim(), required: [], recommended: [] };
    if (cdReserve >= 0 && parseReserveFlag(row[cdReserve])) output.counterDefinitions[counterId].strategicReserve = true;
  }

  for (let i = 1; i < counterCompData.length; i++) {
    const row = counterCompData[i];
    const counterId = String(row[0]).trim();
    const characterId = String(row[1]).trim();
    const role = String(row[2]).trim().toUpperCase();
    if (!counterId || !characterId) continue;
    if (!output.counterDefinitions[counterId]) output.counterDefinitions[counterId] = { name: counterId, required: [], recommended: [] };
    if (role === "REQUIRED") output.counterDefinitions[counterId].required.push(characterId);
    else if (role === "RECOMMENDED") output.counterDefinitions[counterId].recommended.push(characterId);
  }

  const charHeaders = characterDefsData[0] ?? [];
  const cId = col(charHeaders, "Character_ID", 0);
  const cName = col(charHeaders, "Character_Name", 1);
  const cType = col(charHeaders, "Unit_Type", 2);
  const cExt = charHeaders.indexOf("External_ID");
  for (let i = 1; i < characterDefsData.length; i++) {
    const row = characterDefsData[i];
    const characterId = String(row[cId]).trim();
    if (!characterId) continue;
    output.characterDefinitions[characterId] = {
      name: String(row[cName]).trim(),
      unitType: String(row[cType]).trim().toUpperCase(),
      externalId: cExt >= 0 ? String(row[cExt]).trim() : ""
    };
  }

  output.boardConfig = emulateBoardConfig(tabs.GAC_Board_Config);
  output.scoring = emulateScoring(tabs.GAC_Scoring);
  output.defenceTeams = emulateDefenceTeams(tabs.Defence_Teams);
  output.defenceCompositions = emulateDefenceCompositions(tabs.Defence_Composition);
  return output;
}

function emulateBoardConfig(tab) {
  if (!tab) return {};
  const data = tab.grid;
  if (data.length < 2) return {};
  const headers = data[0];
  const cLeague = col(headers, "League", 0);
  const cMode = col(headers, "Mode", 1);
  const cTerritory = col(headers, "Territory", 2);
  const cType = col(headers, "Territory_Type", 3);
  const cCount = col(headers, "Team_Count", 4);
  const config = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const league = String(row[cLeague]).trim().toUpperCase();
    const mode = String(row[cMode]).trim();
    const territory = String(row[cTerritory]).trim().toUpperCase();
    const type = String(row[cType]).trim().toUpperCase();
    const count = Number(row[cCount]);
    if (!league || !mode || !territory) continue;
    if (!config[league]) config[league] = {};
    if (!config[league][mode]) config[league][mode] = [];
    config[league][mode].push({ territory, type, teamCount: isNaN(count) ? 0 : count });
  }
  return config;
}

function emulateScoring(tab) {
  if (!tab) return [];
  const data = tab.grid;
  if (data.length < 2) return [];
  const headers = data[0];
  const cRule = col(headers, "Rule_ID", 0);
  const cBType = col(headers, "Battle_Type", 1);
  const cMode = col(headers, "Mode", 2);
  const cValue = col(headers, "Value", 3);
  const cNotes = headers.indexOf("Notes");
  const rules = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const ruleId = String(row[cRule]).trim().toUpperCase();
    if (!ruleId) continue;
    const value = Number(row[cValue]);
    rules.push({
      ruleId,
      battleType: String(row[cBType]).trim().toUpperCase(),
      mode: String(row[cMode]).trim(),
      value: isNaN(value) ? 0 : value,
      notes: cNotes >= 0 ? String(row[cNotes]).trim() : ""
    });
  }
  return rules;
}

function emulateDefenceTeams(tab) {
  if (!tab) return {};
  const data = tab.grid;
  if (data.length < 2) return {};
  const headers = data[0];
  const cTeam = col(headers, "Defence_Team", 0);
  const cMode = col(headers, "Mode", 1);
  const cThreat = col(headers, "Threat", 2);
  const cNotes = headers.indexOf("Notes");
  const teams = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const team = String(row[cTeam]).trim();
    if (!team) continue;
    const modeRaw = String(row[cMode]).trim();
    const mode = modeRaw ? modeRaw : "ANY";
    if (!teams[mode]) teams[mode] = {};
    teams[mode][team] = {
      threat: String(row[cThreat]).trim().toUpperCase(),
      notes: cNotes >= 0 ? String(row[cNotes]).trim() : ""
    };
  }
  return teams;
}

function emulateDefenceCompositions(tab) {
  if (!tab) return {};
  const data = tab.grid;
  if (data.length < 2) return {};
  const headers = data[0];
  const cTeam = col(headers, "Defence_Team", 0);
  const cMode = col(headers, "Mode", 1);
  const cChar = col(headers, "Character_ID", 2);
  const compositions = {};
  for (let i = 1; i < data.length; i++) {
    const team = String(data[i][cTeam] || "").trim();
    const mode = String(data[i][cMode] || "ANY").trim() || "ANY";
    const characterId = String(data[i][cChar] || "").trim();
    if (!team || !characterId) continue;
    if (!compositions[mode]) compositions[mode] = {};
    if (!compositions[mode][team]) compositions[mode][team] = [];
    if (compositions[mode][team].indexOf(characterId) < 0) compositions[mode][team].push(characterId);
  }
  return compositions;
}

// ─── parity ──────────────────────────────────────────────────────────────────

function diffValues(expected, actual, at, out) {
  if (isDeepStrictEqual(expected, actual)) return;
  const bothObjects = expected && actual && typeof expected === "object" && typeof actual === "object" &&
    Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) {
    out.push({ path: at, expected, actual });
    return;
  }
  if (Array.isArray(expected)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) diffValues(expected[index], actual[index], `${at}[${index}]`, out);
    return;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) diffValues(expected[key], actual[key], `${at}[${JSON.stringify(key)}]`, out);
}

// Compare semantically (key order is not meaningful, array order is), exactly
// like the ADR-ARCH-116 canonical-JSON equivalence.
function diffPayloads(expected, actual) {
  const out = [];
  diffValues(JSON.parse(canonicalJson(expected)), JSON.parse(canonicalJson(actual)), "payload", out);
  return out;
}

function payloadChecksum(payload) {
  const legacy = Object.fromEntries(REQUIRED_PAYLOAD_KEYS.map((key) => [key, payload[key]]));
  return `sha256:${sha256(canonicalJson(legacy))}`;
}

// ─── model construction ──────────────────────────────────────────────────────

function emptyModel(sourceKind) {
  return {
    sourceKind,
    units: [],
    counters: [],
    members: [],
    matchups: [],
    defenceTeams: [],
    defenceCompositions: [],
    board: [],
    scoring: [],
    scoreMeanings: []
  };
}

function headerFindings(tabName, headers, add) {
  const spec = TAB_SPECS[tabName];
  const seen = new Map();
  headers.forEach((header, index) => {
    if (header === "") return;
    if (seen.has(header)) {
      add("HEADER_DUPLICATE", { location: `${tabName} header`, subject: header, observed: `columns ${seen.get(header) + 1} and ${index + 1}`, expected: "one column per header" });
    } else seen.set(header, index);
  });
  spec.columns.forEach((header, index) => {
    const at = headers.indexOf(header);
    if (at < 0) {
      const effect = spec.access === "header"
        ? (spec.appsScript === "unread" ? "Score Meaning formula lookups fail" : "Apps Script reads the field as empty for every row")
        : `Apps Script silently reads column ${index + 1} (${jsonValue(headers[index])}) instead`;
      add("HEADER_MISSING", { location: `${tabName} header`, subject: header, observed: jsonValue(headers), expected: `header ${JSON.stringify(header)}`, effect });
    } else if (spec.access === "positional" && at !== index) {
      add("HEADER_POSITION", { location: `${tabName} header`, subject: header, observed: `column ${at + 1}`, expected: `column ${index + 1}`, effect: `Apps Script reads column ${index + 1} as ${header}` });
    }
  });
  headers.forEach((header, index) => {
    if (header === "" || spec.columns.includes(header) || (spec.optional ?? []).includes(header)) return;
    add("HEADER_UNKNOWN", { location: `${tabName} column ${index + 1}`, subject: header, observed: JSON.stringify(header), expected: "a documented column", effect: "Column content never reaches action=data" });
  });
}

// The snapshot model keeps raw cell values, so rules can tell canonical
// spellings from ones Apps Script happens to normalise.
function modelFromSnapshot(snapshot, add) {
  const model = emptyModel("sheets");
  const { tabs } = snapshot;

  for (const name of CATALOGUE_TABS) {
    const tab = tabs[name];
    if (!tab) {
      const required = TAB_SPECS[name].appsScript === "required";
      add(required ? "SNAPSHOT_TAB_MISSING" : "OPTIONAL_TAB_MISSING", { location: name, subject: name, observed: "absent", expected: "tab present" });
      continue;
    }
    headerFindings(name, (tab.grid[0] ?? []).map(str), add);
    for (const error of tab.errors) {
      add("FORMULA_ERROR", { location: `${name}!${error.cell}`, observed: jsonValue(error.value), expected: "a value", effect: "Error text is served as data or breaks a derived column" });
    }
  }

  const rows = (name) => {
    const tab = tabs[name];
    if (!tab) return { headers: [], body: [] };
    const headers = (tab.grid[0] ?? []).map(str);
    const body = tab.grid.slice(1).map((cells, index) => ({ cells, rowNumber: index + 2 }));
    return { headers, body };
  };
  const field = (headers, cells, name, fallback) => {
    const index = fallback === undefined ? headers.indexOf(name) : col(headers, name, fallback);
    return index >= 0 ? cells[index] : undefined;
  };
  const authored = (values) => values.some((value) => !isBlank(value));

  // Character_Definitions
  {
    const { headers, body } = rows("Character_Definitions");
    const hasExternal = headers.includes("External_ID");
    for (const { cells, rowNumber } of body) {
      const id = field(headers, cells, "Character_ID", 0);
      const name = field(headers, cells, "Character_Name", 1);
      const unitType = field(headers, cells, "Unit_Type", 2);
      const externalId = hasExternal ? field(headers, cells, "External_ID") : "";
      const at = rowLocation("Character_Definitions", rowNumber);
      if (isBlank(id)) {
        if (authored([name, unitType, externalId])) add("ROW_SKIPPED_INCOMPLETE", { location: at, observed: jsonValue(cells), expected: "Character_ID present", effect: "Unit silently absent from characterDefinitions" });
        continue;
      }
      model.units.push({ id, name, unitType, externalId, at });
    }
  }

  // Counter_Definitions (positional, like Code.gs)
  {
    const { headers, body } = rows("Counter_Definitions");
    const reserveIndex = headers.indexOf("Strategic_Reserve");
    for (const { cells, rowNumber } of body) {
      const at = rowLocation("Counter_Definitions", rowNumber);
      if (isBlank(cells[0])) {
        if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, observed: jsonValue(cells), expected: "Counter_ID present", effect: "Counter definition silently absent" });
        continue;
      }
      model.counters.push({ id: cells[0], name: cells[1], strategicReserve: reserveIndex >= 0 ? cells[reserveIndex] : undefined, at });
    }
  }

  // Counter_Composition (positional)
  for (const { cells, rowNumber } of rows("Counter_Composition").body) {
    const at = rowLocation("Counter_Composition", rowNumber);
    if (isBlank(cells[0]) || isBlank(cells[1])) {
      if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, observed: jsonValue(cells), expected: "Counter_ID and Character_ID present", effect: "Member silently absent from its counter" });
      continue;
    }
    model.members.push({ counterId: cells[0], unitId: cells[1], role: cells[2], at });
  }

  // Counters (by header name)
  {
    const { headers, body } = rows("Counters");
    const authoredColumns = TAB_SPECS.Counters.columns.filter((name) => !TAB_SPECS.Counters.derived.includes(name));
    for (const { cells, rowNumber } of body) {
      const value = (name) => field(headers, cells, name);
      const at = rowLocation("Counters", rowNumber);
      if (isBlank(value("Counter_ID")) || isBlank(value("Mode")) || isBlank(value("Defence Team"))) {
        if (authored(authoredColumns.map(value))) {
          add("ROW_SKIPPED_INCOMPLETE", {
            location: at,
            mode: trimmed(value("Mode")),
            observed: jsonValue(Object.fromEntries(authoredColumns.map((name) => [name, value(name) ?? ""]))),
            expected: "Mode, Defence Team and Counter_ID all present",
            effect: "Matchup silently absent from counters"
          });
        }
        continue;
      }
      model.matchups.push({
        mode: value("Mode"),
        defence: value("Defence Team"),
        counterId: value("Counter_ID"),
        counterName: value("Counter Team"),
        tier: value("Tier"),
        bannerScore: value("Banner Score"),
        scoreMeaning: value("Score Meaning"),
        undersize: value("Undersize"),
        notes: value("Notes"),
        at,
        rowNumber
      });
    }
  }

  // Defence_Teams
  {
    const { headers, body } = rows("Defence_Teams");
    const notesIndex = headers.indexOf("Notes");
    for (const { cells, rowNumber } of body) {
      const defence = field(headers, cells, "Defence_Team", 0);
      const mode = field(headers, cells, "Mode", 1);
      const threat = field(headers, cells, "Threat", 2);
      const at = rowLocation("Defence_Teams", rowNumber);
      if (isBlank(defence)) {
        if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, mode: trimmed(mode), observed: jsonValue(cells), expected: "Defence_Team present", effect: "Threat rating silently absent" });
        continue;
      }
      model.defenceTeams.push({ defence, mode, threat, notes: notesIndex >= 0 ? cells[notesIndex] : "", at });
    }
  }

  // Defence_Composition
  {
    const { headers, body } = rows("Defence_Composition");
    for (const { cells, rowNumber } of body) {
      const defence = field(headers, cells, "Defence_Team", 0);
      const mode = field(headers, cells, "Mode", 1);
      const unitId = field(headers, cells, "Character_ID", 2);
      const at = rowLocation("Defence_Composition", rowNumber);
      if (isBlank(defence) || isBlank(unitId)) {
        if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, mode: trimmed(mode), observed: jsonValue(cells), expected: "Defence_Team and Character_ID present", effect: "Defence member silently absent" });
        continue;
      }
      model.defenceCompositions.push({ defence, mode, unitId, at });
    }
  }

  // GAC_Board_Config
  {
    const { headers, body } = rows("GAC_Board_Config");
    for (const { cells, rowNumber } of body) {
      const league = field(headers, cells, "League", 0);
      const mode = field(headers, cells, "Mode", 1);
      const territory = field(headers, cells, "Territory", 2);
      const type = field(headers, cells, "Territory_Type", 3);
      const teamCount = field(headers, cells, "Team_Count", 4);
      const at = rowLocation("GAC_Board_Config", rowNumber);
      if (isBlank(league) || isBlank(mode) || isBlank(territory)) {
        if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, mode: trimmed(mode), observed: jsonValue(cells), expected: "League, Mode and Territory present", effect: "Territory silently absent from boardConfig" });
        continue;
      }
      model.board.push({ league, mode, territory, type, teamCount, at });
    }
  }

  // GAC_Scoring
  {
    const { headers, body } = rows("GAC_Scoring");
    const notesIndex = headers.indexOf("Notes");
    for (const { cells, rowNumber } of body) {
      const ruleId = field(headers, cells, "Rule_ID", 0);
      const at = rowLocation("GAC_Scoring", rowNumber);
      if (isBlank(ruleId)) {
        if (authored(cells)) add("ROW_SKIPPED_INCOMPLETE", { location: at, observed: jsonValue(cells), expected: "Rule_ID present", effect: "Scoring rule silently absent" });
        continue;
      }
      model.scoring.push({
        ruleId,
        battleType: field(headers, cells, "Battle_Type", 1),
        mode: field(headers, cells, "Mode", 2),
        value: field(headers, cells, "Value", 3),
        notes: notesIndex >= 0 ? cells[notesIndex] : "",
        at
      });
    }
  }

  // Score_Meanings (authoring-only; never read by Apps Script)
  {
    const { headers, body } = rows("Score_Meanings");
    for (const { cells, rowNumber } of body) {
      const mode = field(headers, cells, "Mode");
      const score = field(headers, cells, "Score");
      const meaning = field(headers, cells, "Meaning");
      if (!authored([mode, score, meaning])) continue;
      model.scoreMeanings.push({ mode, score, meaning, at: rowLocation("Score_Meanings", rowNumber) });
    }
  }

  return model;
}

// Build the same model from any seven-key payload (a live action=data capture
// or a compiled Git-native release). Sheet-only facts (row positions, headers,
// formulas, skipped rows) do not exist here and are simply not checked.
function modelFromPayload(payload, add) {
  const model = emptyModel("payload");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    add("PAYLOAD_SHAPE", { location: "payload", observed: typeof payload, expected: "object" });
    return model;
  }
  for (const key of REQUIRED_PAYLOAD_KEYS) {
    const value = payload[key];
    const ok = key === "scoring" ? Array.isArray(value) : value && typeof value === "object" && !Array.isArray(value);
    if (!ok) add("PAYLOAD_SHAPE", { location: `payload.${key}`, observed: jsonValue(value === undefined ? undefined : Array.isArray(value) ? "array" : typeof value), expected: key === "scoring" ? "array" : "object" });
  }
  const extra = Object.keys(payload).filter((key) => !REQUIRED_PAYLOAD_KEYS.includes(key) && key !== "release");
  if (extra.length) add("PAYLOAD_SHAPE", { location: "payload", observed: jsonValue(extra), expected: "only the seven action=data keys (plus optional release metadata)" });

  const objectEntries = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

  for (const [id, unit] of objectEntries(payload.characterDefinitions)) {
    model.units.push({ id, name: unit?.name, unitType: unit?.unitType, externalId: unit?.externalId, pilotIds: unit?.pilotIds, at: `characterDefinitions[${JSON.stringify(id)}]` });
  }
  for (const [id, definition] of objectEntries(payload.counterDefinitions)) {
    const at = `counterDefinitions[${JSON.stringify(id)}]`;
    model.counters.push({ id, name: definition?.name, strategicReserve: definition?.strategicReserve, at });
    for (const role of ["required", "recommended"]) {
      (Array.isArray(definition?.[role]) ? definition[role] : []).forEach((unitId, index) => {
        model.members.push({ counterId: id, unitId, role: role.toUpperCase(), at: `${at}.${role}[${index}]` });
      });
    }
  }
  for (const [mode, teams] of objectEntries(payload.counters)) {
    for (const [defence, entries] of objectEntries(teams)) {
      (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
        model.matchups.push({
          mode,
          defence,
          counterId: entry?.counterId,
          counterName: entry?.counter,
          role: entry?.role,
          tier: entry?.tier,
          bannerScore: entry?.bannerScore,
          undersize: entry?.undersize,
          notes: entry?.notes,
          at: `counters[${JSON.stringify(mode)}][${JSON.stringify(defence)}][${index}]`
        });
      });
    }
  }
  for (const [mode, teams] of objectEntries(payload.defenceTeams)) {
    for (const [defence, value] of objectEntries(teams)) {
      model.defenceTeams.push({ defence, mode, threat: value?.threat, notes: value?.notes, at: `defenceTeams[${JSON.stringify(mode)}][${JSON.stringify(defence)}]` });
    }
  }
  for (const [mode, teams] of objectEntries(payload.defenceCompositions)) {
    for (const [defence, units] of objectEntries(teams)) {
      (Array.isArray(units) ? units : []).forEach((unitId, index) => {
        model.defenceCompositions.push({ defence, mode, unitId, at: `defenceCompositions[${JSON.stringify(mode)}][${JSON.stringify(defence)}][${index}]` });
      });
    }
  }
  for (const [league, modes] of objectEntries(payload.boardConfig)) {
    for (const [mode, territories] of objectEntries(modes)) {
      (Array.isArray(territories) ? territories : []).forEach((row, index) => {
        model.board.push({ league, mode, territory: row?.territory, type: row?.type, teamCount: row?.teamCount, at: `boardConfig.${league}[${JSON.stringify(mode)}][${index}]` });
      });
    }
  }
  (Array.isArray(payload.scoring) ? payload.scoring : []).forEach((row, index) => {
    model.scoring.push({ ruleId: row?.ruleId, battleType: row?.battleType, mode: row?.mode, value: row?.value, notes: row?.notes, at: `scoring[${index}]` });
  });
  return model;
}

// ─── rules ───────────────────────────────────────────────────────────────────

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Report a value Apps Script normalises (trim + upper-case) but that is not
// authored canonically. Returns the normalised value for further checks.
function canonicalEnum(value, allowed, add, context, { upper = true } = {}) {
  const normal = upper ? trimmed(value).toUpperCase() : trimmed(value);
  if (allowed.includes(normal) && str(value) !== normal) {
    add("NONCANONICAL_SPELLING", { ...context, observed: jsonValue(value), expected: JSON.stringify(normal), effect: "None today (Apps Script normalises it); not a legal Git-native source value" });
  }
  return normal;
}

function checkUnits(model, add) {
  const byId = groupBy(model.units, (unit) => trimmed(unit.id));
  for (const [id, units] of byId) {
    if (units.length > 1) add("DUPLICATE_UNIT_ID", { location: units.map((unit) => unit.at).join("; "), subject: id, observed: `${units.length} rows`, expected: "1 row", effect: "Only the last row reaches characterDefinitions" });
  }
  const byExternal = groupBy(model.units.filter((unit) => !isBlank(unit.externalId)), (unit) => trimmed(unit.externalId));
  for (const [externalId, units] of byExternal) {
    if (units.length > 1) add("DUPLICATE_EXTERNAL_ID", { location: units.map((unit) => unit.at).join("; "), subject: externalId, observed: units.map((unit) => trimmed(unit.id)).join(", "), expected: "one Character_ID per External_ID", effect: "Roster import marks several units owned from one game unit" });
  }
  const hasCrew = model.units.some(unit => unit.pilotIds !== undefined);
  for (const unit of model.units) {
    const context = { location: unit.at, subject: trimmed(unit.id) };
    const ship = ["SHIP", "CAPITAL_SHIP"].includes(unit.unitType);
    if ((hasCrew && ship && unit.pilotIds === undefined) || (unit.pilotIds !== undefined &&
        (!ship || !Array.isArray(unit.pilotIds) || new Set(unit.pilotIds).size !== unit.pilotIds.length ||
         unit.pilotIds.some(id => typeof id !== "string" || !byId.has(id) || byId.get(id).length !== 1 || byId.get(id)[0].unitType !== "CHARACTER")))) {
      add("SHIP_PILOTS_INVALID", { ...context, observed: jsonValue(unit.pilotIds), expected: "unique canonical CHARACTER IDs on every ship; [] explicitly means pilotless" });
    }
    if (str(unit.id) !== trimmed(unit.id)) add("NONCANONICAL_SPELLING", { ...context, observed: jsonValue(unit.id), expected: JSON.stringify(trimmed(unit.id)), effect: "None today (trimmed by Apps Script)" });
    if (!ID_PATTERN.test(trimmed(unit.id))) add("ID_FORMAT", { ...context, observed: jsonValue(trimmed(unit.id)), expected: "UPPER_SNAKE_CASE", effect: "None; stable IDs are never renamed automatically" });
    if (isBlank(unit.name)) add("UNIT_NAME_BLANK", { ...context, observed: jsonValue(unit.name), expected: "a display name", effect: "Roster and composition screens show a blank unit" });
    const type = canonicalEnum(unit.unitType, UNIT_TYPES, add, context);
    if (!UNIT_TYPES.includes(type)) add("UNIT_TYPE_INVALID", { ...context, observed: jsonValue(unit.unitType), expected: UNIT_TYPES.join(" | "), effect: "Unit is misclassified on the roster screen and in availability" });
    if (isBlank(unit.externalId)) add("UNIT_NO_EXTERNAL_ID", { ...context, observed: jsonValue(unit.externalId ?? ""), expected: "game base ID" });
    else if (!EXTERNAL_ID_PATTERN.test(trimmed(unit.externalId))) add("EXTERNAL_ID_FORMAT", { ...context, observed: jsonValue(unit.externalId), expected: "uppercase game base ID", effect: "Roster import may never match this unit" });
  }
}

function checkCounters(model, add, units) {
  const byId = groupBy(model.counters, (counter) => trimmed(counter.id));
  for (const [id, counters] of byId) {
    if (counters.length > 1) add("DUPLICATE_COUNTER_ID", { location: counters.map((counter) => counter.at).join("; "), subject: id, observed: `${counters.length} rows`, expected: "1 row", effect: "Only the last definition's name and reserve flag survive" });
  }
  const byName = groupBy(model.counters.filter((counter) => !isBlank(counter.name)), (counter) => trimmed(counter.name));
  for (const [name, counters] of byName) {
    if (counters.length > 1) add("COUNTER_NAME_DUPLICATE", { location: counters.map((counter) => counter.at).join("; "), subject: name, observed: counters.map((counter) => trimmed(counter.id)).join(", "), expected: "distinct display names", effect: "Exact-name defence-composition fallback cannot resolve this name" });
  }
  for (const counter of model.counters) {
    const context = { location: counter.at, subject: trimmed(counter.id) };
    if (str(counter.id) !== trimmed(counter.id)) add("NONCANONICAL_SPELLING", { ...context, observed: jsonValue(counter.id), expected: JSON.stringify(trimmed(counter.id)), effect: "None today (trimmed by Apps Script)" });
    if (!ID_PATTERN.test(trimmed(counter.id))) add("ID_FORMAT", { ...context, observed: jsonValue(trimmed(counter.id)), expected: "UPPER_SNAKE_CASE", effect: "None; stable IDs are never renamed automatically" });
    if (isBlank(counter.name)) add("COUNTER_NAME_BLANK", { ...context, observed: jsonValue(counter.name), expected: "a display name", effect: "Counter cards and used-team tracking show a blank name" });
    const reserve = counter.strategicReserve;
    if (reserve !== undefined && reserve !== true && reserve !== false) {
      const normal = trimmed(reserve).toUpperCase();
      if (!RESERVE_TRUE.includes(normal) && !RESERVE_FALSE.includes(normal)) {
        add("STRATEGIC_RESERVE_VALUE", { ...context, observed: jsonValue(reserve), expected: "TRUE/YES/Y/1, or blank/FALSE/NO/N/0", effect: "Read as Normal reserve" });
      }
    }
  }

  // Membership
  const counterIds = new Set(model.counters.map((counter) => trimmed(counter.id)));
  const synthesised = new Map();
  for (const member of model.members) {
    const counterId = trimmed(member.counterId);
    const unitId = trimmed(member.unitId);
    const context = { location: member.at, subject: `${counterId} / ${unitId}` };
    const role = model.sourceKind === "sheets" ? canonicalEnum(member.role, ROLES, add, context) : member.role;
    if (!ROLES.includes(role)) add("COMPOSITION_ROLE_DROPPED", { ...context, observed: jsonValue(member.role), expected: ROLES.join(" | "), effect: `${unitId} is silently missing from ${counterId}` });
    if (!counterIds.has(counterId)) {
      if (!synthesised.has(counterId)) synthesised.set(counterId, []);
      synthesised.get(counterId).push(member);
    }
    if (!units.has(unitId)) add("COMPOSITION_UNKNOWN_UNIT", { ...context, observed: unitId, expected: "a Character_Definitions Character_ID", effect: "Availability can never be satisfied for this member" });
  }
  for (const [counterId, members] of synthesised) {
    add("COMPOSITION_UNKNOWN_COUNTER", {
      location: members.map((member) => member.at).join("; "),
      subject: counterId,
      observed: `${members.length} composition row(s), no Counter_Definitions row`,
      expected: "a Counter_Definitions row",
      effect: `Apps Script synthesises counterDefinitions[${JSON.stringify(counterId)}] with name ${JSON.stringify(counterId)}`
    });
  }
  for (const [key, members] of groupBy(model.members, (member) => `${trimmed(member.counterId)}\u0000${trimmed(member.unitId)}`)) {
    if (members.length < 2) continue;
    const [counterId, unitId] = key.split("\u0000");
    const roles = members.map((member) => trimmed(member.role).toUpperCase());
    add("COMPOSITION_DUPLICATE_MEMBER", { location: members.map((member) => member.at).join("; "), subject: `${counterId} / ${unitId}`, observed: roles.join(" + "), expected: "one role per unit per counter", effect: "Unit is listed twice in counterDefinitions" });
  }
}

// Unit types of a counter's members, used for FLEET/squad compatibility.
function counterUnitTypes(model, units) {
  const types = new Map();
  for (const member of model.members) {
    const unit = units.get(trimmed(member.unitId));
    if (!unit) continue;
    const counterId = trimmed(member.counterId);
    if (!types.has(counterId)) types.set(counterId, new Set());
    types.get(counterId).add(trimmed(unit.unitType).toUpperCase());
  }
  return types;
}

function checkCounterComposition(model, add, units) {
  const types = counterUnitTypes(model, units);
  for (const [counterId, set] of types) {
    const hasCharacter = set.has("CHARACTER");
    const hasShip = SHIP_TYPES.some((type) => set.has(type));
    if (hasCharacter && hasShip) add("COUNTER_UNIT_TYPE_MIXED", { location: `counter ${counterId}`, subject: counterId, observed: [...set].sort().join(", "), expected: "characters only, or ships only", effect: "Counter cannot be valid in both squad and FLEET modes" });
  }
  const required = new Set(model.members.filter((member) => trimmed(member.role).toUpperCase() === "REQUIRED").map((member) => trimmed(member.counterId)));
  const used = new Set(model.matchups.map((matchup) => trimmed(matchup.counterId)));
  for (const counter of model.counters) {
    const id = trimmed(counter.id);
    if (!required.has(id)) add("COUNTER_NO_REQUIRED_MEMBERS", { location: counter.at, subject: id, observed: "0 REQUIRED members", expected: "legitimate when the composition is flexible or partial" });
    if (!used.has(id)) add("COUNTER_UNREFERENCED", { location: counter.at, subject: id, observed: "no matchup", expected: "informational" });
  }
  for (const member of model.members) {
    if (trimmed(member.role).toUpperCase() !== "REQUIRED") continue;
    const unit = units.get(trimmed(member.unitId));
    if (unit && isBlank(unit.externalId)) {
      add("REQUIRED_UNIT_NO_EXTERNAL_ID", { location: `${member.at}; ${unit.at}`, subject: `${trimmed(member.counterId)} / ${trimmed(member.unitId)}`, observed: "External_ID blank", expected: "game base ID sourced from Comlink", effect: `${trimmed(member.counterId)} is never available from an imported roster` });
    }
  }
}

function checkMatchups(model, add, units, scoreMeanings) {
  const counterById = new Map(model.counters.map((counter) => [trimmed(counter.id), counter]));
  const memberCounterIds = new Set(model.members.map((member) => trimmed(member.counterId)));
  const types = counterUnitTypes(model, units);

  for (const matchup of model.matchups) {
    const mode = trimmed(matchup.mode);
    const counterId = trimmed(matchup.counterId);
    const defence = trimmed(matchup.defence);
    const context = { location: matchup.at, mode, subject: `${defence} ← ${counterId}` };

    for (const [label, value] of [["Mode", matchup.mode], ["Defence Team", matchup.defence], ["Counter_ID", matchup.counterId]]) {
      if (str(value) !== trimmed(value)) add("NONCANONICAL_SPELLING", { ...context, observed: `${label} ${jsonValue(value)}`, expected: JSON.stringify(trimmed(value)), effect: "None today (trimmed by Apps Script)" });
    }
    if (!MATCHUP_MODES.includes(mode)) {
      add("MATCHUP_MODE_INVALID", { ...context, observed: jsonValue(matchup.mode), expected: MATCHUP_MODES.join(" | "), effect: `Filed under counters[${JSON.stringify(mode)}], which no screen reads` });
    }

    const definition = counterById.get(counterId);
    if (!definition) {
      add("MATCHUP_UNKNOWN_COUNTER", {
        ...context,
        observed: counterId,
        expected: "a Counter_Definitions Counter_ID",
        effect: memberCounterIds.has(counterId)
          ? "Counter shows a blank name; its definition is an Apps Script placeholder named after the ID"
          : "Counter shows a blank name and has no composition, so it is never availability-gated"
      });
    }
    if (isBlank(matchup.counterName)) {
      add("MATCHUP_COUNTER_NAME_BLANK", { ...context, observed: jsonValue(matchup.counterName ?? ""), expected: definition ? JSON.stringify(trimmed(definition.name)) : "a resolved counter name", effect: "Counter card shows no name" });
    } else if (definition && model.sourceKind === "sheets" && str(matchup.counterName) !== trimmed(definition.name)) {
      add("DERIVED_VALUE_MISMATCH", { ...context, observed: jsonValue(matchup.counterName), expected: JSON.stringify(trimmed(definition.name)), effect: "Counter card shows a name that disagrees with Counter_Definitions" });
    } else if (definition && model.sourceKind === "payload" && str(matchup.counterName) !== str(definition.name)) {
      add("DERIVED_VALUE_MISMATCH", { ...context, observed: jsonValue(matchup.counterName), expected: JSON.stringify(definition.name), effect: "Counter card name disagrees with counterDefinitions" });
    }

    if (matchup.role !== undefined) {
      if (!MATCHUP_ROLES.includes(matchup.role)) add("MATCHUP_ROLE_INVALID", { ...context, observed: jsonValue(matchup.role), expected: MATCHUP_ROLES.join(" | "), effect: "The entry is hidden from every screen and from allocation" });
      const scored = ["tier", "bannerScore", "undersize"].filter((field) => matchup[field] !== undefined);
      if (scored.length) add("MATCHUP_ROLE_SCORED", { ...context, observed: scored.join(", "), expected: "no tier, bannerScore or undersize", effect: "A fabricated value would suggest a one-shot win" });
      if (isBlank(matchup.notes)) add("MATCHUP_ROLE_NOTES_BLANK", { ...context, observed: jsonValue(matchup.notes ?? ""), expected: "what the step achieves and when it applies", effect: "The tactic shows with no explanation" });
      checkMatchupUnitTypes(matchup, mode, counterId, types, add, context);
      continue;
    }

    if (!TIERS.includes(matchup.tier)) add("TIER_INVALID", { ...context, observed: jsonValue(matchup.tier), expected: TIERS.join(" | "), effect: "Tier sorts last and displays incorrectly" });

    const ceiling = BANNER_CEILING[mode];
    const score = matchup.bannerScore;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || (ceiling !== undefined && score > ceiling)) {
      add("BANNER_SCORE_INVALID", { ...context, observed: jsonValue(score), expected: `whole number 1..${ceiling ?? "ceiling"}`, effect: "Allocation tiebreaks and points-to-win use an invalid score" });
    } else if (scoreMeanings && !scoreMeanings.has(`${mode}|${score}`)) {
      add("BANNER_SCORE_NO_MEANING", { ...context, observed: String(score), expected: `a Score_Meanings row for ${mode}`, effect: "Derived Score Meaning is blank" });
    }
    if (scoreMeanings && model.sourceKind === "sheets" && matchup.scoreMeaning !== undefined) {
      const expectedMeaning = scoreMeanings.get(`${mode}|${score}`) ?? "";
      if (str(matchup.scoreMeaning) !== expectedMeaning) add("SCORE_MEANING_MISMATCH", { ...context, observed: jsonValue(matchup.scoreMeaning), expected: JSON.stringify(expectedMeaning), effect: "Authoring-only column is stale; not served" });
    }

    const undersize = matchup.undersize;
    const maxUndersize = UNIT_COUNT[mode] === undefined ? undefined : UNIT_COUNT[mode] - 1;
    if (model.sourceKind === "sheets" && (typeof undersize !== "number")) {
      add("UNDERSIZE_NONNUMERIC", { ...context, observed: jsonValue(undersize), expected: `whole number 0..${maxUndersize ?? "max"}`, effect: "Read as 0 (field the full squad)" });
    } else if (typeof undersize !== "number" || !Number.isInteger(undersize) || undersize < 0 || (maxUndersize !== undefined && undersize > maxUndersize)) {
      add("UNDERSIZE_INVALID", { ...context, observed: jsonValue(undersize), expected: `whole number 0..${maxUndersize ?? "max"}`, effect: "Undersize-adjusted ranking uses an impossible drop count" });
    }

    checkMatchupUnitTypes(matchup, mode, counterId, types, add, context);
  }

  for (const [key, matchups] of groupBy(model.matchups, (matchup) => `${trimmed(matchup.mode)}\u0000${trimmed(matchup.defence)}`)) {
    if (!matchups.some((matchup) => matchup.role === "CLEANUP") || matchups.some((matchup) => matchup.role === "SETUP")) continue;
    const [mode, defence] = key.split("\u0000");
    add("MATCHUP_CLEANUP_WITHOUT_SETUP", { location: matchups.filter((matchup) => matchup.role === "CLEANUP").map((matchup) => matchup.at).join("; "), mode, subject: defence, observed: "CLEANUP only", expected: "a SETUP step for the same defence", effect: "The cleanup's pre-weakened condition has no documented first battle" });
  }

  for (const [key, matchups] of groupBy(model.matchups, (matchup) => `${trimmed(matchup.mode)}\u0000${trimmed(matchup.defence)}\u0000${trimmed(matchup.counterId)}`)) {
    if (matchups.length < 2) continue;
    const [mode, defence, counterId] = key.split("\u0000");
    const describe = (matchup) => `${matchup.at}: tier ${jsonValue(matchup.tier)}, banner ${jsonValue(matchup.bannerScore)}, undersize ${jsonValue(matchup.undersize)}, notes ${jsonValue(matchup.notes ?? "")}`;
    add("DUPLICATE_MATCHUP", {
      location: matchups.map((matchup) => matchup.at).join("; "),
      mode,
      subject: `${defence} ← ${counterId}`,
      observed: matchups.map(describe).join(" | "),
      expected: "one row per (mode, defence, Counter_ID)",
      effect: "The counter is listed twice for this defence"
    });
  }
}

function checkMatchupUnitTypes(matchup, mode, counterId, types, add, context) {
  const set = types.get(counterId);
  if (!set || !MATCHUP_MODES.includes(mode)) return;
  const fleet = mode === "FLEET";
  const wrong = fleet ? set.has("CHARACTER") : SHIP_TYPES.some((type) => set.has(type));
  if (wrong) add("MATCHUP_UNIT_TYPE_MODE", { ...context, observed: [...set].sort().join(", "), expected: fleet ? "SHIP/CAPITAL_SHIP members" : "CHARACTER members", effect: "Availability gates on units that cannot be fielded in this mode" });
}

function defenceMode(raw, add, context) {
  const value = trimmed(raw);
  if (value === "") {
    add("DEFENCE_MODE_BLANK", { ...context, observed: jsonValue(raw ?? ""), expected: "explicit ANY", effect: "Read as ANY" });
    return { lookupMode: "ANY", effectiveMode: "ANY" };
  }
  if (DEFENCE_MODES.includes(value)) return { lookupMode: value, effectiveMode: value };
  const intended = DEFENCE_MODES.find((mode) => mode.toUpperCase() === value.toUpperCase());
  if (intended) {
    add("DEFENCE_MODE_CASE", { ...context, mode: value, observed: JSON.stringify(value), expected: JSON.stringify(intended), effect: `Filed under ${JSON.stringify(value)}; the app only looks up ${JSON.stringify(intended)}, so this row is never applied` });
    return { lookupMode: value, effectiveMode: intended };
  }
  add("DEFENCE_MODE_INVALID", { ...context, mode: value, observed: JSON.stringify(value), expected: DEFENCE_MODES.join(" | "), effect: "Row is never applied" });
  return { lookupMode: value, effectiveMode: null };
}

function checkDefences(model, add, units) {
  // Names the board can select, per mode: exactly the Counters defence keys.
  const selectable = new Map(MATCHUP_MODES.map((mode) => [mode, new Set()]));
  for (const matchup of model.matchups) {
    const mode = trimmed(matchup.mode);
    if (selectable.has(mode)) selectable.get(mode).add(trimmed(matchup.defence));
  }
  const selectableIn = (mode) => (mode === "ANY"
    ? new Set([...selectable.values()].flatMap((names) => [...names]))
    : selectable.get(mode) ?? new Set());
  const reportedAliases = new Set();

  const checkName = (entry, effectiveMode, kind) => {
    const defence = trimmed(entry.defence);
    if (!effectiveMode) return;
    const names = selectableIn(effectiveMode);
    if (names.has(defence)) return;
    const candidates = [...names].filter((name) => aliasKey(name) === aliasKey(defence)).sort();
    if (candidates.length) {
      for (const candidate of candidates) reportedAliases.add([defence, candidate].sort().join("\u0000"));
      add("DEFENCE_ALIAS_CANDIDATE", {
        location: entry.at,
        mode: effectiveMode,
        subject: defence,
        observed: JSON.stringify(defence),
        expected: `candidate alias ${candidates.map((name) => JSON.stringify(name)).join(" or ")} (owner decides; never auto-renamed)`,
        effect: kind === "threat"
          ? `Threat ${jsonValue(trimmed(entry.threat).toUpperCase())} is never applied to ${candidates.map((name) => JSON.stringify(name)).join("/")}; Battle Order reads NORMAL`
          : `Composition is never used for ${candidates.map((name) => JSON.stringify(name)).join("/")}; the defence snapshot falls back to partial`
      });
      return;
    }
    add("DEFENCE_ONLY_IDENTITY", {
      location: entry.at,
      mode: effectiveMode,
      subject: defence,
      observed: `no Counters defence named ${JSON.stringify(defence)} in ${effectiveMode === "ANY" ? "any mode" : effectiveMode}`,
      expected: "legitimate for defence-only, saved or future identities",
      effect: kind === "threat" ? "Applies only if this exact name is on a board" : "Used only for saved My Board identities with this exact name"
    });
  };

  // Defence_Teams
  const teamKeys = new Map();
  for (const entry of model.defenceTeams) {
    const defence = trimmed(entry.defence);
    const context = { location: entry.at, subject: defence };
    if (str(entry.defence) !== defence) add("NONCANONICAL_SPELLING", { ...context, observed: jsonValue(entry.defence), expected: JSON.stringify(defence), effect: "None today (trimmed by Apps Script)" });
    const { lookupMode, effectiveMode } = defenceMode(entry.mode, add, context);
    const key = `${lookupMode}\u0000${defence}`;
    if (!teamKeys.has(key)) teamKeys.set(key, []);
    teamKeys.get(key).push(entry);

    if (isBlank(entry.threat)) add("THREAT_BLANK", { ...context, mode: lookupMode, observed: jsonValue(entry.threat ?? ""), expected: THREATS.join(" | "), effect: "Read as NORMAL" });
    else {
      const threat = model.sourceKind === "sheets" ? canonicalEnum(entry.threat, THREATS, add, { ...context, mode: lookupMode }) : entry.threat;
      if (!THREATS.includes(threat)) add("THREAT_INVALID", { ...context, mode: lookupMode, observed: jsonValue(entry.threat), expected: THREATS.join(" | "), effect: "Read as NORMAL" });
    }
    checkName(entry, effectiveMode, "threat");
  }
  for (const [key, entries] of teamKeys) {
    if (entries.length < 2) continue;
    const [mode, defence] = key.split("\u0000");
    add("DEFENCE_TEAM_DUPLICATE", { location: entries.map((entry) => entry.at).join("; "), mode, subject: defence, observed: entries.map((entry) => jsonValue(entry.threat)).join(", "), expected: "one row per (defence, mode)", effect: "Only the last row's threat is served" });
  }

  // Defence_Composition
  const compositions = new Map();
  for (const entry of model.defenceCompositions) {
    const defence = trimmed(entry.defence);
    const unitId = trimmed(entry.unitId);
    const context = { location: entry.at, subject: `${defence} / ${unitId}` };
    const { lookupMode, effectiveMode } = defenceMode(entry.mode, add, context);
    const key = `${lookupMode}\u0000${defence}`;
    if (!compositions.has(key)) compositions.set(key, { entries: [], effectiveMode });
    compositions.get(key).entries.push(entry);
    const unit = units.get(unitId);
    if (!unit) {
      add("DEFENCE_COMPOSITION_UNKNOWN_UNIT", { ...context, mode: lookupMode, observed: unitId, expected: "a Character_Definitions Character_ID", effect: "The ID enters the round's defence snapshot but matches no roster unit, so nothing is blocked for it" });
    }
  }
  for (const [key, { entries, effectiveMode }] of compositions) {
    const [mode, defence] = key.split("\u0000");
    const location = `${entries[0].at}..${entries[entries.length - 1].at.replace(/^.* row /, "row ")}`;
    const ids = entries.map((entry) => trimmed(entry.unitId));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) add("DEFENCE_COMPOSITION_DUPLICATE_MEMBER", { location, mode, subject: defence, observed: [...new Set(duplicates)].join(", "), expected: "each unit once", effect: "None (de-duplicated by Apps Script)" });
    const unique = [...new Set(ids)];
    const typesPresent = new Set(unique.map((id) => units.get(id)).filter(Boolean).map((unit) => trimmed(unit.unitType).toUpperCase()));
    const hasCharacter = typesPresent.has("CHARACTER");
    const hasShip = SHIP_TYPES.some((type) => typesPresent.has(type));
    if ((SQUAD_MODES.includes(effectiveMode) && hasShip) || (effectiveMode === "FLEET" && hasCharacter) || (effectiveMode === "ANY" && hasCharacter && hasShip)) {
      add("DEFENCE_COMPOSITION_UNIT_TYPE", { location, mode, subject: defence, observed: [...typesPresent].sort().join(", "), expected: effectiveMode === "FLEET" ? "ships only" : effectiveMode === "ANY" ? "characters only or ships only" : "characters only", effect: "Wrong units are blocked from attack" });
    }
    if (SQUAD_MODES.includes(effectiveMode) && unique.length > UNIT_COUNT[effectiveMode]) {
      add("DEFENCE_COMPOSITION_OVERSIZE", { location, mode, subject: defence, observed: `${unique.length} units`, expected: `at most ${UNIT_COUNT[effectiveMode]}`, effect: "Extra units are blocked from attack" });
    }
    if (effectiveMode === "FLEET") {
      add("DEFENCE_COMPOSITION_FLEET_UNREACHABLE", { location, mode, subject: defence, observed: "Mode FLEET", expected: "ANY (or the round's squad mode)", effect: "app.js resolves every My Board team under the round mode or ANY; this composition is never read" });
    }
    checkName({ defence, at: location }, effectiveMode, "composition");
  }

  // Name variants across tabs and modes (candidate aliases only).
  const occurrences = [];
  for (const matchup of model.matchups) occurrences.push({ tab: "Counters", mode: trimmed(matchup.mode), name: trimmed(matchup.defence) });
  for (const entry of model.defenceTeams) occurrences.push({ tab: "Defence_Teams", mode: trimmed(entry.mode) || "ANY", name: trimmed(entry.defence) });
  for (const entry of model.defenceCompositions) occurrences.push({ tab: "Defence_Composition", mode: trimmed(entry.mode) || "ANY", name: trimmed(entry.defence) });
  const byKey = groupBy(occurrences, (occurrence) => aliasKey(occurrence.name));
  for (const group of byKey.values()) {
    const names = [...new Set(group.map((occurrence) => occurrence.name))].sort();
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const pair = [names[i], names[j]];
        if (reportedAliases.has(pair.join("\u0000"))) continue;
        const where = (name) => [...new Set(group.filter((occurrence) => occurrence.name === name).map((occurrence) => `${occurrence.tab} ${occurrence.mode}`))].sort().join(", ");
        const countersModes = (name) => new Set(group.filter((occurrence) => occurrence.name === name && occurrence.tab === "Counters").map((occurrence) => occurrence.mode));
        const sharedCountersMode = [...countersModes(pair[0])].find((mode) => countersModes(pair[1]).has(mode));
        add(sharedCountersMode ? "DEFENCE_NAME_VARIANT" : "DEFENCE_NAME_CROSS_MODE_VARIANT", {
          location: `${JSON.stringify(pair[0])}: ${where(pair[0])}; ${JSON.stringify(pair[1])}: ${where(pair[1])}`,
          mode: sharedCountersMode ?? "",
          subject: pair.join(" / "),
          observed: "names differ only by case, punctuation or plural",
          expected: "candidate alias only; owner decides",
          effect: sharedCountersMode ? "Counters for one defence are split across two board options" : "None; identities are mode-scoped"
        });
      }
    }
  }
}

function checkBoard(model, add) {
  const keyed = groupBy(model.board, (row) => `${trimmed(row.league).toUpperCase()}\u0000${trimmed(row.mode)}\u0000${trimmed(row.territory).toUpperCase()}`);
  for (const row of model.board) {
    const context = { location: row.at, mode: trimmed(row.mode), subject: `${trimmed(row.league)} ${trimmed(row.mode)} ${trimmed(row.territory)}` };
    const league = model.sourceKind === "sheets" ? canonicalEnum(row.league, LEAGUES, add, context) : row.league;
    const territory = model.sourceKind === "sheets" ? canonicalEnum(row.territory, TERRITORIES, add, context) : row.territory;
    const type = model.sourceKind === "sheets" ? canonicalEnum(row.type, TERRITORY_TYPES, add, context) : row.type;
    const problems = [];
    if (!LEAGUES.includes(league)) problems.push(`League ${jsonValue(row.league)}`);
    if (!SQUAD_MODES.includes(trimmed(row.mode))) problems.push(`Mode ${jsonValue(row.mode)}`);
    if (!TERRITORIES.includes(territory)) problems.push(`Territory ${jsonValue(row.territory)}`);
    if (!TERRITORY_TYPES.includes(type)) problems.push(`Territory_Type ${jsonValue(row.type)}`);
    if (typeof row.teamCount !== "number" || !Number.isInteger(row.teamCount) || row.teamCount < 0) problems.push(`Team_Count ${jsonValue(row.teamCount)}`);
    if (problems.length) add("BOARD_ROW_INVALID", { ...context, observed: problems.join("; "), expected: "valid league, 5v5/3v3, territory, SQUAD/FLEET and whole team count", effect: "Board setup generates the wrong slots" });
  }
  for (const [key, rows] of keyed) {
    if (rows.length > 1) add("BOARD_DUPLICATE", { location: rows.map((row) => row.at).join("; "), mode: key.split("\u0000")[1], subject: key.split("\u0000").join(" "), observed: `${rows.length} rows`, expected: "1 row", effect: "Territory is generated twice" });
  }
  const byLeagueMode = groupBy(model.board, (row) => `${trimmed(row.league).toUpperCase()}\u0000${trimmed(row.mode)}`);
  for (const league of LEAGUES) {
    for (const mode of SQUAD_MODES) {
      const rows = byLeagueMode.get(`${league}\u0000${mode}`) ?? [];
      const subject = `${league} ${mode}`;
      const territories = rows.map((row) => trimmed(row.territory).toUpperCase());
      const sorted = [...territories].sort();
      if (JSON.stringify(sorted) !== JSON.stringify([...TERRITORIES].sort())) {
        add("BOARD_SHAPE", { location: rows.length ? rows.map((row) => row.at).join("; ") : "GAC_Board_Config", mode, subject, observed: jsonValue(territories), expected: jsonValue(TERRITORIES), effect: rows.length ? "Board setup generates the wrong territories" : "This league/mode cannot be set up" });
        continue;
      }
      if (JSON.stringify(territories) !== JSON.stringify(TERRITORIES)) add("BOARD_ORDER", { location: rows.map((row) => row.at).join("; "), mode, subject, observed: jsonValue(territories), expected: jsonValue(TERRITORIES), effect: "Territories render in a different order" });
      const fleets = rows.filter((row) => trimmed(row.type).toUpperCase() === "FLEET").length;
      if (fleets !== 1) add("BOARD_FLEET_COUNT", { location: rows.map((row) => row.at).join("; "), mode, subject, observed: `${fleets} FLEET territories`, expected: "1", effect: "Fleet slots differ from the usual GAC board" });
    }
  }
}

function checkScoring(model, add) {
  for (const row of model.scoring) {
    const context = { location: row.at, mode: trimmed(row.mode), subject: trimmed(row.ruleId).toUpperCase() };
    if (model.sourceKind === "sheets") {
      if (str(row.ruleId) !== trimmed(row.ruleId).toUpperCase()) add("NONCANONICAL_SPELLING", { ...context, observed: jsonValue(row.ruleId), expected: JSON.stringify(trimmed(row.ruleId).toUpperCase()), effect: "None today (normalised by Apps Script)" });
      canonicalEnum(row.battleType, BATTLE_TYPES, add, context);
    }
    const battleType = trimmed(row.battleType).toUpperCase();
    const problems = [];
    if (!BATTLE_TYPES.includes(battleType)) problems.push(`Battle_Type ${jsonValue(row.battleType)}`);
    if (!SCORING_MODES.includes(trimmed(row.mode))) problems.push(`Mode ${jsonValue(row.mode)}`);
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) problems.push(`Value ${jsonValue(row.value)} (served as 0)`);
    if (problems.length) add("SCORING_ROW_INVALID", { ...context, observed: problems.join("; "), expected: "SQUAD|FLEET|ANY, 5v5|3v3|ANY and a finite number", effect: "Rule never matches or scores 0" });
  }
  for (const [key, rows] of groupBy(model.scoring, (row) => `${trimmed(row.ruleId).toUpperCase()}\u0000${trimmed(row.battleType).toUpperCase()}\u0000${trimmed(row.mode)}`)) {
    if (rows.length > 1) add("SCORING_DUPLICATE", { location: rows.map((row) => row.at).join("; "), subject: key.split("\u0000").join(" / "), observed: rows.map((row) => jsonValue(row.value)).join(", "), expected: "1 row", effect: "Only the first matching row is used" });
  }
  const setting = model.scoring.filter((row) => trimmed(row.ruleId).toUpperCase() === "SETTING_DEFENCE" && trimmed(row.battleType).toUpperCase() === "ANY" && trimmed(row.mode) === "ANY");
  if (setting.length !== 1 || typeof setting[0].value !== "number" || !Number.isFinite(setting[0].value) || setting[0].value <= 0) {
    add("SETTING_DEFENCE", { location: setting.length ? setting.map((row) => row.at).join("; ") : "GAC_Scoring", subject: "SETTING_DEFENCE / ANY / ANY", observed: setting.length ? setting.map((row) => jsonValue(row.value)).join(", ") : "no row", expected: "exactly one positive finite value", effect: "New-round setup is blocked with a data warning" });
  }
  for (const row of model.scoring) {
    const ruleId = trimmed(row.ruleId).toUpperCase();
    if (ruleId !== "OWN_UNITS" && ruleId !== "ENEMY_UNITS") continue;
    const battleType = trimmed(row.battleType).toUpperCase();
    const mode = trimmed(row.mode);
    const expected = battleType === "FLEET" ? UNIT_COUNT.FLEET : battleType === "SQUAD" && UNIT_COUNT[mode] ? UNIT_COUNT[mode] : null;
    if (expected !== null && row.value !== expected) add("SCORING_UNIT_COUNT", { location: row.at, mode, subject: `${ruleId} / ${battleType} / ${mode}`, observed: jsonValue(row.value), expected: String(expected), effect: "Points-to-win and first-attack maths use the wrong unit count" });
  }
}

function checkScoreMeanings(model, add) {
  const meanings = new Map();
  for (const [key, rows] of groupBy(model.scoreMeanings, (row) => `${trimmed(row.mode)}|${trimmed(row.score)}`)) {
    if (rows.length > 1) add("SCORE_MEANING_INVALID", { location: rows.map((row) => row.at).join("; "), subject: key, observed: `${rows.length} rows`, expected: "1 row", effect: "Score Meaning formula uses the first row" });
  }
  for (const row of model.scoreMeanings) {
    const mode = trimmed(row.mode);
    const ceiling = BANNER_CEILING[mode];
    const problems = [];
    if (ceiling === undefined) problems.push(`Mode ${jsonValue(row.mode)}`);
    if (typeof row.score !== "number" || !Number.isInteger(row.score) || row.score < 1 || (ceiling !== undefined && row.score > ceiling)) problems.push(`Score ${jsonValue(row.score)}`);
    if (isBlank(row.meaning)) problems.push("Meaning blank");
    if (problems.length) add("SCORE_MEANING_INVALID", { location: row.at, mode, subject: `${mode}|${str(row.score)}`, observed: problems.join("; "), expected: "valid mode, score within ceiling, non-blank meaning", effect: "Authoring guidance only" });
    const key = `${mode}|${typeof row.score === "number" ? row.score : trimmed(row.score)}`;
    if (!meanings.has(key)) meanings.set(key, str(row.meaning));
  }
  return meanings;
}

function checkFormulas(snapshot, model, add) {
  const tab = snapshot.tabs.Counters;
  for (const [name, entry] of Object.entries(snapshot.tabs)) {
    if (!entry.formulaMetadata) continue;
    for (const formula of entry.formulas) {
      const derivedAnchor = name === "Counters" && (formula.cell === "D2" || formula.cell === "G2");
      if (!derivedAnchor) add("UNEXPECTED_FORMULA", { location: `${name}!${formula.cell}`, observed: formula.formula ?? `(${formula.type ?? "shared"} formula)`, expected: "authored value", effect: "Cell content is computed, not authored" });
    }
  }
  if (!tab) return;
  if (!tab.formulaMetadata) {
    add("FORMULA_METADATA_UNAVAILABLE", { location: "Counters", observed: snapshot.format, expected: "typed snapshot with formulas" });
    return;
  }
  const headers = (tab.grid[0] ?? []).map(str);
  const lastAuthoredRow = model.matchups.reduce((max, matchup) => Math.max(max, matchup.rowNumber ?? 0), 0);
  for (const [column, source] of [["Counter Team", "Counter_Definitions"], ["Score Meaning", "Score_Meanings"]]) {
    const index = headers.indexOf(column);
    if (index < 0) continue;
    const letter = columnLetters(index);
    const anchor = tab.formulas.find((formula) => formula.cell === `${letter}2`);
    if (!anchor || !anchor.formula || !anchor.formula.includes(source)) {
      add("DERIVED_FORMULA_MISSING", { location: `Counters!${letter}2`, subject: column, observed: anchor?.formula ?? "no formula", expected: `open-ended array formula over ${source}`, effect: `${column} stops deriving for new rows` });
      continue;
    }
    const end = /:([A-Z]+)(\d+)$/.exec(anchor.ref ?? "");
    const lastRow = end ? Number(end[2]) : 2;
    if (lastAuthoredRow > lastRow) {
      add("DERIVED_FORMULA_RANGE", { location: `Counters!${anchor.ref ?? `${letter}2`}`, subject: column, observed: `formula ends at row ${lastRow}; authored rows reach ${lastAuthoredRow}`, expected: "range covers every authored row", effect: `${column} is blank beyond row ${lastRow}` });
    }
  }
}

const SENSITIVE_PATTERNS = [
  [/(?:postgres(?:ql)?:\/\/|bearer\s+[a-z0-9._~-]+|gh[pousr]_[a-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i, "credential-shaped"],
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "email-shaped"],
  [/(?<!\d)\d{3}-?\d{3}-?\d{3}(?!\d)/, "ally-code-shaped"]
];

function scanSensitive(value, at, add) {
  if (Array.isArray(value)) { value.forEach((item, index) => scanSensitive(item, `${at}[${index}]`, add)); return; }
  if (value && typeof value === "object") { for (const [key, child] of Object.entries(value)) scanSensitive(child, `${at}[${JSON.stringify(key)}]`, add); return; }
  if (typeof value !== "string") return;
  for (const [pattern, label] of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) add("SENSITIVE_CONTENT", { location: at, observed: label, expected: "no personal or credential data", effect: "Would be published in the public repository/catalogue" });
  }
}

// ─── known 2026-10-10 observations (issue #34 §5–6) ───────────────────────────

function recheckKnownFindings(model, findings) {
  const has = (code, predicate) => findings.some((finding) => finding.code === code && predicate(finding));
  const unitIds = new Set(model.units.map((unit) => trimmed(unit.id)));
  const countersIn = (mode) => new Set(model.matchups.filter((matchup) => trimmed(matchup.mode) === mode).map((matchup) => trimmed(matchup.defence)));
  const required = (counterId) => model.members.filter((member) => trimmed(member.counterId) === counterId && trimmed(member.role).toUpperCase() === "REQUIRED").map((member) => trimmed(member.unitId));
  const results = [];
  // kind: "defect" (STILL PRESENT/RESOLVED), "valid" (PRESENT/ABSENT) or
  // "confirmation" (CONFIRMED/CHANGED).
  const STATUS = { defect: ["STILL PRESENT", "RESOLVED"], valid: ["PRESENT", "ABSENT"], confirmation: ["CONFIRMED", "CHANGED"] };
  const push = (id, kind, title, present, observed, classification) => results.push({ id, title, status: STATUS[kind][present ? 0 : 1], observed, classification });

  {
    const gungan = model.defenceTeams.filter((entry) => trimmed(entry.defence) === "Gungan" && trimmed(entry.mode) === "5v5");
    const fiveV5 = countersIn("5v5");
    const present = gungan.length > 0 && !fiveV5.has("Gungan") && fiveV5.has("Gungans");
    push("K1", "defect", "5v5 Defence_Teams `Gungan` vs Counters `Gungans`", present,
      present ? `${gungan.map((entry) => `${entry.at} threat ${jsonValue(entry.threat)}`).join("; ")}; Counters 5v5 has "Gungans" only` : `Defence_Teams 5v5 Gungan rows: ${gungan.length}; Counters 5v5 Gungan: ${fiveV5.has("Gungan")}, Gungans: ${fiveV5.has("Gungans")}`,
      has("DEFENCE_ALIAS_CANDIDATE", (finding) => finding.subject === "Gungan") ? "owner-approval (DEFENCE_ALIAS_CANDIDATE)" : "not flagged");
  }
  {
    const anyRows = model.defenceTeams.filter((entry) => trimmed(entry.mode) === "Any");
    push("K2", "defect", "Defence_Teams rows with Mode `Any` (app looks up `ANY`)", anyRows.length > 0,
      `${anyRows.length} row(s)${anyRows.length ? `: ${anyRows.map((entry) => `${trimmed(entry.defence)} (${entry.at.replace(/^.* row /, "row ")})`).join(", ")}` : ""}`,
      anyRows.length ? "owner-approval (DEFENCE_MODE_CASE)" : "n/a");
  }
  {
    const missing = ["KELLERAN_BEQ", "JOCASTA_NU"].filter((id) => !unitIds.has(id));
    const refs = model.defenceCompositions.filter((entry) => missing.includes(trimmed(entry.unitId)) && trimmed(entry.mode) === "3v3");
    push("K3", "defect", "3v3 Defence_Composition references `KELLERAN_BEQ`, `JOCASTA_NU` absent from Character_Definitions", refs.length > 0,
      refs.length ? refs.map((entry) => `${trimmed(entry.unitId)} at ${entry.at}`).join("; ") : `missing IDs: ${missing.join(", ") || "none"}; 3v3 references to them: 0`,
      refs.length ? "blocking (DEFENCE_COMPOSITION_UNKNOWN_UNIT)" : "n/a");
  }
  {
    const variants = findings.filter((finding) => finding.subject === "Geonosian / Geonosians");
    push("K4", "valid", "`Geonosian`/`Geonosians` in different modes", variants.length > 0,
      variants.length ? variants.map((finding) => finding.location).join("; ") : "variant pair not present",
      variants.length ? `${variants.map((finding) => `${finding.severity} (${finding.code})`).join(", ")} — not treated as an error` : "n/a");
  }
  for (const [id, name] of [["K5a", "Chief Chirpa"], ["K5b", "Iden Versio"]]) {
    const rows = model.defenceCompositions.filter((entry) => trimmed(entry.defence) === name && trimmed(entry.mode) === "3v3");
    const errors = findings.filter((finding) => finding.subject === name && (finding.severity === "blocking" || finding.severity === "owner-approval"));
    push(id, "valid", `3v3 defence-only composition \`${name}\``, rows.length > 0,
      rows.length ? `${rows.length} member row(s); blocking/owner-approval findings on the identity: ${errors.length}` : "no 3v3 composition rows",
      rows.length ? (errors.length ? errors.map((finding) => finding.code).join(", ") : "info (DEFENCE_ONLY_IDENTITY) — valid") : "n/a");
  }
  for (const [id, counterId, unitId] of [["K6a", "REVA", "THIRD_SISTER"], ["K6b", "GUNGANS", "BOSS_NASS"]]) {
    const members = required(counterId);
    const counter = model.counters.find((entry) => trimmed(entry.id) === counterId);
    push(id, "confirmation", `Attack identity \`${counterId}\` requires \`${unitId}\` (display name kept as authored)`, members.includes(unitId),
      `${counterId} name ${jsonValue(counter ? trimmed(counter.name) : undefined)}, REQUIRED: ${members.join(", ") || "none"}`,
      members.includes(unitId) ? "confirmed valid — no leader-name convention enforced" : "CHANGED — review");
  }
  return results;
}

// ─── orchestration ───────────────────────────────────────────────────────────

function compareFindings(a, b) {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    a.code.localeCompare(b.code) ||
    a.location.localeCompare(b.location, "en", { numeric: true }) ||
    a.subject.localeCompare(b.subject) ||
    a.observed.localeCompare(b.observed);
}

function collector() {
  const findings = [];
  const add = (code, details) => {
    const { severity } = rule(code);
    findings.push({
      severity,
      code,
      mode: details.mode ?? "",
      location: details.location ?? "",
      subject: details.subject ?? "",
      observed: str(details.observed),
      expected: str(details.expected),
      effect: str(details.effect)
    });
  };
  return { findings, add };
}

function runRules(model, add) {
  const units = new Map();
  for (const unit of model.units) if (!units.has(trimmed(unit.id))) units.set(trimmed(unit.id), unit);
  checkUnits(model, add);
  checkCounters(model, add, units);
  checkCounterComposition(model, add, units);
  const meanings = model.sourceKind === "sheets" && model.scoreMeanings.length ? checkScoreMeanings(model, add) : null;
  checkMatchups(model, add, units, meanings);
  checkDefences(model, add, units);
  checkBoard(model, add);
  checkScoring(model, add);
}

function summarise(findings) {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const byCode = {};
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  }
  const gateFailures = bySeverity.blocking + bySeverity["owner-approval"];
  return { bySeverity, byCode: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))), releaseGate: gateFailures === 0 ? "PASS" : "FAIL" };
}

function tabRowCounts(snapshot) {
  return Object.fromEntries(CATALOGUE_TABS.filter((name) => snapshot.tabs[name]).map((name) => {
    const grid = snapshot.tabs[name].grid;
    const dataRows = grid.slice(1).filter((row) => row.some((value) => !isBlank(value))).length;
    return [name, { gridRows: Math.max(grid.length - 1, 0), nonEmptyRows: dataRows }];
  }));
}

// Audit a Sheet snapshot: rules over the raw tabs, then parity between the
// emulated Code.gs payload and the captured action=data response (if any).
function auditSnapshot(snapshot) {
  const { findings, add } = collector();
  const model = modelFromSnapshot(snapshot, add);
  runRules(model, add);
  checkFormulas(snapshot, model, add);
  for (const [name, tab] of Object.entries(snapshot.tabs)) scanSensitive(tab.grid, name, add);

  const emulated = emulateActionData(snapshot.tabs);
  let parity = { status: "NOT RUN", reason: "no action=data capture in snapshot" };
  if (emulated.error) {
    parity = { status: "NOT RUN", reason: emulated.error };
  } else if (snapshot.actionData) {
    const differences = diffPayloads(emulated, snapshot.actionData.payload);
    differences.forEach((difference) => add("PARITY_MISMATCH", {
      location: difference.path,
      observed: `action=data ${jsonValue(difference.actual)}`,
      expected: `Sheet/Code.gs ${jsonValue(difference.expected)}`,
      effect: "Live payload and Sheet snapshot disagree (capture skew or deployed Apps Script differs from apps-script/Code.gs)"
    }));
    parity = {
      status: differences.length ? "MISMATCH" : "MATCH",
      differences: differences.length,
      emulatedChecksum: payloadChecksum(emulated),
      capturedChecksum: payloadChecksum(snapshot.actionData.payload),
      actionDataCapturedAt: snapshot.actionData.capturedAt ?? null
    };
  }

  findings.sort(compareFindings);
  return {
    schema: REPORT_SCHEMA,
    input: {
      kind: "sheet-snapshot",
      format: snapshot.format,
      capturedAt: snapshot.capturedAt,
      source: snapshot.source,
      tabs: tabRowCounts(snapshot),
      excludedPersonalTabs: [...EXCLUDED_PERSONAL_TABS]
    },
    payloadCounts: emulated.error ? null : countPayloadDomains(emulated),
    parity,
    summary: summarise(findings),
    knownFindings: recheckKnownFindings(model, findings),
    findings
  };
}

// Audit any seven-key payload through the same rules.
function auditPayload(payload, { label = "payload", capturedAt = null } = {}) {
  const { findings, add } = collector();
  const model = modelFromPayload(payload, add);
  runRules(model, add);
  scanSensitive(payload, "payload", add);
  findings.sort(compareFindings);
  let counts = null;
  try { counts = countPayloadDomains(payload); } catch { counts = null; }
  return {
    schema: REPORT_SCHEMA,
    input: { kind: "payload", label, capturedAt, checksum: payload && typeof payload === "object" ? payloadChecksum(payload) : null },
    payloadCounts: counts,
    parity: { status: "NOT RUN", reason: "payload-only audit" },
    summary: summarise(findings),
    knownFindings: recheckKnownFindings(model, findings),
    findings
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────

function cell(value) {
  return str(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ].join("\n");
}

const SEVERITY_TITLES = {
  blocking: "Blocking structural errors",
  "owner-approval": "Owner-approval-required corrections",
  warning: "Non-blocking editorial warnings",
  info: "Informational observations"
};

function renderMarkdown(report) {
  const lines = [];
  const { input, summary } = report;
  lines.push("# Catalogue integrity and parity audit", "");
  lines.push("Generated by `npm run catalogue:audit` (read-only; see `docs/CATALOGUE_AUDIT.md`). Do not edit by hand.", "");
  lines.push("## Input and freshness", "");
  if (input.kind === "sheet-snapshot") {
    lines.push(`- Snapshot captured: \`${input.capturedAt}\` (${input.format})`);
    if (input.source.workbook) lines.push(`- Workbook: \`${input.source.workbook}\`${input.source.workbookModifiedAt ? `, last modified \`${input.source.workbookModifiedAt}\`` : ""}`);
    if (report.parity.actionDataCapturedAt) lines.push(`- action=data captured: \`${report.parity.actionDataCapturedAt}\``);
    lines.push(`- Personal tabs never read: ${input.excludedPersonalTabs.map((tab) => `\`${tab}\``).join(", ")}`);
    lines.push("", table(["Tab", "Data rows (non-empty)", "Rows in snapshot"], Object.entries(input.tabs).map(([tab, counts]) => [tab, counts.nonEmptyRows, counts.gridRows])));
  } else {
    lines.push(`- Payload: \`${input.label}\`${input.capturedAt ? ` captured \`${input.capturedAt}\`` : ""}`);
    if (input.checksum) lines.push(`- Canonical seven-key checksum: \`${input.checksum}\``);
  }
  lines.push("", "## Summary", "");
  lines.push(`Release gate: **${summary.releaseGate}** — ${summary.bySeverity.blocking} blocking, ${summary.bySeverity["owner-approval"]} owner-approval, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info.`, "");
  lines.push(table(["Code", "Severity", "Count"], Object.entries(summary.byCode).map(([code, count]) => [`\`${code}\``, rule(code).severity, count])));

  lines.push("", "## Parity", "");
  if (report.parity.status === "NOT RUN") lines.push(`Not run: ${report.parity.reason}.`);
  else {
    lines.push(`Sheet tabs → emulated \`apps-script/Code.gs\` → compared with the captured \`action=data\` response: **${report.parity.status}** (${report.parity.differences} difference(s)).`, "");
    lines.push(`- Emulated checksum: \`${report.parity.emulatedChecksum}\``);
    lines.push(`- Captured checksum: \`${report.parity.capturedChecksum}\``);
  }
  if (report.payloadCounts) {
    const counts = report.payloadCounts;
    lines.push("", table(["Payload domain", "Count"], [
      ...Object.entries(counts.counters.byMode).sort(([a], [b]) => a.localeCompare(b)).map(([mode, value]) => [`counters ${mode} rows / defences`, `${value.rows} / ${value.defenceTeams}`]),
      ["counterDefinitions", counts.counterDefinitions],
      ["characterDefinitions", counts.characterDefinitions],
      ["boardConfig rows", counts.boardConfig.rows],
      ["scoring rules", counts.scoring],
      ...Object.entries(counts.defenceTeams.byMode).sort(([a], [b]) => a.localeCompare(b)).map(([mode, value]) => [`defenceTeams ${mode}`, value]),
      ...Object.entries(counts.defenceCompositions.teamsByMode).sort(([a], [b]) => a.localeCompare(b)).map(([mode, value]) => [`defenceCompositions ${mode} teams`, value]),
      ["defenceCompositions members", counts.defenceCompositions.members]
    ]));
  }

  lines.push("", "## Known observations rechecked", "");
  lines.push(table(["ID", "Observation", "Status", "Classification", "Evidence"], report.knownFindings.map((entry) => [entry.id, entry.title, entry.status, entry.classification, entry.observed])));

  for (const severity of SEVERITIES) {
    const group = report.findings.filter((finding) => finding.severity === severity);
    lines.push("", `## ${SEVERITY_TITLES[severity]} (${group.length})`, "");
    if (!group.length) { lines.push("None."); continue; }
    lines.push(table(["Code", "Mode", "Location", "Subject", "Observed", "Expected", "Runtime effect"], group.map((finding) => [`\`${finding.code}\``, finding.mode, finding.location, finding.subject, finding.observed, finding.expected, finding.effect])));
  }

  lines.push("", "## Rule legend", "");
  const used = new Set(report.findings.map((finding) => finding.code));
  lines.push(table(["Code", "Severity", "Meaning"], Object.entries(RULES).filter(([code]) => used.has(code)).map(([code, [severity, description]]) => [`\`${code}\``, severity, description])));
  return `${lines.join("\n")}\n`;
}

module.exports = {
  BANNER_CEILING,
  CATALOGUE_TABS,
  MATCHUP_ROLES,
  EXCLUDED_PERSONAL_TABS,
  RULES,
  SEVERITIES,
  SNAPSHOT_KIND,
  SNAPSHOT_SCHEMA,
  TAB_SPECS,
  UNIT_COUNT,
  aliasKey,
  auditPayload,
  auditSnapshot,
  collector,
  compareFindings,
  scanSensitive,
  summarise,
  diffPayloads,
  emulateActionData,
  loadSnapshot,
  payloadChecksum,
  renderMarkdown
};
