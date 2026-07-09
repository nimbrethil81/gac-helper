// app.js
const APP_VERSION = "2.5";
const API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

const ROSTER_SCHEMA = 2;
const ROSTER_KEY = "rosterData";             // versioned object
const LEGACY_ROSTER_KEY = "ownedCharacters"; // pre-v1.9 bare array

const ROSTER_SOURCE_API = "swgoh.gg";        // internal sentinel for API-imported rosters (do not surface)
const ROSTER_FETCH_TIMEOUT_MS = 60000;       // user-initiated import/refresh timeout (allows for Render cold start)
const ROSTER_SYNC_STALE_MS = 1000 * 60 * 60 * 12; // background sync only if older than this

// Board (v2.1 Round screen)
const BOARD_SCHEMA = 2;                       // v2: boards include fleet-territory team rows
const BOARD_KEY = "boardData";               // versioned board object
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

let gacData = {};
let counterDefinitions = {};
let characterDefinitions = {};
let boardConfig = {};                   // league -> mode -> [{territory, type, teamCount}]
let scoringRules = [];                  // GAC banner economy rows (consumed in Item 2)
let baseIdToUnit = {};                  // base_id -> { characterId, unitType }
let currentMode = "5v5";
let lastSquadMode = localStorage.getItem(LAST_SQUAD_MODE_KEY) || "5v5"; // last 5v5/3v3 chosen; used for board setup when the toggle is on Fleet
let boardModeDraft = null;              // squad format picked on the setup card while the toggle is on Fleet
let currentView = "counters";
let usedTeams = JSON.parse(localStorage.getItem("usedTeams") || "[]");
let searchText = "";

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
let leagueDraft = localStorage.getItem(LEAGUE_KEY) || "";
let roundPlan = null;                   // live allocation plan — recomputed every Round render, never persisted

let bannerData = JSON.parse(
    localStorage.getItem("bannerData") || '{"myScore":0,"oppScore":0,"remaining":0}'
);
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

function loadBoard() {
    const raw = localStorage.getItem(BOARD_KEY);
    if (!raw) { board = null; return; }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schema === BOARD_SCHEMA &&
            Array.isArray(parsed.teams) && Array.isArray(parsed.territories)) {
            board = parsed;
            return;
        }
    } catch (e) {
        console.error("Board parse failed, discarding stored board", e);
    }
    board = null;
}

function saveBoard() {
    if (board) localStorage.setItem(BOARD_KEY, JSON.stringify(board));
}

function discardBoard() {
    board = null;
    boardModeDraft = null;
    localStorage.removeItem(BOARD_KEY);
}

function leagueLabel(league) {
    if (!league) return "";
    return league.charAt(0) + league.slice(1).toLowerCase();
}

function setLeague(value) {
    leagueDraft = value;
    if (value) localStorage.setItem(LEAGUE_KEY, value);
    render();
}

// The opponent board is always a squad-format board (5v5 or 3v3) plus the fleet
// territory. "Fleet" is a browsing view on the Counters screen, never a whole-
// board format — so when the toggle is on Fleet, the board takes the squad
// format chosen on the setup card, falling back to the last squad format used.
function boardMode() {
    if (currentMode !== "FLEET") return currentMode;
    return boardModeDraft || lastSquadMode;
}

function setBoardModeDraft(mode) {
    boardModeDraft = mode;
    render();
}

function createBoard() {
    const league = leagueDraft;
    const mode = boardMode();
    const cfg = boardConfig[league] && boardConfig[league][mode];

    if (!league || !cfg || cfg.length === 0) {
        alert("Choose a league first. If a league is selected and this still fails, the board configuration hasn't loaded — check your connection and refresh.");
        return;
    }

    const teams = [];
    cfg.forEach(t => {
        for (let i = 0; i < t.teamCount; i++) {
            teams.push({ territory: t.territory, index: i, name: "", cleared: false });
        }
    });

    board = {
        schema:      BOARD_SCHEMA,
        league:      league,
        mode:        mode,                 // frozen for the round (always 5v5 or 3v3)
        createdAt:   new Date().toISOString(),
        territories: cfg.map(t => ({ territory: t.territory, type: t.type, teamCount: t.teamCount })),
        teams:       teams
    };
    boardModeDraft = null;
    saveBoard();
    render();
}

// ─── BOARD DERIVED STATE ──────────────────────────────────────────────────────

function teamsInTerritory(territoryKey) {
    return board ? board.teams.filter(t => t.territory === territoryKey) : [];
}

function isTerritoryCleared(territoryKey) {
    const teams = teamsInTerritory(territoryKey);
    return teams.length > 0 && teams.every(t => t.cleared);
}

// A back territory unlocks when the front territory in its lane is cleared.
// This applies to Back Top (fleet) exactly as it does to Back Bottom (squad):
// the fleet territory reveals once Front Top is cleared.
function isTerritoryUnlocked(tDef) {
    if (tDef.territory.indexOf("BACK_") === 0) {
        const front = "FRONT_" + tDef.territory.slice(5);
        return isTerritoryCleared(front);
    }
    return true;
}

// Which counter catalogue a territory draws from: fleet territories use the
// FLEET catalogue; squad territories use the board's frozen squad format.
function territoryModeKey(tDef) {
    return tDef.type === "FLEET" ? "FLEET" : board.mode;
}

// ─── BOARD ACTIONS ────────────────────────────────────────────────────────────

function setBoardTeam(territoryKey, index, value) {
    if (!board) return;
    const team = board.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team) return;
    team.name = value;
    saveBoard();
    render();
}

function toggleTeamCleared(territoryKey, index) {
    if (!board) return;
    const team = board.teams.find(t => t.territory === territoryKey && t.index === index);
    if (!team) return;
    team.cleared = !team.cleared;
    saveBoard();
    render();
}

function clearTerritory(territoryKey) {
    if (!board) return;
    const label = TERRITORY_LABELS[territoryKey] || territoryKey;
    if (!confirm(`Mark every team in ${label} as cleared?`)) return;
    board.teams.forEach(t => { if (t.territory === territoryKey) t.cleared = true; });
    saveBoard();
    render();
}

// Mark a counter used straight from a board recommendation. The plan re-solves
// on the render that follows — no stored plan to keep in sync.
function markCounterUsedFromBoard(counterId) {
    if (!usedTeams.includes(counterId)) {
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    render();
}

// ─── ALLOCATION ENGINE (v2.1) ─────────────────────────────────────────────────
// Pure derivation from board + roster + used state. Recomputed on every Round
// render; nothing here is persisted. Exclusivity is enforced at two levels:
// a counter can be assigned to at most one team, and two counters that share
// a required character can never both appear in the same plan (characters used
// on offence are spent for the round).

function requiredChars(counterId) {
    const def = counterDefinitions[counterId];
    return (def && def.required) || [];
}

// Every visible, uncleared, named board team plus its available counters.
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

            const all = (gacData[modeKey] && gacData[modeKey][team.name]) || [];
            const seen = new Set();
            const candidates = [];
            all.forEach(c => {
                if (seen.has(c.counterId)) return;
                seen.add(c.counterId);
                if (getCounterStatus(c.counterId) === "available") candidates.push(c);
            });

            eligible.push({ key, territory: tDef.territory, index: team.index,
                            name: team.name, modeKey, custom: false, candidates });
        });
    });

    return eligible;
}

// Scarcity-first ordered search with pruning. Objective (Option A, lexicographic):
// maximise teams covered, then prefer stronger tiers, then higher banner totals.
// The first complete path is the greedy scarcity-first answer, so even if the
// node budget is exhausted the result is never worse than greedy.
function solveAllocation(teams) {
    const order = teams.slice().sort((a, b) => a.candidates.length - b.candidates.length);

    let best = null;
    let nodes = 0;
    const NODE_BUDGET = 50000;

    const usedCounters = new Set();
    const usedChars = new Set();
    const assign = {};

    function isBetter(cov, tier, ban) {
        if (!best) return true;
        if (cov !== best.coverage) return cov > best.coverage;
        if (tier !== best.tierSum) return tier < best.tierSum;
        return ban > best.bannerSum;
    }

    function dfs(i, cov, tier, ban) {
        nodes++;
        if (nodes > NODE_BUDGET) return;

        // Coverage upper bound: even covering every remaining team can't win.
        const bound = cov + (order.length - i);
        if (best && bound < best.coverage) return;

        if (i === order.length) {
            if (isBetter(cov, tier, ban)) {
                best = { assign: { ...assign }, coverage: cov, tierSum: tier, bannerSum: ban };
            }
            return;
        }

        const t = order[i];
        const cands = t.candidates.slice().sort((a, b) => {
            const d = tierSortValue(a.tier) - tierSortValue(b.tier);
            if (d !== 0) return d;
            return Number(b.bannerScore || 0) - Number(a.bannerScore || 0);
        });

        for (const c of cands) {
            if (usedCounters.has(c.counterId)) continue;
            const req = requiredChars(c.counterId);
            if (req.some(ch => usedChars.has(ch))) continue;

            usedCounters.add(c.counterId);
            req.forEach(ch => usedChars.add(ch));
            assign[t.key] = c;

            dfs(i + 1, cov + 1, tier + tierSortValue(c.tier), ban + Number(c.bannerScore || 0));

            delete assign[t.key];
            usedCounters.delete(c.counterId);
            req.forEach(ch => usedChars.delete(ch));
        }

        // Branch where this team is left uncovered.
        dfs(i + 1, cov, tier, ban);
    }

    dfs(0, 0, 0, 0);
    return best || { assign: {}, coverage: 0, tierSum: 0, bannerSum: 0 };
}

// Plain-language reason for each team, grounded in the plan's real alternatives.
function buildReasons(eligible, assign) {
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
            reasons[t.key] = { counter: null, reason: "Not in the catalogue — no recommendations for this team." };
            return;
        }

        const chosen = assign[t.key] || null;

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
            reasons[t.key] = { counter: chosen, reason };
            return;
        }

        // No assignment — explain why.
        let reason;
        if (t.candidates.length === 0) {
            const all = (gacData[t.modeKey] && gacData[t.modeKey][t.name]) || [];
            if (all.length === 0) {
                reason = "No counters in the catalogue for this team yet.";
            } else if (all.some(c => getOwnership(c.counterId).owned)) {
                reason = "All your counters for this team have been used.";
            } else {
                reason = "You don't own a counter for this team.";
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
        reasons[t.key] = { counter: null, reason };
    });

    return reasons;
}

function computeRoundPlan() {
    if (!board) return null;

    const eligible = buildEligibleTeams();

    // Overlap: at least one available counter is eligible against 2+ teams.
    const counts = {};
    eligible.forEach(t => t.candidates.forEach(c => {
        counts[c.counterId] = (counts[c.counterId] || 0) + 1;
    }));
    const overlap = Object.values(counts).some(n => n >= 2);

    const solved = solveAllocation(eligible.filter(t => !t.custom));
    const reasons = buildReasons(eligible, solved.assign);

    return { eligible, overlap, assign: solved.assign, reasons };
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

async function loadData() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();

        gacData = data.counters;
        counterDefinitions = data.counterDefinitions;
        characterDefinitions = data.characterDefinitions;
        boardConfig = data.boardConfig || {};
        scoringRules = data.scoring || [];

        buildReverseIndex();   // base_id -> Character_ID, from the registry

        render();

        maybeBackgroundSync(); // cache-first: refresh quietly if stale (non-blocking)
    } catch (error) {
        document.getElementById("app").innerHTML =
            "<p style='padding:20px;color:#ff6666;'>Failed to load data. Please check your connection and refresh.</p>";
        console.error(error);
    }
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
    const url = API_URL + "?action=roster&allyCode=" + encodeURIComponent(allyCode);
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

function getCounterStatus(counterId) {
    const { owned } = getOwnership(counterId);
    if (!owned) return "not-owned";
    if (usedTeams.includes(counterId)) return "used";
    return "available";
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function setView(view) {
    currentView = view;
    if (view === "roster") {
        loadRoster();          // defensive re-read on entry
        rosterMessage = null;
    }
    if (view === "round") {
        loadBoard();           // defensive re-read on entry
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
        viewHtml = renderRoster();
    } else {
        viewHtml = renderRound();
    }

    app.innerHTML = `
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
    <button class="nav-button ${currentView === "roster" ? "active" : ""}" onclick="setView('roster')">
        <span class="nav-icon">👤</span>
        ROSTER
    </button>
</nav>
`;

    if (currentView === "counters") {
        showCounters();
    }
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
        usedTeams.push(counterId);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    showCounters();
}

function resetRound() {
    const confirmed = confirm("Reset the round? This clears used teams, banner tracking, and the opponent board.");
    if (!confirmed) return;

    usedTeams = [];
    localStorage.removeItem("usedTeams");

    bannerData = { myScore: 0, oppScore: 0, remaining: 0 };
    localStorage.removeItem("bannerData");

    discardBoard();

    render();
}

// ─── COUNTER CARD ─────────────────────────────────────────────────────────────

function buildCounterCardHtml(counter) {
    const status = getCounterStatus(counter.counterId);
    const ownership = getOwnership(counter.counterId);

    const statusClass = status === "available" ? "status-available" : "status-muted";
    const statusText  = status === "available" ? "Available"
                      : status === "used"      ? "Used"
                      : "Not owned";

    const dimClass = status === "available" ? "" : "used";

    return `
<div class="counter-card ${dimClass}">

    <div class="card-header">
        <div class="team-name">${counter.counter}</div>
        <span class="${statusClass}">${statusText}</span>
        <span class="tier-badge" style="background:${getTierColour(counter.tier)};">
            ${counter.tier}
        </span>
    </div>

    <div>🎯 <strong>Expected Banners:</strong> ${counter.bannerScore || "-"}</div>
    <div>👥 <strong>Undersize:</strong> ${counter.undersize || "-"}</div>

    <div>
        📝 <strong>Notes:</strong> ${counter.notes || "-"}
        ${!ownership.owned ? `
        <div style="margin-top:6px;">
            ❌ <strong>Missing:</strong>
            ${ownership.missing.map(id => getCharacterName(id)).join(", ")}
        </div>` : ""}
    </div>

    ${status === "used"
        ? ""
        : status === "available"
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
    const groupRank = { "available": 1, "used": 2, "not-owned": 3 };

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

    const allCounters = sortCounters(
        (gacData[currentMode] && gacData[currentMode][team]) || []
    );

    if (!hasRoster() && counterFilter !== "all") {
        resultsEl.innerHTML =
            "<p class='empty-state'>Set up your roster to see which counters you can field.</p>";
        return;
    }

    let filtered;

    if (counterFilter === "all") {
        filtered = allCounters;

    } else if (counterFilter === "owned") {
        filtered = allCounters.filter(c => getCounterStatus(c.counterId) !== "not-owned");

        if (filtered.length === 0) {
            resultsEl.innerHTML = "<p class='empty-state'>You don't own any counters for this team.</p>";
            return;
        }

    } else {
        filtered = allCounters.filter(c => getCounterStatus(c.counterId) === "available");

        if (filtered.length === 0) {
            const ownsAny = allCounters.some(c => getOwnership(c.counterId).owned);
            resultsEl.innerHTML = ownsAny
                ? "<p class='empty-state'>You've used all your counters for this team.</p>"
                : "<p class='empty-state'>You don't own any counters for this team.</p>";
            return;
        }
    }

    resultsEl.innerHTML = filtered.map(buildCounterCardHtml).join("");
}

// ─── ROUND VIEW (v2.1) ────────────────────────────────────────────────────────

function renderRound() {
    const summary = `
<div class="round-card">
    <div class="round-card-row">
        <div>
            <div class="round-title">🏆 CURRENT ROUND</div>
            <div class="round-stat">Used Teams: ${getUsedTeamCount()}</div>
        </div>
        <button class="reset-button-inline" onclick="resetRound()">Reset Round</button>
    </div>
</div>
`;

    const boardHtml = board ? renderBoard() : renderBoardSetup();

    return summary + boardHtml + renderBannerSection();
}

function renderBoardSetup() {
    const configLoaded = Object.keys(boardConfig).length > 0;

    const options = LEAGUES.map(l =>
        `<option value="${l}" ${leagueDraft === l ? "selected" : ""}>${leagueLabel(l)}</option>`
    ).join("");

    const warning = !configLoaded
        ? `<div class="roster-msg roster-msg-warn">Board configuration hasn't loaded yet — check your connection and refresh.</div>`
        : "";

    const fmt = boardMode();

    // On Fleet, "Fleet" isn't a whole-board format, so the setup card lets the
    // player pick the squad format for this board. On 5v5/3v3 it's inherited
    // silently from the toggle, exactly as before.
    const formatBlock = currentMode === "FLEET"
        ? `
    <div class="roster-import-helper">
        Choose your league, then pick the match format for the squad territories.
    </div>
    <div class="mode-toggle board-format-choice">
        <button class="mode-button ${fmt === "5v5" ? "active" : ""}" onclick="setBoardModeDraft('5v5')">5v5</button>
        <button class="mode-button ${fmt === "3v3" ? "active" : ""}" onclick="setBoardModeDraft('3v3')">3v3</button>
    </div>`
        : `
    <div class="roster-import-helper">
        Choose your league, then set up the opponent's defence board for this round.
        Format is taken from the Counters screen toggle — currently <strong>${fmt}</strong>.
    </div>`;

    return `
<div class="board-setup-card">
    <div class="roster-import-title">🗺️ SET UP OPPONENT BOARD</div>
    ${formatBlock}
    ${warning}
    <select class="team-select board-league-select" onchange="setLeague(this.value)">
        <option value="" ${!leagueDraft ? "selected" : ""}>Select league…</option>
        ${options}
    </select>
    <button class="roster-data-btn roster-import-btn" onclick="createBoard()" ${(!leagueDraft || !configLoaded) ? "disabled" : ""}>
        Set up board
    </button>
</div>
`;
}

function renderBoard() {
    roundPlan = computeRoundPlan();   // live re-solve: falls out of render-on-state-change

    const overlapBanner = roundPlan && roundPlan.overlap
        ? `<div class="roster-msg roster-msg-ok board-overlap">🔀 Shared counters detected — recommendations below account for the overlap.</div>`
        : "";

    const header = `
<div class="round-card">
    <div class="round-title">🗺️ OPPONENT BOARD</div>
    <div class="round-stat">${leagueLabel(board.league)} · ${board.mode}</div>
</div>
`;
    const territories = board.territories.map(renderTerritory).join("");
    return header + overlapBanner + territories;
}

function renderTerritory(tDef) {
    const label = TERRITORY_LABELS[tDef.territory] || tDef.territory;
    const isFleet = tDef.type === "FLEET";
    const icon = isFleet ? "🚀 " : "";
    const unit = isFleet ? "fleet" : "team";

    if (!isTerritoryUnlocked(tDef)) {
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

    const teams = teamsInTerritory(tDef.territory);
    const clearedCount = teams.filter(t => t.cleared).length;
    const allCleared = clearedCount === teams.length && teams.length > 0;

    const clearBtn = allCleared
        ? `<span class="status-available">Cleared ✓</span>`
        : `<button class="clear-territory-btn" onclick="clearTerritory('${tDef.territory}')">Clear territory</button>`;

    return `
<div class="board-territory">
    <div class="board-territory-header">
        <span class="board-territory-title">${icon}${label.toUpperCase()}</span>
        <span class="board-territory-progress">${clearedCount}/${teams.length} cleared</span>
        ${clearBtn}
    </div>
    ${teams.map(t => renderBoardTeamRow(tDef, t)).join("")}
</div>
`;
}

function renderBoardTeamRow(tDef, team) {
    const territoryKey = tDef.territory;
    const modeKey = territoryModeKey(tDef);
    const teamNames = Object.keys(gacData[modeKey] || {}).sort((a, b) => a.localeCompare(b));

    const options = [
        `<option value="" ${team.name === "" ? "selected" : ""}>Select ${tDef.type === "FLEET" ? "fleet" : "team"}…</option>`,
        `<option value="${NOT_IN_CATALOGUE}" ${team.name === NOT_IN_CATALOGUE ? "selected" : ""}>Not in catalogue</option>`,
        ...teamNames.map(n => `<option value="${n}" ${team.name === n ? "selected" : ""}>${n}</option>`)
    ].join("");

    return `
<div class="board-team ${team.cleared ? "cleared" : ""}">
    <select class="board-team-select" onchange="setBoardTeam('${territoryKey}', ${team.index}, this.value)">
        ${options}
    </select>
    <button class="board-cleared-btn ${team.cleared ? "on" : ""}" onclick="toggleTeamCleared('${territoryKey}', ${team.index})">
        ${team.cleared ? "✓ Cleared" : "Cleared"}
    </button>
</div>
${renderTeamRecommendation(territoryKey, team)}
`;
}

// Recommendation block for a single board team. Empty string when there's
// nothing useful to say (cleared, no team selected, or no plan).
function renderTeamRecommendation(territoryKey, team) {
    if (!roundPlan || team.cleared || !team.name) return "";

    const info = roundPlan.reasons[territoryKey + ":" + team.index];
    if (!info) return "";

    if (info.counter) {
        const c = info.counter;
        return `
<div class="board-rec">
    <div class="board-rec-line">
        🎯 <strong>${c.counter}</strong>
        <span class="tier-badge tier-badge-small" style="background:${getTierColour(c.tier)};">${c.tier}</span>
        <span class="board-rec-banners">~${c.bannerScore || "?"} banners</span>
    </div>
    <div class="board-rec-reason">${info.reason}</div>
    <button class="board-rec-btn" onclick="markCounterUsedFromBoard('${c.counterId}')">Mark used</button>
</div>
`;
    }

    return `
<div class="board-rec board-rec-none">
    <div class="board-rec-reason">${info.reason}</div>
</div>
`;
}

function renderBannerSection() {

    const my  = Number(bannerData.myScore)  || 0;
    const opp = Number(bannerData.oppScore) || 0;
    const rem = Number(bannerData.remaining) || 0;

    const projected = my + rem;
    const margin = my - opp;

    return `
<div class="round-card">
    <div class="round-title">📊 BANNER TRACKING</div>
    <div class="round-stat">Current round score</div>
</div>

<div class="banner-form">

    <label class="banner-label" for="myScore">Your current score</label>
    <input type="number" inputmode="numeric" min="0" id="myScore" class="banner-input"
        value="${my}" oninput="updateBanner('myScore', this.value)">

    <label class="banner-label" for="oppScore">Opponent's current score</label>
    <input type="number" inputmode="numeric" min="0" id="oppScore" class="banner-input"
        value="${opp}" oninput="updateBanner('oppScore', this.value)">

    <label class="banner-label" for="remaining">Your remaining available banners</label>
    <input type="number" inputmode="numeric" min="0" id="remaining" class="banner-input"
        value="${rem}" oninput="updateBanner('remaining', this.value)">

</div>

<div class="banner-readout">
    <div class="banner-readout-row">
        <span>Projected final (max)</span>
        <strong id="projectedFinal">${projected}</strong>
    </div>
    <div class="banner-readout-row">
        <span>Margin now</span>
        <strong id="bannerMargin" class="${margin > 0 ? "ahead" : margin < 0 ? "behind" : ""}">${marginText(margin)}</strong>
    </div>
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
    localStorage.setItem("bannerData", JSON.stringify(bannerData));
    recomputeBannerReadouts();
}

function recomputeBannerReadouts() {
    const my  = Number(bannerData.myScore)  || 0;
    const opp = Number(bannerData.oppScore) || 0;
    const rem = Number(bannerData.remaining) || 0;

    const projected = my + rem;
    const margin = my - opp;

    const projectedEl = document.getElementById("projectedFinal");
    const marginEl = document.getElementById("bannerMargin");

    if (projectedEl) projectedEl.textContent = projected;
    if (marginEl) {
        marginEl.textContent = marginText(margin);
        marginEl.className = margin > 0 ? "ahead" : margin < 0 ? "behind" : "";
    }
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

requestPersistentStorage();  // best-effort eviction resistance
loadRoster();                // hydrate roster (with migration) before first paint
loadBoard();                 // hydrate any in-progress board
loadData();                  // counters/defs/board config, then a staleness-gated background sync
