"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertPayloadContract,
  canonicalJson,
  countPayloadDomains,
  parseCsv,
  semanticJsonEqual,
  sha256
} = require("../scripts/baseline-lib.js");
const { assertNoSecretFields, verifyBaseline } = require("../scripts/verify-baseline.js");

function createSyntheticBaseline() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arch103-verifier-test-"));
  const root = path.join(temporaryRoot, "baseline");
  fs.mkdirSync(path.join(root, "sheets"), { recursive: true });

  const payload = {
    counters: {},
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };
  const raw = `${JSON.stringify(payload)}\n`;
  const canonical = canonicalJson(payload);
  const csv = "ID\nROW_1\n";
  const report = "# Synthetic capture report\n";
  fs.writeFileSync(path.join(root, "apps-script-action-data.raw.json"), raw);
  fs.writeFileSync(path.join(root, "apps-script-action-data.canonical.json"), canonical);
  fs.writeFileSync(path.join(root, "sheets", "Synthetic.csv"), csv);
  fs.writeFileSync(path.join(root, "capture-report.md"), report);

  const manifest = {
    aggregateRowCounts: { sheetDataRows: { Synthetic: 1 } },
    appsScriptPayload: {
      canonicalByteSize: Buffer.byteLength(canonical),
      canonicalFilename: "apps-script-action-data.canonical.json",
      canonicalSha256: sha256(canonical),
      domainCounts: countPayloadDomains(payload),
      rawByteSize: Buffer.byteLength(raw),
      rawFilename: "apps-script-action-data.raw.json",
      rawSha256: sha256(raw),
      topLevelKeys: Object.keys(payload)
    },
    captureTimestamp: "2026-09-21T00:00:00Z",
    report: {
      byteSize: Buffer.byteLength(report),
      filename: "capture-report.md",
      sha256: sha256(report)
    },
    schemaVersion: 1,
    sheetExports: [{
      byteSize: Buffer.byteLength(csv),
      dataRowCount: 1,
      filename: "sheets/Synthetic.csv",
      headers: ["ID"],
      sha256: sha256(csv),
      tabName: "Synthetic"
    }]
  };
  fs.writeFileSync(path.join(root, "manifest.json"), canonicalJson(manifest));
  return { manifest, root, temporaryRoot };
}

function updateManifest(root, mutate) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
}

function withSyntheticBaseline(run) {
  const baseline = createSyntheticBaseline();
  try {
    run(baseline);
  } finally {
    fs.rmSync(baseline.temporaryRoot, { recursive: true, force: true });
  }
}

function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`symbolic-link creation unavailable on this platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test("CSV parser preserves quoted commas, newlines, quotes, and empty trailing cells", () => {
  const rows = parseCsv('id,note,tail\n1,"comma, and\nnewline","quoted ""word""",\n');
  assert.deepEqual(rows, [
    ["id", "note", "tail"],
    ["1", "comma, and\nnewline", 'quoted "word"', ""]
  ]);
});

test("CSV parser treats CRLF and LF as equivalent row separators", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), parseCsv("a,b\n1,2\n"));
});

test("canonical JSON is semantically equal independent of formatting and key order", () => {
  const compact = JSON.parse('{"b":[2,1],"a":{"z":true,"x":null}}');
  const formatted = JSON.parse(canonicalJson(compact));
  assert.equal(semanticJsonEqual(compact, formatted), true);
  assert.equal(canonicalJson(compact), '{\n  "a": {\n    "x": null,\n    "z": true\n  },\n  "b": [\n    2,\n    1\n  ]\n}\n');
});

test("payload contract rejects missing keys and incorrect types", () => {
  const valid = {
    counters: {},
    counterDefinitions: {},
    characterDefinitions: {},
    boardConfig: {},
    scoring: [],
    defenceTeams: {},
    defenceCompositions: {}
  };
  assert.doesNotThrow(() => assertPayloadContract(valid));
  assert.throws(() => assertPayloadContract({ ...valid, scoring: {} }), /scoring must be array/);
  const { defenceCompositions: _removed, ...missing } = valid;
  assert.throws(() => assertPayloadContract(missing), /Payload keys differ/);
});

test("manifest field scan rejects secret-like keys", () => {
  assert.doesNotThrow(() => assertNoSecretFields({ rawSha256: "abc", captureTimestamp: "now" }));
  assert.throws(() => assertNoSecretFields({ metadata: { authorizationHeader: "value" } }), /secret-like/);
});

test("verifier accepts a legitimate synthetic baseline and detects checksum corruption", () => {
  withSyntheticBaseline(({ root }) => {
    assert.doesNotThrow(() => verifyBaseline(root));
    fs.appendFileSync(path.join(root, "apps-script-action-data.raw.json"), "\n");
    assert.throws(() => verifyBaseline(root), /Byte size differs|SHA-256 differs/);
  });
});

for (const [name, filename, pattern] of [
  ["parent traversal", "../outside.json", /\. or \.\. segments/],
  ["nested traversal", "sheets/../../outside.json", /\. or \.\. segments/],
  ["absolute POSIX path", "/tmp/outside.json", /absolute POSIX path/],
  ["absolute Windows path", "C:\\outside.json", /absolute Windows path/],
  ["Windows drive-relative path", "C:outside.json", /drive-relative path/],
  ["backslash traversal", "..\\outside.json", /backslashes/]
]) {
  test(`verifier rejects ${name}`, () => {
    withSyntheticBaseline(({ root }) => {
      updateManifest(root, (manifest) => {
        manifest.appsScriptPayload.rawFilename = filename;
      });
      assert.throws(() => verifyBaseline(root), pattern);
    });
  });
}

test("verifier rejects a final fixture symlink to a file outside the capture root", (t) => {
  withSyntheticBaseline(({ root, temporaryRoot }) => {
    const rawPath = path.join(root, "apps-script-action-data.raw.json");
    const outside = path.join(temporaryRoot, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.rmSync(rawPath);
    if (!createSymlinkOrSkip(t, outside, rawPath, "file")) return;
    assert.throws(() => verifyBaseline(root), /Symbolic links are not allowed/);
  });
});

test("verifier rejects a final fixture symlink to a file inside the capture root", (t) => {
  withSyntheticBaseline(({ root }) => {
    const rawPath = path.join(root, "apps-script-action-data.raw.json");
    fs.rmSync(rawPath);
    if (!createSymlinkOrSkip(t, "apps-script-action-data.canonical.json", rawPath, "file")) return;
    assert.throws(() => verifyBaseline(root), /Symbolic links are not allowed/);
  });
});

test("verifier rejects an intermediate directory symlink outside the capture root", (t) => {
  withSyntheticBaseline(({ root, temporaryRoot }) => {
    const outside = path.join(temporaryRoot, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "payload.json"), "{}\n");
    if (!createSymlinkOrSkip(t, outside, path.join(root, "linked"), "dir")) return;
    updateManifest(root, (manifest) => {
      manifest.appsScriptPayload.rawFilename = "linked/payload.json";
    });
    assert.throws(() => verifyBaseline(root), /Symbolic links are not allowed/);
  });
});

test("verifier rejects a manifest path that names a directory", () => {
  withSyntheticBaseline(({ root }) => {
    updateManifest(root, (manifest) => {
      manifest.appsScriptPayload.rawFilename = "sheets";
    });
    assert.throws(() => verifyBaseline(root), /not a regular file/);
  });
});

test("verifier rejects an unexpected ordinary file", () => {
  withSyntheticBaseline(({ root }) => {
    fs.writeFileSync(path.join(root, "unexpected.txt"), "unexpected\n");
    assert.throws(() => verifyBaseline(root), /unexpected: unexpected\.txt/);
  });
});

test("verifier rejects an unexpected symlink", (t) => {
  withSyntheticBaseline(({ root }) => {
    if (!createSymlinkOrSkip(t, "capture-report.md", path.join(root, "unexpected-link"), "file")) return;
    assert.throws(() => verifyBaseline(root), /Symbolic links are not allowed/);
  });
});
