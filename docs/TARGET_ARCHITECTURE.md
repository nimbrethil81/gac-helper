# SWGOH GAC Helper — Target Architecture

**Status:** Proposed design v0.4, revised after independent peer review, the accepted ARCH-102 platform decisions, and the accepted bootstrap/calibration safety design. Not yet fully implemented.

**Scope.** This document defines the proposed target architecture for modernising GAC Helper's canonical data platform, authoring model, repository and deployment model, and autonomous counter maintenance. It is a future-state design authority, not a description of the shipped system. The current system remains defined by [`SPEC.md`](SPEC.md), and prioritisation remains in [`ROADMAP.md`](../ROADMAP.md).

**Platform decisions.** The Stage-1 host, environment, publication, secret, role and threat-model decisions referenced throughout this document (Cloudflare Workers as production static host, Supabase Free/London as the Stage-1 canonical database, the distributed publication protocol, the Stage-1 role inventory, and the accompanying threat and recovery model) are recorded authoritatively in [`docs/decisions/ADR-ARCH-102-platform.md`](decisions/ADR-ARCH-102-platform.md). This document reflects those accepted decisions; the ADR owns their justification, rejected alternatives, and re-verification requirements.

**Update this document when** an architectural decision below is accepted, revised or rejected during review or implementation. Once the target architecture ships, move enduring current-state facts into `SPEC.md` and either retire this document or reduce it to decisions not captured elsewhere.

This design intentionally optimises for:

- a single-user hobby application;
- minimal or zero additional running cost;
- low ongoing human administration;
- a compact, useful counter catalogue rather than exhaustive squad permutations;
- a first-class human authoring path alongside bounded autonomous maintenance;
- conservative, enforceable and auditable automation;
- strong offline behaviour during live GAC rounds;
- simple rollback and recovery rather than enterprise-scale migration choreography;
- the fewest sensible implementation stages, with manual cloud configuration concentrated into one session.

---

## 1. Context and problem

The current PWA is static. Authored counter data lives in Google Sheets, which is both the canonical data store and the owner's authoring surface. Google Apps Script converts the Sheet to JSON and separately proxies roster requests to Comlink. Development and live code are held in separate repositories with a manually triggered, allow-listed promotion workflow.

The current app renders player state from local storage, but the catalogue itself is not currently cache-first: a failed catalogue fetch prevents normal startup. Correcting that is part of the target architecture, not an existing capability.

The current arrangement has served the product well, but it limits safe autonomous maintenance:

- identity and duplicate rules are not enforced relationally;
- defence teams lack stable identities;
- a statistical observation can too easily be confused with a canonical team identity;
- updates overwrite judgements without retaining evidence or assessment history;
- publication is not naturally atomic;
- an autonomous process would need authority that is difficult to bound safely in a spreadsheet;
- replacing the Sheet without replacing its authoring capability would make routine maintenance harder.

The target architecture replaces Google Sheets as the runtime data platform with a Postgres-compatible canonical store, a version-controlled human-change path and an immutable static catalogue artifact. Evidence, assessment, canonical mutation and publication are separate steps so observations cannot become live product knowledge without policy enforcement and whole-catalogue validation.

Repository consolidation remains a desired target, but it is not a prerequisite for the data-platform migration. It must preserve the current fail-closed public deployment boundary and may proceed only after automated checks exist.

This document does not itself authorise database creation, repository consolidation, migration, deployment or autonomous publication. Each requires approved implementation work.

---

## 2. Architectural principles

### 2.1 Strategic identity over observed composition

The canonical catalogue stores strategic team identities, not every squad permutation seen in source data.

> Prefer the smallest set of canonical identities that preserves strategically meaningful differences.

Observed compositions may justify a new identity only when variation materially changes at least one of:

- leader or defining core;
- roster-resource contention;
- matchup behaviour or reliability;
- recommendation value;
- recognition as a genuinely separate game archetype.

A different flex unit alone does not justify a new identity.

### 2.2 One team registry

Attacking counters and defensive teams are both strategic team archetypes. One `team_archetypes` registry replaces separate counter and defence registries.

A matchup assigns one archetype the defence role and another the attack role for a particular GAC mode.

### 2.3 Evidence, judgement and publication are separate

An observation or source win rate does not become live knowledge directly. The pipeline is:

1. ingest immutable source evidence;
2. map it to existing canonical identities where possible;
3. calculate mechanical measures and confidence;
4. create assessments and findings;
5. make a policy decision;
6. have a deterministic applier re-check policy and create canonical mutations;
7. generate and validate a complete candidate catalogue;
8. publish an immutable artifact atomically.

The semantic analyst proposes. It never writes canonical catalogue tables or the live-release pointer.

### 2.4 Consolidation over proliferation

Before proposing a new archetype, the system must attempt:

1. exact existing identity;
2. existing identity with different flex members;
3. existing identity with different recommended members;
4. undersized or expanded observation of an existing profile;
5. existing identity requiring a profile update;
6. only then, a genuinely new archetype.

The maintenance objective is:

> Maximise useful counter coverage while minimising redundant catalogue entries.

Completeness is deliberately not the publication objective:

> **Completeness is a discovery goal, not a publication goal. Canonical counter data must meet evidence and quality thresholds regardless of catalogue coverage.**

Broad discovery may therefore produce a large staged backlog without creating any corresponding obligation to publish it. A small catalogue of differentiated, reliable counters is preferable to a large catalogue padded with mediocre or weakly evidenced alternatives.

### 2.5 Omission over unsupported precision

Where evidence is insufficient, the safe result is normally `OBSERVE`, not a speculative catalogue change or a question for the user.

Uncertainty becomes a human task only when it is materially relevant, sufficiently evidenced to require a decision now, and not safely resolvable by policy.

### 2.6 Human authoring remains first-class

Autonomy complements rather than replaces the owner.

Routine additions and corrections must not require hand-written SQL. Human-authored changes use version-controlled change files or an equivalent validated interface, pass through the same deterministic validator, and create the same immutable release type as automated changes.

Human authority is explicit per field:

- `AUTHORED_LOCKED` — automation may propose a change but cannot apply it;
- `AUTHORED_BASELINE` — automation may change it only with high confidence and full policy compliance;
- `ASSESSED` — routine autonomous maintenance is permitted.

Migrated Sheet values begin as `AUTHORED_BASELINE` unless deliberately locked. Tactical notes are always human-authored in the initial design.

### 2.7 Atomic, reversible publication

A publication either succeeds as one validated release or changes nothing. Candidate generation is based on an identified base release. Publication refuses to proceed if the current release has moved.

Rollback selects a prior compatible immutable artifact; it does not reverse individual mutations.

### 2.8 Static, cache-first live application

The PWA must not depend on a running database during a live GAC round.

The live app consumes a versioned static catalogue artifact and a small current-version pointer from the same reliable static-delivery path as the app. It renders a validated cached catalogue first and refreshes in the background. A failed refresh never overwrites a known-good cache or blocks an offline round.

The database is the maintenance and authoring store, not the live app's runtime dependency.

### 2.9 Cost restraint and provider neutrality

The logical model is Postgres-compatible and must not depend on a proprietary hosting feature without a justified need.

The target avoids requiring a paid AI API. Exact matching, thresholds, confidence bounds, policy checks and publication are deterministic. AI is used only for genuinely semantic work such as ambiguous identity mapping, strategic-distinction assessment and explanations.

Evidence availability may prove a larger cost or feasibility constraint than the AI runner. No maintenance engine is committed until the evidence source, permitted retrieval method, useful granularity and recurring cost are verified.

---

## 3. Target topology

The desired eventual repository shape is illustrative:

```text
gac-helper/
  app/                 PWA
  maintenance/         ingestion, mapping, assessment and publication code
  db/                  portable schema, migrations and database functions
  data/                reviewed human-authored change files and migration seeds
  catalogue/           generated static catalogue artifacts or manifests
  docs/                product, architecture and operational authorities
  tests/               contract, migration, policy and end-to-end tests
```

The database remains canonical after approved changes are applied. Files under `data/` are auditable inputs or change requests, not a second mutable catalogue.

The target data flow is:

```text
Human change request          External GAC evidence
        |                              |
        v                              v
Validated authoring loader     Immutable observations
        |                              |
        |                    Deterministic mapping first
        |                              |
        |                    Semantic proposal if ambiguous
        |                              |
        +-----------> Findings and assessments
                               |
                    Deterministic policy applier
                               |
                      Canonical catalogue state
                               |
                 Candidate built from base release
                               |
                Whole-catalogue validation and lock
                               |
                 Immutable versioned static artifact
                               |
                  Current-version pointer updated
                               |
                    PWA cache then background refresh
```

Target components:

- **GitHub (Free plan):** source, change files, schema migrations, policy, tests and deployment workflows. Repository secrets plus explicit manual `workflow_dispatch` triggers are the Stage-1 production gate, in place of GitHub Environments (not available for a private repository on GitHub Free); see [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1, §3.
- **Postgres-compatible database — Supabase Free, London region (Stage-1 canonical, subject to ARCH-104 re-verification):** canonical catalogue, evidence, assessments, findings, authoring records and release metadata. Selected as the current use of the account's one remaining free project slot; reversible through a separate approved plan if another owner-operated application later needs the slot more. Development and schema rehearsal use a local, disposable Postgres instance; exactly one hosted project is canonical. See [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.3–§1.4, §3.
- **Static hosting — Cloudflare Workers static assets:** the PWA plus immutable versioned catalogue artifacts and a small current-version pointer, replacing GitHub Pages as the production host because the account is GitHub Free and private-repository Pages is not available on it. A separate, publicly reachable development Worker (marked `noindex`, carrying no credentials or personal data, treated as a preview rather than an access-controlled environment) serves unpublished/candidate artifacts for inspection. See [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.2, §1.5, §3, §4.
- **Deterministic maintenance runner:** scheduled ingestion and rule-based analysis, with AI invoked only for bounded semantic cases. Selection remains deferred to the Stage 2 evidence gate (§20).
- **Google Apps Script:** retained initially only as the roster proxy to Comlink; its `action=data` route is retired after a proved fallback period.
- **Comlink:** existing read-only roster source unless separately replaced.
- **Google Sheets:** migration source and temporary cutover fallback, not part of the target steady-state runtime.
- **Existing public `gac-helper` repository and its GitHub Pages deployment:** retained, unchanged, as a fallback production route through the Stage-1 acceptance window defined in §14–§15; not part of the target steady-state runtime, and retired only at the ARCH-112 exit gate.

---

## 4. Data domains

The schema has six domains:

1. **Canonical catalogue** — units, strategic identities, profiles and matchups.
2. **Accepted catalogue values** — the current tier, banner, undersize, threat and notes used to generate releases.
3. **Human authoring** — idempotent reviewed changes and their application history.
4. **Evidence and assessment** — source observations, mappings, assessments and findings.
5. **Publication** — immutable release metadata, provenance and current-release state.
6. **Application configuration** — board and scoring rules outside autonomous counter authority.

All timestamps are timezone-aware. Stable public codes are immutable after publication. Internal relational keys may use UUIDs.

---

## 5. Canonical catalogue model

### 5.1 `units`

One row per playable character, ship or capital ship.

| Field | Purpose |
|---|---|
| `unit_id` | Stable internal readable key, preserving today's `Character_ID` |
| `display_name` | Current user-facing name |
| `external_id` | Game/Comlink base ID used only as a translation adapter |
| `unit_type` | `CHARACTER`, `SHIP` or `CAPITAL_SHIP` |
| `active` | Unit lifecycle state |
| `created_at`, `updated_at` | Audit timestamps |

Constraints:

- `unit_id` is unique and immutable.
- `external_id` is unique when present.
- every required member of a published profile has a non-empty `external_id`;
- automation may identify a missing unit but may not create or alter `external_id` without a trusted, human-approved source;
- display-name changes do not change identity.

### 5.2 `team_archetypes`

One row per strategic team identity, regardless of attack or defence use.

| Field | Purpose |
|---|---|
| `archetype_id` | Internal relational key |
| `archetype_code` | Stable readable unique code |
| `display_name` | User-facing identity |
| `battle_type` | `SQUAD` or `FLEET` |
| `status` | `ACTIVE`, `RETIRED` or `MERGED` |
| `merged_into_id` | Successor identity for a merged row |
| `identity_reason` | Controlled reason the identity exists |
| `identity_reason_detail` | Required explanation for `OTHER_APPROVED` |
| `created_by` | `HUMAN` or `AUTOMATION` |
| `created_at`, `updated_at` | Audit timestamps |

Initial `identity_reason` values:

- `DISTINCT_LEADER`
- `DISTINCT_CORE`
- `DISTINCT_RESOURCE_CONFLICT`
- `DISTINCT_MATCHUP_BEHAVIOUR`
- `NEW_GAME_ARCHETYPE`
- `LEGACY_MIGRATION`
- `OTHER_APPROVED`

At migration, every attack archetype preserves today's `Counter_ID` exactly as `archetype_code`. Existing display names and public mode strings remain byte-identical during cutover so persisted client state is not orphaned.

### 5.3 `team_profiles`

An archetype answers “what strategic team is this?” A profile answers “what does this team require in this role and format?”

| Field | Purpose |
|---|---|
| `profile_id` | Internal key |
| `archetype_id` | Parent identity |
| `mode` | `ANY`, `3V3`, `5V5` or `FLEET` internally |
| `usage_role` | `ATTACK` or `DEFENCE` |
| `flex_slots` | Number of canonical flex positions |
| `members_complete` | Whether membership is exhaustive for availability filtering |
| `status` | `ACTIVE` or `RETIRED` |
| `created_at`, `updated_at` | Audit timestamps |

Unique on `(archetype_id, mode, usage_role)`.

A mode-specific profile overrides `ANY`. Existing squad counter compositions migrate once as `ANY` attack profiles because they are currently shared across 3v3 and 5v5. A mode-specific row is introduced only where evidence or authoring proves the required core differs.

`REQUIRED`, `RECOMMENDED` and `flex_slots` intentionally reproduce the current model. They do not express faction-constrained flex slots or alternative-member groups; those remain notes/recommended-member guidance until real cases justify a more complex schema.

The app-facing payload continues to use the exact existing mode strings `3v3`, `5v5` and `FLEET`. Internal enum casing must never leak into persisted client keys.

### 5.4 `team_profile_members`

| Field | Purpose |
|---|---|
| `profile_id` | Parent profile |
| `unit_id` | Member unit |
| `member_role` | `REQUIRED` or `RECOMMENDED` |
| `is_leader` | Canonical leader flag |
| `sort_order` | Stable display order |

Unique on `(profile_id, unit_id)`.

Required-member changes receive stronger scrutiny because they affect ownership, resource conflicts and characters committed to defence.

### 5.5 `matchups`

One canonical relationship between a defence archetype and a counter archetype in a mode.

| Field | Purpose |
|---|---|
| `matchup_id` | Internal key |
| `mode` | `3V3`, `5V5` or `FLEET` |
| `defence_archetype_id` | Defending identity |
| `counter_archetype_id` | Attacking identity |
| `status` | `ACTIVE` or `RETIRED` |
| `created_at`, `updated_at` | Audit timestamps |
| `retired_at` | Retirement timestamp |
| `retired_reason` | Evidence-backed reason |
| `retired_by_run_id` | Maintenance run where applicable |

Hard uniqueness:

```text
(mode, defence_archetype_id, counter_archetype_id)
```

### 5.6 `matchup_catalogue_values`

The current accepted player-facing values for a matchup.

| Field | Purpose |
|---|---|
| `matchup_id` | One-to-one parent |
| `tier` | `S`, `A`, `B` or `C` |
| `banner_score` | Full-squad, first-attempt, clean-clear expected value |
| `undersize` | Safe droppable-unit count |
| `notes` | Human-authored tactical advice |
| `tier_authority` | `AUTHORED_LOCKED`, `AUTHORED_BASELINE` or `ASSESSED` |
| `banner_authority` | Same authority states |
| `undersize_authority` | Same authority states |
| `source_assessment_id` | Assessment supporting an assessed value |
| `source_finding_id` | Applied finding where relevant |
| `updated_at` | Audit timestamp |

Notes are human-authored only in the initial architecture and have no autonomous authority state.

A high-confidence assessment may update `AUTHORED_BASELINE` tier values through the deterministic applier. `AUTHORED_LOCKED` values can produce findings but cannot be changed autonomously.

Banner and undersize remain human-authored during the initial autonomous implementation because the proposed aggregate evidence cannot reliably derive their current product meanings. Automation may create `OBSERVE` or `ESCALATE` findings about them but may not publish changes until a later evidence contract proves that first-attempt, team-size and clean-win semantics are available.

### 5.7 `defence_catalogue_values`

One current value row per defence archetype and applicable mode.

| Field | Purpose |
|---|---|
| `archetype_id`, `mode` | Defence identity and format |
| `threat` | `LOW`, `NORMAL`, `HIGH` or `EXTREME` |
| `notes` | Human-authored defence guidance |
| `threat_authority` | `AUTHORED_LOCKED`, `AUTHORED_BASELINE` or `ASSESSED` |
| `source_assessment_id`, `source_finding_id` | Provenance |
| `updated_at` | Audit timestamp |

A mode-specific row overrides `ANY`.

### 5.8 Counter-less defence identities

A defence archetype may exist without a published counter. The app-facing catalogue includes it so the user can place it on a board, receive its threat classification, and see an explicit “no counters in the catalogue yet” result.

Allocation and Battle Order must handle a zero-candidate defence safely.

---

## 6. Human authoring model

Human authoring uses reviewed, version-controlled change files or an equivalent agent-generated interface. It must be usable without direct SQL.

A change contains:

- stable change ID;
- author and timestamp;
- intended entity and operation;
- expected current/base release;
- structured values;
- authority state for judgement fields;
- concise reason.

The loader is idempotent and records applied changes in `authoring_changes`. It validates identifiers, relationships, enums, banner bounds and required external IDs before mutating canonical state.

Human publication uses the same candidate generator and validator as maintenance publication, with:

- `maintenance_run_id = NULL`;
- `release_reason = AUTHORING`;
- full provenance back to the authoring change.

Initial migration seeds may contain the complete legacy catalogue. After cutover, routine files should describe discrete changes rather than duplicate the full database.

`Score_Meanings` is not migrated as runtime data. Its enduring guidance remains in `SCORING_REFERENCE.md`.

---

## 7. Evidence model

### 7.1 Evidence-source entry gate

Stage 2 may not begin until a short spike identifies:

1. the exact provider and dataset;
2. a stable retrieval method;
3. evidence that automated retrieval is permitted;
4. the available dimensions and aggregation semantics;
5. representative sample sizes by matchup and mode;
6. recurring cost;
7. retry, rate-limit and source-outage behaviour.

If no lawful, sufficiently useful and acceptably priced source exists, the programme stops after Stage 1. The canonical platform and improved authoring/publication model remain independently valuable.

### 7.2 `evidence_sources`

| Field | Purpose |
|---|---|
| `source_id` | Internal key |
| `source_code` | Stable provider code |
| `name` | Display name |
| `active` | Ingestion state |
| `priority` | Deterministic precedence |
| `terms_checked_at` | Date retrieval permission was last confirmed |
| `retrieval_contract_version` | Parser/source contract version |

### 7.3 `evidence_observations`

One immutable retrieved source grouping.

| Field | Purpose |
|---|---|
| `observation_id` | Internal key |
| `source_id` | Provider |
| `maintenance_run_id` | Ingestion run |
| `source_cycle_key` | Provider's exact cycle identifier |
| `mode` | Relevant GAC mode |
| `observed_defence_signature` | Deterministic external-unit-ID signature |
| `observed_attack_signature` | Deterministic external-unit-ID signature |
| `source_url` | Traceable location |
| `source_data` | Original useful fields as JSONB |
| `content_hash` | Idempotency key |
| `retrieved_at` | Retrieval timestamp |

Do not freeze guessed provider measures into the Stage 1 schema. Normalised battle counts, wins and other measures are added in Stage 2 only after the provider contract is known. Raw source semantics remain preserved in `source_data`.

Individual battles or distribution buckets are added only if the selected source supplies them and a supported assessment needs them.

### 7.4 `evidence_mappings`

| Field | Purpose |
|---|---|
| `observation_id` | Source observation |
| `defence_archetype_id` | Mapped defence |
| `counter_archetype_id` | Mapped counter |
| `mapping_confidence` | Numeric mechanical bound from 0 to 1 |
| `mapping_method` | `EXACT`, `RULE` or `AI` |
| `mapping_outcome` | `CANONICAL`, `FLEX_VARIANT`, `UNDERSIZED_VARIANT`, `EXPANDED_VARIANT` or `UNRESOLVED` |
| `observed_attack_unit_count` | Supports safe interpretation of team size |
| `mapping_notes` | Concise rationale |

A strict subset of an existing profile maps as `UNDERSIZED_VARIANT` and cannot justify a new archetype or required-core change. Added members consume flex slots first and map as `EXPANDED_VARIANT` where appropriate.

AI may lower mapping confidence because of semantic ambiguity but may not raise it above the mechanical bound.

---

## 8. Assessment and maintenance model

### 8.1 `matchup_assessments`

Append-only assessment of a matchup.

| Field | Purpose |
|---|---|
| `assessment_id` | Internal key |
| `matchup_id` | Assessed relationship |
| `maintenance_run_id` | Producing run |
| `normalised_measures` | Provider-independent measures as JSONB |
| `proposed_tier` | Proposed `S`, `A`, `B` or `C` |
| `proposed_banner_score` | Advisory only until evidence eligibility is proven |
| `proposed_undersize` | Advisory only until evidence eligibility is proven |
| `confidence_score` | Numeric mechanical confidence from 0 to 1 |
| `evidence_summary` | Concise evidence explanation |
| `reasoning_summary` | Policy/semantic reasoning |
| `method_version` | Algorithm version |
| `created_at` | Timestamp |

Confidence bands are derived for display rather than stored independently.

### 8.2 `defence_assessments`

Append-only assessment of a defence archetype and mode, containing provider-supported measures, proposed threat, confidence, reasoning, method version and run provenance.

Threat remains deliberately coarse and serves battle ordering rather than a general meta ranking.

### 8.3 `maintenance_runs`

| Field | Purpose |
|---|---|
| `run_id` | Internal key |
| `cycle_key` | One completed three-round GAC event identifier |
| `mode` | `3V3`, `5V5` or `FLEET` |
| `attempt` | Retry/supersession number |
| `triggered_at`, `evidence_ready_at`, `completed_at` | Lifecycle timestamps |
| `status` | Run state/result |
| `policy_version` | Enforced policy revision |
| `analyst_version` | Semantic component version, if used |
| `source_snapshot` | Retrieval metadata |
| `published_release_id` | Resulting release where applicable |

`cycle_key` uses a documented stable form such as `S{season}-E{event}` and represents a completed GAC event, not one battle round. Source round data may be aggregated into the event.

A partial unique constraint permits only one active attempt for `(cycle_key, mode)` while retaining failed and superseded attempts.

Fleet is a peer mode, not a boolean attached to squad runs.

### 8.4 `maintenance_findings`

Initial finding types:

- `NEW_ARCHETYPE`
- `NEW_MATCHUP`
- `TIER_CHANGE`
- `BANNER_CHANGE`
- `UNDERSIZE_CHANGE`
- `THREAT_CHANGE`
- `COMPOSITION_CHANGE`
- `NOTE_CHANGE`
- `POSSIBLE_DUPLICATE`
- `STALE_MATCHUP`
- `RETIREMENT_CANDIDATE`
- `MISSING_UNIT`

Core fields include run, type, subject, structured proposed change, mechanical confidence, decision, reasoning, proposed policy version, enforced policy version and application result.

Decision meanings:

| Decision | Meaning | Human action |
|---|---|---|
| `PUBLISH` | Eligible for deterministic application and candidate validation | None |
| `OBSERVE` | Potentially meaningful but insufficient | None |
| `ESCALATE` | Material decision cannot safely be resolved by policy | User decision |
| `REJECT` | Noise, invalid evidence, duplication or disproven hypothesis | None |

A `PUBLISH` decision is a proposal, not permission to write canonical state. The deterministic applier re-evaluates policy.

---

## 9. Publication model

### 9.1 `catalogue_releases`

Each release records:

| Field | Purpose |
|---|---|
| `release_id` | Internal key |
| `version` | Monotonic public version |
| `payload_schema_version` | App compatibility contract |
| `base_release_id` | Release used to construct the candidate |
| `previous_release_id` | Explicit published chain |
| `maintenance_run_id` | Producing run, nullable for migration/authoring |
| `release_reason` | `MIGRATION`, `AUTHORING`, `MAINTENANCE` or `APPROVED_OVERRIDE` |
| `scope` | Release metadata |
| `status` | `CANDIDATE`, `PUBLISHED`, `SUPERSEDED` or `REJECTED` |
| `payload` | Complete generated JSON |
| `checksum` | Integrity/idempotency |
| `created_at`, `published_at` | Lifecycle timestamps |

The payload includes:

- payload schema and catalogue versions;
- units and external-ID mapping;
- attack and defence identities;
- resolved profiles and compositions;
- matchups;
- tier, banner, undersize and notes;
- threat and defence notes;
- board configuration and scoring;
- provenance references ignored by the PWA but retained for audit.

### 9.2 `catalogue_state` and concurrency

A singleton row holds `current_release_id`.

Publication spans two independent systems — the database and Cloudflare Workers — and is **not** one atomic transaction across them. It uses a `READY`/`DEPLOYED` release lifecycle with HTTP verification between phases, defined precisely in [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.1:

1. generate and validate a candidate against an explicit base release (no writes yet);
2. in a short database transaction: take the advisory lock, re-check the base release, allocate the monotonic version, insert an immutable release with `status = READY`, and commit **without** moving `current_release_id`;
3. write the immutable artifact and static pointer;
4. deploy artifact and pointer together as one Cloudflare Worker version;
5. verify over HTTP — pointer, artifact, payload schema version, catalogue version, checksum;
6. in a second short database transaction, mark the release `DEPLOYED` and move `current_release_id`;
7. record the deployed commit SHA and the Cloudflare version/deployment identifier on the release row.

Recovery for every failure window in this sequence (Cloudflare deployment failure, HTTP verification failure, database finalization failure) is defined in [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4.2, including an idempotent reconciliation command and a GitHub Actions concurrency group that prevents two production deployments running simultaneously. A failed artifact write does not advertise the new release. A failed pointer write, or a verification failure, leaves clients on the prior artifact and leaves the release `READY` rather than `DEPLOYED`.

### 9.3 Static artifact and client contract

Static artifacts are served as Cloudflare Workers static assets, from the same Worker that serves the PWA (see [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4). The mechanism provides:

- immutable versioned URLs;
- a tiny current-version pointer;
- the safely-ordered, verified publication sequence in §9.2 (not a single cross-system atomic transaction);
- compatibility with the existing static host;
- retention of prior compatible releases;
- no database dependency for ordinary PWA reads.

The static deployed pointer is authoritative for what the phone currently sees. The database's `current_release_id` records the verified-deployed state as understood by the publication tooling, and is expected to agree with the static pointer once step 6 above completes.

The PWA:

- validates `payload_schema_version` and required fields before use;
- renders a cached known-good payload first;
- refreshes in the background;
- never overwrites the cache with an invalid response;
- keeps the cached payload when the pointer, artifact or network is unavailable;
- refuses an incompatible major schema version cleanly;
- checks HTTP status and never treats an error body as a catalogue.

Rollback may select only a release compatible with the deployed app.

---

## 10. Deterministic application configuration

### 10.1 `gac_board_config`

Stores league, mode, territory, territory type, team count and ordering.

### 10.2 `gac_scoring_rules`

Stores the deterministic scoring rules currently represented by `GAC_Scoring`.

The maintenance system has no authority over either domain. Changes use the human authoring path.

### 10.3 Tactical notes

Matchup and defence notes are human-authored only in the initial design. Statistical evidence may produce a `NOTE_CHANGE` finding, but it cannot mutate notes or publish generated tactical advice.

---

## 11. Autonomous decision policy

The machine-readable policy lives in version control, for example `maintenance/policy.yaml`. Automation may apply it but cannot change it.

The initial engine's primary value is maintenance of existing knowledge: tier drift, threat calibration, duplicate detection, staleness and coverage gaps. Rapid discovery after a new character release remains primarily served by human authoring because strong population evidence will not yet exist.

### 11.1 Eligibility and weighting

Evidence remains mode-specific. Provisional recency weighting:

- current completed same-format event: 60%;
- previous same-format event: 25%;
- earlier same-format evidence: 15%.

Both raw and effective sample sizes are recorded. Exact weights remain tunable after report-only runs.

### 11.2 Confidence

Mechanical confidence considers volume, consistency, recency, mapping certainty, source quality and stability.

Only one numeric score from 0 to 1 is canonical per assessment or mapping. Display bands are derived. AI can lower the bound, never raise it.

### 11.3 New archetypes

The system tries every existing-identity interpretation first.

Initial parameters:

- fewer than 25 relevant observations: reject/ignore;
- 25–99: observe;
- 100 or more plus a permitted strategic distinction: eligible for proposal;
- maximum five proposed new archetypes per run.

An official new leader may establish identity earlier, but its matchups still require performance evidence. Creation occurs only through the deterministic applier.

### 11.4 New matchups and usefulness

Initial evidence guidance:

| Relevant attempts | Default outcome |
|---:|---|
| Fewer than 20 | Reject/ignore |
| 20–49 | Observe |
| 50–99 | Observe unless exceptionally strong and stable |
| 100+ | Eligible for proposal |
| 250+ | Strong |
| 1,000+ | Very strong |

An ordinary matchup initially requires about 80% weighted win rate. An S-tier candidate normally requires about 90%.

A new matchup must improve reliability, resource diversity, accessibility, banners, safe undersize or coverage. Redundant statistically valid matchups remain evidence rather than cluttering the catalogue.

### 11.5 Tier and authority

Tier continues to mean reliability, not banner efficiency.

Population evidence is a proxy for the product's personal reliability judgement, not an identical concept.

Initial candidate bands:

- S: about 90% or better;
- A: about 80–89.9%;
- B: about 65–79.9%;
- C: below that only when strategically useful.

`AUTHORED_LOCKED` tier cannot change autonomously. `AUTHORED_BASELINE` may change only with high confidence, mechanical support and no material caveat. `ASSESSED` may change routinely within policy.

Hysteresis limits normal movement to one tier per run. Larger movement stages or escalates.

### 11.6 Banner and undersize

Banner score retains its current product meaning: full-squad, first-attempt, clean-clear expected value. Undersize remains the safe recommended drop count, not the largest observed stunt clear.

Neither value is autonomously publishable in the initial engine because aggregate win-rate and average-banner evidence cannot reliably remove cleanup attempts, losses, team-size effects or non-clean wins.

Automation may create evidence-backed `OBSERVE` or `ESCALATE` findings. Autonomous publication becomes eligible only after a later, reviewed evidence contract supplies the necessary attempt-number, fielded-unit and clean-win semantics.

Any future banner change that crosses the mode's First Attack messiness threshold requires high confidence and explicit validation.

### 11.7 Threat

Threat uses `LOW`, `NORMAL`, `HIGH` and `EXTREME`. It may draw on provider-supported hold rate, attacking strength, banners conceded, cleanup rate and failed first attempts.

`AUTHORED_LOCKED` threat remains fixed. Other threat values move slowly and never follow popularity alone.

### 11.8 Composition mapping and change

A strict subset of a known attack profile is an undersized variant. An expanded composition consumes flex slots before suggesting a profile change. Ordinary member variation is presumed to be flex or recommended-member variation first.

Required-core changes need high confidence because they affect roster availability and committed-defence filtering.

### 11.9 Duplicate detection and merging

Duplicate detection is proactive. Automatic merging is initially limited to provably equivalent migration duplicates. Other merge proposals escalate because they alter stable identities and dependent relationships.

### 11.10 Staleness and retirement

Absence is not immediate invalidity.

Initial same-format-event guidance:

- one to two events: no action;
- about three: mark stale internally;
- four to five: review candidate;
- longer: retirement eligibility only with supporting meta evidence.

Retirement preserves history. It is stricter than addition.

### 11.11 Conflicting sources

Sources remain separate and are not averaged blindly. Policy records priority, reliability and semantic compatibility.

Immature disagreement becomes `OBSERVE`. It escalates only if it blocks an important decision that cannot wait.

### 11.12 Run-level anomalies and override

Publication stops when the run resembles a parser or mapping failure.

Initial examples use both percentages and absolute floors, such as:

- more than five proposed new archetypes;
- tier changes exceeding the greater of 25% or a configured absolute count;
- retirements exceeding the greater of 10% or a configured absolute count;
- widespread banner movement in one direction;
- unusually high mapping failure;
- implausible source-volume change.

An anomaly preserves evidence and blocks routine publication. A human may deliberately publish through `APPROVED_OVERRIDE` only after the waived anomaly, approver and reason are recorded. Bootstrap runs also enforce a configurable maximum number and proportion of canonical additions or changes per publication wave; exceeding either limit creates a review batch rather than an oversized release.

### 11.13 Bootstrap and steady-state operating modes

The first full catalogue passes are not ordinary maintenance runs. The system has two explicit operating modes:

- **Bootstrap mode** — broad discovery and calibration for one squad format at a time, first `5V5` and then `3V3`. Discovery may be large, but candidates remain staged and publication occurs only in small, evidence-ranked waves.
- **Steady-state maintenance mode** — the recurring same-format cycle entered only after both bootstrap stages have passed their human acceptance gates.

Bootstrap mode keeps discovery, candidate generation, validation and publication as separate states. A discovery pass may identify hundreds of missing defences or possible matchups without making any canonical change. Promotion requires the ordinary evidence, usefulness, validation and anomaly rules plus the bootstrap-specific batch ceiling.

The migrated hand-authored catalogue is the trusted seed and calibration set:

- existing provenance and authority states are preserved;
- `AUTHORED_LOCKED` values remain immutable to automation;
- automated evidence may challenge an `AUTHORED_BASELINE` judgement, but a bootstrap disagreement becomes a reviewable proposal and is never a silent overwrite;
- curated examples are exercised as regression and calibration cases, including prior human downgrades or other experience-backed exceptions;
- the acceptance report distinguishes rediscovery, agreement, disagreement, genuinely new coverage and rejected noise.

Evidence precedes inference. Observed matchup data is the primary basis for a candidate; semantic analysis may interpret, normalise or identify ambiguity, but it cannot manufacture a canonical counter without supporting evidence. Each candidate records its source provenance, raw and effective sample size, recency, observed performance measures, banner evidence where available, mechanical confidence and resulting decision state.

Sparse evidence must remain visibly sparse. The system may retain an unknown or low-confidence banner estimate in staging, but it must not manufacture a precise player-facing value. Under the initial authority model, a new matchup that lacks an eligible banner value remains staged until human authoring or a later approved evidence contract supplies one.

Each bootstrap mode begins with a complete shadow pass and ends with a compact human acceptance report covering discovery volume, promotion volume, rejection/hold volume, confidence distribution, disagreement with curated data, representative high-impact additions or changes, and any circuit-breaker events. Passing `5V5` does not validate `3V3`: composition patterns, sample sizes, banner behaviour and matchup volatility are calibrated independently.

Only completion of both bootstrap stages authorises steady-state autonomous maintenance. Even then, the run-level anomaly gates and mass-change ceilings remain active so a provider, parser or mapping failure cannot rewrite a large fraction of the catalogue in one cycle.

---

## 12. Publication validation

### 12.1 Structural validation

The validator proves:

- no orphan IDs or duplicate matchup keys;
- valid lifecycle transitions;
- every required member references a compatible unit with a unique non-empty external ID;
- valid profiles, roles, modes, tiers and threats;
- banner and undersize values within mode limits;
- no invalid active reference to a retired or merged identity;
- payload schema and checksum validity;
- release/base/version consistency;
- run-level anomaly gates.

### 12.2 Product-contract validation

The validator also proves:

- app-facing mode keys are exactly `5v5`, `3v3` and `FLEET`;
- exactly one positive finite `SETTING_DEFENCE / ANY / ANY` rule exists;
- every league/mode has the required territories in canonical order and exactly one Fleet territory;
- banner ceilings and undersize limits match `SCORING_REFERENCE.md`;
- required counter IDs and defence display names do not disappear without an explicit compatible rename migration;
- counter-less defence identities are handled deliberately;
- board and scoring configuration can produce the current app contract;
- the complete PWA payload can be generated;
- provenance exists for each assessed value;
- the candidate remains compatible with persisted client state.

If any validation fails, publish nothing.

---

## 13. Security and authority boundaries

Use least-privilege roles or equivalent narrow operations:

- **Authoring loader:** applies reviewed human changes through validation; cannot change schema or policy.
- **Evidence ingester:** inserts observations and run metadata only.
- **Maintenance analyst:** inserts mappings, assessments and findings only.
- **Deterministic applier:** re-evaluates policy and performs permitted canonical mutations.
- **Publisher:** generates, validates and records releases; changes the current pointer only through the publication transaction.
- **Migration/admin:** used only for approved schema and migration work.

The live PWA needs no database role because it reads static public catalogue artifacts.

The analyst and maintenance runner cannot write:

- units or external IDs;
- archetypes, profiles or matchups;
- accepted catalogue values;
- board or scoring configuration;
- policy or schema;
- releases or current-release state;
- notes;
- credentials or permissions.

The deterministic applier demotes a finding to `OBSERVE` when enforced policy fails and records why. It checks the policy version itself rather than trusting the analyst's claim.

Retrieved third-party content is untrusted data. Instructions embedded in it are never followed, and no retrieval path can alter schema, policy, credentials, permissions, application code or the release pointer.

---

## 14. Repository and environments

The desired endpoint remains one authoritative repository with explicit development and production environments. The private development repository (this one) remains the authoritative source throughout; it is never made public as part of this consolidation.

The account is GitHub Free. GitHub Environments with required reviewers, and GitHub Pages served from a private repository, are not available on that plan. Repository secrets plus explicit manual `workflow_dispatch` triggers are the Stage-1 substitute production gate, and Cloudflare Workers static assets — not private-repository GitHub Pages — is the selected production static host. See [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1–§3 for the full decision and its rejected alternatives, and §12 for the plan-feature facts ARCH-104 must re-verify before relying on them.

Because the production host changes, **the production URL changes.** This is not a side effect to be absorbed silently: the origin change is its own explicit migration, requiring client-state export/import so a player's roster, boards, templates, used counters and preferences survive the move. It is sequenced as ARCH-111/ARCH-112, detailed in §15.4, and depends on the manual authoring, review, publication and rollback runs (§16, "Manual run entry points") being operable end to end before any player-facing cutover.

**Manual operation is mandatory**, not merely available. Every stage of this architecture must support a manual authoring run, a manual candidate/review run, a manual publication run and a manual rollback run, independent of any schedule; see §16, "Manual run entry points". Scheduling, where it exists in Stage 3, is an additional trigger for the same underlying commands, never the only way to operate the system.

Prerequisites for consolidation:

- CI runs the complete test and validation suite;
- public deployment remains fail-closed and allow-listed;
- private docs, tests, database code, personal identifiers and secrets cannot enter the public artifact;
- environment configuration and secrets are external to source;
- production remains an explicit promotion of a tested commit or artifact;
- the current live repository remains recoverable until the consolidated route is proved.

Repository consolidation is not required before database migration and must not be combined atomically with catalogue cutover. It may be completed within Stage 1 through a later internal checkpoint so manual configuration remains concentrated without removing the fallback prematurely.

The existing public `gac-helper` repository and its GitHub Pages deployment remain an untouched fallback through the Stage-1 acceptance window: they are not modified, degraded or pre-emptively retired by adopting Cloudflare Workers for the new production host. They are retired, and `LIVE_REPO_PAT` revoked, only at the approved ARCH-112 exit gate — see §15.4.

---

## 15. Migration and cutover

Migration optimises for recoverability rather than prolonged dual-write.

### 15.0 Production-origin change (ARCH-111/ARCH-112)

The catalogue-platform migration described in §15.1–§15.4 changes the *data source*. Separately, and only as its own explicitly approved migration, the production **hosting origin** changes from GitHub Pages to Cloudflare Workers (§14), which also changes the production URL. Because all player-specific state lives in browser `localStorage` keyed to the origin (`SPEC.md` §3.4), a bare origin change would silently strand a player's roster, boards, templates, used counters and preferences. The origin change is therefore sequenced as its own migration, ARCH-111/ARCH-112, and is not performed as a side effect of any other work package:

1. implement and test client-state export on the old origin;
2. implement and test client-state import on the new origin;
3. export before cutover;
4. deploy and verify the new Cloudflare origin;
5. import state and re-import the roster by ally code;
6. verify boards, templates, used counters, preferences, and offline behaviour;
7. keep the old origin unchanged through at least one complete GAC event;
8. retire the old deployment and `LIVE_REPO_PAT` only at the approved exit gate.

No step of this sequence is performed by the catalogue-platform work packages (ARCH-105–ARCH-110); it is authorised only by ARCH-111/ARCH-112 under their own explicit approval.

### 15.1 Required artifacts

Before mutation:

- commit a timestamped export of every relevant Sheet tab as a private migration artifact;
- capture the current Apps Script `action=data` response as a golden payload;
- record current counts, identifiers, names, modes and required-member external-ID coverage;
- retain the current Sheet and `action=data` route unchanged through at least one complete GAC event after production cutover.

### 15.2 Identity preservation

At cutover:

- every attack `archetype_code` equals today's `Counter_ID`;
- defence display names remain byte-identical;
- app-facing modes remain exactly `5v5`, `3v3` and `FLEET`;
- no rename occurs without a versioned client-state migration.

This protects persisted `usedTeams`, `defenceTemplate:5v5`, `defenceTemplate:3v3`, `boardData` and `myBoardData` state.

### 15.3 Mandatory reconciliation and acceptance

Stage 1 must prove:

1. new payload equals the captured Apps Script payload in all current product semantics, allowing only documented ordering or additive provenance fields;
2. entity counts reconcile to the Sheet export, with every discrepancy explained;
3. every current `Counter_ID` survives;
4. every defence display name survives;
5. every defence identity maps to exactly one archetype or is explicitly unresolved;
6. fixture-roster ownership and availability results are identical;
7. required-unit external-ID coverage is not reduced;
8. board territory order, type and count are identical;
9. scoring preconditions and documented worked examples remain correct;
10. current tests plus payload, caching and compatibility tests pass in CI;
11. an offline cold PWA launch can complete a representative round from cache;
12. a deliberately rejected candidate changes nothing;
13. a published test release can be rolled back successfully;
14. the owner can add one counter through the human authoring path and publish it without SQL.

### 15.4 Cutover sequence

1. apply the complete reviewed schema;
2. load the migration seed;
3. resolve reported duplicates and ambiguous identities;
4. generate the legacy-migration candidate;
5. pass the reconciliation suite;
6. publish a static development artifact;
7. adapt the PWA to separate catalogue and roster-proxy URLs;
8. validate cache-first and offline behaviour;
9. validate production promotion and rollback;
10. cut production to the static catalogue;
11. retain Sheet/`action=data` fallback for at least one complete GAC event;
12. archive the Sheet and retire only `action=data` after acceptance;
13. retain Apps Script `action=roster`.

A long-lived dual-write system is not required.

---

## 16. Minimal implementation sequence

The programme uses five stages. A small evidence gate sits before Stage 2; it is not an additional build stage and requires no infrastructure programme.

### Stage 1 — Canonical platform, authoring and publication

Manual configuration is concentrated into one coordinated session (ARCH-104), which creates only the Stage-1 roles and secrets in [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §7 — Stage-2 evidence/analyst/applier credentials are not created:

- create the Supabase Free project (London region) and least-privilege Stage-1 roles;
- configure repository secrets (no GitHub Environments; manual `workflow_dispatch` gates production instead);
- configure the Cloudflare Workers development and production static catalogue publication targets;
- confirm the guarded route toward one repository.

### Manual run entry points

Manual operation is mandatory, not optional, throughout every stage (see §14). The following are always available as directly runnable commands and/or `workflow_dispatch` workflows, independent of any schedule, and are the exact code path a future scheduled trigger reuses:

- a **manual authoring run** — prepare, dry-run, apply and optionally publish a human catalogue change without SQL (§6);
- a **manual candidate/review run** — a report-only maintenance review outside the schedule, with report-only as the default (§8, Stage 2);
- a **manual publication run** — the `READY`/`DEPLOYED` protocol in §9.2, invoked explicitly;
- a **manual rollback run** — repoint to a prior compatible release, per [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §5.

Every manual run records who/what triggered it and remains idempotent for the same logical unit of work. Full detail is in [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §8.

Agent implementation then:

- adds CI first;
- applies the complete schema;
- creates the authoring loader and authority states;
- migrates and reconciles the current catalogue;
- builds the deterministic validator and locked publisher;
- creates versioned static artifacts and the current pointer;
- adds cache-first catalogue loading and schema validation to the PWA;
- splits catalogue and roster-proxy URLs;
- retains Apps Script for `action=roster` only;
- completes repository consolidation only after CI and fail-closed publication are proved;
- executes every `15.3 acceptance check.

Exit criterion:

> GAC Helper runs from a validated static catalogue, works from cache offline, supports safe human authoring without SQL, preserves all current IDs/names/notes/state, and can roll back to both the prior release and the former Sheet-backed path.

Rollback:

- repoint to the previous static release; or
- restore the unchanged Apps Script `action=data` URL during the fallback window.

### Evidence and runner entry gate

Before Stage 2, perform the `7.1 spike with one representative real cycle. Prefer a deterministic scheduled runner such as an existing CI platform. Prove any required authenticated access rather than assuming a ChatGPT scheduled task can provide it.

If the gate fails, stop after Stage 1.

### Stage 2 — Maintenance engine in report-only mode

Implement:

- idempotent evidence ingestion;
- deterministic canonical mapping first;
- bounded semantic review for ambiguous cases;
- append-only assessments and findings;
- deterministic policy application against a non-current candidate;
- anomaly and failure injection;
- full provenance.

No Stage 2 release becomes current.

Exit criterion:

> Across at least two representative completed same-format events, findings are explainable and credible, authored locks are respected, and injected source/parser/policy failures block candidate acceptance.

Rollback:

> Disable the engine. Stage 1 authoring and publication remain unaffected.

### Stage 3 — Scheduling and bounded autonomous publication capability

Implement:

- event completion and evidence-readiness detection;
- idempotent execution and safe retry;
- static artifact publication;
- concise success reporting;
- alerts only for failure or `ESCALATE`;
- `APPROVED_OVERRIDE` handling;
- proved source-outage, concurrency, rollback and restoration behaviour.

Stage 3 proves that eligible changes can be scheduled and published safely, but it does not authorise unrestricted catalogue expansion or steady-state autonomous operation. The initial full-population work remains in the format-specific bootstrap stages below.

Exit criterion:

> Two consecutive unattended eligible cycles complete correctly, a forced mid-publication failure leaves the previous artifact current, rollback succeeds without database availability, and the user approves the mechanism for a controlled `5V5` bootstrap.

Rollback:

> Disable scheduling and repoint to the last human-approved compatible release.

### Stage 4 — `5V5` bootstrap and calibration

Run one broad `5V5` discovery pass in shadow mode, compare it with the curated `5V5` seed catalogue, and promote only evidence-qualified candidates in bounded waves.

The stage must:

- retain all discoveries and weak candidates in staging rather than forcing catalogue completeness;
- use curated counters as regression and calibration cases;
- review disagreements, false positives, confidence distribution and banner-data quality;
- publish no precise banner value unsupported by eligible evidence or human authoring;
- preserve curated provenance and prevent silent bootstrap overwrites;
- stop each publication wave at the configured absolute and proportional change ceilings;
- produce the bootstrap acceptance report defined in §11.13.

Exit criterion:

> The user accepts the `5V5` bootstrap report, every promoted record has traceable evidence and provenance, held candidates remain staged, bounded-wave and mass-change controls are proven, and the remaining `5V5` backlog can safely enter steady-state maintenance after Stage 5 authorises that operating state.

Rollback:

> Stop further promotion waves and repoint to the last accepted compatible release; staged evidence and rejected/held candidates remain auditable.

### Stage 5 — `3V3` bootstrap and calibration

Repeat Stage 4 independently for `3V3`. Stage-4 success does not waive any `3V3` calibration or acceptance requirement because composition patterns, sample sizes, banner behaviour and matchup volatility differ materially from `5V5`.

Exit criterion:

> The user accepts the `3V3` bootstrap report under the same evidence, provenance, bounded-wave, regression and circuit-breaker criteria as Stage 4.

Rollback:

> Stop further promotion waves and repoint to the last accepted compatible release; Stage-4 `5V5` results remain intact.

After Stage 5, the system enters steady-state autonomous maintenance. This is the operating state produced by the five-stage programme, not a sixth implementation stage.

---

## 17. Cost model

Stage 1 should be viable with no new recurring paid service under normal personal use, subject to current provider limits verified at implementation.

Potential cost areas:

- database storage, inactivity and project limits;
- static artifact storage and deployment;
- scheduled compute;
- evidence-provider subscription or API access;
- AI API usage, if ever needed;
- backups and retention.

The database is removed from the live PWA path so host pausing does not block a round. A documented wake/recovery procedure is still required for authoring and maintenance.

No paid evidence source, AI API or worker is introduced without an explicit decision stating:

- expected monthly cost;
- what capability it unlocks;
- why existing paid/free tools are insufficient;
- the cheaper fallback.

Provider prices, limits, task capabilities and access terms are time-sensitive and must be rechecked during the evidence gate.

---

## 18. Observability and reproducibility

Each run and release must answer:

- what source snapshot was used;
- which retrieval, method, analyst and policy versions ran;
- how many observations mapped, failed or remained ambiguous;
- what findings were proposed, observed, escalated, rejected or applied;
- what policy the applier actually enforced;
- which anomaly and validation gates ran;
- which assessment and finding produced each assessed published value;
- what base release was used;
- whether the static artifact and pointer were published;
- how to restore the previous compatible release.

Routine successful output remains concise. `OBSERVE` is silent by default. Only failures and genuine `ESCALATE` cases demand attention.

Retention periods are set after measuring real volume. Do not add premature archival infrastructure.

---

## 19. Decisions proposed for lock

1. Postgres-compatible relational storage is the canonical maintenance and authoring store.
2. Google Sheets is not part of the target steady-state runtime.
3. Human authoring remains first-class and does not require SQL.
4. Human judgement uses explicit `AUTHORED_LOCKED`, `AUTHORED_BASELINE` and `ASSESSED` authority states.
5. Tactical notes are stored explicitly and remain human-authored initially.
6. One `team_archetypes` registry covers attacking and defensive identities.
7. Shared squad composition uses an `ANY` profile with mode-specific override.
8. Exact observed squads belong in evidence, not automatically in the catalogue.
9. New team identities carry a deliberately high burden of proof.
10. Matchups are unique by mode, defence archetype and counter archetype.
11. Evidence and assessments are append-only.
12. The analyst proposes; a deterministic applier enforces policy and writes canonical changes.
13. Banner and undersize are not autonomously published until suitable evidence semantics are proved.
14. Published catalogues are immutable, schema-versioned static JSON artifacts.
15. Publication is single-writer, base-release-aware and pointer-based.
16. The live PWA renders a validated cached catalogue first and has no database dependency.
17. Maintenance policy is version-controlled and outside AI write authority.
18. `OBSERVE` is silent; only genuine `ESCALATE` cases ask the user.
19. The first implementation requires no paid AI API.
20. Evidence-provider feasibility and cost are a Stage 2 entry gate.
21. Apps Script remains initially for roster proxying only.
22. One repository remains the desired target, but consolidation requires CI, fail-closed public output and a recoverable fallback.
23. The programme has five implementation stages with manual configuration concentrated in Stage 1; Stages 4 and 5 are format-specific bootstrap/calibration stages, after which the system enters steady-state maintenance without a sixth stage.
24. Cloudflare Workers static assets is the selected production static host, replacing GitHub Pages, because the GitHub account is Free and private-repository Pages is unavailable ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1).
25. Supabase Free in the London region is the selected Stage-1 canonical database, using the account's one remaining free project slot, subject to ARCH-104 re-verification of cost and account limits before manual creation ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1, §3).
26. The Supabase-slot allocation is reversible through a separate approved plan if another owner-operated application later needs the slot more ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.4).
27. GitHub repository secrets plus explicit manual `workflow_dispatch` triggers are the Stage-1 production gate, in place of GitHub Environments ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.6).
28. Manual operation — authoring, candidate/review, publication and rollback runs — is mandatory in every stage; scheduling is an additional trigger for the same commands, never the only way to operate the system ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1.7, §8).
29. Publication across the database and Cloudflare Workers uses the `READY`/`DEPLOYED` two-phase protocol with HTTP verification and idempotent reconciliation, not a cross-system atomic transaction ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §4).
30. Stage-1 backup/recovery reconstructs canonical state from ordered migrations, append-only authoring change files, immutable published artifacts and release metadata — not from raw `pg_dump` files committed to Git; an encrypted off-site logical-backup destination is selected later, at GATE-200 or the relevant Stage-2 package ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §10.1).
31. No daily keep-alive is used to defeat Supabase free-tier pausing; every maintenance operation instead preflights database health, stops safely if paused, reports the owner action needed to resume it, and resumes idempotently ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §10.2).
32. Only the Stage-1 roles Stage 1 actually exercises (migration/admin, authoring, publisher, and read-only backup/export if needed) are created in Stage 1; Stage-2 roles (evidence ingester, maintenance analyst, deterministic applier) are not created until Stage 2 ([ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) §1, §7).
33. Bootstrap and steady-state maintenance are distinct operating modes; `5V5` and `3V3` are bootstrapped and accepted independently.
34. The migrated hand-authored catalogue is protected seed/calibration data: automated evidence may challenge it, but bootstrap disagreements cannot silently overwrite it.
35. Large discovery batches are permitted, but publication remains evidence-qualified, usefulness-filtered and bounded by absolute and proportional change ceilings.
36. Every bootstrap mode requires a shadow pass, regression comparison, acceptance report and explicit human gate before completion.

---

## 20. Decisions deferred to implementation evidence

The database host/region, the static artifact storage/pointer mechanism, and the production-hosting selection are now settled by [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md) (§19 items 24–32), subject to the re-verification it requires at ARCH-104. The following remain genuinely open:

- exact one-repository consolidation mechanics (the target hosting is decided; how the consolidated repository route is wired up is not);
- evidence provider, retrieval contract and recurring cost (GATE-200);
- **encrypted off-site logical-backup destination, retention and restore testing for Stage-2 evidence and assessment history** — deliberately not preselected by ADR-ARCH-102 §10.1, and explicitly not "commit raw dumps to Git"; owned by GATE-200 or the relevant Stage-2 work package;
- exact observation idempotency key;
- final deterministic runner;
- exact confidence formula and source-quality weights;
- threshold tuning after report-only runs;
- retention periods;
- later payload-schema evolution;
- whether future evidence can safely support autonomous banner or undersize updates;
- whether more expressive composition alternatives are ever needed.

These are deferred because current evidence is insufficient, not because they may be silently improvised during implementation.

---

## 21. Peer-review resolution

v0.2 accepts the peer review's central findings:

- added human authoring and authority states;
- added explicit notes storage;
- removed the database from the live PWA path;
- separated semantic proposal from deterministic application;
- deferred autonomous banner and undersize mutation;
- added evidence-provider and runner gating;
- added release locking, base-release checks and payload schema versions;
- preserved current identifiers and client-state contracts;
- strengthened product validation and migration acceptance;
- retained Apps Script only for roster proxying.

It modifies three recommendations:

- human-authored values are not all permanently immutable; only `AUTHORED_LOCKED` values are;
- version-controlled authoring files are change inputs, not a second canonical catalogue;
- repository consolidation remains the desired target, but is guarded and sequenced rather than coupled atomically to database cutover.

It also keeps AI available for genuinely semantic ambiguity while making ordinary ingestion, mapping, policy enforcement and publication deterministic.

---

## 22. ARCH-102 resolution (v0.3)

v0.3 records the accepted ARCH-102 platform decisions from [ADR-ARCH-102](decisions/ADR-ARCH-102-platform.md):

- selected Cloudflare Workers static assets as the production static host, and Supabase Free (London) as the Stage-1 canonical database, both subject to ARCH-104 re-verification;
- replaced GitHub Environments with repository secrets plus manual `workflow_dispatch` as the Stage-1 production gate, reflecting the GitHub Free plan;
- replaced the single-transaction publication model with the `READY`/`DEPLOYED` two-phase, HTTP-verified protocol and its recovery/reconciliation procedure, because a database transaction and a Cloudflare deployment cannot be made atomic together;
- required manual authoring, candidate/review, publication and rollback runs in every stage, with scheduling as an additional trigger only;
- ruled out committing raw `pg_dump` backups to Git and ruled out a daily Supabase keep-alive, replacing both with an explicit Stage-1 reconstruction model and a preflight/fail-safe/resume pattern for maintenance operations;
- limited Stage-1 role/credential creation to the roles Stage 1 actually exercises, deferring evidence ingester, maintenance analyst and deterministic-applier credentials to Stage 2;
- recorded mandatory `SECURITY DEFINER` controls for any such function retained in the schema;
- recorded the production-origin change (GitHub Pages → Cloudflare Workers) as its own explicit ARCH-111/ARCH-112 client-state migration, with the existing public repository and GitHub Pages deployment retained as an untouched fallback through the Stage-1 acceptance window and retired only at the approved exit gate.

This section, §14, §15.0, §16, §19 items 24–32 and §20 reflect that resolution. The ADR itself remains the authoritative source for justification, rejected alternatives, the full threat model, and the time-sensitive assumptions ARCH-104 must re-check.

---

## 23. Bootstrap/calibration resolution (v0.4)

v0.4 records the accepted safeguards for the first large automated catalogue passes:

- separated bootstrap mode from steady-state maintenance mode;
- protected curated data as the trusted seed and calibration set while allowing evidence-backed disagreements to become reviewable proposals;
- made broad discovery compatible with deliberately small, evidence-ranked publication waves;
- required candidate-level evidence, confidence and provenance, and prohibited manufactured banner precision;
- strengthened mass-change circuit breakers so abnormal catalogue churn becomes a review batch rather than an automatic release;
- added independent `5V5` and `3V3` bootstrap/calibration stages with shadow runs, regression checks, acceptance reports and human gates;
- defined steady-state autonomous maintenance as the operating state after Stage 5, not a sixth implementation stage.
