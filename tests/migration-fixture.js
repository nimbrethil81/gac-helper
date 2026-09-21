"use strict";

// Builds small synthetic ARCH-103-shaped capture directories for the ARCH-106
// negative tests, so a rejection case never needs the real committed fixture to
// be edited. The generated manifest carries real byte sizes and SHA-256 values,
// so these fixtures pass the same baseline verifier as the committed capture.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { canonicalJson, countPayloadDomains, sha256 } = require("../scripts/baseline-lib.js");

const TAB_FILES = {
  Counters: "sheets/Counters.csv",
  Defence_Teams: "sheets/Defence_Teams.csv",
  Score_Meanings: "sheets/Score_Meanings.csv",
  Counter_Definitions: "sheets/Counter_Definitions.csv",
  Counter_Composition: "sheets/Counter_Composition.csv",
  Character_Definitions: "sheets/Character_Definitions.csv",
  GAC_Board_Config: "sheets/GAC_Board_Config.csv",
  GAC_Scoring: "sheets/GAC_Scoring.csv"
};

const HEADERS = {
  Counters: ["Mode", "Defence Team", "Counter_ID", "Counter Team", "Tier", "Banner Score", "Score Meaning", "Undersize", "Notes"],
  Defence_Teams: ["Defence_Team", "Mode", "Threat", "Notes"],
  Score_Meanings: ["Mode", "Score", "Meaning"],
  Counter_Definitions: ["Counter_ID", "Counter Team"],
  Counter_Composition: ["Counter_ID", "Character_ID", "Role"],
  Character_Definitions: ["Character_ID", "Character_Name", "Unit_Type", "External_ID"],
  GAC_Board_Config: ["League", "Mode", "Territory", "Territory_Type", "Team_Count"],
  GAC_Scoring: ["Rule_ID", "Battle_Type", "Mode", "Value", "Notes"]
};

function encodeCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(tab, rows) {
  const headers = HEADERS[tab];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => encodeCell(row[header])).join(","));
  return `${lines.join("\n")}\n`;
}

// Mirror the parts of the legacy Apps Script the golden payload depends on, so
// a synthetic fixture's payload is consistent with its own CSV rows.
function buildPayload(sheets) {
  const payload = {
    counters: { "5v5": {}, "3v3": {} },
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };

  for (const row of sheets.Counters ?? []) {
    const mode = row.Mode;
    const team = row["Defence Team"];
    if (!payload.counters[mode]) payload.counters[mode] = {};
    if (!payload.counters[mode][team]) payload.counters[mode][team] = [];
    payload.counters[mode][team].push({
      counterId: row.Counter_ID,
      counter: row["Counter Team"],
      tier: row.Tier,
      bannerScore: Number(row["Banner Score"]),
      undersize: Number(row.Undersize) || 0,
      notes: row.Notes ?? ""
    });
  }
  for (const row of sheets.Counter_Definitions ?? []) {
    payload.counterDefinitions[row.Counter_ID] = { name: row["Counter Team"], required: [], recommended: [] };
  }
  for (const row of sheets.Counter_Composition ?? []) {
    if (!payload.counterDefinitions[row.Counter_ID]) {
      payload.counterDefinitions[row.Counter_ID] = { name: row.Counter_ID, required: [], recommended: [] };
    }
    const list = row.Role === "REQUIRED" ? "required" : "recommended";
    payload.counterDefinitions[row.Counter_ID][list].push(row.Character_ID);
  }
  for (const row of sheets.Character_Definitions ?? []) {
    payload.characterDefinitions[row.Character_ID] = {
      name: row.Character_Name,
      unitType: row.Unit_Type,
      externalId: row.External_ID ?? ""
    };
  }
  for (const row of sheets.GAC_Board_Config ?? []) {
    if (!payload.boardConfig[row.League]) payload.boardConfig[row.League] = {};
    if (!payload.boardConfig[row.League][row.Mode]) payload.boardConfig[row.League][row.Mode] = [];
    payload.boardConfig[row.League][row.Mode].push({
      territory: row.Territory,
      type: row.Territory_Type,
      teamCount: Number(row.Team_Count)
    });
  }
  for (const row of sheets.GAC_Scoring ?? []) {
    payload.scoring.push({
      ruleId: row.Rule_ID,
      battleType: row.Battle_Type,
      mode: row.Mode,
      value: Number(row.Value),
      notes: row.Notes ?? ""
    });
  }
  for (const row of sheets.Defence_Teams ?? []) {
    const mode = row.Mode || "ANY";
    if (!payload.defenceTeams[mode]) payload.defenceTeams[mode] = {};
    payload.defenceTeams[mode][row.Defence_Team] = {
      threat: String(row.Threat ?? "").toUpperCase(),
      notes: row.Notes ?? ""
    };
  }
  return payload;
}

// Returns the capture root. Callers remove it with fs.rmSync when done.
function writeFixture(sheets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch106-fixture-"));
  fs.mkdirSync(path.join(root, "sheets"));

  const payload = buildPayload(sheets);
  const rawBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const canonicalBytes = Buffer.from(canonicalJson(payload), "utf8");
  fs.writeFileSync(path.join(root, "apps-script-action-data.raw.json"), rawBytes);
  fs.writeFileSync(path.join(root, "apps-script-action-data.canonical.json"), canonicalBytes);

  const sheetExports = [];
  const sheetDataRows = {};
  for (const [tab, filename] of Object.entries(TAB_FILES)) {
    const rows = sheets[tab] ?? [];
    const bytes = Buffer.from(toCsv(tab, rows), "utf8");
    fs.writeFileSync(path.join(root, filename), bytes);
    sheetDataRows[tab] = rows.length;
    sheetExports.push({
      byteSize: bytes.length,
      classification: "synthetic test fixture",
      dataRowCount: rows.length,
      derivedColumns: [],
      filename,
      headers: HEADERS[tab],
      representation: "synthetic",
      sha256: sha256(bytes),
      stableIdentifiers: [],
      tabName: tab
    });
  }

  const reportBytes = Buffer.from("# Synthetic ARCH-106 test fixture\n", "utf8");
  fs.writeFileSync(path.join(root, "capture-report.md"), reportBytes);

  const manifest = {
    aggregateRowCounts: {
      sheetDataRows,
      sheetDataRowsTotal: Object.values(sheetDataRows).reduce((total, rows) => total + rows, 0),
      sourceDomains: {}
    },
    appsScriptPayload: {
      canonicalByteSize: canonicalBytes.length,
      canonicalFilename: "apps-script-action-data.canonical.json",
      canonicalSha256: sha256(canonicalBytes),
      domainCounts: countPayloadDomains(payload),
      rawByteSize: rawBytes.length,
      rawFilename: "apps-script-action-data.raw.json",
      rawSha256: sha256(rawBytes),
      responseMetadata: { contentType: "application/json; charset=utf-8", httpStatus: 200 },
      topLevelKeys: [
        "counters", "counterDefinitions", "characterDefinitions",
        "boardConfig", "scoring", "defenceTeams", "defenceCompositions"
      ]
    },
    captureTimestamp: "2026-09-21T08:59:37Z",
    integrity: { redactionPerformed: false, semanticTransformationPerformed: false },
    report: { byteSize: reportBytes.length, filename: "capture-report.md", sha256: sha256(reportBytes) },
    schemaVersion: 1,
    sheetExports,
    sourceLimitations: [],
    sourceRepositorySha: "0000000000000000000000000000000000000000",
    sourceWorkbook: { absentOptionalTabs: ["Defence_Composition"], excludedTabs: [], title: "Synthetic" }
  };
  fs.writeFileSync(path.join(root, "manifest.json"), canonicalJson(manifest));

  return root;
}

// A minimal but internally consistent fixture the caller can mutate before
// writing, so each negative test changes exactly one thing.
function baseSheets() {
  return {
    Character_Definitions: [
      { Character_ID: "UNIT_ONE", Character_Name: "Unit One", Unit_Type: "CHARACTER", External_ID: "UNITONE" },
      { Character_ID: "UNIT_TWO", Character_Name: "Unit Two", Unit_Type: "CHARACTER", External_ID: "UNITTWO" }
    ],
    Counter_Definitions: [
      { Counter_ID: "ALPHA", "Counter Team": "Alpha" },
      { Counter_ID: "BETA", "Counter Team": "Beta" }
    ],
    Counter_Composition: [
      { Counter_ID: "ALPHA", Character_ID: "UNIT_ONE", Role: "REQUIRED" },
      { Counter_ID: "BETA", Character_ID: "UNIT_TWO", Role: "REQUIRED" }
    ],
    Counters: [
      {
        Mode: "5v5", "Defence Team": "Alpha", Counter_ID: "BETA", "Counter Team": "Beta",
        Tier: "S", "Banner Score": "62", "Score Meaning": "", Undersize: "0", Notes: "Lead with Unit Two."
      },
      {
        Mode: "3v3", "Defence Team": "Custom Defence", Counter_ID: "ALPHA", "Counter Team": "Alpha",
        Tier: "A", "Banner Score": "54", "Score Meaning": "", Undersize: "1", Notes: ""
      }
    ],
    Defence_Teams: [
      { Defence_Team: "Alpha", Mode: "Any", Threat: "High", Notes: "" }
    ],
    Score_Meanings: [],
    GAC_Board_Config: [
      { League: "KYBER", Mode: "5v5", Territory: "FRONT_TOP", Territory_Type: "SQUAD", Team_Count: "4" },
      { League: "KYBER", Mode: "5v5", Territory: "FRONT_BOTTOM", Territory_Type: "SQUAD", Team_Count: "4" }
    ],
    GAC_Scoring: [
      { Rule_ID: "VICTORY", Battle_Type: "ANY", Mode: "ANY", Value: "15", Notes: "Per battle won" }
    ]
  };
}

module.exports = { HEADERS, baseSheets, buildPayload, toCsv, writeFixture };
