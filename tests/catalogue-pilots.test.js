"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSource, writeSource, compileSource, auditSource, importFromPayload } = require("../scripts/catalogue-source-lib.js");
const { auditPayload, payloadChecksum } = require("../scripts/catalogue-audit-lib.js");
const { renderRelease, verifyReleaseText } = require("../scripts/catalogue-release-lib.js");
const current = readSource(path.join(__dirname, "..", "catalogue", "source")).source;
const copy = () => structuredClone(current);
const blocking = report => report.findings.filter(f => f.severity === "blocking");

test("current static crew metadata covers every hull with canonical character joins", () => {
    const payload = compileSource(current);
    const ships = current["units.json"].filter(u => ["SHIP", "CAPITAL_SHIP"].includes(u.unitType));
    assert.equal(current["ship-pilots.json"].length, ships.length);
    assert.equal(ships.length, 70, "raw game metadata extraction reviewed for this catalogue");
    assert.deepEqual(blocking(auditSource(current)), []);
    for (const ship of ships) {
        assert.ok(Array.isArray(payload.characterDefinitions[ship.id].pilotIds), ship.id);
        for (const id of payload.characterDefinitions[ship.id].pilotIds) assert.equal(payload.characterDefinitions[id].unitType, "CHARACTER");
    }
    assert.deepEqual(payload.characterDefinitions.EXECUTOR.pilotIds, ["ADMIRAL_PIETT"]);
    assert.deepEqual(payload.characterDefinitions.GHOST.pilotIds, ["HERA_SYNDULLA", "KANAN_JARRUS", "ZEB_ORRELIOS"]);
    assert.deepEqual(payload.characterDefinitions.CASSIANS_U_WING.pilotIds, ["CASSIAN_ANDOR", "JYN_ERSO", "K_2SO"]);
    assert.deepEqual(payload.characterDefinitions.VULTURE_DROID.pilotIds, []);
});

test("crew metadata survives seven-key source/payload and release round trips", () => {
    const payload = compileSource(current);
    const imported = importFromPayload(payload, current["score-meanings.json"]);
    assert.deepEqual(imported["ship-pilots.json"], current["ship-pilots.json"]);
    assert.deepEqual(compileSource(imported), payload);
    assert.deepEqual(verifyReleaseText(renderRelease(payload, 25).text).payload, payload);
    assert.equal(Object.keys(payload).length, 7);
});

test("crew validation rejects missing coverage, duplicate mappings, wrong hulls and invalid crew", () => {
    for (const mutate of [
        s => s["ship-pilots.json"].pop(),
        s => s["ship-pilots.json"].push(s["ship-pilots.json"][0]),
        s => { s["ship-pilots.json"][0].shipId = "AAYLA_SECURA"; },
        s => { s["ship-pilots.json"][0].pilotIds = ["UNKNOWN_UNIT"]; },
        s => { s["ship-pilots.json"][0].pilotIds = ["EXECUTOR"]; },
        s => { s["ship-pilots.json"][0].pilotIds = ["HAN_SOLO", "HAN_SOLO"]; }
    ]) {
        const source = copy(); mutate(source);
        assert.ok(blocking(auditSource(source)).length > 0);
    }
});

test("release audit rejects invalid crew even with a recalculated valid checksum", () => {
    const payload = compileSource(current);
    payload.characterDefinitions.EXECUTOR.pilotIds = ["EXECUTOR"];
    assert.ok(blocking(auditPayload(payload)).some(f => f.code === "SHIP_PILOTS_INVALID"));
    assert.throws(() => verifyReleaseText(renderRelease(payload, 25).text), /SHIP_PILOTS_INVALID/);
});

test("old sources without crew stay valid and byte/checksum compatible instead of guessing pilotless", t => {
    const source = copy(); delete source["ship-pilots.json"];
    const payload = compileSource(source);
    assert.equal(payload.characterDefinitions.EXECUTOR.pilotIds, undefined);
    assert.deepEqual(blocking(auditSource(source)), []);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-old-crew-"));
    t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
    writeSource(directory, current);
    writeSource(directory, source);
    assert.equal(fs.existsSync(path.join(directory, "ship-pilots.json")), false);
    const reread = readSource(directory);
    assert.deepEqual(reread.findings, []);
    assert.equal(payloadChecksum(compileSource(reread.source)), payloadChecksum(payload));
    assert.deepEqual(verifyReleaseText(renderRelease(payload, 24).text).payload, payload);
});
