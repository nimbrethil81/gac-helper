"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const { auditSource, compileSource, importFromPayload } = require("../scripts/catalogue-source-lib.js");
const { renderRelease, verifyReleaseText } = require("../scripts/catalogue-release-lib.js");
const { fixtureSource, row, modeFile, defence } = require("./fixed-matchup-fixture.js");

const app = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const fixedContract = "gac-catalogue-release:v3";
const payload = compileSource(fixtureSource());

function harness(mode = "3v3") {
    const storage = new Map();
    const context = vm.createContext({
        __GAC_HELPER_TEST__: true, console, URL, AbortController, TextEncoder, crypto, setTimeout,
        clearTimeout, navigator: {}, notify: [], confirm: () => false, alert() {},
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }
    });
    vm.runInContext(app, context);
    const run = code => vm.runInContext(code, context);
    const read = code => JSON.parse(run(`JSON.stringify(${code})`));
    run(`
        render = () => {};
        applyCataloguePayload(${JSON.stringify(payload)});
        currentMode = ${JSON.stringify(mode)};
        board = createRoundBoard("KYBER", currentMode, [
            { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
            { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 }
        ], "opponent", "synthetic-round", "now");
        const target = board.teams.find(t => t.territory === "FRONT_BOTTOM");
        target.name = ${JSON.stringify(defence)};
        board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
        const picks = matchupCounters(currentMode, target.name);
        ownedCharacters = ["TEST_ALPHA", "TEST_BRAVO", "TEST_CHARLIE", "TEST_DELTA", "TEST_ECHO"];
        roundPlan = computeRoundPlan();
        usageHistory.selectedSeasonId = "synthetic season";
    `);
    return { run, read, context, storage };
}

test("fixed solo, duo and 5v5 round-trip source and the seven-key release", () => {
    const source = fixtureSource();
    assert.equal(auditSource(source).summary.releaseGate, "PASS");
    assert.deepEqual(importFromPayload(payload, source["score-meanings.json"]), source);
    const release = renderRelease(payload, 41);
    const verified = verifyReleaseText(release.text);
    assert.equal(verified.release.contract, fixedContract);
    assert.deepEqual(verified.payload, payload);
    assert.equal(Object.keys(verified.payload).length, 7);
    const mislabeled = JSON.parse(release.text);
    mislabeled.release.contract = "gac-catalogue-release:v1";
    assert.throws(() => verifyReleaseText(JSON.stringify(mislabeled)), /release contract/);
});

test("invalid fixed membership and contradictory matchup fields fail both gates", () => {
    function subject(source) {
        const counters = source[modeFile("3v3")].find(r => r.defence === defence).counters;
        const definition = source["counters.json"].find(d => d.id === counters[0].counterId);
        return { counters, entry: counters[0], definition };
    }
    for (const [label, alter] of Object.entries({
        unknown: ({ entry }) => { entry.lineup = "FLEX"; },
        null: ({ entry }) => { entry.lineup = null; },
        drops: ({ entry }) => { entry.undersize = 2; },
        empty: ({ definition }) => { definition.required = []; },
        full: ({ definition }) => { definition.required = ["TEST_ALPHA", "TEST_BRAVO", "TEST_CHARLIE"]; },
        oversized: ({ definition }) => { definition.required = ["TEST_ALPHA", "TEST_BRAVO", "TEST_CHARLIE", "TEST_DELTA"]; },
        duplicates: ({ definition }) => { definition.required = ["TEST_ALPHA", "TEST_ALPHA"]; },
        unknownMember: ({ definition }) => { definition.required = ["TEST_UNKNOWN"]; },
        ship: ({ definition }, source) => { definition.required = [source["units.json"].find(u => u.unitType === "SHIP").id]; },
        recommended: ({ definition }) => { definition.recommended = ["TEST_BRAVO"]; },
        tactical: ({ counters, entry }) => { counters[0] = { counterId: entry.counterId, lineup: "FIXED", role: "SETUP", notes: "Synthetic weakening step." }; },
        retired: ({ entry }) => { entry.confidence = "PROVISIONAL"; },
        fleet: ({ entry }, source) => { source[modeFile("FLEET")].push({ defence, counters: [entry] }); },
        score: ({ entry }) => { entry.bannerScore = 60; }
    })) {
        const source = fixtureSource();
        alter(subject(source), source);
        const report = auditSource(source);
        assert.equal(report.summary.releaseGate, "FAIL", label);
        assert.throws(() => verifyReleaseText(renderRelease(report.payload, 41).text), /release gate/, label);
    }
});

test("3v3 solo and duo use exact names and 54 banners on Counters, Round and First Attack", () => {
    const { run, read } = harness();
    run('board.teams.forEach(t => { t.cleared = false; }); roundPlan = computeRoundPlan()');
    assert.deepEqual(read("picks.map(c => adjustedScore(c, false))"), [54, 54]);
    assert.equal(run("roundPlan.assign['FRONT_BOTTOM:0'].counterId"), "TEST_SOLO");
    for (const [index, names] of ["Synthetic Alpha", "Synthetic Bravo, Synthetic Charlie"].entries()) {
        const matching = new RegExp(`Exact squad: ${names}`);
        if (index === 1) run('ownedCharacters = ownedCharacters.filter(id => id !== "TEST_ALPHA"); roundPlan = computeRoundPlan()');
        for (const code of [
            `buildCounterCardHtml(picks[${index}])`,
            'renderTeamRecommendation("opponent", "FRONT_BOTTOM", target, currentMode)',
            'renderNextUp()'
        ]) {
            const html = run(code);
            assert.match(html, matching);
            assert.match(html, /54/);
            assert.doesNotMatch(html, /full squad|drop up to|flex|\+\d/);
        }
        assert.equal(run(`counterCompositionForDisplay(picks[${index}].counterId, currentMode, picks[${index}].lineup).flex`), 0);
    }
    assert.match(run("renderNextUp()"), /First attack of the round/);
    assert.equal(run('counterCompositionForDisplay("TEST_SOLO", "3v3").flex'), 2, "the shared definition still allows legacy flex");
});

test("5v5 exact lineup projects its authored score without adding one for the empty slot", () => {
    const { run } = harness("5v5");
    assert.equal(run("adjustedScore(roundPlan.assign['FRONT_BOTTOM:0'], false)"), 66);
    assert.match(run("renderNextUp()"), /~66 banners/);
    assert.match(run("renderNextUp()"), /Exact squad: Synthetic Alpha, Synthetic Bravo, Synthetic Charlie, Synthetic Delta/);
});

test("Last Battle keeps fixed estimates and applies only the attempt bonus difference", () => {
    const { run, read } = harness();
    run("bannerData.myScore = 1000; bannerData.oppScore = 1213");
    for (const [attempts, expected] of [[0, 54], [1, 34], [2, 24]]) {
        run(`target.attempts = ${attempts}`);
        const advice = read("currentLastBattleAdvice()");
        assert.equal(advice.status, "ready");
        for (const counter of advice.counters) {
            assert.equal(counter.expected, expected);
            assert.equal(counter.expectedWithDrop, expected);
            assert.equal(counter.documentedDrop, 0);
        }
        const html = run("renderLastBattle()");
        assert.match(html, new RegExp(`Exact squad: Synthetic Alpha[^<]* <span class="lb-muted">~${expected}`));
        assert.doesNotMatch(html, /full squad|safe to drop|if undersized/i);
    }
});

test("allocation, safe override and usage only consume members of the fixed matchup", () => {
    const { context, run, read } = harness();
    run(`
        const other = board.teams.find(t => t.territory === "FRONT_TOP");
        other.cleared = false;
        other.name = "Synthetic second defence";
        gacData[currentMode][other.name] = [{ ...${JSON.stringify(row("TEST_OVERLAP"))}, counter: "Synthetic overlapping duo" }];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(run('Object.keys(roundPlan.assign).length'), 1, "every pair shares a member");
    assert.deepEqual(read('roundPlan.visibleBoardScarcity.directConflicts.map(c => c.requiredCharacters).sort()'), [["TEST_ALPHA"], ["TEST_CHARLIE"]]);
    run('board.defenceSnapshot = { schema: 1, mode: "3v3", characterIds: ["TEST_CHARLIE", "TEST_ECHO"], unresolvedTeams: [] }');
    assert.equal(run('getCounterStatus("TEST_DUO")'), "on-defence");
    assert.equal(run('getCounterStatus("TEST_SOLO")'), "available");
    run('board.defenceSnapshot = null; ownedCharacters = ["TEST_ALPHA", "TEST_CHARLIE"]');
    assert.equal(run('getCounterStatus("TEST_DUO")'), "not-owned");
    run('ownedCharacters.push("TEST_BRAVO", "TEST_ECHO"); usedTeams = [];');
    run(`
        const free = { name: "Synthetic spare counter", required: ["TEST_ECHO"], recommended: [] };
        counterDefinitions.TEST_SPARE = free;
        picks.push({ counterId: "TEST_SPARE", counter: free.name, tier: "A", bannerScore: 53, undersize: 0 });
        roundPlan = computeRoundPlan();
    `);
    assert.equal(run("roundPlan.assign['FRONT_BOTTOM:0'].counterId"), "TEST_SPARE");
    assert.equal(run("roundPlan.assign['FRONT_TOP:0'].counterId"), "TEST_OVERLAP");
    context.confirm = message => { assert.match(message, /weaken coverage for Synthetic second defence through Synthetic Alpha/); return false; };
    run('markCounterUsedFromBoard("TEST_SOLO", "FRONT_BOTTOM:0")');
    assert.deepEqual(read("usedTeams"), []);
    assert.equal(run("usageHistory.events.length"), 0);
    assert.equal(run("automaticAttackUsageFacts('TEST_DUO', '3v3').participants.length"), 2);

    context.confirm = () => true;
    run('markCounterUsedFromBoard("TEST_SOLO", "FRONT_BOTTOM:0")');
    assert.equal(run('getCounterStatus("TEST_OVERLAP")'), "spent");
    assert.equal(run('getCounterStatus("TEST_DUO")'), "available");
    assert.deepEqual(read("usageHistory.events[0].participants.map(p => p.unitId)"), ["TEST_ALPHA"]);
    assert.equal(run("usageHistory.events[0].attribution.complete"), false);
    run('markCounterUsedFromBoard("TEST_DUO", "FRONT_BOTTOM:0")');
    assert.deepEqual(read("usageHistory.events[1].participants.map(p => p.unitId)"), ["TEST_BRAVO", "TEST_CHARLIE"]);
    assert.equal(run("usageHistory.events[1].attribution.complete"), false);
    assert.equal(run("spentCharacters().has('TEST_ECHO')"), false);
});
