const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const updates = fs.readFileSync(path.join(__dirname, "..", "app-updates.js"), "utf8");

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
        navigator: { onLine: false },
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
    vm.runInContext(updates, context, { filename: "app-updates.js" });
    vm.runInContext(source, context, { filename: "app.js" });
    return {
        values,
        alerts,
        appElement,
        run: expression => vm.runInContext(expression, context)
    };
}

function bottomNav(html) {
    const nav = html.match(/<nav class="bottom-nav">([\s\S]*?)<\/nav>/)[1];
    return [...nav.matchAll(/<button class="nav-button ([^"]*)"[^>]*onclick="setView\('([^']+)'\)">[\s\S]*?<\/span>\s*(\w+)\s*<\/button>/g)]
        .map(([, active, view, label]) => ({ active: active === "active", view, label }));
}

function click(h, buttonPattern) {
    const button = h.appElement.innerHTML.match(buttonPattern);
    assert.ok(button, "navigation control is present");
    h.run(button[1]);
}

function savedRoundStorage() {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        board.teams[0].name = "Saved enemy";
        board.teams[0].attempts = 2;
        myBoard = createCompanionMyBoard(board);
        myBoard.teams[1].customName = "Saved defence";
        myBoard.teams[1].cleared = true;
        saveBoard('opponent');
        saveBoard('my');
    `);
    return {
        ...Object.fromEntries(h.values),
        rosterData: JSON.stringify({ schema: 2, owned: ["REY"], source: "manual", savedAt: "2026-10-23T00:00:00Z" }),
        usedTeams: JSON.stringify(["used-counter"]),
        bannerData: JSON.stringify({ myScore: 123, oppScore: 234, remaining: null, oppFinal: true, scoresPrefilled: true }),
        "defenceTemplate:3v3": JSON.stringify({ schema: 1, mode: "3v3", teams: [] })
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

test("a fresh app entry defaults to the Round screen, not Counters", () => {
    const h = harness();
    assert.equal(h.run("currentView"), "round");
});

test("default entry with no active Round shows the normal Round setup state", () => {
    const h = harness();
    h.run("render()");
    assert.match(h.appElement.innerHTML, /SET UP ROUND/);
    assert.doesNotMatch(h.appElement.innerHTML, /id="teamSelect"/);
    assert.doesNotMatch(h.appElement.innerHTML, /MY ROSTER/);
});

test("default entry with an active Round shows the existing Round state, not the setup card", () => {
    const h = harness(savedRoundStorage());
    h.run("loadRoster(); loadBoard(); render()");
    assert.equal(h.run("currentView"), "round");
    assert.equal(h.run("board.mode"), "3v3");
    assert.equal(h.run("board.teams[0].attempts"), 2);
    assert.doesNotMatch(h.appElement.innerHTML, /SET UP ROUND/);
    assert.match(h.appElement.innerHTML, /Opponent Board/);
    assert.match(h.appElement.innerHTML, /My Board/);
});

test("Counters is no longer the default fallback screen in the bottom nav", () => {
    const h = harness();
    h.run("render()");
    assert.match(h.appElement.innerHTML, /nav-button active"[^>]*onclick="setView\('round'\)/);
    assert.doesNotMatch(h.appElement.innerHTML, /nav-button active"[^>]*onclick="setView\('counters'\)/);
});

test("explicit navigation to Counters still works and stays until the user navigates again", () => {
    const h = harness();
    h.run(`
        gacData = { "5v5": { "Leia Organa": [] } };
        setView('counters');
    `);
    assert.equal(h.run("currentView"), "counters");
    assert.match(h.appElement.innerHTML, /id="teamSelect"/);

    // Re-rendering without further navigation must not force the user back to Round.
    h.run("render()");
    assert.equal(h.run("currentView"), "counters");
});

test("More opens the existing My Roster screen with a return to More", () => {
    const h = harness(savedRoundStorage());
    h.run("loadRoster(); loadBoard(); render()");
    assert.deepEqual(bottomNav(h.appElement.innerHTML), [
        { active: false, view: "counters", label: "COUNTERS" },
        { active: true, view: "round", label: "ROUND" },
        { active: false, view: "more", label: "MORE" }
    ]);
    click(h, /<button class="nav-button [^"]*" onclick="(setView\('more'\))"/);
    assert.equal(h.run("currentView"), "more");
    assert.doesNotMatch(h.appElement.innerHTML, /MY ROSTER/);
    assert.match(h.appElement.innerHTML, /Defence Lineups/);
    assert.match(h.appElement.innerHTML, /My Roster/);
    assert.match(h.appElement.innerHTML, /Usage<\/span>[\s\S]*<h2 id="app-version-heading">App version<\/h2>/);
    assert.ok(h.appElement.innerHTML.includes(`v${h.run("APP_VERSION")} · Build unavailable`));
    click(h, /<button class="more-menu-entry" onclick="([^"]+)"/);
    assert.equal(h.run("currentView"), "roster");
    // Keep the existing renderer, import controls and filtering surface intact.
    assert.ok(h.appElement.innerHTML.includes(h.run("renderRoster()")));
    assert.match(h.appElement.innerHTML, /MY ROSTER/);
    assert.deepEqual(bottomNav(h.appElement.innerHTML).filter(b => b.active).map(b => b.view), ["more"]);
    click(h, /<button class="more-back" onclick="([^"]+)"/);
    assert.equal(h.run("currentView"), "more");
    assert.match(h.appElement.innerHTML, /My Roster/);
    assert.doesNotMatch(h.appElement.innerHTML, /more-back|MY ROSTER/);
});

test("app updates defer on local drafts, writes, operations and round Undo", async () => {
    const h = harness();
    const blocker = () => h.run("appUpdateBlocker()");
    assert.equal(blocker(), null);

    h.run("setBoardModeDraft('5v5')");
    assert.equal(blocker(), null, "choosing the already selected mode leaves no draft change");
    h.run("setBoardModeDraft('3v3')");
    assert.equal(blocker(), "editing");
    h.run("setBoardModeDraft('5v5'); defenceLineupEditor = { dirty: true }");
    assert.equal(blocker(), "editing");
    h.run("defenceLineupEditor = null; usageLineupEditor = { mode: 'FLEET' }");
    assert.equal(blocker(), "editing");
    h.run("usageLineupEditor = null; importDraft = 'unsaved roster paste'");
    assert.equal(blocker(), "editing");
    h.run("importDraft = ''; rosterMeta.allyCode = '123456789'; allyCodeDraft = ''");
    assert.equal(blocker(), "editing", "a deliberately emptied saved ally code is still a draft");
    h.run("allyCodeDraft = null; document.activeElement = { matches: () => true }");
    assert.equal(blocker(), "editing");
    h.run("document.activeElement = null; rosterRequest = {};");
    assert.equal(blocker(), "working");
    h.run("rosterRequest = null; pendingUndo = {};");
    assert.equal(blocker(), "undo");
    h.run("pendingUndo = null; rosterBackup = {};");
    assert.equal(blocker(), null, "roster Undo permits an explicit confirmation at update time");

    h.run(`const store = localStorage.setItem;
        localStorage.setItem = () => { throw new Error('quota'); };`);
    assert.throws(() => h.run("persistBannerData()"), /quota/);
    assert.equal(blocker(), "editing");
    h.run("localStorage.setItem = store; persistBannerData()");
    assert.equal(blocker(), null);

    h.run("let finishRead; const reading = new Promise(resolve => { finishRead = resolve; })");
    const importing = h.run("importUsageHistoryFile({ files: [{ size: 10, text: () => reading }] })");
    assert.equal(blocker(), "working");
    h.run("finishRead('{}')");
    await importing;
    assert.equal(blocker(), null);
});

test("failed battle notes stay available and block an update after blur and navigation", () => {
    const h = harness(savedRoundStorage());
    h.run(`loadBoard(); usageHistory.selectedSeasonId = '80';
        recordAttackUsage('used-counter', 'won', 'board', 'FRONT_TOP:0');
        const eventId = usageHistory.events[0].id;
        const details = { dataset: { eventId }, querySelector: () => ({ classList: { toggle() {} } }) };
        const note = { value: 'Keep this unsaved note', closest: () => details, setAttribute() {} };
        trackBattleEvidenceDraft(note, 'notes');`);
    assert.equal(h.run("appUpdateBlocker()"), "editing");
    h.run(`const store = localStorage.setItem;
        localStorage.setItem = () => { throw new Error('quota'); };
        commitBattleEvidence(note, 'notes');
        setView('more');`);
    assert.equal(h.run("appUpdateBlocker()"), "editing");
    assert.match(h.run("renderBattleDetails(usageHistory.events[0])"), /aria-invalid="true"[^>]*>Keep this unsaved note/);
    assert.equal(h.run("battleEvidenceFor(usageHistory.events[0]).notes"), "");
    h.run("localStorage.setItem = store; commitBattleEvidence(note, 'notes')");
    assert.equal(h.run("appUpdateBlocker()"), null);
    assert.equal(h.run("battleEvidenceFor(usageHistory.events[0]).notes"), "Keep this unsaved note");

    h.run(`updateBattleEvidence(eventId, 'actualBanners', '61');
        const banners = { ...note, value: '', validity: { badInput: true } };
        trackBattleEvidenceDraft(banners, 'actualBanners');
        commitPendingBattleEvidence({ ...banners, validity: { badInput: false } }, 'actualBanners');`);
    assert.equal(h.run("battleEvidenceFor(usageHistory.events[0]).actualBanners"), 61);
    assert.equal(h.run("appUpdateBlocker()"), "editing");
});

test("offline tab changes and My Roster re-entry preserve saved round and roster state", () => {
    const h = harness(savedRoundStorage());
    h.run("loadRoster(); loadBoard(); render()");
    const storedBefore = Object.fromEntries(h.values);
    const state = () => h.run("JSON.stringify({ board, myBoard, usedTeams, bannerData, ownedCharacters, rosterMeta })");
    const stateBefore = state();
    h.run(`
        rosterSearch = "Rey";
        rosterPanelOpen = true;
        allyCodeDraft = "123456789";
        setView('more');
        setView('roster');
        setView('counters');
        setView('round');
        setView('more');
        setView('roster');
    `);
    assert.equal(h.run("rosterSearch"), "Rey");
    assert.equal(h.run("rosterPanelOpen"), true);
    assert.equal(h.run("allyCodeDraft"), "123456789");
    assert.equal(state(), stateBefore);
    assert.deepEqual(Object.fromEntries(h.values), storedBefore);
    h.run("setView('round')");
    assert.match(h.appElement.innerHTML, /Saved enemy/);
    assert.doesNotMatch(h.appElement.innerHTML, /SET UP ROUND/);
    assert.equal(state(), stateBefore);
    assert.deepEqual(Object.fromEntries(h.values), storedBefore);
});

test("explicit navigation to Round still works from another screen", () => {
    const h = harness();
    h.run("setView('counters')");
    h.run("setView('round')");
    assert.equal(h.run("currentView"), "round");
    assert.match(h.appElement.innerHTML, /SET UP ROUND/);
});

for (const mode of ["5v5", "3v3"]) {
    test(`${mode} Round warning opens matching Defence Lineups and returns with side, focus and state intact`, () => {
        const h = harness();
        h.run(`
            board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
            myBoard = createCompanionMyBoard(board);
            myBoard.teams[0].name = "Frozen wall"; myBoard.teams[0].attempts = 2;
            saveDefenceTemplateFromMyBoard();
            board.defenceSnapshot = captureDefenceSnapshot(board.mode, myBoard);
            board.teams[0].attempts = 3;
            activeBoardSide = "my"; focusedTeamKey = "FRONT_TOP:0";
            usedTeams = ["spent-attacker"]; bannerData.remaining = 321;
            saveBoard("opponent"); saveBoard("my");
            defenceLineupsMode = "${mode === "5v5" ? "3v3" : "5v5"}";
            render();
        `);
        const state = () => h.run("JSON.stringify({board, myBoard, usedTeams, bannerData, activeBoardSide, focusedTeamKey})");
        const before = state();
        assert.match(h.appElement.innerHTML, /1 defence team needs lineup details/);
        click(h, /<button[^>]*onclick="(openRoundDefenceLineups\(\))"/);
        assert.equal(h.run("defenceLineupsMode"), mode);
        assert.equal(h.run("currentView"), "defence-lineups");
        assert.deepEqual(bottomNav(h.appElement.innerHTML).filter(b => b.active).map(b => b.view), ["more"]);
        assert.equal(state(), before);
        h.run(`openDefenceLineupEditor('FRONT_TOP', 0); editDefenceLineupMember('characterIds', 0, 'DRAFT'); confirm = () => false`);
        click(h, /<button[^>]*onclick="(setView\('round'\))"/);
        assert.equal(h.run("currentView"), "defence-lineups");
        assert.equal(h.run("defenceLineupEditor.dirty"), true);
        assert.equal(state(), before);
        h.run("confirm = () => true");
        click(h, /<button[^>]*onclick="(setView\('round'\))"/);
        assert.equal(h.run("currentView"), "round");
        assert.equal(state(), before);
        assert.match(h.appElement.innerHTML, /🛡️ MY BOARD/);
        assert.doesNotMatch(h.appElement.innerHTML, /setBoardTeam\('my'|setCustomTeamName\('my'|Clear template|Clear saved/);
    });
}

test("no-round setup links to the chosen format's templates without exposing round correction controls", () => {
    const h = harness();
    h.run(`boardModeDraft = '3v3'; render()`);
    assert.equal(h.run("renderDefenceSnapshotStatus()"), "");
    click(h, /<button[^>]*onclick="(defenceLineupsMode = '3v3'; setView\('defence-lineups'\))"/);
    assert.equal(h.run("defenceLineupsMode"), "3v3");
    assert.equal(h.run("board"), null);
    assert.doesNotMatch(h.appElement.innerHTML, /Back to Round|Apply saved lineup to this round|Use saved defence for this round/);
});
