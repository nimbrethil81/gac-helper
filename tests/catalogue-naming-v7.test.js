"use strict";

// Regression proof for the GAC naming cleanup CR-2026-10-10-03-P01 (#56/#57),
// released as catalogue v7. Like the C1-C5 proof in catalogue-source.test.js,
// every catalogue here is rebuilt from immutable inputs (the frozen capture,
// the schema-1 migration list and the approved schema-2 change set), never
// read from mutable catalogue/source/, so later releases do not invalidate it.
// The app checks run that rebuilt v7 payload through app.js with the same
// vm harness as the other Round tests.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { auditSnapshot, diffPayloads, loadSnapshot, payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const { applyCorrections, compileSource, correctionChecksum, importSnapshot, isApplied, readCorrections } = require("../scripts/catalogue-source-lib.js");

const ROOT = path.resolve(__dirname, "..");
const NAMING_FILE = path.join(ROOT, "catalogue", "corrections", "2026-10-10-gac-naming-cleanup.json");
const V7_CHECKSUM = "sha256:04061fdb82991a5a5c0badd03ac1cd116e0280d1677f42ca90e7e125f4a461e5";
const APPROVED_CHECKSUM = "sha256:d125394ac1660d34854aee6642e25ea868503519cd0f342e299d56712e499d6e";

const snapshot = loadSnapshot(path.join(ROOT, "data", "snapshots", "20261010T070702Z"));
const migration = readCorrections(path.join(ROOT, "catalogue", "corrections", "2026-10-10-baseline.json"));
const v6Source = applyCorrections(importSnapshot(snapshot, auditSnapshot(snapshot)), migration.corrections.filter((c) => c.status === "APPROVED"));
const changeSet = readCorrections(NAMING_FILE);
const proposal = changeSet.corrections.find((c) => c.id === "CR-2026-10-10-03-P01");
const v7Source = applyCorrections(v6Source, [proposal]);
const v6 = compileSource(v6Source);
const v7 = compileSource(v7Source);

// The owner-agreed OLD -> NEW names from #56, written out independently of the
// change-set file so the file cannot vouch for itself.
const DEFENCE_RENAMES = {
  "5v5": {
    Hondo: "Pirate King Hondo Ohnaka",
    Maul: "Maul (Mandalorian)",
    Finn: "Finn (Zorii Resistance)",
    "Bo-Katan Mandalore": "Bo-Katan (Mand'alor)",
    "Ahsoka Tano": "Ahsoka Tano (GL)",
    Rey: "Rey (GL)",
    "Leia Organa": "Leia Organa (GL)",
    "Cere UFU": "Cere (Malicos)"
  },
  "3v3": {
    Hondo: "Pirate King Hondo Ohnaka",
    Mauldalorians: "Maul (Mandalorian)",
    Rex: "CT-7567 Rex",
    Finn: "Finn (Zorii Resistance)",
    "Bo-Katan Mandalore": "Bo-Katan (Mand'alor)",
    "Ahsoka Tano": "Ahsoka Tano (GL)",
    Rey: "Rey (GL)",
    "Leia Organa": "Leia Organa (GL)",
    "Emperor Palp with Vader Dual's End": "Emperor Palpatine (Duel's End Vader)",
    Geonosian: "Geonosians",
    "Cere UFU": "Cere (Malicos)"
  }
};
const COUNTER_RENAMES = {
  BO_KATAN_MANDALORE: ["Bo-Katan Mandalore", "Bo-Katan (Mand'alor)"],
  LEIA: ["Leia Organa", "Leia Organa (GL)"],
  BAD_BATCH: ["Bad Batch", "Bad Batch (Hunter)"],
  VEERS: ["Imperial Troopers", "Imperial Troopers (Veers)"],
  PHOENIX: ["Phoenix", "Phoenix (Hera + Captain Rex)"],
  CERE: ["Cere UFU", "Cere (Malicos)"],
  CERE_SK: ["Cere Starkiller", "Cere (Malicos + Starkiller)"],
  MAUL: ["Maul", "Maul (Mandalorian)"]
};
const NEW_COUNTER_NAME = Object.fromEntries(Object.values(COUNTER_RENAMES));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-naming-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── catalogue proof ─────────────────────────────────────────────────────────

test("v7 is exactly the rebuilt v6 plus the checksum-approved naming change set", () => {
  assert.equal(payloadChecksum(v6), changeSet.baseline.checksum, "the change set is bound to the rebuilt v6");
  assert.equal(proposal.status, "APPROVED");
  assert.equal(proposal.approval.changeSetChecksum, APPROVED_CHECKSUM);
  assert.equal(correctionChecksum(changeSet, proposal), APPROVED_CHECKSUM);
  assert.equal(proposal.changes.length, 54);
  assert.equal(payloadChecksum(v7), V7_CHECKSUM, "rebuilt v7 is the recorded v7 release");
  const paths = diffPayloads(v6, v7).map((difference) => difference.path).sort();
  assert.deepEqual(paths, [...proposal.expectedPayloadPaths].sort(), "no compiled path beyond the approved ones");
});

test("every renamed defence moves to its exact new key with identical counters, and nothing else moves", () => {
  for (const [mode, renames] of Object.entries(DEFENCE_RENAMES)) {
    const expected = {};
    for (const [name, entries] of Object.entries(v6.counters[mode])) {
      expected[renames[name] ?? name] = entries.map((entry) => ({ ...entry, counter: NEW_COUNTER_NAME[entry.counter] ?? entry.counter }));
    }
    assert.deepEqual(v7.counters[mode], expected, `${mode}: order, tiers, banner scores, undersize and notes unchanged`);
    for (const [from, to] of Object.entries(renames)) {
      assert.ok(v6.counters[mode][from], `${mode} ${from} existed in v6`);
      assert.equal(v6.counters[mode][to], undefined, `${mode} ${to} did not collide in v6`);
      assert.equal(v7.counters[mode][from], undefined, `${mode} ${from} is gone`);
    }
  }
  assert.equal(Object.keys(DEFENCE_RENAMES["5v5"]).length + Object.keys(DEFENCE_RENAMES["3v3"]).length, 19);
  assert.deepEqual(v7.counters.FLEET, v6.counters.FLEET);
  assert.deepEqual(Object.keys(v7.counters).sort(), Object.keys(v6.counters).sort());
  assert.deepEqual(Object.keys(v7.counters["3v3"]).filter((name) => /Hondo/.test(name)), ["Pirate King Hondo Ohnaka"], "no second Hondo defence");
});

test("threat and composition keys follow the rename with unchanged content", () => {
  assert.deepEqual(v7.defenceTeams.ANY["Ahsoka Tano (GL)"], v6.defenceTeams.ANY["Ahsoka Tano"]);
  assert.equal(v7.defenceTeams.ANY["Ahsoka Tano (GL)"].threat, "HIGH");
  for (const [from, to] of [["Rex", "CT-7567 Rex"], ["Finn", "Finn (Zorii Resistance)"], ["Rey", "Rey (GL)"]]) {
    assert.deepEqual(v7.defenceCompositions["3v3"][to], v6.defenceCompositions["3v3"][from], `${to} keeps its exact units and order`);
  }
  const oldNames = new Set(Object.values(DEFENCE_RENAMES).flatMap((renames) => Object.keys(renames)));
  for (const [kind, byMode] of [["defenceTeams", v7.defenceTeams], ["defenceCompositions", v7.defenceCompositions]]) {
    for (const [mode, rows] of Object.entries(byMode)) {
      for (const name of Object.keys(rows)) {
        const stale = oldNames.has(name) && (mode === "ANY" || DEFENCE_RENAMES[mode]?.[name]);
        assert.ok(!stale, `${kind} ${mode} still references renamed ${name}`);
      }
    }
  }
  const { ANY: _v7Any, ...v7Teams } = v7.defenceTeams;
  const { ANY: _v6Any, ...v6Teams } = v6.defenceTeams;
  assert.deepEqual(v7Teams, v6Teams, "mode-specific threats unchanged");
});

test("counter IDs keep their members; only the eight display names and Phoenix's core change", () => {
  const expected = JSON.parse(JSON.stringify(v6.counterDefinitions));
  for (const [id, [from, to]] of Object.entries(COUNTER_RENAMES)) {
    assert.equal(v6.counterDefinitions[id].name, from);
    expected[id].name = to;
  }
  expected.PHOENIX.required = ["HERA_SYNDULLA", "CAPTAIN_REX"];
  assert.deepEqual(v7.counterDefinitions, expected);
  assert.deepEqual(v7.counterDefinitions.PHOENIX.recommended, v6.counterDefinitions.PHOENIX.recommended);
  assert.deepEqual(v7.characterDefinitions, v6.characterDefinitions, "no Character_ID, name or externalId changed");
  assert.equal(v7.characterDefinitions.HONDO_OHNAKA.name, "Hondo Ohnaka", "the original Hondo unit is untouched");
  assert.deepEqual(v7.scoring, v6.scoring);
  assert.deepEqual(v7.boardConfig, v6.boardConfig);
});

test("the approval is bound to the exact rows: tampering is refused and a stale baseline cannot apply", (t) => {
  const tampered = JSON.parse(fs.readFileSync(NAMING_FILE, "utf8"));
  tampered.corrections[0].changes[1].after.counters[0].tier = "A";
  const file = path.join(tempDir(t), "tampered.json");
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => readCorrections(file), /does not approve this exact baseline and diff/);

  assert.equal(isApplied(v7Source, proposal), true);
  assert.equal(isApplied(v6Source, proposal), false);
  const stale = JSON.parse(JSON.stringify(v6Source));
  stale["matchups/5v5.json"].find((row) => row.defence === "Hondo").counters[0].notes = "edited after approval";
  assert.throws(() => applyCorrections(stale, [proposal]), /stale before row/);
});

// ─── app behaviour on the v7 payload ─────────────────────────────────────────

const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function harness(initialStorage = {}) {
  const values = new Map(Object.entries(initialStorage));
  const context = {
    __GAC_HELPER_TEST__: true,
    console,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    alert: () => {},
    navigator: {},
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key)
    },
    document: {
      getElementById: () => ({ innerHTML: "" }),
      querySelectorAll: () => [],
      querySelector: () => null
    }
  };
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: "app.js" });
  const run = (expression) => vm.runInContext(expression, context);
  const json = (expression) => JSON.parse(run(`JSON.stringify(${expression})`));
  return { values, run, json };
}

const CONFIG = [
  { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
  { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
  { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
  { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
];

function withCatalogue(h, payload = v7) {
  h.run(`applyCataloguePayload(${JSON.stringify(payload)})`);
}

// One opponent board in `mode` with FRONT_BOTTOM set to `name`.
function opponentBoard(h, mode, name, { owned = [], defence = [] } = {}) {
  h.run(`
    board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(CONFIG)}, "opponent", "round-1", "2026-10-10T00:00:00Z");
    board.defenceSnapshot = { schema: 1, mode: "${mode}", capturedAt: "x", sourceTeamCount: 1,
      characterIds: ${JSON.stringify(defence)}, unresolvedTeams: [], missingSavedDefence: false };
    board.teams.find(t => t.territory === "FRONT_BOTTOM").name = ${JSON.stringify(name)};
    ownedCharacters = ${JSON.stringify(owned)};
    usedTeams = [];
  `);
}

const candidatesFor = (h, territory = "FRONT_BOTTOM") =>
  h.json(`buildEligibleTeams().find(t => t.territory === "${territory}").candidates.map(c => c.counterId)`);

test("Phoenix needs both Hera and Captain Rex, and either on defence or spent blocks it", () => {
  const h = harness();
  withCatalogue(h);
  const both = ["HERA_SYNDULLA", "CAPTAIN_REX"];
  for (const mode of ["5v5", "3v3"]) {
    opponentBoard(h, mode, "CLS", { owned: ["HERA_SYNDULLA"] });
    assert.equal(h.run(`getCounterStatus("PHOENIX")`), "not-owned", `${mode}: Hera alone`);
    assert.deepEqual(candidatesFor(h), [], `${mode}: no Phoenix candidate with Hera alone`);

    opponentBoard(h, mode, "CLS", { owned: ["CAPTAIN_REX"] });
    assert.equal(h.run(`getCounterStatus("PHOENIX")`), "not-owned", `${mode}: Captain Rex alone`);

    opponentBoard(h, mode, "CLS", { owned: both });
    assert.equal(h.run(`getCounterStatus("PHOENIX")`), "available", `${mode}: both, no extra member needed`);
    assert.deepEqual(candidatesFor(h), ["PHOENIX"], `${mode}: Phoenix offered for CLS`);

    for (const onDefence of both) {
      opponentBoard(h, mode, "CLS", { owned: both, defence: [onDefence] });
      assert.equal(h.run(`getCounterStatus("PHOENIX")`), "on-defence", `${mode}: ${onDefence} on defence`);
      assert.deepEqual(candidatesFor(h), [], `${mode}: not offered while ${onDefence} defends`);
    }

    opponentBoard(h, mode, "CLS", { owned: both });
    h.run(`usedTeams = ["PHOENIX"]`);
    assert.equal(h.run(`getCounterStatus("PHOENIX")`), "used");
    assert.equal(h.run(`spentCharacters().get("CAPTAIN_REX")`), "PHOENIX", "using Phoenix spends Captain Rex");
  }
});

test("renamed defences still resolve their committed units and threat", () => {
  const h = harness();
  withCatalogue(h);
  const resolve = (name, mode) => h.json(`resolveDefenceTeamCharacters(${JSON.stringify(name)}, "${mode}")`);
  for (const mode of ["5v5", "3v3"]) {
    assert.deepEqual(resolve("Cere (Malicos)", mode), { characterIds: ["CERE_JUNDA", "TARON_MALICOS"], complete: false });
    assert.deepEqual(resolve("Maul (Mandalorian)", mode), { characterIds: ["MAUL", "CANDEROUS_ORDO", "JANGO_FETT"], complete: false });
    assert.deepEqual(resolve("Bo-Katan (Mand'alor)", mode), { characterIds: v7.counterDefinitions.BO_KATAN_MANDALORE.required, complete: false });
    assert.deepEqual(resolve("Leia Organa (GL)", mode), { characterIds: v7.counterDefinitions.LEIA.required, complete: false });
    assert.equal(h.run(`threatFor("Ahsoka Tano (GL)", "${mode}")`), "HIGH");
    assert.equal(h.run(`threatFor("Ahsoka Tano", "${mode}")`), "NORMAL", "the old name no longer carries the threat");
  }
  for (const name of ["CT-7567 Rex", "Finn (Zorii Resistance)", "Rey (GL)"]) {
    assert.deepEqual(resolve(name, "3v3"), { characterIds: v7.defenceCompositions["3v3"][name], complete: true });
  }
  assert.equal(resolve("Rex", "3v3"), null, "old composition key no longer resolves");
});

test("an old saved opponent name stays visible with no counters until reselected; reselecting restores counters", () => {
  for (const [mode, oldName] of [["5v5", "Hondo"], ["3v3", "Hondo"], ["3v3", "Cere UFU"]]) {
    const newName = DEFENCE_RENAMES[mode][oldName];
    const h = harness();
    withCatalogue(h);
    const owned = Object.values(v7.counterDefinitions).flatMap((def) => def.required || []);
    opponentBoard(h, mode, oldName, { owned });
    h.run(`
      const team = board.teams.find(t => t.territory === "FRONT_BOTTOM");
      team.attempts = 2;
      board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
      bannerData.myScore = 120; bannerData.oppScore = 95; bannerData.remaining = 40;
    `);

    const row = h.run(`renderBoardTeamRow(board.territories.find(t => t.territory === "FRONT_BOTTOM"),
      board.teams.find(t => t.territory === "FRONT_BOTTOM"), board, "opponent")`);
    assert.ok(row.includes(`${oldName} (saved; not in current catalogue)`), `${mode} ${oldName} shows as saved`);
    assert.deepEqual(candidatesFor(h), [], `${mode} ${oldName}: no fallback counter`);
    assert.equal(h.run(`board.teams.find(t => t.territory === "FRONT_BOTTOM").name`), oldName, "never translated automatically");

    h.run(`setBoardTeam("opponent", "FRONT_BOTTOM", 0, ${JSON.stringify(newName)})`);
    assert.deepEqual(candidatesFor(h), [...new Set(v7.counters[mode][newName].map((c) => c.counterId))], "counters return after reselection");
    assert.deepEqual(h.json(`[board.teams.find(t => t.territory === "FRONT_BOTTOM").attempts,
      board.teams.find(t => t.territory === "FRONT_TOP").cleared, bannerData.myScore, bannerData.oppScore, bannerData.remaining]`),
      [2, true, 120, 95, null], "attempts, clears and scores kept; the manual remaining override clears");
  }
});

test("old My Board and template names persist, and the frozen defence snapshot is never rebuilt", () => {
  const frozen = { schema: 1, mode: "3v3", capturedAt: "2026-10-09T00:00:00Z", sourceTeamCount: 1,
    characterIds: ["CT_7567_REX", "CT_5555_FIVES", "CAPTAIN_REX"], unresolvedTeams: [], missingSavedDefence: false };
  const setup = harness();
  setup.run(`
    board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(CONFIG)}, "opponent", "round-1", "2026-10-09T00:00:00Z");
    board.defenceSnapshot = ${JSON.stringify(frozen)};
    myBoard = createCompanionMyBoard(board);
    myBoard.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Rex";
    saveBoard("opponent");
    saveBoard("my");
    saveDefenceTemplateFromMyBoard();
  `);

  // A later launch: saved state from storage, then the v7 catalogue (as from cache).
  const h = harness(Object.fromEntries(setup.values));
  h.run("loadBoard()");
  const migrated = h.json("board.defenceSnapshot");
  assert.equal(migrated.schema, 2);
  assert.deepEqual(migrated.characterIds, frozen.characterIds, "migration retains every frozen blocker");
  assert.deepEqual(migrated.legacyCharacterIds, frozen.characterIds, "old membership remains unattributed");
  assert.equal(migrated.capturedAt, frozen.capturedAt);
  withCatalogue(h);
  assert.deepEqual(h.json("board.defenceSnapshot"), migrated, "snapshot not re-derived from the renamed catalogue");
  assert.equal(h.run(`myBoard.teams.find(t => t.territory === "FRONT_BOTTOM").name`), "Rex");
  assert.equal(JSON.parse(h.values.get("defenceTemplate:3v3")).teams.find((t) => t.territory === "FRONT_BOTTOM").name, "Rex");
  const row = h.run(`renderBoardTeamRow(myBoard.territories.find(t => t.territory === "FRONT_BOTTOM"),
    myBoard.teams.find(t => t.territory === "FRONT_BOTTOM"), myBoard, "my")`);
  assert.ok(row.includes("Rex (saved; not in current catalogue)"));

  h.run(`setBoardTeam("my", "FRONT_BOTTOM", 0, "CT-7567 Rex")`);
  assert.equal(JSON.parse(h.values.get("defenceTemplate:3v3")).teams.find((t) => t.territory === "FRONT_BOTTOM").name, "CT-7567 Rex",
    "manual reselection updates the format's template");
  assert.deepEqual(h.json("board.defenceSnapshot"), migrated, "the round's snapshot stays frozen after reselection");
});
