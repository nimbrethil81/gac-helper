#!/usr/bin/env node
"use strict";

// ARCH-106 loader. Applies the deterministic migration plan to a database that
// already carries the ARCH-105 schema.
//
// The load runs in one transaction as gac_authoring, so it holds exactly the
// Stage-1 catalogue-authoring grants and cannot reach schema objects, roles,
// policies, evidence tables or the release lifecycle. Every statement is
// additionally checked against an allow-list of data verbs. Any failure, before
// or after the writes, rolls the whole transaction back.

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  DEFAULT_CAPTURE_ROOT,
  DEFAULT_DECISIONS_PATH,
  assertLoadable,
  buildPlan,
  readDecisions,
  readSources
} = require("./migration-lib.js");

const MIGRATION_DIRECTORY = path.join("supabase", "migrations");
const LOADER_ROLE = "gac_authoring";
const ALLOWED_VERBS = new Set(["begin", "commit", "rollback", "insert", "select", "set", "reset"]);
const INSERT_CHUNK_ROWS = 400;

// ─── statement guard ─────────────────────────────────────────────────────────

function assertDataStatement(sql) {
  const verb = sql.trim().split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_VERBS.has(verb)) {
    throw new Error(`ARCH-106 loader refuses a non-data statement: ${verb}`);
  }
  return sql;
}

async function run(database, sql, params) {
  return database.query(assertDataStatement(sql), params);
}

// ─── schema application (disposable databases and tests) ─────────────────────

function migrationFiles(directory = MIGRATION_DIRECTORY) {
  const resolved = path.resolve(directory);
  return fs.readdirSync(resolved)
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, sql: fs.readFileSync(path.join(resolved, filename), "utf8") }));
}

async function createDisposableDatabase() {
  const { PGlite } = await import("@electric-sql/pglite");
  const database = new PGlite();
  await database.exec("create role anon nologin; create role authenticated nologin;");
  return database;
}

async function applySchema(database, directory = MIGRATION_DIRECTORY) {
  for (const migration of migrationFiles(directory)) {
    await database.exec(migration.sql);
  }
}

// ─── insert helpers ──────────────────────────────────────────────────────────

async function insertRows(database, table, columns, rows) {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_ROWS);
    const params = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await run(
      database,
      `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`,
      params
    );
  }
}

// Insert only the rows a database does not already hold, and refuse to continue
// when an existing row disagrees with the plan. That gives idempotency without
// ever resolving a conflict by overwriting.
async function reconcileRows(database, { table, keyColumns, columns, rows, describe }) {
  const existing = await run(database, `select ${[...keyColumns, ...columns].join(", ")} from ${table}`);
  const existingByKey = new Map(
    existing.rows.map((row) => [keyColumns.map((column) => String(row[column])).join("\u0000"), row])
  );

  const missing = [];
  let matched = 0;
  for (const row of rows) {
    const key = keyColumns.map((column) => String(row[column])).join("\u0000");
    const current = existingByKey.get(key);
    if (current === undefined) {
      missing.push(row);
      continue;
    }
    for (const column of columns) {
      const before = current[column];
      const after = row[column];
      const equal = before === null || after === null
        ? before === after
        : String(before) === String(after);
      if (!equal) {
        throw new Error(
          `${table} already holds a different ${column} for ${describe(row)}: ${JSON.stringify(before)} vs planned ${JSON.stringify(after)}`
        );
      }
    }
    matched += 1;
  }

  if (missing.length > 0) {
    await insertRows(database, table, [...keyColumns, ...columns], missing);
  }
  return { inserted: missing.length, matched };
}

// ─── load ────────────────────────────────────────────────────────────────────

async function loadPlan(database, plan, reconciliation) {
  assertLoadable(reconciliation);

  const applied = {};
  await database.exec("begin");
  try {
    // Least privilege for the whole transaction: the catalogue-authoring role
    // has no DDL, no permission grants and no release-lifecycle access.
    await run(database, `set local role ${LOADER_ROLE}`);

    applied.units = await reconcileRows(database, {
      table: "gac.units",
      keyColumns: ["unit_id"],
      columns: ["display_name", "external_id", "unit_type"],
      rows: plan.units,
      describe: (row) => row.unit_id
    });

    applied.team_archetypes = await reconcileRows(database, {
      table: "gac.team_archetypes",
      keyColumns: ["archetype_code"],
      columns: ["display_name", "battle_type", "identity_reason", "identity_reason_detail", "created_by"],
      rows: plan.archetypes,
      describe: (row) => row.archetype_code
    });

    const archetypeIds = new Map(
      (await run(database, "select archetype_id, archetype_code from gac.team_archetypes")).rows
        .map((row) => [row.archetype_code, row.archetype_id])
    );

    applied.team_profiles = await reconcileRows(database, {
      table: "gac.team_profiles",
      keyColumns: ["archetype_id", "mode", "usage_role"],
      columns: ["flex_slots", "members_complete"],
      rows: plan.profiles.map((profile) => ({
        archetype_id: archetypeIds.get(profile.archetype_code),
        mode: profile.mode,
        usage_role: profile.usage_role,
        flex_slots: profile.flex_slots,
        members_complete: profile.members_complete
      })),
      describe: (row) => `archetype ${row.archetype_id} / ${row.mode} / ${row.usage_role}`
    });

    const profileIds = new Map(
      (await run(database, "select profile_id, archetype_id, mode, usage_role from gac.team_profiles")).rows
        .map((row) => [`${row.archetype_id}\u0000${row.mode}\u0000${row.usage_role}`, row.profile_id])
    );

    const memberRows = plan.profiles.flatMap((profile) => {
      const archetypeId = archetypeIds.get(profile.archetype_code);
      const profileId = profileIds.get(`${archetypeId}\u0000${profile.mode}\u0000${profile.usage_role}`);
      return profile.members.map((member) => ({
        profile_id: profileId,
        unit_id: member.unit_id,
        member_role: member.member_role,
        is_leader: member.is_leader,
        sort_order: member.sort_order
      }));
    });
    applied.team_profile_members = await reconcileRows(database, {
      table: "gac.team_profile_members",
      keyColumns: ["profile_id", "unit_id"],
      columns: ["member_role", "is_leader", "sort_order"],
      rows: memberRows,
      describe: (row) => `profile ${row.profile_id} / ${row.unit_id}`
    });

    applied.matchups = await reconcileRows(database, {
      table: "gac.matchups",
      keyColumns: ["mode", "defence_archetype_id", "counter_archetype_id"],
      columns: ["status"],
      rows: plan.matchups.map((matchup) => ({
        mode: matchup.mode,
        defence_archetype_id: archetypeIds.get(matchup.defence_archetype_code),
        counter_archetype_id: archetypeIds.get(matchup.counter_archetype_code),
        status: "ACTIVE"
      })),
      describe: (row) => `${row.mode} / ${row.defence_archetype_id} / ${row.counter_archetype_id}`
    });

    const matchupIds = new Map(
      (await run(database, "select matchup_id, mode, defence_archetype_id, counter_archetype_id from gac.matchups")).rows
        .map((row) => [`${row.mode}\u0000${row.defence_archetype_id}\u0000${row.counter_archetype_id}`, row.matchup_id])
    );

    applied.matchup_catalogue_values = await reconcileRows(database, {
      table: "gac.matchup_catalogue_values",
      keyColumns: ["matchup_id"],
      columns: ["tier", "banner_score", "undersize", "notes", "tier_authority", "banner_authority", "undersize_authority"],
      rows: plan.matchups.map((matchup) => ({
        matchup_id: matchupIds.get([
          matchup.mode,
          archetypeIds.get(matchup.defence_archetype_code),
          archetypeIds.get(matchup.counter_archetype_code)
        ].join("\u0000")),
        tier: matchup.tier,
        banner_score: matchup.banner_score,
        undersize: matchup.undersize,
        notes: matchup.notes,
        // The source carries no lock evidence, so nothing migrates as
        // AUTHORED_LOCKED.
        tier_authority: "AUTHORED_BASELINE",
        banner_authority: "AUTHORED_BASELINE",
        undersize_authority: "AUTHORED_BASELINE"
      })),
      describe: (row) => `matchup ${row.matchup_id}`
    });

    applied.defence_catalogue_values = await reconcileRows(database, {
      table: "gac.defence_catalogue_values",
      keyColumns: ["archetype_id", "mode"],
      columns: ["threat", "notes", "threat_authority"],
      rows: plan.defenceValues.map((value) => ({
        archetype_id: archetypeIds.get(value.archetype_code),
        mode: value.mode,
        threat: value.threat,
        notes: value.notes,
        threat_authority: "AUTHORED_BASELINE"
      })),
      describe: (row) => `archetype ${row.archetype_id} / ${row.mode}`
    });

    applied.gac_board_config = await reconcileRows(database, {
      table: "gac.gac_board_config",
      keyColumns: ["league", "mode", "territory"],
      columns: ["territory_type", "team_count", "display_order"],
      rows: plan.boardConfig.map((row) => ({
        league: row.league,
        mode: row.mode,
        territory: row.territory,
        territory_type: row.territory_type,
        team_count: row.team_count,
        display_order: row.display_order
      })),
      describe: (row) => `${row.league} / ${row.mode} / ${row.territory}`
    });

    applied.gac_scoring_rules = await reconcileRows(database, {
      table: "gac.gac_scoring_rules",
      keyColumns: ["rule_id", "battle_type", "mode"],
      columns: ["value", "notes"],
      rows: plan.scoringRules.map((rule) => ({
        rule_id: rule.rule_id,
        battle_type: rule.battle_type,
        mode: rule.mode,
        value: rule.value,
        notes: rule.notes
      })),
      describe: (row) => `${row.rule_id} / ${row.battle_type} / ${row.mode}`
    });

    // The legacy-migration authoring record. authored_at is pinned to the
    // ARCH-103 capture timestamp so two fresh databases agree. ARCH-106 writes
    // no gac.catalogue_releases row: a release carries a generated public
    // payload and a publication lifecycle, and both belong to ARCH-108.
    applied.authoring_changes = await reconcileAuthoringChange(database, plan.authoringChange);

    const invariants = await verifyInvariants(database, plan);
    await database.exec("commit");
    return { applied, invariants };
  } catch (error) {
    await database.exec("rollback");
    throw error;
  }
}

// The authoring record carries columns reconcileRows does not model (a pinned
// timestamp pair and a JSON body), so it gets its own idempotent insert.
async function reconcileAuthoringChange(database, change) {
  const existing = await run(
    database,
    "select change_id, author, entity_type, operation, authority, reason, status from gac.authoring_changes where change_id = $1",
    [change.change_id]
  );
  if (existing.rows.length > 0) {
    const stored = existing.rows[0];
    for (const column of ["author", "entity_type", "operation", "authority", "reason", "status"]) {
      if (stored[column] !== change[column]) {
        throw new Error(
          `gac.authoring_changes already holds a different ${column} for ${change.change_id}: ${JSON.stringify(stored[column])} vs planned ${JSON.stringify(change[column])}`
        );
      }
    }
    return { inserted: 0, matched: 1 };
  }

  await run(
    database,
    `insert into gac.authoring_changes (
       change_id, author, authored_at, entity_type, operation,
       structured_values, authority, reason, status, applied_at
     ) values ($1, $2, $3::timestamptz, $4, $5, $6::jsonb, $7, $8, $9, $3::timestamptz)`,
    [
      change.change_id,
      change.author,
      change.authored_at,
      change.entity_type,
      change.operation,
      JSON.stringify(change.structured_values),
      change.authority,
      change.reason,
      change.status
    ]
  );
  return { inserted: 1, matched: 0 };
}

// ─── post-load invariants, checked before the commit ─────────────────────────

async function countOf(database, table) {
  const result = await run(database, `select count(*)::int as total from ${table}`);
  return result.rows[0].total;
}

async function verifyInvariants(database, plan) {
  const expected = {
    "gac.units": plan.units.length,
    "gac.team_archetypes": plan.archetypes.length,
    "gac.team_profiles": plan.profiles.length,
    "gac.team_profile_members": plan.profiles.reduce((total, profile) => total + profile.members.length, 0),
    "gac.matchups": plan.matchups.length,
    "gac.matchup_catalogue_values": plan.matchups.length,
    "gac.defence_catalogue_values": plan.defenceValues.length,
    "gac.gac_board_config": plan.boardConfig.length,
    "gac.gac_scoring_rules": plan.scoringRules.length,
    "gac.authoring_changes": 1
  };
  const actual = {};
  for (const table of Object.keys(expected)) actual[table] = await countOf(database, table);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Post-load row counts differ: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  const storedUnits = (await run(database, "select unit_id, display_name, external_id from gac.units")).rows;
  const storedUnitById = new Map(storedUnits.map((row) => [row.unit_id, row]));
  for (const unit of plan.units) {
    const stored = storedUnitById.get(unit.unit_id);
    if (!stored) throw new Error(`Unit ${unit.unit_id} did not survive the load`);
    if (stored.display_name !== unit.display_name) {
      throw new Error(`Unit ${unit.unit_id} display name changed during load`);
    }
    if ((stored.external_id ?? null) !== unit.external_id) {
      throw new Error(`Unit ${unit.unit_id} external_id changed during load`);
    }
  }

  const storedArchetypes = (await run(database, "select archetype_code, display_name from gac.team_archetypes")).rows;
  const storedArchetypeByCode = new Map(storedArchetypes.map((row) => [row.archetype_code, row]));
  for (const archetype of plan.archetypes) {
    const stored = storedArchetypeByCode.get(archetype.archetype_code);
    if (!stored) throw new Error(`Archetype ${archetype.archetype_code} did not survive the load`);
    if (stored.display_name !== archetype.display_name) {
      throw new Error(`Archetype ${archetype.archetype_code} display name changed during load`);
    }
  }

  const storedNotes = (await run(database, "select notes from gac.matchup_catalogue_values where notes <> ''")).rows.length;
  const plannedNotes = plan.matchups.filter((matchup) => matchup.notes !== "").length;
  if (storedNotes !== plannedNotes) {
    throw new Error(`Matchup notes differ after load: expected ${plannedNotes} non-blank, got ${storedNotes}`);
  }

  const orphanRequired = await run(database, `
    select count(*)::int as total
    from gac.team_profile_members member
    join gac.units unit on unit.unit_id = member.unit_id
    where member.member_role = 'REQUIRED' and coalesce(unit.external_id, '') = ''
  `);
  if (orphanRequired.rows[0].total !== 0) {
    throw new Error(`${orphanRequired.rows[0].total} required members have no external_id`);
  }

  return { rowCounts: actual };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { capture: DEFAULT_CAPTURE_ROOT, decisions: DEFAULT_DECISIONS_PATH, twice: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capture") options.capture = argv[++index];
    else if (arg === "--decisions") options.decisions = argv[++index];
    else if (arg === "--twice") options.twice = true;
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = readSources(options.capture);
  const decisions = readDecisions(options.decisions);
  const { plan, reconciliation } = buildPlan(sources, decisions);
  assertLoadable(reconciliation);

  const database = await createDisposableDatabase();
  try {
    await applySchema(database);
    const first = await loadPlan(database, plan, reconciliation);
    console.log("ARCH-106 load: committed");
    console.log(`  Row counts: ${JSON.stringify(first.invariants.rowCounts)}`);
    console.log(`  Inserted: ${JSON.stringify(Object.fromEntries(Object.entries(first.applied).map(([table, result]) => [table, result.inserted])))}`);

    if (options.twice) {
      const second = await loadPlan(database, plan, reconciliation);
      const inserted = Object.values(second.applied).reduce((total, result) => total + result.inserted, 0);
      console.log("ARCH-106 second load: committed");
      console.log(`  Rows inserted on the second load: ${inserted}`);
      console.log(`  Row counts: ${JSON.stringify(second.invariants.rowCounts)}`);
      if (inserted !== 0) throw new Error("Second load was not a no-op");
      if (!isDeepStrictEqual(second.invariants.rowCounts, first.invariants.rowCounts)) {
        throw new Error("Second load changed row counts");
      }
      console.log("  Idempotency: confirmed");
    }
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ARCH-106 load failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LOADER_ROLE,
  applySchema,
  assertDataStatement,
  createDisposableDatabase,
  loadPlan,
  migrationFiles
};
