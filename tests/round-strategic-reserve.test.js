const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

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
    assert.match(html, /markCounterUsedFromBoard\('BANE', 'FRONT_BOTTOM:0'\)/, "Bane must remain selectable via Mark used");
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

// ── Real catalogue: BANE and SEE_BANE are flagged (CR-2026-10-11-01-C04) ────
// Reads the committed catalogue/source, so these check the shipped data rather
// than the synthetic definitions above. Only the two Bane definitions are
// asserted; other flags are deliberately not pinned here.

const realPayload = compileSource(readSource(path.join(__dirname, "..", "catalogue", "source")).source);
const realDefs = realPayload.counterDefinitions;

function setUpRealBoard(h, defence, owned, { revealed = false } = {}) {
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        ${revealed
            ? `board.teams.find(t => t.territory === "FRONT_TOP").name = "Dummy Front Top";
               board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
               board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Dummy Front Bottom";
               board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = true;
               board.teams.find(t => t.territory === "BACK_BOTTOM").name = ${JSON.stringify(defence)};`
            : `board.teams.find(t => t.territory === "FRONT_BOTTOM").name = ${JSON.stringify(defence)};`}
        gacData = ${JSON.stringify(realPayload.counters)};
        counterDefinitions = ${JSON.stringify(realDefs)};
        characterDefinitions = {};
        ownedCharacters = ${JSON.stringify(owned)};
        usedTeams = [];
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return revealed ? "BACK_BOTTOM:0" : "FRONT_BOTTOM:0";
}

test("real catalogue: BANE and SEE_BANE are High reserve and share DARTH_BANE", () => {
    const h = harness();
    h.run(`counterDefinitions = ${JSON.stringify(realDefs)};`);
    assert.equal(realDefs.BANE.strategicReserve, true);
    assert.equal(realDefs.SEE_BANE.strategicReserve, true);
    assert.equal(h.run(`isHighReserve("BANE")`), true);
    assert.equal(h.run(`isHighReserve("SEE_BANE")`), true);
    assert.ok(realDefs.BANE.required.includes("DARTH_BANE"));
    assert.ok(realDefs.SEE_BANE.required.includes("DARTH_BANE"), "the two counters cannot be consumed independently");
    assert.equal(h.run(`isHighReserve("SEE")`), false, "SEE alone is not flagged");
});

test("real catalogue: hidden zones nudge an adequate non-reserve option above BANE, which stays selectable with a hold warning", () => {
    const h = harness();
    const key = setUpRealBoard(h, "Darth Malgus", [...realDefs.BANE.required, ...realDefs.BAYLAN.required]);
    assert.equal(h.run(`roundHasHiddenZones(board)`), true);
    assert.equal(h.run(`roundPlan.assign["${key}"].counterId`), "BAYLAN", "S-tier BANE counts one tier weaker, tying A-tier BAYLAN and losing the reserve tie-break");
    const info = h.run(`roundPlan.reasons["${key}"]`);
    assert.equal(info.reserveWarning, false);
    assert.ok(info.reserveAlternatives.some(c => c.counterId === "BANE"));
    const html = h.run(`renderTeamRecommendation("opponent", "FRONT_BOTTOM", board.teams.find(t => t.territory === "FRONT_BOTTOM"), "3v3")`);
    assert.match(html, /Consider holding/);
    assert.match(html, /markCounterUsedFromBoard\('BANE', 'FRONT_BOTTOM:0'\)/);
});

test("real catalogue: SEE_BANE is still chosen over a materially weaker option, with the hold warning", () => {
    const h = harness();
    const owned = [...new Set([...realDefs.SEE_BANE.required, ...realDefs.SEE.required])];
    const key = setUpRealBoard(h, "The Stranger", owned);
    assert.equal(h.run(`roundHasHiddenZones(board)`), true);
    assert.equal(h.run(`roundPlan.assign["${key}"].counterId`), "SEE_BANE", "S-tier SEE_BANE counts as A and still beats B-tier SEE");
    assert.equal(h.run(`roundPlan.reasons["${key}"].reserveWarning`), true);
});

test("real catalogue: with the whole board revealed BANE is ranked normally with no warning", () => {
    const h = harness();
    const key = setUpRealBoard(h, "Darth Malgus", [...realDefs.BANE.required, ...realDefs.BAYLAN.required], { revealed: true });
    assert.equal(h.run(`roundHasHiddenZones(board)`), false);
    assert.equal(h.run(`roundPlan.assign["${key}"].counterId`), "BANE");
    assert.equal(h.run(`roundPlan.reasons["${key}"].reserveWarning`), false);
    const html = h.run(`renderTeamRecommendation("opponent", "BACK_BOTTOM", board.teams.find(t => t.territory === "BACK_BOTTOM"), "3v3")`);
    assert.doesNotMatch(html, /Consider holding/);
});

test("real catalogue: the Counters-screen order is unchanged by the reserve flag", () => {
    const h = harness();
    h.run(`counterDefinitions = ${JSON.stringify(realDefs)}; ownedCharacters = []; usedTeams = []; board = null;`);
    const rows = realPayload.counters["3v3"]["Darth Malgus"];
    const order = h.run(`sortCounters(${JSON.stringify(rows)}).map(c => c.counterId).join(",")`);
    const flagless = JSON.parse(JSON.stringify(realDefs));
    delete flagless.BANE.strategicReserve; delete flagless.SEE_BANE.strategicReserve;
    h.run(`counterDefinitions = ${JSON.stringify(flagless)};`);
    assert.equal(h.run(`sortCounters(${JSON.stringify(rows)}).map(c => c.counterId).join(",")`), order);
});

test("real revealed 5v5 board: spending unflagged SEE on Malgus warns about The Stranger", () => {
    const h = harness();
    const owned = [...new Set([...realDefs.SEE.required, ...realDefs.JKCK.required])];
    h.run(`
        board = createRoundBoard("KYBER", "5v5", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 }], "opponent", "r", "now");
        board.teams[0].name = "Darth Malgus";
        board.teams[1].name = "The Stranger";
        gacData = ${JSON.stringify(realPayload.counters)};
        counterDefinitions = ${JSON.stringify(realDefs)};
        characterDefinitions = ${JSON.stringify(realPayload.characterDefinitions)};
        ownedCharacters = ${JSON.stringify(owned)};
        usedTeams = [];
        roundPlan = computeRoundPlan();
        globalThis.promptText = null;
        confirm = message => { promptText = message; return false; };
        markCounterUsedFromBoard("SEE", "FRONT_TOP:0");
    `);
    assert.equal(h.run(`roundPlan.visibleBoardConservation.changed`), false,
        "coverage alone already protects SEE; a click still evaluates the actual expenditure");
    assert.match(h.run(`promptText`), /The Stranger/);
    assert.match(h.run(`promptText`), /Sith Eternal Emperor/);
    assert.match(h.run(`promptText`), /No one-shot counter remains assigned there/);
    assert.equal(h.run(`usedTeams.length`), 0);
});
