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
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        render();
    `);
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

test("explicit navigation to Roster still works", () => {
    const h = harness();
    h.run("setView('roster')");
    assert.equal(h.run("currentView"), "roster");
    assert.match(h.appElement.innerHTML, /MY ROSTER/);
});

test("explicit navigation to Round still works from another screen", () => {
    const h = harness();
    h.run("setView('counters')");
    h.run("setView('round')");
    assert.equal(h.run("currentView"), "round");
    assert.match(h.appElement.innerHTML, /SET UP ROUND/);
});
