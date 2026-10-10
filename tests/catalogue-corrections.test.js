"use strict";

// The 2026-10-10 baseline correction list (#41): every correction stays
// pending until the owner approves it by ID, applies exactly, and resolves
// only the findings it declares.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadSnapshot, payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const { applyCorrections, auditSource, readCorrections, readSource, writeSource } = require("../scripts/catalogue-source-lib.js");
const { run } = require("../scripts/catalogue-build.js");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_CORRECTIONS = path.join(ROOT, "catalogue", "corrections", "2026-10-10-baseline.json");
const baseline = loadSnapshot(path.join(ROOT, "data", "snapshots", "20261010T070702Z"));
const committed = readSource(path.join(ROOT, "catalogue", "source"));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-corrections-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("baseline corrections are all pending and refuse to apply", (t) => {
  const document = readCorrections(BASELINE_CORRECTIONS);
  assert.deepEqual(document.corrections.map((correction) => [correction.id, correction.status]), [
    ["C1", "PENDING_OWNER_APPROVAL"], ["C2", "PENDING_OWNER_APPROVAL"], ["C3", "PENDING_OWNER_APPROVAL"],
    ["C4", "PENDING_OWNER_APPROVAL"], ["C5", "PENDING_OWNER_APPROVAL"]
  ]);
  assert.equal(document.baselineChecksum, payloadChecksum(baseline.actionData.payload));
  const dir = tempDir(t);
  writeSource(dir, committed.source);
  const result = run(["corrections", BASELINE_CORRECTIONS, "--source", dir, "--apply", "C1"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.lines[0], /PENDING_OWNER_APPROVAL; only APPROVED/);
  assert.deepEqual(readSource(dir).source, committed.source, "nothing was written");
});

test("each correction applies exactly, resolves only its declared findings and introduces none", () => {
  const before = auditSource(committed.source);
  const key = (finding) => `${finding.code}|${finding.subject}|${finding.location}`;
  for (const correction of readCorrections(BASELINE_CORRECTIONS).corrections) {
    const after = auditSource(applyCorrections(committed.source, [correction]));
    const remaining = new Set(after.findings.map(key));
    const resolved = before.findings.filter((finding) => !remaining.has(key(finding)) && finding.severity !== "info");
    const introduced = after.findings.filter((finding) => finding.severity !== "info" && !before.findings.some((other) => key(other) === key(finding)));
    assert.ok(resolved.length > 0, correction.id);
    assert.deepEqual([...new Set(resolved.map((finding) => finding.code))].sort(), [...correction.resolves].sort(), correction.id);
    assert.deepEqual(introduced, [], correction.id);
  }
});

test("all five corrections together pass the unchanged release gate", () => {
  const corrected = applyCorrections(committed.source, readCorrections(BASELINE_CORRECTIONS).corrections);
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
  const existingExternal = new Map(committed.source["units.json"].filter((unit) => unit.externalId).map((unit) => [unit.externalId, unit.id]));
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
  const corrected = applyCorrections(committed.source, corrections)["units.json"].map((unit) => unit.externalId).filter(Boolean);
  assert.equal(new Set(corrected).size, corrected.length);
});

test("a stale or ambiguous correction is refused", () => {
  assert.throws(() => applyCorrections(committed.source, [{ id: "X", changes: [{ file: "defence-teams.json", before: { defence: "Gungan", mode: "5v5", threat: "LOW" }, after: { defence: "Gungans", mode: "5v5", threat: "LOW" } }] }]), /matches 0 rows/);
  assert.throws(() => applyCorrections(committed.source, [{ id: "X", changes: [{ file: "nope.json", after: {} }] }]), /unknown source file/);
});

