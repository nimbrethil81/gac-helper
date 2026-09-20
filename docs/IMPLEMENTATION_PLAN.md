# SWGOH GAC Helper — Target Architecture Implementation Plan

**Status:** Ready for implementation planning and staged execution. No implementation work has started.

**Planning baseline:** `main` at `1e6bdc55b4619eccb4a2ca7103a79d0a831476c1`.

**Architecture authority:** [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) v0.2.

**Scope.** This document defines the ordered delivery plan, dependencies, manual configuration, acceptance gates and rollback points for implementing the target architecture. It does not redefine the architecture and does not describe current shipped behaviour. Current behaviour remains authoritative in [`SPEC.md`](SPEC.md).

**Update this document when** a work package is completed, split, materially re-scoped, blocked or abandoned. Record current status and evidence without turning this document into release history. Shipped behaviour moves into `SPEC.md` and the concise release event goes into `changelog.md`.

---

## 1. Delivery principles

1. The programme has exactly **three user-facing stages**.
2. Work packages inside a stage are execution checkpoints, not additional stages.
3. Nearly all GitHub, database and hosting configuration is concentrated into one Stage 1 session.
4. Stage 1 is independently valuable and may remain the final delivered state if useful evidence cannot be obtained.
5. Stage 2 is report-only. It cannot alter the current live catalogue.
6. Stage 3 activates bounded autonomous publication only after Stage 2 acceptance.
7. The current Sheet-backed application remains recoverable throughout Stage 1 and for at least one complete GAC event after cutover.
8. The production app is never switched during an ordinary coding task. Cutover is its own explicitly approved work package.
9. Each work package begins from fresh repository evidence and ends with a reviewed diff, relevant tests and an updated status in this document.
10. Agents may commit approved work directly to `main` under `AGENTS.md`, but may not trigger production deployment unless the work package explicitly authorises it.
11. No secrets, personal identifiers or private operational files may enter a public artifact.
12. Stage boundaries are acceptance decisions. Passing unit tests alone is not sufficient.
13. Human authoring and maintenance review must be runnable on demand outside the schedule.
14. Manual and scheduled maintenance use the same core pipeline, policy, validation and audit path; a manual trigger cannot bypass safeguards.
15. This conversation remains the control thread. Coding and deep-analysis work may use breakout threads, but scope, decisions, verification and next-step selection return here.

---

## 2. Current repository baseline

At the planning baseline:

- the app is a plain HTML/CSS/JavaScript PWA;
- `app.js` uses one `API_URL` for both catalogue data and `action=roster`;
- Google Sheets is the authored catalogue and Google Apps Script builds its JSON payload;
- Apps Script also proxies the roster request to Comlink;
- the PWA does not persist the catalogue locally before the initial fetch;
- `service-worker.js` precaches only the application shell and uses network-first fallback;
- `tests/my-board.test.js` is the only automated test file;
- there is no `package.json` and no CI workflow;
- `.github/workflows/deploy-to-live.yaml` is manual and synchronises an explicit allow-list into the public live repository;
- `.assetsignore` mirrors the public allow-list;
- internal docs, tests and Apps Script are excluded from the live artifact;
- the Apps Script contains a removable one-off helper with a hard-coded personal ally code;
- the current development/live repository split is working and remains the fallback until consolidation is proved.

These facts constrain the implementation. None may be silently assumed away.

---

## 3. Programme overview

| Stage | Outcome | User involvement | Production effect |
|---|---|---|---|
| **1. Canonical platform, authoring and publication** | Database-backed canonical store, safe human authoring, immutable static catalogue, offline cache, tested cutover and guarded one-repository deployment | One concentrated configuration session plus explicit cutover approval | Replaces Sheet catalogue runtime only after full acceptance |
| **2. Maintenance engine, report-only** | Evidence ingestion, mapping, assessments and policy findings tested against real cycles | Evidence-source decision and review of validation results | None; current catalogue cannot change |
| **3. Scheduled bounded autonomy** | Idempotent scheduling, automatic validated publication, concise reporting and recovery | Activation approval; later involvement only for failures or genuine escalation | Eligible maintenance releases may become current |

Before Stage 2 there is one **evidence and runner entry gate**. It is a go/no-go check, not a fourth build stage.

---

# Stage 1 — Canonical platform, authoring and publication

## 4. Stage 1 objective

Deliver a complete, independently useful replacement for the Sheet-backed catalogue path while preserving the existing product contract and a simple fallback.

At Stage 1 completion:

- Postgres-compatible storage is the canonical maintenance and authoring store;
- human catalogue changes do not require SQL;
- all current IDs, names, notes, modes, configuration and scoring survive migration;
- the application consumes a validated static catalogue artifact;
- the catalogue loads from a known-good local cache before background refresh;
- Apps Script remains only for roster proxying;
- the old `action=data` route and Sheet remain available during the fallback window;
- the public artifact remains fail-closed;
- repository consolidation has been completed only if its safety gates pass;
- no evidence ingestion or autonomous maintenance has been implemented.

## 5. Stage 1 work packages

### ARCH-101 — Baseline capture and CI foundation

**Purpose:** Establish automated protection before changing architecture.

**Baseline and completion evidence:**

- Starting full `main` SHA: `71ee5eb7453859dd61bfdbb841af0669f23a603f` (2026-09-20; newer than the SHA quoted when this work package was handed off — fresh evidence was obtained before editing).
- Initial test command and result: `node --test tests/*.test.js` — 31/31 passing; no `package.json` existed yet.
- Final repository commands: `npm run check` (runs `node --check` over `app.js`, `service-worker.js` and `tests/*.test.js`) and `npm test` (runs `node --test`, which discovers all `*.test.js` files under `tests/` with no file named explicitly).
- Final test/check results: `npm run check` — clean, no output; `npm test` — 31/31 passing. A temporary intentionally-failing test file was added under `tests/`, confirmed to make `npm test` exit non-zero (32 run, 1 failed), then removed; the suite returned to 31/31 passing.
- CI workflow added: `.github/workflows/ci.yml` — runs on push to `main` and on pull requests targeting `main`, using Node 22, running `npm run check` then `npm test`. No install step, since the project has no dependencies. No secrets and no deployment step.
- No `package-lock.json` was added: the project has zero dependencies, so a lockfile would document nothing and was deliberately omitted.
- The disposable `authorise()` helper and its hard-coded personal ally code were removed from `apps-script/Code.gs`. It was not called by any application code, its own comment already marked it "Safe to delete", and removing it leaves `doGet`, `action=data`, `action=roster` and the roster proxy (`fetchRoster`) unchanged.
- `apps-script/Code.gs` is not covered by the syntax-check script: Node's `node --check` rejects the `.gs` extension outright (`ERR_UNKNOWN_FILE_EXTENSION`), and Apps Script's runtime globals (`SpreadsheetApp`, `ContentService`, `UrlFetchApp`) are not something a plain Node syntax check should pretend to validate. No workaround (renaming, wrapping, or stubbing globals) was introduced; this is a known boundary of the current tooling.
- `.github/workflows/deploy-to-live.yaml` was not modified and was not triggered.
- Resulting completion commit SHA: reported in the coding-agent handoff to the control thread (recording it here would create a self-reference against the commit that carries this update).

**Status: Complete.** Every acceptance criterion below passed.

**Repository work:**

- add the smallest suitable Node project manifest and deterministic test commands;
- make `node --test` run all repository tests without naming an individual file;
- add a CI workflow for pushes and pull requests;
- run syntax checks appropriate to the plain-JavaScript app;
- add initial contract-test locations without changing application behaviour;
- document the exact baseline commit and current test count;
- remove the personal ally code from the disposable Apps Script authorisation helper, or remove the helper entirely.

**Must not:**

- change catalogue behaviour;
- alter deployment;
- introduce a frontend framework or build system merely to support tests.

**Acceptance:**

- existing tests pass locally and in CI;
- CI fails on an intentionally failing test in a temporary verification and returns green after restoration;
- no live/public deployment occurs;
- Apps Script contains no personal ally code.

**Rollback:** Revert this package; current app and deployment remain unchanged.

**Depends on:** none.

---

### ARCH-102 — Platform decisions and threat model

**Purpose:** Resolve the implementation decisions that affect Stage 1 structure before cloud configuration.

**Decisions to make from current evidence:**

1. Postgres host and region.
2. One-project versus separate-project environment design.
3. Static catalogue artifact storage and current-pointer mechanism.
4. How the development environment reads unpublished candidate artifacts.
5. One-repository production mechanism and fail-closed public artifact.
6. Backup/export and database wake/recovery procedures.
7. Exact secret and least-privilege role inventory.
8. Whether generated artifacts are committed, attached to releases, or deployed directly.
9. Payload schema version 1 contract.
10. Naming and location of migrations, change files and generated artifacts.

**Required evaluation criteria:**

- no database dependency in the live PWA path;
- no new recurring cost unless explicitly approved;
- compatibility with existing GitHub/static hosting;
- recovery without specialist database knowledge;
- no broad database credential available to the maintenance runner;
- no internal file can enter the public artifact by default;
- the implementation remains portable away from the selected provider.

**Deliverable:** A concise checked-in decision record linked from this plan. Architectural changes discovered here update `TARGET_ARCHITECTURE.md` rather than being hidden in implementation notes.

**Acceptance:** Every Stage 1 configuration field and secret is known before the manual session is scheduled.

**Rollback:** Documentation-only.

**Depends on:** ARCH-101.

---

### ARCH-103 — Migration and golden-contract capture

**Purpose:** Create immutable evidence of the current canonical data and app contract before migration.

**Artifacts:**

- timestamped exports of every relevant Sheet tab;
- current Apps Script `action=data` response as the golden payload;
- manifest containing source timestamp, hashes and row/entity counts;
- reports for current IDs, defence names, modes, required-member external IDs, notes, board configuration and scoring;
- inventory of persisted client keys affected by identity changes.

**Storage constraints:**

- artifacts remain in the private source repository or another approved private location;
- no roster, ally-code or other unnecessary personal data is included;
- generated exports are never added to the public artifact allow-list.

**Acceptance:**

- exports can reconstruct the current payload without querying the Sheet;
- the golden payload is valid JSON and passes a baseline contract test;
- each current `Counter_ID` and defence display name is enumerated;
- unresolved/partial defence compositions are explicitly reported;
- hashes make accidental export changes visible.

**Rollback:** Delete only the new private artifacts if required; the Sheet is untouched.

**Depends on:** ARCH-101. May run in parallel with ARCH-102 after CI exists.

---

### ARCH-104 — Prepared manual-configuration session

**Purpose:** Complete nearly all required cloud and repository setup in one user session after agents have prepared exact instructions.

**Preparation performed by the agent before the session:**

- produce a step-by-step checklist using the selected provider's current UI terminology;
- list every environment, secret and permission with its exact purpose;
- provide validation actions after each group;
- identify which values are safe to expose to the static app and which are publisher/admin only;
- prepare migrations and workflows so configuration can be tested immediately;
- include a recovery/export check before leaving the session.

**Expected user actions in the single session:**

- create or select the database project and region;
- configure development and production repository environments;
- add database, publisher and artifact-storage secrets;
- configure static hosting/publication permissions;
- configure or approve the guarded one-repository deployment route;
- confirm backup/export capability;
- approve required workflow permissions;
- retain the existing live-repository token until fallback retirement.

**Reserved for later:**

- an evidence-provider credential cannot be supplied until the Stage 2 gate identifies a provider;
- Stage 1 should nevertheless reserve the environment/secret naming convention so later setup is a single value addition, not new infrastructure.

**Acceptance:**

- harmless read-only connection tests succeed;
- publisher credentials cannot perform admin/schema operations;
- public/app configuration contains no privileged secret;
- a database export or documented recovery check succeeds;
- no production cutover occurs.

**Rollback:** Remove newly added secrets or disable new workflows; existing application remains unchanged.

**Depends on:** ARCH-102 and prepared implementation from ARCH-105/ARCH-108 far enough to validate connections. The session occurs once those packages are ready, not at the beginning of Stage 1.

---

### ARCH-105 — Core database schema and permissions

**Purpose:** Implement the provider-neutral schema defined by the target architecture.

**Schema areas:**

- units;
- team archetypes, profiles and members;
- matchups;
- accepted matchup and defence catalogue values;
- human authoring changes;
- generic evidence, mapping, assessment, finding and run tables;
- board and scoring configuration;
- releases, provenance and current state;
- lifecycle enums, uniqueness and referential constraints;
- authority states;
- publication lock/base-release fields.

**Permission boundaries:**

- authoring loader;
- evidence ingester;
- maintenance analyst;
- deterministic applier;
- publisher;
- migration/admin.

The live PWA receives no database credential.

**Implementation rules:**

- use ordered, reversible migrations;
- avoid provider-specific SQL where ordinary Postgres works;
- do not add provider-shaped evidence metrics before the Stage 2 source contract exists;
- include schema tests for uniqueness, forbidden writes and lifecycle rules;
- seed no speculative catalogue data.

**Acceptance:**

- migrations apply from an empty database;
- migrations are repeatable/idempotent where required;
- rollback or restore procedure is demonstrated in a disposable environment;
- permissions prove each role can perform only its intended operations;
- no analyst or ingester can mutate canonical state or releases.

**Rollback:** Restore the pre-migration database or recreate from ordered migrations. No app uses it yet.

**Depends on:** ARCH-102. Connection verification uses ARCH-104.

---

### ARCH-106 — Migration loader and reconciliation

**Purpose:** Transform the captured Sheet data into the canonical schema without changing public identity.

**Required transformations:**

- preserve `Character_ID` as `unit_id`;
- preserve every attack `Counter_ID` as `archetype_code`;
- create unified archetypes for attack/defence identities;
- use `ANY` attack profiles for currently mode-shared squad compositions;
- create mode-specific defence profiles and `members_complete` state;
- migrate matchups, tiers, banner scores, undersize and tactical notes;
- migrate threat and defence notes;
- mark migrated judgements `AUTHORED_BASELINE` unless explicitly locked;
- migrate board configuration and scoring;
- create the legacy-migration authoring/provenance record;
- report all duplicate, ambiguous and unresolved mappings.

**Non-negotiable compatibility:**

- public names and mode strings remain byte-identical;
- no automatic tidy-up or rename occurs during migration;
- no unresolved row is guessed;
- no note is dropped;
- no required-unit external-ID coverage is reduced.

**Acceptance:**

- repeated loading is idempotent;
- row/entity counts reconcile to ARCH-103;
- every discrepancy has a written resolution;
- all duplicate identity decisions are explicit;
- the database can generate the current catalogue semantics.

**Rollback:** Drop/recreate the unconnected database and rerun. Sheet remains authoritative.

**Depends on:** ARCH-103 and ARCH-105.

---

### ARCH-107 — Human authoring and manual release path

**Purpose:** Ensure routine maintenance remains easier than direct database editing.

**Repository work:**

- define a concise validated change-file schema;
- implement an idempotent loader;
- support create/update/retire operations required by the current catalogue;
- support `AUTHORED_LOCKED` and `AUTHORED_BASELINE`;
- validate identifiers, membership, modes, scores, notes and expected base release;
- record applied author, reason and change ID;
- provide dry-run output and a human-readable proposed diff;
- create `AUTHORING` candidates through the normal publisher;
- document the agent-assisted authoring workflow.

**Acceptance:**

- an agent can prepare a one-counter change without SQL;
- dry run shows exact canonical and payload effects;
- applying the same change twice does not duplicate data;
- an invalid unit ID, duplicate matchup, out-of-range score or stale base release is rejected;
- locked values cannot be changed by the maintenance role;
- one reversible test authoring change produces a valid development candidate.

**Rollback:** Reject the candidate or create a compensating reviewed authoring change. No live pointer moves.

**Depends on:** ARCH-105 and ARCH-106.

---

### ARCH-108 — Catalogue generator, validator and publisher

**Purpose:** Generate immutable app-compatible artifacts safely.

**Components:**

- payload generator matching the golden contract;
- schema-versioned additive provenance;
- structural and product-contract validators;
- transaction-scoped publication lock;
- base-release comparison;
- monotonic version allocation;
- immutable release record and checksum;
- versioned static artifact;
- safely ordered current-pointer update;
- compatible rollback command;
- explicit `MIGRATION`, `AUTHORING`, `MAINTENANCE` and `APPROVED_OVERRIDE` reasons.

**Product validations include:**

- exact app mode keys;
- one valid `SETTING_DEFENCE` rule;
- territory order/type/count;
- scoring and undersize limits;
- external-ID coverage;
- stable counter and defence keys;
- valid zero-counter defence handling;
- provenance for assessed values;
- compatibility with persisted state.

**Acceptance:**

- golden payload parity passes, excluding documented additive metadata/order;
- two concurrent publishers cannot lose one another's changes;
- stale-base publication is rejected;
- invalid candidate publishes nothing;
- artifact failure leaves the previous pointer current;
- rollback selects only a compatible payload schema;
- previous artifacts remain available.

**Rollback:** Repoint to the previous compatible release. Database history remains intact.

**Depends on:** ARCH-105, ARCH-106 and the platform decisions from ARCH-102. ARCH-107 consumes it.

---

### ARCH-109 — PWA catalogue cache and split endpoints

**Purpose:** Make the live-round application genuinely cache-first while retaining the roster proxy.

**Changes expected in current files:**

- `app.js`:
  - replace the single `API_URL` with separate catalogue and roster-proxy configuration;
  - add a versioned catalogue cache key;
  - validate HTTP status, schema version and required payload fields;
  - render the cached known-good catalogue first;
  - refresh in the background;
  - preserve cache on invalid/failed responses;
  - make incompatibility understandable without discarding usable data;
  - retain existing roster behaviour and timeout;
- `service-worker.js`:
  - make cache lifecycle explicit;
  - remove obsolete shell caches;
  - avoid trapping catalogue versions incorrectly;
  - preserve offline shell startup;
- tests:
  - cached cold start;
  - successful refresh;
  - failed refresh;
  - invalid response;
  - incompatible payload version;
  - roster endpoint remains separate;
  - active round and persisted identity remain intact.

**Must not:**

- redesign the interface;
- change counter/allocation/scoring behaviour;
- move roster calls into the database platform;
- delete compatibility with current localStorage state.

**Acceptance:**

- an offline cold launch after one successful sync reaches a usable round;
- a network failure never replaces a good catalogue;
- a bad 200 response is rejected;
- roster import still uses Apps Script;
- current test suite and new cache tests pass.

**Rollback:** Restore the Apps Script catalogue URL. Existing `action=data` remains live.

**Depends on:** ARCH-108 for the final contract. Test scaffolding may start earlier.

---

### ARCH-110 — Development reconciliation and failure rehearsal

**Purpose:** Prove the integrated Stage 1 system before production or repository consolidation.

**Required exercises:**

1. golden-payload parity;
2. entity-count reconciliation;
3. counter-ID and defence-name preservation;
4. fixture-roster availability equivalence;
5. defence snapshot completeness/unresolved behaviour;
6. board and scoring equivalence;
7. zero-counter defence behaviour;
8. human authoring dry run and candidate generation;
9. offline cold launch;
10. invalid-payload rejection;
11. simultaneous publication;
12. stale-base rejection;
13. artifact-write failure;
14. pointer-write failure;
15. database unavailable while the PWA continues from static/cache;
16. rollback to a prior artifact;
17. rollback to Sheet-backed `action=data`.

**Deliverable:** A signed-off Stage 1 validation report containing evidence, not just pass/fail claims.

**Acceptance:** Every mandatory check passes or has an explicit user-approved exception recorded in the architecture.

**Rollback:** No production state has changed.

**Depends on:** ARCH-106 through ARCH-109.

---

### ARCH-111 — Guarded one-repository consolidation

**Purpose:** Reach the desired single-source repository model without weakening the current public boundary.

**Preconditions:**

- CI is green;
- development reconciliation is complete;
- fail-closed artifact generation exists;
- secrets and personal identifiers are excluded;
- the current live repository remains recoverable.

**Required behaviour:**

- `main` remains the authoritative source;
- only a generated/allow-listed public artifact is deployed;
- internal docs, migrations, tests, evidence and change files cannot be published accidentally;
- production deployment is explicit and uses a tested commit/artifact;
- environment configuration remains external;
- live URL and PWA update behaviour are preserved or deliberately migrated;
- the old live repository remains available until production acceptance.

**Decision rule:** If the chosen hosting or GitHub plan makes consolidation materially riskier or introduces unjustified cost, record the evidence and retain the existing two-repository deployment temporarily. This is an explicit Stage 1 exception requiring user approval, not a silent omission.

**Acceptance:**

- a deliberately added private test file is excluded from the public artifact;
- public artifact contents match the allow-list;
- deployment can be reproduced from a known commit;
- rollback to the former live repository is documented and tested.

**Rollback:** Re-enable the current `deploy-to-live.yaml` path and public repository.

**Depends on:** ARCH-101, ARCH-102 and ARCH-110.

---

### ARCH-112 — Production cutover and fallback window

**Purpose:** Switch production only after explicit approval.

**Pre-cutover evidence:**

- Stage 1 validation report approved;
- database backup/export current;
- migration and artifact hashes recorded;
- prior live commit and Apps Script URL recorded;
- rollback rehearsed;
- no unresolved Critical/Major migration finding;
- production artifact reviewed.

**Cutover:**

1. freeze Sheet authoring briefly;
2. rerun export/reconciliation for changes since ARCH-103;
3. apply the final idempotent delta;
4. publish the production static catalogue;
5. deploy the cache-capable PWA;
6. confirm roster import;
7. confirm active/saved board compatibility;
8. confirm offline reload;
9. start the one-complete-GAC-event fallback window.

**During fallback:**

- Sheet and Apps Script `action=data` remain intact;
- new canonical authoring occurs only through the target path;
- emergency rollback may restore the old catalogue URL;
- no evidence automation begins.

**Stage 1 exit gate:**

- one complete GAC event succeeds on production;
- the owner has completed at least one real authoring change without SQL;
- no catalogue/roster/offline regression remains;
- rollback is still available;
- only then may `action=data` be retired and the Sheet archived.

**Depends on:** ARCH-110 and ARCH-111, or an approved consolidation exception.

---

## 6. Stage 1 dependency summary

| Work package | Depends on | Can overlap |
|---|---|---|
| ARCH-101 | — | — |
| ARCH-102 | ARCH-101 | ARCH-103 |
| ARCH-103 | ARCH-101 | ARCH-102 |
| ARCH-104 | ARCH-102 plus prepared connection code | Scheduled once, validates ARCH-105/108 |
| ARCH-105 | ARCH-102 | Migration-tool preparation |
| ARCH-106 | ARCH-103, ARCH-105 | ARCH-107 design |
| ARCH-107 | ARCH-105, ARCH-106, ARCH-108 | Documentation/tests |
| ARCH-108 | ARCH-102, ARCH-105, ARCH-106 | ARCH-109 scaffolding |
| ARCH-109 | ARCH-108 contract | ARCH-107 |
| ARCH-110 | ARCH-106–109 | — |
| ARCH-111 | ARCH-101/102/110 | — |
| ARCH-112 | ARCH-110/111 or approved exception | — |

Only ARCH-112 may switch production.

---

# Evidence and runner entry gate

## 7. GATE-200 — Source and execution feasibility

This gate occurs after Stage 1 and before Stage 2 implementation commitment. It may be investigated earlier, but it cannot introduce infrastructure or bypass Stage 1 priorities.

**Questions to answer with fresh evidence:**

1. Which provider and exact dataset contain useful GAC matchup observations?
2. Does the provider permit automated retrieval?
3. What authentication and recurring cost are required?
4. Are observations mode-specific?
5. Are exact attack and defence compositions available as stable unit IDs?
6. What sample sizes exist for representative common and uncommon matchups?
7. Are attempt number, units fielded and clean-win semantics available?
8. What rate limits, readiness delay and retention apply?
9. Can the existing CI/scheduled platform run ingestion safely at no new cost?
10. Is AI required for routine mapping, or only ambiguous cases?

**Spike output:**

- one stored raw sample;
- parser feasibility report;
- mapping exercise against a catalogue slice;
- matched/variant/unresolved counts;
- sample-size distribution;
- terms/cost statement;
- recommended runner;
- explicit `GO`, `GO WITH LIMITS` or `STOP AFTER STAGE 1`.

**No-go rule:** If permitted, sufficiently granular and acceptably priced evidence does not exist, do not implement Stages 2 or 3.

---

# Stage 2 — Maintenance engine in report-only mode

## 8. Stage 2 objective

Produce explainable maintenance proposals from real evidence without changing the current catalogue or static pointer.

## 9. Stage 2 work packages

### ARCH-201 — Provider contract and source adapter

- formalise the provider fields and semantics proven by GATE-200;
- add only the required provider-specific normalisation;
- preserve raw responses and hashes;
- implement idempotent retrieval and rate-limit handling;
- create fixtures with secrets/personal data removed.

**Acceptance:** The same source cycle cannot be ingested twice; parser changes are versioned; malformed data fails closed.

**Depends on:** GATE-200 = `GO` or `GO WITH LIMITS`.

---

### ARCH-202 — Run lifecycle and evidence ingestion

- implement `cycle_key` and per-mode attempts;
- detect evidence readiness without guessing;
- ingest immutable observations under the evidence role;
- record source snapshot and retrieval contract;
- support retry/resume without duplicate logical runs;
- keep Fleet as a peer mode.

**Acceptance:** Forced retries and partial source failures preserve one coherent logical run.

**Depends on:** ARCH-201.

---

### ARCH-203 — Deterministic canonical mapping

- exact ID/signature match first;
- subset → `UNDERSIZED_VARIANT`;
- expansion/flex handling;
- existing-profile similarity rules;
- mechanical confidence bound;
- unresolved observations remain unresolved;
- no archetype creation.

**Acceptance:** Known fixtures map deterministically; undersized teams never become new identities; ambiguous cases remain queued for semantic review.

**Depends on:** ARCH-202.

---

### ARCH-204 — Bounded semantic review

- define the minimal structured input for ambiguous mapping or strategic-distinction assessment;
- ensure retrieved content is treated as untrusted data;
- prevent semantic output from writing canonical tables;
- allow semantic analysis only to lower confidence;
- record model/analyst version and reasoning;
- provide deterministic fallback to `OBSERVE` when unavailable.

**Acceptance:** Disabling the semantic component does not stop ingestion or deterministic findings; no credential or write path is exposed to it.

**Depends on:** ARCH-203. May be omitted if GATE-200 proves deterministic mapping sufficient.

---

### ARCH-205 — Assessments, findings and policy

- calculate provider-supported measures;
- implement initial tier and threat assessment only;
- enforce authority states;
- retain banner/undersize as advisory findings only;
- implement usefulness, hysteresis, staleness, duplicate and anomaly rules;
- version `maintenance/policy.yaml`;
- generate `PUBLISH`, `OBSERVE`, `ESCALATE` and `REJECT` findings.

**Acceptance:** Fixtures cover every decision state and policy boundary; locked values never become applicable changes.

**Depends on:** ARCH-203 and optional ARCH-204.

---

### ARCH-206 — Deterministic applier and non-current candidate

- provide an on-demand report-only entry point so a maintenance review can be run outside the eventual schedule;
- record whether each run was triggered manually or by schedule;
- re-evaluate every `PUBLISH` finding against the checked-in policy;
- record enforced policy version;
- demote failed findings to `OBSERVE` with reason;
- apply permitted mutations only in an isolated candidate context;
- generate and validate a static artifact;
- prevent pointer updates unconditionally in report-only mode;
- produce a concise diff against the current release.

**Acceptance:** A user can manually trigger a report-only run and receive the same candidate and findings that the scheduled path would produce from the same inputs. No Stage 2 code path can update `catalogue_state` or the production pointer, even with an analyst credential.

**Depends on:** ARCH-205 and Stage 1 publisher.

---

### ARCH-207 — Report-only validation period

Run at least two representative completed same-format events.

Review:

- mapping accuracy;
- false new-identity pressure;
- proposed tier/threat changes;
- authority-state behaviour;
- duplicate/staleness findings;
- silent `OBSERVE` behaviour;
- anomaly response;
- source outages;
- reproducibility and provenance;
- user value versus operational noise.

**Stage 2 exit gate:**

- no unexplained canonical mapping error;
- no proposed change bypasses policy;
- findings are useful enough to justify scheduling;
- anomaly tests fail closed;
- all proposals can be reproduced from stored evidence;
- user explicitly approves Stage 3 activation work.

**Rollback:** Disable ingestion. Stage 1 remains unchanged.

---

# Stage 3 — Scheduling and bounded autonomous publication

## 10. Stage 3 objective

Run eligible maintenance cycles unattended, publish only validated changes, and involve the user only for failure or genuine escalation.

## 11. Stage 3 work packages

### ARCH-301 — Scheduler and readiness detection

- expose an explicit on-demand trigger as well as the schedule;
- make report-only the safe default for a manual maintenance trigger;
- allow manual publication only through the normal eligible-publication path, never as a validation bypass;
- route scheduled and manual triggers into the same versioned command/function;
- record trigger type, initiator and supplied cycle/mode inputs;
- schedule at the lowest useful cadence;
- detect completed events and source readiness;
- create/resume one logical run;
- prevent overlapping active attempts;
- back off on rate limits and source outages;
- produce no alert for ordinary “not ready” results.

**Acceptance:** Duplicate scheduler triggers create no duplicate run or release. A manual run for the same cycle/mode either resumes the same eligible logical run or is rejected with a clear reason; it never creates a competing publication.

---

### ARCH-302 — Autonomous publication activation

- enable production pointer updates only for eligible `MAINTENANCE` releases;
- retain publication lock and base-release checks;
- refuse anomaly-blocked runs;
- support `APPROVED_OVERRIDE` only through explicit human action;
- preserve authored locks and note authority;
- publish versioned artifact before pointer.

**Acceptance:** A forced mid-publication failure leaves the previous artifact current.

**Depends on:** ARCH-301 and Stage 2 approval.

---

### ARCH-303 — Reporting and escalation

Routine success report:

- cycle/mode;
- evidence volume and mapping rate;
- published changes;
- observed findings count;
- release/version/checksum;
- rollback reference.

Alert only for:

- source or parser failure after retry policy;
- validation or publication failure;
- anomaly stop;
- genuine `ESCALATE` decision.

`OBSERVE` findings remain silent unless explicitly requested.

**Acceptance:** A no-change successful run creates no user task.

---

### ARCH-304 — Operational hardening and activation

Prove:

- retry after interrupted ingestion;
- retry after candidate generation;
- concurrent scheduler trigger;
- source unavailable;
- malformed source;
- semantic component unavailable;
- database unavailable while app remains usable;
- artifact storage unavailable;
- pointer update unavailable;
- rollback to prior compatible release;
- restoration after erroneous but structurally valid release;
- disable switch for all scheduling.

**Stage 3 exit gate:**

- two consecutive unattended eligible cycles complete correctly;
- reporting remains concise;
- failure injection leaves production usable;
- rollback is demonstrated;
- the user approves routine autonomous operation.

**Rollback:** Disable scheduling and repoint to the last human-approved compatible release.

---

## 12. Manual configuration plan

The goal is one substantial session in Stage 1.

| Configuration | Stage 1 session | Later action |
|---|---|---|
| Database project/region | Create and verify | None unless provider changes |
| Database roles/credentials | Configure authoring, publisher and reserved maintenance roles | Populate evidence credential only after GATE-200 |
| GitHub environments | Development and production | None |
| Repository secrets | Database, publisher, artifact storage, roster proxy config | Add provider secret value after GATE-200 |
| Static hosting | Configure development and production publication | None |
| Workflow permissions | Configure CI, candidate and explicit production workflows | Enable scheduled workflow only in Stage 3 |
| Repository consolidation | Configure target route and fallback | Retire old live repo only after acceptance |
| Backup/recovery | Verify export and documented restore | Periodic verification through automation where possible |

If provider UI or account restrictions force another substantial manual setup later, stop and present the reason before expanding the programme.

---

## 13. Manual and on-demand operations

Two separate on-demand paths are required.

### 13.1 Human authoring

The owner or control chat can initiate an authoring run at any time:

1. prepare a validated change file;
2. run a dry run;
3. inspect the canonical and payload diff;
4. apply the change through the authoring loader;
5. generate and validate an `AUTHORING` candidate;
6. publish only after the normal publication gates pass.

Human authoring is independent of the maintenance schedule.

### 13.2 Maintenance review

The owner or control chat can trigger a maintenance review outside the schedule.

The trigger must accept only bounded, validated inputs such as mode, cycle key and report-only/publication intent. Report-only is the default. It uses the same ingestion, mapping, assessment, policy, anomaly and validation code as a scheduled run.

A manual trigger:

- does not lower evidence thresholds;
- does not bypass an anomaly;
- does not override `AUTHORED_LOCKED` values;
- does not write the production pointer unless it is explicitly a publication run and every ordinary gate passes;
- records who/what triggered it;
- remains idempotent for the same cycle and mode.

This capability is required in Stage 2 for report-only analysis and retained in Stage 3 after scheduling is enabled.

---

## 14. Control-chat operating model

This conversation is the programme control thread.

The control thread owns:

- current work-package selection and status;
- architectural and product decisions;
- dependency and acceptance-gate checks;
- manual-configuration guidance;
- review of breakout results against fresh repository evidence;
- the next self-contained handoff prompt;
- decisions to pause, rollback, cut over or activate autonomy.

### 14.1 Coding breakouts

Each coding session receives a self-contained prompt for one work package or an explicitly bounded part of one.

Every coding prompt must include:

- repository and branch;
- a recommended coding-agent reasoning effort level, with a one-sentence justification;
- requirement to report the fresh full `main` SHA;
- instruction to read `AGENTS.md`, this plan and all task-relevant authorities;
- objective, deliverables and precise exclusions;
- current dependencies and prerequisite evidence;
- expected files or components to inspect without assuming their contents;
- tests and acceptance criteria;
- documentation-update rules;
- permission to commit directly to `main` where appropriate;
- an explicit prohibition on production deployment unless that work package authorises it;
- required final report: resulting SHA, files changed, tests run, validation evidence, decisions and blockers.

The control thread also states the recommended effort level outside the prompt when handing it to the user, so the setting is visible before the breakout begins.

After a breakout returns, the control thread independently refreshes repository evidence before accepting completion or preparing the next task.

### 14.2 Deep-analysis breakouts

Use a read-only analysis breakout when a decision needs substantial research, comparison or failure-mode testing before code is appropriate.

Analysis prompts must:

- state that no repository or external-system changes are authorised;
- identify the exact decision to resolve;
- distinguish fact, inference and recommendation;
- return concrete options, trade-offs and a recommended decision;
- identify time-sensitive facts that require current verification.

### 14.3 Manual steps

Whenever the user must configure GitHub, the database host, static hosting, Apps Script or another external service, the control thread provides:

1. the purpose of the configuration;
2. numbered, click-by-click instructions using current interface labels;
3. the exact value or value pattern to enter;
4. which values are secret and must not be pasted into chat or committed;
5. a verification step after each logical group;
6. an explicit stop point if the displayed options differ;
7. the rollback or removal action where relevant.

Do not distribute avoidable configuration across later stages. Prepare the full Stage 1 checklist before asking the user to begin the concentrated configuration session.

---

## 15. Agent execution protocol

Each work package should be handed to a coding agent separately using a self-contained prompt.

Every prompt must require the agent to:

1. report the fresh full `main` SHA;
2. read `AGENTS.md` and relevant authorities;
3. confirm the work-package scope and exclusions;
4. inspect the current implementation before editing;
5. preserve unrelated user changes;
6. implement only the named package;
7. add or update tests;
8. run the relevant suite;
9. review the diff;
10. update this plan's work-package status and evidence;
11. update `SPEC.md` only when shipped current behaviour changes;
12. update `changelog.md` only when a release actually ships;
13. avoid production deployment unless the package is ARCH-112 or ARCH-302 and explicitly approved.

A work package may be split into smaller coding tasks when needed, but the package acceptance gate remains singular and the split does not create another programme stage.

---

## 16. Status tracking

Use these states:

- `Not started`
- `Ready`
- `In progress`
- `Blocked`
- `Validation`
- `Complete`
- `Abandoned`

Initial status:

| Item | Status |
|---|---|
| ARCH-101 | Complete |
| ARCH-102 | Not started |
| ARCH-103 | Not started |
| ARCH-104 | Not started |
| ARCH-105 | Not started |
| ARCH-106 | Not started |
| ARCH-107 | Not started |
| ARCH-108 | Not started |
| ARCH-109 | Not started |
| ARCH-110 | Not started |
| ARCH-111 | Not started |
| ARCH-112 | Not started |
| GATE-200 | Not started |
| ARCH-201–207 | Not started |
| ARCH-301–304 | Not started |

Only one implementation work package should normally be `In progress` at a time. Documentation preparation or independent read-only evidence gathering may overlap where the dependency table permits.

---

## 17. Explicit exclusions

This programme does not include:

- redesigning the PWA interface;
- changing allocation, battle-order or scoring objectives;
- per-battle undersize advice;
- rewriting the app in a framework;
- cloud-backed player roster storage;
- replacing Comlink;
- replacing the Apps Script roster proxy without a separate trigger;
- tactical-note generation by AI;
- autonomous banner or undersize publication in the initial engine;
- long-lived Sheet/database dual-write;
- public distribution or multi-user administration;
- adding paid services without an explicit cost decision.

These remain separate roadmap or architectural decisions.

---

## 18. Definition of programme complete

The programme is complete only when:

- Stage 1 has replaced the catalogue runtime and survived its fallback window;
- Stage 2 has validated real evidence in report-only mode;
- Stage 3 has completed two unattended eligible cycles;
- production works from cached static catalogue data without database availability;
- human authoring remains available and documented;
- every autonomous change is reproducible and policy-enforced;
- failures and anomalies do not partially publish;
- rollback is proven;
- routine success creates no user administration;
- current behaviour and release history have been moved into their proper authorities.
