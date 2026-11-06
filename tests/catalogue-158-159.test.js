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
const dr = 'Darth Revan / Darth Malgus / Bastila Shan (Fallen)';
const baseline = sourceAtCommit(root, '251ccb342c1f4329708b145afb8ebcaf9cae73e6').source;
const current = readSource(path.join(root, 'catalogue/source')).source;
const before = compileSource(baseline);
const payload = compileSource(current);
const proposals = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-158-159-reconciliation.json'));
function harness() {
    const elements = { teamSelect: { options: [dr], value: dr }, results: {} };
    const values = new Map();
    const context = { __GAC_HELPER_TEST__: true, URL, console, setTimeout, clearTimeout, navigator: {}, confirm: () => true, alert: () => {}, localStorage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) }, document: { getElementById: id => elements[id] || { innerHTML: '' }, querySelectorAll: () => [], querySelector: () => null } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
    const run = s => vm.runInContext(s, context);
    run(`gacData=${JSON.stringify(payload.counters)}; counterDefinitions=${JSON.stringify(payload.counterDefinitions)}; characterDefinitions=${JSON.stringify(payload.characterDefinitions)}; defenceTeams=${JSON.stringify(payload.defenceTeams)}; defenceCompositions=${JSON.stringify(payload.defenceCompositions)}; currentMode='3v3'; ownedCharacters=Object.keys(characterDefinitions); usedTeams=[];`);
    return { run, elements };
}

test('#158 removes exactly its mistaken matchup/composition; #159 changes only its declared paths', () => {
    assert.deepEqual(compileSource(applyCorrections(baseline, proposals.corrections)), payload);
    assert.equal(auditSource(current).summary.releaseGate, 'PASS');
    assert.deepEqual(diffPayloads(before, payload).map(d => d.path).sort(), proposals.corrections.flatMap(c => c.expectedPayloadPaths).sort());
    assert.equal(payload.counters['3v3'][depa], undefined);
    assert.equal(payload.defenceCompositions['3v3'][depa], undefined);
    assert.deepEqual(payload.characterDefinitions, before.characterDefinitions);
    assert.deepEqual(payload.counters['3v3']['Satele Shan'], before.counters['3v3']['Satele Shan']);
    assert.deepEqual(payload.counters['5v5'], before.counters['5v5']);
    assert.deepEqual(payload.counters.FLEET, before.counters.FLEET);
    assert.deepEqual(payload.defenceTeams, before.defenceTeams);
    assert.deepEqual(payload.counters['3v3'][dr].slice(0, 4), before.counters['3v3'][dr]);
    assert.equal(payload.counters['3v3'][dr].length, 5);
    assert.equal(new Set(payload.counters['3v3'][dr].map(c => c.counterId)).size, 5);
    assert.deepEqual(payload.counterDefinitions.SLKR_SOLO.required, ['SUPREME_LEADER_KYLO_REN']);
    assert.deepEqual(payload.counterDefinitions.SLKR, before.counterDefinitions.SLKR);
});

test('pickers remove only the erroneous identity and keep the exact DR defence distinct', () => {
    const h = harness();
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes(${JSON.stringify(depa)})`), false);
    assert.equal(h.run(`boardSelectableDefenceNames('3v3').includes(${JSON.stringify(dr)})`), true);
    assert.equal(h.run("boardSelectableDefenceNames('3v3').includes('Satele Shan')"), true);
    assert.doesNotMatch(h.run('renderCounters()'), /Depa Billaba \/ Jedi Knight Revan/);
    assert.equal(payload.counters['3v3']['Darth Revan'], undefined);
    assert.deepEqual(payload.counters['3v3']['Darth Malgus'], before.counters['3v3']['Darth Malgus']);
});

test('SLKR variants check ownership and shared spent/on-defence character in both directions', () => {
    const h = harness();
    h.run("const trio = gacData['3v3']["+JSON.stringify(dr)+"].find(c=>c.counterId==='SLKR'); const solo=gacData['3v3']["+JSON.stringify(dr)+"].find(c=>c.counterId==='SLKR_SOLO'); ownedCharacters=['SUPREME_LEADER_KYLO_REN'];");
    assert.equal(h.run('provisionalStatus(solo)'), 'available');
    assert.equal(h.run('provisionalStatus(trio)'), 'not-owned');
    h.run("ownedCharacters.push('OLD_DAKA','NIGHTSISTER_ZOMBIE'); usedTeams=['SLKR_SOLO'];");
    assert.equal(h.run('provisionalStatus(trio)'), 'spent');
    h.run("usedTeams=['SLKR'];");
    assert.equal(h.run('provisionalStatus(solo)'), 'spent');
    h.run("counterDefinitions.TEST_OTHER_SLKR={name:'Other SLKR team',required:['SUPREME_LEADER_KYLO_REN'],recommended:[]}; usedTeams=['TEST_OTHER_SLKR'];");
    assert.equal(h.run('provisionalStatus(solo)'), 'spent');
    assert.equal(h.run('provisionalStatus(trio)'), 'spent');
    h.run("usedTeams=[]; board={mode:'3v3',defenceSnapshot:{schema:1,mode:'3v3',characterIds:['SUPREME_LEADER_KYLO_REN'],unresolvedTeams:[]}};");
    assert.equal(h.run('provisionalStatus(solo)'), 'on-defence');
    assert.equal(h.run('provisionalStatus(trio)'), 'on-defence');
});

test('both variants are visible unscored research only, with no automatic coverage or Mark Used', () => {
    const h = harness();
    h.run("counterFilter='all'; showCounters();");
    const html = h.elements.results.innerHTML;
    assert.match(html, /SLKR solo/);
    assert.match(html, /Old Daka/);
    assert.match(html, /Provisional options — not included in plans/);
    assert.doesNotMatch(html, /Mark Used|Expected Banners|tier-badge|Undersize/);
    assert.equal(h.run(`oneShotCounters(gacData['3v3'][${JSON.stringify(dr)}]).length`), 0);
    h.run(`board=createRoundBoard('KYBER','3v3',[{territory:'FRONT_TOP',type:'SQUAD',teamCount:1}],'opponent','round','now'); board.teams[0].name=${JSON.stringify(dr)}; roundPlan=computeRoundPlan();`);
    assert.equal(h.run('Object.keys(roundPlan.assign).length'), 0);
});
