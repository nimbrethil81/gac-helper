The counter-data flow is **read-only**: the app fetches data but never writes back to Sheets. This is a deliberate architectural choice — it keeps the app simple and avoids the authentication, write-API, concurrency, and security overhead that write-back would introduce. Roster import is also read-only with respect to the game and swgoh.gg: data flows inward only.

### 3.4 State & Persistence

All player-specific state is held client-side in `localStorage`:

* **Used teams** — keyed on `Counter_ID`, persisted across app launches.
* **Owned characters** — versioned roster object `{schema, savedAt, source, allyCode, syncedAt, owned[]}`, single save/load path, migration from the pre-v1.9 bare array and from the v1 schema. `Character_ID` is the persisted key. Provenance is tracked in `source` (`manual`, `import`, or `swgoh.gg`); `savedAt` records the last local write of any kind, while `syncedAt` records the last successful API return — these are distinct facts and both are meaningful for data freshness.
* **Banner tracking** — the current round's scores (own, opponent, remaining), persisted across app launches and cleared by Reset Round.

**Cache-first model.** localStorage is the working store; the SWGOH.gg API is a refresh mechanism, not a dependency. On boot the app renders from cached roster data instantly (`loadRoster()` runs before any network call), then — only for API-sourced rosters, and only if `syncedAt` is older than a staleness threshold (12 hours) — fires a silent background refresh. The refresh never runs while the Roster screen is open (so it cannot disrupt a mid-edit interaction), and applies only if the owned set actually changed, with an Undo snapshot when it does. If the refresh fails or times out, the app stays silently on cached data. The app is fully functional on cached data alone.

**Storage durability.** The app makes a best-effort `navigator.storage.persist()` request on boot to reduce OS eviction; this is effective on Chromium/Android and desktop. On Safari, Private Browsing uses ephemeral storage that is cleared at session end regardless of `persist()` — this is expected WebKit behaviour, not a bug, and was the reproducible cause of earlier roster-loss reports (an earlier provisional attribution to iOS app-switcher eviction was a misdiagnosis). Normal (non-private) browsing retains storage. The durable backstops against any loss are manual Export/Import and one-tap re-import from SWGOH.gg.

Because state is local to the device and browser, it does not sync across devices and is lost if site data is cleared or the PWA is reinstalled in a context without durable storage. With SWGOH.gg import in place, recovery is a single tap (re-enter or reuse the stored ally code) rather than a manual rebuild.

---

## 4. Data Model

### 4.1 Sheet Structure

The Google Sheet is the **schema source of truth**. Exact column names and ordering are defined in the sheet itself and are intentionally **not duplicated here**, to avoid drift between the spec and the live data. This section describes the *purpose and relationships* of each tab rather than its literal columns.

**Counters** — the core relationship table. Maps an enemy defence team (per mode) to one or more counter teams, each with a tier, expected banner score, undersize flag, and optional notes. This is the data that drives the lookup screen.

**Counter_Definitions** — the identity registry for counter teams. One row per counter, holding its stable `Counter_ID` and display name. Identity only; membership lives in Counter_Composition.

**Counter_Composition** — the membership table. One row per character in a counter team, recording the `Counter_ID`, the `Character_ID`, and whether that character is `REQUIRED` or `RECOMMENDED`. This normalised structure replaced the earlier approach of packing character lists into single cells, and allows data validation on the character column to prevent invalid IDs at entry time.

**Character_Definitions** — the master unit registry. One row per playable unit, holding its stable `Character_ID`, display name, `Unit_Type` (`CHARACTER`, `SHIP`, or `CAPITAL_SHIP`), and `External_ID`. This is the source for the roster screen, for validation, and for import matching.

> **`External_ID` is a translation adapter, not the primary key.** It holds the SWGOH.gg `base_id` for a unit, used only to translate imported rosters into internal `Character_ID`s. The internal key remains `Character_ID`; this keeps the data model independent of an external namespace that is controlled by Capital Games and can change. Only the units that appear as `REQUIRED` in Counter_Composition strictly need a mapping for availability to work; others can be populated opportunistically. base_ids must be taken from the SWGOH.gg character-list endpoint, not derived from display names — several are non-obvious (e.g. Jedi Master Luke, Sith Eternal Emperor) and a wrong value fails silently.

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

**Unit_Type** — enumerated: `CHARACTER`, `SHIP`, `CAPITAL_SHIP`. All-caps enum values keep them distinct from free text and make validation and filtering reliable. The roster screen and import currently consume `CHARACTER` only.

**Role** — enumerated: `REQUIRED`, `RECOMMENDED`. Only `REQUIRED` characters are considered for availability.

---

## 5. API Contract

The Apps Script exposes two actions behind a single `doGet` endpoint.

### `action=data` (default)

Returns a single JSON object with three top-level keys. This contract is the boundary between backend and frontend; the frontend depends on this shape rather than on sheet layout.

```json
{
  "counters": { "5v5": {}, "3v3": {} },
  "counterDefinitions": {},
  "characterDefinitions": {}
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

### 6.2 Used Team Tracking

The user can mark a counter as used during a round. Used counters are keyed on their stable `Counter_ID` and persist across app launches. A round reset clears all used teams (and banner tracking — see [§6.3](#63-banner-tracking)).

Used status is surfaced as part of the unified tri-state counter status (see [§6.5](#65-counter-status)). Used cards are displayed at 0.5 opacity with a grey "Used" status word; the Mark Used button is suppressed on used cards. Used teams are counted in the Current Round summary card.

### 6.3 Banner Tracking

A dedicated Banners view, reached from the bottom navigation bar, lets the user track the current round's score by hand: their own current score, the opponent's current score, and their remaining available banners. From these inputs the app derives a **projected final (max)** — the player's current score plus their remaining banners — and a live **margin** showing whether they are currently leading, trailing, or level.

This feature is intentionally **manual and self-contained**. It does not attempt to derive banners from the counter data, because the app models counters as a lookup tool across all possible defence teams rather than modelling a specific GAC board (its territories, team counts, and defence results). A manual tracker therefore stays accurate regardless of any future board-modelling work. The projected final is an optimistic ceiling, not a win/lose prediction, since the opponent's remaining banners are not tracked. Banner state is stored locally and cleared by Reset Round.

### 6.4 Roster Management

A dedicated Roster view, reached from the bottom navigation bar, lists every `CHARACTER`-type unit (ships and capital ships are excluded). The user searches and taps to toggle ownership, with a running owned/total count. Ownership is stored locally and feeds directly into availability calculations. A clear-roster action resets all ownership.

There are three ways to populate the roster, in order of precedence as the recommended path:

1. **Import from SWGOH.gg (primary).** The user enters their 9-digit ally code and the app loads ownership directly from their account via the roster proxy. When the roster is empty this is presented as a prominent first-run card; once an ally code is associated it becomes a "Refresh from SWGOH.gg" control. Imported base_ids are mapped to internal `Character_ID`s through the `External_ID` adapter; the result replaces the current roster (with Undo). Import is reported in three buckets — characters imported, ships recognised but not yet supported (silent), and units not yet present in the app's database (informational, expected after game updates). Foreground import validates the ally code, guards against being offline, applies a 15-second timeout, and gives per-case error copy (including the common "not yet synced on SWGOH.gg" case). A confirmation is shown before overwriting an existing different roster; a routine refresh of the same ally code is not gated.
2. **Manual toggle (existing).** Tap individual characters on/off. Always available.
3. **Paste-JSON import (fallback).** The collapsible Manage roster data panel provides Export (copies the roster to the clipboard as JSON) and Import (validates pasted roster data, replaces the current roster, reports unrecognised characters), plus Clear roster. This operates on internal `Character_ID`s and shares the same apply path and Undo as the API import.

The screen shows a **source-aware freshness line**: API-sourced rosters show "Last synced from SWGOH.gg: …" (`syncedAt`), manual rosters show "Last saved: …" (`savedAt`). The import result message and Undo control appear in a top-level notice cluster so they remain visible even when the data panel is collapsed. Clear roster lives in the data panel rather than the header because a SWGOH roster rarely shrinks; clearing is a deliberate maintenance action, not part of normal use.

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
SWGOH.gg roster import via ally code, behind a thin Apps Script proxy (`action` router). `External_ID` adapter column and client-side base_id → Character_ID mapping. Schema v2 with `allyCode`/`syncedAt`. Cache-first architecture with staleness-gated, never-mid-edit background sync. Source-aware freshness line, first-run import card, three-bucket import reporting, full foreground error handling and Undo. Manual toggle and paste-JSON import retained as fallbacks. Character-only by design.

**v2.5 — Fleet Support** · *Planned*
Roster stores ships and capital ships; fleet counter data authored in the existing Counter_Composition model (likely via a `FLEET` mode value); fleet toggle on the Counters screen; fleet availability reusing the unchanged ownership engine. Import pipeline widened from characters-only to include ship unit types (already parameterised for this in v2.0).

**Phase 3 — Distribution & Scale** · *Future / conditional*
Considered only as usage grows from personal → closed group → potential public. Candidate change is migrating the roster proxy from Apps Script to a dedicated serverless function (e.g. Cloudflare Workers) with response caching. Explicit trigger criteria: Apps Script `UrlFetch` quota pressure, sustained import latency harming the mid-match experience, a need for multi-user response caching and per-source rate-limit handling, or wanting a custom domain. This is a proxy swap, not an architectural rewrite; the PWA and data model are unaffected. App-store presence, if ever pursued, would wrap the existing PWA rather than replace it.

---

## 9. Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Populate their roster in one step by importing from SWGOH.gg.
3. Select an enemy defence team.
4. Instantly view recommended counters.
5. See which counters they can field and which they have already used.
6. Track the round's banner score and projected final.
7. Complete an entire GAC character attack phase without external notes, spreadsheets, or websites.

---

## 10. Future Vision

The long-term direction is a roster-aware GAC planning assistant. Potential future capabilities include fleet counter support, team-allocation planning, counter-conflict detection, banner optimisation, defence-strategy support, round planning, opponent-roster analysis, and statistical counter recommendations.

Throughout, the app should continue to prioritise simplicity and speed. The goal is a personal SWGOH Grand Arena strategist — not a reimplementation of SWGOH.gg.
