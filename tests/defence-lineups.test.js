const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function harness(initialStorage = {}) {
    const values = new Map(Object.entries(initialStorage));
    const appElement = { innerHTML: "" };
    const alerts = [];
    const context = {
        __GAC_HELPER_TEST__: true,
        console,
        setTimeout,
        clearTimeout,
        confirm: () => true,
        alert: message => alerts.push(message),
        navigator: { onLine: false },
        localStorage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        document: {
            getElementById: id => id === "app" ? appElement : null,
            querySelectorAll: () => [],
            querySelector: () => null
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "app.js" });
    return {
        values,
        alerts,
        appElement,
        setConfirm: callback => { context.confirm = callback; },
        run: expression => vm.runInContext(expression, context)
    };
}

function setup(initialStorage = {}) {
    const h = harness(initialStorage);
    h.run(`
        boardConfig = { KYBER: {}, AURODIUM: {} };
        const cfg = [
            { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
            { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
            { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
            { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
        ];
        for (const mode of ["5v5", "3v3"]) {
            boardConfig.KYBER[mode] = cfg;
            boardConfig.AURODIUM[mode] = cfg.map(t => ({ ...t, teamCount: t.territory === "FRONT_TOP" ? 2 : 1 }));
        }
        characterDefinitions = Object.fromEntries(["A", "B", "C", "D", "E", "F"].map(id => [id, {name: "Unit " + id, unitType: "CHARACTER"}]));
        for (const id of ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]) characterDefinitions[id] = { name: "Ship " + id, unitType: "SHIP" };
        characterDefinitions.CAP = { name: "Capital", unitType: "CAPITAL_SHIP" };
        gacData = { "5v5": { Wall: [], Partial: [], "Fleet-looking squad": [] }, "3v3": { Trio: [] }, FLEET: { Armada: [] } };
        defenceCompositions = { "5v5": { Wall: ["A", "B", "C", "D", "E"], Partial: ["A", "B"] }, "3v3": { Trio: ["A", "B", "C"] }, FLEET: { Armada: ["CAP", "S1", "S2", "S3", "S4"] } };
        setView("defence-lineups");
    `);
    return h;
}

function createTemplate(h, name = "Wall", territory = "FRONT_TOP") {
    h.run(`setDefenceLineupsLeague("KYBER"); setDefenceLineupsIdentity("${territory}", 0, ${JSON.stringify(name)}); openDefenceLineupEditor("${territory}", 0)`);
}

function html(h) { return h.appElement.innerHTML; }
function read(h, mode = "5v5", territory = "FRONT_TOP") {
    return h.run(`readDefenceTemplateLineup("${mode}", "${territory}", 0)`);
}

test("More opens Defence Lineups with no round or roster, groups empty slots and returns to More", () => {
    const h = setup();
    h.run("setView('more')");
    const link = html(h).match(/<button class="more-menu-entry" onclick="([^"]+)">\s*<span>🛡️ Defence Lineups/);
    assert.ok(link);
    h.run(link[1]);
    assert.match(html(h), /Back to More/);
    assert.match(html(h), /nav-button active" onclick="setView\('more'\)/);
    assert.equal(h.run("board"), null);
    assert.equal(h.values.has("rosterData"), false);
    h.run("setDefenceLineupsLeague('KYBER')");
    for (const territory of ["Front Top", "Front Bottom", "Back Top · Fleet", "Back Bottom"]) assert.ok(html(h).includes(territory));
    assert.match(html(h), /0 \/ 0 populated teams confirmed · 0 need confirmation · 0 incomplete/);
    assert.equal((html(h).match(/>Empty slot<\/div>/g) || []).length, 4);
    assert.doesNotMatch(html(h), />Needs confirmation<\/div>/);
    h.run("setView('more')");
    assert.match(html(h), /My Roster/);
});

test("partial catalogue proposals stay unselected and incomplete until explicit progressive saves and confirmation", () => {
    const h = setup();
    createTemplate(h, "Partial");
    assert.match(html(h), /Catalogue proposal · incomplete/);
    assert.equal(h.run("defenceLineupEditor.lineup.characterIds.length"), 0);
    assert.equal(read(h).confirmed, false);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor()");
    assert.match(html(h), /0 \/ 1 populated teams confirmed · 0 need confirmation · 1 incomplete/);
    assert.equal(read(h).lineup.characterIds.length, 2);
    assert.equal(read(h).confirmed, false);
    const restored = setup(Object.fromEntries(h.values));
    restored.run("openDefenceLineupEditor('FRONT_TOP', 0)");
    assert.match(html(restored), /Saved player assignments/);
    assert.doesNotMatch(html(restored), /Catalogue proposal/);
    restored.run(`editDefenceLineupMember("characterIds", 2, "C"); editDefenceLineupMember("characterIds", 3, "D"); editDefenceLineupMember("characterIds", 4, "E"); saveDefenceLineupEditor()`);
    assert.match(html(restored), /0 \/ 1 populated teams confirmed · 1 need confirmation · 0 incomplete/);
    restored.run("saveDefenceLineupEditor(true)");
    assert.match(html(restored), /1 \/ 1 populated teams confirmed/);
    assert.equal(read(restored).confirmed, true);
    assert.equal(read(setup(Object.fromEntries(restored.values))).confirmed, true);
    restored.run("editDefenceLineupMember('characterIds', 4, 'F'); saveDefenceLineupEditor()");
    assert.equal(read(restored).confirmed, false);
});

test("complete proposals require player confirmation and another team's suggestion never reserves units", () => {
    const h = setup();
    createTemplate(h);
    assert.match(html(h), /Needs confirmation/);
    assert.equal(read(h).source, "defence-composition");
    h.run("setDefenceLineupsIdentity('FRONT_BOTTOM', 0, 'Partial'); useDefenceLineupProposal()");
    // Identity edits close the editor; reopen explicitly before accepting.
    h.run("openDefenceLineupEditor('FRONT_TOP', 0); useDefenceLineupProposal(); saveDefenceLineupEditor(true)");
    assert.equal(read(h).confirmed, true);
    assert.equal(read(h, "5v5", "FRONT_BOTTOM").source, "defence-composition");
    assert.equal(read(h, "5v5", "FRONT_BOTTOM").confirmed, false);
    assert.match(html(h), /1 \/ 2 populated teams confirmed · 0 need confirmation · 1 incomplete/);
});

test("5v5 and 3v3 including Fleet keep independent layout and membership without changing Counters mode", () => {
    const h = setup();
    createTemplate(h);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor(true); setDefenceLineupsMode('3v3'); setDefenceLineupsLeague('AURODIUM'); setDefenceLineupsIdentity('FRONT_TOP', 0, 'Trio'); openDefenceLineupEditor('FRONT_TOP', 0); useDefenceLineupProposal(); saveDefenceLineupEditor(true)");
    assert.match(html(h), /Aurodium · 3v3 · 5 slots including Fleet/);
    assert.equal(read(h, "3v3").lineup.characterIds.length, 3);
    h.run("setDefenceLineupsMode('5v5')");
    assert.match(html(h), /Kyber · 5v5 · 4 slots including Fleet/);
    assert.equal(read(h).lineup.characterIds.length, 5);
    assert.equal(read(h).confirmed, true);
    assert.equal(h.run("currentMode"), "5v5");
});

test("duplicate deployment blocks draft saves across territories and duplicate members within a team", () => {
    const h = setup();
    createTemplate(h);
    h.run("editDefenceLineupMember('characterIds', 0, 'A'); saveDefenceLineupEditor(); setDefenceLineupsIdentity('FRONT_BOTTOM', 0, 'Partial'); openDefenceLineupEditor('FRONT_BOTTOM', 0); useDefenceLineupProposal()");
    assert.match(html(h), /Unit A is already assigned to another saved team/);
    assert.match(html(h), /onclick="saveDefenceLineupEditor\(\)" disabled/);
    h.run("saveDefenceLineupEditor()");
    assert.equal(read(h, "5v5", "FRONT_BOTTOM").source, "defence-composition");
    h.run("editDefenceLineupMember('characterIds', 0, 'B')");
    assert.match(html(h), /A unit is selected more than once/);
    h.run("editDefenceLineupMember('characterIds', 0, ''); saveDefenceLineupEditor()");
    assert.equal(read(h, "5v5", "FRONT_BOTTOM").source, "saved");
});

test("custom and saved-outside-catalogue identities edit canonical characters without name guesses", () => {
    const h = setup();
    createTemplate(h, "Fleet-looking squad");
    assert.match(html(h), />Member 1</);
    assert.doesNotMatch(html(h), />Capital ship</);
    h.run(`setDefenceLineupsIdentity("FRONT_TOP", 0, NOT_IN_CATALOGUE, "My wall"); openDefenceLineupEditor("FRONT_TOP", 0); editDefenceLineupMember("characterIds", 0, "F"); editDefenceLineupMember("intentionalUndersize", 0, true); saveDefenceLineupEditor(true)`);
    assert.equal(read(h).confirmed, true);
    assert.match(html(h), /value="My wall"/);
    assert.doesNotMatch(html(h), /Catalogue proposal/);
    h.run("setDefenceLineupsIdentity('FRONT_BOTTOM', 0, 'Legacy Wall'); openDefenceLineupEditor('FRONT_BOTTOM', 0)");
    assert.match(html(h), /Legacy Wall \(saved; not in current catalogue\)/);
    assert.doesNotMatch(html(h), /Catalogue proposal/);
    assert.equal(read(h, "5v5", "FRONT_BOTTOM"), null);
});

test("Fleet flat proposal renders without assigning roles; capital + three starters with zero reinforcements can confirm", () => {
    const h = setup();
    createTemplate(h, "Armada", "BACK_TOP");
    assert.match(html(h), /Catalogue proposal · incomplete/);
    assert.match(html(h), /Starting and reinforcement roles are unknown/);
    assert.match(html(h), /Capital, Ship S1, Ship S2, Ship S3, Ship S4/);
    assert.equal(h.run("defenceLineupEditor.lineup.capitalShipId"), "");
    assert.equal(h.run("defenceLineupEditor.lineup.startingShipIds.length"), 0);
    assert.equal((html(h).match(/>Starting ship [123]</g) || []).length, 3);
    assert.equal((html(h).match(/>Reinforcement \(optional\) [1234]</g) || []).length, 4);
    assert.doesNotMatch(html(h), /Use proposal in draft/);
    h.run(`editDefenceLineupMember("capitalShipId", 0, "CAP"); editDefenceLineupMember("startingShipIds", 0, "S1"); saveDefenceLineupEditor()`);
    assert.equal(read(h, "5v5", "BACK_TOP").complete, false);
    h.run(`editDefenceLineupMember("startingShipIds", 1, "S2"); editDefenceLineupMember("startingShipIds", 2, "S3"); saveDefenceLineupEditor(true)`);
    assert.equal(read(h, "5v5", "BACK_TOP").confirmed, true);
    h.run(`editDefenceLineupMember("reinforcementIds", 0, "S1")`);
    assert.match(html(h), /A unit is selected more than once/);
    h.run(`editDefenceLineupMember("reinforcementIds", 0, "S4"); saveDefenceLineupEditor(true)`);
    assert.equal(read(h, "5v5", "BACK_TOP").lineup.reinforcementIds.length, 1);
    h.run(`editDefenceLineupMember("reinforcementIds", 0, ""); saveDefenceLineupEditor(true)`);
    assert.equal(read(h, "5v5", "BACK_TOP").lineup.reinforcementIds.length, 0);
});

test("derived progress never trusts corrupt confirmed flags and invalid saved IDs remain repairable", () => {
    const h = setup();
    createTemplate(h);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor(true)");
    const saved = JSON.parse(h.values.get("defenceTemplate:5v5"));
    saved.teams[0].lineup.characterIds = ["UNKNOWN"];
    saved.teams.push(null);
    h.values.set("defenceTemplate:5v5", JSON.stringify(saved));
    h.run("closeDefenceLineupEditor(); render()");
    assert.match(html(h), /0 \/ 1 populated teams confirmed · 0 need confirmation · 1 incomplete/);
    h.run("openDefenceLineupEditor('FRONT_TOP', 0)");
    assert.match(html(h), /UNKNOWN \(unavailable \/ invalid\)/);
    assert.equal(JSON.parse(h.values.get("defenceTemplate:5v5")).teams[0].lineup.confirmed, true);
    h.run("clearDefenceLineupDraft(); saveDefenceLineupEditor()");
    assert.equal(read(h).lineup.characterIds.length, 0);
});

test("unavailable registry preserves saved assignments and null/primitive lineups can be replaced", () => {
    const h = setup();
    createTemplate(h);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor(true); closeDefenceLineupEditor(); characterDefinitions = {}; render()");
    assert.match(html(h), /0 \/ 1 populated teams confirmed · 0 need confirmation · 1 incomplete/);
    h.run("openDefenceLineupEditor('FRONT_TOP', 0)");
    assert.match(html(h), /A \(unavailable \/ invalid\)/);
    assert.equal(JSON.parse(h.values.get("defenceTemplate:5v5")).teams[0].lineup.confirmed, true);
    for (const invalid of [null, "broken"]) {
        const saved = JSON.parse(h.values.get("defenceTemplate:5v5"));
        saved.teams[0].lineup = invalid;
        h.values.set("defenceTemplate:5v5", JSON.stringify(saved));
        h.run("closeDefenceLineupEditor(); openDefenceLineupEditor('FRONT_TOP', 0); clearDefenceLineupDraft(); saveDefenceLineupEditor()");
        assert.equal(read(h).lineup.characterIds.length, 0);
        assert.equal(read(h).confirmed, false);
    }
});

test("unsaved editor changes can keep navigation/mode changes pending; saved progress permits return", () => {
    const h = setup();
    createTemplate(h);
    h.run("editDefenceLineupMember('characterIds', 0, 'F')");
    h.setConfirm(() => false);
    h.run("setDefenceLineupsMode('3v3'); setView('more')");
    assert.equal(h.run("defenceLineupsMode"), "5v5");
    assert.equal(h.run("currentView"), "defence-lineups");
    assert.equal(h.run("defenceLineupEditor.lineup.characterIds[0]"), "F");
    h.run("saveDefenceLineupEditor(); setView('more')");
    assert.equal(h.run("currentView"), "more");
    assert.equal(read(h).lineup.characterIds[0], "F");
});

test("layout changes preserve matching confirmed teams and cancellation preserves the entire saved layout", () => {
    const h = setup();
    createTemplate(h);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor(true); setDefenceLineupsLeague('AURODIUM')");
    assert.equal(read(h).confirmed, true);
    assert.match(html(h), /Aurodium · 5v5 · 5 slots including Fleet/);
    h.run("setDefenceLineupsIdentity('FRONT_TOP', 1, 'Extra team')");
    const before = h.values.get("defenceTemplate:5v5");
    h.setConfirm(() => false);
    h.run("setDefenceLineupsLeague('KYBER')");
    assert.equal(h.values.get("defenceTemplate:5v5"), before);
    h.setConfirm(() => true);
    h.run("setDefenceLineupsLeague('KYBER')");
    assert.equal(h.run("loadDefenceTemplate('5v5').teams.some(t => t.name === 'Extra team')"), false);
    assert.equal(read(h).confirmed, true);
});

test("editing future templates leaves all active Round state, filtering and persistence unchanged", () => {
    const h = setup();
    h.run(`
        board = createRoundBoard("KYBER", "5v5", boardConfig.KYBER["5v5"], "opponent", "round", "now");
        myBoard = createCompanionMyBoard(board);
        board.defenceSnapshot = { schema: 1, mode: "5v5", source: "template", capturedAt: "now", characterIds: ["F"], unresolvedTeams: [] };
        myBoard.teams[0].name = "Existing live defence";
        board.teams[0].name = "Existing enemy";
        board.teams[0].attempts = 2;
        activeBoardSide = "my"; focusedTeamKey = "FRONT_TOP:0";
        usedTeams = ["spent"]; bannerData.myScore = 321;
        saveBoard("opponent"); saveBoard("my");
    `);
    const before = h.run("JSON.stringify({board, myBoard, usedTeams, bannerData, activeBoardSide, focusedTeamKey, roundPlan, currentMode})");
    const stored = [h.values.get("boardData"), h.values.get("myBoardData")];
    h.run("setView('more'); setView('defence-lineups')");
    createTemplate(h);
    h.run("useDefenceLineupProposal(); saveDefenceLineupEditor(true); setView('more')");
    assert.equal(h.run("JSON.stringify({board, myBoard, usedTeams, bannerData, activeBoardSide, focusedTeamKey, roundPlan, currentMode})"), before);
    assert.deepEqual([h.values.get("boardData"), h.values.get("myBoardData")], stored);
    assert.equal(h.run("isCharacterOnDefence('F')"), true);
    assert.equal(h.run("isCharacterOnDefence('A')"), false);
});
