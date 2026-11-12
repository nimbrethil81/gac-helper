#!/usr/bin/env node
"use strict";

// Trusted main orchestration only. Proposal JSON is data, never executable input.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { run } = require("./catalogue-build.js");
const { validateModernCorrections, contentChecksum, readSource, compileSource, applyCorrections } = require("./catalogue-source-lib.js");
const { diffPayloads } = require("./catalogue-audit-lib.js");
const REPO = "nimbrethil81/gac-helper";
const OWNER = { login: "nimbrethil81", id: 291301639 };
const WORKFLOW = ".github/workflows/catalogue-direct.yml";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message) => { throw new Error(message); };
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function command(body) {
  if (typeof body !== "string" || /[\r\n]/.test(body)) fail("Only one exact command line is accepted.");
  let match = /^\/catalogue preview (catalogue\/corrections\/[a-z0-9][a-z0-9-]*\.json) ([A-Z0-9][A-Z0-9._-]{2,127})$/.exec(body);
  if (match) return { action: "preview", file: match[1], id: match[2] };
  match = /^\/catalogue approve ([1-9][0-9]{0,15})$/.exec(body);
  if (match && Number.isSafeInteger(Number(match[1]))) return { action: "approve", runId: match[1] };
  fail("Unrecognised command; use the exact documented syntax.");
}
function owner(user) {
  if (user?.id !== OWNER.id || user?.login !== OWNER.login || user?.type !== "User") fail("Authenticated repository owner required; bots are refused.");
}
function verifyEvent(event, live, now = Date.now()) {
  if (event.action !== "created" || event.repository?.full_name !== REPO || event.issue?.pull_request) fail("Only newly created issue comments in the authorised repository are accepted.");
  owner(event.sender); owner(event.comment?.user); owner(live.user);
  if (!Number.isSafeInteger(event.issue.number) || !Number.isSafeInteger(live.id)) fail("Invalid issue/comment identity.");
  const anchor = `https://github.com/${REPO}/issues/${event.issue.number}#issuecomment-${live.id}`;
  for (const key of ["id", "body", "created_at", "updated_at", "html_url"]) if (event.comment[key] !== live[key]) fail("Comment changed or event does not match GitHub.");
  if (live.html_url !== anchor || live.created_at !== live.updated_at || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(live.created_at)) fail("Edited or incorrectly anchored decision refused.");
  const age = now - Date.parse(live.created_at);
  if (!Number.isFinite(age) || age < -60000 || age > 86400000) fail("Outdated event; create a fresh decision after inspecting the preview.");
  return command(live.body);
}
function proposal(document, file, id, issue) {
  if (!/^catalogue\/corrections\/[a-z0-9][a-z0-9-]*\.json$/.test(file)) fail("Correction path is not allowlisted.");
  if (document.schema !== 2) fail("Schema 2 required.");
  validateModernCorrections(document);
  if (document.issue !== `https://github.com/${REPO}/issues/${issue}`) fail("Proposal must belong to this exact issue.");
  if (document.corrections.length !== 1 || document.corrections[0].id !== id) fail("One exact proposal ID per direct run required.");
  const correction = document.corrections[0];
  if (correction.status !== "PENDING_OWNER_APPROVAL" || correction.approval !== null || !correction.expectedPayloadPaths.length) fail("An unapplied pending proposal with complete compiled paths is required.");
  return correction;
}
function sameProposal(frozen, current) {
  // Baseline alone may move. Provenance, rationale and every other byte of the
  // parsed proposal remain covered, beyond the engine's row content checksum.
  if (!isDeepStrictEqual({ ...frozen, baseline: null }, { ...current, baseline: null })) fail("Exact proposal changed after preview; owner decision needed.");
}
function compiledEffects(document) {
  const { source, findings } = readSource("catalogue/source");
  if (findings.length) fail("Unreadable source when comparing compiled effects.");
  return diffPayloads(compileSource(source), compileSource(applyCorrections(source, document.corrections)));
}
function sameEffects(expected, actual) {
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), JSON.parse(JSON.stringify(actual)))) fail("Compiled before/after effects changed after preview; owner decision needed.");
}
function verifyRun(runInfo, frozen, issue) {
  if (runInfo.repository?.full_name !== REPO || runInfo.path !== WORKFLOW || runInfo.event !== "issue_comment" || runInfo.head_branch !== "main" || runInfo.status !== "completed" || runInfo.conclusion !== "success" || runInfo.run_attempt !== 1) fail("Preview workflow provenance is unverified.");
  owner(runInfo.actor); owner(runInfo.triggering_actor);
  if (frozen.schema !== 1 || frozen.runId !== String(runInfo.id) || frozen.commit !== runInfo.head_sha || frozen.issue !== issue || frozen.identity !== digest({ file: frozen.file, document: frozen.document, preview: frozen.preview, effects: frozen.effects })) fail("Preview artifact identity mismatch.");
  proposal(frozen.document, frozen.file, frozen.document?.corrections?.[0]?.id, issue);
}
function engine(args) {
  const result = run(args);
  if (result.exitCode) fail(result.lines.join("\n"));
  return result.lines.join("\n");
}
function releaseCheck(before, after) {
  if (after.checksum === before.checksum || after.catalogueVersion !== before.catalogueVersion + 1) fail("Expected exactly one changed-checksum release bump.");
}
function changedPaths(paths, file) {
  if (!paths.length || paths.some((item) => item !== file && item !== "catalogue/release.json" && !/^catalogue\/source\/(?:matchups\/(?:3v3|5v5|FLEET)|units|counters|defence-teams|defence-compositions|ship-pilots)\.json$/.test(item))) fail("Unexpected application/schema/scoring/workflow path; coding-agent review required.");
  if (!paths.includes(file) || !paths.includes("catalogue/release.json")) fail("Missing approval record or release bump.");
}
async function api(endpoint, raw = false) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) fail(`GitHub permission/API failure (${response.status}): ${endpoint}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}
async function authenticate(event) {
  const live = await api(`issues/comments/${event.comment?.id}`);
  const parsed = verifyEvent(event, live);
  const permission = await api(`collaborators/${OWNER.login}/permission`);
  if (permission.user?.id !== OWNER.id || permission.permission !== "admin") fail("Owner admin permission could not be verified.");
  return { parsed, live };
}
function fresh() {
  git("fetch", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main") || git("status", "--porcelain")) fail("Clean exact fresh main required.");
}
async function main(mode) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_EVENT_NAME !== "issue_comment" || process.env.GITHUB_RUN_ATTEMPT !== "1") fail("Trusted first-attempt main issue-comment execution required.");
  const { parsed, live } = await authenticate(event);
  if (mode === "classify") {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `action=${parsed.action}\n`);
    return;
  }
  if (mode !== parsed.action) fail("Workflow command/action mismatch.");
  fresh();
  const issue = event.issue.number;
  if (mode === "preview") {
    const original = JSON.parse(fs.readFileSync(parsed.file, "utf8"));
    proposal(original, parsed.file, parsed.id, issue);
    engine(["release", "--check"]);
    engine(["corrections", parsed.file, "--rebaseline"]);
    const document = JSON.parse(fs.readFileSync(parsed.file, "utf8"));
    const preview = engine(["corrections", parsed.file, "--preview", parsed.id]);
    const frozen = { schema: 1, runId: process.env.GITHUB_RUN_ID, commit: git("rev-parse", "HEAD"), issue, file: parsed.file, document, preview, effects: compiledEffects(document) };
    frozen.identity = digest({ file: frozen.file, document, preview, effects: frozen.effects });
    fs.mkdirSync(path.join(process.env.RUNNER_TEMP, "catalogue-preview"), { recursive: true });
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "catalogue-preview", "preview.json"), JSON.stringify(frozen, null, 2));
    const summary = `# Exact catalogue preview\n\nIssue #${issue}; ${parsed.id}; baseline ${frozen.commit}.\n\nArtifact identity: ${frozen.identity}\n\n${preview}\n\nComplete proposal (including evidence):\n${JSON.stringify(document, null, 2)}\n\nAfter reviewing all rows, effects and evidence, post this single exact decision on issue #${issue}:\n/catalogue approve ${frozen.runId}\n\nThis approves content only; independent PR review, CI, merge and deployment remain separate.\n`;
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "catalogue-preview", "preview.txt"), summary);
    // Treat all proposal text as plain text in the Actions summary.
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `<pre>${summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n`);
    return;
  }
  const info = await api(`actions/runs/${parsed.runId}`);
  const artifacts = await api(`actions/runs/${parsed.runId}/artifacts`);
  const matches = artifacts.artifacts.filter((item) => item.name === "catalogue-preview" && !item.expired);
  if (matches.length !== 1 || matches[0].size_in_bytes > 2000000) fail("Missing, expired or ambiguous immutable preview artifact.");
  const archive = await api(`actions/artifacts/${matches[0].id}/zip`, true);
  const zip = path.join(process.env.RUNNER_TEMP, "catalogue-preview.zip");
  fs.writeFileSync(zip, archive);
  const frozen = JSON.parse(execFileSync("unzip", ["-p", zip, "preview.json"], { encoding: "utf8", maxBuffer: 2000000 }));
  verifyRun(info, frozen, issue);
  if (Date.parse(live.created_at) <= Date.parse(info.updated_at)) fail("Approval must follow the completed machine preview.");
  // Only a main ancestor can have produced an approvable preview.
  git("merge-base", "--is-ancestor", frozen.commit, "HEAD");
  const file = frozen.file;
  const id = frozen.document.corrections[0].id;
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  sameProposal(frozen.document, current);
  const branch = `catalogue-direct/${id}`;
  if (git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)) fail(`Proposal branch ${branch} already exists; reuse its reviewed PR, never replay approval.`);
  git("switch", "-c", branch);
  engine(["corrections", file, "--rebaseline"]);
  engine(["corrections", file, "--preview", id]);
  sameEffects(frozen.effects, compiledEffects(JSON.parse(fs.readFileSync(file, "utf8"))));
  engine(["corrections", file, "--record-approval", id, "--decision", live.html_url, "--decided-at", live.created_at]);
  engine(["corrections", file, "--apply", id]);
  const before = JSON.parse(fs.readFileSync("catalogue/release.json", "utf8"));
  engine(["release"]);
  releaseCheck(before, JSON.parse(fs.readFileSync("catalogue/release.json", "utf8")));
  engine(["compile", "--gate", "release"]);
  engine(["release", "--check"]);
  const paths = git("diff", "--name-only").split("\n");
  changedPaths(paths, file);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "catalogue-result.json"), JSON.stringify({ branch, file, id, decision: live.html_url, checksum: contentChecksum(frozen.document.corrections[0]), preview: `https://github.com/${REPO}/actions/runs/${parsed.runId}`, identity: frozen.identity, paths }, null, 2));
}
async function publish() {
  // Called only after every required gate, without executing proposed code.
  const result = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_TEMP, "catalogue-result.json"), "utf8"));
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  await authenticate(event); // Refuse an edited/deleted approval during validation.
  git("fetch", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("Main moved during checks; stop and revalidate with a fresh preview.");
  changedPaths(git("diff", "--name-only").split("\n"), result.file);
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", "--", ...result.paths);
  git("commit", "-m", `Apply catalogue proposal ${result.id}`);
  // A non-force push is the atomic replay/race guard. Credentials exist only
  // for this one process; checkout never persists them in the worktree.
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64");
  try {
    execFileSync("git", ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, "push", `--force-with-lease=refs/heads/${result.branch}:`, "origin", `HEAD:refs/heads/${result.branch}`], { stdio: "pipe" });
  } catch {
    // execFile errors include argv, which contains the short-lived token.
    fail("Branch publication failed (permission, race or transport); inspect remote state before retrying. Credentials are withheld from logs.");
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Catalogue branch ready for independent review\n\nBranch: ${result.branch}\n\nDecision: ${result.decision}\n\nPreview: ${result.preview}\n\nChecksum: ${result.checksum}\n\nChanged paths: ${result.paths.join(", ")}\n\nAll local gates passed. ChatGPT must open the implementation PR with its authenticated GitHub connector. GITHUB_TOKEN pushes do not trigger CI: required CI must run on that PR's exact head SHA before review/merge. No merge or deployment performed.\n`);
}
if (require.main === module) (process.argv[2] === "publish" ? publish() : main(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, compiledEffects, sameEffects, command, verifyEvent, proposal, sameProposal, verifyRun, releaseCheck, changedPaths, digest };
