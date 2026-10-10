# Git-native catalogue source

**Scope.** Contributor and operator procedure for the Git-authored catalogue in `catalogue/` (issues #35 and #41–#43, [`ADR-ARCH-116`](decisions/ADR-ARCH-116-git-native-catalogue.md)): layout, fortnightly research/reconciliation, import, compile, release record, corrections, the static release on Pages, the app cutover, and rollback. The schema and payload contracts are owned by ADR-ARCH-116 §4–§7; validation rules and severities are owned by the shared audit ([`CATALOGUE_AUDIT.md`](CATALOGUE_AUDIT.md)). **The live app (v3.6, issue #43) reads the static release; [`SPEC.md`](SPEC.md) describes that runtime.** Apps Script `action=data` and the frozen Sheet are no longer read; they remain only as the cutover rollback route ([Cutover](#cutover)).

**Update this document when** the source layout, review/evidence protocol, commands, correction procedure, release/deployment procedure, budget or migration status changes.

## Layout

| Path | Role |
|---|---|
| `catalogue/source/*.json`, `catalogue/source/matchups/{5v5,3v3,FLEET}.json` | Authoring input (ADR-ARCH-116 §4): one row per line, `"schema": 1`. `units`, `counters` and matchup `defences` must stay sorted by ID/name (code-unit order). The importer also sorts defence teams and compositions by defence then mode. |
| `catalogue/release.json` | Catalogue version and canonical checksum of the compiled seven-key payload (ADR §7). CI fails if it does not match the source. |
| `catalogue/corrections/*.json` | Explicit correction lists. Historical schema 1 records migration corrections C1–C5. Current schema 2 change sets bind exact rows, compiled impact, provenance and an owner decision to one `main` commit/release baseline. |
| `catalogue/IMPORT_REPORT.md` | Generated record of the migration import: provenance, counts, checksums and parity, plus the defects carried verbatim. |

Generated delivery files (`catalogue/current.json`, `catalogue/manifest.json`, `catalogue/releases/*.json`) exist only in the Pages artifact. They are never committed and never read as input.

## Commands

```bash
npm run catalogue:compile                           # compile + shared rule set (parity gate: report only)
npm run catalogue:compile -- --gate release         # exit 1 on any blocking or owner-approval finding
npm run catalogue:compile -- --compare <action-data.json>   # exact canonical parity with a capture
npm run catalogue:release                           # record version/checksum (bumps only if the checksum changed)
npm run catalogue:release -- --check                # verify release.json (CI)
npm run catalogue:corrections -- <list.json>        # check every correction applies and what it resolves
npm run catalogue:corrections -- <list.json> --preview <id>   # complete source + compiled-payload preview
npm run catalogue:corrections -- <list.json> --apply <id>   # APPROVED corrections only
npm run catalogue:import -- <snapshot-dir>          # migration import (see below)
npm run catalogue:ledger                            # releases recorded on main; fails on a reused/decreasing version
npm run catalogue:site -- --out <dir>               # build and verify the complete Pages artifact (CI, deploy)
npm run catalogue:guard -- --site <dir> --url <pages url>        # pre-deploy live check
npm run catalogue:verify-live -- --site <dir> --url <pages url>  # post-deploy live check
npm run catalogue:restore -- --version <N>          # rollback: restore release N's source
```

The compiler, validator and release builder use only Node built-ins and `git`: no `npm ci`, database or credentials. Only `guard` and `verify-live` use the network (HTTPS to Pages). The ledger, site build and restore need full Git history (`git fetch --unshallow` in a shallow clone).

## Migration baseline

Catalogue version 1 is the **unmodified** import of the read-only snapshot `data/snapshots/20261010T070702Z`. The Sheet was confirmed unchanged at 12:44 UTC the same day, and its compiled checksum equals the live `action=data` capture (`IMPORT_REPORT.md`). The import refuses rather than lose data:
- when the Sheet, `Code.gs` emulation and capture disagree;
- when Apps Script would silently skip rows or drop roles;
- when it would synthesise placeholder counters;
- when a mode cannot be represented.

Known defects were carried verbatim into version 1, and the unchanged release validator rejects it. The owner then approved corrections C1–C5 in `catalogue/corrections/2026-10-10-baseline.json`. Each is applied in its own commit with its own release record, versions 2–6. The current source passes the release gate.

Tests enforce that:
- the committed source equals the import plus only `APPROVED` corrections;
- the compiled payload differs from the live capture by exactly the declared paths of those corrections;
- `release.json` advances one version per applied correction.

So no undeclared edit can land during migration.

The Sheet was the migration authority and remains a frozen rollback baseline. Since the v3.6 cutover, `catalogue/source/` on `main` is the authoring authority; the Sheet and Apps Script `action=data` are not review inputs and must not be queried or edited for catalogue maintenance.

## Applying an approved counter change set

Schema 1 is retained only so the migration corrections remain reproducible. New proposals use correction schema 2 (`gac-catalogue-change-set:v1`). The contract reuses the correction list and source compiler; it is not another catalogue or publisher.

Each document records the proposal issue/PR and an exact baseline `{commit, catalogueVersion, checksum}`. Each proposal records its stable ID, disposition, rationale, evidence and limitations; affected references; expected 5v5, 3v3 and FLEET/Counters/Round/scoring/strategic-reserve impact; and every expected compiled payload path. Every source change has a file, stable row key, operation, and exact endpoints: Add is `before: "ABSENT"`, Retire is `after: "REMOVE"`, and Amend contains both complete rows. Array order is data and must be present exactly in those rows.

The preview prints the complete before/after rows and every field-level difference in the compiled seven-key payload. It also prints an approval checksum calculated from the proposal ID, baseline and exact ordered changes. Approval is valid only when all three agree:

- `status` is `APPROVED`;
- `approval.reference` links to the exact owner's GitHub issue comment or PR review;
- `approval.changeSetChecksum` is the checksum printed by preview.

Changing the baseline or any `before`/`after` value invalidates the checksum and needs a new owner decision. A topic, report, issue assignment or PR is not implicit approval. Pending, rejected and deferred proposals can be previewed but never applied.

Minimal pending proposal shape (replace every placeholder; rows are complete source rows, not fragments):

```json
{
  "schema": 2,
  "contract": "gac-catalogue-change-set:v1",
  "issue": "https://github.com/nimbrethil81/gac-helper/issues/NN",
  "baseline": {
    "commit": "<40-hex origin/main SHA>",
    "catalogueVersion": 6,
    "checksum": "sha256:<64 hex>"
  },
  "corrections": [{
    "id": "CR-YYYY-MM-DD-NN-P01",
    "status": "PENDING_OWNER_APPROVAL",
    "disposition": "AMEND",
    "title": "Concise proposal title",
    "rationale": "Why the exact change is proposed.",
    "approval": null,
    "provenance": {
      "evidence": [{
        "url": "https://...",
        "publisher": "...",
        "publishedOrObservedAt": "YYYY-MM-DD",
        "accessedAt": "YYYY-MM-DD",
        "supports": "Exact claim supported."
      }],
      "conditions": "Mode, lineups, omicrons, datacron and game version.",
      "confidence": "High | Medium | Low, with reasoning.",
      "limitations": "Unknowns and contrary evidence, or None."
    },
    "affectedReferences": [{
      "file": "matchups/5v5.json",
      "stableKey": { "mode": "5v5", "defence": "Exact Defence Name" },
      "effect": "Exact changed or checked consequence."
    }],
    "runtimeImpact": {
      "5v5": "...", "3v3": "none", "FLEET": "none",
      "counters": "...", "roundAvailability": "none",
      "scoring": "none", "strategicReserve": "none"
    },
    "expectedPayloadPaths": ["payload[\"counters\"][\"5v5\"][\"Exact Defence Name\"][0][\"notes\"]"],
    "changes": [{
      "file": "matchups/5v5.json",
      "operation": "AMEND",
      "stableKey": { "mode": "5v5", "defence": "Exact Defence Name" },
      "before": { "defence": "Exact Defence Name", "counters": [{ "counterId": "EXACT_COUNTER_ID", "tier": "A", "bannerScore": 62, "undersize": 0, "notes": "Old note" }] },
      "after": { "defence": "Exact Defence Name", "counters": [{ "counterId": "EXACT_COUNTER_ID", "tier": "A", "bannerScore": 62, "undersize": 0, "notes": "New note" }] }
    }]
  }]
}
```

After approval, change the status and replace `approval: null` with `{ "reference": "https://github.com/.../issues/NN#issuecomment-NNN", "decidedAt": "<ISO UTC>", "changeSetChecksum": "<preview checksum>" }`.

### Compare → preview → apply

1. Fetch `main`, confirm `catalogue:release -- --check` and `catalogue:compile -- --gate release`, and record the full `origin/main` SHA plus `catalogue/release.json` in the schema-2 file. Work from that exact commit. Do not use the frozen Sheet, Apps Script `action=data` or an old review as the baseline.
2. Describe one proposal as one coherent set of source changes. Include all dependent rows or list them under `affectedReferences` with `effect: "none — checked"`. Scoring and board-configuration files are refused by this counter workflow; they need their own approved scope and scoring review. A pending draft may start with `expectedPayloadPaths: []`; preview prints the paths to copy into the file. An approved proposal may not leave this list empty.
3. Run `npm run catalogue:corrections -- <file> --preview <proposal-id>`, fill any draft payload paths it reports, then run preview again. The command refuses malformed source, missing/duplicate IDs, overlapping stable keys, stale/ambiguous `before` rows, unexpected Add presence, candidate defence aliases, broken references, a release-gate failure, or any compiled path not declared in `expectedPayloadPaths`. Review the printed source and seven-key payload diff before approval.
4. After the owner approves that exact checksum and posts the decision, record the decision link/date/checksum. Create a dedicated branch at the still-current baseline and run `npm run catalogue:corrections -- <file> --apply <proposal-id>`. Apply refuses `main`, detached HEAD, a moved `origin/main`, a moved HEAD, a changed release/source baseline, tracked catalogue edits, multiple proposal IDs, and any status other than `APPROVED`. It stages the complete source in a temporary directory and swaps it only after the coherent result passes; it does not update `release.json`, commit, merge or deploy. Repeating an already completed exact apply is a no-op; extra changes make it fail.
5. Run `npm run catalogue:release`. A real content change must create exactly one higher version; a no-op stays on the same version. Then run:

   ```bash
   npm run catalogue:compile -- --gate release
   npm run catalogue:release -- --check
   npm run catalogue:ledger
   npm run catalogue:site -- --out "$(mktemp -d)/site"
   node --test tests/catalogue-source.test.js tests/catalogue-corrections.test.js tests/catalogue-release.test.js
   npm run check
   npm test
   ```

   The schema-2 preview's exact `expectedPayloadPaths` comparison proves that all other matchups, definitions, defence compositions, scores, aliases and lookup order are unchanged. Relevant app regression tests still cover Round, availability and all three modes.
6. Before committing or opening the PR, fetch `origin/main` again. If its SHA is no longer the recorded baseline, stop: re-reconcile the expected rows on fresh `main`, regenerate the preview checksum and obtain a new approval. Do not optimistically overwrite or treat a clean textual rebase as permission. Commit one approved proposal, its schema-2 file, source and new `release.json` together unless the owner separately approved an explicitly grouped equivalent.
7. Open a PR to `main` and attach the preview/check output. Owner review and merge publish nothing. Only the owner's later manual **Deploy Pages Live** run from `main` can publish.

### Publish verification and recovery

Before an authorised publish, rerun the release gate, release check, ledger and site build on `main`. The owner then runs **Deploy Pages Live**. Its guard checks the live transition before upload; post-deploy verify pins the deployed commit, pointer, manifest, version, checksum and every retained release byte. Smoke-check the app's Counters and Round behaviour for 5v5, 3v3 and FLEET plus offline availability. Apps Script `action=data` parity is not a publication test.

- **Before merge or after failed PR checks:** no live state changed. Fix the branch or abandon it; never amend `main` or deploy the failed branch.
- **Failed deploy verification:** this is not an automatic undo. Inspect/re-run `catalogue:verify-live`; if the artifact is correct but Pages was stale, redeploy the same reviewed `main`. Do not claim success from the upload step alone.
- **Bad live release:** choose only a previous-good version shown by `npm run catalogue:ledger`. On a fresh branch from current `main`, run `npm run catalogue:restore -- --version <N>`, then `npm run catalogue:release` to record the restored checksum under a new higher version. Run all checks, open a PR, obtain owner review/merge, manually deploy, and verify live. Restore refuses migration-only v1–v5 or any other version absent from `main`'s first-parent ledger, and refuses a historical source that fails today's gate.

Catalogue release, restore and deployment never rewrite browser-local roster, round, used-team, banner or defence-snapshot state.

## Fortnightly counter review

This is the manual, read-only research and reconciliation procedure for 5v5, 3v3 and FLEET (issue #35). It produces a review report and individually reviewable proposals; it does **not** edit catalogue source, approve a proposal, open an authoring PR, merge, or deploy. The application workflow for an explicitly approved proposal is separate work in #36.

### Authority and baseline

Run the review from a fresh checkout of `main`. Give it an immutable review ID (for example `CR-2026-10-24-01`) and a UTC evidence cut-off, then record:

```bash
git fetch origin main
git switch --detach origin/main
git rev-parse HEAD
cat catalogue/release.json
npm run catalogue:release -- --check
npm run catalogue:compile -- --gate release
```

The report's authoring baseline is that full commit SHA plus the version and checksum in `catalogue/release.json`. Read the current `catalogue/source/*.json` files, including all three matchup files, rather than an earlier report or migration snapshot. The compiler and shared audit are the validation authority; do not create a parallel schema or rule set.

Also fetch the public Pages `catalogue/current.json` and `catalogue/manifest.json` and record the current version, checksum and `deployedCommit`. Classify deployment status explicitly:

- **Deployed baseline** — the live pointer version/checksum equals `release.json`. The manifest commit may be older than `main` after non-catalogue commits; record both commits rather than treating them as equal.
- **Committed, not deployed** — `main` has a different release version or checksum from the live pointer. Reconcile against `main`, but name the live release separately in every runtime-impact statement.
- **Deployment unknown** — either live file could not be read or they disagree. Record the error and do not call `main` or a cached value “live”.

The frozen Sheet, migration snapshots and Apps Script `action=data` are rollback/history material only. Do not query or update them, compare current proposals to them, or repeat migration corrections C1–C5 as outstanding work. Release v6 already contains the approved `Gungan`/`Gungans`, `Any`/`ANY`, Grand Inquisitor duplicate and missing-unit fixes; only fresh regression evidence can justify reopening one.

### Select coverage

Every run records what was examined in each of 5v5, 3v3 and FLEET, even when a mode produces no proposal. Spend the review budget in this order:

1. game additions, reworks, new or changed omicrons, and defences with no usable counter;
2. matchups with weak, stale or conflicting evidence, then `strategicReserve` counters and `EXTREME`/`HIGH` threats whose errors affect allocation or battle order most;
3. a rotating sample of mature matchups, using the previous reports' coverage/history so they are not always the same rows.

Before researching a candidate, search current source and unresolved/recent reports by stable row key and proposed before/after. Continue an existing finding when the evidence or requested change is the same; do not emit a fresh duplicate each cycle. A reviewed item may end as **Add**, **Amend**, **Retire**, **No change**, or **Needs identity resolution**. “No change” is a useful result, not a failed review.

### Evidence policy

Every used source must have a link that was opened successfully during the run, a publisher, publication or observation date, the date accessed, and a short statement of what it actually supports. A search result, inaccessible page, title alone, or remembered claim is not usable evidence. Do not bypass access or scraping restrictions.

| Evidence | Required treatment |
|---|---|
| Game release, new unit/ship, rework or omicron | Prefer first-party game announcements or mechanically authoritative game data. Record effective version/date and the exact mechanic changed. Separate confirmed behaviour from preview text. |
| Matchup or battle result | It must be GAC evidence. Record 5v5/3v3/FLEET, attack and exact defence lineups as far as known, leader, relevant omicrons, datacron, outcome/attempt and banners, date range and sample count. Deduplicate reposted or overlapping samples. TW-only results are not GAC evidence. |
| Aggregated statistics | Record population, filters, date window, mode, sample size and statistic definition. Check that the source is currently accessible and permits the way it is being used. Do not turn an unfiltered win rate into a lineup-specific claim. |
| Video, guide or expert report | Record the demonstrated lineup, game version/date, conditions and number of shown battles. Disclose the publisher's stated affiliations, sponsorship or other apparent conflict; distinguish demonstration from a representative sample. |
| Datacron evidence | Record set, level/mechanics, season and expiry. Treat it as conditional and time-limited; do not make a permanent base-matchup claim from a datacron-only result. Flag the row for expiry review. |

Keep evidence for the three modes separate: 5v5 does not establish 3v3, either squad mode does not establish FLEET, and TW does not establish GAC. Note material unknowns such as relics, mods, abilities, turn order, player skill, opponent quality, cleanup state, preloaded turn meter, selection bias, survivor/publication bias, small samples and patch lag. Contradictory evidence stays visible.

Assign **High**, **Medium** or **Low** confidence as a reasoned summary, never directly from one win-rate threshold. High confidence normally needs current, mode-correct, reproducible evidence from more than one independent source or a suitably large and well-defined sample. Medium has useful but limited or partly conflicting support. Low is sparse, conditional, newly released or materially biased. Confidence does not override identity ambiguity or the owner's approval gate.

### Reconcile identities and fields

Resolve an attacking counter by `Counter_ID`, and its members by `Character_ID`; verify any roster-import mapping against a sourced `External_ID`. Resolve a defence only by its **exact displayed name plus mode**, with confirmed composition, omicron and datacron context. `ANY` is an existing consumer wildcard, not permission to merge modes.

- Never create or infer a `Defence_Team_ID`, infer identity from a leader, normalise plurals, rename automatically, or merge modes.
- External “Reva” may resolve to counter `REVA`, whose member is `THIRD_SISTER`; “Gungans” may resolve to `GUNGANS`, led by member `BOSS_NASS`. These display/identity differences are valid.
- `Geonosian` and `Geonosians` in different modes are not automatically one defence. Preserve valid defence-only and partial/flexible compositions.
- If more than one identity is plausible, stop at **Needs identity resolution**. List candidate exact name+mode or IDs, the evidence for each, and the specific owner/source question needed to resolve it. It is not a write-ready proposal.

For every resolved finding, compare all relevant source rows, not just the initially noticed field:

| Source | Stable row key | Reconcile | Meaningful downstream effect |
|---|---|---|---|
| `matchups/{mode}.json` | mode + exact `defence` + `counterId` | authored counter order, `tier`, `bannerScore`, `undersize`, `notes` | Counters ordering/detail; allocation reliability and expected banners; First Attack/Battle Order advice |
| `counters.json` | `id` (`Counter_ID`) | name, ordered required/recommended `Character_ID`s, `strategicReserve` | counter display; roster availability and unit exclusivity; hidden-board reserve strategy |
| `units.json` | `id` (`Character_ID`) | name, unit type, sourced `externalId` | roster import mapping and squad/FLEET validity |
| `defence-teams.json` | exact `defence` + mode | `threat`, notes | Round Battle Order fragility; `ANY` fallback only where explicitly authored |
| `defence-compositions.json` | exact `defence` + mode | ordered member IDs, including intentionally incomplete sets | My Board/defence snapshot unit commitment and availability |

If a finding changes scoring data or its interpretation, stop and request a separately scoped scoring review against `SCORING_REFERENCE.md`; do not smuggle it into a counter proposal. Check whether an apparently new attacker is merely the same attacking archetype under another name or a lineup variant already represented by a `Counter_ID`. Prefer amending the existing identity when that identity is confirmed; do not add a redundant counter just to repeat a matchup. Cross-file consequences must be one identified change set and must list every dependent row.

### Proposal contract

Give each resolved result its own stable proposal ID under the review ID. An **Add**, **Amend** or **Retire** recommendation is eligible for owner consideration only when it contains all of the following:

- disposition and concise rationale;
- exact `catalogue/source/` file path and stable row key; for a matchup, also its intended authored position;
- exact expected before row, or the literal `ABSENT` for an Add;
- exact proposed after row, or the literal `REMOVE` for a Retire; retain meaningful array/member order;
- base commit SHA and release version/checksum (the source revision being reconciled);
- evidence links with publication/observation dates and access dates;
- applicable mode, lineup, omicron, datacron and other conditions;
- confidence, limitations and unresolved contrary evidence;
- expected Counters, Round/availability, scoring and strategic-reserve impact, including “none” where checked;
- every dependent file/row for a cross-file change.

A **No change** result has the same ID, baseline, stable row key or bounded question, evidence, confidence and limitations. Record the confirmed current row(s), state why they remain suitable, and set runtime/strategic-reserve impact to “none — source unchanged.” It carries no source diff and needs no application. **Needs identity resolution** uses the identity questions above instead of before/after rows and cannot be approved for application.

Approval is the specific identified change set, not the topic or whole report. Record the owner's explicit **Approved**, **Rejected** or **Deferred** decision with date and link; any alteration to the expected before/after or dependent rows needs renewed approval. Research, owner approval, Git authoring/PR, owner merge, and manual production deployment are separate gates. #35 grants none of the latter four.

### Report template

Store or post the report where its links and decision history remain reviewable; do not put personal roster or ally-code data in public Git or issues. Use this shape (omit no heading; use `None` where genuinely empty):

```markdown
# Counter review CR-YYYY-MM-DD-NN
- Review date (UTC):
- Evidence cut-off (UTC):
- Base main commit:
- Base release: vN / sha256:...
- Live deployment: Deployed baseline | Committed, not deployed | Unknown
- Live pointer: vN / sha256:...
- Live deployedCommit:
- Modes covered: 5v5 (...); 3v3 (...); FLEET (...)
- Previous report(s) checked for duplicates:

## Coverage and evidence
- Priority changes/releases examined:
- Unreliable/high-impact rows examined:
- Mature rotation examined:
- Sources and access/limitations:

## Findings and proposals
### CR-YYYY-MM-DD-NN-P01 — Add | Amend | Retire | No change
- Question/rationale:
- File and stable row key:
- Intended authored position:
- Expected before: `ABSENT` or exact JSON
- Proposed after: exact JSON or `REMOVE` (same as before for No change)
- Source revision: commit; release version/checksum
- Evidence: URL — publisher — published/observed — accessed — supports
- Conditions: mode; lineups; omicrons; datacron season/expiry; game version
- Confidence and limitations:
- Dependent rows/files:
- Runtime impact: Counters; Round/availability; scoring; strategic reserve
- Decision: Pending | Approved | Rejected | Deferred — date — owner link

### CR-YYYY-MM-DD-NN-I01 — Needs identity resolution
- Observation and candidate identities:
- Evidence/limitations:
- Exact question(s) to resolve:

## Deferred questions
- Question — owner/evidence needed — revisit trigger/date

## Decision/history (chronological)
- YYYY-MM-DD — review opened from commit/release/live deployment
- YYYY-MM-DD — proposal/identity result added, superseded or closed (link and reason)
- YYYY-MM-DD — owner decision recorded (link)
```

Before handing off, re-read each proposed before row from the recorded commit, confirm all three modes have a recorded coverage result, run the shared release gate without modifying source, and check that the history links any superseded proposal rather than duplicating it. A later source change makes the proposal stale: re-reconcile it against fresh `main` and obtain approval for the resulting exact change set before #36 applies anything.

## Static release on Pages

`Deploy Pages Live` (manual `workflow_dispatch`, `main` only, one run at a time) builds the catalogue into the same allow-listed artifact as the app. Nothing is published by a merge, schedule or bot.

### Artifact

| Path | Content |
|---|---|
| `index.html`, `app.js`, `styles.css`, `manifest.json`, `service-worker.js`, `icon-192.png`, `icon-512.png` | App shell. The allow-list lives in `PAGES_APP_FILES` in `scripts/catalogue-release-lib.js`. |
| `catalogue/releases/{N}-{12 hex}.json` | Immutable release file (ADR §5): the seven keys plus `release` `{contract, sourceSchema, catalogueVersion, checksum}`, written as compact JSON with keys sorted recursively. Its bytes depend only on the version and the payload. |
| `catalogue/current.json` | Pointer (ADR §7): `pointerSchema`, `contract`, `catalogueVersion`, `checksum`, `path`, `bytes`. Depends only on the current release. |
| `catalogue/manifest.json` | Deployment record: the `deployedCommit`, the `current` release, and each served release with its `bytes`, file `sha256` and `sourceCommit`. `sourceCommit` is the first `main` commit that recorded the release. This is the only file that changes when an app-only commit is redeployed. |

The build refuses a non-empty output directory. After writing, it re-reads the artifact and fails unless:
- the file set is exactly the allow-list;
- every release file matches its manifest bytes and hash;
- every release file passes the release gate again;
- the pointer names the highest version;
- the budget below holds.

No source, `release.json`, corrections, snapshots, scripts, tests or docs are included.

### Release ledger and retention

The ledger is every `catalogue/release.json` state on the first-parent history of `main`, which is every catalogue `main` could have deployed. Versions must strictly increase, and a version never names two checksums. A checksum may reappear under a higher version (a rollback). The deployed release must be the committed `release.json`, must be the highest version, and must equal the compiled source.

Each deployment replaces the whole Pages site, so nothing from an earlier deployment is assumed to survive. Every deployment rebuilds from Git:
- the current release;
- up to four earlier releases that still compile to their recorded checksum and pass the current release gate.

A rebuilt file is byte-identical to the one served before. Older releases are no longer served but stay restorable from Git. Today the ledger holds only v6: versions 1–5 were recorded inside the #41 PR, never on `main`'s first-parent history, and failed the gate.

### Deployment checks

1. **Preflight** (before upload): the catalogue tests run, then `catalogue:site` builds the artifact. Either failing stops the run. This covers invalid schema, broken identity references, a failing release gate, a corrupted or stale `release.json` checksum, undeclared drift between source and `release.json`, ledger violations, corrupted written files, files outside the allow-list and the budget.
2. **Guard** (before upload): reads the live `catalogue/manifest.json`. A 404 means a first deployment. The run is refused if:
   - the live current version is higher than the build's;
   - the live version names a different checksum;
   - a live release file differs from its rebuilt bytes;
   - the live site cannot be read.
3. **Verify** (after deploy): polls the live pointer, manifest and every release file every 20 s for up to 15 min. It passes only when all are byte-identical to the artifact, which pins the deployed commit, version and checksum. It then re-verifies the live current release. Otherwise the run fails, naming the stale or wrong files. A failed verify does not undo the deployment: re-run `catalogue:verify-live` later, or redeploy.

### Behaviour

| Situation | Result |
|---|---|
| Same release redeployed (for example after an app-only merge) | Release files and pointer are byte-identical. Only `manifest.json` `deployedCommit` changes. The guard reports `same-release`. Clients see the same checksum and download nothing new at cutover. |
| Changed catalogue content | A new `release.json` version (from `catalogue:release`) gets a new release file and a moved pointer. Earlier releases stay served within retention. |
| Source changed without `catalogue:release` | CI and the deploy preflight fail with "Undeclared catalogue change". |
| Stale pointer or out-of-order run | The guard refuses any build older than the live version. Concurrent runs are serialised by the `pages-live` group. A client holding an older pointer still finds a retained release file instead of a 404. |
| Pages/CDN still serving old files after deploy | Verify keeps polling, then fails. It never reports success early. |
| Rollback | See below. The rollback gets a new, higher version with the earlier checksum. Versions never decrease. |

### Deploying

1. Merge the reviewed catalogue PR. CI has run the release gate, the ledger and the full artifact build.
2. The owner runs **Actions → Deploy Pages Live → Run workflow** on `main`.
3. Check the run's summary lines: the guard's transition (`v5 → v6`), and verify's version, checksum and deployed commit.

### Rolling back

To restore a previously approved release N (repeatable, and tested in `tests/catalogue-release.test.js`):

1. On a branch from current `main`, run `npm run catalogue:restore -- --version N`. This writes release N's exact committed source back into `catalogue/source/`. It refuses if N is not on `main`'s first-parent history, or if N no longer compiles to its checksum or passes today's gate.
2. Run `npm run catalogue:release`. It records N's checksum under a new, higher version.
3. Commit, open a PR, and let CI run. The owner merges.
4. Run `Deploy Pages Live`. The guard reports `vCurrent → vNew`, and verify confirms that the live pointer names the new version with N's checksum.

Rolling back the cutover itself (restoring the Apps Script loader in the app) is covered in [Cutover](#cutover).

### Performance budget

The budget is enforced by `catalogue:site` (`BUDGET` in `scripts/catalogue-release-lib.js`). Measurements for v6 were taken on 2026-10-10 with Node 22. Transferred sizes are local gzip/brotli estimates; live transfer sizes are measured at cutover (ADR §10).

| Item | Budget | v6 raw | gzip -9 | brotli |
|---|---|---|---|---|
| `current.json` (same-version launch: the only request) | ≤ 1 KiB | 241 B | 188 B | 162 B |
| Release file (changed-version launch) | ≤ 256 KiB | 85,520 B | 13,707 B | 11,320 B |
| `manifest.json` (not fetched by the app) | ≤ 4 KiB | 692 B | 334 B | 282 B |
| Whole `catalogue/` directory | ≤ 1.5 MiB | 86,453 B | — | — |
| Reference: Apps Script `action=data` capture (2026-10-10) | — | 85,241 B | 13,157 B | — |

The release file is the same size as today's `action=data` (+0.3%). It costs one extra pointer request of about 240 B, and a same-version launch saves the whole payload download. The client checksum work at cutover is parsing the release and hashing the 141,327-byte canonical seven-key JSON. That takes about 4 ms per release in Node 22 on the build container; `crypto.subtle` timing on iPhone Safari is a cutover measurement.

## Cutover

App v3.6 (#43) loads the catalogue from `catalogue/current.json` and the release file it names, not from Apps Script `action=data`. Loading, the `catalogueCache:v2` migration and the service-worker bypass follow ADR-ARCH-116 §8 with the refinements in §12. Roster import is unchanged: it still goes through Apps Script `action=roster`, which calls Comlink.

**Deployment.** The cutover went live with the 2026-10-10 `Deploy Pages Live` run of `a52fbfc`. App and catalogue ship in the same artifact, so the site is never half-switched. Already-installed apps pick up v3.6 on a later launch. Pages serves the shell with a 10-minute HTTP cache, and the bumped service worker (`swgoh-shell-v20`) takes over once old app windows close. Until then the old worker passes catalogue requests straight to the network without caching them, so v3.6 still works under it.

**After deploying.**
1. Check that the run's verify step names the expected catalogue version and checksum.
2. On a device, confirm the footer reads `v3.6` and the Counters screen loads.
3. Relaunch while offline: the app must render from its saved catalogue and show the quiet status line.

**Rolling back the cutover** (tested end to end in a browser for #43):
1. On a branch from current `main`, `git revert` the #43 merge commit. This restores the Apps Script loader in `app.js` and gives `service-worker.js` new bytes, so installed apps update. Keep the catalogue source, `release.json` and the workflow as they are.
2. Open a PR, let CI run, and merge.
3. Run `Deploy Pages Live`. The static catalogue stays published and is ignored again.

v3.6 never writes or removes `catalogueCache:v1`, except to make room when storing v2 would exceed the storage quota. The reverted app therefore finds its last Apps Script catalogue and works offline straight away. Saved roster, round, banner and template state is shared by both versions and is never changed by a catalogue change. The rolled-back app serves the frozen Sheet, so any Git-only catalogue releases are lost on that path (ADR §9). Do not edit or decommission the Sheet or Apps Script `action=data` while this rollback must stay available.

## Limitations

- Finding locations from the shared rule set name payload paths (for example `counters["3v3"]["Grand Inquisitor"][1]`), not source line numbers.
- Time to first render and refresh, and iPhone Safari and installed-PWA behaviour, are measured per deployment. The #43 pull request records the pre-cutover measurements and which device checks the owner still has to make.
- The guard and verify steps need the live Pages site to be reachable. If it is not, the run fails closed.
