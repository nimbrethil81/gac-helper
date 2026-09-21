#!/usr/bin/env node
"use strict";

// ARCH-107 dry run. Applies a change file to a disposable development database
// inside a transaction, reports the exact canonical and payload effects, and
// rolls the transaction back, so nothing is written anywhere.
//
// The output is the candidate canonical state a publisher would later turn into
// a release. ARCH-107 stops here deliberately: payload schema versioning,
// checksums, release records and publication are ARCH-108's.

const fs = require("node:fs");
const path = require("node:path");

const { readChangeFile } = require("./authoring-lib.js");
const { applyChange, openAuthoringDatabase } = require("./authoring-load.js");

function formatValue(value) {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

// diffPayloads compares arrays atomically, which is exact but unreadable for a
// counters list. Render the entries that actually joined or left instead; the
// --json output still carries the complete before and after arrays.
function renderPayloadEntry(entry) {
  if (!Array.isArray(entry.before) || !Array.isArray(entry.after)) {
    return [`- \`${entry.path}\`: ${formatValue(entry.before)} → ${formatValue(entry.after)}`];
  }
  const before = entry.before.map((item) => JSON.stringify(item));
  const after = entry.after.map((item) => JSON.stringify(item));
  const removed = difference(before, after);
  const added = difference(after, before);
  const lines = [`- \`${entry.path}\`: ${before.length} → ${after.length} entries`];
  for (const item of removed) lines.push(`  - removed: ${item}`);
  for (const item of added) lines.push(`  - added: ${item}`);
  if (removed.length === 0 && added.length === 0) lines.push("  - reordered only");
  return lines;
}

function difference(left, right) {
  const remaining = [...right];
  const only = [];
  for (const item of left) {
    const index = remaining.indexOf(item);
    if (index === -1) only.push(item);
    else remaining.splice(index, 1);
  }
  return only;
}

function renderDryRun(change, result) {
  const lines = [];
  lines.push(`# ARCH-107 dry run — ${result.changeId}`);
  lines.push("");
  lines.push(`- Change file: ${change.source}`);
  lines.push(`- Author: ${change.author} (${change.author_role})`);
  lines.push(`- Authored at: ${change.authored_at}`);
  lines.push(`- Reason: ${change.reason}`);
  lines.push(`- Expected base release: ${formatValue(result.baseRelease.expected)}`);
  lines.push(`- Current base release: ${formatValue(result.baseRelease.current)}`);
  lines.push(`- Committed: no (dry run)`);
  lines.push("");

  lines.push("## Canonical effect");
  lines.push("");
  if (result.canonicalDiff.length === 0) {
    lines.push("No canonical row changes. The catalogue already matches this change.");
  } else {
    for (const entry of result.canonicalDiff) {
      lines.push(`### ${entry.operation} ${entry.table} — ${entry.key}`);
      lines.push("");
      if (entry.operation === "INSERT") {
        for (const column of entry.columns) lines.push(`- ${column}: ${formatValue(entry.after[column])}`);
      } else if (entry.operation === "DELETE") {
        for (const column of entry.columns) lines.push(`- ${column}: ${formatValue(entry.before[column])} → (removed)`);
      } else {
        for (const column of entry.columns) {
          lines.push(`- ${column}: ${formatValue(entry.before[column])} → ${formatValue(entry.after[column])}`);
        }
      }
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## Payload effect");
  lines.push("");
  lines.push(
    "Projected with the ARCH-106 compatibility projection of the current seven-key catalogue contract."
  );
  lines.push("");
  if (result.payloadDiff.length === 0) {
    lines.push("No payload changes.");
  } else {
    for (const entry of result.payloadDiff) lines.push(...renderPayloadEntry(entry));
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { change: null, dataDir: null, out: null, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--change") options.change = argv[++index];
    else if (arg === "--data-dir") options.dataDir = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--json") options.json = argv[++index];
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  if (options.change === null) throw new Error("--change <path> is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const change = readChangeFile(options.change);
  const database = await openAuthoringDatabase({ dataDir: options.dataDir });
  try {
    const result = await applyChange(database, change, { dryRun: true });
    if (result.committed) throw new Error("A dry run must never commit");

    const markdown = renderDryRun(change, result);
    if (options.out === null) {
      console.log(markdown);
    } else {
      fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      fs.writeFileSync(path.resolve(options.out), markdown);
      console.log(`ARCH-107 dry run: wrote ${options.out}`);
    }
    if (options.json !== null) {
      fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
      fs.writeFileSync(path.resolve(options.json), `${JSON.stringify({
        changeId: result.changeId,
        baseRelease: result.baseRelease,
        canonicalDiff: result.canonicalDiff,
        payloadDiff: result.payloadDiff,
        candidatePayload: result.payloadAfter
      }, null, 2)}\n`);
      console.log(`ARCH-107 dry run: wrote ${options.json}`);
    }
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ARCH-107 dry run failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { renderDryRun };
