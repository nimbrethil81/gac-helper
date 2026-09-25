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
        __GAC_HELPER_TEST__: true,
        console,
        setTimeout,
        clearTimeout,
        confirm: () => true,
        alert: message => alerts.push(message),
        navigator: {},
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: {
            getElementById: id => id === "app" ? appElement : null,
            querySelectorAll: () => [],
            querySelector: () => null
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return {
        values,
        alerts,
        appElement,
        run: expression => vm.runInContext(expression, context)
    };
}

function basicConfig() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}

// Builds a one-team opponent board with a single recommendation-eligible
// candidate C1 in the given mode, wired up exactly like round-format.test.js's
// "round allocation reads the round's own format" scenario, and returns the
// rendered recommendation card HTML for that team.
function renderCardHtml(h, { mode, counterDef, ownedCharacters, characterDefinitions }) {
    h.run(`
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Enemy Team";
        gacData = { "${mode}": { "Enemy Team": [{ counterId: "C1", counter: "My Counter", tier: "S", bannerScore: 50, undersize: 0 }] } };
        counterDefinitions = { C1: ${JSON.stringify(counterDef)} };
        characterDefinitions = ${JSON.stringify(characterDefinitions || {})};
        ownedCharacters = ${JSON.stringify(ownedCharacters || [])};
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    return h.run(`
        renderTeamRecommendation(
            "opponent", "FRONT_BOTTOM",
            board.teams.find(t => t.territory === "FRONT_BOTTOM"),
            "${mode}"
        )
    `);
}

// ── 1. Counter with no composition data ────────────────────────────────────

test("a counter with no composition data shows no expand affordance and no empty panel", () => {
    const h = harness();
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: [], recommended: [] }
    });
    assert.doesNotMatch(html, /board-rec-disclosure/);
    assert.doesNotMatch(html, /Suggested squad/);
    assert.doesNotMatch(html, /board-rec-squad/);
});

// ── 2. 3v3 with one required member ─────────────────────────────────────────

test("3v3 with one required member shows the character and +2 flex when expanded", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: ["DARTH_NIHILUS"], recommended: [] },
        characterDefinitions: { DARTH_NIHILUS: { name: "Darth Nihilus" } },
        ownedCharacters: ["DARTH_NIHILUS"]
    });
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /Darth Nihilus/);
    assert.match(html, /\+ 2 flex/);
});

// ── 3. 3v3 with two required members ────────────────────────────────────────

test("3v3 with two required members shows both and +1 flex", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: ["DARTH_NIHILUS", "DARTH_TRAYA"], recommended: [] },
        characterDefinitions: {
            DARTH_NIHILUS: { name: "Darth Nihilus" },
            DARTH_TRAYA: { name: "Darth Traya" }
        },
        ownedCharacters: ["DARTH_NIHILUS", "DARTH_TRAYA"]
    });
    assert.match(html, /Darth Nihilus/);
    assert.match(html, /Darth Traya/);
    assert.match(html, /\+ 1 flex/);
});

// ── 4. 3v3 with three explicit members ──────────────────────────────────────

test("3v3 with three explicit members shows all three and no flex row", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: ["A", "B", "C"], recommended: [] },
        characterDefinitions: {
            A: { name: "Alpha" }, B: { name: "Bravo" }, C: { name: "Charlie" }
        },
        ownedCharacters: ["A", "B", "C"]
    });
    assert.match(html, /Alpha/);
    assert.match(html, /Bravo/);
    assert.match(html, /Charlie/);
    assert.doesNotMatch(html, /flex/);
});

// ── 5. Required + recommended ───────────────────────────────────────────────

test("a recommended member is visibly distinguished and still counts toward flex", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: ["A"], recommended: ["B"] },
        characterDefinitions: { A: { name: "Alpha" }, B: { name: "Bravo" } },
        ownedCharacters: ["A", "B"]
    });
    assert.match(html, /Alpha/);
    assert.match(html, /squad-member-recommended/);
    assert.match(html, /Bravo/);
    assert.match(html, /Recommended/);
    assert.match(html, /\+ 1 flex/);   // 1 required + 1 recommended = 2 explicit, 3v3 battle size 3
});

// ── 6. 5v5 flex calculation ──────────────────────────────────────────────────

test("5v5 flex calculation reflects the larger battle size", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    const html = renderCardHtml(h, {
        mode: "5v5",
        counterDef: { name: "My Counter", required: ["A", "B"], recommended: [] },
        characterDefinitions: { A: { name: "Alpha" }, B: { name: "Bravo" } },
        ownedCharacters: ["A", "B"]
    });
    assert.match(html, /\+ 3 flex/);
});

// ── 7. Malformed overspecified composition ──────────────────────────────────

test("overspecified composition data shows every entry, never a negative flex, and does not crash", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    let html;
    assert.doesNotThrow(() => {
        html = renderCardHtml(h, {
            mode: "3v3",
            counterDef: { name: "My Counter", required: ["A", "B"], recommended: ["C", "D"] },
            characterDefinitions: {
                A: { name: "Alpha" }, B: { name: "Bravo" },
                C: { name: "Charlie" }, D: { name: "Delta" }
            },
            ownedCharacters: ["A", "B", "C", "D"]
        });
    });
    assert.match(html, /Alpha/);
    assert.match(html, /Bravo/);
    assert.match(html, /Charlie/);
    assert.match(html, /Delta/);
    assert.doesNotMatch(html, /flex/);
    assert.doesNotMatch(html, /-\d+ flex/);
});

// ── 8. Card starts collapsed ────────────────────────────────────────────────

test("a suggested-squad card starts collapsed by default", () => {
    const h = harness();
    const html = renderCardHtml(h, {
        mode: "3v3",
        counterDef: { name: "My Counter", required: ["A"], recommended: [] },
        characterDefinitions: { A: { name: "Alpha" } },
        ownedCharacters: ["A"]
    });
    assert.match(html, /board-rec-disclosure/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /board-rec-squad/);
    assert.doesNotMatch(html, /Alpha/);
});

// ── 9. Expanding/collapsing never touches round state ───────────────────────

test("toggling a card's expanded state does not select, use, or clear anything", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        myBoard = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Enemy Team";
        gacData = { "3v3": { "Enemy Team": [{ counterId: "C1", counter: "My Counter", tier: "S", bannerScore: 50, undersize: 0 }] } };
        counterDefinitions = { C1: { name: "My Counter", required: ["A"], recommended: [] } };
        characterDefinitions = { A: { name: "Alpha" } };
        ownedCharacters = ["A"];
        usedTeams = [];
        currentView = "round";
        roundPlan = computeRoundPlan();
    `);

    const before = h.run(`JSON.stringify({
        usedTeams: usedTeams,
        cleared: board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared
    })`);

    assert.doesNotThrow(() => h.run(`toggleCounterCardExpanded("FRONT_BOTTOM:0:C1")`));

    const after = h.run(`JSON.stringify({
        usedTeams: usedTeams,
        cleared: board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared
    })`);

    assert.equal(after, before);
    assert.equal(h.run(`expandedCounterCards.has("FRONT_BOTTOM:0:C1")`), true);

    // Toggling again collapses it back, still without touching round state.
    h.run(`toggleCounterCardExpanded("FRONT_BOTTOM:0:C1")`);
    assert.equal(h.run(`expandedCounterCards.has("FRONT_BOTTOM:0:C1")`), false);
});

// ── 10. New round starts with everything collapsed ──────────────────────────

test("resetting the round clears any previously expanded cards", () => {
    const h = harness();
    h.run(`expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);`);
    h.run(`discardBoard();`);
    assert.equal(h.run(`expandedCounterCards.size`), 0);
});

// ── Availability annotation reuses existing state ───────────────────────────

test("a recommended member already spent by another used counter is annotated using existing availability state", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        const teams = board.teams;
        teams.find(t => t.territory === "FRONT_BOTTOM").name = "Enemy Team";
        gacData = { "3v3": {
            "Enemy Team": [{ counterId: "C1", counter: "My Counter", tier: "S", bannerScore: 50, undersize: 0 }]
        }};
        // C1's REQUIRED core (A) is untouched, so C1 itself stays available —
        // only its RECOMMENDED member (B) was spent by an unrelated used
        // counter (C2), which recommended[] never blocks (only required[]
        // does). The expanded view should still surface that B is unavailable.
        counterDefinitions = {
            C1: { name: "My Counter", required: ["A"], recommended: ["B"] },
            C2: { name: "Other Counter", required: ["B"], recommended: [] }
        };
        characterDefinitions = { A: { name: "Alpha" }, B: { name: "Bravo" } };
        ownedCharacters = ["A", "B"];
        usedTeams = ["C2"];
        expandedCounterCards = new Set(["FRONT_BOTTOM:0:C1"]);
        roundPlan = computeRoundPlan();
    `);
    const html = h.run(`
        renderTeamRecommendation(
            "opponent", "FRONT_BOTTOM",
            board.teams.find(t => t.territory === "FRONT_BOTTOM"),
            "3v3"
        )
    `);
    assert.match(html, /Alpha/);
    assert.match(html, /Bravo/);
    assert.match(html, /Used with Other Counter/);
});
