# SWGOH GAC Helper — Roadmap

**Scope.** This document contains forward-looking product ideas and planned work only. It must not document functionality that has already shipped, current system behaviour in detail, release history, or scoring methodology. Current system behaviour belongs in `docs/SPEC.md`; release history belongs in `changelog.md`; scoring authoring guidance belongs in `docs/SCORING_REFERENCE.md`.

Items may be **Planned**, **Candidate**, **Deferred**, **Research**, or **Future / conditional**. When an item ships, remove it from this roadmap: document the resulting current behaviour in `docs/SPEC.md` and record the release in `changelog.md`.

## Planned

### My Board — opponent's remaining offence

*Planned, seam-ready*

Points-to-win currently models only the player's own remaining offence; the opponent's score is hand-entered and static. My Board adds a second board representing the player's own defence, so the same side-agnostic walker can project the opponent's best-case remaining banners against it and turn points-to-win into a full two-sided prediction. The v2.6 engine was built for this: the walker takes any board, the Battles/attempts count lives generically on a board team, and the banner model reserves room for an opponent-remaining figure — so this is additive, not a rework. Would also add a **Setting Defence** scoring row (banked at round start against the player's own defence).

### Per-battle undersize advisor

*Planned*

v2.9 makes the engine *choose* undersized counters when they bank more; the remaining piece is a per-battle "field exactly N units for maximum banners" recommendation that accounts for what the player can safely win with in a *specific* battle, rather than the per-counter safe-drop count the catalogue holds today. The banner arithmetic is settled (the wiki fleet ladder confirmed +1 per unit dropped end to end); what remains is a per-situation winnability judgement finer than the single `Undersize` number per counter — likely dependent on opponent-roster or outcome data the app does not yet hold.

## Candidates

### Threat as a board-wide display attribute

*Candidate*

`Threat` is currently consumed only by Battle Order and surfaced only in the Next Up reason line. A small extension would show it on the opponent board itself — a badge on each team card — so the player can see the shape of the board at a glance rather than one battle at a time. Deliberately held back from v3.0 to keep the first release of the rating focused on the decision it was introduced for, and because board cards are already dense.

### Pilot difficulty — manual-play effort

*Candidate*

An orthogonal attribute capturing how much manual effort a counter needs (e.g. auto-able vs must-play-manually), for the "I need to get my battles done" moment. It is deliberately **not a ranking input** — folding effort into the engine's objective would corrupt the win/banner goal by silently down-ranking strong-but-fiddly counters. Instead it would be *displayed* (a card indicator) and/or drive a *filter* ("auto-able only", reusing the existing available-counters filter idiom), narrowing the candidate pool by the player's effort budget while leaving the ranking untouched. It is a structured, machine-usable layer that *complements* rather than replaces the free-text `Notes` column, which already carries specific manual-play instructions (e.g. "play Jabba manually so auto doesn't waste the insta-kill on Leia"). A small, self-contained future feature: one sheet column, one Apps Script field, a display line and/or a filter toggle.

## Deferred

### Phase-aware battle ordering

*Deferred, pending real-play feedback*

The v3.0 rule is deliberately a single consistent ordering: attack the most fragile battles first, because that is right when there is still time and bench to absorb a failure. Late in a round, when chasing a specific margin against a known opponent score, the opposite may be preferable — bank the certain wins first and accept that the risky battle may not get fought at all. v3.1 establishes the shape such a rule would take — a named phase with its own inverted objective, entered and left on derived state — so this would extend an existing pattern rather than introduce one. Making the order shift as the round progresses was considered for v3.0 and deferred rather than guessed at, on the grounds that the phase boundary (what counts as "late") is exactly the thing real matches will reveal and speculation will not. The inputs it would need — remaining banners, points to win, and the winnability verdict — are all already computed on the same screen, so this is an ordering change rather than new machinery.

### Option B — Banners-first allocation scoring

*Deferred alternative*

The v2.1 allocation engine uses coverage → tier → banner score as its lexicographic objective (Option A). A possible iteration is Option B: maximise total expected banners across the plan directly, letting coverage fall out naturally (an uncovered team contributes zero). This would produce subtler assignments — e.g. accepting a slightly weaker cover on one team to leave a stronger counter free for a harder one — at the cost of the current explicit "cover as many teams as possible" behaviour. Deferred until real-play feedback indicates whether the coverage-first heuristic produces visibly wasteful assignments; if it does, this is the intended iteration.

## Research

### Live GAC board import

*Research spike*

Whether Comlink or any accessible read-only endpoint exposes live GAC board/match state, at no ongoing cost, so that the opponent board could be populated automatically rather than by hand. A short spike using the existing Comlink instance can establish feasibility without commitment. Only pursued if feasible under the zero-cost constraint.

## Future / conditional

### Distribution & Scale

*Future / conditional*

Considered only as usage grows from personal → closed group → potential public. Candidate change is migrating the roster proxy from Apps Script to a dedicated serverless function (e.g. Cloudflare Workers) with response caching. Explicit trigger criteria: Apps Script `UrlFetch` quota pressure, sustained import latency harming the mid-match experience, a need for multi-user response caching and per-source rate-limit handling, or wanting a custom domain. This is a proxy swap, not an architectural rewrite; the PWA and data model are unaffected. App-store presence, if ever pursued, would wrap the existing PWA rather than replace it.
