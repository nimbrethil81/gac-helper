"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MIGRATION_DIRECTORY = path.resolve("supabase/migrations");
const ROLLBACK_DIRECTORY = path.resolve("supabase/rollbacks");

function sqlFiles(directory, suffix = ".sql") {
  return fs.readdirSync(directory)
    .filter((filename) => filename.endsWith(suffix))
    .sort()
    .map((filename) => ({
      filename,
      sql: fs.readFileSync(path.join(directory, filename), "utf8")
    }));
}

async function createDatabase() {
  const { PGlite } = await import("@electric-sql/pglite");
  const database = new PGlite();
  await database.exec("create role anon nologin; create role authenticated nologin;");
  return database;
}

async function applyMigrations(database, history = false) {
  if (history) {
    await database.exec(`
      create table if not exists public.arch105_migration_history (
        filename text primary key,
        applied_at timestamptz not null default statement_timestamp()
      )
    `);
  }

  for (const migration of sqlFiles(MIGRATION_DIRECTORY)) {
    if (history) {
      const applied = await database.query(
        "select 1 from public.arch105_migration_history where filename = $1",
        [migration.filename]
      );
      if (applied.rows.length > 0) continue;
    }
    await database.exec(migration.sql);
    if (history) {
      await database.query(
        "insert into public.arch105_migration_history (filename) values ($1)",
        [migration.filename]
      );
    }
  }
}

async function rollbackMigrations(database) {
  for (const rollback of sqlFiles(ROLLBACK_DIRECTORY, ".down.sql").reverse()) {
    await database.exec(rollback.sql);
  }
}

async function withDatabase(run) {
  const database = await createDatabase();
  try {
    await run(database);
  } finally {
    await database.close();
  }
}

async function rejectsSql(database, sql, pattern) {
  await assert.rejects(database.exec(sql), pattern);
}

test("ARCH-105 migrations create the complete private schema and only Stage-1 roles", async () => {
  await withDatabase(async (database) => {
    await applyMigrations(database);

    const tables = await database.query(`
      select table_name
      from information_schema.tables
      where table_schema = 'gac'
      order by table_name
    `);
    assert.deepEqual(tables.rows.map(({ table_name }) => table_name), [
      "authoring_changes",
      "catalogue_release_authoring_changes",
      "catalogue_release_provenance",
      "catalogue_releases",
      "catalogue_state",
      "defence_assessments",
      "defence_catalogue_values",
      "evidence_mappings",
      "evidence_observations",
      "evidence_sources",
      "gac_board_config",
      "gac_scoring_rules",
      "maintenance_findings",
      "maintenance_runs",
      "matchup_assessments",
      "matchup_catalogue_values",
      "matchups",
      "team_archetypes",
      "team_profile_members",
      "team_profiles",
      "units"
    ]);

    const roles = await database.query(`
      select rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
      from pg_roles
      where rolname like 'gac_%'
      order by rolname
    `);
    assert.deepEqual(roles.rows.map(({ rolname }) => rolname), [
      "gac_authoring",
      "gac_migration_admin",
      "gac_publisher"
    ]);
    for (const role of roles.rows) {
      assert.equal(role.rolcanlogin, false);
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreaterole, false);
      assert.equal(role.rolcreatedb, false);
      assert.equal(role.rolreplication, false);
      assert.equal(role.rolbypassrls, false);
    }

    const forbiddenRoles = await database.query(`
      select rolname from pg_roles
      where rolname in (
        'gac_backup_export',
        'gac_evidence_ingester',
        'gac_maintenance_analyst',
        'gac_deterministic_applier'
      )
    `);
    assert.equal(forbiddenRoles.rows.length, 0);

    const rls = await database.query(`
      select count(*)::int as count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'gac' and c.relkind = 'r' and c.relrowsecurity
    `);
    assert.equal(rls.rows[0].count, 21);

    const securityDefinerFunctions = await database.query(`
      select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'gac' and p.prosecdef
    `);
    assert.equal(securityDefinerFunctions.rows.length, 0);

    const unindexedForeignKeys = await database.query(`
      select conrelid::regclass::text as table_name, attribute.attname as column_name
      from pg_constraint constraint_record
      join pg_attribute attribute
        on attribute.attrelid = constraint_record.conrelid
       and attribute.attnum = any(constraint_record.conkey)
      where constraint_record.contype = 'f'
        and constraint_record.connamespace = 'gac'::regnamespace
        and not exists (
          select 1
          from pg_index index_record
          where index_record.indrelid = constraint_record.conrelid
            and attribute.attnum = any(index_record.indkey)
        )
    `);
    assert.deepEqual(unindexedForeignKeys.rows, []);
  });
});

test("authoring and publisher permissions enforce their Stage-1 boundaries", async () => {
  await withDatabase(async (database) => {
    await applyMigrations(database);

    await database.exec("set role gac_authoring");
    await database.exec(`
      insert into gac.units (unit_id, display_name, external_id, unit_type)
      values ('UNIT_A', 'Unit A', 'UNITA', 'CHARACTER');
      insert into gac.team_archetypes (
        archetype_code, display_name, battle_type, identity_reason, created_by
      ) values
        ('DEFENCE_A', 'Defence A', 'SQUAD', 'LEGACY_MIGRATION', 'HUMAN'),
        ('COUNTER_A', 'Counter A', 'SQUAD', 'LEGACY_MIGRATION', 'HUMAN');
      insert into gac.authoring_changes (
        change_id, author, authored_at, entity_type, operation, structured_values, authority, reason
      ) values (
        'ARCH-105-TEST', 'schema-test', statement_timestamp(), 'UNIT', 'CREATE', '{}',
        'AUTHORED_BASELINE', 'permission rehearsal'
      );
    `);
    await rejectsSql(
      database,
      "insert into gac.evidence_sources (source_code, name, priority, terms_checked_at, retrieval_contract_version) values ('SOURCE', 'Source', 1, current_date, '1')",
      /permission denied|row-level security/
    );
    await rejectsSql(
      database,
      "update gac.catalogue_state set publication_generation = 1",
      /permission denied|row-level security/
    );

    await database.exec("reset role; set role gac_publisher");
    await rejectsSql(
      database,
      "update gac.units set display_name = 'Changed' where unit_id = 'UNIT_A'",
      /permission denied|row-level security/
    );
    await database.exec(`
      insert into gac.catalogue_releases (
        version, payload_schema_version, release_reason, scope, payload, checksum, source_commit_sha
      ) values (
        1, 1, 'MIGRATION', '{}', '{}',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      );
      update gac.catalogue_releases set status = 'READY' where version = 1;
      update gac.catalogue_releases
      set status = 'DEPLOYED',
          deployed_commit_sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          cloudflare_deployment_id = 'deployment-1',
          published_at = statement_timestamp()
      where version = 1;
      update gac.catalogue_state
      set current_release_id = (select release_id from gac.catalogue_releases where version = 1),
          publication_generation = publication_generation + 1;
    `);
    const state = await database.query("select publication_generation from gac.catalogue_state");
    assert.equal(state.rows[0].publication_generation, 1);

    await database.exec("reset role; set role anon");
    await rejectsSql(database, "select * from gac.units", /permission denied/);
    await database.exec("reset role; set role authenticated");
    await rejectsSql(database, "select * from gac.units", /permission denied/);
    await database.exec("reset role");
  });
});

test("schema constraints protect stable identity, uniqueness and lifecycle transitions", async () => {
  await withDatabase(async (database) => {
    await applyMigrations(database);
    await database.exec("set role gac_authoring");
    await database.exec(`
      insert into gac.units (unit_id, display_name, external_id, unit_type)
      values ('UNIT_A', 'Unit A', 'UNITA', 'CHARACTER');
      insert into gac.team_archetypes (
        archetype_code, display_name, battle_type, identity_reason, created_by
      ) values
        ('DEFENCE_A', 'Defence A', 'SQUAD', 'LEGACY_MIGRATION', 'HUMAN'),
        ('COUNTER_A', 'Counter A', 'SQUAD', 'LEGACY_MIGRATION', 'HUMAN');
    `);
    await rejectsSql(
      database,
      "update gac.units set unit_id = 'UNIT_B' where unit_id = 'UNIT_A'",
      /unit_id is immutable/
    );
    await rejectsSql(
      database,
      "insert into gac.team_archetypes (archetype_code, display_name, battle_type, identity_reason, created_by) values ('DEFENCE_A', 'Duplicate', 'SQUAD', 'LEGACY_MIGRATION', 'HUMAN')",
      /duplicate key|unique constraint/
    );
    await rejectsSql(
      database,
      "insert into gac.team_profiles (archetype_id, mode, usage_role) select archetype_id, 'FLEET', 'DEFENCE' from gac.team_archetypes where archetype_code = 'DEFENCE_A'",
      /incompatible/
    );
    await database.exec("reset role; set role gac_publisher");
    await database.exec(`
      insert into gac.catalogue_releases (
        version, payload_schema_version, release_reason, payload, checksum, source_commit_sha
      ) values (
        1, 1, 'MIGRATION', '{}',
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'cccccccccccccccccccccccccccccccccccccccc'
      )
    `);
    await rejectsSql(
      database,
      `update gac.catalogue_releases
       set status = 'DEPLOYED',
           deployed_commit_sha = 'dddddddddddddddddddddddddddddddddddddddd',
           cloudflare_deployment_id = 'deployment-2',
           published_at = statement_timestamp()
       where version = 1`,
      /invalid release transition/
    );
    await rejectsSql(
      database,
      "update gac.catalogue_state set current_release_id = (select release_id from gac.catalogue_releases where version = 1)",
      /current release must be DEPLOYED/
    );
    await database.exec("reset role");
  });
});

test("ordered migrations are idempotent through history and roll back cleanly", async () => {
  await withDatabase(async (database) => {
    await applyMigrations(database, true);
    await applyMigrations(database, true);
    const history = await database.query("select count(*)::int as count from public.arch105_migration_history");
    assert.equal(history.rows[0].count, 2);

    await rollbackMigrations(database);
    const removed = await database.query(`
      select
        exists(select 1 from pg_namespace where nspname = 'gac') as schema_exists,
        exists(select 1 from pg_roles where rolname = 'gac_migration_admin') as migration_role_exists,
        exists(select 1 from pg_roles where rolname = 'gac_authoring') as authoring_role_exists,
        exists(select 1 from pg_roles where rolname = 'gac_publisher') as publisher_role_exists
    `);
    assert.deepEqual(removed.rows[0], {
      schema_exists: false,
      migration_role_exists: false,
      authoring_role_exists: false,
      publisher_role_exists: false
    });

    await database.exec("delete from public.arch105_migration_history");
    await applyMigrations(database, true);
    const restored = await database.query("select count(*)::int as count from information_schema.tables where table_schema = 'gac'");
    assert.equal(restored.rows[0].count, 21);
  });
});
