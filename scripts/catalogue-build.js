#!/usr/bin/env node
"use strict";

// Git-native catalogue tooling (issue #41, ADR-ARCH-116). No network, no
// credentials, no database, no dependency beyond Node itself.
//
//   import <snapshot-dir> [--source <dir>] [--report <file>]
//       Import a reconciled Sheet snapshot into catalogue/source/ unchanged and
//       prove exact parity with its captured action=data.
//   compile [--source <dir>] [--gate parity|release] [--out <file>]
//           [--compare <action-data.json>] [--markdown <file>]
//       Compile source to the seven-key payload and run the shared rule set.
//   release [--check]
//       Record (or, with --check, verify) catalogue/release.json.
//   corrections <list.json> [--preview <id>] [--apply <id>]
//       Check a correction list against the current source. Schema-2 previews
//       show the complete source/payload diff; apply writes one exact approved
//       proposal on a fresh branch and never versions or deploys it.
//
// Exit codes: 0 ok, 1 gate/consistency failure, 2 unusable input.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");

const { countPayloadDomains } = require("./baseline-lib.js");
const { auditSnapshot, diffPayloads, loadSnapshot, payloadChecksum, renderMarkdown } = require("./catalogue-audit-lib.js");
const {
  FILES,
  CHANGE_SET_SCHEMA,
  applyCorrections,
  auditSource,
  compileSource,
  correctionChecksum,
  importSnapshot,
  isApplied,
  readCorrections,
  readSource,
  writeSource,
  writeSourceAtomically
} = require("./catalogue-source-lib.js");
const { sourceAtCommit } = require("./catalogue-release-lib.js");

const DEFAULT_SOURCE = path.join("catalogue", "source");
const RELEASE_FILE = path.join("catalogue", "release.json");
const IMPORT_REPORT = path.join("catalogue", "IMPORT_REPORT.md");

function parseOptions(argv) {
  const options = { positional: [], apply: [], preview: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      if (argv[index + 1] === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return argv[index];
    };
    if (arg === "--source") options.source = take();
    else if (arg === "--report") options.report = take();
    else if (arg === "--gate") options.gate = take();
    else if (arg === "--out") options.out = take();
    else if (arg === "--compare") options.compare = take();
    else if (arg === "--markdown") options.markdown = take();
    else if (arg === "--release-file") options.releaseFile = take();
    else if (arg === "--repo") options.repo = take();
    else if (arg === "--base-ref") options.baseRef = take();
    else if (arg === "--check") options.check = true;
    else if (arg === "--apply") options.apply.push(take());
    else if (arg === "--preview") options.preview.push(take());
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.positional.push(arg);
  }
  options.gate = options.gate ?? "parity";
  if (!["parity", "release"].includes(options.gate)) throw new Error("--gate must be parity or release");
  return options;
}

function git(repo, args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function gitClean(repo, paths) {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...paths], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--", ...paths], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A payload path that a change adds or removes has no value on one side.
const json = (value) => value === undefined ? "<absent>" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

function previewLines(document, correction, plan) {
  const lines = [
    "",
    `=== ${correction.id} — ${correction.title} ===`,
    `Decision: ${correction.status}; disposition: ${correction.disposition}`,
    `Baseline: ${document.baseline.commit} / v${document.baseline.catalogueVersion} / ${document.baseline.checksum}`,
    `Approval checksum: ${correctionChecksum(document, correction)}`,
    `Approval reference: ${correction.approval?.reference ?? "none — not approved"}`,
    "Source-row preview:"
  ];
  correction.changes.forEach((change, index) => {
    lines.push(
      `  ${index + 1}. ${change.operation} catalogue/source/${change.file} ${JSON.stringify(change.stableKey)}`,
      "     BEFORE:",
      ...json(change.before).split("\n").map((line) => `       ${line}`),
      "     AFTER:",
      ...json(change.after).split("\n").map((line) => `       ${line}`)
    );
  });
  lines.push(`Compiled seven-key payload preview (${plan.differences.length} field-level difference(s)):`);
  for (const difference of plan.differences) {
    lines.push(
      `  ${difference.path}`,
      ...json(difference.expected).split("\n").map((line) => `    - ${line}`),
      ...json(difference.actual).split("\n").map((line) => `    + ${line}`)
    );
  }
  lines.push(
    ...(plan.impactDeclared ? [] : [`DRAFT: copy these ${plan.differences.length} path(s) into expectedPayloadPaths and preview again before approval.`]),
    `Release gate after change: ${plan.after.summary.releaseGate}`,
    `Runtime impact: 5v5=${correction.runtimeImpact["5v5"]}; 3v3=${correction.runtimeImpact["3v3"]}; FLEET=${correction.runtimeImpact.FLEET}`
  );
  return lines;
}

function planModernCorrection(source, current, correction) {
  const next = applyCorrections(source, [correction]);
  const after = auditSource(next);
  if (current.summary.releaseGate !== "PASS") throw new Error(`${correction.id}: current source fails the release gate; refusing to build on an invalid baseline`);
  if (after.summary.releaseGate !== "PASS") {
    const failures = after.findings.filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval");
    throw new Error(`${correction.id}: coherent result fails the release gate (${failures.slice(0, 8).map((finding) => `${finding.code} ${finding.subject}`).join("; ")})`);
  }
  const differences = diffPayloads(current.payload, after.payload);
  const actualPaths = differences.map((difference) => difference.path).sort();
  const expectedPaths = [...correction.expectedPayloadPaths].sort();
  if (expectedPaths.length && !isDeepStrictEqual(actualPaths, expectedPaths)) {
    throw new Error(`${correction.id}: compiled impact differs from expectedPayloadPaths (expected ${JSON.stringify(expectedPaths)}, actual ${JSON.stringify(actualPaths)})`);
  }
  return { next, after, differences, impactDeclared: expectedPaths.length > 0 };
}

function verifyModernBaseline(document, sourceDir, releaseFile, options, { applying = false } = {}) {
  const repo = path.resolve(options.repo ?? process.cwd());
  const { source, findings } = readSource(sourceDir);
  const current = auditSource(source, { readFindings: findings });
  if (current.input.checksum !== document.baseline.checksum) {
    throw new Error(`source baseline moved: expected ${document.baseline.checksum}, got ${current.input.checksum}`);
  }
  let release;
  try {
    release = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot read release baseline ${releaseFile}: ${error.message}`);
  }
  if (release.schema !== 1 || release.catalogueVersion !== document.baseline.catalogueVersion || release.checksum !== document.baseline.checksum) {
    throw new Error(`release baseline moved: expected v${document.baseline.catalogueVersion} ${document.baseline.checksum}`);
  }
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (head !== document.baseline.commit) throw new Error(`base commit moved: expected HEAD ${document.baseline.commit}, got ${head}`);
  const baseRef = options.baseRef ?? "refs/remotes/origin/main";
  const base = git(repo, ["rev-parse", "--verify", baseRef]);
  if (base !== document.baseline.commit) throw new Error(`fresh-main preflight failed: ${baseRef} is ${base}, not ${document.baseline.commit}`);
  if (applying) {
    const branch = git(repo, ["branch", "--show-current"]);
    if (!branch || branch === "main") throw new Error("apply requires a dedicated branch; refusing to write on main or detached HEAD");
    if (!gitClean(repo, ["catalogue/source", "catalogue/release.json"])) throw new Error("catalogue/source or catalogue/release.json already has tracked changes; refusing an optimistic overwrite");
  }
  return { repo, source, current };
}

function loadSourceOrThrow(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Source directory not found: ${directory}`);
  return readSource(directory);
}

function table(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

// Deterministic record of the migration import: provenance, counts, parity
// and the defects carried verbatim.
function renderImportReport(snapshotDir, snapshot, source, sourceReport) {
  const captured = snapshot.actionData.payload;
  const compiled = sourceReport.payload;
  const counts = countPayloadDomains(compiled);
  const gate = sourceReport.findings.filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval");
  const lines = [
    "# Git-native catalogue import report",
    "",
    "Generated by `npm run catalogue:import`. Do not edit by hand. Procedure: [`docs/CATALOGUE_SOURCE.md`](../docs/CATALOGUE_SOURCE.md).",
    "",
    "## Provenance",
    "",
    `- Baseline snapshot: \`${snapshotDir}\` (read-only Sheet export \`${snapshot.capturedAt}\`${snapshot.source.workbookModifiedAt ? `, workbook last modified \`${snapshot.source.workbookModifiedAt}\`` : ""})`,
    `- Live \`action=data\` captured: \`${snapshot.actionData.capturedAt}\``,
    "- Import rule: every value is carried exactly as Apps Script serves it. No row is corrected, merged, renamed, inferred or dropped.",
    "",
    "## Parity",
    "",
    table(["Payload", "Canonical seven-key checksum"], [
      ["Captured live `action=data`", `\`${payloadChecksum(captured)}\``],
      ["Compiled from `catalogue/source/`", `\`${payloadChecksum(compiled)}\``]
    ]),
    "",
    `Result: **${diffPayloads(captured, compiled).length === 0 ? "EXACT PARITY" : "MISMATCH"}** (canonical JSON equality, ADR-ARCH-116 §5).`,
    "",
    "## Source files",
    "",
    table(["File", "Rows"], Object.entries(FILES).map(([file, spec]) => {
      const rows = source[file];
      const extra = spec.array === "defences" ? ` defences / ${rows.reduce((sum, row) => sum + row.counters.length, 0)} matchups` : "";
      return [`\`${file}\``, `${rows.length}${extra}`];
    })),
    "",
    "## Payload domains",
    "",
    table(["Domain", "Count"], [
      ...Object.entries(counts.counters.byMode).map(([mode, value]) => [`counters ${mode} matchups / defences`, `${value.rows} / ${value.defenceTeams}`]),
      ["counterDefinitions", String(counts.counterDefinitions)],
      ["characterDefinitions", String(counts.characterDefinitions)],
      ["boardConfig territories", String(counts.boardConfig.rows)],
      ["scoring rules", String(counts.scoring)],
      ["defenceTeams rows", String(counts.defenceTeams.rows)],
      ["defenceCompositions teams / members", `${counts.defenceCompositions.teams} / ${counts.defenceCompositions.members}`],
      ["score meanings (authoring only)", String(source["score-meanings.json"].length)]
    ]),
    "",
    "## Defects carried verbatim",
    "",
    `Release gate on the imported source: **${sourceReport.summary.releaseGate}** — ${sourceReport.summary.bySeverity.blocking} blocking, ${sourceReport.summary.bySeverity["owner-approval"]} owner-approval, ${sourceReport.summary.bySeverity.warning} warning, ${sourceReport.summary.bySeverity.info} info. The release validator is unchanged; these defects are intentionally preserved so the import proves parity, and are resolved only by owner-approved corrections in \`catalogue/corrections/\`.`,
    "",
    table(["Severity", "Code", "Subject", "Observed"], gate.map((finding) => [finding.severity, `\`${finding.code}\``, finding.subject.replace(/\|/g, "\\|"), finding.observed.replace(/\|/g, "\\|")])),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function commandImport(options) {
  const snapshotDir = options.positional[0];
  if (!snapshotDir) throw new Error("import needs a snapshot directory");
  const sourceDir = options.source ?? DEFAULT_SOURCE;
  const snapshot = loadSnapshot(snapshotDir);
  const source = importSnapshot(snapshot, auditSnapshot(snapshot));
  writeSource(sourceDir, source);
  const { source: reread, findings } = readSource(sourceDir);
  const sourceReport = auditSource(reread, { readFindings: findings });
  const report = renderImportReport(path.relative(process.cwd(), path.resolve(snapshotDir)).split(path.sep).join("/"), snapshot, reread, sourceReport);
  fs.writeFileSync(options.report ?? IMPORT_REPORT, report);
  return { exitCode: 0, lines: [`Imported ${snapshotDir} into ${sourceDir}`, `Parity: EXACT (${sourceReport.input.checksum})`, `Release gate on imported source: ${sourceReport.summary.releaseGate}`] };
}

function commandCompile(options) {
  const { source, findings } = loadSourceOrThrow(options.source ?? DEFAULT_SOURCE);
  const report = auditSource(source, { readFindings: findings });
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(report.payload)}\n`);
  if (options.markdown) fs.writeFileSync(options.markdown, renderMarkdown(report));
  const { bySeverity, releaseGate } = report.summary;
  const lines = [
    `Compiled checksum: ${report.input.checksum}`,
    `Findings: ${bySeverity.blocking} blocking, ${bySeverity["owner-approval"]} owner-approval, ${bySeverity.warning} warning, ${bySeverity.info} info`,
    `Release gate: ${releaseGate}`
  ];
  let exitCode = options.gate === "release" && releaseGate !== "PASS" ? 1 : 0;
  if (options.compare) {
    const differences = diffPayloads(JSON.parse(fs.readFileSync(options.compare, "utf8")), report.payload);
    lines.push(`Compare with ${options.compare}: ${differences.length ? `${differences.length} difference(s)` : "EXACT PARITY"}`);
    for (const difference of differences.slice(0, 20)) lines.push(`  ${difference.path}`);
    if (differences.length) exitCode = 1;
  }
  return { exitCode, lines };
}

function commandRelease(options) {
  const releaseFile = options.releaseFile ?? RELEASE_FILE;
  const { source, findings } = loadSourceOrThrow(options.source ?? DEFAULT_SOURCE);
  if (findings.length) return { exitCode: 2, lines: findings.map((finding) => `${finding.code} ${finding.location}: ${finding.observed}`) };
  const checksum = payloadChecksum(compileSource(source));
  const current = fs.existsSync(releaseFile) ? JSON.parse(fs.readFileSync(releaseFile, "utf8")) : null;
  if (options.check) {
    const ok = current?.schema === 1 && Number.isSafeInteger(current.catalogueVersion) && current.catalogueVersion > 0 && current.checksum === checksum;
    return { exitCode: ok ? 0 : 1, lines: [ok ? `release.json matches compiled source (v${current.catalogueVersion}, ${checksum})` : `release.json is stale: recorded ${current?.checksum ?? "nothing"}, compiled ${checksum}. Run npm run catalogue:release.`] };
  }
  const catalogueVersion = !current ? 1 : current.checksum === checksum ? current.catalogueVersion : current.catalogueVersion + 1;
  fs.writeFileSync(releaseFile, `${JSON.stringify({ schema: 1, catalogueVersion, checksum }, null, 2)}\n`);
  return { exitCode: 0, lines: [`release.json: v${catalogueVersion} ${checksum}${current && current.checksum === checksum ? " (unchanged)" : ""}`] };
}

function commandCorrections(options) {
  const file = options.positional[0];
  if (!file) throw new Error("corrections needs a correction list file");
  const document = readCorrections(file);
  const repo = path.resolve(options.repo ?? process.cwd());
  const sourceDir = options.source ?? path.join(repo, DEFAULT_SOURCE);
  const releaseFile = options.releaseFile ?? path.join(repo, RELEASE_FILE);
  if (document.schema === CHANGE_SET_SCHEMA && options.apply.length > 1) throw new Error("apply exactly one approved proposal per reviewed commit");
  if (document.schema === CHANGE_SET_SCHEMA && options.apply.length === 1) {
    const correction = document.corrections.find((entry) => entry.id === options.apply[0]);
    if (!correction) throw new Error(`No correction ${options.apply[0]} in ${file}`);
    const working = loadSourceOrThrow(sourceDir);
    if (isApplied(working.source, correction)) {
      if (correction.status !== "APPROVED") throw new Error(`${correction.id} is present in the source but is ${correction.status}, not APPROVED`);
      const recorded = sourceAtCommit(repo, document.baseline.commit);
      if (recorded.findings.length) throw new Error(`${correction.id}: recorded baseline source is unreadable`);
      const expected = applyCorrections(recorded.source, [correction]);
      if (!isDeepStrictEqual(working.source, expected)) throw new Error(`${correction.id}: appears applied but the source contains other changes; refusing an ambiguous no-op`);
      return {
        exitCode: 0,
        lines: [
          `${correction.id} [APPROVED] ${correction.title}: already applied; exact idempotent no-op.`,
          "No files were written, and nothing was committed, merged or deployed."
        ]
      };
    }
  }
  const baseline = document.schema === CHANGE_SET_SCHEMA
    ? verifyModernBaseline(document, sourceDir, releaseFile, options, { applying: options.apply.length > 0 })
    : loadSourceOrThrow(sourceDir);
  const { source } = baseline;
  const lines = [];
  const current = baseline.current ?? auditSource(source, { readFindings: baseline.findings });
  const same = (a, b) => a.code === b.code && a.subject === b.subject && a.location === b.location;
  const outstanding = [];
  const plans = new Map();
  for (const correction of document.corrections) {
    if (isApplied(source, correction)) {
      lines.push(`${correction.id} [${correction.status}] ${correction.title}: applied`);
      if (correction.status !== "APPROVED") throw new Error(`${correction.id} is present in the source but is ${correction.status}, not APPROVED`);
      continue;
    }
    outstanding.push(correction);
    const modernPlan = document.schema === CHANGE_SET_SCHEMA ? planModernCorrection(source, current, correction) : null;
    if (modernPlan) plans.set(correction.id, modernPlan);
    const after = modernPlan?.after ?? auditSource(applyCorrections(source, [correction]));
    const resolved = current.findings.filter((finding) => finding.severity !== "info" && !after.findings.some((other) => same(other, finding)));
    const introduced = after.findings.filter((finding) => finding.severity !== "info" && !current.findings.some((other) => same(other, finding)));
    lines.push(`${correction.id} [${correction.status}] ${correction.title}: applies cleanly; resolves ${resolved.length}, introduces ${introduced.length} non-info finding(s)`);
    if (document.schema === CHANGE_SET_SCHEMA && (options.preview.length === 0 || options.preview.includes(correction.id) || options.apply.includes(correction.id))) {
      lines.push(...previewLines(document, correction, modernPlan));
    }
  }
  if (document.schema === CHANGE_SET_SCHEMA) {
    for (const id of options.preview) if (!document.corrections.some((correction) => correction.id === id)) throw new Error(`No correction ${id} in ${file}`);
    lines.push(`Release gate: ${current.summary.releaseGate} now; each proposal above is validated independently as one coherent result`);
  } else {
    const all = auditSource(applyCorrections(source, outstanding));
    lines.push(`Release gate: ${current.summary.releaseGate} now; ${all.summary.releaseGate} with every outstanding correction applied`);
  }

  if (options.apply.length) {
    const chosen = options.apply.map((id) => {
      const correction = document.corrections.find((entry) => entry.id === id);
      if (!correction) throw new Error(`No correction ${id} in ${file}`);
      if (correction.status !== "APPROVED") throw new Error(`${id} is ${correction.status}; only APPROVED corrections can be applied`);
      if (!outstanding.includes(correction)) throw new Error(`${id} is already applied`);
      return correction;
    });
    const next = document.schema === CHANGE_SET_SCHEMA ? plans.get(chosen[0].id).next : applyCorrections(source, chosen);
    if (document.schema === CHANGE_SET_SCHEMA) writeSourceAtomically(sourceDir, next);
    else writeSource(sourceDir, next);
    lines.push(
      `Applied ${chosen.map((correction) => correction.id).join(", ")} to ${sourceDir}.`,
      "release.json was not changed and nothing was committed, merged or deployed.",
      "Next: run npm run catalogue:release, then the documented release checks and review the branch diff."
    );
  }
  return { exitCode: 0, lines };
}

const COMMANDS = { import: commandImport, compile: commandCompile, release: commandRelease, corrections: commandCorrections };

function run(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) return { exitCode: 2, lines: [`Usage: catalogue-build.js ${Object.keys(COMMANDS).join("|")} ...`] };
  try {
    return COMMANDS[command](parseOptions(rest));
  } catch (error) {
    return { exitCode: 2, lines: [`${command} failed: ${error.message}`] };
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  for (const line of result.lines) (result.exitCode === 2 ? console.error : console.log)(line);
  process.exitCode = result.exitCode;
}

module.exports = { renderImportReport, run };
