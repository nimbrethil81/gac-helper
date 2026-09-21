#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalJson } = require("./baseline-lib.js");
const { CloudflareDeployment, DirectoryStaticDeployment, buildPublicDirectory, verifyDeploymentAdapter, verifyHttpRelease } = require("./catalogue-artifacts.js");
const { connectPostgres } = require("./catalogue-database.js");
const { generatePayload, validatePayload } = require("./catalogue-lib.js");
const { finaliseRelease, prepareRelease, readRelease, readState, reconcilePublication, rollbackRelease } = require("./catalogue-publisher-lib.js");
const { openAuthoringDatabase } = require("./authoring-load.js");

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { result._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fullSha(value, name) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${name} must be a full lowercase 40-character commit SHA`);
  return value;
}

function releaseShape(row) {
  return { ...row, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload };
}

async function listArtifacts(database) {
  const rows = (await database.query(`
    select release_id, version, payload_schema_version, status, payload, checksum
    from gac.catalogue_releases
    where status <> 'REJECTED'
    order by version
  `)).rows;
  return rows.map(releaseShape);
}

function secretValues() {
  return [process.env.SUPABASE_PUBLISHER_DATABASE_URL, process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID].filter(Boolean);
}

async function stage(database, release) {
  const destinationRoot = path.resolve("dist", "public");
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  const files = buildPublicDirectory({
    sourceRoot: process.cwd(),
    destinationRoot,
    releases: await listArtifacts(database),
    currentReleaseId: release.release_id
  });
  return { destinationRoot, files };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command) throw new Error("Command required: generate | validate | prepare | stage | deploy | verify | finalise | reconcile | rollback | publish");

  if (command === "validate") {
    const filename = path.resolve(required(args.file, "--file"));
    const payload = JSON.parse(fs.readFileSync(filename, "utf8"));
    const result = validatePayload(payload, { forbiddenValues: secretValues() });
    process.stdout.write(`${canonicalJson(result)}\n`);
    return;
  }

  const simulated = args.simulate === true;
  if (simulated && args.dataDir) fs.mkdirSync(path.dirname(path.resolve(args.dataDir)), { recursive: true });
  const database = simulated
    ? await openAuthoringDatabase({ dataDir: args.dataDir ?? null })
    : connectPostgres(process.env.SUPABASE_PUBLISHER_DATABASE_URL);
  try {
    const state = await readState(database);
    const sourceCommitSha = fullSha(args.commit ?? process.env.GITHUB_SHA, "--commit/GITHUB_SHA");
    const reason = args.reason ?? "AUTHORING";
    const changeIds = String(args.changeIds ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const expectedBaseReleaseId = args.base === undefined
      ? state.current_release_id
      : (args.base === "none" ? null : args.base);

    if (command === "generate") {
      const version = Number((await database.query("select coalesce(max(version), 0)::bigint + 1 as version from gac.catalogue_releases")).rows[0].version);
      const payload = await generatePayload(database, {
        version, baseReleaseId: expectedBaseReleaseId, releaseReason: reason,
        generatedAt: new Date().toISOString(), sourceCommitSha, authoringChangeIds: changeIds
      });
      validatePayload(payload, { forbiddenValues: secretValues() });
      process.stdout.write(`${canonicalJson(payload)}\n`);
      return;
    }

    if (command === "prepare" || command === "publish") {
      const prepared = await prepareRelease(database, {
        expectedBaseReleaseId, releaseReason: reason, sourceCommitSha,
        authoringChangeIds: changeIds, provenanceReference: args.reference,
        validation: { forbiddenValues: secretValues() }
      });
      if (command === "prepare") { process.stdout.write(`${canonicalJson(prepared)}\n`); return; }
      args.releaseId = String(prepared.release_id);
    }

    if (command === "reconcile") {
      const deployment = simulated
        ? new DirectoryStaticDeployment(path.resolve("dist", "public"))
        : new CloudflareDeployment({ workerName: process.env.CLOUDFLARE_PRODUCTION_WORKER_NAME });
      const baseUrl = simulated ? null : required(process.env.CATALOGUE_PRODUCTION_BASE_URL, "CATALOGUE_PRODUCTION_BASE_URL");
      const liveDeployment = simulated ? deployment : {
        async readPointer() {
          const response = await fetch(`${baseUrl.replace(/\/$/, "")}/catalogue/current.json`, { cache: "no-store" });
          if (!response.ok) throw new Error(`Pointer HTTP ${response.status}`);
          return response.json();
        },
        deploy: (target) => deployment.deploy(target)
      };
      const result = await reconcilePublication(database, {
        deployment: liveDeployment,
        verify: (target) => simulated ? verifyDeploymentAdapter(deployment, target) : verifyHttpRelease(baseUrl, target),
        deployedCommitSha: sourceCommitSha
      });
      process.stdout.write(`${canonicalJson(result)}\n`);
      return;
    }

    const release = await readRelease(database, required(args.releaseId, "--release-id"));
    if (command === "stage") {
      process.stdout.write(`${canonicalJson(await stage(database, release))}\n`);
      return;
    }

    if (command === "finalise") {
      const result = await finaliseRelease(database, {
        releaseId: release.release_id,
        deployedCommitSha: sourceCommitSha,
        deploymentId: required(args.deploymentId, "--deployment-id")
      });
      process.stdout.write(`${canonicalJson(result)}\n`);
      return;
    }

    const deployment = simulated
      ? new DirectoryStaticDeployment(path.resolve("dist", "public"))
      : new CloudflareDeployment({ workerName: process.env.CLOUDFLARE_PRODUCTION_WORKER_NAME });
    const baseUrl = simulated ? null : required(process.env.CATALOGUE_PRODUCTION_BASE_URL, "CATALOGUE_PRODUCTION_BASE_URL");
    const verify = (target) => simulated ? verifyDeploymentAdapter(deployment, target) : verifyHttpRelease(baseUrl, target);

    if (["deploy", "publish", "rollback"].includes(command)) await stage(database, release);
    if (command === "deploy") {
      process.stdout.write(`${canonicalJson(await deployment.deploy(release))}\n`);
      return;
    }
    if (command === "verify") {
      process.stdout.write(`${canonicalJson(await verify(release))}\n`);
      return;
    }
    if (command === "rollback") {
      if (Number(release.payload_schema_version) !== 1) throw new Error("Rollback target payload schema is incompatible");
      const deployed = await deployment.deploy(release);
      await verify(release);
      const result = await rollbackRelease(database, {
        targetReleaseId: release.release_id,
        deploymentId: deployed.deploymentId,
        deployedCommitSha: sourceCommitSha,
        verifiedChecksum: release.checksum
      });
      process.stdout.write(`${canonicalJson(result)}\n`);
      return;
    }
    if (command === "publish") {
      const deployed = await deployment.deploy(release);
      await verify(release);
      const result = await finaliseRelease(database, {
        releaseId: release.release_id, deployedCommitSha: sourceCommitSha, deploymentId: deployed.deploymentId
      });
      process.stdout.write(`${canonicalJson(result)}\n`);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
