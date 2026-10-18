const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { auditSource, compileSource, importFromPayload, readSource } = require("../scripts/catalogue-source-lib.js");
const { auditPayload } = require("../scripts/catalogue-audit-lib.js");

// Tactical matchup entries (issues #112/#115): a SETUP or CLEANUP step of a
// multi-battle plan carries a role and notes but no tier, banner score or
// undersize. The release gate keeps them honest, the compiler serves them as
// {counterId, counter, role, notes}, and the app shows them only in the
// Counters screen's Multi-battle options section; Round allocation, Next Up and
// the Last Battle advisor never treat them as one-shot coverage.

const SOURCE_DIR = path.join(__dirname, "..", "catalogue", "source");
const committed = readSource(SOURCE_DIR).source;
const payload = compileSource(committed);
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const ONE_SHOT = [
    { counterId: "JABBA", tier: "B", bannerScore: 62, undersize: 0 },
    { counterId: "SATELE_SHAN", tier: "S", bannerScore: 62, undersize: 0 },
    { counterId: "SEE", tier: "A", bannerScore: 62, undersize: 0 },
    { counterId: "JMK", tier: "B", bannerScore: 60, undersize: 0 },
    { counterId: "SEE_BANE", tier: "S", bannerScore: 62, undersize: 0 },
    { counterId: "THE_STRANGER", tier: "A", bannerScore: 62, undersize: 0 }
];

function withStrangerCounters(mutate) {
    const source = structuredClone(committed);
    const row = source["matchups/5v5.json"].find(d => d.defence === "The Stranger");
    mutate(row.counters);
    return auditSource(source);
}

const codes = report => report.findings.map(f => f.code);

test("5v5 The Stranger keeps its six one-shot rows and adds Reva (setup) then Great Mothers (cleanup)", () => {
    const rows = payload.counters["5v5"]["The Stranger"];
    assert.deepEqual(rows.slice(0, 6).map(({ counterId, tier, bannerScore, undersize }) => ({ counterId, tier, bannerScore, undersize })), ONE_SHOT);
    assert.deepEqual(rows.slice(6).map(r => Object.keys(r).sort()), [["counter", "counterId", "notes", "role"], ["counter", "counterId", "notes", "role"]]);
    assert.deepEqual(rows.slice(6).map(r => [r.counterId, r.counter, r.role]), [["REVA", "Reva", "SETUP"], ["GREAT_MOTHERS", "Great Mothers", "CLEANUP"]]);
    assert.match(rows[6].notes, /not expected to win/);
    assert.match(rows[7].notes, /not a fresh-team counter/);
    assert.ok(!payload.counters["3v3"]["The Stranger"].some(r => r.role), "3v3 is unchanged");
    assert.equal(auditSource(committed).summary.releaseGate, "PASS");
});

test("the release gate rejects a scored, unknown-role or unexplained tactical entry", () => {
    // From source, a scored tactical row is refused by the source schema; the
    // shared rule set refuses the same thing in a served payload.
    assert.ok(codes(withStrangerCounters(c => { c[6].tier = "B"; })).includes("SOURCE_SCHEMA"));
    const scored = structuredClone(payload);
    Object.assign(scored.counters["5v5"]["The Stranger"][6], { tier: "B", bannerScore: 55, undersize: 0 });
    const scoredReport = auditPayload(scored);
    assert.ok(codes(scoredReport).includes("MATCHUP_ROLE_SCORED"));
    assert.equal(scoredReport.summary.releaseGate, "FAIL");
    assert.ok(codes(withStrangerCounters(c => { c[6].role = "WEAKEN"; })).includes("MATCHUP_ROLE_INVALID"));
    assert.ok(codes(withStrangerCounters(c => { c[7].notes = " "; })).includes("MATCHUP_ROLE_NOTES_BLANK"));
    assert.ok(codes(withStrangerCounters(c => { c[6].undersize = 1; })).includes("SOURCE_SCHEMA"), "the source schema has no undersize on a tactical row");
    for (const mutate of [c => { c[6].tier = "B"; }, c => { c[6].role = "WEAKEN"; }]) {
        assert.equal(withStrangerCounters(mutate).summary.releaseGate, "FAIL");
    }
    const cleanupOnly = withStrangerCounters(c => { c.splice(6, 1); });
    assert.ok(codes(cleanupOnly).includes("MATCHUP_CLEANUP_WITHOUT_SETUP"));
    assert.equal(cleanupOnly.summary.releaseGate, "PASS", "a missing setup step is a warning, not a blocker");
});

test("importing the compiled payload reproduces the tactical source rows", () => {
    const rows = importFromPayload(payload)["matchups/5v5.json"].find(d => d.defence === "The Stranger").counters;
    const original = committed["matchups/5v5.json"].find(d => d.defence === "The Stranger").counters;
    assert.deepEqual(rows, original);
});

function harness() {
    const values = new Map();
    const elements = {
        app: { innerHTML: "" },
        results: { innerHTML: "" },
        teamSelect: { options: [{}], value: "The Stranger" }
    };
    const context = {
        __GAC_HELPER_TEST__: true,
        console, setTimeout, clearTimeout,
        confirm: () => true, alert: () => {}, navigator: {},
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: { getElementById: id => elements[id] || null, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(appSource, context, { filename: "app.js" });
    const h = { run: expression => vm.runInContext(expression, context), elements };
    h.run(`
        gacData = ${JSON.stringify(payload.counters)};
        counterDefinitions = ${JSON.stringify(payload.counterDefinitions)};
        characterDefinitions = ${JSON.stringify(payload.characterDefinitions)};
        defenceTeams = ${JSON.stringify(payload.defenceTeams)};
        defenceCompositions = ${JSON.stringify(payload.defenceCompositions)};
        currentMode = "5v5";
    `);
    return h;
}

const REVA_AND_GM = ["THIRD_SISTER", "GRAND_INQUISITOR", "SEVENTH_SISTER", "GREAT_MOTHERS"];

function strangerPlan(h, owned, used) {
    const config = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "The Stranger";
        ownedCharacters = ${JSON.stringify(owned)};
        usedTeams = ${JSON.stringify(used)};
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return {
        chosen: h.run(`(roundPlan.assign["FRONT_BOTTOM:0"] || {}).counterId || null`),
        reason: h.run(`roundPlan.reasons["FRONT_BOTTOM:0"].reason`)
    };
}

test("Round Mode never assigns a setup or cleanup step as one-shot coverage", () => {
    const h = harness();
    const onlyTactics = strangerPlan(h, REVA_AND_GM, []);
    assert.equal(onlyTactics.chosen, null);
    assert.match(onlyTactics.reason, /^You don't own a counter for this team\. Multi-battle options you can field are listed in Counters\.$/);

    const withSee = strangerPlan(h, [...REVA_AND_GM, "SITH_ETERNAL_EMPEROR"], []);
    assert.equal(withSee.chosen, "SEE", "one-shot allocation is unchanged");

    // Reva elsewhere is still an ordinary one-shot counter (5v5 Satele Shan lists REVA S / 62).
    h.run(`
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Satele Shan";
        ownedCharacters = ${JSON.stringify(REVA_AND_GM)};
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run(`roundPlan.assign["FRONT_BOTTOM:0"].counterId`), "REVA");
});

test("the Last Battle advisor is handed only one-shot counters", () => {
    const h = harness();
    strangerPlan(h, REVA_AND_GM, []);
    const ids = h.run(`
        board.teams.forEach(t => { if (t.name !== "The Stranger") t.cleared = true; });
        let seen = null;
        lastBattleAdvice = input => { seen = input.counters; return { status: "captured" }; };
        currentLastBattleAdvice();
        JSON.stringify(seen.map(c => c.counterId))
    `);
    assert.deepEqual(JSON.parse(ids), ONE_SHOT.map(c => c.counterId));
});

test("Counters shows setup and cleanup in a separate section with no tier or banners, and Mark Used tracks them", () => {
    const h = harness();
    h.run(`ownedCharacters = ${JSON.stringify(REVA_AND_GM)}; usedTeams = []; counterFilter = "all"; showCounters();`);
    const html = h.elements.results.innerHTML;
    const [oneShot, tactics] = html.split("Multi-battle options");
    assert.ok(tactics, "the section is rendered");
    assert.ok(!/Reva|Great Mothers/.test(oneShot), "neither step is listed among one-shot counters");
    assert.ok(tactics.indexOf("Reva") < tactics.indexOf("Great Mothers"), "setup reads before cleanup");
    assert.match(tactics, />Setup</);
    assert.match(tactics, />Cleanup</);
    assert.doesNotMatch(tactics, /Expected Banners|Undersize|undefined/);
    assert.match(tactics, /not expected to win/);

    h.run(`counterFilter = "available"; markUsed("REVA");`);
    const afterUse = h.elements.results.innerHTML;
    assert.equal(h.run(`getCounterStatus("REVA")`), "used");
    assert.ok(!afterUse.includes(`<div class="team-name">Reva</div>`), "a used setup team drops out of the Available filter");
    assert.ok(afterUse.includes(`<div class="team-name">Great Mothers</div>`));
    assert.match(afterUse, /You don't own any counters for this team/, "one-shot empty state still reads as before");
});
