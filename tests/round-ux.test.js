const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
function harness() {
    const values = new Map();
    const app = { innerHTML: '' };
    const context = { __GAC_HELPER_TEST__: true, console, setTimeout: () => 1, clearTimeout() {},
        confirm: () => true, prompt: () => '86', navigator: {},
        localStorage: {getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k)},
        document: {getElementById: id => id === 'app' ? app : null, querySelectorAll: () => [], querySelector: () => null} };
    vm.createContext(context); vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    run(`
        const cfg=[{territory:'FRONT_TOP',type:'SQUAD',teamCount:2},{territory:'BACK_TOP',type:'FLEET',teamCount:1}];
        board=createRoundBoard('KYBER','3v3',cfg,'opponent','r','now');
        myBoard=createRoundBoard('KYBER','3v3',cfg,'my','r','now');
        board.defenceSnapshot={schema:2,mode:'3v3',capturedAt:'now',characterIds:['A','B'],unresolvedTeams:[],missingSavedDefence:false,legacyCharacterIds:[],slots:[]};
        usageHistory.roundSeasons.r='85'; usageHistory.selectedSeasonId='86'; usageHistory.defenceRounds=['r'];
        counterDefinitions={C1:{name:'Attack one',required:[]},C2:{name:'Attack two',required:[]}};
        gacData={'3v3':{},'5v5':{},FLEET:{}};
    `);
    return {run};
}
test('summary uses cleared slots, team uses, frozen units and assigned season; administration is collapsed', () => {
    const {run}=harness();
    run(`board.teams[0].cleared=true;usedTeams=['C1','C2'];`);
    const html=run('renderRound()');
    assert.match(html,/3v3 · Season 85/);
    assert.match(html,/<strong>1<\/strong><span>Cleared<\/span>/);
    assert.match(html,/<strong>2<\/strong><span>Teams used<\/span>/);
    assert.match(html,/<strong>2<\/strong><span>On defence<\/span>/);
    assert.match(html,/Defence recorded/);
    const manage=html.match(/<details class="round-manage">([\s\S]*?)<\/details>/)[1];
    for (const handler of ['openRoundDefenceLineups','chooseUsageSeason','openBattleFeedbackReport','resetRound']) assert.ok(manage.includes(handler));
    run('chooseUsageSeason()');
    assert.equal(run('usageHistory.roundSeasons.r'),'85');
});
test('setup has no synthetic summary or management and retains storage errors', () => {
    const {run}=harness();
    run(`board=null;myBoard=null;usageHistoryMessage='Storage unavailable';`);
    const html=run('renderRound()');
    assert.doesNotMatch(html,/round-metrics|round-manage|CURRENT ROUND/);
    assert.match(html,/Storage unavailable/);
    assert.match(html,/GAC format/);
});
test('missing, incomplete, legacy and usage errors stay outside Manage round', () => {
    const {run}=harness();
    for (const state of [
        `board.defenceSnapshot.missingSavedDefence=true`,
        `board.defenceSnapshot.missingSavedDefence=false;board.defenceSnapshot.unresolvedTeams=['Unknown']`,
        `board.defenceSnapshot.unresolvedTeams=[];board.defenceSnapshot.legacyCharacterIds=['A']`,
        `board.defenceSnapshot.legacyCharacterIds=[];usageHistory.defenceRounds=[]`,
        `usageHistoryMessage='Could not save locally'`,
        `board.defenceSnapshot=null`
    ]) {
        run(state);
        const html=run('renderRound()').replace(/<details class="round-manage">[\s\S]*?<\/details>/,'');
        assert.match(html,/roster-msg-warn/);
        assert.match(html,/openRoundDefenceLineups|confirmRoundDefenceUsage|Could not save locally/);
    }
});
test('scored actions have result-first DOM order and existing handlers in squad and Fleet', () => {
    const {run}=harness();
    run(`roundPlan={reasons:{'FRONT_TOP:0':{counter:{counterId:'C1',counter:'Attack one',tier:'A',bannerScore:55}}}};board.teams[0].name='Defence';`);
    for(const mode of ['3v3','5v5','FLEET']) {
        const html=run(`renderTeamRecommendation('opponent','FRONT_TOP',board.teams[0],'${mode}')`);
        const buttons=html.match(/<div class="board-rec-actions">([\s\S]*?)<\/div>/)[1];
        assert.ok(buttons.indexOf('Used + Won') < buttons.indexOf('Used + Lost'));
        assert.ok(buttons.indexOf('Used + Lost') < buttons.indexOf('toggleTeamCleared'));
        assert.ok(buttons.indexOf('toggleTeamCleared') < buttons.indexOf('markCounterUsedFromBoard'));
        assert.match(buttons,/markUsedAndCleared/);
    }
});
test('results stay collapsed, separate and editable; Undo withdraws only its event', () => {
    const {run}=harness();
    run(`markUsedAndLost('opponent','FRONT_TOP',0,'C1');markUsedAndLost('opponent','FRONT_TOP',0,'C2')`);
    assert.equal(run('battleDetailsOpen.size'),0);
    assert.equal((run(`renderSlotBattleDetails('FRONT_TOP:0')`).match(/class="battle-details"/g)||[]).length,2);
    assert.equal(run(`updateBattleEvidence(usageHistory.events[0].id,'actualBanners','35').ok`),true);
    assert.equal(run(`updateBattleEvidence(usageHistory.events[1].id,'notes','second attempt').ok`),true);
    run('undoPendingAction()');
    assert.equal((run(`renderSlotBattleDetails('FRONT_TOP:0')`).match(/class="battle-details"/g)||[]).length,1);
    assert.equal(run('usageHistory.events[0].battleEvidence.actualBanners'),35);
    assert.equal(run('usageHistory.events[1].voided'),true);
    run(`markUsedAndCleared('opponent','FRONT_TOP',0,'C2')`);
    assert.equal(run('battleDetailsOpen.size'),0);
    assert.equal(run('board.teams[0].cleared'),true);
    assert.equal(run('usageHistory.events[1].outcome'),'won');
});
test('Next Up hides rationale separately from target and visible opening/reserve/Fleet precautions', () => {
    const {run}=harness();
    run(`roundPlan={reasons:{'FRONT_TOP:0':{reserveWarning:true}}};`);
    const pick={territory:'FRONT_TOP',index:0,name:'Long defence name',counter:{counterId:'C1',counter:'Attack one',tier:'A',bannerScore:55,undersize:1},isOpener:true,warning:'Material risk',reason:'Explanation'};
    let html=run(`renderNextUpRow(${JSON.stringify(pick)},false)`);
    const visible=html.split('<details')[0];
    assert.match(visible,/full squad/); assert.match(visible,/Material risk/); assert.match(visible,/Consider holding/);
    assert.ok(html.indexOf('</button>') < html.indexOf('<details'));
    assert.match(html,/<summary>Why this battle\?<\/summary>/);
    pick.isOpener=false;
    html=run(`renderNextUpRow(${JSON.stringify(pick)},true)`);
    assert.match(html.split('<details')[0],/unlocked slots only/);
});
