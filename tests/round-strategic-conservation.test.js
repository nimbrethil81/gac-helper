const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const realPayload = compileSource(readSource(path.join(__dirname, "..", "catalogue", "source")).source);

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
    vm.runInContext(source, context, { filename: "app.js" });
    return { run: expression => vm.runInContext(expression, context) };
}

const DEFINITIONS = {
    SEE: { name: "Sith Eternal Emperor", required: ["SITH_ETERNAL_EMPEROR"], recommended: [] },
    BANE: { name: "Bane", required: ["DARTH_BANE"], recommended: [], strategicReserve: true },
    SEE_BANE: {
        name: "SEE and Bane",
        required: ["SITH_ETERNAL_EMPEROR", "DARTH_BANE"],
        recommended: [],
        strategicReserve: true
    },
    ALT: { name: "Adequate Alternative", required: ["ALT_LEADER"], recommended: [] },
    WEAK: { name: "Weak Alternative", required: ["WEAK_LEADER"], recommended: [] },
    SHARED: { name: "Shared Counter", required: ["SHARED_LEADER"], recommended: [] },
    UNOWNED: { name: "Unowned Counter", required: ["MISSING_LEADER"], recommended: [] }
};

const ENTRY = (counterId, tier, bannerScore) => ({
    counterId,
    counter: DEFINITIONS[counterId].name,
    tier,
    bannerScore,
    undersize: 0
});

function setUpVisibleBoard(h, mode = "3v3") {
    const config = [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 }];
    h.run(`
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams[0].name = "Easy Defence";
        board.teams[1].name = "The Stranger Fixture";
        gacData = { "${mode}": {
            "Easy Defence": ${JSON.stringify([
                ENTRY("SEE", "S", 65), ENTRY("ALT", "A", 50), ENTRY("UNOWNED", "S", 70)
            ])},
            "The Stranger Fixture": ${JSON.stringify([
                ENTRY("SEE_BANE", "A", 50), ENTRY("BANE", "B", 65)
            ])}
        } };
        counterDefinitions = ${JSON.stringify(DEFINITIONS)};
        characterDefinitions = {};
        ownedCharacters = ["SITH_ETERNAL_EMPEROR", "DARTH_BANE", "ALT_LEADER", "WEAK_LEADER", "SHARED_LEADER"];
        usedTeams = [];
        spentCharsCache = { key: null, map: new Map() };
        roundPlan = computeRoundPlan();
    `);
}

for (const mode of ["5v5", "3v3"]) {
    test(`${mode}: visible-board conservation prefers A+A over banner-favoured S+B`, () => {
        const h = harness();
        setUpVisibleBoard(h, mode);

        assert.equal(h.run(`roundHasHiddenZones(board)`), false);
        assert.equal(h.run(`roundPlan.assign["FRONT_TOP:0"].counterId`), "ALT");
        assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"].counterId`), "SEE_BANE");
        assert.equal(h.run(`roundPlan.visibleBoardConservation.state`), "changed");
        assert.equal(h.run(`roundPlan.visibleBoardConservation.changed`), true);
        assert.equal(h.run(`roundPlan.visibleBoardConservation.motivation`), "visible-board-scarcity");

        const baseline = JSON.parse(h.run(`JSON.stringify(roundPlan.visibleBoardConservation.tradeoffs)`));
        const easy = baseline.find(item => item.defenceId === "FRONT_TOP:0");
        assert.equal(easy.baseline.counterId, "SEE");
        assert.equal(easy.selected.counterId, "ALT");
        assert.deepEqual(easy.preservedFor.map(item => item.defenceId), ["FRONT_TOP:1"]);
        assert.deepEqual(easy.preservedFor[0].sharedRequiredCharacters, ["SITH_ETERNAL_EMPEROR"]);
    });
}

test("scarcity assessment records fieldability and closes indirect required-character conflicts", () => {
    const h = harness();
    setUpVisibleBoard(h);

    const assessment = JSON.parse(h.run(`JSON.stringify(roundPlan.visibleBoardScarcity)`));
    const easy = assessment.teams.find(team => team.defenceId === "FRONT_TOP:0");
    const unowned = easy.candidates.find(candidate => candidate.counterId === "UNOWNED");
    assert.equal(unowned.owned, false);
    assert.equal(unowned.fieldable, false);
    assert.equal(unowned.status, "not-owned");

    const group = assessment.resourceGroups.find(candidate =>
        candidate.counterIds.join(",") === "BANE,SEE,SEE_BANE");
    assert.ok(group, "SEE, Bane and SEE+Bane should form one scarce resource group");
    assert.equal(group.indirect, true, "SEE and Bane conflict indirectly through SEE+Bane");
    assert.deepEqual(group.requiredCharacters, ["DARTH_BANE", "SITH_ETERNAL_EMPEROR"]);
    assert.equal(h.run(`JSON.stringify(assessVisibleBoardScarcity(buildEligibleTeams()))`),
        h.run(`JSON.stringify(assessVisibleBoardScarcity(buildEligibleTeams()))`),
        "the assessment is deterministic");
});

test("real 5v5 catalogue preserves SEE for The Stranger when JKCK covers Darth Malgus", () => {
    const h = harness();
    const owned = [...new Set([
        ...realPayload.counterDefinitions.SEE.required,
        ...realPayload.counterDefinitions.JKCK.required
    ])];
    h.run(`
        board = createRoundBoard("KYBER", "5v5", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 }], "opponent", "round", "now");
        board.teams[0].name = "Darth Malgus";
        board.teams[1].name = "The Stranger";
        gacData = ${JSON.stringify(realPayload.counters)};
        counterDefinitions = ${JSON.stringify(realPayload.counterDefinitions)};
        characterDefinitions = ${JSON.stringify(realPayload.characterDefinitions)};
        ownedCharacters = ${JSON.stringify(owned)};
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);

    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:0"].counterId`), "JKCK");
    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"].counterId`), "SEE");
    assert.equal(h.run(`roundPlan.visibleBoardConservation.state`), "unchanged",
        "coverage already forces this allocation, so diagnostics must not invent a conservation change");
    assert.equal(h.run(`roundPlan.visibleBoardScarcity.teams[1].candidates.some(c => c.counterId === "REVA")`), false,
        "the weakening-only Reva setup is not winning coverage");
});

test("one defence with only a clearly inferior alternative keeps its strongest counter", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 }], "opponent", "round", "now");
        board.teams[0].name = "Solo Defence";
        gacData = { "3v3": { "Solo Defence": ${JSON.stringify([
            ENTRY("SEE", "S", 50), ENTRY("WEAK", "C", 70)
        ])} } };
        counterDefinitions = ${JSON.stringify(DEFINITIONS)};
        characterDefinitions = {};
        ownedCharacters = ["SITH_ETERNAL_EMPEROR", "WEAK_LEADER"];
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);

    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:0"].counterId`), "SEE");
    assert.equal(h.run(`roundPlan.visibleBoardConservation.state`), "unchanged");
    assert.equal(h.run(`roundPlan.visibleBoardScarcity.resourceGroups.length`), 0);
});

test("an impossible board returns a deterministic partial plan with honest warnings", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 3 }], "opponent", "round", "now");
        board.teams[0].name = "Alpha Defence";
        board.teams[1].name = "Bravo Defence";
        board.teams[2].name = "No Data Defence";
        gacData = { "3v3": {
            "Alpha Defence": [${JSON.stringify(ENTRY("SHARED", "S", 50))}],
            "Bravo Defence": [${JSON.stringify(ENTRY("SHARED", "S", 50))}]
        } };
        counterDefinitions = ${JSON.stringify(DEFINITIONS)};
        characterDefinitions = {};
        ownedCharacters = ["SHARED_LEADER"];
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);

    const first = h.run(`JSON.stringify(roundPlan.assign)`);
    h.run(`roundPlan = computeRoundPlan()`);
    assert.equal(h.run(`JSON.stringify(roundPlan.assign)`), first, "ties must not flicker between renders");
    assert.equal(h.run(`Object.keys(roundPlan.assign).length`), 1);
    const warnings = JSON.parse(h.run(`JSON.stringify(roundPlan.visibleBoardConservation.warnings)`));
    assert.ok(warnings.some(warning => warning.status === "compromised"));
    assert.ok(warnings.some(warning => warning.status === "no-credible-coverage"));
});

test("used resources and roster changes are reflected on the next derived plan", () => {
    const h = harness();
    setUpVisibleBoard(h);
    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"].counterId`), "SEE_BANE");

    h.run(`
        usedTeams = ["SEE"];
        spentCharsCache = { key: null, map: new Map() };
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:0"].counterId`), "ALT");
    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"].counterId`), "BANE");
    assert.equal(h.run(`roundPlan.visibleBoardScarcity.teams[0].candidates.find(c => c.counterId === "SEE").status`), "used");
    assert.equal(h.run(`roundPlan.visibleBoardScarcity.teams[1].candidates.find(c => c.counterId === "SEE_BANE").status`), "spent");

    h.run(`
        usedTeams = [];
        ownedCharacters = ownedCharacters.filter(id => id !== "DARTH_BANE");
        spentCharsCache = { key: null, map: new Map() };
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"] == null`), true);
    assert.equal(h.run(`roundPlan.visibleBoardConservation.warnings.some(w => w.defenceId === "FRONT_TOP:1" && w.status === "no-credible-coverage")`), true);
});

test("hidden-zone reserve and visible-board conservation are distinct diagnostics", () => {
    const h = harness();
    const config = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 }
    ];
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams[0].name = "Solo Defence";
        gacData = { "3v3": { "Solo Defence": [${JSON.stringify(ENTRY("BANE", "S", 50))}] } };
        counterDefinitions = ${JSON.stringify(DEFINITIONS)};
        characterDefinitions = {};
        ownedCharacters = ["DARTH_BANE"];
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.hiddenZoneReserve.active`), true);
    assert.equal(h.run(`roundPlan.reserveActive`), true, "legacy field remains available");
    assert.equal(h.run(`roundPlan.visibleBoardConservation.state`), "unchanged");
});

test("revealing the last hidden lane removes only the hidden-reserve reason", () => {
    const h = harness();
    const config = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 2 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 }
    ];
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_TOP").name = "No Data Defence";
        board.teams.find(t => t.territory === "FRONT_BOTTOM" && t.index === 0).name = "Easy Defence";
        board.teams.find(t => t.territory === "FRONT_BOTTOM" && t.index === 1).name = "The Stranger Fixture";
        gacData = { "3v3": {
            "Easy Defence": ${JSON.stringify([ENTRY("SEE", "S", 65), ENTRY("ALT", "A", 50)])},
            "The Stranger Fixture": ${JSON.stringify([ENTRY("SEE_BANE", "A", 50), ENTRY("BANE", "B", 65)])}
        } };
        counterDefinitions = ${JSON.stringify(DEFINITIONS)};
        characterDefinitions = {};
        ownedCharacters = ["SITH_ETERNAL_EMPEROR", "DARTH_BANE", "ALT_LEADER"];
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.hiddenZoneReserve.active`), true);
    assert.equal(h.run(`roundPlan.reasons["FRONT_BOTTOM:1"].reserveWarning`), true);
    assert.ok(h.run(`roundPlan.visibleBoardScarcity.resourceGroups.length`) > 0);

    h.run(`
        board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.hiddenZoneReserve.active`), false);
    assert.equal(h.run(`roundPlan.reasons["FRONT_BOTTOM:1"].reserveWarning`), false);
    assert.ok(h.run(`roundPlan.visibleBoardScarcity.resourceGroups.length`) > 0,
        "visible scarcity remains after the hidden-only reason disappears");
    assert.equal(h.run(`roundPlan.visibleBoardConservation.state`), "changed");
});

test("bounded search degrades to a complete deterministic greedy plan when its budget is exhausted", () => {
    const h = harness();
    h.run(`
        counterDefinitions = Object.fromEntries(Array.from({ length: 18 }, (_, i) => ["C" + i, {
            name: "Counter " + i, required: ["UNIT_" + i], recommended: []
        }]));
    `);
    const result = JSON.parse(h.run(`JSON.stringify(solveAllocation(
        Array.from({ length: 18 }, (_, i) => ({
            key: "FRONT_TOP:" + i,
            modeKey: "5v5",
            candidates: [{ counterId: "C" + i, counter: "Counter " + i, tier: i % 4 === 0 ? "A" : "S", bannerScore: 60, undersize: 0 }]
        })), false, 0))`));
    assert.equal(result.search.exhausted, true);
    assert.equal(result.search.nodes, 0);
    assert.equal(Object.keys(result.assign).length, 18, "budget exhaustion retains the greedy fallback");
    assert.deepEqual(result.assign, result.baselineAssign);
});

test("a realistic-size bounded solve never exceeds the 50,000-node budget", () => {
    const h = harness();
    h.run(`
        counterDefinitions = Object.fromEntries(Array.from({ length: 24 }, (_, i) => ["C" + i, {
            name: "Counter " + i, required: ["UNIT_" + i], recommended: []
        }]));
    `);
    const result = JSON.parse(h.run(`JSON.stringify(solveAllocation(
        Array.from({ length: 18 }, (_, teamIndex) => ({
            key: "T:" + teamIndex,
            modeKey: teamIndex < 15 ? "5v5" : "FLEET",
            candidates: Array.from({ length: 5 }, (_, offset) => {
                const id = "C" + ((teamIndex + offset) % 24);
                return { counterId: id, counter: id, tier: ["S", "A", "B", "C"][offset % 4], bannerScore: 60 - offset, undersize: 0 };
            })
        })), false))`));
    assert.ok(result.search.nodes <= 50000);
    assert.ok(Object.keys(result.assign).length > 0);
    assert.equal(result.search.budget, 50000);
});
