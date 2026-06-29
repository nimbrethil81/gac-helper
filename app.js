// app.js
const APP_VERSION = "1.9";
const API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

const ROSTER_SCHEMA = 1;
const ROSTER_KEY = "rosterData";          // v1.9 versioned object
const LEGACY_ROSTER_KEY = "ownedCharacters"; // pre-v1.9 bare array

let gacData = {};
let counterDefinitions = {};
let characterDefinitions = {};
let currentMode = "5v5";
let currentView = "counters";
let usedTeams = JSON.parse(localStorage.getItem("usedTeams") || "[]");
let searchText = "";

// Roster state. ownedCharacters stays the in-memory array the rest of the
// app reads; rosterMeta carries savedAt/source for the "last saved" line.
let ownedCharacters = [];
let rosterMeta = { savedAt: null, source: "manual" };

let rosterSearch = "";
let rosterPanelOpen = false;            // collapsible data panel state
let rosterBackup = null;                // session-only snapshot for Undo import
let importDraft = "";                   // text currently in the import box
let rosterMessage = null;               // { text, kind: "ok" | "warn" | "error" }

let bannerData = JSON.parse(
    localStorage.getItem("bannerData") || '{"myScore":0,"oppScore":0,"remaining":0}'
);
let counterFilter = localStorage.getItem("counterFilter") || "all";

// ─── ROSTER PERSISTENCE ────────────────────────────────────────────────────────
// Single load/save path. localStorage is the source of truth for owned
// characters; the app never writes back to the Google Sheet.

function loadRoster() {
    // Preferred: v1.9 versioned object.
    const raw = localStorage.getItem(ROSTER_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.owned)) {
                ownedCharacters = parsed.owned.slice();
                rosterMeta = {
                    savedAt: parsed.savedAt || null,
                    source: parsed.source || "manual"
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
                rosterMeta = { savedAt: null, source: "manual" };
                saveRoster("manual");                 // re-write in new schema
                localStorage.removeItem(LEGACY_ROSTER_KEY);
                return;
            }
        } catch (e) {
            console.error("Legacy roster parse failed", e);
        }
    }

    // Nothing stored.
    ownedCharacters = [];
    rosterMeta = { savedAt: null, source: "manual" };
}

function saveRoster(source) {
    if (source) rosterMeta.source = source;
    rosterMeta.savedAt = new Date().toISOString();

    const payload = {
        schema: ROSTER_SCHEMA,
        savedAt: rosterMeta.savedAt,
        source: rosterMeta.source,
        owned: ownedCharacters
    };
    localStorage.setItem(ROSTER_KEY, JSON.stringify(payload));
}

// Shared replace path. v2.0 API import will call this with source "swgoh.gg"
// etc. Caller is responsible for validation; this just commits.
function applyRoster(owned, source) {
    ownedCharacters = owned.slice();
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
// Effective on Chromium/Android and desktop; limited on iOS WebKit, where a
// swipe-away from the app switcher can still purge storage. Manual Export and
// the planned remote import (v2.0) are the durable backstops.

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

        render();
    } catch (error) {
        document.getElementById("app").innerHTML =
            "<p style='padding:20px;color:#ff6666;'>Failed to load data. Please check your connection and refresh.</p>";
        console.error(error);
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

    return {
        owned: missing.length === 0,
        missing
    };
}

// Returns "available" | "used" | "not-owned"
// Precedence: not-owned dominates; used only applies to owned counters.
function getCounterStatus(counterId) {
    const { owned } = getOwnership(counterId);
    if (!owned) return "not-owned";
    if (usedTeams.includes(counterId)) return "used";
    return "available";
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function setView(view) {
    currentView = view;
    // Defensive re-read whenever the roster screen is entered: guards against
    // partial storage eviction by another tab/instance between renders.
    if (view === "roster") {
        loadRoster();
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
        .filter(team =>
            team.toLowerCase().includes(searchText.toLowerCase())
        )
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

    document.querySelectorAll(".counter-filter-btn").forEach(btn => {
        btn.classList.remove("active");
    });
    const activeBtn = document.querySelector(
        `.counter-filter-btn[data-filter="${filter}"]`
    );
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
        .filter(team =>
            team.toLowerCase().includes(searchText.toLowerCase())
        )
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

    // Status word: green for available, muted for used and not-owned
    const statusClass = status === "available" ? "status-available" : "status-muted";
    const statusText  = status === "available" ? "Available"
                      : status === "used"      ? "Used"
                      : "Not owned";

    // Card dims for used and not-owned
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

// Three-tier group sort: Available → Used → Not owned.
// Within each group: tier asc, then banner score desc.
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
        resultsEl.innerHTML =
            "<p class='empty-state'>No matching defence teams found.</p>";
        return;
    }

    const team = teamSelect.value;
    if (!team) return;

    const allCounters = sortCounters(
        (gacData[currentMode] && gacData[currentMode][team]) || []
    );

    // ── Roster empty hint ──────────────────────────────────────────
    // Shown only on Owned and Available filters when no roster is set up.
    if (!hasRoster() && counterFilter !== "all") {
        resultsEl.innerHTML =
            "<p class='empty-state'>Set up your roster to see which counters you can field.</p>";
        return;
    }

    // ── Filter ────────────────────────────────────────────────────
    let filtered;

    if (counterFilter === "all") {
        filtered = allCounters;

    } else if (counterFilter === "owned") {
        filtered = allCounters.filter(c =>
            getCounterStatus(c.counterId) !== "not-owned"
        );

        if (filtered.length === 0) {
            resultsEl.innerHTML =
                "<p class='empty-state'>You don't own any counters for this team.</p>";
            return;
        }

    } else {
        // "available"
        filtered = allCounters.filter(c =>
            getCounterStatus(c.counterId) === "available"
        );

        if (filtered.length === 0) {
            // Distinguish: own at least one counter (all used) vs own none
            const ownsAny = allCounters.some(c =>
                getOwnership(c.counterId).owned
            );
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

    const ownedCount = allCharacters.filter(c =>
        ownedCharacters.includes(c.id)
    ).length;

    const savedLine = rosterMeta.savedAt
        ? `Last saved: ${formatSavedAt(rosterMeta.savedAt)} (${rosterMeta.source})`
        : "Not saved yet";

    return `
<div class="round-card">
    <div class="round-title">👤 MY ROSTER</div>
    <div class="round-stat">${ownedCount} / ${allCharacters.length} characters owned</div>
    <div class="roster-saved-line">${savedLine}</div>
</div>

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

function renderRosterRow(c) {
    const owned = ownedCharacters.includes(c.id);
    return `
<div class="roster-row ${owned ? "owned" : ""}" onclick="toggleOwned('${c.id}')">
    <span class="roster-name">${c.name}</span>
    <span class="roster-status">${owned ? "✅" : "➕"}</span>
</div>
`;
}

// Collapsible "Manage roster data" panel: Export / Import / Clear.
// Undo surfaces here only while a session backup exists.
function renderRosterDataPanel() {

    const messageHtml = rosterMessage
        ? `<div class="roster-msg roster-msg-${rosterMessage.kind}">${rosterMessage.text}</div>`
        : "";

    const undoHtml = rosterBackup
        ? `<button class="roster-data-btn roster-undo-btn" onclick="undoImport()">Undo import</button>`
        : "";

    const body = rosterPanelOpen ? `
<div class="roster-data-body">

    ${messageHtml}
    ${undoHtml}

    <button class="roster-data-btn" onclick="exportRoster()">Export roster</button>

    <label class="roster-data-label" for="importBox">Paste exported roster here</label>
    <textarea
        id="importBox"
        class="roster-import-box"
        placeholder='{"schema":1,"owned":[ ... ]}'
        oninput="importDraft = this.value"
    >${importDraft}</textarea>
    <button class="roster-data-btn" onclick="importRoster()">Import roster</button>

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
    const ownedCount = allCharacters.filter(c =>
        ownedCharacters.includes(c.id)
    ).length;
    stat.textContent = `${ownedCount} / ${allCharacters.length} characters owned`;
}

function clearRoster() {
    const confirmed = confirm("Clear all owned characters? In SWGOH you rarely lose characters, so this is mainly for starting over.");
    if (!confirmed) return;
    ownedCharacters = [];
    saveRoster("manual");
    rosterMessage = null;
    rosterBackup = null;
    render();
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

function buildExportPayload() {
    return JSON.stringify({
        schema: ROSTER_SCHEMA,
        savedAt: rosterMeta.savedAt || new Date().toISOString(),
        source: rosterMeta.source || "manual",
        owned: ownedCharacters
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
        // Clipboard API blocked/unavailable: fall back to a selectable box.
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

    const body = document.querySelector(".roster-data-body");
    if (!body) return;

    const box = document.createElement("textarea");
    box.className = "roster-import-box";
    box.readOnly = true;
    box.value = text;
    body.appendChild(box);
    box.focus();
    box.select();
}

// ─── IMPORT ────────────────────────────────────────────────────────────────────
// Validate fully before mutating. On any failure the existing roster is left
// untouched (we never wrote to it). On success we snapshot for Undo, replace,
// and report imported/skipped counts (lenient-reported).

function importRoster() {
    const raw = (importDraft || "").trim();

    if (!raw) {
        rosterMessage = { text: "Paste an exported roster into the box first.", kind: "warn" };
        render();
        return;
    }

    // ── Parse ──────────────────────────────────────────────────────
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        rosterMessage = { text: "That isn't valid roster data. Check you pasted the whole thing.", kind: "error" };
        render();
        return;
    }

    // ── Validate shape ─────────────────────────────────────────────
    const incoming = parsed && Array.isArray(parsed.owned) ? parsed.owned
                   : Array.isArray(parsed) ? parsed          // tolerate a bare array
                   : null;

    if (!incoming) {
        rosterMessage = { text: "That data has no character list in it.", kind: "error" };
        render();
        return;
    }

    // ── Validate IDs against the master registry (lenient-reported) ──
    const known = [];
    const skipped = [];
    const seen = new Set();

    incoming.forEach(id => {
        if (typeof id !== "string") { skipped.push(String(id)); return; }
        if (seen.has(id)) return;                 // dedupe defensively
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

    // ── Commit: snapshot for Undo, then replace ────────────────────
    rosterBackup = {
        owned: ownedCharacters.slice(),
        meta: { savedAt: rosterMeta.savedAt, source: rosterMeta.source }
    };

    const importSource = (parsed && parsed.source) ? parsed.source : "import";
    applyRoster(known, importSource);

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
        savedAt: rosterBackup.meta.savedAt,
        source: rosterBackup.meta.source
    };
    // Persist the restored state under the new schema.
    saveRoster(rosterMeta.source || "manual");
    rosterBackup = null;
    rosterMessage = { text: "Import undone. Previous roster restored.", kind: "ok" };
    render();
}

// ─── BOOT ───────────────────────────────────────────────────────────────────

requestPersistentStorage();  // best-effort eviction resistance
loadRoster();                // hydrate roster (with migration) before first paint
loadData();
