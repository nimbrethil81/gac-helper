"use strict";

// A small, valid, fully synthetic catalogue snapshot for audit regressions.
// It deliberately includes legitimate shapes the audit must accept: 3v3, 5v5
// and FLEET matchups, a recommended-only member, a counter with no members, a
// partial defence composition, a defence-only identity, sparse threat ratings,
// an ANY threat row and a cross-mode name variant.

const { emulateActionData } = require("../scripts/catalogue-audit-lib.js");

const MEANINGS = {
  "5v5|62": "Standard clean win — some damage, no losses",
  "5v5|61": "Occasionally lose a unit",
  "5v5|60": "Reliable but inefficient — usually lose a unit",
  "3v3|54": "Standard clean win — some damage, no losses",
  "3v3|50": "Risky — often lose two",
  "FLEET|73": "Flawless — all 7 ships survive, full health & protection"
};

const COUNTER_NAMES = {
  LEIA: "Leia Organa",
  REVA: "Reva",
  GUNGANS: "Gungans",
  EXECUTOR: "Executor",
  FLEX: "Flexible Squad"
};

function counterRow(mode, defence, counterId, tier, bannerScore, undersize, notes = "") {
  return [mode, defence, counterId, COUNTER_NAMES[counterId] ?? "", tier, bannerScore, MEANINGS[`${mode}|${bannerScore}`] ?? "", undersize, notes];
}

function tab(grid, extra = {}) {
  return { grid, formulas: [], errors: [], typed: true, formulaMetadata: true, ...extra };
}

function boardGrid() {
  const grid = [["League", "Mode", "Territory", "Territory_Type", "Team_Count"]];
  for (const league of ["KYBER", "AURODIUM", "CHROMIUM", "BRONZIUM", "CARBONITE"]) {
    for (const mode of ["5v5", "3v3"]) {
      grid.push([league, mode, "FRONT_TOP", "SQUAD", 4]);
      grid.push([league, mode, "FRONT_BOTTOM", "SQUAD", 4]);
      grid.push([league, mode, "BACK_TOP", "FLEET", 3]);
      grid.push([league, mode, "BACK_BOTTOM", "SQUAD", 3]);
    }
  }
  return grid;
}

function validSnapshot() {
  const counters = [
    ["Mode", "Defence Team", "Counter_ID", "Counter Team", "Tier", "Banner Score", "Score Meaning", "Undersize", "Notes"],
    counterRow("5v5", "Gungans", "LEIA", "S", 62, 0, "Strong"),
    counterRow("5v5", "Gungans", "REVA", "A", 61, 1),
    counterRow("3v3", "Gungans", "GUNGANS", "B", 54, 2),
    counterRow("3v3", "Geonosian", "FLEX", "C", 50, 0),
    counterRow("5v5", "Geonosians", "LEIA", "A", 60, 4),
    counterRow("5v5", "Rey", "LEIA", "S", 62, 0),
    counterRow("5v5", "Rex", "REVA", "S", 62, 0),
    counterRow("FLEET", "Home One", "EXECUTOR", "S", 73, 6)
  ];

  const snapshot = {
    format: "test-fixture",
    capturedAt: "2026-10-10T00:00:00Z",
    source: { method: "test" },
    actionData: null,
    tabs: {
      Counters: tab(counters, {
        formulas: [
          { cell: "D2", formula: "=IF(C2:C1001=\"\",\"\",IFERROR(VLOOKUP(C2:C1001,Counter_Definitions!A:B,2,FALSE),\"\"))", type: "array", ref: "D2:D1001" },
          { cell: "G2", formula: "=IF(A2:A1001=\"\",\"\",IFERROR(VLOOKUP(A2:A1001&\"|\"&F2:F1001,{Score_Meanings!$A$2:$A1001&\"|\"&Score_Meanings!$B$2:$B1001,Score_Meanings!$C$2:$C1001},2,FALSE),\"\"))", type: "array", ref: "G2:G1001" }
        ]
      }),
      Counter_Definitions: tab([
        ["Counter_ID", "Counter Team", "Strategic_Reserve"],
        ["LEIA", "Leia Organa", true],
        ["REVA", "Reva", ""],
        ["GUNGANS", "Gungans", false],
        ["EXECUTOR", "Executor", "No"],
        ["FLEX", "Flexible Squad", ""]
      ]),
      Counter_Composition: tab([
        ["Counter_ID", "Character_ID", "Role"],
        ["LEIA", "LEIA_ORGANA", "REQUIRED"],
        ["LEIA", "R2_D2", "RECOMMENDED"],
        ["REVA", "THIRD_SISTER", "REQUIRED"],
        ["GUNGANS", "BOSS_NASS", "REQUIRED"],
        ["GUNGANS", "JAR_JAR", "RECOMMENDED"],
        ["EXECUTOR", "EXECUTOR_SHIP", "REQUIRED"],
        ["EXECUTOR", "TIE_FIGHTER", "RECOMMENDED"]
      ]),
      Character_Definitions: tab([
        ["Character_ID", "Character_Name", "Unit_Type", "External_ID"],
        ["LEIA_ORGANA", "Leia Organa", "CHARACTER", "GLLEIA"],
        ["R2_D2", "R2-D2", "CHARACTER", "R2D2_LEGENDARY"],
        ["THIRD_SISTER", "Third Sister", "CHARACTER", "THIRDSISTER"],
        ["BOSS_NASS", "Boss Nass", "CHARACTER", "BOSSNASS"],
        ["JAR_JAR", "Jar Jar Binks", "CHARACTER", "JARJARBINKS"],
        ["EXECUTOR_SHIP", "Executor", "CAPITAL_SHIP", "CAPITALEXECUTOR"],
        ["TIE_FIGHTER", "TIE Fighter", "SHIP", "TIEFIGHTERIMPERIAL"],
        ["CHIEF_CHIRPA", "Chief Chirpa", "CHARACTER", "CHIEFCHIRPA"],
        ["WICKET", "Wicket", "CHARACTER", "WICKET"]
      ]),
      Defence_Teams: tab([
        ["Defence_Team", "Mode", "Threat", "Notes"],
        ["Gungans", "5v5", "HIGH", ""],
        ["Home One", "ANY", "EXTREME", ""]
      ]),
      Defence_Composition: tab([
        ["Defence_Team", "Mode", "Character_ID"],
        ["Gungans", "5v5", "BOSS_NASS"],
        ["Chief Chirpa", "3v3", "CHIEF_CHIRPA"],
        ["Chief Chirpa", "3v3", "WICKET"]
      ]),
      Score_Meanings: tab([
        ["Mode", "Score", "Meaning"],
        ...Object.entries(MEANINGS).map(([key, meaning]) => {
          const [mode, score] = key.split("|");
          return [mode, Number(score), meaning];
        })
      ]),
      GAC_Board_Config: tab(boardGrid()),
      GAC_Scoring: tab([
        ["Rule_ID", "Battle_Type", "Mode", "Value", "Notes"],
        ["VICTORY", "ANY", "ANY", 15, "Per battle won"],
        ["SETTING_DEFENCE", "ANY", "ANY", 90, "Per defence team set"],
        ["OWN_UNITS", "FLEET", "ANY", 7, ""],
        ["TERRITORY_CLEAR_PER_TEAM", "SQUAD", "5v5", 30, ""]
      ])
    }
  };
  return snapshot;
}

// Attach a captured action=data payload equal to what Code.gs would serve.
function withCapture(snapshot) {
  snapshot.actionData = { capturedAt: snapshot.capturedAt, payload: JSON.parse(JSON.stringify(emulateActionData(snapshot.tabs))) };
  return snapshot;
}

module.exports = { COUNTER_NAMES, MEANINGS, counterRow, validSnapshot, withCapture };
