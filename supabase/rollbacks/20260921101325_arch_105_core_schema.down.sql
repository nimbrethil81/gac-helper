begin;

set role gac_migration_admin;
drop schema gac cascade;
reset role;

revoke gac_migration_admin from postgres;
do $$
begin
  execute format('revoke create on database %I from gac_migration_admin', current_database());
end
$$;
drop owned by gac_migration_admin;
drop role gac_migration_admin;

commit;
