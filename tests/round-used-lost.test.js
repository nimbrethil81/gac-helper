const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Used + Lost (issue #73): spends the counter, adds exactly one Battle to the
// targeted defence, leaves it uncleared, and offers an exact Undo.

function harness() {
    const values = new Map();
    const context = {
        __GAC_HELPER_TEST__: true, console, setTimeout, clearTimeout,
        confirm: () => true, alert: () => {}, navigator: {},
        localStorage: {
            getItem: k => values.has(k) ? values.get(k) : null,
            setItem: (k, v) => values.set(k, String(v)),
            removeItem: k => values.delete(k)
        },
        document: { getElementById: id => id === "app" ? { innerHTML: "" } : null, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return { run: e => vm.runInContext(e, context), stored: k => values.get(k) };
}

const CFG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
    { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
    { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
];
const RULES = [
    ["VICTORY", 10], ["FIRST_ATTEMPT", 8], ["SECOND_ATTEMPT", 4]
].map(([ruleId, value]) => ({ ruleId, battleType: "ANY", mode: "ANY", value }));

function setUp(h, mode) {
    h.run(`
        scoringRules = ${JSON.stringify(RULES)};
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(CFG)}, "opponent", "round", "now");
        counterDefinitions = {}; characterDefinitions = {}; gacData = {}; ownedCharacters = [];
        usedTeams = []; localStorage.removeItem("usedTeams");
    `);
}
const att = (h, t, i) => h.run(`board.teams.find(x => x.territory === "${t}" && x.index === ${i}).attempts || 0`);
const remaining = h => h.run(`remainingBannersForBoard(board)`);

for (const [mode, territory] of [["5v5", "FRONT_TOP"], ["3v3", "FRONT_TOP"], ["3v3", "BACK_TOP"]]) {
    test(`${mode} ${territory}: loss spends counter, +1 Battle, stays uncleared, persists, undoes exactly`, () => {
        const h = harness();
        setUp(h, mode);
        const before = h.run(`JSON.stringify(board.teams.map(t => [t.territory, t.index, t.attempts || 0, t.cleared]))`);
        h.run(`markUsedAndLost("opponent", "${territory}", 0, "C1")`);
        assert.equal(att(h, territory, 0), 1);
        assert.equal(h.run(`board.teams.find(x => x.territory === "${territory}" && x.index === 0).cleared`), false);
        assert.equal(h.run(`JSON.stringify(usedTeams)`), `["C1"]`);
        assert.equal(h.stored("usedTeams"), `["C1"]`);
        assert.equal(h.run(`board.teams.filter(t => (t.attempts || 0) > 0).length`), 1, "other defences unchanged");
        assert.match(h.stored("opponentBoard") || h.run(`JSON.stringify(board)`), /"attempts":1/);
        h.run(`undoPendingAction()`);
        assert.equal(h.run(`JSON.stringify(board.teams.map(t => [t.territory, t.index, t.attempts || 0, t.cleared]))`), before);
        assert.equal(h.run(`usedTeams.length`), 0);
    });
}

test("undo keeps a counter that was already used", () => {
    const h = harness();
    setUp(h, "3v3");
    h.run(`usedTeams = ["C1"]`);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    assert.equal(att(h, "FRONT_TOP", 0), 1);
    h.run(`undoPendingAction()`);
    assert.equal(att(h, "FRONT_TOP", 0), 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["C1"]`);
});

test("two losses on one defence reach 2; undo restores only the latest", () => {
    const h = harness();
    setUp(h, "3v3");
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C2")`);
    assert.equal(att(h, "FRONT_TOP", 0), 2);
    h.run(`undoPendingAction()`);
    assert.equal(att(h, "FRONT_TOP", 0), 1);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["C1"]`);
});

test("manual Battles edit after a loss dismisses nothing unsafe and Used + Cleared still works", () => {
    const h = harness();
    setUp(h, "3v3");
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    h.run(`setTeamAttempts("opponent", "FRONT_TOP", 0, 3)`);
    assert.equal(att(h, "FRONT_TOP", 0), 3);
    h.run(`markUsedAndCleared("opponent", "FRONT_TOP", 0, "C2")`);
    assert.equal(h.run(`board.teams.find(x => x.territory === "FRONT_TOP" && x.index === 0).cleared`), true);
    assert.equal(att(h, "FRONT_TOP", 0), 3, "clearing does not change Battles");
});

test("score ceiling drops with Battles 0→1→2→3 and loss undo restores it", () => {
    const h = harness();
    setUp(h, "3v3");
    const r0 = remaining(h);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    const r1 = remaining(h);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C2")`);
    const r2 = remaining(h);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C3")`);
    const r3 = remaining(h);
    assert.equal(r0 - r1, 8 - 4, "first→second attempt bonus");
    assert.equal(r1 - r2, 4, "second→third attempt bonus");
    assert.equal(r2 - r3, 0, "third+ has no bonus");
    h.run(`undoPendingAction()`);
    assert.equal(remaining(h), r2);
});

test("first attack is spent after a loss", () => {
    const h = harness();
    setUp(h, "5v5");
    assert.equal(h.run(`isFirstAttackAvailable()`), true);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    assert.equal(h.run(`isFirstAttackAvailable()`), false);
    h.run(`undoPendingAction()`);
    assert.equal(h.run(`isFirstAttackAvailable()`), true);
});

test("recommendation card renders all three actions with Used + Lost secondary", () => {
    assert.match(source, /board-rec-btn-primary" onclick="markUsedAndCleared[^]*board-rec-btn-secondary" onclick="markUsedAndLost[^]*board-rec-btn-tertiary" onclick="markCounterUsedFromBoard/);
});

test("Used + Lost on a hidden-zone reserve: cancel is a no-op, confirm increments once, Undo restores", () => {
    const h = harness();
    setUp(h, "5v5");
    h.run(`
        counterDefinitions = { BANE: { name: "Bane", required: ["BANE_UNIT"], strategicReserve: true } };
        ownedCharacters = ["BANE_UNIT"];
        confirm = () => false;
        focusedTeamKey = "FRONT_TOP:0";
    `);
    const before = h.run(`JSON.stringify({ board, usedTeams, focusedTeamKey, pendingUndo })`);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "BANE")`);
    assert.equal(h.run(`JSON.stringify({ board, usedTeams, focusedTeamKey, pendingUndo })`), before);
    assert.equal(h.stored("usedTeams"), undefined);
    h.run(`confirm = () => true; markUsedAndLost("opponent", "FRONT_TOP", 0, "BANE")`);
    assert.equal(att(h, "FRONT_TOP", 0), 1);
    assert.equal(h.run(`board.teams[0].cleared`), false);
    assert.equal(h.run(`usedTeams.filter(id => id === "BANE").length`), 1);
    h.run(`undoPendingAction()`);
    assert.equal(att(h, "FRONT_TOP", 0), 0);
    assert.equal(h.run(`usedTeams.length`), 0);
});
