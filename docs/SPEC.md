# SWGOH GAC Helper — Project Specification

A mobile-first Progressive Web App that helps players make faster, better Grand Arena Championship (GAC) decisions in *Star Wars: Galaxy of Heroes*.

---

## Contents

1. [Overview](#1-overview)
   - 1.1 [Design Philosophy](#11-design-philosophy)
   - 1.2 [Target User](#12-target-user)
2. [Design Principles](#2-design-principles)
3. [Architecture](#3-architecture)
   - 3.1 [Frontend](#31-frontend)
   - 3.2 [Backend](#32-backend)
   - 3.3 [Data Flow](#33-data-flow)
   - 3.4 [State & Persistence](#34-state--persistence)
4. [Data Model](#4-data-model)
   - 4.1 [Sheet Structure](#41-sheet-structure)
   - 4.2 [Identifier Standards](#42-identifier-standards)
5. [API Contract](#5-api-contract)
6. [Current Features](#6-current-features)
   - 6.1 [Counter Lookup](#61-counter-lookup)
   - 6.2 [Used Team Tracking](#62-used-team-tracking)
   - 6.3 [Banner Tracking](#63-banner-tracking)
   - 6.4 [Roster Management](#64-roster-management)
   - 6.5 [Counter Status](#65-counter-status)
   - 6.6 [Round Screen](#66-round-screen)
   - 6.7 [Opponent Board](#67-opponent-board)
   - 6.8 [Allocation Engine](#68-allocation-engine)
   - 6.9 [Points to Win](#69-points-to-win)
7. [Roster Model](#7-roster-model)
8. [Roadmap](#8-roadmap)
9. [Success Criteria](#9-success-criteria)
10. [Future Vision](#10-future-vision)

---

## 1. Overview

SWGOH GAC Helper is a lightweight companion app for use during live GAC rounds. It provides a fast counter-lookup experience focused on practical, in-the-moment decision-making, and is evolving incrementally from a simple lookup tool into a personal GAC planning assistant.

The app is designed to answer, within seconds: *which counters beat this enemy team, which are still available to me, and which have I already used?*

It deliberately models **strategic team identities** rather than exact squad compositions. The guiding question is always "can the player reasonably field this counter?" — not "what is the perfect mod-and-relic squad for this specific matchup?"

The app models both **character counters and fleet counters**. Fleet combat is a genuine GAC feature — one of the four territories in every round is a fleet battle — and was brought inside the same model in v2.5 (see [§8](#8-roadmap)): ships and capital ships are imported and shown on the roster, fleet counters are looked up alongside squad counters, and the fleet territory participates in the Round board and the allocation engine. Where this document refers to "counters" without qualification, it means character counters unless the surrounding context is fleet.

The long-term direction is a roster-aware GAC strategist that can recommend attack order, allocate counters efficiently, optimise banners, and avoid conflicts — while always prioritising simplicity and speed over replicating the full depth of sites like SWGOH.gg.

### 1.1 Design Philosophy

* **Fast** — find a counter within seconds, mid-match.
* **Mobile-first** — built for phones and Home Screen PWA installation.
* **Maintainable** — counter data is editable in Google Sheets without touching application code.
* **Incremental** — features ship in stages; the app stays functional throughout.
* **Identity over composition** — counters represent team identities, not squad variations.
* **Cache-first** — local data is the working store; the network is a refresh mechanism, never a dependency.

### 1.2 Target User

* Intermediate to advanced SWGOH players.
* Regular GAC participants who want to maximise banners and efficiency.
* Players who maintain their own counter knowledge and roster data.

---

## 2. Design Principles

**Mobile first.** The interface is optimised for iPhone and Android, and for installation as a standalone Home Screen PWA. Navigation between top-level views uses a fixed bottom navigation bar.

**Fast.** Lookup is the critical path. A user should reach a counter list in as few taps as possible, with search and mode selection always to hand.

**Maintainable.** All game data lives in Google Sheets. Adding counters, adjusting tiers, or editing notes requires no code change and no redeployment of the frontend.

**Incremental.** Each version delivers a self-contained, working improvement. The app is never left in a broken intermediate state between releases.

**Cache-first, network-second.** The app must be fully usable mid-GAC on poor venue wifi. It always renders from local state first and treats remote calls (roster import) as background refreshes that can fail silently without blocking the user.

---

## 3. Architecture

The app is a static frontend served from GitHub Pages, backed by a read-only JSON API built on Google Apps Script over Google Sheets. There is no server-side application code beyond the Apps Script endpoint, and no database other than the spreadsheet.

### 3.1 Frontend

Hosted on GitHub Pages.

* **index.html** — app shell; loads styles and scripts; registers the service worker.
* **styles.css** — theme, layout, responsive design, component styling.
* **app.js** — data loading, state management, rendering, counter lookup, used-team tracking, banner tracking, roster management, roster import, availability calculation, opponent-board management, and the allocation engine.
* **service-worker.js** — PWA offline shell.
* **manifest.json** — PWA metadata.

### 3.2 Backend

* **Google Sheets** — primary data store and single source of truth for all game data, including the `External_ID` (swgoh.gg base_id) mapping column, the per-league board configuration, and the GAC banner scoring rules.
* **Google Apps Script** — a `doGet` web app with a lightweight `action` router:
  * `action=data` (default) — reads the sheets and returns the consolidated counter/definition payload consumed by the frontend, including the board configuration and scoring rules.
  * `action=roster&allyCode=…` — a thin server-side proxy that calls the roster provider and returns base_ids only. This exists solely to clear the browser CORS barrier; it performs no mapping or business logic of its own.

The roster proxy is deliberately "dumb": it returns the player's owned `base_id`s and a sync timestamp, and the client performs all mapping and classification. This keeps the payload small (important for the poor-wifi scenario), keeps the sheet as the single source of truth for the ID mapping, and avoids re-reading the sheet on every sync.

### 3.3 Data Flow

The counter-data flow is **read-only**: the app fetches data but never writes back to Sheets. This is a deliberate architectural choice — it keeps the app simple and avoids the authentication, write-API, concurrency, and security overhead that write-back would introduce. Roster import is also read-only with respect to the game: data flows inward only.

### 3.4 State & Persistence

All player-specific state is held client-side in `localStorage`:

* **Used teams** — keyed on `Counter_ID`, persisted across app launches.
* **Owned units** — versioned roster object `{schema, savedAt, source, allyCode, syncedAt, owned[]}`, single save/load path, migration from the pre-v1.9 bare array and from the v1 schema. `Character_ID` is the persisted key (ships and capital ships are stored under the same key space as characters, since all units share the `Character_ID` namespace). Provenance is tracked in `source` (`manual`, `import`, or the API sentinel); `savedAt` records the last local write of any kind, while `syncedAt` records the last successful API return — these are distinct facts and both are meaningful for data freshness.
* **Banner tracking** — the current round's scores (own, opponent, remaining), persisted across app launches and cleared by Reset Round.
* **Opponent board** — versioned board object `{schema, league, mode, createdAt, territories[], teams[]}`, hydrated before first paint via the same defensive load pattern as the roster. The board is present only for the current round and is cleared by Reset Round together with used teams and banner tracking. Per-team `cleared` flags are the source of truth; territory-cleared state is always derived, never stored. The territory layout (which territories exist, their type, and how many teams each holds) is snapshotted into the board at setup, so an in-progress round renders identically even if the underlying configuration data changes later. From v2.5 the board schema is **2**: boards include team rows for the fleet territory as well as the squad territories; older schema-1 boards (which carried no fleet rows) are discarded on load so a fresh, fleet-aware board is set up. `mode` is always a **squad format** (`5v5` or `3v3`) frozen at setup — "Fleet" is a browsing view on the Counters screen, never a whole-board format (see [§6.7](#67-opponent-board)).
* **League setting** — persisted user preference (`Kyber`, `Aurodium`, `Chromium`, `Bronzium`, or `Carbonite`), remembered across rounds and used to pre-fill the board setup card.
* **Last squad format** — persisted `5v5`/`3v3` preference (`lastSquadMode`). It records the most recent squad format selected on the Counters toggle, and is used to seed the board's format when the toggle is on Fleet at setup time (see [§6.7](#67-opponent-board)).

**Cache-first model.** localStorage is the working store; the roster API is a refresh mechanism, not a dependency. On boot the app renders from cached roster data instantly (`loadRoster()` runs before any network call), then — only for API-sourced rosters, and only if `syncedAt` is older than a staleness threshold (12 hours) — fires a silent background refresh. The refresh never runs while the Roster screen is open (so it cannot disrupt a mid-edit interaction), and applies only if the owned set actually changed, with an Undo snapshot when it does. If the refresh fails or times out, the app stays silently on cached data. The app is fully functional on cached data alone.

**Storage durability.** The app makes a best-effort `navigator.storage.persist()` request on boot to reduce OS eviction; this is effective on Chromium/Android and desktop. On Safari, Private Browsing uses ephemeral storage that is cleared at session end regardless of `persist()` — this is expected WebKit behaviour, not a bug, and was the reproducible cause of earlier roster-loss reports (an earlier provisional attribution to iOS app-switcher eviction was a misdiagnosis). Normal (non-private) browsing retains storage. The durable backstops against any loss are manual Export/Import and one-tap re-import via ally code.

Because state is local to the device and browser, it does not sync across devices and is lost if site data is cleared or the PWA is reinstalled in a context without durable storage. With ally-code import in place, recovery is a single tap (re-enter or reuse the stored ally code) rather than a manual rebuild.

**Roster import timeout.** User-initiated import and refresh use a 60-second timeout. This is generous by design: the roster proxy is hosted on Render's free tier, which cold-starts on the first request after a period of inactivity, and a shorter timeout produced spurious failures on a first import of the day. Background refreshes inherit the same timeout but fail silently.

---

## 4. Data Model

### 4.1 Sheet Structure

The Google Sheet is the **schema source of truth**. Exact column names and ordering are defined in the sheet itself and are intentionally **not duplicated here**, to avoid drift between the spec and the live data. This section describes the *purpose and relationships* of each tab rather than its literal columns.

**Counters** — the core relationship table. Maps an enemy defence team (per mode) to one or more counter teams, each with a tier, expected banner score, undersize flag, and optional notes. This is the data that drives the lookup screen. The `Mode` column carries `5v5`, `3v3`, or `FLEET`; fleet counters are authored here exactly like squad counters, keyed by `Mode = FLEET`.

**Counter_Definitions** — the identity registry for counter teams. One row per counter, holding its stable `Counter_ID` and display name. Identity only; membership lives in Counter_Composition. Fleet counters live here too, their membership being ships and capital ships rather than characters.

**Counter_Composition** — the membership table. One row per unit in a counter team, recording the `Counter_ID`, the `Character_ID`, and whether that unit is `REQUIRED` or `RECOMMENDED`. This normalised structure replaced the earlier approach of packing character lists into single cells, and allows data validation on the character column to prevent invalid IDs at entry time. For a fleet counter, the `Character_ID`s reference `SHIP`/`CAPITAL_SHIP` units.

**Character_Definitions** — the master unit registry. One row per playable unit, holding its stable `Character_ID`, display name, `Unit_Type` (`CHARACTER`, `SHIP`, or `CAPITAL_SHIP`), and `External_ID`. This is the source for the roster screen, for validation, and for import matching.

> **`External_ID` is a translation adapter, not the primary key.** It holds the SWGOH.gg `base_id` for a unit, used only to translate imported rosters into internal `Character_ID`s. The internal key remains `Character_ID`; this keeps the data model independent of an external namespace that is controlled by Capital Games and can change. Only the units that appear as `REQUIRED` in Counter_Composition strictly need a mapping for availability to work; others can be populated opportunistically. base_ids must be taken from the SWGOH.gg character-list endpoint, not derived from display names — several are non-obvious (e.g. Jedi Master Luke, Sith Eternal Emperor) and a wrong value fails silently.

**GAC_Board_Config** — the per-league board layout. One row per (League, Mode, Territory) combination, holding the `Territory_Type` (`SQUAD` or `FLEET`) and the `Team_Count` — how many defence teams that territory holds in that league and format. This feeds the Round screen's board setup: choosing a league and mode pre-generates exactly the right number of team pickers per territory. Territory order within a league/mode is preserved from the sheet (Front Top, Front Bottom, Back Top, Back Bottom). The tab is guarded on the backend: if it is missing or empty the payload carries an empty object, so the sheet can be edited or rearranged without breaking the endpoint.

**GAC_Scoring** — the GAC banner economy. One row per rule, keyed by `Rule_ID` plus `Battle_Type` (`SQUAD`, `FLEET`, or `ANY`) plus `Mode` (`5v5`, `3v3`, or `ANY`). Values cover victory bonuses, first- and second-attempt bonuses, per-unit surviving/full-health/full-protection bonuses, unused-slot bonuses, defeated-enemy points, first-attack bonus, and territory-clear bonuses. This is the single source of truth for banner scoring and is the data source consumed by the Points-to-Win calculator (see [§6.9](#69-points-to-win)). As of v2.6 the tab also carries `OWN_UNITS` and `ENEMY_UNITS` rows — the count of the player's own units that earn per-unit survival bonuses in a clean win, and the count of enemy units defeated. These are equal for squad battles (5v5 → 5, 3v3 → 3) but modelled as two values because a full fleet fields and defeats eight units on each side, and the two counts diverge in the general case. The app supplies correct fallbacks for these counts, so the calculator is accurate even before the rows are populated; adding them keeps the sheet the single source of truth. Values were initially sourced from the SWGOH Wiki; the fleet per-ship and defeated-enemy values in particular remain earmarked for a spot-check against real battle results before the efficiency calculator (see [§8](#8-roadmap)) is built on them. Guarded like GAC_Board_Config.

**Roster** — reserved for future cloud-backed, account-specific roster data (relics, omicrons, notes). Not consumed by the app at this stage.

**GAC History** — reserved for future match-result tracking.

**Expected Banners** — a reference table mapping banner scores to their practical meaning.

> **Composition is mode-agnostic across squad formats.** The required core of a character counter is currently identical across 5v5 and 3v3, so composition does not carry a mode column. If a counter ever needs a genuinely different required core per mode, a `Mode` column (`5v5` / `3v3` / `BOTH`) can be added to Counter_Composition without disturbing the rest of the model. Fleet is modelled as an additional `Mode` value (`FLEET`) on the Counters tab rather than a separate format axis, since the fleet territory is present in every GAC regardless of the character format; a fleet counter's required core is its ships, drawn from the same Counter_Composition table.

### 4.2 Identifier Standards

Stable identifiers are central to the data model. Names can change; IDs must not.

**Counter_ID**
* Uppercase, underscores, no spaces.
* Stable once created.
* Examples: `LEIA`, `BANE`, `STARKILLER`, `GREAT_MOTHERS`, `BO_KATAN_MANDALORE`.

**Character_ID**
* Uppercase, underscores, no spaces.
* Based on official unit names, and aligned with SWGOH's internal naming style where practical. This is the stable internal key for all ownership and composition data, for ships and capital ships as well as characters.
* Stable once created.
* Examples: `LEIA_ORGANA`, `CAPTAIN_DROGAN`, `DARTH_BANE`, `EMPEROR_PALPATINE`.

**External_ID**
* The SWGOH.gg `base_id` for a unit (e.g. `GLLEIA`, `GRANDMASTERLUKE`, `SITHPALPATINE`).
* A translation adapter only — never used as an internal key.
* Authoritative source is the SWGOH.gg character-list endpoint; not derived from display names.

**League**
* Uppercase, no spaces. Enumerated: `KYBER`, `AURODIUM`, `CHROMIUM`, `BRONZIUM`, `CARBONITE`.

**Territory**
* Uppercase, underscored. Enumerated: `FRONT_TOP`, `FRONT_BOTTOM`, `BACK_TOP`, `BACK_BOTTOM`.

**Territory_Type** — enumerated: `SQUAD`, `FLEET`.

**Rule_ID** — uppercase, underscored, stable identifier for a scoring rule (e.g. `VICTORY`, `TERRITORY_CLEAR_PER_TEAM`, `UNUSED_SLOT`).

**Battle_Type** — enumerated: `SQUAD`, `FLEET`, `ANY`.

**Unit_Type** — enumerated: `CHARACTER`, `SHIP`, `CAPITAL_SHIP`. All-caps enum values keep them distinct from free text and make validation and filtering reliable. As of v2.5 the roster screen and import consume all three (`CHARACTER`, `SHIP`, and `CAPITAL_SHIP`).

**Role** — enumerated: `REQUIRED`, `RECOMMENDED`. Only `REQUIRED` units are considered for availability.

---

## 5. API Contract

The Apps Script exposes two actions behind a single `doGet` endpoint.

### `action=data` (default)

Returns a single JSON object with five top-level keys. This contract is the boundary between backend and frontend; the frontend depends on this shape rather than on sheet layout.

```json
{
  "counters": { "5v5": {}, "3v3": {} },
  "counterDefinitions": {},
  "characterDefinitions": {},
  "boardConfig": {},
  "scoring": []
}
```

**counters** — keyed by mode, then by defence team name, to an array of counter entries. Each entry carries its counter ID, display name, tier, banner score, undersize flag, and notes. The payload is seeded with the `5v5` and `3v3` keys so they always exist; a `FLEET` key is emitted automatically when the sheet contains counter rows whose `Mode` is `FLEET`. The mode string is used verbatim as the key, so a fleet counter's `Mode` cell must read exactly `FLEET`.

**counterDefinitions** — keyed by `Counter_ID`:

```json
{
  "LEIA": {
    "name": "Leia Organa",
    "required": ["LEIA_ORGANA"],
    "recommended": ["CAPTAIN_DROGAN", "R2_D2"]
  }
}
```

**characterDefinitions** — keyed by `Character_ID`:

```json
{
  "LEIA_ORGANA": { "name": "Leia Organa", "unitType": "CHARACTER", "externalId": "GLLEIA" }
}
```

`externalId` is read by header name and is optional: if the `External_ID` column is absent or a cell is blank, the field is returned empty and that unit simply won't match on import. This makes the column safe to add incrementally. `unitType` carries `CHARACTER`, `SHIP`, or `CAPITAL_SHIP`.

**boardConfig** — keyed by `League`, then by `Mode`, to an ordered array of territory descriptors:

```json
{
  "KYBER": {
    "5v5": [
      { "territory": "FRONT_TOP",    "type": "SQUAD", "teamCount": 4 },
      { "territory": "FRONT_BOTTOM", "type": "SQUAD", "teamCount": 4 },
      { "territory": "BACK_TOP",     "type": "FLEET", "teamCount": 3 },
      { "territory": "BACK_BOTTOM",  "type": "SQUAD", "teamCount": 3 }
    ]
  }
}
```

Territory order is preserved from the sheet. Missing or empty tab yields an empty object; the frontend renders a "board configuration hasn't loaded" notice in that case rather than failing.

**scoring** — a flat array of banner-economy rule rows. Composite key is (`ruleId`, `battleType`, `mode`):

```json
[
  { "ruleId": "VICTORY",                  "battleType": "ANY",   "mode": "ANY", "value": 15, "notes": "Per battle won" },
  { "ruleId": "TERRITORY_CLEAR_PER_TEAM", "battleType": "SQUAD", "mode": "5v5", "value": 30, "notes": "" }
]
```

Resolution logic is client-side. Missing or empty tab yields an empty array. The rules are consumed by the Points-to-Win Calculator (see [§8](#8-roadmap)); the current app payload is otherwise unaffected by this data.

Both `boardConfig` and `scoring` were added in v2.1 and are fully backwards-compatible: an older frontend ignores unknown keys. The `FLEET` counters bucket (v2.5) required no Apps Script change — it falls out of the existing mode-keyed loop.

### `action=roster&allyCode=…`

A thin proxy to the roster provider (a self-hosted SWGOH Comlink instance). Returns base_ids only; the client does all mapping and classification.

```json
{
  "ok": true,
  "allyCode": "123456789",
  "syncedAt": "2026-06-30T12:00:00.000Z",
  "ownedBaseIds": ["GLLEIA", "GRANDMASTERLUKE", "..."]
}
```

On failure it returns `{ "ok": false, "error": "<code>" }`, where `<code>` is one of `invalid_ally_code`, `not_found`, `rate_limited`, `fetch_failed`, or `bad_response`. The client maps each to user-facing copy.

---

## 6. Current Features

### 6.1 Counter Lookup

The user selects a mode (5v5 / 3v3 / Fleet) and a defence team, and sees the available counters. Each counter card displays the counter team name, tier (colour-coded), expected banners, undersize viability, and notes. A search box filters the defence-team list, and counters are sorted by status group, then tier, then by banner score.

The **Fleet** segment shows fleet counters exactly as the squad modes show squad counters — enemy fleet defence teams and the ship counters that beat them. When the sheet holds no fleet counter data yet, the Fleet view shows a plain "no fleet counters yet" message in place of the dropdown and results, and fills in automatically once fleet counters are authored. Fleet is a browsing view on this screen; it is not a whole-board format (see [§6.7](#67-opponent-board)).

A wayfinding line on the Counters screen points the user to the Round screen for round tracking and reset — those responsibilities live there, not here (see [§6.6](#66-round-screen)).

### 6.2 Used Team Tracking

The user can mark a counter as used during a round. Used counters are keyed on their stable `Counter_ID` and persist across app launches. A round reset clears all used teams (and banner tracking and the opponent board — see [§6.6](#66-round-screen)).

Used status is surfaced as part of the unified tri-state counter status (see [§6.5](#65-counter-status)). Used cards are displayed at 0.5 opacity with a grey "Used" status word; the Mark Used button is suppressed on used cards. Used teams are counted in the Current Round summary card, which appears on both the Counters and Round screens. From v2.1, counters can also be marked used directly from the Round screen's per-team recommendations (see [§6.8](#68-allocation-engine)); the state is shared. This applies to fleet counters as well as squad counters.

### 6.3 Banner Tracking

The user tracks the current round's score: their own current score and the opponent's current score are entered by hand, while the **remaining available banners** figure is, as of v2.6, calculated from the opponent board. From these the app derives a **projected final (max)** — the player's current score plus their remaining banners — and a live **margin** showing whether they are currently leading, trailing, or level. The remaining figure also drives the points-to-win verdict (see [§6.9](#69-points-to-win)).

From v2.1, banner tracking lives on the Round screen alongside the opponent board (see [§6.6](#66-round-screen)), consolidating the live-match workspace into a single view.

**Calculated remaining (v2.6).** The remaining-banners figure is derived by walking every uncleared team on the opponent board and applying the GAC_Scoring rules — victory, the attempt bonus keyed to each team's Battles count (see [§6.7](#67-opponent-board)), per-unit survival/full-health/full-protection bonuses, defeated-enemy points, and per-territory clear bonuses — to produce the most that could still be banked with a clean finish (see [§6.9](#69-points-to-win) for the scoring engine detail). The field remains **overridable**: typing a value sets a manual override, shown with an amber marker and a "Use calculated" link to dismiss it. Any change to the board (clearing or un-clearing a team, adjusting a Battles count, setting a team) discards the override and restores the live calculated figure, so a stale hand-typed value can never silently persist. When no board exists the field reads zero and invites either board setup or a typed value. Reset Round and the empty-board state both leave the field on the calculated (no-override) state; earlier stored numeric `remaining` values migrate to no-override on load.

The projected final remains an optimistic ceiling, not a win/lose prediction: the opponent's remaining offence against the player's own defence is not yet modelled, so the opponent's score stays whatever the player has entered. Modelling that is the planned **My Board** feature (see [§8](#8-roadmap)); the scoring engine is written side-agnostically so it will slot in without rework. Banner state is stored locally and cleared by Reset Round.

### 6.4 Roster Management

A dedicated Roster view, reached from the bottom navigation bar, lists the player's units in two sections — **Characters** and **Ships** — with a running owned/total count for each ("X / Y characters · A / B ships owned"). Within the Ships section, capital ships carry a small **Capital** badge so they are distinguishable from regular ships at a glance, mirroring how the game presents them together. A single search box filters both sections at once; while searching, a section with no matches is hidden, and if nothing matches a single empty line is shown. If the loaded data contains no ship definitions at all (e.g. an older cached payload), the Ships section and its count are omitted and the screen reads exactly as it did before fleet support. The user taps to toggle ownership; ownership is stored locally and feeds directly into availability calculations. A clear-roster action resets all ownership.

There are three ways to populate the roster, in order of precedence as the recommended path:

1. **Import via ally code (primary).** The user enters their 9-digit ally code and the app loads ownership directly from their account via the roster proxy. When the roster is empty this is presented as a prominent first-run card; once an ally code is associated it becomes a "Refresh roster" control. Imported base_ids are mapped to internal `Character_ID`s through the `External_ID` adapter; the result replaces the current roster (with Undo). Import now brings in characters, ships, and capital ships together, and is reported as "Imported X characters and Y ships from the game," with a further count of units not yet present in the app's database (informational, expected after game updates). Foreground import validates the ally code, guards against being offline, applies a 60-second timeout (accommodating Render cold starts), and gives per-case error copy (including the common "not yet synced" case). A confirmation is shown before overwriting an existing different roster; a routine refresh of the same ally code is not gated.
2. **Manual toggle (existing).** Tap individual units on/off. Always available.
3. **Paste-JSON import (fallback).** The collapsible Manage roster data panel provides Export (copies the roster to the clipboard as JSON) and Import (validates pasted roster data, replaces the current roster, reports unrecognised units), plus Clear roster. This operates on internal `Character_ID`s, accepts characters and ships alike, and shares the same apply path and Undo as the API import.

The screen shows a **source-aware freshness line**: API-sourced rosters show "Last synced: …" (`syncedAt`), manual rosters show "Last saved: …" (`savedAt`). The import result message and Undo control appear in a top-level notice cluster so they remain visible even when the data panel is collapsed. Clear roster lives in the data panel rather than the header because a SWGOH roster rarely shrinks; clearing is a deliberate maintenance action, not part of normal use.

A staleness-gated background sync keeps API rosters current without user action — see [§3.4](#34-state--persistence) for its cache-first semantics.

### 6.5 Counter Status

Each counter carries a tri-state status derived from two independent axes:

**Ownership axis** (static, roster-derived) — whether the player owns all required units for a counter. A counter is **owned** when every `REQUIRED` unit is in the player's roster; `RECOMMENDED` units are not considered. This is computed by `getOwnership()`, and applies identically to fleet counters (whose required units are ships).

**Round axis** (dynamic, round-derived) — whether an owned counter has been used this round. This is tracked via `usedTeams` in `localStorage`.

The two axes combine into three card states, computed by `getCounterStatus()`:

| State | Condition | Status word | Opacity |
|---|---|---|---|
| Available | Owned and not yet used | Green "Available" | Full |
| Used | Owned and already used this round | Grey "Used" | 0.5 |
| Not owned | Missing one or more required units | Grey "Not owned" | 0.5 |

**Precedence:** Not owned dominates. Used state is only meaningful for owned counters — a counter missing required units is always Not owned regardless of used state.

**Missing units** — Not owned cards list their missing required units by display name beneath the notes line.

**Filter** — a three-segment control [All] [Owned] [Available] sits below the team selector and above the results list. It is visually subordinate to the mode toggle. The three segments form a nested hierarchy (All ⊇ Owned ⊇ Available), with each a strict subset of the one before. The selected filter persists in `localStorage` and defaults to All.

**Empty states** — each filter produces context-appropriate copy when no counters match:
- **All** — "No matching defence teams found." (no counters in data for this team)
- **Owned** — "You don't own any counters for this team."
- **Available** — "You've used all your counters for this team." (when at least one is owned but all are used); otherwise falls through to the Owned copy.
- **Owned / Available with no roster** — "Set up your roster to see which counters you can field."

**Sort order** — counters are sorted by status group first (Available → Used → Not owned), then by tier (S → A → B → C), then by banner score descending. This ensures fieldable counters surface at the top regardless of tier.

### 6.6 Round Screen

The Round screen is the live-match workspace, reached from the middle position of the bottom navigation bar (v2.1 replaced the earlier "Banners" nav item). It consolidates three related concerns in a single scrolling view:

1. A **round summary card** with the used-team count and the Reset Round action. Reset Round clears used teams, banner tracking, *and* the opponent board together, since a new round means a new opponent — the three pieces of state have the same lifecycle. It is confirmed before running.
2. The **opponent board** (see [§6.7](#67-opponent-board)) and the **allocation recommendations** it drives (see [§6.8](#68-allocation-engine)), or the board setup card when no board exists for the current round.
3. **Banner tracking** (see [§6.3](#63-banner-tracking)) beneath the board, and — from v2.6 — the **points-to-win** verdict it drives (see [§6.9](#69-points-to-win)).

This shape is deliberate. Every part of the Round screen is about the current opponent and the current round, and each part will eventually feed the next feature (the points-to-win calculator sits naturally at the intersection of board state and banner scores). Merging the three avoids the design tension of maintaining two screens both labelled "current round" and lets a future calculator draw directly from board and banner state without cross-screen coordination.

### 6.7 Opponent Board

The opponent board is a per-round record of the opponent's defence layout. It is populated by hand at the start of a round and updated as the round progresses.

**Setup.** When no board exists for the current round, the Round screen shows a setup card. The user picks a league (Kyber, Aurodium, Chromium, Bronzium, or Carbonite; remembered across rounds) and taps "Set up board". The squad format is normally taken from the Counters screen toggle at the moment of setup and frozen into the board — changing the toggle mid-round has no effect on the current board. Because "Fleet" is a browsing view rather than a whole-board format, when the toggle is on Fleet the setup card instead shows a small **5v5 / 3v3 chooser** (pre-selected to the last squad format used) so the board always freezes a valid squad format; on 5v5/3v3 the format is inherited silently as before. The setup card generates the correct number of team pickers per territory from GAC_Board_Config for that league and squad format.

**Territories.** Four territories per board (Front Top, Front Bottom, Back Top, Back Bottom), rendered top-to-bottom in a single scrollable view consistent with the app's existing pattern. Each territory shows its title, its cleared progress (`n/m cleared`), and a bulk **Clear territory** shortcut for players who want to move fast without per-team detail. The fleet territory (Back Top) is marked with a 🚀 icon and its pickers draw from the fleet counter catalogue rather than the squad catalogue.

**Lane unlocking.** The two lanes are independent. **Back Bottom** is locked until Front Bottom is cleared, and **Back Top** (the fleet territory) is locked until Front Top is cleared — the same reveal chain in both lanes, matching the game. (Prior to v2.5, Back Top was permanently locked pending fleet support.)

**Per-team state.** Each squad or fleet slot within a territory has:
- A **team picker** offering every defence team in the relevant counter catalogue (the board's squad format for squad territories, the fleet catalogue for the fleet territory), plus a **Not in catalogue** placeholder for opponent teams the app doesn't yet know about (the app still tracks their cleared state, but produces no recommendations for them).
- A **Cleared toggle** — the per-team source of truth. Territory-cleared state is derived from these flags plus the bulk setter; it is never persisted separately.
- A **Battles counter** (v2.6) — a −/+ stepper mirroring the in-game "Battles" number beside each defence team. It counts attempts made against the team, win or lose, climbing 0, 1, 2, 3… and stored verbatim so it always matches the game. The count decides the attempt bonus the team is still worth to the points-to-win calculation (zero battles → the next win scores as a first attempt, one → second attempt, two or more → no attempt bonus); the interpretation lives in the calculation, not in a display cap. The stepper is shown only while the team is uncleared, since a cleared team's battles no longer affect what is left to win.

**Persistence.** The board is versioned (schema 3), hydrated on boot before first paint, and defensively re-read on entry to the Round screen. It is cleared by Reset Round together with used teams and banner tracking (see [§3.4](#34-state--persistence)). A schema bump from 1 to 2 in v2.5 discarded any pre-fleet board on load; the v2.6 bump from 2 to 3, which adds the per-team Battles count, instead **migrates in place** — every existing team is backfilled to zero battles rather than the in-progress round being discarded.

**Fleet territory (v2.5).** GAC_Board_Config already encoded fleet counts per league, and the board data model already carried `Territory_Type`, so enabling fleet was a matter of populating fleet counter data and lifting the UI lock — no data-model rework was required. The fleet territory now generates its own team rows, unlocks behind Front Top, offers fleet pickers, and participates in the allocation engine (see [§6.8](#68-allocation-engine)).

### 6.8 Allocation Engine

The allocation engine surfaces per-team counter recommendations across the whole visible board, accounting for the fact that each counter can be used only once per round and that units used on offence are spent for the round regardless of the battle's outcome.

**When it engages.** The engine is always active while a board exists. When two or more visible-uncleared teams share at least one eligible-and-owned-and-unused counter, an explicit **overlap notice** appears at the top of the board ("Shared counters detected — recommendations below account for the overlap"), announcing that the recommendations are actively arbitrating between competing claims rather than treating each team in isolation.

**Eligibility.** For each visible-uncleared board team, the engine derives the set of counters that are:
- Present in the counter catalogue for that team (the board's squad format for squad territories, the FLEET catalogue for the fleet territory).
- **Owned** by the player (all required units present — reuses `getOwnership()`).
- **Not yet used** this round (checks `usedTeams`).

Not-in-catalogue placeholder teams contribute no candidates and receive an explanatory reason instead of a recommendation.

**Solver.** A scarcity-first ordered search with branch-and-bound pruning enumerates valid assignments over the eligible teams. The objective is lexicographic:

1. Maximise **coverage** — the number of teams that receive an assignment.
2. Then minimise summed **tier rank** — prefer stronger tiers (S over A over B over C).
3. Then maximise summed **banner score** — prefer higher expected banners as a final tiebreak.

Two exclusivity constraints are enforced natively:

- **Counter-level.** A counter can appear in at most one assignment in a plan.
- **Unit-level.** Two counters that share a required unit can never both appear in the same plan, since units used on offence are spent for the round. The plan explains clashes by name in the losing team's reason. Because ships and characters occupy disjoint unit sets, a fleet counter and a squad counter never collide; the fleet allocation is effectively independent of the squad allocation, while two fleet teams contesting the same owned ship are still arbitrated correctly.

The search order (teams by ascending candidate count, candidates by tier then banner score) means the first complete path is the greedy scarcity-first answer. A 50 000-node budget guards against pathological cases; because the greedy path is explored first, exhausting the budget can only produce a result equal to or better than pure greedy.

**Re-solve model.** The plan is computed live on every Round-screen render. Nothing about the plan is persisted. Marking a counter used, toggling a Cleared flag, editing a team, or changing the roster all trigger a re-solve for free via the app's existing render-on-state-change pattern — there is no separate "plan" object to keep in sync.

**Per-team display.** Each visible-uncleared team card is followed by a recommendation block containing:
- The chosen counter's name, colour-coded tier badge, and expected banner score.
- A one-line **reason** grounded in the plan's real alternatives — e.g. "Also counters Great Mothers — SLKR covers that one instead" — rather than a generic strength claim. When a team is the second choice for a counter that got diverted elsewhere, the reason names both the counter and the team it went to. When a team is left uncovered because of a unit clash, the reason names the unit and the counter holding it.
- A **Mark used** button that commits the counter to `usedTeams` immediately and triggers a re-solve. The state is shared with the Counters screen (see [§6.2](#62-used-team-tracking)).

Teams with no recommendation receive one of four distinct plain-English reasons: no counters in the catalogue yet, none owned, all owned counters already used, or the only eligible counter is committed to another team.

**Scope.** As of v2.5 the engine runs against every unlocked territory, squad and fleet alike. Each team draws candidates from its own catalogue, and the shared ownership, used-state, and exclusivity logic applies uniformly.

### 6.9 Points to Win

Introduced in v2.6, this feature answers "how many banners do I still need to win, and can I get there?" from the current match state. It sits beneath banner tracking on the Round screen and is built on two layers: a data-driven scoring engine and a plain-language verdict.

**Scoring engine.** All banner values are read from GAC_Scoring through a single `scoreRule` lookup, keyed by rule, battle type, and mode, with `ANY` as a wildcard and the most specific matching row winning. A **side-agnostic board walker** totals the most banners still bankable from a board: for every uncleared team in an unlocked territory it adds the clean-win best case, and for every territory still holding an uncleared team it adds the clear bonus (base plus per-team). Every uncleared slot counts, named or not — banner value depends only on battle type and mode, never on which team occupies the slot, so the total is honest even on a board where positions are marked but teams not yet identified. Locked back territories contribute nothing until their front clears, matching the board. Because the walker takes any board object, the same code will serve a future **My Board** (see [§8](#8-roadmap)) with no rework; today it is called only with the opponent board.

**Battle best case.** A clean win: every own unit survives at full health and protection, and every enemy is defeated. The attempt bonus is chosen from the team's Battles count (see [§6.7](#67-opponent-board)) — the next battle is treated as the first, second, or third-plus attempt accordingly. Unit counts come from a **two-count model**: how many of the player's own units earn per-unit survival bonuses, and how many enemy units are defeated. These are equal for squads (5/5, 3/3) but distinct in general — a full fleet fields and defeats eight units each side — and are sourced from the `OWN_UNITS` / `ENEMY_UNITS` scoring rows (see [§4.1](#41-sheet-structure)), with correct in-app fallbacks. Fleet reinforcement slots left empty at setup would earn unused-slot bonuses, but a full-clean-clear best case has none; the deliberate-undersize case belongs to the future efficiency calculator (see [§8](#8-roadmap)).

**Verdict.** Points-to-win is defined as (opponent's current score + 1) − own current score: the banners needed to pull ahead of where the opponent stands now. This is compared against the calculated best-case remaining to decide reachability. The readout resolves to one of three states, each a crisp headline plus an honest support line: **already ahead** ("Ahead by X"), **reachable** ("Points to win: X", with the clean-finish total shown as enough, plus any spare, or "just enough"), or **short** ("Points to win: X", with the clean finish falling a stated amount short). The headline is colour-coded — green when ahead, red when short. Every phrasing refers to the opponent's *current* score, and a one-time caveat notes that their score rises as they attack the player's defence, since only the player's own offence is modelled. The verdict recomputes live as scores are typed, without dropping input focus.

**Data caveat.** Points-to-win uses full-clean-clear best cases, consistent with the documented 69-banner single-battle maximum. The fleet per-ship and defeated-enemy values remain earmarked for a real-battle spot-check before the efficiency calculator is built on them; the points-to-win figure itself is unaffected, since it uses the full-clear best case.

---

## 7. Roster Model

Ownership is tracked at unit level only, as a binary "owned / not owned". Relics, gear, zetas, omicrons, mods, and GP are **not** modelled at this stage, even though the import source exposes them — only unit presence is consumed. As of v2.5, characters, ships, and capital ships are all imported and shown; capital ships are visually distinguished by a badge on the roster.

**Availability rule.** A counter is available when all of its required units are owned. Recommended units do not affect availability. This holds identically for fleet counters, whose required units are ships.

**Identity and mapping.** The internal key is `Character_ID`. Imported rosters arrive as SWGOH.gg `base_id`s and are translated to `Character_ID`s via the `External_ID` adapter column, through a base_id → Character_ID reverse index built on load. The index carries each unit's `unitType`, so import can classify characters, ships, and capital ships and count them separately. Unmapped units are reported as "not in the app's database yet" and not stored.

**Persistence.** Ownership is held in `localStorage` and keyed on `Character_ID` for all unit types. It persists across launches but is device- and browser-specific, with no cross-device sync. See [§3.4](#34-state--persistence).

---

## 8. Roadmap

Forward-looking status. Released version history is maintained separately in `changelog.md`, which is the single source of truth for what has shipped.

**v1.5 — Roster Foundations** · *Complete*
Counter_ID architecture, Character_Definitions, availability engine, availability indicators, missing-character display.

**v1.6 — Manual Roster** · *Complete*
Normalised Counter_Composition tab, Unit_Type support, roster screen with character search and ownership toggles, local persistence, bottom-bar navigation, automatic availability updates.

**v1.65 — Banner Tracking** · *Complete*
Manual tracking of own score, opponent score, and remaining banners, with a derived projected-final (max) and live margin. Self-contained, stored locally, and cleared by Reset Round.

**v1.7 — Available Counters Filter** · *Complete*
A "show available only" toggle to hide unavailable counters, with a stub reveal for hidden counters and a disabled state when no roster is set up.

**v1.8 — Used Team Awareness** · *Complete*
Unified tri-state counter status (Available / Used / Not owned) replacing the separate availability indicator and used-label. Three-segment filter [All] [Owned] [Available] with per-filter empty states, group-first sort order, and ownership vocabulary replacing the previous available/unavailable language.

**v1.9 — Roster Persistence & Portability** · *Complete*
Versioned storage schema, single save/load path, migration, last-saved indicator, clipboard export, validated import with replace semantics and undo, best-effort persistent storage, collapsible roster-data panel. Roster-loss root cause established as Safari Private Browsing ephemeral storage (correcting an earlier provisional iOS app-switcher attribution).

**v2.0 — Roster Import** · *Complete*
Ally-code roster import behind a thin Apps Script proxy (`action` router). `External_ID` adapter column and client-side base_id → Character_ID mapping. Schema v2 with `allyCode`/`syncedAt`. Cache-first architecture with staleness-gated, never-mid-edit background sync. Source-aware freshness line, first-run import card, three-bucket import reporting, full foreground error handling and Undo. Manual toggle and paste-JSON import retained as fallbacks. Character-only at the time; ship import followed in v2.5. (v2.0 subsequently switched roster source from swgoh.gg to SWGOH Comlink hosted on Render's free tier, after swgoh.gg began blocking Apps Script egress IPs; the response contract is unchanged.)

**v2.1 — Round Planning** · *Complete*
Bottom-nav "Banners" replaced by a single **Round screen** merging round summary, opponent board, allocation recommendations, and banner tracking. Two new sheet tabs (**GAC_Board_Config**, **GAC_Scoring**) exposed via extended `action=data` payload keys `boardConfig` and `scoring`. **Opponent board** with league setting, per-territory team pickers, per-team cleared flags, bulk clear-territory, derived territory-cleared state, lane unlocking (Back Bottom behind Front Bottom), and Back Top permanently locked pending v2.5. **Allocation engine** with scarcity-first ordered search, branch-and-bound pruning, coverage → tier → banners objective, native character-level exclusivity, live re-solve, and per-team plain-language reasoning. Reset Round widened to include the board. Service worker cache bump to force fresh assets for installed users, with the stylesheet added to precache. Roster-import copy pass completed source-neutrality.

**v2.5 — Fleet Support** · *Complete*
Roster stores and shows ships and capital ships (capital ships badged), with a Characters/Ships split and dual owned-count. Import widened from characters-only to include ship unit types across ally-code import, background sync, and paste import. Third **Fleet** toggle on the Counters screen with an honest empty state until fleet data is authored. Fleet counters authored via `Mode = FLEET` on the existing Counters tab; fleet availability reuses the unchanged ownership engine. On the Round board, **Back Top** (fleet) unlocks behind Front Top, offers fleet pickers, and joins the allocation engine — which now plans across squad and fleet territories together. Board schema bumped to 2 (pre-fleet boards refreshed on load); a `lastSquadMode` setting and setup-card format chooser handle the case where the board is created while browsing Fleet. No Apps Script change was required — the `FLEET` counters bucket falls out of the existing mode-keyed loop.

**v2.6 — Points-to-Win Calculator** · *Complete*
Board-aware, mode-aware "how many banners do I need to win" maths, on the GAC_Scoring data shipped in v2.1. A per-team **Battles** counter on the opponent board mirrors the in-game count and sets each team's attempt bonus. A data-driven scoring engine (single `scoreRule` lookup, side-agnostic board walker, two-count `OWN_UNITS`/`ENEMY_UNITS` model) totals best-case remaining banners; the "remaining available banners" field becomes calculated, with a board-cleared manual override. A plain-language **points-to-win** verdict (reachable / just-enough / short, colour-coded, honest about the opponent's current score) sits beneath banner tracking. Board schema 2 → 3 migrates in place. GAC_Scoring gains `OWN_UNITS`/`ENEMY_UNITS` rows (with in-app fallbacks); no Apps Script change. Full-clean-clear best cases only; fleet and defeated-enemy values earmarked for a real-battle spot-check. (This is the feature the roadmap previously tracked as "v2.2"; it shipped as v2.6 because Fleet Support took the v2.5 slot and the app version had moved on.)

**My Board — opponent's remaining offence** · *Planned, seam-ready*
Points-to-win currently models only the player's own remaining offence; the opponent's score is hand-entered and static. My Board adds a second board representing the player's own defence, so the same side-agnostic walker can project the opponent's best-case remaining banners against it and turn points-to-win into a full two-sided prediction. The v2.6 engine was built for this: the walker takes any board, the Battles/attempts count lives generically on a board team, and the banner model reserves room for an opponent-remaining figure — so this is additive, not a rework. Would also add a **Setting Defence** scoring row (banked at round start against the player's own defence).

**Efficiency calculator** · *Planned*
The final-battle "can I win with fewer than a full squad?" tool: trading per-unit surviving/full-health/full-protection bonuses against the higher per-slot unused-slot bonus when the units sent retain 100% health, including the deliberate-undersize fleet case (empty reinforcement slots). Depends on the `UNUSED_SLOTS_MAX` data and, critically, a real-battle spot-check of the scoring values — particularly fleet per-ship bonuses and the defeated-enemy count — before players lean on its numbers mid-match.

**Option B — Banners-first allocation scoring** · *Deferred alternative*
The v2.1 allocation engine uses coverage → tier → banner score as its lexicographic objective (Option A). A possible iteration is Option B: maximise total expected banners across the plan directly, letting coverage fall out naturally (an uncovered team contributes zero). This would produce subtler assignments — e.g. accepting a slightly weaker cover on one team to leave a stronger counter free for a harder one — at the cost of the current explicit "cover as many teams as possible" behaviour. Deferred until real-play feedback indicates whether the coverage-first heuristic produces visibly wasteful assignments; if it does, this is the intended iteration.

**Live GAC board import** · *Research spike*
Whether Comlink or any accessible read-only endpoint exposes live GAC board/match state, at no ongoing cost, so that the opponent board could be populated automatically rather than by hand. A short spike using the existing Comlink instance can establish feasibility without commitment. Only pursued if feasible under the zero-cost constraint.

**Phase 3 — Distribution & Scale** · *Future / conditional*
Considered only as usage grows from personal → closed group → potential public. Candidate change is migrating the roster proxy from Apps Script to a dedicated serverless function (e.g. Cloudflare Workers) with response caching. Explicit trigger criteria: Apps Script `UrlFetch` quota pressure, sustained import latency harming the mid-match experience, a need for multi-user response caching and per-source rate-limit handling, or wanting a custom domain. This is a proxy swap, not an architectural rewrite; the PWA and data model are unaffected. App-store presence, if ever pursued, would wrap the existing PWA rather than replace it.

---

## 9. Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Populate their roster in one step by importing from their account, including ships.
3. Set up the opponent's board at the start of a round in one pass.
4. See recommended counters for every visible opponent team at once — squad and fleet — with clear reasoning when the same counter is contested across teams.
5. Mark counters used as the round progresses and watch the recommendations re-solve automatically.
6. Track the round's banner score and projected final on the same screen.
7. Complete an entire GAC attack phase, character and fleet, without external notes, spreadsheets, or websites.

---

## 10. Future Vision

The long-term direction is a roster-aware GAC planning assistant. With v2.1 the app crossed from *catalogue lookup* into *board-aware allocation*; v2.5 brought fleet combat inside the same model, so the board and the allocation engine now cover a full GAC round; v2.6 added explicit points-to-win maths on top, modelling the player's own remaining offence. The next steps build directly on that engine: **My Board** extends the same side-agnostic walker to the opponent's remaining offence for a two-sided prediction, and an **efficiency calculator** adds the undersize-squad maths for the final battle. Beyond that, potential future capabilities include opponent-roster analysis, statistical counter recommendations, and (subject to feasibility) automated board setup from live match data.

Throughout, the app should continue to prioritise simplicity and speed. The goal is a personal SWGOH Grand Arena strategist — not a reimplementation of SWGOH.gg.
