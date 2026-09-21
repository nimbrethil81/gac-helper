"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { canonicalJson } = require("./baseline-lib.js");
const { PAYLOAD_SCHEMA_VERSION, checksumFor, validatePayload } = require("./catalogue-lib.js");

const PUBLIC_FILES = Object.freeze([
  "index.html", "app.js", "styles.css", "manifest.json", "service-worker.js",
  "icon-192.png", "icon-512.png", "README.md", "changelog.md"
]);

function pointerFor(release) {
  return {
    payloadSchemaVersion: Number(release.payload_schema_version ?? release.payload.payloadSchemaVersion),
    catalogueVersion: Number(release.version ?? release.payload.catalogueVersion),
    checksum: release.checksum,
    artifact: `catalogue/v${Number(release.version ?? release.payload.catalogueVersion)}.json`
  };
}

function jsonBytes(value) {
  return `${canonicalJson(value)}\n`;
}

function writeImmutable(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (fs.existsSync(filename)) {
    if (fs.readFileSync(filename, "utf8") !== contents) throw new Error(`Immutable artifact differs: ${filename}`);
    return false;
  }
  fs.writeFileSync(filename, contents, { flag: "wx", mode: 0o644 });
  return true;
}

function writePointerAtomic(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o644 });
  fs.renameSync(temporary, filename);
}

function stageRelease(stagingRoot, release, { movePointer = true } = {}) {
  const payload = release.payload;
  validatePayload(payload);
  if (checksumFor(payload) !== release.checksum) throw new Error("Release checksum does not match its payload");
  const catalogueRoot = path.join(stagingRoot, "catalogue");
  const artifactPath = path.join(catalogueRoot, `v${Number(release.version)}.json`);
  writeImmutable(artifactPath, jsonBytes(payload));
  if (movePointer) writePointerAtomic(path.join(catalogueRoot, "current.json"), jsonBytes(pointerFor(release)));
  return { artifactPath, pointerPath: path.join(catalogueRoot, "current.json"), pointer: pointerFor(release) };
}

function buildPublicDirectory({ sourceRoot, destinationRoot, releases = [], currentReleaseId = null }) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  const copied = [];
  for (const relative of PUBLIC_FILES) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push(relative);
  }
  for (const release of releases.sort((a, b) => Number(a.version) - Number(b.version))) {
    stageRelease(destinationRoot, release, { movePointer: String(release.release_id) === String(currentReleaseId) });
    copied.push(`catalogue/v${Number(release.version)}.json`);
  }
  if (currentReleaseId !== null) copied.push("catalogue/current.json");
  return copied.sort();
}

class LocalStaticDeployment {
  constructor() {
    this.artifacts = new Map();
    this.pointer = null;
    this.deployments = new Map();
    this.failDeployment = false;
  }

  async deploy(release) {
    if (this.failDeployment) throw new Error("simulated deployment failure");
    const key = `${Number(release.version)}:${release.checksum}`;
    if (this.deployments.has(key)) {
      const existing = this.deployments.get(key);
      this.artifacts.set(existing.artifact, JSON.parse(JSON.stringify(release.payload)));
      this.pointer = { ...existing };
      return existing;
    }
    const deployment = { deploymentId: `local-${this.deployments.size + 1}`, ...pointerFor(release) };
    this.artifacts.set(deployment.artifact, JSON.parse(JSON.stringify(release.payload)));
    this.pointer = { ...deployment };
    this.deployments.set(key, deployment);
    return deployment;
  }

  async readPointer() {
    return this.pointer === null ? null : JSON.parse(JSON.stringify(this.pointer));
  }

  async readArtifact(name) {
    const artifact = this.artifacts.get(name);
    return artifact === undefined ? null : JSON.parse(JSON.stringify(artifact));
  }
}

class DirectoryStaticDeployment {
  constructor(root) { this.root = path.resolve(root); }

  async deploy(release) {
    stageRelease(this.root, release);
    return { deploymentId: `simulated-v${Number(release.version)}-${release.checksum.slice(-12)}`, ...pointerFor(release) };
  }

  async readPointer() {
    const filename = path.join(this.root, "catalogue", "current.json");
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : null;
  }

  async readArtifact(name) {
    const filename = path.resolve(this.root, name);
    if (!filename.startsWith(`${this.root}${path.sep}`) || !fs.existsSync(filename)) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  }
}

function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

class CloudflareDeployment {
  constructor({ workerName, cwd = process.cwd(), runner = runCommand }) {
    if (!workerName) throw new Error("CLOUDFLARE_PRODUCTION_WORKER_NAME is required");
    this.workerName = workerName;
    this.cwd = cwd;
    this.runner = runner;
  }

  async deploy(release) {
    const tag = `catalogue-v${Number(release.version)}-${release.checksum.slice(-12)}`;
    await this.runner("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc", "--name", this.workerName, "--tag", tag, "--message", tag], { cwd: this.cwd });
    const listed = await this.runner("npx", ["wrangler", "deployments", "list", "--config", "wrangler.jsonc", "--name", this.workerName, "--json"], { cwd: this.cwd });
    const deployments = JSON.parse(listed.stdout);
    const deploymentId = deployments?.[0]?.id ?? deployments?.[0]?.deployment_id;
    if (!deploymentId) throw new Error("Wrangler did not return a deployment identifier");
    return { deploymentId, ...pointerFor(release) };
  }
}

async function verifyHttpRelease(baseUrl, release, { fetchImpl = globalThis.fetch } = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const pointerResponse = await fetchImpl(`${root}/catalogue/current.json`, { cache: "no-store" });
  if (!pointerResponse.ok) throw new Error(`Pointer HTTP ${pointerResponse.status}`);
  const pointer = await pointerResponse.json();
  if (Number(pointer.payloadSchemaVersion) !== PAYLOAD_SCHEMA_VERSION) throw new Error("Pointer payload schema version mismatch");
  if (Number(pointer.catalogueVersion) !== Number(release.version)) throw new Error("Pointer catalogue version mismatch");
  if (pointer.checksum !== release.checksum) throw new Error("Pointer checksum mismatch");
  if (pointer.artifact !== `catalogue/v${Number(release.version)}.json`) throw new Error("Pointer artifact path mismatch");

  const artifactResponse = await fetchImpl(`${root}/${pointer.artifact}`, { cache: "no-store" });
  if (!artifactResponse.ok) throw new Error(`Artifact HTTP ${artifactResponse.status}`);
  const payload = await artifactResponse.json();
  validatePayload(payload);
  if (payload.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) throw new Error("Artifact payload schema version mismatch");
  if (payload.catalogueVersion !== Number(release.version)) throw new Error("Artifact catalogue version mismatch");
  if (payload.checksum !== release.checksum || checksumFor(payload) !== release.checksum) throw new Error("Artifact checksum mismatch");
  return { pointer, payload };
}

async function verifyDeploymentAdapter(deployment, release) {
  const pointer = await deployment.readPointer();
  if (!pointer) throw new Error("No deployed pointer");
  if (Number(pointer.payloadSchemaVersion) !== PAYLOAD_SCHEMA_VERSION || Number(pointer.catalogueVersion) !== Number(release.version) || pointer.checksum !== release.checksum) {
    throw new Error("Deployed pointer does not match the READY release");
  }
  const payload = await deployment.readArtifact(pointer.artifact);
  if (!payload) throw new Error("Deployed artifact is absent");
  validatePayload(payload);
  if (checksumFor(payload) !== release.checksum) throw new Error("Deployed artifact checksum mismatch");
  return { pointer, payload };
}

module.exports = {
  PUBLIC_FILES,
  CloudflareDeployment,
  DirectoryStaticDeployment,
  LocalStaticDeployment,
  buildPublicDirectory,
  pointerFor,
  runCommand,
  stageRelease,
  verifyDeploymentAdapter,
  verifyHttpRelease,
  writeImmutable
};
