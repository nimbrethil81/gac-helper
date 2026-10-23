const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

// Regression pins for the provisional 5v5 rows from issues #108 (Rotta the
// Hutt / SEE), #110 (SLKR with Dark Side Vision Rey / JML) and #111 (Finn
// (Zorii Resistance) / Talzin and Traya), and #125/#126 (Hondo / JMK and Leia).
// They check the compiled catalogue and
// that Round Mode allocates the exact counter identities, honouring roster and
// used-team availability.

const payload = compileSource(readSource(path.join(__dirname, "..", "catalogue", "source")).source);
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const strip = rows => rows.map(({ counterId, tier, bannerScore, undersize }) => ({ counterId, tier, bannerScore, undersize }));

function harness() {
    const values = new Map();
    const context = {
        __GAC_HELPER_TEST__: true,
        console, setTimeout, clearTimeout,
        confirm: () => true, alert: () => {}, navigator: {},
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: { getElementById: () => ({ innerHTML: "" }), querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(appSource, context, { filename: "app.js" });
    return { run: expression => vm.runInContext(expression, context) };
}

function planFor(defence, ownedCharacters, usedTeams, otherDefence = "") {
    const h = harness();
    const config = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
    h.run(`
        gacData = ${JSON.stringify(payload.counters)};
        counterDefinitions = ${JSON.stringify(payload.counterDefinitions)};
        characterDefinitions = ${JSON.stringify(payload.characterDefinitions)};
        defenceTeams = ${JSON.stringify(payload.defenceTeams)};
        defenceCompositions = ${JSON.stringify(payload.defenceCompositions)};
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = ${JSON.stringify(defence)};
        board.teams.find(t => t.territory === "FRONT_TOP").name = ${JSON.stringify(otherDefence)};
        ownedCharacters = ${JSON.stringify(ownedCharacters)};
        usedTeams = ${JSON.stringify(usedTeams)};
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return h.run(`(roundPlan.assign["FRONT_BOTTOM:0"] || {}).counterId || null`);
}

test("#108 Rotta the Hutt 5v5 offers only the provisional full-size SEE counter", () => {
    const rows = payload.counters["5v5"]["Rotta the Hutt"];
    assert.deepEqual(strip(rows), [{ counterId: "SEE", tier: "B", bannerScore: 60, undersize: 0 }]);
    assert.match(rows[0].notes, /^Provisional:/);
    assert.match(rows[0].notes, /focused datacron/);
    assert.match(rows[0].notes, /not an established win rate/);
    assert.equal(payload.counters["3v3"]["Rotta the Hutt"], undefined);
    assert.deepEqual(payload.counterDefinitions.SEE.required, ["SITH_ETERNAL_EMPEROR"]);
    assert.deepEqual(payload.defenceCompositions["5v5"]["Rotta the Hutt"],
        ["ROTTA_THE_HUTT", "CAD_BANE", "GREEDO", "MOB_ENFORCER", "GAMORREAN_GUARD"]);
    assert.equal(payload.defenceTeams["5v5"]["Rotta the Hutt"].threat, "HIGH");
    const ext = id => payload.characterDefinitions[id].externalId;
    assert.deepEqual(["ROTTA_THE_HUTT", "GREEDO", "MOB_ENFORCER", "CAD_BANE", "GAMORREAN_GUARD"].map(ext),
        ["RACCOON", "GREEDO", "HUMANTHUG", "CADBANE", "GAMORREANGUARD"]);
});

test("#125/#126 Hondo retains its existing answers and adds only provisional full-size Leia and JMK", () => {
    const rows = payload.counters["5v5"]["Pirate King Hondo Ohnaka"];
    assert.deepEqual(strip(rows), [
        { counterId: "CERE", tier: "S", bannerScore: 63, undersize: 0 },
        { counterId: "BAYLAN", tier: "S", bannerScore: 63, undersize: 0 },
        { counterId: "SLKR", tier: "A", bannerScore: 63, undersize: 0 },
        { counterId: "LEIA", tier: "A", bannerScore: 62, undersize: 0 },
        { counterId: "JMK", tier: "B", bannerScore: 58, undersize: 0 }
    ]);
    assert.deepEqual(rows.slice(0, 3).map(row => row.notes), ["Preferred", "Strong", "Strong"]);
    assert.match(rows[3].notes, /Leia Organa \(GL, leader\), R2-D2, Captain Drogan, Mon Mothma, C-3PO/);
    assert.match(rows[3].notes, /One owner-observed full victory/);
    assert.match(rows[3].notes, /no established win rate or datacron independence/);
    assert.match(rows[4].notes, /Jedi Master Kenobi \(leader\), Ahsoka Tano \(Snips, not GL\), Commander Ahsoka Tano \(CAT\), General Kenobi, Wat Tambor/);
    assert.match(rows[4].notes, /possible attack loss after defeating three defenders/);
    assert.match(rows[4].notes, /Three defender defeats are not guaranteed/);
    assert.match(rows[4].notes, /A loss is not a victory or a 58-banner result/);
    for (const row of rows.slice(3)) assert.match(row.notes, /owner-approved planning estimate.*not measured banners or an average/);
    assert.equal(payload.counters["3v3"]["Pirate King Hondo Ohnaka"].some(row => ["JMK", "LEIA"].includes(row.counterId)), false);
    assert.deepEqual(payload.counterDefinitions.JMK, { name: "Jedi Master Kenobi", required: ["JEDI_MASTER_KENOBI"], recommended: [] });
    assert.deepEqual(payload.counterDefinitions.LEIA, { name: "Leia Organa (GL)", required: ["LEIA_ORGANA", "CAPTAIN_DROGAN", "R2_D2"], recommended: [] });
});

test("#125/#126 Hondo ordering, core roster filtering and used-team state follow existing policy", () => {
    const defence = "Pirate King Hondo Ohnaka";
    const core = ["JEDI_MASTER_KENOBI", "LEIA_ORGANA", "CAPTAIN_DROGAN", "R2_D2"];
    assert.equal(planFor(defence, [...core, "CERE_JUNDA", "TARON_MALICOS"], []), "CERE");
    assert.equal(planFor(defence, [...core, "SUPREME_LEADER_KYLO_REN"], []), "SLKR");
    assert.equal(planFor(defence, core, []), "LEIA");
    assert.equal(planFor(defence, core, ["LEIA"]), "JMK");
    assert.equal(planFor(defence, ["LEIA_ORGANA", "R2_D2"], []), null);
    assert.equal(planFor(defence, core, ["LEIA", "JMK"]), null);
    // Leia is the sole owned answer to GL Ahsoka; ordinary whole-board
    // conservation spends the conditional JMK option on Hondo to cover both.
    assert.equal(planFor(defence, core, [], "Ahsoka Tano (GL)"), "JMK");
});

test("#108 Round Mode assigns SEE to Rotta, never substitutes SEE and Bane, and honours roster and used state", () => {
    const seeAndBane = ["SITH_ETERNAL_EMPEROR", "DARTH_BANE"];
    assert.equal(planFor("Rotta the Hutt", seeAndBane, []), "SEE");
    assert.equal(planFor("Rotta the Hutt", seeAndBane, ["SEE"]), null);
    assert.equal(planFor("Rotta the Hutt", ["DARTH_BANE"], []), null);
});

test("#110 SLKR with Dark Side Vision Rey is its own 5v5 identity; generic SLKR and 3v3 are unchanged", () => {
    const variant = payload.counters["5v5"]["SLKR (Dark Side Vision Rey)"];
    assert.deepEqual(strip(variant), [{ counterId: "JML", tier: "B", bannerScore: 55, undersize: 0 }]);
    assert.match(variant[0].notes, /can lose outright/);
    assert.deepEqual(strip(payload.counters["5v5"].SLKR), [
        { counterId: "JML", tier: "S", bannerScore: 63, undersize: 0 },
        { counterId: "BANE", tier: "S", bannerScore: 65, undersize: 3 }
    ]);
    assert.deepEqual(strip(payload.counters["3v3"].SLKR), [{ counterId: "JML", tier: "S", bannerScore: 55, undersize: 0 }]);
    assert.equal(payload.counters["3v3"]["SLKR (Dark Side Vision Rey)"], undefined);
    assert.deepEqual(payload.defenceCompositions["5v5"]["SLKR (Dark Side Vision Rey)"], ["SUPREME_LEADER_KYLO_REN", "REY_DARK_SIDE_VISION"]);
    assert.deepEqual(payload.characterDefinitions.REY_DARK_SIDE_VISION, { name: "Rey (Dark Side Vision)", unitType: "CHARACTER", externalId: "DARKREY" });
    assert.equal(payload.characterDefinitions.REY.externalId, "GLREY");
    assert.equal(planFor("SLKR (Dark Side Vision Rey)", ["JEDI_MASTER_LUKE"], []), "JML");
});

test("#111 5v5 Finn (Zorii Resistance): Talzin B / 59 with loss warning, Traya kept A / 62; 3v3 unchanged", () => {
    const rows = payload.counters["5v5"]["Finn (Zorii Resistance)"];
    assert.deepEqual(strip(rows), [
        { counterId: "MOTHER_TALZIN", tier: "B", bannerScore: 59, undersize: 0 },
        { counterId: "TRAYA", tier: "A", bannerScore: 62, undersize: 0 },
        { counterId: "STARKILLER", tier: "S", bannerScore: 62, undersize: 0 },
        { counterId: "BAYLAN", tier: "S", bannerScore: 61, undersize: 0 }
    ]);
    assert.match(rows[0].notes, /Can fail outright/);
    assert.match(rows[1].notes, /second attempt/);
    assert.deepEqual(strip(payload.counters["3v3"]["Finn (Zorii Resistance)"])[0], { counterId: "MOTHER_TALZIN", tier: "A", bannerScore: 53, undersize: 0 });
    // With only Talzin and Traya owned, the engine now prefers Traya.
    assert.equal(planFor("Finn (Zorii Resistance)", ["MOTHER_TALZIN", "DARTH_TRAYA", "DARTH_NIHILUS"], []), "TRAYA");
});
