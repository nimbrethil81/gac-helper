"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const REQUIRED_PAYLOAD_KEYS = [
  "counters",
  "counterDefinitions",
  "characterDefinitions",
  "boardConfig",
  "scoring",
  "defenceTeams",
  "defenceCompositions"
];

const REQUIRED_PAYLOAD_TYPES = {
  counters: "object",
  counterDefinitions: "object",
  characterDefinitions: "object",
  boardConfig: "object",
  scoring: "array",
  defenceTeams: "object",
  defenceCompositions: "object"
};

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function semanticJsonEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (fieldStarted || field.length > 0) {
        throw new Error(`Unexpected quote at character ${index}`);
      }
      inQuotes = true;
      fieldStarted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (inQuotes) throw new Error("Unterminated quoted CSV field");
  if (field.length > 0 || fieldStarted || row.length > 0 || text.endsWith(",")) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function countPayloadDomains(payload) {
  const countersByMode = {};
  let counterRows = 0;
  let counterDefences = 0;
  for (const [mode, teams] of Object.entries(payload.counters)) {
    let rows = 0;
    const teamNames = Object.keys(teams);
    for (const entries of Object.values(teams)) rows += entries.length;
    countersByMode[mode] = { defenceTeams: teamNames.length, rows };
    counterRows += rows;
    counterDefences += teamNames.length;
  }

  const boardRowsByLeagueMode = {};
  let boardRows = 0;
  for (const [league, modes] of Object.entries(payload.boardConfig)) {
    boardRowsByLeagueMode[league] = {};
    for (const [mode, rows] of Object.entries(modes)) {
      boardRowsByLeagueMode[league][mode] = rows.length;
      boardRows += rows.length;
    }
  }

  const defenceTeamRowsByMode = {};
  let defenceTeamRows = 0;
  for (const [mode, teams] of Object.entries(payload.defenceTeams)) {
    defenceTeamRowsByMode[mode] = Object.keys(teams).length;
    defenceTeamRows += defenceTeamRowsByMode[mode];
  }

  const defenceCompositionTeamsByMode = {};
  let defenceCompositionTeams = 0;
  let defenceCompositionMembers = 0;
  for (const [mode, teams] of Object.entries(payload.defenceCompositions)) {
    defenceCompositionTeamsByMode[mode] = Object.keys(teams).length;
    defenceCompositionTeams += defenceCompositionTeamsByMode[mode];
    for (const members of Object.values(teams)) {
      defenceCompositionMembers += members.length;
    }
  }

  return {
    counters: {
      rows: counterRows,
      defenceTeams: counterDefences,
      byMode: countersByMode
    },
    counterDefinitions: Object.keys(payload.counterDefinitions).length,
    characterDefinitions: Object.keys(payload.characterDefinitions).length,
    boardConfig: {
      rows: boardRows,
      byLeagueMode: boardRowsByLeagueMode
    },
    scoring: payload.scoring.length,
    defenceTeams: {
      rows: defenceTeamRows,
      byMode: defenceTeamRowsByMode
    },
    defenceCompositions: {
      teams: defenceCompositionTeams,
      members: defenceCompositionMembers,
      teamsByMode: defenceCompositionTeamsByMode
    }
  };
}

function assertPayloadContract(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Raw payload must be a JSON object");
  }

  const keys = Object.keys(payload);
  const missing = REQUIRED_PAYLOAD_KEYS.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !REQUIRED_PAYLOAD_KEYS.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`Payload keys differ (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }

  for (const [key, expected] of Object.entries(REQUIRED_PAYLOAD_TYPES)) {
    const actual = Array.isArray(payload[key])
      ? "array"
      : payload[key] && typeof payload[key] === "object"
        ? "object"
        : typeof payload[key];
    if (actual !== expected) {
      throw new Error(`Payload key ${key} must be ${expected}, got ${actual}`);
    }
  }
}

function listFilesRecursively(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

module.exports = {
  REQUIRED_PAYLOAD_KEYS,
  REQUIRED_PAYLOAD_TYPES,
  assertPayloadContract,
  canonicalJson,
  countPayloadDomains,
  listFilesRecursively,
  parseCsv,
  semanticJsonEqual,
  sha256,
  sortJson
};
