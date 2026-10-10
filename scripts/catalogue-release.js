#!/usr/bin/env node
"use strict";

// Static catalogue release for GitHub Pages (issue #42, ADR-ARCH-116 §7–§9).
// Procedure: docs/CATALOGUE_SOURCE.md.
//
//   ledger
//       List the releases recorded on the first-parent history of HEAD and fail
//       on a reused or decreasing version.
//   site --out <dir>
//       Build and verify the complete allow-listed Pages artifact.
//   guard --site <dir> --url <pages base url>
//       Before deployment: refuse if the live release is newer or contradicts
//       the artifact.
//   verify --site <dir> --url <pages base url> [--timeout <s>] [--interval <s>]
//       After deployment: wait until the live catalogue is byte-identical to the
//       artifact, or fail.
//   restore --version <N>
//       Rollback: write the committed source of release N into catalogue/source/.
//
// Exit codes: 0 ok, 1 check failure, 2 unusable input.

const path = require("node:path");

const { buildSite, checkLiveBeforeDeploy, releaseLedger, restoreSource, verifyLive } = require("./catalogue-release-lib.js");

const REPO = path.resolve(__dirname, "..");

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = { "--out": "out", "--site": "site", "--url": "url", "--timeout": "timeout", "--interval": "interval", "--version": "version", "--repo": "repo" }[arg];
    if (!name) throw new Error(`Unknown argument: ${arg}`);
    if (argv[index + 1] === undefined) throw new Error(`${arg} needs a value`);
    options[name] = argv[(index += 1)];
  }
  return options;
}

class UsageError extends Error {}

function need(options, ...names) {
  for (const name of names) if (!options[name]) throw new UsageError(`--${name} is required`);
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const COMMANDS = {
  ledger(options) {
    const { entries, errors } = releaseLedger(options.repo ?? REPO);
    return {
      exitCode: errors.length ? 1 : 0,
      lines: [...entries.map((entry) => `v${entry.catalogueVersion} ${entry.checksum} recorded at ${entry.sourceCommit}`), ...errors.map((error) => `ERROR ${error}`)]
    };
  },

  site(options) {
    need(options, "out");
    const result = buildSite({ repo: options.repo ?? REPO, out: options.out });
    return {
      exitCode: 0,
      lines: [
        `Built ${result.files.length} files into ${options.out} from ${result.head}`,
        `Current: v${result.pointer.catalogueVersion} ${result.pointer.checksum} → catalogue/${result.pointer.path}`,
        `Retained: ${result.manifest.releases.map((entry) => `v${entry.catalogueVersion}`).join(", ")}`,
        ...result.skipped.map((entry) => `Not retained: v${entry.catalogueVersion} (${entry.reason})`),
        `Sizes: pointer ${result.sizes.pointer} B, manifest ${result.sizes.manifest} B, current release ${kib(result.sizes.current)}, catalogue/ ${kib(result.sizes.catalogue)}`
      ]
    };
  },

  async guard(options) {
    need(options, "site", "url");
    return { exitCode: 0, lines: (await checkLiveBeforeDeploy({ site: options.site, baseUrl: options.url })).lines };
  },

  async verify(options) {
    need(options, "site", "url");
    const seconds = (value, fallback) => (value === undefined ? fallback : Number(value) * 1000);
    const result = await verifyLive({
      site: options.site,
      baseUrl: options.url,
      timeoutMs: seconds(options.timeout, undefined),
      intervalMs: seconds(options.interval, undefined)
    });
    return { exitCode: 0, lines: result.lines };
  },

  restore(options) {
    need(options, "version");
    const catalogueVersion = Number(options.version);
    if (!Number.isSafeInteger(catalogueVersion) || catalogueVersion < 1) throw new UsageError("--version must be a positive integer");
    const entry = restoreSource({ repo: options.repo ?? REPO, catalogueVersion });
    return {
      exitCode: 0,
      lines: [
        `Restored catalogue/source/ to v${entry.catalogueVersion} (${entry.checksum}, recorded at ${entry.sourceCommit}).`,
        "Next: npm run catalogue:release (records it as a new, higher version), commit, open a PR, merge, then run Deploy Pages Live."
      ]
    };
  }
};

// Check failures (gate, drift, ledger, live mismatch) exit 1; usage errors exit 2.
async function run(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) return { exitCode: 2, lines: [`Usage: catalogue-release.js ${Object.keys(COMMANDS).join("|")} ...`] };
  let options;
  try {
    options = parseOptions(rest);
  } catch (error) {
    return { exitCode: 2, lines: [`${command}: ${error.message}`] };
  }
  try {
    return await COMMANDS[command](options);
  } catch (error) {
    return { exitCode: error instanceof UsageError ? 2 : 1, lines: [`${command} failed: ${error.message}`] };
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((result) => {
    for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
    process.exitCode = result.exitCode;
  });
}

module.exports = { run };
