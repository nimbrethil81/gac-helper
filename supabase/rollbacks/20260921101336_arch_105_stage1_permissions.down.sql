begin;

set role gac_migration_admin;

drop policy if exists authoring_catalogue_access on gac.units;
drop policy if exists authoring_archetype_access on gac.team_archetypes;
drop policy if exists authoring_profile_access on gac.team_profiles;
drop policy if exists authoring_profile_member_access on gac.team_profile_members;
drop policy if exists authoring_matchup_access on gac.matchups;
drop policy if exists authoring_matchup_value_access on gac.matchup_catalogue_values;
drop policy if exists authoring_defence_value_access on gac.defence_catalogue_values;
drop policy if exists authoring_board_access on gac.gac_board_config;
drop policy if exists authoring_scoring_access on gac.gac_scoring_rules;
drop policy if exists authoring_change_access on gac.authoring_changes;
drop policy if exists authoring_release_read on gac.catalogue_releases;
drop policy if exists authoring_state_read on gac.catalogue_state;

drop policy if exists publisher_units_read on gac.units;
drop policy if exists publisher_archetypes_read on gac.team_archetypes;
drop policy if exists publisher_profiles_read on gac.team_profiles;
drop policy if exists publisher_profile_members_read on gac.team_profile_members;
drop policy if exists publisher_runs_read on gac.maintenance_runs;
drop policy if exists publisher_matchups_read on gac.matchups;
drop policy if exists publisher_sources_read on gac.evidence_sources;
drop policy if exists publisher_observations_read on gac.evidence_observations;
drop policy if exists publisher_mappings_read on gac.evidence_mappings;
drop policy if exists publisher_matchup_assessments_read on gac.matchup_assessments;
drop policy if exists publisher_defence_assessments_read on gac.defence_assessments;
drop policy if exists publisher_findings_read on gac.maintenance_findings;
drop policy if exists publisher_matchup_values_read on gac.matchup_catalogue_values;
drop policy if exists publisher_defence_values_read on gac.defence_catalogue_values;
drop policy if exists publisher_board_read on gac.gac_board_config;
drop policy if exists publisher_scoring_read on gac.gac_scoring_rules;
drop policy if exists publisher_changes_read on gac.authoring_changes;
drop policy if exists publisher_releases_access on gac.catalogue_releases;
drop policy if exists publisher_state_access on gac.catalogue_state;
drop policy if exists publisher_release_changes_access on gac.catalogue_release_authoring_changes;
drop policy if exists publisher_provenance_access on gac.catalogue_release_provenance;

revoke all on schema gac from gac_authoring, gac_publisher;
revoke all on all tables in schema gac from gac_authoring, gac_publisher;
revoke all on all sequences in schema gac from gac_authoring, gac_publisher;
revoke all on all functions in schema gac from gac_authoring, gac_publisher;

alter default privileges for role gac_migration_admin in schema gac
  revoke all on tables from gac_authoring, gac_publisher;
alter default privileges for role gac_migration_admin in schema gac
  revoke all on sequences from gac_authoring, gac_publisher;
alter default privileges for role gac_migration_admin in schema gac
  revoke execute on functions from gac_authoring, gac_publisher;

reset role;
drop owned by gac_authoring;
drop owned by gac_publisher;
drop role gac_authoring;
drop role gac_publisher;

commit;
