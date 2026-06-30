// app.js
const APP_VERSION = "2.0";
const API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

const ROSTER_SCHEMA = 2;
const ROSTER_KEY = "rosterData";             // versioned object
const LEGACY_ROSTER_KEY = "ownedCharacters"; // pre-v1.9 bare array

const ROSTER_SOURCE_API = "swgoh.gg";        // source tag for API-imported rosters
const ROSTER_FETCH_TIMEOUT_MS = 60000;       // user-initiated import/refresh timeout (allows for Render cold start)
const ROSTER_SYNC_STALE_MS = 1000 * 60 * 60 * 12; // background sync only if older than this

let gacData = {};
let counterDefinitions = {};
let characterDefinitions = {};
let baseIdToUnit = {};                  // base_id -> { characterId, unitType }
let currentMode = "5v5";
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

// Shared replace path. The API import calls this with source "swgoh.gg" and an
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

// ─── PERSISTENT STORAGE REQUEST ───────────────────────────────────────────────
// Best-effort: asks the OS to exempt our storage from automatic eviction.
// Effective on Chromium/Android and desktop. On Safari, Private Browsing uses
// ephemeral storage that is cleared at session end regardless (expected
// behaviour, not preventable by persist()); normal browsing retains storage.
// Manual Export and the SWGOH.gg import are the durable backstops.

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
// Reverse index built from characterDefinitions. Keyed by swgoh.gg base_id;
// stores unitType so the importer can classify (character / ship / unknown).

function buildReverseIndex() {
    baseIdToUnit = {};
    Object.entries(characterDefinitions).forEach(([id, def]) => {
        const ext = def && def.externalId ? String(def.externalId).trim() : "";
        if (ext) baseIdToUnit[ext] = { characterId: id, unitType: def.unitType };
    });
}

// Turn a list of base_ids into owned Character_IDs plus diagnostic buckets.
// Unit-type-parameterised; defaults to characters only (v2.5 will widen this).
function classifyBaseIds(baseIds, opts) {
    const wantTypes = (opts && opts.unitTypes) || ["CHARACTER"];
    const ownedCharacterIds = [];
    const ignoredKnown = [];   // recognised, but a type we don't import yet (ships)
    const unknown = [];        // not in the registry / no mapping yet
    const seen = new Set();

    (baseIds || []).forEach(bid => {
        const key = String(bid);
        if (seen.has(key)) return;
        seen.add(key);

        const hit = baseIdToUnit[key];
        if (!hit) { unknown.push(key); return; }

        if (wantTypes.includes(hit.unitType)) {
            ownedCharacterIds.push(hit.characterId);
        } else {
            ignoredKnown.push(key);
        }
    });

    return { ownedCharacterIds, ignoredKnown, unknown };
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

function buildImportSummary(n, ignored, unknown) {
const parts = [`Imported ${n} character${n === 1 ? "" : "s"} from the game.`];
    if (ignored) parts.push(`${ignored} ship${ignored === 1 ? "" : "s"} ignored.`);
    if (unknown) parts.push(`${unknown} unit${unknown === 1 ? "" : "s"} not in the app's database yet — they won't affect counters.`);
    return parts.join(" ");
}

// User-initiated import / refresh (foreground, with feedback and Undo).
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

    // Confirm only when switching into an API roster or overwriting a different
    // roster; a routine refresh of the same ally code is silent-on-intent.
    const isRoutineRefresh =
        rosterMeta.source === ROSTER_SOURCE_API && rosterMeta.allyCode === allyCode;
    if (hasRoster() && !isRoutineRefresh) {
        const ok = confirm(`This replaces your current roster (${ownedCharacters.length} characters) with data from SWGOH.gg. You can undo straight afterwards.`);
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

    const { ownedCharacterIds, ignoredKnown, unknown } =
        classifyBaseIds(data.ownedBaseIds, { unitTypes: ["CHARACTER"] });

    if (ownedCharacterIds.length === 0) {
        rosterMessage = {
            text: "We loaded your account, but none of your characters are mapped in the app yet, so nothing was imported.",
            kind: "error"
        };
        render();
        return;
    }

    rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };
    applyRoster(ownedCharacterIds, ROSTER_SOURCE_API, {
        allyCode: data.allyCode || allyCode,
        syncedAt: data.syncedAt || new Date().toISOString()
    });
    allyCodeDraft = "";

    rosterMessage = {
        text: buildImportSummary(ownedCharacterIds.length, ignoredKnown.length, unknown.length),
        kind: unknown.length ? "warn" : "ok"
    };
    render();
}

// Background refresh (silent, staleness-gated, never mid-edit).
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

        const { ownedCharacterIds } =
            classifyBaseIds(data.ownedBaseIds, { unitTypes: ["CHARACTER"] });
        if (ownedCharacterIds.length === 0) return; // don't wipe a good cache on a bad map

        const changed = !sameSet(ownedCharacterIds, ownedCharacters);
        if (changed) {
            rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };
        }
        applyRoster(ownedCharacterIds, ROSTER_SOURCE_API, {
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

function getCharacterList() {
    return Object.entries(characterDefinitions)
        .filter(([, def]) => def.unitType === "CHARACTER")
        .map(([id, def]) => ({ id, name: def.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

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

// Returns "available" | "used" | "not-owned"
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
        viewHtml = renderBanners();
    }

    app.innerHTML = `
${viewHtml}

<div class="footer">v${APP_VERSION}</div>

<nav class="bottom-nav">
    <button class="nav-button ${currentView === "counters" ? "active" : ""}" onclick="setView('counters')">
        <span class="nav-icon">⚔️</span>
        COUNTERS
    </button>
    <button class="nav-button ${currentView === "banners" ? "active" : ""}" onclick="setView('banners')">
        <span class="nav-icon">📊</span>
        BANNERS
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

    const teams = Object.keys(gacData[currentMode] || {})
        .filter(team => team.toLowerCase().includes(searchText.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    return `
<div class="round-card">
    <div class="round-card-row">
        <div>
            <div class="round-title">🏆 CURRENT ROUND</div>
            <div class="round-stat">Used Teams: ${getUsedTeamCount()}</div>
        </div>
        <button class="reset-button-inline" onclick="resetRound()">Reset Round</button>
    </div>
</div>

<div class="mode-toggle">
    <button class="mode-button ${currentMode === "5v5" ? "active" : ""}" onclick="setMode('5v5')">5v5</button>
    <button class="mode-button ${currentMode === "3v3" ? "active" : ""}" onclick="setMode('3v3')">3v3</button>
</div>

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
    render();
}

function updateSearch(value) {
    searchText = value;

    const teamSelect = document.getElementById("teamSelect");
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
    const confirmed = confirm("Reset the round? This clears used teams and banner tracking.");
    if (!confirmed) return;

    usedTeams = [];
    localStorage.removeItem("usedTeams");

    bannerData = { myScore: 0, oppScore: 0, remaining: 0 };
    localStorage.removeItem("bannerData");

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

// ─── BANNERS VIEW ────────────────────────────────────────────────────────────

function marginText(margin) {
    if (margin > 0) return `Leading by ${margin}`;
    if (margin < 0) return `Trailing by ${Math.abs(margin)}`;
    return "Level";
}

function renderBanners() {

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

    const allCharacters = getCharacterList();

    const filtered = allCharacters.filter(c =>
        c.name.toLowerCase().includes(rosterSearch.toLowerCase())
    );

    const ownedCount = allCharacters.filter(c => ownedCharacters.includes(c.id)).length;

    // Source-aware freshness line: API rosters show "last synced", manual show "last saved".
    const isApi = rosterMeta.source === ROSTER_SOURCE_API && rosterMeta.allyCode;
const freshLine = isApi
        ? `Last synced: ${rosterMeta.syncedAt ? formatSavedAt(rosterMeta.syncedAt) : "never"}`
        : (rosterMeta.savedAt
            ? `Last saved: ${formatSavedAt(rosterMeta.savedAt)} (${rosterMeta.source})`
            : "Not saved yet");

    return `
<div class="round-card">
    <div class="round-title">👤 MY ROSTER</div>
    <div class="round-stat">${ownedCount} / ${allCharacters.length} characters owned</div>
    <div class="roster-saved-line">${freshLine}</div>
</div>

${renderRosterImportCard()}
${renderRosterNotice()}

<input
    type="text"
    class="search-box"
    placeholder="Search characters..."
    value="${rosterSearch}"
    oninput="updateRosterSearch(this.value)"
>

${renderRosterDataPanel()}

<div class="roster-list">
    ${filtered.map(renderRosterRow).join("")}
</div>
`;
}

// Primary import path: prominent when the roster is empty, becomes a Refresh
// control once a roster has been imported.
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

// Top-level message + Undo cluster (visible regardless of the data panel state).
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
    return `
<div class="roster-row ${owned ? "owned" : ""}" onclick="toggleOwned('${c.id}')">
    <span class="roster-name">${c.name}</span>
    <span class="roster-status">${owned ? "✅" : "➕"}</span>
</div>
`;
}

// Manual data management: Export / paste-import (fallback) / Clear.
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
    const app = document.getElementById("app");
    const rosterList = app.querySelector(".roster-list");
    if (!rosterList) return;

    const allCharacters = getCharacterList();
    const filtered = allCharacters.filter(c =>
        c.name.toLowerCase().includes(value.toLowerCase())
    );

    rosterList.innerHTML = filtered.map(renderRosterRow).join("");
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
    const allCharacters = getCharacterList();
    const ownedCount = allCharacters.filter(c => ownedCharacters.includes(c.id)).length;
    stat.textContent = `${ownedCount} / ${allCharacters.length} characters owned`;
}

function clearRoster() {
    const confirmed = confirm("Clear all owned characters? In SWGOH you rarely lose characters, so this is mainly for starting over.");
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
            text: `Copied ${ownedCharacters.length} characters to the clipboard. Paste it somewhere safe.`,
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

    // The notice cluster carries the message; append the selectable box to it.
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
// Operates on your own Character_IDs (not base_ids). Validate before mutating.

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

    incoming.forEach(id => {
        if (typeof id !== "string") { skipped.push(String(id)); return; }
        if (seen.has(id)) return;
        seen.add(id);
        if (characterDefinitions[id] && characterDefinitions[id].unitType === "CHARACTER") {
            known.push(id);
        } else {
            skipped.push(id);
        }
    });

    if (known.length === 0) {
        rosterMessage = {
            text: "None of those characters were recognised. Nothing was imported.",
            kind: "error"
        };
        render();
        return;
    }

    rosterBackup = { owned: ownedCharacters.slice(), meta: { ...rosterMeta } };

    const importSource = (parsed && parsed.source) ? parsed.source : "import";
    applyRoster(known, importSource);   // note: does not adopt a pasted allyCode

    importDraft = "";
    rosterMessage = {
        text: skipped.length
            ? `Imported ${known.length} characters. Skipped ${skipped.length} unrecognised.`
            : `Imported ${known.length} characters.`,
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
loadData();                  // counters/defs, then a staleness-gated background sync
