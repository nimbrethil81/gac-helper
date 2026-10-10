"use strict";

// Pure Node port of `buildDataPayload()` in apps-script/Code.gs.
//
// It turns a read-only export of the catalogue Sheet tabs (one array of rows per
// tab, header row first) into the exact seven-key `action=data` payload the live
// Apps Script would return for the same cells. It exists so a Sheet-tab snapshot
// can be reconciled row by row against both a live `action=data` capture and the
// Git-native compiled catalogue, separating Sheet (source) defects from import
// defects. It is never used to build the Git-native catalogue itself.
//
// Fidelity notes:
// - Every guard, trim, upper-casing, fallback column index and parse rule below
//   mirrors Code.gs line for line. Keep them in step if Code.gs changes.
// - `getDataRange().getValues()` returns full-width rows, so short CSV rows are
//   padded with "" to the header width.
// - A CSV export loses Sheet cell types. Code.gs passes `Counter Team`, `Tier`,
//   `Banner Score` and `Notes` through without String(), so a numeric cell in
//   those columns reaches the payload as a JSON number. `sheetCell` restores that
//   by reading a plainly numeric CSV value as a number, exactly as Sheets types a
//   number typed into a cell.

const CATALOGUE_TABS = Object.freeze([
  "Counters",
  "Counter_Definitions",
  "Counter_Composition",
  "Character_Definitions",
  "GAC_Board_Config",
  "GAC_Scoring",
  "Defence_Teams",
  "Defence_Composition"
]);
const REQUIRED_TABS = Object.freeze(["Counters", "Counter_Definitions", "Counter_Composition", "Character_Definitions"]);
const NUMERIC_CELL = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

function sheetCell(value) {
  if (typeof value !== "string") return value;
  return NUMERIC_CELL.test(value) ? Number(value) : value;
}

function dataRange(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => {
    const padded = row.map(sheetCell);
    while (padded.length < width) padded.push("");
    return padded;
  });
}

function col(headers, name, fallback) {
  const idx = headers.indexOf(name);
  return idx >= 0 ? idx : fallback;
}

function parseUndersize(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function parseReserveFlag(raw) {
  if (raw === true) return true;
  return ["TRUE", "YES", "Y", "1"].indexOf(String(raw).trim().toUpperCase()) >= 0;
}

function buildBoardConfig(data) {
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

function buildScoring(data) {
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

function buildDefenceTeams(data) {
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

function buildDefenceCompositions(data) {
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

// tabs: { [tabName]: string[][] } with the header row first. A tab that is
// absent (undefined) behaves like a missing sheet in Code.gs.
function buildAppsScriptPayload(tabs) {
  for (const name of REQUIRED_TABS) {
    if (!Array.isArray(tabs[name])) throw new Error(`Sheet tab ${name} is required by Code.gs and is missing`);
  }
  const countersData = dataRange(tabs.Counters);
  const counterDefsData = dataRange(tabs.Counter_Definitions);
  const counterCompData = dataRange(tabs.Counter_Composition);
  const characterDefsData = dataRange(tabs.Character_Definitions);

  const output = {
    counters: { "5v5": {}, "3v3": {} },
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };

  const counterHeaders = countersData[0];
  for (let i = 1; i < countersData.length; i++) {
    const row = countersData[i];
    const entry = {};
    counterHeaders.forEach((h, idx) => { entry[h] = row[idx]; });
    const counterId = String(entry.Counter_ID || "").trim();
    const mode = String(entry.Mode || "").trim();
    const team = String(entry["Defence Team"] || "").trim();
    if (!counterId || !mode || !team) continue;
    if (!output.counters[mode]) output.counters[mode] = {};
    if (!output.counters[mode][team]) output.counters[mode][team] = [];
    output.counters[mode][team].push({
      counterId,
      counter: entry["Counter Team"],
      tier: entry.Tier,
      bannerScore: entry["Banner Score"],
      undersize: parseUndersize(entry.Undersize),
      notes: entry.Notes
    });
  }

  const counterDefsHeaders = counterDefsData[0];
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
    if (!output.counterDefinitions[counterId]) {
      output.counterDefinitions[counterId] = { name: counterId, required: [], recommended: [] };
    }
    if (role === "REQUIRED") output.counterDefinitions[counterId].required.push(characterId);
    else if (role === "RECOMMENDED") output.counterDefinitions[counterId].recommended.push(characterId);
  }

  const charHeaders = characterDefsData[0];
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

  output.boardConfig = tabs.GAC_Board_Config ? buildBoardConfig(dataRange(tabs.GAC_Board_Config)) : {};
  output.scoring = tabs.GAC_Scoring ? buildScoring(dataRange(tabs.GAC_Scoring)) : [];
  output.defenceTeams = tabs.Defence_Teams ? buildDefenceTeams(dataRange(tabs.Defence_Teams)) : {};
  output.defenceCompositions = tabs.Defence_Composition ? buildDefenceCompositions(dataRange(tabs.Defence_Composition)) : {};
  return output;
}

// Counter_IDs that Code.gs synthesises a placeholder definition for (name = ID)
// because Counter_Composition names them without a Counter_Definitions row.
// The Git-native validator treats these as errors; they cannot be seen in an
// `action=data` capture, only in the Sheet tabs.
function synthesisedCounterIds(tabs) {
  const defined = new Set(dataRange(tabs.Counter_Definitions).slice(1).map((row) => String(row[0]).trim()).filter(Boolean));
  const synthesised = new Set();
  for (const row of dataRange(tabs.Counter_Composition).slice(1)) {
    const counterId = String(row[0]).trim();
    if (counterId && String(row[1]).trim() && !defined.has(counterId)) synthesised.add(counterId);
  }
  return [...synthesised].sort();
}

module.exports = {
  CATALOGUE_TABS,
  REQUIRED_TABS,
  buildAppsScriptPayload,
  parseReserveFlag,
  parseUndersize,
  sheetCell,
  synthesisedCounterIds
};
