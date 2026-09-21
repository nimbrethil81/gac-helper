-- Reverse of 20260921160000_arch_108_catalogue_value_lifecycle.sql.
--
-- This rollback is non-destructive. It refuses to erase retirement state;
-- reactivate affected rows through an authoring change before retrying.

begin;

set role gac_migration_admin;

do $$
declare
  retired_members integer;
  retired_defence_values integer;
begin
  select count(*) into retired_members
  from gac.team_profile_members
  where status = 'RETIRED';

  select count(*) into retired_defence_values
  from gac.defence_catalogue_values
  where status = 'RETIRED';

  if retired_members > 0 or retired_defence_values > 0 then
    raise exception
      'ARCH-108 lifecycle rollback refused: % retired profile member(s) and % retired defence value row(s) would lose lifecycle state. Reactivate them through reviewed authoring changes before rollback; this script will not delete or rewrite catalogue data.',
      retired_members, retired_defence_values;
  end if;
end
$$;

drop index gac.team_profile_members_one_active_leader_idx;
drop index gac.team_profile_members_active_sort_unique_idx;

alter table gac.team_profile_members
  drop constraint team_profile_members_retirement_state,
  drop column retired_reason,
  drop column retired_at,
  drop column status,
  add constraint team_profile_members_profile_sort_unique unique (profile_id, sort_order);

create unique index team_profile_members_one_leader_idx
  on gac.team_profile_members (profile_id) where is_leader;

alter table gac.defence_catalogue_values
  drop constraint defence_catalogue_values_retirement_state,
  drop column retired_reason,
  drop column retired_at,
  drop column status;

reset role;
commit;
