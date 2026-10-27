const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function harness(initialStorage = {}) {
    const values = new Map(Object.entries(initialStorage));
    const appElement = { innerHTML: "" };
    const alerts = [];
    const context = {
        __GAC_HELPER_TEST__: true, console,
        setTimeout: () => 1, clearTimeout: () => {},
        confirm: () => true, prompt: () => "GAC 100", alert: text => alerts.push(text),
        navigator: { onLine: false },
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: {
            getElementById: id => id === "app" ? appElement : null,
            querySelectorAll: () => [], querySelector: () => null
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return {
        values, appElement, alerts, context,
        run: expression => vm.runInContext(expression, context),
        read: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context))
    };
}

const CONFIG = [
    { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
    { territory: "BACK_TOP", type: "FLEET", teamCount: 1 }
];

function setup(initialStorage = {}, mode = "5v5") {
    const h = harness(initialStorage);
    h.run(`
        characterDefinitions = Object.fromEntries(["A", "B", "C", "D", "E", "F"].map(id => [id, { name: id, unitType: "CHARACTER" }]));
        for (const id of ["S1", "S2", "S3", "S4"]) characterDefinitions[id] = { name: id, unitType: "SHIP" };
        characterDefinitions.CAP = { name: "Capital", unitType: "CAPITAL_SHIP" };
        counterDefinitions = {
            C1: { name: "Attack", required: ["A", "B"] },
            C2: { name: "Cleanup", required: ["C"] },
            F1: { name: "Fleet", required: ["CAP", "S1"] }
        };
        ownedCharacters = Object.keys(characterDefinitions);
        gacData = { "5v5": {}, "3v3": {}, FLEET: {} };
        boardConfig = { KYBER: { "5v5": ${JSON.stringify(CONFIG)}, "3v3": ${JSON.stringify(CONFIG)} } };
        scoringRules = [{ ruleId: "SETTING_DEFENCE", battleType: "ANY", mode: "ANY", value: 90 }];
        board = createRoundBoard("KYBER", ${JSON.stringify(mode)}, ${JSON.stringify(CONFIG)}, "opponent", "round-1", "2026-10-27T10:00:00.000Z");
        myBoard = createRoundBoard("KYBER", ${JSON.stringify(mode)}, ${JSON.stringify(CONFIG)}, "my", "round-1", "2026-10-27T10:00:00.000Z");
    `);
    return h;
}

const events = h => h.read("usageHistory.events");
const activeEvents = h => events(h).filter(event => !event.voided);

function freezeDefence(h) {
    h.run(`
        myBoard.teams[0].name = "Wall";
        myBoard.teams[1].name = "Unknown wall";
        myBoard.teams[2].name = "Fleet";
        board.defenceSnapshot = aggregateDefenceSnapshot({
            schema: 2, mode: board.mode, capturedAt: "2026-10-27T10:00:00.000Z",
            missingSavedDefence: false, legacyCharacterIds: ["F"],
            slots: [
                { territory: "FRONT_TOP", index: 0, name: "Wall", customName: "", type: "SQUAD", characterIds: ["A", "B", "C", "D", "E"], confirmed: true, reviewed: false, source: "saved", lineup: { characterIds: ["A", "B", "C", "D", "E"], confirmed: true } },
                { territory: "FRONT_TOP", index: 1, name: "Unknown wall", customName: "", type: "SQUAD", characterIds: ["F"], confirmed: false, reviewed: false, source: "catalogue" },
                { territory: "BACK_TOP", index: 0, name: "Fleet", customName: "", type: "FLEET", characterIds: ["CAP", "S1", "S2", "S3"], confirmed: true, reviewed: false, source: "saved", lineup: { capitalShipId: "CAP", startingShipIds: ["S1", "S2", "S3"], reinforcementIds: [], confirmed: true } }
            ]
        });
    `);
}

test("all offensive entry points record once and keep required core attribution incomplete", () => {
    const h = setup();
    h.run("markUsed('C1'); markUsed('C1'); render(); markCounterUsedFromBoard('C1', 'FRONT_TOP:0')");
    assert.equal(events(h).length, 1);
    const initial = events(h)[0];
    assert.equal(initial.side, "attack");
    assert.equal(initial.roundId, "round-1");
    assert.equal(initial.seasonId, "GAC 100");
    assert.deepEqual(initial.participants.map(p => p.unitId), ["A", "B"]);
    assert.equal(initial.attribution.complete, false);
    h.run("markUsedAndCleared('opponent', 'FRONT_TOP', 0, 'C1')");
    assert.equal(events(h).length, 1);
    assert.equal(events(h)[0].id, initial.id);
    assert.equal(events(h)[0].outcome, "won");
    h.run("undoPendingAction()");
    assert.equal(activeEvents(h).length, 1, "undoing result update retains original participation");
    assert.equal(events(h)[0].outcome, "used");
    assert.equal(h.run("usedTeams.includes('C1')"), true);
});

test("board Mark used and Used + Lost amend one event; Undo restores the prior result", () => {
    const h = setup({}, "3v3");
    h.run("markCounterUsedFromBoard('C1', 'FRONT_TOP:0'); markUsedAndLost('opponent', 'FRONT_TOP', 0, 'C1')");
    assert.equal(events(h).length, 1);
    assert.equal(events(h)[0].mode, "3v3");
    assert.equal(events(h)[0].slotKey, "FRONT_TOP:0");
    assert.equal(events(h)[0].outcome, "lost");
    assert.equal(h.run("board.teams[0].attempts"), 1);
    h.run("undoPendingAction()");
    assert.equal(activeEvents(h).length, 1);
    assert.equal(events(h)[0].outcome, "used");
    assert.equal(h.run("board.teams[0].attempts"), 0);
});

test("Undo reverses only its own new contribution and never backfills an already-used legacy counter", () => {
    const h = setup();
    h.run("markUsedAndLost('opponent', 'FRONT_TOP', 0, 'C1'); markUsedAndLost('opponent', 'FRONT_TOP', 0, 'C2'); undoPendingAction()");
    assert.equal(activeEvents(h).length, 1);
    assert.equal(activeEvents(h)[0].counterId, "C1");
    assert.equal(h.run("JSON.stringify(usedTeams)"), '["C1"]');
    h.run("usedTeams.push('LEGACY'); markUsedAndCleared('opponent', 'FRONT_TOP', 1, 'LEGACY'); undoPendingAction()");
    assert.equal(events(h).some(event => event.counterId === "LEGACY"), false);
    assert.equal(h.run("usedTeams.includes('LEGACY')"), true);
});

test("counter Mark used without an active round keeps existing tracking without fabricating a round", () => {
    const h = setup();
    h.run("board = null; myBoard = null; markUsed('C1')");
    assert.equal(h.run("usedTeams.includes('C1')"), true);
    assert.equal(events(h).length, 0);
});

test("history survives reset, reload and catalogue replacement; old used state is never backfilled", () => {
    const h = setup({ usedTeams: '["C2"]' });
    assert.equal(events(h).length, 0);
    h.run("markUsed('C1')");
    const recorded = events(h);
    h.run("resetRound(); counterDefinitions = {}; characterDefinitions = {}; render()");
    assert.deepEqual(events(h), recorded);
    const restored = harness(Object.fromEntries(h.values));
    assert.deepEqual(events(restored), recorded);
    assert.equal(restored.run("board"), null);
});

test("explicit season selection is reused across rounds rather than inferred from dates", () => {
    const h = setup();
    let prompts = 0;
    h.context.prompt = () => { prompts++; return "Season alpha"; };
    h.run("markUsed('C1'); resetRound()");
    h.run(`board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(CONFIG)}, "opponent", "round-2", "2030-01-01T00:00:00.000Z"); markUsed('C1')`);
    assert.equal(prompts, 1);
    assert.deepEqual(events(h).map(event => event.seasonId), ["Season alpha", "Season alpha"]);
});

test("cancelled season prompt leaves honest unknown season and preserves normal attack flow", () => {
    const h = setup();
    h.context.prompt = () => null;
    h.run("markUsed('C1')");
    assert.equal(events(h).length, 1);
    assert.equal(events(h)[0].seasonId, null);
    assert.equal(h.run("usedTeams.includes('C1')"), true);
});

test("only confirmed round defence counts; reconfirmation deduplicates and three rounds count three uses", () => {
    const h = setup();
    freezeDefence(h);
    assert.equal(events(h).length, 0, "freezing or saving a lineup is not deployment confirmation");
    h.run("confirmRoundDefenceUsage(); confirmRoundDefenceUsage(); render()");
    const firstCount = events(h).length;
    assert.ok(firstCount > 0);
    assert.equal(events(h).filter(event => event.side === "defence" && event.slotKey === "FRONT_TOP:0").length, 1);
    const wall = events(h).find(event => event.slotKey === "FRONT_TOP:0");
    assert.equal(wall.outcome, "deployed");
    assert.equal(wall.attribution.complete, true);
    assert.deepEqual(wall.participants.map(p => p.unitId).sort(), ["A", "B", "C", "D", "E"]);
    const fleet = events(h).find(event => event.slotKey === "BACK_TOP:0");
    assert.deepEqual(fleet.participants.find(p => p.unitId === "CAP"), { unitId: "CAP", unitType: "CAPITAL_SHIP", role: "capital" });
    assert.equal(fleet.participants.find(p => p.unitId === "S1").role, "starter");
    const unknown = events(h).find(event => event.slotKey === "FRONT_TOP:1");
    assert.ok(unknown, "unknown deployment is represented, not silently zero");
    assert.equal(unknown.attribution.complete, false);
    assert.deepEqual(unknown.participants, [], "catalogue proposal and legacy blockers are not actual membership");
    h.run("board.roundId = 'round-2'; myBoard.roundId = 'round-2'; confirmRoundDefenceUsage(); board.roundId = 'round-3'; myBoard.roundId = 'round-3'; confirmRoundDefenceUsage()");
    assert.equal(events(h).length, firstCount * 3);
    assert.equal(h.read("aggregateUsageHistory().units").find(unit => unit.unitId === "A").uses, 3);
});

test("cancelling defensive deployment confirmation writes no history", () => {
    const h = setup();
    freezeDefence(h);
    h.context.confirm = () => false;
    h.run("confirmRoundDefenceUsage()");
    assert.equal(events(h).length, 0);
});

test("explicit later defence correction replaces membership without creating another deployment", () => {
    const h = setup();
    freezeDefence(h);
    h.run("confirmRoundDefenceUsage()");
    const count = events(h).length;
    const originalId = events(h).find(event => event.slotKey === "FRONT_TOP:0").id;
    h.run(`board.defenceSnapshot.slots[0].characterIds = ["A", "B", "C", "D", "F"]; board.defenceSnapshot.slots[0].lineup.characterIds = ["A", "B", "C", "D", "F"]; syncConfirmedDefenceUsage()`);
    assert.equal(events(h).length, count);
    const updated = events(h).find(event => event.id === originalId);
    assert.deepEqual(updated.participants.map(p => p.unitId).sort(), ["A", "B", "C", "D", "F"]);
    assert.equal(h.read("aggregateUsageHistory().units").some(unit => unit.unitId === "E"), false);
});

test("correction and aggregation contract handles actual characters, fleet roles and explicit pilots equally", () => {
    const h = setup();
    h.run("markUsed('C1')");
    const attackId = events(h)[0].id;
    assert.equal(h.run(`correctUsageParticipants(${JSON.stringify(attackId)}, [{unitId:"D",unitType:"CHARACTER",role:"member"}], {complete:true,provenance:"player-correction"})`), true);
    h.run("markCounterUsedFromBoard('F1', 'BACK_TOP:0')");
    assert.equal(events(h)[1].mode, "FLEET");
    const fleetId = events(h)[1].id;
    assert.equal(h.run(`correctUsageParticipants(${JSON.stringify(fleetId)}, [{unitId:"CAP",unitType:"CAPITAL_SHIP",role:"capital"},{unitId:"S1",unitType:"SHIP",role:"starter"},{unitId:"A",unitType:"CHARACTER",role:"pilot"}], {complete:true,provenance:"player-correction"})`), true);
    freezeDefence(h);
    h.run("confirmRoundDefenceUsage()");
    const result = h.read("aggregateUsageHistory()");
    assert.equal(result.units.find(unit => unit.unitId === "D").uses, 2, "one attack and one defence have equal weight");
    assert.equal(result.units.find(unit => unit.unitId === "A").uses, 2, "explicit pilot participation is supported");
    assert.equal(result.units.find(unit => unit.unitId === "S1").uses, 2);
    assert.ok(result.unattributed.some(row => row.side === "defence"));
    assert.ok(result.teams.some(row => row.mode === "FLEET"));
});

test("future schema is preserved without clobbering it; malformed history does not break round tracking", () => {
    const future = JSON.stringify({ schema: 999, events: [{ future: "opaque" }], extra: true });
    const h = setup({ "gacUsageHistory:v1": future });
    h.run("markUsed('C1')");
    assert.equal(h.values.get("gacUsageHistory:v1"), future);
    assert.equal(h.run("usedTeams.includes('C1')"), true);
    const broken = setup({ "gacUsageHistory:v1": "{broken" });
    broken.run("markUsed('C1')");
    assert.equal(broken.run("usedTeams.includes('C1')"), true);
    assert.equal(activeEvents(broken).length, 1);
});


test("participant corrections reject duplicates and the wrong combat type without changing facts", () => {
    const h = setup();
    h.run("markUsed('C1')");
    const id = events(h)[0].id;
    const before = events(h);
    const attribution = { complete: true, provenance: "player-correction" };
    for (const participants of [
        [{ unitId: "A", unitType: "CHARACTER", role: "member" }, { unitId: "A", unitType: "CHARACTER", role: "member" }],
        [{ unitId: "S1", unitType: "SHIP", role: "starter" }],
        [{ unitId: "", unitType: "CHARACTER", role: "member" }]
    ]) {
        assert.equal(h.run(`correctUsageParticipants(${JSON.stringify(id)}, ${JSON.stringify(participants)}, ${JSON.stringify(attribution)})`), false);
        assert.deepEqual(events(h), before);
    }
});

test("valid history rows and unknown fields survive alongside quarantined malformed rows", () => {
    const h = setup();
    h.run("markUsed('C1')");
    const saved = JSON.parse(h.values.get("gacUsageHistory:v1"));
    saved.extension = { preserved: true };
    saved.events.push({ id: "bad", participants: "bad" }, saved.events[0]);
    const restored = setup({ "gacUsageHistory:v1": JSON.stringify(saved) });
    assert.equal(events(restored).length, 1);
    assert.equal(restored.run("usageHistory.rejectedEvents.length"), 2);
    restored.run("markUsed('C2')");
    const stored = JSON.parse(restored.values.get("gacUsageHistory:v1"));
    assert.deepEqual(stored.extension, { preserved: true });
    assert.equal(stored.rejectedEvents.length, 2);
    assert.equal(stored.events.length, 2);
});

test("a known board target enriches a Counters event when its outcome is recorded", () => {
    const h = setup();
    h.run("markUsed('C1')");
    const id = events(h)[0].id;
    assert.equal(events(h)[0].slotKey, null);
    h.run("markUsedAndCleared('opponent', 'FRONT_TOP', 0, 'C1')");
    assert.equal(events(h).length, 1);
    assert.equal(events(h)[0].id, id);
    assert.equal(events(h)[0].slotKey, "FRONT_TOP:0");
    h.run("undoPendingAction()");
    assert.equal(activeEvents(h).length, 1);
    assert.equal(events(h)[0].outcome, "used");
});

test("repeated Used + Cleared taps preserve the original six-second Undo contribution", () => {
    const h = setup();
    h.run("markUsedAndCleared('opponent', 'FRONT_TOP', 0, 'C1'); markUsedAndCleared('opponent', 'FRONT_TOP', 0, 'C1')");
    assert.equal(activeEvents(h).length, 1);
    h.run("undoPendingAction()");
    assert.equal(activeEvents(h).length, 0);
    assert.equal(h.run("usedTeams.includes('C1')"), false);
    assert.equal(h.run("board.teams[0].cleared"), false);
});

test("persisted wrong combat-type membership is quarantined rather than aggregated", () => {
    const h = setup();
    h.run("markUsed('C1')");
    const saved = JSON.parse(h.values.get("gacUsageHistory:v1"));
    saved.events[0].participants = [{ unitId: "S1", unitType: "SHIP", role: "starter" }];
    saved.events[0].attribution = { complete: true, provenance: "player-correction" };
    const restored = harness({ "gacUsageHistory:v1": JSON.stringify(saved) });
    assert.equal(events(restored).length, 0);
    assert.equal(restored.run("usageHistory.rejectedEvents.length"), 1);
    assert.deepEqual(restored.read("aggregateUsageHistory().units"), []);
});

test("Counters usage records the selected battle mode separately from the active round mode", () => {
    const h = setup();
    h.run("currentMode = '3v3'; markUsed('C1')");
    assert.equal(events(h)[0].mode, "3v3");
    assert.equal(events(h)[0].roundMode, "5v5");
    h.run("currentMode = 'FLEET'; markUsed('F1')");
    assert.equal(events(h)[1].mode, "FLEET");
    assert.equal(events(h)[1].roundMode, "5v5");
});

test("applying a saved lineup to the active round amends its confirmed usage event", () => {
    const h = setup();
    freezeDefence(h);
    h.run(`
        confirmRoundDefenceUsage();
        persistDefenceTemplate({
            schema: 2, mode: "5v5", league: "KYBER", territories: board.territories,
            teams: [{ territory: "FRONT_TOP", index: 0, name: "Wall", customName: "", lineup: {
                characterIds: ["A", "B", "C", "D"], intentionalUndersize: true, confirmed: true
            } }]
        });
    `);
    const count = events(h).length;
    const wallId = events(h).find(event => event.slotKey === "FRONT_TOP:0").id;
    assert.equal(h.run("applySavedLineupToRound('5v5', 'FRONT_TOP', 0)"), true);
    assert.equal(events(h).length, count);
    assert.deepEqual(events(h).find(event => event.id === wallId).participants.map(p => p.unitId), ["A", "B", "C", "D"]);
    assert.equal(h.read("aggregateUsageHistory().units").some(unit => unit.unitId === "E"), false);
});

test("Undo of an outcome correction preserves a subsequently corrected actual lineup", () => {
    const h = setup();
    h.run("markUsed('C1'); markUsedAndCleared('opponent', 'FRONT_TOP', 0, 'C1')");
    h.run(`correctUsageParticipants(usageHistory.events[0].id,
        [{unitId:'A',unitType:'CHARACTER',role:'member'}], {complete:true,provenance:'player-correction'});
        undoPendingAction()`);
    assert.equal(events(h)[0].outcome, "used");
    assert.deepEqual(events(h)[0].participants.map(p => p.unitId), ["A"]);
});

test("explicitly selecting a season resolves current unknown events without assigning old rounds", () => {
    const h = setup();
    h.context.prompt = () => null;
    h.run("markUsed('C1'); board.roundId='round-2'; usedTeams=[]; markUsed('C1')");
    h.context.prompt = () => "GAC 101";
    h.run("chooseUsageSeason()");
    assert.deepEqual(events(h).map(e => e.seasonId), [null, "GAC 101"]);
});

test("a defensive deployment is saved atomically and a quota failure leaves battle tracking usable", () => {
    const h = setup();
    freezeDefence(h);
    // Preselect the season, isolating the single defensive event-batch write.
    h.run("usageHistory.selectedSeasonId='GAC 100'; usageHistory.roundSeasons[board.roundId]='GAC 100'");
    const snapshots = [];
    const originalSet = h.context.localStorage.setItem;
    h.context.localStorage.setItem = (key, value) => {
        if (key === "gacUsageHistory:v1") snapshots.push(JSON.parse(value));
        originalSet(key, value);
    };
    h.run("confirmRoundDefenceUsage()");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].events.length, 3);
    h.context.localStorage.setItem = (key, value) => {
        if (key === "gacUsageHistory:v1") throw new Error("quota");
        originalSet(key, value);
    };
    h.run("markUsed('C1')");
    assert.equal(h.run("usedTeams.includes('C1')"), true);
    assert.match(h.run("usageHistoryMessage"), /could not be saved/);
});

test("an entirely missing round defence cannot be confirmed as actual deployment", () => {
    const h = setup();
    h.run("board.defenceSnapshot=captureDefenceSnapshot(board.mode,myBoard,null)");
    assert.equal(h.run("confirmRoundDefenceUsage()"), false);
    assert.equal(events(h).length, 0);
});
