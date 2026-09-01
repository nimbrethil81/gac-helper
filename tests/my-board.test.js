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

    assert.equal(h.run("JSON.stringify([board.schema, board.side, myBoard.schema, myBoard.side])"), JSON.stringify([4, "opponent", 4, "my"]));
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
