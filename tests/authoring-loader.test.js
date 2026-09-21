"use strict";

// ARCH-107 human authoring tests.
//
// They run against disposable WebAssembly PostgreSQL through the same PGlite
// dependency as the ARCH-105 and ARCH-106 tests. No Docker, hosted database,
// network service or credential is involved, and the committed ARCH-103 fixture
// and ARCH-106 decision file are only ever read.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { canonicalJson } = require("../scripts/baseline-lib.js");
const { ChangeFileError, canonicalDiff, readChangeFile, validateChange } = require("../scripts/authoring-lib.js");
const {
  ALLOWED_VERBS,
  applyChange,
  assertAuthoringStatement,
  canonicalSnapshot,
  openAuthoringDatabase
} = require("../scripts/authoring-load.js");
const { renderDryRun } = require("../scripts/authoring-dry-run.js");
const { readDecisions } = require("../scripts/migration-lib.js");
const { projectPayload } = require("../scripts/migration-verify.js");

const EXAMPLE = path.join("data", "authoring", "arch-107-example-counter.change.json");
const EXAMPLE_REVERT = path.join("data", "authoring", "arch-107-example-counter-revert.change.json");

const DECISIONS = readDecisions();

// A minimal well-formed change, so each negative test can alter exactly one
// thing and prove that the one thing is what gets rejected.
function baseDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    changeId: "ARCH-107-TEST",
    author: "test",
    authorRole: "OWNER",
    authoredAt: "2026-09-21T12:00:00Z",
    reason: "Test change.",
    expectedBaseRelease: null,
    operations: [matchupUpdate()],
    ...overrides
  };
}

function matchupUpdate(values = { tier: "A" }, extra = {}) {
  return {
    entity: "matchup",
    operation: "update",
    mode: "5v5",
    defenceArchetypeCode: "ADMIRAL_RADDUS",
    counterArchetypeCode: "GAS",
    values,
    ...extra
  };
}

function expectRejected(document, code) {
  let error = null;
  try {
    validateChange(document);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof ChangeFileError, `expected a ChangeFileError for ${code}`);
  const codes = error.issues.map((issue) => issue.code);
  assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(", ")} — ${error.message}`);
  return error;
}

// assert.rejects does not hand the error back, so rejections are collected here
// to let each test assert on the issue code rather than on message text.
async function applyRejection(database, document, options = {}) {
  const change = document.change_id === undefined ? validateChange(document) : document;
  try {
    await applyChange(database, change, { decisions: DECISIONS, ...options });
  } catch (error) {
    return error;
  }
  assert.fail("expected the change to be rejected");
}

let sharedDatabase = null;

// One migrated baseline is expensive to build, so read-only and rejection tests
// share it. Every test that writes builds its own.
async function baselineDatabase() {
  if (sharedDatabase === null) sharedDatabase = await openAuthoringDatabase();
  return sharedDatabase;
}

async function withFreshDatabase(run) {
  const database = await openAuthoringDatabase();
  try {
    return await run(database);
  } finally {
    await database.close();
  }
}

test.after(async () => {
  if (sharedDatabase !== null) await sharedDatabase.close();
});

// ─── change-file schema ──────────────────────────────────────────────────────

test("the committed example change files are valid and fully normalised", () => {
  const change = readChangeFile(EXAMPLE);
  assert.equal(change.change_id, "ARCH-107-EXAMPLE-COUNTER");
  assert.equal(change.author_role, "OWNER");
  assert.equal(change.expected_base_release, null);
  assert.equal(change.operations.length, 6);
  // Source mode spellings normalise through the ARCH-106 vocabulary.
  assert.equal(change.operations.at(-1).mode, "5V5");
  assert.equal(change.entity_type, "MULTIPLE");
  assert.equal(change.operation, "create");
  assert.equal(change.authority, "AUTHORED_BASELINE");

  const revert = readChangeFile(EXAMPLE_REVERT);
  assert.equal(revert.operation, "retire");
  assert.equal(revert.operations.length, 3);
});

test("an unrecognised field is rejected rather than ignored", () => {
  expectRejected(baseDocument({ oops: true }), "UNKNOWN_KEY");
  expectRejected(baseDocument({ operations: [matchupUpdate({ tier: "A" }, { oops: true })] }), "UNKNOWN_KEY");
  expectRejected(baseDocument({ operations: [matchupUpdate({ tier: "A", oops: 1 })] }), "UNKNOWN_KEY");
});

test("a malformed change ID, author role or base release is rejected", () => {
  expectRejected(baseDocument({ changeId: "arch-107-lowercase" }), "CHANGE_ID_FORMAT");
  expectRejected(baseDocument({ authorRole: "ROBOT" }), "ENUM");
  const missingBase = baseDocument();
  delete missingBase.expectedBaseRelease;
  expectRejected(missingBase, "REQUIRED");
  expectRejected(baseDocument({ expectedBaseRelease: 0 }), "RANGE");
  expectRejected(baseDocument({ authoredAt: "2026-09-21 12:00:00" }), "TIMESTAMP_OFFSET");
});

test("an invalid unit ID is rejected", () => {
  const create = {
    entity: "unit",
    operation: "create",
    unitId: "bad unit id",
    displayName: "Bad Unit",
    unitType: "CHARACTER"
  };
  expectRejected(baseDocument({ operations: [create] }), "UNIT_ID_FORMAT");
  // A newly authored unit must also satisfy the stricter ARCH-105 uppercase
  // form, even though the ARCH-106 follow-up widened the stored constraint.
  expectRejected(baseDocument({ operations: [{ ...create, unitId: "TIE_ADVANCED_x9" }] }), "UNIT_ID_FORMAT");
  // Referencing the one legacy identifier that relies on the widened form is
  // still allowed.
  assert.doesNotThrow(() => validateChange(baseDocument({
    operations: [{
      entity: "member",
      operation: "create",
      archetypeCode: "GAS",
      mode: "ANY",
      usageRole: "ATTACK",
      unitId: "TIE_ADVANCED_x1",
      memberRole: "RECOMMENDED",
      sortOrder: 9
    }]
  })));
});

test("an out-of-range score is rejected against the mode's scoring ceiling", () => {
  // docs/SCORING_REFERENCE.md: 57 (3v3), 65 (5v5), 73 (fleet).
  expectRejected(baseDocument({ operations: [matchupUpdate({ bannerScore: 66 })] }), "RANGE");
  assert.doesNotThrow(() => validateChange(baseDocument({ operations: [matchupUpdate({ bannerScore: 65 })] })));

  const threeVthree = (values) => ({ ...matchupUpdate(values), mode: "3v3" });
  expectRejected(baseDocument({ operations: [threeVthree({ bannerScore: 58 })] }), "RANGE");
  assert.doesNotThrow(() => validateChange(baseDocument({ operations: [threeVthree({ bannerScore: 57 })] })));

  // Undersize cannot leave a counter with no units, and the schema caps it at 5.
  expectRejected(baseDocument({ operations: [threeVthree({ undersize: 3 })] }), "RANGE");
  expectRejected(baseDocument({ operations: [matchupUpdate({ undersize: 5 })] }), "RANGE");
  expectRejected(baseDocument({ operations: [matchupUpdate({ bannerScore: -1 })] }), "RANGE");
});

test("an invalid tier, threat, mode or note is rejected", () => {
  expectRejected(baseDocument({ operations: [matchupUpdate({ tier: "D" })] }), "ENUM");
  expectRejected(baseDocument({ operations: [{ ...matchupUpdate(), mode: "Any" }] }), "MODE");
  expectRejected(baseDocument({ operations: [{ ...matchupUpdate(), mode: "10v10" }] }), "MODE");
  expectRejected(baseDocument({ operations: [matchupUpdate({ notes: "line\nbreak" })] }), "NOTES_CONTROL_CHARACTER");
  expectRejected(baseDocument({ operations: [matchupUpdate({ notes: " padded " })] }), "NOTES_PADDING");
  expectRejected(baseDocument({ operations: [matchupUpdate({ notes: "x".repeat(501) })] }), "LENGTH");
  expectRejected(baseDocument({
    operations: [{
      entity: "defenceValues",
      operation: "update",
      archetypeCode: "JABBA",
      mode: "3v3",
      values: { threat: "SEVERE" }
    }]
  }), "ENUM");
});

test("ASSESSED authority cannot be authored", () => {
  expectRejected(baseDocument({ operations: [matchupUpdate({ tierAuthority: "ASSESSED" })] }), "ENUM");
});

test("only an OWNER change may lock a value or acknowledge a lock", () => {
  expectRejected(
    baseDocument({ authorRole: "MAINTENANCE", operations: [matchupUpdate({ tierAuthority: "AUTHORED_LOCKED" })] }),
    "LOCK_REQUIRES_OWNER"
  );
  expectRejected(
    baseDocument({ authorRole: "MAINTENANCE", operations: [matchupUpdate({ tier: "A" }, { acknowledgeLocked: true })] }),
    "LOCK_REQUIRES_OWNER"
  );
});

test("two operations targeting the same row are rejected as a duplicate", () => {
  expectRejected(
    baseDocument({ operations: [matchupUpdate({ tier: "A" }), matchupUpdate({ tier: "B" })] }),
    "DUPLICATE_OPERATION"
  );
});

test("an operation that changes nothing is rejected", () => {
  expectRejected(baseDocument({ operations: [matchupUpdate({})] }), "EMPTY_VALUES");
  expectRejected(baseDocument({ operations: [{ entity: "unit", operation: "update", unitId: "GAS" }] }), "EMPTY_VALUES");
});

test("removing a profile member is refused, because no grant allows it", () => {
  // gac_authoring holds no DELETE grant on gac.team_profile_members and the
  // table carries no lifecycle column, so ARCH-107 refuses rather than
  // pretending. Recorded as an open question in docs/database/ARCH-107.md.
  const error = expectRejected(baseDocument({
    operations: [{
      entity: "member",
      operation: "retire",
      archetypeCode: "GAS",
      mode: "ANY",
      usageRole: "ATTACK",
      unitId: "GENERAL_HUX"
    }]
  }), "OPERATION");
  assert.match(error.message, /member supports create, update/);
});

test("a leader must be a required member", () => {
  expectRejected(baseDocument({
    operations: [{
      entity: "member",
      operation: "create",
      archetypeCode: "GAS",
      mode: "ANY",
      usageRole: "ATTACK",
      unitId: "GENERAL_HUX",
      memberRole: "RECOMMENDED",
      isLeader: true,
      sortOrder: 9
    }]
  }), "LEADER_ROLE");
});

// ─── an agent can prepare a one-counter change without SQL ───────────────────

test("the example one-counter change applies to the migrated baseline", async () => {
  await withFreshDatabase(async (database) => {
    const change = readChangeFile(EXAMPLE);
    const result = await applyChange(database, change, { decisions: DECISIONS });
    assert.equal(result.committed, true);
    assert.equal(result.alreadyApplied, false);

    const archetype = (await database.query(
      "select display_name, battle_type, identity_reason, created_by, status from gac.team_archetypes where archetype_code = 'FO_HUX'"
    )).rows;
    assert.deepEqual(archetype, [{
      display_name: "First Order (Hux)",
      battle_type: "SQUAD",
      identity_reason: "DISTINCT_LEADER",
      created_by: "HUMAN",
      status: "ACTIVE"
    }]);

    const members = (await database.query(`
      select member.unit_id, member.member_role, member.is_leader, member.sort_order
      from gac.team_profile_members member
      join gac.team_profiles profile on profile.profile_id = member.profile_id
      join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
      where archetype.archetype_code = 'FO_HUX' order by member.sort_order
    `)).rows;
    assert.deepEqual(members.map((row) => row.unit_id), ["GENERAL_HUX", "SITH_TROOPER", "CAPTAIN_PHASMA"]);
    assert.equal(members[0].is_leader, true);

    const values = (await database.query(`
      select value.tier, value.banner_score, value.undersize, value.notes,
             value.tier_authority, value.banner_authority, value.undersize_authority
      from gac.matchup_catalogue_values value
      join gac.matchups matchup on matchup.matchup_id = value.matchup_id
      join gac.team_archetypes counter on counter.archetype_id = matchup.counter_archetype_id
      where counter.archetype_code = 'FO_HUX'
    `)).rows;
    assert.equal(values.length, 1);
    assert.equal(values[0].tier, "B");
    assert.equal(Number(values[0].banner_score), 60);
    assert.equal(values[0].tier_authority, "AUTHORED_BASELINE");

    // The applied author, reason and stable change ID are recorded, and the
    // ARCH-106 migration record is untouched beside it.
    const recorded = (await database.query(
      "select change_id, author, entity_type, operation, authority, reason, status, applied_at from gac.authoring_changes order by change_id"
    )).rows;
    assert.deepEqual(recorded.map((row) => row.change_id), ["ARCH-106-LEGACY-MIGRATION", "ARCH-107-EXAMPLE-COUNTER"]);
    const authored = recorded[1];
    assert.equal(authored.author, "arch-107-example");
    assert.equal(authored.status, "APPLIED");
    assert.notEqual(authored.applied_at, null);
    assert.match(authored.reason, /^Illustrative worked example/);

    const stored = (await database.query(
      "select structured_values from gac.authoring_changes where change_id = 'ARCH-107-EXAMPLE-COUNTER'"
    )).rows[0].structured_values;
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    assert.equal(parsed.package, "ARCH-107");
    assert.equal(parsed.authorRole, "OWNER");
    assert.equal(parsed.operations.length, 6);
  });
});

// ─── dry run ─────────────────────────────────────────────────────────────────

test("a dry run shows the exact canonical and payload effects and writes nothing", async () => {
  await withFreshDatabase(async (database) => {
    const change = readChangeFile(EXAMPLE);
    const before = await canonicalSnapshot(database);
    const beforePayload = await projectPayload(database, DECISIONS);

    const dry = await applyChange(database, change, { dryRun: true, decisions: DECISIONS });
    assert.equal(dry.committed, false);

    // Nothing survived the rollback.
    const after = await canonicalSnapshot(database);
    assert.equal(canonicalJson(after), canonicalJson(before));
    assert.equal(canonicalJson(await projectPayload(database, DECISIONS)), canonicalJson(beforePayload));

    // The canonical effect is exact: one archetype, one profile, three members,
    // one matchup, one value row and one authoring record.
    const inserted = dry.canonicalDiff.filter((entry) => entry.operation === "INSERT");
    assert.equal(dry.canonicalDiff.length, inserted.length);
    const byTable = {};
    for (const entry of inserted) byTable[entry.table] = (byTable[entry.table] ?? 0) + 1;
    assert.deepEqual(byTable, {
      team_archetypes: 1,
      team_profiles: 1,
      team_profile_members: 3,
      matchups: 1,
      matchup_catalogue_values: 1,
      authoring_changes: 1
    });

    // The payload effect is exact too.
    assert.deepEqual(dry.payloadDiff.map((entry) => entry.path).sort(), [
      "counterDefinitions.FO_HUX",
      "counters.5v5.Admiral Raddus"
    ]);
    const definition = dry.payloadDiff.find((entry) => entry.path === "counterDefinitions.FO_HUX");
    assert.equal(definition.before, undefined);
    assert.deepEqual(definition.after, {
      name: "First Order (Hux)",
      required: ["GENERAL_HUX", "SITH_TROOPER"],
      recommended: ["CAPTAIN_PHASMA"]
    });
    const counters = dry.payloadDiff.find((entry) => entry.path === "counters.5v5.Admiral Raddus");
    assert.equal(counters.after.length, counters.before.length + 1);
    assert.deepEqual(counters.after.at(-1), {
      counterId: "FO_HUX",
      counter: "First Order (Hux)",
      tier: "B",
      bannerScore: 60,
      undersize: 0,
      notes: "Illustrative example value"
    });

    // The candidate payload is a complete, well-formed catalogue contract.
    assert.deepEqual(Object.keys(dry.payloadAfter).sort(), [
      "boardConfig", "characterDefinitions", "counterDefinitions", "counters",
      "defenceCompositions", "defenceTeams", "scoring"
    ]);

    const rendered = renderDryRun(change, dry);
    assert.match(rendered, /Committed: no \(dry run\)/);
    assert.match(rendered, /INSERT matchups — 5V5\|ADMIRAL_RADDUS\|FO_HUX/);
    assert.match(rendered, /counters\.5v5\.Admiral Raddus`: 8 → 9 entries/);
  });
});

// ─── idempotency ─────────────────────────────────────────────────────────────

test("applying the same change twice does not duplicate data", async () => {
  await withFreshDatabase(async (database) => {
    const change = readChangeFile(EXAMPLE);
    const first = await applyChange(database, change, { decisions: DECISIONS });
    assert.equal(first.writes.length, 6);

    const snapshot = await canonicalSnapshot(database);
    const updatedAt = (await database.query(`
      select max(updated_at) as matchups, (select max(updated_at) from gac.team_archetypes) as archetypes
      from gac.matchups
    `)).rows[0];

    const second = await applyChange(database, change, { decisions: DECISIONS });
    assert.equal(second.alreadyApplied, true);
    assert.equal(second.writes.length, 0);
    assert.equal(second.canonicalDiff.length, 0);
    assert.equal(canonicalJson(await canonicalSnapshot(database)), canonicalJson(snapshot));

    const after = (await database.query(`
      select max(updated_at) as matchups, (select max(updated_at) from gac.team_archetypes) as archetypes
      from gac.matchups
    `)).rows[0];
    assert.deepEqual(after, updatedAt, "a repeat apply must not touch any row");

    const changes = (await database.query("select count(*)::int as total from gac.authoring_changes")).rows[0].total;
    assert.equal(changes, 2, "the authoring record must not duplicate");
  });
});

test("an update that is already satisfied writes nothing", async () => {
  await withFreshDatabase(async (database) => {
    const document = baseDocument({
      changeId: "ARCH-107-NOOP-UPDATE",
      operations: [matchupUpdate({ tier: "S", bannerScore: 61 })]
    });
    const result = await applyChange(database, validateChange(document), { decisions: DECISIONS });
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.canonicalDiff.map((entry) => entry.table), ["authoring_changes"]);
  });
});

test("update and retire reach every canonical table the schema allows", async () => {
  await withFreshDatabase(async (database) => {
    const existingDefence = (await database.query(`
      select archetype.archetype_code, value.mode
      from gac.defence_catalogue_values value
      join gac.team_archetypes archetype on archetype.archetype_id = value.archetype_id
      order by archetype.archetype_code limit 1
    `)).rows[0];

    const result = await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-EVERY-UPDATE-PATH",
      operations: [
        { entity: "unit", operation: "update", unitId: "GENERAL_HUX", displayName: "General Hux (Renamed)", externalId: "GENERALHUX2" },
        { entity: "unit", operation: "retire", unitId: "CAPTAIN_PHASMA" },
        { entity: "archetype", operation: "update", archetypeCode: "GAS", displayName: "General Skywalker" },
        { entity: "profile", operation: "update", archetypeCode: "GAS", mode: "ANY", usageRole: "ATTACK", flexSlots: 2, membersComplete: true },
        {
          entity: "member",
          operation: "update",
          archetypeCode: "GAS",
          mode: "ANY",
          usageRole: "ATTACK",
          unitId: "GENERAL_SKYWALKER",
          memberRole: "RECOMMENDED",
          sortOrder: 3
        },
        {
          entity: "defenceValues",
          operation: "update",
          archetypeCode: existingDefence.archetype_code,
          mode: existingDefence.mode,
          values: { threat: "EXTREME", notes: "Updated defence note" }
        },
        {
          entity: "defenceValues",
          operation: "create",
          archetypeCode: "GAS",
          mode: "3v3",
          values: { threat: "HIGH", notes: "New defence note", threatAuthority: "AUTHORED_BASELINE" }
        }
      ]
    })), { decisions: DECISIONS });
    assert.equal(result.writes.length, 7);

    const unit = (await database.query("select display_name, external_id, active from gac.units where unit_id in ('GENERAL_HUX', 'CAPTAIN_PHASMA') order by unit_id")).rows;
    assert.deepEqual(unit, [
      { display_name: "Captain Phasma", external_id: "PHASMA", active: false },
      { display_name: "General Hux (Renamed)", external_id: "GENERALHUX2", active: true }
    ]);

    const archetype = (await database.query("select display_name from gac.team_archetypes where archetype_code = 'GAS'")).rows[0];
    assert.equal(archetype.display_name, "General Skywalker");

    const profile = (await database.query(`
      select profile.flex_slots, profile.members_complete, member.member_role, member.sort_order
      from gac.team_profiles profile
      join gac.team_archetypes archetype on archetype.archetype_id = profile.archetype_id
      join gac.team_profile_members member on member.profile_id = profile.profile_id
      where archetype.archetype_code = 'GAS' and profile.usage_role = 'ATTACK'
    `)).rows[0];
    assert.equal(Number(profile.flex_slots), 2);
    assert.equal(profile.members_complete, true);
    assert.equal(profile.member_role, "RECOMMENDED");
    assert.equal(Number(profile.sort_order), 3);

    const defence = (await database.query(`
      select archetype.archetype_code, value.mode, value.threat, value.notes, value.threat_authority
      from gac.defence_catalogue_values value
      join gac.team_archetypes archetype on archetype.archetype_id = value.archetype_id
      where (archetype.archetype_code = $1 and value.mode = $2) or (archetype.archetype_code = 'GAS' and value.mode = '3V3')
      order by archetype.archetype_code, value.mode
    `, [existingDefence.archetype_code, existingDefence.mode])).rows;
    assert.equal(defence.length, 2);
    assert.ok(defence.some((row) => row.threat === "EXTREME" && row.notes === "Updated defence note"));
    assert.ok(defence.some((row) => row.archetype_code === "GAS" && row.mode === "3V3" && row.threat === "HIGH"));

    // Those updates are idempotent too: re-stating them writes nothing.
    const second = await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-EVERY-UPDATE-PATH-AGAIN",
      operations: [
        { entity: "unit", operation: "update", unitId: "GENERAL_HUX", displayName: "General Hux (Renamed)" },
        { entity: "member", operation: "update", archetypeCode: "GAS", mode: "ANY", usageRole: "ATTACK", unitId: "GENERAL_SKYWALKER", sortOrder: 3 }
      ]
    })), { decisions: DECISIONS });
    assert.equal(second.writes.length, 0);
  });
});

// ─── rejections that need stored state ───────────────────────────────────────

test("a duplicate matchup is rejected", async () => {
  const database = await baselineDatabase();
  const error = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-DUPLICATE-MATCHUP",
    operations: [{
      entity: "matchup",
      operation: "create",
      mode: "5v5",
      defenceArchetypeCode: "ADMIRAL_RADDUS",
      counterArchetypeCode: "GAS",
      values: { tier: "A", bannerScore: 60 }
    }]
  }));
  assert.equal(error.issues[0].code, "DUPLICATE_MATCHUP");
});

test("a create that disagrees with what is already stored is rejected, never merged", async () => {
  const database = await baselineDatabase();

  const unit = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-UNIT-CONFLICT",
    operations: [{
      entity: "unit",
      operation: "create",
      unitId: "GENERAL_HUX",
      displayName: "Renamed Hux",
      unitType: "CHARACTER",
      externalId: "GENERALHUX"
    }]
  }));
  assert.equal(unit.issues[0].code, "CONFLICT");

  const member = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-MEMBER-CONFLICT",
    operations: [{
      entity: "member",
      operation: "create",
      archetypeCode: "GAS",
      mode: "ANY",
      usageRole: "ATTACK",
      unitId: "GENERAL_SKYWALKER",
      memberRole: "RECOMMENDED",
      sortOrder: 4
    }]
  }));
  assert.deepEqual(member.issues.map((issue) => issue.code), ["CONFLICT", "CONFLICT"]);

  const externalId = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-EXTERNAL-ID-CLASH",
    operations: [{
      entity: "unit",
      operation: "create",
      unitId: "ARCH107_CLASH",
      displayName: "Clash",
      unitType: "CHARACTER",
      externalId: "GENERALHUX"
    }]
  }));
  assert.equal(externalId.issues[0].code, "DUPLICATE_EXTERNAL_ID");
});

test("an unknown identifier is rejected", async () => {
  const database = await baselineDatabase();
  const unknownCounter = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-UNKNOWN-ARCHETYPE",
    operations: [{
      entity: "matchup",
      operation: "create",
      mode: "5v5",
      defenceArchetypeCode: "ADMIRAL_RADDUS",
      counterArchetypeCode: "NOT_A_TEAM",
      values: { tier: "A", bannerScore: 60 }
    }]
  }));
  assert.deepEqual(unknownCounter.issues.map((issue) => issue.code), ["UNKNOWN_ARCHETYPE"]);

  const unknownUnit = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-UNKNOWN-UNIT",
    operations: [{
      entity: "member",
      operation: "create",
      archetypeCode: "GAS",
      mode: "ANY",
      usageRole: "ATTACK",
      unitId: "NOT_A_UNIT",
      memberRole: "REQUIRED",
      sortOrder: 9
    }]
  }));
  assert.deepEqual(unknownUnit.issues.map((issue) => issue.code), ["UNKNOWN_UNIT"]);

  const unknownMatchup = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-UNKNOWN-MATCHUP",
    operations: [{ ...matchupUpdate({ tier: "A" }), counterArchetypeCode: "WAMPA", mode: "FLEET" }]
  }));
  assert.deepEqual(unknownMatchup.issues.map((issue) => issue.code), ["UNKNOWN_MATCHUP"]);
});

test("a membership or mode that the canonical model forbids is rejected", async () => {
  const database = await baselineDatabase();

  // A FLEET matchup needs FLEET archetypes on both sides.
  const wrongMode = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-WRONG-MODE",
    operations: [{
      entity: "matchup",
      operation: "create",
      mode: "FLEET",
      defenceArchetypeCode: "ADMIRAL_RADDUS",
      counterArchetypeCode: "GAS",
      values: { tier: "A", bannerScore: 60 }
    }]
  }));
  assert.equal(wrongMode.issues[0].code, "MODE_INCOMPATIBLE");

  // A SQUAD archetype cannot hold a FLEET profile.
  const wrongProfile = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-WRONG-PROFILE",
    operations: [{
      entity: "profile",
      operation: "create",
      archetypeCode: "GAS",
      mode: "FLEET",
      usageRole: "ATTACK"
    }]
  }));
  assert.equal(wrongProfile.issues[0].code, "MODE_INCOMPATIBLE");

  // A required member must carry an external_id. Every migrated unit has one,
  // so the change creates a unit without one and then requires it.
  assert.equal(
    (await database.query("select count(*)::int as total from gac.units where coalesce(external_id, '') = ''")).rows[0].total,
    0,
    "ARCH-106 left no unit without an external_id"
  );
  const missingExternal = await applyRejection(database, baseDocument({
    changeId: "ARCH-107-MISSING-EXTERNAL-ID",
    operations: [
      { entity: "unit", operation: "create", unitId: "ARCH107_NO_EXTERNAL", displayName: "No External", unitType: "CHARACTER" },
      {
        entity: "member",
        operation: "create",
        archetypeCode: "GAS",
        mode: "ANY",
        usageRole: "ATTACK",
        unitId: "ARCH107_NO_EXTERNAL",
        memberRole: "REQUIRED",
        sortOrder: 9
      }
    ]
  }));
  assert.equal(missingExternal.issues[0].code, "MISSING_EXTERNAL_ID");
});

// ─── base release ────────────────────────────────────────────────────────────

// Test scaffolding, not a publisher: it writes one release row and moves the
// singleton pointer directly, as the owner of the schema, so the base-release
// check has something to be stale against. ARCH-108 owns the real publication
// protocol, including version allocation, checksums and the READY/DEPLOYED
// transitions this helper bypasses.
async function seedCurrentRelease(database, version) {
  await database.exec(`
    insert into gac.catalogue_releases (
      version, payload_schema_version, release_reason, status, payload, checksum,
      source_commit_sha, deployed_commit_sha, cloudflare_deployment_id, published_at
    ) values (
      ${version}, 1, 'MIGRATION', 'DEPLOYED', '{}'::jsonb,
      'sha256:${"0".repeat(64)}', '${"a".repeat(40)}', '${"a".repeat(40)}', 'test-deployment',
      statement_timestamp()
    );
    update gac.catalogue_state
       set current_release_id = (select release_id from gac.catalogue_releases where version = ${version}),
           publication_generation = publication_generation + 1
     where singleton_id;
  `);
}

test("a change proposed against a stale base release is rejected", async () => {
  await withFreshDatabase(async (database) => {
    // Nothing published yet: a change expecting a release is stale.
    const expectingRelease = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-EXPECTS-RELEASE",
      expectedBaseRelease: 7
    }));
    assert.equal(expectingRelease.issues[0].code, "STALE_BASE_RELEASE");

    await seedCurrentRelease(database, 7);

    // Now the catalogue has moved: a change written against no release is stale.
    const expectingNothing = await applyRejection(database, baseDocument({ changeId: "ARCH-107-EXPECTS-NOTHING" }));
    assert.equal(expectingNothing.issues[0].code, "STALE_BASE_RELEASE");

    // And a change written against an older release is stale.
    const expectingOlder = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-EXPECTS-OLDER",
      expectedBaseRelease: 6
    }));
    assert.equal(expectingOlder.issues[0].code, "STALE_BASE_RELEASE");

    // The matching base is accepted and recorded against the release.
    const matching = await applyChange(
      database,
      validateChange(baseDocument({ changeId: "ARCH-107-EXPECTS-CURRENT", expectedBaseRelease: 7 })),
      { decisions: DECISIONS }
    );
    assert.equal(matching.committed, true);
    const recorded = (await database.query(`
      select release.version
      from gac.authoring_changes change
      join gac.catalogue_releases release on release.release_id = change.expected_base_release_id
      where change.change_id = 'ARCH-107-EXPECTS-CURRENT'
    `)).rows;
    assert.deepEqual(recorded.map((row) => Number(row.version)), [7]);
  });
});

// ─── locked values ───────────────────────────────────────────────────────────

test("a locked value cannot be changed by the maintenance role", async () => {
  await withFreshDatabase(async (database) => {
    // The owner locks a migrated AUTHORED_BASELINE tier.
    await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-LOCK",
      operations: [matchupUpdate({ tierAuthority: "AUTHORED_LOCKED" })]
    })), { decisions: DECISIONS });

    const locked = (await database.query(`
      select value.tier_authority, value.banner_authority
      from gac.matchup_catalogue_values value
      join gac.matchups matchup on matchup.matchup_id = value.matchup_id
      join gac.team_archetypes defence on defence.archetype_id = matchup.defence_archetype_id
      join gac.team_archetypes counter on counter.archetype_id = matchup.counter_archetype_id
      where matchup.mode = '5V5' and defence.archetype_code = 'ADMIRAL_RADDUS' and counter.archetype_code = 'GAS'
    `)).rows[0];
    assert.equal(locked.tier_authority, "AUTHORED_LOCKED");
    assert.equal(locked.banner_authority, "AUTHORED_BASELINE");

    // The maintenance role is refused outright.
    const refused = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-MAINTENANCE-TIER",
      authorRole: "MAINTENANCE",
      operations: [matchupUpdate({ tier: "C" })]
    }));
    assert.equal(refused.issues[0].code, "LOCKED_VALUE");
    assert.match(refused.message, /cannot be changed by the MAINTENANCE role/);

    // So is an attempt to unlock it.
    const unlockRefused = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-MAINTENANCE-UNLOCK",
      authorRole: "MAINTENANCE",
      operations: [matchupUpdate({ tierAuthority: "AUTHORED_BASELINE" })]
    }));
    assert.equal(unlockRefused.issues[0].code, "LOCKED_VALUE");

    // A field that is not locked stays editable by the maintenance role.
    const allowed = await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-MAINTENANCE-BANNER",
      authorRole: "MAINTENANCE",
      operations: [matchupUpdate({ bannerScore: 60 })]
    })), { decisions: DECISIONS });
    assert.equal(allowed.writes.length, 1);

    // The owner must still acknowledge the lock deliberately.
    const unacknowledged = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-OWNER-TIER",
      operations: [matchupUpdate({ tier: "C" })]
    }));
    assert.equal(unacknowledged.issues[0].code, "LOCKED_VALUE");
    assert.match(unacknowledged.message, /acknowledgeLocked/);

    const acknowledged = await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-OWNER-TIER-ACK",
      operations: [matchupUpdate({ tier: "C" }, { acknowledgeLocked: true })]
    })), { decisions: DECISIONS });
    assert.equal(acknowledged.writes.length, 1);
    assert.equal(acknowledged.canonicalDiff.find((entry) => entry.table === "matchup_catalogue_values").after.tier, "C");
  });
});

// ─── change identity ─────────────────────────────────────────────────────────

test("a change ID cannot be reused for different content, or replayed after the catalogue moved on", async () => {
  await withFreshDatabase(async (database) => {
    await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-STABLE-ID",
      operations: [matchupUpdate({ tier: "A" })]
    })), { decisions: DECISIONS });

    const reused = await applyRejection(database, baseDocument({
      changeId: "ARCH-107-STABLE-ID",
      operations: [matchupUpdate({ tier: "B" })]
    }));
    assert.ok(reused.issues.some((issue) => issue.code === "CHANGE_ID_REUSED"));

    // A later change supersedes the first; replaying the first must not silently
    // undo it.
    await applyChange(database, validateChange(baseDocument({
      changeId: "ARCH-107-SUPERSEDES",
      operations: [matchupUpdate({ tier: "C" })]
    })), { decisions: DECISIONS });

    const replayed = await applyRejection(database, validateChange(baseDocument({
      changeId: "ARCH-107-STABLE-ID",
      operations: [matchupUpdate({ tier: "A" })]
    })));
    assert.equal(replayed.issues[0].code, "ALREADY_APPLIED_DIVERGED");
  });
});

// ─── one reversible authoring change ─────────────────────────────────────────

test("the example change is reversible and produces a valid development candidate", async () => {
  await withFreshDatabase(async (database) => {
    const baseline = await projectPayload(database, DECISIONS);

    await applyChange(database, readChangeFile(EXAMPLE), { decisions: DECISIONS });
    const revert = await applyChange(database, readChangeFile(EXAMPLE_REVERT), { decisions: DECISIONS });
    assert.equal(revert.writes.length, 3);

    // Retirement, never deletion: gac_authoring holds no DELETE grant and the
    // canonical model keeps the history.
    const retired = (await database.query(`
      select archetype.status as archetype_status, profile.status as profile_status,
             matchup.status as matchup_status, matchup.retired_reason
      from gac.team_archetypes archetype
      join gac.team_profiles profile on profile.archetype_id = archetype.archetype_id
      join gac.matchups matchup on matchup.counter_archetype_id = archetype.archetype_id
      where archetype.archetype_code = 'FO_HUX'
    `)).rows;
    assert.deepEqual(retired, [{
      archetype_status: "RETIRED",
      profile_status: "RETIRED",
      matchup_status: "RETIRED",
      retired_reason: "Reversing the ARCH-107 worked example."
    }]);

    const after = await projectPayload(database, DECISIONS);
    assert.equal(canonicalJson(after.counters), canonicalJson(baseline.counters),
      "the counter no longer appears anywhere a player would see it");

    // Known limitation, recorded in docs/database/ARCH-107.md: ARCH-106's
    // compatibility projection predates retirement and does not filter retired
    // attack profiles, so the retired identity still projects into
    // counterDefinitions. ARCH-108's generator owns that filter.
    assert.ok(Object.keys(after.counterDefinitions).includes("FO_HUX"));
    assert.equal(canonicalJson(after.characterDefinitions), canonicalJson(baseline.characterDefinitions));
    assert.equal(canonicalJson(after.boardConfig), canonicalJson(baseline.boardConfig));
    assert.equal(canonicalJson(after.scoring), canonicalJson(baseline.scoring));
    assert.equal(canonicalJson(after.defenceTeams), canonicalJson(baseline.defenceTeams));

    // Both changes are recorded with their own stable IDs, author and reason.
    const recorded = (await database.query(
      "select change_id, operation, status from gac.authoring_changes order by change_id"
    )).rows;
    assert.deepEqual(recorded.map((row) => row.change_id), [
      "ARCH-106-LEGACY-MIGRATION",
      "ARCH-107-EXAMPLE-COUNTER",
      "ARCH-107-EXAMPLE-COUNTER-REVERT"
    ]);
    assert.equal(recorded[2].operation, "retire");
  });
});

// ─── privilege and blast-radius boundaries ───────────────────────────────────

test("the loader refuses any statement that is not a data statement", () => {
  assert.deepEqual([...ALLOWED_VERBS].sort(), ["begin", "commit", "insert", "reset", "rollback", "select", "set", "update"]);
  assert.throws(() => assertAuthoringStatement("drop table gac.units"), /refuses a non-data statement: drop/);
  assert.throws(() => assertAuthoringStatement("grant all on gac.units to postgres"), /refuses a non-data statement: grant/);
  // Deletion is deliberately absent: the canonical model retires rows.
  assert.throws(() => assertAuthoringStatement("delete from gac.matchups"), /refuses a non-data statement: delete/);
  assert.equal(assertAuthoringStatement("update gac.units set active = false"), "update gac.units set active = false");
});

test("an apply leaves schema objects, permissions and the release lifecycle untouched", async () => {
  await withFreshDatabase(async (database) => {
    const snapshot = async () => ({
      tables: (await database.query("select table_name from information_schema.tables where table_schema = 'gac' order by table_name")).rows,
      constraints: (await database.query("select conname from pg_constraint where connamespace = 'gac'::regnamespace order by conname")).rows,
      policies: (await database.query("select tablename, policyname, cmd from pg_policies where schemaname = 'gac' order by tablename, policyname")).rows,
      grants: (await database.query("select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'gac' order by grantee, table_name, privilege_type")).rows,
      roles: (await database.query("select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'gac%' order by rolname")).rows,
      releases: (await database.query("select count(*)::int as total from gac.catalogue_releases")).rows,
      state: (await database.query("select current_release_id, publication_generation from gac.catalogue_state where singleton_id")).rows
    });

    const before = await snapshot();
    await applyChange(database, readChangeFile(EXAMPLE), { decisions: DECISIONS });
    assert.deepEqual(await snapshot(), before);
  });
});

test("a change the database rejects rolls the whole transaction back", async () => {
  await withFreshDatabase(async (database) => {
    const before = await canonicalSnapshot(database);
    // A repeated sort_order passes the change-file checks but violates
    // team_profile_members_profile_sort_unique, so the database refuses it. The
    // change also creates an archetype, which must not survive the rollback.
    const change = validateChange(baseDocument({
      changeId: "ARCH-107-DUPLICATE-SORT-ORDER",
      operations: [
        {
          entity: "archetype",
          operation: "create",
          archetypeCode: "ARCH107_ROLLBACK",
          displayName: "Rollback Probe",
          battleType: "SQUAD",
          identityReason: "NEW_GAME_ARCHETYPE"
        },
        {
          entity: "member",
          operation: "create",
          archetypeCode: "GAS",
          mode: "ANY",
          usageRole: "ATTACK",
          unitId: "GENERAL_HUX",
          memberRole: "REQUIRED",
          isLeader: false,
          sortOrder: 0
        }
      ]
    }));
    await assert.rejects(() => applyChange(database, change, { decisions: DECISIONS }));
    assert.equal(canonicalJson(await canonicalSnapshot(database)), canonicalJson(before));
  });
});

// ─── diff helper ─────────────────────────────────────────────────────────────

test("the canonical diff reports inserts, updates and removals column by column", () => {
  const before = { units: { A: { unit_id: "A", display_name: "One", active: true } } };
  const after = {
    units: {
      A: { unit_id: "A", display_name: "Two", active: true },
      B: { unit_id: "B", display_name: "New", active: true }
    }
  };
  assert.deepEqual(canonicalDiff(before, after), [
    {
      table: "units",
      key: "A",
      operation: "UPDATE",
      before: { display_name: "One" },
      after: { display_name: "Two" },
      columns: ["display_name"]
    },
    {
      table: "units",
      key: "B",
      operation: "INSERT",
      before: null,
      after: { unit_id: "B", display_name: "New", active: true },
      columns: ["active", "display_name", "unit_id"]
    }
  ]);
  assert.equal(canonicalDiff(after, before).filter((entry) => entry.operation === "DELETE").length, 1);
});
