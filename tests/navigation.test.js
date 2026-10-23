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
