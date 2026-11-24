"use strict";

const { sha256 } = require("./baseline-lib.js");

const APP_BUILD_PATH = "app-build.json";
const APP_BUILD_CONTRACT = "gac-app-build:v1";
const SHELL_RECIPE_VERSION = 1;
const PAGES_APP_FILES = Object.freeze([
  "index.html", "app.js", "app-updates.js", "styles.css", "manifest.json", "service-worker.js", "icon-192.png", "icon-512.png"
]);

const DEV_BUILD_ID = "__GAC_BUILD_ID__";
const STAMPED_FILES = ["index.html", "app.js", "app-updates.js", "manifest.json", "service-worker.js"];
const DEV_SHELL_FILES = "/* gac shell files */ []";
const SHELL_FILES = `/* gac shell files */ ${JSON.stringify(PAGES_APP_FILES)}`;
const BUILD_ID = /^[0-9a-f]{64}$/;

function assetRecord(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function shellIdentity(files) {
  // Paths, byte lengths and content digests make the input unambiguous. The
  // recipe version changes when the transformations below change semantics.
  const inputs = PAGES_APP_FILES.map((file) => [file, assetRecord(files[file])]);
  return sha256(JSON.stringify([SHELL_RECIPE_VERSION, inputs]));
}

function appVersion(files) {
  const version = files["app.js"].toString("utf8").match(/^const APP_VERSION = "([0-9]+(?:\.[0-9]+)+)";$/m)?.[1];
  if (!version) throw new Error("app.js is missing its APP_VERSION declaration");
  return version;
}

function replaceMarker(text, marker, replacement, file) {
  if (!text.includes(marker)) throw new Error(`${file} is missing an app build marker`);
  return text.replaceAll(marker, replacement);
}

function stampShell(files, buildId, reverse = false) {
  const stamped = { ...files };
  for (const file of STAMPED_FILES) {
    const text = replaceMarker(files[file].toString("utf8"), reverse ? buildId : DEV_BUILD_ID, reverse ? DEV_BUILD_ID : buildId, file);
    stamped[file] = Buffer.from(file === "service-worker.js" || file === "app-updates.js"
      ? replaceMarker(text, reverse ? SHELL_FILES : DEV_SHELL_FILES, reverse ? DEV_SHELL_FILES : SHELL_FILES, file)
      : text);
  }
  return stamped;
}

function buildAppShell(read) {
  const original = Object.fromEntries(PAGES_APP_FILES.map((file) => [file, read(file)]));
  const buildId = shellIdentity(original);
  const files = stampShell(original, buildId);
  const metadata = {
    contract: APP_BUILD_CONTRACT,
    buildId,
    version: appVersion(original),
    assets: Object.fromEntries(PAGES_APP_FILES.map((file) => [file, assetRecord(files[file])]))
  };
  return { files, metadata };
}

function verifyAppShell(read) {
  const metadata = JSON.parse(read(APP_BUILD_PATH).toString("utf8"));
  if (Object.keys(metadata ?? {}).sort().join() !== "assets,buildId,contract,version" || metadata.contract !== APP_BUILD_CONTRACT ||
      !BUILD_ID.test(metadata.buildId) || Object.keys(metadata.assets ?? {}).sort().join() !== [...PAGES_APP_FILES].sort().join()) {
    throw new Error(`${APP_BUILD_PATH} has an unexpected shape`);
  }
  const files = Object.fromEntries(PAGES_APP_FILES.map((file) => {
    const bytes = read(file);
    const record = assetRecord(bytes);
    const expected = metadata.assets[file];
    if (Object.keys(expected ?? {}).sort().join() !== "bytes,sha256" || record.bytes !== expected.bytes || record.sha256 !== expected.sha256) {
      throw new Error(`${file} is corrupted (bytes or sha256 differ from ${APP_BUILD_PATH})`);
    }
    return [file, bytes];
  }));
  const original = stampShell(files, metadata.buildId, true);
  if (shellIdentity(original) !== metadata.buildId || appVersion(original) !== metadata.version) {
    throw new Error(`${APP_BUILD_PATH} does not match the deterministic shell identity and version`);
  }
  return metadata;
}

module.exports = { APP_BUILD_PATH, PAGES_APP_FILES, buildAppShell, verifyAppShell };
