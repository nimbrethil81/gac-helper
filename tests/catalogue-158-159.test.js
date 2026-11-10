'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource, compileSource, readCorrections, applyCorrections, auditSource } = require('../scripts/catalogue-source-lib');
const { sourceAtCommit } = require('../scripts/catalogue-release-lib');
const { diffPayloads } = require('../scripts/catalogue-audit-lib');
const root = path.join(__dirname, '..');
const depa = 'Depa Billaba / Jedi Knight Revan / Bastila Shan';
const oldDefence = 'Darth Revan / Darth Malgus / Bastila Shan (Fallen)';
const dr = 'Darth Revan / Darth Malak / Bastila Shan (Fallen)';
const baseline = sourceAtCommit(root, '251ccb342c1f4329708b145afb8ebcaf9cae73e6').source;
const current = readSource(path.join(root, 'catalogue/source')).source;
const before = compileSource(baseline);
const payload = compileSource(current);
const historical = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-158-159-reconciliation.json'));
const correction167 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-07-167-revan-malak-baylan.json'));
const correction171 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-10-171-bane-stranger.json'));
function harness() {
    const elements = { teamSelect: { options: [dr], value: dr }, results: { innerHTML: '' } };
    const values = new Map();
    const context = { __GAC_HELPER_TEST__: true, URL, console, setTimeout, clearTimeout, navigator: {}, confirm: () => true, alert: () => {}, localStorage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) }, document: { getElementById: id => elements[id] || { innerHTML: '' }, querySelectorAll: () => [], querySelector: () => null } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
    const run = s => vm.runInContext(s, context);
    run(`gacData=${JSON.stringify(payload.counters)}; counterDefinitions=${JSON.stringify(payload.counterDefinitions)}; characterDefinitions=${JSON.stringify(payload.characterDefinitions)}; defenceTeams=${JSON.stringify(payload.defenceTeams)}; defenceCompositions=${JSON.stringify(payload.defenceCompositions)}; currentMode='3v3'; ownedCharacters=Object.keys(characterDefinitions); usedTeams=[];`);
    return { run, elements };
}

test('#158/#159 remain reproducible historical decisions; #167 and #171 apply their exact approved current corrections', () => {
    const delivered = compileSource(sourceAtCommit(root, '44c305f05f99959a154c5086326dec743b7e25c0').source);
    assert.deepEqual(compileSource(applyCorrections(baseline, historical.corrections)), delivered);
    assert.deepEqual(applyCorrections(applyCorrections(sourceAtCommit(root, correction167.baseline.commit).source, correction167.corrections), correction171.corrections), current);
    assert.equal(auditSource(current).summary.releaseGate, 'PASS');
    const preview = compileSource(sourceAtCommit(root, correction167.baseline.commit).source);
    assert.deepEqual(diffPayloads(preview, payload).map(d => d.path).sort(), [...correction167.corrections.flatMap(c => c.expectedPayloadPaths), ...correction171.corrections.flatMap(c => c.expectedPayloadPaths)].sort());
    assert.equal(payload.counters['3v3'][depa], undefined);
    assert.equal(payload.defenceCompositions['3v3'][depa], undefined);
    assert.deepEqual(payload.counters['3v3']['Satele Shan'], before.counters['3v3']['Satele Shan']);
    assert.deepEqual(payload.counters['5v5'], before.counters['5v5']);
    assert.deepEqual(payload.counters.FLEET, before.counters.FLEET);
    assert.deepEqual(payload.defenceTeams, before.defenceTeams);
    assert.equal(payload.counters['3v3'][oldDefence], undefined);
    assert.equal(payload.defenceCompositions['3v3'][oldDefence], undefined);
    assert.deepEqual(payload.defenceCompositions['3v3'][dr], ['DARTH_REVAN', 'DARTH_MALAK', 'BASTILA_SHAN_FALLEN']);
    assert.deepEqual(payload.counters['3v3'][dr], [{ counter: 'Baylan Skoll (Marrok + Shin Hati)', counterId: 'BAYLAN_MARROK_SHIN', tier: 'S', bannerScore: 57, undersize: 0, notes: 'Owner-approved flawless high-banner counter vs this exact Malak lineup; conditions not specified.' }]);
    assert.deepEqual(payload.counterDefinitions.BAYLAN.required, ['BAYLAN_SKOLL']);
    assert.deepEqual(payload.counterDefinitions.BAYLAN_MARROK_SHIN.required, ['BAYLAN_SKOLL', 'MARROK', 'SHIN_HATI']);
    assert.deepEqual(payload.counters['3v3']['Darth Malgus'], before.counters['3v3']['Darth Malgus']);
    assert.deepEqual(payload.counters['3v3']['Darth Revan with Zaalbar'], before.counters['3v3']['Darth Revan with Zaalbar']);
});

test('corrected defence is selectable and the exact trio renders as a normal S-tier counter', () => {
    const h = harness();
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes(${JSON.stringify(oldDefence)})`), false);
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes(${JSON.stringify(dr)})`), true);
    assert.equal(h.run("boardSelectableDefenceNames('3v3').includes('Satele Shan')"), true);
    h.run("counterFilter='all'; showCounters();");
    assert.doesNotMatch(h.elements.results.innerHTML, /Depa Billaba \/ Jedi Knight Revan|Darth Revan \/ Darth Malgus/);
    assert.match(h.elements.results.innerHTML, /Baylan Skoll \(Marrok \+ Shin Hati\)/);
    assert.doesNotMatch(h.elements.results.innerHTML, /Provisional/);
});

test('the exact Baylan trio needs every unit and shares spent/on-defence blockers with generic Baylan', () => {
    const h = harness();
    const id = 'BAYLAN_MARROK_SHIN';
    assert.equal(h.run(`getCounterStatus('${id}')`), 'available');
    for (const missing of ['BAYLAN_SKOLL', 'MARROK', 'SHIN_HATI']) {
        h.run(`ownedCharacters=Object.keys(characterDefinitions).filter(id=>id!==${JSON.stringify(missing)});`);
        assert.equal(h.run(`getCounterStatus('${id}')`), 'not-owned', missing);
    }
    h.run("ownedCharacters=Object.keys(characterDefinitions); usedTeams=['BAYLAN'];");
    assert.equal(h.run(`getCounterStatus('${id}')`), 'spent');
    h.run("usedTeams=['BAYLAN_MARROK_SHIN'];");
    assert.equal(h.run("getCounterStatus('BAYLAN')"), 'spent');
    h.run("usedTeams=[]; board={mode:'3v3',defenceSnapshot:{schema:1,mode:'3v3',characterIds:['MARROK'],unresolvedTeams:[]}};");
    assert.equal(h.run(`getCounterStatus('${id}')`), 'on-defence');
});
