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

function validateRelativePath(filename, label = "Manifest filename") {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (filename.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  if (path.posix.isAbsolute(filename)) throw new Error(`${label} must not be an absolute POSIX path: ${filename}`);
  if (path.win32.isAbsolute(filename)) throw new Error(`${label} must not be an absolute Windows path: ${filename}`);
  if (/^[A-Za-z]:/.test(filename)) throw new Error(`${label} must not be a Windows drive-relative path: ${filename}`);
  if (filename.includes("\\")) throw new Error(`${label} must not contain backslashes: ${filename}`);

  const segments = filename.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain . or .. segments: ${filename}`);
  }

  return path.posix.normalize(filename);
}

function resolveCaptureRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("Capture root must be a non-empty string");
  }

  const requestedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = fs.lstatSync(requestedRoot);
  } catch (error) {
    throw new Error(`Capture root is unavailable: ${requestedRoot} (${error.message})`);
  }
  if (rootStat.isSymbolicLink()) throw new Error(`Capture root must not be a symbolic link: ${requestedRoot}`);
  if (!rootStat.isDirectory()) throw new Error(`Capture root is not a directory: ${requestedRoot}`);

  return fs.realpathSync(requestedRoot);
}

function resolveRegularFile(root, filename) {
  const relativePath = validateRelativePath(filename);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  const containment = path.relative(root, absolutePath);
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error(`Manifest filename resolves outside capture root: ${filename}`);
  }

  const segments = relativePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let entryStat;
    try {
      entryStat = fs.lstatSync(current);
    } catch (error) {
      throw new Error(`Missing listed file: ${filename} (${error.message})`);
    }
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in baseline paths: ${relativePath}`);
    }
    if (index < segments.length - 1 && !entryStat.isDirectory()) {
      throw new Error(`Baseline path component is not a directory: ${segments.slice(0, index + 1).join("/")}`);
    }
    if (index === segments.length - 1 && !entryStat.isFile()) {
      throw new Error(`Listed baseline path is not a regular file: ${relativePath}`);
    }
  }

  return { absolutePath, relativePath };
}

function listFilesRecursively(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const validatedRelative = validateRelativePath(relative, "Baseline entry path");
    const absolute = path.join(directory, entry.name);
    const entryStat = fs.lstatSync(absolute);
    if (entryStat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in baseline: ${validatedRelative}`);
    if (entryStat.isDirectory()) {
      files.push(...listFilesRecursively(absolute, validatedRelative));
    } else if (entryStat.isFile()) {
      files.push(validatedRelative);
    } else {
      throw new Error(`Non-regular filesystem object is not allowed in baseline: ${validatedRelative}`);
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
  resolveCaptureRoot,
  resolveRegularFile,
  semanticJsonEqual,
  sha256,
  sortJson,
  validateRelativePath
};
