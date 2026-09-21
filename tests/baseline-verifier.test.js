"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertPayloadContract,
  canonicalJson,
  parseCsv,
  semanticJsonEqual
} = require("../scripts/baseline-lib.js");
const { assertNoSecretFields, verifyBaseline } = require("../scripts/verify-baseline.js");

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

test("verifier detects fixture corruption", () => {
  const source = path.resolve("data/exports/20260921T085937Z");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arch103-verifier-test-"));
  const copy = path.join(temporaryRoot, "baseline");
  try {
    fs.cpSync(source, copy, { recursive: true });
    assert.doesNotThrow(() => verifyBaseline(copy));
    fs.appendFileSync(path.join(copy, "apps-script-action-data.raw.json"), "\n");
    assert.throws(() => verifyBaseline(copy), /Byte size differs|SHA-256 differs/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
