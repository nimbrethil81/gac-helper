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

test("legacy opponent board migration creates My Board without overwriting live scores", () => {
    const legacy = {
        schema: 3,
        league: "KYBER",
        mode: "5v5",
        createdAt: "2026-08-31T10:00:00.000Z",
        territories: basicConfig(),
        teams: basicConfig().map((t, index) => ({
            territory: t.territory,
            index: 0,
            name: index === 0 ? "Leia Organa" : "",
            cleared: index === 0,
            attempts: index
        }))
    };
    const h = harness({
        boardData: JSON.stringify(legacy),
        bannerData: JSON.stringify({ myScore: 777, oppScore: 888, remaining: null, oppFinal: false })
    });

    h.run("loadBoard()");

    assert.equal(h.run("JSON.stringify([board.schema, board.side, myBoard.schema, myBoard.side])"), JSON.stringify([5, "opponent", 5, "my"]));
    assert.equal(h.run("JSON.stringify([bannerData.myScore, bannerData.oppScore])"), JSON.stringify([777, 888]));
    assert.equal(h.run("myBoard.teams.every(t => !t.cleared && t.attempts === 0)"), true);
    assert.ok(h.values.has("myBoardData"));
});

test("My Board autosaves identity without progress and keeps formats separate", () => {
    const h = harness();
    h.run(`
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        myBoard.teams[0].name = NOT_IN_CATALOGUE;
        myBoard.teams[0].customName = "Custom wall";
        myBoard.teams[0].attempts = 3;
        myBoard.teams[0].cleared = true;
        saveDefenceTemplateFromMyBoard();
    `);

    const template = JSON.parse(h.values.get("defenceTemplate:5v5"));
    assert.equal(template.teams[0].name, "__NOT_IN_CATALOGUE__");
    assert.equal(template.teams[0].customName, "Custom wall");
    assert.equal("attempts" in template.teams[0], false);
    assert.equal("cleared" in template.teams[0], false);
    assert.equal(h.values.has("defenceTemplate:3v3"), false);
});

test("new round setup validates SETTING_DEFENCE and prefills both scores once", () => {
    const h = harness();
    h.run(`
        boardConfig = { KYBER: { "5v5": ${JSON.stringify(basicConfig())} } };
        leagueDraft = "KYBER";
        currentMode = "5v5";
        scoringRules = [{ ruleId: "SETTING_DEFENCE", battleType: "ANY", mode: "ANY", value: 90 }];
        createBoard();
    `);

    assert.equal(h.run("JSON.stringify([board.teams.length, myBoard.teams.length])"), JSON.stringify([4, 4]));
    assert.equal(h.run("JSON.stringify([bannerData.myScore, bannerData.oppScore, bannerData.scoresPrefilled])"), JSON.stringify([360, 360, true]));

    const missing = harness();
    missing.run(`
        boardConfig = { KYBER: { "5v5": ${JSON.stringify(basicConfig())} } };
        leagueDraft = "KYBER";
        currentMode = "5v5";
        scoringRules = [];
        createBoard();
    `);
    assert.equal(missing.run("board"), null);
    assert.match(missing.alerts[0], /SETTING_DEFENCE/);
});

test("opponent final marker zeroes remaining without mutating My Board", () => {
    const h = harness();
    h.run(`
        scoringRules = [
            { ruleId: "VICTORY", battleType: "ANY", mode: "ANY", value: 15 },
            { ruleId: "FIRST_ATTEMPT", battleType: "ANY", mode: "ANY", value: 30 },
            { ruleId: "FIRST_ATTACK", battleType: "ANY", mode: "ANY", value: 10 },
            { ruleId: "TERRITORY_CLEAR_BASE", battleType: "ANY", mode: "ANY", value: 120 }
        ];
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        bannerData.oppFinal = false;
    `);
    const before = h.run("JSON.stringify(myBoard)");
    assert.ok(h.run("calculatedOpponentRemaining()") > 0);
    h.run("bannerData.oppFinal = true");
    assert.equal(h.run("calculatedOpponentRemaining()"), 0);
    assert.equal(h.run("JSON.stringify(myBoard)"), before);
});

test("two-sided verdict distinguishes guaranteed, impossible and play-dependent outcomes", () => {
    const h = harness();
    assert.equal(h.run("canWinVerdict(500, 300, 50, 100).headline"), "Guaranteed win");
    assert.equal(h.run("canWinVerdict(100, 300, 200, 100).headline"), "Impossible win");
    assert.equal(h.run("canWinVerdict(200, 250, 200, 200).headline"), "Outcome depends on play");
});

test("My Board renders back territories without recommendations or lock gates", () => {
    const h = harness();
    const html = h.run(`
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        renderMyBoard()
    `);
    assert.match(html, /BACK TOP/);
    assert.match(html, /BACK BOTTOM/);
    assert.doesNotMatch(html, /Locked — clear/);
    assert.doesNotMatch(html, /Mark used/);
});

test("Reset Round clears both live boards while preserving both template keys", () => {
    const h = harness({
        "defenceTemplate:5v5": JSON.stringify({ schema: 1, mode: "5v5", teams: [] }),
        "defenceTemplate:3v3": JSON.stringify({ schema: 1, mode: "3v3", teams: [] })
    });
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        saveBoard("opponent");
        saveBoard("my");
        resetRound();
    `);
    assert.equal(h.values.has("boardData"), false);
    assert.equal(h.values.has("myBoardData"), false);
    assert.equal(h.values.has("defenceTemplate:5v5"), true);
    assert.equal(h.values.has("defenceTemplate:3v3"), true);
});

test("opponent allocation and First Attack ordering still resolve from Opponent Board", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Leia Organa";
        gacData = { "5v5": { "Leia Organa": [{ counterId: "JABBA", counter: "Jabba", tier: "S", bannerScore: 62, undersize: 0 }] } };
        counterDefinitions = { JABBA: { name: "Jabba", required: [] } };
        usedTeams = [];
        roundPlan = computeRoundPlan();
    `);
    assert.equal(h.run("roundPlan.reasons['FRONT_BOTTOM:0'].counter.counterId"), "JABBA");
    assert.equal(h.run("computeBattleOrder(roundPlan).firstAttack"), true);
    assert.equal(h.run("computeBattleOrder(roundPlan).squad.counter.counterId"), "JABBA");
});

// ─── CLEARED-ONLY TEMPORARY UNDO ────────────────────────────────────────────

function twoTeamFrontBottomConfig() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 2 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}

test("Cleared marks the defensive team cleared and offers a temporary Undo", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        usedTeams = ["SOME_OTHER_COUNTER"];
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
        saveBoard("opponent");
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    assert.equal(h.run("pendingUndo.kind"), "cleared");
    assert.equal(h.run("JSON.stringify(usedTeams)"), JSON.stringify(["SOME_OTHER_COUNTER"]));
});

function configureTwoRecommendedFrontBottomTeams(h) {
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM" && t.index === 0).name = "Leia Organa";
        board.teams.find(t => t.territory === "FRONT_BOTTOM" && t.index === 1).name = "Jedi Master Luke";
        gacData = { "5v5": {
            "Leia Organa": [{ counterId: "JABBA", counter: "Jabba", tier: "S", bannerScore: 62, undersize: 0 }],
            "Jedi Master Luke": [{ counterId: "JML", counter: "JML", tier: "S", bannerScore: 61, undersize: 0 }]
        } };
        counterDefinitions = { JABBA: { name: "Jabba", required: [] }, JML: { name: "JML", required: [] } };
        usedTeams = [];
    `);
}

test("Cleared advances to the next uncleared defence in the existing squad ordering", () => {
    const h = harness();
    configureTwoRecommendedFrontBottomTeams(h);

    h.run("toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0)");

    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    assert.equal(h.run("focusedTeamKey"), "FRONT_BOTTOM:1");
    assert.equal(h.run("pendingUndo.kind"), "cleared");

    h.run("undoPendingAction()");
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
    assert.equal(h.run("focusedTeamKey"), "FRONT_BOTTOM:1");
});

test("Used + Cleared preserves used state and advances to the next uncleared defence", () => {
    const h = harness();
    configureTwoRecommendedFrontBottomTeams(h);

    h.run("markUsedAndCleared('opponent', 'FRONT_BOTTOM', 0, 'JABBA')");

    assert.equal(h.run("usedTeams.includes('JABBA')"), true);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    assert.equal(h.run("focusedTeamKey"), "FRONT_BOTTOM:1");
    assert.equal(h.run("pendingUndo.kind"), "usedCleared");
});

test("Mark Used does not change the active defence", () => {
    const h = harness();
    configureTwoRecommendedFrontBottomTeams(h);
    h.run("focusedTeamKey = 'FRONT_BOTTOM:0'; markCounterUsedFromBoard('JABBA')");

    assert.equal(h.run("focusedTeamKey"), "FRONT_BOTTOM:0");
    assert.equal(h.run("usedTeams.includes('JABBA')"), true);
});

test("clearing the final recommended defence leaves no invalid selection", () => {
    const h = harness();
    configureTwoRecommendedFrontBottomTeams(h);
    h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 1).cleared = true; focusedTeamKey = 'FRONT_BOTTOM:0'");

    assert.doesNotThrow(() => h.run("toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0)"));
    assert.equal(h.run("focusedTeamKey"), null);
    assert.equal(h.run("pendingUndo.kind"), "cleared");
});

test("Cleared Undo restores exactly the prior defence state and leaves unrelated state untouched", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        usedTeams = ["SOME_OTHER_COUNTER"];
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
        saveBoard("opponent");
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);

    // Cleared marks the defensive team cleared.
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    // Undo becomes available temporarily.
    assert.equal(h.run("pendingUndo.kind"), "cleared");

    h.run("undoPendingAction()");

    // Undo restores the defence to its previous state.
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
    assert.equal(h.run("JSON.parse(localStorage.getItem('boardData')).teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
    // Undo does not change unrelated used-team state.
    assert.equal(h.run("JSON.stringify(usedTeams)"), JSON.stringify(["SOME_OTHER_COUNTER"]));
    // Undo does not mutate the unrelated second team in the same territory.
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 1).cleared"), false);
    // Undo affordance is gone.
    assert.equal(h.run("pendingUndo"), null);
});

test("Cleared state remains once the Undo window expires", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);
    assert.equal(h.run("pendingUndo.kind"), "cleared");

    t.mock.timers.tick(6000);

    assert.equal(h.run("pendingUndo"), null);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
});

// ─── USED + CLEARED ──────────────────────────────────────────────────────────

test("Used + Cleared marks both states from unused/uncleared, and Undo restores both", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        usedTeams = [];
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
        saveBoard("opponent");
    `);

    h.run("markUsedAndCleared('opponent', 'FRONT_BOTTOM', 0, 'JABBA')");

    // From unused + uncleared, the action results in used + cleared.
    assert.equal(h.run("usedTeams.includes('JABBA')"), true);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    // The combined operation persists both state changes.
    assert.equal(h.run("JSON.parse(localStorage.getItem('usedTeams')).includes('JABBA')"), true);
    assert.equal(h.run("JSON.parse(localStorage.getItem('boardData')).teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);

    h.run("undoPendingAction()");

    // Undo from that state restores unused + uncleared.
    assert.equal(h.run("usedTeams.includes('JABBA')"), false);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
    // Undo persists the restored state.
    assert.equal(h.run("JSON.parse(localStorage.getItem('usedTeams')).includes('JABBA')"), false);
    assert.equal(h.run("JSON.parse(localStorage.getItem('boardData')).teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
});

test("Used + Cleared leaves an already-used attacker used, and Undo restores only the defence", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        usedTeams = ["JABBA"];
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
        saveBoard("opponent");
    `);

    h.run("markUsedAndCleared('opponent', 'FRONT_BOTTOM', 0, 'JABBA')");

    // Attacking team remains used; defence becomes cleared.
    assert.equal(h.run("usedTeams.includes('JABBA')"), true);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);

    h.run("undoPendingAction()");

    // Undo leaves the attacker used and restores only the defence to uncleared.
    assert.equal(h.run("JSON.stringify(usedTeams)"), JSON.stringify(["JABBA"]));
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), false);
});

test("Used + Cleared and its Undo do not mutate an unrelated team in the same territory", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 1).cleared = true;
        usedTeams = [];
        markUsedAndCleared('opponent', 'FRONT_BOTTOM', 0, 'JABBA');
    `);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 1).cleared"), true);

    h.run("undoPendingAction()");
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 1).cleared"), true);
});

// A later action replaces the earlier pending Undo rather than stacking a history.
test("A later action supersedes an earlier pending Undo instead of stacking one", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(twoTeamFrontBottomConfig())}, "opponent", "round", "now");
        usedTeams = [];
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);
    assert.equal(h.run("pendingUndo.kind"), "cleared");

    h.run("markUsedAndCleared('opponent', 'FRONT_BOTTOM', 1, 'JABBA')");
    assert.equal(h.run("pendingUndo.kind"), "usedCleared");
    assert.equal(h.run("pendingUndo.index"), 1);

    // The superseded Cleared action's own state is left as it was (not rolled back).
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
});

// ─── EXISTING INDEPENDENT ACTIONS STILL WORK ────────────────────────────────

test("Mark Used still works independently of Cleared", () => {
    const h = harness();
    h.run(`
        usedTeams = [];
        markUsed('SOLO_COUNTER');
    `);
    assert.equal(h.run("usedTeams.includes('SOLO_COUNTER')"), true);
    assert.equal(h.run("JSON.parse(localStorage.getItem('usedTeams')).includes('SOLO_COUNTER')"), true);
});

test("Cleared still works independently of Used", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        usedTeams = [];
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM' && t.index === 0).cleared"), true);
    assert.equal(h.run("usedTeams.length"), 0);
});

// ─── ISOLATION ACROSS BOARD SIDES ───────────────────────────────────────────

test("Cleared Undo on My Board never touches Opponent Board state", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = true;
        toggleTeamCleared('my', 'FRONT_BOTTOM', 0);
    `);
    assert.equal(h.run("myBoard.teams.find(t => t.territory === 'FRONT_BOTTOM').cleared"), true);
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM').cleared"), true);

    h.run("undoPendingAction()");

    assert.equal(h.run("myBoard.teams.find(t => t.territory === 'FRONT_BOTTOM').cleared"), false);
    // The opponent board's independent Cleared state is untouched by the My Board Undo.
    assert.equal(h.run("board.teams.find(t => t.territory === 'FRONT_BOTTOM').cleared"), true);
});

// ─── UI: PRESENCE OF ALL THREE ACTIONS AND THE UNDO TOAST ───────────────────

test("Opponent Board renders Used + Cleared alongside Mark used, and My Board renders neither", () => {
    const h = harness();
    const oppHtml = h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Leia Organa";
        gacData = { "5v5": { "Leia Organa": [{ counterId: "JABBA", counter: "Jabba", tier: "S", bannerScore: 62, undersize: 0 }] } };
        counterDefinitions = { JABBA: { name: "Jabba", required: [] } };
        usedTeams = [];
        renderBoard()
    `);
    assert.match(oppHtml, /Used \+ Cleared/);
    assert.match(oppHtml, /Mark used/);
    assert.match(oppHtml, /Cleared/);

    const myHtml = h.run(`
        myBoard = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        renderMyBoard()
    `);
    assert.doesNotMatch(myHtml, /Used \+ Cleared/);
    assert.doesNotMatch(myHtml, /Mark used/);
});

test("renderBoard shows the temporary Undo toast only while an Undo is pending for that side", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        toggleTeamCleared('opponent', 'FRONT_BOTTOM', 0);
    `);
    assert.match(h.run("renderBoard()"), /Undo/);

    t.mock.timers.tick(6000);
    assert.doesNotMatch(h.run("renderBoard()"), />Undo</);
});

// ─── DEFENCE AVAILABILITY SNAPSHOT (v3.5) ──────────────────────────────────

function defenceTemplate(mode, name) {
    return {
        schema: 1,
        mode,
        teams: [{ territory: "FRONT_TOP", index: 0, name, customName: "" }]
    };
}

function roundSetup(h, mode, template, definitions, compositions = {}) {
    if (template) h.values.set(`defenceTemplate:${mode}`, JSON.stringify(template));
    h.run(`
        boardConfig = { KYBER: { "${mode}": ${JSON.stringify(basicConfig())} } };
        leagueDraft = "KYBER";
        currentMode = "${mode}";
        counterDefinitions = ${JSON.stringify(definitions)};
        defenceCompositions = ${JSON.stringify(compositions)};
        scoringRules = [{ ruleId: "SETTING_DEFENCE", battleType: "ANY", mode: "ANY", value: 90 }];
        createBoard();
    `);
}

test("starting 3v3 and 5v5 rounds snapshot only the matching saved defence", () => {
    const definitions = {
        THREE: { name: "Three Wall", required: ["THREE_LEAD", "THREE_MEMBER"] },
        FIVE: { name: "Five Wall", required: ["FIVE_LEAD", "FIVE_MEMBER"] }
    };
    const h3 = harness({
        "defenceTemplate:3v3": JSON.stringify(defenceTemplate("3v3", "Three Wall")),
        "defenceTemplate:5v5": JSON.stringify(defenceTemplate("5v5", "Five Wall"))
    });
    roundSetup(h3, "3v3", null, definitions);
    assert.equal(h3.run("JSON.stringify(board.defenceSnapshot.characterIds.sort())"), JSON.stringify(["THREE_LEAD", "THREE_MEMBER"]));
    assert.equal(h3.run("board.defenceSnapshot.unresolvedTeams[0]"), "Three Wall");
    assert.match(h3.run("renderDefenceSnapshotStatus()"), /1 defence team needs lineup details\. Some characters may still appear available for attack\./);

    const h5 = harness({
        "defenceTemplate:3v3": JSON.stringify(defenceTemplate("3v3", "Three Wall")),
        "defenceTemplate:5v5": JSON.stringify(defenceTemplate("5v5", "Five Wall"))
    });
    roundSetup(h5, "5v5", null, definitions);
    assert.equal(h5.run("JSON.stringify(board.defenceSnapshot.characterIds.sort())"), JSON.stringify(["FIVE_LEAD", "FIVE_MEMBER"]));
});

test("lead or non-lead defence overlap blocks a composition while no overlap stays available", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.defenceSnapshot = { schema: 1, mode: "3v3", characterIds: ["QA", "MQG"], unresolvedTeams: [], missingSavedDefence: false };
        counterDefinitions = {
            QA_COUNTER: { name: "Queen Amidala", required: ["QA", "MQG", "POW"] },
            MEMBER_COUNTER: { name: "Member test", required: ["OTHER", "MQG"] },
            FREE_COUNTER: { name: "Free team", required: ["FREE"] }
        };
        ownedCharacters = ["QA", "MQG", "POW", "OTHER", "FREE"];
    `);
    assert.equal(h.run("getCounterStatus('QA_COUNTER')"), "on-defence");
    assert.equal(h.run("getCounterStatus('MEMBER_COUNTER')"), "on-defence");
    assert.equal(h.run("getCounterStatus('FREE_COUNTER')"), "available");
    assert.match(h.run("defenceReason('MEMBER_COUNTER')"), /MQG|on defence/);
});

test("defence-blocked counters remain visible, sort below usable counters, and expose On defence", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.defenceSnapshot = { schema: 1, mode: "3v3", characterIds: ["QA"], unresolvedTeams: [], missingSavedDefence: false };
        counterDefinitions = {
            BLOCKED: { name: "Queen Amidala", required: ["QA"] },
            USABLE: { name: "GAS", required: ["GAS"] }
        };
        characterDefinitions = { QA: { name: "Queen Amidala" }, GAS: { name: "General Skywalker" } };
        ownedCharacters = ["QA", "GAS"];
    `);
    const order = h.run("sortCounters([{counterId:'BLOCKED',tier:'S',bannerScore:60},{counterId:'USABLE',tier:'A',bannerScore:50}]).map(c => c.counterId).join(',')");
    assert.equal(order, "USABLE,BLOCKED");
    const html = h.run("buildCounterCardHtml({counterId:'BLOCKED',counter:'Queen Amidala',tier:'S',bannerScore:60,undersize:0,notes:''})");
    assert.match(html, /On defence/);
    assert.doesNotMatch(html, /Mark Used/);
});

test("Round recommendation keeps defence-blocked reference below the usable recommendation", () => {
    const h = harness();
    const html = h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Enemy";
        board.defenceSnapshot = { schema: 1, mode: "3v3", characterIds: ["QA"], unresolvedTeams: [], missingSavedDefence: false };
        gacData = { "3v3": { Enemy: [
            { counterId: "BLOCKED", counter: "Queen Amidala", tier: "S", bannerScore: 56, undersize: 0 },
            { counterId: "USABLE", counter: "GAS", tier: "A", bannerScore: 54, undersize: 0 }
        ] } };
        counterDefinitions = {
            BLOCKED: { name: "Queen Amidala", required: ["QA"] },
            USABLE: { name: "GAS", required: ["GAS"] }
        };
        ownedCharacters = ["QA", "GAS"];
        roundPlan = computeRoundPlan();
        renderTeamRecommendation("opponent", "FRONT_BOTTOM", board.teams.find(t => t.territory === "FRONT_BOTTOM"));
    `);
    assert.match(html, /GAS/);
    assert.match(html, /On defence/);
    assert.ok(html.indexOf("GAS") < html.indexOf("On defence"));
});

test("editing My Board after round start does not mutate the persisted snapshot", () => {
    const h = harness();
    roundSetup(h, "3v3", defenceTemplate("3v3", "Queen Amidala"), {
        QA: { name: "Queen Amidala", required: ["QA", "MQG", "POW"] },
        GAS: { name: "GAS", required: ["GAS"] }
    });
    const before = h.run("JSON.stringify(board.defenceSnapshot)");
    h.run(`
        myBoard.teams[0].name = "GAS";
        saveDefenceTemplateFromMyBoard();
        saveBoard("my");
    `);
    assert.equal(h.run("JSON.stringify(board.defenceSnapshot)"), before);
    assert.equal(JSON.parse(h.values.get("boardData")).defenceSnapshot.characterIds.includes("QA"), true);
});

test("the next round takes a fresh defence snapshot after reset", () => {
    const h = harness();
    const definitions = {
        QA: { name: "Queen Amidala", required: ["QA"] },
        GAS: { name: "GAS", required: ["GAS"] }
    };
    roundSetup(h, "3v3", defenceTemplate("3v3", "Queen Amidala"), definitions);
    assert.equal(h.run("board.defenceSnapshot.characterIds.includes('QA')"), true);
    h.values.set("defenceTemplate:3v3", JSON.stringify(defenceTemplate("3v3", "GAS")));
    h.run("resetRound(); createBoard();");
    assert.equal(h.run("board.defenceSnapshot.characterIds.includes('GAS')"), true);
    assert.equal(h.run("board.defenceSnapshot.characterIds.includes('QA')"), false);
});

test("no saved defence still starts Round Mode and shows the filtering warning", () => {
    const h = harness();
    roundSetup(h, "3v3", null, { QA: { name: "Queen Amidala", required: ["QA"] } });
    assert.notEqual(h.run("board"), null);
    assert.equal(h.run("board.defenceSnapshot.missingSavedDefence"), true);
    assert.match(h.run("renderDefenceSnapshotStatus()"), /No saved 3v3 defence/);
    assert.doesNotMatch(h.run("renderDefenceSnapshotStatus()"), /adoptMyBoardAsRoundDefence/);
});

test("a round started without a saved defence can adopt My Board once", () => {
    const h = harness();
    roundSetup(h, "3v3", null, {
        QA: { name: "Queen Amidala", required: ["QA"] },
        GAS: { name: "GAS", required: ["GAS"] }
    });
    h.run(`setBoardTeam("my", "FRONT_TOP", 0, "Queen Amidala");`);
    assert.equal(h.run("board.defenceSnapshot.missingSavedDefence"), true);
    assert.match(h.run("renderDefenceSnapshotStatus()"), /adoptMyBoardAsRoundDefence/);

    h.run("adoptMyBoardAsRoundDefence()");
    assert.equal(h.run("board.defenceSnapshot.missingSavedDefence"), false);
    assert.deepEqual(JSON.parse(h.values.get("boardData")).defenceSnapshot.characterIds, ["QA"]);
    assert.match(h.run("renderDefenceSnapshotStatus()"), /Defence: 1 unit unavailable/);

    // Once adopted, the snapshot is immutable again.
    h.run(`setBoardTeam("my", "FRONT_TOP", 0, "GAS"); adoptMyBoardAsRoundDefence();`);
    assert.deepEqual(JSON.parse(h.run("JSON.stringify(board.defenceSnapshot.characterIds)")), ["QA"]);
});

test("adopting My Board needs confirmation and never replaces a saved-defence snapshot", () => {
    const declined = harness();
    roundSetup(declined, "3v3", null, { QA: { name: "Queen Amidala", required: ["QA"] } });
    declined.run(`setBoardTeam("my", "FRONT_TOP", 0, "Queen Amidala"); confirm = () => false; adoptMyBoardAsRoundDefence();`);
    assert.equal(declined.run("board.defenceSnapshot.missingSavedDefence"), true);

    const saved = harness();
    roundSetup(saved, "3v3", defenceTemplate("3v3", "Queen Amidala"), {
        QA: { name: "Queen Amidala", required: ["QA"] },
        GAS: { name: "GAS", required: ["GAS"] }
    });
    saved.run(`setBoardTeam("my", "FRONT_TOP", 0, "GAS"); adoptMyBoardAsRoundDefence();`);
    assert.deepEqual(JSON.parse(saved.run("JSON.stringify(board.defenceSnapshot.characterIds)")), ["QA"]);
});

test("Mark Used remains independent from On defence", () => {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.defenceSnapshot = { schema: 1, mode: "3v3", characterIds: ["QA"], unresolvedTeams: [], missingSavedDefence: false };
        counterDefinitions = { QA: { name: "Queen Amidala", required: ["QA"] }, GAS: { name: "GAS", required: ["GAS"] } };
        ownedCharacters = ["QA", "GAS"];
        markUsed("GAS");
    `);
    assert.equal(h.run("getCounterStatus('QA')"), "on-defence");
    assert.equal(h.run("getCounterStatus('GAS')"), "used");
});

test("persisted round state restores its defence snapshot", () => {
    const h1 = harness();
    roundSetup(h1, "3v3", defenceTemplate("3v3", "Queen Amidala"), {
        QA: { name: "Queen Amidala", required: ["QA", "MQG", "POW"] }
    });
    const h2 = harness({
        boardData: h1.values.get("boardData"),
        myBoardData: h1.values.get("myBoardData")
    });
    h2.run("loadBoard()");
    assert.equal(h2.run("JSON.stringify(board.defenceSnapshot.characterIds)"), JSON.stringify(["QA", "MQG", "POW"]));
});

test("ambiguous legacy defence identity is not guessed and is surfaced as unresolved", () => {
    const h = harness();
    h.run(`
        counterDefinitions = {
            A: { name: "Legacy Wall", required: ["A"] },
            B: { name: "Legacy Wall", required: ["B"] }
        };
        defenceCompositions = {};
    `);
    const snapshot = h.run(`captureDefenceSnapshot("3v3", ${JSON.stringify(defenceTemplate("3v3", "Legacy Wall"))})`);
    assert.equal(snapshot.characterIds.length, 0);
    assert.equal(snapshot.unresolvedTeams[0], "Legacy Wall");
});

test("explicit mode-specific defence composition supplies every defensive member", () => {
    const h = harness();
    h.run(`
        counterDefinitions = {};
        defenceCompositions = {
            "3v3": { "Custom Queen Wall": ["QA", "MQG", "POW"] },
            "5v5": { "Custom Queen Wall": ["OTHER"] }
        };
    `);
    const snapshot = h.run(`captureDefenceSnapshot("3v3", ${JSON.stringify(defenceTemplate("3v3", "Custom Queen Wall"))})`);
    assert.equal(JSON.stringify(snapshot.characterIds), JSON.stringify(["QA", "MQG", "POW"]));
    assert.equal(snapshot.unresolvedTeams.length, 0);
});

test("board picker includes mode-specific defences without matchups and commits their full lineups", () => {
    const h = harness();
    h.run(`
        gacData = { "5v5": { "Countered Team": [] }, "3v3": { "Existing Three": [] } };
        defenceTeams = {
            "5v5": { "Chief Chirpa": { threat: "NORMAL" } },
            "3v3": { "Three Only": { threat: "LOW" } },
            ANY: { "Executor": { threat: "HIGH" } }
        };
        defenceCompositions = {
            "5v5": { "Chief Chirpa": ["CHIEF_CHIRPA", "LOGRAY", "PAPLOO", "EWOK_ELDER", "PRINCESS_KNEESAA"] },
            "3v3": { "Chief Chirpa": ["CHIEF_CHIRPA", "PRINCESS_KNEESAA", "LOGRAY"] }
        };
    `);
    const row = h.run(`renderBoardTeamRow(
        { territory: "FRONT_TOP", type: "SQUAD" },
        { territory: "FRONT_TOP", index: 0, name: "", attempts: 0, cleared: false },
        { mode: "5v5" }, "my")`);
    assert.match(row, /<option value="Chief Chirpa"\s*>Chief Chirpa<\/option>/);
    assert.equal((row.match(/<option value="Chief Chirpa"\s*>/g) || []).length, 1);
    assert.doesNotMatch(row, /<option value="Three Only"|<option value="Executor"/);
    assert.match(row, /<option value="Countered Team"\s*>/);

    const five = h.run(`captureDefenceSnapshot("5v5", ${JSON.stringify(defenceTemplate("5v5", "Chief Chirpa"))})`);
    assert.equal(JSON.stringify(five.characterIds), JSON.stringify(["CHIEF_CHIRPA", "LOGRAY", "PAPLOO", "EWOK_ELDER", "PRINCESS_KNEESAA"]));
    assert.equal(five.unresolvedTeams.length, 0);
    const three = h.run(`captureDefenceSnapshot("3v3", ${JSON.stringify(defenceTemplate("3v3", "Chief Chirpa"))})`);
    assert.equal(JSON.stringify(three.characterIds), JSON.stringify(["CHIEF_CHIRPA", "PRINCESS_KNEESAA", "LOGRAY"]));
});

// ─── PLAYER-CONFIRMED TEMPLATE LINEUPS ────────────────────────────────────

function lineupSetup(mode = "5v5") {
    const h = harness();
    h.run(`
        characterDefinitions = Object.fromEntries([
            ...["A", "B", "C", "D", "E", "F"].map(id => [id, { unitType: "CHARACTER" }]),
            ...["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"].map(id => [id, { unitType: "SHIP" }]),
            ["CAP", { unitType: "CAPITAL_SHIP" }], ["CAP2", { unitType: "CAPITAL_SHIP" }]
        ]);
        myBoard = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(basicConfig())}, "my", "round", "now");
        myBoard.teams.forEach((team, index) => team.name = index === 2 ? "Fleet" : "Wall " + index);
        saveDefenceTemplateFromMyBoard();
    `);
    return h;
}

function writeLineup(h, lineup, { territory = "FRONT_TOP", index = 0, name = "Wall 0", customName = "", confirm = false, mode = "5v5" } = {}) {
    return h.run(`writeDefenceTemplateLineup(${JSON.stringify(mode)}, ${JSON.stringify(territory)}, ${index},
        ${JSON.stringify({ name, customName })}, ${JSON.stringify(lineup)}, {confirm: ${confirm}})`);
}

function readLineup(h, territory = "FRONT_TOP", mode = "5v5") {
    return h.run(`readDefenceTemplateLineup("${mode}", "${territory}", 0)`);
}

const fullSquad = { characterIds: ["A", "B", "C", "D", "E"] };
const fullFleet = { capitalShipId: "CAP", startingShipIds: ["S1", "S2", "S3"], reinforcementIds: [] };

test("schema-1 template migration preserves both independent layouts and identities", () => {
    const templates = Object.fromEntries(["5v5", "3v3"].map(mode => [`defenceTemplate:${mode}`, JSON.stringify({
        schema: 1, mode, league: "KYBER", updatedAt: "original", territories: basicConfig(),
        teams: [{ territory: "FRONT_TOP", index: 0, name: "__NOT_IN_CATALOGUE__", customName: `${mode} wall` }]
    })]));
    const h = harness(templates);
    for (const mode of ["5v5", "3v3"]) {
        const original = JSON.parse(templates[`defenceTemplate:${mode}`]);
        const migrated = JSON.parse(h.run(`JSON.stringify(loadDefenceTemplate("${mode}"))`));
        assert.deepEqual(migrated, { ...original, schema: 2 });
        assert.deepEqual(JSON.parse(h.values.get(`defenceTemplate:${mode}`)), migrated);
    }
    assert.equal(h.run('loadDefenceTemplate("FLEET")'), null);
});

test("corrupt lineup fields preserve saved identities, layout, live board and scores", () => {
    const h = lineupSetup();
    const template = JSON.parse(h.values.get("defenceTemplate:5v5"));
    template.teams[0].lineup = { characterIds: "bad", confirmed: true };
    template.teams.push(null);
    h.values.set("defenceTemplate:5v5", JSON.stringify(template));
    assert.equal(readLineup(h).confirmed, false);
    assert.equal(readLineup(h).validation.valid, false);
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams[0].name = "Live opponent";
        myBoard.teams[0].attempts = 2;
        bannerData.myScore = 432;
        saveBoard("opponent"); saveBoard("my");
        loadBoard();
    `);
    assert.equal(h.run("board.teams[0].name"), "Live opponent");
    assert.equal(h.run("myBoard.teams[0].attempts"), 2);
    assert.equal(h.run("bannerData.myScore"), 432);
    assert.equal(h.run(`applyDefenceTemplate(createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "my", "new", "later")).teams[0].name`), "Wall 0");
    assert.equal(h.run('loadDefenceTemplate("5v5").territories.length'), 4);
    h.values.set("defenceTemplate:3v3", "{broken json");
    assert.equal(h.run('loadDefenceTemplate("3v3")'), null);
    assert.equal(h.run("board.teams[0].name"), "Live opponent");
});

test("confirmation is explicit, survives reload and overrides a conflicting catalogue suggestion", () => {
    const h = lineupSetup();
    h.run('defenceCompositions = { "5v5": { "Wall 0": ["F"] } }');
    assert.equal(readLineup(h).source, "defence-composition");
    assert.equal(writeLineup(h, { ...fullSquad, confirmed: true }).ok, true);
    assert.equal(readLineup(h).confirmed, false, "a copied proposal flag never confirms itself");
    assert.equal(writeLineup(h, fullSquad, { confirm: true }).ok, true);
    assert.equal(readLineup(h).confirmed, true);
    assert.equal(readLineup(h).source, "saved");
    assert.deepEqual(Array.from(readLineup(h).lineup.characterIds), fullSquad.characterIds);
    const restored = harness(Object.fromEntries(h.values));
    restored.run('characterDefinitions = ' + h.run('JSON.stringify(characterDefinitions)'));
    assert.equal(readLineup(restored).confirmed, true);
    restored.run('characterDefinitions = {}');
    assert.equal(readLineup(restored).confirmed, false, "unknown catalogue cannot validate confirmation");
    assert.equal(writeLineup(restored, fullSquad, { confirm: true }).ok, false);
    assert.equal(JSON.parse(restored.values.get("defenceTemplate:5v5")).teams[0].lineup.confirmed, true, "persisted confirmation and IDs are retained while catalogue is unavailable");
});

test("unchanged My Board autosaves retain confirmation, while changing or clearing identities invalidates only that slot", () => {
    const h = lineupSetup();
    assert.equal(writeLineup(h, fullSquad, { confirm: true }).ok, true);
    assert.equal(writeLineup(h, fullFleet, { territory: "BACK_TOP", name: "Fleet", confirm: true }).ok, true);
    const saved = JSON.stringify(readLineup(h).lineup);
    h.run('setBoardTeam("my", "FRONT_TOP", 0, "Wall 0"); setBoardTeam("my", "FRONT_BOTTOM", 0, "Another wall"); saveDefenceTemplateFromMyBoard()');
    assert.equal(JSON.stringify(readLineup(h).lineup), saved);
    h.run('setBoardTeam("my", "FRONT_BOTTOM", 0, "Wall 0")');
    assert.equal(readLineup(h, "FRONT_BOTTOM"), null, "same identity in another slot does not acquire members");
    h.run('setBoardTeam("my", "FRONT_TOP", 0, "Changed")');
    assert.equal(readLineup(h), null);
    assert.equal(readLineup(h, "BACK_TOP").confirmed, true);
    assert.equal(writeLineup(h, fullSquad, { confirm: true }).ok, false, "stale identity writes are rejected");
    h.run('setBoardTeam("my", "FRONT_TOP", 0, "Wall 0")');
    assert.equal(readLineup(h), null, "switching back cannot restore a previous identity's confirmation");
    writeLineup(h, fullSquad, { confirm: true });
    h.run('setBoardTeam("my", "FRONT_TOP", 0, "")');
    assert.equal(h.run('loadDefenceTemplate("5v5").teams[0].lineup'), undefined);
});

test("custom-name edits and slot moves never reassign confirmed members", () => {
    const h = lineupSetup();
    h.run('setBoardTeam("my", "FRONT_TOP", 0, NOT_IN_CATALOGUE); setCustomTeamName("my", "FRONT_TOP", 0, "Custom")');
    writeLineup(h, fullSquad, { name: "__NOT_IN_CATALOGUE__", customName: "Custom", confirm: true });
    h.run('setCustomTeamName("my", "FRONT_TOP", 0, "Custom")');
    assert.equal(readLineup(h).confirmed, true);
    h.run('setCustomTeamName("my", "FRONT_TOP", 0, "Edited")');
    assert.equal(readLineup(h), null);
    writeLineup(h, fullSquad, { name: "__NOT_IN_CATALOGUE__", customName: "Edited", confirm: true });
    h.run('myBoard.teams[0].index = 1; saveDefenceTemplateFromMyBoard()');
    assert.equal(h.run('loadDefenceTemplate("5v5").teams[0].lineup'), undefined);
});

test("squad validation accepts progressive drafts and only deliberate undersizing can be confirmed", () => {
    for (const mode of ["5v5", "3v3"]) {
        const h = lineupSetup(mode);
        const options = { mode };
        assert.equal(writeLineup(h, { characterIds: ["A", "B"] }, options).ok, true);
        assert.equal(readLineup(h, "FRONT_TOP", mode).complete, false);
        assert.equal(writeLineup(h, { characterIds: ["A", "B"] }, { ...options, confirm: true }).ok, false);
        assert.equal(writeLineup(h, { characterIds: ["A", "B"], intentionalUndersize: true }, { ...options, confirm: true }).ok, true);
        assert.equal(readLineup(h, "FRONT_TOP", mode).confirmed, true);
        assert.equal(writeLineup(h, { characterIds: [], intentionalUndersize: true }, { ...options, confirm: true }).ok, false);
        const full = mode === "5v5" ? fullSquad : { characterIds: ["A", "B", "C"] };
        assert.equal(writeLineup(h, full, { ...options, confirm: true }).ok, true);
        for (const ids of [["A", "A"], ["UNKNOWN"], ["S1"], ["CAP"], ["A", "B", "C", "D", "E", "F"]]) {
            assert.equal(writeLineup(h, { characterIds: ids }, options).ok, false, ids.join(","));
        }
        assert.equal(writeLineup(h, { characterIds: ["A"], intentionalUndersize: "yes" }, options).ok, false);
    }
});

test("duplicate assignments are rejected across territories and detected in persisted corrupt data", () => {
    const h = lineupSetup();
    writeLineup(h, fullSquad, { confirm: true });
    const duplicate = writeLineup(h, { characterIds: ["A"] }, { territory: "BACK_BOTTOM", name: "Wall 3" });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.errors.join(), /duplicate-assignment:A/);
    assert.equal(readLineup(h).confirmed, true);
    const template = JSON.parse(h.values.get("defenceTemplate:5v5"));
    template.teams[3].lineup = { ...fullSquad, confirmed: true };
    h.values.set("defenceTemplate:5v5", JSON.stringify(template));
    assert.equal(readLineup(h).confirmed, false);
    assert.equal(readLineup(h, "BACK_BOTTOM").confirmed, false);
    assert.equal(writeLineup(h, null, { territory: "BACK_BOTTOM", name: "Wall 3" }).ok, true);
    assert.equal(readLineup(h).confirmed, true);
});

test("Fleet validates capital, starters and reinforcements separately without a reinforcement minimum", () => {
    const h = lineupSetup();
    const options = { territory: "BACK_TOP", name: "Fleet", confirm: true };
    for (const reinforcementIds of [[], ["S4"], ["S4", "S5", "S6", "S7"]]) {
        assert.equal(writeLineup(h, { ...fullFleet, reinforcementIds }, options).ok, true);
        assert.equal(readLineup(h, "BACK_TOP").confirmed, true);
    }
    for (const lineup of [
        { ...fullFleet, capitalShipId: "S4" }, { ...fullFleet, capitalShipId: "A" },
        { ...fullFleet, startingShipIds: ["S1", "S2", "CAP2"] },
        { ...fullFleet, startingShipIds: ["S1", "S2", "A"] },
        { ...fullFleet, reinforcementIds: ["CAP2"] },
        { ...fullFleet, reinforcementIds: ["S1"] },
        { ...fullFleet, reinforcementIds: ["S4", "S5", "S6", "S7", "S8"] },
        { ...fullFleet, startingShipIds: ["S1", "S2", "S3", "S4"] }
    ]) assert.equal(writeLineup(h, lineup, options).ok, false);
    assert.equal(writeLineup(h, { capitalShipId: "CAP", startingShipIds: ["S1"] }, { ...options, confirm: false }).ok, true);
    assert.equal(readLineup(h, "BACK_TOP").complete, false);
});

test("catalogue proposals are unconfirmed, exact, unique, mode-specific and size-aware", () => {
    const h = lineupSetup();
    h.run(`
        defenceCompositions = { "5v5": { Full: ["A", "B", "C", "D", "E"], Partial: ["A", "B"], Empty: [] }, ANY: { Full: ["F"] } };
        counterDefinitions = { CORE: {name: "Core", required: ["A", "B"]}, AMBIG1: {name: "Ambiguous", required: ["A"]}, AMBIG2: {name: "Ambiguous", required: ["B"]}, EMPTY: {name: "Empty", required: ["A", "B", "C", "D", "E"]} };
    `);
    const full = h.run('suggestDefenceLineup("Full", "5v5", "SQUAD")');
    assert.equal(full.confirmed, false);
    assert.equal(full.complete, true);
    assert.deepEqual(Array.from(full.lineup.characterIds), fullSquad.characterIds);
    assert.equal(h.run('suggestDefenceLineup("Partial", "5v5", "SQUAD").complete'), false);
    assert.equal(h.run('suggestDefenceLineup("Empty", "5v5", "SQUAD").complete'), false);
    assert.equal(h.run('suggestDefenceLineup("Core", "5v5", "SQUAD").source'), "required-core");
    assert.equal(h.run('suggestDefenceLineup("Core", "5v5", "SQUAD").complete'), false);
    assert.equal(h.run('suggestDefenceLineup("core", "5v5", "SQUAD")'), null);
    assert.equal(h.run('suggestDefenceLineup("Ambiguous", "5v5", "SQUAD")'), null);
    h.run('counterDefinitions.AMBIG2.required = []');
    assert.equal(h.run('suggestDefenceLineup("Ambiguous", "5v5", "SQUAD")'), null, "a second same-name definition remains ambiguous even without a usable core");
    h.run('defenceCompositions.FLEET = { Fleet: ["CAP", "S1", "S2", "S3", "S4"] }');
    const fleet = h.run('suggestDefenceLineup("Fleet", "5v5", "FLEET")');
    assert.equal(fleet.complete, false);
    assert.equal(fleet.confirmed, false);
    assert.deepEqual(Array.from(fleet.lineup.startingShipIds), [], "flat membership never asserts ship roles");
    assert.deepEqual(Array.from(fleet.suggestedCharacterIds), ["CAP", "S1", "S2", "S3", "S4"]);
});

test("authored underfilled Palpatine and SLKR rows stay incomplete while full rows remain suggestion-only", () => {
    const h = harness();
    const units = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "catalogue/source/units.json"))).units;
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "catalogue/source/defence-compositions.json"))).defenceCompositions;
    const compositions = {};
    rows.forEach(row => (compositions[row.mode] ||= {})[row.defence] = row.units);
    h.run(`characterDefinitions = ${JSON.stringify(Object.fromEntries(units.map(unit => [unit.id, unit])))}; defenceCompositions = ${JSON.stringify(compositions)}`);
    for (const name of ["Emperor Palpatine (Duel's End Vader)", "SLKR (Dark Side Vision Rey)"]) {
        const proposal = h.run(`suggestDefenceLineup(${JSON.stringify(name)}, "5v5", "SQUAD")`);
        assert.equal(proposal.complete, false, name);
        assert.equal(proposal.confirmed, false);
        assert.equal(proposal.lineup.intentionalUndersize, false);
    }
    const full = h.run('suggestDefenceLineup("Chief Chirpa", "5v5", "SQUAD")');
    assert.equal(full.complete, true);
    assert.equal(full.confirmed, false);
});

test("template lineup writes stay isolated by format and leave live snapshots and attack filtering unchanged", () => {
    const h = lineupSetup();
    writeLineup(h, fullSquad, { confirm: true });
    h.run(`
        const template3 = { ...loadDefenceTemplate("5v5"), mode: "3v3", teams: [{territory: "FRONT_TOP", index: 0, name: "Wall 0", customName: ""}] };
        persistDefenceTemplate(template3);
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.defenceSnapshot = {schema: 1, mode: "5v5", characterIds: ["F"], unresolvedTeams: [], missingSavedDefence: false};
        counterDefinitions = { ATTACK: {name: "Attack", required: ["A"]} };
        ownedCharacters = ["A"];
        saveBoard("opponent");
    `);
    const live = h.values.get("boardData");
    assert.equal(writeLineup(h, { characterIds: ["F", "B", "C"] }, { mode: "3v3", confirm: true }).ok, true);
    assert.deepEqual(Array.from(readLineup(h).lineup.characterIds), fullSquad.characterIds);
    assert.deepEqual(Array.from(readLineup(h, "FRONT_TOP", "3v3").lineup.characterIds), ["F", "B", "C"]);
    assert.equal(h.values.get("boardData"), live);
    assert.equal(h.run('getCounterStatus("ATTACK")'), "available");
    h.run('resetRound()');
    assert.equal(readLineup(h).confirmed, true);
    assert.equal(readLineup(h, "FRONT_TOP", "3v3").confirmed, true);
    h.run('clearDefenceTemplate("5v5")');
    assert.equal(h.values.has("defenceTemplate:5v5"), false);
    assert.equal(readLineup(h, "FRONT_TOP", "3v3").confirmed, true);
});


test("Fleet units cannot be assigned to two slots, including capital ships", () => {
    const h = lineupSetup();
    writeLineup(h, fullFleet, { territory: "BACK_TOP", name: "Fleet", confirm: true });
    h.run('myBoard.teams.push({territory: "BACK_TOP", index: 1, name: "Fleet two", customName: ""}); saveDefenceTemplateFromMyBoard()');
    const options = {territory: "BACK_TOP", index: 1, name: "Fleet two"};
    assert.match(writeLineup(h, {capitalShipId: "CAP"}, options).errors.join(), /duplicate-assignment:CAP/);
    assert.match(writeLineup(h, {capitalShipId: "CAP2", startingShipIds: ["S4", "S5", "S6"], reinforcementIds: ["S1"]}, options).errors.join(), /duplicate-assignment:S1/);
    assert.equal(writeLineup(h, {capitalShipId: "CAP2", startingShipIds: ["S4", "S5", "S6"]}, {...options, confirm: true}).ok, true);
    assert.equal(readLineup(h, "BACK_TOP").confirmed, true);
});
