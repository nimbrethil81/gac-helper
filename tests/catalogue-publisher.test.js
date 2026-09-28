"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTestDatabase, loadBaseline } = require("./migration-fixture.js");
const { validateChange } = require("../scripts/authoring-lib.js");
const { applyChange } = require("../scripts/authoring-load.js");
const {
  PAYLOAD_SCHEMA_VERSION,
  checksumFor,
  generatePayload,
  validatePayload
} = require("../scripts/catalogue-lib.js");
const {
  PUBLIC_FILES,
  DirectoryStaticDeployment,
  LocalStaticDeployment,
  buildPublicDirectory,
  verifyDeploymentAdapter
} = require("../scripts/catalogue-artifacts.js");
const {
  PublicationError,
  finaliseRelease,
  prepareRelease,
  readRelease,
  readState,
  reconcilePublication,
  rollbackRelease
} = require("../scripts/catalogue-publisher-lib.js");

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function baselineDatabase() {
  const database = await createTestDatabase();
  await loadBaseline(database);
  return database;
}

function mode(value) {
  return value === "Any" ? "ANY" : value;
}

async function firstMember(database) {
  return (await database.query(`
    select p.archetype_code, p.mode, pm.usage_role, pm.unit_id
    from gac.team_profile_members pm
    join gac.team_profiles p on p.profile_id = pm.profile_id
    order by p.archetype_code, p.mode, pm.position
    limit 1
  `)).rows[0];
}

async function firstDefenceValue(database) {
  return (await database.query(`
    select dcv.archetype_code, dcv.mode, ta.display_name
    from gac.defence_catalogue_values dcv
    join gac.team_archetypes ta on ta.archetype_code = dcv.archetype_code
    order by dcv.archetype_code, dcv.mode
    limit 1
  `)).rows[0];
}

test("generated catalogue matches the payload contract and checksum", async () => {
  const database = await baselineDatabase();
  try {
    const payload = await generatePayload(database, {
      version: 1,
      releaseReason: "MIGRATION",
      generatedAt: "2026-09-21T15:00:00Z",
      sourceCommitSha: SHA
    });
    validatePayload(payload);
    assert.equal(payload.payloadSchemaVersion, PAYLOAD_SCHEMA_VERSION);
    assert.equal(payload.catalogueVersion, 1);
    assert.equal(payload.releaseReason, "MIGRATION");
    assert.equal(payload.checksum, checksumFor(payload));
  } finally {
    await database.close();
  }
});

test("prepare/finalise is atomic, base-checked and idempotent", async () => {
  const database = await baselineDatabase();
  try {
    const release = await prepareRelease(database, {
      expectedBaseReleaseId: null,
      releaseReason: "MIGRATION",
      sourceCommitSha: SHA,
      generatedAt: "2026-09-21T15:05:00Z"
    });
    assert.equal(release.status, "READY");
    assert.equal((await readState(database)).current_release_id, null);

    await assert.rejects(
      prepareRelease(database, { expectedBaseReleaseId: "999", releaseReason: "MIGRATION", sourceCommitSha: SHA }),
      (error) => error instanceof PublicationError && error.code === "STALE_BASE"
    );

    const finalised = await finaliseRelease(database, {
      releaseId: release.release_id,
      deployedCommitSha: SHA,
      deploymentId: "deployment-1",
      publishedAt: "2026-09-21T15:06:00Z"
    });
    assert.equal(finalised.action, "finalised");
    assert.equal(String((await readState(database)).current_release_id), String(release.release_id));
    assert.equal((await readRelease(database, release.release_id)).status, "DEPLOYED");

    const replay = await finaliseRelease(database, {
      releaseId: release.release_id,
      deployedCommitSha: SHA,
      deploymentId: "deployment-1"
    });
    assert.equal(replay.action, "already-finalised");
  } finally {
    await database.close();
  }
});

test("failed publication before the pointer update leaves the old release current", async () => {
  const database = await baselineDatabase();
  try {
    const first = await prepareRelease(database, { expectedBaseReleaseId: null, releaseReason: "MIGRATION", sourceCommitSha: SHA });
    await finaliseRelease(database, { releaseId: first.release_id, deployedCommitSha: SHA, deploymentId: "deployment-1" });
    const second = await prepareRelease(database, { expectedBaseReleaseId: first.release_id, releaseReason: "MAINTENANCE", sourceCommitSha: SHA });

    await assert.rejects(
      finaliseRelease(database, {
        releaseId: second.release_id,
        deployedCommitSha: SHA,
        deploymentId: "deployment-2",
        beforePointerUpdate: () => { throw new Error("simulated pointer failure"); }
      }),
      /simulated pointer failure/
    );
    assert.equal(String((await readState(database)).current_release_id), String(first.release_id));
    assert.equal((await readRelease(database, first.release_id)).status, "DEPLOYED");
    assert.equal((await readRelease(database, second.release_id)).status, "READY");
  } finally {
    await database.close();
  }
});

test("reconciliation finalises a deployed READY release or restores the current release", async () => {
  const database = await baselineDatabase();
  try {
    const deployment = new LocalStaticDeployment();
    const first = await prepareRelease(database, { expectedBaseReleaseId: null, releaseReason: "MIGRATION", sourceCommitSha: SHA });
    await deployment.deploy(first);
    const reconciled = await reconcilePublication(database, {
      deployment,
      verify: (release) => verifyDeploymentAdapter(deployment, release),
      deployedCommitSha: SHA
    });
    assert.equal(reconciled.action, "finalised");

    deployment.pointer = null;
    deployment.artifacts.clear();
    const restored = await reconcilePublication(database, {
      deployment,
      verify: (release) => verifyDeploymentAdapter(deployment, release),
      deployedCommitSha: SHA
    });
    assert.equal(restored.action, "restored-current");
  } finally {
    await database.close();
  }
});

test("rollback requires a compatible verified retained release", async () => {
  const database = await baselineDatabase();
  try {
    const first = await prepareRelease(database, { expectedBaseReleaseId: null, releaseReason: "MIGRATION", sourceCommitSha: SHA });
    await finaliseRelease(database, { releaseId: first.release_id, deployedCommitSha: SHA, deploymentId: "deployment-1" });
    const second = await prepareRelease(database, { expectedBaseReleaseId: first.release_id, releaseReason: "MAINTENANCE", sourceCommitSha: SHA });
    await finaliseRelease(database, { releaseId: second.release_id, deployedCommitSha: SHA, deploymentId: "deployment-2" });

    const firstStored = await readRelease(database, first.release_id);
    await assert.rejects(
      rollbackRelease(database, {
        targetReleaseId: first.release_id,
        deploymentId: "rollback",
        deployedCommitSha: SHA,
        verifiedChecksum: "bad"
      }),
      (error) => error instanceof PublicationError && error.code === "CHECKSUM_MISMATCH"
    );

    const rolled = await rollbackRelease(database, {
      targetReleaseId: first.release_id,
      deploymentId: "rollback",
      deployedCommitSha: SHA,
      verifiedChecksum: firstStored.checksum
    });
    assert.equal(rolled.action, "rolled-back");
    assert.equal(String((await readState(database)).current_release_id), String(first.release_id));
  } finally {
    await database.close();
  }
});

test("retirement lifecycle removes additive children and supports idempotent reactivation", async () => {
  const database = await baselineDatabase();
  try {
    const member = await firstMember(database);
    const defence = await firstDefenceValue(database);
    const retire = validateChange({
      schemaVersion: 1, changeId: "ARCH-108-LIFECYCLE-RETIRE", author: "test", authorRole: "OWNER",
      authoredAt: "2026-09-21T16:00:00Z", reason: "Exercise additive child lifecycle.", expectedBaseRelease: null,
      operations: [
        { entity: "member", operation: "retire", archetypeCode: member.archetype_code, mode: mode(member.mode), usageRole: member.usage_role, unitId: member.unit_id },
        { entity: "defenceValues", operation: "retire", archetypeCode: defence.archetype_code, mode: mode(defence.mode) }
      ]
    });
    await applyChange(database, retire);
    assert.equal((await applyChange(database, retire)).writes.length, 0);

    const payload = await generatePayload(database, { version: 1, releaseReason: "AUTHORING", generatedAt: "2026-09-21T16:05:00Z", sourceCommitSha: SHA, authoringChangeIds: [retire.change_id] });
    const definition = payload.counterDefinitions[member.archetype_code];
    if (definition) assert.ok(![...definition.required, ...definition.recommended].includes(member.unit_id));
    const publicMode = mode(defence.mode) === "ANY" ? "Any" : mode(defence.mode);
    assert.ok(!payload.defenceTeams[publicMode]?.[defence.display_name]);

    const reactivate = validateChange({
      schemaVersion: 1, changeId: "ARCH-108-LIFECYCLE-REACTIVATE", author: "test", authorRole: "OWNER",
      authoredAt: "2026-09-21T16:06:00Z", reason: "Restore additive child lifecycle.", expectedBaseRelease: null,
      operations: [
        { entity: "member", operation: "reactivate", archetypeCode: member.archetype_code, mode: mode(member.mode), usageRole: member.usage_role, unitId: member.unit_id },
        { entity: "defenceValues", operation: "reactivate", archetypeCode: defence.archetype_code, mode: mode(defence.mode) }
      ]
    });
    await applyChange(database, reactivate);
    assert.equal((await applyChange(database, reactivate)).writes.length, 0);
  } finally {
    await database.close();
  }
});

test("public staging is allow-listed", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "arch108-source-"));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "arch108-public-"));
  try {
    fs.writeFileSync(path.join(source, "index.html"), "public");
    fs.writeFileSync(path.join(source, "private.env"), "SECRET=must-not-copy");
    assert.deepEqual(buildPublicDirectory({ sourceRoot: source, destinationRoot: destination }), ["index.html"]);
    assert.equal(fs.existsSync(path.join(destination, "private.env")), false);
    assert.ok(PUBLIC_FILES.includes("index.html"));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
