"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  auditPayload,
  auditSnapshot,
  diffPayloads,
  emulateActionData,
  loadSnapshot,
  renderMarkdown
} = require("../scripts/catalogue-audit-lib.js");
const { run: runCli } = require("../scripts/catalogue-audit.js");
const { createSnapshot } = require("../scripts/catalogue-snapshot.js");
const { openWorkbook } = require("../scripts/xlsx-lib.js");
const { counterRow, validSnapshot, withCapture } = require("./catalogue-audit-fixture.js");

const ROOT = path.resolve(__dirname, "..");
const FRESH_BASELINE = path.join(ROOT, "data", "snapshots", "20261010T070702Z");
const HISTORICAL_EXPORT = path.join(ROOT, "data", "exports", "20260921T085937Z");

const codes = (report, severity) => report.findings.filter((finding) => !severity || finding.severity === severity).map((finding) => finding.code);
const findingsOf = (report, code) => report.findings.filter((finding) => finding.code === code);
const gateFindings = (report) => report.findings.filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval");

function audit(mutate) {
  const snapshot = validSnapshot();
  if (mutate) mutate(snapshot.tabs, snapshot);
  return auditSnapshot(withCapture(snapshot));
}

// ─── valid shapes pass ───────────────────────────────────────────────────────

test("valid synthetic catalogue passes the release gate with no warnings", () => {
  const report = audit();
  assert.deepEqual(gateFindings(report), []);
  assert.deepEqual(codes(report, "warning"), []);
  assert.equal(report.summary.releaseGate, "PASS");
  assert.equal(report.parity.status, "MATCH");
});

test("partial, recommended-only and flexible compositions plus sparse threats are legitimate", () => {
  const report = audit();
  const info = codes(report, "info");
  assert.ok(info.includes("COUNTER_NO_REQUIRED_MEMBERS"), "flexible counter is noted, not failed");
  assert.ok(findingsOf(report, "DEFENCE_ONLY_IDENTITY").some((finding) => finding.subject === "Chief Chirpa"));
  assert.deepEqual(findingsOf(report, "DEFENCE_NAME_CROSS_MODE_VARIANT").map((finding) => finding.subject), ["Geonosian / Geonosians"]);
  assert.equal(findingsOf(report, "THREAT_BLANK").length, 0);
});

test("FLEET counters with ships and a six-unit undersize pass unchanged", () => {
  const report = audit();
  assert.equal(report.findings.filter((finding) => finding.mode === "FLEET" && finding.severity !== "info").length, 0);
  assert.equal(report.payloadCounts.counters.byMode.FLEET.rows, 1);
});

test("one-letter different names (Rey/Rex) are never candidate aliases", () => {
  const report = audit();
  assert.equal(report.findings.filter((finding) => /Rey|Rex/.test(finding.subject)).length, 0);
});

test("leader-name display conventions are never enforced (REVA, GUNGANS)", () => {
  const report = audit();
  const k6 = report.knownFindings.filter((entry) => entry.id.startsWith("K6"));
  assert.deepEqual(k6.map((entry) => entry.status), ["CONFIRMED", "CONFIRMED"]);
  assert.equal(report.findings.filter((finding) => finding.subject === "REVA" || finding.subject === "GUNGANS").length, 0);
});

// ─── structural Sheet problems ───────────────────────────────────────────────

test("incomplete rows silently skipped by Apps Script are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid.push(["", "Gungans", "LEIA", "Leia Organa", "S", 62, "", 0, "half-filled"]);
    tabs.Counter_Composition.grid.push(["LEIA", "", "REQUIRED"]);
    tabs.Defence_Teams.grid.push(["", "5v5", "HIGH", ""]);
    tabs.Defence_Composition.grid.push(["Gungans", "5v5", ""]);
    tabs.GAC_Scoring.grid.push(["", "ANY", "ANY", 5, "orphan"]);
  });
  const skipped = findingsOf(report, "ROW_SKIPPED_INCOMPLETE");
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every((finding) => finding.severity === "blocking"));
  assert.ok(skipped.some((finding) => finding.location === "Counters row 10"));
});

test("derived-formula spill rows with no authored content are not reported", () => {
  const report = audit((tabs) => { tabs.Counters.grid.push(["", "", "", "", "", "", "", "", ""]); });
  assert.equal(findingsOf(report, "ROW_SKIPPED_INCOMPLETE").length, 0);
});

test("header problems are reported per access style", () => {
  const report = audit((tabs) => {
    tabs.Counter_Composition.grid[0] = ["Character_ID", "Counter_ID", "Role"];
    tabs.Character_Definitions.grid[0] = ["Character_ID", "Name", "Unit_Type", "External_ID"];
    tabs.Counters.grid[0] = [...tabs.Counters.grid[0], "Reliability"];
    tabs.Counters.grid.slice(1).forEach((row) => row.push(""));
  });
  assert.equal(findingsOf(report, "HEADER_POSITION").length, 2);
  assert.ok(findingsOf(report, "HEADER_MISSING").some((finding) => finding.subject === "Character_Name" && /silently reads column 2/.test(finding.effect)));
  assert.ok(findingsOf(report, "HEADER_UNKNOWN").some((finding) => finding.subject === "Reliability"));
});

test("missing required tab blocks and skips parity; missing optional tab warns", () => {
  const report = audit((tabs) => { delete tabs.Defence_Composition; });
  assert.deepEqual(findingsOf(report, "OPTIONAL_TAB_MISSING").map((finding) => finding.severity), ["warning"]);
  const snapshot = validSnapshot();
  delete snapshot.tabs.Counter_Composition;
  const broken = auditSnapshot(snapshot);
  assert.equal(findingsOf(broken, "SNAPSHOT_TAB_MISSING")[0].severity, "blocking");
  assert.equal(broken.parity.status, "NOT RUN");
});

test("formula errors, lost/short array formulas, stale derived names and stray formulas are flagged", () => {
  const lost = audit((tabs) => { tabs.Counters.formulas = tabs.Counters.formulas.filter((formula) => formula.cell !== "D2"); });
  assert.deepEqual(findingsOf(lost, "DERIVED_FORMULA_MISSING").map((finding) => finding.subject), ["Counter Team"]);

  const short = audit((tabs) => { tabs.Counters.formulas[0].ref = "D2:D5"; });
  assert.equal(findingsOf(short, "DERIVED_FORMULA_RANGE")[0].severity, "blocking");

  const spill = audit((tabs) => {
    tabs.Counters.grid[1][3] = "#REF!";
    tabs.Counters.errors.push({ cell: "D2", value: "#REF!" });
    tabs.Defence_Teams.formulas.push({ cell: "C2", formula: "=UPPER(\"high\")" });
  });
  assert.equal(findingsOf(spill, "FORMULA_ERROR").length, 1);
  assert.equal(findingsOf(spill, "DERIVED_VALUE_MISMATCH").length, 1);
  assert.equal(findingsOf(spill, "UNEXPECTED_FORMULA")[0].location, "Defence_Teams!C2");
});

test("CSV snapshots report that formula checks could not run", () => {
  const report = audit((tabs) => { tabs.Counters.formulaMetadata = false; });
  assert.equal(findingsOf(report, "FORMULA_METADATA_UNAVAILABLE").length, 1);
});

// ─── identifiers and references ──────────────────────────────────────────────

test("unknown and placeholder-synthesised counter references are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid.push(["3v3", "Gungans", "MAZ_KANATA", "", "A", 54, "", 0, ""]);
    tabs.Counter_Composition.grid.push(["MAZ_KANATA", "R2_D2", "REQUIRED"]);
  });
  assert.equal(findingsOf(report, "MATCHUP_UNKNOWN_COUNTER").length, 1);
  assert.equal(findingsOf(report, "MATCHUP_COUNTER_NAME_BLANK").length, 1);
  const synthesised = findingsOf(report, "COMPOSITION_UNKNOWN_COUNTER");
  assert.equal(synthesised.length, 1);
  assert.match(synthesised[0].effect, /synthesises counterDefinitions\["MAZ_KANATA"\] with name "MAZ_KANATA"/);
  assert.equal(emulateActionData(validSnapshot().tabs).counterDefinitions.MAZ_KANATA, undefined);
});

test("unknown Character_IDs in counter and defence compositions are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counter_Composition.grid.push(["LEIA", "NOT_A_UNIT", "RECOMMENDED"]);
    tabs.Defence_Composition.grid.push(["Gungans", "5v5", "KELLERAN_BEQ"]);
  });
  assert.equal(findingsOf(report, "COMPOSITION_UNKNOWN_UNIT")[0].severity, "blocking");
  assert.equal(findingsOf(report, "DEFENCE_COMPOSITION_UNKNOWN_UNIT")[0].subject, "Gungans / KELLERAN_BEQ");
});

test("duplicate and conflicting roles are blocking; dropped roles are blocking; case variants warn", () => {
  const report = audit((tabs) => {
    tabs.Counter_Composition.grid.push(["LEIA", "R2_D2", "REQUIRED"]);
    tabs.Counter_Composition.grid.push(["REVA", "LEIA_ORGANA", "OPTIONAL"]);
    tabs.Counter_Composition.grid[4][2] = "required";
  });
  assert.equal(findingsOf(report, "COMPOSITION_DUPLICATE_MEMBER")[0].observed, "RECOMMENDED + REQUIRED");
  assert.equal(findingsOf(report, "COMPOSITION_ROLE_DROPPED").length, 1);
  assert.ok(findingsOf(report, "NONCANONICAL_SPELLING").some((finding) => finding.observed === "\"required\""));
});

test("duplicate Character_ID, Counter_ID and External_ID are blocking", () => {
  const report = audit((tabs) => {
    tabs.Character_Definitions.grid.push(["WICKET", "Wicket again", "CHARACTER", "GLLEIA"]);
    tabs.Counter_Definitions.grid.push(["FLEX", "Flex 2", ""]);
  });
  for (const code of ["DUPLICATE_UNIT_ID", "DUPLICATE_COUNTER_ID", "DUPLICATE_EXTERNAL_ID"]) {
    assert.equal(findingsOf(report, code)[0]?.severity, "blocking", code);
  }
});

test("blank names, invalid unit types and missing External_IDs on required members are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counter_Definitions.grid[2][1] = "";
    tabs.Character_Definitions.grid[1][2] = "";
    tabs.Character_Definitions.grid[1][3] = "";
    tabs.Character_Definitions.grid[2][3] = "";
  });
  assert.equal(findingsOf(report, "COUNTER_NAME_BLANK").length, 1);
  assert.equal(findingsOf(report, "UNIT_TYPE_INVALID")[0].subject, "LEIA_ORGANA");
  assert.deepEqual(findingsOf(report, "REQUIRED_UNIT_NO_EXTERNAL_ID").map((finding) => finding.subject), ["LEIA / LEIA_ORGANA"]);
  assert.deepEqual(findingsOf(report, "UNIT_NO_EXTERNAL_ID").map((finding) => finding.subject).sort(), ["LEIA_ORGANA", "R2_D2"]);
});

test("unit type vs FLEET compatibility is enforced for matchups, counters and defences", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid.push(counterRow("FLEET", "Home One", "LEIA", "S", 73, 0));
    tabs.Counters.grid.push(counterRow("5v5", "Gungans", "EXECUTOR", "S", 62, 0));
    tabs.Counter_Composition.grid.push(["REVA", "TIE_FIGHTER", "RECOMMENDED"]);
    tabs.Defence_Composition.grid.push(["Gungans", "5v5", "TIE_FIGHTER"]);
  });
  // FLEET←LEIA, 5v5←EXECUTOR, and both squad matchups of the now-mixed REVA.
  assert.equal(findingsOf(report, "MATCHUP_UNIT_TYPE_MODE").length, 4);
  assert.deepEqual(findingsOf(report, "COUNTER_UNIT_TYPE_MIXED").map((finding) => finding.subject), ["REVA"]);
  assert.equal(findingsOf(report, "DEFENCE_COMPOSITION_UNIT_TYPE").length, 1);
});

test("strategic reserve values outside the recognised spellings warn", () => {
  const report = audit((tabs) => { tabs.Counter_Definitions.grid[2][2] = "High"; });
  assert.deepEqual(findingsOf(report, "STRATEGIC_RESERVE_VALUE").map((finding) => [finding.subject, finding.severity]), [["REVA", "warning"]]);
});

// ─── matchup values ──────────────────────────────────────────────────────────

test("invalid modes, tiers, banner scores and undersize counts are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid[1][4] = "s";
    tabs.Counters.grid[2][5] = 66;
    tabs.Counters.grid[3][7] = 3;
    tabs.Counters.grid.push(counterRow("fleet", "Home One", "EXECUTOR", "S", 73, 0));
    tabs.Counters.grid.push(counterRow("3v3", "Gungans", "REVA", "A", "54", 0));
  });
  assert.equal(findingsOf(report, "TIER_INVALID").length, 1);
  assert.equal(findingsOf(report, "BANNER_SCORE_INVALID").length, 2);
  assert.equal(findingsOf(report, "UNDERSIZE_INVALID")[0].observed, "3");
  assert.equal(findingsOf(report, "MATCHUP_MODE_INVALID")[0].observed, "\"fleet\"");
});

test("legacy or blank undersize warns (read as 0) and unknown banner meanings warn", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid[1][7] = "Yes";
    tabs.Counters.grid[2][7] = "";
    tabs.Counters.grid[5][5] = 59;
    tabs.Counters.grid[5][6] = "";
  });
  assert.equal(findingsOf(report, "UNDERSIZE_NONNUMERIC").length, 2);
  assert.equal(findingsOf(report, "BANNER_SCORE_NO_MEANING").length, 1);
  assert.equal(gateFindings(report).length, 0);
});

test("duplicate logical matchup keys need owner approval and keep both rows visible", () => {
  const report = audit((tabs) => { tabs.Counters.grid.push(counterRow("5v5", "Gungans", "LEIA", "S", 62, 0)); });
  const [duplicate] = findingsOf(report, "DUPLICATE_MATCHUP");
  assert.equal(duplicate.severity, "owner-approval");
  assert.match(duplicate.observed, /Counters row 2: .*notes "Strong" \| Counters row 10: .*notes ""/);
});

// ─── defence identity ────────────────────────────────────────────────────────

test("Defence_Teams Mode \"Any\" needs owner approval; it is never applied at runtime", () => {
  const report = audit((tabs) => { tabs.Defence_Teams.grid[2][1] = "Any"; });
  const [finding] = findingsOf(report, "DEFENCE_MODE_CASE");
  assert.equal(finding.severity, "owner-approval");
  assert.match(finding.effect, /only looks up "ANY"/);
  assert.equal(report.knownFindings.find((entry) => entry.id === "K2").status, "STILL PRESENT");
});

test("5v5 Gungan vs Gungans is a candidate alias, not a rename", () => {
  const snapshot = validSnapshot();
  snapshot.tabs.Defence_Teams.grid[1][0] = "Gungan";
  const report = auditSnapshot(withCapture(snapshot));
  const [alias] = findingsOf(report, "DEFENCE_ALIAS_CANDIDATE");
  assert.equal(alias.severity, "owner-approval");
  assert.match(alias.expected, /candidate alias "Gungans"/);
  assert.match(alias.effect, /never applied to "Gungans"/);
  assert.ok(emulateActionData(snapshot.tabs).defenceTeams["5v5"].Gungan, "the audit never rewrites source data");
  assert.equal(report.knownFindings.find((entry) => entry.id === "K1").status, "STILL PRESENT");
});

test("same-mode Counters name variants warn; distinct modes are informational only", () => {
  const report = audit((tabs) => { tabs.Counters.grid.push(counterRow("5v5", "gungans", "REVA", "A", 61, 0)); });
  const [variant] = findingsOf(report, "DEFENCE_NAME_VARIANT");
  assert.equal(variant.severity, "warning");
  assert.equal(variant.mode, "5v5");
  assert.equal(findingsOf(report, "DEFENCE_NAME_CROSS_MODE_VARIANT")[0].severity, "info");
});

test("threat validation: invalid blocks, blank and lower-case warn, duplicates block", () => {
  const report = audit((tabs) => {
    tabs.Defence_Teams.grid.push(["Rey", "5v5", "Hgh", ""]);
    tabs.Defence_Teams.grid.push(["Rex", "5v5", "", ""]);
    tabs.Defence_Teams.grid.push(["Geonosian", "3v3", "low", ""]);
    tabs.Defence_Teams.grid.push(["Gungans", "5v5", "LOW", ""]);
  });
  assert.equal(findingsOf(report, "THREAT_INVALID")[0].severity, "blocking");
  assert.equal(findingsOf(report, "THREAT_BLANK")[0].severity, "warning");
  assert.ok(findingsOf(report, "NONCANONICAL_SPELLING").some((finding) => finding.observed === "\"low\""));
  assert.equal(findingsOf(report, "DEFENCE_TEAM_DUPLICATE")[0].observed, "\"HIGH\", \"LOW\"");
});

test("defence composition: FLEET rows are unreachable, oversize squads warn, duplicates warn", () => {
  const report = audit((tabs) => {
    tabs.Defence_Composition.grid.push(["Home One", "FLEET", "EXECUTOR_SHIP"]);
    for (const id of ["LEIA_ORGANA", "R2_D2", "THIRD_SISTER", "WICKET"]) tabs.Defence_Composition.grid.push(["Chief Chirpa", "3v3", id]);
    tabs.Defence_Composition.grid.push(["Gungans", "5v5", "BOSS_NASS"]);
  });
  assert.equal(findingsOf(report, "DEFENCE_COMPOSITION_FLEET_UNREACHABLE").length, 1);
  assert.equal(findingsOf(report, "DEFENCE_COMPOSITION_OVERSIZE")[0].observed, "5 units");
  assert.equal(findingsOf(report, "DEFENCE_COMPOSITION_DUPLICATE_MEMBER").length, 2);
});

// ─── board, scoring and privacy ──────────────────────────────────────────────

test("board config shape, values and duplicates are validated", () => {
  const report = audit((tabs) => {
    tabs.GAC_Board_Config.grid = tabs.GAC_Board_Config.grid.filter((row, index) => index !== 4);
    tabs.GAC_Board_Config.grid[5][4] = -1;
    tabs.GAC_Board_Config.grid.push(["KYBER", "3v3", "FRONT_TOP", "SQUAD", 5]);
  });
  assert.ok(findingsOf(report, "BOARD_SHAPE").some((finding) => finding.subject === "KYBER 5v5"));
  assert.equal(findingsOf(report, "BOARD_ROW_INVALID").length, 1);
  assert.equal(findingsOf(report, "BOARD_DUPLICATE").length, 1);
});

test("scoring rules, SETTING_DEFENCE and unit counts are validated", () => {
  const missing = audit((tabs) => { tabs.GAC_Scoring.grid = tabs.GAC_Scoring.grid.filter((row) => row[0] !== "SETTING_DEFENCE"); });
  assert.equal(findingsOf(missing, "SETTING_DEFENCE").length, 1);
  const report = audit((tabs) => {
    tabs.GAC_Scoring.grid[3][3] = 6;
    tabs.GAC_Scoring.grid.push(["VICTORY", "ANY", "ANY", "fifteen", ""]);
  });
  assert.equal(findingsOf(report, "SCORING_UNIT_COUNT")[0].observed, "6");
  assert.equal(findingsOf(report, "SCORING_ROW_INVALID").length, 1);
  assert.equal(findingsOf(report, "SCORING_DUPLICATE").length, 1);
});

test("personal or credential-shaped values in catalogue data are blocking", () => {
  const report = audit((tabs) => {
    tabs.Counters.grid[1][8] = "ask someone@example.com";
    tabs.Defence_Teams.grid[1][3] = "seen on 123-456-789";
  });
  assert.deepEqual(findingsOf(report, "SENSITIVE_CONTENT").map((finding) => finding.observed).sort(), ["ally-code-shaped", "email-shaped"]);
});

// ─── parity and the payload route ────────────────────────────────────────────

test("parity reports every divergence between the Sheet and the captured action=data", () => {
  const snapshot = withCapture(validSnapshot());
  snapshot.actionData.payload.counters["5v5"].Gungans[0].tier = "A";
  snapshot.actionData.payload.defenceTeams.ANY.Extra = { threat: "LOW", notes: "" };
  const report = auditSnapshot(snapshot);
  assert.equal(report.parity.status, "MISMATCH");
  assert.deepEqual(findingsOf(report, "PARITY_MISMATCH").map((finding) => finding.location), [
    "payload[\"counters\"][\"5v5\"][\"Gungans\"][0][\"tier\"]",
    "payload[\"defenceTeams\"][\"ANY\"][\"Extra\"]"
  ]);
  assert.notEqual(report.parity.emulatedChecksum, report.parity.capturedChecksum);
});

test("parity ignores object key order but not array order", () => {
  assert.deepEqual(diffPayloads({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), []);
  assert.equal(diffPayloads({ b: [1, 2] }, { b: [2, 1] }).length, 2);
});

test("the payload route applies the same rules to a compiled seven-key catalogue", () => {
  const payload = emulateActionData(validSnapshot().tabs);
  assert.equal(auditPayload(payload).summary.releaseGate, "PASS");
  assert.equal(auditPayload({ ...payload, release: { contract: "gac-catalogue-release:v1" } }).summary.releaseGate, "PASS");

  const broken = JSON.parse(JSON.stringify(payload));
  broken.defenceTeams.Any = { "Home One": { threat: "HIGH", notes: "" } };
  broken.defenceCompositions["3v3"]["Chief Chirpa"].push("JOCASTA_NU");
  broken.counters["5v5"].Gungans.push({ ...broken.counters["5v5"].Gungans[0] });
  broken.extra = true;
  const report = auditPayload(broken);
  for (const code of ["DEFENCE_MODE_CASE", "DEFENCE_COMPOSITION_UNKNOWN_UNIT", "DUPLICATE_MATCHUP", "PAYLOAD_SHAPE"]) {
    assert.ok(codes(report).includes(code), code);
  }
});

test("emulation stays in lock-step with apps-script/Code.gs action=data", () => {
  // If this fails, Code.gs's data path changed: update emulateActionData to
  // match, then update the digest. Parity findings are meaningless otherwise.
  const source = fs.readFileSync(path.join(ROOT, "apps-script", "Code.gs"), "utf8");
  const dataPath = source.slice(source.indexOf("// ─── DATA PAYLOAD"), source.indexOf("// ─── ROSTER FETCH"));
  assert.equal(crypto.createHash("sha256").update(dataPath).digest("hex"), "0787ec06b2d8470d1411f37032204ca90d84f3ea63b7e91a5dc3e2a0d25238c7");
});

// ─── committed baselines ─────────────────────────────────────────────────────

test("the historical CSV export reconciles exactly and shows its known defects", () => {
  const report = auditSnapshot(loadSnapshot(HISTORICAL_EXPORT));
  assert.equal(report.parity.status, "MATCH");
  assert.ok(findingsOf(report, "COMPOSITION_UNKNOWN_COUNTER").some((finding) => finding.subject === "MAZ_KANATA"));
  assert.equal(findingsOf(report, "DEFENCE_MODE_CASE").length, 8);
});

test("the fresh 2026-10-10 baseline reconciles exactly with live action=data", () => {
  const report = auditSnapshot(loadSnapshot(FRESH_BASELINE));
  assert.equal(report.parity.status, "MATCH");
  assert.equal(report.input.capturedAt, "2026-10-10T07:07:02Z");
});

test("the fresh baseline explicitly reports every known 2026-10-10 observation", () => {
  const report = auditSnapshot(loadSnapshot(FRESH_BASELINE));
  const status = Object.fromEntries(report.knownFindings.map((entry) => [entry.id, entry.status]));
  assert.deepEqual(status, {
    K1: "STILL PRESENT",
    K2: "STILL PRESENT",
    K3: "STILL PRESENT",
    K4: "PRESENT",
    K5a: "PRESENT",
    K5b: "PRESENT",
    K6a: "CONFIRMED",
    K6b: "CONFIRMED"
  });
  assert.equal(findingsOf(report, "DEFENCE_MODE_CASE").length, 8);
  assert.deepEqual(findingsOf(report, "DEFENCE_COMPOSITION_UNKNOWN_UNIT").map((finding) => finding.observed).sort(), ["JOCASTA_NU", "KELLERAN_BEQ"]);
  assert.equal(report.summary.releaseGate, "FAIL", "known defects are reported, never masked");
});

test("committed baseline reports are exactly what the audit regenerates", () => {
  const report = auditSnapshot(loadSnapshot(FRESH_BASELINE));
  assert.equal(fs.readFileSync(path.join(FRESH_BASELINE, "audit-report.md"), "utf8"), renderMarkdown(report));
  assert.equal(fs.readFileSync(path.join(FRESH_BASELINE, "audit-report.json"), "utf8"), `${JSON.stringify(report, null, 2)}\n`);
});

// ─── CLI and snapshot input route ────────────────────────────────────────────

test("CLI: parity gate reports, release gate fails on the baseline, stale snapshots fail", () => {
  assert.equal(runCli({ snapshot: FRESH_BASELINE, gate: "parity" }).exitCode, 0);
  assert.equal(runCli({ snapshot: FRESH_BASELINE, gate: "release" }).exitCode, 1);
  assert.equal(runCli({ snapshot: FRESH_BASELINE, gate: "parity", maxAgeDays: 14, now: "2026-10-20T00:00:00Z" }).exitCode, 0);
  const stale = runCli({ snapshot: FRESH_BASELINE, gate: "parity", maxAgeDays: 14, now: "2026-11-01T00:00:00Z" });
  assert.equal(stale.exitCode, 1);
  assert.ok(stale.lines.some((line) => /STALE/.test(line)));
});

test("CLI: a tampered snapshot is rejected before auditing", (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-audit-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(FRESH_BASELINE, copy, { recursive: true });
  const file = path.join(copy, "tabs", "Defence_Teams.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\"Any\"", "\"ANY\""));
  const result = runCli({ snapshot: copy, gate: "parity" });
  assert.equal(result.exitCode, 2);
  assert.match(result.lines[0], /SHA-256 differs/);
});

// Build a stored (uncompressed) .xlsx in memory: enough structure for the
// reader, including a personal tab that must never be extracted.
function buildXlsx(sheets) {
  const parts = [];
  const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  parts.push(["xl/workbook.xml", xml(`<workbook xmlns:r="r"><sheets>${sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`)]);
  parts.push(["xl/_rels/workbook.xml.rels", xml(`<Relationships>${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`)]);
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (value && typeof value === "object" && value.f) return `<c r="${ref}" t="${value.e ? "e" : "str"}"><f t="array" ref="${value.ref}">${escape(value.f)}</f><v>${escape(value.v)}</v></c>`;
      if (typeof value === "number") return `<c r="${ref}"><v>${value}.0</v></c>`;
      if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      if (value === "") return `<c r="${ref}"/>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
    }).join("")}</row>`).join("");
    parts.push([`xl/worksheets/sheet${index + 1}.xml`, xml(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)]);
  });

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test("xlsx snapshot route: typed values, formulas and errors; personal tabs never extracted", (t) => {
  const fixture = validSnapshot();
  const sheets = Object.entries(fixture.tabs).map(([name, tab]) => ({ name, rows: tab.grid.map((row) => [...row]) }));
  const counters = sheets.find((sheet) => sheet.name === "Counters");
  counters.rows[1][3] = { f: "IF(C2:C1001=\"\",\"\",IFERROR(VLOOKUP(C2:C1001,Counter_Definitions!A:B,2,FALSE),\"\"))", ref: "D2:D1001", v: counters.rows[1][3] };
  counters.rows[1][6] = { f: "IF(A2:A1001=\"\",\"\",IFERROR(VLOOKUP(A2:A1001,Score_Meanings!A:C,3,FALSE),\"\"))", ref: "G2:G1001", v: counters.rows[1][6] };
  sheets.push({ name: "Roster", rows: [["Ally code"], ["123456789"]] });
  sheets.push({ name: "GAC History", rows: [["Opponent"], ["someone@example.com"]] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const xlsx = path.join(dir, "workbook.xlsx");
  fs.writeFileSync(xlsx, buildXlsx(sheets));

  const workbook = openWorkbook(fs.readFileSync(xlsx));
  const read = workbook.readSheet("Counters");
  assert.equal(read.grid.length, 1001, "array formula range defines the getDataRange extent");
  assert.equal(read.grid[1][5], 62);
  assert.equal(read.formulas.length, 2);

  const out = path.join(dir, "snapshot");
  const actionData = path.join(dir, "action-data.json");
  fs.writeFileSync(actionData, JSON.stringify(emulateActionData(fixture.tabs)));
  const { manifest } = createSnapshot({ xlsx, capturedAt: "2026-10-10T00:00:00Z", actionData, actionDataCapturedAt: "2026-10-10T00:01:00Z", out });
  assert.deepEqual(manifest.missingCatalogueTabs, []);
  assert.ok(!manifest.tabs.some((entry) => /Roster|History/.test(entry.tab)));
  const written = fs.readdirSync(out, { recursive: true }).map(String);
  assert.ok(written.every((file) => !/Roster|History/.test(file)));
  for (const file of written.filter((name) => name.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(out, file), "utf8");
    assert.ok(!text.includes("123456789") && !text.includes("someone@example.com"), `${file} must not contain personal-tab data`);
  }

  const report = auditSnapshot(loadSnapshot(out));
  assert.equal(report.parity.status, "MATCH");
  assert.equal(report.summary.releaseGate, "PASS");
  assert.throws(() => createSnapshot({ xlsx, capturedAt: "2026-10-10T00:00:00Z", out }), /Refusing to overwrite/);
});
