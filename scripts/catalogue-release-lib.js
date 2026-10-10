"use strict";

// Static catalogue release for GitHub Pages (issue #42, ADR-ARCH-116 §7–§9).
//
// - releaseLedger reads every catalogue/release.json state that main has held
//   (first-parent history) and refuses a reused or decreasing version.
// - buildSite assembles the complete allow-listed Pages artifact: the app shell
//   files plus catalogue/current.json, catalogue/manifest.json and immutable
//   catalogue/releases/{N}-{hex}.json files. The current release and up to
//   RETAINED_RELEASES - 1 earlier releases are rebuilt from Git, because a Pages
//   deployment replaces the whole site and keeps nothing from the previous one.
// - checkLiveBeforeDeploy and verifyLive compare the live site over HTTPS with
//   the built artifact; fetch is injectable so tests stay offline.
// - restoreSource writes the source of an earlier release back into
//   catalogue/source/ for a reviewed rollback commit.
//
// Node built-ins and git only: no npm ci, network (except the live checks),
// database or credentials.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { REQUIRED_PAYLOAD_KEYS, sha256, sortJson } = require("./baseline-lib.js");
const { auditPayload, payloadChecksum } = require("./catalogue-audit-lib.js");
const { FILES, RELEASE_CONTRACT, SOURCE_SCHEMA, auditSource, readSource } = require("./catalogue-source-lib.js");

// The live Pages allow-list for the app shell (moved here from the workflow).
const PAGES_APP_FILES = Object.freeze([
  "index.html", "app.js", "styles.css", "manifest.json", "service-worker.js", "icon-192.png", "icon-512.png"
]);
const RELEASE_FILE = "catalogue/release.json";
const SOURCE_DIR = "catalogue/source";
const POINTER_PATH = "catalogue/current.json";
const MANIFEST_PATH = "catalogue/manifest.json";
const POINTER_SCHEMA = 1;
const MANIFEST_SCHEMA = 1;
// Current release plus up to four earlier ones. Older releases stay reproducible
// from Git (restoreSource) but are not served.
const RETAINED_RELEASES = 5;
// Performance budget for the client cutover (docs/CATALOGUE_SOURCE.md). The
// build fails rather than publish past it.
const BUDGET = Object.freeze({ pointerBytes: 1024, manifestBytes: 4096, releaseBytes: 256 * 1024, catalogueBytes: 1536 * 1024 });

const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

// ─── git ─────────────────────────────────────────────────────────────────────

function git(repo, args, { binary = false } = {}) {
  return execFileSync("git", args, { cwd: repo, encoding: binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function gitFileAt(repo, commit, file) {
  try {
    return git(repo, ["show", `${commit}:${file}`], { binary: true });
  } catch {
    return null;
  }
}

// ─── release record and ledger ───────────────────────────────────────────────

function parseReleaseRecord(text, where) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: invalid JSON (${error.message})`);
  }
  if (record?.schema !== 1 || !Number.isSafeInteger(record.catalogueVersion) || record.catalogueVersion < 1 || !CHECKSUM.test(record.checksum ?? "")) {
    throw new Error(`${where}: not a release record { schema: 1, catalogueVersion: N > 0, checksum: "sha256:<64 hex>" }`);
  }
  return record;
}

// Every release main has recorded, oldest first: [{ catalogueVersion, checksum,
// sourceCommit }]. sourceCommit is the first first-parent commit recording it.
// Versions must strictly increase and never name two checksums; a checksum may
// recur under a higher version (a rollback).
function releaseLedger(repo, { ref = "HEAD" } = {}) {
  if (git(repo, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("The release ledger needs full Git history (actions/checkout with fetch-depth: 0, or git fetch --unshallow)");
  }
  const commits = git(repo, ["rev-list", "--first-parent", "--reverse", ref, "--", RELEASE_FILE]).split("\n").filter(Boolean);
  const entries = [];
  const errors = [];
  for (const commit of commits) {
    const bytes = gitFileAt(repo, commit, RELEASE_FILE);
    if (bytes === null) continue; // deleted in this commit; a later commit must restore it
    let record;
    try {
      record = parseReleaseRecord(bytes.toString("utf8"), `${RELEASE_FILE} at ${commit}`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const last = entries[entries.length - 1];
    if (last && last.catalogueVersion === record.catalogueVersion) {
      if (last.checksum !== record.checksum) errors.push(`catalogueVersion ${record.catalogueVersion} names two checksums (${last.checksum} at ${last.sourceCommit}, ${record.checksum} at ${commit})`);
      continue;
    }
    if (last && record.catalogueVersion < last.catalogueVersion) {
      errors.push(`catalogueVersion decreased from ${last.catalogueVersion} to ${record.catalogueVersion} at ${commit}; versions never decrease or repeat, including on rollback`);
      continue;
    }
    entries.push({ catalogueVersion: record.catalogueVersion, checksum: record.checksum, sourceCommit: commit });
  }
  return { entries, errors };
}

// ─── release files ───────────────────────────────────────────────────────────

function releasePath(catalogueVersion, checksum) {
  return `releases/${catalogueVersion}-${checksum.slice("sha256:".length, "sha256:".length + 12)}.json`;
}

// Release file bytes: the seven legacy keys plus "release", as compact JSON with
// keys sorted recursively. A pure function of (catalogueVersion, payload).
function renderRelease(payload, catalogueVersion) {
  const checksum = payloadChecksum(payload);
  const document = {
    release: { contract: RELEASE_CONTRACT, sourceSchema: SOURCE_SCHEMA, catalogueVersion, checksum },
    ...Object.fromEntries(REQUIRED_PAYLOAD_KEYS.map((key) => [key, payload[key]]))
  };
  const text = `${JSON.stringify(sortJson(document))}\n`;
  return { catalogueVersion, checksum, path: releasePath(catalogueVersion, checksum), text, bytes: Buffer.byteLength(text), sha256: `sha256:${sha256(text)}` };
}

// Independent check of release file bytes, as the client will do at cutover:
// contract, exact key set, canonical seven-key checksum, and the full shared
// release gate (schema, identity references, enumerations, secrets).
function verifyReleaseText(text, expected = {}) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`release is not valid JSON (${error.message})`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("release is not a JSON object");
  const keys = Object.keys(document).sort();
  const wanted = [...REQUIRED_PAYLOAD_KEYS, "release"].sort();
  if (keys.join() !== wanted.join()) throw new Error(`release keys differ: ${keys.join(", ")}`);
  const meta = document.release;
  if (meta?.contract !== RELEASE_CONTRACT) throw new Error(`release contract ${JSON.stringify(meta?.contract)} is not ${RELEASE_CONTRACT}`);
  if (meta.sourceSchema !== SOURCE_SCHEMA) throw new Error(`release sourceSchema ${JSON.stringify(meta.sourceSchema)} is not ${SOURCE_SCHEMA}`);
  if (Object.keys(meta).sort().join() !== "catalogueVersion,checksum,contract,sourceSchema") throw new Error("release metadata has unexpected keys");
  const checksum = payloadChecksum(document);
  if (meta.checksum !== checksum) throw new Error(`release checksum ${meta.checksum} does not match its payload (${checksum})`);
  if (expected.checksum !== undefined && checksum !== expected.checksum) throw new Error(`release checksum ${checksum} is not the expected ${expected.checksum}`);
  if (expected.catalogueVersion !== undefined && meta.catalogueVersion !== expected.catalogueVersion) throw new Error(`release version ${meta.catalogueVersion} is not the expected ${expected.catalogueVersion}`);
  const payload = Object.fromEntries(REQUIRED_PAYLOAD_KEYS.map((key) => [key, document[key]]));
  const report = auditPayload(payload, { label: "release" });
  if (report.summary.releaseGate !== "PASS") {
    const failing = report.findings.filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval");
    throw new Error(`release fails the release gate: ${failing.slice(0, 5).map((finding) => `${finding.code} ${finding.subject}`).join("; ")}`);
  }
  return { release: meta, payload };
}

// ─── source ──────────────────────────────────────────────────────────────────

// The catalogue source as committed at a commit, read through the same
// validator as the working tree.
function sourceAtCommit(repo, commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-at-commit-"));
  try {
    for (const file of Object.keys(FILES)) {
      const bytes = gitFileAt(repo, commit, `${SOURCE_DIR}/${file}`);
      if (bytes === null) continue;
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
    }
    return readSource(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Blocking and owner-approval findings, source-file problems first: an
// unreadable file otherwise surfaces only as its downstream payload findings.
function gateFailures(report) {
  const failing = report.findings.filter((finding) => finding.severity === "blocking" || finding.severity === "owner-approval");
  return [...failing.filter((finding) => finding.code.startsWith("SOURCE_")), ...failing.filter((finding) => !finding.code.startsWith("SOURCE_"))];
}

// Compile a ledger entry's source and confirm it reproduces the recorded
// checksum and passes the release gate.
function rebuildEntry(repo, entry) {
  const { source, findings } = sourceAtCommit(repo, entry.sourceCommit);
  const report = auditSource(source, { readFindings: findings });
  if (report.input.checksum !== entry.checksum) return { ok: false, reason: `source at ${entry.sourceCommit} compiles to ${report.input.checksum}, not the recorded ${entry.checksum}` };
  if (report.summary.releaseGate !== "PASS") return { ok: false, reason: `fails the release gate (${gateFailures(report).length} blocking/owner-approval finding(s))` };
  return { ok: true, rendered: renderRelease(report.payload, entry.catalogueVersion) };
}

// ─── site build ──────────────────────────────────────────────────────────────

function listFiles(root, prefix = "") {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, relative);
    if (!entry.isFile()) throw new Error(`Unexpected non-file in artifact: ${relative}`);
    return [relative];
  }).sort();
}

function writeNew(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { flag: "wx" });
}

const jsonText = (value) => `${JSON.stringify(sortJson(value), null, 2)}\n`;

// Build the complete Pages artifact into an empty directory, re-read it from
// disk and verify it. Throws (and never leaves a partial success) on: unreadable
// or invalid source, a failing release gate, release.json drift from the source,
// release.json not committed at HEAD, a ledger violation, a budget breach, a
// corrupted written file or any file outside the allow-list.
function buildSite({ repo, out, budget = BUDGET, retain = RETAINED_RELEASES }) {
  repo = path.resolve(repo);
  out = path.resolve(out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`Output directory is not empty: ${out}`);

  // Working-tree catalogue: valid, gated and exactly what release.json records.
  const { source, findings } = readSource(path.join(repo, SOURCE_DIR));
  const report = auditSource(source, { readFindings: findings });
  if (report.summary.releaseGate !== "PASS") {
    throw new Error(`Release gate FAIL: ${gateFailures(report).slice(0, 10).map((finding) => `${finding.code} ${finding.location || finding.subject}: ${finding.observed}`).join("; ")}`);
  }
  const record = parseReleaseRecord(fs.readFileSync(path.join(repo, RELEASE_FILE), "utf8"), RELEASE_FILE);
  if (record.checksum !== report.input.checksum) {
    throw new Error(`Undeclared catalogue change: source compiles to ${report.input.checksum} but ${RELEASE_FILE} records ${record.checksum}. Run npm run catalogue:release.`);
  }

  const ledger = releaseLedger(repo);
  if (ledger.errors.length) throw new Error(`Release ledger: ${ledger.errors.join("; ")}`);
  const top = ledger.entries[ledger.entries.length - 1];
  if (!top || top.catalogueVersion !== record.catalogueVersion || top.checksum !== record.checksum) {
    throw new Error(`${RELEASE_FILE} (v${record.catalogueVersion}) is not the latest release committed on the first-parent history of HEAD${top ? ` (v${top.catalogueVersion})` : ""}; commit it first`);
  }
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  const current = { ...renderRelease(report.payload, top.catalogueVersion), sourceCommit: top.sourceCommit };
  const retained = [current];
  const skipped = [];
  for (const entry of ledger.entries.slice(0, -1).reverse()) {
    if (retained.length >= retain) break;
    const rebuilt = rebuildEntry(repo, entry);
    if (rebuilt.ok) retained.push({ ...rebuilt.rendered, sourceCommit: entry.sourceCommit });
    else skipped.push({ catalogueVersion: entry.catalogueVersion, checksum: entry.checksum, reason: rebuilt.reason });
  }

  const pointer = {
    pointerSchema: POINTER_SCHEMA,
    contract: RELEASE_CONTRACT,
    catalogueVersion: current.catalogueVersion,
    checksum: current.checksum,
    path: current.path,
    bytes: current.bytes
  };
  const manifest = {
    manifestSchema: MANIFEST_SCHEMA,
    contract: RELEASE_CONTRACT,
    deployedCommit: head,
    current: { catalogueVersion: current.catalogueVersion, checksum: current.checksum, path: current.path },
    releases: retained.map(({ catalogueVersion, checksum, path: file, bytes, sha256: digest, sourceCommit }) => ({ catalogueVersion, checksum, path: file, bytes, sha256: digest, sourceCommit }))
  };

  fs.mkdirSync(out, { recursive: true });
  for (const file of PAGES_APP_FILES) {
    const from = path.join(repo, file);
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) throw new Error(`Allow-listed app file missing: ${file}`);
    writeNew(path.join(out, file), fs.readFileSync(from));
  }
  for (const release of retained) writeNew(path.join(out, "catalogue", release.path), release.text);
  writeNew(path.join(out, POINTER_PATH), jsonText(pointer));
  writeNew(path.join(out, MANIFEST_PATH), jsonText(manifest));

  const result = verifySite(out, { budget });
  return { ...result, skipped, head };
}

// Re-read a built artifact from disk and prove it is complete, allow-listed,
// internally consistent and within budget.
function verifySite(out, { budget = BUDGET } = {}) {
  const read = (relative) => fs.readFileSync(path.join(out, relative));
  const manifest = JSON.parse(read(MANIFEST_PATH).toString("utf8"));
  const pointer = JSON.parse(read(POINTER_PATH).toString("utf8"));
  if (manifest.manifestSchema !== MANIFEST_SCHEMA || manifest.contract !== RELEASE_CONTRACT || !COMMIT.test(manifest.deployedCommit ?? "")) throw new Error("manifest.json has an unexpected shape");
  if (pointer.pointerSchema !== POINTER_SCHEMA || pointer.contract !== RELEASE_CONTRACT) throw new Error("current.json has an unexpected shape");
  if (Object.keys(pointer).sort().join() !== "bytes,catalogueVersion,checksum,contract,path,pointerSchema") throw new Error("current.json has unexpected keys");

  const expected = [...PAGES_APP_FILES, POINTER_PATH, MANIFEST_PATH, ...manifest.releases.map((release) => `catalogue/${release.path}`)].sort();
  const actual = listFiles(out);
  if (actual.join("\n") !== expected.join("\n")) {
    const extra = actual.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !actual.includes(file));
    throw new Error(`Artifact is not exactly the allow-list (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
  }

  const versions = new Set();
  for (const entry of manifest.releases) {
    if (versions.has(entry.catalogueVersion)) throw new Error(`manifest lists catalogueVersion ${entry.catalogueVersion} twice`);
    versions.add(entry.catalogueVersion);
    if (entry.path !== releasePath(entry.catalogueVersion, entry.checksum) || !COMMIT.test(entry.sourceCommit ?? "")) throw new Error(`manifest entry v${entry.catalogueVersion} is malformed`);
    const bytes = read(`catalogue/${entry.path}`);
    if (bytes.length !== entry.bytes || `sha256:${sha256(bytes)}` !== entry.sha256) throw new Error(`catalogue/${entry.path} is corrupted (bytes or sha256 differ from the manifest)`);
    verifyReleaseText(bytes.toString("utf8"), entry);
    if (bytes.length > budget.releaseBytes) throw new Error(`catalogue/${entry.path} is ${bytes.length} bytes, over the ${budget.releaseBytes}-byte budget`);
  }
  const top = manifest.releases[0];
  if (!top || Math.max(...versions) !== top.catalogueVersion || manifest.current.path !== top.path) throw new Error("manifest current release is not the highest version");
  if (pointer.catalogueVersion !== top.catalogueVersion || pointer.checksum !== top.checksum || pointer.path !== top.path || pointer.bytes !== top.bytes) {
    throw new Error("current.json does not name the current release exactly");
  }

  const sizes = {
    pointer: read(POINTER_PATH).length,
    manifest: read(MANIFEST_PATH).length,
    current: top.bytes,
    catalogue: listFiles(out).filter((file) => file.startsWith("catalogue/")).reduce((sum, file) => sum + read(file).length, 0)
  };
  if (sizes.pointer > budget.pointerBytes) throw new Error(`current.json is ${sizes.pointer} bytes, over the ${budget.pointerBytes}-byte budget`);
  if (sizes.manifest > budget.manifestBytes) throw new Error(`manifest.json is ${sizes.manifest} bytes, over the ${budget.manifestBytes}-byte budget`);
  if (sizes.catalogue > budget.catalogueBytes) throw new Error(`catalogue/ is ${sizes.catalogue} bytes, over the ${budget.catalogueBytes}-byte budget`);
  return { files: actual, pointer, manifest, sizes };
}

// ─── live checks ─────────────────────────────────────────────────────────────

async function fetchLive(fetchImpl, baseUrl, relative) {
  const url = new URL(relative, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  const response = await fetchImpl(url, { cache: "no-store", headers: { "Cache-Control": "no-cache" }, redirect: "follow" });
  const body = Buffer.from(await response.arrayBuffer());
  return { url, status: response.status, ok: response.ok, body };
}

// Before upload: what is live must not be newer than, or contradict, the
// artifact about to replace it. Refuses a version regression (a stale run or a
// reverted release.json), a version naming a different checksum, and a release
// file whose live bytes differ from the rebuilt immutable file.
async function checkLiveBeforeDeploy({ site, baseUrl, fetchImpl = globalThis.fetch }) {
  const local = JSON.parse(fs.readFileSync(path.join(site, MANIFEST_PATH), "utf8"));
  const live = await fetchLive(fetchImpl, baseUrl, MANIFEST_PATH);
  if (live.status === 404) return { outcome: "first-deployment", lines: ["No live catalogue manifest (404): first catalogue deployment."] };
  if (!live.ok) throw new Error(`GET ${live.url} returned HTTP ${live.status}; refusing to deploy without knowing the live release`);
  let manifest;
  try {
    manifest = JSON.parse(live.body.toString("utf8"));
  } catch {
    throw new Error(`Live ${MANIFEST_PATH} is not JSON`);
  }
  if (manifest.manifestSchema !== MANIFEST_SCHEMA || !Array.isArray(manifest.releases) || !manifest.current) throw new Error(`Live ${MANIFEST_PATH} has an unknown shape`);

  const was = manifest.current;
  const now = local.current;
  if (was.catalogueVersion > now.catalogueVersion) throw new Error(`Live catalogue v${was.catalogueVersion} is newer than this build's v${now.catalogueVersion}; refusing a version regression (roll back by committing a new higher version)`);
  if (was.catalogueVersion === now.catalogueVersion && was.checksum !== now.checksum) throw new Error(`Live v${was.catalogueVersion} is ${was.checksum} but this build's v${now.catalogueVersion} is ${now.checksum}; a version never names two checksums`);

  const lines = [];
  for (const entry of manifest.releases) {
    const mine = local.releases.find((candidate) => candidate.catalogueVersion === entry.catalogueVersion);
    if (!mine) { lines.push(`Live v${entry.catalogueVersion} is no longer retained by this build.`); continue; }
    if (mine.checksum !== entry.checksum || mine.path !== entry.path) throw new Error(`Live v${entry.catalogueVersion} (${entry.checksum}) differs from the rebuilt v${mine.catalogueVersion} (${mine.checksum})`);
    const file = await fetchLive(fetchImpl, baseUrl, `catalogue/${entry.path}`);
    if (!file.ok) { lines.push(`Live catalogue/${entry.path} returned HTTP ${file.status}; it will be restored by this deployment.`); continue; }
    const builtBytes = fs.readFileSync(path.join(site, "catalogue", mine.path));
    if (!file.body.equals(builtBytes)) throw new Error(`Live catalogue/${entry.path} differs from its rebuilt bytes; release files are immutable`);
  }
  const outcome = was.checksum === now.checksum && was.catalogueVersion === now.catalogueVersion ? "same-release" : "new-release";
  lines.unshift(outcome === "same-release"
    ? `Live catalogue is already v${now.catalogueVersion} (${now.checksum}); release files and pointer will be republished unchanged.`
    : `Live catalogue v${was.catalogueVersion} (${was.checksum}) → v${now.catalogueVersion} (${now.checksum}).`);
  return { outcome, lines };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// After deployment: poll the live pointer, manifest and every release file until
// each is byte-identical to the artifact (which names the deployed commit), then
// verify the live current release independently. Throws if the site is still
// stale or wrong when the timeout expires; it never reports success early.
async function verifyLive({ site, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 15 * 60 * 1000, intervalMs = 20 * 1000, sleep = delay, now = Date.now }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(site, MANIFEST_PATH), "utf8"));
  const files = [POINTER_PATH, MANIFEST_PATH, ...manifest.releases.map((release) => `catalogue/${release.path}`)];
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const problems = [];
    let currentBody = null;
    for (const relative of files) {
      let live;
      try {
        live = await fetchLive(fetchImpl, baseUrl, relative);
      } catch (error) {
        problems.push(`${relative}: ${error.message}`);
        continue;
      }
      if (!live.ok) { problems.push(`${relative}: HTTP ${live.status}`); continue; }
      if (!live.body.equals(fs.readFileSync(path.join(site, relative)))) { problems.push(`${relative}: live bytes differ from the deployed artifact`); continue; }
      if (relative === `catalogue/${manifest.current.path}`) currentBody = live.body;
    }
    if (!problems.length) {
      const { release } = verifyReleaseText(currentBody.toString("utf8"), manifest.current);
      return {
        attempts: attempt,
        lines: [
          `Live catalogue verified after ${attempt} attempt(s): v${release.catalogueVersion} ${release.checksum}`,
          `Deployed commit ${manifest.deployedCommit}; ${manifest.releases.length} release file(s) served: ${manifest.releases.map((entry) => `v${entry.catalogueVersion}`).join(", ")}`
        ]
      };
    }
    if (now() >= deadline) throw new Error(`Live catalogue does not match the deployment after ${attempt} attempt(s) (stale Pages/CDN or failed deployment): ${problems.join("; ")}`);
    await sleep(intervalMs);
  }
}

// ─── rollback ────────────────────────────────────────────────────────────────

// Write the exact committed source bytes of an earlier release into the working
// tree. The caller then runs `catalogue:release`, which records the restored
// checksum under a new, higher version.
function restoreSource({ repo, catalogueVersion }) {
  repo = path.resolve(repo);
  const ledger = releaseLedger(repo);
  if (ledger.errors.length) throw new Error(`Release ledger: ${ledger.errors.join("; ")}`);
  const entry = ledger.entries.find((candidate) => candidate.catalogueVersion === catalogueVersion);
  if (!entry) throw new Error(`No catalogueVersion ${catalogueVersion} on the first-parent history of HEAD (known: ${ledger.entries.map((candidate) => candidate.catalogueVersion).join(", ") || "none"})`);
  const rebuilt = rebuildEntry(repo, entry);
  if (!rebuilt.ok) throw new Error(`v${catalogueVersion} cannot be restored: ${rebuilt.reason}`);
  for (const file of Object.keys(FILES)) {
    const bytes = gitFileAt(repo, entry.sourceCommit, `${SOURCE_DIR}/${file}`);
    const target = path.join(repo, SOURCE_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const { source, findings } = readSource(path.join(repo, SOURCE_DIR));
  const checksum = auditSource(source, { readFindings: findings }).input.checksum;
  if (checksum !== entry.checksum) throw new Error(`Restored source compiles to ${checksum}, not ${entry.checksum}`);
  return entry;
}

module.exports = {
  BUDGET,
  MANIFEST_PATH,
  PAGES_APP_FILES,
  POINTER_PATH,
  RETAINED_RELEASES,
  buildSite,
  checkLiveBeforeDeploy,
  releaseLedger,
  releasePath,
  renderRelease,
  restoreSource,
  sourceAtCommit,
  verifyLive,
  verifyReleaseText,
  verifySite
};
