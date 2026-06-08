#!/usr/bin/env node
// eval/eval.mjs — strict pass/fail eval harness for cc-visualizer.
// Zero dependencies. Node 23. Run from repo root: `node eval/eval.mjs`
//
// Prints "PASS Cn: ..." / "FAIL Cn: <why>" / "SKIP Cn: <why>" per criterion,
// ends with "RESULT: X/Y passed". Exit 0 iff every non-skipped check passes.

import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ── Paths ─────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');            // repo root (eval/ lives under it)
const CLI = join(REPO, 'cc-viz.js');
const SAMPLE = join(REPO, 'sample.jsonl');
const FIXTURES = join(HERE, 'fixtures');
const XSS = join(FIXTURES, 'xss.jsonl');
const MESSY = join(FIXTURES, 'messy.jsonl');
const NODE = process.execPath;

// ── Result tracking ─────────────────────────────────────────────────────────
const results = [];
function record(id, status, msg) {
  // status: 'PASS' | 'FAIL' | 'SKIP'
  results.push({ id, status, msg });
  console.log(`${status} ${id}: ${msg}`);
}
// AssertionFailure marks an expected criterion failure (vs. a harness bug).
class AssertionFailure extends Error {}

// Wrap a check so any throw becomes a FAIL rather than killing the run.
function check(id, fn) {
  try {
    fn();
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    if (err instanceof AssertionFailure) {
      record(id, 'FAIL', why);
    } else {
      record(id, 'FAIL', `harness error — ${why}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function runCli(args, opts = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function fileSizeKB(p) {
  return existsSync(p) ? statSync(p).size / 1024 : 0;
}

function assert(cond, why) {
  if (!cond) throw new AssertionFailure(why);
}

// ── Preconditions (hard sanity, not a scored criterion) ──────────────────────
if (!existsSync(CLI)) {
  console.log(`FATAL: CLI not found at ${CLI}`);
  console.log('RESULT: 0/0 passed');
  process.exit(1);
}
if (!existsSync(SAMPLE)) {
  console.log(`FATAL: sample.jsonl not found at ${SAMPLE}`);
  console.log('RESULT: 0/0 passed');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — help: --help AND -h exit 0, print "Usage" + flags to STDOUT.
// ─────────────────────────────────────────────────────────────────────────────
check('C1', () => {
  for (const flag of ['--help', '-h']) {
    const r = runCli([flag]);
    assert(r.status === 0, `\`${flag}\` exited ${r.status} (expected 0); stderr="${(r.stderr || '').trim().slice(0, 120)}"`);
    const out = r.stdout || '';
    assert(/Usage/.test(out), `\`${flag}\` did not print "Usage" to STDOUT (stdout="${out.trim().slice(0, 120)}")`);
    assert(/-o\b/.test(out) || /--output\b/.test(out), `\`${flag}\` STDOUT missing -o/--output flag docs`);
    assert(/--help\b/.test(out), `\`${flag}\` STDOUT missing --help flag docs`);
  }
  record('C1', 'PASS', '--help and -h exit 0 and print Usage + flags to stdout');
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — no-arg friendly: exit 0, usage on STDOUT (not a stderr crash).
// ─────────────────────────────────────────────────────────────────────────────
check('C2', () => {
  const r = runCli([]);
  assert(r.status === 0, `no-arg exited ${r.status} (expected 0); stderr="${(r.stderr || '').trim().slice(0, 120)}"`);
  const out = r.stdout || '';
  assert(/Usage/i.test(out), `no-arg did not print usage to STDOUT (stdout="${out.trim().slice(0, 120)}", stderr="${(r.stderr || '').trim().slice(0, 120)}")`);
  record('C2', 'PASS', 'no-arg exits 0 and prints usage to stdout');
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — generate self-contained: >20KB, no CDN, has sidebar/search/theme toggle.
// ─────────────────────────────────────────────────────────────────────────────
const OUT_EVAL = '/tmp/cc_eval.html';
check('C3', () => {
  const r = runCli([SAMPLE, '-o', OUT_EVAL]);
  assert(r.status === 0, `generate exited ${r.status}; stderr="${(r.stderr || '').trim().slice(0, 160)}"`);
  assert(existsSync(OUT_EVAL), `output file ${OUT_EVAL} was not created`);
  const kb = fileSizeKB(OUT_EVAL);
  assert(kb > 20, `output is ${kb.toFixed(1)} KB (expected > 20 KB)`);
  const html = readFileSync(OUT_EVAL, 'utf8');
  // No external CDN references. Match <script ... src= and <link ... href=
  const extScript = /<script\b[^>]*\bsrc\s*=/i.test(html);
  const extLink = /<link\b[^>]*\bhref\s*=/i.test(html);
  assert(!extScript, 'found external <script src=...> (must be inlined / self-contained)');
  assert(!extLink, 'found external <link href=...> (must be inlined / self-contained)');
  // Interactive features.
  const hasSidebar = /class=["'][^"']*sidebar/i.test(html) || /id=["']sidebar/i.test(html) || /<nav\b/i.test(html);
  assert(hasSidebar, 'no turns/sidebar nav detected in output');
  const hasSearch = /<input\b[^>]*type=["']search["']/i.test(html) || /id=["']search/i.test(html) || /placeholder=["'][^"']*[Ss]earch/i.test(html);
  assert(hasSearch, 'no search input detected in output');
  const hasTheme = /toggleTheme/i.test(html) || /theme-toggle/i.test(html) || /id=["']themeBtn/i.test(html) || /data-theme/i.test(html);
  assert(hasTheme, 'no theme toggle detected in output');
  record('C3', 'PASS', `self-contained ${kb.toFixed(1)} KB; no CDN; sidebar+search+theme present`);
});

// ─────────────────────────────────────────────────────────────────────────────
// C4 — XSS escaping [CRITICAL].
// ─────────────────────────────────────────────────────────────────────────────
const OUT_XSS = '/tmp/cc_xss.html';
check('C4', () => {
  assert(existsSync(XSS), `missing fixture ${XSS}`);
  // Sanity: the fixture actually carries the dangerous payloads.
  const fx = readFileSync(XSS, 'utf8');
  assert(fx.includes("<script>alert('x')</script>"), 'fixture does not contain the <script> payload');
  assert(fx.includes('onerror=alert(1)'), 'fixture does not contain the onerror payload');

  const r = runCli([XSS, '-o', OUT_XSS]);
  assert(r.status === 0, `cc-viz on xss fixture exited ${r.status}; stderr="${(r.stderr || '').trim().slice(0, 160)}"`);
  assert(existsSync(OUT_XSS), `output ${OUT_XSS} not created`);
  const html = readFileSync(OUT_XSS, 'utf8');

  assert(!html.includes("<script>alert('x')</script>"),
    "output contains the literal unescaped <script>alert('x')</script> (XSS not escaped)");
  assert(!html.includes('onerror=alert(1)'),
    'output contains the literal unescaped substring onerror=alert(1) (XSS not escaped)');
  assert(html.includes('&lt;script&gt;'),
    'escaped &lt;script&gt; not found in output (payload should be HTML-escaped, not stripped)');
  record('C4', 'PASS', 'script + onerror payloads HTML-escaped; &lt;script&gt; present');
});

// ─────────────────────────────────────────────────────────────────────────────
// C5 — robustness: messy input → exit 0, output produced, skipped count reported.
// ─────────────────────────────────────────────────────────────────────────────
const OUT_MESSY = '/tmp/cc_messy.html';
check('C5', () => {
  assert(existsSync(MESSY), `missing fixture ${MESSY}`);
  const r = runCli([MESSY, '-o', OUT_MESSY]);
  assert(r.status === 0, `cc-viz on messy fixture exited ${r.status}; stderr="${(r.stderr || '').trim().slice(0, 160)}"`);
  assert(existsSync(OUT_MESSY), `output ${OUT_MESSY} not created`);
  const blob = `${r.stdout || ''}\n${r.stderr || ''}`;
  // Must report a skipped-lines count: a number adjacent to a "skip" word.
  const reportsSkip = /skip\w*[^0-9]{0,20}[1-9]\d*/i.test(blob) || /[1-9]\d*[^0-9]{0,20}skip/i.test(blob);
  assert(reportsSkip, `did not report a skipped-lines count (output="${blob.trim().slice(0, 200)}")`);
  record('C5', 'PASS', 'messy input handled: exit 0, output produced, skipped count reported');
});

// ─────────────────────────────────────────────────────────────────────────────
// C6 — scale: ~3000 synthetic valid lines → runs, produces a file.
// ─────────────────────────────────────────────────────────────────────────────
const BIG = '/tmp/cc_big.jsonl';
const OUT_BIG = '/tmp/cc_big.html';
check('C6', () => {
  const lines = [];
  let prev = null;
  for (let i = 0; i < 3000; i++) {
    const uuid = `big0${String(i).padStart(7, '0')}-0000-0000-0000-000000000000`;
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, 0)).toISOString();
    if (i % 2 === 0) {
      lines.push(JSON.stringify({
        parentUuid: prev, isSidechain: false, type: 'user', uuid, timestamp: ts,
        message: { role: 'user', content: `Synthetic user message #${i} please continue.` },
        sessionId: 'big-session-001',
      }));
    } else {
      lines.push(JSON.stringify({
        parentUuid: prev, isSidechain: false, type: 'assistant', uuid, timestamp: ts,
        message: {
          id: `msg_big${i}`, type: 'message', role: 'assistant', model: 'claude-opus-4-7',
          content: [{ type: 'text', text: `Synthetic assistant reply #${i}.` }],
          usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0 },
        },
      }));
    }
    prev = uuid;
  }
  writeFileSync(BIG, `${lines.join('\n')}\n`);
  const r = runCli([BIG, '-o', OUT_BIG], { timeout: 120_000 });
  assert(r.status === 0, `cc-viz on big input exited ${r.status}; stderr="${(r.stderr || '').trim().slice(0, 160)}"`);
  assert(existsSync(OUT_BIG), `output ${OUT_BIG} not created`);
  assert(fileSizeKB(OUT_BIG) > 20, `big output suspiciously small (${fileSizeKB(OUT_BIG).toFixed(1)} KB)`);
  record('C6', 'PASS', `3000-line input rendered to ${fileSizeKB(OUT_BIG).toFixed(0)} KB without crashing`);
});

// ─────────────────────────────────────────────────────────────────────────────
// C7 — tests: `node --test` runs >=4 tests (parse, escape, stats, empty); pass.
// ─────────────────────────────────────────────────────────────────────────────
check('C7', () => {
  // Discover candidate test files: test/ dir or *.test.mjs anywhere (excluding eval/ & node_modules).
  const candidates = [];
  const testDir = join(REPO, 'test');
  if (existsSync(testDir) && statSync(testDir).isDirectory()) {
    for (const f of readdirSync(testDir)) {
      if (/\.(test\.)?(mjs|js|cjs)$/.test(f)) candidates.push(join('test', f));
    }
  }
  for (const f of readdirSync(REPO)) {
    if (/\.test\.mjs$/.test(f)) candidates.push(f);
  }
  assert(candidates.length > 0, 'no test files found (expected files under test/ or *.test.mjs)');

  // Run the project's own test runner via `node --test`.
  const r = spawnSync(NODE, ['--test', ...candidates], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;

  // TAP summary: "# tests N", "# pass N", "# fail N".
  const mTests = out.match(/#\s*tests\s+(\d+)/);
  const mPass = out.match(/#\s*pass\s+(\d+)/);
  const mFail = out.match(/#\s*fail\s+(\d+)/);
  const nTests = mTests ? Number(mTests[1]) : 0;
  const nPass = mPass ? Number(mPass[1]) : 0;
  const nFail = mFail ? Number(mFail[1]) : (r.status === 0 ? 0 : -1);

  assert(r.status === 0, `\`node --test\` exited ${r.status} (some tests failed). fail=${nFail}, tail="${out.trim().slice(-200)}"`);
  assert(nTests >= 4, `only ${nTests} tests ran (expected >= 4)`);
  assert(nFail === 0, `${nFail} test(s) failed`);

  // Coverage of required topics, by test-name keywords in the TAP output.
  const topics = {
    parse: /\bparse/i.test(out),
    escape: /escap|xss|html.?escape|sanit/i.test(out),
    stats: /\bstat/i.test(out),
    empty: /empty|no.?valid|blank/i.test(out),
  };
  const missing = Object.entries(topics).filter(([, v]) => !v).map(([k]) => k);
  assert(missing.length === 0, `tests pass but do not visibly cover: ${missing.join(', ')} (name tests to mention these topics)`);

  record('C7', 'PASS', `${nPass}/${nTests} tests pass; covers parse/escape/stats/empty`);
});

// ─────────────────────────────────────────────────────────────────────────────
// C8 — packaging: package.json "bin" target has a shebang; bin --help works.
// ─────────────────────────────────────────────────────────────────────────────
check('C8', () => {
  const pkgPath = join(REPO, 'package.json');
  assert(existsSync(pkgPath), 'package.json not found');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${e.message}`);
  }
  assert(pkg.bin, 'package.json has no "bin" field');
  // bin may be a string or { name: path }.
  const binTargets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
  assert(binTargets.length > 0, '"bin" field is empty');
  const binRel = binTargets[0];
  const binAbs = resolve(REPO, binRel);
  assert(existsSync(binAbs), `bin target ${binRel} does not exist`);
  const firstLine = readFileSync(binAbs, 'utf8').split('\n', 1)[0];
  assert(/^#!.*\bnode\b/.test(firstLine), `bin target ${binRel} missing a node shebang (first line: "${firstLine}")`);
  // bin --help works (exit 0).
  const r = spawnSync(NODE, [binAbs, '--help'], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env },
  });
  assert(r.status === 0, `bin --help exited ${r.status}; stderr="${(r.stderr || '').trim().slice(0, 120)}"`);
  record('C8', 'PASS', `bin "${binRel}" has node shebang and --help exits 0`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary.
// ─────────────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const scored = passed + failed; // SKIP not counted
console.log('');
console.log(`RESULT: ${passed}/${scored} passed${skipped ? ` (${skipped} skipped)` : ''}`);
if (failed > 0) {
  console.log(`FAILING: ${results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', ')}`);
}
process.exit(failed === 0 ? 0 : 1);
