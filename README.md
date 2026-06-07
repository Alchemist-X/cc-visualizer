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

# Specify output path
node cc-viz.js sample.jsonl -o /tmp/report.html

# Visualize a real Claude Code session
node cc-viz.js ~/.claude/projects/<project>/<session-id>.jsonl -o out.html

# Open in browser (macOS)
open sample.html
```

Requires **Node.js 18+** (uses ES module `import` with `node:` builtins). No `npm install` needed.

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
| ~7 records (sample) | ~50 KB |
| ~149 records | ~340 KB |

## Limitations

- Read-only visualizer — does not modify transcripts
- Thinking block `signature` fields (base64 blobs) are omitted from display; thinking blocks may appear empty if Claude redacted their content
- Search highlights only the first occurrence per text node; use `n`/`N` to navigate all matches

## Privacy

Never commit real transcript files — they may contain private code, credentials, or personal data. The `.gitignore` already excludes `*.real.jsonl` and `out/`.

## License

MIT © 2026 Alchemist-X
