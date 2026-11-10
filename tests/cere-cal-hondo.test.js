'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {readSource, compileSource, applyCorrections, readCorrections} = require('../scripts/catalogue-source-lib');
const {sourceAtCommit} = require('../scripts/catalogue-release-lib');
const root = path.join(__dirname, '..');
const payload = compileSource(readSource(path.join(root, 'catalogue/source')).source);
const defence = 'Pirate King Hondo Ohnaka';
const members = ['CERE_JUNDA', 'TARON_MALICOS', 'CAL_KESTIS'];
function harness() {
    const values = new Map();
    const context = {__GAC_HELPER_TEST__:true, console, setTimeout, clearTimeout, navigator:{},
        localStorage:{getItem:k=>values.get(k) ?? null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
        document:{getElementById:()=>({innerHTML:''}),querySelectorAll:()=>[],querySelector:()=>null}};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'), context);
    const run = code => vm.runInContext(code,context);
    run(`gacData=${JSON.stringify(payload.counters)}; counterDefinitions=${JSON.stringify(payload.counterDefinitions)}; characterDefinitions=${JSON.stringify(payload.characterDefinitions)}; defenceTeams=${JSON.stringify(payload.defenceTeams)}; defenceCompositions=${JSON.stringify(payload.defenceCompositions)};
        board=createRoundBoard('KYBER','3v3',[{territory:'FRONT_TOP',type:'SQUAD',teamCount:1}],'opponent','round','now');
        board.teams[0].name=${JSON.stringify(defence)}; ownedCharacters=${JSON.stringify(members)}; usedTeams=[];`);
    return {run};
}
test('approved exact Hondo counter is A/56 non-provisional; only declared source rows change',()=>{
    const document=readCorrections(path.join(root,'catalogue/corrections/2026-11-06-cere-cal-hondo-3v3.json'));
    const before=sourceAtCommit(root,document.baseline.commit).source;
    assert.deepEqual(applyCorrections(before,document.corrections), sourceAtCommit(root,'f8d4cc8627eec8494247cff327810d5cca9f32cc').source);
    const old=compileSource(before);
    assert.deepEqual({...payload.counters['5v5'],Geonosians:payload.counters['5v5'].Geonosians.slice(0,-2)},old.counters['5v5']);
    assert.deepEqual(payload.counters.FLEET,old.counters.FLEET);
    assert.deepEqual(payload.counterDefinitions.CERE,old.counterDefinitions.CERE);
    const rows=payload.counters['3v3'][defence];
    assert.deepEqual(rows.slice(0,-1),old.counters['3v3'][defence]);
    assert.equal(rows.filter(c=>c.counterId==='CERE_CAL').length,1);
    const row=rows.at(-1);
    assert.equal(row.tier,'A'); assert.equal(row.bannerScore,56); assert.equal(row.undersize,0);
    assert.equal(row.confidence,undefined);
    assert.match(row.notes,/Owner-reported full clear, 56 banners on 2026-11-06/);
    assert.match(row.notes,/one observed battle/); assert.match(row.notes,/conditions unknown/);
    assert.deepEqual(payload.counterDefinitions.CERE_CAL.required,members);
    assert.deepEqual(payload.defenceCompositions['3v3'][defence],['PIRATE_KING_HONDO_OHNAKA','HONDO_OHNAKA','VANE']);
});
test('exact Cal roster filtering, Round recommendation, squad display and tier ranking',()=>{
    const {run}=harness();
    run('roundPlan=computeRoundPlan();');
    assert.equal(run('roundPlan.assign["FRONT_TOP:0"].counterId'),'CERE_CAL');
    run('expandedCounterCards.add("FRONT_TOP:0:CERE_CAL");');
    const html=run('renderTeamRecommendation("opponent","FRONT_TOP",board.teams[0],"3v3")');
    for(const text of ['Cere Junda','Taron Malicos','Cal Kestis','~56 banners','Used + Cleared','Suggested squad']) assert.ok(html.includes(text));
    assert.doesNotMatch(html,/Provisional counters|Jedi Knight Cal/);
    assert.equal(run('counterCompositionForDisplay("CERE_CAL","3v3").flex'),0);
    run('ownedCharacters=["CERE_JUNDA","TARON_MALICOS","JEDI_KNIGHT_CAL_KESTIS"]; roundPlan=computeRoundPlan();');
    assert.equal(run('roundPlan.assign["FRONT_TOP:0"]'),undefined);
    assert.equal(run('getCounterStatus("CERE")'),'available');
    assert.equal(run('getCounterStatus("CERE_CAL")'),'not-owned');
    run('ownedCharacters.push("CAL_KESTIS","SUPREME_LEADER_KYLO_REN"); roundPlan=computeRoundPlan();');
    assert.equal(run('roundPlan.assign["FRONT_TOP:0"].counterId'),'SLKR','S tier remains ahead of A even with a lower banner estimate');
});
test('shared characters spent by exact lineup block other cores and vice versa',()=>{
    const {run}=harness();
    run('usedTeams=["CERE_CAL"];');
    assert.equal(run('getCounterStatus("CERE")'),'spent');
    assert.equal(run('spentCharacters().has("CAL_KESTIS")'),true);
    assert.equal(run('spentCharacters().has("JEDI_KNIGHT_CAL_KESTIS")'),false);
    run('usedTeams=["CERE"]; roundPlan=computeRoundPlan();');
    assert.equal(run('getCounterStatus("CERE_CAL")'),'spent');
    assert.equal(run('roundPlan.assign["FRONT_TOP:0"]'),undefined);
    run('usedTeams=[]; board.defenceSnapshot={schema:1,mode:"3v3",source:"template",capturedAt:"now",characterIds:["CAL_KESTIS"],unresolvedTeams:[]}; roundPlan=computeRoundPlan();');
    assert.equal(run('getCounterStatus("CERE_CAL")'),'on-defence');
    assert.equal(run('roundPlan.assign["FRONT_TOP:0"]'),undefined);
});
