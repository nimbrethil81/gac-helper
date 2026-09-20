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

test("defence templates persist identity only and remain format-specific", () => {
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
