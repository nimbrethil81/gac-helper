# SWGOH GAC Helper — Agent Instructions

This file is the entry point for AI coding agents. Keep it short: authoritative project knowledge lives in the documents below.

## Before making changes

Read the documentation relevant to the task:

- `docs/SPEC.md` — authoritative **current system**: architecture, data model, API, persistence, behaviour and current design decisions.
- `ROADMAP.md` — **future work only**: planned, candidate, deferred, research and conditional items.
- `docs/SCORING_REFERENCE.md` — authoritative **scoring maths and scoring-data authoring guidance**.
- `changelog.md` — concise **shipped release history**.
- `README.md` — project entry point and headline capabilities only.

For any change to existing behaviour, read `docs/SPEC.md` first.  
For scoring work, also read `docs/SCORING_REFERENCE.md`.  
For proposed features, check `ROADMAP.md`.

## Documentation rules

Follow the scope and **Update this document when** instructions at the top of each document.

Keep one authoritative home for each fact; cross-link rather than duplicate.

In particular:

- SPEC describes **how the shipped system works now**, not release history or future plans.
- ROADMAP describes **future work**, not shipped functionality.
- SCORING_REFERENCE owns **scoring maths and authoring guidance**, not general app behaviour.
- changelog records **what changed when a release ships**, not unreleased work.
- README stays a **brief entry point**.

When roadmap work ships, remove it from ROADMAP, describe the resulting behaviour in SPEC, and record the release in the changelog.

## Repository workflow

`AGENTS.md` is the single authority for the standard Git workflow. Agent-authored repository changes follow this default unless a task explicitly overrides it:

1. Create a dedicated branch from current `main`.
2. Make and validate the scoped changes.
3. Commit and push the branch.
4. Open a pull request targeting `main`.
5. The owner reviews and merges the pull request.
6. An agent must not merge its own pull request unless the owner explicitly instructs it to do so.

Pushing a branch or merging into `main` does **not** deploy the public application. Production deployment is a separate, manually triggered `Deploy Pages Live` GitHub Action. It builds an allow-listed Pages artifact from `main` and deploys that artifact to GitHub Pages. No agent may trigger production deployment unless a task explicitly authorises it.

## Development rules

- Keep changes small and task-focused.
- Preserve the existing plain HTML/CSS/JavaScript PWA architecture unless explicitly asked to change it.
- Reuse existing patterns before introducing new abstractions or dependencies.
- Do not invent sheet columns, IDs, scoring values, API behaviour or persistence rules.
- Do not silently change API contracts or persisted schemas; handle compatibility deliberately.
- Preserve mobile-first and cache/offline behaviour.
- Do not trigger `Deploy Pages Live` unless explicitly asked.
- Keep internal documentation, tests, Apps Script and paused architecture assets outside the live Pages artifact unless explicitly asked.

## Before finishing

Review the diff and verify:

1. The change is limited to the requested scope.
2. Current behaviour still matches `docs/SPEC.md`, updating it if necessary.
3. Scoring changes are reflected in `docs/SCORING_REFERENCE.md` where necessary.
4. Future work is reflected in `ROADMAP.md`, not SPEC or changelog.
5. Shipped release changes are recorded concisely in `changelog.md`.
6. README is updated only if headline capabilities or documentation navigation changed.
7. No information has been unnecessarily duplicated across documents.

Do not claim tests or validation were performed unless they actually were.
