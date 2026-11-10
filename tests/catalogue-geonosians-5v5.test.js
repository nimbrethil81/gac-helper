const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

// Regression pins for CR-2026-11-10-169-P01 (issue #169): the owner-approved
// non-provisional Traya S/62 and Darth Vader A/61 counters against the exact
// 5v5 Geonosians defence, appended after the existing Jawas, Veers and Bossk
// rows. They check the compiled catalogue and that Round Mode honours roster
// and used-team availability for the new identities.

const payload = compileSource(readSource(path.join(__dirname, "..", "catalogue", "source")).source);
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const strip = rows => rows.map(({ counterId, tier, bannerScore, undersize }) => ({ counterId, tier, bannerScore, undersize }));

function harness() {
    const values = new Map();
    const context = {
        __GAC_HELPER_TEST__: true,
        console, setTimeout, clearTimeout,
        confirm: () => true, alert: () => {}, navigator: {},
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: { getElementById: () => ({ innerHTML: "" }), querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(appSource, context, { filename: "app.js" });
    return { run: expression => vm.runInContext(expression, context) };
}

function planFor(defence, ownedCharacters, usedTeams) {
    const h = harness();
    const config = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
    h.run(`
        gacData = ${JSON.stringify(payload.counters)};
        counterDefinitions = ${JSON.stringify(payload.counterDefinitions)};
        characterDefinitions = ${JSON.stringify(payload.characterDefinitions)};
        defenceTeams = ${JSON.stringify(payload.defenceTeams)};
        defenceCompositions = ${JSON.stringify(payload.defenceCompositions)};
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(config)}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = ${JSON.stringify(defence)};
        ownedCharacters = ${JSON.stringify(ownedCharacters)};
        usedTeams = ${JSON.stringify(usedTeams)};
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return h.run(`(roundPlan.assign["FRONT_BOTTOM:0"] || {}).counterId || null`);
}

test("#169 5v5 Geonosians keeps its three existing B-tier answers and adds owner-approved Traya S/62 and Vader A/61", () => {
    const rows = payload.counters["5v5"]["Geonosians"];
    assert.equal(rows.length, 5);
    assert.deepEqual(strip(rows), [
        { counterId: "JAWAS", tier: "B", bannerScore: 60, undersize: 0 },
        { counterId: "VEERS", tier: "B", bannerScore: 61, undersize: 0 },
        { counterId: "BOSSK", tier: "B", bannerScore: 61, undersize: 0 },
        { counterId: "TRAYA", tier: "S", bannerScore: 62, undersize: 0 },
        { counterId: "VADER", tier: "A", bannerScore: 61, undersize: 0 }
    ]);
    for (const row of rows.slice(-2)) {
        assert.equal(row.confidence, undefined, "non-provisional: no provisional metadata");
        assert.equal(row.role, undefined, "full-size scored row: no tactical role");
        assert.match(row.notes, /Owner confirms historical 5v5 success/);
        assert.match(row.notes, /not a measured banner average/);
        assert.match(row.notes, /current-season repeatability unverified/);
    }
    assert.match(rows[3].notes, /Traya and Nihilus/);
    assert.match(rows[3].notes, /Sion as an optional support/);
    assert.match(rows[4].notes, /Merciless Massacre/);
    assert.deepEqual(payload.counterDefinitions.TRAYA.required, ["DARTH_TRAYA", "DARTH_NIHILUS"]);
    const vader = payload.counterDefinitions.VADER;
    assert.equal(vader.name, "Darth Vader");
    assert.deepEqual(vader.required, ["DARTH_VADER"]);
    assert.deepEqual(vader.recommended, []);
    assert.equal(vader.strategicReserve, undefined);
    assert.equal(payload.characterDefinitions.DARTH_VADER.externalId, "VADER", "roster-mapped to original Darth Vader");
});

test("#169 Round: the new options are full-size, spend their own required characters and never double-allocate", () => {
    assert.equal(planFor("Geonosians", ["DARTH_TRAYA", "DARTH_NIHILUS", "DARTH_VADER"], []), "TRAYA",
        "S tier stays ahead of the A-tier Vader estimate");
    assert.equal(planFor("Geonosians", ["DARTH_VADER"], []), "VADER",
        "VADER is roster-matched to original Darth Vader");
    assert.equal(planFor("Geonosians", ["LORD_VADER"], []), null,
        "Counter VADER must not roster-match Lord Vader");
    assert.equal(planFor("Geonosians", ["DARTH_TRAYA"], []), null,
        "TRAYA needs its complete global required core");
    assert.equal(planFor("Geonosians", ["DARTH_TRAYA", "DARTH_NIHILUS", "DARTH_VADER"], ["TRAYA"]), "VADER",
        "Spending Traya does not block Vader (no shared required character)");
    assert.equal(planFor("Geonosians", ["DARTH_TRAYA", "DARTH_NIHILUS", "DARTH_VADER"], ["VADER"]), "TRAYA",
        "Spending Vader does not block Traya; the plan must not double-allocate a used team's characters");
    assert.equal(planFor("Geonosians", ["DARTH_TRAYA", "DARTH_NIHILUS"], ["DARTH_NIHILUS"]), null,
        "Spending DARTH_NIHILUS on Counters blocks TRAYA through the shared required core");
});
