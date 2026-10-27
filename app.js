// app.js
const APP_VERSION = "3.6";
const ROSTER_API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

// Static catalogue (ADR-ARCH-116 §8): a small same-origin pointer names an
// immutable, checksummed release file. Paths are relative to the app, so they
// resolve under the /gac-helper/ Pages path as well as at a site root.
const CATALOGUE_POINTER_URL = "catalogue/current.json";
const CATALOGUE_BASE_URL = "catalogue/";
const CATALOGUE_POINTER_SCHEMA = 1;
const CATALOGUE_RELEASE_CONTRACT = "gac-catalogue-release:v1";
const CATALOGUE_POINTER_TIMEOUT_MS = 10000;
const CATALOGUE_RELEASE_TIMEOUT_MS = 30000;
const CATALOGUE_PAYLOAD_KEYS = ["counters", "counterDefinitions", "characterDefinitions", "boardConfig", "scoring", "defenceTeams", "defenceCompositions"];
const CATALOGUE_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;

const CATALOGUE_CACHE_SCHEMA = 2;
const CATALOGUE_CACHE_KEY = "catalogueCache:v2";
// Pre-cutover Apps Script cache. Read once to migrate; never written, and only
// removed if the v2 write would otherwise exceed the storage quota, so a
// rollback to the Apps Script app still finds its offline catalogue.
const LEGACY_CATALOGUE_CACHE_SCHEMA = 1;
const LEGACY_CATALOGUE_CACHE_KEY = "catalogueCache:v1";
const LEGACY_CATALOGUE_SOURCE_CONTRACT = "apps-script-action-data:v1";

const ROSTER_SCHEMA = 2;
const ROSTER_KEY = "rosterData";             // versioned object
const LEGACY_ROSTER_KEY = "ownedCharacters"; // pre-v1.9 bare array

const ROSTER_SOURCE_API = "swgoh.gg";        // internal sentinel for API-imported rosters (do not surface)
const ROSTER_FETCH_TIMEOUT_MS = 60000;       // user-initiated import/refresh timeout (allows for Render cold start)
const ROSTER_SYNC_STALE_MS = 1000 * 60 * 60 * 12; // background sync only if older than this

// Board (v2.1 Round screen)
const BOARD_SCHEMA = 5;                       // v5: persisted defence-availability snapshot
const BOARD_KEY = "boardData";               // opponent board (legacy-compatible key)
const MY_BOARD_KEY = "myBoardData";           // player's defence for the current round
const DEFENCE_TEMPLATE_SCHEMA = 2;              // v2: player-selected, explicitly confirmed lineups
const DEFENCE_TEMPLATE_KEY_PREFIX = "defenceTemplate:";
const LEAGUE_KEY = "gacLeague";              // persisted user setting
const LAST_SQUAD_MODE_KEY = "gacLastSquadMode"; // remembers 5v5/3v3 while browsing Fleet
const LEAGUES = ["KYBER", "AURODIUM", "CHROMIUM", "BRONZIUM", "CARBONITE"];
const NOT_IN_CATALOGUE = "__NOT_IN_CATALOGUE__";
const TERRITORY_LABELS = {
    FRONT_TOP:    "Front Top",
    FRONT_BOTTOM: "Front Bottom",
    BACK_TOP:     "Back Top",
    BACK_BOTTOM:  "Back Bottom"
};

// Battle Order (v3.0). Threat is an AUTHORED attribute of a defence team, held on
// the Defence_Teams sheet tab: how hard that team is to beat, independent of how
// many counters happen to be documented for it. It exists because catalogue depth
// is a measure of the data, not of the enemy — a thinly-documented easy team would
// otherwise look scarcer than a Galactic Legend with two well-known answers.
// Everything defaults to NORMAL, so the feature behaves sensibly with no ratings
// authored at all and improves as rows are added.
const THREAT_RANK  = { EXTREME: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
const THREAT_LABEL = { EXTREME: "extreme", HIGH: "high", NORMAL: "normal", LOW: "low" };

// First-attack rule (v3.1). How many of your own units a counter must be expected
// to shed before the opening battle is flagged as risky. Expressed as a UNIT COUNT
// rather than a banner threshold so it stays correct in every format: the app
// derives the perfect-win score and the per-unit cost from GAC_Scoring, so 3 units
// resolves to "56 or below" in 5v5, "48 or below" in 3v3, and so on. Retuning the
// scoring rows retunes this automatically.
const OPENER_MESSY_UNITS = 3;

const USAGE_HISTORY_KEY = "gacUsageHistory:v1";
let usageHistoryWritable = true;
let usageHistoryMessage = "";
let usageHistory = loadUsageHistory();

let gacData = {};
let counterDefinitions = {};
let characterDefinitions = {};
let boardConfig = {};                   // league -> mode -> [{territory, type, teamCount}]
let scoringRules = [];                  // GAC banner economy rows (consumed in Item 2)
let defenceTeams = {};                  // mode -> defence team name -> { threat, notes } (v3.0)
let defenceCompositions = {};           // mode -> defence team name -> canonical unit IDs (v3.5)
let baseIdToUnit = {};                  // base_id -> { characterId, unitType }
let catalogueStatus = null;             // quiet cache/refresh status; never blocks a usable catalogue
let currentMode = "5v5";
let lastSquadMode = localStorage.getItem(LAST_SQUAD_MODE_KEY) || "5v5"; // last 5v5/3v3 chosen; used for board setup when the toggle is on Fleet
let boardModeDraft = null;              // GAC format chosen on the round setup card; owned by the round once set
let currentView = "round";
let usedTeams = JSON.parse(localStorage.getItem("usedTeams") || "[]");
let spentCharsCache = { key: null, map: new Map() };  // derived from usedTeams + counterDefinitions (v3.2)
let searchText = "";
let defenceLineupsMode = "5v5";        // independent of Counters and active Round
let defenceLineupEditor = null;         // one unsaved team draft; persistence uses template helpers
let defenceLineupsMessage = null;

// Roster state. ownedCharacters stays the in-memory array the rest of the
// app reads; rosterMeta carries provenance for the freshness line.
let ownedCharacters = [];
let rosterMeta = { savedAt: null, source: "manual", allyCode: null, syncedAt: null };

let rosterSearch = "";
let rosterPanelOpen = false;            // collapsible data panel state
let rosterBackup = null;                // session-only snapshot for Undo
let importDraft = "";                   // text in the paste-import box
let allyCodeDraft = "";                 // text in the ally-code input
let rosterSyncing = false;              // true while an API import/refresh is in flight
let rosterMessage = null;               // { text, kind: "ok" | "warn" | "error" }

// Board state. board is null until set up; league persists across rounds.
let board = null;
let myBoard = null;
let activeBoardSide = "opponent";      // Opponent Board is always the entry default
let leagueDraft = localStorage.getItem(LEAGUE_KEY) || "";
let roundPlan = null;                   // live allocation plan — recomputed every Round render, never persisted
let focusedTeamKey = null;              // board team the Next Up card last pointed at, e.g. "FRONT_BOTTOM:0"
let focusFlash = false;                 // one-shot: true only for the render immediately after a Next Up tap
let expandedCounterCards = new Set();   // keys of recommendation cards showing their suggested squad; UI-only, never persisted

// Temporary Undo for Cleared and Used + Cleared (v3.4). One in-memory slot, not
// persisted: a page reload naturally drops the offer while the underlying
// cleared/used state it may restore continues to persist normally. A later
// action of either kind replaces whatever offer is pending rather than
// stacking a history, matching the "no general undo stack" decision.
const PENDING_UNDO_WINDOW_MS = 6000;    // ~6s: midpoint of the requested 5-8s temporary-undo window
let pendingUndo = null;                 // { kind, side, territoryKey, index, counterId, prevCleared, wasUsed, usageChange, message, timeoutId }

// bannerData.remaining is now a MANUAL OVERRIDE, not a stored figure: null means
// "no override — show the value calculated from the board" (the v2.6 default).
// A number means the user has typed their own value, which persists only until
// they dismiss it or touch the board. Older stored data kept a plain number here;
// it is migrated to null on load so upgrading users start on the calculated
// figure rather than being pinned to a stale hand-typed number.
//
// bannerData.oppFinal (v2.7) marks whether oppScore is the opponent's FINAL score
// (true) or just their current score, still a floor that may rise (false, the
// default). It changes only what the "can I still win?" verdict may assert: a
// clean yes/no needs a final; against a mere current score the verdict can prove
// the round lost, but can only state a breakeven for the winnable case.
let bannerData = (function () {
    let d;
    try { d = JSON.parse(localStorage.getItem("bannerData") || "{}"); }
    catch (e) { d = {}; }
    return {
        myScore:  Number(d.myScore)  || 0,
        oppScore: Number(d.oppScore) || 0,
        remaining: (typeof d.remaining === "number") ? null : (d.remaining ?? null),
        oppFinal: d.oppFinal === true,
        scoresPrefilled: d.scoresPrefilled === true
    };
})();
let counterFilter = localStorage.getItem("counterFilter") || "all";

// ─── ROSTER PERSISTENCE ────────────────────────────────────────────────────────
// Single load/save path. localStorage is the working store; the API is a refresh
// mechanism, not a dependency. The app is fully functional on cached data alone.

function loadRoster() {
    // Preferred: versioned object (schema 1 or 2 both read here; missing fields default).
    const raw = localStorage.getItem(ROSTER_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.owned)) {
                ownedCharacters = parsed.owned.slice();
                rosterMeta = {
                    savedAt:  parsed.savedAt  || null,
                    source:   parsed.source   || "manual",
                    allyCode: parsed.allyCode || null,   // new in schema 2
                    syncedAt: parsed.syncedAt || null    // new in schema 2
                };
                return;
            }
        } catch (e) {
            console.error("Roster parse failed, attempting legacy migration", e);
        }
    }

    // One-time migration: pre-v1.9 bare array under ownedCharacters.
    const legacy = localStorage.getItem(LEGACY_ROSTER_KEY);
    if (legacy) {
        try {
            const arr = JSON.parse(legacy);
            if (Array.isArray(arr)) {
                ownedCharacters = arr.slice();
                rosterMeta = { savedAt: null, source: "manual", allyCode: null, syncedAt: null };
                saveRoster("manual");                 // re-write in current schema
                localStorage.removeItem(LEGACY_ROSTER_KEY);
                return;
            }
        } catch (e) {
            console.error("Legacy roster parse failed", e);
        }
    }

    // Nothing stored.
    ownedCharacters = [];
    rosterMeta = { savedAt: null, source: "manual", allyCode: null, syncedAt: null };
}

function saveRoster(source) {
    if (source) rosterMeta.source = source;
    rosterMeta.savedAt = new Date().toISOString();

    const payload = {
        schema:   ROSTER_SCHEMA,
        savedAt:  rosterMeta.savedAt,
        source:   rosterMeta.source,
        allyCode: rosterMeta.allyCode || null,
        syncedAt: rosterMeta.syncedAt || null,
        owned:    ownedCharacters
    };
    localStorage.setItem(ROSTER_KEY, JSON.stringify(payload));
}

// Shared replace path. The API import calls this with the API source tag and an
// extra { allyCode, syncedAt }. Caller is responsible for validation.
function applyRoster(owned, source, extra) {
    ownedCharacters = owned.slice();
    if (extra) {
        if (extra.allyCode !== undefined) rosterMeta.allyCode = extra.allyCode;
        if (extra.syncedAt !== undefined) rosterMeta.syncedAt = extra.syncedAt;
    }
    saveRoster(source);
}

function formatSavedAt(iso) {
    if (!iso) return "Not saved yet";
    const d = new Date(iso);
    if (isNaN(d)) return "Not saved yet";
    const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `${date}, ${time}`;
}

// ─── BOARD PERSISTENCE (v2.1) ─────────────────────────────────────────────────
// One versioned object, same pattern as the roster. The league/mode territory
// layout is snapshotted into the board at setup, so an in-progress round renders
// identically even if the config data changes later. Territory-cleared state is
// always derived from per-team flags, never stored.

function readStoredBoard(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && [2, 3, 4, 5].includes(parsed.schema) &&
            Array.isArray(parsed.teams) && Array.isArray(parsed.territories)) {
            return parsed;
        }
    } catch (e) {
        console.error(`Board parse failed for ${key}`, e);
    }
    return null;
}

// Schema-2/3 opponent boards remain the source of truth for an in-progress round.
// Migration is additive: attempts and custom names are backfilled, a stable round
// id is derived from the existing creation timestamp, and the live banner scores
// are deliberately left untouched. A missing companion My Board is created from
// the legacy board's frozen layout, without running new-round score prefilling.
function normaliseBoard(bd, side) {
    if (!bd) return false;
    let changed = false;
    bd.teams.forEach(t => {
        if (typeof t.attempts !== "number") { t.attempts = 0; changed = true; }
        if (typeof t.customName !== "string") { t.customName = ""; changed = true; }
    });
    if (!bd.roundId) { bd.roundId = bd.createdAt || `legacy-${bd.league}-${bd.mode}`; changed = true; }
    if (bd.side !== side) { bd.side = side; changed = true; }
    if (bd.schema !== BOARD_SCHEMA) { bd.schema = BOARD_SCHEMA; changed = true; }
    return changed;
}

function validDefenceSnapshot(snapshot, mode) {
    return snapshot && [1, 2].includes(snapshot.schema) && snapshot.mode === mode &&
        Array.isArray(snapshot.characterIds) && Array.isArray(snapshot.unresolvedTeams) &&
        (snapshot.schema === 1 || (Array.isArray(snapshot.slots) && Array.isArray(snapshot.legacyCharacterIds)));
}

function loadBoard() {
    board = readStoredBoard(BOARD_KEY);
    if (!board) {
        myBoard = null;
        activeBoardSide = "opponent";
        return;
    }

    if (normaliseBoard(board, "opponent")) saveBoard("opponent");

    myBoard = readStoredBoard(MY_BOARD_KEY);
    const paired = myBoard && myBoard.roundId === board.roundId &&
        myBoard.league === board.league && myBoard.mode === board.mode;
    if (!paired) {
        myBoard = createCompanionMyBoard(board);
        saveBoard("my");
    } else if (normaliseBoard(myBoard, "my")) {
        saveBoard("my");
    }
    if (upgradeLegacyDefenceSnapshot()) saveBoard("opponent");
}

function saveBoard(side) {
    if (side === "my") {
        if (myBoard) localStorage.setItem(MY_BOARD_KEY, JSON.stringify(myBoard));
        return;
    }
    if (board) localStorage.setItem(BOARD_KEY, JSON.stringify(board));
}

function discardBoard() {
    board = null;
    myBoard = null;
    activeBoardSide = "opponent";
    boardModeDraft = null;
    focusedTeamKey = null;
    expandedCounterCards = new Set();
    clearPendingUndo();
    localStorage.removeItem(BOARD_KEY);
    localStorage.removeItem(MY_BOARD_KEY);
}

function templateKey(mode) {
    return DEFENCE_TEMPLATE_KEY_PREFIX + mode;
}

// Migration is additive and independent of catalogue loading. In particular, a
// bad lineup must not hide otherwise usable saved identities or league layout.
function loadDefenceTemplate(mode) {
    if (!["5v5", "3v3"].includes(mode)) return null;
    try {
        const parsed = JSON.parse(localStorage.getItem(templateKey(mode)) || "null");
        if (!parsed || ![1, DEFENCE_TEMPLATE_SCHEMA].includes(parsed.schema) ||
            parsed.mode !== mode || !Array.isArray(parsed.teams)) return null;
        if (parsed.schema === 1) {
            parsed.schema = DEFENCE_TEMPLATE_SCHEMA;
            // Schema 1 had no player confirmation contract. Never promote any
            // unexpected legacy lineup field to confirmed data.
            parsed.teams = parsed.teams.map(team => team && team.lineup
                ? { ...team, lineup: { ...team.lineup, confirmed: false } } : team);
            persistDefenceTemplate(parsed);
        }
        return parsed;
    } catch (e) {
        console.error(`Defence template parse failed for ${mode}`, e);
    }
    return null;
}

function persistDefenceTemplate(template) {
    try {
        localStorage.setItem(templateKey(template.mode), JSON.stringify(template));
        return true;
    } catch (e) {
        console.error(`Defence template save failed for ${template.mode}`, e);
        return false;
    }
}

function defenceTemplateTeamAt(template, territory, index) {
    const matches = template.teams.filter(t => t && t.territory === territory && t.index === index);
    return matches.length === 1 ? matches[0] : null;
}

function sameDefenceIdentity(a, b) {
    return !!a && !!b && (a.name || "") === (b.name || "") &&
        (a.customName || "") === (b.customName || "");
}

function defenceTemplateTeamType(template, team) {
    const territory = Array.isArray(template.territories) &&
        template.territories.find(t => t && t.territory === team.territory);
    // Legacy identity-only templates may lack layout metadata. Back Top is the
    // Fleet territory in every supported league; never use the browsing toggle.
    return territory ? territory.type : team.territory === "BACK_TOP" ? "FLEET" : "SQUAD";
}

// Partial drafts are valid but incomplete. Only a deliberately selected
// intentionalUndersize state allows a non-empty short squad to be confirmed.
function validateDefenceLineup(lineup, mode, type) {
    const errors = [];
    const characterIds = [];
    if (!isPlainObject(lineup)) return { valid: false, complete: false, characterIds, errors: ["invalid-lineup"] };
    if (!["5v5", "3v3"].includes(mode)) errors.push("invalid-mode");
    if (!["SQUAD", "FLEET"].includes(type)) errors.push("invalid-territory-type");
    const members = (value, unitType, field) => {
        if (!Array.isArray(value)) { errors.push(`invalid-${field}`); return []; }
        value.forEach(id => {
            if (typeof id !== "string" || !Object.hasOwn(characterDefinitions, id) ||
                !characterDefinitions[id] || characterDefinitions[id].unitType !== unitType) errors.push(`invalid-unit:${field}:${id}`);
            else characterIds.push(id);
        });
        return value;
    };
    let complete = false;
    if (type === "FLEET") {
        const capital = lineup.capitalShipId === undefined ? "" : lineup.capitalShipId;
        if (typeof capital !== "string") errors.push("invalid-capitalShipId");
        else if (capital) members([capital], "CAPITAL_SHIP", "capitalShipId");
        const starters = members(lineup.startingShipIds === undefined ? [] : lineup.startingShipIds, "SHIP", "startingShipIds");
        const reinforcements = members(lineup.reinforcementIds === undefined ? [] : lineup.reinforcementIds, "SHIP", "reinforcementIds");
        if (starters.length > 3 || reinforcements.length > 4) errors.push("invalid-size");
        if (lineup.characterIds !== undefined || lineup.intentionalUndersize !== undefined) errors.push("invalid-fleet-fields");
        // Reinforcement capacity is a maximum, never a required count. Capital
        // stars are not known here, so no locked-slot requirement is inferred.
        complete = !!capital && starters.length === 3;
    } else if (type === "SQUAD") {
        const ids = members(lineup.characterIds === undefined ? [] : lineup.characterIds, "CHARACTER", "characterIds");
        const size = mode === "3v3" ? 3 : 5;
        if (ids.length > size) errors.push("invalid-size");
        if (lineup.intentionalUndersize !== undefined && typeof lineup.intentionalUndersize !== "boolean") errors.push("invalid-undersize-state");
        if (lineup.capitalShipId !== undefined || lineup.startingShipIds !== undefined || lineup.reinforcementIds !== undefined) errors.push("invalid-squad-fields");
        complete = ids.length === size || (ids.length > 0 && ids.length < size && lineup.intentionalUndersize === true);
    }
    if (new Set(characterIds).size !== characterIds.length) errors.push("duplicate-unit");
    return { valid: errors.length === 0, complete: errors.length === 0 && complete, characterIds, errors };
}

// Saved assignments (including progressive drafts) share one unit pool across
// every territory. Catalogue proposals do not claim any of that pool.
function validateDefenceTemplate(template) {
    const teams = [];
    const holders = new Map();
    const slots = new Map();
    template.teams.forEach(team => {
        if (!team) return;
        const result = team.lineup === undefined
            ? { valid: true, complete: false, characterIds: [], errors: [] }
            : validateDefenceLineup(team.lineup, template.mode, defenceTemplateTeamType(template, team));
        const row = { territory: team.territory, index: team.index, ...result };
        if (!team.name && team.lineup !== undefined) row.errors.push("missing-identity");
        const slot = `${team.territory}:${team.index}`;
        if (slots.has(slot)) {
            row.errors.push("duplicate-slot");
            slots.get(slot).errors.push("duplicate-slot");
        }
        slots.set(slot, row);
        new Set(row.characterIds).forEach(id => {
            if (holders.has(id)) {
                row.errors.push(`duplicate-assignment:${id}`);
                holders.get(id).errors.push(`duplicate-assignment:${id}`);
            } else holders.set(id, row);
        });
        teams.push(row);
    });
    teams.forEach(row => {
        row.valid = row.errors.length === 0;
        row.complete = row.valid && row.complete;
    });
    return { valid: teams.every(t => t.valid), complete: teams.length > 0 && teams.every(t => t.complete), teams };
}

function suggestDefenceLineup(teamName, mode, type) {
    if (!teamName || teamName === NOT_IN_CATALOGUE) return null;
    const catalogueMode = type === "FLEET" ? "FLEET" : mode;
    const specific = defenceCompositions[catalogueMode];
    const any = defenceCompositions.ANY;
    let ids = specific && Object.hasOwn(specific, teamName) ? specific[teamName] :
        any && Object.hasOwn(any, teamName) ? any[teamName] : undefined;
    let source = "defence-composition";
    // An explicitly authored partial/invalid row must not be silently replaced
    // by a different core. Fallback names must match exactly and uniquely.
    if (ids === undefined) {
        const matches = Object.values(counterDefinitions).filter(def => def && def.name === teamName);
        if (matches.length !== 1 || !Array.isArray(matches[0].required) || !matches[0].required.length) return null;
        ids = matches[0].required;
        source = "required-core";
    }
    if (!Array.isArray(ids)) return null;
    const lineup = type === "FLEET" ? {
        capitalShipId: "",
        startingShipIds: [],
        reinforcementIds: [],
        confirmed: false
    } : { characterIds: [...ids], intentionalUndersize: false, confirmed: false };
    if (type === "FLEET") {
        // Flat catalogue membership carries no starter/reinforcement roles.
        // Expose the membership as a proposal; never invent those roles.
        const errors = [];
        const types = ids.map(id => Object.hasOwn(characterDefinitions, id) && characterDefinitions[id] && characterDefinitions[id].unitType);
        if (types.some(type => !["SHIP", "CAPITAL_SHIP"].includes(type))) errors.push("invalid-fleet-unit");
        if (new Set(ids).size !== ids.length) errors.push("duplicate-unit");
        if (types.filter(type => type === "CAPITAL_SHIP").length > 1 || types.filter(type => type === "SHIP").length > 7) errors.push("invalid-size");
        return { source, lineup, suggestedCharacterIds: [...ids], confirmed: false, complete: false,
            validation: { valid: errors.length === 0, complete: false, characterIds: [...ids], errors } };
    }
    const validation = validateDefenceLineup(lineup, mode, type);
    return { source, lineup, confirmed: false, complete: validation.complete, validation };
}

function readDefenceTemplateLineup(mode, territory, index) {
    const template = loadDefenceTemplate(mode);
    const team = template && defenceTemplateTeamAt(template, territory, index);
    if (!team) return null;
    if (team.lineup !== undefined) {
        const validation = validateDefenceTemplate(template).teams.find(t => t.territory === territory && t.index === index);
        return { source: "saved", lineup: team.lineup, validation,
            complete: validation.complete, confirmed: !!team.lineup && team.lineup.confirmed === true && validation.complete };
    }
    return suggestDefenceLineup(team.name, mode, defenceTemplateTeamType(template, team));
}

// The expected identity prevents a stale editor from attaching members to a
// newly selected team. Confirmation requires this explicit write option; a
// catalogue proposal or an incoming lineup.confirmed flag cannot confirm itself.
function writeDefenceTemplateLineup(mode, territory, index, identity, lineup, options = {}) {
    const template = loadDefenceTemplate(mode);
    const team = template && defenceTemplateTeamAt(template, territory, index);
    if (!team || !team.name || !sameDefenceIdentity(team, identity)) return { ok: false, errors: ["identity-mismatch"] };
    if (lineup === null) delete team.lineup;
    else {
        const validation = validateDefenceLineup(lineup, mode, defenceTemplateTeamType(template, team));
        if (!validation.valid || (options.confirm === true && !validation.complete)) {
            return { ok: false, errors: validation.errors.concat(options.confirm === true && !validation.complete ? ["incomplete-lineup"] : []) };
        }
        team.lineup = { ...lineup, confirmed: options.confirm === true };
    }
    const validation = validateDefenceTemplate(template);
    const current = validation.teams.find(t => t.territory === territory && t.index === index);
    // Other legacy/corrupt slots must not prevent progressive completion here.
    if (!current.valid) return { ok: false, errors: current.errors };
    template.updatedAt = new Date().toISOString();
    return { ok: persistDefenceTemplate(template), validation };
}

function applyDefenceTemplate(bd) {
    const template = loadDefenceTemplate(bd.mode);
    if (!template) return bd;
    bd.teams.forEach(team => {
        const saved = defenceTemplateTeamAt(template, team.territory, team.index);
        if (!saved) return;
        team.name = typeof saved.name === "string" ? saved.name : "";
        team.customName = typeof saved.customName === "string" ? saved.customName : "";
    });
    return bd;
}

// Resolve a saved defensive team to canonical Character_IDs without parsing its
// display name. Explicit Defence_Composition data wins. Existing catalogues get
// a backwards-compatible path when the defence identity exactly and uniquely
// matches a Counter_Definitions team name; the stable Counter_ID then supplies
// its REQUIRED composition. Ambiguous/custom identities stay unresolved.
function resolveDefenceTeamCharacters(teamName, mode) {
    if (!teamName || teamName === NOT_IN_CATALOGUE) return null;

    const explicit = (defenceCompositions[mode] && defenceCompositions[mode][teamName]) ||
        (defenceCompositions.ANY && defenceCompositions.ANY[teamName]);
    if (Array.isArray(explicit) && explicit.length) {
        return { characterIds: [...new Set(explicit)], complete: true };
    }

    const matches = Object.entries(counterDefinitions)
        .filter(([, def]) => def && def.name === teamName && Array.isArray(def.required) && def.required.length);
    if (matches.length !== 1) return null;
    // Counter_Composition models a strategic attacking core, not necessarily
    // every unit fielded on defence. It is useful as a safe lower bound, but the
    // snapshot stays unresolved until the player confirms a saved lineup.
    return { characterIds: [...new Set(matches[0][1].required)], complete: false };
}

function defenceSnapshotSlots(source) {
    return (source && Array.isArray(source.teams) ? source.teams : []).filter(Boolean).map(team => ({
        territory: team.territory, index: team.index, name: team.name || "", customName: team.customName || "",
        type: defenceTemplateTeamType(source, team), characterIds: [], confirmed: false, reviewed: false
    }));
}

// Keep the existing aggregate availability contract. A removed member remains
// blocked whenever another slot (or the unattributed legacy set) still holds it.
function aggregateDefenceSnapshot(snapshot) {
    snapshot.characterIds = [...new Set([...snapshot.legacyCharacterIds, ...snapshot.slots.flatMap(slot => slot.characterIds)])];
    snapshot.unresolvedTeams = snapshot.slots.filter(slot => slot.name && !slot.confirmed).map(slot => slot.customName || slot.name);
    snapshot.sourceTeamCount = snapshot.slots.filter(slot => slot.name).length;
    return snapshot;
}

function hasLegacyDefenceReview(snapshot) {
    return snapshot && snapshot.schema === 2 && (snapshot.legacyReviewRequired === true || snapshot.legacyCharacterIds.length > 0);
}

function captureDefenceSnapshot(mode, source, savedTemplate = source) {
    const slots = defenceSnapshotSlots(source);
    slots.forEach(slot => {
        if (!slot.name) return;
        const saved = savedTemplate && defenceTemplateTeamAt(savedTemplate, slot.territory, slot.index);
        const selection = sameDefenceIdentity(slot, saved) && defenceTemplateTeamType(savedTemplate, saved) === slot.type &&
            readDefenceTemplateLineup(mode, slot.territory, slot.index);
        if (selection && selection.source === "saved") {
            slot.characterIds = [...new Set(selection.validation.characterIds)];
            slot.confirmed = selection.confirmed;
            slot.lineup = JSON.parse(JSON.stringify(selection.lineup));
            slot.source = "saved";
        } else {
            const resolved = resolveDefenceTeamCharacters(slot.name, slot.type === "FLEET" ? "FLEET" : mode);
            // Catalogue membership is a conservative lower bound, never player
            // confirmation, even if the authored row happens to be complete.
            slot.characterIds = resolved ? resolved.characterIds.filter(id => {
                const unit = characterDefinitions[id];
                return !unit || (slot.type === "FLEET" ? ["SHIP", "CAPITAL_SHIP"].includes(unit.unitType) : unit.unitType === "CHARACTER");
            }) : [];
            slot.source = "catalogue";
        }
    });
    return aggregateDefenceSnapshot({ schema: 2, mode, capturedAt: new Date().toISOString(), slots,
        legacyCharacterIds: [], missingSavedDefence: !slots.some(slot => slot.name) });
}

// Aggregate-only snapshots cannot prove which slot held any old ID. Preserve
// EVERY blocker, without catalogue resolution or trusting future template edits.
function upgradeLegacyDefenceSnapshot() {
    const previous = board && board.defenceSnapshot;
    if (!validDefenceSnapshot(previous, board && board.mode) || previous.schema !== 1 || !myBoard) return false;
    board.defenceSnapshot = aggregateDefenceSnapshot({ ...previous, schema: 2,
        slots: defenceSnapshotSlots(myBoard), legacyCharacterIds: [...previous.characterIds],
        legacySourceTeamCount: previous.sourceTeamCount, legacyUnresolvedTeams: [...previous.unresolvedTeams],
        legacyReviewRequired: previous.characterIds.length > 0 || previous.unresolvedTeams.length > 0 || previous.sourceTeamCount > 0 });
    return true;
}

// Schema-4 rounds predate defence snapshots. On first load after the catalogue is
// available, freeze the paired My Board as a best-effort migration and never
// derive it again. New rounds always snapshot the saved template in createBoard.
function ensureDefenceSnapshotForActiveRound() {
    if (upgradeLegacyDefenceSnapshot()) saveBoard("opponent");
    if (!board || validDefenceSnapshot(board.defenceSnapshot, board.mode)) return;
    if (!myBoard || (!Object.keys(counterDefinitions).length && !Object.keys(defenceCompositions).length)) return;
    board.defenceSnapshot = captureDefenceSnapshot(board.mode, myBoard, loadDefenceTemplate(board.mode));
    board.schema = BOARD_SCHEMA;
    myBoard.schema = BOARD_SCHEMA;
    saveBoard("opponent");
    saveBoard("my");
}

// A round started with no saved defence has nothing to filter. The player may
// still commit their filled-in My Board once, by confirmed action; after that
// later changes require the per-slot correction flow like any other snapshot.
function adoptMyBoardAsRoundDefence() {
    if (!board || !myBoard || !validDefenceSnapshot(board.defenceSnapshot, board.mode)) return;
    if (!board.defenceSnapshot.missingSavedDefence) return;
    if (!myBoard.teams.some(t => t && t.name)) return;
    if (!confirm(`Use your current My Board as this round's ${board.mode} defence? Those units will be marked unavailable for attack, and later My Board edits won't change it.`)) return;
    const captured = captureDefenceSnapshot(board.mode, myBoard, loadDefenceTemplate(board.mode));
    captured.legacyCharacterIds = [...board.defenceSnapshot.characterIds];
    board.defenceSnapshot = aggregateDefenceSnapshot(captured);
    saveBoard("opponent");
    syncConfirmedDefenceUsage();
    render();
}

// Explicitly fill empty frozen identities, preserving live names and progress.
// A name entered by the old My Board UI requires an exact saved-identity match.
function savedDefenceAdoptionCandidate() {
    if (!board || !myBoard || !validDefenceSnapshot(board.defenceSnapshot, board.mode) || board.defenceSnapshot.schema !== 2) return null;
    const snapshot = board.defenceSnapshot;
    const saved = loadDefenceTemplate(board.mode);
    if (!saved) return null;
    const candidate = JSON.parse(JSON.stringify(myBoard));
    let added = false;
    candidate.teams.forEach(team => {
        const assignment = defenceTemplateTeamAt(saved, team.territory, team.index);
        const frozen = defenceTemplateTeamAt({ teams: snapshot.slots }, team.territory, team.index);
        const canFill = frozen && !frozen.name && (snapshot.missingSavedDefence || team.name || team.cleared || team.attempts > 0);
        if (canFill && assignment && assignment.name && (!team.name || sameDefenceIdentity(team, assignment)) &&
                defenceTemplateTeamType(saved, assignment) === defenceTemplateTeamType(myBoard, team)) {
            team.name = assignment.name;
            team.customName = assignment.customName || "";
            added = true;
        }
    });
    return added ? candidate : null;
}

function adoptSavedTemplateAsRoundDefence() {
    const candidate = savedDefenceAdoptionCandidate();
    if (!candidate) return;
    const saved = loadDefenceTemplate(board.mode);
    const captured = captureDefenceSnapshot(board.mode, candidate, saved);
    const previous = board.defenceSnapshot;
    const conflict = captured.slots.some(slot => {
        const frozen = defenceTemplateTeamAt({ teams: previous.slots }, slot.territory, slot.index);
        return frozen && !frozen.name && slot.name && slot.confirmed && previous.slots.some(other =>
            (other.territory !== slot.territory || other.index !== slot.index) && other.characterIds.some(id => slot.characterIds.includes(id)));
    });
    if (conflict) {
        const text = "A saved lineup uses a unit already blocked by another current-round defence slot. Correct that slot before filling this identity.";
        defenceLineupsMessage = { kind: "error", text };
        if (currentView === "round") alert(text);
        render();
        return;
    }
    if (!confirm(`Fill empty My Board identities from the saved ${board.mode} defence, including slots with recorded Battles or Cleared? Existing named identities, frozen lineups and all battle progress stay. Newly filled slots will block their known units from attack; later template edits will not update this round.`)) return;
    const next = { ...previous, missingSavedDefence: false, slots: previous.slots.map(slot => {
        const live = defenceTemplateTeamAt(myBoard, slot.territory, slot.index);
        const filled = defenceTemplateTeamAt({ teams: captured.slots }, slot.territory, slot.index);
        const assignment = defenceTemplateTeamAt(saved, slot.territory, slot.index);
        return !slot.name && live && filled && filled.name && sameDefenceIdentity(filled, assignment) &&
            defenceTemplateTeamType(saved, assignment) === slot.type && (!live.name || sameDefenceIdentity(live, filled)) ? filled : slot;
    }) };
    // Only identity fields in eligible empty slots change. Preserve live objects
    // and all other fields, including progress not copied into the snapshot.
    candidate.teams.forEach(team => {
        const live = defenceTemplateTeamAt(myBoard, team.territory, team.index);
        if (live && !live.name && team.name) { live.name = team.name; live.customName = team.customName; }
    });
    board.defenceSnapshot = aggregateDefenceSnapshot(next);
    saveBoard("my");
    saveBoard("opponent");
    syncConfirmedDefenceUsage();
    render();
}

function roundDefenceCorrection(mode, territory, index) {
    const snapshot = board && board.defenceSnapshot;
    if (!validDefenceSnapshot(snapshot, board && board.mode) || snapshot.schema !== 2 || mode !== board.mode || snapshot.missingSavedDefence) return { error: "No matching active-round defence slot." };
    const slot = defenceTemplateTeamAt({ teams: snapshot.slots }, territory, index);
    const saved = loadDefenceTemplate(mode);
    const team = saved && defenceTemplateTeamAt(saved, territory, index);
    if (!slot || !slot.name) return { error: "No deployed identity was frozen in this slot." };
    if (!sameDefenceIdentity(slot, team) || defenceTemplateTeamType(saved, team) !== slot.type) return { error: "The saved identity differs from this round's frozen team. Restore that identity in this saved slot before applying its lineup." };
    const selection = readDefenceTemplateLineup(mode, territory, index);
    if (!selection || selection.source !== "saved" || !selection.confirmed) return { error: "Confirm a valid saved lineup before applying it to this round." };
    const ids = selection.validation.characterIds;
    const conflicts = snapshot.slots.filter(other => other !== slot && other.characterIds.some(id => ids.includes(id)));
    if (conflicts.length) return { error: "A selected unit is already blocked by another current-round defence slot. Correct that slot first." };
    const next = aggregateDefenceSnapshot({ ...snapshot, slots: snapshot.slots.map(other => other === slot
        ? { ...slot, characterIds: [...ids], confirmed: true, reviewed: true, source: "saved", lineup: JSON.parse(JSON.stringify(selection.lineup)) } : other) });
    return { slot, next, added: next.characterIds.filter(id => !snapshot.characterIds.includes(id)),
        released: snapshot.characterIds.filter(id => !next.characterIds.includes(id)),
        changed: !slot.confirmed || JSON.stringify(slot.lineup) !== JSON.stringify(selection.lineup) || (hasLegacyDefenceReview(snapshot) && !slot.reviewed) };
}

function defenceAvailabilityChange(correction) {
    const names = ids => ids.map(getCharacterName).join(", ");
    return `Attack availability will change. Newly blocked: ${names(correction.added) || "none"}. Released from defence: ${names(correction.released) || "none"}.${hasLegacyDefenceReview(board.defenceSnapshot) ? " Legacy uncertainty and unattributed blocks stay until every slot is reviewed and you confirm a full rebaseline." : ""}`;
}

function applySavedLineupToRound(mode, territory, index) {
    const correction = roundDefenceCorrection(mode, territory, index);
    if (correction.error) {
        defenceLineupsMessage = { kind: "error", text: correction.error };
        render();
        return false;
    }
    if (!correction.changed || !confirm(`Apply the saved corrected lineup to ${TERRITORY_LABELS[territory] || territory} ${index + 1}: ${correction.slot.customName || correction.slot.name}?\n\n${defenceAvailabilityChange(correction)}\n\nOnly this slot's membership changes. Recorded battles and scores stay.`)) return false;
    board.defenceSnapshot = correction.next;
    saveBoard("opponent");
    syncConfirmedDefenceUsage();
    defenceLineupsMessage = { kind: "ok", text: "Saved lineup applied to this round. Attack availability updated." };
    render();
    return true;
}

function reviewEmptyRoundDefenceSlot(territory, index) {
    const snapshot = board && board.defenceSnapshot;
    if (!hasLegacyDefenceReview(snapshot)) return;
    const slot = defenceTemplateTeamAt({ teams: snapshot.slots }, territory, index);
    const live = myBoard && defenceTemplateTeamAt(myBoard, territory, index);
    if (!slot || slot.name || !live || live.name || live.cleared || live.attempts > 0) return;
    if (!confirm(`Review ${TERRITORY_LABELS[territory] || territory} ${index + 1} as empty for this round? Confirm there was no deployed defence here. Legacy units stay blocked until you separately confirm the full rebaseline.`)) return;
    slot.reviewed = true;
    saveBoard("opponent");
    render();
}

function canRebaselineRoundDefence(snapshot) {
    return hasLegacyDefenceReview(snapshot) && snapshot.slots.length > 0 &&
        snapshot.slots.every(roundDefenceSlotReviewed);
}

function roundDefenceSlotReviewed(slot) {
    if (!slot.reviewed) return false;
    if (slot.name) return slot.confirmed;
    const live = myBoard && defenceTemplateTeamAt(myBoard, slot.territory, slot.index);
    return !!live && !live.name && !live.cleared && !(live.attempts > 0);
}

function rebaselineRoundDefence() {
    const snapshot = board && board.defenceSnapshot;
    if (!canRebaselineRoundDefence(snapshot)) return false;
    const next = aggregateDefenceSnapshot({ ...snapshot, legacyCharacterIds: [], legacyReviewRequired: false });
    const released = snapshot.characterIds.filter(id => !next.characterIds.includes(id));
    if (!confirm(`Replace ALL unattributed legacy defence blocks with the reviewed current-round assignments?\n\nYou reviewed every slot, including empty slots. Attack availability will change. Released from defence: ${released.map(getCharacterName).join(", ") || "none"}.\n\nConfirm this full defence rebaseline. Battles, used attackers and scores stay.`)) return false;
    board.defenceSnapshot = next;
    saveBoard("opponent");
    syncConfirmedDefenceUsage();
    render();
    return true;
}

function saveDefenceTemplateFromMyBoard() {
    if (!myBoard) return;
    const previous = loadDefenceTemplate(myBoard.mode);
    const template = {
        schema: DEFENCE_TEMPLATE_SCHEMA,
        mode: myBoard.mode,
        league: myBoard.league,
        updatedAt: new Date().toISOString(),
        territories: myBoard.territories.map(t => ({ ...t })),
        // Progress flags never enter templates. Preserve saved members only at
        // the same slot with the same identity; never copy by team name alone.
        teams: myBoard.teams.map(t => {
            const row = { territory: t.territory, index: t.index, name: t.name || "", customName: t.customName || "" };
            const saved = previous && defenceTemplateTeamAt(previous, t.territory, t.index);
            if (row.name && sameDefenceIdentity(row, saved) && saved.lineup !== undefined) row.lineup = saved.lineup;
            return row;
        })
    };
    persistDefenceTemplate(template);
}

function clearDefenceTemplate(mode) {
    const label = mode || (board && board.mode) || boardMode();
    if (!confirm(`Clear your saved ${label} defence template? Your current round board will not change.`)) return;
    localStorage.removeItem(templateKey(label));
    render();
}

function leagueLabel(league) {
    if (!league) return "";
    return league.charAt(0) + league.slice(1).toLowerCase();
}

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setLeague(value) {
    leagueDraft = value;
    if (value) localStorage.setItem(LEAGUE_KEY, value);
    render();
}

// The opponent board is always a squad-format board (5v5 or 3v3) plus the fleet
// territory. A round owns its own GAC format, chosen explicitly on the setup
// card (seeded from the Counters toggle on entry — see setView) rather than
// tracking the Counters toggle live. "Fleet" is a browsing view on the
// Counters screen, never a whole-board format, so it never supplies the
// fallback itself.
function boardMode() {
    if (boardModeDraft) return boardModeDraft;
    return currentMode !== "FLEET" ? currentMode : lastSquadMode;
}

function setBoardModeDraft(mode) {
    boardModeDraft = mode;
    render();
}

function createRoundBoard(league, mode, cfg, side, roundId, createdAt) {
    const teams = [];
    cfg.forEach(t => {
        for (let i = 0; i < t.teamCount; i++) {
            teams.push({
                territory: t.territory,
                index: i,
                name: "",
                customName: "",
                cleared: false,
                attempts: 0
            });
        }
    });
    return {
        schema: BOARD_SCHEMA,
        side: side,
        roundId: roundId,
        league: league,
        mode: mode,
        createdAt: createdAt,
        territories: cfg.map(t => ({ territory: t.territory, type: t.type, teamCount: t.teamCount })),
        teams: teams
    };
}

function createCompanionMyBoard(opponentBoard) {
    const cfg = opponentBoard.territories.map(t => ({ ...t }));
    const mine = createRoundBoard(
        opponentBoard.league,
        opponentBoard.mode,
        cfg,
        "my",
        opponentBoard.roundId || opponentBoard.createdAt,
        opponentBoard.createdAt || new Date().toISOString()
    );
    return applyDefenceTemplate(mine);
}

function createBoard() {
    const league = leagueDraft;
    const mode = boardMode();
    const cfg = boardConfig[league] && boardConfig[league][mode];
    const settingDefence = settingDefenceRule();

    if (!league || !cfg || cfg.length === 0) {
        alert("Choose a league first. If a league is selected and this still fails, the board configuration hasn't loaded — check your connection and refresh.");
        return;
    }
    if (!settingDefence.ok) {
        alert(settingDefence.message);
        return;
    }

    const createdAt = new Date().toISOString();
    const roundId = createdAt;
    const savedDefence = loadDefenceTemplate(mode);
    board = createRoundBoard(league, mode, cfg, "opponent", roundId, createdAt);
    myBoard = applyDefenceTemplate(createRoundBoard(league, mode, cfg, "my", roundId, createdAt));
    board.defenceSnapshot = captureDefenceSnapshot(mode, myBoard, savedDefence);
    activeBoardSide = "opponent";
    boardModeDraft = null;
    expandedCounterCards = new Set();
    saveBoard("opponent");
    saveBoard("my");

    // The game banks the authored setting-defence award before attacks begin.
    // This happens exactly once, here, for genuinely new rounds. loadBoard() never
    // calls it, so upgrading an in-progress schema-2/3 board cannot overwrite live
    // hand-entered scores.
    bannerData = {
        myScore: myBoard.teams.length * settingDefence.value,
        oppScore: board.teams.length * settingDefence.value,
        remaining: null,
        oppFinal: false,
        scoresPrefilled: true
    };
    persistBannerData();
    render();
}

// ─── BOARD DERIVED STATE ──────────────────────────────────────────────────────

function teamsInTerritory(territoryKey, bd) {
    const target = bd || board;
    return target ? target.teams.filter(t => t.territory === territoryKey) : [];
}

function isTerritoryCleared(territoryKey, bd) {
    const teams = teamsInTerritory(territoryKey, bd);
    return teams.length > 0 && teams.every(t => t.cleared);
}

// A back territory unlocks when the front territory in its lane is cleared.
// This applies to Back Top (fleet) exactly as it does to Back Bottom (squad):
// the fleet territory reveals once Front Top is cleared.
function isTerritoryUnlocked(tDef, bd) {
    if (tDef.territory.indexOf("BACK_") === 0) {
        const front = "FRONT_" + tDef.territory.slice(5);
        return isTerritoryCleared(front, bd || board);
    }
    return true;
}

// Strategic reserve (v3.6): whether any territory on the opponent board is still
// locked behind the reveal chain above — i.e. an enemy zone the player cannot yet
// see. This is the sole hidden-zone signal the allocation engine uses to activate
// the strategic-reserve ranking penalty and warning (see solveAllocation and
// buildReasons below); it reuses isTerritoryUnlocked rather than adding a second
// notion of "revealed", and only ever reads the Round board, never the Counters
// screen's own state.
function roundHasHiddenZones(bd) {
    const target = bd || board;
    if (!target) return false;
    return target.territories.some(tDef => !isTerritoryUnlocked(tDef, target));
}

// Which counter catalogue a territory draws from: fleet territories use the
// FLEET catalogue; squad territories use the board's frozen squad format.
function territoryModeKey(tDef, bd) {
    const target = bd || board;
    return tDef.type === "FLEET" ? "FLEET" : target.mode;
}

// ─── BOARD ACTIONS ────────────────────────────────────────────────────────────

function boardForSide(side) {
    return side === "my" ? myBoard : board;
}

function setBoardSide(side) {
    activeBoardSide = side === "my" ? "my" : "opponent";
    focusedTeamKey = null;
    render();
}

function setBoardTeam(side, territoryKey, index, value) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team) return;
    team.name = value;
    if (value !== NOT_IN_CATALOGUE) team.customName = "";
    saveBoard(side);
    if (side === "my") saveDefenceTemplateFromMyBoard();
    else clearRemainingOverrideOnBoardChange();
    render();
}

function setCustomTeamName(side, territoryKey, index, value) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team || team.name !== NOT_IN_CATALOGUE) return;
    team.customName = value;
    saveBoard(side);
    if (side === "my") saveDefenceTemplateFromMyBoard();
}

function toggleTeamCleared(side, territoryKey, index) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team) return;

    dismissPendingUndoFor(side, territoryKey, index);

    const wasCleared = team.cleared;
    team.cleared = !team.cleared;
    // A cleared team can no longer be Next Up, so drop the highlight if it was on it.
    if (side !== "my" && team.cleared && focusedTeamKey === territoryKey + ":" + index) focusedTeamKey = null;
    saveBoard(side);
    if (side !== "my") clearRemainingOverrideOnBoardChange();

    // Only the Cleared action itself (unset → set) offers a temporary Undo; the
    // same button un-clearing a team is the existing direct toggle, not a new
    // "Unclear" affordance, so it gets none.
    if (team.cleared && !wasCleared) {
        setPendingUndo({
            kind: "cleared",
            side, territoryKey, index,
            prevCleared: wasCleared,
            message: "Defence cleared."
        });
    }
    if (side !== "my" && team.cleared && !wasCleared) {
        advanceToNextDefence(territoryKey);
    } else {
        render();
    }
}

// Combined successful-battle action (v3.4): marks the recommended counter used
// and the defensive team cleared as one operation, so the normal counter path
// takes one tap instead of two. Reuses the same used/cleared writes as the
// individual actions rather than introducing new state.
function markUsedAndCleared(side, territoryKey, index, counterId) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team || (team.cleared && usedTeams.includes(counterId))) return;
    if (side !== "my" && !confirmReserveUse(counterId, territoryKey + ":" + index)) return;

    dismissPendingUndoFor(side, territoryKey, index);

    const prevCleared = team.cleared;
    const wasUsed = usedTeams.includes(counterId);
    const usageChange = side !== "my" ? recordAttackUsage(counterId, "won", "board", territoryKey + ":" + index, wasUsed) : null;

    if (!wasUsed) {
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    team.cleared = true;
    if (side !== "my" && focusedTeamKey === territoryKey + ":" + index) focusedTeamKey = null;
    saveBoard(side);
    if (side !== "my") clearRemainingOverrideOnBoardChange();

    setPendingUndo({
        kind: "usedCleared",
        side, territoryKey, index, counterId,
        prevCleared, wasUsed, usageChange,
        message: "Used + Cleared recorded."
    });
    if (side !== "my" && !prevCleared) {
        advanceToNextDefence(territoryKey);
    } else {
        render();
    }
}

// Failed-battle action: spends the recommended counter and records one more
// battle against this defence, leaving it uncleared. Battles feed the existing
// attempt-bonus and points-to-win calculations on the re-render, so no scoring
// is done here. No auto-advance: the defence is still standing, so it keeps focus
// and the re-solve offers it another available counter.
function markUsedAndLost(side, territoryKey, index, counterId) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team || team.cleared) return;
    if (side !== "my" && !confirmReserveUse(counterId, territoryKey + ":" + index)) return;

    dismissPendingUndoFor(side, territoryKey, index);

    const prevAttempts = team.attempts || 0;
    const wasUsed = usedTeams.includes(counterId);
    const usageChange = side !== "my" ? recordAttackUsage(counterId, "lost", "board", territoryKey + ":" + index, wasUsed) : null;

    if (!wasUsed) {
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    team.attempts = prevAttempts + 1;
    saveBoard(side);
    if (side !== "my") clearRemainingOverrideOnBoardChange();

    setPendingUndo({
        kind: "usedLost",
        side, territoryKey, index, counterId,
        prevCleared: team.cleared, prevAttempts, wasUsed, usageChange,
        message: "Used + Lost recorded."
    });
    render();
}

// Advance through the existing Next Up ordering after a successful clear. Squad
// and fleet are deliberately separate tracks, so a squad clear advances to the
// next squad recommendation and a fleet clear to the next fleet recommendation.
// If no eligible recommendation remains, the normal empty/completed state renders.
function advanceToNextDefence(clearedTerritoryKey) {
    const territory = board && board.territories.find(t => t.territory === clearedTerritoryKey);
    const order = computeBattleOrder(computeRoundPlan());
    const next = territory && territory.type === "FLEET" ? order.fleet : order.squad;

    if (next) {
        focusBoardTeam(next.territory, next.index);
    } else {
        render();
    }
}

// Replaces whatever Undo offer is pending (if any) with a new one and arms its
// expiry timer. Deliberately a single slot rather than a stack (out of scope).
function setPendingUndo(entry) {
    clearPendingUndo();
    entry.timeoutId = setTimeout(() => {
        pendingUndo = null;
        render();
    }, PENDING_UNDO_WINDOW_MS);
    pendingUndo = entry;
}

// Cancels any pending Undo offer without acting on it, e.g. because its window
// expired or a later action superseded it.
function clearPendingUndo() {
    if (pendingUndo && pendingUndo.timeoutId) clearTimeout(pendingUndo.timeoutId);
    pendingUndo = null;
}

// Dismisses a pending Undo offer if it belongs to the exact team a new action
// is about to change, so a stale offer never outlives the state it describes.
function dismissPendingUndoFor(side, territoryKey, index) {
    if (pendingUndo && pendingUndo.side === side && pendingUndo.territoryKey === territoryKey && pendingUndo.index === index) {
        clearPendingUndo();
    }
}

// Restores exactly the state captured immediately before the Cleared,
// Used + Cleared or Used + Lost action that offered this Undo — never a blind toggle, so an
// attacker that was already used before a combined action stays used.
function undoPendingAction() {
    if (!pendingUndo) return;
    const { side, territoryKey, index, counterId, prevCleared, prevAttempts, wasUsed, kind } = pendingUndo;

    const target = boardForSide(side);
    const team = target && target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (team) {
        team.cleared = prevCleared;
        if (kind === "usedLost") team.attempts = prevAttempts;
        saveBoard(side);
        if (side !== "my") clearRemainingOverrideOnBoardChange();
    }

    if ((kind === "usedCleared" || kind === "usedLost") && !wasUsed) {
        const i = usedTeams.indexOf(counterId);
        if (i !== -1) {
            usedTeams.splice(i, 1);
            localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
        }
    }

    undoUsageChange(pendingUndo.usageChange);
    clearPendingUndo();
    render();
}

// Record how many battles have already been fought against a team, mirroring the
// in-game "Battles" count beside each defence team — it climbs 0, 1, 2, 3… for
// every attempt whether or not it cleared the team. The count is stored as-is so
// it always matches the number shown in game; the attempt-bonus rule (first
// attempt worth most, second less, third-or-later nothing) is applied later by
// the points-to-win calculation, not by clamping the count here. Only meaningful
// while the team is uncleared; once cleared, its battles no longer affect what
// is left to win.
function setTeamAttempts(side, territoryKey, index, value) {
    const target = boardForSide(side);
    if (!target) return;
    const team = target.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team) return;
    team.attempts = Math.max(0, value);
    saveBoard(side);
    if (side !== "my") clearRemainingOverrideOnBoardChange();
    render();
}

function clearTerritory(side, territoryKey) {
    const target = boardForSide(side);
    if (!target) return;
    const label = TERRITORY_LABELS[territoryKey] || territoryKey;
    if (!confirm(`Mark every team in ${label} as cleared?`)) return;
    target.teams.forEach(t => { if (t.territory === territoryKey) t.cleared = true; });
    saveBoard(side);
    if (side !== "my") clearRemainingOverrideOnBoardChange();
    render();
}

// Opponent Board action guard: combine hidden-zone reserve with a fresh engine
// check of visible-board expenditure. Call before any write, focus change or Undo
// dismissal, so Cancel is a complete no-op. OK always permits the user override.
function confirmReserveUse(counterId, targetKey) {
    if (usedTeams.includes(counterId)) return true;
    if (board && getCounterStatus(counterId) !== "available") return true;
    const name = getCounterName(counterId);
    const messages = [];
    // Derive a fresh plan without assigning roundPlan or changing any UI/state.
    // The action's own defence is excluded from the remaining-board check: this
    // is expected expenditure there, even if a failed battle later needs cleanup.
    if (board && getCounterStatus(counterId) === "available") {
        const plan = computeRoundPlan();
        const intendedKey = targetKey || Object.keys(plan.assign)
            .find(key => plan.assign[key].counterId === counterId);
        const impact = assessCounterUseImpact(plan, counterId, intendedKey);
        if (impact.affected.length) {
            const affected = impact.affected[0];
            const via = affected.sharedRequiredCharacters.length
                ? ` through ${affected.sharedRequiredCharacters.map(getCharacterName).join(", ")}` : "";
            const remaining = affected.remaining
                ? `${getCounterName(affected.remaining.counterId)} (${affected.remaining.tier} tier) remains in the plan; that is a weaker option, not a guaranteed win.`
                : "No one-shot counter remains assigned there.";
            messages.push(impact.state === "limited"
                ? `Using ${name} may weaken coverage for ${affected.defenceName}${via}. Remaining coverage is uncertain because the allocation check reached its search limit.`
                : `Using ${name} would weaken coverage for ${affected.defenceName}${via}. ${remaining}`);
        }
    }
    if (isHighReserve(counterId) && roundHasHiddenZones(board)) {
        messages.push(`Some enemy squads are still hidden. ${name} may be needed for a more difficult matchup later.`);
    }
    if (!messages.length) return true;
    return confirm(`Use ${name} now?\n\n${messages.join("\n\n")}\n\nOK: Use anyway. Cancel: Keep available.`);
}

// Mark a counter used straight from a board recommendation. The plan re-solves
// on the render that follows — no stored plan to keep in sync.
function markCounterUsedFromBoard(counterId, targetKey) {
    if (!confirmReserveUse(counterId, targetKey)) return;
    if (!usedTeams.includes(counterId)) {
        recordAttackUsage(counterId, "used", "board", targetKey);
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    render();
}

// Local usage facts are independent of the live round and catalogue cache.
// IDs are round-scoped actions; corrections retain identity and increment revision.
function emptyUsageHistory() {
    return { schema: 1, selectedSeasonId: null, roundSeasons: {}, defenceRounds: [], completedSeasonIds: [], attackFleetLineups: {}, events: [] };
}

function validUsageParticipants(participants) {
    return Array.isArray(participants) && participants.every(p => p && typeof p.unitId === "string" && p.unitId.trim().length > 0 &&
        ["CHARACTER", "SHIP", "CAPITAL_SHIP"].includes(p.unitType) && typeof p.role === "string" && p.role.length > 0) &&
        new Set(participants.map(p => p.unitId)).size === participants.length;
}

function validUsageEvent(e) {
    return e && typeof e.id === "string" && e.id.length > 0 && typeof e.roundId === "string" && e.roundId.length > 0 &&
        (e.seasonId === null || (typeof e.seasonId === "string" && e.seasonId.trim().length > 0)) &&
        ["5v5", "3v3", "FLEET"].includes(e.mode) && ["attack", "defence"].includes(e.side) &&
        typeof e.source === "string" && typeof e.identity === "string" &&
        (e.counterId === null || typeof e.counterId === "string") && (e.slotKey === null || typeof e.slotKey === "string") &&
        validUsageParticipants(e.participants) &&
        (e.capitalShipId === undefined || e.capitalShipId === null || (e.mode === "FLEET" && typeof e.capitalShipId === "string" &&
            e.participants?.some(p => p.unitId === e.capitalShipId && p.unitType === "CAPITAL_SHIP"))) &&
        (e.benchShips === undefined || (e.mode === "FLEET" && Array.isArray(e.benchShips) &&
            e.benchShips.every(id => validUsageCanonicalId(id) && !e.participants?.some(p => p.unitId === id)) && new Set(e.benchShips).size === e.benchShips.length)) &&
        e.participants.filter(p => p.unitType === "CAPITAL_SHIP").length <= 1 && e.participants.every(p => e.mode === "FLEET"
            ? p.unitType !== "CHARACTER" || p.role === "pilot" : p.unitType === "CHARACTER") &&
        (e.side === "defence" ? e.outcome === "deployed" : e.outcome !== "deployed") && e.attribution && typeof e.attribution.complete === "boolean" &&
        typeof e.attribution.provenance === "string" &&
        (e.attribution.pilotsComplete === undefined || typeof e.attribution.pilotsComplete === "boolean") &&
        (e.attribution.reinforcementParticipationKnown === undefined || typeof e.attribution.reinforcementParticipationKnown === "boolean") && ["used", "won", "lost", "deployed"].includes(e.outcome) &&
        typeof e.voided === "boolean" && Number.isInteger(e.revision) && e.revision > 0 &&
        typeof e.createdAt === "string" && typeof e.updatedAt === "string";
}

function loadUsageHistory() {
    const empty = emptyUsageHistory();
    try {
        const raw = localStorage.getItem(USAGE_HISTORY_KEY);
        if (!raw) return empty;
        const data = JSON.parse(raw);
        if (data && Number.isInteger(data.schema) && data.schema > 1) {
            usageHistoryWritable = false;
            usageHistoryMessage = "Usage history was saved by a newer app; recording is paused.";
            return empty;
        }
        if (!data || data.schema !== 1 || !Array.isArray(data.events) || !isPlainObject(data.roundSeasons) ||
            !Array.isArray(data.defenceRounds) || !data.defenceRounds.every(id => typeof id === "string") ||
            !(data.selectedSeasonId === null || typeof data.selectedSeasonId === "string") ||
            !Object.values(data.roundSeasons).every(id => id === null || typeof id === "string") ||
            !validateUsageHistoryExtensions(data)) throw new Error("Invalid usage store");
        const seen = new Set();
        const rejected = [];
        const events = data.events.filter(e => {
            if (!validUsageEvent(e) || seen.has(e.id)) { rejected.push(e); return false; }
            seen.add(e.id); return true;
        });
        // Keep unknown fields and quarantined rows for recovery, never reinterpret them.
        return { ...data, completedSeasonIds: data.completedSeasonIds || [], attackFleetLineups: data.attackFleetLineups || {}, events, rejectedEvents: [...(Array.isArray(data.rejectedEvents) ? data.rejectedEvents : []), ...rejected] };
    } catch (e) {
        try {
            const raw = localStorage.getItem(USAGE_HISTORY_KEY);
            localStorage.setItem(`${USAGE_HISTORY_KEY}:recovery:${Date.now()}`, raw);
            usageHistoryMessage = "Unreadable usage history kept in a local recovery copy. New recording starts here.";
        } catch (backupError) {
            usageHistoryWritable = false;
            usageHistoryMessage = "Usage history could not be recovered; recording is paused to protect it.";
        }
        return empty;
    }
}

function saveUsageHistory() {
    if (!usageHistoryWritable) return false;
    try {
        localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(usageHistory));
        return true;
    } catch (e) {
        usageHistoryMessage = "Usage history could not be saved on this device. Keep this page open and free some storage.";
        return false;
    }
}

function chooseUsageSeason() {
    if (!usageHistoryWritable || typeof prompt !== "function") return false;
    const answer = prompt("GAC season identifier (use the official season number or your own consistent label; dates are not inferred):", usageHistory.selectedSeasonId || "");
    if (answer === null || !answer.trim()) return false;
    const label = answer.trim().slice(0, 100);
    if ((usageHistory.completedSeasonIds || []).includes(label)) {
        usageScreenMessage = { kind: "error", text: "That season is already completed. Choose a new current season." };
        render(); return false;
    }
    usageHistory.selectedSeasonId = label;
    // Explicitly assigning a season may resolve this round's unknown season.
    if (board && (!Object.hasOwn(usageHistory.roundSeasons, board.roundId) || usageHistory.roundSeasons[board.roundId] === null)) {
        usageHistory.roundSeasons[board.roundId] = usageHistory.selectedSeasonId;
        usageHistory.events.filter(e => e.roundId === board.roundId && e.seasonId === null).forEach(e => {
            e.seasonId = usageHistory.selectedSeasonId; e.revision++; e.updatedAt = new Date().toISOString();
        });
    }
    saveUsageHistory();
    render();
    return true;
}

function usageSeasonForRound() {
    if (!Object.hasOwn(usageHistory.roundSeasons, board.roundId)) {
        if (!usageHistory.selectedSeasonId) chooseUsageSeason();
        usageHistory.roundSeasons[board.roundId] = usageHistory.selectedSeasonId;
    }
    return usageHistory.roundSeasons[board.roundId];
}

function writeUsageEvent(fact, persist = true) {
    if (!usageHistoryWritable) return null;
    const previous = usageHistory.events.find(e => e.id === fact.id);
    const comparable = e => JSON.stringify([e.participants, e.attribution, e.outcome, e.voided, e.identity, e.slotKey, e.snapshotFingerprint, e.benchShips, e.capitalShipId]);
    if (previous && comparable(previous) === comparable(fact)) return { eventId: previous.id, previous: JSON.parse(JSON.stringify(previous)) };
    const now = new Date().toISOString();
    const next = { ...fact, revision: previous ? previous.revision + 1 : 1,
        createdAt: previous ? previous.createdAt : now, updatedAt: now };
    if (!validUsageEvent(next)) return null;
    if (previous) usageHistory.events[usageHistory.events.indexOf(previous)] = next;
    else usageHistory.events.push(next);
    if (persist) saveUsageHistory();
    return { eventId: next.id, previous: previous ? JSON.parse(JSON.stringify(previous)) : null };
}

function recordAttackUsage(counterId, outcome = "used", source = "counters", targetKey = null, wasUsed = false) {
    if (!board || !usageHistoryWritable) return null;
    const id = JSON.stringify([board.roundId, "attack", counterId]);
    const previous = usageHistory.events.find(e => e.id === id);
    // Pre-existing used state is not evidence of a newly recorded battle.
    if (wasUsed && !previous) return null;
    if (previous && !previous.voided) {
        if (outcome === "used") return null;
        return writeUsageEvent({ ...previous, outcome, slotKey: previous.slotKey || targetKey || null });
    }
    const def = counterDefinitions[counterId];
    const territory = targetKey && board.territories.find(t => t.territory === targetKey.split(":")[0]);
    const mode = territory && territory.type === "FLEET" || (!targetKey && currentMode === "FLEET") ? "FLEET" : source === "counters" ? currentMode : board.mode;
    return writeUsageEvent({ id, roundId: board.roundId, roundMode: board.mode, seasonId: usageSeasonForRound(), mode, side: "attack", source,
        counterId, slotKey: targetKey || null, identity: counterId,
        ...automaticAttackUsageFacts(counterId, mode),
        // The required core is known participation, never a full-lineup claim.
        strategicCore: def && Array.isArray(def.required) ? [...def.required] : [], outcome, voided: false });
}

function undoUsageChange(change) {
    if (!change) return;
    const event = usageHistory.events.find(e => e.id === change.eventId);
    if (!event) return;
    writeUsageEvent(change.previous
        ? { ...event, outcome: change.previous.outcome, slotKey: change.previous.slotKey, voided: change.previous.voided }
        : { ...event, voided: true });
}

// Narrow correction API for later actual-lineup editors. No catalogue inference.
function correctUsageParticipants(eventId, participants, attribution) {
    const event = usageHistory.events.find(e => e.id === eventId);
    if (!event || !validUsageParticipants(participants) || !attribution || typeof attribution.complete !== "boolean" ||
        typeof attribution.provenance !== "string" || !attribution.provenance.trim()) return false;
    if (participants.some(p => !characterDefinitions[p.unitId] || characterDefinitions[p.unitId].unitType !== p.unitType)) return false;
    if (participants.some(p => event.mode === "FLEET" ? p.unitType === "CHARACTER" && p.role !== "pilot" : p.unitType !== "CHARACTER")) return false;
    return !!writeUsageEvent({ ...event, participants: JSON.parse(JSON.stringify(participants)), attribution: { ...attribution } });
}

function confirmRoundDefenceUsage() {
    if (!board || !usageHistoryWritable || !board.defenceSnapshot || board.defenceSnapshot.schema !== 2 || board.defenceSnapshot.missingSavedDefence) return false;
    if (usageHistory.defenceRounds.includes(board.roundId)) return false;
    if (!confirm("Record this round's frozen defence as actually deployed? Only explicitly saved slot members count; catalogue proposals, unknown slots and legacy blocks remain unattributed. Saving a template alone never records deployment.")) return false;
    usageSeasonForRound();
    usageHistory.defenceRounds.push(board.roundId);
    syncConfirmedDefenceUsage();
    return true;
}

function syncConfirmedDefenceUsage() {
    if (!board || !usageHistoryWritable || !usageHistory.defenceRounds.includes(board.roundId)) return;
    const snapshot = board.defenceSnapshot;
    if (!snapshot || snapshot.schema !== 2) return;
    snapshot.slots.forEach(slot => {
        // An explicitly reviewed empty slot is not a deployed team.
        const slotKey = `${slot.territory}:${slot.index}`;
        const id = JSON.stringify([board.roundId, "defence", slotKey]);
        const previous = usageHistory.events.find(e => e.id === id);
        if (!slot.name && slot.reviewed) {
            if (previous) writeUsageEvent({ ...previous, voided: true }, false);
            return;
        }
        const snapshotFingerprint = JSON.stringify([slot.name, slot.customName, slot.source, slot.lineup, slot.confirmed, slot.characterIds]);
        if (previous && previous.snapshotFingerprint === snapshotFingerprint && !previous.voided) return;
        const explicit = slot.source === "saved" && slot.lineup;
        const ids = explicit ? [...new Set(slot.characterIds)] : [];
        const facts = slot.type === "FLEET" ? fleetUsageFacts(explicit ? slot.lineup : {},
            explicit ? "explicit-saved-lineup" : "unattributed", !!explicit && slot.confirmed === true) : {
            participants: ids.map(unitId => ({ unitId, unitType: "CHARACTER", role: "member" })),
            attribution: { complete: !!explicit && slot.confirmed === true, provenance: explicit ? "explicit-saved-lineup" : "unattributed" }
        };
        writeUsageEvent({ id, roundId: board.roundId, seasonId: usageHistory.roundSeasons[board.roundId] ?? null,
            mode: slot.type === "FLEET" ? "FLEET" : board.mode, side: "defence", source: "round-defence-confirmation",
            counterId: null, slotKey, snapshotFingerprint, identity: slot.name ? slot.customName || slot.name : "",
            ...facts, outcome: "deployed", voided: false }, false);
    });
    saveUsageHistory();
}

// Both sides contribute one per event, never outcome-based weights. Missing
// participation is returned separately: absence from units does not mean zero.
function aggregateUsageHistory(events = usageHistory.events) {
    const units = new Map(), teams = new Map(), unattributed = [];
    events.filter(e => validUsageEvent(e) && !e.voided).forEach(e => {
        const key = JSON.stringify([e.mode, e.identity]);
        if (e.identity) teams.set(key, { identity: e.identity, mode: e.mode, uses: (teams.get(key)?.uses || 0) + 1 });
        e.participants.forEach(p => {
            const key = `${p.unitType}:${p.unitId}`;
            units.set(key, { unitId: p.unitId, unitType: p.unitType, uses: (units.get(key)?.uses || 0) + 1 });
        });
        if (!e.attribution.complete || (e.mode === "FLEET" && !e.attribution.pilotsComplete)) {
            unattributed.push({ eventId: e.id, mode: e.mode, side: e.side,
                units: !e.attribution.complete, pilots: e.mode === "FLEET" && !e.attribution.pilotsComplete });
        }
    });
    return { units: [...units.values()], teams: [...teams.values()], unattributed };
}

function renderUsageRecordingStatus() {
    const assigned = board && Object.hasOwn(usageHistory.roundSeasons, board.roundId);
    const season = assigned ? usageHistory.roundSeasons[board.roundId] : usageHistory.selectedSeasonId;
    const confirmed = board && usageHistory.defenceRounds.includes(board.roundId);
    const events = board ? usageHistory.events.filter(e => e.roundId === board.roundId && !e.voided) : [];
    const incomplete = events.filter(e => !e.attribution.complete).length;
    const nextSeason = assigned && season && usageHistory.selectedSeasonId !== season
        ? `<div class="round-stat">Next rounds: ${escapeHtml(usageHistory.selectedSeasonId || "Not selected")}</div>` : "";
    return `<div class="round-stat">Usage season: ${season ? escapeHtml(season) : "Unknown — choose to assign this round"}
        <button class="defence-adopt-btn" onclick="chooseUsageSeason()">${assigned && season ? "Season for next rounds" : "Choose season"}</button></div>${nextSeason}
        ${board && board.defenceSnapshot && board.defenceSnapshot.schema === 2 ? `<div class="round-stat">Defence usage: ${confirmed ? "deployment recorded" : "not confirmed"}${incomplete ? ` · ${incomplete} usage lineups incomplete` : ""}
        ${confirmed ? "" : board.defenceSnapshot.missingSavedDefence ? " — set this round’s defence first" : '<button class="defence-adopt-btn" onclick="confirmRoundDefenceUsage(); render()">Confirm actual defence deployment</button>'}</div>` : ""}
        ${usageHistoryMessage ? `<div class="roster-msg roster-msg-warn" role="status">${escapeHtml(usageHistoryMessage)}</div>` : ""}`;
}

// Usage rankings are derived from event facts; no league totals are persisted.
let usageTab = "characters";
let usagePeriod = "current";
let usageScreenMessage = null;

function usageCompletedSeasons(history = usageHistory) {
    return Array.isArray(history.completedSeasonIds) ? history.completedSeasonIds : [];
}

function usagePeriodEvents(period = usagePeriod, history = usageHistory) {
    const events = history.events.filter(event => validUsageEvent(event) && !event.voided);
    if (period === "all") return events;
    const seasons = period === "completed"
        ? usageCompletedSeasons(history).filter(id => id !== history.selectedSeasonId).slice(-3)
        : history.selectedSeasonId ? [history.selectedSeasonId] : [];
    return events.filter(event => event.seasonId !== null && seasons.includes(event.seasonId));
}

function usageRankings(tab = usageTab, events = usagePeriodEvents()) {
    const rows = new Map();
    const add = (id, event) => {
        let row = rows.get(id);
        if (!row) {
            row = { id, label: getCharacterName(id), total: 0, attack: 0, defence: 0, wins: 0, losses: 0 };
            rows.set(id, row);
        }
        row.total++;
        row[event.side]++;
        if (event.side === "attack" && event.outcome === "won") row.wins++;
        if (event.side === "attack" && event.outcome === "lost") row.losses++;
    };
    events.forEach(event => {
        if (tab === "fleets") {
            if (event.mode !== "FLEET") return;
            const capital = event.capitalShipId || event.participants.find(p => p.unitType === "CAPITAL_SHIP")?.unitId;
            if (capital) add(capital, event);
            return;
        }
        const unitType = tab === "ships" ? "SHIP" : "CHARACTER";
        // Defensive duplicate protection also covers a pilot occupying several roles.
        new Set(event.participants.filter(p => p.unitType === unitType).map(p => p.unitId)).forEach(id => add(id, event));
    });
    const ordered = [...rows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    let rank = 0, lastTotal = null;
    return ordered.map((row, index) => {
        if (row.total !== lastTotal) rank = index + 1;
        lastTotal = row.total;
        return { ...row, rank };
    });
}

function setUsageTab(tab) {
    if (!["characters", "ships", "fleets"].includes(tab)) return;
    usageTab = tab;
    render();
}

function setUsagePeriod(period) {
    if (!["current", "completed", "all"].includes(period)) return;
    usagePeriod = period;
    render();
}

function completeUsageSeason(nextSeasonId) {
    if (!usageHistoryWritable || !usageHistory.selectedSeasonId) return false;
    const previous = usageHistory.selectedSeasonId;
    let next = nextSeasonId;
    if (next === undefined) {
        if (typeof prompt !== "function") return false;
        next = prompt(`Complete ${previous} and start which GAC season? Enter the next official number or your consistent label.`, "");
    }
    if (typeof next !== "string" || !next.trim() || next.trim() === previous || next.trim().length > 100) return false;
    next = next.trim();
    if (usageCompletedSeasons().includes(next)) {
        usageScreenMessage = { kind: "error", text: "That season is already marked completed. Choose a new current season." };
        render();
        return false;
    }
    const candidate = { ...usageHistory, selectedSeasonId: next,
        completedSeasonIds: [...usageCompletedSeasons().filter(id => id !== previous), previous] };
    try {
        localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(candidate));
    } catch (error) {
        usageScreenMessage = { kind: "error", text: "Could not save the season change. Existing history is unchanged." };
        render();
        return false;
    }
    usageHistory = candidate;
    usageScreenMessage = { kind: "ok", text: `${previous} marked completed. Current season: ${next}. Existing rounds keep their season.` };
    render();
    return true;
}

function validUsageCanonicalId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(id);
}

function validUsageKnownType(id, unitType) {
    return validUsageCanonicalId(id) && (!characterDefinitions[id] || characterDefinitions[id].unitType === unitType);
}

function validateUsageHistoryExtensions(history, validateKnownTypes = false) {
    const validUnit = (id, type) => validateKnownTypes ? validUsageKnownType(id, type) : validUsageCanonicalId(id);
    if (history.completedSeasonIds !== undefined && (!Array.isArray(history.completedSeasonIds) ||
        history.completedSeasonIds.some(id => typeof id !== "string" || !id.trim() || id.length > 100) ||
        new Set(history.completedSeasonIds).size !== history.completedSeasonIds.length)) return false;
    if (history.attackFleetLineups !== undefined) {
        if (!isPlainObject(history.attackFleetLineups)) return false;
        for (const [counterId, lineup] of Object.entries(history.attackFleetLineups)) {
            if (!validUsageCanonicalId(counterId) || !lineup || lineup.schema !== 1 ||
                !validUnit(lineup.capitalShipId, "CAPITAL_SHIP") ||
                !Array.isArray(lineup.startingShipIds) || lineup.startingShipIds.length !== 3 ||
                !Array.isArray(lineup.reinforcementIds) || lineup.reinforcementIds.length > 4 ||
                [...lineup.startingShipIds, ...lineup.reinforcementIds].some(id => !validUnit(id, "SHIP")) ||
                new Set([...lineup.startingShipIds, ...lineup.reinforcementIds]).size !== lineup.startingShipIds.length + lineup.reinforcementIds.length) return false;
        }
    }
    return true;
}

function validateUsageBackupEvent(event) {
    if (!validUsageEvent(event) || !event.roundId.trim() || event.roundId.length > 256 ||
        /[\u0000-\u001f]/.test(event.roundId) || !Number.isFinite(Date.parse(event.createdAt)) ||
        !Number.isFinite(Date.parse(event.updatedAt)) ||
        event.participants.some(p => !validUsageKnownType(p.unitId, p.unitType))) return false;
    let identity;
    try { identity = JSON.parse(event.id); } catch (error) { return false; }
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== event.roundId || identity[1] !== event.side) return false;
    if (event.side === "attack") {
        if (!validUsageCanonicalId(event.counterId) || identity[2] !== event.counterId || event.identity !== event.counterId) return false;
    } else if (identity[2] !== event.slotKey || event.slotKey === null || event.counterId !== null) return false;
    if (!event.source.trim() || /[\u0000-\u001f]/.test(event.source) || !event.attribution.provenance.trim()) return false;
    const capitals = event.participants.filter(p => p.unitType === "CAPITAL_SHIP");
    if (capitals.length > 1 || (event.capitalShipId && (event.mode !== "FLEET" || capitals.length && capitals[0].unitId !== event.capitalShipId))) return false;
    if (event.slotKey !== null && !/^(FRONT_TOP|FRONT_BOTTOM|BACK_TOP|BACK_BOTTOM):\d+$/.test(event.slotKey)) return false;
    if (event.capitalShipId !== undefined && event.capitalShipId !== null && !validUsageKnownType(event.capitalShipId, "CAPITAL_SHIP")) return false;
    if (event.benchShips !== undefined && (!Array.isArray(event.benchShips) ||
        event.mode !== "FLEET" || event.benchShips.some(id => !validUsageKnownType(id, "SHIP") || event.participants.some(p => p.unitId === id)) || new Set(event.benchShips).size !== event.benchShips.length)) return false;
    return true;
}

function canonicalUsageJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalUsageJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalUsageJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

// A complete backup carries every event (including voided facts), never roster
// ownership or account metadata. Unknown event extensions survive round trips.
function usageBackupPayload() {
    if (!usageHistoryWritable) throw new Error("Export is paused to protect unreadable or newer history. The original device store is unchanged.");
    const history = {
        schema: 1, selectedSeasonId: usageHistory.selectedSeasonId,
        roundSeasons: usageHistory.roundSeasons, defenceRounds: usageHistory.defenceRounds,
        events: usageHistory.events, completedSeasonIds: usageCompletedSeasons(),
        attackFleetLineups: usageHistory.attackFleetLineups || {}
    };
    const text = JSON.stringify({ format: "gac-usage-history", schema: 1, exportedAt: new Date().toISOString(), history },
        (key, value) => /^(allyCode|ally_code|owned|ownedCharacters|rosterData|rosterMeta|accessToken|refreshToken)$/i.test(key) ? undefined : value, 2);
    return text;
}

function mergeCompletedUsageSeasons(existing, incoming) {
    if (!existing.length) return [...incoming];
    if (!incoming.length) return [...existing];
    const all = [...new Set([...existing, ...incoming])];
    const edges = new Map(all.map(id => [id, new Set()]));
    const degree = new Map(all.map(id => [id, 0]));
    [existing, incoming].forEach(sequence => sequence.slice(1).forEach((id, index) => {
        const before = sequence[index];
        if (!edges.get(before).has(id)) { edges.get(before).add(id); degree.set(id, degree.get(id) + 1); }
    }));
    const result = [];
    while (result.length < all.length) {
        const options = all.filter(id => degree.get(id) === 0 && !result.includes(id));
        if (options.length !== 1) throw new Error("Completed-season order conflicts or is ambiguous. Keep the original backup and review season labels before importing.");
        const next = options[0]; result.push(next);
        edges.get(next).forEach(id => degree.set(id, degree.get(id) - 1));
    }
    return result;
}

function prepareUsageHistoryImport(raw) {
    let backup;
    try { backup = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (error) { throw new Error("This is not valid usage-history JSON."); }
    if (!backup || backup.format !== "gac-usage-history" || backup.schema !== 1) throw new Error("Unsupported usage-history backup version.");
    const incoming = backup.history;
    if (!incoming || incoming.schema !== 1 || !Array.isArray(incoming.events) || !isPlainObject(incoming.roundSeasons) ||
        !Array.isArray(incoming.defenceRounds) || incoming.defenceRounds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(incoming.defenceRounds).size !== incoming.defenceRounds.length ||
        !(incoming.selectedSeasonId === null || typeof incoming.selectedSeasonId === "string" && incoming.selectedSeasonId.trim() && incoming.selectedSeasonId.length <= 100) ||
        Object.entries(incoming.roundSeasons).some(([id, season]) => !id.trim() || /[\u0000-\u001f]/.test(id) || !(season === null || typeof season === "string" && season.trim() && season.length <= 100)) ||
        !validateUsageHistoryExtensions(incoming, true)) throw new Error("Invalid usage-history backup shape.");
    const seen = new Set();
    incoming.events.forEach(event => {
        if (!validateUsageBackupEvent(event)) throw new Error("A usage event has invalid identity, participants or fields.");
        if (seen.has(event.id)) throw new Error("The backup contains duplicate event IDs.");
        seen.add(event.id);
        if (!Object.hasOwn(incoming.roundSeasons, event.roundId) || incoming.roundSeasons[event.roundId] !== event.seasonId) throw new Error("An event conflicts with its round's season assignment.");
        if (event.side === "defence" && !incoming.defenceRounds.includes(event.roundId)) throw new Error("A defensive event has no confirmed round deployment.");
    });
    const currentEvents = new Map(usageHistory.events.map(event => [event.id, event]));
    const mergedEvents = [...usageHistory.events];
    let added = 0;
    incoming.events.forEach(event => {
        const existing = currentEvents.get(event.id);
        if (existing && canonicalUsageJson(existing) !== canonicalUsageJson(event)) throw new Error("An imported event conflicts with an existing event. Existing history has not changed.");
        if (!existing) { mergedEvents.push(event); added++; }
    });
    const roundSeasons = { ...usageHistory.roundSeasons };
    Object.entries(incoming.roundSeasons).forEach(([id, season]) => {
        if (Object.hasOwn(roundSeasons, id) && roundSeasons[id] !== season) throw new Error("A round has conflicting season assignments.");
        Object.defineProperty(roundSeasons, id, { value: season, enumerable: true, configurable: true, writable: true });
    });
    const lineups = { ...(usageHistory.attackFleetLineups || {}) };
    Object.entries(incoming.attackFleetLineups || {}).forEach(([id, lineup]) => {
        if (Object.hasOwn(lineups, id) && canonicalUsageJson(lineups[id]) !== canonicalUsageJson(lineup)) throw new Error("A saved attacking fleet conflicts with this device's lineup.");
        Object.defineProperty(lineups, id, { value: lineup, enumerable: true, configurable: true, writable: true });
    });
    const completedSeasonIds = mergeCompletedUsageSeasons(usageCompletedSeasons(), incoming.completedSeasonIds || []);
    const selectedSeasonId = usageHistory.selectedSeasonId || incoming.selectedSeasonId;
    const history = { ...usageHistory, events: mergedEvents, roundSeasons,
        defenceRounds: [...new Set([...usageHistory.defenceRounds, ...incoming.defenceRounds])],
        completedSeasonIds, selectedSeasonId, attackFleetLineups: lineups };
    return { history, added };
}

function importUsageHistory(raw) {
    if (!usageHistoryWritable) return { ok: false, error: "Recording is paused to protect a newer or unreadable store." };
    try {
        const { history, added } = prepareUsageHistoryImport(raw);
        // Commit a validated merge in one write; quota errors preserve memory and disk.
        localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
        usageHistory = history;
        clearPendingUndo();
        usageScreenMessage = { kind: "ok", text: `Imported ${added} new usage event${added === 1 ? "" : "s"}. Existing identical events were kept once.` };
        render();
        return { ok: true, added };
    } catch (error) {
        usageScreenMessage = { kind: "error", text: error.message || "Could not save imported history. Existing history is unchanged." };
        render();
        return { ok: false, error: usageScreenMessage.text };
    }
}

async function importUsageHistoryFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
        usageScreenMessage = { kind: "error", text: "Usage backup is too large (maximum 16 MB). Existing history is unchanged." };
        render(); return;
    }
    try { importUsageHistory(await file.text()); }
    catch (error) { usageScreenMessage = { kind: "error", text: "Could not read that file. Existing history is unchanged." }; render(); }
}

function exportUsageHistory() {
    try {
        const blob = new Blob([usageBackupPayload()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `gac-usage-history-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        usageScreenMessage = { kind: "ok", text: "Usage-history JSON downloaded. Keep the file somewhere safe; browser storage can be lost." };
    } catch (error) {
        usageScreenMessage = { kind: "error", text: "Could not download the backup in this browser." };
    }
    render();
}

function renderUsage() {
    const events = usagePeriodEvents();
    const rows = usageRankings(usageTab, events);
    const unknownSeasons = usageHistory.events.filter(event => validUsageEvent(event) && !event.voided && event.seasonId === null).length;
    const partial = events.filter(event => !event.attribution.complete).length;
    const unknownPilots = events.filter(event => event.mode === "FLEET" && event.attribution.pilotsComplete !== true).length;
    const unconfirmedReinforcements = events.filter(event => event.mode === "FLEET" && ((event.benchShips || []).length || event.attribution.reinforcementParticipationKnown === false)).length;
    const unknownFleets = events.filter(event => event.mode === "FLEET" && !event.capitalShipId && !event.participants.some(p => p.unitType === "CAPITAL_SHIP")).length;
    const periodLabel = usagePeriod === "current" ? usageHistory.selectedSeasonId ? `Current season: ${usageHistory.selectedSeasonId}` : "Choose a current season to view this period."
        : usagePeriod === "completed" ? `Completed seasons: ${usageCompletedSeasons().filter(id => id !== usageHistory.selectedSeasonId).slice(-3).join(", ") || "none marked complete"}` : "All recorded time, including unknown seasons";
    return `<section class="round-card usage-screen">
        <h1 class="round-title">USAGE</h1>
        <p class="usage-help">Each attack and confirmed defensive deployment counts once. Wins and losses describe attacks only.</p>
        <div class="mode-toggle usage-tabs" aria-label="Usage category">${[["characters", "Characters"], ["ships", "Ships"], ["fleets", "Fleets"]].map(([id, label]) => `<button class="mode-button ${usageTab === id ? "active" : ""}" aria-pressed="${usageTab === id}" onclick="setUsageTab('${id}')">${label}</button>`).join("")}</div>
        <label class="usage-period">Period<select class="board-team-select" onchange="setUsagePeriod(this.value)">
            <option value="current" ${usagePeriod === "current" ? "selected" : ""}>Current season</option>
            <option value="completed" ${usagePeriod === "completed" ? "selected" : ""}>Last three completed seasons</option>
            <option value="all" ${usagePeriod === "all" ? "selected" : ""}>All recorded time</option>
        </select></label><p class="usage-help">${escapeHtml(periodLabel)}</p>
        ${unknownSeasons ? `<p class="usage-warning">${unknownSeasons} event${unknownSeasons === 1 ? " has" : "s have"} an unknown season; included only in All recorded time.</p>` : ""}
        ${partial || unknownPilots || unknownFleets ? `<p class="usage-warning">Attribution is incomplete: ${partial} partial lineup${partial === 1 ? "" : "s"}${unknownPilots ? `; ${unknownPilots} fleet${unknownPilots === 1 ? " has" : "s have"} unknown pilot coverage` : ""}${unknownFleets ? `; ${unknownFleets} fleet identit${unknownFleets === 1 ? "y is" : "ies are"} unknown` : ""}. Missing units are unknown, not zero. Optional corrections are below.</p>` : ""}
        ${unconfirmedReinforcements ? `<p class="usage-warning">${unconfirmedReinforcements} fleet${unconfirmedReinforcements === 1 ? " has" : "s have"} reinforcements awaiting participation confirmation. Benched ships and their pilots are excluded until you confirm they actually participated.</p>` : ""}
        ${rows.length ? `<p class="usage-help">Most uses first; equal totals share a rank. Ties display alphabetically. ${usageTab === "ships" ? "Ships count participating non-capital hulls; Fleets groups deployments by capital ship." : usageTab === "fleets" ? "Fleets are grouped by the recorded capital ship, independently of ship appearances." : "Includes pilots only where participation is recorded."}</p>
        <ol class="usage-ranking">${rows.map(row => `<li class="usage-row"><div class="usage-rank">${row.rank}</div><div class="usage-unit"><strong>${escapeHtml(row.label)}</strong>${characterDefinitions[row.id] ? "" : '<span class="usage-help">Saved unit; not in current catalogue</span>'}<span class="usage-help">Attack ${row.attack} · Defence ${row.defence} · Wins ${row.wins} · Losses ${row.losses}</span></div><div class="usage-total">${row.total}<span>uses</span></div></li>`).join("")}</ol>`
            : `<p class="usage-empty">${events.length ? "No attributed uses in this category for this period. Record or correct actual participants to populate the table." : usageHistory.events.length ? "No usage recorded for this period. Try All recorded time or check the season selection." : "No usage recorded yet. Mark attackers used during a round and separately confirm actual defensive deployment to start your history."}</p>`}
        ${usageScreenMessage ? `<div class="roster-msg roster-msg-${usageScreenMessage.kind}" role="status">${escapeHtml(usageScreenMessage.text)}</div>` : ""}
        ${usageHistoryMessage ? `<div class="roster-msg roster-msg-warn" role="status">${escapeHtml(usageHistoryMessage)}</div>` : ""}
    </section>
    <details class="round-card usage-details"><summary>Season periods</summary><p class="usage-help">Seasons are explicit labels. Completion is recorded by you, never inferred from calendar months. Existing rounds retain their assigned season.</p>
        <button class="roster-data-btn" onclick="chooseUsageSeason()">Choose current season</button>
        <button class="roster-data-btn" onclick="completeUsageSeason()" ${usageHistory.selectedSeasonId ? "" : "disabled"}>Complete season / start next</button>
    </details>
    ${typeof renderUsageCorrections === "function" ? renderUsageCorrections() : ""}
    <details class="round-card usage-details"><summary>History backup</summary><p class="usage-help">Export local usage as JSON before changing device or clearing browser data. Import merges identical events once; conflicting history is rejected. No account or roster data is included.</p>
        <button class="roster-data-btn" onclick="exportUsageHistory()">Export usage JSON</button>
        <label class="usage-file-label">Import usage JSON<input type="file" accept="application/json,.json" onchange="importUsageHistoryFile(this)"></label>
    </details>`;
}

// Capture attribution at recording/correction time only. Catalogue or template
// changes never reinterpret historical facts during aggregation or rendering.
function fleetUsageFacts(lineup, provenance, complete = true) {
    const participants = [], seen = new Set();
    const add = (unitId, unitType, role) => {
        if (unitId && !seen.has(unitId)) { seen.add(unitId); participants.push({ unitId, unitType, role }); }
    };
    const participating = new Set(lineup.participatingReinforcementIds || []);
    let pilotsComplete = true;
    const ship = (id, type, role) => {
        if (!id) return;
        add(id, type, role);
        const crew = characterDefinitions[id] && characterDefinitions[id].pilotIds;
        if (!Array.isArray(crew)) { pilotsComplete = false; return; }
        crew.forEach(pilot => add(pilot, "CHARACTER", "pilot"));
    };
    ship(lineup.capitalShipId, "CAPITAL_SHIP", "capital");
    (lineup.startingShipIds || []).forEach(id => ship(id, "SHIP", "starter"));
    (lineup.reinforcementIds || []).filter(id => participating.has(id)).forEach(id => ship(id, "SHIP", "reinforcement"));
    return { participants, capitalShipId: lineup.capitalShipId || null,
        benchShips: (lineup.reinforcementIds || []).filter(id => !participating.has(id)),
        attribution: { complete, provenance, pilotsComplete,
            reinforcementParticipationKnown: (lineup.reinforcementIds || []).every(id => participating.has(id)) } };
}

function validateActualUsageLineup(lineup, mode, event = null) {
    if (!isPlainObject(lineup)) return { valid: false, complete: false, characterIds: [] };
    const typeOf = id => characterDefinitions[id]?.unitType || event?.participants.find(p => p.unitId === id)?.unitType ||
        (event?.benchShips?.includes(id) ? "SHIP" : null);
    const validIds = (ids, type) => Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0 && typeOf(id) === type);
    if (mode !== "FLEET") {
        const ids = lineup.characterIds || [];
        const size = mode === "3v3" ? 3 : 5;
        return { valid: validIds(ids, "CHARACTER") && ids.length <= size && new Set(ids).size === ids.length &&
            (lineup.intentionalUndersize === undefined || typeof lineup.intentionalUndersize === "boolean") &&
            lineup.capitalShipId === undefined && lineup.startingShipIds === undefined && lineup.reinforcementIds === undefined,
            complete: ids.length === size || ids.length > 0 && lineup.intentionalUndersize === true, characterIds: ids };
    }
    const starters = lineup.startingShipIds || [], reinforcements = lineup.reinforcementIds || [],
        participating = lineup.participatingReinforcementIds || [], capital = lineup.capitalShipId || "";
    if (!Array.isArray(starters) || !Array.isArray(reinforcements) || !Array.isArray(participating) ||
        (lineup.capitalShipId !== undefined && typeof lineup.capitalShipId !== "string")) return { valid: false, complete: false, characterIds: [] };
    const ids = [capital, ...starters, ...reinforcements].filter(Boolean);
    return { valid: (!capital || typeOf(capital) === "CAPITAL_SHIP") && validIds(starters, "SHIP") && starters.length <= 3 &&
        validIds(reinforcements, "SHIP") && reinforcements.length <= 4 && new Set(ids).size === ids.length &&
        Array.isArray(participating) && new Set(participating).size === participating.length && participating.every(id => reinforcements.includes(id)) &&
        lineup.characterIds === undefined && lineup.intentionalUndersize === undefined,
        complete: !!capital && starters.length === 3, characterIds: ids };
}

function validAttackFleetLineup(lineup, requireComplete = true, event = null) {
    const validation = validateActualUsageLineup(lineup, "FLEET", event);
    return validation.valid && (!requireComplete || validation.complete);
}

function saveAttackFleetLineup(counterId, lineup) {
    const fleetCounter = (counterDefinitions[counterId]?.required || []).some(id => characterDefinitions[id]?.unitType === "CAPITAL_SHIP") ||
        Object.values(gacData.FLEET || {}).some(counters => Array.isArray(counters) && counters.some(c => c.counterId === counterId));
    if (!usageHistoryWritable || !counterDefinitions[counterId] || !fleetCounter || !validAttackFleetLineup(lineup)) return false;
    const next = { schema: 1, capitalShipId: lineup.capitalShipId,
        startingShipIds: [...lineup.startingShipIds], reinforcementIds: [...(lineup.reinforcementIds || [])] };
    const previous = usageHistory.attackFleetLineups || {};
    usageHistory.attackFleetLineups = { ...previous, [counterId]: next };
    if (saveUsageHistory()) return true;
    usageHistory.attackFleetLineups = previous;
    return false;
}

function automaticAttackUsageFacts(counterId, mode) {
    const def = counterDefinitions[counterId];
    const required = [...new Set(def && Array.isArray(def.required) ? def.required : [])];
    if (mode === "FLEET") {
        const saved = (usageHistory.attackFleetLineups || {})[counterId];
        if (saved && validAttackFleetLineup(saved)) return fleetUsageFacts(saved, "saved-attack-fleet", true);
        const capitals = required.filter(id => characterDefinitions[id]?.unitType === "CAPITAL_SHIP");
        return fleetUsageFacts({ capitalShipId: capitals.length === 1 ? capitals[0] : "", startingShipIds: [], reinforcementIds: [] }, "catalogue-required-capital", false);
    }
    const known = required.filter(id => characterDefinitions[id]?.unitType === "CHARACTER");
    const ids = required.length <= (mode === "3v3" ? 3 : 5) ? known : [];
    return { participants: ids.map(unitId => ({ unitId, unitType: "CHARACTER", role: "member" })),
        attribution: { complete: false, provenance: ids.length ? "catalogue-required-core" : "actual-lineup-unknown" } };
}

function correctUsageLineup(eventId, lineup, options = { complete: true }) {
    const event = usageHistory.events.find(e => e.id === eventId);
    if (!usageHistoryWritable || !event || event.voided || !lineup || typeof options.complete !== "boolean") return false;
    let facts;
    if (event.mode === "FLEET") {
        if (!validAttackFleetLineup(lineup, options.complete, event)) return false;
        facts = fleetUsageFacts(lineup, "player-correction", options.complete);
    } else {
        const validation = validateActualUsageLineup(lineup, event.mode, event);
        if (!validation.valid || (options.complete && !validation.complete)) return false;
        facts = { participants: validation.characterIds.map(unitId => ({ unitId, unitType: "CHARACTER", role: "member" })),
            attribution: { complete: options.complete, provenance: "player-correction" } };
    }
    const previousEvents = [...usageHistory.events];
    const change = writeUsageEvent({ ...event, ...facts }, false);
    if (!change) return false;
    if (saveUsageHistory()) return true;
    usageHistory.events = previousEvents;
    return false;
}

let usageLineupEditor = null;
let usageCorrectionMessage = "";

function openUsageEventEditor(index) {
    const event = usageHistory.events[index];
    if (!event || event.voided) return;
    const participants = event.participants;
    const lineup = event.mode === "FLEET" ? {
        capitalShipId: participants.find(p => p.unitType === "CAPITAL_SHIP")?.unitId || "",
        startingShipIds: participants.filter(p => p.role === "starter").map(p => p.unitId),
        reinforcementIds: [...new Set([...participants.filter(p => p.role === "reinforcement").map(p => p.unitId), ...(event.benchShips || [])])],
        participatingReinforcementIds: participants.filter(p => p.role === "reinforcement").map(p => p.unitId)
    } : { characterIds: participants.filter(p => p.unitType === "CHARACTER").map(p => p.unitId), intentionalUndersize: event.attribution.complete && participants.length < (event.mode === "3v3" ? 3 : 5) };
    usageLineupEditor = { eventId: event.id, mode: event.mode, lineup };
    usageCorrectionMessage = "";
    render();
}

function openAttackFleetEditor(counterId) {
    if (!counterId) { usageLineupEditor = null; render(); return; }
    const saved = (usageHistory.attackFleetLineups || {})[counterId];
    const requiredCapital = (counterDefinitions[counterId]?.required || []).find(id => characterDefinitions[id]?.unitType === "CAPITAL_SHIP");
    usageLineupEditor = { counterId, mode: "FLEET", lineup: saved ? JSON.parse(JSON.stringify(saved)) :
        { capitalShipId: requiredCapital || "", startingShipIds: [], reinforcementIds: [] } };
    usageCorrectionMessage = "";
    render();
}

function editUsageLineup(field, index, value) {
    if (!usageLineupEditor) return;
    const lineup = usageLineupEditor.lineup;
    if (field === "capitalShipId") lineup[field] = value;
    else if (field === "intentionalUndersize") lineup[field] = !!value;
    else {
        const ids = [...(lineup[field] || [])];
        ids[index] = value;
        lineup[field] = ids.filter(Boolean);
        if (field === "reinforcementIds") lineup.participatingReinforcementIds = (lineup.participatingReinforcementIds || []).filter(id => lineup.reinforcementIds.includes(id));
    }
    render();
}

function toggleUsageReinforcement(id, checked) {
    if (!usageLineupEditor || !(usageLineupEditor.lineup.reinforcementIds || []).includes(id)) return;
    const ids = new Set(usageLineupEditor.lineup.participatingReinforcementIds || []);
    if (checked) ids.add(id); else ids.delete(id);
    usageLineupEditor.lineup.participatingReinforcementIds = [...ids];
    render();
}

function saveUsageLineupEditor(complete = true) {
    const editor = usageLineupEditor;
    if (!editor) return false;
    const ok = editor.counterId ? saveAttackFleetLineup(editor.counterId, editor.lineup) : correctUsageLineup(editor.eventId, editor.lineup, { complete });
    usageCorrectionMessage = ok ? "Usage lineup saved. Existing battle results and round planning stay as recorded." : "Check unit types, duplicate selections and lineup size. To record a partial lineup, use Save known members.";
    if (ok) usageLineupEditor = null;
    render();
    return ok;
}

function renderUsageUnitSelect(field, index, unitType, selected, label) {
    const units = Object.entries(characterDefinitions).filter(([, unit]) => unit?.unitType === unitType)
        .sort(([a], [b]) => getCharacterName(a).localeCompare(getCharacterName(b)));
    return `<label class="lineup-field">${label}<select class="board-team-select" onchange="editUsageLineup('${field}', ${index}, this.value)">
        <option value="">Unknown / empty</option>${selected && !characterDefinitions[selected] ? `<option selected value="${escapeHtml(selected)}">${escapeHtml(selected)} (saved; not in catalogue)</option>` : ""}
        ${units.map(([id]) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(getCharacterName(id))}</option>`).join("")}</select></label>`;
}

function renderUsageLineupEditor() {
    if (!usageLineupEditor) return "";
    const { mode, lineup, counterId } = usageLineupEditor;
    let fields = "";
    if (mode === "FLEET") {
        fields = renderUsageUnitSelect("capitalShipId", 0, "CAPITAL_SHIP", lineup.capitalShipId, "Capital ship") +
            Array.from({ length: 3 }, (_, i) => renderUsageUnitSelect("startingShipIds", i, "SHIP", (lineup.startingShipIds || [])[i], `Starter ${i + 1}`)).join("") +
            Array.from({ length: 4 }, (_, i) => renderUsageUnitSelect("reinforcementIds", i, "SHIP", (lineup.reinforcementIds || [])[i], `Reinforcement ${i + 1} (optional)`)).join("");
        if (!counterId) fields += (lineup.reinforcementIds || []).map((id, i) => `<label class="roster-import-helper"><input type="checkbox" ${(lineup.participatingReinforcementIds || []).includes(id) ? "checked" : ""} onchange="toggleUsageReinforcement(usageLineupEditor.lineup.reinforcementIds[${i}], this.checked)"> ${escapeHtml(getCharacterName(id))} actually participated</label>`).join("");
        fields += '<p class="roster-import-helper">Capital and starter crews count automatically. Reinforcements and their crews count only when actual participation is ticked for a recorded event.</p>';
    } else {
        fields = Array.from({ length: mode === "3v3" ? 3 : 5 }, (_, i) => renderUsageUnitSelect("characterIds", i, "CHARACTER", (lineup.characterIds || [])[i], `Member ${i + 1}`)).join("") +
            `<label class="roster-import-helper"><input type="checkbox" ${lineup.intentionalUndersize ? "checked" : ""} onchange="editUsageLineup('intentionalUndersize', 0, this.checked)"> Intentionally undersized actual squad</label>`;
    }
    return `<div class="round-card"><div class="round-title">${counterId ? "Reusable attacking fleet" : "Correct actual usage lineup"}</div>
        <p class="roster-import-helper">${counterId ? "Used for future battles with this counter. Saving does not change past events or defence templates." : "Changes this history event only. It does not change used status, availability, saved templates or scores."}</p>
        ${fields}<div class="roster-data-actions"><button class="roster-data-btn" onclick="saveUsageLineupEditor(true)">${counterId ? "Save attacking fleet" : "Confirm actual lineup"}</button>
        ${counterId ? "" : '<button class="roster-data-btn" onclick="saveUsageLineupEditor(false)">Save known members</button>'}
        <button class="roster-data-btn" onclick="usageLineupEditor=null; render()">Cancel</button></div></div>`;
}

function renderUsageCorrections() {
    const fleetCounters = [...new Set([
        ...Object.keys(counterDefinitions).filter(id => (counterDefinitions[id]?.required || []).some(unitId => characterDefinitions[unitId]?.unitType === "CAPITAL_SHIP")),
        ...Object.keys(usageHistory.attackFleetLineups || {})
    ])].sort((a, b) => getCounterName(a).localeCompare(getCounterName(b)));
    return `${usageCorrectionMessage ? `<div class="roster-msg" role="status">${escapeHtml(usageCorrectionMessage)}</div>` : ""}${renderUsageLineupEditor()}
        <details class="round-card"><summary>Reusable attacking fleets</summary><p class="roster-import-helper">Associate a capital ship, three starters and optional bench with a fleet counter. No changes to historical events.</p>
        <label class="lineup-field">Fleet counter<select class="board-team-select" onchange="openAttackFleetEditor(this.value)"><option value="">Select counter…</option>${fleetCounters.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(getCounterName(id))}</option>`).join("")}</select></label>
        ${fleetCounters.length ? "" : '<p class="roster-import-helper">Fleet counter data is not available yet.</p>'}</details>
        <details class="round-card"><summary>Correct recorded lineups</summary><p class="roster-import-helper">Optional corrections for known members, flex choices and actual fleet reinforcements. One event remains one use. Attack results stay as recorded.</p>
        ${usageHistory.events.map((event, index) => ({ event, index })).filter(({ event }) => !event.voided).reverse().map(({ event, index }) => `<div class="lineup-team"><div>${escapeHtml(event.counterId ? getCounterName(event.counterId) : event.identity || "Unattributed slot")} · ${escapeHtml(event.mode)} · ${event.side === "attack" ? "Attack" : "Defence"}</div>
        <div class="roster-saved-line">${escapeHtml(event.seasonId || "Unknown season")} · ${escapeHtml(event.roundId)} · ${event.attribution.complete ? "Lineup confirmed" : "Partial / unknown lineup"}</div>
        <button class="roster-data-btn" onclick="openUsageEventEditor(${index})">Correct actual lineup</button></div>`).join("") || '<p class="roster-import-helper">No recorded events to correct.</p>'}</details>`;
}

// ─── BANNER SCORING ENGINE (v2.6) ─────────────────────────────────────────────
// Turns the GAC_Scoring rows into a "banners still available" figure for a board.
// Everything reads from the scoring data through one lookup, so any correction
// after a real-battle spot-check is a sheet edit with no code change. The board
// walker is deliberately side-agnostic: Opponent Board yields the player's
// remaining offence and My Board yields the opponent's remaining offence.

// Normalise one scoring row's field names. scoringRules has never been consumed
// before, so we don't assume whether the Apps Script emits camelCase (ruleId),
// snake_case (rule_id), or the raw sheet headers (Rule_ID) — we accept all three.
function readScoringRow(r) {
    const ruleId     = r.ruleId     ?? r.rule_id     ?? r.Rule_ID     ?? r.RuleID;
    const battleType = r.battleType ?? r.battle_type ?? r.Battle_Type ?? r.BattleType;
    const mode       = r.mode       ?? r.Mode;
    const value      = r.value      ?? r.Value;
    return {
        ruleId:     ruleId     != null ? String(ruleId)     : "",
        battleType: battleType != null ? String(battleType) : "ANY",
        mode:       mode       != null ? String(mode)       : "ANY",
        value:      Number(value) || 0
    };
}

// Look up one banner value. battleType is SQUAD | FLEET; mode is 5v5 | 3v3 | ANY.
// ANY in the data is a wildcard; when several rows match, the most specific wins
// (an exact battleType and mode beats an ANY on either axis). Returns 0 if no row
// matches — a missing rule contributes nothing rather than throwing.
function scoreRule(ruleId, battleType, mode) {
    const best = findScoringRow(scoringRules, ruleId, battleType, mode);
    return best ? best.value : 0;
}

// The most specific matching scoring row, or null when none is authored. Callers
// that must not mistake a missing rule for zero (the Last Battle engine) use this
// directly.
function findScoringRow(rows, ruleId, battleType, mode) {
    let best = null, bestSpecificity = -1;
    for (const raw of rows || []) {
        const row = readScoringRow(raw);
        if (row.ruleId !== ruleId) continue;
        if (row.battleType !== battleType && row.battleType !== "ANY") continue;
        if (row.mode !== mode && row.mode !== "ANY") continue;
        const specificity = (row.battleType === battleType ? 1 : 0) +
                            (row.mode === mode ? 1 : 0);
        if (specificity > bestSpecificity) { best = row; bestSpecificity = specificity; }
    }
    return best;
}

// New-round score prefilling is intentionally stricter than ordinary scoring
// lookup. A missing battle rule can safely contribute zero to a projection, but
// silently treating SETTING_DEFENCE as zero would write wrong live scores. Require
// exactly one globally applicable, finite, positive authored row before setup.
function settingDefenceRule() {
    const matches = scoringRules.map(readScoringRow).filter(r =>
        r.ruleId === "SETTING_DEFENCE" && r.battleType === "ANY" && r.mode === "ANY"
    );
    if (matches.length !== 1 || !Number.isFinite(matches[0].value) || matches[0].value <= 0) {
        return {
            ok: false,
            value: 0,
            message: "The SETTING_DEFENCE scoring rule is missing or invalid. Refresh the scoring data before setting up a new round."
        };
    }
    return { ok: true, value: matches[0].value, message: "" };
}

// How many of YOUR units earn per-unit survival bonuses in a clean win, and how
// many ENEMY units you defeat. Equal for squads (5/5, 3/3); for a full fleet both
// are 7 (capital + 6 on each side) — confirmed against the SWGOH Wiki "Fleet Max
// Banners" table, where a flawless first-attempt 7-ship win banks 73. Sourced from
// the OWN_UNITS / ENEMY_UNITS scoring rows if present; falls back to these known
// values so the calculation is correct even before those rows are added to the
// sheet. The fallbacks are the single place any unit count is hard-coded.
function ownUnitCount(battleType, mode) {
    const fromData = scoreRule("OWN_UNITS", battleType, mode);
    if (fromData > 0) return fromData;
    if (battleType === "FLEET") return 7;
    return mode === "3v3" ? 3 : 5;
}

function enemyUnitCount(battleType, mode) {
    const fromData = scoreRule("ENEMY_UNITS", battleType, mode);
    if (fromData > 0) return fromData;
    if (battleType === "FLEET") return 7;
    return mode === "3v3" ? 3 : 5;
}

// Best-case banners for a single battle against a defence team, given how many
// battles have already been fought against it (its in-game "Battles" count). A
// clean win: every own unit survives at full health and protection, every enemy
// is defeated. The attempt bonus is chosen from the battles-so-far count — the
// NEXT battle is the (count+1)-th: 0 → first attempt, 1 → second, 2+ → none.
function battleBestCase(battleType, mode, battlesSoFar) {
    const own   = ownUnitCount(battleType, mode);
    const enemy = enemyUnitCount(battleType, mode);
    const nextAttempt = (battlesSoFar || 0) + 1;

    let p = scoreRule("VICTORY", battleType, mode);
    if (nextAttempt === 1)      p += scoreRule("FIRST_ATTEMPT",  battleType, mode);
    else if (nextAttempt === 2) p += scoreRule("SECOND_ATTEMPT", battleType, mode);
    // third-or-later: no attempt bonus.

    p += own   * scoreRule("SURVIVING_UNIT",       battleType, mode);
    p += own   * scoreRule("FULL_HEALTH_UNIT",     battleType, mode);
    p += own   * scoreRule("FULL_PROTECTION_UNIT", battleType, mode);
    p += enemy * scoreRule("DEFEATED_ENEMY",       battleType, mode);
    return p;
}

// Walk a board and total the theoretical maximum banners still bankable from it —
// the ceiling if every remaining team is cleared perfectly. Counts EVERY uncleared slot in
// EVERY territory, named or not, LOCKED OR NOT — banner value depends only on battle
// type and mode, never on which team occupies the slot. A territory that still has
// any uncleared team also yields its clear bonus (base + per-team).
//
// Locked back territories ARE included (v2.9 fix): this figure answers "what is the
// most I could still bank, assuming I clear my way through the whole board", which
// is what points-to-win and the can-I-still-win verdict both need. Counting only
// currently-reachable territories understated the ceiling to zero on a fresh board
// (both backs locked), producing a false "can't win". The lock gate still governs
// what the allocation engine and board rendering act on — only this scoring walk
// ignores it, because a locked territory will become reachable once its front falls.
function remainingBannersForBoard(bd, opts) {
    opts = opts || {};
    if (!bd) return 0;
    let total = 0;

    bd.territories.forEach(tDef => {
        const battleType = tDef.type;                          // SQUAD | FLEET
        const mode       = battleType === "FLEET" ? "ANY" : bd.mode;
        const teams      = bd.teams.filter(t => t.territory === tDef.territory);

        let anyUncleared = false;
        teams.forEach(team => {
            if (team.cleared) return;
            anyUncleared = true;
            total += battleBestCase(battleType, mode, team.attempts);
        });

        if (anyUncleared) {
            total += scoreRule("TERRITORY_CLEAR_BASE", battleType, mode);
            total += teams.length * scoreRule("TERRITORY_CLEAR_PER_TEAM", battleType, mode);
        }
    });

    // One-off first-attack bonus for the round's opening battle, if not yet spent.
    if (opts.firstAttackAvailable) total += scoreRule("FIRST_ATTACK", "ANY", bd.mode);

    return total;
}

// Has the round's first battle been fought yet? (v3.1) Derived from the board and
// used-team state, never stored — there is no "first attack spent" flag to keep in
// sync, and no way for it to drift from reality.
//
// Three independent signals, any one of which means an attack has happened:
//   • a counter has been marked used — the units are spent, so a battle was fought
//     (or forfeited, which spends the bonus just the same);
//   • a team's Battles count is above zero — the in-game counter has moved;
//   • a team is marked cleared — you cannot clear a team without attacking it, and
//     this catches the case where a team is cleared without touching its stepper.
//
// Deliberately LIVE rather than sticky: correcting a mis-tapped Battles count back
// to zero restores the opening state, which is right, because no attack happened.
// Marking a counter used has no undo anywhere in the app, so that one is effectively
// one-way for the round — it costs an advisory line, not any state.
function isFirstAttackAvailable() {
    if (!board) return false;
    if (usedTeams.length > 0) return false;
    return board.teams.every(t => !t.cleared && !(Number(t.attempts) > 0));
}

function isOpponentFirstAttackAvailable() {
    if (!myBoard || bannerData.oppFinal === true) return false;
    return myBoard.teams.every(t => !t.cleared && !(Number(t.attempts) > 0));
}

// The calculated "remaining available banners" for the live opponent board.
// Zero when there is no board. This is what the banner tracking section shows by
// default, and what a manual override is measured against.
//
// v3.1: the one-off FIRST_ATTACK bonus is now included while the round's opening
// battle is still unfought. The walker has always accepted this flag; nothing ever
// passed it, so a fresh board understated its own ceiling by exactly that bonus and
// both points-to-win and the can-I-still-win verdict read pessimistically at the
// very moment the player is deciding how hard to fight.
function calculatedRemaining() {
    if (!board) return 0;
    return remainingBannersForBoard(board, { firstAttackAvailable: isFirstAttackAvailable() });
}

function calculatedOpponentRemaining() {
    if (!myBoard || bannerData.oppFinal === true) return 0;
    return remainingBannersForBoard(myBoard, { firstAttackAvailable: isOpponentFirstAttackAvailable() });
}

// ─── LAST BATTLE ENGINE ───────────────────────────────────────────────────────
// When exactly one uncleared defence remains on Opponent Board, turn "points to
// win" into the battle banners that final battle must bank, and — where the
// scoring is validated — the end-of-battle conditions that bank them.
//
// Pure and advisory: every function here derives from its arguments (or, for the
// adapter at the end, from live board/score state) and returns a fresh object. It
// never persists anything, mutates the board or scores, or marks counters used.
// All banner values come from the same authored scoring rows as the remaining-
// banner walker; there are no second constants. A rule that is missing makes the
// result "cannot calculate", never a confident zero.
//
// Result shape (lastBattleAdvice):
//   status        "ready" | "notLastBattle" | "noBoard" | "cannotCalculate"
//   reasons       [{ code, message }] — why the result is not exact (or not ready)
//   confidence    "exact" | "bounded"   (ready only)
//   target        { territory, index, name, customName, battleType, roundMode,
//                   formatLabel, attempts, attemptNumber, teamsInTerritory }
//   scores        { my, opp, oppFinal }
//   targetToBeatCurrent   banners needed to finish strictly above opp (≥ 0)
//   bonusesOnClear        { territoryClear, firstAttack, total } — banked by the
//                         clear itself, never already in myScore
//   battleTarget          battle banners still needed after those bonuses (≥ 0)
//   verdict       "alreadyAhead" | "coveredByClear" | "anyWin" | "needsBattle"
//                 | "uncertain" | "impossible"; aheadOf "final" | "current" | null
//   ceilings      { minWin, fullSquad, max, theoreticalMax } per-battle, each
//                 { low, high }; max counts only empty slots confirmed to score,
//                 theoreticalMax every formation; nextAttemptMax — best possible
//                 if this battle is lost
//   formations    [{ fielded, fieldedLow, emptySlots, maxLow, maxHigh,
//                    allowanceLow, allowanceHigh, unitsCanLose, flawlessRequired,
//                    meets, mathematicalOnly, slotRuleConfirmed }]
//   fleetCapacity { capital, eligible, confirmedEmpty }  — fleet only
//   counters      [{ counterId, tier, bannerScore, undersize, expected,
//                    expectedMeets, documentedDrop, available }]  — when supplied
//   needsInput    e.g. ["enemiesRemaining", "fleetCapital"] when an input would
//                 make it exact

// Fleet slot model (issue #86; evidence in docs/CATALOGUE_SOURCE.md "Fleet slot
// rules"). The OWN_UNITS scoring slots are the starting slots plus the
// reinforcement slots; the capital ship earns no per-unit banners. The 4th
// reinforcement slot is locked unless the attacking capital ship is 7★, and a
// locked slot earns nothing. An empty UNLOCKED reinforcement slot earns
// UNUSED_SLOT; whether an empty starting slot (or an unsummoned reinforcement)
// scores is unconfirmed, so formations that need one are theoretical only.
const FLEET_STARTING_SLOTS = 3;
const FLEET_SLOTS_LOCKED_BELOW_7_STAR = 1;

// The attacker's scoring slots by capital-ship stars: "7", "5-6", or anything
// else for not known. eligible lists the possible slot counts (both when the
// stars are not known); confirmedEmpty is how many slots can be left empty with
// the unused-slot bonus confirmed under every possible count — unlocked
// reinforcement slots only.
function fleetSlotCapacity(ownUnits, capital) {
    const reduced = ownUnits - FLEET_SLOTS_LOCKED_BELOW_7_STAR;
    const known = capital === "7" || capital === "5-6";
    const eligible = capital === "7" ? [ownUnits] : capital === "5-6" ? [reduced] : [reduced, ownUnits];
    return {
        capital: known ? capital : null,
        eligible,
        confirmedEmpty: Math.max(0, Math.min(...eligible) - FLEET_STARTING_SLOTS)
    };
}

const LAST_BATTLE_REQUIRED_RULES = ["VICTORY", "FIRST_ATTEMPT", "SECOND_ATTEMPT",
    "SURVIVING_UNIT", "FULL_HEALTH_UNIT", "FULL_PROTECTION_UNIT", "UNUSED_SLOT",
    "DEFEATED_ENEMY", "TERRITORY_CLEAR_BASE", "TERRITORY_CLEAR_PER_TEAM"];

// The scoring rules one battle type/format needs, or { ok: false, missing } if any
// is not authored. Unit counts use the same OWN_UNITS / ENEMY_UNITS resolution as
// battleBestCase.
function battleScoringRules(battleType, mode, rows) {
    const src = rows || scoringRules;
    const missing = [];
    const v = {};
    LAST_BATTLE_REQUIRED_RULES.forEach(id => {
        const row = findScoringRow(src, id, battleType, mode);
        if (!row || !Number.isFinite(row.value)) missing.push(id);
        else v[id] = row.value;
    });
    const firstAttackRow = findScoringRow(src, "FIRST_ATTACK", "ANY", mode);
    if (missing.length) return { ok: false, missing };
    const own = findScoringRow(src, "OWN_UNITS", battleType, mode);
    const enemy = findScoringRow(src, "ENEMY_UNITS", battleType, mode);
    const fallback = battleType === "FLEET" ? 7 : (mode === "3v3" ? 3 : 5);
    return {
        ok: true,
        battleType, mode,
        victory: v.VICTORY,
        attemptBonus: [v.FIRST_ATTEMPT, v.SECOND_ATTEMPT, 0],
        perUnit: { surviving: v.SURVIVING_UNIT, fullHealth: v.FULL_HEALTH_UNIT, fullProtection: v.FULL_PROTECTION_UNIT },
        unitCost: v.SURVIVING_UNIT + v.FULL_HEALTH_UNIT + v.FULL_PROTECTION_UNIT,
        unusedSlot: v.UNUSED_SLOT,
        defeatedEnemy: v.DEFEATED_ENEMY,
        ownUnits: own && own.value > 0 ? own.value : fallback,
        enemyUnits: enemy && enemy.value > 0 ? enemy.value : fallback,
        clearBase: v.TERRITORY_CLEAR_BASE,
        clearPerTeam: v.TERRITORY_CLEAR_PER_TEAM,
        firstAttack: firstAttackRow && Number.isFinite(firstAttackRow.value) ? firstAttackRow.value : null
    };
}

function attemptBonusFor(rules, attempts) {
    const n = Math.max(0, Math.floor(Number(attempts) || 0));
    return rules.attemptBonus[Math.min(n, 2)];
}

function isWholeCount(n) {
    return Number.isInteger(n) && n >= 0;
}

// Banners for one WON battle, from what is on the field at its end. Returns
// { ok, total, breakdown } or { ok: false, errors }. Invariants: at least one unit
// fielded and alive (you cannot win with none); full-health and full-protection
// units are survivors; unused slots are only the slots not fielded.
function battleScore(rules, outcome) {
    const o = outcome || {};
    const errors = [];
    const fields = ["attempts", "fielded", "survivors", "fullHealth", "fullProtection", "unusedSlots", "enemiesDefeated"];
    fields.forEach(f => { if (!isWholeCount(o[f])) errors.push(`${f} must be a whole number ≥ 0`); });
    if (!errors.length) {
        if (o.fielded < 1 || o.fielded > rules.ownUnits) errors.push(`fielded must be 1–${rules.ownUnits}`);
        if (o.survivors < 1) errors.push("a won battle has at least one survivor");
        if (o.survivors > o.fielded) errors.push("survivors cannot exceed fielded units");
        if (o.fullHealth > o.survivors) errors.push("full-health units cannot exceed survivors");
        if (o.fullProtection > o.survivors) errors.push("full-protection units cannot exceed survivors");
        if (o.unusedSlots > rules.ownUnits - o.fielded) errors.push("unused slots cannot exceed slots not fielded");
        if (o.enemiesDefeated < 1 || o.enemiesDefeated > rules.enemyUnits) errors.push(`enemies defeated must be 1–${rules.enemyUnits}`);
    }
    if (errors.length) return { ok: false, errors };
    const breakdown = {
        victory: rules.victory,
        attempt: attemptBonusFor(rules, o.attempts),
        surviving: o.survivors * rules.perUnit.surviving,
        fullHealth: o.fullHealth * rules.perUnit.fullHealth,
        fullProtection: o.fullProtection * rules.perUnit.fullProtection,
        unusedSlots: o.unusedSlots * rules.unusedSlot,
        defeated: o.enemiesDefeated * rules.defeatedEnemy
    };
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    return { ok: true, total, breakdown };
}

// Flawless total for a formation: every fielded unit survives at full health and
// protection, every other slot is a deliberately unused eligible slot.
function formationMax(rules, attempts, fielded, enemiesDefeated) {
    return battleScore(rules, {
        attempts, fielded, survivors: fielded, fullHealth: fielded, fullProtection: fielded,
        unusedSlots: rules.ownUnits - fielded, enemiesDefeated
    }).total;
}

// The lowest a win can score: one survivor, no health/protection bonuses, a full
// squad fielded (no unused-slot bonus).
function minimumWin(rules, attempts, enemiesDefeated) {
    return battleScore(rules, {
        attempts, fielded: rules.ownUnits, survivors: 1, fullHealth: 0, fullProtection: 0,
        unusedSlots: 0, enemiesDefeated
    }).total;
}

// Find the one uncleared defence on a board, or null.
function lastUnclearedTeam(bd) {
    if (!bd || !Array.isArray(bd.teams)) return null;
    const open = bd.teams.filter(t => !t.cleared);
    return open.length === 1 ? open[0] : null;
}

function validScore(n) {
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

// Core engine. input: { board, myScore, oppScore, oppFinal, firstAttackAvailable,
// rules?, enemiesRemaining?, fleetCapital?, counters? }. counters, when given, are
// the target's catalogued counters as { counterId, tier, bannerScore, undersize,
// available }. fleetCapital is the attacking capital ship's stars ("7" | "5-6").
function lastBattleAdvice(input) {
    const inp = input || {};
    const bd = inp.board;
    if (!bd || !Array.isArray(bd.teams) || !Array.isArray(bd.territories)) {
        return { status: "noBoard", reasons: [{ code: "NO_BOARD", message: "Set up the opponent board first." }] };
    }

    const my = inp.myScore, opp = inp.oppScore;
    const scoresOk = validScore(my) && validScore(opp);
    const targetToBeatCurrent = scoresOk ? Math.max(0, opp + 1 - my) : null;

    const uncleared = bd.teams.filter(t => !t.cleared).length;
    const team = lastUnclearedTeam(bd);
    if (!team) {
        return {
            status: "notLastBattle", unclearedCount: uncleared, targetToBeatCurrent,
            reasons: [{ code: uncleared === 0 ? "BOARD_CLEARED" : "SEVERAL_REMAIN",
                message: uncleared === 0 ? "Every defence is cleared." : `${uncleared} defences remain.` }]
        };
    }

    const tDef = bd.territories.find(t => t.territory === team.territory);
    const battleType = tDef && tDef.type === "FLEET" ? "FLEET" : "SQUAD";
    const scoringMode = battleType === "FLEET" ? "ANY" : bd.mode;
    const attempts = Math.max(0, Math.floor(Number(team.attempts) || 0));
    const teamsHere = bd.teams.filter(t => t.territory === team.territory).length;
    const target = {
        territory: team.territory, index: team.index,
        name: team.name || "", customName: team.customName || "",
        battleType, roundMode: bd.mode,
        formatLabel: battleType === "FLEET" ? "Fleet" : bd.mode,
        attempts, attemptNumber: attempts + 1, teamsInTerritory: teamsHere
    };
    const base = { target, scores: { my, opp, oppFinal: inp.oppFinal === true }, targetToBeatCurrent };

    if (!scoresOk) {
        return Object.assign(base, { status: "cannotCalculate",
            reasons: [{ code: "INVALID_SCORE", message: "Enter both scores as whole numbers of 0 or more." }] });
    }
    const rules = battleScoringRules(battleType, scoringMode, inp.rules);
    if (!rules.ok) {
        return Object.assign(base, { status: "cannotCalculate",
            reasons: [{ code: "MISSING_RULES", message: `Scoring rules missing: ${rules.missing.join(", ")}.` }] });
    }
    if (inp.firstAttackAvailable && rules.firstAttack === null) {
        return Object.assign(base, { status: "cannotCalculate",
            reasons: [{ code: "MISSING_RULES", message: "Scoring rules missing: FIRST_ATTACK." }] });
    }

    const reasons = [];
    const needsInput = [];
    let confidence = "exact";

    // Enemies this battle will defeat. A first attempt faces the full defence. A
    // repeat attempt may face survivors of earlier battles; without that input the
    // count is bounded, not known.
    let enemyLow = rules.enemyUnits, enemyHigh = rules.enemyUnits;
    if (attempts > 0) {
        const er = inp.enemiesRemaining;
        if (Number.isInteger(er) && er >= 1 && er <= rules.enemyUnits) {
            enemyLow = enemyHigh = er;
        } else {
            enemyLow = 1;
            confidence = "bounded";
            needsInput.push("enemiesRemaining");
            reasons.push({ code: "CLEANUP_ENEMIES_UNKNOWN",
                message: "Earlier battles may have defeated some enemies; enemy-defeat banners are bounded, not exact." });
        }
    }

    // Scoring slots. A squad has exactly ownUnits slots, every one of which may be
    // left empty for UNUSED_SLOT. A fleet's depends on the capital ship's stars
    // (fleetSlotCapacity); not knowing them gives both possible counts as a range.
    const fleet = battleType === "FLEET";
    const capacity = fleet ? fleetSlotCapacity(rules.ownUnits, inp.fleetCapital) : null;
    const caps = fleet ? capacity.eligible : [rules.ownUnits];
    const confirmedEmpty = fleet ? capacity.confirmedEmpty : rules.ownUnits - 1;
    if (fleet) {
        if (!capacity.capital) {
            if (confidence === "exact") confidence = "bounded";
            needsInput.push("fleetCapital");
            reasons.push({ code: "FLEET_CAPITAL_UNKNOWN",
                message: "Capital-ship stars not given: below 7★ the 4th reinforcement slot is locked, so fleet ceilings are ranges." });
        }
        reasons.push({ code: "FLEET_SLOTS_UNCONFIRMED",
            message: "Empty starting slots and unsummoned reinforcements are not confirmed to score; formations relying on them are theoretical." });
    }

    const territoryClear = rules.clearBase + teamsHere * rules.clearPerTeam;
    const firstAttack = inp.firstAttackAvailable ? rules.firstAttack : 0;
    const bonusesOnClear = { territoryClear, firstAttack, total: territoryClear + firstAttack };
    const battleTarget = Math.max(0, targetToBeatCurrent - bonusesOnClear.total);

    const minWin = { low: minimumWin(rules, attempts, enemyLow), high: minimumWin(rules, attempts, enemyHigh) };

    // Flawless ceiling with `empty` slots deliberately left empty, across every
    // possible slot count: low is the worst case (fewest slots, fewest enemies),
    // high the best. A count with no unit left to field is skipped.
    const ceilingWith = (empty, att) => {
        const valid = caps.filter(c => c - empty >= 1);
        const at = (c, enemies) => formationMax(Object.assign({}, rules, { ownUnits: c }), att, c - empty, enemies);
        return {
            low: Math.min(...valid.map(c => at(c, enemyLow))),
            high: Math.max(...valid.map(c => at(c, enemyHigh))),
            fieldedLow: Math.min(...valid) - empty,
            fieldedHigh: Math.max(...valid) - empty
        };
    };

    // Formations by empty slots: the full line-up first, then each deliberate
    // drop (mathematical potential — the catalogue's undersize says whether a
    // counter actually wins that way). A fleet drop beyond the unlocked
    // reinforcement slots needs an empty starting slot, which is unconfirmed.
    const formations = Array.from({ length: Math.max(...caps) }, (_, empty) => {
        const c = ceilingWith(empty, attempts);
        const allowanceLow = c.low - battleTarget;
        const allowanceHigh = c.high - battleTarget;
        return {
            fielded: c.fieldedHigh, fieldedLow: c.fieldedLow, emptySlots: empty,
            maxLow: c.low, maxHigh: c.high, allowanceLow, allowanceHigh,
            // Units that may be lost while still meeting the target (conservative),
            // never all of them: a win needs a survivor.
            unitsCanLose: allowanceLow >= 0 ? Math.min(c.fieldedLow - 1, Math.floor(allowanceLow / rules.unitCost)) : null,
            flawlessRequired: allowanceLow === 0,
            meets: allowanceLow >= 0 ? "yes" : (allowanceHigh >= 0 ? "maybe" : "no"),
            mathematicalOnly: empty > 0,
            slotRuleConfirmed: empty <= confirmedEmpty
        };
    });
    const confirmed = formations.filter(f => f.slotRuleConfirmed);
    const max = {
        low: Math.max(...confirmed.map(f => f.maxLow)),
        high: Math.max(...confirmed.map(f => f.maxHigh))
    };
    const theoreticalMax = {
        low: Math.max(...formations.map(f => f.maxLow)),
        high: Math.max(...formations.map(f => f.maxHigh))
    };
    const fullSquad = { low: formations[0].maxLow, high: formations[0].maxHigh };
    // If this battle is lost, the best the next attempt could bank (optimistic:
    // no enemy assumed already defeated beyond what is known now, every formation).
    const nextAttemptMax = Math.max(...formations.map(f => ceilingWith(f.emptySlots, attempts + 1).high));

    let verdict;
    // Already past their entered score: say whether that is their final or only
    // their current score, since only the former settles the round. "impossible"
    // is only claimed above the theoretical maximum, so an unconfirmed fleet
    // formation can make a target uncertain but never falsely impossible.
    const aheadOf = my > opp ? (base.scores.oppFinal ? "final" : "current") : null;
    if (my > opp) verdict = "alreadyAhead";
    else if (battleTarget === 0) verdict = "coveredByClear";
    else if (battleTarget <= minWin.low) verdict = "anyWin";
    else if (battleTarget <= max.low) verdict = "needsBattle";
    else if (battleTarget <= theoreticalMax.high) verdict = "uncertain";
    else verdict = "impossible";

    if (!base.scores.oppFinal) {
        reasons.push({ code: "OPP_NOT_FINAL",
            message: "Target is against their current score; it may rise." });
    }

    // Counter options: bannerScore is a full-squad, first-attempt estimate; shift
    // it by the attempt-bonus difference for a repeat attempt. A fleet estimate
    // assumes a 7★ capital ship's full fleet, so a 5★–6★ capital loses the locked
    // slot's per-unit banners. Undersize is the catalogue's documented safe drop,
    // the only undersize the advisor treats as supported; for a fleet only once
    // the capital's stars are known, and only into unlocked reinforcement slots.
    const firstBonus = rules.attemptBonus[0];
    const lockedShift = fleet && capacity.capital ? -(rules.ownUnits - caps[0]) * rules.unitCost : 0;
    const counters = Array.isArray(inp.counters) ? inp.counters.map(c => {
        const banner = Number(c.bannerScore);
        const hasScore = Number.isFinite(banner) && banner > 0;
        const drop = Math.max(0, Math.floor(Number(c.undersize)) || 0);
        const documentedDrop = fleet && !capacity.capital ? 0 : Math.min(drop, confirmedEmpty);
        const shift = attemptBonusFor(rules, attempts) - firstBonus + lockedShift;
        const expected = hasScore ? banner + shift : null;
        return {
            counterId: c.counterId, name: c.name || c.counterId, tier: c.tier || "", available: c.available !== false,
            bannerScore: hasScore ? banner : null, undersize: drop,
            expected, documentedDrop,
            expectedWithDrop: hasScore ? banner + shift + documentedDrop : null,
            expectedMeets: hasScore ? (banner + shift >= battleTarget) : null,
            expectedWithDropMeets: hasScore ? (banner + shift + documentedDrop >= battleTarget) : null
        };
    }) : null;

    return Object.assign(base, {
        status: "ready", confidence, reasons, needsInput,
        bonusesOnClear, battleTarget, verdict, aheadOf,
        ceilings: { minWin, fullSquad, max, theoreticalMax, nextAttemptMax },
        formations, counters, fleetCapacity: capacity,
        unitCost: rules.unitCost, enemyUnits: rules.enemyUnits, ownUnits: rules.ownUnits,
        enemiesDefeated: { low: enemyLow, high: enemyHigh }
    });
}

// Tactical catalogue entries (issues #112/#115) carry a `role` instead of a tier,
// banner score and undersize: SETUP is a deliberate weakening battle that is not
// expected to win, CLEANUP is a win only against a defence an earlier battle has
// already weakened. Neither is a one-shot counter, so allocation, ranking and
// every banner projection use oneShotCounters(); only the Counters screen shows
// tactical entries, in their own section.
const TACTICAL_ROLES = { SETUP: "Setup", CLEANUP: "Cleanup" };

function isTacticalEntry(c) {
    return !!(c && c.role);
}

function oneShotCounters(list) {
    return (list || []).filter(c => !isTacticalEntry(c));
}

function tacticalEntries(list) {
    return (list || []).filter(c => isTacticalEntry(c) && TACTICAL_ROLES[c.role]);
}

// Live adapter: the engine over current Round state. Reads, never writes.
function currentLastBattleAdvice(extra) {
    const team = lastUnclearedTeam(board);
    let counters = null;
    if (team && team.name && team.name !== NOT_IN_CATALOGUE) {
        const tDef = board.territories.find(t => t.territory === team.territory);
        const modeKey = tDef ? territoryModeKey(tDef) : board.mode;
        const seen = new Set();
        counters = oneShotCounters(gacData[modeKey] && gacData[modeKey][team.name]).filter(c => {
            if (seen.has(c.counterId)) return false;
            seen.add(c.counterId);
            return true;
        }).map(c => ({
            counterId: c.counterId, name: c.counter, tier: c.tier, bannerScore: c.bannerScore, undersize: c.undersize,
            available: getCounterStatus(c.counterId) === "available"
        }));
    }
    return lastBattleAdvice(Object.assign({
        board,
        myScore: Number(bannerData.myScore),
        oppScore: Number(bannerData.oppScore),
        oppFinal: bannerData.oppFinal === true,
        firstAttackAvailable: isFirstAttackAvailable(),
        fleetCapital: lastBattleFleetCapital,
        counters
    }, extra || {}));
}

// ─── ALLOCATION ENGINE (SC-01) ────────────────────────────────────────────────
// Pure derivation from board + roster + used state. Recomputed on every Round
// render; nothing here is persisted. Exclusivity is enforced at two levels:
// a counter can be assigned to at most one team, and two counters that share
// a required character can never both appear in the same plan (characters used
// on offence are spent for the round).

function requiredChars(counterId) {
    const def = counterDefinitions[counterId];
    return (def && def.required) || [];
}

// Strategic reserve (v3.6): a counter definition authored with
// `strategicReserve: true` (Counter_Definitions' optional Strategic_Reserve
// column — see docs/SPEC.md §4.1) is a premium/flexible attacking resource worth
// preserving while the opponent's board is still partially hidden — e.g. Darth
// Bane. Absence reads as Normal, so older catalogue entries are unaffected.
// This is a property of the counter DEFINITION, not of the character: the same
// character in a different composition is unaffected unless that definition is
// separately marked.
function isHighReserve(counterId) {
    const def = counterDefinitions[counterId];
    return !!(def && def.strategicReserve);
}

// A High-reserve counter is ranked as if it were one tier weaker while hidden
// zones remain (see roundHasHiddenZones), so an adequate non-reserve counter of
// the same or an adjacent tier is preferred, but a reserve counter still beats
// alternatives more than one tier behind it. This is a mild, single-step penalty,
// not an override: it can never make a reserve counter lose to something more
// than one tier worse, and it does nothing at all once reserveActive is false.
const RESERVE_TIER_PENALTY = 1;

function effectiveTierRank(counter, reserveActive) {
    const base = tierSortValue(counter.tier);
    return (reserveActive && isHighReserve(counter.counterId)) ? base + RESERVE_TIER_PENALTY : base;
}

// Every visible, uncleared, named board team plus its catalogue and available
// counters. candidateStates is deliberately fully materialised here so the
// visible-board scarcity pass below is a pure derivation: it does not need to
// consult roster, used-team or defence state itself.
function buildEligibleTeams() {
    const eligible = [];
    if (!board) return eligible;

    board.territories.forEach(tDef => {
        if (!isTerritoryUnlocked(tDef)) return;

        const modeKey = territoryModeKey(tDef);

        teamsInTerritory(tDef.territory).forEach(team => {
            if (team.cleared) return;
            if (!team.name) return;                       // nothing selected yet

            const key = tDef.territory + ":" + team.index;

            if (team.name === NOT_IN_CATALOGUE) {
                eligible.push({ key, territory: tDef.territory, index: team.index,
                                name: null, modeKey, custom: true, candidates: [] });
                return;
            }

            const all = oneShotCounters(gacData[modeKey] && gacData[modeKey][team.name]);
            const seen = new Set();
            const candidates = [];
            const candidateStates = [];
            const defenceBlocked = [];
            all.forEach(c => {
                if (seen.has(c.counterId)) return;
                seen.add(c.counterId);
                const status = getCounterStatus(c.counterId);
                const ownership = getOwnership(c.counterId);
                candidateStates.push({
                    counterId: c.counterId,
                    counter: c.counter,
                    tier: c.tier,
                    requiredCharacters: requiredChars(c.counterId).slice(),
                    owned: ownership.owned,
                    status,
                    fieldable: status === "available"
                });
                if (status === "available") candidates.push(c);
                if (status === "on-defence") defenceBlocked.push(c);
            });

            eligible.push({ key, territory: tDef.territory, index: team.index,
                            name: team.name, modeKey, custom: false, candidates,
                            candidateStates, defenceBlocked });
        });
    });

    return eligible;
}

// Pure, deterministic description of the real choices on the visible board.
// Direct conflicts name a reused counter identity or shared required character;
// resourceGroups close that graph transitively, so SEE and Bane are not reported
// as two independent fallback routes when SEE_BANE connects both of them.
function assessVisibleBoardScarcity(eligible) {
    const teams = eligible.filter(t => !t.custom && t.name).map(t => ({
        defenceId: t.key,
        defenceName: t.name,
        mode: t.modeKey,
        custom: t.custom,
        candidates: (t.candidateStates || []).map(c => ({
            counterId: c.counterId,
            tier: c.tier,
            requiredCharacters: c.requiredCharacters.slice(),
            owned: c.owned,
            fieldable: c.fieldable,
            status: c.status
        }))
    }));

    const uses = new Map();
    teams.forEach(t => t.candidates.filter(c => c.fieldable).forEach(c => {
        if (!uses.has(c.counterId)) {
            uses.set(c.counterId, {
                counterId: c.counterId,
                requiredCharacters: c.requiredCharacters.slice(),
                defences: []
            });
        }
        uses.get(c.counterId).defences.push({ defenceId: t.defenceId, tier: c.tier });
    }));

    const identities = [...uses.values()].sort((a, b) => a.counterId.localeCompare(b.counterId));
    identities.forEach(identity => identity.defences.sort((a, b) => a.defenceId.localeCompare(b.defenceId)));
    const directConflicts = [];
    const parent = new Map(identities.map(identity => [identity.counterId, identity.counterId]));
    const find = id => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(id) !== id) {
            const next = parent.get(id);
            parent.set(id, root);
            id = next;
        }
        return root;
    };
    const unite = (a, b) => {
        const ar = find(a);
        const br = find(b);
        if (ar === br) return;
        if (ar < br) parent.set(br, ar);
        else parent.set(ar, br);
    };

    identities.forEach(identity => {
        const defenceIds = [...new Set(identity.defences.map(d => d.defenceId))];
        if (defenceIds.length > 1) {
            directConflicts.push({
                type: "counter-identity",
                counterIds: [identity.counterId],
                requiredCharacters: identity.requiredCharacters.slice(),
                defenceIds
            });
        }
    });

    for (let i = 0; i < identities.length; i++) {
        for (let j = i + 1; j < identities.length; j++) {
            const a = identities[i];
            const b = identities[j];
            const shared = a.requiredCharacters.filter(ch => b.requiredCharacters.includes(ch));
            if (!shared.length) continue;
            unite(a.counterId, b.counterId);
            const defenceIds = [...new Set([
                ...a.defences.map(d => d.defenceId),
                ...b.defences.map(d => d.defenceId)
            ])].sort();
            if (defenceIds.length > 1) {
                directConflicts.push({
                    type: "required-character",
                    counterIds: [a.counterId, b.counterId],
                    requiredCharacters: shared.slice().sort(),
                    defenceIds
                });
            }
        }
    }

    const grouped = new Map();
    identities.forEach(identity => {
        const root = find(identity.counterId);
        if (!grouped.has(root)) grouped.set(root, []);
        grouped.get(root).push(identity);
    });
    const resourceGroups = [...grouped.values()].map(group => {
        const counterIds = group.map(identity => identity.counterId).sort();
        const defenceIds = [...new Set(group.flatMap(identity => identity.defences.map(d => d.defenceId)))].sort();
        const characterCounts = new Map();
        group.forEach(identity => identity.requiredCharacters.forEach(character =>
            characterCounts.set(character, (characterCounts.get(character) || 0) + 1)));
        const requiredCharacters = [...characterCounts.entries()]
            .filter(([, count]) => group.length === 1 || count > 1)
            .map(([character]) => character).sort();
        const hasDirectGap = counterIds.length > 2 && counterIds.some((counterId, index) =>
            counterIds.slice(index + 1).some(otherId => {
                const a = uses.get(counterId);
                const b = uses.get(otherId);
                return !a.requiredCharacters.some(ch => b.requiredCharacters.includes(ch));
            }));
        return { counterIds, requiredCharacters, defenceIds, indirect: hasDirectGap };
    }).filter(group => group.defenceIds.length > 1 && (
        group.counterIds.length > 1 || directConflicts.some(conflict => conflict.counterIds[0] === group.counterIds[0])
    )).sort((a, b) => a.counterIds.join("|").localeCompare(b.counterIds.join("|")));

    return {
        state: "assessed",
        teams,
        directConflicts: directConflicts.sort((a, b) =>
            (a.counterIds.join("|") + a.defenceIds.join("|")).localeCompare(
                b.counterIds.join("|") + b.defenceIds.join("|"))),
        resourceGroups,
        quality: {
            state: "limited",
            reason: "Runtime matchup data supplies ordinal tiers but no structured evidence confidence."
        }
    };
}

function compareTierProfiles(a, b) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const av = a[i] == null ? -1 : a[i];
        const bv = b[i] == null ? -1 : b[i];
        if (av !== bv) return av - bv;
    }
    return 0;
}

// Scarcity-first ordered search with pruning. After maximising coverage, compare
// each plan's tiers from weakest to strongest. This maximin-style ordinal profile
// prefers A+A over S+B without pretending tiers are numeric probabilities. The
// former summed-tier objective is retained in the same traversal as a bounded
// counterfactual for diagnostics; no per-candidate re-solves are needed.
function solveAllocation(teams, reserveActive, nodeBudget) {
    const order = teams.slice().sort((a, b) =>
        a.candidates.length - b.candidates.length || a.key.localeCompare(b.key));

    let best = null;
    let baselineBest = null;
    let nodes = 0;
    let exhausted = false;
    const NODE_BUDGET = Number.isInteger(nodeBudget) && nodeBudget >= 0 ? nodeBudget : 50000;

    const usedCounters = new Set();
    const usedChars = new Set();
    const assign = {};

    function sortedCandidates(t) {
        return t.candidates.slice().sort((a, b) => {
            const d = effectiveTierRank(a, reserveActive) - effectiveTierRank(b, reserveActive);
            if (d !== 0) return d;
            const adj = adjustedScore(b, t.modeKey === "FLEET") - adjustedScore(a, t.modeKey === "FLEET");
            if (adj !== 0) return adj;
            const full = (Number(b.bannerScore) || 0) - (Number(a.bannerScore) || 0);
            if (full !== 0) return full;
            return 0; // stable catalogue order is the final deterministic tie-break
        });
    }

    function candidate(cov, tierRanks, reserveCount, ban) {
        return {
            assign: { ...assign },
            coverage: cov,
            tierProfile: tierRanks.slice().sort((a, b) => b - a),
            tierSum: tierRanks.reduce((sum, rank) => sum + rank, 0),
            reserveCount,
            bannerSum: ban
        };
    }

    function isBetter(candidatePlan, current, useProfile) {
        if (!current) return true;
        if (candidatePlan.coverage !== current.coverage) return candidatePlan.coverage > current.coverage;
        if (useProfile) {
            const profileOrder = compareTierProfiles(candidatePlan.tierProfile, current.tierProfile);
            if (profileOrder !== 0) return profileOrder < 0;
        } else if (candidatePlan.tierSum !== current.tierSum) {
            return candidatePlan.tierSum < current.tierSum;
        }
        if (candidatePlan.reserveCount !== current.reserveCount) return candidatePlan.reserveCount < current.reserveCount;
        return candidatePlan.bannerSum > current.bannerSum;
    }

    function consider(cov, tierRanks, reserveCount, ban) {
        const plan = candidate(cov, tierRanks, reserveCount, ban);
        if (isBetter(plan, best, true)) best = plan;
        if (isBetter(plan, baselineBest, false)) baselineBest = plan;
    }

    // Seed both objectives with the deterministic greedy path. A tiny or exhausted
    // budget therefore degrades to a complete usable assignment rather than empty.
    function seedGreedy() {
        let cov = 0;
        let reserveCount = 0;
        let ban = 0;
        const tierRanks = [];
        order.forEach(t => {
            const chosen = sortedCandidates(t).find(c =>
                !usedCounters.has(c.counterId) &&
                !requiredChars(c.counterId).some(ch => usedChars.has(ch)));
            if (!chosen) return;
            usedCounters.add(chosen.counterId);
            requiredChars(chosen.counterId).forEach(ch => usedChars.add(ch));
            assign[t.key] = chosen;
            cov++;
            tierRanks.push(effectiveTierRank(chosen, reserveActive));
            reserveCount += reserveActive && isHighReserve(chosen.counterId) ? 1 : 0;
            ban += adjustedScore(chosen, t.modeKey === "FLEET");
        });
        consider(cov, tierRanks, reserveCount, ban);
        Object.keys(assign).forEach(key => delete assign[key]);
        usedCounters.clear();
        usedChars.clear();
    }

    function dfs(i, cov, tierRanks, reserveCount, ban) {
        if (nodes >= NODE_BUDGET) {
            exhausted = true;
            return;
        }
        nodes++;

        // Coverage upper bound: even covering every remaining team can't win.
        const bound = cov + (order.length - i);
        if (best && baselineBest && bound < best.coverage && bound < baselineBest.coverage) return;

        if (i === order.length) {
            consider(cov, tierRanks, reserveCount, ban);
            return;
        }

        const t = order[i];
        const cands = sortedCandidates(t);

        for (const c of cands) {
            if (usedCounters.has(c.counterId)) continue;
            const req = requiredChars(c.counterId);
            if (req.some(ch => usedChars.has(ch))) continue;

            usedCounters.add(c.counterId);
            req.forEach(ch => usedChars.add(ch));
            assign[t.key] = c;

            dfs(i + 1, cov + 1, tierRanks.concat(effectiveTierRank(c, reserveActive)),
                reserveCount + (reserveActive && isHighReserve(c.counterId) ? 1 : 0),
                ban + adjustedScore(c, t.modeKey === "FLEET"));

            delete assign[t.key];
            usedCounters.delete(c.counterId);
            req.forEach(ch => usedChars.delete(ch));
        }

        // Branch where this team is left uncovered.
        dfs(i + 1, cov, tierRanks, reserveCount, ban);
    }

    seedGreedy();
    dfs(0, 0, [], 0, 0);
    return Object.assign({}, best, {
        baselineAssign: baselineBest.assign,
        baselineTierProfile: baselineBest.tierProfile,
        search: { nodes, budget: NODE_BUDGET, exhausted }
    });
}

// Detect when undersizing is what won a counter its recommendation (v2.9). Returns
// an explanatory sentence if, among the same team's other candidates, some rival in
// the SAME tier has a higher full-squad banner score than the chosen counter yet a
// lower-or-equal undersize-adjusted score — meaning the chosen counter only ranked
// above it because of its droppable-unit bonus. Without this note, the card's
// full-squad headline (kept deliberately as the no-risk figure) could sit below a
// rival's headline with no visible reason. Returns null when the pick was not
// undersize-driven, so the base reason is left untouched.
function undersizeDrovePick(team, chosen) {
    const isFleet = team.modeKey === "FLEET";
    const chosenFull = Number(chosen.bannerScore) || 0;
    const chosenAdj  = adjustedScore(chosen, isFleet);
    if (chosenAdj <= chosenFull) return null;               // no undersize premium counted; can't be undersize-driven
    const chosenTier = tierSortValue(chosen.tier);

    const rival = team.candidates.find(c =>
        c.counterId !== chosen.counterId &&
        tierSortValue(c.tier) === chosenTier &&                       // same tier
        (Number(c.bannerScore) || 0) > chosenFull &&                 // higher at full squad
        adjustedScore(c, isFleet) <= chosenAdj);                     // but not once undersize is counted

    if (!rival) return null;
    return `Chosen for its undersize potential (${chosenAdj} vs ${Number(rival.bannerScore) || 0}).`;
}

// Plain-language reason for each team, grounded in the plan's real alternatives.
// Strategic reserve (v3.6): the team's available High-reserve candidates that
// are neither the chosen counter nor already committed to another team in this
// plan — i.e. still genuinely available, just not the top pick. Surfaced so a
// counter like Bane never silently disappears from the board just because a
// comparable non-reserve option ranked ahead of it; it stays visible, marked,
// and one tap away via the same Mark used action as any other counter.
function reserveAlternatives(t, assignedByCounter, reserveActive) {
    if (!reserveActive) return [];
    return t.candidates.filter(c => isHighReserve(c.counterId) && !assignedByCounter[c.counterId]);
}

function buildReasons(eligible, assign, reserveActive) {
    const reasons = {};

    const teamByKey = {};
    eligible.forEach(t => { teamByKey[t.key] = t; });

    const assignedByCounter = {};   // counterId -> key of the team it's committed to
    const charHolder = {};          // characterId -> counter name holding it in the plan
    const usedChars = new Set();
    Object.entries(assign).forEach(([key, c]) => {
        assignedByCounter[c.counterId] = key;
        requiredChars(c.counterId).forEach(ch => {
            usedChars.add(ch);
            charHolder[ch] = c.counter;
        });
    });

    eligible.forEach(t => {
        if (t.custom) {
            reasons[t.key] = { counter: null, reason: "Not in the catalogue — no recommendations for this team.", defenceBlocked: [], reserveWarning: false, reserveAlternatives: [] };
            return;
        }

        const chosen = assign[t.key] || null;
        const reserveAlts = reserveAlternatives(t, assignedByCounter, reserveActive);

        if (chosen) {
            let reason;
            const rivals = eligible.filter(o =>
                o.key !== t.key && !o.custom &&
                o.candidates.some(c => c.counterId === chosen.counterId));
            const diverted = t.candidates.find(c =>
                c.counterId !== chosen.counterId &&
                assignedByCounter[c.counterId] &&
                assignedByCounter[c.counterId] !== t.key);

            if (t.candidates.length === 1) {
                reason = "Your only available counter for this team.";
            } else if (rivals.length) {
                const o = rivals[0];
                const oChosen = assign[o.key];
                reason = oChosen
                    ? `Also counters ${o.name} — ${oChosen.counter} covers that one instead.`
                    : `Also eligible against ${o.name}; it scores better used here.`;
            } else if (diverted) {
                const other = teamByKey[assignedByCounter[diverted.counterId]];
                reason = `${diverted.counter} is committed to ${other ? other.name : "another team"} — ${chosen.counter} covers this one.`;
            } else {
                reason = "Strongest available option for this team.";
            }

            // v2.9: if this counter was chosen over a same-tier rival that scores
            // higher at full squad — i.e. it only came out ahead on its undersize
            // adjustment — say so, otherwise the card's full-squad headline can look
            // lower than a rival's for no visible reason.
            const undersizeNote = undersizeDrovePick(t, chosen);
            if (undersizeNote) reason += " " + undersizeNote;

            reasons[t.key] = {
                counter: chosen, reason, defenceBlocked: t.defenceBlocked || [],
                reserveWarning: reserveActive && isHighReserve(chosen.counterId),
                reserveAlternatives: reserveAlts
            };
            return;
        }

        // No assignment — explain why.
        let reason;
        if (t.candidates.length === 0) {
            const listed = (gacData[t.modeKey] && gacData[t.modeKey][t.name]) || [];
            const all = oneShotCounters(listed);
            if (all.length === 0) {
                reason = tacticalEntries(listed).length
                    ? "No one-shot counters in the catalogue for this team; see Counters for multi-battle options."
                    : "No counters in the catalogue for this team yet.";
            } else if (all.some(c => getOwnership(c.counterId).owned)) {
                // v3.2: distinguish "you sent them all" from "a unit they need went
                // out with something else" — the second is not obvious from the board.
                const onDefence = all.find(c => getCounterStatus(c.counterId) === "on-defence");
                const spent = all.find(c => getCounterStatus(c.counterId) === "spent");
                reason = onDefence
                    ? `${onDefence.counter} can't be fielded — ${defenceReason(onDefence.counterId)}`
                    : spent
                        ? `${spent.counter} can't be fielded — ${spentReason(spent.counterId)}`
                        : "All your counters for this team have been used.";
            } else {
                reason = "You don't own a counter for this team.";
            }
            if (all.length && tacticalEntries(listed).some(c => getCounterStatus(c.counterId) === "available")) {
                reason += " Multi-battle options you can field are listed in Counters.";
            }
        } else {
            const committed = t.candidates.find(c => assignedByCounter[c.counterId]);
            if (committed) {
                const other = teamByKey[assignedByCounter[committed.counterId]];
                reason = `${committed.counter} is committed to ${other ? other.name : "another team"}.`;
            } else {
                let clashText = null;
                for (const c of t.candidates) {
                    const ch = requiredChars(c.counterId).find(x => usedChars.has(x));
                    if (ch) {
                        clashText = `${c.counter} shares ${getCharacterName(ch)} with ${charHolder[ch]}, which is already assigned.`;
                        break;
                    }
                }
                reason = clashText || "No workable assignment without weakening another team.";
            }
        }
        reasons[t.key] = {
            counter: null, reason, defenceBlocked: t.defenceBlocked || [],
            reserveWarning: false, reserveAlternatives: reserveAlts
        };
    });

    return reasons;
}

function assignmentCounterId(assign, key) {
    return assign[key] ? assign[key].counterId : null;
}

function assignmentDetails(counter, team) {
    return counter ? {
        counterId: counter.counterId,
        tier: counter.tier,
        defenceId: team.key,
        defenceName: team.name
    } : null;
}

function candidateRequiredCharacters(team, counterId) {
    const state = (team.candidateStates || []).find(candidate => candidate.counterId === counterId);
    return state ? state.requiredCharacters : [];
}

// SC-01 diagnostic contract for the later Round UI. Every change is established
// by comparing two objectives over the exact same bounded traversal. Trade-offs
// name the counter, defence and required-unit conflict that moved it; warnings
// describe the selected plan rather than claiming an unmodelled win probability.
function buildConservationDiagnostics(eligible, solved) {
    const selected = solved.assign;
    const baseline = solved.baselineAssign;
    const complete = !solved.search.exhausted;
    const changedKeys = eligible.filter(t =>
        assignmentCounterId(selected, t.key) !== assignmentCounterId(baseline, t.key));
    const changed = complete ? changedKeys.length > 0 : null;

    const tradeoffs = complete ? changedKeys.map(team => {
        const selectedCounter = selected[team.key] || null;
        const baselineCounter = baseline[team.key] || null;
        const baselineRequired = baselineCounter
            ? candidateRequiredCharacters(team, baselineCounter.counterId)
            : [];
        const preservedFor = baselineCounter ? Object.entries(selected).filter(([otherKey, counter]) => {
            if (otherKey === team.key) return false;
            const otherTeam = eligible.find(candidate => candidate.key === otherKey);
            if (!otherTeam) return false;
            const selectedRequired = candidateRequiredCharacters(otherTeam, counter.counterId);
            return counter.counterId === baselineCounter.counterId ||
                baselineRequired.some(character => selectedRequired.includes(character));
        }).map(([otherKey, counter]) => {
            const otherTeam = eligible.find(candidate => candidate.key === otherKey);
            const selectedRequired = candidateRequiredCharacters(otherTeam, counter.counterId);
            return {
                defenceId: otherKey,
                defenceName: otherTeam.name,
                counterId: counter.counterId,
                tier: counter.tier,
                sharedRequiredCharacters: baselineRequired.filter(character => selectedRequired.includes(character))
            };
        }) : [];
        return {
            defenceId: team.key,
            defenceName: team.name,
            selected: assignmentDetails(selectedCounter, team),
            baseline: assignmentDetails(baselineCounter, team),
            preservedFor
        };
    }) : [];

    const warnings = eligible.filter(t => !t.custom).flatMap(team => {
        const chosen = selected[team.key];
        if (!chosen) {
            return [{
                defenceId: team.key,
                defenceName: team.name,
                status: team.candidates.length ? "compromised" : "no-credible-coverage",
                counterId: null,
                tier: null
            }];
        }
        return tierSortValue(chosen.tier) >= tierSortValue("B") ? [{
            defenceId: team.key,
            defenceName: team.name,
            status: "low-tier",
            counterId: chosen.counterId,
            tier: chosen.tier
        }] : [];
    });

    return {
        state: complete ? (changed ? "changed" : "unchanged") : "limited",
        changed,
        motivation: changed ? "visible-board-scarcity" : null,
        selectedTierProfile: solved.tierProfile.slice(),
        baselineTierProfile: solved.baselineTierProfile.slice(),
        tradeoffs,
        warnings,
        search: Object.assign({}, solved.search),
        quality: {
            state: "limited",
            reason: "Tier is an ordinal reliability category; runtime data has no structured evidence confidence or win probability."
        }
    };
}

// Action-time engine diagnostic, using SC-01's eligibility/required-unit snapshot
// and the existing bounded solver. No persisted or render state is changed. One
// counterfactual solve checks whether the rest of the selected plan can retain
// its coverage and ordinal tier profile after this composition is spent.
function assessCounterUseImpact(plan, counterId, targetKey) {
    const empty = { state: "unchanged", affected: [] };
    if (!plan) return empty;
    const remaining = plan.eligible.filter(t => !t.custom && t.key !== targetKey);
    const spent = requiredChars(counterId);
    const conflicts = (team, candidate) => candidate.counterId === counterId ||
        candidateRequiredCharacters(team, candidate.counterId).some(ch => spent.includes(ch));
    const claimed = remaining.filter(t => plan.assign[t.key] && conflicts(t, plan.assign[t.key]));
    if (!claimed.length) return empty;
    const after = solveAllocation(remaining.map(t => Object.assign({}, t, {
        candidates: t.candidates.filter(c => !conflicts(t, c))
    })), plan.reserveActive);
    const before = remaining.filter(t => plan.assign[t.key]).map(t => plan.assign[t.key]);
    // Override risk describes authored reliability, not the hidden reserve nudge;
    // two equally tiered routes are not a dynamic quality loss merely because
    // one has a reserve flag. Hidden-zone concern is explained separately.
    const profile = before.map(c => tierSortValue(c.tier)).sort((a, b) => b - a);
    const afterProfile = Object.values(after.assign).map(c => tierSortValue(c.tier)).sort((a, b) => b - a);
    if (after.coverage > before.length || (after.coverage === before.length &&
        compareTierProfiles(afterProfile, profile) <= 0)) return empty;
    const affected = remaining.filter(t => {
        const previous = plan.assign[t.key];
        const next = after.assign[t.key];
        return previous && (!next || tierSortValue(next.tier) > tierSortValue(previous.tier));
    }).map(t => ({
        defenceId: t.key,
        defenceName: t.name,
        previous: assignmentDetails(plan.assign[t.key], t),
        remaining: assignmentDetails(after.assign[t.key], t),
        sharedRequiredCharacters: candidateRequiredCharacters(t, plan.assign[t.key].counterId)
            .filter(ch => spent.includes(ch))
    }));
    return { state: after.search.exhausted ? "limited" : "changed", affected };
}

function computeRoundPlan() {
    if (!board) return null;

    const eligible = buildEligibleTeams();

    const visibleBoardScarcity = assessVisibleBoardScarcity(eligible);
    const overlap = visibleBoardScarcity.resourceGroups.length > 0;

    // Strategic reserve activates only in Round Mode, and only while at least one
    // enemy zone remains hidden behind the reveal chain (see roundHasHiddenZones).
    // Once the whole board is visible this is false and every reserve-related
    // field below reads as a no-op, so ranking and display fall back exactly to
    // pre-existing behaviour.
    const reserveActive = roundHasHiddenZones(board);

    const solved = solveAllocation(eligible.filter(t => !t.custom), reserveActive);
    const reasons = buildReasons(eligible, solved.assign, reserveActive);
    const visibleBoardConservation = buildConservationDiagnostics(
        eligible.filter(t => !t.custom), solved);

    return {
        eligible,
        overlap,
        assign: solved.assign,
        reasons,
        reserveActive,
        hiddenZoneReserve: { active: reserveActive },
        visibleBoardScarcity,
        visibleBoardConservation
    };
}

// ─── BATTLE ORDER (v3.0) ──────────────────────────────────────────────────────
// Which enemy team to attack NEXT. This is a scheduling pass over the plan the
// allocation engine has already produced — it never changes which counter goes
// where, only which of those battles to fight first.
//
// The allocation engine already guarantees you can't burn a hard team's answer on
// an easy team, so the reason to attack the hard things first is not allocation:
// it is FAILURE RECOVERY. A battle that goes wrong — a loss, or a messy win that
// needs a cleanup team — spends units you hadn't planned to spend. Doing that
// early leaves a full board and a full bench to re-plan around; doing it last
// leaves nothing. So the ordering ranks by how likely a battle is to deviate from
// plan, and how costly that deviation would be if it happened late.

// The authored Threat rating for a defence team. A row matching the exact mode
// wins over an ANY row, mirroring how GAC_Scoring resolves. An unrecognised or
// missing value reads as NORMAL, so a typo in the sheet degrades to the default
// rather than throwing or silently sorting to the top.
function threatFor(name, modeKey) {
    if (!name) return "NORMAL";
    const exact = defenceTeams[modeKey] && defenceTeams[modeKey][name];
    if (exact && exact.threat) {
        const t = String(exact.threat).toUpperCase();
        if (THREAT_RANK[t]) return t;
    }
    const any = defenceTeams["ANY"] && defenceTeams["ANY"][name];
    if (any && any.threat) {
        const t = String(any.threat).toUpperCase();
        if (THREAT_RANK[t]) return t;
    }
    return "NORMAL";
}

function threatRank(threat) {
    return THREAT_RANK[String(threat || "").toUpperCase()] || THREAT_RANK.NORMAL;
}

// Position of a territory in the board's own order, used only as the final
// deterministic tiebreak so an evenly-matched board still picks the same battle
// on every render rather than flickering between equals.
function boardTerritoryOrder(territoryKey) {
    if (!board) return 99;
    const i = board.territories.findIndex(t => t.territory === territoryKey);
    return i < 0 ? 99 : i;
}

// Fragility ordering, most fragile first. Lexicographic, mirroring the style of
// the allocation objective:
//   1. Threat        — the authored judgement always leads.
//   2. Fallbacks     — fewest first; zero fallbacks is a single point of failure.
//   3. Tier          — WORST first; Tier is reliability, so a C-tier plan is the
//                      least certain battle and the one most worth de-risking early.
//   4. Banners       — highest first, as a final tiebreak between equals.
function battleOrderCompare(a, b) {
    if (a.threatRank !== b.threatRank) return a.threatRank - b.threatRank;
    if (a.fallbacks  !== b.fallbacks)  return a.fallbacks  - b.fallbacks;
    if (a.tierRank   !== b.tierRank)   return b.tierRank   - a.tierRank;
    if (a.banners    !== b.banners)    return b.banners    - a.banners;
    return 0;
}

// The reason names the factor that ACTUALLY decided the pick, by comparing the
// winner against the runner-up on each key in turn. That keeps the line honest —
// it never claims a team was chosen for its threat rating when the rating was the
// same as everything else's and something further down the list broke the tie.
function battleOrderReason(w, r, laneActive) {
    const lane = laneActive
        ? "Front Bottom first — clearing it opens the rest of the board. "
        : "";

    if (!r) {
        return lane + (laneActive
            ? "It's the only team here with a counter ready to go."
            : "It's the only team on the board with a counter ready to go.");
    }

    if (w.threatRank !== r.threatRank) {
        if (w.threat === "EXTREME" || w.threat === "HIGH") {
            return lane + `Rated ${THREAT_LABEL[w.threat]} threat — best faced while you still have room to recover.`;
        }
        return lane + "The toughest defence left with a counter ready — best faced while you still have room to recover.";
    }

    if (w.fallbacks !== r.fallbacks) {
        return lane + (w.fallbacks === 0
            ? "No fallback if this one goes wrong — best done while the board is still open."
            : `Only ${w.fallbacks} fallback${w.fallbacks === 1 ? "" : "s"} left if this one goes wrong.`);
    }

    if (w.tierRank !== r.tierRank) {
        const tier = String(w.counter.tier || "?").toUpperCase();
        return lane + `${w.counter.counter} is a ${tier}-tier answer — the least certain battle on the board right now.`;
    }

    if (w.banners !== r.banners) {
        return lane + "The highest-scoring battle available right now.";
    }

    return lane + "Evenly matched with the rest — taken in board order.";
}

function pickNextBattle(pool, laneActive) {
    if (!pool.length) return null;

    const sorted = pool.slice().sort((a, b) => {
        const d = battleOrderCompare(a, b);
        if (d !== 0) return d;
        const t = boardTerritoryOrder(a.territory) - boardTerritoryOrder(b.territory);
        if (t !== 0) return t;
        return a.index - b.index;
    });

    const winner = sorted[0];
    return Object.assign({}, winner, {
        reason: battleOrderReason(winner, sorted[1] || null, laneActive)
    });
}

// Squad and fleet are ranked as SEPARATE TRACKS. Ships and characters occupy
// disjoint unit sets, so a fleet battle and a squad battle never compete for the
// same units and there is no ordering interaction between them at all — forcing
// them into one queue would invent a choice that doesn't exist.
function computeBattleOrder(plan) {
    const empty = { squad: null, fleet: null, laneActive: false, anyNamed: false, firstAttack: false };
    if (!plan || !board) return empty;

    const assign = plan.assign || {};

    const assignedByCounter = {};
    Object.entries(assign).forEach(([key, c]) => { assignedByCounter[c.counterId] = key; });

    const anyNamed = plan.eligible.some(t => !t.custom);

    // Only teams that actually have a recommendation can be Next Up — the app
    // never sends you at something it has no answer for.
    const records = plan.eligible
        .filter(t => !t.custom && assign[t.key])
        .map(t => {
            const chosen = assign[t.key];

            // Units spent by OTHER teams' assignments. A counter needing one of
            // those isn't a real fallback for this team, because taking it would
            // break the plan elsewhere. The chosen counter's own units are not
            // counted, since a fallback is used INSTEAD of it, not alongside it.
            const spentElsewhere = new Set();
            Object.entries(assign).forEach(([key, c]) => {
                if (key === t.key) return;
                requiredChars(c.counterId).forEach(ch => spentElsewhere.add(ch));
            });

            const fallbacks = t.candidates.filter(c =>
                c.counterId !== chosen.counterId &&
                !assignedByCounter[c.counterId] &&
                !requiredChars(c.counterId).some(ch => spentElsewhere.has(ch))
            ).length;

            const threat = threatFor(t.name, t.modeKey);

            return {
                key:        t.key,
                territory:  t.territory,
                index:      t.index,
                name:       t.name,
                isFleet:    t.modeKey === "FLEET",
                counter:    chosen,
                threat:     threat,
                threatRank: threatRank(threat),
                fallbacks:  fallbacks,
                tierRank:   tierSortValue(chosen.tier),
                banners:    adjustedScore(chosen, t.modeKey === "FLEET"),
                // The opening battle ranks on the PLAIN full-squad score, not the
                // undersize-adjusted one: dropping units banks more, but it is
                // precisely the risk you do not want on the battle carrying the
                // one-off bonus (v3.1).
                openerBanners: Number(chosen.bannerScore) || 0
            };
        });

    const squadAll = records.filter(r => !r.isFleet);
    const fleetAll = records.filter(r => r.isFleet);

    // Lane rule. While Front Bottom is on the board and uncleared it owns the
    // squad recommendation. Once it is cleared the rule switches off entirely and
    // every remaining squad team competes flat — Back Bottom gets no automatic
    // priority. Safety valve: if nothing in Front Bottom has a counter ready, the
    // rule stands aside and the rest of the board is considered, rather than the
    // card reporting nothing while workable battles exist elsewhere.
    const frontBottomOpen =
        board.territories.some(t => t.territory === "FRONT_BOTTOM") &&
        !isTerritoryCleared("FRONT_BOTTOM");

    const inFrontBottom = squadAll.filter(r => r.territory === "FRONT_BOTTOM");
    const laneApplies   = frontBottomOpen && inFrontBottom.length > 0;
    const squadPool     = laneApplies ? inFrontBottom : squadAll;

    // Only SAY "Front Bottom first" when the rule actually excluded something;
    // if every squad candidate is in Front Bottom anyway, the line adds nothing.
    const laneActive = laneApplies && squadAll.length > inFrontBottom.length;

    // The opening battle of the round runs the inverted, certainty-first rule
    // instead (v3.1). It ranks over the WHOLE squad board, not the lane-filtered
    // pool, because for the opener the lane is a ranking key rather than a gate —
    // if the only reliable answers sit in Front Top, that is where it sends you.
    const firstAttack = isFirstAttackAvailable();

    const squadPick = firstAttack
        ? pickOpeningBattle(squadAll)
        : pickNextBattle(squadPool, laneActive);

    return {
        squad:       squadPick,
        // Fleet keeps the standard rule throughout. Back Top cannot be unlocked
        // while the first attack is still unfought, so this branch is unreachable
        // on a normally-configured board; it is written to degrade sensibly rather
        // than to be relied on.
        fleet:       pickNextBattle(fleetAll, false),
        laneActive:  firstAttack ? false : laneActive,
        anyNamed:    anyNamed,
        firstAttack: firstAttack
    };
}

// ─── FIRST ATTACK (v3.1) ──────────────────────────────────────────────────────
// The opening battle of a round is the one exception to the fragility ordering
// above, and the objective INVERTS for it: not "which battle is most fragile" but
// "which battle am I most certain to win cleanly".
//
// The reason is that a failure in the opening battle costs something the standard
// model cannot price. Every other failed battle costs UNITS, and units are what the
// allocation engine re-plans around — losing some is recoverable. The first battle
// additionally carries the one-off FIRST_ATTACK bonus, which is SPENT by that battle
// whatever its outcome: lose and forfeit, and the bonus is gone for the round. No
// later cleverness recovers it, and in a close round it can be the difference
// between winnable and not.
//
// The cost of the exception is that the most fragile battle is delayed by exactly
// one, which is a real but tiny loss of recovery headroom — a cheap trade against a
// bonus that can decide the round. After the opening battle the standard rule
// resumes unchanged.
//
// This is permanently a SQUAD-track concern: Back Top is locked until Front Top is
// cleared, and clearing a territory means attacking, so a fleet battle can never be
// the round's opener.

// Ordering for the opening battle only, best-first. Lexicographic:
//   1. Tier          — BEST first, inverted from the standard rule. Certainty is
//                      the whole objective here.
//   2. Front Bottom  — sits immediately below tier, so the lane preference wins
//                      whenever reliability is level. You never leave the lane for
//                      banners, only for certainty. Note this is a RANKING KEY, not
//                      the gate it is in the standard rule: if the only reliable
//                      answers are elsewhere on the board, the opener goes there.
//   3. Banners       — highest FULL-SQUAD score, as a cleanliness proxy: a low
//                      expected score means shed units and a likely cleanup team,
//                      which is exactly the outcome that costs the bonus.
//   4. Threat        — LOWEST first, again inverted; the easiest defence wins.
function openerCompare(a, b) {
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;      // best tier first

    const aLane = a.territory === "FRONT_BOTTOM" ? 0 : 1;
    const bLane = b.territory === "FRONT_BOTTOM" ? 0 : 1;
    if (aLane !== bLane) return aLane - bLane;

    if (a.openerBanners !== b.openerBanners) return b.openerBanners - a.openerBanners;
    if (a.threatRank    !== b.threatRank)    return b.threatRank    - a.threatRank; // lowest threat first
    return 0;
}

// What a flawless first-attempt win banks in this battle's format, and what one of
// your own units costs you when it doesn't come through it intact. Both are read
// from GAC_Scoring rather than hard-coded, so the risk bar tracks the sheet.
function cleanWinCeiling(isFleet) {
    return battleBestCase(isFleet ? "FLEET" : "SQUAD", isFleet ? "ANY" : board.mode, 0);
}

function unitLossCost(isFleet) {
    const battleType = isFleet ? "FLEET" : "SQUAD";
    const mode       = isFleet ? "ANY"   : board.mode;
    return scoreRule("SURVIVING_UNIT",       battleType, mode)
         + scoreRule("FULL_HEALTH_UNIT",     battleType, mode)
         + scoreRule("FULL_PROTECTION_UNIT", battleType, mode);
}

// Does the recommended opener put the first-attack bonus at risk? Returns the
// warning text, or null when the opener is a safe bet. Two independent triggers:
//
//   • TIER — the best available answer is only B or C. Because tier is the opening
//     rule's FIRST key, the chosen opener always carries the best tier on the board,
//     so a B-tier pick is a genuine board-level statement: nothing better exists.
//
//   • EXPECTED MESSINESS — the opener is expected to shed OPENER_MESSY_UNITS or more
//     of your own units. Derived by comparing the counter's full-squad banner score
//     against a flawless win for the format. This one describes the PICK rather than
//     the whole board, since the lane preference sits above banners: a Front Bottom
//     answer can be chosen over a cleaner same-tier answer elsewhere. The wording is
//     kept specific to the pick for that reason.
//
// A counter with no authored banner score is not assumed messy — it is unknown, not
// bad — so the messiness check is skipped and only tier can flag it.
function openerWarning(pick) {
    if (tierSortValue(pick.counter.tier) > tierSortValue("A")) {
        return "No reliable opener on the board — whichever you pick, the first-attack bonus is at risk. This is the best of them.";
    }

    const ceiling = cleanWinCeiling(pick.isFleet);
    const cost    = unitLossCost(pick.isFleet);
    const score   = Number(pick.counter.bannerScore);
    if (!isFinite(score) || score <= 0 || ceiling <= 0 || cost <= 0) return null;

    const losses = Math.floor((ceiling - score) / cost);
    if (losses >= OPENER_MESSY_UNITS) {
        return `Expected to cost you around ${losses} units — a scraped win here risks the first-attack bonus.`;
    }
    return null;
}

// As with the standard rule, the reason names the factor that ACTUALLY decided the
// pick, established against the runner-up rather than asserted.
function openerReason(w, r) {
    const tier = String(w.counter.tier || "?").toUpperCase();

    if (!r) return "The only battle you can field right now.";

    if (w.tierRank !== r.tierRank) {
        return `${w.counter.counter} is your most reliable answer on the board (${tier}-tier) — the surest way to bank the one-off bonus.`;
    }
    if ((w.territory === "FRONT_BOTTOM") !== (r.territory === "FRONT_BOTTOM")) {
        return "As reliable as anything else available, and in Front Bottom — so it opens your priority lane too.";
    }
    if (w.openerBanners !== r.openerBanners) {
        return "The cleanest expected win among your most reliable options.";
    }
    if (w.threatRank !== r.threatRank) {
        return "The easiest defence among your most reliable options.";
    }
    return "As safe as anything else available — taken in board order.";
}

function pickOpeningBattle(pool) {
    if (!pool.length) return null;

    const sorted = pool.slice().sort((a, b) => {
        const d = openerCompare(a, b);
        if (d !== 0) return d;
        const t = boardTerritoryOrder(a.territory) - boardTerritoryOrder(b.territory);
        if (t !== 0) return t;
        return a.index - b.index;
    });

    const winner = sorted[0];
    return Object.assign({}, winner, {
        isOpener: true,
        reason:   openerReason(winner, sorted[1] || null),
        warning:  openerWarning(winner)
    });
}

// Jump the board to the team the Next Up card points at, and leave it highlighted
// so it is still findable after the scroll. The flash is one-shot: focusFlash is
// consumed by the render it triggers, so re-renders (marking a counter used,
// editing a team) keep the highlight without replaying the animation.
function focusBoardTeam(territoryKey, index) {
    focusedTeamKey = territoryKey + ":" + index;
    focusFlash = true;
    render();
    focusFlash = false;

    const el = document.getElementById("teamblock-" + territoryKey + "-" + index);
    if (!el || !el.scrollIntoView) return;
    try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
        el.scrollIntoView();
    }
}

// ─── PERSISTENT STORAGE REQUEST ───────────────────────────────────────────────
// Best-effort: asks the OS to exempt our storage from automatic eviction.

async function requestPersistentStorage() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            const already = await navigator.storage.persisted();
            if (!already) {
                const granted = await navigator.storage.persist();
                console.log("Persistent storage granted:", granted);
            }
        }
    } catch (e) {
        console.error("persist() request failed", e);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidCataloguePayload(data) {
    return isPlainObject(data) &&
        isPlainObject(data.counters) &&
        isPlainObject(data.counters["5v5"]) &&
        isPlainObject(data.counters["3v3"]) &&
        isPlainObject(data.counterDefinitions) &&
        isPlainObject(data.characterDefinitions) &&
        isPlainObject(data.boardConfig) &&
        Array.isArray(data.scoring) &&
        isPlainObject(data.defenceTeams) &&
        isPlainObject(data.defenceCompositions);
}

function readCatalogueEntry(key, schema, sourceContract) {
    let cached;
    try {
        cached = JSON.parse(localStorage.getItem(key) || "null");
    } catch (e) {
        return null;
    }

    if (!cached || cached.schema !== schema ||
        cached.sourceContract !== sourceContract ||
        !Number.isFinite(Date.parse(cached.acceptedAt)) ||
        !isValidCataloguePayload(cached.payload)) {
        return null;
    }
    return cached;
}

// The validated v2 cache first, then a pre-cutover v1 cache (same seven-key
// payload) so an upgrading user keeps their offline catalogue.
function readCatalogueCache() {
    const current = readCatalogueEntry(CATALOGUE_CACHE_KEY, CATALOGUE_CACHE_SCHEMA, CATALOGUE_RELEASE_CONTRACT);
    if (current && CATALOGUE_CHECKSUM_PATTERN.test(current.checksum) &&
        Number.isSafeInteger(current.catalogueVersion) && current.catalogueVersion > 0) {
        return current;
    }
    return readCatalogueEntry(LEGACY_CATALOGUE_CACHE_KEY, LEGACY_CATALOGUE_CACHE_SCHEMA, LEGACY_CATALOGUE_SOURCE_CONTRACT);
}

function writeCatalogueCache(release) {
    const text = JSON.stringify({
        schema: CATALOGUE_CACHE_SCHEMA,
        sourceContract: CATALOGUE_RELEASE_CONTRACT,
        acceptedAt: new Date().toISOString(),
        catalogueVersion: release.catalogueVersion,
        checksum: release.checksum,
        payload: release.payload
    });
    try {
        localStorage.setItem(CATALOGUE_CACHE_KEY, text);
        return true;
    } catch (e) {
        // Most likely the quota: give up the rollback copy rather than the
        // current catalogue, then try once more.
        if (localStorage.getItem(LEGACY_CATALOGUE_CACHE_KEY) !== null) {
            try {
                localStorage.removeItem(LEGACY_CATALOGUE_CACHE_KEY);
                localStorage.setItem(CATALOGUE_CACHE_KEY, text);
                return true;
            } catch (retryError) {
                e = retryError;
            }
        }
        console.warn("Couldn't save the catalogue cache", e);
        return false;
    }
}

function sortCatalogueJson(value) {
    if (Array.isArray(value)) return value.map(sortCatalogueJson);
    if (value && typeof value === "object") {
        const sorted = {};
        Object.keys(value).sort().forEach(key => { sorted[key] = sortCatalogueJson(value[key]); });
        return sorted;
    }
    return value;
}

// Identity of a catalogue: SHA-256 of the canonical JSON of the seven payload
// keys (recursively sorted keys, 2-space indent, trailing newline), exactly as
// the release builder computes it. Throws where crypto.subtle is unavailable.
async function catalogueChecksum(payload) {
    const legacy = {};
    CATALOGUE_PAYLOAD_KEYS.forEach(key => { legacy[key] = payload[key]; });
    const canonical = JSON.stringify(sortCatalogueJson(legacy), null, 2) + "\n";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return "sha256:" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function parseCataloguePointer(pointer) {
    if (!isPlainObject(pointer) ||
        pointer.pointerSchema !== CATALOGUE_POINTER_SCHEMA ||
        pointer.contract !== CATALOGUE_RELEASE_CONTRACT ||
        !Number.isSafeInteger(pointer.catalogueVersion) || pointer.catalogueVersion < 1 ||
        typeof pointer.checksum !== "string" || !CATALOGUE_CHECKSUM_PATTERN.test(pointer.checksum) ||
        !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1) {
        return null;
    }
    // Only the immutable release file the pointer itself identifies is fetched.
    const expectedPath = `releases/${pointer.catalogueVersion}-${pointer.checksum.slice(7, 19)}.json`;
    return pointer.path === expectedPath ? pointer : null;
}

// The timeout covers the body as well as the headers, so a stalled transfer on
// venue wifi fails instead of hanging.
async function fetchCatalogueText(url, ms, options) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response || !response.ok) throw new Error("Catalogue request failed");
        return await response.text();
    } finally {
        clearTimeout(t);
    }
}

// Downloads and verifies the release a pointer names. Throws on any HTTP,
// size, JSON, contract, shape or checksum failure.
async function fetchCatalogueRelease(pointer) {
    const text = await fetchCatalogueText(CATALOGUE_BASE_URL + pointer.path, CATALOGUE_RELEASE_TIMEOUT_MS);
    if (new TextEncoder().encode(text).length !== pointer.bytes) throw new Error("Catalogue release is incomplete");
    const releaseFile = JSON.parse(text);
    const meta = isPlainObject(releaseFile) ? releaseFile.release : null;
    if (!isPlainObject(meta) || meta.contract !== CATALOGUE_RELEASE_CONTRACT || meta.checksum !== pointer.checksum) {
        throw new Error("Catalogue release does not match its pointer");
    }
    const payload = {};
    CATALOGUE_PAYLOAD_KEYS.forEach(key => { payload[key] = releaseFile[key]; });
    if (!isValidCataloguePayload(payload)) throw new Error("Catalogue release is malformed");
    if (await catalogueChecksum(payload) !== pointer.checksum) throw new Error("Catalogue release checksum mismatch");
    return { catalogueVersion: pointer.catalogueVersion, checksum: pointer.checksum, payload };
}

function applyCataloguePayload(data) {
    gacData = data.counters;
    counterDefinitions = data.counterDefinitions;
    characterDefinitions = data.characterDefinitions;
    spentCharsCache = { key: null, map: new Map() };   // definitions changed: required-unit lookups are stale
    boardConfig = data.boardConfig;
    scoringRules = data.scoring;
    defenceTeams = data.defenceTeams;
    defenceCompositions = data.defenceCompositions;

    ensureDefenceSnapshotForActiveRound();
    buildReverseIndex();
}

function renderCatalogueUnavailable() {
    document.getElementById("app").innerHTML =
        "<p style='padding:20px;'>Catalogue unavailable. Check your connection and try again. Your saved roster, round and other data have not been changed.</p>";
}

// Checks the pointer and, only for a catalogue this device has not already
// verified, downloads the release. Returns "unchanged", "updated" or "failed";
// on failure the catalogue already in use (if any) stays in use.
async function refreshCatalogue(cached) {
    try {
        const pointer = parseCataloguePointer(JSON.parse(
            await fetchCatalogueText(CATALOGUE_POINTER_URL, CATALOGUE_POINTER_TIMEOUT_MS, { cache: "no-cache" })));
        if (!pointer) return "failed";

        if (cached && await catalogueChecksum(cached.payload) === pointer.checksum) {
            // Same catalogue already on screen. A migrated v1 cache is recorded
            // as v2 without downloading the release.
            if (cached.schema !== CATALOGUE_CACHE_SCHEMA) {
                writeCatalogueCache({ catalogueVersion: pointer.catalogueVersion, checksum: pointer.checksum, payload: cached.payload });
            }
            return "unchanged";
        }

        const release = await fetchCatalogueRelease(pointer);
        // A verified release is used even if it can't be stored (quota); the
        // next launch then starts from the previous cache and downloads again.
        writeCatalogueCache(release);
        applyCataloguePayload(release.payload);
        return "updated";
    } catch (e) {
        return "failed";
    }
}

async function loadData() {
    const cached = readCatalogueCache();
    if (cached) {
        applyCataloguePayload(cached.payload);
        catalogueStatus = null;
        render();
        maybeBackgroundSync();

        const outcome = await refreshCatalogue(cached);
        if (outcome === "unchanged") return;   // nothing new: no second render
        catalogueStatus = outcome === "updated" ? null : "Using saved catalogue. Couldn't check for updates just now.";
        render();
        return;
    }

    const outcome = await refreshCatalogue(null);
    if (outcome !== "updated") {
        renderCatalogueUnavailable();
        return;
    }
    catalogueStatus = null;
    render();
    maybeBackgroundSync(); // roster refresh remains independent of catalogue loading
}

// ─── EXTERNAL ID MAPPING ───────────────────────────────────────────────────────

function buildReverseIndex() {
    baseIdToUnit = {};
    Object.entries(characterDefinitions).forEach(([id, def]) => {
        const ext = def && def.externalId ? String(def.externalId).trim() : "";
        if (ext) baseIdToUnit[ext] = { characterId: id, unitType: def.unitType };
    });
}

function classifyBaseIds(baseIds, opts) {
    const wantTypes = (opts && opts.unitTypes) || ["CHARACTER"];
    const ownedUnitIds = [];
    const counts = { CHARACTER: 0, SHIP: 0, CAPITAL_SHIP: 0 };
    const ignoredKnown = [];   // recognised, but a unit type we're not importing here
    const unknown = [];        // not in the registry / no mapping yet
    const seen = new Set();

    (baseIds || []).forEach(bid => {
        const key = String(bid);
        if (seen.has(key)) return;
        seen.add(key);

        const hit = baseIdToUnit[key];
        if (!hit) { unknown.push(key); return; }

        if (wantTypes.includes(hit.unitType)) {
            ownedUnitIds.push(hit.characterId);
            if (counts[hit.unitType] !== undefined) counts[hit.unitType]++;
        } else {
            ignoredKnown.push(key);
        }
    });

    return { ownedUnitIds, counts, ignoredKnown, unknown };
}

function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every(x => s.has(x));
}

// ─── ROSTER API CALL ───────────────────────────────────────────────────────────

function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal })
        .finally(() => clearTimeout(t));
}

async function fetchRosterFromApi(allyCode) {
    const url = ROSTER_API_URL + "?action=roster&allyCode=" + encodeURIComponent(allyCode);
    const resp = await fetchWithTimeout(url, ROSTER_FETCH_TIMEOUT_MS);
    return await resp.json();   // structured { ok, ... }
}

function apiErrorMessage(error) {
    switch (error) {
        case "invalid_ally_code":
            return "That doesn't look like a 9-digit ally code.";
        case "not_found":
            return "We couldn't find that ally code. Double-check the 9 digits and try again.";
        case "rate_limited":
            return "The game's servers are busy right now. Wait a moment and try again.";
        default:
            return "Couldn't load your roster right now. Please try again shortly.";
    }
}

function buildImportSummary(counts, unknown) {
    const ch = counts.CHARACTER || 0;
    const sh = (counts.SHIP || 0) + (counts.CAPITAL_SHIP || 0);
    let summary = `Imported ${ch} character${ch === 1 ? "" : "s"} and ${sh} ship${sh === 1 ? "" : "s"} from the game.`;
    if (unknown) summary += ` ${unknown} unit${unknown === 1 ? "" : "s"} not in the app's database yet — they won't affect counters.`;
    return summary;
}

async function importFromAllyCode() {
    const allyCode = String(allyCodeDraft || rosterMeta.allyCode || "").replace(/\D/g, "");

    if (allyCode.length !== 9) {
        rosterMessage = { text: "An ally code is 9 digits — find it in-game under Menu → Profile.", kind: "error" };
        render();
        return;
    }

    if (!navigator.onLine) {
        rosterMessage = { text: "You're offline. Your saved roster is still available — reconnect and try again.", kind: "warn" };
        render();
        return;
    }

    const isRoutineRefresh =
        rosterMeta.source === ROSTER_SOURCE_API && rosterMeta.allyCode === allyCode;
    if (hasRoster() && !isRoutineRefresh) {
        const ok = confirm(`This replaces your current roster (${ownedCharacters.length} characters) with data from your game account. You can undo straight afterwards.`);
        if (!ok) return;
    }

    rosterSyncing = true;
    rosterMessage = null;
    render();

    let data;
    try {
        data = await fetchRosterFromApi(allyCode);
    } catch (e) {
        rosterSyncing = false;
        const timedOut = e && e.name === "AbortError";
        rosterMessage = {
            text: timedOut
                ? "The import took too long to respond. Check your connection and try again."
                : "Couldn't reach the roster service. Check your connection and try again.",
            kind: "error"
        };
        render();
        return;
    }

    rosterSyncing = false;

    if (!data || !data.ok) {
        rosterMessage = { text: apiErrorMessage(data && data.error), kind: "error" };
        render();
        return;
    }

    const { ownedUnitIds, counts, unknown } =
        classifyBaseIds(data.ownedBaseIds, { unitTypes: ["CHARACTER", "SHIP", "CAPITAL_SHIP"] });

    if (ownedUnitIds.length === 0) {
        rosterMessage = {
            text: "We loaded your account, but none of your units are mapped in the app yet, so nothing was imported.",
            kind: "error"
        };
        render();
        return;
    }

    rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };
    applyRoster(ownedUnitIds, ROSTER_SOURCE_API, {
        allyCode: data.allyCode || allyCode,
        syncedAt: data.syncedAt || new Date().toISOString()
    });
    allyCodeDraft = "";

    rosterMessage = {
        text: buildImportSummary(counts, unknown.length),
        kind: unknown.length ? "warn" : "ok"
    };
    render();
}

async function maybeBackgroundSync() {
    if (rosterMeta.source !== ROSTER_SOURCE_API) return; // only API rosters auto-sync
    if (!rosterMeta.allyCode) return;
    if (!navigator.onLine) return;
    if (currentView === "roster") return;                // never apply mid-edit

    const last = rosterMeta.syncedAt ? Date.parse(rosterMeta.syncedAt) : 0;
    if (last && (Date.now() - last) < ROSTER_SYNC_STALE_MS) return;

    try {
        const data = await fetchRosterFromApi(rosterMeta.allyCode);
        if (!data || !data.ok) return;            // silent: stay on cache
        if (currentView === "roster") return;     // user navigated in-flight: abandon

        const { ownedUnitIds } =
            classifyBaseIds(data.ownedBaseIds, { unitTypes: ["CHARACTER", "SHIP", "CAPITAL_SHIP"] });
        if (ownedUnitIds.length === 0) return; // don't wipe a good cache on a bad map

        const changed = !sameSet(ownedUnitIds, ownedCharacters);
        if (changed) {
            rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };
        }
        applyRoster(ownedUnitIds, ROSTER_SOURCE_API, {
            allyCode: data.allyCode || rosterMeta.allyCode,
            syncedAt: data.syncedAt || new Date().toISOString()
        });
        render();   // refresh availability + freshness line quietly
    } catch (e) {
        console.warn("Background roster sync failed (staying on cached roster)", e);
    }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getCharacterName(characterId) {
    const def = characterDefinitions[characterId];
    if (!def) return characterId;
    return def.name || characterId;
}

// Unit lists for the roster screen. Each item carries unitType so the roster
// row can badge capital ships. Ships and capital ships share one list, matching
// how the game groups them; the badge is the only visual distinction.
function getUnitList(types) {
    return Object.entries(characterDefinitions)
        .filter(([, def]) => types.includes(def.unitType))
        .map(([id, def]) => ({ id, name: def.name, unitType: def.unitType }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getCharacterUnits() { return getUnitList(["CHARACTER"]); }
function getShipUnits()      { return getUnitList(["SHIP", "CAPITAL_SHIP"]); }

function getTierColour(tier) {
    switch ((tier || "").toUpperCase()) {
        case "S": return "#1976D2";
        case "A": return "#4CAF50";
        case "B": return "#FF9800";
        case "C": return "#F44336";
        default:  return "#999999";
    }
}

function getUsedTeamCount() {
    return usedTeams.length;
}

function hasRoster() {
    return ownedCharacters.length > 0;
}

// ─── OWNERSHIP ───────────────────────────────────────────────────────────────

function getOwnership(counterId) {
    const def = counterDefinitions[counterId];

    if (!def) {
        return { owned: false, missing: ["Missing definition"] };
    }

    const required = def.required || [];
    const missing = required.filter(
        characterId => !ownedCharacters.includes(characterId)
    );

    return { owned: missing.length === 0, missing };
}

// ─── SPENT UNITS (v3.2) ───────────────────────────────────────────────────────
// Offence spends units for the whole round whatever the battle's outcome, so a
// counter that shares a required character with one already marked used can no
// longer be fielded either. The allocation engine has always enforced that
// exclusivity *within* a plan; it has to hold against history too, or "SEE and
// Bane" keeps offering itself as available after "Bane" has been sent.
//
// Only REQUIRED characters are spent. Recommended ones are advice, not a claim on
// a unit, so they never block a second counter. The lookup is memoised on the
// used-team list and invalidated whenever the definitions behind it are replaced.

// characterId -> the counterId that spent it. The first used counter to claim a
// character owns it; nothing later can take it back this round.
function spentCharacters() {
    const key = usedTeams.join("|");
    if (spentCharsCache.key !== key) {
        const map = new Map();
        usedTeams.forEach(counterId => {
            requiredChars(counterId).forEach(ch => {
                if (!map.has(ch)) map.set(ch, counterId);
            });
        });
        spentCharsCache = { key, map };
    }
    return spentCharsCache.map;
}

// The required characters of this counter that an already-used counter has spent.
// A used counter never clashes with itself — its own claim is what "used" means.
function spentClashes(counterId) {
    if (usedTeams.includes(counterId)) return [];
    const spent = spentCharacters();
    return requiredChars(counterId)
        .filter(ch => spent.has(ch))
        .map(ch => ({ character: ch, holder: spent.get(ch) }));
}

function getCounterName(counterId) {
    const def = counterDefinitions[counterId];
    return (def && def.name) || counterId;
}

// One line naming why a counter is spent, e.g. "Darth Bane was used with Bane."
function spentReason(counterId) {
    const clashes = spentClashes(counterId);
    if (!clashes.length) return null;
    const names = clashes.map(c => getCharacterName(c.character));
    const holder = getCounterName(clashes[0].holder);
    const list = names.length === 1
        ? names[0]
        : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    return `${list} ${names.length === 1 ? "was" : "were"} used with ${holder}.`;
}

function defenceClashes(counterId) {
    const snapshot = board && board.defenceSnapshot;
    if (!validDefenceSnapshot(snapshot, board && board.mode)) return [];
    const onDefence = new Set(snapshot.characterIds);
    return requiredChars(counterId).filter(ch => onDefence.has(ch));
}

function defenceReason(counterId) {
    const clashes = defenceClashes(counterId);
    if (!clashes.length) return null;
    const names = clashes.map(getCharacterName);
    const list = names.length === 1
        ? names[0]
        : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    return `${list} ${names.length === 1 ? "is" : "are"} on defence.`;
}

// ─── SUGGESTED SQUAD (Round card disclosure) ──────────────────────────────────
// Expands a recommendation card's counterId into the catalogue's suggested
// attacking composition, purely for display — this never affects selection,
// scoring, or the spent/on-defence tracking above (only required[] feeds that,
// unchanged). Returns null when there is nothing usable to show, so the card
// can skip the disclosure affordance entirely rather than open onto emptiness.
function counterCompositionForDisplay(counterId, modeKey) {
    const def = counterDefinitions[counterId];
    const required = (def && def.required) || [];
    const recommended = (def && def.recommended) || [];
    if (required.length === 0 && recommended.length === 0) return null;

    // Battle size is only defined for the two squad formats; fleet composition
    // (and anything else) shows the named units with no flex claim rather than
    // guessing at a ship-count slot total.
    const battleSize = modeKey === "3v3" ? 3 : modeKey === "5v5" ? 5 : null;
    const explicitCount = required.length + recommended.length;
    const flex = battleSize != null ? battleSize - explicitCount : 0;

    return {
        required: required.map(id => ({ id, name: getCharacterName(id) })),
        recommended: recommended.map(id => ({ id, name: getCharacterName(id) })),
        flex: flex > 0 ? flex : 0   // negative (overspecified/malformed) collapses to no flex line
    };
}

// Per-character availability note for the expanded squad list, built entirely
// from state the app already tracks (ownedCharacters, spentCharacters(), the
// defence snapshot) rather than a second availability engine. Returns null for
// an available character so its row shows no note.
function isCharacterOnDefence(characterId) {
    const snapshot = board && board.defenceSnapshot;
    if (!validDefenceSnapshot(snapshot, board && board.mode)) return false;
    return snapshot.characterIds.includes(characterId);
}

function characterAvailabilityNote(characterId) {
    if (!ownedCharacters.includes(characterId)) return "Not owned";
    const holder = spentCharacters().get(characterId);
    if (holder) return `Used with ${getCounterName(holder)}`;
    if (isCharacterOnDefence(characterId)) return "On defence";
    return null;
}

function getCounterStatus(counterId) {
    const { owned } = getOwnership(counterId);
    if (!owned) return "not-owned";
    if (usedTeams.includes(counterId)) return "used";
    if (defenceClashes(counterId).length) return "on-defence";
    if (spentClashes(counterId).length) return "spent";
    return "available";
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function openRoundDefenceLineups() {
    if (!board) return;
    defenceLineupsMode = board.mode;
    defenceLineupsMessage = null;
    setView("defence-lineups");
}

function setView(view) {
    if (currentView === "defence-lineups" && view !== currentView) {
        if (!closeDefenceLineupEditor()) return;
    }
    currentView = view;
    if (view === "roster") {
        loadRoster();          // defensive re-read on entry
        rosterMessage = null;
    }
    if (view === "round") {
        loadBoard();           // defensive re-read on entry
        // Seed the setup card's GAC format from the Counters toggle for
        // convenience, once, on first entry into a fresh setup. From then on
        // the round owns its own format until it is created or discarded.
        if (!board && !boardModeDraft) {
            boardModeDraft = currentMode !== "FLEET" ? currentMode : lastSquadMode;
        }
    }
    render();
}

// ─── RENDER ──────────────────────────────────────────────────────────────────

function render() {
    const app = document.getElementById("app");

    let viewHtml;
    if (currentView === "counters") {
        viewHtml = renderCounters();
    } else if (currentView === "roster") {
        viewHtml = renderMoreSubview(renderRoster());
    } else if (currentView === "defence-lineups") {
        viewHtml = renderMoreSubview(renderDefenceLineups());
    } else if (currentView === "usage") {
        viewHtml = renderMoreSubview(renderUsage());
    } else if (currentView === "more") {
        viewHtml = renderMore();
    } else {
        viewHtml = renderRound();
    }

    app.innerHTML = `
${catalogueStatus ? `<div class="roster-saved-line" style="padding:10px 16px 0;">${catalogueStatus}</div>` : ""}
${viewHtml}

<div class="footer">v${APP_VERSION}</div>

<nav class="bottom-nav">
    <button class="nav-button ${currentView === "counters" ? "active" : ""}" onclick="setView('counters')">
        <span class="nav-icon">⚔️</span>
        COUNTERS
    </button>
    <button class="nav-button ${currentView === "round" ? "active" : ""}" onclick="setView('round')">
        <span class="nav-icon">🗺️</span>
        ROUND
    </button>
    <button class="nav-button ${["more", "roster", "defence-lineups", "usage"].includes(currentView) ? "active" : ""}" onclick="setView('more')">
        <span class="nav-icon">☰</span>
        MORE
    </button>
</nav>
`;

    if (currentView === "counters") {
        showCounters();
    }
}

// More owns secondary screens; their shared back control returns to the menu.
function renderMoreSubview(content) {
    return `<button class="more-back" onclick="setView('more')">← Back to More</button>${content}`;
}

function renderMore() {
    return `
<div class="round-card">
    <div class="round-title">MORE</div>
    <button class="more-menu-entry" onclick="setView('roster')">
        <span>👤 My Roster</span><span aria-hidden="true">›</span>
    </button>
    <button class="more-menu-entry" onclick="setView('defence-lineups')">
        <span>🛡️ Defence Lineups</span><span aria-hidden="true">›</span>
    </button>
    <button class="more-menu-entry" onclick="setView('usage')">
        <span>📊 Usage</span><span aria-hidden="true">›</span>
    </button>
</div>
`;
}

// ─── REUSABLE DEFENCE LINEUPS ────────────────────────────────────────────────

// Fill empty layout slots for display/editing without creating a template just
// by opening the screen. Legacy templates without layout metadata retain every
// saved slot, even when the current catalogue cannot supply their old layout.
function defenceLineupsTemplate(mode = defenceLineupsMode) {
    const saved = loadDefenceTemplate(mode);
    if (!saved) return null;
    const template = JSON.parse(JSON.stringify(saved));
    template.teams = template.teams.filter(t => t && typeof t.territory === "string" && Number.isInteger(t.index) && t.index >= 0);
    template.territories = Array.isArray(template.territories) ? template.territories.filter(t => t && typeof t.territory === "string") : [];
    if (!template.territories.length) {
        template.territories = JSON.parse(JSON.stringify((boardConfig[template.league] || {})[mode] || []));
    }
    template.teams.filter(Boolean).forEach(team => {
        let territory = template.territories.find(t => t.territory === team.territory);
        if (!territory) {
            territory = { territory: team.territory, type: team.territory === "BACK_TOP" ? "FLEET" : "SQUAD", teamCount: 0 };
            template.territories.push(territory);
        }
        territory.teamCount = Math.max(territory.teamCount, team.index + 1);
    });
    template.territories.forEach(t => {
        for (let index = 0; index < t.teamCount; index++) {
            if (!defenceTemplateTeamAt(template, t.territory, index)) {
                template.teams.push({ territory: t.territory, index, name: "", customName: "" });
            }
        }
    });
    return template;
}

function closeDefenceLineupEditor() {
    if (defenceLineupEditor && defenceLineupEditor.dirty && !confirm("Discard unsaved lineup changes? Saved progress will remain.")) return false;
    defenceLineupEditor = null;
    return true;
}

function setDefenceLineupsMode(mode) {
    if (mode === defenceLineupsMode || !["5v5", "3v3"].includes(mode) || !closeDefenceLineupEditor()) return;
    defenceLineupsMode = mode;
    defenceLineupsMessage = null;
    render();
}

function setDefenceLineupsLeague(league) {
    const cfg = (boardConfig[league] || {})[defenceLineupsMode];
    if (!cfg || !cfg.length || !closeDefenceLineupEditor()) { render(); return; }
    const previous = defenceLineupsTemplate();
    if (previous && previous.teams.some(t => t.name) &&
        !confirm("Change this saved template's league/layout? Teams in matching slots are kept; slots outside the new layout are removed. Your current round will stay unchanged.")) { render(); return; }
    const teams = [];
    cfg.forEach(t => {
        for (let index = 0; index < t.teamCount; index++) {
            const saved = previous && defenceTemplateTeamAt(previous, t.territory, index);
            teams.push(saved || { territory: t.territory, index, name: "", customName: "" });
        }
    });
    const ok = persistDefenceTemplate({ schema: DEFENCE_TEMPLATE_SCHEMA, mode: defenceLineupsMode, league,
        territories: cfg.map(t => ({ ...t })), teams, updatedAt: new Date().toISOString() });
    defenceLineupsMessage = { kind: ok ? "ok" : "error", text: ok ? "Template layout saved." : "Could not save template layout. Please try again." };
    render();
}

function setDefenceLineupsIdentity(territory, index, name, customName = "") {
    const template = defenceLineupsTemplate();
    const team = template && defenceTemplateTeamAt(template, territory, index);
    if (!team || sameDefenceIdentity(team, { name, customName })) return;
    if (team.lineup !== undefined && !confirm("Change this team's identity and remove its saved unit assignments?")) { render(); return; }
    if (!closeDefenceLineupEditor()) { render(); return; }
    team.name = name;
    team.customName = name === NOT_IN_CATALOGUE ? customName.slice(0, 80) : "";
    delete team.lineup;
    template.updatedAt = new Date().toISOString();
    const ok = persistDefenceTemplate(template);
    defenceLineupsMessage = { kind: ok ? "ok" : "error", text: ok ? "Team identity saved." : "Could not save team identity. Please try again." };
    render();
}

function openDefenceLineupEditor(territory, index) {
    if (!closeDefenceLineupEditor()) return;
    const template = defenceLineupsTemplate();
    const team = template && defenceTemplateTeamAt(template, territory, index);
    if (!team || !team.name) return;
    const selected = readDefenceTemplateLineup(defenceLineupsMode, territory, index);
    const type = defenceTemplateTeamType(template, team);
    const empty = type === "FLEET" ? { capitalShipId: "", startingShipIds: [], reinforcementIds: [] } : { characterIds: [], intentionalUndersize: false };
    defenceLineupEditor = { mode: defenceLineupsMode, territory, index, identity: { name: team.name, customName: team.customName }, type,
        lineup: JSON.parse(JSON.stringify(selected && selected.source === "saved" && isPlainObject(selected.lineup) ? selected.lineup : empty)), dirty: false };
    defenceLineupsMessage = null;
    render();
}

function editDefenceLineupMember(field, index, value) {
    const editor = defenceLineupEditor;
    if (!editor) return;
    if (field === "capitalShipId") editor.lineup.capitalShipId = value;
    else if (field === "intentionalUndersize") editor.lineup.intentionalUndersize = value === true;
    else if (["characterIds", "startingShipIds", "reinforcementIds"].includes(field)) {
        if (!Array.isArray(editor.lineup[field])) editor.lineup[field] = [];
        editor.lineup[field][index] = value;
    } else return;
    editor.lineup.confirmed = false;
    editor.dirty = true;
    defenceLineupsMessage = null;
    render();
}

function defenceLineupDraft() {
    const editor = defenceLineupEditor;
    if (!editor) return null;
    const lineup = { ...editor.lineup, confirmed: false };
    ["characterIds", "startingShipIds", "reinforcementIds"].forEach(field => {
        if (Array.isArray(lineup[field])) lineup[field] = lineup[field].filter(id => id !== "");
    });
    return lineup;
}

function defenceLineupDraftValidation() {
    const editor = defenceLineupEditor;
    const template = editor && defenceLineupsTemplate(editor.mode);
    const team = template && defenceTemplateTeamAt(template, editor.territory, editor.index);
    if (!team || !sameDefenceIdentity(team, editor.identity)) return { valid: false, complete: false, errors: ["identity-mismatch"] };
    team.lineup = defenceLineupDraft();
    return validateDefenceTemplate(template).teams.find(t => t.territory === editor.territory && t.index === editor.index);
}

function useDefenceLineupProposal() {
    const editor = defenceLineupEditor;
    if (!editor || editor.type === "FLEET") return;
    const proposal = suggestDefenceLineup(editor.identity.name, editor.mode, editor.type);
    if (!proposal) return;
    editor.lineup = JSON.parse(JSON.stringify(proposal.lineup));
    editor.dirty = true;
    defenceLineupsMessage = null;
    render();
}

function clearDefenceLineupDraft() {
    const editor = defenceLineupEditor;
    if (!editor) return;
    editor.lineup = editor.type === "FLEET" ? { capitalShipId: "", startingShipIds: [], reinforcementIds: [] } : { characterIds: [], intentionalUndersize: false };
    editor.dirty = true;
    defenceLineupsMessage = null;
    render();
}

function defenceLineupErrorText(errors) {
    return [...new Set(errors.map(error => {
        if (error.startsWith("duplicate-assignment:")) return `${getCharacterName(error.slice("duplicate-assignment:".length))} is already assigned to another saved team. Remove it there before saving here.`;
        if (error === "duplicate-unit") return "A unit is selected more than once in this team.";
        if (error.startsWith("invalid-unit:")) return "A selected unit is unknown or has the wrong unit type. Replace or remove it.";
        if (error === "incomplete-lineup") return "Complete the required slots before confirming.";
        if (error === "identity-mismatch") return "The saved team identity changed. Reopen its editor.";
        if (error === "invalid-size") return "Too many members are selected. Remove the extra members.";
        return "This saved selection is invalid. Correct its members before saving.";
    }))].join(" ");
}

function saveDefenceLineupEditor(confirmLineup = false) {
    const editor = defenceLineupEditor;
    if (!editor) return;
    const result = writeDefenceTemplateLineup(editor.mode, editor.territory, editor.index, editor.identity,
        defenceLineupDraft(), { confirm: confirmLineup === true });
    if (result.ok) {
        editor.lineup = JSON.parse(JSON.stringify(readDefenceTemplateLineup(editor.mode, editor.territory, editor.index).lineup));
        editor.dirty = false;
    }
    defenceLineupsMessage = { kind: result.ok ? "ok" : "error", text: result.ok
        ? confirmLineup ? "Lineup confirmed and saved." : "Progress saved. Confirm when this lineup is ready."
        : result.errors ? defenceLineupErrorText(result.errors) : "Could not save progress. Please try again." };
    render();
}

function defenceLineupStatus(selection) {
    return selection && selection.confirmed ? "Confirmed" : selection && selection.complete ? "Needs confirmation" : "Incomplete";
}

function renderDefenceLineups() {
    const template = defenceLineupsTemplate();
    const populated = template ? template.teams.filter(t => t && t.name) : [];
    const statuses = populated.map(t => defenceLineupStatus(readDefenceTemplateLineup(defenceLineupsMode, t.territory, t.index)));
    const count = status => statuses.filter(s => s === status).length;
    const league = template && template.league || "";
    const options = LEAGUES.map(l => `<option value="${l}" ${league === l ? "selected" : ""} ${!(boardConfig[l] || {})[defenceLineupsMode] ? "disabled" : ""}>${leagueLabel(l)}</option>`).join("");
    const header = `<div class="round-card">
        <div class="round-title">🛡️ DEFENCE LINEUPS</div>
        ${board ? `<button class="more-back" onclick="setView('round')">← Back to Round</button>` : ""}
        <p class="roster-import-helper">Reusable defence for future rounds. Saving here does not change your current round. No roster import is needed.</p>
        <div class="mode-toggle" aria-label="Defence template format">${["5v5", "3v3"].map(mode => `<button class="mode-button ${mode === defenceLineupsMode ? "active" : ""}" onclick="setDefenceLineupsMode('${mode}')">${mode}</button>`).join("")}</div>
        <label class="lineup-field">League / layout<select class="board-team-select" onchange="setDefenceLineupsLeague(this.value)"><option value="">Select league…</option>${options}</select></label>
        ${template ? `<div class="round-stat">${escapeHtml(leagueLabel(league) || "Saved layout")} · ${defenceLineupsMode} · ${template.teams.length} slots including Fleet</div>` : ""}
        <div class="lineup-progress" role="status">${count("Confirmed")} / ${populated.length} populated teams confirmed · ${count("Needs confirmation")} need confirmation · ${count("Incomplete")} incomplete</div>
        ${defenceLineupsMessage ? `<div class="roster-msg roster-msg-${defenceLineupsMessage.kind}" role="status">${escapeHtml(defenceLineupsMessage.text)}</div>` : ""}
        ${renderRoundDefenceReview()}
        ${template ? `<button class="template-clear-btn" onclick="clearDefenceTemplate('${defenceLineupsMode}')">Clear saved ${defenceLineupsMode} template</button>` : ""}
    </div>`;
    if (!template || !template.territories.length) return header + `<div class="empty-state">Choose a league to create this format's saved layout.${!Object.keys(boardConfig).length ? " Board configuration has not loaded yet; refresh when connected." : ""}</div>`;
    return header + template.territories.map(t => `<div class="board-territory">
        <div class="board-territory-header"><span class="board-territory-title">${escapeHtml(TERRITORY_LABELS[t.territory] || t.territory)}${t.type === "FLEET" ? " · Fleet" : ""}</span></div>
        ${template.teams.filter(team => team.territory === t.territory).sort((a, b) => a.index - b.index).map(team => renderDefenceLineupTeam(template, t, team)).join("")}
    </div>`).join("");
}

function renderDefenceLineupTeam(template, territory, team) {
    const names = boardSelectableDefenceNames(territory.type === "FLEET" ? "FLEET" : template.mode);
    const outside = [...new Set(template.teams.filter(t => defenceTemplateTeamType(template, t) === territory.type && t.name && t.name !== NOT_IN_CATALOGUE && !names.includes(t.name)).map(t => t.name))];
    const args = `'${territory.territory}', ${team.index}`;
    const options = [`<option value="">Empty slot</option>`, `<option value="${NOT_IN_CATALOGUE}" ${team.name === NOT_IN_CATALOGUE ? "selected" : ""}>Custom / not in catalogue</option>`,
        ...outside.map(name => `<option value="${escapeHtml(name)}" ${team.name === name ? "selected" : ""}>${escapeHtml(name)} (saved; not in current catalogue)</option>`),
        ...names.map(name => `<option value="${escapeHtml(name)}" ${team.name === name ? "selected" : ""}>${escapeHtml(name)}</option>`)].join("");
    const selection = team.name && readDefenceTemplateLineup(template.mode, territory.territory, team.index);
    const editing = defenceLineupEditor && defenceLineupEditor.territory === team.territory && defenceLineupEditor.index === team.index;
    return `<div class="lineup-team">
        <label class="lineup-field">${territory.type === "FLEET" ? "Fleet" : "Team"} ${team.index + 1}<select class="board-team-select" onchange="setDefenceLineupsIdentity(${args}, this.value)">${options}</select></label>
        ${team.name === NOT_IN_CATALOGUE ? `<label class="lineup-field">Custom team name<input class="board-team-select" type="text" maxlength="80" placeholder="Optional team name" value="${escapeHtml(team.customName)}" onchange="setDefenceLineupsIdentity(${args}, '${NOT_IN_CATALOGUE}', this.value)"></label>` : ""}
        ${team.name ? `<div class="lineup-team-status">${defenceLineupStatus(selection)}</div>
            ${selection && selection.validation && !selection.validation.valid ? `<p class="roster-msg roster-msg-warn">${escapeHtml(defenceLineupErrorText(selection.validation.errors))}</p>` : ""}
            ${editing ? renderDefenceLineupEditor(selection) : `<button class="roster-data-btn" onclick="openDefenceLineupEditor(${args})">Edit lineup</button>`}` : `<div class="roster-saved-line">Empty slot</div>`}
        ${renderRoundDefenceCorrection(template.mode, team.territory, team.index)}
    </div>`;
}

function renderRoundDefenceCorrection(mode, territory, index) {
    if (!board || board.mode !== mode || !board.defenceSnapshot || board.defenceSnapshot.missingSavedDefence) return "";
    const snapshot = board.defenceSnapshot;
    const slot = snapshot.schema === 2 && defenceTemplateTeamAt({ teams: snapshot.slots }, territory, index);
    if (!slot || !slot.name) return "";
    const correction = roundDefenceCorrection(mode, territory, index);
    const label = `Current round: ${slot.customName || slot.name}`;
    if (correction.error) return `<p class="roster-saved-line">${escapeHtml(label)}. ${escapeHtml(correction.error)}</p>`;
    if (!correction.changed) return `<p class="roster-saved-line">${escapeHtml(label)} · Saved lineup matches this round.</p>`;
    return `<div class="lineup-proposal"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(defenceAvailabilityChange(correction))}</p>
        <button class="roster-data-btn" onclick="applySavedLineupToRound('${mode}', '${territory}', ${index})">Apply saved lineup to this round</button></div>`;
}

function renderRoundDefenceReview() {
    if (!board || board.mode !== defenceLineupsMode || !validDefenceSnapshot(board.defenceSnapshot, board.mode)) return "";
    const snapshot = board.defenceSnapshot;
    const adoption = savedDefenceAdoptionCandidate() ? `<div class="lineup-proposal"><p>Fill empty round identities from this format's saved defence, including slots with recorded Battles or Cleared. Existing named identities, frozen lineups and battle progress stay; attack availability will change.</p><button class="roster-data-btn" onclick="adoptSavedTemplateAsRoundDefence()">Use saved defence for this round</button></div>` : "";
    if (snapshot.missingSavedDefence || !hasLegacyDefenceReview(snapshot)) return adoption;
    const reviewed = snapshot.slots.filter(roundDefenceSlotReviewed).length;
    const empty = snapshot.slots.filter(slot => !slot.name && !roundDefenceSlotReviewed(slot)).map(slot => `<button class="roster-data-btn" onclick="reviewEmptyRoundDefenceSlot('${slot.territory}', ${slot.index})">Review empty ${escapeHtml(TERRITORY_LABELS[slot.territory] || slot.territory)} ${slot.index + 1}</button>`).join("");
    const original = `<p>${snapshot.legacySourceTeamCount > 0 ? `The original aggregate recorded ${snapshot.legacySourceTeamCount} populated teams. ` : ""}${snapshot.legacyUnresolvedTeams && snapshot.legacyUnresolvedTeams.length ? `Original unresolved identities: ${snapshot.legacyUnresolvedTeams.map(escapeHtml).join(", ")}. ` : ""}These may differ from My Board; verify the actual deployments in every slot.</p>`;
    return adoption + `<div class="lineup-proposal"><strong>Legacy defence review</strong><p>${snapshot.legacyCharacterIds.length} unattributed units remain blocked. ${reviewed} / ${snapshot.slots.length} round slots reviewed. Apply a confirmed saved lineup to each deployed slot below and explicitly review empty slots. Only a full rebaseline can release unattributed blocks.</p>${original}${empty}
        <button class="roster-data-btn" onclick="rebaselineRoundDefence()" ${canRebaselineRoundDefence(snapshot) ? "" : "disabled"}>Review complete — confirm full defence rebaseline</button></div>`;
}

function renderDefenceLineupMember(field, index, unitType, label, selected) {
    const units = Object.entries(characterDefinitions).filter(([, unit]) => unit && unit.unitType === unitType).sort(([a], [b]) => getCharacterName(a).localeCompare(getCharacterName(b)));
    const known = units.some(([id]) => id === selected);
    const options = `<option value="">Empty / remove</option>` + (selected && !known ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (unavailable / invalid)</option>` : "") +
        units.map(([id]) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(getCharacterName(id))}</option>`).join("");
    return `<label class="lineup-field">${label}<select class="board-team-select" onchange="editDefenceLineupMember('${field}', ${index}, this.value)">${options}</select></label>`;
}

function renderDefenceLineupEditor(selection) {
    const editor = defenceLineupEditor;
    const lineup = editor.lineup || {};
    const validation = defenceLineupDraftValidation();
    const fields = (field, size, type, label) => Array.from({ length: Math.max(size, Array.isArray(lineup[field]) ? lineup[field].length : 0) }, (_, index) =>
        renderDefenceLineupMember(field, index, type, `${label} ${index + 1}`, (lineup[field] || [])[index] || "")).join("");
    const members = editor.type === "FLEET"
        ? `<p class="roster-import-helper">Choose one capital ship and three starting ships. Add 0–4 reinforcements as needed.</p>${renderDefenceLineupMember("capitalShipId", 0, "CAPITAL_SHIP", "Capital ship", lineup.capitalShipId || "")}${fields("startingShipIds", 3, "SHIP", "Starting ship")}${fields("reinforcementIds", 4, "SHIP", "Reinforcement (optional)")}`
        : `${fields("characterIds", editor.mode === "3v3" ? 3 : 5, "CHARACTER", "Member")}<label class="lineup-undersize"><input type="checkbox" ${lineup.intentionalUndersize === true ? "checked" : ""} onchange="editDefenceLineupMember('intentionalUndersize', 0, this.checked)"> Intentionally deploy an undersized squad</label>`;
    const proposal = !selection || selection.source !== "saved" ? suggestDefenceLineup(editor.identity.name, editor.mode, editor.type) : null;
    const ids = proposal && (proposal.suggestedCharacterIds || proposal.lineup.characterIds);
    const proposed = proposal ? `<div class="lineup-proposal"><strong>Catalogue proposal · ${proposal.complete ? "needs your confirmation" : "incomplete"}</strong>
        <p>${(ids || []).map(id => escapeHtml(getCharacterName(id))).join(", ") || "No members supplied."}</p>
        <p>${editor.type === "FLEET" ? "Starting and reinforcement roles are unknown. Assign the proposed ships to roles above." : proposal.complete ? "Review every member before confirming." : "This is a partial or invalid proposal. Fill the remaining slots or deliberately choose undersizing."}</p>
        ${editor.type !== "FLEET" ? `<button class="roster-data-btn" onclick="useDefenceLineupProposal()">Use proposal in draft</button>` : ""}</div>` : "";
    return `<div class="lineup-editor"><div class="roster-saved-line">${selection && selection.source === "saved" ? "Saved player assignments" : "No saved player assignments"}${editor.dirty ? " · Unsaved changes" : ""}</div>
        ${members}${proposed}
        <div class="roster-msg ${validation.valid ? "roster-msg-warn" : "roster-msg-error"}" role="status">${validation.valid ? validation.complete ? "Ready to confirm." : "Incomplete — you can save progress and finish later." : escapeHtml(defenceLineupErrorText(validation.errors))}</div>
        <div class="lineup-actions"><button class="roster-data-btn" onclick="saveDefenceLineupEditor()" ${!validation.valid ? "disabled" : ""}>Save progress</button><button class="roster-data-btn roster-undo-btn" onclick="saveDefenceLineupEditor(true)" ${!validation.valid || !validation.complete ? "disabled" : ""}>Confirm lineup</button></div>
        <div class="lineup-actions"><button class="more-back" onclick="clearDefenceLineupDraft()">Clear members in draft</button><button class="more-back" onclick="if (closeDefenceLineupEditor()) render()">Close editor</button></div>
    </div>`;
}

// ─── COUNTERS VIEW ───────────────────────────────────────────────────────────

function renderCounters() {

    const modeHasData = Object.keys(gacData[currentMode] || {}).length > 0;

    const teams = Object.keys(gacData[currentMode] || {})
        .filter(team => team.toLowerCase().includes(searchText.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    const header = `
<div class="round-card">
    <div class="round-title">🏆 CURRENT ROUND</div>
    <div class="round-stat">Used Teams: ${getUsedTeamCount()}</div>
    <div class="roster-saved-line">Round tracking and reset live on the Round screen.</div>
</div>

<div class="mode-toggle">
    <button class="mode-button ${currentMode === "5v5"   ? "active" : ""}" onclick="setMode('5v5')">5v5</button>
    <button class="mode-button ${currentMode === "3v3"   ? "active" : ""}" onclick="setMode('3v3')">3v3</button>
    <button class="mode-button ${currentMode === "FLEET" ? "active" : ""}" onclick="setMode('FLEET')">Fleet</button>
</div>
`;

    // A mode with no counter data yet (Fleet, until fleet counters are authored)
    // shows a plain message instead of an empty dropdown and blank results.
    if (!modeHasData) {
        const emptyMsg = currentMode === "FLEET"
            ? "No fleet counters have been added yet. Once fleet data is in the sheet, your fleet counters will appear here."
            : "No defence teams found for this mode yet.";
        return header + `<div class="empty-state">${emptyMsg}</div>`;
    }

    return header + `
<input
    type="text"
    id="searchBox"
    class="search-box"
    placeholder="Search defence team..."
    value="${searchText}"
    oninput="updateSearch(this.value)"
>

<select id="teamSelect" class="team-select" onchange="showCounters()">
    ${teams.map(team => `<option value="${team}">${team}</option>`).join("")}
</select>

<div class="counter-filter">
    <button class="counter-filter-btn ${counterFilter === "all"       ? "active" : ""}" data-filter="all"       onclick="setCounterFilter('all')">All</button>
    <button class="counter-filter-btn ${counterFilter === "owned"     ? "active" : ""}" data-filter="owned"     onclick="setCounterFilter('owned')">Owned</button>
    <button class="counter-filter-btn ${counterFilter === "available" ? "active" : ""}" data-filter="available" onclick="setCounterFilter('available')">Available</button>
</div>

<div id="results"></div>
`;
}

function setCounterFilter(filter) {
    counterFilter = filter;
    localStorage.setItem("counterFilter", filter);

    document.querySelectorAll(".counter-filter-btn").forEach(btn => btn.classList.remove("active"));
    const activeBtn = document.querySelector(`.counter-filter-btn[data-filter="${filter}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    showCounters();
}

function setMode(mode) {
    currentMode = mode;
    if (mode === "5v5" || mode === "3v3") {
        lastSquadMode = mode;
        localStorage.setItem(LAST_SQUAD_MODE_KEY, mode);
    }
    render();
}

function updateSearch(value) {
    searchText = value;

    const teamSelect = document.getElementById("teamSelect");
    if (!teamSelect) return;

    const teams = Object.keys(gacData[currentMode] || {})
        .filter(team => team.toLowerCase().includes(searchText.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    teamSelect.innerHTML =
        teams.map(team => `<option value="${team}">${team}</option>`).join("");

    showCounters();
}

function markUsed(counterId) {
    if (!usedTeams.includes(counterId)) {
        recordAttackUsage(counterId);
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    showCounters();
}

function resetRound() {
    const confirmed = confirm("Reset the round? This clears used teams, banner tracking, Opponent Board, and My Board. Your saved defence templates are kept.");
    if (!confirmed) return;

    usedTeams = [];
    localStorage.removeItem("usedTeams");

    bannerData = { myScore: 0, oppScore: 0, remaining: null, oppFinal: false, scoresPrefilled: false };
    localStorage.removeItem("bannerData");

    discardBoard();
    lastBattleFleetCapital = null;

    render();
}

// ─── COUNTER CARD ─────────────────────────────────────────────────────────────

function buildCounterCardHtml(counter) {
    const status = getCounterStatus(counter.counterId);
    const ownership = getOwnership(counter.counterId);

    const statusClass = status === "available" ? "status-available" : "status-muted";
    const statusText  = status === "available" ? "Available"
                      : status === "used"      ? "Used"
                      : status === "on-defence" ? "On defence"
                      : status === "spent"     ? "Unavailable"
                      : "Not owned";

    const dimClass = status === "available" ? "" : "used";

    // v3.2: an owned, unused counter can still be unfieldable because a unit it
    // requires went out with an earlier counter. Say which unit and with what,
    // otherwise a greyed card with no missing-units line looks like a bug.
    const spentNote = status === "spent" ? spentReason(counter.counterId) : null;
    const defenceNote = status === "on-defence" ? defenceReason(counter.counterId) : null;

    // A tactical entry has no tier, banners or undersize to show: its role badge
    // and one plain line about what the battle is for take their place.
    const tactical = isTacticalEntry(counter);
    const badge = tactical
        ? `<span class="tier-badge role-badge">${TACTICAL_ROLES[counter.role]}</span>`
        : `<span class="tier-badge" style="background:${getTierColour(counter.tier)};">
            ${counter.tier}
        </span>`;

    return `
<div class="counter-card ${tactical ? "tactical-card " : ""}${dimClass}">

    <div class="card-header">
        <div class="team-name">${counter.counter}</div>
        <span class="${statusClass}">${statusText}</span>
        ${badge}
    </div>

    ${tactical ? `<div>🧭 <strong>Role:</strong> ${counter.role === "SETUP"
        ? "weakening battle — not expected to win. Plan a second team to finish the defence."
        : "conditional cleanup — only after an earlier battle has weakened this defence. Not a fresh-team counter."}</div>` : `
    <div>🎯 <strong>Expected Banners:</strong> ${counter.bannerScore || "-"}</div>
    ${(() => {
        const fleet = currentMode === "FLEET";
        const us = undersizeInfo(counter, fleet);
        return us
            ? (us.fleet
                ? `<div>👥 <strong>Undersize:</strong> ${fleetUndersizeText(us)}</div>`
                : `<div>👥 <strong>Undersize:</strong> drop up to ${us.drop} → ${us.total} banners (+${us.bonus})</div>`)
            : `<div>👥 <strong>Undersize:</strong> ${fleet ? "full fleet" : "full squad"}</div>`;
    })()}`}

    <div>
        📝 <strong>Notes:</strong> ${counter.notes || "-"}
        ${!ownership.owned ? `
        <div style="margin-top:6px;">
            ❌ <strong>Missing:</strong>
            ${ownership.missing.map(id => getCharacterName(id)).join(", ")}
        </div>` : ""}
        ${spentNote ? `
        <div style="margin-top:6px;">
            🔒 <strong>Units spent:</strong> ${spentNote}
        </div>` : ""}
        ${defenceNote ? `
        <div style="margin-top:6px;">
            🛡️ <strong>On defence:</strong> ${defenceNote}
        </div>` : ""}
    </div>

    ${status === "available"
        ? `<button class="mark-used-button" onclick="markUsed('${counter.counterId}')">Mark Used</button>`
        : ""
    }

</div>
`;
}

// ─── SORT ─────────────────────────────────────────────────────────────────────

function tierSortValue(tier) {
    return { "S": 1, "A": 2, "B": 3, "C": 4 }[tier?.toUpperCase()] || 99;
}

function sortCounters(counters) {
    const groupRank = { "available": 1, "used": 2, "on-defence": 3, "spent": 4, "not-owned": 5 };

    return [...counters].sort((a, b) => {
        const statusA = getCounterStatus(a.counterId);
        const statusB = getCounterStatus(b.counterId);

        const groupDiff = groupRank[statusA] - groupRank[statusB];
        if (groupDiff !== 0) return groupDiff;

        const tierDiff = tierSortValue(a.tier) - tierSortValue(b.tier);
        if (tierDiff !== 0) return tierDiff;

        return Number(b.bannerScore || 0) - Number(a.bannerScore || 0);
    });
}

// ─── SHOW COUNTERS ────────────────────────────────────────────────────────────

function showCounters() {

    const teamSelect = document.getElementById("teamSelect");
    if (!teamSelect) return;

    const resultsEl = document.getElementById("results");

    if (teamSelect.options.length === 0) {
        resultsEl.innerHTML = "<p class='empty-state'>No matching defence teams found.</p>";
        return;
    }

    const team = teamSelect.value;
    if (!team) return;

    const listed = (gacData[currentMode] && gacData[currentMode][team]) || [];
    const allCounters = sortCounters(oneShotCounters(listed));

    if (!hasRoster() && counterFilter !== "all") {
        resultsEl.innerHTML =
            "<p class='empty-state'>Set up your roster to see which counters you can field.</p>";
        return;
    }

    // Tactical steps follow the same filter but keep their authored order, so a
    // setup battle reads before the cleanup that depends on it.
    const keep = c => counterFilter === "all" ||
        (counterFilter === "owned" ? getCounterStatus(c.counterId) !== "not-owned"
                                   : getCounterStatus(c.counterId) === "available");
    const filtered = allCounters.filter(keep);
    const tactics = tacticalEntries(listed).filter(keep);

    let html;
    if (filtered.length) {
        html = filtered.map(buildCounterCardHtml).join("");
    } else if (allCounters.length === 0) {
        html = tactics.length ? "<p class='empty-state'>No one-shot counters are catalogued for this team.</p>" : "";
    } else if (counterFilter === "owned") {
        html = "<p class='empty-state'>You don't own any counters for this team.</p>";
    } else {
        const ownsAny  = allCounters.some(c => getOwnership(c.counterId).owned);
        const anyOnDefence = allCounters.some(c => getCounterStatus(c.counterId) === "on-defence");
        const anySpent = allCounters.some(c => getCounterStatus(c.counterId) === "spent");
        html = !ownsAny
            ? "<p class='empty-state'>You don't own any counters for this team.</p>"
            : anyOnDefence
                ? "<p class='empty-state'>Your remaining counters for this team are committed to defence.</p>"
            : anySpent
                ? "<p class='empty-state'>Your remaining counters for this team need units you've already used this round.</p>"
                : "<p class='empty-state'>You've used all your counters for this team.</p>";
    }

    if (tactics.length) {
        html += `
<div class="tactics-section">
    <div class="tactics-heading">Multi-battle options</div>
    <p class="tactics-intro">Not one-shot counters: no tier or expected banners, and Round Mode never assigns them.</p>
    ${tactics.map(buildCounterCardHtml).join("")}
</div>`;
    }

    resultsEl.innerHTML = html;
}

// ─── ROUND VIEW (v2.1) ────────────────────────────────────────────────────────

function renderRound() {
    const defenceStatus = renderDefenceSnapshotStatus();
    const summary = `
<div class="round-card">
    <div class="round-card-row">
        <div>
            <div class="round-title">🏆 CURRENT ROUND</div>
            <div class="round-stat">Used Teams: ${getUsedTeamCount()}</div>
            ${defenceStatus}
            ${renderUsageRecordingStatus()}
        </div>
        <button class="reset-button-inline" onclick="resetRound()">Reset Round</button>
    </div>
</div>
`;

    const boardHtml = board
        ? renderBoardSwitch() + (activeBoardSide === "my" ? renderMyBoard() : renderBoard())
        : renderBoardSetup();

    return summary + boardHtml + renderBannerSection();
}

function renderDefenceSnapshotStatus() {
    if (!board || !validDefenceSnapshot(board.defenceSnapshot, board.mode)) return "";
    const snapshot = board.defenceSnapshot;
    const lineupsLink = `<button class="defence-adopt-btn" onclick="openRoundDefenceLineups()">Review / correct ${board.mode} Defence Lineups</button>`;
    if (snapshot.missingSavedDefence) {
        const canAdopt = myBoard && myBoard.teams.some(t => t && t.name);
        const action = canAdopt
            ? `<button class="defence-adopt-btn" onclick="adoptMyBoardAsRoundDefence()">Use My Board as this round's defence</button>`
            : "";
        const savedAction = savedDefenceAdoptionCandidate() ? `<button class="defence-adopt-btn" onclick="adoptSavedTemplateAsRoundDefence()">Use saved defence for this round</button>` : "";
        return `<div class="roster-msg roster-msg-warn round-defence-status">No saved ${board.mode} defence when this round started — defence availability is not being filtered.${action}${savedAction}${lineupsLink}</div>`;
    }
    const count = snapshot.characterIds.length;
    const summary = `<div class="round-stat">Defence: ${count} unit${count === 1 ? "" : "s"} unavailable</div>`;
    const legacy = hasLegacyDefenceReview(snapshot)
        ? `<div class="roster-msg roster-msg-warn round-defence-status">${snapshot.legacyCharacterIds.length ? `${snapshot.legacyCharacterIds.length} legacy defence units have no slot attribution and remain blocked.` : "Legacy defence deployments remain unverified, with no known unit IDs."} Review all round slots in More → Defence Lineups before a full rebaseline.</div>` : "";
    const missingIdentities = snapshot.schema === 2 && myBoard ? snapshot.slots.filter(slot => {
        const live = defenceTemplateTeamAt(myBoard, slot.territory, slot.index);
        return !slot.name && live && (live.name || live.attempts > 0 || live.cleared);
    }).length : 0;
    const savedAction = savedDefenceAdoptionCandidate() ? `<button class="defence-adopt-btn" onclick="adoptSavedTemplateAsRoundDefence()">Use saved defence for this round</button>` : "";
    const n = snapshot.unresolvedTeams.length + missingIdentities;
    if (!n) return summary + legacy + lineupsLink;
    return summary + legacy + `<div class="roster-msg roster-msg-warn round-defence-status">${n} defence team${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} lineup details. ${missingIdentities ? `${missingIdentities} round slot${missingIdentities === 1 ? " needs" : "s need"} an applied identity. ` : ""}Some characters may still appear available for attack.${lineupsLink}${savedAction}</div>`;
}

function renderBoardSwitch() {
    return `
<div class="mode-toggle round-board-switch" aria-label="Round board">
    <button class="mode-button ${activeBoardSide === "opponent" ? "active" : ""}" onclick="setBoardSide('opponent')">Opponent Board</button>
    <button class="mode-button ${activeBoardSide === "my" ? "active" : ""}" onclick="setBoardSide('my')">My Board</button>
</div>
`;
}

function renderBoardSetup() {
    const configLoaded = Object.keys(boardConfig).length > 0;

    const options = LEAGUES.map(l =>
        `<option value="${l}" ${leagueDraft === l ? "selected" : ""}>${leagueLabel(l)}</option>`
    ).join("");

    const settingDefence = settingDefenceRule();
    const warning = !configLoaded
        ? `<div class="roster-msg roster-msg-warn">Board configuration hasn't loaded yet — check your connection and refresh.</div>`
        : !settingDefence.ok
            ? `<div class="roster-msg roster-msg-warn">${settingDefence.message}</div>`
            : "";

    const fmt = boardMode();

    // A round owns its own GAC format, chosen explicitly here rather than
    // inherited live from the Counters screen toggle (see boardMode/setView).
    const formatBlock = `
    <div class="round-format-label">GAC format</div>
    <div class="mode-toggle board-format-choice" aria-label="GAC format">
        <button class="mode-button ${fmt === "5v5" ? "active" : ""}" onclick="setBoardModeDraft('5v5')">5v5</button>
        <button class="mode-button ${fmt === "3v3" ? "active" : ""}" onclick="setBoardModeDraft('3v3')">3v3</button>
    </div>
    <div class="roster-import-helper">
        Choose your league, then set up both current-round boards. Opponent Board starts empty; My Board is filled from your saved ${fmt} defence template.
    </div>`;

    const templateControl = `<button class="defence-adopt-btn" onclick="defenceLineupsMode = '${fmt}'; setView('defence-lineups')">Manage ${fmt} Defence Lineups</button>`;

    return `
<div class="board-setup-card">
    <div class="roster-import-title">🗺️ SET UP ROUND</div>
    ${formatBlock}
    ${warning}
    <select class="team-select board-league-select" onchange="setLeague(this.value)">
        <option value="" ${!leagueDraft ? "selected" : ""}>Select league…</option>
        ${options}
    </select>
    <button class="roster-data-btn roster-import-btn" onclick="createBoard()" ${(!leagueDraft || !configLoaded || !settingDefence.ok) ? "disabled" : ""}>
        Set up both boards
    </button>
    ${templateControl}
</div>
`;
}

function renderBoard() {
    roundPlan = computeRoundPlan();   // live re-solve: falls out of render-on-state-change
    const pendingUndoHtml = focusedTeamKey && pendingUndo && pendingUndo.side === "opponent"
        ? ""
        : renderPendingUndo("opponent");

    const overlapBanner = roundPlan && roundPlan.overlap
        ? `<div class="roster-msg roster-msg-ok board-overlap">🔀 Shared counters detected — recommendations below account for the overlap.</div>`
        : "";

    const header = `
<div class="round-card">
    <div class="round-title">🗺️ OPPONENT BOARD</div>
    <div class="round-stat">${leagueLabel(board.league)} · ${board.mode}</div>
</div>
`;
    const territories = board.territories.map(t => renderTerritory(t, board, "opponent")).join("");
    // Next Up sits at the very top of the board so it is the first thing seen
    // on entering the Round screen mid-match.
    // The Last Battle advisor, when it applies, leads the board: it is the one
    // decision left on it.
    return renderLastBattle() + renderNextUp() + header + pendingUndoHtml + overlapBanner + territories;
}

function renderMyBoard() {
    const header = `
<div class="round-card">
    <div class="round-card-row">
        <div>
            <div class="round-title">🛡️ MY BOARD</div>
            <div class="round-stat">${leagueLabel(myBoard.league)} · ${myBoard.mode}</div>
            <div class="roster-saved-line">Frozen defence for this round. Track the opponent's Battles and Cleared here; manage lineups in More.</div>
        </div>
    </div>
</div>
`;
    // The opponent can eventually reach every territory, so My Board always shows
    // all four, including back territories that are not yet unlocked in game.
    return header + renderPendingUndo("my") + myBoard.territories.map(t => renderTerritory(t, myBoard, "my")).join("");
}

// Temporary Undo toast for the Cleared / Used + Cleared action that produced it
// (v3.4). Only ever shows on the board it actually changed, and disappears on
// its own once PENDING_UNDO_WINDOW_MS elapses — see setPendingUndo.
function renderPendingUndo(side) {
    if (!pendingUndo || pendingUndo.side !== side) return "";
    return `
<div class="roster-msg roster-msg-ok board-undo-notice">
    <span>${pendingUndo.message}</span>
    <button class="board-undo-btn" onclick="undoPendingAction()">Undo</button>
</div>
`;
}

function renderTerritory(tDef, bd, side) {
    const label = TERRITORY_LABELS[tDef.territory] || tDef.territory;
    const isFleet = tDef.type === "FLEET";
    const icon = isFleet ? "🚀 " : "";
    const unit = isFleet ? "fleet" : "team";

    if (side !== "my" && !isTerritoryUnlocked(tDef, bd)) {
        const frontLabel = TERRITORY_LABELS["FRONT_" + tDef.territory.slice(5)] || "the front territory";
        return `
<div class="board-territory locked">
    <div class="board-territory-header">
        <span class="board-territory-title">🔒 ${label.toUpperCase()}</span>
        <span class="board-territory-progress">${tDef.teamCount} ${unit}${tDef.teamCount === 1 ? "" : "s"}</span>
    </div>
    <div class="board-locked-note">Locked — clear ${frontLabel} to reveal these ${unit}s.</div>
</div>
`;
    }

    const teams = teamsInTerritory(tDef.territory, bd);
    const clearedCount = teams.filter(t => t.cleared).length;
    const allCleared = clearedCount === teams.length && teams.length > 0;

    const clearBtn = allCleared
        ? `<span class="status-available">Cleared ✓</span>`
        : `<button class="clear-territory-btn" onclick="clearTerritory('${side}', '${tDef.territory}')">Clear territory</button>`;

    return `
<div class="board-territory">
    <div class="board-territory-header">
        <span class="board-territory-title">${icon}${label.toUpperCase()}</span>
        <span class="board-territory-progress">${clearedCount}/${teams.length} cleared</span>
        ${clearBtn}
    </div>
    ${teams.map(t => renderBoardTeamRow(tDef, t, bd, side)).join("")}
</div>
`;
}

// A defence can be selected on a Round board even when no attacking counters
// have yet been documented against it. Keep identities mode-specific: ANY
// threat ratings are not squad/fleet identities and must not leak across modes.
function boardSelectableDefenceNames(modeKey) {
    return [...new Set([
        ...Object.keys(gacData[modeKey] || {}),
        ...Object.keys(defenceTeams[modeKey] || {}),
        ...Object.keys(defenceCompositions[modeKey] || {})
    ])].sort((a, b) => a.localeCompare(b));
}

function renderBoardTeamRow(tDef, team, bd, side) {
    const territoryKey = tDef.territory;
    const modeKey = territoryModeKey(tDef, bd);
    const teamNames = boardSelectableDefenceNames(modeKey);
    const savedOutsideCatalogue = team.name && team.name !== NOT_IN_CATALOGUE && !teamNames.includes(team.name)
        ? `<option value="${escapeHtml(team.name)}" selected>${escapeHtml(team.name)} (saved; not in current catalogue)</option>`
        : "";

    const options = [
        `<option value="" ${team.name === "" ? "selected" : ""}>Select ${tDef.type === "FLEET" ? "fleet" : "team"}…</option>`,
        `<option value="${NOT_IN_CATALOGUE}" ${team.name === NOT_IN_CATALOGUE ? "selected" : ""}>Not in catalogue</option>`,
        savedOutsideCatalogue,
        ...teamNames.map(n => `<option value="${escapeHtml(n)}" ${team.name === n ? "selected" : ""}>${escapeHtml(n)}</option>`)
    ].filter(Boolean).join("");

    // The picker, its battles stepper and its recommendation are wrapped in one
    // block so the Next Up card can scroll to and highlight the whole group.
    const isFocused = side !== "my" && focusedTeamKey === territoryKey + ":" + team.index;
    const focusClass = isFocused ? (focusFlash ? "focused focus-flash" : "focused") : "";
    const pendingUndoHtml = isFocused && pendingUndo && pendingUndo.side === side
        ? renderPendingUndo(side)
        : "";
    const customName = team.name === NOT_IN_CATALOGUE ? `
<input class="board-custom-name" type="text" maxlength="80" placeholder="Optional team name"
    value="${escapeHtml(team.customName || "")}" oninput="setCustomTeamName('${side}', '${territoryKey}', ${team.index}, this.value)">
` : "";

    const frozenSlot = side === "my" && board && board.defenceSnapshot && board.defenceSnapshot.schema === 2
        ? defenceTemplateTeamAt({ teams: board.defenceSnapshot.slots }, territoryKey, team.index) : null;
    const identity = frozenSlot || team;
    const identityControl = side === "my"
        ? `<div class="board-team-select">${escapeHtml(identity.name === NOT_IN_CATALOGUE ? identity.customName || "Not in catalogue" : identity.name || "Empty defence slot")}${identity.name && identity.name !== NOT_IN_CATALOGUE && !teamNames.includes(identity.name) ? " (saved; not in current catalogue)" : ""}</div>`
        : `<select class="board-team-select" onchange="setBoardTeam('${side}', '${territoryKey}', ${team.index}, this.value)">${options}</select>`;

    return `
${pendingUndoHtml}
<div class="board-team-block ${focusClass}" id="teamblock-${territoryKey}-${team.index}">
<div class="board-team ${team.cleared ? "cleared" : ""}">
    ${identityControl}
    <button class="board-cleared-btn ${team.cleared ? "on" : ""}" onclick="toggleTeamCleared('${side}', '${territoryKey}', ${team.index})">
        ${team.cleared ? "✓ Cleared" : "Cleared"}
    </button>
</div>
${side === "my" ? "" : customName}
${team.cleared ? "" : renderAttemptControl(side, territoryKey, team)}
${side === "my" ? "" : renderTeamRecommendation(side, territoryKey, team, modeKey)}
</div>
`;
}

// ─── NEXT UP CARD (v3.0, first-attack mode v3.1) ──────────────────────────────
// One row while only squads are in play, two once the fleet territory unlocks.
// Deliberately carries NO "Mark used" button: that action lives on the team card
// itself, in one place, so there is never a question of which button did what.
//
// For the round's opening battle the card retitles to FIRST ATTACK and the row
// switches to opener framing — a different objective deserves to say so plainly
// rather than silently changing what the same-looking card means.

function renderNextUp() {
    if (!board || !roundPlan) return "";

    const order = computeBattleOrder(roundPlan);

    const rows = [];
    if (order.squad) rows.push(renderNextUpRow(order.squad, false));
    if (order.fleet) rows.push(renderNextUpRow(order.fleet, true));

    // Opener framing applies only when there is actually an opening battle to
    // recommend; the empty states keep the ordinary title.
    const opening = order.firstAttack && !!order.squad;
    const title = opening ? "⚡ FIRST ATTACK" : "⚡ NEXT UP";

    if (rows.length === 0) {
        const msg = order.anyNamed
            ? "Nothing on the board has a counter ready right now — the note under each team explains why."
            : "Pick the opponent's defence teams below and the next battle will appear here.";
        return `
<div class="nextup-card">
    <div class="nextup-title">⚡ NEXT UP</div>
    <div class="nextup-empty">${msg}</div>
</div>
`;
    }

    return `
<div class="nextup-card ${opening ? "nextup-card-opener" : ""}">
    <div class="nextup-title">${title}</div>
    ${rows.join("")}
</div>
`;
}

function renderNextUpRow(pick, isFleet) {
    const label = TERRITORY_LABELS[pick.territory] || pick.territory;
    const c = pick.counter;
    const track = isFleet ? `<span class="nextup-track">🚀 FLEET</span>` : "";
    const opener = pick.isOpener === true;

    // Undersize advice is deliberately suppressed on the opening battle: dropping
    // units banks more, but it is the one battle where the extra risk can cost the
    // one-off bonus. The row says to field the full squad instead.
    const us = opener ? null : undersizeInfo(c, isFleet);
    const undersizeLine = !us ? ""
        : us.fleet
        ? `<div class="nextup-undersize">Undersize: ${fleetUndersizeText(us)}</div>`
        : `<div class="nextup-undersize">${us.total} banners if you undersize · drop up to ${us.drop}</div>`;

    const openerNote = opener
        ? `<div class="nextup-opener-note">First attack of the round — the bonus is paid once, whatever happens. Play this one full squad.</div>`
        : "";

    const risk = allocationRiskText(roundPlan, pick.territory + ":" + pick.index);
    const warnings = [opener && pick.warning, risk].filter(Boolean);
    const warningLine = warnings.length
        ? `<div class="nextup-warning" role="note">⚠ ${warnings.map(escapeHtml).join(" ")}</div>` : "";

    return `
<button class="nextup-row ${opener ? "nextup-row-opener" : ""}" onclick="focusBoardTeam('${pick.territory}', ${pick.index})">
    <div class="nextup-target">${track}${escapeHtml(label)} · ${escapeHtml(pick.name)}</div>
    <div class="nextup-counter">
        🎯 <strong>${escapeHtml(c.counter)}</strong>
        <span class="tier-badge tier-badge-small" style="background:${getTierColour(c.tier)};">${escapeHtml(c.tier)}</span>
        <span class="nextup-banners">~${c.bannerScore || "?"} banners</span>
    </div>
    <div class="nextup-reason">${escapeHtml(pick.reason)}</div>${undersizeLine}${openerNote}${warningLine}
</button>
`;
}

// ─── LAST BATTLE ADVISOR ──────────────────────────────────────────────────────
// Round Mode presentation of the Last Battle engine. It appears automatically at
// the top of Opponent Board when exactly one defence there is uncleared, and is
// rebuilt on every render plus in place while a score is typed (see
// recomputeBannerReadouts), so it never holds stale advice. Only the disclosure's
// open state is kept, in memory; nothing about the advisor is persisted.
let lastBattleDetailsOpen = false;
// The attacking capital ship's stars for a fleet last battle ("7" | "5-6"), or
// null for not sure. Asked on the card itself, in memory only, and cleared by
// Reset Round — the app does not otherwise know capital-ship stars.
let lastBattleFleetCapital = null;

function setLastBattleFleetCapital(value) {
    lastBattleFleetCapital = value === "7" || value === "5-6" ? value : null;
    refreshLastBattleInPlace();
}

function signed(n) {
    return n > 0 ? `+${n}` : `${n}`;
}

function rangeText(low, high) {
    return low === high ? `${low}` : `${low}–${high}`;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function lastBattleTargetLabel(adv) {
    const t = adv.target;
    const name = !t.name ? "Defence not picked yet"
        : t.name === NOT_IN_CATALOGUE ? (t.customName || "Not in catalogue")
        : t.name;
    return `${TERRITORY_LABELS[t.territory] || t.territory} · ${escapeHtml(name)}`;
}

// The headline and its supporting line, by verdict. Every phrase names whether
// the opponent's score is final or current; nothing claims the round is won
// unless their score is final and already passed.
function lastBattleHeadline(adv) {
    const basis = adv.scores.oppFinal ? "their final score" : "their current score";
    const b = adv.bonusesOnClear;
    const clearParts = [`territory clear ${b.territoryClear}`];
    if (b.firstAttack) clearParts.push(`first attack ${b.firstAttack}`);
    const clearText = `${b.total} from clearing (${clearParts.join(" + ")})`;
    const need = adv.targetToBeatCurrent;
    const bt = adv.battleTarget;
    const max = rangeText(adv.ceilings.max.low, adv.ceilings.max.high);
    // A fleet can theoretically go higher through empty slots not confirmed to
    // score; say so rather than present the confirmed ceiling as the limit.
    const theo = adv.ceilings.theoreticalMax;
    const beyond = adv.verdict === "uncertain" && theo.high > adv.ceilings.max.high
        ? ` (up to ${theo.high} only if empty starting slots score — unconfirmed)` : "";

    switch (adv.verdict) {
        case "alreadyAhead": {
            const lead = adv.scores.my - adv.scores.opp;
            return adv.aheadOf === "final"
                ? { cls: "ahead", head: `Ahead of their final score by ${lead}`, support: "You finish ahead whatever this battle does." }
                : { cls: "ahead", head: `Ahead of their current score by ${lead}`, support: "Their score is not marked final and may still rise. Clearing this defence would add " + b.total + "." };
        }
        case "coveredByClear":
            return { cls: "ahead", head: "Any win passes " + basis,
                support: `You need ${need}; ${clearText} covers it on its own.` };
        case "anyWin":
            return { cls: "ahead", head: "Any win passes " + basis,
                support: `You need ${need} = ${clearText} + ${bt} from the battle. Even a scrappy win banks at least ${rangeText(adv.ceilings.minWin.low, adv.ceilings.minWin.high)}.` };
        case "impossible":
            return { cls: "behind", head: `Can't pass ${basis}`,
                support: `You need ${need} = ${clearText} + ${bt} from the battle, but the best this battle can bank is ${rangeText(theo.low, theo.high)}.` };
        default:
            return { cls: adv.verdict === "uncertain" ? "behind" : "",
                head: `Need ${bt} battle banners`,
                support: `To pass ${basis}: ${need} = ${clearText} + ${bt} from the battle. Best possible: ${max}${beyond}.` };
    }
}

// Plain-English conditions for the battle, only where the maths supports them.
function lastBattleConditions(adv, assigned) {
    const lines = [];
    const fleet = adv.target.battleType === "FLEET";
    const needsPlay = adv.verdict === "needsBattle" || adv.verdict === "uncertain";

    if (adv.verdict === "impossible" || adv.verdict === "alreadyAhead") return lines;

    if (needsPlay) {
        const full = adv.formations[0];
        // Same maths for a squad and a fleet; only the nouns differ. A fleet with
        // unknown capital-ship stars reads its worst case (the 4th reinforcement
        // slot locked) as "low", so these allowances stay conservative.
        const noun = fleet ? "Full fleet" : "Full squad";
        const unit = fleet ? "ship" : "unit";
        if (full.meets === "no") {
            lines.push(`A ${fleet ? "full fleet" : "full squad"} tops out at ${full.maxHigh} — ${adv.battleTarget - full.maxHigh} short.`);
        } else if (full.flawlessRequired) {
            lines.push(`${noun}: it must be flawless — every ${unit} alive at full health and protection.`);
        } else if (full.meets === "yes") {
            const slack = full.allowanceLow;
            lines.push(full.unitsCanLose > 0
                ? `${noun}: you can afford to lose ${slack} banner${slack === 1 ? "" : "s"} — up to ${plural(full.unitsCanLose, unit)} (${adv.unitCost} each) or ${slack} missing health/protection bonuses.`
                : `${noun}: keep ${fleet ? "every ship" : `all ${full.fielded} units`} alive; you can afford ${slack} missing health/protection bonus${slack === 1 ? "" : "es"}.`);
        } else if (fleet && !adv.fleetCapacity.capital) {
            lines.push(`${noun}: tops out between ${full.maxLow} and ${full.maxHigh} — set your capital ship's stars to narrow it.`);
        } else {
            lines.push(`${noun}: reachable only if earlier battles left few enemies defeated — between ${full.maxLow} and ${full.maxHigh}.`);
        }

        // Undersize: show the smallest drop that adds what the full line-up lacks,
        // and whether any available catalogued counter documents it as safe. Only
        // drops into slots confirmed to score (for a fleet, unlocked reinforcement
        // slots) are suggested.
        if (full.meets !== "yes" || full.flawlessRequired) {
            const drops = adv.formations.filter(f => f.mathematicalOnly && f.slotRuleConfirmed && f.meets === "yes");
            const better = drops.find(f => !f.flawlessRequired) || drops[0];
            if (better) {
                const backed = (adv.counters || []).filter(c => c.available && c.documentedDrop >= better.emptySlots);
                const support = fleet && !adv.fleetCapacity.capital
                    ? "Set your capital ship's stars to check which counters document it."
                    : backed.length
                    ? `Documented as safe to drop ${better.emptySlots}: ${backed.map(c => escapeHtml(c.name)).join(", ")}.`
                    : `No available catalogued counter is documented as safe to drop ${better.emptySlots} — unverified.`;
                const formation = fleet
                    ? `Leave ${plural(better.emptySlots, "reinforcement slot")} empty`
                    : `Field ${better.fielded}, leave ${plural(better.emptySlots, "slot")} empty`;
                lines.push(`${formation}: ceiling ${better.maxLow} (${signed(better.emptySlots)}), ${better.flawlessRequired ? "flawless required" : `${better.allowanceLow} to spare`}. ${support}`);
            }
        }

        if (adv.target.attemptNumber === 1 || adv.ceilings.nextAttemptMax < adv.battleTarget) {
            lines.push(adv.ceilings.nextAttemptMax < adv.battleTarget
                ? `Win this attempt: a loss leaves the next attempt peaking at ${adv.ceilings.nextAttemptMax}.`
                : `Winning first time matters: a loss drops the ceiling to ${adv.ceilings.nextAttemptMax}.`);
        }
    }

    if (assigned && adv.counters) {
        const pick = adv.counters.find(c => c.counterId === assigned.counterId);
        if (pick && pick.expected !== null && adv.battleTarget > 0) {
            lines.push(`Recommended ${escapeHtml(pick.name)}: expected ~${pick.expected} (estimate, not a guarantee) — ${pick.expectedMeets ? "on track" : `${adv.battleTarget - pick.expected} short of the target on a typical clear`}.`);
        }
    }
    return lines;
}

function lastBattleCounterRows(adv) {
    if (!adv.target.name || adv.target.name === NOT_IN_CATALOGUE) {
        return `<div class="lb-note">Pick this defence from the catalogue to see counter options.</div>`;
    }
    const avail = (adv.counters || []).filter(c => c.available);
    if (!avail.length) return `<div class="lb-note">No available catalogued counter for this defence.</div>`;
    avail.sort((a, b) => tierSortValue(a.tier) - tierSortValue(b.tier) || (b.expected || 0) - (a.expected || 0));
    return `<ul class="lb-list">${avail.map(c => {
        const est = c.expected === null ? "no banner estimate"
            : `~${c.expected}${c.documentedDrop ? ` · drop ${c.documentedDrop} → ~${c.expectedWithDrop}` : ""}`;
        const meets = c.expected === null || adv.battleTarget === 0 ? ""
            : (c.expectedMeets ? " ✓" : c.expectedWithDropMeets ? " ✓ if undersized" : " ✗");
        return `<li><span class="tier-badge tier-badge-small" style="background:${getTierColour(c.tier)};">${escapeHtml(c.tier || "?")}</span> ${escapeHtml(c.name)} <span class="lb-muted">${est}${meets}</span></li>`;
    }).join("")}</ul><div class="lb-note">Estimates are typical clean-clear results, not guarantees.</div>`;
}

// The one input a fleet last battle asks for: the attacking capital ship's stars,
// which decide whether the 4th reinforcement slot is unlocked.
function lastBattleCapitalPicker(adv) {
    const cap = adv.fleetCapacity && adv.fleetCapacity.capital;
    const option = (value, label) => {
        const on = (cap || "") === value;
        return `<button class="lb-capital-btn ${on ? "active" : ""}" aria-pressed="${on}" onclick="setLastBattleFleetCapital('${value}')">${label}</button>`;
    };
    return `<div class="lb-subtitle">Your capital ship</div>
<div class="counter-filter lb-capital" role="group" aria-label="Your capital ship's stars">${option("7", "7★")}${option("5-6", "5★–6★")}${option("", "Not sure")}</div>
${cap ? "" : `<div class="lb-note">Below 7★ the 4th reinforcement slot is locked and earns nothing, so figures are ranges until you choose.</div>`}`;
}

function lastBattleInnerHtml(adv) {
    if (adv.status === "cannotCalculate") {
        return `<div class="lb-target">${lastBattleTargetLabel(adv)}</div>
<div class="lb-headline behind">Cannot calculate precisely</div>
<div class="lb-support">${escapeHtml(adv.reasons[0].message)}</div>`;
    }
    const t = adv.target;
    const h = lastBattleHeadline(adv);
    const assigned = roundPlan && roundPlan.assign ? roundPlan.assign[`${t.territory}:${t.index}`] : null;
    const conditions = lastBattleConditions(adv, assigned);
    const notes = [];
    if (!adv.scores.oppFinal && adv.verdict !== "alreadyAhead") notes.push("Against their current score — the target may rise.");
    if (adv.needsInput.includes("enemiesRemaining")) notes.push(`Battles: ${t.attempts}. Earlier battles may have defeated some enemies, so figures are ranges (${adv.enemiesDefeated.low}–${adv.enemiesDefeated.high} enemy defeats).`);
    const fleet = t.battleType === "FLEET";
    if (fleet && adv.verdict !== "alreadyAhead") notes.push("Fleet: assumes you call in every reinforcement you bring; empty starting slots and unsummoned ships aren't confirmed to score.");

    // Fleet rows are labelled by empty slots, since the fielded count depends on
    // the capital ship's stars; a drop beyond the unlocked reinforcement slots is
    // marked unconfirmed rather than offered.
    const fit = f => adv.battleTarget > 0 ? ` · ${f.meets === "yes" ? `${f.allowanceLow} to spare` : f.meets === "maybe" ? "maybe" : "short"}` : "";
    const formations = fleet ? `
    <div class="lb-subtitle">Ceiling by empty slots</div>
    <ul class="lb-list">${adv.formations.map(f =>
        `<li>${f.emptySlots ? `${f.emptySlots} empty` : "Full fleet"}: up to ${rangeText(f.maxLow, f.maxHigh)}${fit(f)}${!f.slotRuleConfirmed ? " <span class=\"lb-muted\">(needs empty starting slots — unconfirmed)</span>" : f.mathematicalOnly ? " <span class=\"lb-muted\">(maths only)</span>" : ""}</li>`).join("")}</ul>` : `
    <div class="lb-subtitle">Ceiling by units fielded</div>
    <ul class="lb-list">${adv.formations.map(f =>
        `<li>${f.fielded} fielded${f.emptySlots ? ` (${f.emptySlots} empty)` : ""}: up to ${rangeText(f.maxLow, f.maxHigh)}${fit(f)}${f.mathematicalOnly ? " <span class=\"lb-muted\">(maths only)</span>" : ""}</li>`).join("")}</ul>`;

    return `<div class="lb-target">${lastBattleTargetLabel(adv)}</div>
<div class="lb-context">${t.formatLabel} · Attempt ${t.attemptNumber}${t.attemptNumber >= 3 ? " (no attempt bonus)" : ""} · ${adv.scores.oppFinal ? "Final" : "Current"} opponent score</div>
${fleet ? lastBattleCapitalPicker(adv) : ""}
<div class="lb-headline ${h.cls}" aria-live="polite">${h.head}</div>
<div class="lb-support">${h.support}</div>
${conditions.length ? `<ul class="lb-conditions">${conditions.map(l => `<li>${l}</li>`).join("")}</ul>` : ""}
${notes.map(n => `<div class="lb-note">${n}</div>`).join("")}
<details class="lb-details" ${lastBattleDetailsOpen ? "open" : ""} ontoggle="lastBattleDetailsOpen = this.open">
    <summary>Breakdown and counter options</summary>
    ${formations}
    <div class="lb-subtitle">Available counters</div>
    ${lastBattleCounterRows(adv)}
</details>`;
}

// The spotlight card. Empty unless exactly one Opponent Board defence remains.
function renderLastBattle() {
    if (!board) return "";
    const adv = currentLastBattleAdvice();
    if (adv.status !== "ready" && adv.status !== "cannotCalculate") return "";
    return `
<section class="lastbattle-card" aria-label="Last battle advisor">
    <div class="lastbattle-title">🏁 LAST BATTLE</div>
    <div id="lastBattleBody">${lastBattleInnerHtml(adv)}</div>
</section>
`;
}

// Refresh the spotlight in place (score typing) without touching input focus.
function refreshLastBattleInPlace() {
    const el = document.getElementById("lastBattleBody");
    if (!el || !board) return;
    const adv = currentLastBattleAdvice();
    if (adv.status === "ready" || adv.status === "cannotCalculate") el.innerHTML = lastBattleInnerHtml(adv);
}

// Earlier access, inside Banner Tracking: where the remaining banners come from,
// before the last battle. Points to Win already states the target; this splits
// the board-calculated ceiling into battles, territory clears and first attack,
// and never treats any particular battle as the final one.
function remainingBreakdown(bd, firstAttackAvailable) {
    const out = { battles: 0, battleCount: 0, clears: 0, clearCount: 0, firstAttack: 0 };
    bd.territories.forEach(tDef => {
        const battleType = tDef.type === "FLEET" ? "FLEET" : "SQUAD";
        const mode = battleType === "FLEET" ? "ANY" : bd.mode;
        const teams = bd.teams.filter(t => t.territory === tDef.territory);
        const open = teams.filter(t => !t.cleared);
        open.forEach(t => { out.battles += battleBestCase(battleType, mode, t.attempts); });
        out.battleCount += open.length;
        if (open.length) {
            out.clears += scoreRule("TERRITORY_CLEAR_BASE", battleType, mode)
                + teams.length * scoreRule("TERRITORY_CLEAR_PER_TEAM", battleType, mode);
            out.clearCount++;
        }
    });
    if (firstAttackAvailable) out.firstAttack = scoreRule("FIRST_ATTACK", "ANY", bd.mode);
    return out;
}

function renderBannersNeeded() {
    if (!board) return "";
    const r = remainingBreakdown(board, isFirstAttackAvailable());
    if (r.battleCount === 0) return "";
    const parts = [`${r.battles} from ${plural(r.battleCount, "clean battle")}`,
        `${r.clears} from ${plural(r.clearCount, "territory clear")}`];
    if (r.firstAttack) parts.push(`${r.firstAttack} first-attack bonus`);
    const scope = r.battleCount === 1
        ? "One defence left: the Last Battle advisor at the top of Opponent Board turns the target into battle banners."
        : "Exact battle conditions appear in a Last Battle advisor once one defence remains.";
    return `
<details class="lb-needed">
    <summary>Banners needed — where the rest comes from</summary>
    <div class="lb-support">Calculated from Opponent Board: ${parts.join(" · ")}. Battles assume clean full-squad wins at each defence's next attempt${board.territories.some(t => t.type === "FLEET") ? "; fleet battles assume a full fleet with a 7★ capital ship" : ""}.</div>
    <div class="lb-note">${scope}</div>
</details>
`;
}

// The per-team battles counter (v2.6). Mirrors the in-game "Battles" count beside
// each defence team: how many battles have been fought against it so far, win or
// lose. Shown only while the team is uncleared, since a cleared team's battles no
// longer affect what is left to win. The count climbs freely (0, 1, 2, 3…) to
// match the game exactly; the points-to-win calculation reads it to decide the
// attempt bonus (first battle worth most, second less, later none).
function renderAttemptControl(side, territoryKey, team) {
    const n = Math.max(0, team.attempts || 0);

    return `
<div class="board-attempts">
    <span class="board-attempts-label">Battles</span>
    <div class="board-attempts-stepper">
        <button class="board-attempts-btn" onclick="setTeamAttempts('${side}', '${territoryKey}', ${team.index}, ${n - 1})" ${n === 0 ? "disabled" : ""}>&minus;</button>
        <span class="board-attempts-count">${n}</span>
        <button class="board-attempts-btn" onclick="setTeamAttempts('${side}', '${territoryKey}', ${team.index}, ${n + 1})">+</button>
    </div>
</div>
`;
}

// Recommendation block for a single board team. Empty string when there's
// nothing useful to say (cleared, no team selected, or no plan).
// ─── UNDERSIZE (v2.8) ─────────────────────────────────────────────────────────
// The Counters sheet's `undersize` column is, from v2.8, a droppable-unit count:
// the maximum units this counter can drop from a full squad and still win cleanly
// (0 = field the full squad). Any blank or non-numeric value is treated as 0, so a
// sheet still mid-migration (old "Yes"/"No" strings, or unfilled rows) is always
// safe — an un-migrated row simply shows no undersize prompt rather than a wrong
// number. Dropping one unit nets +1 banner over a full clean clear (the +4
// unused-slot bonus minus the 3 forgone surviving/full-health/full-protection
// bonuses), so a droppable count of N is worth up to +N banners, and the
// reconstructed best-case total is the full-squad banner score plus N.
//
// The banner score column, also from v2.8, holds the FULL-SQUAD clean-clear value
// with the undersize premium removed, so score and count own non-overlapping parts
// of the total and can be added without double-counting.
//
// Fleet (issue #86) is different: the +1 is only earned for an UNLOCKED
// reinforcement slot, and whether the 4th is unlocked depends on the attacking
// capital ship's stars, which these screens do not know. A fleet counter
// therefore reports its drop and the conditional bonus but no reconstructed
// total; the Last Battle advisor asks for the stars before adding the two.
function undersizeInfo(counter, isFleet) {
    const drop = Math.max(0, Math.floor(Number(counter && counter.undersize)) || 0);
    if (drop <= 0) return null;                       // no undersize advice to show
    if (isFleet) return { drop, bonus: drop, total: null, fleet: true };
    const full = Number(counter.bannerScore) || 0;
    return {
        drop: drop,
        bonus: drop,                                  // +1 banner net per unit dropped
        total: full + drop                            // reconstructed best-case total
    };
}

// The one wording every screen uses for a fleet counter's undersize.
function fleetUndersizeText(us) {
    return `leave up to ${plural(us.drop, "reinforcement slot")} empty for up to +${us.bonus} — unlocked slots only (the 4th needs a 7★ capital ship)`;
}

// The score the allocation engine RANKS by (v2.9): the full-squad banner score
// plus the safe droppable-unit count, since +1 banner is bankable per unit dropped.
// This is the achievable best for a counter that can undersize, so ranking by it
// makes the engine prefer the higher-scoring option when two counters are otherwise
// comparable. It is used ONLY for ranking — the card still displays the full-squad
// bannerScore as its headline (with the undersize upside shown on its own line), so
// the headline never overstates what a straight, no-risk play would bank. Tier
// remains the primary sort key, so this only ever reorders counters WITHIN a tier;
// undersizing never promotes a lower-tier counter over a higher-tier one.
//
// A fleet counter ranks on its plain banner score: its undersize premium depends
// on capital-ship stars the engine does not know, so it is not bankable here.
function adjustedScore(counter, isFleet) {
    const full = Number(counter && counter.bannerScore) || 0;
    if (isFleet) return full;
    const drop = Math.max(0, Math.floor(Number(counter && counter.undersize)) || 0);
    return full + drop;
}

// Strategic reserve (v3.6): shown on a card whose counter is High reserve while
// hidden zones remain (see roundHasHiddenZones). It never hides, disables or
// blocks the counter — it is advisory text alongside the normal recommendation.
const RESERVE_WARNING_TEXT = "Consider holding — strong flexible counter and hidden zones remain.";

// Wording consumes engine diagnostics only; it never counts candidates or infers
// scarcity from notes, enemy threat, or the strategicReserve catalogue flag.
function conservationReason(plan, key) {
    const diagnostics = plan && plan.visibleBoardConservation;
    if (!diagnostics || diagnostics.changed !== true) return null;
    const tradeoff = diagnostics.tradeoffs.find(t => t.defenceId === key);
    if (!tradeoff || !tradeoff.selected || !tradeoff.baseline) return null;
    const destination = tradeoff.preservedFor.find(other => {
        const change = diagnostics.tradeoffs.find(t => t.defenceId === other.defenceId);
        return change && (!change.baseline || tierSortValue(other.tier) < tierSortValue(change.baseline.tier));
    });
    if (!destination) return null;
    return `Keeps ${getCounterName(destination.counterId)} (${destination.tier} tier) for ${destination.defenceName}, where the alternative allocation is weaker.`;
}

function allocationRiskText(plan, key) {
    const diagnostics = plan && plan.visibleBoardConservation;
    const warning = diagnostics && diagnostics.warnings.find(w => w.defenceId === key);
    if (!warning) return null;
    if (warning.status === "low-tier") return `${warning.tier}-tier option — risky; a win is not assured.`;
    if (warning.status === "compromised") return diagnostics.search.exhausted
        ? "No counter assigned in the current plan; the allocation search reached its limit."
        : "No credible allocation here without compromising another defence.";
    return null; // the existing reason distinguishes catalogue, roster and round availability
}

function renderReserveAlternatives(alts, targetKey, reserveActive = true) {
    const targetArg = targetKey ? `, '${targetKey}'` : "";
    return alts.map(c => `
    <div class="board-rec-reserve-alt">
        <div class="board-rec-reserve-alt-line">
            🎯 ${escapeHtml(c.counter)}
            <span class="tier-badge tier-badge-small" style="background:${getTierColour(c.tier)};">${escapeHtml(c.tier)}</span>
            <button class="board-rec-btn" onclick="markCounterUsedFromBoard('${c.counterId}'${targetArg})">Mark used</button>
        </div>
        ${reserveActive && isHighReserve(c.counterId) ? `<div class="nextup-warning">⚠ ${RESERVE_WARNING_TEXT}</div>` : ""}
    </div>`).join("");
}

function renderTeamRecommendation(side, territoryKey, team, modeKey) {
    if (side === "my" || !roundPlan || team.cleared || !team.name) return "";

    const targetKey = territoryKey + ":" + team.index;
    const info = roundPlan.reasons[targetKey];
    if (!info) return "";
    const blocked = (info.defenceBlocked || []).map(c => `
    <div class="board-rec-blocked"><span>On defence</span> ${escapeHtml(c.counter)}</div>`).join("");
    const conservation = conservationReason(roundPlan, targetKey);
    const alternatives = (info.reserveAlternatives || []).slice();
    if (conservation) {
        const tradeoff = roundPlan.visibleBoardConservation.tradeoffs.find(t => t.defenceId === targetKey);
        const eligible = roundPlan.eligible.find(t => t.key === targetKey);
        const alternative = eligible.candidates.find(c => c.counterId === tradeoff.baseline.counterId);
        if (alternative && !alternatives.some(c => c.counterId === alternative.counterId)) alternatives.push(alternative);
    }
    const reserveAltsHtml = renderReserveAlternatives(alternatives, targetKey, roundPlan.reserveActive);
    const reason = conservation || info.reason;
    const risk = allocationRiskText(roundPlan, targetKey);
    const riskHtml = risk ? `<div class="nextup-warning" role="note">⚠ ${escapeHtml(risk)}</div>` : "";

    if (info.counter) {
        const c = info.counter;
        const us = undersizeInfo(c, modeKey === "FLEET");
        const undersizeLine = !us ? "" : us.fleet ? `
    <div class="board-rec-undersize">Undersize: ${fleetUndersizeText(us)}</div>` : `
    <div class="board-rec-undersize">
        <strong>${us.total} banners</strong> if you undersize · drop up to ${us.drop} for +${us.bonus}
    </div>`;
        const reserveWarningLine = info.reserveWarning ? `
    <div class="nextup-warning">⚠ ${RESERVE_WARNING_TEXT}</div>` : "";
        const squadKey = territoryKey + ":" + team.index + ":" + c.counterId;
        const squadDisclosure = renderSquadDisclosure(squadKey, c.counterId, modeKey);
        // Used + Cleared is the normal successful-counter path, so it leads and is
        // visually primary; Mark used alone stays for when the two states genuinely
        // don't change together (e.g. recording a used counter before the defence
        // actually falls).
        return `
<div class="board-rec">
    <div class="board-rec-line">
        🎯 <strong>${escapeHtml(c.counter)}</strong>
        <span class="tier-badge tier-badge-small" style="background:${getTierColour(c.tier)};">${escapeHtml(c.tier)}</span>
        <span class="board-rec-banners">~${c.bannerScore || "?"} banners</span>
    </div>
    <div class="board-rec-reason">${escapeHtml(reason)}</div>${riskHtml}${undersizeLine}${reserveWarningLine}
    ${squadDisclosure}
    <div class="board-rec-actions">
        <button class="board-rec-btn board-rec-btn-primary" onclick="markUsedAndCleared('${side}', '${territoryKey}', ${team.index}, '${c.counterId}')">Used + Cleared</button>
        <button class="board-rec-btn board-rec-btn-secondary" onclick="markUsedAndLost('${side}', '${territoryKey}', ${team.index}, '${c.counterId}')">Used + Lost</button>
        <button class="board-rec-btn board-rec-btn-tertiary" onclick="markCounterUsedFromBoard('${c.counterId}', '${targetKey}')">Mark used</button>
    </div>${blocked}${reserveAltsHtml}
</div>
`;
    }

    return `
<div class="board-rec board-rec-none">
    <div class="board-rec-reason">${escapeHtml(reason)}</div>${riskHtml}${blocked}${reserveAltsHtml}
</div>
`;
}

// ─── SUGGESTED SQUAD DISCLOSURE (Round card, informational only) ──────────────
// Purely a way to inspect the catalogue's proposed attacking composition for a
// recommendation card. It never selects the counter, marks anything used, or
// changes the recommendation itself — toggleCounterCardExpanded() only flips a
// local, unpersisted UI flag and re-renders. It is a native <button>, separate
// from the card's action buttons below it, so it never intercepts their clicks
// and is keyboard/touch accessible for free via aria-expanded.
function toggleCounterCardExpanded(key) {
    if (expandedCounterCards.has(key)) {
        expandedCounterCards.delete(key);
    } else {
        expandedCounterCards.add(key);
    }
    render();
}

function renderSquadDisclosure(key, counterId, modeKey) {
    const comp = counterCompositionForDisplay(counterId, modeKey);
    if (!comp) return "";   // nothing usable yet — no affordance rather than an empty panel

    const expanded = expandedCounterCards.has(key);
    return `
<button type="button" class="board-rec-disclosure" aria-expanded="${expanded ? "true" : "false"}" onclick="toggleCounterCardExpanded('${key}')">
    <span>Suggested squad</span>
    <span class="board-rec-chevron ${expanded ? "open" : ""}">▾</span>
</button>
${expanded ? renderSuggestedSquad(comp) : ""}
`;
}

function renderSquadMemberRow(member, isRecommended) {
    const note = characterAvailabilityNote(member.id);
    const tag = isRecommended ? `<span class="squad-member-tag">Recommended</span>` : "";
    const noteHtml = note ? `<span class="squad-member-note">${escapeHtml(note)}</span>` : "";
    return `<div class="squad-member-row${isRecommended ? " squad-member-recommended" : ""}">${escapeHtml(member.name)}${tag}${noteHtml}</div>`;
}

function renderSuggestedSquad(comp) {
    const rows = [
        ...comp.required.map(m => renderSquadMemberRow(m, false)),
        ...comp.recommended.map(m => renderSquadMemberRow(m, true))
    ].join("");
    const flexRow = comp.flex > 0
        ? `<div class="squad-member-row squad-flex">+ ${comp.flex} flex</div>`
        : "";

    return `
<div class="board-rec-squad">
    ${rows}${flexRow}
</div>
`;
}

// The remaining figure in effect: the manual override if the user has typed one,
// otherwise the value calculated from the board. This is the single definition of
// "remaining" that projected-final is built on.
function effectiveRemaining() {
    if (typeof bannerData.remaining === "number") return bannerData.remaining;
    return calculatedRemaining();
}

function isRemainingOverridden() {
    return typeof bannerData.remaining === "number";
}

// ─── POINTS TO WIN (v2.6, Phase 3) ────────────────────────────────────────────
// Turns the three tracked numbers into a plain-language verdict. "Points to win"
// is how many more banners you must bank to pass the opponent's CURRENT score:
//   pointsToWin = (opp + 1) − my        (0 or less means you are already past it)
// Whether that is achievable depends on your best-case remaining: if remaining
// covers pointsToWin, a clean finish wins; if not, even a perfect finish falls
// short. Every phrase says "current score", never a bare "to win", because the
// opponent keeps scoring against your defence — their number is a moving target,
// modelled here only as what you have entered.
function pointsToWinReadout(my, opp, rem) {
    const need = (opp + 1) - my;   // banners still required to pull ahead

    if (need <= 0) {
        // Already past their current score.
        const ahead = my - opp;
        return {
            headline: `Ahead by ${ahead}`,
            headlineClass: "ahead",
            support: `You've passed their current score. A clean finish adds up to ${rem} more.`
        };
    }

    if (rem >= need) {
        const spare = rem - need;
        return {
            headline: `Points to win: ${need}`,
            headlineClass: "",
            support: spare > 0
                ? `Pass their current score with ${need} more. A clean finish banks up to ${rem} — enough, +${spare} spare.`
                : `Pass their current score with ${need} more. A clean finish banks exactly ${rem} — just enough.`
        };
    }

    // Even a perfect finish can't pass their current score from the board as entered.
    const short = need - rem;
    return {
        headline: `Points to win: ${need}`,
        headlineClass: "behind",
        support: `${need} to pass their current score, but a clean finish banks only ${rem} — ${short} short.`
    };
}

// Two-sided round outcome. A win requires finishing strictly ahead: a reachable
// tie is not classified as a win because tie-breaking is outside this app's model.
function canWinVerdict(my, opp, myRemaining, oppRemaining) {
    const myMax = my + myRemaining;
    const oppMax = opp + oppRemaining;

    if (my > oppMax) {
        return {
            headline: "Guaranteed win",
            headlineClass: "ahead",
            support: `You're already on ${my}; even a perfect opponent finish reaches only ${oppMax}.`
        };
    }

    if (myMax <= opp) {
        return {
            headline: "Impossible win",
            headlineClass: "behind",
            support: `Your best finish is ${myMax}; they already have ${opp}. You cannot finish strictly ahead.`
        };
    }

    return {
        headline: "Outcome depends on play",
        headlineClass: "",
        support: `You can finish from ${my} to ${myMax}; they can finish from ${opp} to ${oppMax}. The ranges overlap.`
    };
}

function renderBannerSection() {

    const my  = Number(bannerData.myScore)  || 0;
    const opp = Number(bannerData.oppScore) || 0;

    const overridden = isRemainingOverridden();
    const calc = calculatedRemaining();
    const rem = overridden ? bannerData.remaining : calc;
    const oppRem = calculatedOpponentRemaining();

    const myMax = my + rem;
    const oppMax = opp + oppRem;
    const margin = my - opp;
    const ptw = pointsToWinReadout(my, opp, rem);
    const oppFinal = bannerData.oppFinal === true;
    const cw = canWinVerdict(my, opp, rem, oppRem);

    // The remaining field always shows the value in effect. When it is the
    // board-calculated figure, a caption says so and the field is read-only; the
    // moment the user types, it becomes a manual override with a dismiss link.
    const remainingBlock = overridden ? `
    <label class="banner-label" for="remaining">Your remaining available banners</label>
    <input type="number" inputmode="numeric" min="0" id="remaining" class="banner-input"
        value="${rem}" oninput="updateRemaining(this.value)">
    <div class="banner-caption banner-caption-override">
        <span>Manual override — the board calculates ${calc}.</span>
        <button class="banner-link" onclick="clearRemainingOverride()">Use calculated</button>
    </div>
` : `
    <label class="banner-label" for="remaining">Your remaining available banners</label>
    <input type="number" inputmode="numeric" min="0" id="remaining" class="banner-input"
        value="${rem}" oninput="updateRemaining(this.value)">
    <div class="banner-caption">
        <span>${board
            ? "Calculated from the opponent board. Type to override."
            : "Set up the opponent board to calculate this, or type a value."}</span>
    </div>
`;

    // The opponent-score field carries a marker for whether the entered number is
    // their FINAL score or just their current one. Marking it final collapses the
    // opponent range to that score without touching My Board.
    const oppLabel = oppFinal ? "Opponent's final score" : "Opponent's current score";
    const oppMarker = oppFinal ? `
    <div class="banner-caption banner-caption-override">
        <span>Treated as their final score.</span>
        <button class="banner-link" onclick="setOppFinal(false)">It's their current score</button>
    </div>
` : `
    <div class="banner-caption">
        <button class="banner-link" onclick="setOppFinal(true)">Mark as their final score</button>
    </div>
`;

    return `
<div class="round-card">
    <div class="round-title">📊 BANNER TRACKING</div>
    <div class="round-stat">Current round score</div>
</div>

<div class="banner-form">

    <label class="banner-label" for="myScore">Your current score</label>
    <input type="number" inputmode="numeric" min="0" id="myScore" class="banner-input"
        value="${my}" oninput="updateBanner('myScore', this.value)">

    <label class="banner-label" for="oppScore">${oppLabel}</label>
    <input type="number" inputmode="numeric" min="0" id="oppScore" class="banner-input"
        value="${opp}" oninput="updateBanner('oppScore', this.value)">
${oppMarker}
${remainingBlock}
</div>

<div class="banner-readout">
    <div class="banner-readout-row">
        <span>Your current → maximum</span>
        <strong id="myScoreRange">${my}–${myMax}</strong>
    </div>
    <div class="banner-readout-row">
        <span>Opponent current → maximum</span>
        <strong id="oppScoreRange">${opp}–${oppMax}</strong>
    </div>
    <div class="banner-readout-row">
        <span>Margin now</span>
        <strong id="bannerMargin" class="${margin > 0 ? "ahead" : margin < 0 ? "behind" : ""}">${marginText(margin)}</strong>
    </div>
</div>

<div class="ptw-readout">
    <div class="ptw-headline ${ptw.headlineClass}" id="ptwHeadline">${ptw.headline}</div>
    <div class="ptw-support" id="ptwSupport">${ptw.support}</div>
    ${oppFinal
        ? `<div class="ptw-caveat">Their score is final; My Board remains recorded but adds no remaining banners.</div>`
        : `<div class="ptw-caveat">Their maximum includes ${oppRem} banners still available against My Board.</div>`}
    ${renderBannersNeeded()}
</div>

<div class="cw-readout">
    <div class="cw-question">Can I still win this round?</div>
    <div class="cw-headline ${cw.headlineClass}" id="cwHeadline">${cw.headline}</div>
    <div class="cw-support" id="cwSupport">${cw.support}</div>
</div>
`;
}

function marginText(margin) {
    if (margin > 0) return `Leading by ${margin}`;
    if (margin < 0) return `Trailing by ${Math.abs(margin)}`;
    return "Level";
}

function updateBanner(field, value) {
    bannerData[field] = value === "" ? 0 : Number(value);
    persistBannerData();
    recomputeBannerReadouts();
}

// Toggle whether the opponent's entered score is their FINAL score. This changes
// the opponent field's label and the wording of both readouts, so a full re-render
// is warranted — it is a tap, not typing, so losing input focus does not matter.
function setOppFinal(isFinal) {
    bannerData.oppFinal = isFinal === true;
    persistBannerData();
    render();
}

// Typing in the remaining box sets a manual override. We do NOT re-render on every
// keystroke (that would drop focus mid-typing); the override caption/link appear
// on the next full render — a board change or a tap — which is soon enough, and
// the range/margin readouts update live in the meantime.
function updateRemaining(value) {
    bannerData.remaining = value === "" ? 0 : Number(value);
    persistBannerData();
    recomputeBannerReadouts();
}

// Dismiss the manual override and return to the board-calculated figure.
function clearRemainingOverride() {
    bannerData.remaining = null;
    persistBannerData();
    render();
}

// Called by board-mutating actions: touching the board discards any manual
// override so the live calculated figure returns. No-op when nothing is
// overridden, so it is safe to call unconditionally.
function clearRemainingOverrideOnBoardChange() {
    if (typeof bannerData.remaining === "number") {
        bannerData.remaining = null;
        persistBannerData();
    }
}

function persistBannerData() {
    localStorage.setItem("bannerData", JSON.stringify(bannerData));
}

function recomputeBannerReadouts() {
    const my  = Number(bannerData.myScore)  || 0;
    const opp = Number(bannerData.oppScore) || 0;
    const rem = effectiveRemaining();
    const oppRem = calculatedOpponentRemaining();

    const margin = my - opp;

    const myRangeEl = document.getElementById("myScoreRange");
    const oppRangeEl = document.getElementById("oppScoreRange");
    const marginEl = document.getElementById("bannerMargin");

    if (myRangeEl) myRangeEl.textContent = `${my}–${my + rem}`;
    if (oppRangeEl) oppRangeEl.textContent = `${opp}–${opp + oppRem}`;
    if (marginEl) {
        marginEl.textContent = marginText(margin);
        marginEl.className = margin > 0 ? "ahead" : margin < 0 ? "behind" : "";
    }

    // Points-to-win verdict, refreshed live so typing a score updates it in place
    // without a full re-render (which would drop focus from the score field).
    const ptw = pointsToWinReadout(my, opp, rem);
    const ptwHeadEl = document.getElementById("ptwHeadline");
    const ptwSuppEl = document.getElementById("ptwSupport");
    if (ptwHeadEl) {
        ptwHeadEl.textContent = ptw.headline;
        ptwHeadEl.className = "ptw-headline " + ptw.headlineClass;
    }
    if (ptwSuppEl) ptwSuppEl.textContent = ptw.support;

    // Can-I-still-win verdict, refreshed the same way from both live ranges.
    const cw = canWinVerdict(my, opp, rem, oppRem);
    const cwHeadEl = document.getElementById("cwHeadline");
    const cwSuppEl = document.getElementById("cwSupport");
    if (cwHeadEl) {
        cwHeadEl.textContent = cw.headline;
        cwHeadEl.className = "cw-headline " + cw.headlineClass;
    }
    if (cwSuppEl) cwSuppEl.textContent = cw.support;

    refreshLastBattleInPlace();
}

// ─── ROSTER VIEW ─────────────────────────────────────────────────────────────

function renderRoster() {

    const isApi = rosterMeta.source === ROSTER_SOURCE_API && rosterMeta.allyCode;
    const freshLine = isApi
        ? `Last synced: ${rosterMeta.syncedAt ? formatSavedAt(rosterMeta.syncedAt) : "never"}`
        : (rosterMeta.savedAt
            ? `Last saved: ${formatSavedAt(rosterMeta.savedAt)} (${rosterMeta.source})`
            : "Not saved yet");

    return `
<div class="round-card">
    <div class="round-title">👤 MY ROSTER</div>
    <div class="round-stat">${rosterOwnedStatText()}</div>
    <div class="roster-saved-line">${freshLine}</div>
</div>

${renderRosterImportCard()}
${renderRosterNotice()}

<input
    type="text"
    class="search-box"
    placeholder="Search characters and ships..."
    value="${rosterSearch}"
    oninput="updateRosterSearch(this.value)"
>

${renderRosterDataPanel()}

<div id="rosterGroups">${renderRosterGroups()}</div>
`;
}

// The owned-count line. Ships are only mentioned once ship data is present, so
// rosters cached before ship support look exactly as they did before.
function rosterOwnedStatText() {
    const characters = getCharacterUnits();
    const ships = getShipUnits();
    const ownedChar = characters.filter(c => ownedCharacters.includes(c.id)).length;
    const charText = `${ownedChar} / ${characters.length} characters owned`;
    if (ships.length === 0) return charText;
    const ownedShip = ships.filter(s => ownedCharacters.includes(s.id)).length;
    return `${ownedChar} / ${characters.length} characters · ${ownedShip} / ${ships.length} ships owned`;
}

// Characters and Ships as two stacked sections, both filtered by the single
// search box. While searching, a section with no matches is hidden; if nothing
// matches at all, a single empty line is shown.
function renderRosterGroups() {
    const q = rosterSearch.toLowerCase();
    const searching = q.length > 0;

    const characters = getCharacterUnits().filter(c => c.name.toLowerCase().includes(q));
    const allShips = getShipUnits();
    const ships = allShips.filter(s => s.name.toLowerCase().includes(q));

    if (searching && characters.length === 0 && ships.length === 0) {
        return `<div class="roster-empty">No units match your search.</div>`;
    }

    let html = "";

    if (!searching || characters.length) {
        html += `<div class="roster-section-heading">Characters</div>`;
        html += `<div class="roster-list">${characters.map(renderRosterRow).join("")}</div>`;
    }

    if (allShips.length && (!searching || ships.length)) {
        html += `<div class="roster-section-heading">Ships</div>`;
        html += `<div class="roster-list">${ships.map(renderRosterRow).join("")}</div>`;
    }

    return html;
}

function renderRosterImportCard() {
    const empty = !hasRoster();
    const ally = rosterMeta.allyCode || allyCodeDraft || "";
    const isApi = rosterMeta.source === ROSTER_SOURCE_API && rosterMeta.allyCode;
    const btnLabel = isApi ? "Refresh roster" : "Import roster";

    const helper = empty
        ? `<div class="roster-import-helper">Enter your 9-digit ally code to load your roster from the game.</div>`
        : "";

    return `
<div class="roster-import-card ${empty ? "empty" : ""}">
    <div class="roster-import-title">⬇ Import roster</div>
    ${helper}
    <input
        type="text"
        inputmode="numeric"
        class="roster-ally-input"
        placeholder="123456789"
        value="${ally}"
        oninput="allyCodeDraft = this.value"
        ${rosterSyncing ? "disabled" : ""}
    >
    <button class="roster-data-btn roster-import-btn" onclick="importFromAllyCode()" ${rosterSyncing ? "disabled" : ""}>
        ${rosterSyncing ? "Importing…" : btnLabel}
    </button>
</div>
`;
}

function renderRosterNotice() {
    if (!rosterMessage && !rosterBackup) return "";

    const msg = rosterMessage
        ? `<div class="roster-msg roster-msg-${rosterMessage.kind}">${rosterMessage.text}</div>`
        : "";
    const undo = rosterBackup
        ? `<button class="roster-data-btn roster-undo-btn" onclick="undoImport()">Undo last import</button>`
        : "";

    return `<div class="roster-notice">${msg}${undo}</div>`;
}

function renderRosterRow(c) {
    const owned = ownedCharacters.includes(c.id);
    const badge = c.unitType === "CAPITAL_SHIP"
        ? `<span class="roster-badge">Capital</span>`
        : "";
    return `
<div class="roster-row ${owned ? "owned" : ""}" onclick="toggleOwned('${c.id}')">
    <span class="roster-name">${c.name}${badge}</span>
    <span class="roster-status">${owned ? "✅" : "➕"}</span>
</div>
`;
}

function renderRosterDataPanel() {

    const body = rosterPanelOpen ? `
<div class="roster-data-body">

    <button class="roster-data-btn" onclick="exportRoster()">Export roster</button>

<label class="roster-data-label" for="importBox">Restore from exported text</label>
    <textarea
        id="importBox"
        class="roster-import-box"
        placeholder='{"schema":2,"owned":[ ... ]}'
        oninput="importDraft = this.value"
    >${importDraft}</textarea>
<button class="roster-data-btn" onclick="importRoster()">Import from text</button>

    <button class="roster-data-btn roster-clear-btn" onclick="clearRoster()">Clear roster</button>

</div>
` : "";

    return `
<div class="roster-data-panel">
    <button class="roster-data-toggle" onclick="toggleRosterPanel()">
        <span>⚙ Manage roster data</span>
        <span>${rosterPanelOpen ? "▾" : "▸"}</span>
    </button>
    ${body}
</div>
`;
}

function toggleRosterPanel() {
    rosterPanelOpen = !rosterPanelOpen;
    render();
}

function updateRosterSearch(value) {
    rosterSearch = value;
    const groups = document.getElementById("rosterGroups");
    if (!groups) return;
    groups.innerHTML = renderRosterGroups();
}

function toggleOwned(characterId) {
    const idx = ownedCharacters.indexOf(characterId);
    if (idx === -1) {
        ownedCharacters.push(characterId);
    } else {
        ownedCharacters.splice(idx, 1);
    }
    saveRoster("manual");
    updateRosterSearch(rosterSearch);
    updateRosterStat();
}

function updateRosterStat() {
    const stat = document.querySelector(".round-stat");
    if (!stat) return;
    stat.textContent = rosterOwnedStatText();
}

function clearRoster() {
    const confirmed = confirm("Clear all owned units? In SWGOH you rarely lose characters or ships, so this is mainly for starting over.");
    if (!confirmed) return;
    ownedCharacters = [];
    rosterMeta.allyCode = null;
    rosterMeta.syncedAt = null;
    saveRoster("manual");
    rosterMessage = null;
    rosterBackup = null;
    render();
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

function buildExportPayload() {
    return JSON.stringify({
        schema:   ROSTER_SCHEMA,
        savedAt:  rosterMeta.savedAt || new Date().toISOString(),
        source:   rosterMeta.source || "manual",
        allyCode: rosterMeta.allyCode || null,
        syncedAt: rosterMeta.syncedAt || null,
        owned:    ownedCharacters
    });
}

async function exportRoster() {
    if (!hasRoster()) {
        rosterMessage = { text: "Nothing to export — your roster is empty.", kind: "warn" };
        render();
        return;
    }

    const text = buildExportPayload();

    try {
        await navigator.clipboard.writeText(text);
        rosterMessage = {
            text: `Copied ${ownedCharacters.length} units to the clipboard. Paste it somewhere safe.`,
            kind: "ok"
        };
        render();
    } catch (e) {
        console.error("Clipboard write failed, showing manual copy box", e);
        showExportFallback(text);
    }
}

function showExportFallback(text) {
    rosterMessage = {
        text: "Couldn't copy automatically. Select the text below and copy it manually.",
        kind: "warn"
    };
    render();

    const host = document.querySelector(".roster-notice") || document.querySelector(".roster-data-body");
    if (!host) return;

    const box = document.createElement("textarea");
    box.className = "roster-import-box";
    box.readOnly = true;
    box.value = text;
    host.appendChild(box);
    box.focus();
    box.select();
}

// ─── IMPORT (paste — manual fallback) ──────────────────────────────────────────

function importRoster() {
    const raw = (importDraft || "").trim();

    if (!raw) {
        rosterMessage = { text: "Paste an exported roster into the box first.", kind: "warn" };
        render();
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        rosterMessage = { text: "That isn't valid roster data. Check you pasted the whole thing.", kind: "error" };
        render();
        return;
    }

    const incoming = parsed && Array.isArray(parsed.owned) ? parsed.owned
                   : Array.isArray(parsed) ? parsed
                   : null;

    if (!incoming) {
        rosterMessage = { text: "That data has no character list in it.", kind: "error" };
        render();
        return;
    }

    const known = [];
    const skipped = [];
    const seen = new Set();
    let chCount = 0;
    let shCount = 0;

    incoming.forEach(id => {
        if (typeof id !== "string") { skipped.push(String(id)); return; }
        if (seen.has(id)) return;
        seen.add(id);
        const def = characterDefinitions[id];
        const type = def && def.unitType;
        if (type === "CHARACTER" || type === "SHIP" || type === "CAPITAL_SHIP") {
            known.push(id);
            if (type === "CHARACTER") chCount++; else shCount++;
        } else {
            skipped.push(id);
        }
    });

    if (known.length === 0) {
        rosterMessage = {
            text: "None of those units were recognised. Nothing was imported.",
            kind: "error"
        };
        render();
        return;
    }

    rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };

    const importSource = (parsed && parsed.source) ? parsed.source : "import";
    applyRoster(known, importSource);   // note: does not adopt a pasted allyCode

    importDraft = "";
    const base = `Imported ${chCount} character${chCount === 1 ? "" : "s"} and ${shCount} ship${shCount === 1 ? "" : "s"}.`;
    rosterMessage = {
        text: skipped.length ? `${base} Skipped ${skipped.length} unrecognised.` : base,
        kind: skipped.length ? "warn" : "ok"
    };
    render();
}

function undoImport() {
    if (!rosterBackup) return;
    ownedCharacters = rosterBackup.owned.slice();
    rosterMeta = {
        savedAt:  rosterBackup.meta.savedAt  || null,
        source:   rosterBackup.meta.source   || "manual",
        allyCode: rosterBackup.meta.allyCode || null,
        syncedAt: rosterBackup.meta.syncedAt || null
    };
    saveRoster(rosterMeta.source || "manual");
    rosterBackup = null;
    rosterMessage = { text: "Import undone. Previous roster restored.", kind: "ok" };
    render();
}

// ─── BOOT ───────────────────────────────────────────────────────────────────

if (!(typeof globalThis !== "undefined" && globalThis.__GAC_HELPER_TEST__)) {
    requestPersistentStorage();  // best-effort eviction resistance
    loadRoster();                // hydrate roster (with migration) before first paint
    loadBoard();                 // hydrate both boards; migrates a legacy opponent board additively
    loadData();                  // counters/defs/board config, then a staleness-gated background sync
}
