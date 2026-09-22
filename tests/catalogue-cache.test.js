const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function catalogue(name = "Leia") {
    return {
        counters: { "5v5": { [name]: [] }, "3v3": {} },
        counterDefinitions: {},
        characterDefinitions: {},
        boardConfig: {},
        scoring: [],
        defenceTeams: {},
        defenceCompositions: {}
    };
}

function cache(payload, overrides = {}) {
    return JSON.stringify({
        schema: 1,
        sourceContract: "apps-script-action-data:v1",
        acceptedAt: "2026-09-22T10:00:00.000Z",
        payload,
        ...overrides
    });
}

function harness({ storage = {}, fetchImpl } = {}) {
    const values = new Map(Object.entries(storage));
    const appElement = { innerHTML: "" };
    const context = {
        __GAC_HELPER_TEST__: true,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        fetch: fetchImpl,
        confirm: () => true,
        alert() {},
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
    return { values, appElement, run: expression => vm.runInContext(expression, context) };
}

function response(payload, ok = true) {
    return { ok, json: async () => payload };
}

test("a valid fresh catalogue is accepted and cached with versioned metadata", async () => {
    const fresh = catalogue("Fresh team");
    const h = harness({ fetchImpl: async () => response(fresh) });

    await h.run("loadData()");

    const stored = JSON.parse(h.values.get("catalogueCache:v1"));
    assert.equal(stored.schema, 1);
    assert.equal(stored.sourceContract, "apps-script-action-data:v1");
    assert.ok(Date.parse(stored.acceptedAt));
    assert.deepEqual(stored.payload, fresh);
    assert.equal(h.run("Object.keys(gacData['5v5'])[0]"), "Fresh team");
});

test("a cached catalogue renders before a deferred successful refresh", async () => {
    let resolveFetch;
    const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
    const h = harness({
        storage: { "catalogueCache:v1": cache(catalogue("Cached team")) },
        fetchImpl: () => pendingFetch
    });

    const loading = h.run("loadData()");
    assert.equal(h.run("Object.keys(gacData['5v5'])[0]"), "Cached team");
    assert.match(h.appElement.innerHTML, /Using saved catalogue/);

    resolveFetch(response(catalogue("Fresh team")));
    await loading;
    assert.equal(h.run("Object.keys(gacData['5v5'])[0]"), "Fresh team");
});

test("network, HTTP and JSON failures retain a valid cached catalogue", async () => {
    const cases = [
        () => Promise.reject(new Error("offline")),
        async () => response(catalogue(), false),
        async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } })
    ];

    for (const fetchImpl of cases) {
        const h = harness({
            storage: { "catalogueCache:v1": cache(catalogue("Cached team")) },
            fetchImpl
        });
        await h.run("loadData()");
        assert.equal(h.run("Object.keys(gacData['5v5'])[0]"), "Cached team");
        assert.match(h.appElement.innerHTML, /Couldn't check for updates/);
    }
});

test("an invalid fresh payload does not overwrite a valid cache", async () => {
    const original = cache(catalogue("Cached team"));
    const h = harness({
        storage: { "catalogueCache:v1": original },
        fetchImpl: async () => response({ counters: { "5v5": {}, "3v3": {} } })
    });

    await h.run("loadData()");

    assert.equal(h.values.get("catalogueCache:v1"), original);
    assert.equal(h.run("Object.keys(gacData['5v5'])[0]"), "Cached team");
});

test("cold-start failure shows catalogue unavailable without clearing user state", async () => {
    const h = harness({
        storage: {
            usedTeams: JSON.stringify(["LEIA"]),
            rosterData: JSON.stringify({ schema: 2, owned: ["LEIA"] }),
            boardData: JSON.stringify({ schema: 5 }),
            bannerData: JSON.stringify({ myScore: 10 })
        },
        fetchImpl: async () => response({ error: "temporary failure" })
    });

    await h.run("loadData()");

    assert.match(h.appElement.innerHTML, /Catalogue unavailable/);
    assert.equal(h.values.get("usedTeams"), JSON.stringify(["LEIA"]));
    assert.ok(h.values.has("rosterData"));
    assert.ok(h.values.has("boardData"));
    assert.ok(h.values.has("bannerData"));
});

test("invalid cached entries are rejected safely", async () => {
    const h = harness({
        storage: { "catalogueCache:v1": cache(catalogue("Invalid"), { acceptedAt: "not-a-date" }) },
        fetchImpl: () => Promise.reject(new Error("offline"))
    });

    await h.run("loadData()");

    assert.match(h.appElement.innerHTML, /Catalogue unavailable/);
    assert.equal(h.run("Object.keys(gacData).length"), 0);
});

test("the service worker leaves Apps Script requests to the application cache", () => {
    const worker = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
    assert.match(worker, /requestUrl\.origin !== self\.location\.origin\) return/);
    assert.match(worker, /app\.js validates and owns the only fallback cache/);
});
