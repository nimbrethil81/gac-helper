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
   - 6.5 [Counter Availability](#65-counter-availability)
7. [Roster Model](#7-roster-model)
8. [Roadmap](#8-roadmap)
9. [Success Criteria](#9-success-criteria)
10. [Future Vision](#10-future-vision)

---

## 1. Overview

SWGOH GAC Helper is a lightweight companion app for use during live GAC rounds. It provides a fast counter-lookup experience focused on practical, in-the-moment decision-making, and is evolving incrementally from a simple lookup tool into a personal GAC planning assistant.

The app is designed to answer, within seconds: *which counters beat this enemy team, which are still available to me, and which have I already used?*

It deliberately models **strategic team identities** rather than exact squad compositions. The guiding question is always "can the player reasonably field this counter?" — not "what is the perfect mod-and-relic squad for this specific matchup?"

The long-term direction is a roster-aware GAC strategist that can recommend attack order, allocate counters efficiently, optimise banners, and avoid conflicts — while always prioritising simplicity and speed over replicating the full depth of sites like SWGOH.gg.

### 1.1 Design Philosophy

* **Fast** — find a counter within seconds, mid-match.
* **Mobile-first** — built for phones and Home Screen PWA installation.
* **Maintainable** — counter data is editable in Google Sheets without touching application code.
* **Incremental** — features ship in stages; the app stays functional throughout.
* **Identity over composition** — counters represent team identities, not squad variations.

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

---

## 3. Architecture

The app is a static frontend served from GitHub Pages, backed by a read-only JSON API built on Google Apps Script over Google Sheets. There is no server-side application code beyond the Apps Script endpoint, and no database other than the spreadsheet.

### 3.1 Frontend

Hosted on GitHub Pages.

* **index.html** — app shell; loads styles and scripts; registers the service worker.
* **styles.css** — theme, layout, responsive design, component styling.
* **app.js** — data loading, state management, rendering, counter lookup, used-team tracking, banner tracking, roster management, and availability calculation.
* **service-worker.js** — PWA offline shell.
* **manifest.json** — PWA metadata.

### 3.2 Backend

* **Google Sheets** — primary data store and single source of truth for all game data.
* **Google Apps Script** — a `doGet` web app that reads the sheets and returns a single consolidated JSON payload consumed by the frontend.

### 3.3 Data Flow

```
Google Sheets
      ↓
Google Apps Script  (doGet → JSON)
      ↓
app.js  (fetch on load)
      ↓
Rendered views (Counters / Banners / Roster)
```

The flow is **read-only**: the app fetches data but never writes back to Sheets. This is a deliberate architectural choice — it keeps the app simple and avoids the authentication, write-API, concurrency, and security overhead that write-back would introduce.

### 3.4 State & Persistence

All player-specific state is held client-side in `localStorage`:

* **Used teams** — keyed on `Counter_ID`, persisted across app launches.
* **Owned characters** - versioned roster object {schema, savedAt, source, owned[]},
  single save/load path, one-time migration from pre-v1.9 bare array.
  Storage is localStorage; the app requests persistent storage on boot
  (navigator.storage.persist()) as best-effort eviction resistance.
  iOS WebKit confirmed to purge localStorage on swipe-away from the app switcher
  regardless; manual Export and v2.0 remote import are the durable backstops.
* **Banner tracking** — the current round's scores (own, opponent, remaining), persisted across app launches and cleared by Reset Round.

Because state is local to the device and browser, it does not sync across devices and is lost if site data is cleared or the PWA is reinstalled. This is acceptable at the current stage; cloud-backed persistence is addressed by the Roster Import work in [§8](#8-roadmap).

Because localStorage in an installed PWA can be evicted by the operating system, the app makes a best-effort request for persistent storage and provides manual Export/Import as a durable backup. Eviction resistance is improved but not guaranteed on all platforms; durable, cross-device persistence is the goal of the Roster Import work in §8.

---

## 4. Data Model

### 4.1 Sheet Structure

The Google Sheet is the **schema source of truth**. Exact column names and ordering are defined in the sheet itself and are intentionally **not duplicated here**, to avoid drift between the spec and the live data. This section describes the *purpose and relationships* of each tab rather than its literal columns.

**Counters** — the core relationship table. Maps an enemy defence team (per mode) to one or more counter teams, each with a tier, expected banner score, undersize flag, and optional notes. This is the data that drives the lookup screen.

**Counter_Definitions** — the identity registry for counter teams. One row per counter, holding its stable `Counter_ID` and display name. Identity only; membership lives in Counter_Composition.

**Counter_Composition** — the membership table. One row per character in a counter team, recording the `Counter_ID`, the `Character_ID`, and whether that character is `REQUIRED` or `RECOMMENDED`. This normalised structure replaced the earlier approach of packing character lists into single cells, and allows data validation on the character column to prevent invalid IDs at entry time.

**Character_Definitions** — the master unit registry. One row per playable unit, holding its stable `Character_ID`, display name, and `Unit_Type` (`CHARACTER`, `SHIP`, or `CAPITAL_SHIP`). This is the source for the roster screen, for validation, and for future import matching.

**Roster** — reserved for future cloud-backed, account-specific roster data (relics, omicrons, notes). Not consumed by the app at this stage.

**GAC History** — reserved for future match-result tracking.

**Expected Banners** — a reference table mapping banner scores to their practical meaning.

> **Composition is mode-agnostic.** The required core of a counter is currently identical across 5v5 and 3v3, so composition does not carry a mode column. If a counter ever needs a genuinely different required core per mode, a `Mode` column (`5v5` / `3v3` / `BOTH`) can be added to Counter_Composition without disturbing the rest of the model.

### 4.2 Identifier Standards

Stable identifiers are central to the data model. Names can change; IDs must not.

**Counter_ID**
* Uppercase, underscores, no spaces.
* Stable once created.
* Examples: `LEIA`, `BANE`, `STARKILLER`, `GREAT_MOTHERS`, `BO_KATAN_MANDALORE`.

**Character_ID**
* Uppercase, underscores, no spaces.
* Based on official character names, and aligned with SWGOH's internal naming style where practical (eases future imports from external sources).
* Stable once created.
* Examples: `LEIA_ORGANA`, `CAPTAIN_DROGAN`, `DARTH_BANE`, `EMPEROR_PALPATINE`.

**Unit_Type** — enumerated: `CHARACTER`, `SHIP`, `CAPITAL_SHIP`. All-caps enum values keep them distinct from free text and make validation and filtering reliable.

**Role** — enumerated: `REQUIRED`, `RECOMMENDED`. Only `REQUIRED` characters are considered for availability.

---

## 5. API Contract

The Apps Script returns a single JSON object with three top-level keys. This contract is the boundary between backend and frontend; the frontend depends on this shape rather than on sheet layout.

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
  "LEIA_ORGANA": { "name": "Leia Organa", "unitType": "CHARACTER" }
}
```

---

## 6. Current Features

### 6.1 Counter Lookup

The user selects a mode (5v5 / 3v3) and a defence team, and sees the available counters. Each counter card displays the counter team name, tier (colour-coded), expected banners, undersize viability, and notes. A search box filters the defence-team list, and counters are sorted by tier and then by banner score.

### 6.2 Used Team Tracking

The user can mark a counter as used during a round. Used counters are keyed on their stable `Counter_ID` and persist across app launches. A round reset clears all used teams (and banner tracking — see [§6.3](#63-banner-tracking)).

Used status is surfaced as part of the unified tri-state counter status (see [§6.5](#65-counter-status)). Used cards are displayed at 0.5 opacity with a grey "Used" status word; the Mark Used button is suppressed on used cards. Used teams are counted in the Current Round summary card.

### 6.3 Banner Tracking

A dedicated Banners view, reached from the bottom navigation bar, lets the user track the current round's score by hand: their own current score, the opponent's current score, and their remaining available banners. From these inputs the app derives a **projected final (max)** — the player's current score plus their remaining banners — and a live **margin** showing whether they are currently leading, trailing, or level.

This feature is intentionally **manual and self-contained**. It does not attempt to derive banners from the counter data, because the app models counters as a lookup tool across all possible defence teams rather than modelling a specific GAC board (its territories, team counts, and defence results). A manual tracker therefore stays accurate regardless of any future board-modelling work. The projected final is an optimistic ceiling, not a win/lose prediction, since the opponent's remaining banners are not tracked. Banner state is stored locally and cleared by Reset Round.

### 6.4 Roster Management

A dedicated Roster view, reached from the bottom navigation bar, lists every `CHARACTER`-type unit (ships and capital ships are excluded). The user searches and taps to toggle ownership, with a running owned/total count. Ownership is stored locally and feeds directly into availability calculations. A clear-roster action resets all ownership.

Roster ownership is stored under a versioned local schema with a single save/load path, and the screen shows when the roster was last saved and from which source. A collapsible Manage roster data panel provides Export (copies the roster to the clipboard as JSON), Import (validates pasted roster data, replaces the current roster, and reports any unrecognised characters that were skipped), Undo import (restores the previous roster within the session), and Clear roster. Import and Export share the same internal format and the same apply path that the planned roster import in §8 will reuse. Clear roster lives in this panel rather than the header because a SWGOH roster rarely shrinks; clearing is a deliberate maintenance action, not part of normal use.

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

Ownership is tracked at character level only. Relics, gear, zetas, omicrons, mods, and GP are **not** modelled at this stage.

**Availability rule.** A counter is available when all of its required characters are owned. Recommended characters do not affect availability.

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

Versioned storage schema, single save/load path, migration, last-saved indicator, clipboard export, validated import with replace semantics and undo, best-effort persistent storage, collapsible roster-data panel. Root cause of roster loss confirmed as iOS WebKit eviction on swipe-away; v2.0 remote import resolves this.

**v2.0 — Roster Import** · *Planned*
Import roster data from external sources (e.g. SWGOH.gg, HotUtils, or other public roster APIs). Manual roster entry remains available as a fallback, and local storage becomes a cache rather than the source of truth.

---

## 9. Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Select an enemy defence team.
3. Instantly view recommended counters.
4. See which counters they can field and which they have already used.
5. Track the round's banner score and projected final.
6. Complete an entire GAC attack phase without external notes, spreadsheets, or websites.

---

## 10. Future Vision

The long-term direction is a roster-aware GAC planning assistant. Potential future capabilities include automatic roster imports, team-allocation planning, counter-conflict detection, banner optimisation, defence-strategy support, round planning, opponent-roster analysis, and statistical counter recommendations.

Throughout, the app should continue to prioritise simplicity and speed. The goal is a personal SWGOH Grand Arena strategist — not a reimplementation of SWGOH.gg.
