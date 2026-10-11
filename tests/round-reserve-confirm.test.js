const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Confirm before spending a strategic-reserve counter (issue #67). Marking a
// High-reserve counter used on the Opponent Board while any enemy zone is still
// hidden asks first. Cancel changes nothing; OK runs the existing flow once. The
// confirmation never appears for revealed boards, normal counters, the Counters
// screen, My Board, an already-used counter, undo, or rendering.

function harness() {
    const values = new Map();
    const appElement = { innerHTML: "" };
    const confirms = [];
    const state = { answer: true };
    const context = {
        __GAC_HELPER_TEST__: true,
        console,
        setTimeout,
        clearTimeout,
        confirm: message => { confirms.push(message); return state.answer; },
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
    return {
        run: expression => vm.runInContext(expression, context),
        confirms,
        answer: value => { state.answer = value; },
        stored: key => values.get(key)
    };
}

function config() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}

const BANE = { counterId: "BANE", counter: "Bane", tier: "S", bannerScore: 65, undersize: 0 };
const SEE_BANE = { counterId: "SEE_BANE", counter: "SEE and Bane", tier: "S", bannerScore: 66, undersize: 0 };
const RELIABLE = { counterId: "RELIABLE", counter: "Reliable Squad", tier: "A", bannerScore: 55, undersize: 0 };
const DEFS = {
    BANE: { name: "Bane", required: ["DARTH_BANE"], recommended: [], strategicReserve: true },
    SEE_BANE: { name: "SEE and Bane", required: ["SITH_ETERNAL_EMPEROR", "DARTH_BANE"], recommended: [], strategicReserve: true },
    RELIABLE: { name: "Reliable Squad", required: ["RELIABLE_LEADER"], recommended: [] }
};
const OWNED = ["DARTH_BANE", "SITH_ETERNAL_EMPEROR", "RELIABLE_LEADER"];

// FRONT_BOTTOM carries the defence under test; the other front territory is left
// uncleared, so BACK_* stay locked behind the reveal chain (hidden zones).
function setUpBoard(h, { mode = "3v3", counters = [BANE, RELIABLE], revealed = false } = {}) {
    const territory = revealed ? "BACK_BOTTOM" : "FRONT_BOTTOM";
    h.run(`
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(config())}, "opponent", "round", "now");
        ${revealed ? `
        board.teams.find(t => t.territory === "FRONT_TOP").name = "Dummy Front Top";
        board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Dummy Front Bottom";
        board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = true;` : ""}
        board.teams.find(t => t.territory === "${territory}").name = "Darth Malgus";
        gacData = { "${mode}": { "Darth Malgus": ${JSON.stringify(counters)} } };
        counterDefinitions = ${JSON.stringify(DEFS)};
        characterDefinitions = {};
        ownedCharacters = ${JSON.stringify(OWNED)};
        usedTeams = [];
        localStorage.removeItem("usedTeams");
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return territory;
}

const teamCleared = (h, territory) => h.run(`board.teams.find(t => t.territory === "${territory}").cleared`);

test("hidden zones: cancelling the confirmation leaves every piece of state untouched", () => {
    const h = harness();
    setUpBoard(h);
    h.answer(false);
    const before = h.run(`JSON.stringify({ used: usedTeams, board, focusedTeamKey, pendingUndo: pendingUndo && pendingUndo.kind })`);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /Use Bane now\?/);
    assert.match(h.confirms[0], /Some enemy squads are still hidden/);
    assert.equal(h.run(`JSON.stringify({ used: usedTeams, board, focusedTeamKey, pendingUndo: pendingUndo && pendingUndo.kind })`), before);
    assert.equal(h.stored("usedTeams"), undefined, "nothing is persisted");
});

test("hidden zones: confirming marks the counter used exactly once", () => {
    const h = harness();
    setUpBoard(h);
    h.answer(true);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
    assert.equal(h.stored("usedTeams"), `["BANE"]`);
});

test("SEE_BANE is confirmed under its own display name", () => {
    const h = harness();
    setUpBoard(h, { counters: [SEE_BANE, RELIABLE] });
    h.answer(false);

    h.run(`markCounterUsedFromBoard("SEE_BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /Use SEE and Bane now\?/);
    assert.equal(h.run(`usedTeams.length`), 0);

    h.answer(true);
    h.run(`markCounterUsedFromBoard("SEE_BANE")`);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["SEE_BANE"]`);
});

test("Used + Cleared on a reserve counter: cancel changes nothing, confirm applies both once", () => {
    const h = harness();
    const territory = setUpBoard(h, { counters: [BANE] });
    h.answer(false);

    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
    assert.equal(teamCleared(h, territory), false);
    assert.equal(h.run(`pendingUndo`), null, "no Undo offer is created for a cancelled action");

    h.answer(true);
    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 2);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
    assert.equal(teamCleared(h, territory), true);
    assert.equal(h.run(`pendingUndo.kind`), "usedCleared");
});

test("a displayed reserve alternative goes through the same confirmation", () => {
    const h = harness();
    const territory = setUpBoard(h);
    assert.equal(h.run(`roundPlan.assign["${territory}:0"].counterId`), "RELIABLE");
    const html = h.run(`renderTeamRecommendation("opponent", "${territory}", board.teams.find(t => t.territory === "${territory}"), "3v3")`);
    assert.match(html, /markCounterUsedFromBoard\('BANE'\)/);
    h.answer(false);

    h.run(`markCounterUsedFromBoard("BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
});

test("5v5 boards are confirmed too", () => {
    const h = harness();
    setUpBoard(h, { mode: "5v5" });
    h.answer(false);
    h.run(`markCounterUsedFromBoard("BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
});

test("no confirmation once every enemy zone is revealed (checked at click time)", () => {
    const h = harness();
    setUpBoard(h, { revealed: true });
    assert.equal(h.run(`roundHasHiddenZones(board)`), false);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
});

test("no confirmation for a normal counter, even with hidden zones", () => {
    const h = harness();
    setUpBoard(h);
    assert.equal(h.run(`roundHasHiddenZones(board)`), true);

    h.run(`markCounterUsedFromBoard("RELIABLE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["RELIABLE"]`);
});

test("no confirmation when the reserve counter is already used", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`usedTeams = ["BANE"]`);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`, "no duplicate entry");
});

test("the Counters screen's own Mark used is unchanged and never confirms", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`showCounters = () => {};`);

    h.run(`markUsed("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
});

test("My Board actions never confirm", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`
        myBoard = createRoundBoard("KYBER", "3v3", ${JSON.stringify(config())}, "my", "round", "now");
        myBoard.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Darth Malgus";
    `);
    h.answer(false);

    h.run(`markUsedAndCleared("my", "FRONT_BOTTOM", 0, "BANE")`);

    assert.equal(h.confirms.length, 0);
});

test("undo, render and recomputing the plan never prompt", () => {
    const h = harness();
    const territory = setUpBoard(h, { counters: [BANE] });
    h.answer(true);
    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 1);

    h.run(`undoPendingAction()`);
    h.run(`roundPlan = computeRoundPlan()`);
    h.run(`renderTeamRecommendation("opponent", "${territory}", board.teams.find(t => t.territory === "${territory}"), "3v3")`);

    assert.equal(h.confirms.length, 1, "only the original action prompted");
    assert.equal(h.run(`usedTeams.length`), 0, "undo restored the unused state");
});
