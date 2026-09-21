#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  REQUIRED_PAYLOAD_KEYS,
  assertPayloadContract,
  canonicalJson,
  countPayloadDomains,
  listFilesRecursively,
  parseCsv,
  semanticJsonEqual,
  sha256
} = require("./baseline-lib.js");

const SECRET_FIELD_PATTERN = /(?:apikey|authorization|cookie|credential|oauth|password|secret|token|connectionstring|endpointurl)/;

function requireFile(root, filename, expectedBytes, expectedSha) {
  const absolute = path.join(root, filename);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Missing listed file: ${filename}`);
  }
  const bytes = fs.readFileSync(absolute);
  if (bytes.length !== expectedBytes) {
    throw new Error(`Byte size differs for ${filename}: expected ${expectedBytes}, got ${bytes.length}`);
  }
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`SHA-256 differs for ${filename}: expected ${expectedSha}, got ${actualSha}`);
  }
  return bytes;
}

function assertNoSecretFields(value, location = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SECRET_FIELD_PATTERN.test(normalizedKey)) {
      throw new Error(`Prohibited secret-like manifest field at ${location}.${key}`);
    }
    assertNoSecretFields(child, `${location}.${key}`);
  }
}

function verifyBaseline(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assertNoSecretFields(manifest);

  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  if (canonicalJson(manifest) !== manifestText) throw new Error("manifest.json is not deterministically canonicalized");

  const expectedFiles = new Set(["manifest.json"]);
  const rawBytes = requireFile(
    root,
    manifest.appsScriptPayload.rawFilename,
    manifest.appsScriptPayload.rawByteSize,
    manifest.appsScriptPayload.rawSha256
  );
  expectedFiles.add(manifest.appsScriptPayload.rawFilename);

  let rawPayload;
  try {
    rawPayload = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Raw payload is not valid JSON: ${error.message}`);
  }
  assertPayloadContract(rawPayload);

  const canonicalBytes = requireFile(
    root,
    manifest.appsScriptPayload.canonicalFilename,
    manifest.appsScriptPayload.canonicalByteSize,
    manifest.appsScriptPayload.canonicalSha256
  );
  expectedFiles.add(manifest.appsScriptPayload.canonicalFilename);
  let canonicalPayload;
  try {
    canonicalPayload = JSON.parse(canonicalBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Canonical payload is not valid JSON: ${error.message}`);
  }
  if (!semanticJsonEqual(rawPayload, canonicalPayload)) {
    throw new Error("Raw and canonical payloads are not semantically equal");
  }
  if (canonicalBytes.toString("utf8") !== canonicalJson(rawPayload)) {
    throw new Error("Canonical payload is not deterministically formatted");
  }

  if (!semanticJsonEqual(Object.keys(rawPayload), manifest.appsScriptPayload.topLevelKeys)) {
    throw new Error("Payload top-level keys differ from the manifest");
  }
  if (!semanticJsonEqual(REQUIRED_PAYLOAD_KEYS, manifest.appsScriptPayload.topLevelKeys)) {
    throw new Error("Manifest does not record the exact current payload key order");
  }
  const payloadCounts = countPayloadDomains(rawPayload);
  if (!semanticJsonEqual(payloadCounts, manifest.appsScriptPayload.domainCounts)) {
    throw new Error("Payload-domain counts differ from the manifest");
  }

  const rowCounts = {};
  for (const sheet of manifest.sheetExports) {
    const bytes = requireFile(root, sheet.filename, sheet.byteSize, sheet.sha256);
    expectedFiles.add(sheet.filename);
    const rows = parseCsv(bytes.toString("utf8"));
    if (rows.length === 0) throw new Error(`CSV is empty: ${sheet.filename}`);
    if (!semanticJsonEqual(rows[0], sheet.headers)) {
      throw new Error(`CSV header differs from manifest: ${sheet.filename}`);
    }
    const dataRows = rows.length - 1;
    if (dataRows !== sheet.dataRowCount) {
      throw new Error(`CSV row count differs for ${sheet.filename}: expected ${sheet.dataRowCount}, got ${dataRows}`);
    }
    rowCounts[sheet.tabName] = dataRows;
  }
  if (!semanticJsonEqual(rowCounts, manifest.aggregateRowCounts.sheetDataRows)) {
    throw new Error("Aggregate Sheet row counts differ from the manifest");
  }

  const report = manifest.report;
  requireFile(root, report.filename, report.byteSize, report.sha256);
  expectedFiles.add(report.filename);

  const actualFiles = listFilesRecursively(root);
  const unexpected = actualFiles.filter((filename) => !expectedFiles.has(filename));
  const missing = [...expectedFiles].filter((filename) => !actualFiles.includes(filename));
  if (unexpected.length || missing.length) {
    throw new Error(`Baseline file set differs (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
  }

  return {
    captureTimestamp: manifest.captureTimestamp,
    rawByteSize: rawBytes.length,
    rawSha256: sha256(rawBytes),
    exportedTabs: manifest.sheetExports.length,
    sheetRowCounts: rowCounts,
    payloadDomainCounts: payloadCounts
  };
}

function findBaselines(root) {
  if (!fs.existsSync(root)) throw new Error(`Baseline root does not exist: ${root}`);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "manifest.json")))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function main() {
  const requested = process.argv[2];
  const roots = requested ? [path.resolve(requested)] : findBaselines(path.resolve("data/exports"));
  if (roots.length === 0) throw new Error("No baseline manifests found");
  for (const root of roots) {
    const summary = verifyBaseline(root);
    console.log(`Baseline verified: ${path.basename(root)}`);
    console.log(`  Capture: ${summary.captureTimestamp}`);
    console.log(`  Payload: ${summary.rawByteSize} bytes, sha256 ${summary.rawSha256}`);
    console.log(`  Tabs: ${summary.exportedTabs}`);
    console.log(`  Sheet rows: ${JSON.stringify(summary.sheetRowCounts)}`);
    console.log(`  Payload counts: ${JSON.stringify(summary.payloadDomainCounts)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Baseline verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { assertNoSecretFields, findBaselines, verifyBaseline };
