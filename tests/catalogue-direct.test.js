"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { command, verifyEvent, proposal, sameProposal, verifyRun, releaseCheck, changedPaths, digest, sameEffects } = require("../scripts/catalogue-direct.js");
const user = { id: 291301639, login: "nimbrethil81", type: "User" };
const now = Date.parse("2026-11-12T12:00:01Z");
const comment = { id: 123, user, body: "/catalogue approve 12345", created_at: "2026-11-12T12:00:00Z", updated_at: "2026-11-12T12:00:00Z", html_url: "https://github.com/nimbrethil81/gac-helper/issues/171#issuecomment-123" };
const event = { action: "created", repository: { full_name: "nimbrethil81/gac-helper" }, issue: { number: 171 }, sender: user, comment };
const copy = (value) => JSON.parse(JSON.stringify(value));
const pilot = JSON.parse(fs.readFileSync("catalogue/corrections/2026-11-09-172-reva-jmk.json", "utf8"));
const pending = () => { const doc = copy(pilot); doc.corrections[0].status = "PENDING_OWNER_APPROVAL"; doc.corrections[0].approval = null; return doc; };
const file = "catalogue/corrections/2026-11-09-172-reva-jmk.json";
test("new authentic owner decision is verified against exact live GitHub comment", () => {
  assert.deepEqual(verifyEvent(event, comment, now), { action: "approve", runId: "12345" });
  for (const mutate of [
    (e) => { e.sender.id = 1; }, (e) => { e.comment.user.type = "Bot"; },
    (e) => { e.action = "edited"; }, (e) => { e.repository.full_name = "fake/repo"; },
    (e) => { e.issue.pull_request = {}; }, (e) => { e.comment.body += " "; },
    (e) => { e.comment.html_url = "https://evil.test"; }
  ]) { const e = copy(event); mutate(e); assert.throws(() => verifyEvent(e, comment, now)); }
  const edited = { ...comment, updated_at: "2026-11-12T12:00:01Z" };
  assert.throws(() => verifyEvent({ ...event, comment: edited }, edited, now), /Edited/);
  assert.throws(() => verifyEvent(event, comment, now + 86400001), /Outdated/);
});
test("commands accept bounded data only and refuse ambiguous approval", () => {
  assert.equal(command("/catalogue preview catalogue/corrections/2026-11-09-172-reva-jmk.json CR-2026-11-09-172-P01").action, "preview");
  for (const text of ["approve 123", "/catalogue approve 123\n", "/catalogue approve 123\nanything", "/catalogue approve 123 ", "/catalogue approve 01", "/catalogue approve $(id)", "/catalogue preview ../../app.js ID1", "/catalogue preview catalogue/corrections/a.json ID1;evil"]) assert.throws(() => command(text));
});
test("full frozen proposal preserves provenance and exact mode/row/order/path semantics", () => {
  const doc = pending();
  const id = doc.corrections[0].id;
  assert.equal(proposal(doc, file, id, 172).id, id);
  assert.throws(() => proposal(doc, "app.js", id, 172));
  assert.throws(() => proposal(doc, file, id, 171));
  const rebased = copy(doc); rebased.baseline.commit = "a".repeat(40);
  assert.doesNotThrow(() => sameProposal(doc, rebased));
  for (const mutate of [
    (d) => { d.corrections[0].rationale += "changed"; },
    (d) => { d.corrections[0].provenance.limitations += "changed"; },
    (d) => { d.corrections[0].changes[0].after.counters[0].tier = "S"; },
    (d) => { d.corrections[0].expectedPayloadPaths.pop(); },
    (d) => { d.corrections[0].changes[0].stableKey.mode = "5v5"; }
  ]) { const changed = copy(doc); mutate(changed); assert.throws(() => sameProposal(doc, changed), /changed after preview/); }
  const wrongMode = copy(doc); wrongMode.corrections[0].changes[0].stableKey.mode = "5v5";
  assert.throws(() => proposal(wrongMode, file, id, 172), /identity/);
  assert.throws(() => proposal(pilot, file, id, 172), /pending/);
});
test("immutable preview requires exact successful trusted workflow provenance", () => {
  const info = { id: 12345, repository: { full_name: "nimbrethil81/gac-helper" }, path: ".github/workflows/catalogue-direct.yml", event: "issue_comment", head_branch: "main", head_sha: "a".repeat(40), status: "completed", conclusion: "success", run_attempt: 1, actor: user, triggering_actor: user };
  const frozen = { schema: 1, runId: "12345", commit: info.head_sha, issue: 172, file, document: pending(), effects: [], preview: "complete deterministic preview" };
  frozen.identity = digest({ file, document: frozen.document, preview: frozen.preview, effects: frozen.effects });
  assert.doesNotThrow(() => verifyRun(info, frozen, 172));
  for (const patch of [{ conclusion: "failure" }, { event: "pull_request" }, { path: "evil.yml" }, { head_branch: "attacker" }, { run_attempt: 2 }, { head_sha: "b".repeat(40) }, { actor: { ...user, id: 1 } }]) assert.throws(() => verifyRun({ ...info, ...patch }, frozen, 172));
  assert.throws(() => verifyRun(info, { ...frozen, preview: "altered" }, 172), /identity/);
});
test("release and changed path guards fail closed", () => {
  assert.doesNotThrow(() => releaseCheck({ checksum: "a", catalogueVersion: 1 }, { checksum: "b", catalogueVersion: 2 }));
  for (const after of [{ checksum: "a", catalogueVersion: 2 }, { checksum: "b", catalogueVersion: 1 }, { checksum: "b", catalogueVersion: 3 }]) assert.throws(() => releaseCheck({ checksum: "a", catalogueVersion: 1 }, after));
  const paths = [file, "catalogue/release.json", "catalogue/source/matchups/3v3.json"];
  assert.doesNotThrow(() => changedPaths(paths, file));
  for (const extra of ["app.js", ".github/workflows/ci.yml", "catalogue/source/scoring.json", "catalogue/source/board-config.json", "evil.json"]) assert.throws(() => changedPaths([...paths, extra], file));
  assert.throws(() => changedPaths([file], file), /release/);
});
test("workflow write authority is isolated from preview, untrusted heads and deployment", () => {
  const workflow = fs.readFileSync(".github/workflows/catalogue-direct.yml", "utf8");
  assert.match(workflow, /permissions: \{\}/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_dispatch|pages: write|pull-requests: write|secrets\./);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.doesNotMatch(workflow, /\$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(workflow, /npm test[\s\S]*Publish dedicated branch after gates/);
  const script = fs.readFileSync("scripts/catalogue-direct.js", "utf8");
  assert.match(script, /already exists; reuse its reviewed PR, never replay approval/);
  assert.match(script, /GitHub permission\/API failure/);
  assert.match(script, /GITHUB_TOKEN pushes do not trigger CI/);
});

test("identical array path cannot hide a changed compiled reference after rebaseline", () => {
  const { readSource, compileSource, applyCorrections } = require("../scripts/catalogue-source-lib.js");
  const { diffPayloads } = require("../scripts/catalogue-audit-lib.js");
  const { source } = readSource("catalogue/source");
  const row = copy(source["matchups/3v3.json"].find((row) => row.defence === "Jedi Master Kenobi"));
  const correction = { changes: [{ file: "matchups/3v3.json", operation: "ADD", stableKey: { mode: "3v3", defence: "Synthetic new defence" }, before: "ABSENT", after: { ...row, defence: "Synthetic new defence" } }] };
  const effects = (input) => diffPayloads(compileSource(input), compileSource(applyCorrections(input, [correction])));
  const before = effects(source);
  const moved = copy(source);
  const counter = moved["counters.json"].find((entry) => entry.id === row.counters[0].counterId);
  counter.name += " renamed on main";
  const after = effects(moved);
  assert.deepEqual(before.map((diff) => diff.path), after.map((diff) => diff.path));
  assert.throws(() => sameEffects(before, after), /Compiled before\/after effects changed/);
  assert.doesNotThrow(() => sameEffects(before, copy(before)));
});

test("orchestration exercises preview → authentic approval → engine apply/release and duplicate stop", async (t) => {
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { main } = require("../scripts/catalogue-direct.js");
  const { readSource, compileSource, applyCorrections } = require("../scripts/catalogue-source-lib.js");
  const { diffPayloads } = require("../scripts/catalogue-audit-lib.js");
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gac-direct-"));
  const seed = path.join(temp, "seed");
  const clone = path.join(temp, "clone");
  const runtime = path.join(temp, "runtime");
  fs.mkdirSync(seed); fs.mkdirSync(runtime);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  fs.cpSync(path.join(root, "catalogue/source"), path.join(seed, "catalogue/source"), { recursive: true });
  fs.copyFileSync(path.join(root, "catalogue/release.json"), path.join(seed, "catalogue/release.json"));
  git(seed, "init", "-b", "main"); git(seed, "add", "."); git(seed, "commit", "-m", "Fixture source");
  const doc = pending();
  const { source } = readSource(path.join(seed, "catalogue/source"));
  const before = source["matchups/3v3.json"].find((row) => row.defence === "Jedi Master Kenobi");
  const after = copy(before); after.counters[0].notes += " Synthetic test only.";
  doc.corrections[0].changes = [{ file: "matchups/3v3.json", operation: "AMEND", stableKey: { mode: "3v3", defence: "Jedi Master Kenobi" }, before, after }];
  doc.corrections[0].expectedPayloadPaths = diffPayloads(compileSource(source), compileSource(applyCorrections(source, doc.corrections))).map((diff) => diff.path);
  const release = JSON.parse(fs.readFileSync(path.join(seed, "catalogue/release.json")));
  doc.baseline = { commit: git(seed, "rev-parse", "HEAD"), catalogueVersion: release.catalogueVersion, checksum: release.checksum };
  fs.mkdirSync(path.join(seed, "catalogue/corrections"));
  fs.writeFileSync(path.join(seed, file), JSON.stringify(doc));
  git(seed, "add", "."); git(seed, "commit", "-m", "Pending data only");
  git(temp, "clone", seed, clone);
  const oldEnv = { ...process.env }; const oldFetch = global.fetch;
  t.after(() => { process.chdir(root); process.env = oldEnv; global.fetch = oldFetch; fs.rmSync(temp, { recursive: true, force: true }); });
  process.chdir(clone);
  Object.assign(process.env, { GITHUB_REPOSITORY: "nimbrethil81/gac-helper", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "issue_comment", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "12345", RUNNER_TEMP: runtime, GITHUB_STEP_SUMMARY: path.join(runtime, "summary"), GITHUB_EVENT_PATH: path.join(runtime, "event.json") });
  const created = new Date(Date.now() - 10000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const live = { ...copy(comment), body: `/catalogue preview ${file} ${doc.corrections[0].id}`, created_at: created, updated_at: created, html_url: "https://github.com/nimbrethil81/gac-helper/issues/172#issuecomment-123" };
  const e = { ...copy(event), issue: { number: 172 }, comment: live };
  fs.writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify(e));
  let archive;
  global.fetch = async (url) => {
    const endpoint = String(url).split("gac-helper/")[1];
    let data;
    if (endpoint === "issues/comments/123") data = live;
    else if (endpoint === "collaborators/nimbrethil81/permission") data = { user, permission: "admin" };
    else if (endpoint === "actions/runs/12345") data = { id: 12345, repository: e.repository, path: ".github/workflows/catalogue-direct.yml", event: "issue_comment", head_branch: "main", head_sha: git(seed, "rev-parse", "HEAD"), status: "completed", conclusion: "success", run_attempt: 1, actor: user, triggering_actor: user, updated_at: created };
    else if (endpoint === "actions/runs/12345/artifacts") data = { artifacts: [{ id: 9, name: "catalogue-preview", expired: false, size_in_bytes: 10000 }] };
    else if (endpoint === "actions/artifacts/9/zip") return { ok: true, arrayBuffer: async () => archive };
    else throw new Error(`Unexpected API ${endpoint}`);
    return { ok: true, json: async () => copy(data) };
  };
  await main("preview");
  const frozen = JSON.parse(fs.readFileSync(path.join(runtime, "catalogue-preview/preview.json")));
  assert.match(frozen.preview, /Release gate after change: PASS/);
  assert.equal(frozen.effects.length, 1);
  execFileSync("zip", ["-q", path.join(runtime, "fixture.zip"), "preview.json"], { cwd: path.join(runtime, "catalogue-preview") });
  archive = fs.readFileSync(path.join(runtime, "fixture.zip"));
  git(clone, "restore", file);
  live.body = "/catalogue approve 12345";
  live.created_at = live.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify(e));
  await main("approve");
  const applied = JSON.parse(fs.readFileSync(file));
  assert.equal(applied.corrections[0].status, "APPROVED");
  assert.equal(applied.corrections[0].approval.reference, live.html_url);
  assert.equal(JSON.parse(fs.readFileSync("catalogue/release.json")).catalogueVersion, release.catalogueVersion + 1);
  const result = JSON.parse(fs.readFileSync(path.join(runtime, "catalogue-result.json")));
  assert.deepEqual(result.paths.sort(), [file, "catalogue/release.json", "catalogue/source/matchups/3v3.json"].sort());
  // The previously failing release/site gates must see v(N+1) in *local*
  // first-parent history, without publishing a branch to GitHub yet.
  const { releaseLedger } = require("../scripts/catalogue-release-lib.js");
  assert.equal(git(clone, "rev-parse", "HEAD"), result.applicationCommit);
  assert.equal(git(clone, "rev-parse", "HEAD^"), result.baseCommit);
  assert.equal(git(clone, "status", "--porcelain"), "");
  assert.deepEqual(git(clone, "diff", "--name-only", result.baseCommit, result.applicationCommit).split("\n").sort(), result.paths);
  const localLedger = releaseLedger(clone);
  assert.deepEqual(localLedger.errors, []);
  assert.equal(localLedger.entries.at(-1).catalogueVersion, release.catalogueVersion + 1);
  assert.equal(git(seed, "branch", "--list", result.branch), "", "No implementation branch may be published before validation");
  assert.equal(git(seed, "rev-parse", "main"), result.baseCommit, "Main remains unmodified");
  // Simulate the already-published deterministic branch; a new delivery cannot
  // reapply or advance the catalogue a second time.
  git(clone, "push", "origin", `HEAD:refs/heads/${result.branch}`);
  git(clone, "reset", "--hard", "origin/main");
  git(clone, "switch", "main");
  await assert.rejects(main("approve"), /already exists/);
  assert.equal(JSON.parse(fs.readFileSync("catalogue/release.json")).catalogueVersion, release.catalogueVersion);
  git(seed, "commit", "--allow-empty", "-m", "Concurrent main drift");
  await assert.rejects(main("approve"), /Clean exact fresh main/);
  git(clone, "reset", "--hard", "origin/main");
  live.body = `/catalogue preview ${file} ${doc.corrections[0].id}`;
  fs.writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify(e));
  const invalid = copy(doc);
  invalid.corrections[0].expectedPayloadPaths = ['payload["wrong"]'];
  fs.writeFileSync(path.join(seed, file), JSON.stringify(invalid));
  git(seed, "add", "."); git(seed, "commit", "-m", "Invalid expected compiled paths fixture");
  git(clone, "fetch", "origin", "main"); git(clone, "reset", "--hard", "origin/main");
  await assert.rejects(main("preview"), /compiled impact differs/);
  invalid.corrections[0].expectedPayloadPaths = doc.corrections[0].expectedPayloadPaths;
  invalid.corrections[0].changes[0].after.counters[0].tier = "INVALID";
  fs.writeFileSync(path.join(seed, file), JSON.stringify(invalid));
  git(seed, "add", "."); git(seed, "commit", "-m", "Release gate failure fixture");
  git(clone, "fetch", "origin", "main"); git(clone, "reset", "--hard", "origin/main");
  await assert.rejects(main("preview"), /release gate/);
  assert.equal(JSON.parse(fs.readFileSync("catalogue/release.json")).catalogueVersion, release.catalogueVersion);
  global.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(main("classify"), /permission\/API failure \(403\)/);
});
