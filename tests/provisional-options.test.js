'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { readSource, compileSource, auditSource, importFromPayload, releaseContract, readCorrections, applyCorrections } = require('../scripts/catalogue-source-lib.js');
const { auditPayload } = require('../scripts/catalogue-audit-lib.js');
const { sourceAtCommit, renderRelease, verifyReleaseText } = require('../scripts/catalogue-release-lib.js');
const root = path.join(__dirname, '..');
// Pin the original #156 release; later approved corrections may retire its rows.
const committed = sourceAtCommit(root, '251ccb342c1f4329708b145afb8ebcaf9cae73e6').source;
const approvedProposal = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-exact-3v3-provisional.json'));
const original = structuredClone(committed);
for (const change of approvedProposal.corrections[0].changes) {
    original[change.file] = original[change.file].filter(row => !(row.defence === change.stableKey.defence && (change.file.startsWith('matchups/') || row.mode === change.stableKey.mode)));
}
const defence = 'Depa Billaba / Jedi Knight Revan / Bastila Shan';
const entry = { counterId: 'DARTH_REVAN', confidence: 'PROVISIONAL', evidenceKind: 'RELATED', required: ['DARTH_REVAN', 'BASTILA_SHAN_FALLEN', 'DARTH_MALAK'], evidenceUrl: 'https://www.swgoh-ga3.online-server.info/index.php?id=jedi_knight_revan', observedAt: '2026-11-06', notes: 'Related evidence only; exact defence untested. Datacrons, relics and mods unknown.' };
function fixture(mutate = () => {}) {
    const source = structuredClone(original);
    source['matchups/3v3.json'].push({ defence, counters: [structuredClone(entry)] });
    source['matchups/3v3.json'].sort((a, b) => a.defence < b.defence ? -1 : 1);
    mutate(source['matchups/3v3.json'].find(d => d.defence === defence).counters);
    return source;
}
function harness(payload = compileSource(fixture()), old = false) {
    const values = new Map();
    const elements = { teamSelect: { value: defence, options: [defence] }, results: {} };
    const context = { __GAC_HELPER_TEST__: true, URL, AbortController, crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout, navigator: {}, confirm: () => true, alert: () => {}, localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }, document: { getElementById: id => elements[id] ?? { innerHTML: '' }, querySelectorAll: () => [], querySelector: () => null } };
    vm.createContext(context);
    // The actual pre-change client proves v2 is refused rather than interpreted
    // as a tierless ordinary recommendation.
    const code = old ? require('node:child_process').execFileSync('git', ['show', 'e7ba65a:app.js'], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    vm.runInContext(code, context);
    const run = code => vm.runInContext(code, context);
    run(`gacData = ${JSON.stringify(payload.counters)}; counterDefinitions = ${JSON.stringify(payload.counterDefinitions)}; characterDefinitions = ${JSON.stringify(payload.characterDefinitions)}; defenceTeams = ${JSON.stringify(payload.defenceTeams)}; defenceCompositions = ${JSON.stringify(payload.defenceCompositions)}; currentMode = '3v3'; ownedCharacters = ${JSON.stringify(entry.required)}; usedTeams = [];`);
    return { run, context, elements, values };
}

test('provisional source round-trips evidence and exact membership; existing payload stays identical', () => {
    const source = fixture();
    const report = auditSource(source);
    assert.equal(report.summary.releaseGate, 'PASS');
    const payload = compileSource(source);
    assert.deepEqual(importFromPayload(payload)['matchups/3v3.json'].find(d => d.defence === defence).counters, [entry]);
    const stripped = structuredClone(payload);
    delete stripped.counters['3v3'][defence];
    assert.deepEqual(stripped, compileSource(original));
    assert.equal(payload.counters['5v5'][defence], undefined);
    assert.notEqual(payload.counters['3v3']['Jedi Knight Revan'], payload.counters['3v3'][defence]);
});

test('release gate refuses invented confidence, scores, incomplete membership, bad evidence and duplicates', () => {
    for (const mutate of [
        c => { c[0].confidence = 'EXPERIMENTAL'; }, c => { c[0].evidenceKind = 'VERIFIED'; },
        c => { c[0].tier = 'B'; }, c => { c[0].bannerScore = 0; }, c => { c[0].undersize = 0; }, c => { c[0].role = 'SETUP'; },
        c => { c[0].required = []; }, c => { c[0].required = ['UNKNOWN']; }, c => { c[0].required = ['DARTH_MALAK']; },
        c => { c[0].required.push('DARTH_MALAK'); }, c => { c[0].evidenceUrl = 'javascript:alert(1)'; },
        c => { c[0].observedAt = '2026-02-30'; }, c => { c[0].notes = ' '; }, c => { c.push(structuredClone(c[0])); }
    ]) assert.equal(auditSource(fixture(mutate)).summary.releaseGate, 'FAIL', mutate.toString());
    const payload = compileSource(fixture());
    payload.counters['3v3'][defence][0].bannerScore = 53;
    assert.equal(auditPayload(payload).summary.releaseGate, 'FAIL');
});

test('v2 release and cache isolate older clients; v1 historical releases still verify', async () => {
    const payload = compileSource(fixture());
    const rendered = renderRelease(payload, 26);
    assert.equal(releaseContract(payload), 'gac-catalogue-release:v2');
    assert.deepEqual(verifyReleaseText(rendered.text).payload, payload);
    const pointer = { pointerSchema: 1, contract: 'gac-catalogue-release:v2', catalogueVersion: 26, checksum: rendered.checksum, path: rendered.path, bytes: rendered.bytes };
    const h = harness(payload);
    h.context.fetch = async () => ({ ok: true, text: async () => rendered.text });
    h.context.pointer = pointer;
    const fetched = await h.run('fetchCatalogueRelease(pointer)');
    assert.equal(fetched.payload.counters['3v3'][defence][0].confidence, 'PROVISIONAL');
    h.context.fetched = fetched;
    assert.equal(h.run('writeCatalogueCache(fetched); readCatalogueCache().sourceContract'), 'gac-catalogue-release:v2');
    const old = harness(payload, true);
    old.context.pointer = pointer;
    assert.equal(old.run('parseCataloguePointer(pointer)'), null);
    old.values.set('catalogueCache:v2', h.values.get('catalogueCache:v2'));
    assert.equal(old.run('readCatalogueCache()'), null);
    assert.equal(releaseContract(compileSource(original)), 'gac-catalogue-release:v1');
    verifyReleaseText(renderRelease(compileSource(original), 25).text);
    const forged = JSON.parse(rendered.text);
    forged.release.contract = 'gac-catalogue-release:v1';
    assert.throws(() => verifyReleaseText(JSON.stringify(forged)), /contract/);
    h.context.pointer = { ...pointer, contract: 'gac-catalogue-release:v1' };
    await assert.rejects(h.run('fetchCatalogueRelease(pointer)'), /pointer/);
});

test('Counters shows confidence, evidence and exact squad availability with no score or tier', () => {
    const h = harness();
    h.run('counterFilter = "all"; showCounters();');
    let html = h.elements.results.innerHTML;
    assert.match(html, /Provisional options — not included in plans/);
    assert.match(html, /Provisional — related evidence/);
    assert.match(html, /Darth Malak/);
    assert.match(html, /Observed 2026-11-06/);
    assert.doesNotMatch(html, /Expected Banners|tier-badge|Undersize|undefined|Mark Used/);
    h.run('ownedCharacters = ["DARTH_REVAN"]; counterFilter = "available"; showCounters();');
    assert.doesNotMatch(h.elements.results.innerHTML, /provisional-card/);
    assert.equal(h.run(`provisionalStatus(gacData['3v3'][${JSON.stringify(defence)}][0])`), 'not-owned');
    h.run(`ownedCharacters = ${JSON.stringify(entry.required)}; usedTeams = ['OTHER']; counterDefinitions.OTHER = {required:['DARTH_MALAK'], recommended:[]};`);
    assert.equal(h.run(`provisionalStatus(gacData['3v3'][${JSON.stringify(defence)}][0])`), 'spent');
    h.run(`usedTeams = []; gacData['3v3'][${JSON.stringify(defence)}][0].notes = '<script>alert(1)</script>'; counterFilter = 'all'; showCounters();`);
    assert.match(h.elements.results.innerHTML, /&lt;script&gt;/);
});

test('provisional options never enter Round coverage, resource competition or Last Battle input', () => {
    const h = harness();
    h.run(`board = createRoundBoard('KYBER', '3v3', [{territory:'FRONT_TOP',type:'SQUAD',teamCount:1}], 'opponent','round','now'); board.teams[0].name = ${JSON.stringify(defence)}; roundPlan = computeRoundPlan();`);
    assert.equal(h.run('Object.keys(roundPlan.assign).length'), 0);
    assert.equal(h.run(`oneShotCounters(gacData['3v3'][${JSON.stringify(defence)}]).length`), 0);
    h.run('let seen; lastBattleAdvice = input => { seen = input.counters; return {status:"captured"}; }; currentLastBattleAdvice();');
    assert.equal(h.run('seen.length'), 0);
    assert.match(h.run('roundPlan.reasons["FRONT_TOP:0"].reason'), /Provisional/);
});


test('the historical v26 six-option proposal matches its original source without changing generic counters', () => {
    const document = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-exact-3v3-provisional.json'));
    assert.equal(document.corrections[0].status, 'APPROVED');
    const proposed = applyCorrections(original, document.corrections);
    assert.equal(auditSource(proposed).summary.releaseGate, 'PASS');
    const before = compileSource(original);
    const after = compileSource(proposed);
    assert.deepEqual(after, compileSource(committed));
    const names = document.corrections[0].changes.filter(c => c.file === 'matchups/3v3.json').map(c => c.after.defence);
    assert.equal(names.length, 2);
    assert.equal(after.counters['3v3'][names[0]].length, 2);
    assert.equal(after.counters['3v3'][names[1]].length, 4);
    assert.equal(after.defenceCompositions['3v3'][names[0]][0], 'DEPA_BILLABA');
    assert.equal(after.defenceCompositions['3v3'][names[1]][0], 'DARTH_REVAN');
    for (const name of names) {
        assert.equal(after.counters['5v5'][name], undefined);
        assert.equal(new Set(after.counters['3v3'][name].map(c => c.counterId)).size, after.counters['3v3'][name].length);
        assert.equal(oneShotCount(after.counters['3v3'][name]), 0);
        delete after.counters['3v3'][name];
        delete after.defenceCompositions['3v3'][name];
    }
    assert.deepEqual(after, before);
});
function oneShotCount(rows) {
    const h = harness();
    h.context.rows = rows;
    return h.run('oneShotCounters(rows).length');
}


test('malformed provisional downloads/caches fail closed without throwing', () => {
    const valid = compileSource(fixture());
    const h = harness(valid);
    for (const mutate of [
        p => { p.counterDefinitions.DARTH_REVAN.required = null; },
        p => { p.counters['3v3'][defence][0].evidenceUrl = 'javascript:alert(1)'; },
        p => { p.counters['3v3'][defence][0].observedAt = '2026-02-30'; },
        p => { p.counters['3v3'][defence][0].confidence = 'VERIFIED'; },
        p => { p.counters['3v3'][defence][0].required.reverse(); },
        p => { p.counters['3v3'][defence][0].required = ['DARTH_REVAN']; p.counters['3v3'][defence][0].tier = 'A'; }
    ]) {
        h.context.bad = structuredClone(valid);
        mutate(h.context.bad);
        assert.equal(h.run('isValidCataloguePayload(bad)'), false);
    }
});
