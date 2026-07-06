# Changelog
## v1.0
- Initial PWA
- Google Sheets integration
## v1.1
- Active 5v5 / 3v3 mode highlighting
## v1.2
- Tier colour coding
## v1.3
- Sorting
## v1.4
- Reset round
- Search bar
- More colour coding
## v1.5
- Roster import foundations
## v1.6
- Manual roster
## v1.65
- Banner tracking (manual score, opponent score, remaining, projected final)
## v1.7
- Slimmed header (subtitle removed, single-line)
- Available counters filter — "Show available only" toggle above results
- Unavailable counters collapse to a tappable count line when filter is on
- Toggle state persists across sessions (localStorage)
- Toggle disabled with hint when roster is empty
- Empty-result state when no available counters exist for selected team
## v1.8
- Tri-state counter status: Available / Used / Not owned
- Three-segment filter: [All] [Owned] [Available]
- Counters sorted by status group (Available → Used → Not owned), then tier and banner score
- Ownership vocabulary: "Owned / Not owned" replaces "Available / Unavailable"
- CURRENT ROUND card: Reset Round moved inline
## v1.9
- Roster persistence hardening: versioned storage schema `{schema, savedAt, source, owned}`,
  single `loadRoster()` / `saveRoster()` path, one-time migration from pre-v1.9 bare array
- Defensive roster re-read on every entry to the Roster screen
- "Last saved" indicator on Roster screen (date, time, source)
- Export roster to clipboard (with select-to-copy fallback)
- Import roster: paste JSON, validate before mutating, replace semantics,
  lenient-reported (imported / skipped counts), Undo import for session rollback
- `applyRoster(owned, source)` shared entry point — v2.0 API import reuses this
- Best-effort `navigator.storage.persist()` request to reduce OS eviction
- Collapsible "Manage roster data" panel (Export / Import / Undo / Clear roster)
- Clear Roster moved from header into panel — destructive action, rare in SWGOH
- Roster loss reproduced under Safari Private Browsing (expected ephemeral-storage behaviour);
  normal browsing retains storage; persist() remains as best-effort eviction resistance for
  the non-private cases.
  (Note: this supersedes an earlier provisional v1.9 attribution to iOS WebKit app-switcher
  eviction, which was a misdiagnosis. The reproducible cause is Safari Private Browsing's
  ephemeral storage, which persist() cannot prevent by design.)
## v2.0
- Roster import from SWGOH.gg: enter a 9-digit ally code to populate ownership directly
  from your account. Manual toggling and paste-JSON import remain as fallbacks.
- Apps Script extended with an `action` router: default `action=data` returns the unchanged
  counter payload; `action=roster&allyCode=…` is a thin server-side proxy to the swgoh.gg
  player endpoint, returning `{ ok, allyCode, syncedAt, ownedBaseIds }` (base_ids only).
- `External_ID` adapter column added to `Character_Definitions`; `characterDefinitions` now
  carries `externalId`. The client builds a base_id → Character_ID reverse index and maps
  imported units locally, keeping `Character_ID` as the stable internal key (the sheet
  remains the single source of truth for the mapping).
- Roster schema bumped to v2 `{schema, savedAt, source, allyCode, syncedAt, owned}` with a
  v1 → v2 migration. `syncedAt` (last successful API return) is tracked separately from
  `savedAt` (last local write of any kind).
- Cache-first architecture: localStorage is the working store and the API is a refresh
  mechanism, not a dependency. The app renders from cache instantly on boot and is fully
  functional on cached data alone.
- Staleness-gated background sync: an API roster refreshes silently on boot only if `syncedAt`
  is older than 12 hours, never while the Roster screen is open (never mid-edit), and applies
  only if the owned set actually changed (with an Undo snapshot when it does).
- Source-aware freshness line: API rosters show "Last synced from SWGOH.gg: …", manual
  rosters show "Last saved: …".
- First-run import card promoted on the Roster screen when the roster is empty; becomes a
  "Refresh from SWGOH.gg" control once an ally code is associated.
- Import reporting split into three buckets: characters imported, ships recognised but not yet
  supported (silent — fleet is v2.5), and units not yet in the app's database.
- Import pipeline written unit-type-parameterised, defaulting to characters only, so fleet
  support (v2.5) is a flag-flip plus roster/UI work rather than a re-architecture.
- Foreground import/refresh: ally-code validation, offline guard, 15s timeout
  (`ROSTER_FETCH_TIMEOUT_MS`), per-case error copy (invalid code, not-found-on-swgoh.gg,
  rate-limited, timeout, offline), confirm-before-overwrite, and Undo.
- Import message + Undo moved to a top-level notice cluster on the Roster screen so results
  are visible even when the data panel is collapsed.
- Bump service-worker cache name to force fresh assets for installed users.

## v2.1 — Round Planning
- Bottom-nav "Banners" replaced by a single Round screen: round summary, opponent
  board, allocation recommendations, and banner tracking together as the live-match
  workspace. Reset Round moves here from Counters and now clears the board alongside
  used teams and banner tracking. A wayfinding line on the Counters screen points
  players to Round for round tracking.
- Opponent board (Item 1): four territories per league/mode, from the new
  GAC_Board_Config sheet tab. League is a persisted user setting; mode is frozen
  into the board at setup. Per-team `cleared` flag with a bulk "Clear territory"
  shortcut; territory-cleared state is always derived from per-team flags, never
  stored. Back Bottom locked until Front Bottom is cleared; Back Top permanently
  locked with a "fleet support arrives in v2.5" note. Teams not in the counter
  catalogue can be marked "Not in catalogue" and still tracked for cleared state.
  Board is versioned (schema 1) and hydrates before first paint like the roster.
- Allocation engine: scarcity-first ordered search with branch-and-bound pruning
  and a 50 000-node budget (greedy-equivalent fallback beyond the budget).
  Objective is coverage → tier → banner score, lexicographic. Character-level
  exclusivity enforced natively — two counters that share a required character
  never appear in the same plan, since characters used on offence are spent for
  the round. Runs against the visible-uncleared board team set only. Live-solved
  on every Round render; nothing persisted.
- Overlap notice: when two or more visible-uncleared teams share at least one
  eligible-and-owned-and-unused counter, an explicit banner announces the switch
  to optimised recommendations.
- Per-team recommendation cards: chosen counter, tier badge, expected banners,
  a plain-language reason grounded in the plan's real alternatives, and a
  Mark-used button. Empty-state reasons cover the four distinct causes — no
  counters in the catalogue, none owned, all used, or committed elsewhere via
  a named character clash.
- Sheet: new GAC_Board_Config tab (40 rows across all league × mode combinations)
  and new GAC_Scoring tab (banner economy — sourced from swgoh.wiki, to be
  spot-checked against real battle results before Item 2 lands).
- Backend: Apps Script `action=data` payload extended with `boardConfig` and
  `scoring` keys, read by header with positional fallbacks and guarded against
  missing tabs. Fully backwards-compatible.
- Service worker: cache name bumped to `swgoh-cache-v3` in stage 2 and
  `swgoh-cache-v4` in stage 3 to force fresh assets for installed users;
  `styles.css` added to the precache list (a pre-existing gap).
- Roster import: source-neutral copy pass completed — the overwrite-confirm
  dialog no longer mentions swgoh.gg by name.
