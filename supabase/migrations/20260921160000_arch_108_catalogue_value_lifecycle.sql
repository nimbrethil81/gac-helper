-- ARCH-108 additive lifecycle support for authoring-owned child rows.
--
-- Retired rows remain present and auditable. Publication filters them, and
-- gac_authoring intentionally receives no DELETE grant.

begin;

set role gac_migration_admin;

alter table gac.team_profile_members
  add column status gac.profile_status not null default 'ACTIVE',
  add column retired_at timestamptz,
  add column retired_reason text,
  add constraint team_profile_members_retirement_state check (
    (status = 'ACTIVE' and retired_at is null and retired_reason is null)
    or (status = 'RETIRED' and retired_at is not null and coalesce(btrim(retired_reason), '') <> '')
  );

alter table gac.team_profile_members
  drop constraint team_profile_members_profile_sort_unique;
drop index gac.team_profile_members_one_leader_idx;

create unique index team_profile_members_active_sort_unique_idx
  on gac.team_profile_members (profile_id, sort_order)
  where status = 'ACTIVE';
create unique index team_profile_members_one_active_leader_idx
  on gac.team_profile_members (profile_id)
  where is_leader and status = 'ACTIVE';

alter table gac.defence_catalogue_values
  add column status gac.profile_status not null default 'ACTIVE',
  add column retired_at timestamptz,
  add column retired_reason text,
  add constraint defence_catalogue_values_retirement_state check (
    (status = 'ACTIVE' and retired_at is null and retired_reason is null)
    or (status = 'RETIRED' and retired_at is not null and coalesce(btrim(retired_reason), '') <> '')
  );

reset role;
commit;
