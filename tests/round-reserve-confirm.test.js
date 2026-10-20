const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Confirm before spending a strategic-reserve counter (issue #67). Marking a
// High-reserve counter used on the Opponent Board while any enemy zone is still
// hidden asks first. Cancel changes nothing; OK runs the existing flow once. The
// confirmation never appears for revealed boards, normal counters, the Counters
// screen, My Board, an already-used counter, undo, or rendering.

function harness() {
    const values = new Map();
    const appElement = { innerHTML: "" };
    const confirms = [];
    const state = { answer: true };
    const context = {
        __GAC_HELPER_TEST__: true,
        console,
        setTimeout,
        clearTimeout,
        confirm: message => { confirms.push(message); return state.answer; },
        alert: () => {},
        navigator: {},
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
        run: expression => vm.runInContext(expression, context),
        confirms,
        answer: value => { state.answer = value; },
        stored: key => values.get(key),
        storage: () => [...values.entries()]
    };
}

function config() {
    return [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 1 },
        { territory: "FRONT_BOTTOM", type: "SQUAD", teamCount: 1 },
        { territory: "BACK_TOP", type: "FLEET", teamCount: 1 },
        { territory: "BACK_BOTTOM", type: "SQUAD", teamCount: 1 }
    ];
}

const BANE = { counterId: "BANE", counter: "Bane", tier: "S", bannerScore: 65, undersize: 0 };
const SEE_BANE = { counterId: "SEE_BANE", counter: "SEE and Bane", tier: "S", bannerScore: 66, undersize: 0 };
const RELIABLE = { counterId: "RELIABLE", counter: "Reliable Squad", tier: "A", bannerScore: 55, undersize: 0 };
const DEFS = {
    BANE: { name: "Bane", required: ["DARTH_BANE"], recommended: [], strategicReserve: true },
    SEE_BANE: { name: "SEE and Bane", required: ["SITH_ETERNAL_EMPEROR", "DARTH_BANE"], recommended: [], strategicReserve: true },
    RELIABLE: { name: "Reliable Squad", required: ["RELIABLE_LEADER"], recommended: [] }
};
const OWNED = ["DARTH_BANE", "SITH_ETERNAL_EMPEROR", "RELIABLE_LEADER"];

// FRONT_BOTTOM carries the defence under test; the other front territory is left
// uncleared, so BACK_* stay locked behind the reveal chain (hidden zones).
function setUpBoard(h, { mode = "3v3", counters = [BANE, RELIABLE], revealed = false } = {}) {
    const territory = revealed ? "BACK_BOTTOM" : "FRONT_BOTTOM";
    h.run(`
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(config())}, "opponent", "round", "now");
        ${revealed ? `
        board.teams.find(t => t.territory === "FRONT_TOP").name = "Dummy Front Top";
        board.teams.find(t => t.territory === "FRONT_TOP").cleared = true;
        board.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Dummy Front Bottom";
        board.teams.find(t => t.territory === "FRONT_BOTTOM").cleared = true;` : ""}
        board.teams.find(t => t.territory === "${territory}").name = "Darth Malgus";
        gacData = { "${mode}": { "Darth Malgus": ${JSON.stringify(counters)} } };
        counterDefinitions = ${JSON.stringify(DEFS)};
        characterDefinitions = {};
        ownedCharacters = ${JSON.stringify(OWNED)};
        usedTeams = [];
        localStorage.removeItem("usedTeams");
        expandedCounterCards = new Set();
        roundPlan = computeRoundPlan();
    `);
    return territory;
}

const teamCleared = (h, territory) => h.run(`board.teams.find(t => t.territory === "${territory}").cleared`);

test("hidden zones: cancelling the confirmation leaves every piece of state untouched", () => {
    const h = harness();
    setUpBoard(h);
    h.answer(false);
    const before = h.run(`JSON.stringify({ used: usedTeams, board, focusedTeamKey, pendingUndo: pendingUndo && pendingUndo.kind })`);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /Use Bane now\?/);
    assert.match(h.confirms[0], /Some enemy squads are still hidden/);
    assert.equal(h.run(`JSON.stringify({ used: usedTeams, board, focusedTeamKey, pendingUndo: pendingUndo && pendingUndo.kind })`), before);
    assert.equal(h.stored("usedTeams"), undefined, "nothing is persisted");
});

test("hidden zones: confirming marks the counter used exactly once", () => {
    const h = harness();
    setUpBoard(h);
    h.answer(true);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
    assert.equal(h.stored("usedTeams"), `["BANE"]`);
});

test("SEE_BANE is confirmed under its own display name", () => {
    const h = harness();
    setUpBoard(h, { counters: [SEE_BANE, RELIABLE] });
    h.answer(false);

    h.run(`markCounterUsedFromBoard("SEE_BANE")`);

    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /Use SEE and Bane now\?/);
    assert.equal(h.run(`usedTeams.length`), 0);

    h.answer(true);
    h.run(`markCounterUsedFromBoard("SEE_BANE")`);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["SEE_BANE"]`);
});

test("Used + Cleared on a reserve counter: cancel changes nothing, confirm applies both once", () => {
    const h = harness();
    const territory = setUpBoard(h, { counters: [BANE] });
    h.answer(false);

    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
    assert.equal(teamCleared(h, territory), false);
    assert.equal(h.run(`pendingUndo`), null, "no Undo offer is created for a cancelled action");

    h.answer(true);
    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 2);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
    assert.equal(teamCleared(h, territory), true);
    assert.equal(h.run(`pendingUndo.kind`), "usedCleared");
});

test("a displayed reserve alternative goes through the same confirmation", () => {
    const h = harness();
    const territory = setUpBoard(h);
    assert.equal(h.run(`roundPlan.assign["${territory}:0"].counterId`), "RELIABLE");
    const html = h.run(`renderTeamRecommendation("opponent", "${territory}", board.teams.find(t => t.territory === "${territory}"), "3v3")`);
    assert.match(html, /markCounterUsedFromBoard\('BANE', 'FRONT_BOTTOM:0'\)/);
    h.answer(false);

    h.run(`markCounterUsedFromBoard("BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
});

test("5v5 boards are confirmed too", () => {
    const h = harness();
    setUpBoard(h, { mode: "5v5" });
    h.answer(false);
    h.run(`markCounterUsedFromBoard("BANE")`);
    assert.equal(h.confirms.length, 1);
    assert.equal(h.run(`usedTeams.length`), 0);
});

test("no confirmation once every enemy zone is revealed (checked at click time)", () => {
    const h = harness();
    setUpBoard(h, { revealed: true });
    assert.equal(h.run(`roundHasHiddenZones(board)`), false);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
});

test("no confirmation for a normal counter, even with hidden zones", () => {
    const h = harness();
    setUpBoard(h);
    assert.equal(h.run(`roundHasHiddenZones(board)`), true);

    h.run(`markCounterUsedFromBoard("RELIABLE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["RELIABLE"]`);
});

test("no confirmation when the reserve counter is already used", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`usedTeams = ["BANE"]`);

    h.run(`markCounterUsedFromBoard("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`, "no duplicate entry");
});

test("the Counters screen's own Mark used is unchanged and never confirms", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`showCounters = () => {};`);

    h.run(`markUsed("BANE")`);

    assert.equal(h.confirms.length, 0);
    assert.equal(h.run(`JSON.stringify(usedTeams)`), `["BANE"]`);
});

test("My Board actions never confirm", () => {
    const h = harness();
    setUpBoard(h);
    h.run(`
        myBoard = createRoundBoard("KYBER", "3v3", ${JSON.stringify(config())}, "my", "round", "now");
        myBoard.teams.find(t => t.territory === "FRONT_BOTTOM").name = "Darth Malgus";
    `);
    h.answer(false);

    h.run(`markUsedAndCleared("my", "FRONT_BOTTOM", 0, "BANE")`);

    assert.equal(h.confirms.length, 0);
});

test("undo, render and recomputing the plan never prompt", () => {
    const h = harness();
    const territory = setUpBoard(h, { counters: [BANE] });
    h.answer(true);
    h.run(`markUsedAndCleared("opponent", "${territory}", 0, "BANE")`);
    assert.equal(h.confirms.length, 1);

    h.run(`undoPendingAction()`);
    h.run(`roundPlan = computeRoundPlan()`);
    h.run(`renderTeamRecommendation("opponent", "${territory}", board.teams.find(t => t.territory === "${territory}"), "3v3")`);

    assert.equal(h.confirms.length, 1, "only the original action prompted");
    assert.equal(h.run(`usedTeams.length`), 0, "undo restored the unused state");
});

// Fully visible SC-01 fixture: A+A conserves SEE for the Stranger rather than
// choosing the old banner-favoured S+B allocation. SEE itself has no reserve flag.
function setUpConservation(h, mode = "5v5", hidden = false) {
    const cfg = [
        { territory: "FRONT_TOP", type: "SQUAD", teamCount: 2 },
        ...(hidden ? [{ territory: "BACK_TOP", type: "FLEET", teamCount: 1 }] : [])
    ];
    h.run(`
        board = createRoundBoard("KYBER", "${mode}", ${JSON.stringify(cfg)}, "opponent", "r", "now");
        board.teams[0].name = "Easy Defence";
        board.teams[1].name = "The Stranger";
        counterDefinitions = {
            SEE: { name: "SEE", required: ["SITH_ETERNAL_EMPEROR"] },
            BANE: ${JSON.stringify(DEFS.BANE)},
            SEE_BANE: ${JSON.stringify(DEFS.SEE_BANE)},
            RELIABLE: ${JSON.stringify(DEFS.RELIABLE)},
            WEAK: { name: "Weak backup", required: ["WEAK"] }
        };
        characterDefinitions = {
            SITH_ETERNAL_EMPEROR: { name: "Sith Eternal Emperor" }, DARTH_BANE: { name: "Darth Bane" }
        };
        ownedCharacters = [...${JSON.stringify(OWNED)}, "WEAK"];
        gacData = { "${mode}": {
            "Easy Defence": [
                { counterId: "SEE", counter: "SEE", tier: "S", bannerScore: 65, undersize: 0 },
                ${JSON.stringify(RELIABLE)}
            ],
            "The Stranger": [
                { counterId: "SEE_BANE", counter: "SEE and Bane", tier: "A", bannerScore: 50, undersize: 0 },
                { counterId: "BANE", counter: "Bane", tier: "B", bannerScore: 65, undersize: 0 }
            ]
        } };
        usedTeams = []; spentCharsCache = { key: null, map: new Map() };
        roundPlan = computeRoundPlan();
    `);
}

for (const mode of ["5v5", "3v3"]) {
    for (const action of [
        `markCounterUsedFromBoard("SEE", "FRONT_TOP:0")`,
        `markUsedAndCleared("opponent", "FRONT_TOP", 0, "SEE")`,
        `markUsedAndLost("opponent", "FRONT_TOP", 0, "SEE")`
    ]) {
        test(`${mode}: ${action} cancellation preserves state, storage, focus and existing Undo`, () => {
            const h = harness();
            setUpConservation(h, mode);
            h.run(`
                focusedTeamKey = "FRONT_TOP:0";
                setPendingUndo({ kind: "cleared", side: "opponent", territoryKey: "FRONT_TOP", index: 1,
                    prevCleared: false, message: "Existing Undo" });
                globalThis.existingUndo = pendingUndo;
                globalThis.existingPlan = roundPlan;
                saveBoard("opponent");
            `);
            h.answer(false);
            const before = h.run(`JSON.stringify({ board, usedTeams, focusedTeamKey, bannerData })`);
            const storage = h.storage();
            h.run(action);
            assert.equal(h.confirms.length, 1);
            assert.match(h.confirms[0], /Using SEE would weaken coverage for The Stranger through Sith Eternal Emperor/);
            assert.match(h.confirms[0], /Bane \(B tier\) remains/);
            assert.match(h.confirms[0], /not a guaranteed win/);
            assert.match(h.confirms[0], /OK: Use anyway\. Cancel: Keep available/);
            assert.equal(h.run(`JSON.stringify({ board, usedTeams, focusedTeamKey, bannerData })`), before);
            assert.deepEqual(h.storage(), storage);
            assert.equal(h.run(`pendingUndo === existingUndo && roundPlan === existingPlan`), true);
            h.run(`clearPendingUndo()`);
        });
    }
}

test("all three confirmed dynamic overrides apply once, and combined actions undo exactly", () => {
    for (const kind of ["mark", "clear", "lost"]) {
        const h = harness();
        setUpConservation(h);
        const action = kind === "mark" ? `markCounterUsedFromBoard("SEE", "FRONT_TOP:0")`
            : kind === "clear" ? `markUsedAndCleared("opponent", "FRONT_TOP", 0, "SEE")`
            : `markUsedAndLost("opponent", "FRONT_TOP", 0, "SEE")`;
        h.run(action);
        assert.equal(h.confirms.length, 1);
        assert.equal(h.run(`JSON.stringify(usedTeams)`), '["SEE"]');
        assert.equal(h.run(`board.teams[0].cleared`), kind === "clear");
        assert.equal(h.run(`board.teams[0].attempts`), kind === "lost" ? 1 : 0);
        if (kind !== "mark") {
            h.run(`undoPendingAction(); roundPlan = computeRoundPlan()`);
            assert.equal(h.run(`usedTeams.length`), 0);
            assert.equal(h.run(`board.teams[0].cleared`), false);
            assert.equal(h.run(`board.teams[0].attempts`), 0);
            assert.equal(h.run(`roundPlan.assign["FRONT_TOP:1"].counterId`), "SEE_BANE");
            assert.equal(h.confirms.length, 1, "Undo and re-solve never prompt");
        }
    }
});

test("click-time checks ignore a stale plan when the affected defence clears or gets an adequate alternative", () => {
    for (const change of [
        `board.teams[1].cleared = true`,
        `gacData[board.mode]["The Stranger"].push({ counterId: "WEAK", counter: "Now adequate", tier: "A", bannerScore: 70 })`
    ]) {
        const h = harness();
        setUpConservation(h);
        h.run(change);
        h.answer(false);
        h.run(`markCounterUsedFromBoard("SEE", "FRONT_TOP:0")`);
        assert.equal(h.confirms.length, 0);
        assert.equal(h.run(`usedTeams.includes("SEE")`), true);
    }
});

test("the selected composition's required characters drive one combined hidden/visible prompt", () => {
    const h = harness();
    setUpConservation(h, "5v5", true);
    h.answer(false);
    h.run(`markCounterUsedFromBoard("BANE", "FRONT_TOP:0")`);
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /The Stranger through Darth Bane/);
    assert.doesNotMatch(h.confirms[0], /through Sith Eternal Emperor/);
    assert.match(h.confirms[0], /Some enemy squads are still hidden/);
    assert.equal(h.run(`usedTeams.length`), 0);
});

test("own recommendation, spent compositions, Counter Lookup and My Board do not prompt dynamically", () => {
    const h = harness();
    setUpConservation(h);
    h.answer(false);
    h.run(`markUsedAndLost("opponent", "FRONT_TOP", 1, "SEE_BANE")`);
    assert.equal(h.confirms.length, 0, "the intended battle is expected expenditure");
    assert.equal(h.run(`board.teams[1].attempts`), 1);
    h.run(`markCounterUsedFromBoard("SEE", "FRONT_TOP:0")`);
    assert.equal(h.confirms.length, 0, "SEE is already spent through SEE+Bane");
    h.run(`clearPendingUndo()`);

    setUpConservation(h);
    h.run(`showCounters = () => {}; markUsed("SEE")`);
    assert.equal(h.confirms.length, 0);
    setUpConservation(h);
    h.run(`myBoard = createCompanionMyBoard(board); markUsedAndLost("my", "FRONT_TOP", 0, "SEE")`);
    assert.equal(h.confirms.length, 0);
    h.run(`clearPendingUndo()`);
});

test("a required-unit conflict with no replacement names the jeopardised defence", () => {
    const h = harness();
    setUpConservation(h);
    h.run(`gacData[board.mode]["The Stranger"] = gacData[board.mode]["The Stranger"].slice(0, 1)`);
    h.answer(false);
    h.run(`markCounterUsedFromBoard("SEE", "FRONT_TOP:0")`);
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0], /No one-shot counter remains assigned there/);
});

const recommendation = (h, index = 0) => h.run(`renderTeamRecommendation("opponent", "FRONT_TOP", board.teams[${index}], board.mode)`);

test("changed recommendations have one short reason and keep unflagged SEE selectable", () => {
    const h = harness();
    setUpConservation(h);
    const html = recommendation(h);
    assert.match(html, /Keeps SEE and Bane \(A tier\) for The Stranger, where the alternative allocation is weaker\./);
    assert.equal((html.match(/Keeps SEE and Bane/g) || []).length, 1);
    assert.doesNotMatch(html, /Strongest available option|hidden zones remain/);
    assert.match(html, /markCounterUsedFromBoard\('SEE', 'FRONT_TOP:0'\)/);
    assert.match(html, /Reliable Squad/);
    h.run(`board.teams[1].cleared = true; roundPlan = computeRoundPlan()`);
    assert.doesNotMatch(recommendation(h), /Keeps .* for/);
});

test("recommendation, trade-off and unavailable-reason names are HTML escaped", () => {
    const h = harness();
    setUpConservation(h);
    h.run(`
        gacData[board.mode]['<img src=x onerror=alert(1)>'] = gacData[board.mode]["The Stranger"];
        board.teams[1].name = '<img src=x onerror=alert(1)>';
        counterDefinitions.SEE_BANE.name = '<svg onload=alert(2)>';
        gacData[board.mode]["Easy Defence"][1].counter = '<b>unsafe & name</b>';
        roundPlan = computeRoundPlan();
    `);
    const html = recommendation(h);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;svg onload=alert\(2\)&gt;/);
    assert.match(html, /&lt;b&gt;unsafe &amp; name&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<img|<svg|<b>unsafe/);
    assert.doesNotMatch(h.run(`renderNextUp()`), /<img|<svg|<b>unsafe/);
    h.run(`usedTeams = ["SEE_BANE"]; roundPlan = computeRoundPlan()`);
    assert.doesNotMatch(recommendation(h, 1), /<svg/);
    assert.match(recommendation(h, 1), /&lt;svg/);
});

test("low-tier fallback and conflicting allocation are distinct from absent catalogue coverage", () => {
    const h = harness();
    setUpConservation(h);
    h.run(`usedTeams = ["SEE"]; roundPlan = computeRoundPlan()`);
    const risky = recommendation(h, 1);
    assert.match(risky, /B-tier option — risky; a win is not assured/);
    assert.match(risky, /Used \+ Cleared/);
    assert.match(h.run(`renderNextUp()`), /B-tier option — risky; a win is not assured/);
    h.run(`
        usedTeams = [];
        gacData[board.mode]["Easy Defence"] = gacData[board.mode]["The Stranger"].slice(0, 1);
        gacData[board.mode]["The Stranger"] = gacData[board.mode]["The Stranger"].slice(0, 1);
        roundPlan = computeRoundPlan();
    `);
    assert.match(recommendation(h) + recommendation(h, 1), /No credible allocation here without compromising another defence/);
    h.run(`delete gacData[board.mode]["The Stranger"]; roundPlan = computeRoundPlan()`);
    assert.match(recommendation(h, 1), /No counters in the catalogue/);
    assert.doesNotMatch(recommendation(h, 1), /No credible allocation|risky/);
});

test("render and a budget-limited diagnostic never invent a conservation claim", () => {
    const h = harness();
    setUpConservation(h);
    h.run(`roundPlan.visibleBoardConservation.changed = null; roundPlan.visibleBoardConservation.state = "limited"`);
    assert.doesNotMatch(recommendation(h), /Keeps .* for/);
    assert.equal(h.confirms.length, 0);
});
