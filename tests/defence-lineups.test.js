const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const { compileSource, readSource } = require("../scripts/catalogue-source-lib.js");

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

test("compiled character registry reaches both lineup pickers and roster base-ID import", () => {
    const h = setup();
    const { source: catalogue } = readSource(path.join(__dirname, "..", "catalogue", "source"));
    const payload = compileSource(catalogue);
    h.run(`applyCataloguePayload(${JSON.stringify(payload)})`);
    const units = catalogue["units.json"];
    const characters = units.filter(unit => unit.unitType === "CHARACTER");
    assert.equal(characters.length, 341);
    assert.equal(units.length - characters.length, 70);
    for (const mode of ["5v5", "3v3"]) {
        h.run(`defenceLineupsMode = ${JSON.stringify(mode)}`);
        const options = h.run("renderDefenceLineupMember('characterIds', 0, 'CHARACTER', 'Member 1', '')");
        for (const unit of characters) assert.ok(options.includes(`value="${unit.id}"`), `${mode}: ${unit.name} selectable`);
        for (const unit of units.filter(unit => unit.unitType !== "CHARACTER")) assert.ok(!options.includes(`value="${unit.id}"`), `${mode}: ships excluded`);
    }
    const classified = JSON.parse(h.run(`JSON.stringify(classifyBaseIds(${JSON.stringify(units.map(unit => unit.externalId))}, {unitTypes: ['CHARACTER', 'SHIP', 'CAPITAL_SHIP']}))`));
    assert.deepEqual(classified.ownedUnitIds, units.map(unit => unit.id), "every registered base ID retains its internal identity");
    assert.deepEqual(classified.unknown, []);
    for (const [baseId, internalId] of [["HUYANG", "HUYANG"], ["GOPHERANTS", "GROGU_AND_ANZELLANS"], ["HUNTERS3", "HUNTER_MERCENARY"], ["HERASYNDULLAS3", "HERA_SYNDULLA"]]) {
        assert.equal(h.run(`baseIdToUnit[${JSON.stringify(baseId)}].characterId`), internalId);
    }
    assert.equal(h.run("baseIdToUnit.B1MERCDROID"), undefined, "future November release excluded at the October audit cutoff");
    assert.equal(h.run("baseIdToUnit.EMBOANDKEIBU"), undefined, "announced Conquest unit without current playability proof stays blocked");
});
test("verified fleet registry reaches both fleet roles and imports exact base IDs", () => {
    const h = setup();
    const { source: catalogue } = readSource(path.join(__dirname, "..", "catalogue", "source"));
    h.run(`applyCataloguePayload(${JSON.stringify(compileSource(catalogue))})`);
    // SWGOH.GG individual Base ID fields, observed 2026-10-23; full evidence in #145's PR.
    const additions = [
        ["AHSOKA_TANOS_JEDI_STARFIGHTER", "JEDISTARFIGHTERAHSOKATANO"],
        ["B_28_EXTINCTION_CLASS_BOMBER", "SITHBOMBER"],
        ["BTL_B_Y_WING_STARFIGHTER", "YWINGCLONEWARS"],
        ["COMEUPPANCE", "COMEUPPANCE"],
        ["FURY_CLASS_INTERCEPTOR", "FURYCLASSINTERCEPTOR"],
        ["IMPERIAL_TIE_FIGHTER", "TIEFIGHTERIMPERIAL"],
        ["MG_100_STARFORTRESS_SF_17", "MG100STARFORTRESSSF17"],
        ["MARAUDER", "MARAUDER"],
        ["MARK_VI_INTERCEPTOR", "SITHSUPREMACYCLASS"],
        ["PUNISHING_ONE", "PUNISHINGONE"],
        ["REBEL_B_WING", "BWINGREBEL"],
        ["REBEL_Y_WING", "YWINGREBEL"],
        ["RESISTANCE_X_WING", "XWINGRESISTANCE"],
        ["ROGUE_ONE", "ROGUEONESHIP"],
        ["TIE_DAGGER", "TIEDAGGER"],
        ["TIE_ECHELON", "FIRSTORDERTIEECHELON"],
        ["UMBARAN_STARFIGHTER", "UMBARANSTARFIGHTER"],
        ["VULTURE_DROID", "VULTUREDROID"]
    ];
    const units = catalogue["units.json"];
    assert.equal(new Set(units.map(unit => unit.id)).size, units.length);
    assert.equal(new Set(units.map(unit => unit.externalId)).size, units.length);
    const ships = units.filter(unit => unit.unitType === "SHIP");
    const capitals = units.filter(unit => unit.unitType === "CAPITAL_SHIP");
    assert.equal(ships.length, 59);
    assert.equal(capitals.length, 11);
    for (const mode of ["5v5", "3v3"]) {
        h.run(`defenceLineupsMode = ${JSON.stringify(mode)}`);
        for (const field of ["startingShipIds", "reinforcementIds"]) {
            const options = h.run(`renderDefenceLineupMember('${field}', 0, 'SHIP', 'Ship', '')`);
            for (const ship of ships) assert.ok(options.includes(`value="${ship.id}"`), `${mode} ${field}: ${ship.name}`);
            for (const unit of units.filter(unit => unit.unitType !== "SHIP")) assert.ok(!options.includes(`value="${unit.id}"`));
        }
        const options = h.run("renderDefenceLineupMember('capitalShipId', 0, 'CAPITAL_SHIP', 'Capital', '')");
        for (const unit of units) assert.equal(options.includes(`value="${unit.id}"`), unit.unitType === "CAPITAL_SHIP");
    }
    for (const [internalId, baseId] of additions) {
        assert.equal(h.run(`baseIdToUnit[${JSON.stringify(baseId)}].characterId`), internalId);
        assert.equal(h.run(`baseIdToUnit[${JSON.stringify(baseId)}].unitType`), "SHIP");
    }
    const bases = additions.map(([, base]) => base);
    const imported = JSON.parse(h.run(`JSON.stringify(classifyBaseIds(${JSON.stringify([...bases, ...bases])}, {unitTypes: ['SHIP', 'CAPITAL_SHIP']}))`));
    assert.deepEqual(imported.ownedUnitIds, additions.map(([id]) => id));
    assert.deepEqual(imported.counts, { CHARACTER: 0, SHIP: 18, CAPITAL_SHIP: 0 });
    assert.deepEqual(imported.unknown, []);
    const characterImport = JSON.parse(h.run(`JSON.stringify(classifyBaseIds(${JSON.stringify(bases)}))`));
    assert.deepEqual(characterImport.ownedUnitIds, []);
    assert.deepEqual(characterImport.ignoredKnown, bases);
    assert.deepEqual(characterImport.unknown, []);
    assert.equal(h.run("baseIdToUnit.XWINGBLACKONE.characterId"), "POE_DAMERONS_X_WING");
    assert.equal(h.run("baseIdToUnit.XWINGRESISTANCE.characterId"), "RESISTANCE_X_WING");
});

test("fleet catalogue additions preserve stored lineups and allow the three reported ships to save and reload", () => {
    const h = setup();
    const { source: catalogue } = readSource(path.join(__dirname, "..", "catalogue", "source"));
    const payload = compileSource(catalogue);
    const previousPayload = JSON.parse(JSON.stringify(payload));
    const addedIds = ["AHSOKA_TANOS_JEDI_STARFIGHTER","B_28_EXTINCTION_CLASS_BOMBER","BTL_B_Y_WING_STARFIGHTER","COMEUPPANCE","FURY_CLASS_INTERCEPTOR","IMPERIAL_TIE_FIGHTER","MG_100_STARFORTRESS_SF_17","MARAUDER","MARK_VI_INTERCEPTOR","PUNISHING_ONE","REBEL_B_WING","REBEL_Y_WING","RESISTANCE_X_WING","ROGUE_ONE","TIE_DAGGER","TIE_ECHELON","UMBARAN_STARFIGHTER","VULTURE_DROID"];
    for (const id of addedIds) delete previousPayload.characterDefinitions[id];
    h.run(`applyCataloguePayload(${JSON.stringify(previousPayload)})`);
    createTemplate(h, "Executor", "BACK_TOP");
    h.run(`
        editDefenceLineupMember("capitalShipId", 0, "EXECUTOR");
        editDefenceLineupMember("startingShipIds", 0, "HOUNDS_TOOTH");
        editDefenceLineupMember("startingShipIds", 1, "XANADU_BLOOD");
        editDefenceLineupMember("startingShipIds", 2, "RAZOR_CREST");
        editDefenceLineupMember("reinforcementIds", 0, "POE_DAMERONS_X_WING");
        saveDefenceLineupEditor(true);
    `);
    assert.equal(read(h, "5v5", "BACK_TOP").confirmed, true);
    const before = JSON.stringify(read(h, "5v5", "BACK_TOP"));
    const stored = h.values.get("defenceTemplate:5v5");
    h.run(`applyCataloguePayload(${JSON.stringify(payload)})`);
    assert.equal(JSON.stringify(read(h, "5v5", "BACK_TOP")), before);
    assert.equal(h.values.get("defenceTemplate:5v5"), stored, "catalogue update never rewrites saved membership");
    h.run(`
        openDefenceLineupEditor("BACK_TOP", 0);
        editDefenceLineupMember("startingShipIds", 0, "RESISTANCE_X_WING");
        editDefenceLineupMember("startingShipIds", 1, "MG_100_STARFORTRESS_SF_17");
        editDefenceLineupMember("startingShipIds", 2, "COMEUPPANCE");
        saveDefenceLineupEditor(true);
    `);
    assert.equal(read(h, "5v5", "BACK_TOP").confirmed, true);
    const restored = setup(Object.fromEntries(h.values));
    restored.run(`applyCataloguePayload(${JSON.stringify(payload)}); openDefenceLineupEditor('BACK_TOP', 0)`);
    assert.equal(JSON.stringify(read(restored, "5v5", "BACK_TOP")), JSON.stringify(read(h, "5v5", "BACK_TOP")));
    assert.equal(restored.run("defenceLineupEditor.lineup.capitalShipId"), "EXECUTOR");
    assert.deepEqual(JSON.parse(restored.run("JSON.stringify(defenceLineupEditor.lineup.startingShipIds)")), ["RESISTANCE_X_WING", "MG_100_STARFORTRESS_SF_17", "COMEUPPANCE"]);
    assert.deepEqual(JSON.parse(restored.run("JSON.stringify(defenceLineupEditor.lineup.reinforcementIds)")), ["POE_DAMERONS_X_WING"]);
});
