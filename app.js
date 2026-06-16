// app.js
const APP_VERSION = "1.4";
const API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

let gacData = {};
let currentMode = "5v5";
let usedTeams = JSON.parse(localStorage.getItem("usedTeams") || "[]");
let searchText = "";

async function loadData() {
    try {
        const response = await fetch(API_URL);
        gacData = await response.json();
        render();
    } catch (error) {
        document.getElementById("app").innerHTML = "Error: " + error.message;
        console.error(error);
    }
}

function render() {
    const app = document.getElementById("app");
    const teams = Object.keys(gacData[currentMode] || {})
    .filter(team =>
        team.toLowerCase().includes(searchText.toLowerCase())
    )
    .sort((a, b) => a.localeCompare(b));

    app.innerHTML = `

<div class="round-card">

    <div class="round-title">
        🏆 CURRENT ROUND
    </div>

    <div class="round-stat">
        Used Teams: ${getUsedTeamCount()}
    </div>

    <button
        class="reset-button"
        onclick="resetRound()"
    >
        Reset Round
    </button>

</div>

<div class="mode-toggle">

    <button
        class="mode-button ${currentMode === "5v5" ? "active" : ""}"
        onclick="setMode('5v5')"
    >
        5v5
    </button>

    <button
        class="mode-button ${currentMode === "3v3" ? "active" : ""}"
        onclick="setMode('3v3')"
    >
        3v3
    </button>

</div>

<input
    type="text"
    id="searchBox"
    class="search-box"
    placeholder="Search defence team..."
    value="${searchText}"
    oninput="updateSearch(this.value)"
>

<select
    id="teamSelect"
    class="team-select"
    onchange="showCounters()"
>
    ${teams.map(team =>
        `<option value="${team}">${team}</option>`
    ).join("")}
</select>

<div id="results"></div>

<div class="footer">
    v${APP_VERSION}
</div>
`;

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
        teams.map(team =>
            `<option value="${team}">${team}</option>`
        ).join("");

    showCounters();
}

// FIXED: Extracted into its own properly scoped function
function getTierColour(tier) {
    switch ((tier || "").toUpperCase()) {
        case "S": return "#1976D2"; // Blue
        case "A": return "#4CAF50"; // Green
        case "B": return "#FF9800"; // Amber
        case "C": return "#F44336"; // Red
        default: return "#999999";
    }
}

// FIXED: Moved outside of getTierColour
function markUsed(teamName) {
    if (!usedTeams.includes(teamName)) {
        usedTeams.push(teamName);
        localStorage.setItem("usedTeams", JSON.stringify(usedTeams));
    }
    showCounters();
}
function getUsedTeamCount() {
    return usedTeams.length;
}
// FIXED: Moved outside of getTierColour
function resetRound() {

    const confirmed = confirm(
        "Clear all used teams?"
    );

    if (!confirmed) {
        return;
    }

    usedTeams = [];
    localStorage.removeItem("usedTeams");

    render();
}

function showCounters() {
    
    const teamSelect = document.getElementById("teamSelect");
    if (!teamSelect || !teamSelect.value) return;
    
if (teamSelect.options.length === 0) {
    document.getElementById("results").innerHTML =
        "<p>No matching defence teams found.</p>";
    return;
}
    
    const team = teamSelect.value;
    const counters = ((gacData[currentMode] && gacData[currentMode][team]) || [])
    .sort((a, b) => {

        const tierOrder = {
            "S": 1,
            "A": 2,
            "B": 3,
            "C": 4
        };

        const tierDiff =
            (tierOrder[a.tier?.toUpperCase()] || 99) -
            (tierOrder[b.tier?.toUpperCase()] || 99);

        if (tierDiff !== 0) {
            return tierDiff;
        }

        return (
            Number(b.bannerScore || 0) -
            Number(a.bannerScore || 0)
        );
    });

    document.getElementById("results").innerHTML = counters.map(counter => {
        const isUsed = usedTeams.includes(counter.counter);

        return `
<div class="counter-card ${isUsed ? "used" : ""}">

    <div class="card-header">

        <div class="team-name">
            ${counter.counter}
        </div>

        <span
            class="tier-badge"
            style="background:${getTierColour(counter.tier)};"
        >
            ${counter.tier}
        </span>

    </div>

    <div>
        🎯 <strong>Expected Banners:</strong>
        ${counter.bannerScore || "-"}
    </div>

    <div>
        👥 <strong>Undersize:</strong>
        ${counter.undersize || "-"}
    </div>

    <div>
        📝 <strong>Notes:</strong>
        ${counter.notes || "-"}
    </div>

    ${
        isUsed
        ? `<div class="used-label">✓ USED</div>`
        : `<button
              class="mark-used-button"
              onclick="markUsed('${counter.counter}')"
           >
              Mark Used
           </button>`
    }

</div>
`;
    }).join("");
}

// Start the app
loadData();
