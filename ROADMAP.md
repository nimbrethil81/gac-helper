# SWGOH GAC Helper — Roadmap

**Scope.** This document contains forward-looking product ideas and planned work only. It must not document functionality that has already shipped, current system behaviour in detail, release history, or scoring methodology. Current system behaviour belongs in `docs/SPEC.md`; release history is retrievable from Git history and GitHub work records; scoring-data authoring guidance belongs in `docs/CATALOGUE_SOURCE.md`.

**Update this document when** future work is added, reprioritised, deferred, abandoned, or ships. Items may be **Planned**, **Candidate**, **Deferred**, **Research**, or **Future / conditional**. When an item ships, remove it from this roadmap: document the resulting current behaviour in `docs/SPEC.md`.

## Planned

### Per-battle undersize advisor

*Planned*

The current allocation engine can choose undersized counters when they bank more; the remaining piece is a per-battle "field exactly N units for maximum banners" recommendation that accounts for what the player can safely win with in a *specific* battle, rather than the per-counter safe-drop count the catalogue holds today. The squad banner arithmetic is settled (net +1 per deliberately empty slot); fleet slot eligibility is not (see [Real-battle scoring validation](#real-battle-scoring-validation)). What remains is a per-situation winnability judgement finer than the single `Undersize` number per counter — likely dependent on opponent-roster or outcome data the app does not yet hold.

## Candidates

### Threat as a board-wide display attribute

*Candidate*

`Threat` is currently consumed only by Battle Order and surfaced only in the Next Up reason line. A small extension would show it on the opponent board itself — a badge on each team card — so the player can see the shape of the board at a glance rather than one battle at a time. The current rating is intentionally focused on the decision it supports, and board cards are already dense, so broader display should remain an explicit follow-on rather than an incidental expansion.

### Pilot difficulty — manual-play effort

*Candidate*

An orthogonal attribute capturing how much manual effort a counter needs (e.g. auto-able vs must-play-manually), for the "I need to get my battles done" moment. It is deliberately **not a ranking input** — folding effort into the engine's objective would corrupt the win/banner goal by silently down-ranking strong-but-fiddly counters. Instead it would be *displayed* (a card indicator) and/or drive a *filter* ("auto-able only", reusing the existing available-counters filter idiom), narrowing the candidate pool by the player's effort budget while leaving the ranking untouched. It is a structured, machine-usable layer that *complements* rather than replaces the free-text `Notes` column, which already carries specific manual-play instructions (e.g. "play Jabba manually so auto doesn't waste the insta-kill on Leia"). A small, self-contained future feature: one catalogue field, a display line and/or a filter toggle.

### Full-board strategic-reserve optimisation

*Candidate*

The allocation engine's strategic-reserve penalty (see [`SPEC.md`](docs/SPEC.md#68-allocation-engine)) is a mild, local ranking nudge: it makes a High-reserve counter (e.g. Darth Bane) slightly less likely to be picked ahead of a comparable alternative while any part of the board is still hidden, but it never predicts which specific hidden defence a reserved counter should be saved for, and it never reassigns counters once teams are visible. A future iteration could use the *fully revealed* board to solve for the globally best allocation across all defences at once — potentially recommending that an already-used-elsewhere counter should have gone to a different team, or confirming a reserved counter's eventual assignment — but that is a materially larger optimisation problem than today's per-render greedy/branch-and-bound solve and is deliberately out of scope until real-play feedback shows the local nudge is insufficient.

### First Attack lane-priority review

*Candidate*

The current First Attack ordering places the Front Bottom preference above banner cleanliness once tier is equal. This can select a messier opener over a cleaner same-tier battle elsewhere and then warn that the selected opener is messy. Review real-round behaviour to decide whether lane preference should remain above banner score or move below it.

## Deferred

### Retire the frozen catalogue Sheet and Apps Script `action=data`

*Deferred until the live Git-native catalogue has been validated in use (owner decision, 2026-10-10)*

The app no longer reads the Google Sheet or Apps Script `action=data`. Both are kept frozen and unedited only as the cutover rollback route ([`docs/CATALOGUE_SOURCE.md`](docs/CATALOGUE_SOURCE.md#cutover)).

**Retire them only after** the owner has completed live validation:
- iPhone Safari and the installed Home Screen PWA (first launch on v3.6, repeat launch, offline launch);
- at least one real GAC round played on the static catalogue.

**When retiring:**
- Once they are retired, the reverted app can no longer load a catalogue, so the only rollback is a forward fix through `catalogue/source/`.
- `action=data` can be removed, and the Sheet archived or made read-only.
- The Apps Script deployment itself stays: the app still uses it for `action=roster`.
- Update the rollback guidance in `CATALOGUE_SOURCE.md` and the backend description in `SPEC.md` in the same change.
- The `catalogueCache:v1` copy that the app keeps for rollback could then also be dropped. That is a separate app change.

### Phase-aware battle ordering

*Deferred, pending real-play feedback*

The current Battle Order rule deliberately uses one consistent objective after the opening battle: attack the most fragile battles first, because that is appropriate while there is still time and bench depth to absorb a failure. Late in a round, when chasing a specific margin against a known opponent score, the opposite may be preferable — bank the certain wins first and accept that the risky battle may not get fought at all. First Attack already demonstrates the shape such a rule could take: a named phase with its own objective, entered and left from derived state. The unresolved question is the phase boundary — what counts as "late" — and that should be informed by real matches rather than guessed at. The inputs it would need — remaining banners, points to win, and the winnability verdict — are already computed on the same screen, so this is an ordering change rather than new machinery.

### Option B — Banners-first allocation scoring

*Deferred alternative*

The current allocation engine uses coverage → tier → banner score as its lexicographic objective (Option A). A possible iteration is Option B: maximise total expected banners across the plan directly, letting coverage fall out naturally (an uncovered team contributes zero). This would produce subtler assignments — e.g. accepting a slightly weaker cover on one team to leave a stronger counter free for a harder one — at the cost of the current explicit "cover as many teams as possible" behaviour. Deferred until real-play feedback indicates whether the coverage-first heuristic produces visibly wasteful assignments; if it does, this is the intended iteration.

## Research

### Live GAC board import

*Research spike*

Whether Comlink or any accessible read-only endpoint exposes live GAC board/match state, at no ongoing cost, so that the opponent board could be populated automatically rather than by hand. A short spike using the existing Comlink instance can establish feasibility without commitment. Only pursued if feasible under the zero-cost constraint.

### Real-battle scoring validation

*Research — precise Fleet tactical guidance is blocked pending this evidence*

Squad scoring is adequately evidenced for precise guidance: the per-battle values, the 5v5 (65 full squad, 69 solo) and 3v3 (57 full squad, 59 solo) ceilings and the territory-clear bonuses match the [swgoh.wiki Grand Arena Championships](https://swgoh.wiki/wiki/Grand_Arena_Championships) banner tables (page last edited 13 April 2025, accessed 11 October 2026), and an EA community manager confirmed 69 as the 5v5 solo maximum ([devtrackers.gg, 2021](https://devtrackers.gg/swgoh/p/1f896cbc-new-gac-attack-points-scoring-incorrect-in-game)). These are pinned in `tests/scoring-rules.test.js`.

Fleet is not. The wiki's Fleet table counts **7** scoring members (73 full, 79 solo), which the authored `OWN_UNITS` / `ENEMY_UNITS` = 7 rows mirror, but the evidence conflicts on what those 7 are:

- A fleet line-up is a capital ship, starting ships and reinforcements, and reinforcement capacity depends on the capital ship's star level ([devtrackers.gg, 2020](https://devtrackers.gg/swgoh/p/64267b90-players-can-set-extra-reinforcements-in-fleet-battles-in-grand-arena): 4 reinforcements with a 5★ capital ship in Grand Arena). Whether the maximum line-up is 7 or 8 ships, and whether the capital ship is one of the 7 scoring members, is unconfirmed.
- An EA support reply (2020-era forum thread, seen only as a search excerpt; the page returned 403) says a locked reinforcement slot earns **no** unused-slot banners, and the same thread quotes an older 72-point fleet maximum that predates the defeated-enemy bonus.
- The 2021 community-manager confirmation covers squads only; the post explicitly left fleet unused reinforcements and the capital ship unresolved.

Until a real GAC fleet battle (or a current official source) settles them, treat these as unknown: the scoring member count by capital / starting / reinforcement slot; which empty slots earn `UNUSED_SLOT` (locked vs available reinforcements, starting slots); and whether a reduced fleet's maximum is reachable. The 73 / 79 figures are **theoretical ceilings only**. Points-to-win and the whole-board ceiling use the full-clean-clear best case, so they remain indicative for fleet. Record the battle evidence (line-up, capital-ship stars, slots used, banner breakdown screenshot) before changing `scoring.json` or relying on fleet values for per-battle tactical advice.

## Future / conditional

### Cloud-backed roster data

*Future / conditional*

Consider account-specific cloud roster data — such as relics, omicrons and notes — only if the current local, binary owned/not-owned model becomes too limiting. The existing `Roster` sheet tab is not consumed by the app today.

### GAC match history

*Future / conditional*

Consider storing match results and historical GAC data if retrospective analysis becomes useful. The existing `GAC History` sheet tab is not consumed by the app today.

### Mode-specific counter composition

*Future / conditional*

Counter composition is currently shared between 5v5 and 3v3. If a counter needs a genuinely different required core by squad format, extend `Counter_Composition` with a mode dimension rather than duplicating the wider counter model.

### Distribution & Scale

*Future / conditional*

Considered only as usage grows from personal → closed group → potential public. Candidate change is migrating the roster proxy from Apps Script to a dedicated serverless function (e.g. Cloudflare Workers) with response caching. Explicit trigger criteria: Apps Script `UrlFetch` quota pressure, sustained import latency harming the mid-match experience, a need for multi-user response caching and per-source rate-limit handling, or wanting a custom domain. This is a proxy swap, not an architectural rewrite; the PWA and data model are unaffected. App-store presence, if ever pursued, would wrap the existing PWA rather than replace it.
