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
- Foreground import/refresh: ally-code validation, offline guard, timeout guard
  (`ROSTER_FETCH_TIMEOUT_MS`), per-case error copy (invalid code, not-found-on-swgoh.gg,
  rate-limited, timeout, offline), confirm-before-overwrite, and Undo.
- Import message + Undo moved to a top-level notice cluster on the Roster screen so results
  are visible even when the data panel is collapsed.
- Bump service-worker cache name to force fresh assets for installed users.
- Roster data source subsequently switched from swgoh.gg to a self-hosted SWGOH Comlink
  instance (Render free tier), after swgoh.gg began returning HTTP 403 to Apps Script egress
  IPs — a hard block, not a quota issue. The response contract (`{ ok, allyCode, syncedAt,
  ownedBaseIds }`) is unchanged; `rosterUnit[].definitionId` uses `BASEID:RARITY` format,
  split on the colon to recover base_ids. Import timeout extended to 60 seconds to
  accommodate Render's cold-start latency on the first request after inactivity.
- User-facing language made source-neutral following the migration (e.g. the roster-overwrite
  confirmation no longer names swgoh.gg); internal sentinel values deliberately preserved
  unchanged to avoid breaking auto-sync eligibility on existing rosters. One instance of the
  old wording was found and corrected in v2.1 (see below).

## v2.1 — Round Planning
- Bottom-nav "Banners" replaced by a single **Round screen**: round summary, opponent board,
  allocation recommendations, and banner tracking together as the live-match workspace.
  Reset Round moves here from Counters and now clears the board alongside used teams and
  banner tracking. A wayfinding line on the Counters screen points players to Round for
  round tracking and reset.
- **Opponent board:** four territories per league/mode, generated from the new
  `GAC_Board_Config` sheet tab. League is a persisted user setting; mode is frozen into
  the board at setup from the Counters screen toggle. Per-team `cleared` flag with a bulk
  "Clear territory" shortcut; territory-cleared state is always derived from per-team flags,
  never stored separately. Back Bottom locked until Front Bottom is cleared; Back Top
  permanently locked with a "fleet support arrives in v2.5" note. Teams not in the counter
  catalogue can be marked "Not in catalogue" and still tracked for cleared state. Board is
  versioned (schema 1) and hydrates before first paint, same pattern as the roster.
- **Allocation engine:** scarcity-first ordered search with branch-and-bound pruning and a
  50,000-node budget (result is never worse than pure greedy, since the greedy path is
  explored first). Objective is coverage → tier → banner score, in that order (Option A).
  Character-level exclusivity enforced natively — two counters that share a required
  character can never appear in the same plan, since characters used on offence are spent
  for the round regardless of battle outcome. Runs against the visible-uncleared board
  team set only; fleet territory excluded. Live-solved on every Round-screen render;
  nothing about the plan is persisted.
- **Overlap notice:** when two or more visible-uncleared teams share at least one
  eligible-and-owned-and-unused counter, an explicit banner announces the switch to
  optimised, cross-team-aware recommendations.
- **Per-team recommendation cards:** chosen counter, colour-coded tier badge, expected
  banners, a plain-language reason grounded in the plan's real alternatives (e.g. "Also
  counters Great Mothers — SLKR covers that one instead"), and a "Mark used" button that
  commits the counter and triggers an immediate re-solve. Four distinct empty-state reasons
  cover no catalogue match, none owned, all used, and committed elsewhere via a named
  character clash.
- **Sheet:** new `GAC_Board_Config` tab (team counts per territory, for every league × mode
  combination) and new `GAC_Scoring` tab (the full GAC banner economy — victory, attempt,
  survival, health, protection, unused-slot, and territory-clear bonuses). Both sourced
  from the SWGOH Wiki; scoring values are earmarked for a spot-check against real battle
  results before the points-to-win calculator is built on top of them.
- **Backend:** Apps Script `action=data` payload extended with `boardConfig` and `scoring`
  keys, read by header name with positional fallbacks and guarded against missing or empty
  tabs (empty object/array rather than an error). Fully backwards-compatible — the v2.0
  frontend ignores unknown keys.
- **Service worker:** cache name bumped (`swgoh-cache-v3`, then `swgoh-cache-v4`) to force
  fresh assets for installed users across the two build stages; `styles.css` added to the
  precache list, closing a pre-existing gap where a fully offline launch would have
  rendered unstyled.
- **Copy fix:** the roster-overwrite confirmation dialog no longer names swgoh.gg by name,
  completing the source-neutral language pass that began with the Comlink migration.

## v2.5 — Fleet Support
Delivered in three phases within a single workstream; all three shipped together.

- **Roster — Characters/Ships split (Phase 1):** the Roster screen now lists units in two
  sections, **Characters** and **Ships**, with a dual owned-count ("X / Y characters ·
  A / B ships owned"). Capital ships carry a small **Capital** badge within the Ships
  section. A single search box filters both sections; sections with no matches are hidden
  while searching, with a single empty line when nothing matches. If the loaded data has no
  ship definitions (e.g. an older cached payload), the Ships section and its count are
  omitted, so the screen is unchanged until ship data is present.
- **Import widened to ships (Phase 1):** ally-code import, background sync, and paste import
  now bring in `CHARACTER`, `SHIP`, and `CAPITAL_SHIP` units together (previously ships were
  recognised but dropped). `classifyBaseIds` returns owned unit ids plus per-type counts; the
  import summary now reads "Imported X characters and Y ships from the game," retaining the
  "units not in the app's database yet" note. Export/clear copy generalised from
  "characters" to "units".
- **Counters — Fleet toggle (Phase 2):** a third **Fleet** segment joins `5v5` / `3v3`.
  A mode with no counter data (Fleet, until fleet counters are authored) shows a plain
  "no fleet counters yet" message instead of an empty dropdown. `lastSquadMode` is persisted
  whenever a squad format is selected.
- **Board setup — format safety (Phase 2, Option A):** because "Fleet" is a browsing view,
  not a whole-board format, the board setup card shows a small `5v5` / `3v3` chooser (seeded
  from `lastSquadMode`) when the Counters toggle is on Fleet, so the board always freezes a
  valid squad format. On 5v5/3v3 the format is inherited silently as before. `boardMode()`
  resolves the effective squad format; `createBoard()` freezes it into the board.
- **Round board — fleet territory (Phase 3):** **Back Top** (fleet) now unlocks once Front
  Top is cleared, mirroring Back Bottom behind Front Bottom; the "arrives in v2.5" note is
  gone. The fleet territory generates its own team rows, is marked with a 🚀 icon, and its
  pickers draw from the `FLEET` catalogue rather than the squad catalogue.
- **Allocation engine — fleet-aware (Phase 3):** the engine now runs against every unlocked
  territory including fleet. Each team draws candidates from its own catalogue (per-team
  `modeKey`); the shared ownership, used-state, and exclusivity logic is unchanged. Because
  ships and characters are disjoint unit sets, fleet and squad allocations never collide,
  while two fleet teams contesting the same owned ship are arbitrated correctly, and the
  overlap notice fires for fleets as for squads.
- **Board schema bump (1 → 2):** boards now include fleet-territory team rows. Any board
  created before this release is discarded on load and set up afresh.
- **Backend:** no Apps Script change required — the `FLEET` counters bucket falls out of the
  existing mode-keyed loop once `Mode = FLEET` rows exist. `APP_VERSION` → 2.5; service-worker
  cache bumped to v5 to force fresh assets for installed users.

## v2.6 — Points-to-Win Calculator
Board-aware, mode-aware "how many banners do I need to win" maths, built on the
GAC_Scoring data shipped in v2.1. Delivered in three phases within a single
workstream; all three shipped together.

- **Per-team Battles counter (Phase 1):** each uncleared team on the opponent board
  now carries a **Battles** count that mirrors the in-game "Battles" number beside
  every defence team — it climbs 0, 1, 2, 3… for each attempt, win or lose, with a
  −/+ stepper. The count is stored verbatim so it always matches what the game shows;
  the attempt-bonus rule (first attempt worth most, second less, third-or-later none)
  is applied by the calculation, not by clamping the display. The stepper is hidden
  once a team is cleared, its battles no longer affecting what is left to win. Board
  schema bumped 2 → 3; boards created before this release migrate in place, backfilling
  every team to zero battles rather than discarding an in-progress round.
- **Banner scoring engine (Phase 2):** a single `scoreRule` lookup over the GAC_Scoring
  rows (Battle_Type and Mode with `ANY` as a wildcard, most-specific row wins) and a
  side-agnostic board walker that totals the most banners still bankable from a board.
  Every uncleared slot in an unlocked territory counts, named or not — banner value
  depends only on battle type and mode, never on team identity, so the figure is honest
  even on a board where positions are marked but teams not yet identified. Locked back
  territories contribute nothing until their front is cleared. A two-count model (own
  units earn survival/health/protection bonuses; enemy units are the defeated-enemy
  count) lets squads (5/5, 3/3) and a full fleet (8/8) fall out of data. The walker
  accepts any board, leaving a clean seam for a future "my board".
- **Calculated remaining banners (Phase 2):** the "remaining available banners" field,
  previously hand-typed, now shows a figure calculated from the opponent board by
  default, with a caption saying so. It stays overridable — typing sets a manual override
  shown with an amber marker and a "Use calculated" link — but any change to the board
  discards the override and restores the live figure, so a stale typed value can never
  silently win. Reset Round and the empty-board state both leave the field on "calculated"
  (no override) rather than a numeric zero. Existing stored `remaining` values migrate to
  the no-override state on load.
- **Points-to-win readout (Phase 3):** a plain-language verdict beneath banner tracking.
  Points-to-win is (opponent's current score + 1) − own current score, compared against
  the best-case remaining. A crisp headline ("Points to win: X" / "Ahead by X") with an
  honest support line phrased against the opponent's *current* score — reachable (with any
  spare shown), just-enough, or short by a stated amount — and a one-time caveat that their
  score rises as they attack the player's defence. Headline is green when ahead, red when
  even a perfect finish falls short; the whole readout recomputes live as scores are typed,
  without dropping focus from the input.
- **Sheet:** GAC_Scoring gains `OWN_UNITS` and `ENEMY_UNITS` rows (SQUAD 5v5 → 5, 3v3 → 3;
  FLEET → 8 on both) as the data source for the two-count model. The app carries correct
  fallbacks for these counts, so the calculator is accurate before the rows exist; adding
  them makes the sheet the single source of truth. No Apps Script change required — the new
  rows flow through the existing `buildScoring` loop unchanged.
- **Backend:** no Apps Script change. Verified the shipped `buildScoring` emits scoring rows
  in the exact shape the engine reads (`ruleId` / `battleType` / `mode` / `value`, numeric
  values, rule and battle-type upper-cased, mode verbatim).
- **Frontend:** `APP_VERSION` → 2.6; service-worker cache bumped to `swgoh-cache-v7` to force
  fresh `app.js` and `styles.css` for installed users.
- **Data caveat:** points-to-win uses full-clean-clear best cases, consistent with the
  69-banner single-battle maximum. Fleet per-ship values and defeated-enemy counts remain
  earmarked for a real-battle spot-check before the efficiency calculator is built on them.

## v2.7 — Can-I-Win Verdict
A mathematical-winnability readout on the Round screen, answering "can I still win
this round?" so the player can decide whether to try hard on the remaining battles
or treat them as a playground for testing counters. Built entirely on the v2.6
scoring engine — no new scoring data, and no dependency on the fleet/defeated-enemy
spot-check, since it reads the same best-case remaining total the points-to-win
readout already uses. This is the first half of what was roadmapped as the
efficiency calculator; the undersize-squad optimiser is the still-outstanding half.

- **Can-I-win verdict:** beneath the points-to-win readout, a "Can I still win this
  round?" panel weighs the player's ceiling — current score plus best-case remaining
  a flawless finish could bank — against the opponent's score. Three states:
  **Can't win this round** (a flawless finish still falls short; time to experiment),
  **Already won** (current score alone is unbeatable), and **Winnable** (the
  actionable middle). Headline is colour-coded — green won, red lost, neutral
  winnable — and recomputes live as scores are typed.
- **Opponent final-score marker:** the opponent-score field gains a "Mark as their
  final score" link. Unmarked (the default), the number is their *current* score — a
  floor that may still rise — and the winnable verdict states a **breakeven** ("you
  can reach at most X; you win only if they finish on X or below") rather than
  claiming a guaranteed win. Marked final, the field relabels to "Opponent's final
  score", the points-to-win "their score will rise" caveat is suppressed, and the
  verdict gives a clean yes/no. A link reverts to treating it as a current score.
  Same override shape as the v2.6 remaining-banners field. Persisted as
  `bannerData.oppFinal`; defaults to false and is reset by Reset Round.
- **Verdict-pairing correctness:** "Can't win" compares the opponent against the
  player's *ceiling* (never their current score, so being behind now never triggers
  a false "lost"); "Already won" compares the opponent's *final* against the player's
  *current* score, and is asserted only when the opponent score is marked final. A
  lead over a not-yet-final score yields a breakeven, never a guaranteed win.
- **Frontend:** `APP_VERSION` -> 2.7; service-worker cache bumped to `swgoh-cache-v8`
  to force fresh `app.js` and `styles.css` for installed users. No Apps Script or
  sheet change.

## v2.8 — Undersize Optimiser
Surfaces undersize opportunities on the recommendation and lookup cards, so the
banner payoff of dropping units is visible during a round without any mid-match
calculation. Leans entirely on hand-authored catalogue values, so it needs no new
scoring data and does not depend on the fleet/defeated-enemy spot-check.

- **Droppable-count column:** the Counters sheet's `Undersize` column changes from
  `Yes`/`No` to a numeric **droppable-unit count** — the maximum units a counter can
  drop from a full squad and still win cleanly (`0` = full squad). Each unit dropped
  nets **+1 banner** over a full clean clear (the +4 unused-slot bonus minus the 3
  forgone surviving/full-health/full-protection bonuses), so a count of N is worth up
  to +N banners.
- **Banner-score rebasing:** the `Banner Score` column now holds the **full-squad,
  first-attempt, clean-clear** value with the undersize premium removed, so score and
  count own non-overlapping parts of a counter's value and can be added without
  double-counting. The app reconstructs the undersize total as `Banner Score` + count.
  A companion `SCORING_REFERENCE.md` documents the per-mode ceilings (5v5 → 65,
  3v3 → 57, fleet → 73) and meaning ladders used to author scores.
- **Undersize display — recommendation card:** when the allocation engine recommends
  a counter with a droppable count > 0, a new line shows the reconstructed total most
  prominently, then the drop count and bonus — e.g. "67 banners if you undersize ·
  drop up to 2 for +2". Counters with count 0 show no undersize line; the card is
  unchanged from before.
- **Undersize display — lookup card:** the counter lookup card's old "Undersize:
  Yes/No" becomes "drop up to N -> X banners (+N)", or "full squad" when the count is
  0. Both screens share one `undersizeInfo` helper so the payoff maths is defined once.
- **Backend:** the Apps Script parses the `Undersize` cell to a number
  (`parseUndersize`); any non-numeric value — a legacy `Yes`/`No` string on an
  un-migrated row, or a blank — resolves to 0. The app applies the same fallback, so a
  partially-migrated sheet is always safe: an un-migrated row simply carries no
  undersize advice rather than a wrong number, and advice appears row-by-row as the
  data is completed. A new column right of `Banner Score` needs no code change — the
  Apps Script reads the Counters tab by header name, ignoring columns it doesn't name.
- **Fleet unit-count correction:** the SWGOH Wiki "Fleet Max Banners" table confirmed
  fleet is a **7**-unit format (capital + 6), not the 8 assumed when the v2.6 two-count
  model was specced. A flawless first-attempt 7-ship win banks 73. The points-to-win
  engine's fleet fallback (`ownUnitCount` / `enemyUnitCount`) should be corrected from
  8 to 7, and the `GAC_Scoring` sheet's fleet `OWN_UNITS` / `ENEMY_UNITS` rows (if
  added) set to 7. This affects the points-to-win *fleet* best-case only; the undersize
  display and banner-score column do not depend on it.
- **Frontend:** `APP_VERSION` -> 2.8; service-worker cache bumped to `swgoh-cache-v9`
  to force fresh `app.js` and `styles.css` for installed users.
