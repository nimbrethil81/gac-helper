"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readChangeFile, validateChange } = require("../scripts/authoring-lib.js");
const { applyChange, openAuthoringDatabase } = require("../scripts/authoring-load.js");
const { LocalStaticDeployment, PUBLIC_FILES, buildPublicDirectory, verifyDeploymentAdapter, verifyHttpRelease } = require("../scripts/catalogue-artifacts.js");
const { CatalogueValidationError, checksumFor, generatePayload, validatePayload } = require("../scripts/catalogue-lib.js");
const {
  PublicationError, finaliseRelease, prepareRelease, readRelease, readState,
  reconcilePublication, rollbackRelease
} = require("../scripts/catalogue-publisher-lib.js");
const { readSources } = require("../scripts/migration-lib.js");

const SHA = "2073d6502cf8260c19ccb9318e327fd7fbf88d23";
const EXAMPLE = path.join("data", "authoring", "arch-107-example-counter.change.json");
const EXAMPLE_REVERT = path.join("data", "authoring", "arch-107-example-counter-revert.change.json");
const RECONCILIATION = JSON.parse(fs.readFileSync(path.join("data", "migration", "arch-106-reconciliation.json"), "utf8"));

async function status(database, releaseId) {
  return (await database.query("select status from gac.catalogue_releases where release_id = $1", [releaseId])).rows[0].status;
}

test("payload v1 has golden parity, exact public compatibility, checksum, and fail-closed validation", async () => {
  const database = await openAuthoringDatabase();
  try {
    const payload = await generatePayload(database, {
      version: 1,
      releaseReason: "MIGRATION",
      generatedAt: "2026-09-21T16:00:00.000Z",
      sourceCommitSha: SHA
    });
    const result = validatePayload(payload, {
      goldenPayload: readSources().goldenPayload,
      reconciliation: RECONCILIATION
    });
    assert.equal(result.checksum, payload.checksum);
    assert.deepEqual(payload.units, payload.characterDefinitions);
    assert.deepEqual(Object.keys(payload.counters).sort(), ["3v3", "5v5", "FLEET"]);
    const counteredDefences = new Set(Object.values(payload.counters).flatMap((teams) => Object.keys(teams)));
    assert.ok(Object.values(payload.defenceTeams).flatMap((teams) => Object.keys(teams)).some((name) => !counteredDefences.has(name)), "a valid zero-counter defence remains published");

    const removedStableId = structuredClone(payload);
    delete removedStableId.counterDefinitions[Object.keys(removedStableId.counterDefinitions)[0]];
    removedStableId.checksum = checksumFor(removedStableId);
    assert.throws(() => validatePayload(removedStableId, { basePayload: payload }), (error) => error.issues.some((issue) => issue.code === "COUNTER_ID_REMOVED"));

    const tampered = structuredClone(payload);
    tampered.counters["5v5"][Object.keys(tampered.counters["5v5"])[0]][0].notes = "tampered";
    assert.throws(() => validatePayload(tampered), (error) => error instanceof CatalogueValidationError && error.issues.some((issue) => issue.code === "CHECKSUM_MISMATCH"));

    const secret = structuredClone(payload);
    secret.provenance.apiToken = "definitely-not-public";
    secret.checksum = checksumFor(secret);
    assert.throws(() => validatePayload(secret), (error) => error.issues.some((issue) => issue.code === "TOP_LEVEL_KEYS" || issue.code === "SENSITIVE_KEY"));
  } finally {
    await database.close();
  }
});

test("READY/DEPLOYED publication, ARCH-107 integration, failure recovery, retention and rollback", async () => {
  const database = await openAuthoringDatabase();
  const deployment = new LocalStaticDeployment();
  try {
    const noRelease = await database.query("select count(*)::int as total from gac.catalogue_releases");
    await assert.rejects(() => prepareRelease(database, {
      expectedBaseReleaseId: null,
      releaseReason: "MIGRATION",
      sourceCommitSha: SHA,
      validation: { forbiddenValues: ["Admiral Raddus"] }
    }), CatalogueValidationError);
    assert.equal((await database.query("select count(*)::int as total from gac.catalogue_releases")).rows[0].total, noRelease.rows[0].total);

    const first = await prepareRelease(database, {
      expectedBaseReleaseId: null,
      releaseReason: "MIGRATION",
      sourceCommitSha: SHA,
      generatedAt: "2026-09-21T16:01:00.000Z",
      validation: { goldenPayload: readSources().goldenPayload, reconciliation: RECONCILIATION }
    });
    assert.equal(first.version, 1);
    assert.equal(first.status, "READY");
    assert.equal((await readState(database)).current_release_id, null);
    const firstDeployment = await deployment.deploy(await readRelease(database, first.release_id));
    assert.deepEqual(await deployment.deploy(await readRelease(database, first.release_id)), firstDeployment, "deployment is idempotent");
    await verifyDeploymentAdapter(deployment, await readRelease(database, first.release_id));
    await finaliseRelease(database, { releaseId: first.release_id, deployedCommitSha: SHA, deploymentId: firstDeployment.deploymentId });
    assert.equal(String((await readState(database)).current_release_id), String(first.release_id));

    await assert.rejects(() => prepareRelease(database, {
      expectedBaseReleaseId: null, releaseReason: "MIGRATION", sourceCommitSha: SHA
    }), (error) => error instanceof PublicationError && error.code === "STALE_BASE");

    const example = readChangeFile(EXAMPLE);
    example.expected_base_release = 1;
    const applied = await applyChange(database, example);
    assert.equal(applied.committed, true);
    const replay = await applyChange(database, example);
    assert.equal(replay.writes.length, 0);

    const second = await prepareRelease(database, {
      expectedBaseReleaseId: first.release_id,
      releaseReason: "AUTHORING",
      authoringChangeIds: [example.change_id],
      provenanceReference: example.change_id,
      sourceCommitSha: SHA,
      generatedAt: "2026-09-21T16:02:00.000Z"
    });
    assert.equal(second.version, 2);
    assert.ok(second.payload.counterDefinitions.FO_HUX);
    assert.ok(second.payload.counters["5v5"]["Admiral Raddus"].some((entry) => entry.counterId === "FO_HUX"));
    assert.equal((await database.query("select count(*)::int as total from gac.catalogue_release_authoring_changes where release_id = $1 and change_id = $2", [second.release_id, example.change_id])).rows[0].total, 1);

    deployment.failDeployment = true;
    await assert.rejects(async () => deployment.deploy(await readRelease(database, second.release_id)), /simulated deployment failure/);
    assert.equal(await status(database, second.release_id), "READY");
    deployment.failDeployment = false;

    const secondRelease = await readRelease(database, second.release_id);
    const secondDeployment = await deployment.deploy(secondRelease);
    const simulatedFetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith("current.json") ? await deployment.readPointer() : await deployment.readArtifact(deployment.pointer.artifact)
    });
    deployment.pointer.checksum = "sha256:" + "0".repeat(64);
    await assert.rejects(() => verifyHttpRelease("https://catalogue.invalid", secondRelease, { fetchImpl: simulatedFetch }), /Pointer checksum/);
    assert.equal(await status(database, second.release_id), "READY");
    deployment.pointer.checksum = secondRelease.checksum;
    await verifyHttpRelease("https://catalogue.invalid", secondRelease, { fetchImpl: simulatedFetch });

    await assert.rejects(() => finaliseRelease(database, {
      releaseId: second.release_id,
      deployedCommitSha: SHA,
      deploymentId: secondDeployment.deploymentId,
      beforePointerUpdate: () => { throw new Error("simulated finalisation failure"); }
    }), /simulated finalisation failure/);
    assert.equal(await status(database, second.release_id), "READY");
    assert.equal(String((await readState(database)).current_release_id), String(first.release_id));

    const reconciled = await reconcilePublication(database, {
      deployment,
      verify: (release) => verifyDeploymentAdapter(deployment, release),
      deployedCommitSha: SHA
    });
    assert.equal(reconciled.action, "finalised");
    assert.equal(String((await readState(database)).current_release_id), String(second.release_id));
    assert.equal((await reconcilePublication(database, {
      deployment,
      verify: (release) => verifyDeploymentAdapter(deployment, release),
      deployedCommitSha: SHA
    })).action, "already-consistent");

    const revert = readChangeFile(EXAMPLE_REVERT);
    revert.expected_base_release = 2;
    await applyChange(database, revert);
    const third = await prepareRelease(database, {
      expectedBaseReleaseId: second.release_id,
      releaseReason: "AUTHORING",
      authoringChangeIds: [revert.change_id],
      provenanceReference: revert.change_id,
      sourceCommitSha: SHA,
      generatedAt: "2026-09-21T16:03:00.000Z"
    });
    assert.equal(third.version, 3);
    assert.ok(!third.payload.counterDefinitions.FO_HUX);
    assert.ok(!Object.values(third.payload.counters).some((teams) => Object.values(teams).flat().some((entry) => entry.counterId === "FO_HUX")));

    await deployment.deploy(await readRelease(database, first.release_id));
    await verifyDeploymentAdapter(deployment, await readRelease(database, first.release_id));
    await assert.rejects(() => rollbackRelease(database, {
      targetReleaseId: first.release_id,
      deploymentId: "local-rollback",
      deployedCommitSha: SHA,
      verifiedChecksum: first.checksum,
      currentPayloadSchemaVersion: 2
    }), (error) => error.code === "INCOMPATIBLE_SCHEMA");
    const rolledBack = await rollbackRelease(database, {
      targetReleaseId: first.release_id,
      deploymentId: "local-rollback",
      deployedCommitSha: SHA,
      verifiedChecksum: first.checksum
    });
    assert.equal(rolledBack.action, "rolled-back");
    assert.equal((await rollbackRelease(database, {
      targetReleaseId: first.release_id,
      deploymentId: "local-rollback",
      deployedCommitSha: SHA,
      verifiedChecksum: first.checksum
    })).action, "already-current");
    assert.ok(await deployment.readArtifact(`catalogue/v${first.version}.json`));
    assert.ok(await deployment.readArtifact(`catalogue/v${second.version}.json`), "previous artifacts are retained");
  } finally {
    await database.close();
  }
});

test("member and defence-value retire/reactivate paths are idempotent and filtered", async () => {
  const database = await openAuthoringDatabase();
  try {
    const member = (await database.query(`
      select a.archetype_code, p.mode, p.usage_role, m.unit_id
      from gac.team_profile_members m
      join gac.team_profiles p on p.profile_id = m.profile_id
      join gac.team_archetypes a on a.archetype_id = p.archetype_id
      where m.status = 'ACTIVE' and not m.is_leader
      order by m.profile_id, m.sort_order limit 1
    `)).rows[0];
    const defence = (await database.query(`
      select a.archetype_code, a.display_name, v.mode
      from gac.defence_catalogue_values v
      join gac.team_archetypes a on a.archetype_id = v.archetype_id
      where v.status = 'ACTIVE' order by a.archetype_code, v.mode limit 1
    `)).rows[0];
    const mode = (value) => ({ "3V3": "3v3", "5V5": "5v5", ANY: "ANY", FLEET: "FLEET" })[value];
    const retire = validateChange({
      schemaVersion: 1, changeId: "ARCH-108-LIFECYCLE-RETIRE", author: "test", authorRole: "OWNER",
      authoredAt: "2026-09-21T16:04:00Z", reason: "Exercise additive child lifecycle.", expectedBaseRelease: null,
      operations: [
        { entity: "member", operation: "retire", archetypeCode: member.archetype_code, mode: mode(member.mode), usageRole: member.usage_role, unitId: member.unit_id, retiredReason: "Lifecycle test." },
        { entity: "defenceValues", operation: "retire", archetypeCode: defence.archetype_code, mode: mode(defence.mode), retiredReason: "Lifecycle test." }
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

test("public staging is allow-listed and the production workflow is manual-only with concurrency", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "arch108-source-"));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "arch108-public-"));
  try {
    fs.writeFileSync(path.join(source, "index.html"), "public");
    fs.writeFileSync(path.join(source, "private.env"), "SECRET=must-not-copy");
    assert.deepEqual(buildPublicDirectory({ sourceRoot: source, destinationRoot: destination }), ["index.html"]);
    assert.equal(fs.existsSync(path.join(destination, "private.env")), false);
    assert.ok(PUBLIC_FILES.includes("index.html"));

    const workflow = fs.readFileSync(path.join(".github", "workflows", "publish-catalogue.yml"), "utf8");
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
    assert.match(workflow, /group: gac-helper-production-publish/);
    assert.match(workflow, /cancel-in-progress: false/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
