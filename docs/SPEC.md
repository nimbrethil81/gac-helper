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
7. [Roster Model](#7-roster-model)
8. [Roadmap](#8-roadmap)
9. [Success Criteria](#9-success-criteria)
10. [Future Vision](#10-future-vision)

---

## 1. Overview

SWGOH GAC Helper is a lightweight companion app for use during live GAC rounds. It provides a fast counter-lookup experience focused on practical, in-the-moment decision-making, and is evolving incrementally from a simple lookup tool into a personal GAC planning assistant.

The app is designed to answer, within seconds: *which counters beat this enemy team, which are still available to me, and which have I already used?*

It deliberately models **strategic team identities** rather than exact squad compositions. The guiding question is always "can the player reasonably field this counter?" — not "what is the perfect mod-and-relic squad for this specific matchup?"

The app currently models **character counters only**. Fleet combat is a genuine GAC feature — one of the four territories is always a fleet battle — but is deliberately out of scope at this stage and is the subject of a dedicated roadmap milestone (v2.5, see [§8](#8-roadmap)). Where this document refers to "counters" without qualification, it means character counters.

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
  * `action=roster&allyCode=…` — a thin server-side proxy that calls the SWGOH.gg player endpoint and returns base_ids only. This exists solely to clear the browser CORS barrier; it performs no mapping or business logic of its own.

The roster proxy is deliberately "dumb": it returns the player's owned `base_id`s and a sync timestamp, and the client performs all mapping and classification. This keeps the payload small (important for the poor-wifi scenario), keeps the sheet as the single source of truth for the ID mapping, and avoids re-reading the sheet on every sync.

### 3.3 Data Flow

The counter-data flow is **read-only**: the app fetches data but never writes back to Sheets. This is a deliberate architectural choice — it keeps the app simple and avoids the authentication, write-API, concurrency, and security overhead that write-back would introduce. Roster import is also read-only with respect to the game and swgoh.gg: data flows inward only.

### 3.4 State & Persistence

All player-specific state is held client-side in `localStorage`:

* **Used teams** — keyed on `Counter_ID`, persisted across app launches.
* **Owned characters** — versioned roster object `{schema, savedAt, source, allyCode, syncedAt, owned[]}`, single save/load path, migration from the pre-v1.9 bare array and from the v1 schema. `Character_ID` is the persisted key. Provenance is tracked in `source` (`manual`, `import`, or `swgoh.gg`); `savedAt` records the last local write of any kind, while `syncedAt` records the last successful API return — these are distinct facts and both are meaningful for data freshness.
* **Banner tracking** — the current round's scores (own, opponent, remaining), persisted across app launches and cleared by Reset Round.
* **Opponent board** — versioned board object `{schema, league, mode, createdAt, territories[], teams[]}`, hydrated before first paint via the same defensive load pattern as the roster. The board is present only for the current round and is cleared by Reset Round together with used teams and banner tracking. Per-team `cleared` flags are the source of truth; territory-cleared state is always derived, never stored. The territory layout (which territories exist, their type, and how many teams each holds) is snapshotted into the board at setup, so an in-progress round renders identically even if the underlying configuration data changes later. Mode is frozen into the board at setup; changing the 5v5/3v3 toggle on the Counters screen mid-round has no effect on the current board.
* **League setting** — persisted user preference (`Kyber`, `Aurodium`, `Chromium`, `Bronzium`, or `Carbonite`), remembered across rounds and used to pre-fill the board setup card.

**Cache-first model.** localStorage is the working store; the SWGOH.gg API is a refresh mechanism, not a dependency. On boot the app renders from cached roster data instantly (`loadRoster()` runs before any network call), then — only for API-sourced rosters, and only if `syncedAt` is older than a staleness threshold (12 hours) — fires a silent background refresh. The refresh never runs while the Roster screen is open (so it cannot disrupt a mid-edit interaction), and applies only if the owned set actually changed, with an Undo snapshot when it does. If the refresh fails or times out, the app stays silently on cached data. The app is fully functional on cached data alone.

**Storage durability.** The app makes a best-effort `navigator.storage.persist()` request on boot to reduce OS eviction; this is effective on Chromium/Android and desktop. On Safari, Private Browsing uses ephemeral storage that is cleared at session end regardless of `persist()` — this is expected WebKit behaviour, not a bug, and was the reproducible cause of earlier roster-loss reports (an earlier provisional attribution to iOS app-switcher eviction was a misdiagnosis). Normal (non-private) browsing retains storage. The durable backstops against any loss are manual Export/Import and one-tap re-import from SWGOH.gg.

Because state is local to the device and browser, it does not sync across devices and is lost if site data is cleared or the PWA is reinstalled in a context without durable storage. With SWGOH.gg import in place, recovery is a single tap (re-enter or reuse the stored ally code) rather than a manual rebuild.

**Roster import timeout.** User-initiated import and refresh use a 60-second timeout. This is generous by design: the roster proxy is hosted on Render's free tier, which cold-starts on the first request after a period of inactivity, and a shorter timeout produced spurious failures on a first import of the day. Background refreshes inherit the same timeout but fail silently.

---

## 4. Data Model

### 4.1 Sheet Structure

The Google Sheet is the **schema source of truth**. Exact column names and ordering are defined in the sheet itself and are intentionally **not duplicated here**, to avoid drift between the spec and the live data. This section describes the *purpose and relationships* of each tab rather than its literal columns.

**Counters** — the core relationship table. Maps an enemy defence team (per mode) to one or more counter teams, each with a tier, expected banner score, undersize flag, and optional notes. This is the data that drives the lookup screen.

**Counter_Definitions** — the identity registry for counter teams. One row per counter, holding its stable `Counter_ID` and display name. Identity only; membership lives in Counter_Composition.

**Counter_Composition** — the membership table. One row per character in a counter team, recording the `Counter_ID`, the `Character_ID`, and whether that character is `REQUIRED` or `RECOMMENDED`. This normalised structure replaced the earlier approach of packing character lists into single cells, and allows data validation on the character column to prevent invalid IDs at entry time.

**Character_Definitions** — the master unit registry. One row per playable unit, holding its stable `Character_ID`, display name, `Unit_Type` (`CHARACTER`, `SHIP`, or `CAPITAL_SHIP`), and `External_ID`. This is the source for the roster screen, for validation, and for import matching.

> **`External_ID` is a translation adapter, not the primary key.** It holds the SWGOH.gg `base_id` for a unit, used only to translate imported rosters into internal `Character_ID`s. The internal key remains `Character_ID`; this keeps the data model independent of an external namespace that is controlled by Capital Games and can change. Only the units that appear as `REQUIRED` in Counter_Composition strictly need a mapping for availability to work; others can be populated opportunistically. base_ids must be taken from the SWGOH.gg character-list endpoint, not derived from display names — several are non-obvious (e.g. Jedi Master Luke, Sith Eternal Emperor) and a wrong value fails silently.

**GAC_Board_Config** — the per-league board layout. One row per (League, Mode, Territory) combination, holding the `Territory_Type` (`SQUAD` or `FLEET`) and the `Team_Count` — how many defence teams that territory holds in that league and format. This feeds the Round screen's board setup: choosing a league and mode pre-generates exactly the right number of team pickers per territory. Territory order within a league/mode is preserved from the sheet (Front Top, Front Bottom, Back Top, Back Bottom). The tab is guarded on the backend: if it is missing or empty the payload carries an empty object, so the sheet can be edited or rearranged without breaking the endpoint.

**GAC_Scoring** — the GAC banner economy. One row per rule, keyed by `Rule_ID` plus `Battle_Type` (`SQUAD`, `FLEET`, or `ANY`) plus `Mode` (`5v5`, `3v3`, or `ANY`). Values cover victory bonuses, first- and second-attempt bonuses, per-unit surviving/full-health/full-protection bonuses, unused-slot bonuses, defeated-enemy points, first-attack bonus, and territory-clear bonuses. This is the single source of truth for banner scoring and is the data prerequisite for the Points-to-Win Calculator (see [§8](#8-roadmap)). Values were initially sourced from the SWGOH Wiki and are expected to be spot-checked against real battle results before the calculator ships. Guarded like GAC_Board_Config.

**Roster** — reserved for future cloud-backed, account-specific roster data (relics, omicrons, notes). Not consumed by the app at this stage.

**GAC History** — reserved for future match-result tracking.

**Expected Banners** — a reference table mapping banner scores to their practical meaning.

> **Composition is mode-agnostic.** The required core of a counter is currently identical across 5v5 and 3v3, so composition does not carry a mode column. If a counter ever needs a genuinely different required core per mode, a `Mode` column (`5v5` / `3v3` / `BOTH`) can be added to Counter_Composition without disturbing the rest of the model. Fleet (v2.5) is expected to be modelled as an additional `Mode` value (`FLEET`) rather than a separate format axis, since the fleet territory is present in every GAC regardless of the character format.

### 4.2 Identifier Standards

Stable identifiers are central to the data model. Names can change; IDs must not.

**Counter_ID**
* Uppercase, underscores, no spaces.
* Stable once created.
* Examples: `LEIA`, `BANE`, `STARKILLER`, `GREAT_MOTHERS`, `BO_KATAN_MANDALORE`.

**Character_ID**
* Uppercase, underscores, no spaces.
* Based on official character names, and aligned with SWGOH's internal naming style where practical. This is the stable internal key for all ownership and composition data.
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

**Unit_Type** — enumerated: `CHARACTER`, `SHIP`, `CAPITAL_SHIP`. All-caps enum values keep them distinct from free text and make validation and filtering reliable. The roster screen and import currently consume `CHARACTER` only.

**Role** — enumerated: `REQUIRED`, `RECOMMENDED`. Only `REQUIRED` characters are considered for availability.

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

**counters** — keyed by mode, then by defence team name, to an array of counter entries. Each entry carries its counter ID, display name, tier, banner score, undersize flag, and notes.

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

`externalId` is read by header name and is optional: if the `External_ID` column is absent or a cell is blank, the field is returned empty and that unit simply won't match on import. This makes the column safe to add incrementally.

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

Both `boardConfig` and `scoring` were added in v2.1 and are fully backwards-compatible: the v2.0 frontend ignores unknown keys.

### `action=roster&allyCode=…`

A thin proxy to the SWGOH.gg player endpoint. Returns base_ids only; the client does all mapping.

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

The user selects a mode (5v5 / 3v3) and a defence team, and sees the available counters. Each counter card displays the counter team name, tier (colour-coded), expected banners, undersize viability, and notes. A search box filters the defence-team list, and counters are sorted by status group, then tier, then by banner score.

A wayfinding line on the Counters screen points the user to the Round screen for round tracking and reset — those responsibilities live there, not here (see [§6.6](#66-round-screen)).

### 6.2 Used Team Tracking

The user can mark a counter as used during a round. Used counters are keyed on their stable `Counter_ID` and persist across app launches. A round reset clears all used teams (and banner tracking and the opponent board — see [§6.6](#66-round-screen)).

Used status is surfaced as part of the unified tri-state counter status (see [§6.5](#65-counter-status)). Used cards are displayed at 0.5 opacity with a grey "Used" status word; the Mark Used button is suppressed on used cards. Used teams are counted in the Current Round summary card, which appears on both the Counters and Round screens. From v2.1, counters can also be marked used directly from the Round screen's per-team recommendations (see [§6.8](#68-allocation-engine)); the state is shared.

### 6.3 Banner Tracking

The user tracks the current round's score by hand: their own current score, the opponent's current score, and their remaining available banners. From these inputs the app derives a **projected final (max)** — the player's current score plus their remaining banners — and a live **margin** showing whether they are currently leading, trailing, or level.

From v2.1, banner tracking lives on the Round screen alongside the opponent board (see [§6.6](#66-round-screen)), consolidating the live-match workspace into a single view.

This feature is intentionally **manual and self-contained**. It does not attempt to derive banners from the counter data — a manual tracker stays accurate regardless of any future board-modelling work. The projected final is an optimistic ceiling, not a win/lose prediction, since the opponent's remaining banners are not tracked. A points-to-win calculator that consumes the actual GAC scoring rules is planned separately (see [§8](#8-roadmap)). Banner state is stored locally and cleared by Reset Round.

### 6.4 Roster Management

A dedicated Roster view, reached from the bottom navigation bar, lists every `CHARACTER`-type unit (ships and capital ships are excluded). The user searches and taps to toggle ownership, with a running owned/total count. Ownership is stored locally and feeds directly into availability calculations. A clear-roster action resets all ownership.

There are three ways to populate the roster, in order of precedence as the recommended path:

1. **Import from SWGOH.gg (primary).** The user enters their 9-digit ally code and the app loads ownership directly from their account via the roster proxy. When the roster is empty this is presented as a prominent first-run card; once an ally code is associated it becomes a "Refresh from SWGOH.gg" control. Imported base_ids are mapped to internal `Character_ID`s through the `External_ID` adapter; the result replaces the current roster (with Undo). Import is reported in three buckets — characters imported, ships recognised but not yet supported (silent), and units not yet present in the app's database (informational, expected after game updates). Foreground import validates the ally code, guards against being offline, applies a 60-second timeout (accommodating Render cold starts), and gives per-case error copy (including the common "not yet synced on SWGOH.gg" case). A confirmation is shown before overwriting an existing different roster; a routine refresh of the same ally code is not gated.
2. **Manual toggle (existing).** Tap individual characters on/off. Always available.
3. **Paste-JSON import (fallback).** The collapsible Manage roster data panel provides Export (copies the roster to the clipboard as JSON) and Import (validates pasted roster data, replaces the current roster, reports unrecognised characters), plus Clear roster. This operates on internal `Character_ID`s and shares the same apply path and Undo as the API import.

The screen shows a **source-aware freshness line**: API-sourced rosters show "Last synced: …" (`syncedAt`), manual rosters show "Last saved: …" (`savedAt`). The import result message and Undo control appear in a top-level notice cluster so they remain visible even when the data panel is collapsed. Clear roster lives in the data panel rather than the header because a SWGOH roster rarely shrinks; clearing is a deliberate maintenance action, not part of normal use.

A staleness-gated background sync keeps API rosters current without user action — see [§3.4](#34-state--persistence) for its cache-first semantics.

### 6.5 Counter Status

Each counter carries a tri-state status derived from two independent axes:

**Ownership axis** (static, roster-derived) — whether the player owns all required characters for a counter. A counter is **owned** when every `REQUIRED` character is in the player's roster; `RECOMMENDED` characters are not considered. This is computed by `getOwnership()`.

**Round axis** (dynamic, round-derived) — whether an owned counter has been used this round. This is tracked via `usedTeams` in `localStorage`.

The two axes combine into three card states, computed by `getCounterStatus()`:

| State | Condition | Status word | Opacity |
|---|---|---|---|
| Available | Owned and not yet used | Green "Available" | Full |
| Used | Owned and already used this round | Grey "Used" | 0.5 |
| Not owned | Missing one or more required characters | Grey "Not owned" | 0.5 |

**Precedence:** Not owned dominates. Used state is only meaningful for owned counters — a counter missing required characters is always Not owned regardless of used state.

**Missing characters** — Not owned cards list their missing required characters by display name beneath the notes line.

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
3. **Banner tracking** (see [§6.3](#63-banner-tracking)) beneath the board, unchanged in behaviour from the previous Banners screen.

This shape is deliberate. Every part of the Round screen is about the current opponent and the current round, and each part will eventually feed the next feature (the points-to-win calculator sits naturally at the intersection of board state and banner scores). Merging the three avoids the design tension of maintaining two screens both labelled "current round" and lets a future calculator draw directly from board and banner state without cross-screen coordination.

### 6.7 Opponent Board

The opponent board is a per-round record of the opponent's defence layout. It is populated by hand at the start of a round and updated as the round progresses.

**Setup.** When no board exists for the current round, the Round screen shows a setup card. The user picks a league (Kyber, Aurodium, Chromium, Bronzium, or Carbonite; remembered across rounds) and taps "Set up board". The mode is taken from the Counters screen toggle at the moment of setup and frozen into the board — changing the toggle mid-round has no effect on the current board. The setup card generates the correct number of team pickers per territory from GAC_Board_Config for that league and mode.

**Territories.** Four territories per board (Front Top, Front Bottom, Back Top, Back Bottom), rendered top-to-bottom in a single scrollable view consistent with the app's existing pattern. Each territory shows its title, its cleared progress (`n/m cleared`), and a bulk **Clear territory** shortcut for players who want to move fast without per-team detail.

**Lane unlocking.** The two lanes are independent. **Back Bottom** is locked until Front Bottom is cleared, matching the game's reveal chain. **Back Top** is permanently locked with a "fleet support arrives in v2.5" note, since ship modelling is deliberately out of scope until then (see [§8](#8-roadmap)).

**Per-team state.** Each squad slot within a territory has:
- A **team picker** offering every defence team in the counter catalogue for the current mode, plus a **Not in catalogue** placeholder for opponent teams the app doesn't yet know about (the app still tracks their cleared state, but produces no recommendations for them).
- A **Cleared toggle** — the per-team source of truth. Territory-cleared state is derived from these flags plus the bulk setter; it is never persisted separately.

**Persistence.** The board is versioned (schema 1), hydrated on boot before first paint, and defensively re-read on entry to the Round screen. It is cleared by Reset Round together with used teams and banner tracking (see [§3.4](#34-state--persistence)).

**Fleet territory design note.** GAC_Board_Config already encodes fleet counts per league, and the board data model already carries `Territory_Type`. Enabling fleet in v2.5 is a matter of populating fleet counter data and lifting the UI lock — no data-model rework is required.

### 6.8 Allocation Engine

The allocation engine surfaces per-team counter recommendations across the whole visible board, accounting for the fact that each counter can be used only once per round and that characters used on offence are spent for the round regardless of the battle's outcome.

**When it engages.** The engine is always active while a board exists. When two or more visible-uncleared teams share at least one eligible-and-owned-and-unused counter, an explicit **overlap notice** appears at the top of the board ("Shared counters detected — recommendations below account for the overlap"), announcing that the recommendations are actively arbitrating between competing claims rather than treating each team in isolation.

**Eligibility.** For each visible-uncleared board team, the engine derives the set of counters that are:
- Present in the counter catalogue for the current mode and defence team.
- **Owned** by the player (all required characters present — reuses `getOwnership()`).
- **Not yet used** this round (checks `usedTeams`).

Not-in-catalogue placeholder teams contribute no candidates and receive an explanatory reason instead of a recommendation.

**Solver.** A scarcity-first ordered search with branch-and-bound pruning enumerates valid assignments over the eligible teams. The objective is lexicographic:

1. Maximise **coverage** — the number of teams that receive an assignment.
2. Then minimise summed **tier rank** — prefer stronger tiers (S over A over B over C).
3. Then maximise summed **banner score** — prefer higher expected banners as a final tiebreak.

Two exclusivity constraints are enforced natively:

- **Counter-level.** A counter can appear in at most one assignment in a plan.
- **Character-level.** Two counters that share a required character can never both appear in the same plan, since characters used on offence are spent for the round. The plan explains character clashes by name in the losing team's reason.

The search order (teams by ascending candidate count, candidates by tier then banner score) means the first complete path is the greedy scarcity-first answer. A 50 000-node budget guards against pathological cases; because the greedy path is explored first, exhausting the budget can only produce a result equal to or better than pure greedy.

**Re-solve model.** The plan is computed live on every Round-screen render. Nothing about the plan is persisted. Marking a counter used, toggling a Cleared flag, editing a team, or changing the roster all trigger a re-solve for free via the app's existing render-on-state-change pattern — there is no separate "plan" object to keep in sync.

**Per-team display.** Each visible-uncleared team card is followed by a recommendation block containing:
- The chosen counter's name, colour-coded tier badge, and expected banner score.
- A one-line **reason** grounded in the plan's real alternatives — e.g. "Also counters Great Mothers — SLKR covers that one instead" — rather than a generic strength claim. When a team is the second choice for a counter that got diverted elsewhere, the reason names both the counter and the team it went to. When a team is left uncovered because of a character clash, the reason names the character and the counter holding it.
- A **Mark used** button that commits the counter to `usedTeams` immediately and triggers a re-solve. The state is shared with the Counters screen (see [§6.2](#62-used-team-tracking)).

Teams with no recommendation receive one of four distinct plain-English reasons: no counters in the catalogue yet, none owned, all owned counters already used, or the only eligible counter is committed to another team.

**Scope.** The engine currently runs against squad territories only. Fleet territory teams are excluded and the territory is locked (see [§6.7](#67-opponent-board)).

---

## 7. Roster Model

Ownership is tracked at character level only, as a binary "owned / not owned". Relics, gear, zetas, omicrons, mods, and GP are **not** modelled at this stage, even though the import source exposes them — only unit presence is consumed. Ships and capital ships are recognised by the registry but not yet imported or shown (fleet is v2.5).

**Availability rule.** A counter is available when all of its required characters are owned. Recommended characters do not affect availability.

**Identity and mapping.** The internal key is `Character_ID`. Imported rosters arrive as SWGOH.gg `base_id`s and are translated to `Character_ID`s via the `External_ID` adapter column, through a base_id → Character_ID reverse index built on load. Unmapped or non-character units are not stored as ownership.

**Persistence.** Ownership is held in `localStorage` and keyed on `Character_ID`. It persists across launches but is device- and browser-specific, with no cross-device sync. See [§3.4](#34-state--persistence).

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
SWGOH.gg roster import via ally code, behind a thin Apps Script proxy (`action` router). `External_ID` adapter column and client-side base_id → Character_ID mapping. Schema v2 with `allyCode`/`syncedAt`. Cache-first architecture with staleness-gated, never-mid-edit background sync. Source-aware freshness line, first-run import card, three-bucket import reporting, full foreground error handling and Undo. Manual toggle and paste-JSON import retained as fallbacks. Character-only by design. (v2.0 subsequently switched roster source from swgoh.gg to SWGOH Comlink hosted on Render's free tier, after swgoh.gg began blocking Apps Script egress IPs; the response contract is unchanged.)

**v2.1 — Round Planning** · *Complete*
Bottom-nav "Banners" replaced by a single **Round screen** merging round summary, opponent board, allocation recommendations, and banner tracking. Two new sheet tabs (**GAC_Board_Config**, **GAC_Scoring**) exposed via extended `action=data` payload keys `boardConfig` and `scoring`. **Opponent board** with league setting, per-territory team pickers, per-team cleared flags, bulk clear-territory, derived territory-cleared state, lane unlocking (Back Bottom behind Front Bottom), and Back Top permanently locked pending v2.5. **Allocation engine** with scarcity-first ordered search, branch-and-bound pruning, coverage → tier → banners objective, native character-level exclusivity, live re-solve, and per-team plain-language reasoning. Reset Round widened to include the board. Service worker cache bump to force fresh assets for installed users, with the stylesheet added to precache. Roster-import copy pass completed source-neutrality.

**v2.2 — Points-to-Win Calculator** · *Planned* · **Next**
Board-aware and mode-aware "how many banners do I need from remaining battles" calculator, using the shipped GAC_Scoring data as its rule source. Accounts for the territory-clear bonus, differing squad vs fleet scoring, and — on the final battle — the mathematical option to win with fewer than a full squad by trading per-unit surviving/full-health/full-protection bonuses against the higher per-slot unused-slot bonus, provided the units used retain 100% health. The scoring data was sourced from the SWGOH Wiki in v2.1 and is expected to be spot-checked against real battle results before this feature ships. Data prerequisite is met; feature is next in line.

**v2.5 — Fleet Support** · *Planned*
Roster stores ships and capital ships; fleet counter data authored in the existing Counter_Composition model (likely via a `FLEET` mode value); fleet toggle on the Counters screen; fleet availability reusing the unchanged ownership engine; Back Top territory unlocked on the Round board. Import pipeline widened from characters-only to include ship unit types (already parameterised for this in v2.0).

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
2. Populate their roster in one step by importing from SWGOH.gg.
3. Set up the opponent's board at the start of a round in one pass.
4. See recommended counters for every visible opponent team at once, with clear reasoning when the same counter is contested across teams.
5. Mark counters used as the round progresses and watch the recommendations re-solve automatically.
6. Track the round's banner score and projected final on the same screen.
7. Complete an entire GAC character attack phase without external notes, spreadsheets, or websites.

---

## 10. Future Vision

The long-term direction is a roster-aware GAC planning assistant. With v2.1 the app crosses from *catalogue lookup* into *board-aware allocation*; v2.2 will add explicit points-to-win maths on top; v2.5 completes the picture by bringing fleet combat inside the same model. Beyond that, potential future capabilities include opponent-roster analysis, statistical counter recommendations, and (subject to feasibility) automated board setup from live match data.

Throughout, the app should continue to prioritise simplicity and speed. The goal is a personal SWGOH Grand Arena strategist — not a reimplementation of SWGOH.gg.
