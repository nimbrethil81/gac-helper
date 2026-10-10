"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { auditSnapshot, diffPayloads, emulateActionData, loadSnapshot, payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const {
  FILES,
  applyCorrections,
  auditSource,
  compileSource,
  formatSourceJson,
  importFromPayload,
  importSnapshot,
  readCorrections,
  readSource,
  scoreMeaningsFromSnapshot,
  writeSource
} = require("../scripts/catalogue-source-lib.js");
const { renderImportReport, run } = require("../scripts/catalogue-build.js");
const { counterRow, validSnapshot, withCapture } = require("./catalogue-audit-fixture.js");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "catalogue", "source");
const BASELINE_DIR = path.join(ROOT, "data", "snapshots", "20261010T070702Z");
const CORRECTIONS_DIR = path.join(ROOT, "catalogue", "corrections");

const baseline = loadSnapshot(BASELINE_DIR);
const committed = readSource(SOURCE_DIR);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gateKeys = (report) => report.findings
  .filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval")
  .map((finding) => `${finding.code} ${finding.subject}`)
  .sort();

// ─── migration baseline and approved corrections ─────────────────────────────

const imported = importSnapshot(baseline, auditSnapshot(baseline));
const corrections = (fs.existsSync(CORRECTIONS_DIR) ? fs.readdirSync(CORRECTIONS_DIR) : []).filter((file) => file.endsWith(".json")).sort()
  .flatMap((file) => readCorrections(path.join(CORRECTIONS_DIR, file)).corrections);
const approved = corrections.filter((correction) => correction.status === "APPROVED");
const NAMES_ANY = ["Ahsoka Tano", "Carth Onasi", "Executor", "Jedi Master Kenobi", "Leviathan", "Lord Vader", "Profundity", "The Stranger"];
const IMPORTED_GATE = [
  "DEFENCE_ALIAS_CANDIDATE Gungan",
  "DEFENCE_COMPOSITION_UNKNOWN_UNIT Kelleran Beq / JOCASTA_NU",
  "DEFENCE_COMPOSITION_UNKNOWN_UNIT Kelleran Beq / KELLERAN_BEQ",
  ...NAMES_ANY.map((name) => `DEFENCE_MODE_CASE ${name}`),
  "DUPLICATE_MATCHUP Grand Inquisitor ← TRAYA",
  "REQUIRED_UNIT_NO_EXTERNAL_ID BO_KATAN_MANDALORE / IG_12_AND_GROGU",
  "REQUIRED_UNIT_NO_EXTERNAL_ID BO_KATAN_MANDALORE / PAZ_VIZSLA",
  "UNIT_TYPE_INVALID IG_12_AND_GROGU",
  "UNIT_TYPE_INVALID PAZ_VIZSLA"
].sort();

// The exact payload difference each approved correction is allowed to make
// against the captured live action=data. Anything else is an unrelated change.
const anyThreats = Object.fromEntries(NAMES_ANY.map((name) => [name, {
  notes: "",
  threat: { Executor: "HIGH", Leviathan: "EXTREME", "Carth Onasi": "LOW", "The Stranger": "EXTREME" }[name] ?? "HIGH"
}]));
const EXPECTED_DIFF = {
  C1: [
    { path: 'payload["defenceTeams"]["ANY"]', expected: undefined, actual: anyThreats },
    { path: 'payload["defenceTeams"]["Any"]', expected: anyThreats, actual: undefined }
  ],
  C2: [
    { path: 'payload["defenceTeams"]["5v5"]["Gungan"]', expected: { notes: "", threat: "HIGH" }, actual: undefined },
    { path: 'payload["defenceTeams"]["5v5"]["Gungans"]', expected: undefined, actual: { notes: "", threat: "HIGH" } }
  ],
  C3: [
    { path: 'payload["counters"]["3v3"]["Grand Inquisitor"][1]', expected: { bannerScore: 54, counter: "Darth Traya", counterId: "TRAYA", notes: "", tier: "S", undersize: 0 }, actual: undefined }
  ],
  C4: [
    { path: 'payload["characterDefinitions"]["JOCASTA_NU"]', expected: undefined, actual: { externalId: "JOCASTANU", name: "Jocasta Nu", unitType: "CHARACTER" } },
    { path: 'payload["characterDefinitions"]["KELLERAN_BEQ"]', expected: undefined, actual: { externalId: "KELLERANBEQ", name: "Kelleran Beq", unitType: "CHARACTER" } }
  ],
  C5: [
    { path: 'payload["characterDefinitions"]["IG_12_AND_GROGU"]["externalId"]', expected: "", actual: "IG12" },
    { path: 'payload["characterDefinitions"]["IG_12_AND_GROGU"]["unitType"]', expected: "", actual: "CHARACTER" },
    { path: 'payload["characterDefinitions"]["PAZ_VIZSLA"]["externalId"]', expected: "", actual: "PAZVIZSLA" },
    { path: 'payload["characterDefinitions"]["PAZ_VIZSLA"]["unitType"]', expected: "", actual: "CHARACTER" }
  ]
};

test("the unmodified import compiles to exact parity with the fresh live capture", () => {
  const compiled = compileSource(imported);
  assert.deepEqual(diffPayloads(baseline.actionData.payload, compiled), []);
  assert.equal(payloadChecksum(compiled), payloadChecksum(baseline.actionData.payload));
});

test("committed source is the unmodified import plus only APPROVED corrections", () => {
  assert.deepEqual(committed.findings, []);
  assert.deepEqual(committed.source, applyCorrections(imported, approved));
});

test("committed source differs from the live capture by exactly the approved corrections", () => {
  const expected = approved.flatMap((correction) => {
    assert.ok(EXPECTED_DIFF[correction.id], `no expected diff declared for ${correction.id}`);
    return EXPECTED_DIFF[correction.id];
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(diffPayloads(baseline.actionData.payload, compileSource(committed.source)), expected);
});

test("no unrelated counter ratings, names, compositions, scoring or board values changed", () => {
  const live = baseline.actionData.payload;
  const now = compileSource(committed.source);
  assert.deepEqual(now.counterDefinitions, live.counterDefinitions, "counter names, reserve flags and compositions");
  assert.deepEqual(now.scoring, live.scoring);
  assert.deepEqual(now.boardConfig, live.boardConfig);
  assert.deepEqual(now.defenceCompositions, live.defenceCompositions);
  const c3 = approved.some((correction) => correction.id === "C3");
  for (const mode of Object.keys(live.counters)) {
    for (const [defence, entries] of Object.entries(live.counters[mode])) {
      const expected = c3 && mode === "3v3" && defence === "Grand Inquisitor" ? entries.slice(0, 1) : entries;
      assert.deepEqual(now.counters[mode][defence], expected, `${mode} ${defence}`);
    }
  }
  assert.deepEqual(Object.keys(now.counters).sort(), Object.keys(live.counters).sort());
  const touchedUnits = new Set(["JOCASTA_NU", "KELLERAN_BEQ", "IG_12_AND_GROGU", "PAZ_VIZSLA"]);
  for (const [id, unit] of Object.entries(live.characterDefinitions)) {
    if (!touchedUnits.has(id)) assert.deepEqual(now.characterDefinitions[id], unit, id);
  }
});

test("release gate: the import keeps every known defect; approved corrections resolve only theirs", () => {
  assert.deepEqual(gateKeys(auditSource(imported)), IMPORTED_GATE, "the unchanged validator still rejects the import");
  const resolvedCodes = new Set(approved.flatMap((correction) => correction.resolves));
  const report = auditSource(committed.source);
  assert.deepEqual(gateKeys(report), IMPORTED_GATE.filter((key) => !resolvedCodes.has(key.split(" ")[0])));
  const allApproved = corrections.length > 0 && approved.length === corrections.length;
  assert.equal(report.summary.releaseGate, allApproved ? "PASS" : "FAIL");
  assert.equal(run(["compile", "--gate", "release"]).exitCode, allApproved ? 0 : 1);
});

test("release.json records the compiled checksum; each approved correction advanced the version once", () => {
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, "catalogue", "release.json"), "utf8"));
  // Migration progression: v1 is the unmodified import, and each correction
  // landed in its own commit with its own release record.
  assert.deepEqual(release, { schema: 1, catalogueVersion: 1 + approved.length, checksum: payloadChecksum(compileSource(committed.source)) });
  assert.equal(run(["release", "--check"]).exitCode, 0);
});

test("committed source files use the canonical one-row-per-line format", () => {
  for (const [file, spec] of Object.entries(FILES)) {
    const expected = `${formatSourceJson({ schema: 1, [spec.array]: committed.source[file] })}\n`;
    assert.equal(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"), expected, file);
  }
});

test("the committed import report is exactly what the import regenerates", () => {
  const report = renderImportReport("data/snapshots/20261010T070702Z", baseline, imported, auditSource(imported));
  assert.equal(fs.readFileSync(path.join(ROOT, "catalogue", "IMPORT_REPORT.md"), "utf8"), report);
  assert.match(report, /\*\*EXACT PARITY\*\*/);
});

// ─── import/compile behaviour on synthetic fixtures ──────────────────────────

test("synthetic 3v3, 5v5 and FLEET catalogue round-trips exactly, preserving order and authored values", () => {
  const snapshot = validSnapshot();
  snapshot.tabs.Counters.grid.push(counterRow("5v5", "Gungans", "LEIA", "S", 62, 0));
  snapshot.tabs.Defence_Teams.grid.push(["Gungan", "5v5", "High", ""], ["Rex", "Any", "LOW", ""]);
  snapshot.tabs.Defence_Composition.grid.push(["Home One", "ANY", "EXECUTOR_SHIP"]);
  withCapture(snapshot);
  const source = importSnapshot(snapshot, auditSnapshot(snapshot));
  const compiled = compileSource(source);
  assert.deepEqual(diffPayloads(snapshot.actionData.payload, compiled), []);

  assert.deepEqual(source["matchups/5v5.json"].find((row) => row.defence === "Gungans").counters.map((entry) => entry.counterId), ["LEIA", "REVA", "LEIA"], "authored order and duplicates kept");
  assert.deepEqual(source["matchups/FLEET.json"].map((row) => row.defence), ["Home One"]);
  assert.deepEqual(source["counters.json"].find((row) => row.id === "LEIA"), { id: "LEIA", name: "Leia Organa", strategicReserve: true, required: ["LEIA_ORGANA"], recommended: ["R2_D2"] });
  assert.deepEqual(source["counters.json"].find((row) => row.id === "FLEX"), { id: "FLEX", name: "Flexible Squad", required: [], recommended: [] });
  assert.deepEqual(source["defence-compositions.json"].find((row) => row.defence === "Chief Chirpa").units, ["CHIEF_CHIRPA", "WICKET"], "partial squad kept");
  assert.ok(source["defence-teams.json"].some((row) => row.defence === "Gungan" && row.mode === "5v5" && row.threat === "HIGH"), "alias not merged");
  assert.ok(source["defence-teams.json"].some((row) => row.defence === "Rex" && row.mode === "Any"), "mode spelling not normalised");
  assert.deepEqual(source["board-config.json"].slice(0, 4).map((row) => row.territory), ["FRONT_TOP", "FRONT_BOTTOM", "BACK_TOP", "BACK_BOTTOM"]);
  assert.deepEqual(source["scoring.json"].map((row) => row.ruleId), ["VICTORY", "SETTING_DEFENCE", "OWN_UNITS", "TERRITORY_CLEAR_PER_TEAM"]);
  assert.equal(source["score-meanings.json"].length, scoreMeaningsFromSnapshot(snapshot).length);

  const report = auditSource(source);
  for (const code of ["DUPLICATE_MATCHUP", "DEFENCE_ALIAS_CANDIDATE", "DEFENCE_MODE_CASE"]) assert.ok(report.findings.some((finding) => finding.code === code), code);
});

test("FLEET is omitted from the payload only when it has no matchups", () => {
  const payload = emulateActionData(validSnapshot().tabs);
  const source = importFromPayload(payload);
  source["matchups/FLEET.json"] = [];
  assert.equal(compileSource(source).counters.FLEET, undefined);
  assert.deepEqual(compileSource(source).counters["5v5"], payload.counters["5v5"]);
});

test("the import refuses Sheet data it could not carry, and parity mismatches", () => {
  const skipped = validSnapshot();
  skipped.tabs.Counters.grid.push(["", "Gungans", "LEIA", "Leia Organa", "S", 62, "", 0, ""]);
  withCapture(skipped);
  assert.throws(() => importSnapshot(skipped, auditSnapshot(skipped)), /ROW_SKIPPED_INCOMPLETE/);

  const placeholder = validSnapshot();
  placeholder.tabs.Counter_Composition.grid.push(["MAZ_KANATA", "R2_D2", "REQUIRED"]);
  withCapture(placeholder);
  assert.throws(() => importSnapshot(placeholder, auditSnapshot(placeholder)), /COMPOSITION_UNKNOWN_COUNTER/);

  const lowercaseMode = validSnapshot();
  lowercaseMode.tabs.Counters.grid.push(counterRow("fleet", "Home One", "EXECUTOR", "S", 73, 0));
  withCapture(lowercaseMode);
  assert.throws(() => importSnapshot(lowercaseMode, auditSnapshot(lowercaseMode)), /MATCHUP_MODE_INVALID/);

  const drifted = withCapture(validSnapshot());
  drifted.actionData.payload.scoring[0].value = 16;
  assert.throws(() => importSnapshot(drifted, auditSnapshot(drifted)), /parity MISMATCH/);

  const uncaptured = validSnapshot();
  assert.throws(() => importSnapshot(uncaptured, auditSnapshot(uncaptured)), /no action=data capture/);
});

// ─── source schema validation ────────────────────────────────────────────────

test("malformed source is rejected: schema, fields, order, duplicates, files", (t) => {
  const dir = tempDir(t);
  const source = importFromPayload(emulateActionData(validSnapshot().tabs));
  source["units.json"].reverse();
  source["counters.json"].push({ ...source["counters.json"][0] });
  source["counters.json"][1].strategicReserve = false;
  source["matchups/5v5.json"][0].counters = [];
  source["defence-teams.json"].push({ ...source["defence-teams.json"][0], colour: "red" });
  writeSource(dir, source);
  fs.writeFileSync(path.join(dir, "scoring.json"), JSON.stringify({ schema: 2, rules: [] }));
  fs.writeFileSync(path.join(dir, "extra.json"), "{}");
  fs.rmSync(path.join(dir, "score-meanings.json"));

  const { source: reread, findings } = readSource(dir);
  const report = auditSource(reread, { readFindings: findings });
  const codes = (code) => report.findings.filter((finding) => finding.code === code);
  assert.ok(codes("SOURCE_ORDER").some((finding) => finding.location.startsWith("units.json")));
  assert.ok(codes("SOURCE_ORDER").some((finding) => finding.location.startsWith("counters.json")));
  assert.ok(codes("SOURCE_DUPLICATE").some((finding) => finding.location.startsWith("counters.json")));
  assert.ok(codes("SOURCE_DUPLICATE").some((finding) => finding.location.startsWith("defence-teams.json")));
  const schema = codes("SOURCE_SCHEMA").map((finding) => `${finding.location}: ${finding.observed}`).join("\n");
  for (const expected of [/scoring\.json/, /extra\.json: unexpected file/, /score-meanings\.json: missing file/, /strategicReserve must be true/, /counters must be a non-empty array/, /unknown field colour/]) {
    assert.match(schema, expected);
  }
  assert.equal(report.summary.releaseGate, "FAIL");
});

// ─── determinism and tooling ─────────────────────────────────────────────────

test("compilation and source writing are deterministic", (t) => {
  assert.equal(JSON.stringify(compileSource(committed.source)), JSON.stringify(compileSource(committed.source)));
  const a = tempDir(t);
  const b = tempDir(t);
  writeSource(a, committed.source);
  writeSource(b, readSource(a).source);
  for (const file of Object.keys(FILES)) assert.equal(fs.readFileSync(path.join(a, file), "utf8"), fs.readFileSync(path.join(b, file), "utf8"), file);
});

test("release versioning: unchanged source is a no-op; a changed checksum bumps the version", (t) => {
  const dir = tempDir(t);
  const releaseFile = path.join(dir, "release.json");
  writeSource(path.join(dir, "source"), committed.source);
  const args = ["--source", path.join(dir, "source"), "--release-file", releaseFile];
  assert.equal(run(["release", ...args]).exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(releaseFile, "utf8")).catalogueVersion, 1);
  run(["release", ...args]);
  assert.equal(JSON.parse(fs.readFileSync(releaseFile, "utf8")).catalogueVersion, 1);

  const changed = JSON.parse(JSON.stringify(committed.source));
  changed["scoring.json"][0].notes = "Per battle won (edited)";
  writeSource(path.join(dir, "source"), changed);
  assert.equal(run(["release", "--check", ...args]).exitCode, 1);
  run(["release", ...args]);
  assert.equal(JSON.parse(fs.readFileSync(releaseFile, "utf8")).catalogueVersion, 2);
  assert.equal(run(["release", "--check", ...args]).exitCode, 0);
});

test("the compiler path needs only Node built-ins: no database, network or package dependency", () => {
  const files = ["catalogue-source-lib.js", "catalogue-build.js", "catalogue-audit-lib.js", "baseline-lib.js", "xlsx-lib.js"];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");
    for (const match of text.matchAll(/require\("([^"]+)"\)/g)) {
      assert.ok(match[1].startsWith("node:") || match[1].startsWith("./"), `${file} requires ${match[1]}`);
    }
    assert.doesNotMatch(text, /\bfetch\(|https?:\/\/script\.google/, file);
  }
});
