const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Scoring regression anchors (issue #76). `catalogue/source/scoring.json` owns
// the constants and `app.js` owns the arithmetic; these tests pin the expected
// results of the two together, so a change to either is a visible decision.
//
// Evidence: per-battle values, the squad ceilings (5v5 65/69, 3v3 57/59) and the
// territory-clear bonuses match the swgoh.wiki Grand Arena Championships banner
// tables; 69 as the 5v5 solo maximum was also confirmed by an EA community
// manager. The Fleet figures below are the THEORETICAL values implied by the
// authored OWN_UNITS / ENEMY_UNITS = 7 rows and the wiki's 7-member Fleet table.
// How those 7 map onto capital ship, starting ships and reinforcement slots, and
// which empty slots earn UNUSED_SLOT, is unvalidated — see ROADMAP.md
// "Real-battle scoring validation". They are pinned as theoretical ceilings only.

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const scoring = JSON.parse(fs.readFileSync(path.join(root, "catalogue/source/scoring.json"), "utf8"));
const boardConfig = JSON.parse(fs.readFileSync(path.join(root, "catalogue/source/board-config.json"), "utf8"));

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
    const run = e => vm.runInContext(e, context);
    run(`scoringRules = ${JSON.stringify(scoring.rules)}`);
    return run;
}

const FORMATS = [
    // [label, battleType, mode, units]
    ["5v5", "SQUAD", "5v5", 5],
    ["3v3", "SQUAD", "3v3", 3],
    ["Fleet", "FLEET", "ANY", 7]
];

test("every per-battle and territory rule the scorer reads is authored exactly once per scope", () => {
    const needed = ["VICTORY", "FIRST_ATTEMPT", "SECOND_ATTEMPT", "SURVIVING_UNIT", "FULL_HEALTH_UNIT",
        "FULL_PROTECTION_UNIT", "UNUSED_SLOT", "DEFEATED_ENEMY", "FIRST_ATTACK", "TERRITORY_CLEAR_BASE"];
    for (const id of needed) {
        const rows = scoring.rules.filter(r => r.ruleId === id);
        assert.equal(rows.length, 1, `${id} must have exactly one row`);
        assert.ok(Number.isFinite(rows[0].value) && rows[0].value > 0, `${id} must be positive`);
    }
    const perTeam = scoring.rules.filter(r => r.ruleId === "TERRITORY_CLEAR_PER_TEAM");
    assert.deepEqual(perTeam.map(r => [r.battleType, r.mode, r.value]).sort(),
        [["FLEET", "ANY", 33], ["SQUAD", "3v3", 28], ["SQUAD", "5v5", 30]]);
});

test("per-unit counts: squads use format fallbacks, fleet uses the authored 7", () => {
    const run = harness();
    for (const [label, bt, mode, units] of FORMATS) {
        assert.equal(run(`ownUnitCount("${bt}", "${mode}")`), units, `${label} own`);
        assert.equal(run(`enemyUnitCount("${bt}", "${mode}")`), units, `${label} enemy`);
    }
});

test("clean full-squad battle ceilings by attempt: first / second / third+", () => {
    const run = harness();
    const expected = { "5v5": [65, 45, 35, 35], "3v3": [57, 37, 27, 27], "Fleet": [73, 53, 43, 43] };
    for (const [label, bt, mode] of FORMATS) {
        const got = [0, 1, 2, 5].map(n => run(`battleBestCase("${bt}", "${mode}", ${n})`));
        assert.deepEqual(got, expected[label], label);
    }
});

test("attempt bonuses are 30 / 10 / 0 relative to a third+ win", () => {
    const run = harness();
    for (const [label, bt, mode] of FORMATS) {
        const [a1, a2, a3] = [0, 1, 2].map(n => run(`battleBestCase("${bt}", "${mode}", ${n})`));
        assert.equal(a1 - a3, 30, `${label} first`);
        assert.equal(a2 - a3, 10, `${label} second`);
    }
});

test("deliberately unused slots are net +1 per unit in a flawless win (3v3 solo is 59, not 61)", () => {
    const run = harness();
    const perUnit = run(`scoreRule("SURVIVING_UNIT","SQUAD","3v3") + scoreRule("FULL_HEALTH_UNIT","SQUAD","3v3") + scoreRule("FULL_PROTECTION_UNIT","SQUAD","3v3")`);
    const unused = run(`scoreRule("UNUSED_SLOT","SQUAD","3v3")`);
    assert.equal(unused - perUnit, 1);
    const ladder = (bt, mode, units, attempts) => {
        const full = run(`battleBestCase("${bt}", "${mode}", ${attempts})`);
        return Array.from({ length: units }, (_, dropped) => full + dropped * (unused - perUnit));
    };
    assert.deepEqual(ladder("SQUAD", "5v5", 5, 0), [65, 66, 67, 68, 69]);
    assert.deepEqual(ladder("SQUAD", "3v3", 3, 0), [57, 58, 59]);
    assert.deepEqual(ladder("SQUAD", "3v3", 3, 1), [37, 38, 39]);
    assert.deepEqual(ladder("SQUAD", "3v3", 3, 2), [27, 28, 29]);
    // Theoretical only: assumes all 6 non-fielded scoring slots are eligible unused slots.
    assert.deepEqual(ladder("FLEET", "ANY", 7, 0), [73, 74, 75, 76, 77, 78, 79]);
});

test("territory clear bonus is base + per-team for every team in the territory, once", () => {
    const run = harness();
    run(`board = createRoundBoard("KYBER", "3v3", [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 2 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ], "opponent", "r", "now")`);
    // Clear everything except the last team in FRONT_TOP.
    run(`board.teams.forEach(t => { t.cleared = !(t.territory === "FRONT_TOP" && t.index === 1); })`);
    assert.equal(run(`remainingBannersForBoard(board)`), 57 + 120 + 2 * 28);
    // Last team is fleet, with one earlier loss on it.
    run(`board.teams.forEach(t => { t.cleared = !(t.territory === "BACK_TOP" && t.index === 0); })`);
    run(`board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0).attempts = 1`);
    assert.equal(run(`remainingBannersForBoard(board)`), 53 + 120 + 2 * 33);
    // 5v5 squad per-team rate differs.
    run(`board.mode = "5v5"; board.teams.forEach(t => { t.cleared = !(t.territory === "FRONT_BOTTOM"); })`);
    assert.equal(run(`remainingBannersForBoard(board)`), 65 + 120 + 30);
    run(`board.teams.forEach(t => { t.cleared = true; })`);
    assert.equal(run(`remainingBannersForBoard(board)`), 0);
});

test("first-attack bonus is added once, only when requested", () => {
    const run = harness();
    run(`board = createRoundBoard("KYBER", "5v5", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 }], "opponent", "r", "now")`);
    const without = run(`remainingBannersForBoard(board)`);
    assert.equal(run(`remainingBannersForBoard(board, { firstAttackAvailable: true })`) - without, 10);
    assert.equal(run(`isFirstAttackAvailable()`), true);
    run(`board.teams[0].attempts = 1`);
    assert.equal(run(`isFirstAttackAvailable()`), false);
});

test("whole-board opening ceilings from the authored Kyber board configuration", () => {
    const run = harness();
    const expected = { "3v3": 2073, "5v5": 1843 };
    for (const mode of ["3v3", "5v5"]) {
        const cfg = boardConfig.territories.filter(r => r.league === "KYBER" && r.mode === mode);
        run(`board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(cfg)}, "opponent", "r", "now")`);
        assert.equal(run(`remainingBannersForBoard(board)`), expected[mode], mode);
        assert.equal(run(`remainingBannersForBoard(board, { firstAttackAvailable: true })`), expected[mode] + 10, `${mode} + first attack`);
    }
});
