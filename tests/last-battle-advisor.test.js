const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Last Battle Advisor UI (issue #78): Round Mode spotlight and the Banners
// needed disclosure, rendered from the #77 engine.

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const RULES = JSON.parse(fs.readFileSync(path.join(root, "catalogue/source/scoring.json"), "utf8")).rules;

function harness() {
    const values = new Map();
    const elements = new Map();
    const el = id => {
        if (!elements.has(id)) elements.set(id, { id, innerHTML: "", textContent: "", className: "" });
        return elements.get(id);
    };
    const context = {
        __GAC_HELPER_TEST__: true, console, setTimeout, clearTimeout,
        confirm: () => true, alert: () => {}, navigator: {},
        localStorage: {
            getItem: k => values.has(k) ? values.get(k) : null,
            setItem: (k, v) => values.set(k, String(v)),
            removeItem: k => values.delete(k)
        },
        document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    const run = e => vm.runInContext(e, context);
    run(`scoringRules = ${JSON.stringify(RULES)}`);
    return { run, el, keys: () => [...values.keys()].sort() };
}

const CFG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
    { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
    { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
];

// Catalogue: "Empire" (squad) with a drop-2 counter and a full-squad one; "Raddus" fleet.
const CATALOGUE = {
    gacData: {
        "5v5": { Empire: [
            { counterId: "REBELS", counter: "Rebels", tier: "S", bannerScore: 62, undersize: 2 },
            { counterId: "JEDI", counter: "Jedi", tier: "A", bannerScore: 64, undersize: 0 }
        ] },
        "3v3": { Empire: [
            { counterId: "REBELS", counter: "Rebels", tier: "S", bannerScore: 55, undersize: 0 }
        ] },
        FLEET: { Raddus: [
            { counterId: "EXEC", counter: "Executor", tier: "S", bannerScore: 70, undersize: 3 }
        ] }
    },
    counterDefinitions: { REBELS: { required: ["U1"] }, JEDI: { required: ["U2"] }, EXEC: { required: ["S1"] } }
};

function setUp(h, mode, territory, name, opts) {
    const o = Object.assign({ my: 1000, opp: 1100, final: false, attempts: 0 }, opts || {});
    h.run(`
        gacData = ${JSON.stringify(CATALOGUE.gacData)};
        counterDefinitions = ${JSON.stringify(CATALOGUE.counterDefinitions)};
        characterDefinitions = {}; ownedCharacters = ["U1", "U2", "S1"]; usedTeams = [];
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(CFG)}, "opponent", "r", "now");
        board.teams.forEach(t => { t.cleared = !(t.territory === "${territory}" && t.index === 0); });
        { const last = board.teams.find(t => t.territory === "${territory}" && t.index === 0);
          last.name = ${JSON.stringify(name)}; last.attempts = ${o.attempts}; }
        bannerData.myScore = ${o.my}; bannerData.oppScore = ${o.opp}; bannerData.oppFinal = ${o.final};
        activeBoardSide = "opponent"; currentView = "round";
    `);
}
const roundHtml = h => h.run(`renderRound()`);

test("spotlight appears only when exactly one Opponent Board defence is uncleared", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire");
    let html = roundHtml(h);
    assert.match(html, /LAST BATTLE/);
    assert.ok(html.indexOf("LAST BATTLE") < html.indexOf("NEXT UP"), "leads the board");
    assert.match(html, /Front Bottom · Empire/);

    h.run(`board.teams.find(t => t.territory === "FRONT_TOP").cleared = false`);
    assert.doesNotMatch(roundHtml(h), /LAST BATTLE/, "two remain");
    h.run(`board.teams.forEach(t => { t.cleared = true; })`);
    assert.doesNotMatch(roundHtml(h), /LAST BATTLE/, "board cleared");

    // Re-opened: back to one.
    h.run(`board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = false`);
    assert.match(roundHtml(h), /LAST BATTLE/);
    // My Board view does not show it; Reset Round removes it.
    h.run(`activeBoardSide = "my"; myBoard = createCompanionMyBoard(board)`);
    assert.doesNotMatch(roundHtml(h), /LAST BATTLE/);
    h.run(`activeBoardSide = "opponent"; resetRound()`);
    assert.doesNotMatch(roundHtml(h), /LAST BATTLE/);
});

test("header separates clear bonus from battle banners and labels current vs final", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1209 }); // need 210 = 150 + 60
    let html = roundHtml(h);
    assert.match(html, /5v5 · Attempt 1 · Current opponent score/);
    assert.match(html, /Need 60 battle banners/);
    assert.match(html, /210 = 150 from clearing \(territory clear 150\) \+ 60 from the battle/);
    assert.match(html, /may rise/);
    assert.match(html, /you can afford to lose 5 banners — up to 1 unit/);

    h.run(`bannerData.oppFinal = true`);
    html = roundHtml(h);
    assert.match(html, /Final opponent score/);
    assert.match(html, /To pass their final score/);
    assert.doesNotMatch(html, /may rise/);
});

test("5v5 and 3v3 show their own ceilings; undersize is flagged documented or unverified", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1000 + 150 + 65 }); // battle target 66
    let html = roundHtml(h);
    assert.match(html, /up to 69/);
    assert.match(html, /A full squad tops out at 65 — 1 short/);
    // Prefers the smallest drop that leaves some slack over a flawless-only one.
    assert.match(html, /Field 3, leave 2 slots empty: ceiling 67 \(\+2\), 1 to spare\. Documented as safe to drop 2: Rebels/);
    assert.match(html, /Recommended Rebels: expected ~62 \(estimate, not a guarantee\)/);

    setUp(h, "3v3", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1000 + 148 + 57 }); // battle target 58
    html = roundHtml(h);
    assert.match(html, /up to 59/);
    assert.doesNotMatch(html, /up to 69/);
    assert.match(html, /Field 1, leave 2 slots empty: ceiling 59 \(\+2\), 1 to spare\. No available catalogued counter is documented as safe to drop 2 — unverified/);
});

test("Fleet asks for capital-ship stars and only suggests unlocked reinforcement slots", () => {
    const h = harness();
    setUp(h, "5v5", "BACK_TOP", "Raddus", { my: 1000, opp: 1000 + 153 + 60 }); // battle target 61
    let html = roundHtml(h);
    assert.match(html, /Fleet · Attempt 1/);
    assert.match(html, /Your capital ship/);
    assert.match(html, /aria-pressed="true"[^>]*>Not sure/);
    assert.match(html, /Full fleet: you can afford to lose 9 banners — up to 3 ships \(3 each\)/, "worst case: 70 with the 4th slot locked");
    assert.match(html, /Full fleet: up to 70–73/);
    assert.match(html, /6 empty: up to 79 · 18 to spare <span class="lb-muted">\(needs empty starting slots — unconfirmed\)/);
    assert.match(html, /Executor <span class="lb-muted">~70 ✓/, "no documented drop while the stars are unknown");
    assert.doesNotMatch(html, /drop 3/);
    assert.match(html, /call in every reinforcement you bring/);

    h.run(`setLastBattleFleetCapital("7")`);
    html = h.run(`lastBattleInnerHtml(currentLastBattleAdvice())`);
    assert.match(html, /aria-pressed="true"[^>]*>7★/);
    assert.match(html, /you can afford to lose 12 banners — up to 4 ships/);
    assert.match(html, /~70 · drop 3 → ~73/);
    assert.match(html, /Win this attempt|Winning first time/);
});

test("ahead, covered, impossible, tie and cannot-calculate states", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1200, opp: 1100 });
    assert.match(roundHtml(h), /Ahead of their current score by 100/);
    h.run(`bannerData.oppFinal = true`);
    assert.match(roundHtml(h), /Ahead of their final score by 100/);

    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1100 });
    assert.match(roundHtml(h), /Any win passes their current score/);

    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1000 + 150 + 69 });
    assert.match(roundHtml(h), /Can&#39;t pass|Can't pass/);

    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1000 });
    assert.doesNotMatch(roundHtml(h), /Ahead of/, "level is not ahead");

    setUp(h, "5v5", "FRONT_BOTTOM", "Empire");
    h.run(`scoringRules = scoringRules.filter(r => r.ruleId !== "VICTORY")`);
    assert.match(roundHtml(h), /Cannot calculate precisely/);
});

test("prior losses show bounded ranges; Used + Lost and Undo update the advice", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1000 + 150 + 40 });
    assert.match(roundHtml(h), /Attempt 1/);
    h.run(`markUsedAndLost("opponent", "FRONT_BOTTOM", 0, "REBELS")`);
    let html = roundHtml(h);
    assert.match(html, /Attempt 2/);
    assert.match(html, /figures are ranges \(1–5 enemy defeats\)/);
    assert.match(html, /Best possible: 45–49/);
    h.run(`undoPendingAction()`);
    html = roundHtml(h);
    assert.match(html, /Attempt 1/);
    assert.doesNotMatch(html, /figures are ranges/);
});

test("score typing refreshes the advisor in place without a full render or persisted state", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1209 });
    h.el("app").innerHTML = "SENTINEL";
    h.el("lastBattleBody").innerHTML = "stale";
    h.run(`updateBanner("oppScore", "1214")`);
    assert.equal(h.el("app").innerHTML, "SENTINEL", "no full re-render while typing");
    assert.match(h.el("lastBattleBody").innerHTML, /Need 65 battle banners/);
    assert.ok(!h.keys().some(k => /last|advisor/i.test(k)), "no advisor state persisted");
});

test("Banners needed disclosure breaks down the remaining ceiling without replacing points to win", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "Empire", { my: 1000, opp: 1100 });
    h.run(`board.teams.find(t => t.territory === "FRONT_TOP").cleared = false`);
    h.run(`board.teams.find(t => t.territory === "FRONT_BOTTOM").attempts = 1`);
    const html = h.run(`renderBannersNeeded()`);
    // FRONT_TOP team 0 (65, first attempt) + FRONT_BOTTOM (45, second attempt); clears 180 + 150.
    assert.match(html, /<summary>Banners needed/);
    assert.match(html, /110 from 2 clean battles · 330 from 2 territory clears/);
    assert.match(html, /once one defence remains/);
    const section = h.run(`renderBannerSection()`);
    assert.match(section, /Points to win: 101/);
    const total = h.run(`calculatedRemaining()`);
    assert.equal(total, 110 + 330, "breakdown sums to the calculated remaining");
});

test("unnamed or custom last defence still gets the score target without counters", () => {
    const h = harness();
    setUp(h, "5v5", "FRONT_BOTTOM", "");
    let html = roundHtml(h);
    assert.match(html, /Defence not picked yet/);
    assert.match(html, /Pick this defence from the catalogue/);
    setUp(h, "5v5", "FRONT_BOTTOM", "__NOT_IN_CATALOGUE__");
    h.run(`board.teams.find(t => t.territory === "FRONT_BOTTOM").customName = "<b>X</b>"`);
    html = roundHtml(h);
    assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
});
