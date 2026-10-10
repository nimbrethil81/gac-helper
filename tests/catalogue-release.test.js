"use strict";

// Static catalogue release for GitHub Pages (issue #42): deterministic release
// generation, the allow-listed artifact, the release ledger, immutable retained
// releases, live pre/post-deployment checks and source rollback. Every test runs
// offline against throwaway Git repositories and an in-memory "Pages" fetch.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { compileSource, readSource, writeSource } = require("../scripts/catalogue-source-lib.js");
const { run: runBuild } = require("../scripts/catalogue-build.js");
const {
  BUDGET,
  PAGES_APP_FILES,
  RETAINED_RELEASES,
  buildSite,
  checkLiveBeforeDeploy,
  releaseLedger,
  renderRelease,
  restoreSource,
  verifyLive,
  verifyReleaseText,
  verifySite
} = require("../scripts/catalogue-release-lib.js");
const { run: runRelease } = require("../scripts/catalogue-release.js");

const ROOT = path.resolve(__dirname, "..");
const BASE_URL = "https://example.test/gac-helper/";

function tempDir(t, prefix = "catalogue-release-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A throwaway repository holding the app shell, the committed catalogue source
// and non-public material that must never reach the artifact.
function fixtureRepo(t) {
  const dir = tempDir(t);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  for (const file of PAGES_APP_FILES) fs.writeFileSync(path.join(dir, file), `${file} v1\n`);
  fs.cpSync(path.join(ROOT, "catalogue", "source"), path.join(dir, "catalogue", "source"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "SPEC.md"), "internal\n");
  fs.writeFileSync(path.join(dir, "README.md"), "readme\n");
  const repo = {
    dir,
    sourceDir: path.join(dir, "catalogue", "source"),
    releaseFile: path.join(dir, "catalogue", "release.json"),
    release() {
      const result = runBuild(["release", "--source", repo.sourceDir, "--release-file", repo.releaseFile]);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      return JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));
    },
    commit(message) {
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", message);
      return git(dir, "rev-parse", "HEAD");
    },
    // Edit the source in memory and rewrite it in the canonical format.
    edit(change) {
      const { source } = readSource(repo.sourceDir);
      change(source);
      writeSource(repo.sourceDir, source);
    },
    // One reviewed catalogue change: edit, record the release, commit.
    publishChange(note) {
      repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].notes = note; });
      const record = repo.release();
      repo.commit(`catalogue: ${note}`);
      return record;
    },
    build(t2, options = {}) {
      const out = path.join(tempDir(t2, "catalogue-site-"), "_site");
      return { out, ...buildSite({ repo: dir, out, ...options }) };
    }
  };
  repo.release();
  repo.commit("catalogue v1");
  return repo;
}

const readTree = (root) => Object.fromEntries(listTree(root).map((file) => [file, fs.readFileSync(path.join(root, file))]));
function listTree(root, prefix = "") {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listTree(root, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])).sort();
}

// An in-memory GitHub Pages site serving a directory snapshot (or overrides).
function pagesFrom(tree, overrides = {}) {
  const files = { ...tree, ...overrides };
  const requests = [];
  const fetchImpl = async (url) => {
    const relative = new URL(url).pathname.replace(/^\/gac-helper\//, "");
    requests.push(relative);
    const body = files[relative];
    if (body instanceof Error) throw body;
    if (typeof body === "number") return new Response("error", { status: body });
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetchImpl, requests };
}

// ─── release generation ──────────────────────────────────────────────────────

test("the release file is a deterministic function of version and payload", () => {
  const { source } = readSource(path.join(ROOT, "catalogue", "source"));
  const payload = compileSource(source);
  const a = renderRelease(payload, 7);
  const b = renderRelease(JSON.parse(JSON.stringify(payload)), 7);
  assert.equal(a.text, b.text);
  assert.equal(a.path, `releases/7-${a.checksum.slice(7, 19)}.json`);
  const { release } = verifyReleaseText(a.text, { catalogueVersion: 7, checksum: a.checksum });
  assert.deepEqual(release, { contract: "gac-catalogue-release:v1", sourceSchema: 1, catalogueVersion: 7, checksum: a.checksum });
  assert.notEqual(renderRelease(payload, 8).text, a.text, "the version is part of the immutable file");
  assert.equal(renderRelease(payload, 8).checksum, a.checksum, "the checksum covers the seven legacy keys only");
});

test("corrupted or invalid release content is rejected", () => {
  const { source } = readSource(path.join(ROOT, "catalogue", "source"));
  const good = renderRelease(compileSource(source), 1);
  const variant = (change) => { const copy = JSON.parse(good.text); change(copy); return JSON.stringify(copy); };

  assert.throws(() => verifyReleaseText(good.text.slice(0, -200)), /not valid JSON/);
  assert.throws(() => verifyReleaseText(variant((d) => { d.scoring[0].value += 1; })), /does not match its payload/);
  assert.throws(() => verifyReleaseText(variant((d) => { d.release.contract = "gac-catalogue-release:v2"; })), /contract/);
  assert.throws(() => verifyReleaseText(variant((d) => { d.extra = 1; })), /keys differ/);
  assert.throws(() => verifyReleaseText(variant((d) => { d.release.builtAt = "now"; })), /unexpected keys/);
  assert.throws(() => verifyReleaseText(good.text, { checksum: `sha256:${"0".repeat(64)}` }), /not the expected/);
  assert.throws(() => verifyReleaseText(good.text, { catalogueVersion: 2 }), /not the expected 2/);

  // A self-consistent release that breaks an identity reference still fails.
  const broken = JSON.parse(good.text);
  const defences = broken.counters["5v5"];
  defences[Object.keys(defences)[0]][0].counterId = "NO_SUCH_COUNTER";
  delete broken.release;
  const rebuilt = renderRelease(broken, 1);
  assert.throws(() => verifyReleaseText(rebuilt.text), /release gate/);
});

// ─── site build ──────────────────────────────────────────────────────────────

test("the artifact is exactly the allow-list, complete, verified and reproducible", (t) => {
  const repo = fixtureRepo(t);
  const first = repo.build(t);
  const second = repo.build(t);
  const head = git(repo.dir, "rev-parse", "HEAD");
  const record = JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));
  const releaseFile = `catalogue/releases/1-${record.checksum.slice(7, 19)}.json`;

  assert.deepEqual(first.files, [...PAGES_APP_FILES, "catalogue/current.json", "catalogue/manifest.json", releaseFile].sort());
  assert.deepEqual(readTree(first.out), readTree(second.out), "same commit, byte-identical artifact");
  for (const file of PAGES_APP_FILES) assert.equal(fs.readFileSync(path.join(first.out, file), "utf8"), `${file} v1\n`);

  assert.deepEqual(first.pointer, { pointerSchema: 1, contract: "gac-catalogue-release:v1", catalogueVersion: 1, checksum: record.checksum, path: releaseFile.slice("catalogue/".length), bytes: fs.statSync(path.join(first.out, releaseFile)).size });
  assert.equal(first.manifest.deployedCommit, head);
  assert.deepEqual(first.manifest.releases.map((entry) => [entry.catalogueVersion, entry.sourceCommit]), [[1, head]]);
  verifyReleaseText(fs.readFileSync(path.join(first.out, releaseFile), "utf8"), record);
  assert.ok(first.sizes.pointer <= BUDGET.pointerBytes && first.sizes.current <= BUDGET.releaseBytes);
});

test("the build refuses a non-empty output directory and a missing app file", (t) => {
  const repo = fixtureRepo(t);
  const out = tempDir(t);
  fs.writeFileSync(path.join(out, "stale.json"), "{}");
  assert.throws(() => buildSite({ repo: repo.dir, out }), /not empty/);
  fs.rmSync(path.join(repo.dir, "icon-512.png"));
  assert.throws(() => repo.build(t), /Allow-listed app file missing: icon-512.png/);
});

test("deployment fails before upload on drift, invalid schema, broken references and a corrupted record", (t) => {
  const repo = fixtureRepo(t);
  const original = fs.readFileSync(path.join(repo.sourceDir, "matchups", "5v5.json"));
  const restore = () => {
    git(repo.dir, "checkout", "-q", "--", ".");
    assert.deepEqual(fs.readFileSync(path.join(repo.sourceDir, "matchups", "5v5.json")), original);
  };

  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].notes = "undeclared"; });
  assert.throws(() => repo.build(t), /Undeclared catalogue change/);
  restore();

  repo.edit((source) => { source["units.json"][0].rarity = 7; });
  assert.throws(() => repo.build(t), /Release gate FAIL: SOURCE_SCHEMA/);
  restore();

  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].counterId = "NO_SUCH_COUNTER"; });
  assert.throws(() => repo.build(t), /Release gate FAIL/);
  restore();

  fs.writeFileSync(path.join(repo.sourceDir, "counters.json"), "{ not json");
  assert.throws(() => repo.build(t), /Release gate FAIL: SOURCE_SCHEMA/);
  restore();

  const record = JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));
  fs.writeFileSync(repo.releaseFile, JSON.stringify({ ...record, checksum: `sha256:${"f".repeat(64)}` }));
  assert.throws(() => repo.build(t), /Undeclared catalogue change/);
  restore();

  // A correctly recorded but uncommitted release is not deployable.
  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].notes = "uncommitted"; });
  repo.release();
  assert.throws(() => repo.build(t), /not the latest release committed/);
});

test("a corrupted or extended artifact on disk fails verification", (t) => {
  const repo = fixtureRepo(t);
  const built = repo.build(t);
  const releaseFile = path.join(built.out, "catalogue", built.pointer.path);
  const bytes = fs.readFileSync(releaseFile);

  fs.writeFileSync(releaseFile, Buffer.concat([bytes.subarray(0, 100), Buffer.from("X"), bytes.subarray(101)]));
  assert.throws(() => verifySite(built.out), /corrupted/);
  fs.writeFileSync(releaseFile, bytes);

  fs.writeFileSync(path.join(built.out, "README.md"), "internal");
  assert.throws(() => verifySite(built.out), /extra: README.md/);
  fs.rmSync(path.join(built.out, "README.md"));
  verifySite(built.out);
  assert.throws(() => verifySite(built.out, { budget: { ...BUDGET, releaseBytes: 1000 } }), /over the 1000-byte budget/);
  assert.throws(() => verifySite(built.out, { budget: { ...BUDGET, pointerBytes: 10 } }), /current.json is \d+ bytes/);
});

// ─── ledger, retention and immutability ──────────────────────────────────────

test("earlier releases are rebuilt from Git, retained and byte-identical across deployments", (t) => {
  const repo = fixtureRepo(t);
  const v1 = repo.build(t);
  const record2 = repo.publishChange("second release");
  const v2 = repo.build(t);

  assert.equal(record2.catalogueVersion, 2);
  assert.equal(v2.pointer.catalogueVersion, 2);
  assert.deepEqual(v2.manifest.releases.map((entry) => entry.catalogueVersion), [2, 1]);
  const v1File = `catalogue/${v1.pointer.path}`;
  assert.deepEqual(fs.readFileSync(path.join(v2.out, v1File)), fs.readFileSync(path.join(v1.out, v1File)), "v1 is immutable");
  assert.deepEqual(v2.manifest.releases[1], v1.manifest.releases[0], "v1 keeps its provenance");
});

test("repeat deployment of the same release changes nothing but the deployed commit", (t) => {
  const repo = fixtureRepo(t);
  const before = repo.build(t);
  fs.writeFileSync(path.join(repo.dir, "app.js"), "app.js v2\n");
  const head = repo.commit("app-only change");
  const after = repo.build(t);

  const catalogueOnly = (tree) => Object.fromEntries(Object.entries(tree).filter(([file]) => file.startsWith("catalogue/") && file !== "catalogue/manifest.json"));
  assert.deepEqual(catalogueOnly(readTree(after.out)), catalogueOnly(readTree(before.out)));
  assert.deepEqual({ ...after.manifest, deployedCommit: null }, { ...before.manifest, deployedCommit: null });
  assert.equal(after.manifest.deployedCommit, head);
});

test("the ledger refuses a reused or decreasing version and a shallow clone", (t) => {
  const repo = fixtureRepo(t);
  repo.publishChange("v2");
  const record = JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));

  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].notes = "same version, new content"; });
  repo.release();
  fs.writeFileSync(repo.releaseFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")), catalogueVersion: 2 }));
  repo.commit("reuse v2");
  assert.match(releaseLedger(repo.dir).errors.join(), /catalogueVersion 2 names two checksums/);
  assert.throws(() => repo.build(t), /Release ledger/);
  git(repo.dir, "reset", "-q", "--hard", "HEAD~1");

  git(repo.dir, "checkout", "-q", "HEAD~1", "--", "catalogue");
  repo.commit("revert to v1 without a new version");
  assert.match(releaseLedger(repo.dir).errors.join(), /decreased from 2 to 1/);
  git(repo.dir, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(JSON.parse(fs.readFileSync(repo.releaseFile, "utf8")).checksum, record.checksum);

  const shallow = path.join(tempDir(t), "shallow");
  git(repo.dir, "clone", "-q", "--depth", "1", `file://${repo.dir}`, shallow);
  assert.throws(() => releaseLedger(shallow), /full Git history/);
});

test("only gate-passing, reproducible releases are retained, up to the retention limit", (t) => {
  const repo = fixtureRepo(t);
  // v2 is recorded on main but broken (it could never have been deployed).
  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].counterId = "NO_SUCH_COUNTER"; });
  repo.release();
  repo.commit("broken v2");
  git(repo.dir, "checkout", "-q", "HEAD~1", "--", "catalogue/source");
  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].notes = "fixed"; });
  repo.release();
  repo.commit("v3 fixes v2");

  const built = repo.build(t);
  assert.deepEqual(built.manifest.releases.map((entry) => entry.catalogueVersion), [3, 1]);
  assert.deepEqual(built.skipped.map((entry) => entry.catalogueVersion), [2]);
  assert.match(built.skipped[0].reason, /fails the release gate/);

  for (let index = 4; index <= RETAINED_RELEASES + 3; index += 1) repo.publishChange(`release ${index}`);
  const capped = repo.build(t);
  assert.equal(capped.manifest.releases.length, RETAINED_RELEASES);
  assert.deepEqual(capped.manifest.releases.map((entry) => entry.catalogueVersion), [8, 7, 6, 5, 4]);
});

// ─── live checks ─────────────────────────────────────────────────────────────

test("the pre-deployment guard classifies first, same and new releases", async (t) => {
  const repo = fixtureRepo(t);
  const v1 = repo.build(t);
  assert.equal((await checkLiveBeforeDeploy({ site: v1.out, baseUrl: BASE_URL, fetchImpl: pagesFrom({}).fetchImpl })).outcome, "first-deployment");
  const liveV1 = pagesFrom(readTree(v1.out));
  assert.equal((await checkLiveBeforeDeploy({ site: v1.out, baseUrl: BASE_URL, fetchImpl: liveV1.fetchImpl })).outcome, "same-release");

  repo.publishChange("v2");
  const v2 = repo.build(t);
  const result = await checkLiveBeforeDeploy({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v1.out)).fetchImpl });
  assert.equal(result.outcome, "new-release");
  assert.match(result.lines[0], /v1 .* → v2/);
});

test("the pre-deployment guard refuses a stale build, a contradicting version and a mutated release file", async (t) => {
  const repo = fixtureRepo(t);
  const v1 = repo.build(t);
  repo.publishChange("v2");
  const v2 = repo.build(t);

  // A run building v1 while v2 is live (stale pointer / out-of-order run).
  await assert.rejects(checkLiveBeforeDeploy({ site: v1.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v2.out)).fetchImpl }), /newer than this build's v1; refusing a version regression/);

  const conflicting = JSON.parse(fs.readFileSync(path.join(v2.out, "catalogue", "manifest.json"), "utf8"));
  conflicting.current.checksum = `sha256:${"a".repeat(64)}`;
  await assert.rejects(checkLiveBeforeDeploy({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v2.out), { "catalogue/manifest.json": JSON.stringify(conflicting) }).fetchImpl }), /never names two checksums/);

  const v1File = `catalogue/${v1.pointer.path}`;
  await assert.rejects(checkLiveBeforeDeploy({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v1.out), { [v1File]: "{}" }).fetchImpl }), /immutable/);
  await assert.rejects(checkLiveBeforeDeploy({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom({}, { "catalogue/manifest.json": 503 }).fetchImpl }), /HTTP 503; refusing/);
  await assert.rejects(checkLiveBeforeDeploy({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom({}, { "catalogue/manifest.json": "<html>" }).fetchImpl }), /not JSON/);
});

test("post-deployment verification waits for propagation and fails rather than report a stale site", async (t) => {
  const repo = fixtureRepo(t);
  const v1 = repo.build(t);
  repo.publishChange("v2");
  const v2 = repo.build(t);
  const oldTree = readTree(v1.out);
  const newTree = readTree(v2.out);
  let clock = 0;
  const timing = { timeoutMs: 60_000, intervalMs: 20_000, sleep: async (ms) => { clock += ms; }, now: () => clock };

  // The CDN serves the old pointer for the first two attempts.
  let calls = 0;
  const propagating = async (url, init) => {
    calls += 1;
    const relative = new URL(url).pathname.replace(/^\/gac-helper\//, "");
    const tree = calls <= 6 ? oldTree : newTree;
    return tree[relative] === undefined ? new Response("", { status: 404 }) : new Response(tree[relative], { status: 200 });
  };
  const ok = await verifyLive({ site: v2.out, baseUrl: BASE_URL, fetchImpl: propagating, ...timing });
  assert.ok(ok.attempts > 1);
  assert.match(ok.lines[0], /v2 sha256:/);

  clock = 0;
  await assert.rejects(verifyLive({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(oldTree).fetchImpl, ...timing }), /does not match the deployment after 4 attempt\(s\).*current.json: live bytes differ/);

  clock = 0;
  const currentFile = `catalogue/${v2.pointer.path}`;
  await assert.rejects(verifyLive({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(newTree, { [currentFile]: newTree[currentFile].subarray(0, 500) }).fetchImpl, ...timing }), /releases\/2-[0-9a-f]{12}\.json: live bytes differ/);

  clock = 0;
  await assert.rejects(verifyLive({ site: v2.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(newTree, { "catalogue/current.json": new Error("ECONNRESET") }).fetchImpl, ...timing }), /ECONNRESET/);

  // A redeploy of the same release from a newer commit is told apart by the manifest.
  fs.writeFileSync(path.join(repo.dir, "app.js"), "app.js v2\n");
  repo.commit("app-only");
  const redeploy = repo.build(t);
  clock = 0;
  await assert.rejects(verifyLive({ site: redeploy.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(newTree).fetchImpl, ...timing }), /manifest.json: live bytes differ/);
  assert.ok((await verifyLive({ site: redeploy.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(redeploy.out)).fetchImpl, ...timing })).attempts === 1);
});

// ─── rollback ────────────────────────────────────────────────────────────────

test("rollback restores an earlier release's source under a new, higher version and verifies live", async (t) => {
  const repo = fixtureRepo(t);
  const v1Commit = git(repo.dir, "rev-parse", "HEAD");
  const v1Record = JSON.parse(fs.readFileSync(repo.releaseFile, "utf8"));
  const v1 = repo.build(t);
  repo.publishChange("bad change");
  const v2 = repo.build(t);

  assert.throws(() => restoreSource({ repo: repo.dir, catalogueVersion: 9 }), /No catalogueVersion 9/);
  const entry = restoreSource({ repo: repo.dir, catalogueVersion: 1 });
  assert.equal(entry.sourceCommit, v1Commit);
  assert.equal(git(repo.dir, "diff", "--stat", v1Commit, "--", "catalogue/source"), "", "byte-identical v1 source");

  const record = repo.release();
  assert.deepEqual([record.catalogueVersion, record.checksum], [3, v1Record.checksum]);
  repo.commit("Roll back catalogue to v1 as v3");
  const v3 = repo.build(t);

  assert.equal(v3.pointer.catalogueVersion, 3);
  assert.equal(v3.pointer.checksum, v1Record.checksum);
  assert.deepEqual(v3.manifest.releases.map((release) => release.catalogueVersion), [3, 2, 1]);
  for (const earlier of [v1, v2]) {
    const file = `catalogue/${earlier.pointer.path}`;
    assert.deepEqual(fs.readFileSync(path.join(v3.out, file)), fs.readFileSync(path.join(earlier.out, file)));
  }

  const guard = await checkLiveBeforeDeploy({ site: v3.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v2.out)).fetchImpl });
  assert.equal(guard.outcome, "new-release");
  const verified = await verifyLive({ site: v3.out, baseUrl: BASE_URL, fetchImpl: pagesFrom(readTree(v3.out)).fetchImpl, timeoutMs: 0 });
  assert.match(verified.lines[0], new RegExp(`v3 ${v1Record.checksum}`));

  // Rolling back again (repeatable) produces v4 with v2's content.
  restoreSource({ repo: repo.dir, catalogueVersion: 2 });
  assert.deepEqual(repo.release().catalogueVersion, 4);
});

test("a release that fails today's gate cannot be restored", (t) => {
  const repo = fixtureRepo(t);
  repo.edit((source) => { source["matchups/5v5.json"][0].counters[0].counterId = "NO_SUCH_COUNTER"; });
  repo.release();
  repo.commit("broken v2");
  git(repo.dir, "checkout", "-q", "HEAD~1", "--", "catalogue/source");
  repo.release();
  repo.commit("v3");
  assert.throws(() => restoreSource({ repo: repo.dir, catalogueVersion: 2 }), /cannot be restored: fails the release gate/);
});

// ─── CLI and workflow ────────────────────────────────────────────────────────

test("the CLI separates usage errors from check failures", async (t) => {
  const repo = fixtureRepo(t);
  assert.equal((await runRelease(["site"])).exitCode, 2);
  assert.equal((await runRelease(["nope"])).exitCode, 2);
  assert.equal((await runRelease(["restore", "--version", "x", "--repo", repo.dir])).exitCode, 2);
  const out = path.join(tempDir(t), "_site");
  const built = await runRelease(["site", "--out", out, "--repo", repo.dir]);
  assert.equal(built.exitCode, 0, built.lines.join("\n"));
  assert.match(built.lines.join("\n"), /Current: v1 sha256:/);
  assert.equal((await runRelease(["site", "--out", out, "--repo", repo.dir])).exitCode, 1, "non-empty output");
  assert.equal((await runRelease(["ledger", "--repo", repo.dir])).exitCode, 0);
});

test("Deploy Pages Live stays manual, main-only and serialised, and gates the catalogue", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "deploy-pages-live.yml"), "utf8");
  const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(triggers, /^\non:\n {2}workflow_dispatch:\n*$/);
  assert.match(workflow, /if: github\.repository == 'nimbrethil81\/gac-helper' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /concurrency:\n {2}group: pages-live\n {2}cancel-in-progress: false/);
  assert.match(workflow, /fetch-depth: 0/);
  const order = ["catalogue-release.js site --out _site", "catalogue-release.js guard", "actions/upload-pages-artifact", "actions/deploy-pages", "catalogue-release.js verify"]
    .map((step) => workflow.indexOf(step));
  assert.ok(order.every((index) => index > 0), "every catalogue step is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "build → guard → upload → deploy → verify");
  assert.doesNotMatch(workflow, /cp "\$file" _site/, "the allow-list lives in one place");
});

test("the committed catalogue builds a passing release artifact", (t) => {
  if (execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8" }).trim() === "true") {
    t.skip("shallow clone: the release ledger needs full history (CI and Deploy Pages Live fetch it)");
    return;
  }
  const out = path.join(tempDir(t), "_site");
  const built = buildSite({ repo: ROOT, out });
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, "catalogue", "release.json"), "utf8"));
  assert.equal(built.pointer.catalogueVersion, record.catalogueVersion);
  assert.equal(built.pointer.checksum, record.checksum);
});
