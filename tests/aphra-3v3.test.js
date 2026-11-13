'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {readSource,compileSource,applyCorrections,readCorrections}=require('../scripts/catalogue-source-lib');
const {sourceAtCommit}=require('../scripts/catalogue-release-lib');
const {diffPayloads}=require('../scripts/catalogue-audit-lib');
const root=path.join(__dirname,'..'),source=readSource(path.join(root,'catalogue/source')).source,payload=compileSource(source),defence='Dr Aphra';
// Independent acceptance pins from #165, rather than deriving expectations from authored rows.
// The historical correction-chain test is anchored to the last v34 source commit,
// not the moving current catalogue; future approved corrections must not rewrite history.
const expected=[
['DASH_HAN_CHEWIE',['DASH_RENDAR','HAN_SOLO','CHEWBACCA'],'A',54],
['CLS_HAN_CHEWIE',['COMMANDER_LUKE_SKYWALKER','HAN_SOLO','CHEWBACCA'],'A',54],
['CLS_C3PO_CHEWPIO',['COMMANDER_LUKE_SKYWALKER','C3PO','THREEPIO_AND_CHEWIE'],'A',53],
['DOCTOR_APHRA',['DOCTOR_APHRA','BT_1','0_0_0'],'A',53],
['GUNGANS_TARPALS_JAR_JAR',['BOSS_NASS','CAPTAIN_TARPALS','JAR_JAR_BINKS'],'A',55],
['JMK_CAT_GK',['JEDI_MASTER_KENOBI','COMMANDER_AHSOKA_TANO','GENERAL_KENOBI'],'S',56],
['SLKR_HUX_KRU',['SUPREME_LEADER_KYLO_REN','GENERAL_HUX','KYLO_REN_UNMASKED'],'S',54],
['REVA',['THIRD_SISTER','GRAND_INQUISITOR','SEVENTH_SISTER'],'A',54],
['STARKILLER',['EMPEROR_PALPATINE','MARA_JADE','STARKILLER'],'A',53],
['BO_KATAN_MANDALORE',['BO_KATAN_MANDALOR','IG_12_AND_GROGU','PAZ_VIZSLA'],'A',55]];
function harness(owned){const c={__GAC_HELPER_TEST__:true,console,setTimeout,clearTimeout,navigator:{},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},document:{getElementById:()=>({innerHTML:''}),querySelectorAll:()=>[],querySelector:()=>null}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),c);const run=s=>vm.runInContext(s,c);run(`gacData=${JSON.stringify(payload.counters)};counterDefinitions=${JSON.stringify(payload.counterDefinitions)};characterDefinitions=${JSON.stringify(payload.characterDefinitions)};defenceTeams=${JSON.stringify(payload.defenceTeams)};defenceCompositions=${JSON.stringify(payload.defenceCompositions)};ownedCharacters=${JSON.stringify(owned)};usedTeams=[];board=createRoundBoard('KYBER','3v3',[{territory:'FRONT_TOP',type:'SQUAD',teamCount:1}],'opponent','round','now');board.teams[0].name='Dr Aphra';`);return {run};}
test('ten exact approved A/S banner defaults are full-size, non-provisional and deduplicated',()=>{
const rows=payload.counters['3v3'][defence];assert.equal(rows.length,11,'ten exact options plus preserved generic SLKR');assert.equal(new Set(rows.map(c=>c.counterId)).size,11);
for(const [id,members,tier,bannerScore] of expected){const row=rows.find(c=>c.counterId===id);assert.ok(row,id);assert.equal(row.tier,tier);assert.equal(row.bannerScore,bannerScore);assert.equal(row.undersize,0);assert.equal(row.confidence,undefined);assert.equal(row.role,undefined);assert.deepEqual([...payload.counterDefinitions[id].required].sort(),[...members].sort());assert.match(row.notes,/Owner-approved tier/);assert.match(row.notes,/not an empirically measured banner average/);assert.match(row.notes,/No datacron or omicron configuration confirmed/);assert.ok(row.notes.includes(payload.characterDefinitions[members[0]].name+' (leader)'));}
assert.deepEqual(payload.defenceCompositions['3v3'][defence],['DOCTOR_APHRA','BT_1','0_0_0']);assert.equal(payload.counters['3v3']['Doctor Aphra'],undefined);
});
test('preview paths account for every change and preserve existing cores, matchups and other modes',()=>{
const proposal=readCorrections(path.join(root,'catalogue/corrections/2026-11-06-aphra-3v3.json'));const correction167=readCorrections(path.join(root,'catalogue/corrections/2026-11-07-167-revan-malak-baylan.json'));const correction171=readCorrections(path.join(root,'catalogue/corrections/2026-11-10-171-bane-stranger.json'));const correction180=readCorrections(path.join(root,'catalogue/corrections/2026-11-10-180-bane-stranger-note.json'));const correction169=readCorrections(path.join(root,'catalogue/corrections/2026-11-10-169-geonosians-traya-vader.json'));const correction172=readCorrections(path.join(root,'catalogue/corrections/2026-11-09-172-reva-jmk.json'));const before=sourceAtCommit(root,proposal.baseline.commit).source;const old=compileSource(before);const v34=sourceAtCommit(root,'3acc291b6049ac723ba2fa875d5dd2678354e05e').source;const v34Payload=compileSource(v34);const corrections=[...proposal.corrections,...correction167.corrections,...correction171.corrections,...correction180.corrections,...correction169.corrections,...correction172.corrections];assert.deepEqual(applyCorrections(before,corrections),v34);assert.deepEqual(diffPayloads(old,v34Payload).map(d=>d.path).sort(),[...new Set(corrections.flatMap(c=>c.expectedPayloadPaths))].sort());
assert.deepEqual({...payload.counters['5v5'],Geonosians:payload.counters['5v5'].Geonosians.slice(0,-2)},old.counters['5v5']);assert.deepEqual(payload.counters.FLEET,old.counters.FLEET);assert.deepEqual(payload.counters['3v3'][defence][0],old.counters['3v3'][defence][0]);for(const [id,definition]of Object.entries(old.counterDefinitions))assert.deepEqual(payload.counterDefinitions[id],definition,id);
});
test('each exact option is eligible in Round, renders normal actions and requires every member',()=>{
for(const [id,members]of expected){const {run}=harness(members);run('roundPlan=computeRoundPlan();');assert.ok(run(`roundPlan.eligible[0].candidates.some(c=>c.counterId==='${id}')`),id);run(`roundPlan.reasons['FRONT_TOP:0'].counter=roundPlan.eligible[0].candidates.find(c=>c.counterId==='${id}');expandedCounterCards.add('FRONT_TOP:0:${id}');`);const html=run(`renderTeamRecommendation('opponent','FRONT_TOP',board.teams[0],'3v3')`);assert.match(html,/Used \+ Cleared/);assert.doesNotMatch(html,/Provisional counters/);for(const member of members)assert.ok(html.includes(run(`escapeHtml(getCharacterName('${member}'))`)),id+' '+member);
for(const missing of members){run(`ownedCharacters=${JSON.stringify(members.filter(m=>m!==missing))};`);assert.equal(run(`getCounterStatus('${id}')`),'not-owned',id+' '+missing);}
}
});
test('shared variants spend common units and cannot be allocated as independent resources',()=>{
for(const [a,b]of [['DASH_HAN_CHEWIE','CLS_HAN_CHEWIE'],['CLS_HAN_CHEWIE','CLS_C3PO_CHEWPIO'],['JMK_CAT_GK','JMK'],['SLKR_HUX_KRU','SLKR']]){const {run}=harness(Object.keys(payload.characterDefinitions));for(const [spent,blocked]of [[a,b],[b,a]]){run(`usedTeams=['${spent}'];`);assert.equal(run(`getCounterStatus('${blocked}')`),'spent');}}
const {run}=harness(['DASH_RENDAR','COMMANDER_LUKE_SKYWALKER','HAN_SOLO','CHEWBACCA']);run(`board.teams.push({...board.teams[0],index:1});roundPlan=computeRoundPlan();`);assert.equal(run('Object.keys(roundPlan.assign).length'),1);
run(`usedTeams=[];board.defenceSnapshot={schema:1,mode:'3v3',characterIds:['HAN_SOLO'],unresolvedTeams:[]};roundPlan=computeRoundPlan();`);assert.equal(run('Object.keys(roundPlan.assign).length'),0);
});
