# Changelog

**Scope.** This file records notable changes by release, with the newest release first. Entries must stay concise and describe **what changed**, not how the current system works in detail. Current behaviour belongs in `docs/SPEC.md`; scoring methodology and authoring guidance belong in `docs/SCORING_REFERENCE.md`; future work belongs in `ROADMAP.md`.

**Update this file when** a release ships with a notable user-facing, data-model, API, persistence, scoring, or implementation change worth recording. Do not add unreleased work; keep prospective changes in `ROADMAP.md` until they ship.

## v3.3 — My Board

### Added
- Added paired Opponent Board and My Board views with unified setup, defence identity tracking, opponent Battles/Cleared state, and per-format defence templates.
- Added two-sided current-to-maximum score ranges and guaranteed/dependent/impossible outcome verdicts.
- Added and validated the `SETTING_DEFENCE` scoring rule for one-time starting-score prefills.

### Changed
- Reset Round now clears both live boards while preserving 5v5 and 3v3 defence templates.
- Opponent-board persistence moved to schema 4 with additive schema-2/3 migration that preserves existing live scores.

## v3.2

### Fixed
- Counters sharing a `REQUIRED` unit with an already-used counter now become **Unavailable** across both Counter Lookup and Round recommendations.
- Allocation and Battle Order no longer recommend counters that depend on spent units.

### Changed
- Counter status and filtering now distinguish **Available**, **Used**, **Unavailable**, and **Not owned**.
- Service-worker cache version was resynchronised with the application release.

## v3.1 — First Attack

### Added
- Added a dedicated **First Attack** Battle Order mode that prioritises the safest opening battle and suppresses undersize advice for that attack.
- Added risk warnings when the best available opener is low reliability or expected to lose too many units.

### Fixed
- The one-off `FIRST_ATTACK` bonus is now included in calculated remaining banners until the first battle is fought.

## v3.0 — Battle Order

### Added
- Added the **Next Up** Battle Order recommendation to the Round screen.
- Added the `Defence_Teams` sheet data and `defenceTeams` API payload for authored enemy-team threat ratings.
- Added separate squad and fleet Battle Order tracks, with tap-to-locate highlighting on the opponent board.

## v2.9 — Undersize Optimiser (engine)

### Changed
- Allocation now ranks same-tier counters by undersize-adjusted achievable banners rather than full-squad banner score alone.
- Equal-value ties prefer the counter requiring less undersizing.
- Tier was formally defined as counter reliability, and the redundant `Reliability` column was retired.

### Fixed
- Remaining-banner calculations now include locked back territories when calculating the whole-board theoretical ceiling.

## v2.8 — Undersize Optimiser (display)

### Added
- Replaced the old Yes/No undersize flag with a numeric droppable-unit count.
- Added undersize banner advice to Counter Lookup and Round recommendation cards.
- Added `docs/SCORING_REFERENCE.md` for banner-score and undersize authoring guidance.

### Changed
- `Banner Score` was rebased to represent the full-squad, first-attempt, clean-clear value, with undersize value handled separately.
- Apps Script now parses the `Undersize` field as a numeric count.

### Fixed
- Corrected the fleet unit count used by scoring calculations from 8 to 7.

## v2.7 — Can-I-Win Verdict

### Added
- Added the **Can I still win?** mathematical-winnability verdict to the Round screen.
- Added an opponent final-score marker so the app can distinguish a current score from a completed score.

## v2.6 — Points-to-Win Calculator

### Added
- Added per-team **Battles** counts to the opponent board.
- Added a data-driven banner-scoring engine using `GAC_Scoring`.
- Added calculated remaining banners with a temporary manual override.
- Added the **Points to win** readout and reachability verdict.

### Changed
- Opponent-board persistence moved to schema 3, migrating existing boards by adding Battles counts.

## v2.5 — Fleet Support

### Added
- Added ships and capital ships to roster display, ownership and import.
- Added **Fleet** counter lookup alongside 5v5 and 3v3.
- Added the fleet territory to Round board setup, unlocking and allocation.
- Added fleet-aware counter allocation and overlap handling.

### Changed
- Board persistence moved to schema 2 to include fleet territory rows.
- Added `lastSquadMode` handling so a valid 5v5/3v3 board format is retained while browsing Fleet counters.

## v2.1 — Round Planning

### Added
- Added the unified **Round** screen for opponent-board setup, banner tracking and recommendations.
- Added league-aware opponent-board configuration through `GAC_Board_Config`.
- Added the cross-team allocation engine with counter and required-unit exclusivity.
- Added per-team recommendation cards, overlap detection and live re-solving.
- Added `GAC_Scoring` data and exposed `boardConfig` and `scoring` through the Apps Script data payload.

### Changed
- Reset Round now clears opponent-board state as well as used teams and banner tracking.
- Added `styles.css` to the PWA precache so cached offline launches remain styled.

## v2.0 — Roster Import

### Added
- Added roster import by 9-digit ally code through an Apps Script proxy.
- Added `External_ID` mapping between game base IDs and the app's internal unit IDs.
- Added source-aware roster freshness, foreground refresh, validation, error handling and Undo.
- Added cache-first roster loading with staleness-gated background refresh.

### Changed
- Roster persistence moved to schema 2 with ally-code and sync metadata.
- The roster provider was subsequently moved from SWGOH.gg to a self-hosted SWGOH Comlink instance after SWGOH.gg blocked Apps Script requests; the client-facing response contract remained unchanged.

## v1.9 — Roster Persistence & Portability

### Added
- Added versioned roster persistence with a single save/load path.
- Added roster export, validated paste import, Undo and a dedicated roster-data management panel.
- Added source and last-saved information to the Roster screen.
- Added a best-effort persistent-storage request.

### Fixed
- Established Safari Private Browsing's ephemeral storage as the cause of the reproduced roster-loss issue.

## v1.8

### Changed
- Replaced separate availability and used indicators with counter states: **Available**, **Used**, and **Not owned**.
- Added the `[All] [Owned] [Available]` filter and status-first sorting.
- Moved Reset Round into the Current Round card.

## v1.7

### Added
- Added an available-counters filter with persisted state and context-specific empty states.

### Changed
- Slimmed the application header.

## v1.65

### Added
- Added manual banner tracking for own score, opponent score, remaining banners and projected final score.

## v1.6

### Added
- Added manual roster ownership management.

## v1.5

### Added
- Added the foundations for roster-aware counter availability.

## v1.4

### Added
- Added Reset Round and defence-team search.

### Changed
- Expanded interface colour coding.

## v1.3

### Added
- Added counter sorting.

## v1.2

### Added
- Added tier colour coding.

## v1.1

### Added
- Added active highlighting for the 5v5 / 3v3 mode selector.

## v1.0

### Added
- Initial mobile-first PWA.
- Google Sheets-backed counter data.
