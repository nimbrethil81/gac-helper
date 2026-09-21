begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gac_migration_admin') then
    create role gac_migration_admin
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$$;

grant gac_migration_admin to postgres;
do $$
begin
  execute format('grant create on database %I to gac_migration_admin', current_database());
end
$$;
set role gac_migration_admin;

create schema gac authorization gac_migration_admin;
revoke all on schema gac from public;

create type gac.unit_type as enum ('CHARACTER', 'SHIP', 'CAPITAL_SHIP');
create type gac.battle_type as enum ('SQUAD', 'FLEET', 'ANY');
create type gac.catalogue_mode as enum ('ANY', '3V3', '5V5', 'FLEET');
create type gac.archetype_status as enum ('ACTIVE', 'RETIRED', 'MERGED');
create type gac.identity_reason as enum (
  'DISTINCT_LEADER',
  'DISTINCT_CORE',
  'DISTINCT_RESOURCE_CONFLICT',
  'DISTINCT_MATCHUP_BEHAVIOUR',
  'NEW_GAME_ARCHETYPE',
  'LEGACY_MIGRATION',
  'OTHER_APPROVED'
);
create type gac.actor_origin as enum ('HUMAN', 'AUTOMATION');
create type gac.usage_role as enum ('ATTACK', 'DEFENCE');
create type gac.profile_status as enum ('ACTIVE', 'RETIRED');
create type gac.member_role as enum ('REQUIRED', 'RECOMMENDED');
create type gac.matchup_status as enum ('ACTIVE', 'RETIRED');
create type gac.authority_state as enum ('AUTHORED_LOCKED', 'AUTHORED_BASELINE', 'ASSESSED');
create type gac.tier as enum ('S', 'A', 'B', 'C');
create type gac.threat as enum ('LOW', 'NORMAL', 'HIGH', 'EXTREME');
create type gac.mapping_method as enum ('EXACT', 'RULE', 'AI');
create type gac.mapping_outcome as enum (
  'CANONICAL',
  'FLEX_VARIANT',
  'UNDERSIZED_VARIANT',
  'EXPANDED_VARIANT',
  'UNRESOLVED'
);
create type gac.run_status as enum (
  'PENDING',
  'INGESTING',
  'ANALYSING',
  'READY',
  'COMPLETED',
  'FAILED',
  'SUPERSEDED'
);
create type gac.finding_type as enum (
  'NEW_ARCHETYPE',
  'NEW_MATCHUP',
  'TIER_CHANGE',
  'BANNER_CHANGE',
  'UNDERSIZE_CHANGE',
  'THREAT_CHANGE',
  'COMPOSITION_CHANGE',
  'NOTE_CHANGE',
  'POSSIBLE_DUPLICATE',
  'STALE_MATCHUP',
  'RETIREMENT_CANDIDATE',
  'MISSING_UNIT'
);
create type gac.finding_decision as enum ('PUBLISH', 'OBSERVE', 'ESCALATE', 'REJECT');
create type gac.application_result as enum ('PENDING', 'APPLIED', 'SKIPPED', 'FAILED');
create type gac.release_reason as enum ('MIGRATION', 'AUTHORING', 'MAINTENANCE', 'APPROVED_OVERRIDE');
create type gac.release_status as enum ('CANDIDATE', 'READY', 'DEPLOYED', 'SUPERSEDED', 'REJECTED');
create type gac.authoring_status as enum ('PENDING', 'APPLIED', 'REJECTED');
create type gac.provenance_kind as enum ('MIGRATION', 'AUTHORING_CHANGE', 'MAINTENANCE_RUN', 'ROLLBACK');

create function gac.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end
$$;
revoke all on function gac.set_updated_at() from public;

create table gac.units (
  unit_id text primary key,
  display_name text not null,
  external_id text unique,
  unit_type gac.unit_type not null,
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint units_unit_id_format check (unit_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  constraint units_display_name_nonempty check (btrim(display_name) <> ''),
  constraint units_external_id_nonempty check (external_id is null or btrim(external_id) <> '')
);

create table gac.team_archetypes (
  archetype_id bigint generated always as identity primary key,
  archetype_code text not null unique,
  display_name text not null,
  battle_type gac.battle_type not null,
  status gac.archetype_status not null default 'ACTIVE',
  merged_into_id bigint references gac.team_archetypes(archetype_id),
  identity_reason gac.identity_reason not null,
  identity_reason_detail text,
  created_by gac.actor_origin not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint team_archetypes_code_format check (archetype_code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  constraint team_archetypes_display_name_nonempty check (btrim(display_name) <> ''),
  constraint team_archetypes_battle_type check (battle_type <> 'ANY'),
  constraint team_archetypes_merge_state check (
    (status = 'MERGED' and merged_into_id is not null)
    or (status <> 'MERGED' and merged_into_id is null)
  ),
  constraint team_archetypes_not_self_merged check (merged_into_id is null or merged_into_id <> archetype_id),
  constraint team_archetypes_reason_detail check (
    (identity_reason = 'OTHER_APPROVED' and coalesce(btrim(identity_reason_detail), '') <> '')
    or (identity_reason <> 'OTHER_APPROVED')
  )
);
create index team_archetypes_merged_into_id_idx on gac.team_archetypes (merged_into_id);

create table gac.team_profiles (
  profile_id bigint generated always as identity primary key,
  archetype_id bigint not null references gac.team_archetypes(archetype_id),
  mode gac.catalogue_mode not null,
  usage_role gac.usage_role not null,
  flex_slots smallint not null default 0,
  members_complete boolean not null default false,
  status gac.profile_status not null default 'ACTIVE',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint team_profiles_unique unique (archetype_id, mode, usage_role),
  constraint team_profiles_flex_slots_nonnegative check (flex_slots >= 0)
);
create index team_profiles_archetype_id_idx on gac.team_profiles (archetype_id);

create table gac.team_profile_members (
  profile_id bigint not null references gac.team_profiles(profile_id) on delete cascade,
  unit_id text not null references gac.units(unit_id),
  member_role gac.member_role not null,
  is_leader boolean not null default false,
  sort_order smallint not null,
  primary key (profile_id, unit_id),
  constraint team_profile_members_sort_order_nonnegative check (sort_order >= 0),
  constraint team_profile_members_leader_required check (not is_leader or member_role = 'REQUIRED'),
  constraint team_profile_members_profile_sort_unique unique (profile_id, sort_order)
);
create index team_profile_members_unit_id_idx on gac.team_profile_members (unit_id);
create unique index team_profile_members_one_leader_idx
  on gac.team_profile_members (profile_id) where is_leader;

create table gac.maintenance_runs (
  run_id bigint generated always as identity primary key,
  cycle_key text not null,
  mode gac.catalogue_mode not null,
  attempt integer not null default 1,
  triggered_at timestamptz not null default statement_timestamp(),
  evidence_ready_at timestamptz,
  completed_at timestamptz,
  status gac.run_status not null default 'PENDING',
  policy_version text not null,
  analyst_version text,
  source_snapshot jsonb not null default '{}'::jsonb,
  published_release_id bigint,
  constraint maintenance_runs_cycle_key_nonempty check (btrim(cycle_key) <> ''),
  constraint maintenance_runs_mode check (mode <> 'ANY'),
  constraint maintenance_runs_attempt_positive check (attempt > 0),
  constraint maintenance_runs_policy_version_nonempty check (btrim(policy_version) <> ''),
  constraint maintenance_runs_source_snapshot_object check (jsonb_typeof(source_snapshot) = 'object'),
  constraint maintenance_runs_unique_attempt unique (cycle_key, mode, attempt),
  constraint maintenance_runs_completion_state check (
    (status in ('COMPLETED', 'FAILED', 'SUPERSEDED') and completed_at is not null)
    or (status not in ('COMPLETED', 'FAILED', 'SUPERSEDED') and completed_at is null)
  )
);
create unique index maintenance_runs_one_active_attempt_idx
  on gac.maintenance_runs (cycle_key, mode)
  where status in ('PENDING', 'INGESTING', 'ANALYSING', 'READY');

create table gac.matchups (
  matchup_id bigint generated always as identity primary key,
  mode gac.catalogue_mode not null,
  defence_archetype_id bigint not null references gac.team_archetypes(archetype_id),
  counter_archetype_id bigint not null references gac.team_archetypes(archetype_id),
  status gac.matchup_status not null default 'ACTIVE',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  retired_at timestamptz,
  retired_reason text,
  retired_by_run_id bigint references gac.maintenance_runs(run_id),
  constraint matchups_mode check (mode <> 'ANY'),
  constraint matchups_distinct_archetypes check (defence_archetype_id <> counter_archetype_id),
  constraint matchups_unique_relationship unique (mode, defence_archetype_id, counter_archetype_id),
  constraint matchups_retirement_state check (
    (status = 'ACTIVE' and retired_at is null and retired_reason is null and retired_by_run_id is null)
    or (status = 'RETIRED' and retired_at is not null and coalesce(btrim(retired_reason), '') <> '')
  )
);
create index matchups_defence_archetype_id_idx on gac.matchups (defence_archetype_id);
create index matchups_counter_archetype_id_idx on gac.matchups (counter_archetype_id);
create index matchups_retired_by_run_id_idx on gac.matchups (retired_by_run_id);

create table gac.evidence_sources (
  source_id bigint generated always as identity primary key,
  source_code text not null unique,
  name text not null,
  active boolean not null default true,
  priority integer not null,
  terms_checked_at date not null,
  retrieval_contract_version text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint evidence_sources_code_format check (source_code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  constraint evidence_sources_name_nonempty check (btrim(name) <> ''),
  constraint evidence_sources_priority_nonnegative check (priority >= 0),
  constraint evidence_sources_contract_nonempty check (btrim(retrieval_contract_version) <> '')
);

create table gac.evidence_observations (
  observation_id bigint generated always as identity primary key,
  source_id bigint not null references gac.evidence_sources(source_id),
  maintenance_run_id bigint not null references gac.maintenance_runs(run_id),
  source_cycle_key text not null,
  mode gac.catalogue_mode not null,
  observed_defence_signature text not null,
  observed_attack_signature text not null,
  source_url text,
  source_data jsonb not null,
  content_hash text not null,
  retrieved_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint evidence_observations_mode check (mode <> 'ANY'),
  constraint evidence_observations_cycle_nonempty check (btrim(source_cycle_key) <> ''),
  constraint evidence_observations_defence_signature_nonempty check (btrim(observed_defence_signature) <> ''),
  constraint evidence_observations_attack_signature_nonempty check (btrim(observed_attack_signature) <> ''),
  constraint evidence_observations_source_data_object check (jsonb_typeof(source_data) = 'object'),
  constraint evidence_observations_hash_format check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint evidence_observations_source_hash_unique unique (source_id, content_hash)
);
create index evidence_observations_maintenance_run_id_idx on gac.evidence_observations (maintenance_run_id);

create table gac.evidence_mappings (
  observation_id bigint primary key references gac.evidence_observations(observation_id) on delete cascade,
  defence_archetype_id bigint references gac.team_archetypes(archetype_id),
  counter_archetype_id bigint references gac.team_archetypes(archetype_id),
  mapping_confidence numeric(5, 4) not null,
  mapping_method gac.mapping_method not null,
  mapping_outcome gac.mapping_outcome not null,
  observed_attack_unit_count smallint not null,
  mapping_notes text,
  created_at timestamptz not null default statement_timestamp(),
  constraint evidence_mappings_confidence_range check (mapping_confidence between 0 and 1),
  constraint evidence_mappings_unit_count_positive check (observed_attack_unit_count > 0),
  constraint evidence_mappings_resolution_state check (
    (mapping_outcome = 'UNRESOLVED' and defence_archetype_id is null and counter_archetype_id is null)
    or (mapping_outcome <> 'UNRESOLVED' and defence_archetype_id is not null and counter_archetype_id is not null)
  )
);
create index evidence_mappings_defence_archetype_id_idx on gac.evidence_mappings (defence_archetype_id);
create index evidence_mappings_counter_archetype_id_idx on gac.evidence_mappings (counter_archetype_id);

create table gac.matchup_assessments (
  assessment_id bigint generated always as identity primary key,
  matchup_id bigint not null references gac.matchups(matchup_id),
  maintenance_run_id bigint not null references gac.maintenance_runs(run_id),
  normalised_measures jsonb not null,
  proposed_tier gac.tier,
  proposed_banner_score smallint,
  proposed_undersize smallint,
  confidence_score numeric(5, 4) not null,
  evidence_summary text not null,
  reasoning_summary text not null,
  method_version text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint matchup_assessments_measures_object check (jsonb_typeof(normalised_measures) = 'object'),
  constraint matchup_assessments_banner_range check (proposed_banner_score is null or proposed_banner_score between 0 and 100),
  constraint matchup_assessments_undersize_range check (proposed_undersize is null or proposed_undersize between 0 and 5),
  constraint matchup_assessments_confidence_range check (confidence_score between 0 and 1),
  constraint matchup_assessments_evidence_nonempty check (btrim(evidence_summary) <> ''),
  constraint matchup_assessments_reasoning_nonempty check (btrim(reasoning_summary) <> ''),
  constraint matchup_assessments_method_nonempty check (btrim(method_version) <> '')
);
create index matchup_assessments_matchup_id_idx on gac.matchup_assessments (matchup_id);
create index matchup_assessments_maintenance_run_id_idx on gac.matchup_assessments (maintenance_run_id);

create table gac.defence_assessments (
  assessment_id bigint generated always as identity primary key,
  archetype_id bigint not null references gac.team_archetypes(archetype_id),
  mode gac.catalogue_mode not null,
  maintenance_run_id bigint not null references gac.maintenance_runs(run_id),
  normalised_measures jsonb not null,
  proposed_threat gac.threat,
  confidence_score numeric(5, 4) not null,
  evidence_summary text not null,
  reasoning_summary text not null,
  method_version text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint defence_assessments_confidence_range check (confidence_score between 0 and 1),
  constraint defence_assessments_measures_object check (jsonb_typeof(normalised_measures) = 'object'),
  constraint defence_assessments_evidence_nonempty check (btrim(evidence_summary) <> ''),
  constraint defence_assessments_reasoning_nonempty check (btrim(reasoning_summary) <> ''),
  constraint defence_assessments_method_nonempty check (btrim(method_version) <> '')
);
create index defence_assessments_archetype_id_idx on gac.defence_assessments (archetype_id);
create index defence_assessments_maintenance_run_id_idx on gac.defence_assessments (maintenance_run_id);

create table gac.maintenance_findings (
  finding_id bigint generated always as identity primary key,
  maintenance_run_id bigint not null references gac.maintenance_runs(run_id),
  finding_type gac.finding_type not null,
  subject_matchup_id bigint references gac.matchups(matchup_id),
  subject_archetype_id bigint references gac.team_archetypes(archetype_id),
  proposed_change jsonb not null,
  mechanical_confidence numeric(5, 4) not null,
  decision gac.finding_decision not null,
  reasoning text not null,
  proposed_policy_version text not null,
  enforced_policy_version text,
  application_result gac.application_result not null default 'PENDING',
  application_notes text,
  created_at timestamptz not null default statement_timestamp(),
  applied_at timestamptz,
  constraint maintenance_findings_subject_present check (
    subject_matchup_id is not null or subject_archetype_id is not null
  ),
  constraint maintenance_findings_change_object check (jsonb_typeof(proposed_change) = 'object'),
  constraint maintenance_findings_confidence_range check (mechanical_confidence between 0 and 1),
  constraint maintenance_findings_reasoning_nonempty check (btrim(reasoning) <> ''),
  constraint maintenance_findings_policy_nonempty check (btrim(proposed_policy_version) <> ''),
  constraint maintenance_findings_application_state check (
    (application_result = 'APPLIED' and applied_at is not null and enforced_policy_version is not null)
    or (application_result <> 'APPLIED' and applied_at is null)
  )
);
create index maintenance_findings_maintenance_run_id_idx on gac.maintenance_findings (maintenance_run_id);
create index maintenance_findings_subject_matchup_id_idx on gac.maintenance_findings (subject_matchup_id);
create index maintenance_findings_subject_archetype_id_idx on gac.maintenance_findings (subject_archetype_id);

create table gac.matchup_catalogue_values (
  matchup_id bigint primary key references gac.matchups(matchup_id) on delete cascade,
  tier gac.tier not null,
  banner_score smallint not null,
  undersize smallint not null default 0,
  notes text not null default '',
  tier_authority gac.authority_state not null,
  banner_authority gac.authority_state not null,
  undersize_authority gac.authority_state not null,
  source_assessment_id bigint references gac.matchup_assessments(assessment_id),
  source_finding_id bigint references gac.maintenance_findings(finding_id),
  updated_at timestamptz not null default statement_timestamp(),
  constraint matchup_catalogue_values_banner_range check (banner_score between 0 and 100),
  constraint matchup_catalogue_values_undersize_range check (undersize between 0 and 5),
  constraint matchup_catalogue_values_assessed_provenance check (
    (tier_authority <> 'ASSESSED' and banner_authority <> 'ASSESSED' and undersize_authority <> 'ASSESSED')
    or (source_assessment_id is not null and source_finding_id is not null)
  )
);
create index matchup_catalogue_values_source_assessment_id_idx on gac.matchup_catalogue_values (source_assessment_id);
create index matchup_catalogue_values_source_finding_id_idx on gac.matchup_catalogue_values (source_finding_id);

create table gac.defence_catalogue_values (
  archetype_id bigint not null references gac.team_archetypes(archetype_id),
  mode gac.catalogue_mode not null,
  threat gac.threat not null,
  notes text not null default '',
  threat_authority gac.authority_state not null,
  source_assessment_id bigint references gac.defence_assessments(assessment_id),
  source_finding_id bigint references gac.maintenance_findings(finding_id),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (archetype_id, mode),
  constraint defence_catalogue_values_assessed_provenance check (
    threat_authority <> 'ASSESSED'
    or (source_assessment_id is not null and source_finding_id is not null)
  )
);
create index defence_catalogue_values_source_assessment_id_idx on gac.defence_catalogue_values (source_assessment_id);
create index defence_catalogue_values_source_finding_id_idx on gac.defence_catalogue_values (source_finding_id);

create table gac.gac_board_config (
  league text not null,
  mode gac.catalogue_mode not null,
  territory text not null,
  territory_type gac.battle_type not null,
  team_count smallint not null,
  display_order smallint not null,
  updated_at timestamptz not null default statement_timestamp(),
  primary key (league, mode, territory),
  constraint gac_board_config_league check (league in ('KYBER', 'AURODIUM', 'CHROMIUM', 'BRONZIUM', 'CARBONITE')),
  constraint gac_board_config_mode check (mode in ('3V3', '5V5')),
  constraint gac_board_config_territory check (territory in ('FRONT_TOP', 'FRONT_BOTTOM', 'BACK_TOP', 'BACK_BOTTOM')),
  constraint gac_board_config_territory_type check (territory_type <> 'ANY'),
  constraint gac_board_config_team_count_nonnegative check (team_count >= 0),
  constraint gac_board_config_display_order_nonnegative check (display_order >= 0),
  constraint gac_board_config_order_unique unique (league, mode, display_order)
);

create table gac.gac_scoring_rules (
  rule_id text not null,
  battle_type gac.battle_type not null,
  mode gac.catalogue_mode not null,
  value integer not null,
  notes text not null default '',
  updated_at timestamptz not null default statement_timestamp(),
  primary key (rule_id, battle_type, mode),
  constraint gac_scoring_rules_rule_id_format check (rule_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$')
);

create table gac.catalogue_releases (
  release_id bigint generated always as identity primary key,
  version bigint not null unique,
  payload_schema_version integer not null,
  base_release_id bigint references gac.catalogue_releases(release_id),
  previous_release_id bigint references gac.catalogue_releases(release_id),
  maintenance_run_id bigint references gac.maintenance_runs(run_id),
  release_reason gac.release_reason not null,
  scope jsonb not null default '{}'::jsonb,
  status gac.release_status not null default 'CANDIDATE',
  payload jsonb not null,
  checksum text not null,
  source_commit_sha text not null,
  deployed_commit_sha text,
  cloudflare_deployment_id text,
  created_at timestamptz not null default statement_timestamp(),
  published_at timestamptz,
  constraint catalogue_releases_version_positive check (version > 0),
  constraint catalogue_releases_schema_version_positive check (payload_schema_version > 0),
  constraint catalogue_releases_scope_object check (jsonb_typeof(scope) = 'object'),
  constraint catalogue_releases_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint catalogue_releases_checksum_format check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  constraint catalogue_releases_source_commit_sha_format check (source_commit_sha ~ '^[0-9a-f]{40}$'),
  constraint catalogue_releases_deployed_commit_sha_format check (
    deployed_commit_sha is null or deployed_commit_sha ~ '^[0-9a-f]{40}$'
  ),
  constraint catalogue_releases_not_self_referential check (
    (base_release_id is null or base_release_id <> release_id)
    and (previous_release_id is null or previous_release_id <> release_id)
  ),
  constraint catalogue_releases_lifecycle_fields check (
    (
      status in ('CANDIDATE', 'READY', 'REJECTED')
      and published_at is null
      and deployed_commit_sha is null
      and cloudflare_deployment_id is null
    )
    or (
      status in ('DEPLOYED', 'SUPERSEDED')
      and published_at is not null
      and deployed_commit_sha is not null
      and coalesce(btrim(cloudflare_deployment_id), '') <> ''
    )
  )
);
create index catalogue_releases_base_release_id_idx on gac.catalogue_releases (base_release_id);
create index catalogue_releases_previous_release_id_idx on gac.catalogue_releases (previous_release_id);
create index catalogue_releases_maintenance_run_id_idx on gac.catalogue_releases (maintenance_run_id);

alter table gac.maintenance_runs
  add constraint maintenance_runs_published_release_id_fkey
  foreign key (published_release_id) references gac.catalogue_releases(release_id);
create index maintenance_runs_published_release_id_idx on gac.maintenance_runs (published_release_id);

create table gac.catalogue_state (
  singleton_id boolean primary key default true,
  current_release_id bigint references gac.catalogue_releases(release_id),
  publication_generation bigint not null default 0,
  updated_at timestamptz not null default statement_timestamp(),
  constraint catalogue_state_singleton check (singleton_id),
  constraint catalogue_state_generation_nonnegative check (publication_generation >= 0)
);
insert into gac.catalogue_state (singleton_id) values (true);
create index catalogue_state_current_release_id_idx on gac.catalogue_state (current_release_id);

create table gac.authoring_changes (
  change_id text primary key,
  author text not null,
  authored_at timestamptz not null,
  entity_type text not null,
  operation text not null,
  expected_base_release_id bigint references gac.catalogue_releases(release_id),
  structured_values jsonb not null,
  authority gac.authority_state,
  reason text not null,
  status gac.authoring_status not null default 'PENDING',
  applied_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint authoring_changes_id_format check (change_id ~ '^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$'),
  constraint authoring_changes_author_nonempty check (btrim(author) <> ''),
  constraint authoring_changes_entity_nonempty check (btrim(entity_type) <> ''),
  constraint authoring_changes_operation_nonempty check (btrim(operation) <> ''),
  constraint authoring_changes_values_object check (jsonb_typeof(structured_values) = 'object'),
  constraint authoring_changes_reason_nonempty check (btrim(reason) <> ''),
  constraint authoring_changes_application_state check (
    (status = 'APPLIED' and applied_at is not null)
    or (status <> 'APPLIED' and applied_at is null)
  )
);
create index authoring_changes_expected_base_release_id_idx on gac.authoring_changes (expected_base_release_id);

create table gac.catalogue_release_authoring_changes (
  release_id bigint not null references gac.catalogue_releases(release_id) on delete cascade,
  change_id text not null references gac.authoring_changes(change_id),
  primary key (release_id, change_id)
);
create index catalogue_release_authoring_changes_change_id_idx
  on gac.catalogue_release_authoring_changes (change_id);

create table gac.catalogue_release_provenance (
  provenance_id bigint generated always as identity primary key,
  release_id bigint not null references gac.catalogue_releases(release_id) on delete cascade,
  kind gac.provenance_kind not null,
  reference_code text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint catalogue_release_provenance_reference_nonempty check (btrim(reference_code) <> ''),
  constraint catalogue_release_provenance_details_object check (jsonb_typeof(details) = 'object'),
  constraint catalogue_release_provenance_unique unique (release_id, kind, reference_code)
);
create index catalogue_release_provenance_release_id_idx on gac.catalogue_release_provenance (release_id);

create function gac.protect_unit_identity()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.unit_id is distinct from old.unit_id then
    raise exception 'unit_id is immutable';
  end if;
  return new;
end
$$;
revoke all on function gac.protect_unit_identity() from public;

create function gac.protect_archetype_identity()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.archetype_code is distinct from old.archetype_code then
    raise exception 'archetype_code is immutable';
  end if;
  return new;
end
$$;
revoke all on function gac.protect_archetype_identity() from public;

create function gac.validate_profile_mode()
returns trigger
language plpgsql
set search_path = pg_catalog, gac
as $$
declare
  archetype_battle_type gac.battle_type;
begin
  select battle_type into strict archetype_battle_type
  from gac.team_archetypes
  where archetype_id = new.archetype_id;

  if (archetype_battle_type = 'FLEET' and new.mode not in ('ANY', 'FLEET'))
    or (archetype_battle_type = 'SQUAD' and new.mode = 'FLEET') then
    raise exception 'profile mode % is incompatible with archetype battle type %', new.mode, archetype_battle_type;
  end if;
  return new;
end
$$;
revoke all on function gac.validate_profile_mode() from public;

create function gac.validate_matchup_mode()
returns trigger
language plpgsql
set search_path = pg_catalog, gac
as $$
declare
  defence_type gac.battle_type;
  counter_type gac.battle_type;
begin
  select battle_type into strict defence_type from gac.team_archetypes where archetype_id = new.defence_archetype_id;
  select battle_type into strict counter_type from gac.team_archetypes where archetype_id = new.counter_archetype_id;

  if defence_type is distinct from counter_type
    or (new.mode = 'FLEET' and defence_type <> 'FLEET')
    or (new.mode in ('3V3', '5V5') and defence_type <> 'SQUAD') then
    raise exception 'matchup mode and archetype battle types are incompatible';
  end if;
  return new;
end
$$;
revoke all on function gac.validate_matchup_mode() from public;

create function gac.enforce_release_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.version is distinct from old.version
    or new.payload_schema_version is distinct from old.payload_schema_version
    or new.base_release_id is distinct from old.base_release_id
    or new.previous_release_id is distinct from old.previous_release_id
    or new.maintenance_run_id is distinct from old.maintenance_run_id
    or new.release_reason is distinct from old.release_reason
    or new.scope is distinct from old.scope
    or new.payload is distinct from old.payload
    or new.checksum is distinct from old.checksum
    or new.source_commit_sha is distinct from old.source_commit_sha
    or new.created_at is distinct from old.created_at then
    raise exception 'immutable release fields cannot be changed';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'CANDIDATE' and new.status in ('READY', 'REJECTED'))
    or (old.status = 'READY' and new.status in ('DEPLOYED', 'REJECTED'))
    or (old.status = 'DEPLOYED' and new.status = 'SUPERSEDED')
  ) then
    raise exception 'invalid release transition from % to %', old.status, new.status;
  end if;
  return new;
end
$$;
revoke all on function gac.enforce_release_transition() from public;

create function gac.validate_current_release()
returns trigger
language plpgsql
set search_path = pg_catalog, gac
as $$
declare
  target_status gac.release_status;
begin
  if new.current_release_id is not null then
    select status into strict target_status
    from gac.catalogue_releases
    where release_id = new.current_release_id;
    if target_status <> 'DEPLOYED' then
      raise exception 'current release must be DEPLOYED';
    end if;
  end if;
  if new.publication_generation < old.publication_generation then
    raise exception 'publication_generation cannot decrease';
  end if;
  return new;
end
$$;
revoke all on function gac.validate_current_release() from public;

create trigger units_identity_immutable
before update on gac.units for each row execute function gac.protect_unit_identity();
create trigger team_archetypes_identity_immutable
before update on gac.team_archetypes for each row execute function gac.protect_archetype_identity();
create trigger team_profiles_validate_mode
before insert or update on gac.team_profiles for each row execute function gac.validate_profile_mode();
create trigger matchups_validate_mode
before insert or update on gac.matchups for each row execute function gac.validate_matchup_mode();
create trigger catalogue_releases_enforce_transition
before update on gac.catalogue_releases for each row execute function gac.enforce_release_transition();
create trigger catalogue_state_validate_release
before update on gac.catalogue_state for each row execute function gac.validate_current_release();

create trigger units_set_updated_at before update on gac.units
for each row execute function gac.set_updated_at();
create trigger team_archetypes_set_updated_at before update on gac.team_archetypes
for each row execute function gac.set_updated_at();
create trigger team_profiles_set_updated_at before update on gac.team_profiles
for each row execute function gac.set_updated_at();
create trigger matchups_set_updated_at before update on gac.matchups
for each row execute function gac.set_updated_at();
create trigger evidence_sources_set_updated_at before update on gac.evidence_sources
for each row execute function gac.set_updated_at();
create trigger matchup_catalogue_values_set_updated_at before update on gac.matchup_catalogue_values
for each row execute function gac.set_updated_at();
create trigger defence_catalogue_values_set_updated_at before update on gac.defence_catalogue_values
for each row execute function gac.set_updated_at();
create trigger gac_board_config_set_updated_at before update on gac.gac_board_config
for each row execute function gac.set_updated_at();
create trigger gac_scoring_rules_set_updated_at before update on gac.gac_scoring_rules
for each row execute function gac.set_updated_at();
create trigger catalogue_state_set_updated_at before update on gac.catalogue_state
for each row execute function gac.set_updated_at();

alter table gac.units enable row level security;
alter table gac.team_archetypes enable row level security;
alter table gac.team_profiles enable row level security;
alter table gac.team_profile_members enable row level security;
alter table gac.maintenance_runs enable row level security;
alter table gac.matchups enable row level security;
alter table gac.evidence_sources enable row level security;
alter table gac.evidence_observations enable row level security;
alter table gac.evidence_mappings enable row level security;
alter table gac.matchup_assessments enable row level security;
alter table gac.defence_assessments enable row level security;
alter table gac.maintenance_findings enable row level security;
alter table gac.matchup_catalogue_values enable row level security;
alter table gac.defence_catalogue_values enable row level security;
alter table gac.gac_board_config enable row level security;
alter table gac.gac_scoring_rules enable row level security;
alter table gac.catalogue_releases enable row level security;
alter table gac.catalogue_state enable row level security;
alter table gac.authoring_changes enable row level security;
alter table gac.catalogue_release_authoring_changes enable row level security;
alter table gac.catalogue_release_provenance enable row level security;

reset role;
commit;
