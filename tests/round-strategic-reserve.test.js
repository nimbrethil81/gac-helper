const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Strategic reserve (v3.6): a counter definition marked `strategicReserve: true`
// is a premium/flexible attacking resource worth preserving while part of the
// opponent's board is still hidden (see docs/SPEC.md §6.8). These tests cover
// the acceptance scenarios from the task: a comparable non-reserve counter
// outranks a High-reserve one while zones are hidden (A), a reserve counter is
// never demoted below a materially weaker alternative (B), the effect switches
// off once the whole board is revealed (C), the normal Counters screen is
// unaffected (D), and an ordinary counter with no reserve metadata is unaffected
// even while zones remain hidden (E).

function harness() {
    const values = new Map();
    const appElement = { innerHTML: "" };
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
            getElementById: id => id === "app" ? appElement : null,
            querySelectorAll: () => [],
            querySelector: () => null
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return { run: expression => vm.runInContext(expression, context) };
}

function basicConfig() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}

// Wires up a 3v3 board with a single named FRONT_BOTTOM defence ("Darth Malgus")
// carrying the given counter catalogue, mirroring round-composition.test.js's
// setup. BACK_BOTTOM/BACK_TOP stay locked (FRONT_BOTTOM is not cleared), which is
// itself a hidden zone — the ordinary starting state of any fresh round.
function setUpHiddenZoneBoard(h, counters, counterDefinitions, ownedCharacters) {
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Darth Malgus";
        gacData = { "3v3": { "Darth Malgus": ${JSON.stringify(counters)} } };
        counterDefinitions = ${JSON.stringify(counterDefinitions)};
        characterDefinitions = {};
        ownedCharacters = ${JSON.stringify(ownedCharacters)};
        usedTeams = [];
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
}

const BANE = { counterId: "BANE", counter: "Darth Bane", tier: "S", bannerScore: 65, undersize: 0 };
const RELIABLE = { counterId: "RELIABLE", counter: "Reliable Squad", tier: "A", bannerScore: 55, undersize: 0 };
const WEAK = { counterId: "WEAK", counter: "Speculative Squad", tier: "C", bannerScore: 30, undersize: 0 };

const DEFS = {
    BANE: { name: "Darth Bane", required: ["DARTH_BANE"], recommended: [], strategicReserve: true },
    RELIABLE: { name: "Reliable Squad", required: ["RELIABLE_LEADER"], recommended: [] },
    WEAK: { name: "Speculative Squad", required: ["WEAK_LEADER"], recommended: [] }
};

const OWNED = ["DARTH_BANE", "RELIABLE_LEADER", "WEAK_LEADER"];

// ── Scenario A: hidden zone, comparable alternative exists ─────────────────

test("Scenario A: an adequate non-reserve counter outranks a High-reserve counter while zones are hidden, and Bane stays visible/selectable with a hold warning", () => {
    const h = harness();
    setUpHiddenZoneBoard(h, [BANE, RELIABLE], DEFS, OWNED);

    assert.equal(h.run(`roundHasHiddenZones(board)`), true);

    const chosenId = h.run(`roundPlan.assign["FRONT_BOTTOM:0"].counterId`);
    assert.equal(chosenId, "RELIABLE", "the reliable A-tier counter should be preferred over reserve-flagged Bane");

    const info = h.run(`roundPlan.reasons["FRONT_BOTTOM:0"]`);
    assert.equal(info.reserveWarning, false, "the chosen non-reserve counter carries no reserve warning");
    assert.equal(info.reserveAlternatives.length, 1);
    assert.equal(info.reserveAlternatives[0].counterId, "BANE");

    const html = h.run(`
        renderTeamRecommendation("opponent", "FRONT_BOTTOM",
            board.teams.find(t => t.territory === "FRONT_BOTTOM"), "3v3")
    `);
    assert.match(html, /Reliable Squad/);
    assert.match(html, /Darth Bane/, "Bane must remain visible on the card");
    assert.match(html, /Consider holding/, "Bane's row must carry the hold warning");
    assert.match(html, /markCounterUsedFromBoard\('BANE'\)/, "Bane must remain selectable via Mark used");
});

// ── Scenario B: hidden zone, only weak alternatives ─────────────────────────

test("Scenario B: the reserve rule never demotes Bane below a materially weaker alternative", () => {
    const h = harness();
    setUpHiddenZoneBoard(h, [BANE, WEAK], DEFS, OWNED);

    assert.equal(h.run(`roundHasHiddenZones(board)`), true);

    const chosenId = h.run(`roundPlan.assign["FRONT_BOTTOM:0"].counterId`);
    assert.equal(chosenId, "BANE", "Bane should remain the top recommendation over a clearly weaker option");

    const info = h.run(`roundPlan.reasons["FRONT_BOTTOM:0"]`);
    assert.equal(info.reserveWarning, true, "Bane, now the chosen counter, still carries the hold warning");

    const html = h.run(`
        renderTeamRecommendation("opponent", "FRONT_BOTTOM",
            board.teams.find(t => t.territory === "FRONT_BOTTOM"), "3v3")
    `);
    assert.match(html, /Darth Bane/);
    assert.match(html, /Consider holding/);
});

// ── Scenario C: whole board revealed ────────────────────────────────────────

test("Scenario C: once every territory is revealed, ranking and display fall back to normal — no reserve penalty, no warning", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_TOP").name = "Dummy Front Top";
        board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Dummy Front Bottom";
        board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = true;
        board.teams.find(t => t.territory === "BACK_BOTTOM").name = "Darth Malgus";
        gacData = { "3v3": { "Darth Malgus": ${JSON.stringify([BANE, RELIABLE])} } };
        counterDefinitions = ${JSON.stringify(DEFS)};
        characterDefinitions = {};
        ownedCharacters = ${JSON.stringify(OWNED)};
        usedTeams = [];
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);

    assert.equal(h.run(`roundHasHiddenZones(board)`), false, "every territory should now be unlocked");
    assert.equal(h.run(`roundPlan.reserveActive`), false);

    const chosenId = h.run(`roundPlan.assign["BACK_BOTTOM:0"].counterId`);
    assert.equal(chosenId, "BANE", "with no hidden zones, normal tier-first ranking picks the S-tier counter");

    const info = h.run(`roundPlan.reasons["BACK_BOTTOM:0"]`);
    assert.equal(info.reserveWarning, false);
    assert.equal(info.reserveAlternatives.length, 0);

    const html = h.run(`
        renderTeamRecommendation("opponent", "BACK_BOTTOM",
            board.teams.find(t => t.territory === "BACK_BOTTOM"), "3v3")
    `);
    assert.doesNotMatch(html, /Consider holding/);
});

// ── Scenario D: normal Counters screen is unaffected ────────────────────────

test("Scenario D: strategic-reserve metadata never changes Counters-screen sort order or shows a warning", () => {
    const h = harness();
    h.run(`
        counterDefinitions = ${JSON.stringify(DEFS)};
        ownedCharacters = ${JSON.stringify(OWNED)};
        usedTeams = [];
        board = null;
    `);

    const order = h.run(`sortCounters([${JSON.stringify(RELIABLE)}, ${JSON.stringify(BANE)}]).map(c => c.counterId).join(",")`);
    assert.equal(order, "BANE,RELIABLE", "Counters screen keeps its existing tier-first order regardless of reserve metadata");
});

// ── Scenario E: ordinary counter, hidden zones remain ───────────────────────

test("Scenario E: a counter with no reserve metadata gets no warning and no ranking penalty while zones are hidden", () => {
    const h = harness();
    const PLAIN_A = { counterId: "PLAIN_A", counter: "Plain Squad", tier: "S", bannerScore: 60, undersize: 0 };
    const plainDefs = { PLAIN_A: { name: "Plain Squad", required: ["PLAIN_LEADER"], recommended: [] } };
    setUpHiddenZoneBoard(h, [PLAIN_A], plainDefs, ["PLAIN_LEADER"]);

    assert.equal(h.run(`isHighReserve("PLAIN_A")`), false);
    assert.equal(h.run(`effectiveTierRank(${JSON.stringify(PLAIN_A)}, true)`), h.run(`tierSortValue("S")`));

    const chosenId = h.run(`roundPlan.assign["FRONT_BOTTOM:0"].counterId`);
    assert.equal(chosenId, "PLAIN_A");

    const info = h.run(`roundPlan.reasons["FRONT_BOTTOM:0"]`);
    assert.equal(info.reserveWarning, false);
    assert.equal(info.reserveAlternatives.length, 0);

    const html = h.run(`
        renderTeamRecommendation("opponent", "FRONT_BOTTOM",
            board.teams.find(t => t.territory === "FRONT_BOTTOM"), "3v3")
    `);
    assert.doesNotMatch(html, /Consider holding/);
});

// ── Absence reads as Normal (backwards compatibility) ───────────────────────

test("a counter definition with no strategicReserve field is treated as Normal reserve value", () => {
    const h = harness();
    h.run(`counterDefinitions = { BANE: { name: "Darth Bane", required: [], recommended: [] } };`);
    assert.equal(h.run(`isHighReserve("BANE")`), false);
});
