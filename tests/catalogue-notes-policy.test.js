"use strict";

// GAC-NOTES1 — Tactical Notes Only (issue #216). Counter Notes that a change
// adds or modifies are checked against the authoritative baseline; unchanged
// legacy Notes are never examined. Policy: docs/CATALOGUE_SOURCE.md.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { diffPayloads } = require("../scripts/catalogue-audit-lib.js");
const { NOTE_TARGET_LENGTH, applyCorrections, auditSource, compileSource, contentChecksum, readSource, writeSource } = require("../scripts/catalogue-source-lib.js");
const { run } = require("../scripts/catalogue-build.js");

const ROOT = path.resolve(__dirname, "..");
const committed = readSource(path.join(ROOT, "catalogue", "source")).source;
const clone = (value) => JSON.parse(JSON.stringify(value));

// First 5v5 defence with an ordinary scored counter, and that counter's index.
const target = committed["matchups/5v5.json"].find((row) => row.counters.some((entry) => entry.tier));
const scoredIndex = target.counters.findIndex((entry) => entry.tier);

function withNote(note, source = committed) {
  const next = clone(source);
  const entry = next["matchups/5v5.json"].find((row) => row.defence === target.defence).counters[scoredIndex];
  if (note === undefined) delete entry.notes;
  else entry.notes = note;
  return next;
}

const editorial = (report) => report.findings.filter((finding) => finding.code.startsWith("NOTE_"));
const check = (note, baseline = committed) => auditSource(withNote(note, baseline), { baseline });

test("an ordinary counter with omitted or empty Notes validates and compiles to an empty string", () => {
  const baseline = withNote("Legacy short tactical note.");
  for (const note of [undefined, ""]) {
    const report = auditSource(withNote(note), { baseline });
    assert.equal(report.summary.releaseGate, "PASS");
    assert.deepEqual(editorial(report), []);
    assert.equal(report.payload.counters["5v5"][target.defence][scoredIndex].notes, "");
  }
});

test("legitimate short tactical guidance passes without findings", () => {
  for (const note of ["Kill Revan first; Malak needs his omicron.", "Run Bane second so Darth Malak cannot taunt.", "Requires the Vader datacron."]) {
    const report = check(note);
    assert.equal(report.summary.releaseGate, "PASS", note);
    assert.deepEqual(editorial(report), [], note);
  }
});

test("new or changed process and research wording is blocked with an actionable diagnostic", () => {
  const phrases = [
    "Owner-approved lineup.", "User accepted this counter.", "Approved by the owner.",
    "Provisional option, handle with care.", "Provisionally strong.",
    "See https://example.test/report for details.",
    "Historical handover from season 84.", "Research shows a clean clear.", "Evidence is strong.",
    "Won 3 of 4 battles at a 75% win rate.", "Sample size of 12.", "Seen in 5 battles.",
    "Tier A banner score 60.", "Planning estimate only.", "Tracked in issue #216.", "Per PR #230."
  ];
  for (const note of phrases) {
    const report = check(note);
    const found = editorial(report);
    assert.ok(found.some((finding) => finding.code === "NOTE_PROCESS_COMMENTARY" && finding.severity === "blocking"), note);
    assert.equal(report.summary.releaseGate, "FAIL", note);
    const finding = found.find((entry) => entry.code === "NOTE_PROCESS_COMMENTARY");
    assert.equal(finding.location, "matchups/5v5.json");
    assert.equal(finding.subject, `${target.defence} / ${target.counters[scoredIndex].counterId}`);
    assert.ok(finding.observed.includes(JSON.stringify(note)));
    assert.match(finding.expected, /tactical instruction only; remove the .*\(".+"\)/);
  }
});

test("a note over the length target is an editorial warning for human review, never a refusal", () => {
  const exactly = "Kill the leader first; ".padEnd(NOTE_TARGET_LENGTH, "x");
  assert.equal(exactly.length, NOTE_TARGET_LENGTH);
  assert.deepEqual(editorial(check(exactly)), []);

  const long = `${exactly}x`;
  const report = check(long);
  assert.equal(report.summary.releaseGate, "PASS");
  assert.deepEqual(editorial(report).map((finding) => [finding.code, finding.severity]), [["NOTE_LENGTH", "warning"]]);
  assert.match(editorial(report)[0].observed, /121 characters/);

  const uncertain = check("Unverified; may or may not hold the taunt.");
  assert.equal(uncertain.summary.releaseGate, "PASS");
  assert.deepEqual(editorial(uncertain).map((finding) => finding.code), ["NOTE_UNCERTAINTY"]);
});

test("unchanged legacy verbose Notes never block an unrelated change; changing one makes it subject to the rule", () => {
  const legacy = "Owner-approved. Provisional planning estimate from https://example.test/old with a 60% win rate across 12 battles; an unusually long historical note that no longer follows the editorial target at all.";
  const baseline = withNote(legacy);
  // Control: examined as a new note, the same text is blocked.
  assert.equal(auditSource(baseline, { baseline: withNote("Short.") }).summary.releaseGate, "FAIL");

  // Unrelated change elsewhere in the same file and in another file.
  const unrelated = clone(baseline);
  const other = unrelated["matchups/5v5.json"].find((row) => row.defence !== target.defence && row.counters.some((entry) => entry.tier));
  other.counters.find((entry) => entry.tier).tier = "C";
  unrelated["defence-teams.json"][0].threat = "LOW";
  const report = auditSource(unrelated, { baseline });
  assert.deepEqual(editorial(report), []);
  assert.equal(report.summary.releaseGate, "PASS");

  // Amending the legacy note itself to different verbose text is checked; emptying it is allowed.
  assert.equal(auditSource(withNote(`${legacy} More.`, baseline), { baseline }).summary.releaseGate, "FAIL");
  assert.equal(auditSource(withNote("", baseline), { baseline }).summary.releaseGate, "PASS");
  // Without a baseline nothing is examined: existing catalogue and legacy tooling are unaffected.
  assert.deepEqual(editorial(auditSource(baseline)), []);
});

test("SETUP and CLEANUP keep required tactical notes and stay unscored", () => {
  const tactic = committed["matchups/5v5.json"].flatMap((row) => row.counters.map((entry) => ({ row, entry }))).find(({ entry }) => entry.role);
  assert.ok(tactic, "fixture needs an existing tactical step");
  const edit = (mutate) => {
    const next = clone(committed);
    mutate(next["matchups/5v5.json"].find((row) => row.defence === tactic.row.defence).counters.find((entry) => entry.counterId === tactic.entry.counterId));
    return next;
  };
  for (const blank of ["", "   "]) assert.equal(auditSource(edit((entry) => { entry.notes = blank; })).summary.releaseGate, "FAIL");
  assert.equal(auditSource(edit((entry) => { delete entry.notes; })).summary.releaseGate, "FAIL");
  assert.equal(auditSource(edit((entry) => { entry.tier = "A"; })).summary.releaseGate, "FAIL");

  const clean = edit((entry) => { entry.notes = "Strips the taunters so the later cleanup can finish them."; });
  const report = auditSource(clean, { baseline: committed });
  assert.equal(report.summary.releaseGate, "PASS");
  assert.deepEqual(editorial(report), []);
  const compiled = report.payload.counters["5v5"][tactic.row.defence].find((entry) => entry.counterId === tactic.entry.counterId);
  assert.equal(compiled.role, tactic.entry.role);
  assert.equal(compiled.tier, undefined);

  const withProcess = edit((entry) => { entry.notes = "Observed in 3 battles; owner-approved."; });
  assert.equal(auditSource(withProcess, { baseline: committed }).summary.releaseGate, "FAIL");
});

// ─── routes that carry a changed note to the gate ────────────────────────────

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "catalogue"), { recursive: true });
  fs.cpSync(path.join(ROOT, "catalogue", "source"), path.join(dir, "catalogue", "source"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "catalogue", "release.json"), path.join(dir, "catalogue", "release.json"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "baseline");
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", commit);
  git(dir, "switch", "-q", "-c", "notes-rehearsal");
  const release = JSON.parse(fs.readFileSync(path.join(dir, "catalogue", "release.json"), "utf8"));
  return { dir, commit, release, sourceDir: path.join(dir, "catalogue", "source") };
}

test("direct source edits: compile --base-ref checks only the notes the branch added or changed", (t) => {
  const repo = fixtureRepo(t);
  const args = ["compile", "--gate", "release", "--source", repo.sourceDir, "--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"];

  const unchanged = run(args);
  assert.equal(unchanged.exitCode, 0, unchanged.lines.join("\n"));

  writeSource(repo.sourceDir, withNote("Owner-approved: user accepted this lineup."));
  const blocked = run(args);
  assert.equal(blocked.exitCode, 1);
  assert.ok(blocked.lines.some((line) => /blocking NOTE_PROCESS_COMMENTARY matchups\/5v5\.json .*approval status/.test(line)), blocked.lines.join("\n"));

  writeSource(repo.sourceDir, withNote(`${"Kill the leader first; ".padEnd(NOTE_TARGET_LENGTH, "x")}x`));
  const warned = run(args);
  assert.equal(warned.exitCode, 0, warned.lines.join("\n"));
  assert.ok(warned.lines.some((line) => /warning NOTE_LENGTH/.test(line)));

  const missing = run([...args.slice(0, -1), "refs/remotes/origin/nonexistent"]);
  assert.equal(missing.exitCode, 2, "an unreadable baseline fails closed rather than checking every legacy note");
  assert.match(missing.lines[0], /cannot read the catalogue source at refs\/remotes\/origin\/nonexistent/);
});

test("schema-2 corrections: preview/apply refuse process wording and surface length warnings", (t) => {
  const repo = fixtureRepo(t);
  const baseline = { commit: repo.commit, catalogueVersion: repo.release.catalogueVersion, checksum: repo.release.checksum };
  const correctionFor = (note) => {
    const before = clone(target);
    const after = clone(target);
    after.counters[scoredIndex].notes = note;
    const correction = {
      id: "CR-2099-01-01-P01", status: "PENDING_OWNER_APPROVAL", disposition: "AMEND", title: "Synthetic note rehearsal",
      rationale: "Synthetic fixture for the GAC-NOTES1 editorial check.", approval: null,
      provenance: { evidence: [{ url: "https://example.test/evidence", publisher: "Synthetic fixture", publishedOrObservedAt: "2099-01-01", accessedAt: "2099-01-02", supports: "Synthetic." }], conditions: "Synthetic.", confidence: "High for the fixture.", limitations: "Never publishable." },
      affectedReferences: [{ file: "matchups/5v5.json", stableKey: { mode: "5v5", defence: target.defence }, effect: "Synthetic note change." }],
      runtimeImpact: { "5v5": "Synthetic.", "3v3": "none", FLEET: "none", counters: "Synthetic.", roundAvailability: "none", scoring: "none", strategicReserve: "none" },
      expectedPayloadPaths: [],
      changes: [{ file: "matchups/5v5.json", operation: "AMEND", stableKey: { mode: "5v5", defence: target.defence }, before, after }]
    };
    correction.expectedPayloadPaths = diffPayloads(compileSource(committed), compileSource(applyCorrections(committed, [correction]))).map((difference) => difference.path);
    return correction;
  };
  const write = (correction, approved = false) => {
    if (approved) {
      correction.status = "APPROVED";
      correction.approval = { reference: "https://github.com/nimbrethil81/gac-helper/issues/216#issuecomment-123456789", decidedAt: "2099-01-03T12:00:00Z", contentChecksum: contentChecksum(correction) };
    }
    const file = path.join(repo.dir, "change-set.json");
    fs.writeFileSync(file, `${JSON.stringify({ schema: 2, contract: "gac-catalogue-change-set:v1", issue: "https://github.com/nimbrethil81/gac-helper/issues/216", baseline, corrections: [correction] }, null, 2)}\n`);
    return file;
  };
  const common = ["--repo", repo.dir, "--base-ref", "refs/remotes/origin/main"];

  const bad = correctionFor("Owner-approved; won 3 of 4 battles.");
  const refused = run(["corrections", write(bad), ...common, "--preview", bad.id]);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.lines[0], /NOTE_PROCESS_COMMENTARY .* \/ .* — "Owner-approved; won 3 of 4 battles\." — a tactical instruction only; remove the approval status/);

  const approvedBad = correctionFor("Provisional note.");
  const applyRefused = run(["corrections", write(approvedBad, true), ...common, "--apply", approvedBad.id]);
  assert.equal(applyRefused.exitCode, 2);
  assert.match(applyRefused.lines[0], /NOTE_PROCESS_COMMENTARY/);
  assert.deepEqual(readSource(repo.sourceDir).source, committed, "nothing was written");

  const long = correctionFor(`${"Kill the leader first; ".padEnd(NOTE_TARGET_LENGTH, "x")}x`);
  const warned = run(["corrections", write(long), ...common, "--preview", long.id]);
  assert.equal(warned.exitCode, 0, warned.lines.join("\n"));
  assert.match(warned.lines.join("\n"), /Editorial note review \(GAC-NOTES1.*\n  warning NOTE_LENGTH/);

  const good = correctionFor("Kill the leader first.");
  const clean = run(["corrections", write(good), ...common, "--preview", good.id]);
  assert.equal(clean.exitCode, 0, clean.lines.join("\n"));
  assert.doesNotMatch(clean.lines.join("\n"), /Editorial note review/);
});
