'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');
const { readSource, writeSource, compileSource, auditSource, importFromPayload, readCorrections, applyCorrections } = require('../scripts/catalogue-source-lib.js');
const { auditPayload } = require('../scripts/catalogue-audit-lib.js');
const { run: runBuild } = require('../scripts/catalogue-build.js');
const { sourceAtCommit, renderRelease, verifyReleaseText } = require('../scripts/catalogue-release-lib.js');

const root = path.join(__dirname, '..');
const historicalCommit = '251ccb342c1f4329708b145afb8ebcaf9cae73e6';
const historicalSource = sourceAtCommit(root, historicalCommit).source;
const historicalPayload = auditSource(historicalSource, { historical: true }).payload;
const historicalRelease = renderRelease(historicalPayload, 26);
const v2 = 'gac-catalogue-release:v2';
const v1 = 'gac-catalogue-release:v1';
const defence = 'Depa Billaba / Jedi Knight Revan / Bastila Shan';
const pointerFor = (release, contract) => ({ pointerSchema: 1, contract, catalogueVersion: release.catalogueVersion, checksum: release.checksum, path: release.path, bytes: release.bytes });
const pointer = pointerFor(historicalRelease, v2);
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function harness(code = appSource) {
    const values = new Map();
    const elements = { app: {}, teamSelect: { value: defence, options: [defence] }, results: {} };
    const context = {
        __GAC_HELPER_TEST__: true, URL, AbortController, crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
        navigator: {}, confirm: () => true, alert: () => {},
        localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
        document: { getElementById: id => elements[id] ?? null, querySelectorAll: () => [], querySelector: () => null }
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    return { run: code => vm.runInContext(code, context), context, elements, values };
}

test('active audit, compiler, import, corrections and release recording refuse retired matchup fields', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-retired-source-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const active = readSource(path.join(root, 'catalogue/source')).source;
    const source = structuredClone(active);
    const historicalMatch = historicalSource['matchups/3v3.json'].find(row => row.defence === defence);
    source['matchups/3v3.json'].push(historicalMatch);
    assert.ok(auditSource(source).findings.some(f => f.code === 'MATCHUP_PROVISIONAL_RETIRED'));
    assert.ok(auditPayload(historicalPayload).findings.some(f => f.code === 'MATCHUP_PROVISIONAL_RETIRED'));
    assert.throws(() => compileSource(source), /provisional matchup fields are retired/);
    assert.throws(() => importFromPayload(historicalPayload), /provisional matchup fields are retired/);
    const detachedEvidence = structuredClone(active);
    detachedEvidence['matchups/FLEET.json'][0].counters[0].evidenceKind = 'RELATED';
    assert.throws(() => compileSource(detachedEvidence), /provisional matchup fields are retired/);
    assert.ok(auditSource(detachedEvidence).findings.some(f => f.code === 'MATCHUP_PROVISIONAL_RETIRED'));

    const document = readCorrections(path.join(root, 'catalogue/corrections/2026-11-06-exact-3v3-provisional.json'));
    assert.equal(document.corrections[0].status, 'APPROVED', 'historical approval remains readable');
    assert.throws(() => applyCorrections(active, document.corrections), /provisional matchup fields are retired/);
    assert.throws(() => applyCorrections(active, [{ id: 'legacy', changes: [{ file: 'matchups/3v3.json', after: historicalMatch }] }]), /provisional matchup fields are retired/);

    const sourceDir = path.join(dir, 'source');
    const out = path.join(dir, 'payload.json');
    const releaseFile = path.join(dir, 'release.json');
    writeSource(sourceDir, source);
    const compile = runBuild(['compile', '--source', sourceDir, '--out', out]);
    assert.equal(compile.exitCode, 1);
    assert.match(compile.lines.join('\n'), /MATCHUP_PROVISIONAL_RETIRED/);
    assert.equal(fs.existsSync(out), false);
    const release = runBuild(['release', '--source', sourceDir, '--release-file', releaseFile]);
    assert.match(release.lines.join('\n'), /provisional matchup fields are retired/);
    assert.equal(fs.existsSync(releaseFile), false);
});

test('historical v2 verifies with its original checksum and is still refused by pre-v2 clients', async () => {
    assert.equal(historicalRelease.checksum, 'sha256:036f4f986b949dff01715ec3ac0764ad37487021b1e8274a2b10214c0e92fa99');
    assert.equal(historicalRelease.sha256, 'sha256:874b0475119c571f3ab3146fb4104802ca43b138c76f5c006ad2ad4a2090ecfe');
    assert.deepEqual(verifyReleaseText(historicalRelease.text).payload, historicalPayload);
    const old = harness(execFileSync('git', ['show', 'e7ba65a:app.js'], { cwd: root, encoding: 'utf8' }));
    old.context.pointer = pointer;
    assert.equal(old.run('parseCataloguePointer(pointer)'), null);

    const h = harness();
    h.context.fetch = async () => ({ ok: true, text: async () => historicalRelease.text });
    h.context.pointer = pointer;
    h.context.fetched = await h.run('fetchCatalogueRelease(pointer)');
    assert.equal(h.context.fetched.payload.counters['3v3'][defence][0].confidence, 'PROVISIONAL');
    assert.equal(h.run('writeCatalogueCache(fetched); readCatalogueCache().sourceContract'), v2);
    old.values.set('catalogueCache:v2', h.values.get('catalogueCache:v2'));
    assert.equal(old.run('readCatalogueCache()'), null);
    const forged = JSON.parse(historicalRelease.text);
    forged.release.contract = v1;
    assert.throws(() => verifyReleaseText(JSON.stringify(forged)), /contract/);
    h.context.pointer = { ...pointer, contract: v1 };
    await assert.rejects(h.run('fetchCatalogueRelease(pointer)'), /pointer/);
});

test('malformed v2 rows fail verification and a corrupt offline cache fails closed', () => {
    const h = harness();
    for (const change of [
        row => { row.evidenceUrl = 'http://example.test/evidence'; },
        row => { row.observedAt = '2026-02-30'; },
        row => { row.confidence = 'VERIFIED'; },
        row => { row.required = []; },
        row => { row.tier = 'A'; },
        row => { row.role = 'SETUP'; }
    ]) {
        const payload = structuredClone(historicalPayload);
        change(payload.counters['3v3'][defence][0]);
        const release = renderRelease(payload, 26);
        assert.throws(() => verifyReleaseText(release.text), /MATCHUP_PROVISIONAL_INVALID/);
        h.values.set('catalogueCache:v2', JSON.stringify({ schema: 2, sourceContract: v2, acceptedAt: '2026-11-06', catalogueVersion: 26, checksum: release.checksum, payload }));
        assert.equal(h.run('readCatalogueCache()'), null);
    }
});

test('offline v2 cache retains scored and tactical rows while excluding retired rows throughout the app', async () => {
    const h = harness();
    const cache = JSON.stringify({ schema: 2, sourceContract: v2, acceptedAt: '2026-11-06', catalogueVersion: 26, checksum: historicalRelease.checksum, payload: historicalPayload });
    h.values.set('catalogueCache:v2', cache);
    h.context.fetch = async () => { throw new Error('offline'); };
    h.run('render = () => {}; maybeBackgroundSync = () => {};');
    await h.run('loadData()');
    assert.equal(h.values.get('catalogueCache:v2'), cache);
    for (const mode of ['3v3', '5v5', 'FLEET']) {
        h.context.expected = Object.fromEntries(Object.entries(historicalPayload.counters[mode]).map(([name, rows]) => [name, rows.filter(row => row.confidence === undefined)]));
        assert.equal(h.run(`JSON.stringify(gacData['${mode}'])`), JSON.stringify(h.context.expected));
    }

    h.context.defence = defence;
    const owned = historicalPayload.counters['3v3'][defence].flatMap(row => row.required);
    h.context.owned = [...new Set(owned)];
    h.run(`currentMode = '3v3'; counterFilter = 'all'; ownedCharacters = owned; showCounters();
        board = createRoundBoard('KYBER', '3v3', [{territory:'FRONT_TOP',type:'SQUAD',teamCount:1}], 'opponent','round','now');
        board.teams[0].name = defence; roundPlan = computeRoundPlan();`);
    assert.match(h.elements.results.innerHTML, /No one-shot counters are catalogued/);
    assert.doesNotMatch(h.elements.results.innerHTML, /counter-card|Provisional/);
    assert.equal(h.run('Object.keys(roundPlan.assign).length'), 0);
    assert.match(h.run(`renderTeamRecommendation('opponent', 'FRONT_TOP', board.teams[0], '3v3')`), /No counters in the catalogue/);
    assert.doesNotMatch(h.run(`renderTeamRecommendation('opponent', 'FRONT_TOP', board.teams[0], '3v3')`), /<details|Mark used|Provisional/);
    h.run('let seen; lastBattleAdvice = input => { seen = input.counters; return {status:"captured"}; }; currentLastBattleAdvice();');
    assert.equal(h.run('seen.length'), 0);

    const current = compileSource(readSource(path.join(root, 'catalogue/source')).source);
    const release = renderRelease(current, 40);
    const currentPointer = pointerFor(release, v1);
    h.context.fetch = async url => ({ ok: true, text: async () => url.endsWith('current.json') ? JSON.stringify(currentPointer) : release.text });
    assert.equal(await h.run('refreshCatalogue(readCatalogueCache())'), 'updated');
    assert.equal(h.run('readCatalogueCache().sourceContract'), v1);
    assert.equal(h.run('readCatalogueCache().checksum'), release.checksum);
});

test('the approved Malak Revan correction still exposes the ordinary exact counter', () => {
    const payload = compileSource(readSource(path.join(root, 'catalogue/source')).source);
    const name = 'Darth Revan / Darth Malak / Bastila Shan (Fallen)';
    const oldName = 'Darth Revan / Darth Malgus / Bastila Shan (Fallen)';
    assert.equal(payload.counters['3v3'][oldName], undefined);
    assert.equal(payload.defenceCompositions['3v3'][oldName], undefined);
    const [row, ...rest] = payload.counters['3v3'][name];
    assert.deepEqual([row.counterId, row.tier, row.bannerScore, row.undersize, rest.length], ['BAYLAN_MARROK_SHIN', 'S', 57, 0, 0]);
    assert.equal(payload.counterDefinitions.BAYLAN.required.length, 1);
});
