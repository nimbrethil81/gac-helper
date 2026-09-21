"use strict";

// ARCH-106 migration loader tests.
//
// They run against disposable WebAssembly PostgreSQL through the same PGlite
// dependency as the ARCH-105 schema tests. No Docker, hosted database, network
// service or credential is involved, and the committed ARCH-103 fixture is only
// ever read.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");

const { canonicalJson, parseCsv } = require("../scripts/baseline-lib.js");
const { verifyBaseline } = require("../scripts/verify-baseline.js");
const {
  DEFAULT_CAPTURE_ROOT,
  DEFAULT_DECISIONS_PATH,
  allocateDefenceOnlyCode,
  assertLoadable,
  buildPlan,
  readDecisions,
  readSources
} = require("../scripts/migration-lib.js");
const {
  applySchema,
  assertDataStatement,
  createDisposableDatabase,
  loadPlan
} = require("../scripts/migration-load.js");
const { renderMarkdown } = require("../scripts/migration-reconcile.js");
const { applyExpectedDeltas, projectPayload, sortScoring, verifyProjection } = require("../scripts/migration-verify.js");
const { baseSheets, writeFixture } = require("./migration-fixture.js");

// The committed decision file deliberately leaves three conditions BLOCKED.
// These are the candidate resolutions that load against the ARCH-105 schema
// exactly as it is committed today. They are test inputs, not owner decisions.
const CANDIDATE_RESOLUTIONS = {
  DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA: "COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE",
  UNIT_ID_FORMAT_TIE_ADVANCED_X1: "RENAME_UNIT_ID_TO_UPPERCASE",
  MIRROR_MATCHUP_SELF_REFERENCE: "SPLIT_DEFENCE_IDENTITY_FOR_MIRRORS"
};

function withCandidateResolutions(overrides = CANDIDATE_RESOLUTIONS) {
  const decisions = readDecisions();
  for (const anomaly of decisions.anomalies) {
    if (overrides[anomaly.id]) {
      anomaly.status = "RESOLVED";
      anomaly.resolution = overrides[anomaly.id];
    }
  }
  return decisions;
}

function sourceRows(filename) {
  const rows = parseCsv(fs.readFileSync(path.join(DEFAULT_CAPTURE_ROOT, "sheets", filename), "utf8"));
  const headers = rows[0];
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

async function withDatabase(run) {
  const database = await createDisposableDatabase();
  try {
    await applySchema(database);
    return await run(database);
  } finally {
    await database.close();
  }
}

// Everything that must be identical between two independent databases: business
// identities and their relationships, never generated surrogate keys.
async function semanticSnapshot(database) {
  const query = async (sql) => (await database.query(sql)).rows;
  return {
    units: await query("select unit_id, display_name, external_id, unit_type from gac.units order by unit_id"),
    archetypes: await query(`
      select archetype_code, display_name, battle_type, identity_reason, identity_reason_detail, created_by, status
      from gac.team_archetypes order by archetype_code
    `),
    profiles: await query(`
      select archetype.archetype_code, profile.mode, profile.usage_role, profile.flex_slots, profile.members_complete
      from gac.team_profiles profile
      join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
      order by archetype.archetype_code, profile.usage_role, profile.mode
    `),
    members: await query(`
      select archetype.archetype_code, profile.usage_role, profile.mode, member.unit_id, member.member_role,
             member.is_leader, member.sort_order
      from gac.team_profile_members member
      join gac.team_profiles profile on profile.profile_id = member.profile_id
      join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
      order by archetype.archetype_code, profile.usage_role, profile.mode, member.sort_order
    `),
    matchups: await query(`
      select matchup.mode, defence.archetype_code as defence_code, counter.archetype_code as counter_code,
             matchup.status, value.tier, value.banner_score, value.undersize, value.notes,
             value.tier_authority, value.banner_authority, value.undersize_authority
      from gac.matchups matchup
      join gac.team_archetypes defence on defence.archetype_id = matchup.defence_archetype_id
      join gac.team_archetypes counter on counter.archetype_id = matchup.counter_archetype_id
      join gac.matchup_catalogue_values value on value.matchup_id = matchup.matchup_id
      order by matchup.mode, defence.archetype_code, counter.archetype_code
    `),
    defenceValues: await query(`
      select archetype.archetype_code, value.mode, value.threat, value.notes, value.threat_authority
      from gac.defence_catalogue_values value
      join gac.team_archetypes archetype on archetype.archetype_id = value.archetype_id
      order by archetype.archetype_code, value.mode
    `),
    board: await query("select league, mode, territory, territory_type, team_count, display_order from gac.gac_board_config order by league, mode, display_order"),
    scoring: await query("select rule_id, battle_type, mode, value, notes from gac.gac_scoring_rules order by rule_id, battle_type, mode"),
    authoring: await query("select change_id, author, authored_at, entity_type, operation, authority, reason, status, applied_at from gac.authoring_changes order by change_id")
  };
}

async function schemaSnapshot(database) {
  const query = async (sql) => (await database.query(sql)).rows;
  return {
    tables: await query("select table_name from information_schema.tables where table_schema = 'gac' order by table_name"),
    columns: await query("select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'gac' order by table_name, column_name"),
    constraints: await query("select conname from pg_constraint where connamespace = 'gac'::regnamespace order by conname"),
    policies: await query("select tablename, policyname, cmd from pg_policies where schemaname = 'gac' order by tablename, policyname"),
    functions: await query("select proname, prosecdef from pg_proc where pronamespace = 'gac'::regnamespace order by proname"),
    grants: await query("select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'gac' order by grantee, table_name, privilege_type"),
    roles: await query("select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'gac%' order by rolname")
  };
}

// ─── the committed baseline and decision file ────────────────────────────────

test("the committed ARCH-103 fixture is unchanged and verifies", () => {
  const summary = verifyBaseline(DEFAULT_CAPTURE_ROOT);
  assert.equal(summary.rawByteSize, 77553);
  assert.equal(summary.rawSha256, "342e3e4bf095cb7ae25011682f81b17da2b8470b445e046db5f541d5bc0cc4a3");
  assert.equal(summary.captureTimestamp, "2026-09-21T08:59:37Z");

  const manifestText = fs.readFileSync(path.join(DEFAULT_CAPTURE_ROOT, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.appsScriptPayload.canonicalSha256, "9a7fd5e371f2abcaf964e3f844371cdb98a44cb1b9c9a59f17cd4bc108f80cf3");
  for (const sheet of manifest.sheetExports) {
    const bytes = fs.readFileSync(path.join(DEFAULT_CAPTURE_ROOT, sheet.filename));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), sheet.sha256, sheet.filename);
  }
});

test("unexpected fixture corruption is rejected by the baseline verifier", () => {
  const root = writeFixture(baseSheets());
  try {
    const countersPath = path.join(root, "sheets", "Counters.csv");
    fs.writeFileSync(countersPath, `${fs.readFileSync(countersPath, "utf8")}3v3,Injected,ALPHA,Alpha,S,54,,0,\n`);
    assert.throws(() => readSources(root), /Byte size differs|SHA-256 differs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the committed decision file is canonical and leaves exactly the reported blockers open", () => {
  const text = fs.readFileSync(DEFAULT_DECISIONS_PATH, "utf8");
  const decisions = JSON.parse(text);
  assert.equal(canonicalJson(decisions), text, "decision file must stay deterministically canonicalized");
  assert.equal(decisions.package, "ARCH-106");

  const blocked = decisions.anomalies.filter((anomaly) => anomaly.status === "BLOCKED").map((anomaly) => anomaly.id).sort();
  assert.deepEqual(blocked, [
    "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA",
    "MIRROR_MATCHUP_SELF_REFERENCE",
    "UNIT_ID_FORMAT_TIE_ADVANCED_X1"
  ]);
  for (const anomaly of decisions.anomalies) {
    if (anomaly.status === "BLOCKED") {
      assert.equal(anomaly.resolution, null, `${anomaly.id} must not pre-empt the owner decision`);
      assert.ok(Array.isArray(anomaly.candidates) && anomaly.candidates.length > 0, `${anomaly.id} must list candidates`);
    } else {
      assert.equal(anomaly.status, "RESOLVED");
      assert.ok(anomaly.resolution, `${anomaly.id} must name a resolution`);
    }
  }
});

test("the committed decisions refuse to load and report every blocker precisely", () => {
  const { reconciliation } = buildPlan(readSources(), readDecisions());
  assert.equal(reconciliation.status, "BLOCKED");
  const byAnomaly = {};
  for (const blocker of reconciliation.blockers) {
    byAnomaly[blocker.anomalyId] = (byAnomaly[blocker.anomalyId] ?? 0) + 1;
  }
  assert.deepEqual(byAnomaly, {
    UNIT_ID_FORMAT_TIE_ADVANCED_X1: 1,
    MIRROR_MATCHUP_SELF_REFERENCE: 3,
    DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA: 1
  });
  assert.throws(() => assertLoadable(reconciliation), /unresolved blocker/);
  // No note is ever lost silently, even while the load is blocked.
  assert.equal(reconciliation.notePreservation.notesDroppedSilently, 0);
});

test("the committed reconciliation reports match a fresh generation", () => {
  const { reconciliation } = buildPlan(readSources(), readDecisions());
  assert.equal(
    fs.readFileSync(path.join("data", "migration", "arch-106-reconciliation.json"), "utf8"),
    canonicalJson(reconciliation),
    "regenerate the reports with npm run migrate:reconcile"
  );
  assert.equal(
    fs.readFileSync(path.join("data", "migration", "arch-106-reconciliation.md"), "utf8"),
    renderMarkdown(reconciliation),
    "regenerate the reports with npm run migrate:reconcile"
  );
});

// ─── loading the real baseline under explicit resolutions ────────────────────

test("a fresh ARCH-105 schema accepts the ARCH-106 load and reconciles to source", async () => {
  const sources = readSources();
  const { plan, reconciliation } = buildPlan(sources, withCandidateResolutions());
  assert.equal(reconciliation.status, "READY");

  await withDatabase(async (database) => {
    const result = await loadPlan(database, plan, reconciliation);
    assert.deepEqual(result.invariants.rowCounts, {
      "gac.units": 312,
      "gac.team_archetypes": 93,
      "gac.team_profiles": 169,
      "gac.team_profile_members": 70,
      "gac.matchups": 365,
      "gac.matchup_catalogue_values": 365,
      "gac.defence_catalogue_values": 9,
      "gac.gac_board_config": 40,
      "gac.gac_scoring_rules": 16,
      "gac.authoring_changes": 1
    });

    // Source and canonical counts reconcile, with the one collapsed duplicate
    // the only difference between 366 Counters rows and 365 matchups.
    assert.equal(sources.characterDefinitions.length, 312);
    assert.equal(sources.counterComposition.length, 70);
    assert.equal(sources.boardConfig.length, 40);
    assert.equal(sources.scoring.length, 16);
    assert.equal(sources.defenceTeams.length, 9);
    assert.equal(sources.counters.length, 366);
    assert.equal(reconciliation.mappings.manyToOne.length, 1);
    assert.equal(reconciliation.mappings.manyToOne[0].sourceRows.length, 2);
  });
});

test("a second identical load changes nothing", async () => {
  const { plan, reconciliation } = buildPlan(readSources(), withCandidateResolutions());
  await withDatabase(async (database) => {
    const first = await loadPlan(database, plan, reconciliation);
    const beforeIds = (await database.query("select archetype_id, archetype_code from gac.team_archetypes order by archetype_code")).rows;
    const beforeUpdated = (await database.query("select max(updated_at) as latest from gac.units")).rows[0].latest;

    const second = await loadPlan(database, plan, reconciliation);
    assert.equal(Object.values(second.applied).reduce((total, entry) => total + entry.inserted, 0), 0);
    assert.deepEqual(second.invariants.rowCounts, first.invariants.rowCounts);

    const afterIds = (await database.query("select archetype_id, archetype_code from gac.team_archetypes order by archetype_code")).rows;
    assert.deepEqual(afterIds, beforeIds, "surrogate keys must not move on a repeat load");
    const afterUpdated = (await database.query("select max(updated_at) as latest from gac.units")).rows[0].latest;
    assert.deepEqual(afterUpdated, beforeUpdated, "a repeat load must not touch any row");

    const changes = await database.query("select count(*)::int as total from gac.authoring_changes");
    assert.equal(changes.rows[0].total, 1, "provenance must not duplicate");
  });
});

test("two fresh databases produce the same logical identities and the same payload", async () => {
  const sources = readSources();
  const decisions = withCandidateResolutions();
  const { plan, reconciliation } = buildPlan(sources, decisions);

  const results = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    results.push(await withDatabase(async (database) => {
      await loadPlan(database, plan, reconciliation);
      const snapshot = await semanticSnapshot(database);
      // authored_at is pinned; created_at/updated_at are audit-only and excluded.
      return { snapshot, payload: await projectPayload(database, decisions) };
    }));
  }

  assert.deepEqual(results[0].snapshot, results[1].snapshot);
  assert.equal(canonicalJson(results[0].payload), canonicalJson(results[1].payload));
});

// ─── identity, name, note, order and coverage preservation ───────────────────

test("every source identifier, display name, note, board order and scoring value survives", async () => {
  const sources = readSources();
  const decisions = withCandidateResolutions();
  const { plan, reconciliation } = buildPlan(sources, decisions);

  await withDatabase(async (database) => {
    await loadPlan(database, plan, reconciliation);

    // Every Character_ID is retained, with the single documented rename the
    // only difference and nothing dropped.
    const units = (await database.query("select unit_id from gac.units")).rows.map((row) => row.unit_id);
    const renames = new Map(reconciliation.unitIdRenames.map((entry) => [entry.from, entry.to]));
    assert.equal(renames.size, 1);
    for (const row of sourceRows("Character_Definitions.csv")) {
      assert.ok(units.includes(renames.get(row.Character_ID) ?? row.Character_ID), `missing unit ${row.Character_ID}`);
    }
    assert.equal(units.length, 312);

    // Every authored Counter_ID is retained as archetype_code, unchanged.
    const codes = new Set((await database.query("select archetype_code from gac.team_archetypes")).rows.map((row) => row.archetype_code));
    for (const row of sourceRows("Counter_Definitions.csv")) {
      assert.ok(codes.has(row.Counter_ID), `missing archetype_code ${row.Counter_ID}`);
    }
    assert.ok(codes.has("MAZ_KANATA"));

    // No display name changes anywhere.
    const unitNames = new Map((await database.query("select unit_id, display_name from gac.units")).rows.map((row) => [row.unit_id, row.display_name]));
    for (const row of sourceRows("Character_Definitions.csv")) {
      assert.equal(unitNames.get(renames.get(row.Character_ID) ?? row.Character_ID), row.Character_Name);
    }
    const archetypeNames = new Map((await database.query("select archetype_code, display_name from gac.team_archetypes")).rows.map((row) => [row.archetype_code, row.display_name]));
    for (const row of sourceRows("Counter_Definitions.csv")) {
      assert.equal(archetypeNames.get(row.Counter_ID), row["Counter Team"]);
    }
    const storedNames = new Set(archetypeNames.values());
    const sourceDefenceNames = new Set([
      ...sourceRows("Counters.csv").map((row) => row["Defence Team"]),
      ...sourceRows("Defence_Teams.csv").map((row) => row.Defence_Team)
    ]);
    for (const name of sourceDefenceNames) assert.ok(storedNames.has(name), `missing defence display name ${name}`);

    // Every tactical note survives byte-for-byte.
    const storedNotes = (await database.query("select notes from gac.matchup_catalogue_values where notes <> ''")).rows.map((row) => row.notes).sort();
    const expectedNotes = sourceRows("Counters.csv").map((row) => row.Notes).filter((note) => note !== "").sort();
    assert.deepEqual(storedNotes, expectedNotes);
    assert.equal(reconciliation.notePreservation.notesDroppedSilently, 0);

    // Board configuration keeps its significant source order.
    const board = (await database.query("select league, mode, territory, territory_type, team_count, display_order from gac.gac_board_config order by league, mode, display_order")).rows;
    const expectedOrder = new Map();
    for (const row of sourceRows("GAC_Board_Config.csv")) {
      const key = `${row.League}|${row.Mode === "3v3" ? "3V3" : "5V5"}`;
      const next = expectedOrder.get(key) ?? [];
      next.push(row.Territory);
      expectedOrder.set(key, next);
    }
    for (const [key, territories] of expectedOrder) {
      const [league, mode] = key.split("|");
      const stored = board.filter((row) => row.league === league && row.mode === mode).map((row) => row.territory);
      assert.deepEqual(stored, territories, `board order changed for ${key}`);
    }

    // Scoring rows and values are preserved exactly.
    const scoring = (await database.query("select rule_id, battle_type, mode, value, notes from gac.gac_scoring_rules")).rows;
    assert.equal(scoring.length, 16);
    for (const row of sourceRows("GAC_Scoring.csv")) {
      const mode = row.Mode === "3v3" ? "3V3" : row.Mode === "5v5" ? "5V5" : row.Mode;
      const stored = scoring.find((entry) => entry.rule_id === row.Rule_ID && entry.battle_type === row.Battle_Type && entry.mode === mode);
      assert.ok(stored, `missing scoring rule ${row.Rule_ID}/${row.Battle_Type}/${row.Mode}`);
      assert.equal(Number(stored.value), Number(row.Value));
      assert.equal(stored.notes, row.Notes);
    }

    // Required-member external-ID coverage is not reduced.
    const uncovered = await database.query(`
      select count(*)::int as total
      from gac.team_profile_members member
      join gac.units unit on unit.unit_id = member.unit_id
      where member.member_role = 'REQUIRED' and coalesce(unit.external_id, '') = ''
    `);
    assert.equal(uncovered.rows[0].total, 0);
    assert.equal(reconciliation.requiredMemberExternalIdCoverage.withoutExternalId, 0);

    // Every migrated judgement is AUTHORED_BASELINE; nothing is locked.
    const authorities = await database.query(`
      select count(*)::int as total from gac.matchup_catalogue_values
      where tier_authority <> 'AUTHORED_BASELINE' or banner_authority <> 'AUTHORED_BASELINE'
         or undersize_authority <> 'AUTHORED_BASELINE'
    `);
    assert.equal(authorities.rows[0].total, 0);
    const locked = await database.query("select count(*)::int as total from gac.defence_catalogue_values where threat_authority <> 'AUTHORED_BASELINE'");
    assert.equal(locked.rows[0].total, 0);

    // The legacy-migration authoring record exists, and no release was created.
    const change = (await database.query("select change_id, authority, status, author from gac.authoring_changes")).rows;
    assert.equal(change.length, 1);
    assert.equal(change[0].change_id, "ARCH-106-LEGACY-MIGRATION");
    assert.equal(change[0].authority, "AUTHORED_BASELINE");
    assert.equal(change[0].status, "APPLIED");
    const releases = await database.query("select count(*)::int as total from gac.catalogue_releases");
    assert.equal(releases.rows[0].total, 0, "release creation belongs to ARCH-108");
  });
});

// ─── defence identity rules ──────────────────────────────────────────────────

test("unmatched defence names become the committed deterministic defence-only identities", () => {
  const decisions = readDecisions();
  const { reconciliation } = buildPlan(readSources(), decisions);
  const expected = decisions.identityRules.defenceOnlyArchetypeCodes;
  const actual = Object.fromEntries(
    reconciliation.defenceIdentities.defenceOnlyMappings.map((entry) => [entry.displayName, entry.archetypeCode])
  );
  assert.deepEqual(actual, expected);
  assert.equal(Object.keys(expected).length, 33);
  assert.equal(reconciliation.defenceIdentities.reusedExactAttackIdentity, 36);
  for (const [displayName, code] of Object.entries(expected)) {
    assert.match(code, /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/);
    assert.ok(displayName.length > 0);
  }
});

test("the defence-only code rule is deterministic and resolves collisions in order", () => {
  const taken = new Set(["DEF_REY"]);
  assert.deepEqual(allocateDefenceOnlyCode("Rey", taken), { code: "DEF_REY_2", base: "DEF_REY", collisionSuffix: 2 });
  assert.deepEqual(allocateDefenceOnlyCode("Rey", taken), { code: "DEF_REY_3", base: "DEF_REY", collisionSuffix: 3 });
  assert.deepEqual(allocateDefenceOnlyCode("R.E.Y!", new Set()), { code: "DEF_R_E_Y", base: "DEF_R_E_Y", collisionSuffix: null });
  assert.throws(() => allocateDefenceOnlyCode("!!!", new Set()), /no usable code/);
});

test("two defence names that normalise to the same code get distinct deterministic codes", () => {
  const sheets = baseSheets();
  sheets.Counters.push(
    { Mode: "3v3", "Defence Team": "Rogue One", Counter_ID: "ALPHA", "Counter Team": "Alpha", Tier: "B", "Banner Score": "50", "Score Meaning": "", Undersize: "0", Notes: "" },
    { Mode: "3v3", "Defence Team": "Rogue-One", Counter_ID: "ALPHA", "Counter Team": "Alpha", Tier: "B", "Banner Score": "50", "Score Meaning": "", Undersize: "0", Notes: "" }
  );
  const root = writeFixture(sheets);
  try {
    const { reconciliation } = buildPlan(readSources(root), readDecisions());
    const codes = Object.fromEntries(
      reconciliation.defenceIdentities.defenceOnlyMappings.map((entry) => [entry.displayName, entry.archetypeCode])
    );
    assert.equal(codes["Rogue One"], "DEF_ROGUE_ONE");
    assert.equal(codes["Rogue-One"], "DEF_ROGUE_ONE_2");
    assert.notEqual(codes["Rogue One"], codes["Rogue-One"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an ambiguous defence identity is rejected rather than guessed", () => {
  const sheets = baseSheets();
  // Two counter definitions publishing the same display name make the defence
  // name "Alpha" ambiguous.
  sheets.Counter_Definitions.push({ Counter_ID: "ALPHA_TWO", "Counter Team": "Alpha" });
  sheets.Counter_Composition.push({ Counter_ID: "ALPHA_TWO", Character_ID: "UNIT_TWO", Role: "REQUIRED" });
  const root = writeFixture(sheets);
  try {
    const { reconciliation } = buildPlan(readSources(root), readDecisions());
    const ambiguous = reconciliation.blockers.filter((entry) => entry.anomalyId === "AMBIGUOUS_DEFENCE_IDENTITY");
    assert.equal(ambiguous.length, 1);
    assert.match(ambiguous[0].message, /will not guess/);
    assert.deepEqual(ambiguous[0].evidence.candidates.sort(), ["ALPHA", "ALPHA_TWO"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── duplicate handling ──────────────────────────────────────────────────────

test("the known duplicate is handled only by its explicit decision", () => {
  const sources = readSources();

  const blocked = buildPlan(sources, readDecisions()).reconciliation;
  assert.equal(blocked.mappings.manyToOne.length, 0, "no collapse without an explicit decision");

  // The committed evidence says these rows differ, so IDENTICAL_DUPLICATE_COLLAPSED
  // must not silently apply to them either.
  const wrongDecision = withCandidateResolutions({
    ...CANDIDATE_RESOLUTIONS,
    DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA: "IDENTICAL_DUPLICATE_COLLAPSED"
  });
  const stillBlocked = buildPlan(sources, wrongDecision).reconciliation;
  assert.ok(
    stillBlocked.blockers.some((entry) => entry.anomalyId === "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA"),
    "a differing duplicate must not be collapsed as identical"
  );

  const resolved = buildPlan(sources, withCandidateResolutions()).reconciliation;
  assert.equal(resolved.mappings.manyToOne.length, 1);
  assert.deepEqual(resolved.mappings.manyToOne[0].sourceRows, [80, 82]);
  assert.equal(resolved.mappings.manyToOne[0].survivingSourceRow, 80);
});

test("an identical duplicate collapses only with the explicit identical-duplicate decision", () => {
  const sheets = baseSheets();
  const duplicate = { ...sheets.Counters[0] };
  sheets.Counters.push(duplicate);
  const root = writeFixture(sheets);
  try {
    const blocked = buildPlan(readSources(root), readDecisions()).reconciliation;
    assert.ok(blocked.blockers.some((entry) => /appears 2 times with identical values/.test(entry.message)));

    const decisions = withCandidateResolutions({
      DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA: "IDENTICAL_DUPLICATE_COLLAPSED"
    });
    const collapsed = buildPlan(readSources(root), decisions).reconciliation;
    assert.equal(collapsed.blockers.length, 0);
    assert.equal(collapsed.mappings.manyToOne.length, 1);
    assert.equal(collapsed.mappings.manyToOne[0].resolution, "IDENTICAL_DUPLICATE_COLLAPSED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a duplicate that differs in a scored field is rejected under every collapse decision", () => {
  const sheets = baseSheets();
  sheets.Counters.push({ ...sheets.Counters[0], Tier: "B", "Banner Score": "55" });
  const root = writeFixture(sheets);
  try {
    for (const resolution of ["IDENTICAL_DUPLICATE_COLLAPSED", "COLLAPSE_KEEPING_SOLE_NON_BLANK_NOTE"]) {
      const decisions = withCandidateResolutions({ DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA: resolution });
      const { reconciliation } = buildPlan(readSources(root), decisions);
      assert.ok(
        reconciliation.blockers.some((entry) => entry.anomalyId === "DUPLICATE_MATCHUP_3V3_GRAND_INQUISITOR_TRAYA"),
        `${resolution} must not resolve a duplicate that differs in a scored field`
      );
      assert.equal(reconciliation.mappings.manyToOne.length, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── synthesized definition, absent composition, mode spelling ───────────────

test("MAZ_KANATA keeps its published semantics with documented synthesized provenance", async () => {
  const decisions = withCandidateResolutions();
  const { plan, reconciliation } = buildPlan(readSources(), decisions);

  assert.deepEqual(reconciliation.mappings.synthesized, [{
    archetypeCode: "MAZ_KANATA",
    displayName: "MAZ_KANATA",
    provenance: "LEGACY_APPS_SCRIPT_SYNTHESIZED",
    createdBy: "AUTOMATION"
  }]);

  await withDatabase(async (database) => {
    await loadPlan(database, plan, reconciliation);
    const row = (await database.query(`
      select display_name, created_by, identity_reason, identity_reason_detail
      from gac.team_archetypes where archetype_code = 'MAZ_KANATA'
    `)).rows[0];
    assert.equal(row.display_name, "MAZ_KANATA", "the published name must not be invented or tidied");
    assert.equal(row.created_by, "AUTOMATION");
    assert.equal(row.identity_reason, "LEGACY_MIGRATION");
    assert.match(row.identity_reason_detail, /synthesized/i);

    // The similarly spelled defence identity stays separate.
    const defence = (await database.query("select archetype_code from gac.team_archetypes where display_name = 'Maz Kanata'")).rows;
    assert.deepEqual(defence.map((entry) => entry.archetype_code), ["DEF_MAZ_KANATA"]);

    // Authored definitions stay distinguishable from the synthesized one.
    const authored = (await database.query("select count(*)::int as total from gac.team_archetypes where created_by = 'AUTOMATION'")).rows[0].total;
    assert.equal(authored, 1);
  });
});

test("the absent Defence_Composition tab yields incomplete, member-free defence profiles", async () => {
  const decisions = withCandidateResolutions();
  const { plan, reconciliation } = buildPlan(readSources(), decisions);
  assert.equal(reconciliation.defenceComposition.sourceTabPresent, false);
  assert.equal(reconciliation.defenceComposition.membersInvented, 0);
  assert.equal(reconciliation.defenceComposition.allDefenceProfilesIncomplete, true);

  await withDatabase(async (database) => {
    await loadPlan(database, plan, reconciliation);
    const complete = await database.query("select count(*)::int as total from gac.team_profiles where usage_role = 'DEFENCE' and members_complete");
    assert.equal(complete.rows[0].total, 0);
    const members = await database.query(`
      select count(*)::int as total from gac.team_profile_members member
      join gac.team_profiles profile on profile.profile_id = member.profile_id
      where profile.usage_role = 'DEFENCE'
    `);
    assert.equal(members.rows[0].total, 0);
    const attackComplete = await database.query("select count(*)::int as total from gac.team_profiles where usage_role = 'ATTACK' and members_complete");
    assert.equal(attackComplete.rows[0].total, 0, "legacy attack cores are not exhaustive either");

    const projected = await projectPayload(database, decisions);
    assert.deepEqual(projected.defenceCompositions, {});
  });
});

test("the Any/ANY decision stores the canonical enum and projects the source spelling", async () => {
  const decisions = withCandidateResolutions();
  const anomaly = decisions.anomalies.find((entry) => entry.id === "DEFENCE_TEAM_MODE_SPELLING_ANY");
  assert.equal(anomaly.status, "RESOLVED");
  assert.equal(anomaly.resolution, "STORE_CANONICAL_ANY_PROJECT_SOURCE_SPELLING");

  const { plan, reconciliation } = buildPlan(readSources(), decisions);
  assert.ok(reconciliation.modeNormalisations.some((line) => line.includes('source "Any" -> canonical ANY -> public "Any"')));

  await withDatabase(async (database) => {
    await loadPlan(database, plan, reconciliation);
    const stored = (await database.query("select mode::text as mode, count(*)::int as total from gac.defence_catalogue_values group by mode order by mode::text")).rows;
    assert.deepEqual(stored, [{ mode: "5V5", total: 1 }, { mode: "ANY", total: 8 }]);

    const projected = await projectPayload(database, decisions);
    assert.deepEqual(Object.keys(projected.defenceTeams).sort(), ["5v5", "Any"]);
    assert.equal(Object.keys(projected.defenceTeams.Any).length, 8);
  });
});

// ─── compatibility projection ────────────────────────────────────────────────

test("the compatibility projection has no unexplained difference from the golden payload", async () => {
  const sources = readSources();
  const decisions = withCandidateResolutions();
  const { plan, reconciliation } = buildPlan(sources, decisions);

  await withDatabase(async (database) => {
    await loadPlan(database, plan, reconciliation);
    const projected = await projectPayload(database, decisions);
    const result = verifyProjection(sources.goldenPayload, projected, reconciliation);

    assert.deepEqual(result.unexplainedDifferences, []);
    assert.equal(result.byteIdenticalAfterExpectedDeltas, true);
    for (const check of result.checks) assert.ok(check.passed, `${check.id}: ${check.detail}`);
    assert.deepEqual(result.expectedDeltas.map((delta) => delta.id).sort(), [
      "COLLAPSED_DUPLICATE_MATCHUP",
      "RENAMED_UNIT_ID",
      "SCORING_ARRAY_ORDER"
    ]);
    assert.equal(result.passed, true);

    // Expected deltas are declared, not achieved by excluding a domain.
    assert.deepEqual(Object.keys(projected).sort(), Object.keys(sources.goldenPayload).sort());
    const { adjusted } = applyExpectedDeltas(sources.goldenPayload, reconciliation);
    assert.equal(Object.keys(adjusted.counters["3v3"]).length, Object.keys(sources.goldenPayload.counters["3v3"]).length);
    assert.deepEqual(sortScoring(adjusted.scoring).length, 16);
  });
});

test("an unexplained payload difference is reported rather than hidden", () => {
  const { reconciliation } = buildPlan(readSources(), withCandidateResolutions());
  const golden = readSources().goldenPayload;
  const damaged = JSON.parse(JSON.stringify(golden));
  damaged.characterDefinitions.JEDI_KNIGHT_REVAN = { name: "Not real", unitType: "CHARACTER", externalId: "X" };
  const result = verifyProjection(golden, damaged, reconciliation);
  assert.equal(result.passed, false);
  assert.ok(result.unexplainedDifferences.length > 0);
});

// ─── failure, rollback and privilege boundaries ──────────────────────────────

test("an invalid source row is rejected before any database is opened", () => {
  const sheets = baseSheets();
  sheets.Counters[0]["Banner Score"] = "1200";
  const root = writeFixture(sheets);
  try {
    assert.throws(() => buildPlan(readSources(root), readDecisions()), /Banner Score is out of range/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const tierSheets = baseSheets();
  tierSheets.Counters[0].Tier = "Z";
  const tierRoot = writeFixture(tierSheets);
  try {
    assert.throws(() => buildPlan(readSources(tierRoot), readDecisions()), /unknown Tier/);
  } finally {
    fs.rmSync(tierRoot, { recursive: true, force: true });
  }
});

test("a row the database rejects rolls the whole load back", async () => {
  const { plan, reconciliation } = buildPlan(readSources(), withCandidateResolutions());
  const damaged = {
    ...plan,
    matchups: plan.matchups.map((matchup, index) => (index === 200 ? { ...matchup, banner_score: 5000 } : matchup))
  };

  await withDatabase(async (database) => {
    await assert.rejects(loadPlan(database, damaged, reconciliation), /banner_range|check constraint/i);
    for (const table of ["gac.units", "gac.team_archetypes", "gac.matchups", "gac.authoring_changes"]) {
      const count = await database.query(`select count(*)::int as total from ${table}`);
      assert.equal(count.rows[0].total, 0, `${table} must be empty after a rolled-back load`);
    }
  });
});

test("the loader cannot modify schema objects or permissions", async () => {
  const { plan, reconciliation } = buildPlan(readSources(), withCandidateResolutions());

  for (const statement of [
    "create table gac.sneaky (id int)",
    "alter table gac.units drop constraint units_unit_id_format",
    "grant all on gac.units to gac_publisher",
    "drop policy authoring_catalogue_access on gac.units",
    "create function gac.bad() returns void language sql as $$ select 1 $$"
  ]) {
    assert.throws(() => assertDataStatement(statement), /refuses a non-data statement/);
  }

  await withDatabase(async (database) => {
    const before = await schemaSnapshot(database);
    await loadPlan(database, plan, reconciliation);
    const after = await schemaSnapshot(database);
    assert.ok(isDeepStrictEqual(before, after), "the load changed a schema object, policy, grant or role");

    // The loading role itself has no reach beyond the Stage-1 catalogue tables.
    await database.exec("set role gac_authoring");
    await assert.rejects(
      database.exec("insert into gac.catalogue_releases (version, payload_schema_version, release_reason, payload, checksum, source_commit_sha) values (1, 1, 'MIGRATION', '{}', 'sha256:" + "0".repeat(64) + "', '" + "0".repeat(40) + "')"),
      /permission denied|row-level security/
    );
    await assert.rejects(database.exec("create table gac.sneaky (id int)"), /permission denied/);
    await database.exec("reset role");
  });
});
