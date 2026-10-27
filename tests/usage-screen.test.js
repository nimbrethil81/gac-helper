const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function harness(initialStorage = {}) {
    const values = new Map(Object.entries(initialStorage));
    const app = { innerHTML: "" };
    const context = {
        __GAC_HELPER_TEST__: true, console, setTimeout: () => 1, clearTimeout: () => {},
        confirm: () => true, prompt: () => "S5", alert: () => {}, navigator: {},
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
        document: { getElementById: id => id === "app" ? app : null, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    const read = code => JSON.parse(run(`JSON.stringify(${code})`));
    run(`characterDefinitions={
        A:{name:'Alpha',unitType:'CHARACTER'}, B:{name:'Beta',unitType:'CHARACTER'},
        S1:{name:'Starter',unitType:'SHIP'}, S2:{name:'Other starter',unitType:'SHIP'}, S3:{name:'Third starter',unitType:'SHIP'},
        CAP:{name:'Capital',unitType:'CAPITAL_SHIP'}
    }`);
    return { values, app, context, run, read };
}

function event(roundId, side = "attack", seasonId = "S4", options = {}) {
    const identity = side === "attack" ? "C1" : "Saved defence";
    const slotKey = side === "defence" ? "FRONT_TOP:0" : null;
    return {
        id: JSON.stringify([roundId, side, side === "attack" ? "C1" : slotKey]), roundId, seasonId,
        mode: "5v5", side, source: side === "attack" ? "counters" : "round-defence-confirmation",
        counterId: side === "attack" ? "C1" : null, slotKey, identity,
        participants: [{ unitId: "A", unitType: "CHARACTER", role: "member" }],
        attribution: { complete: true, provenance: "player-correction" }, outcome: side === "attack" ? "won" : "deployed",
        voided: false, revision: 1, createdAt: "2026-10-27T12:00:00.000Z", updatedAt: "2026-10-27T12:00:00.000Z", ...options
    };
}

function seed(h, events, extra = {}) {
    const roundSeasons = Object.fromEntries(events.map(e => [e.roundId, e.seasonId]));
    h.run(`usageHistory={schema:1,selectedSeasonId:'S4',roundSeasons:${JSON.stringify(roundSeasons)},defenceRounds:${JSON.stringify(events.filter(e => e.side === "defence").map(e => e.roundId))},events:${JSON.stringify(events)},completedSeasonIds:['S1','S2','S3'],attackFleetLineups:{},...${JSON.stringify(extra)}}`);
}

function backup(history) { return JSON.stringify({ format: "gac-usage-history", schema: 1, history }); }

test("More → Usage is reachable without a round, preserves More navigation and shows all periods/categories", () => {
    const h = harness();
    h.run("setView('more')");
    assert.match(h.app.innerHTML, /setView\('usage'\)/);
    h.run("setView('usage')");
    assert.match(h.app.innerHTML, /Back to More/);
    assert.match(h.app.innerHTML, /Characters/);
    assert.match(h.app.innerHTML, /Ships/);
    assert.match(h.app.innerHTML, /Fleets/);
    assert.match(h.app.innerHTML, /Current season/);
    assert.match(h.app.innerHTML, /Last three completed seasons/);
    assert.match(h.app.innerHTML, /All recorded time/);
    assert.match(h.app.innerHTML, /No usage recorded yet/);
    const nav = h.app.innerHTML.match(/<nav class="bottom-nav">([\s\S]*?)<\/nav>/)[1];
    assert.match(nav, /nav-button active" onclick="setView\('more'\)/);
    assert.equal(h.run("board"), null);
});

test("rankings weight attack and defence equally, keep offensive outcomes separate and use shared tie ranks", () => {
    const h = harness();
    const attack = event("r1");
    const defence = event("r2", "defence");
    const lost = event("r3", "attack", "S4", { outcome: "lost", participants: [{ unitId: "B", unitType: "CHARACTER", role: "member" }] });
    const used = event("r4", "attack", "S4", { outcome: "used", participants: [{ unitId: "B", unitType: "CHARACTER", role: "member" }] });
    seed(h, [attack, defence, lost, used]);
    const rows = h.read("usageRankings('characters')");
    assert.deepEqual(rows.map(r => [r.id, r.rank, r.total, r.attack, r.defence, r.wins, r.losses]), [
        ["A", 1, 2, 1, 1, 1, 0], ["B", 1, 2, 2, 0, 0, 1]
    ]);
    h.run("characterDefinitions.A.name='Zeta'");
    assert.equal(h.read("usageRankings('characters')")[1].id, "A", "renaming changes label order but keeps canonical identity");
});

test("season periods use explicit completion order, exclude current and leave unknown seasons only in all time", () => {
    const h = harness();
    seed(h, [event("a", "attack", "S1"), event("b", "attack", "S2"), event("c", "attack", "S3"), event("d", "attack", "S4"), event("e", "attack", "S5"), event("f", "attack", null)], {
        selectedSeasonId: "S5", completedSeasonIds: ["S1", "S3", "S2", "S4", "S5"]
    });
    assert.deepEqual(h.read("usagePeriodEvents('current').map(e=>e.seasonId)"), ["S5"]);
    assert.deepEqual(h.read("usagePeriodEvents('completed').map(e=>e.seasonId)"), ["S2", "S3", "S4"]);
    assert.equal(h.read("usagePeriodEvents('all')").length, 6);
    h.run("usagePeriod='completed';setView('usage')");
    assert.match(h.app.innerHTML, /S3, S2, S4/);
    assert.match(h.app.innerHTML, /unknown season/);
});

test("completing a season is explicit, persists chronology and does not reassign existing round history", () => {
    const h = harness(); seed(h, [event("r1")]);
    assert.equal(h.run("completeUsageSeason('S5')"), true);
    assert.equal(h.run("usageHistory.selectedSeasonId"), "S5");
    assert.deepEqual(h.read("usageHistory.completedSeasonIds"), ["S1", "S2", "S3", "S4"]);
    assert.equal(h.run("usageHistory.events[0].seasonId"), "S4");
    assert.equal(h.run("completeUsageSeason('S3')"), false);
    assert.equal(h.run("completeUsageSeason('')"), false);
});

test("fleet rankings group by recorded capital, separate hulls and credit an explicit pilot once", () => {
    const h = harness();
    const fleet = event("fleet", "attack", "S4", { mode: "FLEET", capitalShipId: "CAP", participants: [
        { unitId: "CAP", unitType: "CAPITAL_SHIP", role: "capital" },
        { unitId: "S1", unitType: "SHIP", role: "starter" },
        { unitId: "A", unitType: "CHARACTER", role: "pilot" }
    ], benchShips: ["S2"], attribution: { complete: false, pilotsComplete: false, provenance: "actual-fleet" } });
    const unknown = event("unknown", "attack", "S4", { mode: "FLEET", participants: [], attribution: { complete: false, provenance: "unknown" } });
    seed(h, [fleet, unknown]);
    assert.deepEqual(h.read("usageRankings('fleets').map(r=>[r.id,r.total])"), [["CAP", 1]]);
    assert.deepEqual(h.read("usageRankings('ships').map(r=>[r.id,r.total])"), [["S1", 1]]);
    assert.deepEqual(h.read("usageRankings('characters').map(r=>[r.id,r.total])"), [["A", 1]]);
    h.run("setView('usage')");
    assert.match(h.app.innerHTML, /Missing units are unknown, not zero/);
    assert.match(h.app.innerHTML, /fleet identity is unknown/);
});

test("voided events do not rank and missing current catalogue units remain visible by canonical ID", () => {
    const h = harness();
    seed(h, [event("r1", "attack", "S4", { participants: [{ unitId: "OLD_UNIT", unitType: "CHARACTER", role: "member" }] }), event("r2", "attack", "S4", { voided: true })]);
    h.run("setView('usage')");
    assert.deepEqual(h.read("usageRankings().map(r=>r.id)"), ["OLD_UNIT"]);
    assert.match(h.app.innerHTML, /Saved unit; not in current catalogue/);
});

test("export/import round trip survives a fresh device, removed catalogue units and repeat imports without duplication", () => {
    const h = harness();
    const old = event("old", "attack", "S4", { participants: [{ unitId: "OLD_UNIT", unitType: "CHARACTER", role: "member" }], futureField: { version: 1 } });
    seed(h, [old, event("def", "defence")], { selectedSeasonId: "S4", attackFleetLineups: { F1: { schema: 1, capitalShipId: "CAP", startingShipIds: ["S1", "S2", "S3"], reinforcementIds: [] } } });
    h.run("usageHistory.allyCode='123456789';usageHistory.events[0].allyCode='123456789'");
    const exported = h.run("usageBackupPayload()");
    assert.doesNotMatch(exported, /123456789|allyCode/);
    const fresh = harness();
    assert.equal(fresh.run(`importUsageHistory(${JSON.stringify(exported)}).ok`), true);
    assert.equal(fresh.read("usageHistory.events").length, 2);
    assert.equal(fresh.run("usageHistory.events[0].futureField.version"), 1);
    assert.deepEqual(fresh.read("usageHistory.attackFleetLineups.F1.startingShipIds"), ["S1", "S2", "S3"]);
    assert.equal(fresh.run(`importUsageHistory(${JSON.stringify(exported)}).added`), 0);
    assert.equal(fresh.read("usageHistory.events").length, 2);
});

test("invalid JSON, versions, duplicate IDs and divergent existing facts reject atomically", () => {
    const h = harness(); seed(h, [event("r1")]);
    const before = h.run("JSON.stringify(usageHistory)");
    const original = h.read("usageHistory");
    const invalid = ["{", JSON.stringify({ format: "gac-usage-history", schema: 2, history: original }), backup({ ...original, events: [original.events[0], original.events[0]] }), backup({ ...original, events: [{ ...original.events[0], outcome: "lost", revision: 2 }] }), backup({ ...original, events: [{ ...original.events[0], id: "invented-id" }] })];
    invalid.forEach(raw => {
        assert.equal(h.run(`importUsageHistory(${JSON.stringify(raw)}).ok`), false);
        assert.equal(h.run("JSON.stringify(usageHistory)"), before);
    });
});

test("import rejects current unit-type mismatches, round season conflicts and ambiguous completion chronology", () => {
    const h = harness();
    seed(h, [event("r1")]);
    const original = h.read("usageHistory");
    const badType = { ...event("r2"), participants: [{ unitId: "S1", unitType: "CHARACTER", role: "member" }] };
    const cases = [
        { ...original, events: [badType], roundSeasons: { r2: "S4" } },
        { ...original, events: [], roundSeasons: { r1: "S3" } },
        { ...original, events: [], completedSeasonIds: ["OTHER"] }
    ];
    cases.forEach(history => assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(history))}).ok`), false));
});

test("import merges compatible explicit completion orders and rejects contradictory order", () => {
    const h = harness(); seed(h, [], { completedSeasonIds: ["S2", "S3"] });
    const incoming = h.read("usageHistory"); incoming.completedSeasonIds = ["S1", "S2"];
    assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(incoming))}).ok`), true);
    assert.deepEqual(h.read("usageHistory.completedSeasonIds"), ["S1", "S2", "S3"]);
    incoming.completedSeasonIds = ["S3", "S1"];
    assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(incoming))}).ok`), false);
});

test("quota errors while importing or completing a season preserve the original in-memory and persisted history", () => {
    const h = harness(); seed(h, [event("r1")]);
    h.run("saveUsageHistory()");
    const beforeMemory = h.run("JSON.stringify(usageHistory)");
    const beforeDisk = h.values.get("gacUsageHistory:v1");
    const incoming = h.read("usageHistory"); incoming.events.push(event("r2")); incoming.roundSeasons.r2 = "S4";
    h.context.localStorage.setItem = () => { throw new Error("quota"); };
    assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(incoming))}).ok`), false);
    assert.equal(h.run("completeUsageSeason('S5')"), false);
    assert.equal(h.run("JSON.stringify(usageHistory)"), beforeMemory);
    assert.equal(h.values.get("gacUsageHistory:v1"), beforeDisk);
});

test("fleet backup rejects benched participants, conflicting capitals and defensive events without slot identity", () => {
    const h = harness();
    const fleet = event("fleet", "attack", "S4", { mode: "FLEET", capitalShipId: "CAP", participants: [
        { unitId: "CAP", unitType: "CAPITAL_SHIP", role: "capital" }, { unitId: "S1", unitType: "SHIP", role: "starter" }
    ], benchShips: ["S2"] });
    seed(h, []);
    const history = h.read("usageHistory");
    const badCases = [
        { ...fleet, benchShips: ["S1"] },
        { ...fleet, capitalShipId: "OTHER_CAP" },
        { ...fleet, participants: [...fleet.participants, { unitId: "OTHER_CAP", unitType: "CAPITAL_SHIP", role: "capital" }] },
        { ...event("def", "defence"), id: JSON.stringify(["def", "defence", null]), slotKey: null }
    ];
    badCases.forEach(bad => {
        const payload = { ...history, events: [bad], roundSeasons: { [bad.roundId]: "S4" }, defenceRounds: bad.side === "defence" ? [bad.roundId] : [] };
        assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(payload))}).ok`), false);
    });
});

test("saved attacking fleet extensions load before catalogue initialisation and retain unknown canonical historical IDs", () => {
    const stored = { schema: 1, selectedSeasonId: "S4", completedSeasonIds: ["S1", "S2", "S3"], roundSeasons: {}, defenceRounds: [], events: [],
        attackFleetLineups: { F1: { schema: 1, capitalShipId: "OLD_CAP", startingShipIds: ["OLD_S1", "OLD_S2", "OLD_S3"], reinforcementIds: [] } } };
    const h = harness({ "gacUsageHistory:v1": JSON.stringify(stored) });
    assert.equal(h.run("usageHistoryWritable"), true);
    assert.equal(h.run("usageHistory.attackFleetLineups.F1.capitalShipId"), "OLD_CAP");
    assert.equal(h.run("usageHistoryMessage"), "");
});

test("import rejects current/completed season contradictions instead of choosing a chronology", () => {
    const h = harness(); seed(h, [], { selectedSeasonId: "S4", completedSeasonIds: ["S1", "S2", "S3"] });
    const before = h.run("JSON.stringify(usageHistory)");
    const inconsistent = h.read("usageHistory"); inconsistent.completedSeasonIds.push("S4");
    assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(inconsistent))}).ok`), false);
    const newerDevice = { ...inconsistent, selectedSeasonId: "S5" };
    assert.equal(h.run(`importUsageHistory(${JSON.stringify(backup(newerDevice))}).ok`), false);
    assert.equal(h.run("JSON.stringify(usageHistory)"), before);
});
