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

function harness(storage = {}, fetchImpl = () => assert.fail("Unexpected request")) {
    const values = new Map(Object.entries(storage));
    const storageState = { failWrites: false };
    const context = {
        __GAC_HELPER_TEST__: true,
        console: { error() {} },
        AbortController, setTimeout, clearTimeout,
        fetch: fetchImpl,
        confirm: () => true,
        navigator: { onLine: true },
        document: { getElementById: () => null, querySelector: () => null },
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [NOW])); }
            static now() { return Date.parse(NOW); }
        },
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem(key, value) {
                if (storageState.failWrites) throw new Error("Quota exceeded");
                values.set(key, String(value));
            },
            removeItem: key => values.delete(key)
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    const run = expression => vm.runInContext(expression, context);
    // Keep this focused on roster state; rendering is covered by UI tests.
    run(`render = () => {}; characterDefinitions = {
        OLD_UNIT: { unitType: "CHARACTER", externalId: "OLD" },
        REY: { unitType: "CHARACTER", externalId: "EXT_REY" },
        FALCON: { unitType: "SHIP", externalId: "EXT_FALCON" },
        EXECUTOR: { unitType: "CAPITAL_SHIP", externalId: "EXT_EXECUTOR" }
    }; buildReverseIndex(); loadRoster();`);
    return { values, run, storageState, read: expression => JSON.parse(run(`JSON.stringify(${expression})`)) };
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

const ACCOUNT = "123456789";
const OTHER = "987654321";
const ENRICHED_AT = "2026-10-22T09:30:00.000Z";
const initialDevelopment = {
    source: "swgoh.gg",
    allyCode: ACCOUNT,
    syncedAt: ENRICHED_AT,
    units: { OLD_UNIT: { gear: 12, stars: 7 }, REY: { gear: 13, relic: 0, modCount: 0 } }
};
const enrichedRoster = { ...savedRoster, owned: ["OLD_UNIT", "REY"], development: initialDevelopment };

function response(ownedBaseIds, extras = {}) {
    return { ok: true, allyCode: ACCOUNT, syncedAt: NOW, ownedBaseIds, ...extras };
}

function apiHarness(record = enrichedRoster) {
    const pending = [];
    const h = harness({ rosterData: JSON.stringify(record) }, (url, { signal }) =>
        new Promise((resolve, reject) => {
            pending.push({ url, signal, respond: data => resolve({ json: async () => data }), reject });
        }));
    return { ...h, pending, stored: () => JSON.parse(h.values.get("rosterData")) };
}

test("enriched import validates independent facts, maps owned characters and exports ownership only", async () => {
    const h = apiHarness();
    const imported = h.run("importFromAllyCode()");
    h.pending[0].respond(response(["OLD", "EXT_REY", "EXT_FALCON", "EXT_EXECUTOR", "UNKNOWN"], {
        development: {
            OLD: { gear: 12, relic: 0, stars: 7, modCount: "0", skill: [{}] },
            EXT_REY: { gear: 13, relic: 10, stars: 5, modCount: 0, other: "unused" },
            EXT_FALCON: { gear: 13, relic: 0 },
            EXT_EXECUTOR: { gear: 12, modCount: 3 },
            UNKNOWN: { gear: 13, relic: 5 }
        }
    }));
    await imported;

    assert.equal(h.pending.length, 1);
    assert.deepEqual(h.stored().owned, ["OLD_UNIT", "REY", "FALCON", "EXECUTOR"]);
    assert.deepEqual(h.stored().development, {
        source: "swgoh.gg", allyCode: ACCOUNT, syncedAt: NOW,
        units: { OLD_UNIT: { gear: 12, stars: 7 }, REY: { gear: 13, relic: 10, stars: 5, modCount: 0 } }
    });
    const { development, ...ownership } = h.stored();
    assert.deepEqual(JSON.parse(h.run("buildExportPayload()")), ownership);
    assert.match(h.run("rosterMessage.text"), /1 unit not in/);

    const offline = harness({ rosterData: h.values.get("rosterData") });
    offline.run("navigator.onLine = false");
    await offline.run("maybeBackgroundSync()");
    assert.deepEqual(offline.read("rosterDevelopment"), development);
    assert.match(offline.run("renderRosterRow({id:'REY', name:'Rey', unitType:'CHARACTER'})"), /roster-investment">R10/);
    assert.match(offline.run("renderRosterRow({id:'OLD_UNIT', name:'Old', unitType:'CHARACTER'})"), /roster-investment">G12/);
    assert.doesNotMatch(offline.run("renderRosterRow({id:'REY', name:'Ship', unitType:'SHIP'})"), /roster-investment/);
    assert.doesNotMatch(offline.run("renderRosterRow({id:'UNKNOWN', name:'Unknown', unitType:'CHARACTER'})"), /roster-investment/);
});

test("ownership-only and malformed optional replies prune same-account development without re-dating it", async () => {
    for (const extras of [{}, { development: [] }, { development: null },
        { development: { EXT_REY: { gear: 12 } }, syncedAt: "bad timestamp" }]) {
        const h = apiHarness();
        const imported = h.run("importFromAllyCode()");
        h.pending[0].respond(response(["EXT_REY", "EXT_FALCON"], extras));
        await imported;
        assert.equal(h.stored().syncedAt, NOW);
        assert.deepEqual(h.stored().development, {
            ...initialDevelopment, units: { REY: initialDevelopment.units.REY }
        });
        assert.match(h.run("renderRosterRow({id:'REY', name:'Rey', unitType:'CHARACTER'})"), /roster-investment">R0/);
    }
});

test("fresh enriched snapshots remove absent facts, with no gear label when investment is unknown", async () => {
    const h = apiHarness();
    const imported = h.run("importFromAllyCode()");
    h.pending[0].respond(response(["OLD", "EXT_REY"], { development: { EXT_REY: { gear: 13, relic: null, modCount: 4 } } }));
    await imported;
    assert.deepEqual(h.stored().development.units, { REY: { gear: 13, modCount: 4 } });
    for (const id of ["OLD_UNIT", "REY"]) {
        assert.doesNotMatch(h.run(`renderRosterRow({id:'${id}', name:'Character', unitType:'CHARACTER'})`), /roster-investment/);
    }
});

test("different-account ownership-only import cannot inherit development and Undo restores it", async () => {
    const h = apiHarness();
    const imported = h.run(`allyCodeDraft = '${OTHER}'; importFromAllyCode()`);
    h.pending[0].respond(response(["EXT_REY"], { allyCode: OTHER }));
    await imported;
    assert.equal(h.stored().allyCode, OTHER);
    assert.equal(h.stored().development, undefined);
    h.run("undoImport()");
    assert.deepEqual(h.stored(), { ...enrichedRoster, savedAt: NOW });
});

test("background refresh applies development-only changes and Undo restores prior freshness", async () => {
    const h = apiHarness();
    const refreshing = h.run("maybeBackgroundSync()");
    await h.run("maybeBackgroundSync()");
    assert.equal(h.pending.length, 1);
    h.pending[0].respond(response(["OLD", "EXT_REY"], { development: {
        OLD: { gear: 13, relic: 0 }, EXT_REY: { gear: 13, relic: 1, modCount: 3 }
    } }));
    await refreshing;
    assert.deepEqual(h.stored().owned, enrichedRoster.owned);
    assert.equal(h.stored().development.units.OLD_UNIT.relic, 0);

    const stillFresh = h.run("maybeBackgroundSync()");
    await stillFresh;
    assert.equal(h.pending.length, 1);
    h.run("undoImport()");
    assert.deepEqual(h.stored(), { ...enrichedRoster, savedAt: NOW });
});

test("timestamp-only background refresh keeps the existing Undo snapshot", async () => {
    const h = apiHarness();
    h.run("rosterBackup = { owned: ['FALCON'], meta: { source: 'manual' } }");
    const oldUndo = h.read("rosterBackup");
    const refreshing = h.run("maybeBackgroundSync()");
    h.pending[0].respond(response(["EXT_REY", "OLD"], { development: {
        EXT_REY: initialDevelopment.units.REY, OLD: initialDevelopment.units.OLD_UNIT
    } }));
    await refreshing;
    assert.equal(h.stored().development.syncedAt, NOW);
    assert.deepEqual(h.read("rosterBackup"), oldUndo);
});

test("foreground request reuses same-account background work and supersedes a different account", async t => {
    await t.test("same account reuses the request and gives foreground feedback", async () => {
        const h = apiHarness();
        const background = h.run("maybeBackgroundSync()");
        const foreground = h.run("currentView = 'roster'; importFromAllyCode()");
        await h.run("importFromAllyCode()");
        assert.equal(h.pending.length, 1);
        h.pending[0].respond(response(["EXT_REY"]));
        await Promise.all([background, foreground]);
        assert.deepEqual(h.stored().owned, ["REY"]);
        assert.equal(h.run("rosterMessage.kind"), "ok");
    });
    await t.test("a late older response cannot replace the new account", async () => {
        const h = apiHarness();
        const background = h.run("maybeBackgroundSync()");
        const foreground = h.run(`allyCodeDraft = '${OTHER}'; importFromAllyCode()`);
        assert.equal(h.pending.length, 2);
        assert.equal(h.pending[0].signal.aborted, true);
        h.pending[1].respond(response(["EXT_FALCON"], { allyCode: OTHER }));
        await foreground;
        h.pending[0].respond(response(["EXT_REY"]));
        await background;
        assert.deepEqual(h.stored().owned, ["FALCON"]);
        assert.equal(h.stored().allyCode, OTHER);
        assert.equal(h.stored().development, undefined);
    });
});

test("late replies cannot overwrite manual edits, clear, or a background refresh while editing", async () => {
    for (const [start, edit] of [
        ["importFromAllyCode()", "toggleOwned('REY')"],
        ["importFromAllyCode()", "clearRoster()"],
        ["maybeBackgroundSync()", "currentView = 'roster'"]
    ]) {
        const h = apiHarness();
        const request = h.run(start);
        h.run(edit);
        const afterEdit = h.stored();
        h.pending[0].respond(response(["EXT_FALCON"], { development: {} }));
        await request;
        assert.deepEqual(h.stored(), afterEdit);
        assert.equal(h.run("rosterRequest"), null);
    }
});

test("manual edits prune development, paste clears it, and Clear keeps Usage history", () => {
    const h = apiHarness();
    h.values.set("usageHistory", "untouched");
    h.run("toggleOwned('REY'); toggleOwned('REY')");
    assert.deepEqual(h.stored().development.units, { OLD_UNIT: initialDevelopment.units.OLD_UNIT });

    const pasted = { ...enrichedRoster, allyCode: OTHER, owned: ["REY"] };
    h.run(`importDraft = ${JSON.stringify(JSON.stringify(pasted))}; importRoster();`);
    assert.equal(h.stored().development, undefined);
    assert.equal(h.stored().source, "import");
    assert.equal(h.stored().allyCode, ACCOUNT);
    h.run("undoImport()");
    assert.deepEqual(h.stored().development.units, { OLD_UNIT: initialDevelopment.units.OLD_UNIT });

    h.run("clearRoster()");
    assert.deepEqual(h.stored().owned, []);
    assert.equal(h.stored().development, undefined);
    assert.equal(h.stored().allyCode, null);
    assert.equal(h.stored().syncedAt, null);
    assert.equal(h.values.get("usageHistory"), "untouched");
});

test("failed, mismatched and malformed sync responses leave the roster and Undo intact", async () => {
    const failures = [
        pending => pending.reject(new Error("Offline")),
        pending => pending.respond({ ok: false, error: "rate_limited" }),
        pending => pending.respond(response("bad list")),
        pending => pending.respond(response(["EXT_REY", {}])),
        pending => pending.respond(response(["EXT_REY"], { allyCode: OTHER })),
        pending => pending.respond(response(["UNKNOWN"]))
    ];
    for (const fail of failures) {
        const h = apiHarness();
        const request = h.run("importFromAllyCode()");
        fail(h.pending[0]);
        await request;
        assert.deepEqual(h.stored(), enrichedRoster);
        assert.deepEqual(h.read("rosterDevelopment"), initialDevelopment);
        assert.equal(h.run("rosterBackup"), null);
        assert.equal(h.run("rosterMessage.kind"), "error");
    }
});

test("quota errors preserve disk, memory and Undo for both refresh paths and local edits", async () => {
    const h = apiHarness();
    h.run("rosterBackup = { owned: ['FALCON'], meta: { source: 'manual' }, development: null }");
    const undo = h.read("rosterBackup");
    h.storageState.failWrites = true;
    const assertUnchanged = () => {
        assert.deepEqual(h.stored(), enrichedRoster);
        assert.deepEqual(h.read("ownedCharacters"), enrichedRoster.owned);
        assert.deepEqual(h.read("rosterDevelopment"), initialDevelopment);
        assert.deepEqual(h.read("rosterBackup"), undo);
    };
    for (const mode of ["maybeBackgroundSync()", "importFromAllyCode()"]) {
        const syncing = h.run(mode);
        h.pending.at(-1).respond(response(["EXT_FALCON"], { development: {} }));
        await syncing;
        assertUnchanged();
    }
    for (const operation of ["toggleOwned('REY')", "clearRoster()", "undoImport()", "importDraft = '[\"FALCON\"]'; importRoster()"]) {
        h.run(operation);
        assertUnchanged();
        assert.equal(h.run("rosterMessage.kind"), "error");
    }
});

test("cached development requires matching provenance, and ally input safely renders malformed storage", () => {
    const h = harness({ rosterData: JSON.stringify({
        ...enrichedRoster, allyCode: '"><img src=x>', development: initialDevelopment
    }) });
    assert.equal(h.run("rosterDevelopment"), null);
    const card = h.run("renderRosterImportCard()");
    assert.match(card, /value="&quot;&gt;&lt;img src=x&gt;"/);
    assert.doesNotMatch(card, /<img/);
});

test("a pending response cannot overwrite another tab's saved account", async () => {
    const h = apiHarness();
    const request = h.run("importFromAllyCode()");
    const otherRecord = { ...savedRoster, allyCode: OTHER, owned: ["FALCON"] };
    h.values.set("rosterData", JSON.stringify(otherRecord));
    h.pending[0].respond(response(["EXT_REY"], { development: {} }));
    await request;
    assert.deepEqual(h.stored(), otherRecord);
    assert.equal(h.run("rosterRequest"), null);
});

test("the 60-second timeout covers the roster response body", async () => {
    let bodyStarted;
    const started = new Promise(resolve => { bodyStarted = resolve; });
    const h = harness({}, async (_url, { signal }) => ({
        json: () => new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            bodyStarted();
        })
    }));
    h.run(`let timeout, timeoutMs;
        setTimeout = (fn, ms) => { timeout = fn; timeoutMs = ms; };
        clearTimeout = () => {};
        allyCodeDraft = "${ACCOUNT}";
    `);
    const request = h.run("importFromAllyCode()");
    await started;
    assert.equal(h.run("timeoutMs"), 60000);
    h.run("timeout()");
    await request;
    assert.match(h.run("rosterMessage.text"), /took too long/);
    assert.equal(h.values.has("rosterData"), false);
});
