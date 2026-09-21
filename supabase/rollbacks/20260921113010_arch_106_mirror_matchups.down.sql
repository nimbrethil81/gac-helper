-- Reverse of 20260921113010_arch_106_mirror_matchups.sql.
--
-- Restores the original ARCH-105 matchups_distinct_archetypes constraint.
--
-- This rollback is non-destructive: it never deletes a matchup. If any stored
-- matchup is a mirror, it raises and rolls back so the operator can decide,
-- rather than silently discarding authored catalogue rows.

begin;

set role gac_migration_admin;

do $$
declare
  offending_count integer;
  offending_rows text;
begin
  select count(*), coalesce(string_agg(format('%s | %s', matchup.mode, archetype.display_name), ', ' order by matchup.matchup_id), '')
    into offending_count, offending_rows
  from gac.matchups matchup
  join gac.team_archetypes archetype on archetype.archetype_id = matchup.defence_archetype_id
  where matchup.defence_archetype_id = matchup.counter_archetype_id;

  if offending_count > 0 then
    raise exception
      'ARCH-106 mirror-matchup rollback refused: % mirror matchup(s) exist and would be invalidated: %. Resolve them deliberately before restoring matchups_distinct_archetypes; this script will not delete a matchup.',
      offending_count, offending_rows;
  end if;
end
$$;

alter table gac.matchups add constraint matchups_distinct_archetypes
  check (defence_archetype_id <> counter_archetype_id);

reset role;
commit;
