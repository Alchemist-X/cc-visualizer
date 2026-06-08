// test/cc-viz.test.mjs — unit tests for cc-viz pure functions.
// Run: `node --test`  (or `npm test`). Zero dependencies — Node's built-in
// test runner + node:assert only.

import assert from 'node:assert/strict';
import { test } from '../test-helpers.mjs';

import {
  parseArgs,
  parseJsonl,
  esc,
  buildStats,
  buildTurns,
  syntaxHighlightJson,
} from '../cc-viz.js';

// ──────────────────────────────────────────────
// parse — JSONL parsing
// ──────────────────────────────────────────────
test('parse: valid JSONL yields records and zero skipped', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }),
  ].join('\n');
  const { records, skipped } = parseJsonl(raw);
  assert.equal(records.length, 2);
  assert.equal(skipped, 0);
  assert.equal(records[0].type, 'user');
});

test('parse: skips malformed and blank lines, counts skipped', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } }),
    'this is { not json',
    '',
    '   ',
    'also [broken',
  ].join('\n');
  const { records, skipped } = parseJsonl(raw);
  assert.equal(records.length, 1);
  assert.equal(skipped, 2); // two non-JSON lines; blank/whitespace lines are not counted
});

// ──────────────────────────────────────────────
// parseArgs — CLI argument handling
// ──────────────────────────────────────────────
test('parse: parseArgs detects help, usage, and run modes', () => {
  assert.equal(parseArgs(['node', 'cc-viz.js', '--help']).mode, 'help');
  assert.equal(parseArgs(['node', 'cc-viz.js', '-h']).mode, 'help');
  assert.equal(parseArgs(['node', 'cc-viz.js']).mode, 'usage');

  const run = parseArgs(['node', 'cc-viz.js', 'in.jsonl', '-o', 'out.html']);
  assert.equal(run.mode, 'run');
  assert.match(run.inputPath, /in\.jsonl$/);
  assert.match(run.outputPath, /out\.html$/);
});

// ──────────────────────────────────────────────
// escape — HTML escaping / XSS safety
// ──────────────────────────────────────────────
test('escape: HTML-escapes angle brackets, quotes, and ampersands', () => {
  const out = esc(`<script>alert('x')</script>`);
  assert.ok(out.includes('&lt;script&gt;'), 'angle brackets must be escaped');
  assert.ok(!out.includes('<script>'), 'raw <script> tag must not survive');
  assert.ok(out.includes('&#39;'), 'single quotes must be escaped');
});

test('escape: defeats inert onerror=alert(1) payload (XSS / sanitize)', () => {
  const out = esc('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('onerror=alert(1)'), 'literal event-handler payload must not survive');
  assert.ok(!out.includes('<img'), 'raw tag must not survive');
  // Round-trips to readable text in a browser, just not as a live attribute.
  assert.ok(out.includes('&lt;img'), 'escaped tag text should remain visible');
});

test('escape: ampersand is escaped first to avoid double-encoding artifacts', () => {
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('&lt;'), '&amp;lt;');
});

// ──────────────────────────────────────────────
// stats — aggregate statistics
// ──────────────────────────────────────────────
test('stats: counts turns, thinking, tools, and tokens', () => {
  const records = [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'thinking', thinking: 'one two three' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
          { type: 'text', text: 'done' },
        ],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      },
    },
  ];
  const stats = buildStats(records);
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.assistantTurns, 1);
  assert.equal(stats.turns, 2);
  assert.equal(stats.thinkingBlocks, 1);
  assert.equal(stats.thinkingWords, 3);
  assert.equal(stats.toolCounts.Bash, 2);
  assert.equal(stats.totalInput, 100);
  assert.equal(stats.totalOutput, 50);
  assert.equal(stats.totalCacheRead, 10);
  assert.deepEqual(stats.models, ['claude-opus-4-7']);
  assert.equal(stats.durationMs, 60_000);
});

test('stats: ignores non user/assistant records', () => {
  const records = [
    { type: 'summary', message: { content: 'x' } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ];
  const stats = buildStats(records);
  assert.equal(stats.turns, 1);
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.assistantTurns, 0);
});

// ──────────────────────────────────────────────
// empty — empty / no-valid-record input
// ──────────────────────────────────────────────
test('empty: empty input produces zeroed stats and no turns', () => {
  const { records, skipped } = parseJsonl('');
  assert.equal(records.length, 0);
  assert.equal(skipped, 0);

  const stats = buildStats(records);
  assert.equal(stats.turns, 0);
  assert.equal(stats.thinkingBlocks, 0);
  assert.equal(stats.hasTokens, false);
  assert.equal(stats.durationMs, null);
  assert.deepEqual(stats.models, []);

  const turns = buildTurns(records);
  assert.equal(turns.length, 0);
});

test('empty: blank-only input is treated as empty, not as malformed', () => {
  const { records, skipped } = parseJsonl('\n\n   \n\t\n');
  assert.equal(records.length, 0);
  assert.equal(skipped, 0);
});

// ──────────────────────────────────────────────
// render — JSON syntax highlighting stays inert
// ──────────────────────────────────────────────
test('render: syntaxHighlightJson escapes content and never emits raw tags', () => {
  const html = syntaxHighlightJson({ payload: "<script>alert('x')</script>" });
  assert.ok(!html.includes('<script>'), 'must not emit a live script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'must escape the tag for display');
  assert.ok(html.includes('j-key') || html.includes('j-str'), 'should apply syntax classes');
});
