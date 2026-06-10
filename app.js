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
        <h2>SWGOH Counters v${APP_VERSION}</h2>
        <button onclick="resetRound()" style="margin-bottom:10px; padding:8px 12px; background:#f44336; color:white; border:none; border-radius:6px;">
            Reset GAC Round
        </button>
        <br><br>
        <button onclick="setMode('5v5')" style="padding:10px; margin-right:5px; font-weight:bold; background:${currentMode === "5v5" ? "#4CAF50" : "#ddd"}; color:${currentMode === "5v5" ? "white" : "black"};">
            5v5
        </button>
        <button onclick="setMode('3v3')" style="padding:10px; font-weight:bold; background:${currentMode === "3v3" ? "#4CAF50" : "#ddd"}; color:${currentMode === "3v3" ? "white" : "black"};">
            3v3
        </button>
        <br><br>

<input
    type="text"
    id="searchBox"
    placeholder="Search defence team..."
    value="${searchText}"
    oninput="updateSearch(this.value)"
    style="width:100%; padding:10px; margin-bottom:10px; box-sizing:border-box;"
>

<select id="teamSelect" onchange="showCounters()" style="width:100%; padding:10px;">
    ${teams.map(team => `<option value="${team}">${team}</option>`).join("")}
</select>

<div id="results"></div>
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

// FIXED: Moved outside of getTierColour
function resetRound() {
    usedTeams = [];
    localStorage.removeItem("usedTeams");
    render(); // Changed to render() so the main view updates and reflects the reset changes
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
<div style="
    border:1px solid #ddd;
    border-radius:12px;
    padding:14px;
    margin-top:12px;
    background:white;
    box-shadow:0 2px 4px rgba(0,0,0,0.08);
    opacity:${isUsed ? "0.5" : "1"};
">

    <div style="
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:10px;
    ">

        <div style="
            font-size:18px;
            font-weight:bold;
        ">
            ${counter.counter}
        </div>

        <span style="
            background:${getTierColour(counter.tier)};
            color:white;
            padding:4px 12px;
            border-radius:16px;
            font-weight:bold;
            font-size:14px;
        ">
            ${counter.tier === "S" ? "⭐ S" :
  counter.tier === "A" ? "🟢 A" :
  counter.tier === "B" ? "🟠 B" :
  counter.tier === "C" ? "🔴 C" :
  counter.tier}
        </span>

    </div>

    <div style="margin-bottom:6px;">
        🎯 <strong>Expected Banners:</strong> ${counter.bannerScore || "-"}
    </div>

    <div style="margin-bottom:6px;">
        👥 <strong>Undersize:</strong> ${counter.undersize || "-"}
    </div>

    <div style="margin-bottom:10px;">
        📝 <strong>Notes:</strong> ${counter.notes || "-"}
    </div>
                ${isUsed 
                    ? `<strong style="color:red;">✓ USED</strong>` 
                    : `<button onclick="markUsed('${counter.counter}')">Mark Used</button>`
                }
            </div>
        `;
    }).join("");
}

// Start the app
loadData();
