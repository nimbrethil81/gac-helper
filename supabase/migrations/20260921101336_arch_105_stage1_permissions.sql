begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gac_authoring') then
    create role gac_authoring
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gac_publisher') then
    create role gac_publisher
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$$;

set role gac_migration_admin;

revoke all on schema gac from public;
grant usage on schema gac to gac_authoring, gac_publisher;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema gac from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on schema gac from authenticated;
  end if;
end
$$;

revoke all on all tables in schema gac from public;
revoke all on all sequences in schema gac from public;
revoke all on all functions in schema gac from public;

alter default privileges for role gac_migration_admin in schema gac
  revoke all on tables from public;
alter default privileges for role gac_migration_admin in schema gac
  revoke all on sequences from public;
alter default privileges for role gac_migration_admin in schema gac
  revoke execute on functions from public;

grant select, insert, update on
  gac.units,
  gac.team_archetypes,
  gac.team_profiles,
  gac.team_profile_members,
  gac.matchups,
  gac.matchup_catalogue_values,
  gac.defence_catalogue_values,
  gac.gac_board_config,
  gac.gac_scoring_rules,
  gac.authoring_changes
to gac_authoring;
grant select on gac.catalogue_releases, gac.catalogue_state to gac_authoring;
grant usage, select on sequence
  gac.team_archetypes_archetype_id_seq,
  gac.team_profiles_profile_id_seq,
  gac.matchups_matchup_id_seq
to gac_authoring;

grant select on all tables in schema gac to gac_publisher;
grant insert on
  gac.catalogue_releases,
  gac.catalogue_release_authoring_changes,
  gac.catalogue_release_provenance
to gac_publisher;
grant update (status, published_at, deployed_commit_sha, cloudflare_deployment_id)
  on gac.catalogue_releases to gac_publisher;
grant update (current_release_id, publication_generation, updated_at)
  on gac.catalogue_state to gac_publisher;
grant usage, select on sequence
  gac.catalogue_releases_release_id_seq,
  gac.catalogue_release_provenance_provenance_id_seq
to gac_publisher;

create policy authoring_catalogue_access on gac.units
  for all to gac_authoring using (true) with check (true);
create policy authoring_archetype_access on gac.team_archetypes
  for all to gac_authoring using (true) with check (true);
create policy authoring_profile_access on gac.team_profiles
  for all to gac_authoring using (true) with check (true);
create policy authoring_profile_member_access on gac.team_profile_members
  for all to gac_authoring using (true) with check (true);
create policy authoring_matchup_access on gac.matchups
  for all to gac_authoring using (true) with check (true);
create policy authoring_matchup_value_access on gac.matchup_catalogue_values
  for all to gac_authoring using (true) with check (true);
create policy authoring_defence_value_access on gac.defence_catalogue_values
  for all to gac_authoring using (true) with check (true);
create policy authoring_board_access on gac.gac_board_config
  for all to gac_authoring using (true) with check (true);
create policy authoring_scoring_access on gac.gac_scoring_rules
  for all to gac_authoring using (true) with check (true);
create policy authoring_change_access on gac.authoring_changes
  for all to gac_authoring using (true) with check (true);
create policy authoring_release_read on gac.catalogue_releases
  for select to gac_authoring using (true);
create policy authoring_state_read on gac.catalogue_state
  for select to gac_authoring using (true);

create policy publisher_units_read on gac.units for select to gac_publisher using (true);
create policy publisher_archetypes_read on gac.team_archetypes for select to gac_publisher using (true);
create policy publisher_profiles_read on gac.team_profiles for select to gac_publisher using (true);
create policy publisher_profile_members_read on gac.team_profile_members for select to gac_publisher using (true);
create policy publisher_runs_read on gac.maintenance_runs for select to gac_publisher using (true);
create policy publisher_matchups_read on gac.matchups for select to gac_publisher using (true);
create policy publisher_sources_read on gac.evidence_sources for select to gac_publisher using (true);
create policy publisher_observations_read on gac.evidence_observations for select to gac_publisher using (true);
create policy publisher_mappings_read on gac.evidence_mappings for select to gac_publisher using (true);
create policy publisher_matchup_assessments_read on gac.matchup_assessments for select to gac_publisher using (true);
create policy publisher_defence_assessments_read on gac.defence_assessments for select to gac_publisher using (true);
create policy publisher_findings_read on gac.maintenance_findings for select to gac_publisher using (true);
create policy publisher_matchup_values_read on gac.matchup_catalogue_values for select to gac_publisher using (true);
create policy publisher_defence_values_read on gac.defence_catalogue_values for select to gac_publisher using (true);
create policy publisher_board_read on gac.gac_board_config for select to gac_publisher using (true);
create policy publisher_scoring_read on gac.gac_scoring_rules for select to gac_publisher using (true);
create policy publisher_changes_read on gac.authoring_changes for select to gac_publisher using (true);
create policy publisher_releases_access on gac.catalogue_releases
  for all to gac_publisher using (true) with check (true);
create policy publisher_state_access on gac.catalogue_state
  for all to gac_publisher using (true) with check (true);
create policy publisher_release_changes_access on gac.catalogue_release_authoring_changes
  for all to gac_publisher using (true) with check (true);
create policy publisher_provenance_access on gac.catalogue_release_provenance
  for all to gac_publisher using (true) with check (true);

reset role;
commit;
