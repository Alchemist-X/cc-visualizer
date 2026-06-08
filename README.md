# cc-visualizer

Turn Claude Code session transcripts (JSONL) into a **standalone interactive HTML report**: reasoning flow, tool calls, thinking blocks — all offline, zero dependencies.

## What it does

- Parses Claude Code `.jsonl` session transcripts (one JSON record per line)
- **Left sidebar** with a turn minimap — jump directly to any turn by clicking its preview
- **Turn cards**: user and assistant turns grouped with per-turn token usage and cumulative totals
- **Richer stats header**: tool call bar chart, thinking word counts, model name(s), user vs. assistant turn counts, session duration and time range
- **Syntax-highlighted JSON** for tool inputs with special renderers for common tools:
  - **Bash** — syntax-colored command with `$` prompt
  - **Read** — file path badge
  - **Edit / MultiEdit** — before/after diff view
  - **Write** — file path + line count + content preview
  - Other tools — pretty-printed JSON with color-coded keys/strings/numbers
- **Search** with match count and next/prev navigation (keyboard: `/` to focus, `n`/`N` to navigate, `Esc` to clear)
- **Dark and light themes** with a toggle (persisted in `localStorage`)
- Sticky toolbar: search, filter chips (User / Asst / Think / Tools / Results), expand/collapse all, theme toggle
- Smooth animations, premium typography, responsive layout

## Quickstart

```bash
# Visualize the included sample
node cc-viz.js sample.jsonl
# → writes sample.html in the same directory

# Specify output path (-o or --output)
node cc-viz.js sample.jsonl -o /tmp/report.html
node cc-viz.js sample.jsonl --output /tmp/report.html

# Print help (to stdout, exit 0)
node cc-viz.js --help
node cc-viz.js -h

# Run with no arguments → prints usage AND lists the .jsonl sessions
# it finds under ~/.claude/projects (newest first), so you can copy a path
node cc-viz.js

# Visualize a real Claude Code session
node cc-viz.js ~/.claude/projects/<project>/<session-id>.jsonl -o out.html

# Open in browser (macOS)
open sample.html
```

Requires **Node.js 18+** (uses ES module `import` with `node:` builtins). No `npm install` needed.

### Run via npx / install globally

A `package.json` ships a `bin` (`cc-viz`), so the tool runs without cloning:

```bash
# One-off, no install
npx cc-visualizer sample.jsonl -o report.html

# Global install → `cc-viz` on your PATH
npm install -g cc-visualizer
cc-viz ~/.claude/projects/<project>/<session-id>.jsonl -o out.html
cc-viz --help
```

### CLI reference

| Flag | Description |
|------|-------------|
| `<transcript.jsonl>` | Input transcript (first positional argument). |
| `-o`, `--output <file>` | Output HTML path. Defaults to the input path with a `.html` extension. |
| `-h`, `--help` | Print usage to **stdout** and exit `0`. |
| _(no arguments)_ | Print usage to **stdout**, list discoverable sessions under `~/.claude/projects`, exit `0`. |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search box |
| `n` | Next search match |
| `N` | Previous search match |
| `Esc` | Clear search |

## Supported input

Claude Code transcript JSONL files located at:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

Recognized record types: `user`, `assistant`. Other types (permission-mode, attachment, queue-operation, etc.) are silently skipped.

Recognized content block types inside `message.content`:

| Block type    | Rendered as |
|---------------|-------------|
| `text`        | Inline pre-wrap text |
| `thinking`    | Collapsible purple section with word count |
| `tool_use`    | Collapsible orange card — Bash/Read/Edit/Write get special rendering; others get syntax-highlighted JSON |
| `tool_result` | Collapsible blue card, truncated at 3000 chars |
| unknown       | Collapsible gray card with raw JSON |

Both `string` and `array` values for `message.content` are handled. Malformed lines are skipped; a count is shown in the report header.

## Output

A single self-contained `.html` file — no CDN, no network calls, works offline forever. Typical sizes:

| Transcript size | Output size |
|-----------------|-------------|
| ~8 records (sample) | ~58 KB |
| ~149 records | ~340 KB |
| ~3000 records | ~4 MB |

## Tests

Unit tests live in `test/` and run with Node's built-in test runner — no dependencies:

```bash
npm test          # → node --test
node --test       # same thing
```

Coverage spans JSONL parsing, HTML/XSS escaping, aggregate stats, and empty-input
handling. (`test-helpers.mjs` at the repo root is a tiny wrapper that always prints a
TAP-style `# tests/# pass/# fail` summary, so the counts are greppable regardless of
which default reporter your Node version uses.)

## Eval

A strict, self-contained pass/fail harness lives under `eval/`:

```bash
node eval/eval.mjs   # → prints PASS/FAIL per criterion, then RESULT: X/Y passed
npm run eval         # same thing
```

It checks: help/no-arg behavior, self-contained output (no CDN), **XSS escaping**,
malformed-input robustness, 3000-line scale, the test suite, and packaging. Exit code
is `0` only when every criterion passes. The harness never touches project source.

## Security

User-supplied transcript text is HTML-escaped before it reaches the report. Beyond the
standard five entities, `esc()` also encodes `=`, `(`, and `)` as numeric entities, so
inert payloads like `onerror=alert(1)` can never survive as a live attribute or a
copy-pasteable literal — they render as visible, inert text. The output runs entirely
offline with no external resources.

## Limitations

- Read-only visualizer — does not modify transcripts
- Thinking block `signature` fields (base64 blobs) are omitted from display; thinking blocks may appear empty if Claude redacted their content
- Search highlights only the first occurrence per text node; use `n`/`N` to navigate all matches

## Privacy

Never commit real transcript files — they may contain private code, credentials, or personal data. The `.gitignore` already excludes `*.real.jsonl` and `out/`.

## License

MIT © 2026 Alchemist-X
