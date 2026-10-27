const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const CONFIG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 1 }
];

function harness(initialStorage = {}) {
    const values = new Map(Object.entries(initialStorage));
    const app = { innerHTML: "" };
    const context = {
        __GAC_HELPER_TEST__: true, console, setTimeout: () => 1, clearTimeout() {},
        confirm: () => true, prompt: () => "GAC 100", alert() {}, navigator: { onLine: false },
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: { getElementById: id => id === "app" ? app : null, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    const run = expression => vm.runInContext(expression, context);
    run(`
        characterDefinitions = Object.fromEntries(["A", "B", "C", "D", "E", "P0", "P1", "P2", "P3", "PR", "SWAP"].map(id => [id,{name:id,unitType:"CHARACTER"}]));
        characterDefinitions.CAP = {name:"Capital",unitType:"CAPITAL_SHIP",pilotIds:["P0"]};
        characterDefinitions.S1 = {name:"Multi crew",unitType:"SHIP",pilotIds:["P1","P2"]};
        characterDefinitions.S2 = {name:"Shared crew",unitType:"SHIP",pilotIds:["P1"]};
        characterDefinitions.S3 = {name:"Pilotless",unitType:"SHIP",pilotIds:[]};
        characterDefinitions.R1 = {name:"Bench",unitType:"SHIP",pilotIds:["PR"]};
        counterDefinitions = {
            C1:{name:"Attack",required:["A","B"],recommended:["C","D","E"]},
            F1:{name:"Fleet",required:["CAP"],recommended:["S1","S2","S3"]}
        };
        gacData={"5v5":{},"3v3":{},FLEET:{}};
        boardConfig={KYBER:{"5v5":${JSON.stringify(CONFIG)}}};
        scoringRules=[{ruleId:"SETTING_DEFENCE",battleType:"ANY",mode:"ANY",value:90}];
        ownedCharacters=[];
        board=createRoundBoard("KYBER","5v5",${JSON.stringify(CONFIG)},"opponent","round-1","2026-10-27T10:00:00.000Z");
        myBoard=createRoundBoard("KYBER","5v5",${JSON.stringify(CONFIG)},"my","round-1","2026-10-27T10:00:00.000Z");
    `);
    return { values, context, run, read: expression => JSON.parse(run(`JSON.stringify(${expression})`)) };
}

const LINEUP = { capitalShipId: "CAP", startingShipIds: ["S1", "S2", "S3"], reinforcementIds: ["R1"] };
const ids = fact => fact.participants.map(p => p.unitId).sort();
const event = h => h.read("usageHistory.events[0]");

test("new squad usage automatically credits only its trustworthy required core and stays incomplete", () => {
    const h = harness();
    h.run("markUsed('C1')");
    assert.deepEqual(ids(event(h)), ["A", "B"]);
    assert.equal(event(h).attribution.complete, false);
    assert.equal(event(h).participants.some(p => ["C", "D", "E"].includes(p.unitId)), false);
    h.run("counterDefinitions.C1.required=['SWAP']; render(); markUsed('C1')");
    assert.deepEqual(ids(event(h)), ["A", "B"], "catalogue changes never rewrite recorded attribution");
});

test("actual squad corrections replace core attribution without changing battle identity, result or live planning state", () => {
    const h = harness();
    h.run("markUsedAndLost('opponent','FRONT_TOP',0,'C1')");
    const initial = event(h);
    const before = h.read("({usedTeams,board,myBoard,bannerData})");
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,{characterIds:['A','C','D'],intentionalUndersize:true},{complete:true})`), true);
    const corrected = event(h);
    assert.deepEqual(ids(corrected), ["A", "C", "D"]);
    assert.equal(corrected.id, initial.id);
    assert.equal(corrected.roundId, initial.roundId);
    assert.equal(corrected.seasonId, initial.seasonId);
    assert.equal(corrected.outcome, "lost");
    assert.equal(corrected.attribution.complete, true);
    assert.deepEqual(h.read("({usedTeams,board,myBoard,bannerData})"), before);
    assert.equal(h.run("usageHistory.events.length"), 1);
});

test("squad corrections reject duplicate, wrong-type and oversized lineups atomically", () => {
    const h = harness();
    h.run("markUsed('C1')");
    const before = event(h);
    for (const lineup of [
        { characterIds: ["A", "A"], intentionalUndersize: true },
        { characterIds: ["CAP"], intentionalUndersize: true },
        { characterIds: ["A", "B", "C", "D", "E", "SWAP"] }
    ]) {
        assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(lineup)},{complete:true})`), false);
        assert.deepEqual(event(h), before);
    }
});

test("known capital and starting ships credit multi-crew pilots once and exclude unused reinforcements", () => {
    const h = harness();
    const fact = h.read(`fleetUsageFacts(${JSON.stringify(LINEUP)},'test',true)`);
    assert.deepEqual(ids(fact), ["CAP", "P0", "P1", "P2", "S1", "S2", "S3"]);
    assert.equal(fact.participants.filter(p => p.unitId === "P1").length, 1);
    assert.equal(fact.participants.find(p => p.unitId === "P0").role, "pilot");
    assert.equal(fact.capitalShipId, "CAP");
    assert.deepEqual(fact.benchShips, ["R1"]);
    assert.equal(fact.attribution.pilotsComplete, true);
});

test("reinforcements contribute ship and crew only after explicit actual-participation confirmation", () => {
    const h = harness();
    const lineup = { ...LINEUP, participatingReinforcementIds: ["R1"] };
    const fact = h.read(`fleetUsageFacts(${JSON.stringify(lineup)},'test',true)`);
    assert.ok(ids(fact).includes("R1"));
    assert.ok(ids(fact).includes("PR"));
    assert.equal(fact.participants.find(p => p.unitId === "R1").role, "reinforcement");
    assert.equal(ids(fact).filter(id => id === "P1").length, 1);
});

test("pilotless hulls remain ships and missing pilot metadata stays visibly incomplete", () => {
    const h = harness();
    h.run("characterDefinitions.CAP.pilotIds=[]; characterDefinitions.S1.pilotIds=[]; characterDefinitions.S2.pilotIds=[]");
    let fact = h.read(`fleetUsageFacts(${JSON.stringify(LINEUP)},'test',true)`);
    assert.deepEqual(ids(fact), ["CAP", "S1", "S2", "S3"]);
    assert.equal(fact.attribution.pilotsComplete, true);
    h.run("delete characterDefinitions.S1.pilotIds");
    fact = h.read(`fleetUsageFacts(${JSON.stringify(LINEUP)},'test',true)`);
    assert.equal(fact.attribution.pilotsComplete, false);
    assert.deepEqual(ids(fact), ["CAP", "S1", "S2", "S3"]);
});

test("capital-only fleet counter does not invent starter or reinforcement ships", () => {
    const h = harness();
    h.run("currentMode='FLEET'; markUsed('F1')");
    assert.deepEqual(ids(event(h)), ["CAP", "P0"]);
    assert.equal(event(h).capitalShipId, "CAP");
    assert.equal(event(h).attribution.complete, false);
});

test("saved attacking fleet records only future actual uses and remains independent of defensive templates", () => {
    const h = harness();
    h.run("currentMode='FLEET'; markUsed('F1')");
    const first = event(h);
    assert.equal(h.run(`saveAttackFleetLineup('F1',${JSON.stringify(LINEUP)})`), true);
    assert.deepEqual(event(h), first, "saving a reusable fleet cannot reinterpret a previous battle");
    assert.equal(h.values.has("defenceTemplate:5v5"), false);
    h.run("board.roundId='round-2'; usedTeams=[]; markUsed('F1')");
    const second = h.read("usageHistory.events[1]");
    assert.deepEqual(ids(second), ["CAP", "P0", "P1", "P2", "S1", "S2", "S3"]);
    assert.deepEqual(second.benchShips, ["R1"]);
    assert.equal(second.attribution.complete, true);
    assert.equal(second.capitalShipId, "CAP");
    assert.equal(h.run("usageHistory.attackFleetLineups.F1.schema"), 1);
});

test("reusable attacking fleets reject duplicate, missing-starter, wrong-type and non-counter assignments", () => {
    const h = harness();
    for (const [counterId, lineup] of [
        ["F1", { ...LINEUP, startingShipIds: ["S1", "S1", "S3"] }],
        ["F1", { ...LINEUP, startingShipIds: ["S1"] }],
        ["F1", { ...LINEUP, capitalShipId: "A" }],
        ["F1", { ...LINEUP, reinforcementIds: ["S1"] }],
        ["MISSING", LINEUP]
    ]) {
        assert.equal(h.run(`saveAttackFleetLineup(${JSON.stringify(counterId)},${JSON.stringify(lineup)})`), false);
    }
    assert.equal(h.run("Object.keys(usageHistory.attackFleetLineups || {}).length"), 0);
});

test("per-battle fleet corrections add actual reinforcements idempotently and preserve a reusable lineup", () => {
    const h = harness();
    h.run(`currentMode='FLEET'; saveAttackFleetLineup('F1',${JSON.stringify(LINEUP)}); markUsed('F1')`);
    const initial = event(h);
    const saved = h.read("usageHistory.attackFleetLineups");
    const actual = { ...LINEUP, participatingReinforcementIds: ["R1"] };
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(actual)},{complete:true})`), true);
    const corrected = event(h);
    assert.deepEqual(ids(corrected), ["CAP", "P0", "P1", "P2", "PR", "R1", "S1", "S2", "S3"]);
    assert.equal(corrected.id, initial.id);
    assert.equal(corrected.outcome, initial.outcome);
    assert.deepEqual(h.read("usageHistory.attackFleetLineups"), saved);
    h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(actual)},{complete:true})`);
    assert.equal(event(h).revision, corrected.revision);
    assert.equal(h.run("usageHistory.events.length"), 1);
});

test("invalid fleet actual participation is rejected without overwriting a recorded battle", () => {
    const h = harness();
    h.run("currentMode='FLEET'; markUsed('F1')");
    const initial = event(h);
    const bad = { ...LINEUP, participatingReinforcementIds: ["S1"] };
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(bad)},{complete:true})`), false);
    assert.deepEqual(event(h), initial);
});

test("defensive fleet deployment credits capital and starters but keeps selected reinforcements benched", () => {
    const h = harness();
    h.run(`board.defenceSnapshot=aggregateDefenceSnapshot({schema:2,mode:'5v5',capturedAt:'now',missingSavedDefence:false,legacyCharacterIds:[],slots:[{
        territory:'BACK_TOP',index:0,name:'Fleet',customName:'',type:'FLEET',characterIds:['CAP','S1','S2','S3','R1'],confirmed:true,reviewed:false,source:'saved',lineup:${JSON.stringify(LINEUP)}
    }]}); confirmRoundDefenceUsage()`);
    const deployment = event(h);
    assert.equal(deployment.side, "defence");
    assert.equal(deployment.outcome, "deployed");
    assert.deepEqual(ids(deployment), ["CAP", "P0", "P1", "P2", "S1", "S2", "S3"]);
    assert.deepEqual(deployment.benchShips, ["R1"]);
    const before = deployment;
    h.run("characterDefinitions.S1.pilotIds=['SWAP']; syncConfirmedDefenceUsage(); render()");
    assert.deepEqual(event(h), before, "new metadata never reinterprets a frozen defensive event");
});

test("recorded pilot attribution survives reload and current catalogue changes", () => {
    const h = harness();
    h.run(`currentMode='FLEET'; saveAttackFleetLineup('F1',${JSON.stringify(LINEUP)}); markUsed('F1')`);
    const initial = event(h);
    const reopened = harness(Object.fromEntries(h.values));
    reopened.run("characterDefinitions.S1.pilotIds=['SWAP']; render()");
    assert.deepEqual(event(reopened), initial);
});

test("bench-only corrections persist without changing participant counts and repeating them is idempotent", () => {
    const h = harness();
    h.run(`currentMode='FLEET'; saveAttackFleetLineup('F1',${JSON.stringify(LINEUP)}); markUsed('F1')`);
    const actual = { ...LINEUP, reinforcementIds: [] };
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(actual)},{complete:true})`), true);
    const corrected = event(h);
    assert.deepEqual(corrected.benchShips, []);
    assert.deepEqual(ids(corrected), ["CAP", "P0", "P1", "P2", "S1", "S2", "S3"]);
    h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(actual)},{complete:true})`);
    assert.equal(event(h).revision, corrected.revision);
});

test("an overspecified shared squad core does not manufacture an impossible 3v3 lineup", () => {
    const h = harness();
    h.run("currentMode='3v3'; counterDefinitions.C1.required=['A','B','C','D','E']; markUsed('C1')");
    assert.equal(event(h).mode, "3v3");
    assert.deepEqual(ids(event(h)), []);
    assert.equal(event(h).attribution.complete, false);
});

test("event-local correction retains a historical removed member while rejecting invented unknown IDs", () => {
    const h = harness();
    h.run("markUsed('C1'); delete characterDefinitions.A");
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,{characterIds:['A','C'],intentionalUndersize:true},{complete:true})`), true);
    assert.deepEqual(ids(event(h)), ["A", "C"]);
    const before = event(h);
    assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,{characterIds:['NEVER_RECORDED','C'],intentionalUndersize:true},{complete:true})`), false);
    assert.deepEqual(event(h), before);
});

test("only fleet counters can own a reusable attacking fleet", () => {
    const h = harness();
    assert.equal(h.run(`saveAttackFleetLineup('C1',${JSON.stringify(LINEUP)})`), false);
    assert.equal(h.run(`saveAttackFleetLineup('F1',${JSON.stringify(LINEUP)})`), true);
});

test("malformed fleet correction shapes return false and do not replace history", () => {
    const h = harness();
    h.run("markCounterUsedFromBoard('F1','BACK_TOP:0')");
    const before = event(h);
    for (const lineup of [null, { startingShipIds: {} }, { startingShipIds: "S1" }, { reinforcementIds: 3 }, { participatingReinforcementIds: {} }, { capitalShipId: 0 }]) {
        assert.equal(h.run(`correctUsageLineup(usageHistory.events[0].id,${JSON.stringify(lineup)},{complete:false})`), false);
        assert.deepEqual(event(h), before);
    }
});

test("quota failure during actual lineup correction retains previous memory and disk facts", () => {
    const h = harness();
    h.run("markUsed('C1')");
    const before = event(h);
    const stored = h.values.get("gacUsageHistory:v1");
    const set = h.context.localStorage.setItem;
    h.context.localStorage.setItem = (key, value) => {
        if (key === "gacUsageHistory:v1") throw Error("quota");
        set(key, value);
    };
    assert.equal(h.run("correctUsageLineup(usageHistory.events[0].id,{characterIds:['A','C'],intentionalUndersize:true},{complete:true})"), false);
    assert.deepEqual(event(h), before);
    assert.equal(h.values.get("gacUsageHistory:v1"), stored);
});

test("malformed optional local event extensions quarantine only the bad row", () => {
    const h = harness();
    h.run("markCounterUsedFromBoard('F1','BACK_TOP:0')");
    const original = h.read("usageHistory");
    for (const patch of [{ benchShips: "S1" }, { attribution: { complete: false, provenance: "x", pilotsComplete: "yes" } }, { participants: {} }, { capitalShipId: "S1" }]) {
        const history = { ...original, events: [{ ...original.events[0], ...patch }] };
        const reloaded = harness({ "gacUsageHistory:v1": JSON.stringify(history) });
        assert.equal(reloaded.run("usageHistory.events.length"), 0);
        assert.equal(reloaded.run("usageHistory.rejectedEvents.length"), 1);
    }
});
