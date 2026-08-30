// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Comlink base URL is held here, server-side, so it never reaches the client.
const COMLINK_URL = "https://gac-helper-comlink.onrender.com";

// ─── ROUTER ──────────────────────────────────────────────────────────────────

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || "data").toLowerCase();

  if (action === "roster") {
    return jsonOut(fetchRoster(params.allyCode));
  }

  return jsonOut(buildDataPayload());
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Resolve a column index by header name, falling back to a fixed index
// so the script keeps working if a header is renamed or absent.
function col(headers, name, fallback) {
  const idx = headers.indexOf(name);
  return idx >= 0 ? idx : fallback;
}

// ─── DATA PAYLOAD (default action) ───────────────────────────────────────────

function buildDataPayload() {

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const countersSheet      = ss.getSheetByName("Counters");
  const counterDefsSheet   = ss.getSheetByName("Counter_Definitions");
  const counterCompSheet   = ss.getSheetByName("Counter_Composition");
  const characterDefsSheet = ss.getSheetByName("Character_Definitions");

  const countersData      = countersSheet.getDataRange().getValues();
  const counterDefsData   = counterDefsSheet.getDataRange().getValues();
  const counterCompData   = counterCompSheet.getDataRange().getValues();
  const characterDefsData = characterDefsSheet.getDataRange().getValues();

  const output = {
    counters: { "5v5": {}, "3v3": {} },
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {}
  };

  //
  // COUNTERS
  //
  const counterHeaders = countersData[0];

  for (let i = 1; i < countersData.length; i++) {
    const row = countersData[i];
    const entry = {};
    counterHeaders.forEach((h, idx) => { entry[h] = row[idx]; });

    // Skip structurally empty rows.
    //
    // The Counter Team and Score Meaning columns are open-ended ARRAYFORMULAs, so
    // getDataRange() now reports the full sheet height even though the trailing
    // rows evaluate to "". A formula cell counts as used whether or not it
    // produces a value. Without this guard every one of those rows would push an
    // entry under counters[""][""], inflating the payload the phone downloads on
    // every load for no benefit.
    //
    // A row needs all three of Counter_ID, Mode and Defence Team to be usable:
    // Mode and Defence Team are the keys the counter is filed under, and without
    // a Counter_ID there is no composition to resolve, so the entry could never
    // be displayed. Every other loop in this file already guards on its key
    // column; this brings Counters into line with them.
    const counterId = String(entry["Counter_ID"] || "").trim();
    const mode      = String(entry["Mode"] || "").trim();
    const team      = String(entry["Defence Team"] || "").trim();

    if (!counterId || !mode || !team) continue;

    if (!output.counters[mode]) output.counters[mode] = {};
    if (!output.counters[mode][team]) output.counters[mode][team] = [];

    output.counters[mode][team].push({
      counterId:   counterId,
      counter:     entry["Counter Team"],
      tier:        entry["Tier"],
      bannerScore: entry["Banner Score"],
      undersize:   parseUndersize(entry["Undersize"]),
      notes:       entry["Notes"]
    });
  }

  //
  // COUNTER DEFINITIONS
  //
  for (let i = 1; i < counterDefsData.length; i++) {
    const row = counterDefsData[i];
    const counterId = String(row[0]).trim();
    if (!counterId) continue;

    output.counterDefinitions[counterId] = {
      name:        String(row[1]).trim(),
      required:    [],
      recommended: []
    };
  }

  //
  // COUNTER COMPOSITION
  //
  for (let i = 1; i < counterCompData.length; i++) {
    const row         = counterCompData[i];
    const counterId   = String(row[0]).trim();
    const characterId = String(row[1]).trim();
    const role        = String(row[2]).trim().toUpperCase();

    if (!counterId || !characterId) continue;

    if (!output.counterDefinitions[counterId]) {
      output.counterDefinitions[counterId] = {
        name: counterId, required: [], recommended: []
      };
    }

    if (role === "REQUIRED") {
      output.counterDefinitions[counterId].required.push(characterId);
    } else if (role === "RECOMMENDED") {
      output.counterDefinitions[counterId].recommended.push(characterId);
    }
  }

  //
  // CHARACTER DEFINITIONS
  // Returns { name, unitType, externalId }. externalId is the game/swgoh.gg
  // base_id, read by header so it's optional until the External_ID column exists.
  //
  const charHeaders = characterDefsData[0];
  const cId   = col(charHeaders, "Character_ID",   0);
  const cName = col(charHeaders, "Character_Name", 1);
  const cType = col(charHeaders, "Unit_Type",      2);
  const cExt  = charHeaders.indexOf("External_ID"); // -1 if not present yet

  for (let i = 1; i < characterDefsData.length; i++) {
    const row = characterDefsData[i];
    const characterId = String(row[cId]).trim();
    if (!characterId) continue;

    output.characterDefinitions[characterId] = {
      name:       String(row[cName]).trim(),
      unitType:   String(row[cType]).trim().toUpperCase(),
      externalId: cExt >= 0 ? String(row[cExt]).trim() : ""
    };
  }

  //
  // BOARD CONFIG (v2.1)
  // Per-territory defence team counts, keyed league → mode → ordered territory
  // list. Territory order is preserved from the sheet. Guarded: a missing or
  // empty tab yields an empty object rather than an error, so this addition
  // can never break the existing payload.
  //
  output.boardConfig = buildBoardConfig(ss);

  //
  // SCORING (v2.1)
  // GAC banner economy rules as flat rows; (Rule_ID, Battle_Type, Mode) is the
  // composite key. Resolution logic stays client-side. Guarded like boardConfig.
  //
  output.scoring = buildScoring(ss);

  //
  // DEFENCE TEAMS (v3.0)
  // Authored per-defence-team attributes — currently just the Threat rating that
  // feeds Battle Order. Guarded exactly like boardConfig and scoring: a missing
  // or empty tab yields an empty object, and the client reads every team as
  // NORMAL, so the feature works before a single rating is authored.
  //
  output.defenceTeams = buildDefenceTeams(ss);

  return output;
}

// Parse the Counters sheet's Undersize column into a droppable-unit count (v2.8).
// The column changed from "Yes"/"No" strings to a number: the maximum units a
// counter can drop from a full squad and still win cleanly (0 = full squad).
// Anything non-numeric — including the legacy "Yes"/"No" strings on rows not yet
// migrated, or a blank cell — resolves to 0, so a partially-migrated sheet is
// always safe: an un-migrated row simply carries no undersize advice rather than
// a wrong value. Negatives and fractions are clamped/floored to a sane count.
function parseUndersize(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// ─── BOARD CONFIG (GAC_Board_Config tab) ────────────────────────────────────

function buildBoardConfig(ss) {
  const sheet = ss.getSheetByName("GAC_Board_Config");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};

  const headers = data[0];
  const cLeague    = col(headers, "League",         0);
  const cMode      = col(headers, "Mode",           1);
  const cTerritory = col(headers, "Territory",      2);
  const cType      = col(headers, "Territory_Type", 3);
  const cCount     = col(headers, "Team_Count",     4);

  const config = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const league    = String(row[cLeague]).trim().toUpperCase();
    const mode      = String(row[cMode]).trim();           // "5v5"/"3v3", kept verbatim to match counters keys
    const territory = String(row[cTerritory]).trim().toUpperCase();
    const type      = String(row[cType]).trim().toUpperCase();
    const count     = Number(row[cCount]);

    if (!league || !mode || !territory) continue;

    if (!config[league]) config[league] = {};
    if (!config[league][mode]) config[league][mode] = [];

    config[league][mode].push({
      territory: territory,                    // FRONT_TOP | FRONT_BOTTOM | BACK_TOP | BACK_BOTTOM
      type:      type,                         // SQUAD | FLEET
      teamCount: isNaN(count) ? 0 : count
    });
  }

  return config;
}

// ─── SCORING (GAC_Scoring tab) ───────────────────────────────────────────────

function buildScoring(ss) {
  const sheet = ss.getSheetByName("GAC_Scoring");
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const cRule  = col(headers, "Rule_ID",     0);
  const cBType = col(headers, "Battle_Type", 1);
  const cMode  = col(headers, "Mode",        2);
  const cValue = col(headers, "Value",       3);
  const cNotes = headers.indexOf("Notes");   // optional

  const rules = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const ruleId = String(row[cRule]).trim().toUpperCase();
    if (!ruleId) continue;

    const value = Number(row[cValue]);

    rules.push({
      ruleId:     ruleId,
      battleType: String(row[cBType]).trim().toUpperCase(),  // SQUAD | FLEET | ANY
      mode:       String(row[cMode]).trim(),                 // "5v5" | "3v3" | "ANY"
      value:      isNaN(value) ? 0 : value,
      notes:      cNotes >= 0 ? String(row[cNotes]).trim() : ""
    });
  }

  return rules;
}

// ─── DEFENCE TEAMS (Defence_Teams tab, v3.0) ─────────────────────────────────
// Authored attributes of an ENEMY defence team, keyed by the same display name
// the Counters tab uses in its "Defence Team" column — so the board, the counter
// catalogue and this tab all agree on one name.
//
// Shape: mode → defence team name → { threat, notes }. Mode is kept verbatim
// ("5v5" / "3v3" / "FLEET"), matching how boardConfig stores it; a blank mode
// becomes "ANY", which the client treats as a wildcard that a mode-specific row
// overrides. Threat is upper-cased here so the client never has to normalise.
//
// Threat exists because catalogue depth measures the DATA, not the enemy: a
// thinly-documented easy team would otherwise look scarcer than a Galactic
// Legend with two well-known answers. A blank or unrecognised Threat resolves to
// NORMAL client-side, so partial authoring is always safe.

function buildDefenceTeams(ss) {
  const sheet = ss.getSheetByName("Defence_Teams");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};

  const headers = data[0];
  const cTeam   = col(headers, "Defence_Team", 0);
  const cMode   = col(headers, "Mode",         1);
  const cThreat = col(headers, "Threat",       2);
  const cNotes  = headers.indexOf("Notes");    // optional

  const teams = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const team = String(row[cTeam]).trim();
    if (!team) continue;

    const modeRaw = String(row[cMode]).trim();
    const mode    = modeRaw ? modeRaw : "ANY";

    if (!teams[mode]) teams[mode] = {};

    teams[mode][team] = {
      threat: String(row[cThreat]).trim().toUpperCase(),   // "" is fine; client reads it as NORMAL
      notes:  cNotes >= 0 ? String(row[cNotes]).trim() : ""
    };
  }

  return teams;
}

// ─── ROSTER FETCH (action=roster) ────────────────────────────────────────────
// Thin proxy: server-side POST to a self-hosted SWGOH Comlink instance, which
// talks directly to the game's read-only APIs (no swgoh.gg, so no Cloudflare
// challenge). Returns base_ids only; the client maps base_id → Character_ID and
// classifies, keeping this endpoint dumb. Response contract is unchanged from
// the previous swgoh.gg implementation.
//
// Comlink /player returns rosterUnit[].definitionId as "BASEID:RARITY"
// (e.g. "MAGMATROOPER:SEVEN_STAR"); the base_id is the part before the colon.

function fetchRoster(allyCodeRaw) {
  const allyCode = String(allyCodeRaw || "").replace(/\D/g, "");
  if (allyCode.length !== 9) {
    return { ok: false, error: "invalid_ally_code" };
  }

  const url = COMLINK_URL + "/player";
  const body = JSON.stringify({
    payload: { allyCode: allyCode },
    enums: false
  });

  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: body,
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    return { ok: false, error: "fetch_failed", detail: String(err) };
  }

  const code = resp.getResponseCode();
  if (code === 404) return { ok: false, error: "not_found" };
  if (code === 429) return { ok: false, error: "rate_limited" };
  if (code !== 200) return { ok: false, error: "fetch_failed", status: code };

  let parsed;
  try {
    parsed = JSON.parse(resp.getContentText());
  } catch (err) {
    return { ok: false, error: "bad_response" };
  }

  // A valid account always carries a rosterUnit array. Its absence means the
  // game rejected the ally code (unknown / not synced) rather than a transport
  // failure, so we report it as not_found.
  const roster = parsed && parsed.rosterUnit;
  if (!Array.isArray(roster)) {
    return { ok: false, error: "not_found" };
  }

  const ownedBaseIds = [];
  const seen = {};
  roster.forEach(u => {
    const defId = u && u.definitionId;
    if (!defId) return;
    const baseId = String(defId).split(":")[0];
    if (baseId && !seen[baseId]) {
      seen[baseId] = true;
      ownedBaseIds.push(baseId);
    }
  });

  return {
    ok: true,
    allyCode: allyCode,
    syncedAt: new Date().toISOString(),
    ownedBaseIds: ownedBaseIds
  };
}

function authorise() {
  // One-off: triggers the external-request consent prompt if not already granted.
  // Safe to delete. (Your existing UrlFetchApp scope already covers this.)
  UrlFetchApp.fetch(COMLINK_URL + "/player", {
    method: "post",
    contentType: "application/json",
    payload: '{"payload":{"allyCode":"124246291"},"enums":false}',
    muteHttpExceptions: true
  });
}
