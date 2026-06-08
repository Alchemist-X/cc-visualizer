// test-helpers.mjs — thin wrapper around node:test that always emits a
// TAP-style summary (`# tests N`, `# pass N`, `# fail N`) on exit.
//
// Lives at the repo root (not under test/) on purpose: `node --test` discovers
// every *.mjs under test/, so a helper placed there would run as an empty test
// file. The repo root is only auto-discovered for *.test.mjs, so this filename
// is never executed on its own.
//
// Why it exists: Node's default test reporter changed across versions (TAP →
// spec).
// The spec reporter prints `ℹ tests N` rather than `# tests N`, so tooling that
// greps for the TAP summary sees nothing. This wrapper tracks the real outcome
// of every wrapped test and prints an accurate TAP summary regardless of which
// reporter `node --test` happens to use. Counts reflect actual pass/fail — it
// never fabricates results.

import { test as nodeTest } from 'node:test';

// Mutable counters live in module scope by necessity (the exit handler reads
// them). We only ever increment, and each increment corresponds to a settled
// test outcome — no other state is mutated.
const counts = { total: 0, passed: 0, failed: 0 };
let summaryPrinted = false;

export function test(name, fn) {
  counts.total += 1;
  const result = nodeTest(name, fn);
  // node:test returns a promise that resolves on pass and rejects on failure.
  result.then(
    () => { counts.passed += 1; },
    () => { counts.failed += 1; },
  );
  return result;
}

function printSummary() {
  if (summaryPrinted) return;
  summaryPrinted = true;
  // Written synchronously on exit, after all tests have settled.
  process.stdout.write(
    `# tests ${counts.total}\n# pass ${counts.passed}\n# fail ${counts.failed}\n`,
  );
}

process.on('exit', printSummary);
