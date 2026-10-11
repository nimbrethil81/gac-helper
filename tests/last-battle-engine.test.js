const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Last Battle engine (issue #77): pure, mode-aware banner-target maths for the
// final uncleared Opponent Board defence. Driven by the authored scoring rules.

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const RULES = JSON.parse(fs.readFileSync(path.join(root, "catalogue/source/scoring.json"), "utf8")).rules;

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
    run(`scoringRules = ${JSON.stringify(RULES)}`);
    return run;
}

// Front Top 2 squads, Front Bottom 1 squad, Back Top 3 fleets, Back Bottom 1 squad.
const CFG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
    { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 3 },
    { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
];

// Build a board with only (territory, index) left uncleared.
function lastOn(run, mode, territory, index, attempts) {
    run(`board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(CFG)}, "opponent", "r", "now");
         board.teams.forEach(t => { t.cleared = !(t.territory === "${territory}" && t.index === ${index}); });
         board.teams.find(t => t.territory === "${territory}" && t.index === ${index}).attempts = ${attempts || 0};`);
}

function advise(run, extra) {
    return JSON.parse(run(`JSON.stringify(lastBattleAdvice(Object.assign({ board, myScore: 0, oppScore: 0, oppFinal: false, firstAttackAvailable: false }, ${JSON.stringify(extra || {})})))`));
}

// Scores so that targetToBeatCurrent = need.
const need = n => ({ myScore: 1000, oppScore: 999 + n });

test("engages only when exactly one defence on the whole board is uncleared", () => {
    const run = harness();
    run(`board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(CFG)}, "opponent", "r", "now")`);
    let r = advise(run);
    assert.equal(r.status, "notLastBattle");
    assert.equal(r.unclearedCount, 7);
    run(`board.teams.forEach(t => { t.cleared = true; })`);
    r = advise(run);
    assert.equal(r.status, "notLastBattle");
    assert.equal(r.reasons[0].code, "BOARD_CLEARED");
    // Unnamed last defence still counts; a locked back territory is irrelevant.
    lastOn(run, "5v5", "BACK_BOTTOM", 0);
    r = advise(run);
    assert.equal(r.status, "ready");
    assert.equal(r.target.territory, "BACK_BOTTOM");
    assert.equal(r.target.name, "");
    assert.equal(advise(run, { board: null }).status, "noBoard");
});

test("per-format clean ceilings: 5v5 65/69, 3v3 57/59, Fleet 73 indicative only", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);
    let r = advise(run);
    assert.deepEqual([r.ceilings.fullSquad.low, r.ceilings.max.low, r.confidence], [65, 69, "exact"]);
    assert.deepEqual(r.formations.map(f => f.maxLow), [65, 66, 67, 68, 69]);
    assert.equal(r.target.formatLabel, "5v5");

    lastOn(run, "3v3", "FRONT_BOTTOM", 0);
    r = advise(run);
    assert.deepEqual([r.ceilings.fullSquad.low, r.ceilings.max.low], [57, 59]);
    assert.deepEqual(r.formations.map(f => [f.fielded, f.emptySlots, f.mathematicalOnly]), [[3, 0, false], [2, 1, true], [1, 2, true]]);

    lastOn(run, "3v3", "BACK_TOP", 1);
    r = advise(run);
    assert.equal(r.target.battleType, "FLEET");
    assert.equal(r.target.formatLabel, "Fleet");
    assert.equal(r.confidence, "indicative");
    assert.ok(r.reasons.some(x => x.code === "FLEET_UNVALIDATED"));
    assert.equal(r.ceilings.fullSquad.low, 73);
    assert.equal(r.ceilings.max.low, 73, "no unused-slot upside while fleet slots are unvalidated");
    assert.equal(r.formations.length, 1);
});

test("attempts: 2nd and 3rd+ ceilings; cleanup without enemy state is bounded, with it exact", () => {
    const run = harness();
    for (const [attempts, full] of [[1, 45], [2, 35], [4, 35]]) {
        lastOn(run, "5v5", "FRONT_BOTTOM", 0, attempts);
        const bounded = advise(run);
        assert.equal(bounded.target.attemptNumber, attempts + 1);
        assert.equal(bounded.confidence, "bounded");
        assert.deepEqual(bounded.needsInput, ["enemiesRemaining"]);
        assert.deepEqual([bounded.ceilings.fullSquad.low, bounded.ceilings.fullSquad.high], [full - 4, full]);
        const exact = advise(run, { enemiesRemaining: 5 });
        assert.equal(exact.confidence, "exact");
        assert.equal(exact.ceilings.fullSquad.low, full);
        assert.equal(advise(run, { enemiesRemaining: 2 }).ceilings.fullSquad.low, full - 3);
        // Out-of-range input is ignored rather than trusted.
        assert.equal(advise(run, { enemiesRemaining: 9 }).confidence, "bounded");
    }
    lastOn(run, "3v3", "FRONT_BOTTOM", 0, 1);
    assert.equal(advise(run, { enemiesRemaining: 3 }).ceilings.fullSquad.low, 37);
});

test("territory clear: base + per team in that territory, mode-specific, never double counted", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);          // single-team squad territory
    assert.equal(advise(run).bonusesOnClear.territoryClear, 120 + 30);
    lastOn(run, "5v5", "FRONT_TOP", 1);             // two-team squad territory
    assert.equal(advise(run).bonusesOnClear.territoryClear, 120 + 2 * 30);
    lastOn(run, "3v3", "FRONT_TOP", 0);
    assert.equal(advise(run).bonusesOnClear.territoryClear, 120 + 2 * 28);
    lastOn(run, "3v3", "BACK_TOP", 2);              // three-team fleet territory
    assert.equal(advise(run).bonusesOnClear.territoryClear, 120 + 3 * 33);

    lastOn(run, "5v5", "FRONT_TOP", 1);
    const r = advise(run, need(250));
    assert.equal(r.targetToBeatCurrent, 250);
    assert.equal(r.bonusesOnClear.total, 180);
    assert.equal(r.battleTarget, 70);
    assert.equal(r.verdict, "impossible", "70 battle banners exceeds the 69 maximum");
});

test("first-attack bonus counts once when genuinely available", () => {
    const run = harness();
    run(`board = createRoundBoard("KYBER", "3v3", [{ territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 }], "opponent", "r", "now")`);
    assert.equal(run(`isFirstAttackAvailable()`), true);
    const r = advise(run, Object.assign(need(200), { firstAttackAvailable: true }));
    assert.deepEqual(r.bonusesOnClear, { territoryClear: 148, firstAttack: 10, total: 158 });
    assert.equal(r.battleTarget, 42);
    assert.equal(advise(run, need(200)).battleTarget, 52);
});

test("target arithmetic: any win, needs battle, flawless threshold, tie, impossible", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);          // clear bonus 150

    let r = advise(run, need(150 + 51));            // minimum win = 15+30+1+5
    assert.equal(r.ceilings.minWin.low, 51);
    assert.equal(r.verdict, "anyWin");

    r = advise(run, need(150 + 60));
    assert.equal(r.verdict, "needsBattle");
    const full = r.formations[0];
    assert.deepEqual([full.allowanceLow, full.unitsCanLose, full.flawlessRequired, full.meets], [5, 1, false, "yes"]);

    r = advise(run, need(150 + 63));                // 2 points of slack: cannot lose a unit
    assert.equal(r.formations[0].unitsCanLose, 0);
    assert.equal(r.formations[0].allowanceLow, 2);

    r = advise(run, need(150 + 65));                // full squad must be flawless
    assert.equal(r.formations[0].flawlessRequired, true);
    assert.equal(r.formations[1].allowanceLow, 1);  // one empty slot gives a point of slack

    // Exact tie is not a win: finishing on their score needs one more banner.
    r = advise(run, { myScore: 1000, oppScore: 1000 + 150 + 68 });
    assert.equal(r.battleTarget, 69);
    assert.equal(r.verdict, "needsBattle");
    assert.equal(r.formations[4].flawlessRequired, true, "only a flawless solo reaches 69");
    assert.deepEqual(r.formations.slice(0, 4).map(f => f.meets), ["no", "no", "no", "no"]);

    r = advise(run, need(150 + 70));
    assert.equal(r.verdict, "impossible");

    // A loss here would leave a second attempt peaking at 49.
    assert.equal(advise(run, need(150 + 60)).ceilings.nextAttemptMax, 49);
    lastOn(run, "3v3", "FRONT_BOTTOM", 0, 1);
    assert.equal(advise(run, { enemiesRemaining: 3 }).ceilings.nextAttemptMax, 29);
});

test("already met, covered by the clear bonus, and current vs final opponent score", () => {
    const run = harness();
    lastOn(run, "3v3", "FRONT_BOTTOM", 0);
    let r = advise(run, { myScore: 1200, oppScore: 1100 });
    assert.deepEqual([r.verdict, r.aheadOf, r.targetToBeatCurrent, r.battleTarget], ["alreadyAhead", "current", 0, 0]);
    assert.ok(r.reasons.some(x => x.code === "OPP_NOT_FINAL"));
    r = advise(run, { myScore: 1200, oppScore: 1100, oppFinal: true });
    assert.equal(r.aheadOf, "final");
    assert.ok(!r.reasons.some(x => x.code === "OPP_NOT_FINAL"));

    r = advise(run, need(100));                     // clear bonus 148 covers it
    assert.deepEqual([r.verdict, r.battleTarget], ["coveredByClear", 0]);

    r = advise(run, { myScore: 1100, oppScore: 1100 });   // level now: tie is not ahead
    assert.equal(r.targetToBeatCurrent, 1);
    assert.equal(r.verdict, "coveredByClear");
});

test("invalid scores and missing rules cannot be calculated precisely", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);
    for (const s of [{ myScore: -1 }, { oppScore: Number.NaN }, { myScore: "5" }]) {
        const r = JSON.parse(run(`JSON.stringify(lastBattleAdvice(Object.assign({ board, myScore: 0, oppScore: 0 }, ${JSON.stringify(s).replace("null", "NaN")})))`));
        assert.equal(r.status, "cannotCalculate");
        assert.equal(r.reasons[0].code, "INVALID_SCORE");
    }
    assert.equal(advise(run, { myScore: 0, oppScore: 0 }).status, "ready", "zero scores are valid");

    const without = RULES.filter(r => r.ruleId !== "UNUSED_SLOT");
    const r = advise(run, { rules: without });
    assert.equal(r.status, "cannotCalculate");
    assert.match(r.reasons[0].message, /UNUSED_SLOT/);
    const noFirst = RULES.filter(r => r.ruleId !== "FIRST_ATTACK");
    assert.equal(advise(run, { rules: noFirst, firstAttackAvailable: true }).status, "cannotCalculate");
});

test("per-battle model enforces invariants and scores a mixed outcome", () => {
    const run = harness();
    const score = o => JSON.parse(run(`JSON.stringify(battleScore(battleScoringRules("SQUAD", "5v5"), ${JSON.stringify(o)}))`));
    const ok = score({ attempts: 0, fielded: 4, survivors: 3, fullHealth: 2, fullProtection: 1, unusedSlots: 1, enemiesDefeated: 5 });
    assert.equal(ok.ok, true);
    assert.equal(ok.total, 15 + 30 + 3 + 2 + 1 + 4 + 5);
    for (const bad of [
        { attempts: 0, fielded: 5, survivors: 3, fullHealth: 4, fullProtection: 0, unusedSlots: 0, enemiesDefeated: 5 },
        { attempts: 0, fielded: 5, survivors: 3, fullHealth: 0, fullProtection: 4, unusedSlots: 0, enemiesDefeated: 5 },
        { attempts: 0, fielded: 3, survivors: 4, fullHealth: 0, fullProtection: 0, unusedSlots: 0, enemiesDefeated: 5 },
        { attempts: 0, fielded: 4, survivors: 4, fullHealth: 0, fullProtection: 0, unusedSlots: 2, enemiesDefeated: 5 },
        { attempts: 0, fielded: 5, survivors: 0, fullHealth: 0, fullProtection: 0, unusedSlots: 0, enemiesDefeated: 5 },
        { attempts: 0, fielded: 6, survivors: 1, fullHealth: 0, fullProtection: 0, unusedSlots: 0, enemiesDefeated: 5 },
        { attempts: 0, fielded: 5, survivors: 1.5, fullHealth: 0, fullProtection: 0, unusedSlots: 0, enemiesDefeated: 5 }
    ]) assert.equal(score(bad).ok, false, JSON.stringify(bad));
});

test("counter options: estimates shifted by attempt, documented undersize only, fleet drop ignored", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);
    const counters = [
        { counterId: "A", tier: "S", bannerScore: 62, undersize: 2, available: true },
        { counterId: "B", tier: "A", bannerScore: 64, undersize: 0, available: false },
        { counterId: "C", tier: "B", bannerScore: "", undersize: 0 }
    ];
    let r = advise(run, Object.assign(need(150 + 63), { counters }));
    const [a, b, c] = r.counters;
    assert.deepEqual([a.expected, a.expectedMeets, a.documentedDrop, a.expectedWithDrop, a.expectedWithDropMeets], [62, false, 2, 64, true]);
    assert.deepEqual([b.expectedMeets, b.available], [true, false]);
    assert.deepEqual([c.expected, c.expectedMeets], [null, null]);

    lastOn(run, "5v5", "FRONT_BOTTOM", 0, 1);
    r = advise(run, Object.assign(need(150 + 40), { counters, enemiesRemaining: 5 }));
    assert.equal(r.counters[0].expected, 42, "second attempt: 20 fewer than the first-attempt estimate");

    lastOn(run, "5v5", "BACK_TOP", 0);
    r = advise(run, { counters: [{ counterId: "F", bannerScore: 70, undersize: 3 }] });
    assert.equal(r.counters[0].documentedDrop, 0);
});

test("live adapter recalculates from score, Battles and Undo without mutating state", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);
    run(`counterDefinitions = {}; gacData = {}; ownedCharacters = []; usedTeams = ["X"];
         bannerData.myScore = 1000; bannerData.oppScore = 1200; bannerData.oppFinal = false;`);
    const snapshot = () => run(`JSON.stringify([board, bannerData, usedTeams])`);
    const before = snapshot();
    const live = () => JSON.parse(run(`JSON.stringify(currentLastBattleAdvice())`));
    let r = live();
    assert.equal(r.battleTarget, 201 - 150);
    assert.equal(snapshot(), before, "advice never mutates board, scores or used teams");

    run(`bannerData.oppScore = 1210`);
    assert.equal(live().battleTarget, 61);

    run(`markUsedAndLost("opponent", "FRONT_BOTTOM", 0, "C1")`);
    r = live();
    assert.equal(r.target.attemptNumber, 2);
    assert.equal(r.verdict, "impossible", "61 needed but a second attempt peaks at 49");
    run(`undoPendingAction()`);
    r = live();
    assert.equal(r.target.attemptNumber, 1);
    assert.equal(r.verdict, "needsBattle");

    run(`board.teams.find(t => t.territory === "FRONT_TOP").cleared = false`);
    assert.equal(live().status, "notLastBattle");
});

test("existing remaining-banner and points-to-win maths are unchanged", () => {
    const run = harness();
    lastOn(run, "5v5", "FRONT_BOTTOM", 0);
    assert.equal(run(`remainingBannersForBoard(board)`), 65 + 150);
    assert.equal(run(`scoreRule("NOT_A_RULE", "SQUAD", "5v5")`), 0);
    assert.equal(run(`pointsToWinReadout(10, 20, 30).headline`), "Points to win: 11");
});
