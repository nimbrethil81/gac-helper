const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");

function proxy({ status = 200, body = "{}", failure = null } = {}) {
    const requests = [];
    const context = vm.createContext({
        ContentService: {
            createTextOutput: text => ({ setMimeType: () => text }),
            MimeType: { JSON: "json" }
        },
        UrlFetchApp: {
            fetch(url, options) {
                requests.push({ url, method: options.method, body: JSON.parse(options.payload) });
                if (failure) throw failure;
                return { getResponseCode: () => status, getContentText: () => body };
            }
        }
    });
    vm.runInContext(script, context, { filename: "Code.gs" });
    return {
        requests,
        fetch: account => JSON.parse(vm.runInContext(`doGet({parameter:{action:"roster", allyCode:${JSON.stringify(account)}}})`, context))
    };
}

test("roster proxy projects and deduplicates development from the existing player response", () => {
    const sixMods = Array.from({ length: 6 }, (_, id) => ({ id: `synthetic-${id}`, stats: [42] }));
    const rosterUnit = [
        { definitionId: "PRE:SEVEN_STAR", currentTier: 12, currentRarity: 7, relic: { currentTier: 1 }, equippedStatMod: [] },
        { definitionId: "BASE:FOUR_STAR", currentTier: 13, currentRarity: 4, relic: { currentTier: 2 }, equippedStatMod: sixMods, skill: [{ rank: 3 }] },
        { definitionId: "BASE:SEVEN_STAR", currentTier: 13, relic: { currentTier: 12 } },
        { definitionId: "MAX:FIVE_STAR", currentTier: 13, relic: { currentTier: 12 } },
        { definitionId: "WRONG:THREE_STAR", currentTier: 11, relic: { currentTier: 5 }, equippedStatMod: [null] },
        { definitionId: "PARTIAL:BAD", currentTier: "13", relic: { currentTier: 5 }, currentRarity: 2, equippedStatMod: [{ id: "synthetic" }] },
        { definitionId: "MISMATCH:SEVEN_STAR", currentTier: 1, currentRarity: 6, equippedStatMod: Array(7).fill({}) },
        { definitionId: "UNKNOWN", currentTier: 14, relic: { currentTier: 13 }, equippedStatMod: [{}] },
        null,
        { currentTier: 12 }
    ];
    const h = proxy({ body: JSON.stringify({ rosterUnit, playerName: "Synthetic" }) });
    const result = h.fetch("123456789");
    assert.deepEqual(h.requests, [{
        url: "https://gac-helper-comlink.onrender.com/player",
        method: "post",
        body: { payload: { allyCode: "123456789" }, enums: false }
    }]);
    assert.equal(result.ok, true);
    assert.equal(result.allyCode, "123456789");
    assert.ok(Number.isFinite(Date.parse(result.syncedAt)));
    assert.deepEqual(result.ownedBaseIds, ["PRE", "BASE", "MAX", "WRONG", "PARTIAL", "MISMATCH", "UNKNOWN"]);
    assert.deepEqual(result.development, {
        PRE: { gear: 12, stars: 7, modCount: 0 },
        BASE: { gear: 13, relic: 0, stars: 4, modCount: 6 },
        MAX: { gear: 13, relic: 10, stars: 5 },
        WRONG: { gear: 11, stars: 3 },
        PARTIAL: { stars: 2, modCount: 1 },
        MISMATCH: { gear: 1 }
    });
    assert.deepEqual(Object.keys(result).sort(), ["allyCode", "development", "ok", "ownedBaseIds", "syncedAt"]);
});

test("roster proxy keeps the legacy failure contract", () => {
    const invalid = proxy();
    assert.deepEqual(invalid.fetch("123"), { ok: false, error: "invalid_ally_code" });
    assert.equal(invalid.requests.length, 0);
    for (const [options, expected] of [
        [{ status: 404 }, { error: "not_found" }],
        [{ status: 429 }, { error: "rate_limited" }],
        [{ status: 503 }, { error: "fetch_failed", status: 503 }],
        [{ failure: new Error("mock failure") }, { error: "fetch_failed", detail: "Error: mock failure" }],
        [{ body: "{" }, { error: "bad_response" }],
        [{ body: "{}" }, { error: "not_found" }]
    ]) {
        assert.deepEqual(proxy(options).fetch("123456789"), { ok: false, ...expected });
    }
});
