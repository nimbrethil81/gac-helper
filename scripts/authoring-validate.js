#!/usr/bin/env node
"use strict";

// ARCH-107 change-file validation. Structure, identifiers, modes, scores, notes
// and authority only — everything that can be judged without a database, so an
// agent can check a draft change file in a second. Existence, membership,
// locked values and base-release freshness need stored state and are checked by
// the dry run and the apply.

const { readChangeFile } = require("./authoring-lib.js");

function parseArgs(argv) {
  const options = { change: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--change") options.change = argv[++index];
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  if (options.change === null) throw new Error("--change <path> is required");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const change = readChangeFile(options.change);
  console.log(`ARCH-107 validate: ${change.change_id} is well formed`);
  console.log(`  Author: ${change.author} (${change.author_role})`);
  console.log(`  Entity: ${change.entity_type} / operation: ${change.operation} / authority: ${change.authority ?? "(per field)"}`);
  console.log(`  Expected base release: ${JSON.stringify(change.expected_base_release)}`);
  console.log(`  Operations: ${change.operations.length}`);
  for (const op of change.operations) console.log(`    - ${op.entity}.${op.operation} ${op.key}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ARCH-107 validate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
