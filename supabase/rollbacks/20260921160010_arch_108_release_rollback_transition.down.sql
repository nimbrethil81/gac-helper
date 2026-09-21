-- Reverse of 20260921160010_arch_108_release_rollback_transition.sql.
-- Refuse when more than one release is DEPLOYED: that is the short,
-- transaction-local state used while a rollback pointer is being moved.

begin;

set role gac_migration_admin;

do $$
begin
  if (select count(*) from gac.catalogue_releases where status = 'DEPLOYED') > 1 then
    raise exception 'ARCH-108 release-transition rollback refused while a catalogue rollback is incomplete';
  end if;
end
$$;

create or replace function gac.enforce_release_transition()
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

reset role;
commit;
