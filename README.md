# cc-visualizer

Turn Claude Code session transcripts (JSONL) into a **standalone interactive HTML report**: reasoning flow, tool calls, thinking blocks — all offline, zero dependencies.

## What it does

- Parses Claude Code `.jsonl` session transcripts (one JSON record per line)
- Renders each turn as a card: **user** messages, **assistant** replies, **thinking** blocks, **tool calls** (with pretty-printed JSON input), and **tool results** (with truncation for huge outputs)
- Header summary: turn count, tool call counts by name, thinking blocks, token totals, session duration
- Sticky controls: filter by card/block type, expand/collapse all collapsibles, full-text search with match highlighting
- Outputs **one self-contained HTML file** — no CDN, no network, works offline forever

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

Requires **Node.js 23+** (uses ES module `import` with `node:` builtins). No `npm install` needed.

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
| `thinking`    | Collapsible purple section |
| `tool_use`    | Collapsible orange card with tool name + JSON input |
| `tool_result` | Collapsible blue card, truncated at 2000 chars |
| unknown       | Collapsible gray card with raw JSON |

Both `string` and `array` values for `message.content` are handled. Malformed lines are skipped; a count is shown in the report header.

## Limitations

- Read-only visualizer — does not modify transcripts
- Very large transcripts (10 000+ lines) produce large HTML files; modern browsers handle them fine but older machines may be slower
- Thinking block `signature` fields (base64 blobs) are omitted from display
- No diff or comparison across sessions
- Search highlights only the first occurrence per text node (browser limitation)

## Privacy

Never commit real transcript files — they may contain private code, credentials, or personal data. The `.gitignore` already excludes `*.real.jsonl` and `out/`.

## License

MIT © 2026 Alchemist-X
