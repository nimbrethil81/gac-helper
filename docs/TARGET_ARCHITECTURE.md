# SWGOH GAC Helper — Target Architecture

**Status:** Proposed design v0.1, ready for peer review. Not yet implemented.

**Scope.** This document defines the proposed target architecture for modernising GAC Helper's canonical data platform, repository and deployment model, and autonomous counter maintenance. It is a future-state design authority, not a description of the shipped system. The current system remains defined by [`SPEC.md`](SPEC.md), and prioritisation remains in [`ROADMAP.md`](../ROADMAP.md).

**Update this document when** an architectural decision below is accepted, revised, or rejected during review or implementation. Once the target architecture ships, move enduring current-state facts into `SPEC.md` and either retire this document or reduce it to decisions not captured elsewhere.

This design intentionally optimises for:

- a single-user hobby application;
- minimal or zero additional running cost;
- low ongoing human administration;
- a compact, useful counter catalogue rather than exhaustive squad permutations;
- autonomous maintenance with conservative, auditable safeguards;
- simple rollback and recovery rather than enterprise-scale migration choreography;
- the fewest sensible implementation stages, with manual cloud configuration concentrated into one session.

---

## 1. Context and problem

The current PWA is static and cache-first. Authored counter data lives in Google Sheets, Google Apps Script converts it to JSON, and separate development and live repositories are used with a manually triggered promotion workflow.

That arrangement has served the product well, but it creates limits for autonomous counter maintenance:

- identity and duplicate rules are not enforced relationally;
- a statistical observation can too easily be confused with a canonical team identity;
- updates overwrite current judgements without retaining evidence or assessment history;
- Sheet formulas, protected ranges, Apps Script and surgical edits add administration;
- publication is not naturally atomic;
- separate development and live repositories complicate conventional environment promotion;
- giving an autonomous process broad Sheet access would make its authority difficult to bound.

The target architecture replaces the runtime use of Google Sheets with a Postgres-compatible canonical store and an immutable published catalogue. It also introduces a separate evidence and assessment pipeline so observations cannot become live product knowledge without canonicalisation, policy decisions and whole-catalogue validation.

This is not an implementation instruction. Repository consolidation, database creation, migration and autonomous publishing require their own approved implementation work.

---

## 2. Architectural principles

### 2.1 Strategic identity over observed composition

The canonical catalogue stores strategic team identities, not every squad permutation seen in source data.

> Prefer the smallest set of canonical identities that preserves strategically meaningful differences.

Observed compositions may justify a new identity only when the variation materially changes at least one of:

- leader or defining core;
- roster-resource contention;
- matchup behaviour or reliability;
- recommendation value;
- recognition as a genuinely separate game archetype.

A different flex unit alone does not justify a new identity.

### 2.2 One team registry

Attacking counters and defensive teams are both strategic team archetypes. The target model uses one `team_archetypes` registry rather than separate counter and defence registries.

A matchup assigns one archetype the defence role and another the attack role for a particular GAC mode.

### 2.3 Evidence is not publication

Raw or aggregated source evidence, semantic assessment, and the published catalogue are separate domains.

An observed squad or win rate does not become live knowledge directly. It must pass through:

1. source ingestion;
2. canonical mapping;
3. deterministic assessment;
4. policy decision;
5. candidate-catalogue generation;
6. whole-catalogue validation;
7. atomic publication.

### 2.4 Consolidation over proliferation

Creating a matchup is cheaper than creating a new team identity. Before proposing a new archetype, the system must attempt to interpret the observation as:

1. an exact existing identity;
2. an existing identity with a different flex unit;
3. an existing identity with different recommended units;
4. an existing identity whose profile needs adjustment;
5. only then, a genuinely new archetype.

The maintenance objective is:

> Maximise useful counter coverage while minimising redundant catalogue entries.

### 2.5 Omission over unsupported precision

Where evidence is insufficient, the safe result is normally `OBSERVE`, not a speculative catalogue change or a question for the user.

### 2.6 Atomic, reversible publication

A publication either succeeds as one validated catalogue release or changes nothing. Rollback changes the current-release pointer to a prior immutable release; it does not reverse hundreds of individual mutations.

### 2.7 Cache-first live application

The live-round PWA should remain operationally simple. It consumes one compact published JSON catalogue and continues to work from cached data. Maintenance complexity remains behind the publication boundary.

### 2.8 Cost restraint and provider neutrality

The logical data model is Postgres-compatible and must not depend on a proprietary Supabase-only feature without a justified need. Supabase is a likely host, but hosting is an implementation decision.

The first operating model should avoid requiring a paid AI API. A ChatGPT Plus scheduled workflow is the preferred semantic-analysis option only if its available scheduling, network and authenticated database capabilities are proven sufficient. The deterministic pipeline and database design must remain independent of that assumption so another runner can be substituted later.

---

## 3. Target system topology

The target is one product repository with explicit environments and conventional promotion:

```text
gac-helper/
  app/                 PWA
  maintenance/         evidence, analysis, policy and publication code
  supabase/            portable SQL schema, migrations and database functions
  docs/                product, architecture and operational authorities
  tests/               contract, migration and end-to-end tests
```

The exact directory layout is illustrative and should be confirmed against the implementation toolchain.

The logical runtime flow is:

```text
External GAC statistics
        |
        v
Evidence observations
        |
        v
Canonical mapping
        |
        +--> Existing team archetype
        |
        +--> Finding: possible new archetype
        |
        v
Matchup and defence assessments
        |
        v
Maintenance findings
  PUBLISH | OBSERVE | ESCALATE | REJECT
        |
        v
Deterministic policy and anomaly gates
        |
        v
Candidate catalogue JSON
        |
        v
Whole-catalogue validation
        |
        v
Immutable catalogue release
        |
        v
Current-release pointer
        |
        v
GAC Helper PWA
```

Target components:

- **GitHub:** application source, SQL migrations, versioned policy, tests and deployment workflows.
- **Postgres-compatible database:** canonical catalogue, evidence, assessments, findings and releases.
- **Static hosting:** the cache-first PWA.
- **Maintenance runner:** scheduled retrieval and semantic analysis. Initially this may be ChatGPT Plus if capability validation succeeds.
- **Comlink:** existing read-only roster source unless separately replaced.
- **Google Sheets:** archived migration source and fallback snapshot, not part of the target runtime path.

---

## 4. Data domains

The schema is divided into four main domains plus deterministic application configuration:

1. **Canonical catalogue** — stable units, strategic team identities, profiles and matchup relationships.
2. **Evidence** — source observations and their mappings to canonical identities.
3. **Assessment and maintenance** — historical judgements, run records and policy outcomes.
4. **Publication** — immutable catalogue snapshots and the active-release pointer.
5. **Application configuration** — board and scoring rules outside autonomous counter authority.

All timestamps should be timezone-aware. Stable public codes should be immutable after publication. Internal relational keys may use UUIDs.

---

## 5. Canonical catalogue model

### 5.1 `units`

One row per playable character, ship or capital ship.

| Field | Purpose |
|---|---|
| `unit_id` | Stable internal readable key, equivalent to today's `Character_ID` |
| `display_name` | Current user-facing name |
| `external_id` | Game/Comlink base ID used as a translation adapter |
| `unit_type` | `CHARACTER`, `SHIP`, or `CAPITAL_SHIP` |
| `active` | Whether the unit remains active |
| `created_at`, `updated_at` | Audit timestamps |

Constraints:

- `unit_id` is unique and immutable.
- `external_id` is unique when present.
- display names may change without breaking relationships.

Trusted game metadata may create a missing unit automatically when external ID, official name and unit type are unambiguous.

### 5.2 `team_archetypes`

One row per canonical strategic team identity, regardless of whether it is used on attack or defence.

| Field | Purpose |
|---|---|
| `archetype_id` | Internal relational key |
| `archetype_code` | Stable readable unique code |
| `display_name` | User-facing identity |
| `battle_type` | `SQUAD` or `FLEET` |
| `status` | `ACTIVE`, `RETIRED`, or `MERGED` |
| `merged_into_id` | Successor identity where status is `MERGED` |
| `identity_reason` | Controlled reason this identity exists |
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

`OTHER_APPROVED` should require a recorded explanation.

### 5.3 `team_profiles`

An archetype answers “what strategic team is this?” A profile answers “what does this team require in this format and usage?”

| Field | Purpose |
|---|---|
| `profile_id` | Internal key |
| `archetype_id` | Parent strategic identity |
| `mode` | `3V3`, `5V5`, or `FLEET` |
| `usage_role` | `ATTACK` or `DEFENCE` |
| `flex_slots` | Number of canonical flex positions |
| `status` | Profile lifecycle state |

Initial uniqueness:

```text
(archetype_id, mode, usage_role)
```

This deliberately starts with at most one canonical profile for a team in each mode and role.

Example: Emperor Palpatine with Darth Vader (Duel's End) in 3v3 defence can require those two units and carry one flex slot. Thrawn, Mara Jade, Royal Guard and other observed third units remain evidence variants unless they prove strategically distinct.

### 5.4 `team_profile_members`

Normalised unit membership for a team profile.

| Field | Purpose |
|---|---|
| `profile_id` | Parent profile |
| `unit_id` | Member unit |
| `member_role` | `REQUIRED` or `RECOMMENDED` |
| `is_leader` | Whether the member is the canonical leader |
| `sort_order` | Stable display order |

Unique on `(profile_id, unit_id)`.

The initial model intentionally uses only required members, recommended members and flex slots. Alternative groups or more expressive composition rules should be added only when real cases demonstrate that this model is insufficient.

Required-member changes receive stronger scrutiny than recommended-member changes because required membership affects roster and round availability.

### 5.5 `matchups`

One canonical relationship between a defence archetype and counter archetype in a mode.

| Field | Purpose |
|---|---|
| `matchup_id` | Internal key |
| `mode` | `3V3`, `5V5`, or `FLEET` |
| `defence_archetype_id` | Defending team |
| `counter_archetype_id` | Attacking team |
| `status` | `ACTIVE` or `RETIRED` |
| `created_at` | Creation timestamp |

Hard uniqueness:

```text
(mode, defence_archetype_id, counter_archetype_id)
```

This prevents duplicate canonical rows for the same strategic matchup even when many exact compositions are observed.

---

## 6. Evidence model

The initial evidence model stores aggregated source observations rather than every individual battle, keeping storage and complexity small. Individual battles may be introduced later only if a demonstrated analysis need justifies them.

### 6.1 `evidence_sources`

| Field | Purpose |
|---|---|
| `source_id` | Internal key |
| `source_code` | Stable code such as `SWGOH_GG` |
| `name` | Display name |
| `active` | Ingestion state |
| `priority` | Deterministic source precedence where needed |

### 6.2 `evidence_observations`

One immutable retrieved statistical observation for an exact source grouping.

| Field | Purpose |
|---|---|
| `observation_id` | Internal key |
| `source_id` | Evidence provider |
| `maintenance_run_id` | Ingestion run |
| `source_cycle_key` | Source season/round/cycle identifier |
| `mode` | Relevant GAC mode |
| `observed_defence_signature` | Exact observed defending composition signature |
| `observed_attack_signature` | Exact observed attacking composition signature |
| `battle_count`, `wins`, `win_rate` | Source performance measures |
| `average_banners` | Source banner measure, with semantics retained |
| `source_url` | Traceable source location |
| `source_data` | Original useful source fields as JSONB |
| `content_hash` | Idempotency/deduplication key |
| `retrieved_at` | Retrieval timestamp |

Composition signatures should be deterministic and based on trusted external unit IDs, not display-name parsing. Source-specific JSONB is retained so ingestion need not prematurely flatten every provider field.

A uniqueness or idempotency rule should prevent the same source observation from being ingested twice. Its exact key must be decided from the chosen provider's semantics.

### 6.3 `evidence_mappings`

Records the semantic decision that observed compositions correspond to canonical archetypes.

| Field | Purpose |
|---|---|
| `observation_id` | Source observation |
| `defence_archetype_id` | Mapped defence identity |
| `counter_archetype_id` | Mapped counter identity |
| `mapping_confidence` | Mechanically bounded confidence |
| `mapping_method` | `EXACT`, `RULE`, or `AI` |
| `mapping_notes` | Concise rationale or ambiguity |

This is the primary anti-permutation layer. Exact observed squads remain queryable without forcing equivalent canonical identities into the live catalogue.

---

## 7. Assessment and maintenance model

### 7.1 `matchup_assessments`

Append-only historical assessment of a matchup.

| Field | Purpose |
|---|---|
| `assessment_id` | Internal key |
| `matchup_id` | Assessed canonical relationship |
| `maintenance_run_id` | Producing run |
| `battle_count`, `win_rate`, `average_banners` | Normalised supporting measures |
| `tier` | Proposed `S`, `A`, `B`, or `C` |
| `banner_score` | Proposed full-squad, first-attempt clean-clear score |
| `undersize` | Proposed safe droppable-unit count |
| `confidence_score` | Mechanically derived score |
| `confidence_level` | `LOW`, `MEDIUM`, or `HIGH` |
| `evidence_summary` | Concise evidence explanation |
| `reasoning_summary` | Policy/semantic reasoning |
| `method_version` | Assessment algorithm version |
| `created_at` | Timestamp |

Assessments are not overwritten. The published release selects the accepted current judgement while preserving history.

### 7.2 `defence_assessments`

Append-only assessment of a defence archetype's threat.

| Field | Purpose |
|---|---|
| `defence_assessment_id` | Internal key |
| `archetype_id`, `mode` | Assessed defence identity and format |
| `maintenance_run_id` | Producing run |
| `appearance_count`, `hold_rate` | Supporting measures |
| `average_banners_conceded`, `cleanup_rate` | Optional supporting measures |
| `threat` | `LOW`, `NORMAL`, `HIGH`, or `EXTREME` |
| `confidence_level` | Assessment confidence |
| `reasoning_summary` | Explanation |
| `created_at` | Timestamp |

Threat remains coarse and exists to support battle ordering, not to create a detailed meta leaderboard.

### 7.3 `maintenance_runs`

Every logical autonomous cycle is recorded.

| Field | Purpose |
|---|---|
| `run_id` | Internal key |
| `cycle_key` | GAC season/round or equivalent logical key |
| `mode` | `3V3` or `5V5`; fleet inclusion recorded separately |
| `fleet_included` | Whether fleet evidence is included |
| `triggered_at`, `evidence_ready_at`, `completed_at` | Lifecycle timestamps |
| `status` | Run lifecycle/result |
| `policy_version` | Exact policy revision |
| `analyst_version` | Semantic analyst/model version |
| `source_snapshot` | Source retrieval metadata |
| `published_release_id` | Resulting release when published |

The logical run should be unique on `(cycle_key, mode)`. Retries update or resume the same logical run safely rather than creating parallel publications.

### 7.4 `maintenance_findings`

The working and audit inbox for proposed changes.

Initial finding types:

- `NEW_ARCHETYPE`
- `NEW_MATCHUP`
- `TIER_CHANGE`
- `BANNER_CHANGE`
- `UNDERSIZE_CHANGE`
- `THREAT_CHANGE`
- `COMPOSITION_CHANGE`
- `POSSIBLE_DUPLICATE`
- `STALE_MATCHUP`
- `RETIREMENT_CANDIDATE`
- `MISSING_UNIT`

Core fields:

| Field | Purpose |
|---|---|
| `finding_id`, `run_id` | Identity and producing run |
| `finding_type` | Controlled finding type |
| `subject_type`, `subject_id` | Affected entity |
| `proposed_change` | Structured JSONB delta |
| `confidence` | Mechanically bounded confidence |
| `decision` | `PUBLISH`, `OBSERVE`, `ESCALATE`, or `REJECT` |
| `reasoning_summary` | Evidence-backed explanation |
| `created_at` | Timestamp |

Decision meanings:

| Decision | Meaning | Human action |
|---|---|---|
| `PUBLISH` | Policy supports inclusion in the next validated release | None |
| `OBSERVE` | Potentially meaningful but evidence is insufficient | None |
| `ESCALATE` | Material decision is required and no safe policy resolves it | User decision |
| `REJECT` | Noise, duplication, invalid evidence or disproven hypothesis | None |

The existence of uncertainty does not create a human task. Escalation requires material relevance, enough evidence to require a decision now, and no safe policy resolution.

---

## 8. Publication model

### 8.1 `catalogue_releases`

Each candidate or published catalogue is an immutable JSON snapshot.

| Field | Purpose |
|---|---|
| `release_id` | Internal key |
| `version` | Monotonic public version |
| `maintenance_run_id` | Producing run, nullable for migration/manual release |
| `scope` | Release scope/format metadata |
| `status` | `CANDIDATE`, `PUBLISHED`, `SUPERSEDED`, or `REJECTED` |
| `payload` | Complete app-facing JSON catalogue |
| `checksum` | Payload integrity and idempotency |
| `created_at`, `published_at` | Lifecycle timestamps |

The payload should preserve the app-facing concepts required by the PWA, including units, team definitions, compositions, matchups, tiers, banner scores, undersize, threat, board configuration and scoring.

The implementation may initially provide a compatibility payload matching today's Apps Script contract to reduce frontend migration risk.

### 8.2 `catalogue_state`

A singleton row holds `current_release_id`.

Publication is one transaction:

1. materialise the candidate model;
2. generate the complete payload;
3. validate schema, referential integrity and product rules;
4. insert the immutable release;
5. atomically update `current_release_id`.

Rollback atomically points `current_release_id` to a prior valid release.

No client should read mutable working tables as its live catalogue. The app reads only the current published snapshot through a read-only endpoint.

---

## 9. Deterministic application configuration

Counter maintenance must not control game rules or application configuration.

### 9.1 `gac_board_config`

Stores league, mode, territory, territory type, team count and ordering.

### 9.2 `gac_scoring_rules`

Stores the deterministic scoring rules currently represented by the Sheet's `GAC_Scoring` tab.

The autonomous maintenance role has no permission to change either configuration domain.

Existing tactical notes are also outside initial statistical automation. The system may preserve and publish migrated notes, but must not rewrite tactical instructions merely from win-rate statistics.

---

## 10. Autonomous decision policy

The policy is the maintenance system's safety and editorial constitution. Its machine-readable values should live in version control, for example `maintenance/policy.yaml`, with explanatory operational documentation alongside it.

The maintenance process may apply policy but may not change policy.

### 10.1 Evidence eligibility and weighting

Evidence must remain mode-specific:

- 3v3 evidence informs 3v3 squad knowledge;
- 5v5 evidence informs 5v5 squad knowledge;
- fleet evidence informs fleet knowledge.

A provisional recency weighting is:

- current completed same-format cycle: 60%;
- previous same-format cycle: 25%;
- earlier same-format evidence: 15%.

Both raw and effective weighted sample sizes must be recorded. These values are initial parameters, not permanent product truths.

### 10.2 Confidence

Confidence is calculated mechanically from:

- volume;
- consistency;
- recency;
- identity/mapping certainty;
- source quality;
- stability under reasonable filtering.

The semantic analyst may lower confidence because of ambiguity but may not increase it beyond the mechanical bound.

### 10.3 New archetypes

New identities carry the highest burden of proof.

Initial policy:

- fewer than 25 relevant observations: reject/ignore as identity evidence;
- 25–99: observe;
- 100 or more plus a permitted strategic distinction: eligible for autonomous publication;
- maximum five automatically created archetypes per run.

A clearly new official leader or structurally new faction team may establish identity with less performance evidence, but its matchups still require their own performance evidence.

Exceeding the run limit is an anomaly, not a queue of additional automatic identities.

### 10.4 New matchups and usefulness

Initial evidence thresholds:

| Relevant attempts | Default outcome |
|---:|---|
| Fewer than 20 | Reject/ignore as catalogue evidence |
| 20–49 | Observe |
| 50–99 | Observe unless exceptionally strong and stable |
| 100+ | Eligible for publication |
| 250+ | Strong evidence |
| 1,000+ | Very strong evidence |

An ordinary published counter should initially require approximately 80% weighted win rate. An automatic S-tier candidate should normally require approximately 90%.

Evidence alone is not enough. A new counter must add useful choice through at least one of:

- greater reliability;
- materially different roster resources;
- non-GL or otherwise useful accessibility;
- meaningfully better banners;
- safe undersize;
- coverage for a defence with few viable answers.

Strategically redundant counters may remain in evidence without entering the published catalogue.

### 10.5 Tier and tier movement

Tier continues to mean reliability, not banner efficiency.

Initial candidate bands:

- S: about 90% or better weighted wins;
- A: about 80–89.9%;
- B: about 65–79.9%;
- C: below that only when still strategically useful.

Context may downgrade a mechanically suggested tier when success depends on a narrow composition, datacron or other caveat. It may not arbitrarily upgrade it.

Hysteresis prevents oscillation. Normally a matchup may move by at most one tier per maintenance run. A proposed S-to-C jump should be staged or escalated unless correcting a demonstrable data error.

### 10.6 Banner score

Banner score remains the expected full-squad, first-attempt, clean-clear value. Source averages must not be copied until losses, cleanup attempts and undersized attempts are normalised to that meaning.

A published value changes only when:

- the rounded practical expectation changes by at least one banner; and
- confidence is sufficient.

### 10.7 Undersize

Undersize means the safe recommended drop count, not the largest stunt clear observed.

Initial policy:

- at least 50 observations at the proposed undersize;
- about 90% or better weighted win rate;
- no dependence on an obscure or exceptional composition.

A 0-to-1 change may publish at high confidence. Larger jumps require stronger evidence and may be staged.

### 10.8 Threat

Threat uses `LOW`, `NORMAL`, `HIGH`, and `EXTREME`, drawing on hold rate, attacking strength required, banners conceded, cleanup rate and failed first attempts where available.

Threat changes slowly and should not follow popularity alone.

### 10.9 Composition changes

Observed member variation is presumed to be flex variation first.

Changing a recommended member is relatively cheap. Changing the required core needs high confidence because it changes ownership checks, round availability and resource conflicts.

### 10.10 Duplicate detection and merging

Potential duplicates share signals such as the same leader, substantial required-core overlap, the same mode and similar matchup behaviour.

The system should identify duplicates proactively. Obvious migration duplicates may be merged automatically with redirect history. Ambiguous merges escalate because they alter stable identity and dependent relationships.

### 10.11 Staleness and retirement

Absence of evidence is not immediate evidence of invalidity.

Initial same-format-cycle guidance:

- one to two cycles without support: no action;
- about three cycles: mark stale internally;
- four to five cycles: review candidate;
- longer absence: retirement eligibility only when usage or meta evidence also supports obsolescence.

Retirement is `ACTIVE -> RETIRED`, not deletion. Automatic retirement should initially be stricter than addition and require sustained evidence across multiple same-format cycles.

### 10.12 Conflicting sources

Source evidence is retained separately and not averaged blindly. Policy records source priority, reliability and semantic compatibility.

Material immature disagreement becomes `OBSERVE`. It becomes `ESCALATE` only when it blocks an important decision that cannot safely wait.

### 10.13 Run-level anomaly protection

The entire candidate release is stopped when a run resembles a parser or mapping failure rather than ordinary meta change.

Initial anomaly examples:

- more than five new archetypes;
- more than 25% of current matchups changing tier;
- more than 10% of the catalogue proposed for retirement;
- widespread banner movement in one direction;
- unusually high mapping failure;
- an implausible source-volume change.

Evidence and findings remain available for diagnosis, but nothing publishes.

---

## 11. Publication validation

Before publication, deterministic validation must prove at least:

- no orphan IDs;
- no duplicate matchup keys;
- every required member references an existing compatible unit;
- profile and matchup modes are valid;
- tiers and threats use legal values;
- banner scores fall within mode-specific limits;
- undersize values fall within format limits;
- active records do not point incorrectly to retired or merged identities;
- every required PWA contract can be generated;
- payload schema validation passes;
- checksum/version rules pass;
- run-level anomaly limits pass.

If any validation fails, publish nothing.

---

## 12. Security and authority boundaries

Use separate least-privilege roles or equivalent credentials:

- **App reader:** may read only the current published catalogue endpoint.
- **Evidence ingester:** may insert source observations and run metadata; cannot publish.
- **Maintenance analyst:** may create mappings, assessments and findings; cannot change policy, schema or application configuration.
- **Publisher function:** may build a release only through deterministic validation and atomically update the current pointer.
- **Migration/admin role:** held outside routine automation and used only for approved schema/configuration work.

The AI may autonomously:

- map observations to existing archetypes;
- propose or create qualifying archetypes;
- propose or create qualifying matchups;
- assess tier, banner, undersize and threat;
- identify composition change or duplication;
- decide `PUBLISH`, `OBSERVE`, `ESCALATE` or `REJECT` within policy;
- explain anomalies.

The AI may not autonomously:

- alter maintenance policy;
- change scoring or board configuration;
- alter database schema or migrations;
- weaken validation;
- change authentication, secrets or permissions;
- deploy application code;
- broaden its own authority.

Database credentials used by automation must not provide a path around the publishing function.

---

## 13. Repository and environments

The target is a single authoritative repository rather than separate development and live code repositories.

Desired model:

- `main` is the authoritative source;
- automated checks protect promotion;
- development/staging and production use explicit environment-specific configuration;
- production deployment is an explicit promotion of a tested commit;
- secrets remain outside source control;
- schema changes are migrations reviewed with application changes;
- maintenance code, policy and tests live with the product while retaining separate runtime permissions.

The final hosting and branch/environment mechanics must be designed during implementation from the capabilities actually available. This document does not authorise repository deletion or consolidation.

---

## 14. Migration and cutover

Because the app has one primary user, optimise for recoverability and validation rather than prolonged dual-write.

Preferred cutover:

1. export and retain a timestamped backup of the current Google Sheet;
2. apply the complete canonical schema in the target database;
3. migrate units, team identities, profiles, matchups, notes, board configuration and scoring;
4. explicitly detect and resolve duplicate or ambiguous identities;
5. validate counts, relationships and app-facing payload parity;
6. create the first immutable catalogue release as a legacy migration;
7. point the development environment at the new read endpoint;
8. validate real use, cache/offline behaviour and rollback;
9. promote the tested version to production;
10. archive the Sheet as a fallback and remove it from the runtime path.

Avoid a long-lived autonomous-AI-to-Sheets transition and avoid dual-write unless implementation evidence reveals a need.

Migration must preserve stable current IDs where practical. Where defence names become stable archetype codes, maintain a deterministic mapping and report unresolved cases rather than guessing.

---

## 15. Minimal implementation sequence

The programme should use three stages, with nearly all manual GitHub/database setup concentrated in Stage 1.

### Stage 1 — Foundation and one-time infrastructure session

In one coordinated setup session:

- confirm the one-repository/environment design;
- create and configure the target database project and access roles;
- configure required repository environments and secrets;
- apply the complete canonical schema;
- check in the maintenance policy and architectural authorities;
- migrate and validate the full existing catalogue;
- implement the current-catalogue read endpoint;
- adapt the existing PWA to the compatibility payload;
- prove release creation, current-pointer rollback and cache-first operation.

Exit criterion:

> The existing GAC Helper runs correctly against the new canonical database, and Google Sheets is no longer in the runtime path.

### Stage 2 — Autonomous maintenance engine

Implement:

- evidence ingestion;
- idempotent source snapshots;
- canonical mapping;
- assessment generation;
- maintenance findings;
- policy decisions;
- candidate catalogue construction;
- deterministic validation;
- release publication machinery.

Run against real evidence in report-only mode first. Report-only is a bounded validation period, not a permanent manual workflow. It must use the production-shaped schema and permissions.

Exit criterion:

> The system's proposed decisions are credible across representative completed cycles, and failure/anomaly cases prevent publication correctly.

### Stage 3 — Scheduling and operational hardening

Connect the engine to the real cadence:

- detect a completed GAC cycle and evidence readiness;
- execute or resume one idempotent maintenance run;
- publish when all gates pass;
- produce a concise run report;
- alert only on escalation or failure;
- prove retries, source outages, anomaly stops, rollback and release restoration;
- enable bounded autonomous publication.

Exit criterion:

> Routine counter maintenance operates without human approval, while policy exceptions and failures remain visible and recoverable.

Stages 2 and 3 should require little or no new infrastructure configuration beyond the foundation established in Stage 1.

---

## 16. Cost model

The target should be viable with no new recurring paid service under normal personal use.

Expected low-cost components:

- existing GitHub repository and static hosting;
- a free or already-paid Postgres-compatible host if its current limits are sufficient;
- existing self-hosted Comlink arrangement;
- ChatGPT Plus for scheduled semantic work if capability validation succeeds.

Cost must be checked against current provider limits during implementation. The design must not assume that a free tier, scheduled-task capability or external database access remains unchanged.

Before adding a paid AI API or worker, demonstrate that the no-new-cost runner cannot meet reliability, scheduling or authenticated-access needs. If a paid component becomes necessary, it requires an explicit decision with expected monthly cost and a cheaper alternative.

---

## 17. Observability and operational outputs

Each run should leave enough information to answer:

- what source snapshot was used;
- which policy and analyst versions ran;
- how many observations mapped, failed or remained ambiguous;
- what findings were published, observed, escalated or rejected;
- which anomaly and validation gates ran;
- whether a release was created and made current;
- how to restore the previous release.

Routine successful output should be concise. `OBSERVE` findings stay silent unless included in an optional summary. Only failures and genuine `ESCALATE` decisions should demand user attention.

Retention periods for raw source JSON, observations and historical releases should be set after measuring actual volume. Do not add premature archival infrastructure.

---

## 18. Initial decisions proposed for lock

1. Postgres-compatible relational storage is the target canonical store.
2. Google Sheets is not part of the target runtime architecture.
3. A single `team_archetypes` registry covers attacking and defensive strategic identities.
4. 3v3, 5v5 and Fleet differences live in profiles and matchups, not duplicated identities by default.
5. Exact observed squads belong in evidence, not automatically in the catalogue.
6. New team identities carry a deliberately high burden of proof.
7. Matchups are unique by mode, defence archetype and counter archetype.
8. Evidence and assessments are append-only historical records.
9. Published catalogues are immutable JSON snapshots.
10. Publication is atomic and rollback is pointer-based.
11. Maintenance policy is version-controlled and outside AI write authority.
12. Routine autonomous operation should require no human approval.
13. `OBSERVE` is silent; only genuine `ESCALATE` cases ask the user.
14. The first implementation should not require a paid AI API.
15. The live PWA remains cache-first and consumes only a validated published catalogue.
16. The implementation uses three stages with manual infrastructure work concentrated in Stage 1.

---

## 19. Open implementation decisions

These are intentionally not settled by v0.1:

- final database host and region;
- exact repository consolidation mechanics and production hosting;
- evidence provider availability, licence/terms and stable retrieval interface;
- exact evidence observation idempotency key;
- whether ChatGPT Plus can reliably perform the required scheduled authenticated workflow;
- whether fleet should share a maintenance run with squad mode or have its own cycle key;
- exact confidence formula and source-quality weights;
- final threshold tuning after report-only runs;
- retention periods for evidence and releases;
- whether the compatibility payload is permanent or later replaced by a versioned API contract;
- authentication method for the read endpoint and maintenance runner;
- recovery procedure if the database host pauses or becomes unavailable.

These should be resolved from fresh implementation evidence rather than guessed in architecture.

---

## 20. Peer-review brief

A reviewer should challenge this design specifically for:

- unnecessary complexity for a single-user hobby app;
- missing entities, constraints or lifecycle states;
- whether archetype/profile separation is correct;
- whether one attack/defence profile per archetype and mode is too restrictive;
- whether exact observed compositions can be mapped without information loss;
- data provenance, idempotency and reproducibility gaps;
- thresholds that invite catalogue bloat, oscillation or stale advice;
- unsafe AI permissions or paths around deterministic publication;
- publication race conditions and rollback weaknesses;
- migration risks from the current Sheet model;
- assumptions that would introduce recurring cost;
- feasibility of a ChatGPT Plus scheduled runner;
- ways to simplify the three-stage build while retaining a safe checkpoint;
- any current product behaviour or API concept that the target payload fails to preserve.

The review should distinguish:

- architectural flaws that must be corrected before implementation;
- implementation details that can safely be deferred;
- optional enhancements that should not expand the first build.
