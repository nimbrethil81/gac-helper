// app.js
const APP_VERSION = "1.2";

const API_URL = "https://script.google.com/macros/s/AKfycbwSg1axISAAWN2AIMq5U6suLdj9yrfgeT1h2Nys_NT2M0D-9NA-xJ8YVKKMLKKiDcKMdA/exec";

let gacData = {};
let currentMode = "5v5";

async function loadData() {
    try {
        const response = await fetch(API_URL);
        gacData = await response.json();
        render();
        
    } catch (error) {
    document.getElementById("app").innerHTML =
        "Error: " + error.message;

    console.error(error);
}
}
function render() {
    

const app = document.getElementById("app");
    const teams = Object.keys(gacData[currentMode] || {});

app.innerHTML = `
<h2>SWGOH Counters v${APP_VERSION}</h2>

    <button
        onclick="setMode('5v5')"
        style="
            padding:10px;
            margin-right:5px;
            font-weight:bold;
            background:${currentMode === "5v5" ? "#4CAF50" : "#ddd"};
            color:${currentMode === "5v5" ? "white" : "black"};
        "
    >
        5v5
    </button>

    <button
        onclick="setMode('3v3')"
        style="
            padding:10px;
            font-weight:bold;
            background:${currentMode === "3v3" ? "#4CAF50" : "#ddd"};
            color:${currentMode === "3v3" ? "white" : "black"};
        "
    >
        3v3
    </button>
        <br><br>
        <select id="teamSelect" onchange="showCounters()">
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

function getTierColour(tier) {
    switch ((tier || "").toUpperCase()) {
        case "S":
            return "#4CAF50"; // Green
        case "A":
            return "#2196F3"; // Blue
        case "B":
            return "#FF9800"; // Orange
        case "C":
            return "#F44336"; // Red
        default:
            return "#999999";
    }
}

function showCounters() {
    const teamSelect = document.getElementById("teamSelect");
    if (!teamSelect || !teamSelect.value) return;

    const team = teamSelect.value;
    const counters = gacData[currentMode][team] || [];

    // FIXED: Wrapped the HTML template in backticks so JavaScript handles it correctly
    document.getElementById("results").innerHTML = counters.map(counter => `
        <div style="border:1px solid #ccc; border-radius:8px; padding:10px; margin-top:10px;">
            <strong>${counter.counter}</strong><br>
            Tier:
<span
    style="
        background:${getTierColour(counter.tier)};
        color:white;
        padding:2px 8px;
        border-radius:12px;
        font-weight:bold;
    "
>
    ${counter.tier || "-"}
</span>
<br>
            Banner Score: ${counter.bannerScore || "-"}<br>
            Undersize: ${counter.undersize || "-"}<br>
            Notes: ${counter.notes || ""}
        </div>
    `).join("");
}

// Start the app
loadData();
