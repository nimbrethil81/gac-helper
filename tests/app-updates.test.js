"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setImmediate: settle } = require("node:timers/promises");
const test = require("node:test");
const vm = require("node:vm");

const { PAGES_APP_FILES } = require("../scripts/app-shell-lib.js");

const loaded = "a".repeat(64);
const target = "b".repeat(64);
const metadataHash = "00".repeat(32);
const sessionKey = "gacAppUpdateTarget";
const url = "https://example.test/gac-helper/";
const source = fs.readFileSync(path.join(__dirname, "../app-updates.js"), "utf8");

function mount({ buildId = loaded, htmlBuildId = buildId, session = new Map(), alreadyActive = false } = {}) {
    const element = () => ({ dataset: {}, classList: { toggle() {} } });
    const button = Object.assign(element(), {
        querySelector: () => element(),
        matches: selector => selector === "[data-app-update-action]"
    });
    const card = Object.assign(element(), {
        querySelector: selector => selector === "button" ? button : element()
    });
    const listeners = new Map();
    const timers = new Map();
    let timerSequence = 0;
    const addListener = (type, handler, capture) => { if (!capture) listeners.set(type, handler); };
    const workerContainer = { addEventListener() {}, getRegistration: async () => registration };
    const registration = { scope: url, updateViaCache: "none", update: async () => {}, addEventListener() {} };
    const fake = { activationRequests: 0, reloads: 0, stopped: 0, soleWindow: true, liveBuild: target, blocked: null };
    const makeWorker = (id, state) => ({
        state,
        addEventListener() {},
        postMessage(data, [reply]) {
            if (data.type === "gac-app-activate") {
                fake.activationRequests++;
                this.state = "activated";
                workerContainer.controller = registration.active = this;
                registration.waiting = null;
                reply({ result: "accepted", buildId: id });
            } else {
                reply({ buildId: id, metadataHash, soleWindow: fake.soleWindow });
            }
        }
    });
    workerContainer.controller = registration.active = makeWorker(alreadyActive ? target : loaded, "activated");
    registration.waiting = alreadyActive ? null : makeWorker(target, "installed");
    const notice = { hidden: true };
    const announcement = element();
    const sandbox = {
        APP_BUILD_ID: buildId,
        APP_VERSION: "3.6",
        currentView: "more",
        rosterBackup: null,
        appUpdateBlocker: () => fake.blocked,
        AbortController, TextDecoder, URL, queueMicrotask,
        navigator: { onLine: true, serviceWorker: workerContainer },
        document: {
            baseURI: url, visibilityState: "visible",
            getElementById: key => key === "app-update-notice" ? notice : announcement,
            querySelector: selector => selector === ".app-version-card" ? card :
                selector.startsWith("meta") ? { content: htmlBuildId } : null,
            createElement: element,
            addEventListener: addListener,
            body: { append() {}, style: { setProperty() {} } }
        },
        window: { addEventListener() {}, stop: () => { fake.stopped++; } },
        location: { reload: () => { fake.reloads++; } },
        sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
        setTimeout(callback, ms) {
            const id = ++timerSequence;
            timers.set(id, { callback, ms });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        MessageChannel: class {
            port1 = { close() {} };
            port2 = data => queueMicrotask(() => this.port1.onmessage({ data }));
        },
        crypto: { subtle: { digest: async () => new ArrayBuffer(32) } },
        fetch: async () => new Response(JSON.stringify({
            contract: "gac-app-build:v1", buildId: fake.liveBuild, version: "3.6",
            assets: Object.fromEntries(PAGES_APP_FILES.map(file => [file, { bytes: 1, sha256: metadataHash }]))
        }))
    };
    const script = source.replaceAll("__GAC_BUILD_ID__", buildId)
        .replace("/* gac shell files */ []", JSON.stringify(PAGES_APP_FILES));
    vm.runInNewContext(script + "\nappUpdates.start();", sandbox);
    return Object.assign(fake, {
        session,
        status: () => card.dataset.updateState,
        waiting: () => registration.waiting,
        async click() {
            listeners.get("click")({ target: { closest: () => button } });
            await settle();
        },
        expireReload() {
            const watchdog = [...timers.values()].find(timer => timer.ms === 6000);
            assert.ok(watchdog, "pending reload has a deadline");
            watchdog.callback();
        }
    });
}

test("a timed-out reload recovers from the verified active build only on an explicit reload click", async () => {
    const app = mount();
    await settle();
    assert.equal(app.status(), "ready");
    await app.click();
    assert.equal(app.activationRequests, 1);
    assert.equal(app.waiting(), null);
    assert.equal(app.reloads, 1);
    app.expireReload();
    assert.equal(app.stopped, 1);
    assert.equal(app.status(), "interrupted");
    assert.equal(app.session.get(sessionKey), target);

    await app.click(); // Try again verifies but does not reload.
    assert.equal(app.status(), "reloadReady");
    assert.equal(app.reloads, 1);
    app.liveBuild = "c".repeat(64);
    await app.click();
    assert.equal(app.status(), "interrupted", "a stale offered build cannot reload");
    assert.equal(app.reloads, 1);
    app.liveBuild = target;
    await app.click();
    app.soleWindow = false;
    await app.click();
    assert.equal(app.status(), "windows");
    assert.equal(app.reloads, 1);
    app.soleWindow = true;
    await app.click();
    app.blocked = "undo";
    await app.click();
    assert.equal(app.status(), "reloadReady", "pending Undo blocks the click");
    assert.equal(app.reloads, 1);
    app.blocked = null;
    await app.click();
    assert.equal(app.activationRequests, 1, "the active build needs no second activation");
    assert.equal(app.reloads, 2);

    const refreshed = mount({ buildId: target, session: app.session, alreadyActive: true });
    await settle();
    assert.equal(refreshed.status(), "current");
    assert.equal(refreshed.session.has(sessionKey), false);
    assert.equal(refreshed.reloads, 0);
});

test("a saved recovery target can recover a mismatched load without arming unrelated active builds", async () => {
    const unrelated = mount({ alreadyActive: true, htmlBuildId: target });
    await unrelated.click();
    assert.equal(unrelated.status(), "interrupted");
    assert.equal(unrelated.reloads, 0);

    const restored = mount({ alreadyActive: true, htmlBuildId: target, session: new Map([[sessionKey, target]]) });
    assert.equal(restored.status(), "interrupted");
    await restored.click();
    assert.equal(restored.status(), "reloadReady");
    assert.equal(restored.reloads, 0);
    await restored.click();
    assert.equal(restored.reloads, 1);
    assert.equal(restored.activationRequests, 0);
});
