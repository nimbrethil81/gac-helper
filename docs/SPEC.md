# SWGOH GAC Helper — Project Specification

A mobile-first Progressive Web App that helps players make faster, better Grand Arena Championship (GAC) decisions in *Star Wars: Galaxy of Heroes*.

**Scope.** This specification is the authoritative description of the system as it currently exists: its architecture, data model, API contract, current behaviour, and design decisions that remain true. It must not contain release history or planned, candidate, deferred, research, or other future product work. Release history is retrievable from Git history and GitHub work records; future work belongs in [`ROADMAP.md`](../ROADMAP.md); scoring constants live in `catalogue/source/scoring.json`, and scoring-data authoring guidance belongs in [`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#scoring-data-authoring). High-level product principles and success criteria may remain here where they constrain the current design.

**Update this document when** shipped code or data-model changes alter the current architecture, API contract, persistence model, data relationships, user-visible behaviour, or design decisions. Describe the resulting current state, not the history of how it changed.

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
   - 4.1 [Catalogue Structure](#41-catalogue-structure)
   - 4.2 [Identifier Standards](#42-identifier-standards)
5. [API Contract](#5-api-contract)
6. [Current Features](#6-current-features)
   - 6.1 [Counter Lookup](#61-counter-lookup)
   - 6.2 [Used Team Tracking](#62-used-team-tracking)
   - 6.3 [Banner Tracking](#63-banner-tracking)
   - 6.4 [Roster Management](#64-roster-management)
   - 6.5 [Counter Status](#65-counter-status)
   - 6.6 [Round Screen](#66-round-screen)
   - 6.7 [Round Boards](#67-round-boards)
   - 6.8 [Allocation Engine](#68-allocation-engine)
   - 6.9 [Points to Win](#69-points-to-win)
   - 6.10 [Can I Still Win?](#610-can-i-still-win)
   - 6.11 [Battle Order](#611-battle-order)
   - 6.12 [First Attack](#612-first-attack)
   - 6.13 [Last Battle Advisor](#613-last-battle-advisor)
7. [Roster Model](#7-roster-model)
8. [Success Criteria](#8-success-criteria)
9. [Product Direction](#9-product-direction)

---

## 1. Overview

SWGOH GAC Helper is a lightweight companion app for use during live GAC rounds. It provides a fast counter-lookup experience and personal GAC planning support focused on practical, in-the-moment decision-making.

The app is designed to answer, within seconds: *which counters beat this enemy team, which are still available to me, and which have I already used?*

It deliberately models **strategic team identities** rather than exact squad compositions. The guiding question is always "can the player reasonably field this counter?" — not "what is the perfect mod-and-relic squad for this specific matchup?"

The app models both **character counters and fleet counters**. Fleet combat is a genuine GAC feature — one of the four territories in every round is a fleet battle — and ships and capital ships are imported and shown on the roster, fleet counters are looked up alongside squad counters, and the fleet territory participates in the Round boards and the allocation engine (see [§6.7](#67-round-boards) and [§6.8](#68-allocation-engine)). Where this document refers to "counters" without qualification, it means character counters unless the surrounding context is fleet.

The app is a roster-aware GAC strategist that can recommend attack order, allocate counters efficiently, optimise banners, and avoid conflicts — while always prioritising simplicity and speed over replicating the full depth of sites like SWGOH.gg. It answers the four core questions of a live round in one place: *which counter*, *for which team*, *worth how many banners*, and *in what order* (see [§6.11](#611-battle-order)).

### 1.1 Design Philosophy

* **Fast** — find a counter within seconds, mid-match.
* **Mobile-first** — built for phones and Home Screen PWA installation.
* **Maintainable** — counter data is version-controlled catalogue source, edited and reviewed without touching application code.
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

**Maintainable.** All authored catalogue data lives in version-controlled JSON source in the repository. Adding counters, adjusting tiers or editing notes changes only that source. The change is validated in CI, merged after review and published by the manual Pages deployment, with no application code change.

**Incremental.** Each version delivers a self-contained, working improvement. The app is never left in a broken intermediate state between releases.

**Cache-first, network-second.** The app must be fully usable mid-GAC on poor venue wifi. It always renders from local state first and treats remote calls (catalogue refresh and roster import) as background refreshes that can fail silently without blocking the user.

---

## 3. Architecture

The app is a static frontend served from GitHub Pages. Its authored game and configuration data is a version-controlled catalogue in the repository. That catalogue is compiled into a validated, checksummed static release served from the same Pages site. Roster import takes a separate read-only path: a Google Apps Script web app proxies requests to a self-hosted SWGOH Comlink service, which talks directly to the game's read-only APIs. There is no application database, and player-specific state is stored client-side.

### 3.1 Frontend

Hosted on GitHub Pages. The manual `Deploy Pages Live` workflow publishes the app shell and the static catalogue release under `catalogue/` together, in one allow-listed artifact ([`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#static-release-on-pages)).

* **index.html** — app shell; loads styles and scripts; registers the service worker.
* **styles.css** — theme, layout, responsive design, component styling.
* **app.js** — catalogue loading, verification and caching, state management, rendering, counter lookup, used-team tracking, two-sided banner tracking, roster management/import, paired round-board and defence-template persistence, availability calculation, the allocation engine, the battle-order pass that schedules its output, and the Last Battle advisor.
* **service-worker.js** — PWA offline shell. It never handles cross-origin requests or requests under `catalogue/`, so `app.js` owns the only catalogue cache.
* **manifest.json** — PWA metadata.

### 3.2 Backend

There is no server-side catalogue service.

* **Catalogue source** — the source of truth for authored app data. It holds counters and their definitions, the `External_ID` game-base-ID mapping, per-league board configuration, GAC banner scoring rules and defence-team attributes. It is version-controlled JSON under `catalogue/source/` (see [§4.1](#41-catalogue-structure)). A dependency-free Node compiler validates the source and generates the catalogue payload ([§5](#5-api-contract)), and CI runs the release gate on every pull request. Only a manual `Deploy Pages Live` run publishes a catalogue. [`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md) owns the authoring, correction, release and rollback procedure. [`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md) owns the source schema and the release contracts.
* **Google Apps Script** — a `doGet` web app. The app calls only `action=roster&allyCode=…`. That action posts the ally code server-side to the Comlink roster provider, normalises the response and returns deduplicated unit base IDs. Keeping the call server-side hides the Comlink endpoint and avoids browser CORS constraints. Apps Script does no `Character_ID` mapping or roster classification. The same deployment still serves the legacy `action=data` catalogue from a frozen Google Sheet. The app does not read it; both are kept unedited only as the route for rolling back the catalogue cutover ([`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#cutover)).
* **SWGOH Comlink** — a self-hosted service on Render that talks directly to the game's read-only APIs. Its `/player` response supplies `rosterUnit[].definitionId`; the Apps Script takes the base-ID portion before the rarity suffix and returns that compact list to the client.

Apps Script validates the request and provider response and returns only the owned base IDs and a sync timestamp; all mapping and classification is client-side, so the catalogue stays the source of truth for ID mapping.

### 3.3 Data Flow

The counter-data flow is **read-only**: the app fetches the static catalogue and never writes back to it.

Roster import is also read-only. The request path is **PWA → Apps Script → Comlink → game API**; the response returns through Apps Script as a compact list of owned unit base IDs plus a sync timestamp. No roster data is written back to the game or stored anywhere but the device.

### 3.4 State & Persistence

All player-specific state is held client-side in `localStorage`:

* **Used teams** — keyed on `Counter_ID`, persisted across app launches.
* **Owned units** — versioned roster object `{schema, savedAt, source, allyCode, syncedAt, owned[]}`, with a single save/load path and compatibility handling for legacy roster formats. `Character_ID` is the persisted key (ships and capital ships are stored under the same key space as characters, since all units share the `Character_ID` namespace). Provenance is tracked in `source` (`manual`, `import`, or the API sentinel); `savedAt` records the last local write of any kind, while `syncedAt` records the last successful API return — these are distinct facts and both are meaningful for data freshness.
* **Banner tracking** — the current round's editable own and opponent scores, the player's optional remaining-banner override, and the opponent-final marker. New-round setup prefills both scores once from the configured `SETTING_DEFENCE` rule; later board loads and migrations never recalculate or overwrite live totals. Banner state persists across launches and is cleared by Reset Round.
* **Round boards** — schema **5** uses two paired versioned board objects with the same frozen `{league, mode, createdAt, roundId, territories[], teams[]}` layout. `boardData` remains the opponent-board key for compatibility; `myBoardData` holds the player's defence. The opponent-board object also owns the round's immutable `defenceSnapshot`, containing the selected format and canonical unit IDs committed to defence when the round began. Team rows add optional `customName` alongside identity, `attempts`, and `cleared`. Both live boards are cleared by Reset Round. Schema-2/3/4 boards migrate additively; a schema-4 round freezes its paired My Board once after catalogue data loads. Existing banner scores remain unchanged. Older unsupported formats are ignored. `mode` is always a squad format (`5v5` or `3v3`); Fleet remains a territory/catalogue mode rather than a whole-board format (see [§6.7](#67-round-boards)).
* **Defence templates** — one identity-only template per squad format, stored separately under `defenceTemplate:5v5` and `defenceTemplate:3v3`. Each snapshots every territory, including its fleet slots. Template team rows contain only territory/index, catalogue identity and optional custom name; Battles and Cleared state are never copied. Identity edits on My Board autosave the matching template. Reset Round preserves both templates; clearing a template is a separate confirmed action.
* **League setting** — persisted user preference (`Kyber`, `Aurodium`, `Chromium`, `Bronzium`, or `Carbonite`), remembered across rounds and used to pre-fill the board setup card.
* **Last squad format** — persisted `5v5`/`3v3` preference (`lastSquadMode`). It records the most recent squad format selected on the Counters toggle, and is used as the round setup card's seed value when the toggle is on Fleet at setup time (see [§6.7](#67-round-boards)). It is a Counters-screen browsing preference only; the round's own chosen format is owned separately once setup begins.

**Cache-first model.** localStorage is the working store; the roster API is a refresh mechanism, not a dependency. On boot the app renders from cached roster data instantly (`loadRoster()` runs before any network call), then — only for API-sourced rosters, and only if `syncedAt` is older than a staleness threshold (12 hours) — fires a silent background refresh. The refresh never runs while the Roster screen is open (so it cannot disrupt a mid-edit interaction), and applies only if the owned set actually changed, with an Undo snapshot when it does. If the refresh fails or times out, the app stays silently on cached data. The app is fully functional on cached data alone.

**Catalogue loading.** The catalogue is also cache-first, and the app owns its cache.

1. On boot the app renders from the last verified catalogue in `catalogueCache:v2` (`{schema: 2, sourceContract, acceptedAt, catalogueVersion, checksum, payload}`). If no valid v2 entry exists, it renders from a legacy Apps Script cache in `catalogueCache:v1`, which holds the same payload shape.
2. It then fetches the small pointer `catalogue/current.json`, bypassing HTTP caches, with a 10-second timeout.
3. If the pointer's checksum equals the SHA-256 of the catalogue on screen, nothing else is requested and the screen is not redrawn. A matching v1 cache is recorded as v2 at that point.
4. Otherwise the app downloads the immutable release file the pointer names, with a 30-second timeout covering the whole body. It accepts the file only if its size, JSON, contract, payload shape and canonical checksum all match the pointer ([§5](#5-api-contract)). It then stores it as v2, applies it and re-renders.

Any failure leaves the catalogue already in use in place and shows a quiet "Using saved catalogue. Couldn't check for updates just now." line. Failures include being offline, a timeout, an HTTP error, a truncated or corrupt file, an unknown contract, a checksum mismatch and a storage quota error. A verified release that cannot be stored is still used for the session.

With no valid cache and no acceptable release, the app shows "Catalogue unavailable" and changes no saved state. The app never writes `catalogueCache:v1`. It removes v1 only when storing v2 would otherwise exceed the storage quota, so the rollback app can still use it.

A catalogue change never alters saved boards, used teams, banners, templates or the round's `defenceSnapshot`. Saved identities missing from a new catalogue render as "saved; not in current catalogue". ADR-ARCH-116 §8 and §12 record the design rationale.

**Storage durability.** The app makes a best-effort `navigator.storage.persist()` request on boot to reduce OS eviction; this is effective on Chromium/Android and desktop. On Safari, Private Browsing uses ephemeral storage that is cleared at session end regardless of `persist()`. Normal (non-private) browsing retains storage. The durable backstops against any loss are manual Export/Import and one-tap re-import via ally code.

Because state is local to the device and browser, it does not sync across devices and is lost if site data is cleared or the PWA is reinstalled in a context without durable storage. With ally-code import in place, recovery is a single tap (re-enter or reuse the stored ally code) rather than a manual rebuild.

**Roster import timeout.** User-initiated import and refresh use a 60-second timeout to accommodate cold starts of the self-hosted Comlink service on Render's free tier. Background refreshes inherit the same timeout but fail silently.

---

## 4. Data Model

### 4.1 Catalogue Structure

The catalogue source under `catalogue/source/` is the **schema source of truth**. Each file is UTF-8 JSON with a top-level `"schema": 1` and one array of rows. Exact field lists, enumerations, ordering and uniqueness rules are owned by [`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md) §4 and enforced by the compiler's release gate. They are intentionally **not duplicated here**. This section describes the *purpose and relationships* of each file rather than its literal fields.

**Matchups** (`matchups/5v5.json`, `matchups/3v3.json`, `matchups/FLEET.json`) — the core relationship table. Each file covers one mode, named by the file. It maps each enemy defence team to an ordered list of counter teams. Each counter carries a tier, an expected banner score, an undersize count and optional notes. This is the data that drives the lookup screen. Fleet counters are authored in the `FLEET` file exactly like squad counters.

These fields own **non-overlapping** parts of a counter's value. Each feeds the allocation engine (see [§6.8](#68-allocation-engine)) at a different level:
- **`tier`** (`S` / `A` / `B` / `C`) — a **reliability** measure: how consistently the counter wins, as a deliberate authoring judgement. This is the engine's *primary* sort key (safety first).
  - Tier measures reliability, not efficiency, so it does not duplicate `bannerScore` (how *safely* a counter wins versus how *much* it banks). It is hand-authored because the app holds no data on skill, investment, mods or RNG.
  - Suggested rubric: **S** = wins reliably even at moderate investment or imperfect play; **A** = wins consistently with the right units and reasonable play; **B** = works but is matchup- or RNG-sensitive; **C** = situational, often needs specific conditions.
- **`bannerScore`** — the expected value of a **full-squad, first-attempt, clean clear**, with any undersize premium removed. It is the engine's *tiebreak within a tier* (value second). It is an authored estimate, not a guaranteed result. Authoring guidance and the per-mode meaning ladder are in [`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#scoring-data-authoring).
- **`undersize`** — a non-negative integer **droppable-unit count**: the maximum units the counter can drop from a full squad and still win cleanly. `0` means field the full squad. Each unit dropped is worth **+1 banner** over the full clean clear. For squads the engine ranks by the undersize-adjusted score (`bannerScore` + count), the achievable best (see [§6.8](#68-allocation-engine)). For Fleet the count is reinforcement slots left empty, and the +1 depends on those slots being unlocked, so it is shown as a conditional bonus and never added to ranking (see [§6.9](#69-points-to-win)). The client still reads any non-numeric value as `0`.

**Tactical steps.** A matchup entry may instead carry a `role` — `SETUP` or `CLEANUP` — with its `notes` and no `tier`, `bannerScore` or `undersize`. It records a counter used as one step of a multi-battle plan rather than a one-shot win: `SETUP` is a deliberate weakening battle that is not expected to win; `CLEANUP` is a win only against a defence an earlier battle has already weakened, never a fresh-team counter. The notes must state the step's purpose and conditions. The release gate blocks an unknown role, blank notes and any tier, banner score or undersize on a tactical step, and warns when a defence has a `CLEANUP` step but no `SETUP` step. Tactical steps are shown only on the Counters screen ([§6.1](#61-counter-lookup)); Round allocation, Next Up, My Board recommendations and the Last Battle advisor never treat them as coverage or project banners for them. The same `Counter_ID` can be a one-shot counter for one defence and a tactical step for another.

Tier is the only reliability field. Manual-play effort is not part of Tier (see [`ROADMAP.md`](../ROADMAP.md)); free-text `notes` partly serve it today.

A counter's display name is never authored on a matchup: the compiler resolves it from `counters.json`. Every referenced counter must exist in `counters.json`. A squad matchup may reference only character counters, and a `FLEET` matchup only ship counters. The release gate rejects anything else.

**Counters** (`counters.json`) — the identity and membership registry for counter teams. Each row holds:
- the stable `Counter_ID`;
- the display name;
- an ordered list of `required` `Character_ID`s;
- an ordered list of `recommended` `Character_ID`s.

Fleet counters live here too, with ships and capital ships as members. Empty lists are legal for partial or flexible compositions. A `Character_ID` appears at most once per counter, and every member must exist in `units.json`.

An optional `strategicReserve: true` marks a counter definition as a premium, flexible attacking resource worth preserving while the opponent's board is still partly hidden (see [§6.8](#68-allocation-engine)). When it is absent the counter reads as Normal. This is a property of the counter **definition**, not of a character. The same character in a different composition is unaffected unless that definition is marked separately.

**Units** (`units.json`) — the master unit registry. One row per playable unit holds its stable `Character_ID`, display name, `unitType` (`CHARACTER`, `SHIP` or `CAPITAL_SHIP`) and optional `externalId`. This file is the source for the roster screen, for validation and for import matching.

> **`External_ID` is a translation adapter, not the primary key.** It holds the SWGOH unit base ID returned by the game data: the portion of Comlink's `definitionId` before the rarity suffix. It is used only to translate imported rosters into internal `Character_ID`s. The internal key remains `Character_ID`, which keeps the data model independent of the game's external namespace.
>
> Only units that appear in some counter's `required` list strictly need a mapping for availability to work; others can be filled in opportunistically. Base IDs must be sourced from game or Comlink data, never derived from display names. Several are non-obvious (for example Jedi Master Luke and Sith Eternal Emperor), and a wrong value fails silently.

**Board config** (`board-config.json`) — the per-league board layout. Each row is one (league, mode, territory) combination, with the territory `type` (`SQUAD` or `FLEET`) and the `teamCount`: how many defence teams that territory holds in that league and format. This feeds the Round screen's board setup: choosing a league and mode pre-generates exactly the right number of team pickers per territory. Territory order within a league and mode is the source row order: Front Top, Front Bottom, Back Top, Back Bottom.

**Scoring** (`scoring.json`) — the GAC banner economy, and the single source of truth for banner scoring.
- **Rows.** One row per rule, keyed by `ruleId` plus `battleType` (`SQUAD`, `FLEET` or `ANY`) plus `mode` (`5v5`, `3v3` or `ANY`).
- **Values.** They cover setting defence, victory bonuses, first- and second-attempt bonuses, and per-unit surviving, full-health and full-protection bonuses. They also cover unused-slot bonuses, defeated-enemy points, the first-attack bonus and territory-clear bonuses.
- **Consumers.** Round score prefilling and the Points-to-Win calculator (see [§6.9](#69-points-to-win)).
- **`SETTING_DEFENCE`.** The release gate requires exactly one positive `SETTING_DEFENCE` / `ANY` / `ANY` row. New-round setup still checks it and is blocked with a data warning if it is missing or invalid. The app never invents or silently substitutes a starting-score value.
- **Unit counts.** The file also carries `OWN_UNITS` and `ENEMY_UNITS` rows. These are the number of the player's own units that earn per-unit survival bonuses in a clean win, and the number of enemy units defeated. They are separate values so the model does not assume own and enemy unit counts always match. The app supplies format-appropriate fallbacks if these rows are absent.

`scoring.json` owns the values; `app.js` owns the arithmetic ([§6.9](#69-points-to-win)); `tests/scoring-rules.test.js` pins the resulting ceilings and bonus arithmetic for each format and attempt.

The scoring rules also support the First Attack rule (see [§6.12](#612-first-attack)). The `FIRST_ATTACK` row is consumed directly. The per-unit `SURVIVING_UNIT`, `FULL_HEALTH_UNIT` and `FULL_PROTECTION_UNIT` rows are summed to give the banner cost of one of the player's own units failing to come through a battle intact. That cost converts a counter's `bannerScore` into an expected unit loss. Nothing extra is authored for this, so retuning the scoring rows retunes the risk bar with them.

**Defence teams** (`defence-teams.json`) — authored attributes of an **enemy** defence team. Each row is one (defence team, mode) combination, with a `threat` rating and optional free-text `notes`. Mode is `5v5`, `3v3`, `FLEET` or `ANY`; a mode-specific row beats an `ANY` row, mirroring how scoring rules resolve. This is the only file keyed on a defence team rather than a counter. Its key is the **display name** used in the matchup files, which is also the string the opponent board stores. The board, the counter catalogue and this file therefore all agree on one name.

`threat` is hand-authored because every derivable signal (counter count, tiers, scores) measures the data rather than the enemy and would misrank, e.g., a Galactic Legend with one excellent counter. See [§6.11](#611-battle-order).

The file is **sparse by design**. A defence team with no row reads as `NORMAL`; rate only teams the automatic ordering gets wrong (in practice Galactic Legends and thinly documented easy teams). Renaming a defence team in a matchup file would silently orphan its rating. The release gate guards against this. A defence-team or defence-composition name that misses every matchup in its mode but nearly matches one is a candidate alias, and it blocks publication until the owner resolves it. Nothing is ever renamed automatically.

**Defence compositions** (`defence-compositions.json`) — optional canonical unit membership for saved My Board identities. Each row is one (defence team, mode) combination with its list of `Character_ID`s. It exists only to turn a saved defence identity into the exact character and ship IDs that must be unavailable on attack. A mode-specific row beats `ANY`.

When no explicit row exists, the client may reuse a counter's `required` list, but only where the defence name exactly and uniquely matches a counter-team name. Those known required IDs are blocked. The identity is still marked partial, because an attacking core may leave out defensive members. The client never parses names or guesses flex members. Ambiguous, custom or otherwise unresolved identities are recorded in the round snapshot and shown as a partial-filter warning.

**Score meanings** (`score-meanings.json`) — a reference table that maps a (mode, banner score) pair to that score's practical meaning. It exists to keep `bannerScore` authoring consistent ([`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#scoring-data-authoring)). It is not compiled into the catalogue payload.

> **Composition is mode-agnostic across squad formats.** The required core of a character counter is currently identical in 5v5 and 3v3, so counter definitions carry no mode. Fleet is a third matchup mode (`FLEET`) rather than a separate format axis, because the fleet territory is present in every GAC whatever the character format. A fleet counter's required core is its ships, drawn from the same `counters.json`.

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
* The SWGOH unit base ID for a unit (e.g. `GLLEIA`, `GRANDMASTERLUKE`, `SITHPALPATINE`).
* A translation adapter only — never used as an internal key.
* Corresponds to the base-ID portion of Comlink's `definitionId` before the `:` rarity suffix; source it from game/Comlink data rather than deriving it from display names.

**League**
* Uppercase, no spaces. Enumerated: `KYBER`, `AURODIUM`, `CHROMIUM`, `BRONZIUM`, `CARBONITE`.

**Territory**
* Uppercase, underscored. Enumerated: `FRONT_TOP`, `FRONT_BOTTOM`, `BACK_TOP`, `BACK_BOTTOM`.

**Territory_Type** — enumerated: `SQUAD`, `FLEET`.

**Rule_ID** — uppercase, underscored, stable identifier for a scoring rule (e.g. `VICTORY`, `TERRITORY_CLEAR_PER_TEAM`, `UNUSED_SLOT`).

**Battle_Type** — enumerated: `SQUAD`, `FLEET`, `ANY`.

**Unit_Type** — enumerated: `CHARACTER`, `SHIP`, `CAPITAL_SHIP`. All-caps enum values keep them distinct from free text and make validation and filtering reliable. The roster screen and import consume all three (`CHARACTER`, `SHIP`, and `CAPITAL_SHIP`).

**Role** — `REQUIRED` or `RECOMMENDED`, expressed by which list (`required` or `recommended`) a unit appears in on its counter. Only `REQUIRED` units are considered for availability.

**Threat** — enumerated: `EXTREME`, `HIGH`, `NORMAL`, `LOW`. Any other non-blank value fails the release gate; a blank value is only a warning. The client resolves a blank or unrecognised value to `NORMAL`, so bad data falls back to the default rather than sorting to the top of the battle order.

**Defence_Team** — the one identifier in the model that is a **display name rather than a stable ID**. Defence teams have never had an ID. They exist only as the `defence` name in the matchup files, which is also what the opponent board stores. Defence teams and defence compositions (see [§4.1](#41-catalogue-structure)) key on that same string; there is no `Defence_Team_ID`, and the release gate's candidate-alias check guards against renames.

---

## 5. API Contract

The app reads two read-only interfaces: the static catalogue on its own Pages origin, and the Apps Script roster proxy.

### Static catalogue

**Pointer.** `catalogue/current.json` is a small pointer:

```json
{
  "pointerSchema": 1,
  "contract": "gac-catalogue-release:v1",
  "catalogueVersion": 6,
  "checksum": "sha256:<64 hex>",
  "path": "releases/6-<first 12 hex of checksum>.json",
  "bytes": 85520
}
```

`path` is relative to `catalogue/` and names an immutable release file. `bytes` is that file's exact length.

**Release file.** One JSON object containing the seven catalogue keys below plus `release` `{contract, sourceSchema, catalogueVersion, checksum}`.

**Checksum.** `checksum` is the SHA-256 of the canonical JSON of the seven keys only: keys sorted recursively, 2-space indented, with a trailing newline. Identity is therefore by content. The client compares checksums and never refuses a release because of its version number. The client accepts a release only when:
- `path` is exactly `releases/{catalogueVersion}-{first 12 hex}.json` for the pointer's own version and checksum;
- the file is exactly `bytes` long;
- both contracts are `gac-catalogue-release:v1`;
- the seven keys have the shape below;
- the recomputed checksum equals the pointer's.

[`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md) §5 and §7 own the release, pointer and versioning rules. [§3.4](#34-state--persistence) describes caching and failure handling.

**Payload.** The seven catalogue keys are the boundary between catalogue and frontend. The frontend depends on this shape rather than on the source layout.

```json
{
  "counters": { "5v5": {}, "3v3": {} },
  "counterDefinitions": {},
  "characterDefinitions": {},
  "boardConfig": {},
  "scoring": [],
  "defenceTeams": {},
  "defenceCompositions": {}
}
```

**counters** — keyed by mode, then by defence team name, to an ordered array of counter entries `{counterId, counter, tier, bannerScore, undersize, notes}`.
- A tactical step ([§4.1](#41-catalogue-structure)) is `{counterId, counter, role, notes}` instead, with `role` `SETUP` or `CLEANUP`; it has no `tier`, `bannerScore` or `undersize` key.
- `counter` is the display name from `counters.json`.
- `undersize` is the non-negative droppable-unit count.
- `notes` is `""` when absent.
- `5v5` and `3v3` are always present, possibly empty. `FLEET` is present when at least one fleet matchup exists.
- Array order is the authored order, which stable sorts use to break ties.

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

A definition carries `strategicReserve: true` only when it is set in the source (see [§4.1](#41-catalogue-structure)). Otherwise the field is omitted, which the client reads identically to `false`.

**characterDefinitions** — keyed by `Character_ID`:

```json
{
  "LEIA_ORGANA": { "name": "Leia Organa", "unitType": "CHARACTER", "externalId": "GLLEIA" }
}
```

`externalId` is `""` when the unit is unmapped; such a unit simply won't match on import. `unitType` carries `CHARACTER`, `SHIP` or `CAPITAL_SHIP`.

**defenceCompositions** — keyed by mode (`5v5`, `3v3`, `FLEET` or `ANY`) and then defence-team display name. Values are arrays of canonical `Character_ID`s in authored order, de-duplicated. When it is empty (`{}`), the client uses only its exact, unique counter-identity fallback as a partial lower bound and reports that identity as unresolved.

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

Territory order is the source row order. When it is empty (`{}`), the frontend shows a "board configuration hasn't loaded" notice rather than failing.

**scoring** — a flat array of banner-economy rule rows. Composite key is (`ruleId`, `battleType`, `mode`):

```json
[
  { "ruleId": "VICTORY",                  "battleType": "ANY",   "mode": "ANY", "value": 15, "notes": "Per battle won" },
  { "ruleId": "TERRITORY_CLEAR_PER_TEAM", "battleType": "SQUAD", "mode": "5v5", "value": 30, "notes": "" }
]
```

Resolution logic is client-side. An empty source yields an empty array. The rules are consumed by the Points-to-Win Calculator (see [§6.9](#69-points-to-win)); the current app payload is otherwise unaffected by this data.

**defenceTeams** — keyed by `Mode`, then by defence team display name:

```json
{
  "ANY": {
    "Padme Amidala": { "threat": "EXTREME", "notes": "GL — few real answers" }
  },
  "5v5": {
    "Mon Mothma": { "threat": "HIGH", "notes": "" }
  }
}
```

Modes are `5v5`, `3v3`, `FLEET` or `ANY`. `ANY` is a wildcard that a mode-specific entry overrides; this is resolved client-side. `threat` is one of `EXTREME`, `HIGH`, `NORMAL` or `LOW`, and `notes` is `""` when absent. When it is empty (`{}`), every defence team reads as `NORMAL`.

Sparse sections yield safe empty values. Clients ignore keys they do not consume, including `release`. Any breaking change to the seven-key shape requires a new `contract` value and a coordinated app release.

### Roster proxy: Apps Script `action=roster&allyCode=…`

A thin proxy to the self-hosted SWGOH Comlink service. Apps Script posts the ally code to Comlink's `/player` endpoint, reads each `rosterUnit[].definitionId`, strips the rarity suffix after `:`, deduplicates the resulting unit base IDs, and returns those IDs to the client. The client performs all `Character_ID` mapping and character/ship classification.

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

The user selects a mode (5v5 / 3v3 / Fleet) and a defence team, and sees the available counters. Each counter card displays the counter team name, tier (colour-coded), expected banners, undersize advice, and notes. A search box filters the defence-team list, and counters are sorted by status group, then tier, then by banner score.

The undersize line reflects the droppable-unit count (see [§4.1](#41-catalogue-structure)): a counter that can shed units reads "drop up to N → X banners (+N)", showing the reconstructed best-case total; a counter that cannot reads "full squad". A fleet counter reads "leave up to N reinforcement slots empty for up to +N — unlocked slots only (the 4th needs a 7★ capital ship)", with no reconstructed total, since the screen does not know the capital ship's stars; one that cannot reads "full fleet". Round recommendations and Next Up use the same fleet wording.

The **Fleet** segment shows fleet counters exactly as the squad modes show squad counters — enemy fleet defence teams and the ship counters that beat them. When the catalogue holds no fleet matchups, the Fleet view shows a plain "no fleet counters yet" message in place of the dropdown and results, and fills in automatically once fleet counters are authored. Fleet is a browsing view on this screen; it is not a whole-board format (see [§6.7](#67-round-boards)).

Tactical steps ([§4.1](#41-catalogue-structure)) appear after the one-shot counters in a separate **Multi-battle options** section, in authored order so a setup reads before the cleanup that depends on it. Each card shows a **Setup** or **Cleanup** badge in place of the tier and a plain role line ("weakening battle — not expected to win…" / "conditional cleanup — only after an earlier battle has weakened this defence…") in place of expected banners and undersize, plus status, notes and **Mark Used**. The Owned and Available filters apply to them too. When a defence has no one-shot counters, the one-shot area says so above the section.

A wayfinding line on the Counters screen points the user to the Round screen for round tracking and reset — those responsibilities live there, not here (see [§6.6](#66-round-screen)).

### 6.2 Used Team Tracking

The user can mark a counter as used during a round. Used counters are keyed on their stable `Counter_ID` and persist across app launches. A round reset clears all used teams, banner tracking and both current-round boards while preserving defence templates (see [§6.6](#66-round-screen)).

Used status is surfaced as part of the unified counter status (see [§6.5](#65-counter-status)). Used cards are displayed at 0.5 opacity with a grey "Used" status word; the Mark Used button is suppressed on used cards. Marking a counter used also spends its required units for the round, which retires any *other* counter needing one of them — the Current Round count still tracks battles fought, not counters retired. Used teams are counted in the Current Round summary card, which appears on both the Counters and Round screens. Counters can also be marked used directly from the Round screen's per-team recommendations (see [§6.8](#68-allocation-engine)); the state is shared. This applies to fleet counters as well as squad counters.

### 6.3 Banner Tracking

The user tracks two editable live totals: their current score and the opponent's current score. When a genuinely new round is created, both are prefilled once as the number of defence slots multiplied by the authored `SETTING_DEFENCE` rule. From then on they are ordinary hand-editable totals; board edits, template edits, reloads and schema migration never recalculate them. Existing rounds migrating from older opponent-board schemas receive a companion My Board without any score prefill or overwrite.

Banner tracking lives on the Round screen alongside both boards (see [§6.6](#66-round-screen)). It shows each player's **current → maximum** range plus the live current-score margin. The player's maximum is their current score plus remaining offence against Opponent Board; the opponent's maximum is their current score plus remaining offence against My Board.

**Calculated remaining.** The same side-agnostic walker calculates both sides. It walks every uncleared team across the relevant board — including back territories — and applies victory, the attempt bonus keyed to that board team's Battles count, per-unit bonuses, defeated-enemy points and territory-clear bonuses (see [§6.9](#69-points-to-win)). The player's remaining figure retains its temporary manual override: typing a value sets an amber-marked override; changing Opponent Board discards it and returns to the live calculation. The opponent's remaining figure is always calculated from My Board and is not manually overridden.

**First-attack bonus.** Each side's calculation includes `FIRST_ATTACK` while its relevant attack state is untouched. The player's state also considers used counters; the opponent's state is derived from Battles and Cleared on My Board. The bonus drops out automatically once that side has attacked.

**Opponent final-score marker.** The opponent-score field can be marked **final**. While marked, their calculated remaining becomes zero and their range collapses to current → current. This is a scoring assertion only: it never marks, clears or otherwise changes My Board. Reverting the marker restores the board-derived remaining figure. It defaults to current and is reset by Reset Round.

Both maxima remain optimistic perfect-finish ceilings. The two ranges drive the outcome verdict described in [§6.10](#610-can-i-still-win). Banner state is stored locally and cleared by Reset Round.

### 6.4 Roster Management

A dedicated Roster view, reached from the bottom navigation bar, lists the player's units in two sections — **Characters** and **Ships** — with a running owned/total count for each ("X / Y characters · A / B ships owned"). Within the Ships section, capital ships carry a small **Capital** badge so they are distinguishable from regular ships at a glance, mirroring how the game presents them together. A single search box filters both sections at once; while searching, a section with no matches is hidden, and if nothing matches a single empty line is shown. If the loaded data contains no ship definitions at all (e.g. an older cached payload), the Ships section and its count are omitted. The user taps to toggle ownership; ownership is stored locally and feeds directly into availability calculations. A clear-roster action resets all ownership.

There are three ways to populate the roster, in order of precedence as the recommended path:

1. **Import via ally code (primary).** The user enters their 9-digit ally code and the app loads ownership directly from their account via the roster proxy. When the roster is empty this is presented as a prominent first-run card; once an ally code is associated it becomes a "Refresh roster" control. Imported game base IDs are mapped to internal `Character_ID`s through the `External_ID` adapter; the result replaces the current roster (with Undo). Import brings in characters, ships, and capital ships together, and is reported as "Imported X characters and Y ships from the game," with a further count of units not yet present in the app's database (informational, expected after game updates). Foreground import validates the ally code, guards against being offline, applies a 60-second timeout (accommodating Comlink's Render cold starts), and gives per-case error copy (including the common "not yet synced" case). A confirmation is shown before overwriting an existing different roster; a routine refresh of the same ally code is not gated.
2. **Manual toggle.** Tap individual units on/off. Always available.
3. **Paste-JSON import (fallback).** The collapsible Manage roster data panel provides Export (copies the roster to the clipboard as JSON) and Import (validates pasted roster data, replaces the current roster, reports unrecognised units), plus Clear roster. This operates on internal `Character_ID`s, accepts characters and ships alike, and shares the same apply path and Undo as the API import.

The screen shows a **source-aware freshness line**: API-sourced rosters show "Last synced: …" (`syncedAt`), manual rosters show "Last saved: …" (`savedAt`). The import result message and Undo control appear in a top-level notice cluster so they remain visible even when the data panel is collapsed. Clear roster lives in the data panel rather than the header because a SWGOH roster rarely shrinks; clearing is a deliberate maintenance action, not part of normal use.

A staleness-gated background sync keeps API rosters current without user action — see [§3.4](#34-state--persistence) for its cache-first semantics.

### 6.5 Counter Status

Each counter carries a five-state status derived from two independent axes:

**Ownership axis** (static, roster-derived) — whether the player owns all required units for a counter. A counter is **owned** when every `REQUIRED` unit is in the player's roster; `RECOMMENDED` units are not considered. This is computed by `getOwnership()`, and applies identically to fleet counters (whose required units are ships).

**Round axis** (dynamic, round-derived) — whether an owned counter can still be fielded this round. Three things can stop it: the counter itself was marked used, one of its required units is in the active round's defence snapshot, or a required unit went out with an earlier attacking counter. Defence and offensive use remain distinct reasons. Partial overlap is sufficient to block a composition. Offence spends units for the whole round whatever the battle's outcome, so a counter sharing a `REQUIRED` character with a used one is unfieldable even though it has never been marked used itself. Only `REQUIRED` units participate; `RECOMMENDED` units are advice, not a claim.

The two axes combine into four card states, computed by `getCounterStatus()`:

| State | Condition | Status word | Opacity |
|---|---|---|---|
| Available | Owned, not used, no required unit on defence, and no required unit spent | Green "Available" | Full |
| Used | Owned and already used this round | Grey "Used" | 0.5 |
| On defence | Owned and unused, but at least one required unit is in the round's defence snapshot | Grey "On defence" | 0.5 |
| Unavailable | Owned and unused, but a required unit was spent by an earlier counter | Grey "Unavailable" | 0.5 |
| Not owned | Missing one or more required units | Grey "Not owned" | 0.5 |

**Precedence:** Not owned dominates, then Used, On defence, and Unavailable. Round state is only meaningful for owned counters. Used and On defence are not conflated.

**Missing units** — Not owned cards list their missing required units by display name beneath the notes line.

**Spent units** — Unavailable cards name the clash beneath the notes line ("🔒 Units spent: Darth Bane was used with Bane."), so a greyed card with no missing-units line can't be mistaken for a bug. The Mark Used button is suppressed, as it is on Used and Not owned cards.

**Defence units** — On defence cards name the overlapping required unit(s). They remain visible for reference but cannot be marked used.

**Filter** — a three-segment control [All] [Owned] [Available] sits below the team selector and above the results list. It is visually subordinate to the mode toggle. The three segments form a nested hierarchy (All ⊇ Owned ⊇ Available), with each a strict subset of the one before. The selected filter persists in `localStorage` and defaults to All.

**Empty states** — each filter produces context-appropriate copy when no counters match:
- **All** — "No matching defence teams found." (no counters in data for this team)
- **Owned** — "You don't own any counters for this team."
- **Available** — explains whether the owned counters are all used, committed to defence, or require units already spent this round; otherwise falls through to the Owned copy.
- **Owned / Available with no roster** — "Set up your roster to see which counters you can field."

**Sort order** — counters are sorted by status group first (Available → Used → On defence → Unavailable → Not owned), then by tier (S → A → B → C), then by banner score descending. This ensures fieldable counters surface at the top regardless of tier.

### 6.6 Round Screen

The Round screen is the live-match workspace, reached from the middle position of the bottom navigation bar, and is the screen shown by default when the app opens. There is no persisted "last screen" — each fresh load starts on Round; the user can navigate to Counters or Roster within the session as normal. It consolidates three related concerns in a single scrolling view:

1. A **round summary card** with the used-team count, defence-filtering status, and the confirmed Reset Round action. It reports the number of canonical units frozen as unavailable. If no saved defence existed for the selected format, it warns that defence availability is not being filtered and, once My Board has at least one team, offers a confirmed **Use My Board as this round's defence** action (see [§6.7](#67-round-boards)); unresolved legacy/custom identities produce a partial-filter warning. Reset clears used teams, banner tracking, Opponent Board and My Board together; saved 5v5/3v3 defence templates are deliberately preserved.
2. An **Opponent Board / My Board** switch, defaulting to Opponent Board, above the paired current-round boards (see [§6.7](#67-round-boards)). Opponent Board retains allocation and Battle Order, led by the Last Battle advisor when only one defence remains (see [§6.13](#613-last-battle-advisor)); My Board records the opponent's progress against the player's defence.
3. **Banner tracking** (see [§6.3](#63-banner-tracking)) beneath the board, and the **points-to-win** verdict it drives (see [§6.9](#69-points-to-win)).

One setup action creates both boards from the same frozen league/format layout. Co-locating their state and scoring lets the two-sided range and outcome verdict draw directly from live board progress.

### 6.7 Round Boards

The round owns two paired boards with the same league, squad format, territory order and team counts. **Opponent Board** records the opponent's defence and drives the player's counter plan. **My Board** records the player's defence and the opponent's attacks against it.

**Unified setup.** When no round exists, the setup card shows an explicit **GAC format** selector (5v5 / 3v3) above the league picker, seeded once from the Counters screen's current squad-format toggle for convenience (falling back to the last squad format used if the toggle is on Fleet). The round owns this choice from that point on: it does not track later Counters-toggle changes, and the player can switch it freely while the card is empty, since no board exists yet to reinterpret. Selecting a league then creates both boards from the board configuration using the chosen format. Opponent Board starts empty. My Board is populated by the saved template matching the frozen squad format, mapping identities by territory and slot index. At the same moment, the app resolves that template to canonical unit IDs and stores an immutable defence snapshot on the round. Later My Board/template edits never change it, with one exception: when no matching template existed at setup (an empty snapshot flagged as missing saved defence), the player may commit the current My Board once through the confirmed action on the round summary card, and that snapshot is then immutable. A new round takes a fresh snapshot from the matching 3v3 or 5v5 template. Setup also performs the one-time score prefill described in [§6.3](#63-banner-tracking) and is blocked when `SETTING_DEFENCE` is missing or invalid.

**Format ownership.** Once a round is created, its format lives on the board's `mode` field (see [§3.4](#34-state--persistence)) and is authoritative for that round: counter suggestions, defence interpretation and every other format-sensitive Round-screen behaviour read `board.mode`/`myBoard.mode`, never the Counters screen's toggle. The setup card — and its format selector — only ever renders while no round exists, so there is no in-round path that could reinterpret already-entered board data against a different format; reconfiguring the format means Reset Round, which already clears both boards while preserving saved defence templates.

**Territories.** Both boards hold Front Top, Front Bottom, Back Top and Back Bottom, with progress and a bulk Clear territory action. Fleet slots draw from the fleet catalogue. Opponent Board applies normal lane unlocking. My Board deliberately renders all four territories at all times, including back territories the opponent has not yet unlocked, so the full defence and full remaining ceiling are inspectable.

**Lane unlocking.** The two lanes are independent. **Back Bottom** is locked until Front Bottom is cleared, and **Back Top** (the fleet territory) is locked until Front Top is cleared — the same reveal chain in both lanes, matching the game.

**Per-team state.** Each squad or fleet slot on either board has:
- A **team picker** offering every identity in the relevant catalogue plus **Not in catalogue**. Selecting the latter reveals an optional free-text team name. On My Board, catalogue/custom identity changes autosave the matching format template.
- A **Cleared toggle** — the per-team source of truth. Territory-cleared state is derived from these flags plus the bulk setter; it is never persisted separately. On Opponent Board, a successful clear advances to the next recommended uncleared defence in the existing squad or fleet Next Up track; when no recommendation remains, the ordinary empty state is shown. Marking a team cleared (on either board) offers a temporary **Undo** for ~6 seconds that restores the team's exact prior state; after auto-advance the offer appears beside the newly focused matchup, and it disappears on its own once the window elapses. A later Cleared or Used + Cleared action replaces any still-pending Undo offer rather than stacking one.
- A **Battles counter** — a −/+ stepper mirroring the in-game Battles number. On Opponent Board it records the player's attempts; on My Board it records the opponent's. It is stored verbatim and determines the next-attempt bonus in that side's remaining calculation. It is hidden after the team is cleared.

Only Opponent Board has counter recommendations, Battle Order and Next Up highlighting. My Board has no counter recommendations or Battle Order because it describes the opponent's offence, not a plan for the player.

**Templates.** The complete 5v5 and 3v3 templates are independent and each includes its own fleet setup. Saving is identity-only; current Battles and Cleared flags never enter a template. A confirmed clear action removes the saved template for the current format without altering the current My Board.

**Persistence and compatibility.** Both live boards use schema 5 and are hydrated before paint and on Round entry. The opponent-board object persists the defence snapshot. Reset Round clears both. Existing schema-2/3 `boardData` remains readable and is migrated rather than discarded; its saved layout and live team state become Opponent Board, a paired My Board is created from that layout, and existing scores are explicitly preserved. A schema-4 active round freezes its paired My Board once after catalogue data loads, then follows the normal immutable-snapshot rule. The opponent-board key remains unchanged so compatibility is deliberate rather than a silent contract break.

### 6.8 Allocation Engine

The allocation engine surfaces per-team counter recommendations across the whole visible board, accounting for the fact that each counter can be used only once per round and that units used on offence are spent for the round regardless of the battle's outcome.

**When it engages.** The engine is always active while a board exists. When two or more visible-uncleared teams share at least one eligible-and-owned-and-unused counter, an explicit **overlap notice** appears at the top of the board ("Shared counters detected — recommendations below account for the overlap"), announcing that the recommendations are actively arbitrating between competing claims rather than treating each team in isolation.

**Eligibility.** For each visible-uncleared board team, the engine derives the set of counters that are:
- Present in the counter catalogue for that team as a one-shot counter (the board's squad format for squad territories, the FLEET catalogue for the fleet territory). Tactical setup/cleanup steps are never candidates; when the player owns no one-shot counter but can field a tactical step, the team's reason says so and points to Counters.
- **Owned** by the player (all required units present — reuses `getOwnership()`).
- **Still fieldable** this round — neither marked used itself, requiring a unit committed to defence, nor requiring a unit an earlier used counter has already spent (status `available`; see [§6.5](#65-counter-status)).

`buildEligibleTeams()` also materialises every listed one-shot counter's identity, tier, required characters, ownership and current fieldability. A pure deterministic scarcity pass derives direct counter-identity conflicts, direct required-character conflicts and transitive resource groups from that snapshot. Transitive grouping prevents overlapping variants from being counted as independent routes: for example, if one option requires SEE, another requires Bane and a third requires both, all three belong to one resource group even though the first two do not directly overlap. Only visible, named, uncleared defences participate. Used counters, spent characters and the immutable defence snapshot have already removed unfieldable options before a resource can influence allocation. Not-in-catalogue placeholder teams contribute no candidates and receive an explanatory reason instead of a recommendation.

**Solver.** A scarcity-first ordered search with branch-and-bound pruning enumerates valid assignments over the eligible teams. The objective is lexicographic:

1. Maximise **coverage** — the number of teams that receive an assignment.
2. Then compare each plan's **whole-board tier profile from weakest assignment to strongest**, preferring the plan whose weakest differing assignment has the stronger tier. This treats tiers as ordered reliability categories (S over A over B over C), not numeric win probabilities. It prefers A + A over S + B, while S + C still beats A + C because their weakest assignments tie and S wins the next comparison. While the strategic-reserve penalty below is active, a High-reserve counter's tier rank in this profile is one step worse than its authored tier (see below).
3. Then, only while the strategic-reserve penalty is active, minimise the number of High-reserve counters used in the plan.
4. Then maximise summed **undersize-adjusted banner score** — the achievable best per counter: its full-squad banner score plus its safe droppable-unit count (`Banner Score` + `Undersize`), since +1 banner is bankable per unit dropped. A fleet counter contributes its plain banner score: its undersize bonus depends on unlocked reinforcement slots the engine cannot see, so it is not bankable (see [§6.9](#69-points-to-win)).

Because the adjustment sits *below* tier, it only reorders counters **within a tier**; tier remains an inviolable safety floor. When two same-tier counters reach the same adjusted total (e.g. 64 full-squad/no-drop versus 62 full-squad/drop-2), the one relying on **less undersizing** wins.

The undersize adjustment affects *ranking* only. The card headline still shows the **full-squad** banner score, with the undersize upside on its own line (see [§6.1](#61-counter-lookup)). When undersizing changed the pick, the team's reason line says so — e.g. "Chosen for its undersize potential (64 vs 63)." — and no such note appears otherwise.

**Visible-board conservation.** The weakest-first tier profile operates throughout the round, including after all zones are revealed. It reallocates a genuinely shared counter or required character only when doing so improves the complete visible board's reliability distribution after maximum coverage is secured. It therefore does not preserve a strong attacker merely because the attacker looks valuable in isolation, and a single defence with only a materially weaker alternative still receives its strongest fieldable option. The engine does not use the authored enemy `threat` value for this allocation decision, maintain a special defence list, parse matchup notes, or invent confidence/probability values.

**Hidden-zone strategic reserve.** Counter definitions with `strategicReserve: true` (see [§4.1](#41-catalogue-structure) and [§5](#5-api-contract)) mark a premium/flexible attacker worth preserving while the opponent's board is partially hidden. This is a separate input from visible-board scarcity. The penalty applies only in Round Mode and only while `roundHasHiddenZones()` finds a board territory still locked behind the reveal chain ([§6.7](#67-round-boards)); it never applies on the Counters screen and stops once the whole board is unlocked. While active, a High-reserve counter ranks one tier weaker in the tier-profile comparison, then, if candidates are still tied, fewer High-reserve counters are spent overall. It is a mild tie-break: a High-reserve counter still out-ranks any non-reserve alternative more than one tier behind it. A High-reserve counter not chosen for a team stays visible on its card as a compact, still-selectable alternative (same Mark used action), and both it and a chosen High-reserve counter carry "⚠ Consider holding — strong flexible counter and hidden zones remain." The note never hides, disables or blocks a counter. The only interruption is a native confirm ("Use *counter name* now?") on the Opponent Board when the player taps **Mark used** or **Used + Cleared** for a High-reserve counter that is not already used and `roundHasHiddenZones` is true at click time; OK runs the action once, Cancel is a complete no-op. It never appears once the board is revealed, for non-reserve counters, on the Counters screen, My Board, Undo, or state load/render. The engine does not predict which hidden defence may later appear.

Two exclusivity constraints are enforced natively:

- **Counter-level.** A counter can appear in at most one assignment in a plan.
- **Unit-level.** Two counters that share a required unit can never both appear in the same plan, since units used on offence are spent for the round. The same rule applies against round history: a counter sharing a required unit with one already marked used is excluded at the eligibility step above, not just from co-assignment. The plan explains clashes by name in the losing team's reason. Because ships and characters occupy disjoint unit sets, a fleet counter and a squad counter never collide; the fleet allocation is effectively independent of the squad allocation, while two fleet teams contesting the same owned ship are still arbitrated correctly.

Teams are searched by ascending candidate count (then stable board key), candidates by tier, undersize-adjusted score, full-squad score and stable catalogue order. A 50 000-node budget guards pathological cases. The deterministic greedy assignment is seeded before search, so even a budget exhausted before the first leaf returns a complete usable fallback; every explored leaf can only improve it. The branch-and-bound bound is coverage-only.

The same traversal also retains the best plan under the former coverage → summed-tier → hidden-reserve → banner objective. This bounded counterfactual is diagnostic only: it establishes whether the weakest-first visible-board objective actually changed an assignment without multiplying exhaustive solves per candidate.

**Derived diagnostics.** `computeRoundPlan()` exposes non-persisted `hiddenZoneReserve`, `visibleBoardScarcity` and `visibleBoardConservation` objects for the Round UI. Scarcity lists each visible defence's catalogue candidates with `counterId`, tier, required-character IDs, ownership, fieldability and status, plus direct conflicts and transitive resource groups. Conservation reports `state` (`changed`, `unchanged` or `limited`), a nullable `changed`, its motivation, selected and former-objective tier profiles, assignment trade-offs with defence/counter IDs and shared required-character IDs, warnings, and search budget/exhaustion data. Warning status is `low-tier` for a selected B/C option, `compromised` when a fieldable option exists but valid whole-board exclusivity leaves the defence uncovered, and `no-credible-coverage` when no fieldable one-shot option exists. If the search budget is exhausted, change attribution is `limited`/`null` rather than asserted. Both diagnostic objects explicitly report that runtime quality is limited to ordinal tiers: detailed evidence confidence is not present in the runtime payload, so B/C does not mean a guaranteed win and no synthetic score is produced.

**Re-solve model.** The plan is computed live on every Round-screen render and never persisted; any state change (used, Cleared, team edit, roster change) re-solves through the normal render-on-state-change pattern.

**Per-team display.** Each visible-uncleared team card is followed by a recommendation block containing:
- The chosen counter's name, colour-coded tier badge, and expected banner score.
- A one-line **reason** grounded in the plan's real alternatives — e.g. "Also counters Great Mothers — SLKR covers that one instead" — rather than a generic strength claim. When a team is the second choice for a counter that got diverted elsewhere, the reason names both the counter and the team it went to. When a team is left uncovered because of a unit clash, the reason names the unit and the counter holding it. When undersizing is what wins a counter its pick over a higher-full-squad same-tier rival, the reason appends an explanation — e.g. "Chosen for its undersize potential (64 vs 63)." — so the card's deliberately-conservative full-squad headline never looks lower than a rival's for no visible reason. Fleet picks are never undersize-driven, so they never carry it.
- An **undersize line** when the chosen counter has a droppable-unit count > 0 (see [§4.1](#41-catalogue-structure)): it shows the reconstructed best-case total most prominently, then the drop count and bonus — e.g. "67 banners if you undersize · drop up to 2 for +2". Counters that cannot undersize show no such line; a fleet counter shows the conditional fleet wording from [§6.1](#61-counter-lookup) instead of a total. This annotates a recommendation the player is already reading rather than adding a screen or a decision, and the underlying `undersizeInfo` helper is shared with the lookup card (see [§6.1](#61-counter-lookup)).
- A **Used + Cleared** button — the normal successful-counter action and the most prominent of the three — that commits the recommended counter to `usedTeams` and marks the team cleared in one operation, then triggers a re-solve and the same-track auto-advance described above. Its temporary Undo (same ~6-second window as Cleared) restores both to their exact prior values: if the counter was already used before the tap, Undo leaves it used and restores only the team to uncleared, rather than blindly toggling either flag.
- A **Used + Lost** button — the secondary action — that commits the recommended counter to `usedTeams` and increments that defence's persisted Battles count by exactly 1, leaving it uncleared and without auto-advance (the defence keeps focus and the re-solve offers another available counter). Banner ceiling, points-to-win and first-attack availability update through the existing Battles-driven calculations. Its temporary Undo (same window and single-slot behaviour as Used + Cleared) restores the exact prior Battles count and counter-used state; a counter that was already used stays used. Used + Cleared does not change Battles.
- A **Mark used** button, kept visibly tertiary alongside them, that commits only the counter to `usedTeams` immediately and triggers a re-solve, for when used-state and cleared-state don't change together. The state is shared with the Counters screen (see [§6.2](#62-used-team-tracking)).
- Compact **On defence** reference rows for otherwise relevant counters blocked by the snapshot. These appear below the usable recommendation (or beneath the no-recommendation reason), so blocked counters remain visible without appearing actionable.
- A **Suggested squad** disclosure — collapsed by default — that expands inline to show the recommended counter's catalogued attacking composition (see below). Purely informational: expanding or collapsing it never selects the counter, marks anything used, clears the team, or changes the recommendation.

Teams with no recommendation receive a distinct plain-English reason for catalogue, ownership, used, On defence, spent-unit, or allocation conflicts.

**Suggested squad disclosure.** A recommendation card whose `counterDefinitions[counterId]` has non-empty `required` and/or `recommended` shows a tappable, keyboard-accessible disclosure (`aria-expanded`) reading "Suggested squad". With no composition data in the catalogue (`counters.json`) no disclosure is shown. Expanded state is local, in-memory only; it resets when a round is created or reset, and each card's key includes its counterId so a changed selection opens collapsed.

Expanded content lists:
- Each `required[]` character by name (resolved via `characterDefinitions`, falling back to the raw ID if unresolved, matching the app's existing catalogue-fallback convention).
- Each `recommended[]` character by name, visually distinguished and labelled "Recommended".
- A named member's current availability note — "Not owned", "On defence", or "Used with `<counter>`" — reusing the same `ownedCharacters`, `spentCharacters()`, and defence-snapshot state the rest of Round Mode already tracks, rather than a second availability engine. A character with no note is available.
- A trailing **"+ N flex"** row when the battle size (3 for 3v3, 5 for 5v5; fleet and other formats show no flex row) exceeds the number of explicitly listed required-plus-recommended members. No flex row appears when the explicit count meets or exceeds the battle size — including when catalogue data is overspecified, which is treated as malformed and never produces a negative count.

**Scope.** The engine runs against every unlocked territory, squad and fleet alike; each team draws candidates from its own catalogue and the shared ownership, used-state and exclusivity logic applies uniformly.

**Relationship to Battle Order.** A separate pass orders the resulting battles (see [§6.11](#611-battle-order)); it never changes which counter goes to which team.

### 6.9 Points to Win

This feature answers "how many banners do I still need to win, and can I get there?" from the current match state. It sits beneath banner tracking on the Round screen and is built on two layers: a data-driven scoring engine and a plain-language verdict.

**Scoring engine.** All banner values are read from the scoring rules through a single `scoreRule` lookup, keyed by rule, battle type, and mode, with `ANY` as a wildcard and the most specific matching row winning. A **side-agnostic board walker** totals the theoretical maximum banners still bankable from either board — the ceiling if every remaining team is cleared perfectly. For every uncleared team it adds the clean-win best case, and for every territory still holding an uncleared team it adds the clear bonus (base plus per-team). Every slot counts, named or not, and back territories are included because a full remaining ceiling assumes the front is cleared first. Opponent Board therefore yields the player's remaining maximum; My Board yields the opponent's. The lock gate still governs Opponent Board rendering, allocation and Battle Order, not scoring.

**Battle best case.** A clean win means every own unit survives at full health and protection and every enemy is defeated. It banks victory, the attempt bonus, one surviving, full-health and full-protection bonus per own unit, and one defeated-enemy bonus per enemy unit. The attempt bonus is chosen from the relevant board team's Battles count (see [§6.7](#67-round-boards)) — the next battle is treated as the first, second, or third-plus attempt accordingly; a third-plus win carries no attempt bonus. Unit counts come from a **two-count model**: how many of the attacker's own units earn per-unit bonuses, and how many defending units are defeated. They are sourced independently from the `OWN_UNITS` / `ENEMY_UNITS` scoring rows (see [§4.1](#41-catalogue-structure)), with in-app fallbacks of 5 (5v5) and 3 (3v3); fleet uses the authored count of 7.

The best case assumes a full squad. A deliberately empty eligible slot earns the unused-slot bonus instead of that unit's three per-unit bonuses — net +1 banner per slot under the current values — but the best case never assumes undersizing; the undersize display surfaces it as advice (see [§6.8](#68-allocation-engine)), and the Last Battle advisor weighs it for the final battle (see [§6.13](#613-last-battle-advisor)).

**Verdict.** Points-to-win remains `(opponent current + 1) − own current`: the immediate banners required to move ahead of the live opponent total. It is compared with the player's remaining maximum and recomputes while scores are typed. The adjacent two-sided range and outcome verdict supply the opponent-projection context rather than treating their current score as static.

**Banners needed.** A collapsed **Banners needed** disclosure beneath the verdict splits the board-calculated remaining figure into clean battles, territory clears and any first-attack bonus, and points to the Last Battle advisor. It never treats a particular battle as the final one.

**First-attack bonus.** The walker's `firstAttackAvailable` option is supplied from the derived opening-battle state (see [§6.12](#612-first-attack)), so the one-off bonus is counted while it is still winnable and drops out once spent.

**Fleet slot model.** The 7 fleet `OWN_UNITS` are the 3 starting slots and the 4 reinforcement slots; the capital ship earns no per-unit banners. The 4th reinforcement slot is locked unless the attacking capital ship is 7★, and a locked slot earns nothing, so a 5★–6★ capital's full fleet is 6 scoring ships (70 on a first attempt) against 7 (73). Only an empty **unlocked reinforcement slot** is treated as confirmed to earn `UNUSED_SLOT`; an empty starting slot, and an unsummoned reinforcement, are not confirmed to score, so formations that rely on them (the top of the 73–79 ladder) are theoretical. All 7 defending slots — starting ships plus reinforcement slots, including unset, unsummoned or locked ones — count as defeated enemies, and the defending capital ship does not. The evidence for each rule is in [`CATALOGUE_SOURCE.md`](CATALOGUE_SOURCE.md#fleet-slot-rules); what remains unconfirmed is tracked in [`ROADMAP.md`](../ROADMAP.md#real-battle-scoring-validation).

**Data caveat.** Points-to-win uses full-clean-clear best cases. Squad ceilings are corroborated by published game scoring tables. Fleet battles are counted at the 7★ full-fleet best case (73 on a first attempt), which overstates a 5★–6★ capital by 3 per battle; the app does not know capital-ship stars outside the Last Battle advisor. Fleet precision is therefore a ceiling, not a guarantee: formations relying on empty starting slots or unsummoned reinforcements are unconfirmed, and any change to these rules is tracked in [`ROADMAP.md`](../ROADMAP.md#real-battle-scoring-validation) rather than decided here.

### 6.10 Can I Still Win?

This verdict compares both current-to-maximum ranges and answers what can already be proved mathematically. A win requires finishing strictly ahead; a reachable tie is not treated as a win because game tie-breaking is outside the model.

**Guaranteed win.** The player's current score is already above the opponent's maximum (opponent current plus everything still available on My Board). No remaining play can reverse the result.

**Impossible win.** The player's maximum is less than or equal to the opponent's current score. Even a perfect finish cannot produce a strictly higher total.

**Outcome depends on play.** Neither proof applies: the ranges overlap, so efficiency and clears on one or both boards still decide the round.

Marking the opponent score final collapses their range by setting calculated opponent remaining to zero without changing My Board, after which the same three-way comparison applies. The verdict recomputes live as scores are typed.

### 6.11 Battle Order

Battle Order answers "which enemy team should I attack next?" It sits at the very top of the Round screen, above the opponent board, so it is the first thing seen on entering mid-match.

**It is a scheduling pass, not an allocation change.** The allocation engine (see [§6.8](#68-allocation-engine)) has already decided which counter goes to which team, with exclusivity enforced. Battle Order only orders the resulting battles and cannot change an assignment.

Attacking hard teams first is not about preserving counters (the allocation engine already prevents burning a hard team's answer elsewhere) but about **failure recovery**: a loss or messy win spends unplanned units, which is best absorbed early. Battle Order therefore ranks by **fragility** — how likely a battle is to deviate from plan, and how costly that would be late.

**Two independent tracks.** Squad and fleet battles are ranked separately, giving up to two recommendations: the next squad battle and, once Back Top is unlocked, the next fleet battle. Ships and characters occupy disjoint unit sets, so there is no ordering interaction between the tracks.

**Candidates.** Only teams that *have* a recommendation from the allocation engine can be Next Up. A team with no catalogued counter, none owned, or none left unused is never proposed — the app does not send the player at something it has no answer for. Not-in-catalogue placeholders are excluded for the same reason.

**Ordering rule.** Within the candidate set, lexicographic, in this order:

1. **Territory — the lane rule.** While Front Bottom is on the board and uncleared, it owns the squad recommendation. Once Front Bottom is cleared the rule switches off **entirely** and every remaining unlocked squad team competes flat — Back Bottom receives no automatic priority. There is a safety valve: if nothing in Front Bottom has a counter ready, the rule stands aside and the rest of the board is considered, rather than the card reporting nothing while workable battles exist elsewhere. The fleet track has no lane rule.
2. **Threat** — the authored rating (see [§4.1](#41-catalogue-structure)), highest first. It leads deliberately so the player's explicit rating beats app inference (a zero-fallback trivial team must not outrank a Galactic Legend).
3. **Fallbacks** — fewest first. A *fallback* is a counter for this team that is owned, unused, not committed to another team in the plan, and not requiring a unit the plan has already spent. It measures what is left if the recommended play fails, not the catalogued counter count, and shrinks live as counters are marked used.
4. **Tier** — **worst** first (a C-tier pick is the least certain battle, so most worth de-risking early). This is the one place a worse tier sorts higher.
5. **Undersize-adjusted banner score** (plain banner score on the fleet track) — highest first, as a final tiebreak between otherwise equal battles, then board position for determinism so an evenly-matched board does not flicker between equals on re-render.

**The reason line.** Each recommendation carries a one-line reason naming the factor that **actually decided** the pick, found by comparing the winner against the runner-up on each key in turn. When the lane rule excluded candidates from other territories the line is prefixed to say so; if every squad candidate was in Front Bottom anyway the prefix is omitted.

**Display.** A **Next Up** card at the top of the Round screen, one row per track, naming the territory and enemy team, the recommended counter with tier badge and expected banners, the undersize payoff line where applicable, and the reason. Tapping a row scrolls to that team, flashes it once and leaves it highlighted. The card has **no Mark used button** (that action lives on the team card) and shows only the head of each queue.

**Empty states.** With no teams picked, the card invites the player to populate the board; with teams picked but nothing playable, it says so and points at the per-team notes.

**Re-solve model.** Computed live on every Round-screen render and never persisted.

**One exception.** The rule above governs every battle of the round except the first, for which the objective inverts — see [§6.12](#612-first-attack).

### 6.12 First Attack

The round's **opening battle** is the one exception to the fragility ordering in [§6.11](#611-battle-order): the objective inverts to **"which battle am I most certain to win cleanly"**. After that battle the standard rule resumes.

**Why.** The one-off `FIRST_ATTACK` bonus is spent by the first battle whatever its outcome and does not carry over, so a failure there costs something later re-planning cannot recover. The price is delaying the most fragile battle by one.



**Squad only.** Back Top is locked until Front Top is cleared, and clearing a territory means attacking it, so a fleet battle can never be the round's opener. The fleet track keeps the standard rule throughout.

**Opening ordering rule.** Lexicographic, best-first:

1. **Tier** — **best** first, inverted from the standard rule. Certainty is the entire objective for this battle.
2. **Front Bottom** — the lane preference sits immediately below tier, so it wins whenever reliability is level. The player never leaves the lane for banners, only for certainty. Note this is a **ranking key here, not the gate** it is in the standard rule: if the only reliable answers sit in Front Top, the opener goes there. This is what makes the "everything in Front Bottom is hard" case fall out of the ranking rather than needing a threshold rule of its own.
3. **Banner score** — highest **full-squad** score, used as a cleanliness proxy: a low expected score means shed units and a likely cleanup team, which is precisely the outcome that costs the bonus.
4. **Threat** — **lowest** first, again inverted; the easiest defence wins.
5. Board position, for determinism.

**Undersizing is suppressed.** The opener ranks on the plain full-squad score and the card tells the player to field the full squad instead of showing drop advice. Undersize advice returns for every subsequent battle.

**Risk warning.** The card names a pick on any board, but flags when that pick puts the bonus at risk. Two independent triggers:

- **Unreliable tier** — the best available answer is only B or C. Because tier is the opening rule's *first* key, the chosen opener always carries the best tier on the board, so this is a genuine board-level statement: nothing better exists.
- **Expected messiness** — the opener is expected to shed **three or more** of the player's own units. This is derived, not hard-coded: the app computes a flawless first-attempt win for the format from the scoring rules, and the banner cost of one own unit as the sum of the per-unit survival bonuses. On the current data that resolves to a full-squad score of **56 or below in 5v5**, 48 or below in 3v3, and 64 or below in fleet. Retuning the scoring rows retunes the bar.

A counter with no authored banner score is treated as *unknown*, not messy: the messiness check is skipped and only tier can flag it.

> **Known interaction.** Because the lane preference sits above banner score, a Front Bottom answer can be chosen over a cleaner same-tier answer elsewhere and then warn for messiness. The messiness warning is therefore worded about *the pick*, the tier warning about the board.

**Detecting the opening state.** Derived from board and used-team state, never stored — there is no "first attack spent" flag to keep in sync and no way for one to drift from reality. Three independent signals, any one of which means an attack has happened:

- a counter has been marked used — the units are spent, so a battle was fought (or forfeited, which spends the bonus just the same);
- a team's Battles count is above zero — the in-game counter has moved;
- a team is marked cleared — a team cannot be cleared without attacking it, and this catches the case where a team is cleared without touching its stepper.

The test is **live, not sticky**: correcting a mis-tapped Battles count to zero restores the opening state. The standalone **Mark used** button has no undo (outside the brief window in [§6.7](#67-round-boards)), so that signal is one-way for the round. Undoing a **Used + Cleared** tap within its window reverts both signals it set together.

The same derived state supplies the first-attack bonus to the banner calculation (see [§6.3](#63-banner-tracking)), so the two can never disagree about whether the opening battle has been fought.

**Display.** The Next Up card retitles to **⚡ FIRST ATTACK** and switches to amber for this battle, then reverts. The row adds a note that the bonus is paid once and to play full squad, plus the risk warning where it applies. Empty states keep the ordinary title.

### 6.13 Last Battle Advisor

When exactly one Opponent Board defence is uncleared — whatever its territory, squad or fleet, and whether or not an identity was picked — a **🏁 Last Battle** card leads Opponent Board, above Next Up. It turns the score target into the banners that one battle must bank and the end-of-battle conditions that bank them, as far as the scoring evidence supports. It is purely advisory: it is derived on every render and never persisted, never changes the board or scores, and never marks a counter used or picks an attacker. It disappears when the board has more or fewer uncleared defences, on My Board, and after Reset Round.

**Target.** `targetToBeat = max(0, opponent + 1 − own)`, so a tie is never a win. Clearing the last defence also banks its territory-clear bonus (base plus per-team for every team in that territory, by format), plus `FIRST_ATTACK` while still genuinely available ([§6.12](#612-first-attack)). These are shown separately and subtracted once to give the **battle target**. They are never assumed to be already in the entered score. The card names the territory, defence, format (5v5 / 3v3 / Fleet), attempt number and whether the opponent score is **final** or only **current**. Against a current score it says the target may rise, and "ahead" is stated as ahead of their current or final score.

**Verdicts.** Ahead already; any win passes (the clear bonus alone covers the target, or the target is within the lowest possible winning score); needs N battle banners (within the confirmed ceiling in the worst case); may not be reachable (cleanup ranges, unknown capital-ship stars, or only via formations not confirmed to score); or can't pass even with a perfect battle. "Can't pass" is only stated above the theoretical maximum, so an unconfirmed fleet formation can make a target uncertain but never falsely impossible.

**Conditions.** The card states, only where the maths supports it, how much a full squad or fleet can afford to lose: units at the summed per-unit cost, or missing health/protection bonuses. It also says when a flawless full squad is required, or how short a full squad falls. When a full squad cannot comfortably reach the target, it shows the smallest undersized formation with slack, using the net +1 per deliberately empty slot; for a fleet only formations whose empty slots are unlocked reinforcement slots are suggested. It names the available catalogued counters whose authored `undersize` covers that drop, or labels the route **unverified** when none does. It never composes a reduced line-up. It says when a loss would leave the next attempt unable to reach the target. The recommended counter's `bannerScore` is shown as an estimate, shifted for the attempt, not a guarantee. A collapsed **Breakdown and counter options** disclosure lists the ceiling by units fielded (by empty slots for a fleet; undersized rows marked "maths only", fleet rows needing empty starting slots marked unconfirmed) and the available catalogued counters with their estimates and documented drops.

**Cleanup attempts.** Battles above zero do not say which enemies earlier battles defeated, so enemy-defeat banners are shown as a range (1 to the full defence) rather than assumed.

**Fleet.** A fleet last battle applies the fleet slot model ([§6.9](#69-points-to-win)) and asks one question on the card: **Your capital ship** — 7★, 5★–6★ or Not sure (the default). The answer is in-memory only, never persisted, and cleared by Reset Round. With **Not sure** every ceiling is a range across 6 and 7 scoring ships, allowances use the worst case, and catalogued fleet `undersize` is not added to counter estimates. With the stars known the ceilings are exact for confirmed formations; documented drops count up to the unlocked reinforcement slots (4 at 7★, 3 at 5★–6★), and a 5★–6★ estimate drops by the locked slot's per-unit banners, since fleet `bannerScore` assumes a 7★ full fleet. A note says the figures assume every reinforcement brought is called in and that empty starting slots and unsummoned ships are not confirmed to score.

**Cannot calculate.** A missing scoring rule or an invalid score shows **Cannot calculate precisely** with the reason, never a confident zero.

**Refresh.** Score typing updates the card in place without re-rendering the score field, so input focus is kept. The final-score marker, Battles, Cleared, Used + Cleared / Used + Lost, Undo and Reset Round all re-render it. The only UI state kept, in memory, is whether the disclosure is open and the fleet capital-ship answer; choosing an answer refreshes the card in place.

---

## 7. Roster Model

Ownership is tracked at unit level only, as a binary "owned / not owned". Relics, gear, zetas, omicrons, mods, and GP are **not** modelled, even though the import source exposes them — only unit presence is consumed. Characters, ships, and capital ships are all imported and shown; capital ships are visually distinguished by a badge on the roster.

**Availability rule.** A counter is available when all of its required units are owned. Recommended units do not affect availability. This holds identically for fleet counters, whose required units are ships.

**Identity and mapping.** The internal key is `Character_ID`. Imported rosters arrive as SWGOH unit base IDs returned through Comlink and are translated to `Character_ID`s via the `External_ID` adapter column, through a base-ID → Character_ID reverse index built on load. The index carries each unit's `unitType`, so import can classify characters, ships, and capital ships and count them separately. Unmapped units are reported as "not in the app's database yet" and not stored.

**Persistence.** Ownership is held in `localStorage` and keyed on `Character_ID` for all unit types. It persists across launches but is device- and browser-specific, with no cross-device sync. See [§3.4](#34-state--persistence).

---

## 8. Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Populate their roster in one step by importing from their account, including ships.
3. Set up the opponent's board at the start of a round in one pass.
4. See recommended counters for every visible opponent team at once — squad and fleet — with clear reasoning when the same counter is contested across teams.
5. Know which battle to fight next, and why, without weighing the board up by hand.
6. Mark counters used as the round progresses and watch the recommendations and the battle order re-solve automatically.
7. Track both live scores, both current-to-maximum ranges, and the guaranteed/dependent/impossible outcome on the same screen.
8. Complete an entire GAC attack phase, character and fleet, without external notes, spreadsheets, or websites.

---

## 9. Product Direction

SWGOH GAC Helper should remain a roster-aware GAC planning assistant focused on fast, practical decisions during a live round. It should integrate counter selection, cross-team allocation, banner awareness, mathematical winnability, and battle sequencing without attempting to reproduce the full depth of SWGOH.gg.

The product should continue to prioritise simplicity, speed, maintainability, and useful decision support over feature breadth. Forward-looking product ideas and planned work are tracked in [`ROADMAP.md`](../ROADMAP.md).
