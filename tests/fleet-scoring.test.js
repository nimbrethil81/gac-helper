const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Fleet scoring (issue #86): one slot model behind Last Battle, Counters, Round
// recommendations, Next Up and allocation ranking. The 7 OWN_UNITS slots are 3
// starting + 4 reinforcement slots; the 4th reinforcement slot needs a 7★
// capital ship; only empty unlocked reinforcement slots are confirmed to earn
// UNUSED_SLOT. The wiki's 73–79 ladder is therefore partly theoretical.

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

// Back Top holds two fleets so a multi-team territory clear is exercised.
const CFG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
    { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 2 },
    { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
];
const FLEET_CLEAR = 120 + 2 * 33;

// The issue's example: Profundity attacking Chimaera, bannerScore 71, undersize 2.
const CATALOGUE = {
    gacData: {
        "5v5": { Empire: [{ counterId: "REBELS", counter: "Rebels", tier: "S", bannerScore: 62, undersize: 2 }] },
        FLEET: {
            Chimaera: [
                { counterId: "PROFUNDITY", counter: "Profundity", tier: "S", bannerScore: 71, undersize: 2 },
                { counterId: "EXECUTOR", counter: "Executor", tier: "S", bannerScore: 71, undersize: 0 }
            ],
            "Home One": [
                { counterId: "DROPPER", counter: "Dropper", tier: "S", bannerScore: 70, undersize: 2 },
                { counterId: "STEADY", counter: "Steady", tier: "S", bannerScore: 71, undersize: 0 }
            ]
        }
    },
    counterDefinitions: {
        REBELS: { required: ["U1"] },
        PROFUNDITY: { required: ["CAP_PROF"] }, EXECUTOR: { required: ["CAP_EXEC"] },
        DROPPER: { required: ["CAP_DROP"] }, STEADY: { required: ["CAP_STEADY"] }
    }
};

function load(h, owned) {
    h.run(`
        gacData = ${JSON.stringify(CATALOGUE.gacData)};
        counterDefinitions = ${JSON.stringify(CATALOGUE.counterDefinitions)};
        characterDefinitions = {}; usedTeams = [];
        ownedCharacters = ${JSON.stringify(owned || ["U1", "CAP_PROF", "CAP_EXEC", "CAP_DROP", "CAP_STEADY"])};
        activeBoardSide = "opponent"; currentView = "round";
    `);
}

// Every team cleared except Back Top #0, named `name`.
function lastFleet(h, name, opts) {
    const o = Object.assign({ my: 1000, opp: 1000, final: false, attempts: 0 }, opts || {});
    load(h, o.owned);
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(CFG)}, "opponent", "r", "now");
        board.teams.forEach(t => { t.cleared = !(t.territory === "BACK_TOP" && t.index === 0); });
        { const last = board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0);
          last.name = ${JSON.stringify(name)}; last.attempts = ${o.attempts}; }
        bannerData.myScore = ${o.my}; bannerData.oppScore = ${o.opp}; bannerData.oppFinal = ${o.final};
    `);
}

// Opponent score that leaves exactly `battle` banners to find in the battle.
const battleTarget = battle => ({ my: 1000, opp: 999 + FLEET_CLEAR + battle });

const advise = (h, capital) => JSON.parse(h.run(`JSON.stringify(currentLastBattleAdvice({ fleetCapital: ${JSON.stringify(capital)} }))`));
const cardHtml = (h, capital) => h.run(`lastBattleInnerHtml(currentLastBattleAdvice({ fleetCapital: ${JSON.stringify(capital)} }))`);

test("full-fleet 73 and the 73–79 ladder: 7★ confirms four empty slots, the rest stay theoretical", () => {
    const h = harness();
    lastFleet(h, "Chimaera");
    const r = advise(h, "7");
    assert.deepEqual(r.formations.map(f => [f.emptySlots, f.fielded, f.maxLow, f.slotRuleConfirmed]), [
        [0, 7, 73, true], [1, 6, 74, true], [2, 5, 75, true], [3, 4, 76, true], [4, 3, 77, true],
        [5, 2, 78, false], [6, 1, 79, false]
    ]);
    assert.deepEqual([r.ceilings.fullSquad.low, r.ceilings.max.low, r.ceilings.theoreticalMax.high], [73, 77, 79]);
    assert.equal(r.confidence, "exact");
    assert.deepEqual(r.needsInput, []);
    assert.deepEqual(r.fleetCapacity, { capital: "7", eligible: [7], confirmedEmpty: 4 });
});

test("a 5★–6★ capital locks the 4th reinforcement slot: 70 full fleet, 73 confirmed, 75 theoretical", () => {
    const h = harness();
    lastFleet(h, "Chimaera");
    const r = advise(h, "5-6");
    assert.deepEqual(r.formations.map(f => [f.emptySlots, f.fielded, f.maxLow, f.slotRuleConfirmed]), [
        [0, 6, 70, true], [1, 5, 71, true], [2, 4, 72, true], [3, 3, 73, true], [4, 2, 74, false], [5, 1, 75, false]
    ]);
    assert.deepEqual([r.ceilings.max.low, r.ceilings.theoreticalMax.high], [73, 75]);
});

test("unknown capital-ship stars give ranges and a safe worst case, never false precision", () => {
    const h = harness();
    lastFleet(h, "Chimaera");
    const r = advise(h, null);
    assert.deepEqual(r.formations.slice(0, 4).map(f => [f.emptySlots, f.maxLow, f.maxHigh, f.slotRuleConfirmed]), [
        [0, 70, 73, true], [1, 71, 74, true], [2, 72, 75, true], [3, 73, 76, true]
    ]);
    assert.equal(r.formations[4].slotRuleConfirmed, false, "a 4th empty slot may be the locked one or a starting slot");
    assert.deepEqual([r.formations[6].maxLow, r.formations[6].maxHigh], [79, 79], "only a 7★ capital can field a single ship");
    assert.equal(r.confidence, "bounded");
    assert.deepEqual(r.needsInput, ["fleetCapital"]);
    assert.equal(r.fleetCapacity.capital, null);
});

test("Profundity 71 / undersize 2: no screen shows a precise 73 until the stars are known", () => {
    const h = harness();
    lastFleet(h, "Chimaera", battleTarget(60));
    const round = h.run(`renderRound()`);
    assert.doesNotMatch(round, /\b73 banners\b/);
    assert.doesNotMatch(round, /drop up to 2 for \+2/);
    // Counters card, Round recommendation and Next Up share one conditional wording.
    const wording = /leave up to 2 reinforcement slots empty for up to \+2 — unlocked slots only \(the 4th needs a 7★ capital ship\)/;
    h.run(`currentMode = "FLEET"`);
    const card = h.run(`buildCounterCardHtml(gacData.FLEET.Chimaera[0])`);
    assert.match(card, wording);
    assert.doesNotMatch(card, /73/);
    assert.match(h.run(`buildCounterCardHtml(gacData.FLEET.Chimaera[1])`), /Undersize:<\/strong> full fleet/);
    const rec = h.run(`renderTeamRecommendation("opponent", "BACK_TOP", board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0), "FLEET")`);
    const nextUp = h.run(`renderNextUp()`);
    for (const html of [rec, nextUp]) {
        assert.match(html, /Profundity/);
        assert.match(html, wording);
        assert.doesNotMatch(html, /73/);
    }

    // Last Battle: estimate only, no drop added, until the stars are chosen.
    let lb = cardHtml(h, null);
    assert.match(lb, /Profundity <span class="lb-muted">~71 ✓/);
    assert.doesNotMatch(lb, /~73/);
    lb = cardHtml(h, "7");
    assert.match(lb, /Profundity <span class="lb-muted">~71 · drop 2 → ~73/);
    lb = cardHtml(h, "5-6");
    assert.match(lb, /Profundity <span class="lb-muted">~68 · drop 2 → ~70/, "the locked slot's 3 per-unit banners are gone");
});

test("ranking never banks an unverified fleet undersize premium; squads keep theirs", () => {
    const h = harness();
    lastFleet(h, "Home One");
    const plan = JSON.parse(h.run(`JSON.stringify(computeRoundPlan())`));
    const key = "BACK_TOP:0";
    assert.equal(plan.assign[key].counterId, "STEADY", "71 full fleet beats 70 + an unverified 2");
    assert.doesNotMatch(plan.reasons[key].reason, /undersize potential/);
    assert.equal(h.run(`adjustedScore(gacData.FLEET["Home One"][0], true)`), 70);
    assert.equal(h.run(`adjustedScore(gacData["5v5"].Empire[0], false)`), 64, "squad premium unchanged");
    assert.equal(h.run(`undersizeInfo(gacData["5v5"].Empire[0], false).total`), 64);
    assert.equal(h.run(`undersizeInfo(gacData.FLEET["Home One"][0], true).total`), null);
});

test("an undersize-dependent target above the full-fleet ceiling is uncertain, not impossible", () => {
    const h = harness();
    lastFleet(h, "Chimaera", battleTarget(75));
    let r = advise(h, null);
    assert.equal(r.battleTarget, 75);
    assert.equal(r.verdict, "uncertain", "73 confirmed worst case < 75 ≤ 79 theoretical");
    let html = cardHtml(h, null);
    assert.match(html, /A full fleet tops out at 73 — 2 short/);
    assert.match(html, /Best possible: 73–76 \(up to 79 only if empty starting slots score — unconfirmed\)/);
    assert.doesNotMatch(html, /reinforcement slots? empty: ceiling/, "no drop clears the worst case while the stars are unknown");
    assert.doesNotMatch(html, /Can't pass/);

    r = advise(h, "7");
    assert.equal(r.verdict, "needsBattle");
    html = cardHtml(h, "7");
    assert.match(html, /Leave 3 reinforcement slots empty: ceiling 76 \(\+3\), 1 to spare\. No available catalogued counter is documented as safe to drop 3 — unverified\./);
    assert.match(html, /Best possible: 77\./);

    lastFleet(h, "Chimaera", battleTarget(78));
    assert.equal(advise(h, "7").verdict, "uncertain", "78 needs empty starting slots");
    assert.equal(advise(h, null).verdict, "uncertain");
    assert.equal(advise(h, "5-6").verdict, "impossible", "a 6-slot fleet cannot pass 75 even in theory");

    lastFleet(h, "Chimaera", battleTarget(80));
    for (const cap of [null, "7", "5-6"]) assert.equal(advise(h, cap).verdict, "impossible", String(cap));
    assert.match(cardHtml(h, null), /the best this battle can bank is 79/);
});

test("repeat attempts and enemy remnants stay bounded; clear bonus, final and current scores are separate", () => {
    const h = harness();
    lastFleet(h, "Chimaera", Object.assign(battleTarget(50), { attempts: 1 }));
    let r = advise(h, "7");
    assert.equal(r.target.attemptNumber, 2);
    assert.deepEqual([r.ceilings.fullSquad.low, r.ceilings.fullSquad.high], [47, 53], "second attempt: 53 with 1–7 enemy defeats");
    assert.ok(r.needsInput.includes("enemiesRemaining"));
    assert.equal(r.verdict, "needsBattle", "50 ≤ 51: four empty slots with only one enemy left still reach it");
    r = JSON.parse(h.run(`JSON.stringify(currentLastBattleAdvice({ fleetCapital: "7", enemiesRemaining: 7 }))`));
    assert.deepEqual([r.ceilings.fullSquad.low, r.confidence], [53, "exact"]);

    lastFleet(h, "Chimaera", Object.assign(battleTarget(60), { attempts: 2 }));
    r = advise(h, null);
    assert.deepEqual([r.ceilings.fullSquad.low, r.ceilings.fullSquad.high], [34, 43], "third+: no attempt bonus, 6–7 slots, 1–7 enemies");
    assert.equal(r.verdict, "impossible", "60 exceeds the 49 theoretical third-attempt ceiling");

    lastFleet(h, "Chimaera", { my: 1000, opp: 1100, final: true });
    r = advise(h, null);
    assert.deepEqual(r.bonusesOnClear, { territoryClear: FLEET_CLEAR, firstAttack: 0, total: FLEET_CLEAR });
    assert.equal(r.verdict, "coveredByClear");
    assert.match(cardHtml(h, null), /Any win passes their final score/);
    lastFleet(h, "Chimaera", { my: 1000, opp: 1100 });
    assert.match(cardHtml(h, null), /Any win passes their current score/);
});

test("capital-ship stars are in-memory UI state: refresh in place, never persisted, cleared by Reset Round", () => {
    const h = harness();
    lastFleet(h, "Chimaera", battleTarget(60));
    h.run(`renderRound()`);
    const before = h.keys();
    h.el("lastBattleBody").innerHTML = "stale";
    h.run(`setLastBattleFleetCapital("7")`);
    assert.match(h.el("lastBattleBody").innerHTML, /aria-pressed="true"[^>]*>7★/);
    assert.deepEqual(h.keys(), before, "nothing new persisted");
    assert.equal(h.run(`currentLastBattleAdvice().fleetCapacity.capital`), "7");
    h.run(`setLastBattleFleetCapital("9")`);
    assert.equal(h.run(`lastBattleFleetCapital`), null, "unknown values read as not sure");
    h.run(`setLastBattleFleetCapital("5-6"); resetRound()`);
    assert.equal(h.run(`lastBattleFleetCapital`), null);
});

test("squad last battles and the Banners needed note are unchanged by the fleet model", () => {
    const h = harness();
    load(h);
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(CFG)}, "opponent", "r", "now");
        board.teams.forEach(t => { t.cleared = t.territory !== "FRONT_BOTTOM"; });
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Empire";
        bannerData.myScore = 1000; bannerData.oppScore = 1000;
    `);
    const r = advise(h, "5-6");
    assert.equal(r.fleetCapacity, null, "the capital input is ignored for squads");
    assert.deepEqual(r.formations.map(f => [f.fielded, f.maxLow, f.slotRuleConfirmed]), [[5, 65, true], [4, 66, true], [3, 67, true], [2, 68, true], [1, 69, true]]);
    assert.deepEqual([r.ceilings.max.low, r.ceilings.theoreticalMax.high], [69, 69]);
    assert.doesNotMatch(cardHtml(h, null), /capital ship/);
    h.run(`board.teams.find(t => t.territory === "BACK_TOP" && t.index === 0).cleared = false`);
    assert.match(h.run(`renderBannersNeeded()`), /fleet battles assume a full fleet with a 7★ capital ship/);
});
