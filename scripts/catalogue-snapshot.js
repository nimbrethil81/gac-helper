#!/usr/bin/env node
"use strict";

// Create a timestamped, read-only catalogue snapshot from an operator-supplied
// Google Sheets .xlsx export (File → Download → Microsoft Excel) and, where
// available, a saved Apps Script action=data response.
//
//   node scripts/catalogue-snapshot.js --xlsx <workbook.xlsx> --captured-at <ISO>
//     [--action-data <response.json> --action-data-captured-at <ISO>]
//     [--workbook-modified-at <ISO>] [--out data/snapshots/<stamp>]
//
// Only the nine catalogue tabs are decoded; personal tabs (Roster, GAC History)
// are never parsed or written. No network access, no credentials, and the
// workbook file itself is never modified or copied.

const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./baseline-lib.js");
const { openWorkbook } = require("./xlsx-lib.js");
const { CATALOGUE_TABS, EXCLUDED_PERSONAL_TABS, SNAPSHOT_KIND, SNAPSHOT_SCHEMA } = require("./catalogue-audit-lib.js");

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--xlsx") options.xlsx = take();
    else if (arg === "--captured-at") options.capturedAt = take();
    else if (arg === "--action-data") options.actionData = take();
    else if (arg === "--action-data-captured-at") options.actionDataCapturedAt = take();
    else if (arg === "--workbook-modified-at") options.workbookModifiedAt = take();
    else if (arg === "--workbook-title") options.workbookTitle = take();
    else if (arg === "--out") options.out = take();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.xlsx) throw new Error("--xlsx is required");
  for (const key of ["capturedAt", "actionDataCapturedAt", "workbookModifiedAt"]) {
    if (options[key] !== undefined && !ISO_UTC.test(options[key])) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be an ISO-8601 UTC timestamp`);
  }
  if (!options.capturedAt) throw new Error("--captured-at is required (when the workbook export was downloaded)");
  if (options.actionData && !options.actionDataCapturedAt) throw new Error("--action-data-captured-at is required with --action-data");
  return options;
}

function stampOf(iso) {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// One grid row per line keeps snapshot diffs reviewable.
function serialiseTab(tab) {
  const rows = tab.grid.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return [
    "{",
    `  "tab": ${JSON.stringify(tab.name)},`,
    `  "formulas": ${JSON.stringify(tab.formulas)},`,
    `  "errors": ${JSON.stringify(tab.errors)},`,
    `  "grid": [\n${rows}\n  ]`,
    "}",
    ""
  ].join("\n");
}

// Trailing all-empty rows are dropped: Code.gs skips them, and they would only
// bloat the snapshot. The reported grid extent is kept in the manifest.
function trimGrid(grid) {
  let end = grid.length;
  while (end > 1 && grid[end - 1].every((value) => value === "")) end -= 1;
  return grid.slice(0, end);
}

function createSnapshot(options) {
  const workbook = openWorkbook(fs.readFileSync(options.xlsx));
  const out = path.resolve(options.out ?? path.join("data", "snapshots", stampOf(options.capturedAt)));
  if (fs.existsSync(out)) throw new Error(`Refusing to overwrite existing snapshot: ${out}`);

  const tabs = [];
  const files = [];
  for (const name of CATALOGUE_TABS) {
    const sheet = workbook.readSheet(name);
    if (!sheet) continue;
    const grid = trimGrid(sheet.grid);
    const text = serialiseTab({ name, grid, formulas: sheet.formulas, errors: sheet.errors });
    const file = `tabs/${name}.json`;
    files.push([file, text]);
    tabs.push({ tab: name, file, bytes: Buffer.byteLength(text), sha256: sha256(text), reportedGridRows: sheet.grid.length, gridRows: grid.length });
  }

  let actionData;
  if (options.actionData) {
    const bytes = fs.readFileSync(options.actionData);
    JSON.parse(bytes.toString("utf8"));
    files.push(["action-data.raw.json", bytes]);
    actionData = { file: "action-data.raw.json", capturedAt: options.actionDataCapturedAt, bytes: bytes.length, sha256: sha256(bytes) };
  }

  const manifest = {
    kind: SNAPSHOT_KIND,
    schema: SNAPSHOT_SCHEMA,
    capturedAt: options.capturedAt,
    source: {
      method: "xlsx-export",
      ...(options.workbookTitle ? { workbook: options.workbookTitle } : {}),
      ...(options.workbookModifiedAt ? { workbookModifiedAt: options.workbookModifiedAt } : {})
    },
    excludedPersonalTabs: [...EXCLUDED_PERSONAL_TABS],
    missingCatalogueTabs: CATALOGUE_TABS.filter((name) => !tabs.some((tab) => tab.tab === name)),
    tabs,
    ...(actionData ? { actionData } : {})
  };

  fs.mkdirSync(path.join(out, "tabs"), { recursive: true });
  for (const [file, content] of files) fs.writeFileSync(path.join(out, file), content);
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest, workbookTabs: workbook.sheetNames };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { out, manifest } = createSnapshot(options);
  console.log(`Snapshot written: ${path.relative(process.cwd(), out)}`);
  for (const tab of manifest.tabs) console.log(`  ${tab.tab}: ${tab.gridRows - 1} rows (sheet extent ${tab.reportedGridRows - 1})`);
  if (manifest.missingCatalogueTabs.length) console.log(`  Missing catalogue tabs: ${manifest.missingCatalogueTabs.join(", ")}`);
  if (manifest.actionData) console.log(`  action=data: ${manifest.actionData.bytes} bytes`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Snapshot failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createSnapshot, parseArgs, serialiseTab, trimGrid };
