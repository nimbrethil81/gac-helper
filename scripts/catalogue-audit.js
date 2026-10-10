#!/usr/bin/env node
"use strict";

// Read-only catalogue integrity and parity audit (issue #34).
//
//   node scripts/catalogue-audit.js <snapshot-dir>            audit a Sheet snapshot
//   node scripts/catalogue-audit.js --payload <payload.json>  audit any seven-key payload
//
// Options:
//   --gate parity|release   parity (default) reports and exits 0; release exits 1
//                           on any blocking or owner-approval finding.
//   --max-age-days <n>      exit 1 if the snapshot is older than n days.
//   --now <ISO>             reference time for --max-age-days (default: now).
//   --json <file>           write the JSON report.
//   --markdown <file>       write the Markdown report.
//
// Exit codes: 0 ok, 1 gate failed or stale, 2 unreadable/corrupt input.

const fs = require("node:fs");
const path = require("node:path");

const { auditPayload, auditSnapshot, loadSnapshot, renderMarkdown } = require("./catalogue-audit-lib.js");

function parseArgs(argv) {
  const options = { gate: "parity" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--payload") options.payload = take();
    else if (arg === "--gate") options.gate = take();
    else if (arg === "--max-age-days") options.maxAgeDays = Number(take());
    else if (arg === "--now") options.now = take();
    else if (arg === "--json") options.json = take();
    else if (arg === "--markdown") options.markdown = take();
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.snapshot) throw new Error("Only one snapshot directory may be given");
    else options.snapshot = arg;
  }
  if (!["parity", "release"].includes(options.gate)) throw new Error("--gate must be parity or release");
  if (Boolean(options.snapshot) === Boolean(options.payload)) throw new Error("Give exactly one of <snapshot-dir> or --payload <file>");
  if (options.maxAgeDays !== undefined && !(options.maxAgeDays >= 0)) throw new Error("--max-age-days must be a non-negative number");
  return options;
}

function run(options) {
  let report;
  try {
    report = options.snapshot
      ? auditSnapshot(loadSnapshot(options.snapshot))
      : auditPayload(JSON.parse(fs.readFileSync(options.payload, "utf8")), { label: path.basename(options.payload) });
  } catch (error) {
    return { exitCode: 2, lines: [`Audit input rejected: ${error.message}`] };
  }

  const markdown = renderMarkdown(report);
  if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) fs.writeFileSync(options.markdown, markdown);

  const { bySeverity, releaseGate } = report.summary;
  const lines = [
    `Input: ${report.input.kind === "sheet-snapshot" ? `snapshot captured ${report.input.capturedAt}` : report.input.label}`,
    `Findings: ${bySeverity.blocking} blocking, ${bySeverity["owner-approval"]} owner-approval, ${bySeverity.warning} warning, ${bySeverity.info} info`,
    `Parity: ${report.parity.status}${report.parity.differences ? ` (${report.parity.differences} differences)` : ""}`,
    `Release gate: ${releaseGate}`
  ];
  let exitCode = 0;

  if (options.maxAgeDays !== undefined) {
    const capturedAt = Date.parse(report.input.capturedAt ?? "");
    const now = options.now ? Date.parse(options.now) : Date.now();
    const ageDays = (now - capturedAt) / 86400000;
    if (!Number.isFinite(ageDays)) {
      lines.push("Freshness: UNKNOWN (no capture timestamp)");
      exitCode = 1;
    } else {
      const stale = ageDays > options.maxAgeDays;
      lines.push(`Freshness: ${ageDays.toFixed(1)} days old (limit ${options.maxAgeDays}) — ${stale ? "STALE" : "fresh"}`);
      if (stale) exitCode = 1;
    }
  }
  if (options.gate === "release" && releaseGate !== "PASS") exitCode = 1;
  return { exitCode, lines, report };
}

if (require.main === module) {
  let result;
  try {
    result = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    result = { exitCode: 2, lines: [`Usage error: ${error.message}`] };
  }
  for (const line of result.lines) (result.exitCode === 2 ? console.error : console.log)(line);
  process.exitCode = result.exitCode;
}

module.exports = { parseArgs, run };
