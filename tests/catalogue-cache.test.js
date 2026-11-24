"use strict";

// Static catalogue client (issue #43, ADR-ARCH-116 §8): pointer + immutable
// release loading, the v1 → v2 cache migration, failure handling and the
// service-worker bypass. app.js runs in a vm with an in-memory "Pages" fetch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const { compileSource, readSource, releaseContract } = require("../scripts/catalogue-source-lib.js");
const { renderRelease } = require("../scripts/catalogue-release-lib.js");
const { PAGES_APP_FILES, buildAppShell } = require("../scripts/app-shell-lib.js");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const ROSTER_API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

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

// Release file and pointer exactly as the Pages build writes them.
function published(payload, catalogueVersion = 7) {
    const release = renderRelease(payload, catalogueVersion);
    const pointer = {
        pointerSchema: 1,
        contract: releaseContract(payload),
        catalogueVersion,
        checksum: release.checksum,
        path: release.path,
        bytes: release.bytes
    };
    return { release, pointer, files: { "catalogue/current.json": JSON.stringify(pointer, null, 2) + "\n", [`catalogue/${release.path}`]: release.text } };
}

function v1Cache(payload, overrides = {}) {
    return JSON.stringify({
        schema: 1,
        sourceContract: "apps-script-action-data:v1",
        acceptedAt: "2026-09-22T10:00:00.000Z",
        payload,
        ...overrides
    });
}

function v2Cache(payload, catalogueVersion = 6, overrides = {}) {
    return JSON.stringify({
        schema: 2,
        sourceContract: "gac-catalogue-release:v1",
        acceptedAt: "2026-10-10T10:00:00.000Z",
        catalogueVersion,
        checksum: payloadChecksum(payload),
        payload,
        ...overrides
    });
}

function textResponse(text, ok = true) {
    return { ok, status: ok ? 200 : 404, text: async () => text };
}

// A static host: relative URLs map to files; anything else is a 404.
function pages(files) {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url, cache: options.cache });
        return Object.hasOwn(files, url) ? textResponse(files[url]) : textResponse("Not found", false);
    };
    return { requests, fetchImpl };
}

function harness({ storage = {}, fetchImpl, setItem } = {}) {
    const values = new Map(Object.entries(storage));
    let renders = 0;
    let html = "";
    const appElement = {
        get innerHTML() { return html; },
        set innerHTML(value) { renders += 1; html = value; }
    };
    const localStorage = {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => setItem ? setItem(values, key, String(value)) : values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
    const context = { URL,
        __GAC_HELPER_TEST__: true,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        TextEncoder,
        crypto: globalThis.crypto,
        fetch: fetchImpl,
        confirm: () => true,
        alert() {},
        navigator: {},
        localStorage,
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
        appElement,
        renders: () => renders,
        run: expression => vm.runInContext(expression, context)
    };
}

const firstDefence = h => h.run("Object.keys(gacData['5v5'])[0]");

test("a cold start fetches the pointer, then the release, and caches it as v2", async () => {
    const fresh = catalogue("Fresh team");
    const site = published(fresh, 7);
    const host = pages(site.files);
    const h = harness({ fetchImpl: host.fetchImpl });

    await h.run("loadData()");

    assert.deepEqual(host.requests, [
        { url: "catalogue/current.json", cache: "no-cache" },
        { url: `catalogue/${site.release.path}`, cache: undefined }
    ]);
    const stored = JSON.parse(h.values.get("catalogueCache:v2"));
    assert.equal(stored.schema, 2);
    assert.equal(stored.sourceContract, "gac-catalogue-release:v1");
    assert.equal(stored.catalogueVersion, 7);
    assert.equal(stored.checksum, site.release.checksum);
    assert.ok(Date.parse(stored.acceptedAt));
    assert.deepEqual(stored.payload, fresh);
    assert.equal(firstDefence(h), "Fresh team");
    assert.equal(h.values.has("catalogueCache:v1"), false);
});

test("the client accepts the real compiled catalogue with the same checksum as the release builder", async () => {
    const { source: catalogueSource } = readSource(path.join(ROOT, "catalogue", "source"));
    const payload = compileSource(catalogueSource);
    const record = JSON.parse(fs.readFileSync(path.join(ROOT, "catalogue", "release.json"), "utf8"));
    const site = published(payload, record.catalogueVersion);
    assert.equal(site.release.checksum, record.checksum);
    const h = harness({ fetchImpl: pages(site.files).fetchImpl });

    assert.equal(await h.run(`catalogueChecksum(${JSON.stringify(payload)})`), record.checksum);
    await h.run("loadData()");

    const stored = JSON.parse(h.values.get("catalogueCache:v2"));
    assert.equal(stored.checksum, record.checksum);
    assert.equal(stored.catalogueVersion, record.catalogueVersion);
    assert.equal(h.run("Object.keys(counterDefinitions).length"), Object.keys(payload.counterDefinitions).length);
    assert.equal(h.run("Object.keys(baseIdToUnit).length") > 0, true);
});

test("a same-version launch requests only the pointer and renders once", async () => {
    const payload = catalogue("Cached team");
    const site = published(payload, 6);
    const host = pages(site.files);
    const cached = v2Cache(payload, 6);
    const h = harness({ storage: { "catalogueCache:v2": cached }, fetchImpl: host.fetchImpl });

    const loading = h.run("loadData()");
    assert.equal(firstDefence(h), "Cached team");   // rendered from cache before any network result
    assert.equal(h.renders(), 1);
    await loading;

    assert.deepEqual(host.requests.map(r => r.url), ["catalogue/current.json"]);
    assert.equal(h.renders(), 1);
    assert.equal(h.values.get("catalogueCache:v2"), cached);
    assert.doesNotMatch(h.appElement.innerHTML, /Couldn't check/);
});

test("a changed catalogue renders from cache first, then downloads, applies and re-caches", async () => {
    let releasePointer;
    const fresh = published(catalogue("Fresh team"), 7);
    const pendingPointer = new Promise(resolve => { releasePointer = resolve; });
    const fetchImpl = async url => {
        if (url === "catalogue/current.json") { await pendingPointer; return textResponse(fresh.files[url]); }
        return textResponse(fresh.files[url]);
    };
    const h = harness({ storage: { "catalogueCache:v2": v2Cache(catalogue("Cached team"), 6) }, fetchImpl });

    const loading = h.run("loadData()");
    assert.equal(firstDefence(h), "Cached team");

    releasePointer();
    await loading;
    assert.equal(firstDefence(h), "Fresh team");
    assert.equal(h.renders(), 2);
    const stored = JSON.parse(h.values.get("catalogueCache:v2"));
    assert.equal(stored.catalogueVersion, 7);
    assert.deepEqual(stored.payload, catalogue("Fresh team"));
});

test("an upgrading user's v1 Apps Script cache renders offline and is kept for rollback", async () => {
    const legacy = v1Cache(catalogue("Sheet team"));
    const h = harness({ storage: { "catalogueCache:v1": legacy }, fetchImpl: () => Promise.reject(new TypeError("offline")) });

    await h.run("loadData()");

    assert.equal(firstDefence(h), "Sheet team");
    assert.match(h.appElement.innerHTML, /Using saved catalogue\. Couldn't check for updates/);
    assert.equal(h.values.get("catalogueCache:v1"), legacy);
    assert.equal(h.values.has("catalogueCache:v2"), false);
});

test("a v1 cache migrates to v2 on the first successful refresh without being modified", async () => {
    const legacy = v1Cache(catalogue("Sheet team"));
    const site = published(catalogue("Release team"), 6);
    const h = harness({ storage: { "catalogueCache:v1": legacy }, fetchImpl: pages(site.files).fetchImpl });

    await h.run("loadData()");

    assert.equal(firstDefence(h), "Release team");
    assert.equal(JSON.parse(h.values.get("catalogueCache:v2")).checksum, site.release.checksum);
    assert.equal(h.values.get("catalogueCache:v1"), legacy);

    // The next launch prefers v2.
    const next = harness({ storage: Object.fromEntries(h.values), fetchImpl: () => Promise.reject(new TypeError("offline")) });
    await next.run("loadData()");
    assert.equal(firstDefence(next), "Release team");
});

test("a v1 cache that already matches the live checksum is promoted without downloading the release", async () => {
    const payload = catalogue("Same team");
    const site = published(payload, 6);
    const host = pages(site.files);
    const h = harness({ storage: { "catalogueCache:v1": v1Cache(payload) }, fetchImpl: host.fetchImpl });

    await h.run("loadData()");

    assert.deepEqual(host.requests.map(r => r.url), ["catalogue/current.json"]);
    const stored = JSON.parse(h.values.get("catalogueCache:v2"));
    assert.equal(stored.checksum, site.release.checksum);
    assert.equal(stored.catalogueVersion, 6);
    assert.equal(h.renders(), 1);
});

test("network, HTTP, JSON, contract, size and checksum failures keep the cached catalogue untouched", async () => {
    const good = published(catalogue("Fresh team"), 7);
    const pointerPath = "catalogue/current.json";
    const releasePath = `catalogue/${good.release.path}`;
    const pointerWith = changes => JSON.stringify({ ...good.pointer, ...changes });
    const releaseDocument = JSON.parse(good.release.text);
    const tamperedRelease = JSON.stringify({ ...releaseDocument, counters: { "5v5": { Tampered: [] }, "3v3": {} } });
    const cases = {
        "offline": () => Promise.reject(new TypeError("Failed to fetch")),
        "pointer 404": pages({}).fetchImpl,
        "pointer HTML error page": pages({ [pointerPath]: "<html>Service unavailable</html>" }).fetchImpl,
        "pointer unknown contract": pages({ ...good.files, [pointerPath]: pointerWith({ contract: "gac-catalogue-release:v3" }) }).fetchImpl,
        "pointer unknown schema": pages({ ...good.files, [pointerPath]: pointerWith({ pointerSchema: 2 }) }).fetchImpl,
        "pointer bad version": pages({ ...good.files, [pointerPath]: pointerWith({ catalogueVersion: 0 }) }).fetchImpl,
        "pointer path outside releases": pages({ ...good.files, [pointerPath]: pointerWith({ path: "../app.js" }) }).fetchImpl,
        "release 404 during a deploy": pages({ [pointerPath]: good.files[pointerPath] }).fetchImpl,
        "truncated release": pages({ ...good.files, [releasePath]: good.release.text.slice(0, -40) }).fetchImpl,
        "invalid release JSON": pages({ ...good.files, [pointerPath]: pointerWith({ bytes: 9 }), [releasePath]: "{not json" }).fetchImpl,
        "release checksum mismatch": pages({ ...good.files, [pointerPath]: pointerWith({ bytes: Buffer.byteLength(tamperedRelease) }), [releasePath]: tamperedRelease }).fetchImpl,
        "release contract mismatch": (() => {
            const text = JSON.stringify({ ...releaseDocument, release: { ...releaseDocument.release, contract: "other" } });
            return pages({ ...good.files, [pointerPath]: pointerWith({ bytes: Buffer.byteLength(text) }), [releasePath]: text }).fetchImpl;
        })(),
        "release names another checksum": (() => {
            const text = JSON.stringify({ ...releaseDocument, release: { ...releaseDocument.release, checksum: `sha256:${"0".repeat(64)}` } });
            return pages({ ...good.files, [pointerPath]: pointerWith({ bytes: Buffer.byteLength(text) }), [releasePath]: text }).fetchImpl;
        })(),
        "release missing a payload key": (() => {
            const { scoring, ...rest } = releaseDocument;
            const text = JSON.stringify(rest);
            return pages({ ...good.files, [pointerPath]: pointerWith({ bytes: Buffer.byteLength(text) }), [releasePath]: text }).fetchImpl;
        })()
    };

    for (const [name, fetchImpl] of Object.entries(cases)) {
        const cached = v2Cache(catalogue("Cached team"), 6);
        const h = harness({ storage: { "catalogueCache:v2": cached }, fetchImpl });
        await h.run("loadData()");
        assert.equal(firstDefence(h), "Cached team", name);
        assert.equal(h.values.get("catalogueCache:v2"), cached, name);
        assert.match(h.appElement.innerHTML, /Couldn't check for updates/, name);
    }
});

test("a stalled pointer or release transfer times out instead of hanging", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const site = published(catalogue("Fresh team"), 7);
    for (const stalled of ["catalogue/current.json", `catalogue/${site.release.path}`]) {
        let bodyRequested;
        const stalling = new Promise(resolve => { bodyRequested = resolve; });
        const fetchImpl = async (url, options) => {
            if (url !== stalled) return textResponse(site.files[url]);
            // Headers arrive; the body never does until the request is aborted.
            return {
                ok: true,
                text: () => {
                    bodyRequested();
                    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
                }
            };
        };
        const cached = v2Cache(catalogue("Cached team"), 6);
        const h = harness({ storage: { "catalogueCache:v2": cached }, fetchImpl });
        const loading = h.run("loadData()");
        await stalling;
        t.mock.timers.tick(30000);
        await loading;
        assert.equal(firstDefence(h), "Cached team", stalled);
        assert.equal(h.values.get("catalogueCache:v2"), cached, stalled);
        assert.match(h.appElement.innerHTML, /Couldn't check for updates/, stalled);
    }
});

test("a full quota gives up the v1 rollback copy before the current catalogue", async () => {
    const site = published(catalogue("Fresh team"), 7);
    const quota = (values, key, value) => {
        if (key === "catalogueCache:v2" && values.has("catalogueCache:v1")) throw new Error("QuotaExceededError");
        values.set(key, value);
    };
    const h = harness({ storage: { "catalogueCache:v1": v1Cache(catalogue("Sheet team")) }, fetchImpl: pages(site.files).fetchImpl, setItem: quota });

    await h.run("loadData()");

    assert.equal(firstDefence(h), "Fresh team");
    assert.equal(h.values.has("catalogueCache:v1"), false);
    assert.equal(JSON.parse(h.values.get("catalogueCache:v2")).catalogueVersion, 7);
});

test("a verified release that cannot be stored is still used, leaving the old cache intact", async () => {
    const site = published(catalogue("Fresh team"), 7);
    const cached = v2Cache(catalogue("Cached team"), 6);
    const noRoom = (values, key, value) => {
        if (key === "catalogueCache:v2") throw new Error("QuotaExceededError");
        values.set(key, value);
    };
    const h = harness({ storage: { "catalogueCache:v2": cached }, fetchImpl: pages(site.files).fetchImpl, setItem: noRoom });

    await h.run("loadData()");

    assert.equal(firstDefence(h), "Fresh team");
    assert.equal(h.values.get("catalogueCache:v2"), cached);
    assert.doesNotMatch(h.appElement.innerHTML, /Couldn't check/);

    const cold = harness({ fetchImpl: pages(site.files).fetchImpl, setItem: noRoom });
    await cold.run("loadData()");
    assert.equal(firstDefence(cold), "Fresh team");
});

test("cold-start failure shows catalogue unavailable without clearing user state", async () => {
    const storage = {
        usedTeams: JSON.stringify(["LEIA"]),
        rosterData: JSON.stringify({ schema: 2, owned: ["LEIA"] }),
        boardData: JSON.stringify({ schema: 5 }),
        bannerData: JSON.stringify({ myScore: 10 })
    };
    const h = harness({ storage, fetchImpl: pages({}).fetchImpl });

    await h.run("loadData()");

    assert.match(h.appElement.innerHTML, /Catalogue unavailable/);
    for (const [key, value] of Object.entries(storage)) assert.equal(h.values.get(key), value, key);
});

test("invalid cached entries are rejected safely", async () => {
    const payload = catalogue("Invalid");
    const entries = [
        { "catalogueCache:v1": v1Cache(payload, { acceptedAt: "not-a-date" }) },
        { "catalogueCache:v2": v2Cache(payload, 6, { checksum: "md5:abc" }) },
        { "catalogueCache:v2": v2Cache(payload, 6, { sourceContract: "apps-script-action-data:v1" }) },
        { "catalogueCache:v2": v2Cache({ counters: {} }, 6) },
        { "catalogueCache:v2": "{corrupt" }
    ];
    for (const storage of entries) {
        const h = harness({ storage, fetchImpl: () => Promise.reject(new TypeError("offline")) });
        await h.run("loadData()");
        assert.match(h.appElement.innerHTML, /Catalogue unavailable/, Object.values(storage)[0]);
        assert.equal(h.run("Object.keys(gacData).length"), 0);
    }

    // An unusable v2 entry falls back to a valid v1 cache.
    const h = harness({
        storage: { "catalogueCache:v2": "{corrupt", "catalogueCache:v1": v1Cache(catalogue("Sheet team")) },
        fetchImpl: () => Promise.reject(new TypeError("offline"))
    });
    await h.run("loadData()");
    assert.equal(firstDefence(h), "Sheet team");
});

test("a catalogue update mid-round leaves saved personal game state untouched", async () => {
    const site = published(catalogue("Fresh team"), 7);
    const personal = {
        usedTeams: JSON.stringify(["LEIA", "BANE"]),
        rosterData: JSON.stringify({ schema: 2, savedAt: "2026-10-09T10:00:00.000Z", source: "manual", allyCode: null, syncedAt: null, owned: ["LEIA_ORGANA"] }),
        boardData: JSON.stringify({ schema: 5, league: "KYBER", mode: "5v5", createdAt: "2026-10-10T08:00:00.000Z", roundId: "r1", territories: [], teams: [], defenceSnapshot: { mode: "5v5", unitIds: ["DARTH_BANE"], unresolved: [] } }),
        myBoardData: JSON.stringify({ schema: 5, league: "KYBER", mode: "5v5", createdAt: "2026-10-10T08:00:00.000Z", roundId: "r1", territories: [], teams: [] }),
        bannerData: JSON.stringify({ myScore: 123, opponentScore: 98 }),
        "defenceTemplate:5v5": JSON.stringify({ schema: 2, mode: "5v5", teams: [{
            territory: "FRONT_TOP", index: 0, name: "Saved wall", customName: "",
            lineup: { characterIds: ["DARTH_BANE"], intentionalUndersize: true, confirmed: true }
        }] }),
        gacLeague: "KYBER",
        gacLastSquadMode: "3v3"
    };
    const h = harness({ storage: { ...personal, "catalogueCache:v2": v2Cache(catalogue("Cached team"), 6) }, fetchImpl: pages(site.files).fetchImpl });

    await h.run("loadData()");

    assert.equal(firstDefence(h), "Fresh team");
    for (const [key, value] of Object.entries(personal)) assert.equal(h.values.get(key), value, key);
});

test("catalogue loading is same-origin; roster import still uses the Apps Script proxy", async () => {
    const site = published(catalogue(), 7);
    const host = pages(site.files);
    const h = harness({ fetchImpl: host.fetchImpl });
    await h.run("loadData()");

    assert.ok(host.requests.every(r => !/^[a-z]+:/i.test(r.url)), "catalogue URLs are relative to the app");
    assert.equal(h.run("ROSTER_API_URL"), ROSTER_API_URL);
    assert.doesNotMatch(source, /CATALOGUE_API_URL/);

    let rosterUrl;
    const roster = harness({ fetchImpl: async url => { rosterUrl = url; return { ok: true, json: async () => ({ ok: false, error: "not_found" }) }; } });
    await roster.run("fetchRosterFromApi('123456789')");
    assert.equal(rosterUrl, `${ROSTER_API_URL}?action=roster&allyCode=123456789`);
});

// ─── service worker ─────────────────────────────────────────────────────────

const shell = buildAppShell(file => fs.readFileSync(path.join(ROOT, file)));

function worker(scope, { override = {}, saved = new Map(), matchAll = async () => [] } = {}) {
    const listeners = {};
    const requests = [];
    let activations = 0;
    const name = `gac-app-shell:${new URL(scope).pathname}:${shell.metadata.buildId}`;
    const cacheApi = entries => ({
        match: async url => entries.get(url)?.clone(),
        put: async (url, response) => entries.set(url, response.clone())
    });
    const caches = {
        keys: async () => [...saved.keys()],
        has: async key => saved.has(key),
        open: async key => {
            if (!saved.has(key)) saved.set(key, new Map());
            return cacheApi(saved.get(key));
        },
        match: async (url, { cacheName }) => saved.get(cacheName)?.get(url)?.clone(),
        delete: async key => saved.delete(key)
    };
    vm.runInNewContext(shell.files["service-worker.js"].toString("utf8"), {
        URL, Response, AbortController, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, caches,
        self: {
            registration: { scope }, clients: { matchAll },
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => { activations++; }
        },
        fetch: async (url, options) => {
            const href = typeof url === "string" ? url : url.url;
            requests.push({ href, options });
            const file = new URL(href).pathname.slice(new URL(scope).pathname.length) || "index.html";
            return new Response(override[file] ?? (file === "app-build.json"
                ? JSON.stringify(shell.metadata)
                : shell.files[file]));
        }
    }, { filename: "service-worker.js" });
    return {
        name, saved, requests,
        get activations() { return activations; },
        fetch(url) {
            let response;
            listeners.fetch({ request: { url, method: "GET" }, respondWith: result => { response = result; } });
            return response;
        },
        install() {
            let promise;
            listeners.install({ waitUntil: result => { promise = result; } });
            return promise;
        },
        async message(source, data) {
            let operation;
            let response;
            listeners.message({ source, data, ports: [{ postMessage: value => { response = value; } }],
                waitUntil: result => { operation = result; } });
            await operation;
            return response;
        }
    };
}

test("the service worker bypasses the catalogue under the /gac-helper/ Pages path", () => {
    const base = "https://nimbrethil81.github.io/gac-helper/";
    const sw = worker(base);

    assert.equal(sw.fetch(`${base}catalogue/current.json`), undefined);
    assert.equal(sw.fetch(`${base}catalogue/current.json?probe=1`), undefined);
    assert.equal(sw.fetch(`${base}catalogue/releases/6-5d95a75e5a94.json`), undefined);
    assert.equal(sw.fetch(ROSTER_API_URL + "?action=roster&allyCode=123456789"), undefined);

    assert.ok(sw.fetch(base));
    assert.ok(sw.fetch(`${base}app.js`));
    assert.ok(sw.fetch(`${base}index.html`));
});

test("the waiting worker rechecks all app windows and accepts only the requested build within the deadline", async () => {
    const base = "https://example.test/gac-helper/";
    const source = { type: "window", url: base, id: "caller" };
    let windows = [source, { type: "window", url: "https://example.test/other/", id: "unrelated" }];
    const sw = worker(base, { matchAll: async options => {
        assert.equal(options.includeUncontrolled, true);
        return windows;
    } });
    await sw.install();
    const inspected = await sw.message(source, { type: "gac-app-inspect" });
    assert.equal(inspected.soleWindow, true);
    assert.equal(sw.activations, 0);
    const request = { type: "gac-app-activate", buildId: inspected.buildId, metadataHash: inspected.metadataHash, deadline: Date.now() + 2000 };
    windows.push({ type: "window", url: base + "index.html", id: "just opened" });
    assert.equal((await sw.message(source, request)).result, "other-windows");
    windows.pop();
    assert.equal((await sw.message(source, { ...request, deadline: 0 })).result, "unavailable");
    assert.equal((await sw.message(source, { ...request, buildId: "another" })).result, "unavailable");
    assert.equal(sw.activations, 0);
    assert.equal((await sw.message(source, request)).result, "accepted");
    assert.equal(sw.activations, 1);
});

test("the service worker bypasses the catalogue at a site root too", () => {
    const sw = worker("http://localhost:8080/");
    assert.equal(sw.fetch("http://localhost:8080/catalogue/current.json"), undefined);
    assert.ok(sw.fetch("http://localhost:8080/app.js"));
});

test("the service worker verifies and caches the complete shell without caching catalogue or build metadata", async () => {
    const base = "https://example.test/gac-helper/";
    const sw = worker(base);
    await sw.install();
    assert.equal(sw.name, `gac-app-shell:/gac-helper/:${shell.metadata.buildId}`);
    const cache = sw.saved.get(sw.name);
    assert.deepEqual([...cache.keys()].sort(), ["", ".gac-shell-ready", ...PAGES_APP_FILES].map(file => base + file).sort());
    assert.equal(await (await sw.fetch(base)).text(), await (await sw.fetch(base + "index.html")).text());
    for (const file of PAGES_APP_FILES) {
        const response = await sw.fetch(`${base}${file}?build=${shell.metadata.buildId}`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), shell.files[file]);
    }
    const fresh = sw.requests.length;
    await sw.fetch(base + "app-build.json");
    assert.equal(sw.requests.length, fresh + 1);
    assert.equal(sw.requests.at(-1).options.cache, "no-store");
    assert.equal(cache.has(base + "app-build.json"), false);
    assert.ok(sw.requests.every(request => !request.href.includes("/catalogue/")));
});

test("an incomplete install leaves owned and unrelated caches alone", async () => {
    const keys = new Map([["unrelated", new Map()], ["gac-app-shell:/gac-helper/:" + "1".repeat(64), new Map()]]);
    const sw = worker("https://example.test/gac-helper/", { override: { "styles.css": "mixed shell" }, saved: keys });
    await assert.rejects(sw.install(), /App shell verification failed: styles.css/);
    assert.deepEqual([...sw.saved.keys()], ["unrelated", "gac-app-shell:/gac-helper/:" + "1".repeat(64)]);
});
