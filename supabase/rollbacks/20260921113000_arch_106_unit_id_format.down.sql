-- Reverse of 20260921113000_arch_106_unit_id_format.sql.
--
-- Restores the original ARCH-105 uppercase-only units_unit_id_format.
--
-- This rollback is non-destructive: it never renames and never deletes a unit.
-- If any stored unit_id relies on the widened form, it raises and rolls back so
-- the operator can decide, rather than silently discarding a public identifier.

begin;

set role gac_migration_admin;

do $$
declare
  offending_count integer;
  offending_ids text;
begin
  select count(*), coalesce(string_agg(unit_id, ', ' order by unit_id), '')
    into offending_count, offending_ids
  from gac.units
  where unit_id !~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$';

  if offending_count > 0 then
    raise exception
      'ARCH-106 unit_id rollback refused: % unit(s) rely on the widened format and would be invalidated: %. Resolve the identifiers deliberately before restoring the uppercase-only constraint; this script will not rename or delete a unit.',
      offending_count, offending_ids;
  end if;
end
$$;

alter table gac.units drop constraint units_unit_id_format;
alter table gac.units add constraint units_unit_id_format
  check (unit_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$');

reset role;
commit;
