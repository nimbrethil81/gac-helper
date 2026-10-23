const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const NOW = "2026-10-23T12:00:00.000Z";
const savedRoster = {
    schema: 2,
    savedAt: "2026-10-22T10:00:00.000Z",
    source: "swgoh.gg",
    allyCode: "123456789",
    syncedAt: "2026-10-22T09:00:00.000Z",
    owned: ["OLD_UNIT"]
};

function harness(storage = {}) {
    const values = new Map(Object.entries(storage));
    const context = {
        __GAC_HELPER_TEST__: true,
        console: { error() {} },
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [NOW])); }
        },
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    const run = expression => vm.runInContext(expression, context);
    // Keep this focused on roster state; rendering is covered by UI tests.
    run(`render = () => {}; characterDefinitions = {
        OLD_UNIT: { unitType: "CHARACTER" },
        REY: { unitType: "CHARACTER" },
        FALCON: { unitType: "SHIP" },
        EXECUTOR: { unitType: "CAPITAL_SHIP" }
    }; loadRoster();`);
    return { values, run, read: expression => JSON.parse(run(`JSON.stringify(${expression})`)) };
}

test("paste import replaces ownership, normalises IDs and preserves local account metadata with Undo", () => {
    const h = harness({ rosterData: JSON.stringify(savedRoster) });
    const incoming = {
        schema: 2, source: "manual", allyCode: "987654321", syncedAt: NOW,
        owned: ["REY", "FALCON", "REY", "EXECUTOR", "UNKNOWN", 42, null]
    };
    h.run(`importDraft = ${JSON.stringify(JSON.stringify(incoming))}; importRoster();`);

    const expected = { ...savedRoster, savedAt: NOW, source: "manual", owned: ["REY", "FALCON", "EXECUTOR"] };
    assert.deepEqual(h.read("ownedCharacters"), expected.owned);
    assert.deepEqual(JSON.parse(h.values.get("rosterData")), expected);
    assert.equal(h.run("importDraft"), "");
    assert.equal(h.run("rosterMessage.kind"), "warn");
    assert.match(h.run("rosterMessage.text"), /Imported 1 character and 2 ships.*Skipped 3 unrecognised/);

    h.run("undoImport()");
    assert.deepEqual(JSON.parse(h.values.get("rosterData")), { ...savedRoster, savedAt: NOW });
    assert.deepEqual(h.read("ownedCharacters"), savedRoster.owned);
});

test("paste import accepts a legacy bare array and defaults its provenance to import", () => {
    const h = harness();
    h.run(`importDraft = '["REY","FALCON"]'; importRoster();`);
    assert.deepEqual(JSON.parse(h.values.get("rosterData")), {
        schema: 2, savedAt: NOW, source: "import", allyCode: null, syncedAt: null,
        owned: ["REY", "FALCON"]
    });
    assert.equal(h.run("rosterMessage.kind"), "ok");
});

test("invalid or wholly unrecognised pasted data preserves a valid roster and its Undo snapshot", async t => {
    const cases = {
        "malformed JSON": '{"owned":[',
        "missing owned list": '{}',
        "malformed owned list": '{"owned":"REY"}',
        "empty owned list": '{"owned":[]}',
        "non-string IDs only": '{"owned":[42,null,{}]}',
        "unknown IDs only": '{"owned":["UNKNOWN","UNKNOWN"]}'
    };
    for (const [name, draft] of Object.entries(cases)) {
        await t.test(name, () => {
            const raw = JSON.stringify(savedRoster);
            const h = harness({ rosterData: raw });
            h.run("rosterBackup = { owned: ['FALCON'], meta: { source: 'manual' } }");
            const backup = h.read("rosterBackup");
            h.run(`importDraft = ${JSON.stringify(draft)}; importRoster();`);
            assert.equal(h.run("rosterMessage.kind"), "error");
            assert.deepEqual(h.read("ownedCharacters"), savedRoster.owned);
            assert.deepEqual(h.read("rosterMeta"), {
                savedAt: savedRoster.savedAt, source: savedRoster.source,
                allyCode: savedRoster.allyCode, syncedAt: savedRoster.syncedAt
            });
            assert.equal(h.values.get("rosterData"), raw);
            assert.deepEqual(h.read("rosterBackup"), backup);
        });
    }
});

test("schema-1 saved ownership loads without catalogue filtering and saves in the current schema", () => {
    // IDs absent from today's catalogue must survive a cached/older catalogue.
    const owned = ["REY", "NOT_IN_CURRENT_CATALOGUE"];
    const raw = JSON.stringify({ schema: 1, savedAt: savedRoster.savedAt, owned });
    const h = harness({ rosterData: raw });
    assert.deepEqual(h.read("ownedCharacters"), owned);
    assert.equal(h.values.get("rosterData"), raw, "loading does not rewrite a supported object");
    assert.deepEqual(h.read("rosterMeta"), {
        savedAt: savedRoster.savedAt, source: "manual", allyCode: null, syncedAt: null
    });
    h.run("saveRoster()");
    assert.deepEqual(JSON.parse(h.values.get("rosterData")), {
        schema: 2, savedAt: NOW, source: "manual", allyCode: null, syncedAt: null, owned
    });
});

test("current saved roster takes precedence over legacy data and round-trips account provenance", () => {
    const legacy = '["FALCON"]';
    const h = harness({ rosterData: JSON.stringify(savedRoster), ownedCharacters: legacy });
    assert.deepEqual(h.read("ownedCharacters"), savedRoster.owned);
    h.run("saveRoster()");
    const expected = { ...savedRoster, savedAt: NOW };
    assert.deepEqual(JSON.parse(h.values.get("rosterData")), expected);
    const reopened = harness({ rosterData: h.values.get("rosterData") });
    assert.deepEqual(reopened.read("ownedCharacters"), expected.owned);
    assert.deepEqual(reopened.read("rosterMeta"), {
        savedAt: NOW, source: expected.source, allyCode: expected.allyCode, syncedAt: expected.syncedAt
    });
    assert.equal(h.values.get("ownedCharacters"), legacy);
});

test("legacy bare-array ownership migrates when current storage is absent or corrupt", () => {
    for (const raw of [null, '{broken', '{"owned":"REY"}']) {
        const storage = { ownedCharacters: '["REY","NOT_IN_CURRENT_CATALOGUE"]' };
        if (raw !== null) storage.rosterData = raw;
        const h = harness(storage);
        const owned = ["REY", "NOT_IN_CURRENT_CATALOGUE"];
        assert.deepEqual(h.read("ownedCharacters"), owned);
        assert.deepEqual(JSON.parse(h.values.get("rosterData")), {
            schema: 2, savedAt: NOW, source: "manual", allyCode: null, syncedAt: null, owned
        });
        assert.equal(h.values.has("ownedCharacters"), false);
    }
});

test("corrupt stored blobs without usable legacy ownership load an empty roster without rewriting storage", () => {
    for (const legacy of ['{broken', '{"owned":["REY"]}']) {
        const storage = { rosterData: '{broken', ownedCharacters: legacy };
        const h = harness(storage);
        assert.deepEqual(h.read("ownedCharacters"), []);
        assert.deepEqual(h.read("rosterMeta"), { savedAt: null, source: "manual", allyCode: null, syncedAt: null });
        assert.deepEqual(Object.fromEntries(h.values), storage);
    }
});
