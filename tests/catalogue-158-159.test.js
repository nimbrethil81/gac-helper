'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource, compileSource, readCorrections, applyCorrections, auditSource, isApplied } = require('../scripts/catalogue-source-lib');
const { sourceAtCommit } = require('../scripts/catalogue-release-lib');
const { diffPayloads } = require('../scripts/catalogue-audit-lib');
const root = path.join(__dirname, '..');
const depa = 'Depa Billaba / Jedi Knight Revan / Bastila Shan';
const oldDefence = 'Darth Revan / Darth Malgus / Bastila Shan (Fallen)';
const jmkCatGk = 'Jedi Master Kenobi / Commander Ahsoka Tano / General Kenobi';
const dr = 'Darth Revan / Darth Malak / Bastila Shan (Fallen)';
const baseline = sourceAtCommit(root, '251ccb342c1f4329708b145afb8ebcaf9cae73e6').source;
const current = readSource(path.join(root, 'catalogue/source')).source;
// Historical corrections through #172 reproduce this immutable v34 checkpoint.
// Compare current gameplay invariants separately; later approved updates are valid.
const v34 = sourceAtCommit(root, '3acc291b6049ac723ba2fa875d5dd2678354e05e').source;
const before = auditSource(baseline, { historical: true }).payload;
const payload = compileSource(current);
const noNotes = v => JSON.parse(JSON.stringify(v, (k, x) => k === 'notes' ? undefined : x));
const historical = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-158-159-reconciliation.json'));
const correction167 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-07-167-revan-malak-baylan.json'));
const correction171 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-10-171-bane-stranger.json'));
const correction180 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-10-180-bane-stranger-note.json'));
const correction169 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-10-169-geonosians-traya-vader.json'));
const correction172 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-09-172-reva-jmk.json'));
const correction206 = readCorrections(path.join(root, 'catalogue/corrections/2026-11-17-206-jmk-cat-gk-five-counters.json'));
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
    const delivered = sourceAtCommit(root, '44c305f05f99959a154c5086326dec743b7e25c0').source;
    const historicalReport = auditSource(delivered, { historical: true });
    assert.equal(historicalReport.summary.releaseGate, 'PASS');
    assert.ok(historical.corrections.every(correction => isApplied(delivered, correction)));
    assert.deepEqual(diffPayloads(before, historicalReport.payload).map(d => d.path).sort(), historical.corrections.flatMap(c => c.expectedPayloadPaths).sort());
    assert.throws(() => applyCorrections(baseline, historical.corrections), /provisional matchup fields are retired/);
    assert.deepEqual(applyCorrections(applyCorrections(applyCorrections(applyCorrections(applyCorrections(sourceAtCommit(root, correction167.baseline.commit).source, correction167.corrections), correction171.corrections), correction180.corrections), correction169.corrections), correction172.corrections), v34);
    assert.equal(auditSource(current).summary.releaseGate, 'PASS');
    const preview = auditSource(sourceAtCommit(root, correction167.baseline.commit).source, { historical: true }).payload;
    const v34Payload = compileSource(v34);
    assert.deepEqual(diffPayloads(preview, v34Payload).map(d => d.path).sort(), [...new Set([...correction167.corrections.flatMap(c => c.expectedPayloadPaths), ...correction171.corrections.flatMap(c => c.expectedPayloadPaths), ...correction180.corrections.flatMap(c => c.expectedPayloadPaths), ...correction169.corrections.flatMap(c => c.expectedPayloadPaths), ...correction172.corrections.flatMap(c => c.expectedPayloadPaths)])].sort());
    assert.equal(payload.counters['3v3'][depa], undefined);
    assert.equal(payload.defenceCompositions['3v3'][depa], undefined);
    assert.deepEqual(payload.counters['3v3']['Satele Shan'], before.counters['3v3']['Satele Shan']);
    assert.deepEqual(noNotes({...payload.counters['5v5'], Geonosians: payload.counters['5v5'].Geonosians.slice(0, -2)}), noNotes(before.counters['5v5']));
    assert.deepEqual(noNotes(payload.counters.FLEET), noNotes(before.counters.FLEET));
    assert.deepEqual(payload.defenceTeams, before.defenceTeams, 'generic ANY/HIGH JMK threat and other threat rows stay unchanged');
    assert.equal(Object.hasOwn(payload.counters['3v3'], jmkCatGk), false);
    assert.equal(Object.hasOwn(payload.defenceCompositions['3v3'], jmkCatGk), false);
    assert.equal(Object.hasOwn(payload.defenceTeams['3v3'], jmkCatGk), false);
    const jmkRows = payload.counters['3v3']['Jedi Master Kenobi'];
    assert.deepEqual(jmkRows.map(({counterId, tier, bannerScore, undersize, notes}) => ({counterId, tier, bannerScore, undersize, notes})), [
        {counterId:'BAYLAN_MARROK_SHIN',tier:'S',bannerScore:55,undersize:0,notes:'Use Baylan / Marrok / Shin; check the opposing datacron.'},
        {counterId:'LEIA',tier:'S',bannerScore:54,undersize:0,notes:'Use Leia / Captain Drogan / R2-D2; check enemy protection recovery.'},
        {counterId:'BO_KATAN_MANDALORE',tier:'A',bannerScore:53,undersize:0,notes:'Use Bo-Katan / IG-12 & Grogu / Paz Vizsla; check the opposing datacron.'},
        {counterId:'JML_JKCK_LEIA_JT',tier:'A',bannerScore:53,undersize:0,notes:'Use JML / Jedi Knight Cal Kestis / Leia (Jedi Training), not generic JML.'},
        {counterId:'LV_APPO_CX2',tier:'A',bannerScore:51,undersize:0,notes:'Use Lord Vader / Appo / CX-2; do not substitute a different Lord Vader trio.'},
        {counterId:'REVA',tier:'A',bannerScore:53,undersize:0,notes:''},
        {counterId:'BAYLAN',tier:'C',bannerScore:48,undersize:0,notes:'Cleanup only'}
    ]);
    const postApplicationSource = applyCorrections(sourceAtCommit(root, correction206.baseline.commit).source, correction206.corrections);
    const postApplicationPayload = compileSource(postApplicationSource);
    assert.deepEqual([
        Object.hasOwn(postApplicationPayload.counters['3v3'], jmkCatGk),
        Object.hasOwn(postApplicationPayload.defenceCompositions['3v3'], jmkCatGk),
        Object.hasOwn(postApplicationPayload.defenceTeams['3v3'], jmkCatGk)
    ], [true, true, true]);
    assert.deepEqual(postApplicationPayload.defenceTeams['3v3'][jmkCatGk], { threat: 'HIGH', notes: '' });
    assert.equal(payload.counters['3v3'][oldDefence], undefined);
    assert.equal(payload.defenceCompositions['3v3'][oldDefence], undefined);
    assert.deepEqual(payload.defenceCompositions['3v3'][dr], ['DARTH_REVAN', 'DARTH_MALAK', 'BASTILA_SHAN_FALLEN']);
    assert.deepEqual(payload.counters['3v3'][dr], [{ counter: 'Baylan Skoll (Marrok + Shin Hati)', counterId: 'BAYLAN_MARROK_SHIN', tier: 'S', bannerScore: 57, undersize: 0, notes: '' }]);
    assert.deepEqual(payload.counterDefinitions.BAYLAN.required, ['BAYLAN_SKOLL']);
    assert.deepEqual(payload.counterDefinitions.BAYLAN_MARROK_SHIN.required, ['BAYLAN_SKOLL', 'MARROK', 'SHIN_HATI']);
    assert.deepEqual(payload.counters['3v3']['Darth Malgus'], before.counters['3v3']['Darth Malgus']);
    assert.deepEqual(noNotes(payload.counters['3v3']['Darth Revan with Zaalbar']), noNotes(before.counters['3v3']['Darth Revan with Zaalbar']));
});

test('consolidated JMK is the sole current selection and legacy saved names resolve without rewriting', () => {
    const h = harness();
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes(${JSON.stringify(oldDefence)})`), false);
    assert.equal(h.run("boardSelectableDefenceNames('3v3').filter(n=>n==='Jedi Master Kenobi').length"), 1);
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes('Jedi Master Kenobi')`), true);
    assert.equal(h.run("boardSelectableDefenceNames('3v3').includes('Satele Shan')"), true);
    assert.equal(h.run(`matchupCounters('3v3', ${JSON.stringify(jmkCatGk)}).length`), 7);
    assert.equal(h.run(`threatFor(${JSON.stringify(jmkCatGk)}, '3v3')`), 'HIGH');
    assert.equal(h.run(`displayDefenceName('3v3', ${JSON.stringify(jmkCatGk)})`), 'Jedi Master Kenobi');
    h.run(`legacyBoardTeam=${JSON.stringify({name:jmkCatGk,index:0,territory:'FRONT_TOP',attempts:1,cleared:false,customName:''})}; board={mode:'3v3',roundId:'legacy-test',territories:[{territory:'FRONT_TOP',type:'SQUAD'}],teams:[legacyBoardTeam]};`);
    const roundRow = h.run(`renderBoardTeamRow({territory:'FRONT_TOP',type:'SQUAD'},legacyBoardTeam,board,'opponent')`);
    assert.match(roundRow, /defence-heading-picker[^>]*>[\s\S]*<span class="defence-row-name">Jedi Master Kenobi<\/span>/);
    assert.ok(roundRow.includes(`<option value="${jmkCatGk}" selected>Jedi Master Kenobi</option>`));
    assert.equal((roundRow.match(/<option[^>]*>Jedi Master Kenobi<\/option>/g) || []).length, 1);
    assert.equal(h.run('JSON.stringify(legacyBoardTeam.name)'), JSON.stringify(jmkCatGk), 'rendering leaves the saved defence identity unchanged');
    h.elements.teamSelect.value = 'Jedi Master Kenobi';
    h.run("counterFilter='all'; showCounters();");
    assert.match(h.elements.results.innerHTML, /Baylan Skoll \(Marrok \+ Shin Hati\)/);
    assert.match(h.elements.results.innerHTML, /Cleanup only/);
    assert.equal((h.elements.results.innerHTML.match(/counter-card/g) || []).length, 7);
    const legacy = { name: jmkCatGk, attempts: 2, cleared: false };
    assert.equal(h.run(`matchupCounters('3v3', ${JSON.stringify(legacy.name)}).find(c=>c.counterId==='BAYLAN').role || 'scored'`), 'scored');
    assert.equal(legacy.name, jmkCatGk, 'lookup leaves persisted legacy identity untouched');
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
