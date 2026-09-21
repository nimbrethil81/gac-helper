#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertPayloadContract, canonicalJson } = require("./baseline-lib.js");

function main() {
  const [inputFilename, outputDirectory] = process.argv.slice(2);
  if (!inputFilename || !outputDirectory) {
    throw new Error("Usage: node scripts/materialize-baseline-payload.js <raw-json> <output-directory>");
  }

  const raw = fs.readFileSync(inputFilename);
  const payload = JSON.parse(raw.toString("utf8"));
  assertPayloadContract(payload);

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "apps-script-action-data.raw.json"), raw);
  fs.writeFileSync(
    path.join(outputDirectory, "apps-script-action-data.canonical.json"),
    canonicalJson(payload),
    "utf8"
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
