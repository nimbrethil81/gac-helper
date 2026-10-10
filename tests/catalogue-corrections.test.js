"use strict";

// The 2026-10-10 baseline correction list (#41): every correction stays
// pending until the owner approves it by ID, applies exactly, and resolves
// only the findings it declares.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { auditSnapshot, diffPayloads, loadSnapshot, payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const { applyCorrections, auditSource, compileSource, correctionChecksum, importSnapshot, isApplied, readCorrections, readSource, writeSource } = require("../scripts/catalogue-source-lib.js");
const { run } = require("../scripts/catalogue-build.js");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_CORRECTIONS = path.join(ROOT, "catalogue", "corrections", "2026-10-10-baseline.json");
const baseline = loadSnapshot(path.join(ROOT, "data", "snapshots", "20261010T070702Z"));
const committed = readSource(path.join(ROOT, "catalogue", "source"));
// Corrections are always proven against the unmodified migration import.
const imported = importSnapshot(baseline, auditSnapshot(baseline));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-corrections-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function modernCorrection(source, { id = "CR-2099-01-01-P01", change, status = "PENDING_OWNER_APPROVAL" } = {}) {
  const correction = {
    id,
    status,
    disposition: change.operation,
    title: `Synthetic ${change.operation.toLowerCase()} rehearsal`,
    rationale: "Synthetic fixture proving the controlled change-set mechanism without changing the live catalogue.",
    approval: null,
    provenance: {
      evidence: [{ url: "https://example.test/evidence", publisher: "Synthetic fixture", publishedOrObservedAt: "2099-01-01", accessedAt: "2099-01-02", supports: "Only the synthetic value used by this test." }],
      conditions: "Synthetic 5v5 fixture; no production claim.",
      confidence: "High for the deterministic fixture.",
      limitations: "Not real counter evidence and never publishable."
    },
    affectedReferences: [{ file: change.file, stableKey: change.stableKey, effect: "Exact synthetic row under test." }],
    runtimeImpact: { "5v5": "Synthetic fixture only.", "3v3": "none", FLEET: "none", counters: "Synthetic preview only.", roundAvailability: "none", scoring: "none", strategicReserve: "none" },
    expectedPayloadPaths: [],
    changes: [change]
  };
  const after = applyCorrections(source, [correction]);
  correction.expectedPayloadPaths = diffPayloads(compileSource(source), compileSource(after)).map((difference) => difference.path);
  return correction;
}

function modernDocument(source, baseline, correction, { approved = false } = {}) {
  const document = { schema: 2, contract: "gac-catalogue-change-set:v1", issue: "https://github.com/nimbrethil81/gac-helper/issues/36", baseline, corrections: [correction] };
  if (approved) {
    correction.status = "APPROVED";
    correction.approval = { reference: "https://github.com/nimbrethil81/gac-helper/issues/36#issuecomment-123456789", decidedAt: "2099-01-03T12:00:00Z", changeSetChecksum: correctionChecksum(document, correction) };
  }
  return document;
}

function fixtureRepo(t) {
  const dir = tempDir(t);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "catalogue"), { recursive: true });
  fs.cpSync(path.join(ROOT, "catalogue", "source"), path.join(dir, "catalogue", "source"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "catalogue", "release.json"), path.join(dir, "catalogue", "release.json"));
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "baseline");
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", commit);
  const release = JSON.parse(fs.readFileSync(path.join(dir, "catalogue", "release.json"), "utf8"));
  git(dir, "switch", "-q", "-c", "issue-36-rehearsal");
  return { dir, commit, release, sourceDir: path.join(dir, "catalogue", "source"), releaseFile: path.join(dir, "catalogue", "release.json") };
}

function writeDocument(dir, document, name = "change-set.json") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

function amendFirstMatchup(source, note = "Synthetic approved rehearsal") {
  const before = source["matchups/5v5.json"].find((row) => row.counters.length > 1);
  const after = JSON.parse(JSON.stringify(before));
  after.counters[0].notes = note;
  return { file: "matchups/5v5.json", operation: "AMEND", stableKey: { mode: "5v5", defence: before.defence }, before, after };
}

test("every correction is either APPROVED and applied, or pending and not applied", () => {
  const document = readCorrections(BASELINE_CORRECTIONS);
  assert.deepEqual(document.corrections.map((correction) => correction.id), ["C1", "C2", "C3", "C4", "C5"]);
  assert.equal(document.baselineChecksum, payloadChecksum(baseline.actionData.payload));
  for (const correction of document.corrections) {
    assert.ok(["APPROVED", "PENDING_OWNER_APPROVAL"].includes(correction.status), correction.id);
    assert.equal(isApplied(committed.source, correction), correction.status === "APPROVED", correction.id);
  }
});

test("the CLI applies only APPROVED corrections that are not already applied", (t) => {
  const dir = tempDir(t);
  writeSource(path.join(dir, "source"), imported);
  const list = path.join(dir, "list.json");
  const pending = { ...readCorrections(BASELINE_CORRECTIONS).corrections[1], status: "PENDING_OWNER_APPROVAL" };
  const approvedOne = { ...readCorrections(BASELINE_CORRECTIONS).corrections[0], status: "APPROVED" };
  fs.writeFileSync(list, JSON.stringify({ schema: 1, corrections: [approvedOne, pending] }));
  const args = ["corrections", list, "--source", path.join(dir, "source")];

  const refused = run([...args, "--apply", "C2"]);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.lines[0], /PENDING_OWNER_APPROVAL; only APPROVED/);
  assert.deepEqual(readSource(path.join(dir, "source")).source, imported, "nothing was written");

  assert.equal(run([...args, "--apply", "C1"]).exitCode, 0);
  assert.deepEqual(readSource(path.join(dir, "source")).source, applyCorrections(imported, [approvedOne]));
  const again = run([...args, "--apply", "C1"]);
  assert.equal(again.exitCode, 2);
  assert.match(again.lines[0], /already applied/);
  assert.ok(run(args).lines.some((line) => /^C1 \[APPROVED\] .*: applied$/.test(line)));
});

test("each correction applies exactly, resolves only its declared findings and introduces none", () => {
  const before = auditSource(imported);
  const key = (finding) => `${finding.code}|${finding.subject}|${finding.location}`;
  for (const correction of readCorrections(BASELINE_CORRECTIONS).corrections) {
    const after = auditSource(applyCorrections(imported, [correction]));
    const remaining = new Set(after.findings.map(key));
    const resolved = before.findings.filter((finding) => !remaining.has(key(finding)) && finding.severity !== "info");
    const introduced = after.findings.filter((finding) => finding.severity !== "info" && !before.findings.some((other) => key(other) === key(finding)));
    assert.ok(resolved.length > 0, correction.id);
    assert.deepEqual([...new Set(resolved.map((finding) => finding.code))].sort(), [...correction.resolves].sort(), correction.id);
    assert.deepEqual(introduced, [], correction.id);
  }
});

test("all five corrections together pass the unchanged release gate", () => {
  const corrected = applyCorrections(imported, readCorrections(BASELINE_CORRECTIONS).corrections);
  const report = auditSource(corrected);
  assert.equal(report.summary.releaseGate, "PASS");
  const payload = report.payload;
  assert.equal(payload.defenceTeams.ANY["The Stranger"].threat, "EXTREME");
  assert.equal(payload.defenceTeams.Any, undefined);
  assert.equal(payload.defenceTeams["5v5"].Gungans.threat, "HIGH");
  assert.deepEqual(payload.counters["3v3"]["Grand Inquisitor"].map((entry) => [entry.counterId, entry.notes]), [["TRAYA", "Strong"]]);
});

test("new External_IDs are unique and existing Character_IDs and names are preserved", () => {
  const { corrections } = readCorrections(BASELINE_CORRECTIONS);
  const unitChanges = corrections.flatMap((correction) => correction.changes).filter((change) => change.file === "units.json");
  const existingExternal = new Map(imported["units.json"].filter((unit) => unit.externalId).map((unit) => [unit.externalId, unit.id]));
  assert.deepEqual(unitChanges.map((change) => [change.after.id, change.after.unitType, change.after.externalId]).sort(), [
    ["IG_12_AND_GROGU", "CHARACTER", "IG12"],
    ["JOCASTA_NU", "CHARACTER", "JOCASTANU"],
    ["KELLERAN_BEQ", "CHARACTER", "KELLERANBEQ"],
    ["PAZ_VIZSLA", "CHARACTER", "PAZVIZSLA"]
  ]);
  for (const change of unitChanges) {
    assert.equal(existingExternal.has(change.after.externalId), false, change.after.externalId);
    if (change.before) {
      assert.equal(change.after.id, change.before.id);
      assert.equal(change.after.name, change.before.name);
    }
  }
  const corrected = applyCorrections(imported, corrections)["units.json"].map((unit) => unit.externalId).filter(Boolean);
  assert.equal(new Set(corrected).size, corrected.length);
});

test("a stale or ambiguous correction is refused", () => {
  assert.throws(() => applyCorrections(imported, [{ id: "X", changes: [{ file: "defence-teams.json", before: { defence: "Gungan", mode: "5v5", threat: "LOW" }, after: { defence: "Gungans", mode: "5v5", threat: "LOW" } }] }]), /matches 0 rows/);
  assert.throws(() => applyCorrections(imported, [{ id: "X", changes: [{ file: "nope.json", after: {} }] }]), /unknown source file/);
});

// ─── approved Git-native change sets (#36) ──────────────────────────────────

test("schema-2 contract makes add, amend and retire explicit and preserves unrelated rows", (t) => {
  const source = JSON.parse(JSON.stringify(committed.source));
  const add = modernCorrection(source, { change: { file: "units.json", operation: "ADD", stableKey: { id: "SYNTHETIC_UNIT" }, before: "ABSENT", after: { id: "SYNTHETIC_UNIT", name: "Synthetic Unit", unitType: "CHARACTER", externalId: "SYNTHETICUNIT" } } });
  const amendedSource = applyCorrections(source, [add]);
  const amend = modernCorrection(amendedSource, { id: "CR-2099-01-01-P02", change: amendFirstMatchup(amendedSource) });
  const twiceChanged = applyCorrections(amendedSource, [amend]);
  const retired = twiceChanged["defence-teams.json"][0];
  const retire = modernCorrection(twiceChanged, { id: "CR-2099-01-01-P03", change: { file: "defence-teams.json", operation: "RETIRE", stableKey: { defence: retired.defence, mode: retired.mode }, before: retired, after: "REMOVE" } });

  const result = applyCorrections(source, [add, amend, retire]);
  assert.ok(result["units.json"].some((row) => row.id === "SYNTHETIC_UNIT"));
  assert.deepEqual(result["matchups/5v5.json"].find((row) => row.defence === amend.changes[0].after.defence), amend.changes[0].after);
  assert.ok(!result["defence-teams.json"].some((row) => row.defence === retired.defence && row.mode === retired.mode));
  assert.deepEqual(result["counters.json"], source["counters.json"], "unrelated counter identities and compositions stay byte-for-byte equivalent");
  const existing = source["units.json"][0];
  assert.throws(() => applyCorrections(source, [{ id: "CR-2099-01-01-P99", changes: [{ file: "units.json", operation: "ADD", stableKey: { id: existing.id }, before: "ABSENT", after: existing }] }]), /is present; expected ABSENT/);

  const baseline = { commit: "a".repeat(40), catalogueVersion: 6, checksum: payloadChecksum(compileSource(source)) };
  const file = writeDocument(tempDir(t), modernDocument(source, baseline, add));
  assert.equal(readCorrections(file).contract, "gac-catalogue-change-set:v1");
});

test("approval is an exact GitHub decision tied to the baseline and diff checksum", (t) => {
  const source = committed.source;
  const correction = modernCorrection(source, { change: amendFirstMatchup(source) });
  const baseline = { commit: "b".repeat(40), catalogueVersion: 6, checksum: payloadChecksum(compileSource(source)) };
  const document = modernDocument(source, baseline, correction, { approved: true });
  assert.equal(readCorrections(writeDocument(tempDir(t), document)).corrections[0].status, "APPROVED");

  document.corrections[0].changes[0].after.counters[0].notes = "Changed after approval";
  assert.throws(() => readCorrections(writeDocument(tempDir(t), document)), /does not approve this exact baseline and diff/);
});

test("contract rejects missing or duplicate IDs and overlapping source rows", (t) => {
  const source = committed.source;
  const baseline = { commit: "c".repeat(40), catalogueVersion: 6, checksum: payloadChecksum(compileSource(source)) };
  const correction = modernCorrection(source, { change: amendFirstMatchup(source) });
  const badId = modernDocument(source, baseline, { ...correction, id: "bad id" });
  assert.throws(() => readCorrections(writeDocument(tempDir(t), badId)), /stable uppercase proposal ID/);

  const duplicate = modernDocument(source, baseline, correction);
  duplicate.corrections.push(JSON.parse(JSON.stringify(correction)));
  assert.throws(() => readCorrections(writeDocument(tempDir(t), duplicate)), /duplicate correction ID/);

  const overlap = modernDocument(source, baseline, correction);
  overlap.corrections.push({ ...JSON.parse(JSON.stringify(correction)), id: "CR-2099-01-01-P02" });
  assert.throws(() => readCorrections(writeDocument(tempDir(t), overlap)), /overlaps/);
});

test("preview shows the exact source rows and every compiled field change, including authored order", (t) => {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const change = amendFirstMatchup(source, "Order rehearsal");
  change.after.counters.reverse();
  const correction = modernCorrection(source, { change });
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const document = modernDocument(source, baseline, correction);
  const file = writeDocument(repo.dir, document);
  const result = run(["corrections", file, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main", "--preview", correction.id]);
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  const output = result.lines.join("\n");
  assert.match(output, /Source-row preview:/);
  assert.match(output, /BEFORE:/);
  assert.match(output, /AFTER:/);
  for (const payloadPath of correction.expectedPayloadPaths) assert.ok(output.includes(payloadPath), payloadPath);
  assert.deepEqual(readSource(repo.sourceDir).source, source, "preview is read-only");
});

test("approved apply is branch-only, atomic, release-explicit and idempotent", (t) => {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const correction = modernCorrection(source, { change: amendFirstMatchup(source) });
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const pendingFile = writeDocument(repo.dir, modernDocument(source, baseline, correction), "pending.json");
  const pending = run(["corrections", pendingFile, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main", "--apply", correction.id]);
  assert.equal(pending.exitCode, 2);
  assert.match(pending.lines[0], /only APPROVED corrections can be applied/);
  assert.deepEqual(readSource(repo.sourceDir).source, source, "preview metadata never implies approval");

  const document = modernDocument(source, baseline, correction, { approved: true });
  const file = writeDocument(repo.dir, document);
  const args = ["corrections", file, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main", "--apply", correction.id];

  const applied = run(args);
  assert.equal(applied.exitCode, 0, applied.lines.join("\n"));
  assert.match(applied.lines.join("\n"), /release\.json was not changed and nothing was committed, merged or deployed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")), repo.release, "apply never versions implicitly");
  assert.equal(auditSource(readSource(repo.sourceDir).source).summary.releaseGate, "PASS");

  const again = run(args);
  assert.equal(again.exitCode, 0, again.lines.join("\n"));
  assert.match(again.lines.join("\n"), /exact idempotent no-op/);

  const released = run(["release", "--source", repo.sourceDir, "--release-file", repo.releaseFile]);
  assert.equal(released.exitCode, 0, released.lines.join("\n"));
  assert.equal(JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")).catalogueVersion, repo.release.catalogueVersion + 1);
});

test("fresh-main, source checksum and release baseline mismatches fail closed", (t) => {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const correction = modernCorrection(source, { change: amendFirstMatchup(source) });
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const file = writeDocument(repo.dir, modernDocument(source, baseline, correction));
  const args = ["corrections", file, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"];

  fs.writeFileSync(path.join(repo.dir, "README.md"), "moved\n");
  git(repo.dir, "add", "README.md");
  git(repo.dir, "commit", "-q", "-m", "move head");
  const moved = run(args);
  assert.equal(moved.exitCode, 2);
  assert.match(moved.lines[0], /base commit moved/);

  git(repo.dir, "reset", "-q", "--hard", repo.commit);
  fs.writeFileSync(repo.releaseFile, JSON.stringify({ ...repo.release, catalogueVersion: repo.release.catalogueVersion + 1 }));
  const releaseMoved = run(args);
  assert.equal(releaseMoved.exitCode, 2);
  assert.match(releaseMoved.lines[0], /release baseline moved/);

  fs.writeFileSync(repo.releaseFile, JSON.stringify({ ...repo.release, checksum: `sha256:${"0".repeat(64)}` }));
  const checksumMoved = run(args);
  assert.equal(checksumMoved.exitCode, 2);
  assert.match(checksumMoved.lines[0], /release baseline moved/);

  fs.writeFileSync(repo.releaseFile, `${JSON.stringify(repo.release)}\n`);
  const changed = readSource(repo.sourceDir).source;
  changed["matchups/5v5.json"][0].counters[0].notes = "stale source";
  writeSource(repo.sourceDir, changed);
  const sourceMoved = run(args);
  assert.equal(sourceMoved.exitCode, 2);
  assert.match(sourceMoved.lines[0], /source baseline moved/);
});

test("ambiguous aliases and cross-file partial failures abort without writing", (t) => {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const alias = modernCorrection(source, { change: { file: "defence-teams.json", operation: "ADD", stableKey: { defence: "Gungan", mode: "5v5" }, before: "ABSENT", after: { defence: "Gungan", mode: "5v5", threat: "HIGH" } } });
  const aliasResult = run(["corrections", writeDocument(repo.dir, modernDocument(source, baseline, alias), "alias.json"), "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"]);
  assert.equal(aliasResult.exitCode, 2);
  assert.match(aliasResult.lines[0], /fails the release gate.*DEFENCE_ALIAS_CANDIDATE/);

  const first = amendFirstMatchup(source, "Cross-file first change");
  const unit = source["units.json"][0];
  const stale = { ...unit, name: `${unit.name} stale` };
  const second = { file: "units.json", operation: "AMEND", stableKey: { id: unit.id }, before: stale, after: { ...unit, name: `${unit.name} changed` } };
  const correction = modernCorrection(source, { change: first, status: "PENDING_OWNER_APPROVAL" });
  correction.changes.push(second);
  correction.affectedReferences.push({ file: second.file, stableKey: second.stableKey, effect: "Synthetic second row that must fail stale." });
  const document = modernDocument(source, baseline, correction, { approved: true });
  const before = readSource(repo.sourceDir).source;
  const failed = run(["corrections", writeDocument(repo.dir, document, "partial.json"), "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main", "--apply", correction.id]);
  assert.equal(failed.exitCode, 2);
  assert.match(failed.lines[0], /stale before row/);
  assert.deepEqual(readSource(repo.sourceDir).source, before, "no first-file write escaped the failed coherent plan");
  assert.deepEqual(JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")), repo.release, "no partial release record");
});

