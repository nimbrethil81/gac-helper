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
const { applyCorrections, auditSource, compileSource, contentChecksum, correctionChecksum, importSnapshot, isApplied, readCorrections, readSource, writeSource } = require("../scripts/catalogue-source-lib.js");
const { run } = require("../scripts/catalogue-build.js");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_CORRECTIONS = path.join(ROOT, "catalogue", "corrections", "2026-10-10-baseline.json");
const baseline = loadSnapshot(path.join(ROOT, "data", "snapshots", "20261010T070702Z"));
const committed = readSource(path.join(ROOT, "catalogue", "source"));
// Corrections are always proven against the unmodified migration import.
const imported = importSnapshot(baseline, auditSnapshot(baseline));
// Historical applied-state proof uses the rebuilt cutover source, not mutable main.
const snapshotPayload = baseline.actionData.payload;
const cutover = applyCorrections(imported, readCorrections(BASELINE_CORRECTIONS).corrections.filter((correction) => correction.status === "APPROVED"));

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
    correction.approval = { reference: "https://github.com/nimbrethil81/gac-helper/issues/36#issuecomment-123456789", decidedAt: "2099-01-03T12:00:00Z", contentChecksum: contentChecksum(correction) };
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
    assert.equal(isApplied(cutover, correction), correction.status === "APPROVED", correction.id);
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

test("approval is an exact GitHub decision tied to a generated content checksum", (t) => {
  const source = committed.source;
  const correction = modernCorrection(source, { change: amendFirstMatchup(source) });
  const baseline = { commit: "b".repeat(40), catalogueVersion: 6, checksum: payloadChecksum(compileSource(source)) };
  const document = modernDocument(source, baseline, correction, { approved: true });
  assert.equal(readCorrections(writeDocument(tempDir(t), document)).corrections[0].status, "APPROVED");

  document.corrections[0].changes[0].after.counters[0].notes = "Changed after approval";
  assert.throws(() => readCorrections(writeDocument(tempDir(t), document)), /content changed after it was approved/);
});

test("a legacy baseline-bound checksum still verifies and still detects tampering", (t) => {
  const source = committed.source;
  const baseline = { commit: "b".repeat(40), catalogueVersion: 6, checksum: payloadChecksum(compileSource(source)) };
  const document = modernDocument(source, baseline, modernCorrection(source, { change: amendFirstMatchup(source) }), { approved: true });
  const approval = document.corrections[0].approval;
  document.corrections[0].approval = { reference: approval.reference, decidedAt: approval.decidedAt, changeSetChecksum: correctionChecksum(document, document.corrections[0]) };
  readCorrections(writeDocument(tempDir(t), document));
  document.baseline = { ...baseline, catalogueVersion: 7 };
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

test("preview prints compiled paths that a rename adds or removes", (t) => {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const before = source["matchups/5v5.json"][0];
  const after = { ...before, defence: `${before.defence} (renamed)` };
  const correction = modernCorrection(source, { change: { file: "matchups/5v5.json", operation: "RETIRE", stableKey: { mode: "5v5", defence: before.defence }, before, after: "REMOVE" } });
  correction.changes.push({ file: "matchups/5v5.json", operation: "ADD", stableKey: { mode: "5v5", defence: after.defence }, before: "ABSENT", after });
  correction.expectedPayloadPaths = diffPayloads(compileSource(source), compileSource(applyCorrections(source, [correction]))).map((difference) => difference.path);
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const file = writeDocument(repo.dir, modernDocument(source, baseline, correction));
  const result = run(["corrections", file, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main", "--preview", correction.id]);
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  const output = result.lines.join("\n");
  assert.deepEqual([...correction.expectedPayloadPaths].sort(), [`payload["counters"]["5v5"][${JSON.stringify(before.defence)}]`, `payload["counters"]["5v5"][${JSON.stringify(after.defence)}]`].sort());
  for (const payloadPath of correction.expectedPayloadPaths) assert.ok(output.includes(payloadPath), payloadPath);
  assert.equal(output.match(/^ {4}[-+] <absent>$/gm).length, 2);
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


// ─── post-cutover releases ──────────────────────────────────────────────────

test("a synthetic post-v6 approved release moves past the migration proof while invalid changes still fail", (t) => {
  const repo = fixtureRepo(t);
  const ref = ["--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"];
  const source = readSource(repo.sourceDir).source;
  const bound = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const first = modernCorrection(source, { change: amendFirstMatchup(source, "Synthetic release one") });
  const file = writeDocument(repo.dir, modernDocument(source, bound, first, { approved: true }));

  // Stale approval: content edited after the owner approved the content.
  const stale = JSON.parse(fs.readFileSync(file, "utf8"));
  stale.corrections[0].changes[0].after.counters[0].notes = "edited after approval";
  assert.throws(() => readCorrections(writeDocument(repo.dir, stale, "stale.json")), /content changed after it was approved/);

  assert.equal(run(["corrections", file, ...ref, "--apply", first.id]).exitCode, 0);
  // Undeclared source edit: release.json no longer records the compiled source until released.
  assert.equal(run(["release", "--check", "--source", repo.sourceDir, "--release-file", repo.releaseFile]).exitCode, 1);
  assert.equal(run(["release", "--source", repo.sourceDir, "--release-file", repo.releaseFile]).exitCode, 0);
  const released = JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));
  assert.equal(released.catalogueVersion, repo.release.catalogueVersion + 1);
  assert.equal(run(["release", "--check", "--source", repo.sourceDir, "--release-file", repo.releaseFile]).exitCode, 0);
  assert.equal(auditSource(readSource(repo.sourceDir).source).summary.releaseGate, "PASS");

  // The newer catalogue no longer equals the cutover, yet the cutover proof is unaffected.
  const next = readSource(repo.sourceDir).source;
  assert.notEqual(payloadChecksum(compileSource(next)), payloadChecksum(compileSource(cutover)));
  assert.deepEqual(diffPayloads(compileSource(cutover), compileSource(cutover)), []);
  assert.ok(diffPayloads(snapshotPayload, compileSource(next)).length > diffPayloads(snapshotPayload, compileSource(cutover)).length, "migration-only diff would see the new release as undeclared");

  // Wrong version / checksum are rejected by the release check.
  for (const wrong of [{ ...released, checksum: `sha256:${"0".repeat(64)}` }, { ...released, catalogueVersion: 0 }]) {
    fs.writeFileSync(repo.releaseFile, `${JSON.stringify(wrong)}\n`);
    assert.equal(run(["release", "--check", "--source", repo.sourceDir, "--release-file", repo.releaseFile]).exitCode, 1);
  }
  fs.writeFileSync(repo.releaseFile, `${JSON.stringify(released)}\n`);

  // Changed baseline: the old change set cannot apply on top of the new main, and a new one binds to it.
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "-q", "-m", "release one");
  git(repo.dir, "update-ref", "refs/remotes/origin/main", git(repo.dir, "rev-parse", "HEAD"));
  const moved = run(["corrections", file, ...ref]);
  assert.equal(moved.exitCode, 2);
  assert.match(moved.lines[0], /(base commit|release baseline|source baseline) moved/);

  const second = modernCorrection(next, { id: "CR-2099-01-02-P01", change: amendFirstMatchup(next, "Synthetic release two") });
  const secondBaseline = { commit: git(repo.dir, "rev-parse", "HEAD"), catalogueVersion: released.catalogueVersion, checksum: released.checksum };
  const secondFile = writeDocument(repo.dir, modernDocument(next, secondBaseline, second, { approved: true }), "second.json");
  assert.equal(run(["corrections", secondFile, ...ref, "--apply", second.id]).exitCode, 0);
  assert.equal(run(["release", "--source", repo.sourceDir, "--release-file", repo.releaseFile]).exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")).catalogueVersion, repo.release.catalogueVersion + 2);
});

// ─── #68: one content decision, automated checksum validation ────────────────

function approvedFixture(t, extra = {}) {
  const repo = fixtureRepo(t);
  const source = readSource(repo.sourceDir).source;
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  return { repo, source, baseline, args: (file) => ["corrections", file, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"], ...extra };
}

function secondMatchupChange(source, note = "Second synthetic approved rehearsal") {
  const rows = source["matchups/5v5.json"].filter((row) => row.counters.length > 1);
  const before = rows[1];
  const after = JSON.parse(JSON.stringify(before));
  after.counters[1].notes = note;
  return { file: "matchups/5v5.json", operation: "AMEND", stableKey: { mode: "5v5", defence: before.defence }, before, after };
}

test("record-approval stores the owner's link and generates the checksum itself", (t) => {
  const f = approvedFixture(t);
  const correction = modernCorrection(f.source, { change: amendFirstMatchup(f.source) });
  const file = writeDocument(f.repo.dir, modernDocument(f.source, f.baseline, correction));
  const link = "https://github.com/nimbrethil81/gac-helper/issues/68#issuecomment-1";

  const missing = run([...f.args(file), "--record-approval", correction.id]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.lines[0], /needs --decision/);

  const recorded = run([...f.args(file), "--record-approval", correction.id, "--decision", link, "--decided-at", "2099-01-03T12:00:00Z"]);
  assert.equal(recorded.exitCode, 0, recorded.lines.join("\n"));
  const stored = readCorrections(file).corrections[0];
  assert.equal(stored.status, "APPROVED");
  assert.deepEqual(stored.approval, { reference: link, decidedAt: "2099-01-03T12:00:00Z", contentChecksum: contentChecksum(stored) });

  const again = run([...f.args(file), "--record-approval", correction.id, "--decision", link, "--decided-at", "2099-01-03T12:00:00Z"]);
  assert.match(again.lines[0], /only a pending proposal/);
  const bad = run([...f.args(file), "--record-approval", "NOPE-ID-01", "--decision", link, "--decided-at", "2099-01-03T12:00:00Z"]);
  assert.match(bad.lines[0], /No correction/);
});

test("changing only the baseline revalidates automatically without a new owner decision", (t) => {
  const f = approvedFixture(t);
  const correction = modernCorrection(f.source, { change: amendFirstMatchup(f.source) });
  const file = writeDocument(f.repo.dir, modernDocument(f.source, f.baseline, correction, { approved: true }));
  const approval = JSON.stringify(readCorrections(file).corrections[0].approval);

  // main moves with an unrelated, non-catalogue commit and an unrelated catalogue change.
  const other = f.source["matchups/5v5.json"].filter((row) => row.counters.length > 1)[2];
  const unrelated = JSON.parse(JSON.stringify(f.source));
  unrelated["matchups/5v5.json"].find((row) => row.defence === other.defence).counters[0].notes = "Unrelated landed change";
  writeSource(f.repo.sourceDir, unrelated);
  assert.equal(run(["release", "--source", f.repo.sourceDir, "--release-file", f.repo.releaseFile]).exitCode, 0);
  git(f.repo.dir, "add", "-A");
  git(f.repo.dir, "commit", "-q", "-m", "unrelated catalogue change");
  git(f.repo.dir, "update-ref", "refs/remotes/origin/main", git(f.repo.dir, "rev-parse", "HEAD"));

  const stale = run(f.args(file));
  assert.equal(stale.exitCode, 2);
  assert.match(stale.lines[0], /baseline moved|base commit moved/);

  const rebased = run([...f.args(file), "--rebaseline"]);
  assert.equal(rebased.exitCode, 0, rebased.lines.join("\n"));
  const after = readCorrections(file);
  assert.equal(after.baseline.commit, git(f.repo.dir, "rev-parse", "HEAD"));
  assert.equal(JSON.stringify(after.corrections[0].approval), approval, "the owner's decision and generated checksum are untouched");
  const applied = run([...f.args(file), "--apply", correction.id]);
  assert.equal(applied.exitCode, 0, applied.lines.join("\n"));
  assert.equal(run([...f.args(file), "--rebaseline"]).exitCode, 2, "applied proposals are refused");
});

test("rebaseline escalates in plain English when the approved rows or effect changed", (t) => {
  const f = approvedFixture(t);
  const correction = modernCorrection(f.source, { change: amendFirstMatchup(f.source) });
  const file = writeDocument(f.repo.dir, modernDocument(f.source, f.baseline, correction, { approved: true }));
  const before = fs.readFileSync(file, "utf8");

  const edited = JSON.parse(JSON.stringify(f.source));
  edited["matchups/5v5.json"].find((row) => row.defence === correction.changes[0].stableKey.defence).counters[0].notes = "Someone else edited the same row";
  writeSource(f.repo.sourceDir, edited);
  assert.equal(run(["release", "--source", f.repo.sourceDir, "--release-file", f.repo.releaseFile]).exitCode, 0);
  git(f.repo.dir, "add", "-A");
  git(f.repo.dir, "commit", "-q", "-m", "conflicting change");
  git(f.repo.dir, "update-ref", "refs/remotes/origin/main", git(f.repo.dir, "rev-parse", "HEAD"));

  const result = run([...f.args(file), "--rebaseline"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.lines[0], /OWNER DECISION NEEDED: .*no longer matches what was approved/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the change set is untouched");
});

test("a tampered approved proposal or a changed expected effect needs a new decision", (t) => {
  const f = approvedFixture(t);
  const correction = modernCorrection(f.source, { change: amendFirstMatchup(f.source) });
  const document = modernDocument(f.source, f.baseline, correction, { approved: true });
  const tampered = JSON.parse(JSON.stringify(document));
  tampered.corrections[0].changes[0].after.counters[0].tier = "C";
  assert.throws(() => readCorrections(writeDocument(f.repo.dir, tampered, "t1.json")), /content changed after it was approved/);
  const widened = JSON.parse(JSON.stringify(document));
  widened.corrections[0].expectedPayloadPaths.push('payload["counters"]["5v5"]["Elsewhere"][0]["notes"]');
  assert.throws(() => readCorrections(writeDocument(f.repo.dir, widened, "t2.json")), /content changed after it was approved/);
});

test("approved proposals apply as one atomic group without pulling in unapproved ones", (t) => {
  const f = approvedFixture(t);
  const one = modernCorrection(f.source, { id: "CR-2099-01-01-P01", change: amendFirstMatchup(f.source) });
  const two = modernCorrection(f.source, { id: "CR-2099-01-01-P02", change: secondMatchupChange(f.source) });
  const three = modernCorrection(f.source, { id: "CR-2099-01-01-P03", change: secondMatchupChange(f.source, "Pending only") });
  three.changes[0].stableKey = { mode: "5v5", defence: f.source["matchups/5v5.json"].filter((row) => row.counters.length > 1)[3].defence };
  const rowThree = f.source["matchups/5v5.json"].filter((row) => row.counters.length > 1)[3];
  three.changes[0].before = rowThree;
  three.changes[0].after = JSON.parse(JSON.stringify(rowThree));
  three.changes[0].after.counters[0].notes = "Pending only";
  three.affectedReferences[0].stableKey = three.changes[0].stableKey;
  three.expectedPayloadPaths = diffPayloads(compileSource(f.source), compileSource(applyCorrections(f.source, [three]))).map((d) => d.path);

  const document = { schema: 2, contract: "gac-catalogue-change-set:v1", issue: "https://github.com/nimbrethil81/gac-helper/issues/68", baseline: f.baseline, corrections: [one, two, three] };
  for (const entry of [one, two]) {
    entry.status = "APPROVED";
    entry.approval = { reference: "https://github.com/nimbrethil81/gac-helper/issues/68#issuecomment-7", decidedAt: "2099-01-03T12:00:00Z", contentChecksum: contentChecksum(entry) };
  }
  const file = writeDocument(f.repo.dir, document);

  const withPending = run([...f.args(file), "--apply", one.id, "--apply", three.id]);
  assert.equal(withPending.exitCode, 2);
  assert.match(withPending.lines[0], /PENDING_OWNER_APPROVAL; only APPROVED/);
  assert.deepEqual(readSource(f.repo.sourceDir).source, f.source, "nothing written");

  const dup = run([...f.args(file), "--apply", one.id, "--apply", one.id]);
  assert.match(dup.lines[0], /more than once/);

  const group = run([...f.args(file), "--apply", one.id, "--apply", two.id]);
  assert.equal(group.exitCode, 0, group.lines.join("\n"));
  assert.deepEqual(readSource(f.repo.sourceDir).source, applyCorrections(f.source, [one, two]));
  assert.ok(!JSON.stringify(readSource(f.repo.sourceDir).source).includes("Pending only"));
  const again = run([...f.args(file), "--apply", one.id, "--apply", two.id]);
  assert.equal(again.exitCode, 0, again.lines.join("\n"));
  assert.match(again.lines.join("\n"), /exact idempotent no-op/);
});

test("a group is refused whole when a member is already applied or the combined effect is unexpected", (t) => {
  const f = approvedFixture(t);
  const one = modernCorrection(f.source, { id: "CR-2099-01-01-P01", change: amendFirstMatchup(f.source) });
  const two = modernCorrection(f.source, { id: "CR-2099-01-01-P02", change: secondMatchupChange(f.source) });
  const document = { schema: 2, contract: "gac-catalogue-change-set:v1", issue: "https://github.com/nimbrethil81/gac-helper/issues/68", baseline: f.baseline, corrections: [one, two] };
  for (const entry of [one, two]) {
    entry.status = "APPROVED";
    entry.approval = { reference: "https://github.com/nimbrethil81/gac-helper/issues/68#issuecomment-7", decidedAt: "2099-01-03T12:00:00Z", contentChecksum: contentChecksum(entry) };
  }
  const file = writeDocument(f.repo.dir, document);
  assert.equal(run([...f.args(file), "--apply", one.id]).exitCode, 0);
  const partial = run([...f.args(file), "--apply", one.id, "--apply", two.id]);
  assert.equal(partial.exitCode, 2);
  assert.match(partial.lines[0], /baseline moved|already applied/);
  assert.deepEqual(readSource(f.repo.sourceDir).source, applyCorrections(f.source, [one]), "the unapplied member was not written either");
});

test("overlapping corrections in one change set are refused", (t) => {
  const f = approvedFixture(t);
  const one = modernCorrection(f.source, { id: "CR-2099-01-01-P01", change: amendFirstMatchup(f.source) });
  const two = modernCorrection(f.source, { id: "CR-2099-01-01-P02", change: amendFirstMatchup(f.source, "Same row, other note") });
  const document = { schema: 2, contract: "gac-catalogue-change-set:v1", issue: "https://github.com/nimbrethil81/gac-helper/issues/68", baseline: f.baseline, corrections: [one, two] };
  assert.throws(() => readCorrections(writeDocument(f.repo.dir, document)), /overlaps/);
});
