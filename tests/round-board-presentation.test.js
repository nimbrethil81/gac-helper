const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function harness(initialStorage = {}) {
    const values = new Map(Object.entries(initialStorage));
    const appElement = { innerHTML: "" };
    const nodes = new Map();
    const alerts = [];
    const context = {
        __GAC_HELPER_TEST__: true,
        console,
        setTimeout,
        clearTimeout,
        confirm: () => true,
        alert: message => alerts.push(message),
        navigator: {},
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: {
            getElementById: id => id === "app" ? appElement : nodes.get(id) || null,
            querySelectorAll: () => [],
            querySelector: () => null
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return {
        nodes,
        values,
        alerts,
        appElement,
        run: expression => vm.runInContext(expression, context)
    };
}

function basicConfig() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}


function setup() {
    const h = harness();
    h.run(`
        board = createRoundBoard("KYBER", "3v3", ${JSON.stringify(basicConfig())}, "opponent", "round", "now");
        myBoard = createRoundBoard("KYBER", "3v3", board.territories, "my", "round", "now");
        board.teams[0].name = "Enemy One";
        board.teams[1].name = "Enemy Two";
        gacData = { "3v3": {
            "Enemy One": [{ counterId: "C1", counter: "Counter One", tier: "S", bannerScore: 55, undersize: 0 }],
            "Enemy Two": [{ counterId: "C2", counter: "Counter Two", tier: "A", bannerScore: 54, undersize: 0 }]
        }};
        counterDefinitions = { C1: { name: "Counter One", required: ["U1"] }, C2: { name: "Counter Two", required: ["U2"] } };
        ownedCharacters = ["U1", "U2"];
        usageHistory.selectedSeasonId = "85";
        renderBoard();
    `);
    return h;
}

function rowToggle(h, territory, index, open) {
    const panel = { hidden: !open };
    h.nodes.set(`defence-panel-${territory}-${index}`, panel);
    h.nodes.set(`defence-toggle-${territory}-${index}`, { setAttribute() {} });
    h.run(`toggleDefenceRow("${territory}", ${index})`);
    return panel;
}

test("Remaining counts configured revealed defences only; empty and unknown entry remain usable", () => {
    const h = setup();
    h.run(`board.teams[0].name = NOT_IN_CATALOGUE; board.teams[1].name = ""; board.teams[2].name = "Hidden fleet"`);
    let html = h.run("renderBoard()");
    assert.match(html, /Remaining \(1\)/);
    assert.match(html, /Unknown defence/);
    assert.match(html, /Add\/select defence/);
    assert.doesNotMatch(html, /Hidden fleet/);
    h.run(`board.teams[0].name = ""`);
    html = h.run("renderBoard()");
    assert.match(html, /Remaining \(0\)/);
    assert.match(html, /Show All \/ enter defences/);
    assert.match(html, /Add\/select defence/);
});

test("automatic primary target and manual collapse/open survive rerenders, without changing board or plan", () => {
    const h = setup();
    const target = h.run("automaticDefenceTarget");
    const [territory, index] = target.split(":");
    const before = h.run("JSON.stringify([board, usedTeams, usageHistory, computeRoundPlan()])");
    rowToggle(h, territory, Number(index), true);
    assert.equal(h.run(`defenceRowState("${territory}", board.teams.find(t => t.territory === "${territory}")).manual`), false);
    const html = h.run("renderBoard()");
    assert.match(html, new RegExp(`id="defence-toggle-${territory}-${index}" aria-expanded="false"`));
    assert.equal(h.run("JSON.stringify([board, usedTeams, usageHistory, computeRoundPlan()])"), before);
    rowToggle(h, territory, Number(index), false);
    h.run("renderBoard()");
    assert.equal(h.run(`defenceRowState("${territory}", board.teams.find(t => t.territory === "${territory}")).manual`), true);
    h.run(`board.teams.find(t => t.territory === "${territory}").name = "Changed identity"; renderBoard()`);
    assert.equal(h.run(`defenceRowState("${territory}", board.teams.find(t => t.territory === "${territory}")).manual`), null);
});

test("Cleared filter survives allocation renders; explicit Next Up reveals and opens its target", () => {
    const h = setup();
    h.run(`opponentBoardFilter = "cleared"; renderBoard(); renderBoard()`);
    assert.equal(h.run("opponentBoardFilter"), "cleared");
    assert.doesNotMatch(h.run("renderBoard()"), /id="teamblock-FRONT_BOTTOM-0"/);
    h.run(`focusBoardTeam("FRONT_BOTTOM", 0)`);
    assert.equal(h.run("opponentBoardFilter"), "remaining");
    assert.match(h.run("renderBoard()"), /id="defence-toggle-FRONT_BOTTOM-0" aria-expanded="true"/);
});

test("win filters row away but leaves one board-level Undo and exactly restores event and slot", () => {
    const h = setup();
    h.run(`markUsedAndCleared("opponent", "FRONT_TOP", 0, "C1")`);
    let html = h.run("renderBoard()");
    assert.doesNotMatch(html, /id="teamblock-FRONT_TOP-0"/);
    assert.equal((html.match(/class="board-undo-btn"/g) || []).length, 1);
    h.run("undoPendingAction()");
    assert.equal(h.run("board.teams[0].cleared"), false);
    assert.equal(h.run("usageHistory.events.filter(e => !e.voided).length"), 0);
    assert.match(h.run("renderBoard()"), /id="teamblock-FRONT_TOP-0"/);
});

test("manual un-clear retains win; history uses saved identities and distinguishes zero from unknown", () => {
    const h = setup();
    h.run(`markUsedAndCleared("opponent", "FRONT_TOP", 0, "C1"); clearPendingUndo();
        toggleTeamCleared("opponent", "FRONT_TOP", 0);
        board.teams[0].name = "Changed defence";
        counterDefinitions.C1.name = "Changed counter";`);
    let html = h.run(`renderSlotBattleDetails("FRONT_TOP:0")`);
    assert.match(html, /Recorded battles \(1\)/);
    assert.match(html, /Enemy One/);
    assert.match(html, /Counter One/);
    assert.doesNotMatch(html, /Changed defence|Changed counter/);
    assert.match(html, /Banners not provided/);
    h.run(`updateBattleEvidence(usageHistory.events[0].id, "actualBanners", "0")`);
    html = h.run(`renderSlotBattleDetails("FRONT_TOP:0")`);
    assert.match(html, /0 actual banners/);
    assert.equal(h.run("usageHistory.events[0].outcome"), "won");
});

test("loss keeps cleanup target and allocated replacement, counts known losses separately from manual battles", () => {
    const h = setup();
    h.run(`gacData["3v3"]["Enemy One"].push({ counterId: "C3", counter: "Replacement", tier: "A", bannerScore: 53 });
        counterDefinitions.C3 = { name: "Replacement", required: ["U3"] }; ownedCharacters.push("U3");
        focusBoardTeam("FRONT_TOP", 0); markUsedAndLost("opponent", "FRONT_TOP", 0, "C1");`);
    let html = h.run("renderBoard()");
    assert.match(html, /Needs cleanup · 1 loss/);
    assert.match(html, /Replacement/);
    assert.match(html, /id="defence-toggle-FRONT_TOP-0" aria-expanded="true"/);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C3"); board.teams[0].attempts = 4`);
    html = h.run("renderBoard()");
    assert.match(html, /Needs cleanup · 2 losses · 4 battles/);
    assert.match(html, /Recorded battles \(2\)/);
    h.run("clearPendingUndo()");
});

test("automatic advance does not pin former targets and My Board ignores opponent filter", () => {
    const h = setup();
    h.run(`focusBoardTeam("FRONT_TOP", 0, false); renderBoard()`);
    assert.equal(h.run('defenceRows.get("opponent:FRONT_TOP:0").manual'), null);
    h.run(`opponentBoardFilter = "cleared"`);
    const html = h.run("renderMyBoard()");
    assert.equal((html.match(/id="teamblock-/g) || []).length, 4);
    assert.doesNotMatch(html, /Used \+ Won|defence-row-toggle|setBoardTeam/);
});

test("squad is the sole automatic target with both tracks; explicit Fleet focus stays usable", () => {
    const h = setup();
    h.run(`board.teams[0].cleared = true;
        board.teams[2].name = "Fleet Enemy";
        gacData.FLEET = { "Fleet Enemy": [{counterId:"F1",counter:"Fleet Counter",tier:"S",bannerScore:73}] };
        counterDefinitions.F1 = {name:"Fleet Counter",required:[]}; renderBoard();`);
    assert.match(h.run("automaticDefenceTarget"), /FRONT_BOTTOM/);
    let html = h.run("renderBoard()");
    assert.match(html, /id="defence-toggle-BACK_TOP-0" aria-expanded="false"/);
    h.run(`focusBoardTeam("BACK_TOP",0,false)`);
    html = h.run("renderBoard()");
    assert.match(html, /id="defence-toggle-BACK_TOP-0" aria-expanded="false"/);
    h.run(`focusBoardTeam("BACK_TOP",0)`);
    assert.match(h.run("renderBoard()"), /id="defence-toggle-BACK_TOP-0" aria-expanded="true"/);
});

test("changing defence with the same counter closes old counter Details on the first render", () => {
    const h = setup();
    h.run(`expandedCounterCards.add("FRONT_TOP:0:C1");
        gacData["3v3"]["Changed"] = gacData["3v3"]["Enemy One"];
        board.teams[0].name = "Changed";`);
    const html = h.run("renderBoard()");
    assert.equal(h.run(`expandedCounterCards.has("FRONT_TOP:0:C1")`), false);
    assert.match(html, /id="counter-details-FRONT_TOP%3A0%3AC1-toggle" class="board-rec-disclosure" aria-expanded="false"/);
});

test("loss retains cleanup expansion even when another slot becomes the primary target", () => {
    const h = setup();
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 0, "C1")`);
    assert.equal(h.run("automaticDefenceTarget"), "FRONT_BOTTOM:0");
    assert.match(h.run("renderBoard()"), /id="defence-toggle-FRONT_TOP-0" aria-expanded="true"/);
    h.run("clearPendingUndo()");
});
