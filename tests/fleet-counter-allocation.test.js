const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const source = readSource(path.join(root, "catalogue", "source")).source;
const payload = compileSource(source);

function harness() {
  const values = new Map();
  const context = {
    __GAC_HELPER_TEST__: true,
    console,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    alert: () => {},
    navigator: {},
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    },
    document: {
      getElementById: id => id === "app" ? { innerHTML: "" } : null,
      querySelectorAll: () => [],
      querySelector: () => null
    }
  };
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: "app.js" });
  return { run: expression => vm.runInContext(expression, context) };
}

const config = [
  { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
  { territory: "BACK_TOP", type: "FLEET", teamCount: 3 }
];

const attackingCapitalShips = ["EXECUTOR", "PROFUNDITY", "CHIMAERA", "LEVIATHAN"];
const defendingCapitalShips = ["HOME_ONE", "RADDUS", "NEGOTIATOR"];

function setUpThreeFleetBoard(h) {
  h.run(`
    board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(config)}, "opponent", "round", "now");
    board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
    ["Executor", "Profundity", "Negotiator"].forEach((name, index) => {
      board.teams.find(t => t.territory === "BACK_TOP" && t.index === index).name = name;
    });
    board.defenceSnapshot = {
      schema: 1,
      mode: "5v5",
      capturedAt: "2026-10-13T09:22:29Z",
      sourceTeamCount: 3,
      characterIds: ${JSON.stringify(defendingCapitalShips)},
      unresolvedTeams: []
    };
    gacData = ${JSON.stringify(payload.counters)};
    counterDefinitions = ${JSON.stringify(payload.counterDefinitions)};
    characterDefinitions = ${JSON.stringify(payload.characterDefinitions)};
    defenceTeams = ${JSON.stringify(payload.defenceTeams)};
    defenceCompositions = ${JSON.stringify(payload.defenceCompositions)};
    ownedCharacters = ${JSON.stringify([...attackingCapitalShips, ...defendingCapitalShips])};
    usedTeams = [];
    expandedCounterCards = new Set();
  `);
}

function assignments(h) {
  return JSON.parse(h.run(`JSON.stringify(computeRoundPlan().assign)`));
}

test("approved fleet rows and detail notes compile exactly without changing global fleet definitions or threats", () => {
  const profundity = payload.counters.FLEET.Profundity.filter(counter => counter.counterId === "PROFUNDITY");
  const chimaera = payload.counters.FLEET.Negotiator.filter(counter => counter.counterId === "CHIMAERA");

  assert.equal(profundity.length, 1);
  assert.deepEqual(
    { tier: profundity[0].tier, bannerScore: profundity[0].bannerScore, undersize: profundity[0].undersize },
    { tier: "A", bannerScore: 67, undersize: 0 }
  );
  assert.equal(chimaera.length, 1);
  assert.deepEqual(
    { tier: chimaera[0].tier, bannerScore: chimaera[0].bannerScore, undersize: chimaera[0].undersize },
    { tier: "A", bannerScore: 67, undersize: 0 }
  );

  assert.deepEqual(payload.counterDefinitions.PROFUNDITY.required, ["PROFUNDITY"]);
  assert.deepEqual(payload.counterDefinitions.CHIMAERA.required, ["CHIMAERA"]);
  assert.equal(payload.defenceTeams.ANY.Leviathan.threat, "EXTREME");
  assert.equal(payload.defenceTeams.ANY.Profundity.threat, "HIGH");
  assert.equal(payload.defenceTeams.ANY.Executor.threat, "HIGH");

  const h = harness();
  h.run(`currentMode = "FLEET"`);
  const profundityCard = h.run(`buildCounterCardHtml(${JSON.stringify(profundity[0])})`);
  const chimaeraCard = h.run(`buildCounterCardHtml(${JSON.stringify(chimaera[0])})`);
  assert.match(profundityCard, /Han's Millennium Falcon/);
  assert.match(profundityCard, /Imperial TIE Bomber is the preferred first reinforcement/);
  assert.match(chimaeraCard, /Anakin's Eta-2, Marauder and BTL-B Y-wing/);
  assert.match(chimaeraCard, /TIE Defender is the key reinforcement/);
});

test("three-fleet round re-plans after a lost Executor mirror and a Leviathan clear", () => {
  const h = harness();
  setUpThreeFleetBoard(h);

  const initial = assignments(h);
  assert.equal(Object.keys(initial).length, 3, "all three enemy fleets have capital-ship-level coverage");
  assert.equal(new Set(Object.values(initial).map(counter => counter.counterId)).size, 3, "capital ships are never assigned twice");
  assert.ok(Object.values(initial).every(counter => attackingCapitalShips.includes(counter.counterId)));
  for (const counterId of defendingCapitalShips) {
    assert.equal(h.run(`getCounterStatus(${JSON.stringify(counterId)})`), "on-defence");
  }

  h.run(`
    usedTeams = ["EXECUTOR"];
    board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0).attempts = 1;
  `);
  const afterLoss = assignments(h);
  assert.equal(Object.keys(afterLoss).length, 3, "the uncleared Executor is re-covered after the failed mirror");
  assert.ok(Object.values(afterLoss).every(counter => counter.counterId !== "EXECUTOR"));
  assert.equal(new Set(Object.values(afterLoss).map(counter => counter.counterId)).size, 3);

  h.run(`
    usedTeams = ["EXECUTOR", "LEVIATHAN"];
    board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0).cleared = true;
  `);
  const afterClear = assignments(h);
  assert.deepEqual(
    Object.fromEntries(Object.entries(afterClear).map(([key, counter]) => [key, counter.counterId])),
    { "BACK_TOP:1": "PROFUNDITY", "BACK_TOP:2": "CHIMAERA" }
  );

  const profundityNote = payload.counters.FLEET.Profundity.find(counter => counter.counterId === "PROFUNDITY").notes;
  const chimaeraNote = payload.counters.FLEET.Negotiator.find(counter => counter.counterId === "CHIMAERA").notes;
  assert.match(profundityNote, /Imperial TIE Bomber/);
  assert.match(chimaeraNote, /Imperial TIE Bomber/);
  assert.ok(!payload.counterDefinitions.PROFUNDITY.required.includes("IMPERIAL_TIE_BOMBER"));
  assert.ok(!payload.counterDefinitions.CHIMAERA.required.includes("IMPERIAL_TIE_BOMBER"));
});
