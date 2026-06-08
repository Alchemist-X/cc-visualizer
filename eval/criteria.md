# cc-visualizer — Eval Criteria

**Project:** Node zero-dep CLI: `node cc-viz.js <transcript.jsonl> [-o out.html]`. Ships `sample.jsonl`. Emits a standalone interactive HTML report.

Run the harness from the repo root: `node eval/eval.mjs`

Each criterion is a discrete pass/fail check. The harness prints `PASS Cn: ...` or `FAIL Cn: <why>` per check and ends with `RESULT: X/Y passed`. Exit 0 only if all non-skipped checks pass; otherwise exit 1.

---

## C1 — help

`node cc-viz.js --help` AND `node cc-viz.js -h` must each:
- exit `0`
- print to **STDOUT** (not stderr) text containing `Usage`
- mention the flags `-o`/`--output` and `--help`.

## C2 — no-arg friendly

`node cc-viz.js` with no args must:
- exit `0` (a friendly listing, not a crash to stderr)
- print usage text to **STDOUT**.
- If `~/.claude/projects` exists, it should additionally LIST available session `.jsonl` files to pick from (a non-interactive listing is fine).

Harness asserts: exit `0` + usage text on stdout.

## C3 — generate self-contained

`node cc-viz.js sample.jsonl -o /tmp/cc_eval.html`:
- output file size > 20 KB
- NO external `<script src=` and NO external `<link href=` (no CDN references)
- contains a turns/sidebar nav, a search input, and a theme toggle.

## C4 — XSS escaping [CRITICAL]

Harness ships `eval/fixtures/xss.jsonl` whose assistant text contains `<script>alert('x')</script>` and `<img src=x onerror=alert(1)>`.

Run cc-viz on it; assert the output HTML:
- does NOT contain the literal substring `<script>alert('x')</script>`
- does NOT contain the literal substring `onerror=alert(1)`
- (both must be HTML-escaped)
- the escaped `&lt;script&gt;` IS present.

## C5 — robustness

`eval/fixtures/messy.jsonl` contains a non-JSON line + an empty line + an unknown-type record. cc-viz must:
- exit `0`
- produce output
- report a skipped-lines count.

## C6 — scale

Harness generates `/tmp/cc_big.jsonl` (~3000 synthetic valid lines). cc-viz must:
- run without crashing
- produce a file.

## C7 — tests

`node --test` (test files under `test/` or `*.test.mjs`) runs >= 4 tests covering parse, HTML-escaping, stats, and empty-input; all must pass.

## C8 — packaging

`package.json` `"bin"` target has a shebang; running the bin with `--help` works (exit 0).

## AESTHETIC (screenshot >= 8 — implement)

Polished dark + light themes, working sidebar nav, search highlight, nice `tool_use`/diff rendering. (Scored separately via screenshot; not a hard harness gate.)
