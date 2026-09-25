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

function seedBoardConfig(h) {
    h.run(`
        boardConfig = {
            KYBER: { "5v5": ${JSON.stringify(basicConfig())}, "3v3": ${JSON.stringify(basicConfig())} }
        };
        leagueDraft = "KYBER";
        scoringRules = [{ ruleId: "SETTING_DEFENCE", battleType: "ANY", mode: "ANY", value: 90 }];
    `);
}

// ── 1. New round setup defaults to the current Counters format ────────────

test("entering Round view with no round seeds the setup format from the Counters toggle", () => {
    const h = harness();
    h.run(`currentMode = "3v3"; setView('round');`);
    assert.equal(h.run("boardMode()"), "3v3");

    const h2 = harness();
    h2.run(`currentMode = "5v5"; setView('round');`);
    assert.equal(h2.run("boardMode()"), "5v5");
});

test("seeding from Fleet falls back to the last squad format used", () => {
    const h = harness();
    h.run(`currentMode = "FLEET"; lastSquadMode = "3v3"; setView('round');`);
    assert.equal(h.run("boardMode()"), "3v3");
});

// ── 2 & 8. Explicit 5v5/3v3 choice while setup is empty ────────────────────

test("the user can explicitly choose 5v5 or 3v3 on an empty setup card", () => {
    const h = harness();
    h.run(`currentMode = "3v3"; setView('round');`);
    assert.equal(h.run("boardMode()"), "3v3");

    h.run(`setBoardModeDraft('5v5');`);
    assert.equal(h.run("boardMode()"), "5v5");

    h.run(`setBoardModeDraft('3v3');`);
    assert.equal(h.run("boardMode()"), "3v3");
});

test("the setup card renders a GAC format selector, not a team-size label", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    const html = h.run("renderBoardSetup()");
    assert.match(html, /GAC format/);
    assert.doesNotMatch(html, /Team size/i);
    assert.match(html, /setBoardModeDraft\('5v5'\)/);
    assert.match(html, /setBoardModeDraft\('3v3'\)/);
});

// ── 3 & 4. Chosen format persists with the round ───────────────────────────

test("the chosen GAC format is persisted as part of the round state", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    h.run(`setBoardModeDraft('3v3'); createBoard();`);

    assert.equal(h.run("board.mode"), "3v3");
    assert.equal(h.run("myBoard.mode"), "3v3");
    const stored = JSON.parse(h.values.get("boardData"));
    assert.equal(stored.mode, "3v3");
});

// ── 5. Reopening the round restores its own format ─────────────────────────

test("reopening the round restores its own stored format regardless of the current draft", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    h.run(`setBoardModeDraft('3v3'); createBoard();`);

    const h2 = harness({
        boardData: h.values.get("boardData"),
        myBoardData: h.values.get("myBoardData")
    });
    h2.run(`currentMode = "5v5"; setView('round');`); // Counters toggle differs from stored round format
    assert.equal(h2.run("board.mode"), "3v3");
    assert.equal(h2.run("myBoard.mode"), "3v3");
});

// ── 6. Changing the Counters toggle afterwards does not change the round ──

test("changing the Counters format toggle after setup does not mutate the active round", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    h.run(`createBoard();`); // defaults to 5v5

    assert.equal(h.run("board.mode"), "5v5");
    h.run(`setMode('3v3');`); // Counters-screen toggle change
    assert.equal(h.run("board.mode"), "5v5");
    assert.equal(h.run("myBoard.mode"), "5v5");
});

// ── 7. Round counter/suggestion behaviour uses the round's stored format ──

test("round allocation reads the round's own format, not the Counters toggle", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Leia Organa";
        currentMode = "5v5"; // Counters toggle intentionally mismatched
        gacData = {
            "5v5": { "Leia Organa": [{ counterId: "WRONG_MODE", counter: "Wrong", tier: "S", bannerScore: 99, undersize: 0 }] },
            "3v3": { "Leia Organa": [{ counterId: "RIGHT_MODE", counter: "Right", tier: "S", bannerScore: 48, undersize: 0 }] }
        };
        counterDefinitions = {
            WRONG_MODE: { name: "Wrong", required: [] },
            RIGHT_MODE: { name: "Right", required: [] }
        };
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run("roundPlan.reasons['FRONT_BOTTOM:0'].counter.counterId"), "RIGHT_MODE");
});

// ── 9. Setting format while board data already exists never silently
//        reinterprets it — the setup card (and therefore the format
//        selector) only ever renders while no round exists. ─────────────

test("the setup card format selector is unavailable once a round has been created", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    h.run(`createBoard();`);

    const html = h.run("renderRound()");
    assert.doesNotMatch(html, /GAC format/);
});

test("setBoardModeDraft after a round exists cannot retroactively change the active round", () => {
    const h = harness();
    h.run(`currentMode = "5v5"; setView('round');`);
    seedBoardConfig(h);
    h.run(`createBoard();`);
    assert.equal(h.run("board.mode"), "5v5");

    h.run(`setBoardModeDraft('3v3');`); // no setup card is showing for this to act on
    assert.equal(h.run("board.mode"), "5v5");
});

// ── 10. Legacy persisted round state without a dedicated new field ────────
// The round format has always lived in the existing `mode` field of the
// persisted board object (present since schema 2); no new field was added,
// so a legacy board loads exactly as before and its format is authoritative.

test("legacy schema-3 round state loads safely and keeps its own format", () => {
    const legacy = {
        schema: 3,
        league: "KYBER",
        mode: "3v3",
        createdAt: "2026-08-31T10:00:00.000Z",
        territories: basicConfig(),
        teams: basicConfig().map(t => ({ territory: t.territory, index: 0, name: "", cleared: false }))
    };
    const h = harness({ boardData: JSON.stringify(legacy) });
    h.run(`currentMode = "5v5"; setView('round');`); // Counters toggle differs
    assert.equal(h.run("board.mode"), "3v3");
    assert.equal(h.run("myBoard.mode"), "3v3");
});

// ── 11. Existing Fleet behaviour is untouched ──────────────────────────────

test("Fleet browsing on the Counters screen is unaffected by the round format draft", () => {
    const h = harness();
    h.run(`
        gacData = { FLEET: { "Home One": [{ counterId: "F1", counter: "Fleet Counter", tier: "S", bannerScore: 64, undersize: 0 }] } };
        currentMode = "FLEET";
        boardModeDraft = "3v3";
    `);
    const teamNames = h.run(`Object.keys(gacData["FLEET"])`);
    assert.equal(JSON.stringify(teamNames), JSON.stringify(["Home One"]));
});
