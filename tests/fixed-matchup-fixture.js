"use strict";

const path = require("node:path");
const { readSource } = require("../scripts/catalogue-source-lib.js");

const modeFile = mode => `matchups/${mode}.json`;
const defence = "Synthetic fixed-lineup defence";
const row = (counterId, tier = "A", bannerScore = 54) => ({ counterId, tier, bannerScore, undersize: 0, lineup: "FIXED" });
const units = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"].map(id => ({
    id: `TEST_${id}`, name: `Synthetic ${id[0] + id.slice(1).toLowerCase()}`, unitType: "CHARACTER", externalId: `TEST_${id}`
}));
const definitions = [
    { id: "TEST_DUO", name: "Synthetic duo", required: ["TEST_BRAVO", "TEST_CHARLIE"], recommended: [] },
    { id: "TEST_FOUR", name: "Synthetic quartet", required: ["TEST_ALPHA", "TEST_BRAVO", "TEST_CHARLIE", "TEST_DELTA"], recommended: [] },
    { id: "TEST_OVERLAP", name: "Synthetic overlapping duo", required: ["TEST_ALPHA", "TEST_CHARLIE"], recommended: [] },
    { id: "TEST_SOLO", name: "Synthetic solo", required: ["TEST_ALPHA"], recommended: [] }
];

function fixtureSource() {
    const { source } = readSource(path.resolve(__dirname, "../catalogue/source"));
    const append = (file, rows, key) => {
        source[file].push(...structuredClone(rows));
        source[file].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    };
    append("units.json", units, "id");
    append("counters.json", definitions, "id");
    append(modeFile("3v3"), [{ defence, counters: [row("TEST_SOLO", "S"), row("TEST_DUO")] }], "defence");
    append(modeFile("5v5"), [{ defence, counters: [row("TEST_FOUR", "A", 66)] }], "defence");
    return source;
}

module.exports = { fixtureSource, row, modeFile, defence };
