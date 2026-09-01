# SWGOH GAC Helper

A lightweight mobile-first GAC assistant for Star Wars Galaxy of Heroes.

**Scope.** This README is the project entry point only: a short product summary, current headline capabilities, the live-app link, and links to the authoritative documentation. It must not contain detailed system behaviour, release history, roadmap items, or scoring methodology.

**Update this document when** the headline capabilities, live-app link, or authoritative documentation set changes. Do not add implementation detail that belongs in the specialist documents below.

## Current Features

- Counter lookup for 5v5, 3v3, and Fleet
- Roster import and ownership-aware counter availability
- Used-team and spent-unit tracking
- Paired Opponent Board and My Board tracking with reusable defence templates
- Cross-team counter allocation and battle-order recommendations
- Two-sided banner ranges, points-to-win, and mathematical round outcomes
- Google Sheets-backed game data
- Installable PWA with cache-first operation

## Live App

https://nimbrethil81.github.io/gac-helper/

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — authoritative specification of the current system, architecture, data model, and behaviour.
- [`ROADMAP.md`](ROADMAP.md) — forward-looking product ideas and planned, candidate, deferred, research, or conditional work.
- [`docs/SCORING_REFERENCE.md`](docs/SCORING_REFERENCE.md) — scoring maths and authoring guidance for banner and undersize data.
- [`changelog.md`](changelog.md) — concise release history and record of what changed.
